import { describe, expect, it } from "vitest";
import type {
	BotPublicProfile,
	CommentDocument,
	LanguageTag,
	RequiredLocalizedText,
	ThreadDocument,
} from "@bickr/shared/model";
import { RepositoryError } from "@bickr/shared/repository";
import { ToolCallArgumentValidationError } from "../errors";
import {
	apiErrorPayload,
	repositoryErrorCode,
	selfCorrectionMessageForToolFailurePayload,
	toolFailurePayload,
	type ToolFailurePayload,
} from "../index";
import type { BotRuntimeEvent } from "@bickr/shared/model";
import type { RunContext, RuntimeBotDocument, RuntimeRow, ToolResult } from "../types";
import { normalizeToolArgs } from "./tool-args";
import {
	assertNoDuplicateReplyInToolResultRows,
	DuplicateReplyError,
	followToolSelfCorrectionMessage,
	planFollowToolTargets,
	RuntimeTools,
	type RuntimeToolsRuntime,
} from "./tools";

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

describe("tool argument failure guidance", () => {
	it("uses typed guidance when a composite self-author label is pasted as a username", () => {
		const error = caughtError(() => normalizeToolArgs("view_activity", { username: "u/alice (MYSELF)" }));
		expect(error).toBeInstanceOf(ToolCallArgumentValidationError);

		const failure = toolFailurePayload("view_activity", { username: "u/alice (MYSELF)" }, error);

		expect(failure.code).toBe("self_author_annotation_in_handle");
		expect(failure.guidance).toBe("Use only u/handle without the (MYSELF) annotation in handle or username arguments.");
	});

	it("does not infer annotation guidance from generic error prose", () => {
		const failure = toolFailurePayload(
			"view_activity",
			{ username: "alice" },
			new Error("A generic failure happened to mention (MYSELF)."),
		);

		expect(failure.code).toBe("tool_error");
		expect(failure.guidance).toBe("Use a username like alice or u/alice.");
	});
});

describe("draw_random_integers execution", () => {
	it("returns the drawn numbers, records the pair, and carries the typed envelope", async () => {
		const recorder = toolExecutionRecorder();

		const result = await executeRandomDraw(recorder, { ranges: [{ min: 1, max: 6 }, { min: 0, max: 1 }] });

		expect(result.name).toBe("draw_random_integers");
		const numbers = result.result as number[];
		expect(numbers).toHaveLength(2);
		expect(numbers[0]).toBeGreaterThanOrEqual(1);
		expect(numbers[0]).toBeLessThanOrEqual(6);
		expect(numbers[1]).toBeGreaterThanOrEqual(0);
		expect(numbers[1]).toBeLessThanOrEqual(1);
		// The provider sees the bare array, exactly as the control promises.
		expect(result.providerResult).toEqual(numbers);
		expect(result.envelope).toEqual({
			kind: "random_integers_drawn",
			ranges: [{ min: 1, max: 6 }, { min: 0, max: 1 }],
			numbers,
		});
		expect(result.effectiveArgs).toBeUndefined();

		expect(recorder.events.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);
		expect(recorder.events[0]?.payload).toEqual({
			name: "draw_random_integers",
			args: { ranges: [{ min: 1, max: 6 }, { min: 0, max: 1 }] },
		});
		expect(recorder.events[1]?.payload).toMatchObject({
			name: "draw_random_integers",
			args: { ranges: [{ min: 1, max: 6 }, { min: 0, max: 1 }] },
			result: numbers,
			envelope: { kind: "random_integers_drawn" },
		});
	});

	it("rewrites the recorded call to the canonical array when a single range was sent", async () => {
		const recorder = toolExecutionRecorder();

		const result = await executeRandomDraw(recorder, { ranges: { min: 3, max: 3 } });

		expect(result.result).toEqual([3]);
		expect(result.effectiveArgs).toEqual({ ranges: [{ min: 3, max: 3 }] });
		expect(recorder.events[0]?.payload).toEqual({
			name: "draw_random_integers",
			args: { ranges: [{ min: 3, max: 3 }] },
		});
		expect(recorder.replacements).toEqual([{
			name: "draw_random_integers",
			args: { ranges: [{ min: 3, max: 3 }] },
		}]);
	});

	it("rewrites the recorded call when a range carried properties normalization drops", async () => {
		const recorder = toolExecutionRecorder();

		const result = await executeRandomDraw(recorder, { ranges: [{ min: 1, max: 6, label: "d6" }] });

		expect(result.effectiveArgs).toEqual({ ranges: [{ min: 1, max: 6 }] });
		expect(recorder.replacements).toEqual([{
			name: "draw_random_integers",
			args: { ranges: [{ min: 1, max: 6 }] },
		}]);
		expect(recorder.events[0]?.payload).toEqual({
			name: "draw_random_integers",
			args: { ranges: [{ min: 1, max: 6 }] },
		});
	});

	it("leaves the recorded call alone when the argument already arrived canonical", async () => {
		const recorder = toolExecutionRecorder();

		const result = await executeRandomDraw(recorder, { ranges: [{ max: 6, min: 1 }] });

		// Property order is not part of the canonical form; only the set of keys
		// and their values is, so this must not churn the replayed call.
		expect(result.effectiveArgs).toBeUndefined();
		expect(recorder.replacements).toEqual([]);
	});

	it("fails with a typed argument error rather than executing a bad range", async () => {
		const recorder = toolExecutionRecorder();

		const error = await executeRandomDraw(recorder, { ranges: [{ min: 6, max: 1 }] }).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(ToolCallArgumentValidationError);
		expect((error as ToolCallArgumentValidationError).code).toBe("bad_request");
		expect(recorder.events).toEqual([]);
	});
});

/**
 * The draw touches no storage and no forum service, so the recorder only has to
 * stand in for the event log; every other runtime capability throws if reached.
 */
function toolExecutionRecorder() {
	const events: BotRuntimeEvent[] = [];
	const replacements: unknown[] = [];
	let seq = 0;
	const unreachable = (capability: string) => () => {
		throw new Error(`draw_random_integers must not use ${capability}.`);
	};
	const runtime: RuntimeToolsRuntime = {
		env: {
			// Handed out but never queried: the drawn envelope yields no seen content,
			// so preparing a statement here would be a real regression.
			BICKR_D1: { prepare: unreachable("a D1 statement") },
			BICKR_KV: { get: unreachable("a KV read"), put: unreachable("a KV write") },
		} as unknown as RuntimeToolsRuntime["env"],
		appendEvent: (runId, type, payload) => {
			seq += 1;
			const event: BotRuntimeEvent = { seq, runId, type, payload, tokenEstimate: 0, createdAt: "2026-09-01T00:00:00.000Z" };
			events.push(event);
			return event;
		},
		replaceEventPayload: (event, payload) => {
			replacements.push(payload);
			const replaced = { ...event, payload };
			const index = events.findIndex((item) => item.seq === event.seq);
			if (index >= 0) {
				events[index] = replaced;
			}
			return replaced;
		},
		throwIfStopped: () => {},
		forumService: unreachable("the forum coordinator"),
		vectorSearchBots: unreachable("vector search"),
		readCommentTreeTokenBudget: unreachable("the comment-tree token budget"),
		providerContentInActiveContext: () => ({ commentsWithText: new Set(), threadsWithText: new Set() }),
		recentToolResultRows: () => [],
		setLastSuccessfulLogOffSeq: unreachable("the log-off marker"),
	};
	return { events, replacements, runtime };
}

async function executeRandomDraw(
	recorder: ReturnType<typeof toolExecutionRecorder>,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const runContext: RunContext = {
		mode: "normal",
		setupMode: "new_iteration",
		signal: new AbortController().signal,
	};
	return new RuntimeTools(recorder.runtime).executeTool(
		randomDrawParticipant(),
		"run_random",
		"draw_random_integers",
		args,
		runContext,
	);
}

function randomDrawParticipant(): RuntimeBotDocument {
	return {
		id: "bot_random",
		type: "bot",
		schemaVersion: 1,
		revision: 1,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		homeWorldId: "wld_random",
		homeWorldHandle: "random-world",
		ownerUserId: "usr_random",
		handle: "roller",
		language: null,
		includeLanguageInSystemPrompt: false,
		displayName: { lang: null, text: "Roller" },
		shortBio: { lang: null, text: "Rolls things." },
		prompt: { lang: null, text: "Persona" },
		inferenceSettings: {},
		toolSettings: {},
		tickSettings: { enabled: true, intervalSeconds: 60, allowEarlyLogOff: true, compactionThreshold: 0.75 },
	};
}

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

function caughtError(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected action to throw.");
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

describe("duplicate reply detection across retained tool results", () => {
	const selfBotId = "bot_self";
	const createdAt = "2026-05-06T12:00:00.000Z";

	function comment(id: string, body: string, authorBotId: string, parentCommentId?: string): CommentDocument {
		return {
			id,
			threadId: "thr_mentions",
			worldId: "wld_primary",
			forumId: "frm_general",
			authorBotId,
			authorHandle: authorBotId === selfBotId ? "me" : "alice",
			authorDisplayName: en(authorBotId === selfBotId ? "Me" : "Alice"),
			...(parentCommentId ? { parentCommentId } : {}),
			body: en(body),
			voteScore: 0,
			createdAt,
			updatedAt: createdAt,
		};
	}

	function thread(...comments: CommentDocument[]): ThreadDocument {
		return {
			id: "thr_mentions",
			type: "thread",
			schemaVersion: 1,
			revision: comments.length,
			createdAt,
			updatedAt: createdAt,
			worldId: "wld_primary",
			worldHandle: "primary",
			forumId: "frm_general",
			forumHandle: "general",
			title: en("Mentions"),
			rootCommentId: "com_root",
			comments,
			commentCount: comments.length,
			voteScore: 0,
			recentCommentCount: comments.length,
			lastActivityAt: createdAt,
		};
	}

	function toolResultRow(payload: Record<string, unknown>): RuntimeRow {
		return {
			seq: 41,
			run_id: "run-earlier",
			type: "tool_result",
			payload_json: JSON.stringify(payload),
			token_estimate: 0,
			compacted_by: null,
			created_at: createdAt,
		};
	}

	/** A row as the reply tool records it today: authored args plus the typed envelope. */
	function replyRow(authoredBody: string, storedBody: string): RuntimeRow {
		const root = comment("com_root", "Who is around?", "bot_alice");
		const reply = comment("com_reply", storedBody, selfBotId, root.id);
		const replyThread = thread(root, reply);
		return toolResultRow({
			name: "reply_to_comment",
			args: { commentId: root.id, body: en(authoredBody) },
			result: { thread: replyThread, comment: reply },
			envelope: { kind: "comment_created", thread: replyThread, comment: reply },
		});
	}

	it("rejects a verbatim repeat whose stored mention the writer canonicalized", () => {
		// The stored body can no longer stand in for the authored one, so the
		// guard has to compare what this participant wrote both times.
		const authored = "Good point, @alice!";
		const rows = [replyRow(authored, "Good point, u/alice!")];

		const error = duplicateReplyError(() => assertNoDuplicateReplyInToolResultRows(rows, selfBotId, authored));

		expect(error.duplicate).toEqual({
			threadId: "thr_mentions",
			commentId: "com_reply",
			urlPath: "/w/primary/f/general/t/thr_mentions/c/com_reply",
			seq: 41,
		});
		expect(error.message).toContain("/w/primary/f/general/t/thr_mentions/c/com_reply");
	});

	it("rejects a verbatim repeat that carries no mention", () => {
		const authored = "Same thing again.";
		const rows = [replyRow(authored, authored)];

		expect(duplicateReplyError(() => assertNoDuplicateReplyInToolResultRows(rows, selfBotId, authored)).duplicate.commentId)
			.toBe("com_reply");
	});

	it("rejects a repeat that differs only in surrounding whitespace", () => {
		const rows = [replyRow("Good point, @alice!", "Good point, u/alice!")];

		expect(() => assertNoDuplicateReplyInToolResultRows(rows, selfBotId, "\nGood point, @alice!  "))
			.toThrow(DuplicateReplyError);
	});

	it("allows a different reply body and another participant's identical comment", () => {
		const rows = [replyRow("Good point, @alice!", "Good point, u/alice!")];

		expect(() => assertNoDuplicateReplyInToolResultRows(rows, selfBotId, "Good point, @bob!")).not.toThrow();
		expect(() => assertNoDuplicateReplyInToolResultRows(rows, "bot_other", "Good point, @alice!")).not.toThrow();
	});

	it("still matches the stored body of a row written before authored args were retained", () => {
		// Such a row also predates canonicalization, so its stored body is the
		// authored text and is the only thing left to compare against.
		const root = comment("com_root", "Who is around?", "bot_alice");
		const reply = comment("com_reply", "Legacy reply text.", selfBotId, root.id);
		const rows = [toolResultRow({ name: "reply_to_thread", result: { thread: thread(root, reply) } })];

		expect(duplicateReplyError(() => assertNoDuplicateReplyInToolResultRows(rows, selfBotId, "Legacy reply text.")).duplicate.commentId)
			.toBe("com_reply");
		expect(() => assertNoDuplicateReplyInToolResultRows(rows, selfBotId, "Legacy reply text, revised.")).not.toThrow();
	});

	function duplicateReplyError(run: () => void): DuplicateReplyError {
		try {
			run();
		} catch (error) {
			if (error instanceof DuplicateReplyError) {
				return error;
			}
			throw error;
		}
		throw new Error("Expected a duplicate reply to be rejected.");
	}
});
