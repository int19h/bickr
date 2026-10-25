import { AgentLogCard, AgentLogBody, AgentLogExpandControl } from './agent-log-card';
import type { AgentLogAuthor, AgentLogCompactionSession, AgentLogEntry, BotLoopMessage, BotLoopMessagePage } from '@bickr/shared/model';
import type { Ref } from 'react';
import { useMemo, useState } from 'react';
import { TimeAgoLabel } from '../../components/record-display';
import { LoopMarkdown } from '../../readable/loop-markdown';
import { LoopMessageReadableView } from '../../readable/loop-message-readable';
import { indexAgentLogCalls } from './agent-log-calls';
import { Icon, type IconName } from '../../ui';
import { AgentLogCall, AgentLogReasoning, storedResponseMessage, storedPartialMessage } from './agent-log-content';
import { formatTokenCount } from './token-usage';

type MessageEntry = Extract<AgentLogEntry, { kind: 'message' }>;
const sources: Partial<Record<AgentLogAuthor['kind'], { label: string; icon: IconName }>> = {
	owner_injection: { label: 'Owner injection', icon: 'edit' },
	reminder: { label: 'Bickr reminder', icon: 'bell' },
	self_correction: { label: 'Self-correction', icon: 'refresh' },
	recurring_prompt: { label: 'Recurring prompt', icon: 'clock' },
	spotlight_focus: { label: 'Spotlight focus', icon: 'spotlight' },
	synthetic_tool_call: { label: 'Synthetic tool call', icon: 'sparkles' },
	local_simulation: { label: 'Local simulation', icon: 'monitor' },
	legacy_synthetic: { label: 'Synthetic', icon: 'sparkles' },
	unknown: { label: 'Unknown source', icon: 'info' },
};

function sourceFor(author: AgentLogAuthor) {
	switch (author.kind) {
		case 'model':
		case 'bickr_report':
		case 'tool_result':
		case 'compaction_summary':
		case 'legacy_summary':
			return null;
		default:
			return sources[author.kind] ?? sources.unknown!;
	}
}

export type AgentLogViewProps = {
	entries: AgentLogEntry[];
	page: BotLoopMessagePage | null;
	participantName: string;
	onDelete: (message: BotLoopMessage) => void;
	onLogs: (message: BotLoopMessage) => void;
	onRequest: (id: string, errors?: boolean) => void;
	onSession: (id: string) => void;
	onPage: (page: number, sessionId?: string) => void;
	sessions?: ReadonlyMap<string, AgentLogCompactionSession>;
	deletingSeq?: number | null;
	loadingSeq?: number | null;
	source?: { seq: number; runId: string } | null;
	sourceRef?: Ref<HTMLDivElement>;
};

export function AgentLogView(props: AgentLogViewProps) {
	const { entries, page, participantName, sessions } = props;
	const [activeCall, setActiveCall] = useState<number | null>(null);
	const ordered = useMemo(() => [...entries].sort((a, b) => a.position - b.position), [entries]);
	const { calls, results } = useMemo(() => indexAgentLogCalls(ordered), [ordered]);
	const summary = page?.pages.find((item) => item.page === page.currentPage);
	const archive = summary?.isNewest === false || (page?.currentPage ?? 1) !== 1;
	const removeLabel = archive ? 'Remove from archive' : 'Remove from context';
	return (
		<div className={`agent-log${archive ? ' agent-log-archive' : ''}`}>
			<p className="agent-log-caption">{archive ? 'archive' : 'newest · in context'}</p>
			{page?.olderPage && (
				<p className="agent-log-notice">
					Page {page.currentPage} began after compaction.{' '}
					<button onClick={() => props.onPage(page.olderPage!)} type="button">
						Open page {page.olderPage}
					</button>
				</p>
			)}
			{ordered.length === 0 && <p className="agent-log-notice">No loop chat messages yet.</p>}
			{ordered.map((entry, index) => {
				if (entry.kind === 'notice')
					return (
						<AgentLogNoticeView
							key={`notice-${entry.position}-${index}`}
							entry={entry}
							page={page}
							session={entry.notice.kind === 'compaction_started' ? sessions?.get(entry.notice.sessionId) : undefined}
							onRequest={props.onRequest}
							onSession={props.onSession}
							onPage={props.onPage}
						/>
					);
				if (entry.kind !== 'message' && entry.kind !== 'live')
					return (
						<p className="agent-log-notice" key={`unknown-${index}`}>
							Unknown log entry.
						</p>
					);
				const live = entry.kind === 'live';
				const messageEntry = live ? null : (entry as MessageEntry);
				const row = messageEntry?.message;
				const message = live ? (entry.response ? storedResponseMessage(entry.response) : storedPartialMessage(entry.partialResponse)) : row!.message;
				const source = messageEntry ? sourceFor(messageEntry.author) : null;
				const tool = message.role === 'tool';
				const isSummary = messageEntry?.author.kind === 'compaction_summary' || messageEntry?.author.kind === 'legacy_summary';
				const noticePage = isSummary && row ? page?.compactionPageBySeq[String(row.seq)] : undefined;
				const right =
					source && messageEntry?.author.kind !== 'unknown' && sources[messageEntry!.author.kind] ? false : message.role === 'user' || tool;
				const faded =
					messageEntry?.author.kind === 'synthetic_tool_call' ||
					(messageEntry?.author.kind === 'tool_result' && messageEntry.author.synthetic);
				const resultCall = results.get(entry);
				const number = resultCall?.number;
				const requestId = entry.requestId;
				const hasInfo = live || !!requestId || tool || isSummary || !!row?.hasLogs || messageEntry?.author.kind === 'model';
				const highlight = !!row && props.source?.seq === row.seq && props.source.runId === row.runId;
				const showInfo = () => {
					if (isSummary && messageEntry?.sessionId) props.onSession(messageEntry.sessionId);
					else if (tool && row) props.onLogs(row);
					else if (requestId) props.onRequest(requestId);
					else if (row) props.onLogs(row);
				};
				return (
					<AgentLogCard expandable={tool || (message.role === 'user' && row?.contentFormat === 'markdown')}
						key={!tool && requestId ? requestId : `message-${row?.seq}`}
						ref={highlight ? props.sourceRef : undefined}
						id={number ? `loop-result-${number}` : undefined}
						className={`agent-log-card ${right ? 'side-right' : 'side-left'} ${isSummary ? 'tint-summary' : tool ? 'tint-tool' : right ? 'tint-user' : 'tint-assistant'}${source ? ' injected' : ''}${faded ? ' faded' : ''}${live ? ' is-live' : ''}${highlight ? ' source-message-highlight' : ''}${number && activeCall === number ? ' call-highlight' : ''}`}
						onMouseEnter={() => number && setActiveCall(number)}
						onMouseLeave={() => number && setActiveCall(null)}
						onFocus={() => number && setActiveCall(number)}
						onBlur={() => number && setActiveCall(null)}
					>
						<div className="agent-log-corner">
							{source && (
								<span className="agent-log-source" role="img" aria-label={source.label} title={source.label}>
									<Icon name={source.icon} size={12} />
									<span>{source.label}</span>
								</span>
							)}
							{hasInfo && (
								<button
									className="agent-log-info"
									type="button"
									aria-label={row ? `Open raw logs for loop message ${row.seq}` : 'Open live request'}
									disabled={!!row && props.loadingSeq === row.seq}
									onClick={showInfo}
								>
									<Icon name="info" size={14} />
								</button>
							)}
						</div>
						<div className="agent-log-head">
							{number && (
								<a className="agent-log-call-number" href={`#loop-call-${number}`}>
									{number}
								</a>
							)}
							<span className="agent-log-role">
								{live && <span className="agent-log-pulse" />}
								{isSummary ? (
									<>
										<Icon name="compaction" size={13} />
										{participantName}
									</>
								) : tool ? (
									'Tool result'
								) : right ? (
									'Bickr'
								) : (
									'Assistant'
								)}
							</span>
							{row && (
								<>
									<TimeAgoLabel value={row.createdAt} />
									<span>{formatTokenCount(row.tokenEstimate)} tokens</span>
								</>
							)}
						</div>
						<AgentLogReasoning message={message} />
						<AgentLogBody>
							{tool ? (
								<LoopMessageReadableView
									message={message}
									display={row?.display}
									contentFormat={row?.contentFormat}
									toolCall={resultCall?.context}
								/>
							) : row && row.contentFormat !== 'markdown' ? (
								<div className="loop-readable-text">{message.content}</div>
							) : (
								<LoopMarkdown text={message.content ?? ''} worldHandle={row?.display?.context?.worldHandle} />
							)}
						</AgentLogBody>
						{calls.get(entry)?.map((link) => (
							<AgentLogCall
								key={link.number}
								number={link.number}
								call={link.call}
								context={link.context}
								active={activeCall === link.number}
								onActive={(active) => setActiveCall(active ? link.number : null)}
							/>
						))}
						<div className="agent-log-foot">
							<AgentLogExpandControl />
							{row && (
								<button
									className="agent-log-delete"
									type="button"
									aria-label={`${removeLabel}: message ${row.seq}`}
									disabled={props.deletingSeq === row.seq}
									onClick={() => props.onDelete(row)}
								>
									<Icon name="trash" size={13} />
									<span>{removeLabel}</span>
								</button>
							)}
							<div className="agent-log-foot-links">
								{number && <a href={`#loop-call-${number}`}>result of call {number}</a>}
								{tool && !number && row && (
									<button type="button" onClick={() => props.onLogs(row)}>
										Open the call
									</button>
								)}
								{isSummary && noticePage !== undefined && (
									<button type="button" onClick={() => props.onPage(noticePage!, messageEntry?.sessionId ?? undefined)}>
										Open the compaction notice
									</button>
								)}
								{isSummary && messageEntry?.sessionId && (
									<button type="button" onClick={() => props.onSession(messageEntry.sessionId!)}>
										Open the session log
									</button>
								)}
							</div>
							<span className="agent-log-status">
								{live ? (
									'streaming'
								) : row?.status === 'interrupted' ? (
									<span className="agent-log-pill">
										<Icon name="pause" size={12} />
										Interrupted
									</span>
								) : entry.attempts && entry.attempts.count > 1 && requestId ? (
									<button className="agent-log-pill error" type="button" onClick={() => props.onRequest(requestId, true)}>
										<Icon name="alert" size={12} />
										{entry.attempts.count - 1} {entry.attempts.count === 2 ? 'retry' : 'retries'}
									</button>
								) : row?.status && row.status !== 'complete' ? (
									<span className="agent-log-pill">{row.status === 'invalid' ? 'Invalid' : 'Unknown status'}</span>
								) : null}
							</span>
						</div>
					</AgentLogCard>
				);
			})}
			{page?.newerPage && !ordered.some((entry) => entry.kind === 'notice' && entry.notice.kind === 'compaction_started') && (
				<p className="agent-log-notice">
					Continue on{' '}
					<button type="button" onClick={() => props.onPage(page.newerPage!)}>
						page {page.newerPage}
					</button>
				</p>
			)}
		</div>
	);
}

function AgentLogNoticeView({
	entry,
	page,
	session,
	onRequest,
	onSession,
	onPage,
}: {
	entry: Extract<AgentLogEntry, { kind: 'notice' }>;
	page: BotLoopMessagePage | null;
	session?: AgentLogCompactionSession;
	onRequest: AgentLogViewProps['onRequest'];
	onSession: AgentLogViewProps['onSession'];
	onPage: AgentLogViewProps['onPage'];
}) {
	const notice = entry.notice;
	switch (notice.kind) {
		case 'runtime_error':
		case 'dropped_output':
			return (
				<p className="agent-log-notice">
					<span className="agent-log-error">{notice.kind === 'runtime_error' ? 'Runtime error' : 'Dropped output'}.</span> {notice.message}
				</p>
			);
		case 'request_failed':
			return (
				<p className="agent-log-notice">
					<button className="agent-log-error" type="button" onClick={() => onRequest(notice.requestId, true)}>
						No response after {notice.attempts.count} {notice.attempts.count === 1 ? 'attempt' : 'attempts'}
					</button>
				</p>
			);
		case 'compaction_started': {
			const outcome = notice.outcome;
			const attempts = session?.requests.reduce((count, request) => count + request.attempts.length, 0);
			const failed = outcome.kind === 'failed';
			const label = failed
				? `Compaction failed${attempts !== undefined ? ` after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}` : ''}`
				: outcome.kind === 'partial'
					? `Compaction partly succeeded · ${outcome.failedBatchCount} ${outcome.failedBatchCount === 1 ? 'batch' : 'batches'} failed`
					: outcome.kind === 'pending' || outcome.kind === 'succeeded'
						? 'Compaction began here'
						: 'Unknown compaction outcome';
			return (
				<div className="agent-log-notice" id={`loop-session-${notice.sessionId}`}>
					<button
						className={`agent-log-compaction${failed || outcome.kind === 'partial' ? ' error' : ''}`}
						type="button"
						onClick={() => onSession(notice.sessionId)}
					>
						{label}
						{session && (
							<>
								{' '}
								· <TimeAgoLabel value={session.createdAt} /> · {session.requests.length} {session.requests.length === 1 ? 'call' : 'calls'}
							</>
						)}{' '}
						· open the session log
					</button>
					{(outcome.kind === 'succeeded' || outcome.kind === 'partial') && page?.newerPage && (
						<p>
							Continue on{' '}
							<button type="button" onClick={() => onPage(page.newerPage!)}>
								page {page.newerPage}
							</button>
						</p>
					)}
				</div>
			);
		}
		default:
			return <p className="agent-log-notice">Unknown runtime notice.</p>;
	}
}
