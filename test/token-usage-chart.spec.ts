import { describe, expect, it } from "vitest";
import {
	contextWindowBarSegments,
	interpolateTokenUsageChartValue,
	type TokenUsageChartPoint,
} from "../apps/web/src/token-usage-chart";
import { loopContinuationRowsForPage } from "../apps/web/src/loop-page-continuations";
import { loopPagePagerItems } from "../apps/web/src/loop-page-pager";

function point(timeMs: number, totalTokens: number, cachedTokens = 0): TokenUsageChartPoint {
	return { timeMs, x: timeMs, totalTokens, cachedTokens };
}

describe("interpolateTokenUsageChartValue", () => {
	it("returns the value on the rendered polyline at an intermediate timestamp", () => {
		const points = [
			point(0, 0),
			point(100, 1000),
			point(200, 500),
		];

		expect(interpolateTokenUsageChartValue(points, 25, "totalTokens")).toBe(250);
		expect(interpolateTokenUsageChartValue(points, 150, "totalTokens")).toBe(750);
	});

	it("clamps to the nearest endpoint outside the rendered range", () => {
		const points = [
			point(100, 1000, 250),
			point(200, 500, 100),
		];

		expect(interpolateTokenUsageChartValue(points, 50, "cachedTokens")).toBe(250);
		expect(interpolateTokenUsageChartValue(points, 250, "cachedTokens")).toBe(100);
	});
});

describe("contextWindowBarSegments", () => {
	it("converts context token segments into clamped bar percentages", () => {
		const segments = contextWindowBarSegments({
			contextWindowTokens: 10_000,
			promptTokens: 8_000,
			initialTokens: 3_000,
			ongoingTokens: 5_000,
			compactionCutoffTokens: 7_500,
		});

		expect(segments).toMatchObject({
			initialPercent: 30,
			ongoingPercent: 50,
			freePercent: 20,
			cutoffPercent: 75,
			overCutoffTokens: 500,
			overWindowTokens: 0,
		});
	});

	it("clamps visible used segments when prompt tokens exceed the context window", () => {
		const segments = contextWindowBarSegments({
			contextWindowTokens: 10_000,
			promptTokens: 12_000,
			initialTokens: 7_000,
			ongoingTokens: 5_000,
			compactionCutoffTokens: 15_000,
		});

		expect(segments.initialPercent).toBe(70);
		expect(segments.ongoingPercent).toBe(30);
		expect(segments.freePercent).toBe(0);
		expect(segments.cutoffPercent).toBe(100);
		expect(segments.overWindowTokens).toBe(2_000);
	});
});

describe("loopContinuationRowsForPage", () => {
	it("places continued-from at the start and continued-on at the end", () => {
		expect(loopContinuationRowsForPage({
			currentPage: 2,
			pageCount: 3,
			pages: [],
			compactionPageBySeq: { "20": 2 },
			olderPage: 3,
			newerPage: 1,
		})).toEqual([
			{ position: "start", label: "continued from", page: 3 },
			{ position: "end", label: "continued on", page: 1 },
		]);
	});
});

describe("loopPagePagerItems", () => {
	it("shows every page when there are fewer than 25 pages", () => {
		expect(loopPagePagerItems(loopPage(7, 4)).map(itemLabel)).toEqual(["1", "2", "3", "4*", "5", "6", "7"]);
	});

	it("centers 25 pages around the current page", () => {
		const items = loopPagePagerItems(loopPage(50, 25));

		expect(items.map(itemLabel)).toEqual([
			"...<1",
			"13",
			"14",
			"15",
			"16",
			"17",
			"18",
			"19",
			"20",
			"21",
			"22",
			"23",
			"24",
			"25*",
			"26",
			"27",
			"28",
			"29",
			"30",
			"31",
			"32",
			"33",
			"34",
			"35",
			"36",
			"37",
			"...>50",
		]);
	});

	it("fills from the other side near the start and end", () => {
		expect(loopPagePagerItems(loopPage(50, 3)).filter((item) => item.kind === "page").map((item) => item.page)).toEqual(
			Array.from({ length: 25 }, (_, index) => index + 1),
		);
		expect(loopPagePagerItems(loopPage(50, 49)).filter((item) => item.kind === "page").map((item) => item.page)).toEqual(
			Array.from({ length: 25 }, (_, index) => index + 26),
		);
	});

	it("uses ellipses that jump 25 pages and clamp to valid pages", () => {
		expect(loopPagePagerItems(loopPage(100, 50)).filter((item) => item.kind === "ellipsis")).toEqual([
			{ kind: "ellipsis", page: 25, direction: "backward" },
			{ kind: "ellipsis", page: 75, direction: "forward" },
		]);
		expect(loopPagePagerItems(loopPage(30, 18)).filter((item) => item.kind === "ellipsis")).toEqual([
			{ kind: "ellipsis", page: 1, direction: "backward" },
		]);
	});
});

function loopPage(pageCount: number, currentPage: number) {
	return {
		currentPage,
		pageCount,
		pages: Array.from({ length: pageCount }, (_, index) => ({
			page: index + 1,
			messageCount: index + 1,
		})),
		compactionPageBySeq: {},
	};
}

function itemLabel(item: ReturnType<typeof loopPagePagerItems>[number]): string {
	if (item.kind === "ellipsis") {
		return item.direction === "backward" ? `...<${item.page}` : `...>${item.page}`;
	}
	return `${item.page}${item.current ? "*" : ""}`;
}
