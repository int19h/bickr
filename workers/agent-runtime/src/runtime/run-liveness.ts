import type { BotRuntimeEventType } from '@bickr/shared/model';
import type { RuntimeRunTrigger } from '../types';
import { RuntimeOperationTimeoutError, TickStoppedError } from '../errors';
import { withAbortableTimeout } from '../provider/sse';

export const runInactivityMs = 5 * 60_000;
export const cleanupTimeoutMs = 15_000;
export const finalizationRetryMs = 30_000;
export const transitionTimeoutMs = 60_000;

export function boundedCleanup<T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	// Cleanup has its own deadline: a stopped run's already-aborted signal must
	// not prevent release or reporting. D1 cannot cancel an accepted write.
	return withAbortableTimeout(new AbortController().signal, cleanupTimeoutMs,
		() => new RuntimeOperationTimeoutError(operation, cleanupTimeoutMs), run);
}

/** Settle the caller on cancellation even when an external binding ignores it.
 * The underlying promise stays observed; publication fences reject its late work. */
export async function untilRunStopped<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
	if (signal.aborted) throw new TickStoppedError();
	let abort!: () => void;
	const stopped = new Promise<never>((_, reject) => {
		abort = () => reject(new TickStoppedError());
		signal.addEventListener('abort', abort, { once: true });
	});
	try { return await Promise.race([run(), stopped]); }
	finally { signal.removeEventListener('abort', abort); }
}

type RunIdentity = { botId: string; runId: string; trigger: RuntimeRunTrigger; intervalMs: number; claimToken: string | null };
export type RunJournal = RunIdentity & (
	| { kind: 'active'; lastProgressAt: number }
	| { kind: 'finalizing'; terminalType: 'tick_completed' | 'tick_failed' | 'tick_stopped'; status: 'idle' | 'failed'; message: string | null; nextDueAt: string | null; finishedAt: string }
);

/** One coordination row per object, retained only through its active run and
 * outstanding CAS release. Deleted after confirmed release/supersession; retries
 * overwrite it, so an unavailable D1 never produces an append-only backlog. */
const journalKey = 'run_liveness_v1';
export class RunLiveness {
	private readonly storage: Pick<DurableObjectStorage, 'sql' | 'setAlarm'>;
	private streamProgress: { runId: string; at: number } | null = null;
	private streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
	constructor(storage: Pick<DurableObjectStorage, 'sql' | 'setAlarm'>) { this.storage = storage; }

	read(): RunJournal | null {
		const row = this.storage.sql.exec<{ value_json: string }>(
			'SELECT value_json FROM runtime_state WHERE key = ?', journalKey,
		).toArray()[0];
		return row ? JSON.parse(row.value_json) as RunJournal : null;
	}

	write(journal: RunJournal): void {
		this.storage.sql.exec('INSERT INTO runtime_state (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
			journalKey, JSON.stringify(journal));
	}

	async begin(identity: RunIdentity, now = Date.now()): Promise<void> {
		this.write({ ...identity, kind: 'active', lastProgressAt: now });
		// Arm before any external claim or run work. A crash after the claim is
		// therefore recoverable even if tick_started was never appended.
		await this.storage.setAlarm(now + runInactivityMs);
	}

	progress(runId: string, now = Date.now()): void {
		const current = this.read();
		if (current?.kind !== 'active' || current.runId !== runId) return;
		this.write({ ...current, lastProgressAt: Math.max(now, current.lastProgressAt) });
		// Keep the earlier alarm. It reads the exact last progress time and moves
		// itself forward if necessary; no asynchronous per-token alarm writes race.
	}

	stream(runId: string, now = Date.now()): void {
		const current = this.read();
		if (current?.kind !== 'active' || current.runId !== runId) return;
		this.streamProgress = { runId, at: now };
		if (now - current.lastProgressAt >= 1000) this.flushStream();
		else if (this.streamFlushTimer === undefined) {
			this.streamFlushTimer = setTimeout(() => this.flushStream(), 1000);
		}
	}

	flushStream(): void {
		if (this.streamFlushTimer !== undefined) clearTimeout(this.streamFlushTimer);
		this.streamFlushTimer = undefined;
		const progress = this.streamProgress;
		this.streamProgress = null;
		if (progress) this.progress(progress.runId, progress.at);
	}

	finish(runId: string, status: 'idle' | 'failed', message: string | null, terminalType: 'tick_completed' | 'tick_failed' | 'tick_stopped', now = Date.now()): RunJournal | null {
		const current = this.read();
		if (!current || current.runId !== runId) return null;
		if (current.kind === 'finalizing') return current;
		const finishedAt = new Date(now).toISOString();
		const nextDueAt = current.trigger === 'spotlight' ? null : new Date(now + (status === 'failed' ? runInactivityMs : current.intervalMs)).toISOString();
		const journal: RunJournal = { ...current, kind: 'finalizing', terminalType, status, message, nextDueAt, finishedAt };
		this.write(journal);
		return journal;
	}

	clear(runId: string): void {
		this.storage.sql.exec(`DELETE FROM runtime_state WHERE key = ? AND json_extract(value_json, '$.runId') = ?`, journalKey, runId);
	}
}

const progressEvents: ReadonlySet<BotRuntimeEventType> = new Set([
	'tick_started', 'input', 'provider_request', 'provider_delta', 'reasoning_message',
	'assistant_message', 'tool_call', 'tool_result', 'compaction',
]);
export function isRunProgressEvent(type: BotRuntimeEventType): boolean {
	return progressEvents.has(type);
}
