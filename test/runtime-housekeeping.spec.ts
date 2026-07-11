import { describe, expect, it } from "vitest";
import { botInferenceUsageRetentionDays } from "@bickr/shared/token-spend";
import { BotRuntime, dispatchDueBots } from "../workers/agent-runtime/src/index";

type RuntimeEventFixtureRow = {
	seq: number;
	run_id: string;
	type: string;
	payload_json: string;
	token_estimate: number;
	compacted_by: number | null;
	created_at: string;
};

type ProviderUsageFixtureRow = {
	id: number;
	run_id: string;
	request_seq: number;
	completion_tokens: number;
	created_at: string;
};

type InferenceSubmissionFixtureRow = {
	run_id: string;
	event_seq: number;
	purpose: string;
};

type RuntimeHousekeepingSql = ReturnType<typeof runtimeHousekeepingSql>;

type RuntimeInternals = {
	currentIterationStartedSinceLastLogOff(): boolean;
	latestSuccessfulLogOffToolResultSeq(): number;
	loopGeneratedTokenCountSinceLastLogOff(): number;
	prematureLogOffCorrectedSinceLastLogOff(): boolean;
	pruneRuntimeStorageAfterTick(activeRunId: string, now?: Date): { events: number; providerUsage: number };
	successfulMutatingToolCallSinceLastLogOff(): boolean;
	successfulToolCallCountSinceLastLogOff(): number;
};

function runtimeEventRow(
	seq: number,
	type: string,
	payload: Record<string, unknown>,
	options: { createdAt?: string; runId?: string } = {},
): RuntimeEventFixtureRow {
	return {
		seq,
		run_id: options.runId ?? `run-${seq}`,
		type,
		payload_json: JSON.stringify(payload),
		token_estimate: 0,
		compacted_by: null,
		created_at: options.createdAt ?? "2026-07-01T00:00:00.000Z",
	};
}

function runtimeHousekeepingSql(input: {
	events?: RuntimeEventFixtureRow[];
	inferenceSubmissions?: InferenceSubmissionFixtureRow[];
	providerUsage?: ProviderUsageFixtureRow[];
	runtimeState?: Record<string, unknown>;
} = {}) {
	const events = [...(input.events ?? [])];
	const inferenceSubmissions = [...(input.inferenceSubmissions ?? [])];
	const providerUsage = [...(input.providerUsage ?? [])];
	const runtimeState = new Map<string, string>(
		Object.entries(input.runtimeState ?? {}).map(([key, value]) => [key, JSON.stringify(value)]),
	);
	let changes = 0;
	let backfillScans = 0;

	return {
		events,
		providerUsage,
		backfillScans: () => backfillScans,
		runtimeStateValue: (key: string): unknown => {
			const value = runtimeState.get(key);
			return value === undefined ? undefined : JSON.parse(value);
		},
		exec<T>(query: string, ...params: unknown[]) {
			const normalized = query.trim().replace(/\s+/g, " ");
			if (/SELECT value_json FROM runtime_state WHERE key = \?/.test(normalized)) {
				const value = runtimeState.get(String(params[0]));
				return rows<T>(value === undefined ? [] : [{ value_json: value }]);
			}
			if (/INSERT INTO runtime_state/.test(normalized)) {
				runtimeState.set(String(params[0]), String(params[1]));
				return rows<T>([]);
			}
			if (/SELECT changes\(\) AS count/.test(normalized)) {
				return {
					one: () => ({ count: changes }) as T,
					toArray: () => [{ count: changes } as T],
				};
			}
			if (/FROM events WHERE type = 'tool_result' AND seq < \? AND payload_json LIKE '%"name":"log_off"%' ORDER BY seq DESC LIMIT 100/.test(normalized)) {
				backfillScans += 1;
				const beforeSeq = Number(params[0]);
				return rows<T>(events
					.filter((row) =>
						row.type === "tool_result"
						&& row.seq < beforeSeq
						&& row.payload_json.includes('"name":"log_off"'))
					.sort((left, right) => right.seq - left.seq)
					.slice(0, 100));
			}
			if (/FROM events WHERE seq > \? AND type = 'input' LIMIT 1/.test(normalized)) {
				const afterSeq = Number(params[0]);
				return rows<T>(events.some((row) => row.seq > afterSeq && row.type === "input") ? [{ found: 1 }] : []);
			}
			if (/FROM events WHERE seq > \? AND type = 'tool_result' ORDER BY seq ASC/.test(normalized)) {
				const afterSeq = Number(params[0]);
				return rows<T>(events
					.filter((row) => row.seq > afterSeq && row.type === "tool_result")
					.sort((left, right) => left.seq - right.seq));
			}
			if (/FROM events WHERE seq > \? AND type = 'provider_tool_call_dropped' ORDER BY seq DESC/.test(normalized)) {
				const afterSeq = Number(params[0]);
				return rows<T>(events
					.filter((row) => row.seq > afterSeq && row.type === "provider_tool_call_dropped")
					.sort((left, right) => right.seq - left.seq)
					.slice(0, 50));
			}
			if (/COALESCE\(SUM\(u\.completion_tokens\), 0\) AS tokens/.test(normalized)) {
				const afterSeq = Number(params[0]);
				const tokens = providerUsage
					.filter((usage) =>
						usage.request_seq > afterSeq
						&& inferenceSubmissions.some((submission) =>
							submission.purpose === "loop"
							&& submission.event_seq === usage.request_seq
							&& submission.run_id === usage.run_id
						)
					)
					.reduce((sum, usage) => sum + usage.completion_tokens, 0);
				return rows<T>([{ tokens }]);
			}
			if (/^DELETE FROM events WHERE created_at < \? AND run_id != \? AND seq < \?$/.test(normalized)) {
				const [cutoff, activeRunId, beforeSeq] = [String(params[0]), String(params[1]), Number(params[2])];
				const retained = events.filter((row) => !(row.created_at < cutoff && row.run_id !== activeRunId && row.seq < beforeSeq));
				changes = events.length - retained.length;
				events.splice(0, events.length, ...retained);
				return rows<T>([]);
			}
			if (/^DELETE FROM provider_usage WHERE created_at < \? AND id <= \? AND run_id != \?$/.test(normalized)) {
				const [cutoff, cursor, activeRunId] = [String(params[0]), Number(params[1]), String(params[2])];
				const retained = providerUsage.filter((row) => !(row.created_at < cutoff && row.id <= cursor && row.run_id !== activeRunId));
				changes = providerUsage.length - retained.length;
				providerUsage.splice(0, providerUsage.length, ...retained);
				return rows<T>([]);
			}
			return rows<T>([]);
		},
	};
}

function rows<T>(items: unknown[]) {
	return {
		one: () => (items[0] ?? {}) as T,
		toArray: () => items as T[],
	};
}

function runtimeForSql(sql: RuntimeHousekeepingSql): RuntimeInternals {
	return Object.assign(Object.create(BotRuntime.prototype), {
		state: {
			storage: { sql },
		},
	}) as RuntimeInternals;
}

function legacyLastSuccessfulLogOffSeq(events: RuntimeEventFixtureRow[]): number {
	for (const row of [...events].filter((event) => event.type === "tool_result").sort((left, right) => right.seq - left.seq)) {
		const payload = JSON.parse(row.payload_json) as { name?: unknown; result?: { ok?: unknown }; error?: unknown };
		if (payload.name === "log_off" && payload.error !== true && payload.result?.ok !== false) {
			return row.seq;
		}
	}
	return 0;
}

function legacyCounters(input: {
	events: RuntimeEventFixtureRow[];
	inferenceSubmissions: InferenceSubmissionFixtureRow[];
	providerUsage: ProviderUsageFixtureRow[];
}) {
	const lastLogOffSeq = legacyLastSuccessfulLogOffSeq(input.events);
	const successfulToolResults = input.events
		.filter((row) => row.seq > lastLogOffSeq && row.type === "tool_result")
		.map((row) => JSON.parse(row.payload_json) as { name?: string; result?: { ok?: boolean }; error?: boolean })
		.filter((payload) => payload.error !== true && payload.result?.ok !== false);
	return {
		currentIterationStarted: input.events.some((row) => row.seq > lastLogOffSeq && row.type === "input"),
		generatedTokens: input.providerUsage
			.filter((usage) =>
				usage.request_seq > lastLogOffSeq
				&& input.inferenceSubmissions.some((submission) =>
					submission.purpose === "loop"
					&& submission.event_seq === usage.request_seq
					&& submission.run_id === usage.run_id
				)
			)
			.reduce((sum, usage) => sum + usage.completion_tokens, 0),
		lastLogOffSeq,
		prematureLogOffCorrected: input.events
			.filter((row) => row.seq > lastLogOffSeq && row.type === "provider_tool_call_dropped")
			.some((row) => {
				const payload = JSON.parse(row.payload_json) as { reason?: string; calls?: Array<{ reason?: string }> };
				return payload.reason?.split(",").map((reason) => reason.trim()).includes("premature_log_off")
					|| payload.calls?.some((call) => call.reason === "premature_log_off") === true;
			}),
		successfulMutatingToolCall: successfulToolResults.some((payload) => payload.name === "create_thread"),
		successfulToolCallCount: successfulToolResults.length,
	};
}

function cursorCounters(runtime: RuntimeInternals) {
	return {
		currentIterationStarted: runtime.currentIterationStartedSinceLastLogOff(),
		generatedTokens: runtime.loopGeneratedTokenCountSinceLastLogOff(),
		lastLogOffSeq: runtime.latestSuccessfulLogOffToolResultSeq(),
		prematureLogOffCorrected: runtime.prematureLogOffCorrectedSinceLastLogOff(),
		successfulMutatingToolCall: runtime.successfulMutatingToolCallSinceLastLogOff(),
		successfulToolCallCount: runtime.successfulToolCallCountSinceLastLogOff(),
	};
}

function daysBefore(iso: string, days: number): string {
	return new Date(Date.parse(iso) - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("runtime housekeeping", () => {
	it("uses the persisted log-off cursor with lazy backfill equivalent to the old scan", () => {
		const events = [
			runtimeEventRow(1, "input", {}),
			runtimeEventRow(2, "tool_result", { name: "search_threads", result: { ok: true } }),
			runtimeEventRow(3, "tool_result", { name: "log_off", result: { ok: true } }),
			runtimeEventRow(4, "input", {}),
			runtimeEventRow(5, "tool_result", { name: "vote", result: { ok: true } }),
			runtimeEventRow(6, "provider_tool_call_dropped", { reason: "premature_log_off" }),
			runtimeEventRow(7, "tool_result", { name: "log_off", result: { ok: false } }),
			runtimeEventRow(8, "tool_result", { name: "log_off", result: { ok: true } }),
			runtimeEventRow(9, "input", {}),
			runtimeEventRow(10, "tool_result", { name: "create_thread", result: { ok: true } }),
			runtimeEventRow(11, "provider_tool_call_dropped", { calls: [{ reason: "premature_log_off" }] }),
		];
		const inferenceSubmissions = [
			{ run_id: "run-before", event_seq: 5, purpose: "loop" },
			{ run_id: "run-after", event_seq: 9, purpose: "loop" },
			{ run_id: "run-after", event_seq: 10, purpose: "compaction" },
		];
		const providerUsage = [
			{ id: 1, run_id: "run-before", request_seq: 5, completion_tokens: 100, created_at: "2026-07-01T00:00:00.000Z" },
			{ id: 2, run_id: "run-after", request_seq: 9, completion_tokens: 40, created_at: "2026-07-01T00:00:00.000Z" },
			{ id: 3, run_id: "run-after", request_seq: 10, completion_tokens: 200, created_at: "2026-07-01T00:00:00.000Z" },
		];
		const expected = legacyCounters({ events, inferenceSubmissions, providerUsage });
		const lazySql = runtimeHousekeepingSql({ events, inferenceSubmissions, providerUsage });

		expect(cursorCounters(runtimeForSql(lazySql))).toEqual(expected);
		expect(lazySql.runtimeStateValue("last_log_off_seq")).toMatchObject({ seq: expected.lastLogOffSeq, source: "lazy_backfill" });
		expect(lazySql.backfillScans()).toBe(1);

		const cursorSql = runtimeHousekeepingSql({
			events,
			inferenceSubmissions,
			providerUsage,
			runtimeState: { last_log_off_seq: { seq: expected.lastLogOffSeq, source: "tool_result", updatedAt: "2026-07-01T00:00:00.000Z" } },
		});
		expect(cursorCounters(runtimeForSql(cursorSql))).toEqual(expected);
		expect(cursorSql.backfillScans()).toBe(0);
	});

	// The unpaged backfill materialized every tool_result payload at once and
	// OOM-reset large DOs on every tick (2026-07-11 incident). Paging is the
	// fix; this pins that a >1-page candidate history is walked page by page.
	it("pages the lazy backfill instead of materializing the whole history", () => {
		const events = Array.from({ length: 120 }, (_, index) =>
			runtimeEventRow(index + 1, "tool_result", { name: "log_off", result: { ok: index === 0 } }));
		const sql = runtimeHousekeepingSql({ events, inferenceSubmissions: [], providerUsage: [] });
		expect(cursorCounters(runtimeForSql(sql)).lastLogOffSeq).toBe(1);
		expect(sql.backfillScans()).toBe(2);
		expect(sql.runtimeStateValue("last_log_off_seq")).toMatchObject({ seq: 1, source: "lazy_backfill" });
	});

	it("prunes old local DO rows without deleting active-run or post-log-off rows", () => {
		const now = "2026-07-10T00:00:00.000Z";
		const old = daysBefore(now, 40);
		const recent = daysBefore(now, 1);
		const sql = runtimeHousekeepingSql({
			events: [
				runtimeEventRow(1, "input", {}, { createdAt: old, runId: "old-run-a" }),
				runtimeEventRow(2, "input", {}, { createdAt: old, runId: "active-run" }),
				runtimeEventRow(3, "tool_result", { name: "read_thread", result: { ok: true } }, { createdAt: old, runId: "old-run-b" }),
				runtimeEventRow(4, "tool_result", { name: "log_off", result: { ok: true } }, { createdAt: old, runId: "old-run-c" }),
				runtimeEventRow(5, "input", {}, { createdAt: old, runId: "old-run-d" }),
				runtimeEventRow(6, "input", {}, { createdAt: recent, runId: "recent-run" }),
			],
			providerUsage: [
				{ id: 1, run_id: "old-run-a", request_seq: 1, completion_tokens: 10, created_at: daysBefore(now, botInferenceUsageRetentionDays + 1) },
				{ id: 2, run_id: "active-run", request_seq: 2, completion_tokens: 10, created_at: daysBefore(now, botInferenceUsageRetentionDays + 1) },
				{ id: 3, run_id: "old-run-c", request_seq: 3, completion_tokens: 10, created_at: daysBefore(now, botInferenceUsageRetentionDays + 1) },
				{ id: 4, run_id: "recent-run", request_seq: 4, completion_tokens: 10, created_at: recent },
			],
			runtimeState: {
				central_provider_usage_export_cursor: { lastExportedProviderUsageId: 2, exportedAt: now },
				last_log_off_seq: { seq: 4, source: "tool_result", updatedAt: now },
			},
		});

		expect(runtimeForSql(sql).pruneRuntimeStorageAfterTick("active-run", new Date(now))).toEqual({
			events: 2,
			providerUsage: 1,
		});
		expect(sql.events.map((row) => row.seq)).toEqual([2, 4, 5, 6]);
		expect(sql.providerUsage.map((row) => row.id)).toEqual([2, 3, 4]);
	});

	it("dispatches more than one scheduler page and stops at the per-invocation budget", async () => {
		const botIds = Array.from({ length: 50 }, (_, index) => `bot-${String(index + 1).padStart(2, "0")}`);
		const started: string[] = [];
		const prepareCalls: Array<{ sql: string; params: unknown[] }> = [];
		const env = {
			INTERNAL_SERVICE_SECRET: "test-secret",
			BICKR_D1: {
				prepare(sql: string) {
					return {
						bind(...params: unknown[]) {
							prepareCalls.push({ sql, params });
							return {
								async all<T>() {
									const limit = Number(params[2]);
									return {
										success: true,
										results: botIds.splice(0, limit).map((botId) => ({ botId }) as T),
									};
								},
							};
						},
					};
				},
			},
			BOT_RUNTIME: {
				idFromName: (botId: string) => botId,
				get: (botId: string) => ({
					fetch: async (request: Request) => {
						started.push(botId);
						expect(request.url).toBe(`https://internal.bickr/bots/${botId}/tick`);
						expect(request.headers.get("x-bickr-scheduler")).toBe("1");
						expect(await request.json()).toEqual({ background: true });
						return Response.json({ ok: true });
					},
				}),
			},
		};

		const result = await dispatchDueBots(env as unknown as Parameters<typeof dispatchDueBots>[0], Date.parse("2026-07-10T00:00:00.000Z"), {
			batchSize: 20,
			maxDispatches: 25,
		});

		expect(result).toEqual({ dispatched: 25, budgetExhausted: true });
		expect(started).toHaveLength(25);
		expect(prepareCalls).toHaveLength(2);
		expect(prepareCalls[0]?.sql).toContain("ORDER BY next_due_at ASC");
		expect(prepareCalls.map((call) => call.params[2])).toEqual([20, 5]);
	});
});
