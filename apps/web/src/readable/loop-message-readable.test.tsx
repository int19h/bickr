import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotInferenceSubmissionMessage, BotLoopMessage, BotPublicProfile, CommentDocument, ThreadDocument } from "@bickr/shared/model";
import type { ToolResultEnvelope } from "@bickr/shared/tool-results";
import { LoopMessageReadableView, toolResultEnvelope } from "./loop-message-readable";
import { ReadableToolResultEnvelope, readableToolResultRenderers } from "./loop-message-tool-results";
import { loopToolCallsById } from "./loop-message-values";

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

	it("renders malformed provider calls as inspectable dropped output without execution semantics", () => {
		const rawArguments = '{"commentRef":"c/parent","body":"unterminated';
		const invalidMessage: BotInferenceSubmissionMessage = {
			role: "assistant",
			content: null,
			tool_calls: [{
				id: "call-invalid-reply",
				type: "function",
				function: { name: "reply_to_comment", arguments: rawArguments },
			}],
		};
		const stored = loopMessage(9, invalidMessage, "dropped_provider_response");
		const html = renderToStaticMarkup(
			<LoopMessageReadableView
				message={invalidMessage}
				origin="dropped_provider_response"
				toolCallsById={loopToolCallsById([stored])}
			/>,
		);

		expect(html).toContain("Invalid provider output — dropped without execution");
		expect(html).toContain("Call ID");
		expect(html).toContain("call-invalid-reply");
		expect(html).toContain("Function");
		expect(html).toContain("reply_to_comment");
		expect(html).toContain("Raw arguments");
		expect(html).toContain(rawArguments.replaceAll('"', "&quot;"));
		expect(html).not.toContain("Replying to a comment");
		expect(loopToolCallsById([stored]).has("call-invalid-reply")).toBe(false);
	});
});

describe("readableToolResultRenderers", () => {
	const rootComment = comment("cmt_root", "Root post");
	const reply = comment("cmt_reply", "A reply", "cmt_root");
	const thread = threadDocument([rootComment, reply]);
	const profile: BotPublicProfile = {
		id: "bot_alice",
		homeWorldId: "world_sandbox",
		homeWorldHandle: "sandbox",
		handle: "alice",
		language: null,
		displayName: localized("Alice"),
		shortBio: localized("A profile"),
		createdAt,
		updatedAt: createdAt,
	};
	const cases: Array<{ envelope: ToolResultEnvelope; expected: string }> = [
		{ envelope: { kind: "thread_created", thread }, expected: "Rule 82" },
		{ envelope: { kind: "comment_created", thread, comment: reply }, expected: "Parent comment" },
		{ envelope: { kind: "vote_set", votes: [{ commentId: reply.id, value: 1, thread }] }, expected: "Upvoted" },
		{ envelope: { kind: "profile_followed", profiles: [{ username: "alice", following: true, profile }] }, expected: "Followed" },
		{ envelope: { kind: "profile_unfollowed", profiles: [{ username: "alice", following: false, profile }] }, expected: "Unfollowed" },
		{ envelope: { kind: "content_read", items: [{ kind: "comment", id: reply.id, threadId: thread.id, body: reply.body }] }, expected: "A reply" },
		{ envelope: { kind: "opaque", value: { status: "raw fallback" } }, expected: "raw fallback" },
	];

	it("has an exhaustive entry for every result kind", () => {
		expect(Object.keys(readableToolResultRenderers).sort()).toEqual(cases.map(({ envelope }) => envelope.kind).sort());
	});

	it("renders an unknown stored envelope through the JSON fallback", () => {
		const envelope = toolResultEnvelope({ kind: "future_kind", message: "future payload" }, "unknown_tool", {}, {});
		const html = renderToStaticMarkup(
			<ReadableToolResultEnvelope
				displayContext={{ allowActiveWorldFallback: false }}
				envelope={envelope}
			/>,
		);
		expect(envelope.kind).toBe("opaque");
		expect(html).toContain("future payload");
		expect(html).not.toBe("");
	});

	it("renders an unrecognized legacy result through the JSON fallback", () => {
		const envelope = toolResultEnvelope(undefined, "unknown_tool", { legacy: "stored payload" }, {});
		const html = renderToStaticMarkup(
			<ReadableToolResultEnvelope
				displayContext={{ allowActiveWorldFallback: false }}
				envelope={envelope}
			/>,
		);
		expect(envelope.kind).toBe("opaque");
		expect(html).toContain("stored payload");
		expect(html).not.toBe("");
	});

	it.each(cases)("renders $envelope.kind", ({ envelope, expected }) => {
		const html = renderToStaticMarkup(
			<ReadableToolResultEnvelope
				displayContext={{ worldHandle: "sandbox", allowActiveWorldFallback: false }}
				envelope={envelope}
			/>,
		);
		expect(html).toContain(expected);
		expect(html).not.toBe("");
	});
});

function localized(text: string) {
	return { lang: null, text };
}

function comment(id: string, body: string, parentCommentId?: string): CommentDocument {
	return {
		id,
		threadId: "thr_rule",
		worldId: "world_sandbox",
		forumId: "forum_rules",
		authorBotId: "bot_alice",
		authorHandle: "alice",
		authorDisplayName: localized("Alice"),
		...(parentCommentId ? { parentCommentId } : {}),
		body: localized(body),
		voteScore: 0,
		createdAt,
		updatedAt: createdAt,
	};
}

function threadDocument(comments: CommentDocument[]): ThreadDocument {
	return {
		id: "thr_rule",
		type: "thread",
		schemaVersion: 2,
		revision: 1,
		createdAt,
		updatedAt: createdAt,
		worldId: "world_sandbox",
		worldHandle: "sandbox",
		forumId: "forum_rules",
		forumHandle: "rules",
		title: localized("Rule 82"),
		rootCommentId: "cmt_root",
		comments,
		commentCount: comments.length,
		voteScore: 0,
		recentCommentCount: comments.length,
		lastActivityAt: createdAt,
	};
}
