import { acknowledgeFollowerActivity, type FollowerActivityReceipt, type FollowerActivitySelection, type NotificationDeliveryCandidate } from '@bickr/shared/follower-activity';
import type { D1DatabaseLike } from '@bickr/shared/storage';
import type { RuntimeStorage } from './message-store';

// One journal, capped at 20 relationship receipts, retained until D1 settles.
// The separate rotation key survives acknowledgement and compaction. Both keys
// disappear on owner history erase or deleted-participant storage clear.
const journalKey = 'follower_activity_receipts_v1';
const scanKey = 'follower_activity_scan_after_v1';
export class RuntimeFollowerActivityDelivery {
	private readonly storage: Pick<RuntimeStorage, 'sql'>;
	constructor(storage: Pick<RuntimeStorage, 'sql'>) { this.storage = storage; }
	private value(key: string): string | undefined {
		return this.storage.sql.exec<{ value_json: string }>('SELECT value_json FROM runtime_state WHERE key = ?', key).toArray()[0]?.value_json;
	}
	after(): string { const value = this.value(scanKey); return value === undefined ? '' : JSON.parse(value) as string; }
	hasPending(): boolean { return this.value(journalKey) !== undefined; }
	/** Call inside the same transaction that saves the actual input messages. */
	commit(selection: FollowerActivitySelection, candidates: readonly NotificationDeliveryCandidate[], included: ReadonlySet<string>): void {
		if (this.hasPending()) throw new Error('A saved follower activity receipt must settle before another selection commits.');
		const receipts = [
			...selection.silentReceipts,
			...candidates.flatMap(candidate => candidate.kind === 'follower_activity' && included.has(candidate.document.id) ? [candidate.receipt] : []),
		];
		if (receipts.length > 20) throw new RangeError('Too many follower activity receipts for one input.');
		this.storage.sql.exec(`INSERT INTO runtime_state (key, value_json) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, scanKey, JSON.stringify(selection.nextAfter));
		if (receipts.length) this.storage.sql.exec('INSERT INTO runtime_state (key, value_json) VALUES (?, ?)', journalKey, JSON.stringify(receipts));
	}
	/** A D1 exception preserves the exact journal. Zero affected rows settle it. */
	async acknowledge(db: D1DatabaseLike): Promise<void> {
		const saved = this.value(journalKey);
		if (saved === undefined) return;
		const receipts = JSON.parse(saved) as FollowerActivityReceipt[];
		await acknowledgeFollowerActivity(db, receipts);
		// Input and D1 use different stores. A delayed retry must not clear a new
		// journal that another admitted operation saved across the await.
		this.storage.sql.exec('DELETE FROM runtime_state WHERE key = ? AND value_json = ?', journalKey, saved);
	}
}
