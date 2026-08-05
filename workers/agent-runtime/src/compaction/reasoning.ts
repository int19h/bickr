import type { CompactionReasoningFloor } from '@bickr/shared/openrouter-model-capabilities';

export type FrozenCompactionReasoningFallbackResolution =
	| { kind: 'absent' }
	| { kind: 'matched'; learnedFloor: CompactionReasoningFloor }
	| { kind: 'not_applicable' }
	| { kind: 'unrecognized' }
	| { kind: 'stale' };

export type CompactionReasoningProviderClass = 'custom' | 'openrouter';

export function compactionReasoningLearnedFloorFromFrozenState(
	stored: Record<string, unknown> | undefined,
	model: string,
	providerClass: CompactionReasoningProviderClass,
): FrozenCompactionReasoningFallbackResolution {
	if (!stored) {
		return { kind: 'absent' };
	}
	if (typeof stored.model === 'string' && stored.model !== model) {
		return { kind: 'stale' };
	}
	// "minimal" is a frozen on-disk discriminator whose historical meaning is
	// literal. It must not follow a model's changing metadata default, and the
	// persisted record stays untouched until its model no longer matches.
	if (stored.model === model && stored.mode === 'minimal') {
		// This record can only be learned by the custom-provider fallback. The
		// frozen shape has no provider identity, so retain it but never import its
		// lower bound across the OpenRouter boundary.
		if (providerClass === 'openrouter') {
			return { kind: 'not_applicable' };
		}
		return {
			kind: 'matched',
			learnedFloor: { kind: 'explicit_effort', effort: 'minimal' },
		};
	}
	// Only an explicit different model proves that the frozen record is stale.
	// Preserve same-model and malformed records byte-for-byte; repairing or
	// deleting unrecognized persisted state on read would hide its writer bug.
	return { kind: 'unrecognized' };
}
