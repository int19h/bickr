import {
	type BotInferenceSettingsInput,
	type BotTickSettings,
	type ChirperImportSource,
	type CreateBotInput,
	type CreateCommentInput,
	type CreateForumInput,
	type CreateThreadInput,
	type CreateWorldInput,
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
