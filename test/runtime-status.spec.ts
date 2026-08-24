import { describe, expect, it } from "vitest";
import { BotRuntime } from "../workers/agent-runtime/src/index";
import { renewRuntimeRunLease } from "../workers/agent-runtime/src/runtime/bot-runtime";
import type { RuntimeRunTrigger } from "../workers/agent-runtime/src/types";
import {
	authCookie,
	createBotForTest,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";

// The participant's own schedule, already due: a reap that preserves it leaves
// this value exactly where it found it, and one that reschedules cannot produce
// a date in the past.
const standingDueAt = "2020-01-01T00:00:00.000Z";

type FailureEvent = {
	runId: string;
	payload: Record<string, unknown>;
};

type TestRuntime = {
	fetch(request: Request): Promise<Response>;
	reapStaleRun(botId: string): Promise<boolean>;
	recoverStaleRun(botId: string): Promise<{ kind: string; botId: string; runId?: string | null }>;
};

type RuntimeScheduleRow = {
	status: string;
	activeRunTrigger: string | null;
	nextDueAt: string | null;
};

describe("BotRuntime status", () => {
	it("renews only the current run's progress lease across an aggregate visit longer than 15 minutes", async () => {
		const runId = "run-progress-renewal";
		const botId = await seedExpiredRun("progress-renewal", runId);
		for (const now of ["2026-08-23T00:14:00.000Z", "2026-08-23T00:28:00.000Z", "2026-08-23T00:42:00.000Z"]) {
			await expect(renewRuntimeRunLease(testEnv.BICKR_D1, {
				botId,
				runId,
				now,
				leaseExpiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
			})).resolves.toBe(true);
		}
		const lease = await testEnv.BICKR_D1.prepare(
			`SELECT lease_expires_at AS leaseExpiresAt FROM bot_runtime_index WHERE bot_id = ?`,
		).bind(botId).first<{ leaseExpiresAt: string }>();
		expect(lease?.leaseExpiresAt).toBe("2026-08-23T00:57:00.000Z");
	});

	it("loses lease renewal safely after another run owns the row", async () => {
		const botId = await seedExpiredRun("renewal-cas-loss", "run-old");
		await testEnv.BICKR_D1.prepare(
			`UPDATE bot_runtime_index SET active_run_id = ?, lease_expires_at = ? WHERE bot_id = ?`,
		).bind("run-new", "2099-01-01T00:00:00.000Z", botId).run();

		await expect(renewRuntimeRunLease(testEnv.BICKR_D1, {
			botId,
			runId: "run-old",
			now: "2026-08-23T00:00:00.000Z",
			leaseExpiresAt: "2026-08-23T00:15:00.000Z",
		})).resolves.toBe(false);
		await expect(runtimeIndexState(botId)).resolves.toMatchObject({ status: "running", activeRunId: "run-new" });
	});

	it("keeps GET /status side-effect-free for an expired run", async () => {
		const botId = await seedExpiredRun("status-read", "run-status-read");
		const counted = d1WithWriteCount(testEnv.BICKR_D1);
		const harness = runtimeHarness(counted.db);

		const response = await harness.runtime.fetch(
			new Request(`https://internal.bickr/bots/${botId}/status`, {
				headers: { "x-bickr-scheduler": "1" },
			}),
		);

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				status: {
					botId,
					status: "running",
					activeRunId: "run-status-read",
				},
			},
		});
		expect(harness.failureEvents).toEqual([]);
		expect(counted.writeCount()).toBe(0);
		await expect(runtimeIndexState(botId)).resolves.toMatchObject({
			status: "running",
			activeRunId: "run-status-read",
		});
	});

	it("allows exactly one of two racing stale-run reaps to record failure", async () => {
		const runId = "run-double-reap";
		const botId = await seedExpiredRun("double-reap", runId);
		const harness = runtimeHarness(testEnv.BICKR_D1);

		const results = await Promise.all([
			harness.runtime.reapStaleRun(botId),
			harness.runtime.reapStaleRun(botId),
		]);

		expect(results.sort()).toEqual([false, true]);
		expect(harness.failureEvents).toHaveLength(1);
		expect(harness.failureEvents[0]).toMatchObject({
			runId,
			payload: { message: "This Bickr visit took too long and closed before completion." },
		});
		await expect(runtimeIndexState(botId)).resolves.toMatchObject({
			status: "idle",
			activeRunId: null,
			lastError: "This Bickr visit took too long and closed before completion.",
		});
	});

	it("recovers a null lease instead of leaving invalid running state immortal", async () => {
		const botId = await seedRunningRun("null-lease-recovery", "run-null-lease", {
			leaseExpiresAt: null,
			trigger: "manual",
		});
		const harness = runtimeHarness(testEnv.BICKR_D1);

		await expect(harness.runtime.recoverStaleRun(botId)).resolves.toEqual({
			kind: "reaped", botId, runId: "run-null-lease",
		});
		await expect(runtimeIndexState(botId)).resolves.toMatchObject({ status: "idle", activeRunId: null });
	});

	it("releases cleared storage without recreating local history", async () => {
		const botId = await seedExpiredRun("cleared-storage-recovery", "run-cleared-storage");
		const harness = runtimeHarness(testEnv.BICKR_D1, { storageCleared: true });

		await expect(harness.runtime.recoverStaleRun(botId)).resolves.toEqual({
			kind: "released_storage_cleared", botId, runId: "run-cleared-storage",
		});
		expect(harness.failureEvents).toEqual([]);
		await expect(runtimeIndexState(botId)).resolves.toMatchObject({ status: "idle", activeRunId: null });
	});
});

// Both reaping branches end a run the participant's own rhythm did not start,
// so both have to read the trigger off the row rather than reschedule blindly:
// a spotlight visit that overran its lease or was stopped must leave the next
// organic visit alone.
describe("BotRuntime stale-run reaper scheduling", () => {
	it("keeps a spotlight visit's standing schedule when its lease expires", async () => {
		const botId = await seedExpiredRun("reap-lease-spotlight", "run-lease-spotlight", "spotlight");
		const harness = runtimeHarness(testEnv.BICKR_D1);

		await expect(harness.runtime.reapStaleRun(botId)).resolves.toBe(true);

		await expect(runtimeSchedule(botId)).resolves.toEqual({
			status: "idle",
			activeRunTrigger: null,
			nextDueAt: standingDueAt,
		});
	});

	it("reschedules an ordinary visit whose lease expires", async () => {
		const botId = await seedExpiredRun("reap-lease-cron", "run-lease-cron", "cron");
		const harness = runtimeHarness(testEnv.BICKR_D1);

		await expect(harness.runtime.reapStaleRun(botId)).resolves.toBe(true);

		const row = await runtimeSchedule(botId);
		expect(row).toMatchObject({ status: "idle", activeRunTrigger: null });
		expect(Date.parse(row.nextDueAt!)).toBeGreaterThan(Date.now());
	});

	it("keeps a spotlight visit's standing schedule when a stop request is reaped", async () => {
		const botId = await seedRunningRun("reap-stop-spotlight", "run-stop-spotlight", {
			// Live, so only the stop-request branch can act on this row.
			leaseExpiresAt: "2099-01-01T00:00:00.000Z",
			trigger: "spotlight",
		});
		const harness = runtimeHarness(testEnv.BICKR_D1, { stopRequested: true });

		await expect(harness.runtime.reapStaleRun(botId)).resolves.toBe(true);

		await expect(runtimeSchedule(botId)).resolves.toEqual({
			status: "idle",
			activeRunTrigger: null,
			nextDueAt: standingDueAt,
		});
	});

	it("reschedules an ordinary visit when a stop request is reaped", async () => {
		const botId = await seedRunningRun("reap-stop-cron", "run-stop-cron", {
			leaseExpiresAt: "2099-01-01T00:00:00.000Z",
			trigger: "cron",
		});
		const harness = runtimeHarness(testEnv.BICKR_D1, { stopRequested: true });

		await expect(harness.runtime.reapStaleRun(botId)).resolves.toBe(true);

		const row = await runtimeSchedule(botId);
		expect(row).toMatchObject({ status: "idle", activeRunTrigger: null });
		expect(Date.parse(row.nextDueAt!)).toBeGreaterThan(Date.now());
	});

	// The reaper reads the row, then releases it, and the owner's own scheduling
	// runs against the same row in between. Preserving a standing schedule means
	// preserving whatever the column holds at the moment of the release, not
	// re-writing the snapshot the reaper happened to read first: a spotlight visit
	// never owned that column, so it may not put a stale value back into it.
	it("keeps a schedule written between the reaper's read and its release of a spotlight visit", async () => {
		const botId = await seedRunningRun("reap-stale-race", "run-stale-race", {
			leaseExpiresAt: "2020-01-01T00:00:00.000Z",
			trigger: "spotlight",
		});
		const concurrentDueAt = "2030-06-01T00:00:00.000Z";
		const db = d1ReschedulingBeforeRelease(testEnv.BICKR_D1, botId, concurrentDueAt);
		const harness = runtimeHarness(db);

		await expect(harness.runtime.reapStaleRun(botId)).resolves.toBe(true);

		await expect(runtimeSchedule(botId)).resolves.toEqual({
			status: "idle",
			activeRunTrigger: null,
			nextDueAt: concurrentDueAt,
		});
	});

	// A run claimed before the trigger column existed reads as a cron tick, which
	// is the pre-existing behaviour for every run in flight at deploy time.
	it("reschedules a run with no recorded trigger", async () => {
		const botId = await seedExpiredRun("reap-lease-unrecorded", "run-lease-unrecorded");
		const harness = runtimeHarness(testEnv.BICKR_D1);

		await expect(harness.runtime.reapStaleRun(botId)).resolves.toBe(true);

		const row = await runtimeSchedule(botId);
		expect(row.activeRunTrigger).toBeNull();
		expect(Date.parse(row.nextDueAt!)).toBeGreaterThan(Date.now());
	});
});

function runtimeHarness(
	db: D1Database,
	options: { stopRequested?: boolean; storageCleared?: boolean } = {},
): { runtime: TestRuntime; failureEvents: FailureEvent[] } {
	const failureEvents: FailureEvent[] = [];
	const terminalRuns = new Set<string>();
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		env: {
			BICKR_D1: db,
			BICKR_KV: testEnv.BICKR_KV,
		},
		activeAbortController: null,
		activeRunId: null,
		runtimeStorageClearedAt: options.storageCleared ? "2026-08-23T00:00:00.000Z" : null,
		hasStopRequest: () => options.stopRequested === true,
		hasTerminalEvent: (runId: string) => terminalRuns.has(runId),
		recordTickFailure: (runId: string, payload: Record<string, unknown>) => {
			terminalRuns.add(runId);
			failureEvents.push({ runId, payload });
		},
		setStopRequest: () => {},
		appendEvent: (runId: string) => {
			terminalRuns.add(runId);
			return { createdAt: "2026-08-11T00:00:00.000Z" };
		},
		clearStopRequest: () => {},
		markPendingCompactionEventsFailed: () => {},
	}) as unknown as TestRuntime;
	return { runtime, failureEvents };
}

async function seedExpiredRun(handle: string, runId: string, trigger: RuntimeRunTrigger | null = null): Promise<string> {
	return seedRunningRun(handle, runId, { leaseExpiresAt: standingDueAt, trigger });
}

async function seedRunningRun(
	handle: string,
	runId: string,
	options: { leaseExpiresAt: string | null; trigger: RuntimeRunTrigger | null },
): Promise<string> {
	const cookie = await authCookie();
	await seedWorld(cookie);
	// Enabled, because a paused participant has no standing schedule for a reap to
	// preserve or move: the release nulls next_due_at for a disabled row either way.
	const bot = await createBotForTest(cookie, handle, { enabled: true });
	await testEnv.BICKR_D1.prepare(
		`UPDATE bot_runtime_index
		 SET status = 'running',
		     active_run_id = ?,
		     active_run_trigger = ?,
		     lease_expires_at = ?,
		     next_due_at = ?,
		     last_error = NULL
		 WHERE bot_id = ?`,
	)
		.bind(runId, options.trigger, options.leaseExpiresAt, standingDueAt, bot.id)
		.run();
	return bot.id;
}

async function runtimeSchedule(botId: string): Promise<RuntimeScheduleRow> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT status, active_run_trigger AS activeRunTrigger, next_due_at AS nextDueAt
		 FROM bot_runtime_index
		 WHERE bot_id = ?`,
	)
		.bind(botId)
		.first<RuntimeScheduleRow>();
	if (!row) {
		throw new Error(`Missing runtime index row for ${botId}.`);
	}
	return row;
}

async function runtimeIndexState(botId: string): Promise<{
	status: string;
	activeRunId: string | null;
	lastError: string | null;
}> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT status, active_run_id AS activeRunId, last_error AS lastError
		 FROM bot_runtime_index
		 WHERE bot_id = ?`,
	)
		.bind(botId)
		.first<{ status: string; activeRunId: string | null; lastError: string | null }>();
	if (!row) {
		throw new Error(`Missing runtime index row for ${botId}.`);
	}
	return row;
}

/**
 * A D1 that reschedules the row just before the reaper's release lands.
 *
 * The reaper's read and its release are two statements with an await between
 * them, so anything that writes `next_due_at` in that window — an owner
 * resuming, an ordinary tick claiming — commits after the snapshot was taken and
 * before the release decides what to write. Wrapping the release statement is
 * how that window is made deterministic: the interleaving is the subject, so it
 * cannot be left to chance.
 */
function d1ReschedulingBeforeRelease(delegate: D1Database, botId: string, nextDueAt: string): D1Database {
	// The ownership compare-and-set is unique to releaseRuntimeRun, so matching on
	// it cannot catch the reaper's read or any other statement by accident.
	const isRelease = (query: string): boolean => query.includes("active_run_id IS ?");
	const wrap = (statement: D1PreparedStatement, intercept: boolean): D1PreparedStatement =>
		({
			bind: (...values: unknown[]) => wrap(statement.bind(...values), intercept),
			first: statement.first.bind(statement),
			run: async (...args: []) => {
				if (intercept) {
					await delegate
						.prepare(`UPDATE bot_runtime_index SET next_due_at = ? WHERE bot_id = ?`)
						.bind(nextDueAt, botId)
						.run();
				}
				return statement.run(...args);
			},
		}) as unknown as D1PreparedStatement;
	return {
		prepare: (query: string) => wrap(delegate.prepare(query), isRelease(query)),
	} as unknown as D1Database;
}

function d1WithWriteCount(delegate: D1Database): { db: D1Database; writeCount: () => number } {
	let writes = 0;
	const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
		({
			bind: (...values: unknown[]) => wrap(statement.bind(...values)),
			first: statement.first.bind(statement),
			run: (...args: []) => {
				writes += 1;
				return statement.run(...args);
			},
		}) as unknown as D1PreparedStatement;
	return {
		db: {
			prepare: (query: string) => wrap(delegate.prepare(query)),
		} as unknown as D1Database,
		writeCount: () => writes,
	};
}
