import { describe, expect, it } from "vitest";
import { maxSpreadBotTickIds } from "@bickr/shared/validation";
import { planBotTickSpread, type TickSpreadInput } from "../packages/shared/src/tick-spread";
import {
	authCookie,
	authCookieFor,
	contextFor,
	createBot,
	createBotInWorld,
	createWorldForTest,
	deleteBot,
	handleAgentRuntimeRequest,
	jsonRequest,
	seedWorld,
	testEnv,
	userIdForHandle,
} from "./helpers/index-harness";
import type { BotBody } from "./helpers/index-harness";

const now = new Date("2026-05-21T12:00:00.000Z");

function row(botId: string, intervalSeconds: number, nextDueAt: string): TickSpreadInput {
	return {
		botId,
		handle: botId,
		intervalSeconds,
		nextDueAt,
	};
}

function dueSeconds(nextDueAt: string): number {
	return (Date.parse(nextDueAt) - now.getTime()) / 1000;
}

describe("bot tick spread planning", () => {
	it("handles empty and single-bot schedules deterministically", () => {
		expect(planBotTickSpread([], now)).toEqual({
			horizonSeconds: 0,
			scheduled: [],
			usedApproximateHorizon: false,
		});

		const single = planBotTickSpread([row("bot-a", 300, "2026-05-21T12:10:00.000Z")], now);
		expect(single).toMatchObject({
			anchorBotId: "bot-a",
			exactHyperperiodSeconds: 300,
			usedApproximateHorizon: false,
			scheduled: [{ botId: "bot-a", offsetSeconds: 0, orderRelaxed: false }],
		});
		expect(single.scheduled[0]?.nextDueAt).toBe(now.toISOString());
	});

	it("spreads equal intervals evenly while preserving original due order", () => {
		const plan = planBotTickSpread([
			row("bot-a", 60, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 60, "2026-05-21T12:00:02.000Z"),
			row("bot-c", 60, "2026-05-21T12:00:03.000Z"),
			row("bot-d", 60, "2026-05-21T12:00:04.000Z"),
		], now);

		expect(plan.scheduled.map((schedule) => schedule.botId)).toEqual(["bot-a", "bot-b", "bot-c", "bot-d"]);
		expect(plan.scheduled.map((schedule) => schedule.offsetSeconds)).toEqual([0, 15, 30, 45]);
		expect(plan.scheduled.every((schedule) => !schedule.orderRelaxed)).toBe(true);
	});

	it("moves mixed-period bots away from the anchor instead of stacking every first run", () => {
		const plan = planBotTickSpread([
			row("bot-a", 60, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 120, "2026-05-21T12:00:02.000Z"),
			row("bot-c", 90, "2026-05-21T12:00:03.000Z"),
		], now);

		expect(plan.scheduled[0]).toMatchObject({ botId: "bot-a", offsetSeconds: 0 });
		expect(plan.scheduled.slice(1).every((schedule) => schedule.offsetSeconds > 0)).toBe(true);
		expect(new Set(plan.scheduled.map((schedule) => schedule.offsetSeconds)).size).toBeGreaterThan(1);
	});

	it("marks order relaxation when a shorter period cannot run after the previous first-run offset", () => {
		const plan = planBotTickSpread([
			row("bot-a", 100, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 100, "2026-05-21T12:00:02.000Z"),
			row("bot-c", 30, "2026-05-21T12:00:03.000Z"),
		], now);

		expect(plan.scheduled.map((schedule) => schedule.botId)).toEqual(["bot-a", "bot-b", "bot-c"]);
		expect(plan.scheduled[2]?.orderRelaxed).toBe(true);
		expect(plan.scheduled[2]?.offsetSeconds).toBeLessThan(30);
	});

	it("uses a bounded approximation when the exact hyperperiod is impractical", () => {
		const plan = planBotTickSpread([
			row("bot-a", 86_399, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 86_389, "2026-05-21T12:00:02.000Z"),
		], now);

		expect(plan.usedApproximateHorizon).toBe(true);
		expect(plan.exactHyperperiodSeconds).toBeUndefined();
		expect(plan.horizonSeconds).toBeGreaterThan(0);
		expect(plan.horizonSeconds).toBeLessThanOrEqual(604_800);
	});

	it("sets due timestamps from the selected offsets", () => {
		const plan = planBotTickSpread([
			row("bot-a", 60, "2026-05-21T12:00:01.000Z"),
			row("bot-b", 60, "2026-05-21T12:00:02.000Z"),
		], now);

		expect(plan.scheduled.map((schedule) => dueSeconds(schedule.nextDueAt))).toEqual([0, 30]);
	});
});

type SpreadRuntimeRow = {
	botId: string;
	enabled: number;
	status: string;
	nextDueAt: string | null;
	updatedAt: string;
};

async function createScheduledBot(cookie: string, handle: string, intervalSeconds = 60, enabled = true): Promise<BotBody> {
	const response = await createBot(
		contextFor<typeof createBot>(
			jsonRequest(
				"http://example.com/api/worlds/patch-notes/bots",
				"POST",
				{
					handle,
					displayName: handle,
					shortBio: `${handle} bot.`,
					prompt: `You are ${handle}.`,
					tickSettings: { enabled, intervalSeconds },
				},
				cookie,
			),
			{ worldHandle: "patch-notes" },
		),
	);
	expect(response.status, await response.clone().text()).toBe(201);
	const payload = (await response.json()) as { data: { bot: BotBody } };
	return payload.data.bot;
}

async function postSpread(userId: string, body?: unknown): Promise<Response> {
	const headers = new Headers({ "x-bickr-user-id": userId });
	const init: RequestInit = { method: "POST", headers };
	if (body !== undefined) {
		headers.set("content-type", "application/json");
		init.body = JSON.stringify(body);
	}
	return handleAgentRuntimeRequest(
		new Request(`https://internal.bickr/users/${encodeURIComponent(userId)}/bots/spread-ticks`, init),
		{ BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV },
	);
}

async function spreadRuntimeRow(botId: string): Promise<SpreadRuntimeRow> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT bot_id AS botId, enabled, status, next_due_at AS nextDueAt, updated_at AS updatedAt
		 FROM bot_runtime_index WHERE bot_id = ?`,
	).bind(botId).first<SpreadRuntimeRow>();
	expect(row).not.toBeNull();
	return row!;
}

describe("selected bot tick spread routes", () => {
	it("plans only checked bots, skips selected paused and running bots, and spreads duplicates once", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		const anchor = await createScheduledBot(cookie, "spread-anchor", 120);
		const unchecked = await createScheduledBot(cookie, "spread-unchecked", 30);
		const later = await createScheduledBot(cookie, "spread-later", 60);
		const running = await createScheduledBot(cookie, "spread-running", 90);
		const paused = await createScheduledBot(cookie, "spread-paused", 60, false);
		const uncheckedPaused = await createScheduledBot(cookie, "spread-unchecked-paused", 60, false);
		const anchorDue = "2026-05-21T12:01:00.000Z";
		const uncheckedDue = "2026-05-21T12:00:00.000Z";
		const laterDue = "2026-05-21T12:05:00.000Z";
		const runningDue = "2026-05-21T12:00:10.000Z";
		const updatedAt = "2026-05-21T11:59:00.000Z";
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind(anchorDue, updatedAt, anchor.id),
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind(uncheckedDue, updatedAt, unchecked.id),
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind(laterDue, updatedAt, later.id),
			testEnv.BICKR_D1.prepare(
				`UPDATE bot_runtime_index
				 SET status = 'running', active_run_id = 'run-spread-test', lease_expires_at = ?, next_due_at = ?, updated_at = ?
				 WHERE bot_id = ?`,
			).bind("2026-05-21T12:30:00.000Z", runningDue, updatedAt, running.id),
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET updated_at = ? WHERE bot_id IN (?, ?)`)
				.bind(updatedAt, paused.id, uncheckedPaused.id),
		]);

		const before = Date.now();
		const response = await postSpread(userId, {
			botIds: [` ${anchor.id} `, running.id, paused.id, later.id, anchor.id],
		});
		const after = Date.now();
		expect(response.status, await response.clone().text()).toBe(200);
		const payload = (await response.json()) as {
			data: {
				spread: {
					anchorBotId?: string;
					bots: Array<BotBody & { running?: boolean }>;
					scheduled: Array<{ botId: string; nextDueAt: string; offsetSeconds: number; orderRelaxed: boolean }>;
					skipped: { paused: number; running: number };
				};
			};
		};
		const spread = payload.data.spread;
		const expected = planBotTickSpread([
			row(anchor.id, 120, anchorDue),
			row(later.id, 60, laterDue),
		], now);
		expect(spread.anchorBotId).toBe(anchor.id);
		expect(spread.scheduled.map(({ botId, offsetSeconds }) => ({ botId, offsetSeconds })))
			.toEqual(expected.scheduled.map(({ botId, offsetSeconds }) => ({ botId, offsetSeconds })));
		expect(spread.scheduled).toHaveLength(2);
		expect(spread.skipped).toEqual({ paused: 1, running: 1 });
		expect(spread.bots).toHaveLength(6);
		expect(spread.bots.find((bot) => bot.id === running.id)?.running).toBe(true);
		expect(spread.bots.find((bot) => bot.id === unchecked.id)?.running).toBe(false);

		const rows = await testEnv.BICKR_D1.prepare(
			`SELECT bot_id AS botId, enabled, status, next_due_at AS nextDueAt, updated_at AS updatedAt
			 FROM bot_runtime_index WHERE bot_id IN (?, ?, ?, ?, ?, ?)`,
		).bind(anchor.id, unchecked.id, later.id, running.id, paused.id, uncheckedPaused.id)
			.all<SpreadRuntimeRow>();
		const byId = new Map((rows.results ?? []).map((entry) => [entry.botId, entry]));
		const anchorDueMs = Date.parse(byId.get(anchor.id)?.nextDueAt ?? "");
		expect(anchorDueMs).toBeGreaterThanOrEqual(before - 1_000);
		expect(anchorDueMs).toBeLessThanOrEqual(after + 1_000);
		expect(byId.get(unchecked.id)).toMatchObject({ nextDueAt: uncheckedDue, updatedAt });
		expect(byId.get(running.id)).toMatchObject({ enabled: 1, status: "running", nextDueAt: runningDue, updatedAt });
		expect(byId.get(paused.id)).toMatchObject({ enabled: 0, nextDueAt: null, updatedAt });
		expect(byId.get(uncheckedPaused.id)).toMatchObject({ enabled: 0, nextDueAt: null, updatedAt });
		expect(spread.bots.find((bot) => bot.id === anchor.id)?.nextDueAt).toBe(byId.get(anchor.id)?.nextDueAt);
	});

	it("rejects missing and malformed selections with 400 without changing schedules", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		const selected = await createScheduledBot(cookie, "spread-validation");
		const before = await spreadRuntimeRow(selected.id);
		const invalidBodies: unknown[] = [
			undefined,
			{},
			{ botIds: [] },
			{ botIds: [selected.id, 42] },
			{ botIds: [" "] },
			{ botIds: ["x".repeat(81)] },
			{ botIds: Array.from({ length: maxSpreadBotTickIds + 1 }, (_, index) => `bot-${index}`) },
		];

		for (const body of invalidBodies) {
			const response = await postSpread(userId, body);
			expect(response.status, await response.clone().text()).toBe(400);
			expect(await spreadRuntimeRow(selected.id)).toEqual(before);
		}
	});

	it("rejects another owner's, deleted, and unknown IDs with 404 without spreading valid IDs", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		const selected = await createScheduledBot(cookie, "spread-valid");
		const deleted = await createScheduledBot(cookie, "spread-deleted");
		const otherCookie = await authCookieFor({ subject: "spread-other", login: "spread-other", displayName: "Spread Other" });
		await createWorldForTest(otherCookie, "spread-other-world", "Spread Other World");
		const other = await createBotInWorld(otherCookie, "spread-other-world", { handle: "other-spread-bot" });
		const deleteResponse = await deleteBot(
			contextFor<typeof deleteBot>(
				new Request(`http://example.com/api/me/bots/${deleted.id}`, { method: "DELETE", headers: { cookie } }),
				{ botId: deleted.id },
			),
		);
		expect(deleteResponse.status).toBe(200);
		const before = await spreadRuntimeRow(selected.id);

		for (const invalidId of [other.id, deleted.id, "bot-unknown"]) {
			const response = await postSpread(userId, { botIds: [selected.id, invalidId] });
			expect(response.status, await response.clone().text()).toBe(404);
			expect(await spreadRuntimeRow(selected.id)).toEqual(before);
		}
	});

	it("spreads more than 100 selected bots with one JSON-bound ID list", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		const bots: BotBody[] = [];
		for (let index = 0; index < 101; index += 1) {
			bots.push(await createScheduledBot(cookie, `spread-many-${index}`));
		}

		const response = await postSpread(userId, { botIds: bots.map((bot) => bot.id) });
		expect(response.status, await response.clone().text()).toBe(200);
		const payload = (await response.json()) as { data: { spread: { bots: BotBody[]; scheduled: Array<{ botId: string }> } } };
		expect(payload.data.spread.scheduled).toHaveLength(101);
		expect(new Set(payload.data.spread.scheduled.map((entry) => entry.botId))).toHaveLength(101);
		expect(payload.data.spread.bots).toHaveLength(101);
	}, 120_000);
});
