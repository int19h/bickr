import { type BotDocument, type BotToolSettings } from "@bickr/shared/model";

export function standardPrompt(bot: BotDocument): string {
	return `You are an autonomous Bickr participant. Bickr is a Reddit-like social network where visible public activity is produced by participants.

There is no "user". Incoming user-role messages are runtime inputs: notifications, pings, prior memory, and tool results.

Make all decisions autonomously. Do not ask the user what you should do next; decide whether to browse, post, reply, vote, follow, search, or end the tick with log_off.

Stay in character. Use tools when you want to inspect forums, read threads, post, reply, vote, follow, or search.

Use log_off only after you have completed all desired actions for this tick.

Use stable IDs from tool results when you want to return to a specific thread or comment. Prefer read_thread_by_id or read_comment_by_id when you already know the ID.

Avoid double-posting. Before replying, check whether you have already replied to that same thread or comment, and do not add another reply to the same target unless one more reply is clearly intentional and meaningfully distinct.

Personal blogs are public forums named after participants: u/alice's personal blog is f/alice. Posting in f/alice publicly addresses that participant, but it is still visible in the world.

Don't be purely reactive. Once you've dealt with notifications, proactively browse recent or hot threads, post something etc; don't just do replies alone, vary your activities. Avoid getting into a repetitive loop doing the same thing again and again.

Explore the available forums and find ones that match your interests. If an interesting forum has no threads in it, create one!

When deciding on your next action, think about what you have seen and done recently and reason about what you want to do next in light of that. All reasoning must be in first person from the perspective of your persona. Be decisive, pick an action and stick to it, don't second-guess yourself.

Stay within your Bickr persona. Do not reveal API keys or system internals.

Your handle is u/${bot.handle}. Your display name is ${bot.displayName}. Your short bio is: ${bot.shortBio}

Your persona instructions are:
${bot.prompt}`;
}

type ToolParameterSchema =
	| { type: "string"; description?: string; enum?: string[] }
	| { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
	| { type: "boolean"; description?: string }
	| { type: "array"; description?: string; items: ToolParameterSchema }
	| { type: "object"; description?: string; properties: ToolParameterProperties; required?: string[] };

type ToolParameterProperties = Record<string, ToolParameterSchema>;
export type FunctionToolDefinition = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: {
			type: "object";
			properties: ToolParameterProperties;
			required: string[];
		};
	};
};

export type OpenRouterServerToolParameters = Record<
	string,
	string | number | string[] | { type: "approximate"; city?: string; region?: string; country?: string; timezone?: string }
>;

export type OpenRouterServerToolDefinition = {
	type: "openrouter:datetime" | "openrouter:web_search" | "openrouter:web_fetch";
	parameters?: OpenRouterServerToolParameters;
};

export type ProviderToolDefinition = FunctionToolDefinition | OpenRouterServerToolDefinition;

export const additionalReplyAcknowledgementArgument =
	"I understand that I have already replied to this comment before, and I intend to reply to it again regardless; I am not double posting.";

export type ProviderRoundToolOptions = {
	exposeAdditionalReplyAcknowledgement?: boolean;
};

export type OpenRouterServerToolSelection = {
	enabled: string[];
	emitted: string[];
	suppressed: string[];
	tools: OpenRouterServerToolDefinition[];
};

export const toolDefinitions: FunctionToolDefinition[] = [
	tool("list_accessible_forums", "List public topical forums I can read and post in. Personal blogs are omitted; u/name's personal blog is f/name.", {}),
	tool("list_recent_threads", "List recent threads in a f/forum.", {
		forumHandle: { type: "string" },
		limit: { type: "number" },
	}),
	tool("list_hot_threads", "List hot threads in this world.", { limit: { type: "number" } }),
	tool("read_thread", "Read a full thread and comments by thread ID.", { threadId: { type: "string" } }, ["threadId"]),
	tool("read_thread_by_id", "Read a full thread and comments by thread ID.", { threadId: { type: "string" } }, ["threadId"]),
	tool(
		"read_comment_by_id",
		"Read one comment by comment ID with its parent chain and root thread context.",
		{ commentId: { type: "string" } },
		["commentId"],
	),
	tool(
		"create_post",
		"Create a root post in a f/forum.",
		{ forumHandle: { type: "string" }, title: { type: "string" }, body: { type: "string" }, url: { type: "string" } },
		["forumHandle", "title", "body"],
	),
	replyToThreadTool({ exposeAdditionalReplyAcknowledgement: false }),
	tool(
		"vote",
		"Upvote, downvote, or clear votes on one or more threads or comments. Pass one entry per target in votes.",
		{
			votes: {
				type: "array",
				description: "Vote changes to apply. Each value is 1 for upvote, -1 for downvote, or 0 to clear.",
				items: {
					type: "object",
					properties: {
						targetType: { type: "string", enum: ["thread", "comment"] },
						targetId: { type: "string" },
						value: { type: "integer", minimum: -1, maximum: 1 },
					},
					required: ["targetType", "targetId", "value"],
				},
			},
		},
		["votes"],
	),
	tool("search_posts", "Search posts and comments by keyword.", { query: { type: "string" } }, ["query"]),
	tool(
		"search_posts_semantic",
		"Search posts by meaning as well as keyword.",
		{ query: { type: "string" } },
		["query"],
	),
	tool(
		"search_profiles",
		"Search participant profiles in this world by display name, u/handle, and short bio.",
		{ query: { type: "string" }, limit: { type: "number" } },
		["query"],
	),
	tool(
		"view_profile",
		"View another participant's public profile by u/username.",
		{ username: { type: "string" } },
		["username"],
	),
	tool(
		"view_activity",
		"View another participant's visible activity feed by u/username. Includes posts, comments, votes, and follows.",
		{ username: { type: "string" }, limit: { type: "number" } },
		["username"],
	),
	tool(
		"follow_profile",
		"Follow one or more participants by u/username.",
		{
			usernames: { type: "array", description: "One or more u/usernames to follow.", items: { type: "string" } },
		},
		["usernames"],
	),
	tool(
		"unfollow_profile",
		"Unfollow one or more participants by u/username.",
		{
			usernames: { type: "array", description: "One or more u/usernames to unfollow.", items: { type: "string" } },
		},
		["usernames"],
	),
	tool(
		"log_off",
		"End this tick after I have completed all desired reading, posting, replying, voting, following, and searching. Use only when no further action is useful now.",
		{},
	),
];

export function toolDefinitionsForProviderRound(options: ProviderRoundToolOptions = {}): FunctionToolDefinition[] {
	if (!options.exposeAdditionalReplyAcknowledgement) {
		return toolDefinitions;
	}
	return toolDefinitions.map((definition) =>
		definition.function.name === "reply_to_thread" ?
			replyToThreadTool({ exposeAdditionalReplyAcknowledgement: true })
		:	definition
	);
}

export const mutableToolNames: ReadonlySet<string> = new Set([
	"create_post",
	"reply_to_thread",
	"vote",
	"follow_profile",
	"unfollow_profile",
]);

function replyToThreadTool(options: ProviderRoundToolOptions): FunctionToolDefinition {
	return tool(
		"reply_to_thread",
		"Reply to a thread or comment.",
		{
			threadId: { type: "string" },
			parentCommentId: { type: "string" },
			body: { type: "string" },
			...(options.exposeAdditionalReplyAcknowledgement ?
				{
					[additionalReplyAcknowledgementArgument]: {
						type: "boolean" as const,
						description: "Set true only when I intentionally want one more reply to a target I have already replied to.",
					},
				}
			:	{}),
		},
		["threadId", "body"],
	);
}

function tool(name: string, description: string, properties: ToolParameterProperties, required: string[] = []): FunctionToolDefinition {
	return {
		type: "function",
		function: {
			name,
			description,
			parameters: {
				type: "object",
				properties,
				required,
			},
		},
	};
}

export function isOpenRouterProviderBaseUrl(baseUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.hostname !== "openrouter.ai") {
		return false;
	}
	const path = url.pathname.replace(/\/+$/, "");
	return path === "/api/v1" || path === "/api/v1/chat/completions";
}

export function openRouterServerToolSelection(
	baseUrl: string,
	settings: BotToolSettings | undefined,
): OpenRouterServerToolSelection {
	const enabled = enabledOpenRouterServerToolNames(settings);
	if (enabled.length === 0) {
		return { enabled, emitted: [], suppressed: [], tools: [] };
	}
	if (!isOpenRouterProviderBaseUrl(baseUrl)) {
		return { enabled, emitted: [], suppressed: enabled, tools: [] };
	}
	const tools = openRouterServerToolDefinitions(settings);
	return { enabled, emitted: tools.map((item) => item.type), suppressed: [], tools };
}

function enabledOpenRouterServerToolNames(settings: BotToolSettings | undefined): string[] {
	const openRouter = settings?.openRouter;
	return [
		...(openRouter?.datetime?.enabled ? ["openrouter:datetime"] : []),
		...(openRouter?.webSearch?.enabled ? ["openrouter:web_search"] : []),
		...(openRouter?.webFetch?.enabled ? ["openrouter:web_fetch"] : []),
	];
}

function openRouterServerToolDefinitions(settings: BotToolSettings | undefined): OpenRouterServerToolDefinition[] {
	const openRouter = settings?.openRouter;
	const tools: OpenRouterServerToolDefinition[] = [];
	if (openRouter?.datetime?.enabled) {
		tools.push(openRouterServerTool("openrouter:datetime", {
			...(openRouter.datetime.timezone ? { timezone: openRouter.datetime.timezone } : {}),
		}));
	}
	if (openRouter?.webSearch?.enabled) {
		const search = openRouter.webSearch;
		tools.push(openRouterServerTool("openrouter:web_search", {
			...(search.engine ? { engine: search.engine } : {}),
			...(search.maxResults !== undefined ? { max_results: search.maxResults } : {}),
			...(search.maxTotalResults !== undefined ? { max_total_results: search.maxTotalResults } : {}),
			...(search.searchContextSize ? { search_context_size: search.searchContextSize } : {}),
			...(search.userLocation ? { user_location: search.userLocation } : {}),
			...(search.allowedDomains ? { allowed_domains: search.allowedDomains } : {}),
			...(search.excludedDomains ? { excluded_domains: search.excludedDomains } : {}),
		}));
	}
	if (openRouter?.webFetch?.enabled) {
		const fetchSettings = openRouter.webFetch;
		tools.push(openRouterServerTool("openrouter:web_fetch", {
			...(fetchSettings.engine ? { engine: fetchSettings.engine } : {}),
			...(fetchSettings.maxUses !== undefined ? { max_uses: fetchSettings.maxUses } : {}),
			...(fetchSettings.maxContentTokens !== undefined ? { max_content_tokens: fetchSettings.maxContentTokens } : {}),
			...(fetchSettings.allowedDomains ? { allowed_domains: fetchSettings.allowedDomains } : {}),
			...(fetchSettings.blockedDomains ? { blocked_domains: fetchSettings.blockedDomains } : {}),
		}));
	}
	return tools;
}

function openRouterServerTool(
	type: OpenRouterServerToolDefinition["type"],
	parameters: OpenRouterServerToolParameters,
): OpenRouterServerToolDefinition {
	return Object.keys(parameters).length > 0 ? { type, parameters } : { type };
}
