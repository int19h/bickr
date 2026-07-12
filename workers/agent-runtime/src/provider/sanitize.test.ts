import type { BotInferenceSubmissionToolCall } from '@bickr/shared/model';
import { describe, expect, it } from 'vitest';
import {
	createProviderSanitize,
	loopMessageContributesToProviderHistory,
} from './sanitize';
import { parseToolArgs, parseToolArgsWithDiagnostics } from '../runtime/tool-args';

const { providerResponseMessageForHistory, sanitizeProviderToolCalls } = createProviderSanitize({
	canonicalToolName: (name) => name,
	followToolArgsWithTargets: (args, targets) => ({ ...args, targets }),
	followToolTargetsForProviderDedupe: () => {
		throw new Error('not used by these unit tests');
	},
	parseToolArgs,
	parseToolArgsWithDiagnostics,
	providerToolArgs: (_name, args) => args,
	runtimeRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {},
	safeContextText: (text, limit) => text.slice(0, limit),
	stringValue: (value) => typeof value === 'string' ? value : undefined,
});

describe('tool argument validation', () => {
	it("drops malformed JSON argument strings before history or execution", () => {
		const malformed = rawToolCall("call_bad_json", "vote", '{"reason":');

		const result = sanitizeProviderToolCalls([malformed]);

		expect(result.dropped).toEqual([
			expect.objectContaining({
				id: "call_bad_json",
				name: "vote",
				reason: "invalid_arguments_json",
			}),
		]);
		expect(result.toolCalls).toHaveLength(0);
	});

	it.each([
		['original', 'I am done here."},commentRef:'],
		['whitespace', 'I am done here."} ,  commentRef :  '],
		['quoted key', 'I am done here."}, "commentRef":'],
	])("strips a leaked fragment of another argument key from generated reply bodies (%s)", (_variant, text) => {
		const result = sanitizeProviderToolCalls([
			toolCall("call_reply", "reply_to_comment", {
				body: { lang: "en", text },
				commentRef: "c/target",
			}),
		]);

		expect(result.dropped).toEqual([]);
		expect(result.repaired).toEqual([
			expect.objectContaining({
				id: 'call_reply',
				name: 'reply_to_comment',
				reason: 'leaked_argument_fragment',
				field: 'body.text',
				leakedArgumentKey: 'commentRef',
			}),
		]);
		expect(JSON.parse(result.toolCalls[0]?.function.arguments ?? "{}")).toEqual({
			body: { lang: "en", text: "I am done here." },
			commentRef: "c/target",
		});
	});

	it("only strips suffix fragments that name another argument in the same call", () => {
		const text = 'quoted "},commentRef: inside text';
		expect(parseToolArgs(toolCall('call_reply', 'reply_to_comment', { body: { lang: 'en', text }, other: true }))).toEqual({
			body: { lang: 'en', text },
			other: true,
		});
	});
});

describe('Provider requests', () => {
	it("does not retain empty provider responses in provider history", async () => {
		expect(providerResponseMessageForHistory({
			content: "",
			reasoning: "",
			reasoningDetails: [],
			toolCalls: [],
		})).toBeNull();
		expect(providerResponseMessageForHistory({
			content: "",
			reasoning: "I am deciding what to do next.",
			reasoningDetails: [],
			toolCalls: [],
		})).toEqual({ role: "assistant", reasoning: "I am deciding what to do next." });
		expect(providerResponseMessageForHistory(providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }))).toMatchObject({
			role: "assistant",
			content: null,
			tool_calls: [
				expect.objectContaining({
					id: "call-read",
					function: expect.objectContaining({ name: "read_thread" }),
				}),
			],
		});
		expect(loopMessageContributesToProviderHistory("provider_response", { role: "assistant", content: null })).toBe(false);
		expect(loopMessageContributesToProviderHistory("provider_response", { role: "assistant", content: "" })).toBe(false);
		expect(loopMessageContributesToProviderHistory("runtime_error", { role: "user", content: "Bickr Terminal reported an error." })).toBe(false);
		expect(loopMessageContributesToProviderHistory("synthetic_context", { role: "assistant", content: null })).toBe(true);
	});

	it("validates provider tool-call arguments before history or execution", () => {
		const sanitized = sanitizeProviderToolCalls([
			{
				id: "call-malformed",
				type: "function",
				function: { name: "read_thread", arguments: "{\"threadId\":" },
			},
			{
				id: "call-array",
				type: "function",
				function: { name: "read_thread", arguments: "[]" },
			},
			{
				id: "call-null",
				type: "function",
				function: { name: "read_thread", arguments: "null" },
			},
			{
				id: "call-string",
				type: "function",
				function: { name: "read_thread", arguments: "\"x\"" },
			},
			{
				id: "call-valid",
				type: "function",
				function: { name: "read_thread", arguments: "{ \"threadId\": \"thr_test\" }" },
			},
			{
				id: "call-valid",
				type: "function",
				function: { name: "reply_to_comment", arguments: "{ \"commentId\": \"com_test\", \"body\": \"Duplicate id.\" }" },
			},
		]);

		expect(sanitized.dropped.map((call) => [call.id, call.reason])).toEqual([
			["call-malformed", "invalid_arguments_json"],
			["call-array", "arguments_not_json_object"],
			["call-null", "arguments_not_json_object"],
			["call-string", "arguments_not_json_object"],
			["call-valid", "duplicate_tool_call"],
		]);
		expect(sanitized.toolCalls).toEqual([
			{
				id: "call-valid",
				type: "function",
				function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
			},
		]);
	});
});

function toolCall(id: string, name: string, args: Record<string, unknown>): BotInferenceSubmissionToolCall {
	return rawToolCall(id, name, JSON.stringify(args));
}

function rawToolCall(id: string, name: string, args: string): BotInferenceSubmissionToolCall {
	return {
		id,
		type: "function",
		function: {
			name,
			arguments: args,
		},
	};
}

function providerResponseWithToolCall(id: string, name: string, args: Record<string, unknown>) {
	return {
		content: '',
		reasoning: '',
		reasoningDetails: [],
		toolCalls: [toolCall(id, name, args)],
	};
}
