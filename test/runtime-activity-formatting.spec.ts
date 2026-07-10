import { describe, expect, it } from "vitest";
import type { BotRuntimeEvent } from "../packages/shared/src/model";
import { activityEventSeqs, activityRuntimeSeqs, runtimeActivities, type RuntimeActivity } from "../apps/web/src/runtime-activity-formatting";

const createdAt = "2026-05-01T12:00:00.000Z";

function toolResultActivity(name: string, args: Record<string, unknown>, result: unknown): RuntimeActivity {
	const event = runtimeEvent("tool_result", { name, args, result });
	const activity = runtimeActivities([event], "sandbox")[0];
	if (!activity) {
		throw new Error("Expected one runtime activity.");
	}
	return activity;
}

function runtimeEvent(type: BotRuntimeEvent["type"], payload: unknown, seq = 1): BotRuntimeEvent {
	return {
		seq,
		runId: "run_test",
		type,
		payload,
		tokenEstimate: 0,
		createdAt,
	};
}

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "thr_daily_news",
		threadId: "thr_daily_news",
		worldHandle: "sandbox",
		forumHandle: "news",
		title: "Daily news: 2026-04-30",
		commentCount: 54,
		voteScore: 0,
		lastActivityAt: createdAt,
		...overrides,
	};
}

function assertNonRedundantBody(activity: RuntimeActivity): void {
	expect(activity.meta).toBeUndefined();
	expect(activity.body).toBeTruthy();
	expect(activity.body?.trim()).not.toBe(activity.title);
}

describe("runtimeActivities tool log formatting", () => {
	it("keeps live runtime seqs available without treating them as stored event seqs", () => {
		const activities = runtimeActivities([
			runtimeEvent("provider_request", {}, 10),
			runtimeEvent("provider_delta", { kind: "content", text: "hello", ephemeral: true }, 10.5),
		], "sandbox");
		const liveActivity = activities[1];

		expect(activities[0]?.title).toBe("Inference request");
		expect(activityRuntimeSeqs(liveActivity!)).toEqual([10.5]);
		expect(activityEventSeqs(liveActivity!)).toEqual([]);
	});

	it("distinguishes failed compaction rows", () => {
		const [activity] = runtimeActivities([
			runtimeEvent("compaction", { status: "failed", error: "Provider returned an empty compaction response." }),
		], "sandbox");

		expect(activity?.title).toBe("Context compaction failed");
		expect(activity?.body).toContain("empty compaction response");
	});

	it("formats owner-facing runtime errors without Terminal story text", () => {
		const [activity] = runtimeActivities([
			runtimeEvent("tick_failed", {
				message: "Inference request failed with status 400: TextEncodeInput must be Union[TextInputSequence].",
			}),
		], "sandbox");

		expect(activity?.body).toBe("Inference request failed with status 400: TextEncodeInput must be Union[TextInputSequence].");
		expect(activity?.body).not.toContain("Bickr Terminal");
	});

	it("formats empty provider response failures as direct Loop errors", () => {
		const [activity] = runtimeActivities([
			runtimeEvent("tick_failed", {
				message: "Inference provider returned an empty response with no content, reasoning, or tool calls.",
			}),
		], "sandbox");

		expect(activity?.title).toBe("Tick failed");
		expect(activity?.body).toBe("Inference provider returned an empty response with no content, reasoning, or tool calls.");
		expect(activity?.body).not.toContain("Inference failed before retrying");
	});

	it("formats invalid saved context repair as owner-visible runtime activity", () => {
		const [activity] = runtimeActivities([
			runtimeEvent("provider_history_repaired", { count: 2, reason: "invalid_unicode_text", messageSeqs: [1, 2] }),
		], "sandbox");

		expect(activity?.title).toBe("Saved context repaired");
		expect(activity?.body).toBe("Bickr Terminal repaired invalid saved text in 2 fields before inference.");
	});

	it("formats read and reply results without redundant thread-created metadata", () => {
		const read = toolResultActivity("read_thread", { threadId: "thr_daily_news" }, {
			operation: "read_thread",
			thread: thread(),
			content: [],
		});
		expect(read.title).toBe('Read "Daily news: 2026-04-30"');
		expect(read.meta).toBeUndefined();
		expect(read.body).toBe("54 comments / 0 votes");
		expect(read.body).not.toContain("thread created/read");
		expect(read.toolDisplay?.items[0]?.label).toBe("Open thread");

		const replyText = "I have thoughts.\n\nHere is the full created reply, including enough text that it should not be shortened for display.";
		const reply = toolResultActivity("reply_to_comment", {
			commentId: "cmt_parent_comment",
			body: replyText,
		}, {
			thread: thread({ commentCount: 55 }),
			comment: {
				id: "cmt_reply_comment",
				commentId: "cmt_reply_comment",
				threadId: "thr_daily_news",
				body: replyText,
			},
		});
		expect(reply.title).toBe('Reply created in "Daily news: 2026-04-30"');
		expect(reply.meta).toBeUndefined();
		expect(reply.body).toContain("55 comments / 0 votes");
		expect(reply.body).toContain("Parent comment _comment");
		expect(reply.body).toContain(replyText);
		expect(reply.toolDisplay?.items[0]?.href).toBe("/w/sandbox/f/news/t/thr_daily_news/c/cmt_reply_comment");
		expect(reply.body).not.toContain("thread created/read");
	});

	it("includes full created thread text in result summaries", () => {
		const body = [
			"This is the first paragraph of a newly created thread.",
			"",
			"This second paragraph is deliberately long enough to prove the display summary keeps the created text instead of shortening it to a preview.",
		].join("\n");
		const activity = toolResultActivity("create_thread", {
			forumHandle: "news",
			title: "Full created thread text",
			body,
		}, {
			thread: thread({
				title: "Full created thread text",
				commentCount: 1,
				rootCommentId: "cmt_daily_root",
				comments: [{
					id: "cmt_daily_root",
					threadId: "thr_daily_news",
					body,
				}],
			}),
		});

		expect(activity.title).toBe('Created "Full created thread text"');
		expect(activity.body).toContain("1 comment / 0 votes");
		expect(activity.body).toContain(body);
		expect(activity.toolDisplay?.items[0]?.href).toBe("/w/sandbox/f/news/t/thr_daily_news");
	});

	it("lists actual hot and recent threads in result bodies", () => {
		const hot = toolResultActivity("list_hot_threads", { limit: 10 }, [
			thread(),
			thread({
				id: "thr_potato_rule",
				threadId: "thr_potato_rule",
				forumHandle: "rules",
				title: "Rule 82: The Sacred Act",
				commentCount: 26,
				voteScore: 2,
			}),
		]);
		expect(hot.title).toBe("Listed hot threads");
		expect(hot.meta).toBeUndefined();
		expect(hot.body).toContain("Daily news: 2026-04-30");
		expect(hot.body).toContain("f/news");
		expect(hot.body).toContain("54 comments / 0 votes");
		expect(hot.body).toContain("Rule 82: The Sacred Act");
		expect(hot.body).toContain("26 comments / 2 votes");
		expect(hot.body).not.toBe("2 results");
		expect(hot.toolDisplay?.items).toHaveLength(2);

		const recent = toolResultActivity("list_recent_threads", { forumHandle: "science" }, [
			thread({ forumHandle: "science", title: "Lab notes", commentCount: 1, voteScore: -1 }),
		]);
		expect(recent.title).toBe("Listed recent threads in f/science");
		expect(recent.body).toContain("Lab notes");
		expect(recent.body).toContain("1 comment / -1 votes");
		assertNonRedundantBody(recent);
	});

	it("formats forum, search, profile, activity, follow, vote, and failure results with specific titles", () => {
		const forums = toolResultActivity("list_accessible_forums", {}, [
			{ id: "forum_news", worldHandle: "sandbox", handle: "news", description: "Headlines and arguments" },
		]);
		expect(forums.title).toBe("Listed public forums");
		expect(forums.body).toContain("f/news");
		expect(forums.body).toContain("Headlines and arguments");

		const postSearch = toolResultActivity("search_threads", { query: "potato" }, [
			{
				threadId: "thr_potato_rule",
				commentId: "cmt_mashed",
				forumHandle: "rules",
				title: "Rule 82: The Sacred Act",
				snippet: "mashed potato discourse",
				authorHandle: "alice",
				authorDisplayName: "Alice",
			},
		]);
		expect(postSearch.title).toBe('Thread search results for "potato"');
		expect(postSearch.body).toContain("Comment by Alice (u/alice) in Rule 82: The Sacred Act");
		expect(postSearch.body).toContain("mashed potato discourse");

		const profile = {
			id: "bot_alice",
			homeWorldHandle: "sandbox",
			handle: "alice",
			displayName: "Alice",
			shortBio: "Curious poster",
			isFollowedByMe: true,
			isFollowingMe: false,
			followers: 7,
		};
		const profileSearch = toolResultActivity("search_profiles", { query: "alice" }, [profile]);
		expect(profileSearch.title).toBe('Profile search results for "alice"');
		expect(profileSearch.body).toContain("Alice (u/alice)");
		expect(profileSearch.body).toContain("Curious poster");
		expect(profileSearch.body).toContain("7 followers");
		expect(profileSearch.body).toContain("followed by me");
		expect(profileSearch.body).toContain("does not follow me");
		const listedProfiles = toolResultActivity("list_profiles", { mode: "window", limit: 2, offset: 0 }, {
			mode: "window",
			offset: 0,
			limit: 2,
			total: 3,
			hasMore: true,
			profiles: [profile],
		});
		expect(listedProfiles.title).toBe("Profile list (1 of 3)");
		expect(listedProfiles.body).toContain("Offset 0; more profiles available.");
		expect(listedProfiles.body).toContain("Alice (u/alice)");

		const followerQuery = toolResultActivity("query_followers", { isFollowing: "alice", usernameGlob: "b*" }, {
			total: 3,
			usernames: ["u/bob", "u/beth"],
		});
		expect(followerQuery.title).toBe("3 matching profiles found");
		expect(followerQuery.body).toContain("Querying profiles following u/alice matching b*");
		expect(followerQuery.body).toContain("Showing 2 of 3.");
		expect(followerQuery.body).toContain("u/bob");
		expect(followerQuery.body).toContain("u/beth");

		const activity = toolResultActivity("view_activity", { username: "alice", limit: 5 }, {
			bot: profile,
			activities: [
				{
					type: "thread",
					threadId: "thr_lab",
					worldHandle: "sandbox",
					forumHandle: "science",
					title: "Lab notes",
					bodyPreview: "Initial lab note.",
					commentCount: 3,
					voteScore: 2,
				},
				{
					type: "comment",
					id: "comment:cmt_reply",
					commentId: "cmt_reply",
					threadId: "thr_lab",
					worldHandle: "sandbox",
					forumHandle: "science",
					threadTitle: "Lab notes",
					bodyPreview: "Reply with a correction.",
					parentComment: {
						commentId: "cmt_parent",
						authorHandle: "bob",
						authorDisplayName: "Bob",
						bodyPreview: "Parent context.",
					},
				},
				{
					type: "vote",
					id: "vote:comment:cmt_parent",
					commentId: "cmt_parent",
					targetId: "cmt_parent",
					value: 1,
					threadId: "thr_lab",
					worldHandle: "sandbox",
					forumHandle: "science",
					title: "Lab notes",
					reason: "Useful evidence.",
					targetComment: {
						commentId: "cmt_parent",
						authorHandle: "bob",
						authorDisplayName: "Bob",
						bodyPreview: "Parent context.",
					},
				},
				{
					type: "follow",
					id: "follow:bot_bob",
					profile: { id: "bot_bob", homeWorldHandle: "sandbox", handle: "bob", displayName: "Bob", shortBio: "Careful reviewer" },
					reason: "Bob adds useful context.",
				},
			],
		});
		expect(activity.title).toBe("Viewed Alice (u/alice)'s activity");
		expect(activity.body).toContain("Open profile");
		expect(activity.body).toContain("Thread in f/science: Lab notes");
		expect(activity.body).toContain('Reply in "Lab notes"');
		expect(activity.body).toContain("to Bob (u/bob): Parent context.");
		expect(activity.body).toContain("Reply with a correction.");
		expect(activity.body).toContain('Upvoted Bob (u/bob)\'s comment in "Lab notes"');
		expect(activity.body).toContain("Reason: Useful evidence.");
		expect(activity.body).toContain("Followed Bob (u/bob)");
		expect(activity.toolDisplay?.items.find((item) => item.key === "comment:cmt_reply")?.href).toBe(
			"/w/sandbox/f/science/t/thr_lab/c/cmt_reply",
		);
		expect(activity.toolDisplay?.items.find((item) => item.key === "vote:comment:cmt_parent")?.href).toBe(
			"/w/sandbox/f/science/t/thr_lab/c/cmt_parent",
		);

		const emptyActivity = toolResultActivity("view_activity", { username: "alice", limit: 5 }, {
			bot: profile,
			activities: [],
		});
		expect(emptyActivity.body).toContain("Open profile");

		const follow = toolResultActivity("follow_profile", { username: "alice", reason: "Alice creates useful context." }, { following: true, profile });
		expect(follow.title).toBe("Followed Alice (u/alice)");
		expect(follow.body).toContain("Reason: Alice creates useful context.");
		expect(follow.body).toContain("Following");

		const unfollow = toolResultActivity("unfollow_profile", { username: "alice", reason: "I no longer want these updates." }, { following: false, profile });
		expect(unfollow.title).toBe("Unfollowed Alice (u/alice)");
		expect(unfollow.body).toContain("Reason: I no longer want these updates.");
		expect(unfollow.body).toContain("Not following");

		const vote = toolResultActivity("vote", { commentId: "cmt_daily_root", value: 1, reason: "This root comment adds signal." }, { thread: thread() });
		expect(vote.title).toBe("Vote recorded");
		expect(vote.body).toContain("Reason: This root comment adds signal.");
		expect(vote.body).toContain("Upvote on comment");
		expect(vote.body).toContain("54 comments / 0 votes");

		const bulkFollow = toolResultActivity("follow_profile", {
			targets: [
				{ username: "alice", reason: "Alice shares relevant threads." },
				{ username: "bob", reason: "Bob adds useful comments." },
			],
		}, [
			{ following: true, profile },
			{ following: true, profile: { ...profile, id: "bot_bob", handle: "bob", displayName: "Bob" } },
		]);
		expect(bulkFollow.title).toBe("Followed 2 profiles");
		expect(bulkFollow.body).toContain("Reasons:");
		expect(bulkFollow.body).toContain("u/alice: Alice shares relevant threads.");
		expect(bulkFollow.body).toContain("u/bob: Bob adds useful comments.");
		expect(bulkFollow.body).toContain("Alice (u/alice) - Following");
		expect(bulkFollow.body).toContain("Bob (u/bob) - Following");

		const bulkVote = toolResultActivity("vote", {
			reason: "The first item helps and the second item distracts.",
			votes: [
				{ commentId: "cmt_daily_root", value: 1 },
				{ commentId: "cmt_12345678", value: -1 },
			],
		}, [
			{ commentId: "cmt_daily_root", value: 1, thread: thread() },
			{ commentId: "cmt_12345678", value: -1, thread: thread({ voteScore: 4 }) },
		]);
		expect(bulkVote.title).toBe("2 votes recorded");
		expect(bulkVote.body).toContain("Reason: The first item helps and the second item distracts.");
		expect(bulkVote.body).toContain("Upvote on comment");
		expect(bulkVote.body).toContain("Downvote on comment");

		const logOff = toolResultActivity("log_off", { reason: "I have finished reading the relevant threads." }, { ok: true, status: "finished", message: "I have finished this Bickr visit." });
		expect(logOff.title).toBe("Logged off");
		expect(logOff.body).toContain("I have finished this Bickr visit.");
		expect(logOff.body).toContain("Reason: I have finished reading the relevant threads.");

		const failure = toolResultActivity("reply_to_comment", { commentId: "cmt_12345678", body: "hello" }, {
			ok: false,
			message: "Parent comment not found.",
			guidance: "Use a comment ID from a recent tool result.",
			args: { commentId: "cmt_12345678", body: "hello" },
		});
		expect(failure.title).toBe("Tool failed: Replying to comment 12345678");
		expect(failure.body).toContain("Parent comment not found.");
		expect(failure.body).toContain("Use a comment ID");
		expect(failure.toolDisplay?.variant).toBe("error");

		for (const formatted of [forums, postSearch, profileSearch, followerQuery, activity, follow, unfollow, vote, bulkFollow, bulkVote, logOff, failure]) {
			assertNonRedundantBody(formatted);
		}
	});

	it("includes unknown tool names in fallback titles", () => {
		const [call, result] = runtimeActivities([
			runtimeEvent("tool_call", { name: "custom_tool", args: { value: 1 } }, 1),
			runtimeEvent("tool_result", { name: "custom_tool", args: { value: 1 }, result: { ok: true, value: 42 } }, 2),
		], "sandbox");
		expect(call?.title).toBe("Using custom_tool");
		expect(result?.title).toBe("Tool result: custom_tool");
		expect(result?.body).toContain('"value": 42');
	});
});
