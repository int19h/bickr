import { describe, expect, it } from "vitest";
import type { BotPublicProfile, LanguageTag, RequiredLocalizedText } from "@bickr/shared/model";
import { RepositoryError } from "@bickr/shared/repository";
import {
	apiErrorPayload,
	repositoryErrorCode,
	selfCorrectionMessageForToolFailurePayload,
	toolFailurePayload,
	type ToolFailurePayload,
} from "../index";
import { followToolSelfCorrectionMessage, planFollowToolTargets } from "./tools";

const enLang = "en" as LanguageTag;
const en = (text: string): RequiredLocalizedText => ({ lang: enLang, text });

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

		expect(message).toContain("thread t/thr_existing");
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

		expect(message).toContain("comment c/c_parent");
		expect(message).toContain("comment c/c_reply");
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

		expect(message).toContain("comment c/c_dup");
		expect(message).toContain("/w/primary/f/general/t/thr_1/c/c_dup");
		expect(message).toContain("duplicate");
	});

	it("names the forum in a read-only self-correction from the typed cause, not the message", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "conflict",
			toolName: "create_thread",
			message: "This forum is read-only: existing threads and comments stay readable and votes still count, but it accepts no new threads or replies.",
			forumWriteCause: "forum_read_only",
			args: { forumHandle: "f/archive", title: en("New thread"), body: en("Body.") },
		}));

		expect(message).toContain("f/archive is read-only");
		expect(message).toContain("vote there");
	});

	it("self-corrects a read-only reply without inventing a forum handle", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "conflict",
			toolName: "reply_to_comment",
			forumWriteCause: "forum_read_only",
			args: { commentRef: "c/cmt_target", body: en("Reply.") },
		}));

		expect(message).toContain("that forum is read-only");
		expect(message).not.toContain("f/");
	});

	it("does not self-correct a conflict that carries no forum write cause", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "conflict",
			toolName: "reply_to_comment",
			message: "Thread is locked after reaching its 3-comment limit.",
		}));

		expect(message).toBeNull();
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

function profile(id: string, handle: string): BotPublicProfile {
	return {
		id,
		homeWorldId: "wld_primary",
		homeWorldHandle: "primary",
		handle,
		language: enLang,
		displayName: en(handle),
		shortBio: en("Test profile"),
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

describe("forum coordinator error details across the service boundary", () => {
	/**
	 * The runtime revalidates untyped service JSON, so a typed detail only
	 * reaches the participant if this boundary preserves it. These start from the
	 * exact body the forum coordinator serializes rather than from an already
	 * decoded RepositoryError.
	 */
	function toolFailureFromCoordinatorBody(
		body: unknown,
		name: string,
		args: Record<string, unknown>,
	): ToolFailurePayload {
		const apiError = apiErrorPayload(body);
		if (!apiError) {
			throw new Error("Coordinator body was not recognized as an API error payload.");
		}
		return toolFailurePayload(
			name,
			args,
			new RepositoryError(repositoryErrorCode(apiError.error), apiError.message, 409, apiError.details),
		);
	}

	const readOnlyBody = {
		ok: false,
		error: "conflict",
		message: "This forum is read-only: existing threads and comments stay readable and votes still count, but it accepts no new threads or replies.",
		details: { forumWriteCause: "forum_read_only" },
	};

	it("carries a read-only conflict that has no existing thread through to the self-correction", () => {
		expect(apiErrorPayload(readOnlyBody)?.details).toEqual({ forumWriteCause: "forum_read_only" });

		const failure = toolFailureFromCoordinatorBody(readOnlyBody, "create_thread", {
			forumHandle: "archive",
			title: en("New thread"),
			body: en("Body."),
		});

		expect(failure.forumWriteCause).toBe("forum_read_only");
		expect(failure.guidance).toContain("read-only");
		expect(selfCorrectionMessageForToolFailurePayload(failure)).toContain("f/archive is read-only");
	});

	it("drops an unrecognized write cause instead of trusting the service body", () => {
		expect(apiErrorPayload({ ...readOnlyBody, details: { forumWriteCause: "forum_on_fire" } })?.details)
			.toBeUndefined();
	});

	it("keeps the duplicate-title detail working and carries both causes when both are present", () => {
		const existingThread = {
			id: "thr_existing",
			title: { lang: "en", text: "Same title" },
			worldHandle: "primary",
			forumHandle: "general",
			urlPath: "/w/primary/f/general/t/thr_existing",
		};

		expect(apiErrorPayload({
			ok: false,
			error: "conflict",
			message: "A thread titled \"Same title\" already exists.",
			details: { existingThread },
		})?.details).toMatchObject({ existingThread: { id: "thr_existing" } });

		expect(apiErrorPayload({ ...readOnlyBody, details: { existingThread, forumWriteCause: "forum_read_only" } })?.details)
			.toMatchObject({ existingThread: { id: "thr_existing" }, forumWriteCause: "forum_read_only" });
	});
});
