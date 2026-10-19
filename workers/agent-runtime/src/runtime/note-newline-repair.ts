import type { ChatMessage } from '../types';

export type NoteNewlineRepair = { kind: 'unchanged' } | { kind: 'ambiguous' } |
	{ kind: 'repaired'; content: string; replacements: number };
export type NoteMessageRepair = { kind: 'unchanged' } | { kind: 'ambiguous' } |
	{ kind: 'repaired'; message: ChatMessage; replacements: number };

const listStart = /^ {0,3}(?:[-+*] |\d+[.)] )/;

/** A finite migration detector, not a write-time Markdown normalizer.
 * The operator boundary validates reviewed pairs as newline-only transformations. */
export function repairNoteNewlines(content: string, reviewedReplacements: ReadonlyMap<string, string> = new Map()): NoteNewlineRepair {
	const reviewed = reviewedReplacements.get(content);
	if (reviewed !== undefined) {
		let replacements = 0;
		for (let index = 0; index < content.length;) {
			if (content[index] !== '\\') { index++; continue; }
			let end = index;
			while (content[end] === '\\') end++;
			if (end === index + 1 && content[end] === 'n') replacements++;
			index = end + (content[end] === 'n' ? 1 : 0);
		}
		return { kind: 'repaired', content: reviewed, replacements };
	}
	const offsets: number[] = [];
	const indentedOriginal = new Set<number>();
	let originalBase = 0;
	for (const line of content.split('\n')) {
		if (/^(?: {4}| {0,3}\t)/.test(line)) {
			for (let index = originalBase; index < originalBase + line.length; index++) indentedOriginal.add(index);
		}
		originalBase += line.length + 1;
	}
	const protectedOffsets = new Set<number>();
	let decoded = '';
	// A run of two or more backslashes can be intentional nested JSON or code.
	for (let index = 0; index < content.length;) {
		if (content[index] !== '\\') {
			if (indentedOriginal.has(index)) protectedOffsets.add(decoded.length);
			decoded += content[index++];
			continue;
		}
		let end = index;
		while (content[end] === '\\') end++;
		if (end === index + 1 && content[end] === 'n') {
			if (indentedOriginal.has(index)) protectedOffsets.add(decoded.length);
			offsets.push(decoded.length);
			decoded += '\n';
			index = end + 1;
		} else {
			for (let position = index; position < end; position++) {
				if (indentedOriginal.has(position)) protectedOffsets.add(decoded.length + position - index);
			}
			decoded += content.slice(index, end);
			index = end;
		}
	}
	if (offsets.length === 0) return { kind: 'unchanged' };
	let fence: { character: string; width: number } | null = null;
	let inlineWidth = 0;
	let quoted: '"' | "'" | null = null;
	let base = 0;
	for (const line of decoded.split('\n')) {
		// Actual indented source lines stay protected across virtual newline fragments.
		if (protectedOffsets.has(base)) { base += line.length + 1; continue; }
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const wasFenced = fence !== null;
		if (fence) {
			if (fenceMatch && fenceMatch[1]![0] === fence.character && fenceMatch[1]!.length >= fence.width && fenceMatch[2]!.trim() === '') fence = null;
		} else if (inlineWidth === 0 && fenceMatch) {
			fence = { character: fenceMatch[1]![0]!, width: fenceMatch[1]!.length };
		}
		// Escaped fence line endings do not distinguish code syntax from examples.
		if (fenceMatch && offsets.includes(base + line.length)) return { kind: 'ambiguous' };
		if (wasFenced || fenceMatch && fence) {
			for (let index = base; index <= base + line.length; index++) protectedOffsets.add(index);
		} else {
			for (let index = 0; index < line.length;) {
				if ((line[index] === '"' || line[index] === "'") && inlineWidth === 0 && !escapedAt(line, index)) {
					const character = line[index] as '"' | "'";
					if (quoted === character) quoted = null;
					else if (quoted === null && (character === '"' || !/[\p{L}\p{N}]/u.test(line[index - 1] ?? ''))) quoted = character;
					index++;
				} else if (line[index] === '`' && !quoted) {
					let end = index;
					while (line[end] === '`') end++;
					const width = end - index;
					if (inlineWidth === 0) inlineWidth = width;
					else if (inlineWidth === width) inlineWidth = 0;
					index = end;
				} else {
					if (inlineWidth || quoted) protectedOffsets.add(base + index);
					index++;
				}
			}
			if (inlineWidth || quoted) protectedOffsets.add(base + line.length);
		}
		base += line.length + 1;
	}
	// An unmatched delimiter cannot establish which later escapes are prose.
	if (fence || inlineWidth || quoted) return { kind: 'ambiguous' };
	const safe = new Set(offsets.filter(offset => !protectedOffsets.has(offset)));
	const listBoundaries = [...safe].filter(offset => listStart.test(decoded.slice(offset + 1))).length;
	if (!listStart.test(decoded) || listBoundaries < 2) return { kind: 'ambiguous' };
	let repaired = '';
	let decodedOffset = 0;
	for (let index = 0; index < content.length;) {
		if (content[index] === '\\') {
			let end = index;
			while (content[end] === '\\') end++;
			if (end === index + 1 && content[end] === 'n') {
				repaired += safe.has(decodedOffset) ? '\n' : '\\n';
				decodedOffset++;
				index = end + 1;
				continue;
			}
			repaired += content.slice(index, end);
			decodedOffset += end - index;
			index = end;
		} else { repaired += content[index++]; decodedOffset++; }
	}
	return { kind: 'repaired', content: repaired, replacements: safe.size };
}

function escapedAt(line: string, index: number): boolean {
	let backslashes = 0;
	for (let previous = index - 1; previous >= 0 && line[previous] === '\\'; previous--) backslashes++;
	return backslashes % 2 === 1;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only note tool fields enter this adapter. Other history stays byte-for-byte intact. */
export function repairNoteMessage(message: ChatMessage, toolName?: string, reviewedReplacements: ReadonlyMap<string, string> = new Map()): NoteMessageRepair {
	let ambiguous = false;
	let replacements = 0;
	let next = message;
	if (message.role === 'assistant' && message.tool_calls) {
		const calls = message.tool_calls.map(call => {
			if (call.function.name !== 'write_note') return call;
			let args: unknown;
			try { args = JSON.parse(call.function.arguments); } catch { ambiguous = true; return call; }
			if (!record(args) || typeof args.content !== 'string' || typeof args.id !== 'string') return call;
			const result = repairNoteNewlines(args.content, reviewedReplacements);
			if (result.kind === 'ambiguous') ambiguous = true;
			if (result.kind !== 'repaired') return call;
			replacements += result.replacements;
			return { ...call, function: { ...call.function, arguments: JSON.stringify({ ...args, content: result.content }) } };
		});
		if (replacements) next = { ...message, tool_calls: calls };
	} else if (message.role === 'tool' && (toolName === 'read_note' || toolName === 'write_note') && typeof message.content === 'string') {
		let payload: unknown;
		try { payload = JSON.parse(message.content); } catch { return { kind: 'ambiguous' }; }
		if (!record(payload) || typeof payload.id !== 'string' || typeof payload.content !== 'string') return { kind: 'unchanged' };
		const result = repairNoteNewlines(payload.content, reviewedReplacements);
		if (result.kind !== 'repaired') return result;
		replacements = result.replacements;
		next = { ...message, content: JSON.stringify({ ...payload, content: result.content }) };
	}
	return replacements ? { kind: 'repaired', message: next, replacements } : { kind: ambiguous ? 'ambiguous' : 'unchanged' };
}
