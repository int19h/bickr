import type { BotInferenceSettings, BotSummary, BotTickSpreadResult, BotTokenSpendSummary } from "@bickr/shared/model";
import type { CSSProperties, ReactNode } from "react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { Reference, TranslatableText, type WorldView } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import {
	compareMyBotTableRecords,
	defaultMyBotsSortState,
	myBotsRunTickSelection,
	myBotsSortStorageKey,
	myBotsSpendTotal,
	modelColorHue,
	parseMyBotsSortState,
	type MyBotSpendLoadState,
	type MyBotsSortKey,
	type MyBotsSortState,
	type MyBotsSpendTotal,
} from "../../my-bots-table";
import { effectiveBotModel } from "../bots";
import { formatAverageDays, formatTokenCost, formatTokenCostParts } from "../bots/token-usage";
import { formatFullDate } from "../chrome";
import { BotProfileHoverLink } from "../search";
import { Avatar, Confirm, EmptyState, FilterBox, Icon, ToastContext, textValue } from "../../ui";
import { TimeAgoLabel, TimeUntilLabel, compareHandles, matchesFilter } from "../../App";

type MyBotsConfirmAction = "delete" | "spread" | "tick";

type MyBotTableRecord = {
	bot: BotSummary;
	effectiveModel: string;
	lastActiveSort: number | null;
	nextDueSort: number | null;
	spend?: MyBotSpendLoadState;
	world: WorldView | null;
};

export function MyBotsScreen({
	bots,
	onDeleteBots,
	onRunBotTicks,
	onSpreadBotTicks,
	ownerInferenceSettings,
	worlds,
}: {
	bots: BotSummary[];
	onDeleteBots: (bots: BotSummary[]) => Promise<{ deleted: BotSummary[]; failed: BotSummary[] }>;
	onRunBotTicks: (bots: BotSummary[]) => Promise<void>;
	onSpreadBotTicks: () => Promise<BotTickSpreadResult | null>;
	ownerInferenceSettings: BotInferenceSettings | null;
	worlds: WorldView[];
}) {
	const [botFilter, setBotFilter] = useState("");
	const [confirmAction, setConfirmAction] = useState<MyBotsConfirmAction | null>(null);
	const [selectedBotIds, setSelectedBotIds] = useState<Set<string>>(() => new Set());
	const [sort, setSort] = useState<MyBotsSortState>(() => readMyBotsSortState());
	const [spendByBotId, setSpendByBotId] = useState<Record<string, MyBotSpendLoadState>>({});
	const selectAllRef = useRef<HTMLInputElement>(null);
	const toast = useContext(ToastContext);
	const spendFetchKey = useMemo(() => bots.map((bot) => bot.id).sort(compareHandles).join("\u0000"), [bots]);

	const records = useMemo<MyBotTableRecord[]>(() => {
		const worldsByHandle = new Map(worlds.map((world) => [world.handle, world]));
		return bots.flatMap((bot) => {
			const world = worldsByHandle.get(bot.homeWorldHandle) ?? null;
			if (!matchesFilter(botFilter, bot.handle, bot.displayName, bot.shortBio, bot.homeWorldHandle, world?.name)) {
				return [];
			}
			return [{
				bot,
				effectiveModel: effectiveBotModel(bot, ownerInferenceSettings),
				lastActiveSort: timestampSortValue(bot.lastActiveAt ?? bot.createdAt),
				nextDueSort: bot.tickSettings.enabled ? timestampSortValue(bot.nextDueAt) : null,
				spend: spendByBotId[bot.id],
				world,
			}];
		});
	}, [botFilter, bots, ownerInferenceSettings, spendByBotId, worlds]);

	const groups = useMemo(() => {
		const grouped = new Map<string, { rows: MyBotTableRecord[]; world: WorldView | null; worldHandle: string }>();
		for (const record of records) {
			const worldHandle = record.bot.homeWorldHandle;
			const group = grouped.get(worldHandle) ?? { rows: [], world: record.world, worldHandle };
			group.rows.push(record);
			grouped.set(worldHandle, group);
		}

		return [...grouped.values()]
			.sort((left, right) => compareHandles(left.worldHandle, right.worldHandle))
			.map((group) => ({
				...group,
				rows: [...group.rows].sort((left, right) => compareMyBotTableRecords(left, right, sort)),
			}));
	}, [records, sort]);

	useEffect(() => {
		writeMyBotsSortState(sort);
	}, [sort]);

	useEffect(() => {
		const botIds = bots.map((bot) => bot.id);
		if (botIds.length === 0) {
			setSpendByBotId({});
			return;
		}
		setSpendByBotId((current) => {
			const next: Record<string, MyBotSpendLoadState> = {};
			for (const botId of botIds) {
				next[botId] = current[botId] ?? { status: "loading" };
			}
			return next;
		});
		let cancelled = false;
		void (async () => {
			const result = await api<{ spendByBotId: Record<string, BotTokenSpendSummary> }>("/api/me/bots/token-spend");
			if (cancelled) {
				return;
			}
			setSpendByBotId(() => {
				const next: Record<string, MyBotSpendLoadState> = {};
				for (const botId of botIds) {
					const summary = result.ok ? result.data.spendByBotId[botId] : undefined;
					next[botId] = result.ok && summary ?
						{ status: "loaded", summary }
					:	{ status: "error", message: result.ok ? "Token spend summary was missing." : result.message };
				}
				return next;
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [spendFetchKey]);

	const visibleBotIds = useMemo(
		() => groups.flatMap((group) => group.rows.map((row) => row.bot.id)),
		[groups],
	);
	const selectedRecords = useMemo(
		() => groups.flatMap((group) => group.rows).filter((row) => selectedBotIds.has(row.bot.id)),
		[groups, selectedBotIds],
	);
	const selectedBots = useMemo(
		() => selectedRecords.map((record) => record.bot),
		[selectedRecords],
	);
	const overallSpendTotal = useMemo(() => myBotsSpendTotal(groups.flatMap((group) => group.rows)), [groups]);
	const selectedTickRun = useMemo(() => myBotsRunTickSelection(selectedBots), [selectedBots]);
	const selectedCount = selectedBots.length;
	const enabledBotCount = bots.filter((bot) => bot.tickSettings.enabled).length;
	const allVisibleSelected = visibleBotIds.length > 0 && visibleBotIds.every((id) => selectedBotIds.has(id));
	const someVisibleSelected = selectedCount > 0;

	useEffect(() => {
		const visibleIds = new Set(visibleBotIds);
		setSelectedBotIds((current) => {
			let changed = false;
			const next = new Set<string>();
			for (const id of current) {
				if (visibleIds.has(id)) {
					next.add(id);
				} else {
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [visibleBotIds]);

	useEffect(() => {
		if (selectAllRef.current) {
			selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
		}
	}, [allVisibleSelected, someVisibleSelected]);

	function toggleSort(key: MyBotsSortKey): void {
		setSort((current) =>
			current.key === key ?
				{ key, direction: current.direction === "asc" ? "desc" : "asc" }
			:	{ key, direction: "asc" },
		);
	}

	function toggleAllVisible(): void {
		setSelectedBotIds((current) => {
			const next = new Set(current);
			if (allVisibleSelected) {
				for (const id of visibleBotIds) {
					next.delete(id);
				}
			} else {
				for (const id of visibleBotIds) {
					next.add(id);
				}
			}
			return next;
		});
	}

	function toggleGroup(botIds: string[]): void {
		setSelectedBotIds((current) => {
			const next = new Set(current);
			const allGroupSelected = botIds.length > 0 && botIds.every((id) => next.has(id));
			for (const id of botIds) {
				if (allGroupSelected) {
					next.delete(id);
				} else {
					next.add(id);
				}
			}
			return next;
		});
	}

	function toggleBot(botId: string): void {
		setSelectedBotIds((current) => {
			const next = new Set(current);
			if (next.has(botId)) {
				next.delete(botId);
			} else {
				next.add(botId);
			}
			return next;
		});
	}

	async function deleteSelectedBots(): Promise<void> {
		const result = await onDeleteBots(selectedBots);
		if (result.deleted.length > 0) {
			const deletedIds = new Set(result.deleted.map((bot) => bot.id));
			setSelectedBotIds((current) => {
				const next = new Set(current);
				for (const id of deletedIds) {
					next.delete(id);
				}
				return next;
			});
			toast.push(`Deleted ${result.deleted.length} bot${result.deleted.length === 1 ? "" : "s"}.`);
		}
	}

	async function runSelectedTicks(): Promise<void> {
		if (selectedTickRun.disabled) {
			return;
		}
		await onRunBotTicks(selectedTickRun.targetBots);
	}

	async function spreadTicks(): Promise<void> {
		if (enabledBotCount === 0) {
			return;
		}
		const result = await onSpreadBotTicks();
		if (result) {
			const skipped = result.skipped.paused + result.skipped.running;
			toast.push(`Spread ticks for ${result.scheduled.length} bot${result.scheduled.length === 1 ? "" : "s"}${skipped ? `; ${skipped} unchanged` : ""}.`);
		}
	}

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>My bots</h1>
					<p className="sub">All bots you own across every world.</p>
				</div>
				<div className="actions bot-table-bulk-actions">
					{selectedCount > 0 && (
						<>
							<span className="selection-count">
								{selectedCount} selected
							</span>
							<button className="btn danger" onClick={() => setConfirmAction("delete")} type="button">
								<Icon name="trash" size={14} />
								Delete
							</button>
							<button
								className="btn"
								disabled={selectedTickRun.disabled}
								onClick={() => setConfirmAction("tick")}
								title={selectedTickRun.title}
								type="button"
							>
								<Icon name="refresh" size={14} />
								Run tick
							</button>
						</>
					)}
					<button
						className="btn"
						disabled={enabledBotCount === 0}
						onClick={() => setConfirmAction("spread")}
						title={
							enabledBotCount === 0 ?
								"No active bots have scheduled ticks to spread."
							:	"Spread active bot ticks across their schedules"
						}
						type="button"
					>
						<Icon name="clock" size={14} />
						Spread ticks
					</button>
				</div>
			</div>
			{bots.length === 0 ?
				<EmptyState title="You do not own any bots yet">
					Create one from a world's Bots tab.
				</EmptyState>
			:	<>
					<FilterBox
						label="Filter bots"
						onChange={setBotFilter}
						placeholder="Filter by u/handle, display name, or world"
						value={botFilter}
					/>
					{groups.length === 0 ?
						<div className="empty compact-empty">No bots match this filter.</div>
					:	<div className="bot-table-shell">
							<div className="bot-table-scroll">
								<table className="bot-table">
									<colgroup>
										<col className="bot-table-select-col" />
										<col className="bot-table-avatar-col" />
										<col className="bot-table-username-col" />
										<col className="bot-table-display-col" />
										<col className="bot-table-time-col" />
										<col className="bot-table-time-col" />
										<col className="bot-table-model-col" />
										<col className="bot-table-spend-col" />
									</colgroup>
									<thead>
										<tr>
											<th className="bot-table-check-heading" scope="col">
												<input
													aria-label={allVisibleSelected ? "Clear visible bot selection" : "Select all visible bots"}
													checked={allVisibleSelected}
													disabled={visibleBotIds.length === 0}
													onChange={toggleAllVisible}
													ref={selectAllRef}
													type="checkbox"
												/>
											</th>
											<th className="bot-table-avatar-heading" scope="col">
												<span className="sr-only">Avatar</span>
											</th>
											<MyBotsSortHeader label="u/username" onSort={toggleSort} sort={sort} sortKey="handle" />
											<MyBotsSortHeader label="Display name" onSort={toggleSort} sort={sort} sortKey="displayName" />
											<MyBotsSortHeader label="Last active" onSort={toggleSort} sort={sort} sortKey="lastActive" />
											<MyBotsSortHeader label="Next tick" onSort={toggleSort} sort={sort} sortKey="nextDue" />
											<MyBotsSortHeader label="Current model" onSort={toggleSort} sort={sort} sortKey="model" />
											<MyBotsSortHeader label="$/day" onSort={toggleSort} sort={sort} sortKey="spend" />
										</tr>
									</thead>
									{groups.map((group) => {
										const groupBotIds = group.rows.map((row) => row.bot.id);
										const selectedInGroup = groupBotIds.filter((id) => selectedBotIds.has(id)).length;
										const allGroupSelected = groupBotIds.length > 0 && selectedInGroup === groupBotIds.length;
										const someGroupSelected = selectedInGroup > 0;
										const groupSpendTotal = myBotsSpendTotal(group.rows);
										return (
											<tbody key={group.worldHandle}>
												<tr className="bot-table-group-row">
													<th colSpan={7} scope="rowgroup">
														<span className="bot-table-group-layout">
															<MyBotsGroupCheckbox
																allSelected={allGroupSelected}
																botIds={groupBotIds}
																label={`w/${group.worldHandle}`}
																onToggle={toggleGroup}
																someSelected={someGroupSelected}
															/>
															<span className="bot-table-group-label">
																{group.world ?
																	<SpaLink to={{ route: "world", worldHandle: group.worldHandle }}>
																		<Reference kind="world" link={false} name={group.worldHandle} />
																	</SpaLink>
																:	<Reference kind="world" name={group.worldHandle} />}
															</span>
															<span className="bot-table-group-count">
																{group.rows.length} bot{group.rows.length === 1 ? "" : "s"}
															</span>
														</span>
													</th>
													<td className="bot-table-spend-cell" title={formatMyBotsSpendTotalTitle(groupSpendTotal)}>
														{formatMyBotsSpendTotal(groupSpendTotal)}
													</td>
												</tr>
												{group.rows.map((record) => {
													const { bot } = record;
													const selected = selectedBotIds.has(bot.id);
													return (
														<tr
															className={`bot-table-row ${selected ? "selected" : ""} ${bot.tickSettings.enabled ? "" : "paused"}`.trim()}
															key={bot.id}
														>
															<td className="bot-table-check-cell">
																<input
																	aria-label={`Select u/${bot.handle}`}
																	checked={selected}
																	onChange={() => toggleBot(bot.id)}
																	type="checkbox"
																/>
															</td>
															<td className="bot-table-avatar-cell">
																<BotProfileHoverLink
																	bot={bot}
																	className="bot-table-avatar-link"
																	title={`Open ${bot.displayName}`}
																>
																	<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} imageUrl={bot.avatarUrl} name={bot.displayName} size="sm" />
																</BotProfileHoverLink>
															</td>
															<td className="bot-table-username-cell">
																<Reference isBot kind="bot" name={bot.handle} worldHandle={bot.homeWorldHandle} />
															</td>
															<td className="bot-table-display-cell">
																	<BotProfileHoverLink
																		bot={bot}
																		className="bot-table-display-link"
																		title={`Open ${textValue(bot.displayName)}`}
																	>
																		<TranslatableText as="span" text={bot.displayName} />
																	</BotProfileHoverLink>
															</td>
															<td className="bot-table-time-cell">
																<TimeAgoLabel suffix value={bot.lastActiveAt ?? bot.createdAt} />
															</td>
															<td className="bot-table-time-cell">
																{bot.tickSettings.enabled ?
																	<TimeUntilLabel value={bot.nextDueAt} />
																:	<span className="bot-status-label paused">Paused</span>}
															</td>
															<td className="bot-table-model-cell">
																<ModelChip model={record.effectiveModel} />
															</td>
															<td className="bot-table-spend-cell" title={formatBotSpendTitle(record.spend)}>
																{formatBotSpendValue(record.spend)}
															</td>
														</tr>
													);
												})}
											</tbody>
										);
									})}
									<tfoot>
										<tr className="bot-table-total-row">
											<th colSpan={7} scope="row">Total</th>
											<td className="bot-table-spend-cell" title={formatMyBotsSpendTotalTitle(overallSpendTotal)}>
												{formatMyBotsSpendTotal(overallSpendTotal)}
											</td>
										</tr>
									</tfoot>
								</table>
							</div>
						</div>
					}
				</>
			}
			<Confirm
				body={
					confirmAction === "delete" ?
						<>
							This will remove {selectedCount} selected bot{selectedCount === 1 ? "" : "s"} from your active bot list.
						</>
					: confirmAction === "tick" ?
						<>
							This will start a tick for {selectedTickRun.targetCount} selected active bot{selectedTickRun.targetCount === 1 ? "" : "s"}.
							{selectedTickRun.pausedCount > 0 && (
								<> {selectedTickRun.pausedCount} paused selected bot{selectedTickRun.pausedCount === 1 ? "" : "s"} will be skipped.</>
							)}
						</>
					: confirmAction === "spread" ?
						<>
							This will reschedule {enabledBotCount} active bot{enabledBotCount === 1 ? "" : "s"} so their ticks are spread out. The next scheduled bot becomes due now. Paused or already-running bots stay unchanged.
						</>
					:	null
				}
				confirmText={
					confirmAction === "delete" ?
						`Delete ${selectedCount} bot${selectedCount === 1 ? "" : "s"}`
					: confirmAction === "tick" ?
						`Run ${selectedTickRun.targetCount} tick${selectedTickRun.targetCount === 1 ? "" : "s"}`
					:	"Spread ticks"
				}
				danger={confirmAction === "delete"}
				onClose={() => setConfirmAction(null)}
				onConfirm={() => {
					if (confirmAction === "delete") {
						void deleteSelectedBots();
					} else if (confirmAction === "tick") {
						void runSelectedTicks();
					} else if (confirmAction === "spread") {
						void spreadTicks();
					}
				}}
				open={Boolean(confirmAction)}
				title={
					confirmAction === "delete" ? "Delete selected bots?"
					: confirmAction === "tick" ? "Run selected ticks?"
					: "Spread bot ticks?"
				}
			/>
		</div>
	);
}

function ModelChip({ model }: { model: string }) {
	return (
		<span
			className="bot-table-model-chip"
			style={{ "--model-h": String(modelColorHue(model)) } as CSSProperties}
			title={model}
		>
			{model}
		</span>
	);
}

function formatBotSpendValue(spend: MyBotSpendLoadState | undefined): ReactNode {
	if (!spend || spend.status === "loading") {
		return <LoadingEllipsis />;
	}
	if (spend.status === "error" || spend.summary.last24Hours.unknownCost) {
		return "$?";
	}
	return formatTokenCostParts(spend.summary.last24Hours.cost ?? 0, 4);
}

function formatBotSpendTitle(spend: MyBotSpendLoadState | undefined): string {
	if (!spend || spend.status === "loading") {
		return "Token spend is loading.";
	}
	if (spend.status === "error") {
		return `Token spend could not be loaded: ${spend.message}`;
	}
	const last24 = spend.summary.last24Hours;
	const average = spend.summary.average;
	const last24Cost = last24.unknownCost ? "unknown" : formatTokenCost(last24.cost ?? 0);
	const averageCost =
		average.noCurrentModelUsage ? "$0.00/day; no tracked requests for the current model"
		: average.unknownCost ? "unknown/day"
		: `${formatTokenCost(average.costPerDay ?? 0)}/day`;
	return [
		`24h: ${last24Cost} across ${last24.requestCount} tracked request${last24.requestCount === 1 ? "" : "s"}.`,
		`Avg/day: ${averageCost}.`,
		`Average window: ${formatFullDate(average.periodStart)} to ${formatFullDate(average.periodEnd)} (${formatAverageDays(average.dayCount)}).`,
		`Current model: ${spend.summary.currentModel}.`,
	].join("\n");
}

function formatMyBotsSpendTotal(total: MyBotsSpendTotal): ReactNode {
	if (total.pendingCount > 0) {
		return <LoadingEllipsis />;
	}
	if (total.unknownCost || total.errorCount > 0) {
		return "$?";
	}
	return formatTokenCostParts(total.cost ?? 0, 4);
}

function formatMyBotsSpendTotalTitle(total: MyBotsSpendTotal): string {
	if (total.pendingCount > 0) {
		return `Loading token spend for ${total.pendingCount} visible bot${total.pendingCount === 1 ? "" : "s"}.`;
	}
	if (total.errorCount > 0) {
		return `Total is unknown because token spend failed to load for ${total.errorCount} visible bot${total.errorCount === 1 ? "" : "s"}.`;
	}
	if (total.unknownCost) {
		return `Total is unknown because at least one visible tracked request did not report cost. Known subtotal: ${formatTokenCost(total.knownCost)}.`;
	}
	return `${formatTokenCost(total.cost ?? 0)} across ${total.requestCount} tracked 24h request${total.requestCount === 1 ? "" : "s"}.`;
}

function LoadingEllipsis() {
	return (
		<span aria-label="Loading" className="loading-ellipsis">
			<span>.</span>
			<span>.</span>
			<span>.</span>
		</span>
	);
}

function MyBotsSortHeader({
	label,
	onSort,
	sort,
	sortKey,
}: {
	label: string;
	onSort: (key: MyBotsSortKey) => void;
	sort: MyBotsSortState;
	sortKey: MyBotsSortKey;
}) {
	const active = sort.key === sortKey;
	return (
		<th aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
			<button className={`bot-table-sort ${active ? "active" : ""}`} onClick={() => onSort(sortKey)} type="button">
				<span>{label}</span>
				{active && <Icon name={sort.direction === "asc" ? "arrowUp" : "arrowDown"} size={12} />}
			</button>
		</th>
	);
}

function MyBotsGroupCheckbox({
	allSelected,
	botIds,
	label,
	onToggle,
	someSelected,
}: {
	allSelected: boolean;
	botIds: string[];
	label: string;
	onToggle: (botIds: string[]) => void;
	someSelected: boolean;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.indeterminate = someSelected && !allSelected;
		}
	}, [allSelected, someSelected]);
	return (
		<input
			aria-label={allSelected ? `Clear ${label} bot selection` : `Select all bots in ${label}`}
			checked={allSelected}
			className="bot-table-group-checkbox"
			disabled={botIds.length === 0}
			onChange={() => onToggle(botIds)}
			ref={inputRef}
			type="checkbox"
		/>
	);
}

function readMyBotsSortState(): MyBotsSortState {
	try {
		return parseMyBotsSortState(window.localStorage.getItem(myBotsSortStorageKey));
	} catch {
		return defaultMyBotsSortState;
	}
}

function writeMyBotsSortState(sort: MyBotsSortState): void {
	try {
		window.localStorage.setItem(myBotsSortStorageKey, JSON.stringify(sort));
	} catch {
		// Browser storage can be unavailable; the table still sorts for the current render.
	}
}







function timestampSortValue(value: string | null | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
