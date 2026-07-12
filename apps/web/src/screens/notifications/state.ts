import type {
	HumanNotification,
	HumanNotificationReadScope,
	HumanNotificationSummary,
} from "@bickr/shared/model";
import { parsePathname } from "../../routes";

export function humanNotificationSummaryWithReadScope(
	summary: HumanNotificationSummary,
	scope: HumanNotificationReadScope,
	readAt: string,
	readCount: number,
): HumanNotificationSummary {
	let localUnreadCount = 0;
	const notifications = summary.notifications.map((notification) => {
		if (!humanNotificationMatchesReadScope(notification, scope)) {
			return notification;
		}
		if (!notification.readAt) {
			localUnreadCount += 1;
		}
		return { ...notification, readAt: notification.readAt ?? readAt };
	});
	const unreadCount =
		scope.scopeType === "all" ?
			0
		:	Math.max(0, summary.unreadCount - Math.max(localUnreadCount, readCount));
	return {
		...summary,
		unreadCount,
		notifications,
	};
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
