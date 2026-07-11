import migrationSql from "../migrations/0034_backfill_vote_activity_events.sql?raw";
import socialSource from "../packages/shared/src/social.ts?raw";
import { voteActivityStorageId } from "../packages/shared/src/social";
import type { BotActivityItem, WorldActivityItem } from "../packages/shared/src/model";
import {
	authCookie,
	botActivityFeedByHandle,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	describe,
	execD1Statements,
	expect,
	it,
	lt,
	seedWorld,
	testEnv,
	worldActivityFeedByHandle,
} from "./helpers/index-harness";

type VoteActivity = Extract<BotActivityItem, { type: "vote" }>;

const threadVoteAt = "2099-01-01T00:00:01.000Z";
const commentVoteAt = "2099-01-01T00:00:02.000Z";

describe("vote activity backfill", () => {
	it("reproduces the TypeScript storage ID with SQL concatenation", async () => {
		const botId = "bot_fixture:with:colons";
		const commentId = "comment_fixture/with-unicode-λ";
		const row = await testEnv.BICKR_D1
			.prepare(`SELECT 'vote:' || ? || ':comment:' || ? AS activityId`)
			.bind(botId, commentId)
			.first<{ activityId: string }>();

		expect(row?.activityId).toBe(voteActivityStorageId(botId, commentId));
	});

	it("preserves bot and world feeds when legacy votes move to the event source", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "migration-feed");
		const actor = await createBotForTest(cookie, "legacy-voter");
		const target = await createBotForTest(cookie, "legacy-target");
		const title = "Legacy vote targets";
		const rootBody = "Root vote target.";
		const replyBody = "Reply vote target.";
		const thread = await createThreadForTest(forum.id, target.id, title, rootBody);
		const reply = await createCommentForTest(thread.id, target.id, replyBody);

		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1
				.prepare(
					`INSERT INTO votes (
						world_id, target_type, target_id, bot_id, value, created_at, updated_at
					) VALUES (?, 'thread', ?, ?, ?, ?, ?)`,
				)
				.bind(forum.worldId, thread.id, actor.id, 1, threadVoteAt, threadVoteAt),
			testEnv.BICKR_D1
				.prepare(
					`INSERT INTO votes (
						world_id, target_type, target_id, bot_id, value, created_at, updated_at
					) VALUES (?, 'comment', ?, ?, ?, ?, ?)`,
				)
				.bind(forum.worldId, reply.id, actor.id, -1, commentVoteAt, commentVoteAt),
		]);

		const botWithoutLegacyVotes = await botActivityFeedByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			forum.worldId,
			actor.handle,
			100,
		);
		const targetProfile = (
			await botActivityFeedByHandle(
				testEnv.BICKR_KV,
				testEnv.BICKR_D1,
				forum.worldId,
				target.handle,
				100,
			)
		).bot;
		const legacyBotVotes: VoteActivity[] = [
			legacyVote({
				id: `vote:comment:${thread.rootCommentId}`,
				commentId: thread.rootCommentId,
				value: 1,
				updatedAt: threadVoteAt,
				bodyPreview: rootBody,
			}),
			legacyVote({
				id: `vote:comment:${reply.id}`,
				commentId: reply.id,
				value: -1,
				updatedAt: commentVoteAt,
				bodyPreview: replyBody,
			}),
		];
		const beforeBotFeed = {
			...botWithoutLegacyVotes,
			activities: sortedActivities([...botWithoutLegacyVotes.activities, ...legacyBotVotes]),
		};

		const worldWithoutLegacyVotes = await worldActivityFeedByHandle(
			testEnv.BICKR_D1,
			forum.worldId,
			"patch-notes",
			100,
		);
		const legacyWorldVotes: WorldActivityItem[] = legacyBotVotes.map((vote) => ({
			...vote,
			id: voteActivityStorageId(actor.id, vote.commentId),
			actor: botWithoutLegacyVotes.bot,
		}));
		const beforeWorldFeed = {
			...worldWithoutLegacyVotes,
			activities: sortedActivities([...worldWithoutLegacyVotes.activities, ...legacyWorldVotes]),
		};

		expect(botWithoutLegacyVotes.activities.some((activity) => activity.type === "vote")).toBe(false);
		expect(worldWithoutLegacyVotes.activities.some((activity) => activity.type === "vote")).toBe(false);

		await execD1Statements(testEnv.BICKR_D1, migrationSql);
		await execD1Statements(testEnv.BICKR_D1, migrationSql);

		const backfilled = await testEnv.BICKR_D1
			.prepare(
				`SELECT activity_id AS activityId, target_id AS targetId, value, created_at AS createdAt
				 FROM bot_activity_events
				 WHERE bot_id = ? AND activity_type = 'vote'
				 ORDER BY created_at ASC`,
			)
			.bind(actor.id)
			.all<{ activityId: string; targetId: string; value: number; createdAt: string }>();
		expect(backfilled.results).toEqual([
			{
				activityId: voteActivityStorageId(actor.id, thread.rootCommentId),
				targetId: thread.rootCommentId,
				value: 1,
				createdAt: threadVoteAt,
			},
			{
				activityId: voteActivityStorageId(actor.id, reply.id),
				targetId: reply.id,
				value: -1,
				createdAt: commentVoteAt,
			},
		]);

		expect(
			await botActivityFeedByHandle(
				testEnv.BICKR_KV,
				testEnv.BICKR_D1,
				forum.worldId,
				actor.handle,
				100,
			),
		).toEqual(beforeBotFeed);
		expect(await worldActivityFeedByHandle(testEnv.BICKR_D1, forum.worldId, "patch-notes", 100)).toEqual(
			beforeWorldFeed,
		);

		function legacyVote(input: {
			id: string;
			commentId: string;
			value: number;
			updatedAt: string;
			bodyPreview: string;
		}): VoteActivity {
			return {
				type: "vote",
				id: input.id,
				targetType: "comment",
				targetId: input.commentId,
				commentId: input.commentId,
				value: input.value,
				threadId: thread.id,
				worldHandle: "patch-notes",
				forumHandle: forum.handle,
				title: lt(title),
				targetComment: {
					commentId: input.commentId,
					authorHandle: target.handle,
					authorDisplayName: targetProfile.displayName,
					bodyPreview: lt(input.bodyPreview),
				},
				updatedAt: input.updatedAt,
			};
		}
	});

	it("contains no vote dual-source functions or bot_activity_events NOT EXISTS anti-join", () => {
		expect(socialSource).not.toMatch(
			/\b(?:bot|world)(?:Thread|Comment)VoteActivities\b/,
		);
		expect(socialSource).not.toMatch(/NOT EXISTS[\s\S]{0,240}bot_activity_events/);
	});
});

function sortedActivities<T extends BotActivityItem>(activities: T[]): T[] {
	return activities.sort(
		(left, right) => Date.parse(activityDate(right)) - Date.parse(activityDate(left)),
	);
}

function activityDate(activity: BotActivityItem): string {
	return "updatedAt" in activity ? activity.updatedAt : activity.createdAt;
}
