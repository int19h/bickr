import { SubmissionJsonBlock } from "./loop-log-formatting";
import { AgentLogRequestDetails } from "./agent-log-details";
import type {
	BotLoopMessageLogsResponse,
	BotLoopMessagePage,
} from "@bickr/shared/model";
import { loopPagePagerItems } from "../../loop-page-pager";
import { Modal } from "../../ui";
import { RuntimeRow } from "./runtime-row";
import { loopMessageLogKindLabel, loopMessageOriginLabel } from "./runtime-utils";
import { formatByteCount } from "./token-usage";

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
				{payload.request ? <AgentLogRequestDetails request={payload.request} /> : message.role !== "tool" && <p>The exact request is not retained.</p>}
				{logs.length === 0 ?
					<div className="empty compact-empty">No retained raw logs for this message.</div>
				:	logs.filter(log => message.role === "tool" ? log.kind === "tool_call" || log.kind === "tool_result" : log.kind !== "inference_attribution" && (!payload.request || (log.kind !== "provider_request" && log.kind !== "provider_response"))).map((log) => (
						<div className="submission-message role-system" key={log.id}>
							<div className="submission-message-head">
								<b>{loopMessageLogKindLabel(log.kind)}</b>
								<span>#{log.id}</span>
								<span>{log.encoding}</span>
								<span>{formatByteCount(log.textLength)}</span>
							</div>
							{message.role === "tool" && log.kind === "tool_result" ? <pre>{log.text}</pre> : <SubmissionJsonBlock label="log" value={log.text} />}
						</div>
					))}
			</div>
		</Modal>
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
