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
});
