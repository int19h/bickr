import type {
	BotSummary,
	ForumSummary,
	PublicUser,
	ThreadDocument,
} from "@bickr/shared/model";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { WorldView } from "./components/content";
import {
	defaultFontScalePercent,
	readFontScalePercent,
	writeFontScalePercent,
	type FontScalePercent,
} from "./font-scale";
import {
	parsePathname,
	routePath,
	type BotProfileTab,
	type ParsedRoute,
	type Route,
	type SearchRouteState,
	type WorldTab,
} from "./routes";
import type { ThemePreference } from "./screens/chrome";
import { textValue } from "./ui";

export function clientRouteTitle({
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
export function titleWithBickr(prefix: string): string {
	return `${prefix} - Bickr`;
}

export function shouldHandleSpaAnchorClick(
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

export function isStandaloneDisplayMode(): boolean {
	const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
	return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

export function parseBrowserRoute(): ParsedRoute {
	return parsePathname(window.location.pathname, window.location.search);
}

export function canonicalizeCurrentPath(parsed: ParsedRoute): void {
	const canonical = routePath(parsed);
	if (currentLocationPath() !== canonical) {
		window.history.replaceState(null, "", canonical);
	}
}

export function currentLocationPath(): string {
	return `${window.location.pathname}${window.location.search}`;
}

export function readThemePreference(): ThemePreference {
	const value = window.localStorage.getItem("bickr.theme");
	return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function readStoredFontScalePercent(): FontScalePercent {
	try {
		return readFontScalePercent(window.localStorage);
	} catch {
		return defaultFontScalePercent;
	}
}

export function writeStoredFontScalePercent(value: FontScalePercent): void {
	try {
		writeFontScalePercent(window.localStorage, value);
	} catch {
		// Browser storage can be unavailable; the scale still applies for this render.
	}
}
