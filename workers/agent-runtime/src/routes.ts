import { fail, ok, readJsonBody } from '@bickr/shared/api';
import type { AccountMutationResult } from '@bickr/shared/account-mutation-protocol';
import {
	copyAvatarImage,
	fetchRemoteAvatarBytes,
	normalizeAvatarPublicBaseUrl,
	storeAvatarImage,
	validateAvatarFile,
	type AvatarContentType,
} from '@bickr/shared/avatar-storage';
import {
	cleanupTerminalLifecycleOperations,
	lifecycleIdempotencyKey,
	nextLifecycleAlarmAt,
} from '@bickr/shared/entity-lifecycle';
import { makeId } from '@bickr/shared/ids';
import { json } from '@bickr/shared/http';
import { type ObjectIndexConvergenceTask, runObjectIndexConvergenceBatch } from '@bickr/shared/index-repair';
import {
	providerEnvironmentSettingsFromBindings,
	resolveBotProviderSettings,
	resolveLegacyTranslationProviderSettings,
} from '@bickr/shared/inference-settings';
import {
	InferenceConfigurationDataError,
	parseInferenceConfigurationOverridePatch,
	parseInferenceConfigurationOverrides,
	type InferenceConfigurationKind,
} from '@bickr/shared/inference-configuration';
import {
	bickrInferenceDefaultsFromEnvironment,
	canonicalInferenceConsumerBatch,
	canonicalTranslationInferenceAnnotation,
} from '@bickr/shared/inference-configuration-consumers';
import {
	inferenceOverridesFromLegacyTranslationSettings,
	inferenceOverridePatchFromLegacyBotSettingsMask,
	inferenceOverridePatchFromLegacyImageSettingsMask,
	inferenceOverridePatchFromLegacySettingsMask,
	inferenceOverridePatchFromLegacyTranslationSettingsMask,
	legacyImageCompatibilityFieldMask,
	legacyInferenceCompatibilityFieldMask,
	legacyInferenceCompatibilityFieldMaskIsEmpty,
	legacyModelCouplesLinkedCloneProvider,
	type LegacyInferenceCompatibilityFieldMask,
} from '@bickr/shared/inference-configuration-legacy';
import {
	inferenceConfigurationDeleteImpact,
	inferenceConfigurationParentImpact,
	inferenceConfigurationMutations,
	inferenceConfigurationOwnerDto,
	InferenceGraphRepositoryError,
	inferenceGraphReadVersion,
	loadInferenceConfigurationPath,
	listOwnedFixedInferenceConfigurationSummaries,
	listImmediateInferenceChildren,
	listInferenceConfigurations,
	listInferenceLibrarySection,
	listInferenceParentCandidates,
	ownedFixedInferenceConfigurationId,
	parseFixedInferenceConfigurationReference,
	parseInferenceConfigurationKinds,
	parseInferenceLibrarySection,
	readTranslationInferencePointer,
} from '@bickr/shared/inference-configuration-repository';
import {
	translationInferenceState,
	translationInferenceLifecycle,
} from '@bickr/shared/inference-translation-role';
import {
	migrateTranslationRoleForOwner,
	translationRoleMigrationStatus,
} from '@bickr/shared/inference-translation-role-migration';
import {
	type CredentialUpdate,
	maximumCanonicalInferenceAnnotationBatch,
	type CanonicalInferenceAnnotation,
	type CanonicalInferenceAnnotationRequest,
	type CanonicalInferenceFixedReference,
	type InferenceLibrarySection,
} from "@bickr/shared/inference-configuration-owner";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
	worldConfigurationId,
} from "@bickr/shared/inference-configuration-repository";
import {
	activateInferenceGraphLifecycle,
	beginInferenceGraphCompatibilityWrite,
	completeInferenceGraphCompatibilityWrite,
	cleanupInferenceGraphTerminalState,
	inferenceGraphMigrationStatus,
	listInferenceGraphFleetStatus,
	markInferenceGraphCompatibilitySourceWritten,
	pendingInferenceGraphCompatibilityWrite,
	reactivateInferenceGraphCutover,
	rollbackInferenceGraphCutover,
	runInferenceGraphMigrationStep,
} from '@bickr/shared/inference-configuration-migration';
import { addInternalServiceAuthHeader, internalServiceUrl, isTrustedInternalServiceRequest } from '@bickr/shared/internal-service';
import { mutationMaintenanceResponse, readMaintenanceState } from '@bickr/shared/maintenance';
import {
	botByHandle,
	botById,
	botSummaryById,
	userCoordinatorRepositoryMutations,
	humanProfileDeleteEligibility,
	listOwnedWorlds,
	listUserBots,
	listUserAuthIdentities,
	publicBotSummary,
	rawBotById,
	normalizeBotDefaults,
	RepositoryError,
	userById,
	userProfile,
	worldByHandle,
	worldPostingSettingsByIds,
	worldSummaryFromDocument,
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
	parseCreateBotGroupInput,
	parseCreateWorldInput,
	parseAddBotGroupMembersInput,
	parseUpdateBotInput,
	parseUpdateBotGroupInput,
	parseUpdateUserProfileInput,
	parseUpdateWorldInput,
	requiredText,
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
	avatarPromptSettingsRuntime,
	avatarProvider,
	effectiveAvatarSettingsLanguageForBot,
	effectiveAvatarSettingsLanguageForUser,
	effectiveAvatarSettingsLanguageForWorld,
	effectiveProviderSettingsForBotCanonical,
	errorResponse,
	parseTranslationInput,
	readOptionalJsonBody,
	requireAuthenticatedServiceRequest,
	requireAvatarBucket,
	requireSchedulerServiceRequest,
	requireUserMatch,
	runtimeRecord,
	translateForUser,
	upsertBotVector,
} from './runtime/bot-runtime';
import type { Env } from './types';
import type {
	AgentRuntimeRouteContext,
	AgentRuntimeRouteEnv,
	UserBotsCoordinatorContext,
} from './lifecycle/types';
import {
	providerProfileFromUnknown,
	reserveAccountDelete,
	resumeReservedAccountBootstrapOperation,
	runAccountDeleteOperation,
} from './lifecycle/account';
import {
	accountBootstrapOperationHeader,
	reservedAccountBootstrapOperation,
	reserveOrJoinAccountBootstrap,
} from './lifecycle/account-bootstrap-reservation';
import {
	reserveBotCreate,
	reserveBotDelete,
	runBotCreateOperation,
	runBotDeleteOperation,
} from './lifecycle/bot';
import {
	requestOwnerWorldMutation,
	requiredBotGroupMutationResult,
	requiredWorldMutationResult,
	reserveWorldCreate,
	reserveWorldDelete,
	runWorldCreateOperation,
	runWorldDeleteOperation,
} from './lifecycle/world';
import {
	armNextUserLifecycleAlarm,
	lifecycleRecoveryWakeRequestFromUnknown,
	recoverDueLifecycleOwners,
	resumeDueUserLifecycleOperation,
} from './lifecycle/recovery';
import { kvKeys, readJson } from '@bickr/shared/storage';
import { authProviders, type AuthProvider, type AvatarCrop, type AvatarImage, type BotDocument, type BotImageGenerationSettings, type BotInferenceSettings, type BotTranslationSettingsInput, type InferenceGraphErrorCause, type PublicBotEffectiveModel, type WorldDocument } from '@bickr/shared/model';

const {
	deleteBotAvatar,
	linkProviderIdentity,
	refreshLinkedCloneIndexes,
	refreshProviderIdentity,
	relinkBotClone,
	spreadUserBotTicks,
	unlinkBotClone,
	unlinkProviderIdentity,
	updateBot,
	updateBotAvatar,
	updateUserAvatar,
	updateUserProfile,
} = userCoordinatorRepositoryMutations;

const {
	createCustom: createInferenceConfiguration,
	deleteCustom: deleteInferenceConfiguration,
	ensureCompatibilityTranslation,
	renameCustom: renameInferenceConfiguration,
	reparent: reparentInferenceConfiguration,
	update: updateInferenceConfiguration,
	updateLegacyTranslationPointer,
} = inferenceConfigurationMutations;

type AgentRuntimeRouteHandler = (context: AgentRuntimeRouteContext) => Promise<Response>;

type AgentRuntimeHandlerRoute = {
	id: string;
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';
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

type AccountBootstrapDispatchRoute = {
	id: 'account-bootstrap-dispatch';
	method: 'POST';
	pattern: RegExp;
	dispatch: 'account-bootstrap';
};

type AgentRuntimeRoute = AgentRuntimeHandlerRoute | BotRuntimeDispatchRoute | AccountBootstrapDispatchRoute;

const userBotPattern = /^\/users\/([^/]+)\/bots\/([^/]+)$/;

async function worldForUpdateMutation(
	context: AgentRuntimeRouteContext,
	requestedHandle: string,
	nextHandle: string | undefined,
): Promise<{ id: string; handle: string }> {
	try {
		return await worldByHandle(context.env.BICKR_D1, requestedHandle);
	} catch (error) {
		if (!(error instanceof RepositoryError) || error.code !== 'not_found' || !nextHandle || nextHandle === requestedHandle) {
			throw error;
		}
		const candidate = await worldByHandle(context.env.BICKR_D1, nextHandle);
		const document = await readJson<WorldDocument>(context.env.BICKR_KV, kvKeys.world(candidate.id));
		if (!document || document.deletedAt || document.handle !== requestedHandle) {
			throw error;
		}
		// The world projection and canonical claim commit atomically before KV.
		// A failed KV write therefore leaves a narrowly recognizable replay:
		// D1 has the requested new handle while the stable-id document still has
		// the route's old handle. Dispatch that replay to the same world DO.
		return candidate;
	}
}

/**
 * Resolve one participant's effective model for a reader who proved nothing.
 *
 * The addressed world and participant are public, so their absence stays a
 * 404. Everything this function touches afterwards is owner-scoped: the owner
 * document, and the canonical inference graph whose failures are deliberately
 * expressive for the owner who is editing it. `InferenceGraphRepositoryError`
 * carries an `inferenceGraphCause` in typed details, its prose names
 * configuration ids, a missing configuration answers 404, and a cross-owner
 * row answers 409 — a public reader must learn none of that, and even the
 * distinction between "this graph is broken" and "this account was deleted" is
 * owner-only. So every failure past the entity lookup, typed or not, collapses
 * to one constant 500 with no code, id, cause, or message taken from it. What
 * operators read instead is `publicEffectiveModelFailureEvent`.
 */
async function publicEffectiveModelForBot(
	env: Pick<AgentRuntimeRouteEnv, 'BICKR_D1' | 'BICKR_KV' | 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'OPENROUTER_MODEL'>,
	bot: BotDocument,
): Promise<string> {
	// Which of the two owner-scoped reads failed is the diagnosis the collapsed
	// error can no longer carry, and it cannot be recovered from the error either
	// — a KV outage and a D1 outage arrive here as the same untyped value.
	let stage: PublicEffectiveModelStage = 'owner_document';
	try {
		const owner = await userById(env.BICKR_KV, bot.ownerUserId);
		stage = 'canonical_resolution';
		const settings = await effectiveProviderSettingsForBotCanonical(env.BICKR_D1, bot, owner, env);
		return settings.model;
	} catch (error) {
		console.error(publicEffectiveModelFailureEvent(bot.id, stage, error));
		throw new RepositoryError('server_error', 'Effective model is unavailable.', 500);
	}
}

type PublicEffectiveModelStage = 'owner_document' | 'canonical_resolution';

/**
 * The `code` and `inferenceGraphCause` values this log is allowed to name.
 *
 * Written as exhaustive tables rather than a type assertion so that a new union
 * member is a compile error here, and so that the emitted value is always one
 * of these literals rather than whatever string the error happened to hold.
 */
const loggableRepositoryErrorCodes = {
	bad_request: true,
	conflict: true,
	forbidden: true,
	not_found: true,
	server_error: true,
	unauthorized: true,
} as const satisfies Record<RepositoryError['code'], true>;

const loggableInferenceGraphCauses = {
	account_default_required: true,
	corrupt_graph: true,
	cross_owner: true,
	descendant_parent: true,
	duplicate_name: true,
	fixed_entry_requires_lifecycle: true,
	invalid_parent: true,
	quota_exceeded: true,
	self_parent: true,
	stale_revision: true,
	unexpected_unique_conflict: true,
} as const satisfies Record<InferenceGraphErrorCause, true>;

function allowlistedValue<T extends string>(table: Record<T, true>, value: unknown): T | undefined {
	// `hasOwn`, not `in`: an inherited `constructor` or `toString` is not a member.
	return typeof value === 'string' && Object.hasOwn(table, value) ? (value as T) : undefined;
}

/**
 * The one event an opaque public failure leaves behind for operators.
 *
 * The catch above spans owner KV loading, canonical D1 loading, and resolution,
 * so the value it holds is genuinely unknown: typed repository errors, untyped
 * platform failures, and errors a dependency threw with arbitrary text, cause,
 * or metadata attached all arrive there. Logging that object would republish
 * into Workers Logs exactly what the response just refused to disclose — the
 * owner's configuration ids and graph diagnostics — and would put any secret a
 * future thrower attaches there too.
 *
 * So nothing is copied out of the error. `botId` and `stage` are produced by
 * this worker, `errorKind` is decided by `instanceof` rather than read from the
 * value, and the two string fields are emitted only when the error's own value
 * is a member of the tables above. `status` is admitted as a number. Anything
 * unrecognized — including every message, stack, and cause — is dropped, so an
 * unfamiliar failure logs that it happened and where, and nothing else.
 */
function publicEffectiveModelFailureEvent(botId: string, stage: PublicEffectiveModelStage, error: unknown): string {
	return JSON.stringify({
		event: 'public_effective_model_failed',
		botId,
		stage,
		errorKind: error instanceof InferenceGraphRepositoryError
			? 'inference_graph_repository'
			: error instanceof RepositoryError
				? 'repository'
				: error instanceof Error
					? 'error'
					: 'unknown',
		...(error instanceof RepositoryError
			? {
				code: allowlistedValue(loggableRepositoryErrorCodes, error.code),
				status: typeof error.status === 'number' && Number.isFinite(error.status) ? error.status : undefined,
				inferenceGraphCause: allowlistedValue(loggableInferenceGraphCauses, error.details?.inferenceGraphCause),
			}
			: {}),
	});
}

export const agentRuntimeRouteTable = [
	{
		id: 'account-bootstrap-dispatch',
		method: 'POST',
		pattern: /^\/accounts\/bootstrap$/,
		dispatch: 'account-bootstrap',
	},
	{
		id: 'lifecycle-recovery',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/lifecycle\/recover$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) {
				throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			}
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			requireSchedulerServiceRequest(context.request);
			if (context.coordinator.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', 'Lifecycle recovery was dispatched to the wrong coordinator.', 403);
			}
			const wake = lifecycleRecoveryWakeRequestFromUnknown(await readJsonBody(context.request));
			const result = await resumeDueUserLifecycleOperation(context, wake.scheduledAt);
			await armNextUserLifecycleAlarm(context.env.BICKR_D1, context.coordinator);
			return ok(result);
		},
	},
	{
		id: 'user-avatar-upload',
		method: 'PUT',
		pattern: /^\/users\/([^/]+)\/avatar$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const avatar = await storedAvatarFromRequest(context, { kind: 'user', userId });
			return ok({ profile: await updateUserAvatar(context.env.BICKR_KV, context.env.BICKR_D1, userId, avatar), coordinator: context.objectId });
		},
	},
	{
		id: 'user-avatar-delete',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/avatar$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			return ok({ profile: await updateUserAvatar(context.env.BICKR_KV, context.env.BICKR_D1, userId, undefined), coordinator: context.objectId });
		},
	},
	{
		id: 'user-avatar-crop',
		method: 'PATCH',
		pattern: /^\/users\/([^/]+)\/avatar\/crop$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const user = await userById(context.env.BICKR_KV, userId);
			const avatar = await croppedAvatarFromRequest(context.request, user.avatar, 'Your profile does not have an avatar to crop.');
			return ok({ profile: await updateUserAvatar(context.env.BICKR_KV, context.env.BICKR_D1, userId, avatar), coordinator: context.objectId });
		},
	},
	{
		id: 'bot-avatar-upload',
		method: 'PUT',
		pattern: /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const bot = await botById(context.env.BICKR_KV, context.env.BICKR_D1, botId);
			if (bot.ownerUserId !== userId) throw new RepositoryError('forbidden', "Only this participant's owner can update its avatar.", 403);
			const avatar = await storedAvatarFromRequest(context, { kind: 'bot', botId, worldId: bot.homeWorldId });
			const updated = await updateBotAvatar(context.env.BICKR_KV, context.env.BICKR_D1, botId, userId, avatar);
			return ok({ bot: updated, affectedBots: await refreshLinkedCloneIndexes(context.env.BICKR_KV, context.env.BICKR_D1, botId), coordinator: context.objectId });
		},
	},
	{
		id: 'bot-avatar-delete',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const updated = await deleteBotAvatar(context.env.BICKR_KV, context.env.BICKR_D1, botId, userId);
			return ok({ bot: updated, affectedBots: await refreshLinkedCloneIndexes(context.env.BICKR_KV, context.env.BICKR_D1, botId), coordinator: context.objectId });
		},
	},
	{
		id: 'bot-avatar-crop',
		method: 'PATCH',
		pattern: /^\/users\/([^/]+)\/bots\/([^/]+)\/avatar\/crop$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const botId = decodeURIComponent(context.match[2] ?? '');
			const bot = await rawBotById(context.env.BICKR_KV, context.env.BICKR_D1, botId);
			if (bot.ownerUserId !== userId) throw new RepositoryError('forbidden', "Only this participant's owner can crop its avatar.", 403);
			const avatar = await croppedAvatarFromRequest(context.request, bot.avatar, 'This participant does not have an avatar to crop.');
			const updated = await updateBotAvatar(context.env.BICKR_KV, context.env.BICKR_D1, botId, userId, avatar);
			return ok({ bot: updated, affectedBots: await refreshLinkedCloneIndexes(context.env.BICKR_KV, context.env.BICKR_D1, botId), coordinator: context.objectId });
		},
	},
	{
		id: 'world-avatar-upload',
		method: 'PUT',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const worldRef = await worldByHandle(context.env.BICKR_D1, worldHandle);
			const world = await readJson<WorldDocument>(context.env.BICKR_KV, kvKeys.world(worldRef.id));
			if (!world || world.createdByUserId !== userId) throw new RepositoryError('forbidden', "Only this world's owner can update its avatar.", 403);
			const avatar = await storedAvatarFromRequest(context, { kind: 'world', worldId: world.id });
			const result = await requestOwnerWorldMutation(context, world.id, userId, { kind: 'avatar_update', worldHandle, avatar });
			return ok({ world: requiredWorldMutationResult(result), coordinator: context.objectId });
		},
	},
	{
		id: 'world-avatar-delete',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const world = await worldByHandle(context.env.BICKR_D1, worldHandle);
			const result = await requestOwnerWorldMutation(context, world.id, userId, { kind: 'avatar_update', worldHandle });
			return ok({ world: requiredWorldMutationResult(result), coordinator: context.objectId });
		},
	},
	{
		id: 'world-avatar-crop',
		method: 'PATCH',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/avatar\/crop$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const worldRef = await worldByHandle(context.env.BICKR_D1, worldHandle);
			const world = await readJson<WorldDocument>(context.env.BICKR_KV, kvKeys.world(worldRef.id));
			if (!world || world.createdByUserId !== userId) throw new RepositoryError('forbidden', "Only this world's owner can crop its avatar.", 403);
			const avatar = await croppedAvatarFromRequest(context.request, world.avatar, 'This world does not have an avatar to crop.');
			const result = await requestOwnerWorldMutation(context, world.id, userId, { kind: 'avatar_update', worldHandle, avatar });
			return ok({ world: requiredWorldMutationResult(result), coordinator: context.objectId });
		},
	},
	{
		id: 'account-bootstrap',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/account\/bootstrap$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = decodeURIComponent(context.match[1] ?? '');
			if (!userId || context.coordinator.ownerUserId && context.coordinator.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', 'Account bootstrap was dispatched to the wrong coordinator.', 403);
			}
			const profile = providerProfileFromUnknown(await readJsonBody(context.request));
			const operationId = context.request.headers.get(accountBootstrapOperationHeader)?.trim();
			if (operationId) {
				const reserved = await reservedAccountBootstrapOperation(context.env.BICKR_D1, {
					operationId,
					profile,
					userId,
				});
				await resumeReservedAccountBootstrapOperation(context, reserved.operation, reserved.profile);
			} else {
				const existing = await refreshProviderIdentity(context.env.BICKR_KV, context.env.BICKR_D1, profile);
				if (existing.id !== userId) {
					throw new RepositoryError('conflict', 'Provider identity belongs to another account.', 409);
				}
			}
			const user = await userById(context.env.BICKR_KV, userId);
			const result = {
				kind: 'account_bootstrapped',
				profile: userProfile(user, await listUserAuthIdentities(context.env.BICKR_D1, user.id)),
				user,
			} satisfies AccountMutationResult;
			return ok({ ...result, coordinator: context.objectId }, { status: 201 });
		},
	},
	{
		id: 'inference-graph-migration-status',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-graph\/migration$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			if (context.coordinator.ownerUserId !== userId) throw new RepositoryError('forbidden', 'Migration status was dispatched to the wrong coordinator.', 403);
			return ok({ migration: await inferenceGraphMigrationStatus(context.env.BICKR_D1, userId), coordinator: context.objectId });
		},
	},
	{
		id: 'run-inference-graph-migration',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/inference-graph\/migrate$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			requireSchedulerServiceRequest(context.request);
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			if (context.coordinator.ownerUserId !== userId) throw new RepositoryError('forbidden', 'Migration was dispatched to the wrong coordinator.', 403);
			return ok({ migration: await runInferenceGraphMigrationStep(context.env, userId), coordinator: context.objectId });
		},
	},
	{
		id: 'translation-role-migration-status',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-translation-role\/migration$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			requireSchedulerServiceRequest(context.request);
			const maintenance = await readMaintenanceState(context.env.BICKR_D1);
			if (!maintenance.enabled) throw new RepositoryError('conflict', 'Translation role migration status requires maintenance mode.', 409);
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			if (context.coordinator.ownerUserId !== userId) throw new RepositoryError('forbidden', 'Translation role migration status was dispatched to the wrong coordinator.', 403);
			const user = await userById(context.env.BICKR_KV, userId);
			return ok({ migration: await translationRoleMigrationStatus(
				context.env.BICKR_D1, userId, Boolean(user.inferenceSettings?.translation?.enabled),
			), coordinator: context.objectId });
		},
	},
	{
		id: 'migrate-translation-role',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/inference-translation-role\/migrate$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			requireSchedulerServiceRequest(context.request);
			const maintenance = await readMaintenanceState(context.env.BICKR_D1);
			if (!maintenance.enabled) throw new RepositoryError('conflict', 'Translation role migration requires maintenance mode.', 409);
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			if (context.coordinator.ownerUserId !== userId) throw new RepositoryError('forbidden', 'Translation role migration was dispatched to the wrong coordinator.', 403);
			const user = await userById(context.env.BICKR_KV, userId);
			return ok({ migration: await migrateTranslationRoleForOwner(
				context.env.BICKR_D1, userId, Boolean(user.inferenceSettings?.translation?.enabled),
			), coordinator: context.objectId });
		},
	},
	{
		id: 'rollback-inference-graph',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/inference-graph\/rollback$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			requireSchedulerServiceRequest(context.request);
			const maintenance = await readMaintenanceState(context.env.BICKR_D1);
			if (!maintenance.enabled) throw new RepositoryError('conflict', 'Inference graph rollback requires maintenance mode.', 409);
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			if (context.coordinator.ownerUserId !== userId) throw new RepositoryError('forbidden', 'Rollback was dispatched to the wrong coordinator.', 403);
			await rollbackInferenceGraphCutover(context.env.BICKR_D1, userId);
			return ok({ rolledBack: true, coordinator: context.objectId });
		},
	},
	{
		id: 'reactivate-inference-graph',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/inference-graph\/reactivate$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			requireSchedulerServiceRequest(context.request);
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			if (context.coordinator.ownerUserId !== userId) throw new RepositoryError('forbidden', 'Reactivation was dispatched to the wrong coordinator.', 403);
			await reactivateInferenceGraphCutover(context.env.BICKR_D1, userId);
			return ok({ reactivated: true, coordinator: context.objectId });
		},
	},
	{
		id: 'list-inference-configurations',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-configurations$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			const selection = inferenceLibrarySelection(context.url);
			const input = {
				...inferenceListingInput(context.url),
				defaults: await bickrInferenceDefaultsFromEnvironment(context.env),
			};
			return ok({
				configurations: selection.kind === 'section'
					? await listInferenceLibrarySection(context.env.BICKR_D1, userId, { ...input, section: selection.section })
					: await listInferenceConfigurations(context.env.BICKR_D1, userId, {
						...input,
						...(selection.kind === 'kinds' ? { kinds: selection.kinds } : {}),
					}),
				coordinator: context.objectId,
			});
		},
	},
	{
		id: 'create-inference-configuration',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/inference-configurations$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			const body = requiredRecord(await readJsonBody(context.request));
			const configuration = await createInferenceConfiguration(context.env.BICKR_D1, userId, {
				name: requiredString(body.name, 'name'),
				parentId: requiredString(body.parentId, 'parentId'),
				...(body.overrides !== undefined ? { overrides: parseInferenceOverridesForRoute(body.overrides) } : {}),
				...(body.credential !== undefined ? { credential: parseCredentialUpdate(body.credential) } : {}),
			});
			return ok({ configuration: await inferenceConfigurationOwnerDto(
				context.env.BICKR_D1, userId, configuration.id, await bickrInferenceDefaultsFromEnvironment(context.env),
			), coordinator: context.objectId }, { status: 201 });
		},
	},
	{
		id: 'inference-configuration-parent-candidates',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/([^/]+)\/parent-candidates$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			return ok({ candidates: await listInferenceParentCandidates(
				context.env.BICKR_D1,
				userId,
				decodeURIComponent(context.match[2] ?? ''),
				{ ...inferenceListingInput(context.url), defaults: await bickrInferenceDefaultsFromEnvironment(context.env) },
			), coordinator: context.objectId });
		},
	},
	{
		id: 'inference-configuration-children',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/([^/]+)\/children$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			return ok({ children: await listImmediateInferenceChildren(
				context.env.BICKR_D1,
				userId,
				decodeURIComponent(context.match[2] ?? ''),
				{ ...inferenceListingInput(context.url), defaults: await bickrInferenceDefaultsFromEnvironment(context.env) },
			), coordinator: context.objectId });
		},
	},
	{
		id: 'inference-configuration-impact',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/([^/]+)\/impact$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			const configurationId = decodeURIComponent(context.match[2] ?? '');
			const candidateParentId = context.url.searchParams.get('parentId');
			const defaults = await bickrInferenceDefaultsFromEnvironment(context.env);
			return ok({
				impact: candidateParentId
					? await inferenceConfigurationParentImpact(context.env.BICKR_D1, userId, configurationId, candidateParentId, defaults)
					: await inferenceConfigurationDeleteImpact(context.env.BICKR_D1, userId, configurationId, defaults),
				coordinator: context.objectId,
			});
		},
	},
	{
		id: 'rename-inference-configuration',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/([^/]+)\/rename$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			const body = requiredRecord(await readJsonBody(context.request));
			const configuration = await renameInferenceConfiguration(context.env.BICKR_D1, userId, {
				configurationId: decodeURIComponent(context.match[2] ?? ''),
				name: requiredString(body.name, 'name'),
				expectedRevision: requiredPositiveInteger(body.expectedRevision, 'expectedRevision'),
			});
			return ok({ configuration: await inferenceConfigurationOwnerDto(
				context.env.BICKR_D1, userId, configuration.id, await bickrInferenceDefaultsFromEnvironment(context.env),
			), coordinator: context.objectId });
		},
	},
	{
		id: 'reparent-inference-configuration',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/([^/]+)\/reparent$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			const body = requiredRecord(await readJsonBody(context.request));
			const configuration = await reparentInferenceConfiguration(context.env.BICKR_D1, userId, {
				configurationId: decodeURIComponent(context.match[2] ?? ''),
				parentId: requiredString(body.parentId, 'parentId'),
				expectedRevision: requiredPositiveInteger(body.expectedRevision, 'expectedRevision'),
			});
			return ok({ configuration: await inferenceConfigurationOwnerDto(
				context.env.BICKR_D1, userId, configuration.id, await bickrInferenceDefaultsFromEnvironment(context.env),
			), coordinator: context.objectId });
		},
	},
	{
		// Read-only consumer presentation deliberately bypasses the edit cutover
		// gate. Authorization and entity ownership remain mandatory, while the
		// resolver follows the same 0/1/2 state machine as provider execution.
		id: 'get-inference-consumer-annotations',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/inference-consumers\/annotations$/,
		dispatch: 'direct',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const request = parseCanonicalInferenceAnnotationRequest(await readJsonBody(context.request));
			return ok(await canonicalInferenceAnnotations(context, userId, request));
		},
	},
	{
		// Set-oriented canonical model labels for the participants an owner screen
		// is already rendering. It answers with resolved model strings only, so an
		// owner UI never reconstructs an effective model locally and never reads a
		// configuration per row. Registered before the single-configuration route,
		// whose pattern would otherwise claim this path segment.
		id: 'inference-configuration-bot-effective-models',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/effective-models$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			if (context.coordinator.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', 'Inference consumer request was dispatched to the wrong coordinator.', 403);
			}
			const botIds = (context.url.searchParams.get('botIds') ?? '')
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean);
			const request = parseCanonicalInferenceAnnotationRequest({ botIds });
			const annotations = await canonicalInferenceAnnotations(context, userId, request);
			return ok({
				effectiveModels: {
					models: annotations.annotations.flatMap((annotation) => annotation.reference.kind === 'bot'
						? [{
							botId: annotation.reference.botId,
							effectiveModel: annotation.kind === 'canonical'
								? annotation.configuration.effectiveModel
								: annotation.effectiveModel,
						}]
						: []),
				},
				coordinator: context.objectId,
			});
		},
	},
	{
		// The single inference fact a public participant profile publishes.
		//
		// Every viewer reads the same string because resolution is pinned to the
		// participant's own owner and the caller is never an input: the Pages
		// proxy sends no viewer identity, and this handler asks for none. It runs
		// the same canonical resolution the runtime runs for a real tick, so the
		// value is live rather than a publish-time snapshot, and it projects only
		// the effective model out of the resolved provider settings — never the
		// base URL, provider routing, credential, or the configuration graph that
		// produced it.
		//
		// Addressing is the world/handle pair the rest of the public profile
		// already uses, so visibility and not-found behavior are exactly the
		// public profile's: one participant per request, no batch, no
		// enumeration. Everything past that addressed lookup is owner-scoped and
		// fails opaquely — see publicEffectiveModelForBot.
		id: 'public-bot-effective-model',
		method: 'GET',
		pattern: /^\/worlds\/([^/]+)\/bots\/([^/]+)\/effective-model$/,
		dispatch: 'direct',
		handler: async (context) => {
			const world = await worldByHandle(context.env.BICKR_D1, decodeURIComponent(context.match[1] ?? ''));
			const bot = await botByHandle(
				context.env.BICKR_KV,
				context.env.BICKR_D1,
				world.id,
				decodeURIComponent(context.match[2] ?? ''),
			);
			if (!bot) {
				throw new RepositoryError('not_found', 'Bot not found.', 404);
			}
			return ok({
				model: {
					botId: bot.id,
					effectiveModel: await publicEffectiveModelForBot(context.env, bot),
				} satisfies PublicBotEffectiveModel,
			});
		},
	},
	{
		// Owner-authenticated lookup of the fixed entry belonging to one account,
		// world, or participant. Ownership of the named entity is checked before
		// its configuration address is derived, so a client never derives one and
		// an unowned entity is an ordinary not-found.
		id: 'get-fixed-inference-configuration',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/fixed\/([^/]+)\/?([^/]*)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			const reference = parseFixedInferenceConfigurationReference(
				decodeURIComponent(context.match[2] ?? ''),
				decodeURIComponent(context.match[3] ?? ''),
			);
			const configurationId = await ownedFixedInferenceConfigurationId(context.env.BICKR_D1, userId, reference);
			return ok({ configuration: await inferenceConfigurationOwnerDto(
				context.env.BICKR_D1,
				userId,
				configurationId,
				await bickrInferenceDefaultsFromEnvironment(context.env),
			), coordinator: context.objectId });
		},
	},
	{
		id: 'get-inference-configuration',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			return ok({ configuration: await inferenceConfigurationOwnerDto(
				context.env.BICKR_D1,
				userId,
				decodeURIComponent(context.match[2] ?? ''),
				await bickrInferenceDefaultsFromEnvironment(context.env),
			), coordinator: context.objectId });
		},
	},
	{
		id: 'update-inference-configuration',
		method: 'PATCH',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			const body = requiredRecord(await readJsonBody(context.request));
			if (body.overrides === undefined && body.credential === undefined) throw new InputError('An overrides or credential update is required.');
			const configuration = await updateInferenceConfiguration(context.env.BICKR_D1, userId, {
				configurationId: decodeURIComponent(context.match[2] ?? ''),
				expectedRevision: requiredPositiveInteger(body.expectedRevision, 'expectedRevision'),
				...(body.overrides !== undefined ? { overrides: parseInferencePatchForRoute(body.overrides) } : {}),
				...(body.credential !== undefined ? { credential: parseCredentialUpdate(body.credential) } : {}),
			});
			return ok({ configuration: await inferenceConfigurationOwnerDto(
				context.env.BICKR_D1, userId, configuration.id, await bickrInferenceDefaultsFromEnvironment(context.env),
			), coordinator: context.objectId });
		},
	},
	{
		id: 'delete-inference-configuration',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/inference-configurations\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = await requireInferenceGraphOwner(context);
			const body = requiredRecord(await readJsonBody(context.request));
			const impact = await deleteInferenceConfiguration(context.env.BICKR_D1, userId, {
				configurationId: decodeURIComponent(context.match[2] ?? ''),
				expectedRevision: requiredPositiveInteger(body.expectedRevision, 'expectedRevision'),
				defaults: await bickrInferenceDefaultsFromEnvironment(context.env),
			});
			return ok({ impact, coordinator: context.objectId });
		},
	},
	{
		id: 'get-inference-translation-annotation',
		method: 'GET',
		pattern: /^\/users\/([^/]+)\/inference-translation\/annotation$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			if (context.coordinator.ownerUserId !== userId) {
				throw new RepositoryError('forbidden', 'Translation annotation was dispatched to the wrong coordinator.', 403);
			}
			const version = await inferenceGraphReadVersion(context.env.BICKR_D1, userId);
			let legacyEnabled = false;
			if (version.cutoverVersion !== 0) {
				const transition = await translationInferenceState(context.env.BICKR_D1, userId);
				legacyEnabled = transition.kind === 'migration_pending'
					? Boolean((await userById(context.env.BICKR_KV, userId)).inferenceSettings?.translation?.enabled)
					: false;
			}
			return ok({
				annotation: await canonicalTranslationInferenceAnnotation(
					context.env.BICKR_D1,
					userId,
					context.env,
					legacyEnabled,
				),
				coordinator: context.objectId,
			});
		},
	},
	{
		id: 'inference-graph-fleet-status',
		method: 'GET',
		pattern: /^\/inference-graph\/fleet-status$/,
		dispatch: 'direct',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) {
				throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			}
			requireSchedulerServiceRequest(context.request);
			return ok({ status: await listInferenceGraphFleetStatus(context.env.BICKR_D1, {
				...(context.url.searchParams.get('cursor') ? { cursor: context.url.searchParams.get('cursor')! } : {}),
				...(context.url.searchParams.get('limit') ? { limit: requiredPositiveInteger(context.url.searchParams.get('limit'), 'limit') } : {}),
			}) });
		},
	},
	{
		id: 'inference-graph-cleanup',
		method: 'POST',
		pattern: /^\/inference-graph\/cleanup$/,
		dispatch: 'direct',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) {
				throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			}
			requireSchedulerServiceRequest(context.request);
			const maintenance = await readMaintenanceState(context.env.BICKR_D1);
			if (!maintenance.enabled) throw new RepositoryError('conflict', 'Inference graph cleanup requires maintenance mode.', 409);
			const body = requiredRecord(await readJsonBody(context.request));
			return ok({ cleanup: await cleanupInferenceGraphTerminalState(
				context.env.BICKR_D1,
				new Date().toISOString(),
				body.limit === undefined ? undefined : requiredPositiveInteger(body.limit, 'limit'),
			) });
		},
	},
	{
		id: 'activate-inference-graph-lifecycle',
		method: 'POST',
		pattern: /^\/inference-graph\/activate-lifecycle$/,
		dispatch: 'direct',
		handler: async (context) => {
			if (!isTrustedInternalServiceRequest(context.request, context.env.INTERNAL_SERVICE_SECRET)) {
				throw new RepositoryError('unauthorized', 'Authentication is required.', 401);
			}
			requireSchedulerServiceRequest(context.request);
			return ok(await activateInferenceGraphLifecycle(context.env.BICKR_D1));
		},
	},
	{
		id: 'health',
		method: '*',
		pattern: /^\/health$/,
		dispatch: 'direct',
		handler: async ({ env }) =>
			json({
				maintenance: await readMaintenanceState(env.BICKR_D1),
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
		id: 'update-profile',
		method: 'PATCH',
		pattern: /^\/users\/([^/]+)\/profile$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const input = parseUpdateUserProfileInput(await readJsonBody(context.request));
			const version = await inferenceGraphReadVersion(context.env.BICKR_D1, userId);
			const translationPatch = input.inferenceSettings?.translation;
			let currentUser: Awaited<ReturnType<typeof userById>> | null = null;
			if (version.cutoverVersion !== 0) {
				currentUser = await userById(context.env.BICKR_KV, userId);
				const state = await translationInferenceState(context.env.BICKR_D1, userId);
				let enabled = state.kind === 'canonical'
					? state.enabled
					: Boolean(currentUser.inferenceSettings?.translation?.enabled);
				const requestedEnabled = translationPatch === null
					? false
					: translationPatch?.enabled;
				if (requestedEnabled !== undefined && requestedEnabled !== enabled) {
					if (version.cutoverVersion === 2) {
						throw new RepositoryError('conflict', 'Translation inference cannot be enabled or disabled during compatibility rollback.', 409);
					}
					const canonical = requestedEnabled
						? await translationInferenceLifecycle.enable(context.env.BICKR_D1, userId)
						: await translationInferenceLifecycle.disable(context.env.BICKR_D1, userId);
					enabled = canonical.enabled;
				}
				if (input.inferenceSettings && translationPatch !== undefined) {
					input.inferenceSettings = {
						...input.inferenceSettings,
						translation: canonicalTranslationMirrorPatch(enabled, translationPatch),
					};
				}
			}
			const compatibilityFieldMask = input.inferenceSettings === undefined
				? null
				: legacyInferenceCompatibilityFieldMask(input.inferenceSettings);
			if (compatibilityFieldMask) {
				const current = currentUser ?? await userById(context.env.BICKR_KV, userId);
				await prepareLegacyInferenceCompatibilityWrite(context, userId, 'account', userId, current.revision, compatibilityFieldMask);
			}
			const profile = await updateUserProfile(context.env.BICKR_KV, context.env.BICKR_D1, userId, input);
			if (compatibilityFieldMask) await resumePendingLegacyInferenceCompatibilityWrite(context, userId);
			const annotation = await canonicalTranslationInferenceAnnotation(
				context.env.BICKR_D1,
				userId,
				context.env,
				Boolean(profile.inferenceSettings.translation?.enabled),
			);
			const result = {
				kind: 'profile_updated',
				profile: { ...profile, ...(annotation ? { translationInference: annotation } : {}) },
			} satisfies AccountMutationResult;
			return ok({ ...result, coordinator: context.objectId });
		},
	},
	{
		id: 'link-provider-identity',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/auth\/identities$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const profile = providerProfileFromUnknown(await readJsonBody(context.request));
			const user = await linkProviderIdentity(context.env.BICKR_KV, context.env.BICKR_D1, userId, profile);
			const result = { kind: 'provider_identity_linked', profile: userProfile(user, await listUserAuthIdentities(context.env.BICKR_D1, userId)) } satisfies AccountMutationResult;
			return ok({ ...result, coordinator: context.objectId });
		},
	},
	{
		id: 'unlink-provider-identity',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/auth\/identities\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const providerValue = decodeURIComponent(context.match[2] ?? '');
			if (!(authProviders as readonly string[]).includes(providerValue)) {
				throw new RepositoryError('not_found', 'Sign-in provider not found.', 404);
			}
			const identities = await unlinkProviderIdentity(context.env.BICKR_D1, userId, providerValue as AuthProvider);
			const result = { kind: 'provider_identity_unlinked', profile: userProfile(await userById(context.env.BICKR_KV, userId), identities) } satisfies AccountMutationResult;
			return ok({ ...result, coordinator: context.objectId });
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
				await Promise.all(bots.map(async (bot) => ({
					botId: bot.id,
					currentModel: (await effectiveProviderSettingsForBotCanonical(context.env.BICKR_D1, bot, owner, context.env)).model,
				}))),
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
			const compatibilityFieldMask = settingsInput?.inferenceSettings === undefined
				? null
				: legacyInferenceCompatibilityFieldMask(settingsInput.inferenceSettings);
			let profile = await applyGeneratedAvatarForUser(
				context.env,
				userId,
				parseAvatarCandidateValue(body.candidate),
				(targetUserId, avatar) => updateUserAvatar(
					context.env.BICKR_KV,
					context.env.BICKR_D1,
					targetUserId,
					avatar,
				),
			);
				if (settingsInput?.inferenceSettings !== undefined && compatibilityFieldMask) {
					const current = await userById(context.env.BICKR_KV, userId);
					await prepareLegacyInferenceCompatibilityWrite(context, userId, 'account', userId, current.revision, compatibilityFieldMask);
					profile = await updateUserProfile(context.env.BICKR_KV, context.env.BICKR_D1, userId, {
					inferenceSettings: settingsInput.inferenceSettings,
				});
				await resumePendingLegacyInferenceCompatibilityWrite(context, userId);
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
			if (input.importSource?.sourceAvatarUrl) {
				requireAvatarBucket(context.env);
				normalizeAvatarPublicBaseUrl(context.env.BICKR_R2_PUBLIC_BASE_URL);
			}
			const operation = await reserveBotCreate(context, userId, worldHandle, input);
			await runBotCreateOperation(context, operation);
			const bot = await botSummaryById(context.env.BICKR_KV, context.env.BICKR_D1, operation.entityId);
			return ok({ bot, coordinator: context.objectId }, { status: 201 });
		},
	},
	{
		id: 'create-world',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/worlds$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const input = parseCreateWorldInput(await readJsonBody(context.request));
			const operation = await reserveWorldCreate(context, userId, input);
			await runWorldCreateOperation(context, operation);
			const world = (await listOwnedWorlds(context.env.BICKR_D1, userId)).find((candidate) => candidate.id === operation.entityId);
			if (!world) {
				throw new RepositoryError('server_error', 'Activated world projection is missing.', 500);
			}
			return ok({ world, coordinator: context.objectId }, { status: 201 });
		},
	},
	{
		id: 'update-world',
		method: 'PATCH',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
				const input = parseUpdateWorldInput(await readJsonBody(context.request));
				const world = await worldForUpdateMutation(context, worldHandle, input.handle);
				const compatibilityFieldMask = input.imageGeneration === undefined
					? null
					: legacyImageCompatibilityFieldMask(input.imageGeneration);
				if (compatibilityFieldMask) {
					const current = await readJson<WorldDocument>(context.env.BICKR_KV, kvKeys.world(world.id));
					if (!current) throw new RepositoryError('server_error', 'World compatibility source document is missing.', 500);
					await prepareLegacyInferenceCompatibilityWrite(context, userId, 'world', world.id, current.revision, compatibilityFieldMask);
				}
				const result = await requestOwnerWorldMutation(context, world.id, userId, { kind: 'world_update', worldHandle, input });
			const updated = requiredWorldMutationResult(result);
			if (compatibilityFieldMask) await resumePendingLegacyInferenceCompatibilityWrite(context, userId);
			return ok({ world: updated, coordinator: context.objectId });
		},
	},
	{
		id: 'delete-world',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const operation = await reserveWorldDelete(context, userId, worldHandle);
			await runWorldDeleteOperation(context, operation);
			const deleted = await readJson<WorldDocument>(context.env.BICKR_KV, kvKeys.world(operation.entityId));
			if (!deleted?.deletedAt) {
				throw new RepositoryError('server_error', 'Deleted world document is missing.', 500);
			}
			return ok({ world: worldSummaryFromDocument(deleted), coordinator: context.objectId });
		},
	},
	{
		id: 'create-bot-group',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/groups$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const world = await worldByHandle(context.env.BICKR_D1, worldHandle);
			const result = await requestOwnerWorldMutation(context, world.id, userId, {
				kind: 'bot_group_create',
				worldHandle,
				input: parseCreateBotGroupInput(await readJsonBody(context.request)),
			});
			return ok({ group: requiredBotGroupMutationResult(result, 'bot_group_created'), coordinator: context.objectId }, { status: 201 });
		},
	},
	{
		id: 'update-bot-group',
		method: 'PATCH',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/groups\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const world = await worldByHandle(context.env.BICKR_D1, worldHandle);
			const result = await requestOwnerWorldMutation(context, world.id, userId, {
				kind: 'bot_group_update',
				worldHandle,
				groupId: decodeURIComponent(context.match[3] ?? ''),
				input: parseUpdateBotGroupInput(await readJsonBody(context.request)),
			});
			return ok({ group: requiredBotGroupMutationResult(result, 'bot_group_updated'), coordinator: context.objectId });
		},
	},
	{
		id: 'delete-bot-group',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/groups\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const world = await worldByHandle(context.env.BICKR_D1, worldHandle);
			const result = await requestOwnerWorldMutation(context, world.id, userId, {
				kind: 'bot_group_delete', worldHandle, groupId: decodeURIComponent(context.match[3] ?? ''),
			});
			return ok({ group: requiredBotGroupMutationResult(result, 'bot_group_deleted'), coordinator: context.objectId });
		},
	},
	{
		id: 'add-bot-group-members',
		method: 'POST',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/groups\/([^/]+)\/bots$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const world = await worldByHandle(context.env.BICKR_D1, worldHandle);
			const result = await requestOwnerWorldMutation(context, world.id, userId, {
				kind: 'bot_group_members_add',
				worldHandle,
				groupId: decodeURIComponent(context.match[3] ?? ''),
				input: parseAddBotGroupMembersInput(await readJsonBody(context.request)),
			});
			return ok({ group: requiredBotGroupMutationResult(result, 'bot_group_updated'), coordinator: context.objectId });
		},
	},
	{
		id: 'remove-bot-group-member',
		method: 'DELETE',
		pattern: /^\/users\/([^/]+)\/worlds\/([^/]+)\/groups\/([^/]+)\/bots\/([^/]+)$/,
		dispatch: 'user-coordinator',
		handler: async (context) => {
			const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
			const worldHandle = normalizeHandle(decodeURIComponent(context.match[2] ?? ''));
			const world = await worldByHandle(context.env.BICKR_D1, worldHandle);
			const result = await requestOwnerWorldMutation(context, world.id, userId, {
				kind: 'bot_group_member_remove',
				worldHandle,
				groupId: decodeURIComponent(context.match[3] ?? ''),
				botId: decodeURIComponent(context.match[4] ?? ''),
			});
			return ok({ group: requiredBotGroupMutationResult(result, 'bot_group_updated'), coordinator: context.objectId });
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
				const compatibilityFieldMask = input.inferenceSettings === undefined
					? null
					: legacyInferenceCompatibilityFieldMask(input.inferenceSettings);
				if (compatibilityFieldMask) {
					const current = await rawBotById(context.env.BICKR_KV, context.env.BICKR_D1, botId);
					await prepareLegacyInferenceCompatibilityWrite(context, userId, 'bot', botId, current.revision, compatibilityFieldMask);
				}
				const bot = await updateBot(context.env.BICKR_KV, context.env.BICKR_D1, botId, userId, input, updatedAt);
			if (compatibilityFieldMask) await resumePendingLegacyInferenceCompatibilityWrite(context, userId);
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
			const compatibilityFieldMask = settingsInput?.inferenceSettings === undefined
				? null
				: legacyInferenceCompatibilityFieldMask(settingsInput.inferenceSettings);
			let bot = await applyGeneratedAvatarForBot(
				context.env,
				userId,
				botId,
				parseAvatarCandidateValue(body.candidate),
				(targetBotId, avatar) => updateBotAvatar(
					context.env.BICKR_KV,
					context.env.BICKR_D1,
					targetBotId,
					userId,
					avatar,
				),
			);
				if (settingsInput?.inferenceSettings !== undefined && compatibilityFieldMask) {
					const current = await rawBotById(context.env.BICKR_KV, context.env.BICKR_D1, bot.id);
					await prepareLegacyInferenceCompatibilityWrite(context, userId, 'bot', bot.id, current.revision, compatibilityFieldMask);
					bot = await updateBot(context.env.BICKR_KV, context.env.BICKR_D1, bot.id, userId, {
					inferenceSettings: settingsInput.inferenceSettings,
				});
				await resumePendingLegacyInferenceCompatibilityWrite(context, userId);
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
			const compatibilityFieldMask = settingsInput?.imageGeneration === undefined
				? null
				: legacyImageCompatibilityFieldMask(settingsInput.imageGeneration);
			let world = await applyGeneratedAvatarForWorld(
				context.env,
				userId,
				worldHandle,
				parseAvatarCandidateValue(body.candidate),
				async (target, avatar) => requiredWorldMutationResult(await requestOwnerWorldMutation(context, target.id, userId, {
					kind: 'avatar_update',
					worldHandle: target.handle,
					avatar,
				})),
			);
				if (settingsInput?.imageGeneration !== undefined && compatibilityFieldMask) {
					const current = await readJson<WorldDocument>(context.env.BICKR_KV, kvKeys.world(targetWorld.id));
					if (!current) throw new RepositoryError('server_error', 'World compatibility source document is missing.', 500);
					await prepareLegacyInferenceCompatibilityWrite(context, userId, 'world', targetWorld.id, current.revision, compatibilityFieldMask);
					world = requiredWorldMutationResult(await requestOwnerWorldMutation(context, targetWorld.id, userId, {
					kind: 'world_update',
					worldHandle: world.handle,
					input: { imageGeneration: settingsInput.imageGeneration },
				}));
				await resumePendingLegacyInferenceCompatibilityWrite(context, userId);
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
			const operation = await reserveBotDelete(context, userId, botId);
			await runBotDeleteOperation(context, operation);
			const deleted = await readJson<BotDocument>(context.env.BICKR_KV, kvKeys.bot(botId));
			if (!deleted?.deletedAt) {
				throw new RepositoryError('server_error', 'Deleted participant document is missing.', 500);
			}
			const worldPostingSettings = (await worldPostingSettingsByIds(
				context.env.BICKR_D1, [deleted.homeWorldId],
			)).get(deleted.homeWorldId);
			return ok({
				bot: publicBotSummary(deleted, { includeToolSettings: true, nextDueAt: null, worldPostingSettings }),
				coordinator: context.objectId,
			});
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
			const operation = await reserveAccountDelete(context, userId);
			const result = await runAccountDeleteOperation(context, operation);
			return ok({
				...result,
				coordinator: context.objectId,
			}, { status: result.kind === 'account_delete_pending' ? 202 : 200 });
		},
	},
	{
		id: 'bot-runtime',
		method: '*',
		pattern: /^\/bots\/([^/]*)(?:\/.*)?$/,
		dispatch: 'bot-runtime',
	},
] as const satisfies readonly AgentRuntimeRoute[];

type LegacyInferenceCompatibilityWrite =
	| { kind: 'account'; entityId: string; revision: number; settings: BotInferenceSettings }
	| { kind: 'bot'; entityId: string; revision: number; settings: BotInferenceSettings }
	| { kind: 'world'; entityId: string; revision: number; settings: BotImageGenerationSettings | undefined };

async function projectLegacyInferenceCompatibilityWrite(
	context: AgentRuntimeRouteContext,
	ownerUserId: string,
	write: LegacyInferenceCompatibilityWrite,
	fieldMask: LegacyInferenceCompatibilityFieldMask,
): Promise<void> {
	if (context.coordinator.ownerUserId && context.coordinator.ownerUserId !== ownerUserId) {
		throw new RepositoryError('forbidden', 'Compatibility write was dispatched to the wrong coordinator.', 403);
	}
	const version = await inferenceGraphReadVersion(context.env.BICKR_D1, ownerUserId);
	if (version.writerVersion !== 1) return;
	const now = new Date().toISOString();
	await markInferenceGraphCompatibilitySourceWritten(context.env.BICKR_D1, ownerUserId, write.revision, now);
	if (fieldMask.fields.length > 0 || fieldMask.credential) {
		const configurationId = write.kind === 'account'
			? await accountDefaultConfigurationId(ownerUserId)
			: write.kind === 'bot'
				? await botConfigurationId(write.entityId)
				: await worldConfigurationId(write.entityId);
		const selected = (await loadInferenceConfigurationPath(context.env.BICKR_D1, ownerUserId, configurationId))[0];
		// One bounded lookup answers both linked-clone barriers below: the local
		// model made the whole local bundle live, so neither the base URL nor the
		// credential may fall back through the source bot. A model transition
		// carries that intent for the credential too, so the same write that moves
		// the base URL barrier moves the credential with it.
		const linkedClone = write.kind === 'bot' && await isLinkedCloneBot(context.env.BICKR_D1, write.entityId);
		const credential = write.kind !== 'world'
			&& (fieldMask.credential || legacyModelCouplesLinkedCloneProvider(fieldMask, { linkedClone }))
			? legacyCompatibilityCredentialUpdate(write, linkedClone)
			: undefined;
		await updateInferenceConfiguration(context.env.BICKR_D1, ownerUserId, {
			configurationId,
			expectedRevision: selected.revision,
			overrides: write.kind === 'world'
				? inferenceOverridePatchFromLegacyImageSettingsMask(write.settings, fieldMask)
				: write.kind === 'bot'
					? inferenceOverridePatchFromLegacyBotSettingsMask(write.settings, fieldMask, { linkedClone })
					: inferenceOverridePatchFromLegacySettingsMask(write.settings, fieldMask),
			...(credential ? { credential } : {}),
		}, now);
	}
	if (write.kind === 'account') {
		await projectLegacyTranslationCompatibilityWrite(context, ownerUserId, write.settings, fieldMask);
	}
	await completeInferenceGraphCompatibilityWrite(context.env.BICKR_D1, ownerUserId, now);
}

async function isLinkedCloneBot(db: Env['BICKR_D1'], botId: string): Promise<boolean> {
	const row = await db.prepare(
		`SELECT linked FROM bot_clone_sources WHERE bot_id = ? LIMIT 1`,
	).bind(botId).first<{ linked: number }>();
	return row?.linked === 1;
}

/** Mirrors the migration's credential decision, dormancy check included. */
function legacyCompatibilityCredentialUpdate(
	write: Extract<LegacyInferenceCompatibilityWrite, { kind: 'account' | 'bot' }>,
	linkedClone: boolean,
): CredentialUpdate {
	const model = write.settings.model?.trim();
	// A clone that just went dormant reads its source's whole bundle again, so a
	// retained local key is as much a source bypass as the Account-default jump.
	if (linkedClone && !model) return { mode: 'inherit' };
	const secret = write.settings.openRouterApiKey?.trim();
	if (secret) return { mode: 'value', secret };
	return linkedClone && model ? { mode: 'account_default' } : { mode: 'inherit' };
}

async function prepareLegacyInferenceCompatibilityWrite(
	context: AgentRuntimeRouteContext,
	ownerUserId: string,
	kind: LegacyInferenceCompatibilityWrite['kind'],
	entityId: string,
	currentRevision: number,
	fieldMask: LegacyInferenceCompatibilityFieldMask,
): Promise<void> {
	if (context.coordinator.ownerUserId && context.coordinator.ownerUserId !== ownerUserId) {
		throw new RepositoryError('forbidden', 'Compatibility write was dispatched to the wrong coordinator.', 403);
	}
	await resumePendingLegacyInferenceCompatibilityWrite(context, ownerUserId);
	if (legacyInferenceCompatibilityFieldMaskIsEmpty(fieldMask)) return;
	await beginInferenceGraphCompatibilityWrite(context.env.BICKR_D1, {
		ownerUserId,
		kind,
		entityId,
		sourceRevision: currentRevision + 1,
		fieldMask,
		now: new Date().toISOString(),
	});
}

/**
 * After graph cutover, KV retains only the profile-owned prompt and a best-effort
 * enable mirror. Explicit nulls remove any legacy provider bundle that the
 * repository's nested patch merge would otherwise preserve.
 */
function canonicalTranslationMirrorPatch(
	enabled: boolean,
	patch: BotTranslationSettingsInput | null,
): BotTranslationSettingsInput {
	return {
		enabled,
		model: null,
		reasoningEffort: null,
		toolCalls: null,
		providerRouting: null,
		temperature: null,
		topK: null,
		topP: null,
		minP: null,
		frequencyPenalty: null,
		presencePenalty: null,
		repetitionPenalty: null,
		...(patch === null
			? { prompt: null }
			: patch.prompt !== undefined
				? { prompt: patch.prompt }
				: {}),
	};
}

async function resumePendingLegacyInferenceCompatibilityWrite(
	context: AgentRuntimeRouteContext,
	ownerUserId: string,
): Promise<void> {
	const pending = await pendingInferenceGraphCompatibilityWrite(context.env.BICKR_D1, ownerUserId);
	if (!pending) return;
	let write: LegacyInferenceCompatibilityWrite;
	switch (pending.kind) {
		case 'account': {
			const user = await userById(context.env.BICKR_KV, pending.entityId);
			if (user.id !== ownerUserId) throw new RepositoryError('conflict', 'Account convergence owner does not match.', 409);
			if (user.revision < pending.sourceRevision) {
				return;
			}
			write = { kind: 'account', entityId: user.id, revision: user.revision, settings: user.inferenceSettings ?? {} };
			break;
		}
		case 'bot': {
			const bot = await rawBotById(context.env.BICKR_KV, context.env.BICKR_D1, pending.entityId);
			if (bot.ownerUserId !== ownerUserId) throw new RepositoryError('conflict', 'Participant convergence owner does not match.', 409);
			if (bot.revision < pending.sourceRevision) {
				return;
			}
			write = { kind: 'bot', entityId: bot.id, revision: bot.revision, settings: bot.inferenceSettings };
			break;
		}
		case 'world': {
			const world = await readJson<WorldDocument>(context.env.BICKR_KV, kvKeys.world(pending.entityId));
			if (!world || world.createdByUserId !== ownerUserId) throw new RepositoryError('conflict', 'World convergence owner does not match.', 409);
			if (world.revision < pending.sourceRevision) {
				return;
			}
			write = { kind: 'world', entityId: world.id, revision: world.revision, settings: world.imageGeneration };
			break;
		}
	}
	await projectLegacyInferenceCompatibilityWrite(context, ownerUserId, write, pending.fieldMask);
}

async function projectLegacyTranslationCompatibilityWrite(
	context: AgentRuntimeRouteContext,
	ownerUserId: string,
	settings: BotInferenceSettings,
	fieldMask: LegacyInferenceCompatibilityFieldMask,
): Promise<void> {
	if (fieldMask.translationFields.length === 0) return;
	const version = await inferenceGraphReadVersion(context.env.BICKR_D1, ownerUserId);
	// Once cut over, the selected Account default/custom configuration is
	// canonical. Legacy profile prompt/toggle writes must not replace it merely
	// because their deprecated inference subobject is absent or stale.
	if (version.cutoverVersion !== 0) return;
	const selection = await readTranslationInferencePointer(context.env.BICKR_D1, ownerUserId);
	const translation = settings.translation;
	const rootId = await accountDefaultConfigurationId(ownerUserId);
	if (!translation?.model?.trim()) {
		if (selection.configurationId !== rootId) {
			await updateLegacyTranslationPointer(context.env.BICKR_D1, ownerUserId, {
				configurationId: rootId,
				expectedRevision: selection.revision,
			});
		}
		return;
	}
	const overrides = inferenceOverridesFromLegacyTranslationSettings(translation);
	const compatibility = await ensureCompatibilityTranslation(
		context.env.BICKR_D1,
		ownerUserId,
		overrides,
	);
	const configurationId = compatibility.id;
	if (JSON.stringify(compatibility.overrides) !== JSON.stringify(overrides)) {
		await updateInferenceConfiguration(context.env.BICKR_D1, ownerUserId, {
			configurationId,
			expectedRevision: compatibility.revision,
			overrides: inferenceOverridePatchFromLegacyTranslationSettingsMask(translation, fieldMask),
		});
	}
	if (selection.configurationId !== configurationId) {
		await updateLegacyTranslationPointer(context.env.BICKR_D1, ownerUserId, {
			configurationId,
			expectedRevision: selection.revision,
		});
	}
}

async function requireInferenceGraphOwner(context: AgentRuntimeRouteContext): Promise<string> {
	const userId = requireUserMatch(context.request, decodeURIComponent(context.match[1] ?? ''));
	if (context.coordinator.ownerUserId !== userId) {
		throw new RepositoryError('forbidden', 'Inference configuration request was dispatched to the wrong coordinator.', 403);
	}
	const version = await inferenceGraphReadVersion(context.env.BICKR_D1, userId);
	if (version.cutoverVersion !== 1) {
		throw new RepositoryError('conflict', 'Inference configuration graph is not available for this account.', 409);
	}
	return userId;
}

function parseCanonicalInferenceAnnotationRequest(value: unknown): CanonicalInferenceAnnotationRequest {
	const record = requiredRecord(value);
	const allowed = new Set(['accountDefault', 'translation', 'botIds', 'worldIds']);
	const unexpected = Object.keys(record).find((key) => !allowed.has(key));
	if (unexpected) throw new InputError(`Unsupported inference consumer annotation field: ${unexpected}.`);
	const stringArray = (candidate: unknown, field: string): string[] | undefined => {
		if (candidate === undefined) return undefined;
		if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== 'string' || !entry.trim())) {
			throw new InputError(`${field} must be an array of non-empty strings.`);
		}
		return [...new Set(candidate)];
	};
	if (record.accountDefault !== undefined && typeof record.accountDefault !== 'boolean') {
		throw new InputError('accountDefault must be boolean.');
	}
	if (record.translation !== undefined && typeof record.translation !== 'boolean') {
		throw new InputError('translation must be boolean.');
	}
	const request: CanonicalInferenceAnnotationRequest = {
		...(record.accountDefault === true ? { accountDefault: true } : {}),
		...(record.translation === true ? { translation: true } : {}),
		...(stringArray(record.botIds, 'botIds') ? { botIds: stringArray(record.botIds, 'botIds') } : {}),
		...(stringArray(record.worldIds, 'worldIds') ? { worldIds: stringArray(record.worldIds, 'worldIds') } : {}),
	};
	const count = (request.accountDefault ? 1 : 0) + (request.translation ? 1 : 0)
		+ (request.botIds?.length ?? 0) + (request.worldIds?.length ?? 0);
	if (count > maximumCanonicalInferenceAnnotationBatch) {
		throw new InputError(`At most ${maximumCanonicalInferenceAnnotationBatch} fixed inference consumers may be requested.`);
	}
	return request;
}

async function canonicalInferenceAnnotations(
	context: AgentRuntimeRouteContext,
	userId: string,
	request: CanonicalInferenceAnnotationRequest,
): Promise<{ annotations: CanonicalInferenceAnnotation[]; graphRevision: number }> {
	const references: CanonicalInferenceFixedReference[] = [
		...(request.accountDefault ? [{ kind: 'account_default' } as const] : []),
		...(request.translation ? [{ kind: 'translation' } as const] : []),
		...(request.worldIds ?? []).map((worldId) => ({ kind: 'world' as const, worldId })),
		...(request.botIds ?? []).map((botId) => ({ kind: 'bot' as const, botId })),
	];
	const version = await inferenceGraphReadVersion(context.env.BICKR_D1, userId);
	if (version.cutoverVersion === 0) {
		const owner = await userById(context.env.BICKR_KV, userId);
		const environment = providerEnvironmentSettingsFromBindings(context.env);
		const accountModel = resolveBotProviderSettings({ inferenceSettings: {} }, owner, environment).settings.model;
		const legacy = await legacyInferenceConsumerCandidates(context, userId, request.botIds ?? [], request.worldIds ?? []);
		const annotations: CanonicalInferenceAnnotation[] = [];
		for (const reference of references) {
			let effectiveModel: string | undefined;
			switch (reference.kind) {
				case 'account_default':
					effectiveModel = accountModel;
					break;
				case 'translation':
					effectiveModel = resolveLegacyTranslationProviderSettings(owner, environment)?.model;
					break;
				case 'world':
					effectiveModel = legacy.worldIds.has(reference.worldId) ? accountModel : undefined;
					break;
				case 'bot': {
					const inferenceSettings = legacy.botInferenceSettings.get(reference.botId);
					effectiveModel = inferenceSettings
						? resolveBotProviderSettings({ inferenceSettings }, owner, environment).settings.model
						: undefined;
					break;
				}
			}
			if (effectiveModel) {
				annotations.push({ kind: 'legacy_compatibility', reference, effectiveModel, reason: 'graph_not_migrated' });
			}
		}
		return { annotations, graphRevision: version.graphRevision };
	}
	let translationConfigurationId: string | null | undefined;
	if (request.translation) {
		const state = await translationInferenceState(context.env.BICKR_D1, userId);
		if (state.kind === 'canonical') {
			translationConfigurationId = state.enabled ? state.role.id : null;
		} else {
			const legacyEnabled = Boolean((await userById(context.env.BICKR_KV, userId)).inferenceSettings?.translation?.enabled);
			translationConfigurationId = legacyEnabled ? state.role?.id ?? state.selection.configurationId : null;
		}
	}
	const referenceConfigurationIds = await Promise.all(references.map(async (reference) => {
		switch (reference.kind) {
			case 'account_default': return accountDefaultConfigurationId(userId);
			case 'translation': return translationConfigurationId ?? null;
			case 'world': return worldConfigurationId(reference.worldId);
			case 'bot': return botConfigurationId(reference.botId);
		}
	}));
	const referencesByConfigurationId = new Map<string, CanonicalInferenceFixedReference[]>();
	for (const [index, configurationId] of referenceConfigurationIds.entries()) {
		if (!configurationId) continue;
		const selected = referencesByConfigurationId.get(configurationId) ?? [];
		selected.push(references[index]!);
		referencesByConfigurationId.set(configurationId, selected);
	}
	const defaults = await bickrInferenceDefaultsFromEnvironment(context.env);
	const summaries = await listOwnedFixedInferenceConfigurationSummaries(
		context.env.BICKR_D1, userId, references, defaults, version, translationConfigurationId,
	);
	const resolved = await canonicalInferenceConsumerBatch(
		context.env.BICKR_D1,
		userId,
		summaries.map((configuration) => ({
			configurationId: configuration.id,
			consumer: referencesByConfigurationId.get(configuration.id)?.some((reference) => reference.kind === 'translation')
				? 'translation'
				: configuration.kind === 'account_default' ? 'account' : configuration.kind === 'custom' ? 'bot' : configuration.kind,
		})),
		context.env,
		version,
	);
	const annotations = summaries.flatMap((configuration): CanonicalInferenceAnnotation[] => {
		const consumer = resolved.get(configuration.id);
		if (!consumer) return [];
		const credential = consumer.resolution.effective.credential;
		configuration = {
			...configuration,
			effectiveModel: consumer.resolution.effective.model,
			credentialAvailability: credential.kind === 'available'
				? { kind: 'available', source: credential.source }
				: credential.kind === 'explicit_none'
					? { kind: 'explicit_none', source: credential.source }
					: { kind: 'unavailable', source: credential.source, reason: credential.reason },
		};
		return (referencesByConfigurationId.get(configuration.id) ?? []).map((reference) => ({
			kind: 'canonical' as const,
			reference,
			configuration,
		}));
	});
	return { annotations, graphRevision: version.graphRevision };
}

type LegacyInferenceConsumerRow = {
	kind: 'world' | 'bot';
	requestedId: string;
	entityId: string;
	sourceBotId: string | null;
	linked: number | null;
	depth: number;
};

async function legacyInferenceConsumerCandidates(
	context: AgentRuntimeRouteContext,
	ownerUserId: string,
	botIds: readonly string[],
	worldIds: readonly string[],
): Promise<{ worldIds: ReadonlySet<string>; botInferenceSettings: ReadonlyMap<string, BotInferenceSettings> }> {
	const result = await context.env.BICKR_D1.prepare(
		`WITH RECURSIVE requested_bots(id) AS (SELECT value FROM json_each(?)),
		requested_worlds(id) AS (SELECT value FROM json_each(?)),
		owned_bots(id) AS (
			SELECT bots.bot_id FROM bots_index AS bots JOIN requested_bots ON requested_bots.id = bots.bot_id
			WHERE bots.owner_user_id = ? AND bots.deleted_at IS NULL AND bots.lifecycle_state = 'active'
		), clone_chain(requestedId, entityId, sourceBotId, linked, depth) AS (
			SELECT owned.id, owned.id, source.source_bot_id, COALESCE(source.linked, 0), 0
			FROM owned_bots AS owned LEFT JOIN bot_clone_sources AS source ON source.bot_id = owned.id
			UNION ALL
			SELECT chain.requestedId, source_bot.bot_id, source.source_bot_id, COALESCE(source.linked, 0), chain.depth + 1
			FROM clone_chain AS chain
			JOIN bots_index AS source_bot ON source_bot.bot_id = chain.sourceBotId
				AND source_bot.deleted_at IS NULL AND source_bot.lifecycle_state = 'active'
			LEFT JOIN bot_clone_sources AS source ON source.bot_id = source_bot.bot_id
			WHERE chain.linked = 1 AND chain.depth < 17
		)
		SELECT 'world' AS kind, worlds.world_id AS requestedId, worlds.world_id AS entityId,
			NULL AS sourceBotId, NULL AS linked, 0 AS depth
		FROM worlds_index AS worlds JOIN requested_worlds ON requested_worlds.id = worlds.world_id
		WHERE worlds.created_by_user_id = ? AND worlds.deleted_at IS NULL AND worlds.lifecycle_state = 'active'
		UNION ALL
		SELECT 'bot' AS kind, requestedId, entityId, sourceBotId, linked, depth FROM clone_chain
		ORDER BY kind, requestedId, depth`,
	).bind(JSON.stringify(botIds), JSON.stringify(worldIds), ownerUserId, ownerUserId).all<LegacyInferenceConsumerRow>();
	const rows = result.results ?? [];
	const worldSet = new Set(rows.filter((row) => row.kind === 'world').map((row) => row.requestedId));
	const botRows = rows.filter((row) => row.kind === 'bot');
	const entityIds = [...new Set(botRows.map((row) => row.entityId))];
	const documents = await Promise.all(entityIds.map(async (id) => [id, await readJson<BotDocument>(
		context.env.BICKR_KV, kvKeys.bot(id),
	)] as const));
	const byId = new Map(documents.flatMap(([id, bot]) => bot && !bot.deletedAt ? [[id, normalizeBotDefaults(bot)] as const] : []));
	const settings = new Map<string, BotInferenceSettings>();
	for (const requestedId of new Set(botRows.map((row) => row.requestedId))) {
		const chain = botRows.filter((row) => row.requestedId === requestedId);
		if (chain.some((row) => row.depth > 16)) {
			throw new RepositoryError('conflict', 'Clone source chain is too deep.', 409);
		}
		let effective: BotInferenceSettings | undefined;
		for (const row of [...chain].reverse()) {
			const bot = byId.get(row.entityId);
			if (!bot) { effective = undefined; break; }
			const local = bot.inferenceSettings;
			effective = row.linked === 1 && !local.model?.trim() && effective ? effective : local;
		}
		if (effective) settings.set(requestedId, effective);
	}
	return { worldIds: worldSet, botInferenceSettings: settings };
}

function requiredRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('A JSON object is required.');
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new InputError(`${field} is required.`);
	return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
	const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
	if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
		throw new InputError(`${field} must be a positive integer.`);
	}
	return parsed;
}

function pageInput(url: URL): { cursor?: string; limit?: number } {
	const cursor = url.searchParams.get('cursor');
	const limit = url.searchParams.get('limit');
	return {
		...(cursor ? { cursor } : {}),
		...(limit ? { limit: requiredPositiveInteger(limit, 'limit') } : {}),
	};
}

/** Shared public parameters for every bounded inference listing surface. */
export function inferenceListingInput(url: URL): { cursor?: string; limit?: number; query?: string } {
	const query = url.searchParams.get('q');
	return { ...pageInput(url), ...(query ? { query } : {}) };
}

/**
 * Section and kind are mutually exclusive selections over the same library.
 * Both are validated here so an unknown value is a typed 400 rather than an
 * empty page that looks like an empty library.
 */
export function inferenceLibrarySelection(
	url: URL,
): { kind: 'section'; section: InferenceLibrarySection } | { kind: 'kinds'; kinds: InferenceConfigurationKind[] } | { kind: 'all' } {
	const section = url.searchParams.get('section');
	const kinds = url.searchParams.get('kind');
	if (section && kinds) throw new InputError('Only one of section or kind may be requested.');
	if (section) return { kind: 'section', section: parseInferenceLibrarySection(section) };
	if (kinds) return { kind: 'kinds', kinds: parseInferenceConfigurationKinds(kinds) };
	return { kind: 'all' };
}

function parseCredentialUpdate(value: unknown): CredentialUpdate {
	const record = requiredRecord(value);
	switch (record.mode) {
		case 'inherit':
		case 'account_default':
		case 'none':
			return { mode: record.mode };
		case 'value':
			return { mode: 'value', secret: requiredString(record.secret, 'credential.secret') };
		default:
			throw new InputError('credential.mode must be inherit, account_default, value, or none.');
	}
}

function parseInferenceOverridesForRoute(value: unknown) {
	try {
		return parseInferenceConfigurationOverrides(value);
	} catch (error) {
		if (error instanceof InferenceConfigurationDataError) throw new InputError(error.message);
		throw error;
	}
}

function parseInferencePatchForRoute(value: unknown) {
	try {
		return parseInferenceConfigurationOverridePatch(value);
	} catch (error) {
		if (error instanceof InferenceConfigurationDataError) throw new InputError(error.message);
		throw error;
	}
}

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

// Lifecycle orchestration and persisted-request parsing live in focused subsystem modules.

type AvatarStorageTarget =
	| { kind: 'user'; userId: string }
	| { kind: 'bot'; botId: string; worldId: string }
	| { kind: 'world'; worldId: string };

async function storedAvatarFromRequest(
	context: AgentRuntimeRouteContext,
	target: AvatarStorageTarget,
): Promise<AvatarImage> {
	const now = new Date().toISOString();
	const upload = await avatarUploadBytes(context.request);
	return storeAvatarImage(requireAvatarBucket(context.env), {
		...(target.kind === 'user' ? { target: 'user' as const, userId: target.userId }
			: target.kind === 'world' ? { target: 'world' as const, worldId: target.worldId }
			: { botId: target.botId, worldId: target.worldId }),
		bytes: upload.bytes,
		contentType: upload.contentType,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(context.env.BICKR_R2_PUBLIC_BASE_URL),
		source: upload.kind === 'file'
			? { type: 'upload', uploadedAt: now, ...(upload.originalFilename ? { originalFilename: upload.originalFilename } : {}) }
			: { type: 'remote_url', sourceUrl: upload.sourceUrl, importedAt: now },
		now,
	});
}

type AvatarUploadBytes =
	| { kind: 'file'; bytes: Uint8Array; contentType: AvatarContentType; originalFilename?: string }
	| { kind: 'url'; bytes: Uint8Array; contentType: AvatarContentType; sourceUrl: string };

async function avatarUploadBytes(request: Request): Promise<AvatarUploadBytes> {
	const contentType = request.headers.get('content-type') ?? '';
	if (contentType.toLowerCase().includes('multipart/form-data')) {
		const file = (await request.formData()).get('file');
		if (!(file instanceof File)) throw new InputError('Avatar upload must include a file.');
		const validated = await validateAvatarFile(file);
		return {
			kind: 'file',
			bytes: validated.bytes,
			contentType: validated.contentType,
			...(file.name ? { originalFilename: file.name } : {}),
		};
	}
	const body = runtimeRecord(await readJsonBody(request));
	const sourceUrl = requiredText(body.url, 'Avatar URL', 1_000);
	const validated = await fetchRemoteAvatarBytes(sourceUrl);
	return { kind: 'url', bytes: validated.bytes, contentType: validated.contentType, sourceUrl };
}

async function croppedAvatarFromRequest(
	request: Request,
	current: AvatarImage | undefined,
	missingMessage: string,
): Promise<AvatarImage> {
	if (!current) throw new InputError(missingMessage);
	const body = runtimeRecord(await readJsonBody(request));
	if (!('crop' in body)) throw new InputError('Avatar crop is required.');
	const now = new Date().toISOString();
	if (body.crop === null) {
		const { crop: _crop, ...avatar } = current;
		return { ...avatar, updatedAt: now };
	}
	return { ...current, crop: parseAvatarCrop(body.crop, current), updatedAt: now };
}

function parseAvatarCrop(value: unknown, avatar: AvatarImage): AvatarCrop {
	const record = runtimeRecord(value);
	const crop = {
		x: record.x,
		y: record.y,
		size: record.size,
		imageWidth: record.imageWidth,
		imageHeight: record.imageHeight,
	};
	if (!Object.values(crop).every((part) => Number.isInteger(part))) {
		throw new InputError('Avatar crop must use integer pixel coordinates.');
	}
	const parsed = crop as AvatarCrop;
	const max = 100_000;
	if (parsed.imageWidth <= 0 || parsed.imageHeight <= 0 || parsed.imageWidth > max || parsed.imageHeight > max) {
		throw new InputError('Avatar crop image dimensions are invalid.');
	}
	if (parsed.x < 0 || parsed.y < 0 || parsed.size <= 0 || parsed.size > max || parsed.x + parsed.size > parsed.imageWidth || parsed.y + parsed.size > parsed.imageHeight) {
		throw new InputError('Avatar crop square must be inside the image.');
	}
	if (avatar.width !== undefined && avatar.height !== undefined && Number.isInteger(avatar.width) && Number.isInteger(avatar.height) && (Math.round(avatar.width) !== parsed.imageWidth || Math.round(avatar.height) !== parsed.imageHeight)) {
		throw new InputError('Avatar crop dimensions do not match the current avatar.');
	}
	return parsed;
}

/**
 * The scheduler-authenticated inference graph operations are the maintenance
 * work itself: every one of them requires maintenance mode inside its own
 * handler, behind internal-service and scheduler auth. The agent Worker entry
 * and the coordinator entry share this single classification so neither gate
 * can reject a request the other is built to accept.
 */
function isInferenceGraphMaintenanceRequest(request: Request): boolean {
	if (request.method !== 'POST') {
		return false;
	}
	const pathname = new URL(request.url).pathname;
	return /^\/users\/[^/]+\/inference-graph\/(?:migrate|rollback|reactivate)$/.test(pathname) ||
		/^\/users\/[^/]+\/inference-translation-role\/migrate$/.test(pathname) ||
		/^\/inference-graph\/(?:cleanup|activate-lifecycle)$/.test(pathname);
}

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
	// Let the maintenance operations reach their own stricter gate while ordinary
	// mutations keep the shared maintenance rejection behavior.
	const maintenanceResponse = isInferenceGraphMaintenanceRequest(request)
		? null
		: await mutationMaintenanceResponse(request, env.BICKR_D1, { allowRuntimeStop: true });
	if (maintenanceResponse) {
		return maintenanceResponse;
	}
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
		if (coordinator.ownerUserId) {
			await resumeDueUserLifecycleOperation({ env, coordinator }, new Date().toISOString());
		}
		await runPendingUserBotsConvergenceTask(env, coordinator);
		const pending = await coordinator.storage?.get(userBotsConvergenceTaskStorageKey);
		const lifecycleAlarmAt = coordinator.ownerUserId
			? await nextLifecycleAlarmAt(env.BICKR_D1, coordinator.ownerUserId)
			: null;
		if (pending || lifecycleAlarmAt) {
			const lifecycleAlarmMs = lifecycleAlarmAt ? Date.parse(lifecycleAlarmAt) : Number.POSITIVE_INFINITY;
			await coordinator.storage?.setAlarm(Math.max(Date.now() + 1, Math.min(
				Date.now() + userBotsConvergenceAlarmDelayMs,
				lifecycleAlarmMs,
			)));
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

export async function handleAgentRuntimeWorkerRequest(request: Request, env: Env): Promise<Response> {
	try {
		const url = new URL(request.url);
		if (!isTrustedInternalServiceRequest(request, env.INTERNAL_SERVICE_SECRET)) {
			return agentRuntimeNotFoundResponse();
		}
		// The same exemption the coordinator entry applies: without it the Worker
		// edge would reject the maintenance operations before they can be routed
		// to the handlers that require maintenance mode.
		const maintenanceResponse = isInferenceGraphMaintenanceRequest(request)
			? null
			: await mutationMaintenanceResponse(request, env.BICKR_D1, { allowRuntimeStop: true });
		if (maintenanceResponse) {
			return maintenanceResponse;
		}

		const resolved = resolveAgentRuntimeRoute(url.pathname, request.method);
		if (!resolved) {
			return agentRuntimeNotFoundResponse();
		}
		if (resolved.route.dispatch === 'direct') {
			return await handleAgentRuntimeRequest(request, env);
		}
		if (resolved.route.dispatch === 'account-bootstrap') {
			const body = await readJsonBody(request.clone());
			const profile = providerProfileFromUnknown(body);
			const reservation = await reserveOrJoinAccountBootstrap(env.BICKR_D1, {
				candidateUserId: makeId('usr'),
				idempotencyKey: lifecycleIdempotencyKey(request),
				profile,
				now: new Date().toISOString(),
			});
			const forwardedUrl = internalServiceUrl(`/users/${encodeURIComponent(reservation.userId)}/account/bootstrap`);
			const headers = new Headers(request.headers);
			headers.delete(accountBootstrapOperationHeader);
			if (reservation.kind === 'pending') {
				headers.set(accountBootstrapOperationHeader, reservation.operation.operationId);
				headers.set('idempotency-key', reservation.operation.idempotencyKey);
			}
			headers.set('content-type', 'application/json');
			const objectId = env.USER_BOTS.idFromName(reservation.userId);
			return await env.USER_BOTS.get(objectId).fetch(new Request(forwardedUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify(reservation.profile),
			}));
		}
		if (resolved.route.dispatch === 'user-coordinator') {
			const userId = decodeURIComponent(resolved.match[1] ?? '');
			const objectId = env.USER_BOTS.idFromName(userId);
			return await env.USER_BOTS.get(objectId).fetch(request);
		}
		const botId = resolved.match[1] ?? 'unknown';
		const objectId = env.BOT_RUNTIME.idFromName(botId);
		return await env.BOT_RUNTIME.get(objectId).fetch(request);
	} catch (error) {
		return errorResponse(error);
	}
}

export default {
	async fetch(request, env) {
		return handleAgentRuntimeWorkerRequest(request, env);
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(runScheduledAgentRuntimeTasks(env, event.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

async function runScheduledAgentRuntimeTasks(env: Env, scheduledTime: number): Promise<void> {
	const maintenance = await readMaintenanceState(env.BICKR_D1);
	if (maintenance.enabled) {
		console.log(JSON.stringify({ event: 'scheduled_tasks_deferred', reason: 'maintenance', scheduledTime }));
		return;
	}
	await Promise.all([
		dispatchDueBots(env, scheduledTime),
		recoverDueLifecycleOwners(env, scheduledTime).catch((error) => {
			console.warn('lifecycle recovery dispatch failed', error);
		}),
		cleanupTerminalLifecycleOperations(env.BICKR_D1, new Date(scheduledTime).toISOString(), 100).catch((error) => {
			console.warn('terminal lifecycle cleanup failed', error);
		}),
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
	if ((await readMaintenanceState(env.BICKR_D1)).enabled) {
		return { dispatched: 0, budgetExhausted: false };
	}
	const now = new Date(scheduledTime).toISOString();
	const batchSize = Math.max(1, Math.floor(options.batchSize ?? scheduledDispatchSelectLimit));
	const maxDispatches = Math.max(0, Math.floor(options.maxDispatches ?? scheduledDispatchBudget));
	let dispatched = 0;
	while (dispatched < maxDispatches) {
		const limit = Math.min(batchSize, maxDispatches - dispatched);
		const result = await env.BICKR_D1.prepare(
			`SELECT runtime.bot_id AS botId
			 FROM bot_runtime_index runtime
			 JOIN bots_index bots
			   ON bots.bot_id = runtime.bot_id
			  AND bots.deleted_at IS NULL
			  AND bots.lifecycle_state = 'active'
			 WHERE runtime.enabled = 1
			   AND runtime.next_due_at IS NOT NULL
			   AND runtime.next_due_at <= ?
			   AND (runtime.lease_expires_at IS NULL OR runtime.lease_expires_at <= ?)
			 ORDER BY runtime.next_due_at ASC
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
