import { describe, expect, it } from 'vitest';
import type { BotInferenceSubmissionToolCall, LanguageTag } from '@bickr/shared/model';
import { ToolCallArgumentValidationError } from '../errors';
import {
	localizedToolTextArg,
	normalizeToolArgs,
	parseToolArgs,
	randomRangesArgIsCanonical,
	resolveToolArgs,
	toolArgCodecFor,
	type ReferenceToolName,
} from './tool-args';

const enLang = 'en' as LanguageTag;

describe('tool argument validation', () => {
	it('reports malformed tool-call JSON with the parser message', () => {
		const malformed = rawToolCall('call_bad_json', 'vote', '{"reason":');

		expect(() => parseToolArgs(malformed)).toThrow(/Malformed tool call! The arguments for vote are not valid JSON: /);
	});

	it('reports non-object tool-call JSON as a malformed tool call', () => {
		const malformed = rawToolCall('call_string_json', 'vote', '"not an object"');

		expect(() => parseToolArgs(malformed)).toThrow('Malformed tool call! The arguments for vote must be a JSON object, but a string was provided.');
	});

	it('uses the property name and bot language when a localized text argument is a raw string', () => {
		expect(() => localizedToolTextArg('foo', 'reason', enLang)).toThrow(
			'Malformed tool call! reason is a string, but it must be an object. You provided "reason":"foo", which is incorrect; it should be something like "reason":{"lang":"en","text":"foo"} instead.',
		);
	});

	it('uses nested property names in localized text examples', () => {
		const ja = 'ja' as LanguageTag;

		expect(() => localizedToolTextArg('将軍家', 'targets[0].reason', ja)).toThrow(
			'Malformed tool call! targets[0].reason is a string, but it must be an object. You provided "targets[0].reason":"将軍家", which is incorrect; it should be something like "targets[0].reason":{"lang":"ja","text":"将軍家"} instead.',
		);
	});

	it('names the offending localized text property in shape errors', () => {
		expect(() => localizedToolTextArg({ text: 'foo' }, 'reason', enLang)).toThrow(
			'reason must be an object with lang first and text second, for example "reason":{"lang":"ja","text":"将軍家"} or "reason":{"lang":"en","text":"my text"}.',
		);
	});

	it('classifies a pasted self-author annotation without widening participant handle grammar', () => {
		const error = caughtError(() => normalizeToolArgs('view_activity', { username: 'u/alice (MYSELF)' }));

		expect(error).toBeInstanceOf(ToolCallArgumentValidationError);
		expect(error).toMatchObject({ code: 'self_author_annotation_in_handle' });
		expect(normalizeToolArgs('view_activity', { username: 'u/alice' })).toEqual({ username: 'alice' });
	});
});

describe('tool argument reference codecs', () => {
	const cases: Array<{
		name: ReferenceToolName;
		internal: Record<string, unknown>;
		provider: Record<string, unknown>;
	}> = [
		{ name: 'read_thread', internal: { threadId: 'thr_read' }, provider: { threadRef: 't/thr_read' } },
		{ name: 'read_thread_by_id', internal: { threadId: 'thr_read_by_id' }, provider: { threadRef: 't/thr_read_by_id' } },
		{ name: 'read_comment_by_id', internal: { commentId: 'cmt_read' }, provider: { commentRef: 'c/cmt_read' } },
		{
			name: 'reply_to_comment',
			internal: { commentId: 'cmt_reply', body: { lang: 'en', text: 'Reply.' } },
			provider: { commentRef: 'c/cmt_reply', body: { lang: 'en', text: 'Reply.' } },
		},
		{
			name: 'make_additional_reply_to_the_same_comment',
			internal: { commentId: 'cmt_reply_more', body: { lang: 'en', text: 'Another reply.' } },
			provider: { commentRef: 'c/cmt_reply_more', body: { lang: 'en', text: 'Another reply.' } },
		},
		{
			name: 'vote',
			internal: { votes: [{ commentId: 'cmt_vote', value: 1 }], reason: { lang: 'en', text: 'Useful.' } },
			provider: { votes: [{ commentRef: 'c/cmt_vote', value: 1 }], reason: { lang: 'en', text: 'Useful.' } },
		},
	];

	it.each(cases)('$name round-trips internal ids and provider refs in both directions', ({ name, internal, provider }) => {
		const codec = toolArgCodecFor(name);

		expect(codec.decode(codec.encode(internal))).toEqual(internal);
		expect(codec.encode(codec.decode(provider))).toEqual(provider);
	});

	it('resolves the legacy reply thread target through the reply codec', async () => {
		await expect(resolveToolArgs('reply_to_comment', { threadId: 'thr_legacy', body: 'Legacy reply.' }, {
			rootCommentIdForThread: async (threadId) => `root_${threadId}`,
		})).resolves.toEqual({ commentId: 'root_thr_legacy', body: 'Legacy reply.' });
	});
});

describe('random range arguments', () => {
	it('canonicalizes a single range object into the array form', () => {
		expect(normalizeToolArgs('draw_random_integers', { ranges: { min: 1, max: 6 } })).toEqual({
			ranges: [{ min: 1, max: 6 }],
		});
	});

	it('keeps an array of ranges in order and drops nothing', () => {
		expect(normalizeToolArgs('draw_random_integers', { ranges: [{ min: 1, max: 6 }, { min: 0, max: 1 }] })).toEqual({
			ranges: [{ min: 1, max: 6 }, { min: 0, max: 1 }],
		});
	});

	it('keeps only min and max from a range that carries extra properties', () => {
		expect(normalizeToolArgs('draw_random_integers', { ranges: [{ min: 1, max: 6, label: 'd6' }] })).toEqual({
			ranges: [{ min: 1, max: 6 }],
		});
	});

	const canonicalCases: Array<{ label: string; ranges: unknown; canonical: boolean }> = [
		{ label: "an already canonical array", ranges: [{ min: 1, max: 6 }], canonical: true },
		{ label: "a canonical array in another property order", ranges: [{ max: 6, min: 1 }], canonical: true },
		{ label: "a single range object", ranges: { min: 1, max: 6 }, canonical: false },
		{ label: "a range carrying an extra property", ranges: [{ min: 1, max: 6, label: "d6" }], canonical: false },
		{ label: "a range missing from the argument", ranges: [], canonical: false },
	];

	it.each(canonicalCases)("reports $label as canonical=$canonical", ({ ranges, canonical }) => {
		expect(randomRangesArgIsCanonical(ranges, [{ min: 1, max: 6 }])).toBe(canonical);
	});

	const invalid: Array<{ label: string; ranges: unknown; message: string }> = [
		{ label: 'a missing ranges argument', ranges: undefined, message: 'ranges is required.' },
		{ label: 'an empty array', ranges: [], message: 'ranges must include at least one range.' },
		{
			label: 'more ranges than the bulk cap',
			ranges: Array.from({ length: 33 }, () => ({ min: 1, max: 6 })),
			message: 'ranges can include at most 32 ranges.',
		},
		{ label: 'max below min', ranges: [{ min: 6, max: 1 }], message: 'ranges[0].max must be greater than or equal to ranges[0].min.' },
		{
			label: 'a numeric string endpoint',
			ranges: [{ min: '1', max: 6 }],
			message: `ranges[0].min must be a whole number between ${-Number.MAX_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}.`,
		},
		{
			label: 'a fractional endpoint',
			ranges: [{ min: 1, max: 6.5 }],
			message: `ranges[0].max must be a whole number between ${-Number.MAX_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}.`,
		},
		{
			label: 'a missing endpoint',
			ranges: [{ min: 1 }],
			message: `ranges[0].max must be a whole number between ${-Number.MAX_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}.`,
		},
		{ label: 'a non-object range', ranges: [7], message: 'ranges[0] must be an object like {"min":1,"max":6}.' },
		{ label: 'a string ranges argument', ranges: '1-6', message: 'ranges[0] must be an object like {"min":1,"max":6}.' },
		{ label: 'a nested array', ranges: [[{ min: 1, max: 6 }]], message: 'ranges[0] must be an object like {"min":1,"max":6}.' },
	];

	it.each(invalid)('rejects $label with self-correctable guidance', ({ ranges, message }) => {
		const error = caughtError(() =>
			normalizeToolArgs('draw_random_integers', ranges === undefined ? {} : { ranges }),
		);

		expect(error).toBeInstanceOf(ToolCallArgumentValidationError);
		expect((error as ToolCallArgumentValidationError).code).toBe('bad_request');
		expect((error as Error).message).toBe(message);
	});
});

function rawToolCall(id: string, name: string, args: string): BotInferenceSubmissionToolCall {
	return {
		id,
		type: 'function',
		function: {
			name,
			arguments: args,
		},
	};
}

function caughtError(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error('Expected action to throw.');
}
