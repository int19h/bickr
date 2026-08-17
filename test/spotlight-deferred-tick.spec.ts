import {
	authCookie,
	botById,
	BotRuntime,
	contextFor,
	createBotForTest,
	createForumForTest,
	createThreadForTest,
	deleteBot,
	describe,
	ExclusiveOperationQueue,
	expect,
	handleForumCoordinatorRequest,
	it,
	lt,
	memoryRuntimeSql,
	runtimeEvent,
	seedWorld,
	testEnv,
	type BotRuntimeEvent,
	type SpotlightSyntheticContext,
} from "./helpers/index-harness";

/**
 * The deferred spotlight visit.
 *
 * "Wait for the participant's own rhythm" used to mean the injection was never
 * read at all: ordinary visits deliberately skip spotlight injections, and
 * nothing else drained them. These cover the durable queue that closes that
 * gap, end to end through a real visit.
 */

type SimulatedRun = {
	runId: string;
	mode: string;
	spotlightId?: string;
	spotlightContexts: number;
	injections: number;
};

type DeferredHarness = {
	fetch(request: Request): Promise<Response>;
	sql: ReturnType<typeof memoryRuntimeSql>;
	events: BotRuntimeEvent[];
	runs: SimulatedRun[];
	settle(): Promise<void>;
	/** Makes the next simulated visit throw, so the release runs its failure path. */
	failNextRun(message: string): void;
};

function spotlightContext(threadId: string, rootCommentId: string): SpotlightSyntheticContext {
	return {
		kind: "spotlight_context",
		world: { id: "wld_deferred", handle: "w/patch-notes" },
		forum: { id: "frm_deferred", handle: "f/deferred" },
		targetType: "threads",
		threads: [{ id: threadId, threadId, title: lt("Deferred"), rootCommentId }],
		content: [],
	};
}

function deferredHarness(): DeferredHarness {
	const sql = memoryRuntimeSql();
	const events: BotRuntimeEvent[] = [];
	const runs: SimulatedRun[] = [];
	const background: Array<Promise<unknown>> = [];
	let eventSeq = 0;
	let nextRunFailure: string | null = null;
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		activeAbortController: null,
		activeMaintenanceOperation: null,
		activeRunId: null,
		transitionQueue: new ExclusiveOperationQueue(),
		env: {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			BICKR_SIMULATION_MODE: "local",
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
			FORUM_COORDINATOR_SERVICE: {
				fetch: async (request: Request) =>
					handleForumCoordinatorRequest(request, {
						BICKR_D1: testEnv.BICKR_D1,
						BICKR_KV: testEnv.BICKR_KV,
					}),
			},
		},
		state: {
			storage: { sql },
			waitUntil: (promise: Promise<unknown>) => {
				background.push(promise);
			},
			getWebSockets: () => [],
			acceptWebSocket: () => {},
		},
		appendEvent: (runId: string, type: BotRuntimeEvent["type"], payload: unknown) => {
			eventSeq += 1;
			const event = runtimeEvent(eventSeq, runId, type, payload);
			events.push(event);
			return event;
		},
		appendLoopMessage: (runId: string, message: Record<string, unknown>, origin: string) => ({
			seq: eventSeq + 1,
			runId,
			role: message.role,
			message,
			origin,
			tokenEstimate: 0,
			createdAt: new Date().toISOString(),
		}),
		buildMessages: async () => Object.assign([], { deliveredNotificationIds: new Set<string>() }),
		// What the participant says is another subsystem's subject. Standing in
		// for the loop here keeps these tests about which visit reads which
		// injection, and keeps two visits of the same thread from colliding in
		// the local simulation.
		runLocalSimulation: async (
			_bot: unknown,
			runId: string,
			input: { spotlightContexts: unknown[]; injections: unknown[] },
			runContext: { mode: string; spotlightId?: string },
		) => {
			if (nextRunFailure !== null) {
				const message = nextRunFailure;
				nextRunFailure = null;
				throw new Error(message);
			}
			runs.push({
				runId,
				mode: runContext.mode,
				...(runContext.spotlightId ? { spotlightId: runContext.spotlightId } : {}),
				spotlightContexts: input.spotlightContexts.length,
				injections: input.injections.length,
			});
			return { logOffCalled: true, spotlightMutationCount: 0, toolCallCount: 0 };
		},
		compactIfNeeded: async () => {},
		currentIterationStartedSinceLastLogOff: () => true,
		exportRecentProviderUsage: async () => {},
		pruneRuntimeStorageAfterTick: () => {},
		readCommentTreeTokenBudget: async () => 10_000,
	}) as unknown as { fetch(request: Request): Promise<Response> };
	return {
		fetch: (request: Request) => runtime.fetch(request),
		sql,
		events,
		runs,
		failNextRun: (message: string) => {
			nextRunFailure = message;
		},
		settle: async () => {
			// Queued spotlight visits are started through `waitUntil`, so nothing is
			// observable until the object's background work has finished.
			while (background.length > 0) {
				await Promise.all(background.splice(0, background.length));
			}
		},
	};
}

function runtimeRequest(botId: string, path: string, body: unknown): Request {
	return new Request(`https://internal.bickr/bots/${botId}/${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-bickr-scheduler": "1",
			"x-bickr-internal-auth": "test-internal-service-secret",
		},
		body: JSON.stringify(body),
	});
}

async function runPayload(response: Response): Promise<{ runId: string; status: string }> {
	const payload = (await response.json()) as { data: { run: { runId: string; status: string } } };
	return payload.data.run;
}

async function setStandingSchedule(botId: string, nextDueAt: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ? WHERE bot_id = ?`).bind(nextDueAt, botId).run();
}

async function standingSchedule(botId: string): Promise<string | null> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT next_due_at AS nextDueAt FROM bot_runtime_index WHERE bot_id = ?`)
		.bind(botId)
		.first<{ nextDueAt: string | null }>();
	if (!row) {
		throw new Error(`Missing runtime index row for ${botId}.`);
	}
	return row.nextDueAt;
}

async function setLiveSpotlightRun(botId: string, runId: string, leaseExpiresAt: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`UPDATE bot_runtime_index
		 SET status = 'running', active_run_id = ?, active_run_trigger = 'spotlight', lease_expires_at = ?
		 WHERE bot_id = ?`,
	)
		.bind(runId, leaseExpiresAt, botId)
		.run();
}

async function runtimeRunState(botId: string): Promise<Record<string, unknown>> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT enabled, status, active_run_id AS activeRunId, active_run_trigger AS activeRunTrigger,
		        lease_expires_at AS leaseExpiresAt, next_due_at AS nextDueAt
		 FROM bot_runtime_index
		 WHERE bot_id = ?`,
	)
		.bind(botId)
		.first<Record<string, unknown>>();
	if (!row) {
		throw new Error(`Missing runtime index row for ${botId}.`);
	}
	return row;
}

/**
 * The spotlight timer.
 *
 * A spotlight visit interrupts a participant on a human's schedule, so it must
 * leave the participant's own rhythm exactly where it found it — at the claim,
 * which used to push the schedule out to the lease, and at the release, which
 * used to reschedule from completion. These run both kinds of visit end to end
 * over the same row so the difference between them is the assertion.
 */
describe("Spotlight visits and the tick timer", () => {
	// Already due: the participant's own visit is owed and must stay owed.
	const standingDueAt = "2026-08-11T00:00:00.000Z";

	it("leaves the standing schedule alone across a spotlight visit and reschedules after an ordinary one", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-timer");
		const author = await createBotForTest(cookie, "timer-author");
		const participant = await createBotForTest(cookie, "timer-participant", { enabled: true });
		const thread = await createThreadForTest(forum.id, author.id, "Timer thread", "Please look at this.");
		const harness = deferredHarness();
		const spotlightId = "spt_timer";
		await setStandingSchedule(participant.id, standingDueAt);

		const injected = (await (
			await harness.fetch(
				runtimeRequest(participant.id, "inject", {
					text: JSON.stringify(spotlightContext(thread.id, thread.rootCommentId)),
					kind: "spotlight",
					sourceId: spotlightId,
					spotlightId,
				}),
			)
		).json()) as { data: { injectionId: string } };
		const body = { mode: "spotlight", injectionIds: [injected.data.injectionId], spotlightId };

		const spotlight = await runPayload(await harness.fetch(runtimeRequest(participant.id, "tick", body)));
		await harness.settle();

		expect(spotlight.status).toBe("completed");
		expect(harness.runs).toEqual([
			{ runId: spotlight.runId, mode: "spotlight", spotlightId, spotlightContexts: 1, injections: 0 },
		]);
		await expect(standingSchedule(participant.id)).resolves.toBe(standingDueAt);

		// The same request again: the injection is already read, so the visit takes
		// the no-injection early return — which releases the run too.
		const replay = await runPayload(await harness.fetch(runtimeRequest(participant.id, "tick", body)));
		await harness.settle();

		expect(replay.status).toBe("completed");
		expect(harness.runs).toHaveLength(1);
		await expect(standingSchedule(participant.id)).resolves.toBe(standingDueAt);

		// The participant's own visit still moves the schedule on, from its own
		// completion rather than from the schedule it just consumed.
		const natural = await runPayload(await harness.fetch(runtimeRequest(participant.id, "tick", {})));
		await harness.settle();

		expect(natural.status).toBe("completed");
		const rescheduled = await standingSchedule(participant.id);
		expect(rescheduled).not.toBe(standingDueAt);
		expect(Date.parse(rescheduled!)).toBeGreaterThan(Date.now());
	});

	it("leaves the standing schedule alone when a spotlight visit fails", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-timer-failure");
		const author = await createBotForTest(cookie, "timer-failure-author");
		const participant = await createBotForTest(cookie, "timer-failure-participant", { enabled: true });
		const thread = await createThreadForTest(forum.id, author.id, "Timer failure thread", "Please look at this.");
		const harness = deferredHarness();
		const spotlightId = "spt_timer_failure";
		await setStandingSchedule(participant.id, standingDueAt);
		harness.failNextRun("The Bickr page fell over.");

		const injected = (await (
			await harness.fetch(
				runtimeRequest(participant.id, "inject", {
					text: JSON.stringify(spotlightContext(thread.id, thread.rootCommentId)),
					kind: "spotlight",
					sourceId: spotlightId,
					spotlightId,
				}),
			)
		).json()) as { data: { injectionId: string } };

		const spotlight = await runPayload(
			await harness.fetch(
				runtimeRequest(participant.id, "tick", {
					mode: "spotlight",
					injectionIds: [injected.data.injectionId],
					spotlightId,
				}),
			),
		);
		await harness.settle();

		// A failed interruption is not a failure of the participant's own rhythm:
		// where an ordinary failure waits out a lease timeout, this one changes
		// nothing about when the participant visits next.
		expect(spotlight.status).toBe("failed");
		await expect(standingSchedule(participant.id)).resolves.toBe(standingDueAt);
	});

	// Deleting a participant retires the runtime row rather than removing it, so
	// every column describing the run in flight has to go with the run. The
	// trigger is the one the spotlight work added, and leaving it behind would let
	// a row with no run at all still answer "spotlight" to whatever reads it next.
	it("clears a live spotlight run's trigger when the participant is deleted", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const participant = await createBotForTest(cookie, "timer-deleted-participant", { enabled: true });
		await setStandingSchedule(participant.id, standingDueAt);
		await setLiveSpotlightRun(participant.id, "run-deleted-spotlight", "2099-01-01T00:00:00.000Z");

		const response = await deleteBot(
			contextFor<typeof deleteBot>(
				new Request(`http://example.com/api/me/bots/${participant.id}`, { method: "DELETE", headers: { cookie } }),
				{ botId: participant.id },
			),
		);

		expect(response.status, await response.clone().text()).toBe(200);
		await expect(runtimeRunState(participant.id)).resolves.toEqual({
			enabled: 0,
			status: "idle",
			activeRunId: null,
			activeRunTrigger: null,
			leaseExpiresAt: null,
			nextDueAt: null,
		});
	});
});

describe("Deferred spotlight visits", () => {
	it("queues the visit durably and drains it at the participant's next completed visit", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "deferred");
		const author = await createBotForTest(cookie, "deferred-author");
		const participant = await createBotForTest(cookie, "deferred-participant", { enabled: true });
		const thread = await createThreadForTest(forum.id, author.id, "Deferred thread", "Please look at this.");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, participant.id);
		const harness = deferredHarness();
		const spotlightId = "spt_deferred";

		const injected = (await (
			await harness.fetch(
				runtimeRequest(bot.id, "inject", {
					text: JSON.stringify(spotlightContext(thread.id, thread.rootCommentId)),
					kind: "spotlight",
					sourceId: spotlightId,
					spotlightId,
				}),
			)
		).json()) as { data: { injectionId: string } };
		const injectionId = injected.data.injectionId;

		const deferred = await runPayload(
			await harness.fetch(
				runtimeRequest(bot.id, "tick", { mode: "spotlight", injectionIds: [injectionId], spotlightId, deferred: true }),
			),
		);

		// Nothing ran: the request only recorded that a visit is owed.
		expect(deferred).toEqual({ runId: "deferred", status: "queued" });
		expect(harness.events.map((event) => event.type)).toEqual(["thought_injected"]);
		expect(harness.sql.injections()).toEqual([
			expect.objectContaining({ id: injectionId, kind: "spotlight", spotlightId, consumedAt: null }),
		]);

		const natural = await runPayload(await harness.fetch(runtimeRequest(bot.id, "tick", {})));
		expect(natural.status).toBe("completed");
		await harness.settle();

		// The ordinary visit left the spotlight injection alone; the drain that
		// follows it read the injection exactly once, as a spotlight visit.
		expect(harness.runs).toEqual([
			{ runId: natural.runId, mode: "normal", spotlightContexts: 0, injections: 0 },
			{ runId: expect.any(String), mode: "spotlight", spotlightId, spotlightContexts: 1, injections: 0 },
		]);
		expect(harness.sql.injections()).toEqual([
			expect.objectContaining({ id: injectionId, consumedAt: expect.any(String) }),
		]);
		const drainedRunId = harness.runs[1]?.runId;
		expect(
			harness.events.some((event) => event.runId === drainedRunId && event.type === "tick_completed"),
		).toBe(true);

		// A later visit finds nothing owed and starts no second spotlight visit.
		const followUp = await runPayload(await harness.fetch(runtimeRequest(bot.id, "tick", {})));
		expect(followUp.status).toBe("completed");
		await harness.settle();
		expect(harness.runs.filter((run) => run.mode === "spotlight")).toHaveLength(1);
	});

	it("completes without a second visit when a retry re-ticks an injection already read", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "deferred-retick");
		const author = await createBotForTest(cookie, "retick-author");
		const participant = await createBotForTest(cookie, "retick-participant", { enabled: true });
		const thread = await createThreadForTest(forum.id, author.id, "Retick thread", "Look at this.");
		const harness = deferredHarness();
		const spotlightId = "spt_retick";

		const injected = (await (
			await harness.fetch(
				runtimeRequest(participant.id, "inject", {
					text: JSON.stringify(spotlightContext(thread.id, thread.rootCommentId)),
					kind: "spotlight",
					sourceId: spotlightId,
					spotlightId,
				}),
			)
		).json()) as { data: { injectionId: string } };
		const injectionId = injected.data.injectionId;
		const body = { mode: "spotlight", injectionIds: [injectionId], spotlightId };

		expect((await runPayload(await harness.fetch(runtimeRequest(participant.id, "tick", body)))).status).toBe("completed");
		expect(harness.runs).toHaveLength(1);

		// The sender never saw that answer and asks again. The injection is
		// already read, so the visit has nothing to do and says so.
		const retry = await runPayload(await harness.fetch(runtimeRequest(participant.id, "tick", body)));

		expect(retry.status).toBe("completed");
		expect(harness.runs).toHaveLength(1);
	});

	it("refuses to defer a visit that names no injection to read", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const participant = await createBotForTest(cookie, "deferred-empty", { enabled: true });
		const harness = deferredHarness();

		const run = await runPayload(
			await harness.fetch(runtimeRequest(participant.id, "tick", { mode: "spotlight", spotlightId: "spt_empty", deferred: true })),
		);

		expect(run).toMatchObject({ runId: "deferred", status: "failed" });
		expect(harness.events).toEqual([]);
	});

	it("answers a replayed spotlight injection with the injection it already holds", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const participant = await createBotForTest(cookie, "deferred-idempotent", { enabled: true });
		const harness = deferredHarness();
		const body = { text: "Spotlight bytes.", kind: "spotlight", sourceId: "spt_replay", spotlightId: "spt_replay" };

		const first = (await (await harness.fetch(runtimeRequest(participant.id, "inject", body))).json()) as {
			data: { injectionId: string; event?: unknown };
		};
		const second = (await (await harness.fetch(runtimeRequest(participant.id, "inject", body))).json()) as {
			data: { injectionId: string; event?: unknown };
		};

		expect(second.data.injectionId).toBe(first.data.injectionId);
		expect(first.data.event).toBeDefined();
		// The replay is not a second event either: nothing new happened.
		expect(second.data.event).toBeUndefined();
		expect(harness.sql.injections()).toHaveLength(1);
	});
});
