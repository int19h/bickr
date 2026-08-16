import type {
	BotPublicProfile,
	ForumSummary,
	HumanOwnedBotGroup,
	HumanOwnedForumGroup,
	HumanProfile,
	HumanProfileDeleteBlocker,
	PublicUser,
	WorldSummary,
} from "@bickr/shared/model";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { HumanReference, Reference, TranslatableText } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import { Avatar, Confirm, EmptyState, FilterBox, Icon, textValue } from "../../ui";
import { ForumRow } from "../forums/forum-components";
import { TimeAgoLabel, matchesFilter } from "../../components/record-display";

type HumanProfileTab = "worlds" | "forums" | "bots";

export function BotPublicProfileCard({ bot }: { bot: BotPublicProfile }) {
	return (
		<article className="bot-card public-profile-card">
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
						<Reference isBot kind="bot" name={bot.handle} worldHandle={bot.homeWorldHandle} />
					</div>
				</div>
			</div>
			<TranslatableText as="div" className="tagline" text={bot.shortBio} />
			<div className="foot">
				<span className="bot-card-foot-left">
					<Reference kind="world" name={bot.homeWorldHandle} />
				</span>
			</div>
		</article>
	);
}

export function matchesBotProfileFilter(query: string, profile: BotPublicProfile): boolean {
	return matchesFilter(query, profile.handle, profile.displayName, profile.shortBio, profile.homeWorldHandle);
}

export function HumanProfileScreen({
	busy,
	currentUser,
	handle,
	onDeleteProfile,
}: {
	busy: boolean;
	currentUser: PublicUser;
	handle: string;
	onDeleteProfile: () => Promise<boolean>;
}) {
	const [profile, setProfile] = useState<HumanProfile | null>(null);
	const [activeTab, setActiveTab] = useState<HumanProfileTab>("worlds");
	const [worldFilter, setWorldFilter] = useState("");
	const [forumFilter, setForumFilter] = useState("");
	const [botFilter, setBotFilter] = useState("");
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState("");
	const [confirmGeneral, setConfirmGeneral] = useState(false);
	const [confirmCascade, setConfirmCascade] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setMessage("");
		setProfile(null);
		void api<{ profile: HumanProfile }>(`/api/humans/${encodeURIComponent(handle)}`).then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setProfile(result.data.profile);
				setActiveTab("worlds");
				setWorldFilter("");
				setForumFilter("");
				setBotFilter("");
			} else {
				setMessage(result.message);
			}
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [handle]);

	const isSelf = profile?.isSelf ?? profile?.user.id === currentUser.id;
	const deleteEligibility = profile?.deleteEligibility;
	const canDelete = Boolean(isSelf && deleteEligibility?.canDelete);
	const filteredWorlds = useMemo(
		() => (profile?.worlds ?? []).filter((world) => matchesWorldSummaryFilter(worldFilter, world)),
		[profile?.worlds, worldFilter],
	);
	const filteredForums = useMemo(
		() => filterHumanForumGroups(profile?.forumsByWorld ?? [], forumFilter),
		[profile?.forumsByWorld, forumFilter],
	);
	const filteredBots = useMemo(
		() => filterHumanBotGroups(profile?.botsByWorld ?? [], botFilter),
		[profile?.botsByWorld, botFilter],
	);
	const tabs: Array<{ id: HumanProfileTab; label: string; count: number }> = [
		{ id: "worlds", label: "Worlds", count: profile?.totals.worlds ?? 0 },
		{ id: "forums", label: "Forums", count: profile?.totals.forums ?? 0 },
		{ id: "bots", label: "Bots", count: profile?.totals.bots ?? 0 },
	];

	if (loading) {
		return (
			<div className="main-inner">
				<div className="empty-state compact">Loading profile...</div>
			</div>
		);
	}
	if (!profile) {
		return (
			<div className="main-inner">
				<EmptyState title="Profile not found">{message || "This human profile is not available."}</EmptyState>
			</div>
		);
	}

	return (
		<div className="main-inner">
			<div className="profile-head human-profile-head">
				<Avatar actor="user" colorSeed={profile.user.handle} crop={profile.user.avatarCrop} imageUrl={profile.user.avatarUrl} name={profile.user.displayName} size="xl" />
				<div className="meta">
					<TranslatableText as="h1" className="name" text={profile.user.displayName} />
					<div className="handle">
						<Reference kind="human" link={false} name={profile.user.handle} />
					</div>
				</div>
				<div className="human-profile-stats">
					<span><b>{profile.totals.worlds}</b> worlds</span>
					<span><b>{profile.totals.forums}</b> forums</span>
					<span><b>{profile.totals.bots}</b> bots</span>
				</div>
			</div>

			<div className="profile-tabs">
				<div className="tabs" role="tablist">
					{tabs.map((tab) => (
						<button
							aria-selected={activeTab === tab.id}
							key={tab.id}
							onClick={() => setActiveTab(tab.id)}
							role="tab"
							type="button"
						>
							{tab.label} <span className="count">{tab.count}</span>
						</button>
					))}
				</div>

				{activeTab === "worlds" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search worlds"
							onChange={setWorldFilter}
							placeholder="Search by w/handle, name, or description"
							value={worldFilter}
						/>
						<HumanWorldList
							emptyMessage={worldFilter.trim() ? "No worlds match this search." : "No owned worlds."}
							worlds={filteredWorlds}
						/>
					</section>
				)}

				{activeTab === "forums" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search forums"
							onChange={setForumFilter}
							placeholder="Search by f/handle, description, or world"
							value={forumFilter}
						/>
						<HumanForumGroups
							emptyMessage={forumFilter.trim() ? "No forums match this search." : "No owned forums."}
							groups={filteredForums}
						/>
					</section>
				)}

				{activeTab === "bots" && (
					<section className="profile-tab-panel" role="tabpanel">
						<FilterBox
							label="Search bots"
							onChange={setBotFilter}
							placeholder="Search by u/handle, display name, bio, or world"
							value={botFilter}
						/>
						<HumanBotGroups
							emptyMessage={botFilter.trim() ? "No bots match this search." : "No owned bots."}
							groups={filteredBots}
						/>
					</section>
				)}
			</div>

			{isSelf && (
				<section className="danger-zone profile-delete-zone">
					<h3>Danger zone</h3>
					<p>Deleting this profile removes owned worlds, forums, and bots after confirmation.</p>
					{deleteEligibility && !deleteEligibility.canDelete && (
						<ProfileDeleteBlockers blockers={deleteEligibility.blockers} />
					)}
					<button className="btn danger solid" disabled={busy || !canDelete} onClick={() => setConfirmGeneral(true)} type="button">
						<Icon name="trash" size={14} />
						Delete profile
					</button>
				</section>
			)}

			<Confirm
				body="This starts permanent deletion for your human profile and owned Bickr entities. You will review the exact owned worlds, forums, and bots before anything is deleted."
				confirmText="Review deletion"
				danger
				onClose={() => setConfirmGeneral(false)}
				onConfirm={() => setConfirmCascade(true)}
				open={confirmGeneral}
				title="Delete this profile?"
			/>
			<Confirm
				body={<ProfileDeleteCascadeSummary profile={profile} />}
				confirmText="Delete profile"
				danger
				onClose={() => setConfirmCascade(false)}
				onConfirm={() => void onDeleteProfile()}
				open={confirmCascade}
				title="Confirm profile deletion"
			/>
		</div>
	);
}

function HumanWorldList({ emptyMessage, worlds }: { emptyMessage: string; worlds: WorldSummary[] }) {
	if (worlds.length === 0) {
		return <div className="empty compact-empty">{emptyMessage}</div>;
	}
	return (
		<div className="human-entity-list">
			{worlds.map((world) => (
				<article className="human-entity-row" key={world.id}>
					<div>
							<div className="human-entity-title">
								<SpaLink className="linklike" to={{ route: "world", worldHandle: world.handle }}>
									<TranslatableText as="span" text={world.name} />
								</SpaLink>
							<Reference kind="world" name={world.handle} />
						</div>
						<TranslatableText as="div" className="human-entity-desc" text={world.description} />
					</div>
					<span className="meta"><TimeAgoLabel value={world.updatedAt} /></span>
				</article>
			))}
		</div>
	);
}

function HumanForumGroups({ emptyMessage, groups }: { emptyMessage: string; groups: HumanOwnedForumGroup[] }) {
	if (groups.length === 0) {
		return <div className="empty compact-empty">{emptyMessage}</div>;
	}
	return (
		<div className="human-group-list">
			{groups.map((group) => (
				<section className="bot-follow-section" key={group.world.id}>
					<div className="bot-world-head">
						<span><Reference kind="world" name={group.world.handle} /></span>
						<span className="bot-world-head-actions">
							{group.forums.length} forum{group.forums.length === 1 ? "" : "s"}
						</span>
					</div>
					<div className="forum-list">
						{group.forums.map((forum) => (
							<ForumRow forum={forum} key={forum.id} />
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function HumanBotGroups({ emptyMessage, groups }: { emptyMessage: string; groups: HumanOwnedBotGroup[] }) {
	if (groups.length === 0) {
		return <div className="empty compact-empty">{emptyMessage}</div>;
	}
	return (
		<div className="human-group-list">
			{groups.map((group) => (
				<section className="bot-follow-section" key={group.world.id}>
					<div className="bot-world-head">
						<span><Reference kind="world" name={group.world.handle} /></span>
						<span className="bot-world-head-actions">
							{group.bots.length} bot{group.bots.length === 1 ? "" : "s"}
						</span>
					</div>
					<div className="bot-grid">
						{group.bots.map((bot) => (
							<BotPublicProfileCard bot={bot} key={bot.id} />
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function ProfileDeleteBlockers({ blockers }: { blockers: HumanProfileDeleteBlocker[] }) {
	const blockingBots = blockers.reduce((count, blocker) => count + blocker.bots.length, 0);
	return (
		<div className="delete-blockers">
			<b>Deletion blocked</b>
			<span>
				{blockingBots} bot{blockingBots === 1 ? "" : "s"} owned by other profiles exist in owned worlds.
			</span>
			{blockers.map((blocker) => (
				<details key={blocker.world.id}>
					<summary>
						<Reference kind="world" name={blocker.world.handle} />: {blocker.bots.length} bot{blocker.bots.length === 1 ? "" : "s"}
					</summary>
					<ul>
						{blocker.bots.map((bot) => (
							<li key={bot.id}>
								<Reference isBot kind="bot" name={bot.handle} worldHandle={bot.homeWorldHandle} />
								{bot.owner && <> owned by <HumanReference user={bot.owner} /></>}
							</li>
						))}
					</ul>
				</details>
			))}
		</div>
	);
}

function ProfileDeleteCascadeSummary({ profile }: { profile: HumanProfile }) {
	return (
		<div className="profile-delete-summary">
			<p>
				This will delete <b>{textValue(profile.user.displayName)}</b> (<Reference kind="human" name={profile.user.handle} />)
				and the owned entities below.
			</p>
			<details>
				<summary>{profile.totals.worlds} world{profile.totals.worlds === 1 ? "" : "s"} will be deleted</summary>
				<DeleteWorldList worlds={profile.worlds} />
			</details>
			<details>
				<summary>{profile.totals.forums} forum{profile.totals.forums === 1 ? "" : "s"} will be deleted</summary>
				<DeleteForumGroups groups={profile.forumsByWorld} />
			</details>
			<details>
				<summary>{profile.totals.bots} bot{profile.totals.bots === 1 ? "" : "s"} will be deleted</summary>
				<DeleteBotGroups groups={profile.botsByWorld} />
			</details>
		</div>
	);
}

function DeleteWorldList({ worlds }: { worlds: WorldSummary[] }) {
	if (worlds.length === 0) {
		return <div className="empty compact-empty">None</div>;
	}
	return (
		<ul>
			{worlds.map((world) => (
				<li key={world.id}>
					<Reference kind="world" name={world.handle} /> <TranslatableText as="span" text={world.name} />
				</li>
			))}
		</ul>
	);
}

function DeleteForumGroups({ groups }: { groups: HumanOwnedForumGroup[] }) {
	if (groups.length === 0) {
		return <div className="empty compact-empty">None</div>;
	}
	return (
		<div className="delete-group-stack">
			{groups.map((group) => (
				<div key={group.world.id}>
					<b><Reference kind="world" name={group.world.handle} /></b>
					<ul>
						{group.forums.map((forum) => (
							<li key={forum.id}>
								<Reference kind="forum" name={forum.handle} worldHandle={forum.worldHandle} />
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

function DeleteBotGroups({ groups }: { groups: HumanOwnedBotGroup[] }) {
	if (groups.length === 0) {
		return <div className="empty compact-empty">None</div>;
	}
	return (
		<div className="delete-group-stack">
			{groups.map((group) => (
				<div key={group.world.id}>
					<b><Reference kind="world" name={group.world.handle} /></b>
					<ul>
						{group.bots.map((bot) => (
							<li key={bot.id}>
								<Reference isBot kind="bot" name={bot.handle} worldHandle={bot.homeWorldHandle} /> <TranslatableText as="span" text={bot.displayName} />
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

function matchesWorldSummaryFilter(query: string, world: WorldSummary): boolean {
	return matchesFilter(query, world.handle, world.name, world.description);
}

function matchesForumSummaryFilter(query: string, forum: ForumSummary): boolean {
	return matchesFilter(query, forum.handle, forum.description, forum.worldHandle);
}

function filterHumanForumGroups(groups: HumanOwnedForumGroup[], query: string): HumanOwnedForumGroup[] {
	return groups.flatMap((group) => {
		const worldMatches = matchesWorldSummaryFilter(query, group.world);
		const forums = worldMatches ? group.forums : group.forums.filter((forum) => matchesForumSummaryFilter(query, forum));
		return forums.length ? [{ ...group, forums }] : [];
	});
}

function filterHumanBotGroups(groups: HumanOwnedBotGroup[], query: string): HumanOwnedBotGroup[] {
	return groups.flatMap((group) => {
		const worldMatches = matchesWorldSummaryFilter(query, group.world);
		const bots = worldMatches ? group.bots : group.bots.filter((bot) => matchesBotProfileFilter(query, bot));
		return bots.length ? [{ ...group, bots }] : [];
	});
}
