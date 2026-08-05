import { Fragment, useContext, useEffect, useId, useRef, useState } from "react";
import type {
	CSSProperties,
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	ReactNode,
} from "react";
import {
	authProviders,
	type AuthProvider,
	type BotSummary,
	type ForumSummary,
	type HumanNotification,
	type HumanNotificationSummary,
	type PublicUser,
	type SearchResult,
	type SearchSuggestResponse,
	type ThreadDocument,
} from "@bickr/shared/model";
import { api } from "../../api";
import {
	defaultFontScalePercent,
	decreaseFontScalePercent,
	fontScalePercents,
	increaseFontScalePercent,
	type FontScalePercent,
} from "../../font-scale";
import {
	notificationSwipeOffset,
	notificationSwipeShouldDismiss,
	notificationSwipeShouldSuppressClick,
} from "../../notification-swipe";
import {
	defaultSearchRouteState,
	parsePathname,
	routePath,
	type ParsedRoute,
	type Route,
	type SearchRouteState,
} from "../../routes";
import {
	Avatar,
	Icon,
	textValue,
	useViewportConstrainedPopout,
	type IconName,
	type TextLike,
} from "../../ui";
import {
	Reference,
	TranslatableText,
	type WorldView,
} from "../../components/content";
import {
	NavigationContext,
	SpaLink,
	shouldHandleSpaClick,
} from "../../components/navigation";
import { useUiText } from "../../components/ui-text";

const bickrLogoSrc = "/bickr.png";
const githubRepositoryUrl = "https://github.com/int19h/bickr";
const discordInviteUrl = "https://discord.gg/TC8fqeVEWU";

export type ThemePreference = "system" | "light" | "dark";

export const banners = [
	"linear-gradient(135deg, oklch(0.78 0.10 60), oklch(0.72 0.10 30))",
	"linear-gradient(135deg, oklch(0.74 0.06 200), oklch(0.68 0.10 260))",
	"linear-gradient(135deg, oklch(0.80 0.08 130), oklch(0.72 0.09 90))",
	"linear-gradient(135deg, oklch(0.78 0.09 350), oklch(0.70 0.09 310))",
	"linear-gradient(135deg, oklch(0.82 0.04 80), oklch(0.74 0.07 40))",
	"linear-gradient(135deg, oklch(0.76 0.10 20), oklch(0.68 0.12 350))",
];

export function BickrLogo({ alt = "" }: { alt?: string }) {
	return <img alt={alt} className="brand-logo" src={bickrLogoSrc} />;
}

export function authStartHref(provider: AuthProvider, returnTo?: string): string {
	const currentReturnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	return `/api/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo ?? (currentReturnTo || "/"))}`;
}

export function authProviderLabel(provider: AuthProvider): string {
	return provider === "github" ? "GitHub" : "Google";
}

export function Topbar({
	activeWorldHandle,
	bot,
	busy,
	fontScalePercent,
	forum,
	installAvailable,
	notifications,
	onFontScale,
	onMarkAllNotificationsRead,
	onInstall,
	onNotificationDismiss,
	onNotificationOpen,
	onRefresh,
	onRefreshNotifications,
	onTheme,
	route,
	status,
	themePreference,
	thread,
	user,
	world,
	worlds,
}: {
	activeWorldHandle: string | null;
	bot: BotSummary | null;
	busy: boolean;
	fontScalePercent: FontScalePercent;
	forum: ForumSummary | null;
	installAvailable: boolean;
	notifications: HumanNotificationSummary;
	onFontScale: (scale: FontScalePercent) => void;
	onMarkAllNotificationsRead: () => void;
	onInstall: () => void;
	onNotificationDismiss: (notification: HumanNotification) => Promise<boolean>;
	onNotificationOpen: (notification: HumanNotification) => void;
	onRefresh: () => void;
	onRefreshNotifications: (status?: "unread" | "all") => void;
	onTheme: (preference: ThemePreference) => void;
	route: Route;
	status: string;
	themePreference: ThemePreference;
	thread: ThreadDocument | null;
	user: PublicUser | null;
	world: WorldView | null;
	worlds: WorldView[];
}) {
	const t = useUiText();
	const isWorldScoped =
		route !== "worlds" &&
		route !== "my-bots" &&
		route !== "notifications" &&
		route !== "subscriptions" &&
		route !== "human-profile" &&
		route !== "profile" &&
		route !== "profile-avatar" &&
		route !== "inference-library" &&
		route !== "inference-configuration";
	const breadcrumbs: { content: ReactNode; key: string }[] = [];
	if (world && isWorldScoped) {
		breadcrumbs.push({
			key: "world",
			content:
				route === "world" ?
					<span className="current">
						<Reference kind="world" name={world.handle} />
					</span>
				:	<SpaLink to={{ route: "world", worldHandle: world.handle }}>
						<Reference kind="world" link={false} name={world.handle} />
					</SpaLink>,
		});
	}
	if (forum && (route === "forum" || route === "thread")) {
		breadcrumbs.push({
			key: "forum",
			content: (
				<span className={route === "forum" ? "current" : ""}>
					{route === "forum" ?
						<Reference kind="forum" name={forum.handle} />
					:	<SpaLink to={{ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle }}>
							<Reference kind="forum" link={false} name={forum.handle} />
						</SpaLink>
					}
				</span>
			),
		});
	}
		if (route === "thread" && thread) {
			breadcrumbs.push({
				key: "thread",
				content: <TranslatableText as="span" className="current truncate" text={thread.title} />,
			});
		}
	if (route === "world-edit") {
		breadcrumbs.push({ key: "world-edit", content: <span className="current">{t.topbar.edit}</span> });
	}
	if (route === "world-avatar") {
		breadcrumbs.push({ key: "world-avatar", content: <span className="current">{t.topbar.avatar}</span> });
	}
	if ((route === "bot-profile" || route === "bot-avatar" || route === "bot-loop" || route === "bot-edit") && bot) {
		breadcrumbs.push({
			key: "bot",
			content:
				route === "bot-profile" ?
					<span className="current">
						<Reference isBot kind="bot" name={bot.handle} />
					</span>
				:	<SpaLink to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
						<Reference isBot kind="bot" link={false} name={bot.handle} />
					</SpaLink>,
		});
	}
	if (route === "bot-loop") {
		breadcrumbs.push({ key: "bot-loop", content: <span className="current">{t.topbar.loop}</span> });
	}
	if (route === "bot-avatar") {
		breadcrumbs.push({ key: "bot-avatar", content: <span className="current">{t.topbar.avatar}</span> });
	}
	if (route === "bot-edit") {
		breadcrumbs.push({ key: "bot-edit", content: <span className="current">{t.topbar.edit}</span> });
	}
	if (route === "my-bots") {
		breadcrumbs.push({ key: "my-bots", content: <span className="current">{t.nav.myBots}</span> });
	}
	if (route === "search") {
		breadcrumbs.push({ key: "search", content: <span className="current">{t.nav.search}</span> });
	}
	if (route === "notifications") {
		breadcrumbs.push({ key: "notifications", content: <span className="current">{t.nav.notifications}</span> });
	}
	if (route === "subscriptions") {
		breadcrumbs.push({ key: "subscriptions", content: <span className="current">{t.nav.subscriptions}</span> });
	}
	if (route === "profile") {
		breadcrumbs.push({ key: "profile", content: <span className="current">{t.topbar.profile}</span> });
	}
	if (route === "inference-library") {
		breadcrumbs.push({ key: "inference-library", content: <span className="current">{t.nav.inferenceLibrary}</span> });
	}
	if (route === "inference-configuration") {
		breadcrumbs.push({
			key: "inference-library",
			content: <SpaLink to={{ route: "inference-library" }}>{t.nav.inferenceLibrary}</SpaLink>,
		});
		breadcrumbs.push({ key: "inference-configuration", content: <span className="current">{t.topbar.edit}</span> });
	}
	if (route === "profile-avatar") {
		breadcrumbs.push({
			key: "profile",
			content: <SpaLink to={{ route: "profile" }}>{t.topbar.profile}</SpaLink>,
		});
		breadcrumbs.push({ key: "profile-avatar", content: <span className="current">{t.topbar.avatar}</span> });
	}
	return (
		<header className="topbar">
			<div className="brand">
					<MobileNavigationMenu
						active={activeWorldHandle}
						isAuthenticated={Boolean(user)}
						route={route}
						unreadNotifications={notifications.unreadCount}
						worlds={worlds}
				/>
				<SpaLink className="brand-mark desktop-brand-mark" to={{ route: "worlds" }}>
					<BickrLogo alt="Bickr" />
				</SpaLink>
				<SpaLink className="brand-name" to={{ route: "worlds" }}>
					bickr
				</SpaLink>
				<div className="crumbs">
					{breadcrumbs.map((breadcrumb, index) => (
						<Fragment key={breadcrumb.key}>
							{index > 0 && <span className="sep">/</span>}
							{breadcrumb.content}
						</Fragment>
					))}
				</div>
			</div>
			<div className="right">
				<GlobalSearchBox />
				<span className="status-chip" title={status}>
					{busy ? t.topbar.working : status}
				</span>
				<ThemeSwitch onChange={onTheme} value={themePreference} />
				<FontScaleSwitch onChange={onFontScale} value={fontScalePercent} />
				{installAvailable && (
					<button aria-label={t.topbar.installBickr} className="icon-btn topbar-install" onClick={onInstall} title={t.topbar.installBickr} type="button">
						<Icon name="install" size={15} />
					</button>
				)}
				<button className="icon-btn topbar-refresh" disabled={busy} onClick={onRefresh} title={t.topbar.refresh} type="button">
					<Icon name="refresh" size={15} />
				</button>
				{user && (
					<NotificationBell
						notifications={notifications}
						onDismissNotification={onNotificationDismiss}
						onMarkAllRead={onMarkAllNotificationsRead}
						onOpenNotification={onNotificationOpen}
						onRefresh={onRefreshNotifications}
					/>
				)}
				{user ?
					<SpaLink className={`account-btn ${busy ? "disabled" : ""}`} title={t.topbar.profile} to={{ route: "profile" }}>
						<Avatar actor="user" colorSeed={user.handle} crop={user.avatarCrop} imageUrl={user.avatarUrl} name={user.displayName} size="sm" />
						<span>hu/{user.handle}</span>
					</SpaLink>
				:	<SignInControl />
				}
			</div>
		</header>
	);
}

export function GlobalSearchBox() {
	const { navigate } = useContext(NavigationContext);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchResult[]>([]);
	const [loading, setLoading] = useState(false);
	const [open, setOpen] = useState(false);
	const [message, setMessage] = useState("");
	const wrapRef = useRef<HTMLDivElement>(null);
	const requestSeq = useRef(0);
	const trimmed = query.trim();
	const menuRef = useViewportConstrainedPopout<HTMLDivElement>(open && trimmed.length >= 2);

	useEffect(() => {
		if (!open) {
			return undefined;
		}
		function handlePointerDown(event: PointerEvent): void {
			if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) {
				setOpen(false);
			}
		}
		function handleKeyDown(event: KeyboardEvent): void {
			if (event.key === "Escape") {
				setOpen(false);
			}
		}
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open]);

	useEffect(() => {
		const normalized = trimmed;
		requestSeq.current += 1;
		const seq = requestSeq.current;
		if (normalized.length < 2) {
			setResults([]);
			setLoading(false);
			setMessage("");
			return undefined;
		}
		setLoading(true);
		setMessage("");
		const timeout = window.setTimeout(() => {
			void api<SearchSuggestResponse>(`/api/search/suggest?q=${encodeURIComponent(normalized)}`).then((result) => {
				if (requestSeq.current !== seq) {
					return;
				}
				setLoading(false);
				if (result.ok) {
					setResults(result.data.results);
					setMessage(result.data.results.length === 0 ? "No quick matches" : "");
				} else {
					setResults([]);
					setMessage(result.message);
				}
			});
		}, 260);
		return () => window.clearTimeout(timeout);
	}, [trimmed]);

	function openAdvanced(page = 1): void {
		const state: SearchRouteState = {
			...defaultSearchRouteState,
			page,
			query: trimmed,
		};
		setOpen(false);
		navigate({ route: "search", search: state });
	}

	function openResult(result: SearchResult): void {
		const url = new URL(result.urlPath, window.location.origin);
		setOpen(false);
		setQuery("");
		navigate(parsePathname(url.pathname, url.search));
	}

	return (
		<div className="search global-search" ref={wrapRef}>
			<Icon name="search" size={14} />
			<input
				aria-autocomplete="list"
				aria-expanded={open}
				aria-label="Search"
				onChange={(event) => {
					setQuery(event.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && trimmed.length >= 2) {
						event.preventDefault();
						openAdvanced();
					}
				}}
				placeholder="Search worlds, forums, bots"
				value={query}
			/>
			{open && trimmed.length >= 2 && (
				<div className="global-search-menu" ref={menuRef} role="listbox">
					<div className="global-search-head">
						<span>{loading ? "Searching" : message || "Quick matches"}</span>
					</div>
					{results.map((result) => (
						<button
							className="global-search-result"
							key={`${result.type}:${result.id}`}
							onClick={() => openResult(result)}
							role="option"
							type="button"
						>
							<span className="global-search-title">{quickSearchResultTitle(result)}</span>
							<span className="global-search-meta">{searchResultMeta(result)}</span>
						</button>
					))}
					<button className="global-search-advanced" onClick={() => openAdvanced()} type="button">
						<Icon name="search" size={13} />
						Advanced search
					</button>
				</div>
			)}
		</div>
	);
}

function quickSearchResultTitle(result: SearchResult): ReactNode {
	if (result.type === "world") {
		return <Reference kind="world" link={false} name={result.handle} />;
	}
	if (result.type === "forum") {
		return (
			<>
				<Reference kind="forum" link={false} name={result.handle} worldHandle={result.world.handle} />
				<span className="global-search-from">from</span>
				<Reference kind="world" link={false} name={result.world.handle} />
			</>
		);
	}
	return (
		<>
			<Reference isBot kind="bot" link={false} name={result.handle} worldHandle={result.world.handle} />
			<span className="global-search-from">from</span>
			<Reference kind="world" link={false} name={result.world.handle} />
		</>
	);
}

export function searchResultMeta(result: SearchResult): string {
	if (result.type === "world") {
		return textValue(result.name);
	}
	if (result.type === "forum") {
		return textValue(result.description);
	}
	return `${textValue(result.displayName)} · ${textValue(result.shortBio)}`;
}

function ThemeSwitch({
	onChange,
	value,
}: {
	onChange: (preference: ThemePreference) => void;
	value: ThemePreference;
}) {
	const choices: Array<{ label: string; icon: IconName; value: ThemePreference }> = [
		{ label: "System", icon: "monitor", value: "system" },
		{ label: "Light", icon: "sun", value: "light" },
		{ label: "Dark", icon: "moon", value: "dark" },
	];

	return (
		<div aria-label="Theme" className="theme-switch" role="group">
			{choices.map((choice) => (
				<button
					aria-label={`${choice.label} theme`}
					aria-pressed={value === choice.value}
					key={choice.value}
					onClick={() => onChange(choice.value)}
					title={`${choice.label} theme`}
					type="button"
				>
					<Icon name={choice.icon} size={14} />
				</button>
			))}
		</div>
	);
}

function FontScaleSwitch({
	onChange,
	value,
}: {
	onChange: (scale: FontScalePercent) => void;
	value: FontScalePercent;
}) {
	const minimum = fontScalePercents[0];
	const maximum = fontScalePercents[fontScalePercents.length - 1];

	return (
		<div aria-label="Font size" className="font-scale-switch" role="group">
			<button
				aria-label={`Decrease font size, currently ${value}%`}
				disabled={value === minimum}
				onClick={() => onChange(decreaseFontScalePercent(value))}
				title="Decrease font size"
				type="button"
			>
				<span aria-hidden="true" className="font-scale-step">A-</span>
			</button>
			<button
				aria-label={`Reset font size to default, currently ${value}%`}
				className="font-scale-reset"
				onClick={() => onChange(defaultFontScalePercent)}
				title={`Font size ${value}%. Reset to 100%.`}
				type="button"
			>
				{value}%
			</button>
			<button
				aria-label={`Increase font size, currently ${value}%`}
				disabled={value === maximum}
				onClick={() => onChange(increaseFontScalePercent(value))}
				title="Increase font size"
				type="button"
			>
				<span aria-hidden="true" className="font-scale-step">A+</span>
			</button>
		</div>
	);
}

function SignInControl() {
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const menuRef = useViewportConstrainedPopout<HTMLDivElement>(open);

	useEffect(() => {
		if (!open) {
			return undefined;
		}
		const handlePointerDown = (event: PointerEvent) => {
			if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) {
				setOpen(false);
			}
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open]);

	return (
		<div className="sign-in-menu-wrap" ref={wrapRef}>
			<button
				aria-controls={menuId}
				aria-expanded={open}
				className="btn primary compact sign-in-button"
				onClick={() => setOpen((current) => !current)}
				type="button"
			>
				Sign in
			</button>
			{open && (
				<div aria-label="Sign in options" className="sign-in-menu" id={menuId} ref={menuRef} role="menu">
					{authProviders.map((provider) => (
						<a
							className="sign-in-menu-item"
							href={authStartHref(provider)}
							key={provider}
							onClick={() => setOpen(false)}
							role="menuitem"
						>
							<Icon name={provider === "github" ? "github" : "google"} size={16} />
							<span>Continue with {authProviderLabel(provider)}</span>
						</a>
					))}
				</div>
			)}
		</div>
	);
}

export function NotificationBell({
	notifications,
	onDismissNotification,
	onMarkAllRead,
	onOpenNotification,
	onRefresh,
}: {
	notifications: HumanNotificationSummary;
	onDismissNotification: (notification: HumanNotification) => Promise<boolean>;
	onMarkAllRead: () => void;
	onOpenNotification: (notification: HumanNotification) => void;
	onRefresh: (status?: "unread" | "all") => void;
}) {
	const [open, setOpen] = useState(false);
	const menuRef = useViewportConstrainedPopout<HTMLDivElement>(open);
	const unread = notifications.unreadCount;
	return (
		<div className="notification-wrap">
			<button
				aria-expanded={open}
				className={`icon-btn notify ${unread > 0 ? "active" : ""}`}
				onClick={() => {
					const next = !open;
					setOpen(next);
					if (next) {
						onRefresh("unread");
					}
				}}
				title="Notifications"
				type="button"
			>
				<Icon name="bell" size={15} />
				{unread > 0 && <span className="notify-badge">{unread > 99 ? "99+" : unread}</span>}
			</button>
			{open && (
				<div className="notification-menu" ref={menuRef}>
					<div className="notification-menu-head">
						<b>Notifications</b>
						<button className="clear-link" onClick={onMarkAllRead} type="button">
							Mark all read
						</button>
					</div>
					{notifications.notifications.length === 0 ?
						<div className="notification-empty">No unread notifications.</div>
					:	notifications.notifications.map((notification) => (
							<NotificationSwipeDismissFrame
								contentClassName={`notification-card ${notification.readAt ? "" : "unread"} ${notification.spotlightId ? "has-spotlight" : ""}`}
								key={notification.id}
								onDismiss={() => onDismissNotification(notification)}
							>
								<a
									className="notification-card-link"
									href={notificationHref(notification)}
									onClick={(event) => {
										if (!shouldHandleSpaClick(event)) {
											return;
										}
										event.preventDefault();
										setOpen(false);
										onOpenNotification(notification);
									}}
								>
										<TranslatableText as="span" className="notification-title" text={notification.title} />
										<NotificationBody body={notification.body} />
									<span className="notification-meta" title={timestampTitle(notification.createdAt)}>{notificationMeta(notification)}</span>
								</a>
								<button
									aria-label="Close notification"
									className="notification-close"
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										void onDismissNotification(notification);
									}}
									title="Close"
									type="button"
								>
									<Icon name="x" size={13} />
								</button>
								{notification.spotlightId && <SpotlightNotificationBadge />}
							</NotificationSwipeDismissFrame>
						))}
					<button className="notification-load" onClick={() => onRefresh("all")} type="button">
						Show recent read
					</button>
				</div>
			)}
		</div>
	);
}

export function NotificationBody({ body }: { body: TextLike }) {
	const lines = textValue(body).split(/\r?\n/);
	const [firstLine = "", ...detailLines] = lines;
	return (
		<span className="notification-body">
			<span>{firstLine}</span>
			{detailLines.map((line, index) => (
				<span className="notification-body-detail" key={`${index}:${line}`}>
					{line || "\u00a0"}
				</span>
			))}
		</span>
	);
}

export function SpotlightNotificationBadge() {
	return <span aria-label="Spotlight" className="notification-spotlight-badge" title="Spotlight">🔦</span>;
}

type NotificationSwipeGesture = {
	pointerId: number;
	startX: number;
	startY: number;
	widthPx: number;
};

export function NotificationSwipeDismissFrame({
	as = "div",
	children,
	contentClassName,
	onDismiss,
}: {
	as?: "article" | "div";
	children: ReactNode;
	contentClassName: string;
	onDismiss: () => Promise<boolean>;
}) {
	const [dragging, setDragging] = useState(false);
	const [offset, setOffset] = useState(0);
	const dismissingRef = useRef(false);
	const gestureRef = useRef<NotificationSwipeGesture | null>(null);
	const suppressNextClickRef = useRef(false);

	function capturePointer(element: HTMLElement, pointerId: number): void {
		try {
			if (!element.hasPointerCapture(pointerId)) {
				element.setPointerCapture(pointerId);
			}
		} catch {
			// Pointer capture is a progressive enhancement for mouse drags that leave the card.
		}
	}

	function releasePointerCapture(element: HTMLElement, pointerId: number): void {
		try {
			if (element.hasPointerCapture(pointerId)) {
				element.releasePointerCapture(pointerId);
			}
		} catch {
			// The pointer may already be gone after native scroll cancellation.
		}
	}

	function swipeInput(event: ReactPointerEvent<HTMLElement>, gesture: NotificationSwipeGesture) {
		return {
			deltaX: event.clientX - gesture.startX,
			deltaY: event.clientY - gesture.startY,
			widthPx: gesture.widthPx,
		};
	}

	function beginSwipe(event: ReactPointerEvent<HTMLElement>): void {
		if (dismissingRef.current || (event.pointerType === "mouse" && event.button !== 0)) {
			return;
		}
		const bounds = event.currentTarget.getBoundingClientRect();
		gestureRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			widthPx: bounds.width,
		};
		setDragging(false);
		setOffset(0);
	}

	function moveSwipe(event: ReactPointerEvent<HTMLElement>): void {
		const gesture = gestureRef.current;
		if (!gesture || gesture.pointerId !== event.pointerId) {
			return;
		}
		const input = swipeInput(event, gesture);
		const nextOffset = notificationSwipeOffset(input);
		if (nextOffset < 0) {
			suppressNextClickRef.current = true;
			capturePointer(event.currentTarget, event.pointerId);
			setDragging(true);
			setOffset(nextOffset);
			event.preventDefault();
			return;
		}
		if (notificationSwipeShouldSuppressClick(input)) {
			setDragging(false);
			setOffset(0);
		}
	}

	function endSwipe(event: ReactPointerEvent<HTMLElement>): void {
		const gesture = gestureRef.current;
		if (!gesture || gesture.pointerId !== event.pointerId) {
			return;
		}
		const input = swipeInput(event, gesture);
		const shouldDismiss = notificationSwipeShouldDismiss(input);
		if (notificationSwipeShouldSuppressClick(input)) {
			suppressNextClickRef.current = true;
		}
		gestureRef.current = null;
		releasePointerCapture(event.currentTarget, event.pointerId);
		setDragging(false);
		if (!shouldDismiss) {
			setOffset(0);
			return;
		}
		dismissingRef.current = true;
		setOffset(-Math.max(gesture.widthPx, 240));
		void onDismiss().then((dismissed) => {
			if (!dismissed) {
				dismissingRef.current = false;
				setOffset(0);
			}
		});
	}

	function cancelSwipe(event: ReactPointerEvent<HTMLElement>): void {
		const gesture = gestureRef.current;
		if (!gesture || gesture.pointerId !== event.pointerId) {
			return;
		}
		gestureRef.current = null;
		releasePointerCapture(event.currentTarget, event.pointerId);
		setDragging(false);
		setOffset(0);
	}

	function suppressClickAfterSwipe(event: ReactMouseEvent<HTMLElement>): void {
		if (!suppressNextClickRef.current) {
			return;
		}
		suppressNextClickRef.current = false;
		event.preventDefault();
		event.stopPropagation();
	}

	const frameClassName = `notification-swipe-frame ${dragging ? "dragging" : ""} ${offset < 0 ? "active" : ""}`;
	const content = (
		<>
			<div aria-hidden="true" className="notification-swipe-dismiss">
				<Icon name="trash" size={14} />
				<span>Dismiss</span>
			</div>
			<div
				className={`${contentClassName} notification-swipe-content`}
				style={{ "--notification-swipe-x": `${offset}px` } as CSSProperties}
			>
				{children}
			</div>
		</>
	);
	const frameProps = {
		className: frameClassName,
		onClickCapture: suppressClickAfterSwipe,
		onPointerCancel: cancelSwipe,
		onPointerDown: beginSwipe,
		onPointerMove: moveSwipe,
		onPointerUp: endSwipe,
	};
	return as === "article" ? <article {...frameProps}>{content}</article> : <div {...frameProps}>{content}</div>;
}

export type SidebarNavigationProps = {
	active: string | null;
	isAuthenticated: boolean;
	route: Route;
	unreadNotifications: number;
	worlds: WorldView[];
	onNavigate?: () => void;
};

export function MobileNavigationMenu({
	active,
	isAuthenticated,
	route,
	unreadNotifications,
	worlds,
}: SidebarNavigationProps) {
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const menuRef = useViewportConstrainedPopout<HTMLElement>(open);
	const t = useUiText();

	useEffect(() => {
		setOpen(false);
	}, [route]);

	useEffect(() => {
		if (!open) {
			return;
		}

		function handlePointerDown(event: PointerEvent): void {
			if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) {
				setOpen(false);
			}
		}

		function handleKeyDown(event: KeyboardEvent): void {
			if (event.key === "Escape") {
				setOpen(false);
			}
		}

		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open]);

	return (
		<div className="mobile-nav-wrap" ref={wrapRef}>
			<button
				aria-controls={menuId}
				aria-expanded={open}
				aria-label={open ? t.nav.closeNavigation : t.nav.openNavigation}
				className="brand-mark mobile-nav-toggle"
				onClick={() => setOpen((current) => !current)}
				title={t.nav.navigation}
				type="button"
			>
				<BickrLogo alt="" />
			</button>
			{open && (
				<nav aria-label={t.nav.primaryNavigation} className="mobile-nav-menu" id={menuId} ref={menuRef}>
					<SidebarNavigation
						active={active}
						isAuthenticated={isAuthenticated}
						onNavigate={() => setOpen(false)}
						route={route}
						unreadNotifications={unreadNotifications}
						worlds={worlds}
					/>
				</nav>
			)}
		</div>
	);
}

export function Sidebar(props: SidebarNavigationProps) {
	return (
		<aside className="sidebar">
			<SidebarNavigation {...props} />
		</aside>
	);
}

function SidebarNavigation({
	active,
	isAuthenticated,
	onNavigate,
	route,
	unreadNotifications,
	worlds,
}: SidebarNavigationProps) {
	const myWorlds = isAuthenticated ? worlds.filter((world) => world.isMine) : [];
	const discover = (isAuthenticated ? worlds.filter((world) => !world.isMine) : worlds).slice(0, 6);
	const botTotal = worlds.reduce((total, world) => total + world.myBotCount, 0);
	const t = useUiText();

	return (
		<>
			<div className="nav-group">
				<SpaLink
					className={`nav-item ${route === "worlds" ? "active" : ""}`}
					onNavigate={onNavigate}
					to={{ route: "worlds" }}
				>
					<Icon name="world" size={16} />
					<span>{t.nav.allWorlds}</span>
					<span className="count">{worlds.length}</span>
				</SpaLink>
				{isAuthenticated && (
					<SpaLink
						className={`nav-item ${route === "my-bots" ? "active" : ""}`}
						onNavigate={onNavigate}
						to={{ route: "my-bots" }}
					>
						<Icon name="bot" size={16} />
						<span>{t.nav.myBots}</span>
						<span className="count">{botTotal}</span>
					</SpaLink>
				)}
				{isAuthenticated && (
					<SpaLink
						className={`nav-item ${route === "inference-library" || route === "inference-configuration" ? "active" : ""}`}
						onNavigate={onNavigate}
						to={{ route: "inference-library" }}
					>
						<Icon name="settings" size={16} />
						<span>{t.nav.inferenceLibrary}</span>
					</SpaLink>
				)}
				<SpaLink
					className={`nav-item ${route === "search" ? "active" : ""}`}
					onNavigate={onNavigate}
					to={{ route: "search" }}
				>
					<Icon name="search" size={16} />
					<span>{t.nav.search}</span>
				</SpaLink>
				{isAuthenticated && (
					<>
						<SpaLink
							className={`nav-item ${route === "notifications" ? "active" : ""}`}
							onNavigate={onNavigate}
							to={{ route: "notifications" }}
						>
							<Icon name="bell" size={16} />
							<span>{t.nav.notifications}</span>
							{unreadNotifications > 0 && <span className="count">{unreadNotifications > 99 ? "99+" : unreadNotifications}</span>}
						</SpaLink>
						<SpaLink
							className={`nav-item ${route === "subscriptions" ? "active" : ""}`}
							onNavigate={onNavigate}
							to={{ route: "subscriptions" }}
						>
							<Icon name="checklist" size={16} />
							<span>{t.nav.subscriptions}</span>
						</SpaLink>
					</>
				)}
				<button className="nav-item disabled" disabled title={t.nav.comingLater} type="button">
					<Icon name="settings" size={16} />
					<span>{t.nav.settings}</span>
				</button>
			</div>

			{isAuthenticated && (
				<div className="nav-group">
					<div className="label">{t.nav.yourWorlds}</div>
					{myWorlds.length === 0 && <div className="sidebar-note">{t.nav.noneYet}</div>}
					{myWorlds.map((world) => (
						<SpaLink
							className={`nav-item ${active === world.handle ? "active" : ""}`}
							key={world.id}
							onNavigate={onNavigate}
							title={textValue(world.name)}
							to={{ route: "world", worldHandle: world.handle }}
						>
							<span className="world-swatch" style={{ background: banners[world.bannerIdx] }} />
							<span className="truncate">w/{world.handle}</span>
							<span className="count">{world.myBotCount}</span>
						</SpaLink>
					))}
				</div>
			)}

			<div className="nav-group">
				<div className="label">{t.nav.discover}</div>
				{discover.map((world) => (
					<SpaLink
						className={`nav-item ${active === world.handle ? "active" : ""}`}
						key={world.id}
						onNavigate={onNavigate}
						title={textValue(world.name)}
						to={{ route: "world", worldHandle: world.handle }}
					>
						<span className="world-swatch" style={{ background: banners[world.bannerIdx] }} />
						<span className="truncate">w/{world.handle}</span>
						<span className="count">{isAuthenticated ? world.myBotCount : world.botCount}</span>
					</SpaLink>
				))}
			</div>

			{isAuthenticated && (
				<div className="nav-group">
					<div className="label">{t.nav.statistics}</div>
					<SpaLink
						className={`nav-item ${route === "statistics-inference-costs" ? "active" : ""}`}
						onNavigate={onNavigate}
						to={{ route: "statistics-inference-costs" }}
					>
						<Icon name="info" size={16} />
						<span>{t.nav.inferenceCosts}</span>
					</SpaLink>
				</div>
			)}

			<div className="sidebar-footnote">
				<div>{t.nav.footnote}</div>
				<div className="sidebar-community-links">
					<a
						aria-label={t.nav.githubLink}
						className="sidebar-community-link"
						href={githubRepositoryUrl}
						onClick={onNavigate}
						rel="noopener noreferrer"
						target="_blank"
						title={t.nav.githubLink}
					>
						<Icon name="github" size={19} />
					</a>
					<a
						aria-label={t.nav.discordLink}
						className="sidebar-community-link sidebar-community-link-discord"
						href={discordInviteUrl}
						onClick={onNavigate}
						rel="noopener noreferrer"
						target="_blank"
						title={t.nav.discordLink}
					>
						<Icon name="discord" size={19} />
					</a>
				</div>
			</div>
		</>
	);
}

export function formatShortDate(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		return "";
	}
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatFullDate(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		return value;
	}
	return date.toLocaleString(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
		second: "2-digit",
		year: "numeric",
	});
}

export function timestampTitle(value: string | null | undefined): string | undefined {
	return value ? formatFullDate(value) : undefined;
}

export function notificationMeta(notification: HumanNotification): string {
	return [
		notification.actorHandle ? `u/${notification.actorHandle}` : notification.notificationType.replace(/_/g, " "),
		notification.forumHandle ? `f/${notification.forumHandle}` : "",
		notification.worldHandle ? `w/${notification.worldHandle}` : "",
		timeAgo(notification.createdAt),
	]
		.filter(Boolean)
		.join(" / ");
}

export function notificationHref(notification: HumanNotification): string {
	return routePath(notificationRoute(notification));
}

export function notificationRoute(notification: HumanNotification): ParsedRoute {
	const parsed = parsedNotificationUrlPath(notification);
	if (parsed?.route === "bot-profile" && parsed.botActivityId) {
		return parsed;
	}
	const activityId = notificationActivityId(notification);
	if (activityId && notification.actorHandle && notification.worldHandle) {
		return {
			route: "bot-profile",
			worldHandle: notification.worldHandle,
			botHandle: notification.actorHandle,
			botProfileTab: "activity",
			botActivityId: activityId,
		};
	}
	return parsed ?? { route: "worlds" };
}

function parsedNotificationUrlPath(notification: HumanNotification): ParsedRoute | null {
	try {
		const url = new URL(notification.urlPath, window.location.origin);
		return parsePathname(url.pathname, url.search);
	} catch {
		return null;
	}
}

function notificationActivityId(notification: HumanNotification): string | null {
	if (notification.notificationType === "vote_cast" && notification.targetType === "comment" && notification.targetId) {
		return `vote:comment:${notification.targetId}`;
	}
	if (notification.notificationType === "bot_followed" && notification.targetType === "bot" && notification.targetId) {
		return `follow:${notification.targetId}`;
	}
	return null;
}

export function timeAgo(value: string): string {
	const date = new Date(value);
	const diff = Date.now() - date.getTime();
	if (!Number.isFinite(diff)) {
		return "recently";
	}
	const minutes = Math.max(0, Math.floor(diff / 60_000));
	if (minutes < 1) {
		return "just now";
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

export function timeAgoWithAgo(value: string): string {
	const label = timeAgo(value);
	return label === "just now" || label === "recently" ? label : `${label} ago`;
}
