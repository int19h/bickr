import type {
	BotPublicProfile,
	CommentDocument,
	HumanProfile,
	PublicUser,
	ThreadDocument,
} from "@bickr/shared/model";
import {
	RepositoryError,
	humanProfileByHandle,
	listWorlds,
	worldByHandle,
} from "@bickr/shared/repository";
import { botPublicProfileByHandle, forumByHandle, readThread } from "@bickr/shared/social";
import { parsePathname, routePath, type ParsedRoute } from "../src/routes";
import { currentUser, type AppEnv } from "./api/_auth";

export type PageMetadata = {
	title: string;
	description: string;
	canonicalPath: string;
	imageAlt?: string;
	imageUrl?: string;
	ogType: "article" | "website";
	robots?: "noindex,nofollow";
};

type PageMetadataCore = Omit<PageMetadata, "canonicalPath">;

type WorldMetadataRow = {
	id: string;
	handle: string;
	name: string;
	description: string;
	forumCount: number;
	botCount: number;
};

type ForumMetadataRow = {
	id: string;
	worldId: string;
	worldHandle: string;
	handle: string;
	description: string;
	personalBotId: string | null;
};

const defaultDescription = "Bickr is a parody social network of autonomous participants.";
const noIndex = "noindex,nofollow" as const;

export async function pageMetadataForRequest(env: AppEnv, request: Request): Promise<PageMetadata> {
	const url = new URL(request.url);
	const route = parsePathname(url.pathname, url.search);
	const canonicalPath = routePath(route);
	try {
		return {
			...(await pageMetadataForRoute(env, request, route)),
			canonicalPath,
		};
	} catch (error) {
		if (isRouteNotFound(error)) {
			return { ...notFoundMetadata("Page"), canonicalPath };
		}
		throw error;
	}
}

async function pageMetadataForRoute(env: AppEnv, request: Request, route: ParsedRoute): Promise<PageMetadataCore> {
	switch (route.route) {
		case "worlds":
			return worldsMetadata(env);
		case "world":
			return worldMetadata(env, route);
		case "forum":
			return forumMetadata(env, route);
		case "thread":
			return threadMetadata(env, route);
		case "thread-ref":
		case "comment-ref":
			return {
				title: pageTitle("Opening link"),
				description: "Opening a Bickr content link.",
				ogType: "website",
				robots: noIndex,
			};
		case "bot-profile":
			return botProfileMetadata(env, route);
		case "bot-avatar":
			return botToolMetadata(env, route, "avatar");
		case "bot-loop":
			return botToolMetadata(env, route, "loop");
		case "bot-edit":
			return botToolMetadata(env, route, "edit");
		case "my-bots":
			return privateUserMetadata(env, request, "bots", "Manage your Bickr participants.");
		case "notifications":
			return privateUserMetadata(env, request, "notifications", "Notifications from watched Bickr activity.");
		case "profile":
			return privateUserMetadata(env, request, "profile", "Profile and account settings.");
		case "human-profile":
			return humanMetadata(env, route);
		case "search":
			return searchMetadata(route);
	}
}

async function worldsMetadata(env: AppEnv): Promise<PageMetadataCore> {
	const worlds = await listWorlds(env.BICKR_D1);
	return {
		title: pageTitle("Worlds"),
		description:
			worlds.length === 1 ?
				"Browse 1 Bickr world, its forums, and its participants."
			:	`Browse ${worlds.length} Bickr worlds, their forums, and their participants.`,
		ogType: "website",
	};
}

async function worldMetadata(env: AppEnv, route: ParsedRoute): Promise<PageMetadataCore> {
	const world = await worldMetadataByHandle(env.BICKR_D1, requiredRoutePart(route.worldHandle, "World"));
	const tab = route.worldTab ?? "forums";
	const tabLabel = tab === "forums" ? "" : `: ${tab}`;
	return {
		title: pageTitle(`w/${world.handle}${tabLabel}`),
		description: worldTabDescription(world, tab),
		ogType: "website",
		...(tab === "notifications" ? { robots: noIndex } : {}),
	};
}

async function forumMetadata(env: AppEnv, route: ParsedRoute): Promise<PageMetadataCore> {
	const forum = await forumMetadataByHandle(
		env.BICKR_D1,
		requiredRoutePart(route.worldHandle, "World"),
		requiredRoutePart(route.forumHandle, "Forum"),
	);
	return {
		title: pageTitle(`f/${forum.handle} in w/${forum.worldHandle}`),
		description: descriptionText(forum.description, `Forum f/${forum.handle} in w/${forum.worldHandle}.`),
		ogType: "website",
	};
}

async function threadMetadata(env: AppEnv, route: ParsedRoute): Promise<PageMetadataCore> {
	const worldHandle = requiredRoutePart(route.worldHandle, "World");
	const forumHandle = requiredRoutePart(route.forumHandle, "Forum");
	const threadId = requiredRoutePart(route.threadId, "Thread");
	const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
	const thread = await readThread(env.BICKR_KV, threadId);
	if (thread.forumId !== forum.id) {
		return notFoundMetadata("Thread");
	}
	const rootComment = threadRootComment(thread);
	const targetComment = route.commentId ? thread.comments.find((comment) => comment.id === route.commentId) ?? null : null;
	if (route.commentId && !targetComment) {
		return notFoundMetadata("Comment");
	}
	const comment = targetComment ?? rootComment;
	const imageUrl = comment ? comment.authorAvatarUrl ?? await botAvatarUrl(env.BICKR_D1, comment.authorBotId) : undefined;
	return {
		title: pageTitle(targetComment ? `u/${targetComment.authorHandle} on ${thread.title}` : thread.title),
		description: descriptionText(comment?.body ?? "", `${thread.title} in f/${thread.forumHandle}.`),
		ogType: "article",
		...(imageUrl ? { imageUrl, imageAlt: `u/${comment?.authorHandle ?? "participant"} avatar` } : {}),
	};
}

async function botProfileMetadata(env: AppEnv, route: ParsedRoute): Promise<PageMetadataCore> {
	const bot = await botForRoute(env, route);
	const tab = route.botActivityId ? "activity" : route.botProfileTab ?? "activity";
	const tabLabel = tab === "activity" && !route.botActivityId ? "" : `: ${tab}`;
	return {
		title: pageTitle(`u/${bot.handle}${tabLabel}`),
		description: botProfileDescription(bot, tab, Boolean(route.botActivityId)),
		ogType: "website",
		...(bot.avatarUrl ? { imageUrl: bot.avatarUrl, imageAlt: `${bot.displayName} avatar` } : {}),
		...(tab === "notifications" ? { robots: noIndex } : {}),
	};
}

async function botToolMetadata(env: AppEnv, route: ParsedRoute, tool: "avatar" | "edit" | "loop"): Promise<PageMetadataCore> {
	const bot = await botForRoute(env, route);
	return {
		title: pageTitle(`u/${bot.handle}: ${tool}`),
		description: botToolDescription(bot, tool),
		ogType: "website",
		robots: noIndex,
		...(bot.avatarUrl ? { imageUrl: bot.avatarUrl, imageAlt: `${bot.displayName} avatar` } : {}),
	};
}

async function humanMetadata(env: AppEnv, route: ParsedRoute): Promise<PageMetadataCore> {
	const profile = await humanProfileByHandle(env.BICKR_KV, env.BICKR_D1, requiredRoutePart(route.humanHandle, "Profile"), null);
	return humanProfileMetadata(profile);
}

async function privateUserMetadata(
	env: AppEnv,
	request: Request,
	section: "bots" | "notifications" | "profile",
	fallbackDescription: string,
): Promise<PageMetadataCore> {
	const user = await currentUser(env, request);
	const titlePrefix = user ? `hu/${user.handle}: ${section}` : titleCase(section);
	return {
		title: pageTitle(titlePrefix),
		description: user ? privateUserDescription(user, section) : fallbackDescription,
		ogType: "website",
		robots: noIndex,
		...(user?.avatarUrl ? { imageUrl: user.avatarUrl, imageAlt: `${user.displayName} avatar` } : {}),
	};
}

function searchMetadata(route: ParsedRoute): PageMetadataCore {
	const query = route.search?.query.trim() ?? "";
	return {
		title: pageTitle(query ? `Search: ${query}` : "Search"),
		description: query ? `Search Bickr for "${query}".` : "Search Bickr worlds, forums, and participants.",
		ogType: "website",
		robots: noIndex,
	};
}

async function botForRoute(env: AppEnv, route: ParsedRoute): Promise<BotPublicProfile> {
	const world = await worldByHandle(env.BICKR_D1, requiredRoutePart(route.worldHandle, "World"));
	return botPublicProfileByHandle(env.BICKR_KV, env.BICKR_D1, world.id, requiredRoutePart(route.botHandle, "Profile"));
}

function humanProfileMetadata(profile: HumanProfile): PageMetadataCore {
	const totals = profile.totals;
	return {
		title: pageTitle(`hu/${profile.user.handle}`),
		description: `${profile.user.displayName} owns ${countLabel(totals.worlds, "world")}, ${countLabel(totals.forums, "forum")}, and ${countLabel(totals.bots, "participant")} on Bickr.`,
		ogType: "website",
		...(profile.user.avatarUrl ? { imageUrl: profile.user.avatarUrl, imageAlt: `${profile.user.displayName} avatar` } : {}),
	};
}

function botProfileDescription(bot: BotPublicProfile, tab: "activity" | "follows" | "notifications", targetedActivity: boolean): string {
	if (tab === "follows") {
		return `Follows and followers for u/${bot.handle} in w/${bot.homeWorldHandle}.`;
	}
	if (tab === "notifications") {
		return `Notifications related to u/${bot.handle} in w/${bot.homeWorldHandle}.`;
	}
	if (targetedActivity) {
		return `Activity by u/${bot.handle} in w/${bot.homeWorldHandle}. ${descriptionText(bot.shortBio, "")}`;
	}
	return descriptionText(bot.shortBio, `Profile for u/${bot.handle} in w/${bot.homeWorldHandle}.`);
}

function botToolDescription(bot: BotPublicProfile, tool: "avatar" | "edit" | "loop"): string {
	if (tool === "avatar") {
		return `Avatar generation for u/${bot.handle} in w/${bot.homeWorldHandle}.`;
	}
	if (tool === "edit") {
		return `Owner settings for u/${bot.handle} in w/${bot.homeWorldHandle}.`;
	}
	return `Loop transcript and controls for u/${bot.handle} in w/${bot.homeWorldHandle}.`;
}

function worldTabDescription(world: WorldMetadataRow, tab: string): string {
	if (tab === "bots") {
		return `${countLabel(world.botCount, "participant")} in w/${world.handle}. ${descriptionText(world.description, "")}`;
	}
	if (tab === "activity") {
		return `Recent public activity in w/${world.handle}. ${descriptionText(world.description, "")}`;
	}
	if (tab === "notifications") {
		return `Notifications from watched sources in w/${world.handle}.`;
	}
	if (tab === "lore") {
		return `Lore for w/${world.handle}.`;
	}
	return descriptionText(world.description, `${countLabel(world.forumCount, "forum")} in w/${world.handle}.`);
}

function privateUserDescription(user: Pick<PublicUser, "handle">, section: "bots" | "notifications" | "profile"): string {
	if (section === "bots") {
		return `Participants owned by hu/${user.handle}.`;
	}
	if (section === "notifications") {
		return `Notifications for hu/${user.handle}.`;
	}
	return `Profile and account settings for hu/${user.handle}.`;
}

async function worldMetadataByHandle(db: D1Database, handle: string): Promise<WorldMetadataRow> {
	const world = await db
		.prepare(
			`SELECT
				w.world_id AS id,
				w.handle,
				w.name,
				w.description,
				COALESCE(forum_counts.forumCount, 0) AS forumCount,
				COALESCE(bot_counts.botCount, 0) AS botCount
			 FROM worlds_index w
			 LEFT JOIN (
				SELECT world_id, COUNT(*) AS forumCount
				FROM forums_index
				WHERE deleted_at IS NULL AND personal_bot_id IS NULL
				GROUP BY world_id
			 ) forum_counts ON forum_counts.world_id = w.world_id
			 LEFT JOIN (
				SELECT home_world_id AS world_id, COUNT(*) AS botCount
				FROM bots_index
				WHERE deleted_at IS NULL
				GROUP BY home_world_id
			 ) bot_counts ON bot_counts.world_id = w.world_id
			 WHERE w.handle = ? AND w.deleted_at IS NULL`,
		)
		.bind(handle)
		.first<WorldMetadataRow>();
	if (!world) {
		throw new RepositoryError("not_found", "World not found.", 404);
	}
	return world;
}

async function forumMetadataByHandle(db: D1Database, worldHandle: string, forumHandle: string): Promise<ForumMetadataRow> {
	const forum = await db
		.prepare(
			`SELECT
				f.forum_id AS id,
				f.world_id AS worldId,
				f.world_handle AS worldHandle,
				f.handle,
				CASE
					WHEN f.personal_bot_id IS NOT NULL AND b.bot_id IS NOT NULL
						THEN 'Blog of ' || b.display_name || ' (u/' || b.handle || ')'
					ELSE f.description
				END AS description,
				f.personal_bot_id AS personalBotId
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
			 LEFT JOIN bots_index b ON b.bot_id = f.personal_bot_id AND b.deleted_at IS NULL
			 WHERE f.world_handle = ? AND f.handle = ? AND f.deleted_at IS NULL`,
		)
		.bind(worldHandle, forumHandle)
		.first<ForumMetadataRow>();
	if (!forum) {
		throw new RepositoryError("not_found", "Forum not found.", 404);
	}
	return forum;
}

async function botAvatarUrl(db: D1Database, botId: string): Promise<string | undefined> {
	const row = await db
		.prepare(`SELECT avatar_url AS avatarUrl FROM bots_index WHERE bot_id = ? AND deleted_at IS NULL`)
		.bind(botId)
		.first<{ avatarUrl: string | null }>();
	return row?.avatarUrl ?? undefined;
}

function threadRootComment(thread: ThreadDocument): CommentDocument | null {
	return thread.comments.find((comment) => comment.id === thread.rootCommentId) ??
		thread.comments.find((comment) => !comment.parentCommentId) ??
		null;
}

function requiredRoutePart(value: string | undefined, label: string): string {
	if (!value) {
		throw new RepositoryError("not_found", `${label} not found.`, 404);
	}
	return value;
}

function notFoundMetadata(label: string): PageMetadataCore {
	return {
		title: pageTitle(`${label} not found`),
		description: `${label} not found on Bickr.`,
		ogType: "website",
		robots: noIndex,
	};
}

function isRouteNotFound(error: unknown): boolean {
	return error instanceof RepositoryError && (error.code === "not_found" || error.code === "bad_request");
}

function pageTitle(prefix: string): string {
	return `${prefix} - Bickr`;
}

function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function titleCase(value: string): string {
	return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function descriptionText(value: string, fallback: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized || fallback || defaultDescription;
}
