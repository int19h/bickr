import { instructionLocalizationSweepLimit } from '@bickr/shared/instruction-localization-migration';
import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import { RuntimeOperationTimeoutError } from '../errors';
import { withAbortableTimeout } from '../provider/sse';
import { runtimeMaintenanceDispatchTimeoutMs } from '../constants';
import type { Env } from '../types';

export type RuntimeLocalizationStatus = {
	kind: 'cleared' | 'empty' | 'migrated';
	schemaVersion: number;
	factoryPlanDone: boolean;
	legacyHistoryDone: boolean;
	legacyPendingTools: number;
};

/** The release script owns the cursor. This route creates no persistent sweep records. */
export async function sweepRuntimeLocalization(env: Pick<Env, 'BICKR_D1' | 'BOT_RUNTIME' | 'INTERNAL_SERVICE_SECRET'>, cursor = '') {
	const selected = await env.BICKR_D1.prepare(`SELECT bot_id AS id FROM bots_index WHERE bot_id > ? AND deleted_at IS NULL AND lifecycle_state = 'active' ORDER BY bot_id LIMIT ?`)
		.bind(cursor, instructionLocalizationSweepLimit).all<{ id: string }>();
	const rows = selected.results ?? [];
	const results = await Promise.all(rows.map(async ({ id }) => {
		try {
			const headers = new Headers({ 'x-bickr-scheduler': '1' });
			addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
			const status = await withAbortableTimeout(new AbortController().signal, runtimeMaintenanceDispatchTimeoutMs,
				() => new RuntimeOperationTimeoutError('Runtime localization sweep', runtimeMaintenanceDispatchTimeoutMs), async (signal) => {
					const response = await env.BOT_RUNTIME.get(env.BOT_RUNTIME.idFromName(id)).fetch(new Request(internalServiceUrl(`/bots/${encodeURIComponent(id)}/localization/status`), { headers, signal }));
					if (!response.ok) throw new Error(`Runtime localization status returned HTTP ${response.status}.`);
					const payload = await response.json() as { data: { localization: RuntimeLocalizationStatus } };
					return payload.data.localization;
				});
			return { id, kind: 'success' as const, status };
		} catch { return { id, kind: 'failed' as const }; }
	}));
	return { results, done: rows.length < instructionLocalizationSweepLimit, nextCursor: rows.at(-1)?.id ?? null };
}
