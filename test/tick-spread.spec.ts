import { describe, expect, it } from "vitest";
import { planBotTickSpread, type TickSpreadInput } from "../packages/shared/src/tick-spread";

const now = new Date("2026-05-21T12:00:00.000Z");

function row(botId: string, intervalSeconds: number, nextDueAt: string): TickSpreadInput {
	return {
		botId,
		handle: botId,
		intervalSeconds,
		nextDueAt,
	};
}

function dueSeconds(nextDueAt: string): number {
	return (Date.parse(nextDueAt) - now.getTime()) / 1000;
}

describe("bot tick spread planning", () => {
	it("handles empty and single-bot schedules deterministically", () => {
		expect(planBotTickSpread([], now)).toEqual({
			horizonSeconds: 0,
			scheduled: [],
			usedApproximateHorizon: false,
		});

		const single = planBotTickSpread([row("bot-a", 300, "2026-05-21T12:10:00.000Z")], now);
		expect(single).toMatchObject({
			anchorBotId: "bot-a",
			exactHyperperiodSeconds: 300,
			usedApproximateHorizon: false,
			scheduled: [{ botId: "bot-a", offsetSeconds: 0, orderRelaxed: false }],
		});
		expect(single.scheduled[0]?.nextDueAt).toBe(now.toISOString());
	});

	it("spreads equal intervals evenly while preserving original due order", () => {
		const plan = planBotTickSpread([
			row("bot-a", 60, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 60, "2026-05-21T12:00:02.000Z"),
			row("bot-c", 60, "2026-05-21T12:00:03.000Z"),
			row("bot-d", 60, "2026-05-21T12:00:04.000Z"),
		], now);

		expect(plan.scheduled.map((schedule) => schedule.botId)).toEqual(["bot-a", "bot-b", "bot-c", "bot-d"]);
		expect(plan.scheduled.map((schedule) => schedule.offsetSeconds)).toEqual([0, 15, 30, 45]);
		expect(plan.scheduled.every((schedule) => !schedule.orderRelaxed)).toBe(true);
	});

	it("moves mixed-period bots away from the anchor instead of stacking every first run", () => {
		const plan = planBotTickSpread([
			row("bot-a", 60, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 120, "2026-05-21T12:00:02.000Z"),
			row("bot-c", 90, "2026-05-21T12:00:03.000Z"),
		], now);

		expect(plan.scheduled[0]).toMatchObject({ botId: "bot-a", offsetSeconds: 0 });
		expect(plan.scheduled.slice(1).every((schedule) => schedule.offsetSeconds > 0)).toBe(true);
		expect(new Set(plan.scheduled.map((schedule) => schedule.offsetSeconds)).size).toBeGreaterThan(1);
	});

	it("marks order relaxation when a shorter period cannot run after the previous first-run offset", () => {
		const plan = planBotTickSpread([
			row("bot-a", 100, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 100, "2026-05-21T12:00:02.000Z"),
			row("bot-c", 30, "2026-05-21T12:00:03.000Z"),
		], now);

		expect(plan.scheduled.map((schedule) => schedule.botId)).toEqual(["bot-a", "bot-b", "bot-c"]);
		expect(plan.scheduled[2]?.orderRelaxed).toBe(true);
		expect(plan.scheduled[2]?.offsetSeconds).toBeLessThan(30);
	});

	it("uses a bounded approximation when the exact hyperperiod is impractical", () => {
		const plan = planBotTickSpread([
			row("bot-a", 86_399, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 86_389, "2026-05-21T12:00:02.000Z"),
		], now);

		expect(plan.usedApproximateHorizon).toBe(true);
		expect(plan.exactHyperperiodSeconds).toBeUndefined();
		expect(plan.horizonSeconds).toBeGreaterThan(0);
		expect(plan.horizonSeconds).toBeLessThanOrEqual(604_800);
	});

	it("sets due timestamps from the selected offsets", () => {
		const plan = planBotTickSpread([
			row("bot-a", 60, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 60, "2026-05-21T12:00:02.000Z"),
		], now);

		expect(plan.scheduled.map((schedule) => dueSeconds(schedule.nextDueAt))).toEqual([0, 30]);
	});
});
