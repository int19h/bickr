/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshThreadHotScores, searchForumThreads } from "./social";
import { substringSearchQuery, shortSubstringTokens, rebuildForumSearchIndexes, forumSearchPending } from "./indexed-substring-search";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./storage";

const migrationDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const databases: DatabaseSync[] = [];
const now = "2026-10-02T00:00:00.000Z";

async function database(count = 0, skipBackfill = false) {
	let migrated = false;
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	for (const file of readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql") && file < "0061").sort()) {
		sqlite.exec(readFileSync(`${migrationDirectory}/${file}`, "utf8"));
	}
	const insert = sqlite.prepare(`INSERT INTO threads_index(thread_id, root_comment_id, world_id, world_handle,
		forum_id, forum_handle, author_bot_id, author_handle, author_display_name, title, body_preview,
		search_text, created_at, last_activity_at) VALUES(?, ?, 'world', 'world', 'forum', 'forum', 'bot', 'bot', 'Bot', ?, ?, ?, ?, ?)`);
	const thread = (id: string, text = "ancient body", forum = "forum") => {
		insert.run(id, `${id}-root`, text, text, text.toLowerCase(), "2020-01-01T00:00:00.000Z", `2020-01-01T00:00:${id.endsWith("2") ? "02" : "01"}.000Z`);
		if (migrated) sqlite.prepare("UPDATE threads_index SET search_short_tokens = ? WHERE thread_id = ?").run(shortSubstringTokens(text.toLowerCase()), id);
		if (forum !== "forum") sqlite.prepare("UPDATE threads_index SET forum_id = ? WHERE thread_id = ?").run(forum, id);
	};
	sqlite.exec("BEGIN");
	for (let i = 0; i < count; i++) thread(`historical-${String(i).padStart(6, "0")}`);
	sqlite.exec("COMMIT");
	sqlite.exec(readFileSync(`${migrationDirectory}/0061_thread_search_and_hot_refresh.sql`, "utf8"));
	migrated = true;
	let textRows = 0;
	let threadWrites = 0;
	const plans: string[] = [];
	// Instrument the exact residual predicate and source-table writes, rather
	// than measuring elapsed time (which depends on the machine running CI).
	sqlite.function("lower", (value) => {
		textRows++;
		return String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	});
	sqlite.function("audit_thread_write", () => { threadWrites++; return 0; });
	sqlite.exec("CREATE TRIGGER audit_thread_writes AFTER UPDATE ON threads_index BEGIN SELECT audit_thread_write(); END;");
	const statements = new WeakMap<D1PreparedStatementLike, { sql: string; values: unknown[] }>();
	const db: D1DatabaseLike = {
		prepare(sql) {
			const state = { sql, values: [] as unknown[] };
			const execute = () => {
				plans.push(...sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...state.values as []).map((row) => String(row.detail)));
				return sqlite.prepare(sql);
			};
			const statement: D1PreparedStatementLike = {
				bind(...values) { state.values = values; return statement; },
				async first<T>() { return execute().get(...state.values as []) as T ?? null; },
				async all<T>() { return { success: true, results: execute().all(...state.values as []) as T[] }; },
				async run() { return { success: true, meta: { changes: Number(execute().run(...state.values as []).changes) } }; },
			};
			statements.set(statement, state);
			return statement;
		},
		async batch(batch) {
			sqlite.exec("BEGIN");
			try {
				const results = batch.map((statement) => {
					const state = statements.get(statement)!;
					return { success: true, meta: { changes: Number(sqlite.prepare(state.sql).run(...state.values as []).changes) } };
				});
				sqlite.exec("COMMIT");
				return results;
			} catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		},
	};
	const comment = (id: string, threadId: string, text: string, createdAt = "2026-10-01T00:00:00.000Z") => {
		sqlite.prepare(`INSERT INTO comments_index(comment_id, thread_id, world_id, forum_id, author_bot_id,
			author_handle, body_preview, search_text, search_short_tokens, created_at, is_root) VALUES(?, ?, 'world', 'forum', 'bot', 'bot', ?, ?, ?, ?, 0)`)
			.run(id, threadId, text, text.toLowerCase(), shortSubstringTokens(text.toLowerCase()), createdAt);
	};
	if (!skipBackfill) while ((await rebuildForumSearchIndexes(db)).remaining) { /* bounded sweep */ }
	textRows = 0; threadWrites = 0;
	return { sqlite, db, thread, comment, plans, resetCounters() { textRows = 0; threadWrites = 0; }, counts: () => ({ textRows, threadWrites }) };
}

afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("indexed forum substrings", () => {
	it.each([100, 1_000, 10_000])("does not inspect %i historical text rows for absent long or short terms", async (size) => {
		const fixture = await database(size);
		for (const query of ["unmatched-token", "zz", "😀"]) {
			fixture.resetCounters();
			expect(await searchForumThreads(fixture.db, "forum", query, 20, now)).toEqual([]);
			expect(fixture.counts().textRows).toBe(0);
		}
		expect(fixture.plans.some((plan) => /VIRTUAL TABLE INDEX .*M/.test(plan))).toBe(true);
		expect(fixture.plans.some((plan) => /SEARCH [tc] USING INTEGER PRIMARY KEY/.test(plan))).toBe(true);
	});

	it("preserves literal, Unicode, scope, root, and deletion semantics", async () => {
		const fixture = await database();
		fixture.thread("match", 'Prefix foo%_\\"NEAR bar 😀 東京 suffix 😀😃 éü i̇');
		fixture.thread("other", "outside needle", "elsewhere");
		fixture.thread("deleted", "hidden needle");
		fixture.sqlite.prepare("UPDATE threads_index SET deleted_at = ? WHERE thread_id = 'deleted'").run(now);
		fixture.comment("reply", "match", 'Reply foo%_\\"NEAR bar 😀 東京 suffix');
		fixture.comment("root", "match", "root-only needle");
		fixture.sqlite.exec("UPDATE comments_index SET is_root = 1 WHERE comment_id = 'root'");
		fixture.comment("orphan", "deleted", "hidden needle");
		for (const query of ["FOO", "%_", '\\"', "NEAR", "😀", "東京", "😀 東", 'foo%_\\"NEAR', "root-only", "needle", "fo", "東京 suffix", "😀😃", "éü", "i̇"]) {
			const term = substringSearchQuery(query)!;
			const expectedThreads = fixture.sqlite.prepare(`SELECT root_comment_id AS commentId FROM threads_index
				WHERE forum_id = 'forum' AND deleted_at IS NULL AND lower(search_text) LIKE ? ESCAPE '\\' ORDER BY last_activity_at DESC LIMIT 20`).all(term.likePattern);
			const expectedReplies = fixture.sqlite.prepare(`SELECT c.comment_id AS commentId FROM comments_index c JOIN threads_index t ON t.thread_id = c.thread_id
				WHERE c.forum_id = 'forum' AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND c.is_root = 0
				AND lower(c.search_text) LIKE ? ESCAPE '\\' ORDER BY c.created_at DESC LIMIT 20`).all(term.likePattern);
			const actual = await searchForumThreads(fixture.db, "forum", query, 20, now);
			expect(actual.map((row) => row.commentId), query).toEqual([...expectedThreads, ...expectedReplies].slice(0, 20).map((row) => row.commentId));
		}
	});

	it("bounds index preparation and uses indexed readiness checks", async () => {
		const fixture = await database(100, true);
		expect(await forumSearchPending(fixture.db)).toBe(true);
		await expect(searchForumThreads(fixture.db, "forum", "zz")).rejects.toMatchObject({ status: 503 });
		expect(await rebuildForumSearchIndexes(fixture.db)).toEqual({ processed: 64, remaining: true });
		expect(await rebuildForumSearchIndexes(fixture.db)).toEqual({ processed: 36, remaining: false });
		expect(fixture.plans.some(plan => plan.includes("thread_search_pending"))).toBe(true);
		expect(await searchForumThreads(fixture.db, "forum", "zz")).toEqual([]);
	});

	it("bounds backfill bytes and does not overwrite a concurrent projection", async () => {
		const fixture = await database();
		for (let index = 0; index < 6; index++) fixture.thread(`large-${index}`, 'a'.repeat(65_536));
		fixture.sqlite.exec("UPDATE threads_index SET search_short_tokens = NULL");
		expect(await rebuildForumSearchIndexes(fixture.db)).toEqual({ processed: 4, remaining: true });
		expect(await rebuildForumSearchIndexes(fixture.db)).toEqual({ processed: 2, remaining: false });
		fixture.thread("race", "old token");
		fixture.sqlite.exec("UPDATE threads_index SET search_short_tokens = NULL WHERE thread_id = 'race'");
		const batch = fixture.db.batch.bind(fixture.db);
		fixture.db.batch = async statements => {
			fixture.sqlite.prepare("UPDATE threads_index SET search_text = 'new token', search_short_tokens = ? WHERE thread_id = 'race'").run(shortSubstringTokens("new token"));
			return batch(statements);
		};
		expect(await rebuildForumSearchIndexes(fixture.db)).toEqual({ processed: 0, remaining: false });
		expect(await searchForumThreads(fixture.db, "forum", "old")).toEqual([]);
		expect(await searchForumThreads(fixture.db, "forum", "new")).toHaveLength(1);
	});

	it("generates short tokens in linear work and lowercases source once in SQL", async () => {
		const fixture = await database();
		const original = TextEncoder.prototype.encode;
		for (const length of [4_000, 8_000, 16_000, 32_000]) {
			let encodedCharacters = 0;
			const spy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, text = "") {
				encodedCharacters += text.length; return original.call(this, text);
			});
			try {
				const source = 'a😀東京'.repeat(length).slice(0, length);
				fixture.resetCounters();
				fixture.thread(`long-${length}`, source);
				expect(encodedCharacters).toBeLessThanOrEqual(3 * source.length);
				expect(fixture.counts().textRows).toBe(1);
			} finally { spy.mockRestore(); }
		}
	});

	it("updates both indexes with edits, soft deletion, restoration, and hard deletion", async () => {
		const fixture = await database();
		fixture.thread("edit", "before zz");
		expect(await searchForumThreads(fixture.db, "forum", "zz")).toHaveLength(1);
		fixture.sqlite.prepare("UPDATE threads_index SET search_text = 'after yy', search_short_tokens = ? WHERE thread_id = 'edit'").run(shortSubstringTokens("after yy"));
		expect(await searchForumThreads(fixture.db, "forum", "before")).toHaveLength(0);
		expect(await searchForumThreads(fixture.db, "forum", "zz")).toHaveLength(0);
		expect(await searchForumThreads(fixture.db, "forum", "yy")).toHaveLength(1);
		fixture.sqlite.prepare("UPDATE threads_index SET deleted_at = ? WHERE thread_id = 'edit'").run(now);
		expect(await searchForumThreads(fixture.db, "forum", "after")).toHaveLength(0);
		fixture.sqlite.exec("UPDATE threads_index SET deleted_at = NULL WHERE thread_id = 'edit'");
		expect(await searchForumThreads(fixture.db, "forum", "after")).toHaveLength(1);
		fixture.sqlite.exec("DELETE FROM threads_index WHERE thread_id = 'edit'");
		expect(await searchForumThreads(fixture.db, "forum", "yy")).toHaveLength(0);
	});
});

describe("bounded hot-count refresh", () => {
	it("visits at most64 queued historical threads and writes no unchanged thread rows", async () => {
		const fixture = await database(1_000);
		expect(await refreshThreadHotScores(fixture.db, now)).toBe(64);
		expect(fixture.counts().threadWrites).toBe(0);
		expect(fixture.sqlite.prepare("SELECT count(*) AS total FROM thread_hot_refresh").get()?.total).toBe(936);
		expect(fixture.plans.some((plan) => plan.includes("COVERING INDEX thread_hot_refresh_due"))).toBe(true);
	});

	it("refreshes changed counts, schedules the next expiry, and removes idle threads", async () => {
		const fixture = await database();
		fixture.thread("active");
		fixture.comment("old", "active", "old", "2020-01-01T00:00:00.000Z");
		fixture.comment("new", "active", "recent", "2026-10-01T00:00:00.000Z");
		expect(await refreshThreadHotScores(fixture.db, now)).toBe(1);
		expect(fixture.sqlite.prepare("SELECT recent_comment_count AS count FROM threads_index WHERE thread_id = 'active'").get()?.count).toBe(1);
		expect(fixture.sqlite.prepare("SELECT next_refresh_at AS due FROM thread_hot_refresh").get()?.due).toBe("2026-10-08T00:00:00.000Z");
		expect(await refreshThreadHotScores(fixture.db, "2026-10-07T23:59:59.999Z")).toBe(0);
		expect(await refreshThreadHotScores(fixture.db, "2026-10-08T00:00:00.000Z")).toBe(1);
		expect(fixture.sqlite.prepare("SELECT recent_comment_count AS count FROM threads_index WHERE thread_id = 'active'").get()?.count).toBe(0);
		expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM thread_hot_refresh").get()?.count).toBe(0);
	});

	it("queues comment deletion and drops deleted threads", async () => {
		const fixture = await database();
		fixture.thread("active");
		fixture.comment("new", "active", "recent");
		await refreshThreadHotScores(fixture.db, now);
		fixture.sqlite.prepare("UPDATE comments_index SET deleted_at = ? WHERE comment_id = 'new'").run(now);
		await refreshThreadHotScores(fixture.db, now);
		expect(fixture.sqlite.prepare("SELECT recent_comment_count AS count FROM threads_index WHERE thread_id = 'active'").get()?.count).toBe(0);
		fixture.sqlite.exec("UPDATE comments_index SET deleted_at = NULL WHERE comment_id = 'new'");
		fixture.sqlite.exec("DELETE FROM threads_index WHERE thread_id = 'active'");
		expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM thread_hot_refresh").get()?.count).toBe(0);
	});
});
