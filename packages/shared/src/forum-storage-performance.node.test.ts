/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshThreadHotScores, searchForumThreads } from "./social";
import { substringIndexFields, substringSearchQuery } from "./indexed-substring-search";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./storage";

const migrationDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const databases: DatabaseSync[] = [];
const now = "2026-10-02T00:00:00.000Z";

async function database(count = 0) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	for (const file of readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(`${migrationDirectory}/${file}`, "utf8"));
	}
	const insert = sqlite.prepare(`INSERT INTO threads_index(thread_id, root_comment_id, world_id, world_handle,
		forum_id, forum_handle, author_bot_id, author_handle, author_display_name, title, body_preview,
		search_text, search_short_tokens, created_at, last_activity_at) VALUES(?, ?, 'world', 'world', ?, 'forum', 'bot', 'bot', 'Bot', ?, ?, ?, ?, ?, ?)`);
	const thread = (id: string, text = "ancient body", forum = "forum") => {
		const indexed = substringIndexFields(text);
		insert.run(id, `${id}-root`, forum, text, text, indexed.searchText, indexed.shortTokens, "2020-01-01T00:00:00.000Z", `2020-01-01T00:00:${id.endsWith("2") ? "02" : "01"}.000Z`);
	};
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
					if (/RETURNING/i.test(state.sql)) {
						const results = sqlite.prepare(state.sql).all(...state.values as []);
						// D1 changes includes derived trigger writes, unlike returned rows.
						return { success: true, results, meta: { changes: results.length * 7 } };
					}
					return { success: true, meta: { changes: Number(sqlite.prepare(state.sql).run(...state.values as []).changes) } };
				});
				sqlite.exec("COMMIT");
				return results;
			} catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		},
	};
	const comment = (id: string, threadId: string, text: string, createdAt = "2026-10-01T00:00:00.000Z") => {
		const indexed = substringIndexFields(text);
		sqlite.prepare(`INSERT INTO comments_index(comment_id, thread_id, world_id, forum_id, author_bot_id,
			author_handle, body_preview, search_text, search_short_tokens, created_at, is_root) VALUES(?, ?, 'world', 'forum', 'bot', 'bot', ?, ?, ?, ?, 0)`)
			.run(id, threadId, text, indexed.searchText, indexed.shortTokens, createdAt);
	};
	sqlite.exec("BEGIN");
	for (let i = 0; i < count; i++) thread(`historical-${String(i).padStart(6, "0")}`);
	sqlite.exec("COMMIT");
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
		fixture.sqlite.prepare("UPDATE threads_index SET search_text = 'after yy', search_short_tokens = ? WHERE thread_id = 'edit'").run(substringIndexFields("after yy").shortTokens);
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

describe("production-order last-active reads", () => {
	it("plans the world list and the backfill at production-order counts", async () => {
		const sqlite = new DatabaseSync(":memory:");
		databases.push(sqlite);
		for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
			sqlite.exec(readFileSync(`${migrationDirectory}/${file}`, "utf8"));
		}
		const threads = 20_300;
		const comments = 169_567;
		const bots = 505;
		const votes = 29_061;
		const follows = 7_895;
		const indexed = substringIndexFields("scale");
		const createdAt = "2020-01-01T00:00:00.000Z";
		const claim = sqlite.prepare(`INSERT INTO entity_lifecycle_identity_claims
			(key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id, claim_state, created_at, updated_at)
			VALUES ('bot_handle', 'world', ?, 'bot', ?, 'usr_scale', 'active', ?, ?)`);
		const bot = sqlite.prepare(`INSERT INTO bots_index
			(bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id, short_bio, created_at, updated_at)
			VALUES (?, 'world', 'world', ?, ?, 'usr_scale', '', ?, ?)`);
		const thread = sqlite.prepare(`INSERT INTO threads_index
			(thread_id, root_comment_id, world_id, world_handle, forum_id, forum_handle, author_bot_id, author_handle,
			 author_display_name, title, body_preview, search_text, search_short_tokens, created_at, last_activity_at)
			VALUES (?, ?, 'world', 'world', 'forum', 'forum', ?, ?, 'Bot', 'Title', 'Body', ?, ?, ?, ?)`);
		const comment = sqlite.prepare(`INSERT INTO comments_index
			(comment_id, thread_id, world_id, forum_id, author_bot_id, author_handle, body_preview, search_text, search_short_tokens, created_at)
			VALUES (?, ?, 'world', 'forum', ?, ?, 'Body', ?, ?, ?)`);
		const vote = sqlite.prepare(`INSERT INTO votes
			(world_id, target_type, target_id, bot_id, value, created_at, updated_at)
			VALUES ('world', 'comment', ?, ?, 1, ?, ?)`);
		const follow = sqlite.prepare(`INSERT INTO follows
			(world_id, follower_bot_id, followed_bot_id, created_at)
			VALUES ('world', ?, ?, ?)`);
		const stamp = "2026-10-01T00:00:00.000Z";
		sqlite.exec("BEGIN");
		for (let index = 0; index < bots; index += 1) {
			const id = `bot-${String(index).padStart(3, "0")}`;
			claim.run(id, id, createdAt, createdAt);
			bot.run(id, id, id, createdAt, createdAt);
		}
		for (let index = 0; index < threads; index += 1) {
			const author = `bot-${String(index % bots).padStart(3, "0")}`;
			const id = `thread-${index}`;
			thread.run(id, `${id}-root`, author, author, indexed.searchText, indexed.shortTokens, stamp, stamp);
		}
		for (let index = 0; index < comments; index += 1) {
			const author = `bot-${String(index % bots).padStart(3, "0")}`;
			comment.run(`comment-${index}`, `thread-${index % threads}`, author, author, indexed.searchText, indexed.shortTokens, stamp);
		}
		for (let index = 0; index < votes; index += 1) {
			vote.run(`vote-${index}`, `bot-${String(index % bots).padStart(3, "0")}`, stamp, stamp);
		}
		for (let index = 0; index < follows; index += 1) {
			const follower = index % bots;
			const followed = (follower + 1 + Math.floor(index / bots)) % bots;
			follow.run(`bot-${String(follower).padStart(3, "0")}`, `bot-${String(followed).padStart(3, "0")}`, stamp);
		}
		sqlite.exec("COMMIT");

		// Keep this statement aligned with the unpaged listWorldBots query in repository.ts.
		const worldListSql = `WITH selected AS (
			SELECT bot_id AS id, created_at, updated_at, handle, last_active_at
			FROM bots_index
			WHERE home_world_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
			ORDER BY handle ASC
		)
		SELECT
			selected.id AS id,
			selected.created_at AS createdAt,
			selected.updated_at AS updatedAt,
			selected.handle AS handle,
			runtime.next_due_at AS nextDueAt,
			selected.last_active_at AS lastActiveAt
		FROM selected
		LEFT JOIN bot_runtime_index runtime ON runtime.bot_id = selected.id
		ORDER BY selected.handle ASC`;
		const backfillSql = readFileSync(`${migrationDirectory}/0074_backfill_bot_last_active.sql`, "utf8")
			.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim().replace(/;$/, "");
		expect(backfillSql.startsWith("UPDATE bots_index")).toBe(true);
		const worldPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${worldListSql}`).all("world").map((row) => String(row.detail));
		const backfillPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${backfillSql}`).all().map((row) => String(row.detail));
		expect(worldPlan.length).toBeGreaterThan(0);
		expect(worldPlan.join("\n")).not.toMatch(/threads_index|comments_index|\bvotes\b|\bfollows\b/);
		expect(worldPlan.join("\n")).toMatch(/bots_index/);
		expect(worldPlan.join("\n")).toMatch(/bot_runtime_index/);
		expect(backfillPlan.join("\n")).toMatch(/threads_index/);
		const listStarted = performance.now();
		const listed = sqlite.prepare(worldListSql).all("world");
		const listMs = performance.now() - listStarted;
		expect(listed).toHaveLength(bots);
		const backfillStarted = performance.now();
		sqlite.exec(backfillSql);
		const backfillMs = performance.now() - backfillStarted;
		const report = { listMs, backfillMs, bots: listed.length, worldPlan, backfillPlan };
		console.log(JSON.stringify({ event: "d1_overload_scale", ...report }));
		mkdirSync("/build/bickr/logs", { recursive: true });
		writeFileSync("/build/bickr/logs/d1-overload-scale.json", JSON.stringify(report, null, 2));
	}, 180_000);
});
