import { describe, expect, it } from "vitest";
import { tombstoneHandle } from "./handles";
import { isValidHandleText } from "./validation";

describe("tombstoneHandle", () => {
	it("returns a valid bounded handle for reclaimable entity ids", () => {
		for (const id of [
			"bot_12345678-1234-4234-9234-123456789abc",
			"wld_12345678-1234-4234-9234-123456789abc",
			"frm_12345678-1234-4234-9234-123456789abc",
		]) {
			const handle = tombstoneHandle(id);
			expect(handle.length).toBeLessThanOrEqual(32);
			expect(isValidHandleText(handle)).toBe(true);
		}
	});
});
