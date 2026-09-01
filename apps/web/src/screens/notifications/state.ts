import type {
	HumanNotification,
	HumanNotificationReadAnchor,
	HumanNotificationReadScope,
	HumanNotificationSummary,
} from "@bickr/shared/model";
import { parsePathname } from "../../routes";

/**
 * The anchor a mark-all gesture runs with: the newest notification this client
 * holds, in the `(createdAt DESC, id DESC)` order the list is served in. Null
 * when there is nothing rendered, which is a gesture that marks nothing.
 */
export function humanNotificationReadAnchorFor(
	notifications: HumanNotification[],
): HumanNotificationReadAnchor | null {
	let newest: HumanNotification | null = null;
	for (const notification of notifications) {
		if (!newest || sortsAboveInListOrder(notification, newest)) {
			newest = notification;
		}
	}
	return newest ? anchorOf(newest) : null;
}

/**
 * Whether this client can *prove* the server marked this row, which is a
 * strictly smaller set than the one the server actually marks.
 *
 * The server bounds by `rowid <= <the anchor's rowid> AND created_at <= <the
 * rendered createdAt>`, and rowids are not in any response — so within the
 * anchor's millisecond the client cannot tell a row inserted before the anchor
 * from one inserted after it. Id order says nothing about insertion order:
 * `notification_id` is a random UUID. Everything strictly older than the anchor
 * timestamp is below the anchor's rowid, and the anchor row is its own bound;
 * anything else sharing that millisecond is left alone here and picked up from
 * the server's own state when the caller reconciles.
 *
 * The rule this encodes: the optimistic pass may under-claim what was marked,
 * never over-claim. Under-claiming shows a row as unread for the moment before
 * the refetch lands; over-claiming shows a notification that arrived after the
 * gesture as already read, which is the bug the anchor exists to prevent.
 */
export function humanNotificationProvablyReadByAnchor(
	notification: HumanNotification,
	anchor: HumanNotificationReadAnchor,
): boolean {
	return notification.createdAt < anchor.createdAt || notification.id === anchor.notificationId;
}

/**
 * The optimistic half of a mark-all: it marks the rows the server is known to
 * have marked, so the list settles immediately without claiming anything about
 * a notification that may have arrived above the anchor. `unreadCount` comes off
 * the server's `readCount` — the rows it actually changed — rather than being
 * zeroed, which hid exactly those late arrivals.
 *
 * This is a placeholder for the server's answer, not the answer: callers refetch
 * afterwards and take the list and the badge from that.
 */
export function humanNotificationSummaryWithReadScope(
	summary: HumanNotificationSummary,
	scope: HumanNotificationReadScope,
	anchor: HumanNotificationReadAnchor | null,
	readAt: string,
	readCount: number,
): HumanNotificationSummary {
	const notifications = summary.notifications.map((notification) =>
		notification.readAt || !humanNotificationMarkedByReadScope(notification, scope, anchor) ?
			notification
		:	{ ...notification, readAt },
	);
	return {
		...summary,
		unreadCount: Math.max(0, summary.unreadCount - readCount),
		notifications,
	};
}

function anchorOf(notification: HumanNotification): HumanNotificationReadAnchor {
	return { notificationId: notification.id, createdAt: notification.createdAt };
}

/** The by-ids scope carries its own bound; every other scope needs the anchor. */
function humanNotificationMarkedByReadScope(
	notification: HumanNotification,
	scope: HumanNotificationReadScope,
	anchor: HumanNotificationReadAnchor | null,
): boolean {
	if (!humanNotificationMatchesReadScope(notification, scope)) {
		return false;
	}
	if (scope.scopeType === "notifications") {
		return true;
	}
	return anchor !== null && humanNotificationProvablyReadByAnchor(notification, anchor);
}

/** The `(createdAt DESC, id DESC)` order `listHumanNotifications` serves. */
function sortsAboveInListOrder(candidate: HumanNotification, current: HumanNotification): boolean {
	return (
		candidate.createdAt > current.createdAt ||
		(candidate.createdAt === current.createdAt && candidate.id > current.id)
	);
}

export function humanNotificationSummaryWithoutNotification(
	summary: HumanNotificationSummary,
	notification: HumanNotification,
): HumanNotificationSummary {
	return {
		...summary,
		unreadCount: Math.max(0, summary.unreadCount - (notification.readAt ? 0 : 1)),
		notifications: summary.notifications.filter((item) => item.id !== notification.id),
	};
}

function humanNotificationMatchesReadScope(
	notification: HumanNotification,
	scope: HumanNotificationReadScope,
): boolean {
	switch (scope.scopeType) {
		case "all":
			return true;
		case "world":
			return notification.worldId === scope.scopeId;
		case "bot":
			return notification.actorBotId === scope.scopeId;
		case "notifications":
			return scope.notificationIds.includes(notification.id);
	}
}

export function notificationThreadId(notification: HumanNotification): string | null {
	if (notification.targetType === "thread" && notification.targetId) {
		return notification.targetId;
	}
	if (notification.sourceType === "thread" && notification.sourceId) {
		return notification.sourceId;
	}
	try {
		const url = new URL(notification.urlPath, window.location.origin);
		const route = parsePathname(url.pathname, url.search);
		return route.route === "thread" ? route.threadId ?? null : null;
	} catch {
		return null;
	}
}
