import { describe, expect, it } from "vitest";
import {
	notificationSourceDeleteStatements,
	threadIndexScopedNotificationDeleteStatements,
} from "./notification-source-deletes";
import {
	d1SafeBoundParameters,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
	type D1Result,
} from "./storage";

/**
 * The builders' whole contract is the SQL and the bindings they hand back — a
 * caller folds them into its own batch and never runs them here — so these
 * inspect the built statements rather than a database's contents. The delete
 * paths and the cascades that reach them are covered against real D1 in
 * `test/notification-source-cleanup.spec.ts`.
 */
class RecordedStatement implements D1PreparedStatementLike {
	bindings: unknown[] = [];
	readonly query: string;

	constructor(query: string) {
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
		return { success: true, meta: { changes: 0 } };
	}
}

class RecordingD1 implements D1DatabaseLike {
	readonly statements: RecordedStatement[] = [];

	prepare(query: string): D1PreparedStatementLike {
		const statement = new RecordedStatement(query);
		this.statements.push(statement);
		return statement;
	}

	async batch(): Promise<D1Result[]> {
		throw new Error("These builders hand their statements to the caller's batch.");
	}
}

function statementsFor(refs: Parameters<typeof notificationSourceDeleteStatements>[1]): RecordedStatement[] {
	const db = new RecordingD1();
	notificationSourceDeleteStatements(db, refs);
	return db.statements;
}

/** `notifications` only — `human_notifications` deletes are a different table. */
function botStatements(statements: RecordedStatement[]): RecordedStatement[] {
	return statements.filter((statement) => statement.query.includes("DELETE FROM notifications"));
}

function humanStatements(statements: RecordedStatement[], column: "source" | "target"): RecordedStatement[] {
	return statements.filter((statement) => statement.query.includes(`${column}_type = ?`));
}

describe("notificationSourceDeleteStatements", () => {
	it("binds the formatted ref against the bot table and the raw id against both human arms", () => {
		const statements = statementsFor([{ type: "comment", id: "abc23456" }]);

		expect(statements).toHaveLength(3);
		expect(botStatements(statements).map((statement) => statement.bindings)).toEqual([["c/abc23456"]]);
		// The formatted ref exists only in the bot table; binding it here would
		// silently match nothing.
		expect(humanStatements(statements, "source").map((statement) => statement.bindings))
			.toEqual([["comment", "abc23456"]]);
		expect(humanStatements(statements, "target").map((statement) => statement.bindings))
			.toEqual([["comment", "abc23456"]]);
	});

	it("uses the thread ref shape and the thread type for a thread", () => {
		const statements = statementsFor([{ type: "thread", id: "thr23456" }]);

		expect(botStatements(statements).map((statement) => statement.bindings)).toEqual([["t/thr23456"]]);
		expect(humanStatements(statements, "source").map((statement) => statement.bindings))
			.toEqual([["thread", "thr23456"]]);
		expect(humanStatements(statements, "target").map((statement) => statement.bindings))
			.toEqual([["thread", "thr23456"]]);
	});

	it("matches a legacy prefixed id both formatted and bare", () => {
		const statements = statementsFor([
			{ type: "comment", id: "cmt_9d0f" },
			{ type: "thread", id: "thr_9d0f" },
		]);

		expect(botStatements(statements)[0]?.bindings)
			.toEqual(["c/cmt_9d0f", "cmt_9d0f", "t/thr_9d0f", "thr_9d0f"]);
	});

	it("never emits a bare short id as a bot match value", () => {
		// A thread's root comment id equals its thread id, so a bare short id in
		// `source_object_id` cannot be attributed to one or the other. Matching one
		// would retract the notifications of the sibling that shares the id.
		const statements = statementsFor([
			{ type: "comment", id: "abc23456" },
			{ type: "thread", id: "abc23456" },
		]);

		expect(botStatements(statements)[0]?.bindings).toEqual(["c/abc23456", "t/abc23456"]);
		for (const statement of botStatements(statements)) {
			expect(statement.bindings).not.toContain("abc23456");
		}
		// The two types are separate human arms even though they share an id.
		expect(humanStatements(statements, "source").map((statement) => statement.bindings))
			.toEqual([["comment", "abc23456"], ["thread", "abc23456"]]);
	});

	it("collapses repeated refs", () => {
		const statements = statementsFor([
			{ type: "comment", id: "abc23456" },
			{ type: "comment", id: "abc23456" },
			{ type: "comment", id: "def23456" },
		]);

		expect(statements).toHaveLength(3);
		expect(botStatements(statements)[0]?.bindings).toEqual(["c/abc23456", "c/def23456"]);
		expect(humanStatements(statements, "source")[0]?.bindings).toEqual(["comment", "abc23456", "def23456"]);
	});

	it("issues no statement for an empty ref set, so a caller's batch stays as it was", () => {
		expect(statementsFor([])).toEqual([]);
		// An id-less ref is not a ref.
		expect(statementsFor([{ type: "comment", id: "" }])).toEqual([]);
	});

	it("matches by exact value, never by LIKE", () => {
		// Every legacy prefix contains `_`, which is a LIKE wildcard: a prefix
		// probe would match ids that merely differ in that position.
		for (const statement of statementsFor([{ type: "comment", id: "cmt_9d0f" }])) {
			expect(statement.query).not.toMatch(/\bLIKE\b/u);
		}
	});

	it("chunks the bot arm on match values rather than on refs", () => {
		// Legacy refs cost two match values each, so the ceiling is reached at half
		// as many refs as a ref-counted chunk would allow.
		const legacyRefs = Array.from({ length: d1SafeBoundParameters }, (_, index) => ({
			type: "comment" as const,
			id: `cmt_${String(index).padStart(4, "0")}`,
		}));
		const bot = botStatements(statementsFor(legacyRefs));

		expect(bot).toHaveLength(2);
		expect(bot[0]?.bindings).toHaveLength(d1SafeBoundParameters);
		expect(bot[1]?.bindings).toHaveLength(d1SafeBoundParameters);
		for (const statement of bot) {
			expect(statement.bindings.length).toBeLessThanOrEqual(d1SafeBoundParameters);
			expect(statement.query.split("?").length - 1).toBe(statement.bindings.length);
		}
	});

	it("fills a bot chunk exactly at the bound-parameter ceiling before opening a second", () => {
		const refs = (count: number) => Array.from({ length: count }, (_, index) => ({
			type: "comment" as const,
			id: `c${String(index).padStart(7, "0")}`,
		}));

		expect(botStatements(statementsFor(refs(d1SafeBoundParameters)))).toHaveLength(1);
		expect(botStatements(statementsFor(refs(d1SafeBoundParameters + 1)))).toHaveLength(2);
	});

	it("leaves a human chunk one bind short of the ceiling for its type column", () => {
		const refs = (count: number) => Array.from({ length: count }, (_, index) => ({
			type: "thread" as const,
			id: `t${String(index).padStart(7, "0")}`,
		}));

		const atCeiling = statementsFor(refs(d1SafeBoundParameters - 1));
		expect(humanStatements(atCeiling, "source")).toHaveLength(1);
		expect(humanStatements(atCeiling, "source")[0]?.bindings).toHaveLength(d1SafeBoundParameters);

		const overCeiling = statementsFor(refs(d1SafeBoundParameters));
		expect(humanStatements(overCeiling, "source")).toHaveLength(2);
		expect(humanStatements(overCeiling, "target")).toHaveLength(2);
		for (const statement of overCeiling) {
			expect(statement.bindings.length).toBeLessThanOrEqual(d1SafeBoundParameters);
		}
	});
});

describe("threadIndexScopedNotificationDeleteStatements", () => {
	it("reads the comment refs from the index and the thread's own refs from the id", () => {
		const db = new RecordingD1();
		const statements = threadIndexScopedNotificationDeleteStatements(db, "thr23456");

		expect(statements).toHaveLength(6);
		const bot = botStatements(db.statements);
		// The index arm covers both stored shapes in one statement, and the thread's
		// own arm is the ordinary builder.
		expect(bot).toHaveLength(2);
		expect(bot[0]?.query).toContain("SELECT 'c/' || comment_id FROM comments_index WHERE thread_id = ?");
		expect(bot[0]?.query).toContain("substr(comment_id, 1, 4) = 'cmt_'");
		expect(bot[0]?.bindings).toEqual(["thr23456", "thr23456"]);
		expect(bot[1]?.bindings).toEqual(["t/thr23456"]);

		expect(humanStatements(db.statements, "source").map((statement) => statement.bindings))
			.toEqual([["thread", "thr23456"]]);
		// The comment arms fix their type in the SQL, so they bind the thread id
		// alone; the thread arms bind their type like any other.
		const commentScoped = db.statements.filter((statement) => statement.query.includes("source_type = 'comment'"));
		expect(commentScoped.map((statement) => statement.bindings)).toEqual([["thr23456"]]);
	});

	it("matches the legacy bare comment shape without a LIKE wildcard", () => {
		const db = new RecordingD1();
		threadIndexScopedNotificationDeleteStatements(db, "thr_9d0f");

		for (const statement of db.statements) {
			expect(statement.query).not.toMatch(/\bLIKE\b/u);
		}
		// The thread's own bare id is a legacy prefixed one, so it is matched too.
		expect(botStatements(db.statements)[1]?.bindings).toEqual(["t/thr_9d0f", "thr_9d0f"]);
	});
});
