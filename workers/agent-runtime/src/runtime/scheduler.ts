import { readMaintenanceState } from '@bickr/shared/maintenance';
import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import { scheduledDispatchBudget, scheduledDispatchSelectLimit, scheduledDispatchTimeoutMs } from '../constants';
import { RuntimeOperationTimeoutError } from '../errors';
import { withAbortableTimeout } from '../provider/sse';
import type { Env } from '../types';

export async function dispatchDueBots(
	env: Env,
	scheduledTime: number,
	options: { batchSize?: number; maxDispatches?: number } = {},
): Promise<{ dispatched: number; budgetExhausted: boolean }> {
	if ((await readMaintenanceState(env.BICKR_D1)).enabled) {
		return { dispatched: 0, budgetExhausted: false };
	}
	const now = new Date(scheduledTime).toISOString();
	const batchSize = Math.max(1, Math.floor(options.batchSize ?? scheduledDispatchSelectLimit));
	const maxDispatches = Math.max(0, Math.floor(options.maxDispatches ?? scheduledDispatchBudget));
	let dispatched = 0;
	let after: { botId: string; nextDueAt: string } | undefined;
	while (dispatched < maxDispatches) {
		const limit = Math.min(batchSize, maxDispatches - dispatched);
		const result = await env.BICKR_D1.prepare(
			`SELECT runtime.bot_id AS botId, runtime.next_due_at AS nextDueAt
			 FROM bot_runtime_index runtime
			 JOIN bots_index bots
			   ON bots.bot_id = runtime.bot_id
			  AND bots.deleted_at IS NULL
			  AND bots.lifecycle_state = 'active'
			 WHERE runtime.enabled = 1
			   AND runtime.next_due_at IS NOT NULL
			   AND runtime.next_due_at <= ?
			   AND (runtime.lease_expires_at IS NULL OR runtime.lease_expires_at <= ?)
			 ${after ? 'AND (runtime.next_due_at > ? OR (runtime.next_due_at = ? AND runtime.bot_id > ?))' : ''}
			 ORDER BY runtime.next_due_at ASC, runtime.bot_id ASC
			 LIMIT ?`,
		)
			.bind(now, now, ...(after ? [after.nextDueAt, after.nextDueAt, after.botId] : []), limit)
			.all<{ botId: string; nextDueAt: string }>();
		const rows = result.results ?? [];
		if (rows.length === 0) {
			break;
		}
		// Advance using the selected key, before dispatch can change the row.
		// Refused and failed visits keep their old due date. A keyset cursor makes
		// each such row consume at most one attempt in this sweep.
		after = rows.at(-1)!;
		// #17's D1 CAS admission is authoritative. If another scheduler or a
		// stale page double-dispatches a bot, the BotRuntime DO rejects it safely.
		await Promise.all(
			rows.map(async (row) => {
				const id = env.BOT_RUNTIME.idFromName(row.botId);
				const parentSignal = new AbortController().signal;
				try {
					const headers = new Headers({
						'content-type': 'application/json',
						'x-bickr-scheduler': '1',
					});
					addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
					const response = await withAbortableTimeout(
						parentSignal,
						scheduledDispatchTimeoutMs,
						() => new RuntimeOperationTimeoutError('Scheduled Bickr visit dispatch', scheduledDispatchTimeoutMs),
						(signal) =>
							env.BOT_RUNTIME.get(id).fetch(
								new Request(internalServiceUrl(`/bots/${encodeURIComponent(row.botId)}/tick`), {
									method: 'POST',
									signal,
									headers,
									body: JSON.stringify({ background: true }),
								}),
							),
					);
					if (!response.ok) console.warn('scheduled bot tick dispatch refused', row.botId, response.status);
					void response.body?.cancel();
				} catch (error) {
					console.warn('scheduled bot tick dispatch failed', row.botId, error);
				}
			}),
		);
		dispatched += rows.length;
		if (rows.length < limit) {
			break;
		}
	}
	return { dispatched, budgetExhausted: maxDispatches > 0 && dispatched >= maxDispatches };
}
