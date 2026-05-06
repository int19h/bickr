import type { BotRuntimeEvent } from "@bickr/shared/model";
import { handlePatternSource, normalizeHandleText } from "@bickr/shared/validation";

export type RuntimeActivityKind =
	| "assistant"
	| "compaction"
	| "error"
	| "input"
	| "provider"
	| "reasoning"
	| "system"
	| "tick"
	| "tool";

export type ToolDisplayItem = {
	key: string;
	label: string;
	detail?: string;
	href?: string;
};

export type ToolDisplay = {
	items: ToolDisplayItem[];
	variant?: "error";
};

export type RuntimeActivity = {
	id: string;
	seq: number;
	seqLabel?: string;
	createdAt: string;
	kind: RuntimeActivityKind;
	title: string;
	body?: string;
	meta?: string;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	toolDisplay?: ToolDisplay;
	payload?: unknown;
	raw?: unknown;
	streaming?: boolean;
};

export function activityRuntimeSeqs(activity: RuntimeActivity): number[] {
	return activitySeqs(activity, (seq) => Number.isFinite(seq));
}

export function activityEventSeqs(activity: RuntimeActivity): number[] {
	return activitySeqs(activity, (seq) => Number.isInteger(seq));
}

function activitySeqs(activity: RuntimeActivity, includeSeq: (seq: number) => boolean): number[] {
	const raw = runtimeRecord(activity.raw);
	const seqs: number[] = [];
	if (Array.isArray(raw.events)) {
		for (const event of raw.events) {
			const seq = runtimeRecord(event).seq;
			if (typeof seq === "number" && includeSeq(seq)) {
				seqs.push(seq);
			}
		}
	}
	const rawSeq = raw.seq;
	if (typeof rawSeq === "number" && includeSeq(rawSeq)) {
		seqs.push(rawSeq);
	}
	if (includeSeq(activity.seq) && (activity.seqLabel !== "live" || !Number.isInteger(activity.seq))) {
		seqs.push(activity.seq);
	}
	return [...new Set(seqs)].sort((left, right) => left - right);
}

export function runtimeActivities(events: BotRuntimeEvent[], fallbackWorldHandle = ""): RuntimeActivity[] {
	const activities: RuntimeActivity[] = [];
	const turnByRun = new Map<string, number>();
	const streams = new Map<string, RuntimeActivity>();

	for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
		const payload = runtimeRecord(event.payload);
		switch (event.type) {
			case "tick_started":
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tick",
					title: "Tick started",
					meta: stringValue(payload.trigger) ? `trigger: ${stringValue(payload.trigger)}` : undefined,
					raw: event,
				});
				break;
			case "input":
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "input",
					title: "Loop input",
					body: describeLoopInput(payload),
					raw: event,
				});
				break;
			case "provider_request": {
				finishRunStreams(streams, event.runId);
				const turn = (turnByRun.get(event.runId) ?? 0) + 1;
				turnByRun.set(event.runId, turn);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "provider",
					title: "Inference request",
					meta: providerRequestMeta(payload),
					raw: event,
				});
				break;
			}
			case "provider_token_probe":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "provider",
					title: "Token budget check",
					meta: providerTokenProbeMeta(payload),
					raw: event,
				});
				break;
			case "provider_token_estimate":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "provider",
					title: "Token budget estimate",
					meta: providerTokenProbeMeta(payload),
					raw: event,
				});
				break;
			case "provider_retry":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "provider",
					title: "Inference retry",
					body: stringValue(payload.reason),
					meta: `attempt ${stringValue(payload.attempt) ?? "?"}/${stringValue(payload.maxAttempts) ?? "?"} after ${formatDelay(payload.delayMs)}`,
					raw: event,
				});
				break;
			case "provider_tool_call_dropped": {
				finishRunStreams(streams, event.runId);
				const count = Math.max(1, Math.floor(numberValue(payload.count) ?? 1));
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "provider",
					title: "Invalid page control ignored",
					body: `Bickr Terminal ignored ${count} invalid page-control request${count === 1 ? "" : "s"}.`,
					meta: stringValue(payload.retrying) === "true" ? "retrying inference" : undefined,
					payload: event.payload,
					raw: event,
				});
				break;
			}
			case "provider_delta":
				appendProviderDelta(activities, streams, turnByRun, event, payload);
				break;
			case "reasoning_message":
				upsertReasoningMessage(activities, streams, turnByRun, event, payload);
				break;
			case "assistant_message":
				upsertAssistantMessage(activities, streams, turnByRun, event, payload);
				break;
			case "tool_call": {
				const name = stringValue(payload.name) ?? "unknown_tool";
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tool",
					title: toolCallTitle(name, payload.args),
					body: toolReasonBody(payload.args),
					toolName: name,
					args: payload.args,
					raw: event,
				});
				break;
			}
			case "tool_result": {
				const name = stringValue(payload.name) ?? "unknown_tool";
				const summary = toolResultSummary(name, payload.args, payload.result, fallbackWorldHandle);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tool",
					title: summary.title,
					body: summary.body,
					toolDisplay: summary.display,
					toolName: name,
					args: payload.args,
					result: payload.result,
					raw: event,
				});
				break;
			}
			case "compaction":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "compaction",
					title: compactionTitle(payload),
					body: stringValue(payload.error),
					payload: event.payload,
					raw: event,
				});
				break;
			case "thought_injected":
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "input",
					title: "Thought injected",
					body: stringValue(payload.text),
					raw: event,
				});
				break;
			case "tick_stop_requested":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tick",
					title: "Stop requested",
					body: stringValue(payload.message),
					raw: event,
				});
				break;
			case "tick_stopped":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tick",
					title: "Tick stopped",
					body: stringValue(payload.message),
					raw: event,
				});
				break;
			case "tick_completed":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "tick",
					title: "Tick completed",
					meta: stringValue(payload.nextDueAt) ? `next due: ${new Date(String(payload.nextDueAt)).toLocaleString()}` : undefined,
					raw: event,
				});
				break;
			case "tick_failed":
				finishRunStreams(streams, event.runId);
				activities.push({
					id: `event-${event.seq}`,
					seq: event.seq,
					createdAt: event.createdAt,
					kind: "error",
					title: "Tick failed",
					body: stringValue(payload.message) ?? formatPayload(event.payload),
					raw: event,
				});
				break;
		}
	}

	return activities;
}

type ToolResultSummary = {
	title: string;
	body?: string;
	display?: ToolDisplay;
};

function appendProviderDelta(
	activities: RuntimeActivity[],
	streams: Map<string, RuntimeActivity>,
	turnByRun: Map<string, number>,
	event: BotRuntimeEvent,
	payload: Record<string, unknown>,
): void {
	const kind = stringValue(payload.kind);
	const text = stringValue(payload.text);
	if (!text || (kind !== "content" && kind !== "reasoning")) {
		return;
	}
	const turn = turnByRun.get(event.runId) ?? 0;
	const streamKey = `${event.runId}:${turn}:${kind}`;
	let activity = streams.get(streamKey);
	if (!activity) {
		activity = {
			id: `stream-${streamKey}`,
			seq: event.seq,
			seqLabel: payload.ephemeral === true ? "live" : undefined,
			createdAt: event.createdAt,
			kind: kind === "reasoning" ? "reasoning" : "assistant",
			title: kind === "reasoning" ? "Thought" : "Reasoning",
			body: "",
			raw: {
				streamKey,
				events: [event],
			},
			streaming: true,
		};
		streams.set(streamKey, activity);
		activities.push(activity);
	} else {
		appendRawStreamEvent(activity, event);
	}
	activity.body = `${activity.body ?? ""}${text}`;
}

function finishRunStreams(streams: Map<string, RuntimeActivity>, runId: string): void {
	for (const [key, activity] of streams) {
		if (key.startsWith(`${runId}:`)) {
			activity.streaming = false;
		}
	}
}

function upsertReasoningMessage(
	activities: RuntimeActivity[],
	streams: Map<string, RuntimeActivity>,
	turnByRun: Map<string, number>,
	event: BotRuntimeEvent,
	payload: Record<string, unknown>,
): void {
	const content = stringValue(payload.content) ?? "";
	const turn = turnByRun.get(event.runId) ?? 0;
	const stream = streams.get(`${event.runId}:${turn}:reasoning`);
	if (stream) {
		stream.body = content;
		stream.streaming = false;
		stream.meta = stringValue(payload.status) === "interrupted" ? "interrupted" : undefined;
		appendRawStreamEvent(stream, event);
		return;
	}
	activities.push({
		id: `event-${event.seq}`,
		seq: event.seq,
		createdAt: event.createdAt,
		kind: "reasoning",
		title: "Thought",
		body: content,
		meta: stringValue(payload.status) === "interrupted" ? "interrupted" : undefined,
		raw: event,
	});
}

function upsertAssistantMessage(
	activities: RuntimeActivity[],
	streams: Map<string, RuntimeActivity>,
	turnByRun: Map<string, number>,
	event: BotRuntimeEvent,
	payload: Record<string, unknown>,
): void {
	const content = stringValue(payload.content) ?? "";
	const turn = turnByRun.get(event.runId) ?? 0;
	const reasoningStream = streams.get(`${event.runId}:${turn}:reasoning`);
	if (reasoningStream) {
		reasoningStream.streaming = false;
	}
	const stream = streams.get(`${event.runId}:${turn}:content`);
	if (stream) {
		stream.body = content;
		stream.streaming = false;
		stream.meta = stringValue(payload.status) === "interrupted" ? "interrupted" : undefined;
		appendRawStreamEvent(stream, event);
		return;
	}
	activities.push({
		id: `event-${event.seq}`,
		seq: event.seq,
		createdAt: event.createdAt,
		kind: "assistant",
		title: "Reasoning",
		body: content,
		meta: stringValue(payload.status) === "interrupted" ? "interrupted" : undefined,
		raw: event,
	});
}

function appendRawStreamEvent(activity: RuntimeActivity, event: BotRuntimeEvent): void {
	const raw = runtimeRecord(activity.raw);
	if (Array.isArray(raw.events)) {
		raw.events.push(event);
	}
}

function describeLoopInput(payload: Record<string, unknown>): string {
	const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
	const injections = Array.isArray(payload.injections) ? payload.injections : [];
	const lines = [
		`${notifications.length} notification${notifications.length === 1 ? "" : "s"}`,
		`${injections.length} injection${injections.length === 1 ? "" : "s"}`,
		payload.ping === true ? "ping" : "",
	].filter(Boolean);
	const displayNotifications = dedupeNotificationAuthorBios(
		notifications.map((notification) => {
			const record = runtimeRecord(notification);
			return {
				notification,
				message: stringValue(record.message) ?? formatPayload(notification, 240),
				type: stringValue(record.type) ?? "notification",
			};
		}),
	);
	const notificationLines = displayNotifications.slice(0, 6).map((notification) => {
		return `- ${notification.type}: ${notification.message}`;
	});
	const injectionLines = injections.slice(0, 4).map((injection) => `- injection: ${String(injection)}`);
	return [lines.join(" · "), ...notificationLines, ...injectionLines].filter(Boolean).join("\n");
}

function dedupeNotificationAuthorBios<T extends { message: string }>(notifications: T[]): T[] {
	const seenHandles = new Set<string>();
	return notifications.map((notification) => {
		const handle = authorHandleWithBio(notification.message);
		if (!handle) {
			return notification;
		}
		if (!seenHandles.has(handle)) {
			seenHandles.add(handle);
			return notification;
		}
		return {
			...notification,
			message: stripNotificationAuthorBio(notification.message),
		};
	});
}

const notificationAuthorBioPattern = new RegExp(`\\(u\\/(${handlePatternSource})\\)\\nShort bio:`, "iu");

function authorHandleWithBio(message: string): string | null {
	const match = notificationAuthorBioPattern.exec(message);
	return match?.[1] ? normalizeHandleText(match[1]) : null;
}

function stripNotificationAuthorBio(message: string): string {
	return message.replace(/\nShort bio: [\s\S]*?(?= (?:replied in|mentioned you in) ")/, "");
}

function toolCallTitle(name: string, args: unknown): string {
	const canonical = canonicalToolName(name);
	const record = runtimeRecord(args);
	switch (canonical) {
		case "create_thread":
			return `Creating a thread in f/${stringValue(record.forumHandle) ?? "..."}`;
		case "reply_to_comment":
			return `Replying to comment ${shortId(stringValue(record.commentId ?? record.parentCommentId))}`;
		case "vote":
			return bulkVoteTitle(record);
		case "read_thread":
		case "read_thread_by_id":
			return `Reading thread ${shortId(stringValue(record.threadId))}`;
		case "read_comment_by_id":
			return `Reading comment ${shortId(stringValue(record.commentId))}`;
		case "list_accessible_forums":
			return "Listing public forums";
		case "list_recent_threads":
			return `Listing recent threads in f/${stringValue(record.forumHandle) ?? "..."}`;
		case "list_hot_threads":
			return "Listing hot threads";
		case "search_threads":
		case "search_threads_semantic":
			return `Searching threads and comments for "${stringValue(record.query) ?? ""}"`;
		case "search_profiles":
			return `Searching profiles for "${stringValue(record.query) ?? ""}"`;
		case "view_profiles":
			return `Viewing ${stringArrayValue(record.usernames).join(", ") || "profiles"}`;
		case "view_activity":
			return `Viewing u/${stringValue(record.username) ?? "..."}'s activity`;
		case "follow_profile":
			return bulkProfileTitle("Following", record);
		case "unfollow_profile":
			return bulkProfileTitle("Unfollowing", record);
		case "log_off":
			return "Logging off";
		default:
			return `Using ${canonical}`;
	}
}

function toolResultSummary(name: string, args: unknown, result: unknown, fallbackWorldHandle: string): ToolResultSummary {
	const canonical = canonicalToolName(name);
	const record = runtimeRecord(result);
	if (record.ok === false) {
		return failedToolResultSummary(canonical, args, record);
	}

	const thread = threadRecord(result);
	if (canonical === "create_thread" && thread) {
		const items = [openThreadItem(thread, fallbackWorldHandle)].filter(isDisplayItem);
		return resultWithDisplay(`Created "${thread.title ?? "thread"}"`, threadFacts(thread), items);
	}
	if (canonical === "reply_to_comment" && thread) {
		const parentCommentId = stringValue(runtimeRecord(args).commentId ?? runtimeRecord(args).parentCommentId);
		const details = [threadFacts(thread), parentCommentId ? `Parent comment ${shortId(parentCommentId)}` : ""].filter(Boolean);
		const items = [openThreadItem(thread, fallbackWorldHandle)].filter(isDisplayItem);
		return resultWithDisplay(`Reply created in "${thread.title ?? "thread"}"`, details.join("\n"), items);
	}
	if ((canonical === "read_thread" || canonical === "read_thread_by_id") && thread) {
		const items = [openThreadItem(thread, fallbackWorldHandle)].filter(isDisplayItem);
		return resultWithDisplay(`Read "${thread.title ?? "thread"}"`, threadFacts(thread), items);
	}
	if (canonical === "read_comment_by_id") {
		const target = stringValue(record.targetCommentId) ?? stringValue(runtimeRecord(args).commentId);
		const displayThread = threadRecord({ thread: record.thread });
		const details = [
			displayThread?.title ? `In "${displayThread.title}"` : "",
			displayThread ? threadFacts(displayThread) : "",
		].filter(Boolean).join("\n");
		const items = [openCommentItem(displayThread, target, fallbackWorldHandle)].filter(isDisplayItem);
		return resultWithDisplay(`Read comment ${shortId(target)}`, details, items);
	}
	if (canonical === "list_accessible_forums" && Array.isArray(result)) {
		const items = result.map((item, index) => forumItem(runtimeRecord(item), index, fallbackWorldHandle));
		return resultWithDisplay("Listed public forums", itemsBody(items, "No public forums returned."), items);
	}
	if (canonical === "list_recent_threads" && Array.isArray(result)) {
		const forumHandle = stringValue(runtimeRecord(args).forumHandle) ?? "...";
		const items = result.map((item, index) => threadListItem(runtimeRecord(item), index, fallbackWorldHandle));
		return resultWithDisplay(`Listed recent threads in f/${forumHandle}`, itemsBody(items, "No recent threads returned."), items);
	}
	if (canonical === "list_hot_threads" && Array.isArray(result)) {
		const items = result.map((item, index) => threadListItem(runtimeRecord(item), index, fallbackWorldHandle));
		return resultWithDisplay("Listed hot threads", itemsBody(items, "No hot threads returned."), items);
	}
	if ((canonical === "search_threads" || canonical === "search_threads_semantic") && Array.isArray(result)) {
		const query = stringValue(runtimeRecord(args).query) ?? "";
		const items = result.map((item, index) => threadSearchItem(runtimeRecord(item), index, fallbackWorldHandle));
		return resultWithDisplay(`Thread search results for "${query}"`, itemsBody(items, "No matching threads or comments returned."), items);
	}
	if (canonical === "search_profiles" && Array.isArray(result)) {
		const query = stringValue(runtimeRecord(args).query) ?? "";
		const items = result.map((item, index) => profileItem(runtimeRecord(item), index, fallbackWorldHandle));
		return resultWithDisplay(`Profile search results for "${query}"`, itemsBody(items, "No matching profiles returned."), items);
	}
	if (canonical === "view_profiles") {
		const profiles = Array.isArray(record.profiles) ? record.profiles.map(runtimeRecord) : [record];
		const items = profiles.map((profile, index) => profileItem(profile, index, fallbackWorldHandle, "Open profile")).filter(isDisplayItem);
		const labels = profiles.map(profileLabel).filter(Boolean).join(", ");
		return resultWithDisplay(`Viewed ${labels || "profiles"}`, itemsBody(items, "No profiles returned."), items);
	}
	if (canonical === "view_activity") {
		const profile = runtimeRecord(record.bot ?? record.profile);
		const activities = Array.isArray(record.activities) ? record.activities.map(runtimeRecord) : [];
		const items = [
			profileItem(profile, 0, fallbackWorldHandle, "Open profile"),
			...activities.map((activity, index) => activityItem(activity, index + 1, fallbackWorldHandle)),
		].filter(isDisplayItem);
		const title = `Viewed ${profileLabel(profile)}'s activity`;
		return resultWithDisplay(title, itemsBody(items, "No recent activity returned."), items);
	}
	if (canonical === "follow_profile" || canonical === "unfollow_profile") {
		if (Array.isArray(result)) {
			const rows = result.map(runtimeRecord);
			const items = rows.map((row, index) => profileItem(runtimeRecord(row.profile), index, fallbackWorldHandle, "Open profile"));
			const action = canonical === "follow_profile" ? "Followed" : "Unfollowed";
			const status = canonical === "follow_profile" ? "Following" : "Not following";
			return resultWithDisplay(
				`${action} ${countLabel(rows.length, "profile")}`,
				[toolReasonBody(args), rows.map((row) => `${profileLabel(runtimeRecord(row.profile))} - ${status}`).join("\n")].filter(Boolean).join("\n"),
				items,
			);
		}
		const profile = runtimeRecord(record.profile);
		const item = profileItem(profile, 0, fallbackWorldHandle, "Open profile");
		const status = record.following === true ? "Following" : "Not following";
		const title = `${canonical === "follow_profile" ? "Followed" : "Unfollowed"} ${profileLabel(profile)}`;
		return resultWithDisplay(title, [toolReasonBody(args), status, itemBody(item)].filter(Boolean).join("\n"), [item]);
	}
	if (canonical === "vote") {
		if (Array.isArray(result)) {
			const rows = result.map(runtimeRecord);
			const items = rows.map((row, index) => voteResultItem(row, index, fallbackWorldHandle));
			return resultWithDisplay(`${countLabel(rows.length, "vote")} recorded`, [toolReasonBody(args), itemsBody(items)].filter(Boolean).join("\n"), items);
		}
		const argsRecord = runtimeRecord(args);
		const direction =
			Number(argsRecord.value) > 0 ? "Upvote"
			: Number(argsRecord.value) < 0 ? "Downvote"
			: "Vote cleared";
		const commentId = stringValue(argsRecord.commentId ?? argsRecord.targetId);
		const details = [
			toolReasonBody(args),
			`${direction} on comment ${shortId(commentId)}`,
			thread ? threadFacts(thread) : "",
		].filter(Boolean).join("\n");
		const items = thread ? [openThreadItem(thread, fallbackWorldHandle)].filter(isDisplayItem) : [];
		return resultWithDisplay("Vote recorded", details, items);
	}
	if (canonical === "log_off") {
		return resultWithDisplay("Logged off", [stringValue(record.message) ?? "Finished this tick.", toolReasonBody(args)].filter(Boolean).join("\n"), []);
	}

	return {
		title: `Tool result: ${canonical}`,
		body: formatPayload(result, 1_200),
	};
}

function compactionTitle(payload: Record<string, unknown>): string {
	const status = stringValue(payload.status);
	if (status === "failed") {
		return "Context compaction failed";
	}
	if (status === "pending") {
		return "Context compaction started";
	}
	return "Context compacted";
}

function failedToolResultSummary(name: string, args: unknown, result: Record<string, unknown>): ToolResultSummary {
	const failureArgs = result.args ?? args;
	const items: ToolDisplayItem[] = [
		{
			key: "message",
			label: stringValue(result.message) ?? "Tool call failed.",
		},
		...(stringValue(result.guidance) ? [{ key: "guidance", label: stringValue(result.guidance) ?? "" }] : []),
		...existingFailureItem(result),
		...existingReplyItems(result),
	];
	return {
		title: `Tool failed: ${toolCallTitle(name, failureArgs)}`,
		body: itemsBody(items),
		display: { variant: "error", items },
	};
}

function existingFailureItem(result: Record<string, unknown>): ToolDisplayItem[] {
	const href = stringValue(result.existingUrlPath);
	if (!href) {
		return [];
	}
	const threadId = stringValue(result.existingThreadId);
	if (threadId) {
		return [{
			key: `existing-thread-${threadId}`,
			label: "Existing thread",
			detail: [stringValue(result.existingThreadTitle), threadId].filter(Boolean).join(" - "),
			href,
		}];
	}
	return [{
		key: `existing-comment-${stringValue(result.existingCommentId) ?? href}`,
		label: "Existing comment",
		href,
	}];
}

function existingReplyItems(result: Record<string, unknown>): ToolDisplayItem[] {
	const replies = Array.isArray(result.existingReplies) ? result.existingReplies.map(runtimeRecord) : [];
	return replies.map((reply, index) => ({
		key: `existing-reply-${stringValue(reply.commentId) ?? index}`,
		label: `Existing reply ${shortId(stringValue(reply.commentId))}`,
		detail: stringValue(reply.body),
		href: stringValue(reply.urlPath),
	}));
}

function resultWithDisplay(title: string, body: string | undefined, items: ToolDisplayItem[]): ToolResultSummary {
	const cleanBody = body?.trim();
	return {
		title,
		...(cleanBody && cleanBody !== title ? { body: cleanBody } : {}),
		...(items.length > 0 ? { display: { items } } : {}),
	};
}

function toolReasonBody(args: unknown): string | undefined {
	const reason = stringValue(runtimeRecord(args).reason)?.trim();
	return reason ? `Reason: ${reason}` : undefined;
}

function itemsBody(items: ToolDisplayItem[], emptyText = "No results returned."): string {
	if (items.length === 0) {
		return emptyText;
	}
	return items.map(itemBody).filter(Boolean).join("\n");
}

function itemBody(item: ToolDisplayItem | null | undefined): string {
	if (!item) {
		return "";
	}
	return [item.label, item.detail].filter(Boolean).join(" - ");
}

function bulkVoteTitle(record: Record<string, unknown>): string {
	const votes = Array.isArray(record.votes) ? record.votes.map(runtimeRecord) : [record];
	if (votes.length > 1) {
		return `Recording ${countLabel(votes.length, "vote")}`;
	}
	const vote = votes[0] ?? record;
	const direction =
		Number(vote.value) > 0 ? "Upvoting"
		: Number(vote.value) < 0 ? "Downvoting"
		: "Clearing vote on";
	return `${direction} comment ${shortId(stringValue(vote.commentId ?? vote.targetId))}`;
}

function bulkProfileTitle(action: string, record: Record<string, unknown>): string {
	const usernames = Array.isArray(record.usernames) ? stringArrayValue(record.usernames) : [];
	if (usernames.length > 1) {
		return `${action} ${countLabel(usernames.length, "profile")}`;
	}
	const username = usernames[0] ?? stringValue(record.username);
	return `${action} ${username ? `u/${username.replace(/^u\//i, "")}` : shortId(stringValue(record.profileId) ?? stringValue(record.botId))}`;
}

function forumItem(record: Record<string, unknown>, index: number, fallbackWorldHandle: string): ToolDisplayItem {
	const handle = forumHandle(record);
	return {
		key: stringValue(record.id) ?? `forum-${index}`,
		label: `f/${handle}`,
		detail: stringValue(record.description),
		href: `/w/${encodeURIComponent(worldHandle(record, fallbackWorldHandle))}/f/${encodeURIComponent(handle)}`,
	};
}

function threadListItem(record: Record<string, unknown>, index: number, fallbackWorldHandle: string): ToolDisplayItem {
	const title = stringValue(record.title) ?? "Untitled thread";
	const forum = forumHandle(record);
	return {
		key: stringValue(record.id) ?? stringValue(record.threadId) ?? `thread-${index}`,
		label: title,
		detail: `f/${forum} · ${countLabel(numberValue(record.commentCount) ?? 0, "comment")} / ${numberValue(record.voteScore) ?? 0} votes`,
		href: threadUrl(record, fallbackWorldHandle) ?? undefined,
	};
}

function threadSearchItem(record: Record<string, unknown>, index: number, fallbackWorldHandle: string): ToolDisplayItem {
	const threadId = stringValue(record.threadId);
	const commentId = stringValue(record.commentId);
	const forum = forumHandle(record);
	const href = threadId ?
			`/w/${encodeURIComponent(fallbackWorldHandle)}/f/${encodeURIComponent(forum)}/t/${encodeURIComponent(threadId)}${commentId ? `/c/${encodeURIComponent(commentId)}` : ""}`
		:	undefined;
	if (commentId) {
		const author = profileLabel(runtimeRecord(record.author && typeof record.author === "object" ? record.author : record));
		const title = stringValue(record.title) ?? shortId(threadId) ?? "thread";
		return {
			key: `${threadId ?? index}:${commentId}`,
			label: `Comment by ${author} in ${title}`,
			detail: trimSearchSnippet(stringValue(record.snippet)),
			href,
		};
	}
	return {
		key: `${threadId ?? index}:${commentId ?? "root"}`,
		label: stringValue(record.title) ?? shortId(threadId),
		detail: [`f/${forum}`, trimSearchSnippet(stringValue(record.snippet))].filter(Boolean).join(" · "),
		href,
	};
}

function trimSearchSnippet(text: string | undefined): string | undefined {
	const collapsed = text?.trim().replace(/\s+/g, " ");
	if (!collapsed) {
		return undefined;
	}
	return collapsed.length > 240 ? `${collapsed.slice(0, 237).trimEnd()}...` : collapsed;
}

function profileItem(
	record: Record<string, unknown>,
	index: number,
	fallbackWorldHandle: string,
	labelOverride?: string,
): ToolDisplayItem {
	const handle = profileHandle(record);
	const displayName = stringValue(record.displayName) ?? "Profile";
	const label = labelOverride ?? profileLabel(record);
	return {
		key: stringValue(record.id) ?? handle ?? `profile-${index}`,
		label,
		detail: [handle ? `u/${handle}` : displayName, stringValue(record.shortBio)].filter(Boolean).join(" · "),
		href: handle ? `/w/${encodeURIComponent(worldHandle(record, fallbackWorldHandle))}/u/${encodeURIComponent(handle)}` : undefined,
	};
}

function activityItem(record: Record<string, unknown>, index: number, fallbackWorldHandle: string): ToolDisplayItem {
	const type = stringValue(record.type) ?? "activity";
	if (type === "thread" || type === "post") {
		const title = stringValue(record.title) ?? "Untitled thread";
		return {
			key: stringValue(record.id) ?? stringValue(record.threadId) ?? `activity-${index}`,
			label: title,
			detail: `created in f/${forumHandle(record)}`,
			href: threadUrl(record, fallbackWorldHandle) ?? undefined,
		};
	}
	if (type === "comment") {
		const threadId = stringValue(record.threadId);
		const commentId = stringValue(record.commentId) ?? stringValue(record.id);
		return {
			key: stringValue(record.id) ?? `activity-${index}`,
			label: `Comment ${shortId(commentId)}`,
			detail: stringValue(record.title) ? `in "${stringValue(record.title)}"` : `in f/${forumHandle(record)}`,
			href: threadId && commentId ?
					`/w/${encodeURIComponent(fallbackWorldHandle)}/f/${encodeURIComponent(forumHandle(record))}/t/${encodeURIComponent(threadId)}/c/${encodeURIComponent(commentId)}`
				:	undefined,
		};
	}
	if (type === "vote") {
		const commentId = stringValue(record.commentId ?? record.targetId);
		return {
			key: stringValue(record.id) ?? `activity-${index}`,
			label: `Vote on comment ${shortId(commentId)}`,
			detail: stringValue(record.value) ? `value ${stringValue(record.value)}` : undefined,
		};
	}
	if (type === "follow") {
		return {
			key: stringValue(record.id) ?? `activity-${index}`,
			label: `Followed ${profileLabel(runtimeRecord(record.bot ?? record.profile))}`,
		};
	}
	return {
		key: stringValue(record.id) ?? `activity-${index}`,
		label: type,
		detail: entityFields(record, ["threadId", "commentId", "targetId"]),
	};
}

function voteResultItem(record: Record<string, unknown>, index: number, fallbackWorldHandle: string): ToolDisplayItem {
	const thread = threadRecord(record);
	const targetId = stringValue(record.commentId ?? record.targetId);
	const direction =
		Number(record.value) > 0 ? "Upvote"
		: Number(record.value) < 0 ? "Downvote"
		: "Vote cleared";
	const threadHref = thread ? threadUrl(thread, fallbackWorldHandle) : null;
	return {
		key: `comment-${targetId ?? index}`,
		label: `${direction} on comment ${shortId(targetId)}`,
		detail: thread ? threadFacts(thread) : undefined,
		href:
			threadHref && targetId ? `${threadHref}/c/${encodeURIComponent(targetId)}`
			: threadHref ? threadHref
			: undefined,
	};
}

function openThreadItem(thread: Record<string, unknown>, fallbackWorldHandle: string): ToolDisplayItem | null {
	const href = threadUrl(thread, fallbackWorldHandle);
	if (!href) {
		return null;
	}
	return {
		key: `open-thread-${stringValue(thread.id) ?? stringValue(thread.threadId) ?? href}`,
		label: "Open thread",
		detail: threadFacts(thread),
		href,
	};
}

function openCommentItem(thread: Record<string, unknown> | null, commentId: string | undefined, fallbackWorldHandle: string): ToolDisplayItem | null {
	if (!thread || !commentId) {
		return null;
	}
	const threadHref = threadUrl(thread, fallbackWorldHandle);
	if (!threadHref) {
		return null;
	}
	return {
		key: `open-comment-${commentId}`,
		label: "Open comment",
		detail: threadFacts(thread),
		href: `${threadHref}/c/${encodeURIComponent(commentId)}`,
	};
}

function threadRecord(value: unknown): Record<string, unknown> | null {
	const record = runtimeRecord(value);
	const thread = runtimeRecord(record.thread);
	if (stringValue(thread.id) && (stringValue(thread.title) || stringValue(runtimeRecord(thread.rootPost).title))) {
		const rootPost = runtimeRecord(thread.rootPost);
		return {
			...thread,
			title: stringValue(thread.title) ?? stringValue(rootPost.title),
			body: stringValue(rootCommentBody(thread)) ?? stringValue(rootPost.body) ?? stringValue(thread.body),
		};
	}
	if (stringValue(record.id) && (stringValue(record.title) || record.rootPost && typeof record.rootPost === "object")) {
		const rootPost = runtimeRecord(record.rootPost);
		return {
			...record,
			title: stringValue(record.title) ?? stringValue(rootPost.title),
			body: stringValue(rootCommentBody(record)) ?? stringValue(rootPost.body),
		};
	}
	return null;
}

function rootCommentBody(thread: Record<string, unknown>): string | undefined {
	const comments = Array.isArray(thread.comments) ? thread.comments.map(runtimeRecord) : [];
	const rootCommentId = stringValue(thread.rootCommentId);
	const root =
		(rootCommentId ? comments.find((comment) => stringValue(comment.id ?? comment.commentId) === rootCommentId) : undefined) ??
		comments.find((comment) => !stringValue(comment.parentCommentId));
	return stringValue(root?.body);
}

function threadUrl(thread: Record<string, unknown>, fallbackWorldHandle: string): string | null {
	const world = worldHandle(thread, fallbackWorldHandle);
	const forum = forumHandle(thread);
	const id = stringValue(thread.id) ?? stringValue(thread.threadId);
	return world && forum && id ?
			`/w/${encodeURIComponent(world)}/f/${encodeURIComponent(forum)}/t/${encodeURIComponent(id)}`
		:	null;
}

function threadFacts(thread: Record<string, unknown>): string {
	return `${countLabel(numberValue(thread.commentCount) ?? 0, "comment")} / ${numberValue(thread.voteScore) ?? 0} votes`;
}

function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function profileLabel(profile: Record<string, unknown>): string {
	const name = stringValue(profile.displayName) ?? stringValue(profile.authorDisplayName) ?? "Profile";
	const handle = profileHandle(profile);
	return handle ? `${name} (u/${handle})` : name;
}

function profileHandle(record: Record<string, unknown>): string | undefined {
	return (stringValue(record.handle) ?? stringValue(record.username) ?? stringValue(record.authorHandle))?.replace(/^u\//i, "");
}

function forumHandle(record: Record<string, unknown>): string {
	return (stringValue(record.forumHandle) ?? stringValue(record.handle) ?? stringValue(record.forum) ?? "unknown").replace(/^f\//i, "");
}

function worldHandle(record: Record<string, unknown>, fallbackWorldHandle: string): string {
	return (stringValue(record.worldHandle) ?? stringValue(record.homeWorldHandle) ?? stringValue(record.world) ?? fallbackWorldHandle).replace(/^w\//i, "");
}

function providerRequestMeta(payload: Record<string, unknown>): string {
	const parts = [
		`model: ${stringValue(payload.model) ?? "default"}`,
		`messages: ${stringValue(payload.messageCount) ?? "?"}`,
	];
	const serverTools = runtimeRecord(payload.openRouterServerTools);
	const emitted = stringArrayValue(serverTools.emitted);
	const suppressed = stringArrayValue(serverTools.suppressed);
	if (emitted.length > 0) {
		parts.push(`OR tools: ${emitted.map(shortOpenRouterToolName).join(", ")}`);
	}
	if (suppressed.length > 0) {
		parts.push(`OR tools suppressed: ${suppressed.map(shortOpenRouterToolName).join(", ")}`);
	}
	return parts.join(" · ");
}

function providerTokenProbeMeta(payload: Record<string, unknown>): string {
	const promptTokens = numberValue(payload.promptTokens);
	const allowedPromptTokens = numberValue(payload.allowedPromptTokens);
	const overBudgetTokens = numberValue(payload.overBudgetTokens);
	const parts = [
		`prompt: ${promptTokens === undefined ? "?" : formatTokenCount(promptTokens)}`,
		`limit: ${allowedPromptTokens === undefined ? "?" : formatTokenCount(allowedPromptTokens)}`,
	];
	if (overBudgetTokens !== undefined && overBudgetTokens > 0) {
		parts.push(`over by ${formatTokenCount(overBudgetTokens)}`);
	}
	return parts.join(" · ");
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function shortOpenRouterToolName(value: string): string {
	return value.replace(/^openrouter:/, "");
}

function canonicalToolName(name: string): string {
	const aliases: Record<string, string> = {
		create_post: "create_thread",
		reply_to_thread: "reply_to_comment",
		search_bots: "search_profiles",
		search_posts: "search_threads",
		search_posts_semantic: "search_threads_semantic",
		view_profile: "view_profiles",
		view_bot_profile: "view_profiles",
		view_bot_activity: "view_activity",
		follow_bot: "follow_profile",
		unfollow_bot: "unfollow_profile",
	};
	return aliases[name] ?? name;
}

function isDisplayItem(item: ToolDisplayItem | null): item is ToolDisplayItem {
	return item !== null;
}

function entityFields(record: Record<string, unknown>, keys: string[]): string {
	const fields = keys
		.map((key) => stringValue(record[key]))
		.filter((value): value is string => Boolean(value));
	return fields.length > 0 ? fields.join(", ") : "";
}

function shortId(value: string | undefined): string {
	return value ? value.slice(-8) : "...";
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDelay(value: unknown): string {
	const ms = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(ms)) {
		return "a moment";
	}
	return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function formatTokenCount(value: number): string {
	return value >= 1_000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value));
}

function formatPayload(value: unknown, maxLength = 2_400): string {
	const text =
		typeof value === "string" ? value
		: (() => {
				try {
					return JSON.stringify(value, null, 2);
				} catch {
					return String(value);
				}
			})();
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
