import type { BotTokenUsageStats, BotTokenUsageTotals } from "@bickr/shared/model";
import type { CSSProperties, ReactNode } from "react";
import { TimeAgoLabel } from "../../components/record-display";
import {
	contextWindowBarSegments,
	interpolateTokenUsageChartValue,
	tokenUsageModelBreakdownHeaders,
	tokenUsageModelBreakdownRows,
	type TokenUsageChartPoint,
} from "../../token-usage-chart";
import { formatFullDate, formatShortDate } from "../chrome";

export function TokenUsagePanel({ currentModel, usage }: { currentModel: string; usage: BotTokenUsageStats | null }) {
	const hasUsage = Boolean(usage && usage.last7Days.requestCount > 0);
	const modelRows = usage ? tokenUsageModelBreakdownRows(usage.models, currentModel) : [];
	const modelCostFractionDigits = tokenUsageModelCostFractionDigits(modelRows.map((row) => row.breakdown.cost));
	const showModelBreakdown = Boolean(usage && hasUsage);
	return (
		<div className="token-usage-panel">
			<div className="token-usage-head">
				<div>
					<h3>Token Usage</h3>
					{usage && <span>{usage.last7Days.requestCount} tracked request{usage.last7Days.requestCount === 1 ? "" : "s"}</span>}
				</div>
			</div>
			<div className="token-metrics">
				<div>
					<span>24h</span>
					<b>{formatTokenUsageTotals(usage?.last24Hours)}</b>
				</div>
				<div>
					<span>7d</span>
					<b>{formatTokenUsageTotals(usage?.last7Days)}</b>
				</div>
				<div title={usage ? `Based on ${formatAverageDays(usage.dailyAverageDays)} of tracked usage.` : undefined}>
					<span>Avg/day</span>
					<b>{formatTokenUsageTotals(usage ? averageTokenUsageTotals(usage) : undefined)}</b>
				</div>
			</div>
			{usage && hasUsage ?
				<TokenUsageChart usage={usage} />
			:	<div className="token-usage-empty">No exact usage has been reported by the inference provider yet.</div>}
			{showModelBreakdown && (
				<table className="token-model-breakdown">
					<thead>
						<tr>
							{tokenUsageModelBreakdownHeaders.map((header) => (
								<th key={header} scope="col">{header}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{modelRows.length > 0 ?
							modelRows.map(({ breakdown, currentModel: current, key, showModelName }) => (
								<tr
									className={current ? "current-model" : undefined}
									key={key}
									title={`${breakdown.model} via ${breakdown.providerName}: ${formatTokenUsageTotals(breakdown)}${current ? "\nCurrent model" : ""}`}
								>
									<td className="token-model-name">{showModelName ? breakdown.model : ""}</td>
									<td className="token-provider-name">{breakdown.providerName}</td>
									<td>{formatTokenCount(breakdown.totalTokens)}</td>
									<td>{formatTokenCount(breakdown.cachedTokens)}</td>
									<td>{formatTokenCostParts(breakdown.cost, modelCostFractionDigits)}</td>
								</tr>
							))
						:	<tr className="token-model-breakdown-empty">
								<td colSpan={tokenUsageModelBreakdownHeaders.length}>No provider breakdown has been recorded in this window yet.</td>
							</tr>}
					</tbody>
				</table>
			)}
		</div>
	);
}
export function ContextWindowBar({ breakdown, loading = false }: { breakdown: BotTokenUsageStats["contextWindow"]; loading?: boolean }) {
	if (!breakdown) {
		return (
			<div className="context-window-empty">
				{loading ? "Loading current context..." : "No loop inference response has been recorded since the latest compaction."}
			</div>
		);
	}
	const segments = contextWindowBarSegments(breakdown);
	const segmentStyle = (percent: number): CSSProperties => ({ width: `${Math.max(0, Math.min(100, percent))}%` });
	const cutoffStyle: CSSProperties = { left: `${segments.cutoffPercent}%` };
	const statusText =
		segments.overWindowTokens > 0 ?
			`${formatTokenCount(segments.overWindowTokens)} over context window`
		: segments.overCutoffTokens > 0 ?
			`${formatTokenCount(segments.overCutoffTokens)} past next compaction`
		:	`${formatTokenCount(Math.max(0, breakdown.compactionCutoffTokens - breakdown.promptTokens))} before next compaction`;
	const title = [
		`Latest inference: ${formatFullDate(breakdown.usedAt)}`,
		`Model: ${breakdown.model}`,
		`Prompt: ${formatTokenCount(breakdown.promptTokens)} / ${formatTokenCount(breakdown.contextWindowTokens)}`,
		`Initial: ${formatTokenCount(breakdown.initialTokens)}`,
		`Since then: ${formatTokenCount(breakdown.ongoingTokens)}`,
		`Free: ${formatTokenCount(breakdown.freeTokens)}`,
		`Next compaction: ${formatTokenCount(breakdown.compactionCutoffTokens)}`,
		`Response reserve: ${formatTokenCount(breakdown.responseReserveTokens)}`,
	].join("\n");
	return (
		<div className="context-window-panel" title={title}>
			<div className="context-window-head">
				<div>
					<span>Current context</span>
					<b>{formatTokenCount(breakdown.promptTokens)} / {formatTokenCount(breakdown.contextWindowTokens)}</b>
				</div>
				<span>{statusText}</span>
			</div>
			<div className="context-window-bar" role="img" aria-label={`Current context window: ${formatTokenCount(breakdown.promptTokens)} prompt tokens out of ${formatTokenCount(breakdown.contextWindowTokens)}.`}>
				<div className="context-window-segment context-window-initial" style={segmentStyle(segments.initialPercent)} />
				<div className="context-window-segment context-window-ongoing" style={segmentStyle(segments.ongoingPercent)} />
				<div className="context-window-segment context-window-free" style={segmentStyle(segments.freePercent)} />
				<div className="context-window-cutoff" style={cutoffStyle}>
					<span>next compaction</span>
				</div>
			</div>
			<div className="context-window-legend">
				<span><i className="context-window-key initial" /> initial {formatTokenCount(breakdown.initialTokens)}</span>
				<span><i className="context-window-key ongoing" /> since then {formatTokenCount(breakdown.ongoingTokens)}</span>
				<span><i className="context-window-key free" /> free {formatTokenCount(breakdown.freeTokens)}</span>
			</div>
			<div className="context-window-foot">
				Last inference <TimeAgoLabel value={breakdown.usedAt} />; baseline <TimeAgoLabel value={breakdown.baselineUsedAt} />
			</div>
		</div>
	);
}

export function TokenUsageChart({ usage }: { usage: BotTokenUsageStats }) {
	const width = 760;
	const height = 210;
	const padding = { top: 18, right: 18, bottom: 34, left: 58 };
	const plotWidth = width - padding.left - padding.right;
	const plotHeight = height - padding.top - padding.bottom;
	const peakTokens = Math.max(
		1,
		usage.dailyAverageTokens,
		...usage.buckets.map((bucket) => bucket.totalTokens),
	);
	const scaleMaxTokens = Math.ceil(peakTokens * 1.12);
	const windowStart = Date.parse(usage.windowStart);
	const windowEnd = Date.parse(usage.windowEnd);
	const xForTime = (value: string): number => {
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed) || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
			return padding.left;
		}
		return padding.left + ((parsed - windowStart) / (windowEnd - windowStart)) * plotWidth;
	};
	const yForTokens = (tokens: number): number => padding.top + plotHeight - (Math.max(0, tokens) / scaleMaxTokens) * plotHeight;
	const bucketWidth = plotWidth / Math.max(1, usage.buckets.length);
	const chartPoints: TokenUsageChartPoint[] = [
		{ timeMs: windowStart, x: padding.left, totalTokens: 0, cachedTokens: 0 },
		...usage.buckets.map((bucket) => ({
			timeMs: Date.parse(bucket.bucketEnd),
			x: xForTime(bucket.bucketEnd),
			totalTokens: bucket.totalTokens,
			cachedTokens: Math.min(bucket.cachedTokens, bucket.totalTokens),
		})),
	];
	const totalPoints = chartPoints.map((point) => `${point.x},${yForTokens(point.totalTokens)}`).join(" ");
	const cachedPoints = chartPoints.map((point) => `${point.x},${yForTokens(point.cachedTokens)}`).join(" ");
	const cachedArea = areaToBaselinePath(chartPoints, (point) => yForTokens(point.cachedTokens), yForTokens(0));
	const remainderArea = areaBetweenPaths(
		chartPoints,
		(point) => yForTokens(point.totalTokens),
		(point) => yForTokens(point.cachedTokens),
	);
	const averageY = yForTokens(usage.dailyAverageTokens);

	return (
		<div className="token-chart-wrap">
			<svg aria-label="Seven day token usage" className="token-chart" role="img" viewBox={`0 0 ${width} ${height}`}>
				{cachedArea && <path className="token-cached-area" d={cachedArea} />}
				{remainderArea && <path className="token-remainder-area" d={remainderArea} />}
				<line className="token-axis" x1={padding.left} x2={padding.left + plotWidth} y1={padding.top + plotHeight} y2={padding.top + plotHeight} />
				<line className="token-axis" x1={padding.left} x2={padding.left} y1={padding.top} y2={padding.top + plotHeight} />
				<line className="token-average-line" x1={padding.left} x2={padding.left + plotWidth} y1={averageY} y2={averageY}>
					<title>{`Average: ${formatTokenUsageTotals(averageTokenUsageTotals(usage))}/day across ${formatAverageDays(usage.dailyAverageDays)}`}</title>
				</line>
				<text className="token-average-label" x={padding.left + plotWidth - 4} y={Math.max(12, averageY - 6)}>
					avg
				</text>
				{usage.buckets.map((bucket) => {
					const x = xForTime(bucket.bucketStart);
					return (
						<g key={bucket.bucketStart}>
							<rect
								className="token-day-hitbox"
								height={plotHeight}
								width={bucketWidth}
								x={x}
								y={padding.top}
							>
								<title>{`${formatFullDate(bucket.bucketStart)}: ${formatTokenUsageTotals(bucket)}`}</title>
							</rect>
							<text className="token-x-label" x={x + bucketWidth / 2} y={height - 10}>
								<title>{formatFullDate(bucket.bucketStart)}</title>
								{formatShortDate(bucket.bucketStart)}
							</text>
						</g>
					);
				})}
				{cachedPoints && <polyline className="token-cached-line" points={cachedPoints} />}
				{totalPoints && <polyline className="token-line" points={totalPoints} />}
				<text className="token-y-label" x={padding.left - 8} y={padding.top + 4}>
					{formatTokenCount(scaleMaxTokens)}
				</text>
				<text className="token-y-label" x={padding.left - 8} y={padding.top + plotHeight}>
					0
				</text>
				{usage.changeMarkers.map((marker, index) => {
					const markerTimeMs = Date.parse(marker.usedAt);
					// Markers have request timestamps, while the line is daily buckets; use the rendered polyline's value at that time.
					const markerLineTokens = interpolateTokenUsageChartValue(chartPoints, markerTimeMs, "totalTokens");
					const y = yForTokens(markerLineTokens ?? marker.totalTokens);
					const previous =
						marker.previousModel || marker.previousContextWindowTokens !== undefined ?
							`Previous: ${marker.previousModel ?? marker.model}, ${formatTokenCount(marker.previousContextWindowTokens ?? marker.contextWindowTokens)} context`
						:	"First tracked request";
					return (
						<circle
							className="token-change-marker"
							cx={xForTime(marker.usedAt)}
							cy={y}
							key={`${marker.usedAt}-${marker.model}-${index}`}
							r="5.5"
						>
							<title>{`${formatFullDate(marker.usedAt)}\n${marker.model}\nUsage: ${formatTokenUsageTotals(marker)}\nContext: ${formatTokenCount(marker.contextWindowTokens)} tokens\n${previous}`}</title>
						</circle>
					);
				})}
			</svg>
		</div>
	);
}

export type TokenUsageDisplayTotals = Pick<BotTokenUsageTotals, "cachedTokens" | "cost" | "totalTokens">;

export function formatTokenUsageTotals(totals: TokenUsageDisplayTotals | undefined): string {
	if (!totals) {
		return "0";
	}
	const cached = totals.cachedTokens > 0 ? ` (${formatTokenCount(totals.cachedTokens)} cached)` : "";
	const cost = totals.cost !== null ? ` · ${formatTokenCost(totals.cost)}` : "";
	return `${formatTokenCount(totals.totalTokens)}${cached}${cost}`;
}

export function averageTokenUsageTotals(usage: BotTokenUsageStats): TokenUsageDisplayTotals {
	const days = usage.dailyAverageDays > 0 ? usage.dailyAverageDays : 1;
	return {
		totalTokens: usage.dailyAverageTokens,
		cachedTokens: Math.round(usage.last7Days.cachedTokens / days),
		cost: usage.last7Days.cost === null ? null : usage.last7Days.cost / days,
	};
}

export function formatTokenCount(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	const rounded = Math.max(0, Math.round(value));
	if (rounded >= 1_000_000) {
		return `${(rounded / 1_000_000).toFixed(rounded >= 10_000_000 ? 0 : 1)}M`;
	}
	if (rounded >= 10_000) {
		return `${Math.round(rounded / 1_000)}k`;
	}
	return rounded.toLocaleString();
}

export function formatByteCount(value: number): string {
	if (!Number.isFinite(value)) {
		return "0 B";
	}
	const bytes = Math.max(0, Math.round(value));
	if (bytes >= 1_000_000) {
		return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
	}
	if (bytes >= 1_000) {
		return `${(bytes / 1_000).toFixed(bytes >= 10_000 ? 0 : 1)} KB`;
	}
	return `${bytes} B`;
}

export function formatExactTokenCount(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	return Math.max(0, Math.round(value)).toLocaleString();
}

export function formatTokenCost(value: number): string {
	if (!Number.isFinite(value)) {
		return "$0.00";
	}
	const fractionDigits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
	return formatTokenCostFixed(value, fractionDigits);
}

export function formatTokenCostFixed(value: number, fractionDigits: number): string {
	return new Intl.NumberFormat(undefined, {
		currency: "USD",
		maximumFractionDigits: Math.max(0, fractionDigits),
		minimumFractionDigits: Math.max(0, fractionDigits),
		style: "currency",
	}).format(value);
}

export function tokenUsageModelCostFractionDigits(values: readonly (number | null)[]): number {
	return Math.max(2, ...values.map((value) => {
		if (value === null || !Number.isFinite(value)) {
			return 2;
		}
		return Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
	}));
}

export function globalInferenceCostFractionDigits(values: readonly (number | null)[]): number {
	return Math.max(2, ...values.map((value) => {
		if (value === null || !Number.isFinite(value)) {
			return 2;
		}
		const absoluteValue = Math.abs(value);
		if (absoluteValue > 0 && absoluteValue < 0.01) {
			return 4;
		}
		return absoluteValue > 0 && absoluteValue < 1 ? 3 : 2;
	}));
}

export function formatTokenCostParts(value: number | null, fractionDigits: number): ReactNode {
	if (value === null) {
		return "-";
	}
	const formatted = formatTokenCostFixed(value, fractionDigits);
	const decimal = formatted.lastIndexOf(".");
	if (decimal < 0) {
		return formatted;
	}
	let padStart = formatted.length;
	while (padStart > decimal + 1 && formatted[padStart - 1] === "0") {
		padStart -= 1;
	}
	if (padStart === formatted.length) {
		return formatted;
	}
	return (
		<>
			{formatted.slice(0, padStart)}
			<span className="token-cost-pad">{formatted.slice(padStart)}</span>
		</>
	);
}

export function formatPerMillionTokenCost(value: number | null, fractionDigits: number): ReactNode {
	if (value === null) {
		return "-";
	}
	return (
		<>
			{formatTokenCostParts(value, fractionDigits)}
			<span className="per-million-unit">/mtok</span>
		</>
	);
}

export function formatNullableUsageCost(value: number | null): string {
	return value === null ? "$?" : formatTokenCost(value);
}

export function areaToBaselinePath<T extends { x: number }>(
	points: T[],
	yForPoint: (point: T) => number,
	baselineY: number,
): string {
	if (points.length === 0) {
		return "";
	}
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last) {
		return "";
	}
	const top = points.map((point) => `L ${point.x} ${yForPoint(point)}`).join(" ");
	return `M ${first.x} ${baselineY} ${top} L ${last.x} ${baselineY} Z`;
}

export function areaBetweenPaths<T extends { x: number }>(
	points: T[],
	yForUpperPoint: (point: T) => number,
	yForLowerPoint: (point: T) => number,
): string {
	if (points.length === 0) {
		return "";
	}
	const first = points[0];
	if (!first) {
		return "";
	}
	const upper = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${yForUpperPoint(point)}`);
	const lower = [...points].reverse().map((point) => `L ${point.x} ${yForLowerPoint(point)}`);
	return [...upper, ...lower, "Z"].join(" ");
}

export function formatAverageDays(value: number): string {
	if (!Number.isFinite(value) || value <= 0) {
		return "0 days";
	}
	if (value < 1.05) {
		return "1 day";
	}
	if (value >= 6.95) {
		return "7 days";
	}
	return `${value.toFixed(1).replace(/\.0$/, "")} days`;
}
