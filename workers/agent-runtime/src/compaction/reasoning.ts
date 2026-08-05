import type { CompactionReasoningFloor } from '@bickr/shared/openrouter-model-capabilities';

export type FrozenCompactionReasoningFallbackResolution =
	| { kind: 'absent' }
	| { kind: 'matched'; learnedFloor: CompactionReasoningFloor }
	| { kind: 'unrecognized' }
	| { kind: 'stale' };

export function compactionReasoningLearnedFloorFromFrozenState(
	stored: Record<string, unknown> | undefined,
	model: string,
): FrozenCompactionReasoningFallbackResolution {
	if (!stored) {
		return { kind: 'absent' };
	}
	// "minimal" is a frozen on-disk discriminator whose historical meaning is
	// literal. It must not follow a model's changing metadata default, and the
	// persisted record stays untouched until its model no longer matches.
	if (stored.model === model && stored.mode === 'minimal') {
		return {
			kind: 'matched',
			learnedFloor: { kind: 'explicit_effort', effort: 'minimal' },
		};
	}
	// Only an explicit different model proves that the frozen record is stale.
	// Preserve same-model and malformed records byte-for-byte; repairing or
	// deleting unrecognized persisted state on read would hide its writer bug.
	return typeof stored.model === 'string' && stored.model !== model
		? { kind: 'stale' }
		: { kind: 'unrecognized' };
}
