import type { AvatarImage } from "@bickr/shared/model";

export type AvatarGenerationChatRole = "system" | "user" | "assistant";

export type AvatarGenerationChatEntry = {
	role: AvatarGenerationChatRole;
	content: string;
	imageCount?: number;
	status?: "streaming" | "complete" | "aborted" | "error";
	statusMessage?: string;
};

export type AvatarGenerationStreamEvent =
	| { type: "messages"; messages: Array<{ role: "system" | "user"; content: string }> }
	| { type: "assistant_delta"; text: string }
	| { type: "assistant_image"; count: number }
	| { type: "done"; candidate: AvatarImage }
	| { type: "error"; message: string }
	| { type: "aborted"; message: string };

export function applyAvatarGenerationStreamEvent(
	entries: AvatarGenerationChatEntry[],
	event: AvatarGenerationStreamEvent,
): AvatarGenerationChatEntry[] {
	switch (event.type) {
		case "messages":
			return [
				...event.messages.map((message): AvatarGenerationChatEntry => ({
					role: message.role,
					content: message.content,
				})),
				{ role: "assistant", content: "", status: "streaming" },
			];
		case "assistant_delta":
			return updateAssistantEntry(entries, (entry) => ({
				...entry,
				content: entry.content + event.text,
				status: entry.status === "aborted" || entry.status === "error" ? entry.status : "streaming",
			}));
		case "assistant_image":
			return updateAssistantEntry(entries, (entry) => ({
				...entry,
				imageCount: Math.max(entry.imageCount ?? 0, event.count),
				status: entry.status === "aborted" || entry.status === "error" ? entry.status : "streaming",
			}));
		case "done":
			return updateAssistantEntry(entries, (entry) => ({
				...entry,
				status: "complete",
			}));
		case "aborted":
			return updateAssistantEntry(entries, (entry) => ({
				...entry,
				status: "aborted",
				statusMessage: event.message,
			}));
		case "error":
			return updateAssistantEntry(entries, (entry) => ({
				...entry,
				status: "error",
				statusMessage: event.message,
			}));
	}
}

export async function readAvatarGenerationEventStream(
	response: Response,
	onEvent: (event: AvatarGenerationStreamEvent) => void,
): Promise<void> {
	if (!response.body) {
		throw new Error("Avatar generation response did not include a stream.");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parsed = parseAvatarGenerationSseBuffer(buffer);
			buffer = parsed.remainder;
			for (const event of parsed.events) {
				onEvent(event);
			}
		}
		buffer += decoder.decode();
		const parsed = parseAvatarGenerationSseBuffer(buffer + "\n\n");
		for (const event of parsed.events) {
			onEvent(event);
		}
	} finally {
		reader.releaseLock();
	}
}

export function parseAvatarGenerationSseBuffer(text: string): {
	events: AvatarGenerationStreamEvent[];
	remainder: string;
} {
	const events: AvatarGenerationStreamEvent[] = [];
	let buffer = text;
	let boundary = buffer.indexOf("\n\n");
	while (boundary >= 0) {
		const raw = buffer.slice(0, boundary);
		buffer = buffer.slice(boundary + 2);
		const data = raw
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("\n");
		const event = parseAvatarGenerationStreamEvent(data);
		if (event) {
			events.push(event);
		}
		boundary = buffer.indexOf("\n\n");
	}
	return { events, remainder: buffer };
}

function parseAvatarGenerationStreamEvent(data: string): AvatarGenerationStreamEvent | null {
	if (!data || data === "[DONE]") {
		return null;
	}
	const parsed = JSON.parse(data) as unknown;
	const record = recordValue(parsed);
	switch (record.type) {
		case "messages": {
			const messages = Array.isArray(record.messages) ? record.messages.map(recordValue).flatMap((message) => {
				const role: "system" | "user" | null = message.role === "system" ? "system" : message.role === "user" ? "user" : null;
				return role && typeof message.content === "string" ? [{ role, content: message.content }] : [];
			}) : [];
			return { type: "messages", messages };
		}
		case "assistant_delta":
			return { type: "assistant_delta", text: typeof record.text === "string" ? record.text : "" };
		case "assistant_image":
			return { type: "assistant_image", count: typeof record.count === "number" ? record.count : 1 };
		case "done":
			return { type: "done", candidate: record.candidate as AvatarImage };
		case "error":
			return { type: "error", message: typeof record.message === "string" ? record.message : "Could not generate avatar." };
		case "aborted":
			return { type: "aborted", message: typeof record.message === "string" ? record.message : "Avatar generation aborted." };
		default:
			return null;
	}
}

function updateAssistantEntry(
	entries: AvatarGenerationChatEntry[],
	update: (entry: AvatarGenerationChatEntry) => AvatarGenerationChatEntry,
): AvatarGenerationChatEntry[] {
	const index = entries.findIndex((entry) => entry.role === "assistant");
	if (index < 0) {
		return [...entries, update({ role: "assistant", content: "" })];
	}
	return entries.map((entry, entryIndex) => entryIndex === index ? update(entry) : entry);
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
