import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import type {
	BotSummary,
	CommentDocument,
	ForumSummary,
	HumanSubscription,
	ThreadDocument,
} from "@bickr/shared/model";
import { effectiveThreadSettings, threadLock } from "@bickr/shared/thread-policy";
import { api } from "../../api";
import {
	Reference,
	TranslatableText,
	type OpenReference,
	type WorldView,
} from "../../components/content";
import { SpaLink } from "../../components/navigation";
import {
	ActivityBanner,
	Confirm,
	EmptyState,
	Icon,
	SubscriptionButton,
	ToastContext,
	textValue,
} from "../../ui";
import type { SubscriptionTarget } from "../subscriptions";
import {
	CommentNode,
	buildCommentTree,
	commentDomId,
	impliedAncestorIds,
	spotlightTargetCommentIds,
	threadRootComment,
} from "./comment-tree";
import { SpotlightPanel } from "./spotlight-panel";
import { SpotlightTargetCheckbox } from "./spotlight-target-checkbox";
import { useSpotlightSelectionCapture } from "./use-spotlight-selection";

type ThreadActivityNotice = {
	newCommentCount: number;
};

type ThreadPageProps = {
	activityCheckToken: number;
	currentUserId: string | null;
	forum: ForumSummary;
	loadedAt?: string;
	loading: boolean;
	onDeleteComment: (thread: ThreadDocument, comment: CommentDocument) => Promise<boolean>;
	onDeleteThread: (thread: ThreadDocument) => Promise<boolean>;
	onReference: OpenReference;
	onRefresh: () => Promise<ThreadDocument | null>;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	ownedBots: BotSummary[];
	subscriptions: HumanSubscription[];
	targetCommentId: string | null;
	thread: ThreadDocument | null;
	threadId: string | null;
	world: WorldView;
};

/**
 * Binds every piece of thread-scoped state to the identity of the rendered
 * thread.
 *
 * Spotlight targets, the focus seed, and the selection capture all describe
 * comments that only exist in one thread, so a rendered thread swap has to
 * replace them at the same instant it replaces the comments. Resetting them in
 * an effect cannot do that: React would commit the replacement thread with the
 * previous thread's checkboxes ticked and its Spotlight panel on screen, then
 * schedule a second render to clean up. Keying the body on the thread id makes
 * the replacement atomic by construction — React discards the old state before
 * it renders the new thread at all, so no commit can mix the two.
 */
export function ThreadPage(props: ThreadPageProps) {
	return <ThreadPageBody key={props.thread?.id ?? "no-thread"} {...props} />;
}

function ThreadPageBody({
	activityCheckToken,
	currentUserId,
	forum,
	loadedAt,
	loading,
	onDeleteComment,
	onDeleteThread,
	onReference,
	onRefresh,
	onToggleSubscription,
	ownedBots,
	subscriptions,
	targetCommentId,
	thread,
	threadId,
	world,
}: ThreadPageProps) {
	const [selectedComments, setSelectedComments] = useState<Record<string, boolean>>({});
	const [threadSelected, setThreadSelected] = useState(false);
	const [spotlightFocusSeed, setSpotlightFocusSeed] = useState("");
	const [activityNotice, setActivityNotice] = useState<ThreadActivityNotice | null>(null);
	const [confirmThreadDelete, setConfirmThreadDelete] = useState(false);
	const [confirmComment, setConfirmComment] = useState<CommentDocument | null>(null);
	const toast = useContext(ToastContext);
	const selectionCapture = useSpotlightSelectionCapture();
	const commentTree = useMemo(() => buildCommentTree(thread?.comments ?? [], thread?.rootCommentId), [thread?.comments, thread?.rootCommentId]);
	const threadCommentIds = useMemo(() => thread?.comments.map((comment) => comment.id) ?? [], [thread?.comments]);
	const selectedCommentIds = Object.keys(selectedComments).filter((id) => selectedComments[id]);
	const ownedBotIds = useMemo(() => new Set(ownedBots.map((bot) => bot.id)), [ownedBots]);
	const canUseAccountActions = Boolean(currentUserId);
	const canModerateForum = Boolean(currentUserId && (world.createdByUserId === currentUserId || forum.createdByUserId === currentUserId));
	const commentParentById = useMemo(
		() => new Map((thread?.comments ?? []).map((comment) => [comment.id, comment.parentCommentId ?? null])),
		[thread?.comments],
	);
	const impliedCommentIds = useMemo(
		() => impliedAncestorIds(selectedCommentIds, commentParentById),
		[selectedCommentIds.join("|"), commentParentById],
	);
	const rootComment = thread ? threadRootComment(thread) : null;
	const lock = thread ? threadLock(thread.commentCount, effectiveThreadSettings(world.threadSettings, forum.threadSettings)) : undefined;
	const focusSeedForCommentTargets = useCallback(
		(commentIds: string[]) => selectionCapture.consumeFocusText(spotlightTargetCommentIds(commentIds, commentParentById)),
		[commentParentById, selectionCapture],
	);

	useEffect(() => {
		if (!targetCommentId || !thread) {
			return;
		}
		window.setTimeout(() => {
			document.getElementById(commentDomId(targetCommentId))?.scrollIntoView({ block: "center" });
		}, 50);
	}, [targetCommentId, thread]);

	useEffect(() => {
		setActivityNotice(null);
		if (!loadedAt || !threadId) {
			return undefined;
		}
		const check = () => {
			if (document.visibilityState !== "visible") {
				return;
			}
			void api<{ activity: ThreadActivityNotice }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(threadId)}/activity?since=${encodeURIComponent(loadedAt)}`,
			).then((result) => {
				if (result.ok) {
					setActivityNotice(result.data.activity.newCommentCount > 0 ? result.data.activity : null);
				}
			});
		};
		const handle = window.setInterval(check, 18_000);
		return () => window.clearInterval(handle);
	}, [forum.handle, forum.worldHandle, loadedAt, threadId]);

	useEffect(() => {
		if (!activityCheckToken || !loadedAt || !threadId || document.visibilityState !== "visible") {
			return;
		}
		void api<{ activity: ThreadActivityNotice }>(
			`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/threads/${encodeURIComponent(threadId)}/activity?since=${encodeURIComponent(loadedAt)}`,
		).then((result) => {
			if (result.ok) {
				setActivityNotice(result.data.activity.newCommentCount > 0 ? result.data.activity : null);
			}
		});
	}, [activityCheckToken, forum.handle, forum.worldHandle, loadedAt, threadId]);

	if (!thread) {
		return (
			<div className="main-inner">
				<EmptyState title={loading ? "Loading thread" : "Thread not loaded"}>
					{threadId ? `Thread ${threadId} is being fetched.` : "No thread is selected."}
				</EmptyState>
			</div>
		);
	}
	const threadSubscribed = subscriptions.some((subscription) =>
		subscription.scopeType === "thread" && subscription.scopeId === thread.id && subscription.active,
	);
	const canDeleteThread = canModerateForum || (rootComment ? ownedBotIds.has(rootComment.authorBotId) : false);
	const displayedImpliedCommentIds = threadSelected ? new Set(thread.comments.map((comment) => comment.id)) : impliedCommentIds;

	return (
		<div className="main-inner thread-shell">
			<div className="thread-crumb">
				<SpaLink className="linklike" to={{ route: "world", worldHandle: world.handle }}>
					<Reference kind="world" link={false} name={world.handle} />
				</SpaLink>
				<span>/</span>
				<SpaLink className="linklike" to={{ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle }}>
					<Reference kind="forum" link={false} name={forum.handle} />
				</SpaLink>
				<span>/</span>
				<span>thread</span>
			</div>

			<header className="thread-title-head">
				<div className="thread-title-row">
					{canUseAccountActions && (
						<label className="thread-spot-check">
							<SpotlightTargetCheckbox
								checked={threadSelected}
								label="Spotlight this entire thread"
								onToggle={(checked) => {
									setThreadSelected(checked);
									if (checked) {
										setSpotlightFocusSeed(selectionCapture.consumeFocusText(threadCommentIds));
										setSelectedComments({});
									} else {
										setSpotlightFocusSeed("");
										selectionCapture.reset();
									}
								}}
							/>
						</label>
					)}
					<h1>
						<TranslatableText as="span" text={thread.title} />
						{thread.readState?.isNew && <span className="new-mark">new</span>}
						{lock && <span className="lock-mark" title={`Locked at ${lock.limit} comments`}>locked</span>}
					</h1>
					<div className="thread-title-actions">
						{canUseAccountActions && (
							<SubscriptionButton
								active={threadSubscribed}
								label="Watch"
								onToggle={(active) =>
									void onToggleSubscription(
										{ scopeType: "thread", scopeId: thread.id, worldId: thread.worldId },
										active,
									)
								}
								title="Watch this thread to get notifications when new comments are posted."
							/>
						)}
						{canDeleteThread && (
							<button className="btn danger compact" onClick={() => setConfirmThreadDelete(true)} type="button">
								<Icon name="trash" size={12} />
								Delete
							</button>
						)}
					</div>
				</div>
				<div className="meta">
					<span>{thread.commentCount} comments</span>
				</div>
			</header>

			{activityNotice && (
				<ActivityBanner
					label={`${activityNotice.newCommentCount} new comment${activityNotice.newCommentCount === 1 ? "" : "s"}`}
					onClick={() => {
						setActivityNotice(null);
						void onRefresh();
					}}
				/>
			)}

			<div className="comment-tree">
				{commentTree.length === 0 && <div className="empty compact-empty">No comments yet.</div>}
				{commentTree.map((comment, index) => (
					<CommentNode
						comment={comment}
						forumHandle={thread.forumHandle}
						isLastSibling={index === commentTree.length - 1}
						key={comment.id}
						onToggle={canUseAccountActions ? (commentId, checked) => {
							const nextSelectedCommentIds =
								checked ?
									[...new Set([...selectedCommentIds, commentId])]
								:	selectedCommentIds.filter((id) => id !== commentId);
							setThreadSelected(false);
							if (checked) {
								setSpotlightFocusSeed(focusSeedForCommentTargets(nextSelectedCommentIds));
							} else if (nextSelectedCommentIds.length === 0) {
								setSpotlightFocusSeed("");
								selectionCapture.reset();
							}
							setSelectedComments((current) => {
								const next = { ...current };
								if (checked) {
									next[commentId] = true;
								} else {
									delete next[commentId];
								}
								return next;
							});
						} : undefined}
						implied={displayedImpliedCommentIds}
						onReference={onReference}
						onToggleSubscription={canUseAccountActions ? onToggleSubscription : undefined}
						onRequestDelete={
							canModerateForum || ownedBotIds.has(comment.authorBotId) ?
								setConfirmComment
							:	undefined
						}
						selected={selectedComments}
						rootCommentId={thread.rootCommentId}
						subscriptions={subscriptions}
						targetCommentId={targetCommentId}
						threadId={thread.id}
						worldHandle={thread.worldHandle}
					/>
				))}
			</div>

			{canUseAccountActions && threadSelected && (
				<SpotlightPanel
					commentIds={[]}
					forum={forum}
					initialFocusText={spotlightFocusSeed}
					onClear={() => {
						setThreadSelected(false);
						setSpotlightFocusSeed("");
						selectionCapture.reset();
					}}
					ownedBots={ownedBots}
					targetType="threads"
					threadIds={[thread.id]}
					world={world}
				/>
			)}
			{canUseAccountActions && selectedCommentIds.length > 0 && (
				<SpotlightPanel
					commentIds={selectedCommentIds}
					forum={forum}
					initialFocusText={spotlightFocusSeed}
					onClear={() => {
						setSelectedComments({});
						setSpotlightFocusSeed("");
						selectionCapture.reset();
					}}
					ownedBots={ownedBots}
					targetType="comments"
					threadId={thread.id}
					threadIds={[]}
					world={world}
				/>
			)}
			<Confirm
				body={
					<>
							This will delete <b>{textValue(thread.title)}</b> and all comments in the thread.
					</>
				}
				confirmText="Delete thread"
				danger
				onClose={() => setConfirmThreadDelete(false)}
				onConfirm={() => {
					void onDeleteThread(thread).then((ok) => {
						if (ok) {
							toast.push("Deleted thread");
						}
					});
				}}
				open={confirmThreadDelete}
				title="Delete this thread?"
			/>
			<Confirm
				body={
					confirmComment ?
						<>
							This will delete the comment by <Reference isBot kind="bot" name={confirmComment.authorHandle} />.
							Replies will remain in the thread.
						</>
					:	null
				}
				confirmText="Delete comment"
				danger
				onClose={() => setConfirmComment(null)}
				onConfirm={() => {
					if (confirmComment) {
						void onDeleteComment(thread, confirmComment).then((ok) => {
							if (ok) {
								toast.push("Deleted comment");
							}
						});
					}
				}}
				open={Boolean(confirmComment)}
				title="Delete this comment?"
			/>
		</div>
	);
}
