import type {
	AgentLogEntry,
	AgentLogRequest,
	AgentLogCompactionSession,
	BotLoopMessage,
	BotLoopMessageLogsResponse,
	BotLoopMessagePage,
	BotLoopMessagesResponse,
	BotRuntimeEvent,
	BotRuntimeStopResult,
	BotRuntimeStatus,
	BotSummary,
	BotTokenUsageStats,
	UpdateBotInput,
} from "@bickr/shared/model";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { NextDueAtLabel } from "../../components/record-display";
import {
	isLiveProviderLoopMessage,
	removeLiveProviderLoopMessagesForFinalizedMessage,
	removeLiveProviderLoopMessagesForRun,
	upsertLiveProviderLoopMessage,
} from "../../loop-message-streams";
import { Confirm, textValue } from "../../ui";
import { useBotEffectiveModels } from "../../inference/bot-models";
import { LoopMessageLogsModal, LoopMessagePager } from "./loop-messages";
import { AgentLogView } from "./agent-log-view";
import { AgentLogRequestModal, AgentLogSessionModal } from "./agent-log-details";
import { RuntimeRow } from "./runtime-row";
import {
	formatTickIntervalMinutes,
	latestLoopMessageSeq,
	latestPersistentEventSeq,
	mergeLoopMessages,
	reconnectDelayMs,
	runtimeCompactionMessage,
	scrollLogToBottom,
	upsertEvent,
	upsertLoopMessage,
} from "./runtime-utils";
import { ContextWindowBar, TokenUsagePanel } from "./token-usage";

export type RuntimeMonitorPayload = {
	type?: string;
	event?: BotRuntimeEvent;
	message?: string;
	loopMessage?: BotLoopMessage;
	seq?: number;
	deletedAt?: string;
};

type RequestLogEntry = Extract<AgentLogEntry, { kind: 'live' | 'message' }>;

function ignoresStreamDelta(entry: RequestLogEntry | undefined, delta: { attemptId?: number; deltaRevision?: number }): boolean {
	if (!entry) return false;
	if (entry.kind === 'message') return true;
	if (entry.attemptId !== undefined && delta.attemptId !== undefined && entry.attemptId !== delta.attemptId) return delta.attemptId < entry.attemptId;
	return entry.response !== null || (entry.deltaRevision !== undefined && delta.deltaRevision !== undefined && delta.deltaRevision <= entry.deltaRevision);
}

export function BotRuntimePanel({
	bot,
	busy,
	onSave,
}: {
	bot: BotSummary;
	busy: boolean;
	onSave: (botId: string, draft: UpdateBotInput) => Promise<boolean>;
}) {
	const detailGenerationRef = useRef(0);
	const [status, setStatus] = useState<BotRuntimeStatus | null>(null);
	const [events, setEvents] = useState<BotRuntimeEvent[]>([]);
	const [loopEntries, setLoopEntries] = useState<AgentLogEntry[]>([]);
	const [requestDetail, setRequestDetail] = useState<AgentLogRequest | null>(null);
	const [requestErrors, setRequestErrors] = useState(false);
	const [sessions, setSessions] = useState(new Map<string, AgentLogCompactionSession>());
	const [sessionDetail, setSessionDetail] = useState<AgentLogCompactionSession | null>(null);
	useEffect(() => {
		if (!requestDetail || requestDetail.state !== 'pending') return;
		const id = requestDetail.id;
		const generation = detailGenerationRef.current;
		let closed = false;
		let fetching = false;
		const timer = window.setInterval(async () => {
			if (fetching) return;
			fetching = true;
			try {
				const result = await api<{ request: AgentLogRequest }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/requests/${encodeURIComponent(id)}`);
				if (!closed && generation === detailGenerationRef.current && result.ok) setRequestDetail(current => current?.id === id ? result.data.request : current);
			} finally { fetching = false; }
		}, 500);
		return () => { closed = true; window.clearInterval(timer); };
	}, [bot.id, requestDetail?.id, requestDetail?.state]);
	useEffect(() => {
		if (!sessionDetail || sessionDetail.outcome.kind !== "pending") return;
		const id = sessionDetail.id;
		const generation = detailGenerationRef.current;
		let closed = false;
		let fetching = false;
		const timer = window.setInterval(async () => {
			if (fetching) return;
			fetching = true;
			try {
				const result = await api<{ session: AgentLogCompactionSession }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/compaction-sessions/${encodeURIComponent(id)}`);
				if (!closed && generation === detailGenerationRef.current && result.ok) setSessionDetail(current => current?.id === id ? result.data.session : current);
			} finally { fetching = false; }
		}, 1000);
		return () => { closed = true; window.clearInterval(timer); };
	}, [bot.id, sessionDetail?.id, sessionDetail?.outcome.kind]);
	const sessionIds = loopEntries.flatMap(entry => entry.kind === "notice" && entry.notice.kind === "compaction_started" ? [entry.notice.sessionId] : []).join("\n");
	useEffect(() => {
		let closed = false;
		void Promise.all([...new Set(sessionIds.split("\n").filter(Boolean))].map(async id => {
			const result = await api<{ session: AgentLogCompactionSession }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/compaction-sessions/${encodeURIComponent(id)}`);
			return result.ok ? result.data.session : null;
		})).then(values => {
			if (!closed) setSessions(new Map(values.flatMap(session => session ? [[session.id, session] as const] : [])));
		});
		return () => { closed = true; };
	}, [bot.id, sessionIds, loopEntries.filter(entry => entry.kind === "notice" && entry.notice.kind === "compaction_started").map(entry => JSON.stringify(entry)).join("\n")]);
	const [loopMessages, setLoopMessages] = useState<BotLoopMessage[]>([]);
	const [loopMessagePage, setLoopMessagePage] = useState<BotLoopMessagePage | null>(null);
	const [openLoopMessageLogs, setOpenLoopMessageLogs] = useState<BotLoopMessageLogsResponse | null>(null);
	const [loopMessageLogLoadingSeq, setLoopMessageLogLoadingSeq] = useState<number | null>(null);
	const [loopMessageLogError, setLoopMessageLogError] = useState("");
	const [deletingLoopMessageSeq, setDeletingLoopMessageSeq] = useState<number | null>(null);
	const [tokenUsage, setTokenUsage] = useState<BotTokenUsageStats | null>(null);
	const [connected, setConnected] = useState(false);
	const [injection, setInjection] = useState("");
	const [message, setMessage] = useState("");
	const [togglingEnabled, setTogglingEnabled] = useState(false);
	const [clearConfirm, setClearConfirm] = useState(false);
	const [compactConfirm, setCompactConfirm] = useState(false);
	const logRef = useRef<HTMLDivElement | null>(null);
	const sessionAnchorRef = useRef<string | null>(null);
	const sourceMessageRef = useRef<HTMLDivElement | null>(null);
	const sourceMessageScrolledRef = useRef(false);
	const sourceMessageRetriedRef = useRef(false);
	const sourceLookupPendingRef = useRef(false);
	const sourceNavigationGenerationRef = useRef(0);
	const [sourceMessage, setSourceMessage] = useState<{ botId: string; seq: number; runId: string; requestSeq: number; generation: number } | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const latestPersistentEventSeqRef = useRef(0);
	const latestLoopMessageSeqRef = useRef(0);
	const currentLoopPageRef = useRef(1);
	const watchedMessageSeqRef = useRef<number | undefined>(undefined);
	const compactionSourcesRef = useRef(new Set<string>());
	const currentLoopSourceCompactionSeqRef = useRef<number | null>(null);
	const statusRequestGenerationRef = useRef(0);
	const eventsRequestGenerationRef = useRef(0);
	const messagesRequestGenerationRef = useRef(0);
	const streamRevisionRef = useRef(0);
	// Keep only the current snapshot. Reject old frames before they enter the refresh buffer.
	const streamSnapshotEntriesRef = useRef(new Map<string, RequestLogEntry>());
	const liveUpdatesRef = useRef(new Map<string, { revision: number; runId: string; attemptId?: number; deltas: Array<{ arrival: number; revision?: number; kind?: string; text?: string; part?: unknown }> }>());
	const endedRunsRef = useRef(new Set<string>());
	const usageRequestGenerationRef = useRef(0);
	const trailingRefreshTimerRef = useRef<number | undefined>(undefined);
	const reconnectAttemptRef = useRef(0);
	const runtimeEnabled = status?.enabled ?? bot.tickSettings.enabled;
	const currentLoopPage = loopMessagePage?.currentPage ?? 1;
	// The model this participant actually runs is resolved by the server from
	// its configuration, so the panel and the token-usage breakdown agree with
	// the runtime instead of with a stale stored settings cascade.
	const currentModel = useBotEffectiveModels([bot.id]).modelByBotId[bot.id] ?? "";

	useEffect(() => {
		let closed = false;
		let reconnectTimer: number | undefined;
		let heartbeatTimer: number | undefined;
		let socket: WebSocket | null = null;
		let lastMonitorMessageAt = Date.now();
		shouldStickToBottomRef.current = !new URLSearchParams(window.location.search).has("inference");
		closeDetails();
		setSourceMessage(null);
		sourceMessageScrolledRef.current = false;
		sourceMessageRetriedRef.current = false;
		latestPersistentEventSeqRef.current = 0;
		latestLoopMessageSeqRef.current = 0;
		currentLoopPageRef.current = 1;
		currentLoopSourceCompactionSeqRef.current = null;
		watchedMessageSeqRef.current = undefined;
		compactionSourcesRef.current.clear();
		statusRequestGenerationRef.current += 1;
		eventsRequestGenerationRef.current += 1;
		messagesRequestGenerationRef.current += 1;
		usageRequestGenerationRef.current += 1;
		reconnectAttemptRef.current = 0;
		streamRevisionRef.current = 0;
		liveUpdatesRef.current.clear();
		endedRunsRef.current.clear();
		setStatus(null);
		setEvents([]);
		setLoopMessages([]);
		streamSnapshotEntriesRef.current.clear();
		setLoopEntries([]);
		setRequestDetail(null);
		setSessionDetail(null);
		setLoopMessagePage(null);
		setOpenLoopMessageLogs(null);
		setLoopMessageLogLoadingSeq(null);
		setLoopMessageLogError("");
		setDeletingLoopMessageSeq(null);
		setTokenUsage(null);
		setConnected(false);
		void refresh();

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const monitorUrl = `${protocol}//${window.location.host}/api/me/bots/${encodeURIComponent(bot.id)}/runtime/monitor`;

		function clearReconnectTimer(): void {
			if (reconnectTimer !== undefined) {
				window.clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
		}

		function clearHeartbeatTimer(): void {
			if (heartbeatTimer !== undefined) {
				window.clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
			}
		}

		function scheduleReconnect(): void {
			if (closed || reconnectTimer !== undefined) {
				return;
			}
			const delay = reconnectDelayMs(reconnectAttemptRef.current);
			reconnectAttemptRef.current += 1;
			reconnectTimer = window.setTimeout(() => {
				reconnectTimer = undefined;
				connectMonitor();
			}, delay);
		}

		function handleMonitorPayload(payload: RuntimeMonitorPayload): void {
			if (payload.type === "history_cleared") {
				liveUpdatesRef.current.clear();
				invalidateRefreshes({ events: true, messages: true });
				setEvents([]);
				setLoopMessages([]);
				streamSnapshotEntriesRef.current.clear();
				setLoopEntries([]);
				setLoopMessagePage(null);
				setOpenLoopMessageLogs(null);
				setDeletingLoopMessageSeq(null);
				latestPersistentEventSeqRef.current = 0;
				latestLoopMessageSeqRef.current = 0;
				currentLoopPageRef.current = 1;
				currentLoopSourceCompactionSeqRef.current = null;
				setMessage("Loop history erased.");
				scheduleTrailingRefresh({ page: 1 });
				return;
			}
			if (payload.type === "loop_messages_reset") {
				invalidateRefreshes({ messages: true });
				setOpenLoopMessageLogs(null);
				setDeletingLoopMessageSeq(null);
				latestLoopMessageSeqRef.current = 0;
				// A compaction renumbers nested pages. Preserve the generation anchor
				// and resolve its new page from the authoritative page-1 index.
				scheduleTrailingRefresh();
				return;
			}
			if (payload.type === "pong") {
				return;
			}
			if (payload.type === "event_deleted" && Number.isInteger(payload.seq)) {
				invalidateRefreshes({ events: true });
				setEvents((current) => current.filter((item) => item.seq !== payload.seq));
				scheduleTrailingRefresh();
				return;
			}
			if (payload.type === "loop_message_deleted" && Number.isInteger(payload.seq)) {
				invalidateRefreshes({ messages: true });
				setLoopMessages((current) => current.filter((item) => item.seq !== payload.seq));
				setLoopEntries(current => current.filter(entry => entry.kind !== 'message' || entry.message.seq !== payload.seq));
				setOpenLoopMessageLogs((current) => current && current.message.seq === payload.seq ? null : current);
				setDeletingLoopMessageSeq((current) => current === payload.seq ? null : current);
				scheduleTrailingRefresh();
				return;
			}
			if (payload.type === "loop_message" && payload.loopMessage) {
				if (currentLoopPageRef.current !== 1) {
					return;
				}
				rememberLoopMessageSeq(payload.loopMessage);
				setLoopMessages((current) => upsertLoopMessage(removeLiveProviderLoopMessagesForFinalizedMessage(current, payload.loopMessage!), payload.loopMessage!));
				void refreshTokenUsage();
				scheduleTrailingRefresh();
				return;
			}
			if (payload.type === "stream_delta" && payload.event) {
				if (currentLoopPageRef.current !== 1) {
					return;
				}
				if (endedRunsRef.current.has(payload.event.runId)) return;
				const delta = payload.event.payload as { requestId?: string; kind?: string; text?: string; deltaRevision?: number; attemptId?: number; part?: unknown };
				if (delta.requestId) {
					if (ignoresStreamDelta(streamSnapshotEntriesRef.current.get(delta.requestId), delta)) return;
					const arrival = ++streamRevisionRef.current;
					const currentUpdate = liveUpdatesRef.current.get(delta.requestId);
					if (currentUpdate?.attemptId !== undefined && delta.attemptId !== undefined && delta.attemptId < currentUpdate.attemptId) return;
					const previousRevision = currentUpdate?.deltas.at(-1)?.revision;
					if (currentUpdate?.attemptId === delta.attemptId && previousRevision !== undefined && delta.deltaRevision !== undefined && delta.deltaRevision <= previousRevision) return;
					const previous = currentUpdate?.attemptId !== undefined && delta.attemptId !== undefined && currentUpdate.attemptId !== delta.attemptId ? undefined : currentUpdate;
					const update = previous ?? { revision: arrival, runId: payload.event.runId, attemptId: delta.attemptId, deltas: [] };
					update.revision = arrival;
					update.attemptId = delta.attemptId ?? update.attemptId;
					update.deltas.push({ arrival, revision: delta.deltaRevision, kind: delta.kind, text: delta.text, part: delta.part });
					liveUpdatesRef.current.set(delta.requestId, update);
					setLoopEntries(current => {
						const existing = current.find((entry): entry is RequestLogEntry => (entry.kind === 'live' || entry.kind === 'message') && entry.requestId === delta.requestId);
						if (ignoresStreamDelta(existing, delta)) return current;
						const old = existing?.kind === 'live' && (existing.attemptId === undefined || delta.attemptId === undefined || existing.attemptId === delta.attemptId) ? existing : undefined;
						const partial = old?.kind === 'live' && old.partialResponse ? JSON.parse(old.partialResponse) as { content: string; reasoning: string; toolCalls?: unknown[] } : { content: '', reasoning: '', toolCalls: [] };
						if (delta.kind === 'content') partial.content += delta.text ?? '';
						if (delta.kind === 'reasoning') partial.reasoning += delta.text ?? '';
						if (delta.kind === 'tool_call') (partial.toolCalls ??= []).push(delta.part);
						const live: AgentLogEntry = { kind: 'live', position: Number.MAX_SAFE_INTEGER, requestId: delta.requestId!, runId: payload.event!.runId, attempts: old?.kind === 'live' ? old.attempts : { count: 1, failures: [] }, partialResponse: JSON.stringify(partial), response: null, deltaRevision: delta.deltaRevision ?? old?.deltaRevision, attemptId: delta.attemptId ?? old?.attemptId };
						return [...current.filter(entry => entry.kind !== 'live' || entry.requestId !== delta.requestId), live];
					});
				}
				setLoopMessages((current) => upsertLiveProviderLoopMessage(current, payload.event!));
				return;
			}
			if (payload.event) {
				rememberPersistentEventSeq(payload.event);
				setEvents((current) => upsertEvent(current, payload.event!));
				const compactionMessage = runtimeCompactionMessage(payload.event);
				if (compactionMessage) {
					setMessage(compactionMessage);
				}
				const terminal = ["tick_completed", "tick_failed", "tick_stopped"].includes(payload.event.type);
				invalidateRefreshes({ events: true, messages: terminal });
				if (terminal) {
					rememberEndedRun(payload.event.runId);
					setLoopEntries(current => current.filter(entry => entry.kind !== 'live' || entry.runId !== payload.event!.runId));
					if (currentLoopPageRef.current === 1) {
						setLoopMessages((current) => removeLiveProviderLoopMessagesForRun(current, payload.event!.runId));
					}
				}
				// Persistent socket events are only an immediate view. Invalidating any
				// in-flight older snapshot and scheduling one bounded replacement keeps
				// reconnect cursors from advancing past an event the snapshot then drops.
				scheduleTrailingRefresh();
			}
			if (payload.message) {
				setMessage(payload.message);
			}
		}

		function connectMonitor(): void {
			if (closed) {
				return;
			}
			clearReconnectTimer();
			clearHeartbeatTimer();
			if (socket && socket.readyState !== WebSocket.CLOSED) {
				const previousSocket = socket;
				socket = null;
				previousSocket.close();
			}
			const params = new URLSearchParams();
			if (latestPersistentEventSeqRef.current > 0) {
				params.set("afterEvent", String(latestPersistentEventSeqRef.current));
			}
			if (latestLoopMessageSeqRef.current > 0) {
				params.set("afterMessage", String(latestLoopMessageSeqRef.current));
			}
			const query = params.toString();
			const currentSocket = new WebSocket(query ? `${monitorUrl}?${query}` : monitorUrl);
			socket = currentSocket;
			currentSocket.onopen = () => {
				if (closed || socket !== currentSocket) {
					return;
				}
				reconnectAttemptRef.current = 0;
				lastMonitorMessageAt = Date.now();
				setConnected(true);
				void refreshAuthoritativeCurrentPage();
				heartbeatTimer = window.setInterval(() => {
					if (socket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
						clearHeartbeatTimer();
						return;
					}
					if (Date.now() - lastMonitorMessageAt > 45_000) {
						currentSocket.close();
						return;
					}
					currentSocket.send(JSON.stringify({ type: "ping" }));
				}, 15_000);
			};
			currentSocket.onclose = () => {
				if (!closed && socket === currentSocket) {
					setConnected(false);
					clearHeartbeatTimer();
					void refreshAuthoritativeCurrentPage();
					scheduleReconnect();
				}
			};
			currentSocket.onerror = () => {
				if (!closed && socket === currentSocket) {
					setConnected(false);
					currentSocket.close();
				}
			};
			currentSocket.onmessage = (event) => {
				if (closed || socket !== currentSocket) {
					return;
				}
				lastMonitorMessageAt = Date.now();
				try {
					handleMonitorPayload(JSON.parse(event.data) as RuntimeMonitorPayload);
				} catch (error) {
					setMessage(error instanceof Error ? error.message : "Failed to read the monitor update.");
				}
			};
		}

		connectMonitor();
		return () => {
			closed = true;
			clearReconnectTimer();
			clearHeartbeatTimer();
			if (trailingRefreshTimerRef.current !== undefined) {
				window.clearTimeout(trailingRefreshTimerRef.current);
				trailingRefreshTimerRef.current = undefined;
			}
			socket?.close();
		};
	}, [bot.id]);

	useEffect(() => {
		if (connected && status?.status !== "running") {
			return undefined;
		}
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible" && currentLoopPageRef.current === 1) {
				void refreshAuthoritativeCurrentPage();
			}
		}, status?.status === "running" ? 5_000 : 15_000);
		return () => window.clearInterval(interval);
	}, [bot.id, connected, status?.status]);

	useEffect(() => {
		if (!shouldStickToBottomRef.current) {
			return undefined;
		}
		const frame = scrollLogToBottom(logRef);
		return () => window.cancelAnimationFrame(frame);
	}, [loopMessages, loopEntries]);

	useEffect(() => {
		const id = sessionAnchorRef.current;
		if (!id || !logRef.current) return;
		const notice = document.getElementById(`loop-session-${id}`);
		if (!notice || !logRef.current.contains(notice)) return;
		sessionAnchorRef.current = null;
		shouldStickToBottomRef.current = false;
		notice.scrollIntoView({ block: "center" });
	}, [loopEntries, loopMessagePage]);

	useEffect(() => {
		if (!sourceMessage || sourceMessage.botId !== bot.id || sourceMessageScrolledRef.current || sourceLookupPendingRef.current || !loopMessagePage) {
			return;
		}
		if (!sourceMessageRef.current) {
			// Compaction can move the message after its lookup but before the page
			// arrives. Resolve once more rather than guessing from sequence ranges.
			if (!sourceMessageRetriedRef.current) {
				sourceMessageRetriedRef.current = true;
				void navigateToSourceInference(sourceMessage.requestSeq, sourceMessage.runId, sourceMessage.generation);
			} else {
				setLoopMessageLogError("The source inference is no longer available on its loop page.");
				setSourceMessage(null);
			}
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			const row = sourceMessageRef.current;
			if (!row) return;
			shouldStickToBottomRef.current = false;
			row.scrollIntoView({ block: "center" });
			sourceMessageScrolledRef.current = true;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [bot.id, sourceMessage, loopMessages, loopMessagePage]);

	useEffect(() => {
		const log = logRef.current;
		if (!log || typeof ResizeObserver === "undefined") {
			return undefined;
		}
		const observer = new ResizeObserver(() => {
			if (shouldStickToBottomRef.current) {
				scrollLogToBottom(logRef);
			}
		});
		observer.observe(log);
		Array.from(log.children).forEach((child) => observer.observe(child));
		return () => observer.disconnect();
	}, [loopMessages, loopEntries]);

	useEffect(() => {
		latestPersistentEventSeqRef.current = latestPersistentEventSeq(events);
	}, [events]);

	useEffect(() => {
		if ((loopMessagePage?.currentPage ?? 1) === 1) {
			latestLoopMessageSeqRef.current = latestLoopMessageSeq(loopMessages);
		}
	}, [loopMessagePage?.currentPage, loopMessages]);

	function trackLogScroll(): void {
		if (sourceMessage) {
			shouldStickToBottomRef.current = false;
			return;
		}
		const log = logRef.current;
		if (!log) {
			shouldStickToBottomRef.current = true;
			return;
		}
		shouldStickToBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
	}

	function rememberEndedRun(runId: string): void {
		endedRunsRef.current.add(runId);
		// Only recent runs can still have delayed socket frames or snapshots.
		if (endedRunsRef.current.size > 1_000) endedRunsRef.current.delete(endedRunsRef.current.values().next().value!);
		for (const [id, update] of liveUpdatesRef.current) if (update.runId === runId) liveUpdatesRef.current.delete(id);
	}

	function invalidateRefreshes(parts: { events?: boolean; messages?: boolean }): void {
		if (parts.events) eventsRequestGenerationRef.current += 1;
		if (parts.messages) messagesRequestGenerationRef.current += 1;
	}

	function refreshAuthoritativeCurrentPage(): Promise<void> {
		const sourceCompactionSeq = currentLoopSourceCompactionSeqRef.current;
		return refresh({ sourceCompactionSeq, watchedMessageSeq: sourceCompactionSeq === null ? watchedMessageSeqRef.current : undefined });
	}

	function scheduleTrailingRefresh(options?: { page?: number }): void {
		if (trailingRefreshTimerRef.current !== undefined) {
			window.clearTimeout(trailingRefreshTimerRef.current);
		}
		trailingRefreshTimerRef.current = window.setTimeout(() => {
			trailingRefreshTimerRef.current = undefined;
			void (options?.page === undefined ? refreshAuthoritativeCurrentPage() : refresh({ page: options.page }));
		}, 100);
	}

	async function refresh(options: {
		page?: number;
		sourceCompactionSeq?: number | null;
		watchedMessageSeq?: number;
		expectedSourceCompactionSeq?: number | null;
		resolverAttempt?: number;
	} = {}): Promise<void> {
		const anchoredSource = options.sourceCompactionSeq;
		const requestedPage = anchoredSource !== undefined ? 1 : Math.max(1, Math.floor(options.page ?? currentLoopPageRef.current));
		const statusGeneration = ++statusRequestGenerationRef.current;
		const eventsGeneration = ++eventsRequestGenerationRef.current;
		const messagesGeneration = ++messagesRequestGenerationRef.current;
		const streamRevisionAtStart = streamRevisionRef.current;
		const usageGeneration = ++usageRequestGenerationRef.current;
		const messageQuery = new URLSearchParams();
		if (requestedPage > 1) {
			messageQuery.set("page", String(requestedPage));
		}
		const messagePath = `/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages${messageQuery.toString() ? `?${messageQuery.toString()}` : ""}`;
		const [statusResult, eventsResult, messagesResult, tokenUsageResult] = await Promise.all([
			api<{ status: BotRuntimeStatus }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/status`),
			api<{ events: BotRuntimeEvent[] }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/events`),
			api<BotLoopMessagesResponse>(messagePath),
			api<{ usage: BotTokenUsageStats }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/token-usage`),
		]);
		if (statusResult.ok && statusGeneration === statusRequestGenerationRef.current) {
			setStatus(statusResult.data.status);
		}
		if (eventsResult.ok && eventsGeneration === eventsRequestGenerationRef.current) {
			for (const event of eventsResult.data.events) {
				rememberPersistentEventSeq(event);
			}
			// This endpoint returns a complete retained snapshot. WebSocket events
			// remain additive, but a reconnect snapshot must remove rows whose delete
			// or history-clear notification was missed while disconnected.
			setEvents(eventsResult.data.events);
			for (const event of eventsResult.data.events) if (['tick_completed', 'tick_failed', 'tick_stopped'].includes(event.type)) rememberEndedRun(event.runId);
			setLoopEntries(current => current.filter(entry => entry.kind !== 'live' || !endedRunsRef.current.has(entry.runId)));
		}
		if (messagesResult.ok && messagesGeneration === messagesRequestGenerationRef.current) {
			const page = messagesResult.data.page;
			const returnedSource = page.pages.find((item) => item.page === page.currentPage)?.sourceCompactionSeq ?? null;
			if (options.expectedSourceCompactionSeq !== undefined && returnedSource !== options.expectedSourceCompactionSeq) {
				if ((options.resolverAttempt ?? 0) < 1) {
					void refresh({
						sourceCompactionSeq: options.expectedSourceCompactionSeq,
						resolverAttempt: (options.resolverAttempt ?? 0) + 1,
					});
				} else {
					// The page map changed twice without yielding the requested generation.
					// Clear the anchor and converge to page 1 instead of ping-ponging forever.
					currentLoopPageRef.current = 1;
					currentLoopSourceCompactionSeqRef.current = null;
					void refresh({ page: 1 });
				}
				return;
			}
			const hasNewArchive = Object.keys(page.compactionPageBySeq).some(seq => !compactionSourcesRef.current.has(seq));
			if (anchoredSource === null && options.watchedMessageSeq !== undefined && hasNewArchive && !messagesResult.data.messages.some(message => message.seq === options.watchedMessageSeq)) {
				// Active context has no stable page source. Follow a retained row when compaction moves it.
				const retained = await api<BotLoopMessageLogsResponse>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages/${options.watchedMessageSeq}/logs`);
				if (messagesGeneration !== messagesRequestGenerationRef.current) return;
				const compactedBy = retained.ok ? retained.data.message.compactedBy : undefined;
				const archivePage = compactedBy === undefined ? undefined : page.compactionPageBySeq[String(compactedBy)];
				if (compactedBy !== undefined && archivePage === undefined && (options.resolverAttempt ?? 0) < 1) {
					void refresh({ sourceCompactionSeq: null, watchedMessageSeq: options.watchedMessageSeq, resolverAttempt: 1 });
					return;
				}
				if (archivePage !== undefined) {
					void refresh({ page: archivePage, expectedSourceCompactionSeq: compactedBy });
					return;
				}
			}
			if (anchoredSource !== undefined) {
				const anchoredPage = anchoredSource === null
					? page.pages.find(item => (item.sourceCompactionSeq ?? null) === null)?.page
					: page.compactionPageBySeq[String(anchoredSource)];
				if (anchoredPage && anchoredPage !== page.currentPage) {
					void refresh({ page: anchoredPage, expectedSourceCompactionSeq: anchoredSource, resolverAttempt: options.resolverAttempt ?? 0 });
					return;
				}
			}
			currentLoopPageRef.current = page.currentPage;
			currentLoopSourceCompactionSeqRef.current = returnedSource;
			watchedMessageSeqRef.current = messagesResult.data.messages.find(message => !isLiveProviderLoopMessage(message))?.seq;
			compactionSourcesRef.current = new Set(Object.keys(page.compactionPageBySeq));
			setLoopMessagePage(page);
			// The snapshot replaces older live entries. Only newer stream updates
			// can fill gaps or supersede a live value returned by this snapshot.
			for (const [id, update] of liveUpdatesRef.current) {
				if (update.revision <= streamRevisionAtStart) liveUpdatesRef.current.delete(id);
				else update.deltas = update.deltas.filter(delta => delta.arrival > streamRevisionAtStart);
			}
			streamSnapshotEntriesRef.current = new Map(messagesResult.data.entries.flatMap(entry => (entry.kind === 'live' || entry.kind === 'message') && entry.requestId ? [[entry.requestId, entry] as const] : []));
			const retainedUpdates = new Map([...liveUpdatesRef.current].map(([id, update]) => [id, { ...update, deltas: [...update.deltas] }]));
			const endedRuns = new Set(endedRunsRef.current);
			setLoopEntries(current => {
				const entries = messagesResult.data.entries.filter(entry => entry.kind !== 'live' || !endedRuns.has(entry.runId));
				if (page.currentPage !== 1) return entries;
				const newer = current.filter((entry): entry is Extract<AgentLogEntry, { kind: 'live' }> => entry.kind === 'live' && !endedRuns.has(entry.runId) && (retainedUpdates.get(entry.requestId)?.revision ?? 0) > streamRevisionAtStart);
				const ids = new Set(entries.flatMap(entry => entry.kind === 'message' || entry.kind === 'live' ? entry.requestId ? [entry.requestId] : [] : entry.kind === 'notice' && entry.notice.kind === 'request_failed' ? [entry.notice.requestId] : []));
				const mergeLive = (entry: Extract<AgentLogEntry, { kind: 'live' }>, base?: Extract<AgentLogEntry, { kind: 'live' }>): AgentLogEntry => {
					const attemptId = retainedUpdates.get(entry.requestId)?.attemptId;
					if (base?.attemptId !== undefined && attemptId !== undefined && attemptId < base.attemptId) return base;
					const reset = attemptId !== undefined && base?.attemptId !== undefined && attemptId > base.attemptId;
					if (base?.response && !reset) return base;
					const partial = !reset && base?.partialResponse ? JSON.parse(base.partialResponse) as { content: string; reasoning: string; toolCalls?: unknown[] } : { content: '', reasoning: '', toolCalls: [] };
					const deltas = retainedUpdates.get(entry.requestId)?.deltas ?? [];
					let deltaRevision = reset ? 0 : base?.deltaRevision ?? 0;
					for (const delta of deltas) {
						if (delta.arrival <= streamRevisionAtStart || (delta.revision !== undefined && delta.revision <= deltaRevision)) continue;
						if (delta.kind === 'content') partial.content += delta.text ?? '';
						if (delta.kind === 'reasoning') partial.reasoning += delta.text ?? '';
						if (delta.kind === 'tool_call') (partial.toolCalls ??= []).push(delta.part);
						deltaRevision = delta.revision ?? deltaRevision;
					}
					return { ...(base ?? entry), partialResponse: JSON.stringify(partial), response: reset ? null : base?.response ?? entry.response, deltaRevision, attemptId: attemptId ?? base?.attemptId };
				};
				return [...entries.map(entry => {
					if (entry.kind !== 'live') return entry;
					const update = newer.find(item => item.requestId === entry.requestId);
					return update ? mergeLive(update, entry) : entry;
				}), ...newer.filter(entry => !ids.has(entry.requestId)).map(entry => mergeLive(entry))];
			});
			if (page.currentPage === 1) {
				for (const loopMessage of messagesResult.data.messages) {
					rememberLoopMessageSeq(loopMessage);
				}
				setLoopMessages((current) => mergeLoopMessages(current, messagesResult.data.messages));
			} else {
				setLoopMessages(messagesResult.data.messages);
			}
		}
		if (tokenUsageResult.ok && usageGeneration === usageRequestGenerationRef.current) {
			setTokenUsage(tokenUsageResult.data.usage);
		}
	}

	async function refreshTokenUsage(): Promise<void> {
		const generation = ++usageRequestGenerationRef.current;
		const result = await api<{ usage: BotTokenUsageStats }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/token-usage`);
		if (result.ok && generation === usageRequestGenerationRef.current) {
			setTokenUsage(result.data.usage);
		}
	}

	async function switchLoopPage(page: number): Promise<void> {
		const targetPage = Math.max(1, Math.floor(page));
		if (targetPage === currentLoopPageRef.current) {
			return;
		}
		sourceNavigationGenerationRef.current += 1;
		setSourceMessage(null);
		currentLoopPageRef.current = targetPage;
		// Background refreshes must follow the selection before its first response arrives.
		currentLoopSourceCompactionSeqRef.current = loopMessagePage?.pages.find(item => item.page === targetPage)?.sourceCompactionSeq ?? null;
		watchedMessageSeqRef.current = undefined;
		shouldStickToBottomRef.current = targetPage === 1;
		setLoopMessages([]);
		streamSnapshotEntriesRef.current.clear();
		setLoopEntries([]);
		setOpenLoopMessageLogs(null);
		setLoopMessageLogError("");
		setMessage(`Loading loop page ${targetPage}...`);
		await refresh({ page: targetPage, expectedSourceCompactionSeq: currentLoopSourceCompactionSeqRef.current });
		setMessage("");
	}

	async function runTick(): Promise<void> {
		if (!runtimeEnabled) {
			setMessage("This participant is paused. Unpause it before starting a loop run.");
			return;
		}
		sourceNavigationGenerationRef.current += 1;
		setSourceMessage(null);
		shouldStickToBottomRef.current = true;
		currentLoopPageRef.current = 1;
		setMessage("Starting tick...");
		const result = await api<{ run: { runId: string; status: string; error?: string } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/tick`,
			{ method: "POST", body: { background: true } },
		);
		setMessage(
			result.ok ?
				result.data.run.error ?
					`Tick ${result.data.run.status}: ${result.data.run.error}`
				:	`Tick ${result.data.run.status}.`
			:	result.message,
		);
		await refresh({ page: 1 });
		window.setTimeout(() => void refresh({ page: 1 }), 750);
	}

	function rememberPersistentEventSeq(event: BotRuntimeEvent): void {
		if (Number.isInteger(event.seq)) {
			latestPersistentEventSeqRef.current = Math.max(latestPersistentEventSeqRef.current, event.seq);
		}
	}

	function rememberLoopMessageSeq(loopMessage: BotLoopMessage): void {
		if (Number.isInteger(loopMessage.seq) && !isLiveProviderLoopMessage(loopMessage)) {
			latestLoopMessageSeqRef.current = Math.max(latestLoopMessageSeqRef.current, loopMessage.seq);
		}
	}

	async function setLoopEnabled(enabled: boolean): Promise<void> {
		setTogglingEnabled(true);
		setMessage(enabled ? "Unpausing loop..." : "Pausing loop...");
		const saved = await onSave(bot.id, { tickSettings: { enabled } });
		setTogglingEnabled(false);
		if (!saved) {
			setMessage("Failed to update the loop state.");
			await refreshAuthoritativeCurrentPage();
			return;
		}
		setMessage(
			enabled ?
				"Loop unpaused. If nothing is scheduled yet, the next tick will be scheduled ASAP."
			:	"Loop paused. New loop runs are blocked until it is unpaused.",
		);
		await refreshAuthoritativeCurrentPage();
	}

	async function stopTick(): Promise<void> {
		setMessage("Stopping current visit...");
		const result = await api<{ stop: BotRuntimeStopResult }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/stop`,
			{ method: "POST" },
		);
		if (!result.ok) {
			setMessage(result.message);
		} else {
			switch (result.data.stop.kind) {
				case "stop_requested":
					setMessage("Stopping the current visit. Future scheduled visits are still enabled.");
					break;
				case "stopped":
					setMessage("The current visit stopped. Future scheduled visits are still enabled.");
					break;
				case "not_running":
					setMessage("No current visit is running.");
					break;
			}
		}
		await refreshAuthoritativeCurrentPage();
	}

	async function inject(): Promise<void> {
		const text = injection.trim();
		if (!text) {
			return;
		}
		setInjection("");
		const result = await api(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/inject`, {
			method: "POST",
			body: { text },
		});
		setMessage(result.ok ? "Thought injected." : result.message);
	}

	useEffect(() => {
		const query = new URLSearchParams(window.location.search);
		const requestSeq = Number(query.get("inference"));
		if (!Number.isSafeInteger(requestSeq) || requestSeq < 1) return;
		const generation = ++sourceNavigationGenerationRef.current;
		if (query.get("sourceBot") !== bot.id) {
			setLoopMessageLogError("This profile no longer identifies the author of that inference.");
			return;
		}
		void navigateToSourceInference(requestSeq, query.get("runId") ?? "", generation);
		return () => {
			if (generation === sourceNavigationGenerationRef.current) sourceNavigationGenerationRef.current += 1;
		};
	}, [bot.id]);

	async function navigateToSourceInference(requestSeq: number, runId: string, generation: number): Promise<void> {
		sourceLookupPendingRef.current = true;
		const result = await api<BotLoopMessageLogsResponse>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/inference-logs?requestSeq=${requestSeq}&runId=${encodeURIComponent(runId)}`);
		if (generation !== sourceNavigationGenerationRef.current) return;
		sourceLookupPendingRef.current = false;
		if (!result.ok) {
			setLoopMessageLogError(result.message);
			setSourceMessage(null);
			return;
		}
		const target = result.data.message;
		shouldStickToBottomRef.current = false;
		sourceMessageScrolledRef.current = false;
		setSourceMessage({ botId: bot.id, seq: target.seq, runId: target.runId, requestSeq, generation });
		setLoopMessagePage(null);
		setLoopMessages([]);
		streamSnapshotEntriesRef.current.clear();
		setLoopEntries([]);
		// Page numbers change after compaction. Resolve the source generation
		// through the same authoritative page map used for history navigation.
		currentLoopSourceCompactionSeqRef.current = target.compactedBy ?? null;
		void refresh({ sourceCompactionSeq: target.compactedBy ?? null });
	}

	function closeDetails(): void {
		detailGenerationRef.current += 1;
		setRequestDetail(null);
		setSessionDetail(null);
		setOpenLoopMessageLogs(null);
		setLoopMessageLogLoadingSeq(null);
	}

	async function viewLoopMessageLogs(loopMessage: BotLoopMessage): Promise<void> {
		if (isLiveProviderLoopMessage(loopMessage)) {
			return;
		}
		closeDetails();
		const generation = detailGenerationRef.current;
		setLoopMessageLogLoadingSeq(loopMessage.seq);
		setLoopMessageLogError("");
		const result = await api<BotLoopMessageLogsResponse>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages/${encodeURIComponent(String(loopMessage.seq))}/logs`,
		);
		if (generation !== detailGenerationRef.current) return;
		setLoopMessageLogLoadingSeq(null);
		if (result.ok) {
			setOpenLoopMessageLogs(result.data);
			return;
		}
		setLoopMessageLogError(result.message);
	}

	async function viewRequest(id: string, errors = false): Promise<void> {
		closeDetails();
		const generation = detailGenerationRef.current;
		setRequestErrors(errors);
		const result = await api<{ request: AgentLogRequest }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/requests/${encodeURIComponent(id)}`);
		if (generation !== detailGenerationRef.current) return;
		if (result.ok) setRequestDetail(result.data.request);
		else setLoopMessageLogError(result.message);
	}

	async function viewSession(id: string): Promise<void> {
		closeDetails();
		const generation = detailGenerationRef.current;
		const result = await api<{ session: AgentLogCompactionSession }>(`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/compaction-sessions/${encodeURIComponent(id)}`);
		if (generation !== detailGenerationRef.current) return;
		if (result.ok) setSessionDetail(result.data.session);
		else setLoopMessageLogError(result.message);
	}

	async function deleteLoopMessage(loopMessage: BotLoopMessage): Promise<void> {
		if (isLiveProviderLoopMessage(loopMessage)) {
			return;
		}
		if (!window.confirm(currentLoopPageRef.current === 1 ? "Delete this message from the model context?" : "Delete this message from the archive?")) return;
		setDeletingLoopMessageSeq(loopMessage.seq);
		const result = await api<{ deleted: { seq: number; runId: string; origin: BotLoopMessage["origin"]; deletedAt: string } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages/${encodeURIComponent(String(loopMessage.seq))}`,
			{ method: "DELETE" },
		);
		setDeletingLoopMessageSeq(null);
		if (result.ok) {
			invalidateRefreshes({ messages: true });
			setLoopMessages((current) => current.filter((item) => item.seq !== loopMessage.seq));
			setLoopEntries(current => current.filter(entry => entry.kind !== 'message' || entry.message.seq !== loopMessage.seq));
			setOpenLoopMessageLogs((current) => current && current.message.seq === loopMessage.seq ? null : current);
			setMessage("Loop message deleted.");
			scheduleTrailingRefresh();
			return;
		}
		setMessage(result.message);
	}

	async function compactLoopHistory(): Promise<void> {
		setMessage("Compacting loop chat...");
		const result = await api<{ compacted: { messageCount: number; fromSeq?: number; toSeq?: number } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/compact`,
			{ method: "POST" },
		);
		setCompactConfirm(false);
		if (result.ok) {
			invalidateRefreshes({ messages: true });
			const count = result.data.compacted.messageCount;
			setMessage(count > 0 ? `Compacted ${count} loop chat message${count === 1 ? "" : "s"}.` : "There were no loop chat messages to compact.");
			await refreshAuthoritativeCurrentPage();
			return;
		}
		setMessage(result.message);
	}

	async function clearHistory(): Promise<void> {
		setMessage("Resetting loop history...");
		const result = await api<{ cleared: { events: number; injections: number; runtimeState: number; submissions?: number; messages?: number; logs?: number } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/events`,
			{ method: "DELETE" },
		);
		if (result.ok) {
			invalidateRefreshes({ events: true, messages: true });
			setEvents([]);
			setLoopMessages([]);
			streamSnapshotEntriesRef.current.clear();
			setLoopEntries([]);
			setLoopMessagePage(null);
			setOpenLoopMessageLogs(null);
			setDeletingLoopMessageSeq(null);
			latestPersistentEventSeqRef.current = 0;
			latestLoopMessageSeqRef.current = 0;
			currentLoopPageRef.current = 1;
			currentLoopSourceCompactionSeqRef.current = null;
			setMessage(`Reset ${result.data.cleared.messages ?? 0} loop chat messages and ${result.data.cleared.events} legacy events.`);
			scheduleTrailingRefresh({ page: 1 });
		} else {
			setMessage(result.message);
		}
	}


	return (
		<>
			<div className="runtime-card live-runtime loop-runtime">
				<label className="switch-row runtime-switch">
					<input
						checked={runtimeEnabled}
						disabled={busy || togglingEnabled}
						onChange={(event) => void setLoopEnabled(event.target.checked)}
						type="checkbox"
					/>
					<span className="switch-control" />
					<span className="switch-copy">
						<span className="switch-title">Autonomous loop</span>
						<span className="switch-desc">
							{runtimeEnabled ?
								"Active; future scheduled, manual, and spotlight-started visits can run. Stop separately to end a current visit."
							:	"Paused. Future visits are blocked, but a current visit continues until it finishes or is stopped."}
						</span>
					</span>
				</label>
				<RuntimeRow description="How often this bot wakes up to act." label="Tick interval" value={formatTickIntervalMinutes(bot.tickSettings.intervalSeconds)} />
				<RuntimeRow label="Context budget" value={`${bot.effectiveTickSettings.contextWindowTokens} tokens`} />
				<RuntimeRow
					label="Status"
					value={status?.stopState === "stopping" ? "stopping current visit" : status?.stopState === "recovery_pending" ? "stop recovery pending" : status?.status ?? "unknown"}
				/>
				<RuntimeRow label="Next tick" value={<NextDueAtLabel enabled={runtimeEnabled} loaded={Boolean(status)} value={status?.nextDueAt} />} />
				<TokenUsagePanel currentModel={currentModel} usage={tokenUsage} />
				<ContextWindowBar breakdown={tokenUsage?.contextWindow} loading={!tokenUsage} />
				<div className="runtime-actions">
					<button
						className="btn primary"
						disabled={busy || !runtimeEnabled || status?.status === "running"}
						onClick={() => void runTick()}
						title={runtimeEnabled ? "Run tick now" : "Unpause before starting a loop run."}
						type="button"
					>
						Run tick now
					</button>
					<button
						className="btn danger"
						disabled={status?.status !== "running" || Boolean(status.stopState)}
						onClick={() => void stopTick()}
						title="Stop only the current visit. This does not pause future scheduled visits."
						type="button"
					>
						Stop current visit
					</button>
					<button className="btn ghost" onClick={() => void refreshAuthoritativeCurrentPage()} type="button">
						Refresh log
					</button>
					<button
						className="btn danger"
						disabled={status?.status === "running"}
						onClick={() => setClearConfirm(true)}
						type="button"
					>
						Reset loop
					</button>
					<button
						className="btn danger"
						disabled={currentLoopPage !== 1 || status?.status === "running" || !loopMessages.some((item) => !isLiveProviderLoopMessage(item))}
						onClick={() => setCompactConfirm(true)}
						title={currentLoopPage === 1 ? "Compact chat" : "Switch to page 1 before compacting active chat"}
						type="button"
					>
						Compact chat
					</button>
					<span className={`live-dot ${connected ? "on" : ""}`}>{connected ? "live" : "polling"}</span>
				</div>
				<form
					className="inline-form"
					onSubmit={(event) => {
						event.preventDefault();
						void inject();
					}}
				>
					<input
						className="input"
						onChange={(event) => setInjection(event.target.value)}
						aria-label="Inject a thought or focus"
						placeholder="Inject a thought or focus"
						value={injection}
					/>
					<button className="btn" disabled={!injection.trim()} type="submit">
						Inject
					</button>
				</form>
				{message && <div className="runtime-message">{message}</div>}
				{loopMessageLogError && <div className="runtime-message">{loopMessageLogError}</div>}
				<div className="event-log agent-log-scroll" onScroll={trackLogScroll} ref={logRef}>
					<AgentLogView entries={loopEntries} page={loopMessagePage} participantName={textValue(bot.displayName)}
						onDelete={message => void deleteLoopMessage(message)} onLogs={message => void viewLoopMessageLogs(message)}
						onRequest={(id, errors) => void viewRequest(id, errors)} onSession={id => void viewSession(id)} onPage={(page, sessionId) => { sessionAnchorRef.current = sessionId ?? null; void switchLoopPage(page); }}
						sessions={sessions} deletingSeq={deletingLoopMessageSeq} loadingSeq={loopMessageLogLoadingSeq}
						source={sourceMessage?.botId === bot.id ? sourceMessage : null} sourceRef={sourceMessageRef} />
				</div>
				<LoopMessagePager
					onPageSelect={(page) => void switchLoopPage(page)}
					page={loopMessagePage}
				/>
			</div>
			<AgentLogRequestModal request={requestDetail} errors={requestErrors} onClose={closeDetails} />
			<AgentLogSessionModal session={sessionDetail} onClose={closeDetails} />
			<LoopMessageLogsModal
				onClose={closeDetails}
				open={Boolean(openLoopMessageLogs)}
				payload={openLoopMessageLogs}
			/>
			<Confirm
				body="Erase this participant's visit chat, raw AI model logs, older runtime events, streamed text, summaries, and pending owner thoughts. Notes, forum threads, and comments remain."
				confirmText="Reset loop"
				danger
				onClose={() => setClearConfirm(false)}
				onConfirm={() => void clearHistory()}
				open={clearConfirm}
				title="Reset Loop History"
			/>
			<Confirm
				body="Replace the active visit chat with one summary. The AI model will use that summary instead of each message in the replaced part of the chat."
				confirmText="Compact chat"
				danger
				onClose={() => setCompactConfirm(false)}
				onConfirm={() => void compactLoopHistory()}
				open={compactConfirm}
				title="Compact Loop Chat"
			/>
		</>
	);
}
