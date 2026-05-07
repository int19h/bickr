export type TokenUsageChartMetric = "totalTokens" | "cachedTokens";

export type TokenUsageChartPoint = Readonly<{
	timeMs: number;
	x: number;
	totalTokens: number;
	cachedTokens: number;
}>;

export type ContextWindowBarInput = Readonly<{
	contextWindowTokens: number;
	promptTokens: number;
	initialTokens: number;
	ongoingTokens: number;
	compactionCutoffTokens: number;
}>;

export type ContextWindowBarSegments = Readonly<{
	initialPercent: number;
	ongoingPercent: number;
	freePercent: number;
	cutoffPercent: number;
	usedTokens: number;
	visibleInitialTokens: number;
	visibleOngoingTokens: number;
	visibleFreeTokens: number;
	overCutoffTokens: number;
	overWindowTokens: number;
}>;

export function contextWindowBarSegments(input: ContextWindowBarInput): ContextWindowBarSegments {
	const contextWindowTokens = Math.max(1, Math.floor(input.contextWindowTokens));
	const promptTokens = Math.max(0, Math.floor(input.promptTokens));
	const visibleUsedTokens = Math.min(promptTokens, contextWindowTokens);
	const visibleInitialTokens = Math.min(
		Math.max(0, Math.floor(input.initialTokens)),
		visibleUsedTokens,
	);
	const visibleOngoingTokens = Math.min(
		Math.max(0, Math.floor(input.ongoingTokens)),
		Math.max(0, visibleUsedTokens - visibleInitialTokens),
	);
	const visibleFreeTokens = Math.max(0, contextWindowTokens - visibleInitialTokens - visibleOngoingTokens);
	const percent = (tokens: number): number => (tokens / contextWindowTokens) * 100;
	return {
		initialPercent: percent(visibleInitialTokens),
		ongoingPercent: percent(visibleOngoingTokens),
		freePercent: percent(visibleFreeTokens),
		cutoffPercent: Math.max(0, Math.min(100, percent(Math.max(0, Math.floor(input.compactionCutoffTokens))))),
		usedTokens: visibleUsedTokens,
		visibleInitialTokens,
		visibleOngoingTokens,
		visibleFreeTokens,
		overCutoffTokens: Math.max(0, promptTokens - Math.max(0, Math.floor(input.compactionCutoffTokens))),
		overWindowTokens: Math.max(0, promptTokens - contextWindowTokens),
	};
}

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
