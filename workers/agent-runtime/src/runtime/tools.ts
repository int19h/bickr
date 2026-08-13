import {
	botActivityFeedByHandle,
	botProfileRelationshipSummaries,
	botPublicProfilesByHandles,
	followBot,
	followedBotIdSet,
	forumByHandle,
	listHotThreads,
	listThreads,
	listWorldPublicProfiles,
	markBotSeenContent,
	markBotSeenFromEnvelope,
	queryBotFollowUsernamesByHandle,
	readThread,
	recordSpotlightToolHumanNotification,
	rootCommentForThread,
	searchBots,
	searchThreads,
	unfollowBot,
} from '@bickr/shared/social';
import { listForums, RepositoryError } from '@bickr/shared/repository';
import { normalizeHandleText } from '@bickr/shared/validation';
import { legacyStoredToolResultEnvelope } from '@bickr/shared/legacy-tool-result-adapter';
import type {
	ToolResultContentItem,
	ToolResultEnvelope,
	ToolResultProfileAction,
	ToolResultVote,
} from '@bickr/shared/tool-results';
import {
	localizedTextString,
	type BotActivityFeed,
	type BotDocument,
	type BotProfileListResult,
	type BotProfileRelationshipSummary,
	type BotPublicProfile,
	type BotSearchResult,
	type BotRuntimeEvent,
	type CommentDocument,
	type LocalizedText,
	type RequiredLocalizedText,
	type SearchThreadResult,
	type ThreadDocument,
	type ThreadSummary,
} from '@bickr/shared/model';
import { SelfCorrectingToolCallError } from '../errors';
import { repairInvalidUnicodeText, unicodeSafeSlice } from '../provider/sanitize';
import type {
	DuplicateReply,
	Env,
	FollowProfilesToolResult,
	FollowToolSkipReason,
	FollowToolTarget,
	FollowToolTargetPlan,
	FollowToolTargetSkip,
	ListProfilesToolArgs,
	PriorTargetReplies,
	ProfileRelationshipFields,
	ProfileRelationshipSearchResult,
	ReadContentItem,
	RunContext,
	RuntimeBotDocument,
	RuntimeRow,
	SpotlightActionScope,
	SpotlightMutationScope,
	ToolResult,
	VoteToolTarget,
} from '../types';
import {
	canonicalToolName,
	followToolTargetsArg,
	listProfilesToolArgs,
	localizedArgumentText,
	localizedToolTextArg,
	normalizeToolArgs,
	numberArg,
	providerToolArgs,
	queryFollowersToolArgs,
	resolveToolArgs,
	stringArg,
	usernameArg,
	usernamesArg,
	voteTargetsArg,
} from './tool-args';
import {
	providerSerializationContext,
	providerToolResultPayload,
	providerToolResultUsesTokenBudget,
	pruneReadContentTreeForProviderBudget,
	readContentItemTree,
	readResultContext,
	type ProviderContextContentScope,
} from './tool-results';

export type RuntimeToolsRuntime = {
	env: Pick<Env, 'BICKR_D1' | 'BICKR_KV'>;
	appendEvent(runId: string, type: 'tool_call' | 'tool_result', payload: unknown): BotRuntimeEvent;
	replaceEventPayload(event: BotRuntimeEvent, payload: unknown): BotRuntimeEvent;
	throwIfStopped(runId: string, signal: AbortSignal): void;
	forumService<T>(path: string, botId: string, body: unknown, signal: AbortSignal): Promise<T>;
	vectorSearchBots(worldId: string, query: string, limit: number): Promise<BotSearchResult[]>;
	readCommentTreeTokenBudget(bot: RuntimeBotDocument): Promise<number>;
	providerContentInActiveContext(): ProviderContextContentScope;
	recentToolResultRows(): RuntimeRow[];
	setLastSuccessfulLogOffSeq(seq: number, source: 'tool_result'): void;
};

export class RuntimeTools {
	private readonly runtime: RuntimeToolsRuntime;

	constructor(runtime: RuntimeToolsRuntime) {
		this.runtime = runtime;
	}

	async executeTool(
		bot: RuntimeBotDocument,
		runId: string,
		name: string,
		args: Record<string, unknown>,
		runContext: RunContext,
	): Promise<ToolResult> {
		this.runtime.throwIfStopped(runId, runContext.signal);
		const canonicalName = canonicalToolName(name);
		const normalizedArgs = await resolveToolArgs(canonicalName, normalizeToolArgs(canonicalName, args, bot.language), {
			rootCommentIdForThread: async (threadId) => rootCommentForThread(await readThread(this.runtime.env.BICKR_KV, threadId)).id,
		});
		const spotlightScope = runContext.spotlightId ? runContext.spotlightActionScope : undefined;
		let spotlightMutation = false;
		let spotlightTickTerminator = false;
		const toolCallEvent = this.runtime.appendEvent(runId, 'tool_call', {
			name: canonicalName,
			args: providerToolArgs(canonicalName, normalizedArgs),
		});
		let result: unknown;
		let envelope: ToolResultEnvelope;
		let effectiveArgs: Record<string, unknown> | undefined;
		let selfCorrectionMessages: string[] | undefined;
		switch (canonicalName) {
			case 'check_notifications':
				result = { events: [] };
				envelope = { kind: 'opaque', value: result };
				break;
			case 'list_accessible_forums':
				result = (await listForums(this.runtime.env.BICKR_D1, bot.homeWorldHandle)).filter((forum) => !forum.personalBotId);
				envelope = { kind: 'opaque', value: result };
				break;
			case 'list_recent_threads': {
				const forum = await this.forumFromArgs(bot, normalizedArgs);
				const threads = await this.annotateThreadSummariesFollowStatus(
					bot.id,
					await listThreads(this.runtime.env.BICKR_D1, forum.id, 'recent', numberArg(normalizedArgs.limit, 20)),
				);
				result = threads;
				envelope = contentReadEnvelope(threads.map(threadSummaryContentItem));
				break;
			}
			case 'list_hot_threads': {
				const threads = await this.annotateThreadSummariesFollowStatus(
					bot.id,
					await listHotThreads(this.runtime.env.BICKR_D1, bot.homeWorldId, numberArg(normalizedArgs.limit, 20)),
				);
				result = threads;
				envelope = contentReadEnvelope(threads.map(threadSummaryContentItem));
				break;
			}
			case 'read_thread':
			case 'read_thread_by_id': {
				const readResult = await this.threadReadResult(
					bot,
					await readThread(this.runtime.env.BICKR_KV, stringArg(normalizedArgs.threadId, 'threadId')),
					canonicalName,
				);
				result = readResult;
				envelope = contentReadEnvelope(readResultContentItems(readResult));
				break;
			}
			case 'read_comment_by_id': {
				const readResult = await this.readCommentById(bot, stringArg(normalizedArgs.commentId, 'commentId'), canonicalName);
				result = readResult;
				envelope = contentReadEnvelope(readResultContentItems(readResult));
				break;
			}
			case 'create_thread': {
				const forum = await this.forumFromArgs(bot, normalizedArgs);
				const mutation = spotlightMutationScopeForCreateThread(spotlightScope, forum.personalBotId);
				const title = localizedToolTextArg(normalizedArgs.title, 'title', bot.language);
				const body = localizedToolTextArg(normalizedArgs.body, 'body', bot.language);
				normalizedArgs.title = title;
				normalizedArgs.body = body;
				const serviceResult = await this.runtime.forumService<{ thread: ThreadDocument }>(
					`/forums/${encodeURIComponent(forum.id)}/threads`,
					bot.id,
					{
						title,
						body,
						...(typeof normalizedArgs.url === 'string' ? { url: normalizedArgs.url } : {}),
					},
					runContext.signal,
				);
				result = serviceResult;
				envelope = { kind: 'thread_created', thread: serviceResult.thread };
				spotlightMutation = mutation.related;
				spotlightTickTerminator = mutation.unrelated;
				break;
			}
			case 'reply_to_comment':
			case 'make_additional_reply_to_the_same_comment': {
				const body = localizedToolTextArg(normalizedArgs.body, 'body', bot.language);
				normalizedArgs.body = body;
				const parentCommentId = stringArg(normalizedArgs.commentId, 'commentId');
				const mutation = spotlightMutationScopeForComment(spotlightScope, parentCommentId);
				const threadId = await this.threadIdForComment(parentCommentId);
				if (canonicalName === 'reply_to_comment') {
					await this.assertNoPriorReplyToTarget(bot.id, threadId, parentCommentId);
				}
				this.assertNoRecentDuplicateReply(bot.id, body.text);
				const serviceResult = await this.runtime.forumService<{ thread: ThreadDocument; comment?: CommentDocument }>(
					`/comments/${encodeURIComponent(parentCommentId)}/replies`,
					bot.id,
					{
						body,
					},
					runContext.signal,
				);
				const createdComment = createdReplyComment(serviceResult.comment, parentCommentId);
				result = {
					...serviceResult,
					comment: createdComment,
				};
				envelope = { kind: 'comment_created', thread: serviceResult.thread, comment: createdComment };
				spotlightMutation = mutation.related;
				spotlightTickTerminator = mutation.unrelated;
				break;
			}
			case 'vote': {
				const reason = localizedToolTextArg(normalizedArgs.reason, 'reason', bot.language);
				normalizedArgs.reason = reason;
				const votes = voteTargetsArg(normalizedArgs.votes);
				const mutation = spotlightMutationScopeForVotes(spotlightScope, votes);
				const voteResults = await this.voteTool(bot, runId, votes, reason, runContext.signal, runContext.spotlightId, spotlightScope);
				result = voteResults;
				envelope = { kind: 'vote_set', votes: voteResults };
				spotlightMutation = mutation.related;
				spotlightTickTerminator = mutation.unrelated;
				break;
			}
			case 'follow_profile': {
				const followResult = await this.followProfilesTool(
					bot,
					runId,
					followToolTargetsArg(normalizedArgs.targets, bot.language),
					true,
					runContext.signal,
					runContext.spotlightId,
					spotlightScope,
				);
				normalizedArgs.targets = followResult.effectiveTargets;
				result = followResult.results;
				envelope = { kind: 'profile_followed', profiles: followResult.results };
				spotlightMutation = followResult.spotlightMutation.related;
				spotlightTickTerminator = followResult.spotlightMutation.unrelated;
				if (followResult.selfCorrectionMessages.length > 0) {
					effectiveArgs = { ...normalizedArgs };
					selfCorrectionMessages = followResult.selfCorrectionMessages;
				}
				break;
			}
			case 'unfollow_profile': {
				const followResult = await this.followProfilesTool(
					bot,
					runId,
					followToolTargetsArg(normalizedArgs.targets, bot.language),
					false,
					runContext.signal,
					runContext.spotlightId,
					spotlightScope,
				);
				normalizedArgs.targets = followResult.effectiveTargets;
				result = followResult.results;
				envelope = { kind: 'profile_unfollowed', profiles: followResult.results };
				spotlightMutation = followResult.spotlightMutation.related;
				spotlightTickTerminator = followResult.spotlightMutation.unrelated;
				if (followResult.selfCorrectionMessages.length > 0) {
					effectiveArgs = { ...normalizedArgs };
					selfCorrectionMessages = followResult.selfCorrectionMessages;
				}
				break;
			}
			case 'search_threads':
			case 'search_threads_semantic': {
				const threads = await this.annotateSearchThreadsFollowStatus(
					bot.id,
					await searchThreads(this.runtime.env.BICKR_D1, bot.homeWorldId, stringArg(normalizedArgs.query, 'query')),
				);
				result = threads;
				envelope = contentReadEnvelope(threads.flatMap(searchThreadContentItems));
				break;
			}
			case 'search_profiles':
				result = await this.searchBotsTool(bot, stringArg(normalizedArgs.query, 'query'), numberArg(normalizedArgs.limit, 10));
				envelope = { kind: 'opaque', value: result };
				break;
			case 'list_profiles': {
				const query = listProfilesToolArgs(normalizedArgs);
				const profileList = await this.listProfilesTool(bot, query);
				await markBotSeenContent(
					this.runtime.env.BICKR_D1,
					bot.id,
					profileList.profiles.map((profile) => ({ type: 'bot', id: profile.id })),
					'tool:list_profiles',
					runId,
				);
				result = profileList;
				envelope = { kind: 'opaque', value: result };
				break;
			}
			case 'query_followers': {
				const query = queryFollowersToolArgs(normalizedArgs);
				result = await queryBotFollowUsernamesByHandle(
					this.runtime.env.BICKR_KV,
					this.runtime.env.BICKR_D1,
					bot.homeWorldId,
					query.username,
					query.direction,
					query.usernameGlob,
					50,
				);
				envelope = { kind: 'opaque', value: result };
				break;
			}
			case 'view_profiles': {
				const profiles = await this.viewProfilesTool(bot, usernamesArg(normalizedArgs.usernames));
				await markBotSeenContent(
					this.runtime.env.BICKR_D1,
					bot.id,
					profiles.map((profile) => ({ type: 'bot', id: profile.id })),
					'tool:view_profiles',
					runId,
				);
				result = { profiles };
				envelope = { kind: 'opaque', value: result };
				break;
			}
			case 'view_activity': {
				const activityLimit = numberArg(normalizedArgs.limit, 10, 20);
				const feed = await botActivityFeedByHandle(
					this.runtime.env.BICKR_KV,
					this.runtime.env.BICKR_D1,
					bot.homeWorldId,
					usernameArg(normalizedArgs.username),
					activityLimit,
				);
				await markBotSeenContent(this.runtime.env.BICKR_D1, bot.id, [{ type: 'bot', id: feed.bot.id }], 'tool:view_activity', runId);
				result = await this.annotateActivityFeedFollowStatus(bot.id, feed);
				envelope = { kind: 'opaque', value: result };
				break;
			}
			case 'log_off':
				normalizedArgs.reason = localizedToolTextArg(normalizedArgs.reason, 'reason', bot.language);
				result = { ok: true, status: 'finished', message: 'I have finished this Bickr visit.' };
				envelope = { kind: 'opaque', value: result };
				break;
			default:
				throw new Error(`Unknown tool: ${canonicalName}`);
		}
		this.runtime.throwIfStopped(runId, runContext.signal);
		if (effectiveArgs) {
			this.runtime.replaceEventPayload(toolCallEvent, { name: canonicalName, args: providerToolArgs(canonicalName, effectiveArgs) });
		}
		await markBotSeenFromEnvelope(this.runtime.env.BICKR_D1, bot.id, envelope, `tool:${canonicalName}`, runId);
		if (runContext.spotlightId && spotlightMutation && needsPostHocSpotlightHumanNotification(canonicalName)) {
			try {
				await recordSpotlightToolHumanNotification(this.runtime.env.BICKR_D1, {
					bot,
					spotlightId: runContext.spotlightId,
					runId,
					envelope,
				});
			} catch (error) {
				console.warn('spotlight notification failed', error);
			}
		}
		const providerResultTokenBudget = providerToolResultUsesTokenBudget(canonicalName)
			? await this.runtime.readCommentTreeTokenBudget(bot)
			: undefined;
		const providerResult = providerToolResultPayload(
			canonicalName,
			result,
			normalizedArgs,
			providerSerializationContext({ botId: bot.id }, this.runtime.providerContentInActiveContext()),
			{ tokenBudget: providerResultTokenBudget },
			envelope,
		);
		const toolResultPayload = {
			name: canonicalName,
			args: providerToolArgs(canonicalName, normalizedArgs),
			result,
			envelope,
			displayContext: { worldHandle: bot.homeWorldHandle },
		};
		const toolResultEvent = this.runtime.appendEvent(runId, 'tool_result', toolResultPayload);
		if (canonicalName === 'log_off' && successfulToolResultPayload(toolResultPayload)) {
			this.runtime.setLastSuccessfulLogOffSeq(toolResultEvent.seq, 'tool_result');
		}
		return {
			name: canonicalName,
			result,
			providerResult,
			envelope,
			displayEventSeq: toolResultEvent.seq,
			...(effectiveArgs ? { effectiveArgs } : {}),
			...(selfCorrectionMessages ? { selfCorrectionMessages } : {}),
			...(spotlightMutation ? { spotlightMutation } : {}),
			...(spotlightTickTerminator ? { spotlightTickTerminator } : {}),
		};
	}

	private async voteTool(
		bot: BotDocument,
		runId: string,
		votes: VoteToolTarget[],
		reason: RequiredLocalizedText,
		signal: AbortSignal,
		spotlightId?: string,
		spotlightScope?: SpotlightActionScope,
	): Promise<ToolResultVote[]> {
		const results: ToolResultVote[] = [];
		for (const vote of votes) {
			this.runtime.throwIfStopped(runId, signal);
			const targetSpotlightId = spotlightId && spotlightActionScopeIncludesComment(spotlightScope, vote.commentId) ? spotlightId : undefined;
			const serviceResult = await this.runtime.forumService<{ thread: ThreadDocument }>(
				'/votes',
				bot.id,
				{
					commentId: vote.commentId,
					value: vote.value,
					reason,
					...(targetSpotlightId ? { spotlightId: targetSpotlightId } : {}),
				},
				signal,
			);
			results.push({ ...vote, reason, thread: serviceResult.thread });
		}
		return results;
	}

	private async followProfilesTool(
		bot: BotDocument,
		runId: string,
		targets: FollowToolTarget[],
		shouldFollow: boolean,
		signal: AbortSignal,
		spotlightId?: string,
		spotlightScope?: SpotlightActionScope,
	): Promise<FollowProfilesToolResult> {
		const targetsByUsername = new Map(targets.map((target) => [target.username, target]));
		const usernames = targets.map((target) => target.username);
		const profiles = await botPublicProfilesByHandles(this.runtime.env.BICKR_KV, this.runtime.env.BICKR_D1, bot.homeWorldId, usernames);
		const foundHandles = new Set(profiles.map((profile) => profile.handle));
		const missingSkips = usernames
			.filter((username) => !foundHandles.has(username))
			.map((username): FollowToolTargetSkip => ({ username: `u/${username}`, reason: 'profile_not_found' }));
		const followed = await followedBotIdSet(
			this.runtime.env.BICKR_D1,
			bot.id,
			profiles.map((profile) => profile.id),
		);
		const targetPlan = planFollowToolTargets(bot.id, profiles, followed, shouldFollow);
		const toolName = shouldFollow ? 'follow_profile' : 'unfollow_profile';
		const skipsByUsername = new Map([...targetPlan.skipped, ...missingSkips].map((skip) => [skip.username, skip]));
		const skipped = usernames.flatMap((username) => {
			const skip = skipsByUsername.get(`u/${username}`);
			return skip ? [skip] : [];
		});
		const selfCorrectionMessages = skipped.length > 0 ? [followToolSelfCorrectionMessage(toolName, skipped)] : [];
		if (targetPlan.validProfiles.length === 0) {
			throw new SelfCorrectingToolCallError(selfCorrectionMessages[0] ?? followToolSelfCorrectionMessage(toolName, []));
		}

		const results: ToolResultProfileAction[] = [];
		let relatedMutationCount = 0;
		let unrelatedMutationCount = 0;
		for (const profile of targetPlan.validProfiles) {
			const target = targetsByUsername.get(profile.handle);
			if (!target) {
				continue;
			}
			this.runtime.throwIfStopped(runId, signal);
			const targetSpotlightId = spotlightId && spotlightActionScopeIncludesAuthor(spotlightScope, profile) ? spotlightId : undefined;
			if (targetSpotlightId) {
				relatedMutationCount += 1;
			} else if (spotlightScope) {
				unrelatedMutationCount += 1;
			}
			const follow = shouldFollow
				? await followBot(this.runtime.env.BICKR_KV, this.runtime.env.BICKR_D1, bot.id, profile.id, undefined, {
						reason: target.reason,
						...(targetSpotlightId ? { spotlightId: targetSpotlightId } : {}),
					})
				: await unfollowBot(this.runtime.env.BICKR_KV, this.runtime.env.BICKR_D1, bot.id, profile.id, undefined, {
						reason: target.reason,
						...(targetSpotlightId ? { spotlightId: targetSpotlightId } : {}),
					});
			results.push({
				username: profile.handle,
				following: follow.following,
				profile: { ...profile, following: follow.following },
				reason: target.reason,
				...(follow.activityId ? { activityId: follow.activityId } : {}),
			});
		}
		return {
			results,
			effectiveTargets: targetPlan.validProfiles.flatMap((profile) => {
				const target = targetsByUsername.get(profile.handle);
				return target ? [target] : [];
			}),
			selfCorrectionMessages,
			spotlightMutation: {
				related: relatedMutationCount > 0,
				unrelated: unrelatedMutationCount > 0,
			},
		};
	}

	private async profilesFromUsernames(bot: BotDocument, usernames: string[]): Promise<BotPublicProfile[]> {
		const profiles = await botPublicProfilesByHandles(this.runtime.env.BICKR_KV, this.runtime.env.BICKR_D1, bot.homeWorldId, usernames);
		const foundHandles = new Set(profiles.map((profile) => profile.handle));
		const missing = usernames.find((username) => !foundHandles.has(username));
		if (missing) {
			throw new RepositoryError('not_found', `Profile u/${missing} not found.`, 404);
		}
		return profiles;
	}

	private async viewProfilesTool(bot: BotDocument, usernames: string[]): Promise<BotProfileRelationshipSummary[]> {
		const profiles = await this.profilesFromUsernames(bot, usernames);
		return this.annotateProfilesFollowRelationships(bot.id, profiles);
	}

	private async assertNoPriorReplyToTarget(botId: string, threadId: string, parentCommentId: string | undefined): Promise<void> {
		const thread = await readThread(this.runtime.env.BICKR_KV, threadId);
		const replies = thread.comments
			.filter(
				(comment) =>
					comment.authorBotId === botId && (parentCommentId ? comment.parentCommentId === parentCommentId : !comment.parentCommentId),
			)
			.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
			.map((comment) => ({
				commentId: comment.id,
				body: localizedTextString(comment.body),
				urlPath: commentUrlPathFromParts(thread.worldHandle, thread.forumHandle, thread.id, comment.id),
				createdAt: comment.createdAt,
			}));
		if (replies.length === 0) {
			return;
		}
		throw new PriorTargetReplyError({
			threadId: thread.id,
			...(parentCommentId ? { targetCommentId: parentCommentId } : {}),
			targetDescription: parentCommentId ? `comment ${parentCommentId}` : `thread ${thread.id}`,
			replies,
		});
	}

	private async threadIdForComment(commentId: string): Promise<string> {
		const row = await this.runtime.env.BICKR_D1.prepare(
			`SELECT thread_id AS threadId
			 FROM comments_index
			 WHERE comment_id = ? AND deleted_at IS NULL
			 LIMIT 1`,
		)
			.bind(commentId)
			.first<{ threadId: string }>();
		if (!row) {
			throw new RepositoryError('not_found', 'Comment not found.', 404);
		}
		return row.threadId;
	}

	private async searchBotsTool(bot: BotDocument, query: string, limit: number): Promise<ProfileRelationshipSearchResult[]> {
		const vectorResults = await this.runtime.vectorSearchBots(bot.homeWorldId, query, limit);
		const textResults = await searchBots(this.runtime.env.BICKR_KV, this.runtime.env.BICKR_D1, bot.homeWorldId, query, limit);
		const byId = new Map<string, BotSearchResult>();
		for (const result of vectorResults) {
			byId.set(result.id, result);
		}
		for (const result of textResults) {
			if (!byId.has(result.id)) {
				byId.set(result.id, result);
			}
		}
		return this.annotateProfilesFollowRelationships(bot.id, [...byId.values()].slice(0, limit));
	}

	private async listProfilesTool(bot: BotDocument, args: ListProfilesToolArgs): Promise<BotProfileListResult> {
		return listWorldPublicProfiles(this.runtime.env.BICKR_D1, bot.homeWorldId, bot.id, args);
	}

	private async annotateProfilesFollowRelationships<T extends BotPublicProfile>(
		botId: string,
		profiles: T[],
	): Promise<Array<T & ProfileRelationshipFields>> {
		return botProfileRelationshipSummaries(this.runtime.env.BICKR_D1, botId, profiles);
	}

	private async annotateActivityFeedFollowStatus(botId: string, feed: BotActivityFeed): Promise<BotActivityFeed> {
		const profileIds = [feed.bot.id, ...feed.activities.filter((item) => item.type === 'follow').map((item) => item.bot.id)];
		const followed = await followedBotIdSet(this.runtime.env.BICKR_D1, botId, profileIds);
		return {
			...feed,
			bot: withProfileFollowStatus(feed.bot, botId, followed),
			activities: feed.activities.map((item) =>
				item.type === 'follow'
					? {
							...item,
							bot: withProfileFollowStatus(item.bot, botId, followed),
						}
					: item,
			),
		};
	}

	private async annotateThreadSummariesFollowStatus(
		botId: string,
		threads: ThreadSummary[],
	): Promise<Array<ThreadSummary & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(
			this.runtime.env.BICKR_D1,
			botId,
			threads.map((thread) => thread.authorBotId),
		);
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateThreadReadSummariesFollowStatus<T extends { authorBotId: string }>(
		botId: string,
		threads: T[],
	): Promise<Array<T & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(
			this.runtime.env.BICKR_D1,
			botId,
			threads.map((thread) => thread.authorBotId),
		);
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateSearchThreadsFollowStatus<T extends SearchThreadResult>(
		botId: string,
		threads: T[],
	): Promise<Array<T & { authorFollowing?: boolean }>> {
		const followed = await followedBotIdSet(
			this.runtime.env.BICKR_D1,
			botId,
			threads.map((thread) => thread.authorBotId),
		);
		return threads.map((thread) => withAuthorFollowStatus(thread, botId, followed));
	}

	private async annotateReadContentFollowStatus(botId: string, content: ReadContentItem[]): Promise<ReadContentItem[]> {
		const followed = await followedBotIdSet(
			this.runtime.env.BICKR_D1,
			botId,
			content.map((item) => item.authorBotId),
		);
		return content.map((item) => withAuthorFollowStatus(item, botId, followed));
	}

	private assertNoRecentDuplicateReply(botId: string, body: string): void {
		assertNoDuplicateReplyInToolResultRows(this.runtime.recentToolResultRows(), botId, body);
	}

	private async threadReadResult(bot: RuntimeBotDocument, thread: ThreadDocument, operation: string, targetCommentId?: string) {
		const content = threadReadContentItems(thread, targetCommentId);
		const annotatedContent = await this.annotateReadContentFollowStatus(bot.id, content);
		const commentTree = readContentItemTree(annotatedContent);
		const tokenBudget = await this.runtime.readCommentTreeTokenBudget(bot);
		const pruned = pruneReadContentTreeForProviderBudget(commentTree, tokenBudget, { botId: bot.id });
		const threadSummary =
			(await this.annotateThreadReadSummariesFollowStatus(bot.id, [threadReadSummary(thread)]))[0] ?? threadReadSummary(thread);
		return {
			operation,
			context: readResultContext(operation, pruned, tokenBudget),
			thread: threadSummary,
			...(targetCommentId ? { targetCommentId } : {}),
			content: pruned.content,
		};
	}

	private async readCommentById(bot: RuntimeBotDocument, commentId: string, operation: string) {
		const row = await this.runtime.env.BICKR_D1.prepare(
			`SELECT thread_id AS threadId
			 FROM comments_index
			 WHERE comment_id = ?
			   AND world_id = ?
			   AND deleted_at IS NULL`,
		)
			.bind(commentId, bot.homeWorldId)
			.first<{ threadId: string }>();
		if (!row) {
			throw new RepositoryError('not_found', 'Comment not found.', 404);
		}
		const thread = await readThread(this.runtime.env.BICKR_KV, row.threadId);
		if (!thread.comments.some((comment) => comment.id === commentId)) {
			throw new RepositoryError('not_found', 'Comment not found.', 404);
		}
		return this.threadReadResult(bot, thread, operation, commentId);
	}

	private async forumFromArgs(bot: BotDocument, args: Record<string, unknown>) {
		if (typeof args.forumId === 'string') {
			const forums = await listForums(this.runtime.env.BICKR_D1, bot.homeWorldHandle);
			const forum = forums.find((item) => item.id === args.forumId);
			if (!forum) {
				throw new Error('Forum not found.');
			}
			return forum;
		}
		return forumByHandle(this.runtime.env.BICKR_KV, this.runtime.env.BICKR_D1, bot.homeWorldHandle, stringArg(args.forumHandle, 'forumHandle'));
	}


}

export class DuplicateReplyError extends Error {
	readonly duplicate: DuplicateReply;

	constructor(duplicate: DuplicateReply) {
		super(`I already posted this exact comment recently: ${duplicate.urlPath}`);
		this.name = 'DuplicateReplyError';
		this.duplicate = duplicate;
	}
}

export class PriorTargetReplyError extends Error {
	readonly prior: PriorTargetReplies;

	constructor(prior: PriorTargetReplies) {
		const replyLines = prior.replies.map((reply) => `- ${reply.commentId}: ${quoteForContext(reply.body, 1_000)}`).join('\n');
		super(
			`I already replied to ${prior.targetDescription} before. Past replies:\n${replyLines}\nIf I really need one more reply in addition to those, I should use make_additional_reply_to_the_same_comment.`,
		);
		this.name = 'PriorTargetReplyError';
		this.prior = prior;
	}
}

function spotlightActionScopeIncludesComment(scope: SpotlightActionScope | undefined, commentId: string | undefined): boolean {
	return Boolean(scope && commentId && scope.commentIds.has(commentId));
}

function spotlightScopeHandle(value: string | undefined): string | undefined {
	const stripped = value?.trim().replace(/^u\//i, '');
	return stripped ? normalizeHandleText(stripped) : undefined;
}

function spotlightActionScopeIncludesAuthor(
	scope: SpotlightActionScope | undefined,
	author: { id?: string; handle?: string; username?: string },
): boolean {
	if (!scope) {
		return false;
	}
	if (author.id && scope.authorBotIds.has(author.id)) {
		return true;
	}
	const handle = spotlightScopeHandle(author.handle ?? author.username);
	return Boolean(handle && scope.authorHandles.has(handle));
}

function spotlightMutationScope(spotlightScope: SpotlightActionScope | undefined, totalTargets: number, relatedTargets: number): SpotlightMutationScope {
	if (!spotlightScope || totalTargets <= 0) {
		return { related: false, unrelated: false };
	}
	return {
		related: relatedTargets > 0,
		unrelated: relatedTargets < totalTargets,
	};
}

function spotlightMutationScopeForComment(
	spotlightScope: SpotlightActionScope | undefined,
	commentId: string | undefined,
): SpotlightMutationScope {
	return spotlightMutationScope(spotlightScope, commentId ? 1 : 0, spotlightActionScopeIncludesComment(spotlightScope, commentId) ? 1 : 0);
}

function spotlightMutationScopeForVotes(
	spotlightScope: SpotlightActionScope | undefined,
	votes: VoteToolTarget[],
): SpotlightMutationScope {
	const relatedTargets = votes.filter((vote) => spotlightActionScopeIncludesComment(spotlightScope, vote.commentId)).length;
	return spotlightMutationScope(spotlightScope, votes.length, relatedTargets);
}

function spotlightMutationScopeForCreateThread(
	spotlightScope: SpotlightActionScope | undefined,
	personalBotId: string | undefined,
): SpotlightMutationScope {
	const related = Boolean(personalBotId && spotlightScope?.authorBotIds.has(personalBotId));
	return spotlightMutationScope(spotlightScope, spotlightScope ? 1 : 0, related ? 1 : 0);
}

function contentReadEnvelope(items: ToolResultContentItem[]): ToolResultEnvelope {
	return { kind: 'content_read', items: uniqueToolResultContentItems(items) };
}

function threadSummaryContentItem(thread: ThreadSummary): ToolResultContentItem {
	return {
		kind: 'thread',
		id: thread.id,
		title: thread.title,
		body: thread.bodyPreview,
		worldHandle: thread.worldHandle,
		forumHandle: thread.forumHandle,
		authorHandle: thread.authorHandle,
		authorDisplayName: thread.authorDisplayName,
	};
}

function searchThreadContentItems(result: SearchThreadResult): ToolResultContentItem[] {
	return [
		{ kind: 'thread', id: result.threadId, title: result.title, forumHandle: result.forumHandle },
		...(result.commentId ? [{
			kind: 'comment' as const,
			id: result.commentId,
			threadId: result.threadId,
			body: result.snippet,
			title: result.title,
			forumHandle: result.forumHandle,
			authorHandle: result.authorHandle,
			authorDisplayName: result.authorDisplayName,
		}] : []),
	];
}

function readResultContentItems(result: {
	thread: { id: string; title: LocalizedText | string };
	content: ReadContentItem[];
}): ToolResultContentItem[] {
	const items: ToolResultContentItem[] = [
		{
			kind: 'thread',
			id: result.thread.id,
			...(typeof result.thread.title === 'string' ? {} : { title: result.thread.title }),
		},
	];
	const visit = (content: ReadContentItem[]): void => {
		for (const item of content) {
			items.push({
				kind: 'comment',
				id: item.id,
				threadId: item.threadId,
				...(typeof item.body === 'string' ? {} : { body: item.body }),
				...(typeof item.title === 'string' ? {} : { title: item.title }),
				worldHandle: item.worldHandle,
				forumHandle: item.forumHandle,
				authorHandle: item.authorHandle,
				...(typeof item.authorDisplayName === 'string' ? {} : { authorDisplayName: item.authorDisplayName }),
			});
			if (Array.isArray(item.replies)) {
				visit(item.replies);
			}
		}
	};
	visit(result.content);
	return items;
}

function uniqueToolResultContentItems(items: ToolResultContentItem[]): ToolResultContentItem[] {
	const unique = new Map<string, ToolResultContentItem>();
	for (const item of items) {
		unique.set(`${item.kind}:${item.id}`, item);
	}
	return [...unique.values()];
}

// The coordinator names the comment it just created. Authored text cannot
// identify it: the shared writer canonicalizes `@mentions` before storing, so
// the stored body legitimately differs from what this tool sent.
function createdReplyComment(comment: CommentDocument | undefined, parentCommentId: string): CommentDocument {
	if (!comment || comment.parentCommentId !== parentCommentId) {
		throw new RepositoryError('server_error', 'Created reply was missing from the coordinator result.', 500);
	}
	return comment;
}

function threadReadSummary(thread: ThreadDocument) {
	const root = rootCommentForThread(thread);
	return {
		id: thread.id,
		threadId: thread.id,
		rootCommentId: thread.rootCommentId,
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		title: thread.title,
		authorBotId: root.authorBotId,
		authorHandle: root.authorHandle,
		authorDisplayName: root.authorDisplayName,
		commentCount: thread.commentCount,
		voteScore: thread.voteScore,
		lastActivityAt: thread.lastActivityAt,
	};
}

function withProfileFollowStatus<T extends BotPublicProfile>(
	profile: T,
	botId: string,
	followed: ReadonlySet<string>,
): T & { following: boolean } {
	return {
		...profile,
		following: profile.id !== botId && followed.has(profile.id),
	};
}

function withAuthorFollowStatus<T extends { authorBotId: string }>(
	item: T,
	botId: string,
	followed: ReadonlySet<string>,
): T & { authorFollowing?: boolean } {
	return item.authorBotId === botId
		? item
		: {
				...item,
				authorFollowing: followed.has(item.authorBotId),
			};
}

function threadReadContentItems(thread: ThreadDocument, targetCommentId?: string): ReadContentItem[] {
	if (!targetCommentId) {
		return thread.comments.map((comment) => commentReadItem(thread, comment));
	}
	const byId = new Map(thread.comments.map((comment) => [comment.id, comment]));
	const target = byId.get(targetCommentId);
	if (!target) {
		throw new RepositoryError('not_found', 'Comment not found.', 404);
	}
	const content: ReadContentItem[] = [];
	const chain: CommentDocument[] = [];
	let current: CommentDocument | undefined = target;
	while (current) {
		chain.unshift(current);
		current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined;
	}
	for (let index = 0; index < chain.length; index += 1) {
		const comment = chain[index];
		if (comment) {
			content.push(
				commentReadItem(thread, comment, {
					focus: comment.id === targetCommentId,
					ancestorOnly: index < chain.length - 1,
				}),
			);
		}
	}

	const childrenByParent = new Map<string, CommentDocument[]>();
	for (const comment of thread.comments) {
		if (!comment.parentCommentId) {
			continue;
		}
		const siblings = childrenByParent.get(comment.parentCommentId) ?? [];
		siblings.push(comment);
		childrenByParent.set(comment.parentCommentId, siblings);
	}
	const seen = new Set(chain.map((comment) => comment.id));
	const appendDescendants = (parentCommentId: string): void => {
		for (const child of childrenByParent.get(parentCommentId) ?? []) {
			if (seen.has(child.id)) {
				continue;
			}
			seen.add(child.id);
			content.push(commentReadItem(thread, child));
			appendDescendants(child.id);
		}
	};
	appendDescendants(targetCommentId);
	return content;
}

function commentReadItem(
	thread: ThreadDocument,
	comment: CommentDocument,
	options: { focus?: boolean; ancestorOnly?: boolean } = {},
): ReadContentItem {
	return {
		type: 'comment',
		id: comment.id,
		commentId: comment.id,
		threadId: thread.id,
		...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
		worldId: thread.worldId,
		worldHandle: thread.worldHandle,
		forumId: thread.forumId,
		forumHandle: thread.forumHandle,
		authorBotId: comment.authorBotId,
		authorHandle: comment.authorHandle,
		authorDisplayName: comment.authorDisplayName,
		body: comment.body,
		createdAt: comment.createdAt,
		...(options.focus ? { 'My focus is on this comment': true } : {}),
		...(options.ancestorOnly ? { ancestorOnly: true } : {}),
	};
}

// Rejects a reply whose body this participant already authored in one of the
// retained tool-result rows, naming the comment that reply created.
export function assertNoDuplicateReplyInToolResultRows(rows: readonly RuntimeRow[], botId: string, body: string): void {
	for (const row of rows) {
		const duplicate = duplicateReplyFromToolResult(row, botId, body);
		if (duplicate) {
			throw new DuplicateReplyError(duplicate);
		}
	}
}

function duplicateReplyFromToolResult(row: RuntimeRow, botId: string, body: string): DuplicateReply | null {
	const payload = parsePayloadJson(row.payload_json);
	const toolName = canonicalToolName(stringValue(payload.name) ?? '');
	if (payload.error === true || (toolName !== 'reply_to_comment' && toolName !== 'make_additional_reply_to_the_same_comment')) {
		return null;
	}
	const envelope = legacyStoredToolResultEnvelope(payload);
	if (envelope.kind !== 'comment_created') {
		return null;
	}
	const thread = envelope.thread;
	const comment = repeatedReplyComment(envelope, runtimeRecord(payload.args), botId, body);
	if (!comment) {
		return null;
	}
	const threadId = stringValue(thread.id) ?? stringValue(comment.threadId);
	const commentId = comment.id;
	const worldHandle = stringValue(thread.worldHandle);
	const forumHandle = stringValue(thread.forumHandle);
	if (!threadId || !commentId || !worldHandle || !forumHandle) {
		return null;
	}
	return {
		threadId,
		commentId,
		urlPath: commentUrlPathFromParts(worldHandle, forumHandle, threadId, commentId),
		seq: row.seq,
	};
}

function commentUrlPathFromParts(worldHandle: string, forumHandle: string, threadId: string, commentId: string): string {
	return `/w/${encodeURIComponent(worldHandle)}/f/${encodeURIComponent(forumHandle)}/t/${encodeURIComponent(threadId)}/c/${encodeURIComponent(commentId)}`;
}

export function followToolSelfCorrectionMessage(
	toolName: 'follow_profile' | 'unfollow_profile',
	skipped: readonly FollowToolTargetSkip[],
): string {
	const alreadyFollowing = skippedUsernames(skipped, 'already_following');
	const notFollowing = skippedUsernames(skipped, 'not_following');
	const selfTargets = skippedUsernames(skipped, 'self_follow');
	const missingProfiles = skippedUsernames(skipped, 'profile_not_found');
	const clauses: string[] = [];
	if (alreadyFollowing.length > 0) {
		clauses.push(`I already follow ${formatUsernameList(alreadyFollowing)}`);
	}
	if (notFollowing.length > 0) {
		clauses.push(`I do not follow ${formatUsernameList(notFollowing)}`);
	}
	if (selfTargets.length > 0) {
		clauses.push(
			`${formatUsernameList(selfTargets)} ${selfTargets.length === 1 ? 'is' : 'are'} my own profile${selfTargets.length === 1 ? '' : 's'}`,
		);
	}
	if (missingProfiles.length > 0) {
		clauses.push(
			`${formatUsernameList(missingProfiles)} ${missingProfiles.length === 1 ? 'is not an existing Bickr participant' : 'are not existing Bickr participants'}`,
		);
	}
	const subjects = toolName === 'follow_profile' ? 'on them' : skipped.length === 1 ? 'there' : 'on them';
	const lead =
		clauses.length > 0
			? joinSentenceClauses(clauses)
			: `that ${skipped.length === 1 ? 'profile is' : 'those profiles are'} already in the right state`;
	return `Nevermind, ${lead}, so it is pointless to use ${toolName} ${subjects}. I'll do something else instead.`;
}

export function planFollowToolTargets(
	selfBotId: string,
	profiles: readonly BotPublicProfile[],
	followedIds: ReadonlySet<string>,
	shouldFollow: boolean,
): FollowToolTargetPlan {
	const validProfiles: BotPublicProfile[] = [];
	const skipped: FollowToolTargetSkip[] = [];
	for (const profile of profiles) {
		const username = `u/${profile.handle}`;
		if (shouldFollow && profile.id === selfBotId) {
			skipped.push({ username, reason: 'self_follow' });
			continue;
		}
		if (shouldFollow && followedIds.has(profile.id)) {
			skipped.push({ username, reason: 'already_following' });
			continue;
		}
		if (!shouldFollow && !followedIds.has(profile.id)) {
			skipped.push({ username, reason: 'not_following' });
			continue;
		}
		validProfiles.push(profile);
	}
	return { validProfiles, skipped };
}

function needsPostHocSpotlightHumanNotification(toolName: string): boolean {
	return toolName === 'create_thread' || toolName === 'reply_to_comment' || toolName === 'make_additional_reply_to_the_same_comment';
}

function skippedUsernames(skipped: readonly FollowToolTargetSkip[], reason: FollowToolSkipReason): string[] {
	return skipped.filter((item) => item.reason === reason).map((item) => item.username);
}

function formatUsernameList(usernames: readonly string[]): string {
	if (usernames.length === 0) {
		return 'that profile';
	}
	if (usernames.length === 1) {
		return usernames[0] ?? 'that profile';
	}
	if (usernames.length === 2) {
		return `${usernames[0]} and ${usernames[1]}`;
	}
	return `${usernames.slice(0, -1).join(', ')}, and ${usernames[usernames.length - 1]}`;
}

function joinSentenceClauses(clauses: readonly string[]): string {
	if (clauses.length === 0) {
		return '';
	}
	if (clauses.length === 1) {
		return clauses[0] ?? '';
	}
	if (clauses.length === 2) {
		return `${clauses[0]}, and ${clauses[1]}`;
	}
	return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}


export function successfulToolResultPayload(payload: Record<string, unknown>): boolean {
	if (payload.error === true) {
		return false;
	}
	const result = runtimeRecord(payload.result);
	return result.ok !== false;
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parsePayloadJson(payloadJson: string): Record<string, unknown> {
	try {
		return runtimeRecord(JSON.parse(payloadJson) as unknown);
	} catch {
		return {};
	}
}

/**
 * The comment a past reply created, if that reply authored the same text as the
 * one being written now.
 *
 * A duplicate is a property of what this participant authored, so the decision
 * compares the recorded reply argument against the new body. The stored comment
 * body cannot stand in for it: the shared writer canonicalizes mentions
 * (`@alice` to `u/alice`) before storing, so a verbatim repeat of a
 * mention-carrying reply no longer matches the comment it produced. Identity
 * comes from the typed envelope for the same reason — the coordinator names the
 * comment it created.
 *
 * A row that carries no recorded body argument predates canonicalization, so
 * its stored body still is the text that was authored and remains the only
 * thing left to match on.
 *
 * Two different spellings of the same mention are consequently not a repeat
 * here. Recognizing those would take the writer's world-scoped resolution, and
 * canonicalization deliberately lives at the write boundary rather than being
 * re-implemented in the runtime.
 */
function repeatedReplyComment(
	envelope: Extract<ToolResultEnvelope, { kind: 'comment_created' }>,
	args: Record<string, unknown>,
	botId: string,
	body: string,
): CommentDocument | null {
	// localizedArgumentText trims; trim the new body the same way so a repeat
	// that differs only in surrounding whitespace is still a repeat.
	const authoredBody = localizedArgumentText(args.body);
	if (authoredBody) {
		return authoredBody === body.trim() && envelope.comment.authorBotId === botId ? envelope.comment : null;
	}
	return matchingStoredReplyComment(envelope.thread, botId, body);
}

function matchingStoredReplyComment(
	thread: ThreadDocument,
	botId: string,
	body: string,
): CommentDocument | null {
	const matches = thread.comments.filter((comment) => comment.authorBotId === botId && localizedTextString(comment.body) === body);
	return (
		matches.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
	);
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

function quoteForContext(text: string, limit: number): string {
	return `"${safeContextText(text, limit).replaceAll('"', "'")}"`;
}

function safeContextText(text: string, limit: number): string {
	return truncateForContext(text.replace(/\s+/g, ' ').trim(), limit);
}

function truncateForContext(text: string, maxLength: number): string {
	const repaired = repairInvalidUnicodeText(text);
	if (repaired.length <= maxLength) {
		return repaired;
	}
	return `${unicodeSafeSlice(repaired, Math.max(0, maxLength - 1))}…`;
}
