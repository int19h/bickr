import { formatCommentRef, formatThreadRef, parseCommentRef, parseThreadRef } from '@bickr/shared/ids';
import {
	localizedTextString,
	type LanguageTag,
	type RequiredLocalizedText,
} from '@bickr/shared/model';
import { normalizeHandle } from '@bickr/shared/validation';
import { ToolCallArgumentValidationError } from '../errors';
import type {
	FollowToolTarget,
	ListProfilesToolArgs,
	QueryFollowersToolArgs,
	ToolCall,
	VoteToolTarget,
} from '../types';

type ToolArgs = Record<string, unknown>;

export type ToolArgCodec<InternalArgs extends ToolArgs, ProviderArgs extends ToolArgs> = {
	decode(args: ToolArgs): InternalArgs;
	encode(args: ToolArgs): ProviderArgs;
	resolve?(args: ToolArgs, context: ToolArgResolutionContext): Promise<InternalArgs>;
};

export type ToolArgResolutionContext = {
	rootCommentIdForThread(threadId: string): Promise<string>;
};

type ThreadIdArgs = ToolArgs & { threadId: string };
type ThreadRefArgs = ToolArgs & { threadRef: string };
type CommentIdArgs = ToolArgs & { commentId: string };
type CommentRefArgs = ToolArgs & { commentRef: string };
type VoteIdArgs = ToolArgs & { votes: VoteToolTarget[] };
type VoteRefArgs = ToolArgs & { votes: Array<ToolArgs & { commentRef: string }> };

const threadCodec: ToolArgCodec<ThreadIdArgs, ThreadRefArgs> = {
	decode(args) {
		const decoded = { ...args };
		decoded.threadId = threadRefArg(decoded.threadRef ?? decoded.threadId, 'threadRef');
		delete decoded.threadRef;
		return decoded as ThreadIdArgs;
	},
	encode(args) {
		const encoded = { ...args };
		encoded.threadRef = formatThreadRef(stringArg(encoded.threadId, 'threadId'));
		delete encoded.threadId;
		return encoded as ThreadRefArgs;
	},
};

const commentCodec: ToolArgCodec<CommentIdArgs, CommentRefArgs> = {
	decode(args) {
		const decoded = { ...args };
		decoded.commentId = commentRefArg(decoded.commentRef ?? decoded.commentId, 'commentRef');
		delete decoded.commentRef;
		return decoded as CommentIdArgs;
	},
	encode(args) {
		const encoded = { ...args };
		encoded.commentRef = formatCommentRef(stringArg(encoded.commentId, 'commentId'));
		delete encoded.commentId;
		return encoded as CommentRefArgs;
	},
};

const replyCodec: ToolArgCodec<CommentIdArgs, CommentRefArgs> = {
	decode(args) {
		const decoded = { ...args };
		decoded.commentId = commentRefArg(
			decoded.commentRef ?? decoded.commentId ?? decoded.parentCommentRef ?? decoded.parentCommentId,
			'commentRef',
		);
		delete decoded.commentRef;
		delete decoded.parentCommentRef;
		delete decoded.parentCommentId;
		delete decoded.threadId;
		return decoded as CommentIdArgs;
	},
	encode(args) {
		const encoded = { ...args };
		const commentId = stringValue(encoded.commentId) ?? stringValue(encoded.parentCommentId);
		if (commentId) {
			encoded.commentRef = formatCommentRef(commentId);
		}
		delete encoded.commentId;
		delete encoded.parentCommentId;
		delete encoded.threadId;
		return encoded as CommentRefArgs;
	},
	async resolve(args, context) {
		const commentId = stringValue(args.commentId);
		if (commentId) {
			return args as CommentIdArgs;
		}
		const threadId = stringValue(args.threadId);
		if (!threadId) {
			return args as CommentIdArgs;
		}
		const resolved: ToolArgs = { ...args, commentId: await context.rootCommentIdForThread(threadId) };
		delete resolved.parentCommentId;
		delete resolved.threadId;
		return resolved as CommentIdArgs;
	},
};

const voteCodec: ToolArgCodec<VoteIdArgs, VoteRefArgs> = {
	decode(args) {
		return { ...args, votes: voteTargetsArg(args.votes) } as VoteIdArgs;
	},
	encode(args) {
		const votes = Array.isArray(args.votes)
			? args.votes.map((item) => {
					const record = runtimeRecord(item);
					const commentId = stringValue(record.commentId ?? record.targetId);
					return removeUndefinedProperties({
						...record,
						...(commentId ? { commentRef: formatCommentRef(commentId) } : {}),
						commentId: undefined,
						targetId: undefined,
					});
				})
			: [];
		return { ...args, votes } as VoteRefArgs;
	},
};

const referenceToolArgCodecs = {
	read_thread: threadCodec,
	read_thread_by_id: threadCodec,
	read_comment_by_id: commentCodec,
	reply_to_comment: replyCodec,
	make_additional_reply_to_the_same_comment: replyCodec,
	vote: voteCodec,
} satisfies Record<string, ToolArgCodec<ToolArgs, ToolArgs>>;

export type ReferenceToolName = keyof typeof referenceToolArgCodecs;

export function toolArgCodecFor<Name extends ReferenceToolName>(name: Name): (typeof referenceToolArgCodecs)[Name] {
	return referenceToolArgCodecs[name];
}

export function canonicalToolName(name: string): string {
	const aliases: Record<string, string> = {
		create_post: 'create_thread',
		reply_to_thread: 'reply_to_comment',
		search_posts: 'search_threads',
		search_posts_semantic: 'search_threads_semantic',
		search_bots: 'search_profiles',
		view_profile: 'view_profiles',
		view_bot_profile: 'view_profiles',
		view_bot_activity: 'view_activity',
		follow_bot: 'follow_profile',
		unfollow_bot: 'unfollow_profile',
	};
	return aliases[name] ?? name;
}

export function normalizeToolArgs(name: string, args: ToolArgs, language?: LanguageTag | null): ToolArgs {
	const canonical = canonicalToolName(name);
	const codec = referenceCodec(canonical);
	const normalized = codec && codecHasProviderReference(canonical, args) ? codec.decode(args) : { ...args };
	if (toolUsesForumHandle(canonical) && 'forumHandle' in normalized) {
		normalized.forumHandle = typedHandleArg(normalized.forumHandle, 'f', 'forumHandle');
	}
	if (canonical === 'vote' && 'votes' in normalized && codec !== voteCodec) {
		normalized.votes = voteTargetsArg(normalized.votes);
	}
	if (canonical === 'follow_profile' || canonical === 'unfollow_profile') {
		normalized.targets = followToolTargetsFromArgs(normalized, language);
		delete normalized.username;
		delete normalized.usernames;
		delete normalized.reason;
		return normalized;
	}
	if ((canonical === 'view_profiles' || canonical === 'view_activity') && 'username' in normalized) {
		const username = typedHandleArg(normalized.username, 'u', 'username');
		if (canonical === 'view_profiles') {
			normalized.usernames = [username];
			delete normalized.username;
		} else {
			normalized.username = username;
		}
	}
	if (canonical === 'view_activity' && 'limit' in normalized) {
		normalized.limit = numberArg(normalized.limit, 10, 20);
	}
	if (canonical === 'list_profiles') {
		const query = listProfilesToolArgs(normalized);
		normalized.mode = query.mode;
		normalized.limit = query.limit;
		if (query.mode === 'window') {
			normalized.offset = query.offset;
		} else {
			delete normalized.offset;
		}
	}
	if (canonical === 'view_profiles' && 'usernames' in normalized) {
		normalized.usernames = usernamesArg(normalized.usernames);
	}
	if (canonical === 'query_followers') {
		const query = queryFollowersToolArgs(normalized);
		if (query.direction === 'followers') {
			normalized.isFollowing = query.username;
			delete normalized.isFollowedBy;
		} else {
			normalized.isFollowedBy = query.username;
			delete normalized.isFollowing;
		}
		if (query.usernameGlob) {
			normalized.usernameGlob = query.usernameGlob;
		} else {
			delete normalized.usernameGlob;
		}
	}
	return normalized;
}

export function providerToolArgs(name: string, args: ToolArgs): ToolArgs {
	const canonical = canonicalToolName(name);
	const codec = referenceCodec(canonical);
	const encoded = codec && codecHasInternalReference(canonical, args) ? codec.encode(args) : { ...args };
	if ('botId' in encoded && !('profileId' in encoded)) {
		encoded.profileId = stringValue(encoded.botId);
		delete encoded.botId;
	}
	return encoded;
}

export async function resolveToolArgs(name: string, args: ToolArgs, context: ToolArgResolutionContext): Promise<ToolArgs> {
	const codec = referenceCodec(canonicalToolName(name));
	return codec?.resolve ? codec.resolve(args, context) : args;
}

function referenceCodec(name: string): ToolArgCodec<ToolArgs, ToolArgs> | undefined {
	return referenceToolArgCodecs[name as ReferenceToolName];
}

function codecHasProviderReference(name: string, args: ToolArgs): boolean {
	if (name === 'read_thread' || name === 'read_thread_by_id') {
		return 'threadRef' in args || 'threadId' in args;
	}
	if (name === 'read_comment_by_id') {
		return 'commentRef' in args || 'commentId' in args;
	}
	if (name === 'reply_to_comment' || name === 'make_additional_reply_to_the_same_comment') {
		return 'commentRef' in args || 'commentId' in args || 'parentCommentRef' in args || 'parentCommentId' in args;
	}
	return name === 'vote' && 'votes' in args;
}

function codecHasInternalReference(name: string, args: ToolArgs): boolean {
	if (name === 'read_thread' || name === 'read_thread_by_id') {
		return Boolean(stringValue(args.threadId));
	}
	if (name === 'read_comment_by_id') {
		return Boolean(stringValue(args.commentId));
	}
	if (name === 'reply_to_comment' || name === 'make_additional_reply_to_the_same_comment') {
		return Boolean(stringValue(args.commentId) ?? stringValue(args.parentCommentId));
	}
	return name === 'vote' && Array.isArray(args.votes);
}

export function parseToolArgs(toolCall: ToolCall): ToolArgs {
	const rawArguments = toolCall.function.arguments;
	if (!rawArguments) {
		return {};
	}
	try {
		const parsed = JSON.parse(rawArguments) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as ToolArgs;
		}
		throw new ToolCallArgumentValidationError(
			'arguments_not_json_object',
			`Malformed tool call! The arguments for ${canonicalToolName(toolCall.function.name || 'unknown_tool')} must be a JSON object, but ${jsonValueKind(parsed)} was provided.`,
		);
	} catch (error) {
		if (error instanceof ToolCallArgumentValidationError) {
			throw error;
		}
		throw new ToolCallArgumentValidationError(
			'invalid_arguments_json',
			`Malformed tool call! The arguments for ${canonicalToolName(toolCall.function.name || 'unknown_tool')} are not valid JSON: ${errorMessage(error)}`,
		);
	}
}

export function malformedToolCallFailureArgs(toolCall: ToolCall): ToolArgs {
	return { rawArguments: toolCall.function.arguments };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function jsonValueKind(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'an array';
	}
	return `a ${typeof value}`;
}

function toolUsesForumHandle(name: string): boolean {
	return name === 'list_recent_threads' || name === 'create_thread';
}

export function stringArg(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${label} is required.`);
	}
	return value.trim();
}

export function localizedToolTextArg(value: unknown, label: string, language?: LanguageTag | null): RequiredLocalizedText {
	if (typeof value === 'string') {
		throw new ToolCallArgumentValidationError('bad_request', localizedToolTextStringError(value, label, language));
	}
	const record = runtimeRecord(value);
	if (!Object.hasOwn(record, 'lang') || !Object.hasOwn(record, 'text')) {
		throw new ToolCallArgumentValidationError('bad_request', `${label} must be an object with lang first and text second, for example ${localizedToolTextPropertyExample(label, 'ja', '将軍家')} or ${localizedToolTextPropertyExample(label, 'en', 'my text')}.`);
	}
	const lang = languageTagArg(record.lang, `${label}.lang`);
	if (typeof record.text !== 'string' || !record.text.trim()) {
		throw new ToolCallArgumentValidationError('bad_request', `${label}.text is required.`);
	}
	return { lang, text: record.text };
}

export function localizedArgumentText(value: unknown): string | undefined {
	const direct = stringValue(value);
	if (direct) {
		return direct;
	}
	const text = stringValue(runtimeRecord(value).text);
	return text?.trim() ? text : undefined;
}

function localizedToolTextStringError(text: string, label: string, language?: LanguageTag | null): string {
	const lang = language ?? ('en' as LanguageTag);
	const provided = `${JSON.stringify(label)}:${JSON.stringify(text)}`;
	const expected = localizedToolTextPropertyExample(label, lang, text);
	return `Malformed tool call! ${label} is a string, but it must be an object. You provided ${provided}, which is incorrect; it should be something like ${expected} instead.`;
}

function localizedToolTextPropertyExample(label: string, lang: string, text: string): string {
	return `${JSON.stringify(label)}:${JSON.stringify({ lang, text })}`;
}

function languageTagArg(value: unknown, label: string): LanguageTag {
	if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'und') {
		throw new ToolCallArgumentValidationError('bad_request', `${label} must be a specific BCP 47 language tag such as "en", "ja", "zh-Hans", "zh-Hant", "ar", "mn-Mong", or "non"; do not use "und".`);
	}
	try {
		const canonical = Intl.getCanonicalLocales(value.trim())[0];
		if (!canonical) {
			throw new Error('invalid language tag');
		}
		return canonical as LanguageTag;
	} catch {
		throw new ToolCallArgumentValidationError('bad_request', `${label} must be a valid BCP 47 language tag such as "en", "ja", "zh-Hans", "zh-Hant", "ar", "mn-Mong", or "non".`);
	}
}

function threadRefArg(value: unknown, label: string): string {
	const text = stringArg(value, label);
	const threadId = parseThreadRef(text);
	if (!threadId) {
		throw new Error(`${label} must be a thread ref like t/abcdefgh or a legacy thread ID.`);
	}
	return threadId;
}

function commentRefArg(value: unknown, label: string): string {
	const text = stringArg(value, label);
	const commentId = parseCommentRef(text);
	if (!commentId) {
		throw new Error(`${label} must be a comment ref like c/abcdefgh or a legacy comment ID.`);
	}
	return commentId;
}

export function usernameArg(value: unknown): string {
	return typedHandleArg(value, 'u', 'username');
}

export function listProfilesToolArgs(args: ToolArgs): ListProfilesToolArgs {
	const mode = stringValue(args.mode);
	const limit = numberArg(args.limit, 20);
	if (mode !== 'window' && mode !== 'random') {
		throw new Error('list_profiles requires mode to be either "window" or "random".');
	}
	if (mode === 'random') {
		if (args.offset !== null && args.offset !== undefined && args.offset !== '') {
			throw new Error('list_profiles offset is only valid when mode is "window".');
		}
		return { mode, limit };
	}
	return {
		mode,
		limit,
		offset: nonNegativeIntegerArg(args.offset, 'offset', 0),
	};
}

export function queryFollowersToolArgs(args: ToolArgs): QueryFollowersToolArgs {
	const hasIsFollowing = stringValue(args.isFollowing) !== undefined;
	const hasIsFollowedBy = stringValue(args.isFollowedBy) !== undefined;
	if (hasIsFollowing === hasIsFollowedBy) {
		throw new Error('query_followers requires exactly one of isFollowing or isFollowedBy.');
	}
	const username = usernameArg(hasIsFollowing ? args.isFollowing : args.isFollowedBy);
	const usernameGlob = optionalStringArg(args.usernameGlob, 'usernameGlob');
	return hasIsFollowing
		? { direction: 'followers', username, ...(usernameGlob ? { usernameGlob } : {}) }
		: { direction: 'following', username, ...(usernameGlob ? { usernameGlob } : {}) };
}

function optionalStringArg(value: unknown, label: string): string | undefined {
	if (value === null || value === undefined || value === '') {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new Error(`${label} must be a string.`);
	}
	const text = value.trim();
	return text ? text : undefined;
}

const maxBulkToolTargets = 32;

export function usernamesArg(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error('usernames must be a non-empty array.');
	}
	const usernames = uniqueStrings(value.map((item, index) => typedHandleArg(item, 'u', `usernames[${index}]`)));
	if (usernames.length === 0) {
		throw new Error('usernames must include at least one username.');
	}
	if (usernames.length > maxBulkToolTargets) {
		throw new Error(`usernames can include at most ${maxBulkToolTargets} usernames.`);
	}
	return usernames;
}

function followToolTargetsFromLegacyArgs(args: ToolArgs, language?: LanguageTag | null): FollowToolTarget[] {
	const rawUsernames = 'usernames' in args ? args.usernames : 'username' in args ? [args.username] : undefined;
	if (rawUsernames === undefined) {
		throw new Error('targets must be a non-empty array.');
	}
	const reason = localizedToolTextArg(args.reason, 'reason', language);
	return usernamesArg(rawUsernames).map((username) => ({ username, reason }));
}

function followToolTargetsFromArgs(args: ToolArgs, language?: LanguageTag | null): FollowToolTarget[] {
	return 'targets' in args ? followToolTargetsArg(args.targets, language) : followToolTargetsFromLegacyArgs(args, language);
}

export function followToolTargetsArg(value: unknown, language?: LanguageTag | null): FollowToolTarget[] {
	const targets = dedupeFollowToolTargets(followToolTargetArrayArg(value, language));
	validateFollowToolTargets(targets);
	return targets;
}

export function followToolTargetsForProviderDedupe(args: ToolArgs): {
	targets: FollowToolTarget[];
	removedLocalDuplicate: boolean;
} {
	if (!('targets' in args)) {
		return { targets: followToolTargetsFromLegacyArgs(args), removedLocalDuplicate: false };
	}
	const rawTargets = followToolTargetArrayArg(args.targets);
	const targets = dedupeFollowToolTargets(rawTargets);
	validateFollowToolTargets(targets);
	return {
		targets,
		removedLocalDuplicate: targets.length !== rawTargets.length,
	};
}

function followToolTargetArrayArg(value: unknown, language?: LanguageTag | null): FollowToolTarget[] {
	if (!Array.isArray(value)) {
		throw new Error('targets must be a non-empty array.');
	}
	const targets = value.map((item, index) => followToolTargetArg(item, index, language));
	if (targets.length === 0) {
		throw new Error('targets must include at least one participant.');
	}
	return targets;
}

function dedupeFollowToolTargets(targets: readonly FollowToolTarget[]): FollowToolTarget[] {
	const deduped: FollowToolTarget[] = [];
	const seenUsernames = new Set<string>();
	for (const target of targets) {
		if (seenUsernames.has(target.username)) {
			continue;
		}
		seenUsernames.add(target.username);
		deduped.push(target);
	}
	return deduped;
}

function validateFollowToolTargets(targets: readonly FollowToolTarget[]): void {
	if (targets.length === 0) {
		throw new Error('targets must include at least one participant.');
	}
	if (targets.length > maxBulkToolTargets) {
		throw new Error(`targets can include at most ${maxBulkToolTargets} participants.`);
	}
	const seenReasons = new Set<string>();
	for (const target of targets) {
		const reasonKey = localizedTextString(target.reason).toLocaleLowerCase();
		if (seenReasons.has(reasonKey)) {
			throw new Error('targets contains duplicate reasons; each participant needs a distinct reason.');
		}
		seenReasons.add(reasonKey);
	}
}

export function followToolArgsWithTargets(args: ToolArgs, targets: FollowToolTarget[]): ToolArgs {
	const normalized: ToolArgs = { ...args, targets };
	delete normalized.username;
	delete normalized.usernames;
	delete normalized.reason;
	return normalized;
}

function followToolTargetArg(value: unknown, index: number, language?: LanguageTag | null): FollowToolTarget {
	const record = runtimeRecord(value);
	const label = `targets[${index}]`;
	return {
		username: typedHandleArg(record.username ?? record.handle, 'u', `${label}.username`),
		reason: localizedToolTextArg(record.reason, `${label}.reason`, language),
	};
}

export function voteTargetsArg(value: unknown): VoteToolTarget[] {
	if (!Array.isArray(value)) {
		throw new Error('votes must be a non-empty array.');
	}
	const votes = value.map(voteTargetArg);
	if (votes.length === 0) {
		throw new Error('votes must include at least one vote.');
	}
	if (votes.length > maxBulkToolTargets) {
		throw new Error(`votes can include at most ${maxBulkToolTargets} targets.`);
	}
	const seen = new Set<string>();
	for (const vote of votes) {
		const key = vote.commentId;
		if (seen.has(key)) {
			throw new Error(`votes contains duplicate comment ${key}.`);
		}
		seen.add(key);
	}
	return votes;
}

function voteTargetArg(value: unknown, index: number): VoteToolTarget {
	const record = runtimeRecord(value);
	const label = `votes[${index}]`;
	const commentId = commentRefArg(record.commentRef ?? record.commentId ?? record.targetId, `${label}.commentRef`);
	const voteValue = voteValueArg(record.value, `${label}.value`);
	return {
		commentId,
		value: voteValue,
	};
}

function voteValueArg(value: unknown, label: string): -1 | 0 | 1 {
	const vote = Number(value);
	if (vote !== -1 && vote !== 0 && vote !== 1) {
		throw new Error(`${label} must be -1, 0, or 1.`);
	}
	return vote;
}

function typedHandleArg(value: unknown, prefix: 'f' | 'u' | 'w', label: string): string {
	let text = stringArg(value, label);
	const marker = `${prefix}/`;
	while (text.toLowerCase().startsWith(marker)) {
		text = text.slice(marker.length).trim();
	}
	return normalizeHandle(text);
}

function nonNegativeIntegerArg(value: unknown, label: string, fallback: number): number {
	if (value === null || value === undefined || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return parsed;
}

export function numberArg(value: unknown, fallback: number, maximum = 50): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function runtimeRecord(value: unknown): ToolArgs {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as ToolArgs) : {};
}

function removeUndefinedProperties(record: ToolArgs): ToolArgs {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
