import type {
	HumanNotification,
	HumanNotificationReadAnchor,
	HumanNotificationReadScope,
	HumanNotificationSummary,
} from "@bickr/shared/model";
import { parsePathname } from "../../routes";

/**
 * Everything a mark-all gesture has to remember from the moment it happened: the
 * anchor the request runs with, and the ids this client actually had on screen.
 *
 * The id set is the important half. It is not a prediction about what the server
 * will do — it is a record of what was already rendered, and a row that was
 * rendered before the gesture is a row that existed before the gesture. Nothing
 * else about the list is knowable from a response: rowids are not in one, and
 * `created_at` is captured by the writer *before* its INSERT, so a row written
 * after the gesture can carry an older timestamp than the anchor and a later
 * rowid. Remembering is sound where predicting is not.
 */
export type HumanNotificationMarkAllGesture = {
	anchor: HumanNotificationReadAnchor | null;
	renderedIds: ReadonlySet<string>;
};

/** What a reload of the already-loaded pages came back with. */
export type HumanNotificationReloadResult = {
	cancelled: boolean;
	failed: boolean;
	summary: HumanNotificationSummary | null;
};

/**
 * Captures a gesture over the notifications a caller is rendering right now.
 * Call this before the request goes out; the list can change under it after.
 */
export function humanNotificationMarkAllGestureFor(
	notifications: HumanNotification[],
): HumanNotificationMarkAllGesture {
	return {
		anchor: humanNotificationReadAnchorFor(notifications),
		renderedIds: new Set(notifications.map((notification) => notification.id)),
	};
}

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
 * The optimistic half of a mark-all: a placeholder for the server's answer, not
 * the answer. Callers refetch afterwards and take the list and the badge from
 * that; the one rule here is that this pass may lag the server, never contradict
 * it. Under-claiming shows a row as unread for the moment before the refetch
 * lands. Over-claiming shows a notification the server deliberately left unread
 * as read, which is the bug the anchor exists to prevent.
 *
 * So it marks a row only when both halves of the gesture allow it: the row was
 * rendered when the user clicked, and it is one the anchor bound provably
 * covers. The unread count is derived from what was actually marked here plus
 * what is still unread on screen, never zeroed and never reduced by the server's
 * `readCount` — that count includes rows this client has not loaded, so
 * subtracting it can drive the badge to zero while an unread row is sitting in
 * the list.
 */
export function humanNotificationSummaryWithReadScope(
	summary: HumanNotificationSummary,
	scope: HumanNotificationReadScope,
	gesture: HumanNotificationMarkAllGesture,
	readAt: string,
): HumanNotificationSummary {
	let marked = 0;
	const notifications = summary.notifications.map((notification) => {
		if (notification.readAt || !humanNotificationMarkedByGesture(notification, scope, gesture)) {
			return notification;
		}
		marked += 1;
		return { ...notification, readAt };
	});
	const stillUnreadHere = notifications.filter((notification) => !notification.readAt).length;
	return {
		...summary,
		unreadCount: Math.max(stillUnreadHere, summary.unreadCount - marked),
		notifications,
	};
}

/**
 * Walks the list back page by page after a mark-all, up to what was already
 * loaded, so the screen keeps its position instead of collapsing to page one.
 *
 * The walk is bounded by a page budget derived from `loadedCount` alone and
 * never from what a page contains. Page content cannot be trusted to end a loop:
 * `hasMore` is the server's word, and a run of nonempty pages that repeat rows
 * already seen neither grows the accumulated list nor reports itself finished.
 * When the budget runs out the walk stops cleanly and keeps what it has.
 */
export async function reloadHumanNotificationPages(
	loadPage: (offset: number) => Promise<HumanNotificationSummary | null>,
	options: { loadedCount: number; pageSize: number; isCancelled?: () => boolean },
): Promise<HumanNotificationReloadResult> {
	const pageSize = Math.max(1, options.pageSize);
	const pageBudget = Math.ceil(Math.max(1, options.loadedCount) / pageSize) + 1;
	let notifications: HumanNotification[] = [];
	let settled: HumanNotificationSummary | null = null;
	let failed = false;
	let offset = 0;
	for (let pass = 0; pass < pageBudget; pass += 1) {
		const page = await loadPage(offset);
		if (options.isCancelled?.()) {
			return { cancelled: true, failed: false, summary: null };
		}
		if (!page) {
			failed = true;
			break;
		}
		notifications = appendUniqueHumanNotifications(notifications, page.notifications);
		settled = page;
		// Off the page's own bounds rather than off the accumulated list, which
		// dedupes and so cannot be trusted to advance.
		offset = page.nextOffset ?? offset + page.notifications.length;
		if (!page.hasMore || page.notifications.length === 0 || notifications.length >= options.loadedCount) {
			break;
		}
	}
	return { cancelled: false, failed, summary: settled ? { ...settled, notifications } : null };
}

export function appendUniqueHumanNotifications(
	current: HumanNotification[],
	next: HumanNotification[],
): HumanNotification[] {
	const seen = new Set(current.map((notification) => notification.id));
	return [...current, ...next.filter((notification) => !seen.has(notification.id))];
}

function anchorOf(notification: HumanNotification): HumanNotificationReadAnchor {
	return { notificationId: notification.id, createdAt: notification.createdAt };
}

/** The by-ids scope carries its own bound; every other scope needs the gesture. */
function humanNotificationMarkedByGesture(
	notification: HumanNotification,
	scope: HumanNotificationReadScope,
	gesture: HumanNotificationMarkAllGesture,
): boolean {
	if (!humanNotificationMatchesReadScope(notification, scope)) {
		return false;
	}
	if (scope.scopeType === "notifications") {
		return true;
	}
	if (!gesture.renderedIds.has(notification.id)) {
		return false;
	}
	return gesture.anchor !== null && provablyWithinAnchorBound(notification, gesture.anchor);
}

/**
 * Whether a row that was already on screen is also one the server's bound
 * provably covers. Being rendered says the row is older than the gesture; it
 * does not say the row is below the anchor's rowid, and the server bounds by
 * `rowid <= <the anchor's rowid> AND created_at <= <the rendered createdAt>`.
 * Rowids are in no response, so within the anchor's millisecond this client
 * cannot tell a row inserted before the anchor from one inserted after it — id
 * order says nothing about insertion order, `notification_id` being a random
 * UUID. Only rows strictly older than the anchor's timestamp are below its
 * rowid, plus the anchor row itself, which is its own bound. The rest of that
 * millisecond is left to the refetch.
 */
function provablyWithinAnchorBound(
	notification: HumanNotification,
	anchor: HumanNotificationReadAnchor,
): boolean {
	return notification.createdAt < anchor.createdAt || notification.id === anchor.notificationId;
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
