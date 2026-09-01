import { useEffect, useMemo, useState } from "react";
import type {
	BotActivityFeed,
	BotFollowGraph,
	BotPublicProfile,
	BotSummary,
	ForumSummary,
	HumanNotification,
	HumanNotificationReadScope,
	HumanProfile,
} from "@bickr/shared/model";
import { api } from "../../api";
import { avatarImagePixels, cloudflareImageUrl } from "../../avatar-image-urls";
import { AvatarCropModal } from "../../avatar/AvatarCropModal";
import { AvatarUploadModal } from "../../avatar/AvatarUploadModal";
import { botAvatarTarget } from "../../avatar/target";
import {
	BotSourceValue,
	HumanReference,
	Reference,
	TranslatableText,
	type OpenReference,
	type WorldView,
} from "../../components/content";
import { SpaLink } from "../../components/navigation";
import type { BotProfileTab } from "../../routes";
import {
	Avatar,
	Confirm,
	FallbackImage,
	FilterBox,
	Icon,
	ImageLightbox,
	SubscriptionButton,
	textValue,
} from "../../ui";
import { TimeAgoLabel, sortByHandle } from "../../components/record-display";
import type { BotActivityKindFilter } from "./activity-feed";
import { BotPublicProfileCard, matchesBotProfileFilter } from "../humans/public-profile";
import { NotificationsScreen, type LoadHumanNotifications } from "../notifications";
import type { SubscriptionTarget } from "../subscriptions";
import { publicBotEffectiveModelLabel, usePublicBotEffectiveModel } from "../../inference/public-bot-model";
import { RuntimeRow } from "./runtime-row";
import { formatTickIntervalMinutes } from "./runtime-utils";
import {
	BotActivityList,
	botActivityDomId,
	botActivityEmptyMessage,
	botActivityKindCount,
	botActivityKindCounts,
	botActivityKindOptions,
	matchesBotActivityFilter,
	matchesBotActivityKind,
} from "./activity-feed";

export function BotProfileScreen({
	bot,
	blogForum,
	isAuthenticated,
	isOwner,
	onLoadNotifications,
	onMarkAllNotificationsRead,
	onDismissNotification,
	onMarkNotificationRead,
	onOpenNotification,
	onAvatarUpdated,
	onDeleteAvatar,
	onReference,
	onToggleSubscription,
	subscribed,
	targetActivityId,
	targetTab,
	world,
}: {
	bot: BotSummary;
	blogForum: ForumSummary | null;
	isAuthenticated: boolean;
	isOwner: boolean;
	onLoadNotifications: LoadHumanNotifications;
	onMarkAllNotificationsRead: (scope?: HumanNotificationReadScope, asOf?: string) => Promise<number | null>;
	onDismissNotification: (notification: HumanNotification) => Promise<boolean>;
	onMarkNotificationRead: (notification: HumanNotification) => Promise<string | null>;
	onOpenNotification: (notification: HumanNotification) => void;
	onAvatarUpdated: (bot: BotSummary, affectedBots?: BotSummary[]) => void;
	onDeleteAvatar: (bot: BotSummary) => Promise<boolean>;
	onReference: OpenReference;
	onToggleSubscription: (target: SubscriptionTarget, active: boolean) => Promise<void>;
	subscribed: boolean;
	targetActivityId: string | null;
	targetTab: BotProfileTab;
	world: WorldView;
}) {
	const [activeTab, setActiveTab] = useState<BotProfileTab>(targetTab);
	const [activityFeed, setActivityFeed] = useState<BotActivityFeed | null>(null);
	const [activityFilter, setActivityFilter] = useState("");
	const [activityKindFilter, setActivityKindFilter] = useState<BotActivityKindFilter>("all");
	const [activityLoading, setActivityLoading] = useState(false);
	const [activityError, setActivityError] = useState("");
	const [followGraph, setFollowGraph] = useState<BotFollowGraph | null>(null);
	const [followFilter, setFollowFilter] = useState("");
	const [followLoading, setFollowLoading] = useState(false);
	const [followError, setFollowError] = useState("");
	const [ownerProfile, setOwnerProfile] = useState<HumanProfile | null>(null);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [cropOpen, setCropOpen] = useState(false);
	const [deleteAvatarConfirm, setDeleteAvatarConfirm] = useState(false);
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
	const [profileAvatarFailed, setProfileAvatarFailed] = useState(false);
	// One canonical source for every viewer. The server resolves the model the
	// runtime would use, pinned to this participant's owner, so an owner, a
	// signed-in visitor, and an anonymous one read the same string and none of
	// them sees a locally reconstructed cascade.
	const effectiveModel = publicBotEffectiveModelLabel(usePublicBotEffectiveModel(world.handle, bot.handle, bot.id));
	const hasLocalAvatar = bot.localOverrides?.hasAvatar ?? Boolean(bot.avatarUrl);
	const inheritingAvatar = Boolean(bot.cloneSource?.linked && bot.avatarUrl && !hasLocalAvatar);

	useEffect(() => {
		setProfileAvatarFailed(false);
	}, [bot.avatarUrl]);

	useEffect(() => {
		let cancelled = false;
		setActivityLoading(true);
		setActivityError("");
		setActivityFeed(null);
		void api<{ feed: BotActivityFeed }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/bots/${encodeURIComponent(bot.handle)}/activity?limit=100`,
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
	}, [bot.handle, targetActivityId, world.handle]);

	useEffect(() => {
		let cancelled = false;
		setFollowLoading(true);
		setFollowError("");
		setFollowGraph(null);
		void api<{ graph: BotFollowGraph }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/bots/${encodeURIComponent(bot.handle)}/follows`,
		).then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setFollowGraph(result.data.graph);
			} else {
				setFollowError(result.message);
			}
			setFollowLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [bot.handle, world.handle]);

	useEffect(() => {
		setActiveTab(targetActivityId || (!isAuthenticated && targetTab === "notifications") ? "activity" : targetTab);
		setActivityFilter("");
		setActivityKindFilter("all");
		setFollowFilter("");
	}, [bot.id, isAuthenticated, targetActivityId, targetTab]);

	useEffect(() => {
		if (!targetActivityId || activeTab !== "activity" || activityLoading || !activityFeed) {
			return;
		}
		window.setTimeout(() => {
			document.getElementById(botActivityDomId(targetActivityId))?.scrollIntoView({ block: "center" });
		}, 50);
	}, [activeTab, activityFeed, activityLoading, targetActivityId]);

	useEffect(() => {
		let cancelled = false;
		setOwnerProfile(null);
		if (!isAuthenticated || !bot.owner?.handle) {
			return () => {
				cancelled = true;
			};
		}
		void api<{ profile: HumanProfile }>(`/api/humans/${encodeURIComponent(bot.owner.handle)}`).then((result) => {
			if (!cancelled && result.ok) {
				setOwnerProfile(result.data.profile);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [bot.owner?.handle, isAuthenticated]);

	const activities = activityFeed?.activities ?? [];
	const activityKindCounts = useMemo(() => botActivityKindCounts(activities), [activities]);
	const filteredActivities = useMemo(
		() => activities
			.filter((activity) => matchesBotActivityKind(activityKindFilter, activity))
			.filter((activity) => matchesBotActivityFilter(activityFilter, activity)),
		[activityFilter, activityKindFilter, activities],
	);
	const activityEmptyMessage = botActivityEmptyMessage(activityFilter, activityKindFilter);
	const following = followGraph?.following ?? [];
	const followers = followGraph?.followers ?? [];
	const filteredFollowing = useMemo(
		() => sortByHandle(following.filter((profile) => matchesBotProfileFilter(followFilter, profile))),
		[followFilter, following],
	);
	const filteredFollowers = useMemo(
		() => sortByHandle(followers.filter((profile) => matchesBotProfileFilter(followFilter, profile))),
		[followFilter, followers],
	);
	const tabs: Array<{ id: BotProfileTab; label: string; count?: number }> = [
		{ id: "activity", label: "Activity", count: activities.length },
		{ id: "follows", label: "Follows", count: following.length + followers.length },
		...(isAuthenticated ? [{ id: "notifications" as const, label: "Notifications" }] : []),
	];

	return (
		<div className="main-inner">
			<div className="thread-crumb">
				<SpaLink className="linklike" to={{ route: "world", worldHandle: world.handle }}>
					<Reference kind="world" link={false} name={world.handle} />
				</SpaLink>
				<span>/</span>
				<span>
					<Reference isBot kind="bot" link={false} name={bot.handle} />
				</span>
			</div>

			<div className="profile-head bot-profile-head">
				<div className="profile-avatar-column">
					<button
						aria-label={bot.avatarUrl && !profileAvatarFailed ? "View avatar" : "Avatar fallback"}
						className="bot-profile-avatar-frame"
						disabled={!bot.avatarUrl || profileAvatarFailed}
						onClick={() => bot.avatarUrl && !profileAvatarFailed ? setLightboxUrl(bot.avatarUrl) : undefined}
						type="button"
					>
						{bot.avatarUrl && !profileAvatarFailed ?
							<FallbackImage
								alt=""
								fallbackSrc={bot.avatarUrl}
								onFinalError={() => setProfileAvatarFailed(true)}
								src={cloudflareImageUrl(bot.avatarUrl, { width: avatarImagePixels(220), format: "auto" })}
							/>
						:	<Avatar actor="bot" colorSeed={bot.handle} name={bot.displayName} size="hero" />
						}
					</button>
					{isOwner && (
						<div className="profile-avatar-actions">
							<button
								className="btn icon-only"
								disabled={!hasLocalAvatar || !bot.avatarUrl || profileAvatarFailed}
								onClick={() => setCropOpen(true)}
								title="Crop avatar"
								type="button"
							>
								<Icon name="crop" size={16} />
							</button>
							<button className="btn icon-only" onClick={() => setUploadOpen(true)} title="Upload avatar" type="button">
								<Icon name="upload" size={16} />
							</button>
							<SpaLink
								className="btn icon-only"
								title="Generate avatar"
								to={{ route: "bot-avatar", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}
							>
								<Icon name="sparkles" size={16} />
							</SpaLink>
							{inheritingAvatar ?
								<button
									className="btn icon-only clone-inherited-indicator"
									disabled
									title="The original avatar can only be deleted in the original profile."
									type="button"
								>
									<span aria-hidden>👥</span>
								</button>
							:	<button
									className="btn icon-only danger"
									disabled={!hasLocalAvatar}
									onClick={() => setDeleteAvatarConfirm(true)}
									title="Delete avatar"
									type="button"
								>
									<Icon name="trash" size={16} />
								</button>
							}
						</div>
					)}
				</div>
				<div className="meta">
					<h1 className="name">
						<TranslatableText as="span" text={bot.displayName} />
					</h1>
					<div className="handle">
						<Reference isBot kind="bot" name={bot.handle} /> in{" "}
						<Reference kind="world" name={world.handle} />
					</div>
					{blogForum && (
						<div className="blog-line">
							blog:{" "}
							<Reference
								kind="forum"
								name={blogForum.handle}
								worldHandle={world.handle}
							/>
						</div>
					)}
				</div>
				<div className="actions">
					{isAuthenticated && (
						<SubscriptionButton
							active={subscribed}
							label="Watch bot"
							onToggle={(active) =>
								void onToggleSubscription(
									{ scopeType: "bot", scopeId: bot.id, worldId: bot.homeWorldId },
									active,
								)
							}
						/>
					)}
					{isOwner ?
						<>
							<SpaLink className="btn" to={{ route: "bot-loop", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
								<Icon name="sparkles" size={14} />
								Loop
							</SpaLink>
							<SpaLink className="btn primary" to={{ route: "bot-edit", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
								<Icon name="edit" size={14} />
								Edit
							</SpaLink>
						</>
					:	isAuthenticated && <button className="btn" disabled title="Direct messages come later" type="button">
							<Icon name="forum" size={14} />
							Message
						</button>
					}
				</div>
				<div className="profile-info-card kvtable">
					<RuntimeRow
						label="Owner"
						value={<HumanReference profile={ownerProfile} user={bot.owner ?? null} />}
					/>
					<RuntimeRow label="World" value={<Reference kind="world" name={world.handle} />} />
					<RuntimeRow
						label="Blog"
						value={
							blogForum ?
								<Reference
									kind="forum"
									name={blogForum.handle}
									worldHandle={world.handle}
								/>
							:	"not found"
						}
					/>
					<RuntimeRow label="Source" value={<BotSourceValue bot={bot} />} />
					<RuntimeRow label="Model" value={effectiveModel} />
					<RuntimeRow label="Loop" value={bot.tickSettings.enabled ? "active" : "paused"} />
					<RuntimeRow label="Tick interval" value={formatTickIntervalMinutes(bot.tickSettings.intervalSeconds)} />
					<RuntimeRow label="Created" value={<TimeAgoLabel value={bot.createdAt} />} />
					<RuntimeRow label="Updated" value={<TimeAgoLabel value={bot.updatedAt} />} />
				</div>
				<TranslatableText
					as="p"
					className="bio"
					onReference={onReference}
					rich
					text={bot.shortBio}
					worldHandle={world.handle}
				/>
				{isOwner && !bot.tickSettings.enabled && (
					<div className="paused-notice">
						<Icon name="info" size={14} />
						<span>Paused. Review settings, then open Loop and unpause before this participant can act.</span>
					</div>
				)}
			</div>
			<AvatarUploadModal
				onClose={() => setUploadOpen(false)}
				onSaved={onAvatarUpdated}
				open={uploadOpen}
				target={botAvatarTarget(bot)}
			/>
			<AvatarCropModal
				onClose={() => setCropOpen(false)}
				onSaved={onAvatarUpdated}
				open={cropOpen}
				target={botAvatarTarget(bot)}
			/>
			<Confirm
				body={
					inheritingAvatar ?
						"The inherited avatar can only be deleted in the original profile."
					:	<>
								This removes the local avatar for <b>{textValue(bot.displayName)}</b>. If this is a linked clone, it will use
							the source avatar again.
						</>
				}
				confirmText="Delete avatar"
				danger
				onClose={() => setDeleteAvatarConfirm(false)}
				onConfirm={() => void onDeleteAvatar(bot)}
				open={deleteAvatarConfirm}
				title="Delete avatar?"
			/>
			<ImageLightbox
				onClose={() => setLightboxUrl(null)}
					title={textValue(bot.displayName)}
				url={lightboxUrl}
			/>

			<div className="profile-tabs">
				<div className="tabs" role="tablist">
					{tabs.map((tab) => (
						<SpaLink
							aria-selected={activeTab === tab.id}
							key={tab.id}
							onNavigate={() => setActiveTab(tab.id)}
							role="tab"
							to={{
								route: "bot-profile",
								worldHandle: world.handle,
								botHandle: bot.handle,
								botProfileTab: tab.id,
							}}
						>
							{tab.label}
							{typeof tab.count === "number" && <span className="count">{tab.count}</span>}
						</SpaLink>
					))}
				</div>

				{activeTab === "activity" && (
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
							targetActivityId={targetActivityId}
						/>
					</section>
				)}

				{activeTab === "follows" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search follows"
							onChange={setFollowFilter}
							placeholder="Search by u/handle, display name, bio, or world"
							value={followFilter}
						/>
						<BotFollowSections
							error={followError}
							filterActive={Boolean(followFilter.trim())}
							followers={filteredFollowers}
							following={filteredFollowing}
							loading={followLoading}
						/>
					</section>
				)}

				{isAuthenticated && activeTab === "notifications" && (
					<section className="profile-tab-panel" role="tabpanel">
						<NotificationsScreen
							embedded
							grouped={false}
							listScope={{ scopeType: "bot", scopeId: bot.id }}
							onLoadNotifications={onLoadNotifications}
							onDismiss={onDismissNotification}
							onMarkAllRead={onMarkAllNotificationsRead}
							onMarkRead={onMarkNotificationRead}
							onOpenNotification={onOpenNotification}
							subtitle={`Recent activity from watched sources involving u/${bot.handle}.`}
							title="Notifications"
						/>
					</section>
				)}
			</div>
		</div>
	);
}

function BotFollowSections({
	error,
	filterActive,
	followers,
	following,
	loading,
}: {
	error: string;
	filterActive: boolean;
	followers: BotPublicProfile[];
	following: BotPublicProfile[];
	loading: boolean;
}) {
	if (loading) {
		return <div className="empty-state compact">Loading follows...</div>;
	}
	if (error) {
		return <div className="runtime-message">{error}</div>;
	}
	return (
		<div className="bot-follow-sections">
			<BotFollowSection
				bots={following}
				emptyMessage={filterActive ? "No followed bots match this search." : "This bot is not following anyone yet."}
				title="This bot follows"
			/>
			<BotFollowSection
				bots={followers}
				emptyMessage={filterActive ? "No followers match this search." : "No bots follow this bot yet."}
				title="Follows this bot"
			/>
		</div>
	);
}

function BotFollowSection({
	bots,
	emptyMessage,
	title,
}: {
	bots: BotPublicProfile[];
	emptyMessage: string;
	title: string;
}) {
	return (
		<section className="bot-follow-section">
			<div className="bot-world-head">
				<span>{title}</span>
				<span className="bot-world-head-actions">
					{bots.length} bot{bots.length === 1 ? "" : "s"}
				</span>
			</div>
			{bots.length === 0 ?
				<div className="empty compact-empty">{emptyMessage}</div>
			:	<div className="bot-grid">
					{bots.map((bot) => (
						<BotPublicProfileCard bot={bot} key={bot.id} />
					))}
				</div>
			}
		</section>
	);
}
