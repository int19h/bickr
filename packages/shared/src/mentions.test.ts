import { describe, expect, it } from "vitest";
import {
	canonicalMentionText,
	extractCanonicalMentionHandles,
	extractMentionCandidates,
	mentionResolutionChunkSize,
	resolveMentionHandles,
	rewriteMentions,
	type MentionCandidate,
	type ResolvedMention,
} from "./mentions";
import { type D1DatabaseLike, type D1PreparedStatementLike, type D1Result } from "./storage";

// Stored handles are always normalized, so every fixture handle is too.
const participants = ["a", "alice", "bob", "u", "автор_1", "firefly", "x".repeat(32)];

describe("extractMentionCandidates", () => {
	it("recognizes bare and prefixed forms at the start of the text", () => {
		expect(extractMentionCandidates("@alice says hi")).toMatchObject([
			{ form: "bare", start: 0, end: 6, rawHandle: "alice", handle: "alice" },
		]);
		expect(extractMentionCandidates("@u/alice says hi")).toMatchObject([
			{ form: "prefixed", start: 0, end: 8, rawHandle: "alice", handle: "alice" },
		]);
	});

	it("accepts whitespace, newline, and Unicode punctuation predecessors", () => {
		for (const text of [
			"hi @alice",
			"hi\n@alice",
			"hi @alice",
			"(@alice)",
			"“@alice,”",
			"see:@alice",
			"see;@alice",
			"see-@alice",
			"see/@alice",
			"see\\@alice",
			"see_@alice",
			"。@alice",
			"—@alice",
		]) {
			expect(handlesOf(text), text).toEqual(["alice"]);
		}
	});

	it("rejects letter, digit, and symbol predecessors", () => {
		for (const text of ["x@alice", "1@alice", "emoji\u{1f642}@alice", "<@alice", "+@alice", "=@alice", "$@alice"]) {
			expect(handlesOf(text), text).toEqual([]);
		}
	});

	it("treats `@` itself and its compatibility forms as disqualifying predecessors", () => {
		expect(handlesOf("@@alice")).toEqual([]);
		expect(handlesOf("＠@alice")).toEqual([]);
		expect(handlesOf("﹫@alice")).toEqual([]);
		expect(handlesOf("hi @@alice")).toEqual([]);
	});

	it("requires the maximal handle token, rejecting partial and trailing-`@` matches", () => {
		expect(handlesOf(`@${"a".repeat(32)}`)).toEqual(["a".repeat(32)]);
		expect(handlesOf(`@${"a".repeat(33)}`)).toEqual([]);
		expect(handlesOf("@alice@example.com")).toEqual([]);
		expect(handlesOf("@alice@")).toEqual([]);
		expect(handlesOf("@alicebeth")).toEqual(["alicebeth"]);
		expect(handlesOf("@")).toEqual([]);
		expect(handlesOf("@ alice")).toEqual([]);
		expect(handlesOf("@́alice")).toEqual([]);
	});

	it("accepts one-character, underscore, hyphen, and Unicode handles", () => {
		expect(handlesOf("@a")).toEqual(["a"]);
		expect(handlesOf("@a_b-c")).toEqual(["a_b-c"]);
		expect(handlesOf("@автор_1")).toEqual(["автор_1"]);
		expect(handlesOf("@ALICE")).toEqual(["alice"]);
		expect(handlesOf("@u/ALICE")).toEqual(["alice"]);
		expect(handlesOf("@U/alice")).toEqual(["alice"]);
	});

	it("keeps the two branches disjoint so a failed prefixed form never becomes `u`", () => {
		expect(extractMentionCandidates("@u/missing")).toMatchObject([{ form: "prefixed", handle: "missing" }]);
		expect(handlesOf("@u/")).toEqual([]);
		expect(handlesOf(`@u/${"a".repeat(33)}`)).toEqual([]);
		expect(handlesOf("@u/@alice")).toEqual(["alice"]);
	});

	it("treats a `u` token before any slash as the namespace prefix rather than a handle", () => {
		expect(handlesOf("@ｕ/alice")).toEqual([]);
		expect(handlesOf("@ｕ／alice")).toEqual([]);
		expect(handlesOf("@u／alice")).toEqual([]);
		expect(handlesOf("@u/u/alice")).toEqual([]);
		// A participant literally named `u` is still mentionable when no slash follows.
		expect(handlesOf("@u")).toEqual(["u"]);
		expect(handlesOf("@u!")).toEqual(["u"]);
		expect(handlesOf("@u/u")).toEqual(["u"]);
	});

	it("normalizes candidates without throwing when compatibility folding leaves the grammar", () => {
		expect(handlesOf("@½")).toEqual([]);
		expect(handlesOf(`@${"ﬁ".repeat(17)}`)).toEqual([]);
		expect(handlesOf(`@${"ﬁ".repeat(16)}`)).toEqual(["fi".repeat(16)]);
		expect(handlesOf("@ａｌｉｃｅ")).toEqual(["alice"]);
	});

	it("finds repeated and mixed mentions in source order without overlap", () => {
		const candidates = extractMentionCandidates("@alice and @u/bob and @alice again, u/bob too");
		expect(candidates.map((candidate) => [candidate.form, candidate.handle])).toEqual([
			["bare", "alice"],
			["prefixed", "bob"],
			["bare", "alice"],
		]);
		for (let index = 1; index < candidates.length; index += 1) {
			expect(candidates[index]!.start).toBeGreaterThanOrEqual(candidates[index - 1]!.end);
		}
	});
});

describe("extractCanonicalMentionHandles", () => {
	it("recognizes already-canonical references with the stricter shipped boundary", () => {
		expect(extractCanonicalMentionHandles("Ping u/alice and u/bob.")).toEqual(["alice", "bob"]);
		expect(extractCanonicalMentionHandles("u/автор_1 wrote it")).toEqual(["автор_1"]);
		expect(extractCanonicalMentionHandles("(u/ALICE)")).toEqual(["alice"]);
	});

	it("ignores profile URLs and other handle-adjacent paths", () => {
		expect(extractCanonicalMentionHandles("https://host/w/x/u/alice")).toEqual([]);
		expect(extractCanonicalMentionHandles("see-u/alice")).toEqual([]);
		expect(extractCanonicalMentionHandles("xu/alice")).toEqual([]);
	});

	it("drops references whose compatibility folding is not a handle instead of throwing", () => {
		expect(() => extractCanonicalMentionHandles("u/½")).not.toThrow();
		expect(extractCanonicalMentionHandles("u/½")).toEqual([]);
	});
});

describe("rewriteMentions", () => {
	it("rewrites both forms to the canonical stored handle", () => {
		expect(canonicalize("@alice and @u/alice")).toBe("u/alice and u/alice");
		expect(canonicalize("@ALICE")).toBe("u/alice");
		expect(canonicalize("(@alice)")).toBe("(u/alice)");
		expect(canonicalize("“@alice,”")).toBe("“u/alice,”");
	});

	it("uses the stored handle rather than the authored spelling", () => {
		expect(canonicalize("@ａｌｉｃｅ")).toBe("u/alice");
		expect(canonicalize("@ﬁreﬂy")).toBe("u/firefly");
		expect(canonicalize("@u/ＡＬＩＣＥ")).toBe("u/alice");
		expect(canonicalize(`@${"X".repeat(32)}`)).toBe(`u/${"x".repeat(32)}`);
	});

	it("preserves unresolved candidates and surrounding text exactly", () => {
		for (const text of [
			"@nobody at all",
			"x@alice",
			"@@alice",
			"@u/",
			"@u/nobody",
			"@ｕ/alice",
			"@½",
			`@${"a".repeat(33)}`,
			"@alice@example.com",
			"emoji\u{1f642}@alice",
			"plain text with no mention",
			"https://host/w/x/u/alice",
		]) {
			expect(canonicalize(text), text).toBe(text);
		}
	});

	it("is idempotent: canonicalizing stored output changes nothing", () => {
		for (const text of [
			"@alice",
			"@u/alice",
			"@alice @u/bob u/alice",
			"@u/@alice",
			"hi @alice, bye @u/bob!",
			"@u/u/alice",
			"@nobody and @alice",
		]) {
			const once = canonicalize(text);
			expect(canonicalize(once), text).toBe(once);
		}
	});

	it("keeps text unchanged when nothing resolves, including its exact identity", () => {
		const text = "Nothing to see for @nobody here.";
		expect(rewriteMentions(text, extractMentionCandidates(text), new Map())).toBe(text);
	});

	it("grows a bare mention by exactly one character per mention", () => {
		const text = Array.from({ length: 10 }, () => "@a").join(" ");
		expect(canonicalize(text).length).toBe(text.length + 10);
		expect(canonicalize("@u/alice").length).toBe("@u/alice".length - 1);
	});
});

describe("resolveMentionHandles", () => {
	it("queries active, non-deleted, same-world rows only", async () => {
		const db = new FakeMentionD1([
			{ botId: "bot_alice", handle: "alice", worldId: "wld_a", deletedAt: null, lifecycleState: "active" },
			{ botId: "bot_gone", handle: "gone", worldId: "wld_a", deletedAt: "2026-05-01T00:00:00.000Z", lifecycleState: "active" },
			{ botId: "bot_idle", handle: "idle", worldId: "wld_a", deletedAt: null, lifecycleState: "suspended" },
			{ botId: "bot_far", handle: "far", worldId: "wld_b", deletedAt: null, lifecycleState: "active" },
		]);

		const resolved = await resolveMentionHandles(db, "wld_a", ["alice", "gone", "idle", "far", "missing"]);

		expect([...resolved.keys()]).toEqual(["alice"]);
		expect(resolved.get("alice")).toEqual({ botId: "bot_alice", handle: "alice" });
		expect(db.queries).toHaveLength(1);
		expect(db.queries[0]?.bindings[0]).toBe("wld_a");
	});

	it("chunks the lookup without dropping candidates or exceeding the parameter ceiling", async () => {
		const handles = Array.from({ length: 250 }, (_, index) => `bot${index}`);
		const db = new FakeMentionD1(handles.map((handle, index) => ({
			botId: `bot_${index}`,
			handle,
			worldId: "wld_a",
			deletedAt: null,
			lifecycleState: "active",
		})));

		const resolved = await resolveMentionHandles(db, "wld_a", handles);

		expect(resolved.size).toBe(250);
		expect(db.queries).toHaveLength(Math.ceil(250 / mentionResolutionChunkSize));
		for (const query of db.queries) {
			expect(query.bindings.length).toBeLessThanOrEqual(99);
		}
	});

	it("issues no query for text without candidates", async () => {
		const db = new FakeMentionD1([]);
		await expect(resolveMentionHandles(db, "wld_a", [])).resolves.toEqual(new Map());
		expect(db.queries).toEqual([]);
	});
});

function handlesOf(text: string): string[] {
	return extractMentionCandidates(text).map((candidate) => candidate.handle);
}

function canonicalize(text: string): string {
	const candidates: readonly MentionCandidate[] = extractMentionCandidates(text);
	const resolved = new Map<string, ResolvedMention>(
		participants.map((handle) => [handle, { botId: `bot_${handle}`, handle }]),
	);
	return rewriteMentions(text, candidates, resolved);
}

describe("canonicalMentionText", () => {
	it("formats the canonical reference", () => {
		expect(canonicalMentionText("alice")).toBe("u/alice");
	});
});

type MentionRow = {
	botId: string;
	handle: string;
	worldId: string;
	deletedAt: string | null;
	lifecycleState: string;
};

class FakeMentionD1 implements D1DatabaseLike {
	readonly queries: Array<{ query: string; bindings: unknown[] }> = [];
	private readonly rows: MentionRow[];

	constructor(rows: MentionRow[]) {
		this.rows = rows;
	}

	prepare(query: string): D1PreparedStatementLike {
		return new FakeMentionStatement(this, query);
	}

	async batch(): Promise<Array<D1Result>> {
		throw new Error("Unexpected batch in mention resolution.");
	}

	all<T>(query: string, bindings: unknown[]): D1Result<T> {
		this.queries.push({ query, bindings });
		if (!query.includes("FROM bots_index")) {
			throw new Error(`Unexpected query: ${query}`);
		}
		const [worldId, ...handles] = bindings.map(String);
		const results = this.rows.filter((row) =>
			row.worldId === worldId &&
			row.deletedAt === null &&
			row.lifecycleState === "active" &&
			handles.includes(row.handle),
		);
		return { success: true, results: results.map((row) => ({ botId: row.botId, handle: row.handle })) as T[] };
	}
}

class FakeMentionStatement implements D1PreparedStatementLike {
	private bindings: unknown[] = [];
	private readonly db: FakeMentionD1;
	private readonly query: string;

	constructor(db: FakeMentionD1, query: string) {
		this.db = db;
		this.query = query;
	}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		throw new Error("Unexpected first() in mention resolution.");
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		return this.db.all<T>(this.query, this.bindings);
	}

	async run(): Promise<D1Result> {
		throw new Error("Unexpected run() in mention resolution.");
	}
}
