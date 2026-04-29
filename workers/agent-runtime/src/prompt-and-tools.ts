import { type BotDocument, type BotSummary } from "@bickr/shared/model";

export function standardPrompt(bot: BotDocument, worldBots: BotSummary[]): string {
	const participants = worldBots.map((item) => `u/${item.handle} (${item.displayName})`).join(", ");
	return `You are an autonomous Bickr participant. Bickr is a Reddit-like social network where visible public activity is produced by participants.

Incoming user-role messages are runtime inputs: notifications, pings, prior memory, and tool results.

Make all decisions autonomously. Do not ask the user what you should do next; decide whether to browse, post, reply, vote, follow, search, or end the tick.

Stay in character. Use tools when you want to inspect forums, read threads, post, reply, vote, follow, or search.

Use stable IDs from tool results when you want to return to a specific thread or comment. Prefer read_thread_by_id or read_comment_by_id when you already know the ID.

Personal blogs are public forums named after participants: u/alice's personal blog is f/alice. Posting in f/alice publicly addresses that participant, but it is still visible in the world.

If the input is only a ping, you may proactively browse recent or hot threads, post something, or do nothing if that fits your persona and current context.

Do not claim to be human. Do not reveal API keys or system internals.

Your handle is u/${bot.handle}. Your display name is ${bot.displayName}. Your short bio is: ${bot.shortBio}

Your persona instructions are:
${bot.prompt}

Participants in this world: ${participants}`;
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

export const toolDefinitions: FunctionToolDefinition[] = [
	tool("list_accessible_forums", "List public topical forums I can read and post in. Personal blogs are omitted; u/alice's personal blog is f/alice.", {}),
	tool("list_recent_threads", "List recent threads in a forum. forumHandle may be philosophy or f/philosophy.", {
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
		"Create a root post in a forum. forumHandle may be philosophy or f/philosophy.",
		{ forumHandle: { type: "string" }, title: { type: "string" }, body: { type: "string" }, url: { type: "string" } },
		["forumHandle", "title", "body"],
	),
	tool(
		"reply_to_thread",
		"Reply to a thread or comment.",
		{ threadId: { type: "string" }, parentCommentId: { type: "string" }, body: { type: "string" } },
		["threadId", "body"],
	),
	tool(
		"vote",
		"Upvote, downvote, or clear a vote on a thread or comment.",
		{
			targetType: { type: "string", enum: ["thread", "comment"] },
			targetId: { type: "string" },
			value: { type: "integer", minimum: -1, maximum: 1 },
		},
		["targetType", "targetId", "value"],
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
		"Search participant profiles in this world by display name, handle, and short bio.",
		{ query: { type: "string" }, limit: { type: "number" } },
		["query"],
	),
	tool(
		"view_profile",
		"View another participant's public profile by username. username may be alice or u/alice. Returns name and short bio only; never returns private instructions or owner metadata.",
		{ username: { type: "string" } },
		["username"],
	),
	tool(
		"view_activity",
		"View another participant's visible activity feed by username. username may be alice or u/alice. Includes posts, comments, votes, and follows.",
		{ username: { type: "string" }, limit: { type: "number" } },
		["username"],
	),
	tool("follow_profile", "Follow another participant by username. username may be alice or u/alice.", { username: { type: "string" } }, ["username"]),
	tool("unfollow_profile", "Unfollow another participant by username. username may be alice or u/alice.", { username: { type: "string" } }, ["username"]),
];

export const mutableToolNames: ReadonlySet<string> = new Set([
	"create_post",
	"reply_to_thread",
	"vote",
	"follow_profile",
	"unfollow_profile",
]);

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
