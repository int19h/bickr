import {
	humanSubscriptionScopeDeleteStatements,
	type HumanSubscriptionScopeRef,
} from "@bickr/shared/human-subscriptions";
import { d1SafeBoundParameters, type D1DatabaseLike } from "@bickr/shared/storage";
import {
	authCookie,
	contextFor,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	deleteBot,
	deleteCommentRoute,
	deleteForumRoute,
	deleteProfileRoute,
	deleteThreadRoute,
	deleteWorldRoute,
	describe,
	expect,
	it,
	jsonRequest,
	seedWorld,
	testEnv,
	userIdForHandle,
} from "./helpers/index-harness";

/**
 * `human_subscriptions` has no age-based retention: a row stays valid for as
 * long as the entity it points at exists. What bounds the table is therefore
 * every delete path clearing its own scopes, so these cover each of those paths
 * plus the shared helper they all go through (design §2.6, issue #190).
 *
 * The helper builds statements rather than running them, because each delete
 * path folds them into the same batch that tombstones the scope entity; these
 * run them through `db.batch` the way those callers do.
 *
 * Creating an entity auto-subscribes its owner, so the table is never empty by
 * the time a test asserts. Fixture rows carry a distinct id prefix to keep them
 * apart from those, and the dead scopes are additionally asserted to hold zero
 * rows of any origin.
 */

const fixturePrefix = "hsbfix_";
const subscriberUserId = "usr_subscription_cleanup";

/**
 * The shared statement types the helper is written against. The Workers binding
 * satisfies them structurally; TypeScript still wants the narrowing to be said
 * out loud when a statement built here is handed back to `batch`.
 */
function subscriptionDb(): D1DatabaseLike {
	return testEnv.BICKR_D1 as unknown as D1DatabaseLike;
}

async function insertSubscription(input: {
	name: string;
	scopeType: HumanSubscriptionScopeRef["scopeType"];
	scopeId: string;
	userId?: string;
	worldId?: string;
	active?: boolean;
}): Promise<void> {
	const now = "2026-08-01T00:00:00.000Z";
	// REPLACE, because creating an entity already auto-subscribed its owner to
	// it: a fixture for the owner's own scope takes that row's place rather than
	// colliding with it on (user_id, scope_type, scope_id).
	await testEnv.BICKR_D1.prepare(
		`INSERT OR REPLACE INTO human_subscriptions (
			subscription_id, user_id, world_id, scope_type, scope_id, active, auto_created, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
	)
		.bind(
			`${fixturePrefix}${input.name}`,
			input.userId ?? subscriberUserId,
			input.worldId ?? "wld_subscription_cleanup",
			input.scopeType,
			input.scopeId,
			input.active === false ? 0 : 1,
			now,
			now,
		)
		.run();
}

/** The fixture rows still present, by the short name they were inserted under. */
async function remainingFixtures(): Promise<string[]> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT subscription_id AS id
		 FROM human_subscriptions
		 WHERE subscription_id LIKE ?
		 ORDER BY subscription_id`,
	)
		.bind(`${fixturePrefix}%`)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id.slice(fixturePrefix.length));
}

async function subscriptionCountForScope(scopeType: string, scopeId: string): Promise<number> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT COUNT(*) AS count FROM human_subscriptions WHERE scope_type = ? AND scope_id = ?`,
	)
		.bind(scopeType, scopeId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function worldIdForHandle(handle: string): Promise<string> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT world_id AS id FROM worlds_index WHERE handle = ?`)
		.bind(handle)
		.first<{ id: string }>();
	if (!row) {
		throw new Error(`No test world for handle ${handle}.`);
	}
	return row.id;
}

describe("human subscription scope cleanup", () => {
	it("deletes every row of the named scopes, inactive ones included, and nothing else", async () => {
		await insertSubscription({ name: "target_active", scopeType: "thread", scopeId: "thr_dying" });
		// An inactive row is a remembered opt-out, which is worth keeping only
		// while there is something to be opted out of.
		await insertSubscription({ name: "target_inactive", scopeType: "thread", scopeId: "thr_dying", active: false, userId: "usr_other" });
		await insertSubscription({ name: "target_comment", scopeType: "comment", scopeId: "cmt_dying" });
		// Same id, different scope type: the pair is the key, not the id alone.
		await insertSubscription({ name: "same_id_other_type", scopeType: "bot", scopeId: "thr_dying" });
		await insertSubscription({ name: "survivor", scopeType: "thread", scopeId: "thr_living" });

		const db = subscriptionDb();
		const statements = humanSubscriptionScopeDeleteStatements(db, [
			{ scopeType: "thread", scopeId: "thr_dying" },
			{ scopeType: "comment", scopeId: "cmt_dying" },
			// Repeats collapse rather than issuing the same delete twice.
			{ scopeType: "thread", scopeId: "thr_dying" },
		]);
		const results = await db.batch(statements);

		expect(statements).toHaveLength(2);
		expect(results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0)).toBe(3);
		expect(await remainingFixtures()).toEqual(["same_id_other_type", "survivor"]);
	});

	it("issues no statement for an empty scope set, so a caller's batch stays as it was", async () => {
		await insertSubscription({ name: "untouched", scopeType: "world", scopeId: "wld_untouched" });

		expect(humanSubscriptionScopeDeleteStatements(subscriptionDb(), [])).toEqual([]);
		expect(await remainingFixtures()).toEqual(["untouched"]);
	});

	it("chunks a scope set larger than D1's bound-parameter ceiling", async () => {
		// One bind is spent on scope_type, so a chunk holds one fewer id than the
		// safe ceiling; this set forces a second statement by exactly one id.
		const scopeCount = d1SafeBoundParameters;
		const scopes: HumanSubscriptionScopeRef[] = [];
		for (let index = 0; index < scopeCount; index += 1) {
			const scopeId = `cmt_bulk_${String(index).padStart(3, "0")}`;
			await insertSubscription({ name: `bulk_${String(index).padStart(3, "0")}`, scopeType: "comment", scopeId });
			scopes.push({ scopeType: "comment", scopeId });
		}
		await insertSubscription({ name: "bulk_survivor", scopeType: "comment", scopeId: "cmt_bulk_survivor" });

		const db = subscriptionDb();
		const statements = humanSubscriptionScopeDeleteStatements(db, scopes);
		const results = await db.batch(statements);

		expect(statements).toHaveLength(2);
		expect(results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0)).toBe(scopeCount);
		expect(await remainingFixtures()).toEqual(["bulk_survivor"]);
	});

	it("clears the comment scope when a comment is soft deleted, leaving reparented children subscribed", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "comment-scope-cleanup");
		const bot = await createBotForTest(cookie, "comment-scope-author");
		const thread = await createThreadForTest(forum.id, bot.id, "Comment cleanup", "Root body.");
		const parent = await createCommentForTest(thread.id, bot.id, "Parent comment.");
		const child = await createCommentForTest(thread.id, bot.id, "Child comment.", parent.id);
		await insertSubscription({ name: "parent", scopeType: "comment", scopeId: parent.id });
		await insertSubscription({ name: "child", scopeType: "comment", scopeId: child.id });
		await insertSubscription({ name: "thread", scopeType: "thread", scopeId: thread.id });

		const response = await deleteCommentRoute(
			contextFor<typeof deleteCommentRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/comment-scope-cleanup/threads/${thread.id}/comments/${parent.id}`,
					{ method: "DELETE", headers: { cookie } },
				),
				{
					worldHandle: "patch-notes",
					forumHandle: "comment-scope-cleanup",
					threadId: thread.id,
					commentId: parent.id,
				},
			),
		);

		expect(response.status).toBe(200);
		expect(await subscriptionCountForScope("comment", parent.id)).toBe(0);
		// The child was reparented, not deleted, so its subscription still points
		// at a live comment.
		expect(await remainingFixtures()).toEqual(["child", "thread"]);
	});

	it("clears the thread scope and every one of its comment scopes when a thread is deleted", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "thread-scope-cleanup");
		const bot = await createBotForTest(cookie, "thread-scope-author");
		const thread = await createThreadForTest(forum.id, bot.id, "Thread cleanup", "Root body.");
		const first = await createCommentForTest(thread.id, bot.id, "First comment.");
		const second = await createCommentForTest(thread.id, bot.id, "Second comment.", first.id);
		const otherThread = await createThreadForTest(forum.id, bot.id, "Other thread", "Untouched body.");
		await insertSubscription({ name: "thread", scopeType: "thread", scopeId: thread.id });
		await insertSubscription({ name: "root", scopeType: "comment", scopeId: thread.rootCommentId });
		await insertSubscription({ name: "first", scopeType: "comment", scopeId: first.id });
		// An opt-out on a comment of the dying thread dies with it.
		await insertSubscription({ name: "second_optout", scopeType: "comment", scopeId: second.id, active: false });
		await insertSubscription({ name: "other_thread", scopeType: "thread", scopeId: otherThread.id });

		const response = await deleteThreadRoute(
			contextFor<typeof deleteThreadRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/thread-scope-cleanup/threads/${thread.id}`,
					{ method: "DELETE", headers: { cookie } },
				),
				{ worldHandle: "patch-notes", forumHandle: "thread-scope-cleanup", threadId: thread.id },
			),
		);

		expect(response.status).toBe(200);
		expect(await remainingFixtures()).toEqual(["other_thread"]);
		for (const commentId of [thread.rootCommentId, first.id, second.id]) {
			expect(await subscriptionCountForScope("comment", commentId)).toBe(0);
		}
		expect(await subscriptionCountForScope("thread", thread.id)).toBe(0);
	});

	it("clears the forum scope and cascades to the threads and comments it deletes", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "forum-scope-cleanup");
		const survivingForum = await createForumForTest(cookie, "forum-scope-survivor");
		const bot = await createBotForTest(cookie, "forum-scope-author");
		const thread = await createThreadForTest(forum.id, bot.id, "Forum cleanup", "Root body.");
		const comment = await createCommentForTest(thread.id, bot.id, "Comment under a doomed forum.");
		await insertSubscription({ name: "forum", scopeType: "forum", scopeId: forum.id });
		await insertSubscription({ name: "forum_thread", scopeType: "thread", scopeId: thread.id });
		await insertSubscription({ name: "forum_comment", scopeType: "comment", scopeId: comment.id });
		await insertSubscription({ name: "forum_survivor", scopeType: "forum", scopeId: survivingForum.id });

		const response = await deleteForumRoute(
			contextFor<typeof deleteForumRoute>(
				new Request("http://example.com/api/worlds/patch-notes/forums/forum-scope-cleanup", {
					method: "DELETE",
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "forum-scope-cleanup" },
			),
		);

		expect(response.status).toBe(200);
		expect(await remainingFixtures()).toEqual(["forum_survivor"]);
		expect(await subscriptionCountForScope("forum", forum.id)).toBe(0);
		expect(await subscriptionCountForScope("thread", thread.id)).toBe(0);
		expect(await subscriptionCountForScope("comment", comment.id)).toBe(0);
	});

	it("clears the bot scope when a participant is deleted", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const doomed = await createBotForTest(cookie, "bot-scope-doomed");
		const surviving = await createBotForTest(cookie, "bot-scope-surviving");
		await insertSubscription({ name: "bot", scopeType: "bot", scopeId: doomed.id });
		await insertSubscription({ name: "bot_optout", scopeType: "bot", scopeId: doomed.id, userId: "usr_other", active: false });
		await insertSubscription({ name: "bot_survivor", scopeType: "bot", scopeId: surviving.id });

		const response = await deleteBot(
			contextFor<typeof deleteBot>(
				new Request(`http://example.com/api/me/bots/${doomed.id}`, { method: "DELETE", headers: { cookie } }),
				{ botId: doomed.id },
			),
		);

		expect(response.status).toBe(200);
		expect(await remainingFixtures()).toEqual(["bot_survivor"]);
		expect(await subscriptionCountForScope("bot", doomed.id)).toBe(0);
	});

	it("clears the world scope, and its forums' scopes, when a world is deleted", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "world-scope-cleanup");
		const worldId = await worldIdForHandle("patch-notes");
		await insertSubscription({ name: "world", scopeType: "world", scopeId: worldId });
		await insertSubscription({ name: "world_forum", scopeType: "forum", scopeId: forum.id });
		await insertSubscription({ name: "world_survivor", scopeType: "world", scopeId: "wld_elsewhere" });

		const response = await deleteWorldRoute(
			contextFor<typeof deleteWorldRoute>(
				new Request("http://example.com/api/worlds/patch-notes", { method: "DELETE", headers: { cookie } }),
				{ worldHandle: "patch-notes" },
			),
		);

		expect(response.status).toBe(200);
		expect(await remainingFixtures()).toEqual(["world_survivor"]);
		expect(await subscriptionCountForScope("world", worldId)).toBe(0);
		expect(await subscriptionCountForScope("forum", forum.id)).toBe(0);
	});

	it("clears the deleted account's own rows and the scope rows of everything its cascade deletes", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "account-scope-cleanup");
		const bot = await createBotForTest(cookie, "account-scope-bot");
		const thread = await createThreadForTest(forum.id, bot.id, "Account cleanup", "Root body.");
		const userId = await userIdForHandle("octocat");
		const worldId = await worldIdForHandle("patch-notes");

		// The account's own subscriptions, including one on an entity that is not
		// part of its cascade at all.
		await insertSubscription({ name: "own_bot", scopeType: "bot", scopeId: bot.id, userId });
		await insertSubscription({ name: "own_elsewhere", scopeType: "world", scopeId: "wld_elsewhere", userId });
		// Another human's subscriptions on the entities this cascade destroys.
		await insertSubscription({ name: "other_bot", scopeType: "bot", scopeId: bot.id, userId: "usr_bystander" });
		await insertSubscription({ name: "other_forum", scopeType: "forum", scopeId: forum.id, userId: "usr_bystander" });
		await insertSubscription({ name: "other_thread", scopeType: "thread", scopeId: thread.id, userId: "usr_bystander" });
		await insertSubscription({ name: "other_world", scopeType: "world", scopeId: worldId, userId: "usr_bystander" });
		// A bystander's subscription on something the cascade never touches.
		await insertSubscription({ name: "other_survivor", scopeType: "bot", scopeId: "bot_elsewhere", userId: "usr_bystander" });

		const response = await deleteProfileRoute(
			contextFor<typeof deleteProfileRoute>(
				jsonRequest("http://example.com/api/me/profile", "DELETE", { confirmCascade: true }, cookie),
			),
		);

		expect(response.status).toBe(200);
		expect(await remainingFixtures()).toEqual(["other_survivor"]);
		for (const [scopeType, scopeId] of [
			["bot", bot.id],
			["forum", forum.id],
			["thread", thread.id],
			["world", worldId],
		] as const) {
			expect(await subscriptionCountForScope(scopeType, scopeId)).toBe(0);
		}
		const remainingForUser = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM human_subscriptions WHERE user_id = ?`,
		)
			.bind(userId)
			.first<{ count: number }>();
		expect(remainingForUser?.count).toBe(0);
	});
});
