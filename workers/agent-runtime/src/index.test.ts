import { describe, expect, it } from "vitest";
import type { BotInferenceSubmissionMessage, BotInferenceSubmissionToolCall, BotPublicProfile } from "@bickr/shared/model";
import {
	followToolSelfCorrectionMessage,
	planFollowToolTargets,
	rewriteProviderResponseToolCallMessage,
	selfCorrectionMessageForToolFailurePayload,
	type ToolFailurePayload,
} from "./index";

describe("rewriteProviderResponseToolCallMessage", () => {
	it("removes one offending tool call and preserves unrelated calls", () => {
		const message = assistantMessage({
			content: null,
			tool_calls: [
				toolCall("call_bad", "follow_profile", { targets: [{ username: "alice", reason: "Alice writes useful posts." }] }),
				toolCall("call_ok", "read_thread", { threadId: "thr_1" }),
			],
		});

		const result = rewriteProviderResponseToolCallMessage(message, { kind: "drop", toolCallId: "call_bad" });

		expect(result.kind).toBe("updated");
		if (result.kind !== "updated") {
			return;
		}
		expect(result.message.tool_calls).toHaveLength(1);
		expect(result.message.tool_calls?.[0]?.id).toBe("call_ok");
	});

	it("keeps provider response text when only the offending tool call is removed", () => {
		const message = assistantMessage({
			content: "I should not make the same post twice.",
			tool_calls: [toolCall("call_bad", "create_thread", { forumHandle: "general", title: "Same" })],
		});

		const result = rewriteProviderResponseToolCallMessage(message, { kind: "drop", toolCallId: "call_bad" });

		expect(result).toMatchObject({
			kind: "updated",
			message: {
				content: "I should not make the same post twice.",
			},
		});
		if (result.kind === "updated") {
			expect(result.message.tool_calls).toBeUndefined();
		}
	});

	it("soft-deletes an empty provider response when its only tool call is removed", () => {
		const message = assistantMessage({
			content: null,
			tool_calls: [toolCall("call_bad", "reply_to_comment", { commentId: "c_1", body: "Same" })],
		});

		const result = rewriteProviderResponseToolCallMessage(message, { kind: "drop", toolCallId: "call_bad" });

		expect(result.kind).toBe("deleted");
	});

	it("edits tool call arguments and preserves the call id", () => {
		const message = assistantMessage({
			content: null,
			tool_calls: [toolCall("call_follow", "follow_profile", {
				targets: [
					{ username: "alice", reason: "Alice writes interesting posts." },
					{ username: "bob", reason: "Bob shares useful context." },
				],
			})],
		});

		const result = rewriteProviderResponseToolCallMessage(message, {
			kind: "replace_arguments",
			toolCallId: "call_follow",
			arguments: JSON.stringify({ targets: [{ username: "bob", reason: "Bob shares useful context." }] }),
		});

		expect(result.kind).toBe("updated");
		if (result.kind !== "updated") {
			return;
		}
		const [edited] = result.message.tool_calls ?? [];
		expect(edited?.id).toBe("call_follow");
		expect(JSON.parse(edited?.function.arguments ?? "{}")).toEqual({ targets: [{ username: "bob", reason: "Bob shares useful context." }] });
	});
});

describe("follow profile self-corrections", () => {
	it("treats all redundant follow targets as skipped", () => {
		const profiles = [profile("bot_self", "me"), profile("bot_alice", "alice")];
		const plan = planFollowToolTargets("bot_self", profiles, new Set(["bot_alice"]), true);
		const message = followToolSelfCorrectionMessage("follow_profile", plan.skipped);

		expect(plan.validProfiles).toEqual([]);
		expect(plan.skipped).toEqual([
			{ username: "u/me", reason: "self_follow" },
			{ username: "u/alice", reason: "already_following" },
		]);
		expect(message).toContain("u/me");
		expect(message).toContain("u/alice");
		expect(message).toContain("follow_profile");
	});

	it("keeps valid follow targets and names skipped usernames", () => {
		const profiles = [profile("bot_alice", "alice"), profile("bot_bob", "bob")];
		const plan = planFollowToolTargets("bot_self", profiles, new Set(["bot_alice"]), true);
		const message = followToolSelfCorrectionMessage("follow_profile", plan.skipped);

		expect(plan.validProfiles.map((item) => item.handle)).toEqual(["bob"]);
		expect(plan.skipped).toEqual([{ username: "u/alice", reason: "already_following" }]);
		expect(message).toContain("u/alice");
		expect(message).not.toContain("u/bob");
	});

	it("keeps valid unfollow targets and names not-followed usernames", () => {
		const profiles = [profile("bot_alice", "alice"), profile("bot_bob", "bob")];
		const plan = planFollowToolTargets("bot_self", profiles, new Set(["bot_bob"]), false);
		const message = followToolSelfCorrectionMessage("unfollow_profile", plan.skipped);

		expect(plan.validProfiles.map((item) => item.handle)).toEqual(["bob"]);
		expect(plan.skipped).toEqual([{ username: "u/alice", reason: "not_following" }]);
		expect(message).toContain("I do not follow u/alice");
		expect(message).toContain("unfollow_profile");
	});

	it("names missing profiles as non-existing Bickr participants", () => {
		const message = followToolSelfCorrectionMessage("follow_profile", [
			{ username: "u/philosopher_king", reason: "profile_not_found" },
		]);

		expect(message).toContain("u/philosopher_king is not an existing Bickr participant");
		expect(message).toContain("follow_profile");
	});

	it("converts missing follow targets into self-correction text", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "not_found",
			toolName: "unfollow_profile",
			message: "Profile u/philosopher_king not found.",
			args: { targets: [{ username: "philosopher_king", reason: "That profile no longer exists." }] },
		}));

		expect(message).toContain("u/philosopher_king is not an existing Bickr participant");
		expect(message).toContain("unfollow_profile");
	});
});

describe("redundant post and reply self-corrections", () => {
	it("formats duplicate thread self-correction with a thread link path", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "conflict",
			toolName: "create_thread",
			existingThreadId: "thr_existing",
			existingThreadTitle: "Same title",
			existingForumHandle: "general",
			existingWorldHandle: "primary",
			existingUrlPath: "/w/primary/f/general/t/thr_existing",
		}));

		expect(message).toContain("thread thr_existing");
		expect(message).toContain("/w/primary/f/general/t/thr_existing");
		expect(message).toContain("duplicate");
	});

	it("formats prior reply self-correction with the existing reply", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "already_replied",
			toolName: "reply_to_comment",
			existingThreadId: "thr_1",
			targetCommentId: "c_parent",
			existingReplies: [{
				commentId: "c_reply",
				body: "I already said this.",
				urlPath: "/w/primary/f/general/t/thr_1/c/c_reply",
				createdAt: "2026-05-06T12:00:00.000Z",
			}],
		}));

		expect(message).toContain("comment c_parent");
		expect(message).toContain("comment c_reply");
		expect(message).toContain("/w/primary/f/general/t/thr_1/c/c_reply");
	});

	it("formats duplicate comment self-correction with the existing comment", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "duplicate_comment",
			toolName: "reply_to_comment",
			existingThreadId: "thr_1",
			existingCommentId: "c_dup",
			existingUrlPath: "/w/primary/f/general/t/thr_1/c/c_dup",
		}));

		expect(message).toContain("comment c_dup");
		expect(message).toContain("/w/primary/f/general/t/thr_1/c/c_dup");
		expect(message).toContain("duplicate");
	});

	it("does not self-correct generic validation failures", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "bad_request",
			toolName: "create_thread",
			message: "title is required.",
		}));

		expect(message).toBeNull();
	});
});

function assistantMessage(input: Omit<BotInferenceSubmissionMessage, "role">): BotInferenceSubmissionMessage {
	return { role: "assistant", ...input };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): BotInferenceSubmissionToolCall {
	return {
		id,
		type: "function",
		function: {
			name,
			arguments: JSON.stringify(args),
		},
	};
}

function profile(id: string, handle: string): BotPublicProfile {
	return {
		id,
		homeWorldId: "wld_primary",
		homeWorldHandle: "primary",
		handle,
		displayName: handle,
		shortBio: "Test profile",
		createdAt: "2026-05-06T12:00:00.000Z",
		updatedAt: "2026-05-06T12:00:00.000Z",
	};
}

function toolFailure(fields: Partial<ToolFailurePayload> & Pick<ToolFailurePayload, "code" | "toolName">): ToolFailurePayload {
	return {
		ok: false,
		message: "The page reported a redundant action.",
		args: {},
		...fields,
	};
}
