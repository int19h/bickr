import { describe, expect, it } from "vitest";
import { BotRuntime } from "../workers/agent-runtime/src/index";
import {
	authCookie,
	createBotForTest,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";

type FailureEvent = {
	runId: string;
	payload: Record<string, unknown>;
};

type TestRuntime = {
	fetch(request: Request): Promise<Response>;
	reapStaleRun(botId: string): Promise<boolean>;
};

describe("BotRuntime status", () => {
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
});

function runtimeHarness(db: D1Database): { runtime: TestRuntime; failureEvents: FailureEvent[] } {
	const failureEvents: FailureEvent[] = [];
	const terminalRuns = new Set<string>();
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		env: {
			BICKR_D1: db,
			BICKR_KV: testEnv.BICKR_KV,
		},
		activeAbortController: null,
		activeRunId: null,
		activeStreamActivity: new Map<string, string>(),
		hasStopRequest: () => false,
		staleProviderStream: () => null,
		hasTerminalEvent: (runId: string) => terminalRuns.has(runId),
		recordTickFailure: (runId: string, payload: Record<string, unknown>) => {
			terminalRuns.add(runId);
			failureEvents.push({ runId, payload });
		},
		setStopRequest: () => {},
	}) as unknown as TestRuntime;
	return { runtime, failureEvents };
}

async function seedExpiredRun(handle: string, runId: string): Promise<string> {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const bot = await createBotForTest(cookie, handle);
	await testEnv.BICKR_D1.prepare(
		`UPDATE bot_runtime_index
		 SET status = 'running',
		     active_run_id = ?,
		     lease_expires_at = ?,
		     next_due_at = ?,
		     last_error = NULL
		 WHERE bot_id = ?`,
	)
		.bind(runId, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", bot.id)
		.run();
	return bot.id;
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
