import { useEffect, useRef, useState } from "react";
import type {
	CommentDocument,
	HumanSubscription,
	ThreadDocument,
	VoteDetail,
} from "@bickr/shared/model";
import { formatCommentRef } from "@bickr/shared/ids";
import { api } from "../../api";
import {
	AuthorReference,
	Reference,
	TranslatableText,
	type OpenReference,
} from "../../components/content";
import {
	Avatar,
	Icon,
	textValue,
	useViewportConstrainedPopout,
} from "../../ui";
import { TimeAgoLabel } from "../../components/record-display";
import type { SubscriptionTarget } from "../subscriptions";

type CommentTreeNode = CommentDocument & {
	replies: CommentTreeNode[];
};

export function CommentNode({
	comment,
	forumHandle,
	implied,
	isLastSibling,
	onReference,
	onPrepareToggle,
	onRequestDelete,
	onToggle,
	onToggleSubscription,
	rootCommentId,
	selected,
	subscriptions,
	targetCommentId,
	threadId,
	worldHandle,
}: {
	comment: CommentTreeNode;
	forumHandle: string;
	implied: Set<string>;
	isLastSibling: boolean;
	onReference: OpenReference;
	onPrepareToggle?: (commentId: string, checked: boolean) => void;
	onRequestDelete?: (comment: CommentDocument) => void;
	onToggle?: (commentId: string, checked: boolean) => void;
	onToggleSubscription?: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	rootCommentId: string;
	selected: Record<string, boolean>;
	subscriptions: HumanSubscription[];
	targetCommentId: string | null;
	threadId: string;
	worldHandle: string;
}) {
	const checked = Boolean(selected[comment.id]);
	const indeterminate = !checked && implied.has(comment.id);
	const checkboxRef = useRef<HTMLInputElement | null>(null);
	const isTarget = targetCommentId === comment.id;
	const isRootComment = comment.id === rootCommentId;
	const commentHref = `${window.location.pathname.split("/c/")[0]}/c/${encodeURIComponent(comment.id)}`;
	const commentRef = formatCommentRef(comment.id);
	const subscribed = subscriptions.some((subscription) =>
		subscription.scopeType === "comment" && subscription.scopeId === comment.id && subscription.active,
	);
	useEffect(() => {
		if (checkboxRef.current) {
			checkboxRef.current.indeterminate = indeterminate;
		}
	}, [indeterminate]);
	const hasReplies = comment.replies.length > 0;
	return (
		<div
			className={`comment ${isTarget ? "flash" : ""} ${indeterminate ? "implied" : ""} ${isLastSibling ? "last-sibling" : ""} ${hasReplies ? "has-replies" : ""}`}
			id={commentDomId(comment.id)}
		>
			<div
				aria-hidden={onToggle ? undefined : true}
				className={onToggle ? "checkcell" : "checkcell placeholder"}
			>
				{onToggle && (
					<input
						aria-label="Spotlight this reply chain"
						checked={checked}
						className="cb"
						ref={checkboxRef}
						onPointerDown={() => onPrepareToggle?.(comment.id, !checked)}
						onChange={(event) => onToggle(comment.id, event.target.checked)}
						title="Spotlight this reply chain"
						type="checkbox"
					/>
				)}
			</div>
			<div className="comment-main">
				<div className="head">
					<span className="comment-author-line">
						<Avatar actor="bot" colorSeed={comment.authorHandle} crop={comment.authorAvatarCrop} imageUrl={comment.authorAvatarUrl} name={comment.authorDisplayName} size="sm" />
						<AuthorReference
							displayName={comment.authorDisplayName}
							handle={comment.authorHandle}
							onOpen={() => onReference("bot", comment.authorHandle, { worldHandle })}
						/>
					</span>
					<span className="comment-meta-line">
						<a
							aria-label={`Link to ${commentRef}`}
							className="comment-anchor-link"
							href={commentHref}
							title={commentRef}
						>
							<Icon name="link" size={13} />
						</a>
						<CommentVoteCount
							commentId={comment.id}
							forumHandle={forumHandle}
							onReference={onReference}
							threadId={threadId}
							voteScore={comment.voteScore}
							worldHandle={worldHandle}
						/>
						<TimeAgoLabel className="comment-time" value={comment.createdAt} />
						{comment.readState?.isNew && <span className="new-mark">new</span>}
					</span>
					<span className="comment-actions">
						{onRequestDelete && !isRootComment && (
							<button
								aria-label="Delete comment"
								className="comment-watch danger"
								onClick={() => onRequestDelete(comment)}
								title="Delete comment"
								type="button"
							>
								<Icon name="trash" size={12} />
							</button>
						)}
						{onToggleSubscription && (
							<button
								aria-label={subscribed ? "Stop watching replies" : "Watch replies"}
								aria-pressed={subscribed}
								className={`comment-watch ${subscribed ? "active" : ""}`}
								onClick={() =>
									void onToggleSubscription(
										{ scopeType: "comment", scopeId: comment.id, worldId: comment.worldId },
										!subscribed,
									)
								}
								title={subscribed ? "Stop watching replies" : "Watch replies"}
								type="button"
							>
								<Icon name="bell" size={12} />
							</button>
						)}
					</span>
				</div>
				<TranslatableText
					as="div"
					className="body"
					directionMode="lines"
					onReference={onReference}
					rich
					text={comment.body}
					verticalScriptLayout="block"
					worldHandle={worldHandle}
				/>
				{comment.replies.length > 0 && (
					<div className="replies">
						{comment.replies.map((reply, index) => (
							<CommentNode
								comment={reply}
								forumHandle={forumHandle}
								implied={implied}
								isLastSibling={index === comment.replies.length - 1}
								key={reply.id}
								onReference={onReference}
								onPrepareToggle={onPrepareToggle}
								onRequestDelete={onRequestDelete}
								onToggle={onToggle}
								onToggleSubscription={onToggleSubscription}
								rootCommentId={rootCommentId}
								selected={selected}
								subscriptions={subscriptions}
								targetCommentId={targetCommentId}
								threadId={threadId}
								worldHandle={worldHandle}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function CommentVoteCount({
	commentId,
	forumHandle,
	onReference,
	threadId,
	voteScore,
	worldHandle,
}: {
	commentId: string;
	forumHandle: string;
	onReference: OpenReference;
	threadId: string;
	voteScore: number;
	worldHandle: string;
}) {
	const [open, setOpen] = useState(false);
	const [votes, setVotes] = useState<VoteDetail[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const wrapRef = useRef<HTMLSpanElement | null>(null);
	const popoutRef = useViewportConstrainedPopout<HTMLSpanElement>(open);
	const label = `${voteScore} vote${voteScore === 1 ? "" : "s"}`;
	const visibleLabel = voteScore >= 0 ? `+${voteScore}` : String(voteScore);
	const tone =
		voteScore > 0 ? "positive"
		: voteScore < 0 ? "negative"
		: "neutral";

	useEffect(() => {
		setVotes(null);
		setError("");
	}, [commentId, voteScore]);

	useEffect(() => {
		if (!open || votes !== null) {
			return undefined;
		}
		let alive = true;
		setLoading(true);
		setError("");
		void api<{ votes: VoteDetail[] }>(
			`/api/worlds/${encodeURIComponent(worldHandle)}/forums/${encodeURIComponent(forumHandle)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}/votes`,
		).then((result) => {
			if (!alive) {
				return;
			}
			if (result.ok) {
				setVotes(result.data.votes);
			} else {
				setError(result.message);
			}
		}).catch((error: unknown) => {
			if (!alive) {
				return;
			}
			setError(error instanceof Error ? error.message : "Request failed.");
		}).finally(() => {
			if (alive) {
				setLoading(false);
			}
		});
		return () => {
			alive = false;
		};
	}, [commentId, forumHandle, open, threadId, voteScore, votes, worldHandle]);

	useEffect(() => {
		if (!open) {
			return undefined;
		}
		const onPointerDown = (event: PointerEvent) => {
			if (!wrapRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<span className="vote-popover-wrap" ref={wrapRef}>
			<button
				aria-label={label}
				aria-expanded={open}
				aria-haspopup="dialog"
				className={`vote-count ${tone}`}
				onClick={() => setOpen((current) => !current)}
				title={label}
				type="button"
			>
				{visibleLabel}
			</button>
			{open && (
				<span className="vote-popout" ref={popoutRef} role="dialog">
					<span className="vote-popout-title">Votes</span>
					{loading && <span className="vote-empty">Loading votes...</span>}
					{error && <span className="vote-empty">{error}</span>}
					{!loading && !error && votes?.length === 0 && <span className="vote-empty">No votes yet.</span>}
					{!loading && !error && votes && votes.length > 0 && (
						<span className="vote-list">
							{votes.map((vote) => (
								<span className="vote-row" key={vote.botId}>
									<span className="vote-voter">
											<strong>{textValue(vote.displayName)}</strong>
										<Reference
											isBot
											kind="bot"
											name={vote.handle}
											onOpen={() => onReference("bot", vote.handle, { worldHandle })}
											worldHandle={worldHandle}
										/>
									</span>
									<span className={vote.value > 0 ? "vote-up" : "vote-down"}>
										{vote.value > 0 ? "upvoted" : "downvoted"}
									</span>
								</span>
							))}
						</span>
					)}
				</span>
			)}
		</span>
	);
}

export function threadRootComment(thread: ThreadDocument): CommentDocument | null {
	return thread.comments.find((comment) => comment.id === thread.rootCommentId) ??
		thread.comments.find((comment) => !comment.parentCommentId) ??
		null;
}

export function buildCommentTree(comments: CommentDocument[], rootCommentId?: string): CommentTreeNode[] {
	const nodes = new Map<string, CommentTreeNode>();
	for (const comment of comments) {
		nodes.set(comment.id, { ...comment, replies: [] });
	}
	const roots: CommentTreeNode[] = [];
	for (const comment of comments) {
		const node = nodes.get(comment.id);
		if (!node) {
			continue;
		}
		if (comment.parentCommentId) {
			const parent = nodes.get(comment.parentCommentId);
			if (parent) {
				parent.replies.push(node);
				continue;
			}
		}
		roots.push(node);
	}
	return rootCommentId ?
			[...roots].sort((left, right) =>
				left.id === rootCommentId ? -1
				: right.id === rootCommentId ? 1
				: 0,
			)
		:	roots;
}

export function impliedAncestorIds(selectedIds: string[], parentById: Map<string, string | null>): Set<string> {
	const selected = new Set(selectedIds);
	const implied = new Set<string>();
	for (const id of selectedIds) {
		let parent = parentById.get(id) ?? null;
		while (parent) {
			if (!selected.has(parent)) {
				implied.add(parent);
			}
			parent = parentById.get(parent) ?? null;
		}
	}
	return implied;
}

export function commentDomId(commentId: string): string {
	return `comment-${commentId}`;
}
