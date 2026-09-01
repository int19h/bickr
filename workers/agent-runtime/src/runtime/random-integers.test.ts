import { describe, expect, it } from 'vitest';
import { ToolCallArgumentValidationError } from '../errors';
import { randomIntegersForRanges, type RandomRangeTarget, type RandomWordSource } from './random-integers';

const wordSpace = 1n << 64n;
const maxSafe = Number.MAX_SAFE_INTEGER;

/**
 * Feeds exactly the given 64-bit draws, in order, and fails if more are asked
 * for. `consumed()` is what makes an under-consuming generator visible: a test
 * that only checks the returned value cannot tell a redraw from a first draw
 * that happened to land on the same residue.
 */
type ScriptedSource = RandomWordSource & { consumed(): number };

function scriptedSource(draws: readonly bigint[]): ScriptedSource {
	let index = 0;
	const source = ((count: number) => {
		const words = new BigUint64Array(count);
		for (let offset = 0; offset < count; offset += 1) {
			const draw = draws[index];
			if (draw === undefined) {
				throw new Error(`The generator asked for draw ${index + 1}, but only ${draws.length} were scripted.`);
			}
			words[offset] = draw;
			index += 1;
		}
		return words;
	}) as ScriptedSource;
	source.consumed = () => index;
	return source;
}

function acceptanceLimit(span: bigint): bigint {
	return wordSpace - (wordSpace % span);
}

describe('random integer generator', () => {
	it('keeps every drawn number inside its own range', () => {
		const ranges: RandomRangeTarget[] = [
			{ min: 1, max: 6 },
			{ min: 0, max: 1 },
			{ min: -10, max: -5 },
			{ min: 100, max: 100 },
		];

		for (let attempt = 0; attempt < 200; attempt += 1) {
			const numbers = randomIntegersForRanges(ranges);
			expect(numbers).toHaveLength(ranges.length);
			for (const [index, value] of numbers.entries()) {
				const range = ranges[index]!;
				expect(Number.isSafeInteger(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(range.min);
				expect(value).toBeLessThanOrEqual(range.max);
			}
		}
	});

	it('returns one number per range, in range order, consuming one accepted draw each', () => {
		const source = scriptedSource([0n, 4n, 2n]);

		const numbers = randomIntegersForRanges([{ min: 1, max: 6 }, { min: 10, max: 19 }, { min: -3, max: -1 }], source);

		expect(numbers).toEqual([1, 14, -1]);
		expect(source.consumed()).toBe(3);
	});

	it('returns the single value of a fixed range without a special case', () => {
		const source = scriptedSource([12345n]);

		expect(randomIntegersForRanges([{ min: 7, max: 7 }], source)).toEqual([7]);
		// Still exactly one draw: the fixed range goes through the same path.
		expect(source.consumed()).toBe(1);
		expect(randomIntegersForRanges([{ min: -7, max: -7 }], scriptedSource([0n]))).toEqual([-7]);
	});

	it('maps mixed-sign ranges across zero', () => {
		expect(randomIntegersForRanges([{ min: -2, max: 2 }], scriptedSource([0n]))).toEqual([-2]);
		expect(randomIntegersForRanges([{ min: -2, max: 2 }], scriptedSource([4n]))).toEqual([2]);
		expect(randomIntegersForRanges([{ min: -2, max: 2 }], scriptedSource([7n]))).toEqual([0]);
	});

	it('redraws a value that falls in the rejection region instead of folding it back', () => {
		const limit = acceptanceLimit(6n);
		// The scripted draws deliberately have different residues: limit % 6n is 0,
		// so folding the rejected draw back with a plain modulo would answer 1,
		// while the accepted redraw must answer 2. An implementation that dropped
		// the rejection step therefore fails on the value, not just on the count.
		const source = scriptedSource([limit, limit + 3n, 1n]);

		expect(randomIntegersForRanges([{ min: 1, max: 6 }], source)).toEqual([2]);
		expect(source.consumed()).toBe(3);
	});

	it('accepts the last draw below the limit and rejects the limit itself', () => {
		const limit = acceptanceLimit(6n);
		const accepted = scriptedSource([limit - 1n]);
		const rejected = scriptedSource([limit, 1n]);

		// limit - 1 is the largest accepted draw; rejecting it would exhaust the
		// script instead of answering.
		expect(randomIntegersForRanges([{ min: 1, max: 6 }], accepted)).toEqual([6]);
		expect(accepted.consumed()).toBe(1);
		// limit itself must be rejected: a `draw <= limit` comparison would accept
		// it and answer 1 instead of the redraw's 2.
		expect(randomIntegersForRanges([{ min: 1, max: 6 }], rejected)).toEqual([2]);
		expect(rejected.consumed()).toBe(2);
	});

	it('maps the extremes of the accepted interval to the ends of the span', () => {
		expect(randomIntegersForRanges([{ min: 1, max: 6 }], scriptedSource([0n]))).toEqual([1]);
		expect(randomIntegersForRanges([{ min: 1, max: 6 }], scriptedSource([acceptanceLimit(6n) - 1n]))).toEqual([6]);
	});

	it('stays exact for a 2^53 span', () => {
		const span = 1n << 53n;
		const range: RandomRangeTarget = { min: 0, max: maxSafe };

		expect(randomIntegersForRanges([range], scriptedSource([span - 1n]))).toEqual([maxSafe]);
		expect(randomIntegersForRanges([range], scriptedSource([span]))).toEqual([0]);
	});

	it('stays exact across the full safe-integer range', () => {
		const range: RandomRangeTarget = { min: -maxSafe, max: maxSafe };
		const span = BigInt(maxSafe) * 2n + 1n;

		expect(randomIntegersForRanges([range], scriptedSource([0n]))).toEqual([-maxSafe]);
		expect(randomIntegersForRanges([range], scriptedSource([span - 1n]))).toEqual([maxSafe]);
		expect(randomIntegersForRanges([range], scriptedSource([BigInt(maxSafe)]))).toEqual([0]);
	});

	it('rejects a source that does not fill exactly the requested words', () => {
		expect(() => randomIntegersForRanges([{ min: 1, max: 6 }], () => new BigUint64Array(2)))
			.toThrow('Random word source returned 2 words for a request of 1.');
		expect(() => randomIntegersForRanges([{ min: 1, max: 6 }], () => new BigUint64Array(0)))
			.toThrow('Random word source returned 0 words for a request of 1.');
	});
});

describe('random range validation', () => {
	const invalid: Array<{ label: string; ranges: RandomRangeTarget[]; message: string }> = [
		{ label: 'no ranges', ranges: [], message: 'ranges must include at least one range.' },
		{
			label: 'more ranges than the bulk cap',
			ranges: Array.from({ length: 33 }, () => ({ min: 1, max: 6 })),
			message: 'ranges can include at most 32 ranges.',
		},
		{
			label: 'max below min',
			ranges: [{ min: 1, max: 6 }, { min: 6, max: 1 }],
			message: 'ranges[1].max must be greater than or equal to ranges[1].min.',
		},
		{
			label: 'a fractional endpoint',
			ranges: [{ min: 1.5, max: 6 }],
			message: `ranges[0].min must be a whole number between ${-maxSafe} and ${maxSafe}.`,
		},
		{
			label: 'an endpoint past the safe-integer boundary',
			ranges: [{ min: 0, max: maxSafe + 1 }],
			message: `ranges[0].max must be a whole number between ${-maxSafe} and ${maxSafe}.`,
		},
		{
			label: 'a non-finite endpoint',
			ranges: [{ min: 0, max: Number.POSITIVE_INFINITY }],
			message: `ranges[0].max must be a whole number between ${-maxSafe} and ${maxSafe}.`,
		},
	];

	it.each(invalid)('rejects $label as a typed argument failure', ({ ranges, message }) => {
		const thrown = (() => {
			try {
				randomIntegersForRanges(ranges, scriptedSource([]));
				return null;
			} catch (error) {
				return error;
			}
		})();

		expect(thrown).toBeInstanceOf(ToolCallArgumentValidationError);
		expect((thrown as ToolCallArgumentValidationError).code).toBe('bad_request');
		expect((thrown as Error).message).toBe(message);
	});

	it('draws nothing at all when any range is invalid', () => {
		let draws = 0;
		const counting: RandomWordSource = (count) => {
			draws += count;
			return new BigUint64Array(count);
		};

		expect(() => randomIntegersForRanges([{ min: 1, max: 6 }, { min: 6, max: 1 }], counting)).toThrow(
			ToolCallArgumentValidationError,
		);
		expect(draws).toBe(0);
	});
});
