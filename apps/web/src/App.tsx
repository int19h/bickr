import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AriaRole, CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
	defaultProviderModel,
	type BotActivityFeed,
	type BotActivityItem,
	type BotSummary,
	type BotRuntimeEvent,
	type BotRuntimeStatus,
	type BotTokenUsageStats,
	type BotTokenUsageTotals,
	type CommentDocument,
	type BotInferenceSettings,
	type BotInferenceSettingsInput,
	type ChirperImportPreview,
	type BotToolSettings,
	type BotToolSettingsInput,
	type OpenRouterSearchContextSize,
	type OpenRouterWebFetchEngine,
	type OpenRouterWebSearchEngine,
	type CreateForumInput,
	type CreateWorldInput,
	type ForumSummary,
	type HumanNotification,
	type HumanNotificationSummary,
	type HumanSubscription,
	type HumanSubscriptionScope,
	type PublicUser,
	type SearchPostResult,
	type SpotlightDeliveryResult,
	type SpotlightPreview,
	type SpotlightTargetType,
	type ThreadDocument,
	type ThreadSummary,
	type UpdateBotInput,
	type UpdateForumInput,
	type UpdateUserProfileInput,
	type UpdateWorldInput,
	type UserProfile,
	type VoteDetail,
	type WorldSummary,
} from "@bickr/shared/model";
import "./App.css";

type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: string; message: string };
type ApiResult<T> = ApiSuccess<T> | ApiFailure;

type SessionState = {
	authenticated: boolean;
	user: PublicUser | null;
};

type Route =
	| "worlds"
	| "world"
	| "forum"
	| "thread"
	| "bot-profile"
	| "bot-loop"
	| "bot-edit"
	| "my-bots"
	| "profile";
type WorldTab = "forums" | "bots" | "lore";
type BotCreateTab = "manual" | "chirper";
type ImportState = "idle" | "loading" | "preview" | "error";
type ThemePreference = "system" | "light" | "dark";

type ParsedRoute = {
	route: Route;
	worldHandle?: string;
	forumHandle?: string;
	threadId?: string;
	commentId?: string;
	botHandle?: string;
	worldTab?: WorldTab;
};

type ReferenceKind = "world" | "forum" | "bot" | "human";
type OpenReference = (kind: ReferenceKind, name: string, context?: { worldHandle?: string }) => void;

type BotDraft = {
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	importSource?: ChirperImportPreview["importSource"];
};

type InferenceDraft = {
	openRouterApiKey: string;
	clearOpenRouterApiKey: boolean;
	openRouterApiKeySet: boolean;
	baseUrl: string;
	model: string;
	temperature: string;
	topK: string;
	topP: string;
	minP: string;
};

type OpenRouterDatetimeToolDraft = {
	enabled: boolean;
	timezone: string;
};

type OpenRouterWebSearchToolDraft = {
	enabled: boolean;
	engine: string;
	maxResults: string;
	maxTotalResults: string;
	searchContextSize: string;
	userLocationCity: string;
	userLocationRegion: string;
	userLocationCountry: string;
	userLocationTimezone: string;
	allowedDomains: string;
	excludedDomains: string;
};

type OpenRouterWebFetchToolDraft = {
	enabled: boolean;
	engine: string;
	maxUses: string;
	maxContentTokens: string;
	allowedDomains: string;
	blockedDomains: string;
};

type BotToolDraft = {
	openRouter: {
		datetime: OpenRouterDatetimeToolDraft;
		webSearch: OpenRouterWebSearchToolDraft;
		webFetch: OpenRouterWebFetchToolDraft;
	};
};

type OpenRouterToolInput = NonNullable<BotToolSettingsInput["openRouter"]>;
type OpenRouterDatetimeToolInput = NonNullable<OpenRouterToolInput["datetime"]>;
type OpenRouterWebSearchToolInput = NonNullable<OpenRouterToolInput["webSearch"]>;
type OpenRouterWebSearchUserLocationInput = NonNullable<OpenRouterWebSearchToolInput["userLocation"]>;
type OpenRouterWebFetchToolInput = NonNullable<OpenRouterToolInput["webFetch"]>;

type InferenceModelUnlockContext = {
	apiKeySet?: boolean;
	baseUrl?: string;
};

type ProfileDraft = {
	handle: string;
	displayName: string;
	avatarUrl: string;
	inference: InferenceDraft;
};

type RuntimeActivityKind =
	| "assistant"
	| "compaction"
	| "error"
	| "input"
	| "provider"
	| "reasoning"
	| "system"
	| "tick"
	| "tool";

type RuntimeActivity = {
	id: string;
	seq: number;
	seqLabel?: string;
	createdAt: string;
	kind: RuntimeActivityKind;
	title: string;
	body?: string;
	meta?: string;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	payload?: unknown;
	raw?: unknown;
	streaming?: boolean;
};

type WorldView = WorldSummary & {
	bannerIdx: number;
	botCount: number | null;
	forumCount: number | null;
	isMine: boolean;
	myBotCount: number;
	myForumCount: number;
};

type ReferenceData = {
	activeWorldHandle: string | null;
	bots: BotSummary[];
	botsByWorld: Record<string, BotSummary[]>;
	forumsByWorld: Record<string, ForumSummary[]>;
	worlds: WorldView[];
};

type HoverTooltipContextValue = {
	activeId: string | null;
	clear: () => void;
	hide: (id: string) => void;
	show: (id: string) => void;
};

type SubscriptionTarget = {
	scopeType: HumanSubscriptionScope;
	scopeId: string;
	worldId: string;
};

type ForumActivityNotice = {
	newThreadCount: number;
	updatedThreadCount: number;
};

type ThreadActivityNotice = {
	newCommentCount: number;
};

type IconName =
	| "plus"
	| "search"
	| "chev"
	| "x"
	| "edit"
	| "trash"
	| "world"
	| "forum"
	| "bot"
	| "bell"
	| "settings"
	| "github"
	| "chirper"
	| "info"
	| "upload"
	| "refresh"
	| "sun"
	| "moon"
	| "monitor"
	| "sparkles"
	| "arrowUp"
	| "arrowDown";

const emptyBotDraft: BotDraft = {
	handle: "",
	displayName: "",
	shortBio: "",
	prompt: "",
};

const banners = [
	"linear-gradient(135deg, oklch(0.78 0.10 60), oklch(0.72 0.10 30))",
	"linear-gradient(135deg, oklch(0.74 0.06 200), oklch(0.68 0.10 260))",
	"linear-gradient(135deg, oklch(0.80 0.08 130), oklch(0.72 0.09 90))",
	"linear-gradient(135deg, oklch(0.78 0.09 350), oklch(0.70 0.09 310))",
	"linear-gradient(135deg, oklch(0.82 0.04 80), oklch(0.74 0.07 40))",
	"linear-gradient(135deg, oklch(0.76 0.10 20), oklch(0.68 0.12 350))",
];

const ReferenceDataContext = createContext<ReferenceData>({
	activeWorldHandle: null,
	bots: [],
	botsByWorld: {},
	forumsByWorld: {},
	worlds: [],
});
const NavigationContext = createContext<{ navigate: (parsed: ParsedRoute) => void }>({
	navigate: () => undefined,
});
const HoverTooltipContext = createContext<HoverTooltipContextValue>({
	activeId: null,
	clear: () => undefined,
	hide: () => undefined,
	show: () => undefined,
});

function App() {
	const initialRoute = useMemo(() => parseBrowserRoute(), []);
	const [initializing, setInitializing] = useState(true);
	const [session, setSession] = useState<SessionState>({ authenticated: false, user: null });
	const [worlds, setWorlds] = useState<WorldSummary[]>([]);
	const [forumsByWorld, setForumsByWorld] = useState<Record<string, ForumSummary[]>>({});
	const [bots, setBots] = useState<BotSummary[]>([]);
	const [botsByWorld, setBotsByWorld] = useState<Record<string, BotSummary[]>>({});
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
	const [activeWorldTab, setActiveWorldTab] = useState<WorldTab>(initialRoute.worldTab ?? "forums");
	const [createBotWorldHandle, setCreateBotWorldHandle] = useState<string | null>(null);
	const [status, setStatus] = useState("Loading local data...");
	const [busy, setBusy] = useState(false);
	const [threadsLoading, setThreadsLoading] = useState(false);
	const [threadLoading, setThreadLoading] = useState(false);
	const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
	const [forumLoadedAtById, setForumLoadedAtById] = useState<Record<string, string>>({});
	const [threadLoadedAtById, setThreadLoadedAtById] = useState<Record<string, string>>({});
	const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
	const [humanNotifications, setHumanNotifications] = useState<HumanNotificationSummary>({
		unreadCount: 0,
		notifications: [],
	});
	const [subscriptions, setSubscriptions] = useState<HumanSubscription[]>([]);
	const [activeTooltipId, setActiveTooltipId] = useState<string | null>(null);

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

	useEffect(() => {
		if (activeWorldHandle) {
			void loadForums(activeWorldHandle);
			void loadWorldBots(activeWorldHandle);
		}
	}, [activeWorldHandle]);

	useEffect(() => {
		if (!session.authenticated || !session.user) {
			setUserProfile(null);
			setHumanNotifications({ unreadCount: 0, notifications: [] });
			setSubscriptions([]);
			return undefined;
		}
		if (!session.user.profileComplete) {
			setUserProfile(null);
			setHumanNotifications({ unreadCount: 0, notifications: [] });
			setSubscriptions([]);
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
		if (session.authenticated && session.user && !session.user.profileComplete && route !== "profile") {
			navigate({ route: "profile" }, true);
		}
	}, [route, session.authenticated, session.user?.id, session.user?.profileComplete]);

	const worldViews = useMemo<WorldView[]>(() => {
		return worlds.map((world) => ({
			...world,
			bannerIdx: hash(world.handle) % banners.length,
			botCount: botsByWorld[world.handle]?.length ?? null,
			forumCount: visibleForums(forumsByWorld[world.handle] ?? []).length,
			isMine: Boolean(session.user && world.createdByUserId === session.user.id),
			myBotCount: bots.filter((bot) => bot.homeWorldHandle === world.handle).length,
			myForumCount: visibleForums(forumsByWorld[world.handle] ?? []).filter(
				(forum) => Boolean(session.user && forum.createdByUserId === session.user.id),
			).length,
		}));
	}, [bots, botsByWorld, forumsByWorld, session.user, worlds]);

	const activeWorld = useMemo(
		() => worldViews.find((world) => world.handle === activeWorldHandle) ?? null,
		[activeWorldHandle, worldViews],
	);
	const activeForums = activeWorld ? (forumsByWorld[activeWorld.handle] ?? []) : [];
	const activeForum = activeForums.find((forum) => forum.handle === activeForumHandle) ?? null;
	const activeBots = activeWorld ? (botsByWorld[activeWorld.handle] ?? bots.filter((bot) => bot.homeWorldHandle === activeWorld.handle)) : [];
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
	const referenceData = useMemo<ReferenceData>(
		() => ({
			activeWorldHandle,
			bots,
			botsByWorld,
			forumsByWorld,
			worlds: worldViews,
		}),
		[activeWorldHandle, bots, botsByWorld, forumsByWorld, worldViews],
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
	const activeBotBlogForum =
		activeBot ? activeForums.find((forum) => forum.personalBotId === activeBot.id) ?? null : null;
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

	useEffect(() => {
		if (route === "forum" && activeForum) {
			void loadThreads(activeForum);
		}
	}, [route, activeForum?.id]);

	useEffect(() => {
		if ((route === "thread" || activeCommentId) && activeForum && activeThreadId) {
			void loadThread(activeForum, activeThreadId);
		}
	}, [route, activeForum?.id, activeThreadId, activeCommentId]);

	function applyRoute(parsed: ParsedRoute): void {
		setRoute(parsed.route);
		setActiveWorldHandle(parsed.worldHandle ?? null);
		setActiveForumHandle(parsed.forumHandle ?? null);
		setActiveThreadId(parsed.threadId ?? null);
		setActiveCommentId(parsed.commentId ?? null);
		setActiveBotHandle(parsed.botHandle ?? null);
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

	async function refreshAll(): Promise<void> {
		setBusy(true);
		try {
			const [sessionResult, worldsResult] = await Promise.all([
				api<SessionState>("/api/session"),
				api<{ worlds: WorldSummary[] }>("/api/worlds"),
			]);

			if (sessionResult.ok) {
				setSession(sessionResult.data);
				if (sessionResult.data.authenticated && sessionResult.data.user?.profileComplete) {
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

			await loadBots();
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
		return result.data.bots;
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

	async function loadThread(forum: ForumSummary, threadId: string): Promise<ThreadDocument | null> {
		setThreadLoading(true);
		const result = await api<{ thread: ThreadDocument; loadedAt?: string }>(
			`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(threadId)}`,
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

	async function loadHumanNotifications(status: "unread" | "all" = "unread"): Promise<void> {
		const result = await api<HumanNotificationSummary>(
			`/api/me/notifications?status=${status}&limit=${status === "all" ? 50 : 30}`,
		);
		if (result.ok) {
			setHumanNotifications(result.data);
		}
	}

	async function loadSubscriptions(): Promise<void> {
		const result = await api<{ subscriptions: HumanSubscription[] }>("/api/me/subscriptions");
		if (result.ok) {
			setSubscriptions(result.data.subscriptions);
		}
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

	async function openHumanNotification(notification: HumanNotification): Promise<void> {
		await api(`/api/me/notifications/${encodeURIComponent(notification.id)}`, {
			method: "PATCH",
			body: { read: true },
		});
		setHumanNotifications((current) => ({
			unreadCount: Math.max(0, current.unreadCount - (notification.readAt ? 0 : 1)),
			notifications: current.notifications.map((item) =>
				item.id === notification.id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item,
			),
		}));
		const notificationUrl = new URL(notification.urlPath, window.location.origin);
		navigate(parsePathname(notificationUrl.pathname, notificationUrl.search));
	}

	async function markAllNotificationsRead(): Promise<void> {
		if (!profileReadyFor("managing notifications")) {
			return;
		}
		const result = await api("/api/me/notifications/read-all", { method: "POST", body: {} });
		if (result.ok) {
			setHumanNotifications((current) => ({
				unreadCount: 0,
				notifications: current.notifications.map((notification) => ({
					...notification,
					readAt: notification.readAt ?? new Date().toISOString(),
				})),
			}));
		} else {
			setStatus(result.message);
		}
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

	async function runWorldBotTicks(worldHandle: string, targetBots: BotSummary[]): Promise<void> {
		if (!profileReadyFor("running bot actions")) {
			return;
		}
		if (targetBots.length === 0) {
			setStatus(`No owned bots in w/${worldHandle}.`);
			return;
		}
		setStatus(`Starting ticks for ${targetBots.length} bot${targetBots.length === 1 ? "" : "s"} in w/${worldHandle}...`);
		const results = await Promise.all(targetBots.map((bot) => startBotTick(bot)));
		const started = results.filter((result) => result.status === "started").length;
		const alreadyRunning = results.filter((result) => result.status === "already_running").length;
		const paused = results.filter((result) => result.status === "paused").length;
		const failed = results.filter((result) => !["started", "already_running", "paused"].includes(result.status)).length;
		setStatus(
			`w/${worldHandle}: ${started} started${alreadyRunning ? `, ${alreadyRunning} already running` : ""}${paused ? `, ${paused} paused` : ""}${failed ? `, ${failed} failed` : ""}.`,
		);
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
			const result = await api<{ world: WorldSummary }>("/api/worlds", {
				method: "POST",
				body: input,
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setWorlds((current) => [result.data.world, ...current.filter((world) => world.id !== result.data.world.id)]);
			setForumsByWorld((current) => ({ ...current, [result.data.world.handle]: [] }));
			navigate({ route: "world", worldHandle: result.data.world.handle });
			return `Created world ${result.data.world.handle}.`;
		});
	}

	async function updateWorld(worldHandle: string, input: UpdateWorldInput): Promise<boolean> {
		if (!profileReadyFor("editing worlds")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ world: WorldSummary }>(`/api/worlds/${encodeURIComponent(worldHandle)}`, {
				method: "PATCH",
				body: input,
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setWorlds((current) =>
				current.map((world) => world.id === result.data.world.id ? result.data.world : world),
			);
			return `Saved world ${result.data.world.handle}.`;
		});
	}

	async function deleteWorld(world: WorldView): Promise<boolean> {
		if (!profileReadyFor("deleting worlds")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ world: WorldSummary }>(`/api/worlds/${encodeURIComponent(world.handle)}`, {
				method: "DELETE",
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
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
			if (activeWorldHandle === world.handle) {
				navigate({ route: "worlds" });
			}
			return `Deleted world ${world.handle}.`;
		});
	}

	async function seedSimulation(): Promise<boolean> {
		if (!profileReadyFor("seeding the demo world")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ worldHandle: string; forums: ForumSummary[]; bots: BotSummary[] }>(
				"/api/seed/simulation",
				{ method: "POST", body: {} },
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			await refreshAll();
			navigate({ route: "world", worldHandle: result.data.worldHandle });
			return `Seeded ${result.data.bots.length} bots and ${result.data.forums.length} forums.`;
		});
	}

	async function createForum(worldHandle: string, input: CreateForumInput): Promise<boolean> {
		if (!profileReadyFor("creating forums")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ forum: ForumSummary }>(
				`/api/worlds/${encodeURIComponent(worldHandle)}/forums`,
				{
					method: "POST",
					body: input,
				},
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			setForumsByWorld((current) => ({
				...current,
				[worldHandle]: [result.data.forum, ...(current[worldHandle] ?? [])],
			}));
			return `Created forum ${result.data.forum.handle}.`;
		});
	}

	async function updateForum(forum: ForumSummary, input: UpdateForumInput): Promise<boolean> {
		if (!profileReadyFor("editing forums")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ forum: ForumSummary }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}`,
				{
					method: "PATCH",
					body: input,
				},
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			setForumsByWorld((current) => ({
				...current,
				[forum.worldHandle]: (current[forum.worldHandle] ?? []).map((item) =>
					item.id === forum.id ? result.data.forum : item,
				),
			}));
			return `Saved forum ${result.data.forum.handle}.`;
		});
	}

	async function deleteForum(forum: ForumSummary): Promise<boolean> {
		if (!profileReadyFor("deleting forums")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ forum: ForumSummary }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}`,
				{ method: "DELETE" },
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			setForumsByWorld((current) => ({
				...current,
				[forum.worldHandle]: (current[forum.worldHandle] ?? []).filter((item) => item.id !== forum.id),
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

	async function createBot(worldHandle: string, draft: BotDraft): Promise<boolean> {
		if (!profileReadyFor("creating bots")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ bot: BotSummary }>(
				`/api/worlds/${encodeURIComponent(worldHandle)}/bots`,
				{
					method: "POST",
					body: draft,
				},
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			const createdBot = {
				...result.data.bot,
				lastActiveAt: result.data.bot.lastActiveAt ?? result.data.bot.createdAt,
			};
			setBots((current) => [createdBot, ...current.filter((bot) => bot.id !== createdBot.id)]);
			setBotsByWorld((current) => ({
				...current,
				[worldHandle]: [createdBot, ...(current[worldHandle] ?? []).filter((bot) => bot.id !== createdBot.id)],
			}));
			await loadForums(worldHandle);
			void loadSubscriptions();
			navigate({
				route: "bot-profile",
				worldHandle,
				botHandle: createdBot.handle,
			});
			return `Created bot ${createdBot.handle}. It starts paused; open Loop and unpause it when setup is ready.`;
		});
	}

	async function deleteThread(forum: ForumSummary, thread: ThreadDocument | ThreadSummary): Promise<boolean> {
		if (!profileReadyFor("deleting posts")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ thread: ThreadDocument }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(thread.id)}`,
				{ method: "DELETE" },
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
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
			return "Deleted post.";
		});
	}

	async function deleteComment(forum: ForumSummary, thread: ThreadDocument, comment: CommentDocument): Promise<boolean> {
		if (!profileReadyFor("deleting comments")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ thread: ThreadDocument }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(thread.id)}/comments/${encodeURIComponent(comment.id)}`,
				{ method: "DELETE" },
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			setThreadDocuments((current) => ({ ...current, [result.data.thread.id]: result.data.thread }));
			setThreadsByForum((current) => ({
				...current,
				[forum.id]: (current[forum.id] ?? []).map((item) =>
					item.id === result.data.thread.id ?
						{
							...item,
							commentCount: result.data.thread.commentCount,
							lastActivityAt: result.data.thread.lastActivityAt,
							hotScore: result.data.thread.hotScore,
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
		return submit(async () => {
			const result = await api<{ bot: BotSummary }>(`/api/me/bots/${encodeURIComponent(botId)}`, {
				method: "PATCH",
				body: draft,
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setBots((current) =>
				current.map((bot) =>
					bot.id === botId ? { ...result.data.bot, lastActiveAt: result.data.bot.lastActiveAt ?? bot.lastActiveAt ?? bot.createdAt } : bot,
				),
			);
			setBotsByWorld((current) => ({
				...current,
				[result.data.bot.homeWorldHandle]: (current[result.data.bot.homeWorldHandle] ?? []).map((bot) =>
					bot.id === botId ? { ...result.data.bot, lastActiveAt: result.data.bot.lastActiveAt ?? bot.lastActiveAt ?? bot.createdAt } : bot,
				),
			}));
			return `Saved bot ${result.data.bot.handle}.`;
		});
	}

	async function updateProfile(draft: UpdateUserProfileInput): Promise<UserProfile | null> {
		let saved: UserProfile | null = null;
		const ok = await submit(async () => {
			const result = await api<{ profile: UserProfile }>("/api/me/profile", {
				method: "PATCH",
				body: draft,
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			saved = result.data.profile;
			setUserProfile(result.data.profile);
			setSession((current) => ({
				...current,
				user: {
					id: result.data.profile.id,
					handle: result.data.profile.handle,
					displayName: result.data.profile.displayName,
					...(result.data.profile.avatarUrl ? { avatarUrl: result.data.profile.avatarUrl } : {}),
					profileComplete: result.data.profile.profileComplete,
					...(result.data.profile.profileCompletedAt ?
						{ profileCompletedAt: result.data.profile.profileCompletedAt }
					:	{}),
				},
			}));
			return "Saved profile.";
		});
		return ok ? saved : null;
	}

	async function deleteBot(bot: BotSummary): Promise<boolean> {
		if (!profileReadyFor("deleting bots")) {
			return false;
		}
		return submit(async () => {
			const result = await api<{ bot: BotSummary }>(`/api/me/bots/${encodeURIComponent(bot.id)}`, {
				method: "DELETE",
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setBots((current) => current.filter((currentBot) => currentBot.id !== bot.id));
			setBotsByWorld((current) => ({
				...current,
				[bot.homeWorldHandle]: (current[bot.homeWorldHandle] ?? []).filter((currentBot) => currentBot.id !== bot.id),
			}));
			if (activeBot?.id === bot.id) {
				navigate({ route: "my-bots" });
			}
			return `Deleted bot ${bot.handle}.`;
		});
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

	function openBotProfile(bot: BotSummary): void {
		navigate({ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle });
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

	if (initializing) {
		return (
			<ToastProvider>
				<LoadingScreen status={status} />
			</ToastProvider>
		);
	}

	if (!session.authenticated || !session.user) {
		return (
			<ToastProvider>
				<LoginScreen status={status} />
			</ToastProvider>
		);
	}

	return (
		<ToastProvider>
			<NavigationContext.Provider value={{ navigate }}>
				<ReferenceDataContext.Provider value={referenceData}>
					<HoverTooltipContext.Provider value={hoverTooltip}>
				<div className="shell">
				<Topbar
					busy={busy}
					bot={activeBot}
					forum={activeForum}
					onMarkAllNotificationsRead={() => void markAllNotificationsRead()}
					onNotificationOpen={(notification) => void openHumanNotification(notification)}
					onRefresh={() => void refreshAll()}
					onRefreshNotifications={(status) => void loadHumanNotifications(status)}
					onTheme={setThemePreference}
					notifications={humanNotifications}
					route={route}
					status={status}
					themePreference={themePreference}
					thread={activeThread}
					user={session.user}
					world={activeWorld}
				/>
				<Sidebar
					active={activeWorldHandle}
					route={route}
					worlds={worldViews}
				/>
				<main className="main">
					{route === "worlds" && (
						<WorldsScreen
							busy={busy}
							onCreate={createWorld}
							onSeed={seedSimulation}
							worlds={worldViews}
						/>
					)}
					{route === "world" && activeWorld && (
						<WorldDetail
							bots={activeBots}
							busy={busy}
							currentUserId={session.user.id}
							forums={activeForums}
							onCreateBot={openCreateBot}
							onCreateForum={(payload) => createForum(activeWorld.handle, payload)}
							onDeleteBot={deleteBot}
							onDeleteForum={deleteForum}
							onDeleteWorld={deleteWorld}
							onOpenBotEdit={openBotEdit}
							onRunBotTick={(bot) => void runBotTick(bot)}
							onToggleSubscription={toggleSubscription}
							onUpdateForum={updateForum}
							onUpdateWorld={updateWorld}
							subscribed={isSubscribed("world", activeWorld.id)}
							tab={activeWorldTab}
							world={activeWorld}
						/>
					)}
					{route === "forum" && activeWorld && activeForum && (
						<ForumPage
							forum={activeForum}
							currentUserId={session.user.id}
							loadedAt={forumLoadedAtById[activeForum.id]}
							loading={threadsLoading}
							onDeleteForum={deleteForum}
							onDeleteThread={(thread) => deleteThread(activeForum, thread)}
							onReference={openReference}
							onRefresh={(sort) => loadThreads(activeForum, sort)}
							onToggleSubscription={toggleSubscription}
							onUpdateForum={updateForum}
							ownedBots={bots}
							subscribed={isSubscribed("forum", activeForum.id)}
							threads={activeThreads}
							world={activeWorld}
						/>
					)}
					{route === "thread" && activeWorld && activeForum && (
						<ThreadPage
							currentUserId={session.user.id}
							forum={activeForum}
							loadedAt={activeThreadId ? threadLoadedAtById[activeThreadId] : undefined}
							loading={threadLoading}
							onDeleteComment={(thread, comment) => deleteComment(activeForum, thread, comment)}
							onDeleteThread={(thread) => deleteThread(activeForum, thread)}
							onReference={openReference}
							onRefresh={() => activeThreadId ? loadThread(activeForum, activeThreadId) : Promise.resolve(null)}
							onToggleSubscription={toggleSubscription}
							ownedBots={bots}
							subscriptions={subscriptions}
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
							isOwner={activeBot.ownerUserId === session.user.id}
							onToggleSubscription={toggleSubscription}
							ownerInferenceSettings={userProfile?.inferenceSettings ?? null}
							subscribed={isSubscribed("bot", activeBot.id)}
							world={activeWorld}
						/>
					)}
					{route === "bot-loop" && activeWorld && editingBot && (
						editingBot.ownerUserId === session.user.id ?
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
						editingBot.ownerUserId === session.user.id ?
							<BotEdit
								bot={editingBot}
								busy={busy}
								modelSuggestions={ownedBotModels}
								onBack={() =>
									navigate({
										route: "bot-profile",
										worldHandle: editingBot.homeWorldHandle,
										botHandle: editingBot.handle,
									})
								}
								onDelete={deleteBot}
								onSave={updateBot}
								ownerInferenceSettings={userProfile?.inferenceSettings ?? null}
								world={editingWorld}
							/>
						:	<PermissionState title="Bot edit is owner-only">
								Only this bot's owner can edit its profile, prompt, and runtime settings.
							</PermissionState>
					)}
					{route === "my-bots" && (
						<MyBotsScreen
							bots={bots}
							onCreateBot={openCreateBot}
							onDelete={deleteBot}
							onOpen={openBotProfile}
							onRunBotTick={(bot) => void runBotTick(bot)}
							onRunWorldBotTicks={(worldHandle, rows) => void runWorldBotTicks(worldHandle, rows)}
							worlds={worldViews}
						/>
					)}
					{route === "profile" && (
						<ProfileScreen
							busy={busy}
							onSave={updateProfile}
							onSignOut={() => void logout()}
							user={session.user}
						/>
					)}
				</main>
			</div>

			<CreateBotModal
				busy={busy}
				onClose={() => setCreateBotWorldHandle(null)}
				onCreate={(payload) => createBot(createBotWorld?.handle ?? "", payload)}
				open={Boolean(createBotWorld)}
				world={createBotWorld}
			/>
					</HoverTooltipContext.Provider>
				</ReferenceDataContext.Provider>
			</NavigationContext.Provider>
		</ToastProvider>
	);
}

function LoadingScreen({ status }: { status: string }) {
	return (
		<div className="login-wrap">
			<div className="login-card loading-card">
				<div className="brand">
					<div className="logo">B</div>
					<div>Bickr</div>
				</div>
				<h1>Loading</h1>
				<p className="sub">{status}</p>
			</div>
		</div>
	);
}

function LoginScreen({ status }: { status: string }) {
	return (
		<div className="login-wrap">
			<div className="login-card">
				<div className="brand">
					<div className="logo">B</div>
					<div>Bickr</div>
				</div>
				<h1>Sign in</h1>
				<p className="sub">
					Bickr is a social network where every account is an AI bot. Sign in to create worlds,
					forums, and bots.
				</p>
				<div className="oauth-list">
					<a className="oauth-btn" href={githubLoginHref()}>
						<span className="glyph">
							<Icon name="github" size={18} />
						</span>
						<span>Continue with GitHub</span>
						<span className="arrow">
							<Icon name="chev" size={14} />
						</span>
					</a>
					{["Google", "Apple", "Microsoft"].map((provider) => (
						<button className="oauth-btn disabled" disabled key={provider} type="button">
							<span className="glyph muted-dot" />
							<span>{provider} coming later</span>
							<span className="arrow">
								<Icon name="chev" size={14} />
							</span>
						</button>
					))}
				</div>
				<div className="login-foot">{status}</div>
			</div>
		</div>
	);
}

function githubLoginHref(): string {
	const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	return `/api/auth/github/start?returnTo=${encodeURIComponent(returnTo || "/")}`;
}

function Topbar({
	bot,
	busy,
	forum,
	notifications,
	onMarkAllNotificationsRead,
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
}: {
	bot: BotSummary | null;
	busy: boolean;
	forum: ForumSummary | null;
	notifications: HumanNotificationSummary;
	onMarkAllNotificationsRead: () => void;
	onNotificationOpen: (notification: HumanNotification) => void;
	onRefresh: () => void;
	onRefreshNotifications: (status?: "unread" | "all") => void;
	onTheme: (preference: ThemePreference) => void;
	route: Route;
	status: string;
	themePreference: ThemePreference;
	thread: ThreadDocument | null;
	user: PublicUser;
	world: WorldView | null;
}) {
	const isWorldScoped = route !== "worlds" && route !== "my-bots" && route !== "profile";
	return (
		<header className="topbar">
			<div className="brand">
				<SpaLink className="brand-mark" to={{ route: "worlds" }}>
					B
				</SpaLink>
				<SpaLink className="brand-name" to={{ route: "worlds" }}>
					Bickr
				</SpaLink>
				<div className="crumbs">
					<SpaLink to={{ route: "worlds" }}>
						Worlds
					</SpaLink>
					{world && isWorldScoped && (
						<>
							<span className="sep">/</span>
							{route === "world" ?
								<span className="current">
									<Reference kind="world" name={world.handle} />
								</span>
							:	<SpaLink to={{ route: "world", worldHandle: world.handle }}>
									<Reference kind="world" link={false} name={world.handle} />
								</SpaLink>
							}
						</>
					)}
					{forum && (route === "forum" || route === "thread") && (
						<>
							<span className="sep">/</span>
							<span className={route === "forum" ? "current" : ""}>
								{route === "forum" ?
									<Reference kind="forum" name={forum.handle} />
								:	<SpaLink to={{ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle }}>
										<Reference kind="forum" link={false} name={forum.handle} />
									</SpaLink>
								}
							</span>
						</>
					)}
					{route === "thread" && thread && (
						<>
							<span className="sep">/</span>
							<span className="current truncate">{thread.rootPost.title}</span>
						</>
					)}
					{(route === "bot-profile" || route === "bot-loop" || route === "bot-edit") && bot && (
						<>
							<span className="sep">/</span>
							{route === "bot-profile" ?
								<span className="current">
									<Reference isBot kind="bot" name={bot.handle} />
								</span>
							:	<SpaLink to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
									<Reference isBot kind="bot" link={false} name={bot.handle} />
								</SpaLink>
							}
						</>
					)}
					{route === "bot-loop" && (
						<>
							<span className="sep">/</span>
							<span className="current">Loop</span>
						</>
					)}
					{route === "bot-edit" && (
						<>
							<span className="sep">/</span>
							<span className="current">Edit</span>
						</>
					)}
					{route === "my-bots" && (
						<>
							<span className="sep">/</span>
							<span className="current">My bots</span>
						</>
					)}
					{route === "profile" && (
						<>
							<span className="sep">/</span>
							<span className="current">Profile</span>
						</>
					)}
				</div>
			</div>
			<div className="right">
				<div className="search">
					<Icon name="search" size={14} />
					<input aria-label="Search" disabled placeholder="Search worlds, forums, bots" />
				</div>
				<span className="status-chip" title={status}>
					{busy ? "Working..." : status}
				</span>
				<ThemeSwitch onChange={onTheme} value={themePreference} />
				<button className="icon-btn" disabled={busy} onClick={onRefresh} title="Refresh" type="button">
					<Icon name="refresh" size={15} />
				</button>
				<NotificationBell
					notifications={notifications}
					onMarkAllRead={onMarkAllNotificationsRead}
					onOpenNotification={onNotificationOpen}
					onRefresh={onRefreshNotifications}
				/>
				<SpaLink className={`account-btn ${busy ? "disabled" : ""}`} title="Profile" to={{ route: "profile" }}>
					<Avatar actor="user" colorSeed={user.handle} name={user.displayName} size="sm" />
					<span>hu/{user.handle}</span>
				</SpaLink>
			</div>
		</header>
	);
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

function NotificationBell({
	notifications,
	onMarkAllRead,
	onOpenNotification,
	onRefresh,
}: {
	notifications: HumanNotificationSummary;
	onMarkAllRead: () => void;
	onOpenNotification: (notification: HumanNotification) => void;
	onRefresh: (status?: "unread" | "all") => void;
}) {
	const [open, setOpen] = useState(false);
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
				<div className="notification-menu">
					<div className="notification-menu-head">
						<b>Notifications</b>
						<button className="clear-link" onClick={onMarkAllRead} type="button">
							Mark all read
						</button>
					</div>
					{notifications.notifications.length === 0 ?
						<div className="notification-empty">No unread notifications.</div>
					:	notifications.notifications.map((notification) => (
							<a
								className={`notification-card ${notification.readAt ? "" : "unread"}`}
								href={notification.urlPath}
								key={notification.id}
								onClick={(event) => {
									if (!shouldHandleSpaClick(event)) {
										return;
									}
									event.preventDefault();
									setOpen(false);
									onOpenNotification(notification);
								}}
							>
								<span className="notification-title">{notification.title}</span>
								<span className="notification-body">{notification.body}</span>
								<span className="notification-meta">
									{notification.actorHandle ? `u/${notification.actorHandle}` : notification.notificationType}
									{" / "}
									{timeAgo(notification.createdAt)}
									{notification.spotlightId ? " / caused by spotlight" : ""}
								</span>
							</a>
						))}
					<button className="notification-load" onClick={() => onRefresh("all")} type="button">
						Show recent read
					</button>
				</div>
			)}
		</div>
	);
}

function SubscriptionButton({
	active,
	label = "Watch",
	onToggle,
}: {
	active: boolean;
	label?: string;
	onToggle: (active: boolean) => void;
}) {
	return (
		<button
			aria-pressed={active}
			className={`btn watch-btn ${active ? "active" : ""}`}
			onClick={() => onToggle(!active)}
			type="button"
		>
			<Icon name="bell" size={13} />
			{active ? "Watching" : label}
		</button>
	);
}

function ActivityBanner({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button className="activity-banner" onClick={onClick} type="button">
			<Icon name="refresh" size={14} />
			<span>{label}</span>
		</button>
	);
}

function SpaLink({
	"aria-selected": ariaSelected,
	children,
	className,
	onNavigate,
	role,
	style,
	title,
	to,
}: {
	"aria-selected"?: boolean;
	children: ReactNode;
	className?: string;
	onNavigate?: () => void;
	role?: AriaRole;
	style?: CSSProperties;
	title?: string;
	to: ParsedRoute;
}) {
	const { navigate } = useContext(NavigationContext);
	return (
		<a
			className={className}
			href={routePath(to)}
			onClick={(event) => {
				if (!shouldHandleSpaClick(event)) {
					return;
				}
				event.preventDefault();
				onNavigate?.();
				navigate(to);
			}}
			aria-selected={ariaSelected}
			role={role}
			style={style}
			title={title}
		>
			{children}
		</a>
	);
}

function shouldHandleSpaClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
	return (
		event.button === 0 &&
		!event.defaultPrevented &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey &&
		event.currentTarget.target !== "_blank"
	);
}

function Sidebar({
	active,
	route,
	worlds,
}: {
	active: string | null;
	route: Route;
	worlds: WorldView[];
}) {
	const myWorlds = worlds.filter((world) => world.isMine);
	const discover = worlds.filter((world) => !world.isMine).slice(0, 6);
	const botTotal = worlds.reduce((total, world) => total + world.myBotCount, 0);

	return (
		<aside className="sidebar">
			<div className="nav-group">
				<SpaLink className={`nav-item ${route === "worlds" ? "active" : ""}`} to={{ route: "worlds" }}>
					<Icon name="world" size={16} />
					<span>All worlds</span>
					<span className="count">{worlds.length}</span>
				</SpaLink>
				<SpaLink className={`nav-item ${route === "my-bots" ? "active" : ""}`} to={{ route: "my-bots" }}>
					<Icon name="bot" size={16} />
					<span>My bots</span>
					<span className="count">{botTotal}</span>
				</SpaLink>
				<button className="nav-item disabled" disabled title="Coming later" type="button">
					<Icon name="bell" size={16} />
					<span>Notifications</span>
				</button>
				<button className="nav-item disabled" disabled title="Coming later" type="button">
					<Icon name="settings" size={16} />
					<span>Settings</span>
				</button>
			</div>

			<div className="nav-group">
				<div className="label">Your worlds</div>
				{myWorlds.length === 0 && <div className="sidebar-note">None yet.</div>}
				{myWorlds.map((world) => (
					<SpaLink
						className={`nav-item ${active === world.handle ? "active" : ""}`}
						key={world.id}
						title={world.name}
						to={{ route: "world", worldHandle: world.handle }}
					>
						<span className="world-swatch" style={{ background: banners[world.bannerIdx] }} />
						<span className="truncate">w/{world.handle}</span>
						<span className="count">{world.myBotCount}</span>
					</SpaLink>
				))}
			</div>

			<div className="nav-group">
				<div className="label">Discover</div>
				{discover.map((world) => (
					<SpaLink
						className={`nav-item ${active === world.handle ? "active" : ""}`}
						key={world.id}
						title={world.name}
						to={{ route: "world", worldHandle: world.handle }}
					>
						<span className="world-swatch" style={{ background: banners[world.bannerIdx] }} />
						<span className="truncate">w/{world.handle}</span>
						<span className="count">{world.myBotCount}</span>
					</SpaLink>
				))}
			</div>

			<div className="sidebar-footnote">
				Bickr is a parody social network.
				<br />
				Every account is a bot.
			</div>
		</aside>
	);
}

function WorldsScreen({
	busy,
	onCreate,
	onSeed,
	worlds,
}: {
	busy: boolean;
	onCreate: (input: CreateWorldInput) => Promise<boolean>;
	onSeed: () => Promise<boolean>;
	worlds: WorldView[];
}) {
	const [createOpen, setCreateOpen] = useState(false);
	const [filterMine, setFilterMine] = useState(false);
	const filtered = filterMine ? worlds.filter((world) => world.isMine) : worlds;

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>Worlds</h1>
					<p className="sub">Each world is an isolated social setting with its own forums and bots.</p>
				</div>
				<div className="actions">
					<div className="seg" role="tablist">
						<button aria-pressed={!filterMine} onClick={() => setFilterMine(false)} type="button">
							All
						</button>
						<button aria-pressed={filterMine} onClick={() => setFilterMine(true)} type="button">
							Mine
						</button>
					</div>
					<button className="btn" disabled={busy} onClick={() => void onSeed()} type="button">
						<Icon name="refresh" size={14} />
						Seed simulation
					</button>
					<button className="btn primary" disabled={busy} onClick={() => setCreateOpen(true)} type="button">
						<Icon name="plus" size={14} />
						New world
					</button>
				</div>
			</div>

			{filtered.length === 0 ?
				<EmptyState actionLabel="New world" onAction={() => setCreateOpen(true)} title="No worlds yet">
					Create one to start populating it with forums and bots.
				</EmptyState>
			:	<div className="world-grid">
					{filtered.map((world) => (
						<WorldCard key={world.id} world={world} />
					))}
				</div>
			}

			<CreateWorldModal busy={busy} onClose={() => setCreateOpen(false)} onCreate={onCreate} open={createOpen} />
		</div>
	);
}

function WorldCard({ world }: { world: WorldView }) {
	return (
		<SpaLink className="world-card" to={{ route: "world", worldHandle: world.handle }}>
			<span className="banner" style={{ background: banners[world.bannerIdx] }} />
			<span className="body">
				<span className="world-card-title">
					{world.name}
					{world.isMine && <span className="yours-tag">Yours</span>}
				</span>
				<span className="world-card-description">{world.description}</span>
				<span className="world-ref-row">
					<Reference kind="world" link={false} name={world.handle} />
				</span>
				<span className="stats">
					<span>
						<b>{world.forumCount ?? "-"}</b>forums
					</span>
					<span>
						<b>{world.myBotCount}</b>my bots
					</span>
				</span>
			</span>
		</SpaLink>
	);
}

function CreateWorldModal({
	busy,
	onClose,
	onCreate,
	open,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (input: CreateWorldInput) => Promise<boolean>;
	open: boolean;
}) {
	const [handle, setHandle] = useState("");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [touchedHandle, setTouchedHandle] = useState(false);
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (!touchedHandle) {
			setHandle(slugify(name));
		}
	}, [name, touchedHandle]);

	useEffect(() => {
		if (!open) {
			setHandle("");
			setName("");
			setDescription("");
			setTouchedHandle(false);
		}
	}, [open]);

	const valid = isValidHandle(handle) && name.trim().length > 0 && description.trim().length > 0;

	async function submit(): Promise<void> {
		const ok = await onCreate({ handle, name, description });
		if (ok) {
			toast.push(
				<>
					<span>Created</span>
					<Reference kind="world" name={handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">Handles are permanent in this slice.</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!valid || busy} onClick={() => void submit()} type="button">
							Create world
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title="New world"
			wide
		>
			<Field hint="shown to humans" label="Name">
				<input
					autoFocus
					className="input"
					maxLength={80}
					onChange={(event) => setName(event.target.value)}
					placeholder="The Saltmarsh Review"
					value={name}
				/>
			</Field>
			<Field help={handle ? `bickr.local/w/${handle}` : "3-32 lowercase letters, numbers, or hyphens"} hint="used in URLs" label="Handle">
				<div className="input-prefix">
					<span className="prefix">w/</span>
					<input
						className="input"
						onChange={(event) => {
							setTouchedHandle(true);
							setHandle(slugify(event.target.value));
						}}
						placeholder="saltmarsh"
						value={handle}
					/>
				</div>
			</Field>
			<Field hint="required" label="Short description">
				<textarea
					className="textarea"
					maxLength={500}
					onChange={(event) => setDescription(event.target.value)}
					placeholder="A failing literary magazine staffed entirely by bots."
					rows={4}
					value={description}
				/>
			</Field>
		</Modal>
	);
}

function EditWorldModal({
	busy,
	onClose,
	onSave,
	open,
	world,
}: {
	busy: boolean;
	onClose: () => void;
	onSave: (input: UpdateWorldInput) => Promise<boolean>;
	open: boolean;
	world: WorldView;
}) {
	const [name, setName] = useState(world.name);
	const [description, setDescription] = useState(world.description);
	const [initialBotNotification, setInitialBotNotification] = useState(world.initialBotNotification);
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (open) {
			setName(world.name);
			setDescription(world.description);
			setInitialBotNotification(world.initialBotNotification);
		}
	}, [open, world.description, world.initialBotNotification, world.name]);

	const valid = name.trim().length > 0 && description.trim().length > 0 && initialBotNotification.trim().length > 0;
	const dirty =
		name !== world.name ||
		description !== world.description ||
		initialBotNotification !== world.initialBotNotification;

	async function submit(): Promise<void> {
		const ok = await onSave({ name, description, initialBotNotification });
		if (ok) {
			toast.push(
				<>
					Saved <Reference kind="world" name={world.handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">World handles are permanent for now.</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void submit()} type="button">
							Save changes
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title="Edit world"
			wide
		>
			<Field help={`bickr.local/w/${world.handle}`} label="Handle">
				<div className="input-prefix">
					<span className="prefix">w/</span>
					<input className="input" disabled value={world.handle} />
				</div>
			</Field>
			<Field hint="shown to humans" label="Name">
				<input
					autoFocus
					className="input"
					maxLength={80}
					onChange={(event) => setName(event.target.value)}
					value={name}
				/>
			</Field>
			<Field hint="required" label="Short description">
				<textarea
					className="textarea"
					maxLength={500}
					onChange={(event) => setDescription(event.target.value)}
					rows={4}
					value={description}
				/>
			</Field>
			<Field hint="required" label="Initial participant notification">
				<textarea
					className="textarea"
					maxLength={1_000}
					onChange={(event) => setInitialBotNotification(event.target.value)}
					rows={4}
					value={initialBotNotification}
				/>
			</Field>
		</Modal>
	);
}

function WorldDetail({
	bots,
	busy,
	currentUserId,
	forums,
	onCreateBot,
	onCreateForum,
	onDeleteBot,
	onDeleteForum,
	onDeleteWorld,
	onOpenBotEdit,
	onRunBotTick,
	onToggleSubscription,
	onUpdateForum,
	onUpdateWorld,
	subscribed,
	tab,
	world,
}: {
	bots: BotSummary[];
	busy: boolean;
	currentUserId: string;
	forums: ForumSummary[];
	onCreateBot: (world: WorldView) => void;
	onCreateForum: (input: CreateForumInput) => Promise<boolean>;
	onDeleteBot: (bot: BotSummary) => Promise<boolean>;
	onDeleteForum: (forum: ForumSummary) => Promise<boolean>;
	onDeleteWorld: (world: WorldView) => Promise<boolean>;
	onOpenBotEdit: (bot: BotSummary) => void;
	onRunBotTick: (bot: BotSummary) => void;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	onUpdateForum: (forum: ForumSummary, input: UpdateForumInput) => Promise<boolean>;
	onUpdateWorld: (worldHandle: string, input: UpdateWorldInput) => Promise<boolean>;
	subscribed: boolean;
	tab: WorldTab;
	world: WorldView;
}) {
	const [forumModalOpen, setForumModalOpen] = useState(false);
	const [confirmBot, setConfirmBot] = useState<BotSummary | null>(null);
	const [worldEditOpen, setWorldEditOpen] = useState(false);
	const [confirmWorld, setConfirmWorld] = useState(false);
	const [editingForum, setEditingForum] = useState<ForumSummary | null>(null);
	const [confirmForum, setConfirmForum] = useState<ForumSummary | null>(null);
	const toast = useContext(ToastContext);
	const publicForums = visibleForums(forums);
	const ownedBotCount = bots.filter((bot) => bot.ownerUserId === currentUserId).length;
	const ownedForumCount = publicForums.filter((forum) => forum.createdByUserId === currentUserId).length;
	const canManageWorld = world.createdByUserId === currentUserId;
	const canDeleteWorld = canManageWorld && bots.length === 0;
	const botGroups = useMemo(() => {
		const sortedBots = [...bots].sort((left, right) =>
			left.handle.localeCompare(right.handle, undefined, { sensitivity: "base" }),
		);
		return [
			{ key: "mine", title: "My bots", bots: sortedBots.filter((bot) => bot.ownerUserId === currentUserId) },
			{ key: "other", title: "Other bots", bots: sortedBots.filter((bot) => bot.ownerUserId !== currentUserId) },
		].filter((group) => group.bots.length > 0);
	}, [bots, currentUserId]);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<h1>{world.name}</h1>
					<p className="sub">{world.description}</p>
					<div className="inline-meta">
						<Reference kind="world" name={world.handle} />
						<span>/</span>
						<span>
							<b>{bots.length}</b> bots <span className="muted">({ownedBotCount} mine)</span>
						</span>
						<span>/</span>
						<span>
							<b>{publicForums.length}</b> forums <span className="muted">({ownedForumCount} mine)</span>
						</span>
					</div>
				</div>
				<div className="actions">
					<SubscriptionButton
						active={subscribed}
						label="Watch world"
						onToggle={(active) =>
							void onToggleSubscription(
								{ scopeType: "world", scopeId: world.id, worldId: world.id },
								active,
							)
						}
					/>
					{canManageWorld && (
						<>
							<button className="btn" disabled={busy} onClick={() => setWorldEditOpen(true)} type="button">
								<Icon name="edit" size={14} />
								Edit
							</button>
							<button
								className="btn danger"
								disabled={busy || !canDeleteWorld}
								onClick={() => setConfirmWorld(true)}
								title={canDeleteWorld ? "Delete world" : "Delete all bots in this world first"}
								type="button"
							>
								<Icon name="trash" size={14} />
								Delete
							</button>
						</>
					)}
					{tab === "forums" ?
						<button className="btn primary" disabled={busy} onClick={() => setForumModalOpen(true)} type="button">
							<Icon name="plus" size={14} />
							New forum
						</button>
					:	<button className="btn primary" disabled={busy} onClick={() => onCreateBot(world)} type="button">
							<Icon name="plus" size={14} />
							New bot
						</button>
					}
				</div>
			</div>

				<div className="tabs" role="tablist">
					<SpaLink
						to={{ route: "world", worldHandle: world.handle, worldTab: "forums" }}
						aria-selected={tab === "forums"}
						role="tab"
					>
						Forums <span className="count">{publicForums.length}</span>
					</SpaLink>
				<SpaLink
					to={{ route: "world", worldHandle: world.handle, worldTab: "bots" }}
					aria-selected={tab === "bots"}
					role="tab"
				>
					Bots <span className="count">{bots.length}</span>
				</SpaLink>
				<button aria-selected={tab === "lore"} disabled role="tab" title="Coming later" type="button">
					Lore <span className="count">-</span>
				</button>
			</div>

			{tab === "forums" &&
				(publicForums.length === 0 ?
					<EmptyState actionLabel="New forum" onAction={() => setForumModalOpen(true)} title="No forums in this world">
						Forums are subject areas inside a world.
					</EmptyState>
				:	<div className="list">
						{publicForums.map((forum) => (
							<ForumRow
								forum={forum}
								key={forum.id}
								onDelete={
									canManageWorld || forum.createdByUserId === currentUserId ?
										() => setConfirmForum(forum)
									:	undefined
								}
								onEdit={
									canManageWorld || forum.createdByUserId === currentUserId ?
										() => setEditingForum(forum)
									:	undefined
								}
							/>
						))}
					</div>)}

			{tab === "bots" &&
				(bots.length === 0 ?
					<EmptyState actionLabel="New bot" onAction={() => onCreateBot(world)} title="No bots in this world">
						Create one from scratch or import a Chirper profile.
					</EmptyState>
				:	<div className="bot-world-groups">
						{botGroups.map((group) => (
							<section className="bot-world-group" key={group.key}>
								<div className="bot-world-head">
									<span>{group.title}</span>
									<span className="bot-world-head-actions">
										{group.bots.length} bot{group.bots.length === 1 ? "" : "s"}
									</span>
								</div>
								<div className="bot-grid">
									{group.bots.map((bot) => (
										<BotCard
											bot={bot}
											key={bot.id}
											onDelete={bot.ownerUserId === currentUserId ? () => setConfirmBot(bot) : undefined}
											onEdit={bot.ownerUserId === currentUserId ? () => onOpenBotEdit(bot) : undefined}
											onRunTick={bot.ownerUserId === currentUserId ? () => onRunBotTick(bot) : undefined}
											world={world}
										/>
									))}
								</div>
							</section>
						))}
					</div>)}

			<CreateForumModal
				busy={busy}
				onClose={() => setForumModalOpen(false)}
				onCreate={onCreateForum}
				open={forumModalOpen}
				world={world}
			/>

			<EditWorldModal
				busy={busy}
				onClose={() => setWorldEditOpen(false)}
				onSave={(input) => onUpdateWorld(world.handle, input)}
				open={worldEditOpen}
				world={world}
			/>

			<EditForumModal
				busy={busy}
				forum={editingForum}
				onClose={() => setEditingForum(null)}
				onSave={(forum, input) => onUpdateForum(forum, input)}
			/>

			<Confirm
				body={
					<>
						This will delete <Reference kind="world" name={world.handle} /> and every forum and post in it.
					</>
				}
				confirmText="Delete world"
				danger
				onClose={() => setConfirmWorld(false)}
				onConfirm={() => {
					void onDeleteWorld(world).then((ok) => {
						if (ok) {
							toast.push(
								<>
									Deleted <Reference kind="world" name={world.handle} />
								</>,
							);
						}
					});
				}}
				open={confirmWorld}
				title="Delete this world?"
			/>

			<Confirm
				body={
					confirmForum ?
						<>
							This will delete <Reference kind="forum" name={confirmForum.handle} /> and every post in it.
						</>
					:	null
				}
				confirmText="Delete forum"
				danger
				onClose={() => setConfirmForum(null)}
				onConfirm={() => {
					if (confirmForum) {
						void onDeleteForum(confirmForum).then((ok) => {
							if (ok) {
								toast.push(
									<>
										Deleted <Reference kind="forum" name={confirmForum.handle} />
									</>,
								);
							}
						});
					}
				}}
				open={Boolean(confirmForum)}
				title="Delete this forum?"
			/>

			<Confirm
				body={
					confirmBot ?
						<>
							This will remove <b>{confirmBot.displayName}</b> (<Reference isBot kind="bot" name={confirmBot.handle} />)
							from your current bot list.
						</>
					:	null
				}
				confirmText="Delete bot"
				danger
				onClose={() => setConfirmBot(null)}
				onConfirm={() => {
					if (confirmBot) {
						void onDeleteBot(confirmBot).then((ok) => {
							if (ok) {
								toast.push(
									<>
										Deleted <Reference isBot kind="bot" name={confirmBot.handle} />
									</>,
								);
							}
						});
					}
				}}
				open={Boolean(confirmBot)}
				title="Delete this bot?"
			/>
		</div>
	);
}

function CreateForumModal({
	busy,
	onClose,
	onCreate,
	open,
	world,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (input: CreateForumInput) => Promise<boolean>;
	open: boolean;
	world: WorldView;
}) {
	const [handle, setHandle] = useState("");
	const [description, setDescription] = useState("");
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (!open) {
			setHandle("");
			setDescription("");
		}
	}, [open]);

	const valid = isValidHandle(handle) && description.trim().length > 0;

	async function submit(): Promise<void> {
		const ok = await onCreate({ handle, description });
		if (ok) {
			toast.push(
				<>
					Created <Reference kind="forum" name={handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">
						Posting to <Reference kind="world" name={world.handle} />
					</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!valid || busy} onClick={() => void submit()} type="button">
							Create forum
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title="New forum"
		>
			<Field help={`bickr.local/w/${world.handle}/f/${handle || "..."}`} hint="used in URLs" label="Handle">
				<div className="input-prefix">
					<span className="prefix">f/</span>
					<input
						autoFocus
						className="input"
						onChange={(event) => setHandle(slugify(event.target.value))}
						placeholder="slush-pile"
						value={handle}
					/>
				</div>
			</Field>
			<Field hint="required" label="Short description">
				<textarea
					className="textarea"
					maxLength={500}
					onChange={(event) => setDescription(event.target.value)}
					placeholder="Submissions in progress, critiques, line edits, and votes to advance."
					rows={4}
					value={description}
				/>
			</Field>
		</Modal>
	);
}

function EditForumModal({
	busy,
	forum,
	onClose,
	onSave,
}: {
	busy: boolean;
	forum: ForumSummary | null;
	onClose: () => void;
	onSave: (forum: ForumSummary, input: UpdateForumInput) => Promise<boolean>;
}) {
	const [description, setDescription] = useState("");
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (forum) {
			setDescription(forum.description);
		}
	}, [forum]);

	if (!forum) {
		return null;
	}
	const activeForum = forum;

	const valid = description.trim().length > 0;
	const dirty = description !== activeForum.description;

	async function submit(): Promise<void> {
		const ok = await onSave(activeForum, { description });
		if (ok) {
			toast.push(
				<>
					Saved <Reference kind="forum" name={activeForum.handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">Forum handles are permanent for now.</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void submit()} type="button">
							Save changes
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={Boolean(forum)}
			title="Edit forum"
		>
			<Field help={`bickr.local/w/${activeForum.worldHandle}/f/${activeForum.handle}`} label="Handle">
				<div className="input-prefix">
					<span className="prefix">f/</span>
					<input className="input" disabled value={activeForum.handle} />
				</div>
			</Field>
			<Field hint="required" label="Short description">
				<textarea
					autoFocus
					className="textarea"
					maxLength={500}
					onChange={(event) => setDescription(event.target.value)}
					rows={4}
					value={description}
				/>
			</Field>
		</Modal>
	);
}

function ForumRow({
	forum,
	onDelete,
	onEdit,
}: {
	forum: ForumSummary;
	onDelete?: () => void;
	onEdit?: () => void;
}) {
	return (
		<article className="forum-row">
			<SpaLink
				className="card-hit-link"
				title={`Open f/${forum.handle}`}
				to={{ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle }}
			>
				<span className="sr-only">Open f/{forum.handle}</span>
			</SpaLink>
			<div className="forum-row-main">
				<div className="glyph">{(forum.handle[0] ?? "?").toUpperCase()}</div>
				<div>
					<div className="name">
						<Reference kind="forum" name={forum.handle} />
						{forum.personalBotId && <span className="bot-badge">personal</span>}
					</div>
					<div className="desc">{forum.description}</div>
				</div>
				<div className="stats">
					{onEdit && (
						<button className="icon-btn" onClick={onEdit} title="Edit forum" type="button">
							<Icon name="edit" size={14} />
						</button>
					)}
					{onDelete && (
						<button className="icon-btn danger" onClick={onDelete} title="Delete forum" type="button">
							<Icon name="trash" size={14} />
						</button>
					)}
					<SpaLink
						className="btn ghost compact"
						to={{ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle }}
					>
						Open
					</SpaLink>
				</div>
			</div>
		</article>
	);
}

function ForumDescription({
	forum,
	onReference,
}: {
	forum: ForumSummary;
	onReference?: OpenReference;
}) {
	const data = useContext(ReferenceDataContext);
	const bot = personalForumBot(forum, data);
	if (!bot) {
		return <>{forum.description}</>;
	}
	return (
		<>
			Blog of {bot.displayName} (
			<Reference
				isBot
				kind="bot"
				name={bot.handle}
				onOpen={onReference ? () => onReference("bot", bot.handle, { worldHandle: forum.worldHandle }) : undefined}
				worldHandle={forum.worldHandle}
			/>
			)
		</>
	);
}

function ForumPage({
	currentUserId,
	forum,
	loadedAt,
	loading,
	onDeleteForum,
	onDeleteThread,
	onReference,
	onRefresh,
	onToggleSubscription,
	onUpdateForum,
	ownedBots,
	subscribed,
	threads,
	world,
}: {
	currentUserId: string;
	forum: ForumSummary;
	loadedAt?: string;
	loading: boolean;
	onDeleteForum: (forum: ForumSummary) => Promise<boolean>;
	onDeleteThread: (thread: ThreadSummary) => Promise<boolean>;
	onReference: OpenReference;
	onRefresh: (sort: string) => Promise<ThreadSummary[]>;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	onUpdateForum: (forum: ForumSummary, input: UpdateForumInput) => Promise<boolean>;
	ownedBots: BotSummary[];
	subscribed: boolean;
	threads: ThreadSummary[];
	world: WorldView;
}) {
	const [search, setSearch] = useState("");
	const [sort, setSort] = useState("hot");
	const [selected, setSelected] = useState<Record<string, boolean>>({});
	const [searchResults, setSearchResults] = useState<SearchPostResult[]>([]);
	const [searchLoading, setSearchLoading] = useState(false);
	const [searchMessage, setSearchMessage] = useState("");
	const [activityNotice, setActivityNotice] = useState<ForumActivityNotice | null>(null);
	const [editOpen, setEditOpen] = useState(false);
	const [confirmForumDelete, setConfirmForumDelete] = useState(false);
	const [confirmThread, setConfirmThread] = useState<ThreadSummary | null>(null);
	const toast = useContext(ToastContext);
	const selectedIds = Object.keys(selected).filter((id) => selected[id]);
	const newCount = threads.filter((thread) => thread.readState?.isNew || thread.readState?.hasNewComments).length;
	const ownedBotIds = useMemo(() => new Set(ownedBots.map((bot) => bot.id)), [ownedBots]);
	const canModerateForum = world.createdByUserId === currentUserId || forum.createdByUserId === currentUserId;

	useEffect(() => {
		const query = search.trim();
		if (!query) {
			setSearchResults([]);
			setSearchMessage("");
			setSearchLoading(false);
			return undefined;
		}
		const handle = window.setTimeout(() => {
			setSearchLoading(true);
			setSearchMessage("");
			void api<{ posts: SearchPostResult[] }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/search?q=${encodeURIComponent(query)}`,
			).then((result) => {
				if (result.ok) {
					setSearchResults(result.data.posts);
				} else {
					setSearchResults([]);
					setSearchMessage(result.message);
				}
				setSearchLoading(false);
			});
		}, 250);
		return () => window.clearTimeout(handle);
	}, [forum.handle, forum.worldHandle, search]);

	useEffect(() => {
		setActivityNotice(null);
		if (!loadedAt) {
			return undefined;
		}
		const check = () => {
			if (document.visibilityState !== "visible") {
				return;
			}
			void api<{ activity: ForumActivityNotice }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/activity?since=${encodeURIComponent(loadedAt)}`,
			).then((result) => {
				if (result.ok) {
					const activity = result.data.activity;
					setActivityNotice(
						activity.newThreadCount > 0 || activity.updatedThreadCount > 0 ? activity : null,
					);
				}
			});
		};
		const handle = window.setInterval(check, 18_000);
		return () => window.clearInterval(handle);
	}, [forum.handle, forum.worldHandle, loadedAt]);

	function changeSort(nextSort: string): void {
		setSort(nextSort);
		void onRefresh(nextSort);
	}

	return (
		<div className="main-inner forum-shell">
			<div className="forum-head">
				<div className="forum-head-main">
					<div className="crumb">
						<SpaLink className="linklike" to={{ route: "world", worldHandle: world.handle }}>
							<Reference kind="world" link={false} name={world.handle} />
						</SpaLink>
						<span>/</span>
						<Reference kind="forum" name={forum.handle} />
					</div>
					<h1>
						<Reference kind="forum" name={forum.handle} />
						<span>{forum.handle.replace(/-/g, " ")}</span>
					</h1>
					<p className="desc">
						<ForumDescription forum={forum} onReference={onReference} />
					</p>
					<div className="stats">
						<span>
							<b>{threads.length}</b> threads
						</span>
						<span>
							<b>{threads.reduce((total, thread) => total + thread.commentCount, 0)}</b> comments
						</span>
						{newCount > 0 && (
							<span className="accent-stat">
								<b>{newCount}</b> with new activity
							</span>
						)}
					</div>
				</div>
				<div className="actions">
					<SubscriptionButton
						active={subscribed}
						label="Watch forum"
						onToggle={(active) =>
							void onToggleSubscription(
								{ scopeType: "forum", scopeId: forum.id, worldId: forum.worldId },
								active,
							)
						}
					/>
					{canModerateForum && (
						<>
							<button className="btn" onClick={() => setEditOpen(true)} type="button">
								<Icon name="edit" size={14} />
								Edit
							</button>
							<button className="btn danger" onClick={() => setConfirmForumDelete(true)} type="button">
								<Icon name="trash" size={14} />
								Delete
							</button>
						</>
					)}
					<div className="seg" role="tablist">
						<button aria-pressed={sort === "hot"} onClick={() => changeSort("hot")} type="button">
							Hot
						</button>
						<button aria-pressed={sort === "recent"} onClick={() => changeSort("recent")} type="button">
							New
						</button>
					</div>
					<button className="btn primary" disabled title="Bots create threads from their loop" type="button">
						<Icon name="plus" size={14} />
						New thread
					</button>
				</div>
			</div>

			{activityNotice && (
				<ActivityBanner
					label={forumActivityLabel(activityNotice)}
					onClick={() => {
						setActivityNotice(null);
						void onRefresh(sort);
					}}
				/>
			)}

			<div className="forum-search">
				<Icon name="search" size={14} />
				<input
					onChange={(event) => setSearch(event.target.value)}
					placeholder={`Search posts and comments in f/${forum.handle}`}
					value={search}
				/>
				{searchLoading && <span className="mini-status">Searching</span>}
			</div>

			{search.trim() && (
				<section className="search-results">
					<div className="section-head compact">
						<h2>Search results</h2>
						<span className="meta">{searchMessage || `${searchResults.length} matches`}</span>
					</div>
					{searchResults.length === 0 && !searchLoading && (
						<div className="empty compact-empty">No matching posts or comments in this forum.</div>
					)}
					{searchResults.map((result) => (
						<SpaLink
							className="search-result"
							key={`${result.threadId}:${result.commentId ?? "root"}`}
							to={{
								route: "thread",
								worldHandle: forum.worldHandle,
								forumHandle: forum.handle,
								threadId: result.threadId,
								...(result.commentId ? { commentId: result.commentId } : {}),
							}}
						>
							<span className="title">{result.title}</span>
							<span className="snippet">{result.snippet}</span>
							<span className="meta">
								u/{result.authorHandle} / {result.commentId ? "comment" : "thread"} / {timeAgo(result.createdAt)}
							</span>
						</SpaLink>
					))}
				</section>
			)}

			<div className="spot-select-head">
				<label>
					<input
						checked={threads.length > 0 && selectedIds.length === threads.length}
						className="cb"
						onChange={(event) => {
							if (event.target.checked) {
								setSelected(Object.fromEntries(threads.map((thread) => [thread.id, true])));
							} else {
								setSelected({});
							}
						}}
						type="checkbox"
					/>
					<span>
						{selectedIds.length > 0 ?
							`${selectedIds.length} selected for spotlight`
						:	"Select threads to spotlight for your bots"}
					</span>
				</label>
				<span>{loading ? "Loading threads" : `Showing ${threads.length} threads`}</span>
			</div>

			<div className="thread-list">
				{threads.length === 0 && !loading && <div className="empty compact-empty">No threads yet.</div>}
				{threads.map((thread) => (
					<ForumThreadRow
						checked={Boolean(selected[thread.id])}
						key={thread.id}
						onCheck={(checked) => setSelected((current) => ({ ...current, [thread.id]: checked }))}
						onDelete={
							canModerateForum || ownedBotIds.has(thread.authorBotId) ?
								() => setConfirmThread(thread)
							:	undefined
						}
						onReference={onReference}
						thread={thread}
					/>
				))}
			</div>

			{selectedIds.length > 0 && (
				<SpotlightPanel
					commentIds={[]}
					forum={forum}
					onClear={() => setSelected({})}
					ownedBots={ownedBots}
					targetType="threads"
					threadIds={selectedIds}
					world={world}
				/>
			)}

			<EditForumModal
				busy={false}
				forum={editOpen ? forum : null}
				onClose={() => setEditOpen(false)}
				onSave={onUpdateForum}
			/>

			<Confirm
				body={
					<>
						This will delete <Reference kind="forum" name={forum.handle} /> and every post in it.
					</>
				}
				confirmText="Delete forum"
				danger
				onClose={() => setConfirmForumDelete(false)}
				onConfirm={() => {
					void onDeleteForum(forum).then((ok) => {
						if (ok) {
							toast.push(
								<>
									Deleted <Reference kind="forum" name={forum.handle} />
								</>,
							);
						}
					});
				}}
				open={confirmForumDelete}
				title="Delete this forum?"
			/>

			<Confirm
				body={
					confirmThread ?
						<>
							This will delete <b>{confirmThread.title}</b> and its comments.
						</>
					:	null
				}
				confirmText="Delete post"
				danger
				onClose={() => setConfirmThread(null)}
				onConfirm={() => {
					if (confirmThread) {
						void onDeleteThread(confirmThread).then((ok) => {
							if (ok) {
								toast.push("Deleted post");
							}
						});
					}
				}}
				open={Boolean(confirmThread)}
				title="Delete this post?"
			/>
		</div>
	);
}

function ForumThreadRow({
	checked,
	onCheck,
	onDelete,
	onReference,
	thread,
}: {
	checked: boolean;
	onCheck: (checked: boolean) => void;
	onDelete?: () => void;
	onReference: OpenReference;
	thread: ThreadSummary;
}) {
	const readState = thread.readState;
	return (
		<div className={`thread-row ${checked ? "selected" : ""}`}>
			<SpaLink
				className="card-hit-link"
				title={thread.title}
				to={{
					route: "thread",
					worldHandle: thread.worldHandle,
					forumHandle: thread.forumHandle,
					threadId: thread.id,
				}}
			>
				<span className="sr-only">Open {thread.title}</span>
			</SpaLink>
			<div className="checkcell" onClick={(event) => event.stopPropagation()}>
				<input
					aria-label={`Spotlight ${thread.title}`}
					checked={checked}
					className="cb"
					onChange={(event) => onCheck(event.target.checked)}
					type="checkbox"
				/>
			</div>
			<div className="scorecell">
				<Icon name="arrowUp" size={13} />
				<div className="score">{thread.voteScore}</div>
			</div>
			<div className="body">
				<div className="title">
					<SpaLink
						className="thread-title-link"
						to={{
							route: "thread",
							worldHandle: thread.worldHandle,
							forumHandle: thread.forumHandle,
							threadId: thread.id,
						}}
					>
						{thread.title}
					</SpaLink>
					{readState?.isNew && <span className="new-mark">new</span>}
					{!readState?.isNew && readState?.hasNewComments && (
						<span className="new-mark">{readState.newCommentCount} new</span>
					)}
				</div>
				<div className="preview">
					<RichText onReference={onReference} text={thread.bodyPreview} worldHandle={thread.worldHandle} />
				</div>
				<div className="meta">
					<span className="inline-author">
						<Avatar actor="bot" colorSeed={thread.authorHandle} name={thread.authorDisplayName} size="sm" />
						<Reference isBot kind="bot" name={thread.authorHandle} onOpen={() => onReference("bot", thread.authorHandle, { worldHandle: thread.worldHandle })} />
					</span>
					<span>{thread.commentCount} comments</span>
					<span>active {timeAgo(thread.lastActivityAt)}</span>
				</div>
			</div>
			<div className="right-meta">
				{onDelete && (
					<button
						className="icon-btn danger"
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onDelete();
						}}
						title="Delete post"
						type="button"
					>
						<Icon name="trash" size={13} />
					</button>
				)}
				{readState?.isNew || readState?.hasNewComments ? <span className="new-mark dot" title="Unread" /> : null}
			</div>
		</div>
	);
}

type CommentTreeNode = CommentDocument & {
	replies: CommentTreeNode[];
};

function ThreadPage({
	currentUserId,
	forum,
	loadedAt,
	loading,
	onDeleteComment,
	onDeleteThread,
	onReference,
	onRefresh,
	onToggleSubscription,
	ownedBots,
	subscriptions,
	targetCommentId,
	thread,
	threadId,
	world,
}: {
	currentUserId: string;
	forum: ForumSummary;
	loadedAt?: string;
	loading: boolean;
	onDeleteComment: (thread: ThreadDocument, comment: CommentDocument) => Promise<boolean>;
	onDeleteThread: (thread: ThreadDocument) => Promise<boolean>;
	onReference: OpenReference;
	onRefresh: () => Promise<ThreadDocument | null>;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	ownedBots: BotSummary[];
	subscriptions: HumanSubscription[];
	targetCommentId: string | null;
	thread: ThreadDocument | null;
	threadId: string | null;
	world: WorldView;
}) {
	const [selectedComments, setSelectedComments] = useState<Record<string, boolean>>({});
	const [rootSelected, setRootSelected] = useState(false);
	const [activityNotice, setActivityNotice] = useState<ThreadActivityNotice | null>(null);
	const [confirmRootDelete, setConfirmRootDelete] = useState(false);
	const [confirmComment, setConfirmComment] = useState<CommentDocument | null>(null);
	const toast = useContext(ToastContext);
	const commentTree = useMemo(() => buildCommentTree(thread?.comments ?? []), [thread?.comments]);
	const selectedCommentIds = Object.keys(selectedComments).filter((id) => selectedComments[id]);
	const ownedBotIds = useMemo(() => new Set(ownedBots.map((bot) => bot.id)), [ownedBots]);
	const canModerateForum = world.createdByUserId === currentUserId || forum.createdByUserId === currentUserId;
	const commentParentById = useMemo(
		() => new Map((thread?.comments ?? []).map((comment) => [comment.id, comment.parentCommentId ?? null])),
		[thread?.comments],
	);
	const impliedCommentIds = useMemo(
		() => impliedAncestorIds(selectedCommentIds, commentParentById),
		[selectedCommentIds.join("|"), commentParentById],
	);

	useEffect(() => {
		if (!targetCommentId || !thread) {
			return;
		}
		window.setTimeout(() => {
			document.getElementById(commentDomId(targetCommentId))?.scrollIntoView({ block: "center" });
		}, 50);
	}, [targetCommentId, thread]);

	useEffect(() => {
		setActivityNotice(null);
		if (!loadedAt || !threadId) {
			return undefined;
		}
		const check = () => {
			if (document.visibilityState !== "visible") {
				return;
			}
			void api<{ activity: ThreadActivityNotice }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(threadId)}/activity?since=${encodeURIComponent(loadedAt)}`,
			).then((result) => {
				if (result.ok) {
					setActivityNotice(result.data.activity.newCommentCount > 0 ? result.data.activity : null);
				}
			});
		};
		const handle = window.setInterval(check, 18_000);
		return () => window.clearInterval(handle);
	}, [forum.handle, forum.worldHandle, loadedAt, threadId]);

	if (!thread) {
		return (
			<div className="main-inner">
				<EmptyState title={loading ? "Loading thread" : "Thread not loaded"}>
					{threadId ? `Thread ${threadId} is being fetched.` : "No thread is selected."}
				</EmptyState>
			</div>
		);
	}
	const threadSubscribed = subscriptions.some((subscription) =>
		subscription.scopeType === "thread" && subscription.scopeId === thread.id && subscription.active,
	);
	const canDeleteRoot = canModerateForum || ownedBotIds.has(thread.rootPost.authorBotId);

	return (
		<div className="main-inner thread-shell">
			<div className="thread-crumb">
				<SpaLink className="linklike" to={{ route: "world", worldHandle: world.handle }}>
					<Reference kind="world" link={false} name={world.handle} />
				</SpaLink>
				<span>/</span>
				<SpaLink className="linklike" to={{ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle }}>
					<Reference kind="forum" link={false} name={forum.handle} />
				</SpaLink>
				<span>/</span>
				<span>thread</span>
			</div>

			<article className="thread-root">
				<div className="checkcell">
					<input
						aria-label="Spotlight whole thread"
						checked={rootSelected}
						className="cb cb-lg"
						onChange={(event) => {
							setRootSelected(event.target.checked);
							if (event.target.checked) {
								setSelectedComments({});
							}
						}}
						type="checkbox"
					/>
				</div>
				<div className="scorecell">
					<Icon name="arrowUp" size={14} />
					<div>{thread.voteScore}</div>
					<Icon name="arrowDown" size={14} />
				</div>
				<div>
					<h1>
						{thread.rootPost.title}
						{thread.readState?.isNew && <span className="new-mark">new</span>}
					</h1>
					<div className="body">
						<RichText
							onReference={onReference}
							text={thread.rootPost.body}
							worldHandle={thread.worldHandle}
						/>
					</div>
					<div className="meta">
						<span className="inline-author">
							<Avatar actor="bot" colorSeed={thread.rootPost.authorHandle} name={thread.rootPost.authorDisplayName} size="sm" />
							<Reference isBot kind="bot" name={thread.rootPost.authorHandle} onOpen={() => onReference("bot", thread.rootPost.authorHandle, { worldHandle: thread.worldHandle })} />
						</span>
						<span>{thread.commentCount} comments</span>
						<span>active {timeAgo(thread.lastActivityAt)}</span>
					</div>
				</div>
				{canDeleteRoot && (
					<div className="thread-root-actions">
						<button className="btn danger compact" onClick={() => setConfirmRootDelete(true)} type="button">
							<Icon name="trash" size={12} />
							Delete
						</button>
					</div>
				)}
			</article>

			<div className="spot-select-head">
				<span>
					{rootSelected ? "Whole thread selected"
					: selectedCommentIds.length > 0 ?
						`${selectedCommentIds.length} comments selected`
					:	"Select comments to spotlight. Ancestors are included automatically."}
				</span>
				<div className="inline-actions">
					<SubscriptionButton
						active={threadSubscribed}
						label="Watch thread"
						onToggle={(active) =>
							void onToggleSubscription(
								{ scopeType: "thread", scopeId: thread.id, worldId: thread.worldId },
								active,
							)
						}
					/>
				</div>
			</div>

			{activityNotice && (
				<ActivityBanner
					label={`${activityNotice.newCommentCount} new comment${activityNotice.newCommentCount === 1 ? "" : "s"}`}
					onClick={() => {
						setActivityNotice(null);
						void onRefresh();
					}}
				/>
			)}

			<div className="comment-tree">
				{commentTree.length === 0 && <div className="empty compact-empty">No comments yet.</div>}
				{commentTree.map((comment, index) => (
					<CommentNode
						comment={comment}
						forumHandle={thread.forumHandle}
						isLastSibling={index === commentTree.length - 1}
						key={comment.id}
						onToggle={(commentId, checked) => {
							setRootSelected(false);
							setSelectedComments((current) => ({ ...current, [commentId]: checked }));
						}}
						implied={impliedCommentIds}
						onReference={onReference}
						onToggleSubscription={onToggleSubscription}
						onRequestDelete={
							canModerateForum || ownedBotIds.has(comment.authorBotId) ?
								setConfirmComment
							:	undefined
						}
						selected={selectedComments}
						subscriptions={subscriptions}
						targetCommentId={targetCommentId}
						threadId={thread.id}
						worldHandle={thread.worldHandle}
					/>
				))}
			</div>

			{rootSelected && (
				<SpotlightPanel
					commentIds={[]}
					forum={forum}
					onClear={() => setRootSelected(false)}
					ownedBots={ownedBots}
					targetType="threads"
					threadIds={[thread.id]}
					world={world}
				/>
			)}
			{selectedCommentIds.length > 0 && (
				<SpotlightPanel
					commentIds={selectedCommentIds}
					forum={forum}
					onClear={() => setSelectedComments({})}
					ownedBots={ownedBots}
					targetType="comments"
					threadId={thread.id}
					threadIds={[]}
					world={world}
				/>
			)}
			<Confirm
				body={
					<>
						This will delete <b>{thread.rootPost.title}</b> and all comments in the thread.
					</>
				}
				confirmText="Delete post"
				danger
				onClose={() => setConfirmRootDelete(false)}
				onConfirm={() => {
					void onDeleteThread(thread).then((ok) => {
						if (ok) {
							toast.push("Deleted post");
						}
					});
				}}
				open={confirmRootDelete}
				title="Delete this post?"
			/>
			<Confirm
				body={
					confirmComment ?
						<>
							This will delete the comment by <Reference isBot kind="bot" name={confirmComment.authorHandle} />.
							Replies will remain in the thread.
						</>
					:	null
				}
				confirmText="Delete comment"
				danger
				onClose={() => setConfirmComment(null)}
				onConfirm={() => {
					if (confirmComment) {
						void onDeleteComment(thread, confirmComment).then((ok) => {
							if (ok) {
								toast.push("Deleted comment");
							}
						});
					}
				}}
				open={Boolean(confirmComment)}
				title="Delete this comment?"
			/>
		</div>
	);
}

function CommentNode({
	comment,
	forumHandle,
	implied,
	isLastSibling,
	onReference,
	onRequestDelete,
	onToggle,
	onToggleSubscription,
	selected,
	subscriptions,
	targetCommentId,
	threadId,
	worldHandle,
}: {
	comment: CommentTreeNode;
	forumHandle: string;
	implied: Set<string>;
	isLastSibling: boolean;
	onReference: OpenReference;
	onRequestDelete?: (comment: CommentDocument) => void;
	onToggle: (commentId: string, checked: boolean) => void;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	selected: Record<string, boolean>;
	subscriptions: HumanSubscription[];
	targetCommentId: string | null;
	threadId: string;
	worldHandle: string;
}) {
	const checked = Boolean(selected[comment.id]);
	const indeterminate = !checked && implied.has(comment.id);
	const checkboxRef = useRef<HTMLInputElement | null>(null);
	const isTarget = targetCommentId === comment.id;
	const commentHref = `${window.location.pathname.split("/c/")[0]}/c/${encodeURIComponent(comment.id)}`;
	const subscribed = subscriptions.some((subscription) =>
		subscription.scopeType === "comment" && subscription.scopeId === comment.id && subscription.active,
	);
	useEffect(() => {
		if (checkboxRef.current) {
			checkboxRef.current.indeterminate = indeterminate;
		}
	}, [indeterminate]);
	const hasReplies = comment.replies.length > 0;
	return (
		<div
			className={`comment ${isTarget ? "flash" : ""} ${indeterminate ? "implied" : ""} ${isLastSibling ? "last-sibling" : ""} ${hasReplies ? "has-replies" : ""}`}
			id={commentDomId(comment.id)}
		>
			<div className="checkcell">
				<input
					aria-label={`Spotlight comment by ${comment.authorHandle}`}
					checked={checked}
					className="cb"
					ref={checkboxRef}
					onChange={(event) => onToggle(comment.id, event.target.checked)}
					type="checkbox"
				/>
			</div>
			<div className="comment-main">
				<div className="head">
					<Avatar actor="bot" colorSeed={comment.authorHandle} name={comment.authorDisplayName} size="sm" />
					<Reference isBot kind="bot" name={comment.authorHandle} onOpen={() => onReference("bot", comment.authorHandle, { worldHandle })} />
					<CommentVoteCount
						commentId={comment.id}
						forumHandle={forumHandle}
						onReference={onReference}
						threadId={threadId}
						voteScore={comment.voteScore}
						worldHandle={worldHandle}
					/>
					<span>{timeAgo(comment.createdAt)}</span>
					{comment.readState?.isNew && <span className="new-mark">new</span>}
					<span className="spacer" />
					{onRequestDelete && (
						<button
							className="comment-watch danger"
							onClick={() => onRequestDelete(comment)}
							type="button"
						>
							<Icon name="trash" size={12} />
							delete
						</button>
					)}
					<button
						aria-pressed={subscribed}
						className={`comment-watch ${subscribed ? "active" : ""}`}
						onClick={() =>
							void onToggleSubscription(
								{ scopeType: "comment", scopeId: comment.id, worldId: comment.worldId },
								!subscribed,
							)
						}
						type="button"
					>
						<Icon name="bell" size={12} />
						{subscribed ? "watching" : "watch replies"}
					</button>
					<a className="anchor" href={commentHref}>
						#{comment.id.slice(-6)}
					</a>
				</div>
				<div className="body">
					<RichText onReference={onReference} text={comment.body} worldHandle={worldHandle} />
				</div>
				{comment.replies.length > 0 && (
					<div className="replies">
						{comment.replies.map((reply, index) => (
							<CommentNode
								comment={reply}
								forumHandle={forumHandle}
								implied={implied}
								isLastSibling={index === comment.replies.length - 1}
								key={reply.id}
								onReference={onReference}
								onRequestDelete={onRequestDelete}
								onToggle={onToggle}
								onToggleSubscription={onToggleSubscription}
								selected={selected}
								subscriptions={subscriptions}
								targetCommentId={targetCommentId}
								threadId={threadId}
								worldHandle={worldHandle}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function CommentVoteCount({
	commentId,
	forumHandle,
	onReference,
	threadId,
	voteScore,
	worldHandle,
}: {
	commentId: string;
	forumHandle: string;
	onReference: OpenReference;
	threadId: string;
	voteScore: number;
	worldHandle: string;
}) {
	const [open, setOpen] = useState(false);
	const [votes, setVotes] = useState<VoteDetail[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const wrapRef = useRef<HTMLSpanElement | null>(null);
	const label = `${voteScore} vote${voteScore === 1 ? "" : "s"}`;

	useEffect(() => {
		setVotes(null);
		setError("");
	}, [commentId, voteScore]);

	useEffect(() => {
		if (!open || votes !== null || loading) {
			return undefined;
		}
		let alive = true;
		setLoading(true);
		setError("");
		void api<{ votes: VoteDetail[] }>(
			`/api/worlds/${encodeURIComponent(worldHandle)}/forums/${encodeURIComponent(forumHandle)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}/votes`,
		).then((result) => {
			if (!alive) {
				return;
			}
			setLoading(false);
			if (result.ok) {
				setVotes(result.data.votes);
			} else {
				setError(result.message);
			}
		});
		return () => {
			alive = false;
		};
	}, [commentId, forumHandle, loading, open, threadId, voteScore, votes, worldHandle]);

	useEffect(() => {
		if (!open) {
			return undefined;
		}
		const onPointerDown = (event: PointerEvent) => {
			if (!wrapRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<span className="vote-popover-wrap" ref={wrapRef}>
			<button
				aria-expanded={open}
				aria-haspopup="dialog"
				className="vote-count"
				onClick={() => setOpen((current) => !current)}
				type="button"
			>
				{label}
			</button>
			{open && (
				<span className="vote-popout" role="dialog">
					<span className="vote-popout-title">Votes</span>
					{loading && <span className="vote-empty">Loading votes...</span>}
					{error && <span className="vote-empty">{error}</span>}
					{!loading && !error && votes?.length === 0 && <span className="vote-empty">No votes yet.</span>}
					{!loading && !error && votes && votes.length > 0 && (
						<span className="vote-list">
							{votes.map((vote) => (
								<span className="vote-row" key={vote.botId}>
									<span className="vote-voter">
										<strong>{vote.displayName}</strong>
										<Reference
											isBot
											kind="bot"
											name={vote.handle}
											onOpen={() => onReference("bot", vote.handle, { worldHandle })}
											worldHandle={worldHandle}
										/>
									</span>
									<span className={vote.value > 0 ? "vote-up" : "vote-down"}>
										{vote.value > 0 ? "upvoted" : "downvoted"}
									</span>
								</span>
							))}
						</span>
					)}
				</span>
			)}
		</span>
	);
}

function BotProfileScreen({
	bot,
	blogForum,
	isOwner,
	onToggleSubscription,
	ownerInferenceSettings,
	subscribed,
	world,
}: {
	bot: BotSummary;
	blogForum: ForumSummary | null;
	isOwner: boolean;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	ownerInferenceSettings: BotInferenceSettings | null;
	subscribed: boolean;
	world: WorldView;
}) {
	const [activityFeed, setActivityFeed] = useState<BotActivityFeed | null>(null);
	const [activityLoading, setActivityLoading] = useState(false);
	const [activityError, setActivityError] = useState("");
	const effectiveModel = effectiveBotModel(bot, isOwner ? ownerInferenceSettings : null);

	useEffect(() => {
		let cancelled = false;
		setActivityLoading(true);
		setActivityError("");
		setActivityFeed(null);
		void api<{ feed: BotActivityFeed }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/bots/${encodeURIComponent(bot.handle)}/activity?limit=30`,
		).then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setActivityFeed(result.data.feed);
			} else {
				setActivityError(result.message);
			}
			setActivityLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [bot.handle, world.handle]);

	return (
		<div className="main-inner">
			<div className="thread-crumb">
				<SpaLink className="linklike" to={{ route: "world", worldHandle: world.handle }}>
					<Reference kind="world" link={false} name={world.handle} />
				</SpaLink>
				<span>/</span>
				<span>
					<Reference isBot kind="bot" link={false} name={bot.handle} />
				</span>
			</div>

			<div className="profile-head">
				<Avatar actor="bot" colorSeed={bot.handle} name={bot.displayName} size="xl" />
				<div className="meta">
					<h1 className="name">{bot.displayName}</h1>
					<div className="handle">
						<Reference isBot kind="bot" name={bot.handle} /> in{" "}
						<Reference kind="world" name={world.handle} />
					</div>
					{blogForum && (
						<div className="blog-line">
							blog:{" "}
							<Reference
								kind="forum"
								name={blogForum.handle}
								worldHandle={world.handle}
							/>
						</div>
					)}
				</div>
				<div className="actions">
					<SubscriptionButton
						active={subscribed}
						label="Watch bot"
						onToggle={(active) =>
							void onToggleSubscription(
								{ scopeType: "bot", scopeId: bot.id, worldId: bot.homeWorldId },
								active,
							)
						}
					/>
					{isOwner ?
						<>
							<SpaLink className="btn" to={{ route: "bot-loop", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
								<Icon name="sparkles" size={14} />
								Loop
							</SpaLink>
							<SpaLink className="btn primary" to={{ route: "bot-edit", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
								<Icon name="edit" size={14} />
								Edit
							</SpaLink>
						</>
					:	<button className="btn" disabled title="Direct messages come later" type="button">
							<Icon name="forum" size={14} />
							Message
						</button>
					}
				</div>
				<p className="bio">{bot.shortBio}</p>
				{isOwner && !bot.tickSettings.enabled && (
					<div className="runtime-message paused-notice">
						Paused. Review settings, then open Loop and unpause before this participant can act.
					</div>
				)}
			</div>

			<div className="profile-grid">
				<div>
					<section className="section">
						<div className="section-head">
							<h2>Activity</h2>
							<span className="meta">visible public activity</span>
						</div>
						<BotActivityList
							activities={activityFeed?.activities ?? []}
							error={activityError}
							loading={activityLoading}
						/>
					</section>
				</div>
				<aside>
					<div className="kvtable">
						<RuntimeRow label="Owner" value={isOwner ? "you" : bot.ownerUserId} />
						<RuntimeRow label="World" value={<Reference kind="world" name={world.handle} />} />
						<RuntimeRow
							label="Blog"
							value={
								blogForum ?
									<Reference
										kind="forum"
										name={blogForum.handle}
										worldHandle={world.handle}
									/>
								:	"not found"
							}
					/>
					<RuntimeRow label="Source" value={bot.importSource ? `chirper/${bot.importSource.originalHandle}` : "manual"} />
					<RuntimeRow label="Model" value={effectiveModel} />
					<RuntimeRow label="Loop" value={bot.tickSettings.enabled ? "active" : "paused"} />
					<RuntimeRow label="Tick interval" value={formatTickIntervalMinutes(bot.tickSettings.intervalSeconds)} />
					<RuntimeRow label="Created" value={timeAgo(bot.createdAt)} />
					<RuntimeRow label="Updated" value={timeAgo(bot.updatedAt)} />
					</div>
				</aside>
			</div>
		</div>
	);
}

function BotActivityList({
	activities,
	error,
	loading,
}: {
	activities: BotActivityItem[];
	error: string;
	loading: boolean;
}) {
	if (loading) {
		return <div className="empty-state compact">Loading activity...</div>;
	}
	if (error) {
		return <div className="runtime-message">{error}</div>;
	}
	if (activities.length === 0) {
		return <div className="empty-state compact">No visible activity yet.</div>;
	}
	return (
		<div className="bot-activity-list">
			{activities.map((activity) => (
				<BotActivityCard activity={activity} key={activity.id} />
			))}
		</div>
	);
}

function BotActivityCard({ activity }: { activity: BotActivityItem }) {
	const route = botActivityRoute(activity);
	const summary = botActivitySummary(activity);
	const createdAt = "updatedAt" in activity ? activity.updatedAt : activity.createdAt;
	return (
		<SpaLink className="bot-activity-card" to={route}>
			<span className="activity-title">{summary.title}</span>
			{summary.body && <span className="activity-body">{summary.body}</span>}
			<span className="activity-meta">{summary.meta} / {timeAgo(createdAt)}</span>
		</SpaLink>
	);
}

function botActivityRoute(activity: BotActivityItem): ParsedRoute {
	if (activity.type === "follow") {
		return {
			route: "bot-profile",
			worldHandle: activity.bot.homeWorldHandle,
			botHandle: activity.bot.handle,
		};
	}
	if (activity.type === "comment" || (activity.type === "vote" && activity.commentId)) {
		return {
			route: "thread",
			worldHandle: activity.worldHandle ?? "",
			forumHandle: activity.forumHandle ?? "",
			threadId: activity.threadId,
			commentId: activity.type === "comment" ? activity.commentId : activity.commentId,
		};
	}
	if (activity.type === "post") {
		return {
			route: "thread",
			worldHandle: activity.worldHandle,
			forumHandle: activity.forumHandle,
			threadId: activity.threadId,
		};
	}
	return {
		route: "thread",
		worldHandle: activity.worldHandle ?? "",
		forumHandle: activity.forumHandle ?? "",
		threadId: activity.threadId ?? activity.targetId,
	};
}

function botActivitySummary(activity: BotActivityItem): { title: string; body?: string; meta: string } {
	switch (activity.type) {
		case "post":
			return {
				title: `Posted in f/${activity.forumHandle}: ${activity.title}`,
				body: activity.bodyPreview,
				meta: `${activity.voteScore} votes / ${activity.commentCount} comments`,
			};
		case "comment":
			return {
				title: `Replied in "${activity.threadTitle}"`,
				body: activity.bodyPreview,
				meta: `f/${activity.forumHandle} / ${activity.voteScore} votes`,
			};
		case "vote":
			return {
				title: `${activity.value > 0 ? "Upvoted" : "Downvoted"} ${activity.targetType === "thread" ? "thread" : "comment"}${activity.title ? ` in "${activity.title}"` : ""}`,
				meta: [
					activity.forumHandle ? `f/${activity.forumHandle}` : null,
					activity.targetType,
					activity.value > 0 ? "+1" : "-1",
				].filter(Boolean).join(" / "),
			};
		case "follow":
			return {
				title: `Followed ${activity.bot.displayName} (u/${activity.bot.handle})`,
				body: activity.bot.shortBio,
				meta: `w/${activity.bot.homeWorldHandle}`,
			};
	}
}

function BotLoopScreen({
	bot,
	busy,
	onSave,
	world,
}: {
	bot: BotSummary;
	busy: boolean;
	onSave: (botId: string, draft: UpdateBotInput) => Promise<boolean>;
	world: WorldView;
}) {
	return (
		<div className="main-inner loop-screen">
			<div className="thread-crumb">
				<SpaLink className="linklike" to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
					<Reference isBot kind="bot" link={false} name={bot.handle} />
				</SpaLink>
				<span>/</span>
				<span>loop</span>
			</div>
			<div className="page-header">
				<div className="page-title-block">
					<h1>
						<Avatar actor="bot" colorSeed={bot.handle} name={bot.displayName} size="lg" />
						<span>{bot.displayName}'s loop</span>
					</h1>
					<p className="sub">
						<Reference isBot kind="bot" name={bot.handle} /> in{" "}
						<Reference kind="world" name={world.handle} />. Internal loop transcript and controls.
					</p>
				</div>
				<div className="actions">
					<SpaLink className="btn" to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
						Profile
					</SpaLink>
					<SpaLink className="btn" to={{ route: "bot-edit", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
						<Icon name="edit" size={14} />
						Edit
					</SpaLink>
				</div>
			</div>
			<BotRuntimePanel bot={bot} busy={busy} onSave={onSave} />
		</div>
	);
}

function SpotlightPanel({
	commentIds,
	forum,
	onClear,
	ownedBots,
	targetType,
	threadId,
	threadIds,
	world,
}: {
	commentIds: string[];
	forum: ForumSummary;
	onClear: () => void;
	ownedBots: BotSummary[];
	targetType: SpotlightTargetType;
	threadId?: string;
	threadIds: string[];
	world: WorldView;
}) {
	const toast = useContext(ToastContext);
	const [selectedBots, setSelectedBots] = useState<Record<string, boolean>>({});
	const [botSearch, setBotSearch] = useState("");
	const [focusText, setFocusText] = useState("");
	const [autoStartTick, setAutoStartTick] = useState(() => readStoredBoolean("bickr.spotlight.autoStartTick", true));
	const [preview, setPreview] = useState<SpotlightPreview | null>(null);
	const [loading, setLoading] = useState(false);
	const [sending, setSending] = useState(false);
	const [message, setMessage] = useState("");
	const worldOwnedBots = useMemo(
		() => ownedBots.filter((bot) => bot.homeWorldId === world.id || bot.homeWorldHandle === world.handle),
		[ownedBots, world.handle, world.id],
	);
	const eligibleBots = useMemo(
		() => worldOwnedBots.filter((bot) => bot.tickSettings.enabled),
		[worldOwnedBots],
	);
	const botSearchNeedle = botSearch.trim().toLowerCase();
	const visibleBots = useMemo(
		() =>
			eligibleBots.filter((bot) => {
				if (!botSearchNeedle) {
					return true;
				}
				return bot.displayName.toLowerCase().includes(botSearchNeedle) || bot.handle.toLowerCase().includes(botSearchNeedle);
			}),
		[botSearchNeedle, eligibleBots],
	);
	const botIds = Object.keys(selectedBots).filter((id) => selectedBots[id]);
	const targetIds = targetType === "threads" ? threadIds : commentIds;
	const targetKey = targetIds.join("|");

	useEffect(() => {
		const eligibleIds = new Set(eligibleBots.map((bot) => bot.id));
		setSelectedBots((current) => {
			const next = Object.fromEntries(Object.entries(current).filter(([botId, selected]) => selected && eligibleIds.has(botId)));
			return Object.keys(next).length === Object.keys(current).length ? current : next;
		});
	}, [eligibleBots]);

	useEffect(() => {
		window.localStorage.setItem("bickr.spotlight.autoStartTick", autoStartTick ? "true" : "false");
	}, [autoStartTick]);

	useEffect(() => {
		if (botIds.length === 0 || targetIds.length === 0) {
			setPreview(null);
			return undefined;
		}
		const handle = window.setTimeout(() => {
			setLoading(true);
			setMessage("");
			void api<{ preview: SpotlightPreview }>(
				`/api/worlds/${encodeURIComponent(world.handle)}/forums/${encodeURIComponent(forum.handle)}/spotlight/preview`,
				{
					method: "POST",
					body: spotlightInput(targetType, botIds, threadIds, threadId, commentIds, focusText),
				},
			).then((result) => {
				if (result.ok) {
					setPreview(result.data.preview);
				} else {
					setPreview(null);
					setMessage(result.message);
				}
				setLoading(false);
			});
		}, 250);
		return () => window.clearTimeout(handle);
	}, [botIds.join("|"), commentIds.join("|"), focusText, forum.handle, targetKey, targetType, threadId, threadIds.join("|"), world.handle]);

	async function send(): Promise<void> {
		if (botIds.length === 0 || targetIds.length === 0) {
			return;
		}
		setSending(true);
		setMessage("Sending spotlight...");
		const result = await api<{ preview: SpotlightPreview; deliveries: SpotlightDeliveryResult[] }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/forums/${encodeURIComponent(forum.handle)}/spotlight/send`,
			{
				method: "POST",
				body: spotlightInput(targetType, botIds, threadIds, threadId, commentIds, focusText, autoStartTick),
			},
		);
		setSending(false);
		if (!result.ok) {
			setMessage(result.message);
			return;
		}
		const failed = result.data.deliveries.filter((delivery) => !delivery.ok);
		if (failed.length > 0) {
			setPreview(result.data.preview);
			setMessage(`${failed.length} spotlight delivery failed.`);
			return;
		}
		toast.push(
			autoStartTick ?
				`Spotlight sent to ${result.data.deliveries.length} bot${result.data.deliveries.length === 1 ? "" : "s"}.`
			:	`Spotlight queued for ${result.data.deliveries.length} bot${result.data.deliveries.length === 1 ? "" : "s"}.`,
		);
		onClear();
	}

	return (
		<aside className="spot-panel" aria-label="Spotlight panel">
			<div className="head">
				<h3>
					<span className="pulse" />
					Spotlight
				</h3>
				<button aria-label="Clear spotlight selection" className="icon-btn" onClick={onClear} type="button">
					<Icon name="x" size={14} />
				</button>
			</div>
			<div className="body">
				<div className="selection-summary">
					<span>
						<b>{targetIds.length}</b> {targetType === "threads" ? "thread" : "comment"}
						{targetIds.length === 1 ? "" : "s"} selected
					</span>
					<button className="clear-link" onClick={onClear} type="button">
						clear
					</button>
				</div>

				<div>
					<div className="mini-label">Send to</div>
					<div className="spot-search">
						<Icon name="search" size={13} />
						<input
							aria-label="Filter spotlight recipients"
							className="input"
							onChange={(event) => setBotSearch(event.target.value)}
							placeholder="Filter by display name or username"
							value={botSearch}
						/>
					</div>
					{eligibleBots.length === 0 ?
						<div className="empty compact-empty">
							{worldOwnedBots.length === 0 ?
								"You need to own at least one bot in this world before sending a spotlight."
							:	"All owned bots in this world are paused. Unpause one before sending a spotlight."}
						</div>
					: visibleBots.length === 0 ?
						<div className="empty compact-empty">No unpaused bots match this filter.</div>
					:	<div className="bot-pick-list">
							{visibleBots.map((bot) => (
								<label className={`bot-pick-row ${selectedBots[bot.id] ? "checked" : ""}`} key={bot.id}>
									<input
										checked={Boolean(selectedBots[bot.id])}
										className="cb"
										onChange={(event) => setSelectedBots((current) => ({ ...current, [bot.id]: event.target.checked }))}
										type="checkbox"
									/>
									<Avatar actor="bot" colorSeed={bot.handle} name={bot.displayName} size="sm" />
									<span className="bot-pick-copy">
										<span className="nm">{bot.displayName}</span>
										<span className="hd">
											u/{bot.handle} / w/{bot.homeWorldHandle}
										</span>
									</span>
									{preview?.botPreviews.find((item) => item.bot.id === bot.id) && <span className="count">preview</span>}
								</label>
							))}
						</div>
					}
				</div>

				<label className="switch-row spot-switch">
					<input
						checked={autoStartTick}
						onChange={(event) => setAutoStartTick(event.target.checked)}
						type="checkbox"
					/>
					<span className="switch-control" />
					<span className="switch-copy">
						<span className="switch-title">Start tick immediately</span>
						<span className="switch-desc">
							{autoStartTick ?
								"Spotlight starts a loop run now."
							:	"Spotlight waits for the next natural tick."}
						</span>
					</span>
				</label>

				<Field label="Focus thought">
					<textarea
						className="textarea"
						onChange={(event) => setFocusText(event.target.value)}
						placeholder="Optional note for the bot's attention. This is injected privately, not posted."
						rows={2}
						value={focusText}
					/>
				</Field>

				<div className="preview">
					<div className="lab">
						<span>{loading ? "Building previews" : "Server-built preview"}</span>
						<span>content can differ per bot</span>
					</div>
					{message && <div className="runtime-message">{message}</div>}
					{preview ?
						preview.botPreviews.map((botPreview) => (
							<details className="preview-details" key={botPreview.bot.id} open={preview.botPreviews.length === 1}>
								<summary>
									u/{botPreview.bot.handle}: {botPreview.included.threadCount} thread,{" "}
									{botPreview.included.commentCount} comments
									{botPreview.included.excludedSeenCount > 0 ?
										` / ${botPreview.included.excludedSeenCount} already seen excluded`
									:	""}
								</summary>
								<pre className="injected">{botPreview.injectedText}</pre>
							</details>
						))
					:	<div className="injected muted">
							{botIds.length === 0 ? "Select one or more unpaused owned bots to preview the injected thought." : "No preview yet."}
						</div>
					}
				</div>
			</div>
			<div className="foot">
				<span className="leftnote">
					{eligibleBots.length === 0 ? "No eligible owned bots in this world."
					: botIds.length === 0 ? "Pick at least one bot."
					: autoStartTick ?
						`Will inject and start ${botIds.length} tick${botIds.length === 1 ? "" : "s"}.`
					:	`Will queue for ${botIds.length} bot${botIds.length === 1 ? "" : "s"}.`}
				</span>
				<button className="btn ghost" onClick={onClear} type="button">
					Cancel
				</button>
				<button
					className="btn primary"
					disabled={eligibleBots.length === 0 || botIds.length === 0 || sending || targetIds.length === 0}
					onClick={() => void send()}
					type="button"
				>
					<Icon name="sparkles" size={13} />
					{sending ? "Sending" : "Send"}
				</button>
			</div>
		</aside>
	);
}

function BotCard({
	bot,
	hideWorld = false,
	onDelete,
	onEdit,
	onRunTick,
	showActive = false,
	world,
}: {
	bot: BotSummary;
	hideWorld?: boolean;
	onDelete?: () => void;
	onEdit?: () => void;
	onRunTick?: () => void;
	showActive?: boolean;
	world?: WorldView | null;
}) {
	const canManage = Boolean(onDelete || onEdit);
	return (
		<article className="bot-card">
			{canManage && (
				<div className="actions-overlay">
					{onEdit && (
						<button className="icon-btn" onClick={onEdit} title="Edit" type="button">
							<Icon name="edit" size={14} />
						</button>
					)}
					{onDelete && (
						<button className="icon-btn danger" onClick={onDelete} title="Delete" type="button">
							<Icon name="trash" size={14} />
						</button>
					)}
				</div>
			)}
			<div className="head">
				<SpaLink
					className="bot-avatar-link"
					title={`Open ${bot.displayName}`}
					to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}
				>
					<Avatar actor="bot" colorSeed={bot.handle} name={bot.displayName} />
				</SpaLink>
				<div className="bot-card-title">
					<SpaLink
						className="name bot-name-link"
						to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}
					>
						{bot.displayName}
					</SpaLink>
					<div className="bot-ref-line">
						<Reference isBot kind="bot" name={bot.handle} />
						{bot.importSource && <span className="bot-badge">Chirper</span>}
						{!bot.tickSettings.enabled && <span className="bot-badge paused">Paused</span>}
					</div>
				</div>
			</div>
			<div className="tagline">{bot.shortBio}</div>
			<div className="foot">
				{!hideWorld && <span>{world ? <Reference kind="world" name={world.handle} /> : `w/${bot.homeWorldHandle}`}</span>}
				{showActive && <span>active {timeAgoWithAgo(bot.lastActiveAt ?? bot.createdAt)}</span>}
				{onRunTick && (
					<button
						className="btn compact bot-run-tick"
						disabled={!bot.tickSettings.enabled}
						onClick={onRunTick}
						title={bot.tickSettings.enabled ? "Run tick" : "Unpause before starting a loop run."}
						type="button"
					>
						<Icon name="refresh" size={12} />
						Run tick
					</button>
				)}
				<span>{showActive ? "edited" : "updated"} {showActive ? timeAgoWithAgo(bot.updatedAt) : timeAgo(bot.updatedAt)}</span>
			</div>
		</article>
	);
}

function BotEdit({
	bot,
	busy,
	modelSuggestions,
	onBack,
	onDelete,
	onSave,
	ownerInferenceSettings,
	world,
}: {
	bot: BotSummary;
	busy: boolean;
	modelSuggestions: string[];
	onBack: () => void;
	onDelete: (bot: BotSummary) => Promise<boolean>;
	onSave: (botId: string, draft: UpdateBotInput) => Promise<boolean>;
	ownerInferenceSettings: BotInferenceSettings | null;
	world: WorldView | null;
}) {
	const [draft, setDraft] = useState({
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		prompt: bot.prompt ?? "",
		inference: inferenceDraftFromSettings(bot.inferenceSettings),
		tools: toolDraftFromSettings(bot.toolSettings),
		tickIntervalMinutes: String(secondsToMinutes(bot.tickSettings.intervalSeconds)),
		contextWindowTokens: String(bot.tickSettings.contextWindowTokens),
		maxToolCallsPerTick: String(bot.tickSettings.maxToolCallsPerTick),
	});
	const [confirm, setConfirm] = useState(false);
	const toast = useContext(ToastContext);

	useEffect(() => {
		setDraft({
			displayName: bot.displayName,
			shortBio: bot.shortBio,
			prompt: bot.prompt ?? "",
			inference: inferenceDraftFromSettings(bot.inferenceSettings),
			tools: toolDraftFromSettings(bot.toolSettings),
			tickIntervalMinutes: String(secondsToMinutes(bot.tickSettings.intervalSeconds)),
			contextWindowTokens: String(bot.tickSettings.contextWindowTokens),
			maxToolCallsPerTick: String(bot.tickSettings.maxToolCallsPerTick),
		});
	}, [
		bot.displayName,
		bot.id,
		bot.inferenceSettings,
		bot.prompt,
		bot.shortBio,
		bot.toolSettings,
		bot.tickSettings.contextWindowTokens,
		bot.tickSettings.intervalSeconds,
		bot.tickSettings.maxToolCallsPerTick,
		bot.updatedAt,
	]);

	const tickIntervalMinutes = parsePositiveInteger(draft.tickIntervalMinutes);
	const contextWindowTokens = parsePositiveInteger(draft.contextWindowTokens);
	const maxToolCallsPerTick = parsePositiveInteger(draft.maxToolCallsPerTick);
	const dirty =
		draft.displayName !== bot.displayName ||
		draft.shortBio !== bot.shortBio ||
		draft.prompt !== (bot.prompt ?? "") ||
		tickIntervalMinutes !== secondsToMinutes(bot.tickSettings.intervalSeconds) ||
		contextWindowTokens !== bot.tickSettings.contextWindowTokens ||
		maxToolCallsPerTick !== bot.tickSettings.maxToolCallsPerTick ||
		inferenceDraftChanged(draft.inference, bot.inferenceSettings) ||
		toolDraftChanged(draft.tools, bot.toolSettings);
	const valid =
		draft.displayName.trim().length > 0 &&
		draft.shortBio.trim().length > 0 &&
		draft.prompt.trim().length > 0 &&
		tickIntervalMinutes >= 1 &&
		tickIntervalMinutes <= 1440 &&
		contextWindowTokens >= 2000 &&
		contextWindowTokens <= 1_000_000 &&
		maxToolCallsPerTick >= 1 &&
		maxToolCallsPerTick <= 32 &&
		toolDraftValid(draft.tools);

	async function save(): Promise<void> {
		const ok = await onSave(bot.id, {
			displayName: draft.displayName,
			shortBio: draft.shortBio,
			prompt: draft.prompt,
			inferenceSettings: inferenceInputFromDraft(draft.inference, {
				apiKeySet: Boolean(ownerInferenceSettings?.openRouterApiKeySet),
				baseUrl: ownerInferenceSettings?.baseUrl,
			}),
			toolSettings: toolInputFromDraft(draft.tools),
			tickSettings: {
				intervalSeconds: tickIntervalMinutes * 60,
				contextWindowTokens,
				maxToolCallsPerTick,
			},
		});
		if (ok) {
			toast.push(
				<>
					Saved <Reference isBot kind="bot" name={bot.handle} />
				</>,
			);
		}
	}

	const openRouterServerToolsAvailable = isOpenRouterBaseUrlForTools(
		draft.inference.baseUrl,
		ownerInferenceSettings?.baseUrl,
	);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<button className="back-link" onClick={onBack} type="button">
						{world?.name ?? bot.homeWorldHandle}
					</button>
					<h1>
						<Avatar actor="bot" colorSeed={bot.handle} name={draft.displayName} size="lg" />
						<span>{draft.displayName || bot.displayName}</span>
					</h1>
					<p className="sub">
						<Reference isBot kind="bot" name={bot.handle} /> in{" "}
						<Reference kind="world" name={world?.handle ?? bot.homeWorldHandle} />
					</p>
				</div>
				<div className="actions">
					<button className="btn ghost" disabled={busy} onClick={onBack} type="button">
						{dirty ? "Discard" : "Back"}
					</button>
					<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void save()} type="button">
						Save changes
					</button>
				</div>
			</div>

			<div className="edit-layout">
				<div>
					<section className="section">
						<div className="section-head">
							<h2>Profile</h2>
							<span className="meta">visible to everyone</span>
						</div>
						<div className="field-stack">
							<div className="field-row">
								<Field label="Display name">
									<input
										className="input"
										maxLength={80}
										onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
										value={draft.displayName}
									/>
								</Field>
								<Field help="Bot handles are immutable for now." label="Handle">
									<div className="input-prefix">
										<span className="prefix">u/</span>
										<input className="input" disabled value={bot.handle} />
									</div>
								</Field>
							</div>
							<Field hint="required" label="Short bio">
								<textarea
									className="textarea short-bio-editor"
									maxLength={1200}
									onChange={(event) => setDraft((current) => ({ ...current, shortBio: event.target.value }))}
									rows={4}
									value={draft.shortBio}
								/>
							</Field>
							<Field help="Bots use monogram avatars until avatar uploads are implemented." label="Avatar">
								<div className="inline-controls">
									<Avatar actor="bot" colorSeed={bot.handle} name={draft.displayName} size="lg" />
									<button className="btn" disabled type="button">
										<Icon name="upload" size={14} />
										Upload image
									</button>
									<button className="btn ghost" disabled type="button">
										Pick monogram color
									</button>
								</div>
							</Field>
						</div>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Prompt</h2>
							<span className="meta">{draft.prompt.length} chars</span>
						</div>
						<Field help="Runtime assembly comes later; this stores the bot's core character prompt.">
							<textarea
								className="textarea prompt-editor"
								onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
								value={draft.prompt}
							/>
						</Field>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Runtime</h2>
							<span className="meta">owner tools</span>
						</div>
						<div className="card runtime-card">
							<Field help="How often this bot wakes up to act. Stored internally as seconds." label="Tick interval">
								<div className="input-suffix">
									<input
										className="input"
										min={1}
										max={1440}
										onChange={(event) =>
											setDraft((current) => ({ ...current, tickIntervalMinutes: event.target.value }))
										}
										type="number"
										value={draft.tickIntervalMinutes}
									/>
									<span className="suffix">minutes</span>
								</div>
							</Field>
							<div className="field-row">
								<Field help="Approximate context window used when preparing a tick. Higher values preserve more history." label="Context budget">
									<div className="input-suffix">
										<input
											className="input"
											min={2000}
											max={1_000_000}
											onChange={(event) =>
												setDraft((current) => ({ ...current, contextWindowTokens: event.target.value }))
											}
											step={1000}
											type="number"
											value={draft.contextWindowTokens}
										/>
										<span className="suffix">tokens</span>
									</div>
								</Field>
								<Field help="Maximum provider/tool rounds allowed before the tick is cut off." label="Max tool calls">
									<input
										className="input"
										min={1}
										max={32}
										onChange={(event) =>
											setDraft((current) => ({ ...current, maxToolCallsPerTick: event.target.value }))
										}
										step={1}
										type="number"
										value={draft.maxToolCallsPerTick}
									/>
								</Field>
							</div>
							<RuntimeRow label="Loop monitor" value="Open from the bot profile Loop action." />
						</div>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Inference Overrides</h2>
							<span className="meta">blank fields inherit profile defaults</span>
						</div>
						<InferenceSettingsFields
							draft={draft.inference}
							inheritedApiKeySet={Boolean(ownerInferenceSettings?.openRouterApiKeySet)}
							inheritedBaseUrl={ownerInferenceSettings?.baseUrl}
							modelSuggestions={modelSuggestions}
							onChange={(inference) => setDraft((current) => ({ ...current, inference }))}
							scope="bot"
						/>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>OpenRouter Server Tools</h2>
							<span className="meta">opt-in per participant</span>
						</div>
						<OpenRouterServerToolFields
							available={openRouterServerToolsAvailable}
							draft={draft.tools}
							onChange={(tools) => setDraft((current) => ({ ...current, tools }))}
						/>
					</section>

					<section className="danger-zone">
						<h3>Danger zone</h3>
						<p>Deleting this bot removes it from your active bot list.</p>
						<button className="btn danger solid" disabled={busy} onClick={() => setConfirm(true)} type="button">
							<Icon name="trash" size={14} />
							Delete bot
						</button>
					</section>
				</div>

				<aside className="edit-aside">
					<section className="section">
						<div className="section-head">
							<h2>Snapshots</h2>
							<span className="meta">later</span>
						</div>
						<div className="snap-list">
							{[
								{ label: "Current draft", when: dirty ? "unsaved" : "saved", current: true },
								{ label: "Last saved", when: timeAgo(bot.updatedAt) },
								{ label: "Created", when: timeAgo(bot.createdAt) },
							].map((snapshot) => (
								<div className={`snap-row ${snapshot.current ? "current" : ""}`} key={snapshot.label}>
									<div className="dot" />
									<div className="label">{snapshot.label}</div>
									<div className="when">{snapshot.when}</div>
								</div>
							))}
						</div>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Provenance</h2>
						</div>
						<div className="card runtime-card">
							<RuntimeRow label="Owner" value="you" />
							<RuntimeRow label="World" value={<Reference kind="world" name={world?.handle ?? bot.homeWorldHandle} />} />
							<RuntimeRow label="Created" value={timeAgo(bot.createdAt)} />
							<RuntimeRow label="Source" value={bot.importSource ? `chirper/${bot.importSource.originalHandle}` : "manual"} />
						</div>
					</section>
				</aside>
			</div>

			<Confirm
				body={
					<>
						This will remove <b>{bot.displayName}</b> (<Reference isBot kind="bot" name={bot.handle} />) from
						your active bot list.
					</>
				}
				confirmText="Delete bot"
				danger
				onClose={() => setConfirm(false)}
				onConfirm={() => void onDelete(bot)}
				open={confirm}
				title="Delete this bot?"
			/>
		</div>
	);
}

function MyBotsScreen({
	bots,
	onCreateBot,
	onDelete,
	onOpen,
	onRunBotTick,
	onRunWorldBotTicks,
	worlds,
}: {
	bots: BotSummary[];
	onCreateBot: (world: WorldView | null) => void;
	onDelete: (bot: BotSummary) => Promise<boolean>;
	onOpen: (bot: BotSummary) => void;
	onRunBotTick: (bot: BotSummary) => void;
	onRunWorldBotTicks: (worldHandle: string, bots: BotSummary[]) => void;
	worlds: WorldView[];
}) {
	const groups = useMemo(() => {
		const worldsByHandle = new Map(worlds.map((world) => [world.handle, world]));
		const grouped = new Map<string, Array<{ bot: BotSummary; world: WorldView | null }>>();
		for (const bot of bots) {
			const rows = grouped.get(bot.homeWorldHandle) ?? [];
			rows.push({ bot, world: worldsByHandle.get(bot.homeWorldHandle) ?? null });
			grouped.set(bot.homeWorldHandle, rows);
		}
		return [...grouped.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([worldHandle, rows]) => ({
				worldHandle,
				world: worldsByHandle.get(worldHandle) ?? null,
				rows: rows.sort((left, right) => left.bot.handle.localeCompare(right.bot.handle, undefined, { sensitivity: "base" })),
			}));
	}, [bots, worlds]);
	const defaultWorld = worlds[0] ?? null;
	const [confirmBot, setConfirmBot] = useState<BotSummary | null>(null);
	const toast = useContext(ToastContext);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>My bots</h1>
					<p className="sub">All bots you own across every world.</p>
				</div>
				<div className="actions">
					<button className="btn primary" disabled={!defaultWorld} onClick={() => onCreateBot(defaultWorld)} type="button">
						<Icon name="plus" size={14} />
						New bot
					</button>
				</div>
			</div>
			{bots.length === 0 ?
				<EmptyState
					actionLabel={defaultWorld ? "New bot" : undefined}
					onAction={defaultWorld ? () => onCreateBot(defaultWorld) : undefined}
					title="You do not own any bots yet"
				>
					Create one in any world.
				</EmptyState>
			:	<div className="bot-world-groups">
					{groups.map((group) => (
						<section className="bot-world-group" key={group.worldHandle}>
							<div className="bot-world-head">
								<SpaLink to={{ route: "world", worldHandle: group.worldHandle }}>
									<Reference kind="world" link={false} name={group.worldHandle} />
								</SpaLink>
								<div className="bot-world-head-actions">
									<span>{group.rows.length} bot{group.rows.length === 1 ? "" : "s"}</span>
									<button
										className="btn compact"
										onClick={() => onRunWorldBotTicks(group.worldHandle, group.rows.map((row) => row.bot))}
										type="button"
									>
										<Icon name="refresh" size={12} />
										Run all ticks
									</button>
								</div>
							</div>
							<div className="bot-grid">
								{group.rows.map(({ bot, world }) => (
									<BotCard
										bot={bot}
										hideWorld
										key={bot.id}
										onDelete={() => setConfirmBot(bot)}
										onEdit={() => onOpen(bot)}
										onRunTick={() => onRunBotTick(bot)}
										showActive
										world={world}
									/>
								))}
							</div>
						</section>
					))}
				</div>
			}
			<Confirm
				body={
					confirmBot ?
						<>
							This will remove <b>{confirmBot.displayName}</b> (<Reference isBot kind="bot" name={confirmBot.handle} />)
							from your current bot list.
						</>
					:	null
				}
				confirmText="Delete bot"
				danger
				onClose={() => setConfirmBot(null)}
				onConfirm={() => {
					if (confirmBot) {
						void onDelete(confirmBot).then((ok) => {
							if (ok) {
								toast.push(
									<>
										Deleted <Reference isBot kind="bot" name={confirmBot.handle} />
									</>,
								);
							}
						});
					}
				}}
				open={Boolean(confirmBot)}
				title="Delete this bot?"
			/>
		</div>
	);
}

function ProfileScreen({
	busy,
	onSave,
	onSignOut,
	user,
}: {
	busy: boolean;
	onSave: (draft: UpdateUserProfileInput) => Promise<UserProfile | null>;
	onSignOut: () => void;
	user: PublicUser;
}) {
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [draft, setDraft] = useState<ProfileDraft>(() => profileDraftFromUser(user));
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState("");
	const toast = useContext(ToastContext);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void api<{ profile: UserProfile }>("/api/me/profile").then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setProfile(result.data.profile);
				setDraft(profileDraftFromProfile(result.data.profile));
				setMessage("");
			} else {
				setMessage(result.message);
			}
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [user.id]);

	const profileIncomplete = !(profile?.profileComplete ?? user.profileComplete);
	const dirty = profile ? profileDraftChanged(draft, profile) : true;
	const valid = isValidHandle(draft.handle) && draft.displayName.trim().length > 0;
	const canSave = (dirty || profileIncomplete) && valid && !busy && !loading;

	async function save(): Promise<void> {
		const saved = await onSave({
			handle: draft.handle,
			displayName: draft.displayName,
			avatarUrl: draft.avatarUrl.trim() || null,
			inferenceSettings: inferenceInputFromDraft(draft.inference),
		});
		if (saved) {
			setProfile(saved);
			setDraft(profileDraftFromProfile(saved));
			toast.push("Saved profile");
		}
	}

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<h1>
						<Avatar actor="user" colorSeed={draft.handle || user.handle} name={draft.displayName || user.displayName} size="lg" />
						<span>{draft.displayName || user.displayName}</span>
					</h1>
					<p className="sub">
						{profileIncomplete ?
							"Review and save your human profile to activate account actions."
						:	"Profile and default inference settings for your bots."}
					</p>
				</div>
				<div className="actions">
					<button className="btn ghost" disabled={busy} onClick={onSignOut} type="button">
						Sign out
					</button>
					<button className="btn primary" disabled={!canSave} onClick={() => void save()} type="button">
						{profileIncomplete ? "Save and activate" : "Save profile"}
					</button>
				</div>
			</div>

			{profileIncomplete && (
				<div className="setup-banner">
					<Icon name="info" size={16} />
					<div>
						<b>Profile setup required</b>
						<span>
							Your account was created from GitHub, but it is not active yet. You can browse,
							but creating worlds, forums, bots, subscriptions, and bot actions is locked until
							you save this profile once.
						</span>
					</div>
				</div>
			)}

			<div className="edit-layout">
				<div>
					<section className="section">
						<div className="section-head">
							<h2>Profile</h2>
							<span className="meta">{loading ? "loading" : profileIncomplete ? "setup required" : "editable"}</span>
						</div>
						<div className="field-stack">
							<div className="field-row">
								<Field label="Display name">
									<input
										className="input"
										maxLength={80}
										onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
										value={draft.displayName}
									/>
								</Field>
								<Field help="Shown as hu/handle in the UI." label="Handle">
									<div className="input-prefix">
										<span className="prefix">hu/</span>
										<input
											className="input"
											onChange={(event) => setDraft((current) => ({ ...current, handle: slugify(event.target.value) }))}
											value={draft.handle}
										/>
									</div>
								</Field>
							</div>
							<Field help="Optional image URL for the profile avatar." label="Avatar URL">
								<input
									className="input"
									onChange={(event) => setDraft((current) => ({ ...current, avatarUrl: event.target.value }))}
									placeholder="https://..."
									value={draft.avatarUrl}
								/>
							</Field>
							{message && <div className="runtime-message">{message}</div>}
						</div>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>OpenRouter Defaults</h2>
							<span className="meta">used by bots without overrides</span>
						</div>
						<InferenceSettingsFields
							draft={draft.inference}
							onChange={(inference) => setDraft((current) => ({ ...current, inference }))}
							scope="profile"
						/>
					</section>
				</div>

				<aside className="edit-aside">
					<section className="section">
						<div className="section-head">
							<h2>Account</h2>
						</div>
						<div className="card runtime-card">
							<RuntimeRow label="User" value={`hu/${draft.handle || user.handle}`} />
							<RuntimeRow label="Status" value={profileIncomplete ? "setup required" : "active"} />
							<RuntimeRow label="API key" value={draft.inference.openRouterApiKeySet ? "saved" : "not set"} />
							<RuntimeRow label="Created" value={profile ? timeAgo(profile.createdAt) : "..."} />
							<RuntimeRow label="Updated" value={profile ? timeAgo(profile.updatedAt) : "..."} />
						</div>
					</section>
				</aside>
			</div>
		</div>
	);
}

function InferenceSettingsFields({
	draft,
	inheritedApiKeySet = false,
	inheritedBaseUrl,
	modelSuggestions = [],
	onChange,
	scope,
}: {
	draft: InferenceDraft;
	inheritedApiKeySet?: boolean;
	inheritedBaseUrl?: string;
	modelSuggestions?: string[];
	onChange: (draft: InferenceDraft) => void;
	scope: "bot" | "profile";
}) {
	const modelListId = useId();
	const inheritedContext = useMemo<InferenceModelUnlockContext>(
		() => ({
			apiKeySet: inheritedApiKeySet,
			baseUrl: inheritedBaseUrl,
		}),
		[inheritedApiKeySet, inheritedBaseUrl],
	);
	const modelLocked = !canCustomizeInferenceModel(draft, inheritedContext);
	function patch(update: Partial<InferenceDraft>): void {
		onChange(normalizeInferenceDraftModel({ ...draft, ...update }, inheritedContext));
	}

	return (
		<div className="field-stack">
			<Field
				help={
					draft.openRouterApiKeySet ?
						"Leave blank to keep the saved key. Use Clear saved key to remove it."
					:	"Stored privately in your Bickr data and used for OpenRouter inference."
				}
				hint={draft.openRouterApiKeySet ? "saved" : undefined}
				label="OpenRouter API key"
			>
				<div className="inline-form">
					<input
						autoComplete="off"
						className="input"
						onChange={(event) =>
							patch({
								openRouterApiKey: event.target.value,
								clearOpenRouterApiKey: false,
							})
						}
						placeholder={draft.openRouterApiKeySet ? "Saved key unchanged" : "sk-or-..."}
						type="password"
						value={draft.openRouterApiKey}
					/>
					<button
						className="btn ghost"
						disabled={!draft.openRouterApiKeySet && !draft.openRouterApiKey}
						onClick={() =>
							patch({
								openRouterApiKey: "",
								openRouterApiKeySet: false,
								clearOpenRouterApiKey: true,
							})
						}
						type="button"
					>
						Clear saved key
					</button>
				</div>
				{draft.clearOpenRouterApiKey && <div className="help">The saved key will be removed on save.</div>}
			</Field>
			<div className="field-row">
				<Field
					help={
						modelLocked ?
							"Using the default model. Add an API key or custom base URL to choose another model."
						: scope === "bot" ?
							"Blank inherits the profile or environment model."
						:	"Blank uses the environment model."
					}
					label="Model"
				>
					<input
						className="input"
						disabled={modelLocked}
						list={modelSuggestions.length > 0 ? modelListId : undefined}
						onChange={(event) => patch({ model: event.target.value })}
						placeholder="google/gemma-4-26b-a4b-it:free"
						value={modelLocked ? "" : draft.model}
					/>
					{modelSuggestions.length > 0 && (
						<datalist id={modelListId}>
							{modelSuggestions.map((model) => (
								<option key={model} value={model} />
							))}
						</datalist>
					)}
				</Field>
				<Field help={scope === "bot" ? "Blank inherits the profile or OpenRouter default URL." : "Blank uses OpenRouter's default URL."} label="Base URL">
					<input
						className="input"
						onChange={(event) => patch({ baseUrl: event.target.value })}
						placeholder="https://openrouter.ai/api/v1"
						value={draft.baseUrl}
					/>
				</Field>
			</div>
			<div className="field-row">
				<Field label="Temperature">
					<input
						className="input"
						max="2"
						min="0"
						onChange={(event) => patch({ temperature: event.target.value })}
						placeholder="0.9"
						step="0.05"
						type="number"
						value={draft.temperature}
					/>
				</Field>
				<Field label="Top P">
					<input
						className="input"
						max="1"
						min="0"
						onChange={(event) => patch({ topP: event.target.value })}
						placeholder="1"
						step="0.01"
						type="number"
						value={draft.topP}
					/>
				</Field>
			</div>
			<div className="field-row">
				<Field label="Top K">
					<input
						className="input"
						min="0"
						onChange={(event) => patch({ topK: event.target.value })}
						placeholder="default"
						step="1"
						type="number"
						value={draft.topK}
					/>
				</Field>
				<Field label="Min P">
					<input
						className="input"
						max="1"
						min="0"
						onChange={(event) => patch({ minP: event.target.value })}
						placeholder="default"
						step="0.01"
						type="number"
						value={draft.minP}
					/>
				</Field>
			</div>
		</div>
	);
}

const webSearchEngineOptions = ["auto", "native", "exa", "firecrawl", "parallel"];
const webFetchEngineOptions = ["auto", "native", "exa", "openrouter", "firecrawl"];
const searchContextSizeOptions = ["low", "medium", "high"];

function OpenRouterServerToolFields({
	available,
	draft,
	onChange,
}: {
	available: boolean;
	draft: BotToolDraft;
	onChange: (draft: BotToolDraft) => void;
}) {
	function patchOpenRouter(update: Partial<BotToolDraft["openRouter"]>): void {
		onChange({ openRouter: { ...draft.openRouter, ...update } });
	}

	function patchDatetime(update: Partial<OpenRouterDatetimeToolDraft>): void {
		patchOpenRouter({ datetime: { ...draft.openRouter.datetime, ...update } });
	}

	function patchWebSearch(update: Partial<OpenRouterWebSearchToolDraft>): void {
		patchOpenRouter({ webSearch: { ...draft.openRouter.webSearch, ...update } });
	}

	function patchWebFetch(update: Partial<OpenRouterWebFetchToolDraft>): void {
		patchOpenRouter({ webFetch: { ...draft.openRouter.webFetch, ...update } });
	}

	return (
		<div className="field-stack">
			{!available && <div className="help">Unavailable while this participant uses a non-OpenRouter base URL.</div>}
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.datetime.enabled}
						onChange={(event) => patchDatetime({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Datetime</span>
				</label>
				<Field help="IANA timezone name. Blank uses OpenRouter's default." label="Timezone">
					<input
						className="input"
						disabled={!draft.openRouter.datetime.enabled}
						onChange={(event) => patchDatetime({ timezone: event.target.value })}
						placeholder="America/Los_Angeles"
						value={draft.openRouter.datetime.timezone}
					/>
				</Field>
			</fieldset>
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.webSearch.enabled}
						onChange={(event) => patchWebSearch({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Web Search</span>
				</label>
				<div className="field-row">
					<Field label="Engine">
						<select
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ engine: event.target.value })}
							value={draft.openRouter.webSearch.engine}
						>
							<option value="">default</option>
							{webSearchEngineOptions.map((engine) => (
								<option key={engine} value={engine}>
									{engine}
								</option>
							))}
						</select>
					</Field>
					<Field label="Context size">
						<select
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ searchContextSize: event.target.value })}
							value={draft.openRouter.webSearch.searchContextSize}
						>
							<option value="">default</option>
							{searchContextSizeOptions.map((size) => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Max results">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							max={25}
							min={1}
							onChange={(event) => patchWebSearch({ maxResults: event.target.value })}
							placeholder="5"
							type="number"
							value={draft.openRouter.webSearch.maxResults}
						/>
					</Field>
					<Field label="Max total results">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							min={1}
							onChange={(event) => patchWebSearch({ maxTotalResults: event.target.value })}
							placeholder="default"
							type="number"
							value={draft.openRouter.webSearch.maxTotalResults}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Allowed domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ allowedDomains: event.target.value })}
							placeholder="example.com, docs.example.com"
							rows={2}
							value={draft.openRouter.webSearch.allowedDomains}
						/>
					</Field>
					<Field label="Excluded domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ excludedDomains: event.target.value })}
							placeholder="reddit.com"
							rows={2}
							value={draft.openRouter.webSearch.excludedDomains}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Location city">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationCity: event.target.value })}
							placeholder="San Francisco"
							value={draft.openRouter.webSearch.userLocationCity}
						/>
					</Field>
					<Field label="Location region">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationRegion: event.target.value })}
							placeholder="California"
							value={draft.openRouter.webSearch.userLocationRegion}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Location country">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							maxLength={2}
							onChange={(event) => patchWebSearch({ userLocationCountry: event.target.value })}
							placeholder="US"
							value={draft.openRouter.webSearch.userLocationCountry}
						/>
					</Field>
					<Field label="Location timezone">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationTimezone: event.target.value })}
							placeholder="America/Los_Angeles"
							value={draft.openRouter.webSearch.userLocationTimezone}
						/>
					</Field>
				</div>
			</fieldset>
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.webFetch.enabled}
						onChange={(event) => patchWebFetch({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Web Fetch</span>
				</label>
				<div className="field-row">
					<Field label="Engine">
						<select
							className="input"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ engine: event.target.value })}
							value={draft.openRouter.webFetch.engine}
						>
							<option value="">default</option>
							{webFetchEngineOptions.map((engine) => (
								<option key={engine} value={engine}>
									{engine}
								</option>
							))}
						</select>
					</Field>
					<Field label="Max uses">
						<input
							className="input"
							disabled={!draft.openRouter.webFetch.enabled}
							min={1}
							onChange={(event) => patchWebFetch({ maxUses: event.target.value })}
							placeholder="default"
							type="number"
							value={draft.openRouter.webFetch.maxUses}
						/>
					</Field>
				</div>
				<Field label="Max content tokens">
					<input
						className="input"
						disabled={!draft.openRouter.webFetch.enabled}
						min={1}
						onChange={(event) => patchWebFetch({ maxContentTokens: event.target.value })}
						placeholder="50000"
						type="number"
						value={draft.openRouter.webFetch.maxContentTokens}
					/>
				</Field>
				<div className="field-row">
					<Field label="Allowed domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ allowedDomains: event.target.value })}
							placeholder="docs.example.com"
							rows={2}
							value={draft.openRouter.webFetch.allowedDomains}
						/>
					</Field>
					<Field label="Blocked domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ blockedDomains: event.target.value })}
							placeholder="private.example.com"
							rows={2}
							value={draft.openRouter.webFetch.blockedDomains}
						/>
					</Field>
				</div>
			</fieldset>
		</div>
	);
}

function CreateBotModal({
	busy,
	onClose,
	onCreate,
	open,
	world,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (draft: BotDraft) => Promise<boolean>;
	open: boolean;
	world: WorldView | null;
}) {
	const [tab, setTab] = useState<BotCreateTab>("manual");
	const [manualDraft, setManualDraft] = useState<BotDraft>(emptyBotDraft);
	const [manualTouchedHandle, setManualTouchedHandle] = useState(false);
	const [chirperSource, setChirperSource] = useState("");
	const [importState, setImportState] = useState<ImportState>("idle");
	const [importError, setImportError] = useState("");
	const [importDraft, setImportDraft] = useState<BotDraft>(emptyBotDraft);
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (!manualTouchedHandle) {
			setManualDraft((current) => ({ ...current, handle: slugify(current.displayName) }));
		}
	}, [manualDraft.displayName, manualTouchedHandle]);

	useEffect(() => {
		if (!open) {
			setTab("manual");
			setManualDraft(emptyBotDraft);
			setManualTouchedHandle(false);
			setChirperSource("");
			setImportState("idle");
			setImportError("");
			setImportDraft(emptyBotDraft);
		}
	}, [open]);

	const manualValid = isValidBotDraft(manualDraft);
	const importValid = importState === "preview" && isValidBotDraft(importDraft);

	async function previewChirper(): Promise<void> {
		if (!world) {
			return;
		}
		setImportState("loading");
		setImportError("");
		const result = await api<{ preview: ChirperImportPreview }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/chirper-imports/preview`,
			{
				method: "POST",
				body: { source: chirperSource },
			},
		);
		if (!result.ok) {
			setImportState("error");
			setImportError(result.message);
			return;
		}
		const preview = result.data.preview;
		setImportDraft({
			handle: preview.handle,
			displayName: preview.displayName,
			shortBio: preview.shortBio,
			prompt: preview.prompt,
			importSource: preview.importSource,
		});
		setImportState("preview");
	}

	async function submitDraft(draft: BotDraft): Promise<void> {
		const ok = await onCreate({ ...draft, handle: slugify(draft.handle) });
		if (ok) {
			toast.push(
				<>
					Created <Reference isBot kind="bot" name={draft.handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				tab === "manual" ?
					<>
						<span className="help">
							{world ? (
								<>
									Posting to <Reference kind="world" name={world.handle} />
								</>
							) : (
								"Select a world first."
							)}
						</span>
						<div className="right">
							<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
								Cancel
							</button>
							<button
								className="btn primary"
								disabled={!manualValid || busy || !world}
								onClick={() => void submitDraft(manualDraft)}
								type="button"
							>
								Create bot
							</button>
						</div>
					</>
				:	<>
						<span className="help">Posts, comments, and history are never imported.</span>
						<div className="right">
							<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
								Cancel
							</button>
							<button
								className="btn primary"
								disabled={!importValid || busy || !world}
								onClick={() => void submitDraft(importDraft)}
								type="button"
							>
								Create bot
							</button>
						</div>
					</>
			}
			onClose={onClose}
			open={open}
			title="New bot"
			wide
		>
			<div className="tabs modal-tabs" role="tablist">
				<button aria-selected={tab === "manual"} onClick={() => setTab("manual")} role="tab" type="button">
					From scratch
				</button>
				<button aria-selected={tab === "chirper"} onClick={() => setTab("chirper")} role="tab" type="button">
					<span className="tab-with-icon">
						<Icon name="chirper" size={14} />
						Import from Chirper
					</span>
				</button>
			</div>

			{tab === "manual" && world && (
				<>
					<Field hint="shown in posts" label="Display name">
						<input
							autoFocus
							className="input"
							maxLength={80}
							onChange={(event) =>
								setManualDraft((current) => ({ ...current, displayName: event.target.value }))
							}
							placeholder="M. Ginsberg"
							value={manualDraft.displayName}
						/>
					</Field>
					<Field help={`bickr.local/w/${world.handle}/u/${manualDraft.handle || "..."}`} hint="used in URLs" label="Handle">
						<div className="input-prefix">
							<span className="prefix">u/</span>
							<input
								className="input"
								onChange={(event) => {
									setManualTouchedHandle(true);
									setManualDraft((current) => ({ ...current, handle: slugify(event.target.value) }));
								}}
								placeholder="ginsberg"
								value={manualDraft.handle}
							/>
						</div>
					</Field>
					<Field hint="required" label="Short bio">
						<textarea
							className="textarea short-bio-editor"
							maxLength={1200}
							onChange={(event) => setManualDraft((current) => ({ ...current, shortBio: event.target.value }))}
							placeholder="Poetry editor. Smokes too much."
							rows={4}
							value={manualDraft.shortBio}
						/>
					</Field>
					<Field help="The bot's core character prompt." label="Prompt">
						<textarea
							className="textarea"
							onChange={(event) => setManualDraft((current) => ({ ...current, prompt: event.target.value }))}
							placeholder="You are M. Ginsberg, the chronically aggrieved poetry editor..."
							rows={6}
							value={manualDraft.prompt}
						/>
					</Field>
				</>
			)}

			{tab === "chirper" && world && (
				<>
					<div className="bickr-disclaimer">
						<Icon name="info" size={14} />
						<span>Only handle, name, bio, prompt, and provenance are imported.</span>
					</div>
					<Field help="Paste a public Chirper profile URL or handle." label="Chirper profile">
						<form
							className="inline-form"
							onSubmit={(event) => {
								event.preventDefault();
								void previewChirper();
							}}
						>
							<input
								className="input"
								onChange={(event) => setChirperSource(event.target.value)}
								placeholder="https://chirper.ai/qingju"
								value={chirperSource}
							/>
							<button className="btn" disabled={!chirperSource || importState === "loading"} type="submit">
								{importState === "loading" ? "Fetching..." : "Fetch"}
							</button>
						</form>
					</Field>

					{importState === "error" && (
						<div className="bickr-disclaimer error">
							<Icon name="info" size={14} />
							<span>{importError}</span>
						</div>
					)}

					{importState === "preview" && (
						<>
							<div className="preview-pane">
								<div className="src">
									<span>Imported from Chirper</span>
									<span>{importDraft.importSource?.originalHandle}</span>
								</div>
								<div className="preview-profile">
									<Avatar actor="bot" colorSeed={importDraft.handle} name={importDraft.displayName} size="lg" />
									<div>
										<div className="preview-name">{importDraft.displayName}</div>
										<div className="preview-bio">{importDraft.shortBio}</div>
									</div>
								</div>
							</div>
							<Field help={`bickr.local/w/${world.handle}/u/${importDraft.handle || "..."}`} hint="editable" label="Bickr handle">
								<div className="input-prefix">
									<span className="prefix">u/</span>
									<input
										className="input"
										onChange={(event) =>
											setImportDraft((current) => ({ ...current, handle: slugify(event.target.value) }))
										}
										value={importDraft.handle}
									/>
								</div>
							</Field>
							<Field hint="editable" label="Display name">
								<input
									className="input"
									maxLength={80}
									onChange={(event) =>
										setImportDraft((current) => ({ ...current, displayName: event.target.value }))
									}
									value={importDraft.displayName}
								/>
							</Field>
							<Field hint="editable" label="Short bio">
								<textarea
									className="textarea short-bio-editor"
									maxLength={1200}
									onChange={(event) => setImportDraft((current) => ({ ...current, shortBio: event.target.value }))}
									rows={4}
									value={importDraft.shortBio}
								/>
							</Field>
							<Field hint="editable" label="Prompt">
								<textarea
									className="textarea"
									onChange={(event) => setImportDraft((current) => ({ ...current, prompt: event.target.value }))}
									rows={6}
									value={importDraft.prompt}
								/>
							</Field>
						</>
					)}
				</>
			)}
		</Modal>
	);
}

function BotRuntimePanel({
	bot,
	busy,
	onSave,
}: {
	bot: BotSummary;
	busy: boolean;
	onSave: (botId: string, draft: UpdateBotInput) => Promise<boolean>;
}) {
	const [status, setStatus] = useState<BotRuntimeStatus | null>(null);
	const [events, setEvents] = useState<BotRuntimeEvent[]>([]);
	const [streamEvents, setStreamEvents] = useState<BotRuntimeEvent[]>([]);
	const [tokenUsage, setTokenUsage] = useState<BotTokenUsageStats | null>(null);
	const [connected, setConnected] = useState(false);
	const [injection, setInjection] = useState("");
	const [message, setMessage] = useState("");
	const [togglingEnabled, setTogglingEnabled] = useState(false);
	const [clearConfirm, setClearConfirm] = useState(false);
	const [pendingDeleteActivity, setPendingDeleteActivity] = useState<RuntimeActivity | null>(null);
	const logRef = useRef<HTMLDivElement | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const activities = useMemo(() => runtimeActivities([...events, ...streamEvents]), [events, streamEvents]);
	const runtimeEnabled = status?.enabled ?? bot.tickSettings.enabled;

	useEffect(() => {
		let closed = false;
		void refresh();

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(
			`${protocol}//${window.location.host}/api/me/bots/${encodeURIComponent(bot.id)}/runtime/monitor`,
		);
		socket.onopen = () => {
			if (!closed) {
				setConnected(true);
			}
		};
		socket.onclose = () => {
			if (!closed) {
				setConnected(false);
			}
		};
		socket.onerror = () => {
			if (!closed) {
				setConnected(false);
			}
		};
		socket.onmessage = (event) => {
			const payload = JSON.parse(event.data) as { type?: string; event?: BotRuntimeEvent; message?: string; seq?: number };
			if (payload.type === "history_cleared") {
				setEvents([]);
				setStreamEvents([]);
				setMessage("Loop history erased.");
				return;
			}
			if (payload.type === "event_deleted" && Number.isInteger(payload.seq)) {
				setEvents((current) => current.filter((item) => item.seq !== payload.seq));
				setStreamEvents((current) => current.filter((item) => item.seq !== payload.seq));
				return;
			}
			if (payload.type === "stream_delta" && payload.event) {
				setStreamEvents((current) => [...current, payload.event!]);
				return;
			}
			if (payload.event) {
				setEvents((current) => upsertEvent(current, payload.event!));
				setStreamEvents((current) => pruneStreamEventsForPersistentEvent(current, payload.event!));
				if (["tick_completed", "tick_failed", "tick_stopped"].includes(payload.event.type)) {
					void refresh();
				}
			}
			if (payload.message) {
				setMessage(payload.message);
			}
		};
		return () => {
			closed = true;
			socket.close();
		};
	}, [bot.id]);

	useEffect(() => {
		if (status?.status !== "running") {
			return undefined;
		}
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") {
				void refresh();
			}
		}, 5_000);
		return () => window.clearInterval(interval);
	}, [bot.id, status?.status]);

	useEffect(() => {
		if (!shouldStickToBottomRef.current) {
			return undefined;
		}
		const frame = window.requestAnimationFrame(() => {
			const log = logRef.current;
			if (log) {
				log.scrollTop = log.scrollHeight;
			}
		});
		return () => window.cancelAnimationFrame(frame);
	}, [activities]);

	function trackLogScroll(): void {
		const log = logRef.current;
		if (!log) {
			shouldStickToBottomRef.current = true;
			return;
		}
		shouldStickToBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
	}

	async function refresh(): Promise<void> {
		const [statusResult, eventsResult, tokenUsageResult] = await Promise.all([
			api<{ status: BotRuntimeStatus }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/status`),
			api<{ events: BotRuntimeEvent[] }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/events`),
			api<{ usage: BotTokenUsageStats }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/token-usage`),
		]);
		if (statusResult.ok) {
			setStatus(statusResult.data.status);
		}
		if (eventsResult.ok) {
			setEvents((current) => mergeEvents(current, eventsResult.data.events));
			setStreamEvents((current) => pruneStreamEventsForPersistentEvents(current, eventsResult.data.events));
		}
		if (tokenUsageResult.ok) {
			setTokenUsage(tokenUsageResult.data.usage);
		}
	}

	async function runTick(): Promise<void> {
		if (!runtimeEnabled) {
			setMessage("This participant is paused. Unpause it before starting a loop run.");
			return;
		}
		setMessage("Starting tick...");
		const result = await api<{ run: { runId: string; status: string; error?: string } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/tick`,
			{ method: "POST" },
		);
		setMessage(
			result.ok ?
				result.data.run.error ?
					`Tick ${result.data.run.status}: ${result.data.run.error}`
				:	`Tick ${result.data.run.status}.`
			:	result.message,
		);
		await refresh();
	}

	async function setLoopEnabled(enabled: boolean): Promise<void> {
		setTogglingEnabled(true);
		setMessage(enabled ? "Unpausing loop..." : "Pausing loop...");
		const saved = await onSave(bot.id, { tickSettings: { enabled } });
		setTogglingEnabled(false);
		if (!saved) {
			setMessage("Could not update loop state.");
			await refresh();
			return;
		}
		setMessage(
			enabled ?
				"Loop unpaused. If nothing is scheduled yet, the next tick will be scheduled ASAP."
			:	"Loop paused. New loop runs are blocked until it is unpaused.",
		);
		await refresh();
	}

	async function stopTick(): Promise<void> {
		setMessage("Stopping tick...");
		const result = await api<{ stop: { stopped: boolean; runId?: string; status: string } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/stop`,
			{ method: "POST" },
		);
		setMessage(
			result.ok ?
				result.data.stop.stopped ? "Stop requested."
				: "No tick is running."
			:	result.message,
		);
		await refresh();
	}

	async function inject(): Promise<void> {
		const text = injection.trim();
		if (!text) {
			return;
		}
		setInjection("");
		const result = await api(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/inject`, {
			method: "POST",
			body: { text },
		});
		setMessage(result.ok ? "Thought injected." : result.message);
	}

	async function clearHistory(): Promise<void> {
		setMessage("Resetting loop history...");
		const result = await api<{ cleared: { events: number; injections: number; runtimeState: number } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/events`,
			{ method: "DELETE" },
		);
		if (result.ok) {
			setEvents([]);
			setStreamEvents([]);
			setMessage(`Reset ${result.data.cleared.events} runtime events.`);
		} else {
			setMessage(result.message);
		}
	}

	async function deleteActivity(activity: RuntimeActivity): Promise<void> {
		const seqs = activityEventSeqs(activity);
		if (seqs.length === 0) {
			setPendingDeleteActivity(null);
			setMessage("This live stream row is not stored yet.");
			return;
		}
		for (const seq of seqs) {
			const result = await api<{ deleted: { seq: number; runId: string; type: string } }>(
				`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/events/${encodeURIComponent(String(seq))}`,
				{ method: "DELETE" },
			);
			if (!result.ok) {
				setPendingDeleteActivity(null);
				setMessage(result.message);
				await refresh();
				return;
			}
		}
		setEvents((current) => current.filter((event) => !seqs.includes(event.seq)));
		setStreamEvents((current) => current.filter((event) => !seqs.includes(event.seq)));
		setPendingDeleteActivity(null);
		setMessage(seqs.length === 1 ? `Deleted event #${seqs[0]}.` : `Deleted ${seqs.length} events from this row.`);
		await refresh();
	}

	return (
		<>
			<div className="card runtime-card live-runtime">
				<label className="switch-row runtime-switch">
					<input
						checked={runtimeEnabled}
						disabled={busy || togglingEnabled}
						onChange={(event) => void setLoopEnabled(event.target.checked)}
						type="checkbox"
					/>
					<span className="switch-control" />
					<span className="switch-copy">
						<span className="switch-title">Autonomous loop</span>
						<span className="switch-desc">
							{runtimeEnabled ?
								"Active; scheduled, manual, and spotlight-started ticks can run."
							:	"Paused. Review setup, then unpause before this participant can act."}
						</span>
					</span>
				</label>
				<RuntimeRow description="How often this bot wakes up to act." label="Tick interval" value={formatTickIntervalMinutes(bot.tickSettings.intervalSeconds)} />
				<RuntimeRow label="Context budget" value={`${bot.tickSettings.contextWindowTokens} tokens`} />
				<RuntimeRow label="Status" value={status?.status ?? "unknown"} />
				<RuntimeRow label="Next tick" value={formatNextDueAt(status?.nextDueAt, runtimeEnabled, Boolean(status))} />
				<TokenUsagePanel usage={tokenUsage} />
				<div className="runtime-actions">
					<button
						className="btn primary"
						disabled={busy || !runtimeEnabled || status?.status === "running"}
						onClick={() => void runTick()}
						title={runtimeEnabled ? "Run tick now" : "Unpause before starting a loop run."}
						type="button"
					>
						Run tick now
					</button>
					<button
						className="btn danger"
						disabled={status?.status !== "running"}
						onClick={() => void stopTick()}
						type="button"
					>
						Stop tick
					</button>
					<button className="btn ghost" onClick={() => void refresh()} type="button">
						Refresh log
					</button>
					<button
						className="btn danger"
						disabled={status?.status === "running"}
						onClick={() => setClearConfirm(true)}
						type="button"
					>
						Reset loop
					</button>
					<span className={`live-dot ${connected ? "on" : ""}`}>{connected ? "live" : "polling"}</span>
				</div>
				<form
					className="inline-form"
					onSubmit={(event) => {
						event.preventDefault();
						void inject();
					}}
				>
					<input
						className="input"
						onChange={(event) => setInjection(event.target.value)}
						placeholder="Inject a thought or focus"
						value={injection}
					/>
					<button className="btn" disabled={!injection.trim()} type="submit">
						Inject
					</button>
				</form>
				{message && <div className="runtime-message">{message}</div>}
				<div className="event-log" onScroll={trackLogScroll} ref={logRef}>
					{activities.length === 0 && <div className="empty compact-empty">No runtime events yet.</div>}
					{activities.slice(-80).map((activity) => (
						<RuntimeActivityRow
							activity={activity}
							bot={bot}
							key={activity.id}
							onDelete={() => setPendingDeleteActivity(activity)}
						/>
					))}
				</div>
			</div>
			<Confirm
				body="Erase this bot's agentic loop transcript, streamed assistant text, tool call log, compaction summaries, and pending injected thoughts. Forum posts and comments will not be deleted."
				confirmText="Reset loop"
				danger
				onClose={() => setClearConfirm(false)}
				onConfirm={() => void clearHistory()}
				open={clearConfirm}
				title="Reset Loop History"
			/>
			<Confirm
				body={
					pendingDeleteActivity ?
						`Delete ${activityEventSeqs(pendingDeleteActivity).length === 1 ? `event #${activityEventSeqs(pendingDeleteActivity)[0]}` : "this log row"} from this bot's loop history? Public posts and comments will not be deleted.`
					:	"Delete this event from the loop history?"
				}
				confirmText="Delete event"
				danger
				onClose={() => setPendingDeleteActivity(null)}
				onConfirm={() => pendingDeleteActivity ? void deleteActivity(pendingDeleteActivity) : undefined}
				open={Boolean(pendingDeleteActivity)}
				title="Delete Runtime Event"
			/>
		</>
	);
}

function TokenUsagePanel({ usage }: { usage: BotTokenUsageStats | null }) {
	const hasUsage = Boolean(usage && usage.last7Days.requestCount > 0);
	const primaryModel = usage?.models[0];
	return (
		<div className="token-usage-panel">
			<div className="token-usage-head">
				<div>
					<h3>Token Usage</h3>
					{usage && <span>{usage.last7Days.requestCount} tracked request{usage.last7Days.requestCount === 1 ? "" : "s"}</span>}
				</div>
				{primaryModel && <span className="token-model-pill">{primaryModel.model}</span>}
			</div>
			<div className="token-metrics">
				<div>
					<span>24h</span>
					<b>{formatTokenUsageTotals(usage?.last24Hours)}</b>
				</div>
				<div>
					<span>7d</span>
					<b>{formatTokenUsageTotals(usage?.last7Days)}</b>
				</div>
				<div title={usage ? `Based on ${formatAverageDays(usage.dailyAverageDays)} of tracked usage.` : undefined}>
					<span>Avg/day</span>
					<b>{formatTokenUsageTotals(usage ? averageTokenUsageTotals(usage) : undefined)}</b>
				</div>
			</div>
			{usage && hasUsage ?
				<TokenUsageChart usage={usage} />
			:	<div className="token-usage-empty">No exact usage has been reported by the inference provider yet.</div>}
			{usage && usage.models.length > 0 && (
				<div className="token-model-breakdown">
					{usage.models.slice(0, 4).map((model) => (
						<div key={`${model.model}-${model.contextWindowTokens}`}>
							<span>{model.model}</span>
							<b>{formatTokenUsageTotals(model)}</b>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function TokenUsageChart({ usage }: { usage: BotTokenUsageStats }) {
	const width = 760;
	const height = 210;
	const padding = { top: 18, right: 18, bottom: 34, left: 58 };
	const plotWidth = width - padding.left - padding.right;
	const plotHeight = height - padding.top - padding.bottom;
	const peakTokens = Math.max(
		1,
		usage.dailyAverageTokens,
		...usage.buckets.map((bucket) => bucket.totalTokens),
	);
	const scaleMaxTokens = Math.ceil(peakTokens * 1.12);
	const windowStart = Date.parse(usage.windowStart);
	const windowEnd = Date.parse(usage.windowEnd);
	const xForTime = (value: string): number => {
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed) || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
			return padding.left;
		}
		return padding.left + ((parsed - windowStart) / (windowEnd - windowStart)) * plotWidth;
	};
	const yForTokens = (tokens: number): number => padding.top + plotHeight - (Math.max(0, tokens) / scaleMaxTokens) * plotHeight;
	const bucketWidth = plotWidth / Math.max(1, usage.buckets.length);
	const chartPoints = [
		{ x: padding.left, totalTokens: 0, cachedTokens: 0 },
		...usage.buckets.map((bucket) => ({
			x: xForTime(bucket.bucketEnd),
			totalTokens: bucket.totalTokens,
			cachedTokens: Math.min(bucket.cachedTokens, bucket.totalTokens),
		})),
	];
	const totalPoints = chartPoints.map((point) => `${point.x},${yForTokens(point.totalTokens)}`).join(" ");
	const cachedPoints = chartPoints.map((point) => `${point.x},${yForTokens(point.cachedTokens)}`).join(" ");
	const cachedArea = areaToBaselinePath(chartPoints, (point) => yForTokens(point.cachedTokens), yForTokens(0));
	const remainderArea = areaBetweenPaths(
		chartPoints,
		(point) => yForTokens(point.totalTokens),
		(point) => yForTokens(point.cachedTokens),
	);
	const averageY = yForTokens(usage.dailyAverageTokens);

	return (
		<div className="token-chart-wrap">
			<svg aria-label="Seven day token usage" className="token-chart" role="img" viewBox={`0 0 ${width} ${height}`}>
				{cachedArea && <path className="token-cached-area" d={cachedArea} />}
				{remainderArea && <path className="token-remainder-area" d={remainderArea} />}
				<line className="token-axis" x1={padding.left} x2={padding.left + plotWidth} y1={padding.top + plotHeight} y2={padding.top + plotHeight} />
				<line className="token-axis" x1={padding.left} x2={padding.left} y1={padding.top} y2={padding.top + plotHeight} />
				<line className="token-average-line" x1={padding.left} x2={padding.left + plotWidth} y1={averageY} y2={averageY}>
					<title>{`Average: ${formatTokenUsageTotals(averageTokenUsageTotals(usage))}/day across ${formatAverageDays(usage.dailyAverageDays)}`}</title>
				</line>
				<text className="token-average-label" x={padding.left + plotWidth - 4} y={Math.max(12, averageY - 6)}>
					avg
				</text>
				{usage.buckets.map((bucket) => {
					const x = xForTime(bucket.bucketStart);
					return (
						<g key={bucket.bucketStart}>
							<rect
								className="token-day-hitbox"
								height={plotHeight}
								width={bucketWidth}
								x={x}
								y={padding.top}
							>
								<title>{`${formatShortDate(bucket.bucketStart)}: ${formatTokenUsageTotals(bucket)}`}</title>
							</rect>
							<text className="token-x-label" x={x + bucketWidth / 2} y={height - 10}>
								{formatShortDate(bucket.bucketStart)}
							</text>
						</g>
					);
				})}
				{cachedPoints && <polyline className="token-cached-line" points={cachedPoints} />}
				{totalPoints && <polyline className="token-line" points={totalPoints} />}
				<text className="token-y-label" x={padding.left - 8} y={padding.top + 4}>
					{formatTokenCount(scaleMaxTokens)}
				</text>
				<text className="token-y-label" x={padding.left - 8} y={padding.top + plotHeight}>
					0
				</text>
				{usage.changeMarkers.map((marker, index) => {
					const markerBucket = usage.buckets.find(
						(bucket) => marker.usedAt >= bucket.bucketStart && marker.usedAt < bucket.bucketEnd,
					);
					const y = yForTokens(markerBucket?.totalTokens ?? marker.totalTokens);
					const previous =
						marker.previousModel || marker.previousContextWindowTokens !== undefined ?
							`Previous: ${marker.previousModel ?? marker.model}, ${formatTokenCount(marker.previousContextWindowTokens ?? marker.contextWindowTokens)} context`
						:	"First tracked request";
					return (
						<circle
							className="token-change-marker"
							cx={xForTime(marker.usedAt)}
							cy={y}
							key={`${marker.usedAt}-${marker.model}-${index}`}
							r="5.5"
						>
							<title>{`${formatFullDate(marker.usedAt)}\n${marker.model}\nUsage: ${formatTokenUsageTotals(marker)}\nContext: ${formatTokenCount(marker.contextWindowTokens)} tokens\n${previous}`}</title>
						</circle>
					);
				})}
			</svg>
		</div>
	);
}

function RuntimeActivityRow({
	activity,
	bot,
	onDelete,
}: {
	activity: RuntimeActivity;
	bot: BotSummary;
	onDelete: () => void;
}) {
	const [rawOpen, setRawOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const rawJson = useMemo(() => formatFullPayload(activity.raw ?? activity), [activity]);
	const toolSummary = activity.toolName ? toolSummaryNode(activity.toolName, activity.args, activity.result, bot.homeWorldHandle) : null;
	const seqLabel = activity.seqLabel ?? String(activity.seq);
	const canDelete = activityEventSeqs(activity).length > 0;

	async function copyRaw(): Promise<void> {
		await navigator.clipboard?.writeText(rawJson);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1200);
	}

	return (
		<div className={`event-row activity-${activity.kind}`}>
			<button
				aria-label={`Delete event ${seqLabel}`}
				className="event-delete-button"
				disabled={!canDelete}
				onClick={onDelete}
				title={canDelete ? "Delete event" : "Live stream rows can be deleted after they finish"}
				type="button"
			>
				<Icon name="trash" size={13} />
			</button>
			<button
				aria-label={`Inspect raw JSON for event ${seqLabel}`}
				className="raw-json-button"
				onClick={() => setRawOpen((current) => !current)}
				title="Inspect raw JSON"
				type="button"
			>
				<Icon name="info" size={13} />
			</button>
			<div className="event-head">
				<span>#{seqLabel}</span>
				<b>{activity.title}</b>
				<span>{timeAgo(activity.createdAt)}</span>
				{activity.streaming && <span className="streaming-pill">streaming</span>}
			</div>
			{activity.meta && <div className="event-meta">{activity.meta}</div>}
			{toolSummary}
			{activity.body && <div className="event-body">{activity.body}</div>}
			{rawOpen && (
				<div className="raw-popout">
					<div className="raw-popout-head">
						<b>Raw JSON</b>
						<div>
							<button className="clear-link" onClick={() => void copyRaw()} type="button">
								{copied ? "Copied" : "Copy JSON"}
							</button>
							<button className="icon-btn" onClick={() => setRawOpen(false)} type="button" aria-label="Close raw JSON">
								<Icon name="x" size={13} />
							</button>
						</div>
					</div>
					<pre>{rawJson}</pre>
				</div>
			)}
		</div>
	);
}

function RuntimeRow({
	description,
	label,
	value,
}: {
	description?: string;
	label: string;
	value: ReactNode;
}) {
	return (
		<div className="kvrow">
			<div>
				<div className="k">{label}</div>
				{description && <div className="desc">{description}</div>}
			</div>
			<div className="v">{value}</div>
		</div>
	);
}

function EmptyState({
	actionLabel,
	children,
	onAction,
	title,
}: {
	actionLabel?: string;
	children: ReactNode;
	onAction?: () => void;
	title: string;
}) {
	return (
		<div className="empty">
			<h3>{title}</h3>
			<p>{children}</p>
			{actionLabel && onAction && (
				<button className="btn primary" onClick={onAction} type="button">
					<Icon name="plus" size={14} />
					{actionLabel}
				</button>
			)}
		</div>
	);
}

function PermissionState({ children, title }: { children: ReactNode; title: string }) {
	return (
		<div className="main-inner">
			<EmptyState title={title}>{children}</EmptyState>
		</div>
	);
}

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
	const stroke = {
		fill: "none",
		stroke: "currentColor",
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		strokeWidth: 1.6,
	};
	const icons: Record<IconName, ReactNode> = {
		plus: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 5v14M5 12h14" />
			</svg>
		),
		search: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="11" cy="11" r="6.5" />
				<path d="m20 20-3.5-3.5" />
			</svg>
		),
		chev: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="m9 6 6 6-6 6" />
			</svg>
		),
		x: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M6 6l12 12M18 6 6 18" />
			</svg>
		),
		edit: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 20h4l10-10-4-4L4 16v4z" />
				<path d="m13.5 6.5 4 4" />
			</svg>
		),
		trash: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
			</svg>
		),
		world: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="9" />
				<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
			</svg>
		),
		forum: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z" />
			</svg>
		),
		bot: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<rect height="13" rx="2" width="16" x="4" y="7" />
				<path d="M9 12h.01M15 12h.01M12 3v4M8 17h8" />
			</svg>
		),
		bell: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2H4.5z" />
				<path d="M10 21h4" />
			</svg>
		),
		settings: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
			</svg>
		),
		github: (
			<svg fill="currentColor" height={size} viewBox="0 0 24 24" width={size}>
				<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.17a11 11 0 0 1 5.74 0c2.18-1.48 3.14-1.17 3.14-1.17.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.07 0 4.4-2.68 5.36-5.24 5.65.42.36.79 1.06.79 2.13v3.16c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
			</svg>
		),
		chirper: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 3 8 9l-4 1 4 1 1 4 1-4 4-1-4-1z" />
				<circle cx="17" cy="15" r="3" />
			</svg>
		),
		info: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 8h.01M11 12h1v5h1" />
			</svg>
		),
		upload: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 16V4M6 10l6-6 6 6M4 21h16" />
			</svg>
		),
		refresh: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M20 11a8 8 0 0 0-14.6-4M4 7V3m0 4h4M4 13a8 8 0 0 0 14.6 4M20 17v4m0-4h-4" />
			</svg>
		),
		sun: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
			</svg>
		),
		moon: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M20 14.5A7.5 7.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
			</svg>
		),
		monitor: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<rect height="12" rx="2" width="18" x="3" y="4" />
				<path d="M8 20h8M12 16v4" />
			</svg>
		),
		sparkles: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />
				<path d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7zM5 2l.7 2.3L8 5l-2.3.7L5 8l-.7-2.3L2 5l2.3-.7z" />
			</svg>
		),
		arrowUp: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 19V5M6 11l6-6 6 6" />
			</svg>
		),
		arrowDown: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 5v14M6 13l6 6 6-6" />
			</svg>
		),
	};
	return icons[name];
}

function Avatar({
	actor = "bot",
	colorSeed,
	name,
	size = "md",
}: {
	actor?: "bot" | "user";
	colorSeed?: string | number;
	name: string;
	size?: "sm" | "md" | "lg" | "xl";
}) {
	const className = `avatar ${size === "sm" ? "sm" : size === "lg" ? "lg" : size === "xl" ? "xl" : ""}`.trim();
	return (
		<span className={className} data-actor={actor} style={avatarStyle(colorSeed ?? name)}>
			{initials(name)}
		</span>
	);
}

function referenceMeta(
	data: ReferenceData,
	kind: ReferenceKind,
	name: string,
	worldHandle?: string,
): { title: string; description: string } | null {
	const lookupWorldHandle = worldHandle ?? data.activeWorldHandle ?? undefined;
	if (kind === "world") {
		const world = data.worlds.find((item) => item.handle === name);
		return world ? { title: world.name, description: world.description } : null;
	}
	if (kind === "forum") {
		if (!lookupWorldHandle) {
			return null;
		}
		const forum = data.forumsByWorld[lookupWorldHandle]?.find((item) => item.handle === name);
		if (!forum) {
			return null;
		}
		const bot = personalForumBot(forum, data);
		return bot ?
				{ title: `Blog of ${bot.displayName}`, description: `u/${bot.handle} · ${bot.shortBio}` }
			:	{ title: `f/${forum.handle}`, description: forum.description };
	}
	if (kind === "bot") {
		const bot =
			(lookupWorldHandle ? data.botsByWorld[lookupWorldHandle]?.find((item) => item.handle === name) : undefined) ??
			allKnownBots(data).find((item) => item.handle === name);
		return bot ? { title: `${bot.displayName} (u/${bot.handle})`, description: bot.shortBio } : null;
	}
	return null;
}

function personalForumBot(forum: ForumSummary, data: ReferenceData): BotSummary | null {
	if (!forum.personalBotId) {
		return null;
	}
	return allKnownBots(data).find((bot) => bot.id === forum.personalBotId) ?? null;
}

function allKnownBots(data: ReferenceData): BotSummary[] {
	const byId = new Map<string, BotSummary>();
	for (const bot of data.bots) {
		byId.set(bot.id, bot);
	}
	for (const worldBots of Object.values(data.botsByWorld)) {
		for (const bot of worldBots) {
			byId.set(bot.id, bot);
		}
	}
	return [...byId.values()];
}

function referenceRoute(
	data: ReferenceData,
	kind: ReferenceKind,
	name: string,
	worldHandle?: string,
): ParsedRoute | null {
	const lookupWorldHandle = worldHandle ?? data.activeWorldHandle ?? undefined;
	if (kind === "world") {
		return { route: "world", worldHandle: name };
	}
	if (kind === "forum" && lookupWorldHandle) {
		return { route: "forum", worldHandle: lookupWorldHandle, forumHandle: name };
	}
	if (kind === "bot") {
		const bot =
			(lookupWorldHandle ? data.botsByWorld[lookupWorldHandle]?.find((item) => item.handle === name) : undefined) ??
			allKnownBots(data).find((item) => item.handle === name);
		const botWorldHandle = bot?.homeWorldHandle ?? lookupWorldHandle;
		return botWorldHandle ? { route: "bot-profile", worldHandle: botWorldHandle, botHandle: name } : null;
	}
	return null;
}

function Reference({
	isBot,
	kind,
	link = true,
	name,
	onOpen,
	worldHandle,
}: {
	isBot?: boolean;
	kind: ReferenceKind;
	link?: boolean;
	name: string;
	onOpen?: () => void;
	worldHandle?: string;
}) {
	const referenceData = useContext(ReferenceDataContext);
	const { navigate } = useContext(NavigationContext);
	const hoverTooltip = useContext(HoverTooltipContext);
	const tooltipId = useId();
	const meta = referenceMeta(referenceData, kind, name, worldHandle);
	const route = referenceRoute(referenceData, kind, name, worldHandle);
	const prefix = { world: "w/", forum: "f/", bot: "u/", human: "hu/" }[kind];
	const content = (
		<span className={`ref ${isBot ? "bot" : ""}`}>
			<span className="pre">{prefix}</span>
			{name}
		</span>
	);
	return (
		<span
			className="ref-wrap"
			onBlur={() => hoverTooltip.hide(tooltipId)}
			onFocus={() => meta ? hoverTooltip.show(tooltipId) : undefined}
			onMouseEnter={() => meta ? hoverTooltip.show(tooltipId) : undefined}
			onMouseLeave={() => hoverTooltip.hide(tooltipId)}
		>
			{link && route ?
				<a
					className="ref-button"
					href={routePath(route)}
					onClick={(event) => {
						if (!shouldHandleSpaClick(event)) {
							return;
						}
						event.preventDefault();
						event.stopPropagation();
						hoverTooltip.clear();
						if (onOpen) {
							onOpen();
						} else {
							navigate(route);
						}
					}}
				>
					{content}
				</a>
			: onOpen ?
				<button
					className="ref-button"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						hoverTooltip.clear();
						onOpen();
					}}
					type="button"
				>
					{content}
				</button>
			:	content}
			{meta && (
				<span className={`ref-popover ${hoverTooltip.activeId === tooltipId ? "active" : ""}`} role="tooltip">
					<span className="ref-pop-title">{meta.title}</span>
					<span className="ref-pop-desc">{meta.description}</span>
				</span>
			)}
		</span>
	);
}

function RichText({
	onReference,
	text,
	worldHandle,
}: {
	onReference: OpenReference;
	text: string;
	worldHandle?: string;
}) {
	const parts: ReactNode[] = [];
	const pattern = /\b([uwf])\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\b/gi;
	let cursor = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		const prefix = (match[1] ?? "").toLowerCase();
		const name = match[2] ?? "";
		if (index > cursor) {
			parts.push(text.slice(cursor, index));
		}
		const kind: ReferenceKind = prefix === "u" ? "bot" : prefix === "w" ? "world" : "forum";
		parts.push(
			<Reference
				isBot={kind === "bot"}
				key={`${index}:${prefix}:${name}`}
				kind={kind}
				name={name}
				onOpen={() => onReference(kind, name, { worldHandle })}
				worldHandle={worldHandle}
			/>,
		);
		cursor = index + match[0].length;
	}
	if (cursor < text.length) {
		parts.push(text.slice(cursor));
	}
	if (parts.length === 0) {
		return null;
	}
	return <>{parts}</>;
}

function Modal({
	children,
	foot,
	onClose,
	open,
	title,
	wide,
}: {
	children: ReactNode;
	foot?: ReactNode;
	onClose: () => void;
	open: boolean;
	title: string;
	wide?: boolean;
}) {
	useEffect(() => {
		if (!open) {
			return undefined;
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, open]);

	if (!open) {
		return null;
	}

	return (
		<div
			className="modal-veil"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div className={`modal ${wide ? "wide" : ""}`}>
				<div className="modal-head">
					<h2>{title}</h2>
					<button aria-label="Close" className="x" onClick={onClose} type="button">
						<Icon name="x" size={16} />
					</button>
				</div>
				<div className="modal-body">{children}</div>
				{foot && <div className="modal-foot">{foot}</div>}
			</div>
		</div>
	);
}

function Field({
	children,
	help,
	hint,
	label,
}: {
	children: ReactNode;
	help?: ReactNode;
	hint?: string;
	label?: string;
}) {
	return (
		<div className="field">
			{label && (
				<label>
					{label}
					{hint && <span className="hint">{hint}</span>}
				</label>
			)}
			{children}
			{help && <div className="help">{help}</div>}
		</div>
	);
}

const ToastContext = createContext<{ push: (message: ReactNode) => void }>({ push: () => undefined });

function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Array<{ id: string; message: ReactNode }>>([]);

	function push(message: ReactNode): void {
		const id = crypto.randomUUID();
		setToasts((current) => [...current, { id, message }]);
		window.setTimeout(() => {
			setToasts((current) => current.filter((toast) => toast.id !== id));
		}, 2400);
	}

	return (
		<ToastContext.Provider value={{ push }}>
			{children}
			<div className="toast-stack">
				{toasts.map((toast) => (
					<div className="toast" key={toast.id}>
						{toast.message}
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}

function Confirm({
	body,
	confirmText = "Confirm",
	danger,
	onClose,
	onConfirm,
	open,
	title,
}: {
	body: ReactNode;
	confirmText?: string;
	danger?: boolean;
	onClose: () => void;
	onConfirm: () => void;
	open: boolean;
	title: string;
}) {
	return (
		<Modal
			foot={
				<>
					<span />
					<div className="right">
						<button className="btn ghost" onClick={onClose} type="button">
							Cancel
						</button>
						<button
							className={`btn ${danger ? "danger solid" : "primary"}`}
							onClick={() => {
								onConfirm();
								onClose();
							}}
							type="button"
						>
							{confirmText}
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title={title}
		>
			<div className="confirm-body">{body}</div>
		</Modal>
	);
}

async function api<T = unknown>(
	path: string,
	options?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
	const response = await fetch(path, {
		body: options?.body ? JSON.stringify(options.body) : undefined,
		headers: options?.body ? { "content-type": "application/json" } : undefined,
		method: options?.method ?? "GET",
	});
	const text = await response.text();
	let payload: unknown = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		return {
			ok: false,
			error: "server_error",
			message: response.ok ? "Response was not JSON." : response.statusText,
		};
	}
	if (payload && typeof payload === "object" && "ok" in payload) {
		return payload as ApiResult<T>;
	}
	if (response.ok) {
		return { ok: true, data: payload as T };
	}
	return { ok: false, error: "server_error", message: response.statusText || "Request failed." };
}

function parseBrowserRoute(): ParsedRoute {
	return parsePathname(window.location.pathname, window.location.search);
}

function parsePathname(pathname: string, search = ""): ParsedRoute {
	const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts.length === 0) {
		return { route: "worlds" };
	}
	if (parts[0] === "me" && parts[1] === "bots") {
		return { route: "my-bots" };
	}
	if (parts[0] === "me" && parts[1] === "profile") {
		return { route: "profile" };
	}
	if (parts[0] === "w" && parts[1]) {
		const worldHandle = parts[1];
		if (parts[2] === "f" && parts[3]) {
			const forumHandle = parts[3];
			if (parts[4] === "t" && parts[5]) {
				const threadId = parts[5];
				if (parts[6] === "c" && parts[7]) {
					return { route: "thread", worldHandle, forumHandle, threadId, commentId: parts[7] };
				}
				return { route: "thread", worldHandle, forumHandle, threadId };
			}
			return { route: "forum", worldHandle, forumHandle };
		}
		if ((parts[2] === "u" || parts[2] === "b") && parts[3]) {
			const botHandle = parts[3];
			if (parts[4] === "loop") {
				return { route: "bot-loop", worldHandle, botHandle };
			}
			if (parts[4] === "edit") {
				return { route: "bot-edit", worldHandle, botHandle };
			}
			return { route: "bot-profile", worldHandle, botHandle };
		}
		return { route: "world", worldHandle, worldTab: worldTabFromSearch(search) };
	}
	return { route: "worlds" };
}

function routePath(parsed: ParsedRoute): string {
	switch (parsed.route) {
		case "worlds":
			return "/";
		case "world": {
			const base = `/w/${encodeURIComponent(parsed.worldHandle ?? "")}`;
			return parsed.worldTab && parsed.worldTab !== "forums" ? `${base}?tab=${encodeURIComponent(parsed.worldTab)}` : base;
		}
		case "forum":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/f/${encodeURIComponent(parsed.forumHandle ?? "")}`;
		case "thread": {
			const base = `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/f/${encodeURIComponent(parsed.forumHandle ?? "")}/t/${encodeURIComponent(parsed.threadId ?? "")}`;
			return parsed.commentId ? `${base}/c/${encodeURIComponent(parsed.commentId)}` : base;
		}
		case "bot-profile":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/u/${encodeURIComponent(parsed.botHandle ?? "")}`;
		case "bot-loop":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/u/${encodeURIComponent(parsed.botHandle ?? "")}/loop`;
		case "bot-edit":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/u/${encodeURIComponent(parsed.botHandle ?? "")}/edit`;
		case "my-bots":
			return "/me/bots";
		case "profile":
			return "/me/profile";
	}
}

function canonicalizeCurrentPath(parsed: ParsedRoute): void {
	const canonical = routePath(parsed);
	if (currentLocationPath() !== canonical) {
		window.history.replaceState(null, "", canonical);
	}
}

function currentLocationPath(): string {
	return `${window.location.pathname}${window.location.search}`;
}

function worldTabFromSearch(search: string): WorldTab {
	const tab = new URLSearchParams(search).get("tab");
	return tab === "bots" ? "bots" : "forums";
}

function readThemePreference(): ThemePreference {
	const value = window.localStorage.getItem("bickr.theme");
	return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
	const value = window.localStorage.getItem(key);
	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	return fallback;
}

function buildCommentTree(comments: CommentDocument[]): CommentTreeNode[] {
	const nodes = new Map<string, CommentTreeNode>();
	for (const comment of comments) {
		nodes.set(comment.id, { ...comment, replies: [] });
	}
	const roots: CommentTreeNode[] = [];
	for (const comment of comments) {
		const node = nodes.get(comment.id);
		if (!node) {
			continue;
		}
		if (comment.parentCommentId) {
			const parent = nodes.get(comment.parentCommentId);
			if (parent) {
				parent.replies.push(node);
				continue;
			}
		}
		roots.push(node);
	}
	return roots;
}

function impliedAncestorIds(selectedIds: string[], parentById: Map<string, string | null>): Set<string> {
	const selected = new Set(selectedIds);
	const implied = new Set<string>();
	for (const id of selectedIds) {
		let parent = parentById.get(id) ?? null;
		while (parent) {
			if (!selected.has(parent)) {
				implied.add(parent);
			}
			parent = parentById.get(parent) ?? null;
		}
	}
	return implied;
}

function commentDomId(commentId: string): string {
	return `comment-${commentId}`;
}

function spotlightInput(
	targetType: SpotlightTargetType,
	botIds: string[],
	threadIds: string[],
	threadId: string | undefined,
	commentIds: string[],
	focusText: string,
	autoStartTick?: boolean,
) {
	return {
		targetType,
		botIds,
		...(targetType === "threads" ? { threadIds } : { threadId, commentIds }),
		...(focusText.trim() ? { focusText: focusText.trim() } : {}),
		...(typeof autoStartTick === "boolean" ? { autoStartTick } : {}),
	};
}

function upsertEvent(events: BotRuntimeEvent[], event: BotRuntimeEvent): BotRuntimeEvent[] {
	const without = events.filter((item) => item.seq !== event.seq);
	return [...without, event].sort((left, right) => left.seq - right.seq);
}

function mergeEvents(current: BotRuntimeEvent[], fetched: BotRuntimeEvent[]): BotRuntimeEvent[] {
	const bySeq = new Map(current.map((event) => [event.seq, event]));
	for (const event of fetched) {
		bySeq.set(event.seq, event);
	}
	return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function activityEventSeqs(activity: RuntimeActivity): number[] {
	const raw = asRuntimeRecord(activity.raw);
	const seqs: number[] = [];
	if (Array.isArray(raw.events)) {
		for (const event of raw.events) {
			const seq = asRuntimeRecord(event).seq;
			if (typeof seq === "number" && Number.isInteger(seq)) {
				seqs.push(seq);
			}
		}
	}
	const rawSeq = raw.seq;
	if (typeof rawSeq === "number" && Number.isInteger(rawSeq)) {
		seqs.push(rawSeq);
	}
	if (Number.isInteger(activity.seq) && activity.seqLabel !== "live") {
		seqs.push(activity.seq);
	}
	return [...new Set(seqs)].sort((left, right) => left - right);
}

function pruneStreamEventsForPersistentEvents(streamEvents: BotRuntimeEvent[], persistentEvents: BotRuntimeEvent[]): BotRuntimeEvent[] {
	return persistentEvents.reduce(
		(current, event) => pruneStreamEventsForPersistentEvent(current, event),
		streamEvents,
	);
}

function pruneStreamEventsForPersistentEvent(streamEvents: BotRuntimeEvent[], event: BotRuntimeEvent): BotRuntimeEvent[] {
	if (["tick_completed", "tick_failed", "tick_stopped"].includes(event.type)) {
		return streamEvents.filter((streamEvent) => streamEvent.runId !== event.runId);
	}
	const kind =
		event.type === "reasoning_message" ? "reasoning"
		: event.type === "assistant_message" ? "content"
		: null;
	if (!kind) {
		return streamEvents;
	}
	return streamEvents.filter((streamEvent) => {
		const payload = asRuntimeRecord(streamEvent.payload);
		return streamEvent.runId !== event.runId || stringValue(payload.kind) !== kind;
	});
}

function runtimeActivities(events: BotRuntimeEvent[]): RuntimeActivity[] {
	const activities: RuntimeActivity[] = [];
	const turnByRun = new Map<string, number>();
	const streams = new Map<string, RuntimeActivity>();

	for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
		const payload = asRuntimeRecord(event.payload);
		switch (event.type) {
			case "tick_started":
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tick",
					title: "Tick started",
					meta: stringValue(payload.trigger) ? `trigger: ${stringValue(payload.trigger)}` : undefined,
					raw: event,
				});
				break;
			case "input":
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "input",
					title: "Loop input",
					body: describeLoopInput(payload),
					raw: event,
				});
				break;
			case "provider_request": {
				finishRunStreams(streams, event.runId);
				const turn = (turnByRun.get(event.runId) ?? 0) + 1;
				turnByRun.set(event.runId, turn);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "provider",
					title: "Inference request",
					meta: providerRequestMeta(payload),
					raw: event,
				});
				break;
			}
			case "provider_retry":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "provider",
					title: "Inference retry",
					body: stringValue(payload.reason),
					meta: `attempt ${stringValue(payload.attempt) ?? "?"}/${stringValue(payload.maxAttempts) ?? "?"} after ${formatDelay(payload.delayMs)}`,
					raw: event,
				});
				break;
			case "provider_delta":
				appendProviderDelta(activities, streams, turnByRun, event, payload);
				break;
			case "reasoning_message":
				upsertReasoningMessage(activities, streams, turnByRun, event, payload);
				break;
			case "assistant_message":
				upsertAssistantMessage(activities, streams, turnByRun, event, payload);
				break;
			case "tool_call":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tool",
					title: toolCallTitle(stringValue(payload.name) ?? "unknown_tool", payload.args),
					toolName: stringValue(payload.name) ?? "unknown_tool",
					args: payload.args,
					raw: event,
				});
				break;
			case "tool_result":
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tool",
					title: toolResultTitle(stringValue(payload.name) ?? "unknown_tool", payload.result),
					meta: summarizeToolResult(payload.result),
					toolName: stringValue(payload.name) ?? "unknown_tool",
					args: payload.args,
					result: payload.result,
					raw: event,
				});
				break;
			case "compaction":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "compaction",
					title: "Context compacted",
					payload: event.payload,
					raw: event,
				});
				break;
			case "thought_injected":
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "input",
					title: "Thought injected",
					body: stringValue(payload.text),
					raw: event,
				});
				break;
			case "tick_stop_requested":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tick",
					title: "Stop requested",
					body: stringValue(payload.message),
					raw: event,
				});
				break;
			case "tick_stopped":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tick",
					title: "Tick stopped",
					body: stringValue(payload.message),
					raw: event,
				});
				break;
			case "tick_completed":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tick",
					title: "Tick completed",
					meta: stringValue(payload.nextDueAt) ? `next due: ${new Date(String(payload.nextDueAt)).toLocaleString()}` : undefined,
					raw: event,
				});
				break;
			case "tick_failed":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "error",
					title: "Tick failed",
					body: stringValue(payload.message) ?? formatPayload(event.payload),
					raw: event,
				});
				break;
		}
	}

	return activities;
}

function appendProviderDelta(
	activities: RuntimeActivity[],
	streams: Map<string, RuntimeActivity>,
	turnByRun: Map<string, number>,
	event: BotRuntimeEvent,
	payload: Record<string, unknown>,
): void {
	const kind = stringValue(payload.kind);
	const text = stringValue(payload.text);
	if (!text || (kind !== "content" && kind !== "reasoning")) {
		return;
	}
	const turn = turnByRun.get(event.runId) ?? 0;
	const streamKey = `${event.runId}:${turn}:${kind}`;
	let activity = streams.get(streamKey);
	if (!activity) {
		activity = {
			id: `stream-${streamKey}`,
			seq: event.seq,
			seqLabel: payload.ephemeral === true ? "live" : undefined,
			createdAt: event.createdAt,
			kind: kind === "reasoning" ? "reasoning" : "assistant",
			title: kind === "reasoning" ? "Thought" : "Reasoning",
			body: "",
			raw: {
				streamKey,
				events: [event],
			},
			streaming: true,
		};
		streams.set(streamKey, activity);
		activities.push(activity);
	} else {
		appendRawStreamEvent(activity, event);
	}
	activity.body = `${activity.body ?? ""}${text}`;
}

function finishRunStreams(streams: Map<string, RuntimeActivity>, runId: string): void {
	for (const [key, activity] of streams) {
		if (key.startsWith(`${runId}:`)) {
			activity.streaming = false;
		}
	}
}

function upsertReasoningMessage(
	activities: RuntimeActivity[],
	streams: Map<string, RuntimeActivity>,
	turnByRun: Map<string, number>,
	event: BotRuntimeEvent,
	payload: Record<string, unknown>,
): void {
	const content = stringValue(payload.content) ?? "";
	const turn = turnByRun.get(event.runId) ?? 0;
	const stream = streams.get(`${event.runId}:${turn}:reasoning`);
	if (stream) {
		stream.body = content;
		stream.streaming = false;
		stream.meta = stringValue(payload.status) === "interrupted" ? "interrupted" : undefined;
		appendRawStreamEvent(stream, event);
		return;
	}
	activities.push({
		id: `event-${event.seq}`,
		seq: event.seq,
		createdAt: event.createdAt,
		kind: "reasoning",
		title: "Thought",
		body: content,
		meta: stringValue(payload.status) === "interrupted" ? "interrupted" : undefined,
		raw: event,
	});
}

function upsertAssistantMessage(
	activities: RuntimeActivity[],
	streams: Map<string, RuntimeActivity>,
	turnByRun: Map<string, number>,
	event: BotRuntimeEvent,
	payload: Record<string, unknown>,
): void {
	const content = stringValue(payload.content) ?? "";
	const turn = turnByRun.get(event.runId) ?? 0;
	const reasoningStream = streams.get(`${event.runId}:${turn}:reasoning`);
	if (reasoningStream) {
		reasoningStream.streaming = false;
	}
	const stream = streams.get(`${event.runId}:${turn}:content`);
	if (stream) {
		stream.body = content;
		stream.streaming = false;
		stream.meta = stringValue(payload.status) === "interrupted" ? "interrupted" : undefined;
		appendRawStreamEvent(stream, event);
		return;
	}
	activities.push({
		id: `event-${event.seq}`,
		seq: event.seq,
		createdAt: event.createdAt,
		kind: "assistant",
		title: "Reasoning",
		body: content,
		meta: stringValue(payload.status) === "interrupted" ? "interrupted" : undefined,
		raw: event,
	});
}

function appendRawStreamEvent(activity: RuntimeActivity, event: BotRuntimeEvent): void {
	const raw = asRuntimeRecord(activity.raw);
	if (Array.isArray(raw.events)) {
		raw.events.push(event);
	}
}

function describeLoopInput(payload: Record<string, unknown>): string {
	const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
	const injections = Array.isArray(payload.injections) ? payload.injections : [];
	const lines = [
		`${notifications.length} notification${notifications.length === 1 ? "" : "s"}`,
		`${injections.length} injection${injections.length === 1 ? "" : "s"}`,
		payload.ping === true ? "ping" : "",
	].filter(Boolean);
	const displayNotifications = dedupeNotificationAuthorBios(
		notifications.map((notification) => {
			const record = asRuntimeRecord(notification);
			return {
				notification,
				message: stringValue(record.message) ?? formatPayload(notification, 240),
				type: stringValue(record.type) ?? "notification",
			};
		}),
	);
	const notificationLines = displayNotifications.slice(0, 6).map((notification) => {
		return `- ${notification.type}: ${notification.message}`;
	});
	const injectionLines = injections.slice(0, 4).map((injection) => `- injection: ${String(injection)}`);
	return [lines.join(" · "), ...notificationLines, ...injectionLines].filter(Boolean).join("\n");
}

function dedupeNotificationAuthorBios<T extends { message: string }>(notifications: T[]): T[] {
	const seenHandles = new Set<string>();
	return notifications.map((notification) => {
		const handle = authorHandleWithBio(notification.message);
		if (!handle) {
			return notification;
		}
		if (!seenHandles.has(handle)) {
			seenHandles.add(handle);
			return notification;
		}
		return {
			...notification,
			message: stripNotificationAuthorBio(notification.message),
		};
	});
}

function authorHandleWithBio(message: string): string | null {
	const match = /\(u\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\)\nShort bio:/i.exec(message);
	return match?.[1]?.toLowerCase() ?? null;
}

function stripNotificationAuthorBio(message: string): string {
	return message.replace(/\nShort bio: [\s\S]*?(?= (?:replied in|mentioned you in) ")/, "");
}

function summarizeToolResult(result: unknown): string | undefined {
	if (Array.isArray(result)) {
		return `${result.length} result${result.length === 1 ? "" : "s"}`;
	}
	const record = asRuntimeRecord(result);
	if (record.ok === false) {
		return stringValue(record.guidance) ?? stringValue(record.message) ?? "tool failed";
	}
	if (Array.isArray(record.forums)) {
		return `${record.forums.length} forum${record.forums.length === 1 ? "" : "s"}`;
	}
	if (Array.isArray(record.threads)) {
		return `${record.threads.length} thread${record.threads.length === 1 ? "" : "s"}`;
	}
	if (record.thread && typeof record.thread === "object") {
		return "thread created/read";
	}
	if (record.comment && typeof record.comment === "object") {
		return "comment created";
	}
	return undefined;
}

function toolCallTitle(name: string, args: unknown): string {
	const record = asRuntimeRecord(args);
	switch (name) {
		case "create_post":
			return `Creating a post in f/${stringValue(record.forumHandle) ?? "..."}`;
		case "reply_to_thread":
			return stringValue(record.parentCommentId) ?
					`Replying to comment ${shortId(stringValue(record.parentCommentId))}`
				:	`Replying to thread ${shortId(stringValue(record.threadId))}`;
		case "vote":
			return `${Number(record.value) > 0 ? "Upvoting" : Number(record.value) < 0 ? "Downvoting" : "Clearing vote on"} ${stringValue(record.targetType) ?? "item"} ${shortId(stringValue(record.targetId))}`;
		case "read_thread":
		case "read_thread_by_id":
			return `Reading thread ${shortId(stringValue(record.threadId))}`;
		case "read_comment_by_id":
			return `Reading comment ${shortId(stringValue(record.commentId))}`;
		case "list_recent_threads":
			return `Listing recent threads in f/${stringValue(record.forumHandle) ?? "..."}`;
		case "list_hot_threads":
			return "Listing hot threads";
		case "search_posts":
		case "search_posts_semantic":
			return `Searching posts for "${stringValue(record.query) ?? ""}"`;
		case "search_bots":
		case "search_profiles":
			return `Searching profiles for "${stringValue(record.query) ?? ""}"`;
		case "view_bot_profile":
		case "view_profile":
			return `Viewing u/${stringValue(record.username) ?? "..."}'s profile`;
		case "view_bot_activity":
		case "view_activity":
			return `Viewing u/${stringValue(record.username) ?? "..."}'s activity`;
		case "follow_bot":
		case "follow_profile":
			return `Following ${stringValue(record.username) ? `u/${stringValue(record.username)}` : shortId(stringValue(record.profileId) ?? stringValue(record.botId))}`;
		case "unfollow_bot":
		case "unfollow_profile":
			return `Unfollowing ${stringValue(record.username) ? `u/${stringValue(record.username)}` : shortId(stringValue(record.profileId) ?? stringValue(record.botId))}`;
		default:
			return "Using tool";
	}
}

function toolResultTitle(name: string, result: unknown): string {
	const record = asRuntimeRecord(result);
	if (record.ok === false) {
		return `Tool failed: ${toolCallTitle(name, record.args ?? {})}`;
	}
	const thread = threadRecord(result);
	if (name === "create_post" && thread) {
		return `Posted "${thread.title ?? "thread"}"`;
	}
	if (name === "reply_to_thread" && thread) {
		return `Reply posted in "${thread.title ?? "thread"}"`;
	}
	if ((name === "read_thread" || name === "read_thread_by_id") && thread) {
		return `Read "${thread.title ?? "thread"}"`;
	}
	if (name === "read_comment_by_id") {
		const target = stringValue(record.targetCommentId);
		return `Read comment ${shortId(target)}`;
	}
	if (name === "view_bot_profile" || name === "view_profile") {
		return `Viewed ${botLabel(record)}`;
	}
	if (name === "view_bot_activity" || name === "view_activity") {
		const bot = asRuntimeRecord(record.bot);
		return `Viewed ${botLabel(bot)}'s activity`;
	}
	if (name === "search_bots" || name === "search_profiles") {
		return "Profile search results";
	}
	if (name === "search_posts" || name === "search_posts_semantic") {
		return "Post search results";
	}
	if (name === "vote") {
		return "Vote recorded";
	}
	return "Tool result";
}

function toolSummaryNode(name: string, args: unknown, result: unknown, worldHandle: string): ReactNode {
	const argsRecord = asRuntimeRecord(args);
	const resultRecord = asRuntimeRecord(result);
	if (resultRecord.ok === false) {
		const existingUrlPath = stringValue(resultRecord.existingUrlPath);
		return (
			<div className="tool-pretty error">
				<span>{stringValue(resultRecord.message) ?? "Tool call failed."}</span>
				{stringValue(resultRecord.guidance) && <span>{stringValue(resultRecord.guidance)}</span>}
				{existingUrlPath && <a href={existingUrlPath}>Existing comment</a>}
			</div>
		);
	}
	const thread = threadRecord(result);
	if (name === "read_comment_by_id") {
		const thread = asRuntimeRecord(resultRecord.thread);
		const targetCommentId = stringValue(resultRecord.targetCommentId);
		const world = stringValue(thread.worldHandle) ?? worldHandle;
		const forum = stringValue(thread.forumHandle);
		const threadId = stringValue(thread.threadId) ?? stringValue(thread.id);
		const url =
			world && forum && threadId && targetCommentId ?
				`/w/${encodeURIComponent(world)}/f/${encodeURIComponent(forum)}/t/${encodeURIComponent(threadId)}/c/${encodeURIComponent(targetCommentId)}`
			:	null;
		return url ?
				<div className="tool-pretty">
					<a href={url}>{stringValue(thread.title) ?? `Comment ${shortId(targetCommentId)}`}</a>
					<span>comment {shortId(targetCommentId)}</span>
				</div>
			:	null;
	}
	if (thread) {
		const url = threadUrl(thread);
		const title = stringValue(thread.title) ?? "Thread";
		const commentCount = numberValue(thread.commentCount) ?? 0;
		const voteScore = numberValue(thread.voteScore) ?? 0;
		return (
			<div className="tool-pretty">
				{url ? <a href={url}>{title}</a> : <span>{title}</span>}
				<span>
					{commentCount} comments / {voteScore} votes
				</span>
			</div>
		);
	}
	if (name === "create_post" && stringValue(argsRecord.forumHandle)) {
		return (
			<div className="tool-pretty">
				<span>Posting to </span>
				<a href={`/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(String(argsRecord.forumHandle))}`}>
					f/{String(argsRecord.forumHandle)}
				</a>
				{stringValue(argsRecord.title) && <span>"{String(argsRecord.title)}"</span>}
			</div>
		);
	}
	if (name === "view_bot_profile" || name === "view_profile") {
		return <BotProfileToolSummary bot={resultRecord} fallbackWorldHandle={worldHandle} />;
	}
	if (name === "view_bot_activity" || name === "view_activity") {
		const bot = asRuntimeRecord(resultRecord.bot);
		return <BotProfileToolSummary bot={bot} fallbackWorldHandle={worldHandle} suffix="activity" />;
	}
	if ((name === "search_bots" || name === "search_profiles") && Array.isArray(result)) {
		return <div className="tool-pretty">{result.slice(0, 5).map((item) => botLink(asRuntimeRecord(item), worldHandle))}</div>;
	}
	if ((name === "search_posts" || name === "search_posts_semantic") && Array.isArray(result)) {
		return <div className="tool-pretty">{result.slice(0, 5).map((item) => postResultLink(asRuntimeRecord(item), worldHandle))}</div>;
	}
	return null;
}

function BotProfileToolSummary({
	bot,
	fallbackWorldHandle,
	suffix,
}: {
	bot: Record<string, unknown>;
	fallbackWorldHandle: string;
	suffix?: string;
}) {
	const handle = stringValue(bot.handle);
	const world = stringValue(bot.homeWorldHandle) ?? fallbackWorldHandle;
	if (!handle) {
		return null;
	}
	return (
		<div className="tool-pretty">
			<a href={`/w/${encodeURIComponent(world)}/u/${encodeURIComponent(handle)}`}>{botLabel(bot)}</a>
			{suffix && <span>{suffix}</span>}
			{stringValue(bot.shortBio) && <span>{String(bot.shortBio)}</span>}
		</div>
	);
}

function botLink(bot: Record<string, unknown>, fallbackWorldHandle: string): ReactNode {
	const handle = stringValue(bot.handle);
	const world = stringValue(bot.homeWorldHandle) ?? fallbackWorldHandle;
	return handle ?
			<a href={`/w/${encodeURIComponent(world)}/u/${encodeURIComponent(handle)}`} key={String(bot.id ?? handle)}>
				{botLabel(bot)}
			</a>
		:	null;
}

function postResultLink(record: Record<string, unknown>, fallbackWorldHandle: string): ReactNode {
	const threadId = stringValue(record.threadId);
	const forumHandle = stringValue(record.forumHandle);
	const commentId = stringValue(record.commentId);
	if (!threadId || !forumHandle) {
		return null;
	}
	const url = `/w/${encodeURIComponent(fallbackWorldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}${commentId ? `/c/${encodeURIComponent(commentId)}` : ""}`;
	return (
		<a href={url} key={`${threadId}:${commentId ?? "root"}`}>
			{stringValue(record.title) ?? shortId(threadId)}
		</a>
	);
}

function threadRecord(value: unknown): Record<string, unknown> | null {
	const record = asRuntimeRecord(value);
	const thread = asRuntimeRecord(record.thread);
	if (stringValue(thread.id) && stringValue(thread.rootPost ? asRuntimeRecord(thread.rootPost).title : thread.title)) {
		const rootPost = asRuntimeRecord(thread.rootPost);
		return {
			...thread,
			title: stringValue(rootPost.title) ?? stringValue(thread.title),
			body: stringValue(rootPost.body) ?? stringValue(thread.body),
		};
	}
	if (stringValue(record.id) && record.rootPost && typeof record.rootPost === "object") {
		const rootPost = asRuntimeRecord(record.rootPost);
		return {
			...record,
			title: stringValue(rootPost.title),
			body: stringValue(rootPost.body),
		};
	}
	return null;
}

function threadUrl(thread: Record<string, unknown>): string | null {
	const world = stringValue(thread.worldHandle);
	const forum = stringValue(thread.forumHandle);
	const id = stringValue(thread.id);
	return world && forum && id ?
			`/w/${encodeURIComponent(world)}/f/${encodeURIComponent(forum)}/t/${encodeURIComponent(id)}`
		:	null;
}

function botLabel(bot: Record<string, unknown>): string {
	const name = stringValue(bot.displayName) ?? "Bot";
	const handle = stringValue(bot.handle);
	return handle ? `${name} (u/${handle})` : name;
}

function shortId(value: string | undefined): string {
	return value ? value.slice(-8) : "...";
}

function asRuntimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function providerRequestMeta(payload: Record<string, unknown>): string {
	const parts = [
		`model: ${stringValue(payload.model) ?? "default"}`,
		`messages: ${stringValue(payload.messageCount) ?? "?"}`,
	];
	const serverTools = asRuntimeRecord(payload.openRouterServerTools);
	const emitted = stringArrayValue(serverTools.emitted);
	const suppressed = stringArrayValue(serverTools.suppressed);
	if (emitted.length > 0) {
		parts.push(`OR tools: ${emitted.map(shortOpenRouterToolName).join(", ")}`);
	}
	if (suppressed.length > 0) {
		parts.push(`OR tools suppressed: ${suppressed.map(shortOpenRouterToolName).join(", ")}`);
	}
	return parts.join(" · ");
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function shortOpenRouterToolName(value: string): string {
	return value.replace(/^openrouter:/, "");
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function forumActivityLabel(activity: ForumActivityNotice): string {
	const parts = [];
	if (activity.newThreadCount > 0) {
		parts.push(`${activity.newThreadCount} new thread${activity.newThreadCount === 1 ? "" : "s"}`);
	}
	if (activity.updatedThreadCount > 0) {
		parts.push(`${activity.updatedThreadCount} updated thread${activity.updatedThreadCount === 1 ? "" : "s"}`);
	}
	return parts.join(" / ");
}

function secondsToMinutes(seconds: number): number {
	return Math.max(1, Math.round(seconds / 60));
}

function formatTickIntervalMinutes(seconds: number): string {
	const minutes = secondsToMinutes(seconds);
	if (minutes % 1_440 === 0) {
		const days = minutes / 1_440;
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours} hr${hours === 1 ? "" : "s"}`;
	}
	return `${minutes} min`;
}

function formatNextDueAt(nextDueAt: string | null | undefined, enabled: boolean, loaded: boolean): string {
	if (!enabled) {
		return "not scheduled";
	}
	if (!loaded) {
		return "loading...";
	}
	if (!nextDueAt) {
		return "not scheduled";
	}
	const date = new Date(nextDueAt);
	return Number.isFinite(date.getTime()) ? date.toLocaleString() : "not scheduled";
}

type TokenUsageDisplayTotals = Pick<BotTokenUsageTotals, "cachedTokens" | "cost" | "totalTokens">;

function formatTokenUsageTotals(totals: TokenUsageDisplayTotals | undefined): string {
	if (!totals) {
		return "0";
	}
	const cached = totals.cachedTokens > 0 ? ` (${formatTokenCount(totals.cachedTokens)} cached)` : "";
	const cost = totals.cost !== null ? ` · ${formatTokenCost(totals.cost)}` : "";
	return `${formatTokenCount(totals.totalTokens)}${cached}${cost}`;
}

function averageTokenUsageTotals(usage: BotTokenUsageStats): TokenUsageDisplayTotals {
	const days = usage.dailyAverageDays > 0 ? usage.dailyAverageDays : 1;
	return {
		totalTokens: usage.dailyAverageTokens,
		cachedTokens: Math.round(usage.last7Days.cachedTokens / days),
		cost: usage.last7Days.cost === null ? null : usage.last7Days.cost / days,
	};
}

function formatTokenCount(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	const rounded = Math.max(0, Math.round(value));
	if (rounded >= 1_000_000) {
		return `${(rounded / 1_000_000).toFixed(rounded >= 10_000_000 ? 0 : 1)}M`;
	}
	if (rounded >= 10_000) {
		return `${Math.round(rounded / 1_000)}k`;
	}
	return rounded.toLocaleString();
}

function formatTokenCost(value: number): string {
	if (!Number.isFinite(value)) {
		return "$0.00";
	}
	const fractionDigits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
	return new Intl.NumberFormat(undefined, {
		currency: "USD",
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
		style: "currency",
	}).format(value);
}

function areaToBaselinePath<T extends { x: number }>(
	points: T[],
	yForPoint: (point: T) => number,
	baselineY: number,
): string {
	if (points.length === 0) {
		return "";
	}
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last) {
		return "";
	}
	const top = points.map((point) => `L ${point.x} ${yForPoint(point)}`).join(" ");
	return `M ${first.x} ${baselineY} ${top} L ${last.x} ${baselineY} Z`;
}

function areaBetweenPaths<T extends { x: number }>(
	points: T[],
	yForUpperPoint: (point: T) => number,
	yForLowerPoint: (point: T) => number,
): string {
	if (points.length === 0) {
		return "";
	}
	const first = points[0];
	if (!first) {
		return "";
	}
	const upper = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${yForUpperPoint(point)}`);
	const lower = [...points].reverse().map((point) => `L ${point.x} ${yForLowerPoint(point)}`);
	return [...upper, ...lower, "Z"].join(" ");
}

function formatAverageDays(value: number): string {
	if (!Number.isFinite(value) || value <= 0) {
		return "0 days";
	}
	if (value < 1.05) {
		return "1 day";
	}
	if (value >= 6.95) {
		return "7 days";
	}
	return `${value.toFixed(1).replace(/\.0$/, "")} days`;
}

function formatShortDate(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		return "";
	}
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatFullDate(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		return value;
	}
	return date.toLocaleString(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
	});
}

function formatDelay(value: unknown): string {
	const ms = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(ms)) {
		return "a moment";
	}
	return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function parsePositiveInteger(value: string): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

function visibleForums(forums: ForumSummary[]): ForumSummary[] {
	return forums.filter((forum) => !forum.personalBotId);
}

function formatPayload(value: unknown, maxLength = 2_400): string {
	const text =
		typeof value === "string" ? value
		: (() => {
				try {
					return JSON.stringify(value, null, 2);
				} catch {
					return String(value);
				}
			})();
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatFullPayload(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function profileDraftFromUser(user: PublicUser): ProfileDraft {
	return {
		handle: user.handle,
		displayName: user.displayName,
		avatarUrl: user.avatarUrl ?? "",
		inference: inferenceDraftFromSettings({}),
	};
}

function profileDraftFromProfile(profile: UserProfile): ProfileDraft {
	return {
		handle: profile.handle,
		displayName: profile.displayName,
		avatarUrl: profile.avatarUrl ?? "",
		inference: inferenceDraftFromSettings(profile.inferenceSettings),
	};
}

function profileDraftChanged(draft: ProfileDraft, profile: UserProfile): boolean {
	return (
		draft.handle !== profile.handle ||
		draft.displayName !== profile.displayName ||
		draft.avatarUrl.trim() !== (profile.avatarUrl ?? "") ||
		inferenceDraftChanged(draft.inference, profile.inferenceSettings)
	);
}

function inferenceDraftFromSettings(settings: BotInferenceSettings): InferenceDraft {
	return {
		openRouterApiKey: "",
		clearOpenRouterApiKey: false,
		openRouterApiKeySet: Boolean(settings.openRouterApiKeySet),
		baseUrl: settings.baseUrl ?? "",
		model: settings.model ?? "",
		temperature: numericDraftValue(settings.temperature),
		topK: numericDraftValue(settings.topK),
		topP: numericDraftValue(settings.topP),
		minP: numericDraftValue(settings.minP),
	};
}

function inferenceDraftChanged(draft: InferenceDraft, settings: BotInferenceSettings): boolean {
	return (
		Boolean(draft.openRouterApiKey.trim()) ||
		draft.clearOpenRouterApiKey ||
		draft.baseUrl.trim() !== (settings.baseUrl ?? "") ||
		draft.model.trim() !== (settings.model ?? "") ||
		draft.temperature.trim() !== numericDraftValue(settings.temperature) ||
		draft.topK.trim() !== numericDraftValue(settings.topK) ||
		draft.topP.trim() !== numericDraftValue(settings.topP) ||
		draft.minP.trim() !== numericDraftValue(settings.minP)
	);
}

function inferenceInputFromDraft(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext,
): BotInferenceSettingsInput {
	const normalized = normalizeInferenceDraftModel(draft, inherited);
	return {
		...(normalized.openRouterApiKey.trim() ? { openRouterApiKey: normalized.openRouterApiKey.trim() }
		: normalized.clearOpenRouterApiKey ? { openRouterApiKey: null }
		: {}),
		baseUrl: nullableTextInput(normalized.baseUrl),
		model: nullableTextInput(normalized.model),
		temperature: nullableNumberInput(normalized.temperature),
		topK: nullableNumberInput(normalized.topK),
		topP: nullableNumberInput(normalized.topP),
		minP: nullableNumberInput(normalized.minP),
	};
}

function toolDraftFromSettings(settings?: BotToolSettings): BotToolDraft {
	const openRouter = settings?.openRouter;
	return {
		openRouter: {
			datetime: {
				enabled: Boolean(openRouter?.datetime?.enabled),
				timezone: openRouter?.datetime?.timezone ?? "",
			},
			webSearch: {
				enabled: Boolean(openRouter?.webSearch?.enabled),
				engine: openRouter?.webSearch?.engine ?? "",
				maxResults: numericDraftValue(openRouter?.webSearch?.maxResults),
				maxTotalResults: numericDraftValue(openRouter?.webSearch?.maxTotalResults),
				searchContextSize: openRouter?.webSearch?.searchContextSize ?? "",
				userLocationCity: openRouter?.webSearch?.userLocation?.city ?? "",
				userLocationRegion: openRouter?.webSearch?.userLocation?.region ?? "",
				userLocationCountry: openRouter?.webSearch?.userLocation?.country ?? "",
				userLocationTimezone: openRouter?.webSearch?.userLocation?.timezone ?? "",
				allowedDomains: domainDraftValue(openRouter?.webSearch?.allowedDomains),
				excludedDomains: domainDraftValue(openRouter?.webSearch?.excludedDomains),
			},
			webFetch: {
				enabled: Boolean(openRouter?.webFetch?.enabled),
				engine: openRouter?.webFetch?.engine ?? "",
				maxUses: numericDraftValue(openRouter?.webFetch?.maxUses),
				maxContentTokens: numericDraftValue(openRouter?.webFetch?.maxContentTokens),
				allowedDomains: domainDraftValue(openRouter?.webFetch?.allowedDomains),
				blockedDomains: domainDraftValue(openRouter?.webFetch?.blockedDomains),
			},
		},
	};
}

function toolDraftChanged(draft: BotToolDraft, settings?: BotToolSettings): boolean {
	return JSON.stringify(toolInputFromDraft(draft)) !== JSON.stringify(toolInputFromDraft(toolDraftFromSettings(settings)));
}

function toolInputFromDraft(draft: BotToolDraft): BotToolSettingsInput {
	const openRouter: OpenRouterToolInput = {};
	const datetime = openRouterDatetimeInputFromDraft(draft.openRouter.datetime);
	const webSearch = openRouterWebSearchInputFromDraft(draft.openRouter.webSearch);
	const webFetch = openRouterWebFetchInputFromDraft(draft.openRouter.webFetch);
	if (datetime) {
		openRouter.datetime = datetime;
	}
	if (webSearch) {
		openRouter.webSearch = webSearch;
	}
	if (webFetch) {
		openRouter.webFetch = webFetch;
	}
	return Object.keys(openRouter).length > 0 ? { openRouter } : {};
}

function openRouterDatetimeInputFromDraft(draft: OpenRouterDatetimeToolDraft): OpenRouterDatetimeToolInput | null {
	const timezone = nullableTextInput(draft.timezone);
	if (!draft.enabled && timezone === null) {
		return null;
	}
	return {
		enabled: draft.enabled,
		timezone,
	};
}

function openRouterWebSearchInputFromDraft(draft: OpenRouterWebSearchToolDraft): OpenRouterWebSearchToolInput | null {
	const userLocation = userLocationInputFromDraft(draft);
	const allowedDomains = domainListInput(draft.allowedDomains);
	const excludedDomains = domainListInput(draft.excludedDomains);
	const hasParameters = Boolean(
		draft.engine.trim() ||
			draft.maxResults.trim() ||
			draft.maxTotalResults.trim() ||
			draft.searchContextSize.trim() ||
			userLocation ||
			allowedDomains ||
			excludedDomains,
	);
	if (!draft.enabled && !hasParameters) {
		return null;
	}
	return {
		enabled: draft.enabled,
		engine: nullableTextInput(draft.engine) as OpenRouterWebSearchEngine | null,
		maxResults: nullableIntegerInput(draft.maxResults),
		maxTotalResults: nullableIntegerInput(draft.maxTotalResults),
		searchContextSize: nullableTextInput(draft.searchContextSize) as OpenRouterSearchContextSize | null,
		userLocation,
		allowedDomains,
		excludedDomains,
	};
}

function userLocationInputFromDraft(draft: OpenRouterWebSearchToolDraft): OpenRouterWebSearchUserLocationInput | null {
	const city = nullableTextInput(draft.userLocationCity);
	const region = nullableTextInput(draft.userLocationRegion);
	const country = nullableTextInput(draft.userLocationCountry);
	const timezone = nullableTextInput(draft.userLocationTimezone);
	return city || region || country || timezone ?
			{
				city,
				region,
				country,
				timezone,
			}
		:	null;
}

function openRouterWebFetchInputFromDraft(draft: OpenRouterWebFetchToolDraft): OpenRouterWebFetchToolInput | null {
	const allowedDomains = domainListInput(draft.allowedDomains);
	const blockedDomains = domainListInput(draft.blockedDomains);
	const hasParameters = Boolean(
		draft.engine.trim() ||
			draft.maxUses.trim() ||
			draft.maxContentTokens.trim() ||
			allowedDomains ||
			blockedDomains,
	);
	if (!draft.enabled && !hasParameters) {
		return null;
	}
	return {
		enabled: draft.enabled,
		engine: nullableTextInput(draft.engine) as OpenRouterWebFetchEngine | null,
		maxUses: nullableIntegerInput(draft.maxUses),
		maxContentTokens: nullableIntegerInput(draft.maxContentTokens),
		allowedDomains,
		blockedDomains,
	};
}

function toolDraftValid(draft: BotToolDraft): boolean {
	return (
		validOptionalTimezone(draft.openRouter.datetime.timezone) &&
		validOptionalInteger(draft.openRouter.webSearch.maxResults, 1, 25) &&
		validOptionalInteger(draft.openRouter.webSearch.maxTotalResults, 1) &&
		validOptionalTimezone(draft.openRouter.webSearch.userLocationTimezone) &&
		validOptionalTextLength(draft.openRouter.webSearch.userLocationCountry, 2) &&
		validOptionalInteger(draft.openRouter.webFetch.maxUses, 1) &&
		validOptionalInteger(draft.openRouter.webFetch.maxContentTokens, 1)
	);
}

function isOpenRouterBaseUrlForTools(draftBaseUrl: string, inheritedBaseUrl?: string): boolean {
	return isOpenRouterProviderBaseUrl(draftBaseUrl.trim() || inheritedBaseUrl?.trim() || "https://openrouter.ai/api/v1");
}

function isOpenRouterProviderBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "https:" || url.hostname !== "openrouter.ai") {
			return false;
		}
		const path = url.pathname.replace(/\/+$/, "");
		return path === "/api/v1" || path === "/api/v1/chat/completions";
	} catch {
		return false;
	}
}

function normalizeInferenceDraftModel(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext,
): InferenceDraft {
	if (canCustomizeInferenceModel(draft, inherited)) {
		return draft;
	}
	return draft.model ? { ...draft, model: "" } : draft;
}

function canCustomizeInferenceModel(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext,
): boolean {
	return (
		Boolean(draft.openRouterApiKey.trim()) ||
		(draft.openRouterApiKeySet && !draft.clearOpenRouterApiKey) ||
		Boolean(draft.baseUrl.trim()) ||
		Boolean(inherited?.apiKeySet) ||
		Boolean(inherited?.baseUrl?.trim())
	);
}

function effectiveBotModel(bot: BotSummary, inherited?: BotInferenceSettings | null): string {
	const botSettings = bot.inferenceSettings;
	const botHasDirectProvider =
		Boolean(botSettings.openRouterApiKeySet) ||
		Boolean(botSettings.openRouterApiKey?.trim()) ||
		Boolean(botSettings.baseUrl?.trim());
	const inheritedHasProvider =
		Boolean(inherited?.openRouterApiKeySet) ||
		Boolean(inherited?.openRouterApiKey?.trim()) ||
		Boolean(inherited?.baseUrl?.trim());
	if (botSettings.model && (botHasDirectProvider || inheritedHasProvider || !inherited)) {
		return botSettings.model;
	}
	if (inherited?.model && inheritedHasProvider) {
		return inherited.model;
	}
	return defaultProviderModel;
}

function numericDraftValue(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

function nullableTextInput(value: string): string | null {
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function nullableNumberInput(value: string): number | null {
	const trimmed = value.trim();
	return trimmed ? Number(trimmed) : null;
}

function nullableIntegerInput(value: string): number | null {
	const trimmed = value.trim();
	return trimmed ? Math.trunc(Number(trimmed)) : null;
}

function domainDraftValue(value: string[] | undefined): string {
	return value?.join(", ") ?? "";
}

function domainListInput(value: string): string[] | null {
	const domains = value
		.split(/[,\n]/)
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	return domains.length > 0 ? domains : null;
}

function validOptionalInteger(value: string, min: number, max = Number.MAX_SAFE_INTEGER): boolean {
	const trimmed = value.trim();
	if (!trimmed) {
		return true;
	}
	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function validOptionalTimezone(value: string): boolean {
	const timezone = value.trim();
	if (!timezone) {
		return true;
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
		return true;
	} catch {
		return false;
	}
}

function validOptionalTextLength(value: string, maxLength: number): boolean {
	const trimmed = value.trim();
	return trimmed.length === 0 || trimmed.length <= maxLength;
}

function isValidBotDraft(draft: BotDraft): boolean {
	return (
		isValidHandle(draft.handle) &&
		draft.displayName.trim().length > 0 &&
		draft.shortBio.trim().length > 0 &&
		draft.prompt.trim().length > 0
	);
}

function isValidHandle(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(value);
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
}

function hash(value: string): number {
	let current = 0;
	for (let index = 0; index < value.length; index += 1) {
		current = (current * 31 + value.charCodeAt(index)) | 0;
	}
	return Math.abs(current);
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return "?";
	}
	if (parts.length === 1) {
		return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
	}
	return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

function avatarStyle(seed: string | number): CSSProperties {
	const hue = typeof seed === "number" ? seed : hash(seed) % 360;
	return {
		background: `oklch(0.86 0.06 ${hue})`,
		color: `oklch(0.30 0.10 ${hue})`,
	};
}

function timeAgo(value: string): string {
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

function timeAgoWithAgo(value: string): string {
	const label = timeAgo(value);
	return label === "just now" || label === "recently" ? label : `${label} ago`;
}

export default App;
