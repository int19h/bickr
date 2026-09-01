import { describe, expect, it } from "vitest";
import type { BotRuntimeEvent } from "@bickr/shared/model";
import { runtimeActivities } from "./runtime-activity-formatting";

describe("runtimeActivities", () => {
	it("renders duplicate create_thread failures with an existing thread link", () => {
		const events: BotRuntimeEvent[] = [{
			seq: 1,
			runId: "run_1",
			type: "tool_result",
			payload: {
				name: "create_thread",
				args: {
					forumHandle: "general",
					title: "Same title",
				},
				result: {
					ok: false,
					code: "conflict",
					message: "A thread titled \"Same title\" already exists in f/general: thr_existing.",
					toolName: "create_thread",
					existingUrlPath: "/w/primary/f/general/t/thr_existing",
					existingThreadId: "thr_existing",
					existingThreadTitle: "Same title",
				},
			},
			tokenEstimate: 0,
			createdAt: "2026-05-06T12:00:00.000Z",
		}];

		const [activity] = runtimeActivities(events, "primary");

		expect(activity?.toolDisplay).toMatchObject({
			variant: "error",
			items: expect.arrayContaining([
				expect.objectContaining({
					key: "existing-thread-thr_existing",
					label: "Existing thread",
					detail: "Same title - thr_existing",
					href: "/w/primary/f/general/t/thr_existing",
				}),
			]),
		});
	});

	it("names a random draw from the typed envelope instead of the generic tool fallback", () => {
		const ranges = [{ min: 1, max: 6 }, { min: 5, max: 5 }];
		const events: BotRuntimeEvent[] = [
			{
				seq: 1,
				runId: "run_random",
				type: "tool_call",
				payload: { name: "draw_random_integers", args: { ranges } },
				tokenEstimate: 0,
				createdAt: "2026-09-01T12:00:00.000Z",
			},
			{
				seq: 2,
				runId: "run_random",
				type: "tool_result",
				payload: {
					name: "draw_random_integers",
					args: { ranges },
					result: [4, 5],
					envelope: { kind: "random_integers_drawn", ranges, numbers: [4, 5] },
				},
				tokenEstimate: 0,
				createdAt: "2026-09-01T12:00:01.000Z",
			},
		];

		const [call, result] = runtimeActivities(events, "primary");

		expect(call?.title).toBe("Drawing 2 random numbers");
		expect(result?.title).toBe("Drew 2 random numbers");
		expect(result?.body).toBe("1 to 6 - 4\nFixed at 5 - 5");
		expect(result?.title).not.toContain("Tool result:");
	});
});
