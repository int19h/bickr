import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotInferenceSubmissionMessage, BotLoopMessage } from "@bickr/shared/model";
import { LoopMessageReadableView, loopToolCallsById } from "./App";

const createdAt = "2026-05-10T12:00:00.000Z";

function loopMessage(
	seq: number,
	message: BotInferenceSubmissionMessage,
	origin: BotLoopMessage["origin"],
	display?: BotLoopMessage["display"],
): BotLoopMessage {
	return {
		seq,
		position: seq,
		runId: "run-readable",
		role: message.role,
		message,
		...(display ? { display } : {}),
		origin,
		tokenEstimate: 1,
		createdAt,
		status: "complete",
	};
}

describe("LoopMessageReadableView", () => {
	it("uses rich tool display payloads for author and comment links", () => {
		const display: BotLoopMessage["display"] = {
			kind: "tool_result",
			eventSeq: 42,
			name: "search_threads",
			args: { query: "potato" },
			result: [{
				threadId: "thr_rule",
				commentId: "cmt_match",
				forumHandle: "rules",
				title: "Rule 82",
				snippet: "mashed potato discourse",
				authorHandle: "alice",
				authorDisplayName: "Alice",
			}],
			context: { worldHandle: "sandbox" },
		};

		const html = renderToStaticMarkup(
			<LoopMessageReadableView
				display={display}
				message={{
					role: "tool",
					tool_call_id: "call-search",
					content: JSON.stringify([{ threadId: "thr_rule", commentId: "cmt_match", title: "Minimized" }]),
				}}
				origin="tool_result"
				toolCallsById={new Map()}
			/>,
		);

		expect(html).toContain("Comment by");
		expect(html).toContain("u/alice");
		expect(html).toContain("mashed potato discourse");
		expect(html).toContain("href=\"/w/sandbox/f/rules/t/thr_rule/c/cmt_match\"");
	});

	it("omits unknown author and link fields for minimized legacy fallback", () => {
		const html = renderToStaticMarkup(
			<LoopMessageReadableView
				message={{
					role: "tool",
					tool_call_id: "call-search",
					content: JSON.stringify([{ threadId: "thr_rule", commentId: "cmt_match", title: "Rule 82", snippet: "minimized snippet" }]),
				}}
				origin="tool_result"
				toolCall={{ id: "call-search", name: "search_threads", args: { query: "potato" } }}
				toolCallsById={new Map()}
			/>,
		);

		expect(html).toContain("Comment in");
		expect(html).toContain("Rule 82");
		expect(html).not.toContain("Comment by");
		expect(html).not.toContain("someone");
		expect(html).toContain("href=\"/c/cmt_match\"");
	});

	it("uses linked rich results when rendering matching tool requests", () => {
		const display: BotLoopMessage["display"] = {
			kind: "tool_result",
			eventSeq: 77,
			name: "reply_to_comment",
			args: { commentId: "cmt_parent", body: "A reply" },
			result: {
				thread: {
					threadId: "thr_rule",
					forumHandle: "rules",
					title: "Rule 82",
					comments: [
						{ commentId: "cmt_parent", body: "Parent comment text", authorHandle: "alice" },
						{ commentId: "cmt_reply", parentCommentId: "cmt_parent", body: "A reply" },
					],
				},
				comment: { commentId: "cmt_reply", threadId: "thr_rule", body: "A reply" },
			},
			context: { worldHandle: "sandbox" },
		};
		const assistantMessage: BotInferenceSubmissionMessage = {
			role: "assistant",
			content: null,
			tool_calls: [{
				id: "call-reply",
				type: "function",
				function: { name: "reply_to_comment", arguments: JSON.stringify({ commentId: "cmt_parent", body: "A reply" }) },
			}],
		};
		const messages = [
			loopMessage(1, assistantMessage, "provider_response"),
			loopMessage(2, { role: "tool", tool_call_id: "call-reply", content: JSON.stringify({ commentId: "cmt_reply" }) }, "tool_result", display),
		];
		const contexts = loopToolCallsById(messages);

		expect(contexts.get("call-reply")?.result).toBe(display.result);

		const html = renderToStaticMarkup(
			<LoopMessageReadableView
				message={assistantMessage}
				origin="provider_response"
				toolCallsById={contexts}
			/>,
		);

		expect(html).toContain("Parent comment");
		expect(html).toContain("Parent comment text");
		expect(html).toContain("href=\"/w/sandbox/f/rules/t/thr_rule/c/cmt_parent\"");
	});
});
