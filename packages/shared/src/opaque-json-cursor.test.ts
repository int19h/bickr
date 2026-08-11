import { describe, expect, it } from "vitest";
import { decodeOpaqueJsonCursor } from "./opaque-json-cursor";

describe("opaque JSON cursor", () => {
	it("preserves ambiguous Latin-1 bytes in unmarked legacy cursors", () => {
		// Historical cursors encoded JSON characters directly with btoa. The
		// resulting C3 A9 bytes are also valid UTF-8 for é, so this guards the
		// exact legacy behavior until the compatibility branch retires in #158.
		const cursor = btoa(JSON.stringify({ sortName: "Ã©" }));

		expect(decodeOpaqueJsonCursor(cursor)).toEqual({ sortName: "Ã©" });
		expect(decodeOpaqueJsonCursor(cursor)).not.toEqual({ sortName: "é" });
	});
});
