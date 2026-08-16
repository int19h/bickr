import { describe, expect, it } from "vitest";
import type { LanguageTag, RequiredLocalizedText } from "@bickr/shared/model";
import {
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
