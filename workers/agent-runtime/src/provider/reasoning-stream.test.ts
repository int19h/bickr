import { describe, expect, it } from 'vitest';
import { reasoningDetailForStream } from './reasoning-stream';

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
