import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import {
	BotRuntime,
	claimRuntimeRun,
	handleAgentRuntimeRequest,
	releaseRuntimeRun,
} from "../workers/agent-runtime/src/index";
import {
	localizedText,
	schemaVersion,
	type BotDocument,
	type LanguageTag,
	type UserDocument,
} from "../packages/shared/src/model";
import type { RuntimeRunTrigger } from "../workers/agent-runtime/src/types";
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
			claimRuntimeRun(testEnv.BICKR_D1, "bot_claim_idle", "run-idle", "2026-07-09T20:15:00.000Z", now, "cron"),
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
			claimRuntimeRun(testEnv.BICKR_D1, "bot_claim_live", "run-contender", "2026-07-09T20:45:00.000Z", now, "cron"),
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
			claimRuntimeRun(testEnv.BICKR_D1, "bot_claim_expired", "run-successor", "2026-07-09T20:45:00.000Z", now, "cron"),
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

	// The lease guard alone would admit both of these rows. `enabled = 1` has to
	// be an independent conjunct in the claim, because a pause is exactly what
	// leaves a claimable — idle, or holding nothing but a dead lease — row behind.
	it("refuses to claim a paused row and leaves it untouched", async () => {
		await seedBotRuntimeRow({ botId: "bot_claim_paused_idle", status: "idle", nextDueAt: null });
		await seedBotRuntimeRow({
			botId: "bot_claim_paused_expired",
			status: "running",
			activeRunId: "run-abandoned",
			leaseExpiresAt: "2026-07-09T19:59:59.000Z",
			nextDueAt: null,
		});
		await pauseRuntimeIndexRows("bot_claim_paused_idle", "bot_claim_paused_expired");

		await expect(
			claimRuntimeRun(testEnv.BICKR_D1, "bot_claim_paused_idle", "run-paused", "2026-07-09T20:15:00.000Z", now, "cron"),
		).resolves.toBe(false);
		await expect(runtimeIndexRow("bot_claim_paused_idle")).resolves.toMatchObject({
			enabled: 0,
			status: "idle",
			activeRunId: null,
			leaseExpiresAt: null,
			nextDueAt: null,
		});

		await expect(
			claimRuntimeRun(testEnv.BICKR_D1, "bot_claim_paused_expired", "run-successor", "2026-07-09T20:15:00.000Z", now, "cron"),
		).resolves.toBe(false);
		await expect(runtimeIndexRow("bot_claim_paused_expired")).resolves.toMatchObject({
			enabled: 0,
			status: "running",
			activeRunId: "run-abandoned",
			leaseExpiresAt: "2026-07-09T19:59:59.000Z",
			nextDueAt: null,
		});
	});
});

describe("runtime scheduling against a concurrent owner pause", () => {
	// Far enough out that a resume which merely preserved it would leave the
	// participant idle for months instead of visiting again straight away.
	const staleDueAt = "2027-01-01T00:00:00.000Z";

	it("leaves a participant paused mid-visit unscheduled and makes the resume due immediately", async () => {
		await seedBotRuntimeRow({
			status: "running",
			activeRunId: "run-live",
			leaseExpiresAt: staleDueAt,
			nextDueAt: staleDueAt,
		});
		await seedBotDocuments();

		expect((await patchTickEnabled(false)).status).toBe(200);
		// The visit under way is deliberately untouched: pausing is not stopping.
		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({
			enabled: 0,
			nextDueAt: null,
			status: "running",
			activeRunId: "run-live",
		});

		// That visit now finishes and proposes the schedule it computed before the
		// pause. Persisting it would resurrect a schedule for a disabled row.
		await expect(
			releaseRuntimeRun(testEnv.BICKR_D1, {
				botId,
				runId: "run-live",
				status: "idle",
				nextDueAt: staleDueAt,
				lastError: null,
				now: "2026-07-09T20:05:00.000Z",
			}),
		).resolves.toBe(true);
		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({
			enabled: 0,
			nextDueAt: null,
			status: "idle",
			activeRunId: null,
		});

		expect((await patchTickEnabled(true)).status).toBe(200);
		const resumed = await runtimeIndexRow(botId);
		expect(resumed.enabled).toBe(1);
		expect(resumed.nextDueAt).not.toBeNull();
		expect(Date.parse(resumed.nextDueAt!)).toBeLessThanOrEqual(Date.now());
	});

	it("refuses to admit a loop run while the participant is paused", async () => {
		await seedBotRuntimeRow({ status: "idle" });
		await seedBotDocuments();
		expect((await patchTickEnabled(false)).status).toBe(200);
		const harness = testRuntimeHarness();

		const payload = await json<TickResponsePayload>(harness.runtime.fetch(tickRequest()));

		expect(payload).toMatchObject({ ok: true, data: { run: { runId: "paused", status: "paused" } } });
		expect(harness.tickBodies).toEqual([]);
		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({
			enabled: 0,
			nextDueAt: null,
			status: "idle",
		});
	});

	it("refuses to admit a loop run when the pause lands between the enabled read and the claim", async () => {
		await seedBotRuntimeRow({ status: "idle" });
		await seedBotDocuments();
		const harness = testRuntimeHarness();
		// Admission reads `enabled`, then awaits the participant, its owner, and the
		// provider settings before claiming the row. Committing the owner's pause
		// inside the first of those awaits places the write exactly in that window,
		// so only the claim's own guard can keep the run out.
		Object.assign(harness.runtime as object, {
			botWithEffectivePostingSettings: async (bot: BotDocument) => {
				expect((await patchTickEnabled(false)).status).toBe(200);
				return {
					...bot,
					effectivePostingSettings: { threadBodyCharacters: 1000, commentBodyCharacters: 1000 },
					worldPrompt: "",
				};
			},
		});
		// Nothing should reach the tick body, but an admitted run must finish rather
		// than hang the assertions below on a never-released deferred.
		harness.releaseTick.resolve();

		const payload = await json<TickResponsePayload>(harness.runtime.fetch(tickRequest()));

		expect(payload).toMatchObject({ ok: true, data: { run: { runId: "paused", status: "paused" } } });
		expect(harness.tickBodies).toEqual([]);
		expect(harness.events).toEqual([]);
		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({
			enabled: 0,
			status: "idle",
			activeRunId: null,
			leaseExpiresAt: null,
			nextDueAt: null,
		});
	});

	it("still persists a released run's proposed schedule while the participant stays enabled", async () => {
		await seedBotRuntimeRow({
			botId: "bot_release_enabled",
			status: "running",
			activeRunId: "run-enabled",
			leaseExpiresAt: staleDueAt,
			nextDueAt: staleDueAt,
		});

		await expect(
			releaseRuntimeRun(testEnv.BICKR_D1, {
				botId: "bot_release_enabled",
				runId: "run-enabled",
				status: "idle",
				nextDueAt: "2026-07-09T20:01:00.000Z",
				lastError: null,
				now: "2026-07-09T20:00:30.000Z",
			}),
		).resolves.toBe(true);
		await expect(runtimeIndexRow("bot_release_enabled")).resolves.toMatchObject({
			enabled: 1,
			status: "idle",
			activeRunId: null,
			nextDueAt: "2026-07-09T20:01:00.000Z",
		});
	});

	// The mirror image of the pause race: the release carries the *absence* of a
	// schedule computed from a paused read, and the row is enabled again by the
	// time it lands. Writing that null would leave an enabled participant with
	// nothing due and nothing left to reschedule it.
	it("keeps an unpaused participant's fresh schedule when the release proposes a stale nothing", async () => {
		await seedBotRuntimeRow({
			status: "running",
			activeRunId: "run-live",
			leaseExpiresAt: staleDueAt,
			nextDueAt: staleDueAt,
		});
		await seedBotDocuments();

		expect((await patchTickEnabled(false)).status).toBe(200);
		// The run — or a reaper — reads the paused row here and proposes no next
		// visit at all, exactly as production computes it from `enabled`.
		const pausedRead = await runtimeIndexRow(botId);
		expect(pausedRead).toMatchObject({ enabled: 0, status: "running", nextDueAt: null });
		const staleProposal = pausedRead.enabled === 1 ? staleDueAt : null;
		expect(staleProposal).toBeNull();

		// The owner changes their mind before that visit finishes: the resume makes
		// the participant due immediately.
		expect((await patchTickEnabled(true)).status).toBe(200);
		const resumed = await runtimeIndexRow(botId);
		expect(resumed).toMatchObject({ enabled: 1, status: "running", activeRunId: "run-live" });
		expect(resumed.nextDueAt).not.toBeNull();
		expect(Date.parse(resumed.nextDueAt!)).toBeLessThanOrEqual(Date.now());

		await expect(
			releaseRuntimeRun(testEnv.BICKR_D1, {
				botId,
				runId: "run-live",
				status: "idle",
				nextDueAt: staleProposal,
				lastError: null,
				now: "2026-07-09T20:05:00.000Z",
			}),
		).resolves.toBe(true);
		// The run is released — status, lease and ownership all cleared — while the
		// resume's own schedule survives untouched.
		await expect(runtimeIndexRow(botId)).resolves.toEqual({
			enabled: 1,
			status: "idle",
			activeRunId: null,
			activeRunTrigger: null,
			leaseExpiresAt: null,
			nextDueAt: resumed.nextDueAt,
		});
	});

	it("keeps the runtime index write unscheduled when the pause lands after its enabled read", async () => {
		await seedBotRuntimeRow({
			status: "running",
			activeRunId: "run-live",
			leaseExpiresAt: staleDueAt,
			nextDueAt: null,
		});
		await pauseRuntimeIndexRows(botId);
		const runtime = releasingRuntime(stalelyEnabledD1());

		await runtime.setRuntimeIndex(testBotDocument(), "idle", undefined, now, "run-live", "cron");

		await expect(runtimeIndexRow(botId)).resolves.toEqual({
			enabled: 0,
			status: "idle",
			activeRunId: null,
			activeRunTrigger: null,
			leaseExpiresAt: null,
			nextDueAt: null,
		});
	});
});

describe("spotlight visits against the participant's own schedule", () => {
	// Already due, and reached by the participant's own rhythm rather than by any
	// spotlight: every assertion below is about whether this survives the visit.
	const standingDueAt = "2026-07-09T19:58:00.000Z";
	const leaseExpiresAt = "2026-07-09T20:15:00.000Z";

	it("records the trigger and leaves the standing schedule alone when a spotlight claims the row", async () => {
		await seedBotRuntimeRow({ status: "idle", nextDueAt: standingDueAt });

		await expect(
			claimRuntimeRun(testEnv.BICKR_D1, botId, "run-spotlight", leaseExpiresAt, now, "spotlight"),
		).resolves.toBe(true);

		// The live lease is what keeps the scheduler off the row while the visit
		// runs, so a schedule left in the past cannot double-dispatch.
		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({
			status: "running",
			activeRunId: "run-spotlight",
			activeRunTrigger: "spotlight",
			leaseExpiresAt,
			nextDueAt: standingDueAt,
		});
	});

	it("pushes the schedule out to the lease when an ordinary visit claims the row", async () => {
		await seedBotRuntimeRow({ status: "idle", nextDueAt: standingDueAt });

		await expect(claimRuntimeRun(testEnv.BICKR_D1, botId, "run-cron", leaseExpiresAt, now, "cron")).resolves.toBe(true);

		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({
			activeRunTrigger: "cron",
			nextDueAt: leaseExpiresAt,
		});
	});

	// Success, the no-injection early return, and every failure branch release the
	// run through this one call, so the trigger decides the schedule for all of
	// them at once.
	it.each([
		{ label: "completes", status: "idle" as const, lastError: undefined },
		{ label: "fails", status: "failed" as const, lastError: "Provider gave up." },
	])("leaves the standing schedule untouched when a spotlight visit $label", async ({ status, lastError }) => {
		await seedBotRuntimeRow({
			status: "running",
			activeRunId: "run-spotlight",
			activeRunTrigger: "spotlight",
			leaseExpiresAt,
			nextDueAt: standingDueAt,
		});

		const proposed = await releasingRuntime().setRuntimeIndex(
			testBotDocument(),
			status,
			lastError,
			"2026-07-09T20:03:00.000Z",
			"run-spotlight",
			"spotlight",
		);

		expect(proposed).toEqual({ nextDueAt: null, released: true });
		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({
			enabled: 1,
			status,
			activeRunId: null,
			activeRunTrigger: null,
			leaseExpiresAt: null,
			nextDueAt: standingDueAt,
		});
	});

	const completesAt = "2026-07-09T20:04:00.000Z";
	// A failed ordinary visit waits out a lease timeout instead of its own
	// interval, which is 15 minutes past the release below.
	const failsAt = "2026-07-09T20:18:00.000Z";

	// 'manual' is only a human starting the participant's own visit early, so it
	// is an ordinary visit in every way that matters here — the run belongs to the
	// participant's rhythm and reschedules it. Only 'spotlight' is the exception,
	// and the arms below are what keep the two from being confused for each other.
	it.each([
		{ label: "a cron visit completes", trigger: "cron" as const, status: "idle" as const, expected: completesAt },
		{ label: "a cron visit fails", trigger: "cron" as const, status: "failed" as const, expected: failsAt },
		{ label: "a manual visit completes", trigger: "manual" as const, status: "idle" as const, expected: completesAt },
		{ label: "a manual visit fails", trigger: "manual" as const, status: "failed" as const, expected: failsAt },
	])("reschedules from the release when $label", async ({ trigger, status, expected }) => {
		const runId = `run-${trigger}`;
		const lastError = status === "failed" ? "Provider gave up." : undefined;
		await seedBotRuntimeRow({
			status: "running",
			activeRunId: runId,
			activeRunTrigger: trigger,
			leaseExpiresAt,
			nextDueAt: leaseExpiresAt,
		});

		const proposed = await releasingRuntime().setRuntimeIndex(
			testBotDocument(),
			status,
			lastError,
			"2026-07-09T20:03:00.000Z",
			runId,
			trigger,
		);

		expect(proposed).toEqual({ nextDueAt: expected, released: true });
		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({ status, nextDueAt: expected });
	});

	// The out-of-band stop: this instance no longer owns the run, so the trigger
	// can only come from the row the claim recorded it on.
	it("leaves the standing schedule untouched when a spotlight visit is stopped out of band", async () => {
		await seedBotRuntimeRow({
			status: "running",
			activeRunId: "run-spotlight",
			activeRunTrigger: "spotlight",
			leaseExpiresAt: "2027-01-01T00:00:00.000Z",
			nextDueAt: standingDueAt,
		});
		await seedBotDocuments();

		await expect(stoppingRuntime().stopTick(botId)).resolves.toMatchObject({
			kind: "stopped",
			stopped: true,
			runId: "run-spotlight",
			status: "idle",
		});

		await expect(runtimeIndexRow(botId)).resolves.toMatchObject({
			status: "idle",
			activeRunId: null,
			activeRunTrigger: null,
			nextDueAt: standingDueAt,
		});
	});

	it.each([
		{ label: "an ordinary", activeRunTrigger: "cron" as const },
		// A row claimed before the column existed carries no trigger at all, and is
		// read as the ordinary tick it most likely was.
		{ label: "an unrecorded", activeRunTrigger: null },
	])("reschedules from the stop when $label visit is stopped out of band", async ({ activeRunTrigger }) => {
		await seedBotRuntimeRow({
			status: "running",
			activeRunId: "run-cron",
			activeRunTrigger,
			leaseExpiresAt: "2027-01-01T00:00:00.000Z",
			nextDueAt: standingDueAt,
		});
		await seedBotDocuments();

		await expect(stoppingRuntime().stopTick(botId)).resolves.toMatchObject({
			kind: "stopped", stopped: true, runId: "run-cron",
		});

		const row = await runtimeIndexRow(botId);
		expect(row).toMatchObject({ status: "idle", activeRunId: null, activeRunTrigger: null });
		// The stop reschedules from its own clock, an interval out from real now.
		expect(Date.parse(row.nextDueAt!)).toBeGreaterThan(Date.now());
	});
});

// setRuntimeIndex and stopTick reach D1 and KV only, so a prototype instance with
// the surrounding event stream stubbed out exercises the real schedule decision
// without standing up a Durable Object.
function releasingRuntime(db: D1Database = testEnv.BICKR_D1): {
	setRuntimeIndex(
		bot: BotDocument,
		status: "idle" | "failed",
		lastError: string | undefined,
		now: string,
		ownedByRunId: string,
		trigger: RuntimeRunTrigger,
	): Promise<string | null>;
} {
	return Object.assign(Object.create(BotRuntime.prototype), {
		env: { BICKR_D1: db, BICKR_KV: testEnv.BICKR_KV },
	});
}

function stoppingRuntime(): { stopTick(botId: string): Promise<{ stopped: boolean; runId?: string; status: string }> } {
	return Object.assign(releasingRuntime(), {
		activeRunId: null,
		activeAbortController: null,
		reapStaleRun: async () => false,
		appendEvent: () => ({ createdAt: now }),
		setStopRequest: () => {},
		clearStopRequest: () => {},
		markPendingCompactionEventsFailed: () => {},
		hasTerminalEvent: () => false,
	}) as unknown as { stopTick(botId: string): Promise<{ stopped: boolean; runId?: string; status: string }> };
}

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

function testBotDocument(): BotDocument {
	return {
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
	const bot = testBotDocument();
	await testEnv.BICKR_KV.put(kvKeys.user(ownerId), JSON.stringify(user));
	await testEnv.BICKR_KV.put(kvKeys.bot(botId), JSON.stringify(bot));
	await testEnv.BICKR_D1.batch([
		testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id,
				owner_user_id, claim_state, operation_id, created_at, updated_at
			) VALUES ('bot_handle', ?, ?, 'bot', ?, ?, 'active', NULL, ?, ?)`,
		).bind(bot.homeWorldId, bot.handle, bot.id, bot.ownerUserId, now, now),
		testEnv.BICKR_D1.prepare(
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
		),
	]);
}

async function seedBotRuntimeRow(input: {
	botId?: string;
	status: "idle" | "running" | "failed";
	activeRunId?: string | null;
	// Left null by default so the seeded row also models one claimed by a
	// deployment older than the column, which every reader treats as a cron tick.
	activeRunTrigger?: RuntimeRunTrigger | null;
	leaseExpiresAt?: string | null;
	nextDueAt?: string | null;
}): Promise<void> {
	const rowBotId = input.botId ?? botId;
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bot_runtime_index (
			bot_id, owner_user_id, world_id, enabled, tick_interval_seconds, context_window_tokens,
			compaction_threshold, compaction_summary_percent, compaction_max_characters,
			max_tool_calls_per_tick, max_successful_tool_calls_per_iteration,
			max_generated_tokens_per_tick, max_generated_tokens_per_iteration,
			next_due_at, status, active_run_id, active_run_trigger, lease_expires_at, last_error, created_at, updated_at
		) VALUES (?, ?, ?, 1, 60, NULL, 0.75, 10, 4000, 10, 8, 15000, 30000, ?, ?, ?, ?, ?, NULL, ?, ?)`,
	)
		.bind(
			rowBotId,
			ownerId,
			worldId,
			input.nextDueAt === undefined ? now : input.nextDueAt,
			input.status,
			input.activeRunId ?? null,
			input.activeRunTrigger ?? null,
			input.leaseExpiresAt ?? null,
			now,
			now,
		)
		.run();
}

type RuntimeIndexRow = {
	enabled: number;
	status: string;
	activeRunId: string | null;
	activeRunTrigger: string | null;
	leaseExpiresAt: string | null;
	nextDueAt: string | null;
};

async function pauseRuntimeIndexRows(...rowBotIds: string[]): Promise<void> {
	await testEnv.BICKR_D1.batch(
		rowBotIds.map((rowBotId) =>
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET enabled = 0 WHERE bot_id = ?`).bind(rowBotId),
		),
	);
}

async function runtimeIndexRow(rowBotId: string): Promise<RuntimeIndexRow> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT enabled, status, active_run_id AS activeRunId, active_run_trigger AS activeRunTrigger,
			lease_expires_at AS leaseExpiresAt, next_due_at AS nextDueAt
		 FROM bot_runtime_index
		 WHERE bot_id = ?`,
	)
		.bind(rowBotId)
		.first<RuntimeIndexRow>();
	if (!row) {
		throw new Error(`Missing runtime row for ${rowBotId}.`);
	}
	return row;
}

async function patchTickEnabled(enabled: boolean): Promise<Response> {
	return handleAgentRuntimeRequest(
		new Request(`https://agent.internal/users/${ownerId}/bots/${botId}`, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				"x-bickr-user-id": ownerId,
				"idempotency-key": `tick-enabled-${String(enabled)}`,
			},
			body: JSON.stringify({ tickSettings: { enabled } }),
		}),
		testEnv as never,
		{ objectId: "tick-admission-coordinator", ownerUserId: ownerId },
	);
}

// Models the owner's pause committing between the enabled read and the index
// write: the read still reports an enabled participant while the stored row is
// already disabled. Only the write's own guard can keep it unscheduled.
function stalelyEnabledD1(): D1Database {
	return {
		batch: (statements: unknown[]) => (testEnv.BICKR_D1 as unknown as {
			batch(values: unknown[]): Promise<unknown>;
		}).batch(statements),
		prepare: (sql: string) => {
			if (!/^\s*SELECT enabled\b/u.test(sql)) {
				return testEnv.BICKR_D1.prepare(sql);
			}
			const statement = { bind: () => statement, first: async () => ({ enabled: 1 }) };
			return statement;
		},
	} as unknown as D1Database;
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
