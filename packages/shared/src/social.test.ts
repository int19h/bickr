import { describe, expect, it } from "vitest";
import { createThread } from "./social";
import { kvKeys, type D1DatabaseLike, type D1PreparedStatementLike, type D1Result, type KVNamespaceLike } from "./storage";
import { schemaVersion, type BotDocument, type ForumDocument } from "./model";

const now = "2026-05-06T12:00:00.000Z";

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
		expect(kv.puts.some((key) => key.startsWith("v1:thread:thr_"))).toBe(true);
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
		[kvKeys.forum(forum.id), forum],
		[kvKeys.bot(bot.id), bot],
	]));
	return { db: new FakeD1(options.existingThreads), kv };
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
	private readonly existingThreads: ExistingThread[];

	constructor(existingThreads: ExistingThread[]) {
		this.existingThreads = existingThreads;
	}

	prepare(query: string): D1PreparedStatementLike {
		return new FakeStatement(this, query);
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
		return { success: true, meta: { changes: 1 } };
	}
}
