import { InferenceBadge } from "../../components/inference-attribution";
import {
	useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
	type ComponentProps, type CSSProperties,
} from "react";
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
import { SpotlightTargetCheckbox } from "./spotlight-target-checkbox";
import type { SubscriptionTarget } from "../subscriptions";

import { commentIndentLimit, layoutCommentTree, type CommentLayoutRow, type CommentTreeNode } from "./comment-layout";

export function CommentNode({
	comment,
	forumHandle,
	implied,
	layout,
	parentAvailable = true,
	onGoToParent,
	parentHighlighted = false,
	onReference,
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
	layout?: CommentLayoutRow;
	parentAvailable?: boolean;
	onGoToParent?: (parentId: string) => void;
	parentHighlighted?: boolean;
	onReference: OpenReference;
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
	const isTarget = targetCommentId === comment.id;
	const isRootComment = comment.id === rootCommentId;
	const commentHref = `${window.location.pathname.split("/c/")[0]}/c/${encodeURIComponent(comment.id)}`;
	const commentRef = formatCommentRef(comment.id);
	const subscribed = subscriptions.some((subscription) =>
		subscription.scopeType === "comment" && subscription.scopeId === comment.id && subscription.active,
	);
	const hasParentArrow = !isRootComment && Boolean(comment.parentCommentId);
	return (
		<div
			className={`comment ${isTarget ? "flash" : ""} ${indeterminate ? "implied" : ""} ${parentHighlighted ? "parent-highlight" : ""}`}
			data-display-depth={layout?.depth ?? 0}
			style={{ "--comment-depth": layout?.depth ?? 0 } as CSSProperties}
			id={commentDomId(comment.id)}
		>
			{layout?.rails.map((rail) => (
				<span
					aria-hidden="true"
					className={`comment-rail ${rail.kind} ${layout.zeroIndent ? "zero-indent" : ""}`}
					key={`${rail.depth}-${rail.kind}`}
					style={{ "--rail-depth": rail.depth } as CSSProperties}
				/>
			))}
			{layout && layout.connector !== "none" && (
				<span aria-hidden="true" className={`comment-connector ${layout.connector} ${layout.zeroIndent ? "zero-indent" : ""}`} />
			)}
			<div
				aria-hidden={onToggle ? undefined : true}
				className={onToggle ? "checkcell" : "checkcell placeholder"}
			>
				{onToggle && (
					<SpotlightTargetCheckbox
						checked={checked}
						indeterminate={indeterminate}
						label="Spotlight this reply chain"
						onToggle={(next) => onToggle(comment.id, next)}
					/>
				)}
			</div>
			{hasParentArrow && (
				<button
					aria-label={parentAvailable ? "Go to parent comment" : "Parent comment is unavailable"}
					className="comment-parent-link"
					disabled={!parentAvailable}
					onClick={() => onGoToParent?.(comment.parentCommentId!)}
					title={parentAvailable ? "Go to parent comment" : "Parent comment is unavailable"}
					type="button"
				>⮤</button>
			)}
			<div className="head">
				<span className="comment-author-line">
					<Avatar actor="bot" colorSeed={comment.authorHandle} crop={comment.authorAvatarCrop} imageUrl={comment.authorAvatarUrl} name={comment.authorDisplayName} size="sm" />
					<AuthorReference
						displayName={comment.authorDisplayName}
						handle={comment.authorHandle}
						onOpen={() => onReference("bot", comment.authorHandle, { worldHandle })}
					/>
					<InferenceBadge attribution={comment.inferenceAttribution} />
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
				commentBodyId={comment.id}
				directionMode="lines"
				markdown
				onReference={onReference}
				rich
				text={comment.body}
				verticalScriptLayout="block"
				worldHandle={worldHandle}
			/>
		</div>
	);
}

type CommentNodeProps = ComponentProps<typeof CommentNode>;

type CommentTreeProps = Omit<CommentNodeProps, "comment" | "layout" | "parentAvailable" | "onGoToParent" | "parentHighlighted"> & {
	roots: CommentTreeNode[];
	canDeleteComment?: (comment: CommentDocument) => boolean;
};

export function CommentTree({ roots, canDeleteComment, ...props }: CommentTreeProps) {
	const treeRef = useRef<HTMLDivElement>(null);
	const probeRef = useRef<HTMLSpanElement>(null);
	const [indentLimit, setIndentLimit] = useState(0);
	const [parentHighlight, setParentHighlight] = useState<string | null>(null);
	const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const rows = useMemo(() => layoutCommentTree(roots, indentLimit), [roots, indentLimit]);
	const availableIds = useMemo(() => new Set(rows.map((row) => row.comment.id)), [rows]);

	useLayoutEffect(() => {
		const tree = treeRef.current;
		const probe = probeRef.current;
		if (!tree || !probe) return;
		const measure = () => {
			const firstRow = tree.querySelector<HTMLElement>(".comment");
			if (!firstRow) return;
			const style = getComputedStyle(firstRow);
			const gutter = parseFloat(style.gridTemplateColumns.split(" ")[0]!) || 18;
			const gap = parseFloat(style.columnGap) || 0;
			setIndentLimit(commentIndentLimit(tree.getBoundingClientRect().width, window.innerWidth, gutter + gap, probe.getBoundingClientRect().width));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(tree);
		observer.observe(probe);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [roots.length]);

	useEffect(() => () => {
		if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
	}, []);

	const goToParent = useCallback((id: string) => {
		const parent = document.getElementById(commentDomId(id));
		if (!parent) return;
		parent.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
		setParentHighlight(id);
		if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
		highlightTimer.current = setTimeout(() => {
			setParentHighlight(null);
			highlightTimer.current = null;
		}, 1800);
	}, []);

	return (
		<div className="comment-tree" ref={treeRef}>
			<span aria-hidden="true" className="comment-width-probe" ref={probeRef} />
			{roots.length === 0 && <div className="empty compact-empty">No comments yet.</div>}
			{rows.map((row) => (
				<CommentNode
					{...props}
					comment={row.comment}
					key={row.comment.id}
					layout={row}
					onRequestDelete={canDeleteComment?.(row.comment) ? props.onRequestDelete : undefined}
					onGoToParent={goToParent}
					parentAvailable={availableIds.has(row.comment.parentCommentId ?? "")}
					parentHighlighted={parentHighlight === row.comment.id}
				/>
			))}
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

/**
 * The comments a reply-chain Spotlight actually covers: the checked ones plus
 * every ancestor the chain implies, which is also what the panel displays as
 * included. Spotlight prefill quotes exactly this set.
 */
export function spotlightTargetCommentIds(selectedIds: string[], parentById: Map<string, string | null>): string[] {
	return [...new Set([...selectedIds, ...impliedAncestorIds(selectedIds, parentById)])];
}

export function commentDomId(commentId: string): string {
	return `comment-${commentId}`;
}
