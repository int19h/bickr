import {
	authCookie,
	botById,
	BotRuntime,
	createBotForTest,
	createForumForTest,
	createThreadForTest,
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
