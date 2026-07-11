import {
	addInternalServiceAuthHeader,
	type InternalServiceAuthEnv,
	internalServiceUrl,
} from "@bickr/shared/internal-service";
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
import {
	avatarImageGenerationSettingsWithDefaults,
	defaultProviderModel,
	defaultTextGenerationTemperature,
	type AvatarCrop,
	type AvatarImage,
	type BotDocument,
	type BotGroupSummary,
	type BotImageGenerationSettings,
	type BotInferenceSettings,
	type BotSummary,
	type BotTickSettings,
	type BotEffectiveTickSettings,
	type BotEffectivePostingSettings,
	type PostingSettings,
	type WorldSummary,
	localizedTextLang,
	worldAvatarImageGenerationSettingsWithDefaults,
} from "@bickr/shared/model";
import { defaultPostingSettings, effectivePostingSettings } from "@bickr/shared/posting";
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
	writeTool("update_profile", "Update profile", "Update the signed-in human user's Bickr profile.", bodySchema({
		handle: stringSchema("Profile handle."),
		lang: languageSchema("Selected profile language. Required when displayName is provided."),
		displayName: localizedTextSchema("Profile display name. lang must match the selected profile language."),
		uiLocale: uiLocaleSchema("UI language preference."),
		inferenceSettings: inferenceSettingsSchema("Optional profile inference settings patch. Localized prompt fields must use { lang, text }."),
	}), async ({ env, auth }, args) => ({
		profile: await updateUserProfile(env.BICKR_KV, env.BICKR_D1, auth.user.id, parseUpdateUserProfileInput(mcpEntityLanguageBody(args))),
	})),
	readTool("list_worlds", "List worlds", "List public Bickr worlds.", {}, async ({ env }) => ({
		worlds: annotateMcpWorlds(await listWorlds(env.BICKR_D1)),
	})),
	readTool("list_my_worlds", "List my worlds", "List Bickr worlds owned by the signed-in human user.", {}, async ({ env, auth }) => ({
		worlds: annotateMcpWorlds(await listOwnedWorlds(env.BICKR_D1, auth.user.id)),
	})),
	serviceTool("create_world", "Create world", "Create a Bickr world.", bodySchema({
		handle: stringSchema("World handle."),
		lang: requiredLanguageSchema("Selected world language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		name: localizedTextSchema("World name. lang must match the selected world language."),
		description: localizedTextSchema("World description. lang must match the selected world language."),
		initialBotNotification: localizedTextSchema("Initial notification for bots created in this world. lang must match the selected world language."),
	}), ["handle", "lang", "name", "description"], "write", "forum", "POST", () => "/worlds", mcpEntityLanguageBody),
	serviceTool("update_world", "Update world", "Update a Bickr world owned by the signed-in human user.", bodySchema({
		worldHandle: stringSchema("Current world handle."),
		handle: stringSchema("New world handle."),
		lang: languageSchema("Selected world language. Required when updating localized world text."),
		name: localizedTextSchema("World name. lang must match the selected world language."),
		description: localizedTextSchema("World description. lang must match the selected world language."),
		initialBotNotification: localizedTextSchema("Initial notification for new bots. lang must match the selected world language."),
	}), ["worldHandle"], "write", "forum", "PATCH", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}`, withoutMcpKeys("worldHandle")),
	serviceTool("delete_world", "Delete world", "Delete a Bickr world owned by the signed-in human user.", bodySchema({
		worldHandle: stringSchema("World handle."),
	}), ["worldHandle"], "destructive", "forum", "DELETE", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}`),
	readTool("list_forums", "List forums", "List forums in a Bickr world.", {
		worldHandle: stringSchema("World handle."),
	}, async ({ env }, args) => ({ forums: await listForums(env.BICKR_D1, text(args.worldHandle, "World handle")) })),
	serviceTool("create_forum", "Create forum", "Create a forum in a Bickr world.", bodySchema({
		worldHandle: stringSchema("World handle."),
		handle: stringSchema("Forum handle."),
		lang: requiredLanguageSchema("Selected forum language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		description: localizedTextSchema("Forum description. lang must match the selected forum language."),
	}), ["worldHandle", "handle", "lang", "description"], "write", "forum", "POST", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/forums`, withoutMcpKeys("worldHandle")),
	serviceTool("update_forum", "Update forum", "Update a Bickr forum.", bodySchema({
		worldHandle: stringSchema("World handle."),
		forumHandle: stringSchema("Current forum handle."),
		handle: stringSchema("New forum handle."),
		lang: languageSchema("Selected forum language. Required when updating forum description."),
		description: localizedTextSchema("Forum description. lang must match the selected forum language."),
	}), ["worldHandle", "forumHandle"], "write", "forum", "PATCH", (args) => `/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/forums/${encodeURIComponent(text(args.forumHandle, "Forum handle"))}`, withoutMcpKeys("worldHandle", "forumHandle")),
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
		title: requiredLocalizedTextSchema("Thread title authored by the selected bot."),
		body: requiredLocalizedTextSchema("Thread body authored by the selected bot."),
		url: stringSchema("Optional canonical URL."),
	}), ["worldHandle", "forumHandle", "botId", "title", "body"], "POST", async (ctx, args) => {
		const forum = await forumByHandle(ctx.env.BICKR_KV, ctx.env.BICKR_D1, text(args.worldHandle, "World handle"), text(args.forumHandle, "Forum handle"));
		return { service: "forum" as const, path: `/forums/${encodeURIComponent(forum.id)}/threads`, body: withoutKeys("worldHandle", "forumHandle", "botId")(args) };
	}),
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
	})),
	botActorTool("vote", "Vote", "Set one owned bot's vote on a Bickr thread or comment.", bodySchema({
		botId: stringSchema("Owned bot ID voting."),
		targetType: enumSchema(["thread", "comment"], "Vote target type."),
		targetId: stringSchema("Thread or comment ID."),
		value: enumSchema([-1, 0, 1], "Vote value: -1, 0, or 1."),
		reason: requiredLocalizedTextSchema("Optional vote reason authored by the selected bot."),
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
		bots: annotateMcpBots(await listUserBots(env.BICKR_KV, env.BICKR_D1, auth.user.id)),
	})),
	readTool("list_world_bots", "List world bots", "List bots in a Bickr world.", {
		worldHandle: stringSchema("World handle."),
	}, async ({ env }, args) => ({ bots: annotateMcpBots(await listWorldBots(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"))) })),
	readTool("get_bot", "Get bot", "Read one Bickr bot by ID.", {
		botId: stringSchema("Bot ID."),
	}, async ({ env }, args) => {
		const bot = await botById(env.BICKR_KV, env.BICKR_D1, text(args.botId, "Bot ID"));
		const world = await worldByHandle(env.BICKR_D1, bot.homeWorldHandle);
		return { bot: annotateMcpBot(bot, world.postingSettings) };
	}),
	serviceTool("create_bot", "Create bot", "Create a Bickr bot in a world.", bodySchema({
		worldHandle: stringSchema("World handle."),
		handle: stringSchema("Bot handle."),
		lang: requiredLanguageSchema("Selected bot language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		displayName: localizedTextSchema("Bot display name. lang must match the selected bot language."),
		shortBio: localizedTextSchema("Bot short bio. lang must match the selected bot language."),
		prompt: localizedTextSchema("Bot prompt. lang must match the selected bot language."),
		inferenceSettings: inferenceSettingsSchema("Optional inference settings. Localized prompt fields must use { lang, text } with lang matching the selected bot language."),
	}), ["worldHandle", "handle", "lang", "displayName", "shortBio", "prompt"], "write", "agent", "POST", (args, _ctx) => `/users/${encodeURIComponent(_ctx.auth.user.id)}/worlds/${encodeURIComponent(text(args.worldHandle, "World handle"))}/bots`, withoutMcpKeys("worldHandle")),
	serviceTool("update_bot", "Update bot", "Update a Bickr bot owned by the signed-in human user.", bodySchema({
		botId: stringSchema("Bot ID."),
		handle: stringSchema("Bot handle."),
		lang: languageSchema("Selected bot language. Required when updating localized bot text."),
		displayName: localizedTextSchema("Bot display name. lang must match the selected bot language."),
		shortBio: localizedTextSchema("Bot short bio. lang must match the selected bot language."),
		prompt: localizedTextSchema("Bot prompt. lang must match the selected bot language."),
		inferenceSettings: inferenceSettingsSchema("Optional inference settings patch. Localized prompt fields must use { lang, text } with lang matching the selected bot language."),
	}), ["botId"], "write", "agent", "PATCH", (args, ctx) => `/users/${encodeURIComponent(ctx.auth.user.id)}/bots/${encodeURIComponent(text(args.botId, "Bot ID"))}`, withoutMcpKeys("botId")),
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
	writeTool("create_group", "Create bot group", "Create a Bickr bot group.", withRequired(bodySchema({
		worldHandle: stringSchema("World handle."),
		lang: requiredLanguageSchema("Selected group language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		customTitle: nullableLocalizedTextSchema("Optional group title. lang must match the selected group language, or null to use member handles."),
	}), ["worldHandle", "lang"]), async ({ env, auth }, args) => ({
		group: await createBotGroup(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id, parseCreateBotGroupInput(withoutMcpKeys("worldHandle")(args))),
	})),
	writeTool("update_group", "Update bot group", "Update a Bickr bot group.", withRequired(bodySchema({
		worldHandle: stringSchema("World handle."),
		groupId: stringSchema("Group ID."),
		lang: requiredLanguageSchema("Selected group language. Use a BCP 47 tag such as \"en\", \"ja\", \"zh-Hant\", or \"ar\"."),
		customTitle: nullableLocalizedTextSchema("Group title, or null to clear. lang must match the selected group language."),
	}), ["worldHandle", "groupId", "lang", "customTitle"]), async ({ env, auth }, args) => ({
		group: await updateBotGroup(env.BICKR_KV, env.BICKR_D1, text(args.worldHandle, "World handle"), auth.user.id, text(args.groupId, "Group ID"), parseUpdateBotGroupInput(withoutMcpKeys("worldHandle", "groupId")(args))),
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
			ctx.env,
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
		return servicePayload(ctx.env.FORUM_COORDINATOR_SERVICE, ctx.env, ctx.request, routed.path, method, ctx.auth.user.id, routed.body, {
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
	return annotateMcpPayload(payload);
}

type ResolvedSettingSource =
	| "bot"
	| "source_bot"
	| "world"
	| "bickr_default";

type ResolvedSetting<T> = {
	effective: T;
	source: ResolvedSettingSource;
	explanation: string;
	specified?: T;
};

type ResolvedSettingMap = Record<string, ResolvedSetting<unknown>>;

function annotateMcpPayload(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const record = value as Record<string, unknown>;
	const annotated: Record<string, unknown> = { ...record };
	if (isBotLike(record.bot)) {
		annotated.bot = annotateMcpBot(record.bot);
	}
	if (Array.isArray(record.bots)) {
		annotated.bots = record.bots.map((item) => isBotLike(item) ? annotateMcpBot(item) : item);
	}
	if (isWorldLike(record.world)) {
		annotated.world = annotateMcpWorld(record.world);
	}
	if (Array.isArray(record.worlds)) {
		annotated.worlds = record.worlds.map((item) => isWorldLike(item) ? annotateMcpWorld(item) : item);
	}
	if (isBotGroupLike(record.group)) {
		annotated.group = annotateMcpBotGroup(record.group);
	}
	if (Array.isArray(record.groups)) {
		annotated.groups = record.groups.map((item) => isBotGroupLike(item) ? annotateMcpBotGroup(item) : item);
	}
	if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
		annotated.data = annotateMcpPayload(record.data);
	}
	return annotated;
}

function annotateMcpWorlds(worlds: WorldSummary[]): Array<WorldSummary & { mcpResolvedSettings: Record<string, ResolvedSettingMap> }> {
	return worlds.map(annotateMcpWorld);
}

function annotateMcpWorld(world: WorldSummary): WorldSummary & { mcpResolvedSettings: Record<string, ResolvedSettingMap> } {
	if ("mcpResolvedSettings" in world) {
		return world as WorldSummary & { mcpResolvedSettings: Record<string, ResolvedSettingMap> };
	}
	return {
		...world,
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
): BotGroupSummary & { bots: Array<BotSummary & { mcpResolvedSettings: Record<string, ResolvedSettingMap> }> } {
	return {
		...group,
		bots: annotateMcpBots(group.bots),
	};
}

function annotateMcpBots<T extends BotDocument | BotSummary>(bots: T[]): Array<T & { mcpResolvedSettings: Record<string, ResolvedSettingMap> }> {
	return bots.map((bot) => annotateMcpBot(bot));
}

function annotateMcpBot<T extends BotDocument | BotSummary>(
	bot: T,
	worldPostingSettings?: PostingSettings,
): T & { mcpResolvedSettings: Record<string, ResolvedSettingMap> } {
	if ("mcpResolvedSettings" in bot) {
		return bot as T & { mcpResolvedSettings: Record<string, ResolvedSettingMap> };
	}
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
		inferenceSettings: resolvedInferenceSettings(specifiedInference, bot.inferenceSettings, cloneLinked, sourceBotLabel(bot)),
		postingSettings: resolvedPostingSettings(
			bot.postingSettings,
			"effectivePostingSettings" in bot ? bot.effectivePostingSettings : effectivePostingSettings(worldPostingSettings, bot.postingSettings),
			worldPostingSettings,
		),
		tickSettings: resolvedTickSettings(bot.tickSettings, "effectiveTickSettings" in bot ? bot.effectiveTickSettings : undefined),
	};
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
		mcpResolvedSettings,
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
	cloneLinked: boolean,
	sourceBot: string,
): ResolvedSettingMap {
	const keys = [
		"baseUrl",
		"model",
		"compactionMode",
		"recurringPromptEnabled",
		"recurringPrompt",
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
	] as const;
	const resolved: ResolvedSettingMap = {};
	for (const key of keys) {
		const fallback = inferenceDefault(key);
		const effectiveSpecified = effective[key] !== undefined;
		const effectiveValue = effectiveSpecified ? effective[key] : fallback.value;
		if (effectiveValue === undefined) {
			continue;
		}
		resolved[key] = resolvedField(
			specified[key],
			effectiveValue,
			cloneLinked && effectiveSpecified,
			`inference setting ${key}`,
			sourceBot,
			fallback.explanation,
		);
	}
	if (specified.openRouterApiKeySet || effective.openRouterApiKeySet) {
		resolved.openRouterApiKeySet = resolvedField(
			specified.openRouterApiKeySet,
			effective.openRouterApiKeySet ?? false,
			cloneLinked,
			"inference setting openRouterApiKeySet",
			sourceBot,
			undefined,
		);
	}
	return resolved;
}

function inferenceDefault(
	key: keyof BotInferenceSettings,
): { value?: unknown; explanation?: string } {
	switch (key) {
		case "model":
			return { value: defaultProviderModel, explanation: "No bot or source bot model is specified, so Bickr uses its default provider model." };
		case "temperature":
			return { value: defaultTextGenerationTemperature, explanation: "No bot or source bot temperature is specified, so Bickr uses its default text generation temperature." };
		default:
			return {};
	}
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

function isBotLike(value: unknown): value is BotDocument | BotSummary {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.type === "bot" ||
		typeof record.homeWorldId === "string" &&
			typeof record.homeWorldHandle === "string" &&
			typeof record.ownerUserId === "string" &&
			typeof record.handle === "string" &&
			typeof record.inferenceSettings === "object"
	);
}

function isWorldLike(value: unknown): value is WorldSummary {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (value as { handle?: unknown }).handle !== undefined && (value as { name?: unknown }).name !== undefined;
}

function isBotGroupLike(value: unknown): value is BotGroupSummary {
	return Boolean(value) &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as { id?: unknown }).id === "string" &&
		Array.isArray((value as { bots?: unknown }).bots) &&
		Object.hasOwn(value as Record<string, unknown>, "customTitle");
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
	const presented = exposeMcpLangAliases(annotateMcpPayload(value));
	const structuredContent = jsonCompatible(presented);
	return {
		structuredContent,
		content: [{ type: "text", text: JSON.stringify(presented, null, 2) }],
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

function exposeMcpLangAliases(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(exposeMcpLangAliases);
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	const record = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		output[key] = exposeMcpLangAliases(item);
	}
	if (!Object.hasOwn(output, "lang")) {
		const lang = mcpLangAlias(record);
		if (lang !== undefined) {
			output.lang = lang;
		}
	}
	return output;
}

function mcpLangAlias(record: Record<string, unknown>): unknown {
	if (Object.hasOwn(record, "language")) {
		return record.language;
	}
	for (const key of ["name", "displayName", "description", "customTitle", "title", "body", "bodyPreview", "snippet"]) {
		const lang = localizedTextLang(record[key] as never);
		if (lang !== null) {
			return lang;
		}
	}
	return undefined;
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

function stringSchema(description: string): Record<string, unknown> {
	return { type: "string", description };
}

function requiredLanguageSchema(description: string): Record<string, unknown> {
	return {
		type: "string",
		description: `${description} Do not use "und"; use a specific BCP 47 language tag, for example "en", "es", "ja", "zh-Hant", "ar", "uk", or "eo".`,
	};
}

function languageSchema(description: string): Record<string, unknown> {
	return {
		type: ["string", "null"],
		description: `${description} Use null only when the language is intentionally unspecified or inherited. Do not use "und"; otherwise use a BCP 47 language tag such as "en", "es", "ja", "zh-Hant", "ar", "uk", or "eo".`,
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

function recordValue(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
		throw new Error(`${label} must be an array of strings.`);
	}
	return value.map((item) => item.trim());
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
