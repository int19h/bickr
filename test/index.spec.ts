import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { onRequestGet as bootstrap } from "../apps/web/functions/api/bootstrap";
import { onRequestGet as githubStart } from "../apps/web/functions/api/auth/github/start";
import { onRequestGet as githubCallback } from "../apps/web/functions/api/auth/github/callback";
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
import { onRequestPost as chirperPreview } from "../apps/web/functions/api/worlds/[worldHandle]/chirper-imports/preview";
import { onRequestGet as worlds, onRequestPost as createWorld } from "../apps/web/functions/api/worlds";
import {
	onRequestDelete as deleteWorldRoute,
	onRequestPatch as patchWorld,
} from "../apps/web/functions/api/worlds/[worldHandle]";
import {
	handleAgentRuntimeRequest,
	buildRuntimeLoopInput,
	BotRuntime,
	formatRuntimeEventForContext,
	formatRuntimeInputForContext,
	isOpenRouterProviderBaseUrl,
	openRouterServerToolSelection,
	promptContextBudgetCacheFingerprint,
	promptContextBudgetFromCounts,
	providerChatCompletionRequest,
	providerContextReserveTokens,
	providerTokenProbeRequest,
	toolUseRecoveryReminder,
	toolDefinitions,
} from "../workers/agent-runtime/src/index";
import { handleForumCoordinatorRequest } from "../workers/forum-coordinator/src/index";
import {
	botById,
	createSession,
	listForums,
	updateUserProfile,
	upsertGithubUser,
} from "../packages/shared/src/repository";
import {
	botActivityFeedByHandle,
	botPublicProfileByHandle,
	followBot,
	ensureBootstrapNotification,
	listPendingNotifications,
	markBotSeenContent,
	markBotSeenFromResult,
	readThread,
	recordSpotlightToolHumanNotification,
	searchBots,
	searchPosts,
} from "../packages/shared/src/social";
import { oauthReturnToCookieName, sessionCookieName, type AppEnv } from "../apps/web/functions/api/_auth";

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
		expect(vote?.function.parameters.properties.targetType).toEqual({
			type: "string",
			enum: ["thread", "comment"],
		});
		expect(vote?.function.parameters.properties.value).toEqual({
			type: "integer",
			minimum: -1,
			maximum: 1,
		});

		const recentThreads = toolDefinitions.find((definition) => definition.function.name === "list_recent_threads");
		expect(recentThreads?.function.parameters.properties.limit?.type).toBe("number");
		expect(recentThreads?.function.parameters.required).not.toContain("limit");
	});

	it("builds provider chat requests with explicit tool-call controls", () => {
		const request = providerChatCompletionRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "test-model",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
		);

		expect(request.tool_choice).toBe("auto");
		expect(request.parallel_tool_calls).toBe(true);
		expect(request.stream).toBe(true);
		expect(request.stream_options.include_usage).toBe(true);
		expect(request.tools).toBe(toolDefinitions);
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
		expect(request.reasoning).toEqual({ exclude: true });
		expect(request.tool_choice).toBe("auto");
		expect(request.tools).toBe(toolDefinitions);
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
						body: "Reply body.",
						target: true,
					},
				],
			},
		});
		expect(toolResult).toContain('I read thread thr_read in f/philosophy titled "Is it real?" by u/alice');
		expect(toolResult).toContain('comment cmt_read in thread thr_read under comment cmt_parent');
		expect(toolResult).not.toMatch(/^Result:|threadId=|commentId=/);

		const assistantNote = formatRuntimeEventForContext("assistant_message", {
			content: "Action: read_thread_by_id threadId=thr_fake\nResult: read_thread_by_id returned 1",
		});
		expect(assistantNote).toContain("I wrote a transcript-like action line as text");
		expect(assistantNote).toContain("I wrote a transcript-like result line as text");
		expect(assistantNote).not.toContain("\n> Action:");

		const currentInput = formatRuntimeInputForContext({
			ping: false,
			injections: [],
			notifications: [
				{
					id: "ntf_read",
					type: "reply",
					message: "Someone replied.",
					threadId: "thr_read",
					commentId: "cmt_read",
					context: {
						threadId: "thr_read",
						title: "Is it real?",
						content: [
							{
								type: "comment",
								id: "cmt_read",
								commentId: "cmt_read",
								threadId: "thr_read",
								forum: "f/philosophy",
								author: { username: "alice" },
								body: "Hello there.",
							},
						],
					},
				},
			],
		});
		expect(currentInput).toContain("My current situation:");
		expect(currentInput).toContain("I have 1 notification");
		expect(currentInput).toContain('Context included thread thr_read "Is it real?"');
		expect(currentInput).not.toContain("{");
	});

	it("builds a recovery reminder after no-tool ticks", () => {
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 1 })).toContain(
			"The previous tick ended without tool calls.",
		);
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 3 })).toContain(
			"3 recent ticks ended without tool calls.",
		);
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 1 })).toContain("Emit tool calls with JSON arguments");
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
					maxAttempts: 3,
					reason: "Provider stream timed out after 60 seconds without data.",
				}),
			});
		} finally {
			vi.useRealTimers();
		}
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
			`${oauthReturnToCookieName}=%2Fw%2Fprimary%2Ff%2Fphilosophy%2Ft%2Fthr_1`,
		);

		const callbackResponse = await githubCallback(
			contextFor<typeof githubCallback>(
				new Request("http://example.com/api/auth/github/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							"bickr_oauth_state=state-1; bickr_oauth_return_to=%2Fw%2Fprimary%2Ff%2Fphilosophy%2Ft%2Fthr_1",
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
		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					`http://example.com/api/worlds/${encodeURIComponent(worldHandle)}/forums`,
					"POST",
					{ handle: forumHandle, description: "Unicode forum handle." },
					cookie,
				),
				{ worldHandle },
			),
		);
		expect(forumResponse.status).toBe(201);
		expect(await forumResponse.json()).toMatchObject({
			ok: true,
			data: { forum: { handle: forumHandle, worldHandle } },
		});

		const botHandle = "бот_7-δ";
		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					`http://example.com/api/worlds/${encodeURIComponent(worldHandle)}/bots`,
					"POST",
					{
						handle: botHandle,
						displayName: "Unicode Bot",
						shortBio: "Exercises non-Latin bot handles.",
						prompt: "Stay concise.",
					},
					cookie,
				),
				{ worldHandle },
			),
		);
		expect(botResponse.status).toBe(201);
		expect(await botResponse.json()).toMatchObject({
			ok: true,
			data: { bot: { handle: botHandle, homeWorldHandle: worldHandle } },
		});
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
							temperature: 0.4,
							topP: 0.8,
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
			temperature: 0.4,
			topP: 0.8,
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
			data: { bots: [{ handle: "release-sage", lastActiveAt: created.data.bot.createdAt }] },
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
		expect(await patchResponse.json()).toMatchObject({
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
							temperature: 0.7,
							topK: 40,
							topP: 0.92,
							minP: 0.04,
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
				temperature: 0.7,
				topK: 40,
				topP: 0.92,
				minP: 0.04,
			},
		});
		expect(profilePayload.data.profile.inferenceSettings.openRouterApiKey).toBeUndefined();

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
					},
				},
			},
		});
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

	it("creates u/ mention notifications with author name and conditional short bio", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "mentions");
		const author = await createBotForTest(cookie, "mention-author");
		const recipient = await createBotForTest(cookie, "mention-target");
		const thread = await createThreadForTest(forum.id, author.id, "Mention thread", "Root body.");

		await createCommentForTest(thread.id, author.id, "First ping for u/mention-target.");
		const firstNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const firstMention = firstNotifications.find((notification) => notification.notificationType === "mention");
		expect(firstMention?.message).toContain("Mention Author (u/mention-author)");
		expect(firstMention?.message).toContain("Short bio: Mention Author test bot.");

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
		expect(firstLoopInput.autoProfileSeenItems).toEqual([{ type: "bot", id: author.id }]);
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
		expect(secondMention?.message).toContain("Mention Author (u/mention-author)");
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
		expect(mention?.message).toContain("u/автор_1");
	});

	it("enriches reply notifications with parent-chain IDs and profile context", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "reply-context");
		const rootAuthor = await createBotForTest(cookie, "context-root");
		const recipient = await createBotForTest(cookie, "context-parent");
		const replier = await createBotForTest(cookie, "context-replier");
		const thread = await createThreadForTest(forum.id, rootAuthor.id, "Context thread", "Root context body.");
		const parent = await createCommentForTest(thread.id, recipient.id, "Parent comment.");
		const child = await createCommentForTest(thread.id, replier.id, "Child reply.", parent.id);

		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const reply = notifications.find((notification) => notification.notificationType === "reply");
		if (!reply) {
			throw new Error("Expected reply notification.");
		}
		expect(reply.message).toContain("Context Replier (u/context-replier)");
		expect(reply.message).toContain("Short bio: Context Replier test bot.");

		const built = await buildRuntimeLoopInput(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, [reply], []);
		const loopNotification = built.input.notifications[0];
		expect(loopNotification).toMatchObject({
			sourceObjectId: child.id,
			threadId: thread.id,
			commentId: child.id,
			parentCommentId: parent.id,
		});
		expect(built.autoProfileSeenItems).toEqual(
			expect.arrayContaining([
				{ type: "bot", id: replier.id },
				{ type: "bot", id: rootAuthor.id },
			]),
		);

		const contextItems = loopNotification?.context?.content ?? [];
		const rootContext = contextItems.find((item) => item.type === "thread");
		const parentContext = contextItems.find((item) => item.commentId === parent.id);
		const targetContext = contextItems.find((item) => item.commentId === child.id);
		expect(rootContext).toMatchObject({
			id: thread.id,
			threadId: thread.id,
			author: { username: "u/context-root", shortBio: "Context Root test bot." },
		});
		expect(parentContext).toMatchObject({
			id: parent.id,
			commentId: parent.id,
			threadId: thread.id,
			ancestorOnly: true,
		});
		expect(targetContext).toMatchObject({
			id: child.id,
			commentId: child.id,
			threadId: thread.id,
			parentCommentId: parent.id,
			target: true,
		});

		const followup = await createCommentForTest(
			loopNotification?.threadId ?? "",
			recipient.id,
			"Replying with supplied IDs.",
			loopNotification?.commentId,
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
		expect(nextReply?.message).toContain("Context Replier (u/context-replier)");
		expect(nextReply?.message).not.toContain("Short bio:");
		if (!nextReply) {
			throw new Error("Expected second reply notification.");
		}
		const nextBuilt = await buildRuntimeLoopInput(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, [nextReply], []);
		const nextContext = JSON.stringify(nextBuilt.input.notifications[0]?.context ?? {});
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
		expect(contentIds).toEqual(expect.arrayContaining([thread.id, parent.id, child.id]));
		expect(injectedText).toContain("My focus: Look at the parent chain.");
		expect(injectedText).toContain(`threadId=${thread.id}`);
		expect(injectedText).toContain(`commentId=${parent.id} threadId=${thread.id}`);
		expect(injectedText).toContain(`commentId=${child.id} threadId=${thread.id} parentCommentId=${parent.id}`);
		expect(injectedText).toContain("context parent comments are not the target");
		expect(injectedText).toContain("context parent comment by");
		expect(injectedText).toContain("spotlighted comment by");
		expect(injectedText).toContain("profile: Spot Two test bot.");
		expect(injectedText).toContain("set parentCommentId to that commentId");
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

async function authCookie(): Promise<string> {
	return authCookieFor({
		subject: "1175142",
		login: "octocat",
		displayName: "Octo Cat",
	});
}

async function authCookieFor(profile: { subject: string; login: string; displayName: string }): Promise<string> {
	const user = await upsertGithubUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
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

function memoryRuntimeSql() {
	const values = new Map<string, string>();
	return {
		exec<T>(sql: string, ...params: unknown[]) {
			if (/SELECT value_json FROM runtime_state WHERE key = \?/.test(sql)) {
				const value = values.get(String(params[0]));
				return {
					toArray: () => (value === undefined ? [] : [{ value_json: value } as T]),
				};
			}
			if (/INSERT INTO runtime_state/.test(sql)) {
				values.set(String(params[0]), String(params[1]));
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
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

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof Request) {
		return input.url;
	}
	return input.toString();
}
