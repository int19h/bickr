import { describe, expect, it } from "vitest";
import { isD1UniqueConstraintError } from "./d1-errors";

describe("isD1UniqueConstraintError", () => {
	it("matches D1 unique constraint failures", () => {
		expect(
			isD1UniqueConstraintError(
				new Error("D1_ERROR: UNIQUE constraint failed: bots_index.home_world_id, bots_index.handle"),
			),
		).toBe(true);
	});

	it("rejects unrelated errors", () => {
		expect(isD1UniqueConstraintError(new Error("D1_ERROR: no such table: bots_index"))).toBe(false);
		expect(isD1UniqueConstraintError("UNIQUE constraint failed: bots_index.handle")).toBe(false);
	});
});
