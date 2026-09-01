import type { HumanNotification, HumanNotificationSummary, LocalizedText } from "@bickr/shared/model";
import { describe, expect, it } from "vitest";
import {
	humanNotificationReadAnchorFor,
	humanNotificationSummaryWithReadScope,
} from "./state";

/**
 * The optimistic half of a mark-all. It may only show as read what the server
 * demonstrably marked: a notification that arrived after the user clicked must
 * stay visibly unread, and the badge must not be zeroed over it. The server's
 * bound includes the anchor row's `rowid`, which no response carries, so where
 * this client cannot tell it under-claims and lets the refetch that follows the
 * call settle the row.
 */
describe("humanNotificationSummaryWithReadScope", () => {
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

	it("leaves a notification above the anchor unread and keeps it counted", () => {
		const current = summary([
			notification("hnt_new", after),
			notification("hnt_anchor", anchorAt),
			notification("hnt_old", before),
		]);
		const anchor = { notificationId: "hnt_anchor", createdAt: anchorAt };

		const next = humanNotificationSummaryWithReadScope(current, { scopeType: "all" }, anchor, readAt, 2);

		expect(next.notifications.map((item) => [item.id, item.readAt])).toEqual([
			["hnt_new", undefined],
			["hnt_anchor", readAt],
			["hnt_old", readAt],
		]);
		// Derived from the rows the server changed, not zeroed: the late arrival is
		// still unread, and the badge still says so without a refetch.
		expect(next.unreadCount).toBe(1);
	});

	// The server bounds the sweep by the anchor row's rowid, which no response
	// carries. Inside the anchor's millisecond, then, this client cannot tell a
	// row written before the anchor from one written after it — id order says
	// nothing about insertion order — so it claims neither. `hnt_a` here may well
	// have been marked; the refetch that follows the call is what says so.
	it("leaves the anchor's millisecond to the server rather than guessing at a tie-break", () => {
		const current = summary([
			notification("hnt_c", anchorAt),
			notification("hnt_b", anchorAt),
			notification("hnt_a", anchorAt),
		]);

		const next = humanNotificationSummaryWithReadScope(
			current,
			{ scopeType: "all" },
			{ notificationId: "hnt_b", createdAt: anchorAt },
			readAt,
			2,
		);

		// Only the anchor row itself, which is its own bound.
		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual(["hnt_b"]);
		// Still the server's number, not a count of what was shown as read: the
		// badge may under-report unread for a moment, never over-report it as zero.
		expect(next.unreadCount).toBe(1);
	});

	it("marks a row older than the anchor's millisecond, which is below the anchor's rowid either way", () => {
		const current = summary([
			notification("hnt_same_ms", anchorAt),
			notification("hnt_anchor", anchorAt),
			notification("hnt_older", before),
		]);

		const next = humanNotificationSummaryWithReadScope(
			current,
			{ scopeType: "all" },
			{ notificationId: "hnt_anchor", createdAt: anchorAt },
			readAt,
			3,
		);

		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual([
			"hnt_anchor",
			"hnt_older",
		]);
		expect(next.unreadCount).toBe(0);
	});

	it("marks only the scope's own notifications, still bounded by the anchor", () => {
		const current = summary([
			notification("hnt_other_world", before, { worldId: "wld_two", actorBotId: "bot_b" }),
			notification("hnt_new", after),
			notification("hnt_old", before),
		]);

		const next = humanNotificationSummaryWithReadScope(
			current,
			{ scopeType: "world", scopeId: "wld_one" },
			{ notificationId: "hnt_old", createdAt: before },
			readAt,
			1,
		);

		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual(["hnt_old"]);
		expect(next.unreadCount).toBe(2);
	});

	it("marks nothing when nothing was rendered to anchor on", () => {
		const current = summary([notification("hnt_new", after)]);

		const next = humanNotificationSummaryWithReadScope(current, { scopeType: "all" }, null, readAt, 0);

		expect(next.notifications.every((item) => !item.readAt)).toBe(true);
		expect(next.unreadCount).toBe(1);
	});

	it("takes the by-ids scope at its word, which is already what the user saw", () => {
		const current = summary([notification("hnt_new", after), notification("hnt_old", before)]);

		const next = humanNotificationSummaryWithReadScope(
			current,
			{ scopeType: "notifications", notificationIds: ["hnt_new"] },
			null,
			readAt,
			1,
		);

		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual(["hnt_new"]);
		expect(next.unreadCount).toBe(1);
	});

	it("keeps an already-read notification's own timestamp", () => {
		const current = summary([notification("hnt_read", before, { readAt: before })], 0);

		const next = humanNotificationSummaryWithReadScope(
			current,
			{ scopeType: "all" },
			{ notificationId: "hnt_read", createdAt: before },
			readAt,
			0,
		);

		expect(next.notifications[0]?.readAt).toBe(before);
		expect(next.unreadCount).toBe(0);
	});
});
