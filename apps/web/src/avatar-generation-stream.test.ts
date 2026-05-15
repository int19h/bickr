import { describe, expect, it } from "vitest";
import {
	applyAvatarGenerationStreamEvent,
	parseAvatarGenerationSseBuffer,
	type AvatarGenerationChatEntry,
} from "./avatar-generation-stream";

describe("avatar generation stream helpers", () => {
	it("parses SSE events split across chunks", () => {
		const imageEvent = `data: ${JSON.stringify({ type: "assistant_image", count: 1 })}\n\n`;
		const first = parseAvatarGenerationSseBuffer(
			`data: ${JSON.stringify({ type: "assistant_delta", text: "hello" })}\n\n` +
			imageEvent.slice(0, 18),
		);
		expect(first.events).toEqual([{ type: "assistant_delta", text: "hello" }]);

		const second = parseAvatarGenerationSseBuffer(first.remainder + imageEvent.slice(18));
		expect(second.events).toEqual([{ type: "assistant_image", count: 1 }]);
	});

	it("builds chat log entries without retaining image data", () => {
		const base64Url = "data:image/png;base64,super-secret-image-bytes";
		let entries: AvatarGenerationChatEntry[] = [];
		entries = applyAvatarGenerationStreamEvent(entries, {
			type: "messages",
			messages: [
				{ role: "system", content: "Create a profile avatar." },
				{ role: "user", content: `Portrait\n\n[current avatar image included]` },
			],
		});
		entries = applyAvatarGenerationStreamEvent(entries, { type: "assistant_delta", text: "Working on it." });
		entries = applyAvatarGenerationStreamEvent(entries, { type: "assistant_image", count: 1 });
		entries = applyAvatarGenerationStreamEvent(entries, {
			type: "done",
			candidate: {
				key: "worlds/w/bots/b/avatar-candidates/a.png",
				url: base64Url,
				contentType: "image/png",
				updatedAt: "2026-05-12T00:00:00.000Z",
			},
		});

		expect(entries).toHaveLength(3);
		expect(entries.find((entry) => entry.role === "assistant")).toMatchObject({
			content: "Working on it.",
			imageCount: 1,
			status: "complete",
		});
		expect(JSON.stringify(entries)).not.toContain(base64Url);
	});

	it("marks the assistant row as aborted", () => {
		let entries: AvatarGenerationChatEntry[] = [];
		entries = applyAvatarGenerationStreamEvent(entries, {
			type: "messages",
			messages: [
				{ role: "system", content: "Create a profile avatar." },
				{ role: "user", content: "Portrait" },
			],
		});
		entries = applyAvatarGenerationStreamEvent(entries, { type: "assistant_delta", text: "Starting." });
		entries = applyAvatarGenerationStreamEvent(entries, {
			type: "aborted",
			message: "Avatar generation aborted.",
		});

		expect(entries.find((entry) => entry.role === "assistant")).toMatchObject({
			content: "Starting.",
			status: "aborted",
			statusMessage: "Avatar generation aborted.",
		});
	});

	it("keeps prompt-fill prefill in the assistant row and parses prompt done events", () => {
		const parsed = parseAvatarGenerationSseBuffer(`data: ${JSON.stringify({ type: "done", prompt: "Final avatar prompt." })}\n\n`);
		expect(parsed.events).toEqual([{ type: "done", prompt: "Final avatar prompt." }]);

		let entries: AvatarGenerationChatEntry[] = [];
		entries = applyAvatarGenerationStreamEvent(entries, {
			type: "messages",
			messages: [
				{ role: "system", content: "Describe a profile image." },
				{ role: "assistant", content: "Existing prompt draft." },
				{ role: "user", content: "Continue the description." },
			],
		});
		entries = applyAvatarGenerationStreamEvent(entries, { type: "assistant_delta", text: "\n\nRefined final prompt." });
		entries = applyAvatarGenerationStreamEvent(entries, { type: "done", prompt: "Refined final prompt." });

		const assistant = entries.find((entry) => entry.role === "assistant");
		expect(assistant).toMatchObject({
			content: "Existing prompt draft.\n\nRefined final prompt.",
			status: "complete",
		});
		expect(entries.at(-1)?.role).toBe("user");
	});
});
