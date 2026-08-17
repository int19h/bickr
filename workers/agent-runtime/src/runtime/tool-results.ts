import { formatCommentRef, formatThreadRef, parseCommentRef, parseThreadRef } from '@bickr/shared/ids';
import { legacyToolResultEnvelope } from '@bickr/shared/legacy-tool-result-adapter';
import type { ToolResultEnvelope, ToolResultProfileAction, ToolResultVote } from '@bickr/shared/tool-results';
import {
	type BotFollowUsernameQueryResult,
	type LegacyNotificationEvent,
	type NotificationCommentPostRef,
	type NotificationCommentRef,
	type NotificationDeliveryReason,
	type NotificationProfileRef,
	type NotificationThreadPostRef,
	type NotificationThreadRef,
	type StoredNotificationEvent,
	type ThreadDocument,
	storedNotificationEvent,
} from '@bickr/shared/model';
import type {
	ChatMessage,
	ProviderNotificationEventGroup,
	ProviderNotificationPayloadResult,
	ProviderNotificationPruneResult,
	ProviderToolArrayPruneResult,
	ProviderToolResultPayloadOptions,
	ReadContentItem,
	ReadPruneResult,
} from '../types';
import { providerSelfAuthor } from '../constants';
import { canonicalToolName, localizedArgumentText } from './tool-args';

export function providerToolResultPayload(
	name: string,
	result: unknown,
	args: Record<string, unknown>,
	context: ProviderSerializationContext,
	options: ProviderToolResultPayloadOptions = {},
	envelope?: ToolResultEnvelope,
): unknown {
	const canonical = canonicalToolName(name);
	const semanticResult = envelope ?? legacyToolResultEnvelope(canonical, result, args);
	if (canonical === 'check_notifications') {
		const record = runtimeRecord(result);
		return providerCheckNotificationsResult(Array.isArray(record.events) ? record.events : [], context, options.tokenBudget);
	}
	if (canonical === 'list_accessible_forums' && Array.isArray(result)) {
		const forums = result.map((item) => providerForum(runtimeRecord(item)));
		return pruneProviderArrayForBudget(forums, options.tokenBudget).items;
	}
	if (canonical === 'list_recent_threads' && Array.isArray(result)) {
		const threads = result.map((item) => providerThreadSummary(runtimeRecord(item), context, { includeForum: false }));
		return pruneProviderArrayForBudget(threads, options.tokenBudget).items;
	}
	if (canonical === 'list_hot_threads' && Array.isArray(result)) {
		const threads = result.map((item) => providerThreadSummary(runtimeRecord(item), context, { includeForum: true }));
		return pruneProviderArrayForBudget(threads, options.tokenBudget).items;
	}
	if (canonical === 'search_threads' || canonical === 'search_threads_semantic') {
		if (!Array.isArray(result)) {
			return providerSafeJsonValue(result);
		}
		const posts = result.map((item) => providerSearchPost(runtimeRecord(item), context));
		return pruneProviderArrayForBudget(posts, options.tokenBudget).items;
	}
	if (canonical === 'search_profiles' && Array.isArray(result)) {
		const profiles = result.map((item) => providerProfile(runtimeRecord(item)));
		return pruneProviderArrayForBudget(profiles, options.tokenBudget).items;
	}
	if (canonical === 'list_profiles') {
		return providerProfileListResult(runtimeRecord(result), options.tokenBudget);
	}
	if (canonical === 'view_profiles') {
		const record = runtimeRecord(result);
		const profiles = Array.isArray(record.profiles) ? record.profiles : Array.isArray(result) ? result : [result];
		const providerProfiles = profiles.map((item) => providerProfile(runtimeRecord(item)));
		const pruned = pruneProviderArrayForBudget(providerProfiles, options.tokenBudget, (items) => ({ profiles: items }));
		return {
			profiles: pruned.items,
		};
	}
	if (canonical === 'query_followers') {
		return providerFollowerQueryResult(runtimeRecord(result));
	}
	if (canonical === 'view_activity') {
		return providerActivityFeedResult(runtimeRecord(result), options.tokenBudget);
	}
	if (canonical === 'follow_profile' || canonical === 'unfollow_profile') {
		if (semanticResult.kind === 'profile_followed' || semanticResult.kind === 'profile_unfollowed') {
			return semanticResult.profiles.map(providerFollowResult);
		}
		return providerSafeJsonValue(result);
	}
	if (canonical === 'vote' && semanticResult.kind === 'vote_set') {
		return semanticResult.votes.map(providerVoteResult);
	}
	if (canonical === 'read_thread' || canonical === 'read_thread_by_id' || canonical === 'read_comment_by_id') {
		return providerReadResult(runtimeRecord(result), context);
	}
	if (canonical === 'create_thread') {
		return semanticResult.kind === 'thread_created' ? providerCreateThreadResult(semanticResult) : providerSafeJsonValue(result);
	}
	if (canonical === 'reply_to_comment' || canonical === 'make_additional_reply_to_the_same_comment') {
		return semanticResult.kind === 'comment_created' ? providerReplyCommentResult(semanticResult) : providerSafeJsonValue(result);
	}
	if (canonical === 'log_off') {
		return providerSafeJsonValue(result);
	}
	return providerSafeJsonValue(result);
}

function providerJsonTokenEstimate(value: unknown): number {
	return estimateTextTokens(JSON.stringify(value));
}

function pruneProviderArrayForBudget<T>(
	items: T[],
	tokenBudget: number | undefined,
	payloadForItems: (items: T[]) => unknown = (array) => array,
	removeFrom: 'head' | 'tail' = 'tail',
): ProviderToolArrayPruneResult<T> {
	if (tokenBudget === undefined) {
		return {
			items,
			omittedCount: 0,
			tokenEstimate: providerJsonTokenEstimate(payloadForItems(items)),
		};
	}
	const budget = Math.max(1, Math.floor(tokenBudget));
	const pruned = [...items];
	let omittedCount = 0;
	let tokenEstimate = providerJsonTokenEstimate(payloadForItems(pruned));
	while (pruned.length > 0 && tokenEstimate > budget) {
		if (removeFrom === 'head') {
			pruned.shift();
		} else {
			pruned.pop();
		}
		omittedCount += 1;
		tokenEstimate = providerJsonTokenEstimate(payloadForItems(pruned));
	}
	return {
		items: pruned,
		omittedCount,
		tokenEstimate,
	};
}

export function providerToolResultUsesTokenBudget(name: string): boolean {
	const canonical = canonicalToolName(name);
	return (
		canonical === 'check_notifications' ||
		canonical === 'list_accessible_forums' ||
		canonical === 'list_recent_threads' ||
		canonical === 'list_hot_threads' ||
		canonical === 'search_threads' ||
		canonical === 'search_threads_semantic' ||
		canonical === 'search_profiles' ||
		canonical === 'list_profiles' ||
		canonical === 'view_profiles' ||
		canonical === 'view_activity'
	);
}

export type ProviderContextContentScope = {
	commentsWithText: Set<string>;
	threadsWithText: Set<string>;
};

/**
 * Identity of the participant whose provider context is being composed. Forum content authored by
 * this participant is serialized with a {@link providerSelfAuthor} annotation on its usable
 * `u/<handle>` reference, or the standalone marker when no usable handle exists, so the participant
 * cannot mistake its own thread or comment for somebody else's.
 */
export type ProviderSelfParticipant = {
	readonly botId: string;
};

export { providerSelfAuthor };

/**
 * Everything provider-facing forum serialization needs beyond the raw result: who is reading, and
 * which thread/comment bodies the provider context already carries. Identity is a required part of
 * the boundary so no serialization path can silently lose it halfway down a content tree.
 */
export type ProviderSerializationContext = {
	readonly self: ProviderSelfParticipant;
	readonly content: ProviderContextContentScope;
};

export function providerSerializationContext(
	self: ProviderSelfParticipant,
	content: ProviderContextContentScope = emptyProviderContextContentScope(),
): ProviderSerializationContext {
	return { self, content };
}

export function emptyProviderContextContentScope(): ProviderContextContentScope {
	return {
		commentsWithText: new Set(),
		threadsWithText: new Set(),
	};
}

export function cloneProviderContextContentScope(scope: ProviderContextContentScope): ProviderContextContentScope {
	return {
		commentsWithText: new Set(scope.commentsWithText),
		threadsWithText: new Set(scope.threadsWithText),
	};
}

function providerCheckNotificationsResult(
	events: unknown[],
	context: ProviderSerializationContext,
	tokenBudget?: number,
): Record<string, unknown> {
	return providerCheckNotificationsResultWithInclusions(events, context, tokenBudget).payload;
}

export function providerCheckNotificationsResultWithInclusions(
	events: unknown[],
	initialContext: ProviderSerializationContext,
	tokenBudget?: number,
): ProviderNotificationPayloadResult {
	const context = providerSerializationContext(initialContext.self, cloneProviderContextContentScope(initialContext.content));
	const storedEvents = events
		.map(storedNotificationEvent)
		.filter((event): event is StoredNotificationEvent => Boolean(event));
	const providerEvents = mergedProviderNotificationEventGroups(storedEvents).map((group) => ({
		notificationIds: group.notificationIds,
		payload: runtimeRecord(providerSafeJsonValue(providerNotificationEvent(group.event, group.deliveryReasons, context))),
	}));
	if (tokenBudget === undefined) {
		return {
			payload: providerNotificationResultPayload(providerEvents.map((event) => event.payload)),
			includedEventIds: providerEvents.flatMap((event) => event.notificationIds),
		};
	}
	const pruned = pruneProviderNotificationEventsForBudget(providerEvents, tokenBudget);
	return {
		payload: providerNotificationResultPayload(
			pruned.events.map((event) => event.payload),
			pruned,
		),
		includedEventIds: pruned.events.flatMap((event) => event.notificationIds),
	};
}

function providerNotificationResultPayload(
	events: Record<string, unknown>[],
	pruned?: Pick<ProviderNotificationPruneResult, 'omittedEventCount'>,
): Record<string, unknown> {
	return removeUndefinedProperties({
		...(pruned && pruned.omittedEventCount > 0 ? { context: providerNotificationResultContext(pruned) } : {}),
		events,
	});
}

function providerNotificationResultContext(pruned: Pick<ProviderNotificationPruneResult, 'omittedEventCount'>): string {
	const parts: string[] = [];
	if (pruned.omittedEventCount > 0) {
		parts.push(
			`${pruned.omittedEventCount} older notification event${pruned.omittedEventCount === 1 ? ' was' : 's were'} omitted to keep this result compact`,
		);
	}
	return `Result of checking notifications. ${parts.join('. ')}.`;
}

function pruneProviderNotificationEventsForBudget(
	events: Array<{ notificationIds: string[]; payload: Record<string, unknown> }>,
	tokenBudget: number,
): ProviderNotificationPruneResult {
	const budget = Math.max(1, Math.floor(tokenBudget));
	const prunedEvents = events.map((event) => ({
		notificationIds: [...event.notificationIds],
		payload: JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>,
	}));
	let omittedEventCount = 0;
	let tokenEstimate = providerNotificationTokenEstimate(
		prunedEvents.map((event) => event.payload),
		{ omittedEventCount },
	);
	while (prunedEvents.length > 0 && tokenEstimate > budget) {
		prunedEvents.shift();
		omittedEventCount += 1;
		tokenEstimate = providerNotificationTokenEstimate(
			prunedEvents.map((event) => event.payload),
			{ omittedEventCount },
		);
	}
	return {
		events: prunedEvents,
		omittedEventCount,
		tokenEstimate,
	};
}

function providerNotificationTokenEstimate(
	events: Record<string, unknown>[],
	pruned: Pick<ProviderNotificationPruneResult, 'omittedEventCount'>,
): number {
	return estimateTextTokens(JSON.stringify(providerNotificationResultPayload(events, pruned)));
}

/**
 * Which stored events may collapse into one delivered payload. Content creation is immutable: a
 * comment is the same comment however many recipient classes were notified about it, so several
 * notifications naming one source object render once with their reasons unioned.
 *
 * Repeatable actions are not immutable. Two participants voting on one comment, one participant
 * moving from +1 to -1, and a follow/unfollow/follow sequence all share a source object while
 * differing in actor, value or direction — merging them would render the first payload alone while
 * marking every grouped notification delivered, so the rest would be silently lost. They stay one
 * group per notification.
 */
function providerNotificationEventMergesBySource(event: StoredNotificationEvent): boolean {
	switch (event.kind) {
		case 'thread_post':
		case 'reply':
		case 'mention':
		case 'comment_notice':
			return true;
		case 'bootstrap':
		case 'vote':
		case 'follow':
		case 'unfollow':
			return false;
		case 'legacy':
			// Legacy documents predate the payload kinds and carry only a type string, written by
			// several generations of writers: merge the content-creation vocabularies of all of
			// them and leave everything else — repeatable actions, and anything this build does
			// not recognize — distinct.
			return legacyMergeableNotificationTypes.has(event.type);
	}
}

const legacyMergeableNotificationTypes: ReadonlySet<string> = new Set([
	'thread_created',
	'comment_created',
	'reply',
	'mention',
	'personal_forum_post',
	'followed_activity',
]);

function mergedProviderNotificationEventGroups(events: StoredNotificationEvent[]): ProviderNotificationEventGroup[] {
	const bySource = new Map<string, ProviderNotificationEventGroup>();
	const order: string[] = [];
	let position = 0;
	for (const event of events) {
		const notificationId = stringValue(event.id);
		position += 1;
		const key =
			event.sourceObjectId && providerNotificationEventMergesBySource(event) ? `source:${event.type}:${event.sourceObjectId}` : '';
		if (!key) {
			// Position, not notification id: unique by construction, so an event with no id — or a
			// repeated one — still gets a group of its own rather than overwriting somebody else's.
			const uniqueKey = `event:${position}`;
			bySource.set(uniqueKey, {
				event,
				deliveryReasons: [...event.deliveryReasons],
				notificationIds: notificationId ? [notificationId] : [],
			});
			order.push(uniqueKey);
			continue;
		}
		const existing = bySource.get(key);
		if (!existing) {
			bySource.set(key, {
				event,
				deliveryReasons: [...event.deliveryReasons],
				notificationIds: notificationId ? [notificationId] : [],
			});
			order.push(key);
			continue;
		}
		if (notificationId) {
			existing.notificationIds.push(notificationId);
		}
		existing.deliveryReasons = orderedProviderDeliveryReasons([...existing.deliveryReasons, ...event.deliveryReasons]);
	}
	return order.map((key) => bySource.get(key)).filter((event): event is ProviderNotificationEventGroup => Boolean(event));
}

/**
 * The delivered form of one notification, per payload class. Slim and minimal payloads carry no
 * bodies, so what they render is exactly their references; the full ones spend their text budget
 * once each through the shared content scope.
 */
function providerNotificationEvent(
	event: StoredNotificationEvent,
	deliveryReasons: string[],
	context: ProviderSerializationContext,
): Record<string, unknown> {
	const header = {
		type: event.type,
		deliveryReasons: orderedProviderDeliveryReasons(deliveryReasons),
	};
	switch (event.kind) {
		case 'bootstrap':
			// The bootstrap message is Bickr's own words to the participant, not
			// somebody's forum content, which is why it alone is rendered.
			return removeUndefinedProperties({ ...header, message: stringValue(event.message) });
		case 'thread_post':
			return removeUndefinedProperties({
				...header,
				actor: providerNotificationProfileRef(event.actor),
				thread: providerNotificationThreadPostRef(event.thread, context),
			});
		case 'reply':
			return removeUndefinedProperties({
				...header,
				actor: providerNotificationProfileRef(event.actor),
				thread: providerNotificationThreadRef(event.thread),
				comment: providerNotificationCommentPostRef(event.comment, context),
				replyTo: providerNotificationCommentPostRef(event.replyTo, context),
			});
		case 'mention':
			return removeUndefinedProperties({
				...header,
				actor: providerNotificationProfileRef(event.actor),
				thread: providerNotificationThreadRef(event.thread),
				comment: providerNotificationCommentPostRef(event.comment, context),
			});
		case 'comment_notice':
			return removeUndefinedProperties({
				...header,
				actor: providerNotificationProfileRef(event.actor),
				thread: providerNotificationThreadRef(event.thread),
				comment: providerNotificationCommentRef(event.comment),
			});
		case 'vote':
			// The vote reference names what was voted on and how, which is the whole
			// payload: a participant reading this already owns the comment.
			return removeUndefinedProperties({
				...header,
				actor: providerNotificationProfileRef(event.actor),
				vote: removeUndefinedProperties({
					threadRef: providerThreadRef(event.target.threadId),
					commentRef: providerCommentRef(event.target.id),
					value: event.value,
				}),
			});
		case 'follow':
		case 'unfollow':
			return removeUndefinedProperties({
				...header,
				actor: providerNotificationProfileRef(event.actor),
			});
		case 'legacy':
			return providerLegacyNotificationEvent(event, header, context);
	}
}

/**
 * Profile references (a notification's actor) name a participant rather than the author of a piece
 * of forum content, so they keep their `u/<handle>` form even when they point at the reading
 * participant.
 */
function providerNotificationProfileRef(profile: NotificationProfileRef): string | undefined {
	return providerUsername(profile.username);
}

function providerNotificationThreadRef(thread: NotificationThreadRef): Record<string, unknown> {
	return removeUndefinedProperties({
		threadRef: providerThreadRef(thread.id),
		title: stringValue(thread.title),
	});
}

function providerNotificationThreadPostRef(
	thread: NotificationThreadPostRef,
	context: ProviderSerializationContext,
): Record<string, unknown> {
	const includeText = !context.content.threadsWithText.has(thread.id);
	context.content.threadsWithText.add(thread.id);
	return removeUndefinedProperties({
		threadRef: providerThreadRef(thread.id),
		title: stringValue(thread.title),
		author: providerAuthorRef({ author: thread.author }, context.self),
		...(includeText ? { text: stringValue(thread.text) } : {}),
	});
}

function providerNotificationCommentRef(comment: NotificationCommentRef): Record<string, unknown> {
	return removeUndefinedProperties({
		commentRef: providerCommentRef(comment.id),
		threadRef: providerThreadRef(comment.threadId),
	});
}

function providerNotificationCommentPostRef(
	comment: NotificationCommentPostRef,
	context: ProviderSerializationContext,
): Record<string, unknown> {
	const includeText = !context.content.commentsWithText.has(comment.id);
	context.content.commentsWithText.add(comment.id);
	return removeUndefinedProperties({
		commentRef: providerCommentRef(comment.id),
		threadRef: providerThreadRef(comment.threadId),
		author: providerAuthorRef({ author: comment.author }, context.self),
		...(includeText ? { text: stringValue(comment.text) } : {}),
	});
}

/**
 * Legacy adapter: one flat event whose fields have to be sniffed, because every recipient of an
 * action got the same object and its references were whatever that action produced. Retire it with
 * {@link LegacyNotificationEvent}, once no stored document predates the per-recipient payloads.
 */
function providerLegacyNotificationEvent(
	event: LegacyNotificationEvent,
	header: Record<string, unknown>,
	context: ProviderSerializationContext,
): Record<string, unknown> {
	return removeUndefinedProperties({
		...header,
		message: event.type === 'bootstrap' ? stringValue(event.message) : undefined,
		actor: providerNotificationProfileRefRecord(runtimeRecord(event.actor)),
		target: providerLegacyNotificationTargetRef(event.target, context),
		thread: providerLegacyNotificationThreadRef(runtimeRecord(event.thread), context),
		comment: providerNotificationCommentRefRecord(runtimeRecord(event.comment), context),
		replyTo: providerLegacyNotificationTargetRef(event.replyTo, context),
		vote: providerLegacyNotificationVoteRef(runtimeRecord(event.vote)),
	});
}

function providerLegacyNotificationTargetRef(
	value: unknown,
	context: ProviderSerializationContext,
): Record<string, unknown> | string | undefined {
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return undefined;
	}
	if (stringValue(record.threadId) || stringValue(record.threadRef) || stringValue(record.parentCommentId)) {
		return providerNotificationCommentRefRecord(record, context);
	}
	if (stringValue(record.title)) {
		return providerLegacyNotificationThreadRef(record, context);
	}
	return providerNotificationProfileRefRecord(record);
}

function providerNotificationProfileRefRecord(record: Record<string, unknown>): string | undefined {
	const username = stringValue(record.username);
	if (!username) {
		return undefined;
	}
	return username.startsWith('u/') ? username : `u/${username}`;
}

function providerLegacyNotificationThreadRef(
	record: Record<string, unknown>,
	context: ProviderSerializationContext,
): Record<string, unknown> | undefined {
	const threadId = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.threadId) ?? stringValue(record.id);
	const text = stringValue(record.text) ?? stringValue(record.body) ?? stringValue(runtimeRecord(record.rootPost).body);
	if (!threadId && !stringValue(record.title)) {
		return undefined;
	}
	const includeText = Boolean(threadId && text && !context.content.threadsWithText.has(threadId));
	if (threadId && text) {
		context.content.threadsWithText.add(threadId);
	}
	return removeUndefinedProperties({
		threadRef: providerThreadRef(threadId),
		title: stringValue(record.title),
		author: providerAuthorRef(record, context.self),
		...(includeText ? { text } : {}),
	});
}

function providerNotificationCommentRefRecord(
	record: Record<string, unknown>,
	context: ProviderSerializationContext,
): Record<string, unknown> | undefined {
	const id = parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.id) ?? stringValue(record.commentId);
	const text = stringValue(record.text) ?? stringValue(record.body);
	const threadId = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.threadId);
	if (!id && !threadId) {
		return undefined;
	}
	const includeText = Boolean(id && text && !context.content.commentsWithText.has(id));
	if (id && text) {
		context.content.commentsWithText.add(id);
	}
	return removeUndefinedProperties({
		commentRef: providerCommentRef(id),
		threadRef: providerThreadRef(threadId),
		author: providerAuthorRef(record, context.self),
		...(includeText ? { text } : {}),
	});
}

function providerLegacyNotificationVoteRef(record: Record<string, unknown>): Record<string, unknown> | undefined {
	if (Object.keys(record).length === 0) {
		return undefined;
	}
	return removeUndefinedProperties({
		threadRef: providerThreadRef(record.threadId ?? record.threadRef),
		commentRef: providerCommentRef(record.commentId ?? record.commentRef),
		value: numberValue(record.value),
	});
}

/**
 * The delivered twin of the stored reason order, exhaustive over the union by construction. An
 * unknown reason sorts after the known ones rather than being dropped, because a stored document
 * may name a reason this build predates.
 */
const providerDeliveryReasonOrder: Record<NotificationDeliveryReason, number> = {
	bootstrap: 0,
	direct_reply: 1,
	mention: 2,
	personal_forum_post: 3,
	profile_followed_you: 4,
	profile_unfollowed_you: 5,
	vote_on_your_content: 6,
	followed_profile_activity: 7,
	system: 8,
};

export function orderedProviderDeliveryReasons(reasons: string[]): string[] {
	const order: Record<string, number | undefined> = providerDeliveryReasonOrder;
	const unique = [...new Set(reasons.filter(Boolean))];
	const known = unique.filter((reason) => order[reason] !== undefined);
	const unknown = unique.filter((reason) => order[reason] === undefined);
	return [
		...known.sort((left, right) => (order[left] ?? 0) - (order[right] ?? 0)),
		...unknown.sort((left, right) => left.localeCompare(right)),
	];
}

export function collectProviderContextContentFromValue(value: unknown, scope: ProviderContextContentScope): void {
	if (typeof value === 'string') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			return;
		}
		collectProviderContextContentFromValue(parsed, scope);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectProviderContextContentFromValue(item, scope);
		}
		return;
	}
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return;
	}
	const text = stringValue(record.text) ?? stringValue(record.body) ?? stringValue(runtimeRecord(record.rootPost).body);
	if (text) {
		const commentId = commentIdFromProviderContentRecord(record);
		const threadId = parseThreadRef(stringValue(record.threadRef)) ?? stringValue(record.threadId) ?? stringValue(record.id);
		if (commentId) {
			scope.commentsWithText.add(commentId);
		} else if (threadId) {
			scope.threadsWithText.add(threadId);
		}
	}
	for (const item of Object.values(record)) {
		collectProviderContextContentFromValue(item, scope);
	}
}

export function commentTextRecordsFromChatMessages(messages: ChatMessage[]): Map<string, string> {
	const records = new Map<string, string>();
	for (const message of messages) {
		collectCommentTextRecordsFromValue(message.content, records);
	}
	return records;
}

function collectCommentTextRecordsFromValue(value: unknown, output: Map<string, string>): void {
	if (typeof value === 'string') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			return;
		}
		collectCommentTextRecordsFromValue(parsed, output);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectCommentTextRecordsFromValue(item, output);
		}
		return;
	}
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return;
	}
	const commentId = commentIdFromProviderContentRecord(record);
	const text = commentTextFromProviderContentRecord(record);
	if (commentId && text && !output.has(commentId)) {
		output.set(commentId, text);
	}
	for (const item of Object.values(record)) {
		collectCommentTextRecordsFromValue(item, output);
	}
}

export function commentReferencesWithoutTextFromValue(value: unknown): Set<string> {
	const refs = new Set<string>();
	collectCommentReferencesWithoutTextFromValue(value, refs);
	return refs;
}

function collectCommentReferencesWithoutTextFromValue(value: unknown, refs: Set<string>): void {
	if (typeof value === 'string') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			return;
		}
		collectCommentReferencesWithoutTextFromValue(parsed, refs);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectCommentReferencesWithoutTextFromValue(item, refs);
		}
		return;
	}
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return;
	}
	const commentId = commentIdFromProviderContentRecord(record);
	if (commentId && !commentTextFromProviderContentRecord(record)) {
		refs.add(commentId);
	}
	for (const item of Object.values(record)) {
		collectCommentReferencesWithoutTextFromValue(item, refs);
	}
}

export function hydrateNewestCommentReferences(
	value: unknown,
	commentIds: ReadonlySet<string>,
	commentBodies: ReadonlyMap<string, string>,
): Set<string> {
	const pending = new Set([...commentIds].filter((commentId) => commentBodies.has(commentId)));
	const hydrated = new Set<string>();
	hydrateNewestCommentReferencesInValue(value, pending, hydrated, commentBodies);
	return hydrated;
}

function hydrateNewestCommentReferencesInValue(
	value: unknown,
	pending: Set<string>,
	hydrated: Set<string>,
	commentBodies: ReadonlyMap<string, string>,
): void {
	if (pending.size === 0) {
		return;
	}
	if (Array.isArray(value)) {
		for (let index = value.length - 1; index >= 0 && pending.size > 0; index -= 1) {
			hydrateNewestCommentReferencesInValue(value[index], pending, hydrated, commentBodies);
		}
		return;
	}
	const record = runtimeRecord(value);
	if (Object.keys(record).length === 0) {
		return;
	}
	const keys = Object.keys(record);
	for (let index = keys.length - 1; index >= 0 && pending.size > 0; index -= 1) {
		const key = keys[index];
		if (key !== undefined) {
			hydrateNewestCommentReferencesInValue(record[key], pending, hydrated, commentBodies);
		}
	}
	const commentId = commentIdFromProviderContentRecord(record);
	if (!commentId || !pending.has(commentId) || commentTextFromProviderContentRecord(record)) {
		return;
	}
	const body = commentBodies.get(commentId);
	if (!body) {
		return;
	}
	record[commentHydrationTextField(record)] = body;
	pending.delete(commentId);
	hydrated.add(commentId);
}

function commentIdFromProviderContentRecord(record: Record<string, unknown>): string | undefined {
	const explicitCommentId = parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId);
	if (explicitCommentId) {
		return explicitCommentId;
	}
	const type = stringValue(record.type);
	if (type === 'comment') {
		return stringValue(record.id);
	}
	if (stringValue(record.parentCommentId)) {
		return stringValue(record.id);
	}
	const id = stringValue(record.id);
	if (
		id &&
		(stringValue(record.threadId) || stringValue(record.threadRef)) &&
		!stringValue(record.title) &&
		(record.author !== undefined || stringValue(record.authorHandle) || stringValue(record.authorDisplayName))
	) {
		return id;
	}
	return undefined;
}

function commentTextFromProviderContentRecord(record: Record<string, unknown>): string | undefined {
	return rawNonEmptyString(record.body) ?? rawNonEmptyString(record.text);
}

function commentHydrationTextField(record: Record<string, unknown>): 'body' | 'text' {
	if (stringValue(record.type) === 'comment' || 'body' in record) {
		return 'body';
	}
	return 'text';
}

function rawNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function removeUndefinedProperties(record: Record<string, unknown>): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (value !== undefined) {
			output[key] = value;
		}
	}
	return output;
}

const providerRelativeTimeUnits: Array<{ name: string; ms: number }> = [
	{ name: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
	{ name: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
	{ name: 'day', ms: 24 * 60 * 60 * 1000 },
	{ name: 'hour', ms: 60 * 60 * 1000 },
	{ name: 'minute', ms: 60 * 1000 },
];

function providerRelativeTime(value: unknown, nowMs = Date.now()): string | undefined {
	const text = stringValue(value);
	if (!text) {
		return undefined;
	}
	const timeMs = Date.parse(text);
	if (!Number.isFinite(timeMs)) {
		return text;
	}
	const diffMs = nowMs - timeMs;
	const absMs = Math.abs(diffMs);
	if (absMs < 60 * 1000) {
		return 'just now';
	}
	const unit = providerRelativeTimeUnits.find((candidate) => absMs >= candidate.ms) ?? providerRelativeTimeUnits.at(-1)!;
	const count = Math.max(1, Math.floor(absMs / unit.ms));
	const label = `${count} ${unit.name}${count === 1 ? '' : 's'}`;
	return diffMs < 0 ? `in ${label}` : `${label} ago`;
}

function providerUsername(value: unknown): string | undefined {
	const raw = stringValue(value);
	if (!raw) {
		return undefined;
	}
	const handle = raw.replace(/^u\//, '');
	return handle ? `u/${handle}` : undefined;
}

function providerProfileUsername(record: Record<string, unknown>): string | undefined {
	return providerUsername(record.username) ?? providerUsername(record.handle) ?? providerUsername(record.authorHandle);
}

function providerAuthorUsername(record: Record<string, unknown>): string | undefined {
	const author = runtimeRecord(record.author);
	return providerProfileUsername(author) ?? providerUsername(record.authorHandle);
}

/**
 * Canonical author identity of a piece of forum content. Only two keys ever carry it on the records
 * this module serializes: `authorBotId` on thread summaries, search results and read-content items,
 * and `author.id` on notification profile refs. Handles are deliberately not consulted — they are
 * renameable and reusable, so handle equality cannot decide authorship.
 */
function providerAuthorBotId(record: Record<string, unknown>): string | undefined {
	return stringValue(record.authorBotId) ?? stringValue(runtimeRecord(record.author).id);
}

/**
 * The single author-rendering decision for every provider-facing forum-content surface. Canonical
 * self-authorship adds `(MYSELF)` to a usable `u/<handle>` and otherwise falls back to `MYSELF`;
 * everyone else remains `u/<handle>`. Internal bot ids are never emitted.
 */
function providerAuthorRef(record: Record<string, unknown>, self: ProviderSelfParticipant): string | undefined {
	const authorBotId = providerAuthorBotId(record);
	const username = providerAuthorUsername(record);
	if (!authorBotId || authorBotId !== self.botId) {
		return username;
	}
	return username ? `${username} (${providerSelfAuthor})` : providerSelfAuthor;
}

function providerForumName(value: unknown): string | undefined {
	const raw = stringValue(value);
	if (!raw) {
		return undefined;
	}
	const handle = raw.replace(/^f\//, '');
	return handle ? `f/${handle}` : undefined;
}

function providerForumNameFromRecord(record: Record<string, unknown>): string | undefined {
	return providerForumName(record.forum) ?? providerForumName(record.handle) ?? providerForumName(record.forumHandle);
}

export function providerThreadRef(value: unknown): string | undefined {
	const threadId = parseThreadRef(stringValue(value));
	return threadId ? formatThreadRef(threadId) : undefined;
}

export function providerCommentRef(value: unknown): string | undefined {
	const commentId = parseCommentRef(stringValue(value));
	return commentId ? formatCommentRef(commentId) : undefined;
}

function providerFollowResult(action: ToolResultProfileAction): Record<string, unknown> {
	const reason = localizedArgumentText(action.reason);
	return removeUndefinedProperties({
		following: action.following,
		profile: providerProfileUsername(runtimeRecord(action.profile)),
		...(reason ? { reason } : {}),
	});
}

function providerVoteResult(vote: ToolResultVote): Record<string, unknown> {
	return removeUndefinedProperties({
		commentRef: providerCommentRef(vote.commentId),
		value: vote.value,
		target: providerVoteTargetReference(vote.thread, vote),
	});
}

function providerCreateThreadResult(envelope: Extract<ToolResultEnvelope, { kind: 'thread_created' }>): Record<string, unknown> {
	return {
		ok: true,
		thread: providerThreadReference(runtimeRecord(envelope.thread)),
	};
}

function providerReplyCommentResult(envelope: Extract<ToolResultEnvelope, { kind: 'comment_created' }>): Record<string, unknown> {
	return {
		ok: true,
		comment: providerCommentReference(runtimeRecord(envelope.thread), runtimeRecord(envelope.comment)),
	};
}

function providerForum(record: Record<string, unknown>): Record<string, unknown> {
	return {
		forum: providerForumNameFromRecord(record) ?? 'f/unknown',
		description: stringValue(record.description) ?? '',
		// Always emitted, never omitted when false: the tool description tells the
		// participant to read this flag before choosing where to create a thread.
		readOnly: record.readOnly === true,
	};
}

function providerThreadSummary(
	record: Record<string, unknown>,
	context: ProviderSerializationContext,
	options: { includeForum?: boolean } = {},
): Record<string, unknown> {
	const lock = runtimeRecord(record.lock);
	return removeUndefinedProperties({
		threadRef: providerThreadRef(stringValue(record.threadRef) ?? stringValue(record.threadId) ?? stringValue(record.id)),
		rootCommentRef: providerCommentRef(record.rootCommentId),
		...(options.includeForum ? { forum: providerForumNameFromRecord(record) ?? 'f/unknown' } : {}),
		title: stringValue(record.title) ?? 'untitled',
		author: providerAuthorRef(record, context.self),
		commentCount: numberValue(record.commentCount),
		locked: lock.kind === 'comment_limit' ? true : undefined,
		commentLimit: lock.kind === 'comment_limit' ? numberValue(lock.limit) : undefined,
		voteScore: numberValue(record.voteScore),
		lastActivity: providerRelativeTime(record.lastActivityAt),
	});
}

function providerSearchPost(record: Record<string, unknown>, context: ProviderSerializationContext): Record<string, unknown> {
	const commentId = stringValue(record.commentId) ?? stringValue(record.rootCommentId);
	const threadId = stringValue(record.threadId);
	const snippet = stringValue(record.snippet);
	const snippetAlreadyInContext =
		(commentId ? context.content.commentsWithText.has(commentId) : false) ||
		(!commentId && threadId ? context.content.threadsWithText.has(threadId) : false);
	return removeUndefinedProperties({
		threadRef: providerThreadRef(threadId),
		...(commentId ? { commentRef: providerCommentRef(commentId) } : {}),
		forum: providerForumNameFromRecord(record) ?? 'f/unknown',
		title: stringValue(record.title) ?? 'untitled',
		...(snippet && !snippetAlreadyInContext ? { snippet } : {}),
		author: providerAuthorRef(record, context.self),
		when: providerRelativeTime(record.createdAt),
	});
}

function providerProfile(record: Record<string, unknown>): Record<string, unknown> {
	return {
		username: providerProfileUsername(record),
		displayName: stringValue(record.displayName) ?? 'unknown',
		shortBio: stringValue(record.shortBio) ?? '',
		isFollowedByMe: record.isFollowedByMe === true,
		isFollowingMe: record.isFollowingMe === true,
		followers: numberValue(record.followers) ?? 0,
	};
}

function providerProfileListResult(record: Record<string, unknown>, tokenBudget?: number): Record<string, unknown> {
	const profiles = Array.isArray(record.profiles) ? record.profiles.map((item) => providerProfile(runtimeRecord(item))) : [];
	const mode = stringValue(record.mode) === 'random' ? 'random' : 'window';
	const limit = numberValue(record.limit) ?? profiles.length;
	const total = numberValue(record.total) ?? profiles.length;
	const pruned = pruneProviderArrayForBudget(profiles, tokenBudget, (items) => ({ profiles: items }));
	if (mode === 'random') {
		return {
			mode,
			limit,
			total,
			profiles: pruned.items,
		};
	}
	return {
		mode,
		offset: numberValue(record.offset) ?? 0,
		limit,
		total,
		hasMore: record.hasMore === true,
		profiles: pruned.items,
	};
}

function providerFollowerQueryResult(record: Record<string, unknown>): BotFollowUsernameQueryResult {
	return {
		total: numberValue(record.total) ?? 0,
		usernames: stringArrayValue(record.usernames).map((username) => providerUsername(username) ?? username),
	};
}

export function providerReadResult(record: Record<string, unknown>, context: ProviderSerializationContext): Record<string, unknown> {
	const content = Array.isArray(record.content) ? providerReadContentTree(record.content.map(runtimeRecord), context) : [];
	const collapsedReplyCount = providerCollapsedReplyCount(content);
	const trimmedBodyCount = providerTrimmedCommentBodyCount(content);
	const baseContext = stringValue(record.context) ?? 'Result of my read operation.';
	return {
		operation: stringValue(record.operation) ?? 'read',
		context: providerReadContextWithGuidance(baseContext, collapsedReplyCount, trimmedBodyCount),
		thread: providerThreadSummary(runtimeRecord(record.thread), context),
		...(stringValue(record.targetCommentId) ? { targetCommentRef: providerCommentRef(record.targetCommentId) } : {}),
		content,
	};
}

function providerReadContentTree(records: Record<string, unknown>[], context: ProviderSerializationContext): Record<string, unknown>[] {
	const roots: Record<string, unknown>[] = [];
	const comments: Record<string, unknown>[] = [];
	for (const record of records) {
		const item = providerReadContent(record, context);
		if (isProviderComment(item)) {
			comments.push(item);
		} else {
			roots.push(item);
		}
	}
	return [...roots, ...providerNestedCommentList(comments)];
}

function providerReadContent(record: Record<string, unknown>, context: ProviderSerializationContext): Record<string, unknown> {
	const type = stringValue(record.type) ?? (stringValue(record.commentId) ? 'comment' : 'item');
	const id = stringValue(record.id) ?? stringValue(record.commentId);
	const commentId = type === 'comment' ? (stringValue(record.commentId) ?? id) : stringValue(record.commentId);
	const body = stringValue(record.body) ?? stringValue(record.text);
	const includeBody =
		type === 'comment' ? Boolean(commentId && body && !context.content.commentsWithText.has(commentId)) : body !== undefined;
	if (type === 'comment' && commentId && body) {
		context.content.commentsWithText.add(commentId);
	}
	const item = removeUndefinedProperties({
		...(commentId ? { commentRef: providerCommentRef(commentId) } : {}),
		...(stringValue(record.parentCommentId) ? { parentCommentId: stringValue(record.parentCommentId) } : {}),
		author: providerAuthorRef(record, context.self),
		...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
		...(includeBody ? { body: body ?? '' } : {}),
		...(record['My focus is on this comment'] === true || record.target === true ? { 'My focus is on this comment': true } : {}),
		...(record.ancestorOnly ? { ancestorOnly: true } : {}),
	});
	if (type !== 'comment') {
		return item;
	}
	return {
		...item,
		replies: providerReadReplies(record.replies, context),
	};
}

function providerReadReplies(value: unknown, context: ProviderSerializationContext): Record<string, unknown>[] | number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(0, Math.floor(value));
	}
	return Array.isArray(value) ? providerReadContentTree(value.map(runtimeRecord), context).filter(isProviderComment) : [];
}

function providerNestedCommentList(comments: Record<string, unknown>[]): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>();
	const ordered = comments.map((comment) => {
		const node: Record<string, unknown> = {
			...comment,
			replies: providerNestedReplies(comment.replies),
		};
		const id = providerCommentId(node);
		if (id) {
			byId.set(id, node);
		}
		return node;
	});
	const roots: Record<string, unknown>[] = [];
	for (const node of ordered) {
		const parentId = stringValue(node.parentCommentId);
		const parent = parentId ? byId.get(parentId) : undefined;
		if (parent && parent !== node) {
			pushProviderReply(parent, node);
		} else {
			roots.push(node);
		}
	}
	return roots.map(providerCommentWithoutInternalNestingMetadata);
}

export function providerCommentReplies(comment: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(comment.replies) ? comment.replies.map(runtimeRecord) : [];
}

function providerCommentWithoutInternalNestingMetadata(comment: Record<string, unknown>): Record<string, unknown> {
	const { parentCommentId: _parentCommentId, ...rest } = comment;
	return {
		...rest,
		replies: providerNestedReplies(rest.replies),
	};
}

function providerNestedReplies(value: unknown): Record<string, unknown>[] | number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(0, Math.floor(value));
	}
	return Array.isArray(value)
		? value.map(runtimeRecord).filter(isProviderComment).map(providerCommentWithoutInternalNestingMetadata)
		: [];
}

export function providerCollapsedReplyCount(content: Record<string, unknown>[]): number {
	return content.reduce((total, item) => {
		if (typeof item.replies === 'number' && Number.isFinite(item.replies)) {
			return total + Math.max(0, Math.floor(item.replies));
		}
		return total + providerCollapsedReplyCount(providerCommentReplies(item));
	}, 0);
}

function providerTrimmedCommentBodyCount(content: Record<string, unknown>[]): number {
	return content.reduce((total, item) => {
		const body = stringValue(item.body);
		const current = body?.endsWith(readBodyTrimEllipsis) ? 1 : 0;
		return total + current + providerTrimmedCommentBodyCount(providerCommentReplies(item));
	}, 0);
}

export function readResultContext(operation: string, pruned: ReadPruneResult, tokenBudget: number): string {
	const changed = pruned.omittedReplyCount > 0 || pruned.trimmedBodyCount > 0;
	const detail =
		pruned.omittedReplyCount > 0 && pruned.trimmedBodyCount > 0
			? 'Some reply lists were collapsed and some comment bodies were shortened'
			: pruned.omittedReplyCount > 0
				? 'Some reply lists were collapsed'
				: pruned.trimmedBodyCount > 0
					? 'Some comment bodies were shortened'
					: '';
	const baseContext = changed
		? `Result of my ${operation} operation. ${detail} to keep the result within about ${tokenBudget} tokens.`
		: `Result of my ${operation} operation.`;
	return providerReadContextWithGuidance(baseContext, pruned.omittedReplyCount, pruned.trimmedBodyCount);
}

function providerReadContextWithGuidance(baseContext: string, collapsedReplyCount: number, trimmedBodyCount: number): string {
	let context = baseContext;
	if (collapsedReplyCount > 0 && !context.includes('numeric replies value')) {
		context = `${context} A numeric replies value means that many direct replies are omitted; call read_comment_by_id with that comment ref to inspect that branch.`;
	}
	if (trimmedBodyCount > 0 && !context.includes('body ending')) {
		context = `${context} A body ending in ${readBodyTrimEllipsis} has been shortened; call read_comment_by_id with that comment ref to read the full comment.`;
	}
	return context;
}

function pushProviderReply(parent: Record<string, unknown>, reply: Record<string, unknown>): void {
	const replies = providerCommentReplies(parent);
	const replyId = providerCommentId(reply);
	if (!replyId || !replies.some((existing) => providerCommentId(existing) === replyId)) {
		replies.push(reply);
	}
	parent.replies = replies;
}

function isProviderComment(record: Record<string, unknown>): boolean {
	return (
		stringValue(record.type) === 'comment' || Boolean(parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId))
	);
}

function providerCommentId(record: Record<string, unknown>): string | undefined {
	return parseCommentRef(stringValue(record.commentRef)) ?? stringValue(record.commentId) ?? stringValue(record.id);
}

function providerCommentReference(thread: Record<string, unknown>, comment: Record<string, unknown>): Record<string, unknown> {
	const commentId = providerCommentId(comment);
	const threadId = stringValue(comment.threadId) ?? stringValue(thread.id) ?? stringValue(thread.threadId);
	return removeUndefinedProperties({
		commentRef: providerCommentRef(commentId),
		threadRef: providerThreadRef(threadId),
	});
}

function providerThreadReference(thread: Record<string, unknown>): Record<string, unknown> {
	const threadId = parseThreadRef(stringValue(thread.threadRef)) ?? stringValue(thread.id) ?? stringValue(thread.threadId);
	const rootPost = runtimeRecord(thread.rootPost);
	const title = stringValue(thread.title) ?? stringValue(rootPost.title);
	return removeUndefinedProperties({
		threadRef: providerThreadRef(threadId),
		rootCommentRef: providerCommentRef(stringValue(thread.rootCommentId) ?? stringValue(rootPost.id) ?? stringValue(rootPost.commentId)),
		...(title ? { title } : {}),
	});
}

function providerVoteTargetReference(thread: ThreadDocument, vote: ToolResultVote): Record<string, unknown> {
	const targetId = vote.commentId;
	const comment = thread.comments.find((item) => item.id === targetId);
	return comment
		? providerCommentReference(runtimeRecord(thread), runtimeRecord(comment))
		: removeUndefinedProperties({
				commentRef: providerCommentRef(targetId),
				threadRef: providerThreadRef(thread.id),
			});
}

function providerActivityFeedResult(record: Record<string, unknown>, tokenBudget?: number): Record<string, unknown> {
	const profile = providerProfileUsername(runtimeRecord(record.bot));
	const activities = Array.isArray(record.activities) ? record.activities.map((item) => providerActivity(runtimeRecord(item))) : [];
	const payloadForActivities = (items: Record<string, unknown>[]) =>
		removeUndefinedProperties({
			profile,
			activities: items,
		});
	if (tokenBudget === undefined) {
		return payloadForActivities(activities);
	}
	trimProviderActivityBodyPreviewsForBudget(activities, tokenBudget, payloadForActivities);
	const pruned = pruneProviderArrayForBudget(activities, tokenBudget, payloadForActivities);
	return payloadForActivities(pruned.items);
}

function providerActivity(record: Record<string, unknown>): Record<string, unknown> {
	const type = stringValue(record.type);
	if (type === 'thread') {
		return removeUndefinedProperties({
			type,
			threadRef: providerThreadRef(record.threadId),
			forum: providerForumNameFromRecord(record),
			title: stringValue(record.title),
			bodyPreview: providerBodyPreview(record.bodyPreview),
			voteScore: numberValue(record.voteScore),
			commentCount: numberValue(record.commentCount),
			when: providerRelativeTime(record.createdAt),
		});
	}
	if (type === 'comment') {
		return removeUndefinedProperties({
			type,
			commentRef: providerCommentRef(record.commentId),
			forum: providerForumNameFromRecord(record),
			bodyPreview: providerBodyPreview(record.bodyPreview),
			replyTo: providerActivityCommentContext(runtimeRecord(record.parentComment), { includeCommentId: false }),
			when: providerRelativeTime(record.createdAt),
		});
	}
	if (type === 'vote') {
		const reason = localizedArgumentText(record.reason);
		return removeUndefinedProperties({
			type,
			commentRef: providerCommentRef(record.commentId ?? record.targetId),
			value: numberValue(record.value),
			threadRef: providerThreadRef(record.threadId),
			forum: providerForumNameFromRecord(record),
			title: localizedArgumentText(record.title),
			...(reason ? { reason } : {}),
			targetComment: providerActivityCommentContext(runtimeRecord(record.targetComment)),
			when: providerRelativeTime(record.updatedAt ?? record.createdAt),
		});
	}
	if (type === 'follow' || type === 'unfollow') {
		const reason = localizedArgumentText(record.reason);
		return removeUndefinedProperties({
			type,
			profile: providerProfileUsername(runtimeRecord(record.bot)),
			...(reason ? { reason } : {}),
			when: providerRelativeTime(record.createdAt),
		});
	}
	return removeUndefinedProperties({
		type,
		when: providerRelativeTime(record.createdAt ?? record.updatedAt),
	});
}

/**
 * Activity-feed comment contexts (a reply's parent, a vote's target) come from
 * `BotActivityCommentContext`, which carries only the author handle: the public activity API that
 * shares the type deliberately does not expose author bot ids. Authorship here therefore cannot be
 * decided canonically, and this surface keeps `u/<handle>` rather than guessing from handle
 * equality. Giving the feed a canonical author id is a separate, public-API-visible change.
 */
function providerActivityCommentContext(
	record: Record<string, unknown>,
	options: { includeCommentId?: boolean } = {},
): Record<string, unknown> | undefined {
	const commentId = stringValue(record.commentId);
	const author = providerUsername(record.authorHandle);
	const bodyPreview = providerBodyPreview(record.bodyPreview);
	if (!commentId && !author && !bodyPreview) {
		return undefined;
	}
	return removeUndefinedProperties({
		...(options.includeCommentId === false ? {} : { commentRef: providerCommentRef(commentId) }),
		author,
		bodyPreview,
	});
}

function providerBodyPreview(value: unknown): string | undefined {
	const text = stringValue(value);
	if (!text) {
		return undefined;
	}
	const codePoints = Array.from(text);
	if (codePoints.length >= 240 && !text.endsWith(readBodyTrimEllipsis)) {
		return `${text.trimEnd()}${readBodyTrimEllipsis}`;
	}
	return text;
}

function trimProviderActivityBodyPreviewsForBudget(
	activities: Record<string, unknown>[],
	tokenBudget: number,
	payloadForActivities: (items: Record<string, unknown>[]) => unknown,
): void {
	const budget = Math.max(1, Math.floor(tokenBudget));
	if (providerJsonTokenEstimate(payloadForActivities(activities)) <= budget) {
		return;
	}
	const candidates = providerBodyPreviewTrimCandidates(activities);
	if (candidates.length === 0) {
		return;
	}
	const maxLength = Math.max(...candidates.map((candidate) => candidate.codePoints.length));
	let low = 0;
	let high = Math.max(0, maxLength - 2);
	let bestCutoff: number | null = null;
	while (low <= high) {
		const cutoff = Math.floor((low + high) / 2);
		applyProviderBodyPreviewCutoff(candidates, cutoff);
		const tokenEstimate = providerJsonTokenEstimate(payloadForActivities(activities));
		if (tokenEstimate <= budget) {
			bestCutoff = cutoff;
			low = cutoff + 1;
		} else {
			high = cutoff - 1;
		}
	}
	applyProviderBodyPreviewCutoff(candidates, bestCutoff ?? 0);
}

function providerBodyPreviewTrimCandidates(
	value: unknown,
): Array<{ record: Record<string, unknown>; bodyPreview: string; codePoints: string[] }> {
	const candidates: Array<{ record: Record<string, unknown>; bodyPreview: string; codePoints: string[] }> = [];
	const visit = (item: unknown): void => {
		if (Array.isArray(item)) {
			for (const child of item) {
				visit(child);
			}
			return;
		}
		const record = runtimeRecord(item);
		if (Object.keys(record).length === 0) {
			return;
		}
		const bodyPreview = stringValue(record.bodyPreview);
		if (bodyPreview) {
			const codePoints = Array.from(bodyPreview);
			if (codePoints.length > 1) {
				candidates.push({ record, bodyPreview, codePoints });
			}
		}
		for (const child of Object.values(record)) {
			visit(child);
		}
	};
	visit(value);
	return candidates;
}

function applyProviderBodyPreviewCutoff(
	candidates: Array<{ record: Record<string, unknown>; bodyPreview: string; codePoints: string[] }>,
	cutoff: number,
): void {
	for (const candidate of candidates) {
		if (candidate.codePoints.length > cutoff) {
			const prefix = candidate.codePoints.slice(0, cutoff).join('').trimEnd();
			candidate.record.bodyPreview = `${prefix}${readBodyTrimEllipsis}`;
		} else {
			candidate.record.bodyPreview = candidate.bodyPreview;
		}
	}
}

export function providerSafeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(providerSafeJsonValue);
	}
	if (!value || typeof value !== 'object') {
		return value;
	}
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const safeKey = providerSafeKey(key);
		if (!safeKey) {
			continue;
		}
		if (providerTimestampKey(safeKey)) {
			output[safeKey] = providerRelativeTime(item) ?? providerSafeJsonValue(item);
		} else {
			output[safeKey] = providerSafeJsonValue(item);
		}
	}
	return output;
}

function providerTimestampKey(key: string): boolean {
	return /(?:At|_at)$/.test(key);
}

const providerPrivateJsonKeys = new Set([
	'createdbyuserid',
	'owneruserid',
	'password',
	'secret',
	'session',
	'sessionid',
	'userid',
]);

const providerCredentialTokenJsonKeys = new Set([
	'accesstoken',
	'apitoken',
	'authtoken',
	'bearertoken',
	'idtoken',
	'refreshtoken',
	'sessiontoken',
	'token',
]);

function providerSafeKey(key: string): string | null {
	const normalized = key.replace(/[_-]/g, '').toLowerCase();
	if (
		providerPrivateJsonKeys.has(normalized) ||
		providerCredentialTokenJsonKeys.has(normalized) ||
		normalized.endsWith('apikey') ||
		normalized.endsWith('secret')
	) {
		return null;
	}
	return key;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function providerReadCommentTreeTokenBudget(remainingLoopTokens: number): number {
	return Math.max(1, Math.floor(Math.max(0, remainingLoopTokens) / 4));
}

export function readContentItemTree(content: ReadContentItem[]): ReadContentItem[] {
	const byId = new Map<string, ReadContentItem>();
	const ordered = content.map((item) => {
		const node: ReadContentItem = { ...item };
		delete node.replies;
		byId.set(node.id, node);
		return node;
	});
	const roots: ReadContentItem[] = [];
	for (const node of ordered) {
		const parent = node.parentCommentId ? byId.get(node.parentCommentId) : undefined;
		if (parent && parent !== node) {
			pushReadContentReply(parent, node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

export function pruneReadContentTreeForProviderBudget(
	content: ReadContentItem[],
	tokenBudget: number,
	self: ProviderSelfParticipant,
): ReadPruneResult {
	const pruned = cloneReadContentTree(content);
	const protectedParentIds = protectedReadReplyParentIds(pruned);
	const protectedBodyIds = protectedReadBodyIds(pruned);
	let tokenEstimate = providerReadContentTreeTokenEstimate(pruned, self);
	for (;;) {
		if (tokenEstimate <= tokenBudget) {
			break;
		}
		const prunedDepth = deepestPrunableReadReplyDepth(pruned, protectedParentIds);
		if (prunedDepth === null) {
			break;
		}
		pruneReadRepliesAtDepth(pruned, protectedParentIds, prunedDepth);
		const nextEstimate = providerReadContentTreeTokenEstimate(pruned, self);
		if (nextEstimate >= tokenEstimate) {
			tokenEstimate = nextEstimate;
			break;
		}
		tokenEstimate = nextEstimate;
	}
	let trimmedBodyCount = 0;
	if (tokenEstimate > tokenBudget) {
		const trimmed = trimReadContentBodiesForProviderBudget(pruned, protectedBodyIds, tokenBudget, self);
		tokenEstimate = trimmed.tokenEstimate;
		trimmedBodyCount = trimmed.trimmedBodyCount;
	}
	return {
		content: pruned,
		tokenEstimate,
		omittedReplyCount: collapsedReadReplyCount(pruned),
		trimmedBodyCount,
	};
}

function cloneReadContentTree(content: ReadContentItem[]): ReadContentItem[] {
	return content.map((item) => {
		const clone: ReadContentItem = { ...item };
		if (Array.isArray(item.replies)) {
			clone.replies = cloneReadContentTree(item.replies);
		} else if (typeof item.replies !== 'number') {
			delete clone.replies;
		}
		return clone;
	});
}

function protectedReadReplyParentIds(content: ReadContentItem[]): Set<string> {
	const protectedIds = new Set<string>();
	const visit = (items: ReadContentItem[], protectTopLevel: boolean): void => {
		for (const item of items) {
			if (protectTopLevel || item.ancestorOnly || item['My focus is on this comment']) {
				protectedIds.add(item.id);
			}
			if (Array.isArray(item.replies)) {
				visit(item.replies, false);
			}
		}
	};
	visit(content, true);
	return protectedIds;
}

function protectedReadBodyIds(content: ReadContentItem[]): Set<string> {
	const protectedIds = new Set<string>();
	const visit = (items: ReadContentItem[], protectTopLevel: boolean): void => {
		for (const item of items) {
			if (protectTopLevel || item['My focus is on this comment']) {
				protectedIds.add(item.id);
			}
			if (Array.isArray(item.replies)) {
				visit(item.replies, false);
			}
		}
	};
	visit(content, true);
	return protectedIds;
}

const readBodyTrimEllipsis = '…';

function trimReadContentBodiesForProviderBudget(
	content: ReadContentItem[],
	protectedBodyIds: ReadonlySet<string>,
	tokenBudget: number,
	self: ProviderSelfParticipant,
): { tokenEstimate: number; trimmedBodyCount: number } {
	const candidates = readBodyTrimCandidates(content, protectedBodyIds);
	if (candidates.length === 0) {
		return { tokenEstimate: providerReadContentTreeTokenEstimate(content, self), trimmedBodyCount: 0 };
	}
	const maxLength = Math.max(...candidates.map((candidate) => candidate.codePoints.length));
	let low = 0;
	let high = Math.max(0, maxLength - 2);
	let bestCutoff: number | null = null;
	while (low <= high) {
		const cutoff = Math.floor((low + high) / 2);
		applyReadBodyCutoff(candidates, cutoff);
		const tokenEstimate = providerReadContentTreeTokenEstimate(content, self);
		if (tokenEstimate <= tokenBudget) {
			bestCutoff = cutoff;
			low = cutoff + 1;
		} else {
			high = cutoff - 1;
		}
	}
	const cutoff = bestCutoff ?? 0;
	const trimmedBodyCount = applyReadBodyCutoff(candidates, cutoff);
	return { tokenEstimate: providerReadContentTreeTokenEstimate(content, self), trimmedBodyCount };
}

function readBodyTrimCandidates(
	content: ReadContentItem[],
	protectedBodyIds: ReadonlySet<string>,
): Array<{ item: ReadContentItem; body: string; codePoints: string[] }> {
	const candidates: Array<{ item: ReadContentItem; body: string; codePoints: string[] }> = [];
		const visit = (items: ReadContentItem[]): void => {
			for (const item of items) {
				const body = stringValue(item.body) ?? '';
				const codePoints = Array.from(body);
				if (!protectedBodyIds.has(item.id) && codePoints.length > 1) {
					candidates.push({ item, body, codePoints });
				}
				if (Array.isArray(item.replies)) {
				visit(item.replies);
			}
		}
	};
	visit(content);
	return candidates;
}

function applyReadBodyCutoff(candidates: Array<{ item: ReadContentItem; body: string; codePoints: string[] }>, cutoff: number): number {
	let trimmedBodyCount = 0;
	for (const candidate of candidates) {
		if (candidate.codePoints.length > cutoff) {
			const prefix = candidate.codePoints.slice(0, cutoff).join('').trimEnd();
			setReadContentBody(candidate.item, `${prefix}${readBodyTrimEllipsis}`);
			if (stringValue(candidate.item.body) !== candidate.body) {
				trimmedBodyCount += 1;
			}
		} else {
			setReadContentBody(candidate.item, candidate.body);
		}
	}
	return trimmedBodyCount;
}

function setReadContentBody(item: ReadContentItem, body: string): void {
	item.body = item.body && typeof item.body === 'object' && !Array.isArray(item.body)
		? { ...item.body, text: body }
		: body;
}

function deepestPrunableReadReplyDepth(content: ReadContentItem[], protectedParentIds: ReadonlySet<string>, depth = 0): number | null {
	let deepest: number | null = null;
	for (const item of content) {
		const replies = readContentReplies(item);
		if (replies.length === 0) {
			continue;
		}
		if (depth >= 1 && !protectedParentIds.has(item.id)) {
			deepest = Math.max(deepest ?? 0, depth + 1);
		}
		const childDepth = deepestPrunableReadReplyDepth(replies, protectedParentIds, depth + 1);
		if (childDepth !== null) {
			deepest = Math.max(deepest ?? 0, childDepth);
		}
	}
	return deepest;
}

function pruneReadRepliesAtDepth(
	content: ReadContentItem[],
	protectedParentIds: ReadonlySet<string>,
	targetDepth: number,
	depth = 0,
): void {
	for (const item of content) {
		const replies = readContentReplies(item);
		if (replies.length === 0) {
			continue;
		}
		if (depth >= 1 && depth + 1 === targetDepth && !protectedParentIds.has(item.id)) {
			item.replies = replies.length;
			continue;
		}
		pruneReadRepliesAtDepth(replies, protectedParentIds, targetDepth, depth + 1);
	}
}

function collapsedReadReplyCount(content: ReadContentItem[]): number {
	return content.reduce((total, item) => {
		if (typeof item.replies === 'number') {
			return total + item.replies;
		}
		return total + collapsedReadReplyCount(readContentReplies(item));
	}, 0);
}

// The budget estimate renders through the same serializer as emission — including the longer
// `u/<handle> (MYSELF)` label and its standalone fallback. Self-heavy trees may therefore prune at a
// slightly earlier threshold, but the emitted tree still fits the budget computed for it.
function providerReadContentTreeTokenEstimate(content: ReadContentItem[], self: ProviderSelfParticipant): number {
	const providerContent = providerReadContentTree(
		content.map((item) => item as unknown as Record<string, unknown>),
		providerSerializationContext(self),
	);
	return estimateTextTokens(JSON.stringify(providerContent));
}

function readContentReplies(item: ReadContentItem): ReadContentItem[] {
	return Array.isArray(item.replies) ? item.replies : [];
}

function pushReadContentReply(parent: ReadContentItem, reply: ReadContentItem): void {
	const replies = readContentReplies(parent);
	if (!replies.some((existing) => existing.id === reply.id)) {
		replies.push(reply);
	}
	parent.replies = replies;
}

function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) {
		return value.trim();
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const text = (value as { text?: unknown }).text;
		if (typeof text === 'string' && text.trim()) {
			return text.trim();
		}
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return undefined;
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.map(stringValue).filter((item): item is string => Boolean(item)) : [];
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
