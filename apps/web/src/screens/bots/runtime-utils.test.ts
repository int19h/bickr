import type { BotLoopMessage } from "@bickr/shared/model";
import { describe, expect, it } from "vitest";
import { loopMessageActivityKind, loopMessageOriginLabel, loopMessageTitle } from "./runtime-utils";

describe("invalid provider Loop rows", () => {
	it("labels dropped provider responses as errors rather than successful responses", () => {
		const message: BotLoopMessage = {
			seq: 1,
			position: 1,
			runId: "run-invalid",
			role: "assistant",
			message: {
				role: "assistant",
				content: null,
				tool_calls: [{
					id: "call-invalid",
					type: "function",
					function: { name: "read_thread", arguments: "[]" },
				}],
			},
			origin: "dropped_provider_response",
			status: "invalid",
			tokenEstimate: 1,
			createdAt: "2026-08-02T00:00:00.000Z",
		};

		expect(loopMessageActivityKind(message)).toBe("error");
		expect(loopMessageTitle(message)).toBe("Invalid provider output");
		expect(loopMessageOriginLabel(message.origin)).toBe("invalid / dropped provider output");
	});
});
