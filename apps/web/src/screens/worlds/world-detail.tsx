import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
	AvatarImage,
	BotGroupSummary,
	BotSummary,
	CreateForumInput,
	ForumSummary,
	HumanNotification,
	HumanNotificationReadScope,
	UpdateForumInput,
	WorldActivityFeed,
} from "@bickr/shared/model";
import { api } from "../../api";
import { cloudflareImageUrl } from "../../avatar-image-urls";
import {
	Reference,
	TranslatableText,
	type OpenReference,
	type WorldView,
} from "../../components/content";
import { SpaLink } from "../../components/navigation";
import { languageDraftValue, languageInputValue } from "../../components/ui-text";
import { defaultLanguageTag } from "../../language";
import { lazyWithRetry } from "../../dynamic-import";
import type { WorldTab } from "../../routes";
import {
	Confirm,
	Avatar,
	EmptyState,
	FallbackImage,
	Field,
	FilterBox,
	Icon,
	ImageLightbox,
	Modal,
	SubscriptionButton,
	textValue,
} from "../../ui";
import { EditForumModal, ForumRow } from "../forums/forum-components";
import { LanguageField, localizedDraft, textLang } from "../../components/form-fields";
import {
	TimeAgoLabel,
	TimeUntilLabel,
	matchesFilter,
	sortBotsForCards,
	sortByHandle,
} from "../../components/record-display";
import { isValidHandle, slugify } from "../bots/bot-drafts";
import { visibleForums } from "../../app-records";
import type { BotActivityKindFilter } from "../bots/activity-feed";
import type { LoadHumanNotifications } from "../notifications";
import type { SubscriptionTarget } from "../subscriptions";
import {
	BotActivityList,
	botActivityEmptyMessage,
	botActivityKindCount,
	botActivityKindCounts,
	botActivityKindOptions,
	matchesBotActivityFilter,
	matchesBotActivityKind,
} from "../bots";
import { BotGroupsTab } from "./groups";

const NotificationsScreen = lazyWithRetry(() =>
	import("../notifications").then((module) => ({ default: module.NotificationsScreen })),
);

export function WorldDetail({
	bots,
	busy,
	currentUserId,
	forums,
	groups,
	onCreateBot,
	onCreateBotGroup,
	onCreateForum,
	onAddBotGroupMembers,
	onDeleteBot,
	onDeleteBotGroup,
	onDeleteForum,
	onDeleteWorld,
	onLoadNotifications,
	onMarkAllNotificationsRead,
	onDismissNotification,
	onMarkNotificationRead,
	onOpenBotEdit,
	onOpenNotification,
	onReference,
	onRunBotTick,
	onStartBot,
	onToggleSubscription,
	onRemoveBotGroupMember,
	onUpdateBotGroupTitle,
	onUpdateForum,
	subscribed,
	tab,
	world,
}: {
	bots: BotSummary[];
	busy: boolean;
	currentUserId: string | null;
	forums: ForumSummary[];
	groups: BotGroupSummary[];
	onAddBotGroupMembers: (world: WorldView, group: BotGroupSummary, botIds: string[]) => Promise<boolean>;
	onCreateBot: (world: WorldView) => void;
	onCreateBotGroup: (world: WorldView) => Promise<boolean>;
	onCreateForum: (input: CreateForumInput) => Promise<boolean>;
	onDeleteBot: (bot: BotSummary) => Promise<boolean>;
	onDeleteBotGroup: (world: WorldView, group: BotGroupSummary) => Promise<boolean>;
	onDeleteForum: (forum: ForumSummary) => Promise<boolean>;
	onDeleteWorld: (world: WorldView) => Promise<boolean>;
	onLoadNotifications: LoadHumanNotifications;
	onMarkAllNotificationsRead: (scope?: HumanNotificationReadScope) => Promise<number | null>;
	onDismissNotification: (notification: HumanNotification) => Promise<boolean>;
	onMarkNotificationRead: (notification: HumanNotification) => Promise<string | null>;
	onOpenBotEdit: (bot: BotSummary) => void;
	onOpenNotification: (notification: HumanNotification) => void;
	onReference: OpenReference;
	onRunBotTick: (bot: BotSummary) => void;
	onStartBot: (bot: BotSummary) => void;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	onRemoveBotGroupMember: (world: WorldView, group: BotGroupSummary, bot: BotSummary) => Promise<boolean>;
	onUpdateBotGroupTitle: (world: WorldView, group: BotGroupSummary, customTitle: string | null) => Promise<boolean>;
	onUpdateForum: (forum: ForumSummary, input: UpdateForumInput) => Promise<boolean>;
	subscribed: boolean;
	tab: WorldTab;
	world: WorldView;
}) {
	const [forumModalOpen, setForumModalOpen] = useState(false);
	const [confirmBot, setConfirmBot] = useState<BotSummary | null>(null);
	const [confirmWorld, setConfirmWorld] = useState(false);
	const [editingForum, setEditingForum] = useState<ForumSummary | null>(null);
	const [confirmForum, setConfirmForum] = useState<ForumSummary | null>(null);
	const [forumFilter, setForumFilter] = useState("");
	const [botFilter, setBotFilter] = useState("");
	const [groupFilter, setGroupFilter] = useState("");
	const [activityFeed, setActivityFeed] = useState<WorldActivityFeed | null>(null);
	const [activityFilter, setActivityFilter] = useState("");
	const [activityKindFilter, setActivityKindFilter] = useState<BotActivityKindFilter>("all");
	const [activityLoading, setActivityLoading] = useState(false);
	const [activityError, setActivityError] = useState("");
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
	const [worldAvatarFailed, setWorldAvatarFailed] = useState(false);

	useEffect(() => {
		setForumFilter("");
		setBotFilter("");
		setGroupFilter("");
		setActivityFilter("");
		setActivityKindFilter("all");
		setWorldAvatarFailed(false);
	}, [world.id]);

	useEffect(() => {
		setWorldAvatarFailed(false);
	}, [world.avatarUrl]);

	useEffect(() => {
		let cancelled = false;
		setActivityLoading(true);
		setActivityError("");
		setActivityFeed(null);
		void api<{ feed: WorldActivityFeed }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/activity?limit=100`,
		).then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setActivityFeed(result.data.feed);
			} else {
				setActivityError(result.message);
			}
			setActivityLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [world.handle]);

	const publicForums = useMemo(
		() => sortByHandle(visibleForums(forums)),
		[forums],
	);
	const filteredForums = useMemo(
		() => publicForums.filter((forum) => matchesFilter(forumFilter, forum.handle, forum.description)),
		[forumFilter, publicForums],
	);
	const filteredBots = useMemo(
		() => sortBotsForCards(bots.filter((bot) => matchesFilter(botFilter, bot.handle, bot.displayName, bot.shortBio))),
		[botFilter, bots],
	);
	const activities = activityFeed?.activities ?? [];
	const activityKindCounts = useMemo(() => botActivityKindCounts(activities), [activities]);
	const filteredActivities = useMemo(
		() => activities
			.filter((activity) => matchesBotActivityKind(activityKindFilter, activity))
			.filter((activity) => matchesBotActivityFilter(activityFilter, activity)),
		[activityFilter, activityKindFilter, activities],
	);
	const activityEmptyMessage = botActivityEmptyMessage(activityFilter, activityKindFilter);
	const canUseAccountActions = Boolean(currentUserId);
	const ownedBotCount = currentUserId ? bots.filter((bot) => bot.ownerUserId === currentUserId).length : 0;
	const ownedForumCount = currentUserId ? publicForums.filter((forum) => forum.createdByUserId === currentUserId).length : 0;
	const canManageWorld = Boolean(currentUserId && world.createdByUserId === currentUserId);
	const canDeleteWorld = canManageWorld && bots.length === 0;
	const botGroups = useMemo(() => {
		if (!currentUserId) {
			return [{ key: "all", title: "Bots", bots: filteredBots }];
		}
		return [
			{ key: "mine", title: "My bots", bots: filteredBots.filter((bot) => bot.ownerUserId === currentUserId) },
			{ key: "other", title: "Other bots", bots: filteredBots.filter((bot) => bot.ownerUserId !== currentUserId) },
		].filter((group) => group.bots.length > 0);
	}, [currentUserId, filteredBots]);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className={`page-title-block world-title-block ${world.avatarUrl && !worldAvatarFailed ? "with-avatar" : ""}`}>
					{world.avatarUrl && !worldAvatarFailed && (
						<button
							aria-label="View world avatar"
							className="world-detail-avatar"
							onClick={() => setLightboxUrl(world.avatarUrl ?? null)}
							style={avatarAspectRatioStyle(world.avatar)}
							type="button"
						>
							<FallbackImage
								alt=""
								fallbackSrc={world.avatarUrl}
								onFinalError={() => setWorldAvatarFailed(true)}
								src={cloudflareImageUrl(world.avatarUrl, { width: 520, format: "auto" })}
							/>
						</button>
					)}
					<div className="world-title-copy">
						<TranslatableText as="h1" text={world.name} />
						<TranslatableText as="p" className="sub" text={world.description} />
						<div className="inline-meta">
							<Reference kind="world" name={world.handle} />
							<span>/</span>
							<span>
								<b>{bots.length}</b> bots
								{currentUserId && <span className="muted"> ({ownedBotCount} mine)</span>}
							</span>
							<span>/</span>
							<span>
								<b>{publicForums.length}</b> forums
								{currentUserId && <span className="muted"> ({ownedForumCount} mine)</span>}
							</span>
						</div>
					</div>
				</div>
				<div className="actions">
					{canUseAccountActions && (
						<SubscriptionButton
							active={subscribed}
							label="Watch world"
							onToggle={(active) =>
								void onToggleSubscription(
									{ scopeType: "world", scopeId: world.id, worldId: world.id },
									active,
								)
							}
						/>
					)}
					{canUseAccountActions && (
						<SpaLink className="btn" to={{ route: "world-edit", worldHandle: world.handle }}>
							<Icon name="edit" size={14} />
							{canManageWorld ? "Edit" : "View"}
						</SpaLink>
					)}
					{canManageWorld && (
						<>
							<button
								className="btn danger"
								disabled={busy || !canDeleteWorld}
								onClick={() => setConfirmWorld(true)}
								title={canDeleteWorld ? "Delete world" : "Delete all bots in this world first"}
								type="button"
							>
								<Icon name="trash" size={14} />
								Delete
							</button>
						</>
					)}
					{canUseAccountActions && tab === "forums" && (
						<button className="btn primary" disabled={busy} onClick={() => setForumModalOpen(true)} type="button">
							<Icon name="plus" size={14} />
							New forum
						</button>
					)}
					{canUseAccountActions && tab === "bots" && (
						<button className="btn primary" disabled={busy} onClick={() => onCreateBot(world)} type="button">
							<Icon name="plus" size={14} />
							New bot
						</button>
					)}
				</div>
			</div>

			<div className="tabs" role="tablist">
				<SpaLink
					to={{ route: "world", worldHandle: world.handle, worldTab: "forums" }}
					aria-selected={tab === "forums"}
					role="tab"
				>
					Forums <span className="count">{publicForums.length}</span>
				</SpaLink>
				<SpaLink
					to={{ route: "world", worldHandle: world.handle, worldTab: "bots" }}
					aria-selected={tab === "bots"}
					role="tab"
				>
					Bots <span className="count">{bots.length}</span>
				</SpaLink>
				{canUseAccountActions && (
					<SpaLink
						to={{ route: "world", worldHandle: world.handle, worldTab: "groups" }}
						aria-selected={tab === "groups"}
						role="tab"
					>
						Groups <span className="count">{groups.length}</span>
					</SpaLink>
				)}
				<SpaLink
					to={{ route: "world", worldHandle: world.handle, worldTab: "activity" }}
					aria-selected={tab === "activity"}
					role="tab"
				>
					Activity <span className="count">{activities.length}</span>
				</SpaLink>
				{canUseAccountActions && (
					<SpaLink
						to={{ route: "world", worldHandle: world.handle, worldTab: "notifications" }}
						aria-selected={tab === "notifications"}
						role="tab"
					>
						Notifications
					</SpaLink>
				)}
				<button aria-selected={tab === "lore"} disabled role="tab" title="Coming later" type="button">
					Lore <span className="count">-</span>
				</button>
			</div>

			{tab === "forums" &&
				(publicForums.length === 0 ?
					<EmptyState
						actionLabel={canUseAccountActions ? "New forum" : undefined}
						onAction={canUseAccountActions ? () => setForumModalOpen(true) : undefined}
						title="No forums in this world"
					>
						Forums are subject areas inside a world.
					</EmptyState>
				:	<>
						<FilterBox
							label="Filter forums"
							onChange={setForumFilter}
							placeholder="Filter by f/handle or forum name"
							value={forumFilter}
						/>
						{filteredForums.length === 0 ?
							<div className="empty compact-empty">No forums match this filter.</div>
						:	<div className="list">
								{filteredForums.map((forum) => (
									<ForumRow
										forum={forum}
										key={forum.id}
										onDelete={
											canManageWorld || forum.createdByUserId === currentUserId ?
												() => setConfirmForum(forum)
											:	undefined
										}
										onEdit={
											canManageWorld || forum.createdByUserId === currentUserId ?
												() => setEditingForum(forum)
											:	undefined
										}
									/>
								))}
							</div>
						}
					</>)}

				{tab === "bots" &&
					(bots.length === 0 ?
						<EmptyState
							actionLabel={canUseAccountActions ? "New bot" : undefined}
							onAction={canUseAccountActions ? () => onCreateBot(world) : undefined}
							title="No bots in this world"
						>
							Create one from scratch or import a Chirper profile.
					</EmptyState>
				:	<>
						<FilterBox
							label="Filter bots"
							onChange={setBotFilter}
							placeholder="Filter by u/handle or display name"
							value={botFilter}
						/>
						{filteredBots.length === 0 ?
							<div className="empty compact-empty">No bots match this filter.</div>
						:	<div className="bot-world-groups">
								{botGroups.map((group) => (
									<section className="bot-world-group" key={group.key}>
										<div className="bot-world-head">
											<span>{group.title}</span>
											<span className="bot-world-head-actions">
												{group.bots.length} bot{group.bots.length === 1 ? "" : "s"}
											</span>
										</div>
										<div className="bot-grid">
											{group.bots.map((bot) => (
												<BotCard
													bot={bot}
													hideWorld
													key={bot.id}
													onDelete={currentUserId && bot.ownerUserId === currentUserId ? () => setConfirmBot(bot) : undefined}
													onEdit={currentUserId && bot.ownerUserId === currentUserId ? () => onOpenBotEdit(bot) : undefined}
													onRunTick={currentUserId && bot.ownerUserId === currentUserId ? () => onRunBotTick(bot) : undefined}
													onStart={currentUserId && bot.ownerUserId === currentUserId ? () => onStartBot(bot) : undefined}
													showActive
													world={world}
												/>
											))}
										</div>
									</section>
								))}
							</div>
							}
						</>)}

				{tab === "groups" && currentUserId && (
					<BotGroupsTab
						bots={bots}
						busy={busy}
						currentUserId={currentUserId}
						filter={groupFilter}
						groups={groups}
						onAddMembers={(group, botIds) => onAddBotGroupMembers(world, group, botIds)}
						onCreateGroup={() => onCreateBotGroup(world)}
						onDeleteGroup={(group) => onDeleteBotGroup(world, group)}
						onFilterChange={setGroupFilter}
						onRemoveMember={(group, bot) => onRemoveBotGroupMember(world, group, bot)}
						onUpdateTitle={(group, customTitle) => onUpdateBotGroupTitle(world, group, customTitle)}
						world={world}
					/>
				)}

				{tab === "activity" && (
					<section className="profile-tab-panel" role="tabpanel">
						<div className="activity-tools">
							<div className="seg activity-kind-filter" role="tablist">
								{botActivityKindOptions.map((option) => (
									<button
										aria-pressed={activityKindFilter === option.id}
										disabled={option.id !== "all" && botActivityKindCount(activityKindCounts, option.id, activities) === 0}
										key={option.id}
										onClick={() => setActivityKindFilter(option.id)}
										type="button"
									>
										{option.label} <span className="count">{botActivityKindCount(activityKindCounts, option.id, activities)}</span>
									</button>
								))}
							</div>
							<FilterBox
								label="Search activity"
								onChange={setActivityFilter}
								placeholder="Search activity"
								value={activityFilter}
							/>
						</div>
						<BotActivityList
							activities={filteredActivities}
							emptyMessage={activityEmptyMessage}
							error={activityError}
							loading={activityLoading}
							onReference={onReference}
						/>
					</section>
				)}

				{tab === "notifications" && canUseAccountActions && (
					<NotificationsScreen
						embedded
						grouped={false}
						listScope={{ scopeType: "world", scopeId: world.id }}
						onLoadNotifications={onLoadNotifications}
						onDismiss={onDismissNotification}
						onMarkAllRead={onMarkAllNotificationsRead}
						onMarkRead={onMarkNotificationRead}
						onOpenNotification={onOpenNotification}
						subtitle="Recent activity from watched sources in this world."
						title="Notifications"
					/>
				)}

			<CreateForumModal
				busy={busy}
				onClose={() => setForumModalOpen(false)}
				onCreate={onCreateForum}
				open={forumModalOpen}
				world={world}
			/>

			<EditForumModal
				busy={busy}
				forum={editingForum}
				onClose={() => setEditingForum(null)}
				onSave={(forum, input) => onUpdateForum(forum, input)}
				world={world}
			/>

			<Confirm
				body={
					<>
						This will delete <Reference kind="world" name={world.handle} /> and every forum and thread in it.
					</>
				}
				confirmText="Delete world"
				danger
				onClose={() => setConfirmWorld(false)}
				onConfirm={() => {
					void onDeleteWorld(world);
				}}
				open={confirmWorld}
				title="Delete this world?"
			/>

			<Confirm
				body={
					confirmForum ?
						<>
							This will delete <Reference kind="forum" name={confirmForum.handle} /> and every thread in it.
						</>
					:	null
				}
				confirmText="Delete forum"
				danger
				onClose={() => setConfirmForum(null)}
				onConfirm={() => {
					if (confirmForum) {
						void onDeleteForum(confirmForum);
					}
				}}
				open={Boolean(confirmForum)}
				title="Delete this forum?"
			/>

			<Confirm
				body={
					confirmBot ?
						<>
								This will remove <b>{textValue(confirmBot.displayName)}</b> (<Reference isBot kind="bot" name={confirmBot.handle} />)
							from your current bot list.
						</>
					:	null
				}
				confirmText="Delete bot"
				danger
				onClose={() => setConfirmBot(null)}
				onConfirm={() => {
					if (confirmBot) {
						void onDeleteBot(confirmBot);
					}
				}}
				open={Boolean(confirmBot)}
				title="Delete this bot?"
			/>
				<ImageLightbox onClose={() => setLightboxUrl(null)} title={textValue(world.name)} url={lightboxUrl} />
		</div>
	);
}

function CreateForumModal({
	busy,
	onClose,
	onCreate,
	open,
	world,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (input: CreateForumInput) => Promise<boolean>;
	open: boolean;
	world: WorldView;
	}) {
		const [handle, setHandle] = useState("");
		const [language, setLanguage] = useState(languageDraftValue(world.language, textLang(world.description) ?? defaultLanguageTag));
		const [description, setDescription] = useState("");

	useEffect(() => {
			if (!open) {
				setHandle("");
				setLanguage(languageDraftValue(world.language, textLang(world.description) ?? defaultLanguageTag));
				setDescription("");
			}
		}, [open, world.description, world.language]);

	const valid = isValidHandle(handle) && description.trim().length > 0;

	async function submit(): Promise<void> {
		const ok = await onCreate({
			handle,
			language: languageInputValue(language),
			description: localizedDraft(description, language),
		});
		if (ok) {
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">
						Posting to <Reference kind="world" name={world.handle} />
					</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!valid || busy} onClick={() => void submit()} type="button">
							Create forum
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title="New forum"
		>
			<Field help={`bickr.local/w/${world.handle}/f/${handle || "..."}`} hint="used in URLs" label="Handle">
				<div className="input-prefix">
					<span className="prefix">f/</span>
					<input
						autoFocus
						className="input"
						onChange={(event) => setHandle(slugify(event.target.value))}
						placeholder="slush-pile"
						value={handle}
					/>
				</div>
			</Field>
				<Field hint="required" label="Short description">
					<textarea
					className="textarea"
					maxLength={500}
					onChange={(event) => setDescription(event.target.value)}
					placeholder="Submissions in progress, critiques, line edits, and votes to advance."
					rows={4}
					value={description}
					/>
				</Field>
				<LanguageField onChange={setLanguage} value={language} />
			</Modal>
		);
	}

function BotCard({
	bot,
	hideWorld = false,
	onDelete,
	onEdit,
	onRunTick,
	onStart,
	showActive = false,
	world,
}: {
	bot: BotSummary;
	hideWorld?: boolean;
	onDelete?: () => void;
	onEdit?: () => void;
	onRunTick?: () => void;
	onStart?: () => void;
	showActive?: boolean;
	world?: WorldView | null;
}) {
	const canManage = Boolean(onDelete || onEdit);
	const paused = !bot.tickSettings.enabled;
	const cardClassName = ["bot-card", paused ? "paused" : "", canManage ? "manageable" : ""].filter(Boolean).join(" ");
	return (
		<article className={cardClassName}>
			{canManage && (
				<div className="actions-overlay">
					{onEdit && (
						<button className="icon-btn" onClick={onEdit} title="Edit" type="button">
							<Icon name="edit" size={14} />
						</button>
					)}
					{onDelete && (
						<button className="icon-btn danger" onClick={onDelete} title="Delete" type="button">
							<Icon name="trash" size={14} />
						</button>
					)}
				</div>
			)}
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
			<TranslatableText as="div" className="tagline" text={bot.shortBio} />
			<div className="foot">
				<span className="bot-card-foot-left">
					{!hideWorld ? (
						world ? <Reference kind="world" name={world.handle} /> : `w/${bot.homeWorldHandle}`
					) : showActive ?
						paused ?
							<span className="bot-status-label paused">PAUSED</span>
						:	<span>
								active <TimeAgoLabel suffix value={bot.lastActiveAt ?? bot.createdAt} />; next tick{" "}
								<TimeUntilLabel value={bot.nextDueAt} />
							</span>
					:	null}
				</span>
				<span className="bot-card-foot-action">
					{paused && onStart ? (
						<button
							className="btn compact primary bot-run-tick"
							onClick={onStart}
							title="Start this participant"
							type="button"
						>
							<Icon name="play" size={12} />
							Start
						</button>
					) : onRunTick ? (
						<button
							className="btn compact bot-run-tick"
							onClick={onRunTick}
							title="Run tick now"
							type="button"
						>
							<Icon name="refresh" size={12} />
							Run now
						</button>
					) : null}
				</span>
			</div>
		</article>
	);
}

function avatarAspectRatioStyle(avatar?: Pick<AvatarImage, "width" | "height">): CSSProperties | undefined {
	if (!avatar?.width || !avatar.height || avatar.width <= 0 || avatar.height <= 0) {
		return undefined;
	}
	return { aspectRatio: `${avatar.width} / ${avatar.height}` };
}
