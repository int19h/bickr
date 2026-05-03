import { describe, expect, it } from "vitest";
import {
	interpolateTokenUsageChartValue,
	type TokenUsageChartPoint,
} from "../apps/web/src/token-usage-chart";

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
