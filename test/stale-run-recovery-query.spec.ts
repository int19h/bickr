import { describe, expect, it } from "vitest";
import {
	queryStaleRunRecoveryCandidates,
	runStaleRunRecoverySweep,
	type StaleRunRecoveryCandidate,
} from "../workers/agent-runtime/src/runtime/stale-run-recovery";
import { authCookie, createBotForTest, seedWorld, testEnv } from "./helpers/index-harness";

const cutoff = "2026-08-24T12:00:00.000Z";
const expired = "2026-08-24T11:59:00.000Z";
const live = "2026-08-24T12:15:00.000Z";

describe("stale-run recovery D1 query", () => {
	it("uses the migrated running-set index and keyset-pages every recoverable lease regardless of schedule", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const fixtures = await Promise.all([
			createBotForTest(cookie, "recover-future-spotlight", { enabled: true }),
			createBotForTest(cookie, "recover-paused", { enabled: false }),
			createBotForTest(cookie, "recover-null-lease", { enabled: true }),
			createBotForTest(cookie, "recover-live-lease", { enabled: true }),
			createBotForTest(cookie, "recover-not-running", { enabled: true }),
			createBotForTest(cookie, "recover-deleted", { enabled: true }),
			createBotForTest(cookie, "recover-deleting", { enabled: true }),
		]);
		const [spotlight, paused, nullLease, liveLease, notRunning, deleted, deleting] = fixtures;
		await setRuntime(spotlight.id, { leaseExpiresAt: expired, trigger: "spotlight", nextDueAt: live });
		await setRuntime(paused.id, { leaseExpiresAt: expired, trigger: "cron", nextDueAt: null });
		await setRuntime(nullLease.id, { leaseExpiresAt: null, trigger: "manual", nextDueAt: live });
		await setRuntime(liveLease.id, { leaseExpiresAt: live, trigger: "cron", nextDueAt: expired });
		await testEnv.BICKR_D1.prepare(
			`UPDATE bot_runtime_index SET status = 'idle', active_run_id = NULL, lease_expires_at = NULL WHERE bot_id = ?`,
		).bind(notRunning.id).run();
		await setRuntime(deleted.id, { leaseExpiresAt: expired, trigger: "cron", nextDueAt: expired });
		await setRuntime(deleting.id, { leaseExpiresAt: expired, trigger: "cron", nextDueAt: expired });
		await testEnv.BICKR_D1.prepare(`UPDATE bots_index SET deleted_at = ? WHERE bot_id = ?`)
			.bind(cutoff, deleted.id).run();
		await testEnv.BICKR_D1.prepare(`UPDATE bots_index SET deleted_at = ?, lifecycle_state = 'deleting' WHERE bot_id = ?`)
			.bind(cutoff, deleting.id).run();

		let cursor: string | undefined;
		const selected: StaleRunRecoveryCandidate[] = [];
		const recordedSql: string[] = [];
		const recordingDb = {
			batch: testEnv.BICKR_D1.batch.bind(testEnv.BICKR_D1),
			prepare(sql: string) {
				recordedSql.push(sql);
				return testEnv.BICKR_D1.prepare(sql);
			},
		};
		do {
			const page = await queryStaleRunRecoveryCandidates(recordingDb, { now: cutoff, cursor, limit: 2 });
			selected.push(...page.items);
			cursor = page.done ? undefined : page.nextCursor;
			if (page.done) break;
		} while (cursor);

		const expectedIds = [spotlight.id, paused.id, nullLease.id, deleted.id, deleting.id].sort();
		expect(selected.map((row) => row.botId)).toEqual(expectedIds);
		expect(selected.filter((row) => row.botDeletedAt !== null || row.botLifecycleState !== "active").map((row) => row.botId).sort())
			.toEqual([deleted.id, deleting.id].sort());
		expect(selected.map((row) => row.botId)).not.toContain(liveLease.id);
		expect(selected.map((row) => row.botId)).not.toContain(notRunning.id);
		expect(recordedSql).toHaveLength(3);
		expect(recordedSql.slice(1).every((sql) => sql.includes("runtime.bot_id > ?"))).toBe(true);

		const index = await testEnv.BICKR_D1.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
		).bind("bot_runtime_running_lease_recovery").first<{ name: string }>();
		expect(index?.name).toBe("bot_runtime_running_lease_recovery");
		const plan = await testEnv.BICKR_D1.prepare(`EXPLAIN QUERY PLAN ${recordedSql[0]}`)
			.bind(cutoff, 2)
			.all<{ detail: string }>();
		expect((plan.results ?? []).some((row) => row.detail.includes("bot_runtime_running_lease_recovery"))).toBe(true);

		const dispatched: string[] = [];
		const sweep = await runStaleRunRecoverySweep({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			BOT_RUNTIME: {
				idFromName: (botId: string) => botId,
				get: (botId: string) => ({
					fetch: async () => {
						dispatched.push(botId);
						return Response.json({ ok: true, data: { recovery: { kind: "not_running", botId } } });
					},
				}),
			},
		}, { now: cutoff, chunkSize: 2, maxBotsPerRun: 10 });
		expect(sweep).toMatchObject({ selected: 5, skippedNonLive: 2, notRunning: 3, failed: 0 });
		expect(dispatched).toEqual([spotlight.id, paused.id, nullLease.id].sort());
	});
});

async function setRuntime(
	botId: string,
	input: { leaseExpiresAt: string | null; trigger: "cron" | "manual" | "spotlight"; nextDueAt: string | null },
): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`UPDATE bot_runtime_index
		 SET status = 'running', active_run_id = ?, active_run_trigger = ?, lease_expires_at = ?, next_due_at = ?
		 WHERE bot_id = ?`,
	).bind(`run-${botId}`, input.trigger, input.leaseExpiresAt, input.nextDueAt, botId).run();
}
