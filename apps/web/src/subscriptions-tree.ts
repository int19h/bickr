import type {
	HumanSubscriptionChange,
	HumanSubscriptionCommentNode,
	HumanSubscriptionForumNode,
	HumanSubscriptionTarget,
	HumanSubscriptionThreadNode,
	HumanSubscriptionTree,
	HumanSubscriptionWorldNode,
	LocalizedText,
} from "@bickr/shared/model";
import { localizedTextString } from "@bickr/shared/model";

export type SubscriptionTreeNode =
	| HumanSubscriptionWorldNode
	| HumanSubscriptionForumNode
	| HumanSubscriptionThreadNode
	| HumanSubscriptionCommentNode
	| HumanSubscriptionWorldNode["bots"][number];

export type SubscriptionNodeState = "checked" | "indeterminate" | "unchecked";
export type RememberedSubscriptionDescendants = Record<string, string[]>;

export function subscriptionTargetKey(target: Pick<HumanSubscriptionTarget, "scopeType" | "scopeId">): string {
	return `${target.scopeType}:${target.scopeId}`;
}

export function subscriptionKeysFromTree(tree: HumanSubscriptionTree): Set<string> {
	const keys = new Set<string>();
	for (const node of allSubscriptionNodes(tree)) {
		if (node.subscription?.active) {
			keys.add(subscriptionTargetKey(node.target));
		}
	}
	return keys;
}

function subscriptionTargetsByKey(tree: HumanSubscriptionTree): Map<string, HumanSubscriptionTarget> {
	const targets = new Map<string, HumanSubscriptionTarget>();
	for (const node of allSubscriptionNodes(tree)) {
		targets.set(subscriptionTargetKey(node.target), node.target);
	}
	return targets;
}

export function subscriptionNodesByKey(tree: HumanSubscriptionTree): Map<string, SubscriptionTreeNode> {
	const nodes = new Map<string, SubscriptionTreeNode>();
	for (const node of allSubscriptionNodes(tree)) {
		nodes.set(subscriptionTargetKey(node.target), node);
	}
	return nodes;
}

export function subscriptionNodeState(
	node: SubscriptionTreeNode,
	subscribedKeys: ReadonlySet<string>,
): SubscriptionNodeState {
	if (subscribedKeys.has(subscriptionTargetKey(node.target))) {
		return "checked";
	}
	return descendantSubscriptionKeys(node).some((key) => subscribedKeys.has(key)) ? "indeterminate" : "unchecked";
}

export function cycleSubscriptionContainer(
	node: HumanSubscriptionWorldNode | HumanSubscriptionForumNode | HumanSubscriptionThreadNode,
	subscribedKeys: ReadonlySet<string>,
	rememberedDescendantsByKey: RememberedSubscriptionDescendants,
): { rememberedDescendantsByKey: RememberedSubscriptionDescendants; subscribedKeys: Set<string> } {
	const key = subscriptionTargetKey(node.target);
	const descendantKeys = descendantSubscriptionKeys(node);
	const descendantKeySet = new Set(descendantKeys);
	const state = subscriptionNodeState(node, subscribedKeys);
	const nextKeys = new Set(subscribedKeys);
	const nextRemembered = { ...rememberedDescendantsByKey };

	if (state === "indeterminate") {
		nextKeys.add(key);
		delete nextRemembered[key];
		return { subscribedKeys: nextKeys, rememberedDescendantsByKey: nextRemembered };
	}

	if (state === "checked") {
		const subscribedDescendants = descendantKeys.filter((descendantKey) => nextKeys.has(descendantKey));
		nextKeys.delete(key);
		for (const descendantKey of descendantKeys) {
			nextKeys.delete(descendantKey);
		}
		if (subscribedDescendants.length > 0) {
			nextRemembered[key] = subscribedDescendants;
		} else {
			delete nextRemembered[key];
		}
		return { subscribedKeys: nextKeys, rememberedDescendantsByKey: nextRemembered };
	}

	const remembered = (nextRemembered[key] ?? []).filter((descendantKey) => descendantKeySet.has(descendantKey));
	if (remembered.length > 0) {
		for (const descendantKey of remembered) {
			nextKeys.add(descendantKey);
		}
		nextKeys.delete(key);
		delete nextRemembered[key];
		return { subscribedKeys: nextKeys, rememberedDescendantsByKey: nextRemembered };
	}

	nextKeys.add(key);
	return { subscribedKeys: nextKeys, rememberedDescendantsByKey: nextRemembered };
}

export function toggleSubscriptionTarget(
	target: HumanSubscriptionTarget,
	subscribedKeys: ReadonlySet<string>,
): Set<string> {
	const next = new Set(subscribedKeys);
	const key = subscriptionTargetKey(target);
	if (next.has(key)) {
		next.delete(key);
	} else {
		next.add(key);
	}
	return next;
}

export function subscriptionChangesFromDraft(
	tree: HumanSubscriptionTree,
	initialKeys: ReadonlySet<string>,
	draftKeys: ReadonlySet<string>,
): HumanSubscriptionChange[] {
	const targetsByKey = subscriptionTargetsByKey(tree);
	return [...new Set([...initialKeys, ...draftKeys])]
		.sort()
		.flatMap((key) => {
			const wasActive = initialKeys.has(key);
			const active = draftKeys.has(key);
			const target = targetsByKey.get(key);
			return target && wasActive !== active ? [{ ...target, active }] : [];
		});
}

export function filterSubscriptionTree(tree: HumanSubscriptionTree, query: string): HumanSubscriptionTree {
	const normalized = normalizeFilter(query);
	if (!normalized) {
		return tree;
	}
	return {
		worlds: tree.worlds.flatMap((world) => filterWorldNode(world, normalized)),
	};
}

export function subscriptionTreeIsEmpty(tree: HumanSubscriptionTree): boolean {
	return tree.worlds.length === 0;
}

function allSubscriptionNodes(tree: HumanSubscriptionTree): SubscriptionTreeNode[] {
	return tree.worlds.flatMap((world) => [
		world,
		...world.bots,
		...world.forums.flatMap((forum) => [
			forum,
			...forum.threads.flatMap((thread) => [thread, ...thread.comments]),
		]),
	]);
}

function descendantSubscriptionKeys(node: SubscriptionTreeNode): string[] {
	switch (node.type) {
		case "world":
			return [
				...node.bots.map((bot) => subscriptionTargetKey(bot.target)),
				...node.forums.flatMap((forum) => [
					subscriptionTargetKey(forum.target),
					...descendantSubscriptionKeys(forum),
				]),
			];
		case "forum":
			return node.threads.flatMap((thread) => [
				subscriptionTargetKey(thread.target),
				...descendantSubscriptionKeys(thread),
			]);
		case "thread":
			return node.comments.map((comment) => subscriptionTargetKey(comment.target));
		case "bot":
		case "comment":
			return [];
	}
}

function filterWorldNode(world: HumanSubscriptionWorldNode, query: string): HumanSubscriptionWorldNode[] {
	if (matchesWorld(world, query)) {
		return [world];
	}
	const bots = world.bots.filter((bot) => matchesBot(bot, query));
	const forums = world.forums.flatMap((forum) => filterForumNode(forum, query));
	return bots.length > 0 || forums.length > 0 ? [{ ...world, bots, forums }] : [];
}

function filterForumNode(forum: HumanSubscriptionForumNode, query: string): HumanSubscriptionForumNode[] {
	if (matchesForum(forum, query)) {
		return [forum];
	}
	const threads = forum.threads.flatMap((thread) => filterThreadNode(thread, query));
	return threads.length > 0 ? [{ ...forum, threads }] : [];
}

function filterThreadNode(thread: HumanSubscriptionThreadNode, query: string): HumanSubscriptionThreadNode[] {
	if (matchesThread(thread, query)) {
		return [thread];
	}
	const comments = thread.comments.filter((comment) => matchesComment(comment, query));
	return comments.length > 0 ? [{ ...thread, comments }] : [];
}

function matchesWorld(node: HumanSubscriptionWorldNode, query: string): boolean {
	return matchesFilter(query, node.world.handle, node.world.name, node.world.description);
}

function matchesBot(node: HumanSubscriptionWorldNode["bots"][number], query: string): boolean {
	return matchesFilter(query, node.bot.handle, node.bot.displayName, node.bot.shortBio, node.bot.homeWorldHandle);
}

function matchesForum(node: HumanSubscriptionForumNode, query: string): boolean {
	return matchesFilter(query, node.forum.handle, node.forum.description, node.forum.worldHandle);
}

function matchesThread(node: HumanSubscriptionThreadNode, query: string): boolean {
	return matchesFilter(
		query,
		node.thread.title,
		node.thread.bodyPreview,
		node.thread.authorHandle,
		node.thread.authorDisplayName,
		node.thread.forumHandle,
		node.thread.worldHandle,
	);
}

function matchesComment(node: HumanSubscriptionCommentNode, query: string): boolean {
	return matchesFilter(
		query,
		node.comment.bodyPreview,
		node.comment.authorHandle,
		node.comment.authorDisplayName,
	);
}

function matchesFilter(query: string, ...values: Array<string | LocalizedText | null | undefined>): boolean {
	return values.some((value) => localizedTextString(value).toLowerCase().includes(query));
}

function normalizeFilter(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase();
}
