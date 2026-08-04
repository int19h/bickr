import { parseAccountMutationResult } from "@bickr/shared/account-mutation-protocol";
import {
	resolveBotProviderSettings,
	type BotProviderSettingSource,
	type ProviderEnvironmentSettings,
	type ResolvedBotProviderSetting,
	type ResolvedBotProviderSettings,
} from "@bickr/shared/inference-settings";
import {
	addInternalServiceAuthHeader,
	type InternalServiceAuthEnv,
	internalServiceUrl,
} from "@bickr/shared/internal-service";
import {
	authForMcpAccessToken,
	mcpScopeString,
	type McpAuthContext,
	type McpScope,
} from "@bickr/shared/mcp-auth";
import { requireMaintenanceDisabled } from "@bickr/shared/maintenance";
import {
	avatarImageGenerationSettingsWithDefaults,
	type BotDocument,
	type BotGroupSummary,
	type BotImageGenerationSettings,
	type BotInferenceSettings,
	type BotSummary,
	type BotTickSettings,
	type BotEffectiveTickSettings,
	type BotEffectivePostingSettings,
	type PostingSettings,
	type ForumSummary,
	type ThreadDocument,
	type UserDocument,
	type WorldSummary,
	worldAvatarImageGenerationSettingsWithDefaults,
} from "@bickr/shared/model";
import { defaultPostingSettings } from "@bickr/shared/posting";
import { defaultThreadCommentLimit } from "@bickr/shared/thread-policy";
import {
	botById,
	listBotGroups,
	listForums,
	listOwnedWorlds,
	listUserAuthIdentities,
	listUserBots,
	listWorldBots,
	listWorlds,
	rawBotById,
	isBotDocument,
	publicBotSummary,
	userProfile,
	worldByHandle,
} from "@bickr/shared/repository";
import {
	deactivateHumanSubscription,
	forumByHandle,
	listHumanNotifications,
	listHumanSubscriptions,
	listThreadsWithReadState,
	markAllHumanNotificationsRead,
	readThreadWithReadState,
	upsertHumanSubscription,
} from "@bickr/shared/social";
import {
	boundedSearchPage,
	normalizeSearchFilters,
	parseSearchMode,
	parseSearchTypes,
	searchEntitiesText,
} from "@bickr/shared/search";
import {
	asRecord,
	InputError,
	parseUpdateUserProfileInput,
} from "@bickr/shared/validation";
import { type AppEnv, bearerToken } from "./api/_auth";
import { boundedLimit, boundedOffset } from "./api/_query";
import { fetchServiceJson } from "./api/_proxy";
import { exportForumRef, exportThreadRef } from "./api/cli/export/_export";
import { mcpAuthenticateHeader } from "./.well-known/oauth-protected-resource";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcRequest = {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: unknown;
};

type JsonRpcResponse = {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

type ToolAnnotations = {
	title: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

type McpToolBase = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: ToolAnnotations;
	scopes: McpScope[];
	resultKind: McpPayloadEnvelope["kind"];
};

type ReadMcpTool = McpToolBase & {
	kind: "read";
	execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
};

type MutationMcpTool = McpToolBase & {
	kind: "mutation";
	operationSchema: Record<string, unknown>;
	executeOperation: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
	legacyArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
};

type McpTool = ReadMcpTool | MutationMcpTool;

type MutationOperation = {
	operationId: string;
	arguments: Record<string, unknown>;
};

type MutationOperationResult =
	| { operationId: string; status: "succeeded"; result: JsonValue; resultWarning?: JsonValue }
	| { operationId: string; status: "failed"; error: JsonValue }
	| { operationId: string; status: "indeterminate"; error: JsonValue };

type McpPayloadEnvelope =
	| { kind: "opaque"; payload: unknown }
	| { kind: "presented"; payload: unknown }
	| { kind: "bot"; payload: unknown }
	| { kind: "world"; payload: unknown }
	| { kind: "worlds"; payload: unknown }
	| { kind: "forum"; payload: unknown }
	| { kind: "forums"; payload: unknown }
	| { kind: "thread"; payload: unknown }
	| { kind: "group"; payload: unknown }
	| { kind: "groups"; payload: unknown };

type ToolContext = {
	env: AppEnv;
	request: Request;
	auth: McpAuthContext;
	providerEnvironment?: Promise<ProviderEnvironmentSettings>;
	optionalProviderEnvironment?: Promise<ProviderEnvironmentSettings | undefined>;
	mutationOperationId?: string;
};

class InsufficientScopeError extends Error {
	readonly requiredScopes: McpScope[];

	constructor(requiredScopes: McpScope[]) {
		super(`This MCP tool requires ${mcpScopeString(requiredScopes)}.`);
		this.name = "InsufficientScopeError";
		this.requiredScopes = requiredScopes;
	}
}

export const onRequestOptions: PagesFunction<AppEnv> = async () => new Response(null, {
	status: 204,
	headers: corsHeaders(),
});

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	const auth = await mcpAuth(env, request);
	if (!auth) {
		return unauthorizedMcpResponse(request);
	}
	return new Response("Bickr MCP endpoint. Send JSON-RPC requests with POST.", {
		headers: {
			...corsHeaders(),
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
		},
	});
};

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	const auth = await mcpAuth(env, request);
	if (!auth) {
		return unauthorizedMcpResponse(request);
	}
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return jsonRpcHttpResponse(jsonRpcError(null, -32700, "Parse error."));
	}
	try {
		const ctx: ToolContext = { env, request, auth };
		const response = await handleJsonRpc(ctx, payload);
		return response ? jsonRpcHttpResponse(response) : new Response(null, { status: 202, headers: corsHeaders() });
	} catch (error) {
		if (error instanceof InsufficientScopeError) {
			return insufficientScopeResponse(request, error.requiredScopes);
		}
		console.error("mcp request error", error);
		return jsonRpcHttpResponse(jsonRpcError(null, -32603, "Internal error."));
	}
};

async function handleJsonRpc(ctx: ToolContext, value: unknown): Promise<JsonRpcResponse | null> {
	const request = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRpcRequest : {};
	const id = request.id ?? null;
	if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
		return jsonRpcError(id, -32600, "Invalid Request.");
	}
	if (request.method.startsWith("notifications/")) {
		return null;
	}
	switch (request.method) {
		case "initialize":
			return jsonRpcResult(id, {
				protocolVersion: "2025-06-18",
				capabilities: {
					tools: {},
				},
				serverInfo: {
					name: "bickr",
					version: "0.1.0",
				},
			});
		case "ping":
			return jsonRpcResult(id, {});
		case "tools/list":
			return jsonRpcResult(id, { tools: mcpTools.map(toolMetadata) });
		case "tools/call":
			return jsonRpcResult(id, await callTool(ctx, request.params));
		default:
			return jsonRpcError(id, -32601, "Method not found.");
	}
}

async function callTool(ctx: ToolContext, params: unknown): Promise<unknown> {
	const record = asRecord(params);
	const name = text(record.name, "Tool name");
	const tool = mcpTools.find((candidate) => candidate.name === name);
	if (!tool) {
		return toolError({ error: "not_found", message: `Unknown Bickr MCP tool: ${name}` });
	}
	requireToolScopes(ctx.auth, tool.scopes);
	const args = record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments) ?
		record.arguments as Record<string, unknown>
	:	{};
	switch (tool.kind) {
		case "read":
			try {
				const result = await tool.execute(ctx, args);
				return await toolResult({ kind: tool.resultKind, payload: result }, ctx);
			} catch (error) {
				return toolError(errorPayload(error));
			}
		case "mutation":
			return callMutationTool(ctx, tool, args);
		default:
			return assertNeverMcpTool(tool);
	}
}

const maxMutationOperations = 50;

async function callMutationTool(
	ctx: ToolContext,
	tool: MutationMcpTool,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	try {
		// Stopping an already-running visit helps the maintenance drain. Every
		// other runtime or data mutation is blocked before presentation prefetches
		// or any operation in a bulk request can commit.
		if (tool.name !== "stop_runtime") {
			await requireMaintenanceDisabled(ctx.env.BICKR_D1);
		}
		requireCompleteProfile(ctx.auth);
		if (!("operations" in args)) {
			// Compatibility for tool definitions cached before the bulk schema rollout.
			// Retire this singleton path after 2026-09-01 once clients have refreshed tools/list.
			const legacyArguments = tool.legacyArguments ? tool.legacyArguments(args) : args;
			if (mcpPayloadHasBots(tool.resultKind)) {
				// Resolve all presentation dependencies before the legacy mutation commits.
				// A later presentation failure must never make a committed write look retryable.
				await providerEnvironmentForMcp(ctx);
			}
			const result = await tool.executeOperation(ctx, legacyArguments);
			return await toolResult({ kind: tool.resultKind, payload: result }, ctx);
		}
		const operations = mutationOperations(args, tool.operationSchema);
		if (mcpPayloadHasBots(tool.resultKind)) {
			// The bulk result can degrade presentation to resultWarning, but fetching
			// once before all writes also removes avoidable post-commit network I/O.
			await providerEnvironmentForMcp(ctx);
		}
		const results: MutationOperationResult[] = [];
		// Preserve input order and avoid concurrent writes to the same logical entity.
		for (const operation of operations) {
			let payload: unknown;
			try {
				payload = await tool.executeOperation({ ...ctx, mutationOperationId: operation.operationId }, operation.arguments);
			} catch (error) {
				// An exception can happen after a downstream service committed but before its
				// response was observed (for example, a timeout). Never call that "failed":
				// doing so would make an unsafe automatic retry look reasonable.
				results.push({ operationId: operation.operationId, status: "indeterminate", error: jsonCompatible(errorPayload(error)) });
				continue;
			}
			if (isApiFailure(payload)) {
				results.push({ operationId: operation.operationId, status: "failed", error: jsonCompatible(payload) });
				continue;
			}
			results.push(await successfulMutationOperationResult(operation.operationId, tool.resultKind, payload, ctx));
		}
		return mutationToolResult(results);
	} catch (error) {
		return toolError(errorPayload(error));
	}
}

function mutationOperations(args: Record<string, unknown>, operationSchema: Record<string, unknown>): MutationOperation[] {
	if (Object.keys(args).some((key) => key !== "operations")) {
		throw new InputError("Bulk mutation arguments may only contain operations.");
	}
	if (!Array.isArray(args.operations) || args.operations.length === 0) {
		throw new InputError("Operations must be a non-empty array.");
	}
	if (args.operations.length > maxMutationOperations) {
		throw new InputError(`At most ${maxMutationOperations} operations may be submitted at once.`);
	}
	const operationProperties = schemaProperties(operationSchema);
	const allowedKeys = new Set(["operationId", ...Object.keys(operationProperties)]);
	const requiredKeys = schemaRequired(operationSchema);
	const seenIds = new Set<string>();
	return args.operations.map((value, index) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new InputError(`Operation ${index + 1} must be an object.`);
		}
		const record = value as Record<string, unknown>;
		const unexpectedKey = Object.keys(record).find((key) => !allowedKeys.has(key));
		if (unexpectedKey) {
			throw new InputError(`Operation ${index + 1} contains unsupported argument ${unexpectedKey}.`);
		}
		const missingKey = requiredKeys.find((key) => !(key in record));
		if (missingKey) {
			throw new InputError(`Operation ${index + 1} is missing required argument ${missingKey}.`);
		}
		if (typeof record.operationId !== "string" || !record.operationId.trim()) {
			throw new InputError(`Operation ${index + 1} ID is required.`);
		}
		const operationId = record.operationId;
		if (seenIds.has(operationId)) {
			throw new InputError(`Operation ID ${operationId} is duplicated.`);
		}
		seenIds.add(operationId);
		const { operationId: _operationId, ...operationArguments } = record;
		return { operationId, arguments: operationArguments };
	});
}

function assertNeverMcpTool(tool: never): never {
	throw new Error(`Unhandled MCP tool kind: ${String((tool as { kind?: unknown }).kind)}`);
}

const mcpTools: McpTool[] = [
	readTool("get_profile", "Get profile", "Read the signed-in human user's Bickr profile.", {}, async ({ env, auth }) => {
		const profile = userProfile(auth.user, await listUserAuthIdentities(env.BICKR_D1, auth.user.id));
		return { profile: { ...profile, lang: profile.language } };
	}),
	writeTool("update_profile", "Update profile", "Update the signed-in human user's Bickr profile.", bodySchema({
		handle: stringSchema("Profile handle."),
		lang: languageSchema("Selected profile language. Required when displayName is provided."),
		displayName: localizedTextSchema("Profile display name. lang must match the selected profile language."),
		uiLocale: uiLocaleSchema("UI language preference."),
		inferenceSettings: inferenceSettingsSchema("Optional profile inference settings patch. Localized prompt fields must use { lang, text }."),
	}), async (ctx, args) => {
		const payload = await servicePayload(
			ctx.env.AGENT_RUNTIME,
			ctx.env,
			ctx.request,
			`/users/${encodeURIComponent(ctx.auth.user.id)}/profile`,
			"PATCH",
			ctx.auth.user.id,
			parseUpdateUserProfileInput(mcpEntityLanguageBody(args)),
			ctx.mutationOperationId ? { "idempotency-key": `mcp:${ctx.auth.user.id}:${ctx.mutationOperationId}` } : {},
		);
		if (isApiFailure(payload)) return payload;
		const envelope = recordValue(payload, "Profile mutation envelope");
		const result = parseAccountMutationResult(envelope.ok === true ? envelope.data : envelope);
		switch (result.kind) {
			case "profile_updated":
				return { profile: { ...result.profile, lang: result.profile.language } };
			case "account_bootstrapped":
			case "provider_identity_linked":
			case "provider_identity_unlinked":
				throw new Error("Profile coordinator returned the wrong mutation result.");
		}
	}),
	readTool("list_worlds", "List worlds", "List public Bickr worlds.", {}, async ({ env }) => ({
		worlds: await listWorlds(env.BICKR_D1),
	}), "worlds"),
	readTool("list_my_worlds", "List my worlds", "List Bickr worlds owned by the signed-in human user.", {}, async ({ env, auth }) => ({
		worlds: await listOwnedWorlds(env.BICKR_D1, auth.user.id),
	}), "worlds"),
	serviceTool("create_world", "Create world", "Create a Bickr world.", bodySchema({
		handle: stringSchema("World handle."),
		lang: requiredLanguageSchema("Selected world language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		name: localizedTextSchema("World name. lang must match the selected world language."),
		description: localizedTextSchema("World description. lang must match the selected world language."),
		initialBotNotification: localizedTextSchema("Initial notification for bots created in this world. lang must match the selected world language."),
		threadSettings: threadSettingsSchema("Optional thread policy. The smaller global, world, or forum comment limit wins."),
	}), ["handle", "lang", "name", "description"], "write", "agent", "POST", (_args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds`, mcpEntityLanguageBody, "world"),
	serviceTool("update_world", "Update world", "Update a Bickr world owned by the signed-in human user.", bodySchema({
		worldHandle: stringSchema("Current world handle."),
		handle: stringSchema("New world handle."),
		lang: languageSchema("Selected world language. Required when updating localized world text."),
		name: localizedTextSchema("World name. lang must match the selected world language."),
		description: localizedTextSchema("World description. lang must match the selected world language."),
		initialBotNotification: localizedTextSchema("Initial notification for new bots. lang must match the selected world language."),
		threadSettings: threadSettingsSchema("Optional thread policy patch. Set commentLimit to null to restore the global default."),
	}), ["worldHandle"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}`, withoutMcpKeys("worldHandle"), "world"),
	serviceTool("delete_world", "Delete world", "Delete a Bickr world owned by the signed-in human user.", bodySchema({
		worldHandle: stringSchema("World handle."),
	}), ["worldHandle"], "destructive", "agent", "DELETE", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}`),
	readTool("list_forums", "List forums", "List forums in a Bickr world.", {
		worldHandle: stringSchema("World handle."),
	}, async ({ env }, args) => ({ forums: await listForums(env.BICKR_D1, text(args.worldHandle, "World handle")) }), "forums"),
	serviceTool("create_forum", "Create forum", "Create a forum in a Bickr world.", bodySchema({
		worldHandle: stringSchema("World handle."),
		handle: stringSchema("Forum handle."),
		lang: requiredLanguageSchema("Selected forum language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		description: localizedTextSchema("Forum description. lang must match the selected forum language."),
		threadSettings: threadSettingsSchema("Optional forum thread policy. The smaller world or forum comment limit wins."),
	}), ["worldHandle", "handle", "lang", "description"], "write", "forum", "POST", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/forums`, withoutMcpKeys("worldHandle"), "forum"),
	serviceTool("update_forum", "Update forum", "Update a Bickr forum.", bodySchema({
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Current forum handle."),
		handle: stringSchema("New forum handle."),
		lang: languageSchema("Selected forum language. Required when updating forum description."),
		description: localizedTextSchema("Forum description. lang must match the selected forum language."),
		threadSettings: threadSettingsSchema("Optional forum thread policy patch. Set commentLimit to null to inherit the world limit."),
	}), ["worldHandle", "forumHandle"], "write", "forum", "PATCH", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/forums/${encodeURIComponent(text(args.forumHandle, "Forum handle"))}`, withoutMcpKeys("worldHandle", "forumHandle"), "forum"),
	serviceTool("delete_forum", "Delete forum", "Delete a Bickr forum.", bodySchema({
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Forum handle."),
	}), ["worldHandle", "forumHandle"], "destructive", "forum", "DELETE", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/forums/${encodeURIComponent(text(args.forumHandle, "Forum handle"))}`),
	readTool("list_threads", "List threads", "List threads in a Bickr forum.", {
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Forum handle."),
		sort: enumSchema(["recent", "hot"], "Thread sort order."),
		limit: integerSchema("Maximum threads to return."),
		offset: integerSchema("Thread offset."),
	}, async ({ env, auth }, args) => {
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), text(args.forumHandle, "Forum handle"));
		const threads = await listThreadsWithReadState(
			env.BICKR_D1,
			forum.id,
			auth.user.id,
			args.sort === "hot" ? "hot" : "recent",
			boundedLimit(valueString(args.limit), 40, 500),
			boundedOffset(valueString(args.offset)),
		);
		return {
			forum: mcpForum(forum),
			threads: threads.map((thread) => ({ ...thread, lang: thread.title.lang })),
		};
	}),
	readTool("get_thread", "Get thread", "Read one Bickr thread and its comments.", {
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Forum handle."),
		threadId: stringSchema("Thread ID or short thread ref."),
	}, async ({ env, auth }, args) => {
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), text(args.forumHandle, "Forum handle"));
		const thread = await readThreadWithReadState(env.BICKR_KV, env.BICKR_D1, text(args.threadId, "Thread ID"), auth.user.id);
		if (thread.forumId !== forum.id) {
			throw new Error("Thread not found in this forum.");
		}
		return { thread };
	}, "thread"),
	botActorTool("create_thread", "Create thread", "Create a Bickr thread as one of the signed-in human user's bots.", bodySchema({
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Forum handle."),
		botId: stringSchema("Owned bot ID that will author the thread."),
		title: requiredLocalizedTextSchema("Thread title authored by the selected bot."),
		body: requiredLocalizedTextSchema("Thread body authored by the selected bot."),
		url: stringSchema("Optional canonical URL."),
	}), ["worldHandle", "forumHandle", "botId", "title", "body"], "POST", async (ctx, args) => {
		const forum = await forumByHandle(ctx.env.BICKR_KV, ctx.env.BICKR_D1, text(args.worldHandle, "World handle"), text(args.forumHandle, "Forum handle"));
		return { service: "forum" as const, path: `/forums/${encodeURIComponent(forum.id)}/threads`, body: withoutKeys("worldHandle", "forumHandle", "botId")(args) };
	}, "thread"),
	botActorTool("create_comment", "Create comment", "Create a Bickr comment or reply as one of the signed-in human user's bots.", bodySchema({
		botId: stringSchema("Owned bot ID that will author the comment."),
		threadId: stringSchema("Thread ID."),
		parentCommentId: stringSchema("Optional parent comment ID for a reply."),
		body: requiredLocalizedTextSchema("Comment body authored by the selected bot."),
	}), ["botId", "threadId", "body"], "POST", async (_ctx, args) => ({
		service: "forum" as const,
		path: args.parentCommentId ?
			`/comments/${encodeURIComponent(text(args.parentCommentId, "Parent comment ID"))}/replies`
		:	`/threads/${encodeURIComponent(text(args.threadId, "Thread ID"))}/comments`,
		body: withoutKeys("botId", "threadId")(args),
	}), "thread"),
	botActorTool("vote", "Vote", "Set one owned bot's vote on a Bickr thread or comment.", bodySchema({
		botId: stringSchema("Owned bot ID voting."),
		targetType: enumSchema(["thread", "comment"], "Vote target type."),
		targetId: stringSchema("Thread or comment ID selected by targetType."),
		value: enumSchema([-1, 0, 1], "Vote value: -1, 0, or 1."),
		reason: requiredLocalizedTextSchema("Optional vote reason authored by the selected bot."),
	}), ["botId", "targetType", "targetId", "value"], "POST", async (_ctx, args) => ({
		service: "forum" as const,
		path: "/votes",
		body: voteServiceBody(args),
	}), "thread", legacyVoteArguments),
	serviceTool("delete_thread", "Delete thread", "Delete a Bickr thread.", bodySchema({
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Forum handle."),
		threadId: stringSchema("Thread ID."),
	}), ["worldHandle", "forumHandle", "threadId"], "destructive", "forum", "DELETE", async (args, ctx) => {
		const forum = await forumByHandle(ctx.env.BICKR_KV, ctx.env.BICKR_D1, text(args.worldHandle, "World handle"), text(args.forumHandle, "Forum handle"));
		return `/forums/${encodeURIComponent(forum.id)}/threads/${encodeURIComponent(text(args.threadId, "Thread ID"))}`;
	}),
	serviceTool("delete_comment", "Delete comment", "Delete a Bickr comment.", bodySchema({
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Forum handle."),
		threadId: stringSchema("Thread ID."),
		commentId: stringSchema("Comment ID."),
	}), ["worldHandle", "forumHandle", "threadId", "commentId"], "destructive", "forum", "DELETE", async (args, ctx) => {
		const forum = await forumByHandle(ctx.env.BICKR_KV, ctx.env.BICKR_D1, text(args.worldHandle, "World handle"), text(args.forumHandle, "Forum handle"));
		return `/forums/${encodeURIComponent(forum.id)}/threads/${encodeURIComponent(text(args.threadId, "Thread ID"))}/comments/${encodeURIComponent(text(args.commentId, "Comment ID"))}`;
	}),
	readTool("list_my_bots", "List my bots", "List bots owned by the signed-in human user.", {}, async (ctx) => ({
		bots: annotateMcpBots(
			await listUserBots(ctx.env.BICKR_KV, ctx.env.BICKR_D1, ctx.auth.user.id),
			ctx.auth.user,
			await optionalProviderEnvironmentForMcp(ctx),
		),
	}), "presented"),
	readTool("list_world_bots", "List world bots", "List bots in a Bickr world.", {
		worldHandle: stringSchema("World handle."),
	}, async (ctx, args) => ({
		bots: annotateMcpBots(
			await listWorldBots(ctx.env.BICKR_KV, ctx.env.BICKR_D1, text(args.worldHandle, "World handle")),
			ctx.auth.user,
			await optionalProviderEnvironmentForMcp(ctx),
		),
	}), "presented"),
	readTool("get_bot", "Get bot", "Read one Bickr bot by ID.", {
		botId: stringSchema("Bot ID."),
	}, async (ctx, args) => {
		const bot = await botById(ctx.env.BICKR_KV, ctx.env.BICKR_D1, text(args.botId, "Bot ID"));
		const world = await worldByHandle(ctx.env.BICKR_D1, bot.homeWorldHandle);
		return {
			bot: annotateMcpBot(
				bot,
				world.postingSettings,
				ctx.auth.user,
				await optionalProviderEnvironmentForMcp(ctx),
			),
		};
	}, "presented"),
	serviceTool("create_bot", "Create bot", "Create a Bickr bot in a world.", bodySchema({
		worldHandle: stringSchema("World handle."),
		handle: stringSchema("Bot handle."),
		lang: requiredLanguageSchema("Selected bot language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		displayName: localizedTextSchema("Bot display name. lang must match the selected bot language."),
		shortBio: localizedTextSchema("Bot short bio. lang must match the selected bot language."),
		prompt: localizedTextSchema("Bot prompt. lang must match the selected bot language."),
		inferenceSettings: inferenceSettingsSchema("Optional inference settings. Localized prompt fields must use { lang, text } with lang matching the selected bot language."),
	}), ["worldHandle", "handle", "lang", "displayName", "shortBio", "prompt"], "write", "agent", "POST", (args, _ctx) => `/users/${encodeURIComponent(_ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/bots`, withoutMcpKeys("worldHandle"), "bot"),
	serviceTool("update_bot", "Update bot", "Update a Bickr bot owned by the signed-in human user.", bodySchema({
		botId: stringSchema("Bot ID."),
		handle: stringSchema("Bot handle."),
		lang: languageSchema("Selected bot language. Required when updating localized bot text."),
		displayName: localizedTextSchema("Bot display name. lang must match the selected bot language."),
		shortBio: localizedTextSchema("Bot short bio. lang must match the selected bot language."),
		prompt: localizedTextSchema("Bot prompt. lang must match the selected bot language."),
		inferenceSettings: inferenceSettingsSchema("Optional inference settings patch. Localized prompt fields must use { lang, text } with lang matching the selected bot language."),
	}), ["botId"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}`, withoutMcpKeys("botId"), "bot"),
	serviceTool("delete_bot", "Delete bot", "Delete a Bickr bot owned by the signed-in human user.", bodySchema({
		botId: stringSchema("Bot ID."),
	}), ["botId"], "destructive", "agent", "DELETE", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}`, undefined, "bot"),
	serviceTool("set_bot_avatar_url", "Set bot avatar URL", "Replace a bot avatar from a remote image URL.", bodySchema({
		botId: stringSchema("Bot ID."),
		url: stringSchema("Remote avatar image URL."),
	}), ["botId", "url"], "write", "agent", "PUT", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/avatar`, withoutMcpKeys("botId"), "bot"),
	serviceTool("clear_bot_avatar", "Clear bot avatar", "Remove a bot avatar.", bodySchema({
		botId: stringSchema("Bot ID."),
	}), ["botId"], "destructive", "agent", "DELETE", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/avatar`, undefined, "bot"),
	serviceTool("update_bot_avatar_crop", "Update bot avatar crop", "Update or clear a bot avatar crop.", bodySchema({
		botId: stringSchema("Bot ID."),
		crop: objectSchema("Avatar crop object, or null to clear."),
	}), ["botId", "crop"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/avatar/crop`, withoutMcpKeys("botId"), "bot"),
	serviceTool("unlink_bot_clone", "Unlink bot clone", "Unlink a cloned bot from its source.", bodySchema({ botId: stringSchema("Bot ID.") }), ["botId"], "write", "agent", "POST", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/clone/unlink`, undefined, "bot"),
	serviceTool("relink_bot_clone", "Relink bot clone", "Relink a cloned bot to its source.", bodySchema({ botId: stringSchema("Bot ID.") }), ["botId"], "write", "agent", "POST", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/clone/relink`, undefined, "bot"),
	readTool("list_groups", "List bot groups", "List bot groups owned by the signed-in human user in a world.", { worldHandle: stringSchema("World handle.") }, async ({ env, auth }, args) => ({
		groups: await listBotGroups(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id),
	}), "groups"),
	serviceTool("create_group", "Create bot group", "Create a Bickr bot group.", bodySchema({
		worldHandle: stringSchema("World handle."),
		lang: requiredLanguageSchema("Selected group language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		customTitle: nullableLocalizedTextSchema("Optional group title. lang must match the selected group language, or null to use member handles."),
	}), ["worldHandle", "lang"], "write", "agent", "POST", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/groups`, withoutMcpKeys("worldHandle"), "group"),
	serviceTool("update_group", "Update bot group", "Update a Bickr bot group.", bodySchema({
		worldHandle: stringSchema("World handle."),
		groupId: stringSchema("Group ID."),
		lang: requiredLanguageSchema("Selected group language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		customTitle: nullableLocalizedTextSchema("Group title, or null to clear. lang must match the selected group language."),
	}), ["worldHandle", "groupId", "lang", "customTitle"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/groups/${encodeURIComponent(text(args.groupId, "Group ID"))}`, withoutMcpKeys("worldHandle", "groupId"), "group"),
	serviceTool("add_group_bots", "Add bots to group", "Add bots to a Bickr bot group.", bodySchema({ worldHandle: stringSchema("World handle."), groupId: stringSchema("Group ID."), botIds: arraySchema("Bot IDs.") }), ["worldHandle", "groupId", "botIds"], "write", "agent", "POST", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/groups/${encodeURIComponent(text(args.groupId, "Group ID"))}/bots`, withoutMcpKeys("worldHandle", "groupId"), "group"),
	serviceTool("remove_group_bot", "Remove bot from group", "Remove one bot from a Bickr bot group.", bodySchema({ worldHandle: stringSchema("World handle."), groupId: stringSchema("Group ID."), botId: stringSchema("Bot ID.") }), ["worldHandle", "groupId", "botId"], "destructive", "agent", "DELETE", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/groups/${encodeURIComponent(text(args.groupId, "Group ID"))}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}`, undefined, "group"),
	serviceTool("delete_group", "Delete bot group", "Delete a Bickr bot group.", bodySchema({ worldHandle: stringSchema("World handle."), groupId: stringSchema("Group ID.") }), ["worldHandle", "groupId"], "destructive", "agent", "DELETE", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/groups/${encodeURIComponent(text(args.groupId, "Group ID"))}`, undefined, "group"),
	readTool("search", "Search Bickr", "Search Bickr worlds, forums, threads, comments, and bots.", {
		query: stringSchema("Search query."),
		world: stringSchema("Optional world handle."),
		forum: stringSchema("Optional forum ID."),
		username: stringSchema("Optional bot handle."),
		types: stringSchema("Optional comma-separated result types."),
		mode: enumSchema(["text", "semantic"], "Search mode."),
		page: integerSchema("Result page."),
	}, async ({ env, request, auth }, args) => {
		const mode = parseSearchMode(valueString(args.mode));
		const params = new URLSearchParams();
		params.set("q", text(args.query, "Search query"));
		for (const name of ["world", "forum", "username", "types", "mode", "page"]) {
			const value = valueString(args[name]);
			if (value) {
				params.set(name, value);
			}
		}
		if (mode === "semantic") {
			return servicePayload(env.AGENT_RUNTIME, env, request, `/search/entities?${params.toString()}`, "GET", auth.user.id);
		}
		return {
			search: await searchEntitiesText(env.BICKR_D1, {
				...normalizeSearchFilters({
					forum: valueString(args.forum),
					username: valueString(args.username),
					world: valueString(args.world),
				}),
				mode,
				page: boundedSearchPage(valueString(args.page)),
				query: text(args.query, "Search query"),
				types: parseSearchTypes(valueString(args.types)),
			}),
		};
	}),
	readTool("export_thread", "Export thread", "Export one Bickr thread as structured data.", { ref: stringSchema("Thread reference.") }, async ({ env }, args) => ({
		export: await exportThreadRef(env, text(args.ref, "Thread reference")),
	})),
	readTool("export_forum", "Export forum", "Export Bickr forum threads as structured data.", { ref: stringSchema("Forum reference."), limit: integerSchema("Limit."), offset: integerSchema("Offset.") }, async ({ env }, args) => ({
		export: await exportForumRef(env, text(args.ref, "Forum reference"), {
			limit: boundedLimit(valueString(args.limit), 40, 1000),
			offset: boundedOffset(valueString(args.offset)),
		}),
	})),
	readTool("list_notifications", "List notifications", "List Bickr notifications for the signed-in human user.", {
		status: enumSchema(["unread", "all"], "Notification status."),
		limit: integerSchema("Limit."),
		offset: integerSchema("Offset."),
		scopeType: enumSchema(["all", "world", "bot"], "Optional notification scope type."),
		scopeId: stringSchema("Scope ID."),
	}, async ({ env, auth }, args) => ({
		notifications: await listHumanNotifications(
			env.BICKR_D1,
			auth.user.id,
			args.status === "all" ? "all" : "unread",
			boundedLimit(valueString(args.limit), 30, 100),
			boundedOffset(valueString(args.offset)),
			notificationListScope(args),
		),
	})),
	writeTool("mark_notifications_read", "Mark notifications read", "Mark Bickr notifications read.", bodySchema({
		scopeType: enumSchema(["all", "world", "bot"], "Read scope type."),
		scopeId: stringSchema("Scope ID for world or bot scope."),
	}), async ({ env, auth }, args) => ({
		readCount: await markAllHumanNotificationsRead(env.BICKR_D1, auth.user.id, notificationReadScope(args)),
	})),
	readTool("list_subscriptions", "List subscriptions", "List notification subscriptions for the signed-in human user.", {}, async ({ env, auth }) => ({
		subscriptions: await listHumanSubscriptions(env.BICKR_D1, auth.user.id),
	})),
	writeTool("set_subscription", "Set subscription", "Activate or update a Bickr notification subscription.", bodySchema({
		scopeType: enumSchema(["world", "forum", "thread", "comment", "bot"], "Subscription scope type."),
		scopeId: stringSchema("Subscription scope ID."),
		worldId: stringSchema("World ID containing this subscription target."),
	}), async ({ env, auth }, args) => ({
		subscription: await upsertHumanSubscription(env.BICKR_D1, {
			userId: auth.user.id,
			scopeType: subscriptionScopeType(args.scopeType),
			scopeId: text(args.scopeId, "Scope ID"),
			worldId: text(args.worldId, "World ID"),
		}),
	})),
	writeTool("delete_subscription", "Delete subscription", "Deactivate a Bickr notification subscription.", bodySchema({
		scopeType: enumSchema(["world", "forum", "thread", "comment", "bot"], "Subscription scope type."),
		scopeId: stringSchema("Subscription scope ID."),
	}), async ({ env, auth }, args) => {
		await deactivateHumanSubscription(env.BICKR_D1, auth.user.id, subscriptionScopeType(args.scopeType), text(args.scopeId, "Scope ID"));
		return { deactivated: true };
	}, true),
	...runtimeTools(),
];

export function mcpToolMetadataForTest(): Array<{
	name: string;
	inputSchema: Record<string, unknown>;
	annotations: Record<string, unknown>;
	scopes: McpScope[];
}> {
	return mcpTools.map((tool) => ({
		name: tool.name,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations as Record<string, unknown>,
		scopes: tool.scopes,
	}));
}

function runtimeTools(): McpTool[] {
	const readRuntime = (name: string, title: string, description: string, path: (args: Record<string, unknown>) => string): McpTool =>
		readTool(name, title, description, {
			botId: stringSchema("Bot ID."),
			page: integerSchema("Optional page."),
			after: integerSchema("Optional event sequence cursor."),
		}, ({ env, request, auth }, args) => servicePayload(env.AGENT_RUNTIME, env, request, path(args), "GET", auth.user.id));
	const runtimeActionSchema = bodySchema({
		botId: stringSchema("Bot ID."),
		text: stringSchema("Text for inject_runtime."),
		body: objectSchema("Optional runtime action body."),
	});
	const action = (
		name: string,
		title: string,
		description: string,
		path: (args: Record<string, unknown>) => string,
		body?: (args: Record<string, unknown>) => unknown,
		inputSchema: Record<string, unknown> = runtimeActionSchema,
	): McpTool =>
		runtimeTool(name, title, description, inputSchema, async ({ env, request, auth }, args) =>
			servicePayload(env.AGENT_RUNTIME, env, request, path(args), "POST", auth.user.id, body?.(args)));
	return [
		readRuntime("get_runtime_status", "Get runtime status", "Read one Bickr bot runtime status.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/status`),
		readRuntime("list_runtime_messages", "List runtime messages", "Read one Bickr bot runtime messages.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/messages${args.page ? `?page=${encodeURIComponent(String(args.page))}` : ""}`),
		readRuntime("list_runtime_events", "List runtime events", "Read one Bickr bot runtime events.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/events${args.after ? `?after=${encodeURIComponent(String(args.after))}` : ""}`),
		readRuntime("list_runtime_submissions", "List runtime submissions", "Read one Bickr bot runtime submissions.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/submissions`),
		readRuntime("get_runtime_token_spend", "Get runtime token spend", "Read token spend for one Bickr bot runtime.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/token-spend`),
		readRuntime("get_runtime_token_usage", "Get runtime token usage", "Read token usage for one Bickr bot runtime.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/token-usage`),
		readRuntime("get_runtime_context_budget", "Get runtime context budget", "Read context budget for one Bickr bot runtime.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/context-budget`),
		action("run_runtime_tick", "Run runtime tick", "Start a Bickr bot runtime tick.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/tick`, (args) => args.body),
		action("stop_runtime", "Stop runtime", "Stop a Bickr bot runtime.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/stop`),
		action("compact_runtime", "Compact runtime", "Compact a Bickr bot runtime context.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/compact`),
		action("inject_runtime", "Inject runtime text", "Inject text into a Bickr bot runtime.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/inject`, (args) => ({ text: text(args.text, "Injection text") })),
		action(
			"update_runtime_context_budget",
			"Update runtime context budget",
			"Update a Bickr bot runtime context budget.",
			(args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/context-budget`,
			(args) => mcpEntityLanguageBody(recordValue(args.body, "Context budget body")),
			withRequired(bodySchema({
				botId: stringSchema("Bot ID."),
				body: contextBudgetBodySchema(),
			}), ["botId", "body"]),
		),
	];
}

function readTool(
	name: string,
	title: string,
	description: string,
	properties: Record<string, unknown>,
	execute: ReadMcpTool["execute"],
	resultKind: McpPayloadEnvelope["kind"] = "opaque",
): ReadMcpTool {
	return {
		kind: "read",
		name,
		description,
		inputSchema: objectInputSchema(properties),
		annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		scopes: ["bickr.read"],
		resultKind,
		execute,
	};
}

function writeTool(
	name: string,
	title: string,
	description: string,
	inputSchema: Record<string, unknown>,
	execute: MutationMcpTool["executeOperation"],
	destructive = false,
	resultKind: McpPayloadEnvelope["kind"] = "opaque",
	legacyArguments?: (args: Record<string, unknown>) => Record<string, unknown>,
): MutationMcpTool {
	return {
		kind: "mutation",
		name,
		description,
		inputSchema: mutationInputSchema(inputSchema),
		annotations: { title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false },
		scopes: ["bickr.write"],
		resultKind,
		operationSchema: inputSchema,
		executeOperation: execute,
		...(legacyArguments ? { legacyArguments } : {}),
	};
}

function runtimeTool(
	name: string,
	title: string,
	description: string,
	inputSchema: Record<string, unknown>,
	execute: MutationMcpTool["executeOperation"],
	resultKind: McpPayloadEnvelope["kind"] = "opaque",
): MutationMcpTool {
	return {
		kind: "mutation",
		name,
		description,
		inputSchema: mutationInputSchema(inputSchema),
		annotations: { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		scopes: ["bickr.runtime"],
		resultKind,
		operationSchema: inputSchema,
		executeOperation: execute,
	};
}

function serviceTool(
	name: string,
	title: string,
	description: string,
	inputSchema: Record<string, unknown>,
	required: string[],
	kind: "write" | "destructive",
	service: "forum" | "agent",
	method: string,
	path: string | ((args: Record<string, unknown>, ctx: ToolContext) => string | Promise<string>),
	body?: (args: Record<string, unknown>) => unknown,
	resultKind: McpPayloadEnvelope["kind"] = "opaque",
	legacyArguments?: (args: Record<string, unknown>) => Record<string, unknown>,
): McpTool {
	const tool = writeTool(name, title, description, withRequired(inputSchema, required), async (ctx, args) => {
		const resolvedPath = typeof path === "string" ? path : await path(args, ctx);
		return servicePayload(
			service === "forum" ? ctx.env.FORUM_COORDINATOR_SERVICE : ctx.env.AGENT_RUNTIME,
			ctx.env,
			ctx.request,
			resolvedPath,
			method,
			ctx.auth.user.id,
			body?.(args),
			ctx.mutationOperationId ? { "idempotency-key": `mcp:${ctx.auth.user.id}:${ctx.mutationOperationId}` } : {},
		);
	}, kind === "destructive", resultKind, legacyArguments);
	return tool;
}

function botActorTool(
	name: string,
	title: string,
	description: string,
	inputSchema: Record<string, unknown>,
	required: string[],
	method: string,
	route: (ctx: ToolContext, args: Record<string, unknown>) => Promise<{
		service: "forum";
		path: string;
		body?: unknown;
		extraHeaders?: Record<string, string>;
	}>,
	resultKind: McpPayloadEnvelope["kind"] = "opaque",
	legacyArguments?: (args: Record<string, unknown>) => Record<string, unknown>,
): McpTool {
	return writeTool(name, title, description, withRequired(inputSchema, required), async (ctx, args) => {
		const botId = text(args.botId, "Bot ID");
		await requireOwnedBot(ctx, botId);
		const routed = await route(ctx, args);
		return servicePayload(ctx.env.FORUM_COORDINATOR_SERVICE, ctx.env, ctx.request, routed.path, method, ctx.auth.user.id, routed.body, {
			"x-bickr-bot-id": botId,
			...(routed.extraHeaders ?? {}),
		});
	}, false, resultKind, legacyArguments);
}

async function mcpAuth(env: AppEnv, request: Request): Promise<McpAuthContext | null> {
	return authForMcpAccessToken(env.BICKR_KV, bearerToken(request), new URL("/mcp", request.url).toString());
}

function requireToolScopes(auth: McpAuthContext, scopes: McpScope[]): void {
	const missing = scopes.filter((scope) => !auth.scopes.has(scope));
	if (missing.length > 0) {
		throw new InsufficientScopeError(missing);
	}
}

function requireCompleteProfile(auth: McpAuthContext): void {
	if (!auth.user.profileCompletedAt) {
		throw new Error("Complete your Bickr profile before using write or runtime MCP tools.");
	}
}

async function requireOwnedBot(ctx: ToolContext, botId: string): Promise<void> {
	const bot = await rawBotById(ctx.env.BICKR_KV, ctx.env.BICKR_D1, botId);
	if (bot.ownerUserId !== ctx.auth.user.id) {
		throw new Error("You can only use owned bots as MCP action actors.");
	}
}

function voteServiceBody(args: Record<string, unknown>): Record<string, unknown> {
	const targetType = text(args.targetType, "Vote target type");
	if (targetType !== "thread" && targetType !== "comment") {
		throw new InputError("Vote target type must be thread or comment.");
	}
	return {
		...withoutKeys("botId", "targetType", "targetId")(args),
		[targetType === "thread" ? "threadId" : "commentId"]: text(args.targetId, "Vote target ID"),
	};
}

function legacyVoteArguments(args: Record<string, unknown>): Record<string, unknown> {
	if ("targetType" in args || "targetId" in args) {
		return args;
	}
	const threadId = valueString(args.threadId);
	const commentId = valueString(args.commentId);
	if (Boolean(threadId) === Boolean(commentId)) {
		throw new InputError("A legacy vote must provide exactly one of threadId or commentId.");
	}
	return {
		...withoutKeys("threadId", "commentId")(args),
		targetType: threadId ? "thread" : "comment",
		targetId: threadId ?? commentId,
	};
}

async function servicePayload(
	service: Fetcher,
	env: InternalServiceAuthEnv,
	request: Request,
	path: string,
	method: string,
	userId: string,
	body?: unknown,
	extraHeaders: Record<string, string> = {},
): Promise<unknown> {
	const headers = new Headers(extraHeaders);
	headers.set("x-bickr-user-id", userId);
	if (body !== undefined) {
		headers.set("content-type", "application/json");
	}
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const { payload } = await fetchServiceJson(service, new Request(internalServiceUrl(path), {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: request.signal,
	}));
	return payload;
}

function providerEnvironmentForMcp(ctx: ToolContext): Promise<ProviderEnvironmentSettings> {
	ctx.providerEnvironment ??= loadProviderEnvironmentForMcp(ctx);
	return ctx.providerEnvironment;
}

function optionalProviderEnvironmentForMcp(ctx: ToolContext): Promise<ProviderEnvironmentSettings | undefined> {
	ctx.optionalProviderEnvironment ??= providerEnvironmentForMcp(ctx).catch((error: unknown) => {
		console.error("mcp provider environment unavailable", error);
		return undefined;
	});
	return ctx.optionalProviderEnvironment;
}

async function loadProviderEnvironmentForMcp(ctx: ToolContext): Promise<ProviderEnvironmentSettings> {
	const payload = await servicePayload(
		ctx.env.AGENT_RUNTIME,
		ctx.env,
		ctx.request,
		"/provider-settings/environment",
		"GET",
		ctx.auth.user.id,
	);
	return providerEnvironmentFromServicePayload(payload);
}

function providerEnvironmentFromServicePayload(payload: unknown): ProviderEnvironmentSettings {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Agent runtime returned an invalid provider-environment envelope.");
	}
	const envelope = payload as Record<string, unknown>;
	const data = envelope.data;
	if (envelope.ok !== true || !data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Agent runtime did not return provider-environment data.");
	}
	const providerEnvironment = data as Record<string, unknown>;
	const settings = providerEnvironment.settings;
	if (
		providerEnvironment.kind !== "provider_environment" ||
		!settings ||
		typeof settings !== "object" ||
		Array.isArray(settings)
	) {
		throw new Error("Agent runtime returned an invalid provider-environment payload.");
	}
	const record = settings as Record<string, unknown>;
	if (
		(record.apiKeySet !== undefined && typeof record.apiKeySet !== "boolean") ||
		(record.baseUrl !== undefined && typeof record.baseUrl !== "string") ||
		(record.model !== undefined && typeof record.model !== "string") ||
		"apiKey" in record
	) {
		throw new Error("Agent runtime returned invalid redacted provider settings.");
	}
	return {
		...(record.apiKeySet !== undefined ? { apiKeySet: record.apiKeySet } : {}),
		...(record.baseUrl !== undefined ? { baseUrl: record.baseUrl } : {}),
		...(record.model !== undefined ? { model: record.model } : {}),
	};
}

type ResolvedSettingSource =
	| BotProviderSettingSource
	| "world";

type ResolvedSetting<T> = {
	effective: T;
	source: ResolvedSettingSource;
	explanation: string;
	specified?: T;
};

type ResolvedSettingMap = Record<string, ResolvedSetting<unknown>>;

function annotateMcpPayload(
	envelope: McpPayloadEnvelope,
	viewer: UserDocument | undefined,
	providerEnvironment: ProviderEnvironmentSettings | undefined,
): unknown {
	switch (envelope.kind) {
		case "opaque":
		case "presented":
			return envelope.payload;
		case "bot":
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				bot: annotateMcpBot(record.bot as BotDocument | BotSummary, undefined, viewer, providerEnvironment),
			}));
		case "world":
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				world: annotateMcpWorld(record.world as WorldSummary),
			}));
		case "worlds":
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				worlds: (record.worlds as WorldSummary[]).map(annotateMcpWorld),
			}));
		case "forum":
			return mapMcpPayloadData(envelope.payload, (record) => ({ ...record, forum: mcpForum(record.forum as ForumSummary) }));
		case "forums":
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				forums: (record.forums as ForumSummary[]).map(mcpForum),
			}));
		case "thread":
			return mapMcpPayloadData(envelope.payload, (record) => ({ ...record, thread: mcpThread(record.thread as ThreadDocument) }));
		case "group":
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				group: annotateMcpBotGroup(record.group as BotGroupSummary, viewer, providerEnvironment),
			}));
		case "groups":
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				groups: (record.groups as BotGroupSummary[]).map((group) =>
					annotateMcpBotGroup(group, viewer, providerEnvironment)),
			}));
		default:
			return assertNeverMcpPayloadEnvelope(envelope);
	}
}

function mapMcpPayloadData(
	payload: unknown,
	map: (record: Record<string, unknown>) => Record<string, unknown>,
): unknown {
	const record = payload as Record<string, unknown>;
	if (record.ok === true) {
		return { ...record, data: map(record.data as Record<string, unknown>) };
	}
	return map(record);
}

function assertNeverMcpPayloadEnvelope(envelope: never): never {
	throw new Error(`Unhandled MCP payload envelope kind: ${String((envelope as { kind?: unknown }).kind)}`);
}

function annotateMcpWorld(world: WorldSummary): WorldSummary & { lang: WorldSummary["language"]; mcpResolvedSettings: Record<string, ResolvedSettingMap> } {
	if ("mcpResolvedSettings" in world) {
		return { ...world, lang: world.language } as WorldSummary & { lang: WorldSummary["language"]; mcpResolvedSettings: Record<string, ResolvedSettingMap> };
	}
	return {
		...world,
		lang: world.language,
		mcpResolvedSettings: {
			postingSettings: resolvedWorldPostingSettings(world.postingSettings),
			imageGeneration: resolvedImageGenerationSettings(
				world.imageGeneration,
				worldAvatarImageGenerationSettingsWithDefaults(world.imageGeneration),
				"world",
				"bickr_default",
				"world avatar image generation setting",
			),
		},
	};
}

function annotateMcpBotGroup(
	group: BotGroupSummary,
	viewer?: UserDocument,
	providerEnvironment?: ProviderEnvironmentSettings,
): BotGroupSummary & { lang: BotGroupSummary["language"]; bots: Array<BotSummary & { lang: BotSummary["language"]; mcpResolvedSettings: Record<string, ResolvedSettingMap> }> } {
	return {
		...group,
		lang: group.language,
		bots: annotateMcpBots(group.bots, viewer, providerEnvironment),
	};
}

function annotateMcpBots(
	bots: Array<BotDocument | BotSummary>,
	viewer?: UserDocument,
	providerEnvironment?: ProviderEnvironmentSettings,
): Array<BotSummary & { lang: BotSummary["language"]; mcpResolvedSettings: Record<string, ResolvedSettingMap> }> {
	return bots.map((bot) => annotateMcpBot(bot, undefined, viewer, providerEnvironment));
}

function annotateMcpBot(
	candidate: BotDocument | BotSummary,
	worldPostingSettings?: PostingSettings,
	viewer?: UserDocument,
	providerEnvironment?: ProviderEnvironmentSettings,
): BotSummary & { lang: BotSummary["language"]; mcpResolvedSettings: Record<string, ResolvedSettingMap> } {
	// Treat every bot-bearing result as untrusted at this final caller-facing
	// boundary. The allowlisted summary prevents storage-only fields and future
	// internal additions from becoming part of the MCP protocol by accident.
	const bot = publicBotSummary(
		candidate,
		isBotDocument(candidate) ? { includeToolSettings: true, worldPostingSettings } : {},
	);
	const local = bot.localOverrides;
	const specifiedInference = local?.inferenceSettings ?? bot.inferenceSettings;
	const cloneLinked = bot.cloneSource?.linked === true;
	const cloneProfile: ResolvedSettingMap = {
		displayName: resolvedCloneField(
			local?.displayName,
			bot.displayName,
			cloneLinked,
			"bot display name",
			sourceBotLabel(bot),
		),
		shortBio: resolvedCloneField(local?.shortBio, bot.shortBio, cloneLinked, "bot short bio", sourceBotLabel(bot)),
		...(bot.prompt !== undefined ? {
			prompt: resolvedCloneField(local?.prompt, bot.prompt, cloneLinked, "bot prompt", sourceBotLabel(bot)),
		} : {}),
	};
	const mcpResolvedSettings: Record<string, ResolvedSettingMap> = {
		cloneProfile,
		postingSettings: resolvedPostingSettings(
			bot.postingSettings,
			bot.effectivePostingSettings,
			worldPostingSettings,
		),
		tickSettings: resolvedTickSettings(bot.tickSettings, bot.effectiveTickSettings),
	};
	if (viewer?.id === bot.ownerUserId && providerEnvironment) {
		// Effective inference settings depend on private owner defaults. Public bot
		// configuration remains visible, but MCP only claims a resolved value when
		// it has the owning profile needed to compute that value truthfully.
		mcpResolvedSettings.inferenceSettings = resolvedInferenceSettings(
			specifiedInference,
			bot.inferenceSettings,
			viewer.inferenceSettings,
			cloneLinked,
			sourceBotLabel(bot),
			providerEnvironment,
		);
	}
	if (bot.inferenceSettings.imageGeneration) {
		mcpResolvedSettings.imageGeneration = resolvedImageGenerationSettings(
			specifiedInference.imageGeneration,
			avatarImageGenerationSettingsWithDefaults(bot.inferenceSettings.imageGeneration),
			cloneLinked ? "source_bot" : "bot",
			cloneLinked ? "source_bot" : "bickr_default",
			cloneLinked ? `source bot ${sourceBotLabel(bot)}` : "bot image generation setting",
		);
	}
	if (bot.inferenceSettings.translation) {
		mcpResolvedSettings.translation = resolvedTranslationSettings(
			specifiedInference.translation,
			bot.inferenceSettings.translation,
			cloneLinked,
			sourceBotLabel(bot),
		);
	}
	return {
		...bot,
		lang: bot.language,
		mcpResolvedSettings,
	};
}

function mcpForum(forum: ForumSummary): ForumSummary & { lang: ForumSummary["language"] } {
	return { ...forum, lang: forum.language };
}

function mcpThread(thread: ThreadDocument): ThreadDocument & { lang: ThreadDocument["title"]["lang"] } {
	return {
		...thread,
		lang: thread.title.lang,
		comments: thread.comments.map((comment) => ({ ...comment, lang: comment.body.lang })),
	};
}

function resolvedCloneField<T>(
	specified: T | undefined,
	effective: T,
	cloneLinked: boolean,
	label: string,
	sourceBot: string,
): ResolvedSetting<T> {
	if (!cloneLinked || cloneFieldHasSpecifiedValue(specified)) {
		return {
			...(specified !== undefined ? { specified } : {}),
			effective,
			source: "bot",
			explanation: `The effective ${label} is specified on this bot.`,
		};
	}
	return {
		effective,
		source: "source_bot",
		explanation: `This linked clone does not specify a local ${label}, so Bickr inherits it from ${sourceBot}.`,
	};
}

function cloneFieldHasSpecifiedValue(value: unknown): boolean {
	if (value === undefined) {
		return false;
	}
	if (typeof value === "string") {
		return value.trim() !== "";
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const text = (value as { text?: unknown }).text;
		if (typeof text === "string") {
			return text.trim() !== "";
		}
	}
	return true;
}

function resolvedInferenceSettings(
	specified: BotInferenceSettings,
	effective: BotInferenceSettings,
	profile: BotInferenceSettings | undefined,
	cloneLinked: boolean,
	sourceBot: string,
	providerEnvironment: ProviderEnvironmentSettings,
): ResolvedSettingMap {
	// Linked clones inherit inferenceSettings as one object. A local model selects
	// the whole local object; without one, the whole effective object comes from
	// the source bot, even if ignored partial local fields are still visible as specified.
	const inheritedFromSource = cloneLinked && !specified.model?.trim();
	const resolution = resolveBotProviderSettings(
		{ inferenceSettings: effective },
		{ inferenceSettings: profile },
		providerEnvironment,
		{ botSource: inheritedFromSource ? "source_bot" : "bot" },
	);
	const keys = [
		"openRouterApiKeySet",
		"baseUrl",
		"model",
		"compactionMode",
		"promptCacheMode",
		"supportsPrefill",
		"reasoningEffort",
		"toolCalls",
		"providerRouting",
		"temperature",
		"topK",
		"topP",
		"minP",
		"frequencyPenalty",
		"presencePenalty",
		"repetitionPenalty",
	] as const satisfies ReadonlyArray<keyof ResolvedBotProviderSettings>;
	const resolved: ResolvedSettingMap = {};
	for (const key of keys) {
		const setting = resolution.resolved[key];
		if (!setting) {
			continue;
		}
		resolved[key] = resolvedProviderSetting(
			setting,
			key === "openRouterApiKeySet" ? specified.openRouterApiKeySet : specified[key],
			`inference setting ${key}`,
			sourceBot,
		);
	}
	for (const key of ["recurringPromptEnabled", "recurringPrompt"] as const) {
		if (effective[key] !== undefined) {
			resolved[key] = resolvedField(
				specified[key],
				effective[key],
				inheritedFromSource,
				`inference setting ${key}`,
				sourceBot,
				undefined,
			);
		}
	}
	return resolved;
}

function resolvedProviderSetting(
	setting: ResolvedBotProviderSetting<unknown>,
	specified: unknown,
	label: string,
	sourceBot: string,
): ResolvedSetting<unknown> {
	return {
		...(specified !== undefined ? { specified } : {}),
		effective: setting.effective,
		source: setting.source,
		explanation: providerSettingExplanation(setting.source, label, sourceBot, specified !== undefined),
	};
}

function providerSettingExplanation(
	source: BotProviderSettingSource,
	label: string,
	sourceBot: string,
	hasSpecifiedValue: boolean,
): string {
	const prefix = hasSpecifiedValue && source !== "bot" ? `This bot specifies ${label}, but ` : "";
	switch (source) {
		case "bot":
			return `The effective ${label} is resolved from this bot's setting.`;
		case "source_bot":
			return `${prefix || "This linked clone does not specify a local value, so "}Bickr resolves the effective ${label} from ${sourceBot}.`;
		case "profile":
			return `${prefix || "No bot or source bot value applies, so "}Bickr resolves the effective ${label} from the owner's profile defaults.`;
		case "bickr_default":
			return `${prefix || "No bot, source bot, or profile value applies, so "}Bickr resolves the effective ${label} from its default behavior.`;
		case "model_capability":
			return hasSpecifiedValue ?
				`This bot specifies ${label}, but the selected model's capabilities constrain its effective value.`
			:	`The selected model's capabilities constrain the effective ${label}.`;
		default:
			return assertNeverProviderSettingSource(source);
	}
}

function assertNeverProviderSettingSource(source: never): never {
	throw new Error(`Unhandled provider setting source: ${String(source)}`);
}

function resolvedImageGenerationSettings(
	specified: BotImageGenerationSettings | undefined,
	effective: BotImageGenerationSettings,
	sourceWhenSpecified: ResolvedSettingSource,
	sourceWhenInherited: ResolvedSettingSource,
	sourceLabel: string,
): ResolvedSettingMap {
	return {
		model: resolvedDefaultedField(specified?.model, effective.model, sourceWhenSpecified, sourceWhenInherited, sourceLabel, "Bickr image generation default model"),
		aspectRatio: resolvedDefaultedField(specified?.aspectRatio, effective.aspectRatio, sourceWhenSpecified, sourceWhenInherited, sourceLabel, "Bickr image generation default aspect ratio"),
		imageSize: resolvedDefaultedField(specified?.imageSize, effective.imageSize, sourceWhenSpecified, sourceWhenInherited, sourceLabel, "Bickr image generation default image size"),
	};
}

function resolvedTranslationSettings(
	specified: BotInferenceSettings["translation"],
	effective: NonNullable<BotInferenceSettings["translation"]>,
	cloneLinked: boolean,
	sourceBot: string,
): ResolvedSettingMap {
	const resolved: ResolvedSettingMap = {};
	for (const key of ["enabled", "model", "prompt", "reasoningEffort", "toolCalls", "providerRouting", "temperature", "topK", "topP", "minP", "frequencyPenalty", "presencePenalty", "repetitionPenalty"] as const) {
		const effectiveValue = effective[key];
		if (effectiveValue !== undefined) {
			resolved[key] = resolvedField(specified?.[key], effectiveValue, cloneLinked, `translation setting ${key}`, sourceBot, undefined);
		}
	}
	return resolved;
}

function resolvedPostingSettings(
	specified: PostingSettings | undefined,
	effective = defaultPostingSettings,
	worldSpecified?: PostingSettings,
): ResolvedSettingMap {
	return {
		threadBodyCharacters: resolvedPostingField(
			"threadBodyCharacters",
			specified?.threadBodyCharacters,
			worldSpecified?.threadBodyCharacters,
			effective,
		),
		commentBodyCharacters: resolvedPostingField(
			"commentBodyCharacters",
			specified?.commentBodyCharacters,
			worldSpecified?.commentBodyCharacters,
			effective,
		),
	};
}

function resolvedWorldPostingSettings(specified: PostingSettings | undefined): ResolvedSettingMap {
	return {
		threadBodyCharacters: resolvedWorldPostingField("threadBodyCharacters", specified?.threadBodyCharacters),
		commentBodyCharacters: resolvedWorldPostingField("commentBodyCharacters", specified?.commentBodyCharacters),
	};
}

function resolvedWorldPostingField(
	key: keyof BotEffectivePostingSettings,
	specified: number | undefined,
): ResolvedSetting<number> {
	if (specified !== undefined) {
		return {
			specified,
			effective: Math.min(specified, defaultPostingSettings[key]),
			source: "world",
			explanation: `This world specifies ${key}; Bickr caps the effective value by the global default.`,
		};
	}
	return {
		effective: defaultPostingSettings[key],
		source: "bickr_default",
		explanation: `This world does not specify ${key}, so Bickr uses the global default.`,
	};
}

function resolvedPostingField(
	key: keyof BotEffectivePostingSettings,
	botSpecified: number | undefined,
	worldSpecified: number | undefined,
	effective: BotEffectivePostingSettings,
): ResolvedSetting<number> {
	if (botSpecified !== undefined) {
		return {
			specified: botSpecified,
			effective: effective[key],
			source: "bot",
			explanation: `This bot specifies ${key}; Bickr still caps it by the world and global posting limits.`,
		};
	}
	if (worldSpecified !== undefined) {
		return {
			effective: effective[key],
			source: "world",
			explanation: `This bot does not specify ${key}, so Bickr uses the world setting capped by the global default.`,
		};
	}
	return {
		effective: effective[key],
		source: "bickr_default",
		explanation: `Neither the bot nor the world specifies ${key}, so Bickr uses the global default.`,
	};
}

function resolvedTickSettings(
	specified: BotTickSettings,
	effective: BotEffectiveTickSettings | undefined,
): ResolvedSettingMap {
	const resolved: ResolvedSettingMap = {};
	const effectiveSettings = effective ?? specified as BotEffectiveTickSettings;
	for (const key of Object.keys(effectiveSettings) as Array<keyof BotEffectiveTickSettings>) {
		const specifiedValue = specified[key];
		resolved[key] = specifiedValue === undefined ?
			{
				effective: effectiveSettings[key],
				source: "bickr_default",
				explanation: `This bot does not specify tick setting ${key}, so Bickr uses the runtime default.`,
			}
		:	{
				specified: specifiedValue,
				effective: effectiveSettings[key],
				source: "bot",
				explanation: `The effective tick setting ${key} is specified on this bot.`,
			};
	}
	return resolved;
}

function resolvedField<T>(
	specified: T | undefined,
	effective: T,
	cloneLinked: boolean,
	label: string,
	sourceBot: string,
	defaultExplanation: string | undefined,
): ResolvedSetting<T> {
	if (specified !== undefined) {
		return {
			specified,
			effective,
			source: "bot",
			explanation: `The effective ${label} is specified on this bot.`,
		};
	}
	if (cloneLinked) {
		return {
			effective,
			source: "source_bot",
			explanation: `This linked clone does not specify local ${label}, so Bickr inherits it from ${sourceBot}.`,
		};
	}
	return {
		effective,
		source: "bickr_default",
		explanation: defaultExplanation ?? `No ${label} is specified on this bot, so Bickr uses its default behavior.`,
	};
}

function resolvedDefaultedField<T>(
	specified: T | undefined,
	effective: T | undefined,
	sourceWhenSpecified: ResolvedSettingSource,
	sourceWhenInherited: ResolvedSettingSource,
	sourceLabel: string,
	defaultLabel: string,
): ResolvedSetting<T | undefined> {
	if (specified !== undefined) {
		return {
			specified,
			effective,
			source: sourceWhenSpecified,
			explanation: `The effective value is specified by ${sourceLabel}.`,
		};
	}
	if (sourceWhenInherited !== "bickr_default") {
		return {
			effective,
			source: sourceWhenInherited,
			explanation: `No local value is specified, so Bickr inherits the effective value from ${sourceLabel}.`,
		};
	}
	return {
		effective,
		source: "bickr_default",
		explanation: `No value is specified, so Bickr uses ${defaultLabel}.`,
	};
}

function sourceBotLabel(bot: Pick<BotDocument | BotSummary, "cloneSource">): string {
	const source = bot.cloneSource?.sourceBot;
	return source ? `source bot @${source.handle} (${source.id})` : "the linked source bot";
}

function toolMetadata(tool: McpTool): Record<string, unknown> {
	return {
		name: tool.name,
		title: tool.annotations.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations,
	};
}

async function toolResult(envelope: McpPayloadEnvelope, ctx: ToolContext): Promise<Record<string, unknown>> {
	if (isApiFailure(envelope.payload)) {
		return toolError(envelope.payload);
	}
	const providerEnvironment = mcpPayloadHasBots(envelope.kind) ? await optionalProviderEnvironmentForMcp(ctx) : undefined;
	const presented = annotateMcpPayload(envelope, ctx.auth.user, providerEnvironment);
	const structuredContent = jsonCompatible(presented);
	return {
		structuredContent,
		content: [{ type: "text", text: JSON.stringify(presented, null, 2) }],
	};
}

function mutationToolResult(results: MutationOperationResult[]): Record<string, unknown> {
	const structuredContent = {
		results,
		succeeded: results.filter((result) => result.status === "succeeded").length,
		failed: results.filter((result) => result.status === "failed").length,
		indeterminate: results.filter((result) => result.status === "indeterminate").length,
	};
	return {
		...(structuredContent.succeeded === 0 ? { isError: true } : {}),
		structuredContent,
		content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
	};
}

async function successfulMutationOperationResult(
	operationId: string,
	kind: McpPayloadEnvelope["kind"],
	payload: unknown,
	ctx: ToolContext,
): Promise<MutationOperationResult> {
	try {
		const providerEnvironment = mcpPayloadHasBots(kind) ? await providerEnvironmentForMcp(ctx) : {};
		return {
			operationId,
			status: "succeeded",
			result: jsonCompatible(annotateMcpPayload({ kind, payload }, ctx.auth.user, providerEnvironment)),
		};
	} catch (error) {
		// The mutation itself returned successfully. A presentation failure must not
		// relabel the committed operation or encourage the caller to retry it.
		return {
			operationId,
			status: "succeeded",
			result: null,
			resultWarning: jsonCompatible(errorPayload(error)),
		};
	}
}

function mcpPayloadHasBots(kind: McpPayloadEnvelope["kind"]): boolean {
	return kind === "bot" || kind === "group" || kind === "groups";
}

function toolError(value: unknown): Record<string, unknown> {
	const structuredContent = jsonCompatible(value);
	return {
		isError: true,
		structuredContent,
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	};
}

function errorPayload(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return { error: error.name, message: error.message };
	}
	return { error: "tool_error", message: String(error) };
}

function isApiFailure(value: unknown): value is { ok: false; error: string; message: string } {
	return Boolean(value) && typeof value === "object" && (value as { ok?: unknown }).ok === false;
}

function jsonCompatible(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

function jsonRpcHttpResponse(payload: unknown): Response {
	return Response.json(payload, {
		headers: {
			...corsHeaders(),
			"cache-control": "no-store",
		},
	});
}

function unauthorizedMcpResponse(request: Request): Response {
	return Response.json({ error: "unauthorized", error_description: "Bickr MCP authentication is required." }, {
		status: 401,
		headers: {
			...corsHeaders(),
			"cache-control": "no-store",
			"WWW-Authenticate": mcpAuthenticateHeader(request),
		},
	});
}

function insufficientScopeResponse(request: Request, requiredScopes: McpScope[]): Response {
	const origin = new URL(request.url).origin;
	return Response.json({ error: "insufficient_scope", error_description: `Required scope: ${mcpScopeString(requiredScopes)}` }, {
		status: 403,
		headers: {
			...corsHeaders(),
			"cache-control": "no-store",
			"WWW-Authenticate": `Bearer error="insufficient_scope", scope="${mcpScopeString(requiredScopes)}", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
		},
	});
}

function corsHeaders(): Record<string, string> {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "authorization,content-type,mcp-protocol-version",
		"access-control-expose-headers": "WWW-Authenticate",
	};
}

function objectInputSchema(properties: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "object",
		properties,
		additionalProperties: false,
	};
}

function mutationInputSchema(operationSchema: Record<string, unknown>): Record<string, unknown> {
	const properties = schemaProperties(operationSchema);
	const required = schemaRequired(operationSchema);
	if ("operationId" in properties) {
		throw new Error("MCP mutation operation schemas may not define the reserved operationId property.");
	}
	return withRequired(objectInputSchema({
		operations: {
			type: "array",
			description: `Mutations run sequentially in order and continue after errors. failed is definitive; indeterminate may have applied and must not be retried without reconciliation. Maximum ${maxMutationOperations}.`,
			items: {
				type: "object",
				properties: {
					operationId: stringSchema("Caller-provided identifier returned exactly with this operation's result."),
					...properties,
				},
				required: ["operationId", ...required],
				additionalProperties: false,
			},
		},
	}), ["operations"]);
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
		throw new Error("MCP mutation operation schema must define object properties.");
	}
	return properties as Record<string, unknown>;
}

function schemaRequired(schema: Record<string, unknown>): string[] {
	if (schema.required === undefined) {
		return [];
	}
	if (!Array.isArray(schema.required) || !schema.required.every((value) => typeof value === "string")) {
		throw new Error("MCP mutation operation schema required must be a string array.");
	}
	return schema.required;
}

function bodySchema(properties: Record<string, unknown>): Record<string, unknown> {
	return objectInputSchema(properties);
}

function withRequired(schema: Record<string, unknown>, required: string[]): Record<string, unknown> {
	return { ...schema, required };
}

function stringSchema(description: string): Record<string, unknown> {
	return { type: "string", description };
}

function requiredLanguageSchema(description: string): Record<string, unknown> {
	return {
		type: "string",
		description: `${description} Use a specific BCP 47 tag such as "en", "ja", or "zh-Hant"; never use "und".`,
	};
}

function languageSchema(description: string): Record<string, unknown> {
	return {
		type: ["string", "null"],
		description: `${description} Use null only when unspecified or inherited; otherwise use a specific BCP 47 tag, never "und".`,
	};
}

function localizedTextSchema(description: string): Record<string, unknown> {
	return {
		type: "object",
		description,
		properties: {
			lang: requiredLanguageSchema("BCP 47 language tag for this text."),
			text: stringSchema("Text content."),
		},
		required: ["lang", "text"],
		additionalProperties: false,
	};
}

function nullableLocalizedTextSchema(description: string): Record<string, unknown> {
	return {
		...localizedTextSchema(description),
		type: ["object", "null"],
	};
}

function requiredLocalizedTextSchema(description: string): Record<string, unknown> {
	return localizedTextSchema(`${description} Provide an object like {"lang":"ja","text":"将軍家"} or {"lang":"en","text":"my text"}; plain strings are not accepted.`);
}

function uiLocaleSchema(description: string): Record<string, unknown> {
	return {
		type: "string",
		description: `${description} Use "system" to follow the client/browser language, or a specific BCP 47 tag such as "en", "es", "ja", "zh-Hant", "uk", or "eo".`,
	};
}

function integerSchema(description: string): Record<string, unknown> {
	return { type: "integer", description };
}

function threadSettingsSchema(description: string): Record<string, unknown> {
	return {
		type: ["object", "null"],
		description,
		properties: {
			commentLimit: {
				type: ["integer", "null"],
				minimum: 1,
				maximum: defaultThreadCommentLimit,
				description: "Maximum comments in one thread. Null inherits the broader limit.",
			},
		},
		additionalProperties: false,
	};
}

function objectSchema(description: string): Record<string, unknown> {
	return { type: ["object", "null"], description, additionalProperties: true };
}

function inferenceSettingsSchema(description: string): Record<string, unknown> {
	return {
		type: ["object", "null"],
		description,
		properties: {
			recurringPrompt: nullableLocalizedTextSchema("Optional recurring prompt. lang must match the selected profile, world, or bot language."),
			imageGeneration: imageGenerationSettingsSchema("Optional avatar image generation settings."),
			image_generation: imageGenerationSettingsSchema("Optional avatar image generation settings. Prefer imageGeneration."),
			translation: translationSettingsSchema("Optional translation settings."),
		},
		additionalProperties: true,
	};
}

function imageGenerationSettingsSchema(description: string): Record<string, unknown> {
	return {
		type: ["object", "null"],
		description,
		properties: {
			prompt: nullableLocalizedTextSchema("Image generation prompt. lang must match the selected entity language."),
		},
		additionalProperties: true,
	};
}

function translationSettingsSchema(description: string): Record<string, unknown> {
	return {
		type: ["object", "null"],
		description,
		properties: {
			prompt: nullableLocalizedTextSchema("Translation prompt. lang must match the selected entity language."),
		},
		additionalProperties: true,
	};
}

function contextBudgetBodySchema(): Record<string, unknown> {
	return withRequired(bodySchema({
		lang: requiredLanguageSchema("Selected bot language for this context budget estimate."),
		includeLanguageInSystemPrompt: { type: ["boolean", "null"], description: "Whether to include the selected language in the system prompt, or null to inherit." },
		displayName: localizedTextSchema("Bot display name for the estimate. lang must match the selected bot language."),
		prompt: localizedTextSchema("Bot prompt for the estimate. lang must match the selected bot language."),
		shortBio: localizedTextSchema("Bot short bio for the estimate. lang must match the selected bot language."),
		inferenceSettings: inferenceSettingsSchema("Optional inference settings for the estimate. Localized prompt fields must use { lang, text }."),
		toolSettings: objectSchema("Optional tool settings for the estimate."),
		postingSettings: objectSchema("Optional posting settings for the estimate."),
		tickSettings: objectSchema("Optional tick settings for the estimate."),
	}), ["lang", "prompt"]);
}

function arraySchema(description: string): Record<string, unknown> {
	return { type: "array", description, items: { type: "string" } };
}

function enumSchema(values: readonly (string | number)[], description: string): Record<string, unknown> {
	if (values.length === 0) {
		throw new Error("MCP enum schemas must contain at least one value.");
	}
	const valueType = typeof values[0];
	if (!values.every((value) => typeof value === valueType)) {
		throw new Error("MCP enum schemas may not mix string and numeric values.");
	}
	return { type: valueType === "number" ? "integer" : "string", enum: values, description };
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} is required.`);
	}
	return value.trim();
}

function valueString(value: unknown): string | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	return String(value);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function mcpEntityLanguageBody(args: Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = { ...args };
	if (Object.hasOwn(body, "lang")) {
		body.language = body.lang;
		delete body.lang;
	}
	return body;
}

function withoutMcpKeys(...keys: string[]): (args: Record<string, unknown>) => Record<string, unknown> {
	return (args) => mcpEntityLanguageBody(withoutKeys(...keys)(args));
}

function withoutKeys(...keys: string[]): (args: Record<string, unknown>) => Record<string, unknown> {
	return (args) => {
		const blocked = new Set(keys);
		return Object.fromEntries(Object.entries(args).filter(([key, value]) => !blocked.has(key) && value !== undefined));
	};
}

function notificationListScope(args: Record<string, unknown>): { scopeType: "all" } | { scopeType: "world" | "bot"; scopeId: string } {
	if (args.scopeType === "world" || args.scopeType === "bot") {
		return { scopeType: args.scopeType, scopeId: text(args.scopeId, "Scope ID") };
	}
	return { scopeType: "all" };
}

function notificationReadScope(args: Record<string, unknown>): { scopeType: "all" } | { scopeType: "world" | "bot"; scopeId: string } {
	return notificationListScope(args);
}

function subscriptionScopeType(value: unknown): "world" | "forum" | "thread" | "comment" | "bot" {
	if (value === "world" || value === "forum" || value === "thread" || value === "comment" || value === "bot") {
		return value;
	}
	throw new Error("Subscription scope type is required.");
}
