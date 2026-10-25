import { expect, it } from 'vitest';
import type { AgentLogStreamDelta } from '@bickr/shared/model';
import { appendAgentLogDelta, emptyAgentLogPartial, parseAgentLogPartial } from './agent-log-partial';
import { reasoningPartsForDisplay } from './reasoning-formatting';

it('keeps interleaved streams in arrival order and uses the index before the ID', () => {
	const deltas: AgentLogStreamDelta[] = [
		{ kind: 'reasoning', source: 'detail', part: { kind: 'readable', type: 'reasoning.text', index: 0, id: 'first', text: 'First' }, text: 'First' },
		{ kind: 'reasoning', source: 'detail', part: { kind: 'readable', type: 'reasoning.text', index: 0, id: 'renamed', text: ' thought.' }, text: ' thought.' },
		{ kind: 'reasoning', source: 'plain', text: 'Plain between.' },
		{ kind: 'reasoning', source: 'detail', part: { kind: 'readable', type: 'reasoning.text', index: 0, text: 'Last thought.' }, text: 'Last thought.' },
		{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'reasoning.encrypted', index: 1, id: 'secret' } },
		{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'reasoning.encrypted', index: 1, id: 'renamed-secret' } },
		{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'future.type' } },
		{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'future.type' } },
	];
	const partial = deltas.reduce(appendAgentLogDelta, emptyAgentLogPartial());
	expect(partial.reasoningParts).toHaveLength(6);
	expect(partial.reasoningParts[0]).toMatchObject({ id: 'renamed', text: 'First thought.' });
	expect(reasoningPartsForDisplay(partial.reasoningParts)).toMatchObject({ text: 'First thought.\n\nPlain between.\n\nLast thought.', opaqueParts: 3, encryptedParts: 1 });
	expect(parseAgentLogPartial(JSON.stringify(partial))).toEqual(partial);
});
it('joins adjacent unindexed fragments only within the same stream', () => {
	expect(reasoningPartsForDisplay([
		{ kind: 'readable', type: 'reasoning.summary', id: 'one', text: 'Look' },
		{ kind: 'readable', type: 'reasoning.summary', id: 'one', text: 'ing.' },
		{ kind: 'readable', type: 'reasoning.summary', id: 'two', text: 'Separate.' },
		{ kind: 'readable', type: 'reasoning.summary', text: 'Default' },
		{ kind: 'readable', type: 'reasoning.summary', text: ' stream.' },
	]).text).toBe('Looking.\n\nSeparate.\n\nDefault stream.');
});
it('does not trust compatibility text or unknown detail payloads in a stored partial', () => {
	const partial = parseAgentLogPartial(JSON.stringify({ content: 'Reply', reasoning: 'PRIVATE_COMPATIBILITY', reasoningParts: [
		{ kind: 'readable', type: 'reasoning.summary', text: 'Visible summary.' },
		{ kind: 'readable', type: 'future.type', text: 'PRIVATE_TEXT', data: 'PRIVATE_DATA', id: 'future' },
		{ kind: 'opaque', type: 'reasoning.encrypted', text: 'PRIVATE_TEXT', data: 'PRIVATE_DATA' },
	] }));
	expect(JSON.stringify(partial)).not.toContain('PRIVATE');
	expect(reasoningPartsForDisplay(partial.reasoningParts)).toMatchObject({ text: 'Visible summary.', opaqueParts: 2 });
	expect(parseAgentLogPartial('{"reasoning":"PRIVATE_LEGACY"}').reasoningParts).toEqual([{ kind: 'opaque', type: null }]);
});


it('renders plain reasoning when no detail source exists', () => {
	expect(reasoningPartsForDisplay([{ kind: 'text', text: 'Plain' }, { kind: 'text', text: ' only.' }]).text).toBe('Plain only.');
});

it('keeps plain text when details are opaque or contain different readable text', () => {
	expect(reasoningPartsForDisplay([
		{ kind: 'text', text: 'Readable plain thought.' },
		{ kind: 'opaque', type: 'reasoning.encrypted' },
	]).text).toBe('Readable plain thought.');
	expect(reasoningPartsForDisplay([
		{ kind: 'text', text: 'Readable plain thought.' },
		{ kind: 'readable', type: 'reasoning.summary', text: 'A different summary.' },
	]).text).toBe('Readable plain thought.\n\nA different summary.');
});
it('removes only a confirmed adjacent repeat and keeps the remaining plain runs', () => {
	expect(reasoningPartsForDisplay([
		{ kind: 'text', text: 'A unique plain thought.' },
		{ kind: 'opaque', type: 'future.type' },
		{ kind: 'text', text: 'Repeated thought.' },
		{ kind: 'readable', type: 'reasoning.summary', text: 'Repeated ' },
		{ kind: 'readable', type: 'reasoning.summary', text: 'thought.' },
		{ kind: 'text', text: 'Another unique thought.' },
	]).text).toBe('A unique plain thought.\n\nRepeated thought.\n\nAnother unique thought.');
});
