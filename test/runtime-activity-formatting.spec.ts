import { describe, expect, it } from "vitest";
import type { BotRuntimeEvent } from "../packages/shared/src/model";
import { runtimeActivities, type RuntimeActivity } from "../apps/web/src/runtime-activity-formatting";

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

		const reply = toolResultActivity("reply_to_thread", {
			threadId: "thr_daily_news",
			parentCommentId: "cmt_parent_comment",
			body: "I have thoughts.",
		}, {
			thread: thread({ commentCount: 55 }),
		});
		expect(reply.title).toBe('Reply posted in "Daily news: 2026-04-30"');
		expect(reply.meta).toBeUndefined();
		expect(reply.body).toContain("55 comments / 0 votes");
		expect(reply.body).toContain("Parent comment _comment");
		expect(reply.body).not.toContain("thread created/read");
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

		const postSearch = toolResultActivity("search_posts", { query: "potato" }, [
			{
				threadId: "thr_potato_rule",
				commentId: "cmt_mashed",
				forumHandle: "rules",
				title: "Rule 82: The Sacred Act",
				snippet: "mashed potato discourse",
			},
		]);
		expect(postSearch.title).toBe('Post search results for "potato"');
		expect(postSearch.body).toContain("Rule 82: The Sacred Act");
		expect(postSearch.body).toContain("mashed potato discourse");

		const profile = { id: "bot_alice", homeWorldHandle: "sandbox", handle: "alice", displayName: "Alice", shortBio: "Curious poster" };
		const profileSearch = toolResultActivity("search_profiles", { query: "alice" }, [profile]);
		expect(profileSearch.title).toBe('Profile search results for "alice"');
		expect(profileSearch.body).toContain("Alice (u/alice)");
		expect(profileSearch.body).toContain("Curious poster");

		const activity = toolResultActivity("view_activity", { username: "alice", limit: 5 }, {
			bot: profile,
			activities: [{ type: "post", threadId: "thr_lab", forumHandle: "science", title: "Lab notes" }],
		});
		expect(activity.title).toBe("Viewed Alice (u/alice)'s activity");
		expect(activity.body).toContain("Open profile");
		expect(activity.body).toContain("Lab notes");

		const follow = toolResultActivity("follow_profile", { username: "alice" }, { following: true, profile });
		expect(follow.title).toBe("Followed Alice (u/alice)");
		expect(follow.body).toContain("Following");

		const unfollow = toolResultActivity("unfollow_profile", { username: "alice" }, { following: false, profile });
		expect(unfollow.title).toBe("Unfollowed Alice (u/alice)");
		expect(unfollow.body).toContain("Not following");

		const vote = toolResultActivity("vote", { targetType: "thread", targetId: "thr_daily_news", value: 1 }, { thread: thread() });
		expect(vote.title).toBe("Vote recorded");
		expect(vote.body).toContain("Upvote on thread");
		expect(vote.body).toContain("54 comments / 0 votes");

		const failure = toolResultActivity("reply_to_thread", { threadId: "thread_12345678", body: "hello" }, {
			ok: false,
			message: "Parent comment not found.",
			guidance: "Use a comment ID from a recent tool result.",
			args: { threadId: "thread_12345678", body: "hello" },
		});
		expect(failure.title).toBe("Tool failed: Replying to thread 12345678");
		expect(failure.body).toContain("Parent comment not found.");
		expect(failure.body).toContain("Use a comment ID");
		expect(failure.toolDisplay?.variant).toBe("error");

		for (const formatted of [forums, postSearch, profileSearch, activity, follow, unfollow, vote, failure]) {
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
