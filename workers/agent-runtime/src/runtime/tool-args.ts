import { participantListLimits } from '@bickr/shared/content-limits';
import { agentIssue, type AgentIssue } from '../localization/issues';
import { formatCommentRef, formatThreadRef, parseCommentRef, parseThreadRef } from '@bickr/shared/ids';
import {
	localizedTextString,
	type LanguageTag,
	type RequiredLocalizedText,
} from '@bickr/shared/model';
import { InputError, normalizeHandle } from '@bickr/shared/validation';
import { maxBulkToolTargets, providerSelfAuthor } from '../constants';
import { ToolCallArgumentValidationError } from '../errors';
import { validateRandomRanges, type RandomRangeTarget } from './random-integers';
import type {
	FollowToolTarget,
	ListProfilesToolArgs,
	QueryFollowersToolArgs,
	ToolCall,
	VoteToolTarget,
} from '../types';

type ToolArgs = Record<string, unknown>;

export type ToolArgumentRepair = {
	reason: 'leaked_argument_fragment';
	field: 'body.text' | 'title' | 'title.text';
	leakedArgumentKey: string;
	removedSuffix: string;
};

export type ParsedToolArgs = {
	args: ToolArgs;
	repairs: ToolArgumentRepair[];
};

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
		normalized.limit = numberArg(normalized.limit, participantListLimits.defaultActivity, participantListLimits.maximumActivity);
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
	if (canonical === 'draw_random_integers') {
		normalized.ranges = randomRangesArg(normalized.ranges);
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
	return parseToolArgsWithDiagnostics(toolCall).args;
}

export function parseToolArgsWithDiagnostics(toolCall: ToolCall): ParsedToolArgs {
	const rawArguments = toolCall.function.arguments;
	if (!rawArguments) {
		return { args: {}, repairs: [] };
	}
	try {
		const parsed = JSON.parse(rawArguments) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return repairLeakedPostingArgumentFragments(toolCall.function.name, parsed as ToolArgs);
		}
		throw new ToolCallArgumentValidationError(
			'arguments_not_json_object',
			agentIssue(`issue.args.notObject.${jsonArgumentKind(parsed)}`, { toolName: canonicalToolName(toolCall.function.name || 'unknown_tool') }),
		);
	} catch (error) {
		if (error instanceof ToolCallArgumentValidationError) {
			throw error;
		}
		throw new ToolCallArgumentValidationError(
			'invalid_arguments_json',
			agentIssue("issue.args.invalidJson", { toolName: canonicalToolName(toolCall.function.name || 'unknown_tool') }),
			{ cause: error },
		);
	}
}

function repairLeakedPostingArgumentFragments(name: string, args: ToolArgs): ParsedToolArgs {
	const canonical = canonicalToolName(name);
	if (canonical !== 'create_thread' && canonical !== 'reply_to_comment' && canonical !== 'make_additional_reply_to_the_same_comment') {
		return { args, repairs: [] };
	}

	let repairedArgs = args;
	const repairs: ToolArgumentRepair[] = [];
	for (const containerKey of ['body', 'title'] as const) {
		const container = args[containerKey];
		const candidate =
			containerKey === 'title' && typeof container === 'string'
				? { field: 'title' as const, text: container }
				: container && typeof container === 'object' && !Array.isArray(container) && typeof (container as ToolArgs).text === 'string'
					? { field: `${containerKey}.text` as 'body.text' | 'title.text', text: (container as ToolArgs).text as string }
					: null;
		if (!candidate) {
			continue;
		}
		const leak = trailingArgumentFragment(candidate.text, Object.keys(args).filter((key) => key !== containerKey));
		if (!leak) {
			continue;
		}
		const text = candidate.text.slice(0, leak.index).trimEnd();
		if (typeof container === 'string') {
			repairedArgs = { ...repairedArgs, [containerKey]: text };
		} else {
			repairedArgs = { ...repairedArgs, [containerKey]: { ...(container as ToolArgs), text } };
		}
		repairs.push({
			reason: 'leaked_argument_fragment',
			field: candidate.field,
			leakedArgumentKey: leak.argumentKey,
			removedSuffix: candidate.text.slice(leak.index),
		});
	}
	return { args: repairedArgs, repairs };
}

function trailingArgumentFragment(text: string, remainingArgumentKeys: readonly string[]): { argumentKey: string; index: number } | null {
	const match = /"\s*\}\s*,\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*$/u.exec(text);
	if (!match || match.index === undefined) {
		return null;
	}
	const argumentKey = match[1] ?? match[2] ?? '';
	return remainingArgumentKeys.includes(argumentKey) ? { argumentKey, index: match.index } : null;
}

export function malformedToolCallFailureArgs(toolCall: ToolCall): ToolArgs {
	return { rawArguments: toolCall.function.arguments };
}

function jsonArgumentKind(value: unknown): 'array' | 'null' | 'string' | 'number' | 'boolean' {
 if (Array.isArray(value)) return 'array';
 if (value === null) return 'null';
 const kind = typeof value;
 if (kind === 'string' || kind === 'number' || kind === 'boolean') return kind;
 throw new Error('Unexpected non-object JSON argument type.');
}


function toolUsesForumHandle(name: string): boolean {
	return name === 'list_recent_threads' || name === 'create_thread';
}

export function stringArg(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.requiredString", { argument: label }));
	}
	return value.trim();
}

export function localizedToolTextArg(value: unknown, label: string, language?: LanguageTag | null): RequiredLocalizedText {
	if (typeof value === 'string') {
		throw new ToolCallArgumentValidationError('bad_request', localizedToolTextStringError(value, label, language));
	}
	const record = runtimeRecord(value);
	if (!Object.hasOwn(record, 'lang') || !Object.hasOwn(record, 'text')) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.localizedObject", { argument: label, exampleJapanese: localizedToolTextValueExample('ja', '将軍家'), exampleEnglish: localizedToolTextValueExample('en', 'my text') }));
	}
	const lang = languageTagArg(record.lang, `${label}.lang`);
	if (typeof record.text !== 'string' || !record.text.trim()) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.localizedTextEmpty", { argument: label }));
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

function localizedToolTextStringError(text: string, label: string, language?: LanguageTag | null): AgentIssue {
	const lang = language ?? ('en' as LanguageTag);
	const provided = JSON.stringify(text);
	const expected = localizedToolTextValueExample(lang, text);
	return agentIssue("issue.args.localizedObjectSentAsString", { argument: label, provided: provided, expected: expected });
}

function localizedToolTextValueExample(lang: string, text: string): string {
	return JSON.stringify({ lang, text });
}

function languageTagArg(value: unknown, label: string): LanguageTag {
	if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'und') {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.languageSpecific", { argument: label }));
	}
	try {
		const canonical = Intl.getCanonicalLocales(value.trim())[0];
		if (!canonical) {
			throw new Error('invalid language tag');
		}
		return canonical as LanguageTag;
	} catch {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.languageInvalid", { argument: label }));
	}
}

function threadRefArg(value: unknown, label: string): string {
	const text = stringArg(value, label);
	const threadId = parseThreadRef(text);
	if (!threadId) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.threadReference", { argument: label }));
	}
	return threadId;
}

function commentRefArg(value: unknown, label: string): string {
	const text = stringArg(value, label);
	const commentId = parseCommentRef(text);
	if (!commentId) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.commentReference", { argument: label }));
	}
	return commentId;
}

export function usernameArg(value: unknown): string {
	return typedHandleArg(value, 'u', 'username');
}

export function listProfilesToolArgs(args: ToolArgs): ListProfilesToolArgs {
	const mode = stringValue(args.mode);
	const limit = numberArg(args.limit, participantListLimits.defaultProfiles, participantListLimits.maximumProfiles);
	if (mode !== 'window' && mode !== 'random') {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.profilesMode", {  }));
	}
	if (mode === 'random') {
		if (args.offset !== null && args.offset !== undefined && args.offset !== '') {
			throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.profilesRandomOffset", {  }));
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
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.followersDirection", {  }));
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
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.optionalString", { argument: label }));
	}
	const text = value.trim();
	return text ? text : undefined;
}

export function usernamesArg(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.usernamesArray", {  }));
	}
	const usernames = uniqueStrings(value.map((item, index) => typedHandleArg(item, 'u', `usernames[${index}]`)));
	if (usernames.length === 0) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.usernamesEmpty", {  }));
	}
	if (usernames.length > maxBulkToolTargets) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.usernamesLimit", { max: maxBulkToolTargets }));
	}
	return usernames;
}

function followToolTargetsFromLegacyArgs(args: ToolArgs, language?: LanguageTag | null): FollowToolTarget[] {
	const rawUsernames = 'usernames' in args ? args.usernames : 'username' in args ? [args.username] : undefined;
	if (rawUsernames === undefined) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.followTargetsArray", {  }));
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
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.followTargetsArray", {  }));
	}
	const targets = value.map((item, index) => followToolTargetArg(item, index, language));
	if (targets.length === 0) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.followTargetsEmpty", {  }));
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
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.followTargetsEmpty", {  }));
	}
	if (targets.length > maxBulkToolTargets) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.followTargetsLimit", { max: maxBulkToolTargets }));
	}
	const seenReasons = new Set<string>();
	for (const target of targets) {
		const reasonKey = localizedTextString(target.reason).toLocaleLowerCase();
		if (seenReasons.has(reasonKey)) {
			throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.followReasonsDuplicate", {  }));
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

/**
 * Canonicalizes the `ranges` argument to the array form the schema asks for. A
 * single range object is a declared, supported shape, so it is wrapped here
 * rather than rejected; everything downstream sees `RandomRangeTarget[]` and
 * never has to re-inspect the union.
 *
 * Some models send the argument as a JSON-encoded string instead of the JSON
 * value itself, such as `"[{\"min\":1,\"max\":6}]"`. That string is decoded
 * exactly once and the decoded value then goes through the same checks as a
 * value that arrived directly. A string that decodes to another string is not
 * decoded again, and endpoint strings inside the decoded value are still
 * rejected, so the relaxation stops at the outer encoding.
 */
export function randomRangesArg(value: unknown): RandomRangeTarget[] {
	if (value === null || value === undefined) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.rangesRequired", {  }));
	}
	const decoded = typeof value === 'string' ? decodedRandomRangesArg(value) : value;
	const items = Array.isArray(decoded) ? decoded : [decoded];
	const ranges = items.map((item, index) => randomRangeArg(item, `ranges[${index}]`));
	validateRandomRanges(ranges);
	return ranges;
}

function decodedRandomRangesArg(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new ToolCallArgumentValidationError(
			'bad_request',
			agentIssue("issue.args.rangesInvalidJson", {  }),
		);
	}
}

/**
 * Whether the argument as it arrived already is the canonical form, so a caller
 * can tell when replayed history has to be rewritten. Normalization changes the
 * argument in more ways than the singular-to-array wrap: a range that carried
 * extra properties is rebuilt as exactly min and max, and only a structural
 * comparison against the canonical ranges catches that.
 */
export function randomRangesArgIsCanonical(value: unknown, ranges: readonly RandomRangeTarget[]): boolean {
	if (!Array.isArray(value) || value.length !== ranges.length) {
		return false;
	}
	return value.every((item, index) => {
		const range = ranges[index];
		if (!range || !item || typeof item !== 'object' || Array.isArray(item)) {
			return false;
		}
		const record = item as ToolArgs;
		return Object.keys(record).length === 2 && record.min === range.min && record.max === range.max;
	});
}

function randomRangeArg(value: unknown, label: string): RandomRangeTarget {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ToolCallArgumentValidationError(
			'bad_request',
			agentIssue("issue.args.rangeObject", { argument: label }),
		);
	}
	const record = value as ToolArgs;
	return {
		min: randomRangeEndpointArg(record.min, `${label}.min`),
		max: randomRangeEndpointArg(record.max, `${label}.max`),
	};
}

/**
 * Endpoints are taken literally: no string coercion and no rounding, so a
 * participant that sends "1" or 1.5 is told to send a whole number instead of
 * quietly getting a draw it did not ask for.
 */
function randomRangeEndpointArg(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new ToolCallArgumentValidationError(
			'bad_request',
			agentIssue("issue.args.rangeEndpoint", { argument: label, min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
		);
	}
	return value;
}

export function voteTargetsArg(value: unknown): VoteToolTarget[] {
	if (!Array.isArray(value)) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.votesArray", {  }));
	}
	const votes = value.map(voteTargetArg);
	if (votes.length === 0) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.votesEmpty", {  }));
	}
	if (votes.length > maxBulkToolTargets) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.votesLimit", { max: maxBulkToolTargets }));
	}
	const seen = new Set<string>();
	for (const vote of votes) {
		const key = vote.commentId;
		if (seen.has(key)) {
			throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.votesDuplicate", { commentRef: formatCommentRef(key) }));
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
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.voteValue", { argument: label }));
	}
	return vote;
}

function typedHandleArg(value: unknown, prefix: 'f' | 'u' | 'w', label: string): string {
	let text = stringArg(value, label);
	if (prefix === 'u' && text.toUpperCase().endsWith(`(${providerSelfAuthor})`)) {
		throw new ToolCallArgumentValidationError(
			'self_author_annotation_in_handle',
			agentIssue("issue.args.handleSelfAnnotation", { argument: label, selfMarker: providerSelfAuthor }),
		);
	}
	const marker = `${prefix}/`;
	while (text.toLowerCase().startsWith(marker)) {
		text = text.slice(marker.length).trim();
	}
	try {
		return normalizeHandle(text);
	} catch (error) {
		if (!(error instanceof InputError)) throw error;
		throw new ToolCallArgumentValidationError('bad_request', agentIssue(`issue.args.handle.${prefix}`, { argument: label }));
	}
}

function nonNegativeIntegerArg(value: unknown, label: string, fallback: number): number {
	if (value === null || value === undefined || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new ToolCallArgumentValidationError('bad_request', agentIssue("issue.args.nonnegativeInteger", { argument: label }));
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
