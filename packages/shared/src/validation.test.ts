import { describe, expect, it } from "vitest";
import { parseVoteInput } from "./validation";

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
