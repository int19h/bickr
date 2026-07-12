import { describe, expect, it } from "vitest";
import {
	effectiveThreadSettings,
	mergeThreadSettings,
	threadLock,
} from "./thread-policy";
import {
	parseCreateForumInput,
	parseCreateWorldInput,
	parseUpdateForumInput,
	parseUpdateWorldInput,
} from "./validation";

const en = (text: string) => ({ lang: "en", text });

describe("thread policy", () => {
	it("uses the smallest global, world, or forum comment limit", () => {
		expect(effectiveThreadSettings(undefined, undefined)).toEqual({ commentLimit: 200 });
		expect(effectiveThreadSettings({ commentLimit: 150 }, undefined)).toEqual({ commentLimit: 150 });
		expect(effectiveThreadSettings(undefined, { commentLimit: 120 })).toEqual({ commentLimit: 120 });
		expect(effectiveThreadSettings({ commentLimit: 90 }, { commentLimit: 120 })).toEqual({ commentLimit: 90 });
		expect(effectiveThreadSettings({ commentLimit: 150 }, { commentLimit: 80 })).toEqual({ commentLimit: 80 });
	});

	it("merges nullable patches and locks exactly at the effective limit", () => {
		expect(mergeThreadSettings({ commentLimit: 120 }, { commentLimit: null })).toEqual({});
		expect(threadLock(119, { commentLimit: 120 })).toBeUndefined();
		expect(threadLock(120, { commentLimit: 120 })).toEqual({ kind: "comment_limit", limit: 120 });
		expect(threadLock(125, { commentLimit: 120 })).toEqual({ kind: "comment_limit", limit: 120 });
	});

	it("parses world and forum comment limits and null inheritance", () => {
		expect(parseCreateWorldInput({
			handle: "world",
			language: "en",
			name: en("World"),
			description: en("Description"),
			threadSettings: { commentLimit: 150 },
		}).threadSettings).toEqual({ commentLimit: 150 });
		expect(parseCreateForumInput({
			handle: "forum",
			language: "en",
			description: en("Description"),
			threadSettings: { commentLimit: 75 },
		}).threadSettings).toEqual({ commentLimit: 75 });
		expect(parseUpdateWorldInput({ threadSettings: null }).threadSettings).toEqual({ commentLimit: null });
		expect(parseUpdateForumInput({ threadSettings: { commentLimit: null } }).threadSettings).toEqual({ commentLimit: null });
	});

	it("rejects comment limits outside the global range", () => {
		expect(() => parseUpdateWorldInput({ threadSettings: { commentLimit: 0 } })).toThrow(
			"Thread comment limit must be an integer between 1 and 200.",
		);
		expect(() => parseUpdateForumInput({ threadSettings: { commentLimit: 201 } })).toThrow(
			"Thread comment limit must be an integer between 1 and 200.",
		);
	});
});
