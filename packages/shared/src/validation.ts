import {
	isOpenRouterImageAspectRatio,
	isOpenRouterImageSize,
	type BotImageGenerationSettingsInput,
	type BotInferenceSettingsInput,
	type BotCompactionMode,
	type BotContextBudgetInput,
	type BotTranslationSettingsInput,
	type BotToolSettingsInput,
	type BotTickSettingsInput,
	type ChirperImportSource,
	type CreateBotInput,
	type CreateCommentInput,
	type CreateForumInput,
	type CreateThreadInput,
	type CreateWorldInput,
	type OpenRouterDatetimeToolSettingsInput,
	type OpenRouterSearchContextSize,
	type OpenRouterServerToolSettingsInput,
	type OpenRouterWebFetchEngine,
	type OpenRouterWebFetchToolSettingsInput,
	type OpenRouterWebSearchEngine,
	type OpenRouterWebSearchToolSettingsInput,
	type OpenRouterWebSearchUserLocationInput,
	type PostingSettingsInput,
	type JsonObject,
	type JsonValue,
	type UpdateBotInput,
	type UpdateForumInput,
	type UpdateUserProfileInput,
	type UpdateWorldInput,
	type VoteInput,
} from "./model";
import {
	defaultCommentBodyCharacters,
	defaultPostingSettings,
	defaultThreadBodyCharacters,
	postingHardLimit,
} from "./posting";

export class InputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InputError";
	}
}

export const maxBotShortBioLength = 1_200;
export const maxBotPromptLength = 64_000;
export const maxBotReasoningPrefillLength = 500;
export const maxProviderRoutingJsonLength = 8_000;
const maxThreadTitleLength = 160;
export const maxThreadBodyHardLength = postingHardLimit(defaultThreadBodyCharacters);
export const maxCommentBodyHardLength = postingHardLimit(defaultCommentBodyCharacters);
const inferenceReasoningEfforts = ["default", "none", "minimal", "low", "medium", "high", "xhigh"] as const;
const inferenceToolCallModes = ["require", "railroad", "at_will"] as const;
const compactionModes = ["structured_output", "tool_call", "tool_call_cache_friendly"] as const satisfies readonly BotCompactionMode[];
const structuredToolCallModes = ["require", "railroad"] as const;

export const handlePatternSource = String.raw`[\p{Letter}\p{Number}_-][\p{Letter}\p{Number}\p{Mark}_-]{0,31}`;
export const handleHelpText =
	"Handle must be 1-32 letters, numbers, hyphens, or underscores from any language.";

const handlePattern = new RegExp(`^${handlePatternSource}$`, "u");
const disallowedHandleCharacterPattern = /[^\p{Letter}\p{Number}\p{Mark}_-]+/gu;
type RouteParamValue = string | string[] | undefined;

export function normalizeHandleText(value: string): string {
	return value.trim().normalize("NFKC").toLowerCase();
}

export function isValidHandleText(value: string): boolean {
	return handlePattern.test(normalizeHandleText(value));
}

export function sanitizeHandleInput(value: string, maxLength = 32): string {
	const safeMaxLength = Math.max(0, Math.min(32, Math.trunc(maxLength)));
	const normalized = normalizeHandleText(value).replace(disallowedHandleCharacterPattern, "-");
	return Array.from(normalized).slice(0, safeMaxLength).join("");
}

export function slugifyHandle(value: string, fallback = "", maxLength = 32): string {
	const candidate = sanitizeHandleInput(value, maxLength);
	if (isValidHandleText(candidate)) {
		return candidate;
	}

	return fallback && isValidHandleText(fallback) ? normalizeHandleText(fallback) : "";
}

export function normalizeHandle(value: unknown): string {
	if (typeof value !== "string") {
		throw new InputError("Handle is required.");
	}

	const normalized = normalizeHandleText(value);
	if (!handlePattern.test(normalized)) {
		throw new InputError(handleHelpText);
	}

	return normalized;
}

function routeParam(value: RouteParamValue, label: string): string {
	const raw = Array.isArray(value) ? value[0] : value;
	if (typeof raw !== "string" || raw.length === 0) {
		throw new InputError(`${label} is required.`);
	}
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new InputError(`${label} contains invalid URL encoding.`);
	}
}

export function normalizeHandleParam(value: RouteParamValue, label = "Handle"): string {
	return normalizeHandle(routeParam(value, label));
}

export function requiredText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string") {
		throw new InputError(`${label} is required.`);
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new InputError(`${label} is required.`);
	}

	if (trimmed.length > maxLength) {
		throw new InputError(`${label} must be ${maxLength} characters or fewer.`);
	}

	return trimmed;
}

export function requiredPostingBody(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string") {
		throw new InputError(`${label} is required.`);
	}

	if (value.trim().length === 0) {
		throw new InputError(`${label} is required.`);
	}

	if (value.length > maxLength) {
		throw new InputError(`${label} must be ${maxLength} characters or fewer.`);
	}

	return value;
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}

	return requiredText(value, label, maxLength);
}

function optionalTextPreservingEmpty(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new InputError(`${label} must be text.`);
	}
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		throw new InputError(`${label} must be ${maxLength} characters or fewer.`);
	}
	return trimmed;
}

export function parseCreateWorldInput(input: unknown): CreateWorldInput {
	const record = asRecord(input);
	return {
		handle: normalizeHandle(record.handle),
		name: requiredText(record.name, "World name", 80),
		description: requiredText(record.description, "World description", 500),
		...(record.initialBotNotification === undefined ?
			{}
		:	{
				initialBotNotification: requiredText(
					record.initialBotNotification,
					"Initial bot notification",
					1_000,
				),
			}),
		...(record.postingSettings === undefined ?
			{}
		:	{ postingSettings: parsePostingSettings(record.postingSettings, defaultPostingSettings) }),
	};
}

export function parseUpdateWorldInput(input: unknown): UpdateWorldInput {
	const record = asRecord(input);
	const update: UpdateWorldInput = {};
	if (record.handle !== undefined) {
		update.handle = normalizeHandle(record.handle);
	}
	if (record.name !== undefined) {
		update.name = requiredText(record.name, "World name", 80);
	}
	if (record.description !== undefined) {
		update.description = requiredText(record.description, "World description", 500);
	}
	if (record.initialBotNotification !== undefined) {
		update.initialBotNotification = requiredText(
			record.initialBotNotification,
			"Initial bot notification",
			1_000,
		);
	}
	if (record.postingSettings !== undefined) {
		update.postingSettings = parsePostingSettings(record.postingSettings, defaultPostingSettings);
	}
	if (Object.keys(update).length === 0) {
		throw new InputError("At least one world field must be provided.");
	}
	return update;
}

export function parseCreateForumInput(input: unknown): CreateForumInput {
	const record = asRecord(input);
	return {
		handle: normalizeHandle(record.handle),
		description: requiredText(record.description, "Forum description", 500),
	};
}

export function parseUpdateForumInput(input: unknown): UpdateForumInput {
	const record = asRecord(input);
	const update: UpdateForumInput = {};
	if (record.handle !== undefined) {
		update.handle = normalizeHandle(record.handle);
	}
	if (record.description !== undefined) {
		update.description = requiredText(record.description, "Forum description", 500);
	}
	if (Object.keys(update).length === 0) {
		throw new InputError("At least one forum field must be provided.");
	}
	return update;
}

export function parseCreateBotInput(input: unknown): CreateBotInput {
	const record = asRecord(input);
	const importSource = parseImportSource(record.importSource);
	const cloneSourceBotId = optionalText(record.cloneSourceBotId, "Clone source participant", 80);
	if (cloneSourceBotId && importSource) {
		throw new InputError("Choose either a clone source or an import source.");
	}
	const displayName = cloneSourceBotId ?
		optionalTextPreservingEmpty(record.displayName ?? record.name, "Bot name", 80) ?? ""
	:	requiredText(record.displayName ?? record.name, "Bot name", 80);
	const shortBio = cloneSourceBotId ?
		optionalTextPreservingEmpty(record.shortBio, "Short bio", maxBotShortBioLength) ?? ""
	:	requiredText(record.shortBio, "Short bio", maxBotShortBioLength);
	const prompt = cloneSourceBotId ?
		optionalTextPreservingEmpty(record.prompt, "Prompt", maxBotPromptLength) ?? ""
	:	requiredText(record.prompt, "Prompt", maxBotPromptLength);
	return {
		handle: normalizeHandle(record.handle),
		displayName,
		shortBio,
		prompt,
		...(cloneSourceBotId ? { cloneSourceBotId } : {}),
		...(record.inferenceSettings === undefined ?
			{}
		:	{ inferenceSettings: parseInferenceSettings(record.inferenceSettings) }),
		...(record.toolSettings === undefined ? {} : { toolSettings: parseToolSettings(record.toolSettings) }),
		...(record.postingSettings === undefined ?
			{}
		:	{ postingSettings: parsePostingSettings(record.postingSettings, defaultPostingSettings) }),
		...(record.tickSettings === undefined ? {} : { tickSettings: parseTickSettings(record.tickSettings) }),
		...(importSource ? { importSource } : {}),
	};
}

export function parseUpdateBotInput(input: unknown): UpdateBotInput {
	const record = asRecord(input);
	const update: UpdateBotInput = {};
	const handle = record.handle === undefined ? undefined : normalizeHandle(record.handle);
	const displayName = optionalTextPreservingEmpty(record.displayName ?? record.name, "Bot name", 80);
	const shortBio = optionalTextPreservingEmpty(record.shortBio, "Short bio", maxBotShortBioLength);
	const prompt = optionalTextPreservingEmpty(record.prompt, "Prompt", maxBotPromptLength);
	const inferenceSettings =
		record.inferenceSettings === undefined ? undefined : parseInferenceSettings(record.inferenceSettings);
	const toolSettings = record.toolSettings === undefined ? undefined : parseToolSettings(record.toolSettings);
	const postingSettings =
		record.postingSettings === undefined ? undefined : parsePostingSettings(record.postingSettings, defaultPostingSettings);
	const tickSettings = record.tickSettings === undefined ? undefined : parseTickSettings(record.tickSettings);

	if (handle !== undefined) {
		update.handle = handle;
	}
	if (displayName !== undefined) {
		update.displayName = displayName;
	}
	if (shortBio !== undefined) {
		update.shortBio = shortBio;
	}
	if (prompt !== undefined) {
		update.prompt = prompt;
	}
	if (inferenceSettings !== undefined) {
		update.inferenceSettings = inferenceSettings;
	}
	if (toolSettings !== undefined) {
		update.toolSettings = toolSettings;
	}
	if (postingSettings !== undefined) {
		update.postingSettings = postingSettings;
	}
	if (tickSettings !== undefined) {
		update.tickSettings = tickSettings;
	}
	if (Object.keys(update).length === 0) {
		throw new InputError("At least one bot field must be provided.");
	}

	return update;
}

export function parseBotContextBudgetInput(input: unknown): BotContextBudgetInput {
	const record = asRecord(input);
	const tickSettings =
		record.tickSettings === undefined ?
			undefined
		:	pickContextWindowTickSettings(parseTickSettings(record.tickSettings));
	return {
		...(record.displayName === undefined ? {} : { displayName: requiredText(record.displayName, "Bot name", 80) }),
		prompt: requiredText(record.prompt, "Prompt", maxBotPromptLength),
		...(record.shortBio === undefined ? {} : { shortBio: requiredText(record.shortBio, "Short bio", maxBotShortBioLength) }),
		...(record.inferenceSettings === undefined ?
			{}
		:	{ inferenceSettings: parseInferenceSettings(record.inferenceSettings) }),
		...(record.toolSettings === undefined ? {} : { toolSettings: parseToolSettings(record.toolSettings) }),
		...(record.postingSettings === undefined ?
			{}
		:	{ postingSettings: parsePostingSettings(record.postingSettings, defaultPostingSettings) }),
		...(tickSettings === undefined ? {} : { tickSettings }),
	};
}

export function parseUpdateUserProfileInput(input: unknown): UpdateUserProfileInput {
	const record = asRecord(input);
	const update: UpdateUserProfileInput = {};
	const handle = record.handle === undefined ? undefined : normalizeHandle(record.handle);
	const displayName = optionalText(record.displayName ?? record.name, "Display name", 80);
	const avatarUrl =
		record.avatarUrl === null ? null : optionalText(record.avatarUrl, "Avatar URL", 1_000);
	const inferenceSettings =
		record.inferenceSettings === undefined ? undefined : parseInferenceSettings(record.inferenceSettings);

	if (handle !== undefined) {
		update.handle = handle;
	}
	if (displayName !== undefined) {
		update.displayName = displayName;
	}
	if (avatarUrl !== undefined) {
		update.avatarUrl = avatarUrl;
	}
	if (inferenceSettings !== undefined) {
		update.inferenceSettings = inferenceSettings;
	}
	if (Object.keys(update).length === 0) {
		throw new InputError("At least one profile field must be provided.");
	}

	return update;
}

export function parseCreateThreadInput(input: unknown): Omit<CreateThreadInput, "forumId" | "authorBotId"> {
	const record = asRecord(input);
	const url = optionalText(record.url, "Thread URL", 1_000);
	return {
		title: requiredText(record.title, "Thread title", maxThreadTitleLength),
		body: requiredPostingBody(record.body, "Thread body", maxThreadBodyHardLength),
		...(url ? { url } : {}),
	};
}

export function parseCreateCommentInput(input: unknown): Omit<CreateCommentInput, "threadId" | "authorBotId"> {
	const record = asRecord(input);
	const parentCommentId = optionalText(record.parentCommentId, "Parent comment ID", 80);
	return {
		body: requiredPostingBody(record.body, "Comment body", maxCommentBodyHardLength),
		...(parentCommentId ? { parentCommentId } : {}),
	};
}

export function parseVoteInput(input: unknown): Pick<VoteInput, "targetType" | "targetId" | "value" | "reason"> {
	const record = asRecord(input);
	const commentId =
		typeof record.commentId === "string" && record.commentId.trim().length > 0 ?
			record.commentId.trim()
		:	undefined;
	const legacyTargetType = record.targetType === "thread" || record.targetType === "comment" ? record.targetType : undefined;
	const legacyTargetId =
		typeof record.targetId === "string" && record.targetId.trim().length > 0 ?
			record.targetId.trim()
		:	undefined;
	if (!commentId && (!legacyTargetType || !legacyTargetId)) {
		throw new InputError("Vote comment ID is required.");
	}
	const value = Number(record.value);
	if (value !== -1 && value !== 0 && value !== 1) {
		throw new InputError("Vote value must be -1, 0, or 1.");
	}
	const reason = optionalText(record.reason, "Vote reason", 2_000);

	return {
		targetType: commentId ? "comment" : legacyTargetType!,
		targetId: commentId ?? legacyTargetId!,
		value,
		...(reason ? { reason } : {}),
	};
}

export function asRecord(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new InputError("Request body must be a JSON object.");
	}

	return input as Record<string, unknown>;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(input);
	return prototype === Object.prototype || prototype === null;
}

function parseImportSource(value: unknown): ChirperImportSource | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	const record = asRecord(value);
	if (record.provider !== "chirper") {
		throw new InputError("Only Chirper imports are supported.");
	}

	return {
		provider: "chirper",
		originalHandle: requiredText(record.originalHandle, "Original Chirper handle", 120),
		originalProfileUrl: requiredText(record.originalProfileUrl, "Original Chirper profile URL", 500),
		apiUrl: requiredText(record.apiUrl, "Chirper API URL", 500),
		importedAt: requiredText(record.importedAt, "Import timestamp", 40),
		...(record.sourceAvatarUrl === undefined ?
			{}
		:	{ sourceAvatarUrl: requiredText(record.sourceAvatarUrl, "Chirper avatar URL", 1_000) }),
	};
}

function parseInferenceSettings(value: unknown): BotInferenceSettingsInput {
	const record = asRecord(value);
	const settings: BotInferenceSettingsInput = {};
	assignOptionalSecretText(settings, "openRouterApiKey", record.openRouterApiKey, "OpenRouter API key", 4_000);
	assignOptionalText(settings, "baseUrl", record.baseUrl, "Inference base URL", 500);
	assignOptionalText(settings, "model", record.model, "Inference model", 160);
	assignOptionalEnum(settings, "compactionMode", aliasedValue(record, "compactionMode", "compaction_mode"), "compactionMode", compactionModes);
	assignOptionalNullableBoolean(settings, "cacheFriendlyCompaction", aliasedValue(record, "cacheFriendlyCompaction", "cache_friendly_compaction"));
	if (record.recurringPromptEnabled !== undefined || record.recurring_prompt_enabled !== undefined) {
		const enabled = aliasedValue(record, "recurringPromptEnabled", "recurring_prompt_enabled");
		if (enabled === null) {
			settings.recurringPromptEnabled = null;
		} else if (typeof enabled === "boolean") {
			settings.recurringPromptEnabled = enabled;
		} else {
			throw new InputError("recurringPromptEnabled must be a boolean.");
		}
	}
	assignOptionalPreservedText(
		settings,
		"recurringPrompt",
		aliasedValue(record, "recurringPrompt", "reasoningPrefill"),
		"Recurring prompt",
		maxBotReasoningPrefillLength,
	);
	assignOptionalNullableBoolean(settings, "supportsPrefill", aliasedValue(record, "supportsPrefill", "supports_prefill"));
	assignOptionalEnum(settings, "reasoningEffort", aliasedValue(record, "reasoningEffort", "reasoning_effort"), "Reasoning effort", inferenceReasoningEfforts);
	assignOptionalEnum(settings, "toolCalls", aliasedValue(record, "toolCalls", "tool_calls"), "Tool calls", inferenceToolCallModes);
	if (record.providerRouting !== undefined || record.provider_routing !== undefined) {
		const providerRouting = aliasedValue(record, "providerRouting", "provider_routing");
		settings.providerRouting = providerRouting === null ? null : parseProviderRouting(providerRouting);
	}
	if (record.imageGeneration !== undefined || record.image_generation !== undefined) {
		const imageGeneration = aliasedValue(record, "imageGeneration", "image_generation");
		settings.imageGeneration = imageGeneration === null ? null : parseImageGenerationSettings(imageGeneration);
	}
	if (record.translation !== undefined) {
		settings.translation = record.translation === null ? null : parseTranslationSettings(record.translation);
	}
	assignOptionalNumber(settings, "temperature", record.temperature, "Temperature", 0, 2);
	assignOptionalNumber(settings, "topK", aliasedValue(record, "topK", "top_k"), "Top K", 0, 10_000);
	assignOptionalNumber(settings, "topP", aliasedValue(record, "topP", "top_p"), "Top P", 0, 1);
	assignOptionalNumber(settings, "minP", aliasedValue(record, "minP", "min_p"), "Min P", 0, 1);
	assignOptionalNumber(
		settings,
		"frequencyPenalty",
		aliasedValue(record, "frequencyPenalty", "frequency_penalty"),
		"Frequency penalty",
		-2,
		2,
	);
	assignOptionalNumber(
		settings,
		"presencePenalty",
		aliasedValue(record, "presencePenalty", "presence_penalty"),
		"Presence penalty",
		-2,
		2,
	);
	assignOptionalNumber(
		settings,
		"repetitionPenalty",
		aliasedValue(record, "repetitionPenalty", "repetition_penalty"),
		"Repetition penalty",
		0,
		2,
	);
	return settings;
}

function parseProviderRouting(value: unknown): JsonObject {
	if (!isPlainRecord(value)) {
		throw new InputError("Provider routing must be a JSON object.");
	}
	const routing = jsonObjectValue(value, "Provider routing");
	const encoded = JSON.stringify(routing);
	if (encoded.length > maxProviderRoutingJsonLength) {
		throw new InputError(`Provider routing must be ${maxProviderRoutingJsonLength} characters or fewer.`);
	}
	return routing;
}

function jsonObjectValue(value: Record<string, unknown>, label: string): JsonObject {
	const object: JsonObject = {};
	for (const [key, item] of Object.entries(value)) {
		object[key] = jsonValue(item, `${label}.${key}`);
	}
	return object;
}

function jsonValue(value: unknown, label: string): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new InputError(`${label} must be a finite number.`);
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
	}
	if (isPlainRecord(value)) {
		return jsonObjectValue(value, label);
	}
	throw new InputError(`${label} must contain only JSON values.`);
}

function parseImageGenerationSettings(value: unknown): BotImageGenerationSettingsInput {
	const record = asRecord(value);
	const settings: BotImageGenerationSettingsInput = {};
	assignOptionalPlainText(settings, "model", record.model, "Image generation model", 160);
	assignOptionalPlainText(settings, "prompt", record.prompt, "Image generation prompt", 8_000);
	if (record.providerRouting !== undefined || record.provider_routing !== undefined) {
		const providerRouting = aliasedValue(record, "providerRouting", "provider_routing");
		settings.providerRouting = providerRouting === null ? null : parseProviderRouting(providerRouting);
	}
	assignOptionalImageGenerationChoice(
		settings,
		"aspectRatio",
		aliasedValue(record, "aspectRatio", "aspect_ratio"),
		"Image aspect ratio",
		isOpenRouterImageAspectRatio,
	);
	assignOptionalImageGenerationChoice(
		settings,
		"imageSize",
		aliasedValue(record, "imageSize", "image_size"),
		"Image size",
		isOpenRouterImageSize,
	);
	assignOptionalNumber(settings, "temperature", record.temperature, "Image generation temperature", 0, 2);
	assignOptionalNumber(settings, "topK", aliasedValue(record, "topK", "top_k"), "Image generation top K", 0, 10_000);
	assignOptionalNumber(settings, "topP", aliasedValue(record, "topP", "top_p"), "Image generation top P", 0, 1);
	assignOptionalNumber(settings, "minP", aliasedValue(record, "minP", "min_p"), "Image generation min P", 0, 1);
	assignOptionalNumber(
		settings,
		"frequencyPenalty",
		aliasedValue(record, "frequencyPenalty", "frequency_penalty"),
		"Image generation frequency penalty",
		-2,
		2,
	);
	assignOptionalNumber(
		settings,
		"presencePenalty",
		aliasedValue(record, "presencePenalty", "presence_penalty"),
		"Image generation presence penalty",
		-2,
		2,
	);
	assignOptionalNumber(
		settings,
		"repetitionPenalty",
		aliasedValue(record, "repetitionPenalty", "repetition_penalty"),
		"Image generation repetition penalty",
		0,
		2,
	);
	return settings;
}

function parseTranslationSettings(value: unknown): BotTranslationSettingsInput {
	const record = asRecord(value);
	const settings: BotTranslationSettingsInput = {};
	assignOptionalBoolean(settings, "enabled", record.enabled);
	assignOptionalPlainText(settings, "model", record.model, "Translation model", 160);
	assignOptionalPlainText(settings, "prompt", record.prompt, "Translation prompt", 2_000);
	assignOptionalEnum(settings, "reasoningEffort", aliasedValue(record, "reasoningEffort", "reasoning_effort"), "Translation reasoning effort", inferenceReasoningEfforts);
	assignOptionalEnum(settings, "toolCalls", aliasedValue(record, "toolCalls", "tool_calls"), "Translation tool calls", structuredToolCallModes);
	if (record.providerRouting !== undefined || record.provider_routing !== undefined) {
		const providerRouting = aliasedValue(record, "providerRouting", "provider_routing");
		settings.providerRouting = providerRouting === null ? null : parseProviderRouting(providerRouting);
	}
	assignOptionalNumber(settings, "temperature", record.temperature, "Translation temperature", 0, 2);
	assignOptionalNumber(settings, "topK", aliasedValue(record, "topK", "top_k"), "Translation top K", 0, 10_000);
	assignOptionalNumber(settings, "topP", aliasedValue(record, "topP", "top_p"), "Translation top P", 0, 1);
	assignOptionalNumber(settings, "minP", aliasedValue(record, "minP", "min_p"), "Translation min P", 0, 1);
	assignOptionalNumber(
		settings,
		"frequencyPenalty",
		aliasedValue(record, "frequencyPenalty", "frequency_penalty"),
		"Translation frequency penalty",
		-2,
		2,
	);
	assignOptionalNumber(
		settings,
		"presencePenalty",
		aliasedValue(record, "presencePenalty", "presence_penalty"),
		"Translation presence penalty",
		-2,
		2,
	);
	assignOptionalNumber(
		settings,
		"repetitionPenalty",
		aliasedValue(record, "repetitionPenalty", "repetition_penalty"),
		"Translation repetition penalty",
		0,
		2,
	);
	return settings;
}

function parseToolSettings(value: unknown): BotToolSettingsInput {
	const record = asRecord(value);
	const settings: BotToolSettingsInput = {};
	if (record.openRouter !== undefined) {
		settings.openRouter = record.openRouter === null ? null : parseOpenRouterToolSettings(record.openRouter);
	}
	return settings;
}

function parsePostingSettings(
	value: unknown,
	limits: Pick<PostingSettingsInput, "threadBodyCharacters" | "commentBodyCharacters">,
): PostingSettingsInput {
	if (value === null) {
		return {
			threadBodyCharacters: null,
			commentBodyCharacters: null,
		};
	}
	const record = asRecord(value);
	const settings: PostingSettingsInput = {};
	assignOptionalInteger(
		settings,
		"threadBodyCharacters",
		record.threadBodyCharacters,
		"Thread body characters",
		1,
		limits.threadBodyCharacters ?? defaultThreadBodyCharacters,
	);
	assignOptionalInteger(
		settings,
		"commentBodyCharacters",
		record.commentBodyCharacters,
		"Comment body characters",
		1,
		limits.commentBodyCharacters ?? defaultCommentBodyCharacters,
	);
	return settings;
}

function parseOpenRouterToolSettings(value: unknown): OpenRouterServerToolSettingsInput {
	const record = asRecord(value);
	const settings: OpenRouterServerToolSettingsInput = {};
	if (record.datetime !== undefined) {
		settings.datetime = record.datetime === null ? null : parseOpenRouterDatetimeTool(record.datetime);
	}
	if (record.webSearch !== undefined) {
		settings.webSearch = record.webSearch === null ? null : parseOpenRouterWebSearchTool(record.webSearch);
	}
	if (record.webFetch !== undefined) {
		settings.webFetch = record.webFetch === null ? null : parseOpenRouterWebFetchTool(record.webFetch);
	}
	return settings;
}

function parseOpenRouterDatetimeTool(value: unknown): OpenRouterDatetimeToolSettingsInput {
	const record = asRecord(value);
	const settings: OpenRouterDatetimeToolSettingsInput = {};
	assignOptionalBoolean(settings, "enabled", record.enabled);
	assignOptionalTimezone(settings, "timezone", record.timezone, "Datetime timezone");
	return settings;
}

function parseOpenRouterWebSearchTool(value: unknown): OpenRouterWebSearchToolSettingsInput {
	const record = asRecord(value);
	const settings: OpenRouterWebSearchToolSettingsInput = {};
	assignOptionalBoolean(settings, "enabled", record.enabled);
	assignOptionalEnum(
		settings,
		"engine",
		record.engine,
		"Web search engine",
		["auto", "native", "exa", "firecrawl", "parallel"] satisfies OpenRouterWebSearchEngine[],
	);
	assignOptionalInteger(settings, "maxResults", aliasedValue(record, "maxResults", "max_results"), "Web search max results", 1, 25);
	assignOptionalInteger(
		settings,
		"maxTotalResults",
		aliasedValue(record, "maxTotalResults", "max_total_results"),
		"Web search max total results",
		1,
		1_000,
	);
	assignOptionalEnum(
		settings,
		"searchContextSize",
		aliasedValue(record, "searchContextSize", "search_context_size"),
		"Web search context size",
		["low", "medium", "high"] satisfies OpenRouterSearchContextSize[],
	);
	if (record.userLocation !== undefined || record.user_location !== undefined) {
		const userLocation = aliasedValue(record, "userLocation", "user_location");
		settings.userLocation = userLocation === null ? null : parseOpenRouterUserLocation(userLocation);
	}
	assignOptionalDomainList(settings, "allowedDomains", aliasedValue(record, "allowedDomains", "allowed_domains"), "Allowed domains");
	assignOptionalDomainList(settings, "excludedDomains", aliasedValue(record, "excludedDomains", "excluded_domains"), "Excluded domains");
	return settings;
}

function parseOpenRouterUserLocation(value: unknown): OpenRouterWebSearchUserLocationInput {
	const record = asRecord(value);
	const location: OpenRouterWebSearchUserLocationInput = {};
	assignOptionalPlainText(location, "city", record.city, "Search location city", 120);
	assignOptionalPlainText(location, "region", record.region, "Search location region", 120);
	assignOptionalPlainText(location, "country", record.country, "Search location country", 2);
	assignOptionalTimezone(location, "timezone", record.timezone, "Search location timezone");
	return location;
}

function parseOpenRouterWebFetchTool(value: unknown): OpenRouterWebFetchToolSettingsInput {
	const record = asRecord(value);
	const settings: OpenRouterWebFetchToolSettingsInput = {};
	assignOptionalBoolean(settings, "enabled", record.enabled);
	assignOptionalEnum(
		settings,
		"engine",
		record.engine,
		"Web fetch engine",
		["auto", "native", "exa", "openrouter", "firecrawl"] satisfies OpenRouterWebFetchEngine[],
	);
	assignOptionalInteger(settings, "maxUses", aliasedValue(record, "maxUses", "max_uses"), "Web fetch max uses", 1, 1_000);
	assignOptionalInteger(
		settings,
		"maxContentTokens",
		aliasedValue(record, "maxContentTokens", "max_content_tokens"),
		"Web fetch max content tokens",
		1,
		1_000_000,
	);
	assignOptionalDomainList(settings, "allowedDomains", aliasedValue(record, "allowedDomains", "allowed_domains"), "Allowed domains");
	assignOptionalDomainList(settings, "blockedDomains", aliasedValue(record, "blockedDomains", "blocked_domains"), "Blocked domains");
	return settings;
}

function assignOptionalText<K extends keyof BotInferenceSettingsInput>(
	settings: BotInferenceSettingsInput,
	key: K,
	value: unknown,
	label: string,
	maxLength: number,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "") {
		settings[key] = null as BotInferenceSettingsInput[K];
		return;
	}
	settings[key] = requiredText(value, label, maxLength) as BotInferenceSettingsInput[K];
}

function assignOptionalSecretText<K extends keyof BotInferenceSettingsInput>(
	settings: BotInferenceSettingsInput,
	key: K,
	value: unknown,
	label: string,
	maxLength: number,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		settings[key] = null as BotInferenceSettingsInput[K];
		return;
	}
	if (value === "") {
		return;
	}
	settings[key] = requiredText(value, label, maxLength) as BotInferenceSettingsInput[K];
}

function assignOptionalPreservedText<K extends keyof BotInferenceSettingsInput>(
	settings: BotInferenceSettingsInput,
	key: K,
	value: unknown,
	label: string,
	maxLength: number,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "") {
		settings[key] = null as BotInferenceSettingsInput[K];
		return;
	}
	if (typeof value !== "string") {
		throw new InputError(`${label} must be text.`);
	}
	if (!value.trim()) {
		settings[key] = null as BotInferenceSettingsInput[K];
		return;
	}
	if (value.length > maxLength) {
		throw new InputError(`${label} must be ${maxLength} characters or fewer.`);
	}
	settings[key] = value as BotInferenceSettingsInput[K];
}

function assignOptionalNumber<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: unknown,
	label: string,
	min: number,
	max: number,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "") {
		settings[key] = null as T[K];
		return;
	}
	const number = Number(value);
	if (!Number.isFinite(number) || number < min || number > max) {
		throw new InputError(`${label} must be between ${min} and ${max}.`);
	}
	settings[key] = number as T[K];
}

function assignOptionalPlainText<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: unknown,
	label: string,
	maxLength: number,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "") {
		settings[key] = null as T[K];
		return;
	}
	settings[key] = requiredText(value, label, maxLength) as T[K];
}

function assignOptionalImageGenerationChoice(
	settings: BotImageGenerationSettingsInput,
	key: "aspectRatio" | "imageSize",
	value: unknown,
	label: string,
	isSupported: (value: string) => boolean,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "") {
		settings[key] = null;
		return;
	}
	const text = requiredText(value, label, 40);
	if (!isSupported(text)) {
		throw new InputError(`${label} is not supported.`);
	}
	settings[key] = text;
}

function assignOptionalBoolean<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: unknown,
): void {
	if (value === undefined) {
		return;
	}
	if (typeof value !== "boolean") {
		throw new InputError(`${String(key)} must be a boolean.`);
	}
	settings[key] = Boolean(value) as T[K];
}

function assignOptionalNullableBoolean<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: unknown,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		settings[key] = null as T[K];
		return;
	}
	if (typeof value !== "boolean") {
		throw new InputError(`${String(key)} must be a boolean.`);
	}
	settings[key] = Boolean(value) as T[K];
}

function assignOptionalEnum<T extends object, K extends keyof T, V extends string>(
	settings: T,
	key: K,
	value: unknown,
	label: string,
	allowed: readonly V[],
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "") {
		settings[key] = null as T[K];
		return;
	}
	if (typeof value !== "string" || !allowed.includes(value as V)) {
		throw new InputError(`${label} must be one of ${allowed.join(", ")}.`);
	}
	settings[key] = value as T[K];
}

function assignOptionalInteger<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: unknown,
	label: string,
	min: number,
	max: number,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "") {
		settings[key] = null as T[K];
		return;
	}
	settings[key] = boundedInteger(value, label, min, max) as T[K];
}

function assignOptionalTimezone<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: unknown,
	label: string,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null || value === "") {
		settings[key] = null as T[K];
		return;
	}
	const timezone = requiredText(value, label, 120);
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
	} catch {
		throw new InputError(`${label} must be a valid IANA timezone.`);
	}
	settings[key] = timezone as T[K];
}

function assignOptionalDomainList<T extends object, K extends keyof T>(
	settings: T,
	key: K,
	value: unknown,
	label: string,
): void {
	if (value === undefined) {
		return;
	}
	if (value === null) {
		settings[key] = null as T[K];
		return;
	}
	if (!Array.isArray(value)) {
		throw new InputError(`${label} must be an array of domains.`);
	}
	const domains = value.map((item) => requiredText(item, label, 253).toLowerCase());
	if (domains.length === 0) {
		settings[key] = null as T[K];
		return;
	}
	settings[key] = domains as T[K];
}

function aliasedValue(record: Record<string, unknown>, preferredKey: string, fallbackKey: string): unknown {
	return Object.prototype.hasOwnProperty.call(record, preferredKey) ? record[preferredKey] : record[fallbackKey];
}

function parseTickSettings(value: unknown): BotTickSettingsInput {
	const record = asRecord(value);
	const settings: BotTickSettingsInput = {};
	if (record.enabled !== undefined) {
		settings.enabled = Boolean(record.enabled);
	}
	assignBoundedIntegerSetting(settings, "intervalSeconds", record.intervalSeconds, "Tick interval", 30, 86_400);
	assignNullableBooleanAlias(
		settings,
		"allowEarlyLogOff",
		record,
		"allowEarlyLogOff",
		"allow_early_log_off",
		"Allow to log off early",
	);
	assignNullableBoundedIntegerSetting(
		settings,
		"contextWindowTokens",
		record.contextWindowTokens,
		"Context window",
		2_000,
		1_000_000,
	);
	assignNumberRangeSetting(settings, "compactionThreshold", record.compactionThreshold, "Compaction threshold", 0.2, 0.95);
	for (const rule of nullableTickIntegerSettings) {
		assignNullableBoundedIntegerSetting(settings, rule.key, record[rule.key], rule.label, rule.min, rule.max);
	}
	return settings;
}

type TickBoundedIntegerKey = "intervalSeconds";
type TickNullableBooleanKey = "allowEarlyLogOff";
type TickNullableBoundedIntegerKey =
	| "contextWindowTokens"
	| "compactionSummaryPercent"
	| "compactionMaxCharacters"
	| "maxToolCallsPerTick"
	| "maxSuccessfulToolCallsPerIteration"
	| "maxGeneratedTokensPerTick"
	| "maxGeneratedTokensPerIteration";
type TickNumberRangeKey = "compactionThreshold";

const nullableTickIntegerSettings: readonly {
	key: Exclude<TickNullableBoundedIntegerKey, "contextWindowTokens">;
	label: string;
	min: number;
	max: number;
}[] = [
	{ key: "compactionSummaryPercent", label: "Compaction percentage", min: 1, max: 50 },
	{ key: "compactionMaxCharacters", label: "Max number of characters after compaction", min: 1, max: 1_000_000 },
	{ key: "maxToolCallsPerTick", label: "Max tool call attempts per tick", min: 1, max: 32 },
	{ key: "maxSuccessfulToolCallsPerIteration", label: "Max successful tool calls per iteration", min: 1, max: 32 },
	{ key: "maxGeneratedTokensPerTick", label: "Max generated tokens per tick", min: 1, max: 1_000_000 },
	{ key: "maxGeneratedTokensPerIteration", label: "Max generated tokens per iteration", min: 1, max: 1_000_000 },
];

function assignBoundedIntegerSetting(
	settings: BotTickSettingsInput,
	key: TickBoundedIntegerKey,
	value: unknown,
	label: string,
	min: number,
	max: number,
): void {
	if (value === undefined) {
		return;
	}
	settings[key] = boundedInteger(value, label, min, max);
}

function assignNullableBooleanAlias(
	settings: BotTickSettingsInput,
	key: TickNullableBooleanKey,
	record: Record<string, unknown>,
	preferredKey: string,
	fallbackKey: string,
	label: string,
): void {
	if (record[preferredKey] === undefined && record[fallbackKey] === undefined) {
		return;
	}
	const value = aliasedValue(record, preferredKey, fallbackKey);
	if (value === null) {
		settings[key] = null;
		return;
	}
	if (typeof value !== "boolean") {
		throw new InputError(`${label} must be a boolean.`);
	}
	settings[key] = value;
}

function assignNullableBoundedIntegerSetting(
	settings: BotTickSettingsInput,
	key: TickNullableBoundedIntegerKey,
	value: unknown,
	label: string,
	min: number,
	max: number,
): void {
	if (value === undefined) {
		return;
	}
	settings[key] = value === null ? null : boundedInteger(value, label, min, max);
}

function assignNumberRangeSetting(
	settings: BotTickSettingsInput,
	key: TickNumberRangeKey,
	value: unknown,
	label: string,
	min: number,
	max: number,
): void {
	if (value === undefined) {
		return;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		throw new InputError(`${label} must be between ${min} and ${max}.`);
	}
	settings[key] = parsed;
}

function pickContextWindowTickSettings(
	settings: BotTickSettingsInput,
): Pick<BotTickSettingsInput, "allowEarlyLogOff" | "contextWindowTokens" | "compactionMaxCharacters" | "compactionSummaryPercent"> | undefined {
	const picked: Pick<BotTickSettingsInput, "allowEarlyLogOff" | "contextWindowTokens" | "compactionMaxCharacters" | "compactionSummaryPercent"> = {};
	if (settings.allowEarlyLogOff !== undefined) {
		picked.allowEarlyLogOff = settings.allowEarlyLogOff;
	}
	if (settings.contextWindowTokens !== undefined) {
		picked.contextWindowTokens = settings.contextWindowTokens;
	}
	if (settings.compactionMaxCharacters !== undefined) {
		picked.compactionMaxCharacters = settings.compactionMaxCharacters;
	}
	if (settings.compactionSummaryPercent !== undefined) {
		picked.compactionSummaryPercent = settings.compactionSummaryPercent;
	}
	return Object.keys(picked).length === 0 ? undefined : picked;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new InputError(`${label} must be an integer between ${min} and ${max}.`);
	}
	return parsed;
}
