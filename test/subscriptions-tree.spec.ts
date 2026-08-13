import { describe, expect, it } from "vitest";
import { localizedText, type HumanSubscription, type HumanSubscriptionTree, type LanguageTag } from "../packages/shared/src/model";
import {
	cycleSubscriptionContainer,
	filterSubscriptionTree,
	subscriptionChangesFromDraft,
	subscriptionKeysFromTree,
	subscriptionNodeState,
	subscriptionTargetKey,
	subscriptionTreeIsEmpty,
} from "../apps/web/src/subscriptions-tree";

const now = "2026-05-16T12:00:00.000Z";
const en = "en" as LanguageTag;

function lt(text: string) {
	return localizedText(text, en);
}

describe("subscription tree helpers", () => {
	it("cycles implied containers through checked, unchecked, and restored indeterminate states", () => {
		const tree = sampleTree();
		const world = tree.worlds[0]!;
		const commentKey = subscriptionTargetKey(world.forums[0]!.threads[0]!.comments[0]!.target);
		const worldKey = subscriptionTargetKey(world.target);
		let keys = subscriptionKeysFromTree(tree);
		let remembered = {};

		expect([...keys]).toEqual([commentKey]);
		expect(subscriptionNodeState(world, keys)).toBe("indeterminate");

		({ subscribedKeys: keys, rememberedDescendantsByKey: remembered } = cycleSubscriptionContainer(world, keys, remembered));
		expect(keys.has(worldKey)).toBe(true);
		expect(keys.has(commentKey)).toBe(true);
		expect(subscriptionNodeState(world, keys)).toBe("checked");

		({ subscribedKeys: keys, rememberedDescendantsByKey: remembered } = cycleSubscriptionContainer(world, keys, remembered));
		expect(keys.has(worldKey)).toBe(false);
		expect(keys.has(commentKey)).toBe(false);
		expect(remembered).toEqual({ [worldKey]: [commentKey] });

		({ subscribedKeys: keys, rememberedDescendantsByKey: remembered } = cycleSubscriptionContainer(world, keys, remembered));
		expect(keys.has(worldKey)).toBe(false);
		expect(keys.has(commentKey)).toBe(true);
		expect(remembered).toEqual({});
		expect(subscriptionNodeState(world, keys)).toBe("indeterminate");
	});

	it("builds update changes from the initial and draft direct subscription sets", () => {
		const tree = sampleTree();
		const world = tree.worlds[0]!;
		const commentKey = subscriptionTargetKey(world.forums[0]!.threads[0]!.comments[0]!.target);
		const botKey = subscriptionTargetKey(world.bots[0]!.target);
		const initial = new Set([commentKey]);
		const draft = new Set([botKey]);

		expect(subscriptionChangesFromDraft(tree, initial, draft)).toEqual([
			{ active: true, scopeId: "bot_alpha", scopeType: "bot", worldId: "wld_alpha" },
			{ active: false, scopeId: "cmt_reply", scopeType: "comment", worldId: "wld_alpha" },
		]);
	});

	it("filters descendants while preserving the ancestors needed to render hierarchy", () => {
		const tree = sampleTree();

		const commentOnly = filterSubscriptionTree(tree, "specific reply");
		expect(commentOnly.worlds).toHaveLength(1);
		expect(commentOnly.worlds[0]!.forums).toHaveLength(1);
		expect(commentOnly.worlds[0]!.forums[0]!.threads).toHaveLength(1);
		expect(commentOnly.worlds[0]!.forums[0]!.threads[0]!.comments.map((comment) => comment.comment.id)).toEqual(["cmt_reply"]);

		const worldMatch = filterSubscriptionTree(tree, "alpha world");
		expect(worldMatch.worlds[0]!.bots).toHaveLength(1);
		expect(worldMatch.worlds[0]!.forums[0]!.threads[0]!.comments).toHaveLength(1);
		expect(subscriptionTreeIsEmpty(filterSubscriptionTree(tree, "not present"))).toBe(true);
	});
});

function sampleTree(): HumanSubscriptionTree {
	const commentSubscription = subscription("hsb_comment", "comment", "cmt_reply");
	return {
		worlds: [{
			type: "world",
			world: {
				id: "wld_alpha",
				handle: "alpha",
				language: en,
				name: lt("Alpha World"),
				description: lt("Primary watched world."),
				prompt: lt(""),
				recurringPromptEnabled: false,
				recurringPrompt: lt(""),
				initialBotNotification: lt("Welcome."),
				createdByUserId: "usr_owner",
				createdAt: now,
				updatedAt: now,
			},
			target: { scopeType: "world", scopeId: "wld_alpha", worldId: "wld_alpha" },
			bots: [{
				type: "bot",
				bot: {
					id: "bot_alpha",
					homeWorldId: "wld_alpha",
					homeWorldHandle: "alpha",
					handle: "alpha-bot",
					language: en,
					displayName: lt("Alpha Bot"),
					shortBio: lt("Replies with context."),
					createdAt: now,
					updatedAt: now,
				},
				target: { scopeType: "bot", scopeId: "bot_alpha", worldId: "wld_alpha" },
			}],
			forums: [{
				type: "forum",
				forum: {
					id: "frm_general",
					worldId: "wld_alpha",
					worldHandle: "alpha",
					handle: "general",
					language: en,
					description: lt("General discussion."),
					createdByUserId: "usr_owner",
					readOnly: false,
					createdAt: now,
					updatedAt: now,
				},
				target: { scopeType: "forum", scopeId: "frm_general", worldId: "wld_alpha" },
				threads: [{
					type: "thread",
					thread: {
						id: "thr_topic",
						rootCommentId: "cmt_root",
						worldId: "wld_alpha",
						worldHandle: "alpha",
						forumId: "frm_general",
						forumHandle: "general",
						authorBotId: "bot_alpha",
						authorHandle: "alpha-bot",
						authorDisplayName: lt("Alpha Bot"),
						title: lt("Nested subscriptions"),
						bodyPreview: lt("Tree discussion."),
						voteScore: 0,
						commentCount: 2,
						createdAt: now,
						lastActivityAt: now,
					},
					target: { scopeType: "thread", scopeId: "thr_topic", worldId: "wld_alpha" },
					comments: [{
						type: "comment",
						comment: {
							id: "cmt_reply",
							threadId: "thr_topic",
							worldId: "wld_alpha",
							forumId: "frm_general",
							authorBotId: "bot_alpha",
							authorHandle: "alpha-bot",
							authorDisplayName: lt("Alpha Bot"),
							bodyPreview: lt("Specific reply text."),
							createdAt: now,
						},
						target: { scopeType: "comment", scopeId: "cmt_reply", worldId: "wld_alpha" },
						subscription: commentSubscription,
					}],
				}],
			}],
		}],
	};
}

function subscription(
	id: string,
	scopeType: HumanSubscription["scopeType"],
	scopeId: string,
): HumanSubscription {
	return {
		id,
		userId: "usr_owner",
		worldId: "wld_alpha",
		scopeType,
		scopeId,
		active: true,
		autoCreated: false,
		createdAt: now,
		updatedAt: now,
	};
}
