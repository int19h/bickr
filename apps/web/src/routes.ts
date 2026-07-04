import type { SearchEntityType, SearchMode } from "@bickr/shared/model";

export type Route =
	| "worlds"
	| "world"
	| "world-avatar"
	| "world-edit"
	| "forum"
	| "thread"
	| "thread-ref"
	| "comment-ref"
	| "bot-profile"
	| "bot-avatar"
	| "bot-loop"
	| "bot-edit"
	| "my-bots"
	| "search"
	| "statistics-inference-costs"
	| "notifications"
	| "subscriptions"
	| "human-profile"
	| "profile"
	| "profile-avatar";

export type WorldTab = "forums" | "bots" | "groups" | "activity" | "notifications" | "lore";
export type BotProfileTab = "activity" | "follows" | "notifications";

export type SearchRouteState = {
	forum: string;
	mode: SearchMode;
	page: number;
	query: string;
	types: SearchEntityType[];
	username: string;
	world: string;
};

export type ParsedRoute = {
	route: Route;
	worldHandle?: string;
	forumHandle?: string;
	threadId?: string;
	commentId?: string;
	botHandle?: string;
	botProfileTab?: BotProfileTab;
	botActivityId?: string;
	humanHandle?: string;
	search?: SearchRouteState;
	worldTab?: WorldTab;
};

export type PublicRouteNormalization = {
	route: ParsedRoute;
	status?: string;
};

export const allSearchTypes = ["world", "forum", "bot"] as const satisfies readonly SearchEntityType[];

export const defaultSearchRouteState: SearchRouteState = {
	forum: "",
	mode: "substring",
	page: 1,
	query: "",
	types: [...allSearchTypes],
	username: "",
	world: "",
};

export function parsePathname(pathname: string, search = ""): ParsedRoute {
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
	if (parts[0] === "me" && parts[1] === "subscriptions") {
		return { route: "subscriptions" };
	}
	if (parts[0] === "me" && parts[1] === "profile") {
		if (parts[2] === "avatar") {
			return { route: "profile-avatar" };
		}
		return { route: "profile" };
	}
	if (parts[0] === "search") {
		return { route: "search", search: searchRouteStateFromSearch(search) };
	}
	if (parts[0] === "statistics" && parts[1] === "inference-costs") {
		return { route: "statistics-inference-costs" };
	}
	if (parts[0] === "hu" && parts[1]) {
		return { route: "human-profile", humanHandle: parts[1] };
	}
	if (parts[0] === "t" && parts[1]) {
		return { route: "thread-ref", threadId: parts[1] };
	}
	if (parts[0] === "c" && parts[1]) {
		return { route: "comment-ref", commentId: parts[1] };
	}
	if (parts[0] === "w" && parts[1]) {
		const worldHandle = parts[1];
		if (parts[2] === "edit") {
			return { route: "world-edit", worldHandle };
		}
		if (parts[2] === "avatar") {
			return { route: "world-avatar", worldHandle };
		}
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
			if (parts[4] === "avatar") {
				return { route: "bot-avatar", worldHandle, botHandle };
			}
			return { route: "bot-profile", worldHandle, botHandle, ...botProfileRouteSearch(search) };
		}
		return { route: "world", worldHandle, worldTab: worldTabFromSearch(search) };
	}
	return { route: "worlds" };
}

export function routePath(parsed: ParsedRoute): string {
	switch (parsed.route) {
		case "worlds":
			return "/";
		case "world": {
			const base = `/w/${encodeURIComponent(parsed.worldHandle ?? "")}`;
			return parsed.worldTab && parsed.worldTab !== "forums" ? `${base}?tab=${encodeURIComponent(parsed.worldTab)}` : base;
		}
		case "world-edit":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/edit`;
		case "world-avatar":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/avatar`;
		case "forum":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/f/${encodeURIComponent(parsed.forumHandle ?? "")}`;
		case "thread": {
			const base = `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/f/${encodeURIComponent(parsed.forumHandle ?? "")}/t/${encodeURIComponent(parsed.threadId ?? "")}`;
			return parsed.commentId ? `${base}/c/${encodeURIComponent(parsed.commentId)}` : base;
		}
		case "thread-ref":
			return `/t/${encodeURIComponent(parsed.threadId ?? "")}`;
		case "comment-ref":
			return `/c/${encodeURIComponent(parsed.commentId ?? "")}`;
		case "bot-profile":
			return botProfileRoutePath(parsed);
		case "bot-avatar":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/u/${encodeURIComponent(parsed.botHandle ?? "")}/avatar`;
		case "bot-loop":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/u/${encodeURIComponent(parsed.botHandle ?? "")}/loop`;
		case "bot-edit":
			return `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/u/${encodeURIComponent(parsed.botHandle ?? "")}/edit`;
		case "my-bots":
			return "/me/bots";
		case "search":
			return searchRoutePath(parsed.search);
		case "statistics-inference-costs":
			return "/statistics/inference-costs";
		case "notifications":
			return "/me/notifications";
		case "subscriptions":
			return "/me/subscriptions";
		case "human-profile":
			return `/hu/${encodeURIComponent(parsed.humanHandle ?? "")}`;
		case "profile":
			return "/me/profile";
		case "profile-avatar":
			return "/me/profile/avatar";
	}
}

export function normalizeLoggedOutRoute(parsed: ParsedRoute): PublicRouteNormalization {
	switch (parsed.route) {
		case "my-bots":
		case "notifications":
		case "subscriptions":
		case "statistics-inference-costs":
		case "profile":
		case "profile-avatar":
		case "human-profile":
			return {
				route: { route: "worlds" },
				status: "Sign in to access account pages.",
			};
		case "world-edit":
		case "world-avatar":
			return {
				route: { route: "world", worldHandle: parsed.worldHandle, worldTab: "forums" },
				status: "Sign in as the owner to manage this world.",
			};
		case "bot-avatar":
		case "bot-loop":
		case "bot-edit":
			return {
				route: {
					route: "bot-profile",
					worldHandle: parsed.worldHandle,
					botHandle: parsed.botHandle,
					botProfileTab: "activity",
				},
				status: "Sign in as the owner to manage this participant.",
			};
		case "world":
			if (parsed.worldTab === "groups" || parsed.worldTab === "notifications") {
				return {
					route: { ...parsed, worldTab: "forums" },
					status: "Sign in to use account-specific world sections.",
				};
			}
			return { route: parsed };
		case "bot-profile":
			if (parsed.botProfileTab === "notifications") {
				return {
					route: { ...parsed, botProfileTab: "activity", botActivityId: undefined },
					status: "Sign in to view account notifications.",
				};
			}
			return { route: parsed };
		case "search":
			if (parsed.search?.mode === "semantic") {
				return {
					route: { ...parsed, search: { ...parsed.search, mode: "substring", page: 1 } },
					status: "Sign in to use semantic search.",
				};
			}
			return { route: parsed };
		default:
			return { route: parsed };
	}
}

function botProfileRouteSearch(search: string): Pick<ParsedRoute, "botActivityId" | "botProfileTab"> {
	const params = new URLSearchParams(search);
	const tab = params.get("tab");
	const activity = params.get("activity")?.trim();
	const botProfileTab =
		tab === "follows" || tab === "notifications" ? tab : "activity";
	return {
		botProfileTab: activity ? "activity" : botProfileTab,
		...(activity ? { botActivityId: activity } : {}),
	};
}

function botProfileRoutePath(parsed: ParsedRoute): string {
	const base = `/w/${encodeURIComponent(parsed.worldHandle ?? "")}/u/${encodeURIComponent(parsed.botHandle ?? "")}`;
	const params = new URLSearchParams();
	if (parsed.botProfileTab && parsed.botProfileTab !== "activity") {
		params.set("tab", parsed.botProfileTab);
	} else if (parsed.botActivityId) {
		params.set("tab", "activity");
	}
	if (parsed.botActivityId) {
		params.set("activity", parsed.botActivityId);
	}
	const query = params.toString();
	return query ? `${base}?${query}` : base;
}

function searchRouteStateFromSearch(search: string): SearchRouteState {
	const params = new URLSearchParams(search);
	return {
		forum: params.get("forum") ?? "",
		mode: searchModeFromParam(params.get("mode")),
		page: positivePage(params.get("page")),
		query: params.get("q") ?? "",
		types: searchTypesFromParam(params.get("types")),
		username: params.get("username") ?? "",
		world: params.get("world") ?? "",
	};
}

function searchRoutePath(state: SearchRouteState | undefined): string {
	const params = new URLSearchParams();
	const next = state ?? defaultSearchRouteState;
	if (next.query.trim()) {
		params.set("q", next.query.trim());
	}
	if (next.mode !== "substring") {
		params.set("mode", next.mode);
	}
	if (!sameSearchTypes(next.types, allSearchTypes)) {
		params.set("types", next.types.join(","));
	}
	if (next.page > 1) {
		params.set("page", String(next.page));
	}
	if (next.world.trim()) {
		params.set("world", next.world.trim());
	}
	if (next.forum.trim()) {
		params.set("forum", next.forum.trim());
	}
	if (next.username.trim()) {
		params.set("username", next.username.trim());
	}
	const query = params.toString();
	return query ? `/search?${query}` : "/search";
}

function searchModeFromParam(value: string | null): SearchMode {
	return value === "fts" || value === "semantic" ? value : "substring";
}

function searchTypesFromParam(value: string | null): SearchEntityType[] {
	if (!value) {
		return [...allSearchTypes];
	}
	const next: SearchEntityType[] = [];
	for (const type of value.split(",").map((item) => item.trim())) {
		if ((allSearchTypes as readonly string[]).includes(type) && !next.includes(type as SearchEntityType)) {
			next.push(type as SearchEntityType);
		}
	}
	return next.length > 0 ? next : [...allSearchTypes];
}

function sameSearchTypes(left: readonly SearchEntityType[], right: readonly SearchEntityType[]): boolean {
	return left.length === right.length && left.every((type) => right.includes(type));
}

function positivePage(value: string | null): number {
	const parsed = Number(value ?? 1);
	return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
}

function worldTabFromSearch(search: string): WorldTab {
	const tab = new URLSearchParams(search).get("tab");
	return tab === "bots" || tab === "groups" || tab === "activity" || tab === "notifications" || tab === "lore" ? tab : "forums";
}
