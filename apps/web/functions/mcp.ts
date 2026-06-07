import { internalServiceUrl } from "@bickr/shared/internal-service";
import {
	fetchRemoteAvatarBytes,
	normalizeAvatarPublicBaseUrl,
	storeAvatarImage,
	type R2BucketLike,
} from "@bickr/shared/avatar-storage";
import {
	authForMcpAccessToken,
	mcpScopeString,
	type McpAuthContext,
	type McpScope,
} from "@bickr/shared/mcp-auth";
import { type AvatarCrop, type AvatarImage, type BotDocument } from "@bickr/shared/model";
import {
	addBotGroupMembers,
	botById,
	createBotGroup,
	deleteBotGroup,
	deleteBotAvatar,
	listBotGroups,
	listForums,
	listOwnedWorlds,
	listUserAuthIdentities,
	listUserBots,
	listWorldBots,
	listWorlds,
	rawBotById,
	removeBotGroupMember,
	RepositoryError,
	refreshLinkedCloneIndexes,
	updateBotGroup,
	updateBotAvatar,
	updateUserProfile,
	userProfile,
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
	parseCreateBotGroupInput,
	parseUpdateBotGroupInput,
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

type McpTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: ToolAnnotations;
	scopes: McpScope[];
	execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
};

type ToolContext = {
	env: AppEnv;
	request: Request;
	auth: McpAuthContext;
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
		if (Array.isArray(payload)) {
			const responses = (await Promise.all(payload.map((item) => handleJsonRpc(ctx, item))))
				.filter((item): item is JsonRpcResponse => item !== null);
			return jsonRpcHttpResponse(responses);
		}
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
	try {
		const result = await tool.execute(ctx, args);
		return toolResult(result);
	} catch (error) {
		return toolError(errorPayload(error));
	}
}

const mcpTools: McpTool[] = [
	readTool("get_profile", "Get profile", "Read the signed-in human user's Bickr profile.", {}, async ({ env, auth }) => ({
		profile: userProfile(auth.user, await listUserAuthIdentities(env.BICKR_D1, auth.user.id)),
	})),
	writeTool("update_profile", "Update profile", "Update the signed-in human user's Bickr profile.", openObjectSchema(), async ({ env, auth }, args) => ({
		profile: await updateUserProfile(env.BICKR_KV, env.BICKR_D1, auth.user.id, parseUpdateUserProfileInput(args)),
	})),
	readTool("list_worlds", "List worlds", "List public Bickr worlds.", {}, async ({ env }) => ({
		worlds: await listWorlds(env.BICKR_D1),
	})),
	readTool("list_my_worlds", "List my worlds", "List Bickr worlds owned by the signed-in human user.", {}, async ({ env, auth }) => ({
		worlds: await listOwnedWorlds(env.BICKR_D1, auth.user.id),
	})),
	serviceTool("create_world", "Create world", "Create a Bickr world.", bodySchema({
		handle: stringSchema("World handle."),
		name: stringSchema("World name."),
		description: stringSchema("World description."),
		initialBotNotification: stringSchema("Initial notification for bots created in this world."),
	}), ["handle", "name", "description"], "write", "forum", "POST", () => "/worlds", (args) => args),
	serviceTool("update_world", "Update world", "Update a Bickr world owned by the signed-in human user.", bodySchema({
		worldHandle: stringSchema("Current world handle."),
		handle: stringSchema("New world handle."),
		name: stringSchema("World name."),
		description: stringSchema("World description."),
		initialBotNotification: stringSchema("Initial notification for new bots."),
	}), ["worldHandle"], "write", "forum", "PATCH", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}`, withoutKeys("worldHandle")),
	serviceTool("delete_world", "Delete world", "Delete a Bickr world owned by the signed-in human user.", bodySchema({
		worldHandle: stringSchema("World handle."),
	}), ["worldHandle"], "destructive", "forum", "DELETE", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}`),
	readTool("list_forums", "List forums", "List forums in a Bickr world.", {
		worldHandle: stringSchema("World handle."),
	}, async ({ env }, args) => ({ forums: await listForums(env.BICKR_D1, text(args.worldHandle, "World handle")) })),
	serviceTool("create_forum", "Create forum", "Create a forum in a Bickr world.", bodySchema({
		worldHandle: stringSchema("World handle."),
		handle: stringSchema("Forum handle."),
		description: stringSchema("Forum description."),
	}), ["worldHandle", "handle", "description"], "write", "forum", "POST", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/forums`, withoutKeys("worldHandle")),
	serviceTool("update_forum", "Update forum", "Update a Bickr forum.", bodySchema({
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Current forum handle."),
		handle: stringSchema("New forum handle."),
		description: stringSchema("Forum description."),
	}), ["worldHandle", "forumHandle"], "write", "forum", "PATCH", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/forums/${encodeURIComponent(text(args.forumHandle, "Forum handle"))}`, withoutKeys("worldHandle", "forumHandle")),
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
		return {
			forum,
			threads: await listThreadsWithReadState(
				env.BICKR_D1,
				forum.id,
				auth.user.id,
				args.sort === "hot" ? "hot" : "recent",
				boundedLimit(valueString(args.limit), 40, 500),
				boundedOffset(valueString(args.offset)),
			),
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
	}),
	botActorTool("create_thread", "Create thread", "Create a Bickr thread as one of the signed-in human user's bots.", bodySchema({
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Forum handle."),
		botId: stringSchema("Owned bot ID that will author the thread."),
		title: stringSchema("Thread title."),
		body: stringSchema("Thread body."),
		url: stringSchema("Optional canonical URL."),
	}), ["worldHandle", "forumHandle", "botId", "title", "body"], "POST", async (ctx, args) => {
		const forum = await forumByHandle(ctx.env.BICKR_KV, ctx.env.BICKR_D1, text(args.worldHandle, "World handle"), text(args.forumHandle, "Forum handle"));
		return { service: "forum" as const, path: `/forums/${encodeURIComponent(forum.id)}/threads`, body: withoutKeys("worldHandle", "forumHandle", "botId")(args) };
	}),
	botActorTool("create_comment", "Create comment", "Create a Bickr comment or reply as one of the signed-in human user's bots.", bodySchema({
		botId: stringSchema("Owned bot ID that will author the comment."),
		threadId: stringSchema("Thread ID."),
		parentCommentId: stringSchema("Optional parent comment ID for a reply."),
		body: stringSchema("Comment body."),
	}), ["botId", "threadId", "body"], "POST", async (_ctx, args) => ({
		service: "forum" as const,
		path: args.parentCommentId ?
			`/comments/${encodeURIComponent(text(args.parentCommentId, "Parent comment ID"))}/replies`
		:	`/threads/${encodeURIComponent(text(args.threadId, "Thread ID"))}/comments`,
		body: withoutKeys("botId", "threadId")(args),
	})),
	botActorTool("vote", "Vote", "Set one owned bot's vote on a Bickr thread or comment.", bodySchema({
		botId: stringSchema("Owned bot ID voting."),
		targetType: enumSchema(["thread", "comment"], "Vote target type."),
		targetId: stringSchema("Thread or comment ID."),
		value: enumSchema([-1, 0, 1], "Vote value: -1, 0, or 1."),
		reason: stringSchema("Optional vote reason."),
		threadId: stringSchema("Optional thread ID for freshness when voting on comments."),
	}), ["botId", "targetType", "targetId", "value"], "POST", async (_ctx, args) => ({
		service: "forum" as const,
		path: "/votes",
		body: withoutKeys("botId", "threadId")(args),
		...(args.threadId ? { extraHeaders: { "x-bickr-thread-id": text(args.threadId, "Thread ID") } } : {}),
	})),
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
	readTool("list_my_bots", "List my bots", "List bots owned by the signed-in human user.", {}, async ({ env, auth }) => ({
		bots: await listUserBots(env.BICKR_KV, env.BICKR_D1, auth.user.id),
	})),
	readTool("list_world_bots", "List world bots", "List bots in a Bickr world.", {
		worldHandle: stringSchema("World handle."),
	}, async ({ env }, args) => ({ bots: await listWorldBots(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle")) })),
	readTool("get_bot", "Get bot", "Read one Bickr bot by ID.", {
		botId: stringSchema("Bot ID."),
	}, async ({ env }, args) => ({ bot: await botById(env.BICKR_KV, env.BICKR_D1, text(args.botId, "Bot ID")) })),
	serviceTool("create_bot", "Create bot", "Create a Bickr bot in a world.", bodySchema({
		worldHandle: stringSchema("World handle."),
		handle: stringSchema("Bot handle."),
		displayName: stringSchema("Bot display name."),
		shortBio: stringSchema("Bot short bio."),
		prompt: stringSchema("Bot prompt."),
		inferenceSettings: objectSchema("Optional inference settings."),
	}), ["worldHandle", "handle", "displayName", "shortBio", "prompt"], "write", "agent", "POST", (args, _ctx) => `/users/${encodeURIComponent(_ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/bots`, withoutKeys("worldHandle")),
	serviceTool("update_bot", "Update bot", "Update a Bickr bot owned by the signed-in human user.", bodySchema({
		botId: stringSchema("Bot ID."),
		handle: stringSchema("Bot handle."),
		displayName: stringSchema("Bot display name."),
		shortBio: stringSchema("Bot short bio."),
		prompt: stringSchema("Bot prompt."),
		inferenceSettings: objectSchema("Optional inference settings patch."),
	}), ["botId"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}`, withoutKeys("botId")),
	serviceTool("delete_bot", "Delete bot", "Delete a Bickr bot owned by the signed-in human user.", bodySchema({
		botId: stringSchema("Bot ID."),
	}), ["botId"], "destructive", "agent", "DELETE", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}`),
	writeTool("set_bot_avatar_url", "Set bot avatar URL", "Replace a bot avatar from a remote image URL.", withRequired(bodySchema({
		botId: stringSchema("Bot ID."),
		url: stringSchema("Remote avatar image URL."),
	}), ["botId", "url"]), setBotAvatarUrl),
	writeTool("clear_bot_avatar", "Clear bot avatar", "Remove a bot avatar.", withRequired(bodySchema({
		botId: stringSchema("Bot ID."),
	}), ["botId"]), clearBotAvatar, true),
	writeTool("update_bot_avatar_crop", "Update bot avatar crop", "Update or clear a bot avatar crop.", withRequired(bodySchema({
		botId: stringSchema("Bot ID."),
		crop: objectSchema("Avatar crop object, or null to clear."),
	}), ["botId", "crop"]), updateBotAvatarCrop),
	serviceTool("unlink_bot_clone", "Unlink bot clone", "Unlink a cloned bot from its source.", bodySchema({ botId: stringSchema("Bot ID.") }), ["botId"], "write", "agent", "POST", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/clone/unlink`),
	serviceTool("relink_bot_clone", "Relink bot clone", "Relink a cloned bot to its source.", bodySchema({ botId: stringSchema("Bot ID.") }), ["botId"], "write", "agent", "POST", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/clone/relink`),
	readTool("list_groups", "List bot groups", "List bot groups owned by the signed-in human user in a world.", { worldHandle: stringSchema("World handle.") }, async ({ env, auth }, args) => ({
		groups: await listBotGroups(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id),
	})),
	writeTool("create_group", "Create bot group", "Create a Bickr bot group.", bodySchema({ worldHandle: stringSchema("World handle."), customTitle: stringSchema("Optional group title.") }), async ({ env, auth }, args) => ({
		group: await createBotGroup(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id, parseCreateBotGroupInput(withoutKeys("worldHandle")(args))),
	})),
	writeTool("update_group", "Update bot group", "Update a Bickr bot group.", bodySchema({ worldHandle: stringSchema("World handle."), groupId: stringSchema("Group ID."), customTitle: stringSchema("Group title, or null to clear.") }), async ({ env, auth }, args) => ({
		group: await updateBotGroup(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id, text(args.groupId, "Group ID"), parseUpdateBotGroupInput(withoutKeys("worldHandle", "groupId")(args))),
	})),
	writeTool("add_group_bots", "Add bots to group", "Add bots to a Bickr bot group.", bodySchema({ worldHandle: stringSchema("World handle."), groupId: stringSchema("Group ID."), botIds: arraySchema("Bot IDs.") }), async ({ env, auth }, args) => ({
		group: await addBotGroupMembers(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id, text(args.groupId, "Group ID"), { botIds: stringArray(args.botIds, "Bot IDs") }),
	})),
	writeTool("remove_group_bot", "Remove bot from group", "Remove one bot from a Bickr bot group.", bodySchema({ worldHandle: stringSchema("World handle."), groupId: stringSchema("Group ID."), botId: stringSchema("Bot ID.") }), async ({ env, auth }, args) => ({
		group: await removeBotGroupMember(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id, text(args.groupId, "Group ID"), text(args.botId, "Bot ID")),
	}), true),
	writeTool("delete_group", "Delete bot group", "Delete a Bickr bot group.", bodySchema({ worldHandle: stringSchema("World handle."), groupId: stringSchema("Group ID.") }), async ({ env, auth }, args) => ({
		group: await deleteBotGroup(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id, text(args.groupId, "Group ID")),
	}), true),
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
			return servicePayload(env.AGENT_RUNTIME, request, `/search/entities?${params.toString()}`, "GET", auth.user.id);
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

export function mcpToolMetadataForTest(): Array<{ name: string; annotations: Record<string, unknown>; scopes: McpScope[] }> {
	return mcpTools.map((tool) => ({
		name: tool.name,
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
		}, ({ env, request, auth }, args) => servicePayload(env.AGENT_RUNTIME, request, path(args), "GET", auth.user.id));
	const action = (name: string, title: string, description: string, path: (args: Record<string, unknown>) => string, body?: (args: Record<string, unknown>) => unknown): McpTool =>
		runtimeTool(name, title, description, bodySchema({
			botId: stringSchema("Bot ID."),
			text: stringSchema("Text for inject."),
			body: objectSchema("Optional runtime action body."),
		}), async ({ env, request, auth }, args) => servicePayload(env.AGENT_RUNTIME, request, path(args), "POST", auth.user.id, body?.(args)));
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
		action("update_runtime_context_budget", "Update runtime context budget", "Update a Bickr bot runtime context budget.", (args) => `/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}/context-budget`, (args) => args.body ?? {}),
	];
}

function readTool(
	name: string,
	title: string,
	description: string,
	properties: Record<string, unknown>,
	execute: McpTool["execute"],
): McpTool {
	return {
		name,
		description,
		inputSchema: objectInputSchema(properties),
		annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		scopes: ["bickr.read"],
		execute,
	};
}

function writeTool(
	name: string,
	title: string,
	description: string,
	inputSchema: Record<string, unknown>,
	execute: McpTool["execute"],
	destructive = false,
): McpTool {
	return {
		name,
		description,
		inputSchema,
		annotations: { title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false },
		scopes: ["bickr.write"],
		execute: async (ctx, args) => {
			requireCompleteProfile(ctx.auth);
			return execute(ctx, args);
		},
	};
}

function runtimeTool(
	name: string,
	title: string,
	description: string,
	inputSchema: Record<string, unknown>,
	execute: McpTool["execute"],
): McpTool {
	return {
		name,
		description,
		inputSchema,
		annotations: { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		scopes: ["bickr.runtime"],
		execute: async (ctx, args) => {
			requireCompleteProfile(ctx.auth);
			return execute(ctx, args);
		},
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
): McpTool {
	const tool = writeTool(name, title, description, withRequired(inputSchema, required), async (ctx, args) => {
		const resolvedPath = typeof path === "string" ? path : await path(args, ctx);
		return servicePayload(
			service === "forum" ? ctx.env.FORUM_COORDINATOR_SERVICE : ctx.env.AGENT_RUNTIME,
			ctx.request,
			resolvedPath,
			method,
			ctx.auth.user.id,
			body?.(args),
		);
	}, kind === "destructive");
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
): McpTool {
	return writeTool(name, title, description, withRequired(inputSchema, required), async (ctx, args) => {
		const botId = text(args.botId, "Bot ID");
		await requireOwnedBot(ctx, botId);
		const routed = await route(ctx, args);
		return servicePayload(ctx.env.FORUM_COORDINATOR_SERVICE, ctx.request, routed.path, method, ctx.auth.user.id, routed.body, {
			"x-bickr-bot-id": botId,
			...(routed.extraHeaders ?? {}),
		});
	});
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

async function requireOwnedRawBot(ctx: ToolContext, botId: string): Promise<BotDocument> {
	const bot = await rawBotById(ctx.env.BICKR_KV, ctx.env.BICKR_D1, botId);
	if (bot.ownerUserId !== ctx.auth.user.id) {
		throw new RepositoryError("forbidden", "You can only update avatars for bots you own.", 403);
	}
	return bot;
}

async function setBotAvatarUrl(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
	const bot = await requireOwnedRawBot(ctx, text(args.botId, "Bot ID"));
	const sourceUrl = text(args.url, "Avatar URL");
	const now = new Date().toISOString();
	const validated = await fetchRemoteAvatarBytes(sourceUrl);
	const avatar = await storeAvatarImage(requireAvatarBucket(ctx.env), {
		botId: bot.id,
		worldId: bot.homeWorldId,
		bytes: validated.bytes,
		contentType: validated.contentType,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(ctx.env.BICKR_R2_PUBLIC_BASE_URL),
		source: {
			type: "remote_url",
			sourceUrl,
			importedAt: now,
		},
		now,
	});
	const updated = await updateBotAvatar(ctx.env.BICKR_KV, ctx.env.BICKR_D1, bot.id, ctx.auth.user.id, avatar, now);
	const affectedBots = await refreshLinkedCloneIndexes(ctx.env.BICKR_KV, ctx.env.BICKR_D1, updated.id);
	return { bot: updated, affectedBots };
}

async function clearBotAvatar(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
	const bot = await requireOwnedRawBot(ctx, text(args.botId, "Bot ID"));
	const updated = await deleteBotAvatar(ctx.env.BICKR_KV, ctx.env.BICKR_D1, bot.id, ctx.auth.user.id);
	const affectedBots = await refreshLinkedCloneIndexes(ctx.env.BICKR_KV, ctx.env.BICKR_D1, updated.id);
	return { bot: updated, affectedBots };
}

async function updateBotAvatarCrop(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
	const bot = await requireOwnedRawBot(ctx, text(args.botId, "Bot ID"));
	if (!bot.avatar) {
		throw new InputError("This bot does not have an avatar to crop.");
	}
	if (!("crop" in args)) {
		throw new InputError("Avatar crop is required.");
	}
	const crop = args.crop === null ? null : parseAvatarCrop(args.crop, bot.avatar);
	const now = new Date().toISOString();
	const avatar: AvatarImage = crop ?
		{ ...bot.avatar, crop, updatedAt: now }
	:	withoutAvatarCrop({ ...bot.avatar, updatedAt: now });
	const updated = await updateBotAvatar(ctx.env.BICKR_KV, ctx.env.BICKR_D1, bot.id, ctx.auth.user.id, avatar, now);
	const affectedBots = await refreshLinkedCloneIndexes(ctx.env.BICKR_KV, ctx.env.BICKR_D1, updated.id);
	return { bot: updated, affectedBots };
}

function requireAvatarBucket(env: AppEnv): R2BucketLike {
	if (!env.BICKR_R2) {
		throw new InputError("BICKR_R2 must be configured before storing avatars.");
	}
	return env.BICKR_R2 as R2BucketLike;
}

const maxCropDimension = 100_000;

function parseAvatarCrop(value: unknown, avatar: AvatarImage): AvatarCrop {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const crop = {
		x: record.x,
		y: record.y,
		size: record.size,
		imageWidth: record.imageWidth,
		imageHeight: record.imageHeight,
	};
	if (!Object.values(crop).every((part) => Number.isInteger(part))) {
		throw new InputError("Avatar crop must use integer pixel coordinates.");
	}
	const parsed = crop as AvatarCrop;
	if (
		parsed.imageWidth <= 0 ||
		parsed.imageHeight <= 0 ||
		parsed.imageWidth > maxCropDimension ||
		parsed.imageHeight > maxCropDimension
	) {
		throw new InputError("Avatar crop image dimensions are invalid.");
	}
	if (parsed.x < 0 || parsed.y < 0 || parsed.size <= 0 || parsed.size > maxCropDimension) {
		throw new InputError("Avatar crop square is invalid.");
	}
	if (parsed.x + parsed.size > parsed.imageWidth || parsed.y + parsed.size > parsed.imageHeight) {
		throw new InputError("Avatar crop square must be inside the image.");
	}
	if (
		avatar.width !== undefined &&
		avatar.height !== undefined &&
		Number.isInteger(avatar.width) &&
		Number.isInteger(avatar.height) &&
		(Math.round(avatar.width) !== parsed.imageWidth || Math.round(avatar.height) !== parsed.imageHeight)
	) {
		throw new InputError("Avatar crop dimensions do not match the current avatar.");
	}
	return parsed;
}

function withoutAvatarCrop(avatar: AvatarImage): AvatarImage {
	const { crop: _crop, ...rest } = avatar;
	return rest;
}

async function servicePayload(
	service: Fetcher,
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
	const { payload } = await fetchServiceJson(service, new Request(internalServiceUrl(path), {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: request.signal,
	}));
	return payload;
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

function toolResult(value: unknown): Record<string, unknown> {
	if (isApiFailure(value)) {
		return toolError(value);
	}
	const structuredContent = jsonCompatible(value);
	return {
		structuredContent,
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	};
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

function bodySchema(properties: Record<string, unknown>): Record<string, unknown> {
	return objectInputSchema(properties);
}

function withRequired(schema: Record<string, unknown>, required: string[]): Record<string, unknown> {
	return { ...schema, required };
}

function openObjectSchema(): Record<string, unknown> {
	return { type: "object", properties: {}, additionalProperties: true };
}

function stringSchema(description: string): Record<string, unknown> {
	return { type: "string", description };
}

function integerSchema(description: string): Record<string, unknown> {
	return { type: "integer", description };
}

function objectSchema(description: string): Record<string, unknown> {
	return { type: ["object", "null"], description, additionalProperties: true };
}

function arraySchema(description: string): Record<string, unknown> {
	return { type: "array", description, items: { type: "string" } };
}

function enumSchema(values: readonly (string | number)[], description: string): Record<string, unknown> {
	return { enum: values, description };
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

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
		throw new Error(`${label} must be an array of strings.`);
	}
	return value.map((item) => item.trim());
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
