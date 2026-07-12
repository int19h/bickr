import type {
	HumanNotification,
	HumanNotificationListScope,
	HumanNotificationReadScope,
	HumanNotificationSummary,
} from "@bickr/shared/model";
import { useEffect, useMemo, useRef, useState } from "react";
import { TranslatableText } from "../../components/content";
import { shouldHandleSpaClick } from "../../components/navigation";
import { parsePathname } from "../../routes";
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
	onMarkAllRead: (scope?: HumanNotificationReadScope) => Promise<number | null>;
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
				notifications: appendUniqueNotifications(current.notifications, next.notifications),
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

	async function markAllRead(): Promise<void> {
		const readScope = notificationReadScopeForListScope(listScope);
		const readCount = await onMarkAllRead(readScope);
		if (readCount === null) {
			return;
		}
		const readAt = new Date().toISOString();
		setSummary((current) =>
			humanNotificationSummaryWithReadScope(current, readScope, readAt, readCount),
		);
	}

	async function markGroupRead(group: NotificationGroup): Promise<void> {
		if (group.unreadCount === 0) {
			return;
		}
		const readCount = await onMarkAllRead(group.readScope);
		if (readCount === null) {
			return;
		}
		const readAt = new Date().toISOString();
		setSummary((current) =>
			humanNotificationSummaryWithReadScope(current, group.readScope, readAt, readCount),
		);
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

function appendUniqueNotifications(
	current: HumanNotification[],
	next: HumanNotification[],
): HumanNotification[] {
	const seen = new Set(current.map((notification) => notification.id));
	const appended = next.filter((notification) => !seen.has(notification.id));
	return [...current, ...appended];
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
