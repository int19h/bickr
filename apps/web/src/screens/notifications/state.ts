import type {
	HumanNotification,
	HumanNotificationReadAnchor,
	HumanNotificationSummary,
} from "@bickr/shared/model";
import { parsePathname } from "../../routes";

/** What a reload of the already-loaded pages came back with. */
export type HumanNotificationReloadResult = {
	cancelled: boolean;
	failed: boolean;
	summary: HumanNotificationSummary | null;
};

/**
 * The anchor a mark-all gesture runs with: the newest notification this client
 * holds, in the `(createdAt DESC, id DESC)` order the list is served in. Null
 * when there is nothing rendered, which is a gesture that marks nothing.
 *
 * It is the whole of what this client contributes to a mark-all. What the sweep
 * then covered is not knowable here — the server bounds by the anchor row's
 * `rowid`, which no response carries, and `created_at` is captured by the writer
 * *before* its INSERT, so a row written after the gesture can carry an older
 * timestamp than the anchor and a later rowid. No predicate over a response can
 * separate those, so this client does not guess at one: it sends the anchor,
 * then refetches and renders what the server says.
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
 * Walks the list back page by page after a mark-all, up to what was already
 * loaded, so the screen keeps its position instead of collapsing to page one.
 * This walk is the only thing that says what a mark-all read; there is no
 * optimistic pass beside it to agree or disagree with.
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
