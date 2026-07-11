import type { BotLoopMessage, BotLoopMessageLog, BotRuntimeEvent } from "@bickr/shared/model";
import { loopMessageSort } from "../../loop-message-order";
import {
	isLiveProviderLoopMessage,
	removeLiveProviderLoopMessagesForFinalizedMessages,
} from "../../loop-message-streams";

export function upsertEvent(events: BotRuntimeEvent[], event: BotRuntimeEvent): BotRuntimeEvent[] {
	const without = events.filter((item) => item.seq !== event.seq);
	return [...without, event].sort((left, right) => left.seq - right.seq);
}

export function mergeEvents(current: BotRuntimeEvent[], fetched: BotRuntimeEvent[]): BotRuntimeEvent[] {
	const bySeq = new Map(current.map((event) => [event.seq, event]));
	for (const event of fetched) {
		bySeq.set(event.seq, event);
	}
	return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

export function runtimeCompactionMessage(event: BotRuntimeEvent): string | null {
	if (event.type !== "compaction") {
		return null;
	}
	const payload = event.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const status = (payload as { status?: unknown }).status;
	if (status === "pending") {
		return "Compacting loop context...";
	}
	if (status === "complete") {
		return "Loop context compacted.";
	}
	if (status === "failed") {
		return "Loop context compaction failed.";
	}
	return null;
}

export function latestPersistentEventSeq(events: BotRuntimeEvent[]): number {
	return events.reduce((latest, event) => Number.isInteger(event.seq) ? Math.max(latest, event.seq) : latest, 0);
}

export function upsertLoopMessage(messages: BotLoopMessage[], message: BotLoopMessage): BotLoopMessage[] {
	const without = messages.filter((item) => item.seq !== message.seq || item.runId !== message.runId);
	return [...without, message].sort(loopMessageSort);
}

export function mergeLoopMessages(current: BotLoopMessage[], fetched: BotLoopMessage[]): BotLoopMessage[] {
	const retainedCurrent = removeLiveProviderLoopMessagesForFinalizedMessages(
		current.filter(isLiveProviderLoopMessage),
		fetched.filter((message) => message.origin === "provider_response"),
	);
	const bySeq = new Map(retainedCurrent.map((message) => [loopMessageKey(message), message]));
	for (const message of fetched) {
		bySeq.set(loopMessageKey(message), message);
	}
	return [...bySeq.values()].sort(loopMessageSort);
}

export function latestLoopMessageSeq(messages: BotLoopMessage[]): number {
	return messages.reduce((latest, message) => Number.isInteger(message.seq) && !isLiveProviderLoopMessage(message) ? Math.max(latest, message.seq) : latest, 0);
}

export function loopMessageKey(message: BotLoopMessage): string {
	return `${message.runId}:${message.seq}`;
}

export function loopMessageActivityKind(message: BotLoopMessage): "input" | "assistant" | "tool" | "error" {
	if (message.origin === "tool_failure" || message.origin === "runtime_error") {
		return "error";
	}
	if (message.role === "tool") {
		return "tool";
	}
	return message.role === "assistant" ? "assistant" : "input";
}

export function loopMessageTitle(message: BotLoopMessage): string {
	if (message.origin === "compaction") {
		return "Compaction summary";
	}
	if (message.origin === "legacy_migration") {
		return "Legacy history summary";
	}
	if (message.role === "tool") {
		return message.origin === "tool_failure" ? "Tool failure" : "Tool result";
	}
	if (message.origin === "runtime_error") {
		return "Runtime error";
	}
	if (message.origin === "injection") {
		return "Injected thought";
	}
	if (message.origin === "reminder") {
		return "Loop reminder";
	}
	if (message.origin === "synthetic_context") {
		return "Synthetic context";
	}
	if (message.origin === "local_simulation") {
		return "Local simulation";
	}
	if (message.origin === "self_correction") {
		return "Self-correction";
	}
	return message.role === "assistant" ? "Provider response" : "Runtime input";
}

export function loopMessageOriginLabel(origin: BotLoopMessage["origin"]): string {
	switch (origin) {
		case "input":
			return "input";
		case "injection":
			return "injection";
		case "reminder":
			return "reminder";
		case "synthetic_context":
			return "synthetic context";
		case "provider_response":
			return "provider response";
		case "self_correction":
			return "self-correction";
		case "tool_result":
			return "tool result";
		case "tool_failure":
			return "tool failure";
		case "runtime_error":
			return "runtime error";
		case "compaction":
			return "compaction";
		case "legacy_migration":
			return "legacy migration";
		case "local_simulation":
			return "local simulation";
	}
}

export function loopMessageLogKindLabel(kind: BotLoopMessageLog["kind"]): string {
	switch (kind) {
		case "message":
			return "Message";
		case "provider_request":
			return "Provider request";
		case "provider_response":
			return "Provider response";
		case "tool_call":
			return "Tool call";
		case "tool_result":
			return "Tool result";
		case "compaction_request":
			return "Compaction request";
		case "compaction_response":
			return "Compaction response";
	}
}

export function reconnectDelayMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

export function scrollLogToBottom(logRef: { current: HTMLDivElement | null }): number {
	return window.requestAnimationFrame(() => {
		const log = logRef.current;
		if (!log) {
			return;
		}
		log.scrollTop = log.scrollHeight;
		window.requestAnimationFrame(() => {
			if (logRef.current === log) {
				log.scrollTop = log.scrollHeight;
			}
		});
	});
}


export function secondsToMinutes(seconds: number): number {
	return Math.max(1, Math.round(seconds / 60));
}

export function formatTickIntervalMinutes(seconds: number): string {
	const minutes = secondsToMinutes(seconds);
	if (minutes % 1_440 === 0) {
		const days = minutes / 1_440;
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours} hr${hours === 1 ? "" : "s"}`;
	}
	return `${minutes} min`;
}
