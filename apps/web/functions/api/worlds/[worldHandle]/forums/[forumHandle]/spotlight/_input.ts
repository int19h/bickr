import { type SpotlightSendInput } from "@bickr/shared/model";

export function parseSpotlightSendInput(value: unknown): SpotlightSendInput {
	const record = inputRecord(value);
	const targetType = record.targetType === "comments" ? "comments" : "threads";
	return {
		targetType,
		threadIds: Array.isArray(record.threadIds) ? record.threadIds.filter(isString) : undefined,
		threadId: typeof record.threadId === "string" ? record.threadId : undefined,
		commentIds: Array.isArray(record.commentIds) ? record.commentIds.filter(isString) : undefined,
		botIds: Array.isArray(record.botIds) ? record.botIds.filter(isString) : [],
		focusText: typeof record.focusText === "string" ? record.focusText : undefined,
		autoStartTick: typeof record.autoStartTick === "boolean" ? record.autoStartTick : undefined,
		spotlightId: typeof record.spotlightId === "string" && record.spotlightId ? record.spotlightId : undefined,
	};
}

function inputRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
