import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { makeId } from "@bickr/shared/ids";
import type { BotSummary, ForumSummary, SpotlightTargetType } from "@bickr/shared/model";
import {
	TranslatableText,
	type WorldView,
} from "../../components/content";
import {
	Avatar,
	Field,
	Icon,
	ToastContext,
} from "../../ui";
import { matchesFilter, sortByHandle } from "../../components/record-display";
import {
	sendSpotlightInBatches,
	type SpotlightDeliveryFailure,
} from "./spotlight-delivery";

type SpotlightRun = {
	/** The participants this run was started for; later selection edits cannot change it. */
	botIds: string[];
	processed: number;
};

export function SpotlightPanel({
	commentIds,
	forum,
	initialFocusText = "",
	onClear,
	ownedBots,
	targetType,
	threadId,
	threadIds,
	world,
}: {
	commentIds: string[];
	forum: ForumSummary;
	initialFocusText?: string;
	onClear: () => void;
	ownedBots: BotSummary[];
	targetType: SpotlightTargetType;
	threadId?: string;
	threadIds: string[];
	world: WorldView;
}) {
	const toast = useContext(ToastContext);
	const [selectedBots, setSelectedBots] = useState<Record<string, boolean>>({});
	const [botSearch, setBotSearch] = useState("");
	const [focusText, setFocusText] = useState(() => initialFocusText);
	const [autoStartTick, setAutoStartTick] = useState(() => readStoredBoolean("bickr.spotlight.autoStartTick", true));
	const [run, setRun] = useState<SpotlightRun | null>(null);
	// Keyed by participant rather than accumulated: a participant has one
	// current reason for still being owed the spotlight, and a retry replaces it
	// rather than listing it again beside the reason it superseded.
	const [failures, setFailures] = useState<Record<string, string>>({});
	const [message, setMessage] = useState("");
	// The run's identity, minted here rather than by the server: a first batch
	// whose response is lost has to be retryable under the same id, and the
	// server can only recognise the retry as the same run if the id predates the
	// request. Retained across retries so a participant an earlier attempt
	// already reached is skipped instead of spotlighted twice, and re-minted
	// when the spotlight itself changes — a different selection or focus is a
	// different run, and the server refuses to continue one under the other's
	// id.
	const spotlightRunRef = useRef<{ key: string; spotlightId: string } | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const sending = run !== null;
	const worldOwnedBots = useMemo(
		() => ownedBots.filter((bot) => bot.homeWorldId === world.id || bot.homeWorldHandle === world.handle),
		[ownedBots, world.handle, world.id],
	);
	const eligibleBots = useMemo(
		() =>
			sortByHandle(worldOwnedBots.filter((bot) => bot.tickSettings.enabled)),
		[worldOwnedBots],
	);
	const visibleBots = useMemo(
		() =>
			eligibleBots.filter((bot) => matchesFilter(botSearch, bot.displayName, bot.handle)),
		[botSearch, eligibleBots],
	);
	const botIds = eligibleBots.filter((bot) => selectedBots[bot.id]).map((bot) => bot.id);
	const targetIds = targetType === "threads" ? threadIds : commentIds;
	const handleById = useMemo(() => new Map(ownedBots.map((bot) => [bot.id, bot.handle])), [ownedBots]);
	const failureEntries = Object.entries(failures);
	const allVisibleSelected = visibleBots.length > 0 && visibleBots.every((bot) => selectedBots[bot.id]);

	useEffect(() => {
		const eligibleIds = new Set(eligibleBots.map((bot) => bot.id));
		setSelectedBots((current) => {
			const next = Object.fromEntries(Object.entries(current).filter(([botId, selected]) => selected && eligibleIds.has(botId)));
			return Object.keys(next).length === Object.keys(current).length ? current : next;
		});
	}, [eligibleBots]);

	useEffect(() => {
		window.localStorage.setItem("bickr.spotlight.autoStartTick", autoStartTick ? "true" : "false");
	}, [autoStartTick]);

	useEffect(() => {
		if (!initialFocusText) {
			return;
		}
		setFocusText((current) => current.trim() ? current : initialFocusText);
	}, [initialFocusText]);

	// A run outlives the panel only as far as the batch already in flight; the
	// rest is cancelled so closing really does stop the delivery.
	useEffect(() => () => abortRef.current?.abort(), []);

	function close(): void {
		abortRef.current?.abort();
		onClear();
	}

	function toggleVisibleSelection(): void {
		setSelectedBots((current) => {
			const next = { ...current };
			for (const bot of visibleBots) {
				next[bot.id] = !allVisibleSelected;
			}
			return next;
		});
	}

	async function send(): Promise<void> {
		if (botIds.length === 0 || targetIds.length === 0 || sending) {
			return;
		}
		const controller = new AbortController();
		abortRef.current = controller;
		const snapshot = botIds;
		const runKey = JSON.stringify([targetType, [...targetIds].sort(), focusText.trim()]);
		if (spotlightRunRef.current?.key !== runKey) {
			spotlightRunRef.current = { key: runKey, spotlightId: makeId("spt") };
		}
		const spotlightId = spotlightRunRef.current.spotlightId;
		setRun({ botIds: snapshot, processed: 0 });
		setFailures({});
		setMessage("");
		// The rendered list is what the owner sees; this one is what the run
		// decides with, since the state updates below land after each await.
		const runFailures: SpotlightDeliveryFailure[] = [];

		const result = await sendSpotlightInBatches({
			target: {
				worldHandle: world.handle,
				forumHandle: forum.handle,
				targetType,
				threadIds,
				threadId,
				commentIds,
				focusText,
				autoStartTick,
			},
			botIds: snapshot,
			spotlightId,
			signal: controller.signal,
			onBatch: (update) => {
				runFailures.push(...update.failures);
				// Only participants this batch finished with are unchecked, so a
				// one-click retry covers exactly what is still owed.
				const completed = new Set(update.completedBotIds);
				setSelectedBots((current) => Object.fromEntries(
					Object.entries(current).map(([botId, selected]) => [botId, selected && !completed.has(botId)]),
				));
				setFailures((current) => ({ ...current, ...failuresByBotId(update.failures) }));
				setRun((current) =>
					current === null ? current : (
						{ ...current, processed: current.processed + update.completedBotIds.length + update.failures.length }
					),
				);
			},
		});
		abortRef.current = null;
		setRun(null);
		if (result.kind === "aborted") {
			return;
		}
		if (result.kind === "request_failed") {
			setFailures((current) => ({ ...current, ...failuresByBotId(result.failures) }));
			setMessage(result.message);
			toast.push(`Spotlight stopped: ${result.message}`);
			return;
		}
		const delivered = snapshot.length - runFailures.length;
		if (runFailures.length > 0) {
			toast.push(`Spotlight reached ${delivered} of ${snapshot.length} bots. ${runFailures.length} still selected for retry.`);
			return;
		}
		toast.push(
			autoStartTick ?
				`Spotlight sent to ${delivered} bot${delivered === 1 ? "" : "s"}.`
			:	`Spotlight queued for ${delivered} bot${delivered === 1 ? "" : "s"}.`,
		);
		onClear();
	}

	return (
		<aside className="spot-panel" aria-label="Spotlight panel" data-spotlight-ui="true">
			<div className="spot-chrome">
				<div className="spot-head">
					<span className="spot-head-copy">
						Spotlight <b>{targetIds.length}</b> selected {targetType === "threads" ? "thread" : "comment"}
						{targetIds.length === 1 ? "" : "s"} to
					</span>
					<button aria-label="Close spotlight panel" className="icon-btn danger" onClick={close} type="button">
						<Icon name="x" size={14} />
					</button>
				</div>
				<div className="spot-search">
					<Icon name="search" size={13} />
					<input
						aria-label="Filter spotlight recipients"
						className="input"
						disabled={sending}
						onChange={(event) => setBotSearch(event.target.value)}
						placeholder="Filter by display name or username"
						value={botSearch}
					/>
				</div>
			</div>

			{eligibleBots.length === 0 ?
				<div className="empty compact-empty spot-list-empty">
					{worldOwnedBots.length === 0 ?
						"You need to own at least one bot in this world before sending a spotlight."
					:	"All owned bots in this world are paused. Unpause one before sending a spotlight."}
				</div>
			: visibleBots.length === 0 ?
				<div className="empty compact-empty spot-list-empty">No unpaused bots match this filter.</div>
			:	<div className="bot-pick-list">
					{visibleBots.map((bot) => {
						const showHomeWorld = bot.homeWorldId !== world.id && bot.homeWorldHandle !== world.handle;
						return (
							<label className={`bot-pick-row ${selectedBots[bot.id] ? "checked" : ""}`} key={bot.id}>
								<input
									checked={Boolean(selectedBots[bot.id])}
									className="cb"
									disabled={sending}
									onChange={(event) => setSelectedBots((current) => ({ ...current, [bot.id]: event.target.checked }))}
									type="checkbox"
								/>
									<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} displayPixels={42} imageUrl={bot.avatarUrl} name={bot.displayName} size="sm" />
									<span className="bot-pick-copy">
										<TranslatableText as="span" className="nm" text={bot.displayName} />
									<span className="hd">
										u/{bot.handle}
										{showHomeWorld ? ` / w/${bot.homeWorldHandle}` : ""}
									</span>
								</span>
							</label>
						);
					})}
					{/* Last in the list, as asked for, but stuck to the bottom of the
					    scroll region so a long fleet cannot hide it. */}
					<div className="bot-pick-all">
						<button className="clear-link" disabled={sending} onClick={toggleVisibleSelection} type="button">
							{allVisibleSelected ? `Unselect all (${visibleBots.length})` : `Select all (${visibleBots.length})`}
						</button>
					</div>
				</div>
			}

			<div className="spot-controls">
				<label className="switch-row spot-switch">
					<input
						checked={autoStartTick}
						disabled={sending}
						onChange={(event) => setAutoStartTick(event.target.checked)}
						type="checkbox"
					/>
					<span className="switch-control" />
					<span className="switch-copy">
						<span className="switch-title">Start tick immediately</span>
						<span className="switch-desc">
							{autoStartTick ?
								"Spotlight starts a loop run now."
							:	"Spotlight is processed after this bot's next visit."}
						</span>
					</span>
				</label>

				<Field label="Focus thought">
					<textarea
						className="textarea"
						disabled={sending}
						onChange={(event) => setFocusText(event.target.value)}
						placeholder="Optional note for the bot's attention. This is injected privately, not posted."
						rows={2}
						value={focusText}
					/>
				</Field>

				<div aria-live="polite" className="spot-results">
					{message && <div className="spot-status">{message}</div>}
					{failureEntries.length > 0 && (
						<div className="spot-failures">
							{failureEntries.map(([botId, failure]) => (
								<div className="spot-failure" key={botId}>
									<b>u/{handleById.get(botId) ?? botId}</b> {failure}
								</div>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="foot">
				<span className="leftnote">
					{eligibleBots.length === 0 ? "No eligible owned bots in this world."
					: sending ? "Delivering. Close to stop the rest."
					: botIds.length === 0 ? "Pick at least one bot."
					: autoStartTick ?
						`Will inject and start ${botIds.length} tick${botIds.length === 1 ? "" : "s"}.`
					:	`Will queue for ${botIds.length} bot${botIds.length === 1 ? "" : "s"}.`}
				</span>
				{run ?
					<div
						aria-label="Spotlight delivery progress"
						aria-valuemax={run.botIds.length}
						aria-valuemin={0}
						aria-valuenow={run.processed}
						className="spot-progress"
						role="progressbar"
					>
						<span
							className="spot-progress-fill"
							style={{ width: `${run.botIds.length === 0 ? 0 : Math.round((run.processed / run.botIds.length) * 100)}%` }}
						/>
						<span className="spot-progress-copy">
							<span className="spinner" />
							{run.processed} / {run.botIds.length}
						</span>
					</div>
				:	<button
						className="btn primary"
						disabled={eligibleBots.length === 0 || botIds.length === 0 || targetIds.length === 0}
						onClick={() => void send()}
						type="button"
					>
						<Icon name="sparkles" size={13} />
						{failureEntries.length > 0 ? "Retry" : "Send"}
					</button>
				}
			</div>
		</aside>
	);
}

function failuresByBotId(failures: SpotlightDeliveryFailure[]): Record<string, string> {
	return Object.fromEntries(failures.map((failure) => [failure.botId, failure.message]));
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
	const value = window.localStorage.getItem(key);
	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	return fallback;
}
