import type {
	HumanNotification,
	HumanNotificationReadAnchor,
	HumanNotificationReadScope,
	HumanNotificationSummary,
} from "@bickr/shared/model";
import { parsePathname } from "../../routes";

/**
 * The anchor a mark-all gesture runs with: the newest notification this client
 * holds, by the `(createdAt, id)` tuple the server orders and bounds on. Null
 * when there is nothing rendered, which is a gesture that marks nothing.
 */
export function humanNotificationReadAnchorFor(
	notifications: HumanNotification[],
): HumanNotificationReadAnchor | null {
	let newest: HumanNotification | null = null;
	for (const notification of notifications) {
		if (!newest || !humanNotificationAtOrBeforeReadAnchor(notification, anchorOf(newest))) {
			newest = notification;
		}
	}
	return newest ? anchorOf(newest) : null;
}

/** The client half of the server's `created_at < ? OR (created_at = ? AND notification_id <= ?)`. */
export function humanNotificationAtOrBeforeReadAnchor(
	notification: HumanNotification,
	anchor: HumanNotificationReadAnchor,
): boolean {
	return (
		notification.createdAt < anchor.createdAt ||
		(notification.createdAt === anchor.createdAt && notification.id <= anchor.notificationId)
	);
}

/**
 * The optimistic half of a mark-all: it applies the predicate the server
 * applies, so a notification that arrived above the anchor stays visibly unread
 * without waiting for a refetch. `unreadCount` comes off the server's
 * `readCount` — the rows it actually changed — rather than being zeroed, which
 * hid exactly those late arrivals.
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
	return anchor !== null && humanNotificationAtOrBeforeReadAnchor(notification, anchor);
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
