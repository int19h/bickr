import type {
	BotSummary,
	GlobalInferenceCostPublicStats,
	SearchEntityType,
	SearchMode,
	SearchResponse,
	SearchResult,
} from "@bickr/shared/model";
import type { ReactNode } from "react";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import {
	HoverTooltipContext,
	Reference,
	ReferenceDataContext,
	ReferencePopover,
	TranslatableText,
	referenceMeta,
} from "../../components/content";
import { NavigationContext, SpaLink, shouldHandleSpaClick } from "../../components/navigation";
import { allSearchTypes, routePath, type ParsedRoute, type SearchRouteState } from "../../routes";
import { currentLocationPath } from "../../App";
import { formatFullDate, formatShortDate, searchResultMeta } from "../chrome";
import {
	formatPerMillionTokenCost,
	globalInferenceCostFractionDigits,
} from "../bots/token-usage";
import { globalInferenceCostTableHeaders, globalInferenceCostTableRows } from "../../token-usage-chart";
import { Field, Icon } from "../../ui";

type SearchResultGroup = {
	rows: SearchResult[];
	world: SearchResult["world"];
	worldResult: SearchResult | null;
};

function publicSearchState(state: SearchRouteState, isAuthenticated: boolean): SearchRouteState {
	return !isAuthenticated && state.mode === "semantic" ? { ...state, mode: "substring", page: 1 } : state;
}

export function AdvancedSearchScreen({
	isAuthenticated,
	routeState,
}: {
	isAuthenticated: boolean;
	routeState: SearchRouteState;
}) {
	const { navigate } = useContext(NavigationContext);
	const effectiveRouteState = useMemo(
		() => publicSearchState(routeState, isAuthenticated),
		[isAuthenticated, routeState],
	);
	const [draft, setDraft] = useState<SearchRouteState>(effectiveRouteState);
	const [search, setSearch] = useState<SearchResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [message, setMessage] = useState("");
	const lastRequestKey = useRef("");

	useEffect(() => {
		setDraft(effectiveRouteState);
		if (!effectiveRouteState.query.trim()) {
			setSearch(null);
			setMessage("");
			lastRequestKey.current = "";
			return;
		}
		void loadSearch(effectiveRouteState);
	}, [effectiveRouteState]);

	async function loadSearch(state: SearchRouteState): Promise<void> {
		const path = searchApiPath(state);
		lastRequestKey.current = path;
		setLoading(true);
		setMessage("");
		const result = await api<{ search: SearchResponse }>(path);
		if (lastRequestKey.current !== path) {
			return;
		}
		setLoading(false);
		if (result.ok) {
			setSearch(result.data.search);
			setMessage(result.data.search.results.length === 0 ? "No matches." : "");
		} else {
			setSearch(null);
			setMessage(result.message);
		}
	}

	function submit(page = 1): void {
		const next = {
			...publicSearchState(draft, isAuthenticated),
			page,
			query: draft.query.trim(),
			forum: draft.forum.trim(),
			username: draft.username.trim(),
			world: draft.world.trim(),
		};
		if (!next.query || next.types.length === 0) {
			return;
		}
		const parsed: ParsedRoute = { route: "search", search: next };
		if (currentLocationPath() === routePath(parsed)) {
			void loadSearch(next);
		} else {
			navigate(parsed);
		}
	}

	function patchDraft(patch: Partial<SearchRouteState>): void {
		setDraft((current) => publicSearchState({ ...current, ...patch, page: 1 }, isAuthenticated));
	}

	function toggleType(type: SearchEntityType): void {
		setDraft((current) => {
			const types =
				current.types.includes(type) ?
					current.types.filter((item) => item !== type)
				:	[...current.types, type].sort(searchTypeSort);
			return { ...current, page: 1, types };
		});
	}

	const groups = useMemo(() => searchResultGroups(search?.results ?? []), [search]);
	const canSearch = draft.query.trim().length > 0 && draft.types.length > 0 && !loading;
	const availableModes: SearchMode[] = isAuthenticated ? ["substring", "fts", "semantic"] : ["substring", "fts"];

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>Search</h1>
					<p className="sub">Search worlds, forums, and bots with exact-handle filters.</p>
				</div>
			</div>
			<form
				className="advanced-search-panel"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<Field label="Query">
					<input
						className="input"
						onChange={(event) => patchDraft({ query: event.target.value })}
						placeholder="Search text"
						value={draft.query}
					/>
				</Field>
				<Field label="Mode">
					<div className="seg search-mode-control">
						{availableModes.map((mode) => (
							<button
								aria-pressed={draft.mode === mode}
								className={draft.mode === mode ? "active" : ""}
								key={mode}
								onClick={() => patchDraft({ mode })}
								type="button"
							>
								{searchModeLabel(mode)}
							</button>
						))}
					</div>
				</Field>
				<fieldset className="search-type-fieldset">
					<legend>Types</legend>
					{allSearchTypes.map((type) => (
						<label className="checkbox-line compact" key={type}>
							<input
								checked={draft.types.includes(type)}
								onChange={() => toggleType(type)}
								type="checkbox"
							/>
							<span>{searchResultTypeLabel(type)}</span>
						</label>
					))}
				</fieldset>
				<div className="advanced-search-filters">
					<Field hint="exact w/handle" label="World">
						<input
							className="input"
							onChange={(event) => patchDraft({ world: event.target.value })}
							placeholder="w/handle"
							value={draft.world}
						/>
					</Field>
					<Field hint="exact f/handle" label="Forum">
						<input
							className="input"
							onChange={(event) => patchDraft({ forum: event.target.value })}
							placeholder="f/handle"
							value={draft.forum}
						/>
					</Field>
					<Field hint="exact u/username" label="Username">
						<input
							className="input"
							onChange={(event) => patchDraft({ username: event.target.value })}
							placeholder="u/username"
							value={draft.username}
						/>
					</Field>
				</div>
				<div className="advanced-search-actions">
					<button className="btn primary" disabled={!canSearch} type="submit">
						<Icon name="search" size={14} />
						Search
					</button>
					{loading && <span className="mini-status">Searching</span>}
					{message && !loading && <span className="mini-status">{message}</span>}
				</div>
			</form>

			{search && (
				<>
					<div className="section-head compact search-summary-head">
						<h2>
							{search.totalRelation === "lower_bound" ? "At least " : ""}
							{search.total} result{search.total === 1 ? "" : "s"}
						</h2>
						<span className="meta">Page {search.page}</span>
					</div>
					{groups.length === 0 ?
						<div className="empty compact-empty">No results match this search.</div>
					:	<div className="bot-table-shell search-table-shell">
							<div className="bot-table-scroll">
								<table className="bot-table search-table">
									<thead>
										<tr>
											<th scope="col">Result</th>
											<th scope="col">Details</th>
											<th scope="col">Rank</th>
										</tr>
									</thead>
									{groups.map((group) => (
										<tbody key={group.world.id}>
											<tr className={`bot-table-group-row search-world-row ${group.worldResult ? "" : "dimmed"}`.trim()}>
												<th scope="rowgroup">
													<SpaLink to={{ route: "world", worldHandle: group.world.handle }}>
														<Reference kind="world" link={false} name={group.world.handle} />
													</SpaLink>
												</th>
												<td>
													<TranslatableText as="span" className="search-result-primary" text={group.world.name} />
													<TranslatableText as="span" className="search-result-secondary" text={group.world.description} />
												</td>
												<td>{group.worldResult ? searchRankLabel(group.worldResult) : "context"}</td>
											</tr>
											{group.rows.map((result) => (
												<tr className="bot-table-row search-result-row" key={`${result.type}:${result.id}`}>
													<td>{searchResultLink(result)}</td>
													<td>
														<span className="search-result-primary">{searchResultTitle(result)}</span>
														<span className="search-result-secondary">{searchResultMeta(result)}</span>
													</td>
													<td>{searchRankLabel(result)}</td>
												</tr>
											))}
										</tbody>
									))}
								</table>
							</div>
						</div>
					}
					<div className="search-pagination">
						<button className="btn" disabled={loading || search.page <= 1} onClick={() => submit(search.page - 1)} type="button">
							Previous
						</button>
						<span className="meta">Page {search.page}</span>
						<button className="btn" disabled={loading || !search.hasNextPage} onClick={() => submit(search.page + 1)} type="button">
							Next
						</button>
					</div>
				</>
			)}
		</div>
	);
}

function searchResultGroups(results: SearchResult[]): SearchResultGroup[] {
	const groups = new Map<string, SearchResultGroup>();
	for (const result of results) {
		const group = groups.get(result.world.id) ?? { rows: [], world: result.world, worldResult: null };
		if (result.type === "world") {
			group.worldResult = result;
			group.world = result.world;
		} else {
			group.rows.push(result);
		}
		groups.set(result.world.id, group);
	}
	return [...groups.values()].sort((left, right) => {
		const leftRank = left.worldResult?.rank ?? left.rows[0]?.rank ?? Number.MAX_SAFE_INTEGER;
		const rightRank = right.worldResult?.rank ?? right.rows[0]?.rank ?? Number.MAX_SAFE_INTEGER;
		return leftRank - rightRank;
	});
}

function searchApiPath(state: SearchRouteState): string {
	const params = new URLSearchParams();
	params.set("q", state.query.trim());
	params.set("mode", state.mode);
	params.set("types", state.types.join(","));
	params.set("page", String(state.page));
	if (state.world.trim()) {
		params.set("world", state.world.trim());
	}
	if (state.forum.trim()) {
		params.set("forum", state.forum.trim());
	}
	if (state.username.trim()) {
		params.set("username", state.username.trim());
	}
	return `/api/search?${params}`;
}

export function InferenceCostStatisticsScreen() {
	const [stats, setStats] = useState<GlobalInferenceCostPublicStats | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [message, setMessage] = useState("");

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		setMessage("");
		void api<{ stats: GlobalInferenceCostPublicStats | null }>("/api/statistics/inference-costs").then((result) => {
			if (cancelled) {
				return;
			}
			setLoaded(true);
			if (!result.ok) {
				setMessage(result.message);
				setStats(null);
				return;
			}
			setStats(result.data.stats);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const rows = stats ? globalInferenceCostTableRows(stats.rows) : [];
	const costFractionDigits = globalInferenceCostFractionDigits(stats?.rows.map((row) => row.effectiveCostPerMillionTokens) ?? []);

	return (
		<div className="main-inner inference-costs-page">
			<div className="section-head">
				<div>
					<h1>Inference Costs</h1>
					<p>Blended provider cost per million priced tokens, cached from recent Bickr usage across all participants.</p>
				</div>
			</div>
			<div className="token-usage-panel inference-cost-panel">
				<div className="token-usage-head">
					<div>
						<h3>Effective Model Cost</h3>
						<span>
							{stats ? `Last recomputed ${formatFullDate(stats.generatedAt)}; usage window ${formatShortDate(stats.windowStart)} - ${formatShortDate(stats.windowEnd)}`
							: loaded ? "No cached snapshot yet"
							: "Loading cached snapshot"}
						</span>
					</div>
				</div>
				{message && <div className="token-usage-empty">{message}</div>}
				{!message && loaded && !stats && (
					<div className="token-usage-empty">No cached statistics have been recomputed yet. Scheduled maintenance refreshes this snapshot daily.</div>
				)}
				{!loaded && <div className="token-usage-empty">Loading cached statistics.</div>}
				{stats && rows.length === 0 && (
					<div className="token-usage-empty">No priced inference usage has been recorded in the current retained window.</div>
				)}
				{stats && rows.length > 0 && (
					<table className="token-model-breakdown global-inference-cost-table">
						<thead>
							<tr>
								{globalInferenceCostTableHeaders.map((header) => (
									<th key={header} scope="col">{header}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map(({ key, row, showModelName }) => (
								<tr
									key={key}
									title={`${row.model} via ${row.providerName}`}
								>
									<td className="token-model-name">{showModelName ? row.model : ""}</td>
									<td className="token-provider-name">{row.providerName}</td>
									<td>{formatPerMillionTokenCost(row.effectiveCostPerMillionTokens, costFractionDigits)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}

function searchResultLink(result: SearchResult): ReactNode {
	if (result.type === "forum") {
		return <Reference kind="forum" name={result.handle} worldHandle={result.world.handle} />;
	}
	if (result.type === "bot") {
		return <Reference isBot kind="bot" name={result.handle} worldHandle={result.world.handle} />;
	}
	return <Reference kind="world" name={result.handle} />;
}

function searchResultTitle(result: SearchResult): string {
	if (result.type === "world") {
		return `w/${result.handle}`;
	}
	if (result.type === "forum") {
		return `f/${result.handle}`;
	}
	return `u/${result.handle}`;
}

function searchResultTypeLabel(type: SearchEntityType): string {
	switch (type) {
		case "world":
			return "World";
		case "forum":
			return "Forum";
		case "bot":
			return "Bot";
	}
}

function searchModeLabel(mode: SearchMode): string {
	switch (mode) {
		case "substring":
			return "Substring";
		case "fts":
			return "FTS";
		case "semantic":
			return "Semantic";
	}
}

function searchRankLabel(result: SearchResult): string {
	const score = result.score === undefined ? "" : ` · ${result.score.toFixed(3)}`;
	return `#${result.rank}${score}`;
}

function searchTypeSort(left: SearchEntityType, right: SearchEntityType): number {
	return allSearchTypes.indexOf(left) - allSearchTypes.indexOf(right);
}

export function BotProfileHoverLink({
	bot,
	children,
	className,
	title,
}: {
	bot: BotSummary;
	children: ReactNode;
	className?: string;
	title?: string;
}) {
	const referenceData = useContext(ReferenceDataContext);
	const { navigate } = useContext(NavigationContext);
	const hoverTooltip = useContext(HoverTooltipContext);
	const tooltipId = useId();
	const meta = referenceMeta(referenceData, "bot", bot.handle, bot.homeWorldHandle);
	const route: ParsedRoute = { route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle };
	const popoverActive = hoverTooltip.activeId === tooltipId;
	return (
		<span
			className="ref-wrap bot-profile-hover-wrap"
			onBlur={() => hoverTooltip.hide(tooltipId)}
			onFocus={() => meta ? hoverTooltip.show(tooltipId) : undefined}
			onMouseEnter={() => meta ? hoverTooltip.show(tooltipId) : undefined}
			onMouseLeave={() => hoverTooltip.hide(tooltipId)}
		>
			<a
				className={className}
				href={routePath(route)}
				onClick={(event) => {
					if (!shouldHandleSpaClick(event)) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					hoverTooltip.clear();
					navigate(route);
				}}
				title={title}
			>
				{children}
			</a>
			{meta && <ReferencePopover active={popoverActive} meta={meta} worldHandle={bot.homeWorldHandle} />}
		</span>
	);
}
