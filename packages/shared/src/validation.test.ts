import { describe, expect, it } from "vitest";
import { parseCreateBotInput, parseCreateForumInput, parseUpdateBotInput, parseUpdateForumInput, parseVoteInput } from "./validation";
import { mergeToolSettings } from "./repository";

describe("instruction language defaults", () => {
	const input = { handle: "participant", language: "ja", displayName: "Participant", shortBio: "Biography", prompt: "Authored instructions" };
	it("defaults new participants to English without changing their speaking language", () => {
		expect(parseCreateBotInput(input)).toMatchObject({ language: "ja", instructionLanguage: { kind: "fixed", locale: "en" } });
		expect(parseCreateBotInput({ ...input, cloneSourceBotId: "bot_source" }).instructionLanguage).toEqual({ kind: "fixed", locale: "en" });
	});
	it("preserves explicit Auto and does not add a default to unrelated updates", () => {
		expect(parseCreateBotInput({ ...input, instructionLanguage: { kind: "auto" } }).instructionLanguage).toEqual({ kind: "auto" });
		expect(parseUpdateBotInput({ language: "ko" })).not.toHaveProperty("instructionLanguage");
	});
});

describe("notes settings patch", () => {
	it("accepts a PLAN-only patch and preserves the notes setting", () => {
		const patch = parseUpdateBotInput({ toolSettings: { bickrNotes: { planEnabled: false } } });
		expect(patch.toolSettings).toEqual({ bickrNotes: { planEnabled: false } });
		expect(mergeToolSettings({ bickrNotes: { enabled: true, planEnabled: true } }, patch.toolSettings))
			.toEqual({ bickrNotes: { enabled: true, planEnabled: false } });
	});

	it("rejects empty or invalid notes patches", () => {
		expect(() => parseUpdateBotInput({ toolSettings: { bickrNotes: {} } }))
			.toThrow("Provide a Bickr notes setting.");
		expect(() => parseUpdateBotInput({ toolSettings: { bickrNotes: { planEnabled: "false" } } }))
			.toThrow("Bickr PLAN enabled must be a boolean.");
	});
});

describe("parseVoteInput", () => {
	it("maps current threadId and commentId inputs to the internal vote target", () => {
		expect(parseVoteInput({ threadId: " thr_current ", value: 1 })).toEqual({
			targetType: "thread",
			targetId: "thr_current",
			value: 1,
		});
		expect(parseVoteInput({ commentId: " cmt_current ", value: -1 })).toEqual({
			targetType: "comment",
			targetId: "cmt_current",
			value: -1,
		});
	});

	it("rejects the retired targetType and targetId contract", () => {
		expect(() => parseVoteInput({ targetType: "comment", targetId: "cmt_legacy", value: 1 }))
			.toThrow("Provide exactly one of vote threadId or commentId.");
	});

	it("requires exactly one canonical target", () => {
		expect(() => parseVoteInput({ value: 1 })).toThrow("Provide exactly one of vote threadId or commentId.");
		expect(() => parseVoteInput({ threadId: "thr_current", commentId: "cmt_current", value: 1 }))
			.toThrow("Provide exactly one of vote threadId or commentId.");
	});
});

describe("forum read-only input", () => {
	it("accepts a lone read-only update in either direction", () => {
		expect(parseUpdateForumInput({ readOnly: true })).toEqual({ readOnly: true });
		expect(parseUpdateForumInput({ readOnly: false })).toEqual({ readOnly: false });
	});

	it("leaves read-only unset when the patch omits it", () => {
		expect(parseUpdateForumInput({ handle: "general" })).toEqual({ handle: "general" });
	});

	it("rejects non-boolean read-only values instead of coercing them", () => {
		expect(() => parseUpdateForumInput({ readOnly: "true" })).toThrow("Forum read-only state must be a boolean.");
		expect(() => parseUpdateForumInput({ readOnly: 1 })).toThrow("Forum read-only state must be a boolean.");
		expect(() => parseUpdateForumInput({ readOnly: null })).toThrow("Forum read-only state must be a boolean.");
	});

	it("defaults created forums to writable and accepts an explicit state", () => {
		const base = { handle: "general", language: "en", description: { lang: "en", text: "General discussion." } };
		expect(parseCreateForumInput(base).readOnly).toBeUndefined();
		expect(parseCreateForumInput({ ...base, readOnly: true }).readOnly).toBe(true);
		expect(() => parseCreateForumInput({ ...base, readOnly: "yes" })).toThrow("Forum read-only state must be a boolean.");
	});
});
