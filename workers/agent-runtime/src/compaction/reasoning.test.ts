import { describe, expect, it } from 'vitest';
import { compactionReasoningLearnedFloorFromFrozenState } from './reasoning';

describe('frozen compaction reasoning fallback state', () => {
	it('decodes the historical minimal mode as a literal explicit minimal floor', () => {
		expect(compactionReasoningLearnedFloorFromFrozenState({
			model: 'local/model',
			mode: 'minimal',
			reason: 'provider rejected none',
			updatedAt: '2026-08-04T00:00:00.000Z',
		}, 'local/model')).toEqual({
			kind: 'matched',
			learnedFloor: { kind: 'explicit_effort', effort: 'minimal' },
		});
	});

	it('distinguishes absent state from a stale model without normalizing the stored shape', () => {
		expect(compactionReasoningLearnedFloorFromFrozenState(undefined, 'local/model')).toEqual({ kind: 'absent' });
		expect(compactionReasoningLearnedFloorFromFrozenState({
			model: 'old/model',
			mode: 'minimal',
		}, 'new/model')).toEqual({ kind: 'stale' });
		expect(compactionReasoningLearnedFloorFromFrozenState({
			model: 'local/model',
			mode: 'model_default',
		}, 'local/model')).toEqual({ kind: 'stale' });
	});
});
