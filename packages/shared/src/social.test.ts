import { describe, expect, it, vi } from "vitest";
import {
	formatCommentRef,
	formatThreadRef,
	isShortContentId,
	parseCommentRef,
	parseObjectRef,
	parseThreadRef,
} from "./ids";
import {
	bootstrapNotificationId,
	createComment,
	createThread,
	deleteDeliveredNotifications,
	ensureBootstrapNotification,
	listThreadsWithReadState,
	markAllHumanNotificationsRead,
	parseHumanNotificationReadAnchor,
	notificationKvExpirationTtlSeconds,
	notificationTypePriority,
	orderedDeliveryReasons,
	pruneExpiredBotSeenContent,
	threadHotScore,
} from "./social";
import { InputError } from "./validation";
import { kvKeys, type D1DatabaseLike, type D1PreparedStatementLike, type D1Result, type KVNamespaceLike } from "./storage";
import { localizedTextString, schemaVersion, type BotDocument, type ForumDocument, type LanguageTag, type NotificationDeliveryReason, type NotificationDocument, type NotificationType, type PostingSettings, type RequiredLocalizedText, type ThreadSettings, type ThreadSummary, type WorldDocument } from "./model";

const now = "2026-05-06T12:00:00.000Z";
const enLang = "en" as LanguageTag;
const en = (text: string): RequiredLocalizedText => ({ lang: enLang, text });

describe("threadHotScore", () => {
	it("linearly decays engagement over the seven-day activity window", () => {
		const input = { voteScore: 2, recentCommentCount: 4, lastActivityAt: now };
		expect(threadHotScore(input, now)).toBeCloseTo(10);
		expect(threadHotScore(input, "2026-05-10T00:00:00.000Z")).toBeCloseTo(5);
		expect(threadHotScore(input, "2026-05-13T12:00:00.000Z")).toBe(0);
		expect(threadHotScore(input, "2026-05-14T12:00:00.000Z")).toBe(0);
	});

	it("clamps negative engagement and future activity timestamps", () => {
		expect(threadHotScore({ voteScore: -10, recentCommentCount: 1, lastActivityAt: now }, now)).toBe(0);
		expect(threadHotScore(
			{ voteScore: 1, recentCommentCount: 1, lastActivityAt: "2026-05-07T12:00:00.000Z" },
			now,
		)).toBeCloseTo(3.5);
	});
});

describe("pruneExpiredBotSeenContent", () => {
	it("deletes old seen-content rows in bounded D1 batches and resumes cleanly", async () => {
		const db = new FakeSeenContentRetentionD1([
			{ id: "old_1", lastSeenAt: "2026-03-01T00:00:00.000Z" },
			{ id: "old_2", lastSeenAt: "2026-03-02T00:00:00.000Z" },
			{ id: "old_3", lastSeenAt: "2026-03-03T00:00:00.000Z" },
			{ id: "old_4", lastSeenAt: "2026-03-04T00:00:00.000Z" },
			{ id: "old_5", lastSeenAt: "2026-03-05T00:00:00.000Z" },
			{ id: "new_1", lastSeenAt: "2026-06-01T00:00:00.000Z" },
		]);

		const firstRun = await pruneExpiredBotSeenContent(db, {
			now: "2026-07-01T00:00:00.000Z",
			batchSize: 2,
			maxRowsPerRun: 3,
		});

		expect(firstRun).toEqual({
			deletedRows: 3,
			batches: 2,
			budgetExhausted: true,
		});
		expect(db.rows.filter((row) => row.id.startsWith("old_"))).toHaveLength(2);
		expect(db.rows.map((row) => row.id)).toContain("new_1");
		expect(db.runs.map((run) => run.bindings[1])).toEqual([2, 1]);
		expect(db.runs[0]?.query).toContain("DELETE FROM bot_seen_content");
		expect(db.runs[0]?.query).toContain("WHERE last_seen_at < ?");
		expect(db.runs[0]?.query).toContain("LIMIT ?");

		const secondRun = await pruneExpiredBotSeenContent(db, {
			now: "2026-07-01T00:00:00.000Z",
			batchSize: 2,
			maxRowsPerRun: 3,
		});

		expect(secondRun).toEqual({
			deletedRows: 2,
			batches: 1,
			budgetExhausted: false,
		});
		expect(db.rows.map((row) => row.id)).toEqual(["new_1"]);
	});
});

describe("createThread duplicate title guard", () => {
	it("rejects an active duplicate title in the same forum before writing", async () => {
		const { db, kv } = fixture({
			existingThreads: [
				{
					id: "thr_existing",
					forumId: "frm_main",
					title: "Same title",
					worldHandle: "primary",
					forumHandle: "general",
					createdAt: "2026-05-01T00:00:00.000Z",
				},
			],
		});

		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Same title"),
			body: en("Fresh body"),
		}, now)).rejects.toMatchObject({
			code: "conflict",
			status: 409,
			details: {
				existingThread: {
					id: "thr_existing",
					title: en("Same title"),
					worldHandle: "primary",
					forumHandle: "general",
					urlPath: "/w/primary/f/general/t/thr_existing",
				},
			},
		});
		expect(kv.puts).toEqual([]);
	});

	it("allows deleted or different-forum title matches", async () => {
		const { db, kv } = fixture({
			existingThreads: [
				{
					id: "thr_deleted",
					forumId: "frm_main",
					title: "Reusable title",
					worldHandle: "primary",
					forumHandle: "general",
					createdAt: "2026-05-01T00:00:00.000Z",
					deletedAt: "2026-05-02T00:00:00.000Z",
				},
				{
					id: "thr_elsewhere",
					forumId: "frm_other",
					title: "Reusable title",
					worldHandle: "primary",
					forumHandle: "other",
					createdAt: "2026-05-01T00:00:00.000Z",
				},
			],
		});

		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Reusable title"),
			body: en("Fresh body"),
		}, now)).resolves.toMatchObject({
			forumId: "frm_main",
			title: en("Reusable title"),
		});
		expect(kv.puts.some((key) => /^v1:thread:[a-z2-7]{8}$/.test(key))).toBe(true);
	});

	it("preserves exact body text while rejecting all-whitespace bodies", async () => {
		const { db, kv } = fixture({ existingThreads: [] });
		const body = "  Leading and trailing text.  \n";

		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Preserve body"),
			body: en(body),
		}, now);

		expect(thread.comments[0]?.body.text).toBe(body);
		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Blank body"),
			body: en(" \n\t "),
		}, now)).rejects.toMatchObject({
			name: "InputError",
			message: "Thread body is required.",
		});
	});

	it("uses the effective posting limit as a soft target and accepts up to twice that length", async () => {
		const { db, kv } = fixture({
			existingThreads: [],
			worldPostingSettings: { threadBodyCharacters: 100 },
			botPostingSettings: { threadBodyCharacters: 80 },
		});

		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("At hard limit"),
			body: en("x".repeat(160)),
		}, now)).resolves.toMatchObject({ title: en("At hard limit") });
		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Over hard limit"),
			body: en("x".repeat(161)),
		}, now)).rejects.toMatchObject({
			name: "InputError",
			message: "Thread body must be 160 characters or fewer.",
		});
	});

	it("applies the effective posting limit to comment bodies", async () => {
		const { db, kv } = fixture({
			existingThreads: [],
			worldPostingSettings: { commentBodyCharacters: 50 },
			botPostingSettings: { commentBodyCharacters: 40 },
		});
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Comment target"),
			body: en("Root body"),
		}, now);

		await expect(createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: en("x".repeat(80)),
		}, now)).resolves.toMatchObject({ thread: { id: thread.id } });
		await expect(createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: en("x".repeat(81)),
		}, now)).rejects.toMatchObject({
			name: "InputError",
			message: "Comment body must be 80 characters or fewer.",
		});
	});

	it("locks existing threads at the smaller world or forum comment limit only when adding a comment", async () => {
		const { db, kv } = fixture({
			existingThreads: [],
			worldThreadSettings: { commentLimit: 3 },
			forumThreadSettings: { commentLimit: 2 },
		});
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Limited thread"),
			body: en("Root body"),
		}, now);
		expect(thread.commentCount).toBe(1);

		const atLimit = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: en("Allowed final comment"),
		}, now, { thread });
		expect(atLimit.thread.commentCount).toBe(2);

		await expect(createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: en("Rejected after lock"),
		}, now, { thread: atLimit.thread })).rejects.toMatchObject({
			code: "conflict",
			status: 409,
			message: "Thread is locked after reaching its 2-comment limit.",
		});
	});

	it("allows thread creation even when the root comment immediately reaches the configured limit", async () => {
		const { db, kv } = fixture({
			existingThreads: [],
			forumThreadSettings: { commentLimit: 1 },
		});
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Immediately locked"),
			body: en("Root body"),
		}, now);
		expect(thread.commentCount).toBe(1);
		await expect(createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: en("No reply allowed"),
		}, now, { thread })).rejects.toMatchObject({ code: "conflict", status: 409 });
	});

	it("creates short thread and comment IDs with the root comment sharing the thread ID", async () => {
		const { db, kv } = fixture({ existingThreads: [] });
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Short refs"),
			body: en("Root body"),
		}, now);
		const { comment: reply } = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: en("Reply body"),
		}, now, { thread });

		expect(isShortContentId(thread.id)).toBe(true);
		expect(thread.rootCommentId).toBe(thread.id);
		expect(thread.comments[0]?.id).toBe(thread.id);
		expect(reply?.id).toMatch(/^[a-z2-7]{8}$/);
		expect(reply?.id).not.toBe(thread.id);
	});

	it("retries short ID reservation collisions", async () => {
		const restore = mockRandomBytes([
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 1],
		]);
		try {
			const { db, kv } = fixture({
				existingThreads: [],
				reservedContentIds: new Set(["aaaaaaaa"]),
			});
			const thread = await createThread(kv, db, {
				forumId: "frm_main",
				authorBotId: "bot_author",
				title: en("Collision retry"),
				body: en("Root body"),
			}, now);

			expect(thread.id).toBe("aaaaaaab");
			expect(db.contentIds.has("aaaaaaaa")).toBe(true);
			expect(db.contentIds.has("aaaaaaab")).toBe(true);
		} finally {
			restore();
		}
	});
});

describe("mention canonicalization at the write boundary", () => {
	const mentionFixture = (options: Partial<FixtureOptions> = {}) => fixture({
		existingThreads: [],
		indexedBots: [
			{ id: "bot_bob", handle: "bob" },
			{ id: "bot_carol", handle: "carol" },
			{ id: "bot_u", handle: "u" },
			{ id: "bot_gone", handle: "gone", deletedAt: "2026-05-01T00:00:00.000Z" },
			{ id: "bot_idle", handle: "idle", lifecycleState: "suspended" },
			{ id: "bot_far", handle: "far", worldId: "wld_other" },
		],
		...options,
	});

	const mentionNotificationCount = (kv: FakeKV, botId: string): number =>
		kv.puts.filter((key) => key.startsWith(`v1:notification:${botId}:`)).length;

	it("rewrites both authored forms in the title and body of one mutation", async () => {
		const { db, kv } = mentionFixture();

		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Ping @bob about it"),
			body: en("Also (@u/carol) and @BOB, plus u/bob already canonical."),
		}, now);

		expect(thread.title).toEqual(en("Ping u/bob about it"));
		expect(thread.comments[0]?.body).toEqual(
			en("Also (u/carol) and u/bob, plus u/bob already canonical."),
		);
		// Title and body are extracted separately but resolved together.
		expect(db.mentionLookups).toHaveLength(1);
	});

	it("leaves unresolved, deleted, inactive, and other-world candidates exactly unchanged", async () => {
		const { db, kv } = mentionFixture();
		const body = "@nobody @gone @idle @far x@bob emoji\u{1f642}@bob @@bob @u/ @½ @bob@example.com stay put.";

		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Unresolved mentions"),
			body: en(body),
		}, now);

		expect(thread.comments[0]?.body).toEqual(en(body));
		expect(kv.puts.some((key) => key.startsWith("v1:notification:"))).toBe(false);
	});

	it("notifies each mentioned participant once across spellings and excludes the author", async () => {
		const { db, kv } = mentionFixture();

		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Hello @bob"),
			body: en("@BOB, @u/bob and u/bob are the same participant. Also @alice, me."),
		}, now);

		expect(thread.title).toEqual(en("Hello u/bob"));
		expect(thread.comments[0]?.body).toEqual(
			en("u/bob, u/bob and u/bob are the same participant. Also u/alice, me."),
		);
		expect(mentionNotificationCount(kv, "bot_bob")).toBe(1);
		// The author's own handle is canonicalized but never notifies them.
		expect(mentionNotificationCount(kv, "bot_author")).toBe(0);
	});

	it("rejects a title that only overflows after canonicalization", async () => {
		const { db, kv } = mentionFixture();
		const title = `${"t".repeat(147)} @carol`;
		expect(title.length).toBe(154);

		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en(`${title} @carol`),
			body: en("Root body"),
		}, now)).rejects.toMatchObject({
			name: "InputError",
			message: "Thread title must be 160 characters or fewer.",
		});
		expect(kv.puts).toEqual([]);
		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en(title),
			body: en("Root body"),
		}, now)).resolves.toMatchObject({ title: en(`${"t".repeat(147)} u/carol`) });
	});

	it("rejects a body that only overflows after canonicalization", async () => {
		const { db, kv } = mentionFixture({ worldPostingSettings: { threadBodyCharacters: 10 } });

		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Dense mentions"),
			body: en("@bob @bob @bob @carol"),
		}, now)).rejects.toMatchObject({
			name: "InputError",
			message: "Thread body must be 20 characters or fewer.",
		});
		expect(kv.puts).toEqual([]);
	});

	it("detects duplicate titles using the canonicalized title", async () => {
		const { db, kv } = mentionFixture({
			existingThreads: [
				{
					id: "thr_existing",
					forumId: "frm_main",
					title: "Welcome u/bob",
					worldHandle: "primary",
					forumHandle: "general",
					createdAt: "2026-05-01T00:00:00.000Z",
				},
			],
		});

		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Welcome @bob"),
			body: en("Root body"),
		}, now)).rejects.toMatchObject({
			code: "conflict",
			status: 409,
			message: 'A thread titled "Welcome u/bob" already exists in f/general: thr_existing.',
		});
		expect(kv.puts).toEqual([]);
	});

	it("resolves more than one chunk of distinct candidates without truncating", async () => {
		const handles = Array.from({ length: 120 }, (_, index) => `participant${index}`);
		const { db, kv } = mentionFixture({
			indexedBots: handles.map((handle, index) => ({ id: `bot_${index}`, handle })),
		});

		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Many mentions"),
			body: en(handles.map((handle) => `@${handle}`).join(" ")),
		}, now);

		expect(thread.comments[0]?.body.text).toBe(handles.map((handle) => `u/${handle}`).join(" "));
		expect(db.mentionLookups).toHaveLength(2);
		for (const bindings of db.mentionLookups) {
			expect(bindings.length).toBeLessThanOrEqual(99);
		}
		const notified = handles.filter((_, index) => mentionNotificationCount(kv, `bot_${index}`) === 1);
		expect(notified).toHaveLength(handles.length);
	});

	it("canonicalizes comment and reply bodies and preserves their language tag", async () => {
		const { db, kv } = mentionFixture();
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Comment mentions"),
			body: en("Root body"),
		}, now);

		const comment = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: { lang: "ja" as LanguageTag, text: "@bob さん、@u/carol も。" },
		}, now, { thread });
		const reply = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			parentCommentId: comment.comment.id,
			body: en("Replying about @nobody and @carol."),
		}, now, { thread: comment.thread });

		expect(comment.comment.body).toEqual({ lang: "ja", text: "u/bob さん、u/carol も。" });
		expect(reply.comment.body).toEqual(en("Replying about @nobody and u/carol."));
		expect(mentionNotificationCount(kv, "bot_carol")).toBe(2);
	});

	it("is a fixpoint: storing canonicalized text again changes nothing", async () => {
		const { db, kv } = mentionFixture();
		const authored = "@bob, @u/carol, u/bob, @u/u/carol and @nobody.";

		const first = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Fixpoint"),
			body: en(authored),
		}, now);
		const second = await createComment(kv, db, {
			threadId: first.id,
			authorBotId: "bot_author",
			body: en(localizedTextString(first.comments[0]?.body)),
		}, now, { thread: first });

		expect(localizedTextString(first.comments[0]?.body)).toBe("u/bob, u/carol, u/bob, @u/u/carol and @nobody.");
		expect(second.comment.body.text).toBe(localizedTextString(first.comments[0]?.body));
	});
});

describe("notification payloads per recipient class", () => {
	/** Two participants: the fixture's author and a reader that can post as well. */
	const payloadFixture = async (options: Partial<FixtureOptions> = {}) => {
		const built = fixture({
			existingThreads: [],
			indexedBots: [{ id: "bot_reader", handle: "reader" }],
			...options,
		});
		const reader: BotDocument = {
			...built.bot,
			id: "bot_reader",
			handle: "reader",
			displayName: en("Reader"),
		};
		await built.kv.put(kvKeys.bot(reader.id), JSON.stringify(reader));
		built.kv.puts.length = 0;
		built.kv.putOptions.length = 0;
		return { ...built, reader };
	};

	const storedNotifications = async (kv: FakeKV): Promise<NotificationDocument[]> => {
		const keys = [...new Set(kv.puts.filter((key) => key.startsWith("v1:notification:")))];
		const documents = await Promise.all(keys.map((key) => kv.get(key, { type: "json" }) as Promise<NotificationDocument>));
		return documents;
	};

	const storedNotificationFor = async (kv: FakeKV, botId: string): Promise<NotificationDocument> => {
		const documents = await storedNotifications(kv);
		const match = documents.find((document) => document.botId === botId);
		if (!match) {
			throw new Error(`Expected a notification for ${botId}.`);
		}
		return match;
	};

	/** What the KV document costs, which is what the retention numbers are made of. */
	const storedBytes = (notification: NotificationDocument): number => JSON.stringify(notification).length;

	it("gives a new thread's followers the root post and its mentions only the mentioning comment", async () => {
		const { db, kv, bot } = await payloadFixture({ followerBotIds: ["bot_follower"] });

		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: bot.id,
			title: en("Root payloads"),
			body: en("Root body for u/reader."),
		}, now);

		const follower = await storedNotificationFor(kv, "bot_follower");
		expect(follower.notificationType).toBe("followed_activity");
		expect(follower.event).toEqual({
			kind: "thread_post",
			type: "thread_created",
			id: follower.id,
			createdAt: now,
			deliveryReasons: ["followed_profile_activity"],
			sourceObjectId: formatThreadRef(thread.id),
			actor: { id: bot.id, username: "u/alice", displayName: en("Alice") },
			thread: {
				id: thread.id,
				title: en("Root payloads"),
				author: { id: bot.id, username: "u/alice", displayName: en("Alice") },
				text: en("Root body for u/reader."),
			},
		});

		// A mention of a new thread's root comment is a mention, not a thread post:
		// the same references, with the root comment as the mentioning comment.
		const mentioned = await storedNotificationFor(kv, "bot_reader");
		expect(mentioned.notificationType).toBe("mention");
		expect(mentioned.event).toEqual({
			kind: "mention",
			type: "thread_created",
			id: mentioned.id,
			createdAt: now,
			deliveryReasons: ["mention"],
			sourceObjectId: formatThreadRef(thread.id),
			actor: { id: bot.id, username: "u/alice", displayName: en("Alice") },
			thread: { id: thread.id, title: en("Root payloads") },
			comment: {
				id: thread.rootCommentId,
				threadId: thread.id,
				author: { id: bot.id, username: "u/alice", displayName: en("Alice") },
				text: en("Root body for u/reader."),
			},
		});
	});

	it("gives a comment's parent author the reply and the author's followers a body-free notice", async () => {
		const { db, kv, bot } = await payloadFixture({ followerBotIds: ["bot_follower"] });
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_reader",
			title: en("Reply payloads"),
			body: en("Root body nobody replied to."),
		}, now);
		const { thread: withParent, comment: parent } = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_reader",
			body: en("Parent comment."),
		}, now, { thread });
		kv.puts.length = 0;

		const { thread: updated, comment: reply } = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: bot.id,
			parentCommentId: parent.id,
			body: en("Reply body."),
		}, now, { thread: withParent });
		expect(updated.commentCount).toBe(3);

		const parentAuthor = await storedNotificationFor(kv, "bot_reader");
		expect(parentAuthor.notificationType).toBe("reply");
		expect(parentAuthor.event).toEqual({
			kind: "reply",
			type: "comment_created",
			id: parentAuthor.id,
			createdAt: now,
			deliveryReasons: ["direct_reply"],
			sourceObjectId: formatCommentRef(reply.id),
			actor: { id: bot.id, username: "u/alice", displayName: en("Alice") },
			thread: { id: thread.id, title: en("Reply payloads") },
			comment: {
				id: reply.id,
				threadId: thread.id,
				parentCommentId: parent.id,
				author: { id: bot.id, username: "u/alice", displayName: en("Alice") },
				text: en("Reply body."),
			},
			replyTo: {
				id: parent.id,
				threadId: thread.id,
				parentCommentId: thread.rootCommentId,
				author: { id: "bot_reader", username: "u/reader", displayName: en("Reader") },
				text: en("Parent comment."),
			},
		});
		// The parent is not the root, so the root post is not part of the payload.
		expect(JSON.stringify(parentAuthor.event)).not.toContain("Root body nobody replied to.");

		const follower = await storedNotificationFor(kv, "bot_follower");
		expect(follower.notificationType).toBe("followed_activity");
		expect(follower.event).toEqual({
			kind: "comment_notice",
			type: "comment_created",
			id: follower.id,
			createdAt: now,
			deliveryReasons: ["followed_profile_activity"],
			sourceObjectId: formatCommentRef(reply.id),
			actor: { id: bot.id, username: "u/alice", displayName: en("Alice") },
			thread: { id: thread.id, title: en("Reply payloads") },
			comment: { id: reply.id, threadId: thread.id, parentCommentId: parent.id },
		});
	});

	it("carries the root post in a reply exactly when the parent is the root comment", async () => {
		const { db, kv, bot } = await payloadFixture();
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_reader",
			title: en("Root parent"),
			body: en("Root body is the parent here."),
		}, now);
		kv.puts.length = 0;

		const { comment: reply } = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: bot.id,
			body: en("Reply to the root."),
		}, now, { thread });

		const rootAuthor = await storedNotificationFor(kv, "bot_reader");
		expect(rootAuthor.event).toMatchObject({
			kind: "reply",
			comment: { id: reply.id, text: en("Reply to the root.") },
			replyTo: { id: thread.rootCommentId, threadId: thread.id, text: en("Root body is the parent here.") },
		});
	});

	it("keeps a merged recipient on the payload of the notification type that won", async () => {
		const { db, kv, bot } = await payloadFixture({ followerBotIds: ["bot_reader"] });

		await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: bot.id,
			title: en("Merged classes"),
			body: en("Body for u/reader who also follows me."),
		}, now);

		const merged = await storedNotificationFor(kv, "bot_reader");
		expect(merged.notificationType).toBe("mention");
		expect(merged.event?.kind).toBe("mention");
		expect(merged.event?.deliveryReasons).toEqual(["mention", "followed_profile_activity"]);
		expect(localizedTextString(merged.message)).toBe(`Alice mentioned you in "Merged classes".`);
	});

	it("keeps follower notices under a kilobyte no matter how long the content is", async () => {
		const { db, kv, bot } = await payloadFixture({ followerBotIds: ["bot_follower"] });
		const longBody = "L".repeat(6_000);
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: bot.id,
			title: en("Long content"),
			body: en(longBody),
		}, now);
		const postNotice = await storedNotificationFor(kv, "bot_follower");
		kv.puts.length = 0;

		await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: bot.id,
			body: en(longBody),
		}, now, { thread });
		const commentNotice = await storedNotificationFor(kv, "bot_follower");

		// A new thread is the one payload that pays for the body; every comment
		// after it is a reference and a title, which is what makes the steady-state
		// notification store small.
		expect(storedBytes(postNotice)).toBeGreaterThan(6_000);
		expect(commentNotice.event?.kind).toBe("comment_notice");
		expect(storedBytes(commentNotice)).toBeLessThan(1_024);
	});
});

describe("notification type and delivery reason ordering", () => {
	it("ranks every notification type, including the new unfollow", () => {
		// The literal is exhaustive over the union, so a type added without a rank
		// fails to compile here rather than sorting arbitrarily at delivery time.
		const expected: Record<NotificationType, number> = {
			bootstrap: 0,
			reply: 1,
			mention: 2,
			personal_forum_post: 3,
			follow: 4,
			unfollow: 4,
			vote: 4,
			followed_activity: 5,
			interest: 6,
			system: 6,
		};
		for (const [type, priority] of Object.entries(expected) as Array<[NotificationType, number]>) {
			expect(notificationTypePriority(type)).toBe(priority);
		}
	});

	it("keeps every delivery reason in the stored order instead of dropping it", () => {
		const order: Record<NotificationDeliveryReason, number> = {
			bootstrap: 0,
			direct_reply: 1,
			mention: 2,
			personal_forum_post: 3,
			profile_followed_you: 4,
			profile_unfollowed_you: 5,
			vote_on_your_content: 6,
			followed_profile_activity: 7,
			system: 8,
		};
		const reasons = Object.keys(order) as NotificationDeliveryReason[];

		expect(orderedDeliveryReasons(new Set([...reasons].reverse()))).toEqual(reasons);
		expect(orderedDeliveryReasons(new Set(["profile_unfollowed_you"]))).toEqual(["profile_unfollowed_you"]);
		expect(orderedDeliveryReasons(new Set(["followed_profile_activity", "mention"]))).toEqual([
			"mention",
			"followed_profile_activity",
		]);
	});
});

describe("bot notification retention", () => {
	it("writes the pending bootstrap document without a TTL", async () => {
		const { db, kv, bot } = bootstrapFixture();

		await ensureBootstrapNotification(kv, db, bot, now);

		// Retention exception: a bot paused past the pending retention would lose
		// the bootstrap document it never received, and the flag would block a
		// replacement forever.
		expect(kv.puts).toEqual([kvKeys.notification(bot.id, await bootstrapNotificationId(bot.id))]);
		expect(kv.putOptions).toEqual([undefined]);
	});

	it("deletes a delivered notification from D1 before KV", async () => {
		const { db, kv, bot } = fixture({ existingThreads: [] });
		const notification: NotificationDocument = {
			id: "ntf_delivered",
			type: "notification",
			schemaVersion,
			revision: 1,
			worldId: bot.homeWorldId,
			botId: bot.id,
			notificationType: "reply",
			status: "pending",
			message: { lang: enLang, text: "Someone replied to you." },
			createdAt: now,
			updatedAt: now,
		};
		const operations: string[] = [];
		db.operationLog = operations;
		kv.operationLog = operations;

		await deleteDeliveredNotifications(kv, db, [notification]);

		// Row first: a row whose document is already gone is a ghost that holds a
		// slot in the delivery window until the self-heal reaps it, while a document
		// whose row is gone is invisible and expires on its own TTL.
		expect(operations).toEqual([
			"d1:DELETE FROM notifications WHERE notification_id IN (?)",
			`kv:delete:${kvKeys.notification(bot.id, notification.id)}`,
		]);
	});

	it("does nothing when a visit was handed no notifications", async () => {
		const { db, kv } = fixture({ existingThreads: [] });
		const operations: string[] = [];
		db.operationLog = operations;
		kv.operationLog = operations;

		await deleteDeliveredNotifications(kv, db, []);

		expect(operations).toEqual([]);
	});

	it("batches merged bot notification fan-out without changing recipient messages or TTLs", async () => {
		const { db, kv, bot } = fixture({
			existingThreads: [],
			followerBotIds: ["bot_personal", "bot_follower"],
			forumPersonalBotId: "bot_personal",
		});

		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: bot.id,
			title: en("Batch notifications"),
			body: en("Root body"),
		}, now);
		const notificationKeys = kv.puts.filter((key) => key.startsWith("v1:notification:"));
		const notifications = await Promise.all(
			notificationKeys.map((key) => kv.get(key, { type: "json" }) as Promise<NotificationDocument | null>),
		);

		expect(notifications).toHaveLength(2);
		expect(new Set(notifications.map((notification) => notification?.botId))).toEqual(new Set(["bot_personal", "bot_follower"]));
		const personal = notifications.find((notification) => notification?.botId === "bot_personal");
		const follower = notifications.find((notification) => notification?.botId === "bot_follower");
		expect(personal).toMatchObject({
			notificationType: "personal_forum_post",
			sourceObjectId: formatThreadRef(thread.id),
			message: {
				text: `Alice created a thread in your personal forum: "Batch notifications".`,
			},
			event: {
				type: "thread_created",
				deliveryReasons: ["personal_forum_post", "followed_profile_activity"],
			},
		});
		expect(follower).toMatchObject({
			notificationType: "followed_activity",
			sourceObjectId: formatThreadRef(thread.id),
			message: {
				text: `Alice created "Batch notifications".`,
			},
			event: {
				type: "thread_created",
				deliveryReasons: ["followed_profile_activity"],
			},
		});
		for (const key of notificationKeys) {
			const index = kv.puts.indexOf(key);
			expect(kv.putOptions[index]).toEqual({
				expirationTtl: notificationKvExpirationTtlSeconds,
			});
		}
		const notificationInserts = db.runs.filter((run) => run.query.includes("INSERT OR IGNORE INTO notifications"));
		expect(notificationInserts).toHaveLength(1);
		expect(notificationInserts[0]?.bindings).toHaveLength(18);
	});
});

describe("ensureBootstrapNotification", () => {
	const later = "2026-05-07T12:00:00.000Z";

	it("bootstraps a never-notified bot exactly once and records the flag", async () => {
		const { db, kv, bot } = bootstrapFixture();
		const notificationId = await bootstrapNotificationId(bot.id);

		await ensureBootstrapNotification(kv, db, bot, now);

		expect(db.notifications).toEqual([
			{ id: notificationId, botId: bot.id, type: "bootstrap", status: "pending", createdAt: now },
		]);
		expect(db.bootstrapNotifiedAt).toBe(now);

		const queriesBefore = db.queries.length;
		await ensureBootstrapNotification(kv, db, bot, later);

		expect(db.notifications).toHaveLength(1);
		expect(kv.puts).toHaveLength(1);
		expect(db.queries.slice(queriesBefore).some((query) => query.includes("FROM notifications"))).toBe(false);
		expect(db.bootstrapNotifiedAt).toBe(now);
	});

	it("answers from the flag alone, without reading the prunable notification row", async () => {
		const { db, kv, bot } = bootstrapFixture({ bootstrapNotifiedAt: "2026-04-01T00:00:00.000Z" });

		await ensureBootstrapNotification(kv, db, bot, now);

		expect(db.notifications).toEqual([]);
		expect(kv.puts).toEqual([]);
		expect(db.queries.some((query) => query.includes("FROM notifications"))).toBe(false);
		expect(db.bootstrapNotifiedAt).toBe("2026-04-01T00:00:00.000Z");
	});

	it("adopts a bootstrap row left by the previous deployment instead of duplicating it", async () => {
		const legacy = { id: "ntf_legacy", createdAt: "2026-04-01T00:00:00.000Z" };
		const { db, kv, bot } = bootstrapFixture({ legacyBootstrap: legacy });

		await ensureBootstrapNotification(kv, db, bot, now);
		await ensureBootstrapNotification(kv, db, bot, later);

		expect(db.notifications.map((notification) => notification.id)).toEqual([legacy.id]);
		expect(kv.puts).toEqual([]);
		// The flag carries the notification's own creation time, and the shim's
		// legacy lookup runs at most once per bot.
		expect(db.bootstrapNotifiedAt).toBe(legacy.createdAt);
		expect(db.queries.filter(isLegacyBootstrapLookup)).toHaveLength(1);
	});

	it("strips the legacy TTL from the adopted bootstrap document", async () => {
		const legacy = { id: "ntf_legacy", createdAt: "2026-04-01T00:00:00.000Z" };
		const { db, kv, bot } = bootstrapFixture({ legacyBootstrap: legacy });
		const key = kvKeys.notification(bot.id, legacy.id);
		// Written by the previous deployment, which still gave pending bootstrap
		// documents the 90-day retention TTL.
		await kv.put(key, JSON.stringify({
			id: legacy.id,
			type: "notification",
			schemaVersion,
			revision: 1,
			worldId: bot.homeWorldId,
			botId: bot.id,
			notificationType: "bootstrap",
			status: "pending",
			message: en("Welcome."),
			createdAt: legacy.createdAt,
			updatedAt: legacy.createdAt,
		}), { expirationTtl: notificationKvExpirationTtlSeconds });
		kv.puts.length = 0;
		kv.putOptions.length = 0;

		await ensureBootstrapNotification(kv, db, bot, now);

		// The adopted flag never expires, so the document it points at must not
		// either — otherwise the flag outlives the bootstrap it promises.
		expect(kv.puts).toEqual([key]);
		expect(kv.putOptions).toEqual([undefined]);
		expect(db.notifications.map((notification) => notification.id)).toEqual([legacy.id]);
		expect(db.bootstrapNotifiedAt).toBe(legacy.createdAt);
	});

	it("leaves an already-delivered legacy document on its TTL", async () => {
		const legacy = { id: "ntf_legacy", createdAt: "2026-04-01T00:00:00.000Z" };
		const { db, kv, bot } = bootstrapFixture({ legacyBootstrap: legacy });
		await kv.put(kvKeys.notification(bot.id, legacy.id), JSON.stringify({
			id: legacy.id,
			botId: bot.id,
			notificationType: "bootstrap",
			status: "delivered_to_loop",
			createdAt: legacy.createdAt,
		}), { expirationTtl: notificationKvExpirationTtlSeconds });
		kv.puts.length = 0;
		kv.putOptions.length = 0;

		await ensureBootstrapNotification(kv, db, bot, now);

		// Delivery is what bounds a bootstrap document; the exemption is over.
		expect(kv.puts).toEqual([]);
		expect(db.bootstrapNotifiedAt).toBe(legacy.createdAt);
	});

	it("bootstraps a bot with no bots_index row exactly once, without a flag to stamp", async () => {
		const { db, kv, bot } = bootstrapFixture({ missingBotsIndexRow: true });
		const notificationId = await bootstrapNotificationId(bot.id);
		const key = kvKeys.notification(bot.id, notificationId);

		await ensureBootstrapNotification(kv, db, bot, now);
		await ensureBootstrapNotification(kv, db, bot, later);

		// With no row to stamp, the deterministic id is the only thing bounding the
		// bootstrap: the second attempt adopts the row the first one wrote and
		// rewrites the same document instead of creating a second one.
		expect(db.notifications).toEqual([
			{ id: notificationId, botId: bot.id, type: "bootstrap", status: "pending", createdAt: now },
		]);
		expect(kv.puts).toEqual([key, key]);
		expect(kv.putOptions).toEqual([undefined, undefined]);
		expect(db.bootstrapNotifiedAt).toBeNull();
	});

	it("retries a crash between the KV document and the D1 batch without duplicating anything", async () => {
		const { db, kv, bot } = bootstrapFixture({ failBatchOnce: true });
		const notificationId = await bootstrapNotificationId(bot.id);
		const key = kvKeys.notification(bot.id, notificationId);

		await expect(ensureBootstrapNotification(kv, db, bot, now)).rejects.toThrow("D1 batch failed");

		// The document is already stored, but nothing points at it yet.
		expect(kv.puts).toEqual([key]);
		expect(db.notifications).toEqual([]);
		expect(db.bootstrapNotifiedAt).toBeNull();

		await ensureBootstrapNotification(kv, db, bot, later);

		// The retry rewrites the same deterministic key rather than orphaning it.
		expect(kv.puts).toEqual([key, key]);
		expect(db.notifications).toEqual([
			{ id: notificationId, botId: bot.id, type: "bootstrap", status: "pending", createdAt: later },
		]);
		expect(db.bootstrapNotifiedAt).toBe(later);
		const insert = db.runs.find((run) => run.query.includes("INTO notifications"));
		expect(insert?.query).toContain("INSERT OR IGNORE");
		expect(insert?.bindings[0]).toBe(notificationId);
	});

	it("keeps the flag unset when the batch fails, so the bootstrap is still owed", async () => {
		const { db, kv, bot } = bootstrapFixture({ failBatchOnce: true });

		await expect(ensureBootstrapNotification(kv, db, bot, now)).rejects.toThrow("D1 batch failed");

		expect(db.runs.some((run) => run.query.includes("UPDATE bots_index"))).toBe(false);
	});
});

describe("thread list read state", () => {
	it("uses grouped unread comment counts equivalent to the old per-thread computation", async () => {
		const seenThroughAt = "2026-05-06T12:00:00.000Z";
		const comments: ReadStateCommentFixture[] = [
			{ threadId: "thr_active", createdAt: "2026-05-06T12:00:01.000Z" },
			{ threadId: "thr_active", createdAt: "2026-05-06T12:00:02.000Z" },
			{ threadId: "thr_active", createdAt: "2026-05-06T11:59:59.000Z" },
			{ threadId: "thr_active", createdAt: "2026-05-06T12:00:03.000Z", deletedAt: "2026-05-06T12:00:04.000Z" },
			{ threadId: "thr_missing_count", createdAt: "2026-05-06T12:00:05.000Z", deletedAt: "2026-05-06T12:00:06.000Z" },
			{ threadId: "thr_new", createdAt: "2026-05-06T12:00:07.000Z" },
		];
		const db = new ReadStateFakeD1({
			seenThroughAt,
			threads: [
				readStateThread("thr_seen", "Already seen", "2026-05-06T11:00:00.000Z", "2026-05-06T11:30:00.000Z", 1),
				readStateThread("thr_active", "Active old thread", "2026-05-06T11:00:00.000Z", "2026-05-06T12:00:02.000Z", 4),
				readStateThread("thr_missing_count", "Only deleted unseen comments", "2026-05-06T11:00:00.000Z", "2026-05-06T12:00:05.000Z", 2),
				readStateThread("thr_new", "Brand new thread", "2026-05-06T12:00:07.000Z", "2026-05-06T12:00:07.000Z", 1),
			],
			comments,
		});
		const oldPerThreadCount = (threadId: string) =>
			comments.filter((comment) =>
				comment.threadId === threadId &&
				!comment.deletedAt &&
				comment.createdAt > seenThroughAt,
			).length;

		const threads = await listThreadsWithReadState(db, "frm_read", "usr_reader");
		const stateById = new Map(threads.map((thread) => [thread.id, thread.readState]));

		expect(stateById.get("thr_seen")).toMatchObject({ isNew: false, hasNewComments: false, newCommentCount: 0 });
		expect(stateById.get("thr_active")).toMatchObject({
			isNew: false,
			hasNewComments: true,
			newCommentCount: oldPerThreadCount("thr_active"),
		});
		expect(stateById.get("thr_missing_count")).toMatchObject({
			isNew: false,
			hasNewComments: true,
			newCommentCount: oldPerThreadCount("thr_missing_count"),
		});
		expect(stateById.get("thr_new")).toMatchObject({ isNew: true, hasNewComments: false, newCommentCount: 0 });
		expect(db.groupedCountQueries).toHaveLength(1);
		expect(db.singleCountQueries).toHaveLength(0);
	});
});

describe("content refs", () => {
	it("formats and parses short and legacy refs", () => {
		expect(formatThreadRef("abcdefgh")).toBe("t/abcdefgh");
		expect(formatCommentRef("ABCDEFGH")).toBe("c/abcdefgh");
		expect(parseThreadRef("T/ABCDEFGH")).toBe("abcdefgh");
		expect(parseCommentRef("C/ABCDEFGH")).toBe("abcdefgh");
		expect(parseThreadRef("thr_legacy")).toBe("thr_legacy");
		expect(parseCommentRef("cmt_legacy")).toBe("cmt_legacy");
		expect(parseThreadRef("THR_legacy")).toBeUndefined();
		expect(parseCommentRef("CMT_legacy")).toBeUndefined();
		expect(parseObjectRef("t/ABCDEFGH")).toEqual({ type: "thread", id: "abcdefgh" });
		expect(parseObjectRef("T/ABCDEFGH")).toEqual({ type: "thread", id: "abcdefgh" });
		expect(parseObjectRef("c/cmt_legacy")).toEqual({ type: "comment", id: "cmt_legacy" });
		expect(parseObjectRef("C/cmt_legacy")).toEqual({ type: "comment", id: "cmt_legacy" });
		expect(parseObjectRef("THR_legacy")).toBeUndefined();
		expect(parseThreadRef("c/abcdefgh")).toBeUndefined();
		expect(parseObjectRef("abcdefgh")).toBeUndefined();
	});
});

describe("markAllHumanNotificationsRead", () => {
	const before = "2026-05-06T11:59:00.000Z";
	const anchorAt = "2026-05-06T12:00:00.000Z";
	const after = "2026-05-06T12:00:01.000Z";
	const readAt = "2026-05-06T12:00:02.000Z";
	// The newest row the user had been shown when they clicked.
	const anchor = { notificationId: "hnt_anchor_world_one", createdAt: anchorAt };

	function sweepFixture(): FakeHumanNotificationD1 {
		return new FakeHumanNotificationD1([
			{ id: "hnt_old_world_one", worldId: "wld_one", actorBotId: "bot_a", createdAt: before },
			{ id: "hnt_old_world_two", worldId: "wld_two", actorBotId: "bot_b", createdAt: before },
			{ id: "hnt_anchor_world_one", worldId: "wld_one", actorBotId: "bot_a", createdAt: anchorAt },
			{ id: "hnt_new_world_one", worldId: "wld_one", actorBotId: "bot_a", createdAt: after },
			{ id: "hnt_new_world_two", worldId: "wld_two", actorBotId: "bot_b", createdAt: after },
		]);
	}

	it.each([
		["all", { scopeType: "all" } as const, ["hnt_anchor_world_one", "hnt_old_world_one", "hnt_old_world_two"]],
		["world", { scopeType: "world", scopeId: "wld_one" } as const, ["hnt_anchor_world_one", "hnt_old_world_one"]],
		["bot", { scopeType: "bot", scopeId: "bot_a" } as const, ["hnt_anchor_world_one", "hnt_old_world_one"]],
	])("marks up to the anchor and no further in the %s scope", async (_name, scope, expectedRead) => {
		const db = sweepFixture();

		await markAllHumanNotificationsRead(db, "usr_one", scope, readAt, anchor);

		expect(db.readIds()).toEqual(expectedRead);
		// Created after the anchor, so never rendered: still unread in every scope.
		expect(db.unreadIds()).toEqual(expect.arrayContaining(["hnt_new_world_one", "hnt_new_world_two"]));
	});

	it("bounds the anchor's own timestamp by notification id, the order the list is read in", async () => {
		const db = new FakeHumanNotificationD1([
			{ id: "hnt_a", createdAt: anchorAt },
			{ id: "hnt_b", createdAt: anchorAt },
			{ id: "hnt_c", createdAt: anchorAt },
		]);

		// A row sharing the anchor's second is above it when its id is, which is
		// where the list would have put it: below the fold, unrendered.
		await markAllHumanNotificationsRead(db, "usr_one", { scopeType: "all" }, readAt, {
			notificationId: "hnt_b",
			createdAt: anchorAt,
		});

		expect(db.readIds()).toEqual(["hnt_a", "hnt_b"]);
		expect(db.unreadIds()).toEqual(["hnt_c"]);
	});

	it("counts only changed rows and leaves an earlier read timestamp intact", async () => {
		const db = sweepFixture();
		db.rows.push({
			id: "hnt_already_read",
			userId: "usr_one",
			worldId: "wld_one",
			actorBotId: "bot_a",
			createdAt: before,
			readAt: before,
			archivedAt: null,
		});

		const readCount = await markAllHumanNotificationsRead(db, "usr_one", { scopeType: "all" }, readAt, anchor);

		expect(readCount).toBe(3);
		expect(db.row("hnt_old_world_one")?.readAt).toBe(readAt);
		// The read_at IS NULL guard keeps an earlier read timestamp intact.
		expect(db.row("hnt_already_read")?.readAt).toBe(before);
	});

	it("keeps one gesture's later scoped calls bounded by the gesture's anchor", async () => {
		const db = sweepFixture();

		await markAllHumanNotificationsRead(db, "usr_one", { scopeType: "world", scopeId: "wld_one" }, readAt, anchor);
		// A notification arriving between the two calls of the same gesture.
		db.rows.push({
			id: "hnt_mid_sweep",
			userId: "usr_one",
			worldId: "wld_two",
			actorBotId: "bot_b",
			createdAt: after,
			readAt: null,
			archivedAt: null,
		});
		await markAllHumanNotificationsRead(db, "usr_one", { scopeType: "world", scopeId: "wld_two" }, readAt, anchor);

		expect(db.unreadIds()).toEqual(["hnt_mid_sweep", "hnt_new_world_one", "hnt_new_world_two"]);
	});

	it("marks nothing when no anchor is supplied, because nothing was rendered", async () => {
		const db = sweepFixture();

		expect(await markAllHumanNotificationsRead(db, "usr_one", { scopeType: "all" }, readAt)).toBe(0);

		expect(db.readIds()).toEqual([]);
		expect(db.runs).toEqual([]);
	});

	it.each([
		["a notification of another user", { notificationId: "hnt_other_user", createdAt: before }],
		["a notification that does not exist", { notificationId: "hnt_missing", createdAt: before }],
	])("rejects an anchor naming %s", async (_name, rejected) => {
		const db = sweepFixture();
		db.rows.push({
			id: "hnt_other_user",
			userId: "usr_two",
			worldId: "wld_one",
			actorBotId: "bot_a",
			createdAt: before,
			readAt: null,
			archivedAt: null,
		});

		await expect(markAllHumanNotificationsRead(db, "usr_one", { scopeType: "all" }, readAt, rejected))
			.rejects.toThrow(InputError);
		expect(db.readIds()).toEqual([]);
	});

	it("bounds the sweep by the stored timestamp, not the one the client claimed", async () => {
		const db = sweepFixture();

		// A client claiming its anchor is newer than the row really is cannot reach
		// past the row: the cutoff is read back from storage.
		await markAllHumanNotificationsRead(db, "usr_one", { scopeType: "all" }, readAt, {
			notificationId: "hnt_anchor_world_one",
			createdAt: "2099-01-01T00:00:00.000Z",
		});

		expect(db.unreadIds()).toEqual(["hnt_new_world_one", "hnt_new_world_two"]);
	});

	it("does not bound the by-ids scope, which the caller already enumerated", async () => {
		const db = sweepFixture();

		const readCount = await markAllHumanNotificationsRead(
			db,
			"usr_one",
			{ scopeType: "notifications", notificationIds: ["hnt_new_world_one"] },
			readAt,
		);

		expect(readCount).toBe(1);
		expect(db.row("hnt_new_world_one")?.readAt).toBe(readAt);
		expect(db.runs.every((run) => !run.query.includes("created_at"))).toBe(true);
	});

	it("skips archived rows and other users' rows", async () => {
		const db = new FakeHumanNotificationD1([
			{ id: "hnt_archived", worldId: "wld_one", actorBotId: "bot_a", createdAt: before, archivedAt: before },
			{ id: "hnt_other_user", worldId: "wld_one", actorBotId: "bot_a", createdAt: before, userId: "usr_two" },
			{ id: "hnt_mine", worldId: "wld_one", actorBotId: "bot_a", createdAt: before },
			{ id: "hnt_anchor_world_one", worldId: "wld_one", actorBotId: "bot_a", createdAt: anchorAt },
		]);

		expect(await markAllHumanNotificationsRead(db, "usr_one", { scopeType: "all" }, readAt, anchor)).toBe(2);
		expect(db.unreadIds()).toEqual(["hnt_archived", "hnt_other_user"]);
	});
});

describe("parseHumanNotificationReadAnchor", () => {
	const anchor = { notificationId: "hnt_one", createdAt: now };

	it("reads an absent anchor as nothing rendered rather than an error", () => {
		expect(parseHumanNotificationReadAnchor(undefined)).toBeNull();
		expect(parseHumanNotificationReadAnchor(null)).toBeNull();
	});

	it("accepts the timestamp form notification rows are written in", () => {
		expect(parseHumanNotificationReadAnchor(anchor)).toEqual(anchor);
		expect(parseHumanNotificationReadAnchor({ notificationId: " hnt_one ", createdAt: ` ${now} ` })).toEqual(anchor);
		expect(parseHumanNotificationReadAnchor({ notificationId: "hnt_one", createdAt: "2026-05-06T12:00:00Z" }))
			.toEqual({ notificationId: "hnt_one", createdAt: "2026-05-06T12:00:00Z" });
	});

	it.each([
		["a date without a time", { notificationId: "hnt_one", createdAt: "2026-05-06" }],
		["a space-separated timestamp", { notificationId: "hnt_one", createdAt: "2026-05-06 12:00:00Z" }],
		["a local timestamp", { notificationId: "hnt_one", createdAt: "2026-05-06T12:00:00+02:00" }],
		["prose Date.parse accepts", { notificationId: "hnt_one", createdAt: "May 6 2026" }],
		["an epoch number", { notificationId: "hnt_one", createdAt: Date.parse(now) }],
		["a missing timestamp", { notificationId: "hnt_one" }],
		["a missing id", { createdAt: now }],
		["an empty id", { notificationId: " ", createdAt: now }],
		["a bare timestamp", now],
	])("rejects %s", (_name, value) => {
		expect(() => parseHumanNotificationReadAnchor(value)).toThrow(InputError);
	});
});

type HumanNotificationFixtureRow = {
	id: string;
	userId: string;
	worldId: string;
	actorBotId: string;
	createdAt: string;
	readAt: string | null;
	archivedAt: string | null;
};

/**
 * Models the human_notifications columns the mark-all update reads. The
 * predicates are taken from the statement text rather than assumed, so dropping
 * a guard from the query fails here instead of silently widening the sweep.
 */
class FakeHumanNotificationD1 implements D1DatabaseLike {
	readonly runs: Array<{ query: string; bindings: unknown[] }> = [];
	readonly rows: HumanNotificationFixtureRow[];

	constructor(rows: Array<Partial<HumanNotificationFixtureRow> & { id: string; createdAt: string }>) {
		this.rows = rows.map((row) => ({
			userId: "usr_one",
			worldId: "wld_one",
			actorBotId: "bot_a",
			readAt: null,
			archivedAt: null,
			...row,
		}));
	}

	prepare(query: string): D1PreparedStatementLike {
		return new FakeHumanNotificationStatement(this, query);
	}

	async batch(statements: D1PreparedStatementLike[]): Promise<Array<D1Result>> {
		const results: D1Result[] = [];
		for (const statement of statements) {
			results.push(await statement.run());
		}
		return results;
	}

	row(id: string): HumanNotificationFixtureRow | undefined {
		return this.rows.find((row) => row.id === id);
	}

	readIds(): string[] {
		return this.rows.filter((row) => row.readAt !== null).map((row) => row.id).sort();
	}

	unreadIds(): string[] {
		return this.rows.filter((row) => row.readAt === null).map((row) => row.id).sort();
	}

	/** The anchor lookup: scoped to the user, so another user's row is not found. */
	anchorRow(bindings: unknown[]): { createdAt: string } | null {
		const [userId, notificationId] = bindings;
		const row = this.rows.find((candidate) => candidate.userId === userId && candidate.id === notificationId);
		return row ? { createdAt: row.createdAt } : null;
	}

	markRead(query: string, bindings: unknown[]): number {
		if (!query.includes("archived_at IS NULL") || !query.includes("read_at IS NULL")) {
			throw new Error(`Mark-all update dropped a guard: ${query}`);
		}
		const [readAt, userId, ...rest] = bindings;
		const matches = (row: HumanNotificationFixtureRow): boolean =>
			row.userId === userId && row.archivedAt === null && row.readAt === null;
		let changed: HumanNotificationFixtureRow[];
		if (query.includes("notification_id IN (")) {
			const ids = new Set(rest.map(String));
			changed = this.rows.filter((row) => matches(row) && ids.has(row.id));
		} else {
			if (!query.includes("(created_at < ? OR (created_at = ? AND notification_id <= ?))")) {
				throw new Error(`Scoped mark-all update is unbounded: ${query}`);
			}
			const [anchorCreatedAt, tieCreatedAt, anchorId, ...scopeBindings] = rest;
			const scoped = query.includes("AND world_id = ?") ?
				(row: HumanNotificationFixtureRow) => row.worldId === scopeBindings[0]
			: query.includes("AND actor_bot_id = ?") ?
				(row: HumanNotificationFixtureRow) => row.actorBotId === scopeBindings[0]
			:	() => true;
			const atOrBelowAnchor = (row: HumanNotificationFixtureRow): boolean =>
				row.createdAt < String(anchorCreatedAt) ||
				(row.createdAt === String(tieCreatedAt) && row.id <= String(anchorId));
			changed = this.rows.filter((row) => matches(row) && atOrBelowAnchor(row) && scoped(row));
		}
		for (const row of changed) {
			row.readAt = String(readAt);
		}
		return changed.length;
	}
}

class FakeHumanNotificationStatement implements D1PreparedStatementLike {
	private bindings: unknown[] = [];
	private readonly db: FakeHumanNotificationD1;
	private readonly query: string;

	constructor(db: FakeHumanNotificationD1, query: string) {
		this.db = db;
		this.query = query;
	}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		if (!this.query.includes("SELECT created_at AS createdAt")) {
			throw new Error(`Unexpected query: ${this.query}`);
		}
		return this.db.anchorRow(this.bindings) as T | null;
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		return { success: true, results: [] };
	}

	async run(): Promise<D1Result> {
		this.db.runs.push({ query: this.query, bindings: this.bindings });
		if (!this.query.includes("UPDATE human_notifications")) {
			throw new Error(`Unexpected query: ${this.query}`);
		}
		return { success: true, meta: { changes: this.db.markRead(this.query, this.bindings) } };
	}
}

type ExistingThread = {
	id: string;
	forumId: string;
	title: string;
	worldHandle: string;
	forumHandle: string;
	createdAt: string;
	deletedAt?: string;
};

type IndexedBot = {
	id: string;
	handle: string;
	worldId?: string;
	deletedAt?: string;
	lifecycleState?: string;
};

type FixtureOptions = {
	existingThreads: ExistingThread[];
	reservedContentIds?: Set<string>;
	worldPostingSettings?: PostingSettings;
	botPostingSettings?: PostingSettings;
	followerBotIds?: string[];
	forumPersonalBotId?: string;
	worldThreadSettings?: ThreadSettings;
	forumThreadSettings?: ThreadSettings;
	forumReadOnly?: boolean;
	indexedBots?: IndexedBot[];
};

function fixture(options: FixtureOptions): { db: FakeD1; kv: FakeKV; bot: BotDocument } {
	const forum: ForumDocument = {
		id: "frm_main",
		type: "forum",
		schemaVersion,
		revision: 1,
		worldId: "wld_primary",
		worldHandle: "primary",
		handle: "general",
		language: "en" as LanguageTag,
		description: en("General discussion"),
		createdByUserId: "usr_owner",
		readOnly: options.forumReadOnly ?? false,
		...(options.forumPersonalBotId ? { personalBotId: options.forumPersonalBotId } : {}),
		...(options.forumThreadSettings ? { threadSettings: options.forumThreadSettings } : {}),
		createdAt: now,
		updatedAt: now,
	};
	const world: WorldDocument = {
		id: "wld_primary",
		type: "world",
		schemaVersion,
		revision: 1,
		handle: "primary",
		language: "en" as LanguageTag,
		name: en("Primary"),
		description: en("Primary world"),
		prompt: en(""),
		recurringPromptEnabled: false,
		recurringPrompt: en(""),
		initialBotNotification: en("Welcome."),
		...(options.worldPostingSettings ? { postingSettings: options.worldPostingSettings } : {}),
		...(options.worldThreadSettings ? { threadSettings: options.worldThreadSettings } : {}),
		createdByUserId: "usr_owner",
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	};
	const bot: BotDocument = {
		id: "bot_author",
		type: "bot",
		schemaVersion,
		revision: 1,
		homeWorldId: "wld_primary",
		homeWorldHandle: "primary",
		ownerUserId: "usr_owner",
		handle: "alice",
		language: "en" as LanguageTag,
		includeLanguageInSystemPrompt: false,
		displayName: en("Alice"),
		shortBio: en("Test participant"),
		prompt: en("Post clearly."),
		inferenceSettings: {},
		toolSettings: {},
		...(options.botPostingSettings ? { postingSettings: options.botPostingSettings } : {}),
		tickSettings: {
			enabled: false,
			intervalSeconds: 86_400,
			contextWindowTokens: 16_000,
			compactionThreshold: 0.75,
			maxToolCallsPerTick: 8,
			maxSuccessfulToolCallsPerIteration: 8,
		},
		createdAt: now,
		updatedAt: now,
	};
	const kv = new FakeKV(new Map<string, unknown>([
		[kvKeys.world(world.id), world],
		[kvKeys.forum(forum.id), forum],
		[kvKeys.bot(bot.id), bot],
	]));
	return {
		db: new FakeD1(
			options.existingThreads,
			options.reservedContentIds,
			options.followerBotIds,
			options.forumReadOnly ?? false,
			[{ id: bot.id, handle: bot.handle }, ...(options.indexedBots ?? [])],
		),
		kv,
		bot,
	};
}

type BootstrapFixtureOptions = {
	bootstrapNotifiedAt?: string;
	legacyBootstrap?: { id: string; createdAt: string };
	failBatchOnce?: boolean;
	/** Models a bot whose bots_index projection is gone: no row to read or stamp. */
	missingBotsIndexRow?: boolean;
};

function bootstrapFixture(options: BootstrapFixtureOptions = {}): { db: FakeBootstrapD1; kv: FakeKV; bot: BotDocument } {
	const { kv, bot } = fixture({ existingThreads: [] });
	kv.puts.length = 0;
	kv.putOptions.length = 0;
	return { db: new FakeBootstrapD1(bot.id, options), kv, bot };
}

/** The deploy-window shim's one legacy read, which must not repeat per bot. */
function isLegacyBootstrapLookup(query: string): boolean {
	return query.includes("FROM notifications") && query.includes("type = 'bootstrap'");
}

type BootstrapNotificationRow = {
	id: string;
	botId: string;
	type: string;
	status: string;
	createdAt: string;
};

/**
 * Models the only two pieces of state the bootstrap path reads and writes: the
 * notifications rows keyed by their own id, and bots_index.bootstrap_notified_at.
 * The batch can be failed once to reproduce a crash between the KV document and
 * the D1 writes.
 */
class FakeBootstrapD1 implements D1DatabaseLike {
	readonly queries: string[] = [];
	readonly runs: Array<{ query: string; bindings: unknown[] }> = [];
	readonly notifications: BootstrapNotificationRow[] = [];
	bootstrapNotifiedAt: string | null;
	private readonly botId: string;
	private readonly hasBotsIndexRow: boolean;
	private failNextBatch: boolean;

	constructor(botId: string, options: BootstrapFixtureOptions) {
		this.botId = botId;
		this.bootstrapNotifiedAt = options.bootstrapNotifiedAt ?? null;
		this.hasBotsIndexRow = !options.missingBotsIndexRow;
		this.failNextBatch = options.failBatchOnce ?? false;
		if (options.legacyBootstrap) {
			this.notifications.push({
				id: options.legacyBootstrap.id,
				botId,
				type: "bootstrap",
				status: "pending",
				createdAt: options.legacyBootstrap.createdAt,
			});
		}
	}

	prepare(query: string): D1PreparedStatementLike {
		this.queries.push(query);
		return new FakeBootstrapStatement(this, query);
	}

	async batch(statements: D1PreparedStatementLike[]): Promise<Array<D1Result>> {
		if (this.failNextBatch) {
			this.failNextBatch = false;
			throw new Error("D1 batch failed");
		}
		const results: D1Result[] = [];
		for (const statement of statements) {
			results.push(await statement.run());
		}
		return results;
	}

	first<T>(query: string, bindings: unknown[]): T | null {
		if (query.includes("FROM bots_index") && query.includes("bootstrap_notified_at")) {
			if (!this.hasBotsIndexRow || bindings[0] !== this.botId) {
				return null;
			}
			return { bootstrapNotifiedAt: this.bootstrapNotifiedAt } as T;
		}
		if (query.includes("FROM notifications") && query.includes("type = 'bootstrap'")) {
			// ORDER BY created_at ASC, notification_id ASC LIMIT 1.
			const [earliest] = this.notifications
				.filter((row) => row.botId === bindings[0] && row.type === "bootstrap")
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
			return (earliest ? { id: earliest.id, createdAt: earliest.createdAt } : null) as T | null;
		}
		return null;
	}

	run(query: string, bindings: unknown[]): void {
		this.runs.push({ query, bindings });
		if (query.includes("UPDATE bots_index") && query.includes("bootstrap_notified_at")) {
			// WHERE bot_id = ? AND bootstrap_notified_at IS NULL: an absent row or an
			// already-stamped flag matches nothing, so the stamp happens exactly once.
			if (this.hasBotsIndexRow && bindings[1] === this.botId && this.bootstrapNotifiedAt === null) {
				this.bootstrapNotifiedAt = String(bindings[0]);
			}
			return;
		}
		if (query.includes("INSERT OR IGNORE INTO notifications")) {
			const [id, , botId, type, , status, , , createdAt] = bindings;
			if (this.notifications.some((row) => row.id === id)) {
				return;
			}
			this.notifications.push({
				id: String(id),
				botId: String(botId),
				type: String(type),
				status: String(status),
				createdAt: String(createdAt),
			});
		}
	}
}

class FakeBootstrapStatement implements D1PreparedStatementLike {
	private bindings: unknown[] = [];
	private readonly db: FakeBootstrapD1;
	private readonly query: string;

	constructor(db: FakeBootstrapD1, query: string) {
		this.db = db;
		this.query = query;
	}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return this.db.first<T>(this.query, this.bindings);
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		return { success: true, results: [] };
	}

	async run(): Promise<D1Result> {
		this.db.run(this.query, this.bindings);
		return { success: true, meta: { changes: 1 } };
	}
}

function mockRandomBytes(sequences: number[][]): () => void {
	const pending = [...sequences];
	const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
		const next = pending.shift() ?? [0, 0, 0, 0, 2];
		array.set(next);
		return array;
	}) as Crypto["getRandomValues"]);
	return () => spy.mockRestore();
}

class FakeKV implements KVNamespaceLike {
	readonly puts: string[] = [];
	readonly putOptions: Array<{ expirationTtl?: number } | undefined> = [];
	readonly deletes: string[] = [];
	/** Shared with the D1 fake when a test cares about the order across both stores. */
	operationLog?: string[];
	private readonly data: Map<string, unknown>;

	constructor(data: Map<string, unknown>) {
		this.data = data;
	}

	async get(key: string, options?: { type: "json" }): Promise<unknown> {
		const value = this.data.get(key) ?? null;
		if (options?.type === "json" && typeof value === "string") {
			return JSON.parse(value);
		}
		return value;
	}

	async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
		this.puts.push(key);
		this.putOptions.push(options);
		this.data.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.deletes.push(key);
		this.operationLog?.push(`kv:delete:${key}`);
		this.data.delete(key);
	}
}

class FakeD1 implements D1DatabaseLike {
	readonly runs: Array<{ query: string; bindings: unknown[] }> = [];
	/** Shared with the KV fake when a test cares about the order across both stores. */
	operationLog?: string[];
	readonly mentionLookups: unknown[][] = [];
	readonly contentIds: Set<string>;
	private readonly existingThreads: ExistingThread[];
	private readonly followerBotIds: string[];
	private readonly forumReadOnly: boolean;
	private readonly indexedBots: IndexedBot[];

	constructor(
		existingThreads: ExistingThread[],
		reservedContentIds = new Set<string>(),
		followerBotIds: string[] = [],
		forumReadOnly = false,
		indexedBots: IndexedBot[] = [],
	) {
		this.existingThreads = existingThreads;
		this.contentIds = new Set(reservedContentIds);
		this.followerBotIds = followerBotIds;
		this.forumReadOnly = forumReadOnly;
		this.indexedBots = indexedBots;
	}

	prepare(query: string): D1PreparedStatementLike {
		return new FakeStatement(this, query);
	}

	async batch(statements: D1PreparedStatementLike[]): Promise<Array<D1Result>> {
		const results: D1Result[] = [];
		for (const statement of statements) {
			results.push(await statement.run());
		}
		return results;
	}

	first<T>(query: string, bindings: unknown[]): T | null {
		if (query.includes("FROM forums_index f") && query.includes("WHERE f.forum_id = ?")) {
			return {
				worldId: "wld_primary",
				forumDeletedAt: null,
				worldDeletedAt: null,
			} as T;
		}
		if (query.includes("read_only AS readOnly") && query.includes("FROM forums_index")) {
			return { readOnly: this.forumReadOnly ? 1 : 0 } as T;
		}
		if (query.includes("FROM bots_index") && query.includes("WHERE bot_id = ?")) {
			return { deletedAt: null } as T;
		}
		if (query.includes("FROM threads_index") && query.includes("title = ?")) {
			const [forumId, title] = bindings;
			const match = this.existingThreads
				.filter((thread) => thread.forumId === forumId && thread.title === title && !thread.deletedAt)
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
			return match ? {
				id: match.id,
				title: match.title,
				titleLang: enLang,
				worldHandle: match.worldHandle,
				forumHandle: match.forumHandle,
			} as T : null;
		}
		return null;
	}

	all<T>(query: string, bindings: unknown[]): D1Result<T> {
		if (query.includes("FROM follows") && query.includes("WHERE followed_bot_id = ?")) {
			return {
				success: true,
				results: this.followerBotIds.map((botId) => ({ botId }) as T),
			};
		}
		if (query.includes("FROM bots_index") && query.includes("handle IN (")) {
			this.mentionLookups.push(bindings);
			const [worldId, ...handles] = bindings.map(String);
			const rows = this.indexedBots.filter((indexed) =>
				(indexed.worldId ?? "wld_primary") === worldId &&
				indexed.deletedAt === undefined &&
				(indexed.lifecycleState ?? "active") === "active" &&
				handles.includes(indexed.handle),
			);
			return { success: true, results: rows.map((row) => ({ botId: row.id, handle: row.handle }) as T) };
		}
		return { success: true, results: [] };
	}
}

class FakeStatement implements D1PreparedStatementLike {
	private bindings: unknown[] = [];
	private readonly db: FakeD1;
	private readonly query: string;

	constructor(
		db: FakeD1,
		query: string,
	) {
		this.db = db;
		this.query = query;
	}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return this.db.first<T>(this.query, this.bindings);
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		return this.db.all<T>(this.query, this.bindings);
	}

	async run(): Promise<D1Result> {
		this.db.runs.push({ query: this.query, bindings: this.bindings });
		this.db.operationLog?.push(`d1:${this.query.trim().split("\n")[0]?.trim() ?? ""}`);
		if (this.query.includes("INSERT OR IGNORE INTO content_ids")) {
			const id = String(this.bindings[0]);
			if (this.db.contentIds.has(id)) {
				return { success: true, meta: { changes: 0 } };
			}
			this.db.contentIds.add(id);
			return { success: true, meta: { changes: 1 } };
		}
		return { success: true, meta: { changes: 1 } };
	}
}

type SeenContentRetentionFixtureRow = {
	id: string;
	lastSeenAt: string;
};

class FakeSeenContentRetentionD1 implements D1DatabaseLike {
	readonly runs: Array<{ query: string; bindings: unknown[] }> = [];
	rows: SeenContentRetentionFixtureRow[];

	constructor(rows: SeenContentRetentionFixtureRow[]) {
		this.rows = [...rows];
	}

	prepare(query: string): D1PreparedStatementLike {
		return new FakeSeenContentRetentionStatement(this, query);
	}

	async batch(statements: D1PreparedStatementLike[]): Promise<Array<D1Result>> {
		const results: D1Result[] = [];
		for (const statement of statements) {
			results.push(await statement.run());
		}
		return results;
	}

	deleteBefore(cutoff: string, limit: number): number {
		const deletedIds = new Set(
			this.rows
				.filter((row) => row.lastSeenAt < cutoff)
				.slice(0, limit)
				.map((row) => row.id),
		);
		this.rows = this.rows.filter((row) => !deletedIds.has(row.id));
		return deletedIds.size;
	}
}

class FakeSeenContentRetentionStatement implements D1PreparedStatementLike {
	private bindings: unknown[] = [];
	private readonly db: FakeSeenContentRetentionD1;
	private readonly query: string;

	constructor(
		db: FakeSeenContentRetentionD1,
		query: string,
	) {
		this.db = db;
		this.query = query;
	}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return null;
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		return { success: true, results: [] };
	}

	async run(): Promise<D1Result> {
		this.db.runs.push({ query: this.query, bindings: this.bindings });
		if (!this.query.includes("DELETE FROM bot_seen_content")) {
			throw new Error(`Unexpected query: ${this.query}`);
		}
		const [cutoff, limit] = this.bindings;
		if (typeof cutoff !== "string" || typeof limit !== "number") {
			throw new Error("Expected bot seen-content prune cutoff and limit bindings.");
		}
		return { success: true, meta: { changes: this.db.deleteBefore(cutoff, limit) } };
	}
}

type ReadStateThreadFixture = Omit<
	ThreadSummary,
	"authorAvatarCrop" | "authorAvatarUrl" | "authorDisplayName" | "bodyPreview" | "readState" | "title"
> & {
	authorAvatarCrop: string | null;
	authorAvatarUrl: string | null;
	authorDisplayName: string;
	authorDisplayNameLang: string | null;
	bodyPreview: string;
	bodyPreviewLang: string | null;
	title: string;
	titleLang: string | null;
};

type ReadStateCommentFixture = {
	threadId: string;
	createdAt: string;
	deletedAt?: string;
};

function readStateThread(
	id: string,
	title: string,
	createdAt: string,
	lastActivityAt: string,
	commentCount: number,
): ReadStateThreadFixture {
	return {
		id,
		rootCommentId: id,
		worldId: "wld_read",
		worldHandle: "read-world",
		forumId: "frm_read",
		forumHandle: "read-forum",
		authorBotId: "bot_author",
		authorHandle: "alice",
		authorDisplayName: "Alice",
		authorDisplayNameLang: enLang,
		authorAvatarUrl: null,
		authorAvatarCrop: null,
		title,
		titleLang: enLang,
		bodyPreview: `${title} body`,
		bodyPreviewLang: enLang,
		voteScore: 0,
		commentCount,
		createdAt,
		lastActivityAt,
	};
}

class ReadStateFakeD1 implements D1DatabaseLike {
	readonly groupedCountQueries: unknown[][] = [];
	readonly singleCountQueries: unknown[][] = [];
	private readonly seenThroughAt: string | null;
	private readonly threads: ReadStateThreadFixture[];
	private readonly comments: ReadStateCommentFixture[];

	constructor(input: {
		seenThroughAt: string | null;
		threads: ReadStateThreadFixture[];
		comments: ReadStateCommentFixture[];
	}) {
		this.seenThroughAt = input.seenThroughAt;
		this.threads = input.threads;
		this.comments = input.comments;
	}

	prepare(query: string): D1PreparedStatementLike {
		return new ReadStateStatement(this, query);
	}

	async batch(statements: D1PreparedStatementLike[]): Promise<Array<D1Result>> {
		const results: D1Result[] = [];
		for (const statement of statements) {
			results.push(await statement.run());
		}
		return results;
	}

	first<T>(query: string, bindings: unknown[]): T | null {
		if (query.includes("FROM user_forum_reads")) {
			return this.seenThroughAt ? { seenThroughAt: this.seenThroughAt } as T : null;
		}
		if (query.includes("FROM comments_index") && query.includes("COUNT(*) AS count") && !query.includes("GROUP BY thread_id")) {
			this.singleCountQueries.push(bindings);
			const [threadId, seenThroughAt] = bindings;
			return { count: this.commentCount(String(threadId), String(seenThroughAt)) } as T;
		}
		return null;
	}

	all<T>(query: string, bindings: unknown[]): D1Result<T> {
		if (query.includes("FROM threads_index")) {
			const limit = Number(bindings.at(-2) ?? this.threads.length);
			const offset = Number(bindings.at(-1) ?? 0);
			return { success: true, results: this.threads.slice(offset, offset + limit) as T[] };
		}
		if (query.includes("FROM comments_index") && query.includes("GROUP BY thread_id")) {
			this.groupedCountQueries.push(bindings);
			const seenThroughAt = String(bindings.at(-1));
			const threadIds = bindings.slice(0, -1).map(String);
			const rows = threadIds
				.map((threadId) => ({ threadId, count: this.commentCount(threadId, seenThroughAt) }))
				.filter((row) => row.count > 0);
			return { success: true, results: rows as T[] };
		}
		return { success: true, results: [] };
	}

	private commentCount(threadId: string, seenThroughAt: string): number {
		return this.comments.filter((comment) =>
			comment.threadId === threadId &&
			!comment.deletedAt &&
			comment.createdAt > seenThroughAt,
		).length;
	}
}

class ReadStateStatement implements D1PreparedStatementLike {
	private bindings: unknown[] = [];
	private readonly db: ReadStateFakeD1;
	private readonly query: string;

	constructor(
		db: ReadStateFakeD1,
		query: string,
	) {
		this.db = db;
		this.query = query;
	}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return this.db.first<T>(this.query, this.bindings);
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		return this.db.all<T>(this.query, this.bindings);
	}

	async run(): Promise<D1Result> {
		return { success: true, meta: { changes: 1 } };
	}
}
