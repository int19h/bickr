import { describe, expect, it } from 'vitest';
import type { AgentLogReasoningPart } from './model';
import { orderedReasoningForDisplay, reasoningPartsForDisplay } from './reasoning-formatting';

const plain = (text: string): AgentLogReasoningPart => ({ kind: 'text', text });
const detail = (text: string, index = 0): AgentLogReasoningPart => ({ kind: 'readable', type: 'reasoning.summary', index, text });

describe('shared reasoning runs', () => {
	it.each([
		{ parts: [plain('Think'), detail('Summary')], expected: 'Think\n\nSummary' },
		{ parts: [detail('A'), plain('B'), detail('B')], expected: 'AB' },
		{ parts: [detail('A'), plain('B'), detail('B', 1)], expected: 'A\n\nB' },
		{ parts: [detail('A'), { kind: 'opaque', type: 'reasoning.encrypted' }, detail('B')], expected: 'A\n\nB' },
		{ parts: [plain('A'), detail(''), plain('B')], expected: 'A\n\nB' },
	] satisfies Array<{ parts: AgentLogReasoningPart[]; expected: string }>)('preserves identities around removed mirrors: $expected', ({ parts, expected }) => {
		expect(reasoningPartsForDisplay(parts).text).toBe(expected);
	});

	it('keeps the display normalization separate from provider replay', () => {
		const text = 'A\r\nB\r\nC\r\nD\r\nE\r\nF';
		expect(reasoningPartsForDisplay([plain(text)]).text).toBe('ABCDEF');
		expect(reasoningPartsForDisplay([plain(text)], text => text).text).toBe(text);
	});

	it('retains opaque counts and readable labels', () => {
		expect(orderedReasoningForDisplay([
			{ kind: 'plain', text: 'A', identity: 'plain' },
			{ kind: 'summary', text: 'A', identity: 'summary' },
			{ kind: 'encrypted' }, { kind: 'unknown' },
		])).toEqual({ text: 'A', hasText: false, hasSummary: true, encryptedParts: 1, opaqueParts: 2 });
	});
});
