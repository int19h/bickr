import { describe, expect, it } from 'vitest';
import { compactionReasoningLearnedFloorFromFrozenState } from './reasoning';

describe('frozen compaction reasoning fallback state', () => {
	it('decodes the historical minimal mode as a literal explicit minimal floor', () => {
		expect(compactionReasoningLearnedFloorFromFrozenState({
			model: 'local/model',
			mode: 'minimal',
			reason: 'provider rejected none',
			updatedAt: '2026-08-04T00:00:00.000Z',
		}, 'local/model', 'custom')).toEqual({
			kind: 'matched',
			learnedFloor: { kind: 'explicit_effort', effort: 'minimal' },
		});
	});

	it('retains but ignores a matching custom-provider floor on OpenRouter', () => {
		expect(compactionReasoningLearnedFloorFromFrozenState({
			model: 'openai/gpt-4o',
			mode: 'minimal',
			reason: 'provider rejected none',
			updatedAt: '2026-08-04T00:00:00.000Z',
		}, 'openai/gpt-4o', 'openrouter')).toEqual({ kind: 'not_applicable' });
	});

	it('marks only a record for a different model as stale', () => {
		expect(compactionReasoningLearnedFloorFromFrozenState(undefined, 'local/model', 'custom')).toEqual({ kind: 'absent' });
		expect(compactionReasoningLearnedFloorFromFrozenState({
			model: 'old/model',
			mode: 'minimal',
		}, 'new/model', 'openrouter')).toEqual({ kind: 'stale' });
		expect(compactionReasoningLearnedFloorFromFrozenState({
			model: 'local/model',
			mode: 'model_default',
		}, 'local/model', 'custom')).toEqual({ kind: 'unrecognized' });
		expect(compactionReasoningLearnedFloorFromFrozenState({
			mode: 'minimal',
		}, 'local/model', 'openrouter')).toEqual({ kind: 'unrecognized' });
	});
});
