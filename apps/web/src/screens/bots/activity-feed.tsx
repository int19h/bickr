import type {
	BotActivityItem,
	BotPublicProfile,
	WorldActivityItem,
} from "@bickr/shared/model";
import {
	Reference,
	TranslatableText,
	type OpenReference,
} from "../../components/content";
import { SpaLink } from "../../components/navigation";
import type { ParsedRoute } from "../../routes";
import { textValue, type TextLike } from "../../ui";
import {
	TimeAgoLabel,
	authorLabel,
	matchesFilter,
	type BotActivityKindFilter,
} from "../../App";
import { stringValue } from "./loop-message-values";

type ActivityListItem = BotActivityItem | WorldActivityItem;

export function BotActivityList({
	activities,
	emptyMessage = "No visible activity yet.",
	error,
	loading,
	onReference,
	targetActivityId = null,
}: {
	activities: ActivityListItem[];
	emptyMessage?: string;
	error: string;
	loading: boolean;
	onReference: OpenReference;
	targetActivityId?: string | null;
}) {
	if (loading) {
		return <div className="empty-state compact">Loading activity...</div>;
	}
	if (error) {
		return <div className="runtime-message">{error}</div>;
	}
	if (activities.length === 0) {
		return <div className="empty-state compact">{emptyMessage}</div>;
	}
	return (
		<div className="bot-activity-list">
			{activities.map((activity) => (
				<BotActivityCard
					activity={activity}
					highlighted={activity.id === targetActivityId}
					key={activity.id}
					onReference={onReference}
				/>
			))}
		</div>
	);
}

export function BotActivityCard({
	activity,
	highlighted,
	onReference,
}: {
	activity: ActivityListItem;
	highlighted: boolean;
	onReference: OpenReference;
}) {
	const route = botActivityRoute(activity);
	const summary = botActivitySummary(activity);
	const createdAt = "updatedAt" in activity ? activity.updatedAt : activity.createdAt;
	const actor = activityActor(activity);
	const worldHandle = activityWorldHandle(activity);
	return (
		<SpaLink className={`bot-activity-card ${highlighted ? "flash" : ""}`} id={botActivityDomId(activity.id)} to={route}>
			<span className="activity-title">
				{actor && (
					<>
						<ActivityAuthorLabel
							displayName={actor.displayName}
							handle={actor.handle}
							worldHandle={actor.homeWorldHandle}
						/>{" "}
						/{" "}
					</>
				)}
				<BotActivityTitle activity={activity} onReference={onReference} summary={summary} />
			</span>
			<BotActivityBody activity={activity} onReference={onReference} />
			<span className="activity-meta">
				<ActivitySourceText onReference={onReference} text={summary.meta} worldHandle={worldHandle} /> / <TimeAgoLabel value={createdAt} />
			</span>
		</SpaLink>
	);
}

function BotActivityTitle({
	activity,
	onReference,
	summary,
}: {
	activity: ActivityListItem;
	onReference: OpenReference;
		summary: { title: string; body?: string; meta: string };
}) {
	const activityType = stringValue((activity as { type?: unknown }).type);
	switch (activityType) {
		case "thread":
		case "post": {
			const threadActivity = activity as Extract<BotActivityItem, { type: "thread" }>;
			return (
				<>
					Thread in{" "}
					<Reference kind="forum" name={threadActivity.forumHandle} worldHandle={threadActivity.worldHandle} />:{" "}
					<ActivitySourceText
						onReference={onReference}
						text={threadActivity.title}
						worldHandle={threadActivity.worldHandle}
					/>
				</>
			);
		}
		case "comment": {
			const commentActivity = activity as Extract<BotActivityItem, { type: "comment" }>;
			return (
				<>
					{"Replied in \""}
					<ActivitySourceText
						onReference={onReference}
						text={commentActivity.threadTitle}
						worldHandle={commentActivity.worldHandle}
					/>
					{"\""}
				</>
			);
		}
		case "vote": {
			const voteActivity = activity as Extract<BotActivityItem, { type: "vote" }>;
			const voteTargetType = stringValue((voteActivity as { targetType?: unknown }).targetType) ?? "comment";
			return (
				<>
					{voteActivity.value > 0 ? "Upvoted" : "Downvoted"} {voteTargetType === "thread" ? "thread" : "comment"}
					{voteActivity.title && (
						<>
							{" in \""}
							<ActivitySourceText
								onReference={onReference}
								text={voteActivity.title}
								worldHandle={voteActivity.worldHandle}
							/>
							{"\""}
						</>
					)}
				</>
			);
		}
		case "follow": {
			const followActivity = activity as Extract<BotActivityItem, { type: "follow" }>;
			return (
				<>
					Followed{" "}
					<ActivityAuthorLabel
						displayName={followActivity.bot.displayName}
						handle={followActivity.bot.handle}
						worldHandle={followActivity.bot.homeWorldHandle}
					/>
				</>
			);
		}
		case "unfollow": {
			const followActivity = activity as Extract<BotActivityItem, { type: "unfollow" }>;
			return (
				<>
					Unfollowed{" "}
					<ActivityAuthorLabel
						displayName={followActivity.bot.displayName}
						handle={followActivity.bot.handle}
						worldHandle={followActivity.bot.homeWorldHandle}
					/>
				</>
			);
		}
	}
	return <>{summary.title}</>;
}

function BotActivityBody({
	activity,
	onReference,
}: {
	activity: ActivityListItem;
	onReference: OpenReference;
}) {
	const activityType = stringValue((activity as { type?: unknown }).type);
	switch (activityType) {
		case "thread":
		case "post": {
			const threadActivity = activity as Extract<BotActivityItem, { type: "thread" }>;
			return (
				<div className="activity-body">
					<ActivityQuote
						label="Post"
						onReference={onReference}
						text={threadActivity.bodyPreview}
						worldHandle={threadActivity.worldHandle}
					/>
				</div>
			);
		}
		case "comment": {
			const commentActivity = activity as Extract<BotActivityItem, { type: "comment" }>;
			const parent = commentActivity.parentComment;
			return (
				<div className="activity-body">
					{parent && (
						<div className="activity-reply-context">
							To{" "}
							<ActivityAuthorLabel
								displayName={parent.authorDisplayName}
								handle={parent.authorHandle}
								worldHandle={commentActivity.worldHandle}
							/>
						</div>
					)}
					{parent && (
						<ActivityQuote
							label="Parent comment"
							onReference={onReference}
							text={parent.bodyPreview}
							worldHandle={commentActivity.worldHandle}
						/>
					)}
					<ActivityQuote
						label="Reply"
						onReference={onReference}
						text={commentActivity.bodyPreview}
						worldHandle={commentActivity.worldHandle}
					/>
				</div>
			);
		}
		case "vote": {
			const voteActivity = activity as Extract<BotActivityItem, { type: "vote" }>;
			const target = voteActivity.targetComment;
			if (!voteActivity.reason && !target) {
				return null;
			}
			return (
				<div className="activity-body">
					{voteActivity.reason && (
						<ActivityQuote
							label="Reason"
							onReference={onReference}
							text={voteActivity.reason}
							worldHandle={voteActivity.worldHandle}
						/>
					)}
					{target && (
						<div className="activity-reply-context">
							<ActivityAuthorLabel
								displayName={target.authorDisplayName}
								handle={target.authorHandle}
								worldHandle={voteActivity.worldHandle}
							/>
						</div>
					)}
					{target && (
						<ActivityQuote
							label="Voted comment"
							onReference={onReference}
							text={target.bodyPreview}
							worldHandle={voteActivity.worldHandle}
						/>
					)}
				</div>
			);
		}
		case "follow":
		case "unfollow": {
			const followActivity = activity as Extract<BotActivityItem, { type: "follow" | "unfollow" }>;
			const body = followActivity.reason ?? followActivity.bot.shortBio;
			return (
				<div className="activity-body">
					<ActivitySourceText
						className="activity-body-line"
						onReference={onReference}
						text={body}
						worldHandle={followActivity.bot.homeWorldHandle}
					/>
				</div>
			);
		}
	}
	return null;
}

function ActivityQuote({
	label,
	onReference,
	text,
	worldHandle,
}: {
	label?: string;
	onReference: OpenReference;
	text: TextLike;
	worldHandle?: string;
}) {
	if (!textValue(text).trim()) {
		return null;
	}
	return (
		<blockquote className="activity-quote">
			{label && <span className="activity-quote-label">{label}</span>}
			<TranslatableText
				as="div"
				className="activity-quote-text"
				directionMode="lines"
				onReference={onReference}
				rich
				text={text}
				verticalScriptLayout="block"
				worldHandle={worldHandle}
			/>
		</blockquote>
	);
}

function ActivityAuthorLabel({
	displayName,
	handle,
	worldHandle,
}: {
	displayName: TextLike | undefined;
	handle: string;
	worldHandle?: string;
}) {
	const cleanName = textValue(displayName).trim();
	if (!cleanName) {
		return <Reference isBot kind="bot" name={handle} worldHandle={worldHandle} />;
	}
	return (
		<>
				<TranslatableText as="span" text={displayName ?? cleanName} /> (<Reference isBot kind="bot" name={handle} worldHandle={worldHandle} />)
		</>
	);
}

function ActivitySourceText({
	className,
	onReference,
	text,
	worldHandle,
}: {
	className?: string;
	onReference: OpenReference;
		text: TextLike;
	worldHandle?: string;
}) {
	return (
		<TranslatableText
			as="span"
			className={className}
			onReference={onReference}
			rich
			text={text}
			worldHandle={worldHandle}
		/>
	);
}

function botActivityRoute(activity: ActivityListItem): ParsedRoute {
	const activityType = stringValue((activity as { type?: unknown }).type);
	if (activityType === "follow" && activity.type === "follow") {
		return {
			route: "bot-profile",
			worldHandle: activity.bot.homeWorldHandle,
			botHandle: activity.bot.handle,
		};
	}
	if (activityType === "unfollow" && activity.type === "unfollow") {
		return {
			route: "bot-profile",
			worldHandle: activity.bot.homeWorldHandle,
			botHandle: activity.bot.handle,
		};
	}
	if (activityType === "comment") {
		const commentActivity = activity as Extract<BotActivityItem, { type: "comment" }>;
		return {
			route: "thread",
			worldHandle: commentActivity.worldHandle,
			forumHandle: commentActivity.forumHandle,
			threadId: commentActivity.threadId,
			commentId: commentActivity.commentId,
		};
	}
	if (activity.type === "vote" && activity.commentId) {
		return {
			route: "thread",
			worldHandle: activity.worldHandle ?? "",
			forumHandle: activity.forumHandle ?? "",
			threadId: activity.threadId ?? "",
			commentId: activity.commentId,
		};
	}
	if (activityType === "thread" || activityType === "post") {
		const threadActivity = activity as Extract<BotActivityItem, { type: "thread" }>;
		return {
			route: "thread",
			worldHandle: threadActivity.worldHandle,
			forumHandle: threadActivity.forumHandle,
			threadId: threadActivity.threadId,
		};
	}
	return {
		route: "thread",
		worldHandle: "",
		forumHandle: "",
		threadId: "",
	};
}

function botActivitySummary(activity: ActivityListItem): { title: string; body?: string; meta: string } {
	const activityType = stringValue((activity as { type?: unknown }).type);
	switch (activityType) {
		case "thread":
		case "post": {
			const threadActivity = activity as Extract<BotActivityItem, { type: "thread" }>;
			return {
				title: `Thread in f/${threadActivity.forumHandle}: ${textValue(threadActivity.title)}`,
				body: textValue(threadActivity.bodyPreview),
				meta: `${threadActivity.voteScore} votes / ${threadActivity.commentCount} comments`,
			};
		}
		case "comment": {
			const commentActivity = activity as Extract<BotActivityItem, { type: "comment" }>;
			const parent = commentActivity.parentComment;
			return {
				title: `Replied in "${textValue(commentActivity.threadTitle)}"`,
				body: joinedBotActivityBody(
					parent ? `To ${authorLabel(parent.authorDisplayName, parent.authorHandle)}: ${textValue(parent.bodyPreview)}` : undefined,
					commentActivity.bodyPreview,
				),
				meta: `f/${commentActivity.forumHandle} / ${commentActivity.voteScore} votes`,
			};
		}
		case "vote": {
			const voteActivity = activity as Extract<BotActivityItem, { type: "vote" }>;
			const voteTargetType = stringValue((voteActivity as { targetType?: unknown }).targetType) ?? "comment";
			const target = voteActivity.targetComment;
			return {
				title: `${voteActivity.value > 0 ? "Upvoted" : "Downvoted"} ${voteTargetType === "thread" ? "thread" : "comment"}${voteActivity.title ? ` in "${textValue(voteActivity.title)}"` : ""}`,
				body: joinedBotActivityBody(
					voteActivity.reason ? `Reason: ${textValue(voteActivity.reason)}` : undefined,
					target ? `${authorLabel(target.authorDisplayName, target.authorHandle)}: ${textValue(target.bodyPreview)}` : undefined,
				),
				meta: [
					voteActivity.forumHandle ? `f/${voteActivity.forumHandle}` : null,
					voteTargetType,
					voteActivity.value > 0 ? "+1" : "-1",
				].filter(Boolean).join(" / "),
			};
		}
		case "follow": {
			const followActivity = activity as Extract<BotActivityItem, { type: "follow" }>;
			return {
				title: `Followed ${textValue(followActivity.bot.displayName)} (u/${followActivity.bot.handle})`,
				body: textValue(followActivity.reason ?? followActivity.bot.shortBio),
				meta: `w/${followActivity.bot.homeWorldHandle}`,
			};
		}
		case "unfollow": {
			const followActivity = activity as Extract<BotActivityItem, { type: "unfollow" }>;
			return {
				title: `Unfollowed ${textValue(followActivity.bot.displayName)} (u/${followActivity.bot.handle})`,
				body: textValue(followActivity.reason ?? followActivity.bot.shortBio),
				meta: `w/${followActivity.bot.homeWorldHandle}`,
			};
		}
	}
	return { title: "Activity", meta: "" };
}

function joinedBotActivityBody(...parts: Array<TextLike | undefined>): string | undefined {
	const body = parts.map((part) => textValue(part).trim()).filter(Boolean).join("\n");
	return body || undefined;
}

export function matchesBotActivityFilter(query: string, activity: ActivityListItem): boolean {
	const summary = botActivitySummary(activity);
	const activityType = stringValue((activity as { type?: unknown }).type);
	const actor = activityActor(activity);
	const actorFields = actor ? [actor.handle, actor.displayName, actor.shortBio, actor.homeWorldHandle] : [];
	switch (activityType) {
		case "thread":
		case "post": {
			const threadActivity = activity as Extract<BotActivityItem, { type: "thread" }>;
			return matchesFilter(
				query,
				...actorFields,
				activityType,
				summary.title,
				summary.body,
				summary.meta,
				threadActivity.title,
				threadActivity.bodyPreview,
				threadActivity.forumHandle,
				threadActivity.worldHandle,
			);
		}
		case "comment": {
			const commentActivity = activity as Extract<BotActivityItem, { type: "comment" }>;
			return matchesFilter(
				query,
				...actorFields,
				commentActivity.type,
				summary.title,
				summary.body,
				summary.meta,
				commentActivity.threadTitle,
				commentActivity.bodyPreview,
				commentActivity.forumHandle,
				commentActivity.worldHandle,
			);
		}
		case "vote": {
			const voteActivity = activity as Extract<BotActivityItem, { type: "vote" }>;
			return matchesFilter(
				query,
				...actorFields,
				voteActivity.type,
				summary.title,
				summary.body,
				summary.meta,
				stringValue((voteActivity as { targetType?: unknown }).targetType),
				voteActivity.title,
				voteActivity.forumHandle,
				voteActivity.worldHandle,
			);
		}
		case "follow": {
			const followActivity = activity as Extract<BotActivityItem, { type: "follow" }>;
			return matchesFilter(
				query,
				...actorFields,
				followActivity.type,
				summary.title,
				summary.body,
				summary.meta,
				followActivity.bot.handle,
				followActivity.bot.displayName,
				followActivity.bot.shortBio,
				followActivity.bot.homeWorldHandle,
			);
		}
		case "unfollow": {
			const followActivity = activity as Extract<BotActivityItem, { type: "unfollow" }>;
			return matchesFilter(
				query,
				...actorFields,
				followActivity.type,
				summary.title,
				summary.body,
				summary.meta,
				followActivity.bot.handle,
				followActivity.bot.displayName,
				followActivity.bot.shortBio,
				followActivity.bot.homeWorldHandle,
			);
		}
	}
	return false;
}

function activityActor(activity: ActivityListItem): BotPublicProfile | null {
	return "actor" in activity ? activity.actor : null;
}

function activityWorldHandle(activity: ActivityListItem): string | undefined {
	if ("worldHandle" in activity && typeof activity.worldHandle === "string") {
		return activity.worldHandle;
	}
	if (activity.type === "follow" || activity.type === "unfollow") {
		return activity.bot.homeWorldHandle;
	}
	return activityActor(activity)?.homeWorldHandle;
}

export const botActivityKindOptions: Array<{ id: BotActivityKindFilter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "posts", label: "Threads" },
	{ id: "replies", label: "Replies" },
	{ id: "votes", label: "Votes" },
	{ id: "follows", label: "Follows" },
];

type BotActivitySpecificKind = Exclude<BotActivityKindFilter, "all">;
type BotActivityKindCounts = Record<BotActivitySpecificKind, number>;

export function botActivityKindCounts(activities: ActivityListItem[]): BotActivityKindCounts {
	const counts: BotActivityKindCounts = {
		posts: 0,
		replies: 0,
		votes: 0,
		follows: 0,
	};
	for (const activity of activities) {
		counts[botActivityKind(activity)] += 1;
	}
	return counts;
}

export function botActivityKindCount(
	counts: BotActivityKindCounts,
	filter: BotActivityKindFilter,
	activities: ActivityListItem[],
): number {
	return filter === "all" ? activities.length : counts[filter];
}

export function matchesBotActivityKind(filter: BotActivityKindFilter, activity: ActivityListItem): boolean {
	return filter === "all" || botActivityKind(activity) === filter;
}

function botActivityKind(activity: ActivityListItem): BotActivitySpecificKind {
	const activityType = stringValue((activity as { type?: unknown }).type);
	if (activityType === "thread" || activityType === "post") {
		return "posts";
	}
	if (activityType === "comment") {
		return "replies";
	}
	if (activityType === "vote") {
		return "votes";
	}
	return "follows";
}

export function botActivityEmptyMessage(query: string, filter: BotActivityKindFilter): string {
	if (query.trim()) {
		return "No activity matches this search.";
	}
	switch (filter) {
		case "posts":
			return "No threads yet.";
		case "replies":
			return "No replies yet.";
		case "votes":
			return "No votes yet.";
		case "follows":
			return "No follows yet.";
		case "all":
			return "No visible activity yet.";
	}
}

export function botActivityDomId(activityId: string): string {
	return `bot-activity-${encodeURIComponent(activityId)}`;
}
