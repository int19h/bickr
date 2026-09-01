import type {
	HumanNotification,
	HumanNotificationListScope,
	HumanNotificationReadAnchor,
	HumanNotificationReadScope,
	HumanNotificationSummary,
} from "@bickr/shared/model";
import { useEffect, useMemo, useRef, useState } from "react";
import { TranslatableText } from "../../components/content";
import { shouldHandleSpaClick } from "../../components/navigation";
import {
	NotificationBody,
	NotificationSwipeDismissFrame,
	SpotlightNotificationBadge,
	notificationHref,
	notificationMeta,
	timestampTitle,
} from "../chrome";
import { EmptyState, FilterBox, Icon, textValue, type TextLike } from "../../ui";
import { TimeAgoLabel, compareHandles, matchesFilter } from "../../components/record-display";
import {
	appendUniqueHumanNotifications,
	humanNotificationReadAnchorFor,
	humanNotificationSummaryWithoutNotification,
	reloadHumanNotificationPages,
} from "./state";

export type LoadHumanNotifications = (
	status: "unread" | "all",
	limit?: number,
	offset?: number,
	scope?: HumanNotificationListScope,
) => Promise<HumanNotificationSummary | null>;

type NotificationGroupMode = "world" | "bot";

export function NotificationsScreen({
	embedded = false,
	grouped = true,
	listScope = { scopeType: "all" },
	onLoadNotifications,
	onDismiss,
	onMarkAllRead,
	onMarkRead,
	onOpenNotification,
	subtitle = "Recent activity from watched worlds, forums, threads, and participants.",
	title = "Notifications",
}: {
	embedded?: boolean;
	grouped?: boolean;
	listScope?: HumanNotificationListScope;
	onLoadNotifications: LoadHumanNotifications;
	onDismiss: (notification: HumanNotification) => Promise<boolean>;
	onMarkAllRead: (scope?: HumanNotificationReadScope, anchor?: HumanNotificationReadAnchor | null) => Promise<number | null>;
	onMarkRead: (notification: HumanNotification) => Promise<string | null>;
	onOpenNotification: (notification: HumanNotification) => void;
	subtitle?: string;
	title?: string;
}) {
	const pageSize = 50;
	const [summary, setSummary] = useState<HumanNotificationSummary>({ unreadCount: 0, notifications: [] });
	const [groupMode, setGroupMode] = useState<NotificationGroupMode>("world");
	const [filter, setFilter] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [message, setMessage] = useState("");
	const loadVersion = useRef(0);
	const scopeKey = notificationListScopeKey(listScope);

	async function refresh(): Promise<void> {
		const version = loadVersion.current + 1;
		loadVersion.current = version;
		setLoading(true);
		const next = await onLoadNotifications("all", pageSize, 0, listScope);
		if (loadVersion.current !== version) {
			return;
		}
		if (next) {
			setSummary(next);
			setMessage("");
		} else {
			setMessage("Could not load notifications.");
		}
		setLoading(false);
	}

	async function loadMore(): Promise<void> {
		const version = loadVersion.current;
		setLoadingMore(true);
		const next = await onLoadNotifications("all", pageSize, summary.nextOffset ?? summary.notifications.length, listScope);
		if (loadVersion.current !== version) {
			setLoadingMore(false);
			return;
		}
		if (next) {
			setSummary((current) => ({
				...next,
				notifications: appendUniqueHumanNotifications(current.notifications, next.notifications),
			}));
			setMessage("");
		} else {
			setMessage("Could not load more notifications.");
		}
		setLoadingMore(false);
	}

	useEffect(() => {
		setSummary({ unreadCount: 0, notifications: [] });
		setFilter("");
		setMessage("");
		void refresh();
	}, [scopeKey]);

	async function markRead(notification: HumanNotification): Promise<void> {
		if (notification.readAt) {
			return;
		}
		const readAt = await onMarkRead(notification);
		if (!readAt) {
			return;
		}
		setSummary((current) => ({
			...current,
			unreadCount: Math.max(0, current.unreadCount - 1),
			notifications: current.notifications.map((item) =>
				item.id === notification.id ? { ...item, readAt } : item,
			),
		}));
	}

	async function dismissNotification(notification: HumanNotification): Promise<boolean> {
		const dismissed = await onDismiss(notification);
		if (!dismissed) {
			return false;
		}
		setSummary((current) => humanNotificationSummaryWithoutNotification(current, notification));
		return true;
	}

	// Every mark-all this screen makes is bounded by the newest notification it
	// has loaded, so a group sweep and a whole-list sweep in one sitting share the
	// same ceiling and neither reaches a notification that arrived after it.
	//
	// Nothing here is marked read locally. What the sweep covered depends on the
	// anchor row's rowid, which no response carries, so no predicate this screen
	// could write over its own list is sound — it would show rows read that the
	// server deliberately left unread. The screen goes into its loading state
	// instead and shows the refetched list when it lands.
	async function markReadUpToLoaded(readScope: HumanNotificationReadScope): Promise<void> {
		// Captured before the request goes out: the newest row this screen had, which
		// is the ceiling the server sweeps up to.
		const anchor = humanNotificationReadAnchorFor(summary.notifications);
		const loadedCount = summary.notifications.length;
		setLoading(true);
		const readCount = await onMarkAllRead(readScope, anchor);
		if (readCount === null) {
			setLoading(false);
			return;
		}
		await reloadLoadedNotifications(loadedCount);
	}

	// The refetch is the whole of what a mark-all does to this screen: the read
	// state of every row and the unread badge come from it and from nothing else.
	// Reloading page by page up to what was already loaded keeps the list where
	// the user left it instead of collapsing it back to the first page; the walk
	// itself is bounded so it ends on every page shape.
	//
	// A walk that failed part-way is not an answer, so it is not shown as one: the
	// pre-gesture list and its badge stay up, stale but the server's, until a load
	// that finishes replaces them.
	async function reloadLoadedNotifications(loadedCount: number): Promise<void> {
		const version = loadVersion.current + 1;
		loadVersion.current = version;
		setLoading(true);
		const result = await reloadHumanNotificationPages(
			(offset) => onLoadNotifications("all", pageSize, offset, listScope),
			{ isCancelled: () => loadVersion.current !== version, loadedCount, pageSize },
		);
		if (result.cancelled) {
			return;
		}
		if (result.failed) {
			setMessage("Could not refresh notifications.");
		} else {
			if (result.summary) {
				setSummary(result.summary);
			}
			setMessage("");
		}
		setLoading(false);
	}

	async function markAllRead(): Promise<void> {
		await markReadUpToLoaded(notificationReadScopeForListScope(listScope));
	}

	async function markGroupRead(group: NotificationGroup): Promise<void> {
		if (group.unreadCount === 0) {
			return;
		}
		await markReadUpToLoaded(group.readScope);
	}

	const filtered = useMemo(
		() =>
			summary.notifications.filter((notification) =>
				matchesFilter(
					filter,
					notification.actorHandle,
					notification.actorDisplayName,
					notification.forumHandle,
					notification.forumName,
				),
			),
		[filter, summary.notifications],
	);
	const groups = useMemo(
		() => grouped ? notificationGroups(filtered, groupMode) : [],
		[filtered, grouped, groupMode],
	);
	const canLoadMore = Boolean(summary.hasMore);

	return (
		<div className={embedded ? "notifications-page notifications-panel" : "main-inner notifications-page"}>
			<div className="page-header">
				<div>
					<h1>{title}</h1>
					<p className="sub">{subtitle}</p>
				</div>
				<div className="actions">
					{grouped && (
						<div className="seg" role="tablist">
							<button aria-pressed={groupMode === "world"} onClick={() => setGroupMode("world")} type="button">
								By world
							</button>
							<button aria-pressed={groupMode === "bot"} onClick={() => setGroupMode("bot")} type="button">
								By bot
							</button>
						</div>
					)}
					<button className="btn" disabled={loading} onClick={() => void refresh()} type="button">
						<Icon name="refresh" size={14} />
						Refresh
					</button>
					<button className="btn" disabled={summary.unreadCount === 0} onClick={() => void markAllRead()} type="button">
						Mark all read
					</button>
				</div>
			</div>

			<FilterBox
				label="Filter notifications"
				onChange={setFilter}
				placeholder="Filter by u/handle, display name, f/handle, or forum name"
				value={filter}
			/>

			<div className="notification-page-summary">
				<span>{summary.unreadCount} unread</span>
				<span>{filtered.length} shown</span>
				<span>{summary.notifications.length} loaded</span>
				{loading && <span>Loading...</span>}
				{message && <span>{message}</span>}
			</div>

			{summary.notifications.length === 0 && !loading ?
				<EmptyState title="No notifications yet">
					Notifications appear here when watched activity happens.
				</EmptyState>
			: filtered.length === 0 ?
				<div className="empty compact-empty">No notifications match this filter.</div>
			: grouped ?
				<div className="notification-groups">
					{groups.map((group) => (
						<section className="notification-group" key={group.key}>
							<div className="notification-group-head">
								<div>
									<h2>{group.title}</h2>
										{textValue(group.meta) && <TranslatableText as="span" text={group.meta} />}
								</div>
								<div className="notification-group-actions">
									<span>{group.notifications.length}</span>
									<button
										className="btn compact"
										disabled={group.unreadCount === 0}
										onClick={() => void markGroupRead(group)}
										type="button"
									>
										Mark all read
									</button>
								</div>
							</div>
							<NotificationPageList
								notifications={group.notifications}
								onDismiss={dismissNotification}
								onMarkRead={(notification) => void markRead(notification)}
								onOpenNotification={onOpenNotification}
							/>
						</section>
					))}
				</div>
			:	<NotificationPageList
					notifications={filtered}
					onDismiss={dismissNotification}
					onMarkRead={(notification) => void markRead(notification)}
					onOpenNotification={onOpenNotification}
				/>
			}
			{summary.notifications.length > 0 && (
				<div className="notification-page-footer">
					{canLoadMore ?
						<button className="btn" disabled={loading || loadingMore} onClick={() => void loadMore()} type="button">
							<Icon name="refresh" size={14} />
							{loadingMore ? "Loading..." : "Load more"}
						</button>
					:	<span>All loaded</span>
					}
				</div>
			)}
		</div>
	);
}

function NotificationPageList({
	notifications,
	onDismiss,
	onMarkRead,
	onOpenNotification,
}: {
	notifications: HumanNotification[];
	onDismiss: (notification: HumanNotification) => Promise<boolean>;
	onMarkRead: (notification: HumanNotification) => void;
	onOpenNotification: (notification: HumanNotification) => void;
}) {
	return (
		<div className="notification-page-list">
			{notifications.map((notification) => (
				<NotificationPageCard
					key={notification.id}
					notification={notification}
					onDismiss={onDismiss}
					onMarkRead={onMarkRead}
					onOpenNotification={onOpenNotification}
				/>
			))}
		</div>
	);
}

function NotificationPageCard({
	notification,
	onDismiss,
	onMarkRead,
	onOpenNotification,
}: {
	notification: HumanNotification;
	onDismiss: (notification: HumanNotification) => Promise<boolean>;
	onMarkRead: (notification: HumanNotification) => void;
	onOpenNotification: (notification: HumanNotification) => void;
}) {
	return (
		<NotificationSwipeDismissFrame
			as="article"
			contentClassName={`notification-page-card ${notification.readAt ? "" : "unread"} ${notification.spotlightId ? "has-spotlight" : ""}`}
			onDismiss={() => onDismiss(notification)}
		>
			<a
				className="notification-page-link"
				href={notificationHref(notification)}
				onClick={(event) => {
					if (!shouldHandleSpaClick(event)) {
						return;
					}
					event.preventDefault();
					onOpenNotification(notification);
				}}
		>
			<TranslatableText as="span" className="notification-title" text={notification.title} />
				<NotificationBody body={notification.body} />
				<span className="notification-meta" title={timestampTitle(notification.createdAt)}>{notificationMeta(notification)}</span>
			</a>
			{notification.spotlightId && <SpotlightNotificationBadge />}
			<div className="notification-page-actions">
				{notification.readAt ?
					<span className="read-state">Read <TimeAgoLabel value={notification.readAt} /></span>
				:	<button className="btn compact" onClick={() => onMarkRead(notification)} type="button">
						Mark read
					</button>
				}
			</div>
		</NotificationSwipeDismissFrame>
	);
}

function notificationListScopeKey(scope: HumanNotificationListScope): string {
	return scope.scopeType === "all" ? "all" : `${scope.scopeType}:${scope.scopeId}`;
}

function notificationReadScopeForListScope(scope: HumanNotificationListScope): HumanNotificationReadScope {
	return scope.scopeType === "all" ? { scopeType: "all" } : scope;
}

type NotificationGroup = {
	key: string;
	title: string;
	meta: TextLike;
	readScope: HumanNotificationReadScope;
	unreadCount: number;
	notifications: HumanNotification[];
};

function notificationGroups(
	notifications: HumanNotification[],
	mode: NotificationGroupMode,
): NotificationGroup[] {
	const groups = new Map<string, NotificationGroup>();
	for (const notification of notifications) {
		const key =
			mode === "world" ? `world:${notification.worldId}`
			: notification.actorBotId ? `bot:${notification.actorBotId}`
			: notification.actorHandle ? `bot-handle:${notification.actorHandle}`
			: "bot:none";
		const readScope: HumanNotificationReadScope =
			mode === "world" ? { scopeType: "world", scopeId: notification.worldId }
			: notification.actorBotId ? { scopeType: "bot", scopeId: notification.actorBotId }
			: { scopeType: "notifications", notificationIds: [notification.id] };
		const fallbackTitle = mode === "world" ? "Unknown world" : "No participant";
		const title =
			mode === "world" ? (notification.worldHandle ? `w/${notification.worldHandle}` : fallbackTitle)
			: notification.actorHandle ? `u/${notification.actorHandle}`
			: fallbackTitle;
		const meta =
			mode === "world" ? notification.worldName ?? ""
			: notification.actorDisplayName ?? "";
		const group = groups.get(key) ?? { key, title, meta, readScope, unreadCount: 0, notifications: [] };
		if (group.readScope.scopeType === "notifications" && !group.readScope.notificationIds.includes(notification.id)) {
			group.readScope.notificationIds.push(notification.id);
		}
		if (!notification.readAt) {
			group.unreadCount += 1;
		}
		group.notifications.push(notification);
		groups.set(key, group);
	}
	return [...groups.values()].sort((left, right) => compareHandles(left.title, right.title));
}
