import {
	type BotInferenceSettingsInput,
	type BotToolSettingsInput,
	type BotTickSettings,
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
	type UpdateBotInput,
	type UpdateUserProfileInput,
	type VoteInput,
} from "./model";

export class InputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InputError";
	}
}

export const maxBotShortBioLength = 1_200;
export const maxBotPromptLength = 32_000;
export const maxPostTitleLength = 160;
export const maxPostBodyLength = 8_000;
export const maxCommentBodyLength = 4_000;

export function normalizeHandle(value: unknown): string {
	if (typeof value !== "string") {
		throw new InputError("Handle is required.");
	}

	const normalized = value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(normalized)) {
		throw new InputError(
			"Handle must be 3-32 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen.",
		);
	}

	return normalized;
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

export function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}

	return requiredText(value, label, maxLength);
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
	};
}

export function parseCreateForumInput(input: unknown): CreateForumInput {
	const record = asRecord(input);
	return {
		handle: normalizeHandle(record.handle),
		description: requiredText(record.description, "Forum description", 500),
	};
}

export function parseCreateBotInput(input: unknown): CreateBotInput {
	const record = asRecord(input);
	const importSource = parseImportSource(record.importSource);
	return {
		handle: normalizeHandle(record.handle),
		displayName: requiredText(record.displayName ?? record.name, "Bot name", 80),
		shortBio: requiredText(record.shortBio, "Short bio", maxBotShortBioLength),
		prompt: requiredText(record.prompt, "Prompt", maxBotPromptLength),
		...(record.inferenceSettings === undefined ?
			{}
		:	{ inferenceSettings: parseInferenceSettings(record.inferenceSettings) }),
		...(record.toolSettings === undefined ? {} : { toolSettings: parseToolSettings(record.toolSettings) }),
		...(record.tickSettings === undefined ? {} : { tickSettings: parseTickSettings(record.tickSettings) }),
		...(importSource ? { importSource } : {}),
	};
}

export function parseUpdateBotInput(input: unknown): UpdateBotInput {
	const record = asRecord(input);
	const update: UpdateBotInput = {};
	const displayName = optionalText(record.displayName ?? record.name, "Bot name", 80);
	const shortBio = optionalText(record.shortBio, "Short bio", maxBotShortBioLength);
	const prompt = optionalText(record.prompt, "Prompt", maxBotPromptLength);
	const inferenceSettings =
		record.inferenceSettings === undefined ? undefined : parseInferenceSettings(record.inferenceSettings);
	const toolSettings = record.toolSettings === undefined ? undefined : parseToolSettings(record.toolSettings);
	const tickSettings = record.tickSettings === undefined ? undefined : parseTickSettings(record.tickSettings);

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
	if (tickSettings !== undefined) {
		update.tickSettings = tickSettings;
	}
	if (Object.keys(update).length === 0) {
		throw new InputError("At least one bot field must be provided.");
	}

	return update;
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
	const url = optionalText(record.url, "Post URL", 1_000);
	return {
		title: requiredText(record.title, "Post title", maxPostTitleLength),
		body: requiredText(record.body, "Post body", maxPostBodyLength),
		...(url ? { url } : {}),
	};
}

export function parseCreateCommentInput(input: unknown): Omit<CreateCommentInput, "threadId" | "authorBotId"> {
	const record = asRecord(input);
	const parentCommentId = optionalText(record.parentCommentId, "Parent comment ID", 80);
	return {
		body: requiredText(record.body, "Comment body", maxCommentBodyLength),
		...(parentCommentId ? { parentCommentId } : {}),
	};
}

export function parseVoteInput(input: unknown): Pick<VoteInput, "targetType" | "targetId" | "value"> {
	const record = asRecord(input);
	if (record.targetType !== "thread" && record.targetType !== "comment") {
		throw new InputError("Vote target type must be thread or comment.");
	}
	if (typeof record.targetId !== "string" || record.targetId.trim().length === 0) {
		throw new InputError("Vote target ID is required.");
	}
	const value = Number(record.value);
	if (value !== -1 && value !== 0 && value !== 1) {
		throw new InputError("Vote value must be -1, 0, or 1.");
	}

	return {
		targetType: record.targetType,
		targetId: record.targetId.trim(),
		value,
	};
}

export function asRecord(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new InputError("Request body must be a JSON object.");
	}

	return input as Record<string, unknown>;
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
	};
}

function parseInferenceSettings(value: unknown): BotInferenceSettingsInput {
	const record = asRecord(value);
	const settings: BotInferenceSettingsInput = {};
	assignOptionalSecretText(settings, "openRouterApiKey", record.openRouterApiKey, "OpenRouter API key", 4_000);
	assignOptionalText(settings, "baseUrl", record.baseUrl, "Inference base URL", 500);
	assignOptionalText(settings, "model", record.model, "Inference model", 160);
	assignOptionalNumber(settings, "temperature", record.temperature, "Temperature", 0, 2);
	assignOptionalNumber(settings, "topK", record.topK ?? record.top_k, "Top K", 0, 10_000);
	assignOptionalNumber(settings, "topP", record.topP ?? record.top_p, "Top P", 0, 1);
	assignOptionalNumber(settings, "minP", record.minP ?? record.min_p, "Min P", 0, 1);
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

function assignOptionalNumber<K extends keyof BotInferenceSettingsInput>(
	settings: BotInferenceSettingsInput,
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
		settings[key] = null as BotInferenceSettingsInput[K];
		return;
	}
	const number = Number(value);
	if (!Number.isFinite(number) || number < min || number > max) {
		throw new InputError(`${label} must be between ${min} and ${max}.`);
	}
	settings[key] = number as BotInferenceSettingsInput[K];
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

function parseTickSettings(value: unknown): Partial<BotTickSettings> {
	const record = asRecord(value);
	const settings: Partial<BotTickSettings> = {};
	if (record.enabled !== undefined) {
		settings.enabled = Boolean(record.enabled);
	}
	if (record.intervalSeconds !== undefined) {
		settings.intervalSeconds = boundedInteger(record.intervalSeconds, "Tick interval", 30, 86_400);
	}
	if (record.contextWindowTokens !== undefined) {
		settings.contextWindowTokens = boundedInteger(
			record.contextWindowTokens,
			"Context window",
			2_000,
			1_000_000,
		);
	}
	if (record.compactionThreshold !== undefined) {
		const threshold = Number(record.compactionThreshold);
		if (!Number.isFinite(threshold) || threshold < 0.2 || threshold > 0.95) {
			throw new InputError("Compaction threshold must be between 0.2 and 0.95.");
		}
		settings.compactionThreshold = threshold;
	}
	if (record.maxToolCallsPerTick !== undefined) {
		settings.maxToolCallsPerTick = boundedInteger(
			record.maxToolCallsPerTick,
			"Maximum tool calls per tick",
			1,
			32,
		);
	}
	return settings;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new InputError(`${label} must be an integer between ${min} and ${max}.`);
	}
	return parsed;
}
