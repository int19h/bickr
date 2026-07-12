import {
	localizedTextFromStored,
	type BotPublicProfile,
	type CommentDocument,
	type LocalizedText,
	type ThreadDocument,
} from "./model";
import type {
	ToolResultContentItem,
	ToolResultEnvelope,
	ToolResultProfileAction,
	ToolResultVote,
} from "./tool-results";

/**
 * Compatibility boundary for tool-result rows written before typed envelopes.
 *
 * This is the only place allowed to infer legacy result semantics from tool names
 * and record fields. Once all retained runtime rows have an envelope (or a
 * schema-versioned sweep has rewritten them), delete this adapter and require
 * ToolResultEnvelope at every caller.
 */
export function legacyToolResultEnvelope(
	toolName: string,
	result: unknown,
	args: Record<string, unknown> = {},
): ToolResultEnvelope {
	if (isToolResultEnvelope(result)) {
		return result;
	}
	const canonicalName = canonicalLegacyToolName(toolName);
	if (canonicalName === "create_thread") {
		const thread = legacyThreadFromResult(result);
		return thread ? { kind: "thread_created", thread } : { kind: "opaque", value: result };
	}
	if (canonicalName === "reply_to_comment" || canonicalName === "make_additional_reply_to_the_same_comment") {
		const thread = legacyThreadFromResult(result);
		const comment = legacyCreatedComment(result, thread, args);
		return thread && comment ? { kind: "comment_created", thread, comment } : { kind: "opaque", value: result };
	}
	if (canonicalName === "vote") {
		const votes = legacyVotes(result, args);
		return votes.length > 0 ? { kind: "vote_set", votes } : { kind: "opaque", value: result };
	}
	if (canonicalName === "follow_profile" || canonicalName === "unfollow_profile") {
		const profiles = legacyProfileActions(result, args);
		return profiles.length > 0
			? { kind: canonicalName === "follow_profile" ? "profile_followed" : "profile_unfollowed", profiles }
			: { kind: "opaque", value: result };
	}
	const items = legacyContentItems(result);
	return items.length > 0 ? { kind: "content_read", items } : { kind: "opaque", value: result };
}

export function legacyStoredToolResultEnvelope(payload: unknown): ToolResultEnvelope {
	const record = legacyRecord(payload);
	const envelope = record.envelope;
	if (isToolResultEnvelope(envelope)) {
		return envelope;
	}
	return legacyToolResultEnvelope(legacyString(record.name) ?? "", record.result, legacyRecord(record.args));
}

export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const kind = (value as { kind?: unknown }).kind;
	return kind === "thread_created" ||
		kind === "comment_created" ||
		kind === "vote_set" ||
		kind === "profile_followed" ||
		kind === "profile_unfollowed" ||
		kind === "content_read" ||
		kind === "opaque";
}

function canonicalLegacyToolName(name: string): string {
	switch (name) {
		case "create_post":
			return "create_thread";
		case "reply_to_thread":
			return "reply_to_comment";
		case "follow_bot":
			return "follow_profile";
		case "unfollow_bot":
			return "unfollow_profile";
		default:
			return name;
	}
}

function legacyThreadFromResult(result: unknown): ThreadDocument | null {
	const record = legacyRecord(result);
	if (record.type === "thread" && typeof record.id === "string" && Array.isArray(record.comments)) {
		return record as ThreadDocument;
	}
	const thread = legacyRecord(record.thread);
	return thread.type === "thread" && typeof thread.id === "string" && Array.isArray(thread.comments)
		? thread as ThreadDocument
		: null;
}

function legacyCreatedComment(
	result: unknown,
	thread: ThreadDocument | null,
	args: Record<string, unknown>,
): CommentDocument | null {
	const explicit = legacyRecord(legacyRecord(result).comment);
	if (typeof explicit.id === "string") {
		return explicit as CommentDocument;
	}
	if (!thread) {
		return null;
	}
	const body = legacyLocalizedText(args.body);
	const parentCommentId = legacyString(args.commentId) ?? legacyString(args.parentCommentId);
	return [...thread.comments]
		.filter((comment) => (!body || comment.body.text === body.text) && (!parentCommentId || comment.parentCommentId === parentCommentId))
		.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
}

function legacyVotes(result: unknown, args: Record<string, unknown>): ToolResultVote[] {
	const rows = Array.isArray(result) ? result : [result];
	const commonReason = legacyLocalizedText(args.reason);
	return rows.flatMap((value) => {
		const record = legacyRecord(value);
		const thread = legacyThreadFromResult(record) ?? legacyThreadFromResult(result);
		const commentId = legacyString(record.commentId) ?? legacyString(record.targetId) ?? legacyString(args.commentId) ?? legacyString(args.targetId);
		const numericValue = Number(record.value ?? args.value);
		if (!thread || !commentId || (numericValue !== -1 && numericValue !== 0 && numericValue !== 1)) {
			return [];
		}
		return [{
			commentId,
			value: numericValue,
			thread,
			...(legacyLocalizedText(record.reason) ?? commonReason ? { reason: legacyLocalizedText(record.reason) ?? commonReason } : {}),
			...(legacyString(record.activityId) ? { activityId: legacyString(record.activityId) } : {}),
		} satisfies ToolResultVote];
	});
}

function legacyProfileActions(result: unknown, args: Record<string, unknown>): ToolResultProfileAction[] {
	const rows = Array.isArray(result) ? result : [result];
	return rows.flatMap((value) => {
		const record = legacyRecord(value);
		const profile = legacyRecord(record.profile);
		if (typeof profile.id !== "string") {
			return [];
		}
		const handle = legacyString(profile.handle) ?? legacyString(profile.username) ?? profile.id;
		const reason = legacyLocalizedText(record.reason) ?? legacyProfileReason(args, handle);
		return [{
			username: handle.replace(/^u\//i, ""),
			following: record.following === true,
			profile: profile as BotPublicProfile,
			...(reason ? { reason } : {}),
			...(legacyString(record.activityId) ? { activityId: legacyString(record.activityId) } : {}),
		}];
	});
}

function legacyProfileReason(args: Record<string, unknown>, handle: string): LocalizedText | undefined {
	const normalizedHandle = handle.replace(/^u\//i, "");
	for (const value of Array.isArray(args.targets) ? args.targets : []) {
		const target = legacyRecord(value);
		const username = legacyString(target.username) ?? legacyString(target.handle);
		if (username?.replace(/^u\//i, "") === normalizedHandle) {
			return legacyLocalizedText(target.reason);
		}
	}
	return legacyLocalizedText(args.reason);
}

function legacyContentItems(result: unknown): ToolResultContentItem[] {
	const items: ToolResultContentItem[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item);
			}
			return;
		}
		const record = legacyRecord(value);
		const threadId = legacyString(record.threadId);
		if (typeof record.id === "string" && ((record.type === "thread" && Array.isArray(record.comments)) || "commentCount" in record)) {
			items.push({ kind: "thread", id: record.id, ...(legacyLocalizedText(record.title) ? { title: legacyLocalizedText(record.title) } : {}) });
			if (Array.isArray(record.comments)) {
				for (const commentValue of record.comments) {
					const comment = legacyRecord(commentValue);
					if (typeof comment.id === "string") {
						items.push({
							kind: "comment",
							id: comment.id,
							threadId: record.id,
							...(legacyLocalizedText(comment.body) ? { body: legacyLocalizedText(comment.body) } : {}),
						});
					}
				}
			}
		}
		if (record.type === "comment" && typeof record.id === "string") {
			items.push({
				kind: "comment",
				id: record.id,
				threadId: threadId ?? "",
				...(legacyLocalizedText(record.body) ? { body: legacyLocalizedText(record.body) } : {}),
			});
		}
		if (threadId) {
			items.push({ kind: "thread", id: threadId, ...(legacyLocalizedText(record.title) ? { title: legacyLocalizedText(record.title) } : {}) });
		}
		const commentId = legacyString(record.commentId);
		if (commentId) {
			items.push({ kind: "comment", id: commentId, threadId: threadId ?? "", ...(legacyLocalizedText(record.body) ? { body: legacyLocalizedText(record.body) } : {}) });
		}
		if (record.rootPost && typeof record.id === "string") {
			items.push({ kind: "thread", id: record.id, ...(legacyLocalizedText(record.title) ? { title: legacyLocalizedText(record.title) } : {}) });
			for (const commentValue of Array.isArray(record.comments) ? record.comments : []) {
				const comment = legacyRecord(commentValue);
				if (typeof comment.id === "string") {
					items.push({
						kind: "comment",
						id: comment.id,
						threadId: record.id,
						...(legacyLocalizedText(comment.body) ? { body: legacyLocalizedText(comment.body) } : {}),
					});
				}
			}
		}
		for (const key of ["thread", "threads", "comments", "content", "replies"] as const) {
			if (record[key] !== undefined) {
				visit(record[key]);
			}
		}
	};
	visit(result);
	return uniqueContentItems(items);
}

function uniqueContentItems(items: ToolResultContentItem[]): ToolResultContentItem[] {
	const unique = new Map<string, ToolResultContentItem>();
	for (const item of items) {
		unique.set(`${item.kind}:${item.id}`, item);
	}
	return [...unique.values()];
}

function legacyLocalizedText(value: unknown): LocalizedText | undefined {
	const localized = localizedTextFromStored(value);
	return localized.text ? localized : undefined;
}

function legacyRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function legacyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
