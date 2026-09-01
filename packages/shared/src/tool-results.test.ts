import { describe, expect, it } from "vitest";
import { isToolResultEnvelope } from "./legacy-tool-result-adapter";
import { seenItemsFromToolResultEnvelope } from "./social";
import type { ToolResultEnvelope } from "./tool-results";

describe("tool-result envelopes", () => {
	it("fails loudly when a consumer receives an unhandled result kind", () => {
		// The cast simulates a newer producer reaching an older deployed consumer.
		// At compile time, the switch's never assertion also makes adding a real
		// union member fail until every consumer handles it.
		expect(() => seenItemsFromToolResultEnvelope({ kind: "future_kind" } as never))
			.toThrow("Unhandled tool-result envelope kind: future_kind");
	});

	it("recognizes a stored drawn-numbers envelope and marks nothing as seen", () => {
		const envelope: ToolResultEnvelope = { kind: "random_integers_drawn", ranges: [{ min: 1, max: 6 }], numbers: [4] };

		expect(isToolResultEnvelope(envelope)).toBe(true);
		expect(seenItemsFromToolResultEnvelope(envelope)).toEqual([]);
	});
});
