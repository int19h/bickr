import { bootstrapNotificationId } from "../packages/shared/src/social";
import { backfillBootstrapNotifiedMigration } from "./helpers/d1-schema";
import {
	authCookie,
	botById,
	createBotForTest,
	describe,
	ensureBootstrapNotification,
	expect,
	it,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";

const earlyBootstrapAt = "2026-03-01T00:00:00.000Z";
const lateBootstrapAt = "2026-04-01T00:00:00.000Z";
const now = "2026-08-17T00:00:00.000Z";
const later = "2026-08-18T00:00:00.000Z";

describe("bootstrap_notified_at backfill", () => {
	it("stamps only bots holding a bootstrap row, with that row's own created_at", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bootstrapped = await createBotForTest(cookie, "already-bootstrapped");
		const neverTicked = await createBotForTest(cookie, "never-ticked");
		// Two rows for the same bot: a re-bootstrap caused by the pruned-row bug
		// this column exists to end. The earliest is the accurate fact.
		await insertNotification({ id: "ntf_late", botId: bootstrapped.id, type: "bootstrap", createdAt: lateBootstrapAt });
		await insertNotification({ id: "ntf_early", botId: bootstrapped.id, type: "bootstrap", createdAt: earlyBootstrapAt });
		await insertNotification({ id: "ntf_reply", botId: neverTicked.id, type: "reply", createdAt: earlyBootstrapAt });

		expect(await bootstrapFlags()).toEqual([
			{ botId: bootstrapped.id, bootstrapNotifiedAt: null },
			{ botId: neverTicked.id, bootstrapNotifiedAt: null },
		]);

		await backfillBootstrapNotifiedMigration(testEnv.BICKR_D1);
		const backfilled = await bootstrapFlags();
		await backfillBootstrapNotifiedMigration(testEnv.BICKR_D1);

		expect(backfilled).toEqual([
			{ botId: bootstrapped.id, bootstrapNotifiedAt: earlyBootstrapAt },
			// A bot that never ticked keeps NULL and is still owed its bootstrap.
			{ botId: neverTicked.id, bootstrapNotifiedAt: null },
		]);
		expect(await bootstrapFlags()).toEqual(backfilled);
	});

	it("bootstraps a backfilled bot never again, and a never-ticked bot exactly once", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bootstrapped = await createBotForTest(cookie, "already-bootstrapped");
		const neverTicked = await createBotForTest(cookie, "never-ticked");
		await insertNotification({ id: "ntf_early", botId: bootstrapped.id, type: "bootstrap", createdAt: earlyBootstrapAt });
		await backfillBootstrapNotifiedMigration(testEnv.BICKR_D1);

		// The backfilled bot's row is then pruned, which used to re-bootstrap it.
		await testEnv.BICKR_D1.prepare(`DELETE FROM notifications WHERE notification_id = ?`).bind("ntf_early").run();
		await ensureBootstrapNotification(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bootstrapped.id),
			now,
		);

		expect(await bootstrapRowIds(bootstrapped.id)).toEqual([]);

		const fresh = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, neverTicked.id);
		await ensureBootstrapNotification(testEnv.BICKR_KV, testEnv.BICKR_D1, fresh, now);
		await ensureBootstrapNotification(testEnv.BICKR_KV, testEnv.BICKR_D1, fresh, later);

		expect(await bootstrapRowIds(neverTicked.id)).toEqual([await bootstrapNotificationId(neverTicked.id)]);
		expect(await bootstrapFlag(neverTicked.id)).toBe(now);
	});

	it("adopts a bootstrap row created during the deploy window, when the flag is still NULL", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "deploy-window");
		// The migration ran, then old code bootstrapped this bot before the new
		// worker activated: a bootstrap row with no flag.
		await insertNotification({ id: "ntf_window", botId: bot.id, type: "bootstrap", createdAt: lateBootstrapAt });

		await ensureBootstrapNotification(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id),
			now,
		);

		expect(await bootstrapRowIds(bot.id)).toEqual(["ntf_window"]);
		expect(await bootstrapFlag(bot.id)).toBe(lateBootstrapAt);
	});
});

async function insertNotification(input: { id: string; botId: string; type: string; createdAt: string }): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO notifications (
			notification_id, world_id, bot_id, type, source_object_id, status, message, message_lang,
			created_at, delivered_at, read_at
		) VALUES (?, ?, ?, ?, NULL, 'pending', ?, NULL, ?, NULL, NULL)`,
	)
		.bind(input.id, "wld_backfill", input.botId, input.type, `Notification ${input.id}`, input.createdAt)
		.run();
}

async function bootstrapFlags(): Promise<Array<{ botId: string; bootstrapNotifiedAt: string | null }>> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT bot_id AS botId, bootstrap_notified_at AS bootstrapNotifiedAt
		 FROM bots_index
		 ORDER BY handle`,
	).all<{ botId: string; bootstrapNotifiedAt: string | null }>();
	return result.results ?? [];
}

async function bootstrapFlag(botId: string): Promise<string | null> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT bootstrap_notified_at AS bootstrapNotifiedAt FROM bots_index WHERE bot_id = ?`,
	)
		.bind(botId)
		.first<{ bootstrapNotifiedAt: string | null }>();
	return row?.bootstrapNotifiedAt ?? null;
}

async function bootstrapRowIds(botId: string): Promise<string[]> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT notification_id AS id
		 FROM notifications
		 WHERE bot_id = ? AND type = 'bootstrap'
		 ORDER BY created_at`,
	)
		.bind(botId)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}
