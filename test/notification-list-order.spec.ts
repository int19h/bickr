import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	listHumanNotifications,
	markAllHumanNotificationsRead,
} from "@bickr/shared/social";
import type { HumanNotificationReadAnchor, HumanNotificationReadScope } from "@bickr/shared/model";
import type { D1DatabaseLike } from "@bickr/shared/storage";
import { resetD1Schema } from "./helpers/d1-schema";

/**
 * The mark-all anchor is "the newest notification the caller had rendered", and
 * the sweep marks everything at or below it in `(created_at, notification_id)`.
 * That only means anything if the list the caller rendered is read in the same
 * order — with `created_at DESC` alone, the order inside a tie is whatever the
 * plan produces, and `created_at` ties are routine: one bot fan-out writes
 * several rows in the same millisecond.
 *
 * These run against real D1 rather than a fake, because the ordering under test
 * is SQLite's, not a hand-written comparator's, and because the sweep and the
 * list have to agree on the same rows in the same database. The rows are
 * inserted in an order that matches neither the total order nor its reverse, so
 * nothing here is satisfied by insertion order.
 *
 * A planner is free to hand back the right order for the wrong reason — the
 * keyset index alone can produce it — so that the ORDER BY is actually asked for
 * is asserted from the statement text in `packages/shared/src/social.test.ts`.
 */

const userId = "usr_order";
const tieAt = "2026-05-06T12:00:00.000Z";
const olderAt = "2026-05-06T11:59:00.000Z";
const newerAt = "2026-05-06T12:00:01.000Z";
const readAt = "2026-05-06T12:00:02.000Z";

type Fixture = { id: string; worldId: string; botId: string; createdAt: string };

/**
 * Five of these share `tieAt`. Worlds and bots alternate through the tie so a
 * scoped sweep has rows on both sides of the anchor inside the same second.
 */
const fixtures: Fixture[] = [
	{ id: "hnt_tie_c", worldId: "wld_one", botId: "bot_a", createdAt: tieAt },
	{ id: "hnt_older", worldId: "wld_one", botId: "bot_a", createdAt: olderAt },
	{ id: "hnt_tie_a", worldId: "wld_one", botId: "bot_a", createdAt: tieAt },
	{ id: "hnt_newer", worldId: "wld_two", botId: "bot_b", createdAt: newerAt },
	{ id: "hnt_tie_e", worldId: "wld_one", botId: "bot_a", createdAt: tieAt },
	{ id: "hnt_tie_b", worldId: "wld_two", botId: "bot_b", createdAt: tieAt },
	{ id: "hnt_tie_d", worldId: "wld_two", botId: "bot_b", createdAt: tieAt },
];

/** `(created_at DESC, notification_id DESC)`, the order both halves agree on. */
const totalOrder = [
	"hnt_newer",
	"hnt_tie_e",
	"hnt_tie_d",
	"hnt_tie_c",
	"hnt_tie_b",
	"hnt_tie_a",
	"hnt_older",
];

function db(): D1DatabaseLike {
	return testEnv.BICKR_D1 as unknown as D1DatabaseLike;
}

async function seed(ids: string[] = fixtures.map((row) => row.id)): Promise<void> {
	for (const row of fixtures.filter((candidate) => ids.includes(candidate.id))) {
		await testEnv.BICKR_D1
			.prepare(
				`INSERT INTO human_notifications (
					notification_id, user_id, world_id, event_key, notification_type,
					actor_bot_id, title, body, url_path, created_at
				) VALUES (?, ?, ?, ?, 'mention', ?, 'Title', 'Body', '/', ?)`,
			)
			.bind(row.id, userId, row.worldId, `evt_${row.id}`, row.botId, row.createdAt)
			.run();
	}
}

async function unreadIds(): Promise<string[]> {
	const result = await testEnv.BICKR_D1
		.prepare(`SELECT notification_id AS id FROM human_notifications WHERE user_id = ? AND read_at IS NULL`)
		.bind(userId)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id).sort();
}

/** The newest row the list rendered, which is what the client sends as the anchor. */
async function anchorFromRenderedList(): Promise<HumanNotificationReadAnchor> {
	const page = await listHumanNotifications(db(), userId, "all", 50, 0);
	const newest = page.notifications[0];
	expect(newest).toBeDefined();
	return { notificationId: newest.id, createdAt: newest.createdAt };
}

describe("human notification list ordering", () => {
	beforeEach(async () => {
		await resetD1Schema(testEnv.BICKR_D1);
	});

	it("orders by created_at then notification id, so a timestamp tie has one order", async () => {
		await seed();

		const summary = await listHumanNotifications(db(), userId, "all", 50, 0);

		expect(summary.notifications.map((notification) => notification.id)).toEqual(totalOrder);
	});

	it("pages through the tie without repeating or dropping a row", async () => {
		await seed();

		const seen: string[] = [];
		let offset = 0;
		for (;;) {
			const page = await listHumanNotifications(db(), userId, "all", 2, offset);
			seen.push(...page.notifications.map((notification) => notification.id));
			if (!page.hasMore) {
				break;
			}
			offset = page.nextOffset ?? offset + page.notifications.length;
		}

		expect(seen).toEqual(totalOrder);
	});

	it.each([
		[
			"all",
			{ scopeType: "all" } as HumanNotificationReadScope,
			["hnt_older", "hnt_tie_a", "hnt_tie_b", "hnt_tie_c", "hnt_tie_d"],
		],
		[
			"world",
			{ scopeType: "world", scopeId: "wld_one" } as HumanNotificationReadScope,
			["hnt_older", "hnt_tie_a", "hnt_tie_c"],
		],
		[
			"bot",
			{ scopeType: "bot", scopeId: "bot_b" } as HumanNotificationReadScope,
			["hnt_tie_b", "hnt_tie_d"],
		],
	])(
		"marks exactly the rows at or below a mid-tie anchor in the %s scope",
		async (_name, scope, expectedRead) => {
			// The list is read mid-fan-out: `hnt_tie_d` is the newest row written
			// so far, so it is the anchor — and it is inside the tie, with
			// `hnt_tie_c` below it and `hnt_tie_e`, still unwritten, above.
			await seed(["hnt_older", "hnt_tie_a", "hnt_tie_b", "hnt_tie_c", "hnt_tie_d"]);
			const anchor = await anchorFromRenderedList();
			expect(anchor.notificationId).toBe("hnt_tie_d");
			// The rest of the same fan-out lands after the read, in the same
			// millisecond, plus a later notification.
			await seed(["hnt_tie_e", "hnt_newer"]);

			await markAllHumanNotificationsRead(db(), userId, scope, readAt, anchor);

			const stillUnread = await unreadIds();
			expect(stillUnread).toEqual(fixtures.map((row) => row.id).filter((id) => !expectedRead.includes(id)).sort());
			// The row directly above the anchor inside the tie was never rendered.
			expect(stillUnread).toContain("hnt_tie_e");
		},
	);
});
