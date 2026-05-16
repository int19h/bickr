import { describe, expect, it } from "vitest";
import {
	compareMyBotTableRecords,
	myBotsSpendTotal,
	parseMyBotsSortState,
	type MyBotSpendLoadState,
	type MyBotTableRecordForSort,
} from "../apps/web/src/my-bots-table";
import { type BotTokenSpendSummary } from "../packages/shared/src/model";

function spend(cost: number | null, requestCount = 1, unknownCost = cost === null): MyBotSpendLoadState {
	return {
		status: "loaded",
		summary: {
			average: {
				costPerDay: unknownCost ? null : cost,
				dayCount: 1,
				noCurrentModelUsage: false,
				periodEnd: "2026-05-08T00:00:00.000Z",
				periodStart: "2026-05-07T00:00:00.000Z",
				requestCount,
				unknownCost,
			},
			botId: "bot-test",
			currentModel: "test/model",
			generatedAt: "2026-05-08T00:00:00.000Z",
			last24Hours: {
				cost,
				requestCount,
				unknownCost,
				windowEnd: "2026-05-08T00:00:00.000Z",
				windowStart: "2026-05-07T00:00:00.000Z",
			},
		} satisfies BotTokenSpendSummary,
	};
}

function record(handle: string, state?: MyBotSpendLoadState): MyBotTableRecordForSort {
	return {
		bot: { displayName: handle.toUpperCase(), handle },
		effectiveModel: "test/model",
		lastActiveSort: null,
		nextDueSort: null,
		...(state ? { spend: state } : {}),
	};
}

describe("My Bots table helpers", () => {
	it("sorts spend numerically while leaving unknown and loading rows last", () => {
		const rows = [
			record("unknown", spend(null)),
			record("high", spend(0.2)),
			record("low", spend(0.1)),
			record("loading", { status: "loading" }),
		];

		expect([...rows].sort((left, right) => compareMyBotTableRecords(left, right, { direction: "asc", key: "spend" })).map((row) => row.bot.handle))
			.toEqual(["low", "high", "loading", "unknown"]);
		expect([...rows].sort((left, right) => compareMyBotTableRecords(left, right, { direction: "desc", key: "spend" })).map((row) => row.bot.handle))
			.toEqual(["high", "low", "loading", "unknown"]);
	});

	it("parses persisted sort state with a safe fallback", () => {
		expect(parseMyBotsSortState(JSON.stringify({ direction: "desc", key: "spend" }))).toEqual({ direction: "desc", key: "spend" });
		expect(parseMyBotsSortState(JSON.stringify({ direction: "sideways", key: "spend" }))).toEqual({ direction: "asc", key: "handle" });
		expect(parseMyBotsSortState("not json")).toEqual({ direction: "asc", key: "handle" });
	});

	it("sums only the visible records it is given and preserves unknown totals", () => {
		const allRows = [
			record("visible-known", spend(0.4, 2)),
			record("hidden", spend(3, 1)),
			record("visible-unknown", spend(null, 1)),
		];
		const visibleRows = allRows.filter((row) => row.bot.handle.startsWith("visible"));

		expect(myBotsSpendTotal(visibleRows)).toMatchObject({
			cost: null,
			knownCost: 0.4,
			pendingCount: 0,
			requestCount: 3,
			unknownCost: true,
		});
	});
});
