import type { HumanNotification, HumanNotificationSummary, LocalizedText } from "@bickr/shared/model";
import { describe, expect, it } from "vitest";
import {
	humanNotificationMarkAllGestureFor,
	humanNotificationReadAnchorFor,
	humanNotificationSummaryWithReadScope,
	reloadHumanNotificationPages,
} from "./state";

const before = "2026-05-06T11:59:00.000Z";
const anchorAt = "2026-05-06T12:00:00.000Z";
const after = "2026-05-06T12:00:01.000Z";
const readAt = "2026-05-06T12:00:02.000Z";

function notification(id: string, createdAt: string, overrides: Partial<HumanNotification> = {}): HumanNotification {
	return {
		id,
		userId: "usr_one",
		worldId: "wld_one",
		eventKey: `event:${id}`,
		notificationType: "thread_created",
		actorBotId: "bot_a",
		title: localized(id),
		body: localized(id),
		urlPath: "/",
		createdAt,
		...overrides,
	};
}

function localized(text: string): LocalizedText {
	return { lang: null, text };
}

function summary(notifications: HumanNotification[], unreadCount = notifications.length): HumanNotificationSummary {
	return { unreadCount, notifications };
}

/**
 * The optimistic half of a mark-all. It may only show as read what the server
 * demonstrably marked: a notification the client never had on screen must stay
 * visibly unread whatever timestamp it carries, and the badge must not be zeroed
 * over it. Where this client cannot tell, it under-claims and lets the refetch
 * that follows the call settle the row.
 */
describe("humanNotificationSummaryWithReadScope", () => {
	it("takes the newest rendered notification as the anchor, breaking a tie by id", () => {
		expect(humanNotificationReadAnchorFor([])).toBeNull();
		expect(
			humanNotificationReadAnchorFor([
				notification("hnt_b", anchorAt),
				notification("hnt_c", anchorAt),
				notification("hnt_a", before),
			]),
		).toEqual({ notificationId: "hnt_c", createdAt: anchorAt });
	});

	it("captures the rendered ids alongside the anchor", () => {
		const gesture = humanNotificationMarkAllGestureFor([
			notification("hnt_b", anchorAt),
			notification("hnt_a", before),
		]);

		expect(gesture.anchor).toEqual({ notificationId: "hnt_b", createdAt: anchorAt });
		expect([...gesture.renderedIds].sort()).toEqual(["hnt_a", "hnt_b"]);
	});

	it("leaves a notification above the anchor unread and keeps it counted", () => {
		const rendered = [
			notification("hnt_new", after),
			notification("hnt_anchor", anchorAt),
			notification("hnt_old", before),
		];
		const gesture = { anchor: { notificationId: "hnt_anchor", createdAt: anchorAt }, renderedIds: idsOf(rendered) };

		const next = humanNotificationSummaryWithReadScope(summary(rendered), { scopeType: "all" }, gesture, readAt);

		expect(next.notifications.map((item) => [item.id, item.readAt])).toEqual([
			["hnt_new", undefined],
			["hnt_anchor", readAt],
			["hnt_old", readAt],
		]);
		// Derived from what this pass actually marked, not zeroed: the late arrival
		// is still unread, and the badge still says so without a refetch.
		expect(next.unreadCount).toBe(1);
	});

	/**
	 * The row the timestamp predicate on its own gets wrong. `created_at` is
	 * captured by the writer before its INSERT, so a notification written after
	 * the gesture can carry an older timestamp than the anchor and a later rowid —
	 * the server's `rowid <=` bound leaves it unread. A refresh racing the request
	 * can put it in the list this pass runs against, and the only thing that says
	 * it does not belong to the gesture is that it was never rendered.
	 */
	it("leaves a row it never rendered unread, however old the row claims to be", () => {
		const rendered = [notification("hnt_anchor", anchorAt), notification("hnt_old", before)];
		const gesture = { anchor: { notificationId: "hnt_anchor", createdAt: anchorAt }, renderedIds: idsOf(rendered) };
		const current = summary([...rendered, notification("hnt_backdated", before)]);

		const next = humanNotificationSummaryWithReadScope(current, { scopeType: "all" }, gesture, readAt);

		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual([
			"hnt_anchor",
			"hnt_old",
		]);
		expect(next.unreadCount).toBe(1);
	});

	// The server bounds the sweep by the anchor row's rowid, which no response
	// carries. Inside the anchor's millisecond, then, this client cannot tell a
	// row written before the anchor from one written after it — id order says
	// nothing about insertion order — so it claims neither, rendered or not.
	it("leaves the anchor's millisecond to the server rather than guessing at a tie-break", () => {
		const rendered = [
			notification("hnt_c", anchorAt),
			notification("hnt_b", anchorAt),
			notification("hnt_a", anchorAt),
		];
		const gesture = { anchor: { notificationId: "hnt_b", createdAt: anchorAt }, renderedIds: idsOf(rendered) };

		const next = humanNotificationSummaryWithReadScope(summary(rendered), { scopeType: "all" }, gesture, readAt);

		// Only the anchor row itself, which is its own bound.
		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual(["hnt_b"]);
		// The badge may under-report what was read, never over-report it as zero.
		expect(next.unreadCount).toBe(2);
	});

	it("marks a rendered row older than the anchor's millisecond, which is below its rowid either way", () => {
		const rendered = [
			notification("hnt_same_ms", anchorAt),
			notification("hnt_anchor", anchorAt),
			notification("hnt_older", before),
		];
		const gesture = { anchor: { notificationId: "hnt_anchor", createdAt: anchorAt }, renderedIds: idsOf(rendered) };

		const next = humanNotificationSummaryWithReadScope(summary(rendered), { scopeType: "all" }, gesture, readAt);

		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual([
			"hnt_anchor",
			"hnt_older",
		]);
		// One row is still unread on screen, so the badge cannot say zero.
		expect(next.unreadCount).toBe(1);
	});

	it("never lets the badge fall below what is still unread in the list", () => {
		const rendered = [notification("hnt_anchor", anchorAt), notification("hnt_unmarked", anchorAt)];
		const gesture = { anchor: { notificationId: "hnt_anchor", createdAt: anchorAt }, renderedIds: idsOf(rendered) };

		const next = humanNotificationSummaryWithReadScope(
			// A stale count: the server had already read more than this client knows.
			summary(rendered, 1),
			{ scopeType: "all" },
			gesture,
			readAt,
		);

		expect(next.unreadCount).toBe(1);
		expect(next.notifications.find((item) => item.id === "hnt_unmarked")?.readAt).toBeUndefined();
	});

	it("marks only the scope's own notifications, still bounded by the gesture", () => {
		const rendered = [
			notification("hnt_other_world", before, { worldId: "wld_two", actorBotId: "bot_b" }),
			notification("hnt_new", after),
			notification("hnt_old", before),
		];
		const gesture = { anchor: { notificationId: "hnt_old", createdAt: before }, renderedIds: idsOf(rendered) };

		const next = humanNotificationSummaryWithReadScope(
			summary(rendered),
			{ scopeType: "world", scopeId: "wld_one" },
			gesture,
			readAt,
		);

		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual(["hnt_old"]);
		expect(next.unreadCount).toBe(2);
	});

	it("marks nothing when nothing was rendered to anchor on", () => {
		const current = summary([notification("hnt_new", after)]);

		const next = humanNotificationSummaryWithReadScope(
			current,
			{ scopeType: "all" },
			{ anchor: null, renderedIds: new Set<string>() },
			readAt,
		);

		expect(next.notifications.every((item) => !item.readAt)).toBe(true);
		expect(next.unreadCount).toBe(1);
	});

	it("takes the by-ids scope at its word, which is already what the user saw", () => {
		const current = summary([notification("hnt_new", after), notification("hnt_old", before)]);

		const next = humanNotificationSummaryWithReadScope(
			current,
			{ scopeType: "notifications", notificationIds: ["hnt_new"] },
			{ anchor: null, renderedIds: new Set<string>() },
			readAt,
		);

		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual(["hnt_new"]);
		expect(next.unreadCount).toBe(1);
	});

	it("keeps an already-read notification's own timestamp", () => {
		const rendered = [notification("hnt_read", before, { readAt: before })];
		const gesture = { anchor: { notificationId: "hnt_read", createdAt: before }, renderedIds: idsOf(rendered) };

		const next = humanNotificationSummaryWithReadScope(summary(rendered, 0), { scopeType: "all" }, gesture, readAt);

		expect(next.notifications[0]?.readAt).toBe(before);
		expect(next.unreadCount).toBe(0);
	});
});

/**
 * The reconciling walk after a mark-all. It has to end on every page shape a
 * server can hand it, including shapes that never say "done": the bound on it is
 * the page budget, which is fixed before the first request and cannot be moved
 * by anything a page contains.
 */
describe("reloadHumanNotificationPages", () => {
	function pageOf(ids: string[], hasMore: boolean, nextOffset?: number): HumanNotificationSummary {
		return {
			hasMore,
			...(nextOffset === undefined ? {} : { nextOffset }),
			unreadCount: ids.length,
			notifications: ids.map((id) => notification(id, before)),
		};
	}

	it("stops on nonempty pages that keep repeating rows and promising more", async () => {
		const offsets: number[] = [];
		const result = await reloadHumanNotificationPages(
			async (offset) => {
				offsets.push(offset);
				// A walk that outruns this is one that never ends: throwing keeps a
				// regression here a failing test rather than a hanging suite.
				expect(offsets.length, "the page budget did not bound the walk").toBeLessThan(50);
				// Every page: the same two rows, a moving offset, and `hasMore` that
				// never settles. Nothing here can ever end the walk.
				return pageOf(["hnt_a", "hnt_b"], true, offset + 2);
			},
			{ loadedCount: 6, pageSize: 2 },
		);

		expect(offsets).toEqual([0, 2, 4, 6]);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_a", "hnt_b"]);
		expect(result.failed).toBe(false);
		expect(result.cancelled).toBe(false);
	});

	it("stops on a page that repeats rows without advancing the offset either", async () => {
		let loads = 0;
		const result = await reloadHumanNotificationPages(
			async () => {
				loads += 1;
				expect(loads, "the page budget did not bound the walk").toBeLessThan(50);
				return pageOf(["hnt_a"], true, 0);
			},
			{ loadedCount: 100, pageSize: 10 },
		);

		expect(loads).toBe(11);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_a"]);
	});

	it("walks several pages and settles on a final short page", async () => {
		const pages = [
			pageOf(["hnt_a", "hnt_b"], true, 2),
			pageOf(["hnt_c", "hnt_d"], true, 4),
			pageOf(["hnt_e"], false, 5),
		];
		const offsets: number[] = [];

		const result = await reloadHumanNotificationPages(
			async (offset) => {
				offsets.push(offset);
				return pages[offsets.length - 1] ?? null;
			},
			{ loadedCount: 6, pageSize: 2 },
		);

		expect(offsets).toEqual([0, 2, 4]);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual([
			"hnt_a",
			"hnt_b",
			"hnt_c",
			"hnt_d",
			"hnt_e",
		]);
		expect(result.summary?.hasMore).toBe(false);
		expect(result.failed).toBe(false);
	});

	it("stops on an empty page even while the server still claims more", async () => {
		const pages = [pageOf(["hnt_a", "hnt_b"], true, 2), pageOf([], true, 2)];
		let loads = 0;

		const result = await reloadHumanNotificationPages(
			async () => {
				loads += 1;
				return pages[loads - 1] ?? null;
			},
			{ loadedCount: 20, pageSize: 2 },
		);

		expect(loads).toBe(2);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_a", "hnt_b"]);
	});

	it("stops once it has collected what was loaded", async () => {
		let loads = 0;
		const result = await reloadHumanNotificationPages(
			async (offset) => {
				loads += 1;
				return pageOf([`hnt_${offset}`, `hnt_${offset + 1}`], true, offset + 2);
			},
			{ loadedCount: 4, pageSize: 2 },
		);

		expect(loads).toBe(2);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_0", "hnt_1", "hnt_2", "hnt_3"]);
	});

	it("reports a failed page and keeps the pages it already has", async () => {
		let loads = 0;
		const result = await reloadHumanNotificationPages(
			async (offset) => {
				loads += 1;
				return loads === 1 ? pageOf(["hnt_a", "hnt_b"], true, offset + 2) : null;
			},
			{ loadedCount: 6, pageSize: 2 },
		);

		expect(result.failed).toBe(true);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_a", "hnt_b"]);
	});

	it("abandons the walk when a newer load has taken over", async () => {
		let loads = 0;
		const result = await reloadHumanNotificationPages(
			async (offset) => {
				loads += 1;
				return pageOf([`hnt_${offset}`], true, offset + 1);
			},
			{ isCancelled: () => loads >= 2, loadedCount: 10, pageSize: 1 },
		);

		expect(loads).toBe(2);
		expect(result.cancelled).toBe(true);
		expect(result.summary).toBeNull();
	});
});

function idsOf(notifications: HumanNotification[]): ReadonlySet<string> {
	return new Set(notifications.map((item) => item.id));
}
