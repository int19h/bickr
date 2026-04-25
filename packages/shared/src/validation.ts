import {
	type ChirperImportSource,
	type CreateBotInput,
	type CreateForumInput,
	type CreateWorldInput,
	type UpdateBotInput,
} from "./model";

export class InputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InputError";
	}
}

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
		shortBio: requiredText(record.shortBio, "Short bio", 280),
		prompt: requiredText(record.prompt, "Prompt", 12_000),
		...(importSource ? { importSource } : {}),
	};
}

export function parseUpdateBotInput(input: unknown): UpdateBotInput {
	const record = asRecord(input);
	const update: UpdateBotInput = {};
	const displayName = optionalText(record.displayName ?? record.name, "Bot name", 80);
	const shortBio = optionalText(record.shortBio, "Short bio", 280);
	const prompt = optionalText(record.prompt, "Prompt", 12_000);

	if (displayName !== undefined) {
		update.displayName = displayName;
	}
	if (shortBio !== undefined) {
		update.shortBio = shortBio;
	}
	if (prompt !== undefined) {
		update.prompt = prompt;
	}
	if (Object.keys(update).length === 0) {
		throw new InputError("At least one bot field must be provided.");
	}

	return update;
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
