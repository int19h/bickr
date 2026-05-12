import { describe, expect, it, vi } from "vitest";
import {
	formatCommentRef,
	formatThreadRef,
	isShortContentId,
	parseCommentRef,
	parseObjectRef,
	parseThreadRef,
} from "./ids";
import { createComment, createThread, threadHotScore } from "./social";
import { kvKeys, type D1DatabaseLike, type D1PreparedStatementLike, type D1Result, type KVNamespaceLike } from "./storage";
import { schemaVersion, type BotDocument, type ForumDocument, type PostingSettings, type WorldDocument } from "./model";

const now = "2026-05-06T12:00:00.000Z";

describe("threadHotScore", () => {
	it("linearly decays engagement over the seven-day hot window", () => {
		expect(threadHotScore(2, 4, now, now)).toBeCloseTo(10);
		expect(threadHotScore(2, 4, now, "2026-05-10T00:00:00.000Z")).toBeCloseTo(5);
		expect(threadHotScore(2, 4, now, "2026-05-13T12:00:00.000Z")).toBe(0);
		expect(threadHotScore(2, 4, now, "2026-05-14T12:00:00.000Z")).toBe(0);
	});

	it("clamps negative engagement and future creation timestamps", () => {
		expect(threadHotScore(-10, 1, now, now)).toBe(0);
		expect(threadHotScore(1, 1, "2026-05-07T12:00:00.000Z", now)).toBeCloseTo(3.5);
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
			title: "Same title",
			body: "Fresh body",
		}, now)).rejects.toMatchObject({
			code: "conflict",
			status: 409,
			details: {
				existingThread: {
					id: "thr_existing",
					title: "Same title",
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
			title: "Reusable title",
			body: "Fresh body",
		}, now)).resolves.toMatchObject({
			forumId: "frm_main",
			title: "Reusable title",
		});
		expect(kv.puts.some((key) => /^v1:thread:[a-z2-7]{8}$/.test(key))).toBe(true);
	});

	it("preserves exact body text while rejecting all-whitespace bodies", async () => {
		const { db, kv } = fixture({ existingThreads: [] });
		const body = "  Leading and trailing text.  \n";

		const thread = await createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: "Preserve body",
			body,
		}, now);

		expect(thread.comments[0]?.body).toBe(body);
		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: "Blank body",
			body: " \n\t ",
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
			title: "At hard limit",
			body: "x".repeat(160),
		}, now)).resolves.toMatchObject({ title: "At hard limit" });
		await expect(createThread(kv, db, {
			forumId: "frm_main",
			authorBotId: "bot_author",
			title: "Over hard limit",
			body: "x".repeat(161),
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
			title: "Comment target",
			body: "Root body",
		}, now);

		await expect(createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: "x".repeat(80),
		}, now)).resolves.toMatchObject({ id: thread.id });
		await expect(createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: "x".repeat(81),
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
			title: "Short refs",
			body: "Root body",
		}, now);
		const updated = await createComment(kv, db, {
			threadId: thread.id,
			authorBotId: "bot_author",
			body: "Reply body",
		}, now, { thread });
		const reply = updated.comments.find((comment) => comment.body === "Reply body");

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
				title: "Collision retry",
				body: "Root body",
			}, now);

			expect(thread.id).toBe("aaaaaaab");
			expect(db.contentIds.has("aaaaaaaa")).toBe(true);
			expect(db.contentIds.has("aaaaaaab")).toBe(true);
		} finally {
			restore();
		}
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
		expect(parseObjectRef("t/ABCDEFGH")).toEqual({ type: "thread", id: "abcdefgh" });
		expect(parseObjectRef("c/cmt_legacy")).toEqual({ type: "comment", id: "cmt_legacy" });
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
};

function fixture(options: FixtureOptions): { db: FakeD1; kv: FakeKV } {
	const forum: ForumDocument = {
		id: "frm_main",
		type: "forum",
		schemaVersion,
		revision: 1,
		worldId: "wld_primary",
		worldHandle: "primary",
		handle: "general",
		description: "General discussion",
		createdByUserId: "usr_owner",
		createdAt: now,
		updatedAt: now,
	};
	const world: WorldDocument = {
		id: "wld_primary",
		type: "world",
		schemaVersion,
		revision: 1,
		handle: "primary",
		name: "Primary",
		description: "Primary world",
		initialBotNotification: "Welcome.",
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
		displayName: "Alice",
		shortBio: "Test participant",
		prompt: "Post clearly.",
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
	return { db: new FakeD1(options.existingThreads, options.reservedContentIds), kv };
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

	async put(key: string, value: string): Promise<void> {
		this.puts.push(key);
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

	constructor(existingThreads: ExistingThread[], reservedContentIds = new Set<string>()) {
		this.existingThreads = existingThreads;
		this.contentIds = new Set(reservedContentIds);
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
				worldHandle: match.worldHandle,
				forumHandle: match.forumHandle,
			} as T : null;
		}
		return null;
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
		return { success: true, results: [] };
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
