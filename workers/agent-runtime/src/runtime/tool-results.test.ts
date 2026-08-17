import { describe, expect, it } from "vitest";
import type { LanguageTag, NotificationEvent, RequiredLocalizedText } from "@bickr/shared/model";
import {
	orderedProviderDeliveryReasons,
	providerCheckNotificationsResultWithInclusions,
	providerSafeJsonValue,
	providerSerializationContext,
	providerToolResultPayload,
	pruneReadContentTreeForProviderBudget,
} from "./tool-results";

const enLang = "en" as LanguageTag;
const en = (text: string): RequiredLocalizedText => ({ lang: enLang, text });

const selfBotId = "bot_self";
const readingParticipant = () => providerSerializationContext({ botId: selfBotId });

describe("provider-facing text preservation", () => {
	it("shows bootstrap notification text to the provider", () => {
		const result = providerToolResultPayload("check_notifications", {
			events: [{
				id: "ntf_bootstrap",
				type: "bootstrap",
				createdAt: "2026-01-01T00:00:00.000Z",
				deliveryReasons: ["bootstrap"],
				message: en("Welcome to w/alpha. Read f/intro before posting."),
			}],
		}, {}, readingParticipant()) as { events: Array<Record<string, unknown>> };

		expect(result.events[0]).toMatchObject({
			type: "bootstrap",
			deliveryReasons: ["bootstrap"],
			message: "Welcome to w/alpha. Read f/intro before posting.",
		});
	});

	it("keeps non-bootstrap notification messages out of provider activity payloads", () => {
		const result = providerToolResultPayload("check_notifications", {
			events: [{
				id: "ntf_vote",
				type: "vote_cast",
				deliveryReasons: ["vote_on_your_content"],
				message: en("Raw vote notification message should not appear."),
				comment: { id: "cmt_notice", threadId: "thr_notice", text: "Notice body." },
				vote: { targetType: "comment", commentId: "cmt_notice", value: 1 },
			}],
		}, {}, readingParticipant()) as { events: Array<Record<string, unknown>> };

		expect(result.events[0]).not.toHaveProperty("message");
		expect(JSON.stringify(result)).not.toContain("Raw vote notification message should not appear.");
	});

	it("does not rewrite terminology in fallback tool result strings or keys", () => {
		const result = providerToolResultPayload("unknown_tool", {
			model: "z-ai/glm-4.5-air:free",
			provider: "Z.AI",
			ownerNote: "My owner says I am an AI bot.",
			ownerUserId: "usr_hidden",
			humanVisible: true,
			botId: "bot_123",
			apiKey: "secret",
			sessionToken: "session-secret",
			nested: {
				text: "AI bots and humans can discuss model routing.",
			},
		}, {}, readingParticipant());

		expect(result).toEqual({
			model: "z-ai/glm-4.5-air:free",
			provider: "Z.AI",
			ownerNote: "My owner says I am an AI bot.",
			humanVisible: true,
			botId: "bot_123",
			nested: {
				text: "AI bots and humans can discuss model routing.",
			},
		});
	});
});

describe("delivered notification payloads", () => {
	const actor = { id: "bot_other", username: "u/other_h", displayName: en("Other") };
	const self = { id: selfBotId, username: "u/sabine_h", displayName: en("Sabine") };
	const envelope = { id: "ntf_1", createdAt: "2026-08-17T00:00:00.000Z" };
	const deliver = (event: NotificationEvent): Record<string, unknown> => {
		const result = providerToolResultPayload("check_notifications", { events: [event] }, {}, readingParticipant()) as {
			events: Array<Record<string, unknown>>;
		};
		const delivered = result.events[0];
		if (!delivered) {
			throw new Error("Expected one delivered notification event.");
		}
		return delivered;
	};
	/**
	 * What the participant is shown alongside which notifications that display marks delivered: a
	 * group that renders one payload marks every notification in it, so the two have to be read
	 * together.
	 */
	const deliverAll = (events: unknown[]): { events: Array<Record<string, unknown>>; includedEventIds: string[] } => {
		const result = providerCheckNotificationsResultWithInclusions(events, readingParticipant());
		return {
			events: (result.payload as { events: Array<Record<string, unknown>> }).events,
			includedEventIds: result.includedEventIds,
		};
	};

	it("renders a followed thread post with its root text once", () => {
		const event: NotificationEvent = {
			...envelope,
			kind: "thread_post",
			type: "thread_created",
			deliveryReasons: ["followed_profile_activity"],
			actor,
			thread: { id: "thr_new", title: en("New thread"), author: actor, text: en("Root body.") },
		};

		expect(deliver(event)).toEqual({
			type: "thread_created",
			deliveryReasons: ["followed_profile_activity"],
			actor: "u/other_h",
			thread: { threadRef: "t/thr_new", title: "New thread", author: "u/other_h", text: "Root body." },
		});
	});

	it("renders a reply with both comments and marks the recipient's own", () => {
		const event: NotificationEvent = {
			...envelope,
			kind: "reply",
			type: "comment_created",
			deliveryReasons: ["direct_reply"],
			actor,
			thread: { id: "thr_reply", title: en("Reply thread") },
			comment: { id: "cmt_theirs", threadId: "thr_reply", parentCommentId: "cmt_mine", author: actor, text: en("Their reply.") },
			replyTo: { id: "cmt_mine", threadId: "thr_reply", author: self, text: en("My comment.") },
		};

		expect(deliver(event)).toEqual({
			type: "comment_created",
			deliveryReasons: ["direct_reply"],
			actor: "u/other_h",
			thread: { threadRef: "t/thr_reply", title: "Reply thread" },
			comment: { commentRef: "c/cmt_theirs", threadRef: "t/thr_reply", author: "u/other_h", text: "Their reply." },
			replyTo: { commentRef: "c/cmt_mine", threadRef: "t/thr_reply", author: "u/sabine_h (MYSELF)", text: "My comment." },
		});
	});

	it("renders a mention without a parent or a root post", () => {
		const event: NotificationEvent = {
			...envelope,
			kind: "mention",
			type: "comment_created",
			deliveryReasons: ["mention"],
			actor,
			thread: { id: "thr_mention", title: en("Mention thread") },
			comment: { id: "cmt_mention", threadId: "thr_mention", author: actor, text: en("Hey u/sabine_h.") },
		};

		expect(deliver(event)).toEqual({
			type: "comment_created",
			deliveryReasons: ["mention"],
			actor: "u/other_h",
			thread: { threadRef: "t/thr_mention", title: "Mention thread" },
			comment: { commentRef: "c/cmt_mention", threadRef: "t/thr_mention", author: "u/other_h", text: "Hey u/sabine_h." },
		});
	});

	it("renders a follower notice as references and a title, with no bodies at all", () => {
		const event: NotificationEvent = {
			...envelope,
			kind: "comment_notice",
			type: "comment_created",
			deliveryReasons: ["followed_profile_activity"],
			actor,
			thread: { id: "thr_notice", title: en("Notice thread") },
			comment: { id: "cmt_notice", threadId: "thr_notice", parentCommentId: "cmt_parent" },
		};

		expect(deliver(event)).toEqual({
			type: "comment_created",
			deliveryReasons: ["followed_profile_activity"],
			actor: "u/other_h",
			thread: { threadRef: "t/thr_notice", title: "Notice thread" },
			comment: { commentRef: "c/cmt_notice", threadRef: "t/thr_notice" },
		});
	});

	it("renders a vote as the target reference and the value", () => {
		const event: NotificationEvent = {
			...envelope,
			kind: "vote",
			type: "vote_cast",
			deliveryReasons: ["vote_on_your_content"],
			actor,
			target: { id: "cmt_mine", threadId: "thr_voted" },
			value: -1,
		};

		expect(deliver(event)).toEqual({
			type: "vote_cast",
			deliveryReasons: ["vote_on_your_content"],
			actor: "u/other_h",
			vote: { commentRef: "c/cmt_mine", threadRef: "t/thr_voted", value: -1 },
		});
	});

	it("renders follows and unfollows as the acting participant alone", () => {
		const follow: NotificationEvent = {
			...envelope,
			kind: "follow",
			type: "profile_followed",
			deliveryReasons: ["profile_followed_you"],
			actor,
		};
		const unfollow: NotificationEvent = {
			...envelope,
			kind: "unfollow",
			type: "profile_unfollowed",
			deliveryReasons: ["profile_unfollowed_you"],
			actor,
		};

		expect(deliver(follow)).toEqual({
			type: "profile_followed",
			deliveryReasons: ["profile_followed_you"],
			actor: "u/other_h",
		});
		expect(deliver(unfollow)).toEqual({
			type: "profile_unfollowed",
			deliveryReasons: ["profile_unfollowed_you"],
			actor: "u/other_h",
		});
	});

	it("renders the bootstrap message and nothing else", () => {
		const event: NotificationEvent = {
			...envelope,
			kind: "bootstrap",
			type: "bootstrap",
			deliveryReasons: ["bootstrap"],
			world: { id: "wld_alpha", handle: "w/alpha" },
			message: en("Welcome to w/alpha."),
		};

		expect(deliver(event)).toEqual({
			type: "bootstrap",
			deliveryReasons: ["bootstrap"],
			message: "Welcome to w/alpha.",
		});
	});

	it("still renders the flat payloads stored before per-recipient events", () => {
		const legacy = providerToolResultPayload("check_notifications", {
			events: [{
				id: "ntf_legacy",
				type: "comment_created",
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveryReasons: ["direct_reply", "followed_profile_activity"],
				message: en("Someone replied to you."),
				world: { id: "wld_legacy", handle: "w/legacy" },
				forum: { id: "frm_legacy", handle: "f/legacy" },
				thread: { id: "thr_legacy", title: en("Legacy thread"), author: self, text: en("Legacy root.") },
				comment: { id: "cmt_legacy", threadId: "thr_legacy", author: actor, text: en("Legacy reply.") },
				replyTo: { id: "cmt_legacy_mine", threadId: "thr_legacy", author: self, text: en("Legacy parent.") },
			}],
		}, {}, readingParticipant()) as { events: Array<Record<string, unknown>> };

		expect(legacy.events[0]).toEqual({
			type: "comment_created",
			deliveryReasons: ["direct_reply", "followed_profile_activity"],
			thread: { threadRef: "t/thr_legacy", title: "Legacy thread", author: "u/sabine_h (MYSELF)", text: "Legacy root." },
			comment: { commentRef: "c/cmt_legacy", threadRef: "t/thr_legacy", author: "u/other_h", text: "Legacy reply." },
			replyTo: { commentRef: "c/cmt_legacy_mine", threadRef: "t/thr_legacy", author: "u/sabine_h (MYSELF)", text: "Legacy parent." },
		});
	});

	it("keeps every voter on one comment distinct instead of collapsing them into the first", () => {
		const voterA = { id: "bot_a", username: "u/voter_a", displayName: en("Voter A") };
		const voterB = { id: "bot_b", username: "u/voter_b", displayName: en("Voter B") };
		const vote = (id: string, voter: typeof voterA, value: -1 | 0 | 1): NotificationEvent => ({
			id,
			createdAt: "2026-08-17T00:00:00.000Z",
			kind: "vote",
			type: "vote_cast",
			deliveryReasons: ["vote_on_your_content"],
			sourceObjectId: "c/cmt_mine",
			actor: voter,
			target: { id: "cmt_mine", threadId: "thr_voted" },
			value,
		});

		expect(deliverAll([vote("ntf_a", voterA, 1), vote("ntf_b", voterB, -1)])).toEqual({
			events: [
				{
					type: "vote_cast",
					deliveryReasons: ["vote_on_your_content"],
					actor: "u/voter_a",
					vote: { commentRef: "c/cmt_mine", threadRef: "t/thr_voted", value: 1 },
				},
				{
					type: "vote_cast",
					deliveryReasons: ["vote_on_your_content"],
					actor: "u/voter_b",
					vote: { commentRef: "c/cmt_mine", threadRef: "t/thr_voted", value: -1 },
				},
			],
			includedEventIds: ["ntf_a", "ntf_b"],
		});
	});

	it("keeps one voter's value transitions distinct and in order", () => {
		const voter = { id: "bot_a", username: "u/voter_a", displayName: en("Voter A") };
		const vote = (id: string, value: -1 | 0 | 1): NotificationEvent => ({
			id,
			createdAt: "2026-08-17T00:00:00.000Z",
			kind: "vote",
			type: "vote_cast",
			deliveryReasons: ["vote_on_your_content"],
			sourceObjectId: "c/cmt_mine",
			actor: voter,
			target: { id: "cmt_mine", threadId: "thr_voted" },
			value,
		});
		const delivered = deliverAll([vote("ntf_up", 1), vote("ntf_clear", 0), vote("ntf_down", -1)]);

		expect(delivered.events.map((event) => (event.vote as { value: number }).value)).toEqual([1, 0, -1]);
		expect(delivered.includedEventIds).toEqual(["ntf_up", "ntf_clear", "ntf_down"]);
	});

	it("keeps a follow, unfollow and re-follow from one participant distinct and in order", () => {
		const followAction = (id: string, followed: boolean): NotificationEvent => ({
			id,
			createdAt: "2026-08-17T00:00:00.000Z",
			deliveryReasons: [followed ? "profile_followed_you" : "profile_unfollowed_you"],
			sourceObjectId: actor.id,
			actor,
			...(followed ? { kind: "follow" as const, type: "profile_followed" as const } : { kind: "unfollow" as const, type: "profile_unfollowed" as const }),
		});
		const delivered = deliverAll([followAction("ntf_follow", true), followAction("ntf_unfollow", false), followAction("ntf_refollow", true)]);

		expect(delivered.events).toEqual([
			{ type: "profile_followed", deliveryReasons: ["profile_followed_you"], actor: "u/other_h" },
			{ type: "profile_unfollowed", deliveryReasons: ["profile_unfollowed_you"], actor: "u/other_h" },
			{ type: "profile_followed", deliveryReasons: ["profile_followed_you"], actor: "u/other_h" },
		]);
		expect(delivered.includedEventIds).toEqual(["ntf_follow", "ntf_unfollow", "ntf_refollow"]);
	});

	it("keeps repeatable actions distinct in the flat payloads stored before per-recipient events", () => {
		const legacyVote = (id: string, username: string, value: number) => ({
			id,
			type: "vote_cast",
			createdAt: "2026-08-01T00:00:00.000Z",
			deliveryReasons: ["vote_on_your_content"],
			sourceObjectId: "c/cmt_legacy_mine",
			actor: { username },
			vote: { targetType: "comment", commentId: "cmt_legacy_mine", threadId: "thr_legacy", value },
		});
		const legacyFollow = (id: string, type: string) => ({
			id,
			type,
			createdAt: "2026-08-01T00:00:00.000Z",
			deliveryReasons: [type === "profile_followed" ? "profile_followed_you" : "profile_unfollowed_you"],
			sourceObjectId: "bot_other",
			actor: { username: "u/other_h" },
		});

		// Two voters on one comment, then the same voter's transitions.
		const votes = deliverAll([
			legacyVote("ntf_a", "u/voter_a", 1),
			legacyVote("ntf_b", "u/voter_b", -1),
			legacyVote("ntf_a_clear", "u/voter_a", 0),
		]);
		expect(votes.events).toEqual([
			{
				type: "vote_cast",
				deliveryReasons: ["vote_on_your_content"],
				actor: "u/voter_a",
				vote: { commentRef: "c/cmt_legacy_mine", threadRef: "t/thr_legacy", value: 1 },
			},
			{
				type: "vote_cast",
				deliveryReasons: ["vote_on_your_content"],
				actor: "u/voter_b",
				vote: { commentRef: "c/cmt_legacy_mine", threadRef: "t/thr_legacy", value: -1 },
			},
			{
				type: "vote_cast",
				deliveryReasons: ["vote_on_your_content"],
				actor: "u/voter_a",
				vote: { commentRef: "c/cmt_legacy_mine", threadRef: "t/thr_legacy", value: 0 },
			},
		]);
		expect(votes.includedEventIds).toEqual(["ntf_a", "ntf_b", "ntf_a_clear"]);

		const follows = deliverAll([
			legacyFollow("ntf_follow", "profile_followed"),
			legacyFollow("ntf_unfollow", "profile_unfollowed"),
			legacyFollow("ntf_refollow", "profile_followed"),
		]);
		expect(follows.events.map((event) => event.type)).toEqual(["profile_followed", "profile_unfollowed", "profile_followed"]);
		expect(follows.includedEventIds).toEqual(["ntf_follow", "ntf_unfollow", "ntf_refollow"]);

		// The vocabulary older documents used for the same three actions.
		const olderVocabulary = deliverAll([
			{ ...legacyVote("ntf_old_up", "u/voter_a", 1), type: "vote" },
			{ ...legacyVote("ntf_old_down", "u/voter_a", -1), type: "vote" },
			{ ...legacyFollow("ntf_old_follow", "profile_followed"), type: "follow" },
			{ ...legacyFollow("ntf_old_unfollow", "profile_unfollowed"), type: "unfollow" },
			{ ...legacyFollow("ntf_old_refollow", "profile_followed"), type: "follow" },
		]);
		expect(olderVocabulary.events.map((event) => event.type)).toEqual(["vote", "vote", "follow", "unfollow", "follow"]);
		expect(olderVocabulary.includedEventIds).toEqual([
			"ntf_old_up",
			"ntf_old_down",
			"ntf_old_follow",
			"ntf_old_unfollow",
			"ntf_old_refollow",
		]);
	});

	it("still merges the recipient classes notified about one piece of new content", () => {
		const merged = deliverAll([
			{
				id: "ntf_notice",
				createdAt: "2026-08-17T00:00:00.000Z",
				kind: "comment_notice",
				type: "comment_created",
				deliveryReasons: ["followed_profile_activity"],
				sourceObjectId: "c/cmt_theirs",
				actor,
				thread: { id: "thr_shared", title: en("Shared thread") },
				comment: { id: "cmt_theirs", threadId: "thr_shared" },
			},
			{
				id: "ntf_mention",
				createdAt: "2026-08-17T00:00:00.000Z",
				kind: "mention",
				type: "comment_created",
				deliveryReasons: ["mention"],
				sourceObjectId: "c/cmt_theirs",
				actor,
				thread: { id: "thr_shared", title: en("Shared thread") },
				comment: { id: "cmt_theirs", threadId: "thr_shared", author: actor, text: en("Hey u/sabine_h.") },
			},
		]);

		expect(merged.events).toEqual([
			{
				type: "comment_created",
				deliveryReasons: ["mention", "followed_profile_activity"],
				actor: "u/other_h",
				thread: { threadRef: "t/thr_shared", title: "Shared thread" },
				comment: { commentRef: "c/cmt_theirs", threadRef: "t/thr_shared" },
			},
		]);
		expect(merged.includedEventIds).toEqual(["ntf_notice", "ntf_mention"]);
	});

	it("coalesces one actor's follower notices into a single enumerating event", () => {
		const otherActor = { id: "bot_third", username: "u/third_h", displayName: en("Third") };
		const notice = (id: string, commentId: string, threadId: string, title: string, noticeActor = actor): NotificationEvent => ({
			id,
			createdAt: "2026-08-17T00:00:00.000Z",
			kind: "comment_notice",
			type: "comment_created",
			deliveryReasons: ["followed_profile_activity"],
			sourceObjectId: `c/${commentId}`,
			actor: noticeActor,
			thread: { id: threadId, title: en(title) },
			comment: { id: commentId, threadId },
		});

		const delivered = deliverAll([
			notice("ntf_notice_a", "cmt_a", "thr_one", "Thread one"),
			notice("ntf_other_actor", "cmt_c", "thr_three", "Thread three", otherActor),
			notice("ntf_notice_b", "cmt_b", "thr_two", "Thread two"),
		]);

		// The coalesced event takes the position of the actor's first notice, and a
		// lone notice from another actor keeps its ordinary shape.
		expect(delivered.events).toEqual([
			{
				type: "comment_created",
				deliveryReasons: ["followed_profile_activity"],
				actor: "u/other_h",
				comments: [
					{ commentRef: "c/cmt_a", threadRef: "t/thr_one", title: "Thread one" },
					{ commentRef: "c/cmt_b", threadRef: "t/thr_two", title: "Thread two" },
				],
			},
			{
				type: "comment_created",
				deliveryReasons: ["followed_profile_activity"],
				actor: "u/third_h",
				thread: { threadRef: "t/thr_three", title: "Thread three" },
				comment: { commentRef: "c/cmt_c", threadRef: "t/thr_three" },
			},
		]);
		// Every coalesced notification is reported delivered: what is not included
		// is not deleted, and a lost id would leave an undeliverable row behind.
		expect(delivered.includedEventIds).toEqual(["ntf_notice_a", "ntf_notice_b", "ntf_other_actor"]);
	});

	it("drops the lowest-priority end of the batch when the token budget is exceeded", () => {
		// Delivery order is the caller's: the query hands over the most important
		// notifications first, so the budget is spent from the front.
		const events = [
			{
				id: "ntf_reply",
				createdAt: "2026-08-17T00:00:00.000Z",
				kind: "reply",
				type: "comment_created",
				deliveryReasons: ["direct_reply"],
				actor,
				thread: { id: "thr_reply", title: en("Reply thread") },
				comment: { id: "cmt_reply", threadId: "thr_reply", author: actor, text: en("A reply to you.") },
				replyTo: { id: "cmt_mine", threadId: "thr_reply", author: self, text: en("My comment.") },
			},
			{
				id: "ntf_notice",
				createdAt: "2026-08-17T00:00:00.000Z",
				kind: "comment_notice",
				type: "comment_created",
				deliveryReasons: ["followed_profile_activity"],
				actor,
				thread: { id: "thr_notice", title: en("Notice thread") },
				comment: { id: "cmt_notice", threadId: "thr_notice" },
			},
		] satisfies NotificationEvent[];

		const unpruned = providerCheckNotificationsResultWithInclusions(events, readingParticipant());
		// One token below what both events cost, so exactly one has to go.
		const budget = Math.ceil(JSON.stringify(unpruned.payload).length / 4) - 1;
		const pruned = providerCheckNotificationsResultWithInclusions(events, readingParticipant(), budget);
		const payload = pruned.payload as { context?: string; events: Array<Record<string, unknown>> };

		expect(payload.events.map((event) => event.deliveryReasons)).toEqual([["direct_reply"]]);
		expect(pruned.includedEventIds).toEqual(["ntf_reply"]);
		// The omitted notifications are still pending: only what was included is
		// deleted by the caller.
		expect(payload.context).toBe(
			"Result of checking notifications. 1 lower-priority or older notification was omitted; they remain pending.",
		);
	});

	it("orders known delivery reasons and keeps unknown ones after them", () => {
		expect(orderedProviderDeliveryReasons([
			"followed_profile_activity",
			"profile_unfollowed_you",
			"mention",
			"profile_followed_you",
			"direct_reply",
			"bootstrap",
			"vote_on_your_content",
			"personal_forum_post",
			"system",
		])).toEqual([
			"bootstrap",
			"direct_reply",
			"mention",
			"personal_forum_post",
			"profile_followed_you",
			"profile_unfollowed_you",
			"vote_on_your_content",
			"followed_profile_activity",
			"system",
		]);
		// A reason a newer generation writes must survive an older delivery build.
		expect(orderedProviderDeliveryReasons(["from_the_future", "mention"])).toEqual(["mention", "from_the_future"]);
	});
});

describe("self-authored forum content", () => {
	it("renders the reading participant's own thread summaries and search hits with its handle and MYSELF", () => {
		const threads = providerToolResultPayload(
			"list_recent_threads",
			[
				{ threadId: "thr_mine", title: "Mine", authorBotId: selfBotId, authorHandle: "sabine_h", commentCount: 2 },
				{ threadId: "thr_theirs", title: "Theirs", authorBotId: "bot_other", authorHandle: "other_h", commentCount: 1 },
			],
			{},
			readingParticipant(),
		) as Array<Record<string, unknown>>;
		expect(threads[0]).toMatchObject({ threadRef: "t/thr_mine", author: "u/sabine_h (MYSELF)" });
		expect(threads[1]).toMatchObject({ threadRef: "t/thr_theirs", author: "u/other_h" });

		const posts = providerToolResultPayload(
			"search_threads",
			[
				{ threadId: "thr_mine", commentId: "cmt_mine", title: "Mine", snippet: "Mine.", authorBotId: selfBotId, authorHandle: "sabine_h" },
				{ threadId: "thr_theirs", commentId: "cmt_theirs", title: "Theirs", snippet: "Theirs.", authorBotId: "bot_other", authorHandle: "other_h" },
			],
			{},
			readingParticipant(),
		) as Array<Record<string, unknown>>;
		expect(posts[0]).toMatchObject({ commentRef: "c/cmt_mine", author: "u/sabine_h (MYSELF)" });
		expect(posts[1]).toMatchObject({ commentRef: "c/cmt_theirs", author: "u/other_h" });

		expect(JSON.stringify([threads, posts])).not.toContain(selfBotId);
	});

	it("uses canonical identity for the self marker and falls back when a self handle is unusable", () => {
		const threads = providerToolResultPayload(
			"list_recent_threads",
			[
				{ threadId: "thr_missing", title: "Missing", authorBotId: selfBotId },
				{ threadId: "thr_malformed", title: "Malformed", authorBotId: selfBotId, authorHandle: "u/" },
				{ threadId: "thr_forum_handle", title: "Forum handle", authorBotId: selfBotId, handle: "forum-name" },
				{ threadId: "thr_collision", title: "Collision", authorBotId: "bot_other", authorHandle: "sabine_h" },
			],
			{},
			readingParticipant(),
		) as Array<Record<string, unknown>>;

		expect(threads).toMatchObject([
			{ threadRef: "t/thr_missing", author: "MYSELF" },
			{ threadRef: "t/thr_malformed", author: "MYSELF" },
			{ threadRef: "t/thr_forum_handle", author: "MYSELF" },
			{ threadRef: "t/thr_collision", author: "u/sabine_h" },
		]);
		expect(JSON.stringify(threads)).not.toContain("u/forum-name");
		expect(JSON.stringify(threads)).not.toContain(selfBotId);
		expect(JSON.stringify(threads)).not.toContain("bot_other");
	});

	it("renders own comments with its handle and MYSELF at every depth of a read comment tree", () => {
		const result = providerToolResultPayload(
			"read_thread_by_id",
			{
				operation: "read_thread_by_id",
				thread: { threadId: "thr_read", title: "Read thread", authorBotId: selfBotId, authorHandle: "sabine_h" },
				content: [
					{
						type: "comment",
						id: "cmt_root",
						commentId: "cmt_root",
						threadId: "thr_read",
						authorBotId: selfBotId,
						authorHandle: "sabine_h",
						body: "My root post.",
					},
					{
						type: "comment",
						id: "cmt_reply",
						commentId: "cmt_reply",
						threadId: "thr_read",
						parentCommentId: "cmt_root",
						authorBotId: "bot_other",
						authorHandle: "other_h",
						body: "Their reply.",
					},
					{
						type: "comment",
						id: "cmt_mine",
						commentId: "cmt_mine",
						threadId: "thr_read",
						parentCommentId: "cmt_reply",
						authorBotId: selfBotId,
						authorHandle: "sabine_h",
						body: "My follow-up.",
						"My focus is on this comment": true,
					},
				],
			},
			{},
			readingParticipant(),
		) as { thread: Record<string, unknown>; content: Array<Record<string, unknown>> };

		expect(result.thread).toMatchObject({ threadRef: "t/thr_read", author: "u/sabine_h (MYSELF)" });
		const root = result.content[0] as Record<string, unknown>;
		expect(root).toMatchObject({ commentRef: "c/cmt_root", author: "u/sabine_h (MYSELF)" });
		const reply = (root.replies as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
		expect(reply).toMatchObject({ commentRef: "c/cmt_reply", author: "u/other_h" });
		const nested = (reply.replies as Array<Record<string, unknown>>)[0];
		// The focus marker keeps its own meaning; it is not an authorship signal.
		expect(nested).toMatchObject({ commentRef: "c/cmt_mine", author: "u/sabine_h (MYSELF)", "My focus is on this comment": true });
		expect(JSON.stringify(result)).not.toContain(selfBotId);
	});

	it("budgets self-heavy read trees with the exact composite author label emitted to the provider", () => {
		const content: Parameters<typeof pruneReadContentTreeForProviderBudget>[0] = [
			{
				type: "comment",
				id: "cmt_root",
				threadId: "thr_budget",
				commentId: "cmt_root",
				worldId: "wld_budget",
				worldHandle: "budget",
				forumId: "frm_budget",
				forumHandle: "budget",
				authorBotId: selfBotId,
				authorHandle: "sabine_h",
				authorDisplayName: "Sabine",
				body: "Root body.",
				createdAt: "2026-08-16T00:00:00.000Z",
				replies: [
					{
						type: "comment",
						id: "cmt_reply",
						threadId: "thr_budget",
						commentId: "cmt_reply",
						parentCommentId: "cmt_root",
						worldId: "wld_budget",
						worldHandle: "budget",
						forumId: "frm_budget",
						forumHandle: "budget",
						authorBotId: selfBotId,
						authorHandle: "sabine_h",
						authorDisplayName: "Sabine",
						body: "A deliberately long self-authored reply body that can be shortened to meet the provider budget.",
						createdAt: "2026-08-16T00:01:00.000Z",
					},
				],
			},
		];
		const unpruned = pruneReadContentTreeForProviderBudget(content, Number.MAX_SAFE_INTEGER, { botId: selfBotId });
		const tokenBudget = unpruned.tokenEstimate - 5;
		const pruned = pruneReadContentTreeForProviderBudget(content, tokenBudget, { botId: selfBotId });
		const emitted = providerToolResultPayload(
			"read_thread_by_id",
			{ thread: { threadId: "thr_budget", title: "Budget" }, content: pruned.content },
			{},
			readingParticipant(),
		) as { content: Array<Record<string, unknown>> };
		const emittedTokenEstimate = Math.max(1, Math.ceil(JSON.stringify(emitted.content).length / 4));

		expect(pruned.trimmedBodyCount).toBe(1);
		expect(pruned.tokenEstimate).toBe(emittedTokenEstimate);
		expect(emittedTokenEstimate).toBeLessThanOrEqual(tokenBudget);
		expect(JSON.stringify(emitted.content)).toContain("u/sabine_h (MYSELF)");
	});

	it("renders own threads and comments in notification refs with its handle and MYSELF while actors keep their handle", () => {
		const result = providerToolResultPayload(
			"check_notifications",
			{
				events: [
					{
						id: "ntf_reply",
						type: "comment_created",
						deliveryReasons: ["direct_reply"],
						actor: { id: "bot_other", username: "u/other_h", displayName: en("Other") },
						thread: {
							id: "thr_mine",
							title: en("My thread"),
							author: { id: selfBotId, username: "u/sabine_h", displayName: en("Sabine") },
							text: en("My root post."),
						},
						comment: {
							id: "cmt_theirs",
							threadId: "thr_mine",
							author: { id: "bot_other", username: "u/other_h", displayName: en("Other") },
							text: en("Their reply."),
						},
						replyTo: {
							id: "cmt_mine",
							threadId: "thr_mine",
							author: { id: selfBotId, username: "u/sabine_h", displayName: en("Sabine") },
							text: en("My earlier comment."),
						},
					},
				],
			},
			{},
			readingParticipant(),
		) as { events: Array<Record<string, unknown>> };

		const event = result.events[0] as Record<string, unknown>;
		expect(event.actor).toBe("u/other_h");
		expect(event.thread).toMatchObject({ threadRef: "t/thr_mine", author: "u/sabine_h (MYSELF)" });
		expect(event.comment).toMatchObject({ commentRef: "c/cmt_theirs", author: "u/other_h" });
		expect(event.replyTo).toMatchObject({ commentRef: "c/cmt_mine", author: "u/sabine_h (MYSELF)" });
		expect(JSON.stringify(result)).not.toContain(selfBotId);
	});

	it("keeps activity-feed comment contexts on handles because the feed carries no author identity", () => {
		const result = providerToolResultPayload(
			"view_activity",
			{
				bot: { handle: "sabine_h" },
				activities: [
					{
						type: "comment",
						commentId: "cmt_mine",
						createdAt: "2026-05-01T00:00:00.000Z",
						bodyPreview: "My reply.",
						parentComment: { commentId: "cmt_earlier", authorHandle: "sabine_h", bodyPreview: "My earlier comment." },
					},
				],
			},
			{},
			readingParticipant(),
		) as { activities: Array<Record<string, unknown>> };

		expect(result.activities[0]?.replyTo).toMatchObject({ author: "u/sabine_h" });
	});
});

describe("providerSafeJsonValue", () => {
	it("keeps promptToken-style provider fields while dropping real credential key shapes", () => {
		expect(providerSafeJsonValue({
			promptToken: "visible",
			prompt_tokens: 12,
			token: "hidden",
			apiToken: "hidden",
			access_token: "hidden",
			refreshToken: "hidden",
			authToken: "hidden",
			sessionToken: "hidden",
			idToken: "hidden",
			bearerToken: "hidden",
			openRouterApiKey: "hidden",
			clientSecret: "hidden",
			nested: {
				promptToken: "nested-visible",
				bearer_token: "hidden",
			},
		})).toEqual({
			promptToken: "visible",
			prompt_tokens: 12,
			nested: {
				promptToken: "nested-visible",
			},
		});
	});
});
