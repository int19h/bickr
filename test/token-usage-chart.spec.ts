import { describe, expect, it } from "vitest";
import {
	contextWindowBarSegments,
	interpolateTokenUsageChartValue,
	type TokenUsageChartPoint,
} from "../apps/web/src/token-usage-chart";
import { loopContinuationRowsForPage } from "../apps/web/src/loop-page-continuations";

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
