import type { RandomRangeTarget } from '@bickr/shared/tool-results';
import { maxBulkToolTargets } from '../constants';
import { ToolCallArgumentValidationError } from '../errors';

export type { RandomRangeTarget };

/**
 * Fills `count` 64-bit words with cryptographically strong randomness. It is a
 * parameter so tests can drive exact draws, including one that lands in the
 * rejection region; production always uses {@link cryptoRandomWords}.
 */
export type RandomWordSource = (count: number) => BigUint64Array;

const wordBits = 64n;
const wordSpace = 1n << wordBits;

export function cryptoRandomWords(count: number): BigUint64Array {
	const words = new BigUint64Array(count);
	crypto.getRandomValues(words);
	return words;
}

/**
 * Draws one uniformly distributed integer per range, in range order.
 *
 * Every range is validated before any draw happens, so a call either produces a
 * full result or fails without having consumed randomness.
 *
 * Uniformity comes from rejection sampling on 64-bit draws: with span `s` and
 * `limit = 2^64 - (2^64 % s)`, a draw at or above `limit` is discarded and
 * redrawn, so every residue occurs exactly `limit / s` times across the accepted
 * interval. Plain `draw % s` would be biased whenever `s` does not divide 2^64 —
 * a d6 would come back measurably loaded, which is the one thing this control
 * exists to avoid. Rejected draws are redrawn without an attempt cap: the
 * acceptance probability is at least 1/2 per draw for any valid span, so the loop
 * terminates with probability 1 and a cap would only turn a vanishingly rare
 * retry into a participant-visible failure.
 *
 * All arithmetic is BigInt from the start. There is exactly one conversion back
 * to `number`, on the final in-range value, and it is exact by construction:
 * both endpoints are safe integers, so every integer between them is exactly
 * representable — including spans wider than 2^53, such as
 * [-(2^53 - 1), 2^53 - 1].
 */
export function randomIntegersForRanges(
	ranges: readonly RandomRangeTarget[],
	source: RandomWordSource = cryptoRandomWords,
): number[] {
	validateRandomRanges(ranges);
	return ranges.map((range) => randomIntegerForRange(range, source));
}

export function validateRandomRanges(ranges: readonly RandomRangeTarget[]): void {
	if (ranges.length === 0) {
		throw new ToolCallArgumentValidationError('bad_request', 'ranges must include at least one range.');
	}
	if (ranges.length > maxBulkToolTargets) {
		throw new ToolCallArgumentValidationError('bad_request', `ranges can include at most ${maxBulkToolTargets} ranges.`);
	}
	for (const [index, range] of ranges.entries()) {
		assertSafeEndpoint(range.min, `ranges[${index}].min`);
		assertSafeEndpoint(range.max, `ranges[${index}].max`);
		if (range.max < range.min) {
			throw new ToolCallArgumentValidationError(
				'bad_request',
				`ranges[${index}].max must be greater than or equal to ranges[${index}].min.`,
			);
		}
	}
}

function assertSafeEndpoint(value: number, label: string): void {
	if (!Number.isSafeInteger(value)) {
		throw new ToolCallArgumentValidationError(
			'bad_request',
			`${label} must be a whole number between ${-Number.MAX_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}.`,
		);
	}
}

function randomIntegerForRange(range: RandomRangeTarget, source: RandomWordSource): number {
	const min = BigInt(range.min);
	const span = BigInt(range.max) - min + 1n;
	// A single-value range needs no special case: its limit is the whole word
	// space, so the draw is always accepted and its residue is always zero. Every
	// range therefore consumes exactly one accepted draw.
	const limit = wordSpace - (wordSpace % span);
	for (;;) {
		const draw = nextWord(source);
		if (draw < limit) {
			return Number(min + (draw % span));
		}
	}
}

function nextWord(source: RandomWordSource): bigint {
	const words = source(1);
	// The source contract is exactly one word per requested word; a source that
	// returns anything else would silently change which draw is consumed.
	if (words.length !== 1) {
		throw new Error(`Random word source returned ${words.length} words for a request of 1.`);
	}
	return words[0];
}
