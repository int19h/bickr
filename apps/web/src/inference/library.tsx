import { useContext, useMemo, useState } from "react";
import type {
	InferenceBotHomeWorldGroup,
	InferenceConfigurationSummary,
	InferenceLibraryPage,
} from "@bickr/shared/inference-configuration-owner";
import type { ApiFailure } from "../api";
import { EmptyState, FilterBox, Icon, Modal, ToastContext } from "../ui";
import type { InferenceReturnTarget, ParsedRoute } from "../routes";
import {
	createConfiguration,
	inferenceGraphErrorCause,
	inferenceGraphUnavailable,
	librarySectionPath,
	parentCandidatesPath,
} from "./api";
import { ConfigurationSummaryRow, KindBadge } from "./summary";
import { useConfigurationPage } from "./use-configuration-page";

export function InferenceLibraryScreen({
	onNavigate,
	returnTo,
}: {
	onNavigate: (route: ParsedRoute) => void;
	returnTo?: InferenceReturnTarget;
}) {
	const [searchDraft, setSearchDraft] = useState("");
	const [query, setQuery] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const toast = useContext(ToastContext);

	// Search covers custom names and world/participant handles; Account default is
	// a single fixed entry that always stays reachable, including for New
	// configuration's Start blank parent.
	const account = useSection("account", "");
	const custom = useSection("custom", query);
	const worlds = useSection("world", query);
	const bots = useSection("bot", query);
	const accountDefault = account.items[0] ?? null;
	const unavailable = [account, custom, worlds, bots].find((section) => section.error && inferenceGraphUnavailable(section.error));

	function applySearch(value: string): void {
		setSearchDraft(value);
		setQuery(value.trim());
	}

	if (unavailable) {
		return (
			<div className="main-inner">
				<EmptyState title="Inference library is not ready">
					This account has not been moved onto inference configurations yet, so the library cannot be shown.
				</EmptyState>
			</div>
		);
	}

	return (
		<div className="main-inner inference-library">
			<div className="page-header">
				<div className="page-title-block">
					<h1>Inference library</h1>
					<p className="sub">
						Configurations inherit field by field from their parent. Editing a parent flows through every child
						immediately; nothing here is a copied snapshot.
					</p>
				</div>
				<div className="actions">
					<button className="btn primary" onClick={() => setCreateOpen(true)} type="button">
						<Icon name="plus" size={14} />
						New configuration
					</button>
				</div>
			</div>

			<div className="inference-library-search">
				<FilterBox
					label="Search configurations"
					onChange={applySearch}
					placeholder="Search custom names, participants, and worlds"
					value={searchDraft}
				/>
			</div>

			<section className="section">
				<div className="section-head">
					<h2>Custom configurations</h2>
					<span className="meta">created and named by you</span>
				</div>
				<SectionBody
					emptyBody={
						query
							? "No custom configuration matches this search."
							: "You have no custom configurations yet. Create one to share settings across participants and worlds."
					}
					emptyTitle={query ? "No matches" : "No custom configurations"}
					returnTo={returnTo}
					section={custom}
				/>
			</section>

			<section className="section">
				<div className="section-head">
					<h2>Account, world, and bot configurations</h2>
					<span className="meta">created and removed with the account, world, or participant</span>
				</div>

				<h3 className="inference-subsection-title">Account default</h3>
				<SectionBody
					emptyBody="Account default has not been created for this account yet."
					emptyTitle="No Account default"
					returnTo={returnTo}
					section={account}
				/>

				<h3 className="inference-subsection-title">Owned worlds</h3>
				<SectionBody
					emptyBody={query ? "No world configuration matches this search." : "You do not own any worlds yet."}
					emptyTitle={query ? "No matches" : "No world configurations"}
					returnTo={returnTo}
					section={worlds}
				/>

				<h3 className="inference-subsection-title">Participants by home world</h3>
				<BotGroups query={query} returnTo={returnTo} section={bots} />
			</section>

			{createOpen && accountDefault && (
				<CreateConfigurationModal
					accountDefault={accountDefault}
					onClose={() => setCreateOpen(false)}
					onCreated={(configurationId, name) => {
						setCreateOpen(false);
						toast.push(`Created ${name}`);
						onNavigate({ route: "inference-configuration", configurationId, ...(returnTo ? { returnTo } : {}) });
					}}
				/>
			)}
		</div>
	);
}

type SectionState = ReturnType<typeof useSection>;

function useSection(section: "account" | "custom" | "world" | "bot", query: string) {
	return useConfigurationPage<InferenceLibraryPage>(
		(cursor) => librarySectionPath(section, { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) }),
		(payload) => libraryPage(payload),
		[section, query],
	);
}

function libraryPage(payload: unknown): InferenceLibraryPage | null {
	const configurations = (payload as { configurations?: InferenceLibraryPage }).configurations;
	return configurations && Array.isArray(configurations.items) ? configurations : null;
}

function SectionBody({
	emptyBody,
	emptyTitle,
	returnTo,
	section,
}: {
	emptyBody: string;
	emptyTitle: string;
	returnTo?: InferenceReturnTarget;
	section: SectionState;
}) {
	if (section.loading) {
		return <div className="runtime-message">Loading configurations...</div>;
	}
	if (section.error) {
		return <div className="runtime-message error">{section.error.message}</div>;
	}
	if (section.items.length === 0) {
		return <EmptyState title={emptyTitle}>{emptyBody}</EmptyState>;
	}
	return (
		<>
			<ul className="inference-summary-list">
				{section.items.map((summary) => (
					<ConfigurationSummaryRow key={summary.id} returnTo={returnTo} summary={summary} />
				))}
			</ul>
			<LoadMore section={section} />
		</>
	);
}

function LoadMore({ section }: { section: SectionState }) {
	if (!section.nextCursor) {
		return null;
	}
	return (
		<button className="btn ghost compact" disabled={section.loadingMore} onClick={section.loadMore} type="button">
			{section.loadingMore ? "Loading..." : "Load more"}
		</button>
	);
}

function BotGroups({
	query,
	returnTo,
	section,
}: {
	query: string;
	returnTo?: InferenceReturnTarget;
	section: SectionState;
}) {
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const grouped = useMemo(() => groupBotSummaries(section.items, section.extra?.groups ?? []), [section.extra, section.items]);

	if (section.loading) {
		return <div className="runtime-message">Loading participant configurations...</div>;
	}
	if (section.error) {
		return <div className="runtime-message error">{section.error.message}</div>;
	}
	if (grouped.length === 0) {
		return (
			<EmptyState title={query ? "No matches" : "No participant configurations"}>
				{query ? "No participant configuration matches this search." : "You do not own any participants yet."}
			</EmptyState>
		);
	}
	return (
		<>
			{grouped.map((group) => {
				const open = !collapsed[group.homeWorldId];
				return (
					<div className="inference-bot-group" key={group.homeWorldId}>
						<button
							aria-expanded={open}
							className="inference-bot-group-head"
							onClick={() => setCollapsed((current) => ({ ...current, [group.homeWorldId]: open }))}
							type="button"
						>
							<Icon name="chev" size={14} />
							<span>{group.displayName}</span>
							<span className="count">{group.botConfigurationCount}</span>
						</button>
						{open && (
							<ul className="inference-summary-list">
								{group.items.map((summary) => (
									<ConfigurationSummaryRow key={summary.id} returnTo={returnTo} summary={summary} />
								))}
							</ul>
						)}
					</div>
				);
			})}
			<LoadMore section={section} />
		</>
	);
}

export type BotHomeWorldGrouping = InferenceBotHomeWorldGroup & { items: InferenceConfigurationSummary[] };

/**
 * Groups the loaded participant page under the home worlds the server counted.
 * A world's own fixed configuration is not a participant entry, so it can only
 * appear in the owned-world subgroup, never as a duplicate group heading.
 */
export function groupBotSummaries(
	items: readonly InferenceConfigurationSummary[],
	groups: readonly InferenceBotHomeWorldGroup[],
): BotHomeWorldGrouping[] {
	const byWorld = new Map<string, InferenceConfigurationSummary[]>();
	for (const item of items) {
		if (item.kind !== "bot") continue;
		const bucket = byWorld.get(item.identity.homeWorldId) ?? [];
		bucket.push(item);
		byWorld.set(item.identity.homeWorldId, bucket);
	}
	const counted = groups.filter((group) => byWorld.has(group.homeWorldId));
	const missing = [...byWorld.keys()]
		.filter((homeWorldId) => !groups.some((group) => group.homeWorldId === homeWorldId))
		.map((homeWorldId) => {
			const first = byWorld.get(homeWorldId)?.[0];
			const handle = first && first.kind === "bot" ? first.identity.homeWorldHandle : homeWorldId;
			return {
				homeWorldId,
				homeWorldHandle: handle,
				displayName: `w/${handle}`,
				botConfigurationCount: byWorld.get(homeWorldId)?.length ?? 0,
			};
		});
	return [...counted, ...missing]
		.sort((left, right) => left.homeWorldHandle.localeCompare(right.homeWorldHandle))
		.map((group) => ({ ...group, items: byWorld.get(group.homeWorldId) ?? [] }));
}

function CreateConfigurationModal({
	accountDefault,
	onClose,
	onCreated,
}: {
	accountDefault: InferenceConfigurationSummary;
	onClose: () => void;
	onCreated: (configurationId: string, name: string) => void;
}) {
	const [name, setName] = useState("");
	// The chosen parent is retained as the entry itself, not as an id looked up
	// in whatever the search happens to be showing: a later search that no
	// longer lists it must not silently relabel the selection.
	const [parent, setParent] = useState<InferenceConfigurationSummary>(accountDefault);
	const [parentQuery, setParentQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const parentId = parent.id;

	// Parent candidates for a new entry are every owner configuration: a new
	// entry has no descendants to exclude.
	const candidates = useConfigurationPage<{ items: InferenceConfigurationSummary[]; nextCursor?: string }>(
		(cursor) =>
			`/api/me/inference-configurations${searchSuffix({ q: parentQuery.trim(), cursor })}`,
		(payload) => {
			const page = (payload as { configurations?: { items: InferenceConfigurationSummary[]; nextCursor?: string } }).configurations;
			return page && Array.isArray(page.items) ? page : null;
		},
		[parentQuery],
	);

	async function submit(): Promise<void> {
		setBusy(true);
		setError("");
		const result = await createConfiguration({ name: name.trim(), parentId });
		setBusy(false);
		if (!result.ok) {
			setError(createErrorMessage(result));
			return;
		}
		onCreated(result.data.id, result.data.displayName);
	}

	return (
		<Modal
			foot={
				<>
					<span />
					<div className="right">
						<button className="btn ghost" onClick={onClose} type="button">Cancel</button>
						<button className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()} type="button">
							{busy ? "Creating..." : "Create"}
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open
			title="New configuration"
		>
			<div className="field-stack">
				<div className="field">
					<label htmlFor="inference-new-name">Name</label>
					<input
						autoFocus
						className="input"
						id="inference-new-name"
						maxLength={120}
						onChange={(event) => setName(event.target.value)}
						value={name}
					/>
				</div>
				<div className="field">
					<span className="inference-field-label">Parent</span>
					<p className="help">
						Start blank keeps Account default as the parent and stores no overrides. Choosing another entry creates a
						live parent link, not a copy.
					</p>
					<div className="inference-parent-picker">
						<button
							aria-pressed={parentId === accountDefault.id}
							className={`btn compact ${parentId === accountDefault.id ? "primary" : "ghost"}`}
							onClick={() => setParent(accountDefault)}
							type="button"
						>
							Start blank (Account default)
						</button>
						<FilterBox
							label="Search parent configurations"
							onChange={setParentQuery}
							placeholder="Search parents"
							value={parentQuery}
						/>
						{candidates.loading ? (
							<div className="runtime-message">Loading parents...</div>
						) : candidates.error ? (
							<div className="runtime-message error">{candidates.error.message}</div>
						) : candidates.items.length === 0 ? (
							<div className="runtime-message">No configuration matches this search.</div>
						) : (
							<ul className="inference-parent-options">
								{candidates.items.map((candidate) => (
									<li key={candidate.id}>
										<button
											aria-pressed={parentId === candidate.id}
											className={`btn compact ${parentId === candidate.id ? "primary" : "ghost"}`}
											onClick={() => setParent(candidate)}
											type="button"
										>
											{candidate.displayName}
										</button>
									</li>
								))}
							</ul>
						)}
						{candidates.nextCursor && (
							<button className="btn ghost compact" disabled={candidates.loadingMore} onClick={candidates.loadMore} type="button">
								{candidates.loadingMore ? "Loading..." : "Load more"}
							</button>
						)}
					</div>
					<SelectedParentLine parent={parent} />
				</div>
				{error && <div className="runtime-message error">{error}</div>}
			</div>
		</Modal>
	);
}

/**
 * Names the entry the form is actually holding, whatever the parent search is
 * showing right now. The selection is the entry itself, so a retained custom
 * parent keeps its own name and kind instead of being relabelled as Account
 * default once a search stops listing it.
 */
export function SelectedParentLine({ parent }: { parent: InferenceConfigurationSummary }) {
	return (
		<p className="help inference-selected-parent">
			<span>Selected parent: {parent.displayName}</span>
			<KindBadge kind={parent.kind} />
		</p>
	);
}

export function createErrorMessage(failure: ApiFailure): string {
	switch (inferenceGraphErrorCause(failure)) {
		case "duplicate_name":
			return "You already have a custom configuration with that name.";
		case "quota_exceeded":
			return "This account has reached its configuration limit.";
		case "invalid_parent":
			return "That parent configuration is no longer available.";
		default:
			return failure.message;
	}
}

function searchSuffix(parts: { q?: string; cursor?: string }): string {
	const params = new URLSearchParams();
	if (parts.q) params.set("q", parts.q);
	if (parts.cursor) params.set("cursor", parts.cursor);
	const search = params.toString();
	return search ? `?${search}` : "";
}

export { parentCandidatesPath };
