import { useEffect, useMemo, useState } from "react";
import type { BotGroupSummary, BotSummary } from "@bickr/shared/model";
import { Reference, TranslatableText, type WorldView } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import {
	Avatar,
	Confirm,
	EmptyState,
	FilterBox,
	Icon,
	Modal,
	textValue,
} from "../../ui";
import { matchesFilter, sortBotsForCards } from "../../components/record-display";

export function BotGroupsTab({
	bots,
	busy,
	currentUserId,
	filter,
	groups,
	onAddMembers,
	onCreateGroup,
	onDeleteGroup,
	onFilterChange,
	onRemoveMember,
	onUpdateTitle,
	world,
}: {
	bots: BotSummary[];
	busy: boolean;
	currentUserId: string;
	filter: string;
	groups: BotGroupSummary[];
	onAddMembers: (group: BotGroupSummary, botIds: string[]) => Promise<boolean>;
	onCreateGroup: () => Promise<boolean>;
	onDeleteGroup: (group: BotGroupSummary) => Promise<boolean>;
	onFilterChange: (value: string) => void;
	onRemoveMember: (group: BotGroupSummary, bot: BotSummary) => Promise<boolean>;
	onUpdateTitle: (group: BotGroupSummary, customTitle: string | null) => Promise<boolean>;
	world: WorldView;
}) {
	const [addTarget, setAddTarget] = useState<BotGroupSummary | null>(null);
	const [confirmGroup, setConfirmGroup] = useState<BotGroupSummary | null>(null);
	const filteredGroups = useMemo(
		() => groups.filter((group) => matchesBotGroupFilter(filter, group)),
		[filter, groups],
	);

	if (groups.length === 0) {
		return (
			<>
				<EmptyState actionLabel="New group" onAction={() => void onCreateGroup()} title="No groups in this world">
					Groups collect bots in this world for later access-control setup.
				</EmptyState>
			</>
		);
	}

	return (
		<>
			<FilterBox
				label="Filter groups"
				onChange={onFilterChange}
				placeholder="Filter by group title or bot username"
				value={filter}
			/>
			{filteredGroups.length === 0 ?
				<div className="empty compact-empty">No groups match this filter.</div>
			:	<div className="bot-world-groups">
					{filteredGroups.map((group) => (
						<BotGroupSection
							busy={busy}
							group={group}
							key={group.id}
							onAddBots={() => setAddTarget(group)}
							onDelete={() => setConfirmGroup(group)}
							onRemoveMember={(bot) => onRemoveMember(group, bot)}
							onUpdateTitle={(customTitle) => onUpdateTitle(group, customTitle)}
						/>
					))}
				</div>
			}
			<div className="bot-group-create-row">
				<button className="btn primary" disabled={busy} onClick={() => void onCreateGroup()} type="button">
					<Icon name="plus" size={14} />
					New group
				</button>
			</div>
			<AddBotsToGroupModal
				bots={bots}
				busy={busy}
				currentUserId={currentUserId}
				group={addTarget}
				onAdd={onAddMembers}
				onClose={() => setAddTarget(null)}
				world={world}
			/>
			<Confirm
				body={
					confirmGroup ?
						<>
							This will delete <b>{confirmGroup.displayTitle}</b>. The bots themselves will not be deleted.
						</>
					:	null
				}
				confirmText="Delete group"
				danger
				onClose={() => setConfirmGroup(null)}
				onConfirm={() => {
					if (confirmGroup) {
						void onDeleteGroup(confirmGroup);
					}
				}}
				open={Boolean(confirmGroup)}
				title="Delete this group?"
			/>
		</>
	);
}
function BotGroupSection({
	busy,
	group,
	onAddBots,
	onDelete,
	onRemoveMember,
	onUpdateTitle,
}: {
	busy: boolean;
	group: BotGroupSummary;
	onAddBots: () => void;
	onDelete: () => void;
	onRemoveMember: (bot: BotSummary) => Promise<boolean>;
	onUpdateTitle: (customTitle: string | null) => Promise<boolean>;
}) {
	const [editing, setEditing] = useState(false);
		const [draft, setDraft] = useState(textValue(group.customTitle));

	useEffect(() => {
			if (!editing) {
				setDraft(textValue(group.customTitle));
			}
	}, [editing, group.customTitle, group.id]);

	async function saveTitle(): Promise<void> {
		const ok = await onUpdateTitle(draft.trim() || null);
		if (ok) {
			setEditing(false);
		}
	}

	return (
		<section className="bot-world-group bot-group-section">
			<div className="bot-world-head bot-group-head">
				{editing ?
					<form
						className="bot-group-title-edit"
						onSubmit={(event) => {
							event.preventDefault();
							void saveTitle();
						}}
					>
						<input
							aria-label="Group title"
							className="input"
							disabled={busy}
							onChange={(event) => setDraft(event.target.value)}
							placeholder="Auto title from members"
							value={draft}
						/>
						<button className="btn compact primary" disabled={busy} type="submit">
							Save
						</button>
						<button className="btn compact ghost" disabled={busy} onClick={() => setEditing(false)} type="button">
							Cancel
						</button>
					</form>
				:	<span className="bot-group-title-wrap">
						<span className={`bot-group-title ${group.titleSource === "members" ? "generated" : ""}`}>
							{group.displayTitle}
						</span>
						<button
							aria-label="Edit group title"
							className="icon-btn bot-group-title-edit-trigger"
							disabled={busy}
							onClick={() => setEditing(true)}
							title="Edit group title"
							type="button"
						>
							<Icon name="edit" size={13} />
						</button>
					</span>
				}
				<span className="bot-world-head-actions">
					{group.bots.length} bot{group.bots.length === 1 ? "" : "s"}
					<button
						aria-label="Delete group"
						className="icon-btn danger"
						disabled={busy}
						onClick={onDelete}
						title="Delete group"
						type="button"
					>
						<Icon name="trash" size={13} />
					</button>
				</span>
			</div>
			<div className="bot-grid">
				{group.bots.map((bot) => (
					<GroupMemberBotCard bot={bot} key={bot.id} onRemove={() => onRemoveMember(bot)} />
				))}
				<button className="bot-group-ghost-card" disabled={busy} onClick={onAddBots} type="button">
					<Icon name="plus" size={22} />
					<span>Add bots</span>
				</button>
			</div>
		</section>
	);
}

function GroupMemberBotCard({ bot, onRemove }: { bot: BotSummary; onRemove: () => Promise<boolean> }) {
	return (
		<article className="bot-card group-member-card manageable">
			<div className="actions-overlay">
				<button className="icon-btn danger" onClick={() => void onRemove()} title="Remove from group" type="button">
					<Icon name="minusCircle" size={14} />
				</button>
			</div>
			<div className="head">
				<SpaLink
					className="bot-avatar-link"
					title={`Open ${textValue(bot.displayName)}`}
					to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}
				>
					<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} displayPixels={48} imageUrl={bot.avatarUrl} name={bot.displayName} />
				</SpaLink>
				<div className="bot-card-title">
					<SpaLink
						className="name bot-name-link"
						to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}
					>
							<TranslatableText as="span" text={bot.displayName} />
					</SpaLink>
					<div className="bot-ref-line">
						<Reference isBot kind="bot" name={bot.handle} />
					</div>
				</div>
			</div>
		</article>
	);
}

function AddBotsToGroupModal({
	bots,
	busy,
	currentUserId,
	group,
	onAdd,
	onClose,
	world,
}: {
	bots: BotSummary[];
	busy: boolean;
	currentUserId: string;
	group: BotGroupSummary | null;
	onAdd: (group: BotGroupSummary, botIds: string[]) => Promise<boolean>;
	onClose: () => void;
	world: WorldView;
}) {
	const [filter, setFilter] = useState("");
	const [selected, setSelected] = useState<Record<string, boolean>>({});

	useEffect(() => {
		setFilter("");
		setSelected({});
	}, [group?.id]);

	const memberIds = useMemo(() => new Set(group?.bots.map((bot) => bot.id) ?? []), [group]);
	const visibleBots = useMemo(
		() => sortBotsForCards(bots.filter((bot) => matchesFilter(filter, bot.displayName, bot.handle))),
		[bots, filter],
	);
	const botGroups = useMemo(() => [
		{ key: "mine", title: "My bots", bots: visibleBots.filter((bot) => bot.ownerUserId === currentUserId) },
		{ key: "other", title: "Other bots", bots: visibleBots.filter((bot) => bot.ownerUserId !== currentUserId) },
	].filter((item) => item.bots.length > 0), [currentUserId, visibleBots]);
	const selectedIds = Object.keys(selected).filter((botId) => selected[botId] && !memberIds.has(botId));

	async function save(): Promise<void> {
		if (!group || selectedIds.length === 0) {
			return;
		}
		const ok = await onAdd(group, selectedIds);
		if (ok) {
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="leftnote">
						{selectedIds.length === 0 ?
							"Pick at least one new bot."
						:	`${selectedIds.length} bot${selectedIds.length === 1 ? "" : "s"} selected.`}
					</span>
					<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
						Cancel
					</button>
					<button className="btn primary" disabled={busy || selectedIds.length === 0} onClick={() => void save()} type="button">
						<Icon name="plus" size={13} />
						Add selected bots
					</button>
				</>
			}
			onClose={onClose}
			open={Boolean(group)}
			title={group ? `Add bots to ${group.displayTitle}` : "Add bots"}
			wide
		>
			<div className="spot-search">
				<Icon name="search" size={13} />
				<input
					aria-label="Filter bots"
					className="input"
					onChange={(event) => setFilter(event.target.value)}
					placeholder="Filter by display name or username"
					value={filter}
				/>
			</div>
			{bots.length === 0 ?
				<div className="empty compact-empty">No bots exist in this world yet.</div>
			: botGroups.length === 0 ?
				<div className="empty compact-empty">No bots match this filter.</div>
			:	<div className="bot-picker-groups">
					{botGroups.map((section) => (
						<section className="bot-picker-group" key={section.key}>
							<div className="bot-world-head">
								<span>{section.title}</span>
								<span className="bot-world-head-actions">
									{section.bots.length} bot{section.bots.length === 1 ? "" : "s"}
								</span>
							</div>
							<div className="bot-pick-list">
								{section.bots.map((bot) => {
									const alreadyMember = memberIds.has(bot.id);
									const checked = alreadyMember || Boolean(selected[bot.id]);
									return (
										<label className={`bot-pick-row ${checked ? "checked" : ""} ${alreadyMember ? "disabled" : ""}`} key={bot.id}>
											<input
												checked={checked}
												className="cb"
												disabled={alreadyMember}
												onChange={(event) => setSelected((current) => ({ ...current, [bot.id]: event.target.checked }))}
												type="checkbox"
											/>
											<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} displayPixels={42} imageUrl={bot.avatarUrl} name={bot.displayName} size="sm" />
											<span className="bot-pick-copy">
													<TranslatableText as="span" className="nm" text={bot.displayName} />
												<span className="hd">u/{bot.handle}</span>
											</span>
											{alreadyMember && <span className="bot-pick-note">Already in group</span>}
										</label>
									);
								})}
							</div>
						</section>
					))}
				</div>
			}
			<div className="mini-label">World</div>
			<div className="inline-meta">
				<Reference kind="world" name={world.handle} />
			</div>
		</Modal>
	);
}
function matchesBotGroupFilter(query: string, group: BotGroupSummary): boolean {
	return matchesFilter(
		query,
		group.displayTitle,
		group.customTitle,
		...group.bots.flatMap((bot) => [bot.handle, bot.displayName]),
	);
}
