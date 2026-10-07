import { mathLimits, mermaidLimits, svgLimits, participantListLimits } from '@bickr/shared/content-limits';
import type { BotText } from "./localization";
import type { InstructionText } from "@bickr/shared/instruction-template";
import { isOpenRouterProviderBaseUrl } from "@bickr/shared/inference-settings";
import { localizedTextString, type BotDocument, type BotEffectivePostingSettings, type BotToolSettings } from "@bickr/shared/model";
import { defaultPostingSettings } from "@bickr/shared/posting";
import { effectiveTickSettings } from "@bickr/shared/repository";
import { maxBulkToolTargets, providerSelfAuthor, providerTranslationToolName } from "./constants";

export function nativeLanguageSystemPromptLine(
	bot: Pick<BotDocument, "includeLanguageInSystemPrompt" | "language">,
	text: BotText,
): string | null {
	if (!bot.includeLanguageInSystemPrompt || !bot.language) {
		return null;
	}
	return text.format("system.nativeLanguage", { language: bot.language });
}

export function providerParticipantIdentityPrompt(bot: Pick<BotDocument, "handle">, text: BotText): string {
	const username = `u/${bot.handle}`;
	return text.format("system.identity", { username, selfAuthor: providerSelfAuthor });
}

export function standardPrompt(text: BotText, bot: BotDocument, worldPrompt: string, options: { includeNotesTools: boolean; includePlan: boolean }): string {
	const allowEarlyLogOff = effectiveTickSettings(bot.tickSettings).allowEarlyLogOff;
	const setting = worldPrompt.trim();
	const nativeLanguageLine = nativeLanguageSystemPromptLine(bot, text);
	const actionDecision =
		allowEarlyLogOff ?
			text.format("system.actionDecisionWithLogOff")
		:	text.format("system.actionDecision");
	const notesInstruction = !options.includeNotesTools ? '' : text.format("system.notes", { plan: !options.includePlan ? '' : text.format("system.plan") });
	return text.format("system.main", {
		mermaidKiB: mermaidLimits.sourceBytes / 1024, mathKiB: mathLimits.sourceBytes / 1024, svgKiB: svgLimits.sourceBytes / 1024, svgElements: svgLimits.elements,
		actionDecision,
		logOffInstruction: allowEarlyLogOff ? text.format("system.logOffInstruction") : "",
		notes: notesInstruction,
		identity: providerParticipantIdentityPrompt(bot, text),
		nativeLanguage: nativeLanguageLine ? `${nativeLanguageLine}\n\n` : "",
		displayName: localizedTextString(bot.displayName),
		shortBio: localizedTextString(bot.shortBio),
		persona: localizedTextString(bot.prompt),
		setting: setting ? text.format("system.setting", { setting }) : "",
	});
}

export type ToolParameterSchema =
	| { type: "string"; description?: InstructionText; enum?: string[]; minLength?: number; maxLength?: number }
	| { type: "number" | "integer"; description?: InstructionText; minimum?: number; maximum?: number }
	| { type: "boolean"; description?: InstructionText }
	| { type: "array"; description?: InstructionText; items: ToolParameterSchema; minItems?: number; maxItems?: number }
	| { type: "object"; description?: InstructionText; properties: ToolParameterProperties; required?: string[]; additionalProperties?: boolean }
	// A declared choice between shapes. Providers validate tool-call arguments
	// against the schema we supply, so an alternative we deliberately accept has
	// to be declared, not merely tolerated by the parser.
	| { anyOf: ToolParameterSchema[]; description?: InstructionText };

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
	list_notes: { entities?: string[]; cursor?: string; limit?: number };
	read_note: { id: string };
	write_note: { id: string; content: string };
	delete_note: { id: string };
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
export function bickrFunctionToolArgumentExamples(text: BotText) { return {
	list_accessible_forums: {},
	list_recent_threads: { forumHandle: "f/foo", limit: 5 },
	list_hot_threads: { limit: 5 },
	read_thread: { threadRef: "t/abc" },
	read_thread_by_id: { threadRef: "t/abc" },
	read_comment_by_id: { commentRef: "c/abc" },
	create_thread: {
		forumHandle: "f/foo",
		title: { lang: text.contentLanguage, text: text.format("examples.create_thread.title.text") },
		body: { lang: text.contentLanguage, text: text.format("examples.create_thread.body.text") },
	},
	reply_to_comment: { commentRef: "c/abc", body: { lang: text.contentLanguage, text: text.format("examples.reply_to_comment.body.text") } },
	make_additional_reply_to_the_same_comment: { commentRef: "c/abc", body: { lang: text.contentLanguage, text: text.format("examples.make_additional_reply_to_the_same_comment.body.text") } },
	vote: {
		votes: [{ commentRef: "c/abc", value: 1 }],
		reason: { lang: text.contentLanguage, text: text.format("examples.vote.reason.text") },
	},
	search_threads: { query: text.format("examples.search_threads.query") },
	search_threads_semantic: { query: text.format("examples.search_threads_semantic.query") },
	search_profiles: { query: "u/foo", limit: 5 },
	list_profiles: { mode: "window", limit: 5, offset: 0 },
	view_profiles: { usernames: ["u/foo"] },
	list_notes: { entities: ["u/foo"], limit: 20 },
	read_note: { id: "about-foo" },
	write_note: { id: "about-foo", content: text.format("examples.write_note.content") },
	delete_note: { id: "about-foo" },
	query_followers: { isFollowing: "u/foo" },
	view_activity: { username: "u/foo", limit: 5 },
	follow_profile: { targets: [{ username: "u/foo", reason: { lang: text.contentLanguage, text: text.format("examples.follow_profile.targets.reason.text") } }] },
	unfollow_profile: { targets: [{ username: "u/foo", reason: { lang: text.contentLanguage, text: text.format("examples.unfollow_profile.targets.reason.text") } }] },
	log_off: { reason: { lang: text.contentLanguage, text: text.format("examples.log_off.reason.text") } },
	draw_random_integers: { ranges: [{ min: 1, max: 6 }, { min: 1, max: 6 }] },
	provide_summary: { detailedFirstPersonSummary: text.format("examples.provide_summary.detailedFirstPersonSummary") },
	save_translation: { translation: "..." },
	save_avatar_description: { description: text.format("examples.save_avatar_description.description") },
} as const satisfies { [Name in BickrFunctionToolName]: BickrFunctionToolArguments[Name] }; }

export type FunctionToolDefinition = {
	type: "function";
	function: {
		name: BickrFunctionToolName;
		description: InstructionText;
			parameters: {
				type: "object";
				description?: InstructionText;
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
export function providerCompactionSummarySchemaDescription(text: BotText): InstructionText { return text.format("schema.compaction.summary", { transcriptLabels: text.transcriptLabelList }); }
export function providerCompactionSummaryPropertyDescription(text: BotText): InstructionText { return text.format("schema.compaction.property"); }
const defaultMetaCompactionMaxCharacters = 4_000;
const languageTagExamples = "en, es, ja, zh-Hans, zh-Hant, ar, mn-Mong, non";

/**
 * Written in first person and in-universe: a participant reads this as its own
 * way of leaving something to chance, not as a description of a system feature.
 */
function randomIntegersToolDescription(text: BotText): InstructionText { return text.format("tools.draw_random_integers.description"); }

export function toolDefinitions(text: BotText): FunctionToolDefinition[] { return toolDefinitionsForPostingLimits(text, defaultPostingSettings); }

function toolDefinitionsForPostingLimits(text: BotText, postingLimits: BotEffectivePostingSettings): FunctionToolDefinition[] {
	return [
	tool(text, "list_accessible_forums", text.format("tools.list_accessible_forums.description"), {}),
	tool(text, "list_recent_threads", text.format("tools.list_recent_threads.description"), {
		forumHandle: { type: "string" },
		limit: { type: "number" },
	}),
	tool(text, "list_hot_threads", text.format("tools.list_hot_threads.description"), { limit: { type: "number" } }),
	tool(
		text,
		"read_thread",
		text.format("tools.read_thread.description"),
		{ threadRef: { type: "string" } },
		["threadRef"],
	),
	tool(
		text,
		"read_thread_by_id",
		text.format("tools.read_thread_by_id.description"),
		{ threadRef: { type: "string" } },
		["threadRef"],
	),
	tool(
		text,
		"read_comment_by_id",
		text.format("tools.read_comment_by_id.description"),
		{ commentRef: { type: "string" } },
		["commentRef"],
	),
	tool(
		text,
		"create_thread",
		text.format("tools.create_thread.description"),
		{
			forumHandle: { type: "string" },
			title: botAuthoredTextSchema(text, "threadTitle"),
			body: botAuthoredTextSchema(text, "rootBody", postingLimits.threadBodyCharacters),
			url: { type: "string" },
		},
		["forumHandle", "title", "body"],
	),
	replyToCommentTool(
		text,
		"reply_to_comment",
		text.format("tools.reply_to_comment.description"),
		postingLimits.commentBodyCharacters,
	),
	replyToCommentTool(
		text,
		"make_additional_reply_to_the_same_comment",
		text.format("tools.make_additional_reply_to_the_same_comment.description"),
		postingLimits.commentBodyCharacters,
	),
	tool(
		text,
		"vote",
		text.format("tools.vote.description"),
		{
			reason: botAuthoredTextSchema(text, "voteReason"),
			votes: {
				type: "array",
				description: text.format("tools.vote.properties.votes.description"),
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
	tool(text, "search_threads", text.format("tools.search_threads.description"), { query: { type: "string" } }, ["query"]),
	tool(
		text,
		"search_threads_semantic",
		text.format("tools.search_threads_semantic.description"),
		{ query: { type: "string" } },
		["query"],
	),
	tool(
		text,
		"search_profiles",
		text.format("tools.search_profiles.description"),
		{ query: { type: "string" }, limit: { type: "number" } },
		["query"],
	),
	tool(
		text,
		"list_profiles",
		text.format("tools.list_profiles.description"),
		{
			mode: { type: "string", enum: ["window", "random"], description: text.format("tools.list_profiles.properties.mode.description") },
			limit: { type: "integer", minimum: 1, maximum: participantListLimits.maximumProfiles, description: text.format("tools.list_profiles.properties.limit.description", { defaultLimit: participantListLimits.defaultProfiles, maxLimit: participantListLimits.maximumProfiles }) },
			offset: { type: "integer", minimum: 0, description: text.format("tools.list_profiles.properties.offset.description") },
		},
		["mode"],
	),
	tool(
		text,
		"view_profiles",
		text.format("tools.view_profiles.description"),
		{ usernames: { type: "array", description: text.format("tools.view_profiles.properties.usernames.description"), items: { type: "string" } } },
		["usernames"],
	),
	tool(text, "list_notes", text.format("tools.list_notes.description", { maxFilters: participantListLimits.maximumNoteFilters }), {
		entities: { type: "array", description: text.format("tools.list_notes.properties.entities.description"), items: { type: "string" } },
		cursor: { type: "string", description: text.format("tools.list_notes.properties.cursor.description") },
		limit: { type: "integer", minimum: 1, maximum: 50 },
	}),
	tool(text, "read_note", text.format("tools.read_note.description"), { id: { type: "string" } }, ["id"]),
	tool(text, "write_note", text.format("tools.write_note.description"), {
		id: { type: "string" }, content: { type: "string", maxLength: 4000 },
	}, ["id", "content"]),
	tool(text, "delete_note", text.format("tools.delete_note.description"), { id: { type: "string" } }, ["id"]),
	tool(
		text,
		"query_followers",
		text.format("tools.query_followers.description", { maxLimit: participantListLimits.maximumFollowers }),
		{
			isFollowing: { type: "string", description: text.format("tools.query_followers.properties.isFollowing.description") },
			isFollowedBy: { type: "string", description: text.format("tools.query_followers.properties.isFollowedBy.description") },
			usernameGlob: { type: "string", description: text.format("tools.query_followers.properties.usernameGlob.description") },
		},
	),
	tool(
		text,
		"view_activity",
		text.format("tools.view_activity.description"),
		{ username: { type: "string" }, limit: { type: "number", minimum: 1, maximum: participantListLimits.maximumActivity } },
		["username"],
	),
	tool(
		text,
		"follow_profile",
		text.format("tools.follow_profile.description"),
		{
			targets: {
				type: "array",
				description: text.format("tools.follow_profile.properties.targets.description"),
				items: {
					type: "object",
					properties: {
						username: { type: "string", description: text.format("tools.follow_profile.properties.targets.items.properties.username.description") },
						reason: botAuthoredTextSchema(text, "followReason"),
					},
					required: ["username", "reason"],
				},
			},
		},
		["targets"],
	),
	tool(
		text,
		"unfollow_profile",
		text.format("tools.unfollow_profile.description"),
		{
			targets: {
				type: "array",
				description: text.format("tools.unfollow_profile.properties.targets.description"),
				items: {
					type: "object",
					properties: {
						username: { type: "string", description: text.format("tools.unfollow_profile.properties.targets.items.properties.username.description") },
						reason: botAuthoredTextSchema(text, "unfollowReason"),
					},
					required: ["username", "reason"],
				},
			},
		},
		["targets"],
	),
	tool(
		text,
		"draw_random_integers",
		randomIntegersToolDescription(text),
		{ ranges: randomRangesSchema(text) },
		["ranges"],
	),
	tool(
		text,
		"log_off",
		text.format("tools.log_off.description"),
		{ reason: botAuthoredTextSchema(text, "logOffReason") },
		["reason"],
	),
	];
}

type ProviderRoundToolOptions = {
	includeNotesTools?: boolean;
	includeMetaCompactionTool?: boolean;
	includeLogOffTool?: boolean;
	compactionMinCharacters?: number;
	postingLimits?: BotEffectivePostingSettings;
};

export function toolDefinitionsForProviderRound(
	text: BotText,
	compactionMaxCharacters = defaultMetaCompactionMaxCharacters,
	options: ProviderRoundToolOptions = {},
): FunctionToolDefinition[] {
	const baseTools =
		options.postingLimits && !samePostingLimits(options.postingLimits, defaultPostingSettings) ?
			toolDefinitionsForPostingLimits(text, options.postingLimits)
		:	toolDefinitions(text);
	const tools =
		options.includeLogOffTool === false ?
			baseTools.filter((definition) => definition.function.name !== "log_off")
		:	baseTools;
	const availableTools = options.includeNotesTools === false ? tools.filter((definition) => !noteToolNames.has(definition.function.name)) : tools;
	if (options.includeMetaCompactionTool === false) {
		return availableTools;
	}
	return [
		...availableTools,
		metaCompactionToolDefinition(text, compactionMaxCharacters, options.compactionMinCharacters),
	];
}

export const noteToolNames: ReadonlySet<string> = new Set(["list_notes", "read_note", "write_note", "delete_note"]);

export const mutableToolNames: ReadonlySet<string> = new Set([
	"create_thread",
	"reply_to_comment",
	"make_additional_reply_to_the_same_comment",
	"vote",
	"follow_profile",
	"unfollow_profile",
]);

function replyToCommentTool(
	text: BotText,
	name: "reply_to_comment" | "make_additional_reply_to_the_same_comment",
	description: InstructionText,
	bodyMaxLength: number,
): FunctionToolDefinition {
	return tool(
		text,
		name,
		description,
		{
			commentRef: { type: "string" },
			body: botAuthoredTextSchema(text, "replyBody", bodyMaxLength),
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
function randomRangesSchema(text: BotText): ToolParameterSchema {
	return {
		anyOf: [
			randomRangeSchema(text),
			{
				type: "array",
				description: text.format("schema.random_ranges.list"),
				items: randomRangeSchema(text),
				minItems: 1,
				maxItems: maxBulkToolTargets,
			},
		],
		description: text.format("schema.random_ranges.choice", { maxRanges: maxBulkToolTargets }),
	};
}

function randomRangeSchema(text: BotText): ToolParameterSchema {
	return {
		type: "object",
		description: text.format("schema.random_range.description"),
		properties: {
			min: {
				type: "integer",
				description: text.format("schema.random_range.min"),
				minimum: -Number.MAX_SAFE_INTEGER,
				maximum: Number.MAX_SAFE_INTEGER,
			},
			max: {
				type: "integer",
				description: text.format("schema.random_range.max"),
				minimum: -Number.MAX_SAFE_INTEGER,
				maximum: Number.MAX_SAFE_INTEGER,
			},
		},
		required: ["min", "max"],
		additionalProperties: false,
	};
}

const authoredTextMessages = {
	"threadTitle": {
		"schema": "schema.authored.threadTitle",
		"label": "schema.authored_text.thread_title"
	},
	"rootBody": {
		"schema": "schema.authored.rootBody",
		"label": "schema.authored_text.root_body"
	},
	"voteReason": {
		"schema": "schema.authored.voteReason",
		"label": "schema.authored_text.vote_reason"
	},
	"followReason": {
		"schema": "schema.authored.followReason",
		"label": "schema.authored_text.follow_reason"
	},
	"unfollowReason": {
		"schema": "schema.authored.unfollowReason",
		"label": "schema.authored_text.unfollow_reason"
	},
	"logOffReason": {
		"schema": "schema.authored.logOffReason",
		"label": "schema.authored_text.log_off_reason"
	},
	"replyBody": {
		"schema": "schema.authored.replyBody",
		"label": "schema.authored_text.reply_body"
	}
} as const;

function botAuthoredTextSchema(text: BotText, purpose: keyof typeof authoredTextMessages, maxLength?: number): ToolParameterSchema {
	return {
		type: "object",
		description: text.format(authoredTextMessages[purpose].schema, { languageTagExamples }),
		properties: {
			lang: {
				type: "string",
				description: text.format("schema.authored_text.language", { languageTagExamples: languageTagExamples }),
			},
			text: {
				type: "string",
				description: text.format(authoredTextMessages[purpose].label),
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
	text: BotText,
	name: Name,
	description: InstructionText,
	properties: ToolParameterProperties,
	required: string[] = [],
	additionalProperties?: boolean,
): FunctionToolDefinition {
	return {
		type: "function",
		function: {
			name,
			description: text.format("schema.example_arguments", { description: description, exampleArguments: JSON.stringify(bickrFunctionToolArgumentExamples(text)[name]) }),
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
	text: BotText,
	name: Name,
	description: InstructionText,
	properties: ToolParameterProperties,
	required: string[] = [],
): FunctionToolDefinition {
	return functionTool(text, name, description, properties, required);
}

export function metaCompactionToolDefinition(
	text: BotText,
	maxCharacters = defaultMetaCompactionMaxCharacters,
	_minCharacters = 1,
): FunctionToolDefinition {
	const maxLength = Math.max(1, Math.floor(maxCharacters));
	const definition = functionTool(
		text,
		metaCompactionToolName,
		text.format("tools.provide_summary.description"),
		{
			[providerCompactionSummaryProperty]: {
				type: "string",
				description: providerCompactionSummaryPropertyDescription(text),
				minLength: 1,
				maxLength,
			},
		},
		[providerCompactionSummaryProperty],
		false,
	);
	definition.function.parameters.description = providerCompactionSummarySchemaDescription(text);
	return definition;
}

export function providerTranslationToolDefinitions(text: BotText): [FunctionToolDefinition] {
	return [
		functionTool(
			text,
			providerTranslationToolName,
			text.format("tools.save_translation.description"),
			{ translation: { type: "string" } },
			["translation"],
			false,
		),
	];
}

export const providerAvatarDescriptionToolName = "save_avatar_description";

export function providerAvatarDescriptionToolDefinitions(text: BotText): [FunctionToolDefinition] {
	return [
		functionTool(
			text,
			providerAvatarDescriptionToolName,
			text.format("tools.save_avatar_description.description"),
			{ description: { type: "string" } },
			["description"],
			false,
		),
	];
}

export function bickrFunctionToolArgumentExample(text: BotText, name: string): string | undefined {
	if (!Object.hasOwn(bickrFunctionToolArgumentExamples(text), name)) {
		return undefined;
	}
	return JSON.stringify(bickrFunctionToolArgumentExamples(text)[name as BickrFunctionToolName]);
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
