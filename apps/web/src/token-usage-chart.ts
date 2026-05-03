export type TokenUsageChartMetric = "totalTokens" | "cachedTokens";

export type TokenUsageChartPoint = Readonly<{
	timeMs: number;
	x: number;
	totalTokens: number;
	cachedTokens: number;
}>;

export function interpolateTokenUsageChartValue(
	points: readonly TokenUsageChartPoint[],
	timeMs: number,
	metric: TokenUsageChartMetric,
): number | null {
	if (!Number.isFinite(timeMs) || points.length === 0) {
		return null;
	}
	const sortedPoints = points
		.filter((point) => Number.isFinite(point.timeMs) && Number.isFinite(point[metric]))
		.sort((left, right) => left.timeMs - right.timeMs);
	if (sortedPoints.length === 0) {
		return null;
	}

	const first = sortedPoints[0];
	if (!first) {
		return null;
	}
	if (timeMs <= first.timeMs) {
		return first[metric];
	}

	for (let index = 1; index < sortedPoints.length; index += 1) {
		const previous = sortedPoints[index - 1];
		const current = sortedPoints[index];
		if (!previous || !current || timeMs > current.timeMs) {
			continue;
		}
		const span = current.timeMs - previous.timeMs;
		if (!Number.isFinite(span) || span <= 0) {
			return current[metric];
		}
		const progress = (timeMs - previous.timeMs) / span;
		return previous[metric] + (current[metric] - previous[metric]) * progress;
	}

	const last = sortedPoints[sortedPoints.length - 1];
	return last ? last[metric] : null;
}
