import { type BotTokenSpendSummary, type GlobalInferenceCostModelProviderRow, type GlobalInferenceCostPublicStats, type GlobalInferenceCostStats, type GlobalInferenceCostTotals } from "./model";
import { type D1DatabaseLike } from "./storage";

const dayMs = 24 * 60 * 60 * 1000;
const tokenSpendWindowDays = 7;
const globalInferenceCostStatsCacheKey = "global_inference_costs";
export const botInferenceUsageRetentionDays = 8;
export const globalInferenceCostStatsCacheMaxAgeMs = dayMs;
export const globalInferenceCostStatsWindowDays = tokenSpendWindowDays;

export type BotTokenSpendSummaryTarget = {
	botId: string;
	currentModel: string;
};

export type BotInferenceUsageRecord = {
	botId: string;
	ownerUserId: string;
	homeWorldId: string;
	homeWorldHandle: string;
	sourceUsageId: number;
	runId: string;
	requestSeq: number;
	createdAt: string;
	requestedModel: string;
	responseModel: string | null;
	model: string;
	contextWindowTokens: number;
	providerBaseUrl: string;
	providerName: string | null;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cost: number | null;
	exportedAt: string;
};

export type BotInferenceUsageSpendRow = {
	botId: string;
	createdAt: string;
	runId: string;
	requestedModel: string;
	cost: number | null;
};

type GlobalInferenceCostCacheRow = {
	payloadJson: string;
};

type GlobalInferenceCostAggregateRow = {
	model: string;
	providerName: string;
	requestCount: number;
	totalTokens: number;
	pricedRequestCount: number;
	pricedTokens: number;
	unpricedRequestCount: number;
	unpricedTokens: number;
	knownCost: number;
	firstUsedAt: string;
	lastUsedAt: string;
};

type SpendAccumulator = {
	requestCount: number;
	cost: number;
	unknownCost: boolean;
};

export async function recordBotInferenceUsageBatch(
	db: D1DatabaseLike,
	records: readonly BotInferenceUsageRecord[],
): Promise<void> {
	if (records.length === 0) {
		return;
	}
	for (let index = 0; index < records.length; index += 50) {
		const chunk = records.slice(index, index + 50);
		await db.batch(chunk.map((record) =>
			db
				.prepare(
					`INSERT INTO bot_inference_usage (
						bot_id, owner_user_id, home_world_id, home_world_handle, source_usage_id,
						run_id, request_seq, created_at, requested_model, response_model, model,
						context_window_tokens, provider_base_url, provider_name, prompt_tokens,
						completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost, exported_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(bot_id, run_id, request_seq) DO UPDATE SET
						owner_user_id = excluded.owner_user_id,
						home_world_id = excluded.home_world_id,
						home_world_handle = excluded.home_world_handle,
						source_usage_id = excluded.source_usage_id,
						created_at = excluded.created_at,
						requested_model = excluded.requested_model,
						response_model = excluded.response_model,
						model = excluded.model,
						context_window_tokens = excluded.context_window_tokens,
						provider_base_url = excluded.provider_base_url,
						provider_name = excluded.provider_name,
						prompt_tokens = excluded.prompt_tokens,
						completion_tokens = excluded.completion_tokens,
						total_tokens = excluded.total_tokens,
						cached_tokens = excluded.cached_tokens,
						reasoning_tokens = excluded.reasoning_tokens,
						cost = excluded.cost,
						exported_at = excluded.exported_at`,
				)
				.bind(
					record.botId,
					record.ownerUserId,
					record.homeWorldId,
					record.homeWorldHandle,
					record.sourceUsageId,
					record.runId,
					record.requestSeq,
					record.createdAt,
					record.requestedModel,
					record.responseModel,
					record.model,
					record.contextWindowTokens,
					record.providerBaseUrl,
					record.providerName,
					record.promptTokens,
					record.completionTokens,
					record.totalTokens,
					record.cachedTokens,
					record.reasoningTokens,
					record.cost,
					record.exportedAt,
				),
		));
	}
}

export async function pruneBotInferenceUsage(
	db: D1DatabaseLike,
	now = new Date(),
	retentionDays = botInferenceUsageRetentionDays,
): Promise<void> {
	const cutoff = new Date(now.getTime() - retentionDays * dayMs).toISOString();
	await db
		.prepare(`DELETE FROM bot_inference_usage WHERE created_at < ?`)
		.bind(cutoff)
		.run();
}

export async function cachedGlobalInferenceCostStats(db: D1DatabaseLike): Promise<GlobalInferenceCostStats | null> {
	const row = await db
		.prepare(
			`SELECT payload_json AS payloadJson
			 FROM global_inference_cost_stats_cache
			 WHERE cache_key = ?`,
		)
		.bind(globalInferenceCostStatsCacheKey)
		.first<GlobalInferenceCostCacheRow>();
	return row ? parseGlobalInferenceCostStats(row.payloadJson) : null;
}

export async function refreshGlobalInferenceCostStatsCacheIfStale(
	db: D1DatabaseLike,
	now = new Date(),
	maxAgeMs = globalInferenceCostStatsCacheMaxAgeMs,
): Promise<GlobalInferenceCostStats> {
	const cached = await cachedGlobalInferenceCostStats(db);
	if (cached) {
		const generatedAtMs = Date.parse(cached.generatedAt);
		const ageMs = now.getTime() - generatedAtMs;
		if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMs) {
			return cached;
		}
	}
	return recomputeGlobalInferenceCostStatsCache(db, now);
}

export function publicGlobalInferenceCostStats(stats: GlobalInferenceCostStats | null): GlobalInferenceCostPublicStats | null {
	if (!stats) {
		return null;
	}
	return {
		generatedAt: stats.generatedAt,
		windowStart: stats.windowStart,
		windowEnd: stats.windowEnd,
		windowDays: stats.windowDays,
		rows: stats.rows.flatMap((row) =>
			row.effectiveCostPerMillionTokens === null ? [] : [{
				model: row.model,
				providerName: row.providerName,
				effectiveCostPerMillionTokens: row.effectiveCostPerMillionTokens,
			}],
		),
	};
}

export async function recomputeGlobalInferenceCostStatsCache(
	db: D1DatabaseLike,
	now = new Date(),
): Promise<GlobalInferenceCostStats> {
	const stats = await globalInferenceCostStatsFromUsage(db, now);
	await db
		.prepare(
			`INSERT INTO global_inference_cost_stats_cache (
				cache_key, generated_at, window_start, window_end, window_days, payload_json
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(cache_key) DO UPDATE SET
				generated_at = excluded.generated_at,
				window_start = excluded.window_start,
				window_end = excluded.window_end,
				window_days = excluded.window_days,
				payload_json = excluded.payload_json`,
		)
		.bind(
			globalInferenceCostStatsCacheKey,
			stats.generatedAt,
			stats.windowStart,
			stats.windowEnd,
			stats.windowDays,
			JSON.stringify(stats),
		)
		.run();
	return stats;
}

export async function globalInferenceCostStatsFromUsage(
	db: D1DatabaseLike,
	now = new Date(),
): Promise<GlobalInferenceCostStats> {
	const windowEnd = now.toISOString();
	const windowStart = new Date(now.getTime() - globalInferenceCostStatsWindowDays * dayMs).toISOString();
	const result = await db
		.prepare(
			`WITH normalized AS (
				SELECT
					requested_model AS model,
					CASE
						WHEN TRIM(COALESCE(provider_name, '')) = '' THEN 'Unknown provider'
						ELSE TRIM(provider_name)
					END AS provider_name,
					created_at,
					total_tokens,
					cost
				FROM bot_inference_usage
				WHERE created_at >= ?
				  AND created_at <= ?
				  AND total_tokens > 0
			)
			SELECT
				model,
				provider_name AS providerName,
				COUNT(*) AS requestCount,
				COALESCE(SUM(total_tokens), 0) AS totalTokens,
				COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END), 0) AS pricedRequestCount,
				COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN total_tokens ELSE 0 END), 0) AS pricedTokens,
				COALESCE(SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END), 0) AS unpricedRequestCount,
				COALESCE(SUM(CASE WHEN cost IS NULL THEN total_tokens ELSE 0 END), 0) AS unpricedTokens,
				COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN cost ELSE 0 END), 0) AS knownCost,
				MIN(created_at) AS firstUsedAt,
				MAX(created_at) AS lastUsedAt
			 FROM normalized
			 GROUP BY model, provider_name`,
		)
		.bind(windowStart, windowEnd)
		.all<GlobalInferenceCostAggregateRow>();
	const rows = (result.results ?? []).map(globalInferenceCostRowFromAggregate).sort(compareGlobalInferenceCostRows);
	return {
		generatedAt: windowEnd,
		windowStart,
		windowEnd,
		windowDays: globalInferenceCostStatsWindowDays,
		totals: globalInferenceCostTotals(rows),
		rows,
	};
}

export async function listOwnerBotTokenSpendSummaries(
	db: D1DatabaseLike,
	ownerUserId: string,
	targets: readonly BotTokenSpendSummaryTarget[],
	now = new Date(),
): Promise<BotTokenSpendSummary[]> {
	const windowStart = new Date(now.getTime() - tokenSpendWindowDays * dayMs).toISOString();
	const result = await db
		.prepare(
			`SELECT
				bot_id AS botId,
				created_at AS createdAt,
				run_id AS runId,
				requested_model AS requestedModel,
				cost
			 FROM bot_inference_usage
			 WHERE owner_user_id = ?
			   AND created_at >= ?
			   AND created_at <= ?
			 ORDER BY bot_id ASC, created_at ASC, source_usage_id ASC`,
		)
		.bind(ownerUserId, windowStart, now.toISOString())
		.all<BotInferenceUsageSpendRow>();
	return botTokenSpendSummariesFromUsageRows(targets, result.results ?? [], now);
}

function botTokenSpendSummariesFromUsageRows(
	targets: readonly BotTokenSpendSummaryTarget[],
	rows: readonly BotInferenceUsageSpendRow[],
	now = new Date(),
): BotTokenSpendSummary[] {
	const targetsByBotId = new Map(targets.map((target) => [target.botId, target]));
	const rowsByBotId = new Map<string, BotInferenceUsageSpendRow[]>();
	for (const row of rows) {
		if (!targetsByBotId.has(row.botId)) {
			continue;
		}
		let botRows = rowsByBotId.get(row.botId);
		if (!botRows) {
			botRows = [];
			rowsByBotId.set(row.botId, botRows);
		}
		botRows.push(row);
	}
	return targets.map((target) =>
		botTokenSpendSummaryFromUsageRows(target.botId, target.currentModel, rowsByBotId.get(target.botId) ?? [], now),
	);
}

export function botTokenSpendSummaryFromUsageRows(
	botId: string,
	currentModel: string,
	rows: readonly BotInferenceUsageSpendRow[],
	now = new Date(),
): BotTokenSpendSummary {
	const windowEndMs = now.getTime();
	const windowStartMs = windowEndMs - tokenSpendWindowDays * dayMs;
	const last24StartMs = windowEndMs - dayMs;
	const windowEnd = now.toISOString();
	const sortedRows = [...rows].sort((left, right) =>
		timestampMsOrFallback(left.createdAt, 0) - timestampMsOrFallback(right.createdAt, 0) ||
		left.runId.localeCompare(right.runId),
	);
	const last24Hours = emptySpendAccumulator();

	for (const row of sortedRows) {
		const usedAt = Date.parse(row.createdAt);
		if (Number.isFinite(usedAt) && usedAt >= last24StartMs && usedAt <= windowEndMs) {
			addSpendRow(last24Hours, row);
		}
	}

	let currentPeriodRows: BotInferenceUsageSpendRow[] = [];
	let currentPeriodStartMs = windowEndMs;
	const latestRow = sortedRows[sortedRows.length - 1];
	if (latestRow?.requestedModel === currentModel) {
		let firstCurrentIndex = sortedRows.length - 1;
		while (firstCurrentIndex > 0 && sortedRows[firstCurrentIndex - 1]?.requestedModel === currentModel) {
			firstCurrentIndex -= 1;
		}
		currentPeriodRows = sortedRows.slice(firstCurrentIndex);
		currentPeriodStartMs =
			firstCurrentIndex > 0 ?
				Math.max(windowStartMs, timestampMsOrFallback(currentPeriodRows[0]?.createdAt, windowEndMs))
			:	windowStartMs;
	}

	const average = emptySpendAccumulator();
	for (const row of currentPeriodRows) {
		addSpendRow(average, row);
	}
	const noCurrentModelUsage = currentPeriodRows.length === 0;
	const dayCount = noCurrentModelUsage ? 0 : Math.max(1 / 24, (windowEndMs - currentPeriodStartMs) / dayMs);
	const averageCost = spendAccumulatorCost(average);

	return {
		botId,
		currentModel,
		generatedAt: windowEnd,
		last24Hours: {
			requestCount: last24Hours.requestCount,
			windowStart: new Date(last24StartMs).toISOString(),
			windowEnd,
			cost: spendAccumulatorCost(last24Hours),
			unknownCost: last24Hours.unknownCost,
		},
		average: {
			requestCount: average.requestCount,
			periodStart: new Date(currentPeriodStartMs).toISOString(),
			periodEnd: windowEnd,
			dayCount,
			costPerDay: noCurrentModelUsage ? 0 : averageCost === null ? null : averageCost / dayCount,
			unknownCost: average.unknownCost,
			noCurrentModelUsage,
		},
	};
}

function emptySpendAccumulator(): SpendAccumulator {
	return {
		requestCount: 0,
		cost: 0,
		unknownCost: false,
	};
}

function addSpendRow(total: SpendAccumulator, row: Pick<BotInferenceUsageSpendRow, "cost">): void {
	total.requestCount += 1;
	if (row.cost === null) {
		total.unknownCost = true;
	} else {
		total.cost += row.cost;
	}
}

function spendAccumulatorCost(total: SpendAccumulator): number | null {
	return total.unknownCost ? null : total.cost;
}

function globalInferenceCostRowFromAggregate(row: GlobalInferenceCostAggregateRow): GlobalInferenceCostModelProviderRow {
	const pricedTokens = Math.max(0, Math.round(numberValue(row.pricedTokens)));
	const knownCost = Math.max(0, numberValue(row.knownCost));
	return {
		model: stringValue(row.model) || "unknown/model",
		providerName: stringValue(row.providerName) || "Unknown provider",
		requestCount: Math.max(0, Math.round(numberValue(row.requestCount))),
		totalTokens: Math.max(0, Math.round(numberValue(row.totalTokens))),
		pricedRequestCount: Math.max(0, Math.round(numberValue(row.pricedRequestCount))),
		pricedTokens,
		unpricedRequestCount: Math.max(0, Math.round(numberValue(row.unpricedRequestCount))),
		unpricedTokens: Math.max(0, Math.round(numberValue(row.unpricedTokens))),
		knownCost,
		firstUsedAt: stringValue(row.firstUsedAt) || "",
		lastUsedAt: stringValue(row.lastUsedAt) || "",
		effectiveCostPerMillionTokens: pricedTokens > 0 ? (knownCost * 1_000_000) / pricedTokens : null,
	};
}

function globalInferenceCostTotals(rows: readonly GlobalInferenceCostModelProviderRow[]): GlobalInferenceCostTotals {
	return rows.reduce<GlobalInferenceCostTotals>(
		(total, row) => ({
			requestCount: total.requestCount + row.requestCount,
			totalTokens: total.totalTokens + row.totalTokens,
			pricedRequestCount: total.pricedRequestCount + row.pricedRequestCount,
			pricedTokens: total.pricedTokens + row.pricedTokens,
			unpricedRequestCount: total.unpricedRequestCount + row.unpricedRequestCount,
			unpricedTokens: total.unpricedTokens + row.unpricedTokens,
			knownCost: total.knownCost + row.knownCost,
		}),
		{
			requestCount: 0,
			totalTokens: 0,
			pricedRequestCount: 0,
			pricedTokens: 0,
			unpricedRequestCount: 0,
			unpricedTokens: 0,
			knownCost: 0,
		},
	);
}

function compareGlobalInferenceCostRows(left: GlobalInferenceCostModelProviderRow, right: GlobalInferenceCostModelProviderRow): number {
	const leftCost = left.effectiveCostPerMillionTokens;
	const rightCost = right.effectiveCostPerMillionTokens;
	if (leftCost !== null && rightCost !== null) {
		const cost = leftCost - rightCost;
		if (cost !== 0) {
			return cost;
		}
	} else if (leftCost !== null) {
		return -1;
	} else if (rightCost !== null) {
		return 1;
	}
	const pricedTokens = right.pricedTokens - left.pricedTokens;
	if (pricedTokens !== 0) {
		return pricedTokens;
	}
	const model = left.model.localeCompare(right.model);
	if (model !== 0) {
		return model;
	}
	return left.providerName.localeCompare(right.providerName);
}

function parseGlobalInferenceCostStats(value: string): GlobalInferenceCostStats | null {
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const record = parsed as Record<string, unknown>;
		const generatedAt = stringValue(record.generatedAt);
		const windowStart = stringValue(record.windowStart);
		const windowEnd = stringValue(record.windowEnd);
		const rows = Array.isArray(record.rows) ? record.rows.map(parsedGlobalInferenceCostRow).filter((row): row is GlobalInferenceCostModelProviderRow => Boolean(row)) : [];
		if (!generatedAt || !windowStart || !windowEnd) {
			return null;
		}
		return {
			generatedAt,
			windowStart,
			windowEnd,
			windowDays: Math.max(0, Math.round(numberValue(record.windowDays))),
			totals: globalInferenceCostTotals(rows),
			rows,
		};
	} catch {
		return null;
	}
}

function parsedGlobalInferenceCostRow(value: unknown): GlobalInferenceCostModelProviderRow | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const model = stringValue(record.model);
	const providerName = stringValue(record.providerName);
	const firstUsedAt = stringValue(record.firstUsedAt);
	const lastUsedAt = stringValue(record.lastUsedAt);
	if (!model || !providerName || !firstUsedAt || !lastUsedAt) {
		return null;
	}
	const pricedTokens = Math.max(0, Math.round(numberValue(record.pricedTokens)));
	const knownCost = Math.max(0, numberValue(record.knownCost));
	return {
		model,
		providerName,
		requestCount: Math.max(0, Math.round(numberValue(record.requestCount))),
		totalTokens: Math.max(0, Math.round(numberValue(record.totalTokens))),
		pricedRequestCount: Math.max(0, Math.round(numberValue(record.pricedRequestCount))),
		pricedTokens,
		unpricedRequestCount: Math.max(0, Math.round(numberValue(record.unpricedRequestCount))),
		unpricedTokens: Math.max(0, Math.round(numberValue(record.unpricedTokens))),
		knownCost,
		firstUsedAt,
		lastUsedAt,
		effectiveCostPerMillionTokens: pricedTokens > 0 ? (knownCost * 1_000_000) / pricedTokens : null,
	};
}

function numberValue(value: unknown): number {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : 0;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function timestampMsOrFallback(value: string | null | undefined, fallback: number): number {
	const parsed = Date.parse(value ?? "");
	return Number.isFinite(parsed) ? parsed : fallback;
}
