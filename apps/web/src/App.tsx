import { worldAvatarMembersPromptUserContent } from "@bickr/shared/avatar-prompts";
import {
	authProviders,
	defaultProviderModel,
	defaultTextGenerationTemperature,
	defaultTranslationPrompt,
	localizedText,
	localizedTextLang,
	localizedTextString,
	openRouterSuggestedImageAspectRatios,
	openRouterSuggestedImageSizes,
	type AuthProvider,
	type AvatarCrop,
	type BotCompactionMode,
	type BotGroupSummary,
	type BotInferenceSettings,
	type BotInferenceSettingsInput,
	type BotPromptCacheMode,
	type BotPublicProfile,
	type BotSummary,
	type BotTickSpreadResult,
	type BotTokenSpendSummary,
	type CommentDocument,
	type CreateForumInput,
	type CreateWorldInput,
	type ForumSummary,
	type GlobalInferenceCostPublicStats,
	type HumanNotification,
	type HumanNotificationListScope,
	type HumanNotificationReadScope,
	type HumanNotificationSummary,
	type HumanOwnedBotGroup,
	type HumanOwnedForumGroup,
	type HumanOwnedTotals,
	type HumanProfile,
	type HumanProfileDeleteBlocker,
	type HumanSubscription,
	type HumanSubscriptionCommentNode,
	type HumanSubscriptionForumNode,
	type HumanSubscriptionScope,
	type HumanSubscriptionThreadNode,
	type HumanSubscriptionTreeResponse,
	type HumanSubscriptionWorldNode,
	type LanguageTag,
	type LinkedAuthIdentity,
	type LocalizedText,
	type PublicUser,
	type SearchEntityType,
	type SearchMode,
	type SearchResponse,
	type SearchResult,
	type ThreadDocument,
	type ThreadSummary,
	type UpdateBotInput,
	type UpdateForumInput,
	type UpdateUserProfileInput,
	type UpdateWorldInput,
	type UserProfile,
	type WorldListSummary,
	type WorldSummary
} from "@bickr/shared/model";
import { personalForumDescription } from "@bickr/shared/personal-forums";
import {
	handleHelpText,
	isValidHandleText
} from "@bickr/shared/validation";
import type {
	CSSProperties,
	MouseEvent as ReactMouseEvent,
	ReactNode,
} from "react";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import "./App.css";
import {
	avatarImagePixels,
	cloudflareImageUrl,
} from "./avatar-image-urls";
import { AvatarCropModal } from "./avatar/AvatarCropModal";
import {
	AvatarGenerationScreen,
	type AvatarGenerationDraftAdapter,
	type OpenRouterImageModel,
} from "./avatar/AvatarGenerationScreen";
import { AvatarUploadModal } from "./avatar/AvatarUploadModal";
import {
	botAvatarTarget,
	userAvatarTarget,
	worldAvatarTarget,
	type AvatarTextPromptFillMode,
} from "./avatar/target";
import {
	HoverTooltipContext,
	HumanReference,
	Reference,
	ReferenceDataContext,
	ReferencePopover,
	TranslatableText,
	TranslationContext,
	referenceMeta,
	type HoverTooltipContextValue,
	type ReferenceData,
	type ReferenceKind,
	type TranslationContextValue,
	type WorldView
} from "./components/content";
import {
	NavigationContext,
	SpaLink,
	shouldHandleSpaClick,
	type ContentRefType,
	type OpenContentRefOptions,
} from "./components/navigation";
import {
	UiTextContext,
	effectiveUiLocalePreference,
	languageDirection,
	languageDraftValue,
	languageInputValue,
	uiLocaleOptions,
	uiTextByLocale,
	useUiText
} from "./components/ui-text";
import {
	defaultFontScalePercent,
	fontScaleCssValue,
	readFontScalePercent,
	writeFontScalePercent,
	type FontScalePercent,
} from "./font-scale";
import { defaultLanguageTag } from "./language";
import {
	compareMyBotTableRecords,
	defaultMyBotsSortState,
	modelColorHue,
	myBotsRunTickSelection,
	myBotsSortStorageKey,
	myBotsSpendTotal,
	parseMyBotsSortState,
	type MyBotSpendLoadState,
	type MyBotsSortKey,
	type MyBotsSortState,
	type MyBotsSpendTotal,
} from "./my-bots-table";
import {
	allSearchTypes,
	defaultSearchRouteState,
	normalizeLoggedOutRoute,
	parsePathname,
	routePath,
	type BotProfileTab,
	type ParsedRoute,
	type Route,
	type SearchRouteState,
	type WorldTab,
} from "./routes";
import {
	BotEdit,
	BotLoopScreen,
	BotProfileScreen,
	CreateBotModal,
	RuntimeRow,
	effectiveBotModel,
	effectiveNumberPlaceholder,
	effectiveOptionalNumberPlaceholder,
	isValidHandle,
	providerRoutingPlaceholderForInheritance,
	rebaseInferenceDraftForFallbackChange,
	slugify
} from "./screens/bots";
import { createBotInputFromDraft, type BotDraft } from "./screens/bots/bot-drafts";
import {
	formatAverageDays,
	formatExactTokenCount,
	formatPerMillionTokenCost,
	formatTokenCost,
	formatTokenCostParts,
	globalInferenceCostFractionDigits,
} from "./screens/bots/token-usage";
import {
	BickrLogo,
	NotificationBody,
	NotificationSwipeDismissFrame,
	Sidebar,
	SpotlightNotificationBadge,
	Topbar,
	authProviderLabel,
	authStartHref,
	banners,
	formatFullDate,
	formatShortDate,
	notificationHref,
	notificationMeta,
	notificationRoute,
	searchResultMeta,
	timeAgo,
	timeAgoWithAgo,
	timestampTitle,
	type ThemePreference,
} from "./screens/chrome";
import { ForumPage, ThreadPage } from "./screens/forums";
import { WorldsScreen } from "./screens/worlds";
import { WorldDetail } from "./screens/worlds/world-detail";
import { WorldEditPage } from "./screens/worlds/world-edit";
import {
	effectiveInferenceDraftBaseUrl,
	effectiveInferenceDraftModel,
	inferenceCapabilityContext,
	inferenceCapabilityContextForDraft,
	inferenceFallbackContextForDraft,
	providerRoutingDraftError
} from "./settings-drafts/common";
import { imageGenerationInputFromDraft } from "./settings-drafts/image-generation-draft";
import {
	inferenceDraftChanged,
	inferenceDraftFromSettings,
	inferenceInputFromDraft,
	normalizeInferenceDraftForCapabilities,
	promptFillSettingsInputFromDraft,
	type InferenceDraft
} from "./settings-drafts/inference-draft";
import { normalizeTranslationDraftForCapabilities } from "./settings-drafts/translation-draft";
import {
	cycleSubscriptionContainer,
	filterSubscriptionTree,
	subscriptionChangesFromDraft,
	subscriptionKeysFromTree,
	subscriptionNodeState,
	subscriptionNodesByKey,
	subscriptionTargetKey,
	subscriptionTreeIsEmpty,
	toggleSubscriptionTarget,
	type RememberedSubscriptionDescendants,
	type SubscriptionTreeNode,
} from "./subscriptions-tree";
import {
	globalInferenceCostTableHeaders,
	globalInferenceCostTableRows
} from "./token-usage-chart";
import {
	type BotToolDraft,
	type OpenRouterDatetimeToolDraft,
	type OpenRouterWebFetchToolDraft,
	type OpenRouterWebSearchToolDraft
} from "./tool-settings-draft";
import {
	Avatar,
	Confirm,
	EmptyState,
	FallbackImage,
	Field,
	FilterBox,
	Icon,
	ImageLightbox,
	Modal,
	PermissionState,
	ToastContext,
	ToastProvider,
	hash,
	textValue,
	type TextLike,
} from "./ui";
import { runApiAction, useApiQuery } from "./use-api";

export {
effectiveBotModel,
effectiveNumberPlaceholder,
effectiveOptionalNumberPlaceholder,
isValidHandle,
optionalNumberDraftValue,
providerRoutingPlaceholderForInheritance,
rebaseInferenceDraftForFallbackChange,
slugify
} from "./screens/bots/bot-drafts";
export { RuntimeRow } from "./screens/bots/runtime-row";
export { formatTickIntervalMinutes } from "./screens/bots/runtime-utils";


type BotMutationResponse = { bot: BotSummary; affectedBots?: BotSummary[] };
type UserMutationResponse = { profile: UserProfile };

type BeforeInstallPromptEvent = Event & {
	platforms: string[];
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function throwApiError(message: string): never {
	throw new Error(message);
}

type SessionState = {
	authenticated: boolean;
	user: PublicUser | null;
};

export type BotActivityKindFilter = "all" | "posts" | "replies" | "votes" | "follows";
type HumanProfileTab = "worlds" | "forums" | "bots";
type IncludeLanguageInSystemPromptDraft = "include" | "exclude" | "inherit";
type NotificationGroupMode = "world" | "bot";
export type LoadHumanNotifications = (
	status: "unread" | "all",
	limit?: number,
	offset?: number,
	scope?: HumanNotificationListScope,
) => Promise<HumanNotificationSummary | null>;

const avatarGenerationDraftAdapter: AvatarGenerationDraftAdapter<InferenceDraft> = {
	configError: imageGenerationConfigDraftError,
	fromSettings: inferenceDraftFromSettings,
	imageGenerationInput: imageGenerationInputFromDraft,
	model: (draft) => draft.imageGenerationModel,
	providerRoutingError: (draft) => providerRoutingDraftError(draft.imageGenerationProviderRouting),
	renderAdvancedFields: (draft, onChange) => <ImageGenerationAdvancedFields draft={draft} onChange={onChange} />,
	renderBasicFields: (draft, models, onChange) => <ImageGenerationBasicFields draft={draft} models={models} onChange={onChange} />,
	withPrompt: (draft, prompt) => ({ ...draft, imageGenerationPrompt: prompt }),
};

type ProfileDraft = {
	handle: string;
	language: string;
	uiLocale: string;
	displayName: string;
	inference: InferenceDraft;
};

export type SubscriptionTarget = {
	scopeType: HumanSubscriptionScope;
	scopeId: string;
	worldId: string;
};



const languageExamples = [
	{ label: "English", value: "en" },
	{ label: "Spanish", value: "es" },
	{ label: "Chinese (Simplified)", value: "zh-Hans" },
	{ label: "Chinese (Traditional)", value: "zh-Hant" },
	{ label: "Japanese", value: "ja" },
	{ label: "Russian", value: "ru" },
	{ label: "Ukrainian", value: "uk" },
	{ label: "Esperanto", value: "eo" },
	{ label: "Arabic", value: "ar" },
	{ label: "Mongolian (Mongolian script)", value: "mn-Mong" },
	{ label: "Old Norse", value: "non" },
] as const;


export function localizedDraft(text: string, language: string): LocalizedText {
	return localizedText(text, languageInputValue(language));
}


export function textLang(value: TextLike | null | undefined): LanguageTag | null {
	return localizedTextLang(value);
}

function worldAvatarMembersPromptSizeTitle(world: WorldSummary, members: BotSummary[] | null): string {
	if (!members) {
		return "Member bios are still loading; prompt size will appear here once they are available.";
	}
	const source = worldAvatarMembersPromptUserContent(world, members);
	const characters = Array.from(source).length;
	const approximateTokens = Math.ceil(characters / 4);
	return `Will send ${formatExactTokenCount(characters)} characters, about ${formatExactTokenCount(approximateTokens)} tokens, from ${members.length} member bio${members.length === 1 ? "" : "s"}.`;
}


function clientRouteTitle({
	bot,
	botActivityId,
	botHandle,
	botProfileTab,
	commentId,
	forum,
	forumHandle,
	humanHandle,
	route,
	search,
	thread,
	user,
	world,
	worldHandle,
	worldTab,
}: {
	bot: BotSummary | null;
	botActivityId: string | null;
	botHandle: string | null;
	botProfileTab: BotProfileTab;
	commentId: string | null;
	forum: ForumSummary | null;
	forumHandle: string | null;
	humanHandle: string | null;
	route: Route;
	search: SearchRouteState;
	thread: ThreadDocument | null;
	user: PublicUser | null;
	world: WorldView | null;
	worldHandle: string | null;
	worldTab: WorldTab;
}): string {
	switch (route) {
		case "worlds":
			return titleWithBickr("Worlds");
		case "world": {
			const handle = world?.handle ?? worldHandle;
			return handle ? titleWithBickr(worldTab === "forums" ? `w/${handle}` : `w/${handle}: ${worldTab}`) : "Bickr";
		}
		case "world-edit": {
			const handle = world?.handle ?? worldHandle;
			return handle ? titleWithBickr(`w/${handle}: edit`) : titleWithBickr("World edit");
		}
		case "world-avatar": {
			const handle = world?.handle ?? worldHandle;
			return handle ? titleWithBickr(`w/${handle}: avatar`) : titleWithBickr("World avatar");
		}
		case "forum": {
			const handle = forum?.handle ?? forumHandle;
			const parentWorldHandle = forum?.worldHandle ?? world?.handle ?? worldHandle;
			return handle && parentWorldHandle ? titleWithBickr(`f/${handle} in w/${parentWorldHandle}`) : "Bickr";
		}
		case "thread": {
			if (!thread) {
				return titleWithBickr("Thread");
			}
			const comment = commentId ? thread.comments.find((item) => item.id === commentId) : null;
			const title = textValue(thread.title);
			return titleWithBickr(comment ? `u/${comment.authorHandle} on ${title}` : title);
		}
		case "thread-ref":
		case "comment-ref":
			return titleWithBickr("Opening link");
		case "bot-profile": {
			const handle = bot?.handle ?? botHandle;
			if (!handle) {
				return "Bickr";
			}
			const tab = botActivityId ? "activity" : botProfileTab;
			return titleWithBickr(tab === "activity" && !botActivityId ? `u/${handle}` : `u/${handle}: ${tab}`);
		}
		case "bot-avatar":
		case "bot-loop":
		case "bot-edit": {
			const handle = bot?.handle ?? botHandle;
			const label = route === "bot-avatar" ? "avatar" : route === "bot-loop" ? "loop" : "edit";
			return handle ? titleWithBickr(`u/${handle}: ${label}`) : titleWithBickr(label);
		}
		case "my-bots":
			return titleWithBickr(user ? `hu/${user.handle}: bots` : "My bots");
		case "statistics-inference-costs":
			return titleWithBickr("Inference costs");
		case "notifications":
			return titleWithBickr(user ? `hu/${user.handle}: notifications` : "Notifications");
		case "subscriptions":
			return titleWithBickr(user ? `hu/${user.handle}: subscriptions` : "Subscriptions");
		case "profile":
			return titleWithBickr(user ? `hu/${user.handle}: profile` : "Profile");
		case "profile-avatar":
			return titleWithBickr(user ? `hu/${user.handle}: avatar` : "Profile avatar");
		case "human-profile":
			return titleWithBickr(humanHandle ? `hu/${humanHandle}` : "Profile");
		case "search": {
			const query = search.query.trim();
			return titleWithBickr(query ? `Search: ${query}` : "Search");
		}
	}
}

function titleWithBickr(prefix: string): string {
	return `${prefix} - Bickr`;
}

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
	const uiText = uiTextByLocale[effectiveUiLocale];
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
	const translationContext = useMemo<TranslationContextValue>(() => {
		const translation = userProfile?.inferenceSettings.translation;
		const model =
			translation?.model?.trim() ||
			userProfile?.inferenceSettings.model?.trim() ||
			defaultProviderModel;
		return {
			enabled: Boolean(translation?.enabled),
			model,
			prompt: localizedTextString(translation?.prompt).trim() || defaultTranslationPrompt,
		};
	}, [userProfile?.inferenceSettings.model, userProfile?.inferenceSettings.translation]);
	const activeBotBlogForum =
		activeBot ? activeForums.find((forum) => forum.personalBotId === activeBot.id) ?? null : null;
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
			const target = botAvatarTarget(bot, userProfile?.inferenceSettings ?? null);
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
		setUserProfile(profile);
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
			setUserProfile(result.data.profile);
			return `Unlinked ${authProviderLabel(provider)}.`;
		});
		return ok ? saved : null;
	}

	async function deleteProfile(): Promise<boolean> {
		return submit(async () => {
			await runApiAction(throwApiError, () => api<{ deleted: HumanOwnedTotals }>("/api/me/profile", {
				method: "DELETE",
				body: { confirmCascade: true },
			}));
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
			return "Deleted profile.";
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
							<AvatarGenerationScreen
								adapter={avatarGenerationDraftAdapter}
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
								onDiscardSettings={() => updateWorld(activeWorld.handle, { imageGeneration: null })}
								onSaveSettings={(draft, language) => updateWorld(activeWorld.handle, { imageGeneration: imageGenerationInputFromDraft(draft, undefined, language) })}
								onSaved={applySavedWorld}
								renderPromptFillSettingsModal={(props) => (
									<WorldAvatarPromptFillSettingsModal {...props} modelSuggestions={ownedBotModels} />
								)}
								target={worldAvatarTarget(activeWorld, userProfile?.inferenceSettings ?? null)}
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
							ownerInferenceSettings={userProfile?.inferenceSettings ?? null}
							subscribed={currentUser ? isSubscribed("bot", activeBot.id) : false}
							targetActivityId={activeBotActivityId}
							targetTab={activeBotProfileTab}
							world={activeWorld}
						/>
					)}
					{route === "bot-avatar" && activeWorld && activeBot && (
						activeBot.ownerUserId === currentUser?.id ?
							<AvatarGenerationScreen
								adapter={avatarGenerationDraftAdapter}
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
								onSaveSettings={(draft, language) => updateBot(activeBot.id, { inferenceSettings: { imageGeneration: imageGenerationInputFromDraft(draft, undefined, language) } })}
								onDiscardSettings={() => updateBot(activeBot.id, { inferenceSettings: { imageGeneration: null } })}
								onSaved={applySavedBot}
								target={botAvatarTarget(activeBot, userProfile?.inferenceSettings ?? null)}
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
								ownerInferenceSettings={userProfile?.inferenceSettings ?? null}
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
								modelSuggestions={ownedBotModels}
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
								ownerInferenceSettings={userProfile?.inferenceSettings ?? null}
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
								ownerInferenceSettings={userProfile?.inferenceSettings ?? null}
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
							<AvatarGenerationScreen
								adapter={avatarGenerationDraftAdapter}
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
								onDiscardSettings={async () => Boolean(await updateProfile({ inferenceSettings: { imageGeneration: null } }))}
								onSaveSettings={async (draft, language) =>
									Boolean(await updateProfile({
										inferenceSettings: {
											imageGeneration: imageGenerationInputFromDraft(
												draft,
												undefined,
												language,
											),
										},
									}))
								}
								onSaved={applySavedUserProfile}
								target={userAvatarTarget(userProfile)}
							/>
						:	<EmptyState title="Loading profile">
								Loading profile avatar settings.
							</EmptyState>
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
		</UiTextContext.Provider>
	);
}


function LoadingScreen({ status }: { status: string }) {
	return (
		<div className="login-wrap">
			<div className="login-card loading-card">
				<div className="brand">
					<BickrLogo />
					<div className="brand-word">bickr</div>
				</div>
				<h1>Loading</h1>
				<p className="sub">{status}</p>
			</div>
		</div>
	);
}

function LoginScreen({ embedded = false, status }: { embedded?: boolean; status: string }) {
	const card = (
			<div className="login-card">
				<div className="brand">
					<BickrLogo />
					<div className="brand-word">bickr</div>
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
	);
	return embedded ? <div className="main-inner embedded-login-wrap">{card}</div> : <div className="login-wrap">{card}</div>;
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


export function EditForumModal({
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
		const [language, setLanguage] = useState(languageDraftValue(defaultLanguageTag));
		const [description, setDescription] = useState("");
	const [renameOpen, setRenameOpen] = useState(false);
	const toast = useContext(ToastContext);
	const closeEditModal = useCallback(() => {
		if (renameOpen) {
			setRenameOpen(false);
			return;
		}
		onClose();
	}, [onClose, renameOpen]);

		useEffect(() => {
			if (forum) {
				setLanguage(languageDraftValue(forum.language, textLang(forum.description) ?? defaultLanguageTag));
				setDescription(textValue(forum.description));
				setRenameOpen(false);
			}
		}, [forum]);

	if (!forum) {
		return null;
	}
		const activeForum = forum;

		const valid = description.trim().length > 0;
		const savedLanguage = languageInputValue(language);
		const dirty = savedLanguage !== activeForum.language || description !== textValue(activeForum.description);

		async function submit(): Promise<void> {
			const ok = await onSave(activeForum, {
				language: savedLanguage,
				description: localizedDraft(description, language),
			});
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
					<span className="help">Use Change to rename this forum.</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={closeEditModal} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void submit()} type="button">
							Save changes
						</button>
					</div>
				</>
			}
			onClose={closeEditModal}
			open={Boolean(forum)}
			title="Edit forum"
		>
			<Field help={`bickr.local/w/${activeForum.worldHandle}/f/${activeForum.handle}`} label="Handle">
				<div className="inline-controls">
					<div className="input-prefix input-prefix-grow">
						<span className="prefix">f/</span>
						<input className="input" disabled value={activeForum.handle} />
					</div>
					<button className="btn" disabled={busy} onClick={() => setRenameOpen(true)} type="button">
						Change
					</button>
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
				<LanguageField onChange={setLanguage} value={language} />
				<RenameHandleModal
				busy={busy}
				kind="forum"
				routeHelp={(handle) => `bickr.local/w/${activeForum.worldHandle}/f/${handle}`}
				onClose={() => setRenameOpen(false)}
				onSave={async (handle) => {
					const ok = await onSave(activeForum, { handle });
					if (ok) {
						toast.push(
							<>
								Renamed <Reference kind="forum" name={handle} />
							</>,
						);
						setRenameOpen(false);
						onClose();
					}
					return ok;
				}}
				open={renameOpen}
				oldHandle={activeForum.handle}
				warning={
					<>
						Existing comments and descriptions of other forums and bots that mention <b>f/{activeForum.handle}</b> will
						not be updated. Those references will continue to show <b>f/{activeForum.handle}</b> after this forum is
						renamed.
					</>
				}
			/>
		</Modal>
	);
}

export function RenameHandleModal({
	busy,
	kind,
	oldHandle,
	routeHelp,
	onClose,
	onSave,
	open,
	warning,
}: {
	busy: boolean;
	kind: "forum" | "bot";
	oldHandle: string;
	routeHelp: (handle: string) => string;
	onClose: () => void;
	onSave: (handle: string) => Promise<boolean>;
	open: boolean;
	warning: ReactNode;
}) {
	const [handle, setHandle] = useState(oldHandle);
	const label = kind === "forum" ? "Forum handle" : "Bot handle";
	const prefix = kind === "forum" ? "f/" : "u/";

	useEffect(() => {
		if (open) {
			setHandle(oldHandle);
		}
	}, [oldHandle, open]);

	const valid = isValidHandleText(handle);
	const dirty = handle !== oldHandle;

	async function submit(): Promise<void> {
		const ok = await onSave(handle);
		if (ok) {
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">{prefix}{oldHandle} will stop being the canonical handle.</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void submit()} type="button">
							Save
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title={`Change ${kind} handle`}
		>
			<div className="rename-warning">⚠️ {warning}</div>
			<Field help={handle ? routeHelp(handle) : handleHelpText} label={label}>
				<div className="input-prefix">
					<span className="prefix">{prefix}</span>
					<input
						autoFocus
						className="input"
						onChange={(event) => setHandle(slugify(event.target.value))}
						value={handle}
					/>
				</div>
			</Field>
		</Modal>
	);
}

export function ForumRow({
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








function WorldAvatarPromptFillSettingsModal({
	error,
	initialSettings,
	loading,
	mode,
	modelSuggestions,
	onClose,
	onGenerate,
}: {
	error: string;
	initialSettings: BotInferenceSettings | null;
	loading: boolean;
	mode: AvatarTextPromptFillMode | null;
	modelSuggestions: string[];
	onClose: () => void;
	onGenerate: (settings: BotInferenceSettingsInput) => void;
}) {
	const [draft, setDraft] = useState<InferenceDraft>(() => inferenceDraftFromSettings(initialSettings ?? {}));
	const modelListId = useId();
	const open = mode !== null;
	const title = mode === "members" ? "Fill from members" : "Fill from description";
	const routingError = providerRoutingDraftError(draft.providerRouting);
	const canGenerate = Boolean(initialSettings && !loading && !routingError && draft.model.trim());
	const capabilityContext = inferenceCapabilityContextForDraft(draft);
	const modelOptions = useMemo(
		() => Array.from(new Set([defaultProviderModel, ...modelSuggestions, draft.model.trim()].filter(Boolean))),
		[draft.model, modelSuggestions],
	);

	useEffect(() => {
		if (open && initialSettings) {
			setDraft(inferenceDraftFromSettings(initialSettings));
		}
	}, [initialSettings, open]);

	function patch(update: Partial<InferenceDraft>): void {
		setDraft((current) => normalizeInferenceDraftForCapabilities({ ...current, ...update }));
	}

	function submit(): void {
		if (!canGenerate) {
			return;
		}
		onGenerate(promptFillSettingsInputFromDraft(draft));
	}

	return (
		<Modal
			className="avatar-prompt-settings-modal"
			foot={
				<>
					<span />
					<div className="right">
						<button className="btn ghost" onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!canGenerate} onClick={submit} type="button">
							Generate
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title={title}
			wide
		>
			{loading && <div className="runtime-message">Loading generation parameters...</div>}
			{error && <div className="runtime-message error">{error}</div>}
			{initialSettings && (
				<div className="field-stack">
					<div className="inference-row two">
						<Field label="Model">
							<input
								className="input"
								list={modelOptions.length > 0 ? modelListId : undefined}
								onChange={(event) => patch({ model: event.target.value })}
								value={draft.model}
							/>
							{modelOptions.length > 0 && (
								<datalist id={modelListId}>
									{modelOptions.map((model) => (
										<option key={model} value={model} />
									))}
								</datalist>
							)}
						</Field>
						<Field label="Base URL">
							<input
								className="input"
								onChange={(event) => patch({ baseUrl: event.target.value })}
								value={draft.baseUrl}
							/>
						</Field>
					</div>
					<div className="inference-row two">
						<Field label="Reasoning">
							<select
								className="input reasoning-select"
								onChange={(event) => patch({ reasoningEffort: event.target.value })}
								value={draft.reasoningEffort}
							>
								{reasoningEffortOptions.map((option) => (
									<option disabled={option.value === "none" && !capabilityContext.supportsReasoningNone} key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</Field>
						<Field label="Temperature">
							<input
								className="input"
								max="2"
								min="0"
								onChange={(event) => patch({ temperature: event.target.value })}
								step="0.05"
								type="number"
								value={draft.temperature}
							/>
						</Field>
					</div>
					<div className="inference-row three">
						<Field label="Top K">
							<input className="input" min="0" onChange={(event) => patch({ topK: event.target.value })} step="1" type="number" value={draft.topK} />
						</Field>
						<Field label="Top P">
							<input className="input" max="1" min="0" onChange={(event) => patch({ topP: event.target.value })} step="0.01" type="number" value={draft.topP} />
						</Field>
						<Field label="Min P">
							<input className="input" max="1" min="0" onChange={(event) => patch({ minP: event.target.value })} step="0.01" type="number" value={draft.minP} />
						</Field>
					</div>
					<div className="inference-row three">
						<Field label="Frequency penalty">
							<input className="input" max="2" min="-2" onChange={(event) => patch({ frequencyPenalty: event.target.value })} step="0.05" type="number" value={draft.frequencyPenalty} />
						</Field>
						<Field label="Presence penalty">
							<input className="input" max="2" min="-2" onChange={(event) => patch({ presencePenalty: event.target.value })} step="0.05" type="number" value={draft.presencePenalty} />
						</Field>
						<Field label="Repetition penalty">
							<input className="input" max="2" min="0" onChange={(event) => patch({ repetitionPenalty: event.target.value })} step="0.05" type="number" value={draft.repetitionPenalty} />
						</Field>
					</div>
					<ProviderRoutingField onChange={(providerRouting) => patch({ providerRouting })} value={draft.providerRouting} />
				</div>
			)}
		</Modal>
	);
}

export function BotPublicProfileCard({ bot }: { bot: BotPublicProfile }) {
	return (
		<article className="bot-card public-profile-card">
			<div className="head">
					<SpaLink
						className="bot-avatar-link"
					title={`Open ${textValue(bot.displayName)}`}
					to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}
				>
					<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} displayPixels={48} imageUrl={bot.avatarUrl} name={bot.displayName} />
			</SpaLink>
				<div className="bot-card-title">
						<SpaLink
							className="name bot-name-link"
							to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}
						>
							<TranslatableText as="span" text={bot.displayName} />
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

export function matchesBotProfileFilter(query: string, profile: BotPublicProfile): boolean {
	return matchesFilter(query, profile.handle, profile.displayName, profile.shortBio, profile.homeWorldHandle);
}

type MyBotsConfirmAction = "delete" | "spread" | "tick";

type MyBotTableRecord = {
	bot: BotSummary;
	effectiveModel: string;
	lastActiveSort: number | null;
	nextDueSort: number | null;
	spend?: MyBotSpendLoadState;
	world: WorldView | null;
};

function MyBotsScreen({
	bots,
	onDeleteBots,
	onRunBotTicks,
	onSpreadBotTicks,
	ownerInferenceSettings,
	worlds,
}: {
	bots: BotSummary[];
	onDeleteBots: (bots: BotSummary[]) => Promise<{ deleted: BotSummary[]; failed: BotSummary[] }>;
	onRunBotTicks: (bots: BotSummary[]) => Promise<void>;
	onSpreadBotTicks: () => Promise<BotTickSpreadResult | null>;
	ownerInferenceSettings: BotInferenceSettings | null;
	worlds: WorldView[];
}) {
	const [botFilter, setBotFilter] = useState("");
	const [confirmAction, setConfirmAction] = useState<MyBotsConfirmAction | null>(null);
	const [selectedBotIds, setSelectedBotIds] = useState<Set<string>>(() => new Set());
	const [sort, setSort] = useState<MyBotsSortState>(() => readMyBotsSortState());
	const [spendByBotId, setSpendByBotId] = useState<Record<string, MyBotSpendLoadState>>({});
	const selectAllRef = useRef<HTMLInputElement>(null);
	const toast = useContext(ToastContext);
	const spendFetchKey = useMemo(() => bots.map((bot) => bot.id).sort(compareHandles).join("\u0000"), [bots]);

	const records = useMemo<MyBotTableRecord[]>(() => {
		const worldsByHandle = new Map(worlds.map((world) => [world.handle, world]));
		return bots.flatMap((bot) => {
			const world = worldsByHandle.get(bot.homeWorldHandle) ?? null;
			if (!matchesFilter(botFilter, bot.handle, bot.displayName, bot.shortBio, bot.homeWorldHandle, world?.name)) {
				return [];
			}
			return [{
				bot,
				effectiveModel: effectiveBotModel(bot, ownerInferenceSettings),
				lastActiveSort: timestampSortValue(bot.lastActiveAt ?? bot.createdAt),
				nextDueSort: bot.tickSettings.enabled ? timestampSortValue(bot.nextDueAt) : null,
				spend: spendByBotId[bot.id],
				world,
			}];
		});
	}, [botFilter, bots, ownerInferenceSettings, spendByBotId, worlds]);

	const groups = useMemo(() => {
		const grouped = new Map<string, { rows: MyBotTableRecord[]; world: WorldView | null; worldHandle: string }>();
		for (const record of records) {
			const worldHandle = record.bot.homeWorldHandle;
			const group = grouped.get(worldHandle) ?? { rows: [], world: record.world, worldHandle };
			group.rows.push(record);
			grouped.set(worldHandle, group);
		}

		return [...grouped.values()]
			.sort((left, right) => compareHandles(left.worldHandle, right.worldHandle))
			.map((group) => ({
				...group,
				rows: [...group.rows].sort((left, right) => compareMyBotTableRecords(left, right, sort)),
			}));
	}, [records, sort]);

	useEffect(() => {
		writeMyBotsSortState(sort);
	}, [sort]);

	useEffect(() => {
		const botIds = bots.map((bot) => bot.id);
		if (botIds.length === 0) {
			setSpendByBotId({});
			return;
		}
		setSpendByBotId((current) => {
			const next: Record<string, MyBotSpendLoadState> = {};
			for (const botId of botIds) {
				next[botId] = current[botId] ?? { status: "loading" };
			}
			return next;
		});
		let cancelled = false;
		void (async () => {
			const result = await api<{ spendByBotId: Record<string, BotTokenSpendSummary> }>("/api/me/bots/token-spend");
			if (cancelled) {
				return;
			}
			setSpendByBotId(() => {
				const next: Record<string, MyBotSpendLoadState> = {};
				for (const botId of botIds) {
					const summary = result.ok ? result.data.spendByBotId[botId] : undefined;
					next[botId] = result.ok && summary ?
						{ status: "loaded", summary }
					:	{ status: "error", message: result.ok ? "Token spend summary was missing." : result.message };
				}
				return next;
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [spendFetchKey]);

	const visibleBotIds = useMemo(
		() => groups.flatMap((group) => group.rows.map((row) => row.bot.id)),
		[groups],
	);
	const selectedRecords = useMemo(
		() => groups.flatMap((group) => group.rows).filter((row) => selectedBotIds.has(row.bot.id)),
		[groups, selectedBotIds],
	);
	const selectedBots = useMemo(
		() => selectedRecords.map((record) => record.bot),
		[selectedRecords],
	);
	const overallSpendTotal = useMemo(() => myBotsSpendTotal(groups.flatMap((group) => group.rows)), [groups]);
	const selectedTickRun = useMemo(() => myBotsRunTickSelection(selectedBots), [selectedBots]);
	const selectedCount = selectedBots.length;
	const enabledBotCount = bots.filter((bot) => bot.tickSettings.enabled).length;
	const allVisibleSelected = visibleBotIds.length > 0 && visibleBotIds.every((id) => selectedBotIds.has(id));
	const someVisibleSelected = selectedCount > 0;

	useEffect(() => {
		const visibleIds = new Set(visibleBotIds);
		setSelectedBotIds((current) => {
			let changed = false;
			const next = new Set<string>();
			for (const id of current) {
				if (visibleIds.has(id)) {
					next.add(id);
				} else {
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [visibleBotIds]);

	useEffect(() => {
		if (selectAllRef.current) {
			selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
		}
	}, [allVisibleSelected, someVisibleSelected]);

	function toggleSort(key: MyBotsSortKey): void {
		setSort((current) =>
			current.key === key ?
				{ key, direction: current.direction === "asc" ? "desc" : "asc" }
			:	{ key, direction: "asc" },
		);
	}

	function toggleAllVisible(): void {
		setSelectedBotIds((current) => {
			const next = new Set(current);
			if (allVisibleSelected) {
				for (const id of visibleBotIds) {
					next.delete(id);
				}
			} else {
				for (const id of visibleBotIds) {
					next.add(id);
				}
			}
			return next;
		});
	}

	function toggleGroup(botIds: string[]): void {
		setSelectedBotIds((current) => {
			const next = new Set(current);
			const allGroupSelected = botIds.length > 0 && botIds.every((id) => next.has(id));
			for (const id of botIds) {
				if (allGroupSelected) {
					next.delete(id);
				} else {
					next.add(id);
				}
			}
			return next;
		});
	}

	function toggleBot(botId: string): void {
		setSelectedBotIds((current) => {
			const next = new Set(current);
			if (next.has(botId)) {
				next.delete(botId);
			} else {
				next.add(botId);
			}
			return next;
		});
	}

	async function deleteSelectedBots(): Promise<void> {
		const result = await onDeleteBots(selectedBots);
		if (result.deleted.length > 0) {
			const deletedIds = new Set(result.deleted.map((bot) => bot.id));
			setSelectedBotIds((current) => {
				const next = new Set(current);
				for (const id of deletedIds) {
					next.delete(id);
				}
				return next;
			});
			toast.push(`Deleted ${result.deleted.length} bot${result.deleted.length === 1 ? "" : "s"}.`);
		}
	}

	async function runSelectedTicks(): Promise<void> {
		if (selectedTickRun.disabled) {
			return;
		}
		await onRunBotTicks(selectedTickRun.targetBots);
	}

	async function spreadTicks(): Promise<void> {
		if (enabledBotCount === 0) {
			return;
		}
		const result = await onSpreadBotTicks();
		if (result) {
			const skipped = result.skipped.paused + result.skipped.running;
			toast.push(`Spread ticks for ${result.scheduled.length} bot${result.scheduled.length === 1 ? "" : "s"}${skipped ? `; ${skipped} unchanged` : ""}.`);
		}
	}

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>My bots</h1>
					<p className="sub">All bots you own across every world.</p>
				</div>
				<div className="actions bot-table-bulk-actions">
					{selectedCount > 0 && (
						<>
							<span className="selection-count">
								{selectedCount} selected
							</span>
							<button className="btn danger" onClick={() => setConfirmAction("delete")} type="button">
								<Icon name="trash" size={14} />
								Delete
							</button>
							<button
								className="btn"
								disabled={selectedTickRun.disabled}
								onClick={() => setConfirmAction("tick")}
								title={selectedTickRun.title}
								type="button"
							>
								<Icon name="refresh" size={14} />
								Run tick
							</button>
						</>
					)}
					<button
						className="btn"
						disabled={enabledBotCount === 0}
						onClick={() => setConfirmAction("spread")}
						title={
							enabledBotCount === 0 ?
								"No active bots have scheduled ticks to spread."
							:	"Spread active bot ticks across their schedules"
						}
						type="button"
					>
						<Icon name="clock" size={14} />
						Spread ticks
					</button>
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
					:	<div className="bot-table-shell">
							<div className="bot-table-scroll">
								<table className="bot-table">
									<colgroup>
										<col className="bot-table-select-col" />
										<col className="bot-table-avatar-col" />
										<col className="bot-table-username-col" />
										<col className="bot-table-display-col" />
										<col className="bot-table-time-col" />
										<col className="bot-table-time-col" />
										<col className="bot-table-model-col" />
										<col className="bot-table-spend-col" />
									</colgroup>
									<thead>
										<tr>
											<th className="bot-table-check-heading" scope="col">
												<input
													aria-label={allVisibleSelected ? "Clear visible bot selection" : "Select all visible bots"}
													checked={allVisibleSelected}
													disabled={visibleBotIds.length === 0}
													onChange={toggleAllVisible}
													ref={selectAllRef}
													type="checkbox"
												/>
											</th>
											<th className="bot-table-avatar-heading" scope="col">
												<span className="sr-only">Avatar</span>
											</th>
											<MyBotsSortHeader label="u/username" onSort={toggleSort} sort={sort} sortKey="handle" />
											<MyBotsSortHeader label="Display name" onSort={toggleSort} sort={sort} sortKey="displayName" />
											<MyBotsSortHeader label="Last active" onSort={toggleSort} sort={sort} sortKey="lastActive" />
											<MyBotsSortHeader label="Next tick" onSort={toggleSort} sort={sort} sortKey="nextDue" />
											<MyBotsSortHeader label="Current model" onSort={toggleSort} sort={sort} sortKey="model" />
											<MyBotsSortHeader label="$/day" onSort={toggleSort} sort={sort} sortKey="spend" />
										</tr>
									</thead>
									{groups.map((group) => {
										const groupBotIds = group.rows.map((row) => row.bot.id);
										const selectedInGroup = groupBotIds.filter((id) => selectedBotIds.has(id)).length;
										const allGroupSelected = groupBotIds.length > 0 && selectedInGroup === groupBotIds.length;
										const someGroupSelected = selectedInGroup > 0;
										const groupSpendTotal = myBotsSpendTotal(group.rows);
										return (
											<tbody key={group.worldHandle}>
												<tr className="bot-table-group-row">
													<th colSpan={7} scope="rowgroup">
														<span className="bot-table-group-layout">
															<MyBotsGroupCheckbox
																allSelected={allGroupSelected}
																botIds={groupBotIds}
																label={`w/${group.worldHandle}`}
																onToggle={toggleGroup}
																someSelected={someGroupSelected}
															/>
															<span className="bot-table-group-label">
																{group.world ?
																	<SpaLink to={{ route: "world", worldHandle: group.worldHandle }}>
																		<Reference kind="world" link={false} name={group.worldHandle} />
																	</SpaLink>
																:	<Reference kind="world" name={group.worldHandle} />}
															</span>
															<span className="bot-table-group-count">
																{group.rows.length} bot{group.rows.length === 1 ? "" : "s"}
															</span>
														</span>
													</th>
													<td className="bot-table-spend-cell" title={formatMyBotsSpendTotalTitle(groupSpendTotal)}>
														{formatMyBotsSpendTotal(groupSpendTotal)}
													</td>
												</tr>
												{group.rows.map((record) => {
													const { bot } = record;
													const selected = selectedBotIds.has(bot.id);
													return (
														<tr
															className={`bot-table-row ${selected ? "selected" : ""} ${bot.tickSettings.enabled ? "" : "paused"}`.trim()}
															key={bot.id}
														>
															<td className="bot-table-check-cell">
																<input
																	aria-label={`Select u/${bot.handle}`}
																	checked={selected}
																	onChange={() => toggleBot(bot.id)}
																	type="checkbox"
																/>
															</td>
															<td className="bot-table-avatar-cell">
																<BotProfileHoverLink
																	bot={bot}
																	className="bot-table-avatar-link"
																	title={`Open ${bot.displayName}`}
																>
																	<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} imageUrl={bot.avatarUrl} name={bot.displayName} size="sm" />
																</BotProfileHoverLink>
															</td>
															<td className="bot-table-username-cell">
																<Reference isBot kind="bot" name={bot.handle} worldHandle={bot.homeWorldHandle} />
															</td>
															<td className="bot-table-display-cell">
																	<BotProfileHoverLink
																		bot={bot}
																		className="bot-table-display-link"
																		title={`Open ${textValue(bot.displayName)}`}
																	>
																		<TranslatableText as="span" text={bot.displayName} />
																	</BotProfileHoverLink>
															</td>
															<td className="bot-table-time-cell">
																<TimeAgoLabel suffix value={bot.lastActiveAt ?? bot.createdAt} />
															</td>
															<td className="bot-table-time-cell">
																{bot.tickSettings.enabled ?
																	<TimeUntilLabel value={bot.nextDueAt} />
																:	<span className="bot-status-label paused">Paused</span>}
															</td>
															<td className="bot-table-model-cell">
																<ModelChip model={record.effectiveModel} />
															</td>
															<td className="bot-table-spend-cell" title={formatBotSpendTitle(record.spend)}>
																{formatBotSpendValue(record.spend)}
															</td>
														</tr>
													);
												})}
											</tbody>
										);
									})}
									<tfoot>
										<tr className="bot-table-total-row">
											<th colSpan={7} scope="row">Total</th>
											<td className="bot-table-spend-cell" title={formatMyBotsSpendTotalTitle(overallSpendTotal)}>
												{formatMyBotsSpendTotal(overallSpendTotal)}
											</td>
										</tr>
									</tfoot>
								</table>
							</div>
						</div>
					}
				</>
			}
			<Confirm
				body={
					confirmAction === "delete" ?
						<>
							This will remove {selectedCount} selected bot{selectedCount === 1 ? "" : "s"} from your active bot list.
						</>
					: confirmAction === "tick" ?
						<>
							This will start a tick for {selectedTickRun.targetCount} selected active bot{selectedTickRun.targetCount === 1 ? "" : "s"}.
							{selectedTickRun.pausedCount > 0 && (
								<> {selectedTickRun.pausedCount} paused selected bot{selectedTickRun.pausedCount === 1 ? "" : "s"} will be skipped.</>
							)}
						</>
					: confirmAction === "spread" ?
						<>
							This will reschedule {enabledBotCount} active bot{enabledBotCount === 1 ? "" : "s"} so their ticks are spread out. The next scheduled bot becomes due now. Paused or already-running bots stay unchanged.
						</>
					:	null
				}
				confirmText={
					confirmAction === "delete" ?
						`Delete ${selectedCount} bot${selectedCount === 1 ? "" : "s"}`
					: confirmAction === "tick" ?
						`Run ${selectedTickRun.targetCount} tick${selectedTickRun.targetCount === 1 ? "" : "s"}`
					:	"Spread ticks"
				}
				danger={confirmAction === "delete"}
				onClose={() => setConfirmAction(null)}
				onConfirm={() => {
					if (confirmAction === "delete") {
						void deleteSelectedBots();
					} else if (confirmAction === "tick") {
						void runSelectedTicks();
					} else if (confirmAction === "spread") {
						void spreadTicks();
					}
				}}
				open={Boolean(confirmAction)}
				title={
					confirmAction === "delete" ? "Delete selected bots?"
					: confirmAction === "tick" ? "Run selected ticks?"
					: "Spread bot ticks?"
				}
			/>
		</div>
	);
}

function ModelChip({ model }: { model: string }) {
	return (
		<span
			className="bot-table-model-chip"
			style={{ "--model-h": String(modelColorHue(model)) } as CSSProperties}
			title={model}
		>
			{model}
		</span>
	);
}

function formatBotSpendValue(spend: MyBotSpendLoadState | undefined): ReactNode {
	if (!spend || spend.status === "loading") {
		return <LoadingEllipsis />;
	}
	if (spend.status === "error" || spend.summary.last24Hours.unknownCost) {
		return "$?";
	}
	return formatTokenCostParts(spend.summary.last24Hours.cost ?? 0, 4);
}

function formatBotSpendTitle(spend: MyBotSpendLoadState | undefined): string {
	if (!spend || spend.status === "loading") {
		return "Token spend is loading.";
	}
	if (spend.status === "error") {
		return `Token spend could not be loaded: ${spend.message}`;
	}
	const last24 = spend.summary.last24Hours;
	const average = spend.summary.average;
	const last24Cost = last24.unknownCost ? "unknown" : formatTokenCost(last24.cost ?? 0);
	const averageCost =
		average.noCurrentModelUsage ? "$0.00/day; no tracked requests for the current model"
		: average.unknownCost ? "unknown/day"
		: `${formatTokenCost(average.costPerDay ?? 0)}/day`;
	return [
		`24h: ${last24Cost} across ${last24.requestCount} tracked request${last24.requestCount === 1 ? "" : "s"}.`,
		`Avg/day: ${averageCost}.`,
		`Average window: ${formatFullDate(average.periodStart)} to ${formatFullDate(average.periodEnd)} (${formatAverageDays(average.dayCount)}).`,
		`Current model: ${spend.summary.currentModel}.`,
	].join("\n");
}

function formatMyBotsSpendTotal(total: MyBotsSpendTotal): ReactNode {
	if (total.pendingCount > 0) {
		return <LoadingEllipsis />;
	}
	if (total.unknownCost || total.errorCount > 0) {
		return "$?";
	}
	return formatTokenCostParts(total.cost ?? 0, 4);
}

function formatMyBotsSpendTotalTitle(total: MyBotsSpendTotal): string {
	if (total.pendingCount > 0) {
		return `Loading token spend for ${total.pendingCount} visible bot${total.pendingCount === 1 ? "" : "s"}.`;
	}
	if (total.errorCount > 0) {
		return `Total is unknown because token spend failed to load for ${total.errorCount} visible bot${total.errorCount === 1 ? "" : "s"}.`;
	}
	if (total.unknownCost) {
		return `Total is unknown because at least one visible tracked request did not report cost. Known subtotal: ${formatTokenCost(total.knownCost)}.`;
	}
	return `${formatTokenCost(total.cost ?? 0)} across ${total.requestCount} tracked 24h request${total.requestCount === 1 ? "" : "s"}.`;
}

function LoadingEllipsis() {
	return (
		<span aria-label="Loading" className="loading-ellipsis">
			<span>.</span>
			<span>.</span>
			<span>.</span>
		</span>
	);
}

function MyBotsSortHeader({
	label,
	onSort,
	sort,
	sortKey,
}: {
	label: string;
	onSort: (key: MyBotsSortKey) => void;
	sort: MyBotsSortState;
	sortKey: MyBotsSortKey;
}) {
	const active = sort.key === sortKey;
	return (
		<th aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
			<button className={`bot-table-sort ${active ? "active" : ""}`} onClick={() => onSort(sortKey)} type="button">
				<span>{label}</span>
				{active && <Icon name={sort.direction === "asc" ? "arrowUp" : "arrowDown"} size={12} />}
			</button>
		</th>
	);
}

function MyBotsGroupCheckbox({
	allSelected,
	botIds,
	label,
	onToggle,
	someSelected,
}: {
	allSelected: boolean;
	botIds: string[];
	label: string;
	onToggle: (botIds: string[]) => void;
	someSelected: boolean;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.indeterminate = someSelected && !allSelected;
		}
	}, [allSelected, someSelected]);
	return (
		<input
			aria-label={allSelected ? `Clear ${label} bot selection` : `Select all bots in ${label}`}
			checked={allSelected}
			className="bot-table-group-checkbox"
			disabled={botIds.length === 0}
			onChange={() => onToggle(botIds)}
			ref={inputRef}
			type="checkbox"
		/>
	);
}

function SubscriptionsScreen({
	onLoad,
	onSaved,
	response,
}: {
	onLoad: () => Promise<HumanSubscriptionTreeResponse | null>;
	onSaved: (response: HumanSubscriptionTreeResponse) => void;
	response: HumanSubscriptionTreeResponse | null;
}) {
	const [filter, setFilter] = useState("");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState("");
	const [initialKeys, setInitialKeys] = useState<Set<string>>(() => new Set());
	const [draftKeys, setDraftKeys] = useState<Set<string>>(() => new Set());
	const [rememberedDescendantsByKey, setRememberedDescendantsByKey] = useState<RememberedSubscriptionDescendants>({});
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (response) {
			const keys = subscriptionKeysFromTree(response.tree);
			setInitialKeys(keys);
			setDraftKeys(new Set(keys));
			setRememberedDescendantsByKey({});
			setMessage("");
		}
	}, [response]);

	useEffect(() => {
		if (response) {
			return undefined;
		}
		let cancelled = false;
		setLoading(true);
		setMessage("");
		void onLoad().then((loaded) => {
			if (!cancelled && !loaded) {
				setMessage("Subscriptions could not be loaded.");
			}
		}).finally(() => {
			if (!cancelled) {
				setLoading(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [response]);

	const tree = response?.tree ?? { worlds: [] };
	const filteredTree = useMemo(() => filterSubscriptionTree(tree, filter), [filter, tree]);
	const nodesByKey = useMemo(() => subscriptionNodesByKey(tree), [tree]);
	const changes = useMemo(
		() => subscriptionChangesFromDraft(tree, initialKeys, draftKeys),
		[tree, initialKeys, draftKeys],
	);

	function nodeState(node: SubscriptionTreeNode) {
		return subscriptionNodeState(nodesByKey.get(subscriptionTargetKey(node.target)) ?? node, draftKeys);
	}

	function toggleNode(node: SubscriptionTreeNode): void {
		const key = subscriptionTargetKey(node.target);
		const fullNode = nodesByKey.get(key) ?? node;
		if (isSubscriptionContainer(fullNode)) {
			const next = cycleSubscriptionContainer(fullNode, draftKeys, rememberedDescendantsByKey);
			setDraftKeys(next.subscribedKeys);
			setRememberedDescendantsByKey(next.rememberedDescendantsByKey);
		} else {
			setDraftKeys((current) => toggleSubscriptionTarget(fullNode.target, current));
		}
	}

	async function saveChanges(): Promise<void> {
		if (changes.length === 0) {
			return;
		}
		setSaving(true);
		setMessage("");
		const result = await api<HumanSubscriptionTreeResponse>("/api/me/subscriptions", {
			method: "PATCH",
			body: { changes },
		});
		setSaving(false);
		if (!result.ok) {
			setMessage(result.message);
			return;
		}
		onSaved(result.data);
		toast.push(`Updated ${changes.length} subscription change${changes.length === 1 ? "" : "s"}.`);
	}

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>Subscriptions</h1>
					<p className="sub">Watched worlds, participants, forums, threads, and comments.</p>
				</div>
				<div className="actions">
					<button
						className="btn primary"
						disabled={saving || loading || changes.length === 0}
						onClick={() => void saveChanges()}
						type="button"
					>
						<Icon name="checklist" size={14} />
						{saving ? "Updating..." : "Update subscriptions"}
					</button>
				</div>
			</div>
			<FilterBox
				label="Filter subscriptions"
				onChange={setFilter}
				placeholder="Filter by world, participant, forum, thread, or comment"
				value={filter}
			/>
			{message && <div className="runtime-message error">{message}</div>}
			{loading && !response ?
				<div className="empty compact-empty">Loading subscriptions...</div>
			: subscriptionTreeIsEmpty(tree) ?
				<EmptyState title="No active subscriptions">
					Watched activity will appear here.
				</EmptyState>
			: subscriptionTreeIsEmpty(filteredTree) ?
				<div className="empty compact-empty">No subscriptions match this filter.</div>
			:	<div className="subscription-tree-shell">
					{filteredTree.worlds.map((world) => (
						<SubscriptionWorldRows
							key={world.world.id}
							node={world}
							nodeState={nodeState}
							onToggle={toggleNode}
						/>
					))}
				</div>
			}
		</div>
	);
}

function SubscriptionWorldRows({
	node,
	nodeState,
	onToggle,
}: {
	node: HumanSubscriptionWorldNode;
	nodeState: (node: SubscriptionTreeNode) => "checked" | "indeterminate" | "unchecked";
	onToggle: (node: SubscriptionTreeNode) => void;
}) {
	return (
		<>
			<SubscriptionTreeRow
				depth={0}
				label={
					<SpaLink to={{ route: "world", worldHandle: node.world.handle }}>
						<Reference kind="world" link={false} name={node.world.handle} />
					</SpaLink>
				}
					meta={<TranslatableText as="span" text={node.world.name} />}
				node={node}
				onToggle={onToggle}
				state={nodeState(node)}
			/>
			{node.bots.map((bot) => (
				<SubscriptionTreeRow
					depth={1}
					label={
						<span className="subscription-tree-profile-label">
							<Avatar actor="bot" colorSeed={bot.bot.handle} crop={bot.bot.avatarCrop} imageUrl={bot.bot.avatarUrl} name={bot.bot.displayName} size="sm" />
							<span>
								<Reference isBot kind="bot" name={bot.bot.handle} worldHandle={bot.bot.homeWorldHandle} />
									<TranslatableText as="span" className="subscription-tree-display-name" text={bot.bot.displayName} />
								</span>
							</span>
						}
						key={bot.bot.id}
						meta={<TranslatableText as="span" text={bot.bot.shortBio} />}
					node={bot}
					onToggle={onToggle}
					state={nodeState(bot)}
				/>
			))}
			{node.forums.map((forum) => (
				<SubscriptionForumRows
					key={forum.forum.id}
					node={forum}
					nodeState={nodeState}
					onToggle={onToggle}
				/>
			))}
		</>
	);
}

function SubscriptionForumRows({
	node,
	nodeState,
	onToggle,
}: {
	node: HumanSubscriptionForumNode;
	nodeState: (node: SubscriptionTreeNode) => "checked" | "indeterminate" | "unchecked";
	onToggle: (node: SubscriptionTreeNode) => void;
}) {
	return (
		<>
			<SubscriptionTreeRow
				depth={1}
				label={
					<SpaLink to={{ route: "forum", worldHandle: node.forum.worldHandle, forumHandle: node.forum.handle }}>
						<Reference kind="forum" link={false} name={node.forum.handle} />
					</SpaLink>
				}
					meta={<TranslatableText as="span" text={node.forum.description} />}
				node={node}
				onToggle={onToggle}
				state={nodeState(node)}
			/>
			{node.threads.map((thread) => (
				<SubscriptionThreadRows
					key={thread.thread.id}
					node={thread}
					nodeState={nodeState}
					onToggle={onToggle}
				/>
			))}
		</>
	);
}

function SubscriptionThreadRows({
	node,
	nodeState,
	onToggle,
}: {
	node: HumanSubscriptionThreadNode;
	nodeState: (node: SubscriptionTreeNode) => "checked" | "indeterminate" | "unchecked";
	onToggle: (node: SubscriptionTreeNode) => void;
}) {
	return (
		<>
				<SubscriptionTreeRow
					depth={2}
					label={
						<SpaLink to={{ route: "thread", worldHandle: node.thread.worldHandle, forumHandle: node.thread.forumHandle, threadId: node.thread.id }}>
							<TranslatableText as="span" text={node.thread.title} />
						</SpaLink>
					}
				meta={
					<>
						<span>{node.thread.commentCount} comment{node.thread.commentCount === 1 ? "" : "s"}</span>
						<span>u/{node.thread.authorHandle}</span>
						<TimeAgoLabel suffix value={node.thread.lastActivityAt} />
					</>
				}
				node={node}
				onToggle={onToggle}
				state={nodeState(node)}
			/>
			{node.comments.map((comment) => (
				<SubscriptionCommentRow
					key={comment.comment.id}
					node={comment}
					onToggle={onToggle}
					state={nodeState(comment)}
					thread={node.thread}
				/>
			))}
		</>
	);
}

function SubscriptionCommentRow({
	node,
	onToggle,
	state,
	thread,
}: {
	node: HumanSubscriptionCommentNode;
	onToggle: (node: SubscriptionTreeNode) => void;
	state: "checked" | "indeterminate" | "unchecked";
	thread: HumanSubscriptionThreadNode["thread"];
}) {
	return (
			<SubscriptionTreeRow
				depth={3}
				label={
					<SpaLink to={{ route: "thread", worldHandle: thread.worldHandle, forumHandle: thread.forumHandle, threadId: thread.id, commentId: node.comment.id }}>
						{textValue(node.comment.bodyPreview) ? <TranslatableText as="span" text={node.comment.bodyPreview} /> : "Comment"}
					</SpaLink>
				}
			meta={
				<>
					<span>u/{node.comment.authorHandle}</span>
					<TimeAgoLabel suffix value={node.comment.createdAt} />
				</>
			}
			node={node}
			onToggle={onToggle}
			state={state}
		/>
	);
}

function SubscriptionTreeRow({
	depth,
	label,
	meta,
	node,
	onToggle,
	state,
}: {
	depth: number;
	label: ReactNode;
	meta: ReactNode;
	node: SubscriptionTreeNode;
	onToggle: (node: SubscriptionTreeNode) => void;
	state: "checked" | "indeterminate" | "unchecked";
}) {
	return (
		<div
			className={`subscription-tree-row ${node.type} ${state}`}
			style={{ "--subscription-depth": String(depth) } as CSSProperties}
		>
			<div className="subscription-tree-check">
				<SubscriptionTreeCheckbox
					label={subscriptionCheckboxLabel(node, state)}
					onToggle={() => onToggle(node)}
					state={state}
				/>
			</div>
			<div className="subscription-tree-main">
				<div className="subscription-tree-label">{label}</div>
				<div className="subscription-tree-meta">{meta}</div>
			</div>
		</div>
	);
}

function SubscriptionTreeCheckbox({
	label,
	onToggle,
	state,
}: {
	label: string;
	onToggle: () => void;
	state: "checked" | "indeterminate" | "unchecked";
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.indeterminate = state === "indeterminate";
		}
	}, [state]);
	return (
		<input
			aria-checked={state === "indeterminate" ? "mixed" : state === "checked"}
			aria-label={label}
			checked={state === "checked"}
			className="cb subscription-tree-checkbox"
			onChange={onToggle}
			ref={inputRef}
			type="checkbox"
		/>
	);
}

function isSubscriptionContainer(
	node: SubscriptionTreeNode,
): node is HumanSubscriptionWorldNode | HumanSubscriptionForumNode | HumanSubscriptionThreadNode {
	return node.type === "world" || node.type === "forum" || node.type === "thread";
}

function subscriptionCheckboxLabel(node: SubscriptionTreeNode, state: "checked" | "indeterminate" | "unchecked"): string {
	const action =
		state === "checked" ? "Clear"
		: state === "indeterminate" ? "Watch"
		: "Watch";
	switch (node.type) {
		case "world":
			return `${action} w/${node.world.handle}`;
		case "forum":
			return `${action} f/${node.forum.handle}`;
		case "thread":
			return `${action} thread ${textValue(node.thread.title)}`;
		case "comment":
			return `${action} comment by u/${node.comment.authorHandle}`;
		case "bot":
			return `${action} u/${node.bot.handle}`;
	}
}

type SearchResultGroup = {
	rows: SearchResult[];
	world: SearchResult["world"];
	worldResult: SearchResult | null;
};

function publicSearchState(state: SearchRouteState, isAuthenticated: boolean): SearchRouteState {
	return !isAuthenticated && state.mode === "semantic" ? { ...state, mode: "substring", page: 1 } : state;
}

function AdvancedSearchScreen({
	isAuthenticated,
	routeState,
}: {
	isAuthenticated: boolean;
	routeState: SearchRouteState;
}) {
	const { navigate } = useContext(NavigationContext);
	const effectiveRouteState = useMemo(
		() => publicSearchState(routeState, isAuthenticated),
		[isAuthenticated, routeState],
	);
	const [draft, setDraft] = useState<SearchRouteState>(effectiveRouteState);
	const [search, setSearch] = useState<SearchResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [message, setMessage] = useState("");
	const lastRequestKey = useRef("");

	useEffect(() => {
		setDraft(effectiveRouteState);
		if (!effectiveRouteState.query.trim()) {
			setSearch(null);
			setMessage("");
			lastRequestKey.current = "";
			return;
		}
		void loadSearch(effectiveRouteState);
	}, [effectiveRouteState]);

	async function loadSearch(state: SearchRouteState): Promise<void> {
		const path = searchApiPath(state);
		lastRequestKey.current = path;
		setLoading(true);
		setMessage("");
		const result = await api<{ search: SearchResponse }>(path);
		if (lastRequestKey.current !== path) {
			return;
		}
		setLoading(false);
		if (result.ok) {
			setSearch(result.data.search);
			setMessage(result.data.search.results.length === 0 ? "No matches." : "");
		} else {
			setSearch(null);
			setMessage(result.message);
		}
	}

	function submit(page = 1): void {
		const next = {
			...publicSearchState(draft, isAuthenticated),
			page,
			query: draft.query.trim(),
			forum: draft.forum.trim(),
			username: draft.username.trim(),
			world: draft.world.trim(),
		};
		if (!next.query || next.types.length === 0) {
			return;
		}
		const parsed: ParsedRoute = { route: "search", search: next };
		if (currentLocationPath() === routePath(parsed)) {
			void loadSearch(next);
		} else {
			navigate(parsed);
		}
	}

	function patchDraft(patch: Partial<SearchRouteState>): void {
		setDraft((current) => publicSearchState({ ...current, ...patch, page: 1 }, isAuthenticated));
	}

	function toggleType(type: SearchEntityType): void {
		setDraft((current) => {
			const types =
				current.types.includes(type) ?
					current.types.filter((item) => item !== type)
				:	[...current.types, type].sort(searchTypeSort);
			return { ...current, page: 1, types };
		});
	}

	const groups = useMemo(() => searchResultGroups(search?.results ?? []), [search]);
	const canSearch = draft.query.trim().length > 0 && draft.types.length > 0 && !loading;
	const availableModes: SearchMode[] = isAuthenticated ? ["substring", "fts", "semantic"] : ["substring", "fts"];

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>Search</h1>
					<p className="sub">Search worlds, forums, and bots with exact-handle filters.</p>
				</div>
			</div>
			<form
				className="advanced-search-panel"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<Field label="Query">
					<input
						className="input"
						onChange={(event) => patchDraft({ query: event.target.value })}
						placeholder="Search text"
						value={draft.query}
					/>
				</Field>
				<Field label="Mode">
					<div className="seg search-mode-control">
						{availableModes.map((mode) => (
							<button
								aria-pressed={draft.mode === mode}
								className={draft.mode === mode ? "active" : ""}
								key={mode}
								onClick={() => patchDraft({ mode })}
								type="button"
							>
								{searchModeLabel(mode)}
							</button>
						))}
					</div>
				</Field>
				<fieldset className="search-type-fieldset">
					<legend>Types</legend>
					{allSearchTypes.map((type) => (
						<label className="checkbox-line compact" key={type}>
							<input
								checked={draft.types.includes(type)}
								onChange={() => toggleType(type)}
								type="checkbox"
							/>
							<span>{searchResultTypeLabel(type)}</span>
						</label>
					))}
				</fieldset>
				<div className="advanced-search-filters">
					<Field hint="exact w/handle" label="World">
						<input
							className="input"
							onChange={(event) => patchDraft({ world: event.target.value })}
							placeholder="w/handle"
							value={draft.world}
						/>
					</Field>
					<Field hint="exact f/handle" label="Forum">
						<input
							className="input"
							onChange={(event) => patchDraft({ forum: event.target.value })}
							placeholder="f/handle"
							value={draft.forum}
						/>
					</Field>
					<Field hint="exact u/username" label="Username">
						<input
							className="input"
							onChange={(event) => patchDraft({ username: event.target.value })}
							placeholder="u/username"
							value={draft.username}
						/>
					</Field>
				</div>
				<div className="advanced-search-actions">
					<button className="btn primary" disabled={!canSearch} type="submit">
						<Icon name="search" size={14} />
						Search
					</button>
					{loading && <span className="mini-status">Searching</span>}
					{message && !loading && <span className="mini-status">{message}</span>}
				</div>
			</form>

			{search && (
				<>
					<div className="section-head compact search-summary-head">
						<h2>
							{search.totalRelation === "lower_bound" ? "At least " : ""}
							{search.total} result{search.total === 1 ? "" : "s"}
						</h2>
						<span className="meta">Page {search.page}</span>
					</div>
					{groups.length === 0 ?
						<div className="empty compact-empty">No results match this search.</div>
					:	<div className="bot-table-shell search-table-shell">
							<div className="bot-table-scroll">
								<table className="bot-table search-table">
									<thead>
										<tr>
											<th scope="col">Result</th>
											<th scope="col">Details</th>
											<th scope="col">Rank</th>
										</tr>
									</thead>
									{groups.map((group) => (
										<tbody key={group.world.id}>
											<tr className={`bot-table-group-row search-world-row ${group.worldResult ? "" : "dimmed"}`.trim()}>
												<th scope="rowgroup">
													<SpaLink to={{ route: "world", worldHandle: group.world.handle }}>
														<Reference kind="world" link={false} name={group.world.handle} />
													</SpaLink>
												</th>
												<td>
													<TranslatableText as="span" className="search-result-primary" text={group.world.name} />
													<TranslatableText as="span" className="search-result-secondary" text={group.world.description} />
												</td>
												<td>{group.worldResult ? searchRankLabel(group.worldResult) : "context"}</td>
											</tr>
											{group.rows.map((result) => (
												<tr className="bot-table-row search-result-row" key={`${result.type}:${result.id}`}>
													<td>{searchResultLink(result)}</td>
													<td>
														<span className="search-result-primary">{searchResultTitle(result)}</span>
														<span className="search-result-secondary">{searchResultMeta(result)}</span>
													</td>
													<td>{searchRankLabel(result)}</td>
												</tr>
											))}
										</tbody>
									))}
								</table>
							</div>
						</div>
					}
					<div className="search-pagination">
						<button className="btn" disabled={loading || search.page <= 1} onClick={() => submit(search.page - 1)} type="button">
							Previous
						</button>
						<span className="meta">Page {search.page}</span>
						<button className="btn" disabled={loading || !search.hasNextPage} onClick={() => submit(search.page + 1)} type="button">
							Next
						</button>
					</div>
				</>
			)}
		</div>
	);
}

function searchResultGroups(results: SearchResult[]): SearchResultGroup[] {
	const groups = new Map<string, SearchResultGroup>();
	for (const result of results) {
		const group = groups.get(result.world.id) ?? { rows: [], world: result.world, worldResult: null };
		if (result.type === "world") {
			group.worldResult = result;
			group.world = result.world;
		} else {
			group.rows.push(result);
		}
		groups.set(result.world.id, group);
	}
	return [...groups.values()].sort((left, right) => {
		const leftRank = left.worldResult?.rank ?? left.rows[0]?.rank ?? Number.MAX_SAFE_INTEGER;
		const rightRank = right.worldResult?.rank ?? right.rows[0]?.rank ?? Number.MAX_SAFE_INTEGER;
		return leftRank - rightRank;
	});
}

function searchApiPath(state: SearchRouteState): string {
	const params = new URLSearchParams();
	params.set("q", state.query.trim());
	params.set("mode", state.mode);
	params.set("types", state.types.join(","));
	params.set("page", String(state.page));
	if (state.world.trim()) {
		params.set("world", state.world.trim());
	}
	if (state.forum.trim()) {
		params.set("forum", state.forum.trim());
	}
	if (state.username.trim()) {
		params.set("username", state.username.trim());
	}
	return `/api/search?${params}`;
}

function InferenceCostStatisticsScreen() {
	const [stats, setStats] = useState<GlobalInferenceCostPublicStats | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [message, setMessage] = useState("");

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		setMessage("");
		void api<{ stats: GlobalInferenceCostPublicStats | null }>("/api/statistics/inference-costs").then((result) => {
			if (cancelled) {
				return;
			}
			setLoaded(true);
			if (!result.ok) {
				setMessage(result.message);
				setStats(null);
				return;
			}
			setStats(result.data.stats);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const rows = stats ? globalInferenceCostTableRows(stats.rows) : [];
	const costFractionDigits = globalInferenceCostFractionDigits(stats?.rows.map((row) => row.effectiveCostPerMillionTokens) ?? []);

	return (
		<div className="main-inner inference-costs-page">
			<div className="section-head">
				<div>
					<h1>Inference Costs</h1>
					<p>Blended provider cost per million priced tokens, cached from recent Bickr usage across all participants.</p>
				</div>
			</div>
			<div className="token-usage-panel inference-cost-panel">
				<div className="token-usage-head">
					<div>
						<h3>Effective Model Cost</h3>
						<span>
							{stats ? `Last recomputed ${formatFullDate(stats.generatedAt)}; usage window ${formatShortDate(stats.windowStart)} - ${formatShortDate(stats.windowEnd)}`
							: loaded ? "No cached snapshot yet"
							: "Loading cached snapshot"}
						</span>
					</div>
				</div>
				{message && <div className="token-usage-empty">{message}</div>}
				{!message && loaded && !stats && (
					<div className="token-usage-empty">No cached statistics have been recomputed yet. Scheduled maintenance refreshes this snapshot daily.</div>
				)}
				{!loaded && <div className="token-usage-empty">Loading cached statistics.</div>}
				{stats && rows.length === 0 && (
					<div className="token-usage-empty">No priced inference usage has been recorded in the current retained window.</div>
				)}
				{stats && rows.length > 0 && (
					<table className="token-model-breakdown global-inference-cost-table">
						<thead>
							<tr>
								{globalInferenceCostTableHeaders.map((header) => (
									<th key={header} scope="col">{header}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map(({ key, row, showModelName }) => (
								<tr
									key={key}
									title={`${row.model} via ${row.providerName}`}
								>
									<td className="token-model-name">{showModelName ? row.model : ""}</td>
									<td className="token-provider-name">{row.providerName}</td>
									<td>{formatPerMillionTokenCost(row.effectiveCostPerMillionTokens, costFractionDigits)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}

function searchResultLink(result: SearchResult): ReactNode {
	if (result.type === "forum") {
		return <Reference kind="forum" name={result.handle} worldHandle={result.world.handle} />;
	}
	if (result.type === "bot") {
		return <Reference isBot kind="bot" name={result.handle} worldHandle={result.world.handle} />;
	}
	return <Reference kind="world" name={result.handle} />;
}

function searchResultTitle(result: SearchResult): string {
	if (result.type === "world") {
		return `w/${result.handle}`;
	}
	if (result.type === "forum") {
		return `f/${result.handle}`;
	}
	return `u/${result.handle}`;
}

function searchResultTypeLabel(type: SearchEntityType): string {
	switch (type) {
		case "world":
			return "World";
		case "forum":
			return "Forum";
		case "bot":
			return "Bot";
	}
}

function searchModeLabel(mode: SearchMode): string {
	switch (mode) {
		case "substring":
			return "Substring";
		case "fts":
			return "FTS";
		case "semantic":
			return "Semantic";
	}
}

function searchRankLabel(result: SearchResult): string {
	const score = result.score === undefined ? "" : ` · ${result.score.toFixed(3)}`;
	return `#${result.rank}${score}`;
}

function searchTypeSort(left: SearchEntityType, right: SearchEntityType): number {
	return allSearchTypes.indexOf(left) - allSearchTypes.indexOf(right);
}

function BotProfileHoverLink({
	bot,
	children,
	className,
	title,
}: {
	bot: BotSummary;
	children: ReactNode;
	className?: string;
	title?: string;
}) {
	const referenceData = useContext(ReferenceDataContext);
	const { navigate } = useContext(NavigationContext);
	const hoverTooltip = useContext(HoverTooltipContext);
	const tooltipId = useId();
	const meta = referenceMeta(referenceData, "bot", bot.handle, bot.homeWorldHandle);
	const route: ParsedRoute = { route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle };
	const popoverActive = hoverTooltip.activeId === tooltipId;
	return (
		<span
			className="ref-wrap bot-profile-hover-wrap"
			onBlur={() => hoverTooltip.hide(tooltipId)}
			onFocus={() => meta ? hoverTooltip.show(tooltipId) : undefined}
			onMouseEnter={() => meta ? hoverTooltip.show(tooltipId) : undefined}
			onMouseLeave={() => hoverTooltip.hide(tooltipId)}
		>
			<a
				className={className}
				href={routePath(route)}
				onClick={(event) => {
					if (!shouldHandleSpaClick(event)) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					hoverTooltip.clear();
					navigate(route);
				}}
				title={title}
			>
				{children}
			</a>
			{meta && <ReferencePopover active={popoverActive} meta={meta} worldHandle={bot.homeWorldHandle} />}
		</span>
	);
}

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

function HumanProfileScreen({
	busy,
	currentUser,
	handle,
	onDeleteProfile,
}: {
	busy: boolean;
	currentUser: PublicUser;
	handle: string;
	onDeleteProfile: () => Promise<boolean>;
}) {
	const [profile, setProfile] = useState<HumanProfile | null>(null);
	const [activeTab, setActiveTab] = useState<HumanProfileTab>("worlds");
	const [worldFilter, setWorldFilter] = useState("");
	const [forumFilter, setForumFilter] = useState("");
	const [botFilter, setBotFilter] = useState("");
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState("");
	const [confirmGeneral, setConfirmGeneral] = useState(false);
	const [confirmCascade, setConfirmCascade] = useState(false);
	const toast = useContext(ToastContext);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setMessage("");
		setProfile(null);
		void api<{ profile: HumanProfile }>(`/api/humans/${encodeURIComponent(handle)}`).then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setProfile(result.data.profile);
				setActiveTab("worlds");
				setWorldFilter("");
				setForumFilter("");
				setBotFilter("");
			} else {
				setMessage(result.message);
			}
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [handle]);

	const isSelf = profile?.isSelf ?? profile?.user.id === currentUser.id;
	const deleteEligibility = profile?.deleteEligibility;
	const canDelete = Boolean(isSelf && deleteEligibility?.canDelete);
	const filteredWorlds = useMemo(
		() => (profile?.worlds ?? []).filter((world) => matchesWorldSummaryFilter(worldFilter, world)),
		[profile?.worlds, worldFilter],
	);
	const filteredForums = useMemo(
		() => filterHumanForumGroups(profile?.forumsByWorld ?? [], forumFilter),
		[profile?.forumsByWorld, forumFilter],
	);
	const filteredBots = useMemo(
		() => filterHumanBotGroups(profile?.botsByWorld ?? [], botFilter),
		[profile?.botsByWorld, botFilter],
	);
	const tabs: Array<{ id: HumanProfileTab; label: string; count: number }> = [
		{ id: "worlds", label: "Worlds", count: profile?.totals.worlds ?? 0 },
		{ id: "forums", label: "Forums", count: profile?.totals.forums ?? 0 },
		{ id: "bots", label: "Bots", count: profile?.totals.bots ?? 0 },
	];

	async function deleteSelfProfile(): Promise<void> {
		const ok = await onDeleteProfile();
		if (ok) {
			toast.push("Deleted profile");
		}
	}

	if (loading) {
		return (
			<div className="main-inner">
				<div className="empty-state compact">Loading profile...</div>
			</div>
		);
	}
	if (!profile) {
		return (
			<div className="main-inner">
				<EmptyState title="Profile not found">{message || "This human profile is not available."}</EmptyState>
			</div>
		);
	}

	return (
		<div className="main-inner">
			<div className="profile-head human-profile-head">
				<Avatar actor="user" colorSeed={profile.user.handle} crop={profile.user.avatarCrop} imageUrl={profile.user.avatarUrl} name={profile.user.displayName} size="xl" />
				<div className="meta">
					<TranslatableText as="h1" className="name" text={profile.user.displayName} />
					<div className="handle">
						<Reference kind="human" link={false} name={profile.user.handle} />
					</div>
				</div>
				<div className="human-profile-stats">
					<span><b>{profile.totals.worlds}</b> worlds</span>
					<span><b>{profile.totals.forums}</b> forums</span>
					<span><b>{profile.totals.bots}</b> bots</span>
				</div>
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

				{activeTab === "worlds" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search worlds"
							onChange={setWorldFilter}
							placeholder="Search by w/handle, name, or description"
							value={worldFilter}
						/>
						<HumanWorldList
							emptyMessage={worldFilter.trim() ? "No worlds match this search." : "No owned worlds."}
							worlds={filteredWorlds}
						/>
					</section>
				)}

				{activeTab === "forums" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search forums"
							onChange={setForumFilter}
							placeholder="Search by f/handle, description, or world"
							value={forumFilter}
						/>
						<HumanForumGroups
							emptyMessage={forumFilter.trim() ? "No forums match this search." : "No owned forums."}
							groups={filteredForums}
						/>
					</section>
				)}

				{activeTab === "bots" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search bots"
							onChange={setBotFilter}
							placeholder="Search by u/handle, display name, bio, or world"
							value={botFilter}
						/>
						<HumanBotGroups
							emptyMessage={botFilter.trim() ? "No bots match this search." : "No owned bots."}
							groups={filteredBots}
						/>
					</section>
				)}
			</div>

			{isSelf && (
				<section className="danger-zone profile-delete-zone">
					<h3>Danger zone</h3>
					<p>Deleting this profile removes owned worlds, forums, and bots after confirmation.</p>
					{deleteEligibility && !deleteEligibility.canDelete && (
						<ProfileDeleteBlockers blockers={deleteEligibility.blockers} />
					)}
					<button className="btn danger solid" disabled={busy || !canDelete} onClick={() => setConfirmGeneral(true)} type="button">
						<Icon name="trash" size={14} />
						Delete profile
					</button>
				</section>
			)}

			<Confirm
				body="This starts permanent deletion for your human profile and owned Bickr entities. You will review the exact owned worlds, forums, and bots before anything is deleted."
				confirmText="Review deletion"
				danger
				onClose={() => setConfirmGeneral(false)}
				onConfirm={() => setConfirmCascade(true)}
				open={confirmGeneral}
				title="Delete this profile?"
			/>
			<Confirm
				body={<ProfileDeleteCascadeSummary profile={profile} />}
				confirmText="Delete profile"
				danger
				onClose={() => setConfirmCascade(false)}
				onConfirm={() => void deleteSelfProfile()}
				open={confirmCascade}
				title="Confirm profile deletion"
			/>
		</div>
	);
}

function HumanWorldList({ emptyMessage, worlds }: { emptyMessage: string; worlds: WorldSummary[] }) {
	if (worlds.length === 0) {
		return <div className="empty compact-empty">{emptyMessage}</div>;
	}
	return (
		<div className="human-entity-list">
			{worlds.map((world) => (
				<article className="human-entity-row" key={world.id}>
					<div>
							<div className="human-entity-title">
								<SpaLink className="linklike" to={{ route: "world", worldHandle: world.handle }}>
									<TranslatableText as="span" text={world.name} />
								</SpaLink>
							<Reference kind="world" name={world.handle} />
						</div>
						<TranslatableText as="div" className="human-entity-desc" text={world.description} />
					</div>
					<span className="meta"><TimeAgoLabel value={world.updatedAt} /></span>
				</article>
			))}
		</div>
	);
}

function HumanForumGroups({ emptyMessage, groups }: { emptyMessage: string; groups: HumanOwnedForumGroup[] }) {
	if (groups.length === 0) {
		return <div className="empty compact-empty">{emptyMessage}</div>;
	}
	return (
		<div className="human-group-list">
			{groups.map((group) => (
				<section className="bot-follow-section" key={group.world.id}>
					<div className="bot-world-head">
						<span><Reference kind="world" name={group.world.handle} /></span>
						<span className="bot-world-head-actions">
							{group.forums.length} forum{group.forums.length === 1 ? "" : "s"}
						</span>
					</div>
					<div className="forum-list">
						{group.forums.map((forum) => (
							<ForumRow forum={forum} key={forum.id} />
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function HumanBotGroups({ emptyMessage, groups }: { emptyMessage: string; groups: HumanOwnedBotGroup[] }) {
	if (groups.length === 0) {
		return <div className="empty compact-empty">{emptyMessage}</div>;
	}
	return (
		<div className="human-group-list">
			{groups.map((group) => (
				<section className="bot-follow-section" key={group.world.id}>
					<div className="bot-world-head">
						<span><Reference kind="world" name={group.world.handle} /></span>
						<span className="bot-world-head-actions">
							{group.bots.length} bot{group.bots.length === 1 ? "" : "s"}
						</span>
					</div>
					<div className="bot-grid">
						{group.bots.map((bot) => (
							<BotPublicProfileCard bot={bot} key={bot.id} />
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function ProfileDeleteBlockers({ blockers }: { blockers: HumanProfileDeleteBlocker[] }) {
	const blockingBots = blockers.reduce((count, blocker) => count + blocker.bots.length, 0);
	return (
		<div className="delete-blockers">
			<b>Deletion blocked</b>
			<span>
				{blockingBots} bot{blockingBots === 1 ? "" : "s"} owned by other profiles exist in owned worlds.
			</span>
			{blockers.map((blocker) => (
				<details key={blocker.world.id}>
					<summary>
						<Reference kind="world" name={blocker.world.handle} />: {blocker.bots.length} bot{blocker.bots.length === 1 ? "" : "s"}
					</summary>
					<ul>
						{blocker.bots.map((bot) => (
							<li key={bot.id}>
								<Reference isBot kind="bot" name={bot.handle} worldHandle={bot.homeWorldHandle} />
								{bot.owner && <> owned by <HumanReference user={bot.owner} /></>}
							</li>
						))}
					</ul>
				</details>
			))}
		</div>
	);
}

function ProfileDeleteCascadeSummary({ profile }: { profile: HumanProfile }) {
	return (
		<div className="profile-delete-summary">
			<p>
				This will delete <b>{textValue(profile.user.displayName)}</b> (<Reference kind="human" name={profile.user.handle} />)
				and the owned entities below.
			</p>
			<details>
				<summary>{profile.totals.worlds} world{profile.totals.worlds === 1 ? "" : "s"} will be deleted</summary>
				<DeleteWorldList worlds={profile.worlds} />
			</details>
			<details>
				<summary>{profile.totals.forums} forum{profile.totals.forums === 1 ? "" : "s"} will be deleted</summary>
				<DeleteForumGroups groups={profile.forumsByWorld} />
			</details>
			<details>
				<summary>{profile.totals.bots} bot{profile.totals.bots === 1 ? "" : "s"} will be deleted</summary>
				<DeleteBotGroups groups={profile.botsByWorld} />
			</details>
		</div>
	);
}

function DeleteWorldList({ worlds }: { worlds: WorldSummary[] }) {
	if (worlds.length === 0) {
		return <div className="empty compact-empty">None</div>;
	}
	return (
		<ul>
			{worlds.map((world) => (
				<li key={world.id}>
					<Reference kind="world" name={world.handle} /> <TranslatableText as="span" text={world.name} />
				</li>
			))}
		</ul>
	);
}

function DeleteForumGroups({ groups }: { groups: HumanOwnedForumGroup[] }) {
	if (groups.length === 0) {
		return <div className="empty compact-empty">None</div>;
	}
	return (
		<div className="delete-group-stack">
			{groups.map((group) => (
				<div key={group.world.id}>
					<b><Reference kind="world" name={group.world.handle} /></b>
					<ul>
						{group.forums.map((forum) => (
							<li key={forum.id}>
								<Reference kind="forum" name={forum.handle} worldHandle={forum.worldHandle} />
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

function DeleteBotGroups({ groups }: { groups: HumanOwnedBotGroup[] }) {
	if (groups.length === 0) {
		return <div className="empty compact-empty">None</div>;
	}
	return (
		<div className="delete-group-stack">
			{groups.map((group) => (
				<div key={group.world.id}>
					<b><Reference kind="world" name={group.world.handle} /></b>
					<ul>
						{group.bots.map((bot) => (
							<li key={bot.id}>
								<Reference isBot kind="bot" name={bot.handle} worldHandle={bot.homeWorldHandle} /> <TranslatableText as="span" text={bot.displayName} />
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

function matchesWorldSummaryFilter(query: string, world: WorldSummary): boolean {
	return matchesFilter(query, world.handle, world.name, world.description);
}

function matchesForumSummaryFilter(query: string, forum: ForumSummary): boolean {
	return matchesFilter(query, forum.handle, forum.description, forum.worldHandle);
}

function filterHumanForumGroups(groups: HumanOwnedForumGroup[], query: string): HumanOwnedForumGroup[] {
	return groups.flatMap((group) => {
		const worldMatches = matchesWorldSummaryFilter(query, group.world);
		const forums = worldMatches ? group.forums : group.forums.filter((forum) => matchesForumSummaryFilter(query, forum));
		return forums.length ? [{ ...group, forums }] : [];
	});
}

function filterHumanBotGroups(groups: HumanOwnedBotGroup[], query: string): HumanOwnedBotGroup[] {
	return groups.flatMap((group) => {
		const worldMatches = matchesWorldSummaryFilter(query, group.world);
		const bots = worldMatches ? group.bots : group.bots.filter((bot) => matchesBotProfileFilter(query, bot));
		return bots.length ? [{ ...group, bots }] : [];
	});
}

function ProfileScreen({
	busy,
	onAuthIdentityUnlink,
	onAvatarUpdated,
	onOpenAvatarGeneration,
	onSave,
	onSignOut,
	user,
}: {
	busy: boolean;
	onAuthIdentityUnlink: (provider: AuthProvider) => Promise<UserProfile | null>;
	onAvatarUpdated: (profile: UserProfile) => void;
	onOpenAvatarGeneration: () => void;
	onSave: (draft: UpdateUserProfileInput) => Promise<UserProfile | null>;
	onSignOut: () => void;
	user: PublicUser;
}) {
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [draft, setDraft] = useState<ProfileDraft>(() => profileDraftFromUser(user));
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState("");
	const [pendingUnlinkProvider, setPendingUnlinkProvider] = useState<AuthProvider | null>(null);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [cropOpen, setCropOpen] = useState(false);
	const [deleteAvatarConfirm, setDeleteAvatarConfirm] = useState(false);
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
	const [profileAvatarFailed, setProfileAvatarFailed] = useState(false);
	const toast = useContext(ToastContext);
	const t = useUiText();

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

	useEffect(() => {
		setProfileAvatarFailed(false);
	}, [profile?.avatarUrl, user.avatarUrl]);

	const profileIncomplete = !(profile?.profileComplete ?? user.profileComplete);
	const avatarProfile = profile ?? user;
	const authIdentities = profile?.authIdentities ?? [];
	const dirty = profile ? profileDraftChanged(draft, profile) : true;
	const valid =
		isValidHandle(draft.handle) &&
		draft.displayName.trim().length > 0 &&
		!providerRoutingDraftError(draft.inference.providerRouting) &&
		!providerRoutingDraftError(draft.inference.imageGenerationProviderRouting) &&
		!providerRoutingDraftError(draft.inference.translationProviderRouting);
	const canSave = (dirty || profileIncomplete) && valid && !busy && !loading;

	async function save(): Promise<void> {
		const language = languageInputValue(draft.language);
		const saved = await onSave({
			handle: draft.handle,
			language,
			uiLocale: draft.uiLocale === "system" ? "system" : languageInputValue(draft.uiLocale) ?? defaultLanguageTag,
			displayName: localizedText(draft.displayName, language),
			inferenceSettings: inferenceInputFromDraft(draft.inference, undefined, { includeImageGeneration: true, includeTranslation: true }, language),
		});
		if (saved) {
			setProfile(saved);
			setDraft(profileDraftFromProfile(saved));
			toast.push(t.profile.savedProfile);
		}
	}

	async function unlinkAuthIdentity(provider: AuthProvider): Promise<void> {
		const saved = await onAuthIdentityUnlink(provider);
		if (saved) {
			setProfile(saved);
			toast.push(`Unlinked ${authProviderLabel(provider)}`);
		}
	}

	function applySavedAvatarProfile(saved: UserProfile): void {
		setProfile(saved);
		onAvatarUpdated(saved);
	}

	async function deleteAvatar(): Promise<void> {
		const target = userAvatarTarget(avatarProfile);
		const result = await runApiAction(setMessage, () => api<UserMutationResponse>(target.endpoints.clear, { method: "DELETE" }));
		if (!result) {
			return;
		}
		applySavedAvatarProfile(result.data.profile);
		setDeleteAvatarConfirm(false);
		toast.push("Deleted avatar");
	}

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<h1>
						<Avatar
							actor="user"
							colorSeed={draft.handle || user.handle}
							crop={avatarProfile.avatarCrop}
							imageUrl={avatarProfile.avatarUrl}
							name={draft.displayName || user.displayName}
							size="lg"
						/>
						<span>{draft.displayName || textValue(user.displayName)}</span>
					</h1>
					<p className="sub">
						{profileIncomplete ?
							t.profile.subtitleIncomplete
						:	t.profile.subtitleReady}
					</p>
				</div>
				<div className="actions">
					<button className="btn ghost" disabled={busy} onClick={onSignOut} type="button">
						{t.profile.signOut}
					</button>
					<button className="btn primary" disabled={!canSave} onClick={() => void save()} type="button">
						{profileIncomplete ? t.profile.saveAndActivate : t.profile.saveProfile}
					</button>
				</div>
			</div>

			{profileIncomplete && (
				<div className="setup-banner">
					<Icon name="info" size={16} />
					<div>
						<b>{t.profile.setupRequiredTitle}</b>
						<span>
							{t.profile.setupRequiredBody}
						</span>
					</div>
				</div>
			)}

			<div className="edit-layout">
				<div>
					<section className="section">
						<div className="section-head">
							<h2>{t.profile.sectionTitle}</h2>
							<span className="meta">{loading ? t.profile.loading : profileIncomplete ? t.profile.setupRequiredMeta : t.profile.editable}</span>
						</div>
						<div className="field-stack">
							<div className="field-row">
								<Field label={t.profile.displayName}>
									<input
										className="input"
										maxLength={80}
										onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
										value={draft.displayName}
									/>
								</Field>
								<Field help={t.profile.handleHelp} label={t.profile.handle}>
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
								<div className="profile-avatar-editor">
									<div className="profile-avatar-column">
										<button
											aria-label={avatarProfile.avatarUrl && !profileAvatarFailed ? "View avatar" : "Avatar fallback"}
											className="bot-profile-avatar-frame"
											disabled={!avatarProfile.avatarUrl || profileAvatarFailed}
											onClick={() => avatarProfile.avatarUrl && !profileAvatarFailed ? setLightboxUrl(avatarProfile.avatarUrl) : undefined}
											type="button"
										>
											{avatarProfile.avatarUrl && !profileAvatarFailed ?
												<FallbackImage
													alt=""
													fallbackSrc={avatarProfile.avatarUrl}
													onFinalError={() => setProfileAvatarFailed(true)}
													src={cloudflareImageUrl(avatarProfile.avatarUrl, { width: avatarImagePixels(220), format: "auto" })}
												/>
											:	<Avatar actor="user" colorSeed={draft.handle || user.handle} name={draft.displayName || user.displayName} size="hero" />
											}
										</button>
										<div className="profile-avatar-actions">
											<button
												className="btn icon-only"
												disabled={!avatarProfile.avatarUrl || profileAvatarFailed}
												onClick={() => setCropOpen(true)}
												title="Crop avatar"
												type="button"
											>
												<Icon name="crop" size={16} />
											</button>
											<button className="btn icon-only" onClick={() => setUploadOpen(true)} title="Upload avatar" type="button">
												<Icon name="upload" size={16} />
											</button>
											<button className="btn icon-only" onClick={onOpenAvatarGeneration} title="Generate avatar" type="button">
												<Icon name="sparkles" size={16} />
											</button>
											<button
												className="btn icon-only danger"
												disabled={!avatarProfile.avatarUrl}
												onClick={() => setDeleteAvatarConfirm(true)}
												title="Delete avatar"
												type="button"
											>
												<Icon name="trash" size={16} />
											</button>
										</div>
									</div>
								</div>
								<div className="field-row">
									<LanguageField
										label={t.profile.accountLanguage}
										onChange={(language) => setDraft((current) => ({ ...current, language }))}
										value={draft.language}
									/>
									<Field help={t.profile.uiLanguageHelp} label={t.profile.uiLanguage}>
										<select
											className="input"
											onChange={(event) => setDraft((current) => ({ ...current, uiLocale: event.target.value }))}
											value={draft.uiLocale}
										>
											{uiLocaleOptions.map((option) => (
												<option key={option.value} value={option.value}>
													{option.value === "system" ? t.profile.systemUiLanguage : option.label}
												</option>
											))}
										</select>
									</Field>
								</div>
								{message && <div className="runtime-message">{message}</div>}
							</div>
						</section>

					<section className="section">
						<div className="section-head">
							<h2>Inference Provider</h2>
							<span className="meta">credentials and endpoint</span>
						</div>
						<InferenceProviderFields
							draft={draft.inference}
							onChange={(inference) => setDraft((current) => ({ ...current, inference }))}
							scope="profile"
						/>
					</section>
					<section className="section">
						<div className="section-head">
							<h2>Inference: Agentic Loop</h2>
							<span className="meta">used by participants without overrides</span>
						</div>
						<AgenticLoopInferenceFields
							draft={draft.inference}
							onChange={(inference) => setDraft((current) => ({ ...current, inference }))}
							scope="profile"
						/>
					</section>
					<section className="section">
						<div className="section-head">
							<h2>Inference: Image Generation</h2>
							<span className="meta">avatar generation defaults</span>
						</div>
						<ImageGenerationInferenceFields
							draft={draft.inference}
							onChange={(inference) => setDraft((current) => ({ ...current, inference }))}
						/>
					</section>
					<section className="section">
						<div className="section-head">
							<h2>Inference: Translation</h2>
							<span className="meta">inline content translation</span>
						</div>
						<TranslationInferenceFields
							draft={draft.inference}
							onChange={(inference) => setDraft((current) => ({ ...current, inference }))}
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
							<RuntimeRow label="Created" value={profile ? <TimeAgoLabel value={profile.createdAt} /> : "..."} />
							<RuntimeRow label="Updated" value={profile ? <TimeAgoLabel value={profile.updatedAt} /> : "..."} />
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
			<AvatarUploadModal
				onClose={() => setUploadOpen(false)}
				onSaved={(saved) => applySavedAvatarProfile(saved)}
				open={uploadOpen}
				target={userAvatarTarget(avatarProfile)}
			/>
			<AvatarCropModal
				onClose={() => setCropOpen(false)}
				onSaved={(saved) => applySavedAvatarProfile(saved)}
				open={cropOpen}
				target={userAvatarTarget(avatarProfile)}
			/>
			<Confirm
				body="Delete this profile avatar? You can upload or generate a new one later."
				confirmText="Delete avatar"
				danger
				onClose={() => setDeleteAvatarConfirm(false)}
				onConfirm={() => void deleteAvatar()}
				open={deleteAvatarConfirm}
				title="Delete avatar?"
			/>
			<ImageLightbox onClose={() => setLightboxUrl(null)} title={draft.displayName || textValue(user.displayName)} url={lightboxUrl} />
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

export function InferenceProviderFields({
	draft,
	inheritedSettings,
	onChange,
	scope,
}: {
	draft: InferenceDraft;
	inheritedSettings?: BotInferenceSettings | null;
	onChange: (draft: InferenceDraft) => void;
	scope: "bot" | "profile";
}) {
	function patch(update: Partial<InferenceDraft>): void {
		onChange({ ...draft, ...update });
	}
	const baseUrlPlaceholder = effectiveInferenceDraftBaseUrl(draft, inheritedSettings);

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
			<Field help={scope === "bot" ? "Blank inherits the profile or OpenRouter default URL." : "Blank uses OpenRouter's default URL."} label="Base URL">
				<input
					className="input"
					onChange={(event) => patch({ baseUrl: event.target.value })}
					placeholder={baseUrlPlaceholder}
					value={draft.baseUrl}
				/>
			</Field>
		</div>
	);
}

export function AgenticLoopInferenceFields({
	draft,
	inheritedSettings,
	modelSuggestions = [],
	onChange,
	scope,
}: {
	draft: InferenceDraft;
	inheritedSettings?: BotInferenceSettings | null;
	modelSuggestions?: string[];
	onChange: (draft: InferenceDraft) => void;
	scope: "bot" | "profile";
}) {
	const modelListId = useId();
	const fallbackContext = inferenceFallbackContextForDraft(draft, inheritedSettings);
	const modelPlaceholder = effectiveInferenceDraftModel(draft, fallbackContext);
	const temperaturePlaceholder = effectiveNumberPlaceholder(fallbackContext?.temperature, defaultTextGenerationTemperature);
	const topKPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.topK);
	const topPPlaceholder = effectiveNumberPlaceholder(fallbackContext?.topP, 1);
	const minPPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.minP);
	const frequencyPenaltyPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.frequencyPenalty);
	const presencePenaltyPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.presencePenalty);
	const repetitionPenaltyPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.repetitionPenalty);
	const capabilityContext = inferenceCapabilityContextForDraft(draft, inheritedSettings);
	function patch(update: Partial<InferenceDraft>): void {
		const updated = { ...draft, ...update };
		const rebased = rebaseInferenceDraftForFallbackChange(
			draft,
			updated,
			fallbackContext,
			inferenceFallbackContextForDraft(updated, inheritedSettings),
		);
		onChange(normalizeInferenceDraftForCapabilities(rebased, inheritedSettings));
	}

	return (
		<div className="field-stack">
			<div className="inference-row model-reasoning-row">
				<Field
					help={
						scope === "bot" ?
							"Blank inherits the linked source, profile, or environment model."
						:	"Blank uses the environment model."
					}
					label="Model"
				>
					<input
						className="input"
						list={modelSuggestions.length > 0 ? modelListId : undefined}
						onChange={(event) => patch({ model: event.target.value })}
						placeholder={modelPlaceholder}
						value={draft.model}
					/>
					{modelSuggestions.length > 0 && (
						<datalist id={modelListId}>
							{modelSuggestions.map((model) => (
								<option key={model} value={model} />
							))}
						</datalist>
					)}
				</Field>
				<Field label="Reasoning">
					<select
						className="input reasoning-select"
						onChange={(event) => patch({ reasoningEffort: event.target.value })}
						value={draft.reasoningEffort}
					>
						{reasoningEffortOptions.map((option) => (
							<option disabled={option.value === "none" && !capabilityContext.supportsReasoningNone} key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
				<Field label="Tool calls">
					<select
						className="input reasoning-select"
						onChange={(event) => patch({ toolCalls: event.target.value })}
						value={draft.toolCalls}
					>
						{toolCallOptions.map((option) => (
							<option disabled={option.value === "require" && !capabilityContext.supportsRequiredToolCalls} key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
			</div>
			<div className="inference-row three">
				<Field className="checkbox-help-field" help="Turn off for providers that reject tool-enabled requests ending with participant narration.">
					<label className="checkbox-line">
						<input
							checked={draft.supportsPrefill}
							disabled={!capabilityContext.supportsPrefill}
							onChange={(event) => patch({ supportsPrefill: event.target.checked })}
							type="checkbox"
						/>
						<span>Supports prefill</span>
					</label>
				</Field>
				<Field help="How context compaction asks for the memory summary." label="Compaction mode">
					<select
						className="input reasoning-select"
						onChange={(event) => patch({ compactionMode: event.target.value as BotCompactionMode })}
						value={draft.compactionMode}
					>
						{compactionModeOptions.map((option) => (
							<option disabled={option.value === "structured_output" && !capabilityContext.supportsStructuredCompaction} key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
				<Field help="OpenRouter prompt caching for Claude loop requests. Writes cost more than normal input tokens." label="Prompt cache">
					<select
						className="input"
						onChange={(event) => patch({ promptCacheMode: event.target.value as BotPromptCacheMode })}
						value={draft.promptCacheMode}
					>
						{promptCacheModeOptions.map((option) => (
							<option disabled={option.value !== "off" && !capabilityContext.supportsPromptCacheControl} key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
			</div>
			<div className="inference-row four">
				<Field label="Temperature">
					<input
						className="input"
						max="2"
						min="0"
						onChange={(event) => patch({ temperature: event.target.value })}
						placeholder={temperaturePlaceholder}
						step="0.05"
						type="number"
						value={draft.temperature}
					/>
				</Field>
				<Field label="Top K">
					<input
						className="input"
						min="0"
						onChange={(event) => patch({ topK: event.target.value })}
						placeholder={topKPlaceholder}
						step="1"
						type="number"
						value={draft.topK}
					/>
				</Field>
				<Field label="Top P">
					<input
						className="input"
						max="1"
						min="0"
						onChange={(event) => patch({ topP: event.target.value })}
						placeholder={topPPlaceholder}
						step="0.01"
						type="number"
						value={draft.topP}
					/>
				</Field>
				<Field label="Min P">
					<input
						className="input"
						max="1"
						min="0"
						onChange={(event) => patch({ minP: event.target.value })}
						placeholder={minPPlaceholder}
						step="0.01"
						type="number"
						value={draft.minP}
					/>
				</Field>
			</div>
			<div className="inference-row three">
				<Field label="Frequency penalty">
					<input
						className="input"
						max="2"
						min="-2"
						onChange={(event) => patch({ frequencyPenalty: event.target.value })}
						placeholder={frequencyPenaltyPlaceholder}
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
						placeholder={presencePenaltyPlaceholder}
						step="0.05"
						type="number"
						value={draft.presencePenalty}
					/>
				</Field>
				<Field label="Repetition penalty">
					<input
						className="input"
						max="2"
						min="0"
						onChange={(event) => patch({ repetitionPenalty: event.target.value })}
						placeholder={repetitionPenaltyPlaceholder}
						step="0.05"
						type="number"
						value={draft.repetitionPenalty}
					/>
				</Field>
			</div>
			<ProviderRoutingField
				onChange={(providerRouting) => patch({ providerRouting })}
				placeholder={providerRoutingPlaceholderForInheritance(fallbackContext)}
				value={draft.providerRouting}
			/>
		</div>
	);
}

const openRouterProviderRoutingDocsUrl = "https://openrouter.ai/docs/guides/routing/provider-selection";
const openRouterImageGenerationDocsUrl = "https://openrouter.ai/docs/guides/overview/multimodal/image-generation#aspect-ratio";
export const providerRoutingPlaceholder = "{\n\n}";
const reasoningEffortOptions = [
	{ value: "default", label: "Default" },
	{ value: "none", label: "None" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "XHigh" },
] as const;

const imageAspectRatioLabels: Record<string, string> = {
	"1:1": "1:1 - square, 1024x1024",
	"2:3": "2:3 - portrait, 832x1248",
	"3:2": "3:2 - landscape, 1248x832",
	"3:4": "3:4 - portrait, 864x1184",
	"4:3": "4:3 - landscape, 1184x864",
	"4:5": "4:5 - portrait, 896x1152",
	"5:4": "5:4 - landscape, 1152x896",
	"9:16": "9:16 - vertical, 768x1344",
	"16:9": "16:9 - wide, 1344x768",
	"21:9": "21:9 - ultrawide, 1536x672",
	"1:4": "1:4 - extended tall",
	"4:1": "4:1 - extended wide",
	"1:8": "1:8 - extended extra tall",
	"8:1": "8:1 - extended extra wide",
	"2:1": "2:1 - banner",
	"1:2": "1:2 - tall banner",
	"19.5:9": "19.5:9 - phone wide",
	"9:19.5": "9:19.5 - phone vertical",
	"20:9": "20:9 - ultrawide phone",
	"9:20": "9:20 - ultra-tall phone",
	auto: "Auto - Grok chooses",
};

const imageSizeLabels: Record<string, string> = {
	"0.5K": "0.5K - lower resolution",
	"1K": "1K - standard",
	"2K": "2K - higher resolution",
	"4K": "4K - highest resolution",
	"1024x1024": "Square (1024x1024)",
	"1024x1536": "Portrait (1024x1536)",
	"1536x1024": "Landscape (1536x1024)",
	"2560x1440": "2K (2560x1440)",
	"3840x2160": "4K (3840x2160)",
};

function imageAspectRatioLabel(value: string): string {
	return imageAspectRatioLabels[value] ?? value;
}

function imageSizeLabel(value: string): string {
	return imageSizeLabels[value] ?? value;
}

function ImageConfigHelp({ text }: { text: string }) {
	return (
		<>
			{text}{" "}
			<a href={openRouterImageGenerationDocsUrl} rel="noreferrer" target="_blank">
				Docs
			</a>
			.
		</>
	);
}

function imageGenerationConfigDraftError(draft: InferenceDraft): string {
	const aspectRatio = draft.imageGenerationAspectRatio.trim();
	const imageSize = draft.imageGenerationImageSize.trim();
	if (aspectRatio.length > 40) {
		return "Image generation aspect ratio must be 40 characters or fewer.";
	}
	if (imageSize.length > 40) {
		return "Image generation size must be 40 characters or fewer.";
	}
	return "";
}

const toolCallOptions = [
	{ value: "require", label: "Require" },
	{ value: "railroad", label: "Railroad" },
	{ value: "at_will", label: "At will" },
] as const;
const compactionModeOptions = [
	{ value: "structured_output", label: "Structured output" },
	{ value: "tool_call", label: "Tool call" },
	{ value: "tool_call_cache_friendly", label: "Tool call (cache-friendly)" },
] as const satisfies readonly { value: BotCompactionMode; label: string }[];
const promptCacheModeOptions = [
	{ value: "off", label: "Off" },
	{ value: "openrouter_anthropic_5m", label: "Claude 5m (1.25x write)" },
	{ value: "openrouter_anthropic_1h", label: "Claude 1h (2x write)" },
] as const satisfies readonly { value: BotPromptCacheMode; label: string }[];
const structuredToolCallOptions = toolCallOptions.filter((option) => option.value !== "at_will");

function ProviderRoutingField({
	onChange,
	placeholder = providerRoutingPlaceholder,
	value,
}: {
	onChange: (value: string) => void;
	placeholder?: string;
	value: string;
}) {
	const error = providerRoutingDraftError(value);
	return (
		<div className="provider-routing-field">
			<Field label="Provider routing">
				<textarea
					className={`textarea provider-routing-editor ${error ? "invalid" : ""}`}
					onChange={(event) => onChange(event.target.value)}
					placeholder={placeholder}
					rows={7}
					spellCheck={false}
					value={value}
				/>
				{error ?
					<div className="runtime-message error">{error}</div>
				:	<div className="help">
						Sent as OpenRouter's <code>provider</code> request-body object. See{" "}
						<a href={openRouterProviderRoutingDocsUrl} rel="noreferrer" target="_blank">
							OpenRouter provider routing docs
						</a>
						.
					</div>
					}
				</Field>
		</div>
	);
}

function ImageGenerationInferenceFields({
	draft,
	models,
	onChange,
}: {
	draft: InferenceDraft;
	models?: OpenRouterImageModel[];
	onChange: (draft: InferenceDraft) => void;
}) {
	return (
		<div className="field-stack">
			<ImageGenerationBasicFields draft={draft} models={models} onChange={onChange} />
			<ImageGenerationAdvancedFields draft={draft} onChange={onChange} />
		</div>
	);
}

function ImageGenerationBasicFields({
	draft,
	models,
	onChange,
}: {
	draft: InferenceDraft;
	models?: OpenRouterImageModel[];
	onChange: (draft: InferenceDraft) => void;
}) {
	const loadedModelsQuery = useApiQuery<{ models: OpenRouterImageModel[] }>(
		models ? null : "/api/openrouter/image-models",
		[models],
	);
	const loadedModels = models ?? loadedModelsQuery.data?.models ?? [];
	const loadError = models ? "" : loadedModelsQuery.error;
	function patch(update: Partial<InferenceDraft>): void {
		onChange({ ...draft, ...update });
	}
	function patchModel(model: string): void {
		patch({ imageGenerationModel: model });
	}
	const modelSelected = draft.imageGenerationModel.trim().length > 0;
	const aspectRatioListId = useId();
	const imageSizeListId = useId();
	const suggestedAspectRatios = openRouterSuggestedImageAspectRatios(draft.imageGenerationModel);
	const suggestedImageSizes = openRouterSuggestedImageSizes(draft.imageGenerationModel);
	return (
		<div className="inference-row three">
			<Field help={loadError || "Only OpenRouter models that advertise image output are listed."} label="Model">
				<select
					className="input"
					onChange={(event) => patchModel(event.target.value)}
					value={draft.imageGenerationModel}
					>
						<option value="">Choose a model</option>
						{loadedModels.map((model) => (
							<option key={model.id} value={model.id}>
								{model.name ? `${model.name} (${model.id})` : model.id}
							</option>
						))}
					</select>
				</Field>
				<Field
					help={<ImageConfigHelp text="OpenRouter uses the selected model's default when this is left blank. Suggested ratios are model-specific; custom values are sent as typed." />}
					label="Aspect ratio"
				>
					<input
						className="input"
						disabled={!modelSelected}
						list={aspectRatioListId}
						onChange={(event) => patch({ imageGenerationAspectRatio: event.target.value })}
						placeholder="Default"
						value={draft.imageGenerationAspectRatio}
					/>
					<datalist id={aspectRatioListId}>
						{suggestedAspectRatios.map((ratio) => (
							<option key={ratio} label={imageAspectRatioLabel(ratio)} value={ratio} />
						))}
					</datalist>
				</Field>
				<Field
					help={<ImageConfigHelp text="OpenRouter uses the selected model's default when this is left blank. Suggested sizes are model-specific; custom values are sent as typed." />}
					label="Image size"
				>
					<input
						className="input"
						disabled={!modelSelected}
						list={imageSizeListId}
						onChange={(event) => patch({ imageGenerationImageSize: event.target.value })}
						placeholder="Default"
						value={draft.imageGenerationImageSize}
					/>
					<datalist id={imageSizeListId}>
						{suggestedImageSizes.map((size) => (
							<option key={size} label={imageSizeLabel(size)} value={size} />
						))}
					</datalist>
				</Field>
			</div>
		);
	}

function ImageGenerationAdvancedFields({
	draft,
	onChange,
}: {
	draft: InferenceDraft;
	onChange: (draft: InferenceDraft) => void;
}) {
	function patch(update: Partial<InferenceDraft>): void {
		onChange({ ...draft, ...update });
	}
	const modelSelected = draft.imageGenerationModel.trim().length > 0;
	return (
		<div className="field-stack">
			<div className="inference-row four">
				<Field label="Temperature">
					<input
						className="input"
						disabled={!modelSelected}
						max="2"
						min="0"
						onChange={(event) => patch({ imageGenerationTemperature: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.imageGenerationTemperature}
					/>
				</Field>
				<Field label="Top K">
					<input
						className="input"
						disabled={!modelSelected}
						min="0"
						onChange={(event) => patch({ imageGenerationTopK: event.target.value })}
						placeholder="default"
						step="1"
						type="number"
						value={draft.imageGenerationTopK}
					/>
				</Field>
				<Field label="Top P">
					<input
						className="input"
						disabled={!modelSelected}
						max="1"
						min="0"
						onChange={(event) => patch({ imageGenerationTopP: event.target.value })}
						placeholder="default"
						step="0.01"
						type="number"
						value={draft.imageGenerationTopP}
					/>
				</Field>
				<Field label="Min P">
					<input
						className="input"
						disabled={!modelSelected}
						max="1"
						min="0"
						onChange={(event) => patch({ imageGenerationMinP: event.target.value })}
						placeholder="default"
						step="0.01"
						type="number"
						value={draft.imageGenerationMinP}
					/>
				</Field>
			</div>
			<div className="inference-row three">
				<Field label="Frequency penalty">
					<input
						className="input"
						disabled={!modelSelected}
						max="2"
						min="-2"
						onChange={(event) => patch({ imageGenerationFrequencyPenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.imageGenerationFrequencyPenalty}
					/>
				</Field>
				<Field label="Presence penalty">
					<input
						className="input"
						disabled={!modelSelected}
						max="2"
						min="-2"
						onChange={(event) => patch({ imageGenerationPresencePenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.imageGenerationPresencePenalty}
					/>
				</Field>
				<Field label="Repetition penalty">
					<input
						className="input"
						disabled={!modelSelected}
						max="2"
						min="0"
						onChange={(event) => patch({ imageGenerationRepetitionPenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.imageGenerationRepetitionPenalty}
					/>
				</Field>
			</div>
			<fieldset disabled={!modelSelected}>
				<ProviderRoutingField
					onChange={(imageGenerationProviderRouting) => patch({ imageGenerationProviderRouting })}
					value={draft.imageGenerationProviderRouting}
				/>
			</fieldset>
		</div>
	);
}

function TranslationInferenceFields({
	draft,
	modelSuggestions = [],
	onChange,
}: {
	draft: InferenceDraft;
	modelSuggestions?: string[];
	onChange: (draft: InferenceDraft) => void;
}) {
	const modelListId = useId();
	const effectiveLoopModel = effectiveInferenceDraftModel(draft);
	const translationModelSet = draft.translationModel.trim().length > 0;
	const translationModel = draft.translationModel.trim() || effectiveLoopModel;
	const translationBaseUrl = effectiveInferenceDraftBaseUrl(draft);
	const capabilityContext = inferenceCapabilityContext(translationModel, translationBaseUrl);
	const controlsDisabled = !translationModelSet;
	function patch(update: Partial<InferenceDraft>): void {
		onChange(normalizeTranslationDraftForCapabilities({ ...draft, ...update }));
	}

	return (
		<div className="field-stack">
			<div className="inference-row translation-enable-row">
				<label className="checkbox-line">
					<input
						checked={draft.translationEnabled}
						onChange={(event) => patch({ translationEnabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Inline translations</span>
				</label>
			</div>
			{draft.translationEnabled && (
				<>
					<Field help="Sent with the source text for each translation request." label="Translation prompt">
						<textarea
							className="textarea"
							onChange={(event) => patch({ translationPrompt: event.target.value })}
							placeholder={defaultTranslationPrompt}
							rows={4}
							value={draft.translationPrompt}
						/>
					</Field>
					<div className="inference-row model-reasoning-row">
						<Field hint={translationModelSet ? undefined : effectiveLoopModel} label="Model">
							<input
								className="input"
								list={modelSuggestions.length > 0 ? modelListId : undefined}
								onChange={(event) => patch({ translationModel: event.target.value })}
								placeholder={effectiveLoopModel}
								value={draft.translationModel}
							/>
							{modelSuggestions.length > 0 && (
								<datalist id={modelListId}>
									{modelSuggestions.map((model) => (
										<option key={model} value={model} />
									))}
								</datalist>
							)}
						</Field>
						<Field label="Reasoning">
							<select
								className="input reasoning-select"
								disabled={controlsDisabled}
								onChange={(event) => patch({ translationReasoningEffort: event.target.value })}
								value={draft.translationReasoningEffort}
							>
								{reasoningEffortOptions.map((option) => (
									<option disabled={option.value === "none" && !capabilityContext.supportsReasoningNone} key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</Field>
						<Field label="Tool calls">
							<select
								className="input reasoning-select"
								disabled={controlsDisabled}
								onChange={(event) => patch({ translationToolCalls: event.target.value })}
								value={draft.translationToolCalls}
							>
								{structuredToolCallOptions.map((option) => (
									<option disabled={option.value === "require" && !capabilityContext.supportsRequiredToolCalls} key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</Field>
					</div>
					<div className="inference-row four">
						<Field label="Temperature">
							<input
								className="input"
								disabled={controlsDisabled}
								max="2"
								min="0"
								onChange={(event) => patch({ translationTemperature: event.target.value })}
								placeholder="0"
								step="0.05"
								type="number"
								value={draft.translationTemperature}
							/>
						</Field>
						<Field label="Top K">
							<input
								className="input"
								disabled={controlsDisabled}
								min="0"
								onChange={(event) => patch({ translationTopK: event.target.value })}
								placeholder="default"
								step="1"
								type="number"
								value={draft.translationTopK}
							/>
						</Field>
						<Field label="Top P">
							<input
								className="input"
								disabled={controlsDisabled}
								max="1"
								min="0"
								onChange={(event) => patch({ translationTopP: event.target.value })}
								placeholder="default"
								step="0.01"
								type="number"
								value={draft.translationTopP}
							/>
						</Field>
						<Field label="Min P">
							<input
								className="input"
								disabled={controlsDisabled}
								max="1"
								min="0"
								onChange={(event) => patch({ translationMinP: event.target.value })}
								placeholder="default"
								step="0.01"
								type="number"
								value={draft.translationMinP}
							/>
						</Field>
					</div>
					<div className="inference-row three">
						<Field label="Frequency penalty">
							<input
								className="input"
								disabled={controlsDisabled}
								max="2"
								min="-2"
								onChange={(event) => patch({ translationFrequencyPenalty: event.target.value })}
								placeholder="default"
								step="0.05"
								type="number"
								value={draft.translationFrequencyPenalty}
							/>
						</Field>
						<Field label="Presence penalty">
							<input
								className="input"
								disabled={controlsDisabled}
								max="2"
								min="-2"
								onChange={(event) => patch({ translationPresencePenalty: event.target.value })}
								placeholder="default"
								step="0.05"
								type="number"
								value={draft.translationPresencePenalty}
							/>
						</Field>
						<Field label="Repetition penalty">
							<input
								className="input"
								disabled={controlsDisabled}
								max="2"
								min="0"
								onChange={(event) => patch({ translationRepetitionPenalty: event.target.value })}
								placeholder="default"
								step="0.05"
								type="number"
								value={draft.translationRepetitionPenalty}
							/>
						</Field>
					</div>
					<fieldset disabled={controlsDisabled}>
						<ProviderRoutingField
							onChange={(translationProviderRouting) => patch({ translationProviderRouting })}
							value={draft.translationProviderRouting}
						/>
					</fieldset>
				</>
			)}
		</div>
	);
}

const webSearchEngineOptions = ["auto", "native", "exa", "firecrawl", "parallel"];
const webFetchEngineOptions = ["auto", "native", "exa", "openrouter", "firecrawl"];
const searchContextSizeOptions = ["low", "medium", "high"];

export function OpenRouterServerToolFields({
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

export function LanguageField({
	disabled,
	hint,
	label,
	onChange,
	placeholder = "en",
	systemPromptControl,
	value,
}: {
	disabled?: boolean;
	hint?: string;
	label?: string;
	onChange: (value: string) => void;
	placeholder?: string;
	systemPromptControl?: LanguageSystemPromptControlProps;
	value: string;
}) {
	const inputId = useId();
	const listId = `${inputId}-languages`;
	const t = useUiText();
	return (
		<Field
			help={t.language.fieldHelp}
			hint={hint}
			label={label ?? t.language.fieldLabel}
			labelAction={systemPromptControl ? <LanguageSystemPromptControl {...systemPromptControl} /> : undefined}
		>
			<input
				className="input"
				disabled={disabled}
				dir="ltr"
				lang="en"
				list={listId}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				value={value}
			/>
			<datalist id={listId}>
				{languageExamples.map((language) => (
					<option key={language.value} label={language.label} value={language.value} />
				))}
			</datalist>
		</Field>
	);
}

type LanguageSystemPromptControlProps = {
	allowInherit: boolean;
	disabled?: boolean;
	inheritedValue?: boolean | null;
	onChange: (value: IncludeLanguageInSystemPromptDraft) => void;
	value: IncludeLanguageInSystemPromptDraft;
};

function LanguageSystemPromptControl({
	allowInherit,
	disabled,
	inheritedValue,
	onChange,
	value,
}: LanguageSystemPromptControlProps) {
	const checkboxRef = useRef<HTMLInputElement | null>(null);
	const normalizedValue = allowInherit ? value : value === "include" ? "include" : "exclude";
	const indeterminate = normalizedValue === "inherit";
	useEffect(() => {
		if (checkboxRef.current) {
			checkboxRef.current.indeterminate = indeterminate;
		}
	}, [indeterminate]);
	const inheritedText =
		inheritedValue === true ? "inherits checked"
		: inheritedValue === false ? "inherits unchecked"
		: "inherits source";
	const title = indeterminate ? `Add to system prompt (${inheritedText})` : "Add to system prompt";
	return (
		<label className="language-system-prompt-control" title={title}>
			<input
				aria-checked={indeterminate ? "mixed" : normalizedValue === "include"}
				checked={normalizedValue === "include"}
				className="cb"
				disabled={disabled}
				onChange={() => {
					if (!disabled) {
						onChange(nextIncludeLanguageInSystemPromptDraft(normalizedValue, allowInherit));
					}
				}}
				ref={checkboxRef}
				type="checkbox"
			/>
			<span>Add to system prompt</span>
		</label>
	);
}

function nextIncludeLanguageInSystemPromptDraft(
	value: IncludeLanguageInSystemPromptDraft,
	allowInherit: boolean,
): IncludeLanguageInSystemPromptDraft {
	if (!allowInherit) {
		return value === "include" ? "exclude" : "include";
	}
	if (value === "inherit") {
		return "include";
	}
	return value === "include" ? "exclude" : "inherit";
}


function isStandaloneDisplayMode(): boolean {
	const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
	return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

function parseBrowserRoute(): ParsedRoute {
	return parsePathname(window.location.pathname, window.location.search);
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

function readThemePreference(): ThemePreference {
	const value = window.localStorage.getItem("bickr.theme");
	return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function readStoredFontScalePercent(): FontScalePercent {
	try {
		return readFontScalePercent(window.localStorage);
	} catch {
		return defaultFontScalePercent;
	}
}

function writeStoredFontScalePercent(value: FontScalePercent): void {
	try {
		writeFontScalePercent(window.localStorage, value);
	} catch {
		// Browser storage can be unavailable; the scale still applies for this render.
	}
}


function readMyBotsSortState(): MyBotsSortState {
	try {
		return parseMyBotsSortState(window.localStorage.getItem(myBotsSortStorageKey));
	} catch {
		return defaultMyBotsSortState;
	}
}

function writeMyBotsSortState(sort: MyBotsSortState): void {
	try {
		window.localStorage.setItem(myBotsSortStorageKey, JSON.stringify(sort));
	} catch {
		// Browser storage can be unavailable; the table still sorts for the current render.
	}
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

export function TimeAgoLabel({ className, suffix = false, value }: { className?: string; suffix?: boolean; value: string }) {
	return (
		<span className={className} title={timestampTitle(value)}>
			{suffix ? timeAgoWithAgo(value) : timeAgo(value)}
		</span>
	);
}

export function TimeUntilLabel({ value }: { value: string | null | undefined }) {
	return <span title={timestampTitle(value)}>{timeUntil(value)}</span>;
}

export function ShortDateLabel({ value }: { value: string }) {
	return <span title={timestampTitle(value)}>{formatShortDate(value)}</span>;
}

export function NextDueAtLabel({
	enabled,
	loaded,
	value,
}: {
	enabled: boolean;
	loaded: boolean;
	value: string | null | undefined;
}) {
	return <span title={enabled && loaded ? timestampTitle(value) : undefined}>{formatNextDueAt(value, enabled, loaded)}</span>;
}

export function parsePositiveInteger(value: string): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

export function parseOptionalPositiveInteger(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

export function visibleForums(forums: ForumSummary[]): ForumSummary[] {
	return forums.filter((forum) => !forum.personalBotId);
}

function hasOwn<T>(record: Record<string, T>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function findKnownBot(
	botId: string,
	ownedBots: BotSummary[],
	botsByWorld: Record<string, BotSummary[]>,
): BotSummary | null {
	return ownedBots.find((bot) => bot.id === botId) ??
		Object.values(botsByWorld).flat().find((bot) => bot.id === botId) ??
		null;
}

function sortBotsForCascadeDelete(bots: BotSummary[]): BotSummary[] {
	const byId = new Map(bots.map((bot) => [bot.id, bot]));
	const depthCache = new Map<string, number>();
	function depth(bot: BotSummary, visiting = new Set<string>()): number {
		const cached = depthCache.get(bot.id);
		if (cached !== undefined) {
			return cached;
		}
		if (visiting.has(bot.id)) {
			return 0;
		}
		visiting.add(bot.id);
		const source = bot.cloneSource?.linked ? byId.get(bot.cloneSource.sourceBotId) : undefined;
		const value = source ? depth(source, visiting) + 1 : 0;
		visiting.delete(bot.id);
		depthCache.set(bot.id, value);
		return value;
	}
	return [...bots].sort((left, right) => depth(right) - depth(left));
}

function renameThreadSummaries(
	current: Record<string, ThreadSummary[]>,
	rename: {
		worldHandle?: string;
		nextWorldHandle?: string;
		forumId?: string;
		forumHandle?: string;
		nextForumHandle?: string;
	},
): Record<string, ThreadSummary[]> {
	return Object.fromEntries(
		Object.entries(current).map(([forumId, threads]) => [
			forumId,
			threads.map((thread) => ({
				...thread,
				...(rename.worldHandle && thread.worldHandle === rename.worldHandle ?
					{ worldHandle: rename.nextWorldHandle ?? thread.worldHandle }
				:	{}),
				...(rename.forumId && thread.forumId === rename.forumId && thread.forumHandle === rename.forumHandle ?
					{ forumHandle: rename.nextForumHandle ?? thread.forumHandle }
				:	{}),
			})),
		]),
	);
}

function renameThreadDocuments(
	current: Record<string, ThreadDocument>,
	rename: {
		worldHandle?: string;
		nextWorldHandle?: string;
		forumId?: string;
		forumHandle?: string;
		nextForumHandle?: string;
	},
): Record<string, ThreadDocument> {
	return Object.fromEntries(
		Object.entries(current).map(([threadId, thread]) => [
			threadId,
			{
				...thread,
				...(rename.worldHandle && thread.worldHandle === rename.worldHandle ?
					{ worldHandle: rename.nextWorldHandle ?? thread.worldHandle }
				:	{}),
				...(rename.forumId && thread.forumId === rename.forumId && thread.forumHandle === rename.forumHandle ?
					{ forumHandle: rename.nextForumHandle ?? thread.forumHandle }
				:	{}),
			},
		]),
	);
}

function updateThreadSummaryAuthorAvatar(
	current: Record<string, ThreadSummary[]>,
	botId: string,
	avatarUrl: string,
	avatarCrop: AvatarCrop | undefined,
): Record<string, ThreadSummary[]> {
	return Object.fromEntries(
		Object.entries(current).map(([forumId, threads]) => [
			forumId,
			threads.map((thread) => thread.authorBotId === botId ? botAuthoredThreadWithAvatar(thread, avatarUrl, avatarCrop) : thread),
		]),
	);
}

function updateThreadDocumentAuthorAvatar(
	current: Record<string, ThreadDocument>,
	botId: string,
	avatarUrl: string,
	avatarCrop: AvatarCrop | undefined,
): Record<string, ThreadDocument> {
	return Object.fromEntries(
		Object.entries(current).map(([threadId, thread]) => [
			threadId,
			{
				...thread,
				comments: thread.comments.map((comment) =>
					comment.authorBotId === botId ? botAuthoredCommentWithAvatar(comment, avatarUrl, avatarCrop) : comment,
				),
			},
		]),
	);
}

function botAuthoredThreadWithAvatar(thread: ThreadSummary, avatarUrl: string, avatarCrop: AvatarCrop | undefined): ThreadSummary {
	const next = { ...thread, authorAvatarUrl: avatarUrl };
	if (avatarCrop) {
		return { ...next, authorAvatarCrop: avatarCrop };
	}
	delete next.authorAvatarCrop;
	return next;
}

function botAuthoredCommentWithAvatar(comment: CommentDocument, avatarUrl: string, avatarCrop: AvatarCrop | undefined): CommentDocument {
	const next = { ...comment, authorAvatarUrl: avatarUrl };
	if (avatarCrop) {
		return { ...next, authorAvatarCrop: avatarCrop };
	}
	delete next.authorAvatarCrop;
	return next;
}

function routeWithRenamedWorld(current: ParsedRoute, nextWorldHandle: string): ParsedRoute {
	switch (current.route) {
		case "world":
			return { route: "world", worldHandle: nextWorldHandle, worldTab: current.worldTab };
		case "world-edit":
			return { route: "world-edit", worldHandle: nextWorldHandle };
		case "world-avatar":
			return { route: "world-avatar", worldHandle: nextWorldHandle };
		case "forum":
			return { route: "forum", worldHandle: nextWorldHandle, forumHandle: current.forumHandle };
		case "thread":
			return {
				route: "thread",
				worldHandle: nextWorldHandle,
				forumHandle: current.forumHandle,
				threadId: current.threadId,
				commentId: current.commentId,
			};
		case "bot-profile":
			return {
				route: "bot-profile",
				worldHandle: nextWorldHandle,
				botHandle: current.botHandle,
				botProfileTab: current.botProfileTab,
				botActivityId: current.botActivityId,
			};
		case "bot-avatar":
			return { route: "bot-avatar", worldHandle: nextWorldHandle, botHandle: current.botHandle };
		case "bot-loop":
			return { route: "bot-loop", worldHandle: nextWorldHandle, botHandle: current.botHandle };
		case "bot-edit":
			return { route: "bot-edit", worldHandle: nextWorldHandle, botHandle: current.botHandle };
		default:
			return { route: "world", worldHandle: nextWorldHandle };
	}
}

function adjustWorldCounts(
	worlds: WorldListSummary[],
	worldHandle: string,
	delta: Partial<Pick<WorldListSummary, "botCount" | "forumCount">>,
): WorldListSummary[] {
	return worlds.map((world) =>
		world.handle === worldHandle ?
			{
				...world,
				botCount: Math.max(0, world.botCount + (delta.botCount ?? 0)),
				forumCount: Math.max(0, world.forumCount + (delta.forumCount ?? 0)),
			}
		:	world,
	);
}

function compareHandles(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: "base" });
}

export function sortByHandle<T extends { handle: string }>(items: T[]): T[] {
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

export function sortBotsForCards<T extends BotSummary>(items: T[]): T[] {
	return [...items].sort(compareBotCardOrder);
}

function botGroupWithBots(group: BotGroupSummary, bots: BotSummary[]): BotGroupSummary {
	const displayTitle =
		textValue(group.customTitle) || (bots.length > 0 ? bots.map((bot) => `u/${bot.handle}`).join(", ") : "Empty group");
	return {
		...group,
		bots,
		displayTitle,
		titleSource: group.customTitle ? "custom" : "members",
	};
}

function timestampSortValue(value: string | null | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFilterText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

export function matchesFilter(query: string, ...values: Array<TextLike | null | undefined>): boolean {
	const normalizedQuery = normalizeFilterText(query.trim());
	if (!normalizedQuery) {
		return true;
	}
	return values.some((value) => value !== undefined && value !== null && normalizeFilterText(typeof value === "string" ? value : localizedTextString(value)).includes(normalizedQuery));
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

function humanNotificationSummaryWithReadScope(
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

function humanNotificationSummaryWithoutNotification(
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

function publicUserFromProfile(profile: UserProfile): PublicUser {
	return {
		id: profile.id,
		handle: profile.handle,
		language: profile.language,
		...(profile.uiLocale ? { uiLocale: profile.uiLocale } : {}),
		displayName: profile.displayName,
		...(profile.avatar ? { avatar: profile.avatar } : {}),
		...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
		...(profile.avatarCrop ? { avatarCrop: profile.avatarCrop } : {}),
		profileComplete: profile.profileComplete,
		...(profile.profileCompletedAt ? { profileCompletedAt: profile.profileCompletedAt } : {}),
	};
}

function profileDraftFromUser(user: PublicUser): ProfileDraft {
	return {
		handle: user.handle,
		language: languageDraftValue(user.language, textLang(user.displayName) ?? defaultLanguageTag),
		uiLocale: user.uiLocale ?? "system",
		displayName: textValue(user.displayName),
		inference: inferenceDraftFromSettings({}),
	};
}

function profileDraftFromProfile(profile: UserProfile): ProfileDraft {
	return {
		handle: profile.handle,
		language: languageDraftValue(profile.language, textLang(profile.displayName) ?? defaultLanguageTag),
		uiLocale: profile.uiLocale ?? "system",
		displayName: textValue(profile.displayName),
		inference: inferenceDraftFromSettings(profile.inferenceSettings),
	};
}

function profileDraftChanged(draft: ProfileDraft, profile: UserProfile): boolean {
	const language = languageInputValue(draft.language);
	const uiLocale = draft.uiLocale === "system" ? "system" : languageInputValue(draft.uiLocale) ?? defaultLanguageTag;
	return (
		draft.handle !== profile.handle ||
		language !== profile.language ||
		uiLocale !== (profile.uiLocale ?? "system") ||
		draft.displayName !== textValue(profile.displayName) ||
		inferenceDraftChanged(draft.inference, profile.inferenceSettings, { includeImageGeneration: true, includeTranslation: true })
	);
}

export function authorLabel(displayName: TextLike | undefined, handle: string): string {
	const cleanName = displayName ? (typeof displayName === "string" ? displayName : localizedTextString(displayName)).trim() : "";
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
