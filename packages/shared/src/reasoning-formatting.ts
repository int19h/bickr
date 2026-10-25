import { agentLogReasoningDetailKey, type AgentLogReasoningPart } from './model';

export type OrderedReasoningPart =
	| { kind: 'plain' | 'text' | 'summary'; text: string; identity: string }
	| { kind: 'encrypted' | 'unknown' };

function joinConsecutiveParts(parts: readonly OrderedReasoningPart[]): OrderedReasoningPart[] {
	const joined: OrderedReasoningPart[] = [];
	let chunks: string[] = [];
	const flush = () => {
		const last = joined.at(-1);
		if (last && 'text' in last) last.text = chunks.join('');
		chunks = [];
	};
	for (const part of parts) {
		const last = joined.at(-1);
		if ('text' in part && last && 'text' in last && part.identity === last.identity) chunks.push(part.text);
		else {
			flush();
			joined.push('text' in part ? { kind: part.kind, text: '', identity: part.identity } : { kind: part.kind });
			if ('text' in part) chunks.push(part.text);
		}
	}
	flush();
	return joined;
}

/** Keep complete adjacent mirrors once, then separate distinct readable runs. */
export function orderedReasoningForDisplay(input: readonly OrderedReasoningPart[], textForDisplay: (text: string) => string = normalizeReadableText) {
	const consecutive = joinConsecutiveParts(input);
	const repeatedDetails = new Set<number>();
	const unique = consecutive.filter((part, index) => {
		if (part.kind !== 'plain' || !part.text) return true;
		// Prefer the following detail, and pair each detail with at most one plain run.
		for (const adjacent of [index + 1, index - 1]) {
			const detail = consecutive[adjacent];
			if (detail && (detail.kind === 'text' || detail.kind === 'summary') && detail.text === part.text && !repeatedDetails.has(adjacent)) {
				repeatedDetails.add(adjacent);
				return false;
			}
		}
		return true;
	});
	// Mirror removal can make runs with the same identity adjacent.
	const parts = joinConsecutiveParts(unique);
	return {
		text: parts.flatMap(part => 'text' in part && part.text ? [textForDisplay(part.text)] : []).join('\n\n'),
		hasText: parts.some(part => (part.kind === 'plain' || part.kind === 'text') && part.text.length > 0),
		hasSummary: parts.some(part => part.kind === 'summary' && part.text.length > 0),
		encryptedParts: parts.filter(part => part.kind === 'encrypted').length,
		opaqueParts: parts.filter(part => part.kind === 'encrypted' || part.kind === 'unknown').length,
	};
}

/** The runtime and the live view use the same typed parts and run identities. */
export function reasoningPartsForDisplay(values: readonly AgentLogReasoningPart[], textForDisplay: (text: string) => string = normalizeReadableText) {
	return orderedReasoningForDisplay(values.map((part): OrderedReasoningPart => {
		switch (part.kind) {
			case 'text': return { kind: 'plain', text: part.text, identity: 'plain' };
			case 'readable': return {
				kind: part.type === 'reasoning.text' ? 'text' : 'summary', text: part.text,
				identity: agentLogReasoningDetailKey(part) ?? JSON.stringify([part.type, 'default']),
			};
			case 'opaque': return { kind: part.type === 'reasoning.encrypted' ? 'encrypted' : 'unknown' };
		}
	}), textForDisplay);
}

export function normalizeReadableText(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	return normalized
		.split(/(\n{2,})/)
		.map((part) => part.startsWith("\n") ? part : collapseTinyLineRun(part))
		.join("");
}

function collapseTinyLineRun(text: string): string {
	const lines = text.split("\n");
	const meaningful = lines.filter((line) => line.trim().length > 0);
	if (meaningful.length < 6) {
		return text;
	}
	const lengths = meaningful.map((line) => Array.from(line.trim()).length);
	const shortCount = lengths.filter((length) => length <= 6).length;
	const veryShortCount = lengths.filter((length) => length <= 3).length;
	const averageLength = lengths.reduce((total, length) => total + length, 0) / lengths.length;
	const mostlyTiny =
		shortCount / lengths.length >= 0.75 &&
		veryShortCount >= 4 &&
		averageLength <= 6;
	const heavilyFragmented =
		meaningful.length >= 10 &&
		shortCount / lengths.length >= 0.6 &&
		averageLength <= 8;
	return mostlyTiny || heavilyFragmented ? lines.join("") : text;
}

