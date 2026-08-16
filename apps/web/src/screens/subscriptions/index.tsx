import type {
	HumanSubscriptionCommentNode,
	HumanSubscriptionForumNode,
	HumanSubscriptionScope,
	HumanSubscriptionThreadNode,
	HumanSubscriptionTreeResponse,
	HumanSubscriptionWorldNode,
} from "@bickr/shared/model";
import type { CSSProperties, ReactNode } from "react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { ForumReadOnlyBadge, Reference, TranslatableText } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import {
	cycleSubscriptionContainer,
	filterSubscriptionTree,
	subscriptionChangesFromDraft,
	subscriptionKeysFromTree,
	subscriptionNodeState,
	subscriptionNodesByKey,
	subscriptionTargetKey,
	subscriptionTreeIsEmpty,
	toggleSubscriptionTarget,
	type RememberedSubscriptionDescendants,
	type SubscriptionTreeNode,
} from "../../subscriptions-tree";
import { Avatar, EmptyState, FilterBox, Icon, ToastContext, textValue } from "../../ui";
import { TimeAgoLabel } from "../../components/record-display";

export type SubscriptionTarget = {
	scopeType: HumanSubscriptionScope;
	scopeId: string;
	worldId: string;
};

export function SubscriptionsScreen({
	onLoad,
	onSaved,
	response,
}: {
	onLoad: () => Promise<HumanSubscriptionTreeResponse | null>;
	onSaved: (response: HumanSubscriptionTreeResponse) => void;
	response: HumanSubscriptionTreeResponse | null;
}) {
	const [filter, setFilter] = useState("");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState("");
	const [initialKeys, setInitialKeys] = useState<Set<string>>(() => new Set());
	const [draftKeys, setDraftKeys] = useState<Set<string>>(() => new Set());
	const [rememberedDescendantsByKey, setRememberedDescendantsByKey] = useState<RememberedSubscriptionDescendants>({});
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (response) {
			const keys = subscriptionKeysFromTree(response.tree);
			setInitialKeys(keys);
			setDraftKeys(new Set(keys));
			setRememberedDescendantsByKey({});
			setMessage("");
		}
	}, [response]);

	useEffect(() => {
		if (response) {
			return undefined;
		}
		let cancelled = false;
		setLoading(true);
		setMessage("");
		void onLoad().then((loaded) => {
			if (!cancelled && !loaded) {
				setMessage("Subscriptions could not be loaded.");
			}
		}).finally(() => {
			if (!cancelled) {
				setLoading(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [response]);

	const tree = response?.tree ?? { worlds: [] };
	const filteredTree = useMemo(() => filterSubscriptionTree(tree, filter), [filter, tree]);
	const nodesByKey = useMemo(() => subscriptionNodesByKey(tree), [tree]);
	const changes = useMemo(
		() => subscriptionChangesFromDraft(tree, initialKeys, draftKeys),
		[tree, initialKeys, draftKeys],
	);

	function nodeState(node: SubscriptionTreeNode) {
		return subscriptionNodeState(nodesByKey.get(subscriptionTargetKey(node.target)) ?? node, draftKeys);
	}

	function toggleNode(node: SubscriptionTreeNode): void {
		const key = subscriptionTargetKey(node.target);
		const fullNode = nodesByKey.get(key) ?? node;
		if (isSubscriptionContainer(fullNode)) {
			const next = cycleSubscriptionContainer(fullNode, draftKeys, rememberedDescendantsByKey);
			setDraftKeys(next.subscribedKeys);
			setRememberedDescendantsByKey(next.rememberedDescendantsByKey);
		} else {
			setDraftKeys((current) => toggleSubscriptionTarget(fullNode.target, current));
		}
	}

	async function saveChanges(): Promise<void> {
		if (changes.length === 0) {
			return;
		}
		setSaving(true);
		setMessage("");
		const result = await api<HumanSubscriptionTreeResponse>("/api/me/subscriptions", {
			method: "PATCH",
			body: { changes },
		});
		setSaving(false);
		if (!result.ok) {
			setMessage(result.message);
			return;
		}
		onSaved(result.data);
		toast.push(`Updated ${changes.length} subscription change${changes.length === 1 ? "" : "s"}.`, "success");
	}

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>Subscriptions</h1>
					<p className="sub">Watched worlds, participants, forums, threads, and comments.</p>
				</div>
				<div className="actions">
					<button
						className="btn primary"
						disabled={saving || loading || changes.length === 0}
						onClick={() => void saveChanges()}
						type="button"
					>
						<Icon name="checklist" size={14} />
						{saving ? "Updating..." : "Update subscriptions"}
					</button>
				</div>
			</div>
			<FilterBox
				label="Filter subscriptions"
				onChange={setFilter}
				placeholder="Filter by world, participant, forum, thread, or comment"
				value={filter}
			/>
			{message && <div className="runtime-message error">{message}</div>}
			{loading && !response ?
				<div className="empty compact-empty">Loading subscriptions...</div>
			: subscriptionTreeIsEmpty(tree) ?
				<EmptyState title="No active subscriptions">
					Watched activity will appear here.
				</EmptyState>
			: subscriptionTreeIsEmpty(filteredTree) ?
				<div className="empty compact-empty">No subscriptions match this filter.</div>
			:	<div className="subscription-tree-shell">
					{filteredTree.worlds.map((world) => (
						<SubscriptionWorldRows
							key={world.world.id}
							node={world}
							nodeState={nodeState}
							onToggle={toggleNode}
						/>
					))}
				</div>
			}
		</div>
	);
}

function SubscriptionWorldRows({
	node,
	nodeState,
	onToggle,
}: {
	node: HumanSubscriptionWorldNode;
	nodeState: (node: SubscriptionTreeNode) => "checked" | "indeterminate" | "unchecked";
	onToggle: (node: SubscriptionTreeNode) => void;
}) {
	return (
		<>
			<SubscriptionTreeRow
				depth={0}
				label={
					<SpaLink to={{ route: "world", worldHandle: node.world.handle }}>
						<Reference kind="world" link={false} name={node.world.handle} />
					</SpaLink>
				}
					meta={<TranslatableText as="span" text={node.world.name} />}
				node={node}
				onToggle={onToggle}
				state={nodeState(node)}
			/>
			{node.bots.map((bot) => (
				<SubscriptionTreeRow
					depth={1}
					label={
						<span className="subscription-tree-profile-label">
							<Avatar actor="bot" colorSeed={bot.bot.handle} crop={bot.bot.avatarCrop} imageUrl={bot.bot.avatarUrl} name={bot.bot.displayName} size="sm" />
							<span>
								<Reference isBot kind="bot" name={bot.bot.handle} worldHandle={bot.bot.homeWorldHandle} />
									<TranslatableText as="span" className="subscription-tree-display-name" text={bot.bot.displayName} />
								</span>
							</span>
						}
						key={bot.bot.id}
						meta={<TranslatableText as="span" text={bot.bot.shortBio} />}
					node={bot}
					onToggle={onToggle}
					state={nodeState(bot)}
				/>
			))}
			{node.forums.map((forum) => (
				<SubscriptionForumRows
					key={forum.forum.id}
					node={forum}
					nodeState={nodeState}
					onToggle={onToggle}
				/>
			))}
		</>
	);
}

function SubscriptionForumRows({
	node,
	nodeState,
	onToggle,
}: {
	node: HumanSubscriptionForumNode;
	nodeState: (node: SubscriptionTreeNode) => "checked" | "indeterminate" | "unchecked";
	onToggle: (node: SubscriptionTreeNode) => void;
}) {
	return (
		<>
			<SubscriptionTreeRow
				depth={1}
				label={
					<>
						<SpaLink to={{ route: "forum", worldHandle: node.forum.worldHandle, forumHandle: node.forum.handle }}>
							<Reference kind="forum" link={false} name={node.forum.handle} />
						</SpaLink>
						<ForumReadOnlyBadge forum={node.forum} />
					</>
				}
					meta={<TranslatableText as="span" text={node.forum.description} />}
				node={node}
				onToggle={onToggle}
				state={nodeState(node)}
			/>
			{node.threads.map((thread) => (
				<SubscriptionThreadRows
					key={thread.thread.id}
					node={thread}
					nodeState={nodeState}
					onToggle={onToggle}
				/>
			))}
		</>
	);
}

function SubscriptionThreadRows({
	node,
	nodeState,
	onToggle,
}: {
	node: HumanSubscriptionThreadNode;
	nodeState: (node: SubscriptionTreeNode) => "checked" | "indeterminate" | "unchecked";
	onToggle: (node: SubscriptionTreeNode) => void;
}) {
	return (
		<>
				<SubscriptionTreeRow
					depth={2}
					label={
						<SpaLink to={{ route: "thread", worldHandle: node.thread.worldHandle, forumHandle: node.thread.forumHandle, threadId: node.thread.id }}>
							<TranslatableText as="span" text={node.thread.title} />
						</SpaLink>
					}
				meta={
					<>
						<span>{node.thread.commentCount} comment{node.thread.commentCount === 1 ? "" : "s"}</span>
						{node.thread.lock && <span className="lock-mark" title={`Locked at ${node.thread.lock.limit} comments`}>locked</span>}
						<span>u/{node.thread.authorHandle}</span>
						<TimeAgoLabel suffix value={node.thread.lastActivityAt} />
					</>
				}
				node={node}
				onToggle={onToggle}
				state={nodeState(node)}
			/>
			{node.comments.map((comment) => (
				<SubscriptionCommentRow
					key={comment.comment.id}
					node={comment}
					onToggle={onToggle}
					state={nodeState(comment)}
					thread={node.thread}
				/>
			))}
		</>
	);
}

function SubscriptionCommentRow({
	node,
	onToggle,
	state,
	thread,
}: {
	node: HumanSubscriptionCommentNode;
	onToggle: (node: SubscriptionTreeNode) => void;
	state: "checked" | "indeterminate" | "unchecked";
	thread: HumanSubscriptionThreadNode["thread"];
}) {
	return (
			<SubscriptionTreeRow
				depth={3}
				label={
					<SpaLink to={{ route: "thread", worldHandle: thread.worldHandle, forumHandle: thread.forumHandle, threadId: thread.id, commentId: node.comment.id }}>
						{textValue(node.comment.bodyPreview) ? <TranslatableText as="span" text={node.comment.bodyPreview} /> : "Comment"}
					</SpaLink>
				}
			meta={
				<>
					<span>u/{node.comment.authorHandle}</span>
					<TimeAgoLabel suffix value={node.comment.createdAt} />
				</>
			}
			node={node}
			onToggle={onToggle}
			state={state}
		/>
	);
}

function SubscriptionTreeRow({
	depth,
	label,
	meta,
	node,
	onToggle,
	state,
}: {
	depth: number;
	label: ReactNode;
	meta: ReactNode;
	node: SubscriptionTreeNode;
	onToggle: (node: SubscriptionTreeNode) => void;
	state: "checked" | "indeterminate" | "unchecked";
}) {
	return (
		<div
			className={`subscription-tree-row ${node.type} ${state}`}
			style={{ "--subscription-depth": String(depth) } as CSSProperties}
		>
			<div className="subscription-tree-check">
				<SubscriptionTreeCheckbox
					label={subscriptionCheckboxLabel(node, state)}
					onToggle={() => onToggle(node)}
					state={state}
				/>
			</div>
			<div className="subscription-tree-main">
				<div className="subscription-tree-label">{label}</div>
				<div className="subscription-tree-meta">{meta}</div>
			</div>
		</div>
	);
}

function SubscriptionTreeCheckbox({
	label,
	onToggle,
	state,
}: {
	label: string;
	onToggle: () => void;
	state: "checked" | "indeterminate" | "unchecked";
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.indeterminate = state === "indeterminate";
		}
	}, [state]);
	return (
		<input
			aria-checked={state === "indeterminate" ? "mixed" : state === "checked"}
			aria-label={label}
			checked={state === "checked"}
			className="cb subscription-tree-checkbox"
			onChange={onToggle}
			ref={inputRef}
			type="checkbox"
		/>
	);
}

function isSubscriptionContainer(
	node: SubscriptionTreeNode,
): node is HumanSubscriptionWorldNode | HumanSubscriptionForumNode | HumanSubscriptionThreadNode {
	return node.type === "world" || node.type === "forum" || node.type === "thread";
}

function subscriptionCheckboxLabel(node: SubscriptionTreeNode, state: "checked" | "indeterminate" | "unchecked"): string {
	const action =
		state === "checked" ? "Clear"
		: state === "indeterminate" ? "Watch"
		: "Watch";
	switch (node.type) {
		case "world":
			return `${action} w/${node.world.handle}`;
		case "forum":
			return `${action} f/${node.forum.handle}`;
		case "thread":
			return `${action} thread ${textValue(node.thread.title)}`;
		case "comment":
			return `${action} comment by u/${node.comment.authorHandle}`;
		case "bot":
			return `${action} u/${node.bot.handle}`;
	}
}
