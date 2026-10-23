import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import { InputError } from '@bickr/shared/validation';
import { loadRuntimeIndexChunk } from './runtime-storage-retention';
import type { Env } from '../types';

export type LegacyHistoryCost = {
	providerCalls: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	usageMissingCalls: number;
};

export type LegacyHistoryCompactionResult = LegacyHistoryCost & { before: number; remaining: number } & (
	| { kind: 'unchanged' | 'compacted' | 'deferred' }
	| { kind: 'failed'; errorKind: string }
);

type FleetResult =
	| { botId: string; kind: 'census'; legacyToolRows: number }
	| { botId: string; kind: 'compaction'; result: LegacyHistoryCompactionResult }
	| { botId: string; kind: 'failed'; errorKind: 'http_response' | 'dispatch_error' | 'invalid_response'; httpStatus?: number };

export function legacyHistoryCursor(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.length > 256) throw new InputError('The history cursor must be a string of at most 256 characters.');
	return value || undefined;
}

// After a complete active-row census reaches zero, advance the view schema
// version and remove this module and the legacy-history maintenance routes.
// The operator keeps page evidence. This procedure stores no sweep records.
export async function legacyHistoryFleetPage(
	env: Pick<Env, 'BICKR_D1' | 'BOT_RUNTIME' | 'INTERNAL_SERVICE_SECRET'> & { BOT_RUNTIME: NonNullable<Env['BOT_RUNTIME']> },
	operation: 'census' | 'compact',
	cursor?: string,
) {
	const page = await loadRuntimeIndexChunk(env.BICKR_D1, cursor, 25);
	const results: FleetResult[] = [];
	// Await each runtime so that one page cannot start 25 paid inferences at once.
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
			}
		} catch {
			results.push({ botId, kind: 'failed', errorKind: 'dispatch_error' });
		}
	}
	return {
		results,
		legacyRuntimes: results.flatMap(result => result.kind === 'census' && result.legacyToolRows > 0
			? [{ botId: result.botId, legacyToolRows: result.legacyToolRows }] : []),
		done: page.done,
		nextCursor: page.done ? null : page.nextCursor ?? null,
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
		case 'unchanged': case 'compacted': case 'deferred': return { kind: row.kind, ...fields };
		case 'failed': return typeof row.errorKind === 'string' ? { kind: 'failed', errorKind: row.errorKind, ...fields } : null;
		default: return null;
	}
}
