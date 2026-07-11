import { describe, expect, it } from 'vitest';
import type { BotInferenceSubmissionToolCall, LanguageTag } from '@bickr/shared/model';
import {
	localizedToolTextArg,
	parseToolArgs,
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
