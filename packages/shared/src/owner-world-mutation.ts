import type {
	AddBotGroupMembersInput,
	AvatarCrop,
	AvatarImage,
	AvatarImageSource,
	BotGroupSummary,
	CreateBotGroupInput,
	UpdateBotGroupInput,
	UpdateWorldInput,
	WorldSummary,
} from "./model";
import {
	InputError,
	normalizeHandle,
	parseAddBotGroupMembersInput,
	parseCreateBotGroupInput,
	parseUpdateBotGroupInput,
	parseUpdateWorldInput,
} from "./validation";

export type OwnerWorldMutation =
	| { kind: "world_update"; worldHandle: string; input: UpdateWorldInput }
	| { kind: "avatar_update"; worldHandle: string; avatar?: AvatarImage }
	| { kind: "bot_group_create"; worldHandle: string; input: CreateBotGroupInput }
	| { kind: "bot_group_update"; worldHandle: string; groupId: string; input: UpdateBotGroupInput }
	| { kind: "bot_group_delete"; worldHandle: string; groupId: string }
	| { kind: "bot_group_members_add"; worldHandle: string; groupId: string; input: AddBotGroupMembersInput }
	| { kind: "bot_group_member_remove"; worldHandle: string; groupId: string; botId: string };

export type OwnerWorldMutationResult =
	| { kind: "world_updated"; world: WorldSummary }
	| { kind: "bot_group_created"; group: BotGroupSummary }
	| { kind: "bot_group_updated"; group: BotGroupSummary }
	| { kind: "bot_group_deleted"; group: BotGroupSummary };

export function parseOwnerWorldMutation(value: unknown): OwnerWorldMutation {
	const record = requiredRecord(value, "Owner world mutation");
	const worldHandle = normalizeHandle(requiredString(record.worldHandle, "World handle"));
	switch (record.kind) {
		case "world_update":
			return { kind: record.kind, worldHandle, input: parseUpdateWorldInput(record.input) };
		case "avatar_update":
			return {
				kind: record.kind,
				worldHandle,
				...(record.avatar === undefined ? {} : { avatar: parseAvatarImage(record.avatar) }),
			};
		case "bot_group_create":
			return { kind: record.kind, worldHandle, input: parseCreateBotGroupInput(record.input) };
		case "bot_group_update":
			return {
				kind: record.kind,
				worldHandle,
				groupId: requiredString(record.groupId, "Group id"),
				input: parseUpdateBotGroupInput(record.input),
			};
		case "bot_group_delete":
			return { kind: record.kind, worldHandle, groupId: requiredString(record.groupId, "Group id") };
		case "bot_group_members_add":
			return {
				kind: record.kind,
				worldHandle,
				groupId: requiredString(record.groupId, "Group id"),
				input: parseAddBotGroupMembersInput(record.input),
			};
		case "bot_group_member_remove":
			return {
				kind: record.kind,
				worldHandle,
				groupId: requiredString(record.groupId, "Group id"),
				botId: requiredString(record.botId, "Bot id"),
			};
		default:
			throw new InputError("Owner world mutation kind is invalid.");
	}
}

export function parseOwnerWorldMutationResult(value: unknown): OwnerWorldMutationResult {
	const record = requiredRecord(value, "Owner world mutation result");
	switch (record.kind) {
		case "world_updated":
			return { kind: record.kind, world: requiredRecord(record.world, "Updated world") as WorldSummary };
		case "bot_group_created":
		case "bot_group_updated":
		case "bot_group_deleted":
			return { kind: record.kind, group: requiredRecord(record.group, "Bot group") as BotGroupSummary };
		default:
			throw new InputError("Owner world mutation result kind is invalid.");
	}
}

function parseAvatarImage(value: unknown): AvatarImage {
	const record = requiredRecord(value, "Avatar");
	return {
		key: requiredString(record.key, "Avatar key"),
		url: requiredString(record.url, "Avatar URL"),
		contentType: requiredString(record.contentType, "Avatar content type"),
		...(record.byteLength === undefined ? {} : { byteLength: nonnegativeNumber(record.byteLength, "Avatar byte length") }),
		...(record.width === undefined ? {} : { width: positiveNumber(record.width, "Avatar width") }),
		...(record.height === undefined ? {} : { height: positiveNumber(record.height, "Avatar height") }),
		...(record.crop === undefined ? {} : { crop: parseAvatarCrop(record.crop) }),
		...(record.source === undefined ? {} : { source: parseAvatarSource(record.source) }),
		updatedAt: requiredString(record.updatedAt, "Avatar update time"),
	};
}

function parseAvatarCrop(value: unknown): AvatarCrop {
	const record = requiredRecord(value, "Avatar crop");
	return {
		x: nonnegativeNumber(record.x, "Avatar crop x"),
		y: nonnegativeNumber(record.y, "Avatar crop y"),
		size: positiveNumber(record.size, "Avatar crop size"),
		imageWidth: positiveNumber(record.imageWidth, "Avatar crop image width"),
		imageHeight: positiveNumber(record.imageHeight, "Avatar crop image height"),
	};
}

function parseAvatarSource(value: unknown): AvatarImageSource {
	const record = requiredRecord(value, "Avatar source");
	switch (record.type) {
		case "upload":
			return {
				type: record.type,
				uploadedAt: requiredString(record.uploadedAt, "Avatar upload time"),
				...(record.originalFilename === undefined ? {} : { originalFilename: requiredString(record.originalFilename, "Avatar filename") }),
			};
		case "remote_url":
			return {
				type: record.type,
				sourceUrl: requiredString(record.sourceUrl, "Avatar source URL"),
				importedAt: requiredString(record.importedAt, "Avatar import time"),
			};
		case "chirper":
			return {
				type: record.type,
				sourceUrl: requiredString(record.sourceUrl, "Avatar source URL"),
				originalHandle: requiredString(record.originalHandle, "Avatar source handle"),
				importedAt: requiredString(record.importedAt, "Avatar import time"),
			};
		case "generated":
			return {
				type: record.type,
				model: requiredString(record.model, "Avatar model"),
				generatedAt: requiredString(record.generatedAt, "Avatar generation time"),
				...(record.cost === undefined ? {} : { cost: nonnegativeNumber(record.cost, "Avatar cost") }),
				...(record.prompt === undefined ? {} : { prompt: requiredString(record.prompt, "Avatar prompt", true) }),
			};
		default:
			throw new InputError("Avatar source type is invalid.");
	}
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new InputError(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
		throw new InputError(`${label} is required.`);
	}
	return value;
}

function nonnegativeNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new InputError(`${label} must be a nonnegative number.`);
	}
	return value;
}

function positiveNumber(value: unknown, label: string): number {
	const number = nonnegativeNumber(value, label);
	if (number === 0) {
		throw new InputError(`${label} must be positive.`);
	}
	return number;
}
