import { decodeString } from 'micromark-util-decode-string';
export type SourceUnit = { start: number; end: number };
/** UTF-16 indices match both Markdown positions and browser text offsets. */
export function sourceTextUnits(raw: string, value: string, literal = false): SourceUnit[] | null {
	const units: SourceUnit[] = [];
	let offset = 0;
	const rawLines = raw.split(/\r\n|\r|\n/);
	const valueLines = value.split(/\r\n|\r|\n/);
	let valueOffset = 0;
	if (rawLines.length !== valueLines.length) return null;
	for (let line = 0; line < rawLines.length; line++) {
		const spelling = rawLines[line]!;
		const decoded: string[] = [];
		const positions: SourceUnit[] = [];
		for (let i = 0; i < spelling.length; ) {
			const token = literal
				? spelling[i]!
				: (spelling.slice(i).match(/^\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|^&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);/)?.[0] ??
					spelling[i]!);
			const text = literal ? token : decodeString(token);
			decoded.push(text);
			for (let n = 0; n < text.length; n++) positions.push({ start: offset + i, end: offset + i + token.length });
			i += token.length;
		}
		const text = decoded.join('');
		const wanted = valueLines[line]!;
		// Markdown removes container prefixes from continuation lines. Match the
		// actual text suffix, rather than confusing quote/list markers with text.
		if (!text.endsWith(wanted)) return null;
		units.push(...positions.slice(text.length - wanted.length));
		offset += spelling.length;
		valueOffset += wanted.length;
		if (line < rawLines.length - 1) {
			const width = raw.slice(offset, offset + 2) === '\r\n' ? 2 : 1;
			const valueWidth = value.slice(valueOffset, valueOffset + 2) === '\r\n' ? 2 : 1;
			for (let n = 0; n < valueWidth; n++) units.push({ start: offset, end: offset + width });
			valueOffset += valueWidth;
			offset += width;
		}
	}
	return units;
}
