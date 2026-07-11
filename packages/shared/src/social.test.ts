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
	createComment,
	createThread,
	ensureBootstrapNotification,
	listThreadsWithReadState,
	markNotificationsDelivered,
	notificationKvExpirationTtlSeconds,
	pruneExpiredBotSeenContent,
	threadHotScore,
} from "./social";
import { kvKeys, type D1DatabaseLike, type D1PreparedStatementLike, type D1Result, type KVNamespaceLike } from "./storage";
import { schemaVersion, type BotDocument, type ForumDocument, type LanguageTag, type NotificationDocument, type PostingSettings, type RequiredLocalizedText, type ThreadSummary, type WorldDocument } from "./model";

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
		}, now)).resolves.toMatchObject({ id: thread.id });
		await expect(createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: en("x".repeat(81)),
		}, now)).rejects.toMatchObject({
			name: "InputError",
			message: "Comment body must be 80 characters or fewer.",
		});
	});

	it("creates short thread and comment IDs with the root comment sharing the thread ID", async () => {
		const { db, kv } = fixture({ existingThreads: [] });
		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: en("Short refs"),
			body: en("Root body"),
		}, now);
		const updated = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: en("Reply body"),
		}, now, { thread });
		const reply = updated.comments.find((comment) => comment.body.text === "Reply body");

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

describe("bot notification retention", () => {
	it("writes notification documents with the maximum retention TTL", async () => {
		const { db, kv, bot } = fixture({ existingThreads: [] });

		await ensureBootstrapNotification(kv, db, bot, now);

		const notificationPutIndex = kv.puts.findIndex((key) => key.startsWith(`v1:notification:${bot.id}:`));
		expect(notificationPutIndex).toBeGreaterThanOrEqual(0);
		expect(kv.putOptions[notificationPutIndex]).toEqual({
			expirationTtl: notificationKvExpirationTtlSeconds,
		});
	});

	it("re-arms the retention TTL when marking notifications delivered", async () => {
		const { db, kv, bot } = fixture({ existingThreads: [] });
		const notification: NotificationDocument = {
			id: "ntf_delivery-ttl",
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

		await markNotificationsDelivered(kv, db, [notification], now);

		const deliveryPutIndex = kv.puts.findIndex((key) => key === `v1:notification:${bot.id}:${notification.id}`);
		expect(deliveryPutIndex).toBeGreaterThanOrEqual(0);
		// KV put replaces the entry including its expiration; without re-arming
		// the TTL here, delivered documents would outlive their D1 rows forever.
		expect(kv.putOptions[deliveryPutIndex]).toEqual({
			expirationTtl: notificationKvExpirationTtlSeconds,
		});
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

type ExistingThread = {
	id: string;
	forumId: string;
	title: string;
	worldHandle: string;
	forumHandle: string;
	createdAt: string;
	deletedAt?: string;
};

type FixtureOptions = {
	existingThreads: ExistingThread[];
	reservedContentIds?: Set<string>;
	worldPostingSettings?: PostingSettings;
	botPostingSettings?: PostingSettings;
	followerBotIds?: string[];
	forumPersonalBotId?: string;
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
		...(options.forumPersonalBotId ? { personalBotId: options.forumPersonalBotId } : {}),
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
		initialBotNotification: en("Welcome."),
		...(options.worldPostingSettings ? { postingSettings: options.worldPostingSettings } : {}),
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
	return { db: new FakeD1(options.existingThreads, options.reservedContentIds, options.followerBotIds), kv, bot };
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
		this.data.delete(key);
	}
}

class FakeD1 implements D1DatabaseLike {
	readonly runs: Array<{ query: string; bindings: unknown[] }> = [];
	readonly contentIds: Set<string>;
	private readonly existingThreads: ExistingThread[];
	private readonly followerBotIds: string[];

	constructor(existingThreads: ExistingThread[], reservedContentIds = new Set<string>(), followerBotIds: string[] = []) {
		this.existingThreads = existingThreads;
		this.contentIds = new Set(reservedContentIds);
		this.followerBotIds = followerBotIds;
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
		if (query.includes("FROM forums_index") && query.includes("WHERE forum_id = ?")) {
			return { deletedAt: null } as T;
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

	all<T>(query: string, _bindings: unknown[]): D1Result<T> {
		if (query.includes("FROM follows") && query.includes("WHERE followed_bot_id = ?")) {
			return {
				success: true,
				results: this.followerBotIds.map((botId) => ({ botId }) as T),
			};
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
