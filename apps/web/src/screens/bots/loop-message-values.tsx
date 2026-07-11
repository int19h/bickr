import { parseCommentRef, parseThreadRef } from "@bickr/shared/ids";
import type { BotLoopMessage } from "@bickr/shared/model";
import { useContext, type ReactNode } from "react";
import { ContentReference, Reference, ReferenceDataContext } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import { normalizeReadableText } from "../../reasoning-formatting";
import type { ParsedRoute } from "../../routes";
import type { LoopToolCall, LoopToolCallContext } from "./loop-message-readable";

export type JsonRecord = Record<string, unknown>;

export function ReadableQuote({ label, text }: { label?: string; text: string }) {
	return (
		<blockquote className="readable-quote">
			{label && <span>{label}</span>}
			{normalizeReadableText(text)}
		</blockquote>
	);
}

export function trimReadableSnippet(text: string): string {
	const collapsed = normalizeReadableText(text).trim().replace(/\s+/g, " ");
	return collapsed.length > 240 ? `${collapsed.slice(0, 237).trimEnd()}...` : collapsed;
}

export function ProfileReference({
	allowActiveWorldFallback = true,
	profile,
	username,
	worldHandle,
}: {
	allowActiveWorldFallback?: boolean;
	profile?: JsonRecord;
	username?: string;
	worldHandle?: string;
}) {
	const handle = usernameHandle(username) ?? usernameHandle(stringValue(profile?.username)) ?? stringValue(profile?.handle) ?? stringValue(profile?.authorHandle);
	if (!handle) {
		return allowActiveWorldFallback ? <span>someone</span> : null;
	}
	if (!allowActiveWorldFallback && !worldHandle) {
		return <span>u/{handle}</span>;
	}
	return <Reference kind="bot" name={handle} worldHandle={worldHandle} />;
}

export function ForumReference({
	allowActiveWorldFallback = true,
	forumHandle,
	worldHandle,
}: {
	allowActiveWorldFallback?: boolean;
	forumHandle?: string;
	worldHandle?: string;
}) {
	if (!forumHandle) {
		return allowActiveWorldFallback ? <span>a forum</span> : null;
	}
	if (!allowActiveWorldFallback && !worldHandle) {
		return <span>f/{forumHandle}</span>;
	}
	return <Reference kind="forum" name={forumHandle} worldHandle={worldHandle} />;
}

export function ThreadReference({
	allowActiveWorldFallback = true,
	commentId,
	forumHandle,
	label = "thread",
	threadId,
	title,
	worldHandle,
}: {
	allowActiveWorldFallback?: boolean;
	commentId?: string;
	forumHandle?: string;
	label?: string;
	threadId?: string;
	title?: string;
	worldHandle?: string;
}) {
	const referenceData = useContext(ReferenceDataContext);
	const effectiveWorldHandle = worldHandle ?? (allowActiveWorldFallback ? referenceData.activeWorldHandle ?? undefined : undefined);
	const rawThreadId = threadIdFromValue(threadId);
	const rawCommentId = commentIdFromValue(commentId);
	if (effectiveWorldHandle && forumHandle && rawThreadId) {
		return (
			<SpaLink
				className="readable-link"
				title={rawCommentId ? `Open ${title ?? "reply"}` : `Open ${title ?? "thread"}`}
				to={{ route: "thread", worldHandle: effectiveWorldHandle, forumHandle, threadId: rawThreadId, ...(rawCommentId ? { commentId: rawCommentId } : {}) }}
			>
				{title ?? label}
			</SpaLink>
		);
	}
	const href =
		rawCommentId ? `/c/${encodeURIComponent(rawCommentId)}`
		: rawThreadId ? `/t/${encodeURIComponent(rawThreadId)}`
		: null;
	if (href) {
		return (
			<a className="readable-link" href={href} title={rawCommentId ? `Open ${title ?? "reply"}` : `Open ${title ?? "thread"}`}>
				{title ?? label}
			</a>
		);
	}
	return <span>{title ?? label}</span>;
}

export function JsonSyntaxBlock({ value }: { value: unknown }) {
	return (
		<pre className="json-view">
			<code>{renderJsonValue(value, 0, { ancestors: [] })}</code>
		</pre>
	);
}

export function renderJsonValue(
	value: unknown,
	indent: number,
	context: { propertyKey?: string; parent?: JsonRecord; ancestors: JsonRecord[] },
): ReactNode {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return <span className="json-punctuation">[]</span>;
		}
		return (
			<>
				<span className="json-punctuation">[</span>
				{"\n"}
				{value.map((item, index) => (
					<span key={index}>
						{jsonIndent(indent + 1)}
						{renderJsonValue(item, indent + 1, context)}
						{index < value.length - 1 ? <span className="json-punctuation">,</span> : null}
						{"\n"}
					</span>
				))}
				{jsonIndent(indent)}
				<span className="json-punctuation">]</span>
			</>
		);
	}
	if (value && typeof value === "object") {
		const record = value as JsonRecord;
		const entries = Object.entries(record);
		if (entries.length === 0) {
			return <span className="json-punctuation">{"{}"}</span>;
		}
		const ancestors = [record, ...context.ancestors];
		return (
			<>
				<span className="json-punctuation">{"{"}</span>
				{"\n"}
				{entries.map(([key, item], index) => (
					<span key={key}>
						{jsonIndent(indent + 1)}
						<span className="json-key">"{key}"</span>
						<span className="json-punctuation">: </span>
						{renderJsonValue(item, indent + 1, { propertyKey: key, parent: record, ancestors })}
						{index < entries.length - 1 ? <span className="json-punctuation">,</span> : null}
						{"\n"}
					</span>
				))}
				{jsonIndent(indent)}
				<span className="json-punctuation">{"}"}</span>
			</>
		);
	}
	if (typeof value === "string") {
		return <JsonStringValue context={context} value={value} />;
	}
	if (typeof value === "number") {
		return <span className="json-number">{Number.isFinite(value) ? String(value) : "null"}</span>;
	}
	if (typeof value === "boolean") {
		return <span className="json-boolean">{String(value)}</span>;
	}
	return <span className="json-null">null</span>;
}

export function JsonStringValue({
	context,
	value,
}: {
	context: { propertyKey?: string; parent?: JsonRecord; ancestors: JsonRecord[] };
	value: string;
}) {
	const linked = linkedJsonString(value, context);
	if (linked) {
		return (
			<>
				<span className="json-string">"</span>
				{linked}
				<span className="json-string">"</span>
			</>
		);
	}
	return <span className="json-string">{JSON.stringify(value)}</span>;
}

export function linkedJsonString(
	value: string,
	context: { propertyKey?: string; parent?: JsonRecord; ancestors: JsonRecord[] },
): ReactNode | null {
	const key = context.propertyKey ?? "";
	const username = key === "username" || value.startsWith("u/") ? usernameHandle(value) : undefined;
	if (username) {
		return <Reference kind="bot" name={username} worldHandle={worldHandleFromJsonContext(context)} />;
	}
	const worldHandle = key === "world" || key === "worldHandle" || value.startsWith("w/") ? stripHandlePrefix(value, "w") : undefined;
	if (worldHandle) {
		return <Reference kind="world" name={worldHandle} />;
	}
	const forumHandle = key === "forum" || key === "forumHandle" || value.startsWith("f/") ? stripHandlePrefix(value, "f") : undefined;
	if (forumHandle) {
		return <Reference kind="forum" name={forumHandle} worldHandle={worldHandleFromJsonContext(context)} />;
	}
	const route = jsonStringRoute(value, context);
	if (route) {
		return (
			<SpaLink className="json-link" title="Open referenced Bickr item" to={route}>
				{value}
			</SpaLink>
		);
	}
	const threadId = key === "threadRef" || key === "threadId" || value.toLowerCase().startsWith("t/") ? threadIdFromValue(value) : undefined;
	if (threadId) {
		return <ContentReference id={threadId} interactive type="thread" />;
	}
	const commentId =
		key === "commentRef" || key === "commentId" || key === "parentCommentRef" || key === "parentCommentId" || key === "targetCommentRef" || key === "targetCommentId" || value.toLowerCase().startsWith("c/") ?
			commentIdFromValue(value)
		:	undefined;
	if (commentId) {
		return <ContentReference id={commentId} interactive type="comment" />;
	}
	return null;
}

export function jsonStringRoute(
	value: string,
	context: { propertyKey?: string; parent?: JsonRecord; ancestors: JsonRecord[] },
): ParsedRoute | null {
	const key = context.propertyKey ?? "";
	const parent = context.parent ?? {};
	const worldHandle = worldHandleFromJsonContext(context);
	const forumHandle = forumHandleFromJsonContext(context);
	if (!worldHandle || !forumHandle) {
		return null;
	}
	const parentType = stringValue(parent.type);
	const targetType = stringValue(parent.targetType);
	const threadId =
		key === "threadRef" || key === "threadId" ? threadIdFromValue(value)
		: key === "targetId" && targetType === "thread" ? threadIdFromValue(value)
		: key === "id" && (parentType === "thread" || stringValue(parent.title)) ? threadIdFromValue(value)
		: undefined;
	if (threadId) {
		return { route: "thread", worldHandle, forumHandle, threadId };
	}
	const commentId =
		key === "commentRef" || key === "commentId" || key === "parentCommentRef" || key === "parentCommentId" || key === "targetCommentRef" || key === "targetCommentId" ? commentIdFromValue(value)
		: key === "targetId" && targetType === "comment" ? commentIdFromValue(value)
		: key === "id" && (parentType === "comment" || stringValue(parent.threadId) || stringValue(parent.threadRef)) ? commentIdFromValue(value)
		: undefined;
	const containingThreadId = threadIdFromValue(parent.threadRef ?? parent.threadId) ?? findThreadIdInJsonAncestors(context.ancestors);
	if (commentId && containingThreadId) {
		return { route: "thread", worldHandle, forumHandle, threadId: containingThreadId, commentId };
	}
	return null;
}

export function loopToolCallsById(messages: BotLoopMessage[]): Map<string, LoopToolCallContext> {
	const byId = new Map<string, LoopToolCallContext>();
	for (const message of messages) {
		for (const toolCall of message.message.tool_calls ?? []) {
			byId.set(toolCall.id, {
				id: toolCall.id,
				name: canonicalDisplayToolName(toolCall.function.name || "unknown_tool"),
				args: parseToolArguments(toolCall),
			});
		}
	}
	for (const message of messages) {
		const toolCallId = message.message.tool_call_id;
		if (!toolCallId) {
			continue;
		}
		const context = byId.get(toolCallId);
		if (context) {
			context.display = message.display;
			context.result = message.display?.kind === "tool_result" ? message.display.result : parseJsonValue(message.message.content);
		}
	}
	return byId;
}

export function parseToolArguments(toolCall: LoopToolCall): JsonRecord {
	return recordValue(parseJsonValue(toolCall.function.arguments));
}

export function readableToolFailureRecord(value: unknown): JsonRecord | null {
	const record = recordValue(value);
	return record.ok === false ? record : null;
}

export function parseJsonForDisplay(value: unknown): { ok: true; value: unknown } | { ok: false } {
	if (typeof value !== "string") {
		return { ok: true, value };
	}
	const trimmed = value.trim();
	if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
		return { ok: false };
	}
	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch {
		return { ok: false };
	}
}

export function parseJsonValue(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const trimmed = value.trim();
	if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

export function inferToolNameFromResult(value: unknown): string {
	const record = recordValue(value);
	if (Array.isArray(record.events)) {
		return "check_notifications";
	}
	if (Array.isArray(record.profiles) && (record.mode === "window" || record.mode === "random")) {
		return "list_profiles";
	}
	if (Array.isArray(record.profiles)) {
		return "view_profiles";
	}
	if (Array.isArray(record.content) && record.thread) {
		return "read_thread";
	}
	if (record.comment) {
		return "reply_to_comment";
	}
	if (record.rootPost || record.rootCommentId || record.thread) {
		return "create_thread";
	}
	return "unknown_tool";
}

export function canonicalDisplayToolName(name: string): string {
	const aliases: Record<string, string> = {
		create_post: "create_thread",
		follow_bot: "follow_profile",
		reply_to_thread: "reply_to_comment",
		search_bots: "search_profiles",
		search_posts: "search_threads",
		search_posts_semantic: "search_threads_semantic",
		unfollow_bot: "unfollow_profile",
		view_bot_activity: "view_activity",
		view_bot_profile: "view_profiles",
		view_profile: "view_profiles",
	};
	return aliases[name] ?? name;
}

export function stringValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const text = (value as { text?: unknown }).text;
		if (typeof text === "string" && text.trim()) {
			return text.trim();
		}
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

export function threadIdFromValue(value: unknown): string | undefined {
	const text = stringValue(value);
	if (!text) {
		return undefined;
	}
	return parseThreadRef(text);
}

export function commentIdFromValue(value: unknown): string | undefined {
	const text = stringValue(value);
	if (!text) {
		return undefined;
	}
	return parseCommentRef(text);
}

export function threadIdFromRecord(record: JsonRecord): string | undefined {
	return threadIdFromValue(record.threadRef ?? record.threadId ?? record.id);
}

export function commentIdFromRecord(record: JsonRecord): string | undefined {
	return commentIdFromValue(record.commentRef ?? record.commentId ?? record.id);
}

export function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.flatMap((item) => {
		const text = stringValue(item);
		return text ? [text] : [];
	}) : [];
}

export function recordValue(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function firstVoteArg(args: JsonRecord): JsonRecord {
	return arrayValue(args.votes).map(recordValue)[0] ?? {};
}

export function isDisplayPrimitive(value: unknown): boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function lowLevelDisplayKey(key: string): boolean {
	return /(^id$|Id$|_id$|objectId$|tool_call|token|raw|json)/i.test(key);
}

export function humanizeKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export function usernamesFromValue(value: unknown): string[] {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	return values
		.map((item) => {
			if (typeof item === "string") {
				return item;
			}
			const record = recordValue(item);
			return stringValue(record.username) ?? stringValue(record.handle);
		})
		.filter((item): item is string => Boolean(item));
}

export function usernameHandle(value: string | undefined): string | undefined {
	return value ? stripHandlePrefix(value, "u") ?? value : undefined;
}

export function profileRecordFromValue(value: unknown): JsonRecord {
	if (typeof value === "string") {
		return { username: value };
	}
	return recordValue(value);
}

export function firstProfileRecord(...values: unknown[]): JsonRecord {
	for (const value of values) {
		const profile = profileRecordFromValue(value);
		if (profileHasHandle(profile)) {
			return profile;
		}
	}
	return {};
}

export function profileHasHandle(profile: JsonRecord): boolean {
	return Boolean(usernameHandle(stringValue(profile.username)) ?? stringValue(profile.handle) ?? stringValue(profile.authorHandle));
}

export function worldHandleFromRecord(record: JsonRecord): string | undefined {
	return (
		stripHandlePrefix(stringValue(record.world), "w") ??
		stripHandlePrefix(stringValue(record.worldHandle), "w") ??
		stripHandlePrefix(stringValue(record.homeWorldHandle), "w") ??
		stripExplicitHandlePrefix(stringValue(record.handle), "w") ??
		stripHandlePrefix(stringValue(recordValue(record.world).handle), "w")
	);
}

export function forumHandleFromRecord(record: JsonRecord): string | undefined {
	return (
		stripHandlePrefix(stringValue(record.forum), "f") ??
		stripHandlePrefix(stringValue(record.forumHandle), "f") ??
		stripExplicitHandlePrefix(stringValue(record.handle), "f") ??
		stripHandlePrefix(stringValue(recordValue(record.forum).handle), "f")
	);
}

export function stripHandlePrefix(value: string | undefined, prefix: "u" | "w" | "f"): string | undefined {
	if (!value) {
		return undefined;
	}
	const expected = `${prefix}/`;
	return value.startsWith(expected) ? value.slice(expected.length) : value;
}

export function stripExplicitHandlePrefix(value: string | undefined, prefix: "u" | "w" | "f"): string | undefined {
	if (!value) {
		return undefined;
	}
	const expected = `${prefix}/`;
	return value.startsWith(expected) ? value.slice(expected.length) : undefined;
}

export function worldHandleFromJsonContext(context: { parent?: JsonRecord; ancestors: JsonRecord[] }): string | undefined {
	return findHandleInJsonContext("world", context);
}

export function forumHandleFromJsonContext(context: { parent?: JsonRecord; ancestors: JsonRecord[] }): string | undefined {
	return findHandleInJsonContext("forum", context);
}

export function findHandleInJsonContext(kind: "world" | "forum", context: { parent?: JsonRecord; ancestors: JsonRecord[] }): string | undefined {
	const records = [context.parent, ...context.ancestors].filter((item): item is JsonRecord => Boolean(item));
	for (const record of records) {
		const handle = kind === "world" ? worldHandleFromRecord(record) : forumHandleFromRecord(record);
		if (handle) {
			return handle;
		}
	}
	return undefined;
}

export function findStringInJsonAncestors(ancestors: JsonRecord[], ...keys: string[]): string | undefined {
	for (const record of ancestors) {
		for (const key of keys) {
			const direct = stringValue(record[key]);
			if (direct) {
				return direct;
			}
			const nested = stringValue(recordValue(record.thread)[key]);
			if (nested) {
				return nested;
			}
		}
	}
	return undefined;
}

export function findThreadIdInJsonAncestors(ancestors: JsonRecord[]): string | undefined {
	for (const record of ancestors) {
		const direct = threadIdFromValue(record.threadRef ?? record.threadId);
		if (direct) {
			return direct;
		}
		const thread = recordValue(record.thread);
		const nested = threadIdFromValue(thread.threadRef ?? thread.threadId ?? thread.id);
		if (nested) {
			return nested;
		}
	}
	return findStringInJsonAncestors(ancestors, "threadId", "id");
}

export function voteActionLabel(value: number | undefined): string {
	if ((value ?? 0) > 0) {
		return "upvoted";
	}
	if ((value ?? 0) < 0) {
		return "downvoted";
	}
	return "cleared vote on";
}

export function joinReadable(items: ReactNode[]): ReactNode {
	return items.map((item, index) => (
		<span className="readable-join-item" key={index}>
			{index > 0 ? index === items.length - 1 ? " and " : ", " : ""}
			{item}
		</span>
	));
}

export function jsonIndent(level: number): string {
	return "\t".repeat(level);
}
