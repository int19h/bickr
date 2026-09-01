import { localizedTextString, type CommentDocument, type ThreadDocument } from "@bickr/shared/model";
import type {
	RandomRangeTarget,
	ToolResultContentItem,
	ToolResultEnvelope,
	ToolResultProfileAction,
	ToolResultVote,
} from "@bickr/shared/tool-results";
import type { ReactNode } from "react";
import type { ReadableDisplayContext } from "./loop-message-readable";
import {
	ForumReference,
	JsonSyntaxBlock,
	ProfileReference,
	ReadableQuote,
	ThreadReference,
} from "./loop-message-values";

type ResultKind = ToolResultEnvelope["kind"];
type EnvelopeOf<Kind extends ResultKind> = Extract<ToolResultEnvelope, { kind: Kind }>;
type ResultRendererTable = {
	[Kind in ResultKind]: (payload: EnvelopeOf<Kind>, displayContext: ReadableDisplayContext) => ReactNode;
};

/**
 * The only dispatch point for readable tool results. Adding a result kind to
 * ToolResultEnvelope is a compile error here until its presentation is chosen.
 */
export const readableToolResultRenderers = {
	thread_created: ({ thread }, displayContext) => (
		<ReadableThreadCard displayContext={displayContext} thread={thread} />
	),
	comment_created: ({ comment, thread }, displayContext) => (
		<ReadableCommentCard comment={comment} displayContext={displayContext} thread={thread} />
	),
	vote_set: ({ votes }, displayContext) => (
		<ReadableResultList empty="No votes were recorded.">
			{votes.map((vote, index) => (
				<ReadableVoteLine displayContext={displayContext} key={vote.activityId ?? `${vote.commentId}-${index}`} vote={vote} />
			))}
		</ReadableResultList>
	),
	profile_followed: ({ profiles }, displayContext) => (
		<ReadableResultList empty="No profiles were followed.">
			{profiles.map((action, index) => (
				<ReadableProfileRow action={action} displayContext={displayContext} key={action.activityId ?? `${action.username}-${index}`} />
			))}
		</ReadableResultList>
	),
	profile_unfollowed: ({ profiles }, displayContext) => (
		<ReadableResultList empty="No profiles were unfollowed.">
			{profiles.map((action, index) => (
				<ReadableProfileRow action={action} displayContext={displayContext} key={action.activityId ?? `${action.username}-${index}`} />
			))}
		</ReadableResultList>
	),
	content_read: ({ items }, displayContext) => (
		<ReadableResultList empty="No readable content was returned.">
			{items.map((item, index) => {
				const thread = item.kind === "comment" ? items.find((candidate): candidate is Extract<ToolResultContentItem, { kind: "thread" }> => (
					candidate.kind === "thread" && candidate.id === item.threadId
				)) : undefined;
				return <ReadableContentResultItem displayContext={displayContext} item={item} key={`${item.kind}-${item.id}-${index}`} thread={thread} />;
			})}
		</ReadableResultList>
	),
	random_integers_drawn: ({ numbers, ranges }) => (
		<ReadableResultList empty="No numbers were drawn.">
			{numbers.map((value, index) => (
				<ReadableRandomNumberLine key={`${index}-${value}`} range={ranges[index]} value={value} />
			))}
		</ReadableResultList>
	),
	opaque: ({ value }) => <JsonSyntaxBlock value={value} />,
} satisfies ResultRendererTable;

export function ReadableToolResultEnvelope({
	displayContext,
	envelope,
}: {
	displayContext: ReadableDisplayContext;
	envelope: ToolResultEnvelope;
}) {
	// The table and payload share the same discriminant. TypeScript cannot retain
	// that correlation through an indexed mapped type, so the cast stays here.
	const renderer = readableToolResultRenderers[envelope.kind] as (
		payload: ToolResultEnvelope,
		displayContext: ReadableDisplayContext,
	) => ReactNode;
	return renderer(envelope, displayContext);
}

export function ReadableThreadCard({
	displayContext,
	thread,
}: {
	displayContext: ReadableDisplayContext;
	thread: ThreadDocument;
}) {
	const rootComment = thread.comments.find((comment) => comment.id === thread.rootCommentId);
	const worldHandle = thread.worldHandle || displayContext.worldHandle;
	return (
		<div className="readable-search-result readable-thread-card">
			<div className="readable-event-title">
				{rootComment && (
					<>
						<span>Thread by</span>
						<ProfileReference
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
							username={rootComment.authorHandle}
							worldHandle={worldHandle}
						/>
					</>
				)}
				<ThreadReference
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					forumHandle={thread.forumHandle}
					label={localizedTextString(thread.title) || "thread"}
					threadId={thread.id}
					title={localizedTextString(thread.title) || undefined}
					worldHandle={worldHandle}
				/>
			</div>
			<div className="readable-event-meta">
				<ForumReference
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					forumHandle={thread.forumHandle}
					worldHandle={worldHandle}
				/>
				<span>{thread.voteScore} votes</span>
				<span>{thread.commentCount} comments</span>
			</div>
			{rootComment && <ReadableQuote text={localizedTextString(rootComment.body)} />}
		</div>
	);
}

export function ReadableCommentCard({
	comment,
	displayContext,
	thread,
}: {
	comment: CommentDocument;
	displayContext: ReadableDisplayContext;
	thread: ThreadDocument;
}) {
	const parent = comment.parentCommentId ? thread.comments.find((item) => item.id === comment.parentCommentId) : undefined;
	const worldHandle = thread.worldHandle || displayContext.worldHandle;
	const title = localizedTextString(thread.title) || "thread";
	return (
		<div className="readable-search-result readable-comment-card">
			<div className="readable-event-title">
				<span>Comment by</span>
				<ProfileReference
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					username={comment.authorHandle}
					worldHandle={worldHandle}
				/>
				<span>in</span>
				<ThreadReference
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					commentId={comment.id}
					forumHandle={thread.forumHandle}
					label={title}
					threadId={thread.id}
					title={title}
					worldHandle={worldHandle}
				/>
			</div>
			{parent && <ReadableQuote label="Parent comment" text={localizedTextString(parent.body)} />}
			<ReadableQuote label="Comment" text={localizedTextString(comment.body)} />
		</div>
	);
}

export function ReadableProfileRow({
	action,
	displayContext,
}: {
	action: ToolResultProfileAction;
	displayContext: ReadableDisplayContext;
}) {
	const worldHandle = action.profile.homeWorldHandle || displayContext.worldHandle;
	return (
		<div className="readable-profile-card">
			<div className="readable-profile-title">
				<span>{action.following ? "Followed" : "Unfollowed"}</span>
				<ProfileReference
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					username={action.username}
					worldHandle={worldHandle}
				/>
				<span>{localizedTextString(action.profile.displayName)}</span>
			</div>
			{action.reason && <ReadableQuote label="Reason" text={localizedTextString(action.reason)} />}
		</div>
	);
}

export function ReadableVoteLine({
	displayContext,
	vote,
}: {
	displayContext: ReadableDisplayContext;
	vote: ToolResultVote;
}) {
	const worldHandle = vote.thread.worldHandle || displayContext.worldHandle;
	const label = vote.value > 0 ? "Upvoted" : vote.value < 0 ? "Downvoted" : "Cleared vote on";
	const target = vote.thread.comments.find((comment) => comment.id === vote.commentId);
	return (
		<div className="tool-pretty-item readable-vote-line">
			<div className="readable-event-title">
				<span>{label}</span>
				<ThreadReference
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					commentId={vote.commentId}
					forumHandle={vote.thread.forumHandle}
					label="comment"
					threadId={vote.thread.id}
					worldHandle={worldHandle}
				/>
			</div>
			{target && <ReadableQuote label="Voted comment" text={localizedTextString(target.body)} />}
			{vote.reason && <ReadableQuote label="Reason" text={localizedTextString(vote.reason)} />}
		</div>
	);
}

export function ReadableContentResultItem({
	displayContext,
	item,
	thread,
}: {
	displayContext: ReadableDisplayContext;
	item: ToolResultContentItem;
	thread?: Extract<ToolResultContentItem, { kind: "thread" }>;
}) {
	if (item.kind === "thread") {
		const title = localizedTextString(item.title) || "thread";
		const worldHandle = item.worldHandle || displayContext.worldHandle;
		return (
			<div className="readable-search-result readable-thread-card">
				<div className="readable-event-title">
					<span>Thread</span>
					{item.authorHandle && (
						<>
							<span>by</span>
							<ProfileReference
								allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
								username={item.authorHandle}
								worldHandle={worldHandle}
							/>
						</>
					)}
					<ThreadReference
						allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
						forumHandle={item.forumHandle}
						label={title}
						threadId={item.id}
						title={title}
						worldHandle={worldHandle}
					/>
				</div>
				{item.body && <ReadableQuote text={localizedTextString(item.body)} />}
			</div>
		);
	}
	const worldHandle = item.worldHandle || thread?.worldHandle || displayContext.worldHandle;
	const forumHandle = item.forumHandle || thread?.forumHandle;
	const title = localizedTextString(item.title ?? thread?.title) || "thread";
	return (
		<div className="readable-search-result readable-comment-card">
			<div className="readable-event-title">
				<span>{item.authorHandle ? "Comment by" : "Comment in"}</span>
				{item.authorHandle && (
					<>
						<ProfileReference
							allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
							username={item.authorHandle}
							worldHandle={worldHandle}
						/>
						<span>in</span>
					</>
				)}
				<ThreadReference
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					commentId={item.id}
					forumHandle={forumHandle}
					label={title}
					threadId={item.threadId}
					title={title}
					worldHandle={worldHandle}
				/>
			</div>
			{item.body && <ReadableQuote text={localizedTextString(item.body)} />}
		</div>
	);
}

export function ReadableRandomNumberLine({ range, value }: { range?: RandomRangeTarget; value: number }) {
	return (
		<div className="tool-pretty-item readable-random-number-line">
			<span className="tool-pretty-label">{randomRangeLabel(range)}</span>
			<span>{value}</span>
		</div>
	);
}

export function randomRangeLabel(range?: RandomRangeTarget): string {
	if (!range) {
		return "Drawn";
	}
	return range.min === range.max ? `Fixed at ${range.min}` : `${range.min} to ${range.max}`;
}

function ReadableResultList({ children, empty }: { children: ReactNode; empty: string }) {
	const count = Array.isArray(children) ? children.length : children ? 1 : 0;
	return count > 0 ? <div className="tool-pretty tool-list">{children}</div> : <div className="tool-text">{empty}</div>;
}
