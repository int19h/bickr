import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { json } from "@bickr/shared/http";
import {
	botById,
	botPublicProfile,
	createBot,
	deleteBot,
	listForums,
	listWorldBots,
	RepositoryError,
	updateBot,
	userById,
} from "@bickr/shared/repository";
import {
	followBot,
	forumByHandle,
	botActivityFeedByHandle,
	botPublicProfileByHandle,
	buildNotificationForumContext,
	listHotThreads,
	listPendingNotifications,
	markBotSeenContent,
	markBotSeenFromResult,
	listThreads,
	markNotificationsDelivered,
	readThread,
	recordBotRuntimeFailureHumanNotification,
	recordSpotlightFailureHumanNotification,
	recordSpotlightToolHumanNotification,
	searchBots,
	searchPosts,
	unfollowBot,
	ensureBootstrapNotification,
	type ForumContextProfileState,
	type ForumContextResult,
	type SeenContentItem,
} from "@bickr/shared/social";
import {
	type D1DatabaseLike,
	type KVNamespaceLike,
} from "@bickr/shared/storage";
import {
	InputError,
	normalizeHandle,
	parseCreateBotInput,
	parseUpdateBotInput,
} from "@bickr/shared/validation";
import {
	defaultProviderModel,
	type BotDocument,
	type CommentDocument,
	type BotRuntimeEvent,
	type BotRuntimeEventType,
	type BotRuntimeStatus,
	type BotSearchResult,
	type BotSummary,
	type BotTokenUsageBucket,
	type BotTokenUsageChangeMarker,
	type BotTokenUsageModelBreakdown,
	type BotTokenUsageStats,
	type BotTokenUsageTotals,
	type NotificationDocument,
	type ThreadDocument,
	type UserDocument,
} from "@bickr/shared/model";
import {
	mutableToolNames,
	openRouterServerToolSelection,
	standardPrompt,
	toolDefinitions,
	type ProviderToolDefinition,
} from "./prompt-and-tools";

export {
	isOpenRouterProviderBaseUrl,
	openRouterServerToolSelection,
	toolDefinitions,
	type OpenRouterServerToolDefinition,
	type OpenRouterServerToolSelection,
	type ProviderToolDefinition,
} from "./prompt-and-tools";

export interface Env {
	BICKR_D1: D1Database;
	BICKR_KV: KVNamespace;
	BOT_RUNTIME: DurableObjectNamespace;
	USER_BOTS: DurableObjectNamespace;
	FORUM_COORDINATOR_SERVICE: Fetcher;
	AI?: Ai;
	BICKR_BOT_VECTORIZE?: Vectorize;
	OPENROUTER_API_KEY?: string;
	OPENROUTER_BASE_URL?: string;
	OPENROUTER_MODEL?: string;
	BICKR_SIMULATION_MODE?: string;
}

type RuntimeRow = {
	seq: number;
	run_id: string;
	type: BotRuntimeEventType;
	payload_json: string;
	token_estimate: number;
	created_at: string;
	compacted_by: number | null;
};

type ChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | null;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
	reasoning?: string;
	reasoning_content?: string;
	reasoning_details?: ReasoningDetail[];
};

type ReasoningDetail = Record<string, unknown>;

type ToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

type ToolResult = {
	name: string;
	result: unknown;
	providerResult: unknown;
};

type ProviderUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cost: number | null;
	raw: Record<string, unknown>;
};

type ProviderResponse = {
	content: string;
	reasoning: string;
	reasoningDetails: ReasoningDetail[];
	toolCalls: ToolCall[];
	usage?: ProviderUsage;
	responseId?: string;
	responseModel?: string;
};

type ProviderUsageRow = {
	created_at: string;
	run_id: string;
	model: string;
	requested_model: string;
	response_model: string | null;
	context_window_tokens: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cached_tokens: number;
	reasoning_tokens: number;
	cost: number | null;
};

type ToolFailurePayload = {
	ok: false;
	code: string;
	message: string;
	toolName: string;
	args: Record<string, unknown>;
	guidance?: string;
	existingUrlPath?: string;
	existingThreadId?: string;
	existingCommentId?: string;
};

class PersistentToolFailureError extends Error {
	readonly failure: ToolFailurePayload;

	constructor(failure: ToolFailurePayload) {
		super(`Stopped after 5 consecutive failed tool calls. Last error: ${failure.message}`);
		this.name = "PersistentToolFailureError";
		this.failure = failure;
	}
}

type DuplicateReply = {
	threadId: string;
	commentId: string;
	urlPath: string;
	seq: number;
};

class DuplicateReplyError extends Error {
	readonly duplicate: DuplicateReply;

	constructor(duplicate: DuplicateReply) {
		super(`I already posted this exact comment recently: ${duplicate.urlPath}`);
		this.name = "DuplicateReplyError";
		this.duplicate = duplicate;
	}
}

class UnknownRuntimeTargetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnknownRuntimeTargetError";
	}
}

type TickRunResult = {
	runId: string;
	status: "already_running" | "completed" | "failed" | "paused" | "started" | "stopped";
	error?: string;
};

type TickMode = "normal" | "spotlight";

type TickOptions = {
	mode?: TickMode;
	injectionIds?: string[];
	spotlightId?: string;
	background?: boolean;
};

export type LoopNotification = {
	id: string;
	type: string;
	message: string;
	sourceObjectId?: string;
	threadId?: string;
	commentId?: string;
	parentCommentId?: string;
	context?: ProviderNotificationForumContext;
};

type ProviderNotificationForumContext = {
	threadId: string;
	title: string;
	commentId?: string;
	parentCommentId?: string;
	content: Array<Record<string, unknown>>;
};

export type LoopInput = {
	notifications: LoopNotification[];
	injections: string[];
	ping: boolean;
	toolUseReminder?: string;
};

export type RuntimeLoopInputBuild = {
	input: LoopInput;
	autoProfileSeenItems: SeenContentItem[];
};

type InjectionMetadata = {
	kind?: string;
	sourceId?: string;
	spotlightId?: string;
};

type InjectionRow = {
	id: string;
	text: string;
	kind: string;
	sourceId: string | null;
	spotlightId: string | null;
};

type KnownRuntimeTargets = {
	threadIds: Set<string>;
	commentIds: Set<string>;
	commentThreadIds: Map<string, string>;
};

type RunContext = {
	mode: TickMode;
	spotlightId?: string;
	signal: AbortSignal;
	knownTargets: KnownRuntimeTargets;
};

type ProviderMessageStatus = "complete" | "interrupted";

type ProviderStreamActivity = {
	type: string;
	created_at: string;
};

type ThoughtBlock = {
	runId: string;
	startSeq: number;
	endSeq: number;
	createdAt: string;
	text: string;
};

type ReadContentItem = {
	type: "thread" | "comment";
	id: string;
	threadId: string;
	commentId?: string;
	parentCommentId?: string;
	worldId: string;
	worldHandle: string;
	forumId: string;
	forumHandle: string;
	authorBotId: string;
	authorHandle: string;
	authorDisplayName: string;
	title?: string;
	body: string;
	createdAt: string;
	target?: boolean;
	ancestorOnly?: boolean;
};

type ProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	temperature: number;
	usesCustomBaseUrl?: boolean;
	topK?: number;
	topP?: number;
	minP?: number;
};

type ProviderChatCompletionRequest = {
	model: string;
	messages: ChatMessage[];
	tools: ProviderToolDefinition[];
	tool_choice: typeof providerToolChoice;
	parallel_tool_calls: typeof providerParallelToolCalls;
	stream: true;
	stream_options: {
		include_usage: true;
	};
	reasoning: {
		enabled: true;
		exclude: false;
	};
	temperature: number;
	top_k?: number;
	top_p?: number;
	min_p?: number;
};

type ProviderLoopOutcome = {
	toolCallCount: number;
};

type ToolUseRecoveryState = {
	consecutiveNoToolTicks: number;
	lastRunId: string;
	updatedAt: string;
};

class ProviderRequestError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, model: string, endpoint: string, body: string) {
		const suffix = body ? ` Provider response: ${body}` : "";
		super(`Inference request failed with status ${status} for model "${model}" at ${endpoint}.${suffix}`);
		this.name = "ProviderRequestError";
		this.status = status;
		this.body = body;
	}
}

class ProviderRequestTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Provider did not return response headers within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "ProviderRequestTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

class ProviderStreamIdleTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Provider stream timed out after ${Math.round(timeoutMs / 1000)} seconds without data.`);
		this.name = "ProviderStreamIdleTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

class TickStoppedError extends Error {
	constructor() {
		super("Tick stopped by request.");
		this.name = "TickStoppedError";
	}
}

const stopRequestStateKey = "stop_requested_run_id";
const toolUseRecoveryStateKey = "tool_use_recovery";
const providerRequestTimeoutMs = 60_000;
const providerStreamIdleTimeoutMs = 60_000;
const providerMaxAttempts = 3;
const providerRetryBaseDelayMs = 3_000;
const providerToolChoice = "auto" as const;
const providerParallelToolCalls = true;
const providerContextReserveTokens = 2_500;
const dayMs = 24 * 60 * 60 * 1000;
const fallbackProviderModel = defaultProviderModel;
const fallbackProviderBaseUrl = "https://openrouter.ai/api/v1";

export function toolUseRecoveryReminder(state: Pick<ToolUseRecoveryState, "consecutiveNoToolTicks">): string {
	const prefix =
		state.consecutiveNoToolTicks > 1 ?
			`${state.consecutiveNoToolTicks} recent ticks ended without tool calls.`
		:	"The previous tick ended without tool calls.";
	return `${prefix} For this tick, use available function tools when browsing, reading, posting, replying, voting, following, or searching. Emit tool calls with JSON arguments matching the provided tool definitions. Only finish without tool calls when no lookup or visible action is appropriate.`;
}

export function providerChatCompletionRequest(
	settings: ProviderSettings,
	messages: ChatMessage[],
	tools: ProviderToolDefinition[],
): ProviderChatCompletionRequest {
	return {
		model: settings.model,
		messages,
		tools,
		tool_choice: providerToolChoice,
		parallel_tool_calls: providerParallelToolCalls,
		stream: true,
		stream_options: {
			include_usage: true,
		},
		reasoning: {
			enabled: true,
			exclude: false,
		},
		temperature: settings.temperature,
		...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
		...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
	};
}

const runtimeSchema = `
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	type TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	token_estimate INTEGER NOT NULL,
	compacted_by INTEGER,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, seq);
CREATE INDEX IF NOT EXISTS events_compaction ON events (compacted_by, seq);
CREATE TABLE IF NOT EXISTS runtime_state (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS injections (
	id TEXT PRIMARY KEY,
	text TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'manual',
	source_id TEXT,
	spotlight_id TEXT,
	created_at TEXT NOT NULL,
	consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS provider_usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	request_seq INTEGER NOT NULL,
	provider_response_id TEXT,
	requested_model TEXT NOT NULL,
	response_model TEXT,
	model TEXT NOT NULL,
	context_window_tokens INTEGER NOT NULL,
	provider_base_url TEXT NOT NULL,
	prompt_tokens INTEGER NOT NULL,
	completion_tokens INTEGER NOT NULL,
	total_tokens INTEGER NOT NULL,
	cached_tokens INTEGER NOT NULL DEFAULT 0,
	reasoning_tokens INTEGER NOT NULL DEFAULT 0,
	cost REAL,
	usage_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_usage_created_at ON provider_usage (created_at);
CREATE INDEX IF NOT EXISTS provider_usage_model_context ON provider_usage (model, context_window_tokens, created_at);
`;

export class BotRuntime {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private activeAbortController: AbortController | null = null;
	private activeRunId: string | null = null;
	private readonly activeStreamActivity = new Map<string, string>();
	private ephemeralStreamSeq = 0;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.state.blockConcurrencyWhile(async () => {
			for (const statement of runtimeSchema.split(";")) {
				const sql = statement.trim();
				if (sql) {
					this.state.storage.sql.exec(sql);
				}
			}
			this.ensureInjectionColumns();
		});
	}

	private ensureInjectionColumns(): void {
		const columns = new Set(
			this.state.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(injections)`)
				.toArray()
				.map((row) => row.name),
		);
		if (!columns.has("kind")) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'`);
		}
		if (!columns.has("source_id")) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN source_id TEXT`);
		}
		if (!columns.has("spotlight_id")) {
			this.state.storage.sql.exec(`ALTER TABLE injections ADD COLUMN spotlight_id TEXT`);
		}
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			const botId = botIdFromPath(url.pathname);

			if (request.method === "GET" && url.pathname.endsWith("/status")) {
				await this.requireOwnerOrInternal(request, botId);
				return ok({ status: await this.status(botId) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/events")) {
				await this.requireOwnerOrInternal(request, botId);
				const after = Number(url.searchParams.get("after") ?? 0);
				return ok({ events: this.eventsAfter(Number.isFinite(after) ? after : 0) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/token-usage")) {
				await this.requireOwnerOrInternal(request, botId);
				return ok({ usage: this.tokenUsageStats() });
			}

			if (request.method === "DELETE" && url.pathname.endsWith("/events")) {
				await this.requireOwnerOrInternal(request, botId);
				const cleared = await this.clearHistory(botId);
				return ok({ cleared });
			}

			if (request.method === "DELETE" && eventSeqFromPath(url.pathname) !== null) {
				await this.requireOwnerOrInternal(request, botId);
				const deleted = await this.deleteEvent(botId, eventSeqFromPath(url.pathname) ?? 0);
				return ok({ deleted });
			}

			if (request.method === "POST" && url.pathname.endsWith("/tick")) {
				await this.requireOwnerOrInternal(request, botId);
				const options = await readTickOptions(request);
				const trigger =
					options.mode === "spotlight" ? "spotlight"
					: request.headers.get("x-bickr-scheduler") ? "cron"
					: "manual";
				if (options.background) {
					const run = await this.startBackgroundTick(botId, trigger, options);
					return ok({ run });
				}
				const run = await this.runTick(botId, trigger, options);
				return ok({ run });
			}

			if (request.method === "POST" && url.pathname.endsWith("/stop")) {
				await this.requireOwnerOrInternal(request, botId);
				const stop = await this.stopTick(botId);
				return ok({ stop });
			}

			if (request.method === "POST" && url.pathname.endsWith("/inject")) {
				await this.requireOwnerOrInternal(request, botId);
				const body = await readJsonBody(request);
				const text =
					body && typeof body === "object" && "text" in body && typeof body.text === "string" ?
						body.text.trim()
					:	"";
				if (!text) {
					throw new InputError("Injection text is required.");
				}
				const event = await this.injectThought(text, {
					kind: stringValue(body && typeof body === "object" ? (body as Record<string, unknown>).kind : undefined) ?? "manual",
					sourceId: stringValue(body && typeof body === "object" ? (body as Record<string, unknown>).sourceId : undefined),
					spotlightId: stringValue(body && typeof body === "object" ? (body as Record<string, unknown>).spotlightId : undefined),
				});
				return ok({ event, injectionId: stringValue(runtimeRecord(event.payload).injectionId) });
			}

			if (request.method === "GET" && url.pathname.endsWith("/monitor")) {
				await this.requireOwnerOrInternal(request, botId);
				if (request.headers.get("Upgrade") !== "websocket") {
					return fail("bad_request", "Expected WebSocket upgrade.", 400);
				}
				const pair = new WebSocketPair();
				const [client, server] = Object.values(pair);
				this.state.acceptWebSocket(server, [botId]);
				const after = Number(url.searchParams.get("after") ?? 0);
				for (const event of this.eventsAfter(Number.isFinite(after) ? after : 0)) {
					server.send(JSON.stringify({ type: "event", event }));
				}
				return new Response(null, { status: 101, webSocket: client });
			}

			return fail("not_found", "Bot runtime route not found.", 404);
		} catch (error) {
			return errorResponse(error);
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		try {
			const text = typeof message === "string" ? message : new TextDecoder().decode(message);
			const payload = JSON.parse(text) as { type?: string; text?: string };
			if (payload.type === "inject" && payload.text?.trim()) {
				const event = await this.injectThought(payload.text.trim());
				ws.send(JSON.stringify({ type: "event", event }));
			}
		} catch (error) {
			ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Bad message." }));
		}
	}

	async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
		console.error("bot runtime monitor WebSocket error", error);
	}

	private async startBackgroundTick(
		botId: string,
		trigger: "cron" | "manual" | "spotlight",
		options: TickOptions,
	): Promise<TickRunResult> {
		const current = await this.status(botId);
		if (this.activeRunId) {
			return { runId: this.activeRunId, status: "already_running" };
		}
		if (current.status === "running") {
			return { runId: current.activeRunId ?? "active", status: "already_running" };
		}
		if (!current.enabled) {
			return pausedTickResult();
		}
		const tick = this.runTick(botId, trigger, { ...options, background: false }).catch((error) => {
			console.error("background bot tick failed", error);
		});
		this.state.waitUntil(tick);
		return { runId: "background", status: "started" };
	}

	private async runTick(botId: string, trigger: "cron" | "manual" | "spotlight", options: TickOptions = {}): Promise<TickRunResult> {
		const current = await this.status(botId);
		if (this.activeRunId) {
			return { runId: this.activeRunId, status: "already_running" };
		}
		if (current.status === "running") {
			return { runId: current.activeRunId ?? "active", status: "already_running" };
		}
		if (!current.enabled) {
			return pausedTickResult();
		}

		const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		const owner = await userById(this.env.BICKR_KV, bot.ownerUserId);
		const providerSettings = this.effectiveProviderSettings(bot, owner);
		const runId = crypto.randomUUID();
		const now = new Date().toISOString();
		const abortController = new AbortController();
		this.activeAbortController = abortController;
		this.activeRunId = runId;
		this.clearStopRequest();
		await this.setRuntimeIndex(bot, "running", runId, undefined, now);
		await this.appendEvent(runId, "tick_started", { trigger, botId, handle: bot.handle });
		const mode: TickMode = options.mode === "spotlight" ? "spotlight" : "normal";
		const runContext: RunContext = {
			mode,
			...(options.spotlightId ? { spotlightId: options.spotlightId } : {}),
			signal: abortController.signal,
			knownTargets: emptyKnownRuntimeTargets(),
		};

		try {
			this.throwIfStopped(runId, abortController.signal);
			const notifications =
				mode === "spotlight" ? []
				: await (async () => {
						await ensureBootstrapNotification(this.env.BICKR_KV, this.env.BICKR_D1, bot);
						return listPendingNotifications(this.env.BICKR_KV, this.env.BICKR_D1, bot.id);
					})();
			this.throwIfStopped(runId, abortController.signal);
			const injections = this.consumeInjections(mode === "spotlight" ? options.injectionIds ?? [] : undefined);
			const builtInput = await buildRuntimeLoopInput(
				this.env.BICKR_KV,
				this.env.BICKR_D1,
				bot.id,
				notifications,
				injections,
				this.pendingToolUseReminder(),
			);
			const input = builtInput.input;
			rememberLoopInputTargets(runContext.knownTargets, input);
			await this.appendEvent(runId, "input", input);
			if (mode === "spotlight" && injections.length === 0) {
				const nextDueAt = await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
				await this.appendEvent(runId, "tick_completed", {
					...(nextDueAt ? { nextDueAt } : {}),
					note: "No pending spotlight injection was available.",
				});
				return { runId, status: "completed" };
			}
			if (mode !== "spotlight") {
				await markBotSeenContent(
					this.env.BICKR_D1,
					bot.id,
					[
						...notifications
							.map((notification) => seenItemFromSource(notification.sourceObjectId))
							.filter((item): item is { type: "thread" | "comment"; id: string } => Boolean(item)),
						...builtInput.autoProfileSeenItems,
					],
					"notification",
					runId,
				);
				await markNotificationsDelivered(this.env.BICKR_KV, this.env.BICKR_D1, notifications);
			}

			await this.compactIfNeeded(bot, runId);
			const messages = await this.buildMessages(bot, input);
			this.throwIfStopped(runId, abortController.signal);
			if (providerSettings.apiKey || providerSettings.usesCustomBaseUrl || this.env.BICKR_SIMULATION_MODE === "provider") {
				const outcome = await this.runProviderLoop(bot, providerSettings, runId, messages, runContext);
				this.recordToolUseRecoveryOutcome(runId, outcome.toolCallCount);
			} else {
				await this.runLocalSimulation(bot, runId, input, runContext);
			}

			await this.compactIfNeeded(bot, runId);
			const nextDueAt = await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
			await this.appendEvent(runId, "tick_completed", { ...(nextDueAt ? { nextDueAt } : {}) });
			return { runId, status: "completed" };
		} catch (error) {
			if (error instanceof TickStoppedError || isAbortError(error)) {
				if (!this.hasTerminalEvent(runId)) {
					await this.appendEvent(runId, "tick_stopped", { message: "Tick stopped by request." });
				}
				await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
				return { runId, status: "stopped" };
			}
			if (error instanceof PersistentToolFailureError) {
				if (!this.hasTerminalEvent(runId)) {
					await this.appendEvent(runId, "tick_failed", {
						message: error.message,
						toolName: error.failure.toolName,
						failure: error.failure,
					});
				}
				await this.setRuntimeIndex(bot, "failed", null, error.message, new Date().toISOString());
				try {
					await recordBotRuntimeFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						message: error.failure.message,
						toolName: error.failure.toolName,
					});
					if (runContext.mode === "spotlight" && runContext.spotlightId) {
						await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
							bot,
							runId,
							spotlightId: runContext.spotlightId,
							message: error.message,
						});
					}
				} catch (notificationError) {
					console.warn("bot runtime failure notification failed", notificationError);
				}
				return { runId, status: "failed", error: error.message };
			}
			const message = error instanceof Error ? error.message : "Unexpected bot runtime error.";
			if (!this.hasTerminalEvent(runId)) {
				await this.appendEvent(runId, "tick_failed", { message });
			}
			await this.setRuntimeIndex(bot, "failed", null, message, new Date().toISOString());
			if (runContext.mode === "spotlight" && runContext.spotlightId) {
				try {
					await recordSpotlightFailureHumanNotification(this.env.BICKR_D1, {
						bot,
						runId,
						spotlightId: runContext.spotlightId,
						message,
					});
				} catch (notificationError) {
					console.warn("spotlight failure notification failed", notificationError);
				}
			}
			return { runId, status: "failed", error: message };
		} finally {
			if (this.activeRunId === runId) {
				this.activeAbortController = null;
				this.activeRunId = null;
			}
			this.clearStopRequest(runId);
		}
	}

	private async stopTick(botId: string): Promise<{ stopped: boolean; runId?: string; status: BotRuntimeStatus["status"] }> {
		const current = await this.status(botId);
		const runId = current.activeRunId ?? this.activeRunId ?? undefined;
		if (current.status !== "running" || !runId) {
			return { stopped: false, status: current.status };
		}

		this.setStopRequest(runId);
		await this.appendEvent(runId, "tick_stop_requested", { message: "Stop requested." });
		if (this.activeRunId === runId && this.activeAbortController && !this.activeAbortController.signal.aborted) {
			this.activeAbortController.abort();
			return { stopped: true, runId, status: current.status };
		}
		const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
		await this.markRunStopped(bot, runId);
		return { stopped: true, runId, status: "idle" };
	}

	private setStopRequest(runId: string): void {
		this.state.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			stopRequestStateKey,
			JSON.stringify(runId),
		);
	}

	private clearStopRequest(runId?: string): void {
		if (runId) {
			this.state.storage.sql.exec(
				`DELETE FROM runtime_state WHERE key = ? AND value_json = ?`,
				stopRequestStateKey,
				JSON.stringify(runId),
			);
			return;
		}
		this.state.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ?`, stopRequestStateKey);
	}

	private throwIfStopped(runId: string, signal: AbortSignal): void {
		if (signal.aborted) {
			throw new TickStoppedError();
		}
		if (this.hasStopRequest(runId)) {
			throw new TickStoppedError();
		}
	}

	private hasStopRequest(runId: string): boolean {
		const row = this.state.storage.sql
			.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, stopRequestStateKey)
			.toArray()[0];
		if (!row) {
			return false;
		}
		const requestedRunId = stringValue(JSON.parse(row.value_json));
		return requestedRunId === runId;
	}

	private pendingToolUseReminder(): string | undefined {
		const state = this.toolUseRecoveryState();
		return state ? toolUseRecoveryReminder(state) : undefined;
	}

	private recordToolUseRecoveryOutcome(runId: string, toolCallCount: number): void {
		if (toolCallCount > 0) {
			this.clearToolUseRecoveryState();
			return;
		}
		this.setToolUseRecoveryState(runId);
	}

	private toolUseRecoveryState(): ToolUseRecoveryState | undefined {
		const row = this.state.storage.sql
			.exec<{ value_json: string }>(`SELECT value_json FROM runtime_state WHERE key = ?`, toolUseRecoveryStateKey)
			.toArray()[0];
		if (!row) {
			return undefined;
		}
		try {
			const record = runtimeRecord(JSON.parse(row.value_json));
			const consecutiveNoToolTicks = integerValue(record.consecutiveNoToolTicks);
			const lastRunId = stringValue(record.lastRunId);
			const updatedAt = stringValue(record.updatedAt);
			if (!consecutiveNoToolTicks || !lastRunId || !updatedAt) {
				this.clearToolUseRecoveryState();
				return undefined;
			}
			return { consecutiveNoToolTicks, lastRunId, updatedAt };
		} catch {
			this.clearToolUseRecoveryState();
			return undefined;
		}
	}

	private setToolUseRecoveryState(runId: string): void {
		const previous = this.toolUseRecoveryState();
		const consecutiveNoToolTicks =
			previous && previous.lastRunId !== runId ? previous.consecutiveNoToolTicks + 1
			: previous ? previous.consecutiveNoToolTicks
			: 1;
		const state: ToolUseRecoveryState = {
			consecutiveNoToolTicks,
			lastRunId: runId,
			updatedAt: new Date().toISOString(),
		};
		this.state.storage.sql.exec(
			`INSERT INTO runtime_state (key, value_json)
			 VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			toolUseRecoveryStateKey,
			JSON.stringify(state),
		);
	}

	private clearToolUseRecoveryState(): void {
		this.state.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ?`, toolUseRecoveryStateKey);
	}

	private async markRunStopped(bot: BotDocument, runId: string): Promise<string | null> {
		if (!this.hasTerminalEvent(runId)) {
			await this.appendEvent(runId, "tick_stopped", { message: "Tick stopped by request." });
		}
		const nextDueAt = await this.setRuntimeIndex(bot, "idle", null, undefined, new Date().toISOString());
		this.clearStopRequest(runId);
		return nextDueAt;
	}

	private async runProviderLoop(
		bot: BotDocument,
		settings: ProviderSettings,
		runId: string,
		messages: ChatMessage[],
		runContext: RunContext,
	): Promise<ProviderLoopOutcome> {
		let currentMessages = [...messages];
		let consecutiveToolFailures = 0;
		let toolCallCount = 0;
		for (let turn = 0; turn < bot.tickSettings.maxToolCallsPerTick; turn += 1) {
			this.throwIfStopped(runId, runContext.signal);
			const serverTools = openRouterServerToolSelection(settings.baseUrl, bot.toolSettings);
			const providerTools: ProviderToolDefinition[] = [...toolDefinitions, ...serverTools.tools];
			const requestEvent = await this.appendEvent(runId, "provider_request", {
				model: settings.model,
				messageCount: currentMessages.length,
				toolCount: providerTools.length,
				toolChoice: providerToolChoice,
				parallelToolCalls: providerParallelToolCalls,
				contextWindowTokens: bot.tickSettings.contextWindowTokens,
				temperature: settings.temperature,
				openRouterServerTools: {
					enabled: serverTools.enabled,
					emitted: serverTools.emitted,
					suppressed: serverTools.suppressed,
				},
				...(settings.topK !== undefined ? { topK: settings.topK } : {}),
				...(settings.topP !== undefined ? { topP: settings.topP } : {}),
				...(settings.minP !== undefined ? { minP: settings.minP } : {}),
			});
			const response = await this.callProvider(settings, currentMessages, providerTools, runId, runContext.signal);
			if (response.usage) {
				this.recordProviderUsage({
					contextWindowTokens: bot.tickSettings.contextWindowTokens,
					createdAt: requestEvent.createdAt,
					providerResponseId: response.responseId,
					requestSeq: requestEvent.seq,
					responseModel: response.responseModel,
					runId,
					settings,
					usage: response.usage,
				});
			}
			await this.appendProviderMessages(runId, response, "complete");
			currentMessages = [
				...currentMessages,
				{
					role: "assistant",
					content: response.content || null,
					...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
					...(response.reasoningDetails.length > 0 ? { reasoning_details: response.reasoningDetails }
					: response.reasoning ? { reasoning: response.reasoning }
					: {}),
				},
			];
			if (response.toolCalls.length === 0) {
				return { toolCallCount };
			}
			toolCallCount += response.toolCalls.length;

			for (const toolCall of response.toolCalls) {
				this.throwIfStopped(runId, runContext.signal);
				const args = parseToolArgs(toolCall);
				let result: ToolResult;
				try {
					result = await this.executeTool(bot, runId, toolCall.function.name, args, runContext);
					consecutiveToolFailures = 0;
				} catch (error) {
					if (error instanceof TickStoppedError || isAbortError(error)) {
						throw error;
					}
					const failure = toolFailurePayload(toolCall.function.name, args, error);
					consecutiveToolFailures += 1;
					await this.appendEvent(runId, "tool_result", {
						name: toolCall.function.name || "unknown_tool",
						args,
						result: failure,
						error: true,
						consecutiveFailures: consecutiveToolFailures,
					});
					currentMessages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						content: JSON.stringify(failure),
					});
					if (consecutiveToolFailures >= 5) {
						throw new PersistentToolFailureError(failure);
					}
					continue;
				}
				currentMessages.push({
					role: "tool",
					tool_call_id: toolCall.id,
					content: JSON.stringify(result.providerResult),
				});
			}
		}
		return { toolCallCount };
	}

	private async callProvider(
		settings: ProviderSettings,
		messages: ChatMessage[],
		tools: ProviderToolDefinition[],
		runId: string,
		signal: AbortSignal,
	): Promise<ProviderResponse> {
		const endpoint = providerChatCompletionsUrl(settings.baseUrl);
		const body = JSON.stringify(providerChatCompletionRequest(settings, messages, tools));
		const response = await this.fetchProviderWithRetry(settings, endpoint, body, runId, signal);
		if (!response.body) {
			throw new ProviderRequestError(502, settings.model, endpoint, "Provider did not return a streaming response body.");
		}

		let content = "";
		let reasoning = "";
		const reasoningDetails: ReasoningDetail[] = [];
		const toolCalls = new Map<number, ToolCall>();
		let usage: ProviderUsage | undefined;
		let responseId: string | undefined;
		let responseModel: string | undefined;
		this.markProviderStreamActive(runId);
		try {
			for await (const event of readSse(response.body, signal)) {
				this.throwIfStopped(runId, signal);
				this.markProviderStreamActive(runId);
				if (event === "[DONE]") {
					break;
				}
				const chunk = JSON.parse(event) as {
					id?: unknown;
					model?: unknown;
					usage?: unknown;
					choices?: Array<{
						delta?: {
							content?: string;
							reasoning?: string;
							reasoning_content?: string;
							reasoning_details?: ReasoningDetail[];
							tool_calls?: Array<{
								index: number;
								id?: string;
								type?: "function";
								function?: { name?: string; arguments?: string };
							}>;
						};
					}>;
				};
				responseId = stringValue(chunk.id) ?? responseId;
				responseModel = stringValue(chunk.model) ?? responseModel;
				usage = providerUsageFromValue(chunk.usage) ?? usage;
				const delta = chunk.choices?.[0]?.delta;
				if (!delta) {
					continue;
				}
				if (delta.content) {
					content += delta.content;
					this.broadcastProviderDelta(runId, { kind: "content", text: delta.content });
				}
				const plainReasoning = delta.reasoning ?? delta.reasoning_content;
				let detailsReasoning = "";
				if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
					reasoningDetails.push(...delta.reasoning_details);
					detailsReasoning = reasoningTextFromDetails(delta.reasoning_details);
				}
				const deltaReasoning = plainReasoning || detailsReasoning;
				if (deltaReasoning) {
					reasoning += deltaReasoning;
					this.broadcastProviderDelta(runId, { kind: "reasoning", text: deltaReasoning });
				}
				for (const part of delta.tool_calls ?? []) {
					const current =
						toolCalls.get(part.index) ??
						({
							id: part.id ?? `tool-${part.index}`,
							type: "function",
							function: { name: "", arguments: "" },
						} satisfies ToolCall);
					if (part.id) {
						current.id = part.id;
					}
					if (part.function?.name) {
						current.function.name += part.function.name;
					}
					if (part.function?.arguments) {
						current.function.arguments += part.function.arguments;
					}
					toolCalls.set(part.index, current);
					this.broadcastProviderDelta(runId, { kind: "tool_call", part });
				}
			}
		} catch (error) {
			if (error instanceof TickStoppedError || error instanceof ProviderStreamIdleTimeoutError || isAbortError(error)) {
				await this.appendProviderMessages(runId, { content, reasoning, reasoningDetails, toolCalls: [...toolCalls.values()] }, "interrupted");
			}
			throw error;
		} finally {
			this.clearProviderStreamActive(runId);
		}
		return {
			content,
			reasoning,
			reasoningDetails,
			toolCalls: [...toolCalls.values()].filter((tool) => tool.function.name),
			...(usage ? { usage } : {}),
			...(responseId ? { responseId } : {}),
			...(responseModel ? { responseModel } : {}),
		};
	}

	private async appendProviderMessages(
		runId: string,
		response: ProviderResponse,
		status: ProviderMessageStatus,
	): Promise<void> {
		if (response.reasoning) {
			await this.appendEvent(runId, "reasoning_message", {
				content: response.reasoning,
				status,
			});
		}
		if (response.content) {
			await this.appendEvent(runId, "assistant_message", {
				content: response.content,
				status,
			});
		}
	}

	private recordProviderUsage(input: {
		contextWindowTokens: number;
		createdAt: string;
		providerResponseId?: string;
		requestSeq: number;
		responseModel?: string;
		runId: string;
		settings: ProviderSettings;
		usage: ProviderUsage;
	}): void {
		const model = input.responseModel?.trim() || input.settings.model;
		this.state.storage.sql.exec(
			`INSERT INTO provider_usage (
				run_id, request_seq, provider_response_id, requested_model, response_model, model,
				context_window_tokens, provider_base_url, prompt_tokens, completion_tokens, total_tokens,
				cached_tokens, reasoning_tokens, cost, usage_json, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.runId,
			input.requestSeq,
			input.providerResponseId ?? null,
			input.settings.model,
			input.responseModel ?? null,
			model,
			input.contextWindowTokens,
			input.settings.baseUrl,
			input.usage.promptTokens,
			input.usage.completionTokens,
			input.usage.totalTokens,
			input.usage.cachedTokens,
			input.usage.reasoningTokens,
			input.usage.cost,
			JSON.stringify(input.usage.raw),
			input.createdAt,
		);
	}

	private tokenUsageStats(now = new Date()): BotTokenUsageStats {
		const windowEndMs = now.getTime();
		const windowStartMs = windowEndMs - 7 * dayMs;
		const last24StartMs = windowEndMs - dayMs;
		const windowStart = new Date(windowStartMs).toISOString();
		const windowEnd = now.toISOString();
		const rows = this.providerUsageRows(windowStart, windowEnd);
		const buckets = sevenDayUsageBuckets(windowStartMs, rows);
		const last24Hours = emptyUsageTotals();
		const last7Days = emptyUsageTotals();
		const models = new Map<string, BotTokenUsageModelBreakdown>();

		for (const row of rows) {
			const usedAt = Date.parse(row.created_at);
			addUsageRow(last7Days, row);
			if (Number.isFinite(usedAt) && usedAt >= last24StartMs) {
				addUsageRow(last24Hours, row);
			}
			const modelKey = `${row.model}\u0000${row.context_window_tokens}`;
			const current = models.get(modelKey);
			if (current) {
				addUsageRow(current, row);
				current.firstUsedAt = row.created_at < current.firstUsedAt ? row.created_at : current.firstUsedAt;
				current.lastUsedAt = row.created_at > current.lastUsedAt ? row.created_at : current.lastUsedAt;
			} else {
				const totals = emptyUsageTotals();
				addUsageRow(totals, row);
				models.set(modelKey, {
					...totals,
					model: row.model,
					contextWindowTokens: row.context_window_tokens,
					firstUsedAt: row.created_at,
					lastUsedAt: row.created_at,
				});
			}
		}
		const dailyAverageDays = tokenUsageAverageDays(rows, windowEndMs);

		return {
			generatedAt: windowEnd,
			windowStart,
			windowEnd,
			last24Hours,
			last7Days,
			dailyAverageTokens: dailyAverageDays > 0 ? Math.round(last7Days.totalTokens / dailyAverageDays) : 0,
			dailyAverageDays,
			buckets,
			models: [...models.values()].sort((left, right) => right.totalTokens - left.totalTokens),
			changeMarkers: this.tokenUsageChangeMarkers(windowStart, windowEnd),
		};
	}

	private providerUsageRows(since: string, until: string): ProviderUsageRow[] {
		return this.state.storage.sql
			.exec<ProviderUsageRow>(
				`SELECT created_at, run_id, model, requested_model, response_model, context_window_tokens,
				        prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost
				 FROM provider_usage
				 WHERE created_at >= ?
				   AND created_at <= ?
				 ORDER BY created_at ASC, id ASC`,
				since,
				until,
			)
			.toArray();
	}

	private tokenUsageChangeMarkers(since: string, until: string): BotTokenUsageChangeMarker[] {
		const previous = this.state.storage.sql
			.exec<ProviderUsageRow>(
				`SELECT created_at, run_id, model, requested_model, response_model, context_window_tokens,
				        prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost
				 FROM provider_usage
				 WHERE created_at < ?
				 ORDER BY created_at DESC, id DESC
				 LIMIT 1`,
				since,
			)
			.toArray()[0];
		let previousModel = previous?.model;
		let previousContextWindowTokens = previous?.context_window_tokens;
		const markers: BotTokenUsageChangeMarker[] = [];
		for (const row of this.providerUsageRows(since, until)) {
			if (row.model !== previousModel || row.context_window_tokens !== previousContextWindowTokens) {
				markers.push({
					usedAt: row.created_at,
					runId: row.run_id,
					model: row.model,
					requestedModel: row.requested_model,
					...(row.response_model ? { responseModel: row.response_model } : {}),
					contextWindowTokens: row.context_window_tokens,
					...(previousModel ? { previousModel } : {}),
					...(previousContextWindowTokens !== undefined ? { previousContextWindowTokens } : {}),
					totalTokens: row.total_tokens,
					cachedTokens: row.cached_tokens,
					cost: row.cost,
				});
			}
			previousModel = row.model;
			previousContextWindowTokens = row.context_window_tokens;
		}
		return markers;
	}

	private broadcastProviderDelta(runId: string, payload: Record<string, unknown>): void {
		const latestSeq = this.latestEventSeq();
		this.ephemeralStreamSeq = (this.ephemeralStreamSeq % 100_000) + 1;
		const event: BotRuntimeEvent = {
			seq: latestSeq + this.ephemeralStreamSeq / 1_000_000,
			runId,
			type: "provider_delta",
			payload: {
				...payload,
				ephemeral: true,
			},
			tokenEstimate: 0,
			createdAt: new Date().toISOString(),
		};
		this.broadcastControl({ type: "stream_delta", event });
	}

	private latestEventSeq(): number {
		return this.state.storage.sql
			.exec<{ seq: number }>(`SELECT seq FROM events ORDER BY seq DESC LIMIT 1`)
			.toArray()[0]?.seq ?? 0;
	}

	private markProviderStreamActive(runId: string): void {
		this.activeStreamActivity.set(runId, new Date().toISOString());
	}

	private clearProviderStreamActive(runId: string): void {
		this.activeStreamActivity.delete(runId);
	}

	private async fetchProviderWithRetry(
		settings: ProviderSettings,
		endpoint: string,
		body: string,
		runId: string,
		signal: AbortSignal,
	): Promise<Response> {
		let previousRetryKey: string | null = null;
		for (let attempt = 1; attempt <= providerMaxAttempts; attempt += 1) {
			this.throwIfStopped(runId, signal);
			if (attempt > 1) {
				const baseDelay = providerRetryBaseDelayMs * 3 ** (attempt - 2);
				const delayMs = jitteredDelay(baseDelay);
				await this.appendEvent(runId, "provider_retry", {
					attempt,
					maxAttempts: providerMaxAttempts,
					delayMs,
					reason: previousRetryKey,
				});
				await sleep(delayMs, signal);
			}

			let response: Response;
			try {
				const headers: Record<string, string> = {
					"content-type": "application/json",
				};
				if (settings.apiKey) {
					headers.authorization = `Bearer ${settings.apiKey}`;
				}
				response = await providerFetchWithHeaderTimeout(
					endpoint,
					{
						method: "POST",
						headers,
						body,
					},
					signal,
					providerRequestTimeoutMs,
				);
			} catch (error) {
				if (error instanceof TickStoppedError || isAbortError(error)) {
					throw error;
				}
				if (error instanceof ProviderRequestTimeoutError) {
					const retryKey = error.message;
					if (attempt < providerMaxAttempts && (previousRetryKey === null || previousRetryKey === retryKey)) {
						previousRetryKey = retryKey;
						continue;
					}
				}
				throw error;
			}

			if (response.ok) {
				return response;
			}

			const bodyText = await readLimitedText(response.body, 1_200);
			const error = new ProviderRequestError(response.status, settings.model, endpoint, bodyText);
			if (isRetryableProviderStatus(response.status)) {
				const retryKey = `${response.status}:${bodyText}`;
				if (attempt < providerMaxAttempts && (previousRetryKey === null || previousRetryKey === retryKey)) {
					previousRetryKey = retryKey;
					continue;
				}
			}
			throw error;
		}
		throw new ProviderRequestTimeoutError(providerRequestTimeoutMs);
	}

	private effectiveProviderSettings(bot: BotDocument, owner: UserDocument): ProviderSettings {
		const userSettings = owner.inferenceSettings ?? {};
		const envModel = trimmed(this.env.OPENROUTER_MODEL);
		const envBaseUrl = trimmed(this.env.OPENROUTER_BASE_URL);
		const envApiKey = trimmed(this.env.OPENROUTER_API_KEY);
		const userModel = trimmed(userSettings.model);
		const botModel = trimmed(bot.inferenceSettings.model);
		const userBaseUrl = trimmed(userSettings.baseUrl);
		const botBaseUrl = trimmed(bot.inferenceSettings.baseUrl);
		const userApiKey = trimmed(userSettings.openRouterApiKey);
		const botApiKey = trimmed(bot.inferenceSettings.openRouterApiKey);
		const botTemperatureIsLegacyDefault = bot.inferenceSettings.temperature === 0.9;
		const hasUserProvider = Boolean(userApiKey || userBaseUrl);
		const hasBotOrInheritedProvider = Boolean(botApiKey || botBaseUrl || hasUserProvider);
		const hasCustomBaseUrl = Boolean(botBaseUrl || userBaseUrl);

		const model =
			botModel && hasBotOrInheritedProvider ? botModel
			: userModel && hasUserProvider ? userModel
			: envModel ? envModel
			: fallbackProviderModel;
		const baseUrl = botBaseUrl ?? userBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
		const temperature =
			bot.inferenceSettings.temperature !== undefined &&
			(!botTemperatureIsLegacyDefault || userSettings.temperature === undefined) ?
				bot.inferenceSettings.temperature
			: userSettings.temperature !== undefined ? userSettings.temperature
			: bot.inferenceSettings.temperature !== undefined ? bot.inferenceSettings.temperature
			: 0.9;

		return {
			apiKey: botApiKey ?? userApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
			baseUrl,
			model,
			temperature,
			...(hasCustomBaseUrl ? { usesCustomBaseUrl: true } : {}),
			...(bot.inferenceSettings.topK !== undefined ? { topK: bot.inferenceSettings.topK }
			: userSettings.topK !== undefined ? { topK: userSettings.topK }
			: {}),
			...(bot.inferenceSettings.topP !== undefined ? { topP: bot.inferenceSettings.topP }
			: userSettings.topP !== undefined ? { topP: userSettings.topP }
			: {}),
			...(bot.inferenceSettings.minP !== undefined ? { minP: bot.inferenceSettings.minP }
			: userSettings.minP !== undefined ? { minP: userSettings.minP }
			: {}),
		};
	}

	private async runLocalSimulation(
		bot: BotDocument,
		runId: string,
		input: { notifications: Array<{ message: string }>; ping: boolean },
		runContext: RunContext,
	): Promise<void> {
		this.throwIfStopped(runId, runContext.signal);
		const hot = await listHotThreads(this.env.BICKR_D1, bot.homeWorldId, 10);
		const replyTarget = hot.find((thread) => thread.authorBotId !== bot.id);
		if (replyTarget && !input.notifications.some((notification) => notification.message.includes("first time"))) {
			this.throwIfStopped(runId, runContext.signal);
			await this.appendEvent(runId, "assistant_message", {
				content: `Local simulation: replying to "${replyTarget.title}".`,
			});
			await this.executeTool(bot, runId, "reply_to_thread", {
				threadId: replyTarget.id,
				body: `${bot.displayName} weighs in: ${bot.shortBio}`,
			}, runContext);
			return;
		}

		const forums = await listForums(this.env.BICKR_D1, bot.homeWorldHandle);
		const forum =
			forums.find((item) => !item.personalBotId) ??
			forums.find((item) => item.personalBotId === bot.id) ??
			forums[0];
		if (!forum) {
			await this.appendEvent(runId, "assistant_message", { content: "Local simulation: no forum to post in." });
			return;
		}
		this.throwIfStopped(runId, runContext.signal);
		await this.appendEvent(runId, "assistant_message", {
			content: `Local simulation: creating a post in f/${forum.handle}.`,
		});
		await this.executeTool(bot, runId, "create_post", {
			forumHandle: forum.handle,
			title: `${bot.displayName} has logged in`,
			body: `${bot.shortBio}\n\n${bot.prompt.slice(0, 300)}`,
		}, runContext);
	}

	private async executeTool(
		bot: BotDocument,
		runId: string,
		name: string,
		args: Record<string, unknown>,
		runContext: RunContext,
	): Promise<ToolResult> {
		this.throwIfStopped(runId, runContext.signal);
		const canonicalName = canonicalToolName(name);
		const normalizedArgs = normalizeToolArgs(canonicalName, args);
		await this.appendEvent(runId, "tool_call", { name: canonicalName, args: providerToolArgs(canonicalName, normalizedArgs) });
		let result: unknown;
		switch (canonicalName) {
			case "list_accessible_forums":
				result = (await listForums(this.env.BICKR_D1, bot.homeWorldHandle)).filter((forum) => !forum.personalBotId);
				break;
			case "list_recent_threads": {
				const forum = await this.forumFromArgs(bot, normalizedArgs);
				result = await listThreads(this.env.BICKR_D1, forum.id, "recent", numberArg(normalizedArgs.limit, 20));
				break;
			}
			case "list_hot_threads":
				result = await listHotThreads(this.env.BICKR_D1, bot.homeWorldId, numberArg(normalizedArgs.limit, 20));
				break;
			case "read_thread":
			case "read_thread_by_id":
				result = this.threadReadResult(
					await readThread(this.env.BICKR_KV, stringArg(normalizedArgs.threadId, "threadId")),
					canonicalName,
				);
				break;
			case "read_comment_by_id":
				result = await this.readCommentById(bot, stringArg(normalizedArgs.commentId, "commentId"), canonicalName);
				break;
			case "create_post": {
				const forum = await this.forumFromArgs(bot, normalizedArgs);
				result = await this.forumService(
					`/forums/${encodeURIComponent(forum.id)}/threads`,
					bot.id,
					{
						title: stringArg(normalizedArgs.title, "title"),
						body: stringArg(normalizedArgs.body, "body"),
						...(typeof normalizedArgs.url === "string" ? { url: normalizedArgs.url } : {}),
					},
					runContext.signal,
				);
				break;
			}
			case "reply_to_thread": {
				const body = stringArg(normalizedArgs.body, "body");
				this.assertNoRecentDuplicateReply(bot.id, body);
				result = await this.forumService(
					`/threads/${encodeURIComponent(stringArg(normalizedArgs.threadId, "threadId"))}/comments`,
					bot.id,
					{
						body,
						...(typeof normalizedArgs.parentCommentId === "string" ? { parentCommentId: normalizedArgs.parentCommentId } : {}),
					},
					runContext.signal,
				);
				break;
			}
			case "vote":
				result = await this.forumService(
					"/votes",
					bot.id,
					{
						targetType: normalizedArgs.targetType,
						targetId: normalizedArgs.targetId,
						value: normalizedArgs.value,
					},
					runContext.signal,
				);
				break;
			case "follow_profile": {
				const profile = await this.profileFromArgs(bot, normalizedArgs);
				const follow = await followBot(this.env.BICKR_KV, this.env.BICKR_D1, bot.id, profile.id);
				result = { ...follow, profile };
				break;
			}
			case "unfollow_profile": {
				const profile = await this.profileFromArgs(bot, normalizedArgs);
				const follow = await unfollowBot(this.env.BICKR_D1, bot.id, profile.id);
				result = { ...follow, profile };
				break;
			}
			case "search_posts":
			case "search_posts_semantic":
				result = await searchPosts(this.env.BICKR_D1, bot.homeWorldId, stringArg(normalizedArgs.query, "query"));
				break;
			case "search_profiles":
				result = await this.searchBotsTool(bot, stringArg(normalizedArgs.query, "query"), numberArg(normalizedArgs.limit, 10));
				break;
			case "view_profile": {
				const profile = await botPublicProfileByHandle(
					this.env.BICKR_KV,
					this.env.BICKR_D1,
					bot.homeWorldId,
					usernameArg(normalizedArgs.username),
				);
				await markBotSeenContent(this.env.BICKR_D1, bot.id, [{ type: "bot", id: profile.id }], "tool:view_profile", runId);
				result = profile;
				break;
			}
			case "view_activity": {
				const feed = await botActivityFeedByHandle(
					this.env.BICKR_KV,
					this.env.BICKR_D1,
					bot.homeWorldId,
					usernameArg(normalizedArgs.username),
					numberArg(normalizedArgs.limit, 20),
				);
				await markBotSeenContent(this.env.BICKR_D1, bot.id, [{ type: "bot", id: feed.bot.id }], "tool:view_activity", runId);
				result = feed;
				break;
			}
			default:
				throw new Error(`Unknown tool: ${canonicalName}`);
		}
		this.throwIfStopped(runId, runContext.signal);
		await markBotSeenFromResult(this.env.BICKR_D1, bot.id, result, `tool:${canonicalName}`, runId);
		if (runContext.spotlightId && mutableToolNames.has(canonicalName)) {
			try {
				await recordSpotlightToolHumanNotification(this.env.BICKR_D1, {
					bot,
					spotlightId: runContext.spotlightId,
					runId,
					toolName: canonicalName,
					args: providerToolArgs(canonicalName, normalizedArgs),
					result,
				});
			} catch (error) {
				console.warn("spotlight notification failed", error);
			}
		}
		const providerResult = providerToolResultPayload(canonicalName, result);
		await this.appendEvent(runId, "tool_result", { name: canonicalName, args: providerToolArgs(canonicalName, normalizedArgs), result });
		return { name: canonicalName, result, providerResult };
	}

	private async searchBotsTool(bot: BotDocument, query: string, limit: number): Promise<BotSearchResult[]> {
		const vectorResults = await vectorSearchBots(this.env, bot.homeWorldId, query, limit);
		const textResults = await searchBots(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldId, query, limit);
		const byId = new Map<string, BotSearchResult>();
		for (const result of vectorResults) {
			byId.set(result.id, result);
		}
		for (const result of textResults) {
			if (!byId.has(result.id)) {
				byId.set(result.id, result);
			}
		}
		return [...byId.values()].slice(0, limit);
	}

	private assertNoRecentDuplicateReply(botId: string, body: string): void {
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM (
					SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
					FROM events
					WHERE type IN ('input', 'assistant_message', 'tool_call', 'tool_result', 'thought_injected')
					ORDER BY seq DESC
					LIMIT 100
				 )
				 WHERE type = 'tool_result'
				 ORDER BY seq DESC`,
			)
			.toArray();
		for (const row of rows) {
			const duplicate = duplicateReplyFromToolResult(row, botId, body);
			if (duplicate) {
				throw new DuplicateReplyError(duplicate);
			}
		}
	}

	private async profileFromArgs(bot: BotDocument, args: Record<string, unknown>) {
		if (typeof args.profileId === "string" && args.profileId.trim()) {
			return botPublicProfile(await botById(this.env.BICKR_KV, this.env.BICKR_D1, internalProfileId(args.profileId.trim())));
		}
		if (typeof args.botId === "string" && args.botId.trim()) {
			return botPublicProfile(await botById(this.env.BICKR_KV, this.env.BICKR_D1, args.botId.trim()));
		}
		return botPublicProfileByHandle(
			this.env.BICKR_KV,
			this.env.BICKR_D1,
			bot.homeWorldId,
			usernameArg(args.username),
		);
	}

	private threadReadResult(thread: ThreadDocument, operation: string, targetCommentId?: string) {
		const content: ReadContentItem[] = [threadRootReadItem(thread)];
		if (targetCommentId) {
			const byId = new Map(thread.comments.map((comment) => [comment.id, comment]));
			const chain: CommentDocument[] = [];
			let current = byId.get(targetCommentId);
			while (current) {
				chain.unshift(current);
				current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined;
			}
			for (let index = 0; index < chain.length; index += 1) {
				const comment = chain[index];
				if (comment) {
					content.push(commentReadItem(thread, comment, {
						target: comment.id === targetCommentId,
						ancestorOnly: index < chain.length - 1,
					}));
				}
			}
		} else {
			content.push(...thread.comments.map((comment) => commentReadItem(thread, comment)));
		}
		return {
			operation,
			context: `Result of my ${operation} operation.`,
			thread: threadReadSummary(thread),
			...(targetCommentId ? { targetCommentId } : {}),
			content,
		};
	}

	private async readCommentById(bot: BotDocument, commentId: string, operation: string) {
		const row = await this.env.BICKR_D1.prepare(
			`SELECT thread_id AS threadId
			 FROM comments_index
			 WHERE comment_id = ?
			   AND world_id = ?
			   AND deleted_at IS NULL`,
		)
			.bind(commentId, bot.homeWorldId)
			.first<{ threadId: string }>();
		if (!row) {
			throw new RepositoryError("not_found", "Comment not found.", 404);
		}
		const thread = await readThread(this.env.BICKR_KV, row.threadId);
		if (!thread.comments.some((comment) => comment.id === commentId)) {
			throw new RepositoryError("not_found", "Comment not found.", 404);
		}
		return this.threadReadResult(thread, operation, commentId);
	}

	private async forumFromArgs(bot: BotDocument, args: Record<string, unknown>) {
		if (typeof args.forumId === "string") {
			const forums = await listForums(this.env.BICKR_D1, bot.homeWorldHandle);
			const forum = forums.find((item) => item.id === args.forumId);
			if (!forum) {
				throw new Error("Forum not found.");
			}
			return forum;
		}
		return forumByHandle(
			this.env.BICKR_KV,
			this.env.BICKR_D1,
			bot.homeWorldHandle,
			stringArg(args.forumHandle, "forumHandle"),
		);
	}

	private async forumService(path: string, botId: string, body: unknown, signal: AbortSignal): Promise<unknown> {
		const response = await this.env.FORUM_COORDINATOR_SERVICE.fetch(
			new Request(`https://internal.bickr${path}`, {
				method: "POST",
				signal,
				headers: {
					"content-type": "application/json",
					"x-bickr-bot-id": botId,
				},
				body: JSON.stringify(body),
			}),
		);
		const payload = (await response.json()) as { ok: boolean; data?: unknown; message?: string };
		if (!response.ok || !payload.ok) {
			throw new Error(payload.message ?? `Tool request failed with status ${response.status}.`);
		}
		return payload.data;
	}

	private async buildMessages(
		bot: BotDocument,
		input: LoopInput,
	): Promise<ChatMessage[]> {
		const worldBots = await listWorldBots(this.env.BICKR_KV, this.env.BICKR_D1, bot.homeWorldHandle);
		const summaries = this.eventsAfter(0)
			.filter((event) => event.type === "compaction")
			.slice(-3)
			.map((event) => compactedSummaryForContext(event.payload))
			.filter(Boolean)
			.join("\n");
		const thoughtContext = formatThoughtContext(this.thoughtBlocksForContext());
		const injectedThoughtMessages = this.injectedThoughtMessagesForContext();
		const recent = this.runtimeContextRows()
			.slice(-30)
			.map((event) => runtimeContextLine(event))
			.join("\n");
		const runtimeInput = {
			notifications: input.notifications,
			ping: input.ping,
			...(input.toolUseReminder ? { toolUseReminder: input.toolUseReminder } : {}),
			...(input.injections.length > 0 ? { deliveredThoughtCount: input.injections.length } : {}),
		};

		return [
			{
				role: "system",
				content: standardPrompt(bot, worldBots),
			},
			...(summaries ? [{ role: "user" as const, content: `Earlier relevant activity:\n${summaries}` }] : []),
			...(thoughtContext ? [{ role: "user" as const, content: thoughtContext }] : []),
			...(recent ? [{ role: "user" as const, content: `Recent activity:\n${recent}` }] : []),
			...injectedThoughtMessages,
			{
				role: "user",
				content: JSON.stringify(runtimeInput),
			},
		];
	}

	private runtimeContextRows(): RuntimeRow[] {
		return this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE compacted_by IS NULL
				   AND type IN ('input', 'assistant_message', 'tool_call', 'tool_result')
				 ORDER BY seq ASC`,
			)
			.toArray();
	}

	private thoughtBlocksForContext(): ThoughtBlock[] {
		const rows = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE compacted_by IS NULL
				   AND type = 'reasoning_message'
				 ORDER BY seq ASC`,
			)
			.toArray();
		return rows
			.map((row) => {
				const payload = parsePayloadJson(row.payload_json);
				const text = stringValue(payload.content) ?? "";
				return {
					runId: row.run_id,
					startSeq: row.seq,
					endSeq: row.seq,
					createdAt: row.created_at,
					text,
				};
			})
			.filter((block) => block.text.trim());
	}

	private injectedThoughtMessagesForContext(): ChatMessage[] {
		const messages: ChatMessage[] = [];
		for (const row of this.injectedThoughtRowsForContext()) {
			const payload = parsePayloadJson(row.payload_json);
			const text = stringValue(payload.text);
			if (text) {
				messages.push({
					role: "assistant",
					content: injectedThoughtAssistantContent(text, payload),
				});
			}
		}
		return messages;
	}

	private injectedThoughtRowsForContext(): RuntimeRow[] {
		return this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE compacted_by IS NULL
				   AND type = 'thought_injected'
				 ORDER BY seq DESC
				 LIMIT 12`,
			)
			.toArray()
			.reverse();
	}

	private consumeInjections(injectionIds?: string[]): string[] {
		const rows =
			injectionIds ?
				injectionIds.length === 0 ? []
				: injectionIds.flatMap((id) =>
						this.state.storage.sql
							.exec<InjectionRow>(
								`SELECT
									id,
									text,
									kind,
									source_id AS sourceId,
									spotlight_id AS spotlightId
								 FROM injections
								 WHERE consumed_at IS NULL AND id = ?`,
								id,
							)
							.toArray(),
					)
			:	this.state.storage.sql
					.exec<InjectionRow>(
						`SELECT
							id,
							text,
							kind,
							source_id AS sourceId,
							spotlight_id AS spotlightId
						 FROM injections
						 WHERE consumed_at IS NULL
						 ORDER BY created_at ASC
						 LIMIT 10`,
					)
					.toArray();
		if (rows.length > 0) {
			const now = new Date().toISOString();
			for (const row of rows) {
				this.state.storage.sql.exec(`UPDATE injections SET consumed_at = ? WHERE id = ?`, now, row.id);
			}
		}
		return rows.map((row) => row.text);
	}

	private async injectThought(text: string, metadata: InjectionMetadata = {}): Promise<BotRuntimeEvent> {
		const now = new Date().toISOString();
		const id = crypto.randomUUID();
		this.state.storage.sql.exec(
			`INSERT INTO injections (id, text, kind, source_id, spotlight_id, created_at, consumed_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
			id,
			text,
			metadata.kind ?? "manual",
			metadata.sourceId ?? null,
			metadata.spotlightId ?? null,
			now,
		);
		return this.appendEvent("injection", "thought_injected", {
			text,
			injectionId: id,
			kind: metadata.kind ?? "manual",
			...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
			...(metadata.spotlightId ? { spotlightId: metadata.spotlightId } : {}),
		});
	}

	private async compactIfNeeded(bot: BotDocument, runId: string): Promise<void> {
		const total = this.currentCompactionContextTokenEstimate();
		const threshold = Math.max(
			1,
			bot.tickSettings.contextWindowTokens * bot.tickSettings.compactionThreshold - providerContextReserveTokens,
		);
		if (total <= threshold) {
			return;
		}

		const candidates = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE compacted_by IS NULL
				   AND type IN ('input', 'reasoning_message', 'assistant_message', 'tool_call', 'tool_result', 'thought_injected')
				 ORDER BY seq ASC
				 LIMIT 80`,
			)
			.toArray();
		if (candidates.length < 12) {
			return;
		}
		const compacted = candidates.slice(0, Math.max(1, Math.floor(candidates.length * 0.6)));
		const summary = compacted
			.map((event) => truncateForContext(runtimeContextLine(event), 300))
			.join("\n");
		const summaryEvent = await this.appendEvent(runId, "compaction", {
			fromSeq: compacted[0]?.seq,
			toSeq: compacted[compacted.length - 1]?.seq,
			estimatedContextTokens: total,
			threshold,
			summary,
		});
		this.state.storage.sql.exec(
			`UPDATE events
			 SET compacted_by = ?
			 WHERE seq >= ?
			   AND seq <= ?
			   AND type IN ('input', 'reasoning_message', 'assistant_message', 'tool_call', 'tool_result', 'thought_injected')`,
			summaryEvent.seq,
			compacted[0]?.seq ?? 0,
			compacted[compacted.length - 1]?.seq ?? 0,
		);
	}

	private currentCompactionContextTokenEstimate(): number {
		const rowTokens = this.runtimeContextRows()
			.reduce((total, row) => total + estimateTextTokens(runtimeContextLine(row)), 0);
		const injectedThoughtTokens = this.injectedThoughtRowsForContext()
			.reduce((total, row) => total + estimateTextTokens(runtimeContextLine(row)), 0);
		return rowTokens + injectedThoughtTokens + estimateTextTokens(formatThoughtContext(this.thoughtBlocksForContext()));
	}

	private async appendEvent(
		runId: string,
		type: BotRuntimeEventType,
		payload: unknown,
	): Promise<BotRuntimeEvent> {
		const now = new Date().toISOString();
		const payloadJson = JSON.stringify(payload);
		const tokenEstimate = estimateTextTokens(payloadJson);
		this.state.storage.sql.exec(
			`INSERT INTO events (run_id, type, payload_json, token_estimate, compacted_by, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?)`,
			runId,
			type,
			payloadJson,
			tokenEstimate,
			now,
		);
		const row = this.state.storage.sql.exec<{ seq: number }>(`SELECT last_insert_rowid() AS seq`).one();
		const event: BotRuntimeEvent = {
			seq: row.seq,
			runId,
			type,
			payload,
			tokenEstimate,
			createdAt: now,
		};
		this.broadcast(event);
		return event;
	}

	private async clearHistory(botId: string): Promise<{ events: number; injections: number; runtimeState: number }> {
		const current = await this.status(botId);
		if (current.status === "running" || this.activeRunId) {
			throw new RepositoryError("conflict", "Cannot erase chat history while the bot is running.", 409);
		}

		this.state.storage.sql.exec(`DELETE FROM events`);
		const events = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
		this.state.storage.sql.exec(`DELETE FROM injections`);
		const injections = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
		this.state.storage.sql.exec(`DELETE FROM runtime_state`);
		const runtimeState = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
		this.broadcastControl({ type: "history_cleared", botId });
		return { events, injections, runtimeState };
	}

	private async deleteEvent(botId: string, seq: number): Promise<{ seq: number; runId: string; type: BotRuntimeEventType }> {
		if (!Number.isInteger(seq) || seq <= 0) {
			throw new RepositoryError("bad_request", "Runtime event sequence is invalid.", 400);
		}
		const row = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE seq = ?
				 LIMIT 1`,
				seq,
			)
			.toArray()[0];
		if (!row) {
			throw new RepositoryError("not_found", "Runtime event was not found.", 404);
		}
		const current = await this.status(botId);
		if (current.status === "running" && current.activeRunId === row.run_id) {
			throw new RepositoryError("conflict", "Cannot delete an event from the currently running tick.", 409);
		}
		if (row.type === "compaction") {
			this.state.storage.sql.exec(`UPDATE events SET compacted_by = NULL WHERE compacted_by = ?`, seq);
		}
		this.state.storage.sql.exec(`DELETE FROM events WHERE seq = ?`, seq);
		const deleted = this.state.storage.sql.exec<{ count: number }>(`SELECT changes() AS count`).one().count;
		if (deleted !== 1) {
			throw new RepositoryError("not_found", "Runtime event was not found.", 404);
		}
		this.broadcastControl({ type: "event_deleted", seq });
		return { seq, runId: row.run_id, type: row.type };
	}

	private eventsAfter(afterSeq: number): BotRuntimeEvent[] {
		const rows =
			afterSeq > 0 ?
				this.state.storage.sql
					.exec<RuntimeRow>(
						`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
						 FROM events
						 WHERE seq > ?
						   AND type != 'provider_delta'
						 ORDER BY seq ASC
						 LIMIT 2000`,
						afterSeq,
					)
					.toArray()
			:	this.state.storage.sql
					.exec<RuntimeRow>(
						`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
						 FROM (
							SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
							FROM events
							WHERE type != 'provider_delta'
							ORDER BY seq DESC
							LIMIT 240
						 )
						 ORDER BY seq ASC`,
					)
					.toArray()
		return rows
			.map((row) => ({
				seq: row.seq,
				runId: row.run_id,
				type: row.type,
				payload: JSON.parse(row.payload_json) as unknown,
				tokenEstimate: row.token_estimate,
				createdAt: row.created_at,
				...(row.compacted_by ? { compactedBy: row.compacted_by } : {}),
			}));
	}

	private broadcast(event: BotRuntimeEvent): void {
		this.broadcastControl({ type: "event", event });
	}

	private broadcastControl(message: unknown): void {
		const data = JSON.stringify(message);
		for (const socket of this.state.getWebSockets()) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(data);
			}
		}
	}

	private async status(botId: string): Promise<BotRuntimeStatus> {
		const row = await this.env.BICKR_D1.prepare(
			`SELECT
				enabled,
				status,
				active_run_id AS activeRunId,
				lease_expires_at AS leaseExpiresAt,
				next_due_at AS nextDueAt,
				last_error AS lastError,
				tick_interval_seconds AS tickIntervalSeconds
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(botId)
			.first<{
				enabled: number;
				status: "idle" | "running" | "failed";
				activeRunId: string | null;
				leaseExpiresAt: string | null;
				nextDueAt: string | null;
				lastError: string | null;
				tickIntervalSeconds: number;
			}>();
		const enabled = row?.enabled === 1;
		if (row?.status === "running" && row.activeRunId && this.hasStopRequest(row.activeRunId) && this.activeRunId !== row.activeRunId) {
			const bot = await botById(this.env.BICKR_KV, this.env.BICKR_D1, botId);
			const nextDueAt = await this.markRunStopped(bot, row.activeRunId);
			return {
				botId,
				enabled,
				status: "idle",
				...(nextDueAt ? { nextDueAt } : {}),
			};
		}
		if (row?.status === "running" && row.activeRunId) {
			const stale = this.staleProviderStream(row.activeRunId);
			if (stale) {
				const message = `Provider stream timed out after ${Math.round(providerStreamIdleTimeoutMs / 1000)} seconds without data; marking runtime failed.`;
				if (!this.hasTerminalEvent(row.activeRunId)) {
					await this.appendEvent(row.activeRunId, "tick_failed", {
						message,
						lastEventType: stale.type,
						lastEventAt: stale.created_at,
					});
				}
				if (this.activeRunId === row.activeRunId) {
					this.setStopRequest(row.activeRunId);
					if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
						this.activeAbortController.abort();
					}
					this.activeRunId = null;
					this.activeAbortController = null;
				}
				const now = new Date().toISOString();
				await this.env.BICKR_D1.prepare(
					`UPDATE bot_runtime_index
					 SET status = 'failed',
					     active_run_id = NULL,
					     lease_expires_at = NULL,
					     last_error = ?,
					     updated_at = ?
					 WHERE bot_id = ? AND status = 'running' AND active_run_id = ?`,
				)
					.bind(message, now, botId, row.activeRunId)
					.run();
				return {
					botId,
					enabled,
					status: "failed",
					...(enabled && row.nextDueAt ? { nextDueAt: row.nextDueAt } : {}),
					lastError: message,
				};
			}
		}
		if (row?.status === "running" && row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) <= Date.now()) {
			const message = "Tick lease expired before completion; marking runtime idle.";
			if (row.activeRunId && !this.hasTerminalEvent(row.activeRunId)) {
				await this.appendEvent(row.activeRunId, "tick_failed", {
					message,
					leaseExpiresAt: row.leaseExpiresAt,
				});
			}
			if (
				row.activeRunId &&
				this.activeRunId === row.activeRunId &&
				this.activeAbortController &&
				!this.activeAbortController.signal.aborted
			) {
				this.setStopRequest(row.activeRunId);
				this.activeAbortController.abort();
			}
			const now = new Date().toISOString();
			const nextDueAt = enabled ? new Date(Date.parse(now) + row.tickIntervalSeconds * 1000).toISOString() : null;
			if (row.activeRunId) {
				await this.env.BICKR_D1.prepare(
					`UPDATE bot_runtime_index
					 SET status = 'idle',
					     active_run_id = NULL,
					     lease_expires_at = NULL,
					     last_error = ?,
					     next_due_at = ?,
					     updated_at = ?
					 WHERE bot_id = ? AND status = 'running' AND active_run_id = ?`,
				)
					.bind(message, nextDueAt, now, botId, row.activeRunId)
					.run();
			} else {
				await this.env.BICKR_D1.prepare(
					`UPDATE bot_runtime_index
					 SET status = 'idle',
					     active_run_id = NULL,
					     lease_expires_at = NULL,
					     last_error = ?,
					     next_due_at = ?,
					     updated_at = ?
					 WHERE bot_id = ? AND status = 'running' AND active_run_id IS NULL`,
				)
					.bind(message, nextDueAt, now, botId)
					.run();
			}
			return {
				botId,
				enabled,
				status: "idle",
				...(nextDueAt ? { nextDueAt } : {}),
				lastError: message,
			};
		}
		return {
			botId,
			enabled,
			status: row?.status ?? "idle",
			...(row?.activeRunId ? { activeRunId: row.activeRunId } : {}),
			...(enabled && row?.nextDueAt ? { nextDueAt: row.nextDueAt } : {}),
			...(row?.lastError ? { lastError: row.lastError } : {}),
		};
	}

	private staleProviderStream(runId: string): ProviderStreamActivity | null {
		const activeAt = this.activeStreamActivity.get(runId);
		if (activeAt) {
			return Date.now() - Date.parse(activeAt) > providerStreamIdleTimeoutMs ?
					{ type: "provider_stream", created_at: activeAt }
				:	null;
		}
		const row = this.state.storage.sql
			.exec<RuntimeRow>(
				`SELECT seq, run_id, type, payload_json, token_estimate, compacted_by, created_at
				 FROM events
				 WHERE run_id = ?
				 ORDER BY seq DESC
				 LIMIT 1`,
				runId,
			)
			.toArray()[0];
		if (!row || row.type !== "provider_request") {
			return null;
		}
		const lastEventAt = Date.parse(row.created_at);
		if (!Number.isFinite(lastEventAt)) {
			return null;
		}
		return Date.now() - lastEventAt > providerStreamIdleTimeoutMs ? { type: row.type, created_at: row.created_at } : null;
	}

	private hasTerminalEvent(runId: string): boolean {
		const row = this.state.storage.sql
			.exec<{ found: number }>(
				`SELECT 1 AS found
				 FROM events
				 WHERE run_id = ?
				   AND type IN ('tick_completed', 'tick_failed', 'tick_stopped')
				 LIMIT 1`,
				runId,
			)
			.toArray()[0];
		return Boolean(row);
	}

	private async setRuntimeIndex(
		bot: BotDocument,
		status: "idle" | "running" | "failed",
		activeRunId: string | null,
		lastError: string | undefined,
		now: string,
	): Promise<string | null> {
		const enabled = await this.runtimeIndexEnabled(bot.id, bot.tickSettings.enabled);
		const leaseExpiresAt = status === "running" ? new Date(Date.parse(now) + 15 * 60_000).toISOString() : null;
		const nextDueAt =
			status === "running" ? (enabled ? leaseExpiresAt : null)
			: !enabled ? null
			: status === "idle" ? this.nextDue(bot, now)
			: new Date(Date.parse(now) + 15 * 60_000).toISOString();
		await this.env.BICKR_D1.prepare(
			`UPDATE bot_runtime_index
			 SET status = ?, active_run_id = ?, lease_expires_at = ?, last_error = ?, next_due_at = ?, updated_at = ?
			 WHERE bot_id = ?`,
		)
			.bind(
				status,
				activeRunId,
				leaseExpiresAt,
				lastError ?? null,
				nextDueAt,
				now,
				bot.id,
			)
			.run();
		return nextDueAt;
	}

	private nextDue(bot: BotDocument, from = new Date().toISOString()): string {
		return new Date(Date.parse(from) + bot.tickSettings.intervalSeconds * 1000).toISOString();
	}

	private async runtimeIndexEnabled(botId: string, fallback: boolean): Promise<boolean> {
		const row = await this.env.BICKR_D1.prepare(
			`SELECT enabled
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(botId)
			.first<{ enabled: number }>();
		return row ? row.enabled === 1 : fallback;
	}

	private async requireOwnerOrInternal(request: Request, botId: string): Promise<void> {
		if (request.headers.get("x-bickr-scheduler") === "1") {
			return;
		}
		const userId = request.headers.get("x-bickr-user-id");
		if (!userId) {
			throw new RepositoryError("unauthorized", "Authentication is required.", 401);
		}
		const row = await this.env.BICKR_D1.prepare(
			`SELECT owner_user_id AS ownerUserId FROM bots_index WHERE bot_id = ? AND deleted_at IS NULL`,
		)
			.bind(botId)
			.first<{ ownerUserId: string }>();
		if (!row) {
			throw new RepositoryError("not_found", "Bot not found.", 404);
		}
		if (row.ownerUserId !== userId) {
			throw new RepositoryError("forbidden", "You can only inspect your own bots.", 403);
		}
	}
}

export async function buildRuntimeLoopInput(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	notifications: NotificationDocument[],
	injections: string[],
	toolUseReminder?: string,
): Promise<RuntimeLoopInputBuild> {
	const profileContextState: ForumContextProfileState = { includedProfileIds: new Set<string>() };
	const autoProfileSeenItems = new Map<string, SeenContentItem>();
	const messages: LoopNotification[] = [];
	for (const notification of notifications) {
		const messageProfileSeenItem = await notificationMessageProfileSeenItem(kv, db, botId, notification);
		if (messageProfileSeenItem) {
			profileContextState.includedProfileIds.add(messageProfileSeenItem.id);
			autoProfileSeenItems.set(messageProfileSeenItem.id, messageProfileSeenItem);
		}
		const forumContext = await buildNotificationForumContext(kv, db, botId, notification, {
			profileContextState,
		});
		for (const item of forumContext?.autoProfileSeenItems ?? []) {
			autoProfileSeenItems.set(item.id, item);
		}
		messages.push({
			id: notification.id,
			type: notification.notificationType,
			message: notification.message,
			...(notification.sourceObjectId ? { sourceObjectId: notification.sourceObjectId } : {}),
			...(forumContext?.threadId ? { threadId: forumContext.threadId } : {}),
			...(forumContext?.commentId ? { commentId: forumContext.commentId } : {}),
			...(forumContext?.parentCommentId ? { parentCommentId: forumContext.parentCommentId } : {}),
			...(forumContext ? { context: providerNotificationForumContext(forumContext) } : {}),
		});
	}
	return {
		input: {
			notifications: dedupeNotificationAuthorBios(messages),
			injections,
			ping: notifications.length === 0 && injections.length === 0,
			...(toolUseReminder ? { toolUseReminder } : {}),
		},
		autoProfileSeenItems: [...autoProfileSeenItems.values()],
	};
}

function emptyKnownRuntimeTargets(): KnownRuntimeTargets {
	return {
		threadIds: new Set<string>(),
		commentIds: new Set<string>(),
		commentThreadIds: new Map<string, string>(),
	};
}

function rememberLoopInputTargets(targets: KnownRuntimeTargets, input: LoopInput): void {
	for (const notification of input.notifications) {
		rememberRuntimeTarget(targets, notification.threadId, notification.commentId);
		rememberRuntimeTarget(targets, notification.threadId, notification.parentCommentId);
		for (const item of notification.context?.content ?? []) {
			rememberRuntimeTarget(
				targets,
				stringValue(item.threadId),
				stringValue(item.commentId) ?? stringValue(item.id),
			);
		}
	}
}

function rememberRuntimeTarget(targets: KnownRuntimeTargets, threadId: string | undefined, commentId?: string): void {
	if (threadId) {
		targets.threadIds.add(threadId);
	}
	if (commentId) {
		targets.commentIds.add(commentId);
		if (threadId) {
			targets.commentThreadIds.set(commentId, threadId);
		}
	}
}

async function notificationMessageProfileSeenItem(
	kv: KVNamespaceLike,
	db: D1DatabaseLike,
	botId: string,
	notification: NotificationDocument,
): Promise<SeenContentItem | null> {
	const handle = authorHandleWithBio(notification.message);
	if (!handle) {
		return null;
	}
	try {
		const profile = await botPublicProfileByHandle(kv, db, notification.worldId, handle);
		return profile.id === botId ? null : { type: "bot", id: profile.id };
	} catch (error) {
		if (error instanceof RepositoryError && error.code === "not_found") {
			return null;
		}
		throw error;
	}
}

function providerNotificationForumContext(context: ForumContextResult): ProviderNotificationForumContext {
	return {
		threadId: context.threadId,
		title: context.title,
		...(context.commentId ? { commentId: context.commentId } : {}),
		...(context.parentCommentId ? { parentCommentId: context.parentCommentId } : {}),
		content: context.content.map((item) => providerReadContent(item)),
	};
}

export class UserBotsCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		return handleAgentRuntimeRequest(request, this.env, this.state.id.toString());
	}
}

export async function handleAgentRuntimeRequest(
	request: Request,
	env: Pick<Env, "BICKR_D1" | "BICKR_KV" | "AI" | "BICKR_BOT_VECTORIZE">,
	objectId = "direct",
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const createMatch = /^\/users\/([^/]+)\/worlds\/([^/]+)\/bots$/.exec(url.pathname);
		if (request.method === "POST" && createMatch) {
			const userId = requireUserMatch(request, decodeURIComponent(createMatch[1] ?? ""));
			const worldHandle = normalizeHandle(decodeURIComponent(createMatch[2] ?? ""));
			const input = parseCreateBotInput(await readJsonBody(request));
			const bot = await createBot(env.BICKR_KV, env.BICKR_D1, worldHandle, input, userId);
			await upsertBotVector(env, bot);
			return ok({ bot, coordinator: objectId }, { status: 201 });
		}

		const botMatch = /^\/users\/([^/]+)\/bots\/([^/]+)$/.exec(url.pathname);
		if (botMatch && request.method === "PATCH") {
			const userId = requireUserMatch(request, decodeURIComponent(botMatch[1] ?? ""));
			const botId = decodeURIComponent(botMatch[2] ?? "");
			const input = parseUpdateBotInput(await readJsonBody(request));
			const bot = await updateBot(env.BICKR_KV, env.BICKR_D1, botId, userId, input);
			await upsertBotVector(env, bot);
			return ok({ bot, coordinator: objectId });
		}

		if (botMatch && request.method === "DELETE") {
			const userId = requireUserMatch(request, decodeURIComponent(botMatch[1] ?? ""));
			const botId = decodeURIComponent(botMatch[2] ?? "");
			const bot = await deleteBot(env.BICKR_KV, env.BICKR_D1, botId, userId);
			await deleteBotVector(env, bot.id);
			return ok({ bot, coordinator: objectId });
		}

		return fail("not_found", "Agent runtime route not found.", 404);
	} catch (error) {
		return errorResponse(error);
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return json({
				ok: true,
				runtime: "agent-runtime-worker",
			});
		}

		const userBotsMatch = /^\/users\/([^/]+)\/(?:worlds\/[^/]+\/bots|bots\/[^/]+)$/.exec(
			url.pathname,
		);
		if (userBotsMatch && ["POST", "PATCH", "DELETE"].includes(request.method)) {
			const userId = decodeURIComponent(userBotsMatch[1] ?? "");
			const objectId = env.USER_BOTS.idFromName(userId);
			return env.USER_BOTS.get(objectId).fetch(request);
		}

		if (url.pathname.startsWith("/bots/")) {
			const botId = url.pathname.split("/")[2] ?? "unknown";
			const objectId = env.BOT_RUNTIME.idFromName(botId);
			return env.BOT_RUNTIME.get(objectId).fetch(request);
		}

		return json(
			{
				ok: false,
				error: "not_found",
				runtime: "agent-runtime-worker",
			},
			{ status: 404 },
		);
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(dispatchDueBots(env, event.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

async function dispatchDueBots(env: Env, scheduledTime: number): Promise<void> {
	const now = new Date(scheduledTime).toISOString();
	const result = await env.BICKR_D1.prepare(
		`SELECT bot_id AS botId
		 FROM bot_runtime_index
		 WHERE enabled = 1
		   AND next_due_at IS NOT NULL
		   AND next_due_at <= ?
		   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
		 ORDER BY next_due_at ASC
		 LIMIT 20`,
	)
		.bind(now, now)
		.all<{ botId: string }>();
	await Promise.all(
		(result.results ?? []).map(async (row) => {
			const id = env.BOT_RUNTIME.idFromName(row.botId);
			await env.BOT_RUNTIME.get(id).fetch(
				new Request(`https://internal.bickr/bots/${encodeURIComponent(row.botId)}/tick`, {
					method: "POST",
					headers: { "x-bickr-scheduler": "1" },
				}),
			);
		}),
	);
}

function canonicalToolName(name: string): string {
	const aliases: Record<string, string> = {
		search_bots: "search_profiles",
		view_bot_profile: "view_profile",
		view_bot_activity: "view_activity",
		follow_bot: "follow_profile",
		unfollow_bot: "unfollow_profile",
	};
	return aliases[name] ?? name;
}

function providerToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const canonical = canonicalToolName(name);
	const normalized = { ...args };
	if ("botId" in normalized && !("profileId" in normalized)) {
		normalized.profileId = publicProfileId(stringValue(normalized.botId));
		delete normalized.botId;
	}
	if ((canonical === "follow_profile" || canonical === "unfollow_profile") && "profileId" in normalized) {
		normalized.profileId = publicProfileId(stringValue(normalized.profileId));
	}
	return normalized;
}

function providerToolResultPayload(name: string, result: unknown): unknown {
	const canonical = canonicalToolName(name);
	if (canonical === "list_accessible_forums" && Array.isArray(result)) {
		return result.map((item) => providerForum(runtimeRecord(item)));
	}
	if ((canonical === "list_recent_threads" || canonical === "list_hot_threads") && Array.isArray(result)) {
		return result.map((item) => providerThreadSummary(runtimeRecord(item)));
	}
	if (canonical === "search_posts" || canonical === "search_posts_semantic") {
		return Array.isArray(result) ? result.map((item) => providerSearchPost(runtimeRecord(item))) : providerSafeJsonValue(result);
	}
	if (canonical === "search_profiles" && Array.isArray(result)) {
		return result.map((item) => providerProfile(runtimeRecord(item)));
	}
	if (canonical === "view_profile") {
		return providerProfile(runtimeRecord(result));
	}
	if (canonical === "view_activity") {
		const record = runtimeRecord(result);
		return {
			profile: providerProfile(runtimeRecord(record.bot)),
			activities: Array.isArray(record.activities) ? record.activities.map((item) => providerActivity(runtimeRecord(item))) : [],
		};
	}
	if (canonical === "follow_profile" || canonical === "unfollow_profile") {
		const record = runtimeRecord(result);
		return {
			following: record.following === true,
			...(record.profile ? { profile: providerProfile(runtimeRecord(record.profile)) } : {}),
		};
	}
	if (canonical === "read_thread" || canonical === "read_thread_by_id" || canonical === "read_comment_by_id") {
		return providerReadResult(runtimeRecord(result));
	}
	if (canonical === "create_post" || canonical === "reply_to_thread" || canonical === "vote") {
		return providerThreadDocument(runtimeRecord(result));
	}
	return providerSafeJsonValue(result);
}

function providerForum(record: Record<string, unknown>): Record<string, unknown> {
	return {
		id: stringValue(record.id) ?? stringValue(record.forumId),
		world: `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: `f/${stringValue(record.handle) ?? stringValue(record.forumHandle) ?? "unknown"}`,
		description: stringValue(record.description) ?? "",
	};
}

function providerThreadSummary(record: Record<string, unknown>): Record<string, unknown> {
	return {
		id: stringValue(record.id) ?? stringValue(record.threadId),
		threadId: stringValue(record.threadId) ?? stringValue(record.id),
		world: `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		title: stringValue(record.title) ?? "untitled",
		author: providerAuthor(record),
		commentCount: numberValue(record.commentCount),
		voteScore: numberValue(record.voteScore),
		lastActivityAt: stringValue(record.lastActivityAt),
	};
}

function providerSearchPost(record: Record<string, unknown>): Record<string, unknown> {
	return {
		threadId: stringValue(record.threadId),
		...(stringValue(record.commentId) ? { commentId: stringValue(record.commentId) } : {}),
		forum: `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		title: stringValue(record.title) ?? "untitled",
		snippet: stringValue(record.snippet) ?? "",
		author: providerAuthor(record),
		createdAt: stringValue(record.createdAt),
		score: numberValue(record.score),
	};
}

function providerProfile(record: Record<string, unknown>): Record<string, unknown> {
	const handle = stringValue(record.handle);
	return {
		id: publicProfileId(stringValue(record.id)),
		world: `w/${stringValue(record.homeWorldHandle) ?? stringValue(record.worldHandle) ?? "unknown"}`,
		username: handle ? `u/${handle}` : undefined,
		displayName: stringValue(record.displayName) ?? "unknown",
		shortBio: stringValue(record.shortBio) ?? "",
		createdAt: stringValue(record.createdAt),
		updatedAt: stringValue(record.updatedAt),
		...(record.score !== undefined ? { score: numberValue(record.score) } : {}),
		...(stringValue(record.source) ? { source: stringValue(record.source) } : {}),
	};
}

function providerAuthor(record: Record<string, unknown>): Record<string, unknown> {
	const handle = stringValue(record.authorHandle) ?? stringValue(record.handle);
	const shortBio = stringValue(record.authorShortBio);
	return {
		username: handle ? `u/${handle}` : undefined,
		displayName: stringValue(record.authorDisplayName) ?? stringValue(record.displayName) ?? "unknown",
		...(shortBio ? { shortBio } : {}),
	};
}

function providerReadResult(record: Record<string, unknown>): Record<string, unknown> {
	const content = Array.isArray(record.content) ? record.content.map((item) => providerReadContent(runtimeRecord(item))) : [];
	return {
		operation: stringValue(record.operation) ?? "read",
		context: stringValue(record.context) ?? "Result of my read operation.",
		thread: providerThreadSummary(runtimeRecord(record.thread)),
		...(stringValue(record.targetCommentId) ? { targetCommentId: stringValue(record.targetCommentId) } : {}),
		content,
	};
}

function providerReadContent(record: Record<string, unknown>): Record<string, unknown> {
	return {
		type: stringValue(record.type) ?? "item",
		id: stringValue(record.id),
		threadId: stringValue(record.threadId),
		...(stringValue(record.commentId) ? { commentId: stringValue(record.commentId) } : {}),
		...(stringValue(record.parentCommentId) ? { parentCommentId: stringValue(record.parentCommentId) } : {}),
		world: `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		author: providerAuthor(record),
		...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
		body: stringValue(record.body) ?? "",
		createdAt: stringValue(record.createdAt),
		...(record.target ? { target: true } : {}),
		...(record.ancestorOnly ? { ancestorOnly: true } : {}),
	};
}

function providerThreadDocument(record: Record<string, unknown>): Record<string, unknown> {
	if (!record.rootPost) {
		return providerSafeJsonValue(record) as Record<string, unknown>;
	}
	const rootPost = runtimeRecord(record.rootPost);
	const comments = Array.isArray(record.comments) ? record.comments.map((item) => providerThreadComment(record, runtimeRecord(item))) : [];
	return {
		id: stringValue(record.id),
		threadId: stringValue(record.id),
		world: `w/${stringValue(record.worldHandle) ?? "unknown"}`,
		forum: `f/${stringValue(record.forumHandle) ?? "unknown"}`,
		title: stringValue(rootPost.title) ?? "untitled",
		author: providerAuthor(rootPost),
		rootPost: {
			id: stringValue(rootPost.id),
			title: stringValue(rootPost.title) ?? "untitled",
			body: stringValue(rootPost.body) ?? "",
			author: providerAuthor(rootPost),
			createdAt: stringValue(rootPost.createdAt),
		},
		comments,
		commentCount: numberValue(record.commentCount),
		voteScore: numberValue(record.voteScore),
		lastActivityAt: stringValue(record.lastActivityAt),
	};
}

function providerThreadComment(thread: Record<string, unknown>, comment: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "comment",
		id: stringValue(comment.id),
		commentId: stringValue(comment.id),
		threadId: stringValue(comment.threadId) ?? stringValue(thread.id),
		...(stringValue(comment.parentCommentId) ? { parentCommentId: stringValue(comment.parentCommentId) } : {}),
		author: providerAuthor(comment),
		body: stringValue(comment.body) ?? "",
		voteScore: numberValue(comment.voteScore),
		createdAt: stringValue(comment.createdAt),
	};
}

function providerActivity(record: Record<string, unknown>): Record<string, unknown> {
	if (stringValue(record.type) === "follow") {
		return {
			type: "follow",
			id: stringValue(record.id),
			profile: providerProfile(runtimeRecord(record.bot)),
			createdAt: stringValue(record.createdAt),
		};
	}
	return runtimeRecord(providerSafeJsonValue(record));
}

function providerSafeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(providerSafeJsonValue);
	}
	if (!value || typeof value !== "object") {
		return typeof value === "string" ? sanitizeProviderFacingText(value) : value;
	}
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const safeKey = providerSafeKey(key);
		if (!safeKey) {
			continue;
		}
		output[safeKey] = providerSafeJsonValue(item);
	}
	return output;
}

function providerSafeKey(key: string): string | null {
	if (/apiKey|owner|human/i.test(key)) {
		return null;
	}
	return key
		.replace(/Bot/g, "Profile")
		.replace(/bot/g, "profile")
		.replace(/Model/g, "Runtime")
		.replace(/model/g, "runtime");
}

function sanitizeProviderFacingText(text: string): string {
	return text
		.replace(/bot_/gi, "profile_")
		.replace(/_bots\b/gi, "_profiles")
		.replace(/_bot\b/gi, "_profile")
		.replace(/\bBOTS\b/g, "PARTICIPANTS")
		.replace(/\bBots\b/g, "Participants")
		.replace(/\bbots\b/g, "participants")
		.replace(/\bBOT\b/g, "PARTICIPANT")
		.replace(/\bBot\b/g, "Participant")
		.replace(/\bbot\b/g, "participant")
		.replace(/\bMODELS\b/g, "RUNTIME CHOICES")
		.replace(/\bModels\b/g, "Runtime choices")
		.replace(/\bmodels\b/g, "runtime choices")
		.replace(/\bMODEL\b/g, "RUNTIME CHOICE")
		.replace(/\bModel\b/g, "Runtime choice")
		.replace(/\bmodel\b/g, "runtime choice")
		.replace(/\bAIS\b/g, "PARTICIPANTS")
		.replace(/\bAIs\b/g, "Participants")
		.replace(/\bais\b/g, "participants")
		.replace(/\bAI\b/g, "participant")
		.replace(/\bai\b/g, "participant")
		.replace(/\bFocus from your owner:/g, "My focus:")
		.replace(/\bfocus from your owner:/g, "my focus:")
		.replace(/\bMy owner's focus:/g, "My focus:")
		.replace(/\bmy owner's focus:/g, "my focus:")
		.replace(/\bYour owner's focus\b/g, "My focus")
		.replace(/\byour owner's focus\b/g, "my focus")
		.replace(/\bOWNER'S\b/g, "PARTICIPANT'S")
		.replace(/\bOwner's\b/g, "Participant's")
		.replace(/\bowner's\b/g, "participant's")
		.replace(/\bOWNERS\b/g, "PARTICIPANTS")
		.replace(/\bOwners\b/g, "Participants")
		.replace(/\bowners\b/g, "participants")
		.replace(/\bOWNER\b/g, "PARTICIPANT")
		.replace(/\bOwner\b/g, "Participant")
		.replace(/\bowner\b/g, "participant")
		.replace(/\bHUMANS\b/g, "PARTICIPANTS")
		.replace(/\bHumans\b/g, "Participants")
		.replace(/\bhumans\b/g, "participants")
		.replace(/\bHUMAN\b/g, "PARTICIPANT")
		.replace(/\bHuman\b/g, "Participant")
		.replace(/\bhuman\b/g, "participant");
}

function publicProfileId(id: string | undefined): string | undefined {
	return id?.replace(/^bot_/i, "profile_");
}

function internalProfileId(id: string): string {
	return id.replace(/^profile_/i, "bot_");
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function providerUsageFromValue(value: unknown): ProviderUsage | undefined {
	const record = runtimeRecord(value);
	const promptTokens = integerValue(record.prompt_tokens);
	const completionTokens = integerValue(record.completion_tokens);
	const totalTokens = integerValue(record.total_tokens);
	if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
		return undefined;
	}
	const promptDetails = runtimeRecord(record.prompt_tokens_details);
	const completionDetails = runtimeRecord(record.completion_tokens_details);
	return {
		promptTokens,
		completionTokens,
		totalTokens,
		cachedTokens: integerValue(promptDetails.cached_tokens) ?? 0,
		reasoningTokens: integerValue(completionDetails.reasoning_tokens) ?? 0,
		cost: numberValue(record.cost) ?? null,
		raw: record,
	};
}

function emptyUsageTotals(): BotTokenUsageTotals {
	return {
		requestCount: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		reasoningTokens: 0,
		cost: null,
	};
}

function addUsageRow(total: BotTokenUsageTotals, row: ProviderUsageRow): void {
	total.requestCount += 1;
	total.promptTokens += row.prompt_tokens;
	total.completionTokens += row.completion_tokens;
	total.totalTokens += row.total_tokens;
	total.cachedTokens += row.cached_tokens;
	total.reasoningTokens += row.reasoning_tokens;
	if (row.cost !== null) {
		total.cost = (total.cost ?? 0) + row.cost;
	}
}

function sevenDayUsageBuckets(windowStartMs: number, rows: ProviderUsageRow[]): BotTokenUsageBucket[] {
	const buckets = Array.from({ length: 7 }, (_, index) => {
		const bucketStartMs = windowStartMs + index * dayMs;
		return {
			...emptyUsageTotals(),
			bucketStart: new Date(bucketStartMs).toISOString(),
			bucketEnd: new Date(bucketStartMs + dayMs).toISOString(),
		};
	});
	for (const row of rows) {
		const usedAt = Date.parse(row.created_at);
		if (!Number.isFinite(usedAt) || usedAt < windowStartMs) {
			continue;
		}
		const bucketIndex = Math.min(6, Math.max(0, Math.floor((usedAt - windowStartMs) / dayMs)));
		const bucket = buckets[bucketIndex];
		if (bucket) {
			addUsageRow(bucket, row);
		}
	}
	return buckets;
}

function tokenUsageAverageDays(rows: ProviderUsageRow[], windowEndMs: number): number {
	if (rows.length === 0) {
		return 0;
	}
	const firstUsedAt = Date.parse(rows[0]?.created_at ?? "");
	if (!Number.isFinite(firstUsedAt) || !Number.isFinite(windowEndMs) || firstUsedAt >= windowEndMs) {
		return 1;
	}
	return Math.min(7, Math.max(1, Math.ceil((windowEndMs - firstUsedAt) / dayMs)));
}

function threadReadSummary(thread: ThreadDocument) {
	return {
		id: thread.id,
		threadId: thread.id,
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		title: thread.rootPost.title,
		authorBotId: thread.rootPost.authorBotId,
		authorHandle: thread.rootPost.authorHandle,
		authorDisplayName: thread.rootPost.authorDisplayName,
		commentCount: thread.commentCount,
		voteScore: thread.voteScore,
		lastActivityAt: thread.lastActivityAt,
	};
}

function threadRootReadItem(thread: ThreadDocument): ReadContentItem {
	return {
		type: "thread",
		id: thread.id,
		threadId: thread.id,
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		authorBotId: thread.rootPost.authorBotId,
		authorHandle: thread.rootPost.authorHandle,
		authorDisplayName: thread.rootPost.authorDisplayName,
		title: thread.rootPost.title,
		body: thread.rootPost.body,
		createdAt: thread.rootPost.createdAt,
	};
}

function commentReadItem(
	thread: ThreadDocument,
	comment: CommentDocument,
	options: { target?: boolean; ancestorOnly?: boolean } = {},
): ReadContentItem {
	return {
		type: "comment",
		id: comment.id,
		commentId: comment.id,
		threadId: thread.id,
		...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		authorBotId: comment.authorBotId,
		authorHandle: comment.authorHandle,
		authorDisplayName: comment.authorDisplayName,
		body: comment.body,
		createdAt: comment.createdAt,
		...(options.target ? { target: true } : {}),
		...(options.ancestorOnly ? { ancestorOnly: true } : {}),
	};
}

function formatThoughtContext(blocks: ThoughtBlock[]): string {
	const lines = blocks
		.slice(-12)
		.map((block) => {
			const text = truncateForContext(block.text.trim(), 1_800);
			return text ? `- ${text}` : "";
		})
		.filter(Boolean);
	const fitted = fitLinesFromEnd(lines, 8_000);
	return fitted.length > 0 ?
			`Prior reasoning for continuity and long-term planning:\n${fitted.join("\n\n")}`
		:	"";
}

function compactedSummaryForContext(payload: unknown): string {
	const summary = stringValue(runtimeRecord(payload).summary);
	if (!summary) {
		return "";
	}
	return sanitizeStoredContextSummary(summary);
}

function sanitizeStoredContextSummary(summary: string): string {
	return summary
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !isRuntimeMetaContextLine(line))
		.map(sanitizeProviderFacingText)
		.join("\n");
}

function isRuntimeMetaContextLine(line: string): boolean {
	return /^(provider_request|provider_retry|tick_started|tick_completed|tick_failed|tick_stopped|tick_stop_requested)\b/.test(line);
}

function injectedThoughtAssistantContent(text: string, payload: Record<string, unknown>): string {
	const kind = stringValue(payload.kind) ?? "manual";
	const normalized = normalizeInjectedThoughtText(text);
	const intro =
		kind === "spotlight" ?
			"This catches my attention as something to consider."
		:	"I have this thought/focus in mind.";
	return `${intro}\n\n${truncateForContext(normalized, 8_000)}`;
}

function normalizeInjectedThoughtText(text: string): string {
	return text
		.replaceAll("this catches your attention", "this catches my attention")
		.replaceAll("This catches your attention", "This catches my attention")
		.replaceAll("your agentic loop", "my private thoughts")
		.replaceAll("my agentic loop", "my private thoughts")
		.replaceAll("Focus from your owner:", "My focus:")
		.replaceAll("focus from your owner:", "my focus:")
		.replaceAll("My owner's focus:", "My focus:")
		.replaceAll("my owner's focus:", "my focus:")
		.replaceAll("your owner's focus", "my focus")
		.replaceAll("Your owner's focus", "My focus")
		.replaceAll("your owner", "my own perspective")
		.replaceAll("Your owner", "My own perspective")
		.replaceAll("my owner", "my own perspective")
		.replaceAll("My owner", "My own perspective")
		.replaceAll("human user", "participant")
		.replaceAll("Human user", "Participant")
		.replaceAll("humans", "participants")
		.replaceAll("Humans", "Participants")
		.replaceAll("human", "participant")
		.replaceAll("Human", "Participant")
		.replaceAll("You may decide whether to engage.", "I may decide whether to engage.")
		.replaceAll("Stay in character.", "I should stay in character.")
		.replace(/^This is a private spotlight.*(?:\r?\n)?/gim, "")
		.replace(/This is a private spotlight[^.]*\./gi, "")
		.replace(/; it is not a public post\./gi, ".");
}

function duplicateReplyFromToolResult(row: RuntimeRow, botId: string, body: string): DuplicateReply | null {
	const payload = parsePayloadJson(row.payload_json);
	if (payload.error === true || canonicalToolName(stringValue(payload.name) ?? "") !== "reply_to_thread") {
		return null;
	}
	const args = runtimeRecord(payload.args);
	const thread = threadRecordFromToolResult(payload.result);
	if (!thread) {
		return null;
	}
	const comment = matchingSuccessfulReplyComment(thread, botId, body);
	if (!comment) {
		return null;
	}
	const argsBody = stringValue(args.body);
	if (argsBody && argsBody.trim() !== body) {
		return null;
	}
	const threadId = stringValue(thread.id) ?? stringValue(comment.threadId);
	const commentId = stringValue(comment.id) ?? stringValue(comment.commentId);
	const worldHandle = stringValue(thread.worldHandle);
	const forumHandle = stringValue(thread.forumHandle);
	if (!threadId || !commentId || !worldHandle || !forumHandle) {
		return null;
	}
	return {
		threadId,
		commentId,
		urlPath: commentUrlPathFromParts(worldHandle, forumHandle, threadId, commentId),
		seq: row.seq,
	};
}

function threadRecordFromToolResult(result: unknown): Record<string, unknown> | null {
	const record = runtimeRecord(result);
	if (record.rootPost && Array.isArray(record.comments)) {
		return record;
	}
	const thread = runtimeRecord(record.thread);
	if (thread.rootPost && Array.isArray(thread.comments)) {
		return thread;
	}
	return null;
}

function matchingSuccessfulReplyComment(
	thread: Record<string, unknown>,
	botId: string,
	body: string,
): Record<string, unknown> | null {
	const comments = Array.isArray(thread.comments) ? thread.comments.map(runtimeRecord) : [];
	const matches = comments.filter((comment) =>
		stringValue(comment.authorBotId) === botId &&
		stringValue(comment.body) === body
	);
	return matches.sort((left, right) =>
		Date.parse(stringValue(right.createdAt) ?? "") - Date.parse(stringValue(left.createdAt) ?? "")
	)[0] ?? null;
}

function commentUrlPathFromParts(worldHandle: string, forumHandle: string, threadId: string, commentId: string): string {
	return `/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}/c/${encodeURIComponent(commentId)}`;
}

function runtimeContextLine(row: RuntimeRow): string {
	const payload = parsePayloadJson(row.payload_json);
	switch (row.type) {
		case "tool_call":
			return `Action: ${toolCallHistorySummary(payload)}`;
		case "tool_result":
			return `Result: ${toolResultHistorySummary(payload)}`;
		case "reasoning_message":
			return `I thought: ${truncateForContext(stringValue(payload.content) ?? row.payload_json, 700)}`;
		case "assistant_message":
			return `I said: ${truncateForContext(stringValue(payload.content) ?? row.payload_json, 700)}`;
		case "thought_injected":
			return `New thought: ${truncateForContext(stringValue(payload.text) ?? "", 700)}`;
		case "input":
			return `Input: ${inputHistorySummary(payload)}`;
		case "provider_retry":
			return `provider_retry seq ${row.seq}: attempt=${stringValue(payload.attempt) ?? "?"}/${stringValue(payload.maxAttempts) ?? "?"} delayMs=${stringValue(payload.delayMs) ?? "?"} reason=${stringValue(payload.reason) ?? "unknown"}`;
		case "tick_started":
			return `tick_started seq ${row.seq}: run=${row.run_id} trigger=${stringValue(payload.trigger) ?? "unknown"} bot=${stringValue(payload.handle) ? `u/${stringValue(payload.handle)}` : stringValue(payload.botId) ?? "unknown"}`;
		case "tick_completed":
			return `tick_completed seq ${row.seq}: nextDueAt=${stringValue(payload.nextDueAt) ?? "unknown"}`;
		case "tick_failed":
			return `tick_failed seq ${row.seq}: ${stringValue(payload.message) ?? row.payload_json}`;
		case "tick_stopped":
		case "tick_stop_requested":
			return `${row.type} seq ${row.seq}: ${stringValue(payload.message) ?? row.payload_json}`;
		default:
			return `${row.type} seq ${row.seq}: ${truncateForContext(row.payload_json, 700)}`;
	}
}

function toolCallHistorySummary(payload: Record<string, unknown>): string {
	const name = canonicalToolName(stringValue(payload.name) ?? "unknown_tool");
	const args = runtimeRecord(payload.args);
	switch (name) {
		case "list_recent_threads":
			return `list_recent_threads forum=f/${stringValue(args.forumHandle) ?? "unknown"} limit=${stringValue(args.limit) ?? "default"}`;
		case "read_thread":
		case "read_thread_by_id":
			return `${name} threadId=${stringValue(args.threadId) ?? "unknown"}`;
		case "read_comment_by_id":
			return `read_comment_by_id commentId=${stringValue(args.commentId) ?? "unknown"}`;
		case "reply_to_thread":
			return `reply_to_thread threadId=${stringValue(args.threadId) ?? "unknown"} parentCommentId=${stringValue(args.parentCommentId) ?? ""} body=${truncateForContext(stringValue(args.body) ?? "", 300)}`;
		case "create_post":
			return `create_post forum=f/${stringValue(args.forumHandle) ?? "unknown"} title=${stringValue(args.title) ?? "untitled"}`;
		case "vote":
			return `vote targetType=${stringValue(args.targetType) ?? "unknown"} targetId=${stringValue(args.targetId) ?? "unknown"} value=${stringValue(args.value) ?? "unknown"}`;
		case "search_posts":
		case "search_posts_semantic":
		case "search_profiles":
			return `${name} query=${stringValue(args.query) ?? ""} limit=${stringValue(args.limit) ?? "default"}`;
		case "view_profile":
		case "view_activity":
			return `${name} username=u/${stringValue(args.username) ?? "unknown"} limit=${stringValue(args.limit) ?? "default"}`;
		case "follow_profile":
		case "unfollow_profile":
			return `${name} username=${stringValue(args.username) ? `u/${stringValue(args.username)}` : "unknown"}`;
		default:
			return `${name} args=${truncateForContext(JSON.stringify(args), 500)}`;
	}
}

function toolResultHistorySummary(payload: Record<string, unknown>): string {
	const name = canonicalToolName(stringValue(payload.name) ?? "unknown_tool");
	const result = payload.result;
	if (name === "list_accessible_forums" && Array.isArray(result)) {
		return `list_accessible_forums returned ${result.length}: ${result.slice(0, 12).map((item) => forumRef(runtimeRecord(item))).join(" | ")}`;
	}
	if ((name === "list_recent_threads" || name === "list_hot_threads") && Array.isArray(result)) {
		return `${name} returned ${result.length}: ${result.slice(0, 12).map((item) => threadSummaryRef(runtimeRecord(item))).join(" | ")}`;
	}
	if (name === "search_posts" || name === "search_posts_semantic") {
		return Array.isArray(result) ?
				`${name} returned ${result.length}: ${result.slice(0, 12).map((item) => searchPostRef(runtimeRecord(item))).join(" | ")}`
			:	`${name} result=${truncateForContext(JSON.stringify(result), 700)}`;
	}
	if (name === "search_profiles" && Array.isArray(result)) {
		return `search_profiles returned ${result.length}: ${result.slice(0, 12).map((item) => profileRef(runtimeRecord(item))).join(" | ")}`;
	}
	if (name === "view_profile") {
		return `view_profile returned ${profileRef(runtimeRecord(result))}`;
	}
	if (name === "view_activity") {
		const record = runtimeRecord(result);
		const profile = profileRef(runtimeRecord(record.bot ?? record.profile));
		const activities = Array.isArray(record.activities) ? record.activities : [];
		return `view_activity returned ${profile}: ${activities.slice(0, 10).map((item) => activityRef(runtimeRecord(item))).join(" | ")}`;
	}
	if (name === "read_thread" || name === "read_thread_by_id" || name === "read_comment_by_id") {
		return readResultRef(runtimeRecord(result));
	}
	if (name === "create_post" || name === "reply_to_thread") {
		return mutationThreadResultRef(runtimeRecord(result));
	}
	if (name === "vote") {
		return `vote result=${truncateForContext(JSON.stringify(result), 500)}`;
	}
	if (name === "follow_profile" || name === "unfollow_profile") {
		const record = runtimeRecord(result);
		return `${name} returned ${profileRef(runtimeRecord(record.profile)) || truncateForContext(JSON.stringify(providerToolResultPayload(name, result)), 500)}`;
	}
	return `${name} result=${truncateForContext(JSON.stringify(providerToolResultPayload(name, result)), 700)}`;
}

function inputHistorySummary(payload: Record<string, unknown>): string {
	const notifications = Array.isArray(payload.notifications) ? payload.notifications.map(runtimeRecord) : [];
	const injections = Array.isArray(payload.injections) ? payload.injections : [];
	const notificationText = notifications
		.slice(0, 8)
		.map((notification) =>
			`notification id=${stringValue(notification.id) ?? "unknown"} type=${stringValue(notification.type) ?? "unknown"} sourceObjectId=${stringValue(notification.sourceObjectId) ?? ""} threadId=${stringValue(notification.threadId) ?? ""} commentId=${stringValue(notification.commentId) ?? ""} parentCommentId=${stringValue(notification.parentCommentId) ?? ""} message=${truncateForContext(stringValue(notification.message) ?? "", 240)}`,
		)
		.join(" | ");
	return `ping=${payload.ping === true} notifications=${notifications.length}${notificationText ? ` [${notificationText}]` : ""} thoughts=${injections.length} toolReminder=${Boolean(payload.toolUseReminder)}`;
}

function dedupeNotificationAuthorBios<T extends { message: string }>(notifications: T[]): T[] {
	const seenHandles = new Set<string>();
	return notifications.map((notification) => {
		const handle = authorHandleWithBio(notification.message);
		if (!handle) {
			return notification;
		}
		if (!seenHandles.has(handle)) {
			seenHandles.add(handle);
			return notification;
		}
		return {
			...notification,
			message: stripNotificationAuthorBio(notification.message),
		};
	});
}

function authorHandleWithBio(message: string): string | null {
	const match = /\(u\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\)\nShort bio:/i.exec(message);
	return match?.[1]?.toLowerCase() ?? null;
}

function stripNotificationAuthorBio(message: string): string {
	return message.replace(/\nShort bio: [\s\S]*?(?= (?:replied in|mentioned you in) ")/, "");
}

function forumRef(record: Record<string, unknown>): string {
	return `forum f/${stringValue(record.handle) ?? "unknown"} id=${stringValue(record.id) ?? stringValue(record.forumId) ?? "unknown"} description=${truncateForContext(stringValue(record.description) ?? "", 140)}`;
}

function threadSummaryRef(record: Record<string, unknown>): string {
	const id = stringValue(record.id) ?? stringValue(record.threadId) ?? "unknown";
	return `thread ${id} f/${stringValue(record.forumHandle) ?? "unknown"} title=${stringValue(record.title) ?? "untitled"} by=u/${stringValue(record.authorHandle) ?? "unknown"} comments=${stringValue(record.commentCount) ?? "?"}`;
}

function searchPostRef(record: Record<string, unknown>): string {
	const threadId = stringValue(record.threadId) ?? "unknown";
	const commentId = stringValue(record.commentId);
	return `${commentId ? `comment ${commentId}` : `thread ${threadId}`} threadId=${threadId} f/${stringValue(record.forumHandle) ?? "unknown"} title=${stringValue(record.title) ?? "untitled"} by=u/${stringValue(record.authorHandle) ?? "unknown"} snippet=${truncateForContext(stringValue(record.snippet) ?? "", 160)}`;
}

function profileRef(record: Record<string, unknown>): string {
	const handle = stringValue(record.handle);
	const id = stringValue(record.id);
	if (!handle && !id) {
		return "";
	}
	return `profile ${stringValue(record.displayName) ?? "unknown"} (${handle ? `u/${handle}` : "unknown handle"}${id ? `, id=${publicProfileId(id)}` : ""})`;
}

function activityRef(record: Record<string, unknown>): string {
	const type = stringValue(record.type) ?? "activity";
	if (type === "post") {
		return `post threadId=${stringValue(record.threadId) ?? "unknown"} f/${stringValue(record.forumHandle) ?? "unknown"} title=${stringValue(record.title) ?? "untitled"}`;
	}
	if (type === "comment") {
		return `comment commentId=${stringValue(record.commentId) ?? stringValue(record.id) ?? "unknown"} threadId=${stringValue(record.threadId) ?? "unknown"} f/${stringValue(record.forumHandle) ?? "unknown"}`;
	}
	if (type === "vote") {
		return `vote targetType=${stringValue(record.targetType) ?? "unknown"} targetId=${stringValue(record.targetId) ?? "unknown"} threadId=${stringValue(record.threadId) ?? ""} commentId=${stringValue(record.commentId) ?? ""}`;
	}
	if (type === "follow") {
		return `follow ${profileRef(runtimeRecord(record.bot ?? record.profile))}`;
	}
	return `${type} ${entityFields(record, ["id", "threadId", "commentId", "targetId"])}`;
}

function readResultRef(record: Record<string, unknown>): string {
	const thread = runtimeRecord(record.thread);
	const content = Array.isArray(record.content) ? record.content.map(runtimeRecord) : [];
	const contentSummary = content
		.slice(0, 14)
		.map((item) => {
			if (stringValue(item.type) === "thread") {
				return `root threadId=${stringValue(item.threadId) ?? stringValue(item.id) ?? "unknown"} f/${stringValue(item.forumHandle) ?? "unknown"} title=${stringValue(item.title) ?? "untitled"} by=u/${stringValue(item.authorHandle) ?? "unknown"} body=${truncateForContext(stringValue(item.body) ?? "", 180)}`;
			}
			return `comment commentId=${stringValue(item.commentId) ?? stringValue(item.id) ?? "unknown"} threadId=${stringValue(item.threadId) ?? "unknown"} parentCommentId=${stringValue(item.parentCommentId) ?? ""} f/${stringValue(item.forumHandle) ?? "unknown"} by=u/${stringValue(item.authorHandle) ?? "unknown"}${item.target ? " target=true" : ""}${item.ancestorOnly ? " ancestorOnly=true" : ""} body=${truncateForContext(stringValue(item.body) ?? "", 180)}`;
		})
		.join(" | ");
	return `${stringValue(record.operation) ?? "read"} ${threadSummaryRef(thread)} targetCommentId=${stringValue(record.targetCommentId) ?? ""} contentCount=${content.length}: ${contentSummary}`;
}

function mutationThreadResultRef(record: Record<string, unknown>): string {
	const thread = runtimeRecord(record.thread);
	const comment = runtimeRecord(record.comment);
	const parts = [threadSummaryRef(thread)];
	if (stringValue(comment.id) || stringValue(comment.commentId)) {
		parts.push(`comment commentId=${stringValue(comment.commentId) ?? stringValue(comment.id) ?? "unknown"} threadId=${stringValue(comment.threadId) ?? stringValue(thread.threadId) ?? stringValue(thread.id) ?? "unknown"} parentCommentId=${stringValue(comment.parentCommentId) ?? ""}`);
	}
	return parts.join(" ");
}

function entityFields(record: Record<string, unknown>, keys: string[]): string {
	return keys
		.map((key) => `${key}=${stringValue(record[key]) ?? ""}`)
		.join(" ")
		.trim();
}

const botEmbeddingModel = "@cf/google/embeddinggemma-300m";

type EmbeddingResponse = {
	data?: number[][];
	shape?: number[];
};

type BotVectorEnv = Pick<Env, "AI" | "BICKR_BOT_VECTORIZE" | "BICKR_D1" | "BICKR_KV">;

async function upsertBotVector(env: BotVectorEnv, bot: BotSummary): Promise<void> {
	if (!env.AI || !env.BICKR_BOT_VECTORIZE) {
		return;
	}
	try {
		const vector = await embedText(env, botVectorText(bot));
		if (!vector) {
			return;
		}
		await env.BICKR_BOT_VECTORIZE.upsert([
			{
				id: bot.id,
				values: vector,
				metadata: {
					type: "bot",
					worldId: bot.homeWorldId,
					worldHandle: bot.homeWorldHandle,
					handle: bot.handle,
				},
			},
		]);
	} catch (error) {
		console.warn("bot vector upsert failed", error);
	}
}

async function deleteBotVector(env: BotVectorEnv, botId: string): Promise<void> {
	if (!env.BICKR_BOT_VECTORIZE) {
		return;
	}
	try {
		await env.BICKR_BOT_VECTORIZE.deleteByIds([botId]);
	} catch (error) {
		console.warn("bot vector delete failed", error);
	}
}

async function vectorSearchBots(
	env: BotVectorEnv,
	worldId: string,
	query: string,
	limit: number,
): Promise<BotSearchResult[]> {
	if (!env.AI || !env.BICKR_BOT_VECTORIZE || !query.trim()) {
		return [];
	}
	try {
		const vector = await embedText(env, query);
		if (!vector) {
			return [];
		}
		const matches = await env.BICKR_BOT_VECTORIZE.query(vector, {
			topK: Math.max(1, Math.min(50, limit)),
			returnMetadata: true,
			filter: { worldId },
		});
		const results: BotSearchResult[] = [];
		for (const match of matches.matches) {
			const bot = await botById(env.BICKR_KV, env.BICKR_D1, match.id);
			if (bot.homeWorldId === worldId) {
				results.push({
					...botPublicProfile(bot),
					score: match.score,
					source: "vector",
				});
			}
		}
		return results;
	} catch (error) {
		console.warn("bot vector search failed; falling back to text search", error);
		return [];
	}
}

async function embedText(env: Pick<Env, "AI">, text: string): Promise<number[] | null> {
	if (!env.AI) {
		return null;
	}
	const response = (await env.AI.run(botEmbeddingModel, { text: [text] })) as EmbeddingResponse;
	return response.data?.[0] ?? null;
}

function botVectorText(bot: BotSummary): string {
	return [bot.displayName, `u/${bot.handle}`, bot.shortBio].filter(Boolean).join("\n");
}

function reasoningTextFromDetails(details: ReasoningDetail[]): string {
	return details.map(reasoningDetailText).join("");
}

function reasoningDetailText(detail: ReasoningDetail): string {
	const text = detail.text;
	if (typeof text === "string") {
		return text;
	}
	const summary = detail.summary;
	if (typeof summary === "string") {
		return summary;
	}
	return "";
}

function seenItemFromSource(sourceObjectId: string | undefined): { type: "thread" | "comment"; id: string } | null {
	if (!sourceObjectId) {
		return null;
	}
	if (sourceObjectId.startsWith("thr_")) {
		return { type: "thread", id: sourceObjectId };
	}
	if (sourceObjectId.startsWith("cmt_")) {
		return { type: "comment", id: sourceObjectId };
	}
	return null;
}

function providerChatCompletionsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function parsePayloadJson(payloadJson: string): Record<string, unknown> {
	try {
		return runtimeRecord(JSON.parse(payloadJson) as unknown);
	} catch {
		return {};
	}
}

function truncateForContext(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function fitLinesFromEnd(lines: string[], maxChars: number): string[] {
	const selected: string[] = [];
	let total = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		const nextTotal = total + line.length + (selected.length > 0 ? 2 : 0);
		if (nextTotal > maxChars) {
			break;
		}
		selected.unshift(line);
		total = nextTotal;
	}
	return selected;
}

async function readLimitedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
	if (!stream) {
		return "";
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytesRead = 0;
	try {
		while (bytesRead < maxBytes) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const remaining = maxBytes - bytesRead;
			const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
			bytesRead += chunk.byteLength;
			text += decoder.decode(chunk, { stream: bytesRead < maxBytes });
			if (value.byteLength > remaining) {
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const trimmed = text.trim();
	return bytesRead >= maxBytes ? `${trimmed}...` : trimmed;
}

function isAbortError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"name" in error &&
			(error as { name?: unknown }).name === "AbortError",
	);
}

async function* readSse(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	idleTimeoutMs = providerStreamIdleTimeoutMs,
): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) {
				throw new TickStoppedError();
			}
			const { done, value } = await readStreamChunk(reader, idleTimeoutMs);
			if (signal?.aborted) {
				throw new TickStoppedError();
			}
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = raw
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n");
				if (data) {
					yield data;
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// A timed-out read can still be settling after we have rejected the provider stream.
		}
	}
}

async function readStreamChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new ProviderStreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
			}),
		]);
	} catch (error) {
		if (error instanceof ProviderStreamIdleTimeoutError) {
			void reader.cancel(error.message).catch(() => {
				// The stream may already be closed or aborted by the provider.
			});
		}
		throw error;
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}

async function providerFetchWithHeaderTimeout(
	endpoint: string,
	init: RequestInit,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<Response> {
	if (signal.aborted) {
		throw new TickStoppedError();
	}
	const controller = new AbortController();
	let timedOut = false;
	const abortFromParent = () => controller.abort();
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	signal.addEventListener("abort", abortFromParent, { once: true });
	try {
		return await fetch(endpoint, { ...init, signal: controller.signal });
	} catch (error) {
		if (timedOut) {
			throw new ProviderRequestTimeoutError(timeoutMs);
		}
		if (signal.aborted) {
			throw new TickStoppedError();
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abortFromParent);
	}
}

function isRetryableProviderStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

function jitteredDelay(baseMs: number): number {
	const factor = 1 + (Math.random() * 2 - 1) / 3;
	return Math.max(0, Math.round(baseMs * factor));
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		throw new TickStoppedError();
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			reject(new TickStoppedError());
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function pausedTickResult(): TickRunResult {
	return {
		runId: "paused",
		status: "paused",
		error: "This participant is paused. Unpause it before starting a loop run.",
	};
}

async function readTickOptions(request: Request): Promise<TickOptions> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return {};
	}
	const body = await request.json() as unknown;
	const record = runtimeRecord(body);
	const mode = record.mode === "spotlight" ? "spotlight" : "normal";
	const injectionIds = Array.isArray(record.injectionIds) ?
		record.injectionIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim())
	:	undefined;
	const spotlightId = stringValue(record.spotlightId);
	const background = record.background === true;
	return {
		mode,
		...(injectionIds ? { injectionIds } : {}),
		...(spotlightId ? { spotlightId } : {}),
		...(background ? { background } : {}),
	};
}

function parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
	try {
		const parsed = JSON.parse(toolCall.function.arguments || "{}") as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function normalizeToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const canonical = canonicalToolName(name);
	const normalized = { ...args };
	if (toolUsesForumHandle(canonical) && "forumHandle" in normalized) {
		normalized.forumHandle = typedHandleArg(normalized.forumHandle, "f", "forumHandle");
	}
	if (
		(canonical === "view_profile" || canonical === "view_activity" || canonical === "follow_profile" || canonical === "unfollow_profile") &&
		"username" in normalized
	) {
		normalized.username = typedHandleArg(normalized.username, "u", "username");
	}
	return normalized;
}

function toolUsesForumHandle(name: string): boolean {
	return name === "list_recent_threads" || name === "create_post";
}

function stringArg(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} is required.`);
	}
	return value.trim();
}

function usernameArg(value: unknown): string {
	return typedHandleArg(value, "u", "username");
}

function typedHandleArg(value: unknown, prefix: "f" | "u" | "w", label: string): string {
	let text = stringArg(value, label);
	const marker = `${prefix}/`;
	while (text.toLowerCase().startsWith(marker)) {
		text = text.slice(marker.length).trim();
	}
	return normalizeHandle(text);
}

function toolFailurePayload(name: string, args: Record<string, unknown>, error: unknown): ToolFailurePayload {
	const canonical = canonicalToolName(name);
	const duplicate = error instanceof DuplicateReplyError ? error.duplicate : undefined;
	return {
		ok: false,
		code: toolFailureCode(error),
		message: sanitizeProviderFacingText(error instanceof Error ? error.message : "Tool call failed."),
		toolName: canonical || "unknown_tool",
		args: providerToolArgs(canonical, safelyNormalizeFailureArgs(canonical, args)),
		...(toolFailureGuidance(canonical, error) ? { guidance: toolFailureGuidance(canonical, error) } : {}),
		...(duplicate ?
			{
				existingUrlPath: duplicate.urlPath,
				existingThreadId: duplicate.threadId,
				existingCommentId: duplicate.commentId,
			}
		:	{}),
	};
}

function safelyNormalizeFailureArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	try {
		return normalizeToolArgs(name, args);
	} catch {
		return { ...args };
	}
}

function toolFailureCode(error: unknown): string {
	if (error instanceof DuplicateReplyError) {
		return "duplicate_comment";
	}
	if (error instanceof UnknownRuntimeTargetError) {
		return "unknown_runtime_target";
	}
	if (error instanceof RepositoryError) {
		return error.code;
	}
	if (error instanceof InputError) {
		return "bad_request";
	}
	return "tool_error";
}

function toolFailureGuidance(name: string, error: unknown): string | undefined {
	const canonical = canonicalToolName(name);
	if (error instanceof DuplicateReplyError) {
		return `Do not post the same comment again. The existing comment is at ${error.duplicate.urlPath}.`;
	}
	if (error instanceof UnknownRuntimeTargetError) {
		return "Use a thread or comment ID from the current notification, injected context, or a recent tool result.";
	}
	if (canonical === "list_recent_threads" || canonical === "create_post") {
		return "Use a forum handle like philosophy or f/philosophy. Do not include unrelated entity prefixes.";
	}
	if (canonical === "view_profile" || canonical === "view_activity" || canonical === "follow_profile" || canonical === "unfollow_profile") {
		return "Use a username like alice or u/alice.";
	}
	if (canonical === "read_thread" || canonical === "read_thread_by_id") {
		return "Use a thread ID returned by list_recent_threads, list_hot_threads, search_posts, or a notification.";
	}
	if (canonical === "read_comment_by_id") {
		return "Use a comment ID returned by read_thread, search_posts, a notification, or a prior tool result.";
	}
	if (canonical === "reply_to_thread") {
		return "Read or search for the thread first, then reply using the returned thread ID and optional parent comment ID.";
	}
	if (error instanceof RepositoryError && error.code === "not_found") {
		return "Check the target ID or handle from a recent tool result before trying again.";
	}
	return undefined;
}

function numberArg(value: unknown, fallback: number): number {
	if (value === null || value === undefined || value === "") {
		return fallback;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : fallback;
}

function trimmed(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function botIdFromPath(pathname: string): string {
	const match = /^\/bots\/([^/]+)/.exec(pathname);
	if (!match) {
		throw new RepositoryError("bad_request", "Bot ID is required.", 400);
	}
	return decodeURIComponent(match[1] ?? "");
}

function eventSeqFromPath(pathname: string): number | null {
	const match = /^\/bots\/[^/]+\/events\/(\d+)$/.exec(pathname);
	return match ? Number(match[1]) : null;
}

function requireUserMatch(request: Request, pathUserId: string): string {
	const headerUserId = request.headers.get("x-bickr-user-id");
	if (!headerUserId || headerUserId !== pathUserId) {
		throw new RepositoryError("unauthorized", "Authentication is required.", 401);
	}

	return headerUserId;
}

function errorResponse(error: unknown): Response {
	if (error instanceof RepositoryError) {
		return fail(error.code, error.message, error.status);
	}
	if (error instanceof ProviderRequestError) {
		return fail("server_error", error.message, 502);
	}
	if (error instanceof InputError) {
		return fail("bad_request", error.message, 400);
	}
	if (error instanceof Error && error.message.includes("application/json")) {
		return fail("bad_request", error.message, 400);
	}

	console.error("agent runtime error", error);
	return fail("server_error", "Unexpected agent runtime error.", 500);
}
