import { describe, expect, it } from "vitest";
import {
	BotRuntime,
	readOptionalJsonBody,
	runtimeMonitorBackfillCursor,
	runtimeMonitorInitialBackfillLimit,
} from "../workers/agent-runtime/src/index";
import { InputError } from "../packages/shared/src/validation";
import type { BotLoopMessage, BotRuntimeEvent } from "../packages/shared/src/model";

describe("runtime monitor backfill", () => {
	it("caps initial monitor backfills and leaves positive reconnect cursors uncapped", () => {
		expect(runtimeMonitorBackfillCursor(new URL("https://example.test/monitor"), "afterMessage")).toEqual({
			afterSeq: 0,
			initialLimit: runtimeMonitorInitialBackfillLimit,
		});
		expect(runtimeMonitorBackfillCursor(new URL("https://example.test/monitor?afterMessage=42"), "afterMessage")).toEqual({
			afterSeq: 42,
		});
		expect(runtimeMonitorBackfillCursor(new URL("https://example.test/monitor?after=7"), "afterEvent")).toEqual({
			afterSeq: 7,
		});
		expect(runtimeMonitorBackfillCursor(new URL("https://example.test/monitor?afterMessage=0"), "afterMessage")).toEqual({
			afterSeq: 0,
			initialLimit: runtimeMonitorInitialBackfillLimit,
		});
	});

	it("returns the newest active loop messages in display order for capped initial backfill", () => {
		const runtime = testRuntime(loopRows(150), eventRows(0));

		const messages = runtime.loopMessagesAfter(0, runtimeMonitorInitialBackfillLimit);

		expect(messages).toHaveLength(runtimeMonitorInitialBackfillLimit);
		expect(messages[0]?.seq).toBe(51);
		expect(messages.at(-1)?.seq).toBe(150);
	});

	it("keeps reconnect catch-up based on the requested sequence instead of the initial cap", () => {
		const runtime = testRuntime(loopRows(150), eventRows(150));

		expect(runtime.loopMessagesAfter(120).map((message) => message.seq)).toEqual(range(121, 150));
		expect(runtime.eventsAfter(120).map((event) => event.seq)).toEqual(range(121, 150));
	});

	it("uses the monitor cap for initial event backfill without changing event order", () => {
		const runtime = testRuntime(loopRows(0), eventRows(150));

		const events = runtime.eventsAfter(0, runtimeMonitorInitialBackfillLimit);

		expect(events).toHaveLength(runtimeMonitorInitialBackfillLimit);
		expect(events[0]?.seq).toBe(51);
		expect(events.at(-1)?.seq).toBe(150);
	});
});

describe("readOptionalJsonBody", () => {
	it("wraps malformed optional JSON as a typed input error", async () => {
		await expect(readOptionalJsonBody(new Request("https://example.test", {
			method: "POST",
			body: "{",
			headers: { "content-type": "application/json" },
		}))).rejects.toBeInstanceOf(InputError);
		await expect(readOptionalJsonBody(new Request("https://example.test", {
			method: "POST",
			body: "{",
			headers: { "content-type": "application/json" },
		}))).rejects.toMatchObject({
			message: "Request body must be valid JSON.",
		});
	});
});

type RuntimeInternals = {
	loopMessagesAfter(afterSeq: number, initialLimit?: number): BotLoopMessage[];
	eventsAfter(afterSeq: number, initialLimit?: number): BotRuntimeEvent[];
	state: {
		storage: {
			sql: ReturnType<typeof runtimeSql>;
		};
	};
};

type LoopRow = {
	seq: number;
	position: number;
	run_id: string;
	role: "user";
	message_json: string;
	origin: "input";
	status: "complete";
	token_estimate: number;
	stream_seq: number | null;
	display_event_seq: number | null;
	display_event_type: null;
	display_event_payload_json: null;
	compacted_by: null;
	deleted_at: null;
	created_at: string;
	has_logs: number;
};

type EventRow = {
	seq: number;
	run_id: string;
	type: "input";
	payload_json: string;
	token_estimate: number;
	compacted_by: number | null;
	created_at: string;
};

function testRuntime(loopMessages: LoopRow[], events: EventRow[]): RuntimeInternals {
	return Object.assign(Object.create(BotRuntime.prototype), {
		state: {
			storage: {
				sql: runtimeSql(loopMessages, events),
			},
		},
	}) as RuntimeInternals;
}

function runtimeSql(loopMessages: LoopRow[], events: EventRow[]) {
	return {
		exec<T>(sql: string, ...params: unknown[]) {
			const normalized = sql.trim().replace(/\s+/g, " ");
			if (normalized.includes("FROM loop_messages m")) {
				return {
					toArray: () => selectRows(loopMessages, normalized, params) as T[],
				};
			}
			if (normalized.includes("FROM events")) {
				return {
					toArray: () => selectRows(events, normalized, params) as T[],
				};
			}
			return {
				toArray: () => [] as T[],
			};
		},
	};
}

function selectRows<T extends { seq: number }>(rows: T[], sql: string, params: unknown[]): T[] {
	if (sql.includes("seq > ?")) {
		const afterSeq = Number(params[0]);
		return rows.filter((row) => row.seq > afterSeq).slice(0, 2000);
	}
	if (sql.includes("LIMIT ?")) {
		const limit = Number(params[params.length - 1]);
		return rows.slice(-limit);
	}
	return rows;
}

function loopRows(count: number): LoopRow[] {
	return range(1, count).map((seq) => ({
		seq,
		position: seq,
		run_id: "run-monitor",
		role: "user",
		message_json: JSON.stringify({ role: "user", content: `message ${seq}` }),
		origin: "input",
		status: "complete",
		token_estimate: 0,
		stream_seq: null,
		display_event_seq: null,
		display_event_type: null,
		display_event_payload_json: null,
		compacted_by: null,
		deleted_at: null,
		created_at: "2026-07-10T00:00:00.000Z",
		has_logs: 0,
	}));
}

function eventRows(count: number): EventRow[] {
	return range(1, count).map((seq) => ({
		seq,
		run_id: "run-monitor",
		type: "input",
		payload_json: JSON.stringify({ text: `event ${seq}` }),
		token_estimate: 0,
		compacted_by: null,
		created_at: "2026-07-10T00:00:00.000Z",
	}));
}

function range(start: number, end: number): number[] {
	return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}
