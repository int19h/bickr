import type { BotRuntimeEvent } from "@bickr/shared/model";

type RuntimeStreamKind = "content" | "reasoning";

export function pruneStreamEventsForPersistentEvents(
	streamEvents: BotRuntimeEvent[],
	persistentEvents: BotRuntimeEvent[],
): BotRuntimeEvent[] {
	return persistentEvents.reduce(
		(current, event) => pruneStreamEventsForPersistentEvent(current, event),
		streamEvents,
	);
}

function pruneStreamEventsForPersistentEvent(
	streamEvents: BotRuntimeEvent[],
	event: BotRuntimeEvent,
): BotRuntimeEvent[] {
	if (["tick_completed", "tick_failed", "tick_stopped"].includes(event.type)) {
		return streamEvents.filter((streamEvent) => streamEvent.runId !== event.runId);
	}
	const kind = persistentStreamKind(event);
	if (!kind) {
		return streamEvents;
	}
	return streamEvents.filter((streamEvent) => !streamEventIsFinalizedByPersistentEvent(streamEvent, event, kind));
}

function streamEventIsFinalizedByPersistentEvent(
	streamEvent: BotRuntimeEvent,
	event: BotRuntimeEvent,
	kind: RuntimeStreamKind,
): boolean {
	if (streamEvent.runId !== event.runId) {
		return false;
	}
	if (streamEvent.seq > event.seq) {
		return false;
	}
	const payload = runtimeRecord(streamEvent.payload);
	return stringValue(payload.kind) === kind;
}

function persistentStreamKind(event: BotRuntimeEvent): RuntimeStreamKind | null {
	if (event.type === "reasoning_message") {
		return "reasoning";
	}
	if (event.type === "assistant_message") {
		return "content";
	}
	return null;
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}
