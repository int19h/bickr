import type { BotInferenceSubmissionMessage, BotLoopMessage, BotRuntimeEvent } from "@bickr/shared/model";

const liveStreamSeqBase = 1_000_000_000;

export function upsertLiveProviderLoopMessage(messages: BotLoopMessage[], event: BotRuntimeEvent): BotLoopMessage[] {
	const payload = recordValue(event.payload);
	const kind = stringValue(payload.kind);
	const text = stringValue(payload.text);
	if (!text || (kind !== "content" && kind !== "reasoning")) {
		return messages;
	}
	const seq = liveProviderLoopMessageSeq(event);
	const existing = messages.find((message) => message.seq === seq && message.runId === event.runId);
	const existingMessage = existing?.message;
	const nextMessage: BotInferenceSubmissionMessage = {
		role: "assistant",
		content:
			kind === "content" ?
				`${typeof existingMessage?.content === "string" ? existingMessage.content : ""}${text}`
			:	(existingMessage?.content ?? null),
		...(kind === "reasoning" || existingMessage?.reasoning ?
			{ reasoning: `${existingMessage?.reasoning ?? ""}${kind === "reasoning" ? text : ""}` }
		:	{}),
	};
	const next: BotLoopMessage = {
		seq,
		runId: event.runId,
		role: "assistant",
		message: nextMessage,
		origin: "provider_response",
		tokenEstimate: 0,
		createdAt: existing?.createdAt ?? event.createdAt,
		hasLogs: false,
	};
	return [...messages.filter((message) => message.seq !== seq || message.runId !== event.runId), next].sort(loopMessageSort);
}

export function removeLiveProviderLoopMessagesForRun(messages: BotLoopMessage[], runId: string): BotLoopMessage[] {
	return messages.filter((message) => !(isLiveProviderLoopMessage(message) && message.runId === runId));
}

export function isLiveProviderLoopMessage(message: BotLoopMessage): boolean {
	return message.seq >= liveStreamSeqBase;
}

function liveProviderLoopMessageSeq(event: BotRuntimeEvent): number {
	return liveStreamSeqBase + Math.max(0, Math.floor(event.seq));
}

function loopMessageSort(left: BotLoopMessage, right: BotLoopMessage): number {
	return left.seq - right.seq;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
