import { botServiceIssue } from './bot-service-issues';
import type { D1DatabaseLike } from "./storage";
import { RepositoryError } from "./repository";

type SubstringSearchQuery =
	| { kind: "trigram"; match: string; likePattern: string }
	| { kind: "short"; match: string; likePattern: string };

export function substringSearchQuery(query: string): SubstringSearchQuery | null {
	const normalized = query.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 160);
	if (normalized.length < 2) return null;
	const likePattern = `%${normalized.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
	if ([...normalized].length >= 3) {
		// Quoting makes FTS operators, punctuation, and quotes literal. The LIKE
		// residual still defines the result, so tokenizer folding cannot widen it.
		return { kind: "trigram", match: `"${normalized.replaceAll('"', '""')}"`, likePattern };
	}
	const encoded = Array.from(new TextEncoder().encode(normalized), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return { kind: "short", match: `x${encoded}`, likePattern };
}

export function substringCandidateSql(source: "thread" | "comment", query: SubstringSearchQuery): string {
	// Both identifiers come from closed unions, never from user input.
	const index = `${source}_search_${query.kind === "trigram" ? "trigrams" : "short"}`;
	return `SELECT rowid FROM ${index} WHERE ${index} MATCH ?`;
}

/** SQLite lower() folds ASCII only; keep its existing literal-match semantics. */
export function shortSubstringTokens(text: string): string {
	const characters = [...text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())];
	const tokens = new Set<string>();
	const encoder = new TextEncoder();
	const encode = (value: string) => 'x' + Array.from(encoder.encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
	for (let index = 0; index < characters.length; index++) {
		tokens.add(encode(characters[index]!));
		if (index + 1 < characters.length) tokens.add(encode(characters[index]! + characters[index + 1]!));
	}
	return [...tokens].join(' ');
}

export function substringIndexFields(text: string): Readonly<{ searchText: string; shortTokens: string }> {
	const searchText = text.toLowerCase();
	return { searchText, shortTokens: shortSubstringTokens(searchText) };
}

const sources = [
	{ table: 'threads_index', id: 'thread_id', live: 'deleted_at IS NULL' },
	{ table: 'comments_index', id: 'comment_id', live: 'deleted_at IS NULL AND is_root = 0' },
] as const;

export async function forumSearchPending(db: D1DatabaseLike): Promise<boolean> {
	const row = await db.prepare(`SELECT
		EXISTS(SELECT 1 FROM threads_index WHERE search_short_tokens IS NULL AND deleted_at IS NULL LIMIT 1)
		OR EXISTS(SELECT 1 FROM comments_index WHERE search_short_tokens IS NULL AND deleted_at IS NULL AND is_root = 0 LIMIT 1) AS pending`).first<{ pending: number }>();
	return Boolean(row?.pending);
}

export async function requireForumSearchReady(db: D1DatabaseLike): Promise<void> {
	if (await forumSearchPending(db)) throw new RepositoryError('server_error', 'Forum search is rebuilding its index. Please try again shortly.', 503, { botIssue: botServiceIssue('issue.service.searchRebuilding', {}) });
}

/** One-time migration sweep. NULL is an indexed work marker, not a read repair.
 * At most 64 candidates and 256 KiB of source text per table are processed per call
 * (one larger historical row is allowed to make progress). Projection writers
 * fill the column directly. Delete this sweep after all deployed stores drain;
 * the next search schema version must not add another read-time fallback. */
export async function rebuildForumSearchIndexes(db: D1DatabaseLike): Promise<{ processed: number; remaining: boolean }> {
	let processed = 0;
	for (const source of sources) {
		const rows = await db.prepare(`WITH candidates AS MATERIALIZED (
			SELECT ${source.id} AS id, search_text AS text FROM ${source.table}
			WHERE search_short_tokens IS NULL AND ${source.live} ORDER BY ${source.id} LIMIT 64
		), sized AS (
			SELECT id, text, row_number() OVER (ORDER BY id) AS ordinal,
			sum(length(CAST(text AS BLOB))) OVER (ORDER BY id) AS bytes FROM candidates
		) SELECT id, text FROM sized WHERE ordinal = 1 OR bytes <= 262144 ORDER BY id`).all<{ id: string; text: string }>();
		const statements = (rows.results ?? []).map(row => db.prepare(
			`UPDATE ${source.table} SET search_short_tokens = ? WHERE ${source.id} = ? AND search_text = ? AND search_short_tokens IS NULL RETURNING ${source.id} AS id`,
		).bind(shortSubstringTokens(row.text), row.id, row.text));
		if (statements.length) {
			const result = await db.batch(statements);
			if (result.some(item => !item.success)) throw new Error('Forum search index batch failed.');
			processed += result.reduce((sum, item) => sum + (item.results?.length ?? 0), 0);
		}
	}
	return { processed, remaining: await forumSearchPending(db) };
}
