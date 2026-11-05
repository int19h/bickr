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
