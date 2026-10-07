export type TranscriptHeader = { readonly label: string; readonly language: string };

/** Compare display labels without changing the participant's stored prose. */
export function transcriptHeaderMatcher(headers: readonly TranscriptHeader[]): (line: string) => boolean {
	const labels = headers.map(({ label, language }) => {
		const normalized = label.normalize('NFC');
		return { length: normalized.length, folded: normalized.toLocaleLowerCase(language), language };
	});
	return (line) => {
		const normalized = line.normalize('NFC');
		return labels.some(({ length, folded, language }) =>
			normalized.slice(0, length).toLocaleLowerCase(language) === folded
			&& /^[ \u00a0\u202f]{0,2}[:：]/u.test(normalized.slice(length, length + 4)),
		);
	};
}
