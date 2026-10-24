import { Children, Fragment, type ReactNode } from "react";
import { textValueForDisplay } from "../reasoning-formatting";
import type { ReadableDisplayContext } from "./loop-message-readable";
import {
	ProfileReference,
	ReadableQuote,
	ThreadReference,
	arrayValue,
	commentIdFromRecord,
	commentIdFromValue,
	forumHandleFromRecord,
	humanizeKey,
	isDisplayPrimitive,
	lowLevelDisplayKey,
	recordValue,
	stringValue,
	threadIdFromRecord,
	trimReadableSnippet,
	worldHandleFromRecord,
	type JsonRecord,
} from "./loop-message-values";

export function ReadableToolPhrase({ children, className = "tool-pretty" }: { children: ReactNode; className?: string }) {
	const parts = Children.toArray(children);
	return (
		<div className={className + " tool-phrase"}>
			{parts.map((part, index) => (
				<Fragment key={index}>
					{index > 0 ? " " : null}{part}
				</Fragment>
			))}
		</div>
	);
}

// Tool-call previews consume provider arguments, which are intentionally
// JSON-shaped. Keep their compatibility probing separate from result dispatch.
export function ReadablePostingReply({ args, displayContext, result }: { args: JsonRecord; displayContext: ReadableDisplayContext; result?: unknown }) {
	const resultRecord = recordValue(result);
	const thread = recordValue(resultRecord.thread);
	const targetCommentId = commentIdFromValue(args.commentRef ?? args.commentId ?? args.parentCommentRef ?? args.parentCommentId);
	const comments = flattenLegacyComments(arrayValue(thread.comments).map(recordValue));
	const targetComment = targetCommentId ? comments.find((comment) => commentIdFromRecord(comment) === targetCommentId) : undefined;
	const threadId = threadIdFromRecord(args) ?? threadIdFromRecord(thread);
	const worldHandle = worldHandleFromRecord(thread) ?? worldHandleFromRecord(args) ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(thread) ?? forumHandleFromRecord(args);
	const title = stringValue(thread.title);
	const targetBody = textValueForDisplay(targetComment?.body);
	const replyBody = textValueForDisplay(args.body);
	return (
		<div className="tool-pretty tool-list">
			<ReadableToolPhrase className="tool-pretty-item">
				<span>Replying to</span>
				<ThreadReference
					allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					commentId={targetCommentId}
					forumHandle={forumHandle}
					label={targetCommentId ? "comment" : title ?? "thread"}
					threadId={threadId}
					title={targetCommentId ? undefined : title}
					worldHandle={worldHandle}
				/>
			</ReadableToolPhrase>
			{targetBody && <ReadableQuote label="Target comment" text={trimReadableSnippet(targetBody)} />}
			{replyBody && <ReadableQuote label="Reply" text={replyBody} />}
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
			<ReadableToolPhrase className="tool-pretty-item">
				<span>{isFollowing ? "Looking for profiles following" : "Looking for profiles followed by"}</span>
				{username ?
					<ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} username={username} worldHandle={worldHandle} />
				:	<span>profile</span>}
			</ReadableToolPhrase>
			{glob && (
				<ReadableToolPhrase className="tool-pretty-item">
					<span className="tool-pretty-label">Username filter</span>
					<span>{glob}</span>
				</ReadableToolPhrase>
			)}
		</div>
	);
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
				<ReadableToolPhrase className="readable-field-phrase" key={key}>
					<span>{humanizeKey(key)}</span>
					<b>{String(value)}</b>
				</ReadableToolPhrase>
			))}
		</div>
	);
}

function flattenLegacyComments(comments: JsonRecord[]): JsonRecord[] {
	return comments.flatMap((comment) => [comment, ...flattenLegacyComments(arrayValue(comment.replies).map(recordValue))]);
}
