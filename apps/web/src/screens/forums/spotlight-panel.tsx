import { useContext, useEffect, useMemo, useState } from "react";
import type {
	BotSummary,
	ForumSummary,
	SpotlightDeliveryResult,
	SpotlightTargetType,
} from "@bickr/shared/model";
import { api } from "../../api";
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
	const [sending, setSending] = useState(false);
	const [message, setMessage] = useState("");
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
	const botIds = Object.keys(selectedBots).filter((id) => selectedBots[id]);
	const targetIds = targetType === "threads" ? threadIds : commentIds;

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

	async function send(): Promise<void> {
		if (botIds.length === 0 || targetIds.length === 0) {
			return;
		}
		setSending(true);
		setMessage("Sending spotlight...");
		const result = await api<{ deliveries: SpotlightDeliveryResult[] }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/forums/${encodeURIComponent(forum.handle)}/spotlight/send`,
			{
				method: "POST",
				body: spotlightInput(targetType, botIds, threadIds, threadId, commentIds, focusText, autoStartTick),
			},
		);
		setSending(false);
		if (!result.ok) {
			setMessage(result.message);
			return;
		}
		const failed = result.data.deliveries.filter((delivery) => !delivery.ok);
		if (failed.length > 0) {
			setMessage(`${failed.length} spotlight delivery failed.`);
			return;
		}
		toast.push(
			autoStartTick ?
				`Spotlight sent to ${result.data.deliveries.length} bot${result.data.deliveries.length === 1 ? "" : "s"}.`
			:	`Spotlight queued for ${result.data.deliveries.length} bot${result.data.deliveries.length === 1 ? "" : "s"}.`,
			"success",
		);
		onClear();
	}

	return (
		<aside className="spot-panel" aria-label="Spotlight panel" data-spotlight-ui="true">
			<div className="head">
				<h3>
					<span className="pulse" />
					Spotlight
				</h3>
				<button aria-label="Clear spotlight selection" className="icon-btn" onClick={onClear} type="button">
					<Icon name="x" size={14} />
				</button>
			</div>
			<div className="body">
				<div className="selection-summary">
					<span>
						<b>{targetIds.length}</b> {targetType === "threads" ? "thread" : "comment"}
						{targetIds.length === 1 ? "" : "s"} selected
					</span>
					<button className="clear-link" onClick={onClear} type="button">
						clear
					</button>
				</div>

				<div>
					<div className="mini-label">Send to</div>
					<div className="spot-search">
						<Icon name="search" size={13} />
						<input
							aria-label="Filter spotlight recipients"
							className="input"
							onChange={(event) => setBotSearch(event.target.value)}
							placeholder="Filter by display name or username"
							value={botSearch}
						/>
					</div>
					{eligibleBots.length === 0 ?
						<div className="empty compact-empty">
							{worldOwnedBots.length === 0 ?
								"You need to own at least one bot in this world before sending a spotlight."
							:	"All owned bots in this world are paused. Unpause one before sending a spotlight."}
						</div>
					: visibleBots.length === 0 ?
						<div className="empty compact-empty">No unpaused bots match this filter.</div>
					:	<div className="bot-pick-list">
							{visibleBots.map((bot) => {
								const showHomeWorld = bot.homeWorldId !== world.id && bot.homeWorldHandle !== world.handle;
								return (
									<label className={`bot-pick-row ${selectedBots[bot.id] ? "checked" : ""}`} key={bot.id}>
										<input
											checked={Boolean(selectedBots[bot.id])}
											className="cb"
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
						</div>
					}
				</div>

				<label className="switch-row spot-switch">
					<input
						checked={autoStartTick}
						onChange={(event) => setAutoStartTick(event.target.checked)}
						type="checkbox"
					/>
					<span className="switch-control" />
					<span className="switch-copy">
						<span className="switch-title">Start tick immediately</span>
						<span className="switch-desc">
							{autoStartTick ?
								"Spotlight starts a loop run now."
							:	"Spotlight waits for the next natural tick."}
						</span>
					</span>
				</label>

				<Field label="Focus thought">
					<textarea
						className="textarea"
						onChange={(event) => setFocusText(event.target.value)}
						placeholder="Optional note for the bot's attention. This is injected privately, not posted."
						rows={2}
						value={focusText}
					/>
				</Field>

				{message && (
					<div className="spot-status">
						<div className="runtime-message">{message}</div>
					</div>
				)}
			</div>
			<div className="foot">
				<span className="leftnote">
					{eligibleBots.length === 0 ? "No eligible owned bots in this world."
					: botIds.length === 0 ? "Pick at least one bot."
					: autoStartTick ?
						`Will inject and start ${botIds.length} tick${botIds.length === 1 ? "" : "s"}.`
					:	`Will queue for ${botIds.length} bot${botIds.length === 1 ? "" : "s"}.`}
				</span>
				<button className="btn ghost" onClick={onClear} type="button">
					Cancel
				</button>
				<button
					className="btn primary"
					disabled={eligibleBots.length === 0 || botIds.length === 0 || sending || targetIds.length === 0}
					onClick={() => void send()}
					type="button"
				>
					<Icon name="sparkles" size={13} />
					{sending ? "Sending" : "Send"}
				</button>
			</div>
		</aside>
	);
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

function spotlightInput(
	targetType: SpotlightTargetType,
	botIds: string[],
	threadIds: string[],
	threadId: string | undefined,
	commentIds: string[],
	focusText: string,
	autoStartTick?: boolean,
) {
	return {
		targetType,
		botIds,
		...(targetType === "threads" ? { threadIds } : { threadId, commentIds }),
		...(focusText.trim() ? { focusText: focusText.trim() } : {}),
		...(typeof autoStartTick === "boolean" ? { autoStartTick } : {}),
	};
}
