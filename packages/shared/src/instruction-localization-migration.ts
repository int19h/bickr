import { storedNotificationEvent, type NotificationDocument } from './model';
import { kvKeys, readJson, type D1DatabaseLike, type KVNamespaceLike } from './storage';

export const instructionLocalizationVersion = 1;
export const instructionLocalizationStateKey = 'instruction_localization_version';
export const instructionLocalizationSweepLimit = 25;

type BootstrapRow = { id: string; botId: string };
export type BootstrapLocalizationSweepResult = {
	nextCursor: string | null;
	done: boolean;
	results: Array<BootstrapRow & { kind: 'current' | 'composed' | 'deferred' | 'invalid' | 'failed' }>;
};

/** A bounded census for adapter retirement. Composed text and KV keys never change. */
export async function sweepBootstrapLocalization(kv: KVNamespaceLike, db: D1DatabaseLike, cursor = ''): Promise<BootstrapLocalizationSweepResult> {
	const selected = await db.prepare(`SELECT notification_id AS id, bot_id AS botId FROM notifications
		WHERE type = 'bootstrap' AND status = 'pending' AND notification_id > ? ORDER BY notification_id LIMIT ?`)
		.bind(cursor, instructionLocalizationSweepLimit).all<BootstrapRow>();
	const rows = selected.results ?? [];
	const results: BootstrapLocalizationSweepResult['results'] = [];
	for (const row of rows) {
		try {
			const document = await readJson<NotificationDocument>(kv, kvKeys.notification(row.botId, row.id));
			if (!document) { results.push({ ...row, kind: 'deferred' }); continue; }
			if (document.id !== row.id || document.botId !== row.botId || document.notificationType !== 'bootstrap') {
				results.push({ ...row, kind: 'invalid' }); continue;
			}
			const event = storedNotificationEvent(document.event);
			results.push({ ...row, kind: event?.kind === 'bootstrap' ? event.bootstrapVersion === 1 ? 'composed' : 'current' : 'invalid' });
		} catch { results.push({ ...row, kind: 'failed' }); }
	}
	return { results, done: rows.length < instructionLocalizationSweepLimit, nextCursor: rows.at(-1)?.id ?? null };
}
