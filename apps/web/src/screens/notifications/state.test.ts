import type { HumanNotification, HumanNotificationSummary, LocalizedText } from "@bickr/shared/model";
import { describe, expect, it } from "vitest";
import {
	humanNotificationReadAnchorFor,
	humanNotificationSummaryWithReadScope,
} from "./state";

/**
 * The optimistic half of a mark-all. It has to agree with the server's anchor
 * predicate: a notification that arrived after the user clicked must stay
 * visibly unread, and the badge must not be zeroed over it.
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

	it("applies the anchor's id tie-break the way the server does", () => {
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

		expect(next.notifications.filter((item) => item.readAt).map((item) => item.id)).toEqual(["hnt_b", "hnt_a"]);
		expect(next.unreadCount).toBe(1);
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
