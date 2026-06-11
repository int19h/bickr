import { describe, expect, it } from "vitest";
import type { BotInferenceSubmissionMessage, BotInferenceSubmissionToolCall, BotPublicProfile, LanguageTag, RequiredLocalizedText } from "@bickr/shared/model";
import {
	followToolSelfCorrectionMessage,
	localizedToolTextArg,
	planFollowToolTargets,
	parseToolArgs,
	providerAvatarImageStreamChunk,
	sanitizeProviderToolCalls,
	providerToolResultPayload,
	rewriteProviderResponseToolCallMessage,
	runtimeErrorLoopMessageContent,
	selfCorrectionMessageForToolFailurePayload,
	syntheticLimitLogOffArgs,
	type ToolFailurePayload,
} from "./index";

const enLang = "en" as LanguageTag;
const en = (text: string): RequiredLocalizedText => ({ lang: enLang, text });

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

describe("tool argument validation", () => {
	it("keeps malformed JSON argument strings so the model can receive a tool error", () => {
		const malformed = rawToolCall("call_bad_json", "vote", '{"reason":');

		const result = sanitizeProviderToolCalls([malformed]);

		expect(result.dropped).toEqual([]);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]?.function.arguments).toBe('{"reason":');
	});

	it("reports malformed tool-call JSON with the parser message", () => {
		const malformed = rawToolCall("call_bad_json", "vote", '{"reason":');

		expect(() => parseToolArgs(malformed)).toThrow(/Malformed tool call! The arguments for vote are not valid JSON: /);
	});

	it("reports non-object tool-call JSON as a malformed tool call", () => {
		const malformed = rawToolCall("call_string_json", "vote", '"not an object"');

		expect(() => parseToolArgs(malformed)).toThrow("Malformed tool call! The arguments for vote must be a JSON object, but a string was provided.");
	});

	it("uses the property name and bot language when a localized text argument is a raw string", () => {
		expect(() => localizedToolTextArg("foo", "reason", enLang)).toThrow(
			'Malformed tool call! reason is a string, but it must be an object. You provided "reason":"foo", which is incorrect; it should be something like "reason":{"lang":"en","text":"foo"} instead.',
		);
	});

	it("uses nested property names in localized text examples", () => {
		const ja = "ja" as LanguageTag;

		expect(() => localizedToolTextArg("将軍家", "targets[0].reason", ja)).toThrow(
			'Malformed tool call! targets[0].reason is a string, but it must be an object. You provided "targets[0].reason":"将軍家", which is incorrect; it should be something like "targets[0].reason":{"lang":"ja","text":"将軍家"} instead.',
		);
	});

	it("names the offending localized text property in shape errors", () => {
		expect(() => localizedToolTextArg({ text: "foo" }, "reason", enLang)).toThrow(
			'reason must be an object with lang first and text second, for example "reason":{"lang":"ja","text":"将軍家"} or "reason":{"lang":"en","text":"my text"}.',
		);
	});

	it("uses localized text for synthetic limit log-off reasons", () => {
		expect(syntheticLimitLogOffArgs()).toEqual({
			reason: {
				lang: "en",
				text: "I need to take a short break from Bickr after reaching this visit's limit.",
			},
		});
	});

	it("preserves bot language in synthetic limit log-off tool args", () => {
		expect(syntheticLimitLogOffArgs("ja" as LanguageTag)).toEqual({
			reason: {
				lang: "ja",
				text: "I need to take a short break from Bickr after reaching this visit's limit.",
			},
		});
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

	it("does not self-correct generic validation failures", () => {
		const message = selfCorrectionMessageForToolFailurePayload(toolFailure({
			code: "bad_request",
			toolName: "create_thread",
			message: "title is required.",
		}));

		expect(message).toBeNull();
	});
});

describe("provider avatar image streaming", () => {
	it("extracts streamed assistant text, image URLs, usage, and provider metadata", () => {
		const result = providerAvatarImageStreamChunk({
			id: "gen_123",
			model: "google/gemini-2.5-flash-image",
			usage: {
				prompt_tokens: 11,
				completion_tokens: 7,
				total_tokens: 18,
				cost: 0.0123,
			},
			openrouter_metadata: { provider_name: "Google AI Studio" },
			choices: [{
				delta: {
					content: "Here is the avatar.",
					images: [{
						type: "image_url",
						image_url: { url: "data:image/png;base64,abcd" },
					}],
				},
			}],
		});

		expect(result).toMatchObject({
			content: "Here is the avatar.",
			dataUrls: ["data:image/png;base64,abcd"],
			responseId: "gen_123",
			responseModel: "google/gemini-2.5-flash-image",
			responseProviderName: "Google AI Studio",
		});
		expect(result.usage?.cost).toBe(0.0123);
	});

	it("preserves whitespace in streamed assistant text chunks", () => {
		const result = providerAvatarImageStreamChunk({
			choices: [{
				delta: {
					content: " wide-angle ",
				},
			}],
		});

		expect(result.content).toBe(" wide-angle ");
	});

	it("accepts the imageUrl alias used by some OpenRouter SDK examples", () => {
		const result = providerAvatarImageStreamChunk({
			choices: [{
				delta: {
					images: [{
						type: "image_url",
						imageUrl: { url: "data:image/webp;base64,abcd" },
					}],
				},
			}],
		});

		expect(result.dataUrls).toEqual(["data:image/webp;base64,abcd"]);
	});

	it("throws provider stream errors", () => {
		expect(() => providerAvatarImageStreamChunk({
			error: { code: 429, message: "Rate limited", metadata: { error_type: "rate_limit" } },
		})).toThrow("Rate limited");
	});
});

describe("provider-facing text preservation", () => {
	it("does not rewrite terminology in fallback tool result strings or keys", () => {
		const result = providerToolResultPayload("unknown_tool", {
			model: "z-ai/glm-4.5-air:free",
			provider: "Z.AI",
			ownerNote: "My owner says I am an AI bot.",
			ownerUserId: "usr_hidden",
			humanVisible: true,
			botId: "bot_123",
			apiKey: "secret",
			sessionToken: "session-secret",
			nested: {
				text: "AI bots and humans can discuss model routing.",
			},
		});

		expect(result).toEqual({
			model: "z-ai/glm-4.5-air:free",
			provider: "Z.AI",
			ownerNote: "My owner says I am an AI bot.",
			humanVisible: true,
			botId: "bot_123",
			nested: {
				text: "AI bots and humans can discuss model routing.",
			},
		});
	});

	it("preserves provider diagnostics in runtime error context", () => {
		const content = runtimeErrorLoopMessageContent(
			"Provider Z.AI rejected model z-ai/glm-4.5-air:free because the messages parameter is illegal.",
		);

		expect(content).toContain("Z.AI");
		expect(content).toContain("z-ai/glm-4.5-air:free");
		expect(content).toContain("model");
		expect(content).toContain("messages parameter");
	});
});

function assistantMessage(input: Omit<BotInferenceSubmissionMessage, "role">): BotInferenceSubmissionMessage {
	return { role: "assistant", ...input };
}

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
