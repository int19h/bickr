import { fail, ok, readJsonBody } from '@bickr/shared/api';
import { copyAvatarImage, fetchRemoteAvatarBytes, normalizeAvatarPublicBaseUrl, storeAvatarImage } from '@bickr/shared/avatar-storage';
import { ExclusiveOperationQueue } from '@bickr/shared/exclusive-operation-queue';
import { updateWorld } from '@bickr/shared/governance';
import { json } from '@bickr/shared/http';
import { type ObjectIndexConvergenceTask, runObjectIndexConvergenceBatch } from '@bickr/shared/index-repair';
import { addInternalServiceAuthHeader, internalServiceUrl, isTrustedInternalServiceRequest } from '@bickr/shared/internal-service';
import {
	botById,
	createBot,
	deleteBot,
	humanProfileDeleteEligibility,
	listOwnedForumsOutsideOwnedWorlds,
	listOwnedWorlds,
	listUserBots,
	rawBotById,
	refreshLinkedCloneIndexes,
	relinkBotClone,
	RepositoryError,
	softDeleteUserProfile,
	spreadUserBotTicks,
	unlinkBotClone,
	updateBot,
	updateBotAvatar,
	updateUserProfile,
	userById,
} from '@bickr/shared/repository';
import {
	boundedSearchPage,
	normalizeSearchFilters,
	parseSearchMode,
	parseSearchTypes,
	reindexSearchVectors,
	searchEntitiesSemantic,
} from '@bickr/shared/search';
import {
	cachedGlobalInferenceCostStats,
	listOwnerBotTokenSpendSummaries,
	publicGlobalInferenceCostStats,
	refreshGlobalInferenceCostStatsCacheIfStale,
} from '@bickr/shared/token-spend';
import {
	InputError,
	normalizeHandle,
	parseCreateBotInput,
	parseUpdateBotInput,
	parseUpdateUserProfileInput,
	parseUpdateWorldInput,
} from '@bickr/shared/validation';
import {
	applyGeneratedAvatarForBot,
	applyGeneratedAvatarForUser,
	applyGeneratedAvatarForWorld,
	generateAvatar,
	parseAvatarCandidate as parseAvatarCandidateValue,
	parseAvatarGenerationInput as parseAvatarGenerationRequest,
	parseAvatarPromptInput as parseAvatarPromptRequest,
	prefillAvatarPrompt,
	streamAvatarGeneration,
	streamAvatarPrompt,
	worldAvatarPromptSettings as resolvedWorldAvatarPromptSettings,
} from './avatar/service';
import { worldDocumentForAvatar } from './avatar/target';
import { scheduledDispatchBudget, scheduledDispatchSelectLimit, scheduledDispatchTimeoutMs } from './constants';
import { RuntimeOperationTimeoutError } from './errors';
import { withAbortableTimeout } from './provider/sse';
import {
	agentRuntimeNotFoundResponse,
	apiErrorPayload,
	avatarPromptSettingsRuntime,
	avatarProvider,
	deleteBotVector,
	effectiveAvatarSettingsLanguageForBot,
	effectiveAvatarSettingsLanguageForUser,
	effectiveAvatarSettingsLanguageForWorld,
	effectiveProviderSettingsForBot,
	errorResponse,
	parseTranslationInput,
	readOptionalJsonBody,
	repositoryErrorCode,
	requireAuthenticatedServiceRequest,
	requireAvatarBucket,
	requireSchedulerServiceRequest,
	requireUserMatch,
	runtimeRecord,
	sortBotsForCascadeDelete,
	translateForUser,
	upsertBotVector,
} from './runtime/bot-runtime';
import type { Env } from './types';

export type UserBotsCoordinatorContext = {
	objectId: string;
	queue?: ExclusiveOperationQueue;
	storage?: DurableObjectStorage;
};

type AgentRuntimeRouteEnv = Pick<
	Env,
	| 'BICKR_D1'
	| 'BICKR_KV'
	| 'BICKR_R2'
	| 'BICKR_R2_PUBLIC_BASE_URL'
	| 'AI'
	| 'BICKR_SEARCH_VECTORIZE'
	| 'OPENROUTER_API_KEY'
	| 'OPENROUTER_BASE_URL'
	| 'OPENROUTER_MODEL'
> &
	Partial<Pick<Env, 'FORUM_COORDINATOR_SERVICE' | 'INTERNAL_SERVICE_SECRET'>>;

type AgentRuntimeRouteContext = {
	request: Request;
	env: AgentRuntimeRouteEnv;
	url: URL;
	coordinator: UserBotsCoordinatorContext;
	objectId: string;
	match: RegExpExecArray;
};

type AgentRuntimeRouteHandler = (context: AgentRuntimeRouteContext) => Promise<Response>;

type AgentRuntimeHandlerRoute = {
	id: string;
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | '*';
	pattern: RegExp;
	dispatch: 'direct' | 'user-coordinator';
	handler: AgentRuntimeRouteHandler;
};

type BotRuntimeDispatchRoute = {
	id: string;
	method: '*';
	pattern: RegExp;
	dispatch: 'bot-runtime';
};

type AgentRuntimeRoute = AgentRuntimeHandlerRoute | BotRuntimeDispatchRoute;

const userBotPattern = /^\/users\/([^/]+)\/bots\/([^/]+)$/;

export const agentRuntimeRouteTable = [
	{
		id: 'health',
		method: '*',
		pattern: /^\/health$/,
		dispatch: 'direct',
		handler: async () =>
			json({
				ok: true,
				runtime: 'agent-runtime-worker',
			}),
	},
	{
		id: 'translate',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/translate$/,
		dispatch: 'direct',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const input = parseTranslationInput(await readJsonBody(context.request));
			const translation = await translateForUser(context.env, userId, input.text);
			return ok({ translation, coordinator: context.objectId });
		},
	},
	{
		id: 'search-entities',
		method: 'GET',
		pattern: /^\/search\/entities$/,
		dispatch: 'direct',
		handler: async (context) => {
			requireAuthenticatedServiceRequest(context.request);
			const mode = parseSearchMode(context.url.searchParams.get('mode'));
			if (mode !== 'semantic') {
				throw new InputError('Agent runtime search only supports semantic mode.');
			}
			const result = await searchEntitiesSemantic(context.env.BICKR_D1, context.env, {
				...normalizeSearchFilters({
					forum: context.url.searchParams.get('forum'),
					username: context.url.searchParams.get('username'),
					world: context.url.searchParams.get('world'),
				}),
				mode,
				page: boundedSearchPage(context.url.searchParams.get('page')),
				query: context.url.searchParams.get('q') ?? '',
				types: parseSearchTypes(context.url.searchParams.get('types')),
			});
			return ok({ search: result, coordinator: context.objectId });
		},
	},
	{
		id: 'reindex-search-vectors',
		method: 'POST',
		pattern: /^\/search\/reindex-vectors$/,
		dispatch: 'direct',
		handler: async (context) => {
			requireSchedulerServiceRequest(context.request);
			const limit = Number(context.url.searchParams.get('limit') ?? 100);
			const result = await reindexSearchVectors(context.env.BICKR_D1, context.env, Number.isFinite(limit) ? limit : 100);
			return ok({ reindex: result, coordinator: context.objectId });
		},
	},
	{
		id: 'inference-cost-statistics',
		method: 'GET',
		pattern: /^\/statistics\/inference-costs$/,
		dispatch: 'direct',
		handler: async (context) => {
			requireAuthenticatedServiceRequest(context.request);
			return ok({
				stats: publicGlobalInferenceCostStats(await cachedGlobalInferenceCostStats(context.env.BICKR_D1)),
				coordinator: context.objectId,
			});
		},
	},
	{
		id: 'owned-bot-token-spend',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/bots\/token-spend$/,
		dispatch: 'direct',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const now = new Date();
			const [owner, bots] = await Promise.all([
				userById(context.env.BICKR_KV, userId),
				listUserBots(context.env.BICKR_KV, context.env.BICKR_D1, userId),
			]);
			const summaries = await listOwnerBotTokenSpendSummaries(
				context.env.BICKR_D1,
				userId,
				bots.map((bot) => ({
					botId: bot.id,
					currentModel: effectiveProviderSettingsForBot(bot, owner, context.env).model,
				})),
				now,
			);
			return ok({
				generatedAt: now.toISOString(),
				spendByBotId: Object.fromEntries(summaries.map((summary) => [summary.botId, summary])),
				coordinator: context.objectId,
			});
		},
	},
	{
		id: 'spread-owned-bot-ticks',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/bots\/spread-ticks$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const spread = await spreadUserBotTicks(context.env.BICKR_KV, context.env.BICKR_D1, userId);
			return ok({ spread, coordinator: context.objectId });
		},
	},
	{
		id: 'user-avatar-prompt',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/avatar\/prompt$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const input = parseAvatarPromptRequest(await readOptionalJsonBody(context.request));
			if (context.request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarPrompt(
					context.env,
					{ kind: 'user', userId },
					input,
					avatarProvider,
					avatarPromptSettingsRuntime,
					context.request.signal,
				);
			}
			const prompt = await prefillAvatarPrompt(context.env, { kind: 'user', userId }, input, avatarProvider, avatarPromptSettingsRuntime);
			return ok({ prompt, coordinator: context.objectId });
		},
	},
	{
		id: 'user-avatar-generate',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/avatar\/generate$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const input = parseAvatarGenerationRequest(await readJsonBody(context.request));
			if (context.request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarGeneration(context.env, { kind: 'user', userId }, input, avatarProvider, context.request.signal);
			}
			const candidate = await generateAvatar(context.env, { kind: 'user', userId }, input, avatarProvider);
			return ok({ candidate, coordinator: context.objectId });
		},
	},
	{
		id: 'user-avatar-apply',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/avatar\/apply$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const body = runtimeRecord(await readJsonBody(context.request));
			// The client stamps apply settings with the entity's effective language
			// chain, so the parser must expect that chain — passing it as the parse
			// language only; it is not persisted (matching the bot/world apply routes).
			const settingsInput =
				body.settings === undefined
					? undefined
					: parseUpdateUserProfileInput({
							language: effectiveAvatarSettingsLanguageForUser(await userById(context.env.BICKR_KV, userId)),
							inferenceSettings: { imageGeneration: body.settings },
						});
			let profile = await applyGeneratedAvatarForUser(context.env, userId, parseAvatarCandidateValue(body.candidate));
			if (settingsInput?.inferenceSettings !== undefined) {
				profile = await updateUserProfile(context.env.BICKR_KV, context.env.BICKR_D1, userId, {
					inferenceSettings: settingsInput.inferenceSettings,
				});
			}
			return ok({ profile, coordinator: context.objectId });
		},
	},
	{
		id: 'create-bot',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/bots$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const input = parseCreateBotInput(await readJsonBody(context.request));
			const cloneSourceBot = input.cloneSourceBotId
				? await rawBotById(context.env.BICKR_KV, context.env.BICKR_D1, input.cloneSourceBotId)
				: null;
			if (cloneSourceBot && cloneSourceBot.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', 'You can only clone your own participants.', 403);
			}
			if (input.importSource?.sourceAvatarUrl) {
				requireAvatarBucket(context.env);
				normalizeAvatarPublicBaseUrl(context.env.BICKR_R2_PUBLIC_BASE_URL);
			}
			const chirperAvatar = input.importSource?.sourceAvatarUrl ? await fetchRemoteAvatarBytes(input.importSource.sourceAvatarUrl) : null;
			let bot = await createBot(context.env.BICKR_KV, context.env.BICKR_D1, worldHandle, input, userId, {
				cloneSource: cloneSourceBot ?? undefined,
			});
			if (chirperAvatar && input.importSource?.sourceAvatarUrl) {
				const avatar = await storeAvatarImage(requireAvatarBucket(context.env), {
					botId: bot.id,
					worldId: bot.homeWorldId,
					bytes: chirperAvatar.bytes,
					contentType: chirperAvatar.contentType,
					publicBaseUrl: normalizeAvatarPublicBaseUrl(context.env.BICKR_R2_PUBLIC_BASE_URL),
					source: {
						type: 'chirper',
						sourceUrl: input.importSource.sourceAvatarUrl,
						originalHandle: input.importSource.originalHandle,
						importedAt: input.importSource.importedAt,
					},
				});
				bot = await updateBotAvatar(context.env.BICKR_KV, context.env.BICKR_D1, bot.id, userId, avatar);
			}
			await upsertBotVector(context.env, bot);
			return ok({ bot, coordinator: context.objectId }, { status: 201 });
		},
	},
	{
		id: 'update-bot',
		method: 'PATCH',
		pattern: userBotPattern,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const input = parseUpdateBotInput(await readJsonBody(context.request));
			const updatedAt = new Date().toISOString();
			const bot = await updateBot(context.env.BICKR_KV, context.env.BICKR_D1, botId, userId, input, updatedAt);
			await upsertBotVector(context.env, bot);
			const affectedBots = await refreshLinkedCloneIndexes(context.env.BICKR_KV, context.env.BICKR_D1, bot.id);
			await Promise.all(affectedBots.map((affectedBot) => upsertBotVector(context.env, affectedBot)));
			const personalForum = await context.env.BICKR_D1.prepare(
				`SELECT forum_id AS id
							 FROM forums_index
							 WHERE personal_bot_id = ? AND deleted_at IS NULL
							 LIMIT 1`,
			)
				.bind(bot.id)
				.first<{ id: string }>();
			if (personalForum) {
				await startUserBotsConvergenceTask(context.env, context.coordinator, {
					kind: 'object_index_convergence',
					scope: { kind: 'forum', forumId: personalForum.id },
					updatedAt,
				});
			}
			return ok({ bot, affectedBots, coordinator: context.objectId });
		},
	},
	{
		id: 'unlink-bot-clone',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/bots\/([^/]+)\/clone\/unlink$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const rawBot = await rawBotById(context.env.BICKR_KV, context.env.BICKR_D1, botId);
			if (rawBot.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', "Only this participant's owner can unlink it.", 403);
			}
			const effectiveBot = await botById(context.env.BICKR_KV, context.env.BICKR_D1, botId);
			const now = new Date().toISOString();
			const copiedAvatar =
				!rawBot.avatar && effectiveBot.avatar
					? await copyAvatarImage(requireAvatarBucket(context.env), {
							botId: rawBot.id,
							worldId: rawBot.homeWorldId,
							sourceAvatar: effectiveBot.avatar,
							publicBaseUrl: normalizeAvatarPublicBaseUrl(context.env.BICKR_R2_PUBLIC_BASE_URL),
							now,
						})
					: undefined;
			const bot = await unlinkBotClone(context.env.BICKR_KV, context.env.BICKR_D1, botId, userId, copiedAvatar, now);
			await upsertBotVector(context.env, bot);
			const affectedBots = await refreshLinkedCloneIndexes(context.env.BICKR_KV, context.env.BICKR_D1, bot.id);
			await Promise.all(affectedBots.map((affectedBot) => upsertBotVector(context.env, affectedBot)));
			return ok({ bot, affectedBots, coordinator: context.objectId });
		},
	},
	{
		id: 'relink-bot-clone',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/bots\/([^/]+)\/clone\/relink$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const bot = await relinkBotClone(context.env.BICKR_KV, context.env.BICKR_D1, botId, userId);
			await upsertBotVector(context.env, bot);
			const affectedBots = await refreshLinkedCloneIndexes(context.env.BICKR_KV, context.env.BICKR_D1, bot.id);
			await Promise.all(affectedBots.map((affectedBot) => upsertBotVector(context.env, affectedBot)));
			return ok({ bot, affectedBots, coordinator: context.objectId });
		},
	},
	{
		id: 'bot-avatar-prompt',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar\/prompt$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const input = parseAvatarPromptRequest(await readOptionalJsonBody(context.request));
			if (context.request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarPrompt(
					context.env,
					{ kind: 'bot', userId, botId },
					input,
					avatarProvider,
					avatarPromptSettingsRuntime,
					context.request.signal,
				);
			}
			const prompt = await prefillAvatarPrompt(
				context.env,
				{ kind: 'bot', userId, botId },
				input,
				avatarProvider,
				avatarPromptSettingsRuntime,
			);
			return ok({ prompt, coordinator: context.objectId });
		},
	},
	{
		id: 'bot-avatar-generate',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar\/generate$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const input = parseAvatarGenerationRequest(await readJsonBody(context.request));
			if (context.request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarGeneration(context.env, { kind: 'bot', userId, botId }, input, avatarProvider, context.request.signal);
			}
			const candidate = await generateAvatar(context.env, { kind: 'bot', userId, botId }, input, avatarProvider);
			return ok({ candidate, coordinator: context.objectId });
		},
	},
	{
		id: 'bot-avatar-apply',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar\/apply$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const body = runtimeRecord(await readJsonBody(context.request));
			const targetBot = await botById(context.env.BICKR_KV, context.env.BICKR_D1, botId);
			if (targetBot.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', "Only this participant's owner can update its avatar.", 403);
			}
			const settingsInput =
				body.settings === undefined
					? undefined
					: parseUpdateBotInput({
							language: effectiveAvatarSettingsLanguageForBot(targetBot),
							inferenceSettings: { imageGeneration: body.settings },
						});
			let bot = await applyGeneratedAvatarForBot(context.env, userId, botId, parseAvatarCandidateValue(body.candidate));
			if (settingsInput?.inferenceSettings !== undefined) {
				bot = await updateBot(context.env.BICKR_KV, context.env.BICKR_D1, bot.id, userId, {
					inferenceSettings: settingsInput.inferenceSettings,
				});
			}
			await upsertBotVector(context.env, bot);
			const affectedBots = await refreshLinkedCloneIndexes(context.env.BICKR_KV, context.env.BICKR_D1, bot.id);
			await Promise.all(affectedBots.map((affectedBot) => upsertBotVector(context.env, affectedBot)));
			return ok({ bot, affectedBots, coordinator: context.objectId });
		},
	},
	{
		id: 'world-avatar-prompt',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/prompt$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const input = parseAvatarPromptRequest(await readOptionalJsonBody(context.request));
			if (context.request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarPrompt(
					context.env,
					{ kind: 'world', userId, worldHandle },
					input,
					avatarProvider,
					avatarPromptSettingsRuntime,
					context.request.signal,
				);
			}
			const prompt = await prefillAvatarPrompt(
				context.env,
				{ kind: 'world', userId, worldHandle },
				input,
				avatarProvider,
				avatarPromptSettingsRuntime,
			);
			return ok({ prompt, coordinator: context.objectId });
		},
	},
	{
		id: 'world-avatar-prompt-settings',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/prompt-settings$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const settings = await resolvedWorldAvatarPromptSettings(
				context.env,
				{ kind: 'world', userId, worldHandle },
				avatarPromptSettingsRuntime,
			);
			return ok({ settings, coordinator: context.objectId });
		},
	},
	{
		id: 'world-avatar-generate',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/generate$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const input = parseAvatarGenerationRequest(await readJsonBody(context.request));
			if (context.request.headers.get('accept')?.includes('text/event-stream')) {
				return streamAvatarGeneration(context.env, { kind: 'world', userId, worldHandle }, input, avatarProvider, context.request.signal);
			}
			const candidate = await generateAvatar(context.env, { kind: 'world', userId, worldHandle }, input, avatarProvider);
			return ok({ candidate, coordinator: context.objectId });
		},
	},
	{
		id: 'world-avatar-apply',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/apply$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const body = runtimeRecord(await readJsonBody(context.request));
			const targetWorld = await worldDocumentForAvatar(context.env, worldHandle, userId, 'update');
			const settingsInput =
				body.settings === undefined
					? undefined
					: parseUpdateWorldInput({
							language: effectiveAvatarSettingsLanguageForWorld(targetWorld),
							imageGeneration: body.settings,
						});
			let world = await applyGeneratedAvatarForWorld(context.env, userId, worldHandle, parseAvatarCandidateValue(body.candidate));
			if (settingsInput?.imageGeneration !== undefined) {
				world = await updateWorld(context.env.BICKR_KV, context.env.BICKR_D1, world.handle, userId, {
					imageGeneration: settingsInput.imageGeneration,
				});
			}
			return ok({ world, coordinator: context.objectId });
		},
	},
	{
		id: 'delete-bot',
		method: 'DELETE',
		pattern: userBotPattern,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const bot = await deleteBot(context.env.BICKR_KV, context.env.BICKR_D1, botId, userId);
			await deleteBotVector(context.env, bot.id);
			return ok({ bot, coordinator: context.objectId });
		},
	},
	{
		id: 'delete-profile',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/profile$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const input = await readJsonBody(context.request);
			if (!input || typeof input !== 'object' || Array.isArray(input) || (input as { confirmCascade?: unknown }).confirmCascade !== true) {
				throw new InputError('Profile deletion requires confirmCascade: true.');
			}
			const eligibility = await humanProfileDeleteEligibility(context.env.BICKR_D1, userId);
			if (!eligibility.canDelete) {
				throw new RepositoryError(
					'conflict',
					'Profile deletion is blocked because an owned world contains bots owned by other profiles.',
					409,
					{ profileDeleteBlockers: eligibility.blockers },
				);
			}
			const now = new Date().toISOString();
			const [ownedBots, ownedForumsOutsideOwnedWorlds, ownedWorlds] = await Promise.all([
				listUserBots(context.env.BICKR_KV, context.env.BICKR_D1, userId),
				listOwnedForumsOutsideOwnedWorlds(context.env.BICKR_D1, userId),
				listOwnedWorlds(context.env.BICKR_D1, userId),
			]);
			for (const bot of sortBotsForCascadeDelete(ownedBots)) {
				const deleted = await deleteBot(context.env.BICKR_KV, context.env.BICKR_D1, bot.id, userId, { now, allowLinkedCloneDelete: true });
				await deleteBotVector(context.env, deleted.id);
			}
			for (const forum of ownedForumsOutsideOwnedWorlds) {
				await requestCoordinatorGovernanceDeletion(
					context.env,
					`/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}`,
					userId,
				);
			}
			for (const world of ownedWorlds) {
				await requestCoordinatorGovernanceDeletion(context.env, `/worlds/${encodeURIComponent(world.handle)}`, userId);
			}
			const deletedProfile = await softDeleteUserProfile(context.env.BICKR_KV, context.env.BICKR_D1, userId, now);
			return ok({
				profile: deletedProfile,
				deleted: {
					worlds: ownedWorlds.length,
					forums: ownedForumsOutsideOwnedWorlds.length,
					bots: ownedBots.length,
				},
				coordinator: context.objectId,
			});
		},
	},
	{
		id: 'bot-runtime',
		method: '*',
		pattern: /^\/bots\/([^/]*)(?:\/.*)?$/,
		dispatch: 'bot-runtime',
	},
] as const satisfies readonly AgentRuntimeRoute[];

type ResolvedAgentRuntimeRoute = {
	route: (typeof agentRuntimeRouteTable)[number];
	match: RegExpExecArray;
};

export type AgentRuntimeRouteMatch = {
	handlerId: (typeof agentRuntimeRouteTable)[number]['id'];
	dispatch: (typeof agentRuntimeRouteTable)[number]['dispatch'];
	params: readonly string[];
};

function resolveAgentRuntimeRoute(pathname: string, method: string): ResolvedAgentRuntimeRoute | null {
	for (const route of agentRuntimeRouteTable) {
		if (route.method !== '*' && route.method !== method) {
			continue;
		}
		const match = route.pattern.exec(pathname);
		if (match) {
			return { route, match };
		}
	}
	return null;
}

export function matchAgentRuntimeRoute(pathname: string, method: string): AgentRuntimeRouteMatch | null {
	const resolved = resolveAgentRuntimeRoute(pathname, method);
	return resolved
		? {
				handlerId: resolved.route.id,
				dispatch: resolved.route.dispatch,
				params: resolved.match.slice(1),
			}
		: null;
}

// Retained only while a personal-forum rename/profile projection is stale.
// A newer participant update replaces it and converges the same forum scope
// to the newest canonical D1 values.
const userBotsConvergenceTaskStorageKey = 'object-index-convergence-task';
const userBotsConvergenceAlarmDelayMs = 1_000;

export async function handleAgentRuntimeRequest(
	request: Request,
	env: Pick<
		Env,
		| 'BICKR_D1'
		| 'BICKR_KV'
		| 'BICKR_R2'
		| 'BICKR_R2_PUBLIC_BASE_URL'
		| 'AI'
		| 'BICKR_SEARCH_VECTORIZE'
		| 'OPENROUTER_API_KEY'
		| 'OPENROUTER_BASE_URL'
		| 'OPENROUTER_MODEL'
	> &
		Partial<Pick<Env, 'FORUM_COORDINATOR_SERVICE' | 'INTERNAL_SERVICE_SECRET'>>,
	context: UserBotsCoordinatorContext | string = 'direct',
): Promise<Response> {
	const coordinator = typeof context === 'string' ? { objectId: context } : context;
	const operation = () => handleAgentRuntimeRequestExclusive(request, env, coordinator);
	return coordinator.queue ? coordinator.queue.run(operation) : operation();
}

async function handleAgentRuntimeRequestExclusive(
	request: Request,
	env: AgentRuntimeRouteEnv,
	coordinator: UserBotsCoordinatorContext,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const resolved = resolveAgentRuntimeRoute(url.pathname, request.method);
		if (!resolved || !('handler' in resolved.route)) {
			return fail('not_found', 'Agent runtime route not found.', 404);
		}
		return await resolved.route.handler({
			request,
			env,
			url,
			coordinator,
			objectId: coordinator.objectId,
			match: resolved.match,
		});
	} catch (error) {
		return errorResponse(error);
	}
}

async function startUserBotsConvergenceTask(
	env: Pick<Env, 'AI' | 'BICKR_D1' | 'BICKR_KV' | 'BICKR_SEARCH_VECTORIZE'>,
	coordinator: UserBotsCoordinatorContext,
	task: ObjectIndexConvergenceTask,
): Promise<void> {
	if (coordinator.storage) {
		await coordinator.storage.put(userBotsConvergenceTaskStorageKey, task);
		// Persist and arm before any external repair work. If this object is
		// evicted, the alarm resumes from the task's last committed cursor.
		await coordinator.storage.setAlarm(Date.now() + userBotsConvergenceAlarmDelayMs);
		return;
	}
	await runObjectIndexConvergenceBatch(env, task);
}

export async function runPendingUserBotsConvergenceTask(
	env: Pick<Env, 'AI' | 'BICKR_D1' | 'BICKR_KV' | 'BICKR_SEARCH_VECTORIZE'>,
	coordinator: UserBotsCoordinatorContext,
	options: {
		chunkSize?: number;
		maxRowsPerRun?: number;
		maxRepairsPerRun?: number;
	} = {},
): Promise<boolean> {
	const task = await coordinator.storage?.get<ObjectIndexConvergenceTask>(userBotsConvergenceTaskStorageKey);
	if (!task) {
		return false;
	}
	const next = await runObjectIndexConvergenceBatch(env, task, options);
	if (next) {
		await coordinator.storage?.put(userBotsConvergenceTaskStorageKey, next);
	} else {
		await coordinator.storage?.delete(userBotsConvergenceTaskStorageKey);
	}
	return true;
}

export async function runUserBotsConvergenceAlarm(
	env: Pick<Env, 'AI' | 'BICKR_D1' | 'BICKR_KV' | 'BICKR_SEARCH_VECTORIZE'>,
	coordinator: UserBotsCoordinatorContext,
	alarmInfo?: AlarmInvocationInfo,
): Promise<void> {
	const operation = async () => {
		await runPendingUserBotsConvergenceTask(env, coordinator);
		const pending = await coordinator.storage?.get(userBotsConvergenceTaskStorageKey);
		if (pending) {
			await coordinator.storage?.setAlarm(Date.now() + userBotsConvergenceAlarmDelayMs);
		} else {
			await coordinator.storage?.deleteAlarm();
		}
	};
	try {
		if (coordinator.queue) {
			await coordinator.queue.run(operation);
		} else {
			await operation();
		}
	} catch (error) {
		// Replace the platform alarm before its sixth failed delivery exhausts
		// the automatic retry budget, leaving the durable task intact.
		if ((alarmInfo?.retryCount ?? 0) >= 5 && coordinator.storage) {
			await coordinator.storage.setAlarm(Date.now() + userBotsConvergenceAlarmDelayMs);
			return;
		}
		throw error;
	}
}

async function requestCoordinatorGovernanceDeletion(
	env: Partial<Pick<Env, 'FORUM_COORDINATOR_SERVICE' | 'INTERNAL_SERVICE_SECRET'>>,
	path: string,
	userId: string,
): Promise<void> {
	if (!env.FORUM_COORDINATOR_SERVICE) {
		throw new RepositoryError('server_error', 'Forum coordinator service is unavailable.', 500);
	}
	const headers = new Headers({ 'x-bickr-user-id': userId });
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const response = await env.FORUM_COORDINATOR_SERVICE.fetch(
		new Request(internalServiceUrl(path), {
			method: 'DELETE',
			headers,
		}),
	);
	if (response.ok) {
		return;
	}
	const payload = runtimeRecord(await response.json());
	const apiError = apiErrorPayload(payload);
	if (apiError) {
		throw new RepositoryError(repositoryErrorCode(apiError.error), apiError.message, response.status || 500, apiError.details);
	}
	throw new RepositoryError('server_error', 'Governance deletion coordinator request failed.', response.status || 500);
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (!isTrustedInternalServiceRequest(request, env.INTERNAL_SERVICE_SECRET)) {
			return agentRuntimeNotFoundResponse();
		}

		const resolved = resolveAgentRuntimeRoute(url.pathname, request.method);
		if (!resolved) {
			return agentRuntimeNotFoundResponse();
		}
		if (resolved.route.dispatch === 'direct') {
			return handleAgentRuntimeRequest(request, env);
		}
		if (resolved.route.dispatch === 'user-coordinator') {
			const userId = decodeURIComponent(resolved.match[1] ?? '');
			const objectId = env.USER_BOTS.idFromName(userId);
			return env.USER_BOTS.get(objectId).fetch(request);
		}
		const botId = resolved.match[1] ?? 'unknown';
		const objectId = env.BOT_RUNTIME.idFromName(botId);
		return env.BOT_RUNTIME.get(objectId).fetch(request);
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(runScheduledAgentRuntimeTasks(env, event.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

async function runScheduledAgentRuntimeTasks(env: Env, scheduledTime: number): Promise<void> {
	await Promise.all([
		dispatchDueBots(env, scheduledTime),
		refreshGlobalInferenceCostStatsCacheIfStale(env.BICKR_D1, new Date(scheduledTime)).catch((error) => {
			console.warn('global inference cost stats refresh failed', error);
		}),
	]);
}

export async function dispatchDueBots(
	env: Env,
	scheduledTime: number,
	options: { batchSize?: number; maxDispatches?: number } = {},
): Promise<{ dispatched: number; budgetExhausted: boolean }> {
	const now = new Date(scheduledTime).toISOString();
	const batchSize = Math.max(1, Math.floor(options.batchSize ?? scheduledDispatchSelectLimit));
	const maxDispatches = Math.max(0, Math.floor(options.maxDispatches ?? scheduledDispatchBudget));
	let dispatched = 0;
	while (dispatched < maxDispatches) {
		const limit = Math.min(batchSize, maxDispatches - dispatched);
		const result = await env.BICKR_D1.prepare(
			`SELECT bot_id AS botId
			 FROM bot_runtime_index
			 WHERE enabled = 1
			   AND next_due_at IS NOT NULL
			   AND next_due_at <= ?
			   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
			 ORDER BY next_due_at ASC
			 LIMIT ?`,
		)
			.bind(now, now, limit)
			.all<{ botId: string }>();
		const rows = result.results ?? [];
		if (rows.length === 0) {
			break;
		}
		// #17's D1 CAS admission is authoritative. If another scheduler or a
		// stale page double-dispatches a bot, the BotRuntime DO rejects it safely.
		await Promise.all(
			rows.map(async (row) => {
				const id = env.BOT_RUNTIME.idFromName(row.botId);
				const parentSignal = new AbortController().signal;
				try {
					const headers = new Headers({
						'content-type': 'application/json',
						'x-bickr-scheduler': '1',
					});
					addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
					await withAbortableTimeout(
						parentSignal,
						scheduledDispatchTimeoutMs,
						() => new RuntimeOperationTimeoutError('Scheduled Bickr visit dispatch', scheduledDispatchTimeoutMs),
						(signal) =>
							env.BOT_RUNTIME.get(id).fetch(
								new Request(internalServiceUrl(`/bots/${encodeURIComponent(row.botId)}/tick`), {
									method: 'POST',
									signal,
									headers,
									body: JSON.stringify({ background: true }),
								}),
							),
					);
				} catch (error) {
					console.warn('scheduled bot tick dispatch failed', row.botId, error);
				}
			}),
		);
		dispatched += rows.length;
		if (rows.length < limit) {
			break;
		}
	}
	return { dispatched, budgetExhausted: maxDispatches > 0 && dispatched >= maxDispatches };
}
