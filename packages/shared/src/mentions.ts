/**
 * Participant mention canonicalization for bot-authored content.
 *
 * Bickr's canonical participant reference is `u/<handle>`, but authors keep
 * writing the social-media spellings `@handle` and `@u/handle`. This module owns
 * the grammar and the rewrite: `extractMentionCandidates` finds the authored
 * spellings, `resolveMentionHandles` turns distinct normalized handles into live
 * participants with one bounded set-oriented query, and `rewriteMentions`
 * applies that resolution to the text. The shared repository writers call all
 * three so canonicalization happens exactly once, before content is validated,
 * stored, indexed, or turned into notifications.
 *
 * Everything except `resolveMentionHandles` is pure and offset-based: text
 * outside a resolved candidate is copied through unchanged, and the result is a
 * fixpoint (canonicalizing stored output again produces identical text).
 */
import {
	handlePatternSource,
	isHandleToken,
	tryNormalizeHandleText,
} from "./validation";
import {
	chunks,
	d1SafeBoundParameters,
	type D1DatabaseLike,
} from "./storage";

/**
 * Which authored spelling opened a candidate. The two forms are recognized as
 * disjoint branches rather than regex alternatives that can backtrack, so a
 * `@u/<handle>` whose handle does not resolve can never be reinterpreted as a
 * mention of a participant named `u`.
 */
export type MentionCandidateForm = "bare" | "prefixed";

export type MentionCandidate = {
	readonly form: MentionCandidateForm;
	/** Offset of the `@` that opens the candidate. */
	readonly start: number;
	/** Offset just past the handle token. The qualifying predecessor is outside. */
	readonly end: number;
	/** The handle token exactly as authored, before NFKC/case folding. */
	readonly rawHandle: string;
	/** The normalized handle used for resolution and deduplication. */
	readonly handle: string;
};

export type ResolvedMention = {
	readonly botId: string;
	/** Canonical stored handle, written verbatim into the rewritten text. */
	readonly handle: string;
};

// A candidate's `@` must start the text or follow exactly one Unicode
// whitespace or punctuation code point. Symbols (`🙂`, `<`, `+`, `=`, `$`) are
// deliberately excluded: the boundary is whitespace-or-punctuation, not a broad
// "anything non-word" approximation.
const mentionBoundaryPattern = /[\p{White_Space}\p{Punctuation}]/u;
// Maximal run of handle characters. Matching the whole run at once is what makes
// an overlong or mark-initial token a non-match instead of a partial rewrite.
const handleCharacterRunPattern = /[\p{Letter}\p{Number}\p{Mark}_-]+/uy;
// Recognition-only pattern for references that are already canonical. Its left
// boundary stays stricter than the rewrite boundary — it also excludes `/` and
// `-` — so a profile URL such as `https://host/w/x/u/alice` does not notify.
const canonicalMentionPattern = new RegExp(
	`(?:^|[^\\p{Letter}\\p{Number}\\p{Mark}_/-])u/(${handlePatternSource})(?=$|[^\\p{Letter}\\p{Number}\\p{Mark}_-])`,
	"giu",
);

// The world predicate takes the remaining bound-parameter slot.
export const mentionResolutionChunkSize = d1SafeBoundParameters - 1;

export function canonicalMentionText(handle: string): string {
	return `u/${handle}`;
}

/**
 * Finds every `@handle` / `@u/handle` candidate in authored text, in source
 * order and without overlap. Candidates carry normalized handles; whether a
 * candidate is actually rewritten is decided later by resolution.
 */
export function extractMentionCandidates(text: string): MentionCandidate[] {
	const candidates: MentionCandidate[] = [];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "@" || !hasQualifyingPredecessor(text, index)) {
			continue;
		}
		const candidate = candidateAt(text, index);
		if (!candidate) {
			continue;
		}
		candidates.push(candidate);
		index = candidate.end - 1;
	}
	return candidates;
}

/**
 * Normalized handles of references that are already canonical. These are
 * recognized for notification purposes only; they are already in stored form,
 * so there is nothing to rewrite.
 */
export function extractCanonicalMentionHandles(text: string): string[] {
	const handles: string[] = [];
	for (const match of text.matchAll(canonicalMentionPattern)) {
		// The captured token already matches the handle grammar; only NFKC
		// folding can still invalidate it, and that must not throw here.
		const handle = match[1] === undefined ? null : tryNormalizeHandleText(match[1]);
		if (handle !== null) {
			handles.push(handle);
		}
	}
	return handles;
}

/**
 * Replaces each resolved candidate's whole `@...` token with the canonical
 * `u/<stored handle>`. Unresolved candidates and every other code unit —
 * including the qualifying predecessor — are copied through byte for byte.
 */
export function rewriteMentions(
	text: string,
	candidates: readonly MentionCandidate[],
	resolved: ReadonlyMap<string, ResolvedMention>,
): string {
	let rewritten = "";
	let copiedThrough = 0;
	for (const candidate of candidates) {
		const participant = resolved.get(candidate.handle);
		if (!participant) {
			continue;
		}
		rewritten += text.slice(copiedThrough, candidate.start) + canonicalMentionText(participant.handle);
		copiedThrough = candidate.end;
	}
	return rewritten + text.slice(copiedThrough);
}

/**
 * Resolves distinct normalized handles to active, non-deleted participants of
 * one world. The `IN` list is chunked so `worldId` plus its handles always fit
 * inside D1's bound-parameter ceiling; no candidate is dropped to stay in
 * budget, because content hard limits already bound how many can exist.
 */
export async function resolveMentionHandles(
	db: D1DatabaseLike,
	worldId: string,
	handles: readonly string[],
): Promise<Map<string, ResolvedMention>> {
	const resolved = new Map<string, ResolvedMention>();
	for (const chunk of chunks(handles, mentionResolutionChunkSize)) {
		const placeholders = chunk.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT bot_id AS botId, handle
				 FROM bots_index
				 WHERE home_world_id = ?
				   AND handle IN (${placeholders})
				   AND deleted_at IS NULL
				   AND lifecycle_state = 'active'`,
			)
			.bind(worldId, ...chunk)
			.all<ResolvedMention>();
		for (const row of result.results ?? []) {
			resolved.set(row.handle, { botId: row.botId, handle: row.handle });
		}
	}
	return resolved;
}

function candidateAt(text: string, atIndex: number): MentionCandidate | null {
	// The `u/` prefix is matched as its own branch before the handle token, so
	// the bare branch can never see text that starts with it.
	const prefixed = hasCanonicalPrefix(text, atIndex + 1);
	const tokenStart = atIndex + 1 + (prefixed ? 2 : 0);
	const rawHandle = handleCharacterRunAt(text, tokenStart);
	if (rawHandle === null || !isHandleToken(rawHandle)) {
		return null;
	}
	const end = tokenStart + rawHandle.length;
	// A trailing `@` means the token was never a whole mention (`@alice@example`).
	// Handle characters cannot follow, because the run above was maximal.
	if (text[end] === "@") {
		return null;
	}
	// Compatibility expansion can push a valid authored token out of the handle
	// grammar (`@½`, or enough `ﬁ` ligatures to exceed 32 characters). Those
	// candidates simply stay as authored; they never reject the post.
	const handle = tryNormalizeHandleText(rawHandle);
	if (handle === null) {
		return null;
	}
	// `u` immediately before a slash is the canonical namespace prefix, not a
	// participant handle. Without this, a compatibility lookalike such as
	// `@ｕ/alice` or an `@u/` whose handle failed would be corrupted into
	// `u/u/alice` whenever a participant named `u` happens to exist.
	if (handle === "u" && isSlashEquivalent(text, end)) {
		return null;
	}
	return {
		form: prefixed ? "prefixed" : "bare",
		start: atIndex,
		end,
		rawHandle,
		handle,
	};
}

function hasQualifyingPredecessor(text: string, atIndex: number): boolean {
	if (atIndex === 0) {
		return true;
	}
	const predecessor = codePointBefore(text, atIndex);
	// `@` is itself Unicode punctuation, so it has to be excluded explicitly or
	// `@@alice` would match its second `@`. Comparing the NFKC form rejects the
	// compatibility variants (`＠@alice`, `﹫@alice`) on the same grounds.
	return mentionBoundaryPattern.test(predecessor) && predecessor.normalize("NFKC") !== "@";
}

function hasCanonicalPrefix(text: string, index: number): boolean {
	// ASCII only, case-insensitive: `@U/alice` is the prefix, `@ｕ/alice` is not.
	const letter = text[index];
	return (letter === "u" || letter === "U") && text[index + 1] === "/";
}

function handleCharacterRunAt(text: string, start: number): string | null {
	handleCharacterRunPattern.lastIndex = start;
	return handleCharacterRunPattern.exec(text)?.[0] ?? null;
}

function isSlashEquivalent(text: string, index: number): boolean {
	const character = codePointAt(text, index);
	return character !== null && character.normalize("NFKC") === "/";
}

function codePointAt(text: string, index: number): string | null {
	const codePoint = text.codePointAt(index);
	return codePoint === undefined ? null : String.fromCodePoint(codePoint);
}

function codePointBefore(text: string, index: number): string {
	const start = isLowSurrogate(text.charCodeAt(index - 1)) && isHighSurrogate(text.charCodeAt(index - 2)) ?
		index - 2
	:	index - 1;
	return text.slice(start, index);
}

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}
