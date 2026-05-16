import { type BotTokenSpendSummary } from "./model";
import { type D1DatabaseLike } from "./storage";

const dayMs = 24 * 60 * 60 * 1000;
const tokenSpendWindowDays = 7;
export const botInferenceUsageRetentionDays = 8;

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

export function botTokenSpendSummariesFromUsageRows(
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

function timestampMsOrFallback(value: string | null | undefined, fallback: number): number {
	const parsed = Date.parse(value ?? "");
	return Number.isFinite(parsed) ? parsed : fallback;
}
