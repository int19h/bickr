import { parseAccountMutationResult } from "@bickr/shared/account-mutation-protocol";
import {
	inferenceConfigurationFields,
	inferenceFieldOverrideStates,
	isNumericInferenceField,
	numericInferenceFieldDomains,
	type CanonicalInferenceAnnotation,
	type CanonicalInferenceAnnotationSet,
} from "@bickr/shared/inference-configuration-owner";
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
	type BotDocument,
	type BotGroupSummary,
	type BotInferenceSettings,
	type BotSummary,
	type BotTickSettings,
	type BotEffectiveTickSettings,
	type BotEffectivePostingSettings,
	type PostingSettings,
	type SearchResponse,
	type ForumSummary,
	type ThreadDocument,
	type UpdateBotInput,
	type WorldSummary,
} from "@bickr/shared/model";
import { defaultPostingSettings } from "@bickr/shared/posting";
import { defaultThreadCommentLimit } from "@bickr/shared/thread-policy";
import {
	botById,
	listBotGroupsPage,
	listForums,
	listOwnedWorldsPage,
	listUserAuthIdentities,
	listUserBots,
	listWorldBots,
	listWorldsPage,
	rawBotById,
	isBotDocument,
	publicBotSummary,
	RepositoryError,
	userProfile,
	worldByHandle,
	worldPostingSettingsByIds,
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
	outputSchema?: Record<string, unknown>;
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
	| { kind: "profile"; payload: unknown }
	| { kind: "bots"; payload: unknown }
	| { kind: "search"; payload: unknown }
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
				validateMcpInput(args, tool.inputSchema, "Arguments");
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

// Operations in one bulk mutation run serially and most of them cross a service
// boundary, so the request's wall-clock cost grows linearly with this number.
// Twenty keeps the worst case inside connector and client response timeouts.
// The same constant drives the published envelope description and the
// pre-dispatch check, so a client can never be told a limit the server rejects.
const maxMutationOperations = 20;

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
			validateMcpInput(legacyArguments, tool.operationSchema, "Arguments");
			const result = await tool.executeOperation(ctx, legacyArguments);
			if (isApiFailure(result)) return toolError(result);
			try {
				return await toolResult({ kind: tool.resultKind, payload: result }, ctx);
			} catch (error) {
				return successfulSingletonMutationWithWarning(error);
			}
		}
		const operations = mutationOperations(args, tool.operationSchema);
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
		validateMcpInput(operationArguments, operationSchema, `Operation ${index + 1}`);
		return { operationId, arguments: operationArguments };
	});
}

function validateMcpInput(value: unknown, schema: Record<string, unknown>, label: string): void {
	if (value === null) return;
	const properties = schema.properties;
	if (properties && typeof properties === "object" && !Array.isArray(properties)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new InputError(`${label} must be an object.`);
		}
		const record = value as Record<string, unknown>;
		const allowed = properties as Record<string, unknown>;
		const unexpected = Object.keys(record).find((key) => !(key in allowed));
		if (unexpected) throw new InputError(`${label} contains unsupported argument ${unexpected}.`);
		for (const [key, child] of Object.entries(record)) {
			const childSchema = allowed[key];
			if (childSchema && typeof childSchema === "object" && !Array.isArray(childSchema)) {
				validateMcpInput(child, childSchema as Record<string, unknown>, `${label}.${key}`);
			}
		}
	}
}

function assertNeverMcpTool(tool: never): never {
	throw new Error(`Unhandled MCP tool kind: ${String((tool as { kind?: unknown }).kind)}`);
}

const mcpTools: McpTool[] = [
	readTool("get_profile", "Get profile", "Read the signed-in human user's Bickr profile.", {}, async ({ env, auth }) => {
		const profile = userProfile(auth.user, await listUserAuthIdentities(env.BICKR_D1, auth.user.id));
		return { profile };
	}, "profile"),
	writeTool("update_profile", "Update profile", "Update the signed-in human user's Bickr profile.", bodySchema({
		handle: stringSchema("Profile handle."),
		lang: languageSchema("Selected profile language. Required when displayName is provided."),
		displayName: localizedTextSchema("Profile display name. lang must match the selected profile language."),
		uiLocale: uiLocaleSchema("UI language preference."),
		inferenceSettings: profilePromptInferenceSettingsSchema("Profile-owned Translation toggle/prompt and account avatar prompt."),
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
	}, "write", "profile"),
	readTool("list_worlds", "List worlds", "List one bounded page of public Bickr worlds. Concurrent updates may move a world across a page boundary.", {
		limit: integerSchema("Page size, from 1 through 100 (default 100)."),
		cursor: stringSchema("Opaque keyset cursor returned by the previous page."),
	}, async ({ env }, args) => listWorldsPage(env.BICKR_D1, mcpCollectionPage(args)), "worlds"),
	readTool("list_my_worlds", "List my worlds", "List one bounded page of Bickr worlds owned by the signed-in account. Concurrent updates may move a world across a page boundary.", {
		limit: integerSchema("Page size, from 1 through 100 (default 100)."),
		cursor: stringSchema("Opaque keyset cursor returned by the previous page."),
	}, async ({ env, auth }, args) => listOwnedWorldsPage(env.BICKR_D1, auth.user.id, mcpCollectionPage(args)), "worlds"),
	serviceTool("create_world", "Create world", "Create a Bickr world.", bodySchema({
		handle: stringSchema("World handle."),
		lang: requiredLanguageSchema("Selected world language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		name: localizedTextSchema("World name. lang must match the selected world language."),
		description: localizedTextSchema("World description. lang must match the selected world language."),
		prompt: localizedTextSchema("World prompt. lang must match the selected world language."),
		recurringPromptEnabled: { type: "boolean", description: "Whether the recurring world prompt is enabled." },
		recurringPrompt: localizedTextSchema("Recurring world prompt. lang must match the selected world language."),
		imageGeneration: promptOnlyImageGenerationSchema("World avatar prompt."),
		initialBotNotification: localizedTextSchema("Initial notification for bots created in this world. lang must match the selected world language."),
		threadSettings: threadSettingsSchema("Optional thread policy. The smaller global, world, or forum comment limit wins."),
	}), ["handle", "lang", "name", "description"], "write", "agent", "POST", (_args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds`, mcpEntityLanguageBody, "world"),
	serviceTool("update_world", "Update world", "Update a Bickr world owned by the signed-in human user.", bodySchema({
		worldHandle: stringSchema("Current world handle."),
		handle: stringSchema("New world handle."),
		lang: languageSchema("Selected world language. Required when updating localized world text."),
		name: localizedTextSchema("World name. lang must match the selected world language."),
		description: localizedTextSchema("World description. lang must match the selected world language."),
		prompt: localizedTextSchema("World prompt. lang must match the selected world language."),
		recurringPromptEnabled: { type: "boolean", description: "Whether the recurring world prompt is enabled." },
		recurringPrompt: localizedTextSchema("Recurring world prompt. lang must match the selected world language."),
		imageGeneration: promptOnlyImageGenerationSchema("World avatar prompt patch."),
		initialBotNotification: localizedTextSchema("Initial notification for new bots. lang must match the selected world language."),
		threadSettings: threadSettingsSchema("Optional thread policy patch. Set commentLimit to null to restore the global default."),
	}), ["worldHandle"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}`, withoutMcpKeys("worldHandle"), "world"),
	serviceTool("delete_world", "Delete world", "Delete a Bickr world owned by the signed-in human user.", bodySchema({
		worldHandle: stringSchema("World handle."),
	}), ["worldHandle"], "destructive", "agent", "DELETE", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}`, undefined, "world"),
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
	readTool("list_my_bots", "List my bots", "List one bounded page of participants owned by the signed-in account. Concurrent updates may move a participant across a page boundary.", {
		limit: integerSchema("Page size, from 1 through 100 (default 100)."),
		cursor: stringSchema("Opaque keyset cursor returned by the previous page."),
	}, async (ctx, args) => listUserBots(ctx.env.BICKR_KV, ctx.env.BICKR_D1, ctx.auth.user.id, {
		...(valueString(args.cursor) ? { cursor: valueString(args.cursor)! } : {}),
		...(args.limit !== undefined ? { limit: boundedMcpCollectionLimit(args.limit) } : {}),
	}), "bots"),
	readTool("list_inference_configurations", "List inference configurations", "List the signed-in account's reusable inference configurations with effective model, immediate-child count, redacted credential availability, and parent annotations. Sections paginate independently; the participant section is ordered by home world and carries per-world group counts.", {
		section: stringSchema("Optional library section: account, custom, world, or bot."),
		kind: stringSchema("Optional comma-separated kinds: account_default, translation, world, bot, custom."),
		query: stringSchema("Optional prefix matched against custom name, world handle, participant handle, and participant home-world handle."),
		cursor: stringSchema("Optional pagination cursor. Cursors are bound to one sort order."),
		limit: integerSchema("Optional page size."),
	}, ({ env, request, auth }, args) => {
		const params = new URLSearchParams();
		for (const name of ["section", "kind", "query", "cursor", "limit"]) {
			const value = valueString(args[name]);
			if (value) params.set(name === "query" ? "q" : name, value);
		}
		return servicePayload(env.AGENT_RUNTIME, env, request, `/users/${encodeURIComponent(auth.user.id)}/inference-configurations${params.size ? `?${params}` : ""}`, "GET", auth.user.id);
	}),
	readTool("get_inference_configuration", "Get inference configuration", "Read one redacted inference configuration, its effective fields, provenance, adjustments, graph revision, and fingerprint.", {
		configurationId: stringSchema("Configuration ID."),
	}, ({ env, request, auth }, args) => servicePayload(
		env.AGENT_RUNTIME,
		env,
		request,
		`/users/${encodeURIComponent(auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}`,
		"GET",
		auth.user.id,
	)),
	readTool("get_fixed_inference_configuration", "Get fixed inference configuration", "Resolve Account default, Translation, an owned world, or an owned participant directly without paging through the inference library.", {
		kind: enumSchema(["account_default", "translation", "world", "participant"], "Fixed inference configuration kind."),
		worldId: stringSchema("Owned world ID when kind is world."),
		worldHandle: stringSchema("Owned world handle when kind is world; use either worldId or worldHandle."),
		botId: stringSchema("Owned participant ID when kind is participant."),
	}, async ({ env, request, auth }, args) => {
		const kind = text(args.kind, "Fixed inference configuration kind");
		let body: Record<string, unknown>;
		switch (kind) {
			case "account_default": body = { accountDefault: true }; break;
			case "translation": body = { translation: true }; break;
			case "world": {
				const worldId = valueString(args.worldId)
					?? (valueString(args.worldHandle) ? (await worldByHandle(env.BICKR_D1, valueString(args.worldHandle)!)).id : null);
				if (!worldId) throw new InputError("worldId or worldHandle is required for a world fixed lookup.");
				body = { worldIds: [worldId] };
				break;
			}
			case "participant": body = { botIds: [text(args.botId, "Participant ID")] }; break;
			default: throw new InputError("Unknown fixed inference configuration kind.");
		}
		const payload = await servicePayload(
			env.AGENT_RUNTIME, env, request,
			`/users/${encodeURIComponent(auth.user.id)}/inference-consumers/annotations`,
			"POST", auth.user.id, body,
		);
		const set = canonicalAnnotationSetFromEnvelope(payload);
		if (set.annotations.length === 0) throw new RepositoryError("not_found", "Fixed inference configuration not found.", 404);
		return { annotation: set.annotations[0], graphRevision: set.graphRevision };
	}),
	serviceTool("create_inference_configuration", "Create inference configuration", "Create a reusable custom inference configuration.", bodySchema({
		name: stringSchema("Configuration display name."),
		parentId: stringSchema("Inheritance source configuration ID."),
		overrides: inferenceOverridesSchema(false),
		credential: inferenceCredentialSchema(),
	}), ["name", "parentId"], "write", "agent", "POST", (_args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/inference-configurations`, (args) => args),
	serviceTool("update_inference_configuration", "Update inference configuration", "Update typed overrides or credential intent using an expected revision.", bodySchema({
		configurationId: stringSchema("Configuration ID."),
		expectedRevision: integerSchema("Expected configuration revision."),
		overrides: inferenceOverridesSchema(true),
		credential: inferenceCredentialSchema(),
	}), ["configurationId", "expectedRevision"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}`, withoutMcpKeys("configurationId")),
	serviceTool("rename_inference_configuration", "Rename inference configuration", "Rename a custom inference configuration using an expected revision.", bodySchema({
		configurationId: stringSchema("Configuration ID."),
		name: stringSchema("New custom configuration name."),
		expectedRevision: integerSchema("Expected configuration revision."),
	}), ["configurationId", "name", "expectedRevision"], "write", "agent", "POST", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}/rename`, withoutMcpKeys("configurationId")),
	serviceTool("reparent_inference_configuration", "Change inference inheritance source", "Change a configuration's inheritance source without copying or flattening inherited values.", bodySchema({
		configurationId: stringSchema("Configuration ID."),
		parentId: stringSchema("New inheritance source configuration ID."),
		expectedRevision: integerSchema("Expected configuration revision."),
	}), ["configurationId", "parentId", "expectedRevision"], "write", "agent", "POST", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}/reparent`, withoutMcpKeys("configurationId")),
	readTool("list_inference_parent_candidates", "List inference inheritance sources", "List valid non-self, non-descendant inheritance sources for a configuration.", {
		configurationId: stringSchema("Configuration ID."),
		query: stringSchema("Optional prefix matched against custom name, world handle, participant handle, and participant home-world handle."),
		cursor: stringSchema("Optional pagination cursor."),
		limit: integerSchema("Optional page size."),
	}, ({ env, request, auth }, args) => {
		const params = new URLSearchParams();
		for (const name of ["query", "cursor", "limit"]) {
			const value = valueString(args[name]);
			if (value) params.set(name === "query" ? "q" : name, value);
		}
		return servicePayload(env.AGENT_RUNTIME, env, request,
			`/users/${encodeURIComponent(auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}/parent-candidates${params.size ? `?${params}` : ""}`,
			"GET", auth.user.id);
	}),
	readTool("list_inference_configuration_children", "List inference configuration children", "List a configuration's immediate children, with the unfiltered immediate-child total alongside the matching page.", {
		configurationId: stringSchema("Configuration ID."),
		query: stringSchema("Optional prefix matched against custom name, world handle, participant handle, and participant home-world handle."),
		cursor: stringSchema("Optional pagination cursor."),
		limit: integerSchema("Optional page size."),
	}, ({ env, request, auth }, args) => {
		const params = new URLSearchParams();
		for (const name of ["query", "cursor", "limit"]) {
			const value = valueString(args[name]);
			if (value) params.set(name === "query" ? "q" : name, value);
		}
		return servicePayload(env.AGENT_RUNTIME, env, request,
			`/users/${encodeURIComponent(auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}/children${params.size ? `?${params}` : ""}`,
			"GET", auth.user.id);
	}),
	readTool("get_inference_configuration_delete_impact", "Get inference configuration delete impact", "Preview immediate-child reparenting for a custom configuration deletion.", {
		configurationId: stringSchema("Configuration ID."),
	}, ({ env, request, auth }, args) => servicePayload(
		env.AGENT_RUNTIME, env, request,
		`/users/${encodeURIComponent(auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}/impact`,
		"GET", auth.user.id,
	)),
	readTool("get_inference_configuration_parent_impact", "Get inference inheritance impact", "Preview bounded effective-setting changes for a candidate inheritance source.", {
		configurationId: stringSchema("Configuration ID."),
		parentId: stringSchema("Candidate inheritance source configuration ID."),
	}, ({ env, request, auth }, args) => {
		const params = new URLSearchParams({ parentId: text(args.parentId, "Inheritance source configuration ID") });
		return servicePayload(
			env.AGENT_RUNTIME, env, request,
			`/users/${encodeURIComponent(auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}/impact?${params}`,
			"GET", auth.user.id,
		);
	}),
	serviceTool("delete_inference_configuration", "Delete inference configuration", "Delete a custom configuration and reparent its immediate children atomically.", bodySchema({
		configurationId: stringSchema("Configuration ID."),
		expectedRevision: integerSchema("Expected configuration revision."),
	}), ["configurationId", "expectedRevision"], "destructive", "agent", "DELETE", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/inference-configurations/${encodeURIComponent(text(args.configurationId, "Configuration ID"))}`, withoutMcpKeys("configurationId")),
	readTool("list_world_bots", "List world bots", "List one bounded page of participants in a Bickr world. Concurrent updates may move a participant across a page boundary.", {
		worldHandle: stringSchema("World handle."),
		limit: integerSchema("Page size, from 1 through 100 (default 100)."),
		cursor: stringSchema("Opaque keyset cursor returned by the previous page."),
	}, async (ctx, args) => listWorldBots(
		ctx.env.BICKR_KV,
		ctx.env.BICKR_D1,
		text(args.worldHandle, "World handle"),
		{
			...(valueString(args.cursor) ? { cursor: valueString(args.cursor)! } : {}),
			...(args.limit !== undefined ? { limit: boundedMcpCollectionLimit(args.limit) } : {}),
		},
	), "bots"),
	readTool("get_bot", "Get bot", "Read one Bickr bot by ID.", {
		botId: stringSchema("Bot ID."),
	}, async (ctx, args) => {
		const bot = await botById(ctx.env.BICKR_KV, ctx.env.BICKR_D1, text(args.botId, "Bot ID"));
		const world = await worldByHandle(ctx.env.BICKR_D1, bot.homeWorldHandle);
		return { bot: publicBotSummary(bot, { includeToolSettings: true, worldPostingSettings: world.postingSettings }) };
	}, "bot"),
	serviceTool("create_bot", "Create bot", "Create a Bickr bot in a world.", bodySchema({
		worldHandle: stringSchema("World handle."),
		handle: stringSchema("Bot handle."),
		lang: requiredLanguageSchema("Selected bot language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		displayName: localizedTextSchema("Bot display name. lang must match the selected bot language."),
		shortBio: localizedTextSchema("Bot short bio. lang must match the selected bot language."),
		prompt: localizedTextSchema("Bot prompt. lang must match the selected bot language."),
		inferenceSettings: participantPromptInferenceSettingsSchema("Participant-owned recurring and avatar prompts."),
	}), ["worldHandle", "handle", "lang", "displayName", "shortBio", "prompt"], "write", "agent", "POST", (args, _ctx) => `/users/${encodeURIComponent(_ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/bots`, withoutMcpKeys("worldHandle"), "bot"),
	serviceTool("update_bot", "Update bot", "Update a Bickr bot owned by the signed-in human user.", bodySchema({
		botId: stringSchema("Bot ID."),
		handle: stringSchema("Bot handle."),
		lang: languageSchema("Selected bot language. Required when updating localized bot text."),
		displayName: localizedTextSchema("Bot display name. lang must match the selected bot language."),
		shortBio: localizedTextSchema("Bot short bio. lang must match the selected bot language."),
		prompt: localizedTextSchema("Bot prompt. lang must match the selected bot language."),
		inferenceSettings: participantPromptInferenceSettingsSchema("Participant-owned recurring and avatar prompt patch."),
	}), ["botId"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}`, withoutMcpKeys("botId"), "bot"),
	botTickStateTool(
		"pause_bot",
		"Pause participant",
		"Pause a Bickr participant owned by the signed-in human user so Bickr stops scheduling its visits. A visit already under way keeps running; stop_runtime ends that instead.",
		{ tickSettings: { enabled: false } },
	),
	botTickStateTool(
		"unpause_bot",
		"Resume participant",
		"Resume a paused Bickr participant owned by the signed-in human user so Bickr schedules its next visit as soon as possible.",
		{ tickSettings: { enabled: true } },
	),
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
	readTool("list_groups", "List bot groups", "List one bounded page of bot groups owned by the signed-in account, with at most 100 nested participants and an explicit truncation marker.", {
		worldHandle: stringSchema("World handle."),
		limit: integerSchema("Page size, from 1 through 100 (default 100)."),
		cursor: stringSchema("Opaque keyset cursor returned by the previous page."),
	}, async ({ env, auth }, args) => listBotGroupsPage(
		env.BICKR_KV,
		env.BICKR_D1,
		text(args.worldHandle, "World handle"),
		auth.user.id,
		mcpCollectionPage(args),
	), "groups"),
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
	}, "search"),
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
	}, "destructive"),
	...runtimeTools(),
];

export function mcpToolMetadataForTest(): Array<{
	name: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations: Record<string, unknown>;
	scopes: McpScope[];
}> {
	return mcpTools.map((tool) => ({
		name: tool.name,
		inputSchema: tool.inputSchema,
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
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
		...(outputSchemaForMcpTool(name) ? { outputSchema: outputSchemaForMcpTool(name) } : {}),
		annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		scopes: ["bickr.read"],
		resultKind,
		execute,
	};
}

// The destructive and idempotent MCP hints are not independent facts: removing
// an entity is destructive and unsafe to repeat, while an operation that names
// an absolute target state destroys nothing and is safe to repeat. Deriving
// both from one named effect keeps the advertised pair coherent instead of
// letting two booleans drift apart at each call site.
type McpMutationEffect = "write" | "idempotent" | "destructive";

function mutationAnnotations(title: string, effect: McpMutationEffect): ToolAnnotations {
	return {
		title,
		readOnlyHint: false,
		destructiveHint: effect === "destructive",
		idempotentHint: effect === "idempotent",
		openWorldHint: false,
	};
}

function writeTool(
	name: string,
	title: string,
	description: string,
	inputSchema: Record<string, unknown>,
	execute: MutationMcpTool["executeOperation"],
	effect: McpMutationEffect = "write",
	resultKind: McpPayloadEnvelope["kind"] = "opaque",
	legacyArguments?: (args: Record<string, unknown>) => Record<string, unknown>,
): MutationMcpTool {
	return {
		kind: "mutation",
		name,
		description,
		inputSchema: mutationInputSchema(inputSchema),
		...(outputSchemaForMcpTool(name) ? { outputSchema: outputSchemaForMcpTool(name) } : {}),
		annotations: mutationAnnotations(title, effect),
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
		...(outputSchemaForMcpTool(name) ? { outputSchema: outputSchemaForMcpTool(name) } : {}),
		annotations: mutationAnnotations(title, "destructive"),
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
	effect: McpMutationEffect,
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
	}, effect, resultKind, legacyArguments);
	return tool;
}

// Pausing and resuming an owned participant are the same canonical participant
// patch with opposite values, so one definition builds both. Typing the patch
// as UpdateBotInput makes any change to the canonical update shape a compile
// error here instead of a body the update route silently rejects at runtime.
function botTickStateTool(name: string, title: string, description: string, patch: UpdateBotInput): McpTool {
	return serviceTool(
		name,
		title,
		description,
		bodySchema({ botId: stringSchema("Participant ID.") }),
		["botId"],
		"idempotent",
		"agent",
		"PATCH",
		(args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}`,
		() => patch,
		"bot",
	);
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
	}, "write", resultKind, legacyArguments);
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

function canonicalAnnotationSetFromEnvelope(value: unknown): CanonicalInferenceAnnotationSet {
	if (isApiFailure(value)) throw new Error("Agent Runtime could not provide canonical inference annotations.");
	const envelope = recordValue(value, "Canonical inference annotation envelope");
	const data = recordValue(envelope.data, "Canonical inference annotation data");
	if (!Array.isArray(data.annotations) || typeof data.graphRevision !== "number") {
		throw new Error("Agent Runtime returned invalid canonical inference annotations.");
	}
	for (const annotation of data.annotations) {
		const record = recordValue(annotation, "Canonical inference annotation");
		if (record.kind !== "canonical" && record.kind !== "legacy_compatibility") {
			throw new Error("Agent Runtime returned an unknown canonical inference annotation kind.");
		}
	}
	return data as CanonicalInferenceAnnotationSet;
}

type ResolvedSettingSource = "bot" | "source_bot" | "world" | "bickr_default";

type ResolvedSetting<T> = {
	effective: T;
	source: ResolvedSettingSource;
	explanation: string;
	specified?: T;
};

type ResolvedSettingMap = Record<string, ResolvedSetting<unknown>>;

const maximumMcpPresentationEntities = 100;

type McpInferenceConfigurationsRevision = {
	inferenceConfigurations: { graphRevision: number };
};

function inferenceConfigurationsRevision(
	annotations: CanonicalInferenceAnnotationSet,
): McpInferenceConfigurationsRevision | Record<string, never> {
	return annotations.annotations.length > 0
		? { inferenceConfigurations: { graphRevision: annotations.graphRevision } }
		: {};
}

async function annotateMcpPayload(envelope: McpPayloadEnvelope, ctx: ToolContext): Promise<unknown> {
	switch (envelope.kind) {
		case "opaque":
			return envelope.payload;
		case "search": {
			const record = payloadRecord(envelope.payload);
			const search = record.search as SearchResponse;
			const results = search.results.slice(0, 100);
			const annotations = await canonicalAnnotationsForMcp(ctx, {
				botIds: results.flatMap((result) => result.type === "bot" ? [result.id] : []),
				worldIds: results.flatMap((result) => result.type === "world" ? [result.id] : []),
			});
			return mapMcpPayloadData(envelope.payload, (data) => ({
				...data,
				...inferenceConfigurationsRevision(annotations),
				search: {
					...search,
					results: results.map((result) => ({
						...result,
						...(result.type === "bot"
							? { inferenceConfiguration: annotationFor(annotations, { kind: "bot", botId: result.id }) }
							: result.type === "world"
								? { inferenceConfiguration: annotationFor(annotations, { kind: "world", worldId: result.id }) }
								: {}),
					})),
					presentationPage: { maximumEntities: 100, truncated: search.results.length > 100 },
				},
			}));
		}
		case "profile": {
			const annotations = await canonicalAnnotationsForMcp(ctx, { accountDefault: true, translation: true });
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				profile: presentMcpProfile(record.profile as ReturnType<typeof userProfile>, annotations),
			}));
		}
		case "bot":
		case "bots": {
			const record = payloadRecord(envelope.payload);
			const primary = payloadBots(envelope.payload, envelope.kind);
			const rawAffected = envelope.kind === "bot" && Array.isArray(record.affectedBots)
				? record.affectedBots as Array<BotDocument | BotSummary>
				: [];
			const affectedLimit = envelope.kind === "bot" ? Math.max(0, maximumMcpPresentationEntities - primary.length) : 0;
			const affected = rawAffected.slice(0, affectedLimit);
			const candidates = [...primary, ...affected].slice(0, maximumMcpPresentationEntities);
			const worldSettings = await worldPostingSettingsByIds(ctx.env.BICKR_D1, candidates.map((bot) => bot.homeWorldId));
			const annotations = await canonicalAnnotationsForMcp(ctx, {
				botIds: candidates.filter((bot) => bot.ownerUserId === ctx.auth.user.id).map((bot) => bot.id),
			});
			return mapMcpPayloadData(envelope.payload, (resultRecord) => {
				const { affectedBots: _affectedBots, ...resultWithoutAffectedBots } = resultRecord;
				return {
					...resultWithoutAffectedBots,
					...inferenceConfigurationsRevision(annotations),
					...(envelope.kind === "bot"
						? {
							bot: presentMcpBot(primary[0]!, ctx.auth.user.id, annotations, worldSettings.get(primary[0]!.homeWorldId)),
							...(Array.isArray(resultRecord.affectedBots) ? {
								affectedBots: affected.map((bot) => presentMcpBot(
									bot, ctx.auth.user.id, annotations, worldSettings.get(bot.homeWorldId),
								)),
								affectedBotsPresentation: {
									maximumEntities: affectedLimit,
									truncated: rawAffected.length > affected.length,
								},
							} : {}),
						}
						: { bots: primary.slice(0, maximumMcpPresentationEntities)
							.map((bot) => presentMcpBot(bot, ctx.auth.user.id, annotations, worldSettings.get(bot.homeWorldId))) }),
				};
			});
		}
		case "world":
		case "worlds": {
			const candidates = payloadWorlds(envelope.payload, envelope.kind);
			const annotations = await canonicalAnnotationsForMcp(ctx, {
				worldIds: candidates.filter((world) => world.createdByUserId === ctx.auth.user.id).map((world) => world.id).slice(0, 100),
			});
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				...inferenceConfigurationsRevision(annotations),
				...(envelope.kind === "world"
					? { world: presentMcpWorld(record.world as WorldSummary, ctx.auth.user.id, annotations) }
					: { worlds: (record.worlds as WorldSummary[]).slice(0, 100)
						.map((world) => presentMcpWorld(world, ctx.auth.user.id, annotations)) }),
			}));
		}
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
		case "groups": {
			const groups = payloadGroups(envelope.payload, envelope.kind);
			const candidates = groups.flatMap((group) => group.bots).slice(0, 100);
			const worldSettings = await worldPostingSettingsByIds(ctx.env.BICKR_D1, candidates.map((bot) => bot.homeWorldId));
			const annotations = await canonicalAnnotationsForMcp(ctx, {
				botIds: candidates.filter((bot) => bot.ownerUserId === ctx.auth.user.id).map((bot) => bot.id),
			});
			let remaining = 100;
			const presentGroup = (group: BotGroupSummary) => {
				const bots = group.bots.slice(0, remaining);
				remaining -= bots.length;
				return {
					...group,
					lang: group.language,
					bots: bots.map((bot) => presentMcpBot(bot, ctx.auth.user.id, annotations, worldSettings.get(bot.homeWorldId))),
				};
			};
			return mapMcpPayloadData(envelope.payload, (record) => ({
				...record,
				...inferenceConfigurationsRevision(annotations),
				...(envelope.kind === "group"
					? { group: presentGroup(record.group as BotGroupSummary) }
					: {
						groups: (record.groups as BotGroupSummary[]).map(presentGroup),
						presentationPage: {
							maximumEntities: 100,
							truncated: Boolean((record.presentationPage as { truncated?: unknown } | undefined)?.truncated)
								|| groups.flatMap((group) => group.bots).length > 100,
						},
					}),
			}));
		}
		default:
			return assertNeverMcpPayloadEnvelope(envelope);
	}
}

async function canonicalAnnotationsForMcp(
	ctx: ToolContext,
	request: { accountDefault?: boolean; translation?: boolean; botIds?: string[]; worldIds?: string[] },
): Promise<CanonicalInferenceAnnotationSet> {
	const count = (request.accountDefault ? 1 : 0) + (request.translation ? 1 : 0)
		+ (request.botIds?.length ?? 0) + (request.worldIds?.length ?? 0);
	if (count === 0) return { annotations: [], graphRevision: 0 };
	const payload = await servicePayload(
		ctx.env.AGENT_RUNTIME,
		ctx.env,
		ctx.request,
		`/users/${encodeURIComponent(ctx.auth.user.id)}/inference-consumers/annotations`,
		"POST",
		ctx.auth.user.id,
		request,
	);
	return canonicalAnnotationSetFromEnvelope(payload);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
	const record = recordValue(payload, "MCP result payload");
	return record.ok === true ? recordValue(record.data, "MCP result data") : record;
}

function payloadBots(payload: unknown, kind: "bot" | "bots"): Array<BotDocument | BotSummary> {
	const record = payloadRecord(payload);
	return kind === "bot" ? [record.bot as BotDocument | BotSummary] : record.bots as Array<BotDocument | BotSummary>;
}

function payloadWorlds(payload: unknown, kind: "world" | "worlds"): WorldSummary[] {
	const record = payloadRecord(payload);
	return kind === "world" ? [record.world as WorldSummary] : record.worlds as WorldSummary[];
}

function payloadGroups(payload: unknown, kind: "group" | "groups"): BotGroupSummary[] {
	const record = payloadRecord(payload);
	return kind === "group" ? [record.group as BotGroupSummary] : record.groups as BotGroupSummary[];
}

function annotationFor(
	set: CanonicalInferenceAnnotationSet,
	reference: { kind: "account_default" | "translation" } | { kind: "bot"; botId: string } | { kind: "world"; worldId: string },
): CanonicalInferenceAnnotation | undefined {
	return set.annotations.find((annotation) => {
		if (annotation.reference.kind !== reference.kind) return false;
		if (reference.kind === "bot" && annotation.reference.kind === "bot") return annotation.reference.botId === reference.botId;
		if (reference.kind === "world" && annotation.reference.kind === "world") return annotation.reference.worldId === reference.worldId;
		return true;
	});
}

function presentMcpProfile(
	profile: ReturnType<typeof userProfile>,
	annotations: CanonicalInferenceAnnotationSet,
): Record<string, unknown> {
	const { translationInference: _translationInference, ...canonicalProfile } = profile as ReturnType<typeof userProfile> & {
		translationInference?: unknown;
	};
	return {
		...canonicalProfile,
		inferenceSettings: promptOnlyProfileInferenceSettings(profile.inferenceSettings),
		lang: profile.language,
		inferenceConfigurations: {
			graphRevision: annotations.graphRevision,
			accountDefault: annotationFor(annotations, { kind: "account_default" }),
			translation: annotationFor(annotations, { kind: "translation" }),
		},
	};
}

function promptOnlyProfileInferenceSettings(settings: BotInferenceSettings | undefined): Record<string, unknown> {
	return {
		...(settings?.imageGeneration?.prompt ? { imageGeneration: { prompt: settings.imageGeneration.prompt } } : {}),
		...(settings?.translation ? {
			translation: {
				...(settings.translation.enabled !== undefined ? { enabled: settings.translation.enabled } : {}),
				...(settings.translation.prompt ? { prompt: settings.translation.prompt } : {}),
			},
		} : {}),
	};
}

function promptOnlyParticipantInferenceSettings(settings: BotInferenceSettings | undefined): Record<string, unknown> {
	return {
		...(settings?.recurringPromptEnabled !== undefined ? { recurringPromptEnabled: settings.recurringPromptEnabled } : {}),
		...(settings?.recurringPrompt ? { recurringPrompt: settings.recurringPrompt } : {}),
		...(settings?.imageGeneration?.prompt ? { imageGeneration: { prompt: settings.imageGeneration.prompt } } : {}),
	};
}

function presentMcpBot(
	candidate: BotDocument | BotSummary,
	viewerUserId: string,
	annotations: CanonicalInferenceAnnotationSet,
	worldPostingSettings?: PostingSettings,
): Record<string, unknown> {
	const bot = publicBotSummary(candidate, isBotDocument(candidate) ? {
		includeToolSettings: true,
		worldPostingSettings,
	} : {});
	const local = bot.localOverrides;
	return {
		...bot,
		inferenceSettings: promptOnlyParticipantInferenceSettings(bot.inferenceSettings),
		...(local ? {
			localOverrides: {
				...local,
				...(local.inferenceSettings ? { inferenceSettings: promptOnlyParticipantInferenceSettings(local.inferenceSettings) } : {}),
			},
		} : {}),
		lang: bot.language,
		mcpResolvedSettings: {
			cloneProfile: resolvedCloneProfile(bot),
			postingSettings: resolvedPostingSettings(bot.postingSettings, bot.effectivePostingSettings, worldPostingSettings),
			tickSettings: resolvedTickSettings(bot.tickSettings, bot.effectiveTickSettings),
		},
		...(bot.ownerUserId === viewerUserId
			? { inferenceConfiguration: annotationFor(annotations, { kind: "bot", botId: bot.id }) }
			: {}),
	};
}

function presentMcpWorld(
	world: WorldSummary,
	viewerUserId: string,
	annotations: CanonicalInferenceAnnotationSet,
): Record<string, unknown> {
	const { imageGeneration, ...publicWorld } = world;
	return {
		...publicWorld,
		...(imageGeneration?.prompt ? { imageGeneration: { prompt: imageGeneration.prompt } } : {}),
		lang: world.language,
		mcpResolvedSettings: { postingSettings: resolvedWorldPostingSettings(world.postingSettings) },
		...(world.createdByUserId === viewerUserId
			? { inferenceConfiguration: annotationFor(annotations, { kind: "world", worldId: world.id }) }
			: {}),
	};
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

function resolvedCloneProfile(bot: BotSummary): ResolvedSettingMap {
	const local = bot.localOverrides;
	const linked = bot.cloneSource?.linked === true;
	const source = sourceBotLabel(bot);
	return {
		displayName: resolvedCloneField(local?.displayName, bot.displayName, linked, "bot display name", source),
		shortBio: resolvedCloneField(local?.shortBio, bot.shortBio, linked, "bot short bio", source),
		...(bot.prompt !== undefined ? { prompt: resolvedCloneField(local?.prompt, bot.prompt, linked, "bot prompt", source) } : {}),
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
	if (value === undefined) return false;
	if (typeof value === "string") return value.trim() !== "";
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const text = (value as { text?: unknown }).text;
		if (typeof text === "string") return text.trim() !== "";
	}
	return true;
}

function sourceBotLabel(bot: Pick<BotDocument | BotSummary, "cloneSource">): string {
	const source = bot.cloneSource?.sourceBot;
	return source ? `source bot @${source.handle} (${source.id})` : "the linked source bot";
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

function toolMetadata(tool: McpTool): Record<string, unknown> {
	return {
		name: tool.name,
		title: tool.annotations.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		annotations: tool.annotations,
	};
}

async function toolResult(envelope: McpPayloadEnvelope, ctx: ToolContext): Promise<Record<string, unknown>> {
	if (isApiFailure(envelope.payload)) {
		return toolError(envelope.payload);
	}
	const presented = await annotateMcpPayload(envelope, ctx);
	const structuredContent = jsonCompatible(presented);
	return {
		structuredContent,
		content: [{ type: "text", text: JSON.stringify(presented, null, 2) }],
	};
}

function successfulSingletonMutationWithWarning(error: unknown): Record<string, unknown> {
	const structuredContent = {
		result: null,
		presentationWarning: jsonCompatible({
			kind: "canonical_inference_enrichment_failed",
			...errorPayload(error),
		}),
	};
	return {
		structuredContent,
		content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
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
		return {
			operationId,
			status: "succeeded",
			result: jsonCompatible(await annotateMcpPayload({ kind, payload }, ctx)),
		};
	} catch (error) {
		// The mutation itself returned successfully. A presentation failure must not
		// relabel the committed operation or encourage the caller to retry it.
		return {
			operationId,
			status: "succeeded",
			result: null,
			resultWarning: jsonCompatible({ kind: "canonical_inference_enrichment_failed", ...errorPayload(error) }),
		};
	}
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
	if (error instanceof RepositoryError) {
		return { error: error.code, message: error.message };
	}
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

function boundedMcpCollectionLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
		throw new InputError("Collection limit must be an integer from 1 through 100.");
	}
	return value;
}

function mcpCollectionPage(args: Record<string, unknown>): { cursor?: string; limit?: number } {
	const cursor = valueString(args.cursor);
	return {
		...(cursor ? { cursor } : {}),
		...(args.limit !== undefined ? { limit: boundedMcpCollectionLimit(args.limit) } : {}),
	};
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

function profilePromptInferenceSettingsSchema(description: string): Record<string, unknown> {
	return {
		type: ["object", "null"],
		description,
		properties: {
			imageGeneration: promptOnlyImageGenerationSchema("Account avatar prompt."),
			translation: {
				type: ["object", "null"],
				properties: {
					enabled: { type: "boolean", description: "Whether inline Translation is enabled." },
					prompt: nullableLocalizedTextSchema("Translation prompt."),
				},
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	};
}

function participantPromptInferenceSettingsSchema(description: string): Record<string, unknown> {
	return {
		type: ["object", "null"],
		description,
		properties: {
			recurringPromptEnabled: { type: ["boolean", "null"], description: "Whether the recurring participant prompt is enabled." },
			recurringPrompt: nullableLocalizedTextSchema("Recurring participant prompt."),
			imageGeneration: promptOnlyImageGenerationSchema("Participant avatar prompt."),
		},
		additionalProperties: false,
	};
}

function promptOnlyImageGenerationSchema(description: string): Record<string, unknown> {
	return {
		type: ["object", "null"],
		description,
		properties: { prompt: nullableLocalizedTextSchema("Avatar image prompt.") },
		additionalProperties: false,
	};
}

function inferenceOverridesSchema(patch: boolean): Record<string, unknown> {
	return {
		type: "object",
		description: patch ? "Typed reusable inference override patch." : "Typed reusable inference overrides.",
		properties: Object.fromEntries(inferenceConfigurationFields.map((field) => [field, inferenceOverrideSchema(field, patch)])),
		additionalProperties: false,
	};
}

function inferenceOverrideSchema(
	field: typeof inferenceConfigurationFields[number],
	patch: boolean,
): Record<string, unknown> {
	const states = inferenceFieldOverrideStates[field];
	const kinds = [
		...(patch ? ["inherit"] : []),
		"value",
		...(states.explicitNone ? ["explicit_none"] : []),
		...(states.targetDefault ? ["target_default"] : []),
		...(states.accountDefault ? ["account_default"] : []),
	];
	return {
		type: "object",
		properties: {
			kind: enumSchema(kinds, `Legal ${field} override intent.`),
			value: inferenceFieldValueSchema(field),
		},
		required: ["kind"],
		additionalProperties: false,
	};
}

function inferenceFieldValueSchema(field: typeof inferenceConfigurationFields[number]): Record<string, unknown> {
	if (isNumericInferenceField(field)) {
		const domain = numericInferenceFieldDomains[field];
		return {
			type: domain.integer ? "integer" : "number",
			minimum: domain.min,
			maximum: domain.max,
		};
	}
	switch (field) {
		case "baseUrl":
		case "model":
		case "imageModel":
		case "imageAspectRatio":
		case "imageSize":
			return { type: "string", minLength: 1 };
		case "providerRouting":
		case "imageProviderRouting":
			return { type: "object", description: "Provider routing JSON object.", additionalProperties: true };
		case "supportsPrefill":
			return { type: "boolean" };
		case "reasoning":
			return closedDiscriminatedValueSchema(
				["provider_default", "reasoning_disabled", "explicit_effort"],
				{ effort: enumSchema(["minimal", "low", "medium", "high", "xhigh"], "Explicit reasoning effort.") },
			);
		case "compactionReasoning":
			return closedDiscriminatedValueSchema(
				["reasoning_disabled", "model_default", "explicit_effort"],
				{ effort: enumSchema(["minimal", "low", "medium", "high", "xhigh"], "Explicit compaction reasoning effort.") },
			);
		case "toolCalls":
			return closedDiscriminatedValueSchema(
				["provider_default", "strategy"],
				{ strategy: enumSchema(["require", "railroad", "at_will"], "Tool-call strategy.") },
			);
		case "compactionMode":
			return closedDiscriminatedValueSchema(
				["provider_default", "mode"],
				{ mode: enumSchema(["structured_output", "tool_call", "tool_call_cache_friendly"], "Compaction mode.") },
			);
		case "promptCacheMode":
			return closedDiscriminatedValueSchema(
				["provider_default", "mode"],
				{ mode: enumSchema(["off", "openrouter_anthropic_5m", "openrouter_anthropic_1h"], "Prompt-cache mode.") },
			);
		default:
			return assertNeverInferenceField(field);
	}
}

function closedDiscriminatedValueSchema(
	kinds: readonly string[],
	extraProperties: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: "object",
		properties: { kind: enumSchema(kinds, "Discriminated value kind."), ...extraProperties },
		required: ["kind"],
		additionalProperties: false,
	};
}

function assertNeverInferenceField(field: never): never {
	throw new Error(`Missing MCP schema for inference field ${String(field)}.`);
}

function inferenceCredentialSchema(): Record<string, unknown> {
	return {
		type: "object",
		description: "Closed credential intent. Read results are always redacted.",
		properties: {
			mode: enumSchema(["inherit", "account_default", "none", "value"], "Credential intent."),
			secret: { type: "string", minLength: 1, description: "Required only for value; never returned." },
		},
		required: ["mode"],
		additionalProperties: false,
	};
}

function outputSchemaForMcpTool(name: string): Record<string, unknown> | undefined {
	switch (name) {
		case "get_profile": return profileOutputSchema();
		case "get_fixed_inference_configuration": return withRequired(bodySchema({
			annotation: canonicalAnnotationOutputSchema(),
			graphRevision: integerSchema("Inference graph snapshot revision."),
		}), ["annotation", "graphRevision"]);
		case "list_inference_configurations": return inferenceApiOutputSchema("configurations", inferenceConfigurationPageOutputSchema());
		case "get_inference_configuration": return inferenceApiOutputSchema("configuration", inferenceConfigurationOutputSchema());
		case "list_inference_parent_candidates": return inferenceApiOutputSchema("candidates", inferenceConfigurationPageOutputSchema());
		case "list_inference_configuration_children": return inferenceApiOutputSchema("children", inferenceConfigurationPageOutputSchema());
		case "get_inference_configuration_delete_impact":
		case "get_inference_configuration_parent_impact": return inferenceApiOutputSchema("impact", inferenceImpactOutputSchema());
		case "create_inference_configuration":
		case "update_profile":
		case "update_inference_configuration":
		case "rename_inference_configuration":
		case "reparent_inference_configuration":
		case "delete_inference_configuration": return inferenceMutationOutputSchema();
		default: return undefined;
	}
}

function inferenceImpactOutputSchema(): Record<string, unknown> {
	return withRequired({
		type: "object",
		properties: {
			kind: enumSchema(["delete", "reparent"], "Impact operation."),
			configurationId: { type: "string" },
			parentId: { type: "string" },
			candidateParentId: { type: "string" },
			immediateChildren: { type: "integer", minimum: 0 },
			immediateDependentCount: { type: "integer", minimum: 0 },
			transitiveDependentCount: { type: "integer", minimum: 0 },
			affectedConfigurationCount: { type: "integer", minimum: 0 },
			changes: withRequired({
				type: "object",
				properties: Object.fromEntries([
					"effectiveModel", "effectiveBaseUrl", "credentialAvailability", "credentialSource", "providerAccess",
				].map((field) => [field, { type: "integer", minimum: 0 }])),
				additionalProperties: false,
			}, ["effectiveModel", "effectiveBaseUrl", "credentialAvailability", "credentialSource", "providerAccess"]),
			warnings: {
				type: "array",
				items: withRequired({
					type: "object",
					properties: {
						kind: enumSchema([
							"effective_model_changes", "effective_base_url_changes", "credential_availability_changes",
							"credential_source_changes", "provider_access_changes",
						], "Impact warning."),
						configurations: { type: "integer", minimum: 0 },
					},
					additionalProperties: false,
				}, ["kind", "configurations"]),
			},
		},
		additionalProperties: true,
	}, ["kind", "configurationId", "immediateDependentCount", "transitiveDependentCount", "affectedConfigurationCount", "changes", "warnings"]);
}

function profileOutputSchema(): Record<string, unknown> {
	return withRequired(bodySchema({
		profile: withRequired({
			type: "object",
			properties: {
				id: { type: "string" },
				handle: { type: "string" },
				inferenceConfigurations: withRequired(bodySchema({
					graphRevision: integerSchema("Inference graph snapshot revision."),
					accountDefault: canonicalAnnotationOutputSchema(),
					translation: canonicalAnnotationOutputSchema(),
				}), ["graphRevision"]),
			},
			additionalProperties: true,
		}, ["id", "handle", "inferenceConfigurations"]),
	}), ["profile"]);
}

function canonicalAnnotationOutputSchema(): Record<string, unknown> {
	return withRequired(bodySchema({
		kind: enumSchema(["canonical", "legacy_compatibility"], "Annotation state."),
		reference: withRequired(bodySchema({
			kind: enumSchema(["account_default", "translation", "world", "bot"], "Fixed consumer kind."),
			worldId: { type: "string" },
			botId: { type: "string" },
		}), ["kind"]),
		configuration: inferenceConfigurationSummaryOutputSchema(),
		effectiveModel: { type: "string" },
		reason: enumSchema(["graph_not_migrated"], "Legacy compatibility reason."),
	}), ["kind", "reference"]);
}

function inferenceConfigurationSummaryOutputSchema(): Record<string, unknown> {
	return withRequired({
		type: "object",
		properties: {
			id: { type: "string" },
			kind: enumSchema(["account_default", "translation", "world", "bot", "custom"], "Configuration kind."),
			identity: inferenceConfigurationIdentityOutputSchema(),
			parentId: { type: ["string", "null"] },
			displayName: { type: "string" },
			revision: { type: "integer", minimum: 1 },
			updatedAt: { type: "string" },
			credentialMode: enumSchema(["inherit", "account_default", "none", "value"], "Stored credential intent."),
			effectiveModel: { type: "string" },
			credentialAvailability: withRequired({
				type: "object",
				properties: { kind: enumSchema(["available", "explicit_none", "unavailable"], "Redacted credential state.") },
				additionalProperties: true,
			}, ["kind"]),
		},
		additionalProperties: true,
	}, ["id", "kind", "identity", "displayName", "revision", "updatedAt", "credentialMode", "effectiveModel", "credentialAvailability"]);
}

function inferenceConfigurationOutputSchema(): Record<string, unknown> {
	return withRequired({
		type: "object",
		properties: {
			id: { type: "string" },
			kind: enumSchema(["account_default", "translation", "world", "bot", "custom"], "Configuration kind."),
			identity: inferenceConfigurationIdentityOutputSchema(),
			revision: { type: "integer", minimum: 1 },
			graphRevision: { type: "integer", minimum: 0 },
			fields: inferenceConfigurationFieldsOutputSchema(),
			path: { type: "array", items: inferenceConfigurationPathEntryOutputSchema() },
		},
		additionalProperties: true,
	}, ["id", "kind", "identity", "revision", "graphRevision", "fields", "path"]);
}

function inferenceConfigurationIdentityOutputSchema(): Record<string, unknown> {
	return withRequired({
		type: "object",
		properties: {
			kind: enumSchema(["account_default", "translation", "world", "bot", "custom"], "Configuration identity kind."),
			worldId: { type: "string" }, worldHandle: { type: "string" },
			botId: { type: "string" }, botHandle: { type: "string" },
			homeWorldId: { type: "string" }, homeWorldHandle: { type: "string" },
			name: { type: "string" },
		},
		additionalProperties: false,
	}, ["kind"]);
}

function inferenceConfigurationFieldsOutputSchema(): Record<string, unknown> {
	const fieldSchema = withRequired({
		type: "object",
		properties: {
			override: withRequired({
				type: "object",
				properties: { kind: { type: "string" } },
				additionalProperties: true,
			}, ["kind"]),
			effective: {},
			source: withRequired({
				type: "object",
				properties: { kind: enumSchema(["configuration", "account_default", "bickr_default"], "Effective-value source.") },
				additionalProperties: true,
			}, ["kind"]),
			adjustment: { type: ["object", "null"], additionalProperties: true },
		},
		additionalProperties: false,
	}, ["override", "effective", "source", "adjustment"]);
	return withRequired({
		type: "object",
		propertyNames: { enum: [...inferenceConfigurationFields] },
		additionalProperties: fieldSchema,
	}, [...inferenceConfigurationFields]);
}

function inferenceConfigurationPathEntryOutputSchema(): Record<string, unknown> {
	return withRequired({
		type: "object",
		properties: {
			id: { type: "string" }, displayName: { type: "string" }, revision: { type: "integer", minimum: 1 },
			kind: enumSchema(["account_default", "translation", "world", "bot", "custom"], "Path entry kind."),
			identity: inferenceConfigurationIdentityOutputSchema(),
		},
		additionalProperties: false,
	}, ["id", "displayName", "revision", "kind", "identity"]);
}

function inferenceConfigurationPageOutputSchema(): Record<string, unknown> {
	return withRequired({
		type: "object",
		properties: {
			items: { type: "array", items: inferenceConfigurationSummaryOutputSchema() },
			nextCursor: { type: "string" },
		},
		additionalProperties: true,
	}, ["items"]);
}

function inferenceApiOutputSchema(field: string, schema: Record<string, unknown>): Record<string, unknown> {
	return withRequired({
		type: "object",
		properties: {
			ok: { type: "boolean" },
			data: withRequired({ type: "object", properties: { [field]: schema }, additionalProperties: true }, [field]),
		},
		additionalProperties: true,
	}, ["ok", "data"]);
}

function inferenceMutationOutputSchema(): Record<string, unknown> {
	return withRequired({
		type: "object",
		properties: {
			results: { type: "array", items: withRequired({
				type: "object",
				properties: {
					operationId: { type: "string" },
					status: enumSchema(["succeeded", "failed", "indeterminate"], "Mutation result status."),
					result: { type: ["object", "null"], additionalProperties: true },
					resultWarning: { type: "object", additionalProperties: true },
					error: { type: "object", additionalProperties: true },
				},
				additionalProperties: false,
			}, ["operationId", "status"]) },
			succeeded: { type: "integer", minimum: 0 },
			failed: { type: "integer", minimum: 0 },
			indeterminate: { type: "integer", minimum: 0 },
		},
		additionalProperties: false,
	}, ["results", "succeeded", "failed", "indeterminate"]);
}

function contextBudgetBodySchema(): Record<string, unknown> {
	return withRequired(bodySchema({
		configurationId: stringSchema("Optional owned reusable inference configuration for a settings what-if; defaults to this participant's fixed configuration."),
		lang: requiredLanguageSchema("Selected bot language for this context budget estimate."),
		includeLanguageInSystemPrompt: { type: ["boolean", "null"], description: "Whether to include the selected language in the system prompt, or null to inherit." },
		displayName: localizedTextSchema("Bot display name for the estimate. lang must match the selected bot language."),
		prompt: localizedTextSchema("Bot prompt for the estimate. lang must match the selected bot language."),
		shortBio: localizedTextSchema("Bot short bio for the estimate. lang must match the selected bot language."),
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
