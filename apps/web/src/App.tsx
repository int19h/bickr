import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AriaRole, CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
	defaultProviderModel,
	defaultTranslationPrompt,
	authProviders,
	type AuthProvider,
	type BotActivityFeed,
	type BotActivityItem,
	type BotFollowGraph,
	type BotContextBudget,
	type BotInferenceSubmissionMessage,
	type BotLoopMessage,
	type BotLoopMessageLog,
	type BotSummary,
	type BotPublicProfile,
	type BotRuntimeEvent,
	type BotRuntimeStatus,
	type BotTokenUsageStats,
	type BotTokenUsageTotals,
	type CommentDocument,
	type BotInferenceSettings,
	type BotInferenceSettingsInput,
	type ChirperImportPreview,
	type BotToolSettings,
	type CreateForumInput,
	type CreateWorldInput,
	type ForumSummary,
	type HumanNotification,
	type HumanNotificationSummary,
	type HumanSubscription,
	type HumanSubscriptionScope,
	type LinkedAuthIdentity,
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
import {
	handleHelpText,
	handlePatternSource,
	isValidHandleText,
	maxBotPromptLength,
	maxBotReasoningPrefillLength,
	normalizeHandleText,
	sanitizeHandleInput,
} from "@bickr/shared/validation";
import {
	interpolateTokenUsageChartValue,
	type TokenUsageChartPoint,
} from "./token-usage-chart";
import {
	toolInputFromDraft,
	type BotToolDraft,
	type OpenRouterDatetimeToolDraft,
	type OpenRouterWebFetchToolDraft,
	type OpenRouterWebSearchToolDraft,
} from "./tool-settings-draft";
import { prettyJsonText } from "./inference-submission-formatting";
import {
	isLiveProviderLoopMessage,
	removeLiveProviderLoopMessagesForRun,
	upsertLiveProviderLoopMessage,
} from "./loop-message-streams";
import { normalizeReadableText, reasoningDetailsTextForDisplay, textValueForDisplay } from "./reasoning-formatting";
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
	| "notifications"
	| "profile";
type WorldTab = "forums" | "bots" | "lore";
type BotProfileTab = "activity" | "follows";
type BotCreateTab = "manual" | "clone" | "chirper";
type ImportState = "idle" | "loading" | "preview" | "error";
type ThemePreference = "system" | "light" | "dark";
type NotificationGroupMode = "world" | "bot";

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
type LoopToolCall = NonNullable<BotInferenceSubmissionMessage["tool_calls"]>[number];
type LoopToolCallContext = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: unknown;
};
type JsonRecord = Record<string, unknown>;

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
	reasoningPrefill: string;
	translationModel: string;
	translationPrompt: string;
	temperature: string;
	topK: string;
	topP: string;
	minP: string;
	frequencyPenalty: string;
	presencePenalty: string;
	repetitionPenalty: string;
};

type PromptBudgetState =
	| { status: "idle" }
	| { status: "loading"; requestKey: string }
	| { status: "ready"; budget: BotContextBudget; requestKey: string }
	| { status: "error"; message: string; requestKey: string };

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

type RuntimeMonitorPayload = {
	type?: string;
	event?: BotRuntimeEvent;
	message?: string;
	loopMessage?: BotLoopMessage;
	seq?: number;
	deletedAt?: string;
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

type TranslationContextValue = {
	enabled: boolean;
	model: string;
	prompt: string;
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
	| "menu"
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
	| "google"
	| "chirper"
	| "info"
	| "upload"
	| "refresh"
	| "play"
	| "sun"
	| "moon"
	| "monitor"
	| "sparkles"
	| "translate"
	| "original"
	| "chat"
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
const TranslationContext = createContext<TranslationContextValue>({
	enabled: false,
	model: "",
	prompt: defaultTranslationPrompt,
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
	const [freshThreadRequestVersion, setFreshThreadRequestVersion] = useState(0);
	const [threadActivityCheckVersionById, setThreadActivityCheckVersionById] = useState<Record<string, number>>({});
	const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
	const [humanNotifications, setHumanNotifications] = useState<HumanNotificationSummary>({
		unreadCount: 0,
		notifications: [],
	});
	const [subscriptions, setSubscriptions] = useState<HumanSubscription[]>([]);
	const [activeTooltipId, setActiveTooltipId] = useState<string | null>(null);
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
	const translationContext = useMemo<TranslationContextValue>(() => {
		const translation = userProfile?.inferenceSettings.translation;
		const model = translation?.model?.trim() ?? "";
		return {
			enabled: model.length > 0,
			model,
			prompt: translation?.prompt?.trim() || defaultTranslationPrompt,
		};
	}, [userProfile?.inferenceSettings.translation]);
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
			if ((route === "world" || route === "bot-profile" || route === "bot-loop" || route === "bot-edit") && activeWorld) {
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
	): Promise<HumanNotificationSummary | null> {
		const params = new URLSearchParams({
			status,
			limit: String(limit),
		});
		if (offset > 0) {
			params.set("offset", String(offset));
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

	async function markHumanNotificationReadState(
		notification: HumanNotification,
		options: { removeUnread?: boolean } = { removeUnread: true },
	): Promise<string | null> {
		const result = await api(`/api/me/notifications/${encodeURIComponent(notification.id)}`, {
			method: "PATCH",
			body: { read: true },
		});
		if (!result.ok) {
			setStatus(result.message);
			return null;
		}
		const wasUnread = !notification.readAt;
		const readAt = notification.readAt ?? new Date().toISOString();
		setHumanNotifications((current) => ({
			unreadCount: Math.max(0, current.unreadCount - (wasUnread ? 1 : 0)),
			notifications:
				wasUnread && options.removeUnread !== false ?
					current.notifications.filter((item) => item.id !== notification.id)
				:	current.notifications.map((item) =>
						item.id === notification.id ? { ...item, readAt: item.readAt ?? readAt } : item,
					),
		}));
		return readAt;
	}

	async function openHumanNotification(notification: HumanNotification): Promise<void> {
		const readAt = await markHumanNotificationReadState(notification, { removeUnread: true });
		if (!readAt) {
			return;
		}
		const notificationUrl = new URL(notification.urlPath, window.location.origin);
		const parsed = parsePathname(notificationUrl.pathname, notificationUrl.search);
		if (parsed.route === "thread" && parsed.threadId) {
			requestFreshThread(parsed.threadId);
		}
		navigate(parsed);
		await loadHumanNotifications("unread");
	}

	async function markAllNotificationsRead(): Promise<boolean> {
		if (!profileReadyFor("managing notifications")) {
			return false;
		}
		const result = await api("/api/me/notifications/read-all", { method: "POST", body: {} });
		if (result.ok) {
			const readAt = new Date().toISOString();
			setHumanNotifications((current) => ({
				unreadCount: 0,
				notifications: current.notifications.map((notification) => ({
					...notification,
					readAt: notification.readAt ?? readAt,
				})),
			}));
			return true;
		} else {
			setStatus(result.message);
			return false;
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

	async function unlinkAuthIdentity(provider: AuthProvider): Promise<UserProfile | null> {
		let saved: UserProfile | null = null;
		const ok = await submit(async () => {
			const result = await api<{ profile: UserProfile }>(`/api/me/auth/identities/${provider}`, {
				method: "DELETE",
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			saved = result.data.profile;
			setUserProfile(result.data.profile);
			return `Unlinked ${authProviderLabel(provider)}.`;
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
					<TranslationContext.Provider value={translationContext}>
				<div className="shell">
				<Topbar
					activeWorldHandle={activeWorldHandle}
					busy={busy}
					bot={activeBot}
					forum={activeForum}
					onMarkAllNotificationsRead={() => void markAllNotificationsRead()}
					onNotificationOpen={(notification) => void openHumanNotification(notification)}
					onRefresh={() => void refreshCurrentRoute()}
					onRefreshNotifications={(status) => void loadHumanNotifications(status)}
					onTheme={setThemePreference}
					notifications={humanNotifications}
					route={route}
					status={status}
					themePreference={themePreference}
					thread={activeThread}
					user={session.user}
					world={activeWorld}
					worlds={worldViews}
				/>
				<Sidebar
					active={activeWorldHandle}
					unreadNotifications={humanNotifications.unreadCount}
					route={route}
					worlds={worldViews}
				/>
				<main className="main" onClick={handleMainClick}>
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
							onStartBot={(bot) => void startBot(bot)}
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
							activityCheckToken={activeThreadId ? threadActivityCheckVersionById[activeThreadId] ?? 0 : 0}
							currentUserId={session.user.id}
							forum={activeForum}
							loadedAt={activeThreadId ? threadLoadedAtById[activeThreadId] : undefined}
							loading={threadLoading}
							onDeleteComment={(thread, comment) => deleteComment(activeForum, thread, comment)}
							onDeleteThread={(thread) => deleteThread(activeForum, thread)}
							onReference={openReference}
							onRefresh={() => activeThreadId ? loadThread(activeForum, activeThreadId, { fresh: true }) : Promise.resolve(null)}
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
							onReference={openReference}
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
							onStartBot={(bot) => void startBot(bot)}
							worlds={worldViews}
						/>
					)}
					{route === "notifications" && (
						<NotificationsScreen
							onLoadNotifications={fetchHumanNotifications}
							onMarkAllRead={markAllNotificationsRead}
							onMarkRead={markHumanNotificationReadState}
							onOpenNotification={(notification) => void openHumanNotification(notification)}
						/>
					)}
					{route === "profile" && (
						<ProfileScreen
							busy={busy}
							onAuthIdentityUnlink={unlinkAuthIdentity}
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
				ownedBots={bots}
				world={createBotWorld}
			/>
					</TranslationContext.Provider>
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
					<a className="oauth-btn" href={authStartHref("github")}>
						<span className="glyph">
							<Icon name="github" size={18} />
						</span>
						<span>Continue with GitHub</span>
						<span className="arrow">
							<Icon name="chev" size={14} />
						</span>
					</a>
					<a className="oauth-btn" href={authStartHref("google")}>
						<span className="glyph">
							<Icon name="google" size={18} />
						</span>
						<span>Continue with Google</span>
						<span className="arrow">
							<Icon name="chev" size={14} />
						</span>
					</a>
					{["Apple", "Microsoft"].map((provider) => (
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

function authStartHref(provider: AuthProvider, returnTo?: string): string {
	const currentReturnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	return `/api/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo ?? (currentReturnTo || "/"))}`;
}

function authProviderLabel(provider: AuthProvider): string {
	return provider === "github" ? "GitHub" : "Google";
}

function Topbar({
	activeWorldHandle,
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
	worlds,
}: {
	activeWorldHandle: string | null;
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
	worlds: WorldView[];
}) {
	const isWorldScoped = route !== "worlds" && route !== "my-bots" && route !== "notifications" && route !== "profile";
	return (
		<header className="topbar">
			<div className="brand">
				<MobileNavigationMenu
					active={activeWorldHandle}
					route={route}
					unreadNotifications={notifications.unreadCount}
					worlds={worlds}
				/>
				<SpaLink className="brand-mark desktop-brand-mark" to={{ route: "worlds" }}>
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
					{route === "notifications" && (
						<>
							<span className="sep">/</span>
							<span className="current">Notifications</span>
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
								<span className="notification-meta">{notificationMeta(notification)}</span>
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

function FilterBox({
	label,
	onChange,
	placeholder,
	value,
}: {
	label: string;
	onChange: (value: string) => void;
	placeholder: string;
	value: string;
}) {
	return (
		<div className="list-filter">
			<Icon name="search" size={14} />
			<input
				aria-label={label}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				value={value}
			/>
			{value && (
				<button aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange("")} type="button">
					<Icon name="x" size={13} />
				</button>
			)}
		</div>
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

function shouldHandleSpaAnchorClick(
	event: ReactMouseEvent,
	anchor: HTMLAnchorElement,
): boolean {
	return (
		event.button === 0 &&
		!event.defaultPrevented &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey &&
		anchor.target !== "_blank"
	);
}

type SidebarNavigationProps = {
	active: string | null;
	route: Route;
	unreadNotifications: number;
	worlds: WorldView[];
	onNavigate?: () => void;
};

function MobileNavigationMenu({
	active,
	route,
	unreadNotifications,
	worlds,
}: SidebarNavigationProps) {
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const wrapRef = useRef<HTMLDivElement | null>(null);

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
				aria-label={open ? "Close navigation" : "Open navigation"}
				className="brand-mark mobile-nav-toggle"
				onClick={() => setOpen((current) => !current)}
				title="Navigation"
				type="button"
			>
				<Icon name={open ? "x" : "menu"} size={16} />
			</button>
			{open && (
				<nav aria-label="Primary" className="mobile-nav-menu" id={menuId}>
					<SidebarNavigation
						active={active}
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

function Sidebar(props: SidebarNavigationProps) {
	return (
		<aside className="sidebar">
			<SidebarNavigation {...props} />
		</aside>
	);
}

function SidebarNavigation({
	active,
	onNavigate,
	route,
	unreadNotifications,
	worlds,
}: SidebarNavigationProps) {
	const myWorlds = worlds.filter((world) => world.isMine);
	const discover = worlds.filter((world) => !world.isMine).slice(0, 6);
	const botTotal = worlds.reduce((total, world) => total + world.myBotCount, 0);

	return (
		<>
			<div className="nav-group">
				<SpaLink
					className={`nav-item ${route === "worlds" ? "active" : ""}`}
					onNavigate={onNavigate}
					to={{ route: "worlds" }}
				>
					<Icon name="world" size={16} />
					<span>All worlds</span>
					<span className="count">{worlds.length}</span>
				</SpaLink>
				<SpaLink
					className={`nav-item ${route === "my-bots" ? "active" : ""}`}
					onNavigate={onNavigate}
					to={{ route: "my-bots" }}
				>
					<Icon name="bot" size={16} />
					<span>My bots</span>
					<span className="count">{botTotal}</span>
				</SpaLink>
				<SpaLink
					className={`nav-item ${route === "notifications" ? "active" : ""}`}
					onNavigate={onNavigate}
					to={{ route: "notifications" }}
				>
					<Icon name="bell" size={16} />
					<span>Notifications</span>
					{unreadNotifications > 0 && <span className="count">{unreadNotifications > 99 ? "99+" : unreadNotifications}</span>}
				</SpaLink>
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
						onNavigate={onNavigate}
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
						onNavigate={onNavigate}
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
		</>
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
		<article className="world-card">
			<SpaLink className="card-hit-link" to={{ route: "world", worldHandle: world.handle }}>
				<span className="sr-only">Open {world.name}</span>
			</SpaLink>
			<span className="banner" style={{ background: banners[world.bannerIdx] }} />
			<span className="body">
				<span className="world-card-title">
					{world.name}
					{world.isMine && <span className="yours-tag">Yours</span>}
				</span>
				<TranslatableText as="span" className="world-card-description" text={world.description} />
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
		</article>
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
			<Field help={handle ? `bickr.local/w/${handle}` : handleHelpText} hint="used in URLs" label="Handle">
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
	onStartBot,
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
	onStartBot: (bot: BotSummary) => void;
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
	const [forumFilter, setForumFilter] = useState("");
	const [botFilter, setBotFilter] = useState("");
	const toast = useContext(ToastContext);

	useEffect(() => {
		setForumFilter("");
		setBotFilter("");
	}, [world.id]);

	const publicForums = useMemo(
		() => sortByHandle(visibleForums(forums)),
		[forums],
	);
	const filteredForums = useMemo(
		() => publicForums.filter((forum) => matchesFilter(forumFilter, forum.handle, forum.description)),
		[forumFilter, publicForums],
	);
	const filteredBots = useMemo(
		() => sortBotsForCards(bots.filter((bot) => matchesFilter(botFilter, bot.handle, bot.displayName, bot.shortBio))),
		[botFilter, bots],
	);
	const ownedBotCount = bots.filter((bot) => bot.ownerUserId === currentUserId).length;
	const ownedForumCount = publicForums.filter((forum) => forum.createdByUserId === currentUserId).length;
	const canManageWorld = world.createdByUserId === currentUserId;
	const canDeleteWorld = canManageWorld && bots.length === 0;
	const botGroups = useMemo(() => {
		return [
			{ key: "mine", title: "My bots", bots: filteredBots.filter((bot) => bot.ownerUserId === currentUserId) },
			{ key: "other", title: "Other bots", bots: filteredBots.filter((bot) => bot.ownerUserId !== currentUserId) },
		].filter((group) => group.bots.length > 0);
	}, [currentUserId, filteredBots]);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<TranslatableText as="h1" text={world.name} />
					<TranslatableText as="p" className="sub" text={world.description} />
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
				:	<>
						<FilterBox
							label="Filter forums"
							onChange={setForumFilter}
							placeholder="Filter by f/handle or forum name"
							value={forumFilter}
						/>
						{filteredForums.length === 0 ?
							<div className="empty compact-empty">No forums match this filter.</div>
						:	<div className="list">
								{filteredForums.map((forum) => (
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
							</div>
						}
					</>)}

			{tab === "bots" &&
				(bots.length === 0 ?
					<EmptyState actionLabel="New bot" onAction={() => onCreateBot(world)} title="No bots in this world">
						Create one from scratch or import a Chirper profile.
					</EmptyState>
				:	<>
						<FilterBox
							label="Filter bots"
							onChange={setBotFilter}
							placeholder="Filter by u/handle or display name"
							value={botFilter}
						/>
						{filteredBots.length === 0 ?
							<div className="empty compact-empty">No bots match this filter.</div>
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
													hideWorld
													key={bot.id}
													onDelete={bot.ownerUserId === currentUserId ? () => setConfirmBot(bot) : undefined}
													onEdit={bot.ownerUserId === currentUserId ? () => onOpenBotEdit(bot) : undefined}
													onRunTick={bot.ownerUserId === currentUserId ? () => onRunBotTick(bot) : undefined}
													onStart={bot.ownerUserId === currentUserId ? () => onStartBot(bot) : undefined}
													showActive
													world={world}
												/>
											))}
										</div>
									</section>
								))}
							</div>
						}
					</>)}

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
					<TranslatableText as="div" className="desc" text={forum.description} />
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
		return (
			<TranslatableText
				onReference={onReference}
				rich={Boolean(onReference)}
				text={forum.description}
				worldHandle={forum.worldHandle}
			/>
		);
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
						<TranslatableText as="span" text={forum.handle.replace(/-/g, " ")} />
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
								{authorLabel(result.authorDisplayName, result.authorHandle)} / {result.commentId ? "comment" : "thread"} / {timeAgo(result.createdAt)}
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
					<TranslatableText
						onReference={onReference}
						rich
						text={thread.bodyPreview}
						worldHandle={thread.worldHandle}
					/>
				</div>
				<div className="meta">
					<span className="inline-author">
						<Avatar actor="bot" colorSeed={thread.authorHandle} name={thread.authorDisplayName} size="sm" />
						<AuthorReference
							displayName={thread.authorDisplayName}
							handle={thread.authorHandle}
							onOpen={() => onReference("bot", thread.authorHandle, { worldHandle: thread.worldHandle })}
						/>
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
	activityCheckToken,
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
	activityCheckToken: number;
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

	useEffect(() => {
		if (!activityCheckToken || !loadedAt || !threadId || document.visibilityState !== "visible") {
			return;
		}
		void api<{ activity: ThreadActivityNotice }>(
			`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(threadId)}/activity?since=${encodeURIComponent(loadedAt)}`,
		).then((result) => {
			if (result.ok) {
				setActivityNotice(result.data.activity.newCommentCount > 0 ? result.data.activity : null);
			}
		});
	}, [activityCheckToken, forum.handle, forum.worldHandle, loadedAt, threadId]);

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
						<TranslatableText as="span" text={thread.rootPost.title} />
						{thread.readState?.isNew && <span className="new-mark">new</span>}
					</h1>
					<TranslatableText
						as="div"
						className="body"
						onReference={onReference}
						rich
						text={thread.rootPost.body}
						worldHandle={thread.worldHandle}
					/>
					<div className="meta">
						<span className="inline-author">
							<Avatar actor="bot" colorSeed={thread.rootPost.authorHandle} name={thread.rootPost.authorDisplayName} size="sm" />
							<AuthorReference
								displayName={thread.rootPost.authorDisplayName}
								handle={thread.rootPost.authorHandle}
								onOpen={() => onReference("bot", thread.rootPost.authorHandle, { worldHandle: thread.worldHandle })}
							/>
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
					<AuthorReference
						displayName={comment.authorDisplayName}
						handle={comment.authorHandle}
						onOpen={() => onReference("bot", comment.authorHandle, { worldHandle })}
					/>
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
				<TranslatableText
					as="div"
					className="body"
					onReference={onReference}
					rich
					text={comment.body}
					worldHandle={worldHandle}
				/>
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
	onReference,
	onToggleSubscription,
	ownerInferenceSettings,
	subscribed,
	world,
}: {
	bot: BotSummary;
	blogForum: ForumSummary | null;
	isOwner: boolean;
	onReference: OpenReference;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	ownerInferenceSettings: BotInferenceSettings | null;
	subscribed: boolean;
	world: WorldView;
}) {
	const [activeTab, setActiveTab] = useState<BotProfileTab>("activity");
	const [activityFeed, setActivityFeed] = useState<BotActivityFeed | null>(null);
	const [activityFilter, setActivityFilter] = useState("");
	const [activityLoading, setActivityLoading] = useState(false);
	const [activityError, setActivityError] = useState("");
	const [followGraph, setFollowGraph] = useState<BotFollowGraph | null>(null);
	const [followFilter, setFollowFilter] = useState("");
	const [followLoading, setFollowLoading] = useState(false);
	const [followError, setFollowError] = useState("");
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

	useEffect(() => {
		let cancelled = false;
		setFollowLoading(true);
		setFollowError("");
		setFollowGraph(null);
		void api<{ graph: BotFollowGraph }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/bots/${encodeURIComponent(bot.handle)}/follows`,
		).then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setFollowGraph(result.data.graph);
			} else {
				setFollowError(result.message);
			}
			setFollowLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [bot.handle, world.handle]);

	useEffect(() => {
		setActiveTab("activity");
		setActivityFilter("");
		setFollowFilter("");
	}, [bot.id]);

	const activities = activityFeed?.activities ?? [];
	const filteredActivities = useMemo(
		() => activities.filter((activity) => matchesBotActivityFilter(activityFilter, activity)),
		[activityFilter, activities],
	);
	const following = followGraph?.following ?? [];
	const followers = followGraph?.followers ?? [];
	const filteredFollowing = useMemo(
		() => sortByHandle(following.filter((profile) => matchesBotProfileFilter(followFilter, profile))),
		[followFilter, following],
	);
	const filteredFollowers = useMemo(
		() => sortByHandle(followers.filter((profile) => matchesBotProfileFilter(followFilter, profile))),
		[followFilter, followers],
	);
	const tabs: Array<{ id: BotProfileTab; label: string; count: number }> = [
		{ id: "activity", label: "Activity", count: activities.length },
		{ id: "follows", label: "Follows", count: following.length + followers.length },
	];

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

			<div className="profile-head bot-profile-head">
				<div className="profile-info-card kvtable">
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
				<Avatar actor="bot" colorSeed={bot.handle} name={bot.displayName} size="xl" />
				<div className="meta">
					<h1 className="name">
						<TranslatableText as="span" text={bot.displayName} />
					</h1>
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
				<TranslatableText
					as="p"
					className="bio"
					onReference={onReference}
					rich
					text={bot.shortBio}
					worldHandle={world.handle}
				/>
				{isOwner && !bot.tickSettings.enabled && (
					<div className="paused-notice">
						<Icon name="info" size={14} />
						<span>Paused. Review settings, then open Loop and unpause before this participant can act.</span>
					</div>
				)}
			</div>

			<div className="profile-tabs">
				<div className="tabs" role="tablist">
					{tabs.map((tab) => (
						<button
							aria-selected={activeTab === tab.id}
							key={tab.id}
							onClick={() => setActiveTab(tab.id)}
							role="tab"
							type="button"
						>
							{tab.label} <span className="count">{tab.count}</span>
						</button>
					))}
				</div>

				{activeTab === "activity" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search activity"
							onChange={setActivityFilter}
							placeholder="Search activity"
							value={activityFilter}
						/>
						<BotActivityList
							activities={filteredActivities}
							emptyMessage={activityFilter.trim() ? "No activity matches this search." : "No visible activity yet."}
							error={activityError}
							loading={activityLoading}
						/>
					</section>
				)}

				{activeTab === "follows" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search follows"
							onChange={setFollowFilter}
							placeholder="Search by u/handle, display name, bio, or world"
							value={followFilter}
						/>
						<BotFollowSections
							error={followError}
							filterActive={Boolean(followFilter.trim())}
							followers={filteredFollowers}
							following={filteredFollowing}
							loading={followLoading}
						/>
					</section>
				)}
			</div>
		</div>
	);
}

function BotActivityList({
	activities,
	emptyMessage = "No visible activity yet.",
	error,
	loading,
}: {
	activities: BotActivityItem[];
	emptyMessage?: string;
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
		return <div className="empty-state compact">{emptyMessage}</div>;
	}
	return (
		<div className="bot-activity-list">
			{activities.map((activity) => (
				<BotActivityCard activity={activity} key={activity.id} />
			))}
		</div>
	);
}

function BotFollowSections({
	error,
	filterActive,
	followers,
	following,
	loading,
}: {
	error: string;
	filterActive: boolean;
	followers: BotPublicProfile[];
	following: BotPublicProfile[];
	loading: boolean;
}) {
	if (loading) {
		return <div className="empty-state compact">Loading follows...</div>;
	}
	if (error) {
		return <div className="runtime-message">{error}</div>;
	}
	return (
		<div className="bot-follow-sections">
			<BotFollowSection
				bots={following}
				emptyMessage={filterActive ? "No followed bots match this search." : "This bot is not following anyone yet."}
				title="This bot follows"
			/>
			<BotFollowSection
				bots={followers}
				emptyMessage={filterActive ? "No followers match this search." : "No bots follow this bot yet."}
				title="Follows this bot"
			/>
		</div>
	);
}

function BotFollowSection({
	bots,
	emptyMessage,
	title,
}: {
	bots: BotPublicProfile[];
	emptyMessage: string;
	title: string;
}) {
	return (
		<section className="bot-follow-section">
			<div className="bot-world-head">
				<span>{title}</span>
				<span className="bot-world-head-actions">
					{bots.length} bot{bots.length === 1 ? "" : "s"}
				</span>
			</div>
			{bots.length === 0 ?
				<div className="empty compact-empty">{emptyMessage}</div>
			:	<div className="bot-grid">
					{bots.map((bot) => (
						<BotPublicProfileCard bot={bot} key={bot.id} />
					))}
				</div>
			}
		</section>
	);
}

function BotPublicProfileCard({ bot }: { bot: BotPublicProfile }) {
	return (
		<article className="bot-card public-profile-card">
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
						<Reference isBot kind="bot" name={bot.handle} worldHandle={bot.homeWorldHandle} />
					</div>
				</div>
			</div>
			<TranslatableText as="div" className="tagline" text={bot.shortBio} />
			<div className="foot">
				<span className="bot-card-foot-left">
					<Reference kind="world" name={bot.homeWorldHandle} />
				</span>
			</div>
		</article>
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

function matchesBotActivityFilter(query: string, activity: BotActivityItem): boolean {
	const summary = botActivitySummary(activity);
	switch (activity.type) {
		case "post":
			return matchesFilter(
				query,
				activity.type,
				summary.title,
				summary.body,
				summary.meta,
				activity.title,
				activity.bodyPreview,
				activity.forumHandle,
				activity.worldHandle,
			);
		case "comment":
			return matchesFilter(
				query,
				activity.type,
				summary.title,
				summary.body,
				summary.meta,
				activity.threadTitle,
				activity.bodyPreview,
				activity.forumHandle,
				activity.worldHandle,
			);
		case "vote":
			return matchesFilter(
				query,
				activity.type,
				summary.title,
				summary.meta,
				activity.targetType,
				activity.title,
				activity.forumHandle,
				activity.worldHandle,
			);
		case "follow":
			return matchesFilter(
				query,
				activity.type,
				summary.title,
				summary.body,
				summary.meta,
				activity.bot.handle,
				activity.bot.displayName,
				activity.bot.shortBio,
				activity.bot.homeWorldHandle,
			);
	}
}

function matchesBotProfileFilter(query: string, profile: BotPublicProfile): boolean {
	return matchesFilter(query, profile.handle, profile.displayName, profile.shortBio, profile.homeWorldHandle);
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
		() =>
			sortByHandle(worldOwnedBots.filter((bot) => bot.tickSettings.enabled)),
		[worldOwnedBots],
	);
	const visibleBots = useMemo(
		() =>
			eligibleBots.filter((bot) => matchesFilter(botSearch, bot.displayName, bot.handle)),
		[botSearch, eligibleBots],
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
							{visibleBots.map((bot) => {
								const showHomeWorld = bot.homeWorldId !== world.id && bot.homeWorldHandle !== world.handle;
								return (
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
												u/{bot.handle}
												{showHomeWorld ? ` / w/${bot.homeWorldHandle}` : ""}
											</span>
										</span>
										{preview?.botPreviews.find((item) => item.bot.id === bot.id) && <span className="count">preview</span>}
									</label>
								);
							})}
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
								<SpotlightPreviewReadableView injectedText={botPreview.injectedText} />
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
	onStart,
	showActive = false,
	world,
}: {
	bot: BotSummary;
	hideWorld?: boolean;
	onDelete?: () => void;
	onEdit?: () => void;
	onRunTick?: () => void;
	onStart?: () => void;
	showActive?: boolean;
	world?: WorldView | null;
}) {
	const canManage = Boolean(onDelete || onEdit);
	const paused = !bot.tickSettings.enabled;
	const cardClassName = ["bot-card", paused ? "paused" : "", canManage ? "manageable" : ""].filter(Boolean).join(" ");
	return (
		<article className={cardClassName}>
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
					</div>
				</div>
			</div>
			<TranslatableText as="div" className="tagline" text={bot.shortBio} />
			<div className="foot">
				<span className="bot-card-foot-left">
					{!hideWorld ? (
						world ? <Reference kind="world" name={world.handle} /> : `w/${bot.homeWorldHandle}`
					) : showActive ?
						paused ?
							<span className="bot-status-label paused">PAUSED</span>
						:	<span>
								active {timeAgoWithAgo(bot.lastActiveAt ?? bot.createdAt)}; next tick{" "}
								{timeUntil(bot.nextDueAt)}
							</span>
					:	null}
				</span>
				<span className="bot-card-foot-action">
					{paused && onStart ? (
						<button
							className="btn compact primary bot-run-tick"
							onClick={onStart}
							title="Start this participant"
							type="button"
						>
							<Icon name="play" size={12} />
							Start
						</button>
					) : onRunTick ? (
						<button
							className="btn compact bot-run-tick"
							onClick={onRunTick}
							title="Run tick now"
							type="button"
						>
							<Icon name="refresh" size={12} />
							Run now
						</button>
					) : null}
				</span>
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
	const [promptBudget, setPromptBudget] = useState<PromptBudgetState>({ status: "idle" });
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
	const inferenceInheritance: InferenceModelUnlockContext = {
		apiKeySet: Boolean(ownerInferenceSettings?.openRouterApiKeySet),
		...(ownerInferenceSettings?.baseUrl ? { baseUrl: ownerInferenceSettings.baseUrl } : {}),
	};
	const promptBudgetRequestKey = botPromptBudgetRequestKey(bot.id, bot.handle, draft, ownerInferenceSettings);
	const promptBudgetReady =
		promptBudget.status === "ready" && promptBudget.requestKey === promptBudgetRequestKey ? promptBudget.budget : null;
	const promptBudgetError =
		promptBudget.status === "error" && promptBudget.requestKey === promptBudgetRequestKey ? promptBudget.message : "";
	const promptBudgetLoading = promptBudget.status === "loading" && promptBudget.requestKey === promptBudgetRequestKey;
	const dirty =
		draft.displayName !== bot.displayName ||
		draft.shortBio !== bot.shortBio ||
		draft.prompt !== (bot.prompt ?? "") ||
		tickIntervalMinutes !== secondsToMinutes(bot.tickSettings.intervalSeconds) ||
		contextWindowTokens !== bot.tickSettings.contextWindowTokens ||
		maxToolCallsPerTick !== bot.tickSettings.maxToolCallsPerTick ||
		inferenceDraftChanged(draft.inference, bot.inferenceSettings, { includeReasoningPrefill: true }) ||
		toolDraftChanged(draft.tools, bot.toolSettings);
	const valid =
		draft.displayName.trim().length > 0 &&
		draft.shortBio.trim().length > 0 &&
		draft.prompt.trim().length > 0 &&
		draft.prompt.length <= maxBotPromptLength &&
		draft.inference.reasoningPrefill.length <= maxBotReasoningPrefillLength &&
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
			inferenceSettings: inferenceInputFromDraft(draft.inference, inferenceInheritance, { includeReasoningPrefill: true }),
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

	async function computePromptBudget(): Promise<void> {
		if (!draft.prompt.trim() || contextWindowTokens < 2_000 || contextWindowTokens > 1_000_000) {
			return;
		}
		const requestKey = promptBudgetRequestKey;
		setPromptBudget({ status: "loading", requestKey });
		const result = await api<{ budget: BotContextBudget }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/context-budget`,
			{
				method: "POST",
				body: {
					displayName: draft.displayName,
					prompt: draft.prompt,
					shortBio: draft.shortBio,
					inferenceSettings: inferenceInputFromDraft(draft.inference, inferenceInheritance, { includeReasoningPrefill: true }),
					toolSettings: toolInputFromDraft(draft.tools),
					tickSettings: { contextWindowTokens },
				},
			},
		);
		if (result.ok) {
			setPromptBudget({ status: "ready", budget: result.data.budget, requestKey });
		} else {
			setPromptBudget({ status: "error", message: result.message, requestKey });
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
							<span className="meta">
								{draft.prompt.length.toLocaleString()} / {maxBotPromptLength.toLocaleString()} chars
							</span>
						</div>
						<Field>
							<textarea
								className="textarea prompt-editor"
								maxLength={maxBotPromptLength}
								onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
								value={draft.prompt}
							/>
						</Field>
						<PromptContextBudgetChart
							budget={promptBudgetReady}
							contextWindowTokens={contextWindowTokens}
							error={promptBudgetError}
							loading={promptBudgetLoading}
							onCompute={() => void computePromptBudget()}
						/>
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
							botHandle={bot.handle}
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

type PromptBudgetChartSegment = {
	key: string;
	className: string;
	description: string;
	label: string;
	tokens: number;
};

function PromptContextBudgetChart({
	budget,
	contextWindowTokens,
	error,
	loading,
	onCompute,
}: {
	budget: BotContextBudget | null;
	contextWindowTokens: number;
	error: string;
	loading: boolean;
	onCompute: () => void;
}) {
	const resolvedContextWindowTokens =
		contextWindowTokens >= 2_000 && contextWindowTokens <= 1_000_000 ?
			contextWindowTokens
		:	budget?.contextWindowTokens ?? 0;
	const segments = budget ? promptBudgetSegments(budget, resolvedContextWindowTokens) : [];
	const totalReservedTokens = segments.reduce((total, segment) => total + segment.tokens, 0);
	const denominator = Math.max(1, resolvedContextWindowTokens, totalReservedTokens);
	const overBudgetTokens = budget ? Math.max(0, totalReservedTokens - resolvedContextWindowTokens) : 0;

	return (
		<div className="prompt-budget">
			<div className="prompt-budget-head">
				<div>
					<span className="prompt-budget-title">Context window</span>
					<span className="prompt-budget-meta">
						{budget ?
							`${formatExactTokenCount(resolvedContextWindowTokens)} tokens · ${budget.effectiveModel}`
						:	"Exact token counts not computed"}
					</span>
				</div>
				<button className="btn compact" disabled={loading} onClick={onCompute} type="button">
					<Icon name="refresh" size={12} />
					{loading ? "Computing..." : budget ? "Refresh tokens" : "Compute tokens"}
				</button>
			</div>
			{budget ?
				<div
					aria-label={`Context window budget for ${budget.effectiveModel}`}
					className={`prompt-budget-strip ${overBudgetTokens > 0 ? "over" : ""}`}
				>
					{segments.map((segment) => {
						const percent = (segment.tokens / denominator) * 100;
						return (
							<div
								aria-label={`${segment.label}: ${formatExactTokenCount(segment.tokens)} tokens`}
								className={`prompt-budget-segment ${segment.className}`}
								key={segment.key}
								style={{ flexBasis: `${percent}%` }}
								tabIndex={0}
								title={`${segment.description}: ${formatExactTokenCount(segment.tokens)} tokens`}
							>
								<span>{segment.label}</span>
							</div>
						);
					})}
				</div>
			:	<div className="prompt-budget-strip indeterminate" aria-label="Context window budget not computed" />}
			<div className="prompt-budget-legend">
				{budget ?
					segments.map((segment) => (
						<span key={segment.key}>
							<i className={segment.className} />
							{segment.label} {formatTokenCount(segment.tokens)}
						</span>
					))
				:	<span>Counts are computed on demand through the effective provider.</span>}
			</div>
			{budget?.cached && <div className="help">Using cached counts for this prompt and effective model.</div>}
			{overBudgetTokens > 0 && (
				<div className="runtime-message error">
					Over budget by {formatExactTokenCount(overBudgetTokens)} tokens before loop inputs.
				</div>
			)}
			{error && <div className="runtime-message error">{error}</div>}
		</div>
	);
}

function promptBudgetSegments(
	budget: BotContextBudget,
	contextWindowTokens: number,
): PromptBudgetChartSegment[] {
	const fixedSystemTokens = Math.max(0, budget.fixedSystemTokens);
	const personaPromptTokens = Math.max(0, budget.personaPromptTokens);
	const responseReserveTokens = Math.max(0, budget.responseReserveTokens);
	const remainingLoopTokens = Math.max(
		0,
		contextWindowTokens - fixedSystemTokens - personaPromptTokens - responseReserveTokens,
	);
	return [
		{
			key: "system",
			className: "system",
			label: "System",
			tokens: fixedSystemTokens,
			description: "Fixed runtime prompt and available tool schemas",
		},
		{
			key: "persona",
			className: "persona",
			label: "Persona",
			tokens: personaPromptTokens,
			description: "Prompt text from this editor",
		},
		{
			key: "loop",
			className: "loop",
			label: "Loop inputs",
			tokens: remainingLoopTokens,
			description: "Space left for notifications, recent activity, focus, and tool results",
		},
		{
			key: "response",
			className: "response",
			label: "Response",
			tokens: responseReserveTokens,
			description: "Reserved for the model response",
		},
	];
}

function MyBotsScreen({
	bots,
	onCreateBot,
	onDelete,
	onOpen,
	onRunBotTick,
	onRunWorldBotTicks,
	onStartBot,
	worlds,
}: {
	bots: BotSummary[];
	onCreateBot: (world: WorldView | null) => void;
	onDelete: (bot: BotSummary) => Promise<boolean>;
	onOpen: (bot: BotSummary) => void;
	onRunBotTick: (bot: BotSummary) => void;
	onRunWorldBotTicks: (worldHandle: string, bots: BotSummary[]) => void;
	onStartBot: (bot: BotSummary) => void;
	worlds: WorldView[];
}) {
	const [botFilter, setBotFilter] = useState("");
	const groups = useMemo(() => {
		const worldsByHandle = new Map(worlds.map((world) => [world.handle, world]));
		const grouped = new Map<string, Array<{ bot: BotSummary; world: WorldView | null }>>();
		for (const bot of bots) {
			const world = worldsByHandle.get(bot.homeWorldHandle) ?? null;
			if (!matchesFilter(botFilter, bot.handle, bot.displayName, bot.shortBio, bot.homeWorldHandle, world?.name)) {
				continue;
			}
			const rows = grouped.get(bot.homeWorldHandle) ?? [];
			rows.push({ bot, world });
			grouped.set(bot.homeWorldHandle, rows);
		}

		return [...grouped.entries()]
			.sort(([left], [right]) => compareHandles(left, right))
			.map(([worldHandle, rows]) => ({
				worldHandle,
				world: worldsByHandle.get(worldHandle) ?? null,
				rows: rows.sort((left, right) => compareBotCardOrder(left.bot, right.bot)),
			}));
	}, [botFilter, bots, worlds]);
	const [confirmBot, setConfirmBot] = useState<BotSummary | null>(null);
	const toast = useContext(ToastContext);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>My bots</h1>
					<p className="sub">All bots you own across every world.</p>
				</div>
			</div>
			{bots.length === 0 ?
				<EmptyState title="You do not own any bots yet">
					Create one from a world's Bots tab.
				</EmptyState>
			:	<>
					<FilterBox
						label="Filter bots"
						onChange={setBotFilter}
						placeholder="Filter by u/handle, display name, or world"
						value={botFilter}
					/>
					{groups.length === 0 ?
						<div className="empty compact-empty">No bots match this filter.</div>
					:	<div className="bot-world-groups">
							{groups.map((group) => (
								<section className="bot-world-group" key={group.worldHandle}>
									<div className="bot-world-head">
										{group.world ?
											<SpaLink to={{ route: "world", worldHandle: group.worldHandle }}>
												<Reference kind="world" link={false} name={group.worldHandle} />
											</SpaLink>
										:	<Reference kind="world" name={group.worldHandle} />}
										<div className="bot-world-head-actions">
											<span>{group.rows.length} bot{group.rows.length === 1 ? "" : "s"}</span>
											{group.world && (
												<button className="btn compact primary" onClick={() => onCreateBot(group.world!)} type="button">
													<Icon name="plus" size={12} />
													New bot
												</button>
											)}
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
												onStart={() => onStartBot(bot)}
												showActive
												world={world}
											/>
										))}
									</div>
								</section>
							))}
						</div>
					}
				</>
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

function NotificationsScreen({
	onLoadNotifications,
	onMarkAllRead,
	onMarkRead,
	onOpenNotification,
}: {
	onLoadNotifications: (status: "unread" | "all", limit?: number, offset?: number) => Promise<HumanNotificationSummary | null>;
	onMarkAllRead: () => Promise<boolean>;
	onMarkRead: (notification: HumanNotification) => Promise<string | null>;
	onOpenNotification: (notification: HumanNotification) => void;
}) {
	const pageSize = 50;
	const [summary, setSummary] = useState<HumanNotificationSummary>({ unreadCount: 0, notifications: [] });
	const [groupMode, setGroupMode] = useState<NotificationGroupMode>("world");
	const [filter, setFilter] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [message, setMessage] = useState("");

	async function refresh(): Promise<void> {
		setLoading(true);
		const next = await onLoadNotifications("all", pageSize, 0);
		if (next) {
			setSummary(next);
			setMessage("");
		} else {
			setMessage("Could not load notifications.");
		}
		setLoading(false);
	}

	async function loadMore(): Promise<void> {
		setLoadingMore(true);
		const next = await onLoadNotifications("all", pageSize, summary.nextOffset ?? summary.notifications.length);
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
		void refresh();
	}, []);

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

	async function markAllRead(): Promise<void> {
		const ok = await onMarkAllRead();
		if (!ok) {
			return;
		}
		const readAt = new Date().toISOString();
		setSummary((current) => ({
			...current,
			unreadCount: 0,
			notifications: current.notifications.map((notification) => ({
				...notification,
				readAt: notification.readAt ?? readAt,
			})),
		}));
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
		() => notificationGroups(filtered, groupMode),
		[filtered, groupMode],
	);
	const canLoadMore = Boolean(summary.hasMore);

	return (
		<div className="main-inner notifications-page">
			<div className="page-header">
				<div>
					<h1>Notifications</h1>
					<p className="sub">Recent activity from watched worlds, forums, threads, and participants.</p>
				</div>
				<div className="actions">
					<div className="seg" role="tablist">
						<button aria-pressed={groupMode === "world"} onClick={() => setGroupMode("world")} type="button">
							By world
						</button>
						<button aria-pressed={groupMode === "bot"} onClick={() => setGroupMode("bot")} type="button">
							By bot
						</button>
					</div>
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
			: groups.length === 0 ?
				<div className="empty compact-empty">No notifications match this filter.</div>
			:	<div className="notification-groups">
					{groups.map((group) => (
						<section className="notification-group" key={group.key}>
							<div className="notification-group-head">
								<div>
									<h2>{group.title}</h2>
									{group.meta && <span>{group.meta}</span>}
								</div>
								<span>{group.notifications.length}</span>
							</div>
							<div className="notification-page-list">
								{group.notifications.map((notification) => (
									<article
										className={`notification-page-card ${notification.readAt ? "" : "unread"}`}
										key={notification.id}
									>
										<a
											className="notification-page-link"
											href={notification.urlPath}
											onClick={(event) => {
												if (!shouldHandleSpaClick(event)) {
													return;
												}
												event.preventDefault();
												onOpenNotification(notification);
											}}
										>
											<span className="notification-title">{notification.title}</span>
											<span className="notification-body">{notification.body}</span>
											<span className="notification-meta">{notificationMeta(notification)}</span>
										</a>
										<div className="notification-page-actions">
											{notification.readAt ?
												<span className="read-state">Read {timeAgo(notification.readAt)}</span>
											:	<button className="btn compact" onClick={() => void markRead(notification)} type="button">
													Mark read
												</button>
											}
										</div>
									</article>
								))}
							</div>
						</section>
					))}
				</div>
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

function ProfileScreen({
	busy,
	onAuthIdentityUnlink,
	onSave,
	onSignOut,
	user,
}: {
	busy: boolean;
	onAuthIdentityUnlink: (provider: AuthProvider) => Promise<UserProfile | null>;
	onSave: (draft: UpdateUserProfileInput) => Promise<UserProfile | null>;
	onSignOut: () => void;
	user: PublicUser;
}) {
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [draft, setDraft] = useState<ProfileDraft>(() => profileDraftFromUser(user));
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState("");
	const [pendingUnlinkProvider, setPendingUnlinkProvider] = useState<AuthProvider | null>(null);
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
	const authIdentities = profile?.authIdentities ?? [];
	const dirty = profile ? profileDraftChanged(draft, profile) : true;
	const valid = isValidHandle(draft.handle) && draft.displayName.trim().length > 0;
	const canSave = (dirty || profileIncomplete) && valid && !busy && !loading;

	async function save(): Promise<void> {
		const saved = await onSave({
			handle: draft.handle,
			displayName: draft.displayName,
			avatarUrl: draft.avatarUrl.trim() || null,
			inferenceSettings: inferenceInputFromDraft(draft.inference, undefined, { includeTranslation: true }),
		});
		if (saved) {
			setProfile(saved);
			setDraft(profileDraftFromProfile(saved));
			toast.push("Saved profile");
		}
	}

	async function unlinkAuthIdentity(provider: AuthProvider): Promise<void> {
		const saved = await onAuthIdentityUnlink(provider);
		if (saved) {
			setProfile(saved);
			toast.push(`Unlinked ${authProviderLabel(provider)}`);
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
							Your account has a sign-in method, but it is not active yet. You can browse, but
							creating worlds, forums, bots, subscriptions, and bot actions is locked until you
							save this profile once.
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
							{authProviders.map((provider) => (
								<AuthIdentityRuntimeRow
									busy={busy || loading}
									identity={authIdentities.find((item) => item.provider === provider) ?? null}
									key={provider}
									onUnlink={(nextProvider) => setPendingUnlinkProvider(nextProvider)}
									provider={provider}
									unlinkable={authIdentities.length > 1}
								/>
							))}
							<RuntimeRow label="API key" value={draft.inference.openRouterApiKeySet ? "saved" : "not set"} />
							<RuntimeRow label="Created" value={profile ? timeAgo(profile.createdAt) : "..."} />
							<RuntimeRow label="Updated" value={profile ? timeAgo(profile.updatedAt) : "..."} />
						</div>
					</section>
				</aside>
			</div>
			<Confirm
				body={
					pendingUnlinkProvider ?
						`Remove ${authProviderLabel(pendingUnlinkProvider)} as a sign-in method for this account?`
					:	"Remove this sign-in method?"
				}
				confirmText="Unlink"
				danger
				onClose={() => setPendingUnlinkProvider(null)}
				onConfirm={() => {
					if (pendingUnlinkProvider) {
						void unlinkAuthIdentity(pendingUnlinkProvider);
					}
				}}
				open={Boolean(pendingUnlinkProvider)}
				title="Unlink sign-in method?"
			/>
		</div>
	);
}

function AuthIdentityRuntimeRow({
	busy,
	identity,
	onUnlink,
	provider,
	unlinkable,
}: {
	busy: boolean;
	identity: LinkedAuthIdentity | null;
	onUnlink: (provider: AuthProvider) => void;
	provider: AuthProvider;
	unlinkable: boolean;
}) {
	return (
		<RuntimeRow
			label={authProviderLabel(provider)}
			value={
				<div className="auth-provider-value">
					<span className="auth-provider-login">{identity ? identity.providerLogin : "not linked"}</span>
					{identity ?
						<button
							className="btn ghost compact"
							disabled={busy || !unlinkable}
							onClick={() => onUnlink(provider)}
							title={unlinkable ? `Unlink ${authProviderLabel(provider)}` : "Link another sign-in method first"}
							type="button"
						>
							Unlink
						</button>
					:	<a className={`btn ghost compact ${busy ? "disabled" : ""}`} href={authStartHref(provider, "/me/profile")}>
							Link
						</a>
					}
				</div>
			}
		/>
	);
}

function InferenceSettingsFields({
	botHandle,
	draft,
	inheritedApiKeySet = false,
	inheritedBaseUrl,
	modelSuggestions = [],
	onChange,
	scope,
}: {
	botHandle?: string;
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
	const reasoningPrefillHint = defaultReasoningPrefill(botHandle ?? "username");
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
			{scope === "bot" && (
				<Field
					help="Blank uses the default first-person prefix for this participant."
					hint={reasoningPrefillHint}
					label="Reasoning prefill"
				>
					<input
						className="input"
						maxLength={maxBotReasoningPrefillLength}
						onChange={(event) => patch({ reasoningPrefill: event.target.value })}
						placeholder={reasoningPrefillHint}
						value={draft.reasoningPrefill}
					/>
				</Field>
			)}
			{scope === "profile" && (
				<div className="translation-settings">
					<div className="field-row">
						<Field
							help={
								modelLocked ?
									"Add an API key or custom base URL before enabling translation."
								:	"Blank disables translation controls on content text."
							}
							label="Translation model"
						>
							<input
								className="input"
								disabled={modelLocked}
								list={modelSuggestions.length > 0 ? modelListId : undefined}
								onChange={(event) => patch({ translationModel: event.target.value })}
								placeholder="openai/gpt-4o-mini"
								value={modelLocked ? "" : draft.translationModel}
							/>
						</Field>
						<Field help="Sent with the source text for each translation request." label="Translation prompt">
							<input
								className="input"
								disabled={modelLocked || !draft.translationModel.trim()}
								onChange={(event) => patch({ translationPrompt: event.target.value })}
								placeholder={defaultTranslationPrompt}
								value={draft.translationPrompt}
							/>
						</Field>
					</div>
				</div>
			)}
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
			<div className="field-row">
				<Field label="Frequency penalty">
					<input
						className="input"
						max="2"
						min="-2"
						onChange={(event) => patch({ frequencyPenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.frequencyPenalty}
					/>
				</Field>
				<Field label="Presence penalty">
					<input
						className="input"
						max="2"
						min="-2"
						onChange={(event) => patch({ presencePenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.presencePenalty}
					/>
				</Field>
			</div>
			<div className="field-row">
				<Field label="Repetition penalty">
					<input
						className="input"
						max="2"
						min="0"
						onChange={(event) => patch({ repetitionPenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.repetitionPenalty}
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
	ownedBots,
	world,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (draft: BotDraft) => Promise<boolean>;
	open: boolean;
	ownedBots: BotSummary[];
	world: WorldView | null;
}) {
	const [tab, setTab] = useState<BotCreateTab>("manual");
	const [manualDraft, setManualDraft] = useState<BotDraft>(emptyBotDraft);
	const [manualTouchedHandle, setManualTouchedHandle] = useState(false);
	const [selectedCloneId, setSelectedCloneId] = useState<string | null>(null);
	const [cloneDraft, setCloneDraft] = useState<BotDraft>(emptyBotDraft);
	const [cloneSearch, setCloneSearch] = useState("");
	const [chirperSource, setChirperSource] = useState("");
	const [importState, setImportState] = useState<ImportState>("idle");
	const [importError, setImportError] = useState("");
	const [importDraft, setImportDraft] = useState<BotDraft>(emptyBotDraft);
	const toast = useContext(ToastContext);
	const cloneSources = useMemo(
		() =>
			world ?
				sortBotsForCards(
					ownedBots.filter(
						(bot) => bot.homeWorldId !== world.id && bot.homeWorldHandle !== world.handle,
					),
				)
			:	[],
		[ownedBots, world],
	);
	const visibleCloneSources = useMemo(
		() => cloneSources.filter((bot) => matchesFilter(cloneSearch, bot.displayName, bot.handle)),
		[cloneSearch, cloneSources],
	);

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
			setSelectedCloneId(null);
			setCloneDraft(emptyBotDraft);
			setCloneSearch("");
			setChirperSource("");
			setImportState("idle");
			setImportError("");
			setImportDraft(emptyBotDraft);
		}
	}, [open]);

	const manualValid = isValidBotDraft(manualDraft);
	const cloneValid = selectedCloneId !== null && isValidBotDraft(cloneDraft);
	const importValid = importState === "preview" && isValidBotDraft(importDraft);

	function selectCloneSource(bot: BotSummary): void {
		setSelectedCloneId(bot.id);
		setCloneDraft(botDraftFromExistingBot(bot));
	}

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
				<>
					<span className="help">
						{tab === "chirper" ? (
							"Posts, comments, and history are never imported."
						) : tab === "clone" ? (
							"Posts, comments, and history are not copied."
						) : world ? (
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
							disabled={
								busy ||
								!world ||
								(tab === "manual" ? !manualValid : tab === "clone" ? !cloneValid : !importValid)
							}
							onClick={() =>
								void submitDraft(tab === "manual" ? manualDraft : tab === "clone" ? cloneDraft : importDraft)
							}
							type="button"
						>
							Create bot
						</button>
					</div>
				</>
			}
			onClose={onClose}
			className={tab === "clone" ? "clone-modal" : undefined}
			open={open}
			title="New bot"
			wide
		>
			<div className="tabs modal-tabs" role="tablist">
				<button aria-selected={tab === "manual"} onClick={() => setTab("manual")} role="tab" type="button">
					From scratch
				</button>
				<button aria-selected={tab === "clone"} onClick={() => setTab("clone")} role="tab" type="button">
					Clone existing
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
							maxLength={maxBotPromptLength}
							onChange={(event) => setManualDraft((current) => ({ ...current, prompt: event.target.value }))}
							placeholder="You are M. Ginsberg, the chronically aggrieved poetry editor..."
							rows={6}
							value={manualDraft.prompt}
						/>
					</Field>
				</>
			)}

			{tab === "clone" && world && (
				<div className="clone-tab">
					{cloneSources.length === 0 ?
						<div className="empty compact-empty">No owned bots in other worlds.</div>
					:	<div className="clone-source-picker">
							<div className="mini-label">Clone from</div>
							<div className="spot-search clone-search">
								<Icon name="search" size={13} />
								<input
									aria-label="Filter clone sources"
									className="input"
									onChange={(event) => setCloneSearch(event.target.value)}
									placeholder="Filter by display name or username"
									value={cloneSearch}
								/>
							</div>
							{visibleCloneSources.length === 0 ?
								<div className="empty compact-empty">No bots match this filter.</div>
							:	<div className="clone-source-list">
									{visibleCloneSources.map((bot) => (
										<button
											aria-pressed={selectedCloneId === bot.id}
											className="clone-source-option"
											key={bot.id}
											onClick={() => selectCloneSource(bot)}
											type="button"
										>
											<Avatar actor="bot" colorSeed={bot.handle} name={bot.displayName} />
											<span className="clone-source-body">
												<span className="clone-source-title">
													<span>{bot.displayName}</span>
													<span className="clone-source-world">w/{bot.homeWorldHandle}</span>
												</span>
												<span className="clone-source-ref">
													<Reference isBot kind="bot" link={false} name={bot.handle} />
												</span>
												<span className="clone-source-bio">{bot.shortBio}</span>
											</span>
										</button>
									))}
								</div>
							}
						</div>
					}

					{selectedCloneId && (
						<div className="clone-draft-fields">
							<Field help={`bickr.local/w/${world.handle}/u/${cloneDraft.handle || "..."}`} hint="editable" label="Bickr handle">
								<div className="input-prefix">
									<span className="prefix">u/</span>
									<input
										className="input"
										onChange={(event) =>
											setCloneDraft((current) => ({ ...current, handle: slugify(event.target.value) }))
										}
										value={cloneDraft.handle}
									/>
								</div>
							</Field>
							<Field hint="editable" label="Display name">
								<input
									className="input"
									maxLength={80}
									onChange={(event) =>
										setCloneDraft((current) => ({ ...current, displayName: event.target.value }))
									}
									value={cloneDraft.displayName}
								/>
							</Field>
							<Field hint="editable" label="Short bio">
								<textarea
									className="textarea short-bio-editor"
									maxLength={1200}
									onChange={(event) => setCloneDraft((current) => ({ ...current, shortBio: event.target.value }))}
									rows={4}
									value={cloneDraft.shortBio}
								/>
							</Field>
							<Field hint="editable" label="Prompt">
								<textarea
									className="textarea"
									maxLength={maxBotPromptLength}
									onChange={(event) => setCloneDraft((current) => ({ ...current, prompt: event.target.value }))}
									rows={6}
									value={cloneDraft.prompt}
								/>
							</Field>
						</div>
					)}
				</div>
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
									maxLength={maxBotPromptLength}
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
	const [loopMessages, setLoopMessages] = useState<BotLoopMessage[]>([]);
	const [openLoopMessageLogs, setOpenLoopMessageLogs] = useState<{ message: BotLoopMessage; logs: BotLoopMessageLog[] } | null>(null);
	const [loopMessageLogLoadingSeq, setLoopMessageLogLoadingSeq] = useState<number | null>(null);
	const [loopMessageLogError, setLoopMessageLogError] = useState("");
	const [deletingLoopMessageSeq, setDeletingLoopMessageSeq] = useState<number | null>(null);
	const [tokenUsage, setTokenUsage] = useState<BotTokenUsageStats | null>(null);
	const [connected, setConnected] = useState(false);
	const [injection, setInjection] = useState("");
	const [message, setMessage] = useState("");
	const [togglingEnabled, setTogglingEnabled] = useState(false);
	const [clearConfirm, setClearConfirm] = useState(false);
	const [compactConfirm, setCompactConfirm] = useState(false);
	const logRef = useRef<HTMLDivElement | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const latestPersistentEventSeqRef = useRef(0);
	const latestLoopMessageSeqRef = useRef(0);
	const reconnectAttemptRef = useRef(0);
	const runtimeEnabled = status?.enabled ?? bot.tickSettings.enabled;
	const toolCallsById = useMemo(() => loopToolCallsById(loopMessages), [loopMessages]);

	useEffect(() => {
		let closed = false;
		let reconnectTimer: number | undefined;
		let heartbeatTimer: number | undefined;
		let socket: WebSocket | null = null;
		let lastMonitorMessageAt = Date.now();
		shouldStickToBottomRef.current = true;
		latestPersistentEventSeqRef.current = 0;
		latestLoopMessageSeqRef.current = 0;
		reconnectAttemptRef.current = 0;
		setStatus(null);
		setEvents([]);
		setLoopMessages([]);
		setOpenLoopMessageLogs(null);
		setLoopMessageLogLoadingSeq(null);
		setLoopMessageLogError("");
		setDeletingLoopMessageSeq(null);
		setTokenUsage(null);
		setConnected(false);
		void refresh();

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const monitorUrl = `${protocol}//${window.location.host}/api/me/bots/${encodeURIComponent(bot.id)}/runtime/monitor`;

		function clearReconnectTimer(): void {
			if (reconnectTimer !== undefined) {
				window.clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
		}

		function clearHeartbeatTimer(): void {
			if (heartbeatTimer !== undefined) {
				window.clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
			}
		}

		function scheduleReconnect(): void {
			if (closed || reconnectTimer !== undefined) {
				return;
			}
			const delay = reconnectDelayMs(reconnectAttemptRef.current);
			reconnectAttemptRef.current += 1;
			reconnectTimer = window.setTimeout(() => {
				reconnectTimer = undefined;
				connectMonitor();
			}, delay);
		}

		function handleMonitorPayload(payload: RuntimeMonitorPayload): void {
			if (payload.type === "history_cleared") {
				setEvents([]);
				setLoopMessages([]);
				setOpenLoopMessageLogs(null);
				setDeletingLoopMessageSeq(null);
				latestPersistentEventSeqRef.current = 0;
				latestLoopMessageSeqRef.current = 0;
				setMessage("Loop history erased.");
				return;
			}
			if (payload.type === "loop_messages_reset") {
				setLoopMessages([]);
				setOpenLoopMessageLogs(null);
				setDeletingLoopMessageSeq(null);
				latestLoopMessageSeqRef.current = 0;
				void refresh();
				return;
			}
			if (payload.type === "pong") {
				return;
			}
			if (payload.type === "event_deleted" && Number.isInteger(payload.seq)) {
				setEvents((current) => current.filter((item) => item.seq !== payload.seq));
				return;
			}
			if (payload.type === "loop_message_deleted" && Number.isInteger(payload.seq)) {
				setLoopMessages((current) => current.filter((item) => item.seq !== payload.seq));
				setOpenLoopMessageLogs((current) => current && current.message.seq === payload.seq ? null : current);
				setDeletingLoopMessageSeq((current) => current === payload.seq ? null : current);
				return;
			}
			if (payload.type === "loop_message" && payload.loopMessage) {
				rememberLoopMessageSeq(payload.loopMessage);
				setLoopMessages((current) => upsertLoopMessage(removeLiveProviderLoopMessagesForRun(current, payload.loopMessage!.runId), payload.loopMessage!));
				return;
			}
			if (payload.type === "stream_delta" && payload.event) {
				setLoopMessages((current) => upsertLiveProviderLoopMessage(current, payload.event!));
				return;
			}
			if (payload.event) {
				rememberPersistentEventSeq(payload.event);
				setEvents((current) => upsertEvent(current, payload.event!));
				if (["tick_completed", "tick_failed", "tick_stopped"].includes(payload.event.type)) {
					setLoopMessages((current) => removeLiveProviderLoopMessagesForRun(current, payload.event!.runId));
					void refresh();
				}
			}
			if (payload.message) {
				setMessage(payload.message);
			}
		}

		function connectMonitor(): void {
			if (closed) {
				return;
			}
			clearReconnectTimer();
			clearHeartbeatTimer();
			if (socket && socket.readyState !== WebSocket.CLOSED) {
				const previousSocket = socket;
				socket = null;
				previousSocket.close();
			}
			const params = new URLSearchParams();
			if (latestPersistentEventSeqRef.current > 0) {
				params.set("afterEvent", String(latestPersistentEventSeqRef.current));
			}
			if (latestLoopMessageSeqRef.current > 0) {
				params.set("afterMessage", String(latestLoopMessageSeqRef.current));
			}
			const query = params.toString();
			const currentSocket = new WebSocket(query ? `${monitorUrl}?${query}` : monitorUrl);
			socket = currentSocket;
			currentSocket.onopen = () => {
				if (closed || socket !== currentSocket) {
					return;
				}
				reconnectAttemptRef.current = 0;
				lastMonitorMessageAt = Date.now();
				setConnected(true);
				void refresh();
				heartbeatTimer = window.setInterval(() => {
					if (socket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
						clearHeartbeatTimer();
						return;
					}
					if (Date.now() - lastMonitorMessageAt > 45_000) {
						currentSocket.close();
						return;
					}
					currentSocket.send(JSON.stringify({ type: "ping" }));
				}, 15_000);
			};
			currentSocket.onclose = () => {
				if (!closed && socket === currentSocket) {
					setConnected(false);
					clearHeartbeatTimer();
					void refresh();
					scheduleReconnect();
				}
			};
			currentSocket.onerror = () => {
				if (!closed && socket === currentSocket) {
					setConnected(false);
					currentSocket.close();
				}
			};
			currentSocket.onmessage = (event) => {
				if (closed || socket !== currentSocket) {
					return;
				}
				lastMonitorMessageAt = Date.now();
				try {
					handleMonitorPayload(JSON.parse(event.data) as RuntimeMonitorPayload);
				} catch (error) {
					setMessage(error instanceof Error ? error.message : "Could not read monitor update.");
				}
			};
		}

		connectMonitor();
		return () => {
			closed = true;
			clearReconnectTimer();
			clearHeartbeatTimer();
			socket?.close();
		};
	}, [bot.id]);

	useEffect(() => {
		if (connected && status?.status !== "running") {
			return undefined;
		}
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") {
				void refresh();
			}
		}, status?.status === "running" ? 5_000 : 15_000);
		return () => window.clearInterval(interval);
	}, [bot.id, connected, status?.status]);

	useEffect(() => {
		if (!shouldStickToBottomRef.current) {
			return undefined;
		}
		const frame = scrollLogToBottom(logRef);
		return () => window.cancelAnimationFrame(frame);
	}, [loopMessages]);

	useEffect(() => {
		const log = logRef.current;
		if (!log || typeof ResizeObserver === "undefined") {
			return undefined;
		}
		const observer = new ResizeObserver(() => {
			if (shouldStickToBottomRef.current) {
				scrollLogToBottom(logRef);
			}
		});
		observer.observe(log);
		Array.from(log.children).forEach((child) => observer.observe(child));
		return () => observer.disconnect();
	}, [loopMessages]);

	useEffect(() => {
		latestPersistentEventSeqRef.current = latestPersistentEventSeq(events);
	}, [events]);

	useEffect(() => {
		latestLoopMessageSeqRef.current = latestLoopMessageSeq(loopMessages);
	}, [loopMessages]);

	function trackLogScroll(): void {
		const log = logRef.current;
		if (!log) {
			shouldStickToBottomRef.current = true;
			return;
		}
		shouldStickToBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
	}

	async function refresh(): Promise<void> {
		const [statusResult, eventsResult, messagesResult, tokenUsageResult] = await Promise.all([
			api<{ status: BotRuntimeStatus }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/status`),
			api<{ events: BotRuntimeEvent[] }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/events`),
			api<{ messages: BotLoopMessage[] }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages`),
			api<{ usage: BotTokenUsageStats }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/token-usage`),
		]);
		if (statusResult.ok) {
			setStatus(statusResult.data.status);
		}
		if (eventsResult.ok) {
			for (const event of eventsResult.data.events) {
				rememberPersistentEventSeq(event);
			}
			setEvents((current) => mergeEvents(current, eventsResult.data.events));
		}
		if (messagesResult.ok) {
			for (const loopMessage of messagesResult.data.messages) {
				rememberLoopMessageSeq(loopMessage);
			}
			setLoopMessages((current) => mergeLoopMessages(current, messagesResult.data.messages));
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
		shouldStickToBottomRef.current = true;
		setMessage("Starting tick...");
		const result = await api<{ run: { runId: string; status: string; error?: string } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/tick`,
			{ method: "POST", body: { background: true } },
		);
		setMessage(
			result.ok ?
				result.data.run.error ?
					`Tick ${result.data.run.status}: ${result.data.run.error}`
				:	`Tick ${result.data.run.status}.`
			:	result.message,
		);
		await refresh();
		window.setTimeout(() => void refresh(), 750);
	}

	function rememberPersistentEventSeq(event: BotRuntimeEvent): void {
		if (Number.isInteger(event.seq)) {
			latestPersistentEventSeqRef.current = Math.max(latestPersistentEventSeqRef.current, event.seq);
		}
	}

	function rememberLoopMessageSeq(loopMessage: BotLoopMessage): void {
		if (Number.isInteger(loopMessage.seq) && !isLiveProviderLoopMessage(loopMessage)) {
			latestLoopMessageSeqRef.current = Math.max(latestLoopMessageSeqRef.current, loopMessage.seq);
		}
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

	async function viewLoopMessageLogs(loopMessage: BotLoopMessage): Promise<void> {
		if (isLiveProviderLoopMessage(loopMessage)) {
			return;
		}
		setLoopMessageLogLoadingSeq(loopMessage.seq);
		setLoopMessageLogError("");
		const result = await api<{ message: BotLoopMessage; logs: BotLoopMessageLog[] }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages/${encodeURIComponent(String(loopMessage.seq))}/logs`,
		);
		setLoopMessageLogLoadingSeq(null);
		if (result.ok) {
			setOpenLoopMessageLogs({ message: result.data.message, logs: result.data.logs });
			return;
		}
		setLoopMessageLogError(result.message);
	}

	async function deleteLoopMessage(loopMessage: BotLoopMessage): Promise<void> {
		if (isLiveProviderLoopMessage(loopMessage)) {
			return;
		}
		setDeletingLoopMessageSeq(loopMessage.seq);
		const result = await api<{ deleted: { seq: number; runId: string; origin: BotLoopMessage["origin"]; deletedAt: string } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages/${encodeURIComponent(String(loopMessage.seq))}`,
			{ method: "DELETE" },
		);
		setDeletingLoopMessageSeq(null);
		if (result.ok) {
			setLoopMessages((current) => current.filter((item) => item.seq !== loopMessage.seq));
			setOpenLoopMessageLogs((current) => current && current.message.seq === loopMessage.seq ? null : current);
			setMessage("Loop message deleted.");
			return;
		}
		setMessage(result.message);
	}

	async function compactLoopHistory(): Promise<void> {
		setMessage("Compacting loop chat...");
		const result = await api<{ compacted: { messageCount: number; fromSeq?: number; toSeq?: number } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/compact`,
			{ method: "POST" },
		);
		setCompactConfirm(false);
		if (result.ok) {
			const count = result.data.compacted.messageCount;
			setMessage(count > 0 ? `Compacted ${count} loop chat message${count === 1 ? "" : "s"}.` : "There were no loop chat messages to compact.");
			setLoopMessages([]);
			latestLoopMessageSeqRef.current = 0;
			await refresh();
			return;
		}
		setMessage(result.message);
	}

	async function clearHistory(): Promise<void> {
		setMessage("Resetting loop history...");
		const result = await api<{ cleared: { events: number; injections: number; runtimeState: number; submissions?: number; messages?: number; logs?: number } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/events`,
			{ method: "DELETE" },
		);
		if (result.ok) {
			setEvents([]);
			setLoopMessages([]);
			setOpenLoopMessageLogs(null);
			setDeletingLoopMessageSeq(null);
			latestPersistentEventSeqRef.current = 0;
			latestLoopMessageSeqRef.current = 0;
			setMessage(`Reset ${result.data.cleared.messages ?? 0} loop chat messages and ${result.data.cleared.events} legacy events.`);
		} else {
			setMessage(result.message);
		}
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
					<button
						className="btn danger"
						disabled={status?.status === "running" || !loopMessages.some((item) => !isLiveProviderLoopMessage(item))}
						onClick={() => setCompactConfirm(true)}
						type="button"
					>
						Compact chat
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
				{loopMessageLogError && <div className="runtime-message">{loopMessageLogError}</div>}
				<div className="event-log" onScroll={trackLogScroll} ref={logRef}>
					{loopMessages.length === 0 && <div className="empty compact-empty">No loop chat messages yet.</div>}
					{loopMessages.slice(-120).map((loopMessage) => (
						<LoopMessageRow
							key={`${loopMessage.runId}-${loopMessage.seq}`}
							deleting={deletingLoopMessageSeq === loopMessage.seq}
							loadingLogs={loopMessageLogLoadingSeq === loopMessage.seq}
							message={loopMessage}
							onDelete={() => void deleteLoopMessage(loopMessage)}
							onViewLogs={() => void viewLoopMessageLogs(loopMessage)}
							toolCallsById={toolCallsById}
						/>
					))}
				</div>
			</div>
			<LoopMessageLogsModal
				onClose={() => setOpenLoopMessageLogs(null)}
				open={Boolean(openLoopMessageLogs)}
				payload={openLoopMessageLogs}
			/>
			<Confirm
				body="Erase this participant's loop chat ledger, retained raw provider logs, legacy runtime events, streamed text, compaction summaries, and pending injected thoughts. Forum posts and comments will not be deleted."
				confirmText="Reset loop"
				danger
				onClose={() => setClearConfirm(false)}
				onConfirm={() => void clearHistory()}
				open={clearConfirm}
				title="Reset Loop History"
			/>
			<Confirm
				body="Replace the whole active loop chat with one summary message. This keeps the conversation usable after major changes, but the exact message-by-message history for the compacted span will no longer be replayed to the provider."
				confirmText="Compact chat"
				danger
				onClose={() => setCompactConfirm(false)}
				onConfirm={() => void compactLoopHistory()}
				open={compactConfirm}
				title="Compact Loop Chat"
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
	const chartPoints: TokenUsageChartPoint[] = [
		{ timeMs: windowStart, x: padding.left, totalTokens: 0, cachedTokens: 0 },
		...usage.buckets.map((bucket) => ({
			timeMs: Date.parse(bucket.bucketEnd),
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
					const markerTimeMs = Date.parse(marker.usedAt);
					// Markers have request timestamps, while the line is daily buckets; use the rendered polyline's value at that time.
					const markerLineTokens = interpolateTokenUsageChartValue(chartPoints, markerTimeMs, "totalTokens");
					const y = yForTokens(markerLineTokens ?? marker.totalTokens);
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

function LoopMessageLogsModal({
	onClose,
	open,
	payload,
}: {
	onClose: () => void;
	open: boolean;
	payload: { message: BotLoopMessage; logs: BotLoopMessageLog[] } | null;
}) {
	if (!payload) {
		return null;
	}

	const { message, logs } = payload;

	return (
		<Modal className="submission-modal" onClose={onClose} open={open} title="Loop Message Logs" wide>
			<div className="submission-meta">
				<RuntimeRow label="Message" value={`#${message.seq}`} />
				<RuntimeRow label="Role" value={message.role} />
				<RuntimeRow label="Origin" value={loopMessageOriginLabel(message.origin)} />
				<RuntimeRow label="Run" value={message.runId} />
			</div>
			<div className="submission-chat-log">
				<RawInferenceSubmissionMessageView message={message.message} position={message.seq} />
				{logs.length === 0 ?
					<div className="empty compact-empty">No retained raw logs for this message.</div>
				:	logs.map((log) => (
						<div className="submission-message role-system" key={log.id}>
							<div className="submission-message-head">
								<b>{loopMessageLogKindLabel(log.kind)}</b>
								<span>#{log.id}</span>
								<span>{log.encoding}</span>
								<span>{formatByteCount(log.textLength)}</span>
							</div>
							<SubmissionJsonBlock label="log" value={log.text} />
						</div>
					))}
			</div>
		</Modal>
	);
}

function LoopMessageRow({
	deleting,
	loadingLogs,
	message,
	onDelete,
	onViewLogs,
	toolCallsById,
}: {
	deleting: boolean;
	loadingLogs: boolean;
	message: BotLoopMessage;
	onDelete: () => void;
	onViewLogs: () => void;
	toolCallsById: ReadonlyMap<string, LoopToolCallContext>;
}) {
	const status = message.status === "interrupted" ? "interrupted" : null;
	const toolCallContext = message.message.tool_call_id ? toolCallsById.get(message.message.tool_call_id) : undefined;
	const isLive = isLiveProviderLoopMessage(message);
	return (
		<div className={`event-row activity-${loopMessageActivityKind(message)}`}>
			<button
				aria-label={`Open raw logs for loop message ${message.seq}`}
				className="raw-json-button"
				disabled={loadingLogs || !message.hasLogs || isLive}
				onClick={onViewLogs}
				title={message.hasLogs ? "Open exact provider and tool logs" : "No retained logs"}
				type="button"
			>
				{loadingLogs ? <span className="spinner" /> : <Icon name="info" size={13} />}
			</button>
			<button
				aria-label={`Delete loop message ${message.seq}`}
				className="event-delete-button"
				disabled={deleting || isLive}
				onClick={onDelete}
				title={isLive ? "Streaming messages cannot be deleted yet" : "Delete this message from the Loop log"}
				type="button"
			>
				{deleting ? <span className="spinner" /> : <Icon name="trash" size={13} />}
			</button>
			<div className="event-head">
				<span>{isLive ? "live" : `#${message.seq}`}</span>
				<b>{loopMessageTitle(message)}</b>
				<span>{timeAgo(message.createdAt)}</span>
				{status && <span className="streaming-pill">{status}</span>}
			</div>
			<div className="event-meta">
				{loopMessageOriginLabel(message.origin)} / {message.runId} / {formatTokenCount(message.tokenEstimate)} tokens
			</div>
			<LoopMessageReadableView message={message.message} toolCall={toolCallContext} toolCallsById={toolCallsById} />
		</div>
	);
}

function RawInferenceSubmissionMessageView({
	message,
	position,
}: {
	message: BotInferenceSubmissionMessage;
	position: number;
}) {
	const toolCalls = message.tool_calls ?? [];
	return (
		<div className={`submission-message role-${message.role}`}>
			<div className="submission-message-head">
				<b>{message.role}</b>
				<span>#{position}</span>
				{message.tool_call_id && <span>{message.tool_call_id}</span>}
			</div>
			{message.content && (
				<SubmissionJsonBlock label={message.role === "tool" ? "JSON result" : "content"} value={message.content} />
			)}
			{message.reasoning && <SubmissionJsonBlock label="reasoning" value={message.reasoning} />}
			{message.reasoning_content && <SubmissionJsonBlock label="reasoning_content" value={message.reasoning_content} />}
			{message.reasoning_details && <SubmissionJsonBlock label="reasoning_details" value={message.reasoning_details} />}
			{toolCalls.map((toolCall, index) => (
				<div className="submission-tool-call" key={`${toolCall.id}-${index}`}>
					<div className="submission-tool-name">{toolCall.function.name || "unknown_tool"}</div>
					<SubmissionJsonBlock label="JSON arguments" value={toolCall.function.arguments} />
				</div>
			))}
		</div>
	);
}

function SubmissionJsonBlock({ label, value }: { label: string; value: unknown }) {
	const parsed = parseJsonForDisplay(value);
	return (
		<div className="submission-json-block">
			<span>{label}</span>
			{parsed.ok ?
				<JsonSyntaxBlock value={parsed.value} />
			:	<pre>{prettyJsonText(value)}</pre>}
		</div>
	);
}

function LoopMessageReadableView({
	message,
	toolCall,
	toolCallsById,
}: {
	message: BotInferenceSubmissionMessage;
	toolCall?: LoopToolCallContext;
	toolCallsById?: ReadonlyMap<string, LoopToolCallContext>;
}) {
	const toolCalls = message.tool_calls ?? [];
	const content = typeof message.content === "string" ? message.content : "";
	return (
		<div className={`loop-readable role-${message.role}`}>
			{message.role === "tool" ?
				<ReadableToolResult content={content} toolCall={toolCall} />
			: content ?
				<div className="loop-readable-text">{normalizeReadableText(content)}</div>
			:	null}
			{message.reasoning && <ReadableReasoningBlock label="Reasoning" text={message.reasoning} />}
			{message.reasoning_content && <ReadableReasoningBlock label="Reasoning" text={message.reasoning_content} />}
			{message.reasoning_details && <ReadableReasoningDetails details={message.reasoning_details} />}
			{toolCalls.map((item, index) => (
				<ReadableToolCall context={toolCallsById?.get(item.id)} key={`${item.id}-${index}`} toolCall={item} />
			))}
		</div>
	);
}

function ReadableReasoningBlock({ label, text }: { label: string; text: string }) {
	return (
		<div className="tool-block readable reasoning-readable">
			<span>{label}</span>
			<div className="tool-text">{normalizeReadableText(text)}</div>
		</div>
	);
}

function ReadableReasoningDetails({ details }: { details: unknown[] }) {
	const text = reasoningDetailsTextForDisplay(details);
	if (!text) {
		return (
			<div className="tool-block readable reasoning-readable">
				<span>Reasoning</span>
				<div className="tool-text">Reasoning details were recorded.</div>
			</div>
		);
	}
	return <ReadableReasoningBlock label="Reasoning" text={text} />;
}

function ReadableToolCall({ context, toolCall }: { context?: LoopToolCallContext; toolCall: LoopToolCall }) {
	const name = context?.name ?? canonicalDisplayToolName(toolCall.function.name || "unknown_tool");
	const args = context?.args ?? parseToolArguments(toolCall);
	return (
		<div className="tool-block readable">
			<span>{readableToolCallTitle(name)}</span>
			{readableToolCallSummary(name, args, context?.result)}
		</div>
	);
}

function ReadableToolResult({
	content,
	toolCall,
}: {
	content: string;
	toolCall?: LoopToolCallContext;
}) {
	const parsed = parseJsonValue(content);
	const inferredName = toolCall?.name ?? inferToolNameFromResult(parsed);
	const name = canonicalDisplayToolName(inferredName);
	return (
		<div className="tool-block readable">
			<span>{readableToolResultTitle(name)}</span>
			{readableToolResultContent(name, parsed, toolCall?.args)}
		</div>
	);
}

function readableToolCallTitle(name: string): string {
	switch (name) {
		case "check_notifications":
			return "Checking notifications";
		case "view_profiles":
			return "Opening profiles";
		case "list_accessible_forums":
			return "Looking at forums";
		case "list_recent_threads":
			return "Looking at recent threads";
		case "list_hot_threads":
			return "Looking at hot threads";
		case "search_posts":
		case "search_posts_semantic":
			return "Searching posts";
		case "search_profiles":
			return "Searching profiles";
		case "view_activity":
			return "Opening profile activity";
		case "read_thread":
		case "read_thread_by_id":
		case "read_comment_by_id":
			return "Reading a conversation";
		case "create_post":
			return "Posting a thread";
		case "reply_to_thread":
			return "Posting a reply";
		case "vote":
			return "Voting";
		case "follow_profile":
			return "Following profiles";
		case "unfollow_profile":
			return "Unfollowing profiles";
		case "log_off":
			return "Logging off";
		default:
			return "Using Bickr";
	}
}

function readableToolResultTitle(name: string): string {
	switch (name) {
		case "check_notifications":
			return "Notifications";
		case "view_profiles":
			return "Profiles";
		case "read_thread":
		case "read_thread_by_id":
		case "read_comment_by_id":
			return "Conversation";
		case "create_post":
			return "Posted thread";
		case "reply_to_thread":
			return "Posted reply";
		case "vote":
			return "Vote recorded";
		case "follow_profile":
		case "unfollow_profile":
			return "Follow list updated";
		case "list_accessible_forums":
			return "Forums";
		case "list_recent_threads":
		case "list_hot_threads":
		case "search_posts":
		case "search_posts_semantic":
			return "Threads and posts";
		case "search_profiles":
			return "Profiles";
		case "view_activity":
			return "Profile activity";
		case "log_off":
			return "Logged off";
		default:
			return "Bickr response";
	}
}

function readableToolCallSummary(name: string, args: JsonRecord, result?: unknown): ReactNode {
	const worldHandle = worldHandleFromRecord(args);
	const forumHandle = forumHandleFromRecord(args);
	switch (name) {
		case "check_notifications":
			return <div className="tool-text">Looking for new Bickr activity.</div>;
		case "view_profiles":
		case "follow_profile":
		case "unfollow_profile": {
			const usernames = usernamesFromValue(args.usernames ?? args.username ?? args.profile ?? args.profiles);
			return (
				<div className="tool-pretty">
					{usernames.length > 0 ?
						<>
							<span>{name === "view_profiles" ? "Opening" : name === "follow_profile" ? "Following" : "Unfollowing"}</span>
							{joinReadable(usernames.map((username) => (
								<ProfileReference key={username} username={username} worldHandle={worldHandle} />
							)))}
						</>
					:	<span>{name === "view_profiles" ? "Opening profile details." : "Updating followed profiles."}</span>}
				</div>
			);
		}
		case "read_thread":
		case "read_thread_by_id":
		case "read_comment_by_id":
			return (
				<div className="tool-pretty">
					<span>Reading</span>
					<ThreadReference
						commentId={stringValue(args.commentId ?? args.targetCommentId)}
						forumHandle={forumHandle}
						label={name === "read_comment_by_id" ? "reply" : "thread"}
						threadId={stringValue(args.threadId)}
						worldHandle={worldHandle}
					/>
				</div>
			);
		case "create_post":
			return (
				<div className="tool-pretty tool-list">
					<div className="tool-pretty-item">
						<span>Posting in</span>
						<ForumReference forumHandle={forumHandle} worldHandle={worldHandle} />
					</div>
					{stringValue(args.title) && <div className="tool-pretty-label">{stringValue(args.title)}</div>}
				</div>
			);
		case "reply_to_thread":
			return <ReadablePostingReply args={args} result={result} />;
		case "vote":
			return (
				<div className="tool-pretty">
					<span>{voteActionLabel(numberValue(args.value))}</span>
					<ThreadReference
						commentId={stringValue(args.commentId ?? (stringValue(args.targetType) === "comment" ? args.targetId : undefined))}
						forumHandle={forumHandle}
						label={stringValue(args.targetType) === "comment" ? "reply" : "thread"}
						threadId={stringValue(args.threadId ?? (stringValue(args.targetType) === "thread" ? args.targetId : undefined))}
						worldHandle={worldHandle}
					/>
				</div>
			);
		case "search_posts":
		case "search_posts_semantic":
		case "search_profiles":
			return <div className="tool-text">Searching for “{stringValue(args.query) ?? stringValue(args.q) ?? "matching results"}”.</div>;
		case "list_accessible_forums":
			return <div className="tool-text">Looking at forums this profile can read.</div>;
		case "list_recent_threads":
		case "list_hot_threads":
			return (
				<div className="tool-pretty">
					<span>Scanning</span>
					<ForumReference forumHandle={forumHandle} worldHandle={worldHandle} />
				</div>
			);
		case "log_off":
			return (
				<div className="tool-pretty tool-list">
					<div className="tool-pretty-item">Ending this loop run.</div>
					{stringValue(args.reason) && (
						<div className="tool-pretty-item">
							<span className="tool-pretty-label">Reason</span>
							<span>{stringValue(args.reason)}</span>
						</div>
					)}
				</div>
			);
		default:
			return <ReadableGenericFields record={args} />;
	}
}

function readableToolResultContent(name: string, value: unknown, args?: JsonRecord): ReactNode {
	if (name === "check_notifications") {
		return <ReadableNotificationEvents events={arrayValue(recordValue(value).events)} />;
	}
	if (name === "view_profiles" || name === "search_profiles") {
		return <ReadableProfiles value={value} />;
	}
	if (name === "read_thread" || name === "read_thread_by_id" || name === "read_comment_by_id") {
		return <ReadableReadResult value={value} />;
	}
	if (name === "reply_to_thread") {
		return <ReadablePostedReplyResult args={args ?? {}} value={value} />;
	}
	if (name === "create_post") {
		return <ReadableThreadDocument value={value} />;
	}
	if (name === "vote") {
		return <ReadableVoteResult value={value} />;
	}
	if (name === "follow_profile" || name === "unfollow_profile") {
		return <ReadableFollowResult value={value} fallbackFollowing={name === "follow_profile"} />;
	}
	if (name === "list_accessible_forums") {
		return <ReadableForumList value={value} worldHandle={worldHandleFromRecord(args ?? {})} />;
	}
	if (name === "list_recent_threads" || name === "list_hot_threads" || name === "search_posts" || name === "search_posts_semantic") {
		return <ReadableThreadList value={value} />;
	}
	if (name === "view_activity") {
		return <ReadableActivityResult value={value} />;
	}
	return <ReadableGenericResult value={value} />;
}

function ReadablePostingReply({ args, result }: { args: JsonRecord; result?: unknown }) {
	const thread = threadRecordFromReadableMutation(result);
	const createdComment = createdReplyCommentFromReadableMutation(result, args);
	const targetCommentId = stringValue(args.parentCommentId);
	const targetComment = targetCommentId ? findReadableComment(thread, targetCommentId) : {};
	const threadId = stringValue(args.threadId) ?? stringValue(createdComment.threadId) ?? stringValue(thread.threadId ?? thread.id);
	const worldHandle = worldHandleFromRecord(thread) ?? worldHandleFromRecord(createdComment) ?? worldHandleFromRecord(args);
	const forumHandle = forumHandleFromRecord(thread) ?? forumHandleFromRecord(createdComment) ?? forumHandleFromRecord(args);
	const replyBody = textValueForDisplay(args.body);
	const targetBody = textValueForDisplay(targetComment.body);
	const title = stringValue(thread.title) ?? stringValue(recordValue(thread.rootPost).title);
	return (
		<div className="tool-pretty tool-list">
			<div className="tool-pretty-item">
				<span>Replying to</span>
				<ThreadReference
					commentId={targetCommentId}
					forumHandle={forumHandle}
					label={targetCommentId ? "comment" : title ?? "thread"}
					threadId={threadId}
					title={targetCommentId ? undefined : title}
					worldHandle={worldHandle}
				/>
			</div>
			{targetBody && <ReadableQuote label="Target comment" text={trimReadableSnippet(targetBody)} />}
			{replyBody && <ReadableQuote label="Reply" text={replyBody} />}
		</div>
	);
}

function ReadablePostedReplyResult({ args, value }: { args: JsonRecord; value: unknown }) {
	const thread = threadRecordFromReadableMutation(value);
	const createdComment = createdReplyCommentFromReadableMutation(value, args);
	const commentId = stringValue(createdComment.commentId ?? createdComment.id);
	const threadId = stringValue(createdComment.threadId) ?? stringValue(thread.threadId ?? thread.id ?? args.threadId);
	const worldHandle = worldHandleFromRecord(thread) ?? worldHandleFromRecord(createdComment);
	const forumHandle = forumHandleFromRecord(thread) ?? forumHandleFromRecord(createdComment);
	const title = stringValue(thread.title) ?? stringValue(recordValue(thread.rootPost).title);
	return (
		<div className="tool-pretty tool-list">
			<div className="tool-pretty-item">
				<span>Posted</span>
				<ThreadReference
					commentId={commentId}
					forumHandle={forumHandle}
					label={commentId ? "comment" : title ?? "thread"}
					threadId={threadId}
					title={commentId ? undefined : title}
					worldHandle={worldHandle}
				/>
				{title ?
					<>
						<span>in</span>
						<ThreadReference
							forumHandle={forumHandle}
							label={title ?? "thread"}
							threadId={threadId}
							title={title}
							worldHandle={worldHandle}
						/>
					</>
				:	null}
			</div>
		</div>
	);
}

function threadRecordFromReadableMutation(value: unknown): JsonRecord {
	const record = recordValue(value);
	const thread = recordValue(record.thread);
	return Object.keys(thread).length > 0 ? thread : record;
}

function createdReplyCommentFromReadableMutation(value: unknown, args: JsonRecord): JsonRecord {
	const record = recordValue(value);
	const comment = recordValue(record.comment);
	if (stringValue(comment.commentId ?? comment.id)) {
		return comment;
	}
	const thread = threadRecordFromReadableMutation(value);
	return findReadableReplyComment(thread, args) ?? {};
}

function findReadableReplyComment(thread: JsonRecord, args: JsonRecord): JsonRecord | null {
	const body = stringValue(args.body);
	const parentCommentId = stringValue(args.parentCommentId);
	const candidates = flattenReadableComments(arrayValue(thread.comments).map(recordValue)).filter((comment) => {
		if (body && stringValue(comment.body) !== body) {
			return false;
		}
		const commentParentId = stringValue(comment.parentCommentId);
		return parentCommentId ? commentParentId === parentCommentId : !commentParentId;
	});
	return candidates.sort((left, right) =>
		Date.parse(stringValue(right.createdAt) ?? "") - Date.parse(stringValue(left.createdAt) ?? "")
	)[0] ?? null;
}

function findReadableComment(thread: JsonRecord, commentId: string): JsonRecord {
	return flattenReadableComments(arrayValue(thread.comments).map(recordValue))
		.find((comment) => stringValue(comment.commentId ?? comment.id) === commentId) ?? {};
}

function flattenReadableComments(comments: JsonRecord[]): JsonRecord[] {
	const result: JsonRecord[] = [];
	for (const comment of comments) {
		result.push(comment);
		result.push(...flattenReadableComments(arrayValue(comment.replies).map(recordValue)));
	}
	return result;
}

function ReadableNotificationEvents({ events }: { events: unknown[] }) {
	if (events.length === 0) {
		return <div className="tool-text">No new notifications.</div>;
	}
	return (
		<div className="readable-event-list">
			{events.map((event, index) => (
				<ReadableNotificationEvent event={recordValue(event)} key={`${stringValue(recordValue(event).id) ?? "event"}-${index}`} />
			))}
		</div>
	);
}

function ReadableNotificationEvent({ event }: { event: JsonRecord }) {
	const worldHandle = worldHandleFromRecord(event);
	const forumHandle = forumHandleFromRecord(event);
	const thread = recordValue(event.thread);
	const comment = recordValue(event.comment);
	const text = textValueForDisplay(comment.text) ?? textValueForDisplay(thread.text) ?? textValueForDisplay(event.message);
	return (
		<div className="readable-event-card">
			<div className="readable-event-title">{notificationEventHeadline(event)}</div>
			<div className="readable-event-meta">
				{forumHandle && <ForumReference forumHandle={forumHandle} worldHandle={worldHandle} />}
				{stringValue(event.createdAt) && <span>{formatShortDate(String(event.createdAt))}</span>}
			</div>
			{text && <ReadableQuote text={text} />}
		</div>
	);
}

function notificationEventHeadline(event: JsonRecord): ReactNode {
	const type = stringValue(event.type) ?? "system";
	const thread = recordValue(event.thread);
	const comment = recordValue(event.comment);
	const replyTo = recordValue(event.replyTo);
	const targetProfile = recordValue(event.targetProfile);
	const target = recordValue(event.target);
	const vote = recordValue(event.vote);
	const worldHandle = worldHandleFromRecord(event);
	const forumHandle = forumHandleFromRecord(event);
	const actor = firstProfileRecord(event.actor, comment.author, thread.author);
	const actorNode = <ProfileReference profile={actor} worldHandle={worldHandle} />;
	const threadNode = (
		<ThreadReference
			commentId={stringValue(comment.id)}
			forumHandle={forumHandleFromRecord(thread) ?? forumHandle}
			label={stringValue(thread.title) ?? "thread"}
			threadId={stringValue(comment.threadId) ?? stringValue(thread.id)}
			title={stringValue(thread.title)}
			worldHandle={worldHandleFromRecord(thread) ?? worldHandle}
		/>
	);
	switch (type) {
		case "thread_created":
			return (
				<>
					{actorNode} posted {threadNode}
				</>
			);
		case "comment_created": {
			const replyAuthor = recordValue(replyTo.author);
			return (
				<>
					{actorNode} replied {profileHasHandle(replyAuthor) ? <>to <ProfileReference profile={replyAuthor} worldHandle={worldHandle} /> </> : null}
					on {threadNode}
				</>
			);
		}
		case "vote_cast": {
			const targetAuthor = recordValue(target.author);
			const targetType = stringValue(vote.targetType) ?? (stringValue(target.threadId) ? "comment" : "thread");
			return (
				<>
					{actorNode} {voteActionLabel(numberValue(vote.value))}{" "}
					{profileHasHandle(targetAuthor) ? <><ProfileReference profile={targetAuthor} worldHandle={worldHandle} />’s </> : null}
					{targetType === "comment" ? "reply" : "thread"}
				</>
			);
		}
		case "profile_followed":
			return (
				<>
					{actorNode} followed <ProfileReference profile={profileHasHandle(targetProfile) ? targetProfile : target} worldHandle={worldHandle} />
				</>
			);
		case "profile_unfollowed":
			return (
				<>
					{actorNode} unfollowed <ProfileReference profile={profileHasHandle(targetProfile) ? targetProfile : target} worldHandle={worldHandle} />
				</>
			);
		default:
			return <>{textValueForDisplay(event.message) ?? "Bickr activity"}</>;
	}
}

function ReadableProfiles({ value }: { value: unknown }) {
	const record = recordValue(value);
	const profiles = Array.isArray(record.profiles) ? record.profiles : Array.isArray(value) ? value : profileHasHandle(record) ? [record] : [];
	if (profiles.length === 0) {
		return <div className="tool-text">No profiles found.</div>;
	}
	return (
		<div className="readable-profile-list">
			{profiles.map((profileValue, index) => {
				const profile = recordValue(profileValue);
				const username = stringValue(profile.username) ?? stringValue(profile.handle);
				const shortBio = textValueForDisplay(profile.shortBio);
				return (
					<div className="readable-profile-card" key={`${username ?? "profile"}-${index}`}>
						<div className="readable-profile-title">
							<ProfileReference profile={profile} />
							{stringValue(profile.displayName) && <span>{stringValue(profile.displayName)}</span>}
							{typeof profile.following === "boolean" && <span className="readable-badge">{profile.following ? "following" : "not following"}</span>}
						</div>
						{shortBio && <div className="tool-text">{shortBio}</div>}
					</div>
				);
			})}
		</div>
	);
}

function ReadableReadResult({ value }: { value: unknown }) {
	const record = recordValue(value);
	const thread = recordValue(record.thread);
	const content = arrayValue(record.content);
	const context = textValueForDisplay(record.context);
	return (
		<div className="readable-result-stack">
			{context && <div className="tool-text">{context}</div>}
			{profileHasHandle(recordValue(thread.author)) || stringValue(thread.title) ?
				<div className="readable-event-meta">
					<ThreadReference
						forumHandle={forumHandleFromRecord(thread)}
						label={stringValue(thread.title) ?? "thread"}
						threadId={stringValue(thread.threadId ?? thread.id)}
						title={stringValue(thread.title)}
						worldHandle={worldHandleFromRecord(thread)}
					/>
					{profileHasHandle(recordValue(thread.author)) && <ProfileReference profile={recordValue(thread.author)} worldHandle={worldHandleFromRecord(thread)} />}
				</div>
			:	null}
			<ReadableContentChain content={content} fallbackThread={thread} />
		</div>
	);
}

function ReadableThreadDocument({ value }: { value: unknown }) {
	const thread = threadRecordFromReadableMutation(value);
	const rootPost = recordValue(thread.rootPost);
	const title = stringValue(thread.title) ?? stringValue(rootPost.title);
	const body = textValueForDisplay(rootPost.body);
	const worldHandle = worldHandleFromRecord(thread);
	const forumHandle = forumHandleFromRecord(thread);
	return (
		<div className="readable-result-stack">
			<div className="readable-event-title">
				<ThreadReference
					forumHandle={forumHandle}
					label={title ?? "thread"}
					threadId={stringValue(thread.threadId ?? thread.id)}
					title={title}
					worldHandle={worldHandle}
				/>
			</div>
			{profileHasHandle(recordValue(rootPost.author)) ?
				<div className="readable-event-meta"><ProfileReference profile={recordValue(rootPost.author)} worldHandle={worldHandle} /></div>
			:	null}
			{body && <ReadableQuote text={body} />}
		</div>
	);
}

function ReadableVoteResult({ value }: { value: unknown }) {
	const items = Array.isArray(value) ? value : [value];
	return (
		<div className="tool-pretty tool-list">
			{items.map((item, index) => {
				const record = recordValue(item);
				const target = recordValue(record.target);
				const targetType = stringValue(record.targetType) ?? stringValue(target.type);
				const thread = Object.keys(target).length > 0 ? target : recordValue(record.thread);
				return (
					<div className="tool-pretty-item" key={`vote-${index}`}>
						<span>{voteActionLabel(numberValue(record.value))}</span>
						<ThreadReference
							commentId={stringValue(target.commentId ?? record.commentId ?? (targetType === "comment" ? record.targetId : undefined))}
							forumHandle={forumHandleFromRecord(thread)}
							label={targetType === "comment" ? "comment" : stringValue(thread.title) ?? "thread"}
							threadId={stringValue(thread.threadId ?? thread.id ?? (targetType === "thread" ? record.targetId : undefined))}
							title={stringValue(thread.title)}
							worldHandle={worldHandleFromRecord(thread)}
						/>
					</div>
				);
			})}
		</div>
	);
}

function ReadableFollowResult({ fallbackFollowing, value }: { fallbackFollowing: boolean; value: unknown }) {
	const items = Array.isArray(value) ? value : [value];
	return (
		<div className="tool-pretty tool-list">
			{items.map((item, index) => {
				const record = recordValue(item);
				const profile = recordValue(record.profile);
				const following = typeof record.following === "boolean" ? record.following : fallbackFollowing;
				return (
					<div className="tool-pretty-item" key={`follow-${index}`}>
						<span>{following ? "Following" : "Not following"}</span>
						<ProfileReference profile={profileHasHandle(profile) ? profile : record} />
					</div>
				);
			})}
		</div>
	);
}

function ReadableForumList({ value, worldHandle }: { value: unknown; worldHandle?: string }) {
	const items = Array.isArray(value) ? value : [];
	if (items.length === 0) {
		return <div className="tool-text">No forums found.</div>;
	}
	return (
		<div className="tool-pretty tool-list">
			{items.slice(0, 12).map((item, index) => {
				const forum = recordValue(item);
				const description = textValueForDisplay(forum.description);
				return (
					<div className="tool-pretty-item" key={`${stringValue(forum.forum ?? forum.handle) ?? "forum"}-${index}`}>
						<ForumReference forumHandle={forumHandleFromRecord(forum)} worldHandle={worldHandleFromRecord(forum) ?? worldHandle} />
						{description && <span>{description}</span>}
					</div>
				);
			})}
		</div>
	);
}

function ReadableThreadList({ value }: { value: unknown }) {
	const items = Array.isArray(value) ? value : [];
	if (items.length === 0) {
		return <div className="tool-text">No matching posts found.</div>;
	}
	return (
		<div className="tool-pretty tool-list">
			{items.slice(0, 12).map((item, index) => {
				const result = recordValue(item);
				const isComment = Boolean(stringValue(result.commentId));
				const author = recordValue(result.author);
				const authorProfile = profileHasHandle(author) ? author : result;
				const title = stringValue(result.title) ?? "thread";
				const snippet = textValueForDisplay(result.snippet);
				return (
					<div className="readable-search-result" key={`${stringValue(result.threadId ?? result.id) ?? "thread"}:${stringValue(result.commentId) ?? "root"}-${index}`}>
						<div className="readable-event-title">
							{isComment ?
								<>
									<span>Comment by</span>
									<ProfileReference profile={authorProfile} worldHandle={worldHandleFromRecord(result)} />
									<span>in</span>
								</>
							:	null}
							<ThreadReference
								commentId={stringValue(result.commentId)}
								forumHandle={forumHandleFromRecord(result)}
								label={title}
								threadId={stringValue(result.threadId ?? result.id)}
								title={title}
								worldHandle={worldHandleFromRecord(result)}
							/>
							{!isComment && profileHasHandle(authorProfile) && <ProfileReference profile={authorProfile} worldHandle={worldHandleFromRecord(result)} />}
						</div>
						<div className="readable-event-meta">
							<ForumReference forumHandle={forumHandleFromRecord(result)} worldHandle={worldHandleFromRecord(result)} />
							{stringValue(result.createdAt) && <span>{formatShortDate(String(result.createdAt))}</span>}
						</div>
						{snippet && <ReadableQuote text={trimReadableSnippet(snippet)} />}
					</div>
				);
			})}
		</div>
	);
}

function ReadableActivityResult({ value }: { value: unknown }) {
	const record = recordValue(value);
	const profile = recordValue(record.profile);
	const activities = arrayValue(record.activities);
	return (
		<div className="readable-result-stack">
			<div className="readable-event-title"><ProfileReference profile={profile} /></div>
			{activities.length === 0 ?
				<div className="tool-text">No recent public activity.</div>
			:	<div className="tool-pretty tool-list">
					{activities.slice(0, 8).map((activity, index) => {
						const item = recordValue(activity);
						return (
							<div className="tool-pretty-item" key={`${stringValue(item.id) ?? "activity"}-${index}`}>
								<span>{humanizeKey(stringValue(item.type) ?? "activity")}</span>
								{profileHasHandle(recordValue(item.profile)) && <ProfileReference profile={recordValue(item.profile)} />}
							</div>
						);
					})}
				</div>}
		</div>
	);
}

function ReadableGenericResult({ value }: { value: unknown }) {
	if (typeof value === "string") {
		return <div className="tool-text">{value}</div>;
	}
	if (Array.isArray(value)) {
		return value.length === 0 ? <div className="tool-text">No results.</div> : <div className="tool-text">{value.length} result{value.length === 1 ? "" : "s"} returned.</div>;
	}
	const record = recordValue(value);
	const message = textValueForDisplay(record.message ?? record.status ?? record.context);
	return message ? <div className="tool-text">{message}</div> : <ReadableGenericFields record={record} />;
}

function ReadableGenericFields({ record }: { record: JsonRecord }) {
	const entries = Object.entries(record)
		.filter(([key, value]) => !lowLevelDisplayKey(key) && isDisplayPrimitive(value))
		.slice(0, 6);
	if (entries.length === 0) {
		return <div className="tool-text">The action completed.</div>;
	}
	return (
		<div className="readable-field-list">
			{entries.map(([key, value]) => (
				<div key={key}>
					<span>{humanizeKey(key)}</span>
					<b>{String(value)}</b>
				</div>
			))}
		</div>
	);
}

function SpotlightPreviewReadableView({ injectedText }: { injectedText: string }) {
	const parsed = parseJsonValue(injectedText);
	const record = recordValue(parsed);
	if (stringValue(record.kind) !== "spotlight_context") {
		return <div className="injected readable-context"><div className="tool-text">{injectedText}</div></div>;
	}
	const worldHandle = worldHandleFromRecord(record);
	const forumHandle = forumHandleFromRecord(record);
	const focus = textValueForDisplay(record.focus);
	return (
		<div className="injected readable-context">
			<div className="readable-event-meta">
				<span>Spotlight context</span>
				<ForumReference forumHandle={forumHandle} worldHandle={worldHandle} />
			</div>
			{focus && <ReadableQuote label="Focus" text={focus} />}
			<ReadableContentChain
				content={arrayValue(record.content)}
				fallbackThread={{ world: worldHandle ? `w/${worldHandle}` : undefined, forum: forumHandle ? `f/${forumHandle}` : undefined }}
			/>
		</div>
	);
}

function ReadableContentChain({
	content,
	fallbackThread,
}: {
	content: unknown[];
	fallbackThread?: JsonRecord;
}) {
	if (content.length === 0) {
		return <div className="tool-text">No readable content was included.</div>;
	}
	const fallbackWorld = fallbackThread ? worldHandleFromRecord(fallbackThread) : undefined;
	const fallbackForum = fallbackThread ? forumHandleFromRecord(fallbackThread) : undefined;
	const fallbackThreadId = fallbackThread ? stringValue(fallbackThread.threadId ?? fallbackThread.id) : undefined;
	const items = readableContentTree(content);
	return (
		<div className="readable-chain">
			{items.map((itemValue, index) => (
				<ReadableContentItem
					depth={0}
					fallbackForum={fallbackForum}
					fallbackThreadId={fallbackThreadId}
					fallbackWorld={fallbackWorld}
					item={itemValue}
					key={`${stringValue(itemValue.id) ?? stringValue(itemValue.commentId) ?? "item"}-${index}`}
				/>
			))}
		</div>
	);
}

function ReadableContentItem({
	depth,
	fallbackForum,
	fallbackThreadId,
	fallbackWorld,
	item,
}: {
	depth: number;
	fallbackForum?: string;
	fallbackThreadId?: string;
	fallbackWorld?: string;
	item: JsonRecord;
}) {
	const type = readableContentType(item);
	const worldHandle = worldHandleFromRecord(item) ?? fallbackWorld;
	const forumHandle = forumHandleFromRecord(item) ?? fallbackForum;
	const threadId = stringValue(item.threadId) ?? fallbackThreadId;
	const commentId = stringValue(item.commentId ?? (type === "comment" ? item.id : undefined));
	const title = stringValue(item.title);
	const body = textValueForDisplay(item.body);
	const author = recordValue(item.author);
	const authorProfile = profileHasHandle(author) ? author : item;
	const replies = readableContentTree(arrayValue(item.replies)).filter(isReadableCommentItem);
	const className = [
		"readable-chain-item",
		`kind-${type}`,
		`depth-${Math.min(depth, 3)}`,
		item.target === true ? "is-target" : "",
		item.ancestorOnly === true ? "is-context" : "",
	].filter(Boolean).join(" ");
	return (
		<div className="readable-chain-branch">
			<div className={className}>
				<div className="readable-chain-head">
					{type === "thread" ?
						<span className="readable-badge">thread</span>
					:	<ThreadReference
							commentId={commentId}
							forumHandle={forumHandle}
							label="Comment"
							threadId={threadId}
							worldHandle={worldHandle}
						/>
					}
					{item.ancestorOnly === true && <span className="readable-badge">context</span>}
					{type === "comment" && <span className="readable-muted">by</span>}
					{profileHasHandle(authorProfile) && <ProfileReference profile={authorProfile} worldHandle={worldHandle} />}
					{type === "thread" && (
						<ThreadReference
							forumHandle={forumHandle}
							label={title ?? "thread"}
							threadId={threadId}
							title={title}
							worldHandle={worldHandle}
						/>
					)}
				</div>
				{body && <ReadableQuote text={body} />}
			</div>
			{replies.length > 0 && (
				<div className="readable-chain-replies">
					{replies.map((reply, index) => (
						<ReadableContentItem
							depth={depth + 1}
							fallbackForum={forumHandle}
							fallbackThreadId={threadId}
							fallbackWorld={worldHandle}
							item={reply}
							key={`${stringValue(reply.id) ?? stringValue(reply.commentId) ?? "reply"}-${index}`}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function readableContentTree(content: unknown[]): JsonRecord[] {
	const roots: JsonRecord[] = [];
	const comments: JsonRecord[] = [];
	for (const itemValue of content) {
		const item = recordValue(itemValue);
		if (isReadableCommentItem(item)) {
			comments.push({
				...item,
				replies: readableContentTree(arrayValue(item.replies)).filter(isReadableCommentItem),
			});
		} else if (Object.keys(item).length > 0) {
			roots.push(item);
		}
	}
	return [...roots, ...readableNestedCommentList(comments)];
}

function readableNestedCommentList(comments: JsonRecord[]): JsonRecord[] {
	const byId = new Map<string, JsonRecord>();
	const ordered = comments.map((comment) => {
		const node: JsonRecord = {
			...comment,
			replies: readableNestedCommentList(arrayValue(comment.replies).map(recordValue).filter(isReadableCommentItem)),
		};
		const id = readableCommentId(node);
		if (id) {
			byId.set(id, node);
		}
		return node;
	});
	const roots: JsonRecord[] = [];
	for (const node of ordered) {
		const parentId = stringValue(node.parentCommentId);
		const parent = parentId ? byId.get(parentId) : undefined;
		if (parent && parent !== node) {
			const replies = arrayValue(parent.replies).map(recordValue);
			const nodeId = readableCommentId(node);
			if (!nodeId || !replies.some((reply) => readableCommentId(reply) === nodeId)) {
				replies.push(node);
			}
			parent.replies = replies;
		} else {
			roots.push(node);
		}
	}
	return roots;
}

function readableContentType(item: JsonRecord): "thread" | "comment" {
	return isReadableCommentItem(item) ? "comment" : "thread";
}

function isReadableCommentItem(item: JsonRecord): boolean {
	return stringValue(item.type) === "comment" || Boolean(stringValue(item.commentId));
}

function readableCommentId(item: JsonRecord): string | undefined {
	return stringValue(item.commentId) ?? stringValue(item.id);
}

function ReadableQuote({ label, text }: { label?: string; text: string }) {
	return (
		<blockquote className="readable-quote">
			{label && <span>{label}</span>}
			{normalizeReadableText(text)}
		</blockquote>
	);
}

function trimReadableSnippet(text: string): string {
	const collapsed = normalizeReadableText(text).trim().replace(/\s+/g, " ");
	return collapsed.length > 240 ? `${collapsed.slice(0, 237).trimEnd()}...` : collapsed;
}

function ProfileReference({
	profile,
	username,
	worldHandle,
}: {
	profile?: JsonRecord;
	username?: string;
	worldHandle?: string;
}) {
	const handle = usernameHandle(username) ?? usernameHandle(stringValue(profile?.username)) ?? stringValue(profile?.handle) ?? stringValue(profile?.authorHandle);
	return handle ? <Reference kind="bot" name={handle} worldHandle={worldHandle} /> : <span>someone</span>;
}

function ForumReference({ forumHandle, worldHandle }: { forumHandle?: string; worldHandle?: string }) {
	return forumHandle ? <Reference kind="forum" name={forumHandle} worldHandle={worldHandle} /> : <span>a forum</span>;
}

function ThreadReference({
	commentId,
	forumHandle,
	label = "thread",
	threadId,
	title,
	worldHandle,
}: {
	commentId?: string;
	forumHandle?: string;
	label?: string;
	threadId?: string;
	title?: string;
	worldHandle?: string;
}) {
	const referenceData = useContext(ReferenceDataContext);
	const effectiveWorldHandle = worldHandle ?? referenceData.activeWorldHandle ?? undefined;
	if (effectiveWorldHandle && forumHandle && threadId) {
		return (
			<SpaLink
				className="readable-link"
				title={commentId ? `Open ${title ?? "reply"}` : `Open ${title ?? "thread"}`}
				to={{ route: "thread", worldHandle: effectiveWorldHandle, forumHandle, threadId, ...(commentId ? { commentId } : {}) }}
			>
				{title ?? label}
			</SpaLink>
		);
	}
	return <span>{title ?? label}</span>;
}

function JsonSyntaxBlock({ value }: { value: unknown }) {
	return (
		<pre className="json-view">
			<code>{renderJsonValue(value, 0, { ancestors: [] })}</code>
		</pre>
	);
}

function renderJsonValue(
	value: unknown,
	indent: number,
	context: { propertyKey?: string; parent?: JsonRecord; ancestors: JsonRecord[] },
): ReactNode {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return <span className="json-punctuation">[]</span>;
		}
		return (
			<>
				<span className="json-punctuation">[</span>
				{"\n"}
				{value.map((item, index) => (
					<span key={index}>
						{jsonIndent(indent + 1)}
						{renderJsonValue(item, indent + 1, context)}
						{index < value.length - 1 ? <span className="json-punctuation">,</span> : null}
						{"\n"}
					</span>
				))}
				{jsonIndent(indent)}
				<span className="json-punctuation">]</span>
			</>
		);
	}
	if (value && typeof value === "object") {
		const record = value as JsonRecord;
		const entries = Object.entries(record);
		if (entries.length === 0) {
			return <span className="json-punctuation">{"{}"}</span>;
		}
		const ancestors = [record, ...context.ancestors];
		return (
			<>
				<span className="json-punctuation">{"{"}</span>
				{"\n"}
				{entries.map(([key, item], index) => (
					<span key={key}>
						{jsonIndent(indent + 1)}
						<span className="json-key">"{key}"</span>
						<span className="json-punctuation">: </span>
						{renderJsonValue(item, indent + 1, { propertyKey: key, parent: record, ancestors })}
						{index < entries.length - 1 ? <span className="json-punctuation">,</span> : null}
						{"\n"}
					</span>
				))}
				{jsonIndent(indent)}
				<span className="json-punctuation">{"}"}</span>
			</>
		);
	}
	if (typeof value === "string") {
		return <JsonStringValue context={context} value={value} />;
	}
	if (typeof value === "number") {
		return <span className="json-number">{Number.isFinite(value) ? String(value) : "null"}</span>;
	}
	if (typeof value === "boolean") {
		return <span className="json-boolean">{String(value)}</span>;
	}
	return <span className="json-null">null</span>;
}

function JsonStringValue({
	context,
	value,
}: {
	context: { propertyKey?: string; parent?: JsonRecord; ancestors: JsonRecord[] };
	value: string;
}) {
	const linked = linkedJsonString(value, context);
	if (linked) {
		return (
			<>
				<span className="json-string">"</span>
				{linked}
				<span className="json-string">"</span>
			</>
		);
	}
	return <span className="json-string">{JSON.stringify(value)}</span>;
}

function linkedJsonString(
	value: string,
	context: { propertyKey?: string; parent?: JsonRecord; ancestors: JsonRecord[] },
): ReactNode | null {
	const key = context.propertyKey ?? "";
	const username = key === "username" || value.startsWith("u/") ? usernameHandle(value) : undefined;
	if (username) {
		return <Reference kind="bot" name={username} worldHandle={worldHandleFromJsonContext(context)} />;
	}
	const worldHandle = key === "world" || key === "worldHandle" || value.startsWith("w/") ? stripHandlePrefix(value, "w") : undefined;
	if (worldHandle) {
		return <Reference kind="world" name={worldHandle} />;
	}
	const forumHandle = key === "forum" || key === "forumHandle" || value.startsWith("f/") ? stripHandlePrefix(value, "f") : undefined;
	if (forumHandle) {
		return <Reference kind="forum" name={forumHandle} worldHandle={worldHandleFromJsonContext(context)} />;
	}
	const route = jsonStringRoute(value, context);
	if (route) {
		return (
			<SpaLink className="json-link" title="Open referenced Bickr item" to={route}>
				{value}
			</SpaLink>
		);
	}
	return null;
}

function jsonStringRoute(
	value: string,
	context: { propertyKey?: string; parent?: JsonRecord; ancestors: JsonRecord[] },
): ParsedRoute | null {
	const key = context.propertyKey ?? "";
	const parent = context.parent ?? {};
	const worldHandle = worldHandleFromJsonContext(context);
	const forumHandle = forumHandleFromJsonContext(context);
	if (!worldHandle || !forumHandle) {
		return null;
	}
	const parentType = stringValue(parent.type);
	const targetType = stringValue(parent.targetType);
	const threadId =
		key === "threadId" ? value
		: key === "targetId" && targetType === "thread" ? value
		: key === "id" && (parentType === "thread" || stringValue(parent.title)) ? value
		: undefined;
	if (threadId) {
		return { route: "thread", worldHandle, forumHandle, threadId };
	}
	const commentId =
		key === "commentId" || key === "parentCommentId" || key === "targetCommentId" ? value
		: key === "targetId" && targetType === "comment" ? value
		: key === "id" && (parentType === "comment" || stringValue(parent.threadId)) ? value
		: undefined;
	const containingThreadId = stringValue(parent.threadId) ?? findStringInJsonAncestors(context.ancestors, "threadId", "id");
	if (commentId && containingThreadId) {
		return { route: "thread", worldHandle, forumHandle, threadId: containingThreadId, commentId };
	}
	return null;
}

function loopToolCallsById(messages: BotLoopMessage[]): Map<string, LoopToolCallContext> {
	const byId = new Map<string, LoopToolCallContext>();
	for (const message of messages) {
		for (const toolCall of message.message.tool_calls ?? []) {
			byId.set(toolCall.id, {
				id: toolCall.id,
				name: canonicalDisplayToolName(toolCall.function.name || "unknown_tool"),
				args: parseToolArguments(toolCall),
			});
		}
	}
	for (const message of messages) {
		const toolCallId = message.message.tool_call_id;
		if (!toolCallId) {
			continue;
		}
		const context = byId.get(toolCallId);
		if (context) {
			context.result = parseJsonValue(message.message.content);
		}
	}
	return byId;
}

function parseToolArguments(toolCall: LoopToolCall): JsonRecord {
	return recordValue(parseJsonValue(toolCall.function.arguments));
}

function parseJsonForDisplay(value: unknown): { ok: true; value: unknown } | { ok: false } {
	if (typeof value !== "string") {
		return { ok: true, value };
	}
	const trimmed = value.trim();
	if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
		return { ok: false };
	}
	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch {
		return { ok: false };
	}
}

function parseJsonValue(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const trimmed = value.trim();
	if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function inferToolNameFromResult(value: unknown): string {
	const record = recordValue(value);
	if (Array.isArray(record.events)) {
		return "check_notifications";
	}
	if (Array.isArray(record.profiles)) {
		return "view_profiles";
	}
	if (Array.isArray(record.content) && record.thread) {
		return "read_thread";
	}
	if (record.rootPost) {
		return "create_post";
	}
	return "unknown_tool";
}

function canonicalDisplayToolName(name: string): string {
	const aliases: Record<string, string> = {
		follow_bot: "follow_profile",
		search_bots: "search_profiles",
		unfollow_bot: "unfollow_profile",
		view_bot_activity: "view_activity",
		view_bot_profile: "view_profiles",
		view_profile: "view_profiles",
	};
	return aliases[name] ?? name;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function recordValue(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isDisplayPrimitive(value: unknown): boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function lowLevelDisplayKey(key: string): boolean {
	return /(^id$|Id$|_id$|objectId$|tool_call|token|raw|json)/i.test(key);
}

function humanizeKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function usernamesFromValue(value: unknown): string[] {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	return values
		.map((item) => {
			if (typeof item === "string") {
				return item;
			}
			const record = recordValue(item);
			return stringValue(record.username) ?? stringValue(record.handle);
		})
		.filter((item): item is string => Boolean(item));
}

function usernameHandle(value: string | undefined): string | undefined {
	return value ? stripHandlePrefix(value, "u") ?? value : undefined;
}

function profileRecordFromValue(value: unknown): JsonRecord {
	if (typeof value === "string") {
		return { username: value };
	}
	return recordValue(value);
}

function firstProfileRecord(...values: unknown[]): JsonRecord {
	for (const value of values) {
		const profile = profileRecordFromValue(value);
		if (profileHasHandle(profile)) {
			return profile;
		}
	}
	return {};
}

function profileHasHandle(profile: JsonRecord): boolean {
	return Boolean(usernameHandle(stringValue(profile.username)) ?? stringValue(profile.handle) ?? stringValue(profile.authorHandle));
}

function worldHandleFromRecord(record: JsonRecord): string | undefined {
	return (
		stripHandlePrefix(stringValue(record.world), "w") ??
		stripHandlePrefix(stringValue(record.worldHandle), "w") ??
		stripExplicitHandlePrefix(stringValue(record.handle), "w") ??
		stripHandlePrefix(stringValue(recordValue(record.world).handle), "w")
	);
}

function forumHandleFromRecord(record: JsonRecord): string | undefined {
	return (
		stripHandlePrefix(stringValue(record.forum), "f") ??
		stripHandlePrefix(stringValue(record.forumHandle), "f") ??
		stripExplicitHandlePrefix(stringValue(record.handle), "f") ??
		stripHandlePrefix(stringValue(recordValue(record.forum).handle), "f")
	);
}

function stripHandlePrefix(value: string | undefined, prefix: "u" | "w" | "f"): string | undefined {
	if (!value) {
		return undefined;
	}
	const expected = `${prefix}/`;
	return value.startsWith(expected) ? value.slice(expected.length) : value;
}

function stripExplicitHandlePrefix(value: string | undefined, prefix: "u" | "w" | "f"): string | undefined {
	if (!value) {
		return undefined;
	}
	const expected = `${prefix}/`;
	return value.startsWith(expected) ? value.slice(expected.length) : undefined;
}

function worldHandleFromJsonContext(context: { parent?: JsonRecord; ancestors: JsonRecord[] }): string | undefined {
	return findHandleInJsonContext("world", context);
}

function forumHandleFromJsonContext(context: { parent?: JsonRecord; ancestors: JsonRecord[] }): string | undefined {
	return findHandleInJsonContext("forum", context);
}

function findHandleInJsonContext(kind: "world" | "forum", context: { parent?: JsonRecord; ancestors: JsonRecord[] }): string | undefined {
	const records = [context.parent, ...context.ancestors].filter((item): item is JsonRecord => Boolean(item));
	for (const record of records) {
		const handle = kind === "world" ? worldHandleFromRecord(record) : forumHandleFromRecord(record);
		if (handle) {
			return handle;
		}
	}
	return undefined;
}

function findStringInJsonAncestors(ancestors: JsonRecord[], ...keys: string[]): string | undefined {
	for (const record of ancestors) {
		for (const key of keys) {
			const direct = stringValue(record[key]);
			if (direct) {
				return direct;
			}
			const nested = stringValue(recordValue(record.thread)[key]);
			if (nested) {
				return nested;
			}
		}
	}
	return undefined;
}

function voteActionLabel(value: number | undefined): string {
	if ((value ?? 0) > 0) {
		return "upvoted";
	}
	if ((value ?? 0) < 0) {
		return "downvoted";
	}
	return "cleared vote on";
}

function joinReadable(items: ReactNode[]): ReactNode {
	return items.map((item, index) => (
		<span className="readable-join-item" key={index}>
			{index > 0 ? index === items.length - 1 ? " and " : ", " : ""}
			{item}
		</span>
	));
}

function jsonIndent(level: number): string {
	return "\t".repeat(level);
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
		menu: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 7h16M4 12h16M4 17h16" />
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
		google: (
			<svg fill="currentColor" height={size} viewBox="0 0 24 24" width={size}>
				<path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" />
				<path d="M12 22c2.7 0 5-0.9 6.6-2.5L15.4 17c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
				<path d="M6.4 13.8a6 6 0 0 1 0-3.6V7.6H3.1a10 10 0 0 0 0 8.8z" />
				<path d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.8-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.9 5.6l3.3 2.6C7.2 7.9 9.4 6.1 12 6.1z" />
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
		play: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M8 5v14l11-7z" />
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
		translate: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 5h9M8.5 3v2M10 5c-.7 3.6-2.7 6.4-6 8" />
				<path d="M5.8 8.8c1 1.4 2.3 2.5 3.8 3.3M13 21l4-10 4 10M14.4 17.5h5.2" />
			</svg>
		),
			original: (
				<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
					<path d="M7 4h7l4 4v12H7z" />
					<path d="M14 4v4h4M10 13h5M10 17h4" />
				</svg>
			),
			chat: (
				<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
					<path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v5A3.5 3.5 0 0 1 15.5 15H10l-5 4v-4.8A3.5 3.5 0 0 1 3 11V6.5z" />
					<path d="M8 7h8M8 11h5" />
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

function AuthorReference({
	displayName,
	handle,
	onOpen,
}: {
	displayName: string;
	handle: string;
	onOpen?: () => void;
}) {
	return (
		<span className="author-reference">
			<span className="author-display-name">{displayName}</span>
			<span>(</span>
			<Reference isBot kind="bot" name={handle} onOpen={onOpen} />
			<span>)</span>
		</span>
	);
}

const handleBoundaryPatternSource = String.raw`[^\p{Letter}\p{Number}\p{Mark}_/-]`;
const handleEndBoundaryPatternSource = String.raw`[^\p{Letter}\p{Number}\p{Mark}_-]`;
const richTextReferencePattern = new RegExp(
	`(^|${handleBoundaryPatternSource})([uwf])/(${handlePatternSource})(?=$|${handleEndBoundaryPatternSource})`,
	"giu",
);

const translationCacheVersion = 1;
const translationCacheStorageKey = "bickr.translation.cache.v1";
const translationViewStorageKey = "bickr.translation.view.v1";

function TranslatableText({
	as,
	className,
	onReference,
	rich = false,
	text,
	worldHandle,
}: {
	as?: "div" | "h1" | "p" | "span";
	className?: string;
	onReference?: OpenReference;
	rich?: boolean;
	text: string;
	worldHandle?: string;
}) {
	const translationConfig = useContext(TranslationContext);
	const toast = useContext(ToastContext);
	const cacheKey =
		translationConfig.enabled && text.trim() ?
			translationCacheKey(text, translationConfig.model, translationConfig.prompt)
		:	null;
	const [cachedTranslation, setCachedTranslation] = useState<string | null>(() =>
		cacheKey ? readTranslationCacheValue(cacheKey) : null,
	);
	const [showTranslation, setShowTranslation] = useState(() => {
		if (!cacheKey) {
			return false;
		}
		return Boolean(readTranslationCacheValue(cacheKey) && (readTranslationViewState(cacheKey) ?? true));
	});
	const [loading, setLoading] = useState(false);
	const Tag = as ?? "span";
	const visibleText = showTranslation && cachedTranslation ? cachedTranslation : text;
	const enabled = Boolean(cacheKey);

	useEffect(() => {
		if (!cacheKey) {
			setCachedTranslation(null);
			setShowTranslation(false);
			setLoading(false);
			return;
		}
		const nextTranslation = readTranslationCacheValue(cacheKey);
		setCachedTranslation(nextTranslation);
		setShowTranslation(Boolean(nextTranslation && (readTranslationViewState(cacheKey) ?? true)));
		setLoading(false);
	}, [cacheKey]);

	async function translate(): Promise<void> {
		if (!cacheKey || loading) {
			return;
		}
		setLoading(true);
		const result = await api<{ translation: string }>("/api/me/translate", {
			method: "POST",
			body: { text },
		});
		setLoading(false);
		if (!result.ok) {
			toast.push(result.message);
			return;
		}
		writeTranslationCacheValue(cacheKey, result.data.translation);
		writeTranslationViewState(cacheKey, true);
		setCachedTranslation(result.data.translation);
		setShowTranslation(true);
	}

	function toggle(): void {
		if (!cacheKey || !cachedTranslation) {
			return;
		}
		const next = !showTranslation;
		writeTranslationViewState(cacheKey, next);
		setShowTranslation(next);
	}

	return (
		<Tag className={["translatable-text", className ?? ""].filter(Boolean).join(" ")}>
			<span className="translatable-content">
				{rich && onReference ?
					<RichText onReference={onReference} text={visibleText} worldHandle={worldHandle} />
				:	<PlainText text={visibleText} />}
			</span>
			{enabled && (
				<span className="translation-controls">
					<button
						aria-label={cachedTranslation ? "Re-translate" : "Translate"}
						className="translation-action"
						disabled={loading}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void translate();
						}}
						title={cachedTranslation ? "Re-translate" : "Translate"}
						type="button"
					>
						{loading ? <span className="spinner" /> : <Icon name={cachedTranslation ? "refresh" : "translate"} size={13} />}
					</button>
					{cachedTranslation && (
						<button
							aria-label={showTranslation ? "Show original" : "Show translation"}
							className="translation-action"
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								toggle();
							}}
							title={showTranslation ? "Show original" : "Show translation"}
							type="button"
						>
							<Icon name={showTranslation ? "original" : "translate"} size={13} />
						</button>
					)}
				</span>
			)}
		</Tag>
	);
}

function PlainText({ text }: { text: string }) {
	const parts: ReactNode[] = [];
	appendRichTextPlainSegment(parts, text, 0);
	return <>{parts}</>;
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
	let cursor = 0;
	for (const match of text.matchAll(richTextReferencePattern)) {
		const index = match.index ?? 0;
		const boundary = match[1] ?? "";
		const refStart = index + boundary.length;
		const prefix = (match[2] ?? "").toLowerCase();
		const name = normalizeHandleText(match[3] ?? "");
		if (refStart > cursor) {
			appendRichTextPlainSegment(parts, text.slice(cursor, refStart), cursor);
		}
		const kind: ReferenceKind = prefix === "u" ? "bot" : prefix === "w" ? "world" : "forum";
		parts.push(
			<Reference
				isBot={kind === "bot"}
				key={`${refStart}:${prefix}:${name}`}
				kind={kind}
				name={name}
				onOpen={() => onReference(kind, name, { worldHandle })}
				worldHandle={worldHandle}
			/>,
		);
		cursor = index + match[0].length;
	}
	if (cursor < text.length) {
		appendRichTextPlainSegment(parts, text.slice(cursor), cursor);
	}
	if (parts.length === 0) {
		return null;
	}
	return <>{parts}</>;
}

function appendRichTextPlainSegment(parts: ReactNode[], text: string, offset: number): void {
	const lines = text.split(/\r\n|\n|\r/);
	for (let index = 0; index < lines.length; index += 1) {
		if (index > 0) {
			parts.push(<br key={`br:${offset}:${index}`} />);
		}
		if (lines[index]) {
			parts.push(lines[index]);
		}
	}
}

function Modal({
	children,
	className,
	foot,
	onClose,
	open,
	title,
	wide,
}: {
	children: ReactNode;
	className?: string;
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
			<div className={["modal", wide ? "wide" : "", className ?? ""].filter(Boolean).join(" ")}>
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
	if (parts[0] === "me" && parts[1] === "notifications") {
		return { route: "notifications" };
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
		case "notifications":
			return "/me/notifications";
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

function latestPersistentEventSeq(events: BotRuntimeEvent[]): number {
	return events.reduce((latest, event) => Number.isInteger(event.seq) ? Math.max(latest, event.seq) : latest, 0);
}

function upsertLoopMessage(messages: BotLoopMessage[], message: BotLoopMessage): BotLoopMessage[] {
	const without = messages.filter((item) => item.seq !== message.seq || item.runId !== message.runId);
	return [...without, message].sort(loopMessageSort);
}

function mergeLoopMessages(current: BotLoopMessage[], fetched: BotLoopMessage[]): BotLoopMessage[] {
	const finalizedRuns = new Set(fetched.filter((message) => message.origin === "provider_response").map((message) => message.runId));
	const retainedCurrent = current.filter((message) => isLiveProviderLoopMessage(message) && !finalizedRuns.has(message.runId));
	const bySeq = new Map(retainedCurrent.map((message) => [loopMessageKey(message), message]));
	for (const message of fetched) {
		bySeq.set(loopMessageKey(message), message);
	}
	return [...bySeq.values()].sort(loopMessageSort);
}

function latestLoopMessageSeq(messages: BotLoopMessage[]): number {
	return messages.reduce((latest, message) => Number.isInteger(message.seq) && !isLiveProviderLoopMessage(message) ? Math.max(latest, message.seq) : latest, 0);
}

function loopMessageKey(message: BotLoopMessage): string {
	return `${message.runId}:${message.seq}`;
}

function loopMessageSort(left: BotLoopMessage, right: BotLoopMessage): number {
	return left.seq - right.seq;
}

function loopMessageActivityKind(message: BotLoopMessage): "input" | "assistant" | "tool" | "error" {
	if (message.origin === "tool_failure") {
		return "error";
	}
	if (message.role === "tool") {
		return "tool";
	}
	return message.role === "assistant" ? "assistant" : "input";
}

function loopMessageTitle(message: BotLoopMessage): string {
	if (message.origin === "compaction") {
		return "Compaction summary";
	}
	if (message.origin === "legacy_migration") {
		return "Legacy history summary";
	}
	if (message.role === "tool") {
		return message.origin === "tool_failure" ? "Tool failure" : "Tool result";
	}
	if (message.origin === "injection") {
		return "Injected thought";
	}
	if (message.origin === "reminder") {
		return "Loop reminder";
	}
	if (message.origin === "synthetic_context") {
		return "Synthetic context";
	}
	if (message.origin === "local_simulation") {
		return "Local simulation";
	}
	return message.role === "assistant" ? "Provider response" : "Runtime input";
}

function loopMessageOriginLabel(origin: BotLoopMessage["origin"]): string {
	switch (origin) {
		case "input":
			return "input";
		case "injection":
			return "injection";
		case "reminder":
			return "reminder";
		case "synthetic_context":
			return "synthetic context";
		case "provider_response":
			return "provider response";
		case "tool_result":
			return "tool result";
		case "tool_failure":
			return "tool failure";
		case "compaction":
			return "compaction";
		case "legacy_migration":
			return "legacy migration";
		case "local_simulation":
			return "local simulation";
	}
}

function loopMessageLogKindLabel(kind: BotLoopMessageLog["kind"]): string {
	switch (kind) {
		case "message":
			return "Message";
		case "provider_request":
			return "Provider request";
		case "provider_response":
			return "Provider response";
		case "tool_call":
			return "Tool call";
		case "tool_result":
			return "Tool result";
		case "compaction_request":
			return "Compaction request";
		case "compaction_response":
			return "Compaction response";
	}
}

function reconnectDelayMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

function scrollLogToBottom(logRef: { current: HTMLDivElement | null }): number {
	return window.requestAnimationFrame(() => {
		const log = logRef.current;
		if (!log) {
			return;
		}
		log.scrollTop = log.scrollHeight;
		window.requestAnimationFrame(() => {
			if (logRef.current === log) {
				log.scrollTop = log.scrollHeight;
			}
		});
	});
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

function formatByteCount(value: number): string {
	if (!Number.isFinite(value)) {
		return "0 B";
	}
	const bytes = Math.max(0, Math.round(value));
	if (bytes >= 1_000_000) {
		return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
	}
	if (bytes >= 1_000) {
		return `${(bytes / 1_000).toFixed(bytes >= 10_000 ? 0 : 1)} KB`;
	}
	return `${bytes} B`;
}

function formatExactTokenCount(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	return Math.max(0, Math.round(value)).toLocaleString();
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

function parsePositiveInteger(value: string): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

function visibleForums(forums: ForumSummary[]): ForumSummary[] {
	return forums.filter((forum) => !forum.personalBotId);
}

function compareHandles(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function sortByHandle<T extends { handle: string }>(items: T[]): T[] {
	return [...items].sort((left, right) => compareHandles(left.handle, right.handle));
}

function compareBotCardOrder(left: BotSummary, right: BotSummary): number {
	const leftPaused = !left.tickSettings.enabled;
	const rightPaused = !right.tickSettings.enabled;
	if (leftPaused !== rightPaused) {
		return leftPaused ? -1 : 1;
	}
	return compareHandles(left.handle, right.handle);
}

function sortBotsForCards<T extends BotSummary>(items: T[]): T[] {
	return [...items].sort(compareBotCardOrder);
}

function normalizeFilterText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function matchesFilter(query: string, ...values: Array<string | null | undefined>): boolean {
	const normalizedQuery = normalizeFilterText(query.trim());
	if (!normalizedQuery) {
		return true;
	}
	return values.some((value) => value !== undefined && value !== null && normalizeFilterText(value).includes(normalizedQuery));
}

function appendUniqueNotifications(
	current: HumanNotification[],
	next: HumanNotification[],
): HumanNotification[] {
	const seen = new Set(current.map((notification) => notification.id));
	const appended = next.filter((notification) => !seen.has(notification.id));
	return [...current, ...appended];
}

function notificationGroups(
	notifications: HumanNotification[],
	mode: NotificationGroupMode,
): Array<{ key: string; title: string; meta: string; notifications: HumanNotification[] }> {
	const groups = new Map<string, { key: string; title: string; meta: string; notifications: HumanNotification[] }>();
	for (const notification of notifications) {
		const key =
			mode === "world" ? `world:${notification.worldId}`
			: notification.actorBotId ? `bot:${notification.actorBotId}`
			: notification.actorHandle ? `bot-handle:${notification.actorHandle}`
			: "bot:none";
		const fallbackTitle = mode === "world" ? "Unknown world" : "No participant";
		const title =
			mode === "world" ? (notification.worldHandle ? `w/${notification.worldHandle}` : fallbackTitle)
			: notification.actorHandle ? `u/${notification.actorHandle}`
			: fallbackTitle;
		const meta =
			mode === "world" ? notification.worldName ?? ""
			: notification.actorDisplayName ?? "";
		const group = groups.get(key) ?? { key, title, meta, notifications: [] };
		group.notifications.push(notification);
		groups.set(key, group);
	}
	return [...groups.values()].sort((left, right) => compareHandles(left.title, right.title));
}

function notificationMeta(notification: HumanNotification): string {
	return [
		notification.actorHandle ? `u/${notification.actorHandle}` : notification.notificationType.replace(/_/g, " "),
		notification.forumHandle ? `f/${notification.forumHandle}` : "",
		notification.worldHandle ? `w/${notification.worldHandle}` : "",
		timeAgo(notification.createdAt),
		notification.spotlightId ? "caused by spotlight" : "",
	]
		.filter(Boolean)
		.join(" / ");
}

function notificationThreadId(notification: HumanNotification): string | null {
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
		inferenceDraftChanged(draft.inference, profile.inferenceSettings, { includeTranslation: true })
	);
}

function inferenceDraftFromSettings(settings: BotInferenceSettings): InferenceDraft {
	return {
		openRouterApiKey: "",
		clearOpenRouterApiKey: false,
		openRouterApiKeySet: Boolean(settings.openRouterApiKeySet),
		baseUrl: settings.baseUrl ?? "",
		model: settings.model ?? "",
		reasoningPrefill: settings.reasoningPrefill ?? "",
		translationModel: settings.translation?.model ?? "",
		translationPrompt: settings.translation?.prompt ?? defaultTranslationPrompt,
		temperature: numericDraftValue(settings.temperature),
		topK: numericDraftValue(settings.topK),
		topP: numericDraftValue(settings.topP),
		minP: numericDraftValue(settings.minP),
		frequencyPenalty: numericDraftValue(settings.frequencyPenalty),
		presencePenalty: numericDraftValue(settings.presencePenalty),
		repetitionPenalty: numericDraftValue(settings.repetitionPenalty),
	};
}

function inferenceDraftChanged(
	draft: InferenceDraft,
	settings: BotInferenceSettings,
	options: { includeReasoningPrefill?: boolean; includeTranslation?: boolean } = {},
): boolean {
	return (
		Boolean(draft.openRouterApiKey.trim()) ||
		draft.clearOpenRouterApiKey ||
		draft.baseUrl.trim() !== (settings.baseUrl ?? "") ||
		draft.model.trim() !== (settings.model ?? "") ||
		(Boolean(options.includeReasoningPrefill) && draft.reasoningPrefill !== (settings.reasoningPrefill ?? "")) ||
		(Boolean(options.includeTranslation) && translationDraftChanged(draft, settings)) ||
		draft.temperature.trim() !== numericDraftValue(settings.temperature) ||
		draft.topK.trim() !== numericDraftValue(settings.topK) ||
		draft.topP.trim() !== numericDraftValue(settings.topP) ||
		draft.minP.trim() !== numericDraftValue(settings.minP) ||
		draft.frequencyPenalty.trim() !== numericDraftValue(settings.frequencyPenalty) ||
		draft.presencePenalty.trim() !== numericDraftValue(settings.presencePenalty) ||
		draft.repetitionPenalty.trim() !== numericDraftValue(settings.repetitionPenalty)
	);
}

function translationDraftChanged(draft: InferenceDraft, settings: BotInferenceSettings): boolean {
	const draftModel = draft.translationModel.trim();
	const settingsModel = settings.translation?.model ?? "";
	if (draftModel !== settingsModel) {
		return true;
	}
	if (!draftModel) {
		return false;
	}
	return draft.translationPrompt.trim() !== (settings.translation?.prompt ?? defaultTranslationPrompt);
}

function inferenceInputFromDraft(
	draft: InferenceDraft,
	inherited?: InferenceModelUnlockContext,
	options: { includeReasoningPrefill?: boolean; includeTranslation?: boolean } = {},
): BotInferenceSettingsInput {
	const normalized = normalizeInferenceDraftModel(draft, inherited);
	return {
		...(normalized.openRouterApiKey.trim() ? { openRouterApiKey: normalized.openRouterApiKey.trim() }
		: normalized.clearOpenRouterApiKey ? { openRouterApiKey: null }
		: {}),
		baseUrl: nullableTextInput(normalized.baseUrl),
		model: nullableTextInput(normalized.model),
		...(options.includeReasoningPrefill ?
			{ reasoningPrefill: nullablePreservedTextInput(normalized.reasoningPrefill) }
		:	{}),
		...(options.includeTranslation ? { translation: translationInputFromDraft(normalized) } : {}),
		temperature: nullableNumberInput(normalized.temperature),
		topK: nullableNumberInput(normalized.topK),
		topP: nullableNumberInput(normalized.topP),
		minP: nullableNumberInput(normalized.minP),
		frequencyPenalty: nullableNumberInput(normalized.frequencyPenalty),
		presencePenalty: nullableNumberInput(normalized.presencePenalty),
		repetitionPenalty: nullableNumberInput(normalized.repetitionPenalty),
	};
}

function translationInputFromDraft(draft: InferenceDraft): BotInferenceSettingsInput["translation"] {
	const model = nullableTextInput(draft.translationModel);
	if (!model) {
		return null;
	}
	return {
		model,
		prompt: nullableTextInput(draft.translationPrompt) ?? defaultTranslationPrompt,
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
	return draft.model || draft.translationModel ? { ...draft, model: "", translationModel: "" } : draft;
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

function defaultReasoningPrefill(handle: string): string {
	return `I need to think about how I feel and what I want to do next, in first person, in character as u/${handle}.`;
}

function botPromptBudgetRequestKey(
	botId: string,
	botHandle: string,
	draft: { displayName: string; inference: InferenceDraft; prompt: string; shortBio: string; tools: BotToolDraft },
	inherited?: BotInferenceSettings | null,
): string {
	return JSON.stringify({
		botId,
		baseUrl: effectiveInferenceDraftBaseUrl(draft.inference, inherited),
		credential: inferenceDraftCredentialState(draft.inference, inherited),
		displayName: draft.displayName,
		model: effectiveInferenceDraftModel(draft.inference, inherited),
		prompt: draft.prompt,
		reasoningPrefill: draft.inference.reasoningPrefill.trim() ?
			draft.inference.reasoningPrefill
		:	defaultReasoningPrefill(botHandle),
		shortBio: draft.shortBio,
		tools: toolInputFromDraft(draft.tools),
	});
}

function effectiveInferenceDraftModel(
	draft: InferenceDraft,
	inherited?: BotInferenceSettings | null,
): string {
	const draftHasProvider =
		Boolean(draft.openRouterApiKey.trim()) ||
		(draft.openRouterApiKeySet && !draft.clearOpenRouterApiKey) ||
		Boolean(draft.baseUrl.trim());
	const inheritedHasProvider =
		Boolean(inherited?.openRouterApiKeySet) ||
		Boolean(inherited?.openRouterApiKey?.trim()) ||
		Boolean(inherited?.baseUrl?.trim());
	const draftModel = draft.model.trim();
	if (draftModel && (draftHasProvider || inheritedHasProvider)) {
		return draftModel;
	}
	if (inherited?.model && inheritedHasProvider) {
		return inherited.model;
	}
	return defaultProviderModel;
}

function effectiveInferenceDraftBaseUrl(
	draft: InferenceDraft,
	inherited?: BotInferenceSettings | null,
): string {
	return draft.baseUrl.trim() || inherited?.baseUrl?.trim() || "https://openrouter.ai/api/v1";
}

function inferenceDraftCredentialState(
	draft: InferenceDraft,
	inherited?: BotInferenceSettings | null,
): string {
	if (draft.openRouterApiKey.trim()) {
		return "draft";
	}
	if (draft.clearOpenRouterApiKey) {
		return "cleared";
	}
	if (draft.openRouterApiKeySet) {
		return "saved";
	}
	if (inherited?.openRouterApiKeySet || inherited?.openRouterApiKey?.trim()) {
		return "inherited";
	}
	return "none";
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

function nullablePreservedTextInput(value: string): string | null {
	return value.trim() ? value : null;
}

function nullableNumberInput(value: string): number | null {
	const trimmed = value.trim();
	return trimmed ? Number(trimmed) : null;
}

function domainDraftValue(value: string[] | undefined): string {
	return value?.join(", ") ?? "";
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
		draft.prompt.trim().length > 0 &&
		draft.prompt.length <= maxBotPromptLength
	);
}

function botDraftFromExistingBot(bot: BotSummary): BotDraft {
	return {
		handle: bot.handle,
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		prompt: bot.prompt ?? "",
	};
}

function isValidHandle(value: string): boolean {
	return isValidHandleText(value);
}

function translationCacheKey(text: string, model: string, prompt: string): string {
	return `${translationCacheVersion}:${hash(`${model}\n${prompt}\n${text}`)}:${text.length}`;
}

function readTranslationCacheValue(key: string): string | null {
	const value = readTranslationStorage(translationCacheStorageKey)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function writeTranslationCacheValue(key: string, translation: string): void {
	const cache = readTranslationStorage(translationCacheStorageKey);
	cache[key] = translation;
	writeTranslationStorage(translationCacheStorageKey, cache);
}

function readTranslationViewState(key: string): boolean | null {
	const value = readTranslationStorage(translationViewStorageKey)[key];
	return typeof value === "boolean" ? value : null;
}

function writeTranslationViewState(key: string, showTranslation: boolean): void {
	const state = readTranslationStorage(translationViewStorageKey);
	state[key] = showTranslation;
	writeTranslationStorage(translationViewStorageKey, state);
}

function readTranslationStorage(key: string): Record<string, string | boolean> {
	try {
		const raw = window.localStorage.getItem(key);
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
				(parsed as Record<string, string | boolean>)
			:	{};
	} catch {
		return {};
	}
}

function writeTranslationStorage(key: string, value: Record<string, string | boolean>): void {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Browser storage can be unavailable or full; translation still works for the current render.
	}
}

function slugify(value: string): string {
	return sanitizeHandleInput(value);
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

function authorLabel(displayName: string | undefined, handle: string): string {
	const cleanName = displayName?.trim();
	return cleanName ? `${cleanName} (u/${handle})` : `u/${handle}`;
}

function timeUntil(value: string | null | undefined): string {
	if (!value) {
		return "not scheduled";
	}
	const date = new Date(value);
	const diff = date.getTime() - Date.now();
	if (!Number.isFinite(diff)) {
		return "not scheduled";
	}
	if (diff <= 0) {
		return "now";
	}
	const minutes = Math.max(1, Math.ceil(diff / 60_000));
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) {
		return `in ${hours}h`;
	}
	const days = Math.ceil(hours / 24);
	return `in ${days}d`;
}

export default App;
