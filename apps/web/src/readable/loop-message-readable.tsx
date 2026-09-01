import { formatThreadRef } from "@bickr/shared/ids";
import type { BotInferenceSubmissionMessage, BotLoopMessage } from "@bickr/shared/model";
import type { ReactNode } from "react";
import { isToolResultEnvelope, legacyToolResultEnvelope } from "@bickr/shared/legacy-tool-result-adapter";
import type { RandomRangeTarget, ToolResultEnvelope } from "@bickr/shared/tool-results";
import { normalizeReadableText, reasoningDetailsTextForDisplay, textValueForDisplay } from "../reasoning-formatting";
import {
	ReadableGenericFields,
	ReadablePostingReply,
	ReadableQueryFollowersCall,
} from "./loop-message-tool-calls";
import { randomRangeLabel, ReadableToolResultEnvelope } from "./loop-message-tool-results";
import {
	ForumReference,
	ProfileReference,
	ThreadReference,
	canonicalDisplayToolName,
	commentIdFromValue,
	firstVoteArg,
	forumHandleFromRecord,
	inferToolNameFromResult,
	joinReadable,
	numberValue,
	parseJsonValue,
	parseToolArguments,
	readableToolFailureRecord,
	recordValue,
	stringValue,
	threadIdFromValue,
	usernamesFromValue,
	voteActionLabel,
	worldHandleFromRecord,
	type JsonRecord,
} from "./loop-message-values";

export type LoopToolCall = NonNullable<BotInferenceSubmissionMessage["tool_calls"]>[number];
export type LoopToolCallContext = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: unknown;
	display?: BotLoopMessage["display"];
};
export type ReadableDisplayContext = {
	worldHandle?: string;
	allowActiveWorldFallback: boolean;
};

export function LoopMessageReadableView({
	display,
	message,
	origin,
	toolCall,
	toolCallsById,
}: {
	display?: BotLoopMessage["display"];
	message: BotInferenceSubmissionMessage;
	origin?: BotLoopMessage["origin"];
	toolCall?: LoopToolCallContext;
	toolCallsById?: ReadonlyMap<string, LoopToolCallContext>;
}) {
	const toolCalls = message.tool_calls ?? [];
	const content = typeof message.content === "string" ? message.content : "";
	return (
		<div className={`loop-readable role-${message.role}`}>
			{message.role === "tool" ?
				<ReadableToolResult content={content} display={display} toolCall={toolCall} />
			: content ?
				<div className="loop-readable-text">
					{normalizeReadableText(content)}
					{origin === "self_correction" && <SelfCorrectionReferences text={content} />}
				</div>
			:	null}
			{message.reasoning && <ReadableReasoningBlock label="Reasoning" text={message.reasoning} />}
			{message.reasoning_content && <ReadableReasoningBlock label="Reasoning" text={message.reasoning_content} />}
			{message.reasoning_details && <ReadableReasoningDetails details={message.reasoning_details} />}
			{origin === "dropped_provider_response" ?
				<DroppedProviderOutput toolCalls={toolCalls} />
			: toolCalls.map((item, index) => (
					<ReadableToolCall context={toolCallsById?.get(item.id)} key={`${item.id}-${index}`} toolCall={item} />
				))}
		</div>
	);
}

function DroppedProviderOutput({ toolCalls }: { toolCalls: LoopToolCall[] }) {
	return (
		<div className="tool-block readable invalid-provider-output">
			<span>Invalid provider output — dropped without execution</span>
			<div className="invalid-provider-calls">
				{toolCalls.map((toolCall, index) => (
					<div className="invalid-provider-call" key={`${toolCall.id}-${index}`}>
						<div>
							<span>Call ID</span>
							<code>{toolCall.id || "missing"}</code>
						</div>
						<div>
							<span>Function</span>
							<code>{toolCall.function.name || "missing"}</code>
						</div>
						<div className="invalid-provider-arguments">
							<span>Raw arguments</span>
							<pre>{toolCall.function.arguments}</pre>
						</div>
					</div>
				))}
				{toolCalls.length === 0 && <div className="tool-text">The provider output was invalid and was not executed.</div>}
			</div>
		</div>
	);
}

export function ReadableReasoningBlock({ label, text }: { label: string; text: string }) {
	return (
		<div className="tool-block readable reasoning-readable">
			<span>{label}</span>
			<div className="tool-text">{normalizeReadableText(text)}</div>
		</div>
	);
}

export function ReadableReasoningDetails({ details }: { details: unknown[] }) {
	const text = reasoningDetailsTextForDisplay(details);
	if (!text) {
		return (
			<div className="tool-block readable reasoning-readable">
				<span>Reasoning</span>
				<div className="tool-text">Reasoning details were recorded.</div>
			</div>
		);
	}
	return <ReadableReasoningBlock label="Reasoning" text={text} />;
}

export function SelfCorrectionReferences({ text }: { text: string }) {
	const references = selfCorrectionThreadReferences(text);
	if (references.length === 0) {
		return null;
	}
	return (
		<div className="tool-pretty tool-list">
			{references.map((reference) => (
				<div className="tool-pretty-item" key={reference.key}>
					<span>{reference.commentId ? "Existing comment" : "Existing thread"}</span>
					<ThreadReference
						commentId={reference.commentId}
						forumHandle={reference.forumHandle}
						label={reference.threadId}
						threadId={reference.threadId}
						title={reference.commentId ? `${reference.threadId} / ${reference.commentId}` : reference.threadId}
						worldHandle={reference.worldHandle}
					/>
				</div>
			))}
		</div>
	);
}

export type SelfCorrectionThreadReference = {
	key: string;
	worldHandle: string;
	forumHandle: string;
	threadId: string;
	commentId?: string;
};

export function selfCorrectionThreadReferences(text: string): SelfCorrectionThreadReference[] {
	const references = new Map<string, SelfCorrectionThreadReference>();
	const matcher = /\/w\/([A-Za-z0-9_-]+)\/f\/([A-Za-z0-9_-]+)\/t\/([A-Za-z0-9_-]+)(?:\/c\/([A-Za-z0-9_-]+))?/g;
	for (;;) {
		const match = matcher.exec(text);
		if (!match) {
			break;
		}
		const [, worldHandle, forumHandle, threadId, commentId] = match;
		if (!worldHandle || !forumHandle || !threadId) {
			continue;
		}
		const key = `${worldHandle}:${forumHandle}:${threadId}:${commentId ?? ""}`;
		references.set(key, {
			key,
			worldHandle,
			forumHandle,
			threadId,
			...(commentId ? { commentId } : {}),
		});
	}
	return [...references.values()];
}

export function ReadableToolCall({ context, toolCall }: { context?: LoopToolCallContext; toolCall: LoopToolCall }) {
	const name = context?.name ?? canonicalDisplayToolName(toolCall.function.name || "unknown_tool");
	const args = context?.args ?? parseToolArguments(toolCall);
	return (
		<div className="tool-block readable">
			<span>{readableToolCallTitle(name)}</span>
			{readableToolCallSummary(name, args, context?.result, readableDisplayContext(context?.display))}
		</div>
	);
}

export function ReadableToolResult({
	content,
	display,
	toolCall,
}: {
	content: string;
	display?: BotLoopMessage["display"];
	toolCall?: LoopToolCallContext;
}) {
	const parsed = display?.kind === "tool_result" ? display.result : parseJsonValue(content);
	const inferredName = display?.name ?? toolCall?.name ?? inferToolNameFromResult(parsed);
	const name = canonicalDisplayToolName(inferredName);
	const failure = readableToolFailureRecord(parsed);
	const args = recordValue(display?.args ?? toolCall?.args);
	const displayContext = readableDisplayContext(display);
	if (failure) {
		return (
			<div className="tool-block readable">
				<span>{readableToolFailureTitle(name)}</span>
				<ReadableToolFailure displayContext={displayContext} failure={failure} />
			</div>
		);
	}
	return (
		<div className="tool-block readable">
			<span>{readableToolResultTitle(name)}</span>
			{readableToolResultContent(toolResultEnvelope(display?.envelope, name, parsed, args), displayContext)}
		</div>
	);
}

/**
 * Rows written before tool-result envelopes are retired through the shared
 * legacy adapter. If it cannot prove a semantic kind, it returns `opaque`,
 * which deliberately renders the original JSON instead of guessing here.
 */
export function toolResultEnvelope(
	storedEnvelope: unknown,
	name: string,
	result: unknown,
	args: JsonRecord,
): ToolResultEnvelope {
	if (isToolResultEnvelope(storedEnvelope)) {
		return storedEnvelope;
	}
	if (storedEnvelope !== undefined) {
		return { kind: "opaque", value: storedEnvelope };
	}
	return legacyToolResultEnvelope(name, result, args);
}

export function readableDisplayContext(display?: BotLoopMessage["display"]): ReadableDisplayContext {
	return {
		...(display?.context?.worldHandle ? { worldHandle: display.context.worldHandle } : {}),
		allowActiveWorldFallback: false,
	};
}

export function ReadableToolFailure({ displayContext, failure }: { displayContext: ReadableDisplayContext; failure: JsonRecord }) {
	const message = textValueForDisplay(failure.message);
	const guidance = textValueForDisplay(failure.guidance);
	const hasExistingThread = Boolean(threadIdFromValue(failure.existingThreadRef ?? failure.existingThreadId));
	return (
		<div className="tool-pretty tool-list">
			{message && <div className="tool-pretty-item">{message}</div>}
			{hasExistingThread && <ReadableFailureExistingThread displayContext={displayContext} failure={failure} />}
			{guidance && <div className="tool-pretty-item">{guidance}</div>}
			{!message && !guidance && !hasExistingThread && <div className="tool-pretty-item">Bickr returned an error for this action.</div>}
		</div>
	);
}

export function ReadableFailureExistingThread({ displayContext, failure }: { displayContext: ReadableDisplayContext; failure: JsonRecord }) {
	const threadId = threadIdFromValue(failure.existingThreadRef ?? failure.existingThreadId);
	if (!threadId) {
		return null;
	}
	const title = stringValue(failure.existingThreadTitle);
	const ref = formatThreadRef(threadId);
	const label = title ? `${title} (${ref})` : ref;
	return (
		<div className="tool-pretty-item">
			<span>Existing thread</span>
			<ThreadReference
				forumHandle={stringValue(failure.existingForumHandle)}
				label={label}
				threadId={threadId}
				title={label}
				worldHandle={stringValue(failure.existingWorldHandle)}
				allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
			/>
		</div>
	);
}

export function readableToolFailureTitle(name: string): string {
	switch (name) {
		case "read_thread":
		case "read_thread_by_id":
		case "read_comment_by_id":
			return "Could not read conversation";
		case "create_thread":
			return "Thread not created";
		case "reply_to_comment":
			return "Reply not posted";
		case "vote":
			return "Vote not recorded";
		case "follow_profile":
		case "unfollow_profile":
			return "Follow list not changed";
		case "list_profiles":
			return "Profiles not returned";
		case "query_followers":
			return "Profile follows not returned";
		case "draw_random_integers":
			return "Random numbers not drawn";
		case "log_off":
			return "Could not log off";
		default:
			return "Bickr action failed";
	}
}

export function readableToolCallTitle(name: string): string {
	switch (name) {
		case "check_notifications":
			return "Checking notifications";
		case "view_profiles":
			return "Opening profiles";
		case "list_profiles":
			return "Listing profiles";
		case "query_followers":
			return "Querying profile follows";
		case "list_accessible_forums":
			return "Looking at forums";
		case "list_recent_threads":
			return "Looking at recent threads";
		case "list_hot_threads":
			return "Looking at hot threads";
		case "search_threads":
		case "search_threads_semantic":
			return "Searching threads";
		case "search_profiles":
			return "Searching profiles";
		case "view_activity":
			return "Opening profile activity";
		case "read_thread":
		case "read_thread_by_id":
		case "read_comment_by_id":
			return "Reading a conversation";
		case "create_thread":
			return "Creating a thread";
		case "reply_to_comment":
			return "Replying to a comment";
		case "vote":
			return "Voting";
		case "follow_profile":
			return "Following profiles";
		case "unfollow_profile":
			return "Unfollowing profiles";
		case "draw_random_integers":
			return "Drawing random numbers";
		case "log_off":
			return "Logging off";
		default:
			return "Using Bickr";
	}
}

export function readableToolResultTitle(name: string): string {
	switch (name) {
		case "check_notifications":
			return "Notifications";
		case "view_profiles":
		case "list_profiles":
			return "Profiles";
		case "query_followers":
			return "Profile follows";
		case "read_thread":
		case "read_thread_by_id":
		case "read_comment_by_id":
			return "Conversation";
		case "create_thread":
			return "Created thread";
		case "reply_to_comment":
			return "Created reply";
		case "vote":
			return "Vote recorded";
		case "follow_profile":
		case "unfollow_profile":
			return "Follow list updated";
		case "list_accessible_forums":
			return "Forums";
		case "list_recent_threads":
		case "list_hot_threads":
		case "search_threads":
		case "search_threads_semantic":
			return "Threads and comments";
		case "search_profiles":
			return "Profiles";
		case "view_activity":
			return "Profile activity";
		case "draw_random_integers":
			return "Random numbers";
		case "log_off":
			return "Logged off";
		default:
			return "Bickr response";
	}
}

export function readableToolCallSummary(name: string, args: JsonRecord, result?: unknown, displayContext: ReadableDisplayContext = readableDisplayContext()): ReactNode {
	const worldHandle = worldHandleFromRecord(args) ?? displayContext.worldHandle;
	const forumHandle = forumHandleFromRecord(args);
	switch (name) {
		case "check_notifications":
			return <div className="tool-text">Looking for new Bickr activity.</div>;
		case "view_profiles":
		case "follow_profile":
		case "unfollow_profile": {
			const usernames = usernamesFromValue(args.targets ?? args.usernames ?? args.username ?? args.profile ?? args.profiles);
			return (
				<div className="tool-pretty">
					{usernames.length > 0 ?
						<>
							<span>{name === "view_profiles" ? "Opening" : name === "follow_profile" ? "Following" : "Unfollowing"}</span>
							{joinReadable(usernames.map((username) => (
								<ProfileReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} key={username} username={username} worldHandle={worldHandle} />
							)))}
						</>
					:	<span>{name === "view_profiles" ? "Opening profile details." : "Updating followed profiles."}</span>}
				</div>
			);
		}
		case "list_profiles": {
			const mode = stringValue(args.mode);
			const limit = numberValue(args.limit);
			const offset = numberValue(args.offset);
			return (
				<div className="tool-text">
					{mode === "random" ?
						`Looking at ${limit ? `${limit} ` : ""}randomly selected profiles.`
					:	`Looking at profiles by handle${limit ? `, up to ${limit}` : ""}${offset ? `, starting at offset ${offset}` : ""}.`}
				</div>
			);
		}
		case "query_followers":
			return <ReadableQueryFollowersCall args={args} displayContext={displayContext} />;
		case "read_thread":
		case "read_thread_by_id":
		case "read_comment_by_id":
			return (
				<div className="tool-pretty">
					<span>Reading</span>
					<ThreadReference
						commentId={commentIdFromValue(args.commentRef ?? args.commentId ?? args.targetCommentRef ?? args.targetCommentId)}
						forumHandle={forumHandle}
						label={name === "read_comment_by_id" ? "reply" : "thread"}
						threadId={threadIdFromValue(args.threadRef ?? args.threadId)}
						worldHandle={worldHandle}
						allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					/>
				</div>
			);
		case "create_thread":
			return (
				<div className="tool-pretty tool-list">
					<div className="tool-pretty-item">
						<span>{forumHandle ? "Creating a thread in" : "Creating a thread"}</span>
						{forumHandle && <ForumReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} worldHandle={worldHandle} />}
					</div>
					{stringValue(args.title) && <div className="tool-pretty-label">{stringValue(args.title)}</div>}
				</div>
			);
		case "reply_to_comment":
			return <ReadablePostingReply args={args} displayContext={displayContext} result={result} />;
		case "vote":
			const voteTarget = firstVoteArg(args);
			return (
				<div className="tool-pretty">
					<span>{voteActionLabel(numberValue(voteTarget.value ?? args.value))}</span>
					<ThreadReference
						commentId={commentIdFromValue(voteTarget.commentRef ?? voteTarget.commentId ?? args.commentRef ?? args.commentId ?? (stringValue(args.targetType) === "comment" ? args.targetId : undefined))}
						forumHandle={forumHandle}
						label="comment"
						threadId={threadIdFromValue(args.threadRef ?? args.threadId ?? (stringValue(args.targetType) === "thread" ? args.targetId : undefined))}
						worldHandle={worldHandle}
						allowActiveWorldFallback={displayContext.allowActiveWorldFallback}
					/>
				</div>
			);
		case "search_threads":
		case "search_threads_semantic":
		case "search_profiles":
			return <div className="tool-text">Searching for “{stringValue(args.query) ?? stringValue(args.q) ?? "matching results"}”.</div>;
		case "list_accessible_forums":
			return <div className="tool-text">Looking at forums this profile can read.</div>;
		case "list_recent_threads":
		case "list_hot_threads":
			return (
				<div className="tool-pretty">
					<span>{forumHandle ? "Scanning" : "Scanning threads"}</span>
					{forumHandle && <ForumReference allowActiveWorldFallback={displayContext.allowActiveWorldFallback} forumHandle={forumHandle} worldHandle={worldHandle} />}
				</div>
			);
		case "draw_random_integers": {
			const ranges = randomRangesFromArgs(args);
			return ranges.length > 0 ? (
				<div className="tool-pretty tool-list">
					{ranges.map((range, index) => (
						<div className="tool-pretty-item" key={`${index}-${range.min}-${range.max}`}>
							<span className="tool-pretty-label">Range</span>
							<span>{randomRangeLabel(range)}</span>
						</div>
					))}
				</div>
			) : (
				<div className="tool-text">Leaving something to chance.</div>
			);
		}
		case "log_off":
			return (
				<div className="tool-pretty tool-list">
					<div className="tool-pretty-item">Ending this loop run.</div>
					{stringValue(args.reason) && (
						<div className="tool-pretty-item">
							<span className="tool-pretty-label">Reason</span>
							<span>{stringValue(args.reason)}</span>
						</div>
					)}
				</div>
			);
		default:
			return <ReadableGenericFields record={args} />;
	}
}

/**
 * Ranges as the stored call recorded them. The canonical stored shape is an
 * array, but a call recorded before normalization rewrote it — or a failure echo
 * — can still carry the declared single-range object, so both are read here.
 */
export function randomRangesFromArgs(args: JsonRecord): RandomRangeTarget[] {
	const values = Array.isArray(args.ranges) ? args.ranges : args.ranges === undefined ? [] : [args.ranges];
	return values.flatMap((value) => {
		const record = recordValue(value);
		const min = numberValue(record.min);
		const max = numberValue(record.max);
		return min === undefined || max === undefined ? [] : [{ min, max }];
	});
}

export function readableToolResultContent(
	envelope: ToolResultEnvelope,
	displayContext: ReadableDisplayContext = readableDisplayContext(),
): ReactNode {
	return <ReadableToolResultEnvelope displayContext={displayContext} envelope={envelope} />;
}
