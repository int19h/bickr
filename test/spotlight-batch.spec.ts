import { maxSpotlightSendBots } from "@bickr/shared/model";
import {
	authCookie,
	authCookieFor,
	contextFor,
	createBotForTest,
	createForumForTest,
	createThreadForTest,
	describe,
	expect,
	it,
	jsonRequest,
	seedWorld,
	spotlightSend,
	testEnv,
	type SpotlightSendPayload,
} from "./helpers/index-harness";

/**
 * Batching is what keeps a large spotlight alive: the client sends the same run
 * in consecutive requests, and any one of them may be retried after a response
 * it never saw. These cover the run's identity and the idempotency that makes
 * such a retry safe.
 */

type RuntimeStub = {
	fetcher: Fetcher;
	injects: string[];
	ticks: string[];
};

function runtimeStub(options: { tickFailsFor?: Set<string> } = {}): RuntimeStub {
	const stub: RuntimeStub = { injects: [], ticks: [], fetcher: undefined as unknown as Fetcher };
	stub.fetcher = {
		fetch: async (request: Request) => {
			const path = new URL(request.url).pathname;
			const botId = path.split("/")[2] ?? "";
			if (path.endsWith("/inject")) {
				stub.injects.push(botId);
				return Response.json({ ok: true, data: { injectionId: `inj-${botId}` } });
			}
			stub.ticks.push(botId);
			if (options.tickFailsFor?.has(botId)) {
				return Response.json({ ok: false, error: "server_error", message: "Runtime refused the visit." }, { status: 500 });
			}
			return Response.json({ ok: true, data: { run: { runId: `run-${botId}`, status: "started" } } });
		},
	} as unknown as Fetcher;
	return stub;
}

async function sendSpotlight(cookie: string, body: Record<string, unknown>, runtime: RuntimeStub): Promise<Response> {
	return spotlightSend(
		contextFor<typeof spotlightSend>(
			jsonRequest("http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send", "POST", body, cookie),
			{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			{ AGENT_RUNTIME: runtime.fetcher },
		),
	);
}

async function payloadOf(response: Response): Promise<SpotlightSendPayload["data"]> {
	return ((await response.json()) as SpotlightSendPayload).data;
}

describe("Spotlight batches", () => {
	it("refuses a batch above the per-request participant cap before touching the runtime", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const author = await createBotForTest(cookie, "cap-author", { enabled: true });
		const thread = await createThreadForTest(forum.id, author.id, "Capped", "Body.");
		const botIds = Array.from({ length: maxSpotlightSendBots + 1 }, (_, index) => `bot_over_cap_${index}`);
		const runtime = runtimeStub();

		const response = await sendSpotlight(cookie, { targetType: "threads", threadIds: [thread.id], botIds }, runtime);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ details: { spotlightCause: "too_many_bots" } });
		expect(runtime.injects).toEqual([]);
	});

	it("skips participants an earlier batch already reached, without injecting again", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const first = await createBotForTest(cookie, "batch-first", { enabled: true });
		const second = await createBotForTest(cookie, "batch-second", { enabled: true });
		const thread = await createThreadForTest(forum.id, first.id, "Worth attention", "Root context.");
		const runtime = runtimeStub();

		const opening = await payloadOf(
			await sendSpotlight(cookie, { targetType: "threads", threadIds: [thread.id], botIds: [first.id] }, runtime),
		);
		expect(opening.deliveries).toEqual([{ status: "tick_started", botId: first.id, injectionId: `inj-${first.id}` }]);

		// The client never saw that response and replays the same batch alongside
		// the next participant.
		const replayed = await payloadOf(
			await sendSpotlight(
				cookie,
				{
					targetType: "threads",
					threadIds: [thread.id],
					botIds: [first.id, second.id],
					spotlightId: opening.spotlightId,
				},
				runtime,
			),
		);

		expect(replayed.spotlightId).toBe(opening.spotlightId);
		expect(replayed.deliveries).toEqual([
			{ status: "already_delivered", botId: first.id },
			{ status: "tick_started", botId: second.id, injectionId: `inj-${second.id}` },
		]);
		expect(runtime.injects).toEqual([first.id, second.id]);
		expect(runtime.ticks).toEqual([first.id, second.id]);
		await expect(
			testEnv.BICKR_D1.prepare(`SELECT COUNT(*) AS count FROM spotlight_deliveries WHERE spotlight_id = ?`)
				.bind(opening.spotlightId)
				.first<{ count: number }>(),
		).resolves.toEqual({ count: 2 });
	});

	it("re-starts the visit of a participant whose injection landed but whose visit never did", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const bot = await createBotForTest(cookie, "batch-retick", { enabled: true });
		const thread = await createThreadForTest(forum.id, bot.id, "Worth attention", "Root context.");
		const failing = runtimeStub({ tickFailsFor: new Set([bot.id]) });

		const first = await payloadOf(
			await sendSpotlight(cookie, { targetType: "threads", threadIds: [thread.id], botIds: [bot.id] }, failing),
		);
		expect(first.deliveries).toEqual([
			{
				status: "injected_tick_failed",
				botId: bot.id,
				injectionId: `inj-${bot.id}`,
				message: "Runtime refused the visit.",
			},
		]);

		// The owner retries the participant that stayed selected. The injection is
		// idempotent in the runtime, so the retry costs one more inject call whose
		// answer is the same injection, and this time the visit starts.
		const healthy = runtimeStub();
		const retry = await payloadOf(
			await sendSpotlight(
				cookie,
				{ targetType: "threads", threadIds: [thread.id], botIds: [bot.id], spotlightId: first.spotlightId },
				healthy,
			),
		);

		expect(retry.deliveries).toEqual([{ status: "tick_started", botId: bot.id, injectionId: `inj-${bot.id}` }]);
		expect(healthy.ticks).toEqual([bot.id]);
		await expect(
			testEnv.BICKR_D1.prepare(`SELECT status FROM spotlight_deliveries WHERE spotlight_id = ? AND bot_id = ?`)
				.bind(first.spotlightId, bot.id)
				.first<{ status: string }>(),
		).resolves.toEqual({ status: "tick_started" });
	});

	it("refuses a continuation that changes the run's targets, focus, or owner", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const bot = await createBotForTest(cookie, "batch-immutable", { enabled: true });
		const other = await createBotForTest(cookie, "batch-immutable-two", { enabled: true });
		const thread = await createThreadForTest(forum.id, bot.id, "Worth attention", "Root context.");
		const otherThread = await createThreadForTest(forum.id, bot.id, "Something else", "Other body.");
		const runtime = runtimeStub();

		const opening = await payloadOf(
			await sendSpotlight(
				cookie,
				{ targetType: "threads", threadIds: [thread.id], botIds: [bot.id], focusText: "Look here." },
				runtime,
			),
		);

		const differentTargets = await sendSpotlight(
			cookie,
			{
				targetType: "threads",
				threadIds: [otherThread.id],
				botIds: [other.id],
				focusText: "Look here.",
				spotlightId: opening.spotlightId,
			},
			runtime,
		);
		expect(differentTargets.status).toBe(409);
		expect(await differentTargets.json()).toMatchObject({ details: { spotlightCause: "continuation_mismatch" } });

		const differentFocus = await sendSpotlight(
			cookie,
			{
				targetType: "threads",
				threadIds: [thread.id],
				botIds: [other.id],
				focusText: "Look at something else.",
				spotlightId: opening.spotlightId,
			},
			runtime,
		);
		expect(differentFocus.status).toBe(409);

		const unknownRun = await sendSpotlight(
			cookie,
			{ targetType: "threads", threadIds: [thread.id], botIds: [other.id], focusText: "Look here.", spotlightId: "spt_unknown" },
			runtime,
		);
		expect(unknownRun.status).toBe(409);

		// A second owner cannot extend someone else's run even by guessing its id.
		const intruderCookie = await authCookieFor({ subject: "gh-intruder", login: "intruder", displayName: "Intruder" });
		const intruder = await sendSpotlight(
			intruderCookie,
			{ targetType: "threads", threadIds: [thread.id], botIds: [other.id], focusText: "Look here.", spotlightId: opening.spotlightId },
			runtime,
		);
		expect(intruder.status).toBe(409);

		// Only the opening batch's own participant was ever touched.
		expect(runtime.injects).toEqual([bot.id]);
	});

	it("accepts a continuation whose repeated targets arrive in a different order", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const first = await createBotForTest(cookie, "batch-order-first", { enabled: true });
		const second = await createBotForTest(cookie, "batch-order-second", { enabled: true });
		const one = await createThreadForTest(forum.id, first.id, "First", "Body one.");
		const two = await createThreadForTest(forum.id, first.id, "Second", "Body two.");
		const runtime = runtimeStub();

		const opening = await payloadOf(
			await sendSpotlight(cookie, { targetType: "threads", threadIds: [one.id, two.id], botIds: [first.id] }, runtime),
		);
		const continued = await sendSpotlight(
			cookie,
			{ targetType: "threads", threadIds: [two.id, one.id], botIds: [second.id], spotlightId: opening.spotlightId },
			runtime,
		);

		expect(continued.status).toBe(200);
		expect((await payloadOf(continued)).deliveries).toEqual([
			{ status: "tick_started", botId: second.id, injectionId: `inj-${second.id}` },
		]);
	});
});
