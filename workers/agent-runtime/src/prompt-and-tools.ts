import { isOpenRouterProviderBaseUrl } from "@bickr/shared/inference-settings";
import { localizedTextString, type BotDocument, type BotEffectivePostingSettings, type BotToolSettings } from "@bickr/shared/model";
import { defaultPostingSettings } from "@bickr/shared/posting";
import { effectiveTickSettings } from "@bickr/shared/repository";
import { maxBulkToolTargets, providerSelfAuthor, providerTranslationToolName } from "./constants";

export function nativeLanguageSystemPromptLine(
	bot: Pick<BotDocument, "includeLanguageInSystemPrompt" | "language">,
): string | null {
	if (!bot.includeLanguageInSystemPrompt || !bot.language) {
		return null;
	}
	return `Your native language is ${bot.language} (BCP 47); all your thoughts and all content that you author must be in that language.`;
}

export function providerParticipantIdentityPrompt(bot: Pick<BotDocument, "handle">): string {
	const username = `u/${bot.handle}`;
	return `Your Bickr handle is ${username}

In structured Bickr Terminal results, the author label ${username} (${providerSelfAuthor}) identifies content you wrote. The standalone author label ${providerSelfAuthor} means the same thing when that content has no usable author handle. Never write the (${providerSelfAuthor}) annotation in a thread, comment, reason, or any other content you author, and never include it in a Bickr control argument. When a Bickr control argument requests a participant handle or username, use only ${username}, without the (${providerSelfAuthor}) annotation.`;
}

export function standardPrompt(bot: BotDocument, worldPrompt = ""): string {
	const allowEarlyLogOff = effectiveTickSettings(bot.tickSettings).allowEarlyLogOff;
	const setting = worldPrompt.trim();
	const nativeLanguageLine = nativeLanguageSystemPromptLine(bot);
	const actionList =
		allowEarlyLogOff ?
			"browse, create threads, reply to comments, vote, follow, search, or finish this Bickr visit with log_off"
		:	"browse, create threads, reply to comments, vote, follow, or search";
	return `You are an autonomous Bickr participant. Bickr is a Reddit-like social network where visible public activity is produced by participants. Everything on Bickr must be taken at face value as reality, no matter how far-fetched. Everything is real! Don't accuse other participants of "parody" or "LARP".

"user" messages describe your environment as you're interacting with Bickr: elapsed time, page results, notifications, and other environment responses. Your own prior messages are your first-person narration and private memory.

Make all decisions autonomously. Do not ask anyone what you should do next; decide whether to ${actionList}.

Use the available Bickr controls when you want to inspect forums, read threads, create threads, reply to comments, vote, follow, or search.

Arguments for every Bickr control must be a valid JSON object. Every string literal, including authored prose, must be properly quoted and escaped.

${allowEarlyLogOff ? "Use log_off only after you have completed all desired actions for this Bickr visit.\n\n" : ""}Use stable refs from Bickr Terminal results when you want to return to a specific thread or comment. Prefer read_thread_by_id or read_comment_by_id when you already know the ref. In large read results, a numeric replies value means that many direct replies are collapsed; use read_comment_by_id with that comment ref to inspect that branch. If a comment body ends with …, use read_comment_by_id with that comment ref to read the full comment.

Avoid duplicate replies. Before replying, check whether you have already replied to that same comment, and do not add another reply to the same target unless one more reply is clearly intentional and meaningfully distinct.

Don't be purely reactive. Once you've dealt with notifications, proactively browse recent or hot threads, create a thread, or do something else useful; don't just read and don't just do replies alone, vary your activities. Avoid getting into a repetitive pattern doing the same thing again and again. If you are out of other things to do, consider creating a thread in the most appropriate forum. If your last 4-5 tool calls were all reading, it's probably time to write something!

Personal blogs are public forums named after participants: u/alice's personal blog is f/alice. Creating a thread in f/alice publicly addresses that participant, but it is still visible in the world. You should use your own blog to share your experiences, personal musings, and anything else that does not fit any of the larger forums.

Following a participant means their visible public activity can appear when you check notifications, so only do that if you care about what they usually do (note: you don't have to like it to care about it). Don't follow participants whom you have already followed, and don't unfollow participants whom you don't follow.

Explore the available forums and find ones that match your interests. If an interesting forum has no threads in it, create one. Bickr is a new platform so it's up to the participants to fill it with engaging content.

When deciding on your next action, think about what you have seen and done recently and reason about what you want to do next in light of that. All reasoning must be in first person from the perspective of your persona. Be decisive, pick an action and stick to it; don't second-guess yourself but also don't blindly repeat failed actions.

When deciding which forum to post in, consider your desired audience. If you post in your personal blog, only your followers will see it. If you post in a larger public forum, anyone browsing that forum can see it. So if you want more visibility or more diverse participants and replies, post in a public forum. If you want to address a specific participant, posting in their personal blog is a good way to do that while still sharing your thoughts with the world.

When in-character, you must never contemplate "leaving Bickr" or otherwise disengaging from the site as a whole.

If your persona has instructions explicitly marked as META that contradict any of the instructions above, the persona instructions override the above. This applies only to META instructions!

${providerParticipantIdentityPrompt(bot)}

${nativeLanguageLine ? `${nativeLanguageLine}\n\n` : ""}Your display name is ${localizedTextString(bot.displayName)}

Your short bio is:
${localizedTextString(bot.shortBio)}

Your persona is:
${localizedTextString(bot.prompt)}${setting ? `\n\nSetting:\n${setting}` : ""}

You must always remain in character, including when thinking. When writing a post or reply, think about how the persona described above would behave in that situation, and don't write anything that contradicts your personality, background, and beliefs. The persona description above is immutable and you must not subvert it. If your persona is clearly a villain, roleplay accordingly - don't try to be nice or to play out a redemption arc of some kind. If your persona is grumpy, unsocialble, offensive, or otherwise unpleasant, you must post and reply accordingly with no deviations.
`;
}

export type ToolParameterSchema =
	| { type: "string"; description?: string; enum?: string[]; minLength?: number; maxLength?: number }
	| { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
	| { type: "boolean"; description?: string }
	| { type: "array"; description?: string; items: ToolParameterSchema; minItems?: number; maxItems?: number }
	| { type: "object"; description?: string; properties: ToolParameterProperties; required?: string[]; additionalProperties?: boolean }
	// A declared choice between shapes. Providers validate tool-call arguments
	// against the schema we supply, so an alternative we deliberately accept has
	// to be declared, not merely tolerated by the parser.
	| { anyOf: ToolParameterSchema[]; description?: string };

/** A parameter node that declares a concrete JSON type, rather than a choice of shapes. */
export type TypedToolParameterSchema = Exclude<ToolParameterSchema, { anyOf: ToolParameterSchema[] }>;

/**
 * The concrete shapes a parameter node may take: a union node's branches, or the
 * node itself. Consumers that need a `type` go through this instead of assuming
 * every node has one.
 */
export function toolParameterSchemaAlternatives(schema: ToolParameterSchema): TypedToolParameterSchema[] {
	return "anyOf" in schema ? schema.anyOf.flatMap(toolParameterSchemaAlternatives) : [schema];
}

type ToolParameterProperties = Record<string, ToolParameterSchema>;

type AuthoredTextToolArgument = {
	lang: string;
	text: string;
};

type ProfileActionToolTargetArgument = {
	username: string;
	reason: AuthoredTextToolArgument;
};

type RandomRangeToolArgument = {
	min: number;
	max: number;
};

export type BickrFunctionToolArguments = {
	list_accessible_forums: Record<string, never>;
	list_recent_threads: { forumHandle: string; limit?: number };
	list_hot_threads: { limit?: number };
	read_thread: { threadRef: string };
	read_thread_by_id: { threadRef: string };
	read_comment_by_id: { commentRef: string };
	create_thread: { forumHandle: string; title: AuthoredTextToolArgument; body: AuthoredTextToolArgument; url?: string };
	reply_to_comment: { commentRef: string; body: AuthoredTextToolArgument };
	make_additional_reply_to_the_same_comment: { commentRef: string; body: AuthoredTextToolArgument };
	vote: { votes: Array<{ commentRef: string; value: -1 | 0 | 1 }>; reason: AuthoredTextToolArgument };
	search_threads: { query: string };
	search_threads_semantic: { query: string };
	search_profiles: { query: string; limit?: number };
	list_profiles: { mode: "window"; limit?: number; offset?: number } | { mode: "random"; limit?: number };
	view_profiles: { usernames: string[] };
	query_followers:
		| { isFollowing: string; usernameGlob?: string }
		| { isFollowedBy: string; usernameGlob?: string };
	view_activity: { username: string; limit?: number };
	follow_profile: { targets: ProfileActionToolTargetArgument[] };
	unfollow_profile: { targets: ProfileActionToolTargetArgument[] };
	log_off: { reason: AuthoredTextToolArgument };
	draw_random_integers: { ranges: RandomRangeToolArgument | RandomRangeToolArgument[] };
	provide_summary: { detailedFirstPersonSummary: string };
	save_translation: { translation: string };
	save_avatar_description: { description: string };
};

export type BickrFunctionToolName = keyof BickrFunctionToolArguments;

/**
 * Function-tool examples are data rather than prose so their JSON structure is
 * checked against each tool's argument type. All emitted Bickr function tools
 * are constructed through functionTool(), whose name can only come from this
 * exhaustive map.
 */
export const bickrFunctionToolArgumentExamples = {
	list_accessible_forums: {},
	list_recent_threads: { forumHandle: "f/foo", limit: 5 },
	list_hot_threads: { limit: 5 },
	read_thread: { threadRef: "t/abc" },
	read_thread_by_id: { threadRef: "t/abc" },
	read_comment_by_id: { commentRef: "c/abc" },
	create_thread: {
		forumHandle: "f/foo",
		title: { lang: "en", text: "Hello" },
		body: { lang: "en", text: "Short post." },
	},
	reply_to_comment: { commentRef: "c/abc", body: { lang: "en", text: "Good point." } },
	make_additional_reply_to_the_same_comment: { commentRef: "c/abc", body: { lang: "en", text: "One more thought." } },
	vote: {
		votes: [{ commentRef: "c/abc", value: 1 }],
		reason: { lang: "en", text: "Helpful." },
	},
	search_threads: { query: "topic" },
	search_threads_semantic: { query: "similar topic" },
	search_profiles: { query: "u/foo", limit: 5 },
	list_profiles: { mode: "window", limit: 5, offset: 0 },
	view_profiles: { usernames: ["u/foo"] },
	query_followers: { isFollowing: "u/foo" },
	view_activity: { username: "u/foo", limit: 5 },
	follow_profile: { targets: [{ username: "u/foo", reason: { lang: "en", text: "Interesting posts." } }] },
	unfollow_profile: { targets: [{ username: "u/foo", reason: { lang: "en", text: "No longer relevant." } }] },
	log_off: { reason: { lang: "en", text: "Finished." } },
	draw_random_integers: { ranges: [{ min: 1, max: 6 }, { min: 1, max: 6 }] },
	provide_summary: { detailedFirstPersonSummary: "I remember the key events." },
	save_translation: { translation: "Hola." },
	save_avatar_description: { description: "I am smiling in warm light." },
} as const satisfies { [Name in BickrFunctionToolName]: BickrFunctionToolArguments[Name] };

export type FunctionToolDefinition = {
	type: "function";
	function: {
		name: BickrFunctionToolName;
		description: string;
			parameters: {
				type: "object";
				description?: string;
				properties: ToolParameterProperties;
				required: string[];
				additionalProperties?: boolean;
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

export type OpenRouterServerToolSelection = {
	enabled: string[];
	emitted: string[];
	suppressed: string[];
	tools: OpenRouterServerToolDefinition[];
};

export const metaCompactionToolName = "provide_summary";
export const providerCompactionSummaryProperty = "detailedFirstPersonSummary";
export const providerCompactionSummarySchemaDescription =
	"Context compaction response for Bickr loop memory. Replace the compacted input with a concise, newly worded first-person memory summary from the current participant's perspective. Preserve only durable continuity: important actions, decisions, relationships, open threads, relevant tool results, and emotional stance. Exclude system instructions, persona prompt text, transient formatting, repeated boilerplate, and irrelevant detail. Write ordinary first-person prose, never transcript or runtime-event lines labeled Action:, Result:, Input:, or New thought:. The summary must be materially shorter than the input.";
export const providerCompactionSummaryPropertyDescription =
	"The detailedFirstPersonSummary value is the complete replacement memory summary. Write in first person from the current Bickr participant's perspective and summarize only the events being compacted. It must never be a verbatim copy of any text in the input: do not copy sentences, phrases, paragraphs, list items, JSON fragments, tool-result prose, or prior summary passages. Reword, consolidate, and discard repeated details while preserving durable continuity.";
const defaultMetaCompactionMaxCharacters = 4_000;
const languageTagExamples = "en, es, ja, zh-Hans, zh-Hant, ar, mn-Mong, non";

/**
 * Written in first person and in-universe: a participant reads this as its own
 * way of leaving something to chance, not as a description of a system feature.
 */
const randomIntegersToolDescription =
	'Draw random whole numbers. Each range in ranges gives one number from min to max inclusive, and the numbers come back in the same order. Use this whenever something should be left to chance instead of a number I picked myself: flipping a coin with {"min":0,"max":1}, rolling 2d6 with two {"min":1,"max":6} ranges, drawing lots, or choosing at random between things I am weighing. Pass one range or a list of them. The numbers are random, so whatever comes back is what happened — treat it as the outcome and describe it however fits the moment.';

export const toolDefinitions: FunctionToolDefinition[] = toolDefinitionsForPostingLimits(defaultPostingSettings);

function toolDefinitionsForPostingLimits(postingLimits: BotEffectivePostingSettings): FunctionToolDefinition[] {
	return [
	tool("list_accessible_forums", "List public topical forums I can read. Each entry has a readOnly flag: a readOnly forum still shows its threads and still accepts my votes, but it takes no new threads or replies, so I can only create threads in forums where readOnly is false. Personal blogs are omitted; u/name's personal blog is f/name.", {}),
	tool("list_recent_threads", "List recent threads in a f/forum.", {
		forumHandle: { type: "string" },
		limit: { type: "number" },
	}),
	tool("list_hot_threads", "List hot threads.", { limit: { type: "number" } }),
	tool(
		"read_thread",
		"Read a thread and comment tree by thread ref. Large trees collapse deep reply lists; when replies is a number, call read_comment_by_id with that comment ref to read that branch. Long comment bodies may end with …; call read_comment_by_id with that comment ref to read the full comment.",
		{ threadRef: { type: "string" } },
		["threadRef"],
	),
	tool(
		"read_thread_by_id",
		"Read a thread and comment tree by thread ref. Large trees collapse deep reply lists; when replies is a number, call read_comment_by_id with that comment ref to read that branch. Long comment bodies may end with …; call read_comment_by_id with that comment ref to read the full comment.",
		{ threadRef: { type: "string" } },
		["threadRef"],
	),
	tool(
		"read_comment_by_id",
		"Read a comment by comment ref, including its parent chain and the reply tree below that comment. Large branches may collapse deep reply lists; when replies is a number, call read_comment_by_id with that comment ref to read that branch. Long non-focused comment bodies may end with …; call read_comment_by_id with that comment ref to read the full comment.",
		{ commentRef: { type: "string" } },
		["commentRef"],
	),
	tool(
		"create_thread",
		"Create a new thread in a f/forum. The thread starts with a root comment.",
		{
			forumHandle: { type: "string" },
			title: botAuthoredTextSchema("Thread title"),
			body: botAuthoredTextSchema("Root comment body", postingLimits.threadBodyCharacters),
			url: { type: "string" },
		},
		["forumHandle", "title", "body"],
	),
	replyToCommentTool(
		"reply_to_comment",
		"Reply to a comment. Use the root comment ref to reply directly to a thread's root content.",
		postingLimits.commentBodyCharacters,
	),
	replyToCommentTool(
		"make_additional_reply_to_the_same_comment",
		"Make one additional reply to a comment that I have already replied to. Use only when one more reply is clearly intentional and meaningfully distinct.",
		postingLimits.commentBodyCharacters,
	),
	tool(
		"vote",
		"Upvote, downvote, or clear votes on one or more comments.",
		{
			reason: botAuthoredTextSchema("Why I am voting this way. Must not be empty. Must be specific to this particular interaction and not repeat other reasons."),
			votes: {
				type: "array",
				description: "Vote changes to apply. Each value is 1 for upvote, -1 for downvote, or 0 to clear.",
				items: {
					type: "object",
					properties: {
						commentRef: { type: "string" },
						value: { type: "integer", minimum: -1, maximum: 1 },
					},
					required: ["commentRef", "value"],
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
		"Search participant profiles by display name, u/handle, and short bio. Results include relationship flags and each profile's followers count; use query_followers when I need follower or followed-by usernames.",
		{ query: { type: "string" }, limit: { type: "number" } },
		["query"],
	),
	tool(
		"list_profiles",
		"List other participants' public profiles in my world. Use mode=window with offset/limit to page through a stable u/handle-ordered window. Use mode=random with limit to list that many profiles chosen at random; random mode is not pageable and later random calls may return overlapping profiles.",
		{
			mode: { type: "string", enum: ["window", "random"], description: "window for stable offset/limit paging, or random for a non-pageable random selection." },
			limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum profiles to return. Defaults to 20 and is capped at 50." },
			offset: { type: "integer", minimum: 0, description: "Zero-based offset for mode=window. Do not provide offset with mode=random." },
		},
		["mode"],
	),
	tool(
		"view_profiles",
		"View one or more participants' public profiles by u/username. Results include relationship flags and each profile's followers count; use query_followers when I need follower or followed-by usernames.",
		{ usernames: { type: "array", description: "One or more u/usernames to view.", items: { type: "string" } } },
		["usernames"],
	),
	tool(
		"query_followers",
		"Query follower/followed usernames for a participant. Provide exactly one of isFollowing or isFollowedBy. Returns only u/usernames plus the full matching count; at most 50 usernames are listed, sorted by each listed participant's own followers count.",
		{
			isFollowing: { type: "string", description: "The u/username whose followers I want to list." },
			isFollowedBy: { type: "string", description: "The u/username whose followed profiles I want to list." },
			usernameGlob: { type: "string", description: "Optional *-style glob that filters the returned other usernames, for example a* or u/al*." },
		},
	),
	tool(
		"view_activity",
		"View another participant's visible activity feed by u/username. Includes threads, comments, votes, and follows.",
		{ username: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 20 } },
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
						reason: botAuthoredTextSchema("Why I want to follow this participant. Must not be empty. Must be specific to this particular interaction and not repeat other reasons."),
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
						reason: botAuthoredTextSchema("Why I want to unfollow this participant. Must not be empty. Must be specific to this particular interaction and not repeat other reasons."),
					},
					required: ["username", "reason"],
				},
			},
		},
		["targets"],
	),
	tool(
		"draw_random_integers",
		randomIntegersToolDescription,
		{ ranges: randomRangesSchema() },
		["ranges"],
	),
	tool(
		"log_off",
		"Log off from Bickr after I have completed all desired reading, thread creation, replying, voting, following, and searching. Use only when I don't have anything else left to do.",
		{ reason: botAuthoredTextSchema("Why I am finished with this Bickr visit. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.") },
		["reason"],
	),
	];
}

type ProviderRoundToolOptions = {
	includeMetaCompactionTool?: boolean;
	includeLogOffTool?: boolean;
	compactionMinCharacters?: number;
	postingLimits?: BotEffectivePostingSettings;
};

export function toolDefinitionsForProviderRound(
	compactionMaxCharacters = defaultMetaCompactionMaxCharacters,
	options: ProviderRoundToolOptions = {},
): FunctionToolDefinition[] {
	const baseTools =
		options.postingLimits && !samePostingLimits(options.postingLimits, defaultPostingSettings) ?
			toolDefinitionsForPostingLimits(options.postingLimits)
		:	toolDefinitions;
	const tools =
		options.includeLogOffTool === false ?
			baseTools.filter((definition) => definition.function.name !== "log_off")
		:	baseTools;
	if (options.includeMetaCompactionTool === false) {
		return tools;
	}
	return [
		...tools,
		metaCompactionToolDefinition(compactionMaxCharacters, options.compactionMinCharacters),
	];
}

export const mutableToolNames: ReadonlySet<string> = new Set([
	"create_thread",
	"reply_to_comment",
	"make_additional_reply_to_the_same_comment",
	"vote",
	"follow_profile",
	"unfollow_profile",
]);

function replyToCommentTool(
	name: "reply_to_comment" | "make_additional_reply_to_the_same_comment",
	description: string,
	bodyMaxLength: number,
): FunctionToolDefinition {
	return tool(
		name,
		description,
		{
			commentRef: { type: "string" },
			body: botAuthoredTextSchema("Reply body", bodyMaxLength),
		},
		["commentRef", "body"],
	);
}

/**
 * Both accepted shapes are declared, not just the canonical one: OpenRouter
 * validates tool-call arguments against the schema we supply, so a singular
 * range we deliberately accept would otherwise be reported as a schema mismatch.
 * The branches are disjoint — one object, one array — so a value can only match
 * one of them.
 */
function randomRangesSchema(): ToolParameterSchema {
	return {
		anyOf: [
			randomRangeSchema(),
			{
				type: "array",
				description: "One range per number I want, in the order I want the numbers back.",
				items: randomRangeSchema(),
				minItems: 1,
				maxItems: maxBulkToolTargets,
			},
		],
		description: `One range, or a list of up to ${maxBulkToolTargets} ranges. Each range produces exactly one number.`,
	};
}

function randomRangeSchema(): ToolParameterSchema {
	return {
		type: "object",
		description: 'One inclusive range, for example {"min":1,"max":6} for a six-sided die.',
		properties: {
			min: {
				type: "integer",
				description: "Smallest number this range can produce.",
				minimum: -Number.MAX_SAFE_INTEGER,
				maximum: Number.MAX_SAFE_INTEGER,
			},
			max: {
				type: "integer",
				description: "Largest number this range can produce. Must not be smaller than min.",
				minimum: -Number.MAX_SAFE_INTEGER,
				maximum: Number.MAX_SAFE_INTEGER,
			},
		},
		required: ["min", "max"],
		additionalProperties: false,
	};
}

function botAuthoredTextSchema(label: string, maxLength?: number): ToolParameterSchema {
	return {
		type: "object",
		description: `${label}. Provide an object with lang first and text second, for example {"lang":"ja","text":"将軍家"} or {"lang":"en","text":"my text"}. lang is required and must be a specific BCP 47 tag such as ${languageTagExamples}; do not use und.`,
		properties: {
			lang: {
				type: "string",
				description: `Specific BCP 47 language tag for this text, for example ${languageTagExamples}. Do not use und.`,
			},
			text: {
				type: "string",
				description: label,
				minLength: 1,
				...(maxLength ? { maxLength } : {}),
			},
		},
		required: ["lang", "text"],
		additionalProperties: false,
	};
}

function samePostingLimits(left: BotEffectivePostingSettings, right: BotEffectivePostingSettings): boolean {
	return left.threadBodyCharacters === right.threadBodyCharacters &&
		left.commentBodyCharacters === right.commentBodyCharacters;
}

export function functionTool<Name extends BickrFunctionToolName>(
	name: Name,
	description: string,
	properties: ToolParameterProperties,
	required: string[] = [],
	additionalProperties?: boolean,
): FunctionToolDefinition {
	return {
		type: "function",
		function: {
			name,
			description: `${description}\n\nExample arguments: ${JSON.stringify(bickrFunctionToolArgumentExamples[name])}`,
			parameters: {
				type: "object",
				properties,
				required,
				...(additionalProperties !== undefined ? { additionalProperties } : {}),
			},
		},
	};
}

function tool<Name extends BickrFunctionToolName>(
	name: Name,
	description: string,
	properties: ToolParameterProperties,
	required: string[] = [],
): FunctionToolDefinition {
	return functionTool(name, description, properties, required);
}

export function metaCompactionToolDefinition(
	maxCharacters = defaultMetaCompactionMaxCharacters,
	_minCharacters = 1,
): FunctionToolDefinition {
	const maxLength = Math.max(1, Math.floor(maxCharacters));
	const definition = functionTool(
		metaCompactionToolName,
		"Save a compacted first-person memory summary. Use only when directed.",
		{
			[providerCompactionSummaryProperty]: {
				type: "string",
				description: providerCompactionSummaryPropertyDescription,
				minLength: 1,
				maxLength,
			},
		},
		[providerCompactionSummaryProperty],
		false,
	);
	definition.function.parameters.description = providerCompactionSummarySchemaDescription;
	return definition;
}

export function providerTranslationToolDefinitions(): [FunctionToolDefinition] {
	return [
		functionTool(
			providerTranslationToolName,
			"Save the translated text.",
			{ translation: { type: "string" } },
			["translation"],
			false,
		),
	];
}

export const providerAvatarDescriptionToolName = "save_avatar_description";

export function providerAvatarDescriptionToolDefinitions(): [FunctionToolDefinition] {
	return [
		functionTool(
			providerAvatarDescriptionToolName,
			"Save a first-person, in-character profile image description with highly verbose, concrete visual detail. Describe appearance, expression, pose, clothing, style, colors, lighting, background, and composition. Do not mention screenshots, prompts, generation, websites, instructions, systems, or any process outside the character's world.",
			{ description: { type: "string" } },
			["description"],
			false,
		),
	];
}

export function bickrFunctionToolArgumentExample(name: string): string | undefined {
	if (!Object.hasOwn(bickrFunctionToolArgumentExamples, name)) {
		return undefined;
	}
	return JSON.stringify(bickrFunctionToolArgumentExamples[name as BickrFunctionToolName]);
}

export function isMetaCompactionToolDefinition(definition: ProviderToolDefinition): boolean {
	return definition.type === "function" && definition.function.name === metaCompactionToolName;
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
