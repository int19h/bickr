import { approximateTextTokens } from '@bickr/shared/text-token-estimate';
import { renderMarkdownToolResult } from './tool-result-markdown';
import { pruneReadView } from './read-view-budget';
import { facetFingerprint } from './result-context-scope';
import { providerToolArgs } from './tool-args';
import { readContextText, resultMessage, resultDescriptor, unknownOutcomeText, type ResultText } from './result-text';
import { orderedProviderDeliveryReasons, providerNotificationGroups } from './tool-results';
import type { BotText } from '../localization';
import type { ToolResultEnvelope, ToolResultReadContentItem } from '@bickr/shared/tool-results';
import type { BotProfileRelationshipSummary, LocalizedText } from '@bickr/shared/model';
import { parseCommentRef, parseThreadRef } from '@bickr/shared/ids';
import { ResultContextScope, type ResultFacetValue, type ResultFacet } from './result-context-scope';
import { resolveResultHandle, resultHandleKey, type CurrentResultHandle, type ResultEntityReference, type ResultHandleMap, type ResultContentIdentities } from './result-handles';

export const toolResultViewSchemaVersion = 1;
export type ResultRenderContext = Readonly<{ text: BotText; time: ResultTimeContext; handles: ResultHandleMap }>;
export type ResultTimeContext = Readonly<{ settings: Readonly<import('@bickr/shared/model').ParticipantTimeSettings>; createdAt: string }>;
export type ResultInstant = { instant: string; writtenAt: string };
type Facet = number;
type Author = { ref: ResultEntityReference; self: boolean; displayName?: Facet };
type ThreadView = {
	id: string; rootCommentId?: string; forum: ResultEntityReference; title?: Facet; author?: Author;
	commentCount?: number; lock?: { kind: 'comment_limit'; limit: number }; voteScore?: number; lastActivity?: ResultInstant;
};
export type CommentView = {
	id: string; threadId: string; parentCommentId?: string; author: Author; title?: string; body?: Facet;
	focused: boolean; ancestorOnly: boolean; replies: CommentView[] | number; createdAt: string;
};
type ProfileView = {
	ref: ResultEntityReference; displayName?: Facet; bio: Facet; isFollowedByMe: boolean; isFollowingMe: boolean; followers: number;
	myNoteIds?: string[]; totalMyNoteCount?: number; omittedMyNoteIdCount?: number;
};
type ViewBase = { schemaVersion: 1; writtenAt: string; facets: ResultFacetValue[]; omittedCount: number; contextProfiles?: ProfileView[] };
export type ForumListView = ViewBase & { kind: 'list_accessible_forums'; forums: { ref: ResultEntityReference; description: Facet; readOnly: boolean }[] };
export type ThreadListView = ViewBase & { kind: 'list_threads'; includeForum: boolean; threads: ThreadView[] };
export type ReadThreadView = ViewBase & { kind: 'read_thread'; operation: string; context: ResultText; pruning: { tokenBudget: number; omittedReplyCount: number; trimmedBodyCount: number } | null; thread: ThreadView; targetCommentId?: string; content: CommentView[] };
export type ReadCommentView = Omit<ReadThreadView, 'kind'> & { kind: 'read_comment_by_id' };
export type SearchThreadsView = ViewBase & { kind: 'search_threads'; posts: { threadId: string; commentId?: string; forum: ResultEntityReference; title?: Facet; snippet?: Facet; author: Author; when: ResultInstant }[] };
export type ProfilesView = ViewBase & { kind: 'profiles'; source: 'view' | 'search' | 'list'; profiles: ProfileView[]; page?: { mode: 'random'; limit: number; total: number } | { mode: 'window'; limit: number; total: number; offset: number; hasMore: boolean } };
export type ReadNoteView = ViewBase & { kind: 'read_note'; id: string; content: string; links: NoteLinkView[] };
export type WriteNoteView = ViewBase & { kind: 'write_note'; outcome: 'created' | 'replaced'; id: string; links: NoteLinkView[]; unknownReferences: string[] };
export type ListNotesView = ViewBase & { kind: 'list_notes'; ids: string[]; nextCursor: string | null; total: number; unknownFilters: string[] };
export type DeleteNoteView = ViewBase & { kind: 'delete_note'; outcome: { kind: 'deleted'; id: string } | { kind: 'reset'; id: string; content: string } };
export type CreateThreadView = ViewBase & { kind: 'create_thread'; forum: ResultEntityReference; thread: Pick<ThreadView, 'id' | 'rootCommentId' | 'title'> };
export type ReplyView = ViewBase & { kind: 'reply_to_comment'; commentId: string; parentCommentId?: string; threadId: string; threadTitle?: Facet };
export type VoteView = ViewBase & { kind: 'vote'; votes: { commentId: string; threadId: string; threadTitle?: Facet; value: -1 | 0 | 1 }[] };
export type FollowView = ViewBase & { kind: 'follow_profile'; profiles: { ref: ResultEntityReference; following: boolean; reason?: string }[] };
export type RandomIntegersView = ViewBase & { kind: 'draw_random_integers'; numbers: number[]; ranges: { min: number; max: number }[] };
export type LogOffView = ViewBase & { kind: 'log_off' };
type NoteLinkView = { ref: ResultEntityReference; deleted: boolean };
type NotificationThreadView = { id: string; forum?: ResultEntityReference; when?: ResultInstant; title?: Facet; author?: Author; body?: Facet };
type NotificationCommentView = { id: string; when?: ResultInstant; threadId: string; author?: Author; body?: Facet };
type NotificationHeader = { when: ResultInstant; actorName?: Facet; ids: string[]; type: string; deliveryReasons: string[] };
type NotificationView = LegacyNotificationView | NotificationHeader & (
	| { kind: 'unavailable' }
	| { kind: 'bootstrap'; message: { kind: 'authored'; text: string } | { kind: 'factory'; customMessage?: string; introForum?: ResultEntityReference } }
	| { kind: 'thread_post'; actor: ResultEntityReference; thread: NotificationThreadView }
	| { kind: 'reply'; actor: ResultEntityReference; thread: NotificationThreadView; comment: NotificationCommentView; replyTo: NotificationCommentView }
	| { kind: 'mention'; actor: ResultEntityReference; thread: NotificationThreadView; comment: NotificationCommentView }
	| { kind: 'comment_notice'; actor: ResultEntityReference; thread: NotificationThreadView; comment: NotificationCommentView }
	| { kind: 'coalesced_comment_notice'; actor: ResultEntityReference; comments: { when: ResultInstant; comment: NotificationCommentView; title?: Facet }[] }
	| { kind: 'vote'; actor: ResultEntityReference; commentId: string; threadId: string; value: -1 | 0 | 1 }
	| { kind: 'follow' | 'unfollow'; actor: ResultEntityReference }
	| { kind: 'follower_activity_digest'; actor: ResultEntityReference; olderActivityOmitted: boolean; titlesOmitted: boolean; activities: { kind: 'thread' | 'comment'; when: ResultInstant; threadId: string; title?: Facet; commentId?: string }[] }
);
export type NotificationsView = ViewBase & { kind: 'check_notifications'; events: NotificationView[] };
type ActivityCommentView = { id: string; author?: ResultEntityReference; bodyPreview?: string };
type ActivityView =
	| { kind: 'thread'; id: string; forum?: ResultEntityReference; title?: Facet; bodyPreview?: string; voteScore: number; commentCount: number; when: ResultInstant }
	| { kind: 'comment'; id: string; forum?: ResultEntityReference; bodyPreview?: string; replyTo?: ActivityCommentView; when: ResultInstant }
	| { kind: 'vote'; id: string; value: number; threadId?: string; forum?: ResultEntityReference; title?: string; reason?: string; targetComment?: ActivityCommentView; when: ResultInstant }
	| { kind: 'follow'; profile: ResultEntityReference; reason?: string; when: ResultInstant }
	| { kind: 'unfollow'; profile: ResultEntityReference; reason?: string; when: ResultInstant };
export type ActivityFeedView = ViewBase & { kind: 'view_activity'; profile: ResultEntityReference; activities: ActivityView[] };
export type FollowersView = ViewBase & { kind: 'query_followers'; profile: ResultEntityReference; direction: 'followers' | 'following'; total: number; participants: ResultEntityReference[] };
export type FailureView = ViewBase & { kind: 'failure'; existingForum?: ResultEntityReference; fields: Omit<import('../types').ToolFailurePayload, 'message' | 'guidance'>; message: ResultText; guidance?: ResultText };
export type SettlementView = ViewBase & { kind: 'settlement'; outcome: { kind: 'not_dispatched' | 'interrupted'; message: ResultText } | { kind: 'not_attempted' | 'completed_result_unavailable' | 'outcome_unknown' | 'result_unavailable'; message: ResultText } };
export type BatchOutcomeView = ViewBase & { kind: 'batch_outcome'; items: ({ targetRef?: ResultEntityReference } & (
	| { kind: 'recorded'; target: string; view: ToolResultView }
	| { kind: 'committed' | 'unknown' | 'not_attempted'; target: string; message: ResultText }
	| { kind: 'refused'; target: string; message: ResultText; guidance?: ResultText }
))[]; guidance: ResultText };

export type ToolResultView = NotificationsView | ActivityFeedView | FollowersView | FailureView | SettlementView | BatchOutcomeView | ForumListView | ThreadListView | ReadThreadView | ReadCommentView | SearchThreadsView | ProfilesView | ReadNoteView | WriteNoteView | ListNotesView | DeleteNoteView | CreateThreadView | ReplyView | VoteView | FollowView | RandomIntegersView | LogOffView;

export type ViewBuildContext = {
	text: BotText; selfId: string; scope: ResultContextScope; writtenAt: string;
	/** The legacy adapter can use this map to resolve an ID from a handle. */
	references: ReadonlyMap<string, string>;
	contentIdentities?: ResultContentIdentities;
 retainKnownBodyValues?: boolean;
	time: ResultTimeContext;
};
export class UnresolvedResultReferenceError extends Error {
	readonly entityKind: ResultEntityReference['kind'];
	readonly handle: string;
	constructor(entityKind: ResultEntityReference['kind'], handle: string) {
		super('The result reference has no entity ID.');
		this.entityKind = entityKind;
		this.handle = handle;
	}
}
function ref(kind: ResultEntityReference['kind'], entityId: string, handle: string): ResultEntityReference {
	if (!entityId) throw new UnresolvedResultReferenceError(kind, handle);
	return { kind, entityId, handle: handle.replace(/^[uf]\//u, '') };
}
function value(text: LocalizedText | string | undefined): string | undefined {
	const raw = typeof text === 'string' ? text : text?.text;
	return raw?.trim() || undefined;
}
function instant(timestamp: string, context: ViewBuildContext): ResultInstant { return { instant: timestamp, writtenAt: context.writtenAt }; }
export function resultViewBase(_text: BotText, writtenAt = new Date().toISOString()): ViewBase { return { schemaVersion: 1, writtenAt, facets: [], omittedCount: 0 }; }
function base(context: ViewBuildContext): ViewBase { return resultViewBase(context.text, context.writtenAt); }
async function facet(entityId: string, kind: ResultFacet, text: string, context: ViewBuildContext, facets: ResultFacetValue[]): Promise<Facet> {
	const entry = await context.scope.observe({ entityId, facet: kind }, text);
	const index = facets.length;
	// Read pruning keeps body values until it selects the visible content.
	// Known facets acquire their value by hydration after compaction.
	facets.push(entry.state === 'known' && context.retainKnownBodyValues && (kind === 'comment_body' || kind === 'thread_body') ? { ...entry, value: text } : entry);
	return index;
}
async function author(id: string, handle: string, displayName: LocalizedText | string | undefined, context: ViewBuildContext, facets: ResultFacetValue[]): Promise<Author> {
	const name = value(displayName);
	return { ref: ref('participant', id, handle), self: id === context.selfId,
		...(name ? { displayName: await facet(id, 'profile_display_name', name, context, facets) } : {}) };
}
async function thread(source: import('@bickr/shared/tool-results').ToolResultRead['thread'], context: ViewBuildContext, facets: ResultFacetValue[], includeAuthor = true): Promise<ThreadView> {
	const title = value(source.title);
	return { id: source.id, rootCommentId: source.rootCommentId, forum: ref('forum', source.forumId, source.forumHandle),
		...(title ? { title: await facet(source.id, 'thread_title', title, context, facets) } : {}),
		...(includeAuthor && (source.authorBotId || source.authorHandle) ? { author: await author(source.authorBotId ?? '', source.authorHandle ?? '', source.authorDisplayName, context, facets) } : {}),
		commentCount: source.commentCount, ...(source.lock ? { lock: { kind: source.lock.kind, limit: source.lock.limit } } : {}),
		voteScore: source.voteScore, ...(source.lastActivityAt ? { lastActivity: instant(source.lastActivityAt, context) } : {}) };
}
async function comment(source: ToolResultReadContentItem, context: ViewBuildContext, facets: ResultFacetValue[]): Promise<CommentView> {
	const body = value(source.body);
	const bodyFacet = body ? await facet(source.id, 'comment_body', body, context, facets) : undefined;
	return { id: source.id, threadId: source.threadId, ...(source.parentCommentId ? { parentCommentId: source.parentCommentId } : {}),
		author: await author(source.authorBotId, source.authorHandle, source.authorDisplayName, context, facets),
		...(value(source.title) ? { title: value(source.title) } : {}), ...(bodyFacet !== undefined ? { body: bodyFacet } : {}),
		focused: source.focused === true, ancestorOnly: source.ancestorOnly === true, createdAt: source.createdAt,
		replies: typeof source.replies === 'number' ? source.replies : await sequential(source.replies ?? [], item => comment(item, context, facets)) };
}
async function sequential<T, U>(items: readonly T[], build: (item: T) => Promise<U>): Promise<U[]> {
	const result: U[] = [];
	for (const item of items) result.push(await build(item));
	return result;
}

async function profile(source: BotProfileRelationshipSummary & { associatedNoteReaderBotId?: string; associatedNoteIds?: string[]; associatedNoteCount?: number }, context: ViewBuildContext, facets: ResultFacetValue[]): Promise<ProfileView> {
	const name = value(source.displayName);
	const ids = source.associatedNoteReaderBotId === context.selfId ? source.associatedNoteIds : undefined;
	return { ref: ref('participant', source.id, source.handle), ...(name ? { displayName: await facet(source.id, 'profile_display_name', name, context, facets) } : {}),
		bio: await facet(source.id, 'profile_bio', value(source.shortBio) ?? '', context, facets), isFollowedByMe: source.isFollowedByMe, isFollowingMe: source.isFollowingMe, followers: source.followers,
		...(ids ? { myNoteIds: ids.map(id => id), totalMyNoteCount: source.associatedNoteCount ?? ids.length } : {}) };
}

async function notificationThread(source: import('@bickr/shared/model').NotificationThreadRef | import('@bickr/shared/model').NotificationThreadPostRef, context: ViewBuildContext, facets: ResultFacetValue[]): Promise<NotificationThreadView> {
	const title = value(source.title);
	const body = 'text' in source ? value(source.text) : undefined;
	const forumId = context.contentIdentities?.forumsByThreadId.get(source.id);
	const forumHandle = forumId ? context.contentIdentities?.forumHandlesById.get(forumId) : undefined;
	const createdAt = context.contentIdentities?.threadCreatedAtById.get(source.id);
	return { id: source.id, ...(createdAt ? { when: instant(createdAt, context) } : {}), ...(forumId && forumHandle ? { forum: ref('forum', forumId, forumHandle) } : {}), ...(title ? { title: await facet(source.id, 'thread_title', title, context, facets) } : {}),
		...('author' in source ? { author: await author(source.author.id, source.author.username, source.author.displayName, context, facets) } : {}),
		...(body ? { body: await facet(source.id, 'thread_body', body, context, facets) } : {}) };
}
async function notificationComment(source: import('@bickr/shared/model').NotificationCommentRef | import('@bickr/shared/model').NotificationCommentPostRef, context: ViewBuildContext, facets: ResultFacetValue[]): Promise<NotificationCommentView> {
	const body = 'text' in source ? value(source.text) : undefined;
	const createdAt = context.contentIdentities?.commentCreatedAtById.get(source.id);
	return { id: source.id, threadId: source.threadId, ...(createdAt ? { when: instant(createdAt, context) } : {}),
		...('author' in source ? { author: await author(source.author.id, source.author.username, source.author.displayName, context, facets) } : {}),
		...(body ? { body: await facet(source.id, 'comment_body', body, context, facets) } : {}) };
}
type LegacyNotificationTargetView = { kind: 'profile'; ref: ResultEntityReference } | { kind: 'thread'; thread: NotificationThreadView } | { kind: 'comment'; comment: NotificationCommentView };
type LegacyNotificationView = NotificationHeader & { kind: 'legacy'; message?: string; actor?: ResultEntityReference; target?: LegacyNotificationTargetView; thread?: NotificationThreadView; comment?: NotificationCommentView; replyTo?: LegacyNotificationTargetView; vote?: { threadId?: string; commentId?: string; value?: number } };

/**
 * This adapter reads the old notification shape. After the notification census
 * and WI-F compaction, advance the view schema version and delete the adapter.
 */
async function legacyNotificationView(event: import('@bickr/shared/model').LegacyNotificationEvent, header: NotificationHeader, context: ViewBuildContext, facets: ResultFacetValue[]): Promise<LegacyNotificationView> {
	const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const string = (input: unknown): string | undefined => typeof input === 'string' ? input.trim() || undefined : typeof record(input).text === 'string' ? (record(input).text as string).trim() || undefined : typeof input === 'number' || typeof input === 'boolean' ? String(input) : undefined;
	const participant = (source: Record<string, unknown>): ResultEntityReference | undefined => {
		const handle = string(source.username);
		if (!handle) return undefined;
		return ref('participant', string(source.id) ?? context.references.get(handle.startsWith('u/') ? handle : `u/${handle}`) ?? '', handle);
	};
	const author = async (source: Record<string, unknown>): Promise<Author | undefined> => {
		const nested = record(source.author);
		const handle = string(source.authorHandle) ?? string(nested.username) ?? string(nested.handle);
		const id = string(source.authorBotId) ?? string(nested.id) ?? (handle ? context.references.get(handle.startsWith('u/') ? handle : `u/${handle}`) : undefined);
		if ((!handle && id !== context.selfId) || !id) return undefined;
		return { ref: ref('participant', id ?? '', handle ?? ''), self: id === context.selfId };
	};
	const thread = async (source: Record<string, unknown>): Promise<NotificationThreadView | undefined> => {
		const id = parseThreadRef(string(source.threadRef)) ?? string(source.threadId) ?? string(source.id);
		const title = string(source.title);
		if (!id && !title) return undefined;
		const body = string(source.text) ?? string(source.body) ?? string(record(source.rootPost).body);
		return { id: id ?? '', ...(title ? { title: await facet(id ?? '', 'thread_title', title, context, facets) } : {}), author: await author(source), ...(id && body ? { body: await facet(id, 'thread_body', body, context, facets) } : {}) };
	};
	const comment = async (source: Record<string, unknown>): Promise<NotificationCommentView | undefined> => {
		const id = parseCommentRef(string(source.commentRef)) ?? string(source.id) ?? string(source.commentId);
		const threadId = parseThreadRef(string(source.threadRef)) ?? string(source.threadId);
		if (!id && !threadId) return undefined;
		const body = string(source.text) ?? string(source.body);
		return { id: id ?? '', threadId: threadId ?? '', author: await author(source), ...(id && body ? { body: await facet(id, 'comment_body', body, context, facets) } : {}) };
	};
	const target = async (value: unknown): Promise<LegacyNotificationTargetView | undefined> => {
		const source = record(value);
		if (string(source.threadId) || string(source.threadRef) || string(source.parentCommentId)) { const item = await comment(source); return item ? { kind: 'comment', comment: item } : undefined; }
		if (string(source.title)) { const item = await thread(source); return item ? { kind: 'thread', thread: item } : undefined; }
		const profile = participant(source);
		return profile ? { kind: 'profile', ref: profile } : undefined;
	};
	const vote = record(event.vote);
	return { ...header, kind: 'legacy', message: event.type === 'bootstrap' ? string(event.message) : undefined,
		actor: participant(record(event.actor)), target: await target(event.target), thread: await thread(record(event.thread)), comment: await comment(record(event.comment)), replyTo: await target(event.replyTo),
		...(Object.keys(vote).length ? { vote: { threadId: parseThreadRef(string(vote.threadId ?? vote.threadRef)), commentId: parseCommentRef(string(vote.commentId ?? vote.commentRef)), value: typeof vote.value === 'number' && Number.isFinite(vote.value) ? vote.value : undefined } } : {}) };
}

async function notifications(events: import('@bickr/shared/model').StoredNotificationEvent[], context: ViewBuildContext, common: ViewBase): Promise<NotificationsView | null> {
	const result: NotificationView[] = [];
	for (const group of providerNotificationGroups(events)) {
		const event = group.event;
		const header: NotificationHeader = { when: instant(event.createdAt, context), ids: group.notificationIds.map(id => id), type: event.type, deliveryReasons: orderedProviderDeliveryReasons(group.deliveryReasons) };
		if ('actor' in event && event.kind !== 'legacy' && value(event.actor.displayName)) header.actorName = await facet(event.actor.id, 'profile_display_name', value(event.actor.displayName)!, context, common.facets);
		const actor = 'actor' in event && event.kind !== 'legacy' ? ref('participant', event.actor.id, event.actor.username) : undefined;
		const thread = () => notificationThread((event as Extract<typeof event, { thread: unknown }>).thread, context, common.facets);
		const comment = () => notificationComment((event as Extract<typeof event, { comment: unknown }>).comment, context, common.facets);
		switch (event.kind) {
			case 'bootstrap':
				if (event.bootstrapVersion === 2 && event.introForum && !context.references.has(event.introForum)) { result.push({ ...header, kind: 'unavailable' }); break; }
				result.push({ ...header, kind: 'bootstrap', message: event.bootstrapVersion === 1
				? { kind: 'authored', text: event.composedMessage.text }
				: { kind: 'factory', ...(event.customMessage ? { customMessage: event.customMessage.text } : {}), ...(event.introForum ? { introForum: ref('forum', context.references.get(event.introForum) ?? '', event.introForum) } : {}) } }); break;
			case 'thread_post': result.push({ ...header, kind: event.kind, actor: actor!, thread: await thread() }); break;
			case 'reply': result.push({ ...header, kind: event.kind, actor: actor!, thread: await thread(), comment: await comment(), replyTo: await notificationComment(event.replyTo, context, common.facets) }); break;
			case 'mention':
			case 'comment_notice': result.push({ ...header, kind: event.kind, actor: actor!, thread: await thread(), comment: await comment() }); break;
			case 'coalesced_comment_notice': result.push({ ...header, kind: event.kind, actor: actor!, comments: await sequential(event.notices, async notice => ({ when: instant(notice.createdAt, context), comment: await notificationComment(notice.comment, context, common.facets), ...(value(notice.thread.title) ? { title: await facet(notice.thread.id, 'thread_title', value(notice.thread.title)!, context, common.facets) } : {}) })) }); break;
			case 'vote': result.push({ ...header, kind: 'vote', actor: actor!, commentId: event.target.id, threadId: event.target.threadId, value: event.value }); break;
			case 'follow':
			case 'unfollow': result.push({ ...header, kind: event.kind, actor: actor! }); break;
			case 'follower_activity_digest': result.push({ ...header, kind: event.kind, actor: actor!, olderActivityOmitted: event.olderActivityOmitted, titlesOmitted: false, activities: await sequential(event.activities, async item => ({ kind: item.kind, when: instant(item.createdAt, context), threadId: item.thread.id, ...(value(item.thread.title) ? { title: await facet(item.thread.id, 'thread_title', value(item.thread.title)!, context, common.facets) } : {}), ...(item.kind === 'comment' ? { commentId: item.comment.id } : {}) })) }); break;
			// Legacy notifications are adapted at their existing storage boundary.
			case 'legacy': {
				try { result.push(await legacyNotificationView(event, header, context, common.facets)); }
				catch (error) { if (!(error instanceof UnresolvedResultReferenceError)) throw error; result.push({ ...header, kind: 'unavailable' }); }
				break;
			}
		}
	}
	return { ...common, kind: 'check_notifications', events: result };
}
function activityBodyPreview(source: LocalizedText | string | undefined): string | undefined {
	const text = value(source);
	return text && Array.from(text).length >= 240 && !text.endsWith('…') ? `${text.trimEnd()}…` : text;
}
function activityComment(source: import('@bickr/shared/model').BotActivityCommentContext | undefined, context: ViewBuildContext): ActivityCommentView | undefined {
	if (!source) return undefined;
	const username = `u/${source.authorHandle}`;
	return { id: source.commentId, ...(source.authorHandle ? { author: ref('participant', context.contentIdentities?.authorsByCommentId.get(source.commentId) ?? context.references.get(username) ?? '', source.authorHandle) } : {}), ...(activityBodyPreview(source.bodyPreview) ? { bodyPreview: activityBodyPreview(source.bodyPreview) } : {}) };
}
async function activityFeed(feed: import('@bickr/shared/model').BotActivityFeed, context: ViewBuildContext, common: ViewBase): Promise<ActivityFeedView> {
	const forum = (handle: string | undefined, threadId: string | undefined): ResultEntityReference | undefined => handle ? ref('forum', context.contentIdentities?.forumsByThreadId.get(threadId ?? '') ?? context.references.get(`f/${handle}`) ?? '', handle) : undefined;
	const activities: ActivityView[] = await sequential(feed.activities, async item => {
		switch (item.type) {
			case 'thread': return { kind: 'thread', id: item.threadId, forum: forum(item.forumHandle, item.threadId), ...(value(item.title) ? { title: await facet(item.threadId, 'thread_title', value(item.title)!, context, common.facets) } : {}), bodyPreview: activityBodyPreview(item.bodyPreview), voteScore: item.voteScore, commentCount: item.commentCount, when: instant(item.createdAt, context) };
			case 'comment': return { kind: 'comment', id: item.commentId, forum: forum(item.forumHandle, item.threadId), bodyPreview: activityBodyPreview(item.bodyPreview), replyTo: activityComment(item.parentComment, context), when: instant(item.createdAt, context) };
			case 'vote': return { kind: 'vote', id: item.commentId ?? item.targetId!, value: item.value, threadId: item.threadId, forum: forum(item.forumHandle, item.threadId), title: value(item.title), reason: value(item.reason), targetComment: activityComment(item.targetComment, context), when: instant(item.updatedAt, context) };
			case 'follow':
			case 'unfollow': return { kind: item.type, profile: ref('participant', item.bot.id, item.bot.handle), reason: value(item.reason), when: instant(item.createdAt, context) };
		}
	});
	return { ...common, kind: 'view_activity', profile: ref('participant', feed.bot.id, feed.bot.handle), activities };
}

/** Every source field is selected here. Internal entity records never become views. */
export async function buildToolResultView(envelope: ToolResultEnvelope, context: ViewBuildContext, tokenBudget?: number): Promise<ToolResultView | null> {
	const view = await buildUnprunedToolResultView(envelope, { ...context, scope: context.scope.clone(), retainKnownBodyValues: envelope.kind === 'posts_read' });
	if (view) {
		pruneToolResultView(view, resultViewBuildRenderContext(view, context), tokenBudget);
		if (view.kind === 'read_thread' || view.kind === 'read_comment_by_id') {
			const scope = context.scope.clone();
			for (let index = 0; index < view.facets.length; index += 1) {
				const item = view.facets[index]!;
				if ((item.facet === 'comment_body' || item.facet === 'thread_body') && item.value !== undefined) {
					const fingerprint = await facetFingerprint(item.value);
					view.facets[index] = scope.knows(item, fingerprint) ? { entityId: item.entityId, facet: item.facet, state: 'known', fingerprint } : { entityId: item.entityId, facet: item.facet, state: 'shown', fingerprint, value: item.value, ...(item.shortened ? { shortened: true } : {}) };
					scope.include([view.facets[index]!]);
				}
			}
		}
		context.scope.include(resultViewFacetArrays(view).flat());
	}
	return view;
}

async function buildUnprunedToolResultView(envelope: ToolResultEnvelope, context: ViewBuildContext): Promise<ToolResultView | null> {
	const common = base(context);
	const facets = common.facets;
	const links = (items: import('@bickr/shared/tool-results').NoteToolLink[]): NoteLinkView[] => items.map(link => ({ ref: ref(link.kind, link.entityId, link.handle), deleted: link.deleted }));
	switch (envelope.kind) {
		case 'notifications_checked': return notifications(envelope.events, context, common);
		case 'activity_viewed': return activityFeed(envelope.feed, context, common);
		case 'followers_queried': return { ...common, kind: 'query_followers', profile: ref('participant', envelope.result.profile.id, envelope.result.profile.handle), direction: envelope.result.direction, total: envelope.result.total, participants: envelope.result.participants.map(participant => ref('participant', participant.id, participant.handle)) };
		case 'forums_listed': return { ...common, kind: 'list_accessible_forums', forums: await sequential(envelope.forums, async forum => ({ ref: ref('forum', forum.id, forum.handle), description: await facet(forum.id, 'forum_description', value(forum.description) ?? '', context, facets), readOnly: forum.readOnly })) };
		case 'threads_listed': return { ...common, kind: 'list_threads', includeForum: envelope.order === 'hot', threads: await sequential(envelope.threads, item => thread(item, context, facets)) };
		case 'posts_read': return { ...common, kind: envelope.read.operation === 'read_comment_by_id' ? 'read_comment_by_id' : 'read_thread', operation: envelope.read.operation, pruning: envelope.read.contextDecision ? { tokenBudget: envelope.read.contextDecision.tokenBudget, omittedReplyCount: envelope.read.contextDecision.omittedReplyCount, trimmedBodyCount: envelope.read.contextDecision.trimmedBodyCount } : null, context: envelope.read.contextDecision ? readContextText(envelope.read.contextDecision) : { kind: 'literal', value: envelope.read.context }, thread: await thread(envelope.read.thread, context, facets, false), ...(envelope.read.targetCommentId ? { targetCommentId: envelope.read.targetCommentId } : {}), content: await sequential(envelope.read.content, item => comment(item, context, facets)) };
		case 'posts_searched': return { ...common, kind: 'search_threads', posts: await sequential(envelope.posts, async post => {
			const commentId = post.commentId ?? post.rootCommentId;
			const title = value(post.title), snippet = value(post.snippet);
			return { threadId: post.threadId, ...(commentId ? { commentId } : {}), forum: ref('forum', context.contentIdentities?.forumsByThreadId.get(post.threadId) ?? context.references.get(`f/${post.forumHandle}`) ?? '', post.forumHandle),
				...(title ? { title: await facet(post.threadId, 'thread_title', title, context, facets) } : {}),
				...(snippet ? { snippet: await facet(commentId ?? post.threadId, commentId ? 'comment_body' : 'thread_body', snippet, context, facets) } : {}),
				author: await author(post.authorBotId, post.authorHandle, post.authorDisplayName, context, facets), when: instant(post.createdAt, context) };
		}) };
		case 'profile_viewed': return { ...common, kind: 'profiles', source: 'view', profiles: await sequential(envelope.profiles, item => profile(item, context, facets)) };
		case 'profiles_searched': return { ...common, kind: 'profiles', source: 'search', profiles: await sequential(envelope.profiles, item => profile(item, context, facets)) };
		case 'profiles_listed': return { ...common, kind: 'profiles', source: 'list', profiles: await sequential(envelope.page.profiles, item => profile(item, context, facets)), page: envelope.page.mode === 'random'
			? { mode: 'random', limit: envelope.page.limit, total: envelope.page.total }
			: { mode: 'window', offset: envelope.page.offset, limit: envelope.page.limit, total: envelope.page.total, hasMore: envelope.page.hasMore } };
		case 'note_listed': return { ...common, kind: 'list_notes', ids: envelope.ids.map(id => id), nextCursor: envelope.nextCursor, total: envelope.total, unknownFilters: envelope.unknownFilters.map(filter => filter) };
		case 'note_read': return { ...common, kind: 'read_note', id: envelope.id, content: envelope.content, links: links(envelope.links) };
		case 'note_written': return { ...common, kind: 'write_note', outcome: envelope.outcome, id: envelope.id, links: links(envelope.links), unknownReferences: envelope.unknownReferences.map(reference => reference) };
		case 'note_deleted': return { ...common, kind: 'delete_note', outcome: { kind: 'deleted', id: envelope.id } };
		case 'note_reset': return { ...common, kind: 'delete_note', outcome: { kind: 'reset', id: envelope.id, content: envelope.content } };
		case 'thread_created': {
			const title = value(envelope.thread.title);
			return { ...common, kind: 'create_thread', forum: ref('forum', envelope.thread.forumId, envelope.thread.forumHandle), thread: { id: envelope.thread.id, rootCommentId: envelope.thread.rootCommentId, ...(title ? { title: await facet(envelope.thread.id, 'thread_title', title, context, facets) } : {}) } };
		}
		case 'comment_created': return { ...common, kind: 'reply_to_comment', commentId: envelope.comment.id, parentCommentId: envelope.comment.parentCommentId, threadId: envelope.comment.threadId, ...(value(envelope.thread.title) ? { threadTitle: await facet(envelope.thread.id, 'thread_title', value(envelope.thread.title)!, context, facets) } : {}) };
		case 'vote_set': return { ...common, kind: 'vote', votes: await sequential(envelope.votes, async vote => ({ commentId: vote.commentId, threadId: vote.thread.id, value: vote.value, ...(value(vote.thread.title) ? { threadTitle: await facet(vote.thread.id, 'thread_title', value(vote.thread.title)!, context, facets) } : {}) })) };
		case 'profile_followed':
		case 'profile_unfollowed': return { ...common, kind: 'follow_profile', profiles: envelope.profiles.map(action => ({ ref: ref('participant', action.profile.id, action.profile.handle), following: action.following, ...(value(action.reason) ? { reason: value(action.reason) } : {}) })) };
		case 'random_integers_drawn': return { ...common, kind: 'draw_random_integers', numbers: envelope.numbers.map(number => number), ranges: envelope.ranges.map(range => ({ min: range.min, max: range.max })) };
		case 'logged_off': return { ...common, kind: 'log_off' };
		default: return null;
	}
}

export function renderResultReference(reference: ResultEntityReference, handles: ResultHandleMap, deletedMark: string): string {
	const current = resolveResultHandle(reference, handles);
	return `${reference.kind === 'participant' ? 'u' : 'f'}/${current.handle}${current.deleted ? deletedMark : ''}`;
}

export function renderToolResultView(view: ToolResultView, context: ResultRenderContext): string {
	return renderMarkdownToolResult(view, context);
}

/** Each view kind declares the facet indexes that it can hold. */
function mapViewFacets(view: ToolResultView, map: (index: number) => number): void {
	for (const item of view.contextProfiles ?? []) { if (item.displayName !== undefined) item.displayName = map(item.displayName); item.bio = map(item.bio); }
	const author = (item: Author | undefined): void => { if (item?.displayName !== undefined) item.displayName = map(item.displayName); };
	const thread = (item: ThreadView): void => { if (item.title !== undefined) item.title = map(item.title); author(item.author); };
	const comment = (item: CommentView): void => { author(item.author); if (item.body !== undefined) item.body = map(item.body); if (Array.isArray(item.replies)) item.replies.forEach(comment); };
	const notificationThread = (item: NotificationThreadView): void => { if (item.title !== undefined) item.title = map(item.title); author(item.author); if (item.body !== undefined) item.body = map(item.body); };
	const notificationComment = (item: NotificationCommentView): void => { author(item.author); if (item.body !== undefined) item.body = map(item.body); };
	switch (view.kind) {
		case 'list_accessible_forums': view.forums.forEach(item => { item.description = map(item.description); }); break;
		case 'list_threads': view.threads.forEach(thread); break;
		case 'read_thread':
		case 'read_comment_by_id': thread(view.thread); view.content.forEach(comment); break;
		case 'reply_to_comment': if (view.threadTitle !== undefined) view.threadTitle = map(view.threadTitle); break;
		case 'vote': view.votes.forEach(vote => { if (vote.threadTitle !== undefined) vote.threadTitle = map(vote.threadTitle); }); break;
		case 'create_thread': if (view.thread.title !== undefined) view.thread.title = map(view.thread.title); break;
		case 'search_threads': view.posts.forEach(item => { author(item.author); if (item.title !== undefined) item.title = map(item.title); if (item.snippet !== undefined) item.snippet = map(item.snippet); }); break;
		case 'profiles': view.profiles.forEach(item => { if (item.displayName !== undefined) item.displayName = map(item.displayName); item.bio = map(item.bio); }); break;
		case 'view_activity': view.activities.forEach(item => { if (item.kind === 'thread' && item.title !== undefined) item.title = map(item.title); }); break;
		case 'check_notifications': view.events.forEach(item => {
			if (item.actorName !== undefined) item.actorName = map(item.actorName);
			switch (item.kind) {
				case 'thread_post': notificationThread(item.thread); break;
				case 'reply': notificationThread(item.thread); notificationComment(item.comment); notificationComment(item.replyTo); break;
				case 'mention':
				case 'comment_notice': notificationThread(item.thread); notificationComment(item.comment); break;
				case 'coalesced_comment_notice': item.comments.forEach(notice => { notificationComment(notice.comment); if (notice.title !== undefined) notice.title = map(notice.title); }); break;
				case 'follower_activity_digest': item.activities.forEach(activity => { if (activity.title !== undefined && !item.titlesOmitted) activity.title = map(activity.title); }); break;
				case 'legacy': {
					const target = (value: LegacyNotificationTargetView | undefined): void => { if (value?.kind === 'thread') notificationThread(value.thread); if (value?.kind === 'comment') notificationComment(value.comment); };
					if (item.thread) notificationThread(item.thread); if (item.comment) notificationComment(item.comment); target(item.target); target(item.replyTo); break;
				}
				case 'unavailable': case 'bootstrap': case 'vote': case 'follow': case 'unfollow': break;
			}
		}); break;
		case 'read_note': case 'write_note': case 'list_notes': case 'delete_note': case 'follow_profile': case 'draw_random_integers': case 'log_off': case 'query_followers': case 'failure': case 'settlement': case 'batch_outcome': break;
	}
}
/** Skipped profiles stay on the triggering view for later hydration. */
export async function retainKnownProfiles(view: ToolResultView, profiles: import('@bickr/shared/tool-results').ViewedProfileResult[], context: ViewBuildContext): Promise<void> {
	for (const source of profiles) {
		const item = await profile(source, { ...context, scope: context.scope.clone() }, view.facets);
		(view.contextProfiles ??= []).push(item);
	}
}

export function resultViewFacetArrays(view: ToolResultView): ResultFacetValue[][] {
	return [view.facets, ...(view.kind === 'batch_outcome' ? view.items.flatMap(item => item.kind === 'recorded' ? resultViewFacetArrays(item.view) : []) : [])];
}

function retainReferencedFacets(view: ToolResultView): void {
	const old = view.facets, next: ResultFacetValue[] = [], indexes = new Map<number, number>();
	mapViewFacets(view, index => {
		const existing = indexes.get(index);
		if (existing !== undefined) return existing;
		const nextIndex = next.length;
		const facet = old[index];
		if (!facet) throw new Error('A result view references an absent facet.');
		next.push(facet); indexes.set(index, nextIndex); return nextIndex;
	});
	view.facets = next;
}

/** Budget decisions happen once. Rendering never re-prunes stored history. */
export function pruneToolResultView(view: ToolResultView, context: ResultRenderContext, tokenBudget?: number): void {
	if ((view.kind === 'read_thread' || view.kind === 'read_comment_by_id') && view.pruning) {
		const estimate = (): number => {
			const allBodies = view.facets.map(item => item.facet === 'comment_body' || item.facet === 'thread_body' ? { ...item, state: 'shown' as const, value: item.value ?? '' } : item);
			return approximateTextTokens(renderToolResultView({ ...view, facets: allBodies }, context));
		};
		const outcome = pruneReadView(view, view.pruning.tokenBudget, estimate);
		view.pruning = { tokenBudget: view.pruning.tokenBudget, ...outcome };
		view.context = readContextText({ operation: view.operation, ...view.pruning });
		if (outcome.trimmedBodyCount === 0 && view.facets.some(item => item.facet === 'comment_body' && item.state === 'shown' && item.value.endsWith('…'))) {
			view.context = { kind: 'sequence', parts: [view.context, resultMessage('formatting.sentenceSeparator'), resultMessage('read.guidance.trimmed', { ellipsis: '…' })] };
		}
		view.omittedCount = outcome.omittedReplyCount;
		retainReferencedFacets(view);
		return;
	}
	if (tokenBudget === undefined) { retainReferencedFacets(view); return; }
	const budget = Math.max(1, Math.floor(tokenBudget));
	const estimate = (): number => {
		const budgetView = view.kind === 'profiles' && view.source === 'list' ? { ...view, source: 'view' as const, omittedCount: 0 } : view;
		return approximateTextTokens(renderToolResultView(budgetView, context));
	};
	if (view.kind === 'profiles' && view.source === 'view' && estimate() > budget) {
		const original = view.profiles.map(profile => profile.myNoteIds?.slice());
		const maxIds = Math.max(0, ...original.map(ids => ids?.length ?? 0));
		const limit = (count: number): void => { view.profiles.forEach((profile, index) => {
			const ids = original[index];
			if (!ids) return;
			profile.myNoteIds = ids.slice(0, count);
			profile.omittedMyNoteIdCount = ids.length - profile.myNoteIds.length;
		}); };
		limit(0);
		if (estimate() <= budget) {
			let low = 0, high = maxIds - 1, accepted = 0;
			while (low <= high) { const middle = Math.floor((low + high) / 2); limit(middle); if (estimate() <= budget) { accepted = middle; low = middle + 1; } else high = middle - 1; }
			limit(accepted);
		}
	}
	if (view.kind === 'view_activity' && estimate() > budget) {
		const candidates: { item: { bodyPreview?: string }; original: string; points: string[] }[] = [];
		const add = (item: { bodyPreview?: string } | undefined): void => { if (item?.bodyPreview && Array.from(item.bodyPreview).length > 1) candidates.push({ item, original: item.bodyPreview, points: Array.from(item.bodyPreview) }); };
		for (const item of view.activities) {
			if (item.kind === 'thread' || item.kind === 'comment') add(item);
			if (item.kind === 'comment') add(item.replyTo);
			if (item.kind === 'vote') add(item.targetComment);
		}
		if (candidates.length > 0) {
			const apply = (cutoff: number): void => { for (const candidate of candidates) candidate.item.bodyPreview = candidate.points.length > cutoff ? `${candidate.points.slice(0, cutoff).join('').trimEnd()}…` : candidate.original; };
			let low = 0, high = Math.max(0, Math.max(...candidates.map(candidate => candidate.points.length)) - 2), accepted = 0;
			while (low <= high) { const middle = Math.floor((low + high) / 2); apply(middle); if (estimate() <= budget) { accepted = middle; low = middle + 1; } else high = middle - 1; }
			apply(accepted);
		}
	}
	while (estimate() > budget) {
		let dropped = false;
		switch (view.kind) {
			case 'list_accessible_forums': dropped = view.forums.pop() !== undefined; break;
			case 'list_threads': dropped = view.threads.pop() !== undefined; break;
			case 'search_threads': dropped = view.posts.pop() !== undefined; break;
			case 'profiles': dropped = view.profiles.pop() !== undefined; break;
			case 'view_activity': dropped = view.activities.pop() !== undefined; break;
			case 'check_notifications': {
				const last = view.events.at(-1);
				if (last?.kind === 'follower_activity_digest' && last.activities.length > 1) { last.activities.pop(); last.olderActivityOmitted = true; continue; }
				if (last?.kind === 'follower_activity_digest' && !last.titlesOmitted) { last.titlesOmitted = true; last.activities.forEach(activity => { delete activity.title; }); continue; }
				const event = view.events.pop();
				if (event) { view.omittedCount += Math.max(1, event.ids.length); dropped = true; }
				break;
			}
			default: break;
		}
		if (!dropped) break;
		if (view.kind !== 'check_notifications') view.omittedCount += 1;
	}
	retainReferencedFacets(view);
}

export function resultViewReferences(view: ToolResultView): ResultEntityReference[] {
	const refs: ResultEntityReference[] = (view.contextProfiles ?? []).map(item => item.ref);
	const author = (item?: Author): void => { if (item) refs.push(item.ref); };
	const thread = (item: ThreadView): void => { refs.push(item.forum); author(item.author); };
	const comment = (item: CommentView): void => { author(item.author); if (Array.isArray(item.replies)) item.replies.forEach(comment); };
	const notificationThread = (item: NotificationThreadView): void => { if (item.forum) refs.push(item.forum); author(item.author); };
	const notificationComment = (item: NotificationCommentView): void => { author(item.author); };
	switch (view.kind) {
		case 'list_accessible_forums': refs.push(...view.forums.map(item => item.ref)); break;
		case 'list_threads': view.threads.forEach(thread); break;
		case 'read_thread': case 'read_comment_by_id': thread(view.thread); view.content.forEach(comment); break;
		case 'search_threads': view.posts.forEach(item => { refs.push(item.forum); author(item.author); }); break;
		case 'profiles': refs.push(...view.profiles.map(item => item.ref)); break;
		case 'failure': if (view.existingForum) refs.push(view.existingForum); break;
		case 'read_note': case 'write_note': refs.push(...view.links.map(link => link.ref)); break;
		case 'follow_profile': refs.push(...view.profiles.map(item => item.ref)); break;
		case 'query_followers': refs.push(view.profile, ...view.participants); break;
		case 'view_activity':
			refs.push(view.profile);
			for (const item of view.activities) {
				if (item.kind === 'follow' || item.kind === 'unfollow') refs.push(item.profile);
				else {
					if (item.forum) refs.push(item.forum);
					if (item.kind === 'comment' && item.replyTo?.author) refs.push(item.replyTo.author);
					if (item.kind === 'vote' && item.targetComment?.author) refs.push(item.targetComment.author);
				}
			}
			break;
		case 'check_notifications':
			for (const item of view.events) {
				if (item.kind === 'bootstrap') { if (item.message.kind === 'factory' && item.message.introForum) refs.push(item.message.introForum); continue; }
				if (item.kind === 'unavailable') continue;
				if (item.kind === 'legacy') {
					if (item.actor) refs.push(item.actor); if (item.thread) notificationThread(item.thread); if (item.comment) notificationComment(item.comment);
					for (const target of [item.target, item.replyTo]) { if (target?.kind === 'profile') refs.push(target.ref); if (target?.kind === 'thread') notificationThread(target.thread); if (target?.kind === 'comment') notificationComment(target.comment); }
					continue;
				}
				refs.push(item.actor);
				if (item.kind === 'thread_post' || item.kind === 'reply' || item.kind === 'mention' || item.kind === 'comment_notice') notificationThread(item.thread);
				if (item.kind === 'reply' || item.kind === 'mention' || item.kind === 'comment_notice') notificationComment(item.comment);
				if (item.kind === 'reply') notificationComment(item.replyTo);
				if (item.kind === 'coalesced_comment_notice') item.comments.forEach(notice => notificationComment(notice.comment));
			}
			break;
		case 'batch_outcome': for (const item of view.items) { if (item.targetRef) refs.push(item.targetRef); if (item.kind === 'recorded') refs.push(...resultViewReferences(item.view)); } break;
		case 'create_thread': refs.push(view.forum); break;
		case 'settlement': case 'log_off': case 'draw_random_integers': case 'list_notes': case 'delete_note': case 'reply_to_comment': case 'vote': break;
	}
	return refs;
}

export function failureResultView(failure: import('../types').ToolFailurePayload, text: BotText, prose: { message: ResultText; guidance?: ResultText }): FailureView {
	const fields = {
		ok: false as const, code: failure.code, toolName: failure.toolName, args: providerToolArgs(failure.toolName, failure.args),
		forumWriteCause: failure.forumWriteCause, followCause: failure.followCause,
		existingUrlPath: failure.existingUrlPath, existingThreadId: failure.existingThreadId, existingThreadRef: failure.existingThreadRef,
		existingThreadTitle: failure.existingThreadTitle, existingWorldHandle: failure.existingWorldHandle, existingForumHandle: failure.existingForumHandle,
		existingCommentId: failure.existingCommentId, existingCommentRef: failure.existingCommentRef, targetCommentId: failure.targetCommentId, targetCommentRef: failure.targetCommentRef,
		existingReplies: failure.existingReplies?.map(reply => ({ commentId: reply.commentId, commentRef: reply.commentRef, body: reply.body, urlPath: reply.urlPath, createdAt: reply.createdAt })),
	};
	return { ...resultViewBase(text), kind: 'failure', fields, message: prose.message, ...(prose.guidance ? { guidance: prose.guidance } : {}) };
}
export function settlementResultView(kind: SettlementView['outcome']['kind'], message: ResultText, text: BotText): SettlementView {
	return { ...resultViewBase(text), kind: 'settlement', outcome: { kind, message } };
}
export async function batchResultView(name: string, items: readonly import('../errors').ToolBatchOutcomeItem[], context: ViewBuildContext, failure: (args: Record<string, unknown>, error: unknown) => FailureView): Promise<BatchOutcomeView> {
	const result: BatchOutcomeView['items'] = [];
	for (const item of items) {
		const targetRef = item.targetParticipant ? ref('participant', item.targetParticipant.id, item.targetParticipant.handle) : undefined;
		switch (item.kind) {
			case 'recorded': {
				const view = await buildToolResultView(item.envelope, context);
				if (!view) throw new Error('The recorded batch item has no typed view.');
				result.push({ kind: 'recorded', target: item.target, ...(targetRef ? { targetRef } : {}), view }); break;
			}
			case 'committed': result.push({ kind: item.kind, target: item.target, ...(targetRef ? { targetRef } : {}), message: resultDescriptor(item.issue) }); break;
			case 'refused': {
				const rendered = failure(item.args, item.error);
				result.push({ kind: 'refused', target: item.target, ...(targetRef ? { targetRef } : {}), message: rendered.message, ...(rendered.guidance ? { guidance: rendered.guidance } : {}) }); break;
			}
			case 'unknown': result.push({ kind: item.kind, target: item.target, ...(targetRef ? { targetRef } : {}), message: unknownOutcomeText(name) }); break;
			case 'not_attempted': result.push({ kind: item.kind, target: item.target, ...(targetRef ? { targetRef } : {}), message: resultMessage('recovery.batch.notAttempted') }); break;
		}
	}
	return { ...resultViewBase(context.text, context.writtenAt), kind: 'batch_outcome', items: result, guidance: resultMessage('recovery.batch.guidance') };
}

export function notificationContentIds(events: import('@bickr/shared/model').StoredNotificationEvent[]): { threadIds: string[]; commentIds: string[] } {
	const threadIds: string[] = [], commentIds: string[] = [];
	for (const event of events) {
		switch (event.kind) {
			case 'thread_post': threadIds.push(event.thread.id); break;
			case 'reply': commentIds.push(event.replyTo.id); threadIds.push(event.thread.id); commentIds.push(event.comment.id); break;
			case 'mention': case 'comment_notice': threadIds.push(event.thread.id); commentIds.push(event.comment.id); break;
			case 'vote': threadIds.push(event.target.threadId); commentIds.push(event.target.id); break;
			case 'follower_activity_digest': for (const activity of event.activities) { threadIds.push(activity.thread.id); if (activity.kind === 'comment') commentIds.push(activity.comment.id); } break;
			case 'bootstrap': case 'follow': case 'unfollow': case 'legacy': break;
		}
	}
	return { threadIds, commentIds };
}

/** The producer supplies current references for the first budget preview. */
export function resultViewBuildRenderContext(view: ToolResultView, input: Pick<ViewBuildContext, 'text' | 'time'>): ResultRenderContext {
	return Object.freeze({ text: input.text, time: Object.freeze({ settings: Object.freeze({ mode: input.time.settings.mode, timezone: input.time.settings.timezone }), createdAt: input.time.createdAt }), handles: producedResultHandles(view) });
}

/** The first render uses references from the new result, before it enters history. */
export function producedResultHandles(view: ToolResultView): ResultRenderContext['handles'] {
	const handles: Map<string, CurrentResultHandle> = new Map(resultViewReferences(view).map(ref => [resultHandleKey(ref), Object.freeze({ kind: 'current' as const, handle: ref.handle })]));
	if (view.kind === 'read_note' || view.kind === 'write_note') {
		for (const link of view.links) handles.set(resultHandleKey(link.ref), Object.freeze({ kind: link.deleted ? 'deleted' : 'current', handle: link.ref.handle }));
	}
	if (view.kind === 'batch_outcome') for (const item of view.items) {
		if (item.kind === 'recorded') for (const [key, handle] of producedResultHandles(item.view)) handles.set(key, handle);
	}
	return handles;
}
