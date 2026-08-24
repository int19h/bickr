import type {
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
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { NextDueAtLabel } from "../../components/record-display";
import { Reference, type WorldView } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import {
	isLiveProviderLoopMessage,
	removeLiveProviderLoopMessagesForFinalizedMessage,
	removeLiveProviderLoopMessagesForRun,
	upsertLiveProviderLoopMessage,
} from "../../loop-message-streams";
import { loopContinuationRowsForPage } from "../../loop-page-continuations";
import { Avatar, Confirm, Icon, textValue } from "../../ui";
import { useBotEffectiveModels } from "../../inference/bot-models";
import { loopToolCallsById } from "../../readable/loop-message-values";
import { LoopContinuationRow, LoopMessageLogsModal, LoopMessagePager, LoopMessageRow } from "./loop-messages";
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

export function BotLoopScreen({
	bot,
	busy,
	onSave,
	world,
}: {
	bot: BotSummary;
	busy: boolean;
	onSave: (botId: string, draft: UpdateBotInput) => Promise<boolean>;
	world: WorldView;
}) {
	return (
		<div className="main-inner loop-screen">
			<div className="thread-crumb">
				<SpaLink className="linklike" to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
					<Reference isBot kind="bot" link={false} name={bot.handle} />
				</SpaLink>
				<span>/</span>
				<span>loop</span>
			</div>
			<div className="page-header">
				<div className="page-title-block">
						<h1>
							<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} imageUrl={bot.avatarUrl} name={bot.displayName} size="lg" />
							<span>{textValue(bot.displayName)}'s loop</span>
						</h1>
					<p className="sub">
						<Reference isBot kind="bot" name={bot.handle} /> in{" "}
						<Reference kind="world" name={world.handle} />. Internal loop transcript and controls.
					</p>
				</div>
				<div className="actions">
					<SpaLink className="btn" to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
						Profile
					</SpaLink>
					<SpaLink className="btn" to={{ route: "bot-edit", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
						<Icon name="edit" size={14} />
						Edit
					</SpaLink>
				</div>
			</div>
			<BotRuntimePanel bot={bot} busy={busy} onSave={onSave} />
		</div>
	);
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
	const [status, setStatus] = useState<BotRuntimeStatus | null>(null);
	const [events, setEvents] = useState<BotRuntimeEvent[]>([]);
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
	const shouldStickToBottomRef = useRef(true);
	const latestPersistentEventSeqRef = useRef(0);
	const latestLoopMessageSeqRef = useRef(0);
	const currentLoopPageRef = useRef(1);
	const currentLoopSourceCompactionSeqRef = useRef<number | null>(null);
	const statusRequestGenerationRef = useRef(0);
	const eventsRequestGenerationRef = useRef(0);
	const messagesRequestGenerationRef = useRef(0);
	const usageRequestGenerationRef = useRef(0);
	const trailingRefreshTimerRef = useRef<number | undefined>(undefined);
	const reconnectAttemptRef = useRef(0);
	const runtimeEnabled = status?.enabled ?? bot.tickSettings.enabled;
	const toolCallsById = useMemo(() => loopToolCallsById(loopMessages), [loopMessages]);
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
		shouldStickToBottomRef.current = true;
		latestPersistentEventSeqRef.current = 0;
		latestLoopMessageSeqRef.current = 0;
		currentLoopPageRef.current = 1;
		currentLoopSourceCompactionSeqRef.current = null;
		statusRequestGenerationRef.current += 1;
		eventsRequestGenerationRef.current += 1;
		messagesRequestGenerationRef.current += 1;
		usageRequestGenerationRef.current += 1;
		reconnectAttemptRef.current = 0;
		setStatus(null);
		setEvents([]);
		setLoopMessages([]);
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
				invalidateRefreshes({ events: true, messages: true });
				setEvents([]);
				setLoopMessages([]);
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
				if (["tick_completed", "tick_failed", "tick_stopped"].includes(payload.event.type)) {
					invalidateRefreshes({ events: true, messages: true });
					if (currentLoopPageRef.current === 1) {
						setLoopMessages((current) => removeLiveProviderLoopMessagesForRun(current, payload.event!.runId));
					}
					scheduleTrailingRefresh();
				}
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
					setMessage(error instanceof Error ? error.message : "Could not read monitor update.");
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
				void refresh();
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
	}, [loopMessages]);

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
	}, [loopMessages]);

	useEffect(() => {
		latestPersistentEventSeqRef.current = latestPersistentEventSeq(events);
	}, [events]);

	useEffect(() => {
		if ((loopMessagePage?.currentPage ?? 1) === 1) {
			latestLoopMessageSeqRef.current = latestLoopMessageSeq(loopMessages);
		}
	}, [loopMessagePage?.currentPage, loopMessages]);

	function trackLogScroll(): void {
		const log = logRef.current;
		if (!log) {
			shouldStickToBottomRef.current = true;
			return;
		}
		shouldStickToBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
	}

	function invalidateRefreshes(parts: { events?: boolean; messages?: boolean }): void {
		if (parts.events) eventsRequestGenerationRef.current += 1;
		if (parts.messages) messagesRequestGenerationRef.current += 1;
	}

	function refreshAuthoritativeCurrentPage(): Promise<void> {
		const sourceCompactionSeq = currentLoopSourceCompactionSeqRef.current;
		return sourceCompactionSeq === null ?
			refresh({ page: currentLoopPageRef.current })
		: refresh({ sourceCompactionSeq });
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
		expectedSourceCompactionSeq?: number;
		resolverAttempt?: number;
	} = {}): Promise<void> {
		const anchoredSource = options.sourceCompactionSeq;
		const requestedPage = anchoredSource !== undefined ? 1 : Math.max(1, Math.floor(options.page ?? currentLoopPageRef.current));
		const statusGeneration = ++statusRequestGenerationRef.current;
		const eventsGeneration = ++eventsRequestGenerationRef.current;
		const messagesGeneration = ++messagesRequestGenerationRef.current;
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
			if (anchoredSource !== undefined && anchoredSource !== null) {
				const anchoredPage = page.compactionPageBySeq[String(anchoredSource)];
				if (anchoredPage && anchoredPage !== 1) {
					void refresh({
						page: anchoredPage,
						expectedSourceCompactionSeq: anchoredSource,
						resolverAttempt: options.resolverAttempt ?? 0,
					});
					return;
				}
			}
			currentLoopPageRef.current = page.currentPage;
			currentLoopSourceCompactionSeqRef.current = returnedSource;
			setLoopMessagePage(page);
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
		currentLoopPageRef.current = targetPage;
		shouldStickToBottomRef.current = targetPage === 1;
		setLoopMessages([]);
		setOpenLoopMessageLogs(null);
		setLoopMessageLogError("");
		setMessage(`Loading loop page ${targetPage}...`);
		await refresh({ page: targetPage });
		setMessage("");
	}

	async function runTick(): Promise<void> {
		if (!runtimeEnabled) {
			setMessage("This participant is paused. Unpause it before starting a loop run.");
			return;
		}
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
			setMessage("Could not update loop state.");
			await refresh();
			return;
		}
		setMessage(
			enabled ?
				"Loop unpaused. If nothing is scheduled yet, the next tick will be scheduled ASAP."
			:	"Loop paused. New loop runs are blocked until it is unpaused.",
		);
		await refresh();
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
		await refresh();
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

	async function viewLoopMessageLogs(loopMessage: BotLoopMessage): Promise<void> {
		if (isLiveProviderLoopMessage(loopMessage)) {
			return;
		}
		setLoopMessageLogLoadingSeq(loopMessage.seq);
		setLoopMessageLogError("");
		const result = await api<BotLoopMessageLogsResponse>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages/${encodeURIComponent(String(loopMessage.seq))}/logs`,
		);
		setLoopMessageLogLoadingSeq(null);
		if (result.ok) {
			setOpenLoopMessageLogs(result.data);
			return;
		}
		setLoopMessageLogError(result.message);
	}

	async function deleteLoopMessage(loopMessage: BotLoopMessage): Promise<void> {
		if (isLiveProviderLoopMessage(loopMessage)) {
			return;
		}
		setDeletingLoopMessageSeq(loopMessage.seq);
		const result = await api<{ deleted: { seq: number; runId: string; origin: BotLoopMessage["origin"]; deletedAt: string } }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/messages/${encodeURIComponent(String(loopMessage.seq))}`,
			{ method: "DELETE" },
		);
		setDeletingLoopMessageSeq(null);
		if (result.ok) {
			invalidateRefreshes({ messages: true });
			setLoopMessages((current) => current.filter((item) => item.seq !== loopMessage.seq));
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
			setLoopMessages([]);
			setLoopMessagePage(null);
			latestLoopMessageSeqRef.current = 0;
			currentLoopPageRef.current = 1;
			currentLoopSourceCompactionSeqRef.current = null;
			await refresh({ page: 1 });
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

	const continuationRows = loopContinuationRowsForPage(loopMessagePage);

	return (
		<>
			<div className="card runtime-card live-runtime">
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
					<button className="btn ghost" onClick={() => void refresh()} type="button">
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
						placeholder="Inject a thought or focus"
						value={injection}
					/>
					<button className="btn" disabled={!injection.trim()} type="submit">
						Inject
					</button>
				</form>
				{message && <div className="runtime-message">{message}</div>}
				{loopMessageLogError && <div className="runtime-message">{loopMessageLogError}</div>}
				<div className="event-log" onScroll={trackLogScroll} ref={logRef}>
					{continuationRows.filter((row) => row.position === "start").map((row) => (
						<LoopContinuationRow
							key={`${row.position}-${row.page}`}
							label={row.label}
							onPageSelect={(page) => void switchLoopPage(page)}
							page={row.page}
						/>
					))}
					{loopMessages.length === 0 && <div className="empty compact-empty">No loop chat messages yet.</div>}
					{loopMessages.map((loopMessage) => (
						<LoopMessageRow
							key={`${loopMessage.runId}-${loopMessage.seq}`}
							deleting={deletingLoopMessageSeq === loopMessage.seq}
							loadingLogs={loopMessageLogLoadingSeq === loopMessage.seq}
							message={loopMessage}
							onDelete={() => void deleteLoopMessage(loopMessage)}
							onViewLogs={() => void viewLoopMessageLogs(loopMessage)}
							toolCallsById={toolCallsById}
						/>
					))}
					{continuationRows.filter((row) => row.position === "end").map((row) => (
						<LoopContinuationRow
							key={`${row.position}-${row.page}`}
							label={row.label}
							onPageSelect={(page) => void switchLoopPage(page)}
							page={row.page}
						/>
					))}
				</div>
				<LoopMessagePager
					onPageSelect={(page) => void switchLoopPage(page)}
					page={loopMessagePage}
				/>
			</div>
			<LoopMessageLogsModal
				onClose={() => setOpenLoopMessageLogs(null)}
				open={Boolean(openLoopMessageLogs)}
				payload={openLoopMessageLogs}
			/>
			<Confirm
				body="Erase this participant's loop chat ledger, retained raw provider logs, legacy runtime events, streamed text, compaction summaries, and pending injected thoughts. Forum threads and comments will not be deleted."
				confirmText="Reset loop"
				danger
				onClose={() => setClearConfirm(false)}
				onConfirm={() => void clearHistory()}
				open={clearConfirm}
				title="Reset Loop History"
			/>
			<Confirm
				body="Replace the whole active loop chat with one summary message. This keeps the conversation usable after major changes, but the exact message-by-message history for the compacted span will no longer be replayed to the provider."
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
