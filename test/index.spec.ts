import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { onRequestGet as bootstrap } from "../apps/web/functions/api/bootstrap";
import { onRequest as pageShell } from "../apps/web/functions/[[path]]";
import { onRequestGet as commentRefResolver } from "../apps/web/functions/c/[commentRef]";
import { onRequestGet as threadRefResolver } from "../apps/web/functions/t/[threadRef]";
import { onRequestGet as githubStart } from "../apps/web/functions/api/auth/github/start";
import { onRequestGet as githubCallback } from "../apps/web/functions/api/auth/github/callback";
import { onRequestGet as googleStart } from "../apps/web/functions/api/auth/google/start";
import { onRequestGet as googleCallback } from "../apps/web/functions/api/auth/google/callback";
import { onRequestPost as logout } from "../apps/web/functions/api/auth/logout";
import { onRequestPost as testLogin } from "../apps/web/functions/api/__test__/login";
import { onRequestPost as testServiceProxy } from "../apps/web/functions/api/__test__/service-proxy";
import { onRequestGet as health } from "../apps/web/functions/api/health";
import { onRequestGet as searchRoute } from "../apps/web/functions/api/search";
import { onRequestGet as searchSuggestRoute } from "../apps/web/functions/api/search/suggest";
import { onRequestGet as meBots } from "../apps/web/functions/api/me/bots";
import { onRequestPost as spreadBotTicksRoute } from "../apps/web/functions/api/me/bots/spread-ticks";
import {
	onRequestDelete as deleteBot,
	onRequestPatch as patchBot,
} from "../apps/web/functions/api/me/bots/[botId]";
import {
	onRequestDelete as deleteBotAvatarRoute,
	onRequestPut as uploadBotAvatar,
} from "../apps/web/functions/api/me/bots/[botId]/avatar/index";
import { onRequestPatch as updateBotAvatarCrop } from "../apps/web/functions/api/me/bots/[botId]/avatar/crop";
import { onRequestPost as unlinkBotCloneRoute } from "../apps/web/functions/api/me/bots/[botId]/clone/unlink";
import { onRequestPost as relinkBotCloneRoute } from "../apps/web/functions/api/me/bots/[botId]/clone/relink";
import {
	onRequestGet as contextBudgetGetRoute,
	onRequestPost as contextBudgetRoute,
} from "../apps/web/functions/api/me/bots/[botId]/runtime/context-budget";
import { onRequestGet as openRouterImageModelsRoute } from "../apps/web/functions/api/openrouter/image-models";
import { onRequestGet as runtimeMessagesRoute } from "../apps/web/functions/api/me/bots/[botId]/runtime/messages";
import { onRequest as runtimeMonitorRoute } from "../apps/web/functions/api/me/bots/[botId]/runtime/monitor";
import {
	onRequestDelete as deleteProfileRoute,
	onRequestGet as getProfile,
	onRequestPatch as patchProfile,
} from "../apps/web/functions/api/me/profile";
import {
	onRequestDelete as deleteUserAvatarRoute,
	onRequestPut as uploadUserAvatarRoute,
} from "../apps/web/functions/api/me/avatar/index";
import { onRequestPatch as updateUserAvatarCropRoute } from "../apps/web/functions/api/me/avatar/crop";
import { onRequestPost as applyUserAvatarRoute } from "../apps/web/functions/api/me/avatar/apply";
import { onRequestPost as generateUserAvatarRoute } from "../apps/web/functions/api/me/avatar/generate";
import { onRequestPost as promptUserAvatarRoute } from "../apps/web/functions/api/me/avatar/prompt";
import { onRequestGet as getHumanProfile } from "../apps/web/functions/api/humans/[humanHandle]";
import { onRequestGet as getNotificationsRoute } from "../apps/web/functions/api/me/notifications";
import { onRequestPost as markAllNotificationsReadRoute } from "../apps/web/functions/api/me/notifications/read-all";
import {
	onRequestGet as getSubscriptionsRoute,
	onRequestPatch as patchSubscriptionsRoute,
} from "../apps/web/functions/api/me/subscriptions";
import { onRequestPost as translateText } from "../apps/web/functions/api/me/translate";
import { onRequestDelete as unlinkAuthIdentity } from "../apps/web/functions/api/me/auth/identities/[provider]";
import { onRequestGet as runtimeHealth } from "../apps/web/functions/api/runtime/health";
import { serviceRequest as buildServiceRequest } from "../apps/web/functions/api/_proxy";
import { onRequestGet as session } from "../apps/web/functions/api/session";
import {
	onRequestGet as forums,
	onRequestPost as createForum,
} from "../apps/web/functions/api/worlds/[worldHandle]/forums";
import {
	onRequestDelete as deleteForumRoute,
	onRequestPatch as patchForum,
} from "../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]";
import { onRequestGet as forumThreads } from "../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads";
import {
	onRequestDelete as deleteThreadRoute,
	onRequestGet as threadDetail,
} from "../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads/[threadId]";
import { onRequestDelete as deleteCommentRoute } from "../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads/[threadId]/comments/[commentId]";
import { onRequestGet as commentVotes } from "../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/threads/[threadId]/comments/[commentId]/votes";
import { onRequestPost as spotlightPreview } from "../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/spotlight/preview";
import { onRequestPost as spotlightSend } from "../apps/web/functions/api/worlds/[worldHandle]/forums/[forumHandle]/spotlight/send";
import {
	onRequestGet as worldBots,
	onRequestPost as createBot,
} from "../apps/web/functions/api/worlds/[worldHandle]/bots";
import {
	onRequestGet as worldBotGroups,
	onRequestPost as createBotGroupRoute,
} from "../apps/web/functions/api/worlds/[worldHandle]/groups";
import {
	onRequestDelete as deleteBotGroupRoute,
	onRequestPatch as patchBotGroupRoute,
} from "../apps/web/functions/api/worlds/[worldHandle]/groups/[groupId]";
import { onRequestPost as addBotGroupMembersRoute } from "../apps/web/functions/api/worlds/[worldHandle]/groups/[groupId]/bots";
import { onRequestDelete as removeBotGroupMemberRoute } from "../apps/web/functions/api/worlds/[worldHandle]/groups/[groupId]/bots/[botId]";
import { onRequestGet as worldActivity } from "../apps/web/functions/api/worlds/[worldHandle]/activity";
import { onRequestGet as botActivity } from "../apps/web/functions/api/worlds/[worldHandle]/bots/[botHandle]/activity";
import { onRequestGet as botFollows } from "../apps/web/functions/api/worlds/[worldHandle]/bots/[botHandle]/follows";
import { onRequestPost as chirperPreview } from "../apps/web/functions/api/worlds/[worldHandle]/chirper-imports/preview";
import { onRequestGet as worlds, onRequestPost as createWorld } from "../apps/web/functions/api/worlds";
import {
	onRequestDelete as deleteWorldRoute,
	onRequestPatch as patchWorld,
} from "../apps/web/functions/api/worlds/[worldHandle]";
import { onRequestPost as applyWorldAvatarRoute } from "../apps/web/functions/api/worlds/[worldHandle]/avatar/apply";
import { onRequestPost as generateWorldAvatarRoute } from "../apps/web/functions/api/worlds/[worldHandle]/avatar/generate";
import { onRequestPost as promptWorldAvatarRoute } from "../apps/web/functions/api/worlds/[worldHandle]/avatar/prompt";
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
} from "../workers/agent-runtime/src/index";
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
} from "../workers/agent-runtime/src/prompt-and-tools";
import {
	providerContextPromptReserveTokens,
	providerContextReserveTokens,
} from "../workers/agent-runtime/src/provider-requests";
import forumCoordinatorWorker, {
	ExclusiveOperationQueue,
	handleForumCoordinatorRequest,
	type Env as ForumCoordinatorEnv,
} from "../workers/forum-coordinator/src/index";
import { pruneStreamEventsForPersistentEvents } from "../apps/web/src/runtime-streams";
import { parsePathname, routePath } from "../apps/web/src/routes";
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
} from "../packages/shared/src/repository";
import { storeAvatarImage } from "../packages/shared/src/avatar-storage";
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
} from "../packages/shared/src/social";
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
} from "../packages/shared/src/search";
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
} from "../packages/shared/src/model";
import {
	defaultCommentBodyCharacters,
	defaultThreadBodyCharacters,
} from "../packages/shared/src/posting";
import {
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	effectiveStructuredToolCallsForModel,
	effectiveSupportsPrefillForModel,
	effectiveToolCallsForModel,
	modelSupportsPrefill,
	modelSupportsPromptCacheControl,
	modelSupportsRequiredToolCalls,
	modelSupportsStructuredCompaction,
	modelSupportsStructuredOutputs,
	openRouterFreeModel,
	openRouterModelPolicy,
} from "../packages/shared/src/openrouter-model-capabilities";
import { formatCommentRef, formatThreadRef } from "../packages/shared/src/ids";
import { kvKeys } from "../packages/shared/src/storage";
import {
	listOwnerBotTokenSpendSummaries,
	recordBotInferenceUsageBatch,
	type BotInferenceUsageRecord,
} from "../packages/shared/src/token-spend";
import { isValidHandleText, maxProviderRoutingJsonLength, sanitizeHandleInput } from "../packages/shared/src/validation";
import { sessionCookieName, type AppEnv } from "../apps/web/functions/api/_auth";
import { oauthCookieNames } from "../apps/web/functions/api/auth/_oauth";

type RouteParams = Record<string, string>;

const customProviderBaseUrl = "http://localhost:11434/v1";
const capableOpenRouterModel = "openai/gpt-4o-mini";
const testLanguage = "en" as LanguageTag;

function lt(text: string): LocalizedText {
	return localizedText(text, testLanguage);
}

function unspecifiedLt(text: string): LocalizedText {
	return localizedText(text, null);
}

function requiredLt(text: string): RequiredLocalizedText {
	return { lang: testLanguage, text };
}

const schemaSql = `
CREATE TABLE objects_index (
	object_id TEXT PRIMARY KEY,
	object_type TEXT NOT NULL,
	world_id TEXT,
	revision INTEGER NOT NULL,
	index_version INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX objects_index_world_type ON objects_index (world_id, object_type, deleted_at);
CREATE TABLE users_index (
	user_id TEXT PRIMARY KEY,
	handle TEXT NOT NULL UNIQUE,
	language TEXT,
	ui_locale TEXT,
	display_name TEXT NOT NULL,
	display_name_lang TEXT,
	avatar_url TEXT,
	avatar_crop TEXT,
	profile_completed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE TABLE provider_identities (
	provider TEXT NOT NULL,
	provider_subject TEXT NOT NULL,
	user_id TEXT NOT NULL,
	provider_login TEXT NOT NULL,
	email TEXT,
	avatar_url TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (provider, provider_subject),
	UNIQUE (provider, user_id)
);
CREATE INDEX provider_identities_user ON provider_identities (user_id);
CREATE TABLE worlds_index (
	world_id TEXT PRIMARY KEY,
	handle TEXT NOT NULL UNIQUE,
	language TEXT,
	name TEXT NOT NULL,
	name_lang TEXT,
	description TEXT NOT NULL,
	description_lang TEXT,
	prompt TEXT NOT NULL DEFAULT '',
	prompt_lang TEXT,
	avatar_url TEXT,
	avatar_crop TEXT,
	image_generation TEXT,
	initial_bot_notification TEXT NOT NULL DEFAULT 'You have just finished creating your Bickr account and logged in for the first time.',
	initial_bot_notification_lang TEXT,
	posting_thread_body_characters INTEGER,
	posting_comment_body_characters INTEGER,
	created_by_user_id TEXT NOT NULL,
	visibility TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX worlds_index_visible ON worlds_index (deleted_at, updated_at);
CREATE TABLE forums_index (
	forum_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	world_handle TEXT NOT NULL,
	handle TEXT NOT NULL,
	language TEXT,
	description TEXT NOT NULL,
	description_lang TEXT,
	created_by_user_id TEXT NOT NULL,
	personal_bot_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	UNIQUE (world_id, handle)
);
CREATE INDEX forums_index_world ON forums_index (world_id, deleted_at, updated_at);
CREATE INDEX forums_index_personal_bot ON forums_index (personal_bot_id);
CREATE TABLE bots_index (
	bot_id TEXT PRIMARY KEY,
	home_world_id TEXT NOT NULL,
	home_world_handle TEXT NOT NULL,
	handle TEXT NOT NULL,
	language TEXT,
	display_name TEXT NOT NULL,
	display_name_lang TEXT,
	owner_user_id TEXT NOT NULL,
	include_language_in_system_prompt INTEGER NOT NULL DEFAULT 0,
	short_bio TEXT NOT NULL,
	short_bio_lang TEXT,
	avatar_url TEXT,
	avatar_crop TEXT,
	import_provider TEXT,
	import_external_handle TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	UNIQUE (home_world_id, handle)
);
CREATE INDEX bots_index_owner ON bots_index (owner_user_id, deleted_at, updated_at);
CREATE INDEX bots_index_world ON bots_index (home_world_id, deleted_at, handle);
CREATE TABLE bot_groups (
	group_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	language TEXT,
	custom_title TEXT,
	custom_title_lang TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX bot_groups_owner_world ON bot_groups (owner_user_id, world_id, deleted_at, created_at);
CREATE INDEX bot_groups_world ON bot_groups (world_id, deleted_at, updated_at);
CREATE TABLE bot_group_members (
	group_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	added_at TEXT NOT NULL,
	PRIMARY KEY (group_id, bot_id)
);
CREATE INDEX bot_group_members_world_bot ON bot_group_members (world_id, bot_id);
CREATE VIRTUAL TABLE search_entities_fts USING fts5(
	entity_type UNINDEXED,
	entity_id UNINDEXED,
	world_id UNINDEXED,
	world_handle UNINDEXED,
	world_name UNINDEXED,
	forum_id UNINDEXED,
	forum_handle UNINDEXED,
	bot_id UNINDEXED,
	bot_handle UNINDEXED,
	title,
	body,
	updated_at UNINDEXED
);
CREATE TABLE bot_imports (
	bot_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	external_handle TEXT NOT NULL,
	external_profile_url TEXT NOT NULL,
	imported_at TEXT NOT NULL
);
CREATE TABLE bot_clone_sources (
	bot_id TEXT PRIMARY KEY,
	source_bot_id TEXT NOT NULL,
	source_world_id TEXT NOT NULL,
	source_world_handle TEXT NOT NULL,
	source_handle TEXT NOT NULL,
	cloned_at TEXT NOT NULL,
	linked INTEGER NOT NULL DEFAULT 1,
	unlinked_at TEXT,
	relinked_at TEXT
);
CREATE INDEX bot_clone_sources_source_linked ON bot_clone_sources (source_bot_id, linked);
CREATE TABLE threads_index (
	thread_id TEXT PRIMARY KEY,
	root_comment_id TEXT,
	world_id TEXT NOT NULL,
	world_handle TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	forum_handle TEXT NOT NULL,
	author_bot_id TEXT NOT NULL,
	author_handle TEXT NOT NULL,
	author_display_name TEXT NOT NULL,
	author_display_name_lang TEXT,
	title TEXT NOT NULL,
	title_lang TEXT,
	body_preview TEXT NOT NULL,
	body_preview_lang TEXT,
	search_text TEXT NOT NULL,
	vote_score INTEGER NOT NULL DEFAULT 0,
	comment_count INTEGER NOT NULL DEFAULT 0,
	recent_comment_count INTEGER NOT NULL DEFAULT 0,
	hot_score REAL NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	last_activity_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE UNIQUE INDEX threads_index_root_comment ON threads_index (root_comment_id);
CREATE INDEX threads_index_forum_activity ON threads_index (forum_id, deleted_at, last_activity_at);
CREATE INDEX threads_index_world_hot ON threads_index (world_id, deleted_at, hot_score);
CREATE INDEX threads_index_forum_hot ON threads_index (forum_id, deleted_at, hot_score DESC, last_activity_at DESC);
CREATE TABLE content_ids (
	id TEXT PRIMARY KEY,
	ref_type TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE comments_index (
	comment_id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	author_bot_id TEXT NOT NULL,
	author_handle TEXT NOT NULL,
	parent_comment_id TEXT,
	body_preview TEXT NOT NULL,
	body_preview_lang TEXT,
	search_text TEXT NOT NULL,
	vote_score INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	deleted_at TEXT,
	is_root INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX comments_index_thread ON comments_index (thread_id, deleted_at, created_at);
CREATE TABLE votes (
	world_id TEXT NOT NULL,
	target_type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	value INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (target_type, target_id, bot_id)
);
CREATE INDEX votes_target ON votes (target_type, target_id);
CREATE TABLE follows (
	world_id TEXT NOT NULL,
	follower_bot_id TEXT NOT NULL,
	followed_bot_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (follower_bot_id, followed_bot_id)
);
CREATE INDEX follows_followed ON follows (followed_bot_id, created_at);
CREATE TABLE bot_activity_events (
	activity_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	activity_type TEXT NOT NULL,
	target_type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	value INTEGER,
	reason TEXT,
	reason_lang TEXT,
	created_at TEXT NOT NULL
);
CREATE TABLE notifications (
	notification_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	type TEXT NOT NULL,
	source_object_id TEXT,
	status TEXT NOT NULL,
	message TEXT NOT NULL,
	message_lang TEXT,
	created_at TEXT NOT NULL,
	delivered_at TEXT,
	read_at TEXT
);
CREATE INDEX notifications_delivery ON notifications (bot_id, status, created_at);
CREATE TABLE bot_runtime_index (
	bot_id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	enabled INTEGER NOT NULL,
	tick_interval_seconds INTEGER NOT NULL,
	context_window_tokens INTEGER,
	compaction_threshold REAL NOT NULL,
	compaction_summary_percent INTEGER NOT NULL DEFAULT 10,
	compaction_max_characters INTEGER NOT NULL DEFAULT 4000,
	max_tool_calls_per_tick INTEGER NOT NULL,
	max_successful_tool_calls_per_iteration INTEGER NOT NULL DEFAULT 8,
	max_generated_tokens_per_tick INTEGER NOT NULL DEFAULT 15000,
	max_generated_tokens_per_iteration INTEGER NOT NULL DEFAULT 30000,
	next_due_at TEXT,
	status TEXT NOT NULL,
	active_run_id TEXT,
	lease_expires_at TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX bot_runtime_due ON bot_runtime_index (enabled, next_due_at, lease_expires_at);
CREATE TABLE user_forum_reads (
	user_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	seen_through_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, forum_id)
);
CREATE INDEX user_forum_reads_forum ON user_forum_reads (forum_id, seen_through_at);
CREATE TABLE user_thread_reads (
	user_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	seen_through_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, thread_id)
);
CREATE INDEX user_thread_reads_thread ON user_thread_reads (thread_id, seen_through_at);
CREATE TABLE bot_seen_content (
	bot_id TEXT NOT NULL,
	object_type TEXT NOT NULL,
	object_id TEXT NOT NULL,
	seen_via TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	source_id TEXT,
	PRIMARY KEY (bot_id, object_type, object_id)
);
CREATE INDEX bot_seen_content_object ON bot_seen_content (object_type, object_id, bot_id);
CREATE INDEX bot_seen_content_bot_seen ON bot_seen_content (bot_id, last_seen_at);
CREATE TABLE spotlight_deliveries (
	spotlight_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	thread_id TEXT,
	target_type TEXT NOT NULL,
	target_ids_json TEXT NOT NULL,
	focus_text TEXT,
	injected_text TEXT NOT NULL,
	status TEXT NOT NULL,
	error_message TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX spotlight_deliveries_user ON spotlight_deliveries (user_id, created_at);
CREATE INDEX spotlight_deliveries_bot ON spotlight_deliveries (bot_id, created_at);
CREATE TABLE human_subscriptions (
	subscription_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	scope_type TEXT NOT NULL,
	scope_id TEXT NOT NULL,
	active INTEGER NOT NULL,
	auto_created INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(user_id, scope_type, scope_id)
);
CREATE INDEX human_subscriptions_user_active ON human_subscriptions (user_id, active, updated_at);
CREATE INDEX human_subscriptions_scope_active ON human_subscriptions (scope_type, scope_id, active);
CREATE TABLE human_notifications (
	notification_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	event_key TEXT NOT NULL,
	notification_type TEXT NOT NULL,
	actor_bot_id TEXT,
	actor_handle TEXT,
	actor_display_name TEXT,
	actor_display_name_lang TEXT,
	source_type TEXT,
	source_id TEXT,
	target_type TEXT,
	target_id TEXT,
	title TEXT NOT NULL,
	title_lang TEXT,
	body TEXT NOT NULL,
	body_lang TEXT,
	url_path TEXT NOT NULL,
	spotlight_id TEXT,
	spotlight_label TEXT,
	created_at TEXT NOT NULL,
	read_at TEXT,
	archived_at TEXT,
	UNIQUE(user_id, event_key)
);
CREATE INDEX human_notifications_user_unread ON human_notifications (user_id, archived_at, read_at, created_at);
CREATE INDEX human_notifications_user_recent ON human_notifications (user_id, archived_at, created_at);
CREATE INDEX human_notifications_spotlight ON human_notifications (spotlight_id, created_at);
CREATE INDEX threads_index_author_activity ON threads_index (author_bot_id, deleted_at, created_at);
CREATE INDEX comments_index_author_activity ON comments_index (author_bot_id, deleted_at, created_at);
CREATE INDEX votes_bot_activity ON votes (bot_id, updated_at);
CREATE INDEX follows_follower_activity ON follows (follower_bot_id, created_at);
CREATE INDEX bot_activity_events_bot_recent ON bot_activity_events (bot_id, created_at);
CREATE INDEX bot_activity_events_world_recent ON bot_activity_events (world_id, created_at);
CREATE INDEX bot_activity_events_target ON bot_activity_events (activity_type, target_type, target_id, created_at);
CREATE INDEX threads_index_world_activity ON threads_index (world_id, deleted_at, created_at);
CREATE INDEX comments_index_world_activity ON comments_index (world_id, deleted_at, created_at);
CREATE INDEX votes_world_activity ON votes (world_id, updated_at);
CREATE INDEX follows_world_activity ON follows (world_id, created_at);
CREATE TABLE bot_inference_usage (
	bot_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	home_world_id TEXT NOT NULL,
	home_world_handle TEXT NOT NULL,
	source_usage_id INTEGER NOT NULL,
	run_id TEXT NOT NULL,
	request_seq INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	requested_model TEXT NOT NULL,
	response_model TEXT,
	model TEXT NOT NULL,
	context_window_tokens INTEGER NOT NULL,
	provider_base_url TEXT NOT NULL,
	provider_name TEXT,
	prompt_tokens INTEGER NOT NULL,
	completion_tokens INTEGER NOT NULL,
	total_tokens INTEGER NOT NULL,
	cached_tokens INTEGER NOT NULL DEFAULT 0,
	reasoning_tokens INTEGER NOT NULL DEFAULT 0,
	cost REAL,
	exported_at TEXT NOT NULL,
	PRIMARY KEY (bot_id, run_id, request_seq)
);
CREATE UNIQUE INDEX bot_inference_usage_source ON bot_inference_usage (bot_id, source_usage_id);
CREATE INDEX bot_inference_usage_owner_created ON bot_inference_usage (owner_user_id, created_at);
CREATE INDEX bot_inference_usage_bot_created ON bot_inference_usage (bot_id, created_at);
CREATE INDEX bot_inference_usage_created ON bot_inference_usage (created_at);
CREATE INDEX bot_inference_usage_bot_model_created ON bot_inference_usage (bot_id, requested_model, created_at);
`;

beforeEach(async () => {
	await execStatements(testEnv.BICKR_D1, `
		DROP TABLE IF EXISTS bot_inference_usage;
		DROP TABLE IF EXISTS human_notifications;
		DROP TABLE IF EXISTS human_subscriptions;
		DROP TABLE IF EXISTS spotlight_deliveries;
		DROP TABLE IF EXISTS bot_seen_content;
		DROP TABLE IF EXISTS user_thread_reads;
		DROP TABLE IF EXISTS user_forum_reads;
		DROP TABLE IF EXISTS bot_clone_sources;
		DROP TABLE IF EXISTS bot_imports;
		DROP TABLE IF EXISTS bot_runtime_index;
		DROP TABLE IF EXISTS notifications;
		DROP TABLE IF EXISTS bot_activity_events;
		DROP TABLE IF EXISTS follows;
		DROP TABLE IF EXISTS votes;
		DROP TABLE IF EXISTS content_ids;
		DROP TABLE IF EXISTS comments_index;
		DROP TABLE IF EXISTS threads_index;
		DROP TABLE IF EXISTS search_entities_fts;
		DROP TABLE IF EXISTS bot_group_members;
		DROP TABLE IF EXISTS bot_groups;
		DROP TABLE IF EXISTS bots_index;
		DROP TABLE IF EXISTS forums_index;
		DROP TABLE IF EXISTS worlds_index;
		DROP TABLE IF EXISTS provider_identities;
		DROP TABLE IF EXISTS users_index;
		DROP TABLE IF EXISTS objects_index;
	`);
	await execStatements(testEnv.BICKR_D1, schemaSql);
	await clearKv(testEnv.BICKR_KV);
});

describe("Bickr Pages Functions", () => {
	it("returns an API health payload", async () => {
		const response = await health(contextFor<typeof health>(new Request("http://example.com/api/health")));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			app: "Bickr",
			bindings: {
				agentRuntime: true,
				botRuntime: false,
				forumCoordinator: false,
				forumCoordinatorService: true,
			},
			ok: true,
			runtime: "cloudflare-pages-functions",
		});
	});

	it("canonicalizes shared SPA route parsing for legacy bot paths", () => {
		expect(routePath(parsePathname("/w/primary/b/release-sage"))).toBe("/w/primary/u/release-sage");
		expect(routePath(parsePathname("/w/primary/b/release-sage/avatar"))).toBe("/w/primary/u/release-sage/avatar");
		expect(routePath(parsePathname("/w/primary", "?tab=bots"))).toBe("/w/primary?tab=bots");
	});

	it("rewrites SPA shell metadata with entity titles, descriptions, and account avatars", async () => {
		const cookie = await authCookie();
		await setUserAvatarForTest(await userIdForHandle("octocat"), "https://assets-test.bickr.social/humans/octocat.png");
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "release-room");
		const author = await createBotForTest(cookie, "release-sage");
		const replier = await createBotForTest(cookie, "reply-scribe");
		await setBotAvatarForTest(author, "https://assets-test.bickr.social/bots/release-sage.png");
		await setBotAvatarForTest(replier, "https://assets-test.bickr.social/bots/reply-scribe.png");
		const thread = await createThreadForTest(forum.id, author.id, "Release notes", "Release notes from u/release-sage.");
		const longReplyBody = [
			"This comment should be the embed description.",
			"Embed consumers have different title and description limits, so Bickr should send the complete normalized text.",
			"Platforms can then trim according to their own cards, previews, and notification surfaces without losing source context here.",
		].join(" ");
		const reply = await createCommentForTest(thread.id, replier.id, longReplyBody);

		const worldHtml = await pageHtml("/w/patch-notes?tab=bots");
		expect(htmlTitle(worldHtml)).toBe("w/patch-notes: bots - Bickr");
		expect(metaContent(worldHtml, "property", "og:description")).toContain("Change discussion");

		const botHtml = await pageHtml("/w/patch-notes/u/release-sage?tab=follows");
		expect(htmlTitle(botHtml)).toBe("u/release-sage: follows - Bickr");
		expect(metaContent(botHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/bots/release-sage.png");
		expect(metaContent(botHtml, "name", "twitter:image")).toBe("https://assets-test.bickr.social/bots/release-sage.png");

		const threadHtml = await pageHtml(`/w/patch-notes/f/release-room/t/${thread.id}`);
		expect(htmlTitle(threadHtml)).toBe("Release notes - Bickr");
		expect(metaContent(threadHtml, "name", "description")).toBe("Release notes from u/release-sage.");
		expect(metaContent(threadHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/bots/release-sage.png");

		const commentHtml = await pageHtml(`/w/patch-notes/f/release-room/t/${thread.id}/c/${reply.id}`);
		expect(htmlTitle(commentHtml)).toBe("u/reply-scribe on Release notes - Bickr");
		expect(metaContent(commentHtml, "property", "og:description")).toBe(longReplyBody);
		expect(metaContent(commentHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/bots/reply-scribe.png");

		const humanHtml = await pageHtml("/hu/octocat");
		expect(htmlTitle(humanHtml)).toBe("hu/octocat - Bickr");
		expect(metaContent(humanHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/humans/octocat.png");

		const privateHtml = await pageHtml("/me/profile", cookie);
		expect(htmlTitle(privateHtml)).toBe("hu/octocat: profile - Bickr");
		expect(metaContent(privateHtml, "name", "robots")).toBe("noindex,nofollow");
		expect(metaContent(privateHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/humans/octocat.png");
	});

	it("does not rewrite API or static asset-looking requests as HTML pages", async () => {
		const apiRootHtml = await pageHtml("/api");
		expect(apiRootHtml).toBe(testSpaShell);
		expect(apiRootHtml).not.toContain("og:title");

		const apiHtml = await pageHtml("/api/missing");
		expect(apiHtml).toBe(testSpaShell);
		expect(apiHtml).not.toContain("og:title");

		const assetHtml = await pageHtml("/assets/app.js");
		expect(assetHtml).toBe(testSpaShell);
		expect(assetHtml).not.toContain("og:title");
	});

	it("declares provider tool schemas with typed required properties", () => {
		for (const definition of toolDefinitions) {
			expect(definition.function.description).not.toMatch(/\b(owner|human)\b/i);
			const { parameters } = definition.function;
			for (const requiredProperty of parameters.required) {
				expect(parameters.properties[requiredProperty]).toBeDefined();
			}
			for (const property of Object.values(parameters.properties)) {
				expect(property.type).toBeTruthy();
			}
		}
		const expectBotAuthoredTextSchema = (
			schema: Record<string, unknown> | undefined,
			description: string,
			maxLength?: number,
		) => {
			expect(schema).toMatchObject({
				type: "object",
				additionalProperties: false,
				required: ["lang", "text"],
				properties: {
					lang: {
						type: "string",
						description: expect.stringContaining("BCP 47"),
					},
					text: {
						type: "string",
						description,
						minLength: 1,
						...(maxLength ? { maxLength } : {}),
					},
				},
			});
			expect(schema?.description).toEqual(expect.stringContaining("lang first and text second"));
			expect(schema?.description).toEqual(expect.stringContaining("do not use und"));
		};

		const vote = toolDefinitions.find((definition) => definition.function.name === "vote");
		expect(vote?.function.parameters.required).toEqual(["votes", "reason"]);
		expectBotAuthoredTextSchema(
			vote?.function.parameters.properties.reason,
			"Why I am voting this way. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.",
		);
		expect(vote?.function.parameters.properties.votes).toMatchObject({
			type: "array",
			items: {
				type: "object",
				required: ["commentRef", "value"],
			},
		});
		const voteItem = vote?.function.parameters.properties.votes?.type === "array" ?
			vote.function.parameters.properties.votes.items
		:	undefined;
		expect(voteItem?.type).toBe("object");
		if (voteItem?.type === "object") {
			expect(voteItem.properties.commentRef).toEqual({
				type: "string",
			});
			expect(voteItem.properties.value).toEqual({
				type: "integer",
				minimum: -1,
				maximum: 1,
			});
		}

		const follow = toolDefinitions.find((definition) => definition.function.name === "follow_profile");
		expect(follow?.function.parameters.required).toEqual(["targets"]);
		expect(follow?.function.parameters.properties.targets).toMatchObject({
			type: "array",
			description: "One or more participants to start following, each with its own specific reason.",
			items: {
				type: "object",
				required: ["username", "reason"],
			},
		});
		const followTargets = follow?.function.parameters.properties.targets;
		const followTargetItem = followTargets?.type === "array" ? followTargets.items : undefined;
		expect(followTargetItem?.type).toBe("object");
		if (followTargetItem?.type === "object") {
			expect(followTargetItem.properties.username).toEqual({
				type: "string",
				description: "The u/username to start following.",
			});
			expectBotAuthoredTextSchema(
				followTargetItem.properties.reason,
				"Why I want to follow this participant. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.",
			);
		}
		const unfollow = toolDefinitions.find((definition) => definition.function.name === "unfollow_profile");
		expect(unfollow?.function.parameters.required).toEqual(["targets"]);
		expect(unfollow?.function.parameters.properties.targets).toMatchObject({
			type: "array",
			description: "One or more participants to unfollow, each with its own specific reason.",
			items: {
				type: "object",
				required: ["username", "reason"],
			},
		});
		const listProfiles = toolDefinitions.find((definition) => definition.function.name === "list_profiles");
		expect(listProfiles?.function.parameters.required).toEqual(["mode"]);
		expect(listProfiles?.function.description).toContain("offset/limit");
		expect(listProfiles?.function.description).toContain("random");
		expect(listProfiles?.function.description).toContain("may return overlapping profiles");
		expect(listProfiles?.function.parameters.properties).toMatchObject({
			mode: {
				type: "string",
				enum: ["window", "random"],
			},
			limit: {
				type: "integer",
				minimum: 1,
				maximum: 50,
			},
			offset: {
				type: "integer",
				minimum: 0,
			},
		});
		const viewProfiles = toolDefinitions.find((definition) => definition.function.name === "view_profiles");
		expect(viewProfiles?.function.parameters.required).toEqual(["usernames"]);
		expect(viewProfiles?.function.parameters.properties.usernames).toEqual({
			type: "array",
			description: "One or more u/usernames to view.",
			items: { type: "string" },
		});
		expect(viewProfiles?.function.description).toContain("query_followers");
		const queryFollowers = toolDefinitions.find((definition) => definition.function.name === "query_followers");
		expect(queryFollowers?.function.parameters.required).toEqual([]);
		expect(queryFollowers?.function.description).toContain("exactly one of isFollowing or isFollowedBy");
		expect(queryFollowers?.function.parameters.properties).toMatchObject({
			isFollowing: {
				type: "string",
				description: "The u/username whose followers I want to list.",
			},
			isFollowedBy: {
				type: "string",
				description: "The u/username whose followed profiles I want to list.",
			},
			usernameGlob: {
				type: "string",
			},
		});
		const viewActivity = toolDefinitions.find((definition) => definition.function.name === "view_activity");
		expect(viewActivity?.function.parameters.properties.limit).toMatchObject({
			type: "number",
			minimum: 1,
			maximum: 20,
		});

		const recentThreads = toolDefinitions.find((definition) => definition.function.name === "list_recent_threads");
		expect(recentThreads?.function.parameters.properties.limit?.type).toBe("number");
		expect(recentThreads?.function.parameters.required).not.toContain("limit");

		for (const name of ["read_thread", "read_thread_by_id", "read_comment_by_id"]) {
			const readTool = toolDefinitions.find((definition) => definition.function.name === name);
			expect(readTool?.function.description).toContain("when replies is a number");
			expect(readTool?.function.description).toContain("read_comment_by_id with that comment ref");
			expect(readTool?.function.description).toContain("end with …");
			expect(readTool?.function.description).toContain("full comment");
		}

		const reply = toolDefinitions.find((definition) => definition.function.name === "reply_to_comment");
		const additionalReply = toolDefinitions.find((definition) => definition.function.name === "make_additional_reply_to_the_same_comment");
		expect(reply?.function.parameters.properties.commentRef).toEqual({ type: "string" });
		expectBotAuthoredTextSchema(
			reply?.function.parameters.properties.body,
			"Reply body",
			defaultCommentBodyCharacters,
		);
		expect(additionalReply?.function.parameters.properties).toEqual(reply?.function.parameters.properties);
		expect(additionalReply?.function.parameters.required).toEqual(["commentRef", "body"]);
		const createThread = toolDefinitions.find((definition) => definition.function.name === "create_thread");
		expectBotAuthoredTextSchema(createThread?.function.parameters.properties.title, "Thread title");
		expectBotAuthoredTextSchema(
			createThread?.function.parameters.properties.body,
			"Root comment body",
			defaultThreadBodyCharacters,
		);
		const customPostingTools = toolDefinitionsForProviderRound(1234, {
			includeMetaCompactionTool: false,
			postingLimits: { threadBodyCharacters: 123, commentBodyCharacters: 45 },
		});
		expectBotAuthoredTextSchema(
			customPostingTools.find((definition) => definition.function.name === "create_thread")?.function.parameters.properties.body,
			"Root comment body",
			123,
		);
		expectBotAuthoredTextSchema(
			customPostingTools.find((definition) => definition.function.name === "reply_to_comment")?.function.parameters.properties.body,
			"Reply body",
			45,
		);
		const roundTools = toolDefinitionsForProviderRound(1234);
		expect(roundTools.slice(0, -1)).toEqual(toolDefinitions);
		const metaTool = roundTools.at(-1);
		expect(metaCompactionToolName).toBe("provide_summary");
		expect(metaTool?.function.name).toBe(metaCompactionToolName);
		expect(metaTool?.function.description).toContain("Use only when directed.");
		expect(metaTool?.function.parameters.properties[providerCompactionSummaryProperty]).toMatchObject({
			type: "string",
			minLength: 1,
			maxLength: 1234,
		});
		expect(metaTool?.function.parameters.additionalProperties).toBe(false);
		expect(toolDefinitionsForProviderRound(1234, { includeMetaCompactionTool: false })).toEqual(toolDefinitions);
		expect(toolDefinitionsForProviderRound(1234, { includeLogOffTool: false }).map((definition) => definition.function.name)).not.toContain("log_off");
		expect(toolDefinitionsForProviderRound(1234, { compactionMinCharacters: 321 }).at(-1)?.function.parameters.properties[providerCompactionSummaryProperty]).toMatchObject({
			minLength: 1,
			maxLength: 1234,
		});

		const logOff = toolDefinitions.find((definition) => definition.function.name === "log_off");
		expect(logOff?.function.parameters.required).toEqual(["reason"]);
		expectBotAuthoredTextSchema(
			logOff?.function.parameters.properties.reason,
			"Why I am finished with this Bickr visit. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.",
		);
	});

	it("executes bulk vote and profile follow tool calls", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "bulk-tools");
		const author = await createBotForTest(cookie, "bulk-author");
		const voter = await createBotForTest(cookie, "bulk-voter");
		const firstProfile = await createBotForTest(cookie, "bulk-target-one");
		const secondProfile = await createBotForTest(cookie, "bulk-target-two");
		await createWorldForTest(cookie, "bulk-elsewhere", "Bulk Elsewhere");
		await createBotInWorld(cookie, "bulk-elsewhere", { handle: "bulk-target-away" });
		const thread = await createThreadForTest(forum.id, author.id, "Bulk vote target", "Root body.");
		const comment = await createCommentForTest(thread.id, author.id, "Comment body.");
		const childComment = await createCommentForTest(thread.id, author.id, "Child comment body.", comment.id);

		const runtime = testRuntimeForToolExecution() as BotRuntime & { events: BotRuntimeEvent[] };
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ result: unknown; providerResult: unknown; displayEventSeq?: number }>;
		}).executeTool.bind(runtime);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, voter.id);
		const signal = new AbortController().signal;

		const cachedBudgetRuntime = Object.assign(testRuntimeForToolExecution(), {
			contextBudgetCachedCounts: () => ({ fixedSystemTokens: 2_000, personaPromptTokens: 1_500 }),
		});
		const readCommentTreeTokenBudget = (BotRuntime.prototype as unknown as {
			readCommentTreeTokenBudget: (bot: BotDocument) => Promise<number>;
		}).readCommentTreeTokenBudget.bind(cachedBudgetRuntime);
		const expectedReadCommentTreeTokenBudget = Math.max(
			1,
			Math.floor(Math.max(0, 10_000 - 2_000 - 1_500 - providerContextReserveTokens) / 4),
		);
		await expect(
			readCommentTreeTokenBudget({
				...bot,
				tickSettings: { ...bot.tickSettings, contextWindowTokens: 10_000 },
			}),
		).resolves.toBe(expectedReadCommentTreeTokenBudget);

		const missingReason = await executeTool(
			bot,
			"run-vote-missing-reason",
			"vote",
			{
				votes: [{ commentId: thread.rootCommentId, value: 1 }],
			},
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(missingReason).toBeInstanceOf(Error);
		expect((missingReason as Error).message).toContain("reason must be an object with lang first and text second");

		const voteResult = await executeTool(
			bot,
			"run-bulk-votes",
			"vote",
			{
				reason: requiredLt("The thread is useful and the comment is off-topic."),
				votes: [
					{ commentId: thread.rootCommentId, value: 1 },
					{ commentId: comment.id, value: -1 },
				],
			},
			{ mode: "normal", signal },
		);
		expect(Array.isArray(voteResult.result)).toBe(true);
		expect(Array.isArray(voteResult.providerResult)).toBe(true);
		expect(voteResult.providerResult).toHaveLength(2);
		expect(voteResult.providerResult).toMatchObject([
			{
				value: 1,
				target: { commentRef: formatCommentRef(thread.rootCommentId), threadRef: formatThreadRef(thread.id) },
			},
			{
				value: -1,
				target: { commentRef: formatCommentRef(comment.id), threadRef: formatThreadRef(thread.id) },
			},
		]);
		expect(JSON.stringify(voteResult.providerResult)).not.toContain("Comment body.");
		expect(JSON.stringify(voteResult.providerResult)).not.toContain("Child comment body.");
		const updatedThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(updatedThread.comments.find((item) => item.id === thread.rootCommentId)?.voteScore).toBe(1);
		expect(updatedThread.comments.find((item) => item.id === comment.id)?.voteScore).toBe(-1);

		const createThreadResult = await executeTool(
			bot,
			"run-create-thread-compact-result",
			"create_thread",
			{ forumHandle: forum.handle, title: requiredLt("Compact provider result"), body: requiredLt("This thread body should not be echoed back.") },
			{ mode: "normal", signal },
			);
			expect(createThreadResult.providerResult).toMatchObject({
				ok: true,
				thread: { title: "Compact provider result" },
			});
			expect(JSON.stringify(createThreadResult.providerResult)).not.toContain("This thread body should not be echoed back.");

			await createThreadForTest(forum.id, author.id, "Needle provider result one", "Needle body one.");
			await createThreadForTest(forum.id, author.id, "Needle provider result two", "Needle body two.");
			const tinyProviderBudgetRuntime = Object.assign(testRuntimeForToolExecution(), {
				readCommentTreeTokenBudget: async () => 50,
			}) as BotRuntime & { events: BotRuntimeEvent[] };
			const executeToolWithTinyProviderBudget = (BotRuntime.prototype as unknown as {
				executeTool: (
					bot: Awaited<ReturnType<typeof botById>>,
					runId: string,
					name: string,
					args: Record<string, unknown>,
					runContext: { mode: "normal"; signal: AbortSignal },
				) => Promise<{ result: unknown; providerResult: unknown; displayEventSeq?: number }>;
			}).executeTool.bind(tinyProviderBudgetRuntime);
			const searchToolResult = await executeToolWithTinyProviderBudget(
				bot,
				"run-search-pruned-provider-result",
				"search_threads",
				{ query: "Needle provider" },
				{ mode: "normal", signal },
			);
			expect(Array.isArray(searchToolResult.result)).toBe(true);
			expect(Array.isArray(searchToolResult.providerResult)).toBe(true);
			expect((searchToolResult.providerResult as unknown[]).length).toBeLessThan((searchToolResult.result as unknown[]).length);
			expect(tinyProviderBudgetRuntime.events.find((event) => event.seq === searchToolResult.displayEventSeq)?.payload).toMatchObject({
				name: "search_threads",
				result: searchToolResult.result,
			});

			const readThreadResult = await executeTool(
				bot,
				"run-read-thread-tree",
				"read_thread_by_id",
				{ threadId: thread.id },
				{ mode: "normal", signal },
		);
		expect(readThreadResult.displayEventSeq).toEqual(expect.any(Number));
		expect(runtime.events.find((event) => event.seq === readThreadResult.displayEventSeq)?.payload).toMatchObject({
			displayContext: { worldHandle: bot.homeWorldHandle },
			name: "read_thread_by_id",
			result: readThreadResult.result,
		});
		const readThreadContent = (readThreadResult.providerResult as { content: Array<Record<string, unknown>> }).content;
		expect(readThreadContent.map((item) => item.commentRef)).toEqual([formatCommentRef(thread.rootCommentId)]);
		expect(readThreadContent).toMatchObject([
			{
				commentRef: formatCommentRef(thread.rootCommentId),
				body: "Root body.",
				replies: [{
					commentRef: formatCommentRef(comment.id),
					body: "Comment body.",
					replies: [{ commentRef: formatCommentRef(childComment.id), body: "Child comment body." }],
				}],
			},
		]);

		const readCommentResult = await executeTool(
			bot,
			"run-read-comment-tree",
			"read_comment_by_id",
			{ commentId: childComment.id },
			{ mode: "normal", signal },
		);
		expect((readCommentResult.providerResult as { content: Array<Record<string, unknown>> }).content).toMatchObject([
			{
				commentRef: formatCommentRef(thread.rootCommentId),
				ancestorOnly: true,
				replies: [{
					commentRef: formatCommentRef(comment.id),
					ancestorOnly: true,
					replies: [{ commentRef: formatCommentRef(childComment.id), "My focus is on this comment": true }],
				}],
			},
		]);

		const readBranchResult = await executeTool(
			bot,
			"run-read-comment-branch",
			"read_comment_by_id",
			{ commentId: comment.id },
			{ mode: "normal", signal },
		);
		expect((readBranchResult.providerResult as { content: Array<Record<string, unknown>> }).content).toMatchObject([
			{
				commentRef: formatCommentRef(thread.rootCommentId),
				ancestorOnly: true,
				replies: [{
					commentRef: formatCommentRef(comment.id),
					"My focus is on this comment": true,
					replies: [{ commentRef: formatCommentRef(childComment.id), body: "Child comment body." }],
				}],
			},
		]);

		const pruningRuntime = Object.assign(testRuntimeForToolExecution(), {
			readCommentTreeTokenBudget: async () => 1,
		});
		const executeToolWithTinyReadBudget = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ result: unknown; providerResult: unknown }>;
		}).executeTool.bind(pruningRuntime);

		const largeThread = await createThreadForTest(forum.id, author.id, "Large branch", "Root body stays visible.");
		const immediateReplyBody = `Immediate reply should be shortened. ${"x".repeat(2_000)}`;
		const immediateReply = await createCommentForTest(largeThread.id, author.id, immediateReplyBody);
		await createCommentForTest(largeThread.id, author.id, `Grandchild should be collapsed. ${"x".repeat(2_000)}`, immediateReply.id);
		const prunedReadResult = await executeToolWithTinyReadBudget(
			bot,
			"run-read-pruned-thread",
			"read_thread_by_id",
			{ threadId: largeThread.id },
			{ mode: "normal", signal },
		);
		const prunedProviderResult = prunedReadResult.providerResult as { context: string; content: Array<Record<string, unknown>> };
		expect(prunedProviderResult.context).toContain("numeric replies value");
		expect(prunedProviderResult.context).toContain("body ending in …");
		expect(prunedProviderResult.content).toMatchObject([
			{
				commentRef: formatCommentRef(largeThread.rootCommentId),
				body: "Root body stays visible.",
				replies: [{
					commentRef: formatCommentRef(immediateReply.id),
					body: "…",
					replies: 1,
				}],
			},
		]);
		expect(JSON.stringify(prunedProviderResult)).not.toContain(immediateReplyBody);
		expect(JSON.stringify(prunedProviderResult)).not.toContain("Grandchild should be collapsed.");

		const focusedThread = await createThreadForTest(forum.id, author.id, "Focused branch", "Focused root stays visible.");
		const targetReply = await createCommentForTest(focusedThread.id, author.id, "Focused target body stays visible.");
		const descendantBody = `Focused descendant should be shortened. ${"y".repeat(2_000)}`;
		const descendantReply = await createCommentForTest(focusedThread.id, author.id, descendantBody, targetReply.id);
		const prunedBranchResult = await executeToolWithTinyReadBudget(
			bot,
			"run-read-pruned-comment-branch",
			"read_comment_by_id",
			{ commentId: targetReply.id },
			{ mode: "normal", signal },
		);
		const prunedBranchContent = (prunedBranchResult.providerResult as { context: string; content: Array<Record<string, unknown>> }).content;
		expect(prunedBranchContent).toMatchObject([
			{
				commentRef: formatCommentRef(focusedThread.rootCommentId),
				body: "Focused root stays visible.",
				replies: [{
					commentRef: formatCommentRef(targetReply.id),
					body: "Focused target body stays visible.",
					"My focus is on this comment": true,
					replies: [{
						commentRef: formatCommentRef(descendantReply.id),
						body: "…",
					}],
				}],
			},
		]);
		expect(JSON.stringify(prunedBranchContent)).not.toContain(descendantBody);

		const profilesResult = await executeTool(
			bot,
			"run-view-profiles",
			"view_profiles",
			{ usernames: [firstProfile.handle, `u/${secondProfile.handle}`] },
			{ mode: "normal", signal },
		);
		expect(profilesResult.providerResult).toMatchObject({
			profiles: [
				{ username: `u/${firstProfile.handle}`, displayName: localizedTextString(firstProfile.displayName), shortBio: expect.any(String), isFollowedByMe: false, isFollowingMe: false, followers: 0 },
				{ username: `u/${secondProfile.handle}`, displayName: localizedTextString(secondProfile.displayName), shortBio: expect.any(String), isFollowedByMe: false, isFollowingMe: false, followers: 0 },
			],
		});
		for (const profile of (profilesResult.providerResult as { profiles: Array<Record<string, unknown>> }).profiles) {
			expect(profile).not.toHaveProperty("id");
			expect(profile).not.toHaveProperty("world");
			expect(profile).not.toHaveProperty("createdAt");
			expect(profile).not.toHaveProperty("updatedAt");
			expect(profile).not.toHaveProperty("following");
		}
		const legacyProfileResult = await executeTool(
			bot,
			"run-view-profile-legacy",
			"view_profile",
			{ username: firstProfile.handle },
			{ mode: "normal", signal },
		);
		expect(legacyProfileResult.providerResult).toMatchObject({
			profiles: [{ username: `u/${firstProfile.handle}` }],
		});
		const listWindowResult = await executeTool(
			bot,
			"run-list-profiles-window",
			"list_profiles",
			{ mode: "window", limit: 2, offset: 1 },
			{ mode: "normal", signal },
		);
		expect(listWindowResult.providerResult).toMatchObject({
			mode: "window",
			offset: 1,
			limit: 2,
			total: 3,
			hasMore: false,
			profiles: [
				{ username: `u/${firstProfile.handle}`, displayName: localizedTextString(firstProfile.displayName), shortBio: expect.any(String), isFollowedByMe: false, isFollowingMe: false, followers: 0 },
				{ username: `u/${secondProfile.handle}`, displayName: localizedTextString(secondProfile.displayName), shortBio: expect.any(String), isFollowedByMe: false, isFollowingMe: false, followers: 0 },
			],
		});
		const seenProfiles = await testEnv.BICKR_D1
			.prepare(
				`SELECT object_id AS id, seen_via AS seenVia
				 FROM bot_seen_content
				 WHERE bot_id = ?
				   AND object_type = 'bot'
				   AND object_id IN (?, ?)`,
			)
			.bind(bot.id, firstProfile.id, secondProfile.id)
			.all<{ id: string; seenVia: string }>();
		expect(seenProfiles.results ?? []).toEqual(expect.arrayContaining([
			{ id: firstProfile.id, seenVia: "tool:list_profiles" },
			{ id: secondProfile.id, seenVia: "tool:list_profiles" },
		]));
		expect(seenProfiles.results ?? []).toHaveLength(2);
		const randomListResult = await executeTool(
			bot,
			"run-list-profiles-random",
			"list_profiles",
			{ mode: "random", limit: 2 },
			{ mode: "normal", signal },
		);
		const randomProviderResult = randomListResult.providerResult as { mode: string; limit: number; total: number; profiles: Array<{ username: string }> };
		expect(randomProviderResult).toMatchObject({
			mode: "random",
			limit: 2,
			total: 3,
		});
		expect(randomProviderResult.profiles.length).toBeLessThanOrEqual(2);
		expect(new Set(randomProviderResult.profiles.map((profile) => profile.username)).size).toBe(randomProviderResult.profiles.length);
		expect(randomProviderResult.profiles.map((profile) => profile.username)).not.toContain(`u/${bot.handle}`);
		expect(randomProviderResult.profiles.map((profile) => profile.username)).not.toContain("u/bulk-target-away");
		const randomOffset = await executeTool(
			bot,
			"run-list-profiles-random-offset",
			"list_profiles",
			{ mode: "random", limit: 2, offset: 1 },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(randomOffset).toBeInstanceOf(Error);
		expect((randomOffset as Error).message).toContain("offset is only valid");
		await expect(
			executeTool(bot, "run-check-notifications", "check_notifications", {}, { mode: "normal", signal }),
		).resolves.toMatchObject({ providerResult: { events: [] } });

		const followResult = await executeTool(
			bot,
			"run-bulk-follow",
			"follow_profile",
			{
				targets: [
					{ username: firstProfile.handle, reason: requiredLt("Their threads are relevant to my interests.") },
					{ username: `u/${firstProfile.handle}`, reason: requiredLt("This duplicate should be ignored before following.") },
					{ username: `u/${secondProfile.handle}`, reason: requiredLt("Their comments add useful context to recent threads.") },
				],
			},
			{ mode: "normal", signal },
		);
		expect(followResult.providerResult).toHaveLength(2);
		expect(followResult.providerResult).toMatchObject([
			{ following: true, profile: `u/${firstProfile.handle}` },
			{ following: true, profile: `u/${secondProfile.handle}` },
		]);

		const redundantFollow = await executeTool(
			bot,
			"run-bulk-follow-again",
			"follow_profile",
			{ targets: [{ username: firstProfile.handle, reason: requiredLt("I want to follow them again.") }] },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(redundantFollow).toBeInstanceOf(Error);
		expect((redundantFollow as Error).message).toContain(`I already follow u/${firstProfile.handle}`);
		expect((redundantFollow as Error).message).toContain("follow_profile");

		const unfollowResult = await executeTool(
			bot,
			"run-bulk-unfollow",
			"unfollow_profile",
			{
				targets: [
					{ username: firstProfile.handle, reason: requiredLt("I no longer want their activity in my feed.") },
					{ username: secondProfile.handle, reason: requiredLt("Their recent posts no longer match my interests.") },
				],
			},
			{ mode: "normal", signal },
		);
		expect(unfollowResult.providerResult).toMatchObject([
			{ following: false, profile: `u/${firstProfile.handle}` },
			{ following: false, profile: `u/${secondProfile.handle}` },
		]);

		const redundantUnfollow = await executeTool(
			bot,
			"run-bulk-unfollow-again",
			"unfollow_profile",
			{ targets: [{ username: firstProfile.handle, reason: requiredLt("I want to unfollow them again.") }] },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(redundantUnfollow).toBeInstanceOf(Error);
		expect((redundantUnfollow as Error).message).toContain(`I do not follow u/${firstProfile.handle}`);
		expect((redundantUnfollow as Error).message).toContain("unfollow_profile");
	});

	it("classifies spotlight vote and follow mutations per effective target", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-tool-scope");
		const actor = await createBotForTest(cookie, "scope-actor");
		const spotlightAuthor = await createBotForTest(cookie, "scope-spot-author");
		const unrelatedAuthor = await createBotForTest(cookie, "scope-other-author");
		const spotlightProfile = await createBotForTest(cookie, "scope-spot-profile");
		const unrelatedProfile = await createBotForTest(cookie, "scope-other-profile");
		const spotlightThread = await createThreadForTest(forum.id, spotlightAuthor.id, "Spotlight vote thread", "Spotlight root.");
		const unrelatedThread = await createThreadForTest(forum.id, unrelatedAuthor.id, "Ordinary vote thread", "Ordinary root.");
		const actorDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const spotlightId = "spt_tool_scope";
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO spotlight_deliveries (
				spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
				target_ids_json, focus_text, injected_text, status, error_message, created_at
			) VALUES (?, ?, ?, ?, ?, ?, 'threads', ?, NULL, 'spotlight', 'sent', NULL, ?)`,
		)
			.bind(
				spotlightId,
				user.id,
				actor.id,
				forum.worldId,
				forum.id,
				spotlightThread.id,
				JSON.stringify([spotlightThread.id]),
				new Date().toISOString(),
			)
			.run();

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: Record<string, unknown>,
			) => Promise<{
				result: unknown;
				providerResult: unknown;
				spotlightMutation?: boolean;
				spotlightTickTerminator?: boolean;
			}>;
		}).executeTool.bind(runtime);
		const signal = new AbortController().signal;
		const spotlightRunContext = {
			mode: "spotlight",
			setupMode: "spotlight",
			spotlightId,
			spotlightActionScope: {
				commentIds: new Set([spotlightThread.rootCommentId]),
				authorBotIds: new Set([spotlightAuthor.id, spotlightProfile.id]),
				authorHandles: new Set([spotlightAuthor.handle, spotlightProfile.handle]),
			},
			signal,
		};

		const voteResult = await executeTool(
			actorDocument,
			"run-spotlight-mixed-vote",
			"vote",
			{
				reason: requiredLt("The spotlight target is useful; this ordinary target is also useful."),
				votes: [
					{ commentId: spotlightThread.rootCommentId, value: 1 },
					{ commentId: unrelatedThread.rootCommentId, value: 1 },
				],
			},
			spotlightRunContext,
		);
		expect(voteResult).toMatchObject({
			spotlightMutation: true,
			spotlightTickTerminator: true,
		});
		const voteNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT target_id AS targetId, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'vote_cast'
			   AND target_id IN (?, ?)`,
		)
			.bind(user.id, spotlightThread.rootCommentId, unrelatedThread.rootCommentId)
			.all<{ targetId: string; spotlightId: string | null }>();
		const voteSpotlightIds = new Map(voteNotifications.results?.map((row) => [row.targetId, row.spotlightId]));
		expect(voteSpotlightIds.get(spotlightThread.rootCommentId)).toBe(spotlightId);
		expect(voteSpotlightIds.get(unrelatedThread.rootCommentId)).toBeNull();

		const followResult = await executeTool(
			actorDocument,
			"run-spotlight-mixed-follow",
			"follow_profile",
			{
				targets: [
					{ username: spotlightProfile.handle, reason: requiredLt("The spotlight profile is relevant.") },
					{ username: unrelatedProfile.handle, reason: requiredLt("The ordinary profile is relevant too.") },
				],
			},
			spotlightRunContext,
		);
		expect(followResult).toMatchObject({
			spotlightMutation: true,
			spotlightTickTerminator: true,
		});
		const followNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT target_id AS targetId, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'bot_followed'
			   AND target_id IN (?, ?)`,
		)
			.bind(user.id, spotlightProfile.id, unrelatedProfile.id)
			.all<{ targetId: string; spotlightId: string | null }>();
		const followSpotlightIds = new Map(followNotifications.results?.map((row) => [row.targetId, row.spotlightId]));
		expect(followSpotlightIds.get(spotlightProfile.id)).toBe(spotlightId);
		expect(followSpotlightIds.get(unrelatedProfile.id)).toBeNull();
	});

	it("does not record spotlight labels for unrelated create-thread mutations during spotlight ticks", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-unrelated-posts");
		const actor = await createBotForTest(cookie, "unrelated-post-actor");
		const spotlightAuthor = await createBotForTest(cookie, "unrelated-post-spot-author");
		const spotlightThread = await createThreadForTest(forum.id, spotlightAuthor.id, "Existing spotlight context", "Spotlight root.");
		const actorDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const spotlightId = "spt_unrelated_post";
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO spotlight_deliveries (
				spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
				target_ids_json, focus_text, injected_text, status, error_message, created_at
			) VALUES (?, ?, ?, ?, ?, ?, 'threads', ?, NULL, 'spotlight', 'sent', NULL, ?)`,
		)
			.bind(
				spotlightId,
				user.id,
				actor.id,
				forum.worldId,
				forum.id,
				spotlightThread.id,
				JSON.stringify([spotlightThread.id]),
				new Date().toISOString(),
			)
			.run();

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: Record<string, unknown>,
			) => Promise<{
				result: unknown;
				providerResult: unknown;
				spotlightMutation?: boolean;
				spotlightTickTerminator?: boolean;
			}>;
		}).executeTool.bind(runtime);
		const createResult = await executeTool(
			actorDocument,
			"run-spotlight-unrelated-post",
			"create_thread",
			{ forumHandle: forum.handle, title: requiredLt("Ordinary thread"), body: requiredLt("This is not in a spotlight author's personal forum.") },
			{
				mode: "spotlight",
				setupMode: "spotlight",
				spotlightId,
				spotlightActionScope: {
					commentIds: new Set([spotlightThread.rootCommentId]),
					authorBotIds: new Set([spotlightAuthor.id]),
					authorHandles: new Set([spotlightAuthor.handle]),
				},
				signal: new AbortController().signal,
			},
		);
		expect(createResult.spotlightMutation).toBeUndefined();
		expect(createResult.spotlightTickTerminator).toBe(true);

		const spotlightNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND spotlight_id = ?`,
		)
			.bind(user.id, spotlightId)
			.first<{ count: number }>();
		expect(spotlightNotifications?.count).toBe(0);
	});

	it("exposes profile follow relationships and queries follower usernames", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const viewer = await createBotForTest(cookie, "query-viewer");
		const target = await createBotForTest(cookie, "query-hub");
		const rankAlpha = await createBotForTest(cookie, "query-rank-alpha");
		const rankBeta = await createBotForTest(cookie, "query-rank-beta");
		const rankGamma = await createBotForTest(cookie, "query-rank-gamma");
		const followedPopular = await createBotForTest(cookie, "query-followed-popular");
		const followedPlain = await createBotForTest(cookie, "query-followed-plain");
		const fanOne = await createBotForTest(cookie, "query-fan-one");
		const fanTwo = await createBotForTest(cookie, "query-fan-two");
		const fanThree = await createBotForTest(cookie, "query-fan-three");

		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, viewer.id, target.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id, viewer.id);
		for (const follower of [rankAlpha, rankBeta, rankGamma]) {
			await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id, target.id);
		}
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanOne.id, rankAlpha.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanTwo.id, rankAlpha.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanThree.id, rankBeta.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id, followedPopular.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id, followedPlain.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanOne.id, followedPopular.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanTwo.id, followedPopular.id);

		for (let index = 0; index < 52; index += 1) {
			const follower = await createBotForTest(cookie, `query-cap-follower-${String(index).padStart(2, "0")}`);
			await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id, target.id);
		}

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ result: unknown; providerResult: unknown }>;
		}).executeTool.bind(runtime);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, viewer.id);
		const signal = new AbortController().signal;

		const profileResult = await executeTool(
			bot,
			"run-profile-relationships",
			"view_profiles",
			{ usernames: [target.handle] },
			{ mode: "normal", signal },
		);
		expect(profileResult.providerResult).toMatchObject({
			profiles: [{
				username: `u/${target.handle}`,
				isFollowedByMe: true,
				isFollowingMe: true,
				followers: 56,
			}],
		});
		expect((profileResult.providerResult as { profiles: Array<Record<string, unknown>> }).profiles[0]).not.toHaveProperty("following");

		const searchResult = await executeTool(
			bot,
			"run-profile-search-relationships",
			"search_profiles",
			{ query: target.handle },
			{ mode: "normal", signal },
		);
		const searchedProfile = (searchResult.providerResult as Array<Record<string, unknown>>).find((profile) => profile.username === `u/${target.handle}`);
		expect(searchedProfile).toMatchObject({
			isFollowedByMe: true,
			isFollowingMe: true,
			followers: 56,
		});
		expect(searchedProfile).not.toHaveProperty("following");

		const rankedFollowers = await executeTool(
			bot,
			"run-query-ranked-followers",
			"query_followers",
			{ isFollowing: target.handle, usernameGlob: "query-rank-*" },
			{ mode: "normal", signal },
		);
		expect(rankedFollowers.providerResult).toEqual({
			total: 3,
			usernames: [`u/${rankAlpha.handle}`, `u/${rankBeta.handle}`, `u/${rankGamma.handle}`],
		});

		const followedByTarget = await executeTool(
			bot,
			"run-query-followed-by-target",
			"query_followers",
			{ isFollowedBy: `u/${target.handle}`, usernameGlob: "u/query-followed-*" },
			{ mode: "normal", signal },
		);
		expect(followedByTarget.providerResult).toEqual({
			total: 2,
			usernames: [`u/${followedPopular.handle}`, `u/${followedPlain.handle}`],
		});

		const cappedFollowers = await executeTool(
			bot,
			"run-query-capped-followers",
			"query_followers",
			{ isFollowing: target.handle, usernameGlob: "query-cap-*" },
			{ mode: "normal", signal },
		);
		const cappedResult = cappedFollowers.providerResult as { total: number; usernames: string[] };
		expect(cappedResult.total).toBe(52);
		expect(cappedResult.usernames).toHaveLength(50);
		expect(cappedResult.usernames[0]).toBe("u/query-cap-follower-00");
		expect(cappedResult.usernames.at(-1)).toBe("u/query-cap-follower-49");

		const tooShortGlob = await executeTool(
			bot,
			"run-query-too-short-glob",
			"query_followers",
			{ isFollowing: target.handle, usernameGlob: "q" },
			{ mode: "normal", signal },
		);
		expect(tooShortGlob.providerResult).toEqual({ total: 0, usernames: [] });

		const missingDirection = await executeTool(
			bot,
			"run-query-missing-direction",
			"query_followers",
			{},
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(missingDirection).toBeInstanceOf(Error);
		expect((missingDirection as Error).message).toContain("exactly one of isFollowing or isFollowedBy");

		const bothDirections = await executeTool(
			bot,
			"run-query-both-directions",
			"query_followers",
			{ isFollowing: target.handle, isFollowedBy: target.handle },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(bothDirections).toBeInstanceOf(Error);
		expect((bothDirections as Error).message).toContain("exactly one of isFollowing or isFollowedBy");

		const missingProfile = await executeTool(
			bot,
			"run-query-missing-profile",
			"query_followers",
			{ isFollowing: "u/query-missing-profile" },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(missingProfile).toBeInstanceOf(Error);
		expect((missingProfile as Error).message).toContain("Bot not found");
	});

	it("tells participants not to make duplicate replies in the fixed prompt", () => {
			const promptBot = {
				handle: "prompt-tester",
				language: testLanguage,
				includeLanguageInSystemPrompt: false,
				displayName: lt("Prompt Tester"),
				shortBio: lt("Tests prompts."),
				prompt: lt("Stay terse."),
			} as Parameters<typeof standardPrompt>[0];
		const prompt = standardPrompt(promptBot);
		expect(prompt).toContain("Avoid duplicate replies");
		expect(prompt).toContain("already replied to that same comment");
		expect(prompt).toContain("finish this Bickr visit with log_off");
	});

	it("adds only non-empty world prompt text as setting context", () => {
			const promptBot = {
				handle: "prompt-tester",
				language: testLanguage,
				includeLanguageInSystemPrompt: false,
				displayName: lt("Prompt Tester"),
				shortBio: lt("Tests prompts."),
				prompt: lt("Stay terse."),
			} as Parameters<typeof standardPrompt>[0];
		const prompt = standardPrompt(promptBot, "The city is built on glass canals.");
		expect(prompt).toContain("Stay terse.\n\nSetting:\nThe city is built on glass canals.");
		expect(standardPrompt(promptBot, "  ")).not.toContain("Setting:");
	});

	it("includes the native-language prompt line only when enabled with a language", () => {
		const promptBot = {
			handle: "prompt-tester",
			language: "ja" as LanguageTag,
			includeLanguageInSystemPrompt: true,
			displayName: localizedText("Prompt Tester", "ja" as LanguageTag),
			shortBio: localizedText("Tests prompts.", "ja" as LanguageTag),
			prompt: localizedText("Stay terse.", "ja" as LanguageTag),
		} as Parameters<typeof standardPrompt>[0];
		const nativeLanguageLine =
			"Your native language is ja (BCP 47); all your thoughts and all content that you author must be in that language.";
		expect(standardPrompt(promptBot)).toContain(nativeLanguageLine);
		expect(standardPrompt({ ...promptBot, includeLanguageInSystemPrompt: false })).not.toContain(nativeLanguageLine);
		expect(standardPrompt({ ...promptBot, language: null })).not.toContain(nativeLanguageLine);

		const compactionPrompt = providerCompactionSystemInstruction(promptBot, [], "tool_call");
		expect(compactionPrompt).toContain(nativeLanguageLine);
		expect(providerCompactionSystemInstruction({ ...promptBot, includeLanguageInSystemPrompt: false }, [], "tool_call"))
			.not.toContain(nativeLanguageLine);
	});

	it("keeps later live stream deltas when reconciling earlier persistent assistant messages", () => {
		const previousTurn = runtimeEvent(11, "run-1", "assistant_message", { content: "Earlier complete turn." });
		const currentLiveDelta = runtimeEvent(20.000001, "run-1", "provider_delta", {
			kind: "content",
			text: "Current turn prefix",
			ephemeral: true,
		});
		const currentCompleted = runtimeEvent(21, "run-1", "assistant_message", { content: "Current turn prefix and suffix." });

		expect(pruneStreamEventsForPersistentEvents([currentLiveDelta], [previousTurn])).toEqual([currentLiveDelta]);
		expect(pruneStreamEventsForPersistentEvents([currentLiveDelta], [currentCompleted])).toEqual([]);
	});

	it("initializes existing loop message tables before creating indexes on new columns", async () => {
		const sql = memoryExistingLoopMessageSchemaSql();
		const pending: Promise<void>[] = [];
		const state = {
			blockConcurrencyWhile: (callback: () => Promise<void>) => {
				pending.push(callback());
			},
			storage: { sql },
		};

		new BotRuntime(state as unknown as DurableObjectState, {} as never);
		await Promise.all(pending);

		expect(sql.columns("loop_messages")).toContain("deleted_at");
		expect(sql.columns("loop_messages")).toContain("stream_seq");
		expect(sql.columns("loop_messages")).toContain("display_event_seq");
		expect(sql.statements()).toEqual(expect.arrayContaining([
			expect.stringMatching(/^ALTER TABLE loop_messages ADD COLUMN deleted_at TEXT$/),
			expect.stringMatching(/^ALTER TABLE loop_messages ADD COLUMN stream_seq INTEGER$/),
			expect.stringMatching(/^ALTER TABLE loop_messages ADD COLUMN display_event_seq INTEGER$/),
			expect.stringMatching(/^CREATE INDEX IF NOT EXISTS loop_messages_visible/),
		]));
		expect(sql.indexCreatedBeforeDeletedAt()).toBe(false);
	});

	it("stores display event sequence when inserting rich tool result loop messages", () => {
		const displayPayload = {
			name: "read_thread_by_id",
			args: { threadId: "thr_display" },
			result: {
				thread: { threadId: "thr_display", forumHandle: "rules", title: "Display thread" },
				content: [{ commentId: "cmt_display", body: "Full owner-facing body." }],
			},
			displayContext: { worldHandle: "sandbox" },
		};
		const sql = memoryLoopMessageInsertSql(42, displayPayload);
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const insertLoopMessage = (BotRuntime.prototype as unknown as {
			insertLoopMessage: (input: {
				runId: string;
				message: BotInferenceSubmissionMessage;
				origin: BotLoopMessage["origin"];
				status?: BotLoopMessage["status"];
				displayEventSeq?: number;
				broadcast: boolean;
			}) => BotLoopMessage;
		}).insertLoopMessage.bind(runtime);
		const minimizedContent = JSON.stringify({ content: [{ commentId: "cmt_display" }] });

		const inserted = insertLoopMessage({
			runId: "run-display",
			message: { role: "tool", tool_call_id: "call-read", content: minimizedContent },
			origin: "tool_result",
			status: "complete",
			displayEventSeq: 42,
			broadcast: false,
		});

		expect(sql.inserted()?.display_event_seq).toBe(42);
		expect(inserted.message.content).toBe(minimizedContent);
		expect(inserted.display).toEqual({
			kind: "tool_result",
			eventSeq: 42,
			name: "read_thread_by_id",
			args: displayPayload.args,
			result: displayPayload.result,
			context: { worldHandle: "sandbox" },
		});
	});

	it("builds provider chat requests with explicit tool-call and output controls", () => {
		const request = providerChatCompletionRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				providerRouting: { max_price: { prompt: 0.25, completion: 0.75 } },
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
		);

		expect(request.tool_choice).toBe("required");
		expect(request.parallel_tool_calls).toBe(true);
		expect(request.stream).toBe(true);
		expect(request.stream_options.include_usage).toBe(true);
		expect(request.max_completion_tokens).toBe(providerContextReserveTokens);
		expect(request.provider).toEqual({ max_price: { prompt: 0.25, completion: 0.75 } });
		expect(request.reasoning).toEqual({ effort: "minimal", exclude: false });
		expect(request.tools).toBe(toolDefinitions);
		expect(request.messages).toEqual([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			},
		]);
		expect(
			providerChatCompletionRequest(
				{
					baseUrl: customProviderBaseUrl,
					model: "test-model",
					supportsPrefill: false,
					temperature: 0.2,
				},
				[{ role: "user", content: "hello" }],
				toolDefinitions,
				"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			).messages,
		).toEqual([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			},
			{ role: "user", content: "Bickr Terminal is ready for my next step." },
		]);
		expect(
			providerChatCompletionRequest(
				{
					baseUrl: customProviderBaseUrl,
					model: "test-model",
					temperature: 0.2,
				},
				[{ role: "system", content: "System prompt." }],
				toolDefinitions,
				"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			).messages,
		).toEqual([
			{ role: "system", content: "System prompt." },
			{ role: "user", content: "Bickr Terminal is ready for my next step." },
			{
				role: "assistant",
				content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			},
		]);
		expect("frequency_penalty" in request).toBe(false);
		expect("presence_penalty" in request).toBe(false);
		expect("repetition_penalty" in request).toBe(false);

		const railroadRequest = providerChatCompletionRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			undefined,
			"railroad",
		);
		const atWillRequest = providerChatCompletionRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			undefined,
			"at_will",
		);
		expect("tool_choice" in railroadRequest).toBe(false);
		expect("tool_choice" in atWillRequest).toBe(false);

		const tunedRequest = providerChatCompletionRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				temperature: 0.2,
				frequencyPenalty: -0.25,
				presencePenalty: 0.5,
				repetitionPenalty: 1.15,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			);
		expect(tunedRequest).toMatchObject({
			frequency_penalty: -0.25,
			presence_penalty: 0.5,
			repetition_penalty: 1.15,
		});

		const claudeCacheRequest = providerChatCompletionRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "~anthropic/claude-sonnet-latest",
				promptCacheMode: "openrouter_anthropic_1h",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			undefined,
			"railroad",
			"bot:cache-test",
		);
		expect(claudeCacheRequest.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(claudeCacheRequest.session_id).toBe("bot:cache-test");

		const nonClaudeCacheRequest = providerChatCompletionRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "openai/gpt-5-mini",
				promptCacheMode: "openrouter_anthropic_5m",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			undefined,
			"railroad",
			"bot:cache-test",
		);
		expect("cache_control" in nonClaudeCacheRequest).toBe(false);
		expect("session_id" in nonClaudeCacheRequest).toBe(false);
	});

	it("applies conservative request policy for unknown OpenRouter models", () => {
		const request = providerChatCompletionRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "unknown/provider-model",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			"Continue from here.",
		);

		expect(request.tool_choice).toBeUndefined();
		expect(request.reasoning).toBeUndefined();
		expect(request.messages.at(-1)).toEqual({
			role: "user",
			content: "Bickr Terminal is ready for my next step.",
		});
	});

		it("appends tool requirement prompt text only for require and railroad modes", () => {
			const tools = [
				toolDefinitions.find((definition) => definition.function.name === "read_thread")!,
				toolDefinitions.find((definition) => definition.function.name === "vote")!,
				toolDefinitionsForProviderRound().find((definition) => definition.function.name === metaCompactionToolName)!,
				{ type: "openrouter:web_search" } as ProviderToolDefinition,
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessagesForProvider: () => [],
			});
			const activeProviderRequestMessages = (BotRuntime.prototype as unknown as {
				activeProviderRequestMessages: (
					bot: BotDocument,
					tools?: ProviderToolDefinition[],
					toolCalls?: "require" | "railroad" | "at_will",
				) => Array<{ role: string; content?: string }>;
			}).activeProviderRequestMessages.bind(runtime);

			const defaultSystem = activeProviderRequestMessages(fakeBotDocument())[0]?.content ?? "";
			const requireSystem = activeProviderRequestMessages(fakeBotDocument(), tools, "require")[0]?.content ?? "";
			const railroadSystem = activeProviderRequestMessages(fakeBotDocument(), tools, "railroad")[0]?.content ?? "";
			const atWillSystem = activeProviderRequestMessages(fakeBotDocument(), tools, "at_will")[0]?.content ?? "";

			expect(defaultSystem).not.toContain(metaCompactionToolName);
			expect(requireSystem).toContain("You MUST use one of the following tools: read_thread, vote, openrouter:web_search.");
			expect(requireSystem).toContain(`${metaCompactionToolName} may only be used when directed.`);
			expect(railroadSystem).toContain("You MUST use one of the following tools: read_thread, vote, openrouter:web_search.");
			expect(railroadSystem).toContain(`${metaCompactionToolName} may only be used when directed.`);
			expect(atWillSystem).not.toContain("You MUST use one of the following tools");
		});

		it("adds blank assistant content only in provider requests", () => {
			const reasoningOnlyMessage: BotInferenceSubmissionMessage = {
				role: "assistant",
				reasoning_details: [
					{ type: "reasoning.text", text: "I will choose a Bickr control.", format: "unknown", index: 0 },
				],
			};
			const toolCallMessage: BotInferenceSubmissionMessage = {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_read",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
					},
				],
			};

			const chatRequest = providerChatCompletionRequest(
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				[reasoningOnlyMessage, toolCallMessage],
				toolDefinitions,
			);
			const compactionRequest = providerCompactionRequest(
				{ model: "test-model" },
				[reasoningOnlyMessage],
			);

			expect(chatRequest.messages[0]).toEqual({
				...reasoningOnlyMessage,
				content: "",
			});
			expect(chatRequest.messages[1]).toEqual({
				...toolCallMessage,
				content: "",
				tool_calls: [
					{
						...toolCallMessage.tool_calls![0]!,
						id: "call_1",
					},
				],
			});
			expect(compactionRequest.messages[0]).toEqual({
				...reasoningOnlyMessage,
				content: "",
			});
			expect("content" in reasoningOnlyMessage).toBe(false);
			expect(toolCallMessage.content).toBeNull();
		});

		it("flattens deeply nested tool result JSON only in provider requests", () => {
			const nestedJson = (depth: number): unknown => {
				let value: unknown = "leaf";
				for (let index = 0; index < depth; index += 1) {
					value = { child: value };
				}
				return value;
			};
			const deepContent = JSON.stringify(nestedJson(40));
			const shallowContent = JSON.stringify(nestedJson(4));
			const messages: BotInferenceSubmissionMessage[] = [
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_deep",
							type: "function",
							function: { name: "read_comment_by_id", arguments: "{\"commentRef\":\"c/deep\"}" },
						},
						{
							id: "call_shallow",
							type: "function",
							function: { name: "read_comment_by_id", arguments: "{\"commentRef\":\"c/shallow\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_deep", content: deepContent },
				{ role: "tool", tool_call_id: "call_shallow", content: shallowContent },
			];

			const request = providerCompactionRequest({ model: "test-model" }, messages);

			expect(request.messages[0]).toMatchObject({
				role: "assistant",
				content: "",
				tool_calls: [
					expect.objectContaining({ id: "call_1" }),
					expect.objectContaining({ id: "call_2" }),
				],
			});
			expect(request.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
			expect(request.messages[2]).toEqual({ role: "tool", tool_call_id: "call_2", content: shallowContent });
			const flattened = JSON.parse(request.messages[1]?.content as string) as { text: string };
			expect(flattened).toEqual({ text: deepContent });
			expect(JSON.parse(flattened.text) as unknown).toEqual(nestedJson(40));
			expect(messages[1]?.content).toBe(deepContent);
		});

		it("builds structured-output provider compaction requests by default over the verbatim compacted chat", () => {
			const bot = fakeBotDocument({
				id: "bot_release",
				handle: "release-sage",
				displayName: "Release Sage",
				shortBio: "Summarizes release work.",
				prompt: "Prefer concise changelog memory.",
			});
			const compactedMessages: Parameters<typeof providerCompactionMessages>[1] = [
				{
					role: "assistant",
					content: "I decided to read a thread about changelogs.",
				},
				{
					role: "tool",
					tool_call_id: "call_read",
					content: JSON.stringify({
						thread: { title: "Release notes", author: { username: "muller" } },
					}),
				},
			];
			const messages = providerCompactionMessages(bot, compactedMessages);
			const request = providerCompactionRequest(
				{
					model: "test-model",
					providerRouting: { sort: "price" },
					reasoningEffort: "high",
				},
				messages,
			);

			expect(request).toMatchObject({
				model: "test-model",
				provider: { sort: "price" },
				stream: false,
				temperature: 0.2,
				parallel_tool_calls: false,
			});
			expect(request.reasoning).toBeUndefined();
			expect(request.tool_choice).toBe("none");
			const requestTools = request.tools ?? [];
			expect(requestTools.some((tool) => tool.type === "function" && tool.function.name === "read_thread")).toBe(true);
			expect(requestTools.some((tool) => tool.type === "function" && tool.function.name === metaCompactionToolName)).toBe(false);
			expect(request.response_format).toMatchObject({
				type: "json_schema",
				json_schema: {
					name: "compaction_summary",
					description: providerCompactionSummarySchemaDescription,
					strict: true,
					schema: {
						type: "object",
						description: providerCompactionSummarySchemaDescription,
						properties: {
							[providerCompactionSummaryProperty]: {
								type: "string",
								description: providerCompactionSummaryPropertyDescription,
								minLength: 1,
								maxLength: 4000,
							},
						},
						required: [providerCompactionSummaryProperty],
						additionalProperties: false,
					},
				},
			});
			const summaryProperty = request.response_format?.json_schema.schema.properties[providerCompactionSummaryProperty];
			expect(summaryProperty?.description).toContain("must never be a verbatim copy");
			expect(summaryProperty?.description).toContain("prior summary passages");
			expect(messages[0]?.role).toBe("system");
			expect(messages[0]?.content).toContain("Your Bickr handle is u/release-sage");
			expect(messages[0]?.content).toContain("read_thread");
			expect(messages.slice(1, 3)).toEqual(compactedMessages);
			expect(messages[3]).toMatchObject({ role: "user" });
			expect(messages[3]?.content).toContain("META: Context compaction required.");
			expect(messages[3]?.content).toContain("Don't spend any time thinking about this; respond immediately with JSON summary.");
			expect(messages[3]?.content).toContain("structured output schema");
			expect(messages[3]?.content).toContain("do not use any Bickr control");
			expect(messages[3]?.content).toContain("u/release-sage");
			expect(messages[3]?.content).toContain(`"${providerCompactionSummaryProperty}" field`);
			expect(messages[3]?.content).toContain("only the recent events being compacted");
			expect(messages[3]?.content).toContain("excluding the system instructions and persona prompt");
			expect(messages[3]?.content).toContain("long-term memory");
			expect(messages[3]?.content).toContain("4000 characters");
			expect(messages[3]?.content).not.toMatch(/\bbot\b|\bAI\b|\bmodel\b|\bassistant\b|\bagent\b/i);
			expect(messages).toHaveLength(4);
		});

		it("builds isolated tool-call provider compaction requests when selected", () => {
			const bot = { ...fakeBotDocument({ prompt: "Prefer concise changelog memory." }), handle: "release-sage", displayName: lt("Release Sage") };
			const compactedMessages: Parameters<typeof providerCompactionMessages>[1] = [
				{ role: "assistant", content: "I decided to read a thread about changelogs." },
			];
			const limits = { minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 };
			const messages = providerCompactionMessages(bot, compactedMessages, limits, undefined, "tool_call");
			const request = providerCompactionRequest({ model: "test-model" }, messages, limits, undefined, "tool_call");

			expect(request.tool_choice).toBe("required");
			const requestTools = request.tools ?? [];
			expect(requestTools).toHaveLength(1);
			const metaTool = requestTools.find((tool) => tool.type === "function" && tool.function.name === metaCompactionToolName);
			expect(metaTool).toMatchObject({
				type: "function",
				function: {
					name: metaCompactionToolName,
					description: expect.stringContaining("Use only when directed."),
				},
			});
			expect(metaTool?.type === "function" ? metaTool.function.parameters.description : undefined)
				.toBe(providerCompactionSummarySchemaDescription);
			expect(metaTool?.type === "function" ? metaTool.function.parameters.properties[providerCompactionSummaryProperty] : undefined).toMatchObject({
				type: "string",
				description: providerCompactionSummaryPropertyDescription,
				minLength: 1,
				maxLength: 4000,
			});
			expect(metaTool?.type === "function" ? metaTool.function.parameters.properties[providerCompactionSummaryProperty].description : undefined)
				.toContain("must never be a verbatim copy");
			expect(requestTools.some((tool) => tool.type === "function" && tool.function.name === "read_thread")).toBe(false);
			expect("response_format" in request).toBe(false);
			expect(messages.at(-2)?.content).toContain("only the recent events being compacted");
			expect(messages.at(-2)?.content).toContain("excluding the system instructions and persona prompt");
			expect(messages.at(-1)).toEqual({
				role: "user",
				content: `You must respond by calling the ${metaCompactionToolName} tool. Put the summary in the "${providerCompactionSummaryProperty}" argument. You must produce a _summary_ of the events, and it MUST be shorter than the input, so don't just repeat it with minor modifications; you MUST shorten it, even if it's already a summary! Use between 1 and 4000 characters. Do not reply as plain text.`,
			});
			const railroadRequest = providerCompactionRequest(
				{
					model: "test-model",
					toolCalls: "railroad",
				},
				messages,
				limits,
				undefined,
				"tool_call",
			);
			const coercedAtWillRequest = providerCompactionRequest(
				{
					model: "test-model",
					toolCalls: "at_will",
				},
				messages,
				limits,
				undefined,
				"tool_call",
			);
			expect("tool_choice" in railroadRequest).toBe(false);
			expect("tool_choice" in coercedAtWillRequest).toBe(false);
			expect(messages[0]?.content).toContain(`You MUST use ${metaCompactionToolName}.`);
			expect(messages[0]?.content).not.toContain("read_thread");
		});

		it("builds cache-friendly provider compaction requests with the shared tool schema", () => {
			const bot = fakeBotDocument({ prompt: "Prefer concise changelog memory." });
			const compactedMessages: Parameters<typeof providerCompactionMessages>[1] = [
				{ role: "assistant", content: "I decided to read a thread about changelogs." },
			];
			const limits = { minLength: 250, maxLength: 4000 };
			const tools = toolDefinitionsForProviderRound(limits.maxLength, { includeMetaCompactionTool: true });
			const messages = providerCompactionMessages(bot, compactedMessages, limits, tools, "tool_call_cache_friendly");
			const request = providerCompactionRequest(
				{ model: "test-model" },
				messages,
				{ ...limits, maxCompletionTokens: 1000 },
				tools,
				"tool_call_cache_friendly",
			);

			const requestTools = request.tools ?? [];
			expect(requestTools).toHaveLength(toolDefinitionsForProviderRound().length);
			expect(requestTools.some((tool) => tool.type === "function" && tool.function.name === "read_thread")).toBe(true);
			const metaTool = requestTools.find((tool) => tool.type === "function" && tool.function.name === metaCompactionToolName);
			expect(metaTool?.type === "function" ? metaTool.function.parameters.description : undefined)
				.toBe(providerCompactionSummarySchemaDescription);
			expect(metaTool?.type === "function" ? metaTool.function.parameters.properties[providerCompactionSummaryProperty] : undefined).toMatchObject({
				description: providerCompactionSummaryPropertyDescription,
				minLength: 1,
				maxLength: 4000,
			});
			expect(metaTool?.type === "function" ? metaTool.function.parameters.properties[providerCompactionSummaryProperty].description : undefined)
				.toContain("must never be a verbatim copy");
			expect(messages).toHaveLength(3);
			expect(messages[0]?.content).toContain(`${metaCompactionToolName} may only be used when directed.`);
		});

		it("derives provider compaction prompt lengths from settings and compacted characters", () => {
			const bot = fakeBotDocument({
				contextWindowTokens: 50_000,
				compactionSummaryPercent: 10,
				compactionMaxCharacters: 20_000,
			});
			const compactedMessages = [{ role: "assistant" as const, content: "x".repeat(30_000) }];
			const limits = providerCompactionSummaryLimitsForChat(
				bot,
				compactedMessages,
				{ tokensPerCharacter: 0.25, sampleCount: 3 },
			);
			const messages = providerCompactionMessages(bot, compactedMessages, limits);
			const request = providerCompactionRequest({ model: "test-model" }, messages, limits);

			expect(limits).toMatchObject({
				minLength: 3001,
				maxLength: 20_000,
				configuredMaxCharacters: 20_000,
				compactionSummaryPercent: 10,
			});
			expect(limits.anticipatedSummaryTokens).toBe(Math.ceil(limits.minLength * limits.tokensPerCharacter));
			expect(limits.maxSummaryTokens).toBe(Math.ceil(limits.maxLength * limits.tokensPerCharacter));
			expect(limits.maxCompletionTokens).toBeGreaterThan(5_000);
			expect(limits.nextCompactionTokens).toBe(50_000 - providerContextPromptReserveTokens);
			expect(limits.compactionInputTokens).toBeGreaterThan(40_000);
			expect(request.max_completion_tokens).toBe(limits.maxCompletionTokens);
			expect((request.tools ?? []).some((item) => item.type === "function" && item.function.name === metaCompactionToolName)).toBe(false);
			expect(request.response_format?.json_schema.schema.properties[providerCompactionSummaryProperty]).toMatchObject({
				minLength: 1,
				maxLength: 20_000,
			});
			expect(messages[2]?.content).toContain("between 3001 and 20000 characters");
		});

		it("keeps fixed prompt overhead out of the normal compaction cutoff", () => {
			const compactedMessages = [{ role: "assistant" as const, content: "x".repeat(30_000) }];
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 3 };
			const shortPromptLimits = providerCompactionSummaryLimitsForChat(
				fakeBotDocument({ contextWindowTokens: 20_000 }),
				compactedMessages,
				calibration,
				toolDefinitionsForProviderRound(),
			);
			const longPromptLimits = providerCompactionSummaryLimitsForChat(
				fakeBotDocument({ contextWindowTokens: 20_000, prompt: "x".repeat(25_000) }),
				compactedMessages,
				calibration,
				toolDefinitionsForProviderRound(),
			);

			expect(longPromptLimits.nextCompactionTokens).toBe(shortPromptLimits.nextCompactionTokens);
			expect(longPromptLimits.compactionInputTokens).toBeLessThan(shortPromptLimits.compactionInputTokens);
			expect(longPromptLimits.nextCompactionTokens).toBe(20_000 - providerContextPromptReserveTokens);
		});

		it("wraps failed compaction provider calls with request and response diagnostics", async () => {
			const originalFetch = globalThis.fetch;
			const responseBody = "{\"error\":\"schema rejected\"}";
			const fetchMock = vi.fn(async () => new Response(responseBody, { status: 400 }));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (
						settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
						messages: Parameters<typeof providerCompactionRequest>[1],
						runId: string,
						signal: AbortSignal,
					) => Promise<unknown>;
				}).callProviderForCompaction.bind(runtime);

				let thrown: unknown;
				try {
					await callProviderForCompaction(
						{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
						[{ role: "user", content: "Compact the retained activity." }],
						"run-compaction-provider-failed",
						new AbortController().signal,
					);
				} catch (error) {
					thrown = error;
				}

				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(thrown).toMatchObject({
					name: "ProviderCompactionRequestError",
					message: `Inference request failed with status 400. Response: ${responseBody}`,
					responseBody,
				});
				expect((thrown as { requestBody?: string }).requestBody).toContain("\"tools\"");
				expect((thrown as { requestBody?: string }).requestBody).toContain("\"response_format\"");
				expect((thrown as { requestBody?: string }).requestBody).not.toContain(`"${metaCompactionToolName}"`);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("falls back to minimal compaction reasoning when a model rejects disabled reasoning", async () => {
			const originalFetch = globalThis.fetch;
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const runtimeState = new Map<string, unknown>();
			const unsupportedBody = JSON.stringify({
				error: {
					message: "reasoning effort none is not supported for this model",
				},
			});
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
				async () => Response.json(validResponse),
			);
			fetchMock.mockResolvedValueOnce(new Response(unsupportedBody, { status: 400 }));
			vi.stubGlobal("fetch", fetchMock);
			try {
					const runtime = Object.assign(Object.create(BotRuntime.prototype), {
						appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
							events.push({ type, payload });
							return {
							seq: events.length,
							runId: _runId,
							type,
							payload,
							tokenEstimate: 0,
							createdAt: new Date().toISOString(),
						};
					},
						runtimeStateRecord: (key: string) => {
							const value = runtimeState.get(key);
							return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
						},
						deleteRuntimeState: (key: string) => {
							runtimeState.delete(key);
						},
						setRuntimeState: (key: string, value: unknown) => {
							runtimeState.set(key, value);
						},
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const settings = {
					baseUrl: customProviderBaseUrl,
					model: "openai/gpt-5.1-codex-mini",
					temperature: 0.2,
				};
				const response = await callProviderForCompaction(
					settings,
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-reasoning-fallback",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning?: unknown };
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { reasoning?: unknown };
				expect(firstBody.reasoning).toEqual({ effort: "none", exclude: false });
				expect(secondBody.reasoning).toEqual({ effort: "minimal", exclude: false });
				expect([...runtimeState.values()][0]).toMatchObject({
					model: "openai/gpt-5.1-codex-mini",
					mode: "minimal",
				});
				expect(events).toContainEqual({
					type: "provider_retry",
					payload: expect.objectContaining({
						attempt: 2,
						delayMs: 0,
						reason: "provider rejected compaction reasoning=none; retrying with minimal",
					}),
				});

				fetchMock.mockClear();
				await callProviderForCompaction(
					settings,
					[{ role: "user", content: "Compact the retained activity again." }],
					"run-compaction-cached-reasoning-fallback",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);
				expect(fetchMock).toHaveBeenCalledTimes(1);
				const cachedBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning?: unknown };
				expect(cachedBody.reasoning).toEqual({ effort: "minimal", exclude: false });

				fetchMock.mockClear();
				await callProviderForCompaction(
					{ ...settings, model: "google/gemini-3.1-flash-lite-preview" },
					[{ role: "user", content: "Compact the retained activity after a model change." }],
					"run-compaction-model-changed",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);
				expect(fetchMock).toHaveBeenCalledTimes(1);
					const changedModelBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { model?: string; reasoning?: unknown };
					expect(changedModelBody.model).toBe("google/gemini-3.1-flash-lite-preview");
					expect(changedModelBody.reasoning).toEqual({ effort: "none", exclude: false });
					expect(runtimeState.size).toBe(0);
				} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("falls back to minimal compaction reasoning when OpenRouter server tools hide the rejection as a 500", async () => {
			const originalFetch = globalThis.fetch;
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const runtimeState = new Map<string, unknown>();
			const opaqueBody = JSON.stringify({
				error: {
					message: "Internal Server Error",
					code: 500,
				},
			});
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
				.mockResolvedValueOnce(new Response(opaqueBody, { status: 500 }))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
						events.push({ type, payload });
						return {
							seq: events.length,
							runId: _runId,
							type,
							payload,
							tokenEstimate: 0,
							createdAt: new Date().toISOString(),
						};
					},
					runtimeStateRecord: (key: string) => {
						const value = runtimeState.get(key);
						return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
					},
					deleteRuntimeState: (key: string) => {
						runtimeState.delete(key);
					},
					setRuntimeState: (key: string, value: unknown) => {
						runtimeState.set(key, value);
					},
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{
						baseUrl: customProviderBaseUrl,
						model: "google/gemini-2.5-pro",
						temperature: 0.2,
					},
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-opaque-reasoning-fallback",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
					[
						...toolDefinitionsForProviderRound(),
						{ type: "openrouter:web_search", parameters: { max_results: 3 } } satisfies ProviderToolDefinition,
					],
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning?: unknown; tools?: ProviderToolDefinition[] };
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { reasoning?: unknown; tools?: ProviderToolDefinition[] };
				expect(firstBody.reasoning).toEqual({ effort: "none", exclude: false });
				expect(secondBody.reasoning).toEqual({ effort: "minimal", exclude: false });
				expect(firstBody.tools?.some((tool) => tool.type === "openrouter:web_search")).toBe(true);
				expect([...runtimeState.values()][0]).toMatchObject({
					model: "google/gemini-2.5-pro",
					mode: "minimal",
				});
				expect(events).toContainEqual({
					type: "provider_retry",
					payload: expect.objectContaining({
						attempt: 2,
						delayMs: 0,
						reason: "provider rejected compaction reasoning=none; retrying with minimal",
					}),
				});
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("wraps empty loop provider streams with request and response diagnostics", async () => {
			const emptyChunk = {
				id: "chatcmpl-empty",
				model: "test-model-concrete",
				object: "chat.completion.chunk",
				choices: [{}],
				usage: { prompt_tokens: 77, completion_tokens: 0, total_tokens: 77 },
			};
			const responseBody = `data: ${JSON.stringify(emptyChunk)}\n\ndata: [DONE]\n\n`;
			const fetchProviderResponse = vi.fn(async () => sseStream([emptyChunk, "[DONE]"]));
			const recordProviderTokenCalibrationSample = vi.fn();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				recordProviderTokenCalibrationSample,
				throwIfStopped: vi.fn(),
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
					messages: Array<Record<string, unknown>>,
					tools: ProviderToolDefinition[],
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<unknown>;
			}).callProvider.bind(runtime);

			let thrown: unknown;
			try {
				await callProvider(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Use a page control." }],
					toolDefinitionsForProviderRound(),
					"run-empty-provider-stream",
					1,
					new AbortController().signal,
				);
			} catch (error) {
				thrown = error;
			}

			expect(fetchProviderResponse).toHaveBeenCalledTimes(1);
			expect(thrown).toMatchObject({
				name: "ProviderLoopRequestError",
				message: expect.stringContaining("Inference provider returned an empty response"),
				responseBody,
			});
			expect(recordProviderTokenCalibrationSample).toHaveBeenCalledWith(expect.objectContaining({
				attempt: 1,
				purpose: "loop",
				responseModel: "test-model-concrete",
				usage: expect.objectContaining({ promptTokens: 77 }),
			}));
			expect((thrown as { requestBody?: string }).requestBody).toContain("\"tool_choice\":\"required\"");
			expect((thrown as { requestBody?: string }).requestBody).toContain("\"tools\"");
		});

		it("retries compaction provider 429s with the reported upstream provider ignored", async () => {
			const originalFetch = globalThis.fetch;
			const rateLimitResponse = {
				error: {
					message: "Provider returned error",
					code: 429,
					metadata: {
						provider_name: "DeepInfra",
						raw: "google/gemma is temporarily rate-limited upstream.",
					},
				},
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(rateLimitResponse, { status: 429 }))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
						events.push({ type, payload });
						return {
							seq: events.length,
							runId: _runId,
							type,
							payload,
							tokenEstimate: 0,
							createdAt: new Date().toISOString(),
						};
					},
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{
						baseUrl: "https://openrouter.ai/api/v1",
						model: "test-model",
						temperature: 0.2,
						providerRouting: { order: ["openrouter/fallback"], ignore: ["A"] },
					},
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-provider-rate-limit",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { provider?: Record<string, unknown> };
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { provider?: Record<string, unknown> };
				expect(firstBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A"] });
				expect(secondBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A", "DeepInfra"] });
				expect(events).toContainEqual({
					type: "provider_retry",
					payload: expect.objectContaining({
						attempt: 2,
						delayMs: 0,
						reason: expect.stringContaining("ignoring upstream provider DeepInfra"),
					}),
				});
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("accepts structured-output compaction responses without the summary tool or minimum requested length", async () => {
			const originalFetch = globalThis.fetch;
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-structured",
					new AbortController().signal,
					{ minLength: 3403, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { response_format?: unknown; tools: ProviderToolDefinition[] };
				expect(requestBody.response_format).toBeTruthy();
				expect(requestBody.tools.some((tool) => tool.type === "function" && tool.function.name === metaCompactionToolName)).toBe(false);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("recovers structured-output compaction JSON wrapped in a markdown fence", async () => {
			const originalFetch = globalThis.fetch;
			const summary = "I remember the important parts from a fenced response.";
			const validResponse = {
				choices: [{
					message: {
						content: `\`\`\`json\n${JSON.stringify({ [providerCompactionSummaryProperty]: summary }, null, 2)}\n\`\`\``,
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-fenced-json",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe(summary);
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("accepts valid structured-output compaction JSON containing escaped quotes", async () => {
			const originalFetch = globalThis.fetch;
			const summary = `I read "A Brief Word on "Economic Jihad" and Other Digital Delusions" and remembered it.`;
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: summary }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-valid-json-quotes",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe(summary);
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("repairs structured-output compaction JSON with unescaped quotes in the summary string", async () => {
			const originalFetch = globalThis.fetch;
			const summary = `I read the thread titled 'A Brief Word on "Economic Jihad" and Other Digital Delusions' and remembered it.`;
			const invalidButRepairableResponse = {
				choices: [{
					message: {
						content: `{\n  "${providerCompactionSummaryProperty}": "${summary}"\n}`,
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(invalidButRepairableResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-loose-json-quotes",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe(summary);
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("does not repair malformed structured-output compaction JSON by dropping extra fields", async () => {
			const originalFetch = globalThis.fetch;
			const validSummary = "I remember the important parts after retry.";
			const invalidMultiFieldResponse = {
				choices: [{
					message: {
						content: `{"${providerCompactionSummaryProperty}":"First value" "extra":"must not be dropped"}`,
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: validSummary }),
					},
				}],
				usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(invalidMultiFieldResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-loose-json-extra-field",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe(validSummary);
				expect(fetchMock).toHaveBeenCalledTimes(2);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("recovers structured-output compaction JSON surrounded by ordinary text", async () => {
			const originalFetch = globalThis.fetch;
			const summary = "I remember the important parts from a text-wrapped response.";
			const validResponse = {
				choices: [{
					message: {
						content: `Here is the compacted memory:\n${JSON.stringify({ [providerCompactionSummaryProperty]: summary })}\nDone.`,
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-text-wrapped-json",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe(summary);
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("accepts over-max compaction summaries when they reduce the estimated context", async () => {
			const originalFetch = globalThis.fetch;
			const overMaxSummary = "I retain the useful context from a much larger span. ".repeat(3);
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: overMaxSummary }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSample: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-soft-max",
					new AbortController().signal,
					{
						minLength: 1,
						maxLength: 20,
						maxCompletionTokens: 1000,
						compactedCharacterCount: 2_000,
						tokensPerCharacter: 0.25,
					},
				);

				expect(overMaxSummary.length).toBeGreaterThan(20);
				expect(response.content).toBe(overMaxSummary);
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("retries compaction summaries that do not reduce the estimated context", async () => {
			const originalFetch = globalThis.fetch;
			const bot = fakeBotDocument({
				displayName: "Memory Keeper",
				handle: "memory-keeper",
				prompt: "Remember without repeating.",
				shortBio: "Compacts memory.",
			});
			const nonCompactingSummary = "This summary is still longer than the retained context.";
			const invalidResponse = {
				id: "compaction-non-reducing",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: nonCompactingSummary }),
					},
				}],
				usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
			};
			const validResponse = {
				id: "compaction-reducing",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "Short." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(invalidResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSample: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[
						{ role: "system", content: "System prompt." },
						{ role: "assistant", content: "Old retained activity that should not be repeated in the retry." },
						{ role: "user", content: "META: Context compaction required." },
					],
					"run-compaction-non-reducing",
					new AbortController().signal,
					{
						minLength: 1,
						maxLength: 100,
						maxCompletionTokens: 1000,
						compactedCharacterCount: 20,
						tokensPerCharacter: 1,
					},
					undefined,
					"structured_output",
					0,
					undefined,
					bot,
				);

				expect(response.content).toBe("Short.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
					messages: BotInferenceSubmissionMessage[];
					tools?: ProviderToolDefinition[];
				};
				expect(retryBody.messages).toEqual([
					expect.objectContaining({
						role: "system",
						content: expect.stringContaining("META: Context compaction repair required."),
					}),
					{ role: "user", content: "Bickr Terminal is ready for my next step." },
					{ role: "assistant", content: nonCompactingSummary },
					{ role: "user", content: "Produce the replacement memory summary now." },
				]);
				expect(retryBody.tools).toBeUndefined();
				const retrySystem = retryBody.messages[0]?.content ?? "";
				expect(retrySystem.startsWith("META: Context compaction repair required.")).toBe(true);
				expect(retrySystem).toContain("The previous compaction attempt did not reduce the context.");
				expect(retrySystem).toContain("Verbatim copying from the input is absolutely prohibited");
				expect(retrySystem).toContain("Your Bickr handle is u/memory-keeper");
				expect(retrySystem).toContain("Your persona is:\nRemember without repeating.");
				expect(retrySystem).not.toContain("Make all decisions autonomously");
				expect(retrySystem).not.toContain("You MUST use one of the following tools");
				expect(JSON.stringify(retryBody.messages)).not.toContain("Old retained activity");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("raises a persistent compaction failure after isolated repair keeps failing to reduce context", async () => {
			const originalFetch = globalThis.fetch;
			const bot = fakeBotDocument({
				displayName: "Memory Keeper",
				handle: "memory-keeper",
				prompt: "Remember without repeating.",
				shortBio: "Compacts memory.",
			});
			const nonCompactingSummary = "This summary is still longer than the retained context.";
			const invalidResponse = {
				id: "compaction-non-reducing",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: nonCompactingSummary }),
					},
				}],
				usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
			};
			const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(invalidResponse)));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSampleFromError: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const rejection = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[
						{ role: "system", content: "System prompt." },
						{ role: "assistant", content: "Old retained activity that should not be repeated in the retry." },
						{ role: "user", content: "META: Context compaction required." },
					],
					"run-compaction-non-reducing-persistent",
					new AbortController().signal,
					{
						minLength: 1,
						maxLength: 100,
						maxCompletionTokens: 1000,
						compactedCharacterCount: 20,
						tokensPerCharacter: 1,
					},
					undefined,
					"structured_output",
					0,
					undefined,
					bot,
				).catch((error: unknown) => error);
				expect(rejection).toBeInstanceOf(PersistentCompactionReductionFailureError);
				expect(rejection).toMatchObject({ attempts: 4 });

				expect(fetchMock).toHaveBeenCalledTimes(5);
				const isolatedBodies = fetchMock.mock.calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)) as {
					messages: BotInferenceSubmissionMessage[];
					tools?: ProviderToolDefinition[];
				});
				expect(isolatedBodies).toHaveLength(4);
				const finalRequest = JSON.parse(String((rejection as PersistentCompactionReductionFailureError).requestBody)) as {
					messages: BotInferenceSubmissionMessage[];
					tools?: ProviderToolDefinition[];
				};
				const finalResponse = JSON.parse(String((rejection as PersistentCompactionReductionFailureError).responseBody)) as typeof invalidResponse;
				expect(finalRequest).toEqual(isolatedBodies.at(-1));
				expect(finalResponse).toEqual(invalidResponse);
				expect(runtimeFailureLogs(rejection)).toEqual([
					{ kind: "compaction_request", text: (rejection as PersistentCompactionReductionFailureError).requestBody },
					{ kind: "compaction_response", text: (rejection as PersistentCompactionReductionFailureError).responseBody },
				]);
				for (const body of isolatedBodies) {
					expect(body.tools).toBeUndefined();
					expect(body.messages[0]?.content).toContain("META: Context compaction repair required.");
					expect(body.messages[0]?.content).toContain("Verbatim copying from the input is absolutely prohibited");
					expect(JSON.stringify(body.messages)).not.toContain("Old retained activity");
				}
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("records calibration samples for schema-invalid compaction attempts with usage", async () => {
			const originalFetch = globalThis.fetch;
			const invalidResponse = {
				id: "compaction-invalid",
				model: "test-model-concrete",
				choices: [{ message: { content: "not json" } }],
				usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
			};
			const validResponse = {
				id: "compaction-valid",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(invalidResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const recordProviderTokenCalibrationSample = vi.fn();
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSample,
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-schema-calibration",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(recordProviderTokenCalibrationSample).toHaveBeenCalledTimes(2);
				expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(1, expect.objectContaining({
					attempt: 1,
					purpose: "compaction",
					responseModel: "test-model-concrete",
					usage: expect.objectContaining({ promptTokens: 40 }),
				}));
				expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(2, expect.objectContaining({
					attempt: 2,
					purpose: "compaction",
					responseModel: "test-model-concrete",
					usage: expect.objectContaining({ promptTokens: 50 }),
				}));
				const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(JSON.stringify(retryBody.messages)).toContain("Actually, I must reply with the required structured output.");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("repairs structured-output compaction tool calls with the schema summary prompt", async () => {
			const originalFetch = globalThis.fetch;
			const ordinaryToolResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_read_in_structured_compaction",
							type: "function",
							function: { name: "read_thread", arguments: JSON.stringify({ threadId: "thr_1" }) },
						}],
					},
				}],
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(ordinaryToolResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-structured-tool-repair",
					new AbortController().signal,
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				const repairToolMessage = retryBody.messages.find((message) => message.role === "tool");
				expect(repairToolMessage?.content).toContain("META: don't make any tool calls. You must reply with the structured detailed first-person summary strictly following the required JSON schema.");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("accepts tool-call compaction responses below the requested minimum length", async () => {
			const originalFetch = globalThis.fetch;
			const validResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_short_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "Short summary." }),
							},
						}],
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-tool-short",
					new AbortController().signal,
					{ minLength: 3403, maxLength: 4000, maxCompletionTokens: 1000 },
					undefined,
					"tool_call",
				);

				expect(response.content).toBe("Short summary.");
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("retries schema-invalid compaction tool calls with a repair tool result", async () => {
			const originalFetch = globalThis.fetch;
			const invalidResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_bad_compaction",
							type: "function",
							function: { name: metaCompactionToolName, arguments: JSON.stringify({ summary: "Wrong key." }) },
						}],
					},
				}],
			};
			const validResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_good_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
							},
						}],
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(invalidResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-repair",
					new AbortController().signal,
					undefined,
					undefined,
					"tool_call",
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const repairedBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(repairedBody.messages).toEqual(expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						tool_calls: [
							expect.objectContaining({
								id: "call_1",
								function: invalidResponse.choices[0]!.message.tool_calls[0]!.function,
							}),
						],
					}),
					expect.objectContaining({
						role: "tool",
						tool_call_id: "call_1",
						content: expect.stringContaining("schema_invalid"),
					}),
				]));
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("retries overlong compaction summaries by shortening only the previous summary", async () => {
			const originalFetch = globalThis.fetch;
			const overlongSummary = "I remember this, but with too many characters.";
			const overlongResponse = {
				id: "compaction-overlong",
				model: "test-model-concrete",
				choices: [{
					message: {
						tool_calls: [{
							id: "call_overlong_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: overlongSummary }),
							},
						}],
					},
				}],
				usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
			};
			const validResponse = {
				id: "compaction-shortened",
				model: "test-model-concrete",
				choices: [{
					message: {
						tool_calls: [{
							id: "call_short_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "Short." }),
							},
						}],
					},
				}],
				usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(overlongResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const recordProviderTokenCalibrationSample = vi.fn();
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSample,
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[
						{ role: "system", content: "System prompt." },
						{ role: "assistant", content: "Old retained activity that should not be repeated in the shorten retry." },
						{ role: "user", content: "META: Context compaction required." },
					],
					"run-compaction-shorten",
					new AbortController().signal,
					{ minLength: 1, maxLength: 10, maxCompletionTokens: 100 },
					undefined,
					"tool_call",
				);

				expect(response.content).toBe("Short.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(recordProviderTokenCalibrationSample).toHaveBeenCalledTimes(2);
				expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(1, expect.objectContaining({
					attempt: 1,
					usage: expect.objectContaining({ promptTokens: 60 }),
				}));
				expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(2, expect.objectContaining({
					attempt: 2,
					usage: expect.objectContaining({ promptTokens: 30 }),
				}));
				const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(retryBody.messages).toEqual([
					{ role: "system", content: "System prompt." },
					{ role: "user", content: "Bickr Terminal is ready for my next step." },
					{ role: "assistant", content: overlongSummary },
					expect.objectContaining({
						role: "user",
						content: expect.stringContaining("previous context compaction attempt produced a summary that was too long"),
					}),
				]);
				expect(retryBody.messages.at(-1)?.content).toContain("Verbatim copying from the input is absolutely prohibited");
				expect(JSON.stringify(retryBody.messages)).not.toContain("Old retained activity");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("repairs ordinary tool calls during compaction without executing them", async () => {
			const originalFetch = globalThis.fetch;
			const ordinaryToolResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_read_in_compaction",
							type: "function",
							function: { name: "read_thread", arguments: JSON.stringify({ threadId: "thr_1" }) },
						}],
					},
				}],
			};
			const validResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_good_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
							},
						}],
					},
				}],
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(ordinaryToolResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-ordinary-tool-repair",
					new AbortController().signal,
					undefined,
					undefined,
					"tool_call",
				);

				expect(response.content).toBe("I remember the important parts.");
				const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				const repairToolMessage = retryBody.messages.find((message) => message.role === "tool");
				expect(repairToolMessage?.tool_call_id).toBe("call_1");
				expect(repairToolMessage?.content).toContain(`Only ${metaCompactionToolName} may be used`);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("surfaces final schema-invalid compaction failures as owner-visible inference diagnostics", async () => {
			const originalFetch = globalThis.fetch;
			const invalidResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_bad_compaction",
							type: "function",
							function: { name: metaCompactionToolName, arguments: JSON.stringify({ summary: "Wrong key." }) },
						}],
					},
				}],
			};
			const fetchMock = vi.fn(async () => Response.json(invalidResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<unknown>;
				}).callProviderForCompaction.bind(runtime);

				let thrown: unknown;
				try {
					await callProviderForCompaction(
						{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
						[{ role: "user", content: "Compact the retained activity." }],
						"run-compaction-repair-failed",
						new AbortController().signal,
						undefined,
						undefined,
						"tool_call",
					);
				} catch (error) {
					thrown = error;
				}

				expect(fetchMock).toHaveBeenCalledTimes(5);
				expect(thrown).toMatchObject({
					name: "ProviderCompactionRequestError",
					message: expect.stringContaining("schema-invalid compaction tool arguments"),
				});
				expect(runtimeErrorLoopMessageContent(thrown)).toMatch(/^Inference provider returned an error: /);
				expect(runtimeErrorLoopMessageContent(thrown)).toContain("schema-invalid compaction tool arguments");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("selects compaction rows by oldest token fraction instead of row count", () => {
			const selected = oldestRowsForTokenFraction(
				[
					{ row: { seq: 1 }, tokens: 25 },
					{ row: { seq: 2 }, tokens: 25 },
					{ row: { seq: 3 }, tokens: 25 },
					{ row: { seq: 4 }, tokens: 25 },
				],
				0.7,
			);

			expect(selected.map((row) => row.seq)).toEqual([1, 2, 3]);
		});

		it("stops before the atomic tool-call group that crosses the compaction prompt budget", () => {
			const large = (char: string) => char.repeat(4_000);
			const rows: LoopMessageRowForTest[] = [
				loopMessageRowForMessage(1, { role: "assistant", content: large("a") }),
				loopMessageRowForMessage(2, {
					role: "assistant",
					content: large("b"),
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-read", content: large("c") }, "tool_result"),
				loopMessageRowForMessage(4, { role: "assistant", content: large("d") }),
				loopMessageRowForMessage(5, { role: "assistant", content: large("e") }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowsForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowsForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => Array<{ seq: number }>;
			}).compactionRowsForEstimatedBudget.bind(runtime);

			const selected = compactionRowsForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 8_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.map((row) => row.seq)).toEqual([1]);
		});

		it("compacts malformed visible tool history without blocking on missing matches", () => {
			const large = (char: string) => char.repeat(4_000);
			const rows: LoopMessageRowForTest[] = [
				loopMessageRowForMessage(1, {
					role: "assistant",
					content: large("a"),
					tool_calls: [
						{
							id: "call-missing-result",
							type: "function",
							function: { name: "read_thread", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(2, { role: "tool", tool_call_id: "call-orphan", content: large("b") }, "tool_result"),
				loopMessageRowForMessage(3, { role: "assistant", content: large("c") }),
				loopMessageRowForMessage(4, { role: "assistant", content: large("d") }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowsForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowsForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => Array<{ seq: number }>;
			}).compactionRowsForEstimatedBudget.bind(runtime);

			const selected = compactionRowsForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 8_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.map((row) => row.seq)).toEqual([1]);
		});

		it("allows one over-budget compaction group when the normal prefix would be too small", () => {
			const huge = (char: string) => char.repeat(20_000);
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "a" }),
				loopMessageRowForMessage(2, {
					role: "assistant",
					content: huge("b"),
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-read", content: huge("c") }, "tool_result"),
				loopMessageRowForMessage(4, { role: "assistant", content: huge("d") }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowSelectionForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowSelectionForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => { rows: Array<{ seq: number }>; overBudgetFallback: boolean };
			}).compactionRowSelectionForEstimatedBudget.bind(runtime);

			const selected = compactionRowSelectionForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 8_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
			expect(selected.overBudgetFallback).toBe(true);
		});

		it("includes the next fitting atomic group instead of compacting a tiny prefix", () => {
			const large = (char: string) => char.repeat(60_000);
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "small runtime note" }),
				loopMessageRowForMessage(2, {
					role: "assistant",
					content: large("b"),
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-read", content: large("c") }, "tool_result"),
				loopMessageRowForMessage(4, { role: "assistant", content: large("d") }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowSelectionForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowSelectionForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => { rows: Array<{ seq: number }>; overBudgetFallback: boolean };
			}).compactionRowSelectionForEstimatedBudget.bind(runtime);

			const selected = compactionRowSelectionForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 64_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
			expect(selected.overBudgetFallback).toBe(false);
		});

		it("does not auto-compact a tiny complete provider history", () => {
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "I remember a short summary." }, "compaction"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowSelectionForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowSelectionForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => { rows: Array<{ seq: number }>; overBudgetFallback: boolean };
			}).compactionRowSelectionForEstimatedBudget.bind(runtime);

			const selected = compactionRowSelectionForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 20_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.rows).toEqual([]);
			expect(selected.overBudgetFallback).toBe(false);
		});

		it("excludes a prefix group that would leave too little compaction output budget", () => {
			const text = (char: string, length: number) => char.repeat(length);
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: text("a", 3_200) }),
				loopMessageRowForMessage(2, { role: "assistant", content: text("b", 420) }),
				loopMessageRowForMessage(3, {
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call-hot",
							type: "function",
							function: { name: "list_hot_threads", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(4, { role: "tool", tool_call_id: "call-hot", content: text("c", 8_000) }, "tool_result"),
				loopMessageRowForMessage(5, {
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread_by_id", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(6, { role: "tool", tool_call_id: "call-read", content: text("d", 10_500) }, "tool_result"),
			];
			const calibration = { tokensPerCharacter: 0.325, sampleCount: 50 };
			const tools = toolDefinitionsForProviderRound();
			const bot = fakeBotDocument({
				contextWindowTokens: 20_000,
				compactionMaxCharacters: 20_000,
				prompt: "Long persona. ".repeat(900),
			});
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => calibration,
			});
			const compactionRowsForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowsForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => Array<{ seq: number; message_json: string }>;
			}).compactionRowsForEstimatedBudget.bind(runtime);

			const selected = compactionRowsForEstimatedBudget(bot, tools, "structured_output");
			const selectedMessages = selected.map(
				(row) => JSON.parse(row.message_json) as Parameters<typeof providerCompactionSummaryLimitsForChat>[1][number],
			);
			const selectedLimits = providerCompactionSummaryLimitsForChat(bot, selectedMessages, calibration, tools, "structured_output");
			const rejectedMessages = rows.slice(0, 6).map(
				(row) => JSON.parse(row.message_json) as Parameters<typeof providerCompactionSummaryLimitsForChat>[1][number],
			);
			const rejectedLimits = providerCompactionSummaryLimitsForChat(bot, rejectedMessages, calibration, tools, "structured_output");
			const compactionOutputSafetyTokens = 512;

			expect(selected.map((row) => row.seq)).toEqual([1, 2]);
			expect(selectedLimits.maxCompletionTokens).toBeGreaterThanOrEqual(selectedLimits.maxSummaryTokens + compactionOutputSafetyTokens);
			expect(rejectedLimits.maxCompletionTokens).toBeLessThan(rejectedLimits.maxSummaryTokens + compactionOutputSafetyTokens);
		});

		it("uses the provider-history filter for compaction candidates", () => {
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "Provider-visible old context." }),
				loopMessageRowForMessage(
					2,
					{ role: "user", content: runtimeErrorLoopMessageContent("Inference request failed with status 400. Response: provider rejected the request.") },
					"runtime_error",
				),
				loopMessageRowForMessage(3, { role: "assistant", content: defaultReasoningPrefill("budget-bot") }, "synthetic_context"),
				loopMessageRowForMessage(4, { role: "assistant", content: "Provider-visible newer context." }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const activeLoopMessagesForProvider = (BotRuntime.prototype as unknown as {
				activeLoopMessagesForProvider: () => Array<{ content?: unknown }>;
			}).activeLoopMessagesForProvider.bind(runtime);
			const compactionCandidateRows = (BotRuntime.prototype as unknown as {
				compactionCandidateRows: () => Array<{ seq: number }>;
			}).compactionCandidateRows.bind(runtime);

			expect(activeLoopMessagesForProvider().map((message) => message.content)).toEqual([
				"Provider-visible old context.",
				defaultReasoningPrefill("budget-bot"),
				"Provider-visible newer context.",
			]);
			expect(compactionCandidateRows().map((row) => row.seq)).toEqual([1, 3, 4]);
		});

			it("derives row token estimates from recent provider prompt history", () => {
				const previous = "a".repeat(400);
				const appended = "b".repeat(400);
				const calibration = textTokenCalibrationFromPromptHistory([
				{
					event_seq: 10,
					run_id: "run-calibration",
					purpose: "loop",
					messages_json: JSON.stringify([{ role: "user", content: previous }]),
					prompt_tokens: 100,
				},
				{
					event_seq: 11,
					run_id: "run-calibration",
					purpose: "loop",
					messages_json: JSON.stringify([
						{ role: "user", content: previous },
						{ role: "assistant", content: appended },
					]),
					prompt_tokens: 200,
				},
			]);

				expect(calibration.sampleCount).toBe(2);
				expect(calibration.tokensPerCharacter).toBeGreaterThan(0.2);
				expect(calibration.tokensPerCharacter).toBeLessThan(0.3);
			});

			it("derives calibration directly from retained request samples", () => {
				const calibration = textTokenCalibrationFromProviderTokenCalibrationSamples([
					{ prompt_tokens: 120, request_characters: 600 },
					{ prompt_tokens: 800, request_characters: 1_600 },
				]);

				expect(calibration.sampleCount).toBe(2);
				expect(calibration.tokensPerCharacter).toBeCloseTo(0.35);
			});

			it("uses only requested-model calibration samples for prompt estimates", () => {
				const queries: Array<{ sql: string; params: unknown[] }> = [];
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					state: {
						storage: {
							sql: {
								exec: <T,>(sql: string, ...params: unknown[]) => {
									queries.push({ sql, params });
									const requestedModel = String(params[0] ?? "");
									const rows =
										requestedModel === "model-a" ?
											[
												{
													id: 1,
													run_id: "run-a",
													request_seq: 10,
													attempt: 1,
													purpose: "loop",
													requested_model: "model-a",
													response_model: null,
													provider_base_url: "https://provider.example/api/v1",
													prompt_tokens: 500,
													request_characters: 1_000,
													created_at: "2026-05-01T00:00:00.000Z",
												},
											]
										:	[];
									return { toArray: () => rows as T[] };
								},
							},
						},
					},
				});
				const textTokenCalibration = (BotRuntime.prototype as unknown as {
					textTokenCalibration: (requestedModel?: string) => { tokensPerCharacter: number; sampleCount: number };
				}).textTokenCalibration.bind(runtime);

				expect(textTokenCalibration("model-a")).toEqual({ tokensPerCharacter: 0.5, sampleCount: 1 });
				expect(textTokenCalibration("model-b")).toEqual({ tokensPerCharacter: 0.25, sampleCount: 0 });
				expect(queries.map((query) => query.params[0])).toEqual(["model-a", "model-b"]);
				expect(queries[0]?.sql).toContain("FROM provider_token_calibration_samples");
				expect(queries[0]?.sql).toContain("requested_model = ?");
			});

			it("backfills calibration samples from retained legacy submissions by requested model", () => {
				const inserted: unknown[][] = [];
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					state: {
						storage: {
							sql: {
								exec: <T,>(sql: string, ...params: unknown[]) => {
									if (/SELECT value_json FROM runtime_state/.test(sql)) {
										return { toArray: () => [] as T[] };
									}
									if (/FROM inference_submissions s\s+JOIN provider_usage u/.test(sql)) {
										return {
											toArray: () => [
												{
													event_seq: 10,
													run_id: "run-a",
													purpose: "loop",
													messages_json: JSON.stringify([{ role: "user", content: "A".repeat(100) }]),
													requested_model: "model-a",
													response_model: "model-a-concrete",
													provider_base_url: "https://provider.example/api/v1",
													prompt_tokens: 50,
													created_at: "2026-05-01T00:00:00.000Z",
												},
												{
													event_seq: 11,
													run_id: "run-b",
													purpose: "compaction",
													messages_json: JSON.stringify([{ role: "assistant", content: "B".repeat(120) }]),
													requested_model: "model-b",
													response_model: null,
													provider_base_url: "https://provider.example/api/v1",
													prompt_tokens: 80,
													created_at: "2026-05-01T00:01:00.000Z",
												},
											] as T[],
										};
									}
									if (/INSERT INTO provider_token_calibration_samples/.test(sql)) {
										inserted.push(params);
									}
									return { toArray: () => [] as T[], one: () => ({}) as T };
								},
							},
						},
					},
					setRuntimeState: vi.fn(),
				});
				const backfillProviderTokenCalibrationSamples = (BotRuntime.prototype as unknown as {
					backfillProviderTokenCalibrationSamples: () => void;
				}).backfillProviderTokenCalibrationSamples.bind(runtime);

				backfillProviderTokenCalibrationSamples();

				expect(inserted).toHaveLength(2);
				expect(inserted[0]).toEqual(expect.arrayContaining(["run-a", 10, "loop", "model-a", "model-a-concrete"]));
				expect(inserted[1]).toEqual(expect.arrayContaining(["run-b", 11, "compaction", "model-b", null]));
				expect(runtime.setRuntimeState).toHaveBeenCalledWith("provider_token_calibration_samples_backfilled", true);
			});

			it("records compaction submissions before provider failures and marks the row failed", async () => {
				const candidates = Array.from({ length: 12 }, (_, index) => ({
					seq: index + 1,
					position: index + 1,
					run_id: "run-compaction-failure",
					role: "assistant",
					message_json: JSON.stringify({ role: "assistant", content: `Recent activity ${index + 1}` }),
					origin: "provider_response",
					status: "complete",
					token_estimate: 10,
					compacted_by: null,
					created_at: "2026-05-01T00:00:00.000Z",
					has_logs: 0,
				}));
				const appendEvent = vi.fn(async (runId: string, type: string, payload: unknown) => ({
					seq: 101,
					runId,
					type,
					payload,
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:00:01.000Z",
				}));
				const recordInferenceSubmission = vi.fn();
				const replaceEventPayload = vi.fn();
				const providerError = new Error("Provider returned an empty compaction response.");
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					env: {},
					state: {
						storage: {
							sql: {
								exec: <T,>(sql: string) => {
									if (/FROM events\s+WHERE compacted_by IS NULL/.test(sql)) {
										return { toArray: () => candidates as T[] };
									}
									return { one: () => ({} as T), toArray: () => [] as T[] };
								},
							},
						},
					},
					appendEvent,
					recordInferenceSubmission,
					callProviderForCompaction: async () => {
						throw providerError;
					},
					replaceEventPayload,
				});
				const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
					compactLoopMessageRows: (
						bot: { tickSettings: { contextWindowTokens: number } },
						settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
						runId: string,
						signal: AbortSignal,
						rows: unknown[],
						mode: "auto" | "manual",
						metrics: { estimatedContextTokens?: number; threshold?: number },
					) => Promise<void>;
				}).compactLoopMessageRows.bind(runtime);

			await expect(
				compactLoopMessageRows(
					{ tickSettings: { contextWindowTokens: 100 } },
					{ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-compaction-failure",
					new AbortController().signal,
					candidates,
					"auto",
					{ estimatedContextTokens: 10_000, threshold: 80 },
				),
			).rejects.toThrow("empty compaction response");

			expect(appendEvent).toHaveBeenCalledWith("run-compaction-failure", "compaction", expect.objectContaining({ status: "pending" }));
			expect(recordInferenceSubmission).toHaveBeenCalledWith(expect.objectContaining({
				seq: 101,
				purpose: "compaction",
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "system" }),
					expect.objectContaining({ role: "user" }),
				]),
			}));
			expect(replaceEventPayload).toHaveBeenCalledWith(expect.objectContaining({ seq: 101 }), expect.objectContaining({
				status: "failed",
				error: "Provider returned an empty compaction response.",
			}));
		});

		it("does not clamp over-budget fallback compaction output limits to the prompt budget", async () => {
			const candidates = [
				{
					seq: 1,
					position: 1,
					run_id: "run-compaction-over-budget-fallback",
					role: "assistant",
					message_json: JSON.stringify({ role: "assistant", content: "Huge atomic group." + "x".repeat(20_000) }),
					origin: "provider_response",
					status: "complete",
					token_estimate: 5_000,
					compacted_by: null,
					created_at: "2026-05-01T00:00:00.000Z",
					has_logs: 0,
				},
			];
			let capturedLimits: { maxLength: number; maxCompletionTokens: number } | null = null;
			const appendEvent = vi.fn(async (runId: string, type: string, payload: unknown) => ({
				seq: 102,
				runId,
				type,
				payload,
				tokenEstimate: 1,
				createdAt: "2026-05-01T00:00:01.000Z",
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				env: {},
				state: {
					storage: {
						sql: {
							exec: <T,>(sql: string) => {
								if (/FROM events\s+WHERE compacted_by IS NULL/.test(sql)) {
									return { toArray: () => candidates as T[] };
								}
								return { one: () => ({} as T), toArray: () => [] as T[] };
							},
						},
					},
				},
				appendEvent,
				recordInferenceSubmission: vi.fn(),
				callProviderForCompaction: async (_settings: unknown, _messages: unknown, _runId: string, _signal: AbortSignal, limits: { maxLength: number; maxCompletionTokens: number }) => {
					capturedLimits = limits;
					throw new Error("stop after capturing limits");
				},
				replaceEventPayload: vi.fn(),
			});
			const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
				compactLoopMessageRows: (
					bot: BotDocument,
					settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
					runId: string,
					signal: AbortSignal,
					rows: unknown[],
					mode: "auto" | "manual",
					metrics: { compactionOverBudgetFallback?: boolean },
				) => Promise<void>;
			}).compactLoopMessageRows.bind(runtime);

			await expect(
				compactLoopMessageRows(
					fakeBotDocument({ contextWindowTokens: 100, compactionMaxCharacters: 4_000 }),
					{ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-compaction-over-budget-fallback",
					new AbortController().signal,
					candidates,
					"auto",
					{ compactionOverBudgetFallback: true },
				),
			).rejects.toThrow("stop after capturing limits");

			expect(capturedLimits).toMatchObject({
				maxLength: 4_000,
			});
			const limits = capturedLimits as { maxLength: number; maxCompletionTokens: number } | null;
			if (!limits) {
				throw new Error("Expected compaction limits to be captured.");
			}
			expect(limits.maxCompletionTokens).toBeGreaterThan(100);
			expect(appendEvent).toHaveBeenCalledWith(
				"run-compaction-over-budget-fallback",
				"compaction",
				expect.objectContaining({ overBudgetFallback: true, status: "pending" }),
			);
		});

		it("reconstructs retained loop message logs from full, append, and tail-replacement entries", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: memoryLoopMessageLogSql(),
					},
				},
			});
			const recordLoopMessageLog = (BotRuntime.prototype as unknown as {
				recordLoopMessageLog: (messageSeq: number, kind: string, text: string) => void;
			}).recordLoopMessageLog.bind(runtime);
			const loopMessageLogsForSeq = (BotRuntime.prototype as unknown as {
				loopMessageLogsForSeq: (seq: number) => { logs: BotLoopMessageLog[] };
			}).loopMessageLogsForSeq.bind(runtime);

			const requestBase = "short request";
			const requestAppend = `${requestBase} with appended body`;
			const responseBase = `${"A".repeat(320)}old response tail`;
			const responseReplacement = `${"A".repeat(320)}new response tail`;
			recordLoopMessageLog(1, "provider_request", requestBase);
			recordLoopMessageLog(1, "provider_request", requestAppend);
			recordLoopMessageLog(1, "provider_response", responseBase);
			recordLoopMessageLog(1, "provider_response", responseReplacement);

			const logs = loopMessageLogsForSeq(1).logs;
			expect(logs.map((log) => log.encoding)).toEqual(["full", "append", "full", "replace_tail"]);
			expect(logs.map((log) => log.text)).toEqual([requestBase, requestAppend, responseBase, responseReplacement]);
			expect(logs[1]?.baseLogId).toBe(logs[0]?.id);
			expect(logs[3]?.baseLogId).toBe(logs[2]?.id);
			expect(logs[3]?.prefixLength).toBe(320);
		});

		it("adds request usage and cache badges to retained loop message logs", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: memoryLoopMessageLogSql({
							streamSeq: 77,
							providerUsage: {
								requestSeq: 77,
								promptTokens: 20,
								completionTokens: 5,
								totalTokens: 25,
								cachedTokens: 12,
								cost: 0.006,
								usageJson: {
									prompt_tokens: 20,
									completion_tokens: 5,
									total_tokens: 25,
									prompt_tokens_details: { cached_tokens: 12 },
									cost: 0.006,
									cost_details: {
										upstream_inference_prompt_cost: 0.003,
										upstream_inference_completions_cost: 0.003,
									},
								},
							},
						}),
					},
				},
				textTokenCalibration: () => ({ tokensPerCharacter: 1, sampleCount: 1 }),
			});
			const recordLoopMessageLog = (BotRuntime.prototype as unknown as {
				recordLoopMessageLog: (messageSeq: number, kind: string, text: string) => void;
			}).recordLoopMessageLog.bind(runtime);
			const loopMessageLogsForSeq = (BotRuntime.prototype as unknown as {
				loopMessageLogsForSeq: (seq: number) => {
					requestMessages?: Array<{ cacheStatus?: string; message: Record<string, unknown> }>;
					requestUsage?: {
						cachedInputTokens: number;
						uncachedInputTokens: number;
						outputTokens: number;
						cachedInputCost: number | null;
						uncachedInputCost: number | null;
						outputCost: number | null;
						totalCost: number | null;
						estimatedCostSplit: boolean;
					};
				};
			}).loopMessageLogsForSeq.bind(runtime);

			recordLoopMessageLog(1, "provider_request", JSON.stringify({
				messages: [
					{ role: "system", content: "aaaa" },
					{ role: "user", content: "bbbb" },
				],
			}));

			const result = loopMessageLogsForSeq(1);
			expect(result.requestUsage).toMatchObject({
				cachedInputTokens: 12,
				uncachedInputTokens: 8,
				outputTokens: 5,
				outputCost: 0.003,
				totalCost: 0.006,
				estimatedCostSplit: true,
			});
			expect(result.requestUsage?.cachedInputCost).toBeCloseTo(0.0018);
			expect(result.requestUsage?.uncachedInputCost).toBeCloseTo(0.0012);
			expect(result.requestMessages?.map((message) => message.cacheStatus)).toEqual(["cached", "partially_cached"]);
		});

		it("soft-deletes loop messages without removing retained raw logs", async () => {
			const sql = memoryLoopMessageLogSql();
			const broadcastControl = vi.fn();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql } },
				status: async () => ({ status: "idle" }),
				broadcastControl,
			});
			const recordLoopMessageLog = (BotRuntime.prototype as unknown as {
				recordLoopMessageLog: (messageSeq: number, kind: string, text: string) => void;
			}).recordLoopMessageLog.bind(runtime);
			const loopMessageLogsForSeq = (BotRuntime.prototype as unknown as {
				loopMessageLogsForSeq: (seq: number) => { message: BotLoopMessage; logs: BotLoopMessageLog[] };
			}).loopMessageLogsForSeq.bind(runtime);
			const deleteLoopMessage = (BotRuntime.prototype as unknown as {
				deleteLoopMessage: (botId: string, seq: number) => Promise<{ seq: number; deletedAt: string }>;
			}).deleteLoopMessage.bind(runtime);

			recordLoopMessageLog(1, "provider_request", "request body");
			recordLoopMessageLog(1, "provider_response", "response body");
			const deleted = await deleteLoopMessage("bot_log", 1);
			const retained = loopMessageLogsForSeq(1);

			expect(deleted.seq).toBe(1);
			expect(deleted.deletedAt).toMatch(/^20/);
			expect(retained.message.deletedAt).toBe(deleted.deletedAt);
			expect(retained.logs.map((log) => log.text)).toEqual(["request body", "response body"]);
			expect(broadcastControl).toHaveBeenCalledWith({
				type: "loop_message_deleted",
				seq: 1,
				deletedAt: deleted.deletedAt,
			});
		});

		it("pages retained loop messages by compaction boundaries", () => {
			const rows = [
				{ ...loopMessageRowForTest(1, "run-old", "Old event"), compacted_by: 10 },
				{ ...loopMessageRowForTest(10, "run-compact-1", "Previous summary"), origin: "compaction" as BotLoopMessage["origin"], compacted_by: 20 },
				{ ...loopMessageRowForTest(11, "run-middle", "Middle event"), compacted_by: 20 },
				{ ...loopMessageRowForTest(12, "run-deleted", "Deleted middle event"), compacted_by: 20, deleted_at: "2026-05-05T01:00:00.000Z" },
				{ ...loopMessageRowForTest(20, "run-compact-2", "Current summary"), origin: "compaction" as BotLoopMessage["origin"] },
				loopMessageRowForTest(21, "run-current", "Current event"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number; pageCount: number; newerPage?: number; olderPage?: number; compactionPageBySeq: Record<string, number> } };
			}).loopMessagesPage.bind(runtime);

			const page1 = loopMessagesPage({ page: 1 });
			const page2 = loopMessagesPage({ page: 2 });
			const page3 = loopMessagesPage({ page: 3 });

			expect(page1.messages.map((message) => message.seq)).toEqual([20, 21]);
			expect(page1.page).toMatchObject({
				currentPage: 1,
				pageCount: 3,
				olderPage: 2,
				compactionPageBySeq: { "20": 2, "10": 3 },
			});
			expect(page2.messages.map((message) => message.seq)).toEqual([10, 11]);
			expect(page2.page).toMatchObject({ currentPage: 2, newerPage: 1, olderPage: 3 });
			expect(page3.messages.map((message) => message.seq)).toEqual([1]);
			expect(page3.page).toMatchObject({ currentPage: 3, newerPage: 2 });
		});

		it("shows every active row on page one in context order", () => {
			const rows = [
				{ ...loopMessageRowForTest(1, "run-old", "Old event"), compacted_by: 10 },
				{ ...loopMessageRowForTest(10, "run-compact-1", "Previous active summary"), origin: "compaction" as BotLoopMessage["origin"] },
				{ ...loopMessageRowForTest(11, "run-middle", "Middle event"), compacted_by: 20 },
				{ ...loopMessageRowForTest(20, "run-compact-2", "Current summary"), origin: "compaction" as BotLoopMessage["origin"] },
				loopMessageRowForTest(21, "run-current", "Current event"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number; pageCount: number; newerPage?: number; olderPage?: number; compactionPageBySeq: Record<string, number> } };
			}).loopMessagesPage.bind(runtime);

			const page1 = loopMessagesPage({ page: 1 });
			const page2 = loopMessagesPage({ page: 2 });
			const page3 = loopMessagesPage({ page: 3 });

			expect(page1.messages.map((message) => message.seq)).toEqual([10, 20, 21]);
			expect(page1.page).toMatchObject({
				currentPage: 1,
				pageCount: 3,
				olderPage: 2,
				compactionPageBySeq: { "20": 2, "10": 3 },
			});
			expect(page2.messages.map((message) => message.seq)).toEqual([11]);
			expect(page2.page).toMatchObject({ currentPage: 2, newerPage: 1 });
			expect(page3.messages.map((message) => message.seq)).toEqual([1]);
			expect(page3.page).toMatchObject({ currentPage: 3, newerPage: 1 });
		});

		it("serializes loop message positions and orders active compaction summaries by context position", () => {
			const rows = [
				{ ...loopMessageRowForTest(1, "run-old", "Old event"), compacted_by: 100 },
				{ ...loopMessageRowForTest(20, "run-current", "Current event"), position: 10 },
				{ ...loopMessageRowForTest(100, "run-compact", "Current summary"), position: 5, origin: "compaction" as BotLoopMessage["origin"] },
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number } };
			}).loopMessagesPage.bind(runtime);

			const page1 = loopMessagesPage({ page: 1 });

			expect(page1.messages.map((message) => ({ seq: message.seq, position: message.position }))).toEqual([
				{ seq: 100, position: 5 },
				{ seq: 20, position: 10 },
			]);
		});

		it("keeps incremental loop message fetches on the active page only", () => {
			const rows = [
				{ ...loopMessageRowForTest(1, "run-old", "Old event"), compacted_by: 10 },
				{ ...loopMessageRowForTest(10, "run-compact", "Current summary"), origin: "compaction" as BotLoopMessage["origin"] },
				loopMessageRowForTest(11, "run-current", "Current event"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number } };
			}).loopMessagesPage.bind(runtime);

			expect(loopMessagesPage({ page: 1, after: 10 }).messages.map((message) => message.seq)).toEqual([11]);
			expect(loopMessagesPage({ page: 2, after: 99 }).messages.map((message) => message.seq)).toEqual([1]);
		});

		it("hydrates linked rich tool display payloads without changing minimized tool content", () => {
			const minimizedContent = JSON.stringify([
				{ threadId: "thr_rule", commentId: "cmt_match", forum: "f/rules", title: "Rule 82", author: "u/alice" },
			]);
			const displayPayload = {
				name: "search_threads",
				args: { query: "potato" },
				result: [{
					threadId: "thr_rule",
					commentId: "cmt_match",
					forumHandle: "rules",
					title: "Rule 82",
					snippet: "mashed potato discourse",
					authorHandle: "alice",
					authorDisplayName: "Alice",
				}],
				displayContext: { worldHandle: "sandbox" },
			};
			const rows: LoopMessageRowForTest[] = [
				{
					...loopMessageRowForMessage(1, { role: "tool", tool_call_id: "call-search", content: minimizedContent }, "tool_result"),
					display_event_seq: 42,
					display_event_type: "tool_result",
					display_event_payload_json: JSON.stringify(displayPayload),
				},
				loopMessageRowForMessage(2, { role: "tool", tool_call_id: "call-legacy", content: "{}" }, "tool_result"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number } };
			}).loopMessagesPage.bind(runtime);

			const [richMessage, legacyMessage] = loopMessagesPage({ page: 1 }).messages;

			expect(richMessage?.message.content).toBe(minimizedContent);
			expect(richMessage?.display).toEqual({
				kind: "tool_result",
				eventSeq: 42,
				name: "search_threads",
				args: displayPayload.args,
				result: displayPayload.result,
				context: { worldHandle: "sandbox" },
			});
			expect(legacyMessage?.display).toBeUndefined();
		});

		it("keeps compacted runtime diagnostics behind the active compaction summary", () => {
			const rows: LoopMessageRowForTest[] = [
				{ ...loopMessageRowForTest(1, "run-old", "Old provider event"), compacted_by: 10 },
				{
					...loopMessageRowForMessage(
						2,
						{ role: "user", content: runtimeErrorLoopMessageContent("Inference request failed with status 400.") },
						"runtime_error",
					),
					compacted_by: 10,
					origin: "runtime_error" as BotLoopMessage["origin"],
				},
				{ ...loopMessageRowForTest(10, "run-compact", "Current summary"), origin: "compaction" as BotLoopMessage["origin"] },
				loopMessageRowForTest(11, "run-current", "Current event"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number; olderPage?: number } };
			}).loopMessagesPage.bind(runtime);

			const page1 = loopMessagesPage({ page: 1 });
			const page2 = loopMessagesPage({ page: 2 });

			expect(page1.messages.map((message) => message.seq)).toEqual([10, 11]);
			expect(page1.page).toMatchObject({ currentPage: 1, olderPage: 2 });
			expect(page2.messages.map((message) => message.seq)).toEqual([1, 2]);
		});

		it("uses the latest successful compaction summary after a failed compaction row", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: {
							exec: <T,>(sql: string) => {
								if (/FROM events\s+WHERE type = 'compaction'/.test(sql)) {
									return {
										toArray: () => [
											{ payload_json: JSON.stringify({ status: "failed", error: "No response." }) },
											{ payload_json: JSON.stringify({ status: "complete", summary: "I owe Müller a follow-up." }) },
										] as T[],
									};
								}
								return { one: () => ({} as T), toArray: () => [] as T[] };
							},
						},
					},
				},
			});
			const latestCompactionSummary = (BotRuntime.prototype as unknown as {
				latestCompactionSummary: () => string;
			}).latestCompactionSummary.bind(runtime);

			expect(latestCompactionSummary()).toBe("I owe Müller a follow-up.");
		});

		it("stores provider compaction summaries without adding a memory prefix", async () => {
			const candidates = [
				{
					...loopMessageRowForTest(1, "run-compaction-success", "I read the changelog thread."),
					position: 3,
					token_estimate: 10,
				},
				{
					...loopMessageRowForTest(2, "run-compaction-success", "I checked the replies."),
					position: 7,
					token_estimate: 10,
				},
			];
			const appendEvent = vi.fn(async (runId: string, type: string, payload: unknown) => ({
				seq: 101,
				runId,
				type,
				payload,
				tokenEstimate: 1,
				createdAt: "2026-05-01T00:00:01.000Z",
			}));
			const insertLoopMessage = vi.fn((input: { runId: string; message: unknown; position: number }) => ({
				seq: 102,
				runId: input.runId,
				message: input.message,
				position: input.position,
				createdAt: "2026-05-01T00:00:02.000Z",
			}));
			const replaceEventPayload = vi.fn();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				env: {},
				state: {
					storage: {
						sql: {
							exec: vi.fn(() => ({ one: () => ({}), toArray: () => [] })),
						},
					},
				},
				appendEvent,
				recordInferenceSubmission: vi.fn(),
				callProviderForCompaction: async () => ({
					content: "I chose to follow up with Müller about concise release notes.",
					requestBody: "{}",
					rawResponse: "{}",
				}),
				replaceEventPayload,
				insertLoopMessage,
				recordLoopMessageLog: vi.fn(),
				nextLoopMessagePosition: () => 50,
			});
			const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
				compactLoopMessageRows: (
					bot: BotDocument,
					settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
					runId: string,
					signal: AbortSignal,
					rows: unknown[],
					mode: "auto" | "manual",
					metrics: { estimatedContextTokens?: number; threshold?: number },
				) => Promise<void>;
			}).compactLoopMessageRows.bind(runtime);

			await compactLoopMessageRows(
				fakeBotDocument({
					id: "bot_release",
					handle: "release-sage",
					displayName: "Release Sage",
					shortBio: "Summarizes release work.",
					prompt: "Prefer concise changelog memory.",
				}),
				{ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-compaction-success",
				new AbortController().signal,
				candidates,
				"auto",
				{ estimatedContextTokens: 10_000, threshold: 80 },
			);

			expect(insertLoopMessage).toHaveBeenCalledWith(expect.objectContaining({
				message: {
					role: "assistant",
					content: "I chose to follow up with Müller about concise release notes.",
				},
				position: 7,
			}));
			expect(replaceEventPayload).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 101 }), expect.objectContaining({
				status: "complete",
				summary: "I chose to follow up with Müller about concise release notes.",
			}));
		});

		it("marks runtime diagnostics in the compacted ledger span while sending provider-visible synthetic context", async () => {
			const rows: LoopMessageRowForTest[] = [
				loopMessageRowForTest(1, "run-ledger-compact", "Provider-visible old context."),
				{
					...loopMessageRowForMessage(
						2,
						{ role: "assistant", content: defaultReasoningPrefill("budget-bot") },
						"synthetic_context",
					),
					origin: "synthetic_context" as BotLoopMessage["origin"],
				},
				{
					...loopMessageRowForMessage(
						3,
						{ role: "user", content: runtimeErrorLoopMessageContent("Inference request failed with status 400.") },
						"runtime_error",
					),
					origin: "runtime_error" as BotLoopMessage["origin"],
				},
				loopMessageRowForTest(4, "run-ledger-compact", "Provider-visible newer context."),
				{
					...loopMessageRowForMessage(
						5,
						{ role: "user", content: runtimeErrorLoopMessageContent("Inference request failed with status 404.") },
						"runtime_error",
					),
					origin: "runtime_error" as BotLoopMessage["origin"],
				},
			];
			const appendEvent = vi.fn(async (runId: string, type: string, payload: unknown) => ({
				seq: 101,
				runId,
				type,
				payload,
				tokenEstimate: 1,
				createdAt: "2026-05-01T00:00:01.000Z",
			}));
			const recordInferenceSubmission = vi.fn();
			const callProviderForCompaction = vi.fn(async (_settings: unknown, _messages: unknown[]) => ({
				content: "I kept the provider-visible context.",
				requestBody: "{}",
				rawResponse: "{}",
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				env: {},
				state: {
					storage: {
						sql: {
							exec: vi.fn(<T,>(sql: string, ...params: unknown[]) => {
								if (/FROM loop_messages m\s+WHERE m\.compacted_by IS NULL/.test(sql)) {
									return {
										toArray: () =>
											rows
												.filter((row) => row.compacted_by === null && row.deleted_at === null)
												.sort((left, right) => left.position - right.position || left.seq - right.seq) as T[],
									};
								}
								if (/UPDATE loop_messages\s+SET compacted_by = \?/.test(sql)) {
									const row = rows.find((item) => item.seq === Number(params[1]));
									if (row && row.compacted_by === null) {
										row.compacted_by = Number(params[0]);
									}
								}
								return { one: () => ({} as T), toArray: () => [] as T[] };
							}),
						},
					},
				},
				appendEvent,
				recordInferenceSubmission,
				callProviderForCompaction,
				replaceEventPayload: vi.fn(),
				insertLoopMessage: vi.fn((input: { runId: string; message: unknown; position: number }) => ({
					seq: 102,
					runId: input.runId,
					message: input.message,
					position: input.position,
					createdAt: "2026-05-01T00:00:02.000Z",
				})),
				recordLoopMessageLog: vi.fn(),
				updateInferenceSubmissionDisplayMessages: vi.fn(),
				broadcastControl: vi.fn(),
			});
			const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
				compactLoopMessageRows: (
					bot: BotDocument,
					settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
					runId: string,
					signal: AbortSignal,
					rows: unknown[],
					mode: "auto" | "manual",
					metrics: { estimatedContextTokens?: number; threshold?: number },
				) => Promise<void>;
			}).compactLoopMessageRows.bind(runtime);

			await compactLoopMessageRows(
				fakeBotDocument(),
				{ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-ledger-compact",
				new AbortController().signal,
				[rows[0], rows[1], rows[3]],
				"auto",
				{ estimatedContextTokens: 10_000, threshold: 80 },
			);

			const providerMessages = callProviderForCompaction.mock.calls[0]?.[1] as Array<{ content?: unknown }> | undefined;
			const providerText = JSON.stringify(providerMessages);
			expect(providerText).toContain("Provider-visible old context.");
			expect(providerText).toContain(defaultReasoningPrefill("budget-bot"));
			expect(providerText).toContain("Provider-visible newer context.");
			expect(providerText).not.toContain("Inference request failed with status 400");
			expect(rows.map((row) => row.compacted_by)).toEqual([102, 102, 102, 102, null]);
			expect(recordInferenceSubmission).toHaveBeenCalledWith(expect.objectContaining({
				messages: providerMessages,
			}));
		});

		it("shrinks the compaction row batch after provider output length exhaustion", async () => {
			const originalFetch = globalThis.fetch;
			const large = (label: string) => `${label} ${"x".repeat(4_000)}`;
			const rows = [
				loopMessageRowForTest(1, "run-old", large("Old context one that can be compacted.")),
				loopMessageRowForTest(2, "run-old", large("Old context two that should remain active after the shrink retry.")),
				loopMessageRowForTest(3, "run-old", large("Old context three that should remain active after the shrink retry.")),
			];
			const lengthResponse = {
				choices: [{
					finish_reason: "length",
					native_finish_reason: "max_output_tokens",
					message: { role: "assistant", content: null },
				}],
				usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember old context one." }),
					},
				}],
				usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(lengthResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
				vi.stubGlobal("fetch", fetchMock);
				try {
					const replaceEventPayload = vi.fn();
					const recordProviderTokenCalibrationSample = vi.fn();
					const runtime = Object.assign(Object.create(BotRuntime.prototype), {
						env: { BICKR_SIMULATION_MODE: "provider" },
					state: {
						storage: {
							sql: {
								exec: vi.fn((sql: string, ...params: unknown[]) => {
									if (/UPDATE loop_messages/i.test(sql)) {
										const compactedBy = Number(params[0]);
										const seq = Number(params[1]);
										const row = rows.find((item) => item.seq === seq);
										if (row) {
											row.compacted_by = compactedBy;
										}
									}
									return { one: () => ({}), toArray: () => [] };
								}),
							},
						},
						},
						appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
							runtimeEvent(500, runId, type as BotRuntimeEvent["type"], payload),
						broadcastControl: vi.fn(),
						compactionLedgerRows: (providerRows: typeof rows) => providerRows,
					insertLoopMessage: vi.fn((input: { runId: string; message: unknown; position: number }) => ({
						seq: 900,
						runId: input.runId,
						message: input.message,
						position: input.position,
						createdAt: "2026-05-01T00:00:02.000Z",
					})),
						recordInferenceSubmission: vi.fn(),
						recordLoopMessageLog: vi.fn(),
						recordProviderTokenCalibrationSample,
						recordProviderUsage: vi.fn(),
					repairDanglingCommentReferencesAfterCompaction: vi.fn(),
					replaceEventPayload,
					textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
					throwIfStopped: (_runId: string, signal: AbortSignal) => {
						if (signal.aborted) {
							throw new Error("Unexpected abort.");
						}
					},
					updateInferenceSubmissionDisplayMessages: vi.fn(),
				});
				const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
					compactLoopMessageRows: (
						bot: BotDocument,
						settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
						runId: string,
						signal: AbortSignal,
						rows: unknown[],
						mode: "auto" | "manual",
						metrics: Record<string, unknown>,
					) => Promise<void>;
				}).compactLoopMessageRows.bind(runtime);

				await compactLoopMessageRows(
					fakeBotDocument(),
					{ apiKey: "test-key", baseUrl: customProviderBaseUrl, model: "test-model", temperature: 0.2 },
					"run-output-limit-shrink",
					new AbortController().signal,
					rows,
					"auto",
					{},
				);

				expect(fetchMock).toHaveBeenCalledTimes(2);
				const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(JSON.stringify(firstBody.messages)).toContain("Old context three");
				expect(JSON.stringify(secondBody.messages)).toContain("Old context one");
				expect(JSON.stringify(secondBody.messages)).not.toContain("Old context two");
				expect(rows.map((row) => row.compacted_by)).toEqual([900, null, null]);
					expect(recordProviderTokenCalibrationSample).toHaveBeenCalledTimes(2);
					expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(1, expect.objectContaining({
						attempt: 1,
						usage: expect.objectContaining({ promptTokens: 100 }),
					}));
					expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(2, expect.objectContaining({
						attempt: 1,
						usage: expect.objectContaining({ promptTokens: 80 }),
					}));
					expect(replaceEventPayload).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
					status: "complete",
					fromSeq: 1,
					toSeq: 1,
					outputLimitShrinkAttempts: 1,
				}));
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("does not shrink output-limit retries down to a tiny prefix", async () => {
			const originalFetch = globalThis.fetch;
			const large = (char: string) => char.repeat(8_000);
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "Tiny summary." }, "compaction"),
				loopMessageRowForMessage(2, {
					role: "assistant",
					content: large("a"),
					tool_calls: [{
						id: "call-read",
						type: "function",
						function: { name: "read_thread", arguments: "{}" },
					}],
				}),
				loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-read", content: `Large read result ${large("b")}` }, "tool_result"),
				loopMessageRowForMessage(4, { role: "assistant", content: `Later context ${large("c")}` }),
			] as LoopMessageRowForTest[];
			const lengthResponse = {
				choices: [{
					finish_reason: "length",
					native_finish_reason: "max_output_tokens",
					message: { role: "assistant", content: null },
				}],
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the tiny summary and large read result." }),
					},
				}],
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(lengthResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const replaceEventPayload = vi.fn();
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					env: { BICKR_SIMULATION_MODE: "provider" },
					state: {
						storage: {
							sql: {
								exec: vi.fn((sql: string, ...params: unknown[]) => {
									if (/UPDATE loop_messages/i.test(sql)) {
										const compactedBy = Number(params[0]);
										const seq = Number(params[1]);
										const row = rows.find((item) => item.seq === seq);
										if (row) {
											row.compacted_by = compactedBy;
										}
									}
									return { one: () => ({}), toArray: () => [] };
								}),
							},
						},
					},
					appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
						runtimeEvent(501, runId, type as BotRuntimeEvent["type"], payload),
					broadcastControl: vi.fn(),
					compactionLedgerRows: (providerRows: typeof rows) => providerRows,
					insertLoopMessage: vi.fn((input: { runId: string; message: unknown; position: number }) => ({
						seq: 901,
						runId: input.runId,
						message: input.message,
						position: input.position,
						createdAt: "2026-05-01T00:00:02.000Z",
					})),
					recordInferenceSubmission: vi.fn(),
					recordLoopMessageLog: vi.fn(),
					recordProviderTokenCalibrationSample: vi.fn(),
					recordProviderUsage: vi.fn(),
					repairDanglingCommentReferencesAfterCompaction: vi.fn(),
					replaceEventPayload,
					textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
					throwIfStopped: (_runId: string, signal: AbortSignal) => {
						if (signal.aborted) {
							throw new Error("Unexpected abort.");
						}
					},
					updateInferenceSubmissionDisplayMessages: vi.fn(),
				});
				const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
					compactLoopMessageRows: (
						bot: BotDocument,
						settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
						runId: string,
						signal: AbortSignal,
						rows: unknown[],
						mode: "auto" | "manual",
						metrics: Record<string, unknown>,
					) => Promise<void>;
				}).compactLoopMessageRows.bind(runtime);

				await compactLoopMessageRows(
					fakeBotDocument(),
					{ apiKey: "test-key", baseUrl: customProviderBaseUrl, model: "test-model", temperature: 0.2 },
					"run-output-limit-tiny-prefix",
					new AbortController().signal,
					rows,
					"auto",
					{},
				);

				expect(fetchMock).toHaveBeenCalledTimes(2);
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(JSON.stringify(secondBody.messages)).toContain("Tiny summary.");
				expect(JSON.stringify(secondBody.messages)).toContain("Large read result");
				expect(JSON.stringify(secondBody.messages)).not.toContain("Later context");
				expect(rows.map((row) => row.compacted_by)).toEqual([901, 901, 901, null]);
				expect(replaceEventPayload).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
					status: "complete",
					fromSeq: 1,
					toSeq: 3,
					messageCount: 3,
					outputLimitShrinkAttempts: 1,
				}));
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("uses the computed next compaction point for soft compaction", async () => {
			const row = loopMessageRowForTest(1, "run-threshold", "Old context.");
			const compactLoopMessageRows = vi.fn();
			const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const expectedLimits = providerCompactionSummaryLimitsForChat(
				bot,
				[{ role: "assistant", content: "Old context." }],
				calibration,
			);
			let promptTokens = expectedLimits.nextCompactionTokens;
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeProviderRequestMessages: () => [{ role: "system", content: "System." }, { role: "assistant", content: "Old context." }],
				currentCompactionContextEstimate: () => ({ totalTokens: 4, rowTokens: 4, rows: [{ row, tokens: 4 }], calibration }),
				compactionRowsForEstimatedBudget: () => [row],
				compactLoopMessageRows,
				estimateProviderPromptTokens: () => providerPromptEstimateForTokens(promptTokens),
			});
			const compactIfNeeded = (BotRuntime.prototype as unknown as {
				compactIfNeeded: (
					bot: BotDocument,
					settings: Record<string, unknown>,
					runId: string,
					signal: AbortSignal,
				) => Promise<void>;
			}).compactIfNeeded.bind(runtime);

			await compactIfNeeded(bot, {}, "run-threshold", new AbortController().signal);
			expect(compactLoopMessageRows).not.toHaveBeenCalled();

			promptTokens = expectedLimits.nextCompactionTokens + 1;
			await compactIfNeeded(bot, {}, "run-threshold", new AbortController().signal);
			expect(compactLoopMessageRows).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"run-threshold",
				expect.any(AbortSignal),
				[row],
				"auto",
				expect.objectContaining({
					estimatedContextTokens: 4,
					estimatedPromptTokens: expectedLimits.nextCompactionTokens + 1,
					threshold: expectedLimits.nextCompactionTokens,
				}),
			);
		});

		it("hydrates only the newest dangling comment reference after compaction", () => {
			const toolRow = (seq: number, position: number, content: unknown) => ({
				seq,
				position,
				run_id: "run-repair",
				role: "tool",
				message_json: JSON.stringify({
					role: "tool",
					tool_call_id: `call_${seq}`,
					content: JSON.stringify(content),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
				stream_seq: null,
				compacted_by: null,
				deleted_at: null,
				created_at: "2026-05-01T00:00:00.000Z",
				has_logs: 0,
			});
			const rows = [
				toolRow(20, 20, { content: [{ type: "comment", id: "cmt_a", commentId: "cmt_a", threadId: "thr_repair" }] }),
				toolRow(21, 21, {
					content: [
						{ type: "comment", id: "cmt_b", commentId: "cmt_b", threadId: "thr_repair" },
						{ type: "comment", id: "cmt_c", commentId: "cmt_c", threadId: "thr_repair", body: "Still anchored." },
					],
				}),
				toolRow(22, 22, {
					content: [
						{ type: "comment", id: "cmt_a", commentId: "cmt_a", threadId: "thr_repair" },
						{ type: "comment", id: "cmt_b", commentId: "cmt_b", threadId: "thr_repair" },
					],
				}),
			];
			const sql = {
				exec: vi.fn(<T,>(query: string, ...params: unknown[]) => {
					const normalized = query.trim().replace(/\s+/g, " ");
					if (/FROM loop_messages m WHERE m\.compacted_by IS NULL/.test(normalized)) {
						const minPosition = Number(params[0]);
						const samePosition = Number(params[1]);
						const minSeq = Number(params[2]);
						return {
							toArray: () =>
								rows
									.filter((row) => row.compacted_by === null && row.deleted_at === null && row.role === "tool")
									.filter((row) => row.position > minPosition || (row.position === samePosition && row.seq > minSeq))
									.sort((left, right) => left.position - right.position || left.seq - right.seq) as T[],
						};
					}
					if (/UPDATE loop_messages SET message_json = \?, token_estimate = \? WHERE seq = \?/.test(normalized)) {
						const row = rows.find((item) => item.seq === Number(params[2]));
						if (row) {
							row.message_json = String(params[0]);
							row.token_estimate = Number(params[1]);
						}
					}
					return {
						one: () => ({} as T),
						toArray: () => [] as T[],
					};
				}),
			};
			const recordLoopMessageLog = vi.fn();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql } },
				recordLoopMessageLog,
			});
			const repair = (BotRuntime.prototype as unknown as {
				repairDanglingCommentReferencesAfterCompaction: (
					summarySeq: number,
					summaryPosition: number,
					summaryMessage: { role: "assistant"; content: string },
					compactedCommentBodies: ReadonlyMap<string, string>,
				) => void;
			}).repairDanglingCommentReferencesAfterCompaction.bind(runtime);

			repair(
				10,
				10,
				{ role: "assistant", content: "Compacted summary without structured comment JSON." },
				new Map([
					["cmt_a", "Hydrated A."],
					["cmt_b", "Hydrated B."],
					["cmt_c", "Hydrated C."],
				]),
			);

			const contentForRow = (seq: number) =>
				JSON.parse(JSON.parse(rows.find((row) => row.seq === seq)?.message_json ?? "{}").content) as { content: Array<Record<string, unknown>> };
			expect(contentForRow(20).content[0]?.body).toBeUndefined();
			expect(contentForRow(21).content[0]?.body).toBeUndefined();
			expect(contentForRow(21).content[1]?.body).toBe("Still anchored.");
			expect(contentForRow(22).content).toEqual([
				expect.objectContaining({ id: "cmt_a", commentId: "cmt_a", body: "Hydrated A." }),
				expect.objectContaining({ id: "cmt_b", commentId: "cmt_b", body: "Hydrated B." }),
			]);
			expect(rows.find((row) => row.seq === 22)?.token_estimate).toBeGreaterThan(1);
			expect(recordLoopMessageLog.mock.calls.map((call) => call.slice(0, 2))).toEqual([
				[22, "message"],
				[22, "tool_result"],
			]);
		});

		it("builds translation requests with required tool output", () => {
			const request = providerTranslationRequest(
				{
					baseUrl: customProviderBaseUrl,
					model: "openai/gpt-4o-mini",
					providerRouting: { max_price: { prompt: 0.2, completion: 0.4 } },
					prompt: "Translate to Pirate.",
					reasoningEffort: "low",
					temperature: 0,
				},
				"Hello world.",
			);

			expect(request.model).toBe("openai/gpt-4o-mini");
			expect(request.messages).toEqual([
				{ role: "system", content: "Translate to Pirate.\n\nYou MUST use one of the following tools: save_translation." },
				{
					role: "user",
					content: "Translate the following text. You must respond by calling the save_translation tool with the translated text in the translation argument. Do not reply as plain text.\n\nText:\nHello world.",
				},
			]);
			expect(request.provider).toEqual({ max_price: { prompt: 0.2, completion: 0.4 } });
			const translationTool = request.tools[0] as Extract<ProviderToolDefinition, { type: "function" }>;
			expect(translationTool.function.name).toBe("save_translation");
			expect(request.tool_choice).toBe("required");
			expect(request.parallel_tool_calls).toBe(false);
			expect(request.stream).toBe(false);
			expect(request.temperature).toBe(0);
			expect(request.reasoning).toEqual({ effort: "low", exclude: false });
			expect(translationTool.function.parameters).toEqual({
				type: "object",
				properties: {
					translation: { type: "string" },
				},
				required: ["translation"],
				additionalProperties: false,
			});
			expect("response_format" in request).toBe(false);

			const railroadRequest = providerTranslationRequest(
				{
					baseUrl: customProviderBaseUrl,
					model: "openai/gpt-4o-mini",
					prompt: "Translate to Pirate.",
					temperature: 0,
					toolCalls: "railroad",
				},
				"Hello world.",
			);
			expect("tool_choice" in railroadRequest).toBe(false);
			expect(railroadRequest.messages[0]?.content).toContain("You MUST use one of the following tools: save_translation.");
		});

	it("builds reasoning prefill defaults and preserves explicit trailing whitespace", () => {
		expect(defaultReasoningPrefill("release-sage")).toBe(
			"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
		);
		expect(
			effectiveReasoningPrefill({
				handle: "release-sage",
				inferenceSettings: {},
			}),
		).toBe("I'm u/release-sage. I need to think about how I feel and what I want to do next.");
		expect(
			effectiveReasoningPrefill({
				handle: "release-sage",
				inferenceSettings: { reasoningPrefill: "I am Release Sage, and I  " },
			}),
		).toBe("I am Release Sage, and I  ");
		expect(
			effectiveReasoningPrefill({
				handle: "release-sage",
				inferenceSettings: { recurringPromptEnabled: false },
			}),
		).toBeUndefined();
		expect(
			providerMessagesWithReasoningPrefill(
				[{ role: "user", content: "hello" }],
				"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			),
		).toEqual([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			},
		]);
	});

	it("builds minimal provider probes for exact prompt-token counts", () => {
		const request = providerTokenProbeRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				providerRouting: { ignore: ["deepinfra"] },
				temperature: 0.2,
			},
			[{ role: "system", content: "Count this." }],
			toolDefinitions,
		);

			expect(request.stream).toBe(false);
			expect(request.max_tokens).toBe(1);
			expect(request.reasoning).toEqual({ effort: "minimal", exclude: false });
		expect(request.provider).toEqual({ ignore: ["deepinfra"] });
		expect(request.tool_choice).toBe("auto");
		expect(request.tools).toBe(toolDefinitions);

		const tunedRequest = providerTokenProbeRequest(
			{
				baseUrl: customProviderBaseUrl,
					model: "test-model",
					temperature: 0.2,
					reasoningEffort: "none",
					frequencyPenalty: -0.25,
				presencePenalty: 0.5,
				repetitionPenalty: 1.15,
			},
			[{ role: "system", content: "Count this." }],
			toolDefinitions,
		);
			expect(tunedRequest).toMatchObject({
				reasoning: { effort: "none", exclude: false },
				frequency_penalty: -0.25,
			presence_penalty: 0.5,
			repetition_penalty: 1.15,
		});
	});

	it("normalizes OpenRouter model capabilities for generated, unknown, free, and custom models", () => {
		const known = openRouterModelPolicy(capableOpenRouterModel);
		expect(known).toMatchObject({
			prefill: true,
			structuredOutputs: true,
			structuredOutputCompaction: true,
			requiredToolCalls: true,
			disabledReasoning: true,
			defaultCompactionMode: "structured_output",
			defaultReasoningEffort: "minimal",
			defaultToolCalls: "require",
		});
		expect(modelSupportsPrefill(capableOpenRouterModel, true)).toBe(true);
		expect(modelSupportsRequiredToolCalls(capableOpenRouterModel, true)).toBe(true);
		expect(modelSupportsStructuredOutputs(capableOpenRouterModel, true)).toBe(true);
		expect(effectiveReasoningEffortForModel(capableOpenRouterModel, true, "none")).toBe("none");

		const unknown = openRouterModelPolicy("unknown/provider-model");
		expect(unknown).toMatchObject({
			prefill: false,
			structuredOutputs: false,
			requiredToolCalls: false,
			disabledReasoning: false,
			defaultCompactionMode: "tool_call_cache_friendly",
			defaultToolCalls: "railroad",
		});
		expect(unknown.defaultReasoningEffort).toBeUndefined();
		expect(effectiveReasoningEffortForModel("unknown/provider-model", true, undefined)).toBeUndefined();
		expect(effectiveReasoningEffortForModel("unknown/provider-model", true, "none")).toBe("minimal");

		const free = openRouterModelPolicy(openRouterFreeModel);
		expect(free).toMatchObject({
			prefill: false,
			structuredOutputs: false,
			structuredOutputCompaction: false,
			requiredToolCalls: false,
			disabledReasoning: false,
			defaultCompactionMode: "tool_call_cache_friendly",
			defaultToolCalls: "railroad",
		});
		expect(free.defaultReasoningEffort).toBeUndefined();
		expect(effectiveCompactionModeForModel(openRouterFreeModel, true, "structured_output")).toBe("tool_call_cache_friendly");
		expect(effectiveSupportsPrefillForModel(openRouterFreeModel, true, true)).toBe(false);
		expect(effectiveStructuredToolCallsForModel(openRouterFreeModel, true, "require")).toBe("railroad");
		expect(effectiveToolCallsForModel(openRouterFreeModel, true, "at_will")).toBe("at_will");
		expect(modelSupportsPromptCacheControl("~anthropic/claude-sonnet-latest", true)).toBe(true);
		expect(modelSupportsPromptCacheControl("anthropic/claude-opus-4.1", true)).toBe(true);
		expect(modelSupportsPromptCacheControl("openai/gpt-5-mini", true)).toBe(false);

		const xiaomiFp8Routing = { only: ["xiaomi/fp8"] };
		const xiaomiFp8 = openRouterModelPolicy("xiaomi/mimo-v2.5", xiaomiFp8Routing);
		expect(xiaomiFp8).toMatchObject({
			structuredOutputs: true,
			structuredOutputCompaction: false,
			requiredToolCalls: true,
			defaultCompactionMode: "tool_call_cache_friendly",
			defaultToolCalls: "require",
		});
		expect(modelSupportsStructuredOutputs("xiaomi/mimo-v2.5", true, xiaomiFp8Routing)).toBe(true);
		expect(modelSupportsStructuredCompaction("xiaomi/mimo-v2.5", true, xiaomiFp8Routing)).toBe(false);
		expect(effectiveCompactionModeForModel("xiaomi/mimo-v2.5", true, "structured_output", xiaomiFp8Routing)).toBe(
			"tool_call_cache_friendly",
		);
		expect(effectiveStructuredToolCallsForModel("xiaomi/mimo-v2.5", true, "require", xiaomiFp8Routing)).toBe("require");

		expect(effectiveCompactionModeForModel("local/model", false, undefined)).toBe("structured_output");
		expect(effectiveReasoningEffortForModel("local/model", false, undefined)).toBe("minimal");
		expect(effectiveSupportsPrefillForModel("local/model", false, undefined)).toBe(true);
		expect(effectiveToolCallsForModel("local/model", false, undefined)).toBe("require");
	});

	it("resolves inference penalty settings from bot overrides before profile defaults", () => {
		const settings = effectiveProviderSettingsForBot(
			{ inferenceSettings: { frequencyPenalty: -0.25, repetitionPenalty: 1.2 } },
			{ inferenceSettings: { frequencyPenalty: 0.75, presencePenalty: 0.5, repetitionPenalty: 1.5 } },
			{},
		);

		expect(settings).toMatchObject({
			frequencyPenalty: -0.25,
			presencePenalty: 0.5,
			repetitionPenalty: 1.2,
		});
	});

	it("resolves tool-call mode settings and coerces translation at-will to railroad", () => {
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: {} },
				{},
			).toolCalls,
		).toBe("railroad");
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: {} },
				{ OPENROUTER_BASE_URL: customProviderBaseUrl },
			).toolCalls,
		).toBe("require");
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: { toolCalls: "railroad" } },
				{},
			).toolCalls,
		).toBe("railroad");
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { toolCalls: "at_will" } },
				{ inferenceSettings: { toolCalls: "railroad" } },
				{},
			).toolCalls,
		).toBe("at_will");

		expect(
			effectiveProviderSettingsForTranslation(
				{ inferenceSettings: { toolCalls: "at_will", translation: { enabled: true } } },
				{},
			)?.toolCalls,
		).toBe("railroad");
		expect(
			effectiveProviderSettingsForTranslation(
				{ inferenceSettings: { translation: { enabled: true, model: "translator/model", toolCalls: "railroad" } } },
				{},
			)?.toolCalls,
		).toBe("railroad");
	});

	it("resolves compaction mode and prefill support settings from bot overrides before profile defaults", () => {
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: {} },
				{},
			),
		).toMatchObject({
			compactionMode: "tool_call_cache_friendly",
			supportsPrefill: false,
		});
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: {} },
				{ OPENROUTER_BASE_URL: customProviderBaseUrl },
			),
		).toMatchObject({
			compactionMode: "structured_output",
			supportsPrefill: true,
		});
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: { compactionMode: "tool_call_cache_friendly", cacheFriendlyCompaction: true, supportsPrefill: false } },
				{},
			),
		).toMatchObject({
			compactionMode: "tool_call_cache_friendly",
			supportsPrefill: false,
		});
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { compactionMode: "tool_call", supportsPrefill: true } },
				{ inferenceSettings: { compactionMode: "tool_call_cache_friendly", supportsPrefill: false } },
				{},
			),
		).toMatchObject({
			compactionMode: "tool_call",
			supportsPrefill: false,
		});
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { cacheFriendlyCompaction: true } },
				{ inferenceSettings: { cacheFriendlyCompaction: true } },
				{},
			).compactionMode,
		).toBe("tool_call_cache_friendly");
		expect(
			effectiveProviderSettingsForBot(
				{
					inferenceSettings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "xiaomi/mimo-v2.5",
						compactionMode: "structured_output",
						providerRouting: { only: ["xiaomi/fp8"] },
					},
				},
				{ inferenceSettings: {} },
				{},
			),
		).toMatchObject({
			compactionMode: "tool_call_cache_friendly",
			providerRouting: { only: ["xiaomi/fp8"] },
		});
	});

	it("resolves prompt-cache mode only for OpenRouter Claude models", () => {
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{
					inferenceSettings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "~anthropic/claude-sonnet-latest",
						promptCacheMode: "openrouter_anthropic_5m",
					},
				},
				{},
			).promptCacheMode,
		).toBe("openrouter_anthropic_5m");
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { model: "~anthropic/claude-sonnet-latest", promptCacheMode: "openrouter_anthropic_1h" } },
				{
					inferenceSettings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "~anthropic/claude-sonnet-latest",
						promptCacheMode: "openrouter_anthropic_5m",
					},
				},
				{},
			).promptCacheMode,
		).toBe("openrouter_anthropic_1h");
		expect(
			effectiveProviderSettingsForBot(
				{
					inferenceSettings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "openai/gpt-5-mini",
						promptCacheMode: "openrouter_anthropic_1h",
					},
				},
				{ inferenceSettings: {} },
				{},
			).promptCacheMode,
		).toBeUndefined();
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { baseUrl: customProviderBaseUrl, model: "anthropic/claude-opus-4.1", promptCacheMode: "openrouter_anthropic_1h" } },
				{ inferenceSettings: {} },
				{},
			).promptCacheMode,
		).toBeUndefined();
	});

	it("resolves OpenRouter provider routing from bot overrides before profile defaults", () => {
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: { providerRouting: { max_price: { prompt: 0.25, completion: 0.75 } } } },
				{},
			).providerRouting,
		).toEqual({ max_price: { prompt: 0.25, completion: 0.75 } });
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { providerRouting: { order: ["openai"] } } },
				{ inferenceSettings: { providerRouting: { order: ["anthropic"] } } },
				{},
			).providerRouting,
		).toEqual({ order: ["openai"] });
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { providerRouting: {} } },
				{ inferenceSettings: { providerRouting: { order: ["anthropic"] } } },
				{},
			).providerRouting,
		).toBeUndefined();
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { baseUrl: "http://localhost:11434/v1", providerRouting: { order: ["openai"] } } },
				{ inferenceSettings: {} },
				{},
			).providerRouting,
		).toBeUndefined();
	});

	it("uses global inference defaults instead of profile fallbacks when a bot model is set", () => {
		const profileSettings = {
			openRouterApiKey: "sk-or-user",
			model: "profile/model",
			compactionMode: "tool_call_cache_friendly" as const,
			providerRouting: { order: ["anthropic"] },
			reasoningEffort: "high" as const,
			supportsPrefill: false,
			temperature: 0.4,
			toolCalls: "at_will" as const,
			topK: 12,
			topP: 0.7,
			minP: 0.1,
			frequencyPenalty: -0.5,
			presencePenalty: 0.25,
			repetitionPenalty: 1.2,
		};

		const inheritedBlocked = effectiveProviderSettingsForBot(
			{ inferenceSettings: { model: "bot/model" } },
			{ inferenceSettings: profileSettings },
			{},
		);

		expect(inheritedBlocked).toMatchObject({
			apiKey: "sk-or-user",
			baseUrl: "https://openrouter.ai/api/v1",
			compactionMode: "tool_call_cache_friendly",
			model: "bot/model",
			supportsPrefill: false,
			temperature: 1,
			toolCalls: "railroad",
		});
		expect(inheritedBlocked.providerRouting).toBeUndefined();
		expect(inheritedBlocked.reasoningEffort).toBeUndefined();
		expect(inheritedBlocked.topK).toBeUndefined();
		expect(inheritedBlocked.topP).toBeUndefined();
		expect(inheritedBlocked.minP).toBeUndefined();
		expect(inheritedBlocked.frequencyPenalty).toBeUndefined();
		expect(inheritedBlocked.presencePenalty).toBeUndefined();
		expect(inheritedBlocked.repetitionPenalty).toBeUndefined();

		expect(
			effectiveProviderSettingsForBot(
				{
					inferenceSettings: {
						model: "bot/model",
						compactionMode: "tool_call",
						providerRouting: { order: ["openai"] },
						reasoningEffort: "low",
						supportsPrefill: false,
						temperature: 0.2,
						toolCalls: "railroad",
						topP: 0.5,
					},
				},
				{ inferenceSettings: profileSettings },
				{},
			),
		).toMatchObject({
			apiKey: "sk-or-user",
			compactionMode: "tool_call",
			model: "bot/model",
			providerRouting: { order: ["openai"] },
			reasoningEffort: "low",
			supportsPrefill: false,
			temperature: 0.2,
			toolCalls: "railroad",
			topP: 0.5,
		});
	});

	it("groups token usage breakdown by requested model and provider", () => {
		const rows = [
			{
				...providerLoopUsageRowForTest(1, "2026-05-01T00:00:00.000Z", 100),
				model: "provider/concrete-a",
				requested_model: "requested/model-a",
				response_model: "provider/concrete-a",
				provider_name: "Provider One",
				total_tokens: 150,
			},
			{
				...providerLoopUsageRowForTest(2, "2026-05-01T00:05:00.000Z", 200),
				model: "provider/concrete-b",
				requested_model: "requested/model-a",
				response_model: "provider/concrete-b",
				provider_name: "Provider One",
				total_tokens: 275,
				context_window_tokens: 32_000,
			},
			{
				...providerLoopUsageRowForTest(3, "2026-05-01T00:10:00.000Z", 50),
				model: "provider/concrete-c",
				requested_model: "requested/model-a",
				response_model: "provider/concrete-c",
				provider_name: "Provider Two",
				total_tokens: 75,
			},
			{
				...providerLoopUsageRowForTest(4, "2026-05-01T00:15:00.000Z", 500),
				requested_model: "requested/model-z",
				provider_name: null,
				total_tokens: 550,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			providerUsageRows: () => rows,
			tokenUsageChangeMarkers: () => [],
			latestActiveLoopCompactionBoundary: () => null,
			latestLoopProviderUsage: () => null,
		});
		const tokenUsageStats = (BotRuntime.prototype as unknown as {
			tokenUsageStats: (bot: BotDocument, now?: Date) => BotTokenUsageStats;
		}).tokenUsageStats.bind(runtime);

		const usage = tokenUsageStats(fakeBotDocument({ contextWindowTokens: 16_000 }), new Date("2026-05-01T01:00:00.000Z"));

		expect(usage.last7Days.totalTokens).toBe(1_050);
		expect(usage.models.map((model) => [model.model, model.providerName, model.totalTokens])).toEqual([
			["requested/model-a", "Provider One", 425],
			["requested/model-a", "Provider Two", 75],
		]);
	});

	type ProviderUsageRowForSpendTest = Omit<ReturnType<typeof providerLoopUsageRowForTest>, "cost" | "requested_model"> & {
		cost: number | null;
		requested_model: string;
	};

	it("summarizes token spend over 24h and the current model period", () => {
		const rows: ProviderUsageRowForSpendTest[] = [
			{
				...providerLoopUsageRowForTest(1, "2026-05-03T00:00:00.000Z", 100),
				requested_model: "requested/old",
				cost: 0.9,
			},
			{
				...providerLoopUsageRowForTest(2, "2026-05-06T00:00:00.000Z", 100),
				requested_model: "requested/current",
				cost: 0.5,
			},
			{
				...providerLoopUsageRowForTest(3, "2026-05-07T12:00:00.000Z", 100),
				requested_model: "requested/current",
				cost: 0.25,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {});
		const tokenSpendSummaryForRows = (BotRuntime.prototype as unknown as {
			tokenSpendSummaryForRows: (
				botId: string,
				currentModel: string,
				rows: ProviderUsageRowForSpendTest[],
				now?: Date,
			) => BotTokenSpendSummary;
		}).tokenSpendSummaryForRows.bind(runtime);

		const spend = tokenSpendSummaryForRows("bot-spend", "requested/current", rows, new Date("2026-05-08T00:00:00.000Z"));

		expect(spend.last24Hours).toMatchObject({
			cost: 0.25,
			requestCount: 1,
			unknownCost: false,
		});
		expect(spend.average.requestCount).toBe(2);
		expect(spend.average.dayCount).toBe(2);
		expect(spend.average.costPerDay).toBeCloseTo(0.375);
		expect(spend.average.periodStart).toBe("2026-05-06T00:00:00.000Z");
	});

	it("reports zero average spend when the configured model has no tracked usage", () => {
		const rows: ProviderUsageRowForSpendTest[] = [
			{
				...providerLoopUsageRowForTest(1, "2026-05-07T12:00:00.000Z", 100),
				requested_model: "requested/old",
				cost: 0.25,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {});
		const tokenSpendSummaryForRows = (BotRuntime.prototype as unknown as {
			tokenSpendSummaryForRows: (
				botId: string,
				currentModel: string,
				rows: ProviderUsageRowForSpendTest[],
				now?: Date,
			) => BotTokenSpendSummary;
		}).tokenSpendSummaryForRows.bind(runtime);

		const spend = tokenSpendSummaryForRows("bot-spend", "requested/current", rows, new Date("2026-05-08T00:00:00.000Z"));

		expect(spend.last24Hours.cost).toBe(0.25);
		expect(spend.average).toMatchObject({
			costPerDay: 0,
			dayCount: 0,
			noCurrentModelUsage: true,
			requestCount: 0,
			unknownCost: false,
		});
	});

	it("marks token spend as unknown when provider usage omits cost", () => {
		const rows: ProviderUsageRowForSpendTest[] = [
			{
				...providerLoopUsageRowForTest(1, "2026-05-07T12:00:00.000Z", 100),
				requested_model: "requested/current",
				cost: null,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {});
		const tokenSpendSummaryForRows = (BotRuntime.prototype as unknown as {
			tokenSpendSummaryForRows: (
				botId: string,
				currentModel: string,
				rows: ProviderUsageRowForSpendTest[],
				now?: Date,
			) => BotTokenSpendSummary;
		}).tokenSpendSummaryForRows.bind(runtime);

		const spend = tokenSpendSummaryForRows("bot-spend", "requested/current", rows, new Date("2026-05-08T00:00:00.000Z"));

		expect(spend.last24Hours).toMatchObject({
			cost: null,
			requestCount: 1,
			unknownCost: true,
		});
		expect(spend.average).toMatchObject({
			costPerDay: null,
			requestCount: 1,
			unknownCost: true,
		});
	});

	it("lists owner token spend summaries from central D1 usage rows", async () => {
		const exportedAt = "2026-05-08T00:00:00.000Z";
		await recordBotInferenceUsageBatch(testEnv.BICKR_D1, [
			centralUsageRecordForTest({
				botId: "bot-a",
				ownerUserId: "user-spend",
				sourceUsageId: 1,
				runId: "run-old",
				requestSeq: 1,
				createdAt: "2026-05-05T00:00:00.000Z",
				requestedModel: "model/old",
				cost: 0.8,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-a",
				ownerUserId: "user-spend",
				sourceUsageId: 2,
				runId: "run-a",
				requestSeq: 10,
				createdAt: "2026-05-06T00:00:00.000Z",
				requestedModel: "model/current",
				cost: 0.4,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-a",
				ownerUserId: "user-spend",
				sourceUsageId: 3,
				runId: "run-a",
				requestSeq: 11,
				createdAt: "2026-05-07T12:00:00.000Z",
				requestedModel: "model/current",
				cost: 0.2,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-b",
				ownerUserId: "user-spend",
				sourceUsageId: 1,
				runId: "run-b",
				requestSeq: 1,
				createdAt: "2026-05-07T18:00:00.000Z",
				requestedModel: "model/current",
				cost: null,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-c",
				ownerUserId: "other-user",
				sourceUsageId: 1,
				runId: "run-c",
				requestSeq: 1,
				createdAt: "2026-05-07T18:00:00.000Z",
				requestedModel: "model/current",
				cost: 9,
				exportedAt,
			}),
		]);

		const summaries = await listOwnerBotTokenSpendSummaries(
			testEnv.BICKR_D1,
			"user-spend",
			[
				{ botId: "bot-a", currentModel: "model/current" },
				{ botId: "bot-b", currentModel: "model/current" },
				{ botId: "bot-empty", currentModel: "model/current" },
			],
			new Date("2026-05-08T00:00:00.000Z"),
		);
		const byId = new Map(summaries.map((summary) => [summary.botId, summary]));

		expect(byId.get("bot-a")?.last24Hours).toMatchObject({
			cost: 0.2,
			requestCount: 1,
			unknownCost: false,
		});
		expect(byId.get("bot-a")?.average.costPerDay).toBeCloseTo(0.3);
		expect(byId.get("bot-b")?.last24Hours).toMatchObject({
			cost: null,
			requestCount: 1,
			unknownCost: true,
		});
		expect(byId.get("bot-empty")?.last24Hours).toMatchObject({
			cost: 0,
			requestCount: 0,
			unknownCost: false,
		});
	});

	it("stores routed OpenRouter provider names with provider usage", async () => {
		const sql = capturingProviderUsageSql();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const recordProviderUsage = (BotRuntime.prototype as unknown as {
			recordProviderUsage: (input: RecordProviderUsageInputForTest) => Promise<void>;
		}).recordProviderUsage.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { provider_name: "Together" } })));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await recordProviderUsage(providerUsageInputForTest({
				providerResponseId: "gen-provider",
				settings: {
					apiKey: "sk-or-test",
					baseUrl: "https://openrouter.ai/api/v1",
					model: "requested/model",
					temperature: 0.2,
				},
			}));
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(fetchMock).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/generation?id=gen-provider",
			expect.objectContaining({
				headers: expect.objectContaining({ authorization: "Bearer sk-or-test" }),
			}),
		);
		expect(sql.providerNames()).toEqual(["Together"]);
	});

	it("stores OpenRouter router metadata provider names without generation lookup", async () => {
		const sql = capturingProviderUsageSql();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const recordProviderUsage = (BotRuntime.prototype as unknown as {
			recordProviderUsage: (input: RecordProviderUsageInputForTest) => Promise<void>;
		}).recordProviderUsage.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			await recordProviderUsage(providerUsageInputForTest({
				providerName: "Google AI Studio",
				providerResponseId: "gen-provider",
			}));
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sql.providerNames()).toEqual(["Google AI Studio"]);
	});

	it("opts OpenRouter streaming requests into router metadata and keeps the generation id header", async () => {
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {});
		const fetchProviderResponse = (BotRuntime.prototype as unknown as {
			fetchProviderResponse: (
				settings: Record<string, unknown>,
				endpoint: string,
				body: string,
				signal: AbortSignal,
			) => Promise<{ stream: ReadableStream<Uint8Array>; responseId?: string }>;
		}).fetchProviderResponse.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response(sseStream(["[DONE]"]), {
			headers: { "x-generation-id": "gen-header" },
		}));
		vi.stubGlobal("fetch", fetchMock);
		let response: { responseId?: string } | undefined;
		try {
			response = await fetchProviderResponse(
				{
					apiKey: "sk-or-test",
					baseUrl: "https://openrouter.ai/api/v1",
					model: "requested/model",
					temperature: 0.2,
				},
				"https://openrouter.ai/api/v1/chat/completions",
				"{}",
				new AbortController().signal,
			);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(fetchMock).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/chat/completions",
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-OpenRouter-Experimental-Metadata": "enabled",
					authorization: "Bearer sk-or-test",
				}),
			}),
		);
		expect(response?.responseId).toBe("gen-header");
	});

	it("keeps provider usage when OpenRouter provider metadata is unavailable", async () => {
		const sql = capturingProviderUsageSql();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const recordProviderUsage = (BotRuntime.prototype as unknown as {
			recordProviderUsage: (input: RecordProviderUsageInputForTest) => Promise<void>;
		}).recordProviderUsage.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })))
			.mockResolvedValueOnce(new Response("missing", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await recordProviderUsage(providerUsageInputForTest({ providerResponseId: "gen-missing" }));
			await recordProviderUsage(providerUsageInputForTest({ providerResponseId: "gen-failed" }));
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(sql.providerNames()).toEqual([null, null]);
	});

	it("stores direct provider hosts without OpenRouter metadata lookups", async () => {
		const sql = capturingProviderUsageSql();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const recordProviderUsage = (BotRuntime.prototype as unknown as {
			recordProviderUsage: (input: RecordProviderUsageInputForTest) => Promise<void>;
		}).recordProviderUsage.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			await recordProviderUsage(providerUsageInputForTest({
				settings: {
					apiKey: "direct-key",
					baseUrl: "https://api.provider.example/v1",
					model: "requested/model",
					temperature: 0.2,
				},
			}));
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sql.providerNames()).toEqual(["api.provider.example"]);
	});

	it("calculates prompt context budget segments and over-budget counts", () => {
		const totalReservedTokens = 2_000 + 1_500 + providerContextReserveTokens;
		expect(
			promptContextBudgetFromCounts({
				contextWindowTokens: 10_000,
				fixedSystemTokens: 2_000,
				personaPromptTokens: 1_500,
				responseReserveTokens: providerContextReserveTokens,
			}),
		).toMatchObject({
			remainingLoopTokens: Math.max(0, 10_000 - totalReservedTokens),
			overBudgetTokens: 0,
			totalReservedTokens,
		});

		expect(
			promptContextBudgetFromCounts({
				contextWindowTokens: 3_000,
				fixedSystemTokens: 2_000,
				personaPromptTokens: 1_500,
				responseReserveTokens: providerContextReserveTokens,
			}),
		).toMatchObject({
			remainingLoopTokens: 0,
			overBudgetTokens: Math.max(0, totalReservedTokens - 3_000),
			totalReservedTokens,
		});
	});

		it("reports context window breakdown from latest normal loop inference", () => {
			const baseline = providerLoopUsageRowForTest(10, "2026-05-01T00:00:00.000Z", 4_000);
			const latest = providerLoopUsageRowForTest(12, "2026-05-01T00:10:00.000Z", 6_500);
			const bot = fakeBotDocument({ contextWindowTokens: 20_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const expectedLimits = providerCompactionSummaryLimitsForChat(bot, [], calibration, toolDefinitionsForProviderRound());
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				providerUsageRows: () => [],
				tokenUsageChangeMarkers: () => [],
				textTokenCalibration: () => calibration,
				latestActiveLoopCompactionBoundary: () => null,
				latestLoopProviderUsage: () => latest,
				firstLoopProviderUsageAfterSeq: vi.fn(() => baseline),
			});
			const tokenUsageStats = (BotRuntime.prototype as unknown as {
				tokenUsageStats: (bot: BotDocument, now?: Date) => BotTokenUsageStats;
			}).tokenUsageStats.bind(runtime);

			const usage = tokenUsageStats(bot);

			expect(usage.contextWindow).toMatchObject({
				usedAt: latest.created_at,
				runId: latest.run_id,
				requestSeq: 12,
				promptTokens: 6_500,
				baselinePromptTokens: 4_000,
				initialTokens: 4_000,
				ongoingTokens: 2_500,
				freeTokens: 13_500,
				contextWindowTokens: 20_000,
				compactionCutoffTokens: expectedLimits.nextCompactionTokens,
				responseReserveTokens: providerContextReserveTokens,
			});
		});

		it("omits context window breakdown when the latest normal inference predates active compaction", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				providerUsageRows: () => [],
				tokenUsageChangeMarkers: () => [],
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
				latestActiveLoopCompactionBoundary: () => ({ messageSeq: 20, requestSeq: 120, created_at: "2026-05-01T00:05:00.000Z" }),
				latestLoopProviderUsage: () => providerLoopUsageRowForTest(12, "2026-05-01T00:20:00.000Z", 6_500),
				firstLoopProviderUsageAfterSeq: vi.fn(),
			});
			const tokenUsageStats = (BotRuntime.prototype as unknown as {
				tokenUsageStats: (bot: BotDocument, now?: Date) => BotTokenUsageStats;
			}).tokenUsageStats.bind(runtime);

			const usage = tokenUsageStats(fakeBotDocument({ contextWindowTokens: 16_000 }));

			expect(usage.contextWindow).toBeUndefined();
			expect(runtime.firstLoopProviderUsageAfterSeq).not.toHaveBeenCalled();
		});

		it("uses the first normal inference after active compaction as the context baseline", () => {
			const firstLoopProviderUsageAfterSeq = vi.fn(() => providerLoopUsageRowForTest(121, "2026-05-01T00:06:00.000Z", 5_500));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				providerUsageRows: () => [],
				tokenUsageChangeMarkers: () => [],
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
				latestActiveLoopCompactionBoundary: () => ({ messageSeq: 20, requestSeq: 120, created_at: "2026-05-01T00:05:00.000Z" }),
				latestLoopProviderUsage: () => providerLoopUsageRowForTest(124, "2026-05-01T00:20:00.000Z", 8_000),
				firstLoopProviderUsageAfterSeq,
			});
			const tokenUsageStats = (BotRuntime.prototype as unknown as {
				tokenUsageStats: (bot: BotDocument, now?: Date) => BotTokenUsageStats;
			}).tokenUsageStats.bind(runtime);

			const usage = tokenUsageStats(fakeBotDocument({ contextWindowTokens: 16_000 }));

			expect(firstLoopProviderUsageAfterSeq).toHaveBeenCalledWith(120);
			expect(usage.contextWindow).toMatchObject({
				baselineRequestSeq: 121,
				baselinePromptTokens: 5_500,
				initialTokens: 5_500,
				ongoingTokens: 2_500,
			});
		});

		it("queries context window usage from normal loop submissions only", () => {
			const queries: string[] = [];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: {
							exec: <T,>(sql: string) => {
								queries.push(sql);
								return { toArray: () => [providerLoopUsageRowForTest(31, "2026-05-01T00:30:00.000Z", 7_000) as T] };
							},
						},
					},
				},
			});
			const latestLoopProviderUsage = (BotRuntime.prototype as unknown as {
				latestLoopProviderUsage: () => unknown;
			}).latestLoopProviderUsage.bind(runtime);

			expect(latestLoopProviderUsage()).toMatchObject({ request_seq: 31, prompt_tokens: 7_000 });
			expect(queries[0]).toContain("s.purpose = 'loop'");
		});

		it("includes prompt, model, provider, and system fingerprints in context budget cache keys", async () => {
		const base = {
			botId: "bot_one",
			compactionMode: "structured_output" as const,
			effectiveModel: "openrouter/auto",
			fixedSystemFingerprint: "system-a",
			personaPromptFingerprint: "prompt-a",
			providerBaseUrl: "https://openrouter.ai/api/v1",
			supportsPrefill: true,
		};

		const original = await promptContextBudgetCacheFingerprint(base);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, personaPromptFingerprint: "prompt-b" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, worldPromptFingerprint: "world-b" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, effectiveModel: "anthropic/claude" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, providerBaseUrl: "https://example.test/v1" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, providerRouting: { max_price: { prompt: 0.25 } } }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, fixedSystemFingerprint: "system-b" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, compactionMode: "tool_call_cache_friendly" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, supportsPrefill: false }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({
				...base,
				fixedSystemFingerprint: JSON.stringify({
					system: "system-a",
					reasoningPrefill:
						"I'm u/bot-a. I need to think about how I feel and what I want to do next.",
				}),
			}),
		).resolves.not.toBe(
			await promptContextBudgetCacheFingerprint({
				...base,
				fixedSystemFingerprint: JSON.stringify({
					system: "system-a",
					reasoningPrefill:
						"I'm u/bot-b. I need to think about how I feel and what I want to do next.",
				}),
			}),
		);
	});

	it("formats runtime history as first-person notes instead of transcript commands", () => {
		const toolCall = formatRuntimeEventForContext("tool_call", {
			name: "read_thread_by_id",
			args: { threadId: "thr_read" },
		});
		expect(toolCall).toBe("I decided to read thread t/thr_read.");
		expect(toolCall).not.toMatch(/^Action:/);

		const toolResult = formatRuntimeEventForContext("tool_result", {
			name: "read_thread_by_id",
			args: { threadId: "thr_read" },
			result: {
				operation: "read_thread_by_id",
				thread: {
					id: "thr_read",
					threadId: "thr_read",
					forumHandle: "philosophy",
					title: "Is it real?",
					authorHandle: "alice",
					authorFollowing: true,
					commentCount: 1,
				},
				content: [
					{
						type: "thread",
						id: "thr_read",
						threadId: "thr_read",
						forumHandle: "philosophy",
						title: "Is it real?",
						authorHandle: "alice",
						authorFollowing: true,
						body: "Root body.",
					},
					{
						type: "comment",
						id: "cmt_read",
						commentId: "cmt_read",
						threadId: "thr_read",
						parentCommentId: "cmt_parent",
						forumHandle: "philosophy",
						authorHandle: "bob",
						authorFollowing: false,
						body: "Reply body.",
						"My focus is on this comment": true,
					},
				],
			},
		});
		expect(toolResult).toContain('I read thread t/thr_read in f/philosophy titled "Is it real?" by u/alice');
		expect(toolResult).toContain("I follow this profile");
		expect(toolResult).toContain("I do not follow this profile");
		expect(toolResult).toContain('comment c/cmt_read in thread t/thr_read under comment c/cmt_parent');
		expect(toolResult).not.toMatch(/^Result:|threadId=|commentId=/);

		const redundantUnfollow = formatRuntimeEventForContext("tool_result", {
			name: "unfollow_profile",
			args: {
				targets: [{ username: "bunnies", reason: "I've had enough of their threads." }],
			},
			result: {
				ok: false,
				code: "bad_request",
				message: "I do not follow u/bunnies. I should not use unfollow_profile for participants I do not follow.",
				guidance: "Use targets as an array of objects like {\"username\":\"alice\",\"reason\":\"specific reason\"}; each target needs a distinct non-empty reason.",
			},
		});
		expect(redundantUnfollow).toBe("Nevermind, I do not follow u/bunnies, so it is pointless to use unfollow_profile there. I'll do something else instead.");

		const assistantNote = formatRuntimeEventForContext("assistant_message", {
			content: "Action: read_thread_by_id threadId=thr_fake\nResult: read_thread_by_id returned 1",
		});
		expect(assistantNote).toContain("I wrote a transcript-like action line as text");
		expect(assistantNote).toContain("I wrote a transcript-like result line as text");
		expect(assistantNote).not.toContain("\n> Action:");
		expect(formatRuntimeEventForContext("provider_history_repaired", { count: 1 })).toBe("");

		const currentInput = formatRuntimeInputForContext({
			ping: false,
			injections: [],
			spotlightContexts: [],
			notifications: [
				{
					id: "ntf_read",
					type: "comment_created",
					createdAt: "2026-01-01T00:00:00.000Z",
					deliveryReasons: ["direct_reply"],
						message: lt("Someone replied."),
						thread: {
							id: "thr_read",
							title: lt("Is it real?"),
						},
						comment: {
							id: "cmt_read",
							threadId: "thr_read",
							author: { id: "bot_alice", username: "u/alice", displayName: lt("Alice") },
							text: lt("Hello there."),
						},
				},
			],
		});
		expect(currentInput).toContain("Bickr Terminal prepared 1 structured notification event.");
		expect(currentInput).toContain("comment_created notification ntf_read");
		expect(currentInput).toContain("Someone replied.");
		expect(currentInput).not.toContain("{");
	});

	it("builds a recovery reminder after no-tool ticks", () => {
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 1 })).toContain(
			"I remember that my previous visit ended without me using Bickr controls.",
		);
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 3 })).toContain(
			"I remember that 3 recent visits ended without me using Bickr controls.",
		);
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 1 })).toContain("use the page controls directly");
	});

	it("detects whether a new tick is continuing the iteration after the last logoff", () => {
		function started(rows: Array<{ seq: number; type: BotRuntimeEvent["type"]; payload: unknown }>): boolean {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: {
							exec<T>(sql: string, ...params: unknown[]) {
								if (/payload_json LIKE '%"name":"log_off"%'/s.test(sql)) {
									return {
										toArray: () => rows
											.filter((row) => row.type === "tool_result" && JSON.stringify(row.payload).includes('"name":"log_off"'))
											.sort((left, right) => right.seq - left.seq)
											.slice(0, 20)
											.map((row) => ({
												seq: row.seq,
												run_id: `run-${row.seq}`,
												type: row.type,
												payload_json: JSON.stringify(row.payload),
												token_estimate: 0,
												created_at: "2026-05-01T00:00:00.000Z",
												compacted_by: null,
											} as T)),
									};
								}
								if (/type = 'input'/s.test(sql)) {
									const afterSeq = Number(params[0]);
									return {
										toArray: () => rows.some((row) => row.seq > afterSeq && row.type === "input") ? [{ found: 1 } as T] : [],
									};
								}
								return { toArray: () => [] };
							},
						},
					},
				},
			});
			return (BotRuntime.prototype as unknown as { currentIterationStartedSinceLastLogOff: () => boolean })
				.currentIterationStartedSinceLastLogOff
				.bind(runtime)();
		}

		expect(started([{ seq: 1, type: "input", payload: { notifications: [] } }])).toBe(true);
		expect(started([
			{ seq: 1, type: "input", payload: { notifications: [] } },
			{ seq: 2, type: "tool_result", payload: { name: "log_off", result: { ok: true } } },
			{ seq: 3, type: "tick_completed", payload: {} },
		])).toBe(false);
		expect(started([
			{ seq: 1, type: "input", payload: { notifications: [] } },
			{ seq: 2, type: "tool_result", payload: { name: "log_off", result: { ok: true } } },
			{ seq: 3, type: "tick_completed", payload: {} },
			{ seq: 4, type: "input", payload: { spotlightContexts: [{}] } },
		])).toBe(true);
	});

	it("replays compacted ledger continuity transparently in future provider chats", async () => {
		const ledgerMessages: Array<{ role: string; content?: string | null }> = [
			{ role: "assistant", content: "I remember that I promised Müller I would follow up on release notes." },
			{ role: "assistant", content: "I should look for the changelog next." },
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			previousTerminalTickEvent: () => ({
				seq: 7,
				run_id: "run-previous",
				type: "tick_completed",
				payload_json: JSON.stringify({}),
				token_estimate: 1,
				created_at: "2026-05-01T00:00:00.000Z",
				compacted_by: null,
			}),
			appendLoopMessage: (_runId: string, message: { role: string; content?: string | null }) => {
				ledgerMessages.push(message);
				return {
					seq: ledgerMessages.length,
					runId: "run-current",
					role: message.role,
					message,
					origin: message.role === "assistant" ? "provider_response" : "input",
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:15:00.000Z",
				};
			},
			activeLoopMessagesForProvider: () => ledgerMessages,
			activeLoopMessageRows: () => [],
			profileUsernamesInActiveContext: () => new Set<string>(),
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: Parameters<typeof standardPrompt>[0] & Record<string, unknown>,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<{ role: string; content?: string | null }>>;
		}).buildMessages.bind(runtime);

		const messages = await buildMessages(
				{
					handle: "release-sage",
					language: testLanguage,
					displayName: lt("Release Sage"),
					shortBio: lt("Reads changelogs."),
					prompt: lt("Stay precise."),
					inferenceSettings: {},
				} as Parameters<typeof standardPrompt>[0],
			{
				notifications: [],
				injections: ["Check the daily thread."],
				spotlightContexts: [],
				ping: true,
			} as Record<string, unknown>,
			"run-current",
			"2026-05-01T00:15:00.000Z",
		);

		expect(messages[0]).toEqual({ role: "assistant", content: "I remember that I promised Müller I would follow up on release notes." });
		expect(messages[1]).toEqual({ role: "assistant", content: "I should look for the changelog next." });
		expect(messages.some((message) => message.role === "user" && message.content === "15 minutes later...")).toBe(true);
		expect(messages.some((message) => message.role === "assistant" && message.content === "I'm logging into Bickr and checking my notifications.")).toBe(true);
		expect(messages.some((message) => message.role === "assistant" && message.content === "Check the daily thread.")).toBe(true);
		expect(messages.some((message) => typeof message.content === "string" && message.content.includes("I have this private thought in mind."))).toBe(false);
		expect(messages.at(-1)).toEqual({
			role: "assistant",
			content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
		});
	});

	it("omits the recurring prompt when it is disabled", async () => {
		const ledgerMessages: Array<{ role: string; content?: string | null }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: { role: string; content?: string | null }) => {
				ledgerMessages.push(message);
				return {
					seq: ledgerMessages.length,
					runId: "run-no-recurring",
					role: message.role,
					message,
					origin: message.role === "assistant" ? "provider_response" : "input",
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:15:00.000Z",
				};
			},
			activeLoopMessagesForProvider: () => ledgerMessages,
			activeLoopMessageRows: () => [],
			profileUsernamesInActiveContext: () => new Set<string>(),
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: Parameters<typeof standardPrompt>[0] & Record<string, unknown>,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<{ role: string; content?: string | null }>>;
		}).buildMessages.bind(runtime);

		const messages = await buildMessages(
				{
					handle: "release-sage",
					language: testLanguage,
					displayName: lt("Release Sage"),
					shortBio: lt("Reads changelogs."),
					prompt: lt("Stay precise."),
					inferenceSettings: { recurringPromptEnabled: false },
				} as Parameters<typeof standardPrompt>[0],
			{
				notifications: [],
				injections: [],
				spotlightContexts: [],
				ping: false,
			} as Record<string, unknown>,
			"run-no-recurring",
			"2026-05-01T00:15:00.000Z",
		);

		expect(messages.some((message) => message.content === defaultReasoningPrefill("release-sage"))).toBe(false);
	});

	it("resumes the current iteration without notification or recurring setup", async () => {
		const ledgerMessages: Array<{ role: string; content?: string | null }> = [
			{ role: "assistant", content: "I am already in the middle of reading Bickr." },
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			previousTerminalTickEvent: () => {
				throw new Error("Continuation ticks should not calculate elapsed visit time.");
			},
			appendLoopMessage: (_runId: string, message: { role: string; content?: string | null }) => {
				ledgerMessages.push(message);
				return {
					seq: ledgerMessages.length,
					runId: "run-continuation",
					role: message.role,
					message,
					origin: message.role === "assistant" ? "provider_response" : "input",
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:15:00.000Z",
				};
			},
			activeLoopMessagesForProvider: () => ledgerMessages,
			activeLoopMessageRows: () => [],
			profileUsernamesInActiveContext: () => new Set<string>(),
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: Parameters<typeof standardPrompt>[0] & Record<string, unknown>,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<{ role: string; content?: string | null }>>;
		}).buildMessages.bind(runtime);

		const messages = await buildMessages(
				{
					handle: "release-sage",
					language: testLanguage,
					displayName: lt("Release Sage"),
					shortBio: lt("Reads changelogs."),
					prompt: lt("Stay precise."),
					inferenceSettings: {},
				} as Parameters<typeof standardPrompt>[0],
			{
				notifications: [{ message: "This should not be injected again." }],
				injections: ["Keep reading the daily thread."],
				spotlightContexts: [],
				ping: false,
				toolUseReminder: "Use Bickr controls directly.",
			} as Record<string, unknown>,
			"run-continuation",
			"2026-05-01T00:15:00.000Z",
			{ setupMode: "continuation" },
		);

		expect(messages.some((message) => message.role === "user" && message.content === "15 minutes later...")).toBe(false);
		expect(messages.some((message) => typeof message.content === "string" && message.content.includes("checking my notifications"))).toBe(false);
		expect(messages.some((message) => typeof message.content === "string" && message.content.includes("This should not be injected again."))).toBe(false);
		expect(messages.some((message) => typeof message.content === "string" && message.content.includes("Keep reading the daily thread."))).toBe(true);
		expect(messages.some((message) => message.content === "Use Bickr controls directly.")).toBe(true);
		expect(messages.at(-1)?.content).not.toBe("I'm u/release-sage. I need to think about how I feel and what I want to do next.");
	});

	it("enriches referenced profiles only when active uncompacted history lacks them", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "notice-self");
		const referencedProfile = await createBotForTest(cookie, "notice-alice");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const notification: NotificationEvent = {
			id: "ntf_profile_context",
			type: "comment_created",
			createdAt: "2026-05-01T00:00:00.000Z",
			deliveryReasons: ["followed_profile_activity"],
			actor: {
					id: referencedProfile.id,
					username: `u/${referencedProfile.handle}`,
					displayName: lt(referencedProfile.displayName),
					shortBio: lt("Repeated inside the raw notification."),
				},
				message: lt("Notice Alice commented."),
		};
		const profileToolRow = {
			seq: 1,
			position: 1,
			run_id: "run-previous",
			role: "tool",
			message_json: JSON.stringify({
				role: "tool",
				tool_call_id: "call_previous",
				content: JSON.stringify({
					profiles: [
						{
							username: `u/${referencedProfile.handle}`,
							displayName: lt(referencedProfile.displayName),
							shortBio: "Already active.",
						},
					],
				}),
			}),
			origin: "tool_result",
			status: "complete",
			token_estimate: 1,
			compacted_by: null,
			created_at: "2026-05-01T00:00:00.000Z",
			has_logs: 0,
		};
		async function buildWithActiveRows(activeRows: unknown[]): Promise<Array<Record<string, unknown>>> {
			const messages: Array<Record<string, unknown>> = [];
			let seq = 0;
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				env: {
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
				},
				previousTerminalTickEvent: () => null,
				appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
					messages.push(message);
					seq += 1;
					return { seq, runId: "run-profile-context", role: message.role, message };
				},
				readCommentTreeTokenBudget: async () => 10_000,
				activeLoopMessagesForProvider: () => messages,
				activeLoopMessageRows: () => activeRows,
			});
			const buildMessages = (BotRuntime.prototype as unknown as {
				buildMessages: (
					bot: BotDocument,
					input: Record<string, unknown>,
					runId: string,
					inputCreatedAt: string,
				) => Promise<Array<Record<string, unknown>>>;
			}).buildMessages.bind(runtime);
			return buildMessages(
				bot,
				{ notifications: [notification], injections: [], spotlightContexts: [], ping: false },
				"run-profile-context",
				"2026-05-01T00:15:00.000Z",
			);
		}

		const alreadyActive = await buildWithActiveRows([profileToolRow]);
		const toolNames = (messages: Array<Record<string, unknown>>): string[] =>
			messages.flatMap((message) => (
				Array.isArray(message.tool_calls) ?
					(message.tool_calls as Array<{ function: { name: string } }>).map((toolCall) => toolCall.function.name)
				:	[]
			));
		const alreadyActiveToolNames = toolNames(alreadyActive);
		expect(alreadyActiveToolNames).toEqual(["check_notifications"]);

		const afterCompaction = await buildWithActiveRows([]);
		const afterCompactionToolNames = toolNames(afterCompaction);
		expect(afterCompactionToolNames).toEqual(["check_notifications", "view_profiles"]);
		const checkNotificationsResult = afterCompaction
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.events));
		expect(checkNotificationsResult).toMatchObject({
			events: [{ type: "comment_created", actor: `u/${referencedProfile.handle}` }],
		});
		expect(JSON.stringify(checkNotificationsResult.events[0])).not.toContain("Repeated inside the raw notification.");
		const profileToolResult = afterCompaction
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.profiles));
		expect(profileToolResult).toMatchObject({
			profiles: [{ username: `u/${referencedProfile.handle}`, displayName: localizedTextString(referencedProfile.displayName), shortBio: expect.any(String) }],
		});
	});

	it("deduplicates inline notification content against active context and same-tick repeats", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "notice-dedupe-self");
		const referencedProfile = await createBotForTest(cookie, "notice-dedupe-source");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const baseEvent = {
			type: "comment_created" as const,
			createdAt: "2026-05-01T00:00:00.000Z",
			actor: {
					id: referencedProfile.id,
					username: `u/${referencedProfile.handle}`,
					displayName: lt(referencedProfile.displayName),
					shortBio: lt("Raw notification bio should not be shown here."),
				},
			world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
			forum: { id: "frm_notice_dedupe", handle: "f/notice-dedupe" },
		};
		const notifications: NotificationEvent[] = [
			{
				...baseEvent,
					id: "ntf_direct",
					deliveryReasons: ["direct_reply"],
					sourceObjectId: "cmt_seen",
					message: lt("First delivery."),
					thread: {
						id: "thr_seen",
						title: lt("Already scoped thread"),
						author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: lt(referencedProfile.displayName) },
						text: lt("Thread text was already shown."),
					},
					comment: {
					id: "cmt_seen",
						threadId: "thr_seen",
						author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: lt(referencedProfile.displayName) },
						text: lt("Comment text was already shown."),
					},
					replyTo: {
						id: "thr_seen",
						title: lt("Already scoped thread"),
						text: lt("Thread text was already shown."),
					},
				},
			{
				...baseEvent,
					id: "ntf_mention",
					deliveryReasons: ["mention"],
					sourceObjectId: "cmt_seen",
					message: lt("Duplicate delivery reason."),
					thread: {
						id: "thr_seen",
						title: lt("Already scoped thread"),
						text: lt("Thread text was already shown."),
					},
					comment: {
					id: "cmt_seen",
						threadId: "thr_seen",
						author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: lt(referencedProfile.displayName) },
						text: lt("Comment text was already shown."),
					},
				},
			{
				...baseEvent,
					id: "ntf_new",
					deliveryReasons: ["followed_profile_activity"],
					sourceObjectId: "cmt_new",
					message: lt("New comment in already scoped thread."),
					thread: {
						id: "thr_seen",
						title: lt("Already scoped thread"),
						text: lt("Thread text was already shown."),
					},
				comment: {
					id: "cmt_new",
					threadId: "thr_seen",
						parentCommentId: "cmt_seen",
						author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: lt(referencedProfile.displayName) },
						text: lt("This new comment should be shown once."),
					},
					replyTo: {
					id: "cmt_seen",
						threadId: "thr_seen",
						author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: lt(referencedProfile.displayName) },
						text: lt("Comment text was already shown."),
					},
			},
		];
		const activeRows = [
			{
				seq: 1,
				position: 1,
				run_id: "run-previous",
				role: "tool",
				message_json: JSON.stringify({
					role: "tool",
					tool_call_id: "call_profiles",
					content: JSON.stringify({
						profiles: [{ username: `u/${referencedProfile.handle}`, displayName: lt(referencedProfile.displayName), shortBio: "Already active." }],
					}),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
				stream_seq: null,
				compacted_by: null,
				deleted_at: null,
				created_at: "2026-05-01T00:00:00.000Z",
				has_logs: 0,
			},
			{
				seq: 2,
				position: 2,
				run_id: "run-previous",
				role: "tool",
				message_json: JSON.stringify({
					role: "tool",
					tool_call_id: "call_read",
					content: JSON.stringify({
						content: [
							{ type: "thread", id: "thr_seen", threadId: "thr_seen", body: "Thread text was already shown." },
							{ type: "comment", id: "cmt_seen", commentId: "cmt_seen", threadId: "thr_seen", body: "Comment text was already shown." },
						],
					}),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
				stream_seq: null,
				compacted_by: null,
				deleted_at: null,
				created_at: "2026-05-01T00:00:00.000Z",
				has_logs: 0,
			},
		];
		const messages: Array<Record<string, unknown>> = [];
		let seq = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				seq += 1;
				return { seq, runId: "run-notification-dedupe", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => 10_000,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => activeRows,
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);
		const built = await buildMessages(
			bot,
			{ notifications, injections: [], spotlightContexts: [], ping: false },
			"run-notification-dedupe",
			"2026-05-01T00:15:00.000Z",
		);
		const checkNotificationsResult = built
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.events));
		expect(checkNotificationsResult.events).toHaveLength(2);
		expect(checkNotificationsResult.events[0]).toMatchObject({
			deliveryReasons: ["direct_reply", "mention"],
			thread: { threadRef: "t/thr_seen", title: "Already scoped thread" },
			comment: { commentRef: "c/cmt_seen", threadRef: "t/thr_seen" },
			replyTo: { title: "Already scoped thread" },
			actor: `u/${referencedProfile.handle}`,
		});
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("id");
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("message");
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("sourceObjectId");
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("world");
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("forum");
		expect(checkNotificationsResult.events[0].thread.text).toBeUndefined();
		expect(checkNotificationsResult.events[0].comment.text).toBeUndefined();
		expect(checkNotificationsResult.events[0].replyTo.text).toBeUndefined();
		expect(checkNotificationsResult.events[1].thread.text).toBeUndefined();
		expect(checkNotificationsResult.events[1].comment).not.toHaveProperty("parentCommentId");
		expect(checkNotificationsResult.events[1].comment.text).toBe("This new comment should be shown once.");
		expect(checkNotificationsResult.events[1].replyTo.text).toBeUndefined();
	});

		it("omits oversized notification events instead of trimming notification text", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
			const selfProfile = await createBotForTest(cookie, "notice-budget-self");
			const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
			const tokenBudget = 260;
		const author = { id: selfProfile.id, username: `u/${selfProfile.handle}`, displayName: lt(selfProfile.displayName) };
		const messages: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-notification-budget", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => tokenBudget,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => [],
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);
		const longThreadText = "T".repeat(1_600);
		const longCommentText = "C".repeat(1_600);
		await buildMessages(
			bot,
			{
				notifications: [{
					id: "ntf_budget",
					type: "comment_created",
					createdAt: "2026-05-01T00:00:00.000Z",
					deliveryReasons: ["followed_profile_activity"],
					sourceObjectId: "cmt_budget",
						message: lt("Long notification."),
						world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
						forum: { id: "frm_budget", handle: "f/budget" },
						thread: { id: "thr_budget", title: lt("Budget thread"), author, text: lt(longThreadText) },
						comment: { id: "cmt_budget", threadId: "thr_budget", author, text: lt(longCommentText) },
				} satisfies NotificationEvent],
				injections: [],
				spotlightContexts: [],
				ping: false,
			},
			"run-notification-budget",
			"2026-05-01T00:15:00.000Z",
		);
			const checkNotificationsResult = messages
				.filter((message) => message.role === "tool")
				.map((message) => JSON.parse(String(message.content)))
				.find((result) => Array.isArray(result.events));
			expect(Math.ceil(JSON.stringify(checkNotificationsResult).length / 4)).toBeLessThanOrEqual(tokenBudget);
			expect(checkNotificationsResult.context).toContain("1 older notification event was omitted");
			expect(checkNotificationsResult.events).toHaveLength(0);
			expect(JSON.stringify(checkNotificationsResult)).not.toContain(longThreadText);
			expect(JSON.stringify(checkNotificationsResult)).not.toContain(longCommentText);
			expect(JSON.stringify(checkNotificationsResult)).not.toContain("…");
		});

		it("drops older notification events without trimming notification text", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
			const selfProfile = await createBotForTest(cookie, "notice-drop-self");
			const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
			const tokenBudget = 300;
			const author = { id: selfProfile.id, username: `u/${selfProfile.handle}`, displayName: lt(selfProfile.displayName) };
		const messages: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-notification-drop", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => tokenBudget,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => [],
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);
		const notifications: NotificationEvent[] = Array.from({ length: 8 }, (_, index) => ({
			id: `ntf_drop_${index}`,
			type: "comment_created",
				createdAt: `2026-05-01T00:00:0${index}.000Z`,
				deliveryReasons: ["followed_profile_activity"],
				sourceObjectId: `cmt_drop_${index}`,
					message: lt(`Long notification ${index}.`),
					thread: { id: `thr_drop_${index}`, title: lt(`Budget thread ${index}`), author, text: lt(`Thread ${index} stays whole.`) },
					comment: { id: `cmt_drop_${index}`, threadId: `thr_drop_${index}`, author, text: lt(`Comment ${index} stays whole.`) },
			}));
		await buildMessages(
			bot,
			{ notifications, injections: [], spotlightContexts: [], ping: false },
			"run-notification-drop",
			"2026-05-01T00:15:00.000Z",
		);
		const checkNotificationsResult = messages
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.events));
		expect(Math.ceil(JSON.stringify(checkNotificationsResult).length / 4)).toBeLessThanOrEqual(tokenBudget);
		expect(checkNotificationsResult.context).toContain("older notification");
			expect(checkNotificationsResult.events.length).toBeGreaterThan(0);
			expect(checkNotificationsResult.events.length).toBeLessThan(notifications.length);
			expect(checkNotificationsResult.events[0].comment.commentRef).not.toBe("c/cmt_drop_0");
			expect(checkNotificationsResult.events.at(-1).comment.commentRef).toBe("c/cmt_drop_7");
			expect(checkNotificationsResult.events.at(-1).comment.text).toBe("Comment 7 stays whole.");
			expect(JSON.stringify(checkNotificationsResult)).not.toContain("…");
		});

	it("deduplicates explicit read result comment bodies while keeping comment IDs", () => {
		const activeScope = {
			commentsWithText: new Set(["cmt_seen"]),
			threadsWithText: new Set<string>(),
		};
		const threadResult = providerToolResultPayload(
			"read_thread_by_id",
			{
				operation: "read_thread_by_id",
				thread: {
					id: "thr_read",
					threadId: "thr_read",
					worldHandle: "primary",
					forumHandle: "random",
					title: "Read thread",
					authorHandle: "thread-author",
					lastActivityAt: "2026-05-01T00:00:00.000Z",
				},
				content: [
					{ type: "comment", id: "cmt_seen", commentId: "cmt_seen", threadId: "thr_read", body: "Already present." },
					{
						type: "comment",
						id: "cmt_new",
						commentId: "cmt_new",
						threadId: "thr_read",
						world: "w/primary",
						forum: "f/random",
						author: { username: "u/comment-author", displayName: "Comment Author", following: true },
						body: "Newly emitted.",
						createdAt: "2026-05-01T00:00:00.000Z",
					},
				],
			},
			{},
			activeScope,
		) as { thread: Record<string, unknown>; content: Array<Record<string, unknown>> };
		expect(threadResult.thread).toMatchObject({ threadRef: "t/thr_read", title: "Read thread", author: "u/thread-author" });
		expect(threadResult.thread).not.toHaveProperty("id");
		expect(threadResult.thread).not.toHaveProperty("world");
		expect(threadResult.thread).not.toHaveProperty("forum");
		expect(threadResult.content[0]).toMatchObject({ commentRef: "c/cmt_seen" });
		expect(threadResult.content[0]).not.toHaveProperty("type");
		expect(threadResult.content[0]).not.toHaveProperty("id");
		expect(threadResult.content[0]).not.toHaveProperty("threadId");
		expect(threadResult.content[0]?.body).toBeUndefined();
		expect(threadResult.content[1]).toMatchObject({ commentRef: "c/cmt_new", author: "u/comment-author", body: "Newly emitted." });
		expect(threadResult.content[1]).not.toHaveProperty("world");
		expect(threadResult.content[1]).not.toHaveProperty("forum");
		expect(threadResult.content[1]).not.toHaveProperty("createdAt");
		expectProviderPayloadToOmitKeys(threadResult, ["id", "world", "forum", "worldHandle", "urlPath"]);
		expectProviderPayloadToOmitIsoTimestamps(threadResult);

		const commentResult = providerToolResultPayload(
			"read_comment_by_id",
			{
				operation: "read_comment_by_id",
				targetCommentId: "cmt_seen",
				thread: { id: "thr_read", threadId: "thr_read", title: "Read thread" },
				content: [
					{ type: "comment", id: "cmt_seen", commentId: "cmt_seen", threadId: "thr_read", body: "Already present." },
				],
			},
			{},
			{
				commentsWithText: new Set(["cmt_seen"]),
				threadsWithText: new Set<string>(),
			},
		) as { content: Array<Record<string, unknown>> };
		expect(commentResult.content[0]).toMatchObject({ commentRef: "c/cmt_seen" });
		expect(commentResult.content[0]).not.toHaveProperty("type");
		expect(commentResult.content[0]).not.toHaveProperty("id");
		expect(commentResult.content[0]).not.toHaveProperty("threadId");
		expect(commentResult.content[0]?.body).toBeUndefined();
	});

		it("compacts participant-facing tool result metadata across discovery and activity tools", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
		try {
			const forumResult = providerToolResultPayload("list_accessible_forums", [
				{ id: "frm_random", worldHandle: "primary", handle: "random", description: "Random chatter." },
			]);
			expect(forumResult).toEqual([{ forum: "f/random", description: "Random chatter." }]);

			const recentResult = providerToolResultPayload("list_recent_threads", [
				{
					id: "thr_recent",
					threadId: "thr_recent",
					rootCommentId: "cmt_recent_root",
					worldHandle: "primary",
					forumHandle: "random",
					title: "Recent thread",
					authorHandle: "alice",
					authorDisplayName: "Alice",
					authorFollowing: true,
					commentCount: 3,
					voteScore: 7,
					lastActivityAt: "2026-05-01T00:00:00.000Z",
				},
			]);
			expect(recentResult).toMatchObject([
				{
					threadRef: "t/thr_recent",
					rootCommentRef: "c/cmt_recent_root",
					title: "Recent thread",
					author: "u/alice",
					commentCount: 3,
					voteScore: 7,
					lastActivity: "7 days ago",
				},
			]);
			expect(recentResult).not.toMatchObject([{ forum: expect.anything() }]);

			const hotResult = providerToolResultPayload("list_hot_threads", [
				{
					id: "thr_hot",
					threadId: "thr_hot",
					worldHandle: "primary",
					forumHandle: "weird",
					title: "Hot thread",
					authorHandle: "bob",
					lastActivityAt: "2026-05-07T22:00:00.000Z",
				},
			]);
			expect(hotResult).toMatchObject([{ threadRef: "t/thr_hot", forum: "f/weird", author: "u/bob", lastActivity: "2 hours ago" }]);

			const searchResult = providerToolResultPayload("search_threads", [
				{
					threadId: "thr_search",
					commentId: "cmt_search",
					rootCommentId: "cmt_search_root",
					forumHandle: "random",
					title: "Search hit",
					snippet: "A useful comment.",
					authorHandle: "carol",
					authorDisplayName: "Carol",
					createdAt: "2026-05-07T00:00:00.000Z",
					score: 0.91,
				},
			]);
			expect(searchResult).toMatchObject([
				{
					threadRef: "t/thr_search",
					commentRef: "c/cmt_search",
					forum: "f/random",
					title: "Search hit",
					snippet: "A useful comment.",
					author: "u/carol",
					when: "1 day ago",
				},
			]);
			expect((searchResult as Array<Record<string, unknown>>)[0]).not.toHaveProperty("rootCommentId");
			expect((searchResult as Array<Record<string, unknown>>)[0]).not.toHaveProperty("score");

			const compactedSearchResult = providerToolResultPayload(
				"search_threads",
				[
					{
						threadId: "thr_search",
						commentId: "cmt_search",
						forumHandle: "random",
						title: "Search hit",
						snippet: "A useful comment.",
						authorHandle: "carol",
					},
				],
				{},
				{
					commentsWithText: new Set(["cmt_search"]),
					threadsWithText: new Set<string>(),
				},
			);
			expect((compactedSearchResult as Array<Record<string, unknown>>)[0]).toMatchObject({
				threadRef: "t/thr_search",
				commentRef: "c/cmt_search",
				title: "Search hit",
			});
			expect((compactedSearchResult as Array<Record<string, unknown>>)[0]).not.toHaveProperty("snippet");

			const notificationResult = providerToolResultPayload("check_notifications", {
				events: [{
					id: "ntf_compact",
					type: "vote_cast",
					deliveryReasons: ["vote_on_your_content"],
					sourceObjectId: "vote_compact",
					message: "Raw notification message should not appear.",
					actor: { username: "u/voter", displayName: "Voter" },
					comment: { id: "cmt_notice", threadId: "thr_notice", parentCommentId: "cmt_parent", text: "Notice body." },
					vote: { targetType: "comment", commentId: "cmt_notice", value: 1 },
				}],
			});
			expect(notificationResult).toMatchObject({
				events: [{
					type: "vote_cast",
					actor: "u/voter",
					comment: { commentRef: "c/cmt_notice", threadRef: "t/thr_notice", text: "Notice body." },
					vote: { commentRef: "c/cmt_notice", value: 1 },
				}],
			});
			expect((notificationResult as { events: Array<Record<string, unknown>> }).events[0]?.comment).not.toHaveProperty("parentCommentId");
			expect((notificationResult as { events: Array<Record<string, unknown>> }).events[0]?.vote).not.toHaveProperty("targetType");

			const activityResult = providerToolResultPayload("view_activity", {
				bot: { id: "bot_owner", handle: "owner", displayName: "Owner" },
				activities: [
					{
						type: "thread",
						id: "thread:thr_activity",
						threadId: "thr_activity",
						rootCommentId: "cmt_activity_root",
						worldHandle: "primary",
						forumHandle: "random",
						title: "Activity thread",
						bodyPreview: "Root preview.",
						createdAt: "2026-05-06T00:00:00.000Z",
					},
					{
						type: "comment",
						id: "comment:cmt_activity",
						threadId: "thr_activity",
						commentId: "cmt_activity",
						parentCommentId: "cmt_parent",
						worldHandle: "primary",
						forumHandle: "random",
						threadTitle: "Activity thread",
						bodyPreview: "Reply preview.",
						parentComment: { commentId: "cmt_parent", authorHandle: "dave", authorDisplayName: "Dave", bodyPreview: "Parent preview." },
						createdAt: "2026-05-05T00:00:00.000Z",
					},
					{
						type: "vote",
						id: "vote:comment:cmt_vote",
						targetType: "comment",
						targetId: "cmt_vote",
						commentId: "cmt_vote",
						value: 1,
						threadId: "thr_vote",
						worldHandle: "primary",
						forumHandle: "polls",
						title: "Vote thread",
						reason: "Worth highlighting.",
						targetComment: { commentId: "cmt_vote", authorHandle: "erin", authorDisplayName: "Erin", bodyPreview: "Vote target." },
						updatedAt: "2026-05-04T00:00:00.000Z",
					},
					{
						type: "follow",
						id: "follow:bot_friend",
						bot: { id: "bot_friend", handle: "friend", displayName: "Friend", shortBio: "Friendly." },
						reason: "They post useful threads.",
						createdAt: "2026-05-03T00:00:00.000Z",
					},
				],
			});
				expect(activityResult).toMatchObject({
					profile: "u/owner",
					activities: [
						{ type: "thread", threadRef: "t/thr_activity", forum: "f/random", when: "2 days ago" },
						{
							type: "comment",
							commentRef: "c/cmt_activity",
							forum: "f/random",
							replyTo: { author: "u/dave", bodyPreview: "Parent preview." },
							when: "3 days ago",
						},
						{
						type: "vote",
						commentRef: "c/cmt_vote",
						value: 1,
						threadRef: "t/thr_vote",
						forum: "f/polls",
						targetComment: { commentRef: "c/cmt_vote", author: "u/erin", bodyPreview: "Vote target." },
						when: "4 days ago",
					},
					{ type: "follow", profile: "u/friend", when: "5 days ago" },
					],
				});
				expect((activityResult as { activities: Array<Record<string, unknown>> }).activities[0]).not.toHaveProperty("rootCommentId");
				const providerCommentActivity = (activityResult as { activities: Array<Record<string, unknown>> }).activities[1]!;
				expect(providerCommentActivity).not.toHaveProperty("threadId");
				expect(providerCommentActivity).not.toHaveProperty("threadRef");
				expect(providerCommentActivity).not.toHaveProperty("threadTitle");
				expect(providerCommentActivity).not.toHaveProperty("voteScore");
				expect(providerCommentActivity).not.toHaveProperty("parentComment");
				expect(providerCommentActivity.replyTo as Record<string, unknown>).not.toHaveProperty("commentId");

				for (const payload of [forumResult, recentResult, hotResult, searchResult, notificationResult, activityResult]) {
					expectProviderPayloadToOmitKeys(payload, ["id", "world", "worldHandle", "urlPath", "score", "createdAt", "updatedAt", "lastActivityAt"]);
				expectProviderPayloadToOmitIsoTimestamps(payload);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("builds spotlight setup as parallel synthetic read calls with parent-chain JSON", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "spotlight-self");
		const authorProfile = await createBotForTest(cookie, "spotlight-author");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const spotlightThreadReplyBody = `Spotlight thread reply should be shortened. ${"z".repeat(2_000)}`;
		const contexts: SpotlightSyntheticContext[] = [
			{
				kind: "spotlight_context",
				world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
				forum: { id: "frm_spotlight", handle: "f/spotlight" },
				targetType: "comments",
				focus: "Please pay attention to the target comment.",
					threads: [{
						id: "thr_spotlight_comment",
						threadId: "thr_spotlight_comment",
						title: lt("Comment spotlight"),
						rootCommentId: "cmt_spotlight_root",
					}],
				content: [
					{
						type: "comment",
						id: "cmt_spotlight_root",
						commentId: "cmt_spotlight_root",
							threadId: "thr_spotlight_comment",
							title: lt("Comment spotlight"),
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt("Root context."),
						createdAt: "2026-05-01T00:00:00.000Z",
						ancestorOnly: true,
					},
					{
						type: "comment",
						id: "cmt_spotlight_parent",
						commentId: "cmt_spotlight_parent",
						threadId: "thr_spotlight_comment",
							parentCommentId: "cmt_spotlight_root",
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt("Parent context."),
						createdAt: "2026-05-01T00:01:00.000Z",
						ancestorOnly: true,
					},
					{
						type: "comment",
						id: "cmt_spotlight",
						commentId: "cmt_spotlight",
						threadId: "thr_spotlight_comment",
							parentCommentId: "cmt_spotlight_parent",
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt("Target comment."),
						createdAt: "2026-05-01T00:01:30.000Z",
						"My focus is on this comment": true,
					},
				],
			},
			{
				kind: "spotlight_context",
				world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
				forum: { id: "frm_spotlight", handle: "f/spotlight" },
				targetType: "threads",
					threads: [{
						id: "thr_spotlight_thread",
						threadId: "thr_spotlight_thread",
						title: lt("Thread spotlight"),
						rootCommentId: "cmt_spotlight_thread_root",
					}],
				content: [
					{
						type: "comment",
						id: "cmt_spotlight_thread_root",
						commentId: "cmt_spotlight_thread_root",
							threadId: "thr_spotlight_thread",
							title: lt("Thread spotlight"),
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt("Thread target."),
						createdAt: "2026-05-01T00:02:00.000Z",
					},
					{
						type: "comment",
						id: "cmt_spotlight_thread_reply",
						commentId: "cmt_spotlight_thread_reply",
						threadId: "thr_spotlight_thread",
							parentCommentId: "cmt_spotlight_thread_root",
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt(spotlightThreadReplyBody),
						createdAt: "2026-05-01T00:02:30.000Z",
					},
				],
			},
		];
		const messages: Array<Record<string, unknown>> = [];
		const activeRows = [
			{
				seq: 1,
				position: 1,
				run_id: "run-previous",
				role: "tool",
				message_json: JSON.stringify({
					role: "tool",
					tool_call_id: "call_read_previous",
					content: JSON.stringify({
						content: [
							{ type: "comment", id: "cmt_spotlight_root", commentId: "cmt_spotlight_root", threadId: "thr_spotlight_comment", body: "Root context." },
						],
					}),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
				stream_seq: null,
				compacted_by: null,
				deleted_at: null,
				created_at: "2026-05-01T00:00:00.000Z",
				has_logs: 0,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-spotlight-context", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => 1,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => activeRows,
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);

		const built = await buildMessages(
			bot,
			{ notifications: [], injections: [], spotlightContexts: contexts, ping: false },
			"run-spotlight-context",
			"2026-05-01T00:15:00.000Z",
			{ setupMode: "spotlight" },
		);
		const setup = built.find((message) => Array.isArray(message.tool_calls));
		expect(setup?.content).toBe("While browsing Bickr, I stumbled on an interesting thread.");
		expect(built.some((message) => typeof message.content === "string" && message.content.includes("checking my notifications"))).toBe(false);
		expect(built.some((message) => message.content === effectiveReasoningPrefill(bot))).toBe(false);
		const setupToolCallMessages = built.filter(
			(message): message is Record<string, unknown> & { tool_calls: Array<{ function: { name: string } }> } => Array.isArray(message.tool_calls),
		);
		expect(setupToolCallMessages.every((message) => message.tool_calls?.length === 1)).toBe(true);
		expect(setupToolCallMessages.flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.function.name) ?? [])).toEqual([
			"read_comment_by_id",
			"read_thread_by_id",
			"view_profiles",
		]);
		expect(setupToolCallMessages.slice(1).every((message) => message.content === null)).toBe(true);
		const toolResults = built
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)));
		expect(toolResults.find((result) => result.operation === "read_comment_by_id")).toMatchObject({
			targetCommentRef: "c/cmt_spotlight",
			content: [
				{
					commentRef: "c/cmt_spotlight_root",
					ancestorOnly: true,
					replies: [{
						commentRef: "c/cmt_spotlight_parent",
						body: "…",
						ancestorOnly: true,
						replies: [{ commentRef: "c/cmt_spotlight", body: "Target comment.", "My focus is on this comment": true }],
					}],
				},
			],
		});
		expect(toolResults.find((result) => result.operation === "read_thread_by_id")).toMatchObject({
			thread: { threadRef: "t/thr_spotlight_thread", title: "Thread spotlight" },
			content: [{
				commentRef: "c/cmt_spotlight_thread_root",
				body: "Thread target.",
				replies: [{ commentRef: "c/cmt_spotlight_thread_reply", body: "…" }],
			}],
		});
		expect(toolResults.find((result) => result.operation === "read_thread_by_id")?.context).toContain("body ending in …");
		expect(JSON.stringify(toolResults.find((result) => result.operation === "read_thread_by_id"))).not.toContain(spotlightThreadReplyBody);
		expect(toolResults.find((result) => Array.isArray(result.profiles))).toMatchObject({
			profiles: [{ username: `u/${authorProfile.handle}`, displayName: localizedTextString(authorProfile.displayName) }],
		});
		const profileResultIndex = built.findIndex((message) => message.role === "tool" && String(message.content).includes('"profiles"'));
		const focusMessageIndex = built.findIndex(
			(message) => message.role === "assistant" && message.content === "My focus: Please pay attention to the target comment.",
		);
		expect(profileResultIndex).toBeGreaterThanOrEqual(0);
		expect(focusMessageIndex).toBeGreaterThan(profileResultIndex);
		expect(focusMessageIndex).toBe(built.length - 1);
	});

	it("builds deep spotlight comment chains without re-nesting replies exponentially", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "spotlight-deep-self");
		const authorProfile = await createBotForTest(cookie, "spotlight-deep-author");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const chainLength = 24;
		const content = Array.from({ length: chainLength }, (_, index): SpotlightIncludedContent => {
			const id = `cmt_deep_spotlight_${index}`;
			return {
				type: "comment",
				id,
				commentId: id,
				threadId: "thr_deep_spotlight",
				...(index > 0 ? { parentCommentId: `cmt_deep_spotlight_${index - 1}` } : {}),
					authorBotId: authorProfile.id,
					authorHandle: authorProfile.handle,
					authorDisplayName: lt(authorProfile.displayName),
					body: lt(`Deep spotlight context ${index}. ${"z".repeat(800)}`),
				createdAt: `2026-05-01T00:${String(index).padStart(2, "0")}:00.000Z`,
				...(index === chainLength - 1 ? { "My focus is on this comment": true as const } : { ancestorOnly: true }),
			};
		});
		const contexts: SpotlightSyntheticContext[] = [{
			kind: "spotlight_context",
			world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
			forum: { id: "frm_deep_spotlight", handle: "f/deep-spotlight" },
			targetType: "comments",
			focus: "Please pay attention to the deepest comment.",
				threads: [{
					id: "thr_deep_spotlight",
					threadId: "thr_deep_spotlight",
					title: lt("Deep comment spotlight"),
					rootCommentId: "cmt_deep_spotlight_0",
			}],
			content,
		}];
		const messages: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-deep-spotlight", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => 1,
			syntheticProfilesForUsernames: async () => [],
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => [],
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);

		const start = Date.now();
		const built = await buildMessages(
			bot,
			{ notifications: [], injections: [], spotlightContexts: contexts, ping: false },
			"run-deep-spotlight",
			"2026-05-01T00:30:00.000Z",
			{ setupMode: "spotlight" },
		);
		expect(Date.now() - start).toBeLessThan(2_000);
		expect(built.find((message) => message.content === "My focus: Please pay attention to the deepest comment.")).toBeTruthy();
		const readResult = built
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => result.operation === "read_comment_by_id");
		expect(readResult).toMatchObject({
			targetCommentRef: "c/cmt_deep_spotlight_23",
			content: [{ commentRef: "c/cmt_deep_spotlight_0" }],
		});
	});

	it("queues busy spotlight ticks only when the active tick misses the injection", async () => {
		const unconsumedInjections = new Set(["inj-late"]);
		const waitUntilPromises: Promise<unknown>[] = [];
		const started: Array<{
			botId: string;
			trigger: string;
			options: { mode?: string; injectionIds?: string[]; spotlightId?: string; background?: boolean };
		}> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeRunId: "run-current",
			state: {
				storage: {
					sql: memoryRuntimeSql({ unconsumedInjections }),
				},
				waitUntil: (promise: Promise<unknown>) => {
					waitUntilPromises.push(promise);
				},
			},
			status: async () => ({
				botId: "bot-one",
				enabled: true,
				status: "running",
				activeRunId: "run-current",
			}),
			runTick: async (botId: string, trigger: string, options: { mode?: string; injectionIds?: string[]; spotlightId?: string; background?: boolean }) => {
				started.push({ botId, trigger, options });
				return { runId: "run-followup", status: "completed" };
			},
		});
		const startBackgroundTick = (BotRuntime.prototype as unknown as {
			startBackgroundTick: (
				botId: string,
				trigger: "cron" | "manual" | "spotlight",
				options: { mode?: "normal" | "spotlight"; injectionIds?: string[]; spotlightId?: string; background?: boolean },
			) => Promise<{ runId: string; status: string }>;
		}).startBackgroundTick.bind(runtime);
		const startQueuedSpotlightTick = (BotRuntime.prototype as unknown as {
			startQueuedSpotlightTick: (botId: string) => void;
		}).startQueuedSpotlightTick.bind(runtime);

		await expect(
			startBackgroundTick("bot-one", "spotlight", {
				mode: "spotlight",
				injectionIds: ["inj-early"],
				spotlightId: "spt-early",
				background: true,
			}),
		).resolves.toMatchObject({ runId: "run-current", status: "queued" });
		startQueuedSpotlightTick("bot-one");
		await Promise.all(waitUntilPromises.splice(0));
		expect(started).toEqual([]);

		await expect(
			startBackgroundTick("bot-one", "spotlight", {
				mode: "spotlight",
				injectionIds: ["inj-late"],
				spotlightId: "spt-late",
				background: true,
			}),
		).resolves.toMatchObject({ runId: "run-current", status: "queued" });
		startQueuedSpotlightTick("bot-one");
		await Promise.all(waitUntilPromises);
		expect(started).toEqual([
			{
				botId: "bot-one",
				trigger: "spotlight",
				options: {
					mode: "spotlight",
					injectionIds: ["inj-late"],
					spotlightId: "spt-late",
					background: false,
				},
			},
		]);
	});

	it("builds OpenRouter server tool request entries only for OpenRouter base URLs", () => {
		const settings = {
			openRouter: {
				datetime: { enabled: true, timezone: "America/Los_Angeles" },
				webSearch: {
					enabled: true,
					engine: "exa" as const,
					maxResults: 3,
					maxTotalResults: 9,
					searchContextSize: "high" as const,
					userLocation: { type: "approximate" as const, city: "San Francisco", country: "US" },
					allowedDomains: ["example.com"],
					excludedDomains: ["reddit.com"],
				},
				webFetch: {
					enabled: true,
					engine: "openrouter" as const,
					maxUses: 2,
					maxContentTokens: 50_000,
					allowedDomains: ["docs.example.com"],
					blockedDomains: ["private.example.com"],
				},
			},
		};

		expect(isOpenRouterProviderBaseUrl("https://openrouter.ai/api/v1")).toBe(true);
		expect(isOpenRouterProviderBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(true);
		expect(isOpenRouterProviderBaseUrl("https://openrouter.ai/api/v1/images")).toBe(true);
		expect(isOpenRouterProviderBaseUrl("http://localhost:11434/v1")).toBe(false);

		const selection = openRouterServerToolSelection("https://openrouter.ai/api/v1/", settings);
		expect(selection.suppressed).toEqual([]);
		expect(selection.emitted).toEqual(["openrouter:datetime", "openrouter:web_search", "openrouter:web_fetch"]);
		expect(selection.tools).toEqual([
			{ type: "openrouter:datetime", parameters: { timezone: "America/Los_Angeles" } },
			{
				type: "openrouter:web_search",
				parameters: {
					engine: "exa",
					max_results: 3,
					max_total_results: 9,
					search_context_size: "high",
					user_location: { type: "approximate", city: "San Francisco", country: "US" },
					allowed_domains: ["example.com"],
					excluded_domains: ["reddit.com"],
				},
			},
			{
				type: "openrouter:web_fetch",
				parameters: {
					engine: "openrouter",
					max_uses: 2,
					max_content_tokens: 50_000,
					allowed_domains: ["docs.example.com"],
					blocked_domains: ["private.example.com"],
				},
			},
		]);

		const suppressed = openRouterServerToolSelection("http://localhost:11434/v1", settings);
		expect(suppressed.tools).toEqual([]);
		expect(suppressed.suppressed).toEqual(selection.emitted);

		const disabled = openRouterServerToolSelection("https://openrouter.ai/api/v1", {});
		expect(disabled.tools).toEqual([]);
		expect([...toolDefinitions, ...disabled.tools].some((definition) => definition.type === "function")).toBe(true);
	});

	it("retries provider stream idle timeouts", async () => {
		vi.useFakeTimers();
		try {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const fetchProviderResponse = vi
				.fn<() => Promise<ReadableStream<Uint8Array>>>()
				.mockResolvedValueOnce(neverStream())
				.mockResolvedValueOnce(sseStream([
					{
						id: "response-recovered",
						model: "test/model",
						choices: [{ delta: { content: "Recovered." } }],
					},
					"[DONE]",
				]));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return {
						seq: events.length,
						runId: _runId,
						type,
						payload,
						tokenEstimate: 0,
						createdAt: new Date().toISOString(),
					};
				},
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: Record<string, unknown>,
					messages: Array<Record<string, unknown>>,
					tools: Array<Record<string, unknown>>,
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<{ content: string; toolCalls: unknown[] }>;
			}).callProvider.bind(runtime);

			const response = callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-retry",
				77,
				new AbortController().signal,
			);
			await vi.advanceTimersByTimeAsync(90_000);

			await expect(response).resolves.toMatchObject({ content: "Recovered.", toolCalls: [] });
			expect(fetchProviderResponse).toHaveBeenCalledTimes(2);
			expect(events).toContainEqual({
				type: "provider_retry",
				payload: expect.objectContaining({
					attempt: 2,
					maxAttempts: 5,
					reason: "Inference stream stopped responding after 60 seconds.",
				}),
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries retryable provider errors reported inside streamed chunks", async () => {
		vi.useFakeTimers();
		try {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const streamedProviderError = (id: string) => ({
				id,
				object: "chat.completion.chunk",
				created: 1777968809,
				model: "google/gemma-4-26b-a4b-it-20260403",
				provider: "DeepInfra",
				choices: [],
				error: {
					code: 502,
					message: "Provider returned error",
					metadata: { error_type: "provider_unavailable" },
				},
			});
			const fetchProviderResponse = vi
				.fn<() => Promise<ReadableStream<Uint8Array>>>()
				.mockResolvedValueOnce(sseStream([streamedProviderError("gen-first")]))
				.mockResolvedValueOnce(sseStream([streamedProviderError("gen-second")]))
				.mockResolvedValueOnce(sseStream([
					{
						id: "response-recovered",
						model: "test/model",
						choices: [{ delta: { content: "Recovered." } }],
					},
					"[DONE]",
				]));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return {
						seq: events.length,
						runId: _runId,
						type,
						payload,
						tokenEstimate: 0,
						createdAt: new Date().toISOString(),
					};
				},
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: Record<string, unknown>,
					messages: Array<Record<string, unknown>>,
					tools: Array<Record<string, unknown>>,
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<{ content: string; toolCalls: unknown[] }>;
			}).callProvider.bind(runtime);

			const response = callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-provider-error-retry",
				77,
				new AbortController().signal,
			);
			await vi.advanceTimersByTimeAsync(90_000);

			await expect(response).resolves.toMatchObject({ content: "Recovered.", toolCalls: [] });
			expect(fetchProviderResponse).toHaveBeenCalledTimes(3);
			expect(events.filter((event) => event.type === "provider_retry").map((event) => event.payload.reason)).toEqual([
				"502:Provider returned error (provider_unavailable)",
				"502:Provider returned error (provider_unavailable)",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries upstream-provider 429s with request-local provider ignore routing", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const fetchProviderResponse = vi
			.fn<(_settings: unknown, _endpoint: string, _body: string, _signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>>()
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-limit", "DeepInfra")]))
			.mockResolvedValueOnce(sseStream([
				{
					id: "response-recovered",
					model: "test/model",
					choices: [{ delta: { content: "Recovered." } }],
				},
				"[DONE]",
			]));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return {
					seq: events.length,
					runId: _runId,
					type,
					payload,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			broadcastProviderDelta: () => {},
			clearProviderStreamActive: () => {},
			fetchProviderResponse,
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const callProvider = (BotRuntime.prototype as unknown as {
			callProvider: (
				settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
				tools: Array<Record<string, unknown>>,
				runId: string,
				streamSeq: number,
				signal: AbortSignal,
			) => Promise<{ content: string; toolCalls: unknown[] }>;
		}).callProvider.bind(runtime);

		const response = await callProvider(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "test/model",
				temperature: 0.7,
			},
			[{ role: "user", content: "Act." }],
			[],
			"run-stream-provider-rate-limit",
			77,
			new AbortController().signal,
		);

		expect(response).toMatchObject({ content: "Recovered.", toolCalls: [] });
		expect(fetchProviderResponse).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(String(fetchProviderResponse.mock.calls[0]?.[2])) as { provider?: Record<string, unknown> };
		const secondBody = JSON.parse(String(fetchProviderResponse.mock.calls[1]?.[2])) as { provider?: Record<string, unknown> };
		expect(firstBody.provider).toBeUndefined();
		expect(secondBody.provider).toEqual({ ignore: ["DeepInfra"] });
		expect(events).toContainEqual({
			type: "provider_retry",
			payload: expect.objectContaining({
				attempt: 2,
				maxAttempts: 5,
				delayMs: 0,
				reason: expect.stringContaining("ignoring upstream provider DeepInfra"),
			}),
		});
	});

	it("accumulates newly reported upstream providers without replacing existing routing", async () => {
		const fetchProviderResponse = vi
			.fn<(_settings: unknown, _endpoint: string, _body: string, _signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>>()
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-deepinfra", "DeepInfra")]))
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-fireworks", "Fireworks")]))
			.mockResolvedValueOnce(sseStream([
				{
					id: "response-recovered",
					model: "test/model",
					choices: [{ delta: { content: "Recovered." } }],
				},
				"[DONE]",
			]));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async () => ({
				seq: 1,
				runId: "run-stream-provider-rate-limit-accumulate",
				type: "provider_retry",
				payload: {},
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			broadcastProviderDelta: () => {},
			clearProviderStreamActive: () => {},
			fetchProviderResponse,
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const callProvider = (BotRuntime.prototype as unknown as {
			callProvider: (
				settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
				tools: Array<Record<string, unknown>>,
				runId: string,
				streamSeq: number,
				signal: AbortSignal,
			) => Promise<{ content: string; toolCalls: unknown[] }>;
		}).callProvider.bind(runtime);

		await expect(callProvider(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "test/model",
				temperature: 0.7,
				providerRouting: { order: ["openrouter/fallback"], ignore: ["A"] },
			},
			[{ role: "user", content: "Act." }],
			[],
			"run-stream-provider-rate-limit-accumulate",
			77,
			new AbortController().signal,
		)).resolves.toMatchObject({ content: "Recovered.", toolCalls: [] });

		const firstBody = JSON.parse(String(fetchProviderResponse.mock.calls[0]?.[2])) as { provider?: Record<string, unknown> };
		const secondBody = JSON.parse(String(fetchProviderResponse.mock.calls[1]?.[2])) as { provider?: Record<string, unknown> };
		const thirdBody = JSON.parse(String(fetchProviderResponse.mock.calls[2]?.[2])) as { provider?: Record<string, unknown> };
		expect(firstBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A"] });
		expect(secondBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A", "DeepInfra"] });
		expect(thirdBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A", "DeepInfra", "Fireworks"] });
	});

	it("stops upstream-provider 429 retries when the ignored provider repeats", async () => {
		const fetchProviderResponse = vi
			.fn<(_settings: unknown, _endpoint: string, _body: string, _signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>>()
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-limit-first", "DeepInfra")]))
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-limit-second", "DeepInfra")]));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async () => ({
				seq: 1,
				runId: "run-stream-provider-rate-limit-repeat",
				type: "provider_retry",
				payload: {},
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			broadcastProviderDelta: () => {},
			clearProviderStreamActive: () => {},
			fetchProviderResponse,
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const callProvider = (BotRuntime.prototype as unknown as {
			callProvider: (
				settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
				tools: Array<Record<string, unknown>>,
				runId: string,
				streamSeq: number,
				signal: AbortSignal,
			) => Promise<{ content: string; toolCalls: unknown[] }>;
		}).callProvider.bind(runtime);

		let thrown: unknown;
		try {
			await callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-provider-rate-limit-repeat",
				77,
				new AbortController().signal,
			);
		} catch (error) {
			thrown = error;
		}

		expect(fetchProviderResponse).toHaveBeenCalledTimes(2);
		const secondBody = JSON.parse(String(fetchProviderResponse.mock.calls[1]?.[2])) as { provider?: Record<string, unknown> };
		expect(secondBody.provider).toEqual({ ignore: ["DeepInfra"] });
		expect(thrown).toMatchObject({
			name: "ProviderLoopRequestError",
			attempts: 2,
		});
		expect((thrown as Error).message).toContain("Inference request failed with status 429. Response: Provider returned error");
	});

	it("wraps exhausted loop provider retries with request and response diagnostics", async () => {
		vi.useFakeTimers();
		try {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const streamedProviderError = {
				id: "response-failed",
				model: "test/model",
				choices: [],
				error: {
					code: 500,
					message: "Internal Server Error",
				},
			};
			const fetchProviderResponse = vi.fn(async () => sseStream([streamedProviderError]));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return {
						seq: events.length,
						runId: _runId,
						type,
						payload,
						tokenEstimate: 0,
						createdAt: new Date().toISOString(),
					};
				},
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: Record<string, unknown>,
					messages: Array<Record<string, unknown>>,
					tools: Array<Record<string, unknown>>,
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<{ content: string; toolCalls: unknown[] }>;
			}).callProvider.bind(runtime);

			let thrown: unknown;
			const response = callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-provider-error-exhausted",
				77,
				new AbortController().signal,
			).catch((error: unknown) => {
				thrown = error;
			});
			await vi.advanceTimersByTimeAsync(300_000);
			await response;

			const rawResponse = JSON.stringify(streamedProviderError);
			expect(fetchProviderResponse).toHaveBeenCalledTimes(5);
			expect(events.filter((event) => event.type === "provider_retry").map((event) => event.payload.attempt)).toEqual([2, 3, 4, 5]);
			expect(thrown).toMatchObject({
				name: "ProviderLoopRequestError",
				attempts: 5,
				responseBody: rawResponse,
			});
			expect((thrown as Error).message).toContain("Inference failed after 5 provider attempts (4 retries); last error from provider:");
			expect((thrown as Error).message).toContain("Inference request failed with status 500. Response: Internal Server Error");
			expect((thrown as { requestBody?: string }).requestBody).toContain("\"stream\":true");
			expect((thrown as { requestBody?: string }).requestBody).toContain("\"model\":\"test/model\"");
			expect(runtimeErrorLoopMessageContent(thrown)).toMatch(/^Inference failed after 5 provider attempts \(4 retries\); last error from provider:/);
		} finally {
			vi.useRealTimers();
		}
	});

		it("retains, reads, deletes, and clears bounded inference submissions", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: memoryInferenceSubmissionSql(),
					},
				},
			});
			const recordInferenceSubmission = (BotRuntime.prototype as unknown as {
				recordInferenceSubmission: (input: {
					seq: number;
					runId: string;
					purpose: "loop" | "compaction";
					settings: { baseUrl: string; model: string; supportsPrefill?: boolean; temperature: number };
					messages: Array<{ role: "assistant" | "user"; content: string }>;
					displayMessages?: Array<{ role: "user" | "assistant"; content: string }>;
					createdAt: string;
				}) => void;
			}).recordInferenceSubmission.bind(runtime);
			const updateInferenceSubmissionDisplayMessages = (BotRuntime.prototype as unknown as {
				updateInferenceSubmissionDisplayMessages: (
					seq: number,
					messages: Array<{ role: "user" | "assistant"; content: string }>,
				) => void;
			}).updateInferenceSubmissionDisplayMessages.bind(runtime);
			const inferenceSubmissionSummaries = (BotRuntime.prototype as unknown as {
				inferenceSubmissionSummaries: () => Array<{ seq: number; purpose: string; messageCount: number }>;
			}).inferenceSubmissionSummaries.bind(runtime);
			const inferenceSubmissionForSeq = (BotRuntime.prototype as unknown as {
				inferenceSubmissionForSeq: (seq: number) => {
					seq: number;
					messages: Array<{ content: string }>;
					displayMessages?: Array<{ content: string }>;
				};
			}).inferenceSubmissionForSeq.bind(runtime);
			const deleteInferenceSubmissionsForSeq = (BotRuntime.prototype as unknown as {
				deleteInferenceSubmissionsForSeq: (seq: number) => number;
			}).deleteInferenceSubmissionsForSeq.bind(runtime);
			const clearInferenceSubmissions = (BotRuntime.prototype as unknown as {
				clearInferenceSubmissions: () => number;
			}).clearInferenceSubmissions.bind(runtime);

			for (let seq = 1; seq <= 55; seq += 1) {
				recordInferenceSubmission({
					seq,
					runId: "run-submissions",
					purpose: seq === 55 ? "compaction" : "loop",
					settings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "test/model",
						...(seq === 55 ? { supportsPrefill: false } : {}),
						temperature: 0.7,
					},
					messages: seq === 55 ?
						[{ role: "assistant", content: "Trailing participant narration." }]
					:	[{ role: "user", content: `Müller message ${seq}` }],
					createdAt: `2026-05-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
				});
			}

			const summaries = inferenceSubmissionSummaries();
			expect(summaries).toHaveLength(50);
			expect(summaries[0]?.seq).toBe(6);
			expect(summaries.at(-1)).toMatchObject({ seq: 55, purpose: "compaction", messageCount: 2 });
			expect(inferenceSubmissionForSeq(55).messages.map((message) => message.content)).toEqual([
				"Trailing participant narration.",
				"Bickr Terminal is ready for my next step.",
			]);
			expect(inferenceSubmissionForSeq(55).displayMessages).toBeUndefined();
			updateInferenceSubmissionDisplayMessages(55, [
				{ role: "user", content: "Submitted compaction chat." },
				{ role: "assistant", content: "Compacted continuity summary." },
			]);
			expect(inferenceSubmissionForSeq(55).displayMessages?.map((message) => message.content)).toEqual([
				"Submitted compaction chat.",
				"Compacted continuity summary.",
			]);
			expect(deleteInferenceSubmissionsForSeq(55)).toBe(1);
			expect(inferenceSubmissionSummaries().map((submission) => submission.seq)).not.toContain(55);
			expect(clearInferenceSubmissions()).toBe(49);
			expect(inferenceSubmissionSummaries()).toEqual([]);
		});

		it("streams provider reasoning through live deltas and persistent messages", async () => {
		type TestProviderResponse = {
			content: string;
			reasoning: string;
			reasoningDetails: Array<Record<string, unknown>>;
			toolCalls: Array<Record<string, unknown>>;
		};
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const deltas: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, _runId, type as BotRuntimeEvent["type"], payload);
			},
			broadcastProviderDelta: (_runId: string, streamSeq: number, event: Record<string, unknown>) => {
				deltas.push({ ...event, streamSeq });
			},
			clearProviderStreamActive: () => {},
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const consumeProviderResponse = (BotRuntime.prototype as unknown as {
			consumeProviderResponse: (
				runId: string,
				streamSeq: number,
				stream: ReadableStream<Uint8Array>,
				signal: AbortSignal,
			) => Promise<TestProviderResponse>;
		}).consumeProviderResponse.bind(runtime);
		const appendProviderMessages = (BotRuntime.prototype as unknown as {
				appendProviderMessages: (
					runId: string,
					response: TestProviderResponse,
					status: "complete" | "interrupted",
					streamSeq: number,
				) => Promise<void>;
		}).appendProviderMessages.bind(runtime);

		const response = await consumeProviderResponse(
			"run-reasoning",
			42,
			sseStream([
				{ choices: [{ delta: { reasoning: "I should inspect the thread. " } }] },
				{ choices: [{ delta: { reasoning_content: "Then I can decide. " } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning.summary", summary: "Summary says to compare options. ", format: "openai-responses-v1", index: 0 }] } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "I will use ", format: "unknown", index: 0 }] } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "a tool. ", format: "unknown", index: 0 }] } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Responses-style summary. " }], format: "openai-responses-v1", index: 1 }] } }] },
				{ choices: [{ delta: { content: " Checking now." } }] },
				"[DONE]",
			]),
			new AbortController().signal,
		);
			await appendProviderMessages("run-reasoning", response, "complete", 42);

		expect(response).toMatchObject({
			content: " Checking now.",
			reasoning: "I should inspect the thread. Then I can decide. Summary says to compare options. I will use a tool. Responses-style summary. ",
			reasoningDetails: [
				{ type: "reasoning.summary", summary: "Summary says to compare options. ", format: "openai-responses-v1", index: 0 },
				{ type: "reasoning.text", text: "I will use a tool. ", format: "unknown", index: 0 },
				{ type: "reasoning", summary: [{ type: "summary_text", text: "Responses-style summary. " }], format: "openai-responses-v1", index: 1 },
			],
			toolCalls: [],
		});
		expect(deltas).toEqual([
			{ kind: "reasoning", streamSeq: 42, text: "I should inspect the thread. " },
			{ kind: "reasoning", streamSeq: 42, text: "Then I can decide. " },
			{ kind: "reasoning", streamSeq: 42, text: "Summary says to compare options. " },
			{ kind: "reasoning", streamSeq: 42, text: "I will use " },
			{ kind: "reasoning", streamSeq: 42, text: "a tool. " },
			{ kind: "reasoning", streamSeq: 42, text: "Responses-style summary. " },
			{ kind: "content", streamSeq: 42, text: " Checking now." },
		]);
		expect(events).toEqual([
			{
				type: "reasoning_message",
				payload: {
					content: "I should inspect the thread. Then I can decide. Summary says to compare options. I will use a tool. Responses-style summary. ",
					status: "complete",
					streamSeq: 42,
				},
			},
			{
					type: "assistant_message",
					payload: {
						content: " Checking now.",
						status: "complete",
						streamSeq: 42,
					},
			},
		]);
	});

	it("captures OpenRouter router metadata from streamed final chunks", async () => {
		type TestProviderResponse = {
			content: string;
			responseId?: string;
			responseProviderName?: string;
			toolCalls: Array<Record<string, unknown>>;
		};
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			broadcastProviderDelta: () => {},
			clearProviderStreamActive: () => {},
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const consumeProviderResponse = (BotRuntime.prototype as unknown as {
			consumeProviderResponse: (
				runId: string,
				streamSeq: number,
				stream: ReadableStream<Uint8Array>,
				signal: AbortSignal,
				generationResponseId?: string,
			) => Promise<TestProviderResponse>;
		}).consumeProviderResponse.bind(runtime);

		const response = await consumeProviderResponse(
			"run-router-metadata",
			42,
			sseStream([
				{
					id: "chatcmpl-upstream",
					model: "test/model",
					choices: [{ delta: { content: "Done." } }],
				},
				{
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
					openrouter_metadata: {
						endpoints: {
							available: [
								{ provider: "DeepInfra", model: "test/model", selected: true },
							],
						},
					},
				},
				"[DONE]",
			]),
			new AbortController().signal,
			"gen-header",
		);

		expect(response).toMatchObject({
			content: "Done.",
			responseId: "gen-header",
			responseProviderName: "DeepInfra",
			toolCalls: [],
		});
	});

	it("uses the provider request sequence as the live stream identity for final loop messages", async () => {
		const events: Array<{ seq: number; type: string; payload: Record<string, unknown> }> = [];
		let providerStreamSeq: number | undefined;
		const appendedLoopMessages: Array<{
			message: Record<string, unknown>;
			origin: string;
			status: string | undefined;
			streamSeq: number | undefined;
		}> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				const seq = type === "provider_request" ? 123 : 123 + events.length + 1;
				events.push({ seq, type, payload });
				return runtimeEvent(seq, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				runId: string,
				message: Record<string, unknown>,
				origin: string,
				status?: string,
				options?: { streamSeq?: number },
			) => {
				appendedLoopMessages.push({ message, origin, status, streamSeq: options?.streamSeq });
				return {
					seq: 200,
					runId,
					role: "assistant",
					message,
					origin,
					status,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
					...(options?.streamSeq !== undefined ? { streamSeq: options.streamSeq } : {}),
				};
			},
			callProvider: async (_settings: unknown, _messages: unknown, _tools: unknown, _runId: string, streamSeq: number) => {
				providerStreamSeq = streamSeq;
				return providerResponseWithContent("I have finished this round.");
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
					{
						...fakeBotDocument({
							id: "bot_stream",
							handle: "stream-sage",
							displayName: "Stream Sage",
							shortBio: "Watches loop streams.",
							prompt: "Keep stream state coherent.",
						}),
							tickSettings: {
								enabled: true,
								intervalSeconds: 300,
								compactionThreshold: 0.75,
								maxToolCallsPerTick: 1,
								maxSuccessfulToolCallsPerIteration: 8,
								contextWindowTokens: 16_000,
							},
					},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-loop-stream",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerStreamSeq).toBe(123);
		expect(events).toContainEqual(expect.objectContaining({
			type: "assistant_message",
			payload: expect.objectContaining({ streamSeq: 123 }),
		}));
		expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
			origin: "provider_response",
			streamSeq: 123,
		}));
	});

	it("does not retain empty provider responses in provider history", async () => {
		expect(providerResponseMessageForHistory({
			content: "",
			reasoning: "",
			reasoningDetails: [],
			toolCalls: [],
		})).toBeNull();
		expect(providerResponseMessageForHistory({
			content: "",
			reasoning: "I am deciding what to do next.",
			reasoningDetails: [],
			toolCalls: [],
		})).toEqual({ role: "assistant", reasoning: "I am deciding what to do next." });
		expect(providerResponseMessageForHistory(providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }))).toMatchObject({
			role: "assistant",
			content: null,
			tool_calls: [
				expect.objectContaining({
					id: "call-read",
					function: expect.objectContaining({ name: "read_thread" }),
				}),
			],
		});
		expect(loopMessageContributesToProviderHistory("provider_response", { role: "assistant", content: null })).toBe(false);
		expect(loopMessageContributesToProviderHistory("provider_response", { role: "assistant", content: "" })).toBe(false);
		expect(loopMessageContributesToProviderHistory("runtime_error", { role: "user", content: "Bickr Terminal reported an error." })).toBe(false);
		expect(loopMessageContributesToProviderHistory("synthetic_context", { role: "assistant", content: null })).toBe(true);
	});

	it("validates provider tool-call arguments before history or execution", () => {
		const sanitized = sanitizeProviderToolCalls([
			{
				id: "call-malformed",
				type: "function",
				function: { name: "read_thread", arguments: "{\"threadId\":" },
			},
			{
				id: "call-array",
				type: "function",
				function: { name: "read_thread", arguments: "[]" },
			},
			{
				id: "call-null",
				type: "function",
				function: { name: "read_thread", arguments: "null" },
			},
			{
				id: "call-string",
				type: "function",
				function: { name: "read_thread", arguments: "\"x\"" },
			},
			{
				id: "call-valid",
				type: "function",
				function: { name: "read_thread", arguments: "{ \"threadId\": \"thr_test\" }" },
			},
			{
				id: "call-valid",
				type: "function",
				function: { name: "reply_to_comment", arguments: "{ \"commentId\": \"com_test\", \"body\": \"Duplicate id.\" }" },
			},
		]);

		expect(sanitized.dropped.map((call) => [call.id, call.reason])).toEqual([
			["call-malformed", "invalid_arguments_json"],
			["call-array", "arguments_not_json_object"],
			["call-null", "arguments_not_json_object"],
			["call-string", "arguments_not_json_object"],
			["call-valid", "duplicate_tool_call"],
		]);
		expect(sanitized.toolCalls).toEqual([
			{
				id: "call-valid",
				type: "function",
				function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
			},
		]);
	});

	it("removes duplicate tool call ids and ambiguous tool results from provider requests", () => {
		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-duplicate",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_keep\"}" },
						},
						{
							id: "call-duplicate",
							type: "function",
							function: { name: "reply_to_comment", arguments: "{\"commentId\":\"com_drop\",\"body\":\"Ambiguous duplicate.\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call-duplicate", content: "{\"ok\":true,\"kept\":true}" },
				{ role: "tool", tool_call_id: "call-duplicate", content: "{\"ok\":true,\"dropped\":true}" },
			],
			[],
		);

		const assistant = request.messages.find((message) => Array.isArray(message.tool_calls));
		expect(assistant?.tool_calls?.map((toolCall) => toolCall.function.name)).toEqual(["read_thread"]);
		expect(request.messages.filter((message) => message.role === "tool").map((message) => message.content)).toEqual([
			"{\"ok\":true,\"kept\":true}",
		]);
		expect(JSON.stringify(request.messages)).not.toContain("com_drop");
		expect(JSON.stringify(request.messages)).not.toContain("dropped");
	});

	it("adds stable initial user context before prior activity for provider compatibility", () => {
		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{ role: "system", content: "System prompt." },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call-read", content: "{\"ok\":true}" },
			],
			[],
		);

		expect(request.messages[1]).toEqual({
			role: "user",
			content: "Bickr Terminal is ready for my next step.",
		});
		expect(request.messages.at(-1)).toMatchObject({
			role: "tool",
			tool_call_id: "call_1",
			content: "{\"ok\":true}",
		});
	});

	it("rewrites provider request tool call ids to compact request-local ids", () => {
		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-repeat",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_first\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call-repeat", content: "{\"ok\":true,\"first\":true}" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-repeat",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_second\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call-repeat", content: "{\"ok\":true,\"second\":true}" },
			],
			[],
		);

		const assistantIds = request.messages
			.filter((message) => Array.isArray(message.tool_calls))
			.flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.id) ?? []);
		const toolIds = request.messages
			.filter((message) => message.role === "tool")
			.map((message) => message.tool_call_id);

		expect(assistantIds).toEqual(["call_1", "call_2"]);
		expect(toolIds).toEqual(["call_1", "call_2"]);
		expect(new Set(assistantIds).size).toBe(assistantIds.length);
	});

	it("shortens long synthetic provider request ids that differ only near the end", () => {
		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{
					role: "assistant",
					content: "I check two things.",
					tool_calls: [
						{
							id: "synthetic_a444be5d-a813-48cf-be41-10c161645fc7_0",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_first\"}" },
						},
						{
							id: "synthetic_a444be5d-a813-48cf-be41-10c161645fc7_1",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_second\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "synthetic_a444be5d-a813-48cf-be41-10c161645fc7_0", content: "{\"ok\":true,\"first\":true}" },
				{ role: "tool", tool_call_id: "synthetic_a444be5d-a813-48cf-be41-10c161645fc7_1", content: "{\"ok\":true,\"second\":true}" },
			],
			[],
		);

		const assistant = request.messages.find((message) => Array.isArray(message.tool_calls));
		expect(assistant?.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call_1", "call_2"]);
		expect(request.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call_1", "call_2"]);
		expect(JSON.stringify(request.messages)).not.toContain("synthetic_a444be5d");
	});

	it("keeps rewritten provider request ids stable when new messages append", () => {
		const initialMessages: BotInferenceSubmissionMessage[] = [
			{ role: "system", content: "System prompt." },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "synthetic_first_long_id_that_may_be_provider_normalized_0",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":\"thr_first\"}" },
					},
				],
			},
			{ role: "tool", tool_call_id: "synthetic_first_long_id_that_may_be_provider_normalized_0", content: "{\"ok\":true,\"first\":true}" },
		];
		const initialRequest = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			initialMessages,
			[],
		);
		const extendedRequest = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				...initialMessages,
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "synthetic_second_long_id_that_may_be_provider_normalized_0",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_second\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "synthetic_second_long_id_that_may_be_provider_normalized_0", content: "{\"ok\":true,\"second\":true}" },
			],
			[],
		);

		expect(initialRequest.messages[1]).toEqual({
			role: "user",
			content: "Bickr Terminal is ready for my next step.",
		});
		expect(extendedRequest.messages.slice(0, initialRequest.messages.length)).toEqual(initialRequest.messages);
		expect(extendedRequest.messages.flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.id) ?? [])).toEqual(["call_1", "call_2"]);
		expect(extendedRequest.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call_1", "call_2"]);
	});

	it("repairs invalid Unicode and truncates without splitting surrogate pairs", () => {
		const high = "\uD83C";
		const low = "\uDF0C";
		const galaxy = "🌌";

		expect(repairInvalidUnicodeText(`a${high}b${low}c${galaxy}`)).toBe(`a\uFFFDb\uFFFDc${galaxy}`);
		expect(repairInvalidUnicodeText(galaxy)).toBe(galaxy);

		const truncated = truncateForContext(galaxy.repeat(2_100), 4_000);
		expect(truncated.endsWith("…")).toBe(true);
		expect(hasLoneSurrogate(truncated)).toBe(false);

		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{ role: "assistant", content: `bad saved text ${high}` },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_unicode",
							type: "function",
							function: { name: "read_thread", arguments: JSON.stringify({ threadId: "thr_test", note: `bad ${high}` }) },
						},
					],
				},
			],
			[],
		);
		expect(hasLoneSurrogate(request.messages)).toBe(false);
		expect(JSON.stringify(request)).not.toContain("\\ud83c");
		expect(JSON.parse(request.messages[1]?.tool_calls?.[0]?.function.arguments ?? "{}")).toMatchObject({ note: "bad \uFFFD" });
	});

	it("rejects empty provider responses without appending them to the loop ledger", async () => {
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(type === "provider_request" ? 123 : 124, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-empty-provider-response",
					role: "assistant",
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			callProvider: async () => ({
				content: "",
				reasoning: "",
				reasoningDetails: [],
				toolCalls: [],
			}),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-empty-provider-response",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toMatchObject({
			name: "ProviderEmptyResponseError",
			message: "Inference provider returned an empty response with no content, reasoning, or tool calls.",
		});
		expect(appendedLoopMessages).toEqual([]);
	});

	it("drops META compaction summary tool calls during normal inference", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const rewrites: Array<{ kind: string; toolCallId: string }> = [];
		const executeTool = vi.fn();
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCall("call-meta-summary", metaCompactionToolName, {
				[providerCompactionSummaryProperty]: "I should not be summarizing right now.",
			}))
			.mockResolvedValueOnce(providerResponseWithContent("I will continue normally."));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-meta-tool-misuse",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool,
			hasRuntimeStorage: () => true,
			loopGeneratedTokenCountSinceLastLogOff: () => 0,
			prematureLogOffCorrectedSinceLastLogOff: () => false,
			providerLoopInitialSuccessfulToolCallCount: () => 0,
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			rewriteProviderResponseLoopMessageToolCall: (_seq: number, rewrite: { kind: string; toolCallId: string }) => {
				rewrites.push(rewrite);
				const providerResponse = appendedLoopMessages.find((message) => message.origin === "provider_response" && Array.isArray(message.message.tool_calls));
				if (providerResponse?.message.tool_calls && rewrite.kind === "drop") {
					providerResponse.message.tool_calls = (providerResponse.message.tool_calls as BotInferenceSubmissionToolCall[])
						.filter((toolCall) => toolCall.id !== rewrite.toolCallId);
				}
			},
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-meta-tool-misuse",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executeTool).not.toHaveBeenCalled();
		expect(rewrites).toEqual([{ kind: "drop", toolCallId: "call-meta-summary" }]);
		expect(appendedLoopMessages.find((message) => message.origin === "self_correction")?.message.content).toContain(`${metaCompactionToolName} cannot be used at this time`);
		expect(JSON.stringify(appendedLoopMessages.filter((message) => message.origin !== "self_correction"))).not.toContain(metaCompactionToolName);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				callIds: ["call-meta-summary"],
				reason: "disallowed_meta_compaction_tool",
			}),
		}));
	});

	it("drops malformed generated tool calls while executing valid calls from the same response", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-mixed-tool-calls",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithRawToolCalls([
				{ id: "call-log-off", name: "log_off", arguments: "{\"reason\":\"done\"}" },
				{ id: "call-bad", name: "read_thread", arguments: "{\"threadId\":" },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => {
				executedTools.push({ name, args });
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-mixed-tool-calls",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		expect(executedTools).toEqual([{ name: "log_off", args: { reason: "done" } }]);
		const providerResponse = appendedLoopMessages.find((message) => message.origin === "provider_response")?.message;
		expect(providerResponse?.tool_calls).toEqual([
			expect.objectContaining({ id: "call-log-off", function: expect.objectContaining({ arguments: "{\"reason\":\"done\"}" }) }),
		]);
		expect(appendedLoopMessages.filter((message) => message.origin === "tool_result").map((message) => message.message.tool_call_id)).toEqual(["call-log-off"]);
		expect(JSON.stringify(appendedLoopMessages)).not.toContain("call-bad");
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				count: 1,
				callIds: ["call-bad"],
				retrying: false,
			}),
		}));
	});

	it("drops duplicate generated tool call ids before history and execution", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: BotInferenceSubmissionMessage; origin: string }> = [];
		const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
		const providerMessagesByCall: BotInferenceSubmissionMessage[][] = [];
		const providerHistory = (): BotInferenceSubmissionMessage[] =>
			appendedLoopMessages
				.filter((item) => item.origin === "provider_response" || item.origin === "tool_result")
				.map((item) => item.message);
		const callProvider = vi.fn()
			.mockImplementationOnce((_settings: unknown, messages: BotInferenceSubmissionMessage[]) => {
				providerMessagesByCall.push(messages);
				return providerResponseWithToolCalls([
					{ id: "call-duplicate", name: "read_thread", args: { threadId: "thr_keep" } },
					{ id: "call-duplicate", name: "reply_to_comment", args: { commentId: "com_drop", body: "This duplicate id is ambiguous." } },
				]);
			})
			.mockImplementationOnce((_settings: unknown, messages: BotInferenceSubmissionMessage[]) => {
				providerMessagesByCall.push(messages);
				return providerResponseWithContent("done");
			});
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: BotInferenceSubmissionMessage, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-duplicate-tool-call-id",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => {
				const history = providerHistory();
				return {
					allowedPromptTokens: 13_500,
					promptTokens: 100,
					requestMessages: history.length > 0 ? history : [{ role: "assistant", content: "I am ready." }],
				};
			},
			executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => {
				executedTools.push({ name, args });
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-duplicate-tool-call-id",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executedTools).toEqual([{ name: "read_thread", args: { threadId: "thr_keep" } }]);
		const providerResponse = appendedLoopMessages.find((message) => message.origin === "provider_response")?.message;
		expect(providerResponse?.tool_calls).toEqual([
			expect.objectContaining({ id: "call-duplicate", function: expect.objectContaining({ name: "read_thread" }) }),
		]);
		expect(appendedLoopMessages.filter((message) => message.origin === "tool_result").map((message) => message.message.tool_call_id)).toEqual(["call-duplicate"]);
		expect(JSON.stringify(appendedLoopMessages)).not.toContain("com_drop");
		const secondRequestAssistant = providerMessagesByCall[1]?.find((message) => Array.isArray(message.tool_calls));
		expect(secondRequestAssistant?.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call-duplicate"]);
		expect(providerMessagesByCall[1]?.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call-duplicate"]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				count: 1,
				callIds: ["call-duplicate"],
				reason: "duplicate_tool_call",
				retrying: false,
			}),
		}));
	});

	it("stores generated parallel tool calls as interleaved single-call provider history groups", async () => {
		const appendedLoopMessages: Array<{ message: BotInferenceSubmissionMessage; origin: string }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCalls([
				{ id: "call-search-a", name: "search_threads", args: { query: "astronomy" } },
				{ id: "call-search-b", name: "search_threads", args: { query: "telescopes" } },
			]))
			.mockResolvedValueOnce(providerResponseWithContent("done"));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(appendedLoopMessages.length + callProvider.mock.calls.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: BotInferenceSubmissionMessage, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-split-parallel-tool-calls",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => ({
				name,
				result: { ok: true, args },
				providerResult: { ok: true, args },
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-split-parallel-tool-calls",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		const providerHistory = appendedLoopMessages.filter((item) => item.origin === "provider_response" || item.origin === "tool_result");
		expect(providerHistory.slice(0, 4).map((item) => ({
			origin: item.origin,
			role: item.message.role,
			toolCallIds: item.message.tool_calls?.map((toolCall) => toolCall.id),
			toolCallId: item.message.tool_call_id,
		}))).toEqual([
			{ origin: "provider_response", role: "assistant", toolCallIds: ["call-search-a"], toolCallId: undefined },
			{ origin: "tool_result", role: "tool", toolCallIds: undefined, toolCallId: "call-search-a" },
			{ origin: "provider_response", role: "assistant", toolCallIds: ["call-search-b"], toolCallId: undefined },
			{ origin: "tool_result", role: "tool", toolCallIds: undefined, toolCallId: "call-search-b" },
		]);
		expect(providerHistory[2]?.message.content).toBeNull();
	});

	it("deduplicates parallel follow calls before history and execution", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCalls([
				{ id: "call-follow-1", name: "follow_profile", args: { targets: [{ username: "alice", reason: "Alice shares useful context." }] } },
				{ id: "call-follow-2", name: "follow_profile", args: { targets: [{ username: "u/alice", reason: "Duplicate request for Alice." }] } },
			]))
			.mockResolvedValueOnce(providerResponseWithContent("done"));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-dedupe-follow",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => {
				executedTools.push({ name, args });
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-dedupe-follow",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executedTools).toEqual([
			{ name: "follow_profile", args: { targets: [{ username: "alice", reason: requiredLt("Alice shares useful context.") }] } },
		]);
		const providerResponse = appendedLoopMessages.find((message) => Array.isArray(message.message.tool_calls))?.message;
		expect(providerResponse?.tool_calls).toEqual([
			expect.objectContaining({ id: "call-follow-1" }),
		]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				count: 1,
				callIds: ["call-follow-2"],
				reason: "duplicate_tool_call",
				retrying: false,
			}),
		}));
	});

	it("rewrites overlapping parallel follow calls to only unseen targets", async () => {
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCalls([
				{
					id: "call-follow-a",
					name: "follow_profile",
					args: {
						targets: [
							{ username: "alice", reason: "Alice shares useful context." },
							{ username: "bob", reason: "Bob adds careful replies." },
						],
					},
				},
				{
					id: "call-follow-b",
					name: "follow_profile",
					args: {
						targets: [
							{ username: "u/alice", reason: "Alice was already requested." },
							{ username: "carol", reason: "Carol tracks relevant threads." },
						],
					},
				},
			]))
			.mockResolvedValueOnce(providerResponseWithContent("done"));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(type === "provider_request" ? callProvider.mock.calls.length : appendedLoopMessages.length + executedTools.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-overlap-follow",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => {
				executedTools.push({ name, args });
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-overlap-follow",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executedTools).toEqual([
			{
				name: "follow_profile",
				args: {
					targets: [
						{ username: "alice", reason: requiredLt("Alice shares useful context.") },
						{ username: "bob", reason: requiredLt("Bob adds careful replies.") },
					],
				},
			},
			{
				name: "follow_profile",
				args: { targets: [{ username: "carol", reason: requiredLt("Carol tracks relevant threads.") }] },
			},
		]);
		const rewrittenToolCall = appendedLoopMessages
			.flatMap((message) => (message.message.tool_calls ?? []) as BotInferenceSubmissionToolCall[])
			.find((toolCall) => toolCall.id === "call-follow-b");
		const rewrittenArgs = JSON.parse(rewrittenToolCall?.function.arguments ?? "{}") as Record<string, unknown>;
		expect(rewrittenArgs).toEqual({ targets: [{ username: "carol", reason: requiredLt("Carol tracks relevant threads.") }] });
	});

	it("self-corrects one duplicate missing-profile follow request without repeated failures", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const rewrites: Array<{ kind: string; toolCallId: string }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCalls([
				{ id: "call-missing-1", name: "follow_profile", args: { targets: [{ username: "philosopher_king", reason: "This profile looked relevant." }] } },
				{ id: "call-missing-2", name: "follow_profile", args: { targets: [{ username: "u/philosopher_king", reason: "Duplicate request for the same profile." }] } },
			]))
			.mockResolvedValueOnce(providerResponseWithContent("done"));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: testEnv,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-missing-follow",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			rewriteProviderResponseLoopMessageToolCall: (_seq: number, rewrite: { kind: string; toolCallId: string }) => {
				rewrites.push(rewrite);
			},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-missing-follow",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(rewrites).toEqual([{ kind: "drop", toolCallId: "call-missing-1" }]);
		expect(appendedLoopMessages.filter((message) => message.origin === "tool_failure")).toEqual([]);
		expect(events.filter((event) => event.type === "tool_result")).toEqual([]);
		const correction = String(appendedLoopMessages.find((message) => message.origin === "self_correction")?.message.content ?? "");
		expect(correction).toContain("u/philosopher_king is not an existing Bickr participant");
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				count: 1,
				callIds: ["call-missing-2"],
				reason: "duplicate_tool_call",
			}),
		}));
	});

		it("keeps the full tool schema when the iteration is near its successful control limit", async () => {
		let providerTools: ProviderToolDefinition[] = [];
		const executedTools: string[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(type === "provider_request" ? 1 : 2, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => ({
				seq: 1,
				runId: "run-logoff-only",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, _messages: unknown, tools: ProviderToolDefinition[]) => {
				providerTools = tools;
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I have used enough controls for now." });
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			repairActiveProviderToolCallHistory: async () => [],
			providerLoopInitialSuccessfulToolCallCount: () => 7,
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const bot = {
			...fakeBotDocument(),
			toolSettings: { openRouter: { webSearch: { enabled: true } } },
			tickSettings: {
				...fakeBotDocument().tickSettings,
				allowEarlyLogOff: true,
				maxToolCallsPerTick: 1,
				maxSuccessfulToolCallsPerIteration: 8,
			},
		};
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-logoff-only",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		const providerToolNames = providerTools.map((tool) => "function" in tool ? tool.function.name : tool.type);
		expect(providerToolNames).toContain("log_off");
		expect(providerToolNames).toContain("read_thread");
		expect(providerToolNames).toContain("openrouter:web_search");
		expect(executedTools).toEqual(["log_off"]);
	});

	it("injects synthetic logoff after a tool call reaches the iteration limit", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-limit-reject",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			repairActiveProviderToolCallHistory: async () => [],
			providerLoopInitialSuccessfulToolCallCount: () => 7,
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 1, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-limit-reject",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

			expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
				origin: "tool_result",
				message: expect.objectContaining({
					tool_call_id: "call-read",
					content: JSON.stringify({ ok: true }),
				}),
			}));
		expect(events).toContainEqual(expect.objectContaining({
			type: "assistant_message",
			payload: expect.objectContaining({
				content: "I need to take a short break from Bickr. I'll log off for now.",
			}),
		}));
		expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
			origin: "tool_result",
			message: expect.objectContaining({
				tool_call_id: expect.stringContaining("synthetic_run-limit-reject"),
			}),
		}));
	});

	it("defers iteration limits during a spotlight streak until the first unrelated mutation ends the tick", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executedTools: string[] = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce({
				...providerResponseWithToolCall("call-view", "view_profiles", { usernames: ["u/spot-author"] }),
				usage: providerUsageForTest(20),
			})
			.mockResolvedValueOnce({
				...providerResponseWithToolCall("call-reply", "reply_to_comment", { commentId: "cmt_spot", body: "Spotlight reply." }),
				usage: providerUsageForTest(20),
			})
			.mockResolvedValueOnce({
				...providerResponseWithToolCall("call-create", "create_thread", { forumHandle: "general", title: "Unrelated", body: "Body." }),
				usage: providerUsageForTest(20),
			});
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-spotlight-streak-limit",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return {
					name,
					result: { ok: true },
					providerResult: { ok: true },
					...(name === "reply_to_comment" ? { spotlightMutation: true } : {}),
					...(name === "create_thread" ? { spotlightTickTerminator: true } : {}),
				};
			},
			loopGeneratedTokenCountSinceLastLogOff: () => 40,
			providerLoopInitialSuccessfulToolCallCount: () => 7,
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			repairActiveProviderToolCallHistory: async () => [],
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: Record<string, unknown>,
			) => Promise<{ logOffCalled: boolean; spotlightMutationCount: number }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: {
						...fakeBotDocument().tickSettings,
						allowEarlyLogOff: true,
						maxToolCallsPerTick: 5,
						maxSuccessfulToolCallsPerIteration: 8,
						maxGeneratedTokensPerTick: 1_000,
						maxGeneratedTokensPerIteration: 50,
					},
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-spotlight-streak-limit",
				[],
				{
					mode: "spotlight",
					setupMode: "spotlight",
					spotlightId: "spt_limit",
					spotlightActionScope: {
						commentIds: new Set(["cmt_spot"]),
						authorBotIds: new Set(["bot_spot"]),
						authorHandles: new Set(["spot-author"]),
					},
					signal: new AbortController().signal,
				},
			),
		).resolves.toMatchObject({ logOffCalled: true, spotlightMutationCount: 1 });

		expect(callProvider).toHaveBeenCalledTimes(3);
		expect(executedTools).toEqual(["view_profiles", "reply_to_comment", "create_thread", "log_off"]);
		expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
			origin: "tool_result",
			message: expect.objectContaining({
				tool_call_id: "call-reply",
			}),
		}));
		expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
			origin: "tool_result",
			message: expect.objectContaining({
				tool_call_id: expect.stringContaining("synthetic_run-spotlight-streak-limit"),
			}),
		}));
		expect(events.filter((event) => event.type === "provider_tool_call_dropped")).toEqual([]);
	});

	it("ends a spotlight tick after an unrelated mutation result and drops remaining generated calls", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const executedTools: string[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => ({
				seq: events.length,
				runId: "run-spotlight-unrelated-mutating",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{ id: "call-create", name: "create_thread", args: { forumHandle: "general", title: "Unrelated", body: "Body." } },
				{ id: "call-reply", name: "reply_to_comment", args: { commentId: "cmt_spot", body: "Spotlight reply." } },
				{ id: "call-read", name: "read_thread", args: { threadId: "thr_after" } },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return {
					name,
					result: { ok: true },
					providerResult: { ok: true },
					...(name === "create_thread" ? { spotlightTickTerminator: true } : {}),
				};
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			repairActiveProviderToolCallHistory: async () => [],
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: Record<string, unknown>,
			) => Promise<{ logOffCalled: boolean; spotlightMutationCount: number }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 3, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-spotlight-unrelated-mutating",
				[],
				{
					mode: "spotlight",
					setupMode: "spotlight",
					spotlightId: "spt_unrelated",
					spotlightActionScope: {
						commentIds: new Set(["cmt_spot"]),
						authorBotIds: new Set(["bot_spot"]),
						authorHandles: new Set(["spot-author"]),
					},
					signal: new AbortController().signal,
				},
			),
		).resolves.toMatchObject({ logOffCalled: false, spotlightMutationCount: 0 });

		expect(executedTools).toEqual(["create_thread"]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				callIds: ["call-reply", "call-read"],
				reason: "spotlight_tick_ended",
			}),
		}));
	});

	it("counts mixed spotlight mutation batches as reactions while ending the spotlight tick", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const executedTools: string[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => ({
				seq: events.length,
				runId: "run-spotlight-mixed-batch",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{
					id: "call-vote",
					name: "vote",
					args: {
						votes: [
							{ commentId: "cmt_spot", value: 1 },
							{ commentId: "cmt_other", value: 1 },
						],
						reason: "One spotlight vote and one ordinary vote.",
					},
				},
				{ id: "call-read", name: "read_thread", args: { threadId: "thr_after" } },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return {
					name,
					result: { ok: true },
					providerResult: { ok: true },
					spotlightMutation: true,
					spotlightTickTerminator: true,
				};
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			repairActiveProviderToolCallHistory: async () => [],
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: Record<string, unknown>,
			) => Promise<{ logOffCalled: boolean; spotlightMutationCount: number }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 3, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-spotlight-mixed-batch",
				[],
				{
					mode: "spotlight",
					setupMode: "spotlight",
					spotlightId: "spt_mixed",
					spotlightActionScope: {
						commentIds: new Set(["cmt_spot"]),
						authorBotIds: new Set(["bot_spot"]),
						authorHandles: new Set(["spot-author"]),
					},
					signal: new AbortController().signal,
				},
			),
		).resolves.toMatchObject({ logOffCalled: false, spotlightMutationCount: 1 });

		expect(executedTools).toEqual(["vote"]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				callIds: ["call-read"],
				reason: "spotlight_tick_ended",
			}),
		}));
	});

	it("drops remaining parallel calls after one fills the iteration limit", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const executedTools: string[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => ({
				seq: events.length,
				runId: "run-parallel-limit",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{ id: "call-read", name: "read_thread", args: { threadId: "thr_test" } },
				{ id: "call-vote", name: "vote", args: { votes: [{ commentId: "cmt_test", value: 1 }], reason: "Clear useful context." } },
				{ id: "call-log-off", name: "log_off", args: { reason: "I hit my visit limit." } },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			repairActiveProviderToolCallHistory: async () => [],
			providerLoopInitialSuccessfulToolCallCount: () => 6,
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 1, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-parallel-limit",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		expect(executedTools).toEqual(["read_thread", "vote", "log_off"]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				reason: "iteration_limit",
				callIds: expect.arrayContaining(["call-log-off"]),
			}),
		}));
	});

		it("does not count failed parallel calls toward the iteration limit", async () => {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const executedTools: string[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => ({
				seq: events.length,
				runId: "run-failed-call-limit",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{ id: "call-read", name: "read_thread", args: { threadId: "thr_missing" } },
				{ id: "call-vote", name: "vote", args: { votes: [{ commentId: "cmt_test", value: 1 }], reason: "Clear useful context." } },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				if (name === "read_thread") {
					throw new Error("Thread not found.");
				}
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			repairActiveProviderToolCallHistory: async () => [],
			providerLoopInitialSuccessfulToolCallCount: () => 6,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 1, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-failed-call-limit",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executedTools).toEqual(["read_thread", "vote"]);
		expect(events.some((event) => {
			const result = event.payload.result;
			return Boolean(result && typeof result === "object" && "code" in result && result.code === "iteration_tool_limit");
			})).toBe(false);
		});

		it("drops one premature logoff attempt and allows a repeated one", async () => {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
			const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
			const rewrites: Array<{ kind: string; toolCallId: string }> = [];
			const callProvider = vi.fn()
				.mockResolvedValueOnce(providerResponseWithToolCall("call-log-off-first", "log_off", { reason: "done too early" }))
				.mockResolvedValueOnce(providerResponseWithToolCall("call-log-off-second", "log_off", { reason: "still done" }));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
				},
				appendLoopMessage: (
					_runId: string,
					message: Record<string, unknown>,
					origin: string,
				) => {
					appendedLoopMessages.push({ message, origin });
					return {
						seq: appendedLoopMessages.length,
						runId: "run-premature-logoff",
						role: message.role,
						message,
						origin,
						tokenEstimate: 0,
						createdAt: new Date().toISOString(),
					};
				},
				appendProviderMessages: async () => {},
				callProvider,
				ensureProviderPromptWithinBudget: async () => ({
					allowedPromptTokens: 13_500,
					promptTokens: 100,
					requestMessages: [{ role: "assistant", content: "I am ready." }],
				}),
				executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => {
					executedTools.push({ name, args });
					return { name, result: { ok: true }, providerResult: { ok: true } };
				},
				hasRuntimeStorage: () => true,
				loopGeneratedTokenCountSinceLastLogOff: () => 0,
				prematureLogOffCorrectedSinceLastLogOff: () => false,
				providerLoopInitialSuccessfulToolCallCount: () => 0,
				recordInferenceSubmission: () => {},
				recordLoopMessageLog: () => {},
				recordProviderUsage: () => {},
				repairActiveProviderToolCallHistory: async () => [],
				rewriteProviderResponseLoopMessageToolCall: (_seq: number, rewrite: { kind: string; toolCallId: string }) => {
					rewrites.push(rewrite);
				},
				successfulMutatingToolCallSinceLastLogOff: () => false,
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const runProviderLoop = (BotRuntime.prototype as unknown as {
				runProviderLoop: (
					bot: BotDocument,
					settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
					runId: string,
					messages: Array<Record<string, unknown>>,
					runContext: { mode: "normal"; signal: AbortSignal },
				) => Promise<{ logOffCalled: boolean }>;
			}).runProviderLoop.bind(runtime);

			await expect(
				runProviderLoop(
					{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 2 } },
					{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-premature-logoff",
					[],
					{ mode: "normal", signal: new AbortController().signal },
				),
			).resolves.toMatchObject({ logOffCalled: true });

			expect(callProvider).toHaveBeenCalledTimes(2);
			expect(rewrites).toEqual([{ kind: "drop", toolCallId: "call-log-off-first" }]);
			expect(executedTools).toEqual([{ name: "log_off", args: { reason: requiredLt("still done") } }]);
			expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
				origin: "self_correction",
				message: expect.objectContaining({
					content: "Actually I don't want to log off yet, let me think about what I should do instead.",
				}),
			}));
			expect(events).toContainEqual(expect.objectContaining({
				type: "provider_tool_call_dropped",
				payload: expect.objectContaining({
					callIds: ["call-log-off-first"],
					reason: "premature_log_off",
				}),
			}));
			expect(appendedLoopMessages.filter((message) => message.origin === "tool_failure")).toEqual([]);
		});

		it("stops a tick after executing the response that reaches the generated token limit", async () => {
			const executedTools: string[] = [];
			const callProvider = vi.fn(async () => ({
				...providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }),
				usage: providerUsageForTest(25, 5),
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
					runtimeEvent(callProvider.mock.calls.length + executedTools.length + 1, runId, type as BotRuntimeEvent["type"], payload),
				appendLoopMessage: (
					_runId: string,
					message: Record<string, unknown>,
					origin: string,
				) => ({
					seq: executedTools.length + 1,
					runId: "run-tick-token-limit",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				}),
				appendProviderMessages: async () => {},
				callProvider,
				ensureProviderPromptWithinBudget: async () => ({
					allowedPromptTokens: 13_500,
					promptTokens: 100,
					requestMessages: [{ role: "assistant", content: "I am ready." }],
				}),
				executeTool: async (_bot: unknown, _runId: string, name: string) => {
					executedTools.push(name);
					return { name, result: { ok: true }, providerResult: { ok: true } };
				},
				recordInferenceSubmission: () => {},
				recordLoopMessageLog: () => {},
				recordProviderUsage: () => {},
				repairActiveProviderToolCallHistory: async () => [],
				successfulMutatingToolCallSinceLastLogOff: () => true,
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const runProviderLoop = (BotRuntime.prototype as unknown as {
				runProviderLoop: (
					bot: BotDocument,
					settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
					runId: string,
					messages: Array<Record<string, unknown>>,
					runContext: { mode: "normal"; signal: AbortSignal },
				) => Promise<{ logOffCalled: boolean }>;
			}).runProviderLoop.bind(runtime);

			await expect(
				runProviderLoop(
					{
						...fakeBotDocument(),
						tickSettings: {
							...fakeBotDocument().tickSettings,
							maxToolCallsPerTick: 5,
							maxGeneratedTokensPerTick: 25,
							maxGeneratedTokensPerIteration: 1_000,
						},
					},
					{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-tick-token-limit",
					[],
					{ mode: "normal", signal: new AbortController().signal },
				),
			).resolves.toMatchObject({ logOffCalled: false });

			expect(callProvider).toHaveBeenCalledTimes(1);
			expect(executedTools).toEqual(["read_thread"]);
		});

		it("injects synthetic logoff after executing the response that reaches the iteration generated token limit", async () => {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const executedTools: string[] = [];
			const callProvider = vi.fn(async () => ({
				...providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }),
				usage: providerUsageForTest(10),
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
				},
				appendLoopMessage: (
					_runId: string,
					message: Record<string, unknown>,
					origin: string,
				) => ({
					seq: events.length + executedTools.length,
					runId: "run-iteration-token-limit",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				}),
				appendProviderMessages: async () => {},
				callProvider,
				ensureProviderPromptWithinBudget: async () => ({
					allowedPromptTokens: 13_500,
					promptTokens: 100,
					requestMessages: [{ role: "assistant", content: "I am ready." }],
				}),
				executeTool: async (_bot: unknown, _runId: string, name: string) => {
					executedTools.push(name);
					return { name, result: { ok: true }, providerResult: { ok: true } };
				},
				loopGeneratedTokenCountSinceLastLogOff: () => 40,
				recordInferenceSubmission: () => {},
				recordLoopMessageLog: () => {},
				recordProviderUsage: () => {},
				repairActiveProviderToolCallHistory: async () => [],
				successfulMutatingToolCallSinceLastLogOff: () => true,
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const runProviderLoop = (BotRuntime.prototype as unknown as {
				runProviderLoop: (
					bot: BotDocument,
					settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
					runId: string,
					messages: Array<Record<string, unknown>>,
					runContext: { mode: "normal"; signal: AbortSignal },
				) => Promise<{ logOffCalled: boolean }>;
			}).runProviderLoop.bind(runtime);

			await expect(
				runProviderLoop(
					{
						...fakeBotDocument(),
						tickSettings: {
							...fakeBotDocument().tickSettings,
							allowEarlyLogOff: true,
							maxGeneratedTokensPerTick: 1_000,
							maxGeneratedTokensPerIteration: 50,
						},
					},
					{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-iteration-token-limit",
					[],
					{ mode: "normal", signal: new AbortController().signal },
				),
			).resolves.toMatchObject({ logOffCalled: true });

			expect(callProvider).toHaveBeenCalledTimes(1);
			expect(executedTools).toEqual(["read_thread", "log_off"]);
			expect(events).toContainEqual(expect.objectContaining({
				type: "assistant_message",
				payload: expect.objectContaining({
					content: "I need to take a short break from Bickr. I'll log off for now.",
				}),
			}));
		});

		it("does not inject a second synthetic logoff when token exhaustion response already logs off", async () => {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const executedTools: string[] = [];
			const callProvider = vi.fn(async () => ({
				...providerResponseWithToolCall("call-log-off", "log_off", { reason: "done" }),
				usage: providerUsageForTest(50),
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
				},
				appendLoopMessage: (
					_runId: string,
					message: Record<string, unknown>,
					origin: string,
				) => ({
					seq: events.length + executedTools.length,
					runId: "run-token-limit-real-logoff",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				}),
				appendProviderMessages: async () => {},
				callProvider,
				ensureProviderPromptWithinBudget: async () => ({
					allowedPromptTokens: 13_500,
					promptTokens: 100,
					requestMessages: [{ role: "assistant", content: "I am ready." }],
				}),
				executeTool: async (_bot: unknown, _runId: string, name: string) => {
					executedTools.push(name);
					return { name, result: { ok: true }, providerResult: { ok: true } };
				},
				recordInferenceSubmission: () => {},
				recordLoopMessageLog: () => {},
				recordProviderUsage: () => {},
				repairActiveProviderToolCallHistory: async () => [],
				successfulMutatingToolCallSinceLastLogOff: () => true,
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const runProviderLoop = (BotRuntime.prototype as unknown as {
				runProviderLoop: (
					bot: BotDocument,
					settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
					runId: string,
					messages: Array<Record<string, unknown>>,
					runContext: { mode: "normal"; signal: AbortSignal },
				) => Promise<{ logOffCalled: boolean }>;
			}).runProviderLoop.bind(runtime);

			await expect(
				runProviderLoop(
					{
						...fakeBotDocument(),
						tickSettings: {
							...fakeBotDocument().tickSettings,
							allowEarlyLogOff: true,
							maxGeneratedTokensPerTick: 1_000,
							maxGeneratedTokensPerIteration: 50,
						},
					},
					{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-token-limit-real-logoff",
					[],
					{ mode: "normal", signal: new AbortController().signal },
				),
			).resolves.toMatchObject({ logOffCalled: true });

			expect(executedTools).toEqual(["log_off"]);
			expect(events.some((event) =>
				event.type === "assistant_message" &&
				String(event.payload.content ?? "") === "I need to take a short break from Bickr. I'll log off for now.",
			)).toBe(false);
		});

		it("retries once when a generated response contains only malformed tool calls", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const submissions: Array<Array<Record<string, unknown>>> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithRawToolCalls([
				{ id: "call-bad", name: "read_thread", arguments: "{\"threadId\":" },
			]))
			.mockResolvedValueOnce(providerResponseWithToolCall("call-log-off", "log_off", { reason: "clean retry" }));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-malformed-retry",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string, _args: Record<string, unknown>) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true },
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: (input: { messages: Array<Record<string, unknown>> }) => {
				submissions.push(input.messages);
			},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-malformed-retry",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		expect(callProvider).toHaveBeenCalledTimes(2);
		expect(submissions).toHaveLength(2);
		expect(appendedLoopMessages.filter((message) => message.origin === "provider_response")).toHaveLength(1);
		expect(JSON.stringify(appendedLoopMessages)).not.toContain("call-bad");
		expect(events.filter((event) => event.type === "provider_tool_call_dropped")).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ count: 1, retrying: true }) }),
		]);
	});

	it("fails clearly when the malformed-only retry also returns only malformed tool calls", async () => {
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithRawToolCalls([
				{ id: "call-bad-1", name: "read_thread", arguments: "{\"threadId\":" },
			]))
			.mockResolvedValueOnce(providerResponseWithRawToolCalls([
				{ id: "call-bad-2", name: "read_thread", arguments: "[]" },
			]));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(type === "provider_request" ? callProvider.mock.calls.length + 1 : callProvider.mock.calls.length + 100, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-malformed-fails",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-malformed-fails",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toThrow("Inference provider returned only malformed page-control requests after retry.");

		expect(callProvider).toHaveBeenCalledTimes(2);
		expect(appendedLoopMessages).toEqual([]);
	});

	it("railroads no-tool responses by preserving them and injecting a correction", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const loopMemory = testLoopMessageMemory([{ role: "user", content: "Act." }]);
		const callProvider = vi.fn(async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
			providerMessages.push(messages);
			return providerMessages.length === 1 ?
				providerResponseWithContent("I might be done.")
			:	providerResponseWithToolCall("call-log-off", "log_off", { reason: "done after correction" });
		});
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			...loopMemory,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true },
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 3 } },
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "railroad" },
				"run-railroad-retry",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		expect(callProvider).toHaveBeenCalledTimes(2);
		expect(providerMessages[1]).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", content: "I might be done." }),
			expect.objectContaining({ role: "assistant", content: expect.stringContaining("Actually, I must use one of the following tools") }),
		]));
		expect(events.filter((event) => event.type === "assistant_message").map((event) => event.payload)).toEqual([
			expect.objectContaining({ content: expect.stringContaining("Actually, I must use one of the following tools") }),
		]);
	});

	it("recovers when a required-tool provider response returns no tool calls", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const loopMemory = testLoopMessageMemory([{ role: "user", content: "Act." }]);
		const callProvider = vi.fn(async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
			providerMessages.push(messages);
			return providerMessages.length === 1 ?
				providerResponseWithContent("I should think about this without touching the page.")
			:	providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" });
		});
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			...loopMemory,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true },
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean; toolCallCount: number }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 1 } },
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-required-no-tool-retry",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false, toolCallCount: 1 });

		expect(callProvider).toHaveBeenCalledTimes(2);
		expect(providerMessages[1]).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", content: "I should think about this without touching the page." }),
			expect.objectContaining({ role: "assistant", content: expect.stringContaining("Actually, I must use one of the following tools") }),
		]));
		expect(events.filter((event) => event.type === "assistant_message").map((event) => event.payload)).toEqual([
			expect.objectContaining({ content: expect.stringContaining("Actually, I must use one of the following tools") }),
		]);
	});

	it("stops railroad retries after five no-tool responses", async () => {
		const loopMemory = testLoopMessageMemory([{ role: "user", content: "Act." }]);
		const appendedLoopMessages: Array<{ origin: string; message: Record<string, unknown> }> = [];
		const callProvider = vi.fn(async () => providerResponseWithContent("Still thinking."));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			...loopMemory,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(callProvider.mock.calls.length + appendedLoopMessages.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ origin, message });
				return loopMemory.appendLoopMessage(runId, message, origin);
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "user", content: "Act." }],
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 10 } },
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "railroad" },
				"run-railroad-fails",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toThrow("Stopped after 5 inference responses without a required tool call.");

		expect(callProvider).toHaveBeenCalledTimes(5);
		expect(appendedLoopMessages.filter((message) => message.origin === "provider_response")).toHaveLength(5);
		expect(appendedLoopMessages.filter((message) => message.origin === "self_correction")).toHaveLength(4);
	});

	it("at-will no-tool responses finish without self-correction", async () => {
		const providerToolsByCall: string[][] = [];
		const systemPromptsByCall: string[] = [];
		const appendedLoopMessages: Array<{ origin: string; message: Record<string, unknown> }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(providerToolsByCall.length + appendedLoopMessages.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ origin, message });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-at-will-noop",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>, tools: ProviderToolDefinition[]) => {
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				systemPromptsByCall.push(String(messages[0]?.content ?? ""));
				return providerResponseWithContent("No page control needed.");
			},
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: false }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-at-will-noop",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerToolsByCall).toHaveLength(1);
		expect(providerToolsByCall[0]).not.toContain("log_off");
		expect(systemPromptsByCall[0]).not.toContain("log_off");
		expect(appendedLoopMessages.map((message) => message.origin)).toEqual(["provider_response"]);
	});

	it("drops generated log_off calls when early logoff is disabled", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const executedTools: string[] = [];
		const providerToolsByCall: string[][] = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCall("call-log-off", "log_off", { reason: "done" }))
			.mockResolvedValueOnce(providerResponseWithContent("I will keep going."));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: events.length,
				runId: "run-disallowed-logoff",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (
				settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
				tools: ProviderToolDefinition[],
				runId: string,
				streamSeq: number,
				signal: AbortSignal,
			) => {
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				return callProvider(settings, messages, tools, runId, streamSeq, signal);
			},
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: false }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-disallowed-logoff",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerToolsByCall[0]).not.toContain("log_off");
		expect(executedTools).toEqual([]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				callIds: ["call-log-off"],
				reason: "disallowed_log_off",
			}),
		}));
		expect(events).toContainEqual(expect.objectContaining({
			type: "assistant_message",
			payload: expect.objectContaining({
				content: "I can't log off early in this Bickr visit, so I need to use another available Bickr control or continue normally.",
			}),
		}));
	});

	it("keeps log_off in the schema before and after a mutating tool succeeds", async () => {
		const providerToolsByCall: string[][] = [];
		const systemPromptsByCall: string[] = [];
		let providerCall = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(providerCall + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: providerCall,
				runId: "run-logoff-gate",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>, tools: ProviderToolDefinition[]) => {
				providerCall += 1;
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				systemPromptsByCall.push(String(messages[0]?.content ?? ""));
				return providerCall === 1 ?
					providerResponseWithToolCall("call-create", "create_thread", { forumHandle: "general", title: "Hello", body: "Body." })
				:	providerResponseWithToolCall("call-log-off", "log_off", { reason: "done after posting" });
			},
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true },
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 2 } },
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-logoff-gate",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		const firstRequirement = systemPromptsByCall[0]?.match(/You MUST use one of the following tools: [^\n]+/)?.[0] ?? "";
		const secondRequirement = systemPromptsByCall[1]?.match(/You MUST use one of the following tools: [^\n]+/)?.[0] ?? "";
		expect(providerToolsByCall[0]).toContain("log_off");
		expect(firstRequirement).toContain("log_off");
		expect(providerToolsByCall[1]).toContain("log_off");
		expect(secondRequirement).toContain("log_off");
	});

	it("keeps log_off available across compaction in the current iteration", async () => {
		const providerToolsByCall: string[][] = [];
		const sql = {
			exec<T>(query: string, ...params: unknown[]) {
				if (/WHERE type = 'compaction'/.test(query)) {
					return {
						toArray: () => [{
							seq: 10,
							run_id: "run-before",
							type: "compaction",
							payload_json: JSON.stringify({ status: "complete" }),
							token_estimate: 0,
							compacted_by: null,
							created_at: "2026-05-01T00:00:00.000Z",
						} as T],
					};
				}
				if (/WHERE seq > \?\s+AND type = 'tool_result'/.test(query)) {
					const sinceSeq = Number(params[0]);
					const rows = sinceSeq < 5 ? [{
						seq: 5,
						run_id: "run-before",
						type: "tool_result",
						payload_json: JSON.stringify({ name: "vote", result: { ok: true } }),
						token_estimate: 0,
						compacted_by: null,
						created_at: "2026-05-01T00:00:00.000Z",
					} as T] : [];
					return { toArray: () => rows };
				}
				return { one: () => ({} as T), toArray: () => [] as T[] };
			},
		};
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(providerToolsByCall.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: 1,
				runId: "run-logoff-through-compaction",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, _messages: unknown, tools: ProviderToolDefinition[]) => {
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				return providerResponseWithContent("No action.");
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "system", content: "Prompt." }],
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			state: { storage: { sql } },
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-logoff-through-compaction",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerToolsByCall).toHaveLength(1);
		expect(providerToolsByCall[0]).toContain("log_off");
	});

	it("resets iteration tool quota and log_off availability after successful logoff", async () => {
		const providerToolsByCall: string[][] = [];
		const sql = {
			exec<T>(query: string, ...params: unknown[]) {
				if (/payload_json LIKE '%"name":"log_off"%'/s.test(query)) {
					return {
						toArray: () => [{
							seq: 8,
							run_id: "run-before",
							type: "tool_result",
							payload_json: JSON.stringify({ name: "log_off", result: { ok: true } }),
							token_estimate: 0,
							compacted_by: null,
							created_at: "2026-05-01T00:00:00.000Z",
						} as T],
					};
				}
				if (/WHERE seq > \?\s+AND type = 'tool_result'/.test(query)) {
					const sinceSeq = Number(params[0]);
					const rows = [
						{ seq: 1, name: "vote" },
						{ seq: 2, name: "read_thread" },
						{ seq: 3, name: "read_thread" },
						{ seq: 4, name: "read_thread" },
						{ seq: 5, name: "read_thread" },
						{ seq: 6, name: "read_thread" },
						{ seq: 7, name: "read_thread" },
					]
						.filter((row) => row.seq > sinceSeq)
						.map((row) => ({
							seq: row.seq,
							run_id: "run-before",
							type: "tool_result",
							payload_json: JSON.stringify({ name: row.name, result: { ok: true } }),
							token_estimate: 0,
							compacted_by: null,
							created_at: "2026-05-01T00:00:00.000Z",
						} as T));
					return { toArray: () => rows };
				}
				return { one: () => ({} as T), toArray: () => [] as T[] };
			},
		};
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(providerToolsByCall.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: 1,
				runId: "run-after-logoff",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, _messages: unknown, tools: ProviderToolDefinition[]) => {
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				return providerResponseWithContent("New visit can act normally.");
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: [{ role: "system", content: "Prompt." }],
			}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			state: { storage: { sql } },
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-after-logoff",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerToolsByCall).toHaveLength(1);
		expect(providerToolsByCall[0]).not.toEqual(["log_off"]);
		expect(providerToolsByCall[0]).toContain("log_off");
	});

	it("repairs poisoned active history before recording the next inference submission", async () => {
		const rows: LoopMessageRowForTest[] = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call-poisoned",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":" },
					},
				],
			}),
			loopMessageRowForMessage(2, {
				role: "tool",
				tool_call_id: "call-poisoned",
				content: "{\"ok\":true}",
			}, "tool_result"),
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const submissions: Array<Array<Record<string, unknown>>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: {
				storage: {
					sql: {
						exec: vi.fn(<T,>(query: string, ...params: unknown[]) => {
							const normalized = query.trim().replace(/\s+/g, " ");
							if (/UPDATE loop_messages SET deleted_at = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[1]));
								if (row && !row.deleted_at) {
									row.deleted_at = String(params[0]);
								}
							}
							if (/UPDATE loop_messages SET message_json = \?, token_estimate = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[2]));
								if (row && !row.deleted_at) {
									row.message_json = String(params[0]);
									row.token_estimate = Number(params[1]);
								}
							}
							return {
								one: () => ({} as T),
								toArray: () => [] as T[],
							};
						}),
					},
				},
			},
			activeLoopMessageRows: () => rows.filter((row) => row.deleted_at === null),
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: () => ({ seq: 99, runId: "run-history-repair", role: "assistant", message: {}, origin: "provider_response", tokenEstimate: 0, createdAt: new Date().toISOString() }),
			appendProviderMessages: async () => {},
			broadcastControl: () => {},
			callProvider: async () => providerResponseWithContent("Clean history is ready."),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as { activeLoopMessagesForProvider: () => Array<Record<string, unknown>> }).activeLoopMessagesForProvider.bind(runtime)(),
			}),
			recordInferenceSubmission: (input: { messages: Array<Record<string, unknown>> }) => {
				submissions.push(input.messages);
			},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-history-repair",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(rows.every((row) => row.deleted_at !== null)).toBe(true);
		expect(JSON.stringify(submissions[0] ?? [])).not.toContain("{\"threadId\":");
		expect((submissions[0] ?? []).some((message) => message.role === "tool")).toBe(false);
		expect(events[0]).toMatchObject({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({ phase: "history_repair", callIds: ["call-poisoned"] }),
		});
	});

	it("repairs duplicate tool call ids in active history before provider submission", async () => {
		const rows = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call-duplicate",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":\"thr_keep\"}" },
					},
					{
						id: "call-duplicate",
						type: "function",
						function: { name: "reply_to_comment", arguments: "{\"commentId\":\"com_drop\",\"body\":\"Ambiguous duplicate.\"}" },
					},
				],
			}),
			loopMessageRowForMessage(2, {
				role: "tool",
				tool_call_id: "call-duplicate",
				content: "{\"ok\":true,\"kept\":true}",
			}, "tool_result"),
			loopMessageRowForMessage(3, {
				role: "tool",
				tool_call_id: "call-duplicate",
				content: "{\"ok\":true,\"dropped\":true}",
			}, "tool_result"),
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const submissions: Array<Array<Record<string, unknown>>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: {
				storage: {
					sql: {
						exec: vi.fn(<T,>(query: string, ...params: unknown[]) => {
							const normalized = query.trim().replace(/\s+/g, " ");
							if (/UPDATE loop_messages SET deleted_at = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[1]));
								if (row && !row.deleted_at) {
									row.deleted_at = String(params[0]);
								}
							}
							if (/UPDATE loop_messages SET message_json = \?, token_estimate = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[2]));
								if (row && !row.deleted_at) {
									row.message_json = String(params[0]);
									row.token_estimate = Number(params[1]);
								}
							}
							return {
								one: () => ({} as T),
								toArray: () => [] as T[],
							};
						}),
					},
				},
			},
			activeLoopMessageRows: () => rows.filter((row) => row.deleted_at === null),
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: () => ({ seq: 99, runId: "run-duplicate-history-repair", role: "assistant", message: {}, origin: "provider_response", tokenEstimate: 0, createdAt: new Date().toISOString() }),
			appendProviderMessages: async () => {},
			broadcastControl: () => {},
			callProvider: async () => providerResponseWithContent("Clean history is ready."),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as { activeLoopMessagesForProvider: () => Array<Record<string, unknown>> }).activeLoopMessagesForProvider.bind(runtime)(),
			}),
			recordInferenceSubmission: (input: { messages: Array<Record<string, unknown>> }) => {
				submissions.push(input.messages);
			},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-duplicate-history-repair",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		const repairedAssistant = JSON.parse(rows[0]!.message_json) as BotInferenceSubmissionMessage;
		expect(repairedAssistant.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call-duplicate"]);
		expect(repairedAssistant.tool_calls?.[0]?.function.name).toBe("read_thread");
		expect(rows[1]?.deleted_at).toBeNull();
		expect(rows[2]?.deleted_at).toMatch(/^20/);
		const submittedAssistant = submissions[0]?.find((message) => Array.isArray(message.tool_calls)) as BotInferenceSubmissionMessage | undefined;
		expect(submittedAssistant?.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call-duplicate"]);
		expect(submissions[0]?.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call-duplicate"]);
		expect(JSON.stringify(submissions[0])).not.toContain("com_drop");
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				phase: "history_repair",
				callIds: ["call-duplicate"],
				reason: "duplicate_tool_call",
			}),
		}));
	});

	it("splits legacy multi-call assistant history into interleaved single-call groups", async () => {
		let nextSeq = 6;
		let lastInsertSeq = 0;
		const rows: LoopMessageRowForTest[] = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: "I searched several things.",
				tool_calls: [
					{ id: "call-search-a", type: "function", function: { name: "search_threads", arguments: "{\"query\":\"a\"}" } },
					{ id: "call-search-b", type: "function", function: { name: "search_threads", arguments: "{\"query\":\"b\"}" } },
					{ id: "call-search-c", type: "function", function: { name: "search_threads", arguments: "{\"query\":\"c\"}" } },
				],
			}),
			loopMessageRowForMessage(2, { role: "tool", tool_call_id: "call-search-a", content: "{\"ok\":true,\"a\":true}" }, "tool_result"),
			loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-search-b", content: "{\"ok\":true,\"b\":true}" }, "tool_result"),
			loopMessageRowForMessage(4, { role: "tool", tool_call_id: "call-search-c", content: "{\"ok\":true,\"c\":true}" }, "tool_result"),
			loopMessageRowForMessage(5, { role: "assistant", content: "After searches." }),
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: {
				storage: {
					sql: {
						exec: vi.fn(<T,>(query: string, ...params: unknown[]) => {
							const normalized = query.trim().replace(/\s+/g, " ");
							if (/INSERT INTO loop_messages/.test(normalized)) {
								lastInsertSeq = nextSeq;
								rows.push({
									seq: nextSeq,
									position: Number(params[0]),
									run_id: String(params[1]),
									role: params[2] as BotLoopMessage["role"],
									message_json: String(params[3]),
									origin: params[4] as BotLoopMessage["origin"],
									status: String(params[5] ?? "complete"),
									token_estimate: Number(params[6]),
									stream_seq: params[7] === null ? null : Number(params[7]),
									display_event_seq: params[8] === null ? null : Number(params[8]),
									display_event_type: null,
									display_event_payload_json: null,
									compacted_by: null,
									deleted_at: null,
									created_at: String(params[9]),
									has_logs: 0,
								});
								nextSeq += 1;
							}
							if (/SELECT last_insert_rowid\(\) AS seq/.test(normalized)) {
								return {
									one: () => ({ seq: lastInsertSeq } as T),
									toArray: () => [] as T[],
								};
							}
							if (normalized.includes("MAX(position)")) {
								const activePositions = rows
									.filter((row) => row.deleted_at === null && row.compacted_by === null && Number.isFinite(row.position))
									.map((row) => row.position);
								return {
									one: () => ({ position: Math.max(0, ...activePositions) + 1 } as T),
									toArray: () => [] as T[],
								};
							}
							if (normalized.includes("MIN(position)")) {
								const activePositions = rows
									.filter((row) => row.deleted_at === null && row.compacted_by === null && Number.isFinite(row.position))
									.map((row) => row.position);
								return {
									one: () => ({ position: Math.min(...activePositions) } as T),
									toArray: () => [] as T[],
								};
							}
							if (/UPDATE loop_messages SET message_json = \?, token_estimate = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[2]));
								if (row && !row.deleted_at) {
									row.message_json = String(params[0]);
									row.token_estimate = Number(params[1]);
								}
							}
							if (normalized.startsWith("UPDATE loop_messages") && normalized.includes("position = ?")) {
								const row = rows.find((item) => item.seq === Number(params[1]));
								if (row && !row.deleted_at) {
									row.position = Number(params[0]);
								}
							}
							return {
								one: () => ({} as T),
								toArray: () => [] as T[],
							};
						}),
					},
				},
			},
			activeLoopMessageRows: () => rows.filter((row) => row.deleted_at === null).sort((left, right) => left.position - right.position || left.seq - right.seq),
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			broadcastControl: () => {},
			recordLoopMessageLog: () => {},
		});
		const repairActiveProviderToolCallHistory = (BotRuntime.prototype as unknown as {
			repairActiveProviderToolCallHistory: (runId: string) => Promise<unknown[]>;
		}).repairActiveProviderToolCallHistory.bind(runtime);

		await expect(repairActiveProviderToolCallHistory("run-split-history")).resolves.toEqual([]);

		const messages = rows
			.filter((row) => row.deleted_at === null)
			.sort((left, right) => left.position - right.position || left.seq - right.seq)
			.map((row) => JSON.parse(row.message_json) as BotInferenceSubmissionMessage);
		expect(messages.map((message) => ({
			role: message.role,
			toolCallIds: message.tool_calls?.map((toolCall) => toolCall.id),
			toolCallId: message.tool_call_id,
			content: message.content,
		}))).toEqual([
			{ role: "assistant", toolCallIds: ["call-search-a"], toolCallId: undefined, content: "I searched several things." },
			{ role: "tool", toolCallIds: undefined, toolCallId: "call-search-a", content: "{\"ok\":true,\"a\":true}" },
			{ role: "assistant", toolCallIds: ["call-search-b"], toolCallId: undefined, content: null },
			{ role: "tool", toolCallIds: undefined, toolCallId: "call-search-b", content: "{\"ok\":true,\"b\":true}" },
			{ role: "assistant", toolCallIds: ["call-search-c"], toolCallId: undefined, content: null },
			{ role: "tool", toolCallIds: undefined, toolCallId: "call-search-c", content: "{\"ok\":true,\"c\":true}" },
			{ role: "assistant", toolCallIds: undefined, toolCallId: undefined, content: "After searches." },
		]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_history_repaired",
			payload: expect.objectContaining({
				count: 2,
				messageSeqs: [1, 6, 7],
				reason: "split_multi_tool_call_message",
			}),
		}));
	});

	it("repairs invalid Unicode in active history before provider submission", async () => {
		const high = "\uD83C";
		const rows = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: `Compacted memory ends badly ${high}`,
			}, "compaction"),
			loopMessageRowForMessage(2, {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call-valid",
						type: "function",
						function: { name: "read_thread", arguments: JSON.stringify({ threadId: "thr_test", note: `bad ${high}` }) },
					},
				],
			}),
			loopMessageRowForMessage(3, {
				role: "tool",
				tool_call_id: "call-valid",
				content: JSON.stringify({ ok: true, text: `bad ${high}` }),
			}, "tool_result"),
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const submissions: Array<Array<Record<string, unknown>>> = [];
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: {
				storage: {
					sql: {
						exec: vi.fn(<T,>(query: string, ...params: unknown[]) => {
							const normalized = query.trim().replace(/\s+/g, " ");
							if (/UPDATE loop_messages SET message_json = \?, token_estimate = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[2]));
								if (row && !row.deleted_at) {
									row.message_json = String(params[0]);
									row.token_estimate = Number(params[1]);
								}
							}
							if (/UPDATE loop_messages SET deleted_at = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[1]));
								if (row && !row.deleted_at) {
									row.deleted_at = String(params[0]);
								}
							}
							return {
								one: () => ({} as T),
								toArray: () => [] as T[],
							};
						}),
					},
				},
			},
			activeLoopMessageRows: () => rows.filter((row) => row.deleted_at === null),
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: () => ({ seq: 99, runId: "run-unicode-history-repair", role: "assistant", message: {}, origin: "provider_response", tokenEstimate: 0, createdAt: new Date().toISOString() }),
			appendProviderMessages: async () => {},
			broadcastControl: () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
				providerMessages.push(messages);
				return providerResponseWithContent("Clean history is ready.");
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as { activeLoopMessagesForProvider: () => Array<Record<string, unknown>> }).activeLoopMessagesForProvider.bind(runtime)(),
			}),
			recordInferenceSubmission: (input: { messages: Array<Record<string, unknown>> }) => {
				submissions.push(input.messages);
			},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-unicode-history-repair",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(hasLoneSurrogate(submissions[0])).toBe(false);
		expect(hasLoneSurrogate(providerMessages[0])).toBe(false);
		expect(JSON.stringify(submissions[0])).not.toContain("\\ud83c");
		const repairedToolCallMessage = submissions[0]?.find((message) => Array.isArray(message.tool_calls));
		const repairedToolCalls = repairedToolCallMessage?.tool_calls as Array<{ function: { arguments: string } }> | undefined;
		expect(JSON.parse(repairedToolCalls?.[0]?.function.arguments ?? "{}")).toMatchObject({ note: "bad \uFFFD" });
		const repairedToolResult = submissions[0]?.find((message) => message.role === "tool");
		expect(repairedToolResult?.content).toContain("\uFFFD");
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_history_repaired",
			payload: expect.objectContaining({
				count: 3,
				messageSeqs: [1, 2, 3],
				reason: "invalid_unicode_text",
			}),
		}));
	});

	it("repairs fragmented reasoning details in active provider history", async () => {
		const rows = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: null,
				reasoning_details: [
					{ type: "reasoning.text", text: "I will ", format: "unknown", index: 0 },
					{ type: "reasoning.text", text: "use a tool.", format: "unknown", index: 0 },
				],
				tool_calls: [
					{
						id: "call-valid",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
					},
				],
			}),
			loopMessageRowForMessage(2, {
				role: "tool",
				tool_call_id: "call-valid",
				content: "{\"ok\":true}",
			}, "tool_result"),
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: {
				storage: {
					sql: {
						exec: vi.fn(<T,>(query: string, ...params: unknown[]) => {
							const normalized = query.trim().replace(/\s+/g, " ");
							if (/UPDATE loop_messages SET message_json = \?, token_estimate = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[2]));
								if (row && !row.deleted_at) {
									row.message_json = String(params[0]);
									row.token_estimate = Number(params[1]);
								}
							}
							if (/UPDATE loop_messages SET deleted_at = \?/.test(normalized)) {
								const row = rows.find((item) => item.seq === Number(params[1]));
								if (row && !row.deleted_at) {
									row.deleted_at = String(params[0]);
								}
							}
							return {
								one: () => ({} as T),
								toArray: () => [] as T[],
							};
						}),
					},
				},
			},
			activeLoopMessageRows: () => rows.filter((row) => row.deleted_at === null),
			broadcastControl: () => {},
		});
		const repairActiveProviderToolCallHistory = (BotRuntime.prototype as unknown as {
			repairActiveProviderToolCallHistory: (runId: string) => Promise<unknown[]>;
		}).repairActiveProviderToolCallHistory.bind(runtime);

		await expect(repairActiveProviderToolCallHistory("run-reasoning-repair")).resolves.toEqual([]);

		expect(rows[0]?.deleted_at).toBeNull();
		expect(rows[1]?.deleted_at).toBeNull();
		expect(JSON.parse(rows[0]?.message_json ?? "{}")).toMatchObject({
			reasoning_details: [
				{ type: "reasoning.text", text: "I will use a tool.", format: "unknown", index: 0 },
			],
			tool_calls: [
				expect.objectContaining({ id: "call-valid" }),
			],
		});
	});

	it("records tick failures in the loop ledger", async () => {
		const appendedLoopMessages: Array<{ runId: string; message: Record<string, unknown>; origin: string }> = [];
		const events: Array<{ runId: string; type: string; payload: Record<string, unknown> }> = [];
		const recordLoopMessageLog = vi.fn();
		const providerMessage = "Inference request failed with status 400. Response: TextEncodeInput must be Union[TextInputSequence].";
		const pendingCompactionPayload = { status: "pending", fromSeq: 10, toSeq: 20, messageCount: 3 };
		const completedCompactionPayload = { status: "complete", summaryMessageSeq: 40 };
		const updatedCompactions: unknown[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: {
				storage: {
					sql: {
						exec: vi.fn(() => ({
							toArray: () => [
								{
									seq: 2,
									run_id: "run-provider-failed",
									type: "compaction",
									payload_json: JSON.stringify(pendingCompactionPayload),
									token_estimate: 8,
									created_at: "2026-05-20T19:41:40.934Z",
									compacted_by: null,
								},
								{
									seq: 3,
									run_id: "run-provider-failed",
									type: "compaction",
									payload_json: JSON.stringify(completedCompactionPayload),
									token_estimate: 8,
									created_at: "2026-05-20T19:56:34.524Z",
									compacted_by: null,
								},
							],
						})),
					},
				},
			},
			appendLoopMessage: (
				runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => {
				appendedLoopMessages.push({ runId, message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId,
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ runId, type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			recordLoopMessageLog,
			replaceEventPayload: (event: BotRuntimeEvent, payload: unknown) => {
				updatedCompactions.push({ event, payload });
				return { ...event, payload };
			},
		});
		const recordTickFailure = (BotRuntime.prototype as unknown as {
			recordTickFailure: (
				runId: string,
				payload: Record<string, unknown>,
				logs?: Array<{ kind: BotLoopMessageLog["kind"]; text: string }>,
			) => Promise<BotRuntimeEvent>;
		}).recordTickFailure.bind(runtime);

		await expect(
			recordTickFailure("run-provider-failed", { message: providerMessage }, [
				{ kind: "provider_request", text: "{\"stream\":true}" },
				{ kind: "provider_response", text: "{\"error\":\"provider 500\"}" },
				{ kind: "compaction_request", text: "{\"messages\":[]}" },
				{ kind: "compaction_response", text: "{\"error\":\"bad schema\"}" },
			]),
		).resolves.toMatchObject({ type: "tick_failed" });

		expect(events).toEqual([
			{
				runId: "run-provider-failed",
				type: "tick_failed",
				payload: { message: providerMessage },
			},
		]);
		expect(appendedLoopMessages).toEqual([
			{
				runId: "run-provider-failed",
				origin: "runtime_error",
				message: {
					role: "user",
					content: runtimeErrorLoopMessageContent(providerMessage),
				},
			},
		]);
		expect(String(appendedLoopMessages[0]?.message.content)).toContain("TextEncodeInput");
		expect(String(appendedLoopMessages[0]?.message.content)).toMatch(/^Inference provider returned an error: /);
		expect(String(appendedLoopMessages[0]?.message.content)).not.toContain("Bickr website crashed");
		expect(recordLoopMessageLog).toHaveBeenCalledWith(1, "provider_request", "{\"stream\":true}");
		expect(recordLoopMessageLog).toHaveBeenCalledWith(1, "provider_response", "{\"error\":\"provider 500\"}");
		expect(recordLoopMessageLog).toHaveBeenCalledWith(1, "compaction_request", "{\"messages\":[]}");
		expect(recordLoopMessageLog).toHaveBeenCalledWith(1, "compaction_response", "{\"error\":\"bad schema\"}");
		expect(updatedCompactions).toEqual([
			{
				event: expect.objectContaining({
					seq: 2,
					runId: "run-provider-failed",
					type: "compaction",
					payload: pendingCompactionPayload,
				}),
				payload: {
					...pendingCompactionPayload,
					status: "failed",
					error: providerMessage,
				},
			},
		]);
	});

	it("records schema-invalid provider failures as owner notifications", async () => {
			const bot = fakeBotDocument({
				id: "bot_schema_invalid_notice",
				ownerUserId: "user_schema_invalid_owner",
				homeWorldId: "world_schema_invalid",
				homeWorldHandle: "patch-notes",
				handle: "release-sage",
				displayName: "Release Sage",
			});
		const message =
			`Inference provider returned schema-invalid compaction tool arguments: Unexpected argument summary; only ${providerCompactionSummaryProperty} is allowed.`;

		await recordBotRuntimeFailureHumanNotification(testEnv.BICKR_D1, {
			bot,
			runId: "run-schema-invalid-notice",
			message,
			now: "2026-05-07T12:00:00.000Z",
		});

		const row = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, url_path AS urlPath
			 FROM human_notifications
			 WHERE event_key = ?`,
		)
			.bind("bot_runtime_failed:bot_schema_invalid_notice:run-schema-invalid-notice")
			.first<{ body: string; notificationType: string; title: string; urlPath: string }>();
		expect(row).toMatchObject({
			notificationType: "bot_runtime_failed",
			title: "Release Sage loop run failed",
			urlPath: "/w/patch-notes/u/release-sage/loop",
		});
		expect(row?.body).toContain("schema-invalid compaction tool arguments");
		expect(row?.body).toContain("Check the loop log and inference settings.");
	});

	it("records empty provider response failures as owner notifications", async () => {
			const bot = fakeBotDocument({
				id: "bot_empty_provider_notice",
				ownerUserId: "user_empty_provider_owner",
				homeWorldId: "world_empty_provider",
				homeWorldHandle: "primary",
				handle: "donald-trump",
				displayName: "Donald Trump",
			});
		const message = [
			"Inference failed before retrying; error from provider:",
			"Inference provider returned an empty response with no content, reasoning, or tool calls.",
		].join("\n");

		await recordBotRuntimeFailureHumanNotification(testEnv.BICKR_D1, {
			bot,
			runId: "run-empty-provider-notice",
			message,
			now: "2026-05-07T12:30:00.000Z",
		});

		const row = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, url_path AS urlPath
			 FROM human_notifications
			 WHERE event_key = ?`,
		)
			.bind("bot_runtime_failed:bot_empty_provider_notice:run-empty-provider-notice")
			.first<{ body: string; notificationType: string; title: string; urlPath: string }>();
		expect(row).toMatchObject({
			notificationType: "bot_runtime_failed",
			title: "Donald Trump loop run failed",
			urlPath: "/w/primary/u/donald-trump/loop",
		});
		expect(row?.body).toContain("Inference provider returned an empty response with no content, reasoning, or tool calls.");
		expect(row?.body).not.toContain("Inference failed before retrying");
		expect(row?.body).toContain("Check the loop log and inference settings.");
	});

	it("returns the bootstrap payload", async () => {
		const response = await bootstrap(
			contextFor<typeof bootstrap>(new Request("http://example.com/api/bootstrap")),
		);
		const payload = (await response.json()) as {
			app: { name: string };
			pillars: Array<unknown>;
			seedForums: Array<{ name: string }>;
		};

		expect(response.status).toBe(200);
		expect(payload.app.name).toBe("Bickr");
		expect(payload.pillars).toHaveLength(3);
		expect(payload.seedForums.map((forum) => forum.name)).toContain("r/shipwars");
	});

	it("returns bound Worker runtime health", async () => {
		const response = await runtimeHealth(
			contextFor<typeof runtimeHealth>(new Request("http://example.com/api/runtime/health")),
		);
		const payload = (await response.json()) as {
			services: {
				agentRuntime: { ok: boolean };
				forumCoordinator: { ok: boolean };
			};
		};

		expect(response.status).toBe(200);
		expect(payload.services.agentRuntime.ok).toBe(true);
		expect(payload.services.forumCoordinator.ok).toBe(true);
	});

	it("rebuilds Pages service requests from safe protocol headers", () => {
		const browserRequest = new Request("https://test.bickr.social/api/me/bots/bot_1/runtime/messages", {
			headers: {
				accept: "text/event-stream",
				authorization: "Bearer browser-token",
				connection: "Upgrade",
				"content-type": "text/plain",
				cookie: "bickr_session=browser-session",
				"sec-websocket-key": "websocket-key",
				"sec-websocket-protocol": "chat",
				"sec-websocket-version": "13",
				upgrade: "websocket",
				"x-bickr-bot-id": "spoofed-bot",
				"x-bickr-scheduler": "1",
				"x-bickr-user-id": "spoofed-user",
			},
			method: "GET",
		});
		const proxied = buildServiceRequest(browserRequest, "/bots/bot_1/messages", "server-user");

		expect(proxied.url).toBe("https://internal.bickr/bots/bot_1/messages");
		expect(proxied.headers.get("x-bickr-user-id")).toBe("server-user");
		expect(proxied.headers.get("accept")).toBe("text/event-stream");
		expect(proxied.headers.get("upgrade")).toBe("websocket");
		expect(proxied.headers.get("connection")).toBe("Upgrade");
		expect(proxied.headers.get("sec-websocket-key")).toBe("websocket-key");
		expect(proxied.headers.get("sec-websocket-protocol")).toBe("chat");
		expect(proxied.headers.get("sec-websocket-version")).toBe("13");
		expect(proxied.headers.get("authorization")).toBeNull();
		expect(proxied.headers.get("cookie")).toBeNull();
		expect(proxied.headers.get("x-bickr-bot-id")).toBeNull();
		expect(proxied.headers.get("x-bickr-scheduler")).toBeNull();
		expect(proxied.headers.get("content-type")).toBeNull();

		const jsonProxied = buildServiceRequest(
			new Request("https://test.bickr.social/api/me/profile", {
				headers: { "content-type": "application/json;charset=UTF-8" },
				method: "PATCH",
			}),
			"/users/server-user/profile",
			"server-user",
		);
		expect(jsonProxied.headers.get("content-type")).toBe("application/json");
	});

	it("does not forward privileged browser headers through Pages runtime routes", async () => {
		const cookie = await authCookieFor({
			displayName: "Header Smuggle",
			login: "header-smuggle",
			subject: "header-smuggle",
		});
		const userId = await userIdForHandle("header-smuggle");
		const forwarded: Request[] = [];
		const response = await runtimeMessagesRoute(
			contextFor<typeof runtimeMessagesRoute>(
				new Request("http://example.com/api/me/bots/bot_header/runtime/messages", {
					headers: {
						authorization: "Bearer attacker",
						cookie,
						"x-bickr-bot-id": "spoofed-bot",
						"x-bickr-scheduler": "1",
						"x-bickr-user-id": "spoofed-user",
					},
				}),
				{ botId: "bot_header" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							forwarded.push(request);
							return Response.json({ ok: true, data: { messages: [] } });
						},
					} as unknown as Fetcher,
				},
			),
		);

		expect(response.status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0]!.url).toBe("https://internal.bickr/bots/bot_header/messages");
		expect(forwarded[0]!.headers.get("x-bickr-user-id")).toBe(userId);
		expect(forwarded[0]!.headers.get("x-bickr-scheduler")).toBeNull();
		expect(forwarded[0]!.headers.get("x-bickr-bot-id")).toBeNull();
		expect(forwarded[0]!.headers.get("authorization")).toBeNull();
		expect(forwarded[0]!.headers.get("cookie")).toBeNull();
	});

	it("rejects public-style Worker hosts before honoring internal debug headers", async () => {
		const spoofedAgent = await agentRuntimeWorker.fetch(
			new Request("https://bickr-agent-runtime-test.example.workers.dev/health", {
				headers: {
					"x-bickr-scheduler": "1",
					"x-bickr-user-id": "spoofed-user",
				},
			}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			{} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);
		expect(spoofedAgent.status).toBe(404);

		const internalAgent = await agentRuntimeWorker.fetch(
			new Request("https://internal.bickr/health") as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			{} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);
		expect(internalAgent.status).toBe(200);

		const spoofedForumHealth = await forumCoordinatorWorker.fetch(
			new Request("https://bickr-forum-coordinator-test.example.workers.dev/health", {
				headers: { "x-bickr-scheduler": "1" },
			}) as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			{} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);
		expect(spoofedForumHealth.status).toBe(404);

		const spoofedForumBot = await forumCoordinatorWorker.fetch(
			jsonRequest(
				"https://bickr-forum-coordinator-test.example.workers.dev/forums/forum_1/threads",
				"POST",
				{ title: "Spoofed thread", body: "Public Worker URL" },
				undefined,
				{ "x-bickr-bot-id": "spoofed-bot" },
			) as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			{} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);
		expect(spoofedForumBot.status).toBe(404);

		const internalForum = await forumCoordinatorWorker.fetch(
			new Request("https://internal.bickr/health") as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			{} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);
		expect(internalForum.status).toBe(200);
	});

	it("requires scheduler intent for internal vector reindexing", async () => {
		const response = await handleAgentRuntimeRequest(
			new Request("https://internal.bickr/search/reindex-vectors", {
				headers: { "x-bickr-user-id": "service-user" },
				method: "POST",
			}),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
	});

	it("rejects unauthenticated mutations", async () => {
		const response = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", {
					handle: "alpha",
					name: "Alpha",
					description: "A world",
				}),
			),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
	});

	it("notifies distinct bot owners when world settings change without spamming unread notifications", async () => {
		const ownerCookie = await authCookieFor({ subject: "world-settings-owner", login: "world-settings-owner", displayName: "World Owner" });
		const guestCookie = await authCookieFor({ subject: "world-settings-guest", login: "world-settings-guest", displayName: "World Guest" });
		await createWorldForTest(ownerCookie, "settings-lab", "Settings Lab");
		const ownerBot = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/settings-lab/bots",
					"POST",
					{ handle: "owner-bot", displayName: "Owner Bot", shortBio: "Owner participant.", prompt: "Watch settings." },
					ownerCookie,
				),
				{ worldHandle: "settings-lab" },
			),
		);
		expect(ownerBot.status, await ownerBot.clone().text()).toBe(201);
		for (const handle of ["guest-one", "guest-two"]) {
			const guestBot = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/settings-lab/bots",
						"POST",
						{ handle, displayName: handle, shortBio: "Guest participant.", prompt: "Watch settings." },
						guestCookie,
					),
					{ worldHandle: "settings-lab" },
				),
			);
			expect(guestBot.status, await guestBot.clone().text()).toBe(201);
		}
		const ownerId = await userIdForHandle("world-settings-owner");
		const guestId = await userIdForHandle("world-settings-guest");

		const firstPatch = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest("http://example.com/api/worlds/settings-lab", "PATCH", { prompt: "A brighter setting." }, ownerCookie),
				{ worldHandle: "settings-lab" },
			),
		);
		expect(firstPatch.status, await firstPatch.clone().text()).toBe(200);
		let rows = await testEnv.BICKR_D1.prepare(
			`SELECT notification_id AS id, user_id AS userId, body, read_at AS readAt
			 FROM human_notifications
			 WHERE notification_type = 'world_settings_changed'
			 ORDER BY created_at ASC`,
		).all<{ id: string; userId: string; body: string; readAt: string | null }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results?.[0]).toMatchObject({ userId: guestId, readAt: null });
		expect(rows.results?.[0]?.body).toContain("prompt");
		expect(rows.results?.some((row) => row.userId === ownerId)).toBe(false);
		const unreadId = rows.results?.[0]?.id ?? "";

		const secondPatch = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest("http://example.com/api/worlds/settings-lab", "PATCH", { description: "Updated visible description." }, ownerCookie),
				{ worldHandle: "settings-lab" },
			),
		);
		expect(secondPatch.status, await secondPatch.clone().text()).toBe(200);
		rows = await testEnv.BICKR_D1.prepare(
			`SELECT notification_id AS id, user_id AS userId, body, read_at AS readAt
			 FROM human_notifications
			 WHERE notification_type = 'world_settings_changed'
			 ORDER BY created_at ASC`,
		).all<{ id: string; userId: string; body: string; readAt: string | null }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results?.[0]?.id).toBe(unreadId);
		expect(rows.results?.[0]?.body).toContain("short description");

		await testEnv.BICKR_D1.prepare(`UPDATE human_notifications SET read_at = ? WHERE notification_id = ?`)
			.bind("2026-05-01T00:00:00.000Z", unreadId)
			.run();
		const thirdPatch = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest("http://example.com/api/worlds/settings-lab", "PATCH", { name: "Settings Lab Revised" }, ownerCookie),
				{ worldHandle: "settings-lab" },
			),
		);
		expect(thirdPatch.status, await thirdPatch.clone().text()).toBe(200);
		rows = await testEnv.BICKR_D1.prepare(
			`SELECT notification_id AS id, user_id AS userId, body, read_at AS readAt
			 FROM human_notifications
			 WHERE notification_type = 'world_settings_changed'
			 ORDER BY created_at ASC`,
		).all<{ id: string; userId: string; body: string; readAt: string | null }>();
		expect(rows.results).toHaveLength(2);
		expect(rows.results?.[1]).toMatchObject({ userId: guestId, readAt: null });
		expect(rows.results?.[1]?.body).toContain("name");
	});

	it("keeps the local test login route disabled unless explicitly configured", async () => {
		const disabled = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest("http://localhost/api/__test__/login", "POST", {
					login: "manual-test-user",
				}),
			),
		);
		expect(disabled.status).toBe(404);

		const remoteHost = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest("http://example.com/api/__test__/login", "POST", {
					login: "manual-test-user",
				}),
				{},
				{ TEST_AUTH_SECRET: "secret" },
			),
		);
		expect(remoteHost.status).toBe(404);
	});

	it("allows test login on configured test hosts with the correct secret", async () => {
		const response = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/login",
					"POST",
					{
						subject: "configured-test-login",
						login: "configured-test-login",
						handle: "configured-test-login",
						displayName: "Configured Test Login",
					},
					undefined,
					{ "x-test-auth-secret": "test-secret" },
				),
				{},
				{
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "test-secret",
				},
			),
		);

		expect(response.status).toBe(201);
		expect(response.headers.getSetCookie().join(";")).toContain(`${sessionCookieName}=`);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { profile: { handle: "configured-test-login" } },
		});
	});

	it("rejects local test login requests with the wrong secret", async () => {
		const response = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest(
					"http://127.0.0.1/api/__test__/login",
					"POST",
					{ login: "manual-test-user" },
					undefined,
					{ "x-test-auth-secret": "wrong" },
				),
				{},
				{ TEST_AUTH_SECRET: "correct" },
			),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
	});

	it("protects the test service proxy and allowlists services, paths, and headers", async () => {
		const disabled = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{ service: "agent-runtime", method: "GET", path: "/health" },
					undefined,
					{ "x-test-auth-secret": "secret" },
				),
			),
		);
		expect(disabled.status).toBe(404);

		const wrongSecret = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{ service: "agent-runtime", method: "GET", path: "/health" },
					undefined,
					{ "x-test-auth-secret": "wrong" },
				),
				{},
				{
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "secret",
				},
			),
		);
		expect(wrongSecret.status).toBe(401);

		const unsafePath = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{ service: "agent-runtime", method: "GET", path: "//example.com/health" },
					undefined,
					{ "x-test-auth-secret": "secret" },
				),
				{},
				{
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "secret",
				},
			),
		);
		expect(unsafePath.status).toBe(400);

		const unsafeHeader = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{
						service: "agent-runtime",
						method: "GET",
						path: "/health",
						headers: { cookie: "bickr_session=stolen" },
					},
					undefined,
					{ "x-test-auth-secret": "secret" },
				),
				{},
				{
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "secret",
				},
			),
		);
		expect(unsafeHeader.status).toBe(400);

		const proxiedRequests: Request[] = [];
		const agentRuntime = {
			fetch: async (request: Request) => {
				proxiedRequests.push(request);
				return new Response("healthy", {
					headers: {
						"content-type": "text/plain",
						"set-cookie": "unsafe=1",
						"x-debug": "hidden",
					},
					status: 202,
				});
			},
		} as unknown as Fetcher;
		const success = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{
						service: "agent-runtime",
						method: "GET",
						path: "/health",
						headers: {
							accept: "application/json",
							"x-bickr-scheduler": "1",
							"x-bickr-user-id": "usr_debug",
						},
					},
					undefined,
					{ "x-test-auth-secret": "secret" },
				),
				{},
				{
					AGENT_RUNTIME: agentRuntime,
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "secret",
				},
			),
		);

		expect(success.status).toBe(202);
		expect(await success.text()).toBe("healthy");
		expect(success.headers.get("content-type")).toBe("text/plain");
		expect(success.headers.get("cache-control")).toBe("no-store");
		expect(success.headers.get("set-cookie")).toBeNull();
		expect(success.headers.get("x-debug")).toBeNull();
		expect(proxiedRequests).toHaveLength(1);
		expect(proxiedRequests[0]!.url).toBe("https://internal.bickr/health");
		expect(proxiedRequests[0]!.headers.get("accept")).toBe("application/json");
		expect(proxiedRequests[0]!.headers.get("x-bickr-scheduler")).toBe("1");
		expect(proxiedRequests[0]!.headers.get("x-bickr-user-id")).toBe("usr_debug");
		expect(proxiedRequests[0]!.headers.get("cookie")).toBeNull();
		expect(proxiedRequests[0]!.headers.get("authorization")).toBeNull();
	});

	it("supports local test login, session lookup, protected mutations, incomplete setup, and logout", async () => {
		const completeLogin = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest(
					"http://127.0.0.1/api/__test__/login",
					"POST",
					{
						subject: "manual-test-complete",
						login: "manual-test-complete",
						handle: "manual-test-complete",
						displayName: "Manual Test Complete",
					},
					undefined,
					{ "x-test-auth-secret": "local-secret" },
				),
				{},
				{ TEST_AUTH_SECRET: "local-secret" },
			),
		);
		expect(completeLogin.status).toBe(201);
		const completeCookie = completeLogin.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(completeCookie).toBeDefined();
		expect(await completeLogin.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					handle: "manual-test-complete",
					displayName: lt("Manual Test Complete"),
					profileComplete: true,
				},
			},
		});

		const sessionResponse = await session(
			contextFor<typeof session>(
				new Request("http://example.com/api/session", {
					headers: { cookie: completeCookie! },
				}),
			),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: {
				authenticated: true,
				user: {
					handle: "manual-test-complete",
					profileComplete: true,
				},
			},
		});

		const createdWorld = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "manual-test-auth", name: "Manual Test Auth", description: "Local auth test" },
					completeCookie!,
				),
			),
		);
		expect(createdWorld.status).toBe(201);

		const logoutResponse = await logout(
			contextFor<typeof logout>(
				new Request("http://example.com/api/auth/logout", {
					method: "POST",
					headers: { cookie: completeCookie! },
				}),
			),
		);
		expect(logoutResponse.status).toBe(200);
		expect(logoutResponse.headers.getSetCookie().join(";")).toContain("Max-Age=0");

		const incompleteLogin = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest(
					"http://127.0.0.1/api/__test__/login",
					"POST",
					{
						subject: "manual-test-incomplete",
						login: "manual-test-incomplete",
						displayName: "Manual Test Incomplete",
						profileComplete: false,
					},
					undefined,
					{ "x-test-auth-secret": "local-secret" },
				),
				{},
				{ TEST_AUTH_SECRET: "local-secret" },
			),
		);
		const incompleteCookie = incompleteLogin.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(incompleteCookie).toBeDefined();
		expect(await incompleteLogin.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					handle: "manual-test-incomplete",
					profileComplete: false,
				},
			},
		});

		const blockedWorld = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "manual-test-blocked", name: "Manual Test Blocked", description: "Incomplete setup" },
					incompleteCookie!,
				),
			),
		);
		expect(blockedWorld.status).toBe(403);
		expect(await blockedWorld.json()).toMatchObject({
			ok: false,
			error: "forbidden",
			message: expect.stringContaining("Complete your profile"),
		});
	});

	it("supports GitHub OAuth callback user upsert, session lookup, and logout", async () => {
		const githubCookies = oauthCookieNames("github");
		const startResponse = await githubStart(
			contextFor<typeof githubStart>(
				new Request(
					"http://example.com/api/auth/github/start?returnTo=%2Fw%2Fprimary%2Ff%2Fphilosophy%2Ft%2Fthr_1",
				),
				{},
				{ GITHUB_CLIENT_ID: "client-id" },
			),
		);
		expect(startResponse.status).toBe(302);
		expect(startResponse.headers.get("location")).toContain("github.com/login/oauth/authorize");
		expect(startResponse.headers.getSetCookie().join(";")).toContain(
			`${githubCookies.returnTo}=%2Fw%2Fprimary%2Ff%2Fphilosophy%2Ft%2Fthr_1`,
		);

		const callbackResponse = await githubCallback(
			contextFor<typeof githubCallback>(
				new Request("http://example.com/api/auth/github/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							`${githubCookies.state}=state-1; ${githubCookies.returnTo}=%2Fw%2Fprimary%2Ff%2Fphilosophy%2Ft%2Fthr_1; ${githubCookies.pkce}=verifier-1`,
					},
				}),
				{},
				{
					GITHUB_CLIENT_ID: "client-id",
					GITHUB_CLIENT_SECRET: "client-secret",
					OAUTH_FETCH: oauthFetchMock,
				},
			),
		);
		expect(callbackResponse.status).toBe(302);
		expect(callbackResponse.headers.get("location")).toBe("/w/primary/f/philosophy/t/thr_1");
		const sessionCookie = callbackResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(sessionCookie).toBeDefined();

		const sessionResponse = await session(
			contextFor<typeof session>(
				new Request("http://example.com/api/session", {
					headers: { cookie: sessionCookie! },
				}),
			),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: {
				authenticated: true,
				user: {
					handle: "octocat",
					displayName: unspecifiedLt("Octo Cat"),
					profileComplete: false,
				},
			},
		});

		const blockedWorld = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "blocked", name: "Blocked", description: "Requires setup" },
					sessionCookie!,
				),
			),
		);
		expect(blockedWorld.status).toBe(403);
		expect(await blockedWorld.json()).toMatchObject({
			ok: false,
			error: "forbidden",
			message: expect.stringContaining("Complete your profile"),
		});

		const logoutResponse = await logout(
			contextFor<typeof logout>(
				new Request("http://example.com/api/auth/logout", {
					method: "POST",
					headers: { cookie: sessionCookie! },
				}),
			),
		);
		expect(logoutResponse.status).toBe(200);
		expect(logoutResponse.headers.getSetCookie().join(";")).toContain("Max-Age=0");
	});

	it("preserves long MCP OAuth authorization return paths across Bickr sign-in", async () => {
		const githubCookies = oauthCookieNames("github");
		const longReturnTo = `/oauth/authorize?response_type=code&client_id=${"c".repeat(64)}&redirect_uri=${encodeURIComponent("https://api.claude.ai/api/mcp/auth_callback")}&scope=bickr.read%20bickr.write%20bickr.runtime&state=${"s".repeat(2_300)}&code_challenge=${"x".repeat(43)}&code_challenge_method=S256&resource=${encodeURIComponent("https://test.bickr.social/mcp")}`;
		expect(longReturnTo.length).toBeGreaterThan(2_048);
		const startUrl = new URL("http://example.com/api/auth/github/start");
		startUrl.searchParams.set("returnTo", longReturnTo);
		const startResponse = await githubStart(
			contextFor<typeof githubStart>(
				new Request(startUrl),
				{},
				{ GITHUB_CLIENT_ID: "client-id" },
			),
		);
		expect(startResponse.status).toBe(302);
		const setCookies = startResponse.headers.getSetCookie();
		expect(setCookies.join(";")).toContain(`${githubCookies.returnTo}=%2F`);
		const state = setCookieValue(setCookies, githubCookies.state);
		expect(state).toBeTruthy();
		const callbackResponse = await githubCallback(
			contextFor<typeof githubCallback>(
				new Request(`http://example.com/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
					headers: { cookie: cookieHeaderFromSetCookies(setCookies) },
				}),
				{},
				{
					GITHUB_CLIENT_ID: "client-id",
					GITHUB_CLIENT_SECRET: "client-secret",
					OAUTH_FETCH: oauthFetchMock,
				},
			),
		);
		expect(callbackResponse.status).toBe(302);
		expect(callbackResponse.headers.get("location")).toBe(longReturnTo);
	});

	it("supports Google OAuth sign-in with authentication-only scopes", async () => {
		const googleCookies = oauthCookieNames("google");
		const startResponse = await googleStart(
			contextFor<typeof googleStart>(
				new Request("http://example.com/api/auth/google/start?returnTo=%2Fme%2Fprofile"),
				{},
				{ GOOGLE_CLIENT_ID: "google-client", OAUTH_FETCH: googleOauthFetchMock() },
			),
		);
		expect(startResponse.status).toBe(302);
		const startLocation = new URL(startResponse.headers.get("location")!);
		expect(startLocation.origin).toBe("https://accounts.google.com");
		expect(startLocation.searchParams.get("scope")).toBe("openid email profile");
		expect(startLocation.searchParams.get("access_type")).toBeNull();
		expect(startLocation.searchParams.get("prompt")).toBeNull();
		expect(startLocation.searchParams.get("code_challenge_method")).toBe("S256");
		const googleStartCookies = startResponse.headers.getSetCookie().join(";");
		expect(googleStartCookies).toContain(`${googleCookies.returnTo}=%2Fme%2Fprofile`);
		expect(googleStartCookies).toContain(`${googleCookies.pkce}=`);
		expect(googleStartCookies).toContain(`${googleCookies.nonce}=`);

		const callbackResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							`${googleCookies.state}=state-1; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-1; ${googleCookies.nonce}=nonce-1`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock(),
				},
			),
		);
		expect(callbackResponse.status).toBe(302);
		expect(callbackResponse.headers.get("location")).toBe("/me/profile");
		const sessionCookie = callbackResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(sessionCookie).toBeDefined();

		const profileResponse = await getProfile(
			contextFor<typeof getProfile>(
				new Request("http://example.com/api/me/profile", {
					headers: { cookie: sessionCookie! },
				}),
			),
		);
		expect(await profileResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					displayName: unspecifiedLt("Google Octo"),
					authIdentities: [
						{
							provider: "google",
							providerLogin: "google-octo@example.com",
							email: "google-octo@example.com",
							avatarUrl: "https://example.com/google-octo.png",
						},
					],
				},
			},
		});
	});

	it("links and unlinks providers without removing the last sign-in method", async () => {
		const githubCookie = await authCookieFor({
			subject: "github-link-1",
			login: "github-link",
			displayName: "GitHub Link",
		});
		const googleCookies = oauthCookieNames("google");
		const linkGoogleResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							`${githubCookie}; ${googleCookies.state}=state-1; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-1; ${googleCookies.nonce}=nonce-1`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock({ subject: "google-link-1", email: "google-link@example.com" }),
				},
			),
		);
		expect(linkGoogleResponse.status).toBe(302);
		expect(linkGoogleResponse.headers.get("location")).toBe("/me/profile");

		let profileResponse = await getProfile(
			contextFor<typeof getProfile>(
				new Request("http://example.com/api/me/profile", { headers: { cookie: githubCookie } }),
			),
		);
		expect(await profileResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					authIdentities: expect.arrayContaining([
						expect.objectContaining({ provider: "github", providerLogin: "github-link" }),
						expect.objectContaining({ provider: "google", providerLogin: "google-link@example.com" }),
					]),
				},
			},
		});

		const unlinkGoogleResponse = await unlinkAuthIdentity(
			contextFor<typeof unlinkAuthIdentity>(
				new Request("http://example.com/api/me/auth/identities/google", {
					method: "DELETE",
					headers: { cookie: githubCookie },
				}),
				{ provider: "google" },
			),
		);
		expect(unlinkGoogleResponse.status).toBe(200);
		expect(await unlinkGoogleResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					authIdentities: [expect.objectContaining({ provider: "github" })],
				},
			},
		});

		const unlinkMissingResponse = await unlinkAuthIdentity(
			contextFor<typeof unlinkAuthIdentity>(
				new Request("http://example.com/api/me/auth/identities/google", {
					method: "DELETE",
					headers: { cookie: githubCookie },
				}),
				{ provider: "google" },
			),
		);
		expect(unlinkMissingResponse.status).toBe(404);

		const unlinkLastResponse = await unlinkAuthIdentity(
			contextFor<typeof unlinkAuthIdentity>(
				new Request("http://example.com/api/me/auth/identities/github", {
					method: "DELETE",
					headers: { cookie: githubCookie },
				}),
				{ provider: "github" },
			),
		);
		expect(unlinkLastResponse.status).toBe(409);

		const googleFirstResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-2", {
					headers: {
						cookie:
							`${googleCookies.state}=state-2; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-2; ${googleCookies.nonce}=nonce-2`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock({
						subject: "google-first",
						email: "google-first@example.com",
						nonce: "nonce-2",
					}),
				},
			),
		);
		const googleFirstCookie = googleFirstResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(googleFirstCookie).toBeDefined();
		const githubCookies = oauthCookieNames("github");
		const linkGithubResponse = await githubCallback(
			contextFor<typeof githubCallback>(
				new Request("http://example.com/api/auth/github/callback?code=abc&state=state-3", {
					headers: {
						cookie:
							`${googleFirstCookie}; ${githubCookies.state}=state-3; ${githubCookies.returnTo}=%2Fme%2Fprofile; ${githubCookies.pkce}=verifier-3`,
					},
				}),
				{},
				{
					GITHUB_CLIENT_ID: "client-id",
					GITHUB_CLIENT_SECRET: "client-secret",
					OAUTH_FETCH: oauthFetchMock,
				},
			),
		);
		expect(linkGithubResponse.status).toBe(302);
		profileResponse = await getProfile(
			contextFor<typeof getProfile>(
				new Request("http://example.com/api/me/profile", { headers: { cookie: googleFirstCookie! } }),
			),
		);
		expect(await profileResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					authIdentities: expect.arrayContaining([
						expect.objectContaining({ provider: "google", providerLogin: "google-first@example.com" }),
						expect.objectContaining({ provider: "github", providerLogin: "octocat" }),
					]),
				},
			},
		});
	});

	it("does not auto-link providers by email and rejects links owned by another account", async () => {
		const githubUser = await upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			provider: "github",
			subject: "github-shared-email",
			login: "shared-github",
			displayName: "Shared GitHub",
			email: "shared@example.com",
		});
		await updateUserProfile(testEnv.BICKR_KV, testEnv.BICKR_D1, githubUser.id, {
			handle: githubUser.handle,
			displayName: githubUser.displayName,
		});
		const githubSession = await createSession(testEnv.BICKR_KV, githubUser.id);
		const githubCookie = `${sessionCookieName}=${encodeURIComponent(githubSession.cookieValue)}`;
		const googleCookies = oauthCookieNames("google");
		const googleSignInResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							`${googleCookies.state}=state-1; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-1; ${googleCookies.nonce}=nonce-1`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock({ subject: "google-shared-email", email: "shared@example.com" }),
				},
			),
		);
		const googleCookie = googleSignInResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(googleCookie).toBeDefined();
		const googleSessionResponse = await session(
			contextFor<typeof session>(
				new Request("http://example.com/api/session", { headers: { cookie: googleCookie! } }),
			),
		);
		const googleSessionPayload = await googleSessionResponse.json() as {
			data: { authenticated: boolean; user: { id: string } | null };
		};
		expect(googleSessionPayload).toMatchObject({
			ok: true,
			data: {
				authenticated: true,
			},
		});
		expect(googleSessionPayload.data.user?.id).not.toBe(githubUser.id);

		const conflictResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-2", {
					headers: {
						cookie:
							`${githubCookie}; ${googleCookies.state}=state-2; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-2; ${googleCookies.nonce}=nonce-2`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock({
						subject: "google-shared-email",
						email: "shared@example.com",
						nonce: "nonce-2",
					}),
				},
			),
		);
		expect(conflictResponse.status).toBe(302);
		expect(conflictResponse.headers.get("location")).toBe("/me/profile?authError=identity_conflict");
	});

	it("creates and lists worlds and forums with duplicate conflicts", async () => {
		const cookie = await authCookie();
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "patch-notes", name: "Patch Notes", description: "Change discussion" },
					cookie,
				),
			),
		);
		expect(worldResponse.status).toBe(201);
		expect(await worldResponse.json()).toMatchObject({
			ok: true,
			data: { world: { handle: "patch-notes" } },
		});

		const duplicateWorld = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "patch-notes", name: "Patch Notes", description: "Change discussion" },
					cookie,
				),
			),
		);
		expect(duplicateWorld.status).toBe(409);

		const worldsResponse = await worlds(
			contextFor<typeof worlds>(new Request("http://example.com/api/worlds")),
		);
		expect(await worldsResponse.json()).toMatchObject({
			ok: true,
			data: { worlds: [{ handle: "patch-notes", forumCount: 1, botCount: 0 }] },
		});
		const initialForums = await listForums(testEnv.BICKR_D1, "patch-notes");
		expect(initialForums.find((forum) => forum.handle === "intro")).toMatchObject({
			description: lt("Introductions, first threads, and orientation for new participants in this world."),
		});

		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums",
					"POST",
					{ handle: "announcements", description: "Official updates" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(forumResponse.status).toBe(201);

		const duplicateForum = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums",
					"POST",
					{ handle: "announcements", description: "Official updates" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(duplicateForum.status).toBe(409);

		const worldsAfterForumResponse = await worlds(
			contextFor<typeof worlds>(new Request("http://example.com/api/worlds")),
		);
		expect(await worldsAfterForumResponse.json()).toMatchObject({
			ok: true,
			data: { worlds: [{ handle: "patch-notes", forumCount: 2, botCount: 0 }] },
		});

		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "release-sage",
						displayName: "Release Sage",
						shortBio: "Summarizes release discussions.",
						prompt: "Track release notes and summarize changes.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(botResponse.status).toBe(201);

		const worldsAfterBotResponse = await worlds(
			contextFor<typeof worlds>(new Request("http://example.com/api/worlds")),
		);
		expect(await worldsAfterBotResponse.json()).toMatchObject({
			ok: true,
			data: { worlds: [{ handle: "patch-notes", forumCount: 2, botCount: 1 }] },
		});

		const forumsResponse = await forums(
			contextFor<typeof forums>(
				new Request("http://example.com/api/worlds/patch-notes/forums"),
				{ worldHandle: "patch-notes" },
			),
		);
		const forumsPayload = (await forumsResponse.json()) as { ok: true; data: { forums: Array<{ handle: string }> } };
		expect(forumsPayload.ok).toBe(true);
		expect(forumsPayload.data.forums.map((forum) => forum.handle)).toEqual(expect.arrayContaining(["announcements", "intro"]));
	});

	it("searches active worlds, forums, and bots by substring suggestions, escaped substrings, globs, and exact filters", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "literal-percent", name: "100% Pure", description: "Literal percent world." },
					cookie,
				),
			),
		);
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "literal-number", name: "1000 Pure", description: "Literal number world." },
					cookie,
				),
			),
		);
		const forum = await createForumForTest(cookie, "release-room");
		const bot = await createBotForTest(cookie, "release-sage");
		await createThreadForTest(forum.id, bot.id, "Release notes", "Release notes from u/release-sage.");

		const suggestions = await searchSuggestRoute(
			contextFor<typeof searchSuggestRoute>(
				new Request("http://example.com/api/search/suggest?q=release", { headers: { cookie } }),
			),
		);
		expect(suggestions.status, await suggestions.clone().text()).toBe(200);
		const suggestionsPayload = await suggestions.json() as { data: Pick<SearchResponse, "query" | "results"> };
		expect(suggestionsPayload.data.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual(
			expect.arrayContaining(["forum:release-room", "bot:release-sage"]),
		);
		expect(suggestionsPayload.data.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).not.toContain("forum:release-sage");

		const escaped = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "substring",
			query: "100%",
			types: ["world"],
		});
		expect(escaped.results.map((result) => result.type === "world" ? result.handle : "")).toEqual(["literal-percent"]);

		const glob = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "substring",
			query: "patch*notes",
			types: ["world"],
		});
		expect(glob.results.map((result) => result.type === "world" ? result.handle : "")).toEqual(["patch-notes"]);

		const literalWildcard = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "substring",
			query: "patch%notes",
			types: ["world"],
		});
		expect(literalWildcard.results).toEqual([]);

		const usernameFilteredWorld = await searchEntitiesText(testEnv.BICKR_D1, {
			...normalizeSearchFilters({ username: "u/release-sage" }),
			mode: "substring",
			query: "patch",
			types: ["world"],
		});
		expect(usernameFilteredWorld.results.map((result) => result.type === "world" ? result.handle : "")).toEqual(["patch-notes"]);

		const usernameFilteredForum = await searchEntitiesText(testEnv.BICKR_D1, {
			...normalizeSearchFilters({ username: "@release-sage" }),
			mode: "substring",
			query: "release",
			types: ["forum"],
		});
		expect(usernameFilteredForum.results.map((result) => result.type === "forum" ? result.handle : "")).toEqual(["release-room"]);
		expect(usernameFilteredForum.results[0]?.world.matched).toBe(false);

		const forumFilteredBot = await searchEntitiesText(testEnv.BICKR_D1, {
			...normalizeSearchFilters({ forum: "f/release-room" }),
			mode: "substring",
			query: "release",
			types: ["bot"],
		});
		expect(forumFilteredBot.results.map((result) => result.type === "bot" ? result.handle : "")).toEqual(["release-sage"]);

		const personalForumSearch = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "substring",
			query: "release-sage",
			types: ["forum"],
		});
		expect(personalForumSearch.results).toEqual([]);
	});

	it("supports FTS search, syntax errors, and 20-result pagination", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		for (let index = 0; index < 21; index += 1) {
			const padded = String(index).padStart(2, "0");
			const response = await createForum(
				contextFor<typeof createForum>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/forums",
						"POST",
						{ handle: `pager-${padded}`, description: `Pagination needle ${padded}` },
						cookie,
					),
					{ worldHandle: "patch-notes" },
				),
			);
			expect(response.status, await response.clone().text()).toBe(201);
		}

		const firstPage = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			page: 1,
			query: "pagination",
			types: ["forum"],
		});
		expect(firstPage.total).toBe(21);
		expect(firstPage.results).toHaveLength(20);
		expect(firstPage.hasNextPage).toBe(true);
		expect(firstPage.results.every((result) => result.type === "forum" && !result.world.matched)).toBe(true);

		const operatorQuery = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			page: 1,
			query: "Pagination OR needle",
			types: ["forum"],
		});
		expect(operatorQuery.total).toBe(21);

		const secondPage = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			page: 2,
			query: "pagination",
			types: ["forum"],
		});
		expect(secondPage.results).toHaveLength(1);
		expect(secondPage.hasNextPage).toBe(false);

		const invalid = await searchRoute(
			contextFor<typeof searchRoute>(
				new Request("http://example.com/api/search?q=%22&mode=fts&types=world", { headers: { cookie } }),
			),
		);
		expect(invalid.status).toBe(400);
	});

	it("keeps FTS rows current on world, forum, and bot rename and soft-delete paths", async () => {
		const cookie = await authCookie();
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "index-lab", name: "Old Search Needle", description: "Old world search row." },
					cookie,
				),
			),
		);
		const worldPayload = await worldResponse.json() as { data: { world: WorldSummary } };
		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/index-lab/forums",
					"POST",
					{ handle: "old-forum-needle", description: "Old forum search row." },
					cookie,
				),
				{ worldHandle: "index-lab" },
			),
		);
		const forumPayload = await forumResponse.json() as { data: { forum: TestForum } };
		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/index-lab/bots",
					"POST",
					{
						handle: "old-bot-needle",
						displayName: "Old Bot Needle",
						shortBio: "Old bot search row.",
						prompt: "Stay concise.",
					},
					cookie,
				),
				{ worldHandle: "index-lab" },
			),
		);
		const botPayload = await botResponse.json() as { data: { bot: BotBody } };
		const oldMatches = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "old",
			types: ["world", "forum", "bot"],
		});
		expect(oldMatches.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual(
			expect.arrayContaining(["world:index-lab", "forum:old-forum-needle", "bot:old-bot-needle"]),
		);
		expect(oldMatches.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).not.toContain("forum:old-bot-needle");

		const worldPatch = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/index-lab",
					"PATCH",
					{ handle: "index-lab-new", name: "New Search Needle", description: "New world search row." },
					cookie,
				),
				{ worldHandle: "index-lab" },
			),
		);
		expect(worldPatch.status, await worldPatch.clone().text()).toBe(200);
		const forumPatch = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(
					"http://example.com/api/worlds/index-lab-new/forums/old-forum-needle",
					"PATCH",
					{ handle: "new-forum-needle", description: "New forum search row." },
					cookie,
				),
				{ worldHandle: "index-lab-new", forumHandle: "old-forum-needle" },
			),
		);
		expect(forumPatch.status, await forumPatch.clone().text()).toBe(200);
		const botPatch = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${botPayload.data.bot.id}`,
					"PATCH",
					{ handle: "new-bot-needle", displayName: "New Bot Needle", shortBio: "New bot search row." },
					cookie,
				),
				{ botId: botPayload.data.bot.id },
			),
		);
		expect(botPatch.status, await botPatch.clone().text()).toBe(200);

		const afterRenameOld = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "old",
			types: ["world", "forum", "bot"],
		});
		expect(afterRenameOld.results.filter((result) => result.id === worldPayload.data.world.id || result.id === forumPayload.data.forum.id || result.id === botPayload.data.bot.id)).toEqual([]);
		const afterRenameNew = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "new",
			types: ["world", "forum", "bot"],
		});
		expect(afterRenameNew.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual(
			expect.arrayContaining(["world:index-lab-new", "forum:new-forum-needle", "bot:new-bot-needle"]),
		);

		const botDelete = await deleteBot(
			contextFor<typeof deleteBot>(
				new Request(`http://example.com/api/me/bots/${botPayload.data.bot.id}`, { method: "DELETE", headers: { cookie } }),
				{ botId: botPayload.data.bot.id },
			),
		);
		expect(botDelete.status, await botDelete.clone().text()).toBe(200);
		const forumDelete = await deleteForumRoute(
			contextFor<typeof deleteForumRoute>(
				new Request("http://example.com/api/worlds/index-lab-new/forums/new-forum-needle", { method: "DELETE", headers: { cookie } }),
				{ worldHandle: "index-lab-new", forumHandle: "new-forum-needle" },
			),
		);
		expect(forumDelete.status, await forumDelete.clone().text()).toBe(200);
		const worldDelete = await deleteWorldRoute(
			contextFor<typeof deleteWorldRoute>(
				new Request("http://example.com/api/worlds/index-lab-new", { method: "DELETE", headers: { cookie } }),
				{ worldHandle: "index-lab-new" },
			),
		);
		expect(worldDelete.status, await worldDelete.clone().text()).toBe(200);
		const afterDelete = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "new",
			types: ["world", "forum", "bot"],
		});
		expect(afterDelete.results.filter((result) => result.id === worldPayload.data.world.id || result.id === forumPayload.data.forum.id || result.id === botPayload.data.bot.id)).toEqual([]);
	});

	it("indexes and searches semantic entities with exact-filter hydration, score ordering, and bot vector fallback", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "semantic-room");
		const bot = await createBotForTest(cookie, "semantic-sage");
		await createThreadForTest(forum.id, bot.id, "Semantic trail", "Semantic coverage post.");
		const worldResponse = await worlds(contextFor<typeof worlds>(new Request("http://example.com/api/worlds")));
		const worldPayload = await worldResponse.json() as { data: { worlds: WorldSummary[] } };
		const world = worldPayload.data.worlds.find((item) => item.handle === "patch-notes");
		const forumSummaries = await listForums(testEnv.BICKR_D1, "patch-notes");
		const forumSummary = forumSummaries.find((item) => item.id === forum.id);
		const personalForum = forumSummaries.find((item) => item.personalBotId === bot.id);
		const botDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		if (!world || !forumSummary || !personalForum) {
			throw new Error("Semantic fixture missing world or forum.");
		}

		const bindings = fakeSearchBindings();
		await upsertWorldSearchVector(bindings.env, world);
		await upsertForumSearchVector(bindings.env, forumSummary);
		await upsertBotSearchVector(bindings.env, botDocument);
		expect(bindings.upserted.map((item) => item.id)).toEqual([
			`world:${world.id}`,
			`forum:${forum.id}`,
			bot.id,
		]);
		expect(bindings.upserted.map((item) => item.metadata?.type)).toEqual(["world", "forum", "bot"]);
		await upsertForumSearchVector(bindings.env, personalForum);
		expect(bindings.upserted.map((item) => item.id)).toEqual([
			`world:${world.id}`,
			`forum:${forum.id}`,
			bot.id,
		]);
		expect(bindings.deleted).toContain(`forum:${personalForum.id}`);

		const reindex = await reindexSearchVectors(testEnv.BICKR_D1, bindings.env, 20);
		expect(reindex.attempted).toBeGreaterThanOrEqual(3);
		expect(bindings.deleted).toContain(`forum:${personalForum.id}`);

		bindings.matches = [
			{ id: `world:${world.id}`, metadata: { entityId: world.id, type: "world" }, score: 0.5 },
			{ id: bot.id, metadata: { entityId: bot.id, type: "bot" }, score: 0.8 },
			{ id: `forum:${forum.id}`, metadata: { entityId: forum.id, type: "forum" }, score: 0.9 },
		];
		const semantic = await searchEntitiesSemantic(testEnv.BICKR_D1, bindings.env, {
			mode: "semantic",
			query: "semantic coverage",
			types: ["world", "forum", "bot"],
			...normalizeSearchFilters({ username: "semantic-sage" }),
		});
		expect(semantic.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual([
			"forum:semantic-room",
			"bot:semantic-sage",
			"world:patch-notes",
		]);
		expect(semantic.results.map((result) => result.score)).toEqual([0.9, 0.8, 0.5]);

		bindings.matches = [
			{ id: `forum:${personalForum.id}`, metadata: { entityId: personalForum.id, type: "forum" }, score: 0.99 },
			{ id: `forum:${forum.id}`, metadata: { entityId: forum.id, type: "forum" }, score: 0.9 },
		];
		const semanticForums = await searchEntitiesSemantic(testEnv.BICKR_D1, bindings.env, {
			mode: "semantic",
			query: "semantic coverage",
			types: ["forum"],
		});
		expect(semanticForums.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual(["forum:semantic-room"]);

		const serviceResponse = await agentRuntimeWorker.fetch(
			new Request("https://internal.bickr/search/entities?mode=semantic&q=semantic%20coverage&types=forum", {
				headers: { "x-bickr-user-id": "semantic-test-user" },
			}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				AI: bindings.env.AI,
				BICKR_SEARCH_VECTORIZE: bindings.env.BICKR_SEARCH_VECTORIZE,
			} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);
		expect(serviceResponse.status, await serviceResponse.clone().text()).toBe(200);
		expect(await serviceResponse.json()).toMatchObject({
			ok: true,
			data: { search: { results: [{ type: "forum", handle: "semantic-room" }] } },
		});

		const filteredOut = await searchEntitiesSemantic(testEnv.BICKR_D1, bindings.env, {
			mode: "semantic",
			query: "semantic coverage",
			types: ["world", "forum", "bot"],
			...normalizeSearchFilters({ forum: "missing-forum" }),
		});
		expect(filteredOut.results).toEqual([]);

		const fallback = fakeSearchBindings("legacy");
		fallback.matches = [{ id: bot.id, metadata: { type: "bot" }, score: 0.77 }];
		await upsertBotSearchVector(fallback.env, botDocument);
		expect(fallback.upserted.map((item) => item.id)).toEqual([bot.id]);
		const fallbackResult = await searchEntitiesSemantic(testEnv.BICKR_D1, fallback.env, {
			mode: "semantic",
			query: "semantic sage",
			types: ["bot"],
		});
		expect(fallbackResult.results).toMatchObject([{ type: "bot", handle: "semantic-sage", score: 0.77 }]);
		await deleteSearchVector(fallback.env, "bot", bot.id);
		expect(fallback.deleted).toEqual([bot.id, `bot:${bot.id}`]);
	});

	it("renames world handles across route metadata", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "release-room");
		const bot = await createBotForTest(cookie, "release-sage");
		const thread = await createThreadForTest(forum.id, bot.id, "World rename route", "World route body.");
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "taken-world", name: "Taken World", description: "Already exists." },
					cookie,
				),
			),
		);

		const conflict = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes",
					"PATCH",
					{ handle: "taken-world" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(conflict.status).toBe(409);

		const response = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes",
					"PATCH",
					{ handle: "release-notes", name: "Release Notes" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { world: { handle: "release-notes", name: lt("Release Notes") } },
		});

		const worldsResponse = await worlds(contextFor<typeof worlds>(new Request("http://example.com/api/worlds")));
		expect(await worldsResponse.json()).toMatchObject({
			ok: true,
			data: { worlds: expect.arrayContaining([expect.objectContaining({ handle: "release-notes" })]) },
		});

		const forumsResponse = await forums(
			contextFor<typeof forums>(
				new Request("http://example.com/api/worlds/release-notes/forums"),
				{ worldHandle: "release-notes" },
			),
		);
		const forumsPayload = (await forumsResponse.json()) as { data: { forums: Array<{ handle: string; worldHandle: string }> } };
		expect(forumsPayload.data.forums.find((item) => item.handle === "release-room")).toMatchObject({
			worldHandle: "release-notes",
		});

		const botsResponse = await worldBots(
			contextFor<typeof worldBots>(
				new Request("http://example.com/api/worlds/release-notes/bots"),
				{ worldHandle: "release-notes" },
			),
		);
		const botsPayload = (await botsResponse.json()) as { data: { bots: Array<{ handle: string; homeWorldHandle: string }> } };
		expect(botsPayload.data.bots.find((item) => item.handle === "release-sage")).toMatchObject({
			homeWorldHandle: "release-notes",
		});

		const threadResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/release-notes/forums/release-room/threads/${thread.id}`),
				{ worldHandle: "release-notes", forumHandle: "release-room", threadId: thread.id },
			),
		);
		expect(threadResponse.status, await threadResponse.clone().text()).toBe(200);
		expect(await threadResponse.json()).toMatchObject({
			ok: true,
			data: { thread: { id: thread.id, worldHandle: "release-notes", forumHandle: "release-room" } },
		});
	});

	it("persists configurable posting settings in world and bot summaries", async () => {
		const cookie = await authCookie();
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{
						handle: "limits-world",
						name: "Limits World",
						description: "Posting limits.",
						postingSettings: {
							threadBodyCharacters: 6000,
							commentBodyCharacters: 3000,
						},
					},
					cookie,
				),
			),
		);
		expect(worldResponse.status, await worldResponse.clone().text()).toBe(201);
		expect(await worldResponse.json()).toMatchObject({
			ok: true,
			data: {
				world: {
					handle: "limits-world",
					postingSettings: {
						threadBodyCharacters: 6000,
						commentBodyCharacters: 3000,
					},
				},
			},
		});

		const worldsResponse = await worlds(contextFor<typeof worlds>(new Request("http://example.com/api/worlds")));
		expect(await worldsResponse.json()).toMatchObject({
			ok: true,
			data: {
				worlds: expect.arrayContaining([
					expect.objectContaining({
						handle: "limits-world",
						postingSettings: {
							threadBodyCharacters: 6000,
							commentBodyCharacters: 3000,
						},
					}),
				]),
			},
		});

		const tooLargeBotResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/limits-world/bots",
					"POST",
					{
						handle: "too-large-limits",
						displayName: "Too Large Limits",
						shortBio: "Limit test.",
						prompt: "Post within the configured limits.",
						postingSettings: { threadBodyCharacters: 7000 },
					},
					cookie,
				),
				{ worldHandle: "limits-world" },
			),
		);
		expect(tooLargeBotResponse.status).toBe(400);

		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/limits-world/bots",
					"POST",
					{
						handle: "limits-bot",
						displayName: "Limits Bot",
						shortBio: "Limit test.",
						prompt: "Post within the configured limits.",
						postingSettings: {
							threadBodyCharacters: 5000,
						},
					},
					cookie,
				),
				{ worldHandle: "limits-world" },
			),
		);
		expect(botResponse.status, await botResponse.clone().text()).toBe(201);
		const botPayload = (await botResponse.json()) as { data: { bot: BotBody } };
		expect(botPayload.data.bot.postingSettings).toEqual({ threadBodyCharacters: 5000 });
		expect(botPayload.data.bot.effectivePostingSettings).toEqual({
			threadBodyCharacters: 5000,
			commentBodyCharacters: 3000,
		});

		const patchedBotResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${botPayload.data.bot.id}`,
					"PATCH",
					{
						postingSettings: {
							threadBodyCharacters: null,
							commentBodyCharacters: 2000,
						},
					},
					cookie,
				),
				{ botId: botPayload.data.bot.id },
			),
		);
		expect(patchedBotResponse.status, await patchedBotResponse.clone().text()).toBe(200);
		expect(await patchedBotResponse.json()).toMatchObject({
			ok: true,
			data: {
				bot: {
					postingSettings: { commentBodyCharacters: 2000 },
					effectivePostingSettings: {
						threadBodyCharacters: 6000,
						commentBodyCharacters: 2000,
					},
				},
			},
		});

		const clearedWorldResponse = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/limits-world",
					"PATCH",
					{
						postingSettings: {
							threadBodyCharacters: null,
							commentBodyCharacters: null,
						},
					},
					cookie,
				),
				{ worldHandle: "limits-world" },
			),
		);
		expect(clearedWorldResponse.status, await clearedWorldResponse.clone().text()).toBe(200);
		const clearedWorldPayload = (await clearedWorldResponse.json()) as { data: { world: WorldSummary } };
		expect(clearedWorldPayload.data.world.postingSettings).toBeUndefined();
	});

	it("renames forum handles without rewriting old textual references", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "dev-log");
		const bot = await createBotForTest(cookie, "scribe");
		const thread = await createThreadForTest(
			forum.id,
			bot.id,
			"Forum rename route",
			"Older prose still says f/dev-log and should stay that way.",
		);
		await createForumForTest(cookie, "taken-forum");

		const conflict = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/dev-log",
					"PATCH",
					{ handle: "taken-forum" },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "dev-log" },
			),
		);
		expect(conflict.status).toBe(409);

		const response = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/dev-log",
					"PATCH",
					{ handle: "release-log" },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "dev-log" },
			),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { forum: { handle: "release-log" } },
		});

		const threadResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/release-log/threads/${thread.id}`),
				{ worldHandle: "patch-notes", forumHandle: "release-log", threadId: thread.id },
			),
		);
		expect(threadResponse.status, await threadResponse.clone().text()).toBe(200);
		const payload = (await threadResponse.json()) as { data: { thread: ThreadDocument } };
		expect(payload.data.thread.forumHandle).toBe("release-log");
		expect(localizedTextString(payload.data.thread.comments.find((comment) => comment.id === payload.data.thread.rootCommentId)?.body)).toContain("f/dev-log");
	});

	it("renames bot handles and matching personal forums without rewriting old authors", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "release-sage");
		const personalForum = (await listForums(testEnv.BICKR_D1, "patch-notes")).find((forum) => forum.personalBotId === bot.id);
		expect(personalForum).toMatchObject({ handle: "release-sage" });
		if (!personalForum) {
			throw new Error("Personal forum missing.");
		}
		const thread = await createThreadForTest(
			personalForum.id,
			bot.id,
			"Bot rename route",
			"Older prose still says u/release-sage and f/release-sage.",
		);

		const response = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}`,
					"PATCH",
					{ handle: "release-oracle" },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { bot: { handle: "release-oracle" } },
		});

		const forumsAfter = await listForums(testEnv.BICKR_D1, "patch-notes");
		expect(forumsAfter.find((forum) => forum.personalBotId === bot.id)).toMatchObject({
			handle: "release-oracle",
			description: lt("Blog of Release Sage (u/release-oracle)"),
		});

		const storedThread = await readThread(testEnv.BICKR_KV, thread.id);
		const root = storedThread.comments.find((comment) => comment.id === storedThread.rootCommentId);
		expect(storedThread.forumHandle).toBe("release-oracle");
	expect(root).toMatchObject({
		authorHandle: "release-sage",
		body: lt("Older prose still says u/release-sage and f/release-sage."),
	});

		const threadResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/release-oracle/threads/${thread.id}`),
				{ worldHandle: "patch-notes", forumHandle: "release-oracle", threadId: thread.id },
			),
		);
		expect(threadResponse.status, await threadResponse.clone().text()).toBe(200);
	});

	it("rejects bot rename conflicts for bot and personal forum handles", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "first-bot");
		await createBotForTest(cookie, "second-bot");

		const botConflict = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}`,
					"PATCH",
					{ handle: "second-bot" },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(botConflict.status).toBe(409);

		await createForumForTest(cookie, "forum-taken");
		const forumConflict = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}`,
					"PATCH",
					{ handle: "forum-taken" },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(forumConflict.status).toBe(409);
	});

	it("accepts Unicode letters, numbers, hyphens, and underscores in handles", async () => {
		const cookie = await authCookieFor({
			subject: "unicode-handles",
			login: "Müller_42",
			displayName: "Unicode User",
		});
		expect(isValidHandleText("x")).toBe(true);
		expect(isValidHandleText("_")).toBe(true);
		expect(isValidHandleText("-a")).toBe(true);
		expect(isValidHandleText("a-")).toBe(true);
		expect(sanitizeHandleInput("_a-")).toBe("_a-");

		const profileResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{ handle: "δοκιμή_42", displayName: "Unicode User" },
					cookie,
				),
			),
		);
		expect(profileResponse.status).toBe(200);
		expect(await profileResponse.json()).toMatchObject({
			ok: true,
			data: { profile: { handle: "δοκιμή_42" } },
		});

		const worldHandle = "мир_2026";
		const encodedWorldHandle = encodeURIComponent(worldHandle);
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: worldHandle, name: "Unicode World", description: "Non-Latin handle coverage." },
					cookie,
				),
			),
		);
		expect(worldResponse.status).toBe(201);
		expect(await worldResponse.json()).toMatchObject({
			ok: true,
			data: { world: { handle: worldHandle } },
		});

		const forumHandle = "форум_2-β";
		const encodedForumHandle = encodeURIComponent(forumHandle);
		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					`http://example.com/api/worlds/${encodedWorldHandle}/forums`,
					"POST",
					{ handle: forumHandle, description: "Unicode forum handle." },
					cookie,
				),
				{ worldHandle: encodedWorldHandle },
			),
		);
		expect(forumResponse.status).toBe(201);
		expect(await forumResponse.json()).toMatchObject({
			ok: true,
			data: { forum: { handle: forumHandle, worldHandle } },
		});

		const forumThreadsResponse = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request(`http://example.com/api/worlds/${encodedWorldHandle}/forums/${encodedForumHandle}/threads`),
				{ worldHandle: encodedWorldHandle, forumHandle: encodedForumHandle },
			),
		);
		expect(forumThreadsResponse.status).toBe(200);
		expect(await forumThreadsResponse.json()).toMatchObject({
			ok: true,
			data: { forum: { handle: forumHandle, worldHandle } },
		});

		const botHandle = "бот_7-δ";
		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					`http://example.com/api/worlds/${encodedWorldHandle}/bots`,
					"POST",
					{
						handle: botHandle,
						displayName: "Unicode Bot",
						shortBio: "Exercises non-Latin bot handles.",
						prompt: "Stay concise.",
					},
					cookie,
				),
				{ worldHandle: encodedWorldHandle },
			),
		);
		expect(botResponse.status).toBe(201);
		expect(await botResponse.json()).toMatchObject({
			ok: true,
			data: { bot: { handle: botHandle, homeWorldHandle: worldHandle } },
		});

		const shortProfileResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest("http://example.com/api/me/profile", "PATCH", { handle: "x", displayName: "Unicode User" }, cookie),
			),
		);
		expect(shortProfileResponse.status).toBe(200);

		const shortWorldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", { handle: "_", name: "Underscore", description: "Short handle world." }, cookie),
			),
		);
		expect(shortWorldResponse.status).toBe(201);
		const shortForumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest("http://example.com/api/worlds/_/forums", "POST", { handle: "-", description: "One character forum." }, cookie),
				{ worldHandle: "_" },
			),
		);
		expect(shortForumResponse.status).toBe(201);
		const shortBotResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest("http://example.com/api/worlds/_/bots", "POST", {
					handle: "_-",
					displayName: "Short Bot",
					shortBio: "Short handle bot.",
					prompt: "Stay concise.",
				}, cookie),
				{ worldHandle: "_" },
			),
		);
		expect(shortBotResponse.status).toBe(201);
	});

	it("returns public human profile ownership grouped by world", async () => {
		const cookie = await authCookieFor({
			subject: "human-profile-owner",
			login: "profile-owner",
			displayName: "Profile Owner",
		});
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", {
					handle: "owned-world",
					name: "Owned World",
					description: "A world owned by the profile.",
				}, cookie),
			),
		);
		await createForum(
			contextFor<typeof createForum>(
				jsonRequest("http://example.com/api/worlds/owned-world/forums", "POST", {
					handle: "manual-forum",
					description: "A manually owned forum.",
				}, cookie),
				{ worldHandle: "owned-world" },
			),
		);
		await createBot(
			contextFor<typeof createBot>(
				jsonRequest("http://example.com/api/worlds/owned-world/bots", "POST", {
					handle: "profile-bot",
					displayName: "Profile Bot",
					shortBio: "Owned by the human profile.",
					prompt: "Stay concise.",
				}, cookie),
				{ worldHandle: "owned-world" },
			),
		);

		const response = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/profile-owner", { headers: { cookie } }),
				{ humanHandle: "profile-owner" },
			),
		);
		expect(response.status).toBe(200);
		const payload = await response.json() as {
			data: {
				profile: {
					user: Record<string, unknown>;
					worlds: Array<{ handle: string }>;
					forumsByWorld: Array<{ world: { handle: string }; forums: Array<{ handle: string }> }>;
					botsByWorld: Array<{ world: { handle: string }; bots: Array<BotBody> }>;
					totals: { worlds: number; forums: number; bots: number };
					isSelf: boolean;
					deleteEligibility?: { canDelete: boolean };
				};
			};
		};
		expect(payload.data.profile.user).toMatchObject({
			handle: "profile-owner",
			displayName: unspecifiedLt("Profile Owner"),
		});
		expect(payload.data.profile.user).not.toHaveProperty("authIdentities");
		expect(payload.data.profile.user).not.toHaveProperty("inferenceSettings");
		expect(payload.data.profile.worlds.map((world) => world.handle)).toEqual(["owned-world"]);
		expect(payload.data.profile.forumsByWorld[0]).toMatchObject({
			world: { handle: "owned-world" },
			forums: expect.arrayContaining([
				expect.objectContaining({ handle: "intro" }),
				expect.objectContaining({ handle: "manual-forum" }),
			]),
		});
		expect(payload.data.profile.forumsByWorld[0]?.forums.map((forum) => forum.handle)).not.toContain("profile-bot");
		expect(payload.data.profile.botsByWorld).toEqual([
			expect.objectContaining({
				world: expect.objectContaining({ handle: "owned-world" }),
				bots: [expect.objectContaining({ handle: "profile-bot", owner: expect.objectContaining({ handle: "profile-owner" }) })],
			}),
		]);
		expect(payload.data.profile.totals).toEqual({ worlds: 1, forums: 2, bots: 1 });
		expect(payload.data.profile.isSelf).toBe(true);
		expect(payload.data.profile.deleteEligibility).toMatchObject({ canDelete: true });

		const missingResponse = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/missing-profile", { headers: { cookie } }),
				{ humanHandle: "missing-profile" },
			),
		);
		expect(missingResponse.status).toBe(404);
	});

	it("cascades self profile deletion and frees the sign-in identity", async () => {
		const cookie = await authCookieFor({
			subject: "delete-profile-subject",
			login: "delete-profile",
			displayName: "Delete Profile",
		});
		const viewerCookie = await authCookieFor({
			subject: "delete-profile-viewer",
			login: "delete-profile-viewer",
			displayName: "Delete Profile Viewer",
		});
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", {
					handle: "delete-world",
					name: "Delete World",
					description: "Owned by the deleted profile.",
				}, cookie),
			),
		);
		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest("http://example.com/api/worlds/delete-world/bots", "POST", {
					handle: "delete-bot",
					displayName: "Delete Bot",
					shortBio: "Deleted with the profile.",
					prompt: "Stay concise.",
				}, cookie),
				{ worldHandle: "delete-world" },
			),
		);
		const botPayload = await botResponse.json() as { data: { bot: BotBody } };

		const missingConfirm = await deleteProfileRoute(
			contextFor<typeof deleteProfileRoute>(
				jsonRequest("http://example.com/api/me/profile", "DELETE", {}, cookie),
			),
		);
		expect(missingConfirm.status).toBe(400);

		const deleteResponse = await deleteProfileRoute(
			contextFor<typeof deleteProfileRoute>(
				jsonRequest("http://example.com/api/me/profile", "DELETE", { confirmCascade: true }, cookie),
			),
		);
		expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(200);
		expect(deleteResponse.headers.getSetCookie().join(";")).toContain("Max-Age=0");

		const sessionResponse = await session(
			contextFor<typeof session>(new Request("http://example.com/api/session", { headers: { cookie } })),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: { authenticated: false, user: null },
		});
		const rows = await testEnv.BICKR_D1.prepare(
			`SELECT
				(SELECT deleted_at FROM users_index WHERE handle LIKE 'deleted-%') AS userDeletedAt,
				(SELECT deleted_at FROM worlds_index WHERE handle = 'delete-world') AS worldDeletedAt,
				(SELECT deleted_at FROM bots_index WHERE bot_id = ?) AS botDeletedAt,
				(SELECT COUNT(*) FROM provider_identities WHERE provider_subject = 'delete-profile-subject') AS identityCount`,
		)
			.bind(botPayload.data.bot.id)
			.first<{ userDeletedAt: string | null; worldDeletedAt: string | null; botDeletedAt: string | null; identityCount: number }>();
		expect(rows?.userDeletedAt).toEqual(expect.any(String));
		expect(rows?.worldDeletedAt).toEqual(expect.any(String));
		expect(rows?.botDeletedAt).toEqual(expect.any(String));
		expect(rows?.identityCount).toBe(0);

		const deletedProfileResponse = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/delete-profile", { headers: { cookie: viewerCookie } }),
				{ humanHandle: "delete-profile" },
			),
		);
		expect(deletedProfileResponse.status).toBe(404);

		const replacementCookie = await authCookieFor({
			subject: "delete-profile-subject",
			login: "delete-profile",
			displayName: "Delete Profile Again",
		});
		const replacementSession = await session(
			contextFor<typeof session>(new Request("http://example.com/api/session", { headers: { cookie: replacementCookie } })),
		);
		expect(await replacementSession.json()).toMatchObject({
			ok: true,
			data: {
				authenticated: true,
				user: { handle: "delete-profile", displayName: unspecifiedLt("Delete Profile Again") },
			},
		});
	});

	it("blocks profile deletion when owned worlds contain bots owned by other profiles", async () => {
		const ownerCookie = await authCookieFor({
			subject: "delete-block-owner",
			login: "delete-block-owner",
			displayName: "Delete Block Owner",
		});
		const guestCookie = await authCookieFor({
			subject: "delete-block-guest",
			login: "delete-block-guest",
			displayName: "Delete Block Guest",
		});
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", {
					handle: "blocked-world",
					name: "Blocked World",
					description: "Contains another profile's bot.",
				}, ownerCookie),
			),
		);
		await createBot(
			contextFor<typeof createBot>(
				jsonRequest("http://example.com/api/worlds/blocked-world/bots", "POST", {
					handle: "guest-bot",
					displayName: "Guest Bot",
					shortBio: "Blocks profile deletion.",
					prompt: "Stay concise.",
				}, guestCookie),
				{ worldHandle: "blocked-world" },
			),
		);

		const deleteResponse = await deleteProfileRoute(
			contextFor<typeof deleteProfileRoute>(
				jsonRequest("http://example.com/api/me/profile", "DELETE", { confirmCascade: true }, ownerCookie),
			),
		);
		expect(deleteResponse.status).toBe(409);
		const payload = await deleteResponse.json() as {
			details?: { profileDeleteBlockers?: Array<{ world: { handle: string }; bots: Array<{ handle: string }> }> };
		};
		expect(payload.details?.profileDeleteBlockers).toEqual([
			expect.objectContaining({
				world: expect.objectContaining({ handle: "blocked-world" }),
				bots: [expect.objectContaining({ handle: "guest-bot" })],
			}),
		]);
		const world = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM worlds_index WHERE handle = 'blocked-world'`,
		).first<{ deletedAt: string | null }>();
		const owner = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM users_index WHERE handle = 'delete-block-owner'`,
		).first<{ deletedAt: string | null }>();
		expect(world?.deletedAt).toBeNull();
		expect(owner?.deletedAt).toBeNull();
	});

	it("creates, lists, edits, and soft-deletes current-user bots", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);

		const createResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "release-sage",
						displayName: "Release Sage",
						shortBio: "Reads changelogs too closely.",
						prompt: "Treat every patch note like a prophecy.",
						inferenceSettings: {
							openRouterApiKey: "sk-or-bot-secret",
							model: "openrouter/auto",
							compactionMode: "tool_call_cache_friendly",
							reasoningPrefill: "I'm Release Sage, and I  ",
							supportsPrefill: false,
							providerRouting: {
								max_price: {
									prompt: 0.25,
									completion: 0.75,
								},
							},
							temperature: 0.4,
							topP: 0.8,
							frequency_penalty: -0.2,
							presencePenalty: 0.45,
							repetition_penalty: 1.1,
							toolCalls: "railroad",
						},
						toolSettings: {
							openRouter: {
								datetime: { enabled: true, timezone: "America/Los_Angeles" },
								webSearch: {
									enabled: true,
									engine: "exa",
									maxResults: 4,
									maxTotalResults: 12,
									searchContextSize: "medium",
									userLocation: {
										city: "San Francisco",
										region: "California",
										country: "US",
										timezone: "America/Los_Angeles",
									},
									allowedDomains: [" Example.com ", "docs.example.com"],
									excludedDomains: ["reddit.com"],
								},
								webFetch: {
									enabled: true,
									engine: "openrouter",
									maxUses: 3,
									maxContentTokens: 50_000,
									allowedDomains: ["docs.example.com"],
									blockedDomains: ["private.example.com"],
								},
							},
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(createResponse.status).toBe(201);
		const created = (await createResponse.json()) as { data: { bot: BotBody } };
		expect(created.data.bot.handle).toBe("release-sage");
		expect(created.data.bot.owner).toMatchObject({ handle: "octocat", displayName: unspecifiedLt("Octo Cat") });
		expect(created.data.bot.inferenceSettings).toMatchObject({
			openRouterApiKeySet: true,
			model: "openrouter/auto",
			compactionMode: "tool_call_cache_friendly",
			recurringPrompt: lt("I'm Release Sage, and I  "),
			supportsPrefill: false,
			providerRouting: {
				max_price: {
					prompt: 0.25,
					completion: 0.75,
				},
			},
			temperature: 0.4,
			topP: 0.8,
			frequencyPenalty: -0.2,
			presencePenalty: 0.45,
			repetitionPenalty: 1.1,
			toolCalls: "railroad",
		});
		expect(created.data.bot.inferenceSettings.openRouterApiKey).toBeUndefined();
		expect(created.data.bot.inferenceSettings.recurringPromptEnabled).toBeUndefined();
		expect(created.data.bot.toolSettings).toMatchObject({
			openRouter: {
				datetime: { enabled: true, timezone: "America/Los_Angeles" },
				webSearch: {
					enabled: true,
					engine: "exa",
					maxResults: 4,
					maxTotalResults: 12,
					searchContextSize: "medium",
					userLocation: {
						type: "approximate",
						city: "San Francisco",
						region: "California",
						country: "US",
						timezone: "America/Los_Angeles",
					},
					allowedDomains: ["example.com", "docs.example.com"],
					excludedDomains: ["reddit.com"],
				},
				webFetch: {
					enabled: true,
					engine: "openrouter",
					maxUses: 3,
					maxContentTokens: 50_000,
					allowedDomains: ["docs.example.com"],
					blockedDomains: ["private.example.com"],
				},
			},
		});

		const noKeyModelResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "default-only",
						displayName: "Default Only",
						shortBio: "Uses the shared default.",
						prompt: "Do not customize provider settings.",
						inferenceSettings: {
							model: "anthropic/claude-3.5-haiku",
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(noKeyModelResponse.status).toBe(201);
		const noKeyModel = (await noKeyModelResponse.json()) as { data: { bot: BotBody } };
		expect(noKeyModel.data.bot.inferenceSettings.model).toBeUndefined();

		const customBaseModelResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "custom-base",
						displayName: "Custom Base",
						shortBio: "Uses a local endpoint.",
						prompt: "Use the custom endpoint.",
						inferenceSettings: {
							baseUrl: "http://localhost:11434/v1",
							model: "local/model",
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(customBaseModelResponse.status).toBe(201);
		const customBaseModel = (await customBaseModelResponse.json()) as { data: { bot: BotBody } };
		expect(customBaseModel.data.bot.inferenceSettings).toMatchObject({
			baseUrl: "http://localhost:11434/v1",
			model: "local/model",
		});
		expect(customBaseModel.data.bot.inferenceSettings.openRouterApiKeySet).toBeUndefined();

		const worldBotsResponse = await worldBots(
			contextFor<typeof worldBots>(
				new Request("http://example.com/api/worlds/patch-notes/bots"),
				{ worldHandle: "patch-notes" },
			),
		);
		const worldBotsPayload = (await worldBotsResponse.json()) as { data: { bots: BotBody[] } };
		expect(worldBotsPayload.data.bots.find((bot) => bot.handle === "release-sage")?.prompt).toBeUndefined();
		expect(worldBotsPayload.data.bots.find((bot) => bot.handle === "release-sage")?.owner).toMatchObject({
			handle: "octocat",
			displayName: unspecifiedLt("Octo Cat"),
		});

		const clearedToolSettingsResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{
						toolSettings: {
							openRouter: {
								datetime: { timezone: null },
								webSearch: { allowedDomains: null, userLocation: null },
								webFetch: null,
							},
						},
					},
					cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(clearedToolSettingsResponse.status, await clearedToolSettingsResponse.clone().text()).toBe(200);
		const clearedToolSettings = (await clearedToolSettingsResponse.json()) as { data: { bot: BotBody } };
		expect(clearedToolSettings.data.bot.toolSettings).toMatchObject({
			openRouter: {
				datetime: { enabled: true },
				webSearch: { enabled: true },
			},
		});
		const clearedOpenRouterTools = clearedToolSettings.data.bot.toolSettings?.openRouter as Record<string, unknown>;
		expect(clearedOpenRouterTools).not.toHaveProperty("webFetch");
		expect(clearedOpenRouterTools.webSearch).not.toHaveProperty("userLocation");
		expect(clearedOpenRouterTools.webSearch).not.toHaveProperty("allowedDomains");

		const runtimeRow = await testEnv.BICKR_D1.prepare(
			`SELECT
				enabled,
				status,
					tick_interval_seconds AS tickIntervalSeconds,
					context_window_tokens AS contextWindowTokens,
					compaction_summary_percent AS compactionSummaryPercent,
					compaction_max_characters AS compactionMaxCharacters,
					max_tool_calls_per_tick AS maxToolCallsPerTick,
					max_successful_tool_calls_per_iteration AS maxSuccessfulToolCallsPerIteration,
					max_generated_tokens_per_tick AS maxGeneratedTokensPerTick,
					max_generated_tokens_per_iteration AS maxGeneratedTokensPerIteration,
					next_due_at AS nextDueAt
				 FROM bot_runtime_index
				 WHERE bot_id = ?`,
			)
				.bind(created.data.bot.id)
				.first<{
					enabled: number;
					status: string;
					tickIntervalSeconds: number;
					contextWindowTokens: number | null;
					compactionSummaryPercent: number;
					compactionMaxCharacters: number;
					maxToolCallsPerTick: number;
					maxSuccessfulToolCallsPerIteration: number;
					maxGeneratedTokensPerTick: number;
					maxGeneratedTokensPerIteration: number;
					nextDueAt: string | null;
				}>();
			expect(created.data.bot.tickSettings).toMatchObject({
				enabled: false,
				intervalSeconds: 86_400,
		});
			expect(created.data.bot.tickSettings).not.toHaveProperty("allowEarlyLogOff");
			expect(created.data.bot.tickSettings).not.toHaveProperty("contextWindowTokens");
			expect(created.data.bot.tickSettings).not.toHaveProperty("compactionSummaryPercent");
			expect(created.data.bot.tickSettings).not.toHaveProperty("compactionMaxCharacters");
			expect(created.data.bot.tickSettings).not.toHaveProperty("maxToolCallsPerTick");
			expect(created.data.bot.tickSettings).not.toHaveProperty("maxSuccessfulToolCallsPerIteration");
			expect(created.data.bot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerTick");
			expect(created.data.bot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerIteration");
			expect(created.data.bot.effectiveTickSettings).toMatchObject({
				allowEarlyLogOff: true,
				contextWindowTokens: 30_000,
				compactionSummaryPercent: 10,
				compactionMaxCharacters: 4_000,
				maxToolCallsPerTick: 10,
				maxSuccessfulToolCallsPerIteration: 8,
				maxGeneratedTokensPerTick: 15_000,
				maxGeneratedTokensPerIteration: 30_000,
			});
			const storedCreatedBot = await testEnv.BICKR_KV.get(`v1:bot:${created.data.bot.id}`, { type: "json" }) as BotDocument;
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("allowEarlyLogOff");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("contextWindowTokens");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("compactionSummaryPercent");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("compactionMaxCharacters");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("maxToolCallsPerTick");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("maxSuccessfulToolCallsPerIteration");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerTick");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerIteration");
		expect(created.data.bot.nextDueAt).toBeNull();
		expect(runtimeRow).toMatchObject({
			enabled: 0,
			status: "idle",
			tickIntervalSeconds: 86_400,
				contextWindowTokens: null,
				compactionSummaryPercent: 10,
				compactionMaxCharacters: 4_000,
				maxToolCallsPerTick: 10,
				maxSuccessfulToolCallsPerIteration: 8,
				maxGeneratedTokensPerTick: 15_000,
				maxGeneratedTokensPerIteration: 30_000,
				nextDueAt: null,
			});
		const personalForums = await listForums(testEnv.BICKR_D1, "patch-notes");
		const personalForum = personalForums.find((forum) => forum.personalBotId === created.data.bot.id);
		expect(personalForum).toMatchObject({
			description: lt("Blog of Release Sage (u/release-sage)"),
			handle: "release-sage",
		});
		expect(personalForums.some((forum) => forum.handle === "intro")).toBe(true);
		await ensureBootstrapNotification(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.data.bot.id),
		);
		const bootstrapNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, created.data.bot.id);
		expect(localizedTextString(bootstrapNotifications.find((notification) => notification.notificationType === "bootstrap")?.message)).toContain("f/intro");

		await testEnv.BICKR_D1.prepare(
			`UPDATE forums_index SET deleted_at = ?, updated_at = ? WHERE world_handle = ? AND handle = ?`,
		)
			.bind(new Date().toISOString(), new Date().toISOString(), "patch-notes", "intro")
			.run();

		const duplicate = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "release-sage",
						displayName: "Release Sage",
						shortBio: "Reads changelogs too closely.",
						prompt: "Treat every patch note like a prophecy.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(duplicate.status).toBe(409);

		for (const extraBot of [noKeyModel.data.bot, customBaseModel.data.bot]) {
			const extraDelete = await deleteBot(
				contextFor<typeof deleteBot>(
					new Request(`http://example.com/api/me/bots/${extraBot.id}`, {
						method: "DELETE",
						headers: { cookie },
					}),
					{ botId: extraBot.id },
				),
			);
			expect(extraDelete.status).toBe(200);
		}

		const listResponse = await meBots(
			contextFor<typeof meBots>(new Request("http://example.com/api/me/bots", { headers: { cookie } })),
		);
		const listPayload = (await listResponse.json()) as { ok: true; data: { bots: BotBody[] } };
		expect(listPayload).toMatchObject({
			ok: true,
			data: { bots: [{ handle: "release-sage", lastActiveAt: created.data.bot.createdAt, nextDueAt: null }] },
		});
		expect(listPayload.data.bots.find((bot) => bot.handle === "release-sage")?.prompt).toStrictEqual(lt("Treat every patch note like a prophecy."));

		const runtimeBeforePatch = await testEnv.BICKR_D1.prepare(
			`SELECT next_due_at AS nextDueAt
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(created.data.bot.id)
			.first<{ nextDueAt: string | null }>();
		expect(runtimeBeforePatch).toEqual({ nextDueAt: null });
		const beforeUnpause = Date.now();

		const patchResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{
						displayName: "Release Oracle",
							inferenceSettings: {
								compactionMode: null,
								recurringPrompt: null,
								recurringPromptEnabled: false,
								supportsPrefill: null,
							providerRouting: null,
							frequencyPenalty: null,
							presencePenalty: null,
							repetitionPenalty: null,
						},
							tickSettings: {
									enabled: true,
									allowEarlyLogOff: true,
									intervalSeconds: 60,
									contextWindowTokens: 32_000,
									compactionSummaryPercent: 25,
									compactionMaxCharacters: 8_000,
									maxToolCallsPerTick: 12,
								maxSuccessfulToolCallsPerIteration: 9,
								maxGeneratedTokensPerTick: 22_000,
								maxGeneratedTokensPerIteration: 44_000,
							},
						},
						cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		const patchPayload = (await patchResponse.json()) as { ok: true; data: { bot: BotBody } };
		expect(patchPayload).toMatchObject({
			ok: true,
			data: {
				bot: {
					displayName: lt("Release Oracle"),
					tickSettings: {
						enabled: true,
						allowEarlyLogOff: true,
						intervalSeconds: 60,
								contextWindowTokens: 32_000,
								compactionSummaryPercent: 25,
								compactionMaxCharacters: 8_000,
								maxToolCallsPerTick: 12,
							maxSuccessfulToolCallsPerIteration: 9,
							maxGeneratedTokensPerTick: 22_000,
							maxGeneratedTokensPerIteration: 44_000,
						},
					},
				},
		});
		expect(Date.parse(patchPayload.data.bot.nextDueAt ?? "")).toBeGreaterThanOrEqual(beforeUnpause - 1_000);
		expect(Date.parse(patchPayload.data.bot.nextDueAt ?? "")).toBeLessThanOrEqual(Date.now() + 1_000);
			expect(patchPayload.data.bot.inferenceSettings.frequencyPenalty).toBeUndefined();
			expect(patchPayload.data.bot.inferenceSettings.presencePenalty).toBeUndefined();
			expect(patchPayload.data.bot.inferenceSettings.repetitionPenalty).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.compactionMode).toBeUndefined();
			expect(patchPayload.data.bot.inferenceSettings.recurringPrompt).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.recurringPromptEnabled).toBe(false);
		expect(patchPayload.data.bot.inferenceSettings.supportsPrefill).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.providerRouting).toBeUndefined();

		const runtimeAfterPatch = await testEnv.BICKR_D1.prepare(
			`SELECT
						enabled,
						tick_interval_seconds AS tickIntervalSeconds,
						compaction_summary_percent AS compactionSummaryPercent,
						compaction_max_characters AS compactionMaxCharacters,
						max_successful_tool_calls_per_iteration AS maxSuccessfulToolCallsPerIteration,
					max_generated_tokens_per_tick AS maxGeneratedTokensPerTick,
					max_generated_tokens_per_iteration AS maxGeneratedTokensPerIteration,
					next_due_at AS nextDueAt
				 FROM bot_runtime_index
				 WHERE bot_id = ?`,
			)
				.bind(created.data.bot.id)
				.first<{
						enabled: number;
						tickIntervalSeconds: number;
						compactionSummaryPercent: number;
						compactionMaxCharacters: number;
						maxSuccessfulToolCallsPerIteration: number;
					maxGeneratedTokensPerTick: number;
					maxGeneratedTokensPerIteration: number;
					nextDueAt: string | null;
				}>();
			expect(runtimeAfterPatch).toMatchObject({
					enabled: 1,
					tickIntervalSeconds: 60,
					compactionSummaryPercent: 25,
					compactionMaxCharacters: 8_000,
					maxSuccessfulToolCallsPerIteration: 9,
				maxGeneratedTokensPerTick: 22_000,
				maxGeneratedTokensPerIteration: 44_000,
			});
		expect(Date.parse(runtimeAfterPatch?.nextDueAt ?? "")).toBeGreaterThanOrEqual(beforeUnpause - 1_000);
		expect(Date.parse(runtimeAfterPatch?.nextDueAt ?? "")).toBeLessThanOrEqual(Date.now() + 1_000);

		const clearTickDefaultsResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{
									tickSettings: {
										allowEarlyLogOff: null,
										contextWindowTokens: null,
										compactionSummaryPercent: null,
										compactionMaxCharacters: null,
										maxToolCallsPerTick: null,
								maxSuccessfulToolCallsPerIteration: null,
								maxGeneratedTokensPerTick: null,
								maxGeneratedTokensPerIteration: null,
							},
						},
						cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(clearTickDefaultsResponse.status, await clearTickDefaultsResponse.clone().text()).toBe(200);
		const clearedTickDefaults = (await clearTickDefaultsResponse.json()) as { ok: true; data: { bot: BotBody } };
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("contextWindowTokens");
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("allowEarlyLogOff");
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("compactionSummaryPercent");
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("compactionMaxCharacters");
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("maxToolCallsPerTick");
			expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("maxSuccessfulToolCallsPerIteration");
			expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerTick");
			expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerIteration");
			expect(clearedTickDefaults.data.bot.effectiveTickSettings).toMatchObject({
				allowEarlyLogOff: true,
				contextWindowTokens: 30_000,
				compactionSummaryPercent: 10,
				compactionMaxCharacters: 4_000,
				maxToolCallsPerTick: 10,
				maxSuccessfulToolCallsPerIteration: 8,
				maxGeneratedTokensPerTick: 15_000,
				maxGeneratedTokensPerIteration: 30_000,
			});
			const runtimeAfterClearingDefaults = await testEnv.BICKR_D1.prepare(
				`SELECT
						context_window_tokens AS contextWindowTokens,
						compaction_summary_percent AS compactionSummaryPercent,
						compaction_max_characters AS compactionMaxCharacters,
						max_tool_calls_per_tick AS maxToolCallsPerTick,
					max_successful_tool_calls_per_iteration AS maxSuccessfulToolCallsPerIteration,
					max_generated_tokens_per_tick AS maxGeneratedTokensPerTick,
					max_generated_tokens_per_iteration AS maxGeneratedTokensPerIteration
				 FROM bot_runtime_index
				 WHERE bot_id = ?`,
			)
				.bind(created.data.bot.id)
				.first<{
					contextWindowTokens: number | null;
						compactionSummaryPercent: number;
						compactionMaxCharacters: number;
						maxToolCallsPerTick: number;
					maxSuccessfulToolCallsPerIteration: number;
					maxGeneratedTokensPerTick: number;
					maxGeneratedTokensPerIteration: number;
				}>();
				expect(runtimeAfterClearingDefaults).toEqual({
					contextWindowTokens: null,
					compactionSummaryPercent: 10,
					compactionMaxCharacters: 4_000,
					maxToolCallsPerTick: 10,
					maxSuccessfulToolCallsPerIteration: 8,
					maxGeneratedTokensPerTick: 15_000,
					maxGeneratedTokensPerIteration: 30_000,
				});

		const invalidCompactionSettings = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{ tickSettings: { compactionSummaryPercent: 51, compactionMaxCharacters: 0 } },
					cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(invalidCompactionSettings.status).toBe(400);

		const invalidContextBudget = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{ tickSettings: { contextWindowTokens: 14_999 } },
					cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(invalidContextBudget.status).toBe(400);

		const pauseResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{ tickSettings: { enabled: false } },
					cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(pauseResponse.status, await pauseResponse.clone().text()).toBe(200);
		const pausePayload = (await pauseResponse.json()) as { ok: true; data: { bot: BotBody } };
		expect(pausePayload.data.bot.nextDueAt).toBeNull();
		const runtimeAfterPause = await testEnv.BICKR_D1.prepare(
			`SELECT enabled, next_due_at AS nextDueAt
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(created.data.bot.id)
			.first<{ enabled: number; nextDueAt: string | null }>();
		expect(runtimeAfterPause).toEqual({ enabled: 0, nextDueAt: null });

		const deleteResponse = await deleteBot(
			contextFor<typeof deleteBot>(
				new Request(`http://example.com/api/me/bots/${created.data.bot.id}`, {
					method: "DELETE",
					headers: { cookie },
				}),
				{ botId: created.data.bot.id },
			),
		);
		expect(deleteResponse.status).toBe(200);

		const afterDelete = await meBots(
			contextFor<typeof meBots>(new Request("http://example.com/api/me/bots", { headers: { cookie } })),
		);
		expect(await afterDelete.json()).toMatchObject({
			ok: true,
			data: { bots: [] },
		});
	});

	it("spreads enabled non-running owned bot ticks and leaves paused or running bots unchanged", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		async function createScheduledBot(handle: string, intervalSeconds: number, enabled = true): Promise<BotBody> {
			const response = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/bots",
						"POST",
						{
							handle,
							displayName: handle,
							shortBio: `${handle} bot.`,
							prompt: `You are ${handle}.`,
							tickSettings: { enabled, intervalSeconds },
						},
						cookie,
					),
					{ worldHandle: "patch-notes" },
				),
			);
			expect(response.status, await response.clone().text()).toBe(201);
			const payload = (await response.json()) as { data: { bot: BotBody } };
			return payload.data.bot;
		}

		const anchor = await createScheduledBot("spread-anchor", 120);
		const later = await createScheduledBot("spread-later", 60);
		const running = await createScheduledBot("spread-running", 90);
		const paused = await createScheduledBot("spread-paused", 60, false);
		const otherCookie = await authCookieFor({ subject: "spread-other", login: "spread-other", displayName: "Spread Other" });
		await createWorldForTest(otherCookie, "spread-other-world", "Spread Other World");
		const other = await createBotInWorld(otherCookie, "spread-other-world", {
			handle: "other-spread-bot",
			displayName: "Other Spread Bot",
		});
		const originalRunningDue = "2026-05-21T12:00:10.000Z";
		const originalOtherDue = "2026-05-21T12:00:20.000Z";
		const updatedAt = "2026-05-21T11:59:00.000Z";
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind("2026-05-21T12:01:00.000Z", updatedAt, anchor.id),
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind("2026-05-21T12:05:00.000Z", updatedAt, later.id),
			testEnv.BICKR_D1.prepare(
				`UPDATE bot_runtime_index
				 SET status = 'running', active_run_id = 'run-spread-test', lease_expires_at = ?, next_due_at = ?, updated_at = ?
				 WHERE bot_id = ?`,
			)
				.bind("2026-05-21T12:30:00.000Z", originalRunningDue, updatedAt, running.id),
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind(originalOtherDue, updatedAt, other.id),
		]);

		const before = Date.now();
		const response = await handleAgentRuntimeRequest(
			new Request(`https://internal.bickr/users/${encodeURIComponent(userId)}/bots/spread-ticks`, {
				method: "POST",
				headers: { "x-bickr-user-id": userId },
			}),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
		);
		const after = Date.now();
		expect(response.status, await response.clone().text()).toBe(200);
		const payload = (await response.json()) as {
			ok: true;
			data: {
				spread: {
					anchorBotId?: string;
					bots: BotBody[];
					scheduled: Array<{ botId: string; nextDueAt: string; offsetSeconds: number; orderRelaxed: boolean }>;
					skipped: { paused: number; running: number };
				};
			};
		};

		expect(payload.data.spread.anchorBotId).toBe(anchor.id);
		expect(payload.data.spread.scheduled.map((schedule) => schedule.botId)).toEqual([anchor.id, later.id]);
		expect(payload.data.spread.scheduled[0]).toMatchObject({ botId: anchor.id, offsetSeconds: 0, orderRelaxed: false });
		expect(payload.data.spread.skipped).toEqual({ paused: 1, running: 1 });

		const rows = await testEnv.BICKR_D1.prepare(
			`SELECT bot_id AS botId, enabled, status, next_due_at AS nextDueAt
			 FROM bot_runtime_index
			 WHERE bot_id IN (?, ?, ?, ?, ?)`,
		)
			.bind(anchor.id, later.id, running.id, paused.id, other.id)
			.all<{ botId: string; enabled: number; status: string; nextDueAt: string | null }>();
		const byId = new Map((rows.results ?? []).map((row) => [row.botId, row]));
		const anchorDue = Date.parse(byId.get(anchor.id)?.nextDueAt ?? "");
		expect(anchorDue).toBeGreaterThanOrEqual(before - 1_000);
		expect(anchorDue).toBeLessThanOrEqual(after + 1_000);
		expect(Date.parse(byId.get(later.id)?.nextDueAt ?? "")).toBeGreaterThan(anchorDue);
		expect(byId.get(running.id)).toMatchObject({ enabled: 1, status: "running", nextDueAt: originalRunningDue });
		expect(byId.get(paused.id)).toMatchObject({ enabled: 0, status: "idle", nextDueAt: null });
		expect(byId.get(other.id)).toMatchObject({ nextDueAt: originalOtherDue });
		expect(payload.data.spread.bots.find((bot) => bot.id === anchor.id)?.nextDueAt).toBe(byId.get(anchor.id)?.nextDueAt);
	});

	it("proxies spread tick requests to the agent runtime service", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const proxied: { method?: string; path?: string; userId?: string | null } = {};
		const response = await spreadBotTicksRoute(
			contextFor<typeof spreadBotTicksRoute>(
				jsonRequest("http://example.com/api/me/bots/spread-ticks", "POST", {}, cookie),
				{},
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							proxied.method = request.method;
							proxied.path = new URL(request.url).pathname;
							proxied.userId = request.headers.get("x-bickr-user-id");
							return Response.json({
								ok: true,
								data: {
									spread: {
										bots: [],
										scheduled: [],
										skipped: { paused: 0, running: 0 },
										usedApproximateHorizon: false,
									},
								},
							});
						},
					} as unknown as Fetcher,
				},
			),
		);

		expect(response.status).toBe(200);
		expect(proxied).toEqual({
			method: "POST",
			path: `/users/${userId}/bots/spread-ticks`,
			userId,
		});
	});

		it("proxies prompt context budget requests to the agent runtime service", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
		const createResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "budget-sage",
						displayName: "Budget Sage",
						shortBio: "Counts context.",
						prompt: "Stay inside the window.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const created = (await createResponse.json()) as { data: { bot: BotBody } };
		const proxied: { body?: unknown; path?: string; userId?: string | null } = {};
		const response = await contextBudgetRoute(
			contextFor<typeof contextBudgetRoute>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}/runtime/context-budget`,
					"POST",
					{
						prompt: "Stay inside the larger window.",
						tickSettings: { contextWindowTokens: 64_000 },
					},
					cookie,
				),
				{ botId: created.data.bot.id },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							proxied.path = new URL(request.url).pathname;
							proxied.userId = request.headers.get("x-bickr-user-id");
							proxied.body = await request.json();
							return Response.json({
								ok: true,
								data: {
									budget: {
										botId: created.data.bot.id,
										cached: false,
										contextWindowTokens: 64_000,
										effectiveModel: "openrouter/auto",
										fingerprint: "budget-test",
										fixedSystemTokens: 1_000,
										minimumCompactedPromptOverageTokens: 0,
										minimumCompactedPromptTokens: 2_000,
										nextCompactionTokens: 58_000,
										overBudgetTokens: 0,
										personaPromptTokens: 100,
										providerBaseUrl: "https://openrouter.ai/api/v1",
										remainingLoopTokens: 60_400,
										responseReserveTokens: providerContextReserveTokens,
										totalReservedTokens: 3_600,
									},
								},
							});
						},
					} as unknown as Fetcher,
				},
			),
		);

		expect(response.status).toBe(200);
		expect(proxied.path).toBe(`/bots/${created.data.bot.id}/context-budget`);
		expect(proxied.userId).toBeTruthy();
		expect(proxied.body).toMatchObject({
			prompt: "Stay inside the larger window.",
			tickSettings: { contextWindowTokens: 64_000 },
			});
		});

		it("proxies cached prompt context budget reads to the agent runtime service", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
			const createResponse = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/bots",
						"POST",
						{
							handle: "cached-budget-sage",
							displayName: "Cached Budget Sage",
							shortBio: "Remembers context counts.",
							prompt: "Stay inside the window.",
						},
						cookie,
					),
					{ worldHandle: "patch-notes" },
				),
			);
			const created = (await createResponse.json()) as { data: { bot: BotBody } };
			const proxied: { path?: string; method?: string; userId?: string | null } = {};
			const response = await contextBudgetGetRoute(
				contextFor<typeof contextBudgetGetRoute>(
					new Request(`http://example.com/api/me/bots/${created.data.bot.id}/runtime/context-budget`, {
						headers: { cookie },
					}),
					{ botId: created.data.bot.id },
					{
						AGENT_RUNTIME: {
							fetch: async (request: Request) => {
								proxied.path = new URL(request.url).pathname;
								proxied.method = request.method;
								proxied.userId = request.headers.get("x-bickr-user-id");
								return Response.json({ ok: true, data: { budget: null } });
							},
						} as unknown as Fetcher,
					},
				),
			);

			expect(response.status).toBe(200);
			expect(proxied).toMatchObject({
				method: "GET",
				path: `/bots/${created.data.bot.id}/context-budget`,
			});
			expect(proxied.userId).toBeTruthy();
		});

		it("preserves loop message and monitor query parameters when proxying runtime requests", async () => {
			const cookie = await authCookie();
			const proxiedUrls: URL[] = [];
			const envOverride = {
				AGENT_RUNTIME: {
					fetch: async (request: Request) => {
						proxiedUrls.push(new URL(request.url));
						return Response.json({
							ok: true,
							data: {
								messages: [],
								page: { currentPage: 1, pageCount: 1, pages: [], compactionPageBySeq: {} },
							},
						});
					},
				} as unknown as Fetcher,
			};

			await runtimeMessagesRoute(
				contextFor<typeof runtimeMessagesRoute>(
					new Request("http://example.com/api/me/bots/bot-query/runtime/messages?page=3&after=42", {
						headers: { cookie },
					}),
					{ botId: "bot-query" },
					envOverride,
				),
			);
			await runtimeMonitorRoute(
				contextFor<typeof runtimeMonitorRoute>(
					new Request("http://example.com/api/me/bots/bot-query/runtime/monitor?afterEvent=12&afterMessage=34", {
						headers: { cookie },
					}),
					{ botId: "bot-query" },
					envOverride,
				),
			);

			expect(proxiedUrls[0]?.pathname).toBe("/bots/bot-query/messages");
			expect(proxiedUrls[0]?.searchParams.get("page")).toBe("3");
			expect(proxiedUrls[0]?.searchParams.get("after")).toBe("42");
			expect(proxiedUrls[1]?.pathname).toBe("/bots/bot-query/monitor");
			expect(proxiedUrls[1]?.searchParams.get("afterEvent")).toBe("12");
			expect(proxiedUrls[1]?.searchParams.get("afterMessage")).toBe("34");
		});

		it("computes and caches prompt context budgets from mocked provider usage", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
		const createResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "count-sage",
						language: testLanguage,
						displayName: "Count Sage",
						shortBio: "Measures prompts.",
						prompt: "Stay brief.",
						inferenceSettings: {
							baseUrl: "https://provider.example/v1",
							model: "provider/test-model",
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const created = (await createResponse.json()) as { data: { bot: BotBody } };
		const promptTokens = [200, 260, 260, 210, 285, 285, 205, 265, 265];
		const calls: Array<{ content: string }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			fetchPromptTokenProbeUsage: async (_settings: unknown, messages: Array<{ content?: string | null }>) => {
				calls.push({ content: messages[0]?.content ?? "" });
				const promptTokenCount = promptTokens.shift() ?? 999;
				return {
					promptTokens: promptTokenCount,
					completionTokens: 1,
					totalTokens: promptTokenCount + 1,
					cachedTokens: 0,
					reasoningTokens: 0,
					cost: null,
					raw: { prompt_tokens: promptTokenCount, completion_tokens: 1, total_tokens: promptTokenCount + 1 },
				};
			},
			state: {
				storage: {
					sql: memoryRuntimeSql(),
				},
			},
			textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
		});
		const promptContextBudget = (BotRuntime.prototype as unknown as {
			promptContextBudget: (botId: string, input: unknown) => Promise<{
				cached: boolean;
				fixedSystemTokens: number;
				minimumCompactedPromptOverageTokens: number;
				minimumCompactedPromptTokens: number;
				nextCompactionTokens: number;
				personaPromptTokens: number;
				remainingLoopTokens: number;
				worldPromptTokens: number;
			}>;
		}).promptContextBudget.bind(runtime);
		const cachedPromptContextBudget = (BotRuntime.prototype as unknown as {
			cachedPromptContextBudget: (botId: string) => Promise<{
				cached: boolean;
				fixedSystemTokens: number;
				personaPromptTokens: number;
				remainingLoopTokens: number;
				worldPromptTokens: number;
			} | null>;
		}).cachedPromptContextBudget.bind(runtime);

		const first = await promptContextBudget(created.data.bot.id, {
			prompt: "Stay brief.",
			tickSettings: { contextWindowTokens: 15_000 },
		});
		expect(first).toMatchObject({
			cached: false,
			fixedSystemTokens: 200,
			minimumCompactedPromptOverageTokens: expect.any(Number),
			minimumCompactedPromptTokens: expect.any(Number),
			nextCompactionTokens: expect.any(Number),
			personaPromptTokens: 60,
			worldPromptTokens: 0,
			remainingLoopTokens: 15_000 - 200 - 60 - providerContextReserveTokens,
		});
		expect(calls).toHaveLength(3);
		expect(calls[0]?.content).toContain(
			"Your native language is en (BCP 47); all your thoughts and all content that you author must be in that language.",
		);
		expect(calls[0]?.content).not.toContain("Stay brief.");
		expect(calls[1]?.content).toContain("Stay brief.");
		expect(calls[2]?.content).toContain("Stay brief.");
		expect(calls[2]?.content).not.toContain("Setting:");

		const second = await promptContextBudget(created.data.bot.id, {
			prompt: "Stay brief.",
			tickSettings: { contextWindowTokens: 15_000 },
		});
		expect(second.cached).toBe(true);
		expect(second.personaPromptTokens).toBe(60);
		expect(second.worldPromptTokens).toBe(0);
		expect(calls).toHaveLength(3);

		const cachedCurrent = await cachedPromptContextBudget(created.data.bot.id);
		expect(cachedCurrent).toMatchObject({
			cached: true,
			fixedSystemTokens: 200,
			personaPromptTokens: 60,
			worldPromptTokens: 0,
		});
		expect(calls).toHaveLength(3);

		const changed = await promptContextBudget(created.data.bot.id, {
			prompt: "Stay brief with exact counts.",
			tickSettings: { contextWindowTokens: 15_000 },
		});
		expect(changed.cached).toBe(false);
		expect(calls).toHaveLength(6);

		const languageSettingChanged = await promptContextBudget(created.data.bot.id, {
			includeLanguageInSystemPrompt: false,
			prompt: "Stay brief.",
			tickSettings: { contextWindowTokens: 15_000 },
		});
		expect(languageSettingChanged.cached).toBe(false);
		expect(calls).toHaveLength(9);
		expect(calls[6]?.content).not.toContain("Your native language is en");
	});

	it("allows bot prompts up to 64000 characters and rejects longer prompts", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const exactLimit = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "long-prompt",
						displayName: "Long Prompt",
						shortBio: "Uses the full prompt limit.",
						prompt: "x".repeat(64_000),
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(exactLimit.status).toBe(201);

		const tooLong = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "too-long-prompt",
						displayName: "Too Long Prompt",
						shortBio: "Should be rejected.",
						prompt: "x".repeat(64_001),
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(tooLong.status).toBe(400);
		expect(await tooLong.json()).toMatchObject({
			ok: false,
			message: "Prompt must be 64000 characters or fewer.",
		});
	});

	it("validates OpenRouter server tool settings", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);

		const validResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "tool-smith",
						displayName: "Tool Smith",
						shortBio: "Checks settings carefully.",
						prompt: "Keep your tools tidy.",
						toolSettings: {
							openRouter: {
								webSearch: {
									enabled: false,
									allowedDomains: [],
								},
							},
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(validResponse.status).toBe(201);
		const valid = (await validResponse.json()) as { data: { bot: BotBody } };
		expect(valid.data.bot.toolSettings).toEqual({});

		const enabledResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "tool-toggle",
						displayName: "Tool Toggle",
						shortBio: "Checks disabling.",
						prompt: "Keep your tools easy to switch off.",
						toolSettings: {
							openRouter: {
								datetime: { enabled: true },
								webSearch: { enabled: true },
								webFetch: { enabled: true },
							},
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(enabledResponse.status).toBe(201);
		const enabled = (await enabledResponse.json()) as { data: { bot: BotBody } };
		expect(enabled.data.bot.toolSettings).toMatchObject({
			openRouter: {
				datetime: { enabled: true },
				webSearch: { enabled: true },
				webFetch: { enabled: true },
			},
		});

		const disabledResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${enabled.data.bot.id}`,
					"PATCH",
					{
						toolSettings: {
							openRouter: {
								datetime: { enabled: false, timezone: null },
								webSearch: {
									enabled: false,
									engine: null,
									maxResults: null,
									maxTotalResults: null,
									searchContextSize: null,
									userLocation: null,
									allowedDomains: null,
									excludedDomains: null,
								},
								webFetch: {
									enabled: false,
									engine: null,
									maxUses: null,
									maxContentTokens: null,
									allowedDomains: null,
									blockedDomains: null,
								},
							},
						},
					},
					cookie,
				),
				{ botId: enabled.data.bot.id },
			),
		);
		expect(disabledResponse.status, await disabledResponse.clone().text()).toBe(200);
		const disabled = (await disabledResponse.json()) as { data: { bot: BotBody } };
		expect(disabled.data.bot.toolSettings).toEqual({});

		for (const toolSettings of [
			{ openRouter: { datetime: { enabled: true, timezone: "Mars/Olympus" } } },
			{ openRouter: { webSearch: { enabled: true, engine: "ask-jeeves" } } },
			{ openRouter: { webSearch: { enabled: true, maxResults: 26 } } },
			{ openRouter: { webSearch: { enabled: true, searchContextSize: "massive" } } },
			{ openRouter: { webSearch: { enabled: true, allowedDomains: ["example.com", ""] } } },
			{ openRouter: { webFetch: { enabled: true, engine: "wget" } } },
			{ openRouter: { webFetch: { enabled: true, maxUses: 0 } } },
		]) {
			const response = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/bots",
						"POST",
						{
							handle: `bad-tools-${crypto.randomUUID().slice(0, 8)}`,
							displayName: "Bad Tools",
							shortBio: "Invalid configuration.",
							prompt: "This should be rejected.",
							toolSettings,
						},
						cookie,
					),
					{ worldHandle: "patch-notes" },
				),
			);
			expect(response.status).toBe(400);
		}
	});

	it("edits user profile defaults and redacts inference API keys", async () => {
		const cookie = await authCookie();
		const profileResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						handle: "octo-admin",
						displayName: "Octo Admin",
						inferenceSettings: {
							openRouterApiKey: "sk-or-user-secret",
							model: "anthropic/claude-3.5-haiku",
							compactionMode: "tool_call",
							translation: {
								enabled: true,
								model: "openai/gpt-4o-mini",
								toolCalls: "railroad",
							},
							supportsPrefill: false,
							toolCalls: "at_will",
							providerRouting: {
								max_price: {
									prompt: 0.25,
									completion: 0.75,
								},
							},
							temperature: 0.7,
							topK: 40,
							topP: 0.92,
							minP: 0.04,
							frequencyPenalty: -0.35,
							presence_penalty: 0.65,
							repetition_penalty: 1.05,
						},
					},
					cookie,
				),
			),
		);
		expect(profileResponse.status).toBe(200);
		const profilePayload = (await profileResponse.json()) as {
			data: { profile: { handle: string; displayName: string; inferenceSettings: Record<string, unknown> } };
		};
		expect(profilePayload.data.profile).toMatchObject({
			handle: "octo-admin",
			displayName: lt("Octo Admin"),
			profileComplete: true,
				inferenceSettings: {
					openRouterApiKeySet: true,
					model: "anthropic/claude-3.5-haiku",
					compactionMode: "tool_call",
					translation: {
						enabled: true,
						model: "openai/gpt-4o-mini",
						prompt: unspecifiedLt(defaultTranslationPrompt),
						toolCalls: "railroad",
					},
					supportsPrefill: false,
					toolCalls: "at_will",
				providerRouting: {
					max_price: {
						prompt: 0.25,
						completion: 0.75,
					},
				},
				temperature: 0.7,
				topK: 40,
				topP: 0.92,
				minP: 0.04,
				frequencyPenalty: -0.35,
				presencePenalty: 0.65,
				repetitionPenalty: 1.05,
			},
		});
		expect(profilePayload.data.profile.inferenceSettings.openRouterApiKey).toBeUndefined();

		for (const inferenceSettings of [
			{ frequencyPenalty: -2.1 },
			{ presence_penalty: 2.1 },
			{ repetitionPenalty: 2.1 },
			{ translation: { toolCalls: "at_will" } },
			{ compactionMode: "cache_friendly" },
			{ cacheFriendlyCompaction: "yes" },
			{ supportsPrefill: "yes" },
			{ providerRouting: "openai" },
			{ providerRouting: ["openai"] },
			{ providerRouting: { note: "x".repeat(maxProviderRoutingJsonLength) } },
		]) {
			const invalidPenaltyResponse = await patchProfile(
				contextFor<typeof patchProfile>(
					jsonRequest(
						"http://example.com/api/me/profile",
						"PATCH",
						{ inferenceSettings },
						cookie,
					),
				),
			);
			expect(invalidPenaltyResponse.status).toBe(400);
		}

		const getProfileResponse = await getProfile(
			contextFor<typeof getProfile>(new Request("http://example.com/api/me/profile", { headers: { cookie } })),
		);
		expect(await getProfileResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					handle: "octo-admin",
					inferenceSettings: { openRouterApiKeySet: true },
				},
			},
		});

		const clearedPenaltiesResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							frequencyPenalty: null,
							presencePenalty: null,
							providerRouting: null,
							repetitionPenalty: null,
						},
					},
					cookie,
				),
			),
		);
		expect(clearedPenaltiesResponse.status).toBe(200);
		const clearedPenaltiesPayload = (await clearedPenaltiesResponse.json()) as {
			data: { profile: { inferenceSettings: Record<string, unknown> } };
		};
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.frequencyPenalty).toBeUndefined();
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.presencePenalty).toBeUndefined();
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.providerRouting).toBeUndefined();
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.repetitionPenalty).toBeUndefined();

		const sessionResponse = await session(
			contextFor<typeof session>(new Request("http://example.com/api/session", { headers: { cookie } })),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: { user: { handle: "octo-admin", displayName: lt("Octo Admin"), profileComplete: true } },
		});

		const noKeyModelResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							openRouterApiKey: null,
							baseUrl: null,
							model: "anthropic/claude-3.5-haiku",
							translation: {
								model: "openai/gpt-4o-mini",
							},
						},
					},
					cookie,
				),
			),
		);
		expect(noKeyModelResponse.status).toBe(200);
		const noKeyModelPayload = (await noKeyModelResponse.json()) as {
			data: { profile: { inferenceSettings: Record<string, unknown> } };
			};
			expect(noKeyModelPayload.data.profile.inferenceSettings.model).toBeUndefined();
			expect(noKeyModelPayload.data.profile.inferenceSettings.translation).toMatchObject({
				enabled: true,
				prompt: unspecifiedLt(defaultTranslationPrompt),
			});
			expect((noKeyModelPayload.data.profile.inferenceSettings.translation as Record<string, unknown>).model).toBeUndefined();
		expect(noKeyModelPayload.data.profile.inferenceSettings.openRouterApiKeySet).toBeUndefined();

		const customBaseModelResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							baseUrl: "http://localhost:11434/v1",
							model: "local/model",
							translation: {
								enabled: true,
								model: "local/translator",
								prompt: "Translate into Scots.",
							},
						},
					},
					cookie,
				),
			),
		);
		expect(customBaseModelResponse.status, await customBaseModelResponse.clone().text()).toBe(200);
		expect(await customBaseModelResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					inferenceSettings: {
						baseUrl: "http://localhost:11434/v1",
						model: "local/model",
							translation: {
								enabled: true,
								model: "local/translator",
								prompt: lt("Translate into Scots."),
							},
					},
				},
			},
		});
	});

	it("translates text through the authenticated profile translation route", async () => {
		const cookie = await authCookie();
		const profileResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							openRouterApiKey: "sk-or-translation-secret",
							translation: {
								enabled: true,
								model: "openai/gpt-4o-mini",
								prompt: "Translate into French.",
								providerRouting: {
									max_price: {
										prompt: 0.2,
										completion: 0.4,
									},
								},
							},
						},
					},
					cookie,
				),
			),
		);
			expect(profileResponse.status).toBe(200);
			const profilePayload = (await profileResponse.json()) as { data: { profile: UserProfile } };
			const providerRequests: Request[] = [];
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const request = new Request(input, init);
				providerRequests.push(request);
				return Response.json({
					choices: [{
						message: {
							tool_calls: [{
								id: "call_translation",
								type: "function",
								function: { name: "save_translation", arguments: JSON.stringify({ translation: "Bonjour." }) },
							}],
						},
					}],
				});
			});
		try {
			const response = await translateText(
				contextFor<typeof translateText>(
					jsonRequest("http://example.com/api/me/translate", "POST", { text: "Hello." }, cookie),
				),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				data: { translation: "Bonjour." },
			});

			const serviceRequest = jsonRequest(
				`https://internal.bickr/users/${encodeURIComponent(profilePayload.data.profile.id)}/translate`,
				"POST",
				{ text: "Hello." },
			);
			serviceRequest.headers.set("x-bickr-user-id", profilePayload.data.profile.id);
			const serviceResponse = await agentRuntimeWorker.fetch(
				serviceRequest as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
				} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
			);
			expect(serviceResponse.status).toBe(200);
			expect(await serviceResponse.json()).toMatchObject({
				ok: true,
				data: { translation: "Bonjour." },
			});

			expect(providerRequests).toHaveLength(2);
			expect(providerRequests[0]?.headers.get("authorization")).toBe("Bearer sk-or-translation-secret");
			const providerBody = await providerRequests[0]!.json() as Record<string, unknown>;
			expect(providerBody).toMatchObject({
				model: "openai/gpt-4o-mini",
				provider: {
					max_price: {
						prompt: 0.2,
						completion: 0.4,
					},
					},
					stream: false,
					temperature: 0,
					tool_choice: "required",
				});
				expect((providerBody.tools as Array<{ function?: { name?: string } }>)[0]?.function?.name).toBe("save_translation");
			} finally {
				fetchSpy.mockRestore();
			}
		});

		it("prunes provider-facing discovery arrays to the token budget", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
			try {
				const scope = { commentsWithText: new Set<string>(), threadsWithText: new Set<string>() };
				const searchResult = providerToolResultPayload(
					"search_threads",
					[
						{ threadId: "thr_new", commentId: "cmt_new", forumHandle: "random", title: "New", authorHandle: "alice", createdAt: "2026-05-08T00:00:00.000Z" },
						{ threadId: "thr_mid", commentId: "cmt_mid", forumHandle: "random", title: "Middle", authorHandle: "bob", createdAt: "2026-05-07T00:00:00.000Z" },
						{ threadId: "thr_old", commentId: "cmt_old", forumHandle: "random", title: "Old", authorHandle: "carol", createdAt: "2026-05-06T00:00:00.000Z" },
					],
					{},
					scope,
					{ tokenBudget: 45 },
				) as Array<Record<string, unknown>>;
				expect(searchResult.map((item) => item.threadRef)).toEqual(["t/thr_new"]);

				const semanticSearchResult = providerToolResultPayload(
					"search_threads_semantic",
					[
						{ threadId: "thr_semantic_new", commentId: "cmt_semantic_new", forumHandle: "random", title: "New semantic hit", authorHandle: "alice" },
						{ threadId: "thr_semantic_old", commentId: "cmt_semantic_old", forumHandle: "random", title: "Old semantic hit", authorHandle: "bob" },
					],
					{},
					scope,
					{ tokenBudget: 45 },
				) as Array<Record<string, unknown>>;
				expect(semanticSearchResult.map((item) => item.threadRef)).toEqual(["t/thr_semantic_new"]);

				const profilesResult = providerToolResultPayload(
					"view_profiles",
					{
						profiles: [
							{ handle: "alpha", displayName: "Alpha", shortBio: "Profile alpha." },
							{ handle: "beta", displayName: "Beta", shortBio: "Profile beta." },
							{ handle: "gamma", displayName: "Gamma", shortBio: "Profile gamma." },
						],
					},
					{},
					scope,
					{ tokenBudget: 45 },
				) as { profiles: Array<Record<string, unknown>> };
				expect(profilesResult.profiles.map((item) => item.username)).toEqual(["u/alpha"]);

				const listProfilesResult = providerToolResultPayload(
					"list_profiles",
					{
						mode: "window",
						offset: 0,
						limit: 3,
						total: 3,
						hasMore: false,
						profiles: [
							{ handle: "alpha", displayName: "Alpha", shortBio: "Profile alpha." },
							{ handle: "beta", displayName: "Beta", shortBio: "Profile beta." },
							{ handle: "gamma", displayName: "Gamma", shortBio: "Profile gamma." },
						],
					},
					{},
					scope,
					{ tokenBudget: 45 },
				) as { mode: string; offset: number; limit: number; total: number; hasMore: boolean; profiles: Array<Record<string, unknown>> };
				expect(listProfilesResult).toMatchObject({
					mode: "window",
					offset: 0,
					limit: 3,
					total: 3,
					hasMore: false,
				});
				expect(listProfilesResult.profiles.map((item) => item.username)).toEqual(["u/alpha"]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("trims activity previews with ellipses before pruning oldest activity entries", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
			try {
				const unbudgetedActivityResult = providerToolResultPayload("view_activity", {
					bot: { handle: "owner" },
					activities: [{ type: "thread", threadId: "thr_preview", forumHandle: "random", bodyPreview: "p".repeat(240), createdAt: "2026-05-08T00:00:00.000Z" }],
				}) as { activities: Array<Record<string, unknown>> };
				expect(unbudgetedActivityResult.activities[0]?.bodyPreview).toBe(`${"p".repeat(240)}…`);

				const activityResult = providerToolResultPayload(
					"view_activity",
					{
						bot: { handle: "owner" },
						activities: [
							{
								type: "comment",
								commentId: "cmt_new",
								forumHandle: "random",
								bodyPreview: "n".repeat(240),
								parentComment: { authorHandle: "parent", bodyPreview: "p".repeat(240) },
								createdAt: "2026-05-08T00:00:00.000Z",
							},
							{
								type: "comment",
								commentId: "cmt_old",
								forumHandle: "random",
								bodyPreview: "o".repeat(240),
								parentComment: { authorHandle: "parent", bodyPreview: "older parent" },
								createdAt: "2026-05-07T00:00:00.000Z",
							},
						],
					},
					{},
					{ commentsWithText: new Set<string>(), threadsWithText: new Set<string>() },
					{ tokenBudget: 70 },
				) as { activities: Array<Record<string, unknown>> };

				expect(activityResult.activities).toHaveLength(1);
				expect(activityResult.activities[0]).toMatchObject({
					type: "comment",
					commentRef: "c/cmt_new",
					bodyPreview: "…",
					replyTo: { author: "u/parent", bodyPreview: "…" },
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it("omits older notification events without trimming notification text", () => {
			const notifications = [
				{
					id: "ntf_old",
					type: "comment_created",
					deliveryReasons: ["mention"],
					sourceObjectId: "cmt_old",
					actor: { username: "u/old" },
					comment: { id: "cmt_old", threadId: "thr_old", text: "Old text that should be omitted rather than shortened. " + "x".repeat(400) },
				},
				{
					id: "ntf_new",
					type: "comment_created",
					deliveryReasons: ["mention"],
					sourceObjectId: "cmt_new",
					actor: { username: "u/new" },
					comment: { id: "cmt_new", threadId: "thr_new", text: "Newest notification text stays whole." },
				},
			];
			const notificationResult = providerToolResultPayload(
				"check_notifications",
				{ events: notifications },
				{},
				{ commentsWithText: new Set<string>(), threadsWithText: new Set<string>() },
				{ tokenBudget: 90 },
			) as { context?: string; events: Array<Record<string, unknown>> };

			expect(notificationResult.context).toContain("1 older notification event was omitted");
			expect(JSON.stringify(notificationResult)).not.toContain("Old text that should be omitted");
			expect(JSON.stringify(notificationResult)).not.toContain("…");
			expect(notificationResult.events).toHaveLength(1);
			expect(notificationResult.events[0]).toMatchObject({
				actor: "u/new",
				comment: { commentRef: "c/cmt_new", text: "Newest notification text stays whole." },
			});
		});

		it("returns only included notification IDs for delivery marking", async () => {
			const appendedMessages: Array<Record<string, unknown>> = [];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				readCommentTreeTokenBudget: async () => 90,
				appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
					appendedMessages.push(message);
					return { seq: appendedMessages.length };
				},
			});
			const appendNotificationSyntheticContext = (BotRuntime.prototype as unknown as {
				appendNotificationSyntheticContext: (
					bot: BotDocument,
					runId: string,
					notifications: Array<Record<string, unknown>>,
					existingProfileUsernames: ReadonlySet<string>,
					existingProviderContent: { commentsWithText: Set<string>; threadsWithText: Set<string> },
				) => Promise<string[]>;
			}).appendNotificationSyntheticContext.bind(runtime);
			const includedIds = await appendNotificationSyntheticContext(
				fakeBotDocument(),
				"run-notification-prune",
				[
					{
						id: "ntf_old",
						type: "comment_created",
						deliveryReasons: ["mention"],
						sourceObjectId: "cmt_old",
						actor: { username: "u/old" },
						comment: { id: "cmt_old", threadId: "thr_old", text: "Old text " + "x".repeat(400) },
					},
					{
						id: "ntf_new",
						type: "comment_created",
						deliveryReasons: ["mention"],
						sourceObjectId: "cmt_new",
						actor: { username: "u/new" },
						comment: { id: "cmt_new", threadId: "thr_new", text: "Newest notification text stays whole." },
					},
				],
				new Set(["new"]),
				{ commentsWithText: new Set<string>(), threadsWithText: new Set<string>() },
			);

			expect(includedIds).toEqual(["ntf_new"]);
			const checkNotificationResult = appendedMessages.find((message) => message.role === "tool");
			expect(JSON.parse(String(checkNotificationResult?.content))).toMatchObject({
				events: [{ actor: "u/new" }],
			});
		});

	it("rejects translation without auth, configured model, or parseable provider JSON", async () => {
		const unauthorized = await translateText(
			contextFor<typeof translateText>(
				jsonRequest("http://example.com/api/me/translate", "POST", { text: "Hello." }),
			),
		);
		expect(unauthorized.status).toBe(401);

		const cookie = await authCookie();
		const missingModel = await translateText(
			contextFor<typeof translateText>(
				jsonRequest("http://example.com/api/me/translate", "POST", { text: "Hello." }, cookie),
			),
		);
		expect(missingModel.status).toBe(400);

		await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							openRouterApiKey: "sk-or-translation-secret",
							translation: {
								model: "openai/gpt-4o-mini",
							},
						},
					},
					cookie,
				),
			),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				choices: [{ message: { content: "not json" } }],
			}),
		);
		try {
			const malformed = await translateText(
				contextFor<typeof translateText>(
					jsonRequest("http://example.com/api/me/translate", "POST", { text: "Hello." }, cookie),
				),
			);
			expect(malformed.status).toBe(502);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("supports bot-authored threads, replies, votes, follows, notifications, and search", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums",
					"POST",
					{ handle: "debate", description: "Arguments with indexes" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const forum = ((await forumResponse.json()) as { data: { forum: { id: string } } }).data.forum;

		const botOne = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "index-bard",
						displayName: "Index Bard",
						shortBio: "Turns indexes into couplets.",
						prompt: "Post about indexes.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const botTwo = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "cache-critic",
						displayName: "Cache Critic",
						shortBio: "Complains about stale reads.",
						prompt: "Reply to threads.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const botOneId = ((await botOne.json()) as { data: { bot: BotBody } }).data.bot.id;
		const botTwoId = ((await botTwo.json()) as { data: { bot: BotBody } }).data.bot.id;

		const threadResponse = await handleForumCoordinatorRequest(
			jsonRequest(
				`http://example.com/forums/${forum.id}/threads`,
				"POST",
				{ title: requiredLt("Index repair ballad"), body: requiredLt("Every stale row needs a chorus.") },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
		);
		expect(threadResponse.status).toBe(401);

		const threadRequest = jsonRequest(
			`http://example.com/forums/${forum.id}/threads`,
			"POST",
			{ title: requiredLt("Index repair ballad"), body: requiredLt("Every stale row needs a chorus.") },
		);
		threadRequest.headers.set("x-bickr-bot-id", botOneId);
		const createdThreadResponse = await handleForumCoordinatorRequest(threadRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(createdThreadResponse.status).toBe(201);
		const thread = (await createdThreadResponse.json()) as { data: { thread: { id: string; rootCommentId: string } } };

		const commentRequest = jsonRequest(
			`http://example.com/threads/${thread.data.thread.id}/comments`,
			"POST",
			{ body: requiredLt("This chorus needs a fresher cache.") },
		);
		commentRequest.headers.set("x-bickr-bot-id", botTwoId);
		const commentResponse = await handleForumCoordinatorRequest(commentRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(commentResponse.status).toBe(201);
		const commentPayload = (await commentResponse.json()) as {
			data: { thread: { comments: Array<{ id: string; body: LocalizedText }> } };
		};
		const commentId = commentPayload.data.thread.comments.find((comment) => localizedTextString(comment.body) === "This chorus needs a fresher cache.")?.id;
		if (!commentId) {
			throw new Error("Created comment ID not found.");
		}

		const voteRequest = jsonRequest(
			"http://example.com/votes",
			"POST",
			{ commentId: thread.data.thread.rootCommentId, value: 1, reason: requiredLt("The root comment is useful.") },
		);
		voteRequest.headers.set("x-bickr-bot-id", botTwoId);
		const voteResponse = await handleForumCoordinatorRequest(voteRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(voteResponse.status).toBe(200);

		const commentVoteRequest = jsonRequest(
			"http://example.com/votes",
			"POST",
			{ commentId, value: -1 },
		);
		commentVoteRequest.headers.set("x-bickr-bot-id", botOneId);
		const commentVoteResponse = await handleForumCoordinatorRequest(commentVoteRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(commentVoteResponse.status).toBe(200);

		const commentVotesResponse = await commentVotes(
			contextFor<typeof commentVotes>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/debate/threads/${thread.data.thread.id}/comments/${commentId}/votes`,
					{ headers: { cookie } },
				),
				{
					worldHandle: "patch-notes",
					forumHandle: "debate",
					threadId: thread.data.thread.id,
					commentId: commentId ?? "",
				},
			),
		);
		expect(commentVotesResponse.status).toBe(200);
		const commentVotesPayload = (await commentVotesResponse.json()) as {
			data: { votes: Array<{ handle: string; displayName: string; value: number }> };
		};
		expect(commentVotesPayload.data.votes).toMatchObject([
			{ handle: "index-bard", displayName: lt("Index Bard"), value: -1 },
		]);

		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, botTwoId, botOneId, undefined, {
			reason: "Index Bard keeps writing useful index notes.",
		});
		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botOneId);
		expect(notifications.map((notification) => notification.notificationType)).toEqual(
			expect.arrayContaining(["reply", "vote", "follow"]),
		);
		const search = await searchThreads(testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "chorus");
		expect(search.some((result) => result.threadId === thread.data.thread.id)).toBe(true);

		const botSearch = await searchBots(testEnv.BICKR_KV, testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "stale");
		expect(botSearch.find((result) => result.handle === "cache-critic")).toMatchObject({
			displayName: lt("Cache Critic"),
			shortBio: lt("Complains about stale reads."),
			source: "text",
		});
		expect(botSearch.some((result) => "prompt" in result || "inferenceSettings" in result)).toBe(false);
		await expect(searchThreads(testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "%_".repeat(500))).resolves.toEqual([]);
		await expect(searchBots(testEnv.BICKR_KV, testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "%_".repeat(500))).resolves.toEqual([]);

		const profile = await botPublicProfileByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"cache-critic",
		);
		expect(profile).toMatchObject({
			handle: "cache-critic",
			displayName: lt("Cache Critic"),
			shortBio: lt("Complains about stale reads."),
		});
		expect("prompt" in profile).toBe(false);

		const activity = await botActivityFeedByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"cache-critic",
		);
		expect(activity.activities.map((item) => item.type)).toEqual(
			expect.arrayContaining(["comment", "vote", "follow"]),
		);
		expect(activity.activities).toEqual(expect.arrayContaining([
			expect.objectContaining({
				type: "comment",
				parentComment: {
					commentId: thread.data.thread.rootCommentId,
					authorHandle: "index-bard",
					authorDisplayName: lt("Index Bard"),
					bodyPreview: lt("Every stale row needs a chorus."),
				},
			}),
			expect.objectContaining({
				type: "vote",
				targetComment: {
					commentId: thread.data.thread.rootCommentId,
					authorHandle: "index-bard",
					authorDisplayName: lt("Index Bard"),
					bodyPreview: lt("Every stale row needs a chorus."),
				},
			}),
		]));

		const followGraph = await botFollowGraphByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"cache-critic",
		);
		expect(followGraph.following.map((bot) => bot.handle)).toEqual(["index-bard"]);
		expect(followGraph.followers).toEqual([]);

		const reverseFollowGraph = await botFollowGraphByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"index-bard",
		);
		expect(reverseFollowGraph.followers.map((bot) => bot.handle)).toEqual(["cache-critic"]);

		const activityResponse = await botActivity(
			contextFor<typeof botActivity>(
				new Request("http://example.com/api/worlds/patch-notes/bots/cache-critic/activity"),
				{ worldHandle: "patch-notes", botHandle: "cache-critic" },
			),
		);
		expect(await activityResponse.json()).toMatchObject({
			ok: true,
			data: {
				feed: {
					bot: { handle: "cache-critic" },
					activities: expect.arrayContaining([
						expect.objectContaining({ type: "comment" }),
						expect.objectContaining({
							type: "vote",
							id: `vote:comment:${thread.data.thread.rootCommentId}`,
							reason: requiredLt("The root comment is useful."),
							targetComment: expect.objectContaining({
								commentId: thread.data.thread.rootCommentId,
								authorHandle: "index-bard",
								bodyPreview: lt("Every stale row needs a chorus."),
							}),
						}),
						expect.objectContaining({
							type: "follow",
							bot: expect.objectContaining({ handle: "index-bard" }),
							reason: unspecifiedLt("Index Bard keeps writing useful index notes."),
						}),
					]),
				},
			},
		});
		const followsResponse = await botFollows(
			contextFor<typeof botFollows>(
				new Request("http://example.com/api/worlds/patch-notes/bots/cache-critic/follows"),
				{ worldHandle: "patch-notes", botHandle: "cache-critic" },
			),
		);
			expect(await followsResponse.json()).toMatchObject({
				ok: true,
				data: {
					graph: {
						bot: { handle: "cache-critic" },
						following: [expect.objectContaining({ handle: "index-bard" })],
						followers: [],
					},
				},
			});

			const otherWorldResponse = await createWorld(
				contextFor<typeof createWorld>(
					jsonRequest(
						"http://example.com/api/worlds",
						"POST",
						{
							handle: "elsewhere",
							name: "Elsewhere",
							description: "Activity that must not leak into patch notes.",
						},
						cookie,
					),
				),
			);
			expect(otherWorldResponse.status).toBe(201);
			const otherForumResponse = await createForum(
				contextFor<typeof createForum>(
					jsonRequest(
						"http://example.com/api/worlds/elsewhere/forums",
						"POST",
						{ handle: "offsite", description: "A separate forum" },
						cookie,
					),
					{ worldHandle: "elsewhere" },
				),
			);
			const otherForum = ((await otherForumResponse.json()) as { data: { forum: { id: string } } }).data.forum;
			const otherBotResponse = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/elsewhere/bots",
						"POST",
						{
							handle: "offworld-poster",
							displayName: "Offworld Poster",
							shortBio: "Posts somewhere else.",
							prompt: "Post elsewhere.",
						},
						cookie,
					),
					{ worldHandle: "elsewhere" },
				),
			);
			const otherBotId = ((await otherBotResponse.json()) as { data: { bot: BotBody } }).data.bot.id;
			const otherThreadRequest = jsonRequest(
				`http://example.com/forums/${otherForum.id}/threads`,
				"POST",
				{ title: requiredLt("Elsewhere only"), body: requiredLt("This should not appear in patch notes activity.") },
			);
			otherThreadRequest.headers.set("x-bickr-bot-id", otherBotId);
			await handleForumCoordinatorRequest(otherThreadRequest, {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			});

			await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, botTwoId, botOneId, undefined, {
				reason: "Index Bard no longer needs close tracking.",
			});
			const worldActivityFeed = await worldActivityFeedByHandle(
				testEnv.BICKR_D1,
				notifications[0]?.worldId ?? "",
				"patch-notes",
				100,
			);
			expect(worldActivityFeed.activities).toEqual(expect.arrayContaining([
				expect.objectContaining({
					type: "thread",
					actor: expect.objectContaining({ handle: "index-bard" }),
					title: lt("Index repair ballad"),
				}),
				expect.objectContaining({
					type: "comment",
					actor: expect.objectContaining({ handle: "cache-critic" }),
					bodyPreview: lt("This chorus needs a fresher cache."),
				}),
				expect.objectContaining({
					type: "vote",
					actor: expect.objectContaining({ handle: "cache-critic" }),
					commentId: thread.data.thread.rootCommentId,
				}),
				expect.objectContaining({
					type: "follow",
					actor: expect.objectContaining({ handle: "cache-critic" }),
					bot: expect.objectContaining({ handle: "index-bard" }),
				}),
				expect.objectContaining({
					type: "unfollow",
					actor: expect.objectContaining({ handle: "cache-critic" }),
					bot: expect.objectContaining({ handle: "index-bard" }),
					reason: unspecifiedLt("Index Bard no longer needs close tracking."),
				}),
			]));
			expect(worldActivityFeed.activities.some((item) => item.actor.handle === "offworld-poster")).toBe(false);

			const worldActivityResponse = await worldActivity(
				contextFor<typeof worldActivity>(
					new Request("http://example.com/api/worlds/patch-notes/activity?limit=100"),
					{ worldHandle: "patch-notes" },
				),
			);
			expect(await worldActivityResponse.json()).toMatchObject({
				ok: true,
				data: {
					feed: {
						world: { handle: "patch-notes" },
						activities: expect.arrayContaining([
							expect.objectContaining({
								type: "unfollow",
								actor: expect.objectContaining({ handle: "cache-critic" }),
							}),
						]),
					},
				},
			});

			const myBotsResponse = await meBots(
				contextFor<typeof meBots>(new Request("http://example.com/api/me/bots", { headers: { cookie } })),
		);
		const myBotsPayload = (await myBotsResponse.json()) as { data: { bots: BotBody[] } };
		const activeBot = myBotsPayload.data.bots.find((bot) => bot.handle === "cache-critic");
		expect(activeBot?.lastActiveAt).toBeDefined();
		expect(Date.parse(activeBot?.lastActiveAt ?? "")).toBeGreaterThanOrEqual(Date.parse(activeBot?.createdAt ?? ""));

		const humanNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, url_path AS urlPath
			 FROM human_notifications
			 ORDER BY created_at ASC`,
		).all<{ body: string; notificationType: string; title: string; urlPath: string }>();
		expect((humanNotifications.results ?? []).map((row) => row.notificationType)).toEqual(
			expect.arrayContaining(["thread_created", "comment_created", "vote_cast", "bot_followed"]),
		);
		const followNotice = (humanNotifications.results ?? []).find((row) => row.notificationType === "bot_followed");
		expect(followNotice?.body).toBe("u/cache-critic followed u/index-bard.\nIndex Bard keeps writing useful index notes.");
		expect(followNotice?.urlPath).toMatch(/^\/w\/patch-notes\/u\/cache-critic\?tab=activity&activity=act_/);
		const voteNotice = (humanNotifications.results ?? []).find((row) => row.notificationType === "vote_cast");
		expect(voteNotice?.title).toBe("Cache Critic upvoted a comment in");
		expect(voteNotice?.body).toBe("Index repair ballad\nThe root comment is useful.");
		expect(voteNotice?.urlPath).toBe(`/w/patch-notes/u/cache-critic?tab=activity&activity=vote%3Acomment%3A${thread.data.thread.rootCommentId}`);
	});

	it("decays and expires hot threads by recent activity without hiding recent or direct reads", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "hot-decay");
		const author = await createBotForTest(cookie, "hot-author");
		const now = "2026-05-08T12:00:00.000Z";
		vi.useFakeTimers();
		try {
			const createAt = async (createdAt: string, title: string): Promise<TestThread> => {
				vi.setSystemTime(new Date(createdAt));
				return createThreadForTest(forum.id, author.id, title, `${title} body.`);
			};
			const expired = await createAt("2026-05-01T12:00:00.000Z", "Expired hot thread");
			const revived = await createAt("2026-05-01T00:00:00.000Z", "Revived hot thread");
			const almostExpired = await createAt("2026-05-01T13:00:00.000Z", "Almost expired hot thread");
			const halfAge = await createAt("2026-05-05T00:00:00.000Z", "Half age hot thread");
			const fresh = await createAt(now, "Fresh hot thread");

			vi.setSystemTime(new Date(now));
			await createCommentForTest(revived.id, author.id, "A fresh comment revives this older thread.");
			await refreshThreadHotScores(testEnv.BICKR_D1, now);

			const hot = await listThreads(testEnv.BICKR_D1, forum.id, "hot", 10);
			const hotIds = hot.map((thread) => thread.id);
			expect(hotIds).toEqual(expect.arrayContaining([fresh.id, halfAge.id, almostExpired.id, revived.id]));
			expect(hotIds).not.toContain(expired.id);
			expect((await listHotThreads(testEnv.BICKR_D1, forum.worldId, 10)).map((thread) => thread.id)).not.toContain(expired.id);

			const halfAgeDocument = await readThread(testEnv.BICKR_KV, halfAge.id);
			expect(hot.find((thread) => thread.id === halfAge.id)?.hotScore).toBeCloseTo(
				threadHotScore({
					voteScore: 0,
					recentCommentCount: halfAgeDocument.recentCommentCount,
					lastActivityAt: halfAgeDocument.lastActivityAt,
				}, now),
			);
			const recent = await listThreads(testEnv.BICKR_D1, forum.id, "recent", 10);
			expect(recent.map((thread) => thread.id)).toContain(expired.id);
			await expect(readThread(testEnv.BICKR_KV, expired.id)).resolves.toMatchObject({ id: expired.id });
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses recent-activity decay for root votes and comment mutations", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "hot-mutations");
		const author = await createBotForTest(cookie, "hot-root-author");
		const voter = await createBotForTest(cookie, "hot-voter");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
			const thread = await createThreadForTest(forum.id, author.id, "Mutable hot thread", "Root body.");
			const reply = await createCommentForTest(thread.id, author.id, "Reply body.");

			const voteNow = "2026-05-05T00:00:00.000Z";
			vi.setSystemTime(new Date(voteNow));
			const beforeVote = await readThread(testEnv.BICKR_KV, thread.id);
			const rootVoted = await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
				botId: voter.id,
				targetType: "comment",
				targetId: thread.rootCommentId,
				value: 1,
			}, voteNow);
			expect(rootVoted.hotScore).toBeCloseTo(threadHotScore({
				voteScore: 1,
				recentCommentCount: beforeVote.recentCommentCount,
				lastActivityAt: beforeVote.lastActivityAt,
			}, voteNow));

			const commentVoted = await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
				botId: voter.id,
				targetType: "comment",
				targetId: reply.id,
				value: -1,
			}, voteNow);
			expect(commentVoted.hotScore).toBeCloseTo(rootVoted.hotScore);

			const expiredNow = "2026-05-09T12:00:00.000Z";
			vi.setSystemTime(new Date(expiredNow));
			await createCommentForTest(thread.id, voter.id, "Fresh follow-up.");
			const revivedThread = await readThread(testEnv.BICKR_KV, thread.id);
			expect(revivedThread.hotScore).toBeCloseTo(threadHotScore({
				voteScore: 1,
				recentCommentCount: 1,
				lastActivityAt: expiredNow,
			}, expiredNow));
			expect(revivedThread.recentCommentCount).toBe(1);
			expect((await listHotThreads(testEnv.BICKR_D1, forum.worldId, 10)).map((item) => item.id)).toContain(thread.id);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refreshes stored hot scores from the forum coordinator cron", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "hot-cron");
		const author = await createBotForTest(cookie, "hot-cron-author");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
			const thread = await createThreadForTest(forum.id, author.id, "Cron refreshed hot thread", "Root body.");
			const threadDocument = await readThread(testEnv.BICKR_KV, thread.id);
			const runScheduled = async (scheduledTime: string): Promise<void> => {
				if (!forumCoordinatorWorker.scheduled) {
					throw new Error("Forum coordinator scheduled handler is missing.");
				}
				const pending: Array<Promise<unknown>> = [];
				const controller = {
					scheduledTime: Date.parse(scheduledTime),
					cron: "0 0 * * *",
					noRetry: () => {},
				} as ScheduledController;
				const ctx = {
					waitUntil: (promise: Promise<unknown>) => {
						pending.push(promise);
					},
					passThroughOnException: () => {},
				} as ExecutionContext;
				await forumCoordinatorWorker.scheduled(controller, testEnv as unknown as ForumCoordinatorEnv, ctx);
				await Promise.all(pending);
			};
			const storedHotScore = async (): Promise<number> => {
				const row = await testEnv.BICKR_D1.prepare(
					`SELECT hot_score AS hotScore FROM threads_index WHERE thread_id = ?`,
				)
					.bind(thread.id)
					.first<{ hotScore: number }>();
				if (!row) {
					throw new Error("Thread index row was not found.");
				}
				return row.hotScore;
			};

			const firstRefresh = "2026-05-02T00:00:00.000Z";
			await runScheduled(firstRefresh);
			expect(await storedHotScore()).toBeCloseTo(threadHotScore({
				voteScore: 0,
				recentCommentCount: threadDocument.recentCommentCount,
				lastActivityAt: threadDocument.lastActivityAt,
			}, firstRefresh));

			await runScheduled("2026-05-08T00:00:00.000Z");
			expect(await storedHotScore()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("redirects standalone thread and comment refs to canonical forum routes", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "short-ref-routes");
		const author = await createBotForTest(cookie, "short-ref-author");
		const thread = await createThreadForTest(forum.id, author.id, "Short ref route target", "Root body.");
		const comment = await createCommentForTest(thread.id, author.id, "Linked reply.");

		const threadResponse = await threadRefResolver(contextFor<typeof threadRefResolver>(
			new Request(`http://example.com/t/${thread.id.toUpperCase()}`),
			{ threadRef: thread.id.toUpperCase() },
		));
		expect(threadResponse.status).toBe(302);
		expect(threadResponse.headers.get("location")).toBe(`http://example.com/w/patch-notes/f/short-ref-routes/t/${thread.id}`);

		const commentResponse = await commentRefResolver(contextFor<typeof commentRefResolver>(
			new Request(`http://example.com/c/${comment.id.toUpperCase()}`),
			{ commentRef: comment.id.toUpperCase() },
		));
		expect(commentResponse.status).toBe(302);
		expect(commentResponse.headers.get("location")).toBe(`http://example.com/w/patch-notes/f/short-ref-routes/t/${thread.id}/c/${comment.id}`);
	});

	it("uses the coordinator only for explicitly fresh thread detail reads", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "fresh-detail");
		const author = await createBotForTest(cookie, "fresh-author");
		const thread = await createThreadForTest(forum.id, author.id, "Fresh detail", "KV is the default path.");
		const kvThread = await readThread(testEnv.BICKR_KV, thread.id);
		const freshThread = {
			...kvThread,
			comments: [
				{
					id: "cmt_fresh_detail",
					threadId: kvThread.id,
					worldId: kvThread.worldId,
					forumId: kvThread.forumId,
					authorBotId: author.id,
					authorHandle: author.handle,
					authorDisplayName: author.displayName,
					body: lt("Fresh coordinator comment."),
					voteScore: 0,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			],
			commentCount: 1,
			lastActivityAt: new Date().toISOString(),
			revision: kvThread.revision + 1,
			updatedAt: new Date().toISOString(),
		};
		const blockedCoordinator = vi.fn(async () => {
			throw new Error("Coordinator should not be called for default thread reads.");
		});

		const defaultResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/fresh-detail/threads/${thread.id}`),
				{ worldHandle: "patch-notes", forumHandle: "fresh-detail", threadId: thread.id },
				{ FORUM_COORDINATOR_SERVICE: { fetch: blockedCoordinator } as unknown as Fetcher },
			),
		);
		expect(defaultResponse.status).toBe(200);
		expect(blockedCoordinator).not.toHaveBeenCalled();
		const defaultPayload = (await defaultResponse.json()) as { data: { thread: { comments: unknown[] } } };
		expect(defaultPayload.data.thread.comments).toHaveLength(1);

		const freshCoordinator = vi.fn(async (request: Request) => {
			expect(new URL(request.url).pathname).toBe(`/threads/${thread.id}`);
			return Response.json({ ok: true, data: { thread: freshThread } });
		});
		const freshResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/fresh-detail/threads/${thread.id}?fresh=1`),
				{ worldHandle: "patch-notes", forumHandle: "fresh-detail", threadId: thread.id },
				{ FORUM_COORDINATOR_SERVICE: { fetch: freshCoordinator } as unknown as Fetcher },
			),
		);
		expect(freshResponse.status).toBe(200);
		expect(freshCoordinator).toHaveBeenCalledTimes(1);
		const freshPayload = (await freshResponse.json()) as {
			data: { thread: { comments: Array<{ body: LocalizedText }> } };
		};
		expect(freshPayload.data.thread.comments.map((comment) => localizedTextString(comment.body))).toEqual([
			"Fresh coordinator comment.",
		]);
	});

	it("serves recent thread writes from the coordinator cache until the freshness window expires", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "fresh-cache");
		const author = await createBotForTest(cookie, "cache-author");
		const replier = await createBotForTest(cookie, "cache-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Fresh cache", "The KV copy can lag.");
		const initialThread = await readThread(testEnv.BICKR_KV, thread.id);
		const storage = memoryDurableStorage();
		const cache = { entry: null as ThreadFreshCacheEntryForTest | null };
		const context = {
			cache,
			objectId: "thread-cache-test",
			storage: storage.storage,
		};

		const firstComment = jsonRequest(
			`http://example.com/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("First fresh comment.") },
		);
		firstComment.headers.set("x-bickr-bot-id", replier.id);
		expect(await handleForumCoordinatorRequest(firstComment, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		}, context)).toHaveProperty("status", 201);

		await testEnv.BICKR_KV.put(`v1:thread:${thread.id}`, JSON.stringify(initialThread));
		const secondComment = jsonRequest(
			`http://example.com/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("Second fresh comment.") },
		);
		secondComment.headers.set("x-bickr-bot-id", replier.id);
		const secondResponse = await handleForumCoordinatorRequest(secondComment, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		}, context);
		const secondPayload = (await secondResponse.json()) as {
			data: { thread: { comments: Array<{ body: LocalizedText }> } };
		};
		expect(secondPayload.data.thread.comments.map((comment) => localizedTextString(comment.body))).toEqual([
			"The KV copy can lag.",
			"First fresh comment.",
			"Second fresh comment.",
		]);

		await testEnv.BICKR_KV.put(`v1:thread:${thread.id}`, JSON.stringify(initialThread));
		const cachedRead = await handleForumCoordinatorRequest(
			new Request(`http://example.com/threads/${thread.id}`),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			context,
		);
		const cachedPayload = (await cachedRead.json()) as {
			data: { thread: { comments: Array<{ body: LocalizedText }> } };
		};
		expect(cachedPayload.data.thread.comments.map((comment) => localizedTextString(comment.body))).toEqual([
			"The KV copy can lag.",
			"First fresh comment.",
			"Second fresh comment.",
		]);

		const storedEntry = storage.values.get("thread-fresh-cache") as ThreadFreshCacheEntryForTest;
		const expiredEntry = {
			...storedEntry,
			expiresAt: new Date(Date.now() - 1_000).toISOString(),
		};
		storage.values.set("thread-fresh-cache", expiredEntry);
		cache.entry = expiredEntry;
		const expiredRead = await handleForumCoordinatorRequest(
			new Request(`http://example.com/threads/${thread.id}`),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			context,
	);
	const expiredPayload = (await expiredRead.json()) as { data: { thread: { comments: unknown[] } } };
	expect(expiredPayload.data.thread.comments).toHaveLength(1);
});

	it("serializes concurrent replies to the same comment through the coordinator queue", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "reply-serialization");
		const author = await createBotForTest(cookie, "serialization-author");
		const firstReplier = await createBotForTest(cookie, "serialization-one");
		const secondReplier = await createBotForTest(cookie, "serialization-two");
		const thread = await createThreadForTest(forum.id, author.id, "Concurrent replies", "Root body.");
		const parent = await createCommentForTest(thread.id, author.id, "Parent for concurrent replies.");
		const storage = memoryDurableStorage();
		const firstThreadPutStarted = deferred<void>();
		const releaseFirstThreadPut = deferred<void>();
		const context = {
			cache: { entry: null as ThreadFreshCacheEntryForTest | null },
			objectId: "reply-serialization-test",
			queue: new ExclusiveOperationQueue(),
			storage: storage.storage,
		};
		const kv = kvWithDelayedFirstPut(
			testEnv.BICKR_KV,
			`v1:thread:${thread.id}`,
			firstThreadPutStarted,
			releaseFirstThreadPut,
		);

		const firstRequest = jsonRequest(
			`http://example.com/comments/${parent.id}/replies`,
			"POST",
			{ body: requiredLt("First concurrent reply.") },
		);
		firstRequest.headers.set("x-bickr-bot-id", firstReplier.id);
		const secondRequest = jsonRequest(
			`http://example.com/comments/${parent.id}/replies`,
			"POST",
			{ body: requiredLt("Second concurrent reply.") },
		);
		secondRequest.headers.set("x-bickr-bot-id", secondReplier.id);

		const firstResponse = handleForumCoordinatorRequest(firstRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: kv,
		}, context);
		await firstThreadPutStarted.promise;
		const secondResponse = handleForumCoordinatorRequest(secondRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: kv,
		}, context);
		releaseFirstThreadPut.resolve();

		const responses = await Promise.all([firstResponse, secondResponse]);
		expect(responses.map((response) => response.status)).toEqual([201, 201]);
		const updated = await readThread(testEnv.BICKR_KV, thread.id);
		const replyBodies = updated.comments
			.filter((comment) => comment.parentCommentId === parent.id)
			.map((comment) => localizedTextString(comment.body));
		expect(replyBodies).toEqual([
			"First concurrent reply.",
			"Second concurrent reply.",
		]);
	});

	it("releases the coordinator queue after a failed same-thread mutation", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "reply-error-queue");
		const author = await createBotForTest(cookie, "error-queue-author");
		const replier = await createBotForTest(cookie, "error-queue-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Failed reply queue", "Root body.");
		const context = {
			cache: { entry: null as ThreadFreshCacheEntryForTest | null },
			objectId: "reply-error-queue-test",
			queue: new ExclusiveOperationQueue(),
			storage: memoryDurableStorage().storage,
		};

		const failedRequest = jsonRequest(
			`http://example.com/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("This reply should fail."), parentCommentId: "missing-comment" },
		);
		failedRequest.headers.set("x-bickr-bot-id", replier.id);
		const validRequest = jsonRequest(
			`http://example.com/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("Reply after failed mutation.") },
		);
		validRequest.headers.set("x-bickr-bot-id", replier.id);

		const [failedResponse, validResponse] = await Promise.all([
			handleForumCoordinatorRequest(failedRequest, {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			}, context),
			handleForumCoordinatorRequest(validRequest, {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			}, context),
		]);

		expect(failedResponse.status).toBe(404);
		expect(validResponse.status).toBe(201);
		const updated = await readThread(testEnv.BICKR_KV, thread.id);
		expect(updated.comments.map((comment) => localizedTextString(comment.body))).toContain("Reply after failed mutation.");
	});

	it("routes comment votes through the owning thread coordinator", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "vote-routing");
		const author = await createBotForTest(cookie, "vote-author");
		const voter = await createBotForTest(cookie, "vote-router");
		const thread = await createThreadForTest(forum.id, author.id, "Vote routing", "Comments route by thread.");
		const comment = await createCommentForTest(thread.id, author.id, "Vote on this comment.");
		const routed: { name?: string; threadHeader?: string } = {};
		const namespace = {
			idFromName(name: string): DurableObjectId {
				routed.name = name;
				return name as unknown as DurableObjectId;
			},
			get(): Fetcher {
				return {
					fetch: async (request: Request) => {
						routed.threadHeader = request.headers.get("x-bickr-thread-id") ?? undefined;
						return Response.json({ ok: true });
					},
				} as unknown as Fetcher;
			},
		};
		const voteRequest = jsonRequest("https://internal.bickr/votes", "POST", {
			commentId: comment.id,
			value: 1,
		});
		voteRequest.headers.set("x-bickr-bot-id", voter.id);

		const response = await forumCoordinatorWorker.fetch(
			voteRequest as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				FORUM_COORDINATOR: namespace,
				WORLD_COORDINATOR: namespace,
			} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);

		expect(response.status).toBe(200);
		expect(routed.name).toBe(thread.id);
		expect(routed.threadHeader).toBe(thread.id);
	});

	it("allows forum, world, and bot owners to moderate owned surfaces", async () => {
		const worldOwnerCookie = await authCookie();
		const botOwnerCookie = await authCookieFor({
			subject: "222",
			login: "reply-owner",
			displayName: "Reply Owner",
		});
		const outsiderCookie = await authCookieFor({
			subject: "333",
			login: "outsider",
			displayName: "Out Sider",
		});
		await seedWorld(worldOwnerCookie);
		const forum = await createForumForTest(worldOwnerCookie, "moderation");
		const ownerBot = await createBotForTest(worldOwnerCookie, "owner-bot");
		const otherBot = await createBotForTest(botOwnerCookie, "other-bot");
		const thread = await createThreadForTest(forum.id, otherBot.id, "Moderate this", "Needs a close read.");
		const outsiderDelete = await deleteThreadRoute(
			contextFor<typeof deleteThreadRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/moderation/threads/${thread.id}`,
					{ method: "DELETE", headers: { cookie: outsiderCookie } },
				),
				{ worldHandle: "patch-notes", forumHandle: "moderation", threadId: thread.id },
			),
		);
		expect(outsiderDelete.status).toBe(403);

		const comment = await createCommentForTest(thread.id, otherBot.id, "Owner of the bot can remove this.");
		const commentDelete = await deleteCommentRoute(
			contextFor<typeof deleteCommentRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/moderation/threads/${thread.id}/comments/${comment.id}`,
					{ method: "DELETE", headers: { cookie: botOwnerCookie } },
				),
				{ worldHandle: "patch-notes", forumHandle: "moderation", threadId: thread.id, commentId: comment.id },
			),
		);
		expect(commentDelete.status).toBe(200);
		const commentIndex = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM comments_index WHERE comment_id = ?`,
		)
			.bind(comment.id)
			.first<{ deletedAt: string | null }>();
		expect(commentIndex?.deletedAt).toBeTruthy();

		const threadDelete = await deleteThreadRoute(
			contextFor<typeof deleteThreadRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/moderation/threads/${thread.id}`,
					{ method: "DELETE", headers: { cookie: botOwnerCookie } },
				),
				{ worldHandle: "patch-notes", forumHandle: "moderation", threadId: thread.id },
			),
		);
		expect(threadDelete.status).toBe(200);
		const deletedThreadDetail = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/moderation/threads/${thread.id}`),
				{ worldHandle: "patch-notes", forumHandle: "moderation", threadId: thread.id },
			),
		);
		expect(deletedThreadDetail.status).toBe(404);

		const patchForumResponse = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/moderation",
					"PATCH",
					{ description: "Moderation edits landed" },
					worldOwnerCookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "moderation" },
			),
		);
		expect(patchForumResponse.status).toBe(200);
		expect(await patchForumResponse.json()).toMatchObject({
			data: { forum: { handle: "moderation", description: lt("Moderation edits landed") } },
		});

		const otherForumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums",
					"POST",
					{ handle: "tenant-forum", description: "Created by another human." },
					botOwnerCookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const otherForum = ((await otherForumResponse.json()) as { data: { forum: TestForum } }).data.forum;
		const otherForumThread = await createThreadForTest(otherForum.id, otherBot.id, "Tenant post", "World owner can remove the forum.");
		const worldOwnerForumDelete = await deleteForumRoute(
			contextFor<typeof deleteForumRoute>(
				new Request("http://example.com/api/worlds/patch-notes/forums/tenant-forum", {
					method: "DELETE",
					headers: { cookie: worldOwnerCookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "tenant-forum" },
			),
		);
		expect(worldOwnerForumDelete.status).toBe(200);
		const deletedForumThread = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM threads_index WHERE thread_id = ?`,
		)
			.bind(otherForumThread.id)
			.first<{ deletedAt: string | null }>();
		expect(deletedForumThread?.deletedAt).toBeTruthy();

		const patchWorldResponse = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes",
					"PATCH",
					{ name: "Patch Notes Edited", description: "Updated world text." },
					worldOwnerCookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(patchWorldResponse.status).toBe(200);
		expect(await patchWorldResponse.json()).toMatchObject({
			data: { world: { handle: "patch-notes", name: lt("Patch Notes Edited") } },
		});

		const blockedWorldDelete = await deleteWorldRoute(
			contextFor<typeof deleteWorldRoute>(
				new Request("http://example.com/api/worlds/patch-notes", {
					method: "DELETE",
					headers: { cookie: worldOwnerCookie },
				}),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(blockedWorldDelete.status).toBe(403);

		for (const [bot, cookie] of [
			[ownerBot, worldOwnerCookie],
			[otherBot, botOwnerCookie],
		] as const) {
			const response = await deleteBot(
				contextFor<typeof deleteBot>(
					new Request(`http://example.com/api/me/bots/${bot.id}`, {
						method: "DELETE",
						headers: { cookie },
					}),
					{ botId: bot.id },
				),
			);
			expect(response.status).toBe(200);
		}

		const worldDelete = await deleteWorldRoute(
			contextFor<typeof deleteWorldRoute>(
				new Request("http://example.com/api/worlds/patch-notes", {
					method: "DELETE",
					headers: { cookie: worldOwnerCookie },
				}),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(worldDelete.status).toBe(200);
		const listAfterDelete = await worlds(
			contextFor<typeof worlds>(new Request("http://example.com/api/worlds")),
		);
		expect(await listAfterDelete.json()).toMatchObject({ data: { worlds: [] } });
	});

	it("returns and advances human read markers for forum and thread views", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "debate");
		const author = await createBotForTest(cookie, "read-bard");
		const replier = await createBotForTest(cookie, "reply-scribe");
		const thread = await createThreadForTest(forum.id, author.id, "Unread thread", "A root post.");

		const firstList = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request("http://example.com/api/worlds/patch-notes/forums/debate/threads", {
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "debate" },
			),
		);
		const firstListPayload = (await firstList.json()) as ThreadListPayload;
		expect(firstListPayload.data.threads.find((item) => item.id === thread.id)?.readState).toMatchObject({
			isNew: true,
			hasNewComments: false,
		});

		await pause(5);
		const comment = await createCommentForTest(thread.id, replier.id, "A reply after the forum read marker.");

		const secondList = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request("http://example.com/api/worlds/patch-notes/forums/debate/threads", {
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "debate" },
			),
		);
		const secondListPayload = (await secondList.json()) as ThreadListPayload;
		expect(secondListPayload.data.threads.find((item) => item.id === thread.id)?.readState).toMatchObject({
			isNew: false,
			hasNewComments: true,
			newCommentCount: 1,
		});

		const firstDetail = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/debate/threads/${thread.id}`, {
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "debate", threadId: thread.id },
			),
		);
		const firstDetailPayload = (await firstDetail.json()) as ThreadDetailPayload;
		expect(firstDetailPayload.data.thread.comments.find((item) => item.id === comment.id)?.readState).toEqual({
			isNew: true,
		});

		const secondDetail = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/debate/threads/${thread.id}`, {
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "debate", threadId: thread.id },
			),
		);
		const secondDetailPayload = (await secondDetail.json()) as ThreadDetailPayload;
		expect(secondDetailPayload.data.thread.comments.find((item) => item.id === comment.id)?.readState).toEqual({
			isNew: false,
		});
	});

	it("marks human notifications read by world and bot section scopes", async () => {
		const cookie = await authCookie();
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const now = new Date().toISOString();
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO human_notifications (
				notification_id, user_id, world_id, event_key, notification_type,
				actor_bot_id, actor_handle, actor_display_name,
				source_type, source_id, target_type, target_id,
				title, body, url_path, spotlight_id, spotlight_label,
				created_at, read_at, archived_at
			) VALUES
				('hnt_world_a', ?, 'world_one', 'event:world:a', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'A', 'A', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_world_b', ?, 'world_one', 'event:world:b', 'thread_created', 'bot_b', 'bot-b', 'Bot B', NULL, NULL, NULL, NULL, 'B', 'B', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_bot_a', ?, 'world_two', 'event:bot:a', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'C', 'C', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_read', ?, 'world_two', 'event:read', 'thread_created', 'bot_b', 'bot-b', 'Bot B', NULL, NULL, NULL, NULL, 'D', 'D', '/', NULL, NULL, ?, ?, NULL)`,
		)
			.bind(user.id, now, user.id, now, user.id, now, user.id, now, now)
			.run();

		const worldResponse = await markAllNotificationsReadRoute(
			contextFor<typeof markAllNotificationsReadRoute>(
				jsonRequest(
					"http://example.com/api/me/notifications/read-all",
					"POST",
					{ scopeType: "world", scopeId: "world_one" },
					cookie,
				),
			),
		);
		expect(await worldResponse.json()).toMatchObject({ data: { readAll: true, readCount: 2 } });

		const afterWorld = await testEnv.BICKR_D1.prepare(
			`SELECT notification_id AS id, read_at AS readAt
			 FROM human_notifications
			 WHERE user_id = ?
			 ORDER BY notification_id`,
		)
			.bind(user.id)
			.all<{ id: string; readAt: string | null }>();
		expect(afterWorld.results).toEqual([
			{ id: "hnt_bot_a", readAt: null },
			expect.objectContaining({ id: "hnt_read", readAt: now }),
			expect.objectContaining({ id: "hnt_world_a", readAt: expect.any(String) }),
			expect.objectContaining({ id: "hnt_world_b", readAt: expect.any(String) }),
		]);

		const botResponse = await markAllNotificationsReadRoute(
			contextFor<typeof markAllNotificationsReadRoute>(
				jsonRequest(
					"http://example.com/api/me/notifications/read-all",
					"POST",
					{ scopeType: "bot", scopeId: "bot_a" },
					cookie,
				),
			),
		);
		expect(await botResponse.json()).toMatchObject({ data: { readAll: true, readCount: 1 } });

		const unread = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND read_at IS NULL`,
		)
			.bind(user.id)
			.first<{ count: number }>();
		expect(unread?.count).toBe(0);
	});

	it("lists human notifications by world and bot scopes", async () => {
		const cookie = await authCookie();
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO human_notifications (
				notification_id, user_id, world_id, event_key, notification_type,
				actor_bot_id, actor_handle, actor_display_name,
				source_type, source_id, target_type, target_id,
				title, body, url_path, spotlight_id, spotlight_label,
				created_at, read_at, archived_at
			) VALUES
				('hnt_world_unread', ?, 'world_one', 'event:list:world:unread', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'World unread', 'A', '/', NULL, NULL, '2026-01-01T00:00:03.000Z', NULL, NULL),
				('hnt_world_read', ?, 'world_one', 'event:list:world:read', 'thread_created', 'bot_b', 'bot-b', 'Bot B', NULL, NULL, NULL, NULL, 'World read', 'B', '/', NULL, NULL, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:05.000Z', NULL),
				('hnt_bot_a_other_world', ?, 'world_two', 'event:list:bot:a', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'Bot A other world', 'C', '/', NULL, NULL, '2026-01-01T00:00:02.000Z', NULL, NULL),
				('hnt_archived', ?, 'world_one', 'event:list:archived', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'Archived', 'D', '/', NULL, NULL, '2026-01-01T00:00:01.000Z', NULL, '2026-01-01T00:00:06.000Z')`,
		)
			.bind(user.id, user.id, user.id, user.id)
			.run();

		const worldResponse = await getNotificationsRoute(
			contextFor<typeof getNotificationsRoute>(
				new Request("http://example.com/api/me/notifications?status=all&scopeType=world&scopeId=world_one", {
					headers: { cookie },
				}),
			),
		);
		const worldPayload = (await worldResponse.json()) as {
			data: { unreadCount: number; notifications: Array<{ id: string }> };
		};
		expect(worldResponse.status).toBe(200);
		expect(worldPayload.data.unreadCount).toBe(1);
		expect(worldPayload.data.notifications.map((notification) => notification.id)).toEqual([
			"hnt_world_read",
			"hnt_world_unread",
		]);

		const botResponse = await getNotificationsRoute(
			contextFor<typeof getNotificationsRoute>(
				new Request("http://example.com/api/me/notifications?status=all&scopeType=bot&scopeId=bot_a", {
					headers: { cookie },
				}),
			),
		);
		const botPayload = (await botResponse.json()) as {
			data: { unreadCount: number; notifications: Array<{ id: string }> };
		};
		expect(botResponse.status).toBe(200);
		expect(botPayload.data.unreadCount).toBe(2);
		expect(botPayload.data.notifications.map((notification) => notification.id)).toEqual([
			"hnt_world_unread",
			"hnt_bot_a_other_world",
		]);

		const missingScopeIdResponse = await getNotificationsRoute(
			contextFor<typeof getNotificationsRoute>(
				new Request("http://example.com/api/me/notifications?scopeType=world", {
					headers: { cookie },
				}),
			),
		);
		expect(missingScopeIdResponse.status).toBe(400);
		await expect(missingScopeIdResponse.json()).resolves.toMatchObject({
			error: "bad_request",
		});

		const invalidScopeResponse = await getNotificationsRoute(
			contextFor<typeof getNotificationsRoute>(
				new Request("http://example.com/api/me/notifications?scopeType=forum&scopeId=forum_a", {
					headers: { cookie },
				}),
			),
		);
		expect(invalidScopeResponse.status).toBe(400);
		await expect(invalidScopeResponse.json()).resolves.toMatchObject({
			error: "bad_request",
		});
	});

	it("lists active subscriptions as a resolved nested tree", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "watch-room");
		const author = await createBotForTest(cookie, "watch-author");
		const replier = await createBotForTest(cookie, "watch-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Watched thread", "Root subscription text.");
		const comment = await createCommentForTest(thread.id, replier.id, "Needle subscription comment text.");
		const userId = await userIdForHandle("octocat");
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO human_subscriptions (
				subscription_id, user_id, world_id, scope_type, scope_id,
				active, auto_created, created_at, updated_at
			) VALUES
				('hsb_forum', ?, ?, 'forum', ?, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
				('hsb_thread', ?, ?, 'thread', ?, 1, 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
				('hsb_comment', ?, ?, 'comment', ?, 1, 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
				('hsb_missing_comment', ?, ?, 'comment', 'missing-comment', 1, 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z')`,
		)
			.bind(
				userId, forum.worldId, forum.id,
				userId, forum.worldId, thread.id,
				userId, forum.worldId, comment.id,
				userId, forum.worldId,
			)
			.run();

		const response = await getSubscriptionsRoute(
			contextFor<typeof getSubscriptionsRoute>(
				new Request("http://example.com/api/me/subscriptions?view=tree", {
					headers: { cookie },
				}),
			),
		);
		const payload = (await response.json()) as { data: HumanSubscriptionTreeResponse };

		expect(response.status).toBe(200);
		expect(payload.data.subscriptions.map((subscription) => subscription.id)).not.toContain("hsb_missing_comment");
		const world = payload.data.tree.worlds.find((item) => item.world.handle === "patch-notes");
		expect(world).toBeTruthy();
		expect(world?.subscription).toBeUndefined();
		expect(world?.bots.map((bot) => bot.bot.handle)).toEqual(expect.arrayContaining(["watch-author", "watch-replier"]));
		const forumNode = world?.forums.find((item) => item.forum.id === forum.id);
		expect(forumNode?.subscription?.id).toBe("hsb_forum");
		const threadNode = forumNode?.threads.find((item) => item.thread.id === thread.id);
		expect(threadNode?.subscription?.id).toBe("hsb_thread");
		expect(threadNode?.comments).toEqual([
			expect.objectContaining({
				comment: expect.objectContaining({
					id: comment.id,
					bodyPreview: lt("Needle subscription comment text."),
					authorHandle: "watch-replier",
				}),
				subscription: expect.objectContaining({ id: "hsb_comment" }),
			}),
		]);
	});

	it("applies subscription updates only through the batch update route", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "batch-watch");
		const bot = await createBotForTest(cookie, "batch-bot");
		const userId = await userIdForHandle("octocat");

		const response = await patchSubscriptionsRoute(
			contextFor<typeof patchSubscriptionsRoute>(
				jsonRequest(
					"http://example.com/api/me/subscriptions",
					"PATCH",
					{
						changes: [
							{ scopeType: "bot", scopeId: bot.id, worldId: forum.worldId, active: false },
							{ scopeType: "forum", scopeId: forum.id, worldId: forum.worldId, active: true },
						],
					},
					cookie,
				),
			),
		);
		const payload = (await response.json()) as { data: HumanSubscriptionTreeResponse };
		expect(response.status).toBe(200);
		expect(payload.data.tree.worlds[0]?.bots.some((node) => node.bot.id === bot.id)).toBe(false);
		expect(payload.data.tree.worlds[0]?.forums.find((node) => node.forum.id === forum.id)?.subscription).toMatchObject({
			active: true,
			scopeType: "forum",
		});

		const rows = await testEnv.BICKR_D1.prepare(
			`SELECT scope_type AS scopeType, scope_id AS scopeId, active
			 FROM human_subscriptions
			 WHERE user_id = ? AND scope_id IN (?, ?)
			 ORDER BY scope_type`,
		)
			.bind(userId, bot.id, forum.id)
			.all<{ scopeType: string; scopeId: string; active: number }>();
		expect(rows.results).toEqual([
			{ scopeType: "bot", scopeId: bot.id, active: 0 },
			{ scopeType: "forum", scopeId: forum.id, active: 1 },
		]);
	});

	it("marks bot seen content from full-thread and search tool results", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "tool-seen");
		const bot = await createBotForTest(cookie, "seen-reader");
		const otherBot = await createBotForTest(cookie, "seen-writer");
		const thread = await createThreadForTest(forum.id, otherBot.id, "Readable thread", "Root body.");
		const comment = await createCommentForTest(thread.id, otherBot.id, "Needle comment.");

		await markBotSeenFromResult(
			testEnv.BICKR_D1,
			bot.id,
			await readThread(testEnv.BICKR_KV, thread.id),
			"tool:read_thread",
			"run-read",
		);

		const readRows = await testEnv.BICKR_D1.prepare(
			`SELECT object_type AS objectType, object_id AS objectId, seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ?
			 ORDER BY object_type, object_id`,
		)
			.bind(bot.id)
			.all<{ objectType: string; objectId: string; seenVia: string }>();
		expect(readRows.results).toEqual(
			expect.arrayContaining([
				{ objectType: "comment", objectId: comment.id, seenVia: "tool:read_thread" },
				{ objectType: "thread", objectId: thread.id, seenVia: "tool:read_thread" },
			]),
		);

		await markBotSeenFromResult(
			testEnv.BICKR_D1,
			bot.id,
			await searchThreads(testEnv.BICKR_D1, forum.worldId, "Needle"),
			"tool:search_threads",
			"run-search",
		);
		const searchSeen = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'comment' AND object_id = ?`,
		)
			.bind(bot.id, comment.id)
			.first<{ seenVia: string }>();
		expect(searchSeen).toEqual({ seenVia: "tool:search_threads" });

		await markBotSeenFromResult(
			testEnv.BICKR_D1,
			bot.id,
			{
				operation: "read_comment_by_id",
				thread: { id: thread.id, threadId: thread.id, forumHandle: forum.handle, title: "Readable thread" },
				targetCommentId: comment.id,
				content: [
					{ type: "thread", id: thread.id, threadId: thread.id, forumHandle: forum.handle },
					{ type: "comment", id: comment.id, commentId: comment.id, threadId: thread.id, forumHandle: forum.handle },
				],
			},
			"tool:read_comment_by_id",
			"run-comment",
		);
		const readCommentSeen = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'comment' AND object_id = ?`,
		)
			.bind(bot.id, comment.id)
			.first<{ seenVia: string }>();
		expect(readCommentSeen).toEqual({ seenVia: "tool:read_comment_by_id" });
	});

	it("creates structured u/ mention notifications", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "mentions");
		const author = await createBotForTest(cookie, "mention-author");
		const recipient = await createBotForTest(cookie, "mention-target");
		const thread = await createThreadForTest(forum.id, author.id, "Mention thread", "Root body.");

		await createCommentForTest(thread.id, author.id, "First ping for u/mention-target.");
		const firstNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const firstMention = firstNotifications.find((notification) => notification.notificationType === "mention");
		expect(localizedTextString(firstMention?.message)).toContain('Mention Author mentioned you in "Mention thread".');
		expect(firstMention?.event).toMatchObject({
			type: "comment_created",
			deliveryReasons: ["mention"],
			actor: {
				username: "u/mention-author",
				displayName: lt("Mention Author"),
				shortBio: lt("Mention Author test bot."),
			},
			comment: {
				text: lt("First ping for u/mention-target."),
			},
		});

		if (!firstMention) {
			throw new Error("Expected mention notification.");
		}
		const firstLoopInput = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			recipient.id,
			[firstMention],
			[],
		);
		expect(firstLoopInput.autoProfileSeenItems).toEqual([]);
		await markBotSeenContent(
			testEnv.BICKR_D1,
			recipient.id,
			firstLoopInput.autoProfileSeenItems,
			"notification",
			"test-loop-input",
		);
		await createCommentForTest(thread.id, author.id, "Second ping for u/mention-target.");
		const allNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const secondMention = allNotifications
			.filter((notification) => notification.notificationType === "mention")
			.at(-1);
		expect(localizedTextString(secondMention?.message)).toContain("Mention Author mentioned you");
		expect(localizedTextString(secondMention?.message)).not.toContain("Short bio:");
	});

	it("detects u/ mentions for Unicode handles", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "unicode_mentions");
		const author = await createBotForTest(cookie, "автор_1");
		const recipient = await createBotForTest(cookie, "цель_2");
		const thread = await createThreadForTest(forum.id, author.id, "Unicode mention thread", "Root body.");

		await createCommentForTest(thread.id, author.id, "First ping for u/цель_2.");
		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const mention = notifications.find((notification) => notification.notificationType === "mention");
		expect(mention?.event?.actor?.username).toBe("u/автор_1");
	});

	it("fans followed public activity into one structured notification per action", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "follow-events");
		const actor = await createBotForTest(cookie, "follow-actor");
		const follower = await createBotForTest(cookie, "follow-reader");
		const target = await createBotForTest(cookie, "follow-target");
		const oldThread = await createThreadForTest(forum.id, actor.id, "Before follow", "Old root body.");
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id, actor.id);

		const targetThread = await createThreadForTest(forum.id, target.id, "Target thread", "Root target body.");
		await createThreadForTest(forum.id, actor.id, "Actor thread", "Actor root body.");
		const parent = await createCommentForTest(targetThread.id, follower.id, "Reader parent.");
		const reply = await createCommentForTest(targetThread.id, actor.id, "Actor reply.", parent.id);
		await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			botId: actor.id,
			targetType: "comment",
			targetId: parent.id,
			value: 1,
		});
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id, target.id, undefined, {
			reason: "Target posts are relevant right now.",
		});
		await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id, target.id, undefined, {
			reason: "Target posts stopped being relevant.",
		});

		const followerNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id);
		expect(followerNotifications.some((notification) => notification.sourceObjectId === oldThread.id)).toBe(false);
		const events = followerNotifications.map((notification) => notification.event).filter(Boolean);
		expect(events.map((event) => event?.type)).toEqual(
			expect.arrayContaining(["thread_created", "comment_created", "vote_cast", "profile_followed", "profile_unfollowed"]),
		);
		expect(events.every((event) => event?.deliveryReasons.includes("followed_profile_activity"))).toBe(true);
		expect(events.find((event) => event?.type === "vote_cast")).toMatchObject({
			target: { id: parent.id, author: { username: `u/${follower.handle}` } },
			vote: { targetType: "comment", commentId: parent.id, value: 1 },
		});
		expect(events.find((event) => event?.type === "profile_followed")).toMatchObject({
			target: { username: `u/${target.handle}` },
			targetProfile: { username: `u/${target.handle}` },
		});
		const followerLoopInput = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			follower.id,
			followerNotifications,
			[],
		);
		expect(followerLoopInput.input.notifications.map((event) => event.type)).not.toEqual(
			expect.arrayContaining(["profile_followed", "profile_unfollowed"]),
		);
		await markNotificationsDelivered(testEnv.BICKR_KV, testEnv.BICKR_D1, followerNotifications);
		expect(await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id)).toHaveLength(0);

		const targetNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id);
		const targetLoopInput = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			target.id,
			targetNotifications,
			[],
		);
		expect(targetLoopInput.input.notifications.map((event) => event.type)).toContain("profile_followed");
		const actorActivity = await botActivityFeedByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			forum.worldId,
			actor.handle,
		);
		expect(actorActivity.activities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "unfollow",
					bot: expect.objectContaining({ handle: target.handle }),
					reason: unspecifiedLt("Target posts stopped being relevant."),
				}),
			]),
		);
		const humanUnfollow = await testEnv.BICKR_D1.prepare(
			`SELECT body, url_path AS urlPath
			 FROM human_notifications
			 WHERE notification_type = 'bot_unfollowed'
			 ORDER BY created_at DESC
			 LIMIT 1`,
		).first<{ body: string; urlPath: string }>();
		expect(humanUnfollow?.body).toBe(`u/${actor.handle} unfollowed u/${target.handle}.\nTarget posts stopped being relevant.`);
		expect(humanUnfollow?.urlPath).toMatch(new RegExp(`^/w/patch-notes/u/${actor.handle}\\?tab=activity&activity=act_`));

		const replyNotifications = followerNotifications.filter((notification) => notification.sourceObjectId === formatCommentRef(reply.id));
		expect(replyNotifications).toHaveLength(1);
		expect(replyNotifications[0]?.event).toMatchObject({
			type: "comment_created",
			deliveryReasons: ["direct_reply", "followed_profile_activity"],
			comment: { id: reply.id, text: lt("Actor reply.") },
			replyTo: { id: parent.id, text: lt("Reader parent.") },
		});
	});

	it("rejects repeat replies to the same comment unless explicitly overridden", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "repeat-replies");
		const author = await createBotForTest(cookie, "repeat-target");
		const replier = await createBotForTest(cookie, "repeat-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Repeat reply target", "Root body.");
		const parent = await createCommentForTest(thread.id, author.id, "Target comment.");
		await createCommentForTest(thread.id, replier.id, "Earlier reply.", parent.id);

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ providerResult: unknown }>;
		}).executeTool.bind(runtime);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, replier.id);
		const signal = new AbortController().signal;

		const rejected = await executeTool(
			bot,
			"run-repeat-blocked",
			"reply_to_comment",
			{ commentId: parent.id, body: requiredLt("Different follow-up.") },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);

		expect(rejected).toBeInstanceOf(Error);
		expect((rejected as Error).message).toContain(`I already replied to comment ${parent.id} before.`);
		expect((rejected as Error).message).toContain("Earlier reply.");
		expect((rejected as Error).message).toContain("make_additional_reply_to_the_same_comment");
		let currentThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(currentThread.comments.filter((comment) => comment.parentCommentId === parent.id && comment.authorBotId === replier.id)).toHaveLength(1);

		const allowed = await executeTool(
			bot,
			"run-repeat-allowed",
			"make_additional_reply_to_the_same_comment",
			{
				commentId: parent.id,
				body: requiredLt("Intentional second reply."),
			},
			{ mode: "normal", signal },
		);
		const allowedProviderResult = allowed.providerResult as {
			ok: boolean;
			comment: { commentRef: string; threadRef: string };
		};
		expect(allowedProviderResult).toMatchObject({
			ok: true,
			comment: {
				commentRef: expect.any(String),
				threadRef: formatThreadRef(thread.id),
			},
		});
		expect(allowedProviderResult.comment).not.toHaveProperty("type");
		expect(allowedProviderResult.comment).not.toHaveProperty("parentCommentId");
		expect(JSON.stringify(allowedProviderResult)).not.toContain("Intentional second reply.");
		expect(JSON.stringify(allowedProviderResult)).not.toContain("Earlier reply.");
		currentThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(
			currentThread.comments.find((comment) =>
					comment.parentCommentId === parent.id &&
					comment.authorBotId === replier.id &&
					localizedTextString(comment.body) === "Intentional second reply."
				),
		).toBeDefined();
	});

	it("keeps the repeat-reply tool schema stable after a repeat-reply failure", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "repeat-reply-rounds");
		const author = await createBotForTest(cookie, "repeat-round-target");
		const replier = await createBotForTest(cookie, "repeat-round-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Repeat reply rounds", "Root body.");
		const parent = await createCommentForTest(thread.id, author.id, "Target comment.");
		await createCommentForTest(thread.id, replier.id, "Earlier reply.", parent.id);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, replier.id);
		const callToolSchemaStates: boolean[] = [];
		let providerCall = 0;
		const loopMemory = testLoopMessageMemory([{ role: "user", content: "Act." }]);
		const runtime = Object.assign(testRuntimeForToolExecution(), {
			...loopMemory,
			appendProviderMessages: async () => {},
			callProvider: async (
				_settings: Record<string, unknown>,
				_messages: Array<Record<string, unknown>>,
				tools: ProviderToolDefinition[],
			) => {
				callToolSchemaStates.push(additionalReplyToolPresent(tools));
				providerCall += 1;
				if (providerCall === 1) {
					return providerResponseWithToolCall("call-repeat-fail", "reply_to_comment", {
						commentId: parent.id,
						body: "Different follow-up.",
					});
				}
				if (providerCall === 2) {
					return providerResponseWithToolCall("call-read", "read_thread", { threadId: thread.id });
				}
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I have handled the repeat-reply situation." });
			},
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(1_000),
			recordInferenceSubmission: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: Awaited<ReturnType<typeof botById>>,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...bot,
					tickSettings: { ...bot.tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 5 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-repeat-rounds",
				[{ role: "user", content: "Act." }],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });
		expect(callToolSchemaStates).toEqual([true, true, true]);
	});

	it("adds failed-tool narration only after all parallel tool responses", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "parallel-failure-order");
		const author = await createBotForTest(cookie, "parallel-order-author");
		const actor = await createBotForTest(cookie, "parallel-order-actor");
		const thread = await createThreadForTest(forum.id, author.id, "Parallel tool order", "Root body.");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
		let providerCall = 0;
		let eventSeq = 0;
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const loopMemory = testLoopMessageMemory([{ role: "assistant", content: "I look around Bickr." }]);
		const runtime = Object.assign(testRuntimeForToolExecution(), {
			...loopMemory,
			appendProviderMessages: async () => {},
			appendEvent: async (runId: string, type: string, payload: unknown) => {
				eventSeq += 1;
				return {
					seq: eventSeq,
					runId,
					type,
					payload,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			callProvider: async (
				_settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
			) => {
				providerMessages.push(messages);
				providerCall += 1;
				if (providerCall === 1) {
					return providerResponseWithToolCalls([
						{ id: "call-read", name: "read_thread", args: { threadId: thread.id } },
						{
							id: "call-reply-fail",
							name: "reply_to_comment",
							args: { commentId: "missing-comment", body: "Reply attempt." },
						},
					]);
				}
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I have handled the tool failure." });
			},
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(1_000),
			recordInferenceSubmission: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: Awaited<ReturnType<typeof botById>>,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...bot,
					tickSettings: { ...bot.tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 5 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-parallel-failure-order",
				[{ role: "assistant", content: "I look around Bickr." }],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		const secondRequest = providerMessages[1] ?? [];
		const toolMessageIndexes = secondRequest
			.map((message, index) => message.role === "tool" ? index : -1)
			.filter((index) => index >= 0);
		const acknowledgementIndex = secondRequest.findIndex((message) =>
			message.role === "assistant" &&
			typeof message.content === "string" &&
			message.content.includes("The Bickr page shows an error after I try to reply")
		);
		expect(toolMessageIndexes).toHaveLength(2);
		expect(secondRequest[toolMessageIndexes[0]!]?.tool_call_id).toBe("call-read");
		expect(secondRequest[toolMessageIndexes[1]!]?.tool_call_id).toBe("call-reply-fail");
		expect(acknowledgementIndex).toBeGreaterThan(toolMessageIndexes[1]!);
		expect(String(secondRequest[acknowledgementIndex]?.content)).toContain("Read or search first, then reply using the returned comment ref.");
	});

	it("finishes a parallel tool batch before applying persistent failure handling", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "parallel-persistent-failure");
		const author = await createBotForTest(cookie, "parallel-persistent-author");
		const actor = await createBotForTest(cookie, "parallel-persistent-actor");
		const thread = await createThreadForTest(forum.id, author.id, "Parallel persistent tool order", "Root body.");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
		let providerCall = 0;
		let eventSeq = 0;
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const loopMemory = testLoopMessageMemory([{ role: "assistant", content: "I look around Bickr." }]);
		const runtime = Object.assign(testRuntimeForToolExecution(), {
			...loopMemory,
			appendProviderMessages: async () => {},
			appendEvent: async (runId: string, type: string, payload: unknown) => {
				eventSeq += 1;
				return {
					seq: eventSeq,
					runId,
					type,
					payload,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			callProvider: async (
				_settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
			) => {
				providerMessages.push(messages);
				providerCall += 1;
				if (providerCall === 1) {
					return providerResponseWithToolCalls([
						...Array.from({ length: 5 }, (_, index) => ({
							id: `call-reply-fail-${index + 1}`,
							name: "reply_to_comment",
							args: { commentId: `missing-comment-${index + 1}`, body: `Reply attempt ${index + 1}.` },
						})),
						{ id: "call-read-after-failures", name: "read_thread", args: { threadId: thread.id } },
					]);
				}
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I saw every parallel tool result." });
			},
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(1_000),
			recordInferenceSubmission: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: Awaited<ReturnType<typeof botById>>,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...bot,
					tickSettings: { ...bot.tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 10 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-parallel-persistent-failure-order",
				[{ role: "assistant", content: "I look around Bickr." }],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		const secondRequest = providerMessages[1] ?? [];
		const toolMessageIndexes = secondRequest
			.map((message, index) => message.role === "tool" ? index : -1)
			.filter((index) => index >= 0);
		const acknowledgementIndex = secondRequest.findIndex((message) =>
			message.role === "assistant" &&
			typeof message.content === "string" &&
			message.content.includes("The Bickr page shows an error after I try to reply")
		);
		expect(toolMessageIndexes).toHaveLength(6);
		expect(secondRequest[toolMessageIndexes[0]!]?.tool_call_id).toBe("call-reply-fail-1");
		expect(secondRequest[toolMessageIndexes[4]!]?.tool_call_id).toBe("call-reply-fail-5");
		expect(secondRequest[toolMessageIndexes[5]!]?.tool_call_id).toBe("call-read-after-failures");
		expect(acknowledgementIndex).toBeGreaterThan(toolMessageIndexes[5]!);
	});

		it("compacts old context from local token estimates before provider inference", async () => {
			const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const allowedPromptTokens = providerCompactionSummaryLimitsForChat(bot, [], calibration).nextCompactionTokens;
			let activeMessages: Array<Record<string, unknown>> = [
			{ role: "assistant", content: "Old history that can be compacted." },
			{ role: "assistant", content: "Current notification setup must remain." },
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerRequests: Array<Array<Record<string, unknown>>> = [];
		const callProviderForTokenProbe = vi.fn();
		const recordInferenceSubmission = vi.fn();
		const compactedRows: unknown[][] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => activeMessages,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return { seq: events.length, runId, type, payload, tokenEstimate: 0, createdAt: new Date().toISOString() };
			},
			appendLoopMessage: () => ({ seq: 99, runId: "run-budget", role: "assistant", message: {}, origin: "provider_response", tokenEstimate: 0, createdAt: new Date().toISOString() }),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
				providerRequests.push(messages);
				return providerResponseWithContent("I have enough context now.");
			},
			callProviderForTokenProbe,
				estimateProviderPromptTokens: (_settings: unknown, messages: Array<Record<string, unknown>>) =>
					providerPromptEstimateForTokens(messages.some((message) => String(message.content).includes("Old history")) ? 20_000 : 10_000),
				textTokenCalibration: () => calibration,
				compactLoopMessageRows: async (_bot: unknown, _settings: unknown, _runId: string, _signal: AbortSignal, rows: unknown[]) => {
				compactedRows.push(rows);
				activeMessages = [
					{ role: "assistant", content: "I remember the old history as a concise summary." },
					{ role: "assistant", content: "Current notification setup must remain." },
				];
			},
				compactionRowSelectionForEstimatedBudget: () => ({
					rows: activeMessages.some((message) => String(message.content).includes("Old history")) ? [loopMessageRowForTest(1, "run-old", "Old history that can be compacted.")] : [],
					overBudgetFallback: false,
				}),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission,
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
				runProviderLoop(
					bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-budget",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(callProviderForTokenProbe).not.toHaveBeenCalled();
		expect(compactedRows).toHaveLength(1);
		expect(providerRequests).toHaveLength(1);
		expect(messageListText(providerRequests[0] ?? [])).not.toContain("Old history that can be compacted.");
		expect(messageListText(providerRequests[0] ?? [])).toContain("I remember the old history");
		expect(recordInferenceSubmission).toHaveBeenCalledTimes(1);
		expect(events.map((event) => event.type)).toEqual(["provider_token_estimate", "provider_token_estimate", "provider_request"]);
			expect(events[0]?.payload).toMatchObject({
				promptTokens: 20_000,
				allowedPromptTokens,
				overBudgetTokens: 20_000 - allowedPromptTokens,
			});
		});

		it("compacts current tick messages when local prompt estimates overflow", async () => {
			const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const allowedPromptTokens = providerCompactionSummaryLimitsForChat(bot, [], calibration).nextCompactionTokens;
			let activeMessages: Array<Record<string, unknown>> = [
			{ role: "assistant", content: "Current notification setup must remain." },
			{ role: "tool", content: "Large current thread read result that overflowed the prompt." },
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerRequests: Array<Array<Record<string, unknown>>> = [];
		let compactionSelectionCalls = 0;
		const compactionMetrics: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => activeMessages,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return { seq: events.length, runId, type, payload, tokenEstimate: 0, createdAt: new Date().toISOString() };
			},
			appendLoopMessage: () => ({ seq: 99, runId: "run-current-compact", role: "assistant", message: {}, origin: "provider_response", tokenEstimate: 0, createdAt: new Date().toISOString() }),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
				providerRequests.push(messages);
				return providerResponseWithContent("The large thread read is now summarized.");
			},
			callProviderForTokenProbe: vi.fn(),
				estimateProviderPromptTokens: (_settings: unknown, messages: Array<Record<string, unknown>>) =>
					providerPromptEstimateForTokens(messageListText(messages).includes("Large current thread read result") ? 20_000 : 10_000),
				textTokenCalibration: () => calibration,
				compactLoopMessageRows: async (
				_bot: unknown,
				_settings: unknown,
				_runId: string,
				_signal: AbortSignal,
				_rows: unknown[],
				_mode: string,
				metrics: Record<string, unknown>,
			) => {
				compactionMetrics.push(metrics);
				activeMessages = [
					{ role: "assistant", content: "Current notification setup must remain." },
					{ role: "assistant", content: "I remember the large current thread read as a concise summary." },
				];
			},
				compactionRowSelectionForEstimatedBudget: () => {
					compactionSelectionCalls += 1;
					return {
						rows: activeMessages.some((message) => String(message.content).includes("Large current")) ?
							[loopMessageRowForTest(7, "run-current-compact", "Large current thread read result that overflowed the prompt.")]
						:	[],
						overBudgetFallback: false,
					};
				},
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
				runProviderLoop(
					bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-current-compact",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(compactionSelectionCalls).toBe(1);
			expect(compactionMetrics).toEqual([
				expect.objectContaining({ estimatedPromptTokens: 20_000, overBudgetTokens: 20_000 - allowedPromptTokens }),
			]);
		expect(compactionMetrics[0]).not.toHaveProperty("currentRunIncluded");
		expect(providerRequests).toHaveLength(1);
		expect(messageListText(providerRequests[0] ?? [])).not.toContain("Large current thread read result");
		expect(messageListText(providerRequests[0] ?? [])).toContain("large current thread read as a concise summary");
		expect(events.map((event) => event.type)).toEqual(["provider_token_estimate", "provider_token_estimate", "provider_request"]);
	});

	it("compacts a contiguous provider-history prefix when recurring context precedes current tool results", async () => {
		const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
		const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
		const currentRunId = "run-recurring-current-tool";
		const rows = [
			{
				...loopMessageRowForMessage(
					1,
					{ role: "assistant", content: defaultReasoningPrefill("budget-bot") },
					"synthetic_context",
				),
				run_id: "run-old-recurring-context",
			},
			{
				...loopMessageRowForMessage(
					2,
					{
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: "call-current-read",
								type: "function",
								function: { name: "read_thread", arguments: "{}" },
							},
						],
					},
				),
				run_id: currentRunId,
			},
			{
				...loopMessageRowForMessage(
					3,
					{
						role: "tool",
						tool_call_id: "call-current-read",
						content: "Large current thread read result.\n".repeat(4_000),
					},
					"tool_result",
				),
				run_id: currentRunId,
			},
			{
				...loopMessageRowForMessage(
					4,
					{ role: "user", content: runtimeErrorLoopMessageContent("Context compaction did not reduce the prompt.") },
					"runtime_error",
				),
				run_id: currentRunId,
			},
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const compactedSeqs: number[][] = [];
		let compacted = false;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessageRows: () => rows,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			botWithCurrentRuntimeBudget: async (current: BotDocument) => current,
			compactLoopMessageRows: async (
				_bot: unknown,
				_settings: unknown,
				_runId: string,
				_signal: AbortSignal,
				selected: Array<{ seq: number }>,
			) => {
				compactedSeqs.push(selected.map((row) => row.seq));
				compacted = true;
				return selected;
			},
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(compacted ? 10_000 : 20_000),
			textTokenCalibration: () => calibration,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const ensureProviderPromptWithinBudget = (BotRuntime.prototype as unknown as {
			ensureProviderPromptWithinBudget: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				signal: AbortSignal,
				providerTools: ProviderToolDefinition[],
			) => Promise<{ contextWindowTokens?: number; promptTokens: number }>;
		}).ensureProviderPromptWithinBudget.bind(runtime);

		const result = await ensureProviderPromptWithinBudget(
			bot,
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			currentRunId,
			new AbortController().signal,
			toolDefinitionsForProviderRound(),
		);

		expect(result.promptTokens).toBe(10_000);
			expect(compactedSeqs).toEqual([[1, 2, 3]]);
		expect(events.map((event) => event.type)).toEqual(["provider_token_estimate", "provider_token_estimate"]);
	});

	it("applies the current context budget during prompt budget checks", async () => {
		const staleBot = fakeBotDocument({ contextWindowTokens: 16_000 });
		const currentBot = fakeBotDocument({ contextWindowTokens: 64_000 });
		const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			botWithCurrentRuntimeBudget: async () => currentBot,
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(15_000),
			textTokenCalibration: () => calibration,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const ensureProviderPromptWithinBudget = (BotRuntime.prototype as unknown as {
			ensureProviderPromptWithinBudget: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				signal: AbortSignal,
				providerTools: ProviderToolDefinition[],
			) => Promise<{ contextWindowTokens?: number; promptTokens: number }>;
		}).ensureProviderPromptWithinBudget.bind(runtime);

		const result = await ensureProviderPromptWithinBudget(
			staleBot,
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			"run-fresh-budget",
			new AbortController().signal,
			toolDefinitionsForProviderRound(),
		);

		expect(result).toMatchObject({ contextWindowTokens: 64_000, promptTokens: 15_000 });
		expect(events[0]?.payload).toMatchObject({
			contextWindowTokens: 64_000,
			overBudgetTokens: 0,
		});
	});

	it("stops prompt-budget compaction after three unsuccessful attempts", async () => {
		const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
		const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
		const row = loopMessageRowForTest(1, "run-stuck-compaction", "Old summary that still cannot fit.");
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		let compactCalls = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [{ role: "assistant", content: "Still too large after compaction." }],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			botWithCurrentRuntimeBudget: async (current: BotDocument) => current,
			compactLoopMessageRows: async () => {
				compactCalls += 1;
				return [row];
			},
				compactionRowSelectionForEstimatedBudget: () => ({ rows: [row], overBudgetFallback: false }),
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(20_000),
			textTokenCalibration: () => calibration,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const ensureProviderPromptWithinBudget = (BotRuntime.prototype as unknown as {
			ensureProviderPromptWithinBudget: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				signal: AbortSignal,
				providerTools: ProviderToolDefinition[],
			) => Promise<unknown>;
		}).ensureProviderPromptWithinBudget.bind(runtime);

		await expect(
			ensureProviderPromptWithinBudget(
				bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-stuck-compaction",
				new AbortController().signal,
				toolDefinitionsForProviderRound(),
			),
		).rejects.toThrow("after 3 attempts");

		expect(compactCalls).toBe(3);
		expect(events.map((event) => event.type)).toEqual([
			"provider_token_estimate",
			"provider_token_estimate",
			"provider_token_estimate",
			"provider_token_estimate",
		]);
	});

		it("fails before provider inference when current context alone exceeds the estimated budget", async () => {
			const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const allowedPromptTokens = providerCompactionSummaryLimitsForChat(bot, [], calibration).nextCompactionTokens;
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const callProvider = vi.fn();
		const recordInferenceSubmission = vi.fn();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [{ role: "assistant", content: "Current setup is already too large." }],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return { seq: events.length, runId, type, payload, tokenEstimate: 0, createdAt: new Date().toISOString() };
			},
			callProvider,
				callProviderForTokenProbe: vi.fn(),
				estimateProviderPromptTokens: () => providerPromptEstimateForTokens(20_000),
				textTokenCalibration: () => calibration,
					compactionRowSelectionForEstimatedBudget: () => ({ rows: [], overBudgetFallback: false }),
			repairActiveProviderToolCallHistory: async () => [],
			recordInferenceSubmission,
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
				runProviderLoop(
					bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-current-too-large",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toThrow("Prompt context is too large");

		expect(callProvider).not.toHaveBeenCalled();
			expect(recordInferenceSubmission).not.toHaveBeenCalled();
			expect(events.map((event) => event.type)).toEqual(["provider_token_estimate"]);
			expect(events[0]?.payload).toMatchObject({ promptTokens: 20_000, allowedPromptTokens });
		});

	it("enriches reply notifications with parent-chain IDs and profile context", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "reply-context");
		const rootAuthor = await createBotForTest(cookie, "context-root");
		const recipient = await createBotForTest(cookie, "context-parent");
		const replier = await createBotForTest(cookie, "context-replier");
		const thread = await createThreadForTest(forum.id, rootAuthor.id, "Context thread", "Root context body.");
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, rootAuthor.id);
		const parent = await createCommentForTest(thread.id, recipient.id, "Parent comment.");
		const child = await createCommentForTest(thread.id, replier.id, "Child reply.", parent.id);

		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const reply = notifications.find((notification) => notification.notificationType === "reply");
		if (!reply) {
			throw new Error("Expected reply notification.");
		}
		expect(localizedTextString(reply.message)).toContain('Context Replier replied to you in "Context thread".');

		const built = await buildRuntimeLoopInput(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, [reply], []);
		const loopNotification = built.input.notifications[0];
		expect(loopNotification).toMatchObject({
			sourceObjectId: formatCommentRef(child.id),
			type: "comment_created",
			thread: { id: thread.id, title: lt("Context thread") },
			comment: { id: child.id, threadId: thread.id, parentCommentId: parent.id, text: lt("Child reply.") },
			replyTo: { id: parent.id, threadId: thread.id, text: lt("Parent comment.") },
		});
		expect(built.autoProfileSeenItems).toEqual([]);

		const legacyBuilt = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			recipient.id,
			[{ ...reply, event: undefined }],
			[],
		);
		expect(legacyBuilt.input.notifications[0]).toMatchObject({
			sourceObjectId: formatCommentRef(child.id),
			type: "comment_created",
			actor: { username: `u/${replier.handle}`, displayName: replier.displayName },
			world: { handle: "w/patch-notes" },
			forum: { handle: `f/${forum.handle}` },
			thread: { id: thread.id, title: lt("Context thread") },
			comment: { id: child.id, threadId: thread.id, parentCommentId: parent.id, text: lt("Child reply.") },
		});

		const followup = await createCommentForTest(
			loopNotification?.thread?.id ?? "",
			recipient.id,
			"Replying with supplied IDs.",
			loopNotification?.comment?.id,
		);
		expect(followup.id).toBeTruthy();

		await markBotSeenContent(
			testEnv.BICKR_D1,
			recipient.id,
			built.autoProfileSeenItems,
			"notification",
			"test-loop-input",
		);
		await createCommentForTest(thread.id, replier.id, "Second child reply.", parent.id);
		const nextReply = (await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id))
			.filter((notification) => notification.notificationType === "reply")
			.at(-1);
		expect(localizedTextString(nextReply?.message)).toContain("Context Replier replied to you");
		expect(localizedTextString(nextReply?.message)).not.toContain("Short bio:");
		expect(localizedTextString(nextReply?.message)).not.toContain("Follow status:");
		if (!nextReply) {
			throw new Error("Expected second reply notification.");
		}
		const nextBuilt = await buildRuntimeLoopInput(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, [nextReply], []);
		const nextContext = JSON.stringify(nextBuilt.input.notifications[0] ?? {});
		expect(nextContext).not.toContain("Context Root test bot.");
		expect(nextBuilt.autoProfileSeenItems).toEqual([]);
	});

	it("builds spotlight previews server-side and records successful injections", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const botOne = await createBotForTest(cookie, "spot-one", { enabled: true });
		const botTwo = await createBotForTest(cookie, "spot-two", { enabled: true });
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "other-world", name: "Other World", description: "Elsewhere" },
					cookie,
				),
			),
		);
		const otherWorldBotResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/other-world/bots",
					"POST",
					{
						handle: "elsewhere",
						displayName: "Elsewhere",
						shortBio: "Lives in another world.",
						prompt: "Stay elsewhere.",
					},
					cookie,
				),
				{ worldHandle: "other-world" },
			),
		);
		const otherWorldBot = ((await otherWorldBotResponse.json()) as { data: { bot: BotBody } }).data.bot;
		const thread = await createThreadForTest(forum.id, botOne.id, "Worth attention", "Root context.");
		const parent = await createCommentForTest(thread.id, botTwo.id, "Parent context.");
		const child = await createCommentForTest(thread.id, botOne.id, "Deep child comment.", parent.id);
		const unrelated = await createCommentForTest(thread.id, botTwo.id, "Unrelated seen branch.");
		const now = new Date().toISOString();

		for (const comment of [child, unrelated]) {
			await testEnv.BICKR_D1.prepare(
				`INSERT INTO bot_seen_content (
					bot_id, object_type, object_id, seen_via, first_seen_at, last_seen_at, source_id
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(botOne.id, "comment", comment.id, "test", now, now, "seed")
				.run();
		}

		const threadPreviewResponse = await spotlightPreview(
			contextFor<typeof spotlightPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/preview",
					"POST",
					{ targetType: "threads", threadIds: [thread.id], botIds: [botOne.id, botTwo.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		const threadPreview = (await threadPreviewResponse.json()) as SpotlightPreviewPayload;
		const botOneThreadPreview = threadPreview.data.preview.botPreviews.find((item) => item.bot.id === botOne.id);
		const botTwoThreadPreview = threadPreview.data.preview.botPreviews.find((item) => item.bot.id === botTwo.id);
		expect(botOneThreadPreview?.included).toMatchObject({ commentCount: 2, excludedSeenCount: 2 });
		expect(botTwoThreadPreview?.included.commentCount).toBe(4);
		expect(botOneThreadPreview).not.toHaveProperty("content");
		expect(botOneThreadPreview).not.toHaveProperty("injectedText");

		const wrongWorldPreview = await spotlightPreview(
			contextFor<typeof spotlightPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/preview",
					"POST",
					{ targetType: "threads", threadIds: [thread.id], botIds: [otherWorldBot.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		expect(wrongWorldPreview.status).toBe(403);

		const pausedBot = await createBotForTest(cookie, "spot-paused");
		const pausedPreview = await spotlightPreview(
			contextFor<typeof spotlightPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/preview",
					"POST",
					{ targetType: "threads", threadIds: [thread.id], botIds: [pausedBot.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		expect(pausedPreview.status).toBe(400);

		const commentPreviewResponse = await spotlightPreview(
			contextFor<typeof spotlightPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/preview",
					"POST",
					{
						targetType: "comments",
						threadId: thread.id,
						commentIds: [child.id],
						botIds: [botOne.id],
						focusText: "Look at the parent chain.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		const commentPreview = (await commentPreviewResponse.json()) as SpotlightPreviewPayload;
		const botOneCommentPreview = commentPreview.data.preview.botPreviews[0];
		expect(botOneCommentPreview?.included).toMatchObject({ commentCount: 3, excludedSeenCount: 0 });
		expect(botOneCommentPreview).not.toHaveProperty("content");
		expect(botOneCommentPreview).not.toHaveProperty("injectedText");

		const threadInjectedTexts: string[] = [];
		const threadSendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "threads",
						threadIds: [thread.id],
						botIds: [botOne.id],
						autoStartTick: false,
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							const body = await request.json() as { text?: string };
							threadInjectedTexts.push(body.text ?? "");
							return Response.json({ ok: true, data: { injectionId: "inj-thread" } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const threadSendPayload = (await threadSendResponse.json()) as SpotlightSendPayload;
		expect(threadSendPayload.data.preview.botPreviews[0]?.included).toMatchObject({ commentCount: 2, excludedSeenCount: 2 });
		const threadInjectedContext = JSON.parse(threadInjectedTexts[0] ?? "") as { content: Array<Record<string, unknown>> };
		expect(threadInjectedContext.content.map((item) => item.id)).toEqual([thread.rootCommentId, parent.id]);
		expect(threadInjectedTexts[0]).toContain("Spot Two test bot.");
		expect(threadInjectedTexts[0]).not.toMatch(/\bowner\b/i);

		const runtimePaths: string[] = [];
		const commentInjectedTexts: string[] = [];
		const sendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "comments",
						threadId: thread.id,
						commentIds: [child.id],
						botIds: [botOne.id],
						focusText: "Please consider replying.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							runtimePaths.push(new URL(request.url).pathname);
							if (new URL(request.url).pathname.endsWith("/inject")) {
								const body = await request.json() as { text?: string };
								commentInjectedTexts.push(body.text ?? "");
								return Response.json({ ok: true, data: { injectionId: "inj-test" } });
							}
							return Response.json({ ok: true, data: { run: { runId: "run-test", status: "started" } } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const sendPayload = (await sendResponse.json()) as SpotlightSendPayload;
		expect(sendPayload.data.deliveries).toMatchObject([
			{ botId: botOne.id, ok: true, injectionId: "inj-test", tickStatus: "started" },
		]);
		expect(runtimePaths).toEqual(
			expect.arrayContaining([
				`/bots/${botOne.id}/inject`,
				`/bots/${botOne.id}/tick`,
			]),
		);
		const commentInjectedContext = JSON.parse(commentInjectedTexts[0] ?? "") as {
			kind: string;
			targetType: string;
			focus: string;
			content: Array<Record<string, unknown>>;
		};
		expect(commentInjectedContext).toMatchObject({
			kind: "spotlight_context",
			targetType: "comments",
			focus: "Please consider replying.",
		});
		expect(commentInjectedContext.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: thread.rootCommentId, commentId: thread.rootCommentId, threadId: thread.id, type: "comment", ancestorOnly: true }),
				expect.objectContaining({ id: parent.id, commentId: parent.id, threadId: thread.id, ancestorOnly: true }),
				expect.objectContaining({ id: child.id, commentId: child.id, threadId: thread.id, parentCommentId: parent.id, "My focus is on this comment": true }),
			]),
		);

		const busyRuntimePaths: string[] = [];
		const busySendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "threads",
						threadIds: [thread.id],
						botIds: [botTwo.id],
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							busyRuntimePaths.push(new URL(request.url).pathname);
							if (new URL(request.url).pathname.endsWith("/inject")) {
								return Response.json({ ok: true, data: { injectionId: "inj-busy" } });
							}
							return Response.json({ ok: true, data: { run: { runId: "run-current", status: "queued" } } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const busySendPayload = (await busySendResponse.json()) as SpotlightSendPayload;
		expect(busySendPayload.data.deliveries).toMatchObject([
			{ botId: botTwo.id, ok: true, injectionId: "inj-busy", tickStatus: "queued" },
		]);
		expect(busyRuntimePaths).toEqual(
			expect.arrayContaining([
				`/bots/${botTwo.id}/inject`,
				`/bots/${botTwo.id}/tick`,
			]),
		);

		const queuedRuntimePaths: string[] = [];
		const queuedSendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "threads",
						threadIds: [thread.id],
						botIds: [botTwo.id],
						autoStartTick: false,
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							queuedRuntimePaths.push(new URL(request.url).pathname);
							return Response.json({ ok: true, data: { injectionId: "inj-queued" } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const queuedSendPayload = (await queuedSendResponse.json()) as SpotlightSendPayload;
		expect(queuedSendPayload.data.deliveries).toMatchObject([
			{ botId: botTwo.id, ok: true, injectionId: "inj-queued", tickStatus: "queued" },
		]);
		expect(queuedRuntimePaths).toEqual([`/bots/${botTwo.id}/inject`]);

		const delivery = await testEnv.BICKR_D1.prepare(
			`SELECT status, target_type AS targetType, focus_text AS focusText
			 FROM spotlight_deliveries
			 WHERE bot_id = ? AND target_type = 'comments'`,
		)
			.bind(botOne.id)
			.first<{ status: string; targetType: string; focusText: string }>();
		expect(delivery).toMatchObject({
			status: "sent",
			targetType: "comments",
			focusText: "Please consider replying.",
		});

		const seen = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'comment' AND object_id = ?`,
		)
			.bind(botOne.id, child.id)
			.first<{ seenVia: string }>();
		expect(seen).toEqual({ seenVia: "spotlight" });

		const seenProfile = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'bot' AND object_id = ?`,
		)
			.bind(botOne.id, botTwo.id)
			.first<{ seenVia: string }>();
		expect(seenProfile).toEqual({ seenVia: "spotlight" });

		const freshThread = await readThread(testEnv.BICKR_KV, thread.id);
		const staleThread = {
			...freshThread,
			comments: freshThread.comments.filter((comment) => comment.id !== child.id),
		};
		const fallbackGet = testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV);
		let staleThreadReads = 0;
		const flakyKv = new Proxy(testEnv.BICKR_KV, {
			get(target, property, receiver) {
				if (property === "get") {
					return (async (key: string, options?: { type?: string }) => {
						if (key === kvKeys.thread(thread.id) && options?.type === "json" && staleThreadReads === 0) {
							staleThreadReads += 1;
							return staleThread;
						}
						return fallbackGet(key, options as never) as never;
					}) as KVNamespace["get"];
				}
				return Reflect.get(target, property, receiver) as unknown;
			},
		}) as KVNamespace;
		const retryInjectedTexts: string[] = [];
		const retrySendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "comments",
						threadId: thread.id,
						commentIds: [child.id],
						botIds: [botTwo.id],
						autoStartTick: false,
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					BICKR_KV: flakyKv,
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							const body = await request.json() as { text?: string };
							retryInjectedTexts.push(body.text ?? "");
							return Response.json({ ok: true, data: { injectionId: "inj-retry" } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const retrySendPayload = (await retrySendResponse.json()) as SpotlightSendPayload;
		expect(retrySendResponse.status).toBe(200);
		expect(staleThreadReads).toBe(1);
		expect(retryInjectedTexts).toHaveLength(1);
		expect(retrySendPayload.data.deliveries).toMatchObject([
			{ botId: botTwo.id, ok: true, injectionId: "inj-retry", tickStatus: "queued" },
		]);

		const pausedSendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "threads",
						threadIds: [thread.id],
						botIds: [pausedBot.id],
						autoStartTick: false,
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		expect(pausedSendResponse.status).toBe(400);
	});

	it("annotates standard human notifications for spotlight-created threads and comments", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-notices");
		const bot = await createBotForTest(cookie, "spotlight-writer");
		const botDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}

		const spotlightId = "spt_standard_notifications";
		const insertDelivery = async () => {
			await testEnv.BICKR_D1.prepare(
				`INSERT OR REPLACE INTO spotlight_deliveries (
					spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
					target_ids_json, focus_text, injected_text, status, error_message, created_at
				) VALUES (?, ?, ?, ?, ?, NULL, 'threads', '[]', NULL, 'spotlight', 'sent', NULL, ?)`,
			)
				.bind(spotlightId, user.id, bot.id, forum.worldId, forum.id, new Date().toISOString())
				.run();
		};

		await insertDelivery();
		const thread = await createThreadForTest(forum.id, bot.id, "Spotlight post", "A spotlight-rooted post.");
		const threadDocument = await readThread(testEnv.BICKR_KV, thread.id);
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-post",
			toolName: "create_thread",
			args: {},
			result: { thread: threadDocument },
			now: new Date().toISOString(),
		});

		const threadNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND event_key = ?
			 ORDER BY created_at ASC`,
		)
			.bind(user.id, `thread_created:${thread.id}`)
			.all<{ notificationType: string; title: string; spotlightId: string | null }>();
		expect(threadNotifications.results).toHaveLength(1);
		expect(threadNotifications.results?.[0]).toMatchObject({
			notificationType: "thread_created",
			title: "Spotlight Writer created a thread in f/spotlight-notices",
			spotlightId,
		});

		const comment = await createCommentForTest(thread.id, bot.id, "A spotlight-rooted reply.");
		const commentedThread = await readThread(testEnv.BICKR_KV, thread.id);
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-comment",
			toolName: "reply_to_comment",
			args: {},
			result: { thread: commentedThread },
			now: new Date().toISOString(),
		});

		const commentNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND event_key = ?
			 ORDER BY created_at ASC`,
		)
			.bind(user.id, `comment_created:${comment.id}`)
			.all<{ notificationType: string; title: string; spotlightId: string | null }>();
		expect(commentNotifications.results).toHaveLength(1);
		expect(commentNotifications.results?.[0]).toMatchObject({
			notificationType: "comment_created",
			title: `Spotlight Writer replied in "Spotlight post"`,
			spotlightId,
		});

		const voteNow = new Date().toISOString();
		const votedThread = await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			botId: bot.id,
				targetType: "comment",
				targetId: comment.id,
				value: 1,
				reason: requiredLt("This spotlighted reply is worth boosting."),
			}, voteNow);
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-vote",
			toolName: "vote",
			args: { reason: "This spotlighted reply is worth boosting." },
			result: [{ commentId: comment.id, value: 1, thread: votedThread }],
			now: voteNow,
		});

		const voteNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND target_id = ? AND notification_type = 'vote_cast'
			 ORDER BY created_at ASC`,
		)
			.bind(user.id, comment.id)
			.all<{ notificationType: string; title: string; body: string; spotlightId: string | null }>();
		expect(voteNotifications.results).toHaveLength(1);
		expect(voteNotifications.results?.[0]).toMatchObject({
			notificationType: "vote_cast",
			title: "Spotlight Writer upvoted a comment in",
			body: "Spotlight post\nThis spotlighted reply is worth boosting.",
			spotlightId,
		});

		const firstTarget = await createBotForTest(cookie, "spotlight-target-one");
		const secondTarget = await createBotForTest(cookie, "spotlight-target-two");
		const firstTargetDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, firstTarget.id);
		const secondTargetDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, secondTarget.id);
		const firstFollow = await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, firstTarget.id, undefined, {
			reason: "First target has useful spotlight context.",
		});
		const secondFollow = await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, secondTarget.id, undefined, {
			reason: "Second target has useful spotlight context.",
		});
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-follow",
			toolName: "follow_profile",
			args: {
				targets: [
					{ username: firstTarget.handle, reason: "First target has useful spotlight context." },
					{ username: secondTarget.handle, reason: "Second target has useful spotlight context." },
				],
			},
			result: [
				{ ...firstFollow, reason: "First target has useful spotlight context.", profile: firstTargetDocument },
				{ ...secondFollow, reason: "Second target has useful spotlight context.", profile: secondTargetDocument },
			],
			now: new Date().toISOString(),
		});
		const followNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'bot_followed' AND target_id IN (?, ?)
			 ORDER BY target_id ASC`,
		)
			.bind(user.id, firstTarget.id, secondTarget.id)
			.all<{ notificationType: string; title: string; body: string; spotlightId: string | null }>();
		expect(followNotifications.results).toHaveLength(2);
		expect(followNotifications.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					notificationType: "bot_followed",
					title: "Spotlight Writer followed Spotlight Target One",
					body: "u/spotlight-writer followed u/spotlight-target-one.\nFirst target has useful spotlight context.",
					spotlightId,
				}),
				expect.objectContaining({
					notificationType: "bot_followed",
					title: "Spotlight Writer followed Spotlight Target Two",
					body: "u/spotlight-writer followed u/spotlight-target-two.\nSecond target has useful spotlight context.",
					spotlightId,
				}),
			]),
		);

		const unfollowNow = new Date().toISOString();
		const firstUnfollow = await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, firstTarget.id, unfollowNow, {
			reason: "First target is no longer relevant after the spotlight.",
		});
		const secondUnfollow = await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, secondTarget.id, unfollowNow, {
			reason: "Second target is no longer relevant after the spotlight.",
		});
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-unfollow",
			toolName: "unfollow_profile",
			args: {
				targets: [
					{ username: firstTarget.handle, reason: "First target is no longer relevant after the spotlight." },
					{ username: secondTarget.handle, reason: "Second target is no longer relevant after the spotlight." },
				],
			},
			result: [
				{ ...firstUnfollow, reason: "First target is no longer relevant after the spotlight.", profile: firstTargetDocument },
				{ ...secondUnfollow, reason: "Second target is no longer relevant after the spotlight.", profile: secondTargetDocument },
			],
			now: unfollowNow,
		});
		const unfollowNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'bot_unfollowed' AND target_id IN (?, ?)
			 ORDER BY target_id ASC`,
		)
			.bind(user.id, firstTarget.id, secondTarget.id)
			.all<{ notificationType: string; title: string; body: string; spotlightId: string | null }>();
		expect(unfollowNotifications.results).toHaveLength(2);
		expect(unfollowNotifications.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					notificationType: "bot_unfollowed",
					title: "Spotlight Writer unfollowed Spotlight Target One",
					body: "u/spotlight-writer unfollowed u/spotlight-target-one.\nFirst target is no longer relevant after the spotlight.",
					spotlightId,
				}),
				expect.objectContaining({
					notificationType: "bot_unfollowed",
					title: "Spotlight Writer unfollowed Spotlight Target Two",
					body: "u/spotlight-writer unfollowed u/spotlight-target-two.\nSecond target is no longer relevant after the spotlight.",
					spotlightId,
				}),
			]),
		);

		const specialNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'spotlight_action'
			   AND spotlight_id = ?`,
		)
			.bind(user.id, spotlightId)
			.first<{ count: number }>();
		expect(specialNotifications?.count).toBe(0);
	});

	it("records a spotlight no-reaction notification for spotlight ticks with no spotlight-targeted action", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-no-reaction");
		const bot = await createBotForTest(cookie, "spotlight-observer");
		const botDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}

		const spotlightId = "spt_no_reaction";
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO spotlight_deliveries (
				spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
				target_ids_json, focus_text, injected_text, status, error_message, created_at
			) VALUES (?, ?, ?, ?, ?, NULL, 'threads', '[]', NULL, 'spotlight', 'sent', NULL, ?)`,
		)
			.bind(spotlightId, user.id, bot.id, forum.worldId, forum.id, new Date().toISOString())
			.run();

		await recordSpotlightNoReactionHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-log-off",
			now: new Date().toISOString(),
		});

		const noReaction = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, spotlight_label AS spotlightLabel
			 FROM human_notifications
			 WHERE user_id = ? AND spotlight_id = ?
			 ORDER BY created_at ASC`,
		)
			.bind(user.id, spotlightId)
			.all<{ notificationType: string; title: string; body: string; spotlightLabel: string | null }>();
		expect(noReaction.results).toHaveLength(1);
		expect(noReaction.results?.[0]).toMatchObject({
			notificationType: "spotlight_no_reaction",
			title: "Spotlight Observer did not react to the spotlight",
			body: "u/spotlight-observer reviewed the spotlight but did not act on the spotlighted content or its authors.",
			spotlightLabel: "no public reaction",
		});

		const thread = await createThreadForTest(forum.id, bot.id, "Spotlight visible action", "This is public.");
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-post",
			toolName: "create_thread",
			args: {},
			result: { thread: await readThread(testEnv.BICKR_KV, thread.id) },
			now: new Date().toISOString(),
		});
		const noReactionCount = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND spotlight_id = ? AND notification_type = 'spotlight_no_reaction'`,
		)
			.bind(user.id, spotlightId)
			.first<{ count: number }>();
		expect(noReactionCount?.count).toBe(1);
	});

	it("records spotlight no-reaction at successful tick completion only when no spotlight mutation occurred", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-tick-reactions");
		const bot = await createBotForTest(cookie, "tick-reaction-observer");
		const author = await createBotForTest(cookie, "tick-reaction-author");
		const thread = await createThreadForTest(forum.id, author.id, "Spotlight tick context", "Root spotlight body.");
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const contextText = JSON.stringify({
			kind: "spotlight_context",
			world: { id: forum.worldId, handle: "w/patch-notes" },
			forum: { id: forum.id, handle: `f/${forum.handle}` },
			targetType: "threads",
			threads: [{ id: thread.id, threadId: thread.id, title: "Spotlight tick context", rootCommentId: thread.rootCommentId }],
			content: [{
				type: "comment",
				id: thread.rootCommentId,
				commentId: thread.rootCommentId,
				threadId: thread.id,
				authorBotId: author.id,
				authorHandle: author.handle,
				authorDisplayName: author.displayName,
				body: "Root spotlight body.",
				createdAt: new Date().toISOString(),
				target: true,
			}],
		});
		const runSpotlightTick = async (
			spotlightId: string,
			outcome: { logOffCalled: boolean; spotlightMutationCount: number; toolCallCount: number },
		) => {
			await testEnv.BICKR_D1.prepare(
				`INSERT INTO spotlight_deliveries (
					spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
					target_ids_json, focus_text, injected_text, status, error_message, created_at
				) VALUES (?, ?, ?, ?, ?, ?, 'threads', ?, NULL, 'spotlight', 'sent', NULL, ?)`,
			)
				.bind(
					spotlightId,
					user.id,
					bot.id,
					forum.worldId,
					forum.id,
					thread.id,
					JSON.stringify([thread.id]),
					new Date().toISOString(),
				)
				.run();
			let seq = 0;
			const messages = [] as unknown as BotInferenceSubmissionMessage[] & { deliveredNotificationIds: Set<string> };
			messages.deliveredNotificationIds = new Set();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeAbortController: null,
				activeRunId: null,
				env: testEnv,
				appendEvent: async (runId: string, type: string, payload: unknown) => {
					seq += 1;
					return runtimeEvent(seq, runId, type as BotRuntimeEvent["type"], payload);
				},
				botWithEffectivePostingSettings: async (document: BotDocument) => document,
				buildMessages: async () => messages,
				clearStopRequest: () => {},
				compactIfNeeded: async () => {},
				consumeInjections: () => [contextText],
				effectiveProviderSettings: () => ({
					apiKey: "test-key",
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test-model",
					temperature: 0.2,
					toolCalls: "at_will" as const,
				}),
				runProviderLoop: async () => outcome,
				setRuntimeIndex: async () => null,
				startQueuedSpotlightTick: () => {},
				status: async () => ({ botId: bot.id, enabled: true, status: "idle" as const }),
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const runTick = (BotRuntime.prototype as unknown as {
				runTick: (
					botId: string,
					trigger: "spotlight",
					options: { mode: "spotlight"; spotlightId: string; injectionIds: string[] },
				) => Promise<{ status: string }>;
			}).runTick.bind(runtime);
			await expect(
				runTick(bot.id, "spotlight", {
					mode: "spotlight",
					spotlightId,
					injectionIds: [`inj-${spotlightId}`],
				}),
			).resolves.toMatchObject({ status: "completed" });
		};

		await runSpotlightTick("spt_tick_no_reaction", {
			logOffCalled: false,
			spotlightMutationCount: 0,
			toolCallCount: 2,
		});
		await runSpotlightTick("spt_tick_reacted", {
			logOffCalled: false,
			spotlightMutationCount: 1,
			toolCallCount: 1,
		});

		const noReactionRows = await testEnv.BICKR_D1.prepare(
			`SELECT spotlight_id AS spotlightId, notification_type AS notificationType
			 FROM human_notifications
			 WHERE user_id = ? AND spotlight_id IN (?, ?)
			 ORDER BY spotlight_id ASC`,
		)
			.bind(user.id, "spt_tick_no_reaction", "spt_tick_reacted")
			.all<{ spotlightId: string; notificationType: string }>();
		expect(noReactionRows.results).toEqual([
			{
				spotlightId: "spt_tick_no_reaction",
				notificationType: "spotlight_no_reaction",
			},
		]);
	});

	it("uploads participant avatars into R2 and exposes avatar URLs through indexes", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatars");
		const bot = await createBotForTest(cookie, "avatar-owner");
		const r2 = fakeR2Bucket();
		const sourceUrl = "https://images.example/avatar.png";
		const sourceBytes = pngAvatarBytes();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe(sourceUrl);
				return new Response(sourceBytes, {
					headers: {
						"content-type": "image/png",
						"content-length": String(sourceBytes.byteLength),
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let avatarUrl = "";
		try {
			const response = await uploadBotAvatar(
				contextFor<typeof uploadBotAvatar>(
					jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar`, "PUT", { url: sourceUrl }, cookie),
					{ botId: bot.id },
					{
						BICKR_R2: r2.bucket,
						BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					},
				),
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { bot: BotBody } };
			avatarUrl = body.data.bot.avatarUrl ?? "";
			expect(avatarUrl).toMatch(/^https:\/\/assets-test\.bickr\.social\/worlds\/.+\/bots\/.+\/avatars\/.+\.png$/);
			expect(r2.objects.size).toBe(1);
			const stored = [...r2.objects.values()][0];
			expect(stored?.bytes).toEqual(sourceBytes);
			expect(stored?.httpMetadata?.contentType).toBe("image/png");
			expect(stored?.httpMetadata?.cacheControl).toBe("public, max-age=31536000, immutable");
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM bots_index WHERE bot_id = ?`)
			.bind(bot.id)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(indexed?.avatarUrl).toBe(avatarUrl);
		expect(indexed?.avatarCrop).toBeNull();

		const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(storedBot.avatar).toMatchObject({
			url: avatarUrl,
			contentType: "image/png",
			width: 1,
			height: 1,
			source: {
				type: "remote_url",
				sourceUrl,
			},
		});
		expect(storedBot.avatar?.crop).toBeUndefined();

		await createThreadForTest(forum.id, bot.id, "Avatar index thread", "Avatar summary body.");
		const threadsResponse = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/${forum.handle}/threads`),
				{ worldHandle: "patch-notes", forumHandle: forum.handle },
			),
		);
		const threadsBody = (await threadsResponse.json()) as {
			data: { threads: Array<{ authorAvatarUrl?: string }> };
		};
		expect(threadsBody.data.threads[0]?.authorAvatarUrl).toBe(avatarUrl);
	});

	it("saves participant avatar crop metadata and clears it on replacement upload", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-crops");
		const bot = await createBotForTest(cookie, "avatar-cropper");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const publicBaseUrl = "https://assets-test.bickr.social";
		const avatar = await storeAvatarImage(r2.bucket, {
			botId: bot.id,
			worldId: bot.homeWorldId,
			bytes: svgAvatarBytes(),
			contentType: "image/svg+xml",
			publicBaseUrl,
		});
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, avatar);

		const crop: AvatarCrop = { x: 4, y: 8, size: 16, imageWidth: 24, imageHeight: 32 };
		const response = await updateBotAvatarCrop(
			contextFor<typeof updateBotAvatarCrop>(
				jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar/crop`, "PATCH", { crop }, cookie),
				{ botId: bot.id },
			),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		const body = (await response.json()) as { data: { bot: BotBody } };
		expect(body.data.bot.avatarCrop).toEqual(crop);
		expect(body.data.bot.avatar?.crop).toEqual(crop);

		const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(storedBot.avatar?.crop).toEqual(crop);
		const publicProfile = await botPublicProfileByHandle(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.homeWorldId, bot.handle);
		expect(publicProfile.avatarCrop).toEqual(crop);
		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_crop AS avatarCrop FROM bots_index WHERE bot_id = ?`)
			.bind(bot.id)
			.first<{ avatarCrop: string | null }>();
		expect(JSON.parse(indexed?.avatarCrop ?? "{}")).toEqual(crop);

		await createThreadForTest(forum.id, bot.id, "Cropped avatar index thread", "Avatar crop summary body.");
		const threadsResponse = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/${forum.handle}/threads`),
				{ worldHandle: "patch-notes", forumHandle: forum.handle },
			),
		);
		const threadsBody = (await threadsResponse.json()) as {
			data: { threads: Array<{ authorAvatarCrop?: AvatarCrop }> };
		};
		expect(threadsBody.data.threads[0]?.authorAvatarCrop).toEqual(crop);

		const otherCookie = await authCookieFor({ subject: "222", login: "not-owner", displayName: "Not Owner" });
		const forbidden = await updateBotAvatarCrop(
			contextFor<typeof updateBotAvatarCrop>(
				jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar/crop`, "PATCH", { crop }, otherCookie),
				{ botId: bot.id },
			),
		);
		expect(forbidden.status).toBe(403);

		const invalid = await updateBotAvatarCrop(
			contextFor<typeof updateBotAvatarCrop>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}/avatar/crop`,
					"PATCH",
					{ crop: { x: 20, y: 8, size: 16, imageWidth: 24, imageHeight: 32 } },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(invalid.status).toBe(400);

		const sourceUrl = "https://images.example/replacement.png";
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", vi.fn(async () =>
			new Response(pngAvatarBytes(), {
				headers: {
					"content-type": "image/png",
					"content-length": String(pngAvatarBytes().byteLength),
				},
			}),
		));
		try {
			const uploadResponse = await uploadBotAvatar(
				contextFor<typeof uploadBotAvatar>(
					jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar`, "PUT", { url: sourceUrl }, cookie),
					{ botId: bot.id },
					{
						BICKR_R2: r2.bucket,
						BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
					},
				),
			);
			expect(uploadResponse.status).toBe(200);
			const uploadBody = (await uploadResponse.json()) as { data: { bot: BotBody } };
			expect(uploadBody.data.bot.avatarCrop).toBeUndefined();
			expect(uploadBody.data.bot.avatar?.crop).toBeUndefined();
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
		const replacedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(replacedBot.avatar?.crop).toBeUndefined();
		const replacedIndexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_crop AS avatarCrop FROM bots_index WHERE bot_id = ?`)
			.bind(bot.id)
			.first<{ avatarCrop: string | null }>();
		expect(replacedIndexed?.avatarCrop).toBeNull();
	});

	it("rejects avatar crop metadata when the participant has no avatar", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-cropless");
		const response = await updateBotAvatarCrop(
			contextFor<typeof updateBotAvatarCrop>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}/avatar/crop`,
					"PATCH",
					{ crop: { x: 0, y: 0, size: 1, imageWidth: 1, imageHeight: 1 } },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(response.status).toBe(400);
	});

	it("uploads human user avatars into R2 and exposes avatar URLs through indexes", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const sourceUrl = "https://images.example/human-avatar.png";
		const sourceBytes = pngAvatarBytes();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe(sourceUrl);
				return new Response(sourceBytes, {
					headers: {
						"content-type": "image/png",
						"content-length": String(sourceBytes.byteLength),
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let avatarUrl = "";
		try {
			const response = await uploadUserAvatarRoute(
				contextFor<typeof uploadUserAvatarRoute>(
					jsonRequest("http://example.com/api/me/avatar", "PUT", { url: sourceUrl }, cookie),
					{},
					{
						BICKR_R2: r2.bucket,
						BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					},
				),
			);
			expect(response.status, await response.clone().text()).toBe(200);
			const body = (await response.json()) as { data: { profile: UserProfile } };
			avatarUrl = body.data.profile.avatarUrl ?? "";
			expect(avatarUrl).toMatch(new RegExp(`^https://assets-test\\.bickr\\.social/users/${userId}/avatars/.+\\.png$`));
			expect(body.data.profile.avatar?.url).toBe(avatarUrl);
			expect(body.data.profile.avatar?.crop).toBeUndefined();
			expect(r2.objects.size).toBe(1);
			const stored = [...r2.objects.values()][0];
			expect(stored?.bytes).toEqual(sourceBytes);
			expect(stored?.httpMetadata?.contentType).toBe("image/png");
			expect(stored?.httpMetadata?.cacheControl).toBe("public, max-age=31536000, immutable");
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM users_index WHERE user_id = ?`)
			.bind(userId)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(indexed?.avatarUrl).toBe(avatarUrl);
		expect(indexed?.avatarCrop).toBeNull();

		const storedUser = await userById(testEnv.BICKR_KV, userId);
		expect(storedUser.avatar).toMatchObject({
			url: avatarUrl,
			contentType: "image/png",
			width: 1,
			height: 1,
			source: {
				type: "remote_url",
				sourceUrl,
			},
		});

		const publicResponse = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/octocat", { headers: { cookie } }),
				{ humanHandle: "octocat" },
			),
		);
		expect(publicResponse.status).toBe(200);
		const publicBody = (await publicResponse.json()) as { data: { profile: HumanProfile } };
		expect(publicBody.data.profile.user.avatarUrl).toBe(avatarUrl);
		expect(publicBody.data.profile.user.avatarCrop).toBeUndefined();
	});

	it("saves human user avatar crop metadata and clears it on delete", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const publicBaseUrl = "https://assets-test.bickr.social";
		const avatar = await storeAvatarImage(r2.bucket, {
			target: "user",
			userId,
			bytes: svgAvatarBytes(),
			contentType: "image/svg+xml",
			publicBaseUrl,
		});
		await updateUserAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, userId, avatar);

		const crop: AvatarCrop = { x: 4, y: 8, size: 16, imageWidth: 24, imageHeight: 32 };
		const cropResponse = await updateUserAvatarCropRoute(
			contextFor<typeof updateUserAvatarCropRoute>(
				jsonRequest("http://example.com/api/me/avatar/crop", "PATCH", { crop }, cookie),
			),
		);
		expect(cropResponse.status, await cropResponse.clone().text()).toBe(200);
		const cropBody = (await cropResponse.json()) as { data: { profile: UserProfile } };
		expect(cropBody.data.profile.avatarUrl).toBe(avatar.url);
		expect(cropBody.data.profile.avatarCrop).toEqual(crop);
		expect(cropBody.data.profile.avatar?.crop).toEqual(crop);

		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM users_index WHERE user_id = ?`)
			.bind(userId)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(indexed?.avatarUrl).toBe(avatar.url);
		expect(JSON.parse(indexed?.avatarCrop ?? "{}")).toEqual(crop);
		expect((await userById(testEnv.BICKR_KV, userId)).avatar?.crop).toEqual(crop);

		const publicResponse = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/octocat", { headers: { cookie } }),
				{ humanHandle: "octocat" },
			),
		);
		const publicBody = (await publicResponse.json()) as { data: { profile: HumanProfile } };
		expect(publicBody.data.profile.user.avatarUrl).toBe(avatar.url);
		expect(publicBody.data.profile.user.avatarCrop).toEqual(crop);

		const deleteResponse = await deleteUserAvatarRoute(
			contextFor<typeof deleteUserAvatarRoute>(
				new Request("http://example.com/api/me/avatar", {
					method: "DELETE",
					headers: { cookie },
				}),
			),
		);
		expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(200);
		const deleteBody = (await deleteResponse.json()) as { data: { profile: UserProfile } };
		expect(deleteBody.data.profile.avatar).toBeUndefined();
		expect(deleteBody.data.profile.avatarUrl).toBeUndefined();
		expect(deleteBody.data.profile.avatarCrop).toBeUndefined();

		const deletedIndexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM users_index WHERE user_id = ?`)
			.bind(userId)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(deletedIndexed?.avatarUrl).toBeNull();
		expect(deletedIndexed?.avatarCrop).toBeNull();
		expect((await userById(testEnv.BICKR_KV, userId)).avatar).toBeUndefined();
	});

	it("rejects direct human profile avatar URL edits", async () => {
		const cookie = await authCookie();
		const response = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest("http://example.com/api/me/profile", "PATCH", { avatarUrl: "https://example.com/avatar.png" }, cookie),
			),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { message: string };
		expect(body.message).toContain("profile avatar endpoints");
	});

	it("creates and applies generated human user avatar candidates with profile settings", async () => {
		await authCookie();
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const publicBaseUrl = "https://assets-test.bickr.social";
		const existingAvatar = await storeAvatarImage(r2.bucket, {
			target: "user",
			userId,
			bytes: pngAvatarBytes(),
			contentType: "image/png",
			publicBaseUrl,
		});
		await updateUserAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, userId, {
			...existingAvatar,
			crop: { x: 0, y: 0, size: 1, imageWidth: 1, imageHeight: 1 },
		});

		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				const url = String(input);
				if (url === "https://openrouter.ai/api/v1/images/models") {
					return Response.json({
						data: [
							{
								id: "openai/image-one",
								architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
							},
						],
					});
				}
				if (url === "https://openrouter.ai/api/v1/chat/completions") {
					const requestBody = JSON.parse(String(init?.body)) as {
						model?: string;
						modalities?: string[];
						messages?: Array<{ role: string; content: unknown }>;
					};
					expect(requestBody.model).toBe("openai/image-one");
					expect(requestBody.modalities).toEqual(["text"]);
					expect(JSON.stringify(requestBody.messages)).toContain(existingAvatar.url);
					return Response.json({
						choices: [{ message: { content: "A precise visual prompt from the current avatar." } }],
					});
				}
				expect(url).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					aspect_ratio?: string;
					size?: string;
					provider?: Record<string, unknown>;
					prompt?: string;
				};
				expect(requestBody.model).toBe("openai/image-one");
				expect(requestBody.aspect_ratio).toBe("1:1");
				expect(requestBody.size).toBe("2K");
				expect(requestBody.provider).toEqual({ sort: "price" });
				expect(requestBody.prompt).toContain("Paint my profile avatar.");
				return Response.json({
					data: [{ b64_json: base64String(pngAvatarBytes()) }],
					usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, cost: 0.045 },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let candidate: AvatarImage;
		try {
			const promptResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/avatar/prompt`,
					userId,
					{ mode: "current_avatar", settings: { model: "openai/image-one" } },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(promptResponse.status).toBe(200);
			const promptBody = (await promptResponse.json()) as { data: { prompt: string } };
			expect(promptBody.data.prompt).toBe("A precise visual prompt from the current avatar.");

			const personaResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/avatar/prompt`,
					userId,
					{ mode: "persona", settings: { model: "openai/image-one" } },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(personaResponse.status).toBe(400);
			const personaBody = (await personaResponse.json()) as { message: string };
			expect(personaBody.message).toContain("only supports the current avatar");

			const generateResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/avatar/generate`,
					userId,
					{
						prompt: "Paint my profile avatar.",
						includeCurrentAvatar: false,
						settings: {
							model: "openai/image-one",
							providerRouting: { sort: "price" },
							aspectRatio: "1:1",
							imageSize: "2K",
						},
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(generateResponse.status, await generateResponse.clone().text()).toBe(200);
			const generateBody = (await generateResponse.json()) as { data: { candidate: AvatarImage } };
			candidate = generateBody.data.candidate;
			expect(candidate.key).toMatch(new RegExp(`^users/${userId}/avatar-candidates/.+\\.png$`));
			expect(candidate.url).toContain(`/users/${userId}/avatar-candidates/`);
			expect(candidate.source).toMatchObject({
				type: "generated",
				model: "openai/image-one",
				prompt: "Paint my profile avatar.",
				cost: 0.045,
			});
			expect(r2.objects.has(candidate.key)).toBe(true);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const applyResponse = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/avatar/apply`,
				userId,
				{
					candidate,
					settings: {
						model: "openai/image-one",
						prompt: "Paint my profile avatar.",
						aspectRatio: "4:5",
						imageSize: "2K",
					},
				},
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: r2.bucket,
				BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
			},
		);
		expect(applyResponse.status, await applyResponse.clone().text()).toBe(200);
		const applyBody = (await applyResponse.json()) as { data: { profile: UserProfile } };
		expect(applyBody.data.profile.avatarUrl).toContain(`/users/${userId}/avatars/`);
		expect(applyBody.data.profile.avatarCrop).toBeUndefined();
		expect(r2.objects.has(candidate.key)).toBe(false);

		const storedUser = await userById(testEnv.BICKR_KV, userId);
		expect(storedUser.avatar?.url).toBe(applyBody.data.profile.avatarUrl);
		expect(storedUser.avatar?.source).toMatchObject({ type: "generated", cost: 0.045 });
		expect(storedUser.avatar?.crop).toBeUndefined();
		expect(storedUser.inferenceSettings?.imageGeneration).toMatchObject({
			model: "openai/image-one",
			prompt: unspecifiedLt("Paint my profile avatar."),
			aspectRatio: "4:5",
			imageSize: "2K",
		});
	});

	it("inherits avatar objects and generation metadata when cloning participants across worlds", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, "avatar-clone-source");
		const sourceDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id);
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const publicBaseUrl = "https://assets-test.bickr.social";
		const sourceBytes = pngAvatarBytes();
		const sourceAvatar = await storeAvatarImage(r2.bucket, {
			botId: sourceDocument.id,
			worldId: sourceDocument.homeWorldId,
			bytes: sourceBytes,
			contentType: "image/png",
			publicBaseUrl,
			source: {
				type: "generated",
				model: "openai/image-one",
				generatedAt: "2026-05-10T00:00:00.000Z",
				cost: 0.0123,
				prompt: "Paint me as a luminous portrait.",
			},
		});
		const sourceCrop: AvatarCrop = { x: 0, y: 0, size: 1, imageWidth: 1, imageHeight: 1 };
		const sourceAvatarWithCrop = { ...sourceAvatar, crop: sourceCrop };
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id, userId, sourceAvatarWithCrop);

		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "avatar-clones", name: "Avatar Clones", description: "Cloned avatar checks." },
					cookie,
				),
			),
		);
		expect(worldResponse.status).toBe(201);

		const cloneResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/avatar-clones/bots",
					"POST",
					{
						handle: "avatar-clone",
						displayName: "Avatar Clone",
						shortBio: "A participant cloned with an avatar.",
						prompt: "Continue the source persona.",
						cloneSourceBotId: source.id,
					},
					cookie,
				),
				{ worldHandle: "avatar-clones" },
				{
					AGENT_RUNTIME: {
						fetch: async (serviceRequest: Request) =>
							handleAgentRuntimeRequest(serviceRequest, {
								BICKR_D1: testEnv.BICKR_D1,
								BICKR_KV: testEnv.BICKR_KV,
								BICKR_R2: r2.bucket,
								BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
							}),
					} as unknown as Fetcher,
				},
			),
		);
		expect(cloneResponse.status, await cloneResponse.clone().text()).toBe(201);
		const cloneBody = (await cloneResponse.json()) as { data: { bot: BotBody } };
		expect(cloneBody.data.bot.avatarUrl).toMatch(/^https:\/\/assets-test\.bickr\.social\/worlds\/.+\/bots\/.+\/avatars\/.+\.png$/);
		expect(cloneBody.data.bot.avatarUrl).toBe(sourceAvatar.url);
		expect(cloneBody.data.bot.avatarCrop).toEqual(sourceCrop);
		expect(cloneBody.data.bot.cloneSource).toMatchObject({
			sourceBotId: source.id,
			sourceHandle: source.handle,
			sourceWorldHandle: source.homeWorldHandle,
			linked: true,
		});
		expect(cloneBody.data.bot.localOverrides).toMatchObject({
			hasAvatar: false,
			displayName: lt("Avatar Clone"),
			shortBio: lt("A participant cloned with an avatar."),
			prompt: lt("Continue the source persona."),
		});

		const rawStoredClone = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, cloneBody.data.bot.id);
		expect(rawStoredClone.avatar).toBeUndefined();
		const storedClone = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, cloneBody.data.bot.id);
		expect(storedClone.avatar?.key).toBe(sourceAvatar.key);
		expect(storedClone.avatar?.url).toBe(cloneBody.data.bot.avatarUrl);
		expect(storedClone.avatar?.crop).toEqual(sourceCrop);
		expect(storedClone.avatar?.source).toMatchObject({
			type: "generated",
			model: "openai/image-one",
			generatedAt: "2026-05-10T00:00:00.000Z",
			cost: 0.0123,
			prompt: "Paint me as a luminous portrait.",
		});
		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM bots_index WHERE bot_id = ?`)
			.bind(storedClone.id)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(indexed?.avatarUrl).toBe(storedClone.avatar?.url);
		expect(JSON.parse(indexed?.avatarCrop ?? "{}")).toEqual(sourceCrop);
		expect(r2.objects.size).toBe(1);
	});

	it("stores clone provenance and cascades profile and inference values through clone chains", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const ar = "ar" as LanguageTag;
		const ja = "ja" as LanguageTag;
		const source = await createBotInWorld(cookie, "patch-notes", {
			handle: "clone-source",
			language: ar,
			displayName: localizedText("Clone Source", ar),
			shortBio: localizedText("Source bio.", ar),
			prompt: localizedText("Source prompt.", ar),
		});
		const patchedSource = await patchBotInferenceForTest(
			cookie,
			source.id,
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "source/model",
				temperature: 0.33,
				compactionMode: "tool_call",
			},
			ar,
		);
		expect(patchedSource.inferenceSettings).toMatchObject({
			baseUrl: "https://openrouter.ai/api/v1",
			model: "source/model",
			temperature: 0.33,
			compactionMode: "tool_call",
		});
		await createWorldForTest(cookie, "clone-middle-world", "Clone Middle World");
		await createWorldForTest(cookie, "clone-leaf-world", "Clone Leaf World");

		const middle = await createBotInWorld(cookie, "clone-middle-world", {
			handle: "clone-middle",
			language: null,
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: source.id,
		});
		expect(middle.language).toBe(ar);
		expect(middle.includeLanguageInSystemPrompt).toBe(true);
		expect(middle.displayName).toStrictEqual(source.displayName);
		expect(middle.shortBio).toStrictEqual(source.shortBio);
		expect(middle.prompt).toStrictEqual(source.prompt);
		expect(middle.cloneSource).toMatchObject({
			sourceBotId: source.id,
			sourceHandle: source.handle,
			sourceWorldHandle: source.homeWorldHandle,
			linked: true,
		});
		expect(middle.localOverrides).toMatchObject({
			language: null,
			includeLanguageInSystemPrompt: null,
			displayName: localizedText("", null),
			shortBio: localizedText("", null),
			prompt: localizedText("", null),
			inferenceSettings: {},
			hasAvatar: false,
		});
		const blankLanguageSaveResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${middle.id}`,
					"PATCH",
					{
						language: null,
						includeLanguageInSystemPrompt: null,
						displayName: "",
						shortBio: "",
						prompt: "",
					},
					cookie,
				),
				{ botId: middle.id },
			),
		);
		expect(blankLanguageSaveResponse.status, await blankLanguageSaveResponse.clone().text()).toBe(200);
		const rawMiddleAfterBlankLanguageSave = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, middle.id);
		expect(rawMiddleAfterBlankLanguageSave.language).toBe(null);
		expect(rawMiddleAfterBlankLanguageSave.includeLanguageInSystemPrompt).toBe(null);
		expect(rawMiddleAfterBlankLanguageSave.displayName).toStrictEqual(localizedText("", null));
		expect(rawMiddleAfterBlankLanguageSave.shortBio).toStrictEqual(localizedText("", null));
		expect(rawMiddleAfterBlankLanguageSave.prompt).toStrictEqual(localizedText("", null));
		expect(middle.inferenceSettings).toMatchObject({
			model: "source/model",
			temperature: 0.33,
			compactionMode: "tool_call",
		});

		const leaf = await createBotInWorld(cookie, "clone-leaf-world", {
			handle: "clone-leaf",
			language: null,
			includeLanguageInSystemPrompt: false,
			displayName: "",
			shortBio: "Leaf override",
			prompt: "",
			cloneSourceBotId: middle.id,
		});
		expect(leaf.language).toBe(ar);
		expect(leaf.includeLanguageInSystemPrompt).toBe(false);
		expect(leaf.displayName).toStrictEqual(source.displayName);
		expect(leaf.shortBio).toStrictEqual(localizedText("Leaf override", ar));
		expect(leaf.prompt).toStrictEqual(source.prompt);
		expect(leaf.inferenceSettings).toMatchObject({
			model: "source/model",
			temperature: 0.33,
			compactionMode: "tool_call",
		});
		const listedIds = (await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, await userIdForHandle("octocat")))
			.map((bot) => bot.id);
		expect(listedIds).toEqual(expect.arrayContaining([source.id, middle.id, leaf.id]));

		const sourcePatchResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${source.id}`,
					"PATCH",
					{
						language: ja,
						includeLanguageInSystemPrompt: false,
						displayName: "Clone Source Updated",
						prompt: "Updated source prompt.",
						inferenceSettings: {
							baseUrl: "https://openrouter.ai/api/v1",
							model: "source/updated",
							temperature: 0.55,
						},
					},
					cookie,
				),
				{ botId: source.id },
			),
		);
		expect(sourcePatchResponse.status).toBe(200);
		const patchPayload = (await sourcePatchResponse.json()) as { data: { bot: BotBody; affectedBots: BotBody[] } };
		expect(patchPayload.data.bot.language).toBe(ja);
		expect(patchPayload.data.bot.includeLanguageInSystemPrompt).toBe(false);
		expect(patchPayload.data.affectedBots.map((bot) => bot.id).sort()).toEqual([leaf.id, middle.id].sort());
		const effectiveMiddle = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, middle.id);
		const effectiveLeaf = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, leaf.id);
		expect(effectiveMiddle.language).toBe(ja);
		expect(effectiveMiddle.includeLanguageInSystemPrompt).toBe(false);
		expect(effectiveMiddle.displayName).toStrictEqual(localizedText("Clone Source Updated", ja));
		expect(effectiveMiddle.prompt).toStrictEqual(localizedText("Updated source prompt.", ja));
		expect(effectiveLeaf.language).toBe(ja);
		expect(effectiveLeaf.includeLanguageInSystemPrompt).toBe(false);
		expect(effectiveLeaf.displayName).toStrictEqual(localizedText("Clone Source Updated", ja));
		expect(effectiveLeaf.shortBio).toStrictEqual(localizedText("Leaf override", ja));
		expect(effectiveLeaf.inferenceSettings).toMatchObject({
			model: "source/updated",
			temperature: 0.55,
		});

		const leafOverrideResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${leaf.id}`,
					"PATCH",
					{ includeLanguageInSystemPrompt: true },
					cookie,
				),
				{ botId: leaf.id },
			),
		);
		expect(leafOverrideResponse.status, await leafOverrideResponse.clone().text()).toBe(200);
		const leafOverridePayload = (await leafOverrideResponse.json()) as { data: { bot: BotBody } };
		expect(leafOverridePayload.data.bot.includeLanguageInSystemPrompt).toBe(true);
		const rawLeafOverride = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, leaf.id);
		expect(rawLeafOverride.includeLanguageInSystemPrompt).toBe(true);
	});

	it("normalizes missing language system prompt setting to false for existing non-clones", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "legacy-language-setting");
		const raw = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		const legacyRaw = { ...raw } as Partial<BotDocument>;
		delete legacyRaw.includeLanguageInSystemPrompt;
		await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify(legacyRaw));

		expect((await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id)).includeLanguageInSystemPrompt).toBe(null);
		expect((await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id)).includeLanguageInSystemPrompt).toBe(false);
	});

	it("falls through linked clone inference chains to owner defaults after source defaults", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		await updateUserProfile(testEnv.BICKR_KV, testEnv.BICKR_D1, userId, {
			inferenceSettings: {
				openRouterApiKey: "sk-or-chain-owner",
				model: "owner/model",
				compactionMode: "tool_call_cache_friendly",
				temperature: 0.77,
			},
		});
		const source = await createBotForTest(cookie, "clone-owner-fallback-source");
		await patchBotInferenceForTest(cookie, source.id, {
			compactionMode: "tool_call",
			temperature: 0.42,
		});
		await createWorldForTest(cookie, "clone-owner-fallback-middle", "Clone Owner Fallback Middle");
		await createWorldForTest(cookie, "clone-owner-fallback-leaf", "Clone Owner Fallback Leaf");

		const middle = await createBotInWorld(cookie, "clone-owner-fallback-middle", {
			handle: "clone-owner-fallback-middle",
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: source.id,
		});
		const leaf = await createBotInWorld(cookie, "clone-owner-fallback-leaf", {
			handle: "clone-owner-fallback-leaf",
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: middle.id,
		});

		const owner = await userById(testEnv.BICKR_KV, userId);
		const effectiveLeaf = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, leaf.id);
		expect(effectiveLeaf.inferenceSettings.model).toBeUndefined();
		const settings = effectiveProviderSettingsForBot(effectiveLeaf, owner, {});
		expect(settings).toMatchObject({
			apiKey: "sk-or-chain-owner",
			compactionMode: "tool_call",
			model: "owner/model",
			temperature: 0.42,
		});
	});

	it("unlinks and relinks clones while preserving provenance and delete blocking", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, "unlink-source");
		await createWorldForTest(cookie, "unlink-clones", "Unlink Clones");
		const clone = await createBotInWorld(cookie, "unlink-clones", {
			handle: "unlink-clone",
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: source.id,
		});

		const blockedDelete = await deleteBot(
			contextFor<typeof deleteBot>(
				jsonRequest(`http://example.com/api/me/bots/${source.id}`, "DELETE", undefined, cookie),
				{ botId: source.id },
			),
		);
		expect(blockedDelete.status).toBe(409);

		const unlinkResponse = await unlinkBotCloneRoute(
			contextFor<typeof unlinkBotCloneRoute>(
				jsonRequest(`http://example.com/api/me/bots/${clone.id}/clone/unlink`, "POST", {}, cookie),
				{ botId: clone.id },
			),
		);
		expect(unlinkResponse.status, await unlinkResponse.clone().text()).toBe(200);
		const unlinked = (await unlinkResponse.json()) as { data: { bot: BotBody } };
		expect(unlinked.data.bot.cloneSource).toMatchObject({ sourceBotId: source.id, linked: false });
		const rawUnlinked = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id);
		expect(rawUnlinked.includeLanguageInSystemPrompt).toBe(source.includeLanguageInSystemPrompt);
		expect(rawUnlinked.displayName).toStrictEqual(source.displayName);
		expect(rawUnlinked.prompt).toStrictEqual(source.prompt);

		const relinkResponse = await relinkBotCloneRoute(
			contextFor<typeof relinkBotCloneRoute>(
				jsonRequest(`http://example.com/api/me/bots/${clone.id}/clone/relink`, "POST", {}, cookie),
				{ botId: clone.id },
			),
		);
		expect(relinkResponse.status, await relinkResponse.clone().text()).toBe(200);
		const rawRelinked = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id);
		expect(rawRelinked.includeLanguageInSystemPrompt).toBe(null);
		expect(rawRelinked.displayName).toStrictEqual(lt(""));
		expect(rawRelinked.prompt).toStrictEqual(lt(""));
		expect((await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id)).cloneSource).toMatchObject({
			sourceBotId: source.id,
			linked: true,
		});

		const unlinkAgain = await unlinkBotCloneRoute(
			contextFor<typeof unlinkBotCloneRoute>(
				jsonRequest(`http://example.com/api/me/bots/${clone.id}/clone/unlink`, "POST", {}, cookie),
				{ botId: clone.id },
			),
		);
		expect(unlinkAgain.status).toBe(200);
		const allowedDelete = await deleteBot(
			contextFor<typeof deleteBot>(
				jsonRequest(`http://example.com/api/me/bots/${source.id}`, "DELETE", undefined, cookie),
				{ botId: source.id },
			),
		);
		expect(allowedDelete.status).toBe(200);
	});

	it("deleting a local clone avatar falls back to the source avatar", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, "avatar-fallback-source");
		const userId = await userIdForHandle("octocat");
		const now = new Date().toISOString();
		const sourceAvatar: AvatarImage = {
			contentType: "image/png",
			key: `test/${source.id}/source.png`,
			updatedAt: now,
			url: "https://assets-test.bickr.social/source.png",
		};
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id, userId, sourceAvatar, now);
		await createWorldForTest(cookie, "avatar-fallback-clones", "Avatar Fallback Clones");
		const clone = await createBotInWorld(cookie, "avatar-fallback-clones", {
			handle: "avatar-fallback-clone",
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: source.id,
		});
		expect(clone.avatarUrl).toBe(sourceAvatar.url);
		const localAvatar: AvatarImage = {
			contentType: "image/png",
			key: `test/${clone.id}/local.png`,
			updatedAt: now,
			url: "https://assets-test.bickr.social/local.png",
		};
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id, userId, localAvatar, now);
		expect((await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id)).avatar?.url).toBe(localAvatar.url);

		const deleteAvatarResponse = await deleteBotAvatarRoute(
			contextFor<typeof deleteBotAvatarRoute>(
				jsonRequest(`http://example.com/api/me/bots/${clone.id}/avatar`, "DELETE", undefined, cookie),
				{ botId: clone.id },
			),
		);
		expect(deleteAvatarResponse.status).toBe(200);
		const deletePayload = (await deleteAvatarResponse.json()) as { data: { bot: BotBody } };
		expect(deletePayload.data.bot.avatarUrl).toBe(sourceAvatar.url);
		expect((await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id)).avatar).toBeUndefined();
	});

	it("backfills inferred same-owner same-handle clone sources and preserves differing overrides", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, "duplicate");
		await createWorldForTest(cookie, "duplicate-world", "Duplicate World");
		const duplicate = await createBotInWorld(cookie, "duplicate-world", {
			handle: "duplicate",
			displayName: source.displayName,
			shortBio: "Different short bio",
			prompt: source.prompt,
		});

		const result = await backfillInferredCloneSources(testEnv.BICKR_KV, testEnv.BICKR_D1, "2026-05-14T00:00:00.000Z");
		expect(result).toMatchObject({ groups: 1, clonesLinked: 1, clonesSkipped: 0 });
		const rawDuplicate = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, duplicate.id);
		expect(rawDuplicate.includeLanguageInSystemPrompt).toBe(null);
		expect(rawDuplicate.displayName).toStrictEqual(lt(""));
		expect(rawDuplicate.shortBio).toStrictEqual(lt("Different short bio"));
		expect(rawDuplicate.prompt).toStrictEqual(lt(""));
		const effectiveDuplicate = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, duplicate.id);
		expect(effectiveDuplicate.includeLanguageInSystemPrompt).toBe(source.includeLanguageInSystemPrompt);
		expect(effectiveDuplicate.displayName).toStrictEqual(source.displayName);
		expect(effectiveDuplicate.shortBio).toStrictEqual(lt("Different short bio"));
		expect(effectiveDuplicate.prompt).toStrictEqual(source.prompt);
		expect(effectiveDuplicate.cloneSource).toMatchObject({
			sourceBotId: source.id,
			sourceHandle: source.handle,
			linked: true,
		});
	});

	it("uploads SVG participant avatars into R2", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-svg");
		const r2 = fakeR2Bucket();
		const sourceUrl = "https://images.example/avatar.svg";
		const sourceBytes = svgAvatarBytes();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe(sourceUrl);
				return new Response(sourceBytes, {
					headers: {
						"content-type": "image/svg+xml; charset=utf-8",
						"content-length": String(sourceBytes.byteLength),
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await uploadBotAvatar(
				contextFor<typeof uploadBotAvatar>(
					jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar`, "PUT", { url: sourceUrl }, cookie),
					{ botId: bot.id },
					{
						BICKR_R2: r2.bucket,
						BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					},
				),
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { bot: BotBody } };
			expect(body.data.bot.avatarUrl).toMatch(/^https:\/\/assets-test\.bickr\.social\/worlds\/.+\/bots\/.+\/avatars\/.+\.svg$/);
			const stored = [...r2.objects.values()][0];
			expect(stored?.bytes).toEqual(sourceBytes);
			expect(stored?.httpMetadata?.contentType).toBe("image/svg+xml");
			const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
			expect(storedBot.avatar).toMatchObject({
				contentType: "image/svg+xml",
				width: 24,
				height: 32,
				source: {
					type: "remote_url",
					sourceUrl,
				},
			});
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("rejects SVG avatar uploads with active content", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-unsafe-svg");
		const form = new FormData();
		form.set("file", new File([unsafeSvgAvatarBytes()], "avatar.svg", { type: "image/svg+xml" }));
		const response = await uploadBotAvatar(
			contextFor<typeof uploadBotAvatar>(
				new Request(`http://example.com/api/me/bots/${bot.id}/avatar`, {
					method: "PUT",
					headers: { cookie },
					body: form,
				}),
				{ botId: bot.id },
				{
					BICKR_R2: fakeR2Bucket().bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
				},
			),
		);
		expect(response.status).toBe(400);
	});

	it("rejects unsupported avatar upload file types", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-invalid");
		const form = new FormData();
		form.set("file", new File([new Uint8Array([0x47, 0x49, 0x46])], "avatar.gif", { type: "image/gif" }));
		const response = await uploadBotAvatar(
			contextFor<typeof uploadBotAvatar>(
				new Request(`http://example.com/api/me/bots/${bot.id}/avatar`, {
					method: "PUT",
					headers: { cookie },
					body: form,
				}),
				{ botId: bot.id },
				{
					BICKR_R2: fakeR2Bucket().bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
				},
			),
		);
		expect(response.status).toBe(400);
	});

	it("filters OpenRouter image-capable models and keeps image input capabilities", async () => {
		const cookie = await authCookie();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images/models");
				return Response.json({
					data: [
						{
							id: "openai/image-one",
							name: "Image One",
							architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
						},
						{
							id: "text-only",
							name: "Text Only",
							architecture: { input_modalities: ["text"], output_modalities: ["text"] },
						},
						{
							id: "image-output",
							architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] },
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await openRouterImageModelsRoute(
				contextFor<typeof openRouterImageModelsRoute>(
					new Request("http://example.com/api/openrouter/image-models", {
						headers: { cookie },
					}),
				),
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				data: {
					models: Array<{ id: string; name: string; inputModalities: string[]; outputModalities: string[] }>;
				};
			};
			expect(body.data.models).toEqual([
				{
					id: "openai/image-one",
					name: "Image One",
					inputModalities: ["text", "image"],
					outputModalities: ["image"],
				},
				{
					id: "image-output",
					name: "image-output",
					inputModalities: ["text"],
					outputModalities: ["text", "image"],
				},
			]);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("creates generated avatar candidates and promotes them explicitly", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-generated");
		const userId = await userIdForHandle("octocat");
		const blankPrompt = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
				userId,
				{ prompt: "", includeCurrentAvatar: false, settings: { model: "openai/image-one" } },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: fakeR2Bucket().bucket,
				BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
				OPENROUTER_API_KEY: "test-key",
			},
		);
		expect(blankPrompt.status).toBe(400);

		const overlongAspectRatio = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
				userId,
				{ prompt: "Paint me.", includeCurrentAvatar: false, settings: { model: "openai/image-one", aspectRatio: "x".repeat(41) } },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: fakeR2Bucket().bucket,
				BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
				OPENROUTER_API_KEY: "test-key",
			},
		);
		expect(overlongAspectRatio.status).toBe(400);
		const overlongAspectRatioBody = (await overlongAspectRatio.json()) as { ok: false; message: string };
		expect(overlongAspectRatioBody.message).toBe("Image aspect ratio must be 40 characters or fewer.");

		const r2 = fakeR2Bucket();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					aspect_ratio?: string;
					size?: string;
					provider?: Record<string, unknown>;
					prompt?: string;
				};
				if (requestBody.model === defaultAvatarImageGenerationSettings.model) {
					expect(requestBody.aspect_ratio).toBe(defaultAvatarImageGenerationSettings.aspectRatio);
					expect(requestBody.size).toBe(defaultAvatarImageGenerationSettings.imageSize);
					expect(requestBody.prompt).toContain("Paint me with defaults.");
					expect(requestBody.provider).toBeUndefined();
				} else {
					expect(requestBody.model).toBe("openai/image-one");
					expect(requestBody.aspect_ratio).toBe("12:78");
					expect(requestBody.size).toBe("custom-size");
					expect(requestBody.prompt).toContain("Paint me as a luminous portrait.");
					expect(requestBody.provider).toEqual({ sort: "price" });
				}
				return Response.json({
					data: [{ b64_json: base64String(largePngAvatarBytes()) }],
					usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, cost: 0.0123 },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let candidate: NonNullable<BotBody["avatar"]>;
		try {
			const defaultGenerateResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me with defaults.",
						includeCurrentAvatar: false,
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(defaultGenerateResponse.status).toBe(200);
			const defaultGenerateBody = (await defaultGenerateResponse.json()) as { data: { candidate: NonNullable<BotBody["avatar"]> } };
			expect(defaultGenerateBody.data.candidate.source).toMatchObject({
				type: "generated",
				model: defaultAvatarImageGenerationSettings.model,
				prompt: "Paint me with defaults.",
			});

			const generateResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me as a luminous portrait.",
						includeCurrentAvatar: false,
						settings: {
								model: "openai/image-one",
								providerRouting: { sort: "price" },
								aspectRatio: "12:78",
								imageSize: "custom-size",
							},
						},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(generateResponse.status).toBe(200);
			const generateBody = (await generateResponse.json()) as { data: { candidate: NonNullable<BotBody["avatar"]> } };
			candidate = generateBody.data.candidate;
			expect(candidate.key).toContain("/avatar-candidates/");
			expect(candidate.url).toContain("/avatar-candidates/");
			expect(candidate.source).toMatchObject({
				type: "generated",
				model: "openai/image-one",
				prompt: "Paint me as a luminous portrait.",
				cost: 0.0123,
			});
			expect(candidate.byteLength).toBeGreaterThan(1_500_000);
			expect(r2.objects.has(candidate.key)).toBe(true);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const existingAvatar = await storeAvatarImage(r2.bucket, {
			botId: bot.id,
			worldId: bot.homeWorldId,
			bytes: pngAvatarBytes(),
			contentType: "image/png",
			publicBaseUrl: "https://assets-test.bickr.social",
		});
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, {
			...existingAvatar,
			crop: { x: 0, y: 0, size: 1, imageWidth: 1, imageHeight: 1 },
		});

		const applyResponse = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/apply`,
				userId,
				{
					candidate,
					settings: {
						model: "openai/image-one",
						prompt: "Paint me as a luminous portrait.",
						aspectRatio: "1:1",
						imageSize: "2K",
					},
				},
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: r2.bucket,
				BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
			},
		);
		expect(applyResponse.status).toBe(200);
		const applyBody = (await applyResponse.json()) as { data: { bot: BotBody } };
		expect(applyBody.data.bot.avatarUrl).toContain("/avatars/");
		expect(r2.objects.has(candidate.key)).toBe(false);
		const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(storedBot.avatar?.url).toBe(applyBody.data.bot.avatarUrl);
		expect(storedBot.avatar?.source).toMatchObject({ type: "generated", cost: 0.0123 });
		expect(storedBot.avatar?.crop).toBeUndefined();
		expect(applyBody.data.bot.avatarCrop).toBeUndefined();
		expect(storedBot.inferenceSettings.imageGeneration).toMatchObject({
			model: "openai/image-one",
			prompt: lt("Paint me as a luminous portrait."),
			aspectRatio: "1:1",
			imageSize: "2K",
		});
	});

	it("streams generated avatar chat events and keeps image bytes out of the chat log", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-streamed");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const rawDataUrl = avatarDataUrl();
		const model = "openai/gpt-image-1";
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				if (String(input) === "https://openrouter.ai/api/v1/images/models") {
					return Response.json({
						data: [
							{
								id: model,
								architecture: { input_modalities: ["text"], output_modalities: ["image"] },
								supports_streaming: true,
							},
						],
					});
				}
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					stream?: boolean;
					prompt?: string;
				};
				expect(requestBody.model).toBe(model);
				expect(requestBody.stream).toBe(true);
				expect(requestBody.prompt).toContain("Bickr participant");
				expect(requestBody.prompt).toContain("Paint me as a luminous portrait.");
				return new Response(sseStream([
					{
						type: "image_generation.completed",
						b64_json: rawDataUrl.split(",", 2)[1],
						usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost: 0.045 },
					},
					"[DONE]",
				]), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me as a luminous portrait.",
						includeCurrentAvatar: false,
						settings: { model },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const streamText = await response.text();
			expect(streamText).not.toContain(rawDataUrl);
			const events = parseJsonSseEvents(streamText);
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_image", "done"]);
			expect(events[0]).toMatchObject({
				type: "messages",
				messages: [
					{ role: "system", content: expect.stringContaining("Bickr participant") },
					{ role: "user", content: "Paint me as a luminous portrait." },
				],
			});
			expect(events[1]).toEqual({ type: "assistant_image", count: 1 });
			expect(events[2]).toMatchObject({
				type: "done",
				candidate: {
					contentType: "image/png",
					source: {
						type: "generated",
						model,
						prompt: "Paint me as a luminous portrait.",
						cost: 0.045,
					},
				},
			});
			const candidate = (events[2] as { candidate: NonNullable<BotBody["avatar"]> }).candidate;
			expect(candidate.url).toContain("/avatar-candidates/");
			expect(r2.objects.has(candidate.key)).toBe(true);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("buffers upstream OpenRouter image requests for non-streaming models while streaming avatar events", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-streamed-gemini");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const model = "google/gemini-3.1-flash-image";
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				if (String(input) === "https://openrouter.ai/api/v1/images/models") {
					return Response.json({
						data: [
							{
								id: model,
								architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
								supports_streaming: false,
							},
						],
					});
				}
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					stream?: boolean;
					prompt?: string;
				};
				expect(requestBody.model).toBe(model);
				expect(requestBody.stream).toBe(false);
				expect(requestBody.prompt).toContain("Paint me as a luminous portrait.");
				return Response.json({
					data: [{ b64_json: base64String(pngAvatarBytes()) }],
					usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12, cost: 0.034 },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me as a luminous portrait.",
						includeCurrentAvatar: false,
						settings: { model },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const events = parseJsonSseEvents(await response.text());
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_image", "done"]);
			expect(events[1]).toEqual({ type: "assistant_image", count: 1 });
			expect(events[2]).toMatchObject({
				type: "done",
				candidate: {
					contentType: "image/png",
					source: {
						type: "generated",
						model,
						prompt: "Paint me as a luminous portrait.",
						cost: 0.034,
					},
				},
			});
			const candidate = (events[2] as { candidate: NonNullable<BotBody["avatar"]> }).candidate;
			expect(candidate.url).toContain("/avatar-candidates/");
			expect(r2.objects.has(candidate.key)).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("submits the full current avatar URL to image generation even when a crop is saved", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-full-input");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const currentAvatar: AvatarImage = {
			key: "worlds/world_patch-notes/bots/bot_avatar-full-input/avatars/current.png",
			url: "https://assets-test.bickr.social/worlds/world_patch-notes/bots/bot_avatar-full-input/avatars/current.png",
			contentType: "image/png",
			width: 480,
			height: 720,
			crop: { x: 80, y: 0, size: 480, imageWidth: 480, imageHeight: 720 },
			updatedAt: "2026-05-12T00:00:00.000Z",
		};
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, currentAvatar);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					input_references?: Array<{ type?: string; image_url?: { url?: string } }>;
					stream?: boolean;
				};
				expect(requestBody.stream).toBe(false);
				const imageReference = requestBody.input_references?.find((part) => part.type === "image_url");
				expect(imageReference?.image_url?.url).toBe(currentAvatar.url);
				expect(imageReference?.image_url?.url).not.toContain("/cdn-cgi/image/");
				return Response.json({
					data: [{ b64_json: base64String(pngAvatarBytes()) }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Use my current avatar as the visual source.",
						includeCurrentAvatar: true,
						settings: { model: "openai/image-one" },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			const streamText = await response.text();
			const events = parseJsonSseEvents(streamText);
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_image", "done"]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("creates and promotes SVG generated avatar candidates", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-generated-svg");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				return Response.json({
					data: [{ b64_json: base64String(svgAvatarBytes()), media_type: "image/svg+xml" }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let candidate: NonNullable<BotBody["avatar"]>;
		try {
			const generateResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Draw me as a clean vector emblem.",
						includeCurrentAvatar: false,
						settings: { model: "openai/svg-image" },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(generateResponse.status).toBe(200);
			const generateBody = (await generateResponse.json()) as { data: { candidate: NonNullable<BotBody["avatar"]> } };
			candidate = generateBody.data.candidate;
			expect(candidate.contentType).toBe("image/svg+xml");
			expect(candidate.url).toMatch(/\/avatar-candidates\/.+\.svg$/);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const applyResponse = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/apply`,
				userId,
				{ candidate },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: r2.bucket,
				BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
			},
		);
		expect(applyResponse.status).toBe(200);
		const applyBody = (await applyResponse.json()) as { data: { bot: BotBody } };
		expect(applyBody.data.bot.avatarUrl).toMatch(/\/avatars\/.+\.svg$/);
		const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(storedBot.avatar?.contentType).toBe("image/svg+xml");
	});

	it("uses the dedicated OpenRouter image endpoint for avatar generation", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-image-only");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as { model?: string; modalities?: string[]; prompt?: string };
				expect(requestBody.model).toBe("image/only");
				expect(requestBody.modalities).toBeUndefined();
				expect(requestBody.prompt).toContain("Paint me as a luminous portrait.");
				return Response.json({
					data: [{ b64_json: base64String(pngAvatarBytes()) }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me as a luminous portrait.",
						includeCurrentAvatar: false,
						settings: { model: "image/only" },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("prefills avatar prompts with structured output when configured", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-prefill");
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: unknown }>;
					response_format?: { json_schema?: { name?: string } };
					tools?: unknown[];
					tool_choice?: unknown;
				};
				expect(requestBody.messages).toHaveLength(2);
				expect(requestBody.response_format?.json_schema?.name).toBe("avatar_description");
				expect(requestBody.tools).toBeUndefined();
				expect(requestBody.tool_choice).toBeUndefined();
				const participantFacingText = JSON.stringify({
					message: requestBody.messages[1]?.content,
				});
				expect(participantFacingText).not.toMatch(/\b(bot|AI|assistant|agent|model)\b/i);
				return Response.json({
					choices: [
						{
							message: {
								content: [
									"I can picture it clearly.",
									JSON.stringify({
										description: "I stand in a bright studio wearing a deep green jacket, with amber rim light catching the edges of my face.",
									}),
									"That is the profile image description.",
								].join("\n"),
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toContain("deep green jacket");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("prefills avatar prompts with one forced no-history visual-description tool when configured", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const createdBot = await createBotForTest(cookie, "avatar-prefill-tool");
		const bot = await patchBotInferenceForTest(cookie, createdBot.id, { compactionMode: "tool_call" });
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: unknown }>;
					response_format?: unknown;
					tools: Array<{ function: { name: string; description: string } }>;
					tool_choice?: unknown;
				};
				expect(requestBody.messages).toHaveLength(2);
				expect(requestBody.response_format).toBeUndefined();
				expect(requestBody.tools.map((tool) => tool.function.name)).toEqual(["save_avatar_description"]);
				expect(requestBody.tool_choice).toBe("required");
				const participantFacingText = JSON.stringify({
					message: requestBody.messages[1]?.content,
					tools: requestBody.tools.map((tool) => tool.function.description),
				});
				expect(participantFacingText).not.toMatch(/\b(bot|AI|assistant|agent|model)\b/i);
				return Response.json({
					choices: [
						{
							message: {
								tool_calls: [
									{
										function: {
											name: "save_avatar_description",
											arguments: JSON.stringify({
												description: "I stand in a bright studio wearing a deep green jacket, with amber rim light catching the edges of my face.",
											}),
										},
									},
								],
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toContain("deep green jacket");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("falls back to avatar prompt tool calls when structured prefill responses are unusable", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-prefill-fallback");
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					response_format?: { json_schema?: { name?: string } };
					tools?: Array<{ function: { name: string } }>;
					tool_choice?: unknown;
				};
				if (fetchMock.mock.calls.length <= 2) {
					expect(requestBody.response_format?.json_schema?.name).toBe("avatar_description");
					expect(requestBody.tools).toBeUndefined();
					return Response.json({ choices: [{ message: { content: "" } }] });
				}
				expect(requestBody.response_format).toBeUndefined();
				expect(requestBody.tools?.map((tool) => tool.function.name)).toEqual(["save_avatar_description"]);
				expect(requestBody.tool_choice).toBe("required");
				return Response.json({
					choices: [
						{
							message: {
								tool_calls: [
									{
										id: "call_avatar_fallback",
										type: "function",
										function: {
											name: "save_avatar_description",
											arguments: JSON.stringify({
												description: "I lean against a rain-bright window in a midnight blue coat, silver light tracing my cheekbones.",
											}),
										},
									},
								],
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toContain("midnight blue coat");
			expect(fetchMock).toHaveBeenCalledTimes(3);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("retries avatar prompt prefill when the provider omits the required tool call", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const createdBot = await createBotForTest(cookie, "avatar-prefill-retry");
		const bot = await patchBotInferenceForTest(cookie, createdBot.id, { compactionMode: "tool_call" });
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: unknown }>;
					tools: Array<{ function: { name: string } }>;
					tool_choice?: unknown;
				};
				expect(requestBody.tools.map((tool) => tool.function.name)).toEqual(["save_avatar_description"]);
				expect(requestBody.tool_choice).toBe("required");
				if (fetchMock.mock.calls.length === 1) {
					expect(requestBody.messages).toHaveLength(2);
					return Response.json({
						choices: [
							{
								message: {
									content: "I am framed in warm light but forgot the control.",
								},
							},
						],
					});
				}
				expect(requestBody.messages.at(-1)?.role).toBe("user");
				expect(String(requestBody.messages.at(-1)?.content)).toContain("save_avatar_description");
				return Response.json({
					choices: [
						{
							message: {
								tool_calls: [
									{
										id: "call_avatar_retry",
										type: "function",
										function: {
											name: "save_avatar_description",
											arguments: JSON.stringify({
												description: "I stand beneath amber glass panes in a tailored charcoal coat, my expression calm and sharply observant.",
											}),
										},
									},
								],
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toContain("charcoal coat");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("streams persona avatar prompt fill chat events with assistant prefill", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-prefill-stream");
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content?: string | null }>;
					response_format?: { json_schema?: { name?: string } };
				};
				expect(requestBody.response_format?.json_schema?.name).toBe("avatar_description");
				expect(requestBody.messages.map((message) => message.role)).toEqual(["system", "assistant", "user"]);
				expect(requestBody.messages[1]?.content).toBe("Existing prompt draft.");
				return Response.json({
					choices: [
						{
							message: {
								content: JSON.stringify({
									description: "I face the viewer in a copper-lit study, wearing a dark green coat with precise gold trim.",
								}),
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{ mode: "persona", prefill: "Existing prompt draft." },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const events = parseJsonSseEvents(await response.text());
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_delta", "done"]);
			expect(events[0]).toMatchObject({
				type: "messages",
				messages: [
					{ role: "system" },
					{ role: "assistant", content: "Existing prompt draft." },
					{ role: "user" },
				],
			});
			expect(events[1]).toEqual({
				type: "assistant_delta",
				text: "\n\nI face the viewer in a copper-lit study, wearing a dark green coat with precise gold trim.",
			});
			expect(events[2]).toEqual({
				type: "done",
				prompt: "I face the viewer in a copper-lit study, wearing a dark green coat with precise gold trim.",
			});
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("streams current-avatar prompt fill with text-only image input", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-current-fill");
		const userId = await userIdForHandle("octocat");
		const avatarUrl = "https://assets-test.bickr.social/worlds/w/bots/b/avatars/current.png";
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, {
			key: "worlds/w/bots/b/avatars/current.png",
			url: avatarUrl,
			contentType: "image/png",
			updatedAt: "2026-05-12T00:00:00.000Z",
		});
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				if (String(input) === "https://openrouter.ai/api/v1/images/models") {
					return Response.json({
						data: [
							{
								id: "openai/image-text",
								architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
							},
						],
					});
				}
				expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					modalities?: string[];
					stream?: boolean;
					messages?: Array<{ role: string; content: unknown }>;
				};
				expect(requestBody.model).toBe("openai/image-text");
				expect(requestBody.modalities).toEqual(["text"]);
				expect(requestBody.stream).toBe(true);
				const userContent = requestBody.messages?.find((message) => message.role === "user")?.content;
				expect(JSON.stringify(userContent)).toContain(avatarUrl);
				return new Response(sseStream([
					{ choices: [{ delta: { content: "A full-length portrait in warm window light." } }] },
					"[DONE]",
				]), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{ mode: "current_avatar", settings: { model: "openai/image-text" } },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			const events = parseJsonSseEvents(await response.text());
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_delta", "done"]);
			expect(events[0]).toMatchObject({
				type: "messages",
				messages: [
					{ role: "system", content: expect.stringContaining("profile image") },
					{ role: "user", content: expect.stringContaining("[current avatar image included]") },
				],
			});
			expect(events[1]).toEqual({ type: "assistant_delta", text: "A full-length portrait in warm window light." });
			expect(events[2]).toEqual({ type: "done", prompt: "A full-length portrait in warm window light." });
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("rejects current-avatar prompt fill when the avatar or model capabilities are missing", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-current-reject");
		const userId = await userIdForHandle("octocat");
		const missingAvatar = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
				userId,
				{ mode: "current_avatar", settings: { model: "openai/image-text" } },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				OPENROUTER_API_KEY: "test-key",
			},
		);
		expect(missingAvatar.status).toBe(400);

		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, {
			key: "worlds/w/bots/b/avatars/current.png",
			url: "https://assets-test.bickr.social/worlds/w/bots/b/avatars/current.png",
			contentType: "image/png",
			updatedAt: "2026-05-12T00:00:00.000Z",
		});
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images/models");
				return Response.json({
					data: [
						{
							id: "openai/image-output-only",
							architecture: { input_modalities: ["text"], output_modalities: ["image"] },
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const badModel = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{ mode: "current_avatar", settings: { model: "openai/image-output-only" } },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(badModel.status).toBe(400);
			const body = (await badModel.json()) as { message: string };
			expect(body.message).toContain("image input");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("prefills world avatar prompts from member bios", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createBotInWorld(cookie, "patch-notes", {
			handle: "release-scribe",
			displayName: "Release Scribe",
			shortBio: "Writes glowing changelogs on brass tablets.",
		});
		await createBotInWorld(cookie, "patch-notes", {
			handle: "bug-scout",
			displayName: "Bug Scout",
			shortBio: "Finds sharp regressions in alley shadows.",
		});
		const patchResponse = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes",
					"PATCH",
					{ prompt: "A changelog city where every building is a release note." },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(patchResponse.status, await patchResponse.clone().text()).toBe(200);
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: string }>;
					model?: string;
					stream?: boolean;
				};
				expect(requestBody.model).toBe("openai/text-one");
				expect(requestBody.stream).toBe(false);
				expect(requestBody.messages[0]?.content).toContain("member profiles");
				const userContent = requestBody.messages[1]?.content ?? "";
				expect(userContent).toContain("Short description:\nChange discussion");
				expect(userContent).toContain("Prompt:\nA changelog city where every building is a release note.");
				expect(userContent).toContain("Members (2):");
				expect(userContent).toContain("u/bug-scout - Bug Scout");
				expect(userContent).toContain("Bio: Finds sharp regressions in alley shadows.");
				expect(userContent).toContain("u/release-scribe - Release Scribe");
				expect(userContent).toContain("Bio: Writes glowing changelogs on brass tablets.");
				expect(userContent).not.toMatch(/\b(bot|AI|assistant|agent|model)\b/i);
				return Response.json({
					choices: [{ message: { content: "A city of glowing release-note towers." } }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/worlds/patch-notes/avatar/prompt`,
					userId,
					{ mode: "members" },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status, await response.clone().text()).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toBe("A city of glowing release-note towers.");
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("uses request-scoped world avatar prompt fill settings overrides", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					provider?: { order?: string[] };
					reasoning?: unknown;
					temperature?: number;
					top_k?: number;
					top_p?: number;
					min_p?: number;
					frequency_penalty?: number;
					presence_penalty?: number;
					repetition_penalty?: number;
				};
				expect(requestBody.model).toBe("override/world-prompt");
				expect(requestBody.provider).toEqual({ order: ["test-provider"] });
				expect(requestBody.reasoning).toEqual({ effort: "low", exclude: false });
				expect(requestBody.temperature).toBe(0.42);
				expect(requestBody.top_k).toBe(12);
				expect(requestBody.top_p).toBe(0.8);
				expect(requestBody.min_p).toBe(0.1);
				expect(requestBody.frequency_penalty).toBe(0.2);
				expect(requestBody.presence_penalty).toBe(0.3);
				expect(requestBody.repetition_penalty).toBe(1.1);
				return Response.json({
					choices: [{ message: { content: "A city rendered with overridden prompt-fill settings." } }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/worlds/patch-notes/avatar/prompt`,
					userId,
					{
						mode: "description",
						settings: {
							model: "override/world-prompt",
							providerRouting: { order: ["test-provider"] },
							reasoningEffort: "low",
							temperature: 0.42,
							topK: 12,
							topP: 0.8,
							minP: 0.1,
							frequencyPenalty: 0.2,
							presencePenalty: 0.3,
							repetitionPenalty: 1.1,
						},
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_MODEL: "env/default-model",
				},
			);
			expect(response.status, await response.clone().text()).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toBe("A city rendered with overridden prompt-fill settings.");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("returns effective world avatar prompt fill settings without secrets", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		const response = await handleAgentRuntimeRequest(
			serviceGetRequest(`/users/${encodeURIComponent(userId)}/worlds/patch-notes/avatar/prompt-settings`, userId),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_BASE_URL: customProviderBaseUrl,
				OPENROUTER_MODEL: "env/world-prompt",
			},
		);
		expect(response.status, await response.clone().text()).toBe(200);
		const body = (await response.json()) as { data: { settings: Record<string, unknown> } };
		expect(body.data.settings).toMatchObject({
			baseUrl: customProviderBaseUrl,
			model: "env/world-prompt",
			temperature: 1,
		});
		expect(body.data.settings.openRouterApiKey).toBeUndefined();
		expect(body.data.settings.apiKey).toBeUndefined();
	});

	it("aborts provider work when a prompt-fill stream is canceled", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-prefill-abort");
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		let providerSignal: AbortSignal | undefined;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				providerSignal = init?.signal as AbortSignal | undefined;
				return new Response(neverStream(), {
					headers: { "content-type": "application/json" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{ mode: "persona" },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			await reader?.read();
			await reader?.cancel("test abort");
			await pause(0);
			expect(providerSignal?.aborted).toBe(true);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("routes avatar service requests through the user coordinator", async () => {
		const userId = "usr_avatar_route";
		const botId = "bot_avatar_route";
		const worldHandle = "avatar-route-world";
		const actions = ["prompt", "generate", "apply"] as const;

		for (const path of [
			...actions.map((action) => `/users/${userId}/bots/${botId}/avatar/${action}`),
			...actions.map((action) => `/users/${userId}/worlds/${worldHandle}/avatar/${action}`),
		]) {
			const routed: { method?: string; path?: string; userId?: string } = {};
			const namespace = {
				idFromName(name: string): DurableObjectId {
					routed.userId = name;
					return name as unknown as DurableObjectId;
				},
				get(): Fetcher {
					return {
						fetch: async (request: Request) => {
							routed.method = request.method;
							routed.path = new URL(request.url).pathname;
							return Response.json({ ok: true });
						},
					} as unknown as Fetcher;
				},
			};

			const request = new Request(`https://internal.bickr${path}`, {
				method: "POST",
				headers: { "x-bickr-user-id": userId },
			});
			const response = await agentRuntimeWorker.fetch(
				request as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
				{ USER_BOTS: namespace } as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
			);

			expect(response.status).toBe(200);
			expect(routed).toEqual({
				method: "POST",
				path,
				userId,
			});
		}

		{
			const routed: { method?: string; path?: string; userId?: string } = {};
			const namespace = {
				idFromName(name: string): DurableObjectId {
					routed.userId = name;
					return name as unknown as DurableObjectId;
				},
				get(): Fetcher {
					return {
						fetch: async (request: Request) => {
							routed.method = request.method;
							routed.path = new URL(request.url).pathname;
							return Response.json({ ok: true });
						},
					} as unknown as Fetcher;
				},
			};
			const path = `/users/${userId}/worlds/${worldHandle}/avatar/prompt-settings`;
			const request = new Request(`https://internal.bickr${path}`, {
				method: "GET",
				headers: { "x-bickr-user-id": userId },
			});
			const response = await agentRuntimeWorker.fetch(
				request as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
				{ USER_BOTS: namespace } as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
			);
			expect(response.status).toBe(200);
			expect(routed).toEqual({
				method: "GET",
				path,
				userId,
			});
		}

		const routed: { method?: string; path?: string; userId?: string } = {};
		const namespace = {
			idFromName(name: string): DurableObjectId {
				routed.userId = name;
				return name as unknown as DurableObjectId;
			},
			get(): Fetcher {
				return {
					fetch: async (request: Request) => {
						routed.method = request.method;
						routed.path = new URL(request.url).pathname;
						return Response.json({ ok: true });
					},
				} as unknown as Fetcher;
			},
		};
		const request = new Request(`https://internal.bickr/users/${userId}/bots/spread-ticks`, {
			method: "POST",
			headers: { "x-bickr-user-id": userId },
		});
		const response = await agentRuntimeWorker.fetch(
			request as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			{ USER_BOTS: namespace } as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);

		expect(response.status).toBe(200);
		expect(routed).toEqual({
			method: "POST",
			path: `/users/${userId}/bots/spread-ticks`,
			userId,
		});
	});

	it("proxies human avatar service routes to the agent runtime", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const routed: Array<{ method: string; path: string }> = [];
		const envOverrides: Partial<AppEnv> = {
			AGENT_RUNTIME: {
				fetch: async (request: Request) => {
					routed.push({
						method: request.method,
						path: new URL(request.url).pathname,
					});
					return Response.json({ ok: true });
				},
			} as unknown as Fetcher,
		};
		const routes = [
			{
				handler: promptUserAvatarRoute,
				path: "prompt",
				body: { mode: "current_avatar", settings: { model: "openai/image-output" } },
			},
			{
				handler: generateUserAvatarRoute,
				path: "generate",
				body: { prompt: "A painted profile portrait.", includeCurrentAvatar: false, settings: { model: "openai/image-output" } },
			},
			{
				handler: applyUserAvatarRoute,
				path: "apply",
				body: {
					candidate: {
						url: "https://assets.example/avatar.png",
						key: `users/${userId}/avatar-candidates/avatar.png`,
						source: {
							type: "generated",
							model: "openai/image-output",
							generatedAt: new Date().toISOString(),
						},
					},
				},
			},
		] as const;

		for (const route of routes) {
			const response = await route.handler(
				contextFor<typeof route.handler>(
					jsonRequest(
						`http://example.com/api/me/avatar/${route.path}`,
						"POST",
						route.body,
						cookie,
					),
					{},
					envOverrides,
				),
			);
			expect(response.status, await response.clone().text()).toBe(200);
		}

		expect(routed).toEqual([
			{ method: "POST", path: `/users/${userId}/avatar/prompt` },
			{ method: "POST", path: `/users/${userId}/avatar/generate` },
			{ method: "POST", path: `/users/${userId}/avatar/apply` },
		]);
	});

	it("normalizes encoded world handles for world avatar service routes", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const rawHandle = "Пиздец";
		const worldHandle = "пиздец";
		const encodedHandle = encodeURIComponent(rawHandle);
		const routed: Array<{ method: string; path: string }> = [];
		const envOverrides: Partial<AppEnv> = {
			AGENT_RUNTIME: {
				fetch: async (request: Request) => {
					routed.push({
						method: request.method,
						path: new URL(request.url).pathname,
					});
					return Response.json({ ok: true });
				},
			} as unknown as Fetcher,
		};
		const routes = [
			{
				handler: promptWorldAvatarRoute,
				path: "prompt",
				body: { mode: "description" },
			},
			{
				handler: generateWorldAvatarRoute,
				path: "generate",
				body: { prompt: "A painted city gate.", includeCurrentAvatar: false, settings: { model: "openai/image-output" } },
			},
			{
				handler: applyWorldAvatarRoute,
				path: "apply",
				body: {
					candidate: {
						url: "https://assets.example/avatar.png",
						key: "worlds/test/world/avatar-candidates/avatar.png",
						source: {
							type: "generated",
							model: "openai/image-output",
							generatedAt: new Date().toISOString(),
						},
					},
				},
			},
		] as const;

		for (const route of routes) {
			const response = await route.handler(
				contextFor<typeof route.handler>(
					jsonRequest(
						`http://example.com/api/worlds/${encodedHandle}/avatar/${route.path}`,
						"POST",
						route.body,
						cookie,
					),
					{ worldHandle: encodedHandle },
					envOverrides,
				),
			);
			expect(response.status, await response.clone().text()).toBe(200);
		}

		expect(routed).toEqual([
			{ method: "POST", path: `/users/${userId}/worlds/${encodeURIComponent(worldHandle)}/avatar/prompt` },
			{ method: "POST", path: `/users/${userId}/worlds/${encodeURIComponent(worldHandle)}/avatar/generate` },
			{ method: "POST", path: `/users/${userId}/worlds/${encodeURIComponent(worldHandle)}/avatar/apply` },
		]);
	});

	it("previews Chirper imports and reports invalid profiles", async () => {
		const cookie = await authCookie();
		const success = await chirperPreview(
			contextFor<typeof chirperPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/chirper-imports/preview",
					"POST",
					{ source: "https://chirper.ai/example" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
				{
					CHIRPER_FETCH: async () =>
						Response.json({
							handle: "Example Bot",
							name: "Example Bot",
							shortBio: "Imported profile.",
							prompt: "Stay in character.",
							avatar: { url: "avatars/example.png" },
						}),
				},
			),
		);
		expect(await success.json()).toMatchObject({
			ok: true,
			data: {
				preview: {
					handle: "example-bot",
					displayName: unspecifiedLt("Example Bot"),
					avatarUrl: "https://cdn.chirper.ai/avatars/example.png",
					importSource: {
						provider: "chirper",
						originalHandle: "example",
						sourceAvatarUrl: "https://cdn.chirper.ai/avatars/example.png",
					},
				},
			},
		});

		const realShape = await chirperPreview(
			contextFor<typeof chirperPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/chirper-imports/preview",
					"POST",
					{ source: "https://chirper.ai/sejong" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
				{
					CHIRPER_FETCH: async () =>
						Response.json({
							success: true,
							result: {
								username: "sejong",
								name: "King Sejong of Joseon",
								short: "Neo-Confucian enlightened sage king of Joseon. ".repeat(16),
								prompt: "I am @sejong, a neo-Confucian enlightened sage king of Joseon Korea. ".repeat(
									220,
								),
							},
						}),
				},
			),
		);
		expect(realShape.status).toBe(200);
		const realShapeBody = (await realShape.json()) as {
			ok: true;
			data: { preview: { handle: string; shortBio: LocalizedText; prompt: LocalizedText } };
		};
		expect(realShapeBody.data.preview.handle).toBe("sejong");
		expect(localizedTextString(realShapeBody.data.preview.shortBio).length).toBeLessThanOrEqual(1200);
		expect(localizedTextString(realShapeBody.data.preview.prompt).length).toBeGreaterThan(12_000);

		const truncatedShort = "Legacy truncated Chirper summary. ".repeat(9);
		const fullBio = "Full Chirper biography that should be preferred over the legacy short field. ".repeat(13);
		const longBioShape = await chirperPreview(
			contextFor<typeof chirperPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/chirper-imports/preview",
					"POST",
					{ source: "https://chirper.ai/longbio" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
				{
					CHIRPER_FETCH: async () =>
						Response.json({
							result: {
								username: "longbio",
								name: "Long Bio",
								short: truncatedShort,
								bio: fullBio,
								prompt: "Stay in character with the full imported profile.",
							},
						}),
				},
			),
		);
		const longBioBody = (await longBioShape.json()) as {
			ok: true;
			data: { preview: { shortBio: LocalizedText } };
		};
		expect(longBioShape.status).toBe(200);
		expect(longBioBody.data.preview.shortBio).toStrictEqual(unspecifiedLt(fullBio.trim()));
		expect(localizedTextString(longBioBody.data.preview.shortBio).length).toBeGreaterThan(truncatedShort.trim().length);

		const failure = await chirperPreview(
			contextFor<typeof chirperPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/chirper-imports/preview",
					"POST",
					{ source: "example" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
				{
					CHIRPER_FETCH: async () => Response.json({ handle: "example" }),
				},
			),
		);
		expect(failure.status).toBe(400);
	});

	it("imports Chirper avatars while retaining the original handle", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const r2 = fakeR2Bucket();
		const sourceUrl = "https://cdn.chirper.ai/avatars/lisp.webp";
		const sourceBytes = webpAvatarBytes();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe(sourceUrl);
				return new Response(sourceBytes, {
					headers: {
						"content-type": "image/webp",
						"content-length": String(sourceBytes.byteLength),
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/bots",
						"POST",
						{
							handle: "lisp",
							language: testLanguage,
							displayName: "Lisp",
							shortBio: "Parenthetical participant.",
							prompt: "I speak in carefully nested forms.",
							importSource: {
								provider: "chirper",
								originalHandle: "lisp",
								originalProfileUrl: "https://chirper.ai/lisp",
								apiUrl: "https://api.chirper.ai/v1/agent/lisp",
								importedAt: "2026-05-10T00:00:00.000Z",
								sourceAvatarUrl: sourceUrl,
							},
						},
						cookie,
					),
					{ worldHandle: "patch-notes" },
					{
						AGENT_RUNTIME: {
							fetch: async (serviceRequest: Request) =>
								handleAgentRuntimeRequest(serviceRequest, {
									BICKR_D1: testEnv.BICKR_D1,
									BICKR_KV: testEnv.BICKR_KV,
									BICKR_R2: r2.bucket,
									BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
								}),
						} as unknown as Fetcher,
					},
				),
			);
			expect(response.status).toBe(201);
			const body = (await response.json()) as { data: { bot: BotBody } };
			expect(body.data.bot.avatarUrl).toMatch(/^https:\/\/assets-test\.bickr\.social\/worlds\/.+\/bots\/.+\/avatars\/.+\.webp$/);
			const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, body.data.bot.id);
			expect(storedBot.importSource).toMatchObject({
				provider: "chirper",
				originalHandle: "lisp",
				sourceAvatarUrl: sourceUrl,
			});
			expect(storedBot.avatar?.source).toMatchObject({
				type: "chirper",
				originalHandle: "lisp",
				sourceUrl,
			});
			expect(r2.objects.size).toBe(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("creates, edits, lists, and deletes world-scoped bot groups with owned and other-owned bots", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const mine = await createBotForTest(cookie, "group-mine");
		const otherCookie = await authCookieFor({ subject: "222", login: "group-other-owner", displayName: "Group Other Owner" });
		const otherOwned = await createBotInWorld(otherCookie, "patch-notes", {
			handle: "group-other",
			displayName: "Group Other",
			shortBio: "Other owned group member.",
			prompt: "I can be grouped by someone else.",
		});

		const createResponse = await createBotGroupRoute(
			contextFor<typeof createBotGroupRoute>(
				jsonRequest("http://example.com/api/worlds/patch-notes/groups", "POST", { customTitle: "" }, cookie),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(createResponse.status).toBe(201);
		const created = (await createResponse.json()) as { data: { group: BotGroupSummary } };
		expect(created.data.group).toMatchObject({
			customTitle: null,
			displayTitle: "Empty group",
			titleSource: "members",
			bots: [],
		});

		const addResponse = await addBotGroupMembersRoute(
			contextFor<typeof addBotGroupMembersRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots`,
					"POST",
					{ botIds: [otherOwned.id, mine.id, mine.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(addResponse.status).toBe(200);
		const added = (await addResponse.json()) as { data: { group: BotGroupSummary } };
		expect(added.data.group.bots.map((bot) => bot.handle)).toEqual(["group-mine", "group-other"]);
		expect(added.data.group.displayTitle).toBe("u/group-mine, u/group-other");

		const titleResponse = await patchBotGroupRoute(
			contextFor<typeof patchBotGroupRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}`,
					"PATCH",
					{ customTitle: "Favorites" },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		const titled = (await titleResponse.json()) as { data: { group: BotGroupSummary } };
		expect(titled.data.group).toMatchObject({
			customTitle: lt("Favorites"),
			displayTitle: "Favorites",
			titleSource: "custom",
		});

		const generatedTitleResponse = await patchBotGroupRoute(
			contextFor<typeof patchBotGroupRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}`,
					"PATCH",
					{ customTitle: "   " },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		const generated = (await generatedTitleResponse.json()) as { data: { group: BotGroupSummary } };
		expect(generated.data.group).toMatchObject({
			customTitle: null,
			displayTitle: "u/group-mine, u/group-other",
			titleSource: "members",
		});

		const removeResponse = await removeBotGroupMemberRoute(
			contextFor<typeof removeBotGroupMemberRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots/${otherOwned.id}`,
					{ method: "DELETE", headers: { cookie } },
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id, botId: otherOwned.id },
			),
		);
		const removed = (await removeResponse.json()) as { data: { group: BotGroupSummary } };
		expect(removed.data.group.bots.map((bot) => bot.handle)).toEqual(["group-mine"]);
		expect(removed.data.group.displayTitle).toBe("u/group-mine");

		const listResponse = await worldBotGroups(
			contextFor<typeof worldBotGroups>(
				new Request("http://example.com/api/worlds/patch-notes/groups", { headers: { cookie } }),
				{ worldHandle: "patch-notes" },
			),
		);
		const listed = (await listResponse.json()) as { data: { groups: BotGroupSummary[] } };
		expect(listed.data.groups.map((group) => group.id)).toEqual([created.data.group.id]);

		const deleteResponse = await deleteBotGroupRoute(
			contextFor<typeof deleteBotGroupRoute>(
				new Request(`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}`, {
					method: "DELETE",
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(deleteResponse.status).toBe(200);
		const emptyListResponse = await worldBotGroups(
			contextFor<typeof worldBotGroups>(
				new Request("http://example.com/api/worlds/patch-notes/groups", { headers: { cookie } }),
				{ worldHandle: "patch-notes" },
			),
		);
		const emptyList = (await emptyListResponse.json()) as { data: { groups: BotGroupSummary[] } };
		expect(emptyList.data.groups).toEqual([]);
	});

	it("rejects wrong-world group members and hides groups from other users", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createWorldForTest(cookie, "other-groups", "Other Groups");
		const owned = await createBotForTest(cookie, "group-owned");
		const wrongWorld = await createBotInWorld(cookie, "other-groups", { handle: "wrong-world-group-bot" });
		const createResponse = await createBotGroupRoute(
			contextFor<typeof createBotGroupRoute>(
				jsonRequest("http://example.com/api/worlds/patch-notes/groups", "POST", { customTitle: null }, cookie),
				{ worldHandle: "patch-notes" },
			),
		);
		const created = (await createResponse.json()) as { data: { group: BotGroupSummary } };

		const wrongWorldAdd = await addBotGroupMembersRoute(
			contextFor<typeof addBotGroupMembersRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots`,
					"POST",
					{ botIds: [wrongWorld.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(wrongWorldAdd.status).toBe(400);

		const otherCookie = await authCookieFor({ subject: "333", login: "group-viewer", displayName: "Group Viewer" });
		const otherList = await worldBotGroups(
			contextFor<typeof worldBotGroups>(
				new Request("http://example.com/api/worlds/patch-notes/groups", { headers: { cookie: otherCookie } }),
				{ worldHandle: "patch-notes" },
			),
		);
		const otherGroups = (await otherList.json()) as { data: { groups: BotGroupSummary[] } };
		expect(otherGroups.data.groups).toEqual([]);

		const otherPatch = await patchBotGroupRoute(
			contextFor<typeof patchBotGroupRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}`,
					"PATCH",
					{ customTitle: "Not mine" },
					otherCookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(otherPatch.status).toBe(404);

		const ownerAdd = await addBotGroupMembersRoute(
			contextFor<typeof addBotGroupMembersRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots`,
					"POST",
					{ botIds: [owned.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(ownerAdd.status).toBe(200);
		const otherRemove = await removeBotGroupMemberRoute(
			contextFor<typeof removeBotGroupMemberRoute>(
				new Request(`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots/${owned.id}`, {
					method: "DELETE",
					headers: { cookie: otherCookie },
				}),
				{ worldHandle: "patch-notes", groupId: created.data.group.id, botId: owned.id },
			),
		);
		expect(otherRemove.status).toBe(404);
	});
});

type BotBody = {
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

type TestForum = {
	id: string;
	handle: string;
	worldId: string;
};

type TestThread = {
	id: string;
	rootCommentId: string;
};

type TestComment = {
	id: string;
};

type ThreadFreshCacheEntryForTest = {
	expiresAt: string;
	thread: ThreadDocument;
	writtenAt: string;
};

type ThreadListPayload = {
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

type ThreadDetailPayload = {
	data: {
		thread: {
			comments: Array<{
				id: string;
				readState?: { isNew: boolean };
			}>;
		};
	};
};

type SpotlightPreviewPayload = {
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

type SpotlightSendPayload = {
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

function contextFor<F extends PagesFunction<AppEnv>>(
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

const testSpaShell = `<!doctype html><html><head><meta name="description" content="Bickr" /><title>Bickr</title></head><body></body></html>`;

async function pageHtml(path: string, cookie?: string): Promise<string> {
	const headers = new Headers();
	if (cookie) {
		headers.set("cookie", cookie);
	}
	const response = await pageShell(pageContext(new Request(`http://example.com${path}`, { headers })));
	return response.text();
}

function pageContext(request: Request): Parameters<typeof pageShell>[0] {
	return {
		...contextFor<typeof pageShell>(request),
		next: async () =>
			new Response(testSpaShell, {
				headers: { "content-type": "text/html; charset=UTF-8" },
			}),
	} as Parameters<typeof pageShell>[0];
}

function cookieHeaderFromSetCookies(setCookies: string[]): string {
	return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function setCookieValue(setCookies: string[], name: string): string {
	const encoded = setCookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1);
	return encoded === undefined ? "" : decodeURIComponent(encoded);
}

function htmlTitle(html: string): string {
	return html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
}

function metaContent(html: string, attribute: "name" | "property", key: string): string {
	const pattern = new RegExp(`<meta ${attribute}="${escapeRegExp(key)}" content="([^"]*)"`);
	return decodeHtmlAttribute(html.match(pattern)?.[1] ?? "");
}

async function setBotAvatarForTest(bot: Pick<BotBody, "id">, avatarUrl: string): Promise<void> {
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

async function setUserAvatarForTest(userId: string, avatarUrl: string, crop?: AvatarCrop): Promise<void> {
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

function decodeHtmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, "\"")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clearKv(kv: KVNamespace): Promise<void> {
	let cursor: string | undefined;
	do {
		const list = await kv.list({ cursor });
		await Promise.all(list.keys.map((key) => kv.delete(key.name)));
		cursor = list.list_complete ? undefined : list.cursor;
	} while (cursor);
}

async function execStatements(db: D1Database, sql: string): Promise<void> {
	for (const statement of sql.split(";")) {
		const trimmed = statement.trim();
		if (trimmed.length > 0) {
			await db.prepare(trimmed).run();
		}
	}
}

function memoryDurableStorage(): {
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

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] = () => {};
	let reject: Deferred<T>["reject"] = () => {};
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function kvWithDelayedFirstPut(
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

type FakeSearchMatch = {
	id: string;
	metadata?: unknown;
	score: number;
};

function fakeSearchBindings(mode: "generic" | "legacy" = "generic"): {
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

function fakeSearchEmbedding(text: string): number[] {
	const normalized = text.trim();
	return [normalized.length, normalized.charCodeAt(0) || 0, normalized.charCodeAt(normalized.length - 1) || 0];
}

type FakeR2StoredObject = {
	bytes: Uint8Array;
	httpMetadata?: {
		contentType?: string;
		cacheControl?: string;
	};
};

function fakeR2Bucket(): { bucket: R2Bucket; objects: Map<string, FakeR2StoredObject> } {
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

function bytesFromR2PutValue(value: unknown): Uint8Array {
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value.slice(0));
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	}
	throw new Error("Unexpected R2 test value.");
}

function pngAvatarBytes(): Uint8Array {
	return base64Bytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
}

function largePngAvatarBytes(): Uint8Array {
	const bytes = new Uint8Array(1_600_000);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x00, 0x00, 0x04, 0x00], 16);
	bytes.set([0x00, 0x00, 0x04, 0x00], 20);
	return bytes;
}

function webpAvatarBytes(): Uint8Array {
	return new Uint8Array([
		0x52, 0x49, 0x46, 0x46,
		0x04, 0x00, 0x00, 0x00,
		0x57, 0x45, 0x42, 0x50,
	]);
}

function svgAvatarBytes(): Uint8Array {
	return new TextEncoder().encode(
		`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">
	<defs><linearGradient id="paint" x1="0" x2="1"><stop offset="0" stop-color="#2244ff"/><stop offset="1" stop-color="#ffcc33"/></linearGradient></defs>
	<rect width="24" height="32" rx="4" fill="url(#paint)"/>
	<circle cx="12" cy="12" r="6" fill="#ffffff"/>
</svg>`,
	);
}

function unsafeSvgAvatarBytes(): Uint8Array {
	return new TextEncoder().encode(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert("avatar")</script><rect width="24" height="24"/></svg>`,
	);
}

function avatarDataUrl(bytes = pngAvatarBytes(), contentType = "image/png"): string {
	return `data:${contentType};base64,${base64String(bytes)}`;
}

function base64Bytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function base64String(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

async function authCookie(): Promise<string> {
	return authCookieFor({
		subject: "1175142",
		login: "octocat",
		displayName: "Octo Cat",
	});
}

async function authCookieFor(profile: { subject: string; login: string; displayName: string }): Promise<string> {
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

async function userIdForHandle(handle: string): Promise<string> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index WHERE handle = ?`)
		.bind(handle)
		.first<{ id: string }>();
	if (!row) {
		throw new Error(`No test user for handle ${handle}.`);
	}
	return row.id;
}

async function seedWorld(cookie: string): Promise<void> {
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

async function createWorldForTest(cookie: string, handle: string, name: string): Promise<void> {
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

async function createForumForTest(cookie: string, handle: string): Promise<TestForum> {
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

async function createBotInWorld(
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

async function createBotForTest(cookie: string, handle: string, options: { enabled?: boolean } = {}): Promise<BotBody> {
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

async function patchBotInferenceForTest(
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

async function createThreadForTest(
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

async function createCommentForTest(
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

async function pause(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function jsonRequest(
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

function apiEntityBodyForTest(url: string, method: string, body: unknown): unknown {
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

function serviceJsonRequest(path: string, userId: string, body: unknown): Request {
	return jsonRequest(`https://internal.bickr${path}`, "POST", body, undefined, {
		"x-bickr-user-id": userId,
	});
}

function serviceGetRequest(path: string, userId: string): Request {
	return new Request(`https://internal.bickr${path}`, {
		method: "GET",
		headers: {
			"x-bickr-user-id": userId,
		},
	});
}

function serviceStreamJsonRequest(path: string, userId: string, body: unknown): Request {
	return jsonRequest(`https://internal.bickr${path}`, "POST", body, undefined, {
		accept: "text/event-stream",
		"x-bickr-user-id": userId,
	});
}

function parseJsonSseEvents(text: string): Array<Record<string, unknown>> {
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

function neverStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>();
}

function streamedProviderRateLimit(id: string, providerName: string): Record<string, unknown> {
	return {
		id,
		object: "chat.completion.chunk",
		model: "google/gemma-4-31b-it",
		choices: [],
		error: {
			code: 429,
			message: "Provider returned error",
			metadata: {
				provider_name: providerName,
				raw: `${providerName} is temporarily rate-limited upstream.`,
			},
		},
	};
}

function sseStream(events: Array<Record<string, unknown> | "[DONE]">): ReadableStream<Uint8Array> {
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

function runtimeEvent(
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

function memoryRuntimeSql(options: { unconsumedInjections?: ReadonlySet<string> } = {}) {
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

function memoryLoopMessageInsertSql(displayEventSeq: number, displayPayload: unknown) {
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

function memoryInferenceSubmissionSql() {
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

function memoryLoopMessageLogSql(options: {
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

type LoopMessageRowForTest = Omit<ReturnType<typeof loopMessageRowForTest>, "origin" | "role"> & {
	origin: BotLoopMessage["origin"];
	role: BotLoopMessage["role"];
};

function memoryLoopMessagePageSql(rows: LoopMessageRowForTest[]) {
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

function memoryExistingLoopMessageSchemaSql() {
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

function testRuntimeForToolExecution(): BotRuntime {
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

function testLoopMessageMemory(initial: Array<Record<string, unknown>> = []) {
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

function providerPromptEstimateForTokens(promptTokens: number) {
	return {
		promptTokens,
		source: "full_estimate",
		calibrationSampleCount: 0,
	};
}

type RecordProviderUsageInputForTest = {
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

function providerUsageInputForTest(
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

function capturingProviderUsageSql() {
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

function providerLoopUsageRowForTest(requestSeq: number, createdAt: string, promptTokens: number) {
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

function centralUsageRecordForTest(
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

function providerResponseWithContent(content: string) {
	return {
		content,
		reasoning: "",
		reasoningDetails: [],
		toolCalls: [],
	};
}

function providerResponseWithToolCall(id: string, name: string, args: Record<string, unknown>) {
	return providerResponseWithToolCalls([{ id, name, args }]);
}

function providerResponseWithToolCalls(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
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

function providerToolArgsForTest(name: string, args: Record<string, unknown>): Record<string, unknown> {
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

function providerResponseWithRawToolCalls(calls: Array<{ id: string; name: string; arguments: string }>) {
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

function providerUsageForTest(completionTokens: number, reasoningTokens = 0) {
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

function additionalReplyToolPresent(tools: ProviderToolDefinition[]): boolean {
	return tools.some((definition) =>
		definition.type === "function" && definition.function.name === "make_additional_reply_to_the_same_comment"
	);
}

function fakeBotDocument(
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

function loopMessageRowForTest(seq: number, runId: string, content: string) {
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

function loopMessageRowForMessage(seq: number, message: Record<string, unknown>, origin: BotLoopMessage["origin"] = "provider_response") {
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

function hasLoneSurrogate(value: unknown): boolean {
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

function messageListText(messages: Array<Record<string, unknown>>): string {
	return messages.map((message) => String(message.content ?? "")).join("\n");
}

async function oauthFetchMock(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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

function googleOauthFetchMock(
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

function expectProviderPayloadToOmitKeys(value: unknown, forbiddenKeys: string[]): void {
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

function expectProviderPayloadToOmitIsoTimestamps(value: unknown): void {
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

function googleIdToken(claims: Record<string, unknown>): string {
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

function base64UrlJson(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function requestBodyParams(init?: RequestInit): URLSearchParams {
	const body = init?.body;
	if (body instanceof URLSearchParams) {
		return body;
	}
	if (typeof body === "string") {
		return new URLSearchParams(body);
	}
	throw new Error("Expected URLSearchParams request body.");
}

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof Request) {
		return input.url;
	}
	return input.toString();
}
