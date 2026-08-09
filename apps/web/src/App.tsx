import {
	localizedText,
	type AuthProvider,
	type BotGroupSummary,
	type BotSummary,
	type BotTickSpreadResult,
	type AccountDeletionResult,
	type CommentDocument,
	type CreateForumInput,
	type CreateWorldInput,
	type ForumSummary,
	type HumanNotification,
	type HumanNotificationListScope,
	type HumanNotificationReadScope,
	type HumanNotificationSummary,
	type HumanSubscription,
	type HumanSubscriptionScope,
	type HumanSubscriptionTreeResponse,
	type PublicUser,
	type ThreadDocument,
	type ThreadSummary,
	type UpdateBotInput,
	type UpdateForumInput,
	type UpdateUserProfileInput,
	type UpdateWorldInput,
	type UserProfile,
	type WorldListSummary,
	type WorldSummary,
} from "@bickr/shared/model";
import { personalForumDescription } from "@bickr/shared/personal-forums";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
	Suspense,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { api } from "./api";
import { applyAccountDeletionResult } from "./profile-deletion";
import {
	adjustWorldCounts,
	botGroupWithBots,
	findKnownBot,
	hasOwn,
	publicUserFromProfile,
	renameThreadDocuments,
	renameThreadSummaries,
	profileWithPreservedTranslationInference,
	routeWithRenamedWorld,
	sortBotsForCascadeDelete,
	throwApiError,
	translationContextValue,
	updateThreadDocumentAuthorAvatar,
	updateThreadSummaryAuthorAvatar,
	visibleForums,
	worldAvatarMembersPromptSizeTitle,
} from "./app-records";
import {
	canonicalizeCurrentPath,
	clientRouteTitle,
	currentLocationPath,
	isStandaloneDisplayMode,
	parseBrowserRoute,
	readStoredFontScalePercent,
	readThemePreference,
	shouldHandleSpaAnchorClick,
	writeStoredFontScalePercent,
} from "./app-routing";
import "./App.css";
import { botAvatarTarget, userAvatarTarget, worldAvatarTarget } from "./avatar/target";
import { LoadingScreen, LoginScreen } from "./components/auth-screens";
import {
	HoverTooltipContext,
	Reference,
	ReferenceDataContext,
	TranslationContext,
	type HoverTooltipContextValue,
	type ReferenceData,
	type ReferenceKind,
	type TranslationContextValue,
	type WorldView,
} from "./components/content";
import {
	NavigationContext,
	SpaLink,
	type ContentRefType,
	type OpenContentRefOptions,
} from "./components/navigation";
import {
	UiTextContext,
	effectiveUiLocalePreference,
	languageDirection,
	useUiTextLocale,
} from "./components/ui-text";
import { lazyWithRetry } from "./dynamic-import";
import { fontScaleCssValue, type FontScalePercent } from "./font-scale";
import {
	defaultSearchRouteState,
	normalizeLoggedOutRoute,
	parsePathname,
	routePath,
	type BotProfileTab,
	type InferenceReturnTarget,
	type ParsedRoute,
	type Route,
	type SearchRouteState,
	type WorldTab,
} from "./routes";
import { createBotInputFromDraft, type BotDraft } from "./screens/bots/bot-drafts";
import {
	Sidebar,
	Topbar,
	authProviderLabel,
	banners,
	notificationRoute,
	type ThemePreference,
} from "./screens/chrome";
import { ForumPage, ThreadPage } from "./screens/forums";
import {
	humanNotificationSummaryWithReadScope,
	humanNotificationSummaryWithoutNotification,
	notificationThreadId,
} from "./screens/notifications/state";
import type { SubscriptionTarget } from "./screens/subscriptions";
import { WorldsScreen } from "./screens/worlds";
import { WorldDetail } from "./screens/worlds/world-detail";
import { WorldEditPage } from "./screens/worlds/world-edit";
import {
	Avatar,
	EmptyState,
	PermissionState,
	ToastProvider,
	hash,
} from "./ui";
import { runApiAction } from "./use-api";

type BotMutationResponse = { bot: BotSummary; affectedBots?: BotSummary[] };
type UserMutationResponse = { profile: UserProfile };

const BotAvatarGenerationScreen = lazyWithRetry(() =>
	import("./avatar/AvatarGenerationRoutes").then((module) => ({ default: module.BotAvatarGenerationScreen })),
);
const UserAvatarGenerationScreen = lazyWithRetry(() =>
	import("./avatar/AvatarGenerationRoutes").then((module) => ({ default: module.UserAvatarGenerationScreen })),
);
const WorldAvatarGenerationScreen = lazyWithRetry(() =>
	import("./avatar/AvatarGenerationRoutes").then((module) => ({ default: module.WorldAvatarGenerationScreen })),
);
const BotEdit = lazyWithRetry(() =>
	import("./screens/bots/edit").then((module) => ({ default: module.BotEdit })),
);
const BotLoopScreen = lazyWithRetry(() =>
	import("./screens/bots/runtime").then((module) => ({ default: module.BotLoopScreen })),
);
const BotProfileScreen = lazyWithRetry(() =>
	import("./screens/bots/profile").then((module) => ({ default: module.BotProfileScreen })),
);
const CreateBotModal = lazyWithRetry(() =>
	import("./screens/bots/create").then((module) => ({ default: module.CreateBotModal })),
);
const HumanProfileScreen = lazyWithRetry(() =>
	import("./screens/humans/public-profile").then((module) => ({ default: module.HumanProfileScreen })),
);
const ProfileScreen = lazyWithRetry(() =>
	import("./screens/humans/settings").then((module) => ({ default: module.ProfileScreen })),
);
const MyBotsScreen = lazyWithRetry(() =>
	import("./screens/my-bots").then((module) => ({ default: module.MyBotsScreen })),
);
const NotificationsScreen = lazyWithRetry(() =>
	import("./screens/notifications").then((module) => ({ default: module.NotificationsScreen })),
);
const AdvancedSearchScreen = lazyWithRetry(() =>
	import("./screens/search").then((module) => ({ default: module.AdvancedSearchScreen })),
);
const InferenceCostStatisticsScreen = lazyWithRetry(() =>
	import("./screens/search").then((module) => ({ default: module.InferenceCostStatisticsScreen })),
);
const SubscriptionsScreen = lazyWithRetry(() =>
	import("./screens/subscriptions").then((module) => ({ default: module.SubscriptionsScreen })),
);
const InferenceLibraryScreen = lazyWithRetry(() =>
	import("./inference/library").then((module) => ({ default: module.InferenceLibraryScreen })),
);
const InferenceConfigurationEditorScreen = lazyWithRetry(() =>
	import("./inference/editor").then((module) => ({ default: module.InferenceConfigurationEditorScreen })),
);

type BeforeInstallPromptEvent = Event & {
	platforms: string[];
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type SessionState = {
	authenticated: boolean;
	user: PublicUser | null;
};

function App() {
	const initialRoute = useMemo(() => parseBrowserRoute(), []);
	const [initializing, setInitializing] = useState(true);
	const [session, setSession] = useState<SessionState>({ authenticated: false, user: null });
	const [worlds, setWorlds] = useState<WorldListSummary[]>([]);
	const [forumsByWorld, setForumsByWorld] = useState<Record<string, ForumSummary[]>>({});
	const [bots, setBots] = useState<BotSummary[]>([]);
	const [botsByWorld, setBotsByWorld] = useState<Record<string, BotSummary[]>>({});
	const [botGroupsByWorld, setBotGroupsByWorld] = useState<Record<string, BotGroupSummary[]>>({});
	const [threadsByForum, setThreadsByForum] = useState<Record<string, ThreadSummary[]>>({});
	const [threadDocuments, setThreadDocuments] = useState<Record<string, ThreadDocument>>({});
	const [route, setRoute] = useState<Route>(initialRoute.route);
	const [activeWorldHandle, setActiveWorldHandle] = useState<string | null>(
		initialRoute.worldHandle ?? null,
	);
	const [activeForumHandle, setActiveForumHandle] = useState<string | null>(
		initialRoute.forumHandle ?? null,
	);
	const [activeThreadId, setActiveThreadId] = useState<string | null>(initialRoute.threadId ?? null);
	const [activeCommentId, setActiveCommentId] = useState<string | null>(initialRoute.commentId ?? null);
	const [activeBotHandle, setActiveBotHandle] = useState<string | null>(initialRoute.botHandle ?? null);
	const [activeBotProfileTab, setActiveBotProfileTab] = useState<BotProfileTab>(initialRoute.botProfileTab ?? "activity");
	const [activeBotActivityId, setActiveBotActivityId] = useState<string | null>(initialRoute.botActivityId ?? null);
	const [activeConfigurationId, setActiveConfigurationId] = useState<string | null>(initialRoute.configurationId ?? null);
	const [activeReturnTo, setActiveReturnTo] = useState<InferenceReturnTarget | null>(initialRoute.returnTo ?? null);
	const [activeHumanHandle, setActiveHumanHandle] = useState<string | null>(initialRoute.humanHandle ?? null);
	const [activeSearch, setActiveSearch] = useState<SearchRouteState>(initialRoute.search ?? defaultSearchRouteState);
	const [activeWorldTab, setActiveWorldTab] = useState<WorldTab>(initialRoute.worldTab ?? "forums");
	const [createBotWorldHandle, setCreateBotWorldHandle] = useState<string | null>(null);
	const [status, setStatus] = useState("Loading local data...");
	const [busy, setBusy] = useState(false);
	const [threadsLoading, setThreadsLoading] = useState(false);
	const [threadLoading, setThreadLoading] = useState(false);
	const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
	const [fontScalePercent, setFontScalePercent] = useState<FontScalePercent>(() => readStoredFontScalePercent());
	const [forumLoadedAtById, setForumLoadedAtById] = useState<Record<string, string>>({});
	const [threadLoadedAtById, setThreadLoadedAtById] = useState<Record<string, string>>({});
	const [freshThreadRequestVersion, setFreshThreadRequestVersion] = useState(0);
	const [threadActivityCheckVersionById, setThreadActivityCheckVersionById] = useState<Record<string, number>>({});
	const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
	const [humanNotifications, setHumanNotifications] = useState<HumanNotificationSummary>({
		unreadCount: 0,
		notifications: [],
	});
	const [subscriptions, setSubscriptions] = useState<HumanSubscription[]>([]);
	const [subscriptionTreeResponse, setSubscriptionTreeResponse] = useState<HumanSubscriptionTreeResponse | null>(null);
	const [activeTooltipId, setActiveTooltipId] = useState<string | null>(null);
	const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
	const [standaloneDisplay, setStandaloneDisplay] = useState(() => isStandaloneDisplayMode());
	const dismissingHumanNotificationRequests = useRef(new Map<string, Promise<boolean>>());
	const pendingFreshThreadIds = useRef(new Set<string>());

	useEffect(() => {
		void refreshAll();
	}, []);

	useEffect(() => {
		const onPopState = () => {
			const parsed = parseBrowserRoute();
			applyRoute(parsed);
			canonicalizeCurrentPath(parsed);
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	useEffect(() => {
		canonicalizeCurrentPath(initialRoute);
	}, [initialRoute]);

	useEffect(() => {
		const displayMode = window.matchMedia("(display-mode: standalone)");
		const updateStandaloneDisplay = () => setStandaloneDisplay(isStandaloneDisplayMode());
		const handleBeforeInstallPrompt = (event: Event) => {
			event.preventDefault();
			setInstallPromptEvent(event as BeforeInstallPromptEvent);
		};
		const handleAppInstalled = () => {
			setInstallPromptEvent(null);
			updateStandaloneDisplay();
		};
		window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
		window.addEventListener("appinstalled", handleAppInstalled);
		displayMode.addEventListener("change", updateStandaloneDisplay);
		updateStandaloneDisplay();
		return () => {
			window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
			window.removeEventListener("appinstalled", handleAppInstalled);
			displayMode.removeEventListener("change", updateStandaloneDisplay);
		};
	}, []);

	useEffect(() => {
		window.localStorage.setItem("bickr.theme", themePreference);
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const applyTheme = () => {
			const effective = themePreference === "system" ? (media.matches ? "dark" : "light") : themePreference;
			document.documentElement.dataset.theme = effective;
			document.documentElement.dataset.themePreference = themePreference;
		};
		applyTheme();
		media.addEventListener("change", applyTheme);
		return () => media.removeEventListener("change", applyTheme);
	}, [themePreference]);

	useLayoutEffect(() => {
		writeStoredFontScalePercent(fontScalePercent);
		document.documentElement.style.setProperty("--font-scale", fontScaleCssValue(fontScalePercent));
		document.documentElement.dataset.fontScalePercent = String(fontScalePercent);
	}, [fontScalePercent]);

	const effectiveUiLocale = useMemo(
		() => effectiveUiLocalePreference(session.user?.uiLocale),
		[session.user?.uiLocale],
	);
	const uiText = useUiTextLocale(effectiveUiLocale);
	const currentUser = session.authenticated ? session.user : null;
	const isAuthenticated = Boolean(currentUser);

	useEffect(() => {
		document.documentElement.lang = effectiveUiLocale;
		document.documentElement.dir = languageDirection(effectiveUiLocale);
		document.documentElement.dataset.uiLocale = effectiveUiLocale;
	}, [effectiveUiLocale]);

	useEffect(() => {
		if (activeWorldHandle) {
			void loadForums(activeWorldHandle);
			void loadWorldBots(activeWorldHandle);
			if (session.authenticated && session.user?.profileComplete) {
				void loadBotGroups(activeWorldHandle);
			}
		}
	}, [activeWorldHandle, session.authenticated, session.user?.id, session.user?.profileComplete]);

	useEffect(() => {
		if (!session.authenticated || !session.user) {
			setUserProfile(null);
			setBotGroupsByWorld({});
			setHumanNotifications({ unreadCount: 0, notifications: [] });
			setSubscriptions([]);
			setSubscriptionTreeResponse(null);
			return undefined;
		}
		if (!session.user.profileComplete) {
			setBotGroupsByWorld({});
			setHumanNotifications({ unreadCount: 0, notifications: [] });
			setSubscriptions([]);
			setSubscriptionTreeResponse(null);
			void loadUserProfile();
			return undefined;
		}
		void loadUserProfile();
		void loadHumanNotifications();
		void loadSubscriptions();
		const handle = window.setInterval(() => {
			if (document.visibilityState === "visible") {
				void loadHumanNotifications();
			}
		}, 30_000);
		return () => window.clearInterval(handle);
	}, [session.authenticated, session.user?.id]);

	useEffect(() => {
		if (currentUser && !currentUser.profileComplete && route !== "profile" && route !== "profile-avatar") {
			navigate({ route: "profile" }, true);
		}
	}, [route, currentUser?.id, currentUser?.profileComplete]);

	useEffect(() => {
		if (initializing || isAuthenticated) {
			return;
		}
		const normalized = normalizeLoggedOutRoute(currentParsedRoute());
		if (routePath(normalized.route) === currentLocationPath()) {
			return;
		}
		if (normalized.status) {
			setStatus(normalized.status);
		}
		navigate(normalized.route, true);
	}, [
		activeBotActivityId,
		activeBotHandle,
		activeBotProfileTab,
		activeCommentId,
		activeForumHandle,
		activeHumanHandle,
		activeSearch,
		activeThreadId,
		activeWorldHandle,
		activeWorldTab,
		initializing,
		isAuthenticated,
		route,
	]);

	const worldViews = useMemo<WorldView[]>(() => {
		return worlds.map((world) => {
			const loadedBots = botsByWorld[world.handle];
			const loadedForums = forumsByWorld[world.handle];
			return {
				...world,
				bannerIdx: hash(world.handle) % banners.length,
				botCount: loadedBots ? loadedBots.length : world.botCount,
				forumCount: loadedForums ? visibleForums(loadedForums).length : world.forumCount,
				isMine: Boolean(session.user && world.createdByUserId === session.user.id),
				myBotCount: bots.filter((bot) => bot.homeWorldHandle === world.handle).length,
			};
		});
	}, [bots, botsByWorld, forumsByWorld, session.user, worlds]);

	const activeWorld = useMemo(
		() => worldViews.find((world) => world.handle === activeWorldHandle) ?? null,
		[activeWorldHandle, worldViews],
	);
	const activeForums = activeWorld ? (forumsByWorld[activeWorld.handle] ?? []) : [];
	const activeForum = activeForums.find((forum) => forum.handle === activeForumHandle) ?? null;
	const activeBots = activeWorld ? (botsByWorld[activeWorld.handle] ?? bots.filter((bot) => bot.homeWorldHandle === activeWorld.handle)) : [];
	const activeBotGroups = activeWorld ? (botGroupsByWorld[activeWorld.handle] ?? []) : [];
	const activeThreads = activeForum ? (threadsByForum[activeForum.id] ?? []) : [];
	const activeThread = activeThreadId ? (threadDocuments[activeThreadId] ?? null) : null;
	const activeBot = useMemo(() => {
		if (!activeWorld || !activeBotHandle) {
			return null;
		}
		const publicBot = activeBots.find((bot) => bot.handle === activeBotHandle) ?? null;
		const ownedBot =
			bots.find((bot) => bot.homeWorldHandle === activeWorld.handle && bot.handle === activeBotHandle) ?? null;
		if (ownedBot?.ownerUserId === session.user?.id) {
			return publicBot ? { ...publicBot, ...ownedBot } : ownedBot;
		}
		return publicBot ?? ownedBot;
	}, [activeBotHandle, activeBots, activeWorld, bots, session.user?.id]);
	const editingBot = activeBot;
	const editingWorld =
		editingBot ? worldViews.find((world) => world.handle === editingBot.homeWorldHandle) ?? activeWorld : null;
	const createBotWorld =
		createBotWorldHandle ?
			worldViews.find((world) => world.handle === createBotWorldHandle) ?? null
		: null;
	const knownHumans = useMemo<PublicUser[]>(() => {
		const byId = new Map<string, PublicUser>();
		const add = (user: PublicUser | null | undefined) => {
			if (user) {
				byId.set(user.id, user);
			}
		};
		add(session.user);
		add(userProfile);
		for (const bot of bots) {
			add(bot.owner);
		}
		for (const worldBots of Object.values(botsByWorld)) {
			for (const bot of worldBots) {
				add(bot.owner);
			}
		}
		return [...byId.values()];
	}, [bots, botsByWorld, session.user, userProfile]);
	const referenceData = useMemo<ReferenceData>(
		() => ({
			activeWorldHandle,
			bots,
			botsByWorld,
			forumsByWorld,
			humans: knownHumans,
			worlds: worldViews,
		}),
		[activeWorldHandle, bots, botsByWorld, forumsByWorld, knownHumans, worldViews],
	);
	const hoverTooltip = useMemo<HoverTooltipContextValue>(
		() => ({
			activeId: activeTooltipId,
			clear: () => setActiveTooltipId(null),
			hide: (id) => setActiveTooltipId((current) => current === id ? null : current),
			show: (id) => setActiveTooltipId(id),
		}),
		[activeTooltipId],
	);
	const translationContext = useMemo<TranslationContextValue>(
		() => translationContextValue(userProfile),
		[userProfile],
	);
	const activeBotBlogForum =
		activeBot ? activeForums.find((forum) => forum.personalBotId === activeBot.id) ?? null : null;
	// Nonbinding completions for model fields, from the models this owner's
	// participants already use.
	const ownedBotModels = useMemo(() => {
		const models = new Set<string>();
		for (const bot of bots) {
			const model = bot.inferenceSettings.model?.trim();
			if (model) {
				models.add(model);
			}
		}
		return [...models].sort((left, right) => left.localeCompare(right));
	}, [bots]);
	const documentTitle = useMemo(
		() =>
			clientRouteTitle({
				bot: activeBot,
				botActivityId: activeBotActivityId,
				botHandle: activeBotHandle,
				botProfileTab: activeBotProfileTab,
				commentId: activeCommentId,
				forum: activeForum,
				forumHandle: activeForumHandle,
				humanHandle: activeHumanHandle,
				route,
				search: activeSearch,
				thread: activeThread,
				user: session.user,
				world: activeWorld,
				worldHandle: activeWorldHandle,
				worldTab: activeWorldTab,
			}),
		[
			activeBot,
			activeBotActivityId,
			activeBotHandle,
			activeBotProfileTab,
			activeCommentId,
			activeForum,
			activeForumHandle,
			activeHumanHandle,
			activeSearch,
			activeThread,
			activeWorld,
			activeWorldHandle,
			activeWorldTab,
			route,
			session.user,
		],
	);

	useEffect(() => {
		document.title = documentTitle;
	}, [documentTitle]);

	useEffect(() => {
		if (route === "forum" && activeForum) {
			void loadThreads(activeForum);
		}
	}, [route, activeForum?.id]);

	useEffect(() => {
		if ((route === "thread" || activeCommentId) && activeForum && activeThreadId) {
			const fresh = pendingFreshThreadIds.current.delete(activeThreadId);
			void loadThread(activeForum, activeThreadId, { fresh });
		}
	}, [route, activeForum?.id, activeThreadId, activeCommentId, freshThreadRequestVersion]);

	function applyRoute(parsed: ParsedRoute): void {
		setRoute(parsed.route);
		setActiveWorldHandle(parsed.worldHandle ?? null);
		setActiveForumHandle(parsed.forumHandle ?? null);
		setActiveThreadId(parsed.threadId ?? null);
		setActiveCommentId(parsed.commentId ?? null);
		setActiveBotHandle(parsed.botHandle ?? null);
		setActiveBotProfileTab(parsed.route === "bot-profile" ? parsed.botProfileTab ?? "activity" : "activity");
		setActiveBotActivityId(parsed.route === "bot-profile" ? parsed.botActivityId ?? null : null);
		setActiveConfigurationId(parsed.configurationId ?? null);
		setActiveReturnTo(parsed.returnTo ?? null);
		setActiveHumanHandle(parsed.humanHandle ?? null);
		setActiveSearch(parsed.route === "search" ? parsed.search ?? defaultSearchRouteState : defaultSearchRouteState);
		setActiveWorldTab(parsed.route === "world" ? parsed.worldTab ?? "forums" : "forums");
	}

	function navigate(parsed: ParsedRoute, replace = false): void {
		applyRoute(parsed);
		const nextPath = routePath(parsed);
		if (currentLocationPath() !== nextPath) {
			if (replace) {
				window.history.replaceState(null, "", nextPath);
			} else {
				window.history.pushState(null, "", nextPath);
			}
		}
	}

	function currentParsedRoute(): ParsedRoute {
		switch (route) {
			case "world":
				return { route, worldHandle: activeWorldHandle ?? undefined, worldTab: activeWorldTab };
			case "world-edit":
			case "world-avatar":
				return { route, worldHandle: activeWorldHandle ?? undefined };
			case "forum":
				return { route, worldHandle: activeWorldHandle ?? undefined, forumHandle: activeForumHandle ?? undefined };
			case "thread":
				return {
					route,
					worldHandle: activeWorldHandle ?? undefined,
					forumHandle: activeForumHandle ?? undefined,
					threadId: activeThreadId ?? undefined,
					commentId: activeCommentId ?? undefined,
				};
			case "bot-profile":
				return {
					route,
					worldHandle: activeWorldHandle ?? undefined,
					botHandle: activeBotHandle ?? undefined,
					botProfileTab: activeBotProfileTab,
					botActivityId: activeBotActivityId ?? undefined,
				};
			case "bot-avatar":
			case "bot-loop":
			case "bot-edit":
				return { route, worldHandle: activeWorldHandle ?? undefined, botHandle: activeBotHandle ?? undefined };
			case "human-profile":
				return { route, humanHandle: activeHumanHandle ?? undefined };
			case "inference-library":
				return { route, ...(activeReturnTo ? { returnTo: activeReturnTo } : {}) };
			case "inference-configuration":
				return {
					route,
					configurationId: activeConfigurationId ?? undefined,
					...(activeReturnTo ? { returnTo: activeReturnTo } : {}),
				};
			case "search":
				return { route, search: activeSearch };
			case "thread-ref":
				return { route, threadId: activeThreadId ?? undefined };
			case "comment-ref":
				return { route, commentId: activeCommentId ?? undefined };
			default:
				return { route };
		}
	}

	async function openContentRef(type: ContentRefType, id: string, options: OpenContentRefOptions = {}): Promise<void> {
		const result = await runApiAction(
			setStatus,
			() => api<{ path: string }>(`/api/content-refs/${type}/${encodeURIComponent(id)}`),
		);
		if (!result) {
			return;
		}
		const parsed = parsePathname(result.data.path);
		if (parsed.route === "thread" && parsed.threadId) {
			navigate(parsed, options.replace ?? false);
			return;
		}
		setStatus("Content link resolved to an unsupported route.");
	}

	useEffect(() => {
		if (route === "comment-ref" && activeCommentId) {
			setStatus("Opening link...");
			void openContentRef("comment", activeCommentId, { replace: true });
		}
		if (route === "thread-ref" && activeThreadId) {
			setStatus("Opening link...");
			void openContentRef("thread", activeThreadId, { replace: true });
		}
	}, [route, activeCommentId, activeThreadId]);

	function requestFreshThread(threadId: string): void {
		pendingFreshThreadIds.current.add(threadId);
		setFreshThreadRequestVersion((current) => current + 1);
	}

	function requestThreadActivityCheck(threadId: string): void {
		setThreadActivityCheckVersionById((current) => ({
			...current,
			[threadId]: (current[threadId] ?? 0) + 1,
		}));
	}

	function handleMainClick(event: ReactMouseEvent<HTMLElement>): void {
		if (event.defaultPrevented) {
			return;
		}
		const target = event.target;
		if (!(target instanceof Element)) {
			return;
		}
		const anchor = target.closest<HTMLAnchorElement>("a[data-fresh-thread-link][href]");
		if (!anchor || !event.currentTarget.contains(anchor) || !shouldHandleSpaAnchorClick(event, anchor)) {
			return;
		}
		const url = new URL(anchor.href, window.location.origin);
		if (url.origin !== window.location.origin) {
			return;
		}
		const parsed = parsePathname(url.pathname, url.search);
		if (parsed.route !== "thread" || !parsed.threadId) {
			return;
		}
		event.preventDefault();
		requestFreshThread(parsed.threadId);
		navigate(parsed);
	}

	async function refreshCurrentRoute(): Promise<void> {
		setBusy(true);
		try {
			if (route === "thread" && activeForum && activeThreadId) {
				await loadThread(activeForum, activeThreadId, { fresh: true });
				setStatus("Thread refreshed");
				return;
			}
			if (route === "forum" && activeForum) {
				await loadThreads(activeForum);
				setStatus("Forum refreshed");
				return;
			}
			if (
				(
					route === "world" ||
					route === "world-edit" ||
					route === "world-avatar" ||
					route === "bot-profile" ||
					route === "bot-avatar" ||
					route === "bot-loop" ||
					route === "bot-edit"
				) &&
				activeWorld
			) {
				await Promise.all([loadForums(activeWorld.handle), loadWorldBots(activeWorld.handle)]);
				setStatus("World refreshed");
				return;
			}
			if (route === "my-bots") {
				await loadBots();
				setStatus("Bots refreshed");
				return;
			}
			if (route === "notifications") {
				await loadHumanNotifications("all");
				setStatus("Notifications refreshed");
				return;
			}
			if (route === "subscriptions") {
				await loadSubscriptionTree();
				setStatus("Subscriptions refreshed");
				return;
			}
			await refreshAll();
		} finally {
			setBusy(false);
		}
	}

	async function refreshAll(): Promise<void> {
		setBusy(true);
		try {
			const [sessionResult, worldsResult] = await Promise.all([
				api<SessionState>("/api/session"),
				api<{ worlds: WorldListSummary[] }>("/api/worlds"),
			]);
			const nextSession: SessionState =
				sessionResult.ok ? sessionResult.data : { authenticated: false, user: null };

			if (sessionResult.ok) {
				setSession(nextSession);
				if (nextSession.authenticated && nextSession.user?.profileComplete) {
					await loadUserProfile();
				} else {
					setUserProfile(null);
				}
			} else {
				setSession({ authenticated: false, user: null });
				setUserProfile(null);
			}

			if (!worldsResult.ok) {
				throw new Error(worldsResult.message);
			}

			const nextWorlds = worldsResult.data.worlds;
			setWorlds(nextWorlds);
			setActiveWorldHandle((current) => {
				if (current && nextWorlds.some((world) => world.handle === current)) {
					return current;
				}
				return nextWorlds[0]?.handle ?? null;
			});

			if (nextSession.authenticated) {
				await loadBots();
			} else {
				setBots([]);
			}
			setStatus("Ready");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Failed to load app data.");
		} finally {
			setBusy(false);
			setInitializing(false);
		}
	}

	async function loadForums(worldHandle: string): Promise<ForumSummary[]> {
		const result = await api<{ forums: ForumSummary[] }>(
			`/api/worlds/${encodeURIComponent(worldHandle)}/forums`,
		);
		if (!result.ok) {
			setStatus(result.message);
			return [];
		}
		setForumsByWorld((current) => ({ ...current, [worldHandle]: result.data.forums }));
		setWorlds((current) =>
			current.map((world) =>
				world.handle === worldHandle ? { ...world, forumCount: visibleForums(result.data.forums).length } : world,
			),
		);
		return result.data.forums;
	}

	async function loadWorldBots(worldHandle: string): Promise<BotSummary[]> {
		const result = await api<{ bots: BotSummary[] }>(
			`/api/worlds/${encodeURIComponent(worldHandle)}/bots`,
		);
		if (!result.ok) {
			setStatus(result.message);
			return [];
		}
		setBotsByWorld((current) => ({ ...current, [worldHandle]: result.data.bots }));
		setWorlds((current) =>
			current.map((world) =>
				world.handle === worldHandle ? { ...world, botCount: result.data.bots.length } : world,
			),
		);
		return result.data.bots;
	}

	async function loadBotGroups(worldHandle: string): Promise<BotGroupSummary[]> {
		const result = await api<{ groups: BotGroupSummary[] }>(
			`/api/worlds/${encodeURIComponent(worldHandle)}/groups`,
		);
		if (!result.ok) {
			if (result.error !== "unauthorized" && result.error !== "forbidden") {
				setStatus(result.message);
			}
			setBotGroupsByWorld((current) => ({ ...current, [worldHandle]: [] }));
			return [];
		}
		setBotGroupsByWorld((current) => ({ ...current, [worldHandle]: result.data.groups }));
		return result.data.groups;
	}

	async function loadThreads(forum: ForumSummary, sort = "hot"): Promise<ThreadSummary[]> {
		setThreadsLoading(true);
		const result = await api<{ threads: ThreadSummary[]; loadedAt?: string }>(
			`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads?sort=${encodeURIComponent(sort)}`,
		);
		setThreadsLoading(false);
		if (!result.ok) {
			setStatus(result.message);
			return [];
		}
		setThreadsByForum((current) => ({ ...current, [forum.id]: result.data.threads }));
		if (result.data.loadedAt) {
			setForumLoadedAtById((current) => ({ ...current, [forum.id]: result.data.loadedAt! }));
		}
		return result.data.threads;
	}

	async function loadThread(
		forum: ForumSummary,
		threadId: string,
		options: { fresh?: boolean } = {},
	): Promise<ThreadDocument | null> {
		setThreadLoading(true);
		const params = options.fresh ? "?fresh=1" : "";
		const result = await api<{ thread: ThreadDocument; loadedAt?: string }>(
			`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(threadId)}${params}`,
		);
		setThreadLoading(false);
		if (!result.ok) {
			setStatus(result.message);
			return null;
		}
		setThreadDocuments((current) => ({ ...current, [result.data.thread.id]: result.data.thread }));
		if (result.data.loadedAt) {
			setThreadLoadedAtById((current) => ({ ...current, [result.data.thread.id]: result.data.loadedAt! }));
		}
		return result.data.thread;
	}

	async function loadBots(): Promise<BotSummary[]> {
		const result = await api<{ bots: BotSummary[] }>("/api/me/bots");
		if (result.ok) {
			setBots(result.data.bots);
			return result.data.bots;
		}
		if (result.error === "unauthorized") {
			setBots([]);
			return [];
		}
		throw new Error(result.message);
	}

	async function loadUserProfile(): Promise<UserProfile | null> {
		const result = await api<{ profile: UserProfile }>("/api/me/profile");
		if (result.ok) {
			setUserProfile(result.data.profile);
			return result.data.profile;
		}
		if (result.error === "unauthorized") {
			setUserProfile(null);
			return null;
		}
		setStatus(result.message);
		return null;
	}

	async function fetchHumanNotifications(
		status: "unread" | "all" = "unread",
		limit = status === "all" ? 50 : 30,
		offset = 0,
		scope: HumanNotificationListScope = { scopeType: "all" },
	): Promise<HumanNotificationSummary | null> {
		const params = new URLSearchParams({
			status,
			limit: String(limit),
		});
		if (offset > 0) {
			params.set("offset", String(offset));
		}
		if (scope.scopeType !== "all") {
			params.set("scopeType", scope.scopeType);
			params.set("scopeId", scope.scopeId);
		}
		const result = await api<HumanNotificationSummary>(`/api/me/notifications?${params}`);
		if (result.ok) {
			return result.data;
		}
		setStatus(result.message);
		return null;
	}

	async function loadHumanNotifications(status: "unread" | "all" = "unread"): Promise<HumanNotificationSummary | null> {
		const summary = await fetchHumanNotifications(status, status === "all" ? 50 : 30);
		if (summary) {
			setHumanNotifications(summary);
			if (activeThreadId && summary.notifications.some((notification) => notificationThreadId(notification) === activeThreadId)) {
				requestThreadActivityCheck(activeThreadId);
			}
		}
		return summary;
	}

	async function loadSubscriptions(): Promise<HumanSubscription[]> {
		const result = await api<{ subscriptions: HumanSubscription[] }>("/api/me/subscriptions");
		if (result.ok) {
			setSubscriptions(result.data.subscriptions);
			return result.data.subscriptions;
		}
		return [];
	}

	async function loadSubscriptionTree(): Promise<HumanSubscriptionTreeResponse | null> {
		const result = await api<HumanSubscriptionTreeResponse>("/api/me/subscriptions?view=tree");
		if (result.ok) {
			setSubscriptionTreeResponse(result.data);
			setSubscriptions(result.data.subscriptions);
			return result.data;
		}
		setStatus(result.message);
		return null;
	}

	function isSubscribed(scopeType: HumanSubscriptionScope, scopeId: string): boolean {
		return subscriptions.some((subscription) =>
			subscription.scopeType === scopeType && subscription.scopeId === scopeId && subscription.active,
		);
	}

	async function toggleSubscription(target: SubscriptionTarget, active: boolean): Promise<void> {
		if (!session.user) {
			return;
		}
		if (!profileReadyFor("watching threads, forums, worlds, or bots")) {
			return;
		}
		const previous = subscriptions;
		const optimistic: HumanSubscription = {
			id: `local:${target.scopeType}:${target.scopeId}`,
			userId: session.user.id,
			worldId: target.worldId,
			scopeType: target.scopeType,
			scopeId: target.scopeId,
			active,
			autoCreated: false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		setSubscriptionTreeResponse(null);
		setSubscriptions((current) => {
			const rest = current.filter(
				(subscription) =>
					!(subscription.scopeType === target.scopeType && subscription.scopeId === target.scopeId),
			);
			return active ? [optimistic, ...rest] : [{ ...optimistic, active: false }, ...rest];
		});
		const result = await api<{ subscription?: HumanSubscription }>("/api/me/subscriptions", {
			method: active ? "PUT" : "DELETE",
			body: target,
		});
		if (!result.ok) {
			setSubscriptions(previous);
			setStatus(result.message);
			return;
		}
		if (active && result.data.subscription) {
			setSubscriptions((current) => [
				result.data.subscription!,
				...current.filter(
					(subscription) =>
						!(
							subscription.scopeType === target.scopeType &&
							subscription.scopeId === target.scopeId
						),
				),
			]);
		}
	}

	async function markHumanNotificationReadState(
		notification: HumanNotification,
		options: { removeUnread?: boolean } = { removeUnread: true },
	): Promise<string | null> {
		const result = await runApiAction(setStatus, () => api(`/api/me/notifications/${encodeURIComponent(notification.id)}`, {
			method: "PATCH",
			body: { read: true },
		}));
		if (!result) {
			return null;
		}
		const wasUnread = !notification.readAt;
		const readAt = notification.readAt ?? new Date().toISOString();
		const removeFromList = wasUnread && options.removeUnread !== false;
		setHumanNotifications((current) => ({
			...current,
			unreadCount: Math.max(0, current.unreadCount - (wasUnread ? 1 : 0)),
			notifications:
				removeFromList ?
					current.notifications.filter((item) => item.id !== notification.id)
				:	current.notifications.map((item) =>
						item.id === notification.id ? { ...item, readAt: item.readAt ?? readAt } : item,
					),
		}));
		return readAt;
	}

	async function dismissHumanNotification(notification: HumanNotification): Promise<boolean> {
		const existing = dismissingHumanNotificationRequests.current.get(notification.id);
		if (existing) {
			return existing;
		}
		const request = (async () => {
			const result = await runApiAction(setStatus, () => api(`/api/me/notifications/${encodeURIComponent(notification.id)}`, {
				method: "PATCH",
				body: { archived: true },
			}));
			if (!result) {
				return false;
			}
			setHumanNotifications((current) => humanNotificationSummaryWithoutNotification(current, notification));
			return true;
		})();
		dismissingHumanNotificationRequests.current.set(notification.id, request);
		const dismissed = await request;
		if (!dismissed) {
			dismissingHumanNotificationRequests.current.delete(notification.id);
		}
		return dismissed;
	}

	async function openHumanNotification(notification: HumanNotification): Promise<void> {
		const readAt = await markHumanNotificationReadState(notification, { removeUnread: true });
		if (!readAt) {
			return;
		}
		const parsed = notificationRoute(notification);
		if (parsed.route === "thread" && parsed.threadId) {
			requestFreshThread(parsed.threadId);
		}
		navigate(parsed);
		await loadHumanNotifications("unread");
	}

	async function markAllNotificationsRead(scope: HumanNotificationReadScope = { scopeType: "all" }): Promise<number | null> {
		if (!profileReadyFor("managing notifications")) {
			return null;
		}
		const result = await runApiAction(setStatus, () => api<{ readAll: true; readCount: number }>("/api/me/notifications/read-all", {
			method: "POST",
			body: scope,
		}));
		if (!result) {
			return null;
		}
		const readAt = new Date().toISOString();
		setHumanNotifications((current) =>
			humanNotificationSummaryWithReadScope(current, scope, readAt, result.data.readCount),
		);
		return result.data.readCount;
	}

	async function startBotTick(bot: BotSummary): Promise<{ bot: BotSummary; error?: string; status: string }> {
		if (!bot.tickSettings.enabled) {
			return {
				bot,
				error: "This participant is paused. Unpause it before starting a loop run.",
				status: "paused",
			};
		}
		try {
			const result = await api<{ run: { runId: string; status: string; error?: string } }>(
				`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/tick`,
				{ method: "POST", body: { background: true } },
			);
			if (!result.ok) {
				return { bot, error: result.message, status: "failed" };
			}
			return { bot, error: result.data.run.error, status: result.data.run.status };
		} catch (error) {
			return {
				bot,
				error: error instanceof Error ? error.message : "Request failed.",
				status: "failed",
			};
		}
	}

	async function runBotTick(bot: BotSummary): Promise<void> {
		if (!profileReadyFor("running bot actions")) {
			return;
		}
		setStatus(`Starting tick for u/${bot.handle}...`);
		const result = await startBotTick(bot);
		if (result.status === "started") {
			setStatus(`Started tick for u/${bot.handle}.`);
			return;
		}
		if (result.status === "already_running") {
			setStatus(`u/${bot.handle} already has a tick running.`);
			return;
		}
		if (result.status === "paused") {
			setStatus(`u/${bot.handle} is paused. Unpause it before starting a loop run.`);
			return;
		}
		setStatus(result.error ? `Could not start tick for u/${bot.handle}: ${result.error}` : `Tick ${result.status} for u/${bot.handle}.`);
	}

	async function runBotTicks(label: string, targetBots: BotSummary[]): Promise<void> {
		if (!profileReadyFor("running bot actions")) {
			return;
		}
		if (targetBots.length === 0) {
			setStatus(`No bots selected for ${label}.`);
			return;
		}
		setStatus(`Starting ticks for ${targetBots.length} bot${targetBots.length === 1 ? "" : "s"} in ${label}...`);
		const results = await Promise.all(targetBots.map((bot) => startBotTick(bot)));
		const started = results.filter((result) => result.status === "started").length;
		const alreadyRunning = results.filter((result) => result.status === "already_running").length;
		const paused = results.filter((result) => result.status === "paused").length;
		const failed = results.filter((result) => !["started", "already_running", "paused"].includes(result.status)).length;
		setStatus(
			`${label}: ${started} started${alreadyRunning ? `, ${alreadyRunning} already running` : ""}${paused ? `, ${paused} paused` : ""}${failed ? `, ${failed} failed` : ""}.`,
		);
	}

	async function spreadBotTicks(): Promise<BotTickSpreadResult | null> {
		if (!profileReadyFor("editing bots")) {
			return null;
		}
		let spread: BotTickSpreadResult | null = null;
		const ok = await submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ spread: BotTickSpreadResult }>("/api/me/bots/spread-ticks", {
				method: "POST",
			}));
			spread = result.data.spread;
			applySavedBots(spread.bots);
			const skipped = spread.skipped.paused + spread.skipped.running;
			return `Spread ticks for ${spread.scheduled.length} bot${spread.scheduled.length === 1 ? "" : "s"}${skipped ? `; ${skipped} unchanged` : ""}.`;
		});
		return ok ? spread : null;
	}

	async function startBot(bot: BotSummary): Promise<void> {
		if (bot.tickSettings.enabled) {
			void runBotTick(bot);
			return;
		}
		const ok = await updateBot(bot.id, { tickSettings: { enabled: true } });
		if (ok) {
			setStatus(`Started bot ${bot.handle}. Its next tick will be scheduled ASAP.`);
		}
	}

	async function submit(action: () => Promise<string | void>): Promise<boolean> {
		setBusy(true);
		try {
			const message = await action();
			if (message) {
				setStatus(message);
			}
			return true;
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Request failed.");
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function createWorld(input: CreateWorldInput): Promise<boolean> {
		if (!profileReadyFor("creating worlds")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ world: WorldSummary }>("/api/worlds", {
				method: "POST",
				body: input,
			}));
			const createdWorld: WorldListSummary = { ...result.data.world, forumCount: 1, botCount: 0 };
			setWorlds((current) => [createdWorld, ...current.filter((world) => world.id !== createdWorld.id)]);
			navigate({ route: "world", worldHandle: createdWorld.handle });
			return `Created world ${createdWorld.handle}.`;
		});
	}

	async function updateWorld(worldHandle: string, input: UpdateWorldInput): Promise<boolean> {
		if (!profileReadyFor("editing worlds")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ world: WorldSummary }>(`/api/worlds/${encodeURIComponent(worldHandle)}`, {
				method: "PATCH",
				body: input,
			}));
			const savedWorld = result.data.world;
			const renamed = savedWorld.handle !== worldHandle;
			setWorlds((current) =>
				current.map((world) => world.id === savedWorld.id ? { ...world, ...savedWorld } : world),
			);
			if (renamed) {
				setForumsByWorld((current) => {
					const next = { ...current };
					const renamedForums = next[worldHandle]?.map((forum) => ({ ...forum, worldHandle: savedWorld.handle }));
					delete next[worldHandle];
					if (renamedForums) {
						next[savedWorld.handle] = renamedForums;
					}
					return next;
				});
				setBotsByWorld((current) => {
					const next = { ...current };
					const renamedBots = next[worldHandle]?.map((bot) => ({ ...bot, homeWorldHandle: savedWorld.handle }));
					delete next[worldHandle];
					if (renamedBots) {
						next[savedWorld.handle] = renamedBots;
					}
					return next;
				});
				setBotGroupsByWorld((current) => {
					const next = { ...current };
					const renamedGroups = next[worldHandle];
					delete next[worldHandle];
					if (renamedGroups) {
						next[savedWorld.handle] = renamedGroups;
					}
					return next;
				});
				setBots((current) =>
					current.map((bot) => bot.homeWorldHandle === worldHandle ? { ...bot, homeWorldHandle: savedWorld.handle } : bot),
				);
				setThreadsByForum((current) => renameThreadSummaries(current, { worldHandle, nextWorldHandle: savedWorld.handle }));
				setThreadDocuments((current) => renameThreadDocuments(current, { worldHandle, nextWorldHandle: savedWorld.handle }));
				if (activeWorldHandle === worldHandle) {
					navigate(routeWithRenamedWorld(
						{
							route,
							worldHandle,
							forumHandle: activeForumHandle ?? undefined,
							threadId: activeThreadId ?? undefined,
							commentId: activeCommentId ?? undefined,
							botHandle: activeBotHandle ?? undefined,
							botProfileTab: activeBotProfileTab,
							botActivityId: activeBotActivityId ?? undefined,
							worldTab: activeWorldTab,
						},
						savedWorld.handle,
					), true);
				}
			}
			return `Saved world ${savedWorld.handle}.`;
		});
	}

	async function deleteWorld(world: WorldView): Promise<boolean> {
		if (!profileReadyFor("deleting worlds")) {
			return false;
		}
		return submit(async () => {
			await runApiAction(throwApiError, () => api<{ world: WorldSummary }>(`/api/worlds/${encodeURIComponent(world.handle)}`, {
				method: "DELETE",
			}));
			setWorlds((current) => current.filter((item) => item.id !== world.id));
			setForumsByWorld((current) => {
				const next = { ...current };
				delete next[world.handle];
				return next;
			});
			setBotsByWorld((current) => {
				const next = { ...current };
				delete next[world.handle];
				return next;
			});
			setBotGroupsByWorld((current) => {
				const next = { ...current };
				delete next[world.handle];
				return next;
			});
			if (activeWorldHandle === world.handle) {
				navigate({ route: "worlds" });
			}
			// Deleting a world removes its fixed configuration and every fixed
			// configuration of the participants it took with it, so the account's
			// translation annotation is reread for the repaired ancestry.
			void loadUserProfile();
			return `Deleted world ${world.handle}.`;
		});
	}

	async function createForum(worldHandle: string, input: CreateForumInput): Promise<boolean> {
		if (!profileReadyFor("creating forums")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ forum: ForumSummary }>(
				`/api/worlds/${encodeURIComponent(worldHandle)}/forums`,
				{
					method: "POST",
					body: input,
				},
			));
			setWorlds((current) => adjustWorldCounts(current, worldHandle, { forumCount: 1 }));
			setForumsByWorld((current) => ({
				...current,
				...(hasOwn(current, worldHandle) ?
					{ [worldHandle]: [result.data.forum, ...(current[worldHandle] ?? [])] }
				:	{}),
			}));
			return `Created forum ${result.data.forum.handle}.`;
		});
	}

	async function updateForum(forum: ForumSummary, input: UpdateForumInput): Promise<boolean> {
		if (!profileReadyFor("editing forums")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ forum: ForumSummary }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}`,
				{
					method: "PATCH",
					body: input,
				},
			));
			const savedForum = result.data.forum;
			const renamed = savedForum.handle !== forum.handle;
			setForumsByWorld((current) => ({
				...current,
				[forum.worldHandle]: (current[forum.worldHandle] ?? []).map((item) =>
					item.id === forum.id ? savedForum : item,
				),
			}));
			if (renamed) {
				setThreadsByForum((current) =>
					renameThreadSummaries(current, { forumId: forum.id, forumHandle: forum.handle, nextForumHandle: savedForum.handle }),
				);
				setThreadDocuments((current) =>
					renameThreadDocuments(current, { forumId: forum.id, forumHandle: forum.handle, nextForumHandle: savedForum.handle }),
				);
				if (activeForum?.id === forum.id) {
					navigate(
						route === "thread" && activeThreadId ?
							{
								route: "thread",
								worldHandle: savedForum.worldHandle,
								forumHandle: savedForum.handle,
								threadId: activeThreadId,
								...(activeCommentId ? { commentId: activeCommentId } : {}),
							}
						:	{ route: "forum", worldHandle: savedForum.worldHandle, forumHandle: savedForum.handle },
						true,
					);
				}
			}
			return `Saved forum ${savedForum.handle}.`;
		});
	}

	async function deleteForum(forum: ForumSummary): Promise<boolean> {
		if (!profileReadyFor("deleting forums")) {
			return false;
		}
		return submit(async () => {
			await runApiAction(throwApiError, () => api<{ forum: ForumSummary }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}`,
				{ method: "DELETE" },
			));
			setWorlds((current) => adjustWorldCounts(current, forum.worldHandle, { forumCount: -1 }));
			setForumsByWorld((current) => ({
				...current,
				...(hasOwn(current, forum.worldHandle) ?
					{ [forum.worldHandle]: (current[forum.worldHandle] ?? []).filter((item) => item.id !== forum.id) }
				:	{}),
			}));
			setThreadsByForum((current) => {
				const next = { ...current };
				delete next[forum.id];
				return next;
			});
			if (activeForum?.id === forum.id) {
				navigate({ route: "world", worldHandle: forum.worldHandle });
			}
			return `Deleted forum ${forum.handle}.`;
		});
	}

	function saveBotGroup(worldHandle: string, group: BotGroupSummary): void {
		setBotGroupsByWorld((current) => ({
			...current,
			[worldHandle]: [
				...((current[worldHandle] ?? []).some((item) => item.id === group.id) ? [] : [group]),
				...(current[worldHandle] ?? []).map((item) => item.id === group.id ? group : item),
			],
		}));
	}

	async function createBotGroup(world: WorldView): Promise<boolean> {
		if (!profileReadyFor("creating groups")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ group: BotGroupSummary }>(
					`/api/worlds/${encodeURIComponent(world.handle)}/groups`,
					{
						method: "POST",
						body: { language: world.language, customTitle: null },
					},
			));
			saveBotGroup(world.handle, result.data.group);
			return "Created group.";
		});
	}

	async function updateBotGroupTitle(world: WorldView, group: BotGroupSummary, customTitle: string | null): Promise<boolean> {
		if (!profileReadyFor("editing groups")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ group: BotGroupSummary }>(
					`/api/worlds/${encodeURIComponent(world.handle)}/groups/${encodeURIComponent(group.id)}`,
					{
						method: "PATCH",
						body: {
							language: group.language ?? world.language,
							customTitle: customTitle ? localizedText(customTitle, group.language ?? world.language) : null,
						},
					},
			));
			saveBotGroup(world.handle, result.data.group);
			return "Saved group title.";
		});
	}

	async function deleteBotGroup(world: WorldView, group: BotGroupSummary): Promise<boolean> {
		if (!profileReadyFor("deleting groups")) {
			return false;
		}
		return submit(async () => {
			await runApiAction(throwApiError, () => api<{ group: BotGroupSummary }>(
				`/api/worlds/${encodeURIComponent(world.handle)}/groups/${encodeURIComponent(group.id)}`,
				{ method: "DELETE" },
			));
			setBotGroupsByWorld((current) => ({
				...current,
				[world.handle]: (current[world.handle] ?? []).filter((item) => item.id !== group.id),
			}));
			return "Deleted group.";
		});
	}

	async function addBotGroupMembers(world: WorldView, group: BotGroupSummary, botIds: string[]): Promise<boolean> {
		if (!profileReadyFor("editing groups")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ group: BotGroupSummary }>(
				`/api/worlds/${encodeURIComponent(world.handle)}/groups/${encodeURIComponent(group.id)}/bots`,
				{
					method: "POST",
					body: { botIds },
				},
			));
			saveBotGroup(world.handle, result.data.group);
			return `Added ${botIds.length} bot${botIds.length === 1 ? "" : "s"} to group.`;
		});
	}

	async function removeBotGroupMember(world: WorldView, group: BotGroupSummary, bot: BotSummary): Promise<boolean> {
		if (!profileReadyFor("editing groups")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ group: BotGroupSummary }>(
				`/api/worlds/${encodeURIComponent(world.handle)}/groups/${encodeURIComponent(group.id)}/bots/${encodeURIComponent(bot.id)}`,
				{ method: "DELETE" },
			));
			saveBotGroup(world.handle, result.data.group);
			return `Removed ${bot.handle} from group.`;
		});
	}

	async function createBot(worldHandle: string, draft: BotDraft): Promise<boolean> {
		if (!profileReadyFor("creating bots")) {
			return false;
		}
		return submit(async () => {
			const input = createBotInputFromDraft(draft);
			const result = await runApiAction(throwApiError, () => api<{ bot: BotSummary }>(
				`/api/worlds/${encodeURIComponent(worldHandle)}/bots`,
				{
					method: "POST",
					body: input,
				},
			));
			const createdBot = {
				...result.data.bot,
				lastActiveAt: result.data.bot.lastActiveAt ?? result.data.bot.createdAt,
			};
			setWorlds((current) => adjustWorldCounts(current, worldHandle, { botCount: 1 }));
			setBots((current) => [createdBot, ...current.filter((bot) => bot.id !== createdBot.id)]);
			setBotsByWorld((current) => ({
				...current,
				...(hasOwn(current, worldHandle) ?
					{ [worldHandle]: [createdBot, ...(current[worldHandle] ?? []).filter((bot) => bot.id !== createdBot.id)] }
				:	{}),
			}));
			setCreateBotWorldHandle(null);
			navigate({
				route: "bot-profile",
				worldHandle,
				botHandle: createdBot.handle,
			});
			void loadForums(worldHandle).catch((error) => {
				setStatus(error instanceof Error ? error.message : "Could not refresh forums after creating bot.");
			});
			void loadSubscriptions().catch((error) => {
				setStatus(error instanceof Error ? error.message : "Could not refresh subscriptions after creating bot.");
			});
			return `Created bot ${createdBot.handle}. It starts paused; open Loop and unpause it when setup is ready.`;
		});
	}

	async function deleteThread(forum: ForumSummary, thread: ThreadDocument | ThreadSummary): Promise<boolean> {
		if (!profileReadyFor("deleting threads")) {
			return false;
		}
		return submit(async () => {
			await runApiAction(throwApiError, () => api<{ thread: ThreadDocument }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(thread.id)}`,
				{ method: "DELETE" },
			));
			setThreadsByForum((current) => ({
				...current,
				[forum.id]: (current[forum.id] ?? []).filter((item) => item.id !== thread.id),
			}));
			setThreadDocuments((current) => {
				const next = { ...current };
				delete next[thread.id];
				return next;
			});
			if (activeThreadId === thread.id) {
				navigate({ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle });
			}
			return "Deleted thread.";
		});
	}

	async function deleteComment(forum: ForumSummary, thread: ThreadDocument, comment: CommentDocument): Promise<boolean> {
		if (!profileReadyFor("deleting comments")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ thread: ThreadDocument }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(thread.id)}/comments/${encodeURIComponent(comment.id)}`,
				{ method: "DELETE" },
			));
			setThreadDocuments((current) => ({ ...current, [result.data.thread.id]: result.data.thread }));
			setThreadsByForum((current) => ({
				...current,
				[forum.id]: (current[forum.id] ?? []).map((item) =>
					item.id === result.data.thread.id ?
						{
							...item,
							commentCount: result.data.thread.commentCount,
							lastActivityAt: result.data.thread.lastActivityAt,
						}
					:	item,
				),
			}));
			return "Deleted comment.";
		});
	}

	async function updateBot(botId: string, draft: UpdateBotInput): Promise<boolean> {
		if (!profileReadyFor("editing bots")) {
			return false;
		}
		const previousBot = findKnownBot(botId, bots, botsByWorld);
		const previousPersonalForum =
			previousBot ?
				(forumsByWorld[previousBot.homeWorldHandle] ?? []).find(
					(forum) => forum.personalBotId === previousBot.id && forum.handle === previousBot.handle,
				) ?? null
			:	null;
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<BotMutationResponse>(`/api/me/bots/${encodeURIComponent(botId)}`, {
				method: "PATCH",
				body: draft,
			}));
			const savedBot = result.data.bot;
			const renamed = Boolean(previousBot && previousBot.handle !== savedBot.handle);
			applySavedBots([savedBot, ...(result.data.affectedBots ?? [])]);
			if (previousBot) {
				setForumsByWorld((current) => ({
					...current,
					[savedBot.homeWorldHandle]: (current[savedBot.homeWorldHandle] ?? []).map((forum) =>
							forum.personalBotId === savedBot.id ?
								{
									...forum,
									handle: forum.handle === previousBot.handle ? savedBot.handle : forum.handle,
									language: savedBot.language,
									description: personalForumDescription(savedBot),
								}
							:	forum,
						),
				}));
				if (renamed && previousPersonalForum) {
					setThreadsByForum((current) =>
						renameThreadSummaries(current, {
							forumId: previousPersonalForum.id,
							forumHandle: previousPersonalForum.handle,
							nextForumHandle: savedBot.handle,
						}),
					);
					setThreadDocuments((current) =>
						renameThreadDocuments(current, {
							forumId: previousPersonalForum.id,
							forumHandle: previousPersonalForum.handle,
							nextForumHandle: savedBot.handle,
						}),
					);
				}
				if (activeBot?.id === savedBot.id && (route === "bot-profile" || route === "bot-avatar" || route === "bot-loop" || route === "bot-edit")) {
					navigate({
						route,
						worldHandle: savedBot.homeWorldHandle,
						botHandle: savedBot.handle,
						...(route === "bot-profile" ? { botProfileTab: activeBotProfileTab, botActivityId: activeBotActivityId ?? undefined } : {}),
					}, true);
				}
			}
			return `Saved bot ${savedBot.handle}.`;
		});
	}

	async function unlinkBotClone(bot: BotSummary): Promise<boolean> {
		if (!profileReadyFor("editing bots")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<BotMutationResponse>(`/api/me/bots/${encodeURIComponent(bot.id)}/clone/unlink`, {
				method: "POST",
			}));
			applySavedBots([result.data.bot, ...(result.data.affectedBots ?? [])]);
			return `Unlinked bot ${result.data.bot.handle}.`;
		});
	}

	async function relinkBotClone(bot: BotSummary): Promise<boolean> {
		if (!profileReadyFor("editing bots")) {
			return false;
		}
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<BotMutationResponse>(`/api/me/bots/${encodeURIComponent(bot.id)}/clone/relink`, {
				method: "POST",
			}));
			applySavedBots([result.data.bot, ...(result.data.affectedBots ?? [])]);
			return `Relinked bot ${result.data.bot.handle}.`;
		});
	}

	async function deleteBotAvatar(bot: BotSummary): Promise<boolean> {
		if (!profileReadyFor("editing bots")) {
			return false;
		}
		return submit(async () => {
			const target = botAvatarTarget(bot);
			const result = await runApiAction(throwApiError, () => api<BotMutationResponse>(target.endpoints.clear, {
				method: "DELETE",
			}));
			applySavedBots([result.data.bot, ...(result.data.affectedBots ?? [])]);
			return `Deleted avatar for ${result.data.bot.handle}.`;
		});
	}

	function applySavedBot(savedBot: BotSummary, affectedBots: BotSummary[] = []): void {
		applySavedBots([savedBot, ...affectedBots]);
	}

	function applySavedWorld(savedWorld: WorldSummary): void {
		setWorlds((current) =>
			current.map((world) => world.id === savedWorld.id ? { ...world, ...savedWorld } : world),
		);
	}

	function applySavedBots(savedBots: BotSummary[]): void {
		if (savedBots.length === 0) {
			return;
		}
		const savedById = new Map(savedBots.map((bot) => [bot.id, bot]));
		setBots((current) =>
			current.map((bot) =>
				savedById.has(bot.id) ?
					{
						...savedById.get(bot.id)!,
						lastActiveAt: savedById.get(bot.id)!.lastActiveAt ?? bot.lastActiveAt ?? bot.createdAt,
					}
				:	bot,
			),
		);
		setBotsByWorld((current) => {
			const next = { ...current };
			for (const worldHandle of Object.keys(next)) {
				next[worldHandle] = (next[worldHandle] ?? []).map((bot) => {
					const saved = savedById.get(bot.id);
					return saved ? { ...saved, lastActiveAt: saved.lastActiveAt ?? bot.lastActiveAt ?? bot.createdAt } : bot;
				});
			}
			return next;
		});
		setBotGroupsByWorld((current) => {
			const next: Record<string, BotGroupSummary[]> = {};
			for (const [worldHandle, groups] of Object.entries(current)) {
				next[worldHandle] = groups.map((group) => {
					const nextBots = group.bots.map((bot) => {
						const saved = savedById.get(bot.id);
						return saved ? { ...saved, lastActiveAt: saved.lastActiveAt ?? bot.lastActiveAt ?? bot.createdAt } : bot;
					});
					return botGroupWithBots(group, nextBots);
				});
			}
			return next;
		});
		for (const savedBot of savedBots) {
			const avatarUrl = savedBot.avatarUrl;
			setThreadsByForum((current) => avatarUrl ? updateThreadSummaryAuthorAvatar(current, savedBot.id, avatarUrl, savedBot.avatarCrop) : current);
			setThreadDocuments((current) => avatarUrl ? updateThreadDocumentAuthorAvatar(current, savedBot.id, avatarUrl, savedBot.avatarCrop) : current);
		}
	}

	function applySavedUserProfile(profile: UserProfile): void {
		setUserProfile((current) => profileWithPreservedTranslationInference(current, profile));
		setSession((current) => ({
			...current,
			user: publicUserFromProfile(profile),
		}));
	}

	async function updateProfile(draft: UpdateUserProfileInput): Promise<UserProfile | null> {
		let saved: UserProfile | null = null;
		const ok = await submit(async () => {
			const result = await runApiAction(throwApiError, () => api<UserMutationResponse>("/api/me/profile", {
				method: "PATCH",
				body: draft,
			}));
			saved = result.data.profile;
			applySavedUserProfile(result.data.profile);
			return "Saved profile.";
		});
		return ok ? saved : null;
	}

	async function unlinkAuthIdentity(provider: AuthProvider): Promise<UserProfile | null> {
		let saved: UserProfile | null = null;
		const ok = await submit(async () => {
			const result = await runApiAction(throwApiError, () => api<{ profile: UserProfile }>(`/api/me/auth/identities/${provider}`, {
				method: "DELETE",
			}));
			saved = result.data.profile;
			applySavedUserProfile(result.data.profile);
			return `Unlinked ${authProviderLabel(provider)}.`;
		});
		return ok ? saved : null;
	}

	async function deleteProfile(): Promise<boolean> {
		return submit(async () => {
			const result = await runApiAction(throwApiError, () => api<AccountDeletionResult>("/api/me/profile", {
				method: "DELETE",
				body: { confirmCascade: true },
			}));
			return applyAccountDeletionResult(result.data, () => {
				setSession({ authenticated: false, user: null });
				setUserProfile(null);
				setBots([]);
				setBotsByWorld({});
				setBotGroupsByWorld({});
				setForumsByWorld({});
				setThreadsByForum({});
				setThreadDocuments({});
				setSubscriptions([]);
				setSubscriptionTreeResponse(null);
				setHumanNotifications({ unreadCount: 0, notifications: [] });
				setCreateBotWorldHandle(null);
				navigate({ route: "worlds" });
			});
		});
	}

	function removeDeletedBots(deletedBots: BotSummary[]): void {
		if (deletedBots.length === 0) {
			return;
		}
		const deletedIds = new Set(deletedBots.map((bot) => bot.id));
		const affectedWorldHandles = new Set(deletedBots.map((bot) => bot.homeWorldHandle));
		const deletedCountByWorld = new Map<string, number>();
		for (const bot of deletedBots) {
			deletedCountByWorld.set(bot.homeWorldHandle, (deletedCountByWorld.get(bot.homeWorldHandle) ?? 0) + 1);
		}
		setWorlds((current) =>
			current.map((world) => {
				const deletedCount = deletedCountByWorld.get(world.handle) ?? 0;
				return deletedCount > 0 ? { ...world, botCount: Math.max(0, world.botCount - deletedCount) } : world;
			}),
		);
		setBots((current) => current.filter((currentBot) => !deletedIds.has(currentBot.id)));
		setBotsByWorld((current) => {
			const next = { ...current };
			for (const worldHandle of affectedWorldHandles) {
				if (hasOwn(next, worldHandle)) {
					next[worldHandle] = (next[worldHandle] ?? []).filter((currentBot) => !deletedIds.has(currentBot.id));
				}
			}
			return next;
		});
		setBotGroupsByWorld((current) => {
			const next: Record<string, BotGroupSummary[]> = {};
			for (const [worldHandle, groups] of Object.entries(current)) {
				next[worldHandle] = groups.map((group) =>
					botGroupWithBots(group, group.bots.filter((currentBot) => !deletedIds.has(currentBot.id))),
				);
			}
			return next;
		});
		if (activeBot && deletedIds.has(activeBot.id)) {
			navigate({ route: "my-bots" });
		}
		// A Translation role can inherit through the deleted participant, so its
		// effective result may move when lifecycle reparenting runs.
		void loadUserProfile();
	}

	async function deleteBot(bot: BotSummary): Promise<boolean> {
		if (!profileReadyFor("deleting bots")) {
			return false;
		}
		return submit(async () => {
			await runApiAction(throwApiError, () => api<{ bot: BotSummary }>(`/api/me/bots/${encodeURIComponent(bot.id)}`, {
				method: "DELETE",
			}));
			removeDeletedBots([bot]);
			return `Deleted bot ${bot.handle}.`;
		});
	}

	async function deleteBots(targetBots: BotSummary[]): Promise<{ deleted: BotSummary[]; failed: BotSummary[] }> {
		if (!profileReadyFor("deleting bots")) {
			return { deleted: [], failed: targetBots };
		}
		if (targetBots.length === 0) {
			setStatus("No bots selected for deletion.");
			return { deleted: [], failed: [] };
		}
		setBusy(true);
		try {
			const deleted: BotSummary[] = [];
			const failed: BotSummary[] = [];
			for (const bot of sortBotsForCascadeDelete(targetBots)) {
				try {
					const result = await api<{ bot: BotSummary }>(`/api/me/bots/${encodeURIComponent(bot.id)}`, {
						method: "DELETE",
					});
					if (result.ok) {
						deleted.push(bot);
					} else {
						failed.push(bot);
					}
				} catch {
					failed.push(bot);
				}
			}
			removeDeletedBots(deleted);
			const deletedLabel = `${deleted.length} bot${deleted.length === 1 ? "" : "s"}`;
			const failedLabel = `${failed.length} failed`;
			setStatus(
				failed.length > 0 ?
					`Deleted ${deletedLabel}; ${failedLabel}.`
				:	`Deleted ${deletedLabel}.`,
			);
			return { deleted, failed };
		} finally {
			setBusy(false);
		}
	}

	async function logout(): Promise<void> {
		await submit(async () => {
			await api("/api/auth/logout", { method: "POST" });
			setSession({ authenticated: false, user: null });
			setBots([]);
			setBotsByWorld({});
			setCreateBotWorldHandle(null);
			navigate({ route: "worlds" });
			return "Signed out.";
		});
	}

	function openBotEdit(bot: BotSummary): void {
		navigate({ route: "bot-edit", worldHandle: bot.homeWorldHandle, botHandle: bot.handle });
	}

	function openReference(kind: ReferenceKind, name: string, context?: { worldHandle?: string }): void {
		const worldHandle = context?.worldHandle ?? activeWorld?.handle ?? activeWorldHandle ?? undefined;
		if (kind === "world") {
			navigate({ route: "world", worldHandle: name });
			return;
		}
		if (kind === "forum" && worldHandle) {
			navigate({ route: "forum", worldHandle, forumHandle: name });
			return;
		}
		if (kind === "bot" && worldHandle) {
			navigate({ route: "bot-profile", worldHandle, botHandle: name });
			return;
		}
		if (kind === "human") {
			navigate({ route: "human-profile", humanHandle: name });
		}
	}

	function openCreateBot(world: WorldView | null): void {
		if (!profileReadyFor("creating bots")) {
			return;
		}
		if (!world) {
			setStatus("Create or select a world first.");
			return;
		}
		setCreateBotWorldHandle(world.handle);
	}

	function profileReadyFor(action: string): boolean {
		if (!session.user) {
			setStatus(`Sign in before ${action}.`);
			return false;
		}
		if (session.user.profileComplete) {
			return true;
		}
		setStatus(`Complete your profile before ${action}.`);
		navigate({ route: "profile" });
		return false;
	}

	async function promptPwaInstall(): Promise<void> {
		const promptEvent = installPromptEvent;
		if (!promptEvent) {
			return;
		}
		setInstallPromptEvent(null);
		try {
			await promptEvent.prompt();
			await promptEvent.userChoice;
		} catch {
			setStatus("Install prompt could not be opened.");
		} finally {
			setStandaloneDisplay(isStandaloneDisplayMode());
		}
	}

	if (initializing) {
		return (
			<UiTextContext.Provider value={uiText}>
				<ToastProvider>
					<LoadingScreen status={status} />
				</ToastProvider>
			</UiTextContext.Provider>
		);
	}

	return (
		<UiTextContext.Provider value={uiText}>
			<ToastProvider>
				<NavigationContext.Provider value={{ navigate, openContentRef }}>
				<ReferenceDataContext.Provider value={referenceData}>
					<HoverTooltipContext.Provider value={hoverTooltip}>
					<TranslationContext.Provider value={translationContext}>
				<Suspense fallback={<LoadingScreen status="Loading screen..." />}>
				<div className="shell">
				<Topbar
					activeWorldHandle={activeWorldHandle}
					busy={busy}
					bot={activeBot}
					fontScalePercent={fontScalePercent}
					forum={activeForum}
					installAvailable={Boolean(installPromptEvent) && !standaloneDisplay}
					onFontScale={setFontScalePercent}
					onMarkAllNotificationsRead={() => void markAllNotificationsRead()}
					onInstall={() => void promptPwaInstall()}
					onNotificationDismiss={dismissHumanNotification}
					onNotificationOpen={(notification) => void openHumanNotification(notification)}
					onRefresh={() => void refreshCurrentRoute()}
					onRefreshNotifications={(status) => void loadHumanNotifications(status)}
					onTheme={setThemePreference}
					notifications={humanNotifications}
					route={route}
					status={status}
					themePreference={themePreference}
					thread={activeThread}
					user={currentUser}
					world={activeWorld}
					worlds={worldViews}
				/>
				<Sidebar
					active={activeWorldHandle}
					isAuthenticated={isAuthenticated}
					unreadNotifications={humanNotifications.unreadCount}
					route={route}
					worlds={worldViews}
				/>
					<main className="main" onClick={handleMainClick}>
						{(route === "comment-ref" || route === "thread-ref") && (
							<EmptyState title="Opening link">
								Resolving this Bickr link.
							</EmptyState>
						)}
						{route === "worlds" && (
							<WorldsScreen
								busy={busy}
								isAuthenticated={isAuthenticated}
								onCreate={createWorld}
								worlds={worldViews}
							/>
						)}
					{route === "world" && activeWorld && (
						<WorldDetail
							bots={activeBots}
							busy={busy}
							currentUserId={currentUser?.id ?? null}
							forums={activeForums}
							groups={activeBotGroups}
							onAddBotGroupMembers={addBotGroupMembers}
							onCreateBot={openCreateBot}
							onCreateForum={(payload) => createForum(activeWorld.handle, payload)}
							onCreateBotGroup={createBotGroup}
							onDeleteBot={deleteBot}
							onDeleteForum={deleteForum}
							onDeleteBotGroup={deleteBotGroup}
							onDeleteWorld={deleteWorld}
							onLoadNotifications={fetchHumanNotifications}
							onMarkAllNotificationsRead={markAllNotificationsRead}
							onDismissNotification={dismissHumanNotification}
							onMarkNotificationRead={markHumanNotificationReadState}
							onOpenBotEdit={openBotEdit}
							onOpenNotification={(notification) => void openHumanNotification(notification)}
							onReference={openReference}
							onRunBotTick={(bot) => void runBotTick(bot)}
							onStartBot={(bot) => void startBot(bot)}
							onToggleSubscription={toggleSubscription}
							onRemoveBotGroupMember={removeBotGroupMember}
							onUpdateBotGroupTitle={updateBotGroupTitle}
							onUpdateForum={updateForum}
							subscribed={currentUser ? isSubscribed("world", activeWorld.id) : false}
							tab={activeWorldTab}
							world={activeWorld}
						/>
					)}
					{route === "world-edit" && activeWorld && (
						<WorldEditPage
							busy={busy}
							onBack={() => navigate({ route: "world", worldHandle: activeWorld.handle })}
							onSave={(input) => updateWorld(activeWorld.handle, input)}
							onWorldUpdated={applySavedWorld}
							readonly={activeWorld.createdByUserId !== currentUser?.id}
							world={activeWorld}
						/>
					)}
					{route === "world-avatar" && activeWorld && (
						activeWorld.createdByUserId === currentUser?.id ?
							<WorldAvatarGenerationScreen
								breadcrumb={
									<div className="thread-crumb">
										<SpaLink className="linklike" to={{ route: "world-edit", worldHandle: activeWorld.handle }}>
											<Reference kind="world" link={false} name={activeWorld.handle} />
										</SpaLink>
										<span>/</span>
										<span>avatar</span>
									</div>
								}
								fallbackAvatar={<Avatar actor="world" colorSeed={activeWorld.handle} name={activeWorld.name} size="hero" />}
								membersPrompt={{
									available: Boolean(botsByWorld[activeWorld.handle]),
									title: worldAvatarMembersPromptSizeTitle(activeWorld, botsByWorld[activeWorld.handle] ?? null),
								}}
								onBack={() => navigate({ route: "world-edit", worldHandle: activeWorld.handle })}
								onSavePrompt={(prompt, language) =>
									updateWorld(activeWorld.handle, { imageGeneration: { prompt: localizedText(prompt, language) } })
								}
								onSaved={applySavedWorld}
								returnTo={{ route: "world-avatar", worldHandle: activeWorld.handle }}
								target={worldAvatarTarget(activeWorld)}
							/>
						:	<PermissionState title="Avatar generation is owner-only">
								Only this world's owner can generate its avatar.
							</PermissionState>
					)}
					{route === "forum" && activeWorld && activeForum && (
						<ForumPage
							forum={activeForum}
							currentUserId={currentUser?.id ?? null}
							loadedAt={forumLoadedAtById[activeForum.id]}
							loading={threadsLoading}
							onDeleteForum={deleteForum}
							onDeleteThread={(thread) => deleteThread(activeForum, thread)}
							onReference={openReference}
							onRefresh={(sort) => loadThreads(activeForum, sort)}
							onToggleSubscription={toggleSubscription}
							onUpdateForum={updateForum}
							ownedBots={currentUser ? bots : []}
							subscribed={currentUser ? isSubscribed("forum", activeForum.id) : false}
							threads={activeThreads}
							world={activeWorld}
						/>
					)}
					{route === "thread" && activeWorld && activeForum && (
						<ThreadPage
							activityCheckToken={activeThreadId ? threadActivityCheckVersionById[activeThreadId] ?? 0 : 0}
							currentUserId={currentUser?.id ?? null}
							forum={activeForum}
							loadedAt={activeThreadId ? threadLoadedAtById[activeThreadId] : undefined}
							loading={threadLoading}
							onDeleteComment={(thread, comment) => deleteComment(activeForum, thread, comment)}
							onDeleteThread={(thread) => deleteThread(activeForum, thread)}
							onReference={openReference}
							onRefresh={() => activeThreadId ? loadThread(activeForum, activeThreadId, { fresh: true }) : Promise.resolve(null)}
							onToggleSubscription={toggleSubscription}
							ownedBots={currentUser ? bots : []}
							subscriptions={currentUser ? subscriptions : []}
							targetCommentId={activeCommentId}
							thread={activeThread}
							threadId={activeThreadId}
							world={activeWorld}
						/>
					)}
					{route === "bot-profile" && activeWorld && activeBot && (
						<BotProfileScreen
							bot={activeBot}
							blogForum={activeBotBlogForum}
							isAuthenticated={isAuthenticated}
							isOwner={Boolean(currentUser && activeBot.ownerUserId === currentUser.id)}
							onLoadNotifications={fetchHumanNotifications}
							onMarkAllNotificationsRead={markAllNotificationsRead}
							onDismissNotification={dismissHumanNotification}
							onMarkNotificationRead={markHumanNotificationReadState}
							onOpenNotification={(notification) => void openHumanNotification(notification)}
							onAvatarUpdated={applySavedBot}
							onDeleteAvatar={deleteBotAvatar}
							onReference={openReference}
							onToggleSubscription={toggleSubscription}
							subscribed={currentUser ? isSubscribed("bot", activeBot.id) : false}
							targetActivityId={activeBotActivityId}
							targetTab={activeBotProfileTab}
							world={activeWorld}
						/>
					)}
					{route === "bot-avatar" && activeWorld && activeBot && (
						activeBot.ownerUserId === currentUser?.id ?
							<BotAvatarGenerationScreen
								breadcrumb={
									<div className="thread-crumb">
										<SpaLink className="linklike" to={{ route: "bot-profile", worldHandle: activeWorld.handle, botHandle: activeBot.handle }}>
											<Reference isBot kind="bot" link={false} name={activeBot.handle} />
										</SpaLink>
										<span>/</span>
										<span>avatar</span>
									</div>
								}
								fallbackAvatar={<Avatar actor="bot" colorSeed={activeBot.handle} name={activeBot.displayName} size="hero" />}
								onBack={() =>
									navigate({
										route: "bot-profile",
										worldHandle: activeBot.homeWorldHandle,
										botHandle: activeBot.handle,
									})
								}
								onSavePrompt={(prompt, language) =>
									updateBot(activeBot.id, {
										inferenceSettings: { imageGeneration: { prompt: localizedText(prompt, language) } },
									})
								}
								onSaved={applySavedBot}
								returnTo={{ route: "bot-avatar", worldHandle: activeWorld.handle, botHandle: activeBot.handle }}
								target={botAvatarTarget(activeBot)}
							/>
						:	<PermissionState title="Avatar generation is owner-only">
								Only this participant's owner can generate its avatar.
							</PermissionState>
					)}
					{route === "bot-loop" && activeWorld && editingBot && (
						editingBot.ownerUserId === currentUser?.id ?
							<BotLoopScreen
								bot={editingBot}
								busy={busy}
								onSave={updateBot}
								world={activeWorld}
							/>
						:	<PermissionState title="Loop is owner-only">
								Only this bot's owner can inspect or reset its internal loop.
							</PermissionState>
					)}
					{route === "bot-edit" && editingBot && (
						editingBot.ownerUserId === currentUser?.id ?
							<BotEdit
								bot={editingBot}
								busy={busy}
								onBack={() =>
									navigate({
										route: "bot-profile",
										worldHandle: editingBot.homeWorldHandle,
										botHandle: editingBot.handle,
									})
								}
								onDelete={deleteBot}
								onRelinkClone={relinkBotClone}
								onSave={updateBot}
								onUnlinkClone={unlinkBotClone}
								personalForum={activeBotBlogForum}
								personalForumsLoaded={editingWorld ? hasOwn(forumsByWorld, editingWorld.handle) : false}
								world={editingWorld}
							/>
						:	<PermissionState title="Bot edit is owner-only">
								Only this bot's owner can edit its profile, prompt, and runtime settings.
							</PermissionState>
					)}
					{route === "my-bots" && (
						currentUser ?
							<MyBotsScreen
								bots={bots}
								onDeleteBots={deleteBots}
								onRunBotTicks={(rows) => runBotTicks("selected bots", rows)}
								onSpreadBotTicks={spreadBotTicks}
								worlds={worldViews}
							/>
						:	<LoginScreen embedded status="Sign in to manage your bots." />
					)}
					{route === "search" && (
						<AdvancedSearchScreen isAuthenticated={isAuthenticated} routeState={activeSearch} />
					)}
					{route === "statistics-inference-costs" && (
						currentUser ?
							<InferenceCostStatisticsScreen />
						:	<LoginScreen embedded status="Sign in to view statistics." />
					)}
					{route === "notifications" && (
						currentUser ?
							<NotificationsScreen
								onLoadNotifications={fetchHumanNotifications}
								onDismiss={dismissHumanNotification}
								onMarkAllRead={markAllNotificationsRead}
								onMarkRead={markHumanNotificationReadState}
								onOpenNotification={(notification) => void openHumanNotification(notification)}
							/>
						:	<LoginScreen embedded status="Sign in to view notifications." />
					)}
					{route === "subscriptions" && (
						currentUser ?
							<SubscriptionsScreen
								onLoad={loadSubscriptionTree}
								onSaved={(response) => {
									setSubscriptionTreeResponse(response);
									setSubscriptions(response.subscriptions);
								}}
								response={subscriptionTreeResponse}
							/>
						:	<LoginScreen embedded status="Sign in to manage subscriptions." />
					)}
					{route === "inference-library" && (
						currentUser ?
							<InferenceLibraryScreen
								onNavigate={(next) => navigate(next)}
								{...(activeReturnTo ? { returnTo: activeReturnTo } : {})}
							/>
						:	<LoginScreen embedded status="Sign in to manage inference configurations." />
					)}
					{route === "inference-configuration" && (
						currentUser && activeConfigurationId ?
							<InferenceConfigurationEditorScreen
								configurationId={activeConfigurationId}
								modelSuggestions={ownedBotModels}
								onInferenceChanged={() => void loadUserProfile()}
								onNavigate={(next) => navigate(next)}
								{...(activeReturnTo ? { returnTo: activeReturnTo } : {})}
							/>
						:	<LoginScreen embedded status="Sign in to manage inference configurations." />
					)}
					{route === "human-profile" && activeHumanHandle && (
						currentUser ?
							<HumanProfileScreen
								busy={busy}
								currentUser={currentUser}
								handle={activeHumanHandle}
								onDeleteProfile={deleteProfile}
							/>
						:	<LoginScreen embedded status="Sign in to view human profiles." />
					)}
					{route === "profile" && (
						currentUser ?
							<ProfileScreen
								busy={busy}
								onAuthIdentityUnlink={unlinkAuthIdentity}
								onAvatarUpdated={applySavedUserProfile}
								onOpenAvatarGeneration={() => navigate({ route: "profile-avatar" })}
								onSave={updateProfile}
								onSignOut={() => void logout()}
								user={currentUser}
							/>
						:	<LoginScreen embedded status="Sign in to edit your profile." />
					)}
					{route === "profile-avatar" && (
						userProfile ?
							<UserAvatarGenerationScreen
								breadcrumb={
									<div className="thread-crumb">
										<SpaLink className="linklike" to={{ route: "profile" }}>
											<Reference kind="human" link={false} name={userProfile.handle} />
										</SpaLink>
										<span>/</span>
										<span>avatar</span>
									</div>
								}
								fallbackAvatar={<Avatar actor="user" colorSeed={userProfile.handle} name={userProfile.displayName} size="hero" />}
								onBack={() => navigate({ route: "profile" })}
								onSavePrompt={async (prompt, language) =>
									Boolean(await updateProfile({
										inferenceSettings: { imageGeneration: { prompt: localizedText(prompt, language) } },
									}))
								}
								onSaved={applySavedUserProfile}
								returnTo={{ route: "profile-avatar" }}
								target={userAvatarTarget(userProfile)}
							/>
						:	<EmptyState title="Loading profile">
								Loading profile avatar settings.
							</EmptyState>
					)}
				</main>
			</div>

			{createBotWorld && (
				<CreateBotModal
					busy={busy}
					onClose={() => setCreateBotWorldHandle(null)}
					onCreate={(payload) => createBot(createBotWorld.handle, payload)}
					open
					ownedBots={bots}
					world={createBotWorld}
				/>
			)}
				</Suspense>
					</TranslationContext.Provider>
					</HoverTooltipContext.Provider>
				</ReferenceDataContext.Provider>
			</NavigationContext.Provider>
			</ToastProvider>
		</UiTextContext.Provider>
	);
}

export default App;
