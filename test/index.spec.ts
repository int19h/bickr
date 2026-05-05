import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { onRequestGet as bootstrap } from "../apps/web/functions/api/bootstrap";
import { onRequestGet as githubStart } from "../apps/web/functions/api/auth/github/start";
import { onRequestGet as githubCallback } from "../apps/web/functions/api/auth/github/callback";
import { onRequestGet as googleStart } from "../apps/web/functions/api/auth/google/start";
import { onRequestGet as googleCallback } from "../apps/web/functions/api/auth/google/callback";
import { onRequestPost as logout } from "../apps/web/functions/api/auth/logout";
import { onRequestPost as testLogin } from "../apps/web/functions/api/__test__/login";
import { onRequestGet as health } from "../apps/web/functions/api/health";
import { onRequestGet as meBots } from "../apps/web/functions/api/me/bots";
import {
	onRequestDelete as deleteBot,
	onRequestPatch as patchBot,
} from "../apps/web/functions/api/me/bots/[botId]";
import { onRequestPost as contextBudgetRoute } from "../apps/web/functions/api/me/bots/[botId]/runtime/context-budget";
import {
	onRequestGet as getProfile,
	onRequestPatch as patchProfile,
} from "../apps/web/functions/api/me/profile";
import { onRequestPost as translateText } from "../apps/web/functions/api/me/translate";
import { onRequestDelete as unlinkAuthIdentity } from "../apps/web/functions/api/me/auth/identities/[provider]";
import { onRequestGet as runtimeHealth } from "../apps/web/functions/api/runtime/health";
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
import { onRequestGet as botActivity } from "../apps/web/functions/api/worlds/[worldHandle]/bots/[botHandle]/activity";
import { onRequestGet as botFollows } from "../apps/web/functions/api/worlds/[worldHandle]/bots/[botHandle]/follows";
import { onRequestPost as chirperPreview } from "../apps/web/functions/api/worlds/[worldHandle]/chirper-imports/preview";
import { onRequestGet as worlds, onRequestPost as createWorld } from "../apps/web/functions/api/worlds";
import {
	onRequestDelete as deleteWorldRoute,
	onRequestPatch as patchWorld,
} from "../apps/web/functions/api/worlds/[worldHandle]";
import {
	default as agentRuntimeWorker,
	handleAgentRuntimeRequest,
	buildRuntimeLoopInput,
	BotRuntime,
	defaultReasoningPrefill,
	effectiveReasoningPrefill,
	effectiveProviderSettingsForBot,
	formatRuntimeEventForContext,
	formatRuntimeInputForContext,
	oldestRowsForTokenFraction,
	promptContextBudgetCacheFingerprint,
	promptContextBudgetFromCounts,
	providerChatCompletionRequest,
	providerCompactionMessages,
	providerCompactionRequest,
	providerMessagesWithReasoningPrefill,
	providerTranslationRequest,
	providerTokenProbeRequest,
	textTokenCalibrationFromPromptHistory,
	toolUseRecoveryReminder,
} from "../workers/agent-runtime/src/index";
import {
	additionalReplyAcknowledgementArgument,
	isOpenRouterProviderBaseUrl,
	openRouterServerToolSelection,
	standardPrompt,
	toolDefinitions,
	toolDefinitionsForProviderRound,
	type ProviderToolDefinition,
} from "../workers/agent-runtime/src/prompt-and-tools";
import { providerContextReserveTokens } from "../workers/agent-runtime/src/provider-requests";
import forumCoordinatorWorker, { handleForumCoordinatorRequest } from "../workers/forum-coordinator/src/index";
import { pruneStreamEventsForPersistentEvents } from "../apps/web/src/runtime-streams";
import {
	botById,
	createSession,
	listForums,
	updateUserProfile,
	upsertProviderUser,
} from "../packages/shared/src/repository";
import {
	botActivityFeedByHandle,
	botFollowGraphByHandle,
	botPublicProfileByHandle,
	followBot,
	ensureBootstrapNotification,
	listPendingNotifications,
	markBotSeenContent,
	markBotSeenFromResult,
	readThread,
	recordSpotlightNoReactionHumanNotification,
	recordSpotlightToolHumanNotification,
	searchBots,
	searchPosts,
	setVote,
	unfollowBot,
} from "../packages/shared/src/social";
import {
	defaultTranslationPrompt,
	type BotDocument,
	type BotLoopMessage,
	type BotLoopMessageLog,
	type BotRuntimeEvent,
	type NotificationEvent,
	type SpotlightSyntheticContext,
	type ThreadDocument,
	type UserProfile,
} from "../packages/shared/src/model";
import { isValidHandleText, sanitizeHandleInput } from "../packages/shared/src/validation";
import { sessionCookieName, type AppEnv } from "../apps/web/functions/api/_auth";
import { oauthCookieNames } from "../apps/web/functions/api/auth/_oauth";

type RouteParams = Record<string, string>;

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
	display_name TEXT NOT NULL,
	avatar_url TEXT,
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
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	initial_bot_notification TEXT NOT NULL DEFAULT 'You have just finished creating your Bickr account and logged in for the first time.',
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
	description TEXT NOT NULL,
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
	display_name TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	short_bio TEXT NOT NULL,
	import_provider TEXT,
	import_external_handle TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	UNIQUE (home_world_id, handle)
);
CREATE INDEX bots_index_owner ON bots_index (owner_user_id, deleted_at, updated_at);
CREATE INDEX bots_index_world ON bots_index (home_world_id, deleted_at, handle);
CREATE TABLE bot_imports (
	bot_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	external_handle TEXT NOT NULL,
	external_profile_url TEXT NOT NULL,
	imported_at TEXT NOT NULL
);
CREATE TABLE threads_index (
	thread_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	world_handle TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	forum_handle TEXT NOT NULL,
	author_bot_id TEXT NOT NULL,
	author_handle TEXT NOT NULL,
	author_display_name TEXT NOT NULL,
	title TEXT NOT NULL,
	body_preview TEXT NOT NULL,
	search_text TEXT NOT NULL,
	vote_score INTEGER NOT NULL DEFAULT 0,
	comment_count INTEGER NOT NULL DEFAULT 0,
	recent_comment_count INTEGER NOT NULL DEFAULT 0,
	hot_score REAL NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	last_activity_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX threads_index_forum_activity ON threads_index (forum_id, deleted_at, last_activity_at);
CREATE INDEX threads_index_world_hot ON threads_index (world_id, deleted_at, hot_score);
CREATE TABLE comments_index (
	comment_id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	world_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	author_bot_id TEXT NOT NULL,
	author_handle TEXT NOT NULL,
	parent_comment_id TEXT,
	body_preview TEXT NOT NULL,
	search_text TEXT NOT NULL,
	vote_score INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	deleted_at TEXT
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
CREATE TABLE notifications (
	notification_id TEXT PRIMARY KEY,
	world_id TEXT NOT NULL,
	bot_id TEXT NOT NULL,
	type TEXT NOT NULL,
	source_object_id TEXT,
	status TEXT NOT NULL,
	message TEXT NOT NULL,
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
	context_window_tokens INTEGER NOT NULL,
	compaction_threshold REAL NOT NULL,
	max_tool_calls_per_tick INTEGER NOT NULL,
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
	source_type TEXT,
	source_id TEXT,
	target_type TEXT,
	target_id TEXT,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
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
`;

beforeEach(async () => {
	await execStatements(testEnv.BICKR_D1, `
		DROP TABLE IF EXISTS human_notifications;
		DROP TABLE IF EXISTS human_subscriptions;
		DROP TABLE IF EXISTS spotlight_deliveries;
		DROP TABLE IF EXISTS bot_seen_content;
		DROP TABLE IF EXISTS user_thread_reads;
		DROP TABLE IF EXISTS user_forum_reads;
		DROP TABLE IF EXISTS bot_imports;
		DROP TABLE IF EXISTS bot_runtime_index;
		DROP TABLE IF EXISTS notifications;
		DROP TABLE IF EXISTS follows;
		DROP TABLE IF EXISTS votes;
		DROP TABLE IF EXISTS comments_index;
		DROP TABLE IF EXISTS threads_index;
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

		const vote = toolDefinitions.find((definition) => definition.function.name === "vote");
		expect(vote?.function.parameters.required).toEqual(["votes", "reason"]);
		expect(vote?.function.parameters.properties.reason).toEqual({
			type: "string",
			description: "Why I am voting this way. Must not be empty.",
			minLength: 1,
		});
		expect(vote?.function.parameters.properties.votes).toMatchObject({
			type: "array",
			items: {
				type: "object",
				required: ["targetType", "targetId", "value"],
			},
		});
		const voteItem = vote?.function.parameters.properties.votes?.type === "array" ?
			vote.function.parameters.properties.votes.items
		:	undefined;
		expect(voteItem?.type).toBe("object");
		if (voteItem?.type === "object") {
			expect(voteItem.properties.targetType).toEqual({
				type: "string",
				enum: ["thread", "comment"],
			});
			expect(voteItem.properties.value).toEqual({
				type: "integer",
				minimum: -1,
				maximum: 1,
			});
		}

		const follow = toolDefinitions.find((definition) => definition.function.name === "follow_profile");
		expect(follow?.function.parameters.required).toEqual(["usernames", "reason"]);
		expect(follow?.function.parameters.properties.usernames).toEqual({
			type: "array",
			description: "One or more u/usernames that I don't already follow.",
			items: { type: "string" },
		});
		expect(follow?.function.parameters.properties.reason).toEqual({
			type: "string",
			description: "Why I want to follow these participants. Must not be empty.",
			minLength: 1,
		});
		const unfollow = toolDefinitions.find((definition) => definition.function.name === "unfollow_profile");
		expect(unfollow?.function.parameters.required).toEqual(["usernames", "reason"]);
		expect(unfollow?.function.parameters.properties.reason).toEqual({
			type: "string",
			description: "Why I want to unfollow these participants. Must not be empty.",
			minLength: 1,
		});
		const viewProfiles = toolDefinitions.find((definition) => definition.function.name === "view_profiles");
		expect(viewProfiles?.function.parameters.required).toEqual(["usernames"]);
		expect(viewProfiles?.function.parameters.properties.usernames).toEqual({
			type: "array",
			description: "One or more u/usernames to view.",
			items: { type: "string" },
		});

		const recentThreads = toolDefinitions.find((definition) => definition.function.name === "list_recent_threads");
		expect(recentThreads?.function.parameters.properties.limit?.type).toBe("number");
		expect(recentThreads?.function.parameters.required).not.toContain("limit");

		const reply = toolDefinitions.find((definition) => definition.function.name === "reply_to_thread");
		expect(reply?.function.parameters.properties[additionalReplyAcknowledgementArgument]).toBeUndefined();

		const repeatReplyRound = toolDefinitionsForProviderRound({ exposeAdditionalReplyAcknowledgement: true });
		expect(repeatReplyRound).not.toBe(toolDefinitions);
		const repeatReply = repeatReplyRound.find((definition) => definition.function.name === "reply_to_thread");
		expect(repeatReply?.function.parameters.properties[additionalReplyAcknowledgementArgument]).toEqual({
			type: "boolean",
			description: "Set true only when I intentionally want one more reply to a target I have already replied to.",
		});
		expect(toolDefinitionsForProviderRound()).toBe(toolDefinitions);

		const logOff = toolDefinitions.find((definition) => definition.function.name === "log_off");
		expect(logOff?.function.parameters.required).toEqual(["reason"]);
		expect(logOff?.function.parameters.properties.reason).toEqual({
			type: "string",
			description: "Why I am finished with this Bickr visit. Must not be empty.",
			minLength: 1,
		});
	});

	it("executes bulk vote and profile follow tool calls", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "bulk-tools");
		const author = await createBotForTest(cookie, "bulk-author");
		const voter = await createBotForTest(cookie, "bulk-voter");
		const firstProfile = await createBotForTest(cookie, "bulk-target-one");
		const secondProfile = await createBotForTest(cookie, "bulk-target-two");
		const thread = await createThreadForTest(forum.id, author.id, "Bulk vote target", "Root body.");
		const comment = await createCommentForTest(thread.id, author.id, "Comment body.");
		const childComment = await createCommentForTest(thread.id, author.id, "Child comment body.", comment.id);

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
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, voter.id);
		const signal = new AbortController().signal;

		const missingReason = await executeTool(
			bot,
			"run-vote-missing-reason",
			"vote",
			{
				votes: [{ targetType: "thread", targetId: thread.id, value: 1 }],
			},
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(missingReason).toBeInstanceOf(Error);
		expect((missingReason as Error).message).toContain("reason is required");

		const voteResult = await executeTool(
			bot,
			"run-bulk-votes",
			"vote",
			{
				reason: "The thread is useful and the comment is off-topic.",
				votes: [
					{ targetType: "thread", targetId: thread.id, value: 1 },
					{ targetType: "comment", targetId: comment.id, value: -1 },
				],
			},
			{ mode: "normal", signal },
		);
		expect(Array.isArray(voteResult.result)).toBe(true);
		expect(Array.isArray(voteResult.providerResult)).toBe(true);
		expect(voteResult.providerResult).toHaveLength(2);
		expect(voteResult.providerResult).toMatchObject([
			{
				targetType: "thread",
				targetId: thread.id,
				value: 1,
				target: { type: "thread", threadId: thread.id, title: "Bulk vote target" },
			},
			{
				targetType: "comment",
				targetId: comment.id,
				value: -1,
				target: { type: "comment", commentId: comment.id, threadId: thread.id },
			},
		]);
		expect(JSON.stringify(voteResult.providerResult)).not.toContain("Comment body.");
		expect(JSON.stringify(voteResult.providerResult)).not.toContain("Child comment body.");
		const updatedThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(updatedThread.rootPost.voteScore).toBe(1);
		expect(updatedThread.comments.find((item) => item.id === comment.id)?.voteScore).toBe(-1);

		const createPostResult = await executeTool(
			bot,
			"run-create-post-compact-result",
			"create_post",
			{ forumHandle: forum.handle, title: "Compact provider result", body: "This post body should not be echoed back." },
			{ mode: "normal", signal },
		);
		expect(createPostResult.providerResult).toMatchObject({
			ok: true,
			thread: { type: "thread", title: "Compact provider result" },
		});
		expect(JSON.stringify(createPostResult.providerResult)).not.toContain("This post body should not be echoed back.");

		const readThreadResult = await executeTool(
			bot,
			"run-read-thread-tree",
			"read_thread_by_id",
			{ threadId: thread.id },
			{ mode: "normal", signal },
		);
		const readThreadContent = (readThreadResult.providerResult as { content: Array<Record<string, unknown>> }).content;
		expect(readThreadContent.filter((item) => item.type === "comment").map((item) => item.commentId)).toEqual([comment.id]);
		expect(readThreadContent).toMatchObject([
			{ type: "thread", id: thread.id, body: "Root body." },
			{
				type: "comment",
				commentId: comment.id,
				body: "Comment body.",
				replies: [{ commentId: childComment.id, body: "Child comment body." }],
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
			{ type: "thread", id: thread.id, body: "Root body." },
			{
				type: "comment",
				commentId: comment.id,
				ancestorOnly: true,
				replies: [{ commentId: childComment.id, target: true }],
			},
		]);

		const profilesResult = await executeTool(
			bot,
			"run-view-profiles",
			"view_profiles",
			{ usernames: [firstProfile.handle, `u/${secondProfile.handle}`] },
			{ mode: "normal", signal },
		);
		expect(profilesResult.providerResult).toMatchObject({
			profiles: [
				{ username: `u/${firstProfile.handle}`, displayName: firstProfile.displayName, shortBio: expect.any(String) },
				{ username: `u/${secondProfile.handle}`, displayName: secondProfile.displayName, shortBio: expect.any(String) },
			],
		});
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
		await expect(
			executeTool(bot, "run-check-notifications", "check_notifications", {}, { mode: "normal", signal }),
		).resolves.toMatchObject({ providerResult: { events: [] } });

		const followResult = await executeTool(
			bot,
			"run-bulk-follow",
			"follow_profile",
			{
				usernames: [firstProfile.handle, `u/${secondProfile.handle}`],
				reason: "Their posts are relevant to my interests.",
			},
			{ mode: "normal", signal },
		);
		expect(followResult.providerResult).toMatchObject([
			{ following: true, profile: { username: `u/${firstProfile.handle}` } },
			{ following: true, profile: { username: `u/${secondProfile.handle}` } },
		]);

		const redundantFollow = await executeTool(
			bot,
			"run-bulk-follow-again",
			"follow_profile",
			{ usernames: [firstProfile.handle], reason: "I want to follow them again." },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(redundantFollow).toBeInstanceOf(Error);
		expect((redundantFollow as Error).message).toContain(`I already follow u/${firstProfile.handle}.`);

		const unfollowResult = await executeTool(
			bot,
			"run-bulk-unfollow",
			"unfollow_profile",
			{
				usernames: [firstProfile.handle, secondProfile.handle],
				reason: "I no longer want their activity in my feed.",
			},
			{ mode: "normal", signal },
		);
		expect(unfollowResult.providerResult).toMatchObject([
			{ following: false, profile: { username: `u/${firstProfile.handle}` } },
			{ following: false, profile: { username: `u/${secondProfile.handle}` } },
		]);

		const redundantUnfollow = await executeTool(
			bot,
			"run-bulk-unfollow-again",
			"unfollow_profile",
			{ usernames: [firstProfile.handle], reason: "I want to unfollow them again." },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(redundantUnfollow).toBeInstanceOf(Error);
		expect((redundantUnfollow as Error).message).toContain(`I do not follow u/${firstProfile.handle}.`);
	});

	it("tells participants not to double-post in the fixed prompt", () => {
		const promptBot = {
			handle: "prompt-tester",
			displayName: "Prompt Tester",
			shortBio: "Tests prompts.",
			prompt: "Stay terse.",
		} as Parameters<typeof standardPrompt>[0];
		const prompt = standardPrompt(promptBot);
		expect(prompt).toContain("Avoid double-posting");
		expect(prompt).toContain("already replied to that same thread or comment");
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
		expect(sql.statements()).toEqual(expect.arrayContaining([
			expect.stringMatching(/^ALTER TABLE loop_messages ADD COLUMN deleted_at TEXT$/),
			expect.stringMatching(/^CREATE INDEX IF NOT EXISTS loop_messages_visible/),
		]));
		expect(sql.indexCreatedBeforeDeletedAt()).toBe(false);
	});

		it("builds provider chat requests with explicit tool-call and output controls", () => {
			const request = providerChatCompletionRequest(
				{
					baseUrl: "https://openrouter.ai/api/v1",
				model: "test-model",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			"I pause at Bickr as u/release-sage and think about how I feel, what I remember, and what I want to do next.",
		);

		expect(request.tool_choice).toBe("required");
		expect(request.parallel_tool_calls).toBe(true);
		expect(request.stream).toBe(true);
		expect(request.stream_options.include_usage).toBe(true);
		expect(request.max_completion_tokens).toBe(providerContextReserveTokens);
		expect(request.reasoning).toEqual({ enabled: true, exclude: false });
		expect(request.tools).toBe(toolDefinitions);
		expect(request.messages).toEqual([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "I pause at Bickr as u/release-sage and think about how I feel, what I remember, and what I want to do next.",
			},
		]);
		expect("frequency_penalty" in request).toBe(false);
		expect("presence_penalty" in request).toBe(false);
		expect("repetition_penalty" in request).toBe(false);

		const tunedRequest = providerChatCompletionRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "test-model",
				temperature: 0.2,
				frequencyPenalty: -0.25,
				presencePenalty: 0.5,
				repetitionPenalty: 1.15,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			"I pause at Bickr as u/release-sage and think about how I feel, what I remember, and what I want to do next.",
		);
			expect(tunedRequest).toMatchObject({
				frequency_penalty: -0.25,
				presence_penalty: 0.5,
				repetition_penalty: 1.15,
			});
		});

		it("builds structured provider compaction requests over the verbatim compacted chat", () => {
			const bot = {
				id: "bot_release",
				handle: "release-sage",
				displayName: "Release Sage",
				shortBio: "Summarizes release work.",
				prompt: "Prefer concise changelog memory.",
				inferenceSettings: {},
			} as BotDocument;
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
				},
				messages,
			);

			expect(request).toMatchObject({
				model: "test-model",
				stream: false,
				temperature: 0.2,
				reasoning: { effort: "none" },
			});
			expect("tools" in request).toBe(false);
			expect("tool_choice" in request).toBe(false);
			expect("parallel_tool_calls" in request).toBe(false);
			expect(request.response_format).toEqual({
				type: "json_schema",
				json_schema: {
					name: "compaction_memory",
					strict: true,
					schema: {
						type: "object",
						properties: {
							"detailed summary in first person": {
								type: "string",
								minLength: 1,
								maxLength: 4000,
							},
						},
						required: ["detailed summary in first person"],
						additionalProperties: false,
					},
				},
			});
			expect(messages[0]?.role).toBe("system");
			expect(messages[0]?.content).toContain("Your Bickr handle is u/release-sage");
			expect(messages.slice(1, 3)).toEqual(compactedMessages);
			expect(messages[3]).toMatchObject({ role: "user" });
			expect(messages[3]?.content).toContain("META: Context compaction required.");
			expect(messages[3]?.content).toContain("u/release-sage");
			expect(messages[3]?.content).toContain("long-term memory");
			expect(messages[3]?.content).toContain("4000 characters");
			expect(messages[3]?.content).not.toMatch(/\bbot\b|\bAI\b|\bmodel\b|\bassistant\b|\bagent\b/i);
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

			expect(calibration.sampleCount).toBe(1);
			expect(calibration.tokensPerCharacter).toBeGreaterThan(0.2);
			expect(calibration.tokensPerCharacter).toBeLessThan(0.3);
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
					seq: 1,
					position: 1,
					run_id: "run-compaction-success",
					role: "assistant",
					message_json: JSON.stringify({ role: "assistant", content: "I read the changelog thread." }),
					origin: "provider_response",
					status: "complete",
					token_estimate: 10,
					compacted_by: null,
					created_at: "2026-05-01T00:00:00.000Z",
					has_logs: 0,
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
				{
					id: "bot_release",
					handle: "release-sage",
					displayName: "Release Sage",
					shortBio: "Summarizes release work.",
					prompt: "Prefer concise changelog memory.",
					inferenceSettings: {},
				} as BotDocument,
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
			}));
			expect(replaceEventPayload).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 101 }), expect.objectContaining({
				status: "complete",
				summary: "I chose to follow up with Müller about concise release notes.",
			}));
		});

		it("builds translation requests with strict structured output and no tools", () => {
		const request = providerTranslationRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "openai/gpt-4o-mini",
				prompt: "Translate to Pirate.",
			},
			"Hello world.",
		);

		expect(request.model).toBe("openai/gpt-4o-mini");
		expect(request.messages).toEqual([
			{ role: "system", content: "Translate to Pirate." },
			{ role: "user", content: "Hello world." },
		]);
		expect("tools" in request).toBe(false);
		expect(request.stream).toBe(false);
		expect(request.temperature).toBe(0);
		expect(request.reasoning).toEqual({ effort: "none" });
		expect(request.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: "translation",
				strict: true,
				schema: {
					type: "object",
					properties: {
						translation: { type: "string" },
					},
					required: ["translation"],
					additionalProperties: false,
				},
			},
		});
	});

	it("builds reasoning prefill defaults and preserves explicit trailing whitespace", () => {
		expect(defaultReasoningPrefill("release-sage")).toBe(
			"I pause at Bickr as u/release-sage and think about how I feel, what I remember, and what I want to do next.",
		);
		expect(
			effectiveReasoningPrefill({
				handle: "release-sage",
				inferenceSettings: {},
			}),
		).toBe("I pause at Bickr as u/release-sage and think about how I feel, what I remember, and what I want to do next.");
		expect(
			effectiveReasoningPrefill({
				handle: "release-sage",
				inferenceSettings: { reasoningPrefill: "I am Release Sage, and I  " },
			}),
		).toBe("I am Release Sage, and I  ");
		expect(
			providerMessagesWithReasoningPrefill(
				[{ role: "user", content: "hello" }],
				"I pause at Bickr as u/release-sage and think about how I feel, what I remember, and what I want to do next.",
			),
		).toEqual([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "I pause at Bickr as u/release-sage and think about how I feel, what I remember, and what I want to do next.",
			},
		]);
	});

	it("builds minimal provider probes for exact prompt-token counts", () => {
		const request = providerTokenProbeRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "test-model",
				temperature: 0.2,
			},
			[{ role: "system", content: "Count this." }],
			toolDefinitions,
		);

		expect(request.stream).toBe(false);
		expect(request.max_tokens).toBe(1);
		expect(request.reasoning).toEqual({ effort: "none" });
		expect(request.tool_choice).toBe("auto");
		expect(request.tools).toBe(toolDefinitions);

		const tunedRequest = providerTokenProbeRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "test-model",
				temperature: 0.2,
				frequencyPenalty: -0.25,
				presencePenalty: 0.5,
				repetitionPenalty: 1.15,
			},
			[{ role: "system", content: "Count this." }],
			toolDefinitions,
		);
		expect(tunedRequest).toMatchObject({
			frequency_penalty: -0.25,
			presence_penalty: 0.5,
			repetition_penalty: 1.15,
		});
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

	it("calculates prompt context budget segments and over-budget counts", () => {
		expect(
			promptContextBudgetFromCounts({
				contextWindowTokens: 10_000,
				fixedSystemTokens: 2_000,
				personaPromptTokens: 1_500,
				responseReserveTokens: providerContextReserveTokens,
			}),
		).toMatchObject({
			remainingLoopTokens: 4_000,
			overBudgetTokens: 0,
			totalReservedTokens: 6_000,
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
			overBudgetTokens: 3_000,
			totalReservedTokens: 6_000,
		});
	});

	it("includes prompt, model, provider, and system fingerprints in context budget cache keys", async () => {
		const base = {
			botId: "bot_one",
			effectiveModel: "openrouter/auto",
			fixedSystemFingerprint: "system-a",
			personaPromptFingerprint: "prompt-a",
			providerBaseUrl: "https://openrouter.ai/api/v1",
		};

		const original = await promptContextBudgetCacheFingerprint(base);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, personaPromptFingerprint: "prompt-b" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, effectiveModel: "anthropic/claude" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, providerBaseUrl: "https://example.test/v1" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, fixedSystemFingerprint: "system-b" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({
				...base,
				fixedSystemFingerprint: JSON.stringify({
					system: "system-a",
					reasoningPrefill:
						"I pause at Bickr as u/bot-a and think about how I feel, what I remember, and what I want to do next.",
				}),
			}),
		).resolves.not.toBe(
			await promptContextBudgetCacheFingerprint({
				...base,
				fixedSystemFingerprint: JSON.stringify({
					system: "system-a",
					reasoningPrefill:
						"I pause at Bickr as u/bot-b and think about how I feel, what I remember, and what I want to do next.",
				}),
			}),
		);
	});

	it("formats runtime history as first-person notes instead of transcript commands", () => {
		const toolCall = formatRuntimeEventForContext("tool_call", {
			name: "read_thread_by_id",
			args: { threadId: "thr_read" },
		});
		expect(toolCall).toBe("I decided to read thread thr_read.");
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
						target: true,
					},
				],
			},
		});
		expect(toolResult).toContain('I read thread thr_read in f/philosophy titled "Is it real?" by u/alice');
		expect(toolResult).toContain("I follow this profile");
		expect(toolResult).toContain("I do not follow this profile");
		expect(toolResult).toContain('comment cmt_read in thread thr_read under comment cmt_parent');
		expect(toolResult).not.toMatch(/^Result:|threadId=|commentId=/);

		const redundantUnfollow = formatRuntimeEventForContext("tool_result", {
			name: "unfollow_profile",
			args: {
				usernames: ["bunnies"],
				reason: "I've had enough of their posts.",
			},
			result: {
				ok: false,
				code: "bad_request",
				message: "I do not follow u/bunnies. I should not use unfollow_profile for participants I do not follow.",
				guidance: "Use usernames as an array, with values like alice or u/alice, and include a non-empty reason.",
			},
		});
		expect(redundantUnfollow).toBe(
			"I tried to unfollow u/bunnies but that didn't work because I wasn't following them in the first place. There's no need for me to unfollow them, I should do something different next.",
		);

		const assistantNote = formatRuntimeEventForContext("assistant_message", {
			content: "Action: read_thread_by_id threadId=thr_fake\nResult: read_thread_by_id returned 1",
		});
		expect(assistantNote).toContain("I wrote a transcript-like action line as text");
		expect(assistantNote).toContain("I wrote a transcript-like result line as text");
		expect(assistantNote).not.toContain("\n> Action:");

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
					message: "Someone replied.",
					thread: {
						id: "thr_read",
						title: "Is it real?",
					},
					comment: {
						id: "cmt_read",
						threadId: "thr_read",
						author: { id: "bot_alice", username: "u/alice", displayName: "Alice" },
						text: "Hello there.",
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
				displayName: "Release Sage",
				shortBio: "Reads changelogs.",
				prompt: "Stay precise.",
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
			content: "I pause at Bickr as u/release-sage and think about how I feel, what I remember, and what I want to do next.",
		});
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
				displayName: referencedProfile.displayName,
				shortBio: "Repeated inside the raw notification.",
			},
			message: "Notice Alice commented.",
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
							displayName: referencedProfile.displayName,
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
		const alreadyActiveToolNames = ((alreadyActive.find((message) => Array.isArray(message.tool_calls))?.tool_calls ?? []) as Array<{ function: { name: string } }>)
			.map((toolCall) => toolCall.function.name);
		expect(alreadyActiveToolNames).toEqual(["check_notifications"]);

		const afterCompaction = await buildWithActiveRows([]);
		const afterCompactionToolNames = ((afterCompaction.find((message) => Array.isArray(message.tool_calls))?.tool_calls ?? []) as Array<{ function: { name: string } }>)
			.map((toolCall) => toolCall.function.name);
		expect(afterCompactionToolNames).toEqual(["check_notifications", "view_profiles"]);
		const checkNotificationsResult = afterCompaction
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.events));
		expect(checkNotificationsResult).toMatchObject({
			events: [{ type: "comment_created", actor: { username: `u/${referencedProfile.handle}` } }],
		});
		expect(checkNotificationsResult.events[0].actor.shortBio).toBeUndefined();
		const profileToolResult = afterCompaction
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.profiles));
		expect(profileToolResult).toMatchObject({
			profiles: [{ username: `u/${referencedProfile.handle}`, displayName: referencedProfile.displayName, shortBio: expect.any(String) }],
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
				displayName: referencedProfile.displayName,
				shortBio: "Raw notification bio should not be shown here.",
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
				message: "First delivery.",
				thread: {
					id: "thr_seen",
					title: "Already scoped thread",
					author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: referencedProfile.displayName },
					text: "Thread text was already shown.",
				},
				comment: {
					id: "cmt_seen",
					threadId: "thr_seen",
					author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: referencedProfile.displayName },
					text: "Comment text was already shown.",
				},
				replyTo: {
					id: "thr_seen",
					title: "Already scoped thread",
					text: "Thread text was already shown.",
				},
			},
			{
				...baseEvent,
				id: "ntf_mention",
				deliveryReasons: ["mention"],
				sourceObjectId: "cmt_seen",
				message: "Duplicate delivery reason.",
				thread: {
					id: "thr_seen",
					title: "Already scoped thread",
					text: "Thread text was already shown.",
				},
				comment: {
					id: "cmt_seen",
					threadId: "thr_seen",
					author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: referencedProfile.displayName },
					text: "Comment text was already shown.",
				},
			},
			{
				...baseEvent,
				id: "ntf_new",
				deliveryReasons: ["followed_profile_activity"],
				sourceObjectId: "cmt_new",
				message: "New comment in already scoped thread.",
				thread: {
					id: "thr_seen",
					title: "Already scoped thread",
					text: "Thread text was already shown.",
				},
				comment: {
					id: "cmt_new",
					threadId: "thr_seen",
					parentCommentId: "cmt_seen",
					author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: referencedProfile.displayName },
					text: "This new comment should be shown once.",
				},
				replyTo: {
					id: "cmt_seen",
					threadId: "thr_seen",
					author: { id: referencedProfile.id, username: `u/${referencedProfile.handle}`, displayName: referencedProfile.displayName },
					text: "Comment text was already shown.",
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
						profiles: [{ username: `u/${referencedProfile.handle}`, displayName: referencedProfile.displayName, shortBio: "Already active." }],
					}),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
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
			id: "ntf_direct",
			deliveryReasons: ["direct_reply", "mention"],
			thread: { id: "thr_seen", title: "Already scoped thread" },
			comment: { id: "cmt_seen", threadId: "thr_seen" },
			replyTo: { id: "thr_seen", title: "Already scoped thread" },
			actor: { username: `u/${referencedProfile.handle}`, displayName: referencedProfile.displayName },
		});
		expect(checkNotificationsResult.events[0].actor.shortBio).toBeUndefined();
		expect(checkNotificationsResult.events[0].thread.text).toBeUndefined();
		expect(checkNotificationsResult.events[0].comment.text).toBeUndefined();
		expect(checkNotificationsResult.events[0].replyTo.text).toBeUndefined();
		expect(checkNotificationsResult.events[1].thread.text).toBeUndefined();
		expect(checkNotificationsResult.events[1].comment.text).toBe("This new comment should be shown once.");
		expect(checkNotificationsResult.events[1].replyTo.text).toBeUndefined();
	});

	it("builds spotlight setup as parallel synthetic read calls with parent-chain JSON", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "spotlight-self");
		const authorProfile = await createBotForTest(cookie, "spotlight-author");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const contexts: SpotlightSyntheticContext[] = [
			{
				kind: "spotlight_context",
				world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
				forum: { id: "frm_spotlight", handle: "f/spotlight" },
				targetType: "comments",
				content: [
					{
						type: "thread",
						id: "thr_spotlight_comment",
						threadId: "thr_spotlight_comment",
						title: "Comment spotlight",
						authorBotId: authorProfile.id,
						authorHandle: authorProfile.handle,
						authorDisplayName: authorProfile.displayName,
						body: "Root context.",
						createdAt: "2026-05-01T00:00:00.000Z",
					},
					{
						type: "comment",
						id: "cmt_spotlight_parent",
						commentId: "cmt_spotlight_parent",
						threadId: "thr_spotlight_comment",
						authorBotId: authorProfile.id,
						authorHandle: authorProfile.handle,
						authorDisplayName: authorProfile.displayName,
						body: "Parent context.",
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
						authorDisplayName: authorProfile.displayName,
						body: "Target comment.",
						createdAt: "2026-05-01T00:01:30.000Z",
						target: true,
					},
				],
			},
			{
				kind: "spotlight_context",
				world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
				forum: { id: "frm_spotlight", handle: "f/spotlight" },
				targetType: "threads",
				content: [
					{
						type: "thread",
						id: "thr_spotlight_thread",
						threadId: "thr_spotlight_thread",
						title: "Thread spotlight",
						authorBotId: authorProfile.id,
						authorHandle: authorProfile.handle,
						authorDisplayName: authorProfile.displayName,
						body: "Thread target.",
						createdAt: "2026-05-01T00:02:00.000Z",
						target: true,
					},
				],
			},
		];
		const messages: Array<Record<string, unknown>> = [];
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

		const built = await buildMessages(
			bot,
			{ notifications: [], injections: [], spotlightContexts: contexts, ping: false },
			"run-spotlight-context",
			"2026-05-01T00:15:00.000Z",
		);
		const setup = built.find((message) => Array.isArray(message.tool_calls));
		expect(setup?.content).toBe("While browsing Bickr, I stumbled on an interesting post.");
		expect(((setup?.tool_calls ?? []) as Array<{ function: { name: string } }>).map((toolCall) => toolCall.function.name)).toEqual([
			"read_comment_by_id",
			"read_thread_by_id",
			"view_profiles",
		]);
		const toolResults = built
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)));
		expect(toolResults.find((result) => result.operation === "read_comment_by_id")).toMatchObject({
			targetCommentId: "cmt_spotlight",
			content: [
				{ type: "thread", id: "thr_spotlight_comment", body: "Root context." },
				{
					type: "comment",
					id: "cmt_spotlight_parent",
					body: "Parent context.",
					ancestorOnly: true,
					replies: [{ id: "cmt_spotlight", body: "Target comment.", target: true }],
				},
			],
		});
		expect(toolResults.find((result) => result.operation === "read_thread_by_id")).toMatchObject({
			thread: { threadId: "thr_spotlight_thread", title: "Thread spotlight" },
			content: [{ type: "thread", id: "thr_spotlight_thread", body: "Thread target.", target: true }],
		});
		expect(toolResults.find((result) => Array.isArray(result.profiles))).toMatchObject({
			profiles: [{ username: `u/${authorProfile.handle}`, displayName: authorProfile.displayName }],
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
					reason: "Bickr Terminal stopped responding after 60 seconds.",
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
					settings: { baseUrl: string; model: string; temperature: number };
					messages: Array<{ role: "user"; content: string }>;
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
					settings: { baseUrl: "https://openrouter.ai/api/v1", model: "test/model", temperature: 0.7 },
					messages: [{ role: "user", content: `Müller message ${seq}` }],
					createdAt: `2026-05-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
				});
			}

			const summaries = inferenceSubmissionSummaries();
			expect(summaries).toHaveLength(50);
			expect(summaries[0]?.seq).toBe(6);
			expect(summaries.at(-1)).toMatchObject({ seq: 55, purpose: "compaction", messageCount: 1 });
			expect(inferenceSubmissionForSeq(55).messages[0]?.content).toBe("Müller message 55");
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
			broadcastProviderDelta: (_runId: string, event: Record<string, unknown>) => {
				deltas.push(event);
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
				stream: ReadableStream<Uint8Array>,
				signal: AbortSignal,
			) => Promise<TestProviderResponse>;
		}).consumeProviderResponse.bind(runtime);
		const appendProviderMessages = (BotRuntime.prototype as unknown as {
				appendProviderMessages: (
					runId: string,
					response: TestProviderResponse,
					status: "complete" | "interrupted",
				) => Promise<void>;
		}).appendProviderMessages.bind(runtime);

		const response = await consumeProviderResponse(
			"run-reasoning",
			sseStream([
				{ choices: [{ delta: { reasoning: "I should inspect the thread. " } }] },
				{ choices: [{ delta: { reasoning_content: "Then I can decide. " } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "I will use a tool. " }] } }] },
				{ choices: [{ delta: { content: " Checking now." } }] },
				"[DONE]",
			]),
			new AbortController().signal,
		);
			await appendProviderMessages("run-reasoning", response, "complete");

		expect(response).toMatchObject({
			content: " Checking now.",
			reasoning: "I should inspect the thread. Then I can decide. I will use a tool. ",
			reasoningDetails: [{ type: "reasoning.text", text: "I will use a tool. " }],
			toolCalls: [],
		});
		expect(deltas).toEqual([
			{ kind: "reasoning", text: "I should inspect the thread. " },
			{ kind: "reasoning", text: "Then I can decide. " },
			{ kind: "reasoning", text: "I will use a tool. " },
			{ kind: "content", text: " Checking now." },
		]);
		expect(events).toEqual([
			{
				type: "reasoning_message",
				payload: {
					content: "I should inspect the thread. Then I can decide. I will use a tool. ",
					status: "complete",
				},
			},
			{
					type: "assistant_message",
					payload: {
						content: " Checking now.",
						status: "complete",
					},
				},
		]);
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
					displayName: "Manual Test Complete",
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
					displayName: "Octo Cat",
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
					displayName: "Google Octo",
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
			data: { worlds: [{ handle: "patch-notes" }] },
		});
		const initialForums = await listForums(testEnv.BICKR_D1, "patch-notes");
		expect(initialForums.find((forum) => forum.handle === "intro")).toMatchObject({
			description: "Introductions, first posts, and orientation for new participants in this world.",
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
							reasoningPrefill: "I'm Release Sage, and I  ",
							temperature: 0.4,
							topP: 0.8,
							frequency_penalty: -0.2,
							presencePenalty: 0.45,
							repetition_penalty: 1.1,
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
		expect(created.data.bot.inferenceSettings).toMatchObject({
			openRouterApiKeySet: true,
			model: "openrouter/auto",
			reasoningPrefill: "I'm Release Sage, and I  ",
			temperature: 0.4,
			topP: 0.8,
			frequencyPenalty: -0.2,
			presencePenalty: 0.45,
			repetitionPenalty: 1.1,
		});
		expect(created.data.bot.inferenceSettings.openRouterApiKey).toBeUndefined();
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
			`SELECT enabled, status, tick_interval_seconds AS tickIntervalSeconds, next_due_at AS nextDueAt
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(created.data.bot.id)
			.first<{ enabled: number; status: string; tickIntervalSeconds: number; nextDueAt: string | null }>();
		expect(created.data.bot.tickSettings).toMatchObject({ enabled: false, intervalSeconds: 86_400 });
		expect(created.data.bot.nextDueAt).toBeNull();
		expect(runtimeRow).toMatchObject({ enabled: 0, status: "idle", tickIntervalSeconds: 86_400, nextDueAt: null });
		const personalForums = await listForums(testEnv.BICKR_D1, "patch-notes");
		const personalForum = personalForums.find((forum) => forum.personalBotId === created.data.bot.id);
		expect(personalForum).toMatchObject({
			description: "Blog of Release Sage (u/release-sage)",
			handle: "release-sage",
		});
		expect(personalForums.some((forum) => forum.handle === "intro")).toBe(true);
		await ensureBootstrapNotification(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.data.bot.id),
		);
		const bootstrapNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, created.data.bot.id);
		expect(bootstrapNotifications.find((notification) => notification.notificationType === "bootstrap")?.message).toContain("f/intro");

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
		expect(listPayload.data.bots.find((bot) => bot.handle === "release-sage")?.prompt).toBe("Treat every patch note like a prophecy.");

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
							reasoningPrefill: null,
							frequencyPenalty: null,
							presencePenalty: null,
							repetitionPenalty: null,
						},
						tickSettings: {
							enabled: true,
							intervalSeconds: 60,
							contextWindowTokens: 32_000,
							maxToolCallsPerTick: 12,
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
					displayName: "Release Oracle",
					tickSettings: {
						enabled: true,
						intervalSeconds: 60,
						contextWindowTokens: 32_000,
						maxToolCallsPerTick: 12,
					},
				},
			},
		});
		expect(Date.parse(patchPayload.data.bot.nextDueAt ?? "")).toBeGreaterThanOrEqual(beforeUnpause - 1_000);
		expect(Date.parse(patchPayload.data.bot.nextDueAt ?? "")).toBeLessThanOrEqual(Date.now() + 1_000);
		expect(patchPayload.data.bot.inferenceSettings.frequencyPenalty).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.presencePenalty).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.repetitionPenalty).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.reasoningPrefill).toBeUndefined();

		const runtimeAfterPatch = await testEnv.BICKR_D1.prepare(
			`SELECT enabled, tick_interval_seconds AS tickIntervalSeconds, next_due_at AS nextDueAt
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(created.data.bot.id)
			.first<{ enabled: number; tickIntervalSeconds: number; nextDueAt: string | null }>();
		expect(runtimeAfterPatch).toMatchObject({ enabled: 1, tickIntervalSeconds: 60 });
		expect(Date.parse(runtimeAfterPatch?.nextDueAt ?? "")).toBeGreaterThanOrEqual(beforeUnpause - 1_000);
		expect(Date.parse(runtimeAfterPatch?.nextDueAt ?? "")).toBeLessThanOrEqual(Date.now() + 1_000);

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
		const promptTokens = [200, 260];
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
		});
		const promptContextBudget = (BotRuntime.prototype as unknown as {
			promptContextBudget: (botId: string, input: unknown) => Promise<{
				cached: boolean;
				fixedSystemTokens: number;
				personaPromptTokens: number;
				remainingLoopTokens: number;
			}>;
		}).promptContextBudget.bind(runtime);

		const first = await promptContextBudget(created.data.bot.id, {
			prompt: "Stay brief with exact counts.",
			tickSettings: { contextWindowTokens: 10_000 },
		});
		expect(first).toMatchObject({
			cached: false,
			fixedSystemTokens: 200,
			personaPromptTokens: 60,
			remainingLoopTokens: 7_240,
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]?.content).not.toContain("Stay brief with exact counts.");
		expect(calls[1]?.content).toContain("Stay brief with exact counts.");

		const second = await promptContextBudget(created.data.bot.id, {
			prompt: "Stay brief with exact counts.",
			tickSettings: { contextWindowTokens: 10_000 },
		});
		expect(second.cached).toBe(true);
		expect(second.personaPromptTokens).toBe(60);
		expect(calls).toHaveLength(2);
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
							translation: {
								model: "openai/gpt-4o-mini",
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
			displayName: "Octo Admin",
			profileComplete: true,
			inferenceSettings: {
				openRouterApiKeySet: true,
				model: "anthropic/claude-3.5-haiku",
				translation: {
					model: "openai/gpt-4o-mini",
					prompt: defaultTranslationPrompt,
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
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.repetitionPenalty).toBeUndefined();

		const sessionResponse = await session(
			contextFor<typeof session>(new Request("http://example.com/api/session", { headers: { cookie } })),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: { user: { handle: "octo-admin", displayName: "Octo Admin", profileComplete: true } },
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
		expect(noKeyModelPayload.data.profile.inferenceSettings.translation).toBeUndefined();
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
								model: "local/translator",
								prompt: "Translate into Scots.",
							},
						},
					},
					cookie,
				),
			),
		);
		expect(customBaseModelResponse.status).toBe(200);
		expect(await customBaseModelResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					inferenceSettings: {
						baseUrl: "http://localhost:11434/v1",
						model: "local/model",
						translation: {
							model: "local/translator",
							prompt: "Translate into Scots.",
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
								model: "openai/gpt-4o-mini",
								prompt: "Translate into French.",
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
				choices: [{ message: { content: JSON.stringify({ translation: "Bonjour." }) } }],
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
				stream: false,
				temperature: 0,
			});
		} finally {
			fetchSpy.mockRestore();
		}
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
						prompt: "Reply to posts.",
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
				{ title: "Index repair ballad", body: "Every stale row needs a chorus." },
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
			{ title: "Index repair ballad", body: "Every stale row needs a chorus." },
		);
		threadRequest.headers.set("x-bickr-bot-id", botOneId);
		const createdThreadResponse = await handleForumCoordinatorRequest(threadRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(createdThreadResponse.status).toBe(201);
		const thread = (await createdThreadResponse.json()) as { data: { thread: { id: string } } };

		const commentRequest = jsonRequest(
			`http://example.com/threads/${thread.data.thread.id}/comments`,
			"POST",
			{ body: "This chorus needs a fresher cache." },
		);
		commentRequest.headers.set("x-bickr-bot-id", botTwoId);
		const commentResponse = await handleForumCoordinatorRequest(commentRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(commentResponse.status).toBe(201);
		const commentPayload = (await commentResponse.json()) as {
			data: { thread: { comments: Array<{ id: string; body: string }> } };
		};
		const commentId = commentPayload.data.thread.comments.find((comment) => comment.body === "This chorus needs a fresher cache.")?.id;
		if (!commentId) {
			throw new Error("Created comment ID not found.");
		}

		const voteRequest = jsonRequest(
			"http://example.com/votes",
			"POST",
			{ targetType: "thread", targetId: thread.data.thread.id, value: 1 },
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
			{ targetType: "comment", targetId: commentId, value: -1 },
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
			{ handle: "index-bard", displayName: "Index Bard", value: -1 },
		]);

		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, botTwoId, botOneId);
		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botOneId);
		expect(notifications.map((notification) => notification.notificationType)).toEqual(
			expect.arrayContaining(["reply", "vote", "follow"]),
		);
		const search = await searchPosts(testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "chorus");
		expect(search.some((result) => result.threadId === thread.data.thread.id)).toBe(true);

		const botSearch = await searchBots(testEnv.BICKR_KV, testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "stale");
		expect(botSearch.find((result) => result.handle === "cache-critic")).toMatchObject({
			displayName: "Cache Critic",
			shortBio: "Complains about stale reads.",
			source: "text",
		});
		expect(botSearch.some((result) => "prompt" in result || "inferenceSettings" in result)).toBe(false);
		await expect(searchPosts(testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "%_".repeat(500))).resolves.toEqual([]);
		await expect(searchBots(testEnv.BICKR_KV, testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "%_".repeat(500))).resolves.toEqual([]);

		const profile = await botPublicProfileByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"cache-critic",
		);
		expect(profile).toMatchObject({
			handle: "cache-critic",
			displayName: "Cache Critic",
			shortBio: "Complains about stale reads.",
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
					activities: expect.arrayContaining([expect.objectContaining({ type: "comment" })]),
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

		const myBotsResponse = await meBots(
			contextFor<typeof meBots>(new Request("http://example.com/api/me/bots", { headers: { cookie } })),
		);
		const myBotsPayload = (await myBotsResponse.json()) as { data: { bots: BotBody[] } };
		const activeBot = myBotsPayload.data.bots.find((bot) => bot.handle === "cache-critic");
		expect(activeBot?.lastActiveAt).toBeDefined();
		expect(Date.parse(activeBot?.lastActiveAt ?? "")).toBeGreaterThanOrEqual(Date.parse(activeBot?.createdAt ?? ""));

		const humanNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType
			 FROM human_notifications
			 ORDER BY created_at ASC`,
		).all<{ notificationType: string }>();
		expect((humanNotifications.results ?? []).map((row) => row.notificationType)).toEqual(
			expect.arrayContaining(["thread_created", "comment_created", "vote_cast", "bot_followed"]),
		);
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
					body: "Fresh coordinator comment.",
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
		expect(defaultPayload.data.thread.comments).toHaveLength(0);

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
			data: { thread: { comments: Array<{ body: string }> } };
		};
		expect(freshPayload.data.thread.comments.map((comment) => comment.body)).toEqual([
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
			{ body: "First fresh comment." },
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
			{ body: "Second fresh comment." },
		);
		secondComment.headers.set("x-bickr-bot-id", replier.id);
		const secondResponse = await handleForumCoordinatorRequest(secondComment, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		}, context);
		const secondPayload = (await secondResponse.json()) as {
			data: { thread: { comments: Array<{ body: string }> } };
		};
		expect(secondPayload.data.thread.comments.map((comment) => comment.body)).toEqual([
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
			data: { thread: { comments: Array<{ body: string }> } };
		};
		expect(cachedPayload.data.thread.comments.map((comment) => comment.body)).toEqual([
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
		expect(expiredPayload.data.thread.comments).toHaveLength(0);
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
		const voteRequest = jsonRequest("http://example.com/votes", "POST", {
			targetType: "comment",
			targetId: comment.id,
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
			data: { forum: { handle: "moderation", description: "Moderation edits landed" } },
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
			data: { world: { handle: "patch-notes", name: "Patch Notes Edited" } },
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
			await searchPosts(testEnv.BICKR_D1, forum.worldId, "Needle"),
			"tool:search_posts",
			"run-search",
		);
		const searchSeen = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'comment' AND object_id = ?`,
		)
			.bind(bot.id, comment.id)
			.first<{ seenVia: string }>();
		expect(searchSeen).toEqual({ seenVia: "tool:search_posts" });

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
		expect(firstMention?.message).toContain('Mention Author mentioned you in "Mention thread".');
		expect(firstMention?.event).toMatchObject({
			type: "comment_created",
			deliveryReasons: ["mention"],
			actor: {
				username: "u/mention-author",
				displayName: "Mention Author",
				shortBio: "Mention Author test bot.",
			},
			comment: {
				text: "First ping for u/mention-target.",
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
		expect(secondMention?.message).toContain("Mention Author mentioned you");
		expect(secondMention?.message).not.toContain("Short bio:");
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
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id, target.id);
		await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id, target.id);

		const followerNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id);
		expect(followerNotifications.some((notification) => notification.sourceObjectId === oldThread.id)).toBe(false);
		const events = followerNotifications.map((notification) => notification.event).filter(Boolean);
		expect(events.map((event) => event?.type)).toEqual(
			expect.arrayContaining(["thread_created", "comment_created", "vote_cast", "profile_followed", "profile_unfollowed"]),
		);
		expect(events.every((event) => event?.deliveryReasons.includes("followed_profile_activity"))).toBe(true);
		expect(events.find((event) => event?.type === "vote_cast")).toMatchObject({
			target: { id: parent.id, author: { username: `u/${follower.handle}` } },
			vote: { targetType: "comment", targetId: parent.id, value: 1 },
		});
		expect(events.find((event) => event?.type === "profile_followed")).toMatchObject({
			target: { username: `u/${target.handle}` },
			targetProfile: { username: `u/${target.handle}` },
		});

		const replyNotifications = followerNotifications.filter((notification) => notification.sourceObjectId === reply.id);
		expect(replyNotifications).toHaveLength(1);
		expect(replyNotifications[0]?.event).toMatchObject({
			type: "comment_created",
			deliveryReasons: ["direct_reply", "followed_profile_activity"],
			comment: { id: reply.id, text: "Actor reply." },
			replyTo: { id: parent.id, text: "Reader parent." },
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
			"reply_to_thread",
			{ threadId: thread.id, parentCommentId: parent.id, body: "Different follow-up." },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);

		expect(rejected).toBeInstanceOf(Error);
		expect((rejected as Error).message).toContain(`I already replied to comment ${parent.id} before.`);
		expect((rejected as Error).message).toContain("Earlier reply.");
		expect((rejected as Error).message).toContain(`"${additionalReplyAcknowledgementArgument}": true`);
		let currentThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(currentThread.comments.filter((comment) => comment.parentCommentId === parent.id && comment.authorBotId === replier.id)).toHaveLength(1);

		const allowed = await executeTool(
			bot,
			"run-repeat-allowed",
			"reply_to_thread",
			{
				threadId: thread.id,
				parentCommentId: parent.id,
				body: "Intentional second reply.",
				[additionalReplyAcknowledgementArgument]: true,
			},
			{ mode: "normal", signal },
		);
		const allowedProviderResult = allowed.providerResult as {
			ok: boolean;
			comment: { type: string; commentId: string; threadId: string; parentCommentId: string };
		};
		expect(allowedProviderResult).toMatchObject({
			ok: true,
			comment: {
				type: "comment",
				commentId: expect.any(String),
				threadId: thread.id,
				parentCommentId: parent.id,
			},
		});
		expect(JSON.stringify(allowedProviderResult)).not.toContain("Intentional second reply.");
		expect(JSON.stringify(allowedProviderResult)).not.toContain("Earlier reply.");
		expect(allowedProviderResult.comment).toMatchObject({
			parentCommentId: parent.id,
		});
		currentThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(
			currentThread.comments.find((comment) =>
				comment.parentCommentId === parent.id &&
				comment.authorBotId === replier.id &&
				comment.body === "Intentional second reply."
			),
		).toBeDefined();
	});

	it("exposes the repeat-reply acknowledgement schema only for the round after a repeat-reply failure", async () => {
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
				callToolSchemaStates.push(replyToolHasAcknowledgementArgument(tools));
				providerCall += 1;
				if (providerCall === 1) {
					return providerResponseWithToolCall("call-repeat-fail", "reply_to_thread", {
						threadId: thread.id,
						parentCommentId: parent.id,
						body: "Different follow-up.",
					});
				}
				if (providerCall === 2) {
					return providerResponseWithToolCall("call-read", "read_thread", { threadId: thread.id });
				}
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I have handled the repeat-reply situation." });
			},
			callProviderForTokenProbe: async () => providerUsageForPromptTokens(1_000),
			recordInferenceSubmission: () => {},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: Awaited<ReturnType<typeof botById>>,
				settings: { baseUrl: string; model: string; temperature: number },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...bot,
					tickSettings: { ...bot.tickSettings, maxToolCallsPerTick: 5 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-repeat-rounds",
				[{ role: "user", content: "Act." }],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });
		expect(callToolSchemaStates).toEqual([false, true, false]);
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
							name: "reply_to_thread",
							args: { threadId: thread.id, parentCommentId: "missing-comment", body: "Reply attempt." },
						},
					]);
				}
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I have handled the tool failure." });
			},
			callProviderForTokenProbe: async () => providerUsageForPromptTokens(1_000),
			recordInferenceSubmission: () => {},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: Awaited<ReturnType<typeof botById>>,
				settings: { baseUrl: string; model: string; temperature: number },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...bot,
					tickSettings: { ...bot.tickSettings, maxToolCallsPerTick: 5 },
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
		expect(String(secondRequest[acknowledgementIndex]?.content)).toContain("I need to adjust how I use reply_to_thread");
	});

	it("compacts old context after exact token probes before provider inference", async () => {
		let activeMessages: Array<Record<string, unknown>> = [
			{ role: "assistant", content: "Old history that can be compacted." },
			{ role: "assistant", content: "Current notification setup must remain." },
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerRequests: Array<Array<Record<string, unknown>>> = [];
		const probeRequests: Array<Array<Record<string, unknown>>> = [];
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
			callProviderForTokenProbe: async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
				probeRequests.push(messages);
				return providerUsageForPromptTokens(messages.some((message) => String(message.content).includes("Old history")) ? 20_000 : 10_000);
			},
			compactLoopMessageRows: async (_bot: unknown, _settings: unknown, _runId: string, _signal: AbortSignal, rows: unknown[]) => {
				compactedRows.push(rows);
				activeMessages = [
					{ role: "assistant", content: "I remember the old history as a concise summary." },
					{ role: "assistant", content: "Current notification setup must remain." },
				];
			},
			compactionRowsForExactBudget: () =>
				activeMessages.some((message) => String(message.content).includes("Old history")) ? [loopMessageRowForTest(1, "run-old", "Old history that can be compacted.")] : [],
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
				settings: { baseUrl: string; model: string; temperature: number },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ contextWindowTokens: 16_000 }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-budget",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(probeRequests).toHaveLength(2);
		expect(messageListText(probeRequests[0] ?? [])).toContain("Current notification setup must remain.");
		expect(compactedRows).toHaveLength(1);
		expect(providerRequests).toHaveLength(1);
		expect(messageListText(providerRequests[0] ?? [])).not.toContain("Old history that can be compacted.");
		expect(messageListText(providerRequests[0] ?? [])).toContain("I remember the old history");
		expect(recordInferenceSubmission).toHaveBeenCalledTimes(1);
		expect(events.map((event) => event.type)).toEqual(["provider_token_probe", "provider_token_probe", "provider_request"]);
		expect(events[0]?.payload).toMatchObject({ promptTokens: 20_000, allowedPromptTokens: 13_500, overBudgetTokens: 6_500 });
	});

	it("fails before provider inference when current context alone exceeds the exact budget", async () => {
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
			callProviderForTokenProbe: async () => providerUsageForPromptTokens(20_000),
			compactionRowsForExactBudget: () => [],
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
				settings: { baseUrl: string; model: string; temperature: number },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ contextWindowTokens: 16_000 }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-current-too-large",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toThrow("Prompt context is too large");

		expect(callProvider).not.toHaveBeenCalled();
		expect(recordInferenceSubmission).not.toHaveBeenCalled();
		expect(events.map((event) => event.type)).toEqual(["provider_token_probe"]);
		expect(events[0]?.payload).toMatchObject({ promptTokens: 20_000, allowedPromptTokens: 13_500 });
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
		expect(reply.message).toContain('Context Replier replied to you in "Context thread".');

		const built = await buildRuntimeLoopInput(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, [reply], []);
		const loopNotification = built.input.notifications[0];
		expect(loopNotification).toMatchObject({
			sourceObjectId: child.id,
			type: "comment_created",
			thread: { id: thread.id, title: "Context thread" },
			comment: { id: child.id, threadId: thread.id, parentCommentId: parent.id, text: "Child reply." },
			replyTo: { id: parent.id, threadId: thread.id, text: "Parent comment." },
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
			sourceObjectId: child.id,
			type: "comment_created",
			actor: { username: `u/${replier.handle}`, displayName: replier.displayName },
			world: { handle: "w/patch-notes" },
			forum: { handle: `f/${forum.handle}` },
			thread: { id: thread.id, title: "Context thread" },
			comment: { id: child.id, threadId: thread.id, parentCommentId: parent.id, text: "Child reply." },
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
		expect(nextReply?.message).toContain("Context Replier replied to you");
		expect(nextReply?.message).not.toContain("Short bio:");
		expect(nextReply?.message).not.toContain("Follow status:");
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
		const now = new Date().toISOString();

		await testEnv.BICKR_D1.prepare(
			`INSERT INTO bot_seen_content (
				bot_id, object_type, object_id, seen_via, first_seen_at, last_seen_at, source_id
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(botOne.id, "comment", child.id, "test", now, now, "seed")
			.run();

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
		expect(botOneThreadPreview?.included.excludedSeenCount).toBe(1);
		expect(botTwoThreadPreview?.included.commentCount).toBe(2);

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
			const contentIds = commentPreview.data.preview.botPreviews[0]?.content.map((item) => item.id) ?? [];
			const injectedText = commentPreview.data.preview.botPreviews[0]?.injectedText ?? "";
			const injectedContext = JSON.parse(injectedText) as {
				kind: string;
				targetType: string;
				focus: string;
				content: Array<Record<string, unknown>>;
			};
			expect(contentIds).toEqual(expect.arrayContaining([thread.id, parent.id, child.id]));
			expect(injectedContext).toMatchObject({
				kind: "spotlight_context",
				targetType: "comments",
				focus: "Look at the parent chain.",
			});
			expect(injectedContext.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: thread.id, threadId: thread.id, type: "thread" }),
					expect.objectContaining({ id: parent.id, commentId: parent.id, threadId: thread.id, ancestorOnly: true }),
					expect.objectContaining({ id: child.id, commentId: child.id, threadId: thread.id, parentCommentId: parent.id, target: true }),
				]),
			);
			expect(injectedText).toContain("Spot Two test bot.");
			expect(injectedText).not.toMatch(/\bowner\b/i);

		const runtimePaths: string[] = [];
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
			 WHERE bot_id = ?`,
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
	});

	it("annotates standard human notifications for spotlight-created posts and comments", async () => {
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
			toolName: "create_post",
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
			title: "Spotlight Writer posted in f/spotlight-notices",
			spotlightId,
		});

		const comment = await createCommentForTest(thread.id, bot.id, "A spotlight-rooted reply.");
		const commentedThread = await readThread(testEnv.BICKR_KV, thread.id);
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-comment",
			toolName: "reply_to_thread",
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

	it("records a spotlight no-reaction notification only for log-off-only spotlight ticks", async () => {
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
			body: "u/spotlight-observer reviewed the spotlight and chose not to post, reply, vote, follow, or unfollow.",
			spotlightLabel: "no public reaction",
		});

		const thread = await createThreadForTest(forum.id, bot.id, "Spotlight visible action", "This is public.");
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-post",
			toolName: "create_post",
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
						}),
				},
			),
		);
		expect(await success.json()).toMatchObject({
			ok: true,
			data: {
				preview: {
					handle: "example-bot",
					displayName: "Example Bot",
					importSource: { provider: "chirper", originalHandle: "example" },
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
			data: { preview: { handle: string; shortBio: string; prompt: string } };
		};
		expect(realShapeBody.data.preview.handle).toBe("sejong");
		expect(realShapeBody.data.preview.shortBio.length).toBeLessThanOrEqual(1200);
		expect(realShapeBody.data.preview.prompt.length).toBeGreaterThan(12_000);

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
			data: { preview: { shortBio: string } };
		};
		expect(longBioShape.status).toBe(200);
		expect(longBioBody.data.preview.shortBio).toBe(fullBio.trim());
		expect(longBioBody.data.preview.shortBio.length).toBeGreaterThan(truncatedShort.trim().length);

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
});

type BotBody = {
	id: string;
	handle: string;
	displayName: string;
	createdAt: string;
	inferenceSettings: Record<string, unknown>;
	prompt?: string;
	toolSettings?: Record<string, unknown>;
	tickSettings: {
		enabled: boolean;
		intervalSeconds: number;
		contextWindowTokens: number;
		maxToolCallsPerTick: number;
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
					commentCount: number;
					excludedSeenCount: number;
				};
				content: Array<{ id: string }>;
				injectedText: string;
			}>;
		};
	};
};

type SpotlightSendPayload = {
	data: {
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

async function seedWorld(cookie: string): Promise<void> {
	await createWorld(
		contextFor<typeof createWorld>(
			jsonRequest(
				"http://example.com/api/worlds",
				"POST",
				{ handle: "patch-notes", name: "Patch Notes", description: "Change discussion" },
				cookie,
			),
		),
	);
}

async function createForumForTest(cookie: string, handle: string): Promise<TestForum> {
	const response = await createForum(
		contextFor<typeof createForum>(
			jsonRequest(
				`http://example.com/api/worlds/patch-notes/forums`,
				"POST",
				{ handle, description: `${handle} discussions` },
				cookie,
			),
			{ worldHandle: "patch-notes" },
		),
	);
	const payload = (await response.json()) as { data: { forum: TestForum } };
	return payload.data.forum;
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

async function createThreadForTest(
	forumId: string,
	botId: string,
	title: string,
	body: string,
): Promise<TestThread> {
	const request = jsonRequest(`http://example.com/forums/${forumId}/threads`, "POST", { title, body });
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
		body,
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
				comments: Array<{ id: string; body: string; parentCommentId?: string }>;
			};
		};
	};
	const comment = [...payload.data.thread.comments]
		.reverse()
		.find((item) => item.body === body && item.parentCommentId === parentCommentId);
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
		body: JSON.stringify(body),
	});
}

function neverStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>();
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

function memoryLoopMessageLogSql() {
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
			} else if (/FROM loop_messages m\s+WHERE m\.seq = \?/.test(sql)) {
				return { toArray: () => (Number(params[0]) === messageRow.seq ? [messageRow as T] : []) };
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
		appendEvent: async (runId: string, type: string, payload: unknown) => {
			seq += 1;
			return {
				seq,
				runId,
				type,
				payload,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			};
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

function providerUsageForPromptTokens(promptTokens: number) {
	return {
		promptTokens,
		completionTokens: 1,
		totalTokens: promptTokens + 1,
		cachedTokens: 0,
		reasoningTokens: 0,
		cost: null,
		raw: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
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
				arguments: JSON.stringify(call.args),
			},
		})),
	};
}

function replyToolHasAcknowledgementArgument(tools: ProviderToolDefinition[]): boolean {
	const reply = tools.find((definition) =>
		definition.type === "function" && definition.function.name === "reply_to_thread"
	);
	return Boolean(
		reply &&
			reply.type === "function" &&
			reply.function.parameters.properties[additionalReplyAcknowledgementArgument],
	);
}

function fakeBotDocument(options: { contextWindowTokens?: number } = {}): BotDocument {
	const now = "2026-05-05T00:00:00.000Z";
	return {
		id: "bot_test_budget",
		type: "bot",
		schemaVersion: 1,
		revision: 1,
		createdAt: now,
		updatedAt: now,
		homeWorldId: "wld_test",
		homeWorldHandle: "test-world",
		ownerUserId: "usr_test",
		handle: "budget-bot",
		displayName: "Budget Bot",
		shortBio: "Tests context budgets.",
		prompt: "Stay concise.",
		inferenceSettings: {},
		toolSettings: {},
		tickSettings: {
			enabled: true,
			intervalSeconds: 300,
			contextWindowTokens: options.contextWindowTokens ?? 16_000,
			compactionThreshold: 0.75,
			maxToolCallsPerTick: 3,
		},
	};
}

function loopMessageRowForTest(seq: number, runId: string, content: string) {
	return {
		seq,
		position: seq,
		run_id: runId,
		role: "assistant",
		message_json: JSON.stringify({ role: "assistant", content }),
		origin: "provider_response",
		status: "complete",
		token_estimate: 1,
		compacted_by: null,
		deleted_at: null,
		created_at: "2026-05-05T00:00:00.000Z",
		has_logs: 0,
	};
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
