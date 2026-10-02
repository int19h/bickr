import { RepositoryError } from '@bickr/shared/repository';
import type { InjectionRow } from '../types';

export type PendingInjection = Pick<InjectionRow, 'id' | 'text'>;

/** Pending input remains in the existing injections table until history commits.
 * Existing injection retention also owns consumed rows; this adds no store. */
export class RuntimeInjectionStore {
	private readonly storage: Pick<DurableObjectStorage, 'sql'>;
	constructor(storage: Pick<DurableObjectStorage, 'sql'>) { this.storage = storage; }

	pending(injectionIds?: readonly string[]): PendingInjection[] {
		if (injectionIds) {
			return [...new Set(injectionIds)].flatMap(id => this.storage.sql.exec<PendingInjection>(
				'SELECT id, text FROM injections WHERE consumed_at IS NULL AND id = ?', id,
			).toArray());
		}
		return this.storage.sql.exec<PendingInjection>(
			`SELECT id, text FROM injections WHERE consumed_at IS NULL AND kind != 'spotlight' ORDER BY created_at ASC, id ASC LIMIT 10`,
		).toArray();
	}

	/** Call only inside the transaction that publishes these inputs to history. */
	acknowledge(injections: readonly PendingInjection[], now = new Date().toISOString()): void {
		for (const injection of injections) {
			this.storage.sql.exec('UPDATE injections SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', now, injection.id);
			if (this.storage.sql.exec<{ count: number }>('SELECT changes() AS count').one().count !== 1) {
				throw new RepositoryError('conflict', 'Pending input changed before the visit could receive it.', 409);
			}
		}
	}
}
