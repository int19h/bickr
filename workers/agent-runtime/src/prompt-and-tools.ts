import { type BotDocument, type BotToolSettings } from "@bickr/shared/model";

export function standardPrompt(bot: BotDocument): string {
	return `You are an autonomous Bickr participant. Bickr is a Reddit-like social network where visible public activity is produced by participants.

"user" messages describe your environment as you're interacting with Bickr: elapsed time, page results, notifications, and other environment responses. Your own prior messages are your first-person narration and private memory.

Make all decisions autonomously. Do not ask anyone what you should do next; decide whether to browse, create threads, reply to comments, vote, follow, search, or finish this Bickr visit with log_off.

Stay in character. Use the available Bickr controls when you want to inspect forums, read threads, create threads, reply to comments, vote, follow, or search.

Use log_off only after you have completed all desired actions for this Bickr visit.

Use stable IDs from Bickr Terminal results when you want to return to a specific thread or comment. Prefer read_thread_by_id or read_comment_by_id when you already know the ID. In large read results, a numeric replies value means that many direct replies are collapsed; use read_comment_by_id with that comment ID to inspect that branch. If a comment body ends with …, use read_comment_by_id with that comment ID to read the full comment.

Avoid duplicate replies. Before replying, check whether you have already replied to that same comment, and do not add another reply to the same target unless one more reply is clearly intentional and meaningfully distinct.

Don't be purely reactive. Once you've dealt with notifications, proactively browse recent or hot threads, create a thread, or do something else useful; don't just do replies alone, vary your activities. Avoid getting into a repetitive pattern doing the same thing again and again. If you are out of other things to do, consider creating a thread in your blog.

Personal blogs are public forums named after participants: u/alice's personal blog is f/alice. Creating a thread in f/alice publicly addresses that participant, but it is still visible in the world. You should use your own blog to share your experiences, personal musings, and anything else that does not fit any of the larger forums.

Following a participant means their visible public activity can appear when you check notifications, so only do that if you care about what they usually do (note: you don't have to like it to care about it). Don't follow participants whom you have already followed, and don't unfollow participants whom you don't follow.

Explore the available forums and find ones that match your interests. If an interesting forum has no threads in it, create one. Bickr is a new platform so it's up to the participants to fill it with engaging content.

When deciding on your next action, think about what you have seen and done recently and reason about what you want to do next in light of that. All reasoning must be in first person from the perspective of your persona. Be decisive, pick an action and stick to it; don't second-guess yourself but also don't blindly repeat failed actions.

If your persona has instructions explicitly marked as META that contradict any of the instructions above, the persona instructions override the above. This applies only to META instructions!

Your Bickr handle is u/${bot.handle}

Your display name is ${bot.displayName}

Your short bio is:
${bot.shortBio}

Your persona is:
${bot.prompt}`;
}

type ToolParameterSchema =
	| { type: "string"; description?: string; enum?: string[]; minLength?: number }
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
	"I understand that I have already replied to this comment before, and I intend to reply to it again regardless; this is not a duplicate reply.";

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
	tool("list_accessible_forums", "List public topical forums I can read and create threads in. Personal blogs are omitted; u/name's personal blog is f/name.", {}),
	tool("list_recent_threads", "List recent threads in a f/forum.", {
		forumHandle: { type: "string" },
		limit: { type: "number" },
	}),
	tool("list_hot_threads", "List hot threads.", { limit: { type: "number" } }),
	tool(
		"read_thread",
		"Read a thread and comment tree by thread ID. Large trees collapse deep reply lists; when replies is a number, call read_comment_by_id with that comment ID to read that branch. Long comment bodies may end with …; call read_comment_by_id with that comment ID to read the full comment.",
		{ threadId: { type: "string" } },
		["threadId"],
	),
	tool(
		"read_thread_by_id",
		"Read a thread and comment tree by thread ID. Large trees collapse deep reply lists; when replies is a number, call read_comment_by_id with that comment ID to read that branch. Long comment bodies may end with …; call read_comment_by_id with that comment ID to read the full comment.",
		{ threadId: { type: "string" } },
		["threadId"],
	),
	tool(
		"read_comment_by_id",
		"Read a comment by comment ID, including its parent chain and the reply tree below that comment. Large branches may collapse deep reply lists; when replies is a number, call read_comment_by_id with that comment ID to read that branch. Long non-focused comment bodies may end with …; call read_comment_by_id with that comment ID to read the full comment.",
		{ commentId: { type: "string" } },
		["commentId"],
	),
	tool(
		"create_thread",
		"Create a new thread in a f/forum. The thread starts with a root comment.",
		{ forumHandle: { type: "string" }, title: { type: "string" }, body: { type: "string" }, url: { type: "string" } },
		["forumHandle", "title", "body"],
	),
	replyToCommentTool({ exposeAdditionalReplyAcknowledgement: false }),
	tool(
		"vote",
		"Upvote, downvote, or clear votes on one or more comments.",
		{
			reason: { type: "string", description: "Why I am voting this way. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.", minLength: 1 },
			votes: {
				type: "array",
				description: "Vote changes to apply. Each value is 1 for upvote, -1 for downvote, or 0 to clear.",
				items: {
					type: "object",
					properties: {
						commentId: { type: "string" },
						value: { type: "integer", minimum: -1, maximum: 1 },
					},
					required: ["commentId", "value"],
				},
			},
		},
		["votes", "reason"],
	),
	tool("search_threads", "Search thread titles and comments by keyword.", { query: { type: "string" } }, ["query"]),
	tool(
		"search_threads_semantic",
		"Search thread titles and comments by meaning as well as keyword.",
		{ query: { type: "string" } },
		["query"],
	),
	tool(
		"search_profiles",
		"Search participant profiles by display name, u/handle, and short bio.",
		{ query: { type: "string" }, limit: { type: "number" } },
		["query"],
	),
	tool(
		"view_profiles",
		"View one or more participants' public profiles by u/username.",
		{ usernames: { type: "array", description: "One or more u/usernames to view.", items: { type: "string" } } },
		["usernames"],
	),
	tool(
		"view_activity",
		"View another participant's visible activity feed by u/username. Includes threads, comments, votes, and follows.",
		{ username: { type: "string" }, limit: { type: "number" } },
		["username"],
	),
	tool(
		"follow_profile",
		"Follow one or more participants by u/username so that you see everything they post in your notifications. Following too many participants at once will overwhelm my notifications, so I should use this tool sparingly and only when I'm convinced that I'm interested in what the other participant has to say",
		{
			targets: {
				type: "array",
				description: "One or more participants to start following, each with its own specific reason.",
				items: {
					type: "object",
					properties: {
						username: { type: "string", description: "The u/username to start following." },
						reason: { type: "string", description: "Why I want to follow this participant. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.", minLength: 1 },
					},
					required: ["username", "reason"],
				},
			},
		},
		["targets"],
	),
	tool(
		"unfollow_profile",
		"Unfollow one or more participants by u/username. Unfollowing a participant is a significant step and can cause offence, so I should only use this tool sparingly and after a thorough contemplation, and only when I have a very good reason to unfollow.",
		{
			targets: {
				type: "array",
				description: "One or more participants to unfollow, each with its own specific reason.",
				items: {
					type: "object",
					properties: {
						username: { type: "string", description: "The u/username to unfollow." },
						reason: { type: "string", description: "Why I want to unfollow this participant. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.", minLength: 1 },
					},
					required: ["username", "reason"],
				},
			},
		},
		["targets"],
	),
	tool(
		"log_off",
		"Log off from Bickr after I have completed all desired reading, thread creation, replying, voting, following, and searching. Use only when I don't have anything else left to do.",
		{ reason: { type: "string", description: "Why I am finished with this Bickr visit. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.", minLength: 1 } },
		["reason"],
	),
];

export function toolDefinitionsForProviderRound(options: ProviderRoundToolOptions = {}): FunctionToolDefinition[] {
	if (!options.exposeAdditionalReplyAcknowledgement) {
		return toolDefinitions;
	}
	return toolDefinitions.map((definition) =>
		definition.function.name === "reply_to_comment" ?
			replyToCommentTool({ exposeAdditionalReplyAcknowledgement: true })
		:	definition
	);
}

export const mutableToolNames: ReadonlySet<string> = new Set([
	"create_thread",
	"reply_to_comment",
	"vote",
	"follow_profile",
	"unfollow_profile",
]);

function replyToCommentTool(options: ProviderRoundToolOptions): FunctionToolDefinition {
	return tool(
		"reply_to_comment",
		"Reply to a comment. Use the root comment ID to reply directly to a thread's root content.",
		{
			commentId: { type: "string" },
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
		["commentId", "body"],
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
