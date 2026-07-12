import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import {
	BotRuntime,
	claimRuntimeRun,
	releaseRuntimeRun,
} from "../workers/agent-runtime/src/index";
import {
	localizedText,
	schemaVersion,
	type BotDocument,
	type LanguageTag,
	type UserDocument,
} from "../packages/shared/src/model";
import { kvKeys } from "../packages/shared/src/storage";

const testLanguage = "en" as LanguageTag;
const ownerId = "usr_tick_admission";
const botId = "bot_tick_admission";
const worldId = "wld_tick_admission";
const now = "2026-07-09T20:00:00.000Z";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};

type TickResponsePayload = {
	ok: boolean;
	data: {
		run: {
			runId: string;
			status: string;
		};
	};
};

type RuntimeHarness = {
	runtime: TestRuntime;
	tickBodies: string[];
	tickStarted: Deferred<string>;
	releaseTick: Deferred<void>;
	events: Array<{ runId: string; type: string }>;
};

type TestRuntime = {
	fetch(request: Request): Promise<Response>;
	activeAbortController: AbortController | null;
	activeRunId: string | null;
	activeMaintenanceOperation: string | null;
};

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("BotRuntime tick admission", () => {
	it("admits only one of two simultaneous ticks racing through admission", async () => {
		await seedBotRuntimeRow({ status: "idle" });
		await seedBotDocuments();
		const harness = testRuntimeHarness();

		// Fire both requests before either can be admitted, so they interleave
		// inside the admission awaits (status/bot/user/claim). This is the race
		// the transition queue exists to close: without it, both requests pass
		// the guards and start two provider loops.
		const responses = [
			harness.runtime.fetch(tickRequest()),
			harness.runtime.fetch(tickRequest()),
		].map((response, index) => response.then((value) => ({ index, value })));

		// The winner blocks inside the tick body on releaseTick, so the first
		// settled response is necessarily the rejected loser.
		const loser = await Promise.race(responses);
		const loserPayload = await json<TickResponsePayload>(loser.value);
		expect(loserPayload).toMatchObject({
			ok: true,
			data: { run: { status: "already_running" } },
		});
		expect(harness.tickBodies).toHaveLength(1);

		harness.releaseTick.resolve();
		const winner = await responses[1 - loser.index]!;
		const winnerPayload = await json<TickResponsePayload>(winner.value);
		expect(winnerPayload).toMatchObject({
			ok: true,
			data: { run: { status: "completed" } },
		});
		expect(harness.events.filter((event) => event.type === "tick_started")).toHaveLength(1);
		expect(harness.tickBodies).toHaveLength(1);
	});

	it("rejects a tick while manual compaction has begun", async () => {
		await seedBotRuntimeRow({ status: "idle" });
		await seedBotDocuments();
		const harness = testRuntimeHarness();
		const compactStarted = deferred<void>();
		const releaseCompact = deferred<void>();
		const order: string[] = [];

		Object.assign(harness.runtime as object, {
			compactionCandidateRows: () => [{ seq: 1 }],
			compactLoopMessageRowsInBatches: async () => {
				order.push("compact-start");
				compactStarted.resolve();
				await releaseCompact.promise;
				order.push("compact-end");
			},
		});

		const compact = harness.runtime.fetch(compactRequest());
		await compactStarted.promise;
		const tickPayload = await json<TickResponsePayload>(harness.runtime.fetch(tickRequest()));

		expect(tickPayload).toMatchObject({
			ok: true,
			data: { run: { runId: "active", status: "already_running" } },
		});
		expect(harness.tickBodies).toEqual([]);

		releaseCompact.resolve();
		const compactPayload = await json<{ ok: boolean; data: { compacted: { fromSeq: number; toSeq: number; messageCount: number } } }>(compact);
		expect(compactPayload).toMatchObject({
			ok: true,
			data: { compacted: { fromSeq: 1, toSeq: 1, messageCount: 1 } },
		});
		expect(order).toEqual(["compact-start", "compact-end"]);
	});

	it("rejects clear-history while a tick is running", async () => {
		await seedBotRuntimeRow({ status: "idle" });
		await seedBotDocuments();
		const harness = testRuntimeHarness();

		const tick = harness.runtime.fetch(tickRequest());
		const runId = await harness.tickStarted.promise;
		const clearResponse = await harness.runtime.fetch(clearHistoryRequest());

		expect(clearResponse.status).toBe(409);
		expect(await clearResponse.json()).toMatchObject({
			ok: false,
			error: "conflict",
			message: "Cannot erase chat history while the bot is running.",
		});

		harness.releaseTick.resolve();
		await expect(json<TickResponsePayload>(tick)).resolves.toMatchObject({
			ok: true,
			data: { run: { runId, status: "completed" } },
		});
	});
});

describe("runtime D1 claim helpers", () => {
	it("claims idle rows, rejects live leases, claims expired leases, and ignores stale releases", async () => {
		await seedBotRuntimeRow({ botId: "bot_claim_idle", status: "idle" });
		await expect(
			claimRuntimeRun(testEnv.BICKR_D1, "bot_claim_idle", "run-idle", "2026-07-09T20:15:00.000Z", now),
		).resolves.toBe(true);
		await expect(runtimeIndexRow("bot_claim_idle")).resolves.toMatchObject({
			status: "running",
			activeRunId: "run-idle",
			leaseExpiresAt: "2026-07-09T20:15:00.000Z",
		});

		await seedBotRuntimeRow({
			botId: "bot_claim_live",
			status: "running",
			activeRunId: "run-live",
			leaseExpiresAt: "2026-07-09T20:30:00.000Z",
		});
		await expect(
			claimRuntimeRun(testEnv.BICKR_D1, "bot_claim_live", "run-contender", "2026-07-09T20:45:00.000Z", now),
		).resolves.toBe(false);
		await expect(runtimeIndexRow("bot_claim_live")).resolves.toMatchObject({
			status: "running",
			activeRunId: "run-live",
			leaseExpiresAt: "2026-07-09T20:30:00.000Z",
		});

		await seedBotRuntimeRow({
			botId: "bot_claim_expired",
			status: "running",
			activeRunId: "run-expired",
			leaseExpiresAt: "2026-07-09T19:59:59.000Z",
		});
		await expect(
			claimRuntimeRun(testEnv.BICKR_D1, "bot_claim_expired", "run-successor", "2026-07-09T20:45:00.000Z", now),
		).resolves.toBe(true);
		await expect(runtimeIndexRow("bot_claim_expired")).resolves.toMatchObject({
			status: "running",
			activeRunId: "run-successor",
			leaseExpiresAt: "2026-07-09T20:45:00.000Z",
		});

		await expect(
			releaseRuntimeRun(testEnv.BICKR_D1, {
				botId: "bot_claim_expired",
				runId: "run-expired",
				status: "idle",
				nextDueAt: null,
				lastError: null,
				now: "2026-07-09T20:46:00.000Z",
			}),
		).resolves.toBe(false);
		await expect(runtimeIndexRow("bot_claim_expired")).resolves.toMatchObject({
			status: "running",
			activeRunId: "run-successor",
			leaseExpiresAt: "2026-07-09T20:45:00.000Z",
		});
	});
});

function testRuntimeHarness(): RuntimeHarness {
	const tickStarted = deferred<string>();
	const releaseTick = deferred<void>();
	const events: RuntimeHarness["events"] = [];
	const tickBodies: string[] = [];
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		state: fakeRuntimeState(),
		env: {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		},
		activeAbortController: null,
		activeRunId: null,
		activeMaintenanceOperation: null,
		activeStreamActivity: new Map<string, string>(),
		ephemeralStreamSeq: 0,
		transitionQueue: new ExclusiveOperationQueue(),
		botWithEffectivePostingSettings: async (bot: BotDocument) => ({
			...bot,
			effectivePostingSettings: {
				threadBodyCharacters: 1000,
				commentBodyCharacters: 1000,
			},
			worldPrompt: "",
		}),
		effectiveProviderSettings: () => ({
			baseUrl: "https://provider.example.test/v1",
			model: "test-model",
			temperature: 0.2,
		}),
		currentIterationStartedSinceLastLogOff: () => false,
		runAdmittedTick: async function (
			this: RuntimeHarness["runtime"],
			_botId: string,
			_trigger: string,
			_options: unknown,
			admitted: { runId: string },
		) {
			tickBodies.push(admitted.runId);
			events.push({ runId: admitted.runId, type: "tick_started" });
			tickStarted.resolve(admitted.runId);
			await releaseTick.promise;
			await releaseRuntimeRun(testEnv.BICKR_D1, {
				botId,
				runId: admitted.runId,
				status: "idle",
				nextDueAt: null,
				lastError: null,
				now: new Date().toISOString(),
			});
			if (this.activeRunId === admitted.runId) {
				this.activeRunId = null;
				this.activeAbortController = null;
			}
			return { runId: admitted.runId, status: "completed" };
		},
		exportRecentProviderUsage: async () => {},
	}) as unknown as RuntimeHarness["runtime"];
	return { runtime, tickBodies, tickStarted, releaseTick, events };
}

function fakeRuntimeState(): DurableObjectState {
	return {
		storage: {
			sql: {
				exec<T = unknown>(query: string) {
					if (/SELECT changes\(\) AS count/.test(query)) {
						return fakeSqlCursor([{ count: 0 } as T]);
					}
					return fakeSqlCursor<T>([]);
				},
			},
		},
		waitUntil: () => {},
		getWebSockets: () => [],
		acceptWebSocket: () => {},
	} as unknown as DurableObjectState;
}

function fakeSqlCursor<T>(rows: T[]) {
	return {
		toArray: () => rows,
		one: () => {
			const first = rows[0];
			if (first === undefined) {
				throw new Error("Expected a fake SQL row.");
			}
			return first;
		},
	};
}

function tickRequest(): Request {
	return new Request(`https://internal.bickr/bots/${botId}/tick`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-bickr-scheduler": "1",
		},
		body: "{}",
	});
}

function compactRequest(): Request {
	return new Request(`https://internal.bickr/bots/${botId}/compact`, {
		method: "POST",
		headers: { "x-bickr-scheduler": "1" },
	});
}

function clearHistoryRequest(): Request {
	return new Request(`https://internal.bickr/bots/${botId}/events`, {
		method: "DELETE",
		headers: { "x-bickr-scheduler": "1" },
	});
}

async function seedBotDocuments(): Promise<void> {
	const user: UserDocument = {
		id: ownerId,
		type: "user",
		schemaVersion,
		revision: 1,
		handle: "tick-owner",
		language: testLanguage,
		displayName: localizedText("Tick Owner", testLanguage),
		createdAt: now,
		updatedAt: now,
	};
	const bot: BotDocument = {
		id: botId,
		type: "bot",
		schemaVersion,
		revision: 1,
		homeWorldId: worldId,
		homeWorldHandle: "tick-world",
		ownerUserId: ownerId,
		handle: "tick-bot",
		language: testLanguage,
		includeLanguageInSystemPrompt: false,
		displayName: localizedText("Tick Bot", testLanguage),
		shortBio: localizedText("Admission test participant.", testLanguage),
		prompt: localizedText("Stay concise.", testLanguage),
		inferenceSettings: {},
		toolSettings: {},
		tickSettings: {
			enabled: true,
			intervalSeconds: 60,
			compactionThreshold: 0.75,
		},
		createdAt: now,
		updatedAt: now,
	};
	await testEnv.BICKR_KV.put(kvKeys.user(ownerId), JSON.stringify(user));
	await testEnv.BICKR_KV.put(kvKeys.bot(botId), JSON.stringify(bot));
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, language, display_name, display_name_lang,
			owner_user_id, include_language_in_system_prompt, short_bio, short_bio_lang, avatar_url, avatar_crop,
			import_provider, import_external_handle, created_at, updated_at, deleted_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
	)
		.bind(
			bot.id,
			bot.homeWorldId,
			bot.homeWorldHandle,
			bot.handle,
			bot.language,
			bot.displayName.text,
			bot.displayName.lang,
			bot.ownerUserId,
			bot.shortBio.text,
			bot.shortBio.lang,
			bot.createdAt,
			bot.updatedAt,
		)
		.run();
}

async function seedBotRuntimeRow(input: {
	botId?: string;
	status: "idle" | "running" | "failed";
	activeRunId?: string | null;
	leaseExpiresAt?: string | null;
}): Promise<void> {
	const rowBotId = input.botId ?? botId;
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bot_runtime_index (
			bot_id, owner_user_id, world_id, enabled, tick_interval_seconds, context_window_tokens,
			compaction_threshold, compaction_summary_percent, compaction_max_characters,
			max_tool_calls_per_tick, max_successful_tool_calls_per_iteration,
			max_generated_tokens_per_tick, max_generated_tokens_per_iteration,
			next_due_at, status, active_run_id, lease_expires_at, last_error, created_at, updated_at
		) VALUES (?, ?, ?, 1, 60, NULL, 0.75, 10, 4000, 10, 8, 15000, 30000, ?, ?, ?, ?, NULL, ?, ?)`,
	)
		.bind(
			rowBotId,
			ownerId,
			worldId,
			now,
			input.status,
			input.activeRunId ?? null,
			input.leaseExpiresAt ?? null,
			now,
			now,
		)
		.run();
}

async function runtimeIndexRow(rowBotId: string): Promise<{
	status: string;
	activeRunId: string | null;
	leaseExpiresAt: string | null;
}> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT status, active_run_id AS activeRunId, lease_expires_at AS leaseExpiresAt
		 FROM bot_runtime_index
		 WHERE bot_id = ?`,
	)
		.bind(rowBotId)
		.first<{ status: string; activeRunId: string | null; leaseExpiresAt: string | null }>();
	if (!row) {
		throw new Error(`Missing runtime row for ${rowBotId}.`);
	}
	return row;
}

async function json<T>(response: Promise<Response> | Response): Promise<T> {
	return (await (await response).json()) as T;
}

function deferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] = () => {};
	let reject: Deferred<T>["reject"] = () => {};
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}
