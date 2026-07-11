import type { ReactNode } from "react";
import { ShortDateLabel } from "../../App";
import { textValueForDisplay } from "../../reasoning-formatting";
import type { ReadableDisplayContext } from "./loop-message-readable";
import {
	ForumReference,
	ProfileReference,
	ReadableQuote,
	ThreadReference,
	arrayValue,
	commentIdFromRecord,
	commentIdFromValue,
	firstProfileRecord,
	forumHandleFromRecord,
	humanizeKey,
	isDisplayPrimitive,
	lowLevelDisplayKey,
	numberValue,
	profileHasHandle,
	recordValue,
	stringArrayValue,
	stringValue,
	threadIdFromRecord,
	threadIdFromValue,
	trimReadableSnippet,
	usernameHandle,
	voteActionLabel,
	worldHandleFromRecord,
	type JsonRecord,
} from "./loop-message-values";

export function ReadablePostingReply({ args, displayContext, result }: { args: JsonRecord; displayContext: ReadableDisplayContext; result?: unknown }) {
	const thread = threadRecordFromReadableMutation(result);
	const createdComment = createdReplyCommentFromReadableMutation(result, args);
	const targetCommentId = commentIdFromValue(args.commentRef ?? args.commentId ?? args.parentCommentRef ?? args.parentCommentId);
	const targetComment = targetCommentId ? findReadableComment(thread, targetCommentId) : {};
	const threadId = threadIdFromRecord(args) ?? threadIdFromRecord(createdComment) ?? threadIdFromRecord(thread);
	const worldHandle = worldHandleFromRecord(thread) ?? worldHandleFromRecord(createdComment) ?? worldHandleFromRecord(args) ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(thread) ?? forumHandleFromRecord(createdComment) ?? forumHandleFromRecord(args);
	const replyBody = textValueForDisplay(args.body);
	const targetBody = textValueForDisplay(targetComment.body);
	const title = readableThreadTitle(thread);
	return (
		<div className="tool-pretty tool-list">
			<div className="tool-pretty-item">
				<span>Replying to</span>
				<ThreadReference
					commentId={targetCommentId}
					forumHandle={forumHandle}
					label={targetCommentId ? "comment" : title ?? "thread"}
					threadId={threadId}
					title={targetCommentId ? undefined : title}
					worldHandle={worldHandle}
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
				/>
			</div>
			{targetBody && <ReadableQuote label="Target comment" text={trimReadableSnippet(targetBody)} />}
			{replyBody && <ReadableQuote label="Reply" text={replyBody} />}
		</div>
	);
}

export function ReadablePostedReplyResult({ args, displayContext, value }: { args: JsonRecord; displayContext: ReadableDisplayContext; value: unknown }) {
	const thread = threadRecordFromReadableMutation(value);
	const createdComment = createdReplyCommentFromReadableMutation(value, args);
	const commentId = commentIdFromRecord(createdComment);
	const threadId = threadIdFromRecord(createdComment) ?? threadIdFromRecord(thread) ?? threadIdFromRecord(args);
	const worldHandle = worldHandleFromRecord(thread) ?? worldHandleFromRecord(createdComment) ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(thread) ?? forumHandleFromRecord(createdComment);
	const title = readableThreadTitle(thread);
	const body = textValueForDisplay(createdComment.body) ?? textValueForDisplay(args.body);
	return (
		<div className="tool-pretty tool-list">
			<div className="tool-pretty-item">
				<span>Posted</span>
				<ThreadReference
					commentId={commentId}
					forumHandle={forumHandle}
					label={commentId ? "comment" : title ?? "thread"}
					threadId={threadId}
					title={commentId ? undefined : title}
					worldHandle={worldHandle}
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
				/>
				{title ?
					<>
						<span>in</span>
						<ThreadReference
							forumHandle={forumHandle}
							label={title ?? "thread"}
							threadId={threadId}
							title={title}
							worldHandle={worldHandle}
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
						/>
					</>
					:	null}
			</div>
			{body && <ReadableQuote label="Comment" text={body} />}
		</div>
	);
}

export function threadRecordFromReadableMutation(value: unknown): JsonRecord {
	const record = recordValue(value);
	const thread = recordValue(record.thread);
	return Object.keys(thread).length > 0 ? thread : record;
}

export function readableRootComment(thread: JsonRecord): JsonRecord {
	const comments = flattenReadableComments(arrayValue(thread.comments).map(recordValue));
	const rootCommentId = commentIdFromValue(thread.rootCommentRef ?? thread.rootCommentId);
	return (
		(rootCommentId ? comments.find((comment) => readableCommentId(comment) === rootCommentId) : undefined) ??
		comments.find((comment) => !stringValue(comment.parentCommentId)) ??
		{}
	);
}

export function readableThreadTitle(thread: JsonRecord): string | undefined {
	return stringValue(thread.title) ?? stringValue(recordValue(thread.rootPost).title);
}

export function createdReplyCommentFromReadableMutation(value: unknown, args: JsonRecord): JsonRecord {
	const record = recordValue(value);
	const comment = recordValue(record.comment);
	if (commentIdFromRecord(comment)) {
		return comment;
	}
	const thread = threadRecordFromReadableMutation(value);
	return findReadableReplyComment(thread, args) ?? {};
}

export function findReadableReplyComment(thread: JsonRecord, args: JsonRecord): JsonRecord | null {
	const body = stringValue(args.body);
	const parentCommentId = commentIdFromValue(args.commentRef ?? args.commentId ?? args.parentCommentRef ?? args.parentCommentId);
	const candidates = flattenReadableComments(arrayValue(thread.comments).map(recordValue)).filter((comment) => {
		if (body && stringValue(comment.body) !== body) {
			return false;
		}
		const commentParentId = stringValue(comment.parentCommentId);
		return parentCommentId ? commentParentId === parentCommentId : !commentParentId;
	});
	return candidates.sort((left, right) =>
		Date.parse(stringValue(right.createdAt) ?? "") - Date.parse(stringValue(left.createdAt) ?? "")
	)[0] ?? null;
}

export function findReadableComment(thread: JsonRecord, commentId: string): JsonRecord {
	return flattenReadableComments(arrayValue(thread.comments).map(recordValue))
		.find((comment) => readableCommentId(comment) === commentId) ?? {};
}

export function flattenReadableComments(comments: JsonRecord[]): JsonRecord[] {
	const result: JsonRecord[] = [];
	for (const comment of comments) {
		result.push(comment);
		result.push(...flattenReadableComments(arrayValue(comment.replies).map(recordValue)));
	}
	return result;
}

export function ReadableNotificationEvents({ displayContext, events }: { displayContext: ReadableDisplayContext; events: unknown[] }) {
	if (events.length === 0) {
		return <div className="tool-text">No new notifications.</div>;
	}
	return (
		<div className="readable-event-list">
			{events.map((event, index) => (
				<ReadableNotificationEvent displayContext={displayContext} event={recordValue(event)} key={`${stringValue(recordValue(event).id) ?? "event"}-${index}`} />
			))}
		</div>
	);
}

export function ReadableNotificationEvent({ displayContext, event }: { displayContext: ReadableDisplayContext; event: JsonRecord }) {
	const worldHandle = worldHandleFromRecord(event) ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(event);
	const thread = recordValue(event.thread);
	const comment = recordValue(event.comment);
	const text = textValueForDisplay(comment.text) ?? textValueForDisplay(thread.text) ?? textValueForDisplay(event.message);
	return (
		<div className="readable-event-card">
			<div className="readable-event-title">{notificationEventHeadline(event, displayContext)}</div>
			<div className="readable-event-meta">
				{forumHandle && <ForumReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} worldHandle={worldHandle} />}
				{stringValue(event.createdAt) && <ShortDateLabel value={String(event.createdAt)} />}
			</div>
			{text && <ReadableQuote text={text} />}
		</div>
	);
}

export function notificationEventHeadline(event: JsonRecord, displayContext: ReadableDisplayContext): ReactNode {
	const type = stringValue(event.type) ?? "system";
	const thread = recordValue(event.thread);
	const comment = recordValue(event.comment);
	const replyTo = recordValue(event.replyTo);
	const targetProfile = recordValue(event.targetProfile);
	const target = recordValue(event.target);
	const vote = recordValue(event.vote);
	const worldHandle = worldHandleFromRecord(event) ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(event);
	const actor = firstProfileRecord(event.actor, comment.author, thread.author);
	const actorNode = <ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={actor} worldHandle={worldHandle} />;
	const threadNode = (
		<ThreadReference
			allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
			commentId={commentIdFromRecord(comment)}
			forumHandle={forumHandleFromRecord(thread) ?? forumHandle}
			label={stringValue(thread.title) ?? "thread"}
			threadId={threadIdFromRecord(comment) ?? threadIdFromRecord(thread)}
			title={stringValue(thread.title)}
			worldHandle={worldHandleFromRecord(thread) ?? worldHandle}
		/>
	);
	switch (type) {
		case "thread_created":
			return (
				<>
					{actorNode} created {threadNode}
				</>
			);
		case "comment_created": {
			const replyAuthor = recordValue(replyTo.author);
			return (
				<>
					{actorNode} replied {profileHasHandle(replyAuthor) ? <>to <ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={replyAuthor} worldHandle={worldHandle} /> </> : null}
					on {threadNode}
				</>
			);
		}
		case "vote_cast": {
			const targetAuthor = recordValue(target.author);
			const targetType =
				stringValue(vote.targetType) ??
				(commentIdFromRecord(target) || commentIdFromRecord(vote) || threadIdFromRecord(target) ? "comment" : "thread");
			return (
				<>
					{actorNode} {voteActionLabel(numberValue(vote.value))}{" "}
					{profileHasHandle(targetAuthor) ? <><ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={targetAuthor} worldHandle={worldHandle} />’s </> : null}
					{targetType === "comment" ? "reply" : "thread"}
				</>
			);
		}
		case "profile_followed":
			return (
				<>
					{actorNode} followed <ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={profileHasHandle(targetProfile) ? targetProfile : target} worldHandle={worldHandle} />
				</>
			);
		case "profile_unfollowed":
			return (
				<>
					{actorNode} unfollowed <ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={profileHasHandle(targetProfile) ? targetProfile : target} worldHandle={worldHandle} />
				</>
			);
		default:
			return <>{textValueForDisplay(event.message) ?? "Bickr activity"}</>;
	}
}

export function ReadableProfiles({ displayContext, value }: { displayContext: ReadableDisplayContext; value: unknown }) {
	const record = recordValue(value);
	const profiles = Array.isArray(record.profiles) ? record.profiles : Array.isArray(value) ? value : profileHasHandle(record) ? [record] : [];
	if (profiles.length === 0) {
		return <div className="tool-text">No profiles found.</div>;
	}
	return (
		<div className="readable-profile-list">
			{profiles.map((profileValue, index) => {
				const profile = recordValue(profileValue);
				const username = stringValue(profile.username) ?? stringValue(profile.handle);
				const shortBio = textValueForDisplay(profile.shortBio);
				return (
					<div className="readable-profile-card" key={`${username ?? "profile"}-${index}`}>
						<div className="readable-profile-title">
							<ProfileReference
								allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
								profile={profile}
								worldHandle={worldHandleFromRecord(profile) ?? displayContext.worldHandle}
							/>
							{stringValue(profile.displayName) && <span>{stringValue(profile.displayName)}</span>}
							{typeof profile.followers === "number" && <span className="readable-badge">{profile.followers} follower{profile.followers === 1 ? "" : "s"}</span>}
							{typeof profile.isFollowedByMe === "boolean" && <span className="readable-badge">{profile.isFollowedByMe ? "followed by me" : "not followed by me"}</span>}
							{typeof profile.isFollowingMe === "boolean" && <span className="readable-badge">{profile.isFollowingMe ? "follows me" : "does not follow me"}</span>}
							{typeof profile.following === "boolean" && typeof profile.isFollowedByMe !== "boolean" && <span className="readable-badge">{profile.following ? "followed by me" : "not followed by me"}</span>}
						</div>
						{shortBio && <div className="tool-text">{shortBio}</div>}
					</div>
				);
			})}
		</div>
	);
}

export function ReadableQueryFollowersCall({ args, displayContext }: { args: JsonRecord; displayContext: ReadableDisplayContext }) {
	const isFollowing = stringValue(args.isFollowing);
	const isFollowedBy = stringValue(args.isFollowedBy);
	const username = isFollowing ?? isFollowedBy;
	const worldHandle = worldHandleFromRecord(args) ?? displayContext.worldHandle;
	const glob = stringValue(args.usernameGlob);
	return (
		<div className="tool-pretty tool-list">
			<div className="tool-pretty-item">
				<span>{isFollowing ? "Looking for profiles following" : "Looking for profiles followed by"}</span>
				{username ?
					<ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} username={username} worldHandle={worldHandle} />
				:	<span>profile</span>}
			</div>
			{glob && (
				<div className="tool-pretty-item">
					<span className="tool-pretty-label">Username filter</span>
					<span>{glob}</span>
				</div>
			)}
		</div>
	);
}

export function ReadableQueryFollowersResult({ displayContext, value }: { displayContext: ReadableDisplayContext; value: unknown }) {
	const record = recordValue(value);
	const usernames = stringArrayValue(record.usernames);
	const total = numberValue(record.total) ?? usernames.length;
	return (
		<div className="tool-pretty tool-list">
			<div className="tool-pretty-item">
				<span className="tool-pretty-label">Matches</span>
				<span>{total}</span>
			</div>
			{usernames.length < total && (
				<div className="tool-pretty-item">
					<span className="tool-pretty-label">Shown</span>
					<span>{usernames.length}</span>
				</div>
			)}
			{usernames.length > 0 ?
				usernames.map((username, index) => (
					<div className="tool-pretty-item" key={`${username}-${index}`}>
						<ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} username={username} worldHandle={displayContext.worldHandle} />
					</div>
				))
			:	<div className="tool-pretty-item">No matching usernames returned.</div>}
		</div>
	);
}

export function ReadableReadResult({ displayContext, value }: { displayContext: ReadableDisplayContext; value: unknown }) {
	const record = recordValue(value);
	const thread = recordValue(record.thread);
	const content = arrayValue(record.content);
	const context = textValueForDisplay(record.context);
	const worldHandle = worldHandleFromRecord(thread) ?? displayContext.worldHandle;
	const threadAuthor = profileHasHandle(recordValue(thread.author)) ? recordValue(thread.author) : thread;
	return (
		<div className="readable-result-stack">
			{context && <div className="tool-text">{context}</div>}
			{profileHasHandle(threadAuthor) || stringValue(thread.title) ?
				<div className="readable-event-meta">
					<ThreadReference
						forumHandle={forumHandleFromRecord(thread)}
						label={stringValue(thread.title) ?? "thread"}
						threadId={threadIdFromRecord(thread)}
						title={stringValue(thread.title)}
						worldHandle={worldHandle}
						allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					/>
					{profileHasHandle(threadAuthor) && (
						<ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={threadAuthor} worldHandle={worldHandle} />
					)}
				</div>
			:	null}
			<ReadableContentChain content={content} displayContext={displayContext} fallbackThread={thread} />
		</div>
	);
}

export function ReadableThreadDocument({ args, displayContext, value }: { args?: JsonRecord; displayContext: ReadableDisplayContext; value: unknown }) {
	const thread = threadRecordFromReadableMutation(value);
	const rootComment = readableRootComment(thread);
	const rootPost = recordValue(thread.rootPost);
	const title = readableThreadTitle(thread);
	const body =
		textValueForDisplay(rootComment.body) ??
		textValueForDisplay(rootPost.body) ??
		textValueForDisplay(thread.body) ??
		textValueForDisplay(args?.body);
	const authorProfile = profileHasHandle(rootComment) ? rootComment : recordValue(rootPost.author);
	const worldHandle = worldHandleFromRecord(thread) ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(thread);
	return (
		<div className="readable-result-stack">
			<div className="readable-event-title">
				<ThreadReference
					forumHandle={forumHandle}
					label={title ?? "thread"}
					threadId={threadIdFromRecord(thread)}
					title={title}
					worldHandle={worldHandle}
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
				/>
			</div>
			{profileHasHandle(authorProfile) ?
				<div className="readable-event-meta"><ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={authorProfile} worldHandle={worldHandle} /></div>
			:	null}
			{body && <ReadableQuote text={body} />}
		</div>
	);
}

export function ReadableVoteResult({ displayContext, value }: { displayContext: ReadableDisplayContext; value: unknown }) {
	const items = Array.isArray(value) ? value : [value];
	return (
		<div className="tool-pretty tool-list">
			{items.map((item, index) => {
				const record = recordValue(item);
				const target = recordValue(record.target);
				const commentId = commentIdFromValue(target.commentRef ?? target.commentId ?? record.commentRef ?? record.commentId ?? record.targetId);
				const targetType = stringValue(record.targetType) ?? stringValue(target.type) ?? (commentId ? "comment" : undefined);
				const thread = Object.keys(target).length > 0 ? target : recordValue(record.thread);
				const worldHandle = worldHandleFromRecord(thread) ?? displayContext.worldHandle;
				return (
					<div className="tool-pretty-item" key={`vote-${index}`}>
						<span>{voteActionLabel(numberValue(record.value))}</span>
						<ThreadReference
							commentId={commentId}
							forumHandle={forumHandleFromRecord(thread)}
							label={targetType === "comment" ? "comment" : stringValue(thread.title) ?? "thread"}
							threadId={threadIdFromRecord(thread) ?? threadIdFromValue(targetType === "thread" ? record.targetId : undefined)}
							title={stringValue(thread.title)}
							worldHandle={worldHandle}
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
						/>
					</div>
				);
			})}
		</div>
	);
}

export function ReadableFollowResult({ displayContext, fallbackFollowing, value }: { displayContext: ReadableDisplayContext; fallbackFollowing: boolean; value: unknown }) {
	const items = Array.isArray(value) ? value : [value];
	return (
		<div className="tool-pretty tool-list">
			{items.map((item, index) => {
				const record = recordValue(item);
				const profile = recordValue(record.profile);
				const following = typeof record.following === "boolean" ? record.following : fallbackFollowing;
				const profileRecord = profileHasHandle(profile) ? profile : record;
				return (
					<div className="tool-pretty-item" key={`follow-${index}`}>
						<span>{following ? "Following" : "Not following"}</span>
						<ProfileReference
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
							profile={profileRecord}
							worldHandle={worldHandleFromRecord(profileRecord) ?? displayContext.worldHandle}
						/>
					</div>
				);
			})}
		</div>
	);
}

export function ReadableForumList({ displayContext, value, worldHandle }: { displayContext: ReadableDisplayContext; value: unknown; worldHandle?: string }) {
	const items = Array.isArray(value) ? value : [];
	if (items.length === 0) {
		return <div className="tool-text">No forums found.</div>;
	}
	return (
		<div className="tool-pretty tool-list">
			{items.slice(0, 12).map((item, index) => {
				const forum = recordValue(item);
				const description = textValueForDisplay(forum.description);
				return (
					<div className="tool-pretty-item" key={`${stringValue(forum.forum ?? forum.handle) ?? "forum"}-${index}`}>
						<ForumReference
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
							forumHandle={forumHandleFromRecord(forum)}
							worldHandle={worldHandleFromRecord(forum) ?? worldHandle}
						/>
						{description && <span>{description}</span>}
					</div>
				);
			})}
		</div>
	);
}

export function ReadableThreadList({ displayContext, value }: { displayContext: ReadableDisplayContext; value: unknown }) {
	const items = Array.isArray(value) ? value : [];
	if (items.length === 0) {
		return <div className="tool-text">No matching threads or comments found.</div>;
	}
	return (
		<div className="tool-pretty tool-list">
			{items.slice(0, 12).map((item, index) => {
				const result = recordValue(item);
				const commentId = commentIdFromRecord(result);
				const threadId = threadIdFromRecord(result);
				const isComment = Boolean(commentId);
				const author = recordValue(result.author);
				const authorProfile = profileHasHandle(author) ? author : result;
				const authorUsername = stringValue(result.author);
				const hasAuthor = profileHasHandle(authorProfile) || Boolean(usernameHandle(authorUsername));
				const title = stringValue(result.title) ?? "thread";
				const snippet = textValueForDisplay(result.snippet);
				const worldHandle = worldHandleFromRecord(result) ?? displayContext.worldHandle;
				return (
					<div className="readable-search-result" key={`${threadId ?? "thread"}:${commentId ?? "root"}-${index}`}>
						<div className="readable-event-title">
							{isComment && hasAuthor ?
								<>
									<span>Comment by</span>
									<ProfileReference
										allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
										profile={authorProfile}
										username={authorUsername}
										worldHandle={worldHandle}
									/>
									<span>in</span>
								</>
							: isComment ?
								<span>Comment in</span>
							:	null}
							<ThreadReference
								commentId={commentId}
								forumHandle={forumHandleFromRecord(result)}
								label={title}
								threadId={threadId}
								title={title}
								worldHandle={worldHandle}
								allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
							/>
							{!isComment && hasAuthor && (
								<ProfileReference
									allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
									profile={authorProfile}
									username={authorUsername}
									worldHandle={worldHandle}
								/>
							)}
						</div>
						<div className="readable-event-meta">
							<ForumReference
								allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
								forumHandle={forumHandleFromRecord(result)}
								worldHandle={worldHandle}
							/>
							{stringValue(result.createdAt) && <ShortDateLabel value={String(result.createdAt)} />}
						</div>
						{snippet && <ReadableQuote text={trimReadableSnippet(snippet)} />}
					</div>
				);
			})}
		</div>
	);
}

export function ReadableActivityResult({ displayContext, value }: { displayContext: ReadableDisplayContext; value: unknown }) {
	const record = recordValue(value);
	const profile = firstProfileRecord(record.profile, record.bot);
	const activities = arrayValue(record.activities);
	const worldHandle = worldHandleFromRecord(profile) ?? worldHandleFromRecord(record) ?? displayContext.worldHandle;
	return (
		<div className="readable-result-stack">
			<div className="readable-event-title"><ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={profile} worldHandle={worldHandle} /></div>
			{activities.length === 0 ?
				<div className="tool-text">No recent public activity.</div>
				:	<div className="readable-result-stack">
						{activities.slice(0, 12).map((activity, index) => {
							const item = recordValue(activity);
							return (
								<ReadableActivityItem
									activity={item}
									displayContext={displayContext}
									fallbackWorldHandle={worldHandle}
									key={`${stringValue(item.id) ?? "activity"}-${index}`}
								/>
							);
						})}
					</div>}
		</div>
	);
}

export function ReadableActivityItem({
	activity,
	displayContext,
	fallbackWorldHandle,
}: {
	activity: JsonRecord;
	displayContext: ReadableDisplayContext;
	fallbackWorldHandle?: string;
}) {
	const type = stringValue(activity.type) ?? "activity";
	if (type === "thread" || type === "post") {
		return <ReadableThreadActivity activity={activity} displayContext={displayContext} fallbackWorldHandle={fallbackWorldHandle} />;
	}
	if (type === "comment") {
		return <ReadableCommentActivity activity={activity} displayContext={displayContext} fallbackWorldHandle={fallbackWorldHandle} />;
	}
	if (type === "vote") {
		return <ReadableVoteActivity activity={activity} displayContext={displayContext} fallbackWorldHandle={fallbackWorldHandle} />;
	}
	if (type === "follow" || type === "unfollow") {
		return <ReadableFollowActivity activity={activity} displayContext={displayContext} fallbackWorldHandle={fallbackWorldHandle} type={type} />;
	}
	return (
		<div className="readable-search-result readable-activity-result">
			<div className="readable-event-title">{humanizeKey(type)}</div>
			<ReadableGenericFields record={activity} />
		</div>
	);
}

export function ReadableThreadActivity({
	activity,
	displayContext,
	fallbackWorldHandle,
}: {
	activity: JsonRecord;
	displayContext: ReadableDisplayContext;
	fallbackWorldHandle?: string;
}) {
	const worldHandle = worldHandleFromRecord(activity) ?? fallbackWorldHandle ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(activity);
	const threadId = threadIdFromRecord(activity);
	const title = stringValue(activity.title) ?? "thread";
	const body = readableActivityPreview(activity);
	return (
		<div className="readable-search-result readable-activity-result">
			<div className="readable-event-title">
				<span>Created</span>
				<ThreadReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} label={title} threadId={threadId} title={title} worldHandle={worldHandle} />
			</div>
			<div className="readable-event-meta">
				<ForumReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} worldHandle={worldHandle} />
				<span>{readableActivityCounts(activity)}</span>
				{stringValue(activity.createdAt) && <ShortDateLabel value={String(activity.createdAt)} />}
			</div>
			{body && <ReadableQuote text={body} />}
		</div>
	);
}

export function ReadableCommentActivity({
	activity,
	displayContext,
	fallbackWorldHandle,
}: {
	activity: JsonRecord;
	displayContext: ReadableDisplayContext;
	fallbackWorldHandle?: string;
}) {
	const worldHandle = worldHandleFromRecord(activity) ?? fallbackWorldHandle ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(activity);
	const threadId = threadIdFromRecord(activity);
	const commentId = commentIdFromRecord(activity);
	const title = stringValue(activity.threadTitle ?? activity.title) ?? "thread";
	const parentComment = recordValue(activity.parentComment);
	const parentCommentId = commentIdFromValue(parentComment.commentRef ?? parentComment.commentId ?? activity.parentCommentRef ?? activity.parentCommentId);
	const parentBody = readableActivityPreview(parentComment);
	const body = readableActivityPreview(activity);
	return (
		<div className="readable-search-result readable-activity-result">
			<div className="readable-event-title">
				<span>Replied in</span>
				<ThreadReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} label={title} threadId={threadId} title={title} worldHandle={worldHandle} />
			</div>
			<div className="readable-event-meta">
				<ForumReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} worldHandle={worldHandle} />
				<ThreadReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} commentId={commentId} forumHandle={forumHandle} label="comment" threadId={threadId} worldHandle={worldHandle} />
				<span>{`${numberValue(activity.voteScore) ?? 0} votes`}</span>
				{stringValue(activity.createdAt) && <ShortDateLabel value={String(activity.createdAt)} />}
			</div>
			{parentCommentId && (
				<div className="readable-event-meta">
					<span>to</span>
					{profileHasHandle(parentComment) && <ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={parentComment} worldHandle={worldHandle} />}
					<ThreadReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} commentId={parentCommentId} forumHandle={forumHandle} label="parent comment" threadId={threadId} worldHandle={worldHandle} />
				</div>
			)}
			{parentBody && <ReadableQuote label="Parent comment" text={parentBody} />}
			{body && <ReadableQuote label="Reply" text={body} />}
		</div>
	);
}

export function ReadableVoteActivity({
	activity,
	displayContext,
	fallbackWorldHandle,
}: {
	activity: JsonRecord;
	displayContext: ReadableDisplayContext;
	fallbackWorldHandle?: string;
}) {
	const worldHandle = worldHandleFromRecord(activity) ?? fallbackWorldHandle ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(activity);
	const threadId = threadIdFromRecord(activity);
	const commentId = commentIdFromValue(activity.commentRef ?? activity.commentId ?? activity.targetId);
	const title = stringValue(activity.title);
	const targetComment = recordValue(activity.targetComment);
	const targetBody = readableActivityPreview(targetComment);
	const reason = textValueForDisplay(activity.reason);
	const value = numberValue(activity.value);
	return (
		<div className="readable-search-result readable-activity-result">
			<div className="readable-event-title">
				<span>{voteActionLabel(value)}</span>
				{profileHasHandle(targetComment) ? <><ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={targetComment} worldHandle={worldHandle} /><span>’s</span></> : null}
				<ThreadReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} commentId={commentId} forumHandle={forumHandle} label="comment" threadId={threadId} worldHandle={worldHandle} />
				{title ? <><span>in</span><ThreadReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} label={title} threadId={threadId} title={title} worldHandle={worldHandle} /></> : null}
			</div>
			<div className="readable-event-meta">
				<ForumReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} worldHandle={worldHandle} />
				<span>{(value ?? 0) > 0 ? "+1" : (value ?? 0) < 0 ? "-1" : "cleared"}</span>
				{stringValue(activity.updatedAt ?? activity.createdAt) && <ShortDateLabel value={String(activity.updatedAt ?? activity.createdAt)} />}
			</div>
			{targetBody && <ReadableQuote label="Voted comment" text={targetBody} />}
			{reason && <ReadableQuote label="Reason" text={trimReadableSnippet(reason)} />}
		</div>
	);
}

export function ReadableFollowActivity({
	activity,
	displayContext,
	fallbackWorldHandle,
	type,
}: {
	activity: JsonRecord;
	displayContext: ReadableDisplayContext;
	fallbackWorldHandle?: string;
	type: "follow" | "unfollow";
}) {
	const profile = firstProfileRecord(activity.profile, activity.bot);
	const worldHandle = worldHandleFromRecord(profile) ?? fallbackWorldHandle ?? displayContext.worldHandle;
	const reason = textValueForDisplay(activity.reason) ?? textValueForDisplay(profile.shortBio);
	return (
		<div className="readable-search-result readable-activity-result">
			<div className="readable-event-title">
				<span>{type === "follow" ? "Followed" : "Unfollowed"}</span>
				<ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} profile={profile} worldHandle={worldHandle} />
			</div>
			<div className="readable-event-meta">
				{worldHandle && <span>w/{worldHandle}</span>}
				{stringValue(activity.createdAt) && <ShortDateLabel value={String(activity.createdAt)} />}
			</div>
			{reason && <ReadableQuote text={trimReadableSnippet(reason)} />}
		</div>
	);
}

export function readableActivityPreview(record: JsonRecord): string | undefined {
	const text = textValueForDisplay(record.bodyPreview ?? record.body ?? record.snippet);
	return text ? trimReadableSnippet(text) : undefined;
}

export function readableActivityCounts(activity: JsonRecord): string {
	return `${numberValue(activity.voteScore) ?? 0} votes / ${countLabel(numberValue(activity.commentCount) ?? 0, "comment")}`;
}

export function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function ReadableGenericResult({ value }: { value: unknown }) {
	if (typeof value === "string") {
		return <div className="tool-text">{value}</div>;
	}
	if (Array.isArray(value)) {
		return value.length === 0 ? <div className="tool-text">No results.</div> : <div className="tool-text">{value.length} result{value.length === 1 ? "" : "s"} returned.</div>;
	}
	const record = recordValue(value);
	const message = textValueForDisplay(record.message ?? record.status ?? record.context);
	return message ? <div className="tool-text">{message}</div> : <ReadableGenericFields record={record} />;
}

export function ReadableGenericFields({ record }: { record: JsonRecord }) {
	const entries = Object.entries(record)
		.filter(([key, value]) => !lowLevelDisplayKey(key) && isDisplayPrimitive(value))
		.slice(0, 6);
	if (entries.length === 0) {
		return <div className="tool-text">The action completed.</div>;
	}
	return (
		<div className="readable-field-list">
			{entries.map(([key, value]) => (
				<div key={key}>
					<span>{humanizeKey(key)}</span>
					<b>{String(value)}</b>
				</div>
			))}
		</div>
	);
}

export function ReadableContentChain({
	content,
	displayContext,
	fallbackThread,
}: {
	content: unknown[];
	displayContext: ReadableDisplayContext;
	fallbackThread?: JsonRecord;
}) {
	if (content.length === 0) {
		return <div className="tool-text">No readable content was included.</div>;
	}
	const fallbackWorld = fallbackThread ? worldHandleFromRecord(fallbackThread) ?? displayContext.worldHandle : displayContext.worldHandle;
	const fallbackForum = fallbackThread ? forumHandleFromRecord(fallbackThread) : undefined;
	const fallbackThreadId = fallbackThread ? threadIdFromRecord(fallbackThread) : undefined;
	const items = readableContentTree(content);
	return (
		<div className="readable-chain">
			{items.map((itemValue, index) => (
				<ReadableContentItem
					depth={0}
					displayContext={displayContext}
					fallbackForum={fallbackForum}
					fallbackThreadId={fallbackThreadId}
					fallbackWorld={fallbackWorld}
					item={itemValue}
					key={`${commentIdFromRecord(itemValue) ?? threadIdFromRecord(itemValue) ?? "item"}-${index}`}
				/>
			))}
		</div>
	);
}

export function ReadableContentItem({
	depth,
	displayContext,
	fallbackForum,
	fallbackThreadId,
	fallbackWorld,
	item,
}: {
	depth: number;
	displayContext: ReadableDisplayContext;
	fallbackForum?: string;
	fallbackThreadId?: string;
	fallbackWorld?: string;
	item: JsonRecord;
}) {
	const type = readableContentType(item);
	const worldHandle = worldHandleFromRecord(item) ?? fallbackWorld;
	const forumHandle = forumHandleFromRecord(item) ?? fallbackForum;
	const threadId = threadIdFromRecord(item) ?? fallbackThreadId;
	const commentId = commentIdFromValue(item.commentRef ?? item.commentId ?? (type === "comment" ? item.id : undefined));
	const title = stringValue(item.title);
	const body = textValueForDisplay(item.body);
	const author = recordValue(item.author);
	const authorProfile = profileHasHandle(author) ? author : item;
	const authorUsername = stringValue(item.author);
	const hasAuthor = profileHasHandle(authorProfile) || Boolean(usernameHandle(authorUsername));
	const omittedReplies = numberValue(item.replies) ?? 0;
	const replies = Array.isArray(item.replies) ? readableContentTree(item.replies).filter(isReadableCommentItem) : [];
	const isFocusedComment = item["My focus is on this comment"] === true || item.target === true;
	const className = [
		"readable-chain-item",
		`kind-${type}`,
		`depth-${Math.min(depth, 3)}`,
		isFocusedComment ? "is-target" : "",
		item.ancestorOnly === true ? "is-context" : "",
	].filter(Boolean).join(" ");
	return (
		<div className="readable-chain-branch">
			<div className={className}>
				<div className="readable-chain-head">
					{type === "thread" ?
						<span className="readable-badge">thread</span>
					:	<ThreadReference
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
							commentId={commentId}
							forumHandle={forumHandle}
							label="Comment"
							threadId={threadId}
							worldHandle={worldHandle}
						/>
					}
					{item.ancestorOnly === true && <span className="readable-badge">context</span>}
					{type === "comment" && hasAuthor && <span className="readable-muted">by</span>}
					{type === "comment" && hasAuthor && (
						<ProfileReference
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
							profile={authorProfile}
							username={authorUsername}
							worldHandle={worldHandle}
						/>
					)}
					{type === "thread" && (
						<ThreadReference
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
							forumHandle={forumHandle}
							label={title ?? "thread"}
							threadId={threadId}
							title={title}
							worldHandle={worldHandle}
						/>
					)}
				</div>
				{body && <ReadableQuote text={body} />}
			</div>
			{replies.length > 0 && (
				<div className="readable-chain-replies">
					{replies.map((reply, index) => (
						<ReadableContentItem
							depth={depth + 1}
							displayContext={displayContext}
							fallbackForum={forumHandle}
							fallbackThreadId={threadId}
							fallbackWorld={worldHandle}
							item={reply}
							key={`${commentIdFromRecord(reply) ?? threadIdFromRecord(reply) ?? "reply"}-${index}`}
						/>
					))}
				</div>
			)}
			{omittedReplies > 0 && (
				<div className="readable-chain-omitted">
					{omittedReplies} {omittedReplies === 1 ? "reply" : "replies"} omitted
				</div>
			)}
		</div>
	);
}

export function readableContentTree(content: unknown[]): JsonRecord[] {
	const roots: JsonRecord[] = [];
	const comments: JsonRecord[] = [];
	for (const itemValue of content) {
		const item = recordValue(itemValue);
		if (isReadableCommentItem(item)) {
			comments.push({
				...item,
				replies: readableRepliesValue(item.replies),
			});
		} else if (Object.keys(item).length > 0) {
			roots.push(item);
		}
	}
	return [...roots, ...readableNestedCommentList(comments)];
}

export function readableNestedCommentList(comments: JsonRecord[]): JsonRecord[] {
	const byId = new Map<string, JsonRecord>();
	const ordered = comments.map((comment) => {
		const node: JsonRecord = {
			...comment,
			replies: readableRepliesValue(comment.replies),
		};
		const id = readableCommentId(node);
		if (id) {
			byId.set(id, node);
		}
		return node;
	});
	const roots: JsonRecord[] = [];
	for (const node of ordered) {
		const parentId = stringValue(node.parentCommentId);
		const parent = parentId ? byId.get(parentId) : undefined;
		if (parent && parent !== node) {
			const replies = arrayValue(parent.replies).map(recordValue);
			const nodeId = readableCommentId(node);
			if (!nodeId || !replies.some((reply) => readableCommentId(reply) === nodeId)) {
				replies.push(node);
			}
			parent.replies = replies;
		} else {
			roots.push(node);
		}
	}
	return roots;
}

export function readableRepliesValue(value: unknown): JsonRecord[] | number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.floor(value));
	}
	return Array.isArray(value) ? readableNestedCommentList(value.map(recordValue).filter(isReadableCommentItem)) : [];
}

export function readableContentType(item: JsonRecord): "thread" | "comment" {
	return isReadableCommentItem(item) ? "comment" : "thread";
}

export function isReadableCommentItem(item: JsonRecord): boolean {
	return stringValue(item.type) === "comment" || Boolean(commentIdFromRecord(item));
}

export function readableCommentId(item: JsonRecord): string | undefined {
	return commentIdFromRecord(item);
}
