import type { AgentLogReasoningPart } from '@bickr/shared/model';
import { describe, expect, it } from 'vitest';
import { reasoningDetailForStream, reasoningTextFromParts, StreamReasoningDetails } from './reasoning-stream';

describe('reasoning stream display boundary', () => {
	it.each(['reasoning.encrypted', 'future.type'])('hides every payload field of %s', type => {
		expect(reasoningDetailForStream({ type, index: 4, id: 'part', text: 'OPAQUE', summary: 'OPAQUE', data: 'OPAQUE', signature: 'OPAQUE' }))
			.toEqual({ kind: 'opaque', type, index: 4, id: 'part' });
	});
	it('keeps a readable text identity and omits unrelated fields', () => {
		expect(reasoningDetailForStream({ type: 'reasoning.text', index: 0, id: 'part', text: 'Readable', data: 'PRIVATE' }))
			.toEqual({ kind: 'readable', type: 'reasoning.text', index: 0, id: 'part', text: 'Readable' });
	});
	it('reads summary arrays through explicit text fields', () => {
		expect(reasoningDetailForStream({ type: 'reasoning.summary', summary: ['A ', { text: 'summary', data: 'PRIVATE' }, { summary: '.' }, { data: 'PRIVATE' }] }))
			.toEqual({ kind: 'readable', type: 'reasoning.summary', text: 'A summary.' });
	});
	it.each([null, 'OPAQUE', { text: 'OPAQUE' }])('contains an item without a provider type', value => {
		expect(reasoningDetailForStream(value)).toEqual({ kind: 'opaque', type: null });
	});
});

const plain = (text: string): AgentLogReasoningPart => ({ kind: 'text', text });
const summary = (text: string, index?: number): AgentLogReasoningPart => ({ kind: 'readable', type: 'reasoning.summary', text, ...(index === undefined ? {} : { index }) });
const opaque: AgentLogReasoningPart = { kind: 'opaque', type: 'reasoning.encrypted', index: 1 };

it.each([
	{ name: 'whole plain run before a fragmented detail', parts: [plain('Sum'), plain('mary.'), summary('Sum', 0), summary('mary.', 0)], expected: 'Summary.' },
	{ name: 'whole plain run after a fragmented detail', parts: [summary('Sum', 0), summary('mary.', 0), plain('Sum'), plain('mary.')], expected: 'Summary.' },
	{ name: 'matching deltas interleaved in arrival order', parts: [plain('Sum'), summary('Sum', 0), plain('mary.'), summary('mary.', 0)], expected: 'Summary.' },
	{ name: 'anonymous consecutive detail chunks', parts: [plain('AB'), summary('A'), summary('B')], expected: 'AB' },
	{ name: 'one detail can mirror only one plain run', parts: [plain('A'), summary('A', 0), plain('A')], expected: 'A\n\nA' },
	{ name: 'an opaque barrier keeps a separate plain run', parts: [plain('A'), opaque, summary('A', 0)], expected: 'A\n\nA' },
	{ name: 'different identities keep separate runs', parts: [plain('AB'), summary('A', 0), summary('B', 1)], expected: 'AB\n\nA\n\nB' },
	{ name: 'whitespace differences are not mirrors', parts: [plain('A '), summary('A', 0)], expected: 'A \n\nA' },
	{ name: 'partial text matches are not mirrors', parts: [plain('Summary.'), summary('Summary', 0)], expected: 'Summary.\n\nSummary' },
	{ name: 'non-adjacent repetition stays', parts: [plain('A'), summary('B', 0), summary('A', 1)], expected: 'A\n\nB\n\nA' },
	{ name: 'detail repetition stays', parts: [summary('A', 0), summary('A', 0)], expected: 'AA' },
])('uses the live mirror rule: $name', ({ parts, expected }) => {
	expect(reasoningTextFromParts(parts)).toBe(expected);
});

it('keeps the same barriers as live partials when an opaque marker repeats', () => {
	const stream = new StreamReasoningDetails();
	stream.append([{ type: 'reasoning.encrypted', index: 1, data: 'OPAQUE' }]);
	stream.appendPlain('Summary.');
	stream.append([{ type: 'reasoning.encrypted', index: 1, data: 'OPAQUE_MORE' }]);
	stream.append([{ type: 'reasoning.summary', index: 0, summary: 'Summary.' }]);
	expect(stream.readableText()).toBe('Summary.');
	expect(stream.finish(value => value as Record<string, unknown>[])).toEqual([
		{ type: 'reasoning.encrypted', index: 1, data: 'OPAQUE' },
		{ type: 'reasoning.encrypted', index: 1, data: 'OPAQUE_MORE' },
		{ type: 'reasoning.summary', index: 0, summary: 'Summary.' },
	]);
});

it('joins many mirrored deltas once at settlement', () => {
	const stream = new StreamReasoningDetails();
	for (let index = 0; index < 2000; index++) {
		stream.appendPlain('Chunk.');
		stream.append([{ type: 'reasoning.text', index: 0, text: 'Chunk.' }]);
	}
	expect(stream.readableText()).toBe('Chunk.'.repeat(2000));
});
