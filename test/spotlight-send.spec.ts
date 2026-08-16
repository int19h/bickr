import {
	authCookie,
	contextFor,
	createBot,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	createWorld,
	describe,
	expect,
	it,
	jsonRequest,
	kvKeys,
	readThread,
	seedWorld,
	spotlightSend,
	testEnv,
	type BotBody,
	type SpotlightSendPayload,
} from "./helpers/index-harness";

/**
 * The spotlight send route's delivery contract: what each participant's own
 * unit does, and how one participant's problem is kept away from its siblings.
 * Batch continuation and idempotency live in `spotlight-batch.spec.ts`.
 */

type RuntimeStub = {
	fetcher: Fetcher;
	paths: string[];
	injectedTexts: string[];
	tickBodies: Array<Record<string, unknown>>;
};

function runtimeStub(
	options: {
		injectionId?: string;
		tickStatus?: string;
		injectFails?: (botId: string) => string | null;
		tickFails?: (botId: string) => string | null;
	} = {},
): RuntimeStub {
	const stub: RuntimeStub = {
		paths: [],
		injectedTexts: [],
		tickBodies: [],
		fetcher: undefined as unknown as Fetcher,
	};
	stub.fetcher = {
		fetch: async (request: Request) => {
			const path = new URL(request.url).pathname;
			stub.paths.push(path);
			const botId = path.split("/")[2] ?? "";
			const body = (await request.json()) as Record<string, unknown>;
			if (path.endsWith("/inject")) {
				const failure = options.injectFails?.(botId) ?? null;
				if (failure) {
					return Response.json({ ok: false, error: "server_error", message: failure }, { status: 500 });
				}
				stub.injectedTexts.push(typeof body.text === "string" ? body.text : "");
				return Response.json({ ok: true, data: { injectionId: options.injectionId ?? `inj-${botId}` } });
			}
			stub.tickBodies.push(body);
			const failure = options.tickFails?.(botId) ?? null;
			if (failure) {
				return Response.json({ ok: false, error: "server_error", message: failure }, { status: 500 });
			}
			// Mirrors the runtime: a deferred visit is queued rather than started.
			const status = options.tickStatus ?? (body.deferred === true ? "queued" : "started");
			return Response.json({ ok: true, data: { run: { runId: `run-${botId}`, status } } });
		},
	} as unknown as Fetcher;
	return stub;
}

async function sendSpotlight(
	cookie: string,
	body: Record<string, unknown>,
	overrides: Partial<{ AGENT_RUNTIME: Fetcher; BICKR_KV: KVNamespace }> = {},
): Promise<Response> {
	return spotlightSend(
		contextFor<typeof spotlightSend>(
			jsonRequest("http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send", "POST", body, cookie),
			{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			overrides,
		),
	);
}

async function deliveryRow(spotlightId: string, botId: string) {
	return testEnv.BICKR_D1.prepare(
		`SELECT status, error_message AS errorMessage, target_type AS targetType, target_ids_json AS targetIdsJson, focus_text AS focusText
		 FROM spotlight_deliveries
		 WHERE spotlight_id = ? AND bot_id = ?`,
	)
		.bind(spotlightId, botId)
		.first<{ status: string; errorMessage: string | null; targetType: string; targetIdsJson: string; focusText: string | null }>();
}

describe("Spotlight send", () => {
	it("injects the unseen content each participant needs and starts its visit", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const botOne = await createBotForTest(cookie, "spot-one", { enabled: true });
		const botTwo = await createBotForTest(cookie, "spot-two", { enabled: true });
		const thread = await createThreadForTest(forum.id, botOne.id, "Worth attention", "Root context.");
		const parent = await createCommentForTest(thread.id, botTwo.id, "Parent context.");
		const child = await createCommentForTest(thread.id, botOne.id, "Deep child comment.", parent.id);
		const unrelated = await createCommentForTest(thread.id, botTwo.id, "Unrelated seen branch.");
		const now = new Date().toISOString();

		for (const comment of [child, unrelated]) {
			await testEnv.BICKR_D1.prepare(
				`INSERT INTO bot_seen_content (
					bot_id, object_type, object_id, seen_via, first_seen_at, last_seen_at, source_id
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(botOne.id, "comment", comment.id, "test", now, now, "seed")
				.run();
		}

		const threadRuntime = runtimeStub();
		const threadResponse = await sendSpotlight(
			cookie,
			{ targetType: "threads", threadIds: [thread.id], botIds: [botOne.id], autoStartTick: false },
			{ AGENT_RUNTIME: threadRuntime.fetcher },
		);
		const threadPayload = (await threadResponse.json()) as SpotlightSendPayload;
		expect(threadPayload.data.spotlightId).toMatch(/^spt_/);
		expect(threadPayload.data.deliveries).toEqual([
			{ status: "tick_pending", botId: botOne.id, injectionId: `inj-${botOne.id}`, reason: "deferred" },
		]);
		// Content the participant has already seen is left out, and the ancestors
		// of what is left are kept so the injected chain still reads.
		const threadContext = JSON.parse(threadRuntime.injectedTexts[0] ?? "") as { content: Array<Record<string, unknown>> };
		expect(threadContext.content.map((item) => item.id)).toEqual([thread.rootCommentId, parent.id]);
		expect(threadRuntime.injectedTexts[0]).toContain("Spot Two test bot.");
		expect(threadRuntime.injectedTexts[0]).not.toMatch(/\bowner\b/i);
		expect(threadRuntime.tickBodies).toEqual([
			{ mode: "spotlight", injectionIds: [`inj-${botOne.id}`], spotlightId: threadPayload.data.spotlightId, deferred: true },
		]);

		const commentRuntime = runtimeStub();
		const commentResponse = await sendSpotlight(
			cookie,
			{
				targetType: "comments",
				threadId: thread.id,
				commentIds: [child.id],
				botIds: [botOne.id],
				focusText: "Please consider replying.",
			},
			{ AGENT_RUNTIME: commentRuntime.fetcher },
		);
		const commentPayload = (await commentResponse.json()) as SpotlightSendPayload;
		expect(commentPayload.data.deliveries).toEqual([
			{ status: "tick_started", botId: botOne.id, injectionId: `inj-${botOne.id}` },
		]);
		expect(commentRuntime.paths).toEqual([`/bots/${botOne.id}/inject`, `/bots/${botOne.id}/tick`]);
		expect(commentRuntime.tickBodies[0]).toMatchObject({ background: true });
		expect(commentRuntime.tickBodies[0]).not.toHaveProperty("deferred");
		const commentContext = JSON.parse(commentRuntime.injectedTexts[0] ?? "") as {
			kind: string;
			targetType: string;
			focus: string;
			content: Array<Record<string, unknown>>;
		};
		expect(commentContext).toMatchObject({
			kind: "spotlight_context",
			targetType: "comments",
			focus: "Please consider replying.",
		});
		expect(commentContext.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: thread.rootCommentId, threadId: thread.id, type: "comment", ancestorOnly: true }),
				expect.objectContaining({ id: parent.id, threadId: thread.id, ancestorOnly: true }),
				expect.objectContaining({ id: child.id, parentCommentId: parent.id, "My focus is on this comment": true }),
			]),
		);

		await expect(deliveryRow(commentPayload.data.spotlightId, botOne.id)).resolves.toMatchObject({
			status: "tick_started",
			errorMessage: null,
			targetType: "comments",
			targetIdsJson: JSON.stringify([child.id]),
			focusText: "Please consider replying.",
		});
		await expect(
			testEnv.BICKR_D1.prepare(
				`SELECT seen_via AS seenVia FROM bot_seen_content WHERE bot_id = ? AND object_type = 'comment' AND object_id = ?`,
			)
				.bind(botOne.id, child.id)
				.first<{ seenVia: string }>(),
		).resolves.toEqual({ seenVia: "spotlight" });
		// The authors whose bios were pulled into the injected context count as
		// seen too, or the participant would be re-shown them at its next visit.
		await expect(
			testEnv.BICKR_D1.prepare(
				`SELECT seen_via AS seenVia FROM bot_seen_content WHERE bot_id = ? AND object_type = 'bot' AND object_id = ?`,
			)
				.bind(botOne.id, botTwo.id)
				.first<{ seenVia: string }>(),
		).resolves.toEqual({ seenVia: "spotlight" });
	});

	it("reports a busy participant's queued visit distinctly from a deferred one", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const bot = await createBotForTest(cookie, "spot-busy", { enabled: true });
		const thread = await createThreadForTest(forum.id, bot.id, "Busy", "Body.");
		const runtime = runtimeStub({ tickStatus: "queued" });

		const response = await sendSpotlight(
			cookie,
			{ targetType: "threads", threadIds: [thread.id], botIds: [bot.id] },
			{ AGENT_RUNTIME: runtime.fetcher },
		);

		const payload = (await response.json()) as SpotlightSendPayload;
		expect(payload.data.deliveries).toEqual([
			{ status: "tick_pending", botId: bot.id, injectionId: `inj-${bot.id}`, reason: "queued_behind_run" },
		]);
	});

	it("rejects participants the sender does not own or that live in another world", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const bot = await createBotForTest(cookie, "spot-owned", { enabled: true });
		const thread = await createThreadForTest(forum.id, bot.id, "Worth attention", "Root context.");
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "other-world", name: "Other World", description: "Elsewhere" },
					cookie,
				),
			),
		);
		const otherWorldResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/other-world/bots",
					"POST",
					{ handle: "elsewhere", displayName: "Elsewhere", shortBio: "Lives elsewhere.", prompt: "Stay elsewhere." },
					cookie,
				),
				{ worldHandle: "other-world" },
			),
		);
		const otherWorldBot = ((await otherWorldResponse.json()) as { data: { bot: BotBody } }).data.bot;

		const runtime = runtimeStub();
		const wrongWorld = await sendSpotlight(
			cookie,
			{ targetType: "threads", threadIds: [thread.id], botIds: [otherWorldBot.id] },
			{ AGENT_RUNTIME: runtime.fetcher },
		);
		expect(wrongWorld.status).toBe(403);
		expect(await wrongWorld.json()).toMatchObject({ details: { spotlightCause: "bot_outside_world" } });

		const notOwned = await sendSpotlight(
			cookie,
			{ targetType: "threads", threadIds: [thread.id], botIds: ["bot_not_yours"] },
			{ AGENT_RUNTIME: runtime.fetcher },
		);
		expect(notOwned.status).toBe(403);
		expect(await notOwned.json()).toMatchObject({ details: { spotlightCause: "bot_not_owned" } });
		expect(runtime.paths).toEqual([]);
	});

	it("keeps a paused participant, a failed injection, and a failed visit from costing their siblings", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const healthy = await createBotForTest(cookie, "spot-healthy", { enabled: true });
		const injectFailure = await createBotForTest(cookie, "spot-inject-fails", { enabled: true });
		const tickFailure = await createBotForTest(cookie, "spot-tick-fails", { enabled: true });
		const paused = await createBotForTest(cookie, "spot-paused", { enabled: false });
		const thread = await createThreadForTest(forum.id, healthy.id, "Worth attention", "Root context.");
		const runtime = runtimeStub({
			injectFails: (botId) => (botId === injectFailure.id ? "Runtime refused the injection." : null),
			tickFails: (botId) => (botId === tickFailure.id ? "Runtime refused the visit." : null),
		});

		const response = await sendSpotlight(
			cookie,
			{
				targetType: "threads",
				threadIds: [thread.id],
				botIds: [healthy.id, injectFailure.id, tickFailure.id, paused.id],
			},
			{ AGENT_RUNTIME: runtime.fetcher },
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as SpotlightSendPayload;
		// Results come back in the order the request listed its participants, so a
		// client can line them up against its own selection without matching ids.
		expect(payload.data.deliveries).toEqual([
			{ status: "tick_started", botId: healthy.id, injectionId: `inj-${healthy.id}` },
			{
				status: "not_injected",
				botId: injectFailure.id,
				cause: "inject_error",
				message: "Runtime refused the injection.",
			},
			{
				status: "injected_tick_failed",
				botId: tickFailure.id,
				injectionId: `inj-${tickFailure.id}`,
				message: "Runtime refused the visit.",
			},
			{
				status: "not_injected",
				botId: paused.id,
				cause: "paused",
				message: "This participant is paused, so it cannot receive a spotlight.",
			},
		]);
		// The healthy participant's visit started even though a sibling failed
		// first in the same batch.
		expect(runtime.paths).toContain(`/bots/${healthy.id}/tick`);
		expect(runtime.paths).not.toContain(`/bots/${paused.id}/inject`);
		await expect(deliveryRow(payload.data.spotlightId, paused.id)).resolves.toMatchObject({ status: "not_injected" });
		await expect(deliveryRow(payload.data.spotlightId, tickFailure.id)).resolves.toMatchObject({
			status: "injected_tick_failed",
			errorMessage: "Runtime refused the visit.",
		});
	});

	it("retries a plan built from a KV replica that has not caught up, without injecting twice", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const bot = await createBotForTest(cookie, "spot-stale", { enabled: true });
		const thread = await createThreadForTest(forum.id, bot.id, "Worth attention", "Root context.");
		const comment = await createCommentForTest(thread.id, bot.id, "Just written.");
		const freshThread = await readThread(testEnv.BICKR_KV, thread.id);
		const staleThread = {
			...freshThread,
			comments: freshThread.comments.filter((item) => item.id !== comment.id),
		};
		const fallbackGet = testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV);
		let staleThreadReads = 0;
		const flakyKv = new Proxy(testEnv.BICKR_KV, {
			get(target, property, receiver) {
				if (property === "get") {
					return (async (key: string, options?: { type?: string }) => {
						if (key === kvKeys.thread(thread.id) && options?.type === "json" && staleThreadReads === 0) {
							staleThreadReads += 1;
							return staleThread;
						}
						return fallbackGet(key, options as never) as never;
					}) as KVNamespace["get"];
				}
				return Reflect.get(target, property, receiver) as unknown;
			},
		}) as KVNamespace;
		const runtime = runtimeStub();

		const response = await sendSpotlight(
			cookie,
			{ targetType: "comments", threadId: thread.id, commentIds: [comment.id], botIds: [bot.id], autoStartTick: false },
			{ AGENT_RUNTIME: runtime.fetcher, BICKR_KV: flakyKv },
		);

		expect(response.status).toBe(200);
		expect(staleThreadReads).toBe(1);
		expect(runtime.injectedTexts).toHaveLength(1);
		const payload = (await response.json()) as SpotlightSendPayload;
		expect(payload.data.deliveries).toEqual([
			{ status: "tick_pending", botId: bot.id, injectionId: `inj-${bot.id}`, reason: "deferred" },
		]);
	});
});
