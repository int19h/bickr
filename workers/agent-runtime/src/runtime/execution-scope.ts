import { AsyncLocalStorage } from 'node:async_hooks';
import { TickStoppedError } from '../errors';

/** Async descendants retain their execution authority even after their caller
 * stops awaiting them. Authority is checked against the current journal, never
 * removable history. No retired-run tombstones or pending-promise registry. */
const execution = new AsyncLocalStorage<{ isCurrent: () => boolean }>();

export function withRunExecution<T>(isCurrent: () => boolean, operation: () => T): T {
	return execution.run({ isCurrent }, operation);
}

export function assertExecutionPublication(): void {
	const scope = execution.getStore();
	if (scope && !scope.isCurrent()) throw new TickStoppedError();
}

/** Finalization and historical adapters own their writes independently of the
 * live provider continuation. Use only for a synchronous settlement transaction. */
export function settleOutsideExecution<T>(operation: () => T): T {
	return execution.exit(operation);
}
