import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import { InputError } from '@bickr/shared/validation';
import { loadRuntimeIndexChunk } from './runtime-storage-retention';
import type { Env } from '../types';
import { ProviderRequestError, ProviderCompactionRequestError, ProviderLoopRequestError } from '../errors';

export type LegacyHistoryCost = {
	providerCalls: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	usageMissingCalls: number;
};

export type LegacyHistoryCompactionResult = LegacyHistoryCost & { before: number; remaining: number } & (
	| { kind: 'unchanged' | 'compacted' }
	| { kind: 'deferred'; reason: 'busy' }
	| { kind: 'deferred'; reason: 'rate_limit'; retryAfterMs?: number }
	| { kind: 'failed'; errorKind: string; error?: import('@bickr/shared/model').AgentLogFailure }
);

type FleetResult =
	| { botId: string; kind: 'census'; legacyToolRows: number }
	| { botId: string; kind: 'compaction'; result: LegacyHistoryCompactionResult }
	| { botId: string; kind: 'failed'; errorKind: 'http_response' | 'dispatch_error' | 'invalid_response'; httpStatus?: number };

export type LegacyHistoryCursor = string | { retryBotId: string };

export function legacyHistoryCursor(value: unknown): LegacyHistoryCursor | undefined {
	if (value === undefined) return undefined;
	if (value && typeof value === 'object' && 'retryBotId' in value && typeof value.retryBotId === 'string' && value.retryBotId.length > 0 && value.retryBotId.length <= 256) return { retryBotId: value.retryBotId };
	if (typeof value !== 'string' || value.length > 256) throw new InputError('The history cursor must be a string or a retryBotId object with at most 256 characters.');
	return value || undefined;
}

// After a complete active-row census reaches zero, advance the view schema
// version and remove this module and the legacy-history maintenance routes.
// The operator keeps page evidence. This procedure stores no sweep records.
export async function legacyHistoryFleetPage(
	env: Pick<Env, 'BICKR_D1' | 'BOT_RUNTIME' | 'INTERNAL_SERVICE_SECRET'> & { BOT_RUNTIME: NonNullable<Env['BOT_RUNTIME']> },
	operation: 'census' | 'compact',
	cursor?: LegacyHistoryCursor,
	requestedLimit?: unknown,
) {
	const limit = operation === 'compact' ? legacyHistoryCompactionPageLimit(requestedLimit) : 25;
	const retryBotId = typeof cursor === 'object' ? cursor.retryBotId : undefined;
	const page = await loadRuntimeIndexChunk(env.BICKR_D1, retryBotId ?? (typeof cursor === 'string' ? cursor : undefined), limit, retryBotId !== undefined);
	let rateLimited: { botId: string; retryAfterMs?: number } | undefined;
	const results: FleetResult[] = [];
	// Await each runtime before dispatching the next one. Owners can share keys.
	for (const { botId } of page.items) {
		const headers = new Headers({ 'x-bickr-scheduler': '1' });
		addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
		try {
			const path = operation === 'census' ? 'status' : 'maintenance/legacy-history/compact';
			const response = await env.BOT_RUNTIME.get(env.BOT_RUNTIME.idFromName(botId)).fetch(new Request(
				internalServiceUrl(`/bots/${encodeURIComponent(botId)}/${path}`),
				{ method: operation === 'census' ? 'GET' : 'POST', headers },
			));
			if (!response.ok) {
				results.push({ botId, kind: 'failed', errorKind: 'http_response', httpStatus: response.status });
				continue;
			}
			const payload = await response.json() as { data?: { status?: { legacyToolRows?: number }; compaction?: unknown } };
			if (operation === 'census') {
				const count = payload.data?.status?.legacyToolRows;
				if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
					results.push({ botId, kind: 'failed', errorKind: 'invalid_response' });
				} else {
					results.push({ botId, kind: 'census', legacyToolRows: count });
				}
			} else {
				const result = compactionResultFromResponse(payload.data?.compaction);
				results.push(result ? { botId, kind: 'compaction', result } : { botId, kind: 'failed', errorKind: 'invalid_response' });
				if (result?.kind === 'deferred' && result.reason === 'rate_limit') {
					rateLimited = { botId, ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) };
					break;
				}
			}
		} catch {
			results.push({ botId, kind: 'failed', errorKind: 'dispatch_error' });
		}
	}
	return {
		results,
		legacyRuntimes: results.flatMap(result => result.kind === 'census' && result.legacyToolRows > 0
			? [{ botId: result.botId, legacyToolRows: result.legacyToolRows }] : []),
		done: !rateLimited && page.done,
		nextCursor: rateLimited ? { retryBotId: rateLimited.botId } : page.done ? null : page.nextCursor ?? null,
		stoppedForRateLimit: rateLimited !== undefined,
		...(operation === 'compact' ? { pauseMs: Math.max(60_000, rateLimited?.retryAfterMs ?? 0) } : {}),
		...(rateLimited?.retryAfterMs !== undefined ? { retryAfterMs: rateLimited.retryAfterMs } : {}),
	};
}

function compactionResultFromResponse(value: unknown): LegacyHistoryCompactionResult | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	const count = (key: string): number | null => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] >= 0 ? row[key] : null;
	const before = count('before'), remaining = count('remaining'), providerCalls = count('providerCalls');
	const promptTokens = count('promptTokens'), completionTokens = count('completionTokens'), totalTokens = count('totalTokens');
	const usageMissingCalls = count('usageMissingCalls');
	if (before === null || remaining === null || providerCalls === null || promptTokens === null ||
		completionTokens === null || totalTokens === null || usageMissingCalls === null) return null;
	const fields = { before, remaining, providerCalls, promptTokens, completionTokens, totalTokens, usageMissingCalls };
	switch (row.kind) {
		case 'unchanged': case 'compacted': return { kind: row.kind, ...fields };
		case 'deferred': {
			if (row.reason === 'busy') return { kind: 'deferred', reason: 'busy', ...fields };
			const retryAfterMs = row.retryAfterMs === undefined ? undefined : count('retryAfterMs');
			return row.reason === 'rate_limit' && retryAfterMs !== null
				? { kind: 'deferred', reason: 'rate_limit', ...fields, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } : null;
		}
		case 'failed': return typeof row.errorKind === 'string' ? { kind: 'failed', errorKind: row.errorKind, ...fields, ...(row.error ? { error: row.error as import('@bickr/shared/model').AgentLogFailure } : {}) } : null;
		default: return null;
	}
}

export function legacyHistoryCompactionPageLimit(value: unknown): number {
	if (value === undefined) return 5;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new InputError('The compaction page limit must be an integer from 1 through 5.');
	return value;
}

/** Preserve Retry-After at the compaction HTTP boundary without changing normal retry rules. */
export class LegacyHistoryRateLimitError extends ProviderRequestError {
	readonly retryAfterMs?: number;
	constructor(error: ProviderRequestError, retryAfterMs?: number) {
		super(error.status, '', '', error.body, {
			providerError: error.providerError, rawResponse: error.rawResponse, responseId: error.responseId,
			responseModel: error.responseModel, usage: error.usage,
		});
		this.retryAfterMs = retryAfterMs;
	}
}

export function legacyHistoryRateLimit(error: unknown): { retryAfterMs?: number } | null {
	if (error instanceof ProviderCompactionRequestError || error instanceof ProviderLoopRequestError) return legacyHistoryRateLimit(error.originalError);
	if (!(error instanceof ProviderRequestError)) return null;
	const errorType = error.providerError?.errorType;
	if (error.status !== 429 && error.providerError?.status !== 429 &&
		(errorType !== 'rate_limit_exceeded' && errorType !== 'rate_limit_error')) return null;
	return error instanceof LegacyHistoryRateLimitError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {};
}

/** Retry-After permits delay seconds or an HTTP date. Invalid values give no delay. */
export function legacyHistoryRetryDelay(headers: Headers, body: string, now = Date.now()): number | undefined {
	const header = headers.get('retry-after')?.trim();
	if (header) {
		const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : undefined;
		const delay = seconds !== undefined ? seconds * 1000 : /^[A-Za-z]{3},/.test(header) ? Date.parse(header) - now : NaN;
		if (Number.isFinite(delay) && Math.abs(delay) <= Number.MAX_SAFE_INTEGER) return Math.max(0, Math.ceil(delay));
	}
	// Some provider APIs return retry_after seconds in structured JSON instead.
	// Read these fields only at this boundary. Never inspect the message text.
	try {
		const payload = JSON.parse(body) as { retry_after?: unknown; error?: { retry_after?: unknown; metadata?: { retry_after?: unknown } } };
		const seconds = payload?.error?.metadata?.retry_after ?? payload?.error?.retry_after ?? payload?.retry_after;
		if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= Number.MAX_SAFE_INTEGER / 1000) return Math.ceil(seconds * 1000);
	} catch { /* A provider error body does not need to contain JSON. */ }
	return undefined;
}
