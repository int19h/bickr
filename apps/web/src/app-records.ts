import { worldAvatarMembersPromptUserContent } from "@bickr/shared/avatar-prompts";
import {
	defaultProviderModel,
	defaultTranslationPrompt,
	localizedTextString,
} from "@bickr/shared/model";
import type {
	AvatarCrop,
	BotGroupSummary,
	BotSummary,
	CommentDocument,
	ForumSummary,
	PublicUser,
	ThreadDocument,
	ThreadSummary,
	UserProfile,
	WorldListSummary,
	WorldSummary,
} from "@bickr/shared/model";
import type { ParsedRoute } from "./routes";
import { formatExactTokenCount } from "./screens/bots/token-usage";
import { textValue } from "./ui";

export function throwApiError(message: string): never {
	throw new Error(message);
}

/**
 * Translation view state for the whole app.
 *
 * The identity is the cache key input. It is the Translation role plus
 * the effective revision fingerprint the server computed, so a change to any
 * inherited routing, reasoning, or sampling value invalidates cached
 * translations even when the model and prompt are unchanged.
 */
export function translationContextValue(profile: UserProfile | null): {
	enabled: boolean;
	identity: string;
	model: string;
	prompt: string;
} {
	const translation = profile?.inferenceSettings.translation;
	const annotation = profile?.translationInference;
	return {
		enabled: annotation ? annotation.enabled : Boolean(translation?.enabled),
		identity: annotation?.enabled
			? `${annotation.migrationPending ? `migration:${annotation.sourceConfigurationId}` : annotation.configurationId}:${annotation.effectiveRevisionFingerprint}`
			: defaultProviderModel,
		model: annotation?.enabled ? annotation.effectiveModel : defaultProviderModel,
		prompt: localizedTextString(translation?.prompt).trim() || defaultTranslationPrompt,
	};
}

/**
 * Entity mutation responses intentionally contain only their owned profile
 * fields. Keep the independently resolved Translation annotation when such a
 * response omits it, while allowing an explicit canonical enabled/disabled
 * annotation to replace the saved value.
 */
export function profileWithPreservedTranslationInference(
	current: UserProfile | null,
	saved: UserProfile,
): UserProfile {
	if (saved.translationInference !== undefined || current?.translationInference === undefined) {
		return saved;
	}
	return { ...saved, translationInference: current.translationInference };
}

export function worldAvatarMembersPromptSizeTitle(world: WorldSummary, members: BotSummary[] | null): string {
	if (!members) {
		return "Member bios are still loading; prompt size will appear here once they are available.";
	}
	const source = worldAvatarMembersPromptUserContent(world, members);
	const characters = Array.from(source).length;
	const approximateTokens = Math.ceil(characters / 4);
	return `Will send ${formatExactTokenCount(characters)} characters, about ${formatExactTokenCount(approximateTokens)} tokens, from ${members.length} member bio${members.length === 1 ? "" : "s"}.`;
}

export function visibleForums(forums: ForumSummary[]): ForumSummary[] {
	return forums.filter((forum) => !forum.personalBotId);
}

export function hasOwn<T>(record: Record<string, T>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

export function findKnownBot(
	botId: string,
	ownedBots: BotSummary[],
	botsByWorld: Record<string, BotSummary[]>,
): BotSummary | null {
	return ownedBots.find((bot) => bot.id === botId) ??
		Object.values(botsByWorld).flat().find((bot) => bot.id === botId) ??
		null;
}

export function sortBotsForCascadeDelete(bots: BotSummary[]): BotSummary[] {
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

export function renameThreadSummaries(
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

export function renameThreadDocuments(
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

export function updateThreadSummaryAuthorAvatar(
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

export function updateThreadDocumentAuthorAvatar(
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

export function botAuthoredThreadWithAvatar(thread: ThreadSummary, avatarUrl: string, avatarCrop: AvatarCrop | undefined): ThreadSummary {
	const next = { ...thread, authorAvatarUrl: avatarUrl };
	if (avatarCrop) {
		return { ...next, authorAvatarCrop: avatarCrop };
	}
	delete next.authorAvatarCrop;
	return next;
}

export function botAuthoredCommentWithAvatar(comment: CommentDocument, avatarUrl: string, avatarCrop: AvatarCrop | undefined): CommentDocument {
	const next = { ...comment, authorAvatarUrl: avatarUrl };
	if (avatarCrop) {
		return { ...next, authorAvatarCrop: avatarCrop };
	}
	delete next.authorAvatarCrop;
	return next;
}

export function routeWithRenamedWorld(current: ParsedRoute, nextWorldHandle: string): ParsedRoute {
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

export function adjustWorldCounts(
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

export function botGroupWithBots(group: BotGroupSummary, bots: BotSummary[]): BotGroupSummary {
	const displayTitle =
		textValue(group.customTitle) || (bots.length > 0 ? bots.map((bot) => `u/${bot.handle}`).join(", ") : "Empty group");
	return {
		...group,
		bots,
		displayTitle,
		titleSource: group.customTitle ? "custom" : "members",
	};
}

export function publicUserFromProfile(profile: UserProfile): PublicUser {
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
