import type { AgentLogRequest, AgentLogAttempt } from "@bickr/shared/model";
import { InferenceAttributionFields } from "../../components/inference-attribution";
import type { Ref } from "react";
import type {
	BotInferenceSubmissionMessage,
	BotLoopMessage,
	BotLoopMessageLogsResponse,
	BotLoopMessagePage,
	BotLoopMessageRequestLogMessage,
	BotLoopMessageRequestUsage,
} from "@bickr/shared/model";
import { TimeAgoLabel } from "../../components/record-display";
import { prettyJsonText } from "../../inference-submission-formatting";
import { isLiveProviderLoopMessage } from "../../loop-message-streams";
import { loopPagePagerItems } from "../../loop-page-pager";
import { Icon, Modal } from "../../ui";
import { LoopMessageReadableView, type LoopToolCallContext } from "../../readable/loop-message-readable";
import { JsonSyntaxBlock, parseJsonForDisplay } from "../../readable/loop-message-values";
import { RuntimeRow } from "./runtime-row";
import { loopMessageActivityKind, loopMessageLogKindLabel, loopMessageOriginLabel, loopMessageTitle } from "./runtime-utils";
import { formatByteCount, formatNullableUsageCost, formatTokenCount } from "./token-usage";

export function LoopMessageLogsModal({
	onClose,
	open,
	payload,
}: {
	onClose: () => void;
	open: boolean;
	payload: BotLoopMessageLogsResponse | null;
}) {
	if (!payload) {
		return null;
	}

	const { message, logs } = payload;

	return (
		<Modal className="submission-modal" onClose={onClose} open={open} title="Loop Message Logs" wide>
			<div className="submission-meta">
				<RuntimeRow label="Message" value={`#${message.seq}`} />
				<RuntimeRow label="Role" value={message.role} />
				<RuntimeRow label="Origin" value={loopMessageOriginLabel(message.origin)} />
				<RuntimeRow label="Run" value={message.runId} />
			</div>
			<div className="submission-chat-log">
				{payload.request ? <AgentLogRequestView request={payload.request} /> : <p>The exact request is not retained.</p>}
				{logs.length === 0 ?
					<div className="empty compact-empty">No retained raw logs for this message.</div>
				:	logs.filter(log => log.kind !== "inference_attribution").map((log) => (
						<div className="submission-message role-system" key={log.id}>
							<div className="submission-message-head">
								<b>{loopMessageLogKindLabel(log.kind)}</b>
								<span>#{log.id}</span>
								<span>{log.encoding}</span>
								<span>{formatByteCount(log.textLength)}</span>
							</div>
							<SubmissionJsonBlock label="log" value={log.text} />
						</div>
					))}
			</div>
		</Modal>
	);
}

export function LoopMessageRow({
	deleting,
	highlighted = false,
	rowRef,
	loadingLogs,
	message,
	onDelete,
	onViewLogs,
	toolCallsById,
}: {
	deleting: boolean;
	highlighted?: boolean;
	rowRef?: Ref<HTMLDivElement>;
	loadingLogs: boolean;
	message: BotLoopMessage;
	onDelete: () => void;
	onViewLogs: () => void;
	toolCallsById: ReadonlyMap<string, LoopToolCallContext>;
}) {
	const status =
		message.status === "interrupted" ? "interrupted"
		: message.status === "invalid" ? "invalid / dropped"
		: null;
	const toolCallContext = message.message.tool_call_id ? toolCallsById.get(message.message.tool_call_id) : undefined;
	const isLive = isLiveProviderLoopMessage(message);
	return (
		<div className={`event-row activity-${loopMessageActivityKind(message)}${highlighted ? " source-message-highlight" : ""}`} ref={rowRef}>
			<button
				aria-label={`Open raw logs for loop message ${message.seq}`}
				className="raw-json-button"
				disabled={loadingLogs || isLive}
				onClick={onViewLogs}
				title="Open retained provider and tool logs"
				type="button"
			>
				{loadingLogs ? <span className="spinner" /> : <Icon name="info" size={13} />}
			</button>
			<button
				aria-label={`Delete loop message ${message.seq}`}
				className="event-delete-button"
				disabled={deleting || isLive}
				onClick={onDelete}
				title={isLive ? "Streaming messages cannot be deleted yet" : "Delete this message from the Loop log"}
				type="button"
			>
				{deleting ? <span className="spinner" /> : <Icon name="trash" size={13} />}
			</button>
			<div className="event-head">
				<span>{isLive ? "live" : `#${message.seq}`}</span>
				<b>{loopMessageTitle(message)}</b>
				<TimeAgoLabel value={message.createdAt} />
				{status && <span className="streaming-pill">{status}</span>}
			</div>
			<div className="event-meta">
				{loopMessageOriginLabel(message.origin)} / {message.runId} / {formatTokenCount(message.tokenEstimate)} tokens
			</div>
			<LoopMessageReadableView contentFormat={message.contentFormat} display={message.display} message={message.message} origin={message.origin} toolCall={toolCallContext} toolCallsById={toolCallsById} />
		</div>
	);
}

export function LoopContinuationRow({
	label,
	onPageSelect,
	page,
}: {
	label: string;
	onPageSelect: (page: number) => void;
	page: number;
}) {
	return (
		<div className="event-row loop-continuation-row">
			<LoopContinuationLink label={label} onPageSelect={onPageSelect} page={page} />
		</div>
	);
}

export function LoopContinuationLink({
	label,
	onPageSelect,
	page,
}: {
	label: string;
	onPageSelect: (page: number) => void;
	page: number;
}) {
	return (
		<div className="loop-continuation-note">
			<span>{label}</span>
			<button onClick={() => onPageSelect(page)} title={`Open loop page ${page}`} type="button">
				page {page}
			</button>
		</div>
	);
}

export function LoopMessageRequestUsageLine({ usage }: { usage: BotLoopMessageRequestUsage }) {
	const estimatedSplit = usage.estimatedCostSplit ? " approx." : "";
	return (
		<div className="request-usage-line">
			{formatTokenCount(usage.cachedInputTokens)} cached input tokens ({formatNullableUsageCost(usage.cachedInputCost)}{estimatedSplit})
			{" + "}
			{formatTokenCount(usage.uncachedInputTokens)} uncached input tokens ({formatNullableUsageCost(usage.uncachedInputCost)}{estimatedSplit})
			{" + "}
			{formatTokenCount(usage.outputTokens)} output tokens ({formatNullableUsageCost(usage.outputCost)})
			{" = "}
			{formatNullableUsageCost(usage.totalCost)}
		</div>
	);
}

export function RequestLogMessageView({ item }: { item: BotLoopMessageRequestLogMessage }) {
	return (
		<RawInferenceSubmissionMessageView
			cacheStatus={item.cacheStatus}
			message={item.message}
			position={item.position}
		/>
	);
}

export function LoopMessagePager({
	onPageSelect,
	page,
}: {
	onPageSelect: (page: number) => void;
	page: BotLoopMessagePage | null;
}) {
	if (!page || page.pageCount <= 1) {
		return null;
	}
	const items = loopPagePagerItems(page);
	if (items.length === 0) {
		return null;
	}
	return (
		<div aria-label="Loop history pages" className="loop-page-pager">
			<span className="loop-page-pager-label">Page:</span>
			{items.map((item) => (
				item.kind === "ellipsis" ?
					<a
						aria-label={`Jump ${item.direction === "backward" ? "back" : "forward"} 25 loop pages`}
						className="loop-page-link ellipsis"
						href={`#loop-page-${item.page}`}
						key={`${item.direction}-${item.page}`}
						onClick={(event) => {
							event.preventDefault();
							onPageSelect(item.page);
						}}
						title={`Open loop page ${item.page}`}
					>
						…
					</a>
				:	<a
						aria-current={item.current ? "page" : undefined}
						className={`loop-page-link ${item.current ? "active" : ""}`}
						href={`#loop-page-${item.page}`}
						key={item.page}
						onClick={(event) => {
							event.preventDefault();
							onPageSelect(item.page);
						}}
						title={`Open loop page ${item.page}${item.messageCount ? ` (${item.messageCount} messages)` : ""}`}
					>
						{item.page}
					</a>
			))}
		</div>
	);
}

export function RawInferenceSubmissionMessageView({
	cacheStatus,
	message,
	position,
}: {
	cacheStatus?: BotLoopMessageRequestLogMessage["cacheStatus"];
	message: BotInferenceSubmissionMessage;
	position: number;
}) {
	const toolCalls = message.tool_calls ?? [];
	return (
		<div className={`submission-message role-${message.role}`}>
			<div className="submission-message-head">
				<b>{message.role}</b>
				<span>#{position}</span>
				{message.tool_call_id && <span>{message.tool_call_id}</span>}
				{cacheStatus && <span className="cache-status">{cacheStatus === "cached" ? "cached" : "partially cached"}</span>}
			</div>
			{message.content && (
				<SubmissionJsonBlock label={message.role === "tool" ? "JSON result" : "content"} value={message.content} />
			)}
			{message.reasoning && <SubmissionJsonBlock label="reasoning" value={message.reasoning} />}
			{message.reasoning_content && <SubmissionJsonBlock label="reasoning_content" value={message.reasoning_content} />}
			{message.reasoning_details && <SubmissionJsonBlock label="reasoning_details" value={message.reasoning_details} />}
			{toolCalls.map((toolCall, index) => (
				<div className="submission-tool-call" key={`${toolCall.id}-${index}`}>
					<div className="submission-tool-name">{toolCall.function.name || "unknown_tool"}</div>
					<SubmissionJsonBlock label="JSON arguments" value={toolCall.function.arguments} />
				</div>
			))}
		</div>
	);
}

export function SubmissionJsonBlock({ label, value }: { label: string; value: unknown }) {
	const parsed = parseJsonForDisplay(value);
	return (
		<div className="submission-json-block">
			<span>{label}</span>
			{parsed.ok ?
				<JsonSyntaxBlock value={parsed.value} />
			:	<pre>{prettyJsonText(value)}</pre>}
		</div>
	);
}

export function AgentLogRequestView({ request }: { request: AgentLogRequest }) {
	const selected = request.attempts.find(attempt => attempt.outcome?.kind === 'success') ?? request.attempts.findLast(attempt => attempt.outcome === null);
	return <div>
		<p>{request.state}. Attempts: {request.attempts.length}.</p>
		{selected && <AgentLogAttemptDetails attempt={selected} />}
		{selected && <AgentLogAttemptResponse attempt={selected} />}
		{request.attempts.filter(attempt => attempt.outcome && attempt.outcome.kind !== 'success').map(attempt => <details key={attempt.id}>
			<summary>Attempt {attempt.id}: {attempt.outcome?.kind}</summary>
			<pre>{JSON.stringify(attempt.outcome, null, 2)}</pre>
			<AgentLogAttemptDetails attempt={attempt} />
			<AgentLogAttemptResponse attempt={attempt} />
		</details>)}
	</div>;
}

function AgentLogAttemptDetails({ attempt }: { attempt: AgentLogAttempt }) {
	return <div>
		{attempt.usage && <LoopMessageRequestUsageLine usage={attempt.usage} />}
		{attempt.attribution && <InferenceAttributionFields attribution={attempt.attribution} />}
		{attempt.messages.map(item => <RequestLogMessageView key={item.position} item={item} />)}
		{attempt.body !== null ? <details><summary>Request body</summary><pre>{attempt.body}</pre></details> : <p>The exact request is not retained.</p>}
	</div>;
}

function AgentLogAttemptResponse({ attempt }: { attempt: AgentLogAttempt }) {
	const outcome = attempt.outcome;
	const response = outcome?.kind === 'success' || outcome?.kind === 'interrupted' ? outcome.response : null;
	return response ? <pre>{response}</pre> : attempt.partialResponse ? <pre>{attempt.partialResponse}</pre> : null;
}
