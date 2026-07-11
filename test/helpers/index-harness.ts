import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { onRequestGet as bootstrap } from "../../apps/web/functions/api/bootstrap";
import { onRequest as pageShell } from "../../apps/web/functions/[[path]]";
import { onRequestGet as commentRefResolver } from "../../apps/web/functions/c/[commentRef]";
import { onRequestGet as threadRefResolver } from "../../apps/web/functions/t/[threadRef]";
import { onRequestGet as githubStart } from "../../apps/web/functions/api/auth/github/start";
import { onRequestGet as githubCallback } from "../../apps/web/functions/api/auth/github/callback";
import { onRequestGet as googleStart } from "../../apps/web/functions/api/auth/google/start";
import { onRequestGet as googleCallback } from "../../apps/web/functions/api/auth/google/callback";
import { onRequestPost as logout } from "../../apps/web/functions/api/auth/logout";
import { onRequestPost as testLogin } from "../../apps/web/functions/api/__test__/login";
import { onRequestPost as testServiceProxy } from "../../apps/web/functions/api/__test__/service-proxy";
import { onRequestGet as health } from "../../apps/web/functions/api/health";
import { onRequestGet as searchRoute } from "../../apps/web/functions/api/search";
import { onRequestGet as searchSuggestRoute } from "../../apps/web/functions/api/search/suggest";
import { onRequestGet as meBots } from "../../apps/web/functions/api/me/bots";
import { onRequestPost as spreadBotTicksRoute } from "../../apps/web/functions/api/me/bots/spread-ticks";
import {
	onRequestDelete as deleteBot,
	onRequestPatch as patchBot,
} from "../../apps/web/functions/api/me/bots/[botId]";
import {
	onRequestDelete as deleteBotAvatarRoute,
	onRequestPut as uploadBotAvatar,
} from "../../apps/web/functions/api/me/bots/[botId]/avatar/index";
import { onRequestPatch as updateBotAvatarCrop } from "../../apps/web/functions/api/me/bots/[botId]/avatar/crop";
import { onRequestPost as unlinkBotCloneRoute } from "../../apps/web/functions/api/me/bots/[botId]/clone/unlink";
import { onRequestPost as relinkBotCloneRoute } from "../../apps/web/functions/api/me/bots/[botId]/clone/relink";
import {
	onRequestGet as contextBudgetGetRoute,
	onRequestPost as contextBudgetRoute,
} from "../../apps/web/functions/api/me/bots/[botId]/runtime/context-budget";
import { onRequestGet as openRouterImageModelsRoute } from "../../apps/web/functions/api/openrouter/image-models";
import { onRequestGet as runtimeMessagesRoute } from "../../apps/web/functions/api/me/bots/[botId]/runtime/messages";
import { onRequest as runtimeMonitorRoute } from "../../apps/web/functions/api/me/bots/[botId]/runtime/monitor";
import {
	onRequestDelete as deleteProfileRoute,
	onRequestGet as getProfile,
	onRequestPatch as patchProfile,
} from "../../apps/web/functions/api/me/profile";
import {
	onRequestDelete as deleteUserAvatarRoute,
	onRequestPut as uploadUserAvatarRoute,
} from "../../apps/web/functions/api/me/avatar/index";
import { onRequestPatch as updateUserAvatarCropRoute } from "../../apps/web/functions/api/me/avatar/crop";
import { onRequestPost as applyUserAvatarRoute } from "../../apps/web/functions/api/me/avatar/apply";
import { onRequestPost as generateUserAvatarRoute } from "../../apps/web/functions/api/me/avatar/generate";
import { onRequestPost as promptUserAvatarRoute } from "../../apps/web/functions/api/me/avatar/prompt";
import { onRequestGet as getHumanProfile } from "../../apps/web/functions/api/humans/[humanHandle]";
import { onRequestGet as getNotificationsRoute } from "../../apps/web/functions/api/me/notifications";
import { onRequestPost as markAllNotificationsReadRoute } from "../../apps/web/functions/api/me/notifications/read-all";
import {
	onRequestGet as getSubscriptionsRoute,
	onRequestPatch as patchSubscriptionsRoute,
} from "../../apps/web/functions/api/me/subscriptions";
import { onRequestPost as translateText } from "../../apps/web/functions/api/me/translate";
import { onRequestDelete as unlinkAuthIdentity } from "../../apps/web/functions/api/me/auth/identities/[provider]";
import { onRequestGet as runtimeHealth } from "../../apps/web/functions/api/runtime/health";
import { serviceRequest as buildServiceRequest } from "../../apps/web/functions/api/_proxy";
import { onRequestGet as session } from "../../apps/web/functions/api/session";
import {
	onRequestGet as forums,
	onRequestPost as createForum,
} from "../../apps/web/functions/api/worlds/[worldHandle]/forums";
import {
	onRequestDelete as deleteForumRoute,
	onRequestPatch as patchForum,
} from "../../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]";
import { onRequestGet as forumThreads } from "../../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads";
import {
	onRequestDelete as deleteThreadRoute,
	onRequestGet as threadDetail,
} from "../../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads/[threadId]";
import { onRequestDelete as deleteCommentRoute } from "../../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads/[threadId]/comments/[commentId]";
import { onRequestGet as commentVotes } from "../../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads/[threadId]/comments/[commentId]/votes";
import { onRequestPost as spotlightPreview } from "../../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/spotlight/preview";
import { onRequestPost as spotlightSend } from "../../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/spotlight/send";
import {
	onRequestGet as worldBots,
	onRequestPost as createBot,
} from "../../apps/web/functions/api/worlds/[worldHandle]/bots";
import {
	onRequestGet as worldBotGroups,
	onRequestPost as createBotGroupRoute,
} from "../../apps/web/functions/api/worlds/[worldHandle]/groups";
import {
	onRequestDelete as deleteBotGroupRoute,
	onRequestPatch as patchBotGroupRoute,
} from "../../apps/web/functions/api/worlds/[worldHandle]/groups/[groupId]";
import { onRequestPost as addBotGroupMembersRoute } from "../../apps/web/functions/api/worlds/[worldHandle]/groups/[groupId]/bots";
import { onRequestDelete as removeBotGroupMemberRoute } from "../../apps/web/functions/api/worlds/[worldHandle]/groups/[groupId]/bots/[botId]";
import { onRequestGet as worldActivity } from "../../apps/web/functions/api/worlds/[worldHandle]/activity";
import { onRequestGet as botActivity } from "../../apps/web/functions/api/worlds/[worldHandle]/bots/[botHandle]/activity";
import { onRequestGet as botFollows } from "../../apps/web/functions/api/worlds/[worldHandle]/bots/[botHandle]/follows";
import { onRequestPost as chirperPreview } from "../../apps/web/functions/api/worlds/[worldHandle]/chirper-imports/preview";
import { onRequestGet as worlds, onRequestPost as createWorld } from "../../apps/web/functions/api/worlds";
import {
	onRequestDelete as deleteWorldRoute,
	onRequestPatch as patchWorld,
} from "../../apps/web/functions/api/worlds/[worldHandle]";
import { onRequestPost as applyWorldAvatarRoute } from "../../apps/web/functions/api/worlds/[worldHandle]/avatar/apply";
import { onRequestPost as generateWorldAvatarRoute } from "../../apps/web/functions/api/worlds/[worldHandle]/avatar/generate";
import { onRequestPost as promptWorldAvatarRoute } from "../../apps/web/functions/api/worlds/[worldHandle]/avatar/prompt";
import {
	default as agentRuntimeWorker,
	handleAgentRuntimeRequest,
	buildRuntimeLoopInput,
	BotRuntime,
	defaultReasoningPrefill,
	effectiveReasoningPrefill,
	effectiveProviderSettingsForBot,
	effectiveProviderSettingsForTranslation,
	formatRuntimeEventForContext,
	formatRuntimeInputForContext,
	loopMessageContributesToProviderHistory,
	oldestRowsForTokenFraction,
	PersistentCompactionReductionFailureError,
	promptContextBudgetCacheFingerprint,
	promptContextBudgetFromCounts,
	providerChatCompletionRequest,
	providerCompactionMessages,
	providerCompactionRequest,
	providerCompactionSystemInstruction,
	providerCompactionSummaryLimitsForChat,
	providerMessagesWithReasoningPrefill,
	providerResponseMessageForHistory,
	providerTranslationRequest,
	repairInvalidUnicodeText,
	runtimeFailureLogs,
	sanitizeProviderToolCalls,
	providerToolResultPayload,
	providerTokenProbeRequest,
	runtimeErrorLoopMessageContent,
	textTokenCalibrationFromProviderTokenCalibrationSamples,
	textTokenCalibrationFromPromptHistory,
	truncateForContext,
	toolUseRecoveryReminder,
} from "../../workers/agent-runtime/src/index";
import {
	isOpenRouterProviderBaseUrl,
	metaCompactionToolName,
	openRouterServerToolSelection,
	providerCompactionSummaryPropertyDescription,
	providerCompactionSummaryProperty,
	providerCompactionSummarySchemaDescription,
	standardPrompt,
	toolDefinitions,
	toolDefinitionsForProviderRound,
	type ProviderToolDefinition,
} from "../../workers/agent-runtime/src/prompt-and-tools";
import {
	providerContextCompletionReserveTokens,
} from "../../workers/agent-runtime/src/provider-requests";
import forumCoordinatorWorker, {
	ExclusiveOperationQueue,
	handleForumCoordinatorRequest,
	type Env as ForumCoordinatorEnv,
} from "../../workers/forum-coordinator/src/index";
import { pruneStreamEventsForPersistentEvents } from "../../apps/web/src/runtime-streams";
import { parsePathname, routePath } from "../../apps/web/src/routes";
import {
	botById,
	backfillInferredCloneSources,
	createSession,
	listForums,
	listUserBots,
	rawBotById,
	updateBotAvatar,
	updateUserAvatar,
	updateUserProfile,
	upsertProviderUser,
	userById,
} from "../../packages/shared/src/repository";
import { storeAvatarImage } from "../../packages/shared/src/avatar-storage";
import {
	botActivityFeedByHandle,
	botFollowGraphByHandle,
	botPublicProfileByHandle,
	followBot,
	ensureBootstrapNotification,
	listHotThreads,
	listPendingNotifications,
	listThreads,
	markBotSeenContent,
	markBotSeenFromResult,
	markNotificationsDelivered,
	readThread,
	recordBotRuntimeFailureHumanNotification,
	recordSpotlightNoReactionHumanNotification,
	recordSpotlightToolHumanNotification,
	refreshThreadHotScores,
	searchBots,
	searchThreads,
	setVote,
	threadHotScore,
	unfollowBot,
	worldActivityFeedByHandle,
} from "../../packages/shared/src/social";
import {
	normalizeSearchFilters,
	deleteSearchVector,
	reindexSearchVectors,
	searchEntitiesSemantic,
	searchEntitiesText,
	upsertBotSearchVector,
	upsertForumSearchVector,
	upsertWorldSearchVector,
	type SearchVectorEnv,
} from "../../packages/shared/src/search";
import {
	defaultAvatarImageGenerationSettings,
	defaultTranslationPrompt,
	localizedText,
	localizedTextString,
	type AvatarCrop,
	type AvatarImage,
	type BotDocument,
	type BotGroupSummary,
	type BotInferenceSubmissionMessage,
	type BotInferenceSubmissionToolCall,
	type BotLoopMessage,
	type BotLoopMessageLog,
	type BotRuntimeEvent,
	type BotTokenSpendSummary,
	type BotTokenUsageStats,
	type HumanProfile,
	type HumanSubscriptionTreeResponse,
	type LanguageTag,
	type LocalizedText,
	type NotificationEvent,
	type RequiredLocalizedText,
	type SearchResponse,
	type SpotlightIncludedContent,
	type SpotlightSyntheticContext,
	type ThreadDocument,
	type UserProfile,
	type WorldSummary,
} from "../../packages/shared/src/model";
import {
	defaultCommentBodyCharacters,
	defaultThreadBodyCharacters,
} from "../../packages/shared/src/posting";
import {
	compactionReasoningNonePolicyForModel,
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	effectiveStructuredToolCallsForModel,
	effectiveSupportsPrefillForModel,
	effectiveToolCallsForModel,
	modelSupportsCompactionReasoningNone,
	modelSupportsPrefill,
	modelSupportsPromptCacheControl,
	modelSupportsRequiredToolCalls,
	modelSupportsStructuredCompaction,
	modelSupportsStructuredOutputs,
	openRouterFreeModel,
	openRouterModelPolicy,
} from "../../packages/shared/src/openrouter-model-capabilities";
import { formatCommentRef, formatThreadRef } from "../../packages/shared/src/ids";
import { kvKeys } from "../../packages/shared/src/storage";
import {
	cachedGlobalInferenceCostStats,
	globalInferenceCostStatsCacheMaxAgeMs,
	globalInferenceCostStatsFromUsage,
	listOwnerBotTokenSpendSummaries,
	publicGlobalInferenceCostStats,
	recordBotInferenceUsageBatch,
	refreshGlobalInferenceCostStatsCacheIfStale,
	type BotInferenceUsageRecord,
} from "../../packages/shared/src/token-spend";
import { isValidHandleText, maxProviderRoutingJsonLength, sanitizeHandleInput } from "../../packages/shared/src/validation";
import { sessionCookieName, type AppEnv } from "../../apps/web/functions/api/_auth";
import { oauthCookieNames } from "../../apps/web/functions/api/auth/_oauth";
import { clearKv, execD1Statements, resetD1Schema } from "./d1-schema";

export {
	addBotGroupMembersRoute,
	agentRuntimeWorker,
	applyUserAvatarRoute,
	applyWorldAvatarRoute,
	backfillInferredCloneSources,
	beforeEach,
	bootstrap,
	botActivity,
	botActivityFeedByHandle,
	botById,
	botFollowGraphByHandle,
	botFollows,
	botPublicProfileByHandle,
	BotRuntime,
	buildRuntimeLoopInput,
	buildServiceRequest,
	cachedGlobalInferenceCostStats,
	chirperPreview,
	clearKv,
	commentRefResolver,
	commentVotes,
	compactionReasoningNonePolicyForModel,
	contextBudgetGetRoute,
	contextBudgetRoute,
	createBot,
	createBotGroupRoute,
	createForum,
	createSession,
	createWorld,
	defaultAvatarImageGenerationSettings,
	defaultCommentBodyCharacters,
	defaultReasoningPrefill,
	defaultThreadBodyCharacters,
	defaultTranslationPrompt,
	deleteBot,
	deleteBotAvatarRoute,
	deleteBotGroupRoute,
	deleteCommentRoute,
	deleteForumRoute,
	deleteProfileRoute,
	deleteSearchVector,
	deleteThreadRoute,
	deleteUserAvatarRoute,
	deleteWorldRoute,
	describe,
	effectiveCompactionModeForModel,
	effectiveProviderSettingsForBot,
	effectiveProviderSettingsForTranslation,
	effectiveReasoningEffortForModel,
	effectiveReasoningPrefill,
	effectiveStructuredToolCallsForModel,
	effectiveSupportsPrefillForModel,
	effectiveToolCallsForModel,
	ensureBootstrapNotification,
	ExclusiveOperationQueue,
	execD1Statements,
	expect,
	followBot,
	formatCommentRef,
	formatRuntimeEventForContext,
	formatRuntimeInputForContext,
	formatThreadRef,
	forumCoordinatorWorker,
	forums,
	forumThreads,
	generateUserAvatarRoute,
	generateWorldAvatarRoute,
	getHumanProfile,
	getNotificationsRoute,
	getProfile,
	getSubscriptionsRoute,
	githubCallback,
	githubStart,
	globalInferenceCostStatsCacheMaxAgeMs,
	globalInferenceCostStatsFromUsage,
	googleCallback,
	googleStart,
	handleAgentRuntimeRequest,
	handleForumCoordinatorRequest,
	health,
	isOpenRouterProviderBaseUrl,
	isValidHandleText,
	it,
	kvKeys,
	listForums,
	listHotThreads,
	listOwnerBotTokenSpendSummaries,
	listPendingNotifications,
	listThreads,
	listUserBots,
	localizedText,
	localizedTextString,
	logout,
	loopMessageContributesToProviderHistory,
	markAllNotificationsReadRoute,
	markBotSeenContent,
	markBotSeenFromResult,
	markNotificationsDelivered,
	maxProviderRoutingJsonLength,
	meBots,
	metaCompactionToolName,
	modelSupportsPrefill,
	modelSupportsCompactionReasoningNone,
	modelSupportsPromptCacheControl,
	modelSupportsRequiredToolCalls,
	modelSupportsStructuredCompaction,
	modelSupportsStructuredOutputs,
	normalizeSearchFilters,
	oauthCookieNames,
	oldestRowsForTokenFraction,
	openRouterFreeModel,
	openRouterImageModelsRoute,
	openRouterModelPolicy,
	openRouterServerToolSelection,
	pageShell,
	parsePathname,
	patchBot,
	patchBotGroupRoute,
	patchForum,
	patchProfile,
	patchSubscriptionsRoute,
	patchWorld,
	PersistentCompactionReductionFailureError,
	promptContextBudgetCacheFingerprint,
	promptContextBudgetFromCounts,
	promptUserAvatarRoute,
	promptWorldAvatarRoute,
	providerChatCompletionRequest,
	providerCompactionMessages,
	providerCompactionRequest,
	providerCompactionSummaryLimitsForChat,
	providerCompactionSummaryProperty,
	providerCompactionSummaryPropertyDescription,
	providerCompactionSummarySchemaDescription,
	providerCompactionSystemInstruction,
	providerContextCompletionReserveTokens,
	providerMessagesWithReasoningPrefill,
	providerResponseMessageForHistory,
	providerTokenProbeRequest,
	providerToolResultPayload,
	providerTranslationRequest,
	pruneStreamEventsForPersistentEvents,
	publicGlobalInferenceCostStats,
	rawBotById,
	readThread,
	recordBotInferenceUsageBatch,
	recordBotRuntimeFailureHumanNotification,
	recordSpotlightNoReactionHumanNotification,
	recordSpotlightToolHumanNotification,
	refreshGlobalInferenceCostStatsCacheIfStale,
	refreshThreadHotScores,
	reindexSearchVectors,
	relinkBotCloneRoute,
	removeBotGroupMemberRoute,
	repairInvalidUnicodeText,
	resetD1Schema,
	routePath,
	runtimeErrorLoopMessageContent,
	runtimeFailureLogs,
	runtimeHealth,
	runtimeMessagesRoute,
	runtimeMonitorRoute,
	sanitizeHandleInput,
	sanitizeProviderToolCalls,
	searchBots,
	searchEntitiesSemantic,
	searchEntitiesText,
	searchRoute,
	searchSuggestRoute,
	searchThreads,
	session,
	sessionCookieName,
	setVote,
	spotlightPreview,
	spotlightSend,
	spreadBotTicksRoute,
	standardPrompt,
	storeAvatarImage,
	testEnv,
	testLogin,
	testServiceProxy,
	textTokenCalibrationFromPromptHistory,
	textTokenCalibrationFromProviderTokenCalibrationSamples,
	threadDetail,
	threadHotScore,
	threadRefResolver,
	toolDefinitions,
	toolDefinitionsForProviderRound,
	toolUseRecoveryReminder,
	translateText,
	truncateForContext,
	unfollowBot,
	unlinkAuthIdentity,
	unlinkBotCloneRoute,
	updateBotAvatar,
	updateBotAvatarCrop,
	updateUserAvatar,
	updateUserAvatarCropRoute,
	updateUserProfile,
	uploadBotAvatar,
	uploadUserAvatarRoute,
	upsertBotSearchVector,
	upsertForumSearchVector,
	upsertProviderUser,
	upsertWorldSearchVector,
	userById,
	vi,
	worldActivity,
	worldActivityFeedByHandle,
	worldBotGroups,
	worldBots,
	worlds,
};

export type {
	AppEnv,
	AvatarCrop,
	AvatarImage,
	BotDocument,
	BotGroupSummary,
	BotInferenceSubmissionMessage,
	BotInferenceSubmissionToolCall,
	BotInferenceUsageRecord,
	BotLoopMessage,
	BotLoopMessageLog,
	BotRuntimeEvent,
	BotTokenSpendSummary,
	BotTokenUsageStats,
	ForumCoordinatorEnv,
	HumanProfile,
	HumanSubscriptionTreeResponse,
	LanguageTag,
	LocalizedText,
	NotificationEvent,
	ProviderToolDefinition,
	RequiredLocalizedText,
	SearchResponse,
	SearchVectorEnv,
	SpotlightIncludedContent,
	SpotlightSyntheticContext,
	ThreadDocument,
	UserProfile,
	WorldSummary,
};

export type RouteParams = Record<string, string>;

export const customProviderBaseUrl = "http://localhost:11434/v1";

export const capableOpenRouterModel = "openai/gpt-4o-mini";

export const testLanguage = "en" as LanguageTag;

export function lt(text: string): LocalizedText {
	return localizedText(text, testLanguage);
}

export function unspecifiedLt(text: string): LocalizedText {
	return localizedText(text, null);
}

export function requiredLt(text: string): RequiredLocalizedText {
	return { lang: testLanguage, text };
}

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

export type BotBody = {
	id: string;
	homeWorldId: string;
	homeWorldHandle: string;
	handle: string;
	language: LanguageTag | null;
	includeLanguageInSystemPrompt: boolean | null;
	displayName: string;
	shortBio: string;
	avatar?: AvatarImage;
	avatarUrl?: string;
	avatarCrop?: AvatarCrop;
	cloneSource?: {
		sourceBotId: string;
		sourceWorldId: string;
		sourceWorldHandle: string;
		sourceHandle: string;
		linked: boolean;
		sourceBot?: {
			id: string;
			homeWorldHandle: string;
			handle: string;
			language: LanguageTag | null;
			includeLanguageInSystemPrompt: boolean | null;
			displayName: string;
			shortBio: string;
			avatarUrl?: string;
			avatarCrop?: AvatarCrop;
		};
	};
	localOverrides?: {
		language: LanguageTag | null;
		includeLanguageInSystemPrompt: boolean | null;
		displayName: string;
		shortBio: string;
		prompt?: string;
		inferenceSettings: Record<string, unknown>;
		hasAvatar: boolean;
		avatarUrl?: string;
		avatarCrop?: AvatarCrop;
	};
	owner?: {
		id: string;
		handle: string;
		displayName: string;
	};
	createdAt: string;
	inferenceSettings: Record<string, unknown>;
	prompt?: string;
	postingSettings: {
		threadBodyCharacters?: number;
		commentBodyCharacters?: number;
	};
	effectivePostingSettings: {
		threadBodyCharacters: number;
		commentBodyCharacters: number;
	};
	toolSettings?: Record<string, unknown>;
	tickSettings: {
		enabled: boolean;
		intervalSeconds: number;
		allowEarlyLogOff?: boolean;
				contextWindowTokens?: number;
				compactionSummaryPercent?: number;
				compactionMaxCharacters?: number;
				maxToolCallsPerTick?: number;
			maxSuccessfulToolCallsPerIteration?: number;
			maxGeneratedTokensPerTick?: number;
			maxGeneratedTokensPerIteration?: number;
		};
		effectiveTickSettings: {
			enabled: boolean;
			intervalSeconds: number;
			allowEarlyLogOff: boolean;
				contextWindowTokens: number;
				compactionThreshold: number;
				compactionSummaryPercent: number;
				compactionMaxCharacters: number;
				maxToolCallsPerTick: number;
			maxSuccessfulToolCallsPerIteration: number;
			maxGeneratedTokensPerTick: number;
			maxGeneratedTokensPerIteration: number;
		};
	lastActiveAt?: string;
	nextDueAt?: string | null;
};

export type TestForum = {
	id: string;
	handle: string;
	worldId: string;
};

export type TestThread = {
	id: string;
	rootCommentId: string;
};

export type TestComment = {
	id: string;
};

export type ThreadFreshCacheEntryForTest = {
	expiresAt: string;
	thread: ThreadDocument;
	writtenAt: string;
};

export type ThreadListPayload = {
	data: {
		threads: Array<{
			id: string;
			readState?: {
				isNew: boolean;
				hasNewComments: boolean;
				newCommentCount: number;
			};
		}>;
	};
};

export type ThreadDetailPayload = {
	data: {
		thread: {
			comments: Array<{
				id: string;
				readState?: { isNew: boolean };
			}>;
		};
	};
};

export type SpotlightPreviewPayload = {
	data: {
		preview: {
			botPreviews: Array<{
				bot: { id: string };
				included: {
					threadCount: number;
					commentCount: number;
					excludedSeenCount: number;
				};
			}>;
		};
	};
};

export type SpotlightSendPayload = {
	data: {
		preview: SpotlightPreviewPayload["data"]["preview"];
		deliveries: Array<{
			botId: string;
			ok: boolean;
			injectionId?: string;
			tickStatus?: string;
		}>;
	};
};

export function contextFor<F extends PagesFunction<AppEnv>>(
	request: Request,
	params: RouteParams = {},
	envOverrides: Partial<AppEnv> = {},
): Parameters<F>[0] {
	const appEnv: Partial<AppEnv> = {
		ASSETS: {
			fetch,
		} as unknown as Fetcher,
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
		AGENT_RUNTIME: {
			fetch: async (serviceRequest: Request) => {
				if (new URL(serviceRequest.url).pathname === "/health") {
					return Response.json({ ok: true, runtime: "agent-runtime-worker" });
				}
				return handleAgentRuntimeRequest(serviceRequest, {
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
				});
			},
		} as unknown as Fetcher,
		INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		FORUM_COORDINATOR_SERVICE: {
			fetch: async (serviceRequest: Request) => {
				if (new URL(serviceRequest.url).pathname === "/health") {
					return Response.json({ ok: true, runtime: "forum-coordinator-worker" });
				}
				return handleForumCoordinatorRequest(serviceRequest, {
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
				});
			},
		} as unknown as Fetcher,
		...envOverrides,
	};

	return {
		data: {},
		env: appEnv,
		functionPath: new URL(request.url).pathname,
		next: async () => new Response("Not Found", { status: 404 }),
		params,
		passThroughOnException: () => {},
		request,
		waitUntil: () => {},
	} as unknown as Parameters<F>[0];
}

export const testSpaShell = `<!doctype html><html><head><meta name="description" content="Bickr" /><title>Bickr</title></head><body></body></html>`;

export async function pageHtml(path: string, cookie?: string): Promise<string> {
	const headers = new Headers();
	if (cookie) {
		headers.set("cookie", cookie);
	}
	const response = await pageShell(pageContext(new Request(`http://example.com${path}`, { headers })));
	return response.text();
}

export function pageContext(request: Request): Parameters<typeof pageShell>[0] {
	return {
		...contextFor<typeof pageShell>(request),
		next: async () =>
			new Response(testSpaShell, {
				headers: { "content-type": "text/html; charset=UTF-8" },
			}),
	} as Parameters<typeof pageShell>[0];
}

export function cookieHeaderFromSetCookies(setCookies: string[]): string {
	return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

export function setCookieValue(setCookies: string[], name: string): string {
	const encoded = setCookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1);
	return encoded === undefined ? "" : decodeURIComponent(encoded);
}

export function htmlTitle(html: string): string {
	return html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
}

export function metaContent(html: string, attribute: "name" | "property", key: string): string {
	const pattern = new RegExp(`<meta ${attribute}="${escapeRegExp(key)}" content="([^"]*)"`);
	return decodeHtmlAttribute(html.match(pattern)?.[1] ?? "");
}

export async function setBotAvatarForTest(bot: Pick<BotBody, "id">, avatarUrl: string): Promise<void> {
	const stored = await testEnv.BICKR_KV.get(`v1:bot:${bot.id}`, { type: "json" }) as BotDocument | null;
	if (!stored) {
		throw new Error(`Bot ${bot.id} not found.`);
	}
	const now = new Date().toISOString();
	const avatar: AvatarImage = {
		contentType: "image/png",
		key: `test/${bot.id}.png`,
		updatedAt: now,
		url: avatarUrl,
	};
	await testEnv.BICKR_KV.put(`v1:bot:${bot.id}`, JSON.stringify({ ...stored, avatar, updatedAt: now }));
	await testEnv.BICKR_D1.prepare(`UPDATE bots_index SET avatar_url = ?, updated_at = ? WHERE bot_id = ?`)
		.bind(avatarUrl, now, bot.id)
		.run();
}

export async function setUserAvatarForTest(userId: string, avatarUrl: string, crop?: AvatarCrop): Promise<void> {
	const now = new Date().toISOString();
	const avatar: AvatarImage = {
		contentType: "image/png",
		key: `test/users/${userId}.png`,
		updatedAt: now,
		url: avatarUrl,
		...(crop ? { crop } : {}),
	};
	await updateUserAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, userId, avatar, now);
}

export function decodeHtmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, "\"")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function memoryDurableStorage(): {
	storage: DurableObjectStorage;
	values: Map<string, unknown>;
} {
	const values = new Map<string, unknown>();
	return {
		storage: {
			delete: async (key: string) => {
				values.delete(key);
			},
			get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
			put: async (key: string, value: unknown) => {
				values.set(key, value);
			},
		} as unknown as DurableObjectStorage,
		values,
	};
}

export type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};

export function deferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] = () => {};
	let reject: Deferred<T>["reject"] = () => {};
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

export function kvWithDelayedFirstPut(
	delegate: KVNamespace,
	delayedKey: string,
	started: Deferred<void>,
	release: Deferred<void>,
): KVNamespace {
	let delayed = false;
	return {
		get: delegate.get.bind(delegate),
		put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
			if (key === delayedKey && !delayed) {
				delayed = true;
				started.resolve();
				await release.promise;
			}
			await delegate.put(key, value, options);
		},
		delete: delegate.delete.bind(delegate),
	} as unknown as KVNamespace;
}

export type FakeSearchMatch = {
	id: string;
	metadata?: unknown;
	score: number;
};

export function fakeSearchBindings(mode: "generic" | "legacy" = "generic"): {
	deleted: string[];
	env: SearchVectorEnv;
	matches: FakeSearchMatch[];
	upserted: Array<{ id: string; metadata?: Record<string, string | number | boolean>; values: number[] }>;
} {
	const deleted: string[] = [];
	const upserted: Array<{ id: string; metadata?: Record<string, string | number | boolean>; values: number[] }> = [];
	let matches: FakeSearchMatch[] = [];
	const vectorize: NonNullable<SearchVectorEnv["BICKR_SEARCH_VECTORIZE"]> = {
		deleteByIds: async (ids) => {
			deleted.push(...ids);
		},
		query: async () => ({ matches }),
		upsert: async (vectors) => {
			upserted.push(...vectors);
		},
	};
	const env: SearchVectorEnv = {
		AI: {
			run: async (_model, input) => ({ data: input.text.map(fakeSearchEmbedding) }),
		},
		...(mode === "generic" ? { BICKR_SEARCH_VECTORIZE: vectorize } : { BICKR_BOT_VECTORIZE: vectorize }),
	};
	return {
		deleted,
		env,
		get matches() {
			return matches;
		},
		set matches(next) {
			matches = next;
		},
		upserted,
	};
}

export function fakeSearchEmbedding(text: string): number[] {
	const normalized = text.trim();
	return [normalized.length, normalized.charCodeAt(0) || 0, normalized.charCodeAt(normalized.length - 1) || 0];
}

export type FakeR2StoredObject = {
	bytes: Uint8Array;
	httpMetadata?: {
		contentType?: string;
		cacheControl?: string;
	};
};

export function fakeR2Bucket(): { bucket: R2Bucket; objects: Map<string, FakeR2StoredObject> } {
	const objects = new Map<string, FakeR2StoredObject>();
	const bucket = {
		get: async (key: string) => {
			const object = objects.get(key);
			if (!object) {
				return null;
			}
			return {
				arrayBuffer: async () => new Uint8Array(object.bytes).buffer,
			};
		},
		put: async (
			key: string,
			value: unknown,
			options?: { httpMetadata?: FakeR2StoredObject["httpMetadata"] },
		) => {
			objects.set(key, {
				bytes: bytesFromR2PutValue(value),
				...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
			});
			return null;
		},
		delete: async (key: string) => {
			objects.delete(key);
		},
	} as unknown as R2Bucket;
	return { bucket, objects };
}

export function bytesFromR2PutValue(value: unknown): Uint8Array {
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value.slice(0));
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	}
	throw new Error("Unexpected R2 test value.");
}

export function pngAvatarBytes(): Uint8Array {
	return base64Bytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
}

export function jpegAvatarBytes(): Uint8Array {
	return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}

export function largePngAvatarBytes(): Uint8Array {
	const bytes = new Uint8Array(1_600_000);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x00, 0x00, 0x04, 0x00], 16);
	bytes.set([0x00, 0x00, 0x04, 0x00], 20);
	return bytes;
}

export function webpAvatarBytes(): Uint8Array {
	return new Uint8Array([
		0x52, 0x49, 0x46, 0x46,
		0x04, 0x00, 0x00, 0x00,
		0x57, 0x45, 0x42, 0x50,
	]);
}

export function svgAvatarBytes(): Uint8Array {
	return new TextEncoder().encode(
		`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">
	<defs><linearGradient id="paint" x1="0" x2="1"><stop offset="0" stop-color="#2244ff"/><stop offset="1" stop-color="#ffcc33"/></linearGradient></defs>
	<rect width="24" height="32" rx="4" fill="url(#paint)"/>
	<circle cx="12" cy="12" r="6" fill="#ffffff"/>
</svg>`,
	);
}

export function unsafeSvgAvatarBytes(): Uint8Array {
	return new TextEncoder().encode(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert("avatar")</script><rect width="24" height="24"/></svg>`,
	);
}

export function avatarDataUrl(bytes = pngAvatarBytes(), contentType = "image/png"): string {
	return `data:${contentType};base64,${base64String(bytes)}`;
}

export function base64Bytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function base64String(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export async function authCookie(): Promise<string> {
	return authCookieFor({
		subject: "1175142",
		login: "octocat",
		displayName: "Octo Cat",
	});
}

export async function authCookieFor(profile: { subject: string; login: string; displayName: string }): Promise<string> {
	const user = await upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
		provider: "github",
		subject: profile.subject,
		login: profile.login,
		displayName: profile.displayName,
	});
	await updateUserProfile(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id, {
		handle: user.handle,
		displayName: user.displayName,
	});
	const created = await createSession(testEnv.BICKR_KV, user.id);
	return `${sessionCookieName}=${encodeURIComponent(created.cookieValue)}`;
}

export async function userIdForHandle(handle: string): Promise<string> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index WHERE handle = ?`)
		.bind(handle)
		.first<{ id: string }>();
	if (!row) {
		throw new Error(`No test user for handle ${handle}.`);
	}
	return row.id;
}

export async function seedWorld(cookie: string): Promise<void> {
	await createWorld(
		contextFor<typeof createWorld>(
			jsonRequest(
				"http://example.com/api/worlds",
				"POST",
				{ handle: "patch-notes", language: testLanguage, name: "Patch Notes", description: "Change discussion" },
				cookie,
			),
		),
	);
}

export async function createWorldForTest(cookie: string, handle: string, name: string): Promise<void> {
	const response = await createWorld(
		contextFor<typeof createWorld>(
			jsonRequest(
				"http://example.com/api/worlds",
				"POST",
				{ handle, language: testLanguage, name, description: `${name} test world.` },
				cookie,
			),
		),
	);
	expect(response.status, await response.clone().text()).toBe(201);
}

export async function createForumForTest(cookie: string, handle: string): Promise<TestForum> {
	const response = await createForum(
		contextFor<typeof createForum>(
			jsonRequest(
				`http://example.com/api/worlds/patch-notes/forums`,
				"POST",
				{ handle, language: testLanguage, description: `${handle} discussions` },
				cookie,
			),
			{ worldHandle: "patch-notes" },
		),
	);
	const payload = (await response.json()) as { data: { forum: TestForum } };
	return payload.data.forum;
}

export async function createBotInWorld(
	cookie: string,
	worldHandle: string,
	input: {
		handle: string;
		language?: LanguageTag | null;
		includeLanguageInSystemPrompt?: boolean | null;
		displayName?: string | LocalizedText;
		shortBio?: string | LocalizedText;
		prompt?: string | LocalizedText;
		cloneSourceBotId?: string;
	},
): Promise<BotBody> {
	const response = await createBot(
		contextFor<typeof createBot>(
			jsonRequest(
				`http://example.com/api/worlds/${worldHandle}/bots`,
				"POST",
				{
					language: testLanguage,
					...input,
					displayName: input.displayName === undefined ? `${input.handle} display` : localizedTextString(input.displayName),
					shortBio: input.shortBio === undefined ? `${input.handle} bio` : localizedTextString(input.shortBio),
					prompt: input.prompt === undefined ? `${input.handle} prompt` : localizedTextString(input.prompt),
				},
				cookie,
			),
			{ worldHandle },
		),
	);
	expect(response.status, await response.clone().text()).toBe(201);
	const payload = (await response.json()) as { data: { bot: BotBody } };
	return payload.data.bot;
}

export async function createBotForTest(cookie: string, handle: string, options: { enabled?: boolean } = {}): Promise<BotBody> {
	const displayName = handle
		.split("-")
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
	const response = await createBot(
		contextFor<typeof createBot>(
			jsonRequest(
				"http://example.com/api/worlds/patch-notes/bots",
				"POST",
				{
					handle,
					language: testLanguage,
					displayName,
					shortBio: `${displayName} test bot.`,
					prompt: `You are ${displayName}.`,
				},
				cookie,
			),
			{ worldHandle: "patch-notes" },
		),
	);
	const payload = (await response.json()) as { data: { bot: BotBody } };
	if (options.enabled !== undefined && payload.data.bot.tickSettings.enabled !== options.enabled) {
		const patchResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${payload.data.bot.id}`,
					"PATCH",
					{ tickSettings: { enabled: options.enabled } },
					cookie,
				),
				{ botId: payload.data.bot.id },
			),
		);
		const patchPayload = (await patchResponse.json()) as { data: { bot: BotBody } };
		return patchPayload.data.bot;
	}
	return payload.data.bot;
}

export async function patchBotInferenceForTest(
	cookie: string,
	botId: string,
	inferenceSettings: Record<string, unknown>,
	language: LanguageTag = testLanguage,
): Promise<BotBody> {
	const response = await patchBot(
		contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${botId}`,
					"PATCH",
					{ language, inferenceSettings },
					cookie,
				),
			{ botId },
		),
	);
	const payload = (await response.json()) as { data: { bot: BotBody } };
	return payload.data.bot;
}

export async function createThreadForTest(
	forumId: string,
	botId: string,
	title: string,
	body: string,
): Promise<TestThread> {
	const request = jsonRequest(`http://example.com/forums/${forumId}/threads`, "POST", {
		title: requiredLt(title),
		body: requiredLt(body),
	});
	request.headers.set("x-bickr-bot-id", botId);
	const response = await handleForumCoordinatorRequest(request, {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
	});
	const payload = (await response.json()) as { data: { thread: TestThread } };
	return payload.data.thread;
}

export async function createCommentForTest(
	threadId: string,
	botId: string,
	body: string,
	parentCommentId?: string,
): Promise<TestComment> {
	const request = jsonRequest(`http://example.com/threads/${threadId}/comments`, "POST", {
		body: requiredLt(body),
		...(parentCommentId ? { parentCommentId } : {}),
	});
	request.headers.set("x-bickr-bot-id", botId);
	const response = await handleForumCoordinatorRequest(request, {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
	});
	const payload = (await response.json()) as {
		data: {
			thread: {
				rootCommentId: string;
				comments: Array<{ id: string; body: LocalizedText | string; parentCommentId?: string }>;
			};
		};
	};
	const effectiveParentCommentId = parentCommentId ?? payload.data.thread.rootCommentId;
	const comment = [...payload.data.thread.comments]
		.reverse()
		.find((item) => localizedTextString(item.body) === body && item.parentCommentId === effectiveParentCommentId);
	if (!comment) {
		throw new Error("Created comment not found in test response.");
	}
	return { id: comment.id };
}

export async function pause(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export function jsonRequest(
	url: string,
	method: string,
	body: unknown,
	cookie?: string,
	headerOverrides: Record<string, string> = {},
): Request {
	const headers = new Headers({ "content-type": "application/json" });
	if (cookie) {
		headers.set("cookie", cookie);
	}
	for (const [key, value] of Object.entries(headerOverrides)) {
		headers.set(key, value);
	}
	return new Request(url, {
		method,
		headers,
		body: JSON.stringify(apiEntityBodyForTest(url, method, body)),
	});
}

export function apiEntityBodyForTest(url: string, method: string, body: unknown): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return body;
	}
	const normalizedMethod = method.toUpperCase();
	if (normalizedMethod !== "POST" && normalizedMethod !== "PATCH") {
		return body;
	}
	const record = body as Record<string, unknown>;
	if (Object.hasOwn(record, "language")) {
		return body;
	}
	const path = new URL(url).pathname;
	if (!path.startsWith("/api/")) {
		return body;
	}
	if (
		path === "/api/worlds" ||
		/^\/api\/worlds\/[^/]+$/.test(path) ||
		/^\/api\/worlds\/[^/]+\/forums(?:\/[^/]+)?$/.test(path) ||
		/^\/api\/worlds\/[^/]+\/bots$/.test(path) ||
		/^\/api\/me\/bots\/[^/]+$/.test(path) ||
		/^\/api\/worlds\/[^/]+\/groups(?:\/[^/]+)?$/.test(path) ||
		path === "/api/me/profile"
	) {
		return { language: testLanguage, ...record };
	}
	return body;
}

export function serviceJsonRequest(path: string, userId: string, body: unknown): Request {
	return jsonRequest(`https://internal.bickr${path}`, "POST", body, undefined, {
		"x-bickr-user-id": userId,
	});
}

export function serviceGetRequest(path: string, userId: string): Request {
	return new Request(`https://internal.bickr${path}`, {
		method: "GET",
		headers: {
			"x-bickr-user-id": userId,
		},
	});
}

export function serviceStreamJsonRequest(path: string, userId: string, body: unknown): Request {
	return jsonRequest(`https://internal.bickr${path}`, "POST", body, undefined, {
		accept: "text/event-stream",
		"x-bickr-user-id": userId,
	});
}

export function parseJsonSseEvents(text: string): Array<Record<string, unknown>> {
	return text
		.split("\n\n")
		.map((block) =>
			block
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("\n")
		)
		.filter((data) => data && data !== "[DONE]")
		.map((data) => JSON.parse(data) as Record<string, unknown>);
}

export function neverStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>();
}

export function streamedProviderRateLimit(id: string, providerName: string): Record<string, unknown> {
	return {
		id,
		object: "chat.completion.chunk",
		model: "google/gemma-4-31b-it",
		choices: [],
		error: {
			code: 429,
			message: "Provider returned error",
			metadata: {
				error_type: "provider_rate_limited",
				provider_name: providerName,
				raw: `${providerName} is temporarily rate-limited upstream.`,
			},
		},
	};
}

export function sseStream(events: Array<Record<string, unknown> | "[DONE]">): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				const data = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);
				controller.enqueue(encoder.encode(`data: ${data}\n\n`));
			}
			controller.close();
		},
	});
}

export function runtimeEvent(
	seq: number,
	runId: string,
	type: BotRuntimeEvent["type"],
	payload: unknown,
): BotRuntimeEvent {
	return {
		seq,
		runId,
		type,
		payload,
		tokenEstimate: 0,
		createdAt: "2026-04-30T00:00:00.000Z",
	};
}

export function memoryRuntimeSql(options: { unconsumedInjections?: ReadonlySet<string> } = {}) {
	const values = new Map<string, string>();
	return {
		exec<T>(sql: string, ...params: unknown[]) {
			if (/SELECT value_json FROM runtime_state WHERE key = \?/.test(sql)) {
				const value = values.get(String(params[0]));
				return {
					toArray: () => (value === undefined ? [] : [{ value_json: value } as T]),
				};
			}
			if (/SELECT 1 AS found\s+FROM injections\s+WHERE id = \? AND consumed_at IS NULL/.test(sql)) {
				const found = options.unconsumedInjections?.has(String(params[0])) ?? false;
				return {
					toArray: () => (found ? [{ found: 1 } as T] : []),
				};
			}
			if (/INSERT INTO runtime_state/.test(sql)) {
				values.set(String(params[0]), String(params[1]));
			}
			if (/DELETE FROM runtime_state WHERE key = \?/.test(sql)) {
				values.delete(String(params[0]));
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
}

export function memoryLoopMessageInsertSql(displayEventSeq: number, displayPayload: unknown) {
	let inserted: (Record<string, unknown> & { display_event_seq: number | null }) | null = null;
	let lastInsertSeq = 0;
	return {
		inserted: () => inserted,
		exec<T>(sql: string, ...params: unknown[]) {
			const normalized = sql.trim().replace(/\s+/g, " ");
			if (/SELECT COALESCE\(MAX\(position\), 0\) \+ 1 AS position FROM loop_messages/.test(normalized)) {
				return {
					one: () => ({ position: 1 }) as T,
					toArray: () => [{ position: 1 } as T],
				};
			}
			if (/SELECT seq, type, payload_json FROM events WHERE seq = \? LIMIT 1/.test(normalized)) {
				return {
					toArray: () =>
						Number(params[0]) === displayEventSeq ?
							[{ seq: displayEventSeq, type: "tool_result", payload_json: JSON.stringify(displayPayload) } as T]
						:	[],
				};
			}
			if (/INSERT INTO loop_messages/.test(normalized)) {
				lastInsertSeq = 1;
				inserted = {
					seq: lastInsertSeq,
					position: Number(params[0]),
					run_id: String(params[1]),
					role: params[2] as BotLoopMessage["role"],
					message_json: String(params[3]),
					origin: params[4] as BotLoopMessage["origin"],
					status: params[5] === null || params[5] === undefined ? "complete" : String(params[5]),
					token_estimate: Number(params[6]),
					stream_seq: params[7] === null ? null : Number(params[7]),
					display_event_seq: params[8] === null ? null : Number(params[8]),
					display_event_type: Number(params[8]) === displayEventSeq ? "tool_result" : null,
					display_event_payload_json: Number(params[8]) === displayEventSeq ? JSON.stringify(displayPayload) : null,
					compacted_by: null,
					deleted_at: null,
					created_at: String(params[9]),
					has_logs: 0,
				};
			}
			if (/SELECT last_insert_rowid\(\) AS seq/.test(normalized)) {
				return {
					one: () => ({ seq: lastInsertSeq }) as T,
					toArray: () => [{ seq: lastInsertSeq } as T],
				};
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
}

export function memoryInferenceSubmissionSql() {
	type Row = {
		id: string;
		event_seq: number;
		run_id: string;
		purpose: string;
		model: string;
		provider_base_url: string;
		message_count: number;
		messages_json: string;
		display_messages_json: string | null;
		created_at: string;
	};
	let rows: Row[] = [];
	let lastChanges = 0;
	return {
		exec<T>(sql: string, ...params: unknown[]) {
			if (/INSERT INTO inference_submissions/.test(sql)) {
				const row: Row = {
					id: String(params[0]),
					event_seq: Number(params[1]),
					run_id: String(params[2]),
					purpose: String(params[3]),
					model: String(params[4]),
					provider_base_url: String(params[5]),
					message_count: Number(params[6]),
					messages_json: String(params[7]),
					display_messages_json: params[8] === null ? null : String(params[8]),
					created_at: String(params[9]),
				};
				rows = [...rows.filter((existing) => existing.event_seq !== row.event_seq), row];
				lastChanges = 1;
			} else if (/UPDATE inference_submissions\s+SET display_messages_json = \?/.test(sql)) {
				const row = rows.find((item) => item.event_seq === Number(params[1]));
				if (row) {
					row.display_messages_json = String(params[0]);
					lastChanges = 1;
				} else {
					lastChanges = 0;
				}
			} else if (/DELETE FROM inference_submissions\s+WHERE id NOT IN/.test(sql)) {
				const keep = new Set(
					[...rows]
						.sort((left, right) => right.event_seq - left.event_seq)
						.slice(0, Number(params[0]))
						.map((row) => row.id),
				);
				const before = rows.length;
				rows = rows.filter((row) => keep.has(row.id));
				lastChanges = before - rows.length;
			} else if (/SELECT id, event_seq, run_id, purpose, model, provider_base_url, message_count, messages_json, display_messages_json, created_at\s+FROM inference_submissions\s+WHERE event_seq = \?/.test(sql)) {
				const row = rows.find((item) => item.event_seq === Number(params[0]));
				return {
					toArray: () => (row ? [row as T] : []),
				};
			} else if (/SELECT id, event_seq, run_id, purpose, model, provider_base_url, message_count, messages_json, display_messages_json, created_at\s+FROM inference_submissions\s+ORDER BY event_seq ASC/.test(sql)) {
				return {
					toArray: () => [...rows].sort((left, right) => left.event_seq - right.event_seq) as T[],
				};
			} else if (/DELETE FROM inference_submissions WHERE event_seq = \?/.test(sql)) {
				const before = rows.length;
				rows = rows.filter((row) => row.event_seq !== Number(params[0]));
				lastChanges = before - rows.length;
			} else if (/DELETE FROM inference_submissions/.test(sql)) {
				lastChanges = rows.length;
				rows = [];
			} else if (/SELECT changes\(\) AS count/.test(sql)) {
				return {
					one: () => ({ count: lastChanges }) as T,
					toArray: () => [{ count: lastChanges } as T],
				};
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
}

export function memoryLoopMessageLogSql(options: {
	streamSeq?: number | null;
	providerUsage?: {
		requestSeq: number;
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cachedTokens: number;
		reasoningTokens?: number;
		cost?: number | null;
		usageJson: unknown;
	};
} = {}) {
	type LogRow = {
		id: number;
		message_seq: number;
		kind: string;
		encoding: string;
		base_log_id: number | null;
		prefix_length: number | null;
		text_length: number;
		chunk_count: number;
		created_at: string;
	};
	type ChunkRow = {
		log_id: number;
		chunk_index: number;
		text: string;
	};
	const messageRow = {
		seq: 1,
		position: 1,
		run_id: "run-log",
		role: "assistant",
		message_json: JSON.stringify({ role: "assistant", content: "Stored message." }),
		origin: "provider_response",
		status: "complete",
		token_estimate: 1,
		stream_seq: options.streamSeq ?? null,
		display_event_seq: null,
		display_event_type: null,
		display_event_payload_json: null,
		compacted_by: null,
		deleted_at: null as string | null,
		created_at: "2026-05-01T00:00:00.000Z",
		has_logs: 1,
	};
	let logs: LogRow[] = [];
	let chunks: ChunkRow[] = [];
	let lastInsertId = 0;
	return {
		exec<T>(sql: string, ...params: unknown[]) {
			if (/SELECT id\s+FROM loop_message_logs\s+WHERE kind = \?/.test(sql)) {
				const row = [...logs].reverse().find((item) => item.kind === String(params[0]));
				return { toArray: () => (row ? [{ id: row.id } as T] : []) };
			}
			if (/INSERT INTO loop_message_logs/.test(sql)) {
				lastInsertId += 1;
				logs.push({
					id: lastInsertId,
					message_seq: Number(params[0]),
					kind: String(params[1]),
					encoding: String(params[2]),
					base_log_id: params[3] === null ? null : Number(params[3]),
					prefix_length: params[4] === null ? null : Number(params[4]),
					text_length: Number(params[5]),
					chunk_count: Number(params[6]),
					created_at: String(params[7]),
				});
			} else if (/SELECT last_insert_rowid\(\) AS id/.test(sql)) {
				return {
					one: () => ({ id: lastInsertId }) as T,
					toArray: () => [{ id: lastInsertId } as T],
				};
			} else if (/INSERT INTO loop_message_log_chunks/.test(sql)) {
				chunks.push({
					log_id: Number(params[0]),
					chunk_index: Number(params[1]),
					text: String(params[2]),
				});
			} else if (/FROM loop_messages\s+WHERE compacted_by IS NULL/.test(sql)) {
				return { toArray: () => [{ seq: messageRow.seq } as T] };
			} else if (/FROM loop_message_logs\s+ORDER BY id ASC/.test(sql)) {
				return { toArray: () => logs as T[] };
			} else if (/FROM loop_message_logs\s+WHERE id = \?/.test(sql)) {
				const row = logs.find((item) => item.id === Number(params[0]));
				return { toArray: () => (row ? [row as T] : []) };
			} else if (/FROM loop_message_log_chunks\s+WHERE log_id = \?/.test(sql)) {
				return {
					toArray: () =>
						chunks
							.filter((chunk) => chunk.log_id === Number(params[0]))
							.sort((left, right) => left.chunk_index - right.chunk_index) as T[],
				};
			} else if (/FROM loop_messages m[\s\S]+WHERE m\.seq = \?/.test(sql)) {
				return { toArray: () => (Number(params[0]) === messageRow.seq ? [messageRow as T] : []) };
			} else if (/FROM provider_usage\s+WHERE run_id = \?/.test(sql)) {
				const usage = options.providerUsage;
				if (!usage || String(params[0]) !== messageRow.run_id || Number(params[1]) !== usage.requestSeq) {
					return { toArray: () => [] as T[] };
				}
				return {
					toArray: () => [{
						created_at: "2026-05-01T00:00:01.000Z",
						run_id: messageRow.run_id,
						model: "test-model",
						requested_model: "test-model",
						response_model: null,
						provider_name: null,
						context_window_tokens: 16_000,
						prompt_tokens: usage.promptTokens,
						completion_tokens: usage.completionTokens,
						total_tokens: usage.totalTokens,
						cached_tokens: usage.cachedTokens,
						reasoning_tokens: usage.reasoningTokens ?? 0,
						cost: usage.cost ?? null,
						usage_json: JSON.stringify(usage.usageJson),
					} as T],
				};
			} else if (/UPDATE loop_messages\s+SET deleted_at = \?/.test(sql)) {
				if (Number(params[1]) === messageRow.seq && !messageRow.deleted_at) {
					messageRow.deleted_at = String(params[0]);
				}
			} else if (/FROM loop_message_logs\s+WHERE message_seq = \?/.test(sql)) {
				return {
					toArray: () => logs.filter((row) => row.message_seq === Number(params[0])).sort((left, right) => left.id - right.id) as T[],
				};
			} else if (/DELETE FROM loop_message_log_chunks WHERE log_id = \?/.test(sql)) {
				chunks = chunks.filter((chunk) => chunk.log_id !== Number(params[0]));
			} else if (/DELETE FROM loop_message_logs WHERE id = \?/.test(sql)) {
				logs = logs.filter((row) => row.id !== Number(params[0]));
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
}

export type LoopMessageRowForTest = Omit<ReturnType<typeof loopMessageRowForTest>, "origin" | "role"> & {
	origin: BotLoopMessage["origin"];
	role: BotLoopMessage["role"];
};

export function memoryLoopMessagePageSql(rows: LoopMessageRowForTest[]) {
	const sortedRows = (pageRows: LoopMessageRowForTest[]) =>
		[...pageRows].sort((left, right) => left.position - right.position || left.seq - right.seq);
	const hasVisibleChildren = (seq: number): boolean => rows.some((child) => child.deleted_at === null && child.compacted_by === seq);
	const compactionBoundaries = () =>
		rows
			.filter((row) => row.deleted_at === null)
			.filter((row) => row.origin === "compaction")
			.filter((row) => hasVisibleChildren(row.seq));
	const latestActiveBoundary = (): number | null =>
		compactionBoundaries()
			.filter((row) => row.compacted_by === null)
			.sort((left, right) => right.seq - left.seq)[0]?.seq ?? null;
	const boundaryChildren = (sourceCompactionSeq: number | null): number[] =>
		compactionBoundaries()
			.filter((row) => row.compacted_by === sourceCompactionSeq)
			.sort((left, right) => right.position - left.position || right.seq - left.seq)
			.map((row) => row.seq);
	const activeRows = (afterSeq = 0) =>
		sortedRows(
			rows
				.filter((row) => row.deleted_at === null)
				.filter((row) => row.compacted_by === null)
				.filter((row) => afterSeq <= 0 || row.seq > afterSeq),
		);
	const rowsForSource = (sourceCompactionSeq: number) => {
		return sortedRows(
			rows
				.filter((row) => row.deleted_at === null)
				.filter((row) => row.compacted_by === sourceCompactionSeq),
		);
	};
	return {
		exec<T>(sql: string, ...params: unknown[]) {
			if (/SELECT m\.seq,\s*m\.created_at\s+FROM loop_messages m/.test(sql)) {
				const seq = latestActiveBoundary();
				const row = seq === null ? undefined : rows.find((item) => item.seq === seq);
				return { toArray: () => (row ? [({ seq, created_at: row.created_at } as T)] : []) };
			}
			if (/SELECT m\.seq\s+FROM loop_messages m/.test(sql)) {
				const sourceCompactionSeq = /m\.compacted_by = \?/.test(sql) ? Number(params[0]) : null;
				return { toArray: () => boundaryChildren(sourceCompactionSeq).map((seq) => ({ seq }) as T) };
			}
			if (/SELECT COUNT\(\*\) AS messageCount/.test(sql)) {
				const pageRows =
					/compacted_by IS NULL/.test(sql) || /m\.compacted_by IS NULL/.test(sql) ?
						activeRows()
					:	rowsForSource(Number(params[0]));
				const seqs = pageRows.map((row) => row.seq);
				return {
					one: () =>
						({
							messageCount: pageRows.length,
							fromSeq: seqs.length > 0 ? Math.min(...seqs) : null,
							toSeq: seqs.length > 0 ? Math.max(...seqs) : null,
						}) as T,
					toArray: () => [],
				};
			}
			if (/SELECT m\.seq, m\.position, m\.run_id/.test(sql)) {
				if (/WHERE\s+m\.compacted_by IS NULL/.test(sql)) {
					const after = /m\.seq > \?/.test(sql) ? Number(params[0]) : 0;
					return { toArray: () => activeRows(after) as T[] };
				}
				return { toArray: () => rowsForSource(Number(params[0])) as T[] };
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
}

export function memoryExistingLoopMessageSchemaSql() {
	const columnsByTable = new Map<string, string[]>([
		[
			"loop_messages",
			[
				"seq",
				"position",
				"run_id",
				"role",
				"message_json",
				"origin",
				"status",
				"token_estimate",
				"compacted_by",
				"created_at",
			],
		],
		["injections", ["id", "text", "kind", "source_id", "spotlight_id", "created_at", "consumed_at"]],
		[
			"inference_submissions",
			[
				"id",
				"event_seq",
				"run_id",
				"purpose",
				"model",
				"provider_base_url",
				"message_count",
				"messages_json",
				"display_messages_json",
				"created_at",
			],
		],
		["runtime_state", ["key", "value_json"]],
	]);
	const executedStatements: string[] = [];
	let loopMessagesVisibleIndexBeforeDeletedAt = false;
	return {
		columns: (table: string) => columnsByTable.get(table) ?? [],
		indexCreatedBeforeDeletedAt: () => loopMessagesVisibleIndexBeforeDeletedAt,
		statements: () => executedStatements,
		exec<T>(sql: string) {
			const normalized = sql.trim().replace(/\s+/g, " ");
			executedStatements.push(normalized);
			const tableInfo = /^PRAGMA table_info\(([^)]+)\)$/.exec(normalized);
			if (tableInfo) {
				const columns = columnsByTable.get(tableInfo[1] ?? "") ?? [];
				return {
					one: () => ({} as T),
					toArray: () => columns.map((name, cid) => ({ cid, name }) as T),
				};
			}
			const alterColumn = /^ALTER TABLE ([a-z_]+) ADD COLUMN ([a-z_]+)(?: |$)/.exec(normalized);
			if (alterColumn) {
				const table = alterColumn[1] ?? "";
				const column = alterColumn[2] ?? "";
				const columns = columnsByTable.get(table) ?? [];
				if (!columns.includes(column)) {
					columnsByTable.set(table, [...columns, column]);
				}
			}
			if (/^CREATE INDEX IF NOT EXISTS loop_messages_visible /.test(normalized)) {
				if (!columnsByTable.get("loop_messages")?.includes("deleted_at")) {
					loopMessagesVisibleIndexBeforeDeletedAt = true;
					throw new Error("loop_messages_visible index created before deleted_at exists");
				}
			}
			if (/SELECT COUNT\(\*\) AS count FROM loop_messages/.test(normalized)) {
				return {
					one: () => ({ count: 1 }) as T,
					toArray: () => [{ count: 1 } as T],
				};
			}
			if (/SELECT value_json FROM runtime_state WHERE key = \?/.test(normalized)) {
				return {
					one: () => ({} as T),
					toArray: () => [],
				};
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
}

export function testRuntimeForToolExecution(): BotRuntime {
	let seq = 0;
	const events: BotRuntimeEvent[] = [];
	return Object.assign(Object.create(BotRuntime.prototype), {
		env: {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			FORUM_COORDINATOR_SERVICE: {
				fetch: (request: Request) =>
					handleForumCoordinatorRequest(request, {
						BICKR_D1: testEnv.BICKR_D1,
						BICKR_KV: testEnv.BICKR_KV,
					}),
			},
		},
		state: {
			storage: {
				sql: memoryRuntimeSql(),
			},
		},
		events,
		appendEvent: async (runId: string, type: string, payload: unknown) => {
			seq += 1;
			const event = {
				seq,
				runId,
				type,
				payload,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			} as BotRuntimeEvent;
			events.push(event);
			return event;
		},
		throwIfStopped: (_runId: string, signal: AbortSignal) => {
			if (signal.aborted) {
				throw new Error("Unexpected abort.");
			}
		},
	}) as BotRuntime;
}

export function testLoopMessageMemory(initial: Array<Record<string, unknown>> = []) {
	let seq = 0;
	const messages = [...initial];
	return {
		activeLoopMessagesForProvider: () => [...messages],
		appendLoopMessage: (runId: string, message: Record<string, unknown>, origin: string, status = "complete") => {
			seq += 1;
			messages.push(message);
			return {
				seq,
				runId,
				role: message.role,
				message,
				origin,
				status,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			};
		},
	};
}

export function providerPromptEstimateForTokens(promptTokens: number) {
	return {
		promptTokens,
		source: "full_estimate",
		calibrationSampleCount: 0,
	};
}

export type RecordProviderUsageInputForTest = {
	contextWindowTokens: number;
	createdAt: string;
	providerName?: string;
	providerResponseId?: string;
	requestSeq: number;
	responseModel?: string;
	runId: string;
	settings: {
		apiKey?: string;
		baseUrl: string;
		model: string;
		temperature: number;
	};
	usage: ReturnType<typeof providerUsageForTest>;
};

export function providerUsageInputForTest(
	overrides: Partial<RecordProviderUsageInputForTest> = {},
): RecordProviderUsageInputForTest {
	return {
		contextWindowTokens: 16_000,
		createdAt: "2026-05-01T00:00:00.000Z",
		providerResponseId: "gen-test",
		requestSeq: 1,
		runId: "run-provider-usage",
		settings: {
			apiKey: "sk-or-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "requested/model",
			temperature: 0.2,
		},
		usage: providerUsageForTest(20),
		...overrides,
	};
}

export function capturingProviderUsageSql() {
	const inserts: unknown[][] = [];
	return {
		providerNames: () => inserts.map((params) => params[8] as string | null),
		exec<T>(sql: string, ...params: unknown[]) {
			if (/INSERT INTO provider_usage/.test(sql)) {
				inserts.push(params);
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
}

export function providerLoopUsageRowForTest(requestSeq: number, createdAt: string, promptTokens: number) {
	return {
		created_at: createdAt,
		run_id: "run-context-window",
		request_seq: requestSeq,
		model: "test-model",
		requested_model: "test-model",
		response_model: null,
		provider_name: null,
		context_window_tokens: 16_000,
		prompt_tokens: promptTokens,
		completion_tokens: 100,
		total_tokens: promptTokens + 100,
		cached_tokens: 0,
		reasoning_tokens: 0,
		cost: null,
	};
}

export function centralUsageRecordForTest(
	overrides: Pick<
		BotInferenceUsageRecord,
		"botId" | "ownerUserId" | "sourceUsageId" | "runId" | "requestSeq" | "createdAt" | "requestedModel" | "cost" | "exportedAt"
	> & Partial<BotInferenceUsageRecord>,
): BotInferenceUsageRecord {
	return {
		homeWorldId: "world-spend",
		homeWorldHandle: "spend-world",
		responseModel: null,
		model: overrides.requestedModel,
		contextWindowTokens: 16_000,
		providerBaseUrl: "https://provider.example.test",
		providerName: null,
		promptTokens: 100,
		completionTokens: 20,
		totalTokens: 120,
		cachedTokens: 0,
		reasoningTokens: 0,
		...overrides,
	};
}

export function providerResponseWithContent(content: string) {
	return {
		content,
		reasoning: "",
		reasoningDetails: [],
		toolCalls: [],
	};
}

export function providerResponseWithToolCall(id: string, name: string, args: Record<string, unknown>) {
	return providerResponseWithToolCalls([{ id, name, args }]);
}

export function providerResponseWithToolCalls(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
	return {
		content: "",
		reasoning: "",
		reasoningDetails: [],
		toolCalls: calls.map((call) => ({
			id: call.id,
			type: "function" as const,
			function: {
				name: call.name,
				arguments: JSON.stringify(providerToolArgsForTest(call.name, call.args)),
			},
		})),
	};
}

export function providerToolArgsForTest(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const text = (value: unknown): unknown => typeof value === "string" ? requiredLt(value) : value;
	switch (name) {
		case "create_thread":
			return { ...args, title: text(args.title), body: text(args.body) };
		case "reply_to_comment":
		case "make_additional_reply_to_the_same_comment":
			return { ...args, body: text(args.body) };
		case "vote":
		case "log_off":
			return { ...args, reason: text(args.reason) };
		case "follow_profile":
		case "unfollow_profile":
			return {
				...args,
				targets: Array.isArray(args.targets) ?
					args.targets.map((target) =>
						target && typeof target === "object" && !Array.isArray(target) ?
							{ ...target as Record<string, unknown>, reason: text((target as Record<string, unknown>).reason) }
						:	target,
					)
				:	args.targets,
			};
		default:
			return args;
	}
}

export function providerResponseWithRawToolCalls(calls: Array<{ id: string; name: string; arguments: string }>) {
	return {
		content: "",
		reasoning: "",
		reasoningDetails: [],
		toolCalls: calls.map((call) => ({
			id: call.id,
			type: "function" as const,
			function: {
				name: call.name,
				arguments: call.arguments,
			},
		})),
	};
}

export function providerUsageForTest(completionTokens: number, reasoningTokens = 0) {
	return {
		promptTokens: 10,
		completionTokens,
		totalTokens: 10 + completionTokens,
		cachedTokens: 0,
		reasoningTokens,
		cost: null,
		raw: {
			prompt_tokens: 10,
			completion_tokens: completionTokens,
			total_tokens: 10 + completionTokens,
			completion_tokens_details: { reasoning_tokens: reasoningTokens },
		},
	};
}

export function additionalReplyToolPresent(tools: ProviderToolDefinition[]): boolean {
	return tools.some((definition) =>
		definition.type === "function" && definition.function.name === "make_additional_reply_to_the_same_comment"
	);
}

export function fakeBotDocument(
	options: {
		allowEarlyLogOff?: boolean;
		compactionMaxCharacters?: number;
		compactionSummaryPercent?: number;
		contextWindowTokens?: number;
		displayName?: string | LocalizedText;
		handle?: string;
		homeWorldHandle?: string;
		homeWorldId?: string;
		id?: string;
		ownerUserId?: string;
		prompt?: string | LocalizedText;
		shortBio?: string | LocalizedText;
	} = {},
): BotDocument {
	const now = "2026-05-05T00:00:00.000Z";
	return {
		id: options.id ?? "bot_test_budget",
		type: "bot",
		schemaVersion: 1,
		revision: 1,
		createdAt: now,
		updatedAt: now,
		homeWorldId: options.homeWorldId ?? "wld_test",
		homeWorldHandle: options.homeWorldHandle ?? "test-world",
		ownerUserId: options.ownerUserId ?? "usr_test",
		handle: options.handle ?? "budget-bot",
		language: testLanguage,
		includeLanguageInSystemPrompt: false,
		displayName: typeof options.displayName === "string" ? lt(options.displayName) : options.displayName ?? lt("Budget Bot"),
		shortBio: typeof options.shortBio === "string" ? lt(options.shortBio) : options.shortBio ?? lt("Tests context budgets."),
		prompt: typeof options.prompt === "string" ? lt(options.prompt) : options.prompt ?? lt("Stay concise."),
		inferenceSettings: {},
		toolSettings: {},
		tickSettings: {
			enabled: true,
			intervalSeconds: 300,
			...(options.allowEarlyLogOff !== undefined ? { allowEarlyLogOff: options.allowEarlyLogOff } : {}),
			contextWindowTokens: options.contextWindowTokens ?? 16_000,
			compactionThreshold: 0.75,
			compactionSummaryPercent: options.compactionSummaryPercent ?? 10,
			compactionMaxCharacters: options.compactionMaxCharacters ?? 4_000,
			maxToolCallsPerTick: 3,
			maxSuccessfulToolCallsPerIteration: 8,
			maxGeneratedTokensPerTick: 15_000,
			maxGeneratedTokensPerIteration: 30_000,
		},
	};
}

export function loopMessageRowForTest(seq: number, runId: string, content: string) {
	return {
		seq,
		position: seq,
		run_id: runId,
		role: "assistant" as BotLoopMessage["role"],
		message_json: JSON.stringify({ role: "assistant", content }),
		origin: "provider_response" as BotLoopMessage["origin"],
		status: "complete",
		token_estimate: 1,
		stream_seq: null as number | null,
		display_event_seq: null as number | null,
		display_event_type: null as BotRuntimeEvent["type"] | null,
		display_event_payload_json: null as string | null,
		compacted_by: null as number | null,
		deleted_at: null as string | null,
		created_at: "2026-05-05T00:00:00.000Z",
		has_logs: 0,
	};
}

export function loopMessageRowForMessage(seq: number, message: Record<string, unknown>, origin: BotLoopMessage["origin"] = "provider_response") {
	return {
		seq,
		position: seq,
		run_id: "run-history-repair",
		role: message.role as BotLoopMessage["role"],
		message_json: JSON.stringify(message),
		origin,
		status: "complete",
		token_estimate: 1,
		stream_seq: null as number | null,
		display_event_seq: null as number | null,
		display_event_type: null as BotRuntimeEvent["type"] | null,
		display_event_payload_json: null as string | null,
		compacted_by: null,
		deleted_at: null as string | null,
		created_at: "2026-05-05T00:00:00.000Z",
		has_logs: 0,
	};
}

export function hasLoneSurrogate(value: unknown): boolean {
	if (typeof value === "string") {
		for (let index = 0; index < value.length; index += 1) {
			const code = value.charCodeAt(index);
			if (code >= 0xD800 && code <= 0xDBFF) {
				const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
				if (next >= 0xDC00 && next <= 0xDFFF) {
					index += 1;
					continue;
				}
				return true;
			}
			if (code >= 0xDC00 && code <= 0xDFFF) {
				return true;
			}
		}
		return false;
	}
	if (Array.isArray(value)) {
		return value.some(hasLoneSurrogate);
	}
	if (value && typeof value === "object") {
		return Object.values(value).some(hasLoneSurrogate);
	}
	return false;
}

export function messageListText(messages: Array<Record<string, unknown>>): string {
	return messages.map((message) => String(message.content ?? "")).join("\n");
}

export async function oauthFetchMock(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = requestUrl(input);
	if (url.includes("github.com/login/oauth/access_token")) {
		expect(init?.method).toBe("POST");
		return Response.json({
			access_token: "gho_mock",
			token_type: "bearer",
			scope: "read:user",
		});
	}

	if (url.includes("api.github.com/user")) {
		return Response.json({
			id: 1175142,
			login: "octocat",
			name: "Octo Cat",
			email: "octo@example.com",
			avatar_url: "https://example.com/octo.png",
		});
	}

	return new Response("Unexpected OAuth request", { status: 500 });
}

export function googleOauthFetchMock(
	overrides: Partial<{
		subject: string;
		email: string;
		name: string;
		avatarUrl: string;
		nonce: string;
	}> = {},
): typeof fetch {
	const profile = {
		subject: overrides.subject ?? "google-123",
		email: overrides.email ?? "google-octo@example.com",
		name: overrides.name ?? "Google Octo",
		avatarUrl: overrides.avatarUrl ?? "https://example.com/google-octo.png",
		nonce: overrides.nonce ?? "nonce-1",
	};
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = requestUrl(input);
		if (url.includes("/.well-known/openid-configuration")) {
			return Response.json({
				issuer: "https://accounts.google.com",
				authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
				token_endpoint: "https://oauth2.googleapis.com/token",
				userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
				jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
				response_types_supported: ["code"],
				subject_types_supported: ["public"],
				id_token_signing_alg_values_supported: ["RS256"],
			});
		}

		if (url.includes("oauth2.googleapis.com/token")) {
			expect(init?.method).toBe("POST");
			const params = requestBodyParams(init);
			expect(params.get("code_verifier")).toMatch(/^verifier-/);
			expect(params.get("access_type")).toBeNull();
			return Response.json({
				access_token: `google_access_${profile.subject}`,
				token_type: "bearer",
				scope: "openid email profile",
				id_token: googleIdToken({
					aud: "google-client",
					iss: "https://accounts.google.com",
					sub: profile.subject,
					email: profile.email,
					name: profile.name,
					picture: profile.avatarUrl,
					nonce: profile.nonce,
				}),
			});
		}

		if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
			return Response.json({
				sub: profile.subject,
				email: profile.email,
				email_verified: true,
				name: profile.name,
				picture: profile.avatarUrl,
			});
		}

		return new Response("Unexpected Google OAuth request", { status: 500 });
	}) as typeof fetch;
}

export function expectProviderPayloadToOmitKeys(value: unknown, forbiddenKeys: string[]): void {
	const forbidden = new Set(forbiddenKeys);
	const violations: string[] = [];
	const visit = (item: unknown, path: string): void => {
		if (Array.isArray(item)) {
			item.forEach((child, index) => visit(child, `${path}[${index}]`));
			return;
		}
		if (!item || typeof item !== "object") {
			return;
		}
		for (const [key, child] of Object.entries(item)) {
			const childPath = `${path}.${key}`;
			if (forbidden.has(key)) {
				violations.push(childPath);
			}
			visit(child, childPath);
		}
	};
	visit(value, "$");
	expect(violations).toEqual([]);
}

export function expectProviderPayloadToOmitIsoTimestamps(value: unknown): void {
	const violations: string[] = [];
	const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
	const visit = (item: unknown, path: string): void => {
		if (Array.isArray(item)) {
			item.forEach((child, index) => visit(child, `${path}[${index}]`));
			return;
		}
		if (!item || typeof item !== "object") {
			if (typeof item === "string" && isoTimestamp.test(item)) {
				violations.push(path);
			}
			return;
		}
		for (const [key, child] of Object.entries(item)) {
			visit(child, `${path}.${key}`);
		}
	};
	visit(value, "$");
	expect(violations).toEqual([]);
}

export function googleIdToken(claims: Record<string, unknown>): string {
	const now = Math.floor(Date.now() / 1000);
	return [
		base64UrlJson({ alg: "RS256", typ: "JWT" }),
		base64UrlJson({
			exp: now + 600,
			iat: now,
			...claims,
		}),
		"signature",
	].join(".");
}

export function base64UrlJson(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function requestBodyParams(init?: RequestInit): URLSearchParams {
	const body = init?.body;
	if (body instanceof URLSearchParams) {
		return body;
	}
	if (typeof body === "string") {
		return new URLSearchParams(body);
	}
	throw new Error("Expected URLSearchParams request body.");
}

export function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof Request) {
		return input.url;
	}
	return input.toString();
}
