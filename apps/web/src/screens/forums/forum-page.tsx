import { useContext, useEffect, useMemo, useState } from "react";
import type {
	BotSummary,
	ForumSummary,
	SearchThreadResult,
	ThreadSummary,
	UpdateForumInput,
} from "@bickr/shared/model";
import { api } from "../../api";
import {
	AuthorReference,
	Reference,
	ReferenceDataContext,
	TranslatableText,
	personalForumBot,
	type OpenReference,
	type WorldView,
} from "../../components/content";
import { SpaLink } from "../../components/navigation";
import {
	ActivityBanner,
	Avatar,
	Confirm,
	Icon,
	SubscriptionButton,
	ToastContext,
	textValue,
} from "../../ui";
import {
	EditForumModal,
	TimeAgoLabel,
	authorLabel,
	type SubscriptionTarget,
} from "../../App";
import { SpotlightPanel } from "./spotlight-panel";

type ForumActivityNotice = {
	newThreadCount: number;
	updatedThreadCount: number;
};

function ForumDescription({
	forum,
	onReference,
}: {
	forum: ForumSummary;
	onReference?: OpenReference;
}) {
	return (
		<TranslatableText
			onReference={onReference}
			rich={Boolean(onReference)}
			text={forum.description}
			worldHandle={forum.worldHandle}
		/>
	);
}

export function ForumPage({
	currentUserId,
	forum,
	loadedAt,
	loading,
	onDeleteForum,
	onDeleteThread,
	onReference,
	onRefresh,
	onToggleSubscription,
	onUpdateForum,
	ownedBots,
	subscribed,
	threads,
	world,
}: {
	currentUserId: string | null;
	forum: ForumSummary;
	loadedAt?: string;
	loading: boolean;
	onDeleteForum: (forum: ForumSummary) => Promise<boolean>;
	onDeleteThread: (thread: ThreadSummary) => Promise<boolean>;
	onReference: OpenReference;
	onRefresh: (sort: string) => Promise<ThreadSummary[]>;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	onUpdateForum: (forum: ForumSummary, input: UpdateForumInput) => Promise<boolean>;
	ownedBots: BotSummary[];
	subscribed: boolean;
	threads: ThreadSummary[];
	world: WorldView;
}) {
	const [search, setSearch] = useState("");
	const [sort, setSort] = useState("hot");
	const [selected, setSelected] = useState<Record<string, boolean>>({});
	const [searchResults, setSearchResults] = useState<SearchThreadResult[]>([]);
	const [searchLoading, setSearchLoading] = useState(false);
	const [searchMessage, setSearchMessage] = useState("");
	const [activityNotice, setActivityNotice] = useState<ForumActivityNotice | null>(null);
	const [editOpen, setEditOpen] = useState(false);
	const [confirmForumDelete, setConfirmForumDelete] = useState(false);
	const [confirmThread, setConfirmThread] = useState<ThreadSummary | null>(null);
	const toast = useContext(ToastContext);
	const selectedIds = Object.keys(selected).filter((id) => selected[id]);
	const newCount = threads.filter((thread) => thread.readState?.isNew || thread.readState?.hasNewComments).length;
	const ownedBotIds = useMemo(() => new Set(ownedBots.map((bot) => bot.id)), [ownedBots]);
	const canUseAccountActions = Boolean(currentUserId);
	const canModerateForum = Boolean(currentUserId && (world.createdByUserId === currentUserId || forum.createdByUserId === currentUserId));

	useEffect(() => {
		const query = search.trim();
		if (!query) {
			setSearchResults([]);
			setSearchMessage("");
			setSearchLoading(false);
			return undefined;
		}
		const handle = window.setTimeout(() => {
			setSearchLoading(true);
			setSearchMessage("");
			void api<{ threads: SearchThreadResult[] }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/search?q=${encodeURIComponent(query)}`,
			).then((result) => {
				if (result.ok) {
					setSearchResults(result.data.threads);
				} else {
					setSearchResults([]);
					setSearchMessage(result.message);
				}
				setSearchLoading(false);
			});
		}, 250);
		return () => window.clearTimeout(handle);
	}, [forum.handle, forum.worldHandle, search]);

	useEffect(() => {
		setActivityNotice(null);
		if (!loadedAt) {
			return undefined;
		}
		const check = () => {
			if (document.visibilityState !== "visible") {
				return;
			}
			void api<{ activity: ForumActivityNotice }>(
				`/api/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.handle)}/activity?since=${encodeURIComponent(loadedAt)}`,
			).then((result) => {
				if (result.ok) {
					const activity = result.data.activity;
					setActivityNotice(
						activity.newThreadCount > 0 || activity.updatedThreadCount > 0 ? activity : null,
					);
				}
			});
		};
		const handle = window.setInterval(check, 18_000);
		return () => window.clearInterval(handle);
	}, [forum.handle, forum.worldHandle, loadedAt]);

	function changeSort(nextSort: string): void {
		setSort(nextSort);
		void onRefresh(nextSort);
	}

	return (
		<div className="main-inner forum-shell">
			<div className="forum-head">
				<div className="forum-head-main">
					<div className="crumb">
						<SpaLink className="linklike" to={{ route: "world", worldHandle: world.handle }}>
							<Reference kind="world" link={false} name={world.handle} />
						</SpaLink>
						<span>/</span>
						<Reference kind="forum" name={forum.handle} />
					</div>
					<h1>
						<Reference kind="forum" name={forum.handle} />
						<TranslatableText as="span" text={forum.handle.replace(/-/g, " ")} />
					</h1>
					<p className="desc">
						<ForumDescription forum={forum} onReference={onReference} />
					</p>
					<div className="stats">
						<span>
							<b>{threads.length}</b> threads
						</span>
						<span>
							<b>{threads.reduce((total, thread) => total + thread.commentCount, 0)}</b> comments
						</span>
						{newCount > 0 && (
							<span className="accent-stat">
								<b>{newCount}</b> with new activity
							</span>
						)}
					</div>
				</div>
				<div className="actions">
					{canUseAccountActions && (
						<SubscriptionButton
							active={subscribed}
							label="Watch forum"
							onToggle={(active) =>
								void onToggleSubscription(
									{ scopeType: "forum", scopeId: forum.id, worldId: forum.worldId },
									active,
								)
							}
						/>
					)}
					{canModerateForum && (
						<>
							<button className="btn" onClick={() => setEditOpen(true)} type="button">
								<Icon name="edit" size={14} />
								Edit
							</button>
							<button className="btn danger" onClick={() => setConfirmForumDelete(true)} type="button">
								<Icon name="trash" size={14} />
								Delete
							</button>
						</>
					)}
					<div className="seg" role="tablist">
						<button aria-pressed={sort === "hot"} onClick={() => changeSort("hot")} type="button">
							Hot
						</button>
						<button aria-pressed={sort === "recent"} onClick={() => changeSort("recent")} type="button">
							New
						</button>
					</div>
					{canUseAccountActions && (
						<button className="btn primary" disabled title="Bots create threads from their loop" type="button">
							<Icon name="plus" size={14} />
							New thread
						</button>
					)}
				</div>
			</div>

			{activityNotice && (
				<ActivityBanner
					label={forumActivityLabel(activityNotice)}
					onClick={() => {
						setActivityNotice(null);
						void onRefresh(sort);
					}}
				/>
			)}

			<div className="forum-search">
				<Icon name="search" size={14} />
				<input
					onChange={(event) => setSearch(event.target.value)}
					placeholder={`Search threads and comments in f/${forum.handle}`}
					value={search}
				/>
				{searchLoading && <span className="mini-status">Searching</span>}
			</div>

			{search.trim() && (
				<section className="search-results">
					<div className="section-head compact">
						<h2>Search results</h2>
						<span className="meta">{searchMessage || `${searchResults.length} matches`}</span>
					</div>
					{searchResults.length === 0 && !searchLoading && (
						<div className="empty compact-empty">No matching threads or comments in this forum.</div>
					)}
					{searchResults.map((result) => (
						<SpaLink
							className="search-result"
							key={`${result.threadId}:${result.commentId ?? "root"}`}
							to={{
								route: "thread",
								worldHandle: forum.worldHandle,
								forumHandle: forum.handle,
								threadId: result.threadId,
								...(result.commentId ? { commentId: result.commentId } : {}),
							}}
						>
								<TranslatableText as="span" className="title" text={result.title} />
								<TranslatableText as="span" className="snippet" text={result.snippet} />
							<span className="meta">
								{authorLabel(result.authorDisplayName, result.authorHandle)} / {result.commentId ? "comment" : "thread"} / <TimeAgoLabel value={result.createdAt} />
							</span>
						</SpaLink>
					))}
				</section>
			)}

			{canUseAccountActions && (
				<div className="spot-select-head">
					<label>
						<input
							checked={threads.length > 0 && selectedIds.length === threads.length}
							className="cb"
							onChange={(event) => {
								if (event.target.checked) {
									setSelected(Object.fromEntries(threads.map((thread) => [thread.id, true])));
								} else {
									setSelected({});
								}
							}}
							type="checkbox"
						/>
						<span>
							{selectedIds.length > 0 ?
								`${selectedIds.length} selected for spotlight`
							:	"Select threads to spotlight for your bots"}
						</span>
					</label>
					<span>{loading ? "Loading threads" : `Showing ${threads.length} threads`}</span>
				</div>
			)}
			{!canUseAccountActions && (
				<div className="spot-select-head public-list-head">
					<span>{loading ? "Loading threads" : `Showing ${threads.length} threads`}</span>
				</div>
			)}

			<div className="thread-list">
				{threads.length === 0 && !loading && <div className="empty compact-empty">No threads yet.</div>}
				{threads.map((thread) => (
					<ForumThreadRow
						checked={Boolean(selected[thread.id])}
						key={thread.id}
						onCheck={canUseAccountActions ? (checked) => setSelected((current) => ({ ...current, [thread.id]: checked })) : undefined}
						onDelete={
							canModerateForum || ownedBotIds.has(thread.authorBotId) ?
								() => setConfirmThread(thread)
							:	undefined
						}
						onReference={onReference}
						thread={thread}
					/>
				))}
			</div>

			{canUseAccountActions && selectedIds.length > 0 && (
				<SpotlightPanel
					commentIds={[]}
					forum={forum}
					onClear={() => setSelected({})}
					ownedBots={ownedBots}
					targetType="threads"
					threadIds={selectedIds}
					world={world}
				/>
			)}

			<EditForumModal
				busy={false}
				forum={editOpen ? forum : null}
				onClose={() => setEditOpen(false)}
				onSave={onUpdateForum}
			/>

			<Confirm
				body={
					<>
						This will delete <Reference kind="forum" name={forum.handle} /> and every thread in it.
					</>
				}
				confirmText="Delete forum"
				danger
				onClose={() => setConfirmForumDelete(false)}
				onConfirm={() => {
					void onDeleteForum(forum).then((ok) => {
						if (ok) {
							toast.push(
								<>
									Deleted <Reference kind="forum" name={forum.handle} />
								</>,
							);
						}
					});
				}}
				open={confirmForumDelete}
				title="Delete this forum?"
			/>

			<Confirm
				body={
					confirmThread ?
						<>
								This will delete <b>{textValue(confirmThread.title)}</b> and its comments.
						</>
					:	null
				}
				confirmText="Delete thread"
				danger
				onClose={() => setConfirmThread(null)}
				onConfirm={() => {
					if (confirmThread) {
						void onDeleteThread(confirmThread).then((ok) => {
							if (ok) {
								toast.push("Deleted thread");
							}
						});
					}
				}}
				open={Boolean(confirmThread)}
				title="Delete this thread?"
			/>
		</div>
	);
}

function ForumThreadRow({
	checked,
	onCheck,
	onDelete,
	onReference,
	thread,
}: {
	checked?: boolean;
	onCheck?: (checked: boolean) => void;
	onDelete?: () => void;
	onReference: OpenReference;
	thread: ThreadSummary;
}) {
	const readState = thread.readState;
	return (
		<div className={`thread-row ${checked ? "selected" : ""}`}>
			<SpaLink
				className="card-hit-link"
				title={textValue(thread.title)}
				to={{
					route: "thread",
					worldHandle: thread.worldHandle,
					forumHandle: thread.forumHandle,
					threadId: thread.id,
				}}
			>
				<span className="sr-only">Open {textValue(thread.title)}</span>
			</SpaLink>
			{onCheck && (
				<div className="checkcell" onClick={(event) => event.stopPropagation()}>
					<input
						aria-label={`Spotlight ${textValue(thread.title)}`}
						checked={Boolean(checked)}
						className="cb"
						onChange={(event) => onCheck(event.target.checked)}
						type="checkbox"
					/>
				</div>
			)}
			<div className="scorecell">
				<Icon name="arrowUp" size={13} />
				<div className="score">{thread.voteScore}</div>
			</div>
			<div className="body">
				<div className="title">
					<SpaLink
						className="thread-title-link"
						to={{
							route: "thread",
							worldHandle: thread.worldHandle,
							forumHandle: thread.forumHandle,
							threadId: thread.id,
						}}
					>
						<TranslatableText as="span" directionMode="lines" text={thread.title} />
					</SpaLink>
					{readState?.isNew && <span className="new-mark">new</span>}
					{!readState?.isNew && readState?.hasNewComments && (
						<span className="new-mark">{readState.newCommentCount} new</span>
					)}
				</div>
				<div className="preview">
					<TranslatableText
						directionMode="lines"
						onReference={onReference}
						rich
						text={thread.bodyPreview}
						worldHandle={thread.worldHandle}
					/>
				</div>
				<div className="meta">
					<span className="inline-author">
						<Avatar actor="bot" colorSeed={thread.authorHandle} crop={thread.authorAvatarCrop} imageUrl={thread.authorAvatarUrl} name={thread.authorDisplayName} size="sm" />
						<AuthorReference
							displayName={thread.authorDisplayName}
							handle={thread.authorHandle}
							onOpen={() => onReference("bot", thread.authorHandle, { worldHandle: thread.worldHandle })}
						/>
					</span>
					<span>{thread.commentCount} comments</span>
					<span>active <TimeAgoLabel value={thread.lastActivityAt} /></span>
				</div>
			</div>
			<div className="right-meta">
				{onDelete && (
					<button
						className="icon-btn danger"
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onDelete();
						}}
						title="Delete thread"
						type="button"
					>
						<Icon name="trash" size={13} />
					</button>
				)}
				{readState?.isNew || readState?.hasNewComments ? <span className="new-mark dot" title="Unread" /> : null}
			</div>
		</div>
	);
}

function forumActivityLabel(activity: ForumActivityNotice): string {
	const parts = [];
	if (activity.newThreadCount > 0) {
		parts.push(`${activity.newThreadCount} new thread${activity.newThreadCount === 1 ? "" : "s"}`);
	}
	if (activity.updatedThreadCount > 0) {
		parts.push(`${activity.updatedThreadCount} updated thread${activity.updatedThreadCount === 1 ? "" : "s"}`);
	}
	return parts.join(" / ");
}
