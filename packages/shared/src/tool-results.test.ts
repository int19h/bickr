import { describe, expect, it } from "vitest";
import { seenItemsFromToolResultEnvelope } from "./social";

describe("tool-result envelopes", () => {
	it("fails loudly when a consumer receives an unhandled result kind", () => {
		// The cast simulates a newer producer reaching an older deployed consumer.
		// At compile time, the switch's never assertion also makes adding a real
		// union member fail until every consumer handles it.
		expect(() => seenItemsFromToolResultEnvelope({ kind: "future_kind" } as never))
			.toThrow("Unhandled tool-result envelope kind: future_kind");
	});
});
