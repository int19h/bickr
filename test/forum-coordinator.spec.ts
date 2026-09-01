import {
	authCookie,
	authCookieFor,
	botActivity,
	botActivityFeedByHandle,
	botById,
	botFollowGraphByHandle,
	botFollows,
	botPublicProfileByHandle,
	BotRuntime,
	buildRuntimeLoopInput,
	commentRefResolver,
	commentVotes,
	contextFor,
	createBot,
	createBotForTest,
	createBotInWorld,
	createCommentForTest,
	createForum,
	createForumForTest,
	createThreadForTest,
	createWorld,
	createWorldForTest,
	deferred,
	deleteBot,
	deleteCommentRoute,
	deleteDeliveredNotifications,
	deleteForumRoute,
	deleteThreadRoute,
	deleteWorldRoute,
	describe,
	ExclusiveOperationQueue,
	expect,
	followBot,
	formatCommentRef,
	forumCoordinatorWorker,
	forumThreads,
	getNotificationsRoute,
	getSubscriptionsRoute,
	handleForumCoordinatorRequest,
	it,
	jsonRequest,
	kvKeys,
	kvWithDelayedFirstPut,
	listHotThreads,
	listPendingNotifications,
	listThreads,
	localizedTextString,
	lt,
	markAllNotificationsReadRoute,
	markBotSeenContent,
	markBotSeenFromResult,
	meBots,
	memoryDurableStorage,
	patchForum,
	patchSubscriptionsRoute,
	patchWorld,
	pause,
	readThread,
	recordSpotlightNoReactionHumanNotification,
	recordSpotlightToolHumanNotification,
	refreshThreadHotScores,
	requiredLt,
	runtimeEvent,
	searchBots,
	searchThreads,
	seedWorld,
	setSubscriptionRoute,
	setVote,
	spotlightInjectedText,
	testEnv,
	testRuntimeForToolExecution,
	threadDetail,
	threadHotScore,
	threadRefResolver,
	unfollowBot,
	unspecifiedLt,
	userIdForHandle,
	vi,
	worldActivity,
	worldActivityFeedByHandle,
	worlds,
} from "./helpers/index-harness";
import type {
	BotBody,
	BotDocument,
	BotInferenceSubmissionMessage,
	BotRuntimeEvent,
	ForumCoordinatorEnv,
	HumanSubscriptionTreeResponse,
	LocalizedText,
	SpotlightSyntheticContext,
	TestForum,
	TestThread,
	ThreadDetailPayload,
	ThreadFreshCacheEntryForTest,
	ThreadListPayload,
} from "./helpers/index-harness";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import {
	bootstrapNotificationId,
	humanNotificationRetentionDays,
	pruneExpiredBotSeenContent,
	pruneExpiredHumanNotifications,
	pruneExpiredNotifications,
	pruneExpiredSpotlightDeliveries,
	selectTombstonedBotsAfterCursorSql,
	selectTombstonedBotsFirstPageSql,
	spotlightDeliveryRetentionDays,
} from "@bickr/shared/social";
import {
	forumCoordinatorDailyCronExpression,
	forumCoordinatorNotificationPruneCronExpression,
} from "../workers/forum-coordinator/src/cron";
import { botInferenceUsageRetentionDays } from "@bickr/shared/token-spend";
import type { KVNamespaceLike } from "@bickr/shared/storage";
import type { ForumDocument } from "@bickr/shared/model";

async function postThread(forumId: string, botId: string, title: string, body: string): Promise<Response> {
	const request = jsonRequest(`http://example.com/forums/${forumId}/threads`, "POST", {
		title: requiredLt(title),
		body: requiredLt(body),
	});
	request.headers.set("x-bickr-bot-id", botId);
	return handleForumCoordinatorRequest(request, {
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
	});
}

async function setForumThreadCommentLimit(forumId: string, commentLimit: number): Promise<void> {
	const key = kvKeys.forum(forumId);
	const forum = await testEnv.BICKR_KV.get<ForumDocument>(key, { type: "json" });
	if (!forum) {
		throw new Error(`Forum ${forumId} was not found.`);
	}
	await testEnv.BICKR_KV.put(key, JSON.stringify({
		...forum,
		threadSettings: { commentLimit },
		revision: forum.revision + 1,
	}));
	await testEnv.BICKR_D1.prepare(
		`UPDATE forums_index SET thread_comment_limit = ? WHERE forum_id = ?`,
	).bind(commentLimit, forumId).run();
}

async function runForumCoordinatorScheduled(
	scheduledTime: string,
	cron = forumCoordinatorDailyCronExpression,
): Promise<void> {
	if (!forumCoordinatorWorker.scheduled) {
		throw new Error("Forum coordinator scheduled handler is missing.");
	}
	const pending: Array<Promise<unknown>> = [];
	const controller = {
		scheduledTime: Date.parse(scheduledTime),
		cron,
		noRetry: () => {},
	} as ScheduledController;
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
		passThroughOnException: () => {},
	} as ExecutionContext;
	await forumCoordinatorWorker.scheduled(controller, testEnv as unknown as ForumCoordinatorEnv, ctx);
	await Promise.all(pending);
}

function scheduledLogs(consoleLog: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
	return consoleLog.mock.calls.map(([message]) => {
		try {
			return JSON.parse(String(message)) as Record<string, unknown>;
		} catch {
			return {};
		}
	});
}

/**
 * `pending` is the only status this build writes. The retired ones are still
 * inserted by these tests on purpose: rows carrying them exist in production
 * until the prune drains them.
 */
type BotNotificationStatus = "pending" | "delivered_to_loop" | "read_or_consumed" | "archived";

async function insertBotForRetention(botId: string, options: { deletedAt?: string } = {}): Promise<void> {
	const now = "2026-01-01T00:00:00.000Z";
	// bots_index enforces a live handle claim by trigger, so a fixture row needs
	// one even though nothing in these tests reads the handle.
	await testEnv.BICKR_D1.prepare(
		`INSERT OR IGNORE INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		) VALUES ('bot_handle', 'wld_retention', ?, 'bot', ?, 'usr_retention', 'active', NULL, ?, ?)`,
	)
		.bind(`handle-${botId}`, botId, now, now)
		.run();
	await testEnv.BICKR_D1.prepare(
		`INSERT OR IGNORE INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, display_name,
			owner_user_id, short_bio, created_at, updated_at, deleted_at, lifecycle_state
		) VALUES (?, 'wld_retention', 'retention-world', ?, 'Retention bot', 'usr_retention', 'Bio', ?, ?, ?, 'active')`,
	)
		.bind(botId, `handle-${botId}`, now, now, options.deletedAt ?? null)
		.run();
}

async function insertBotNotificationForRetention(input: {
	id: string;
	status: BotNotificationStatus;
	createdAt: string;
	botId?: string;
	notificationType?: string;
}): Promise<void> {
	const botId = input.botId ?? "bot_retention";
	const notificationType = input.notificationType ?? "system";
	// The prune deletes notifications of a bot that is missing from bots_index, so
	// a retention fixture needs a live bot unless it is testing exactly that.
	await insertBotForRetention(botId);
	await testEnv.BICKR_KV.put(kvKeys.notification(botId, input.id), JSON.stringify({
		id: input.id,
		type: "notification",
		notificationType,
		botId,
		status: input.status,
		createdAt: input.createdAt,
	}));
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO notifications (
			notification_id, world_id, bot_id, type, source_object_id, status, message, message_lang,
			created_at, delivered_at, read_at
		) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
	)
		.bind(
			input.id,
			"wld_retention",
			botId,
			notificationType,
			input.status,
			`Notification ${input.id}`,
			input.createdAt,
			input.status === "delivered_to_loop" ? input.createdAt : null,
			input.status === "read_or_consumed" ? input.createdAt : null,
		)
		.run();
}

async function botNotificationRowIds(): Promise<string[]> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT notification_id AS id
		 FROM notifications
		 ORDER BY notification_id`,
	).all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

async function botNotificationKvExists(id: string, botId = "bot_retention"): Promise<boolean> {
	return (await testEnv.BICKR_KV.get(botNotificationKvKey(id, botId))) !== null;
}

function botNotificationKvKey(id: string, botId = "bot_retention"): string {
	return kvKeys.notification(botId, id);
}

function kvWithScriptedDeletes(failingKeys: ReadonlySet<string> = new Set()): KVNamespaceLike & { deletedKeys: string[] } {
	const deletedKeys: string[] = [];
	return {
		deletedKeys,
		get: (key, options) => testEnv.BICKR_KV.get(key, options),
		put: (key, value, options) => testEnv.BICKR_KV.put(key, value, options),
		delete: async (key) => {
			deletedKeys.push(key);
			if (failingKeys.has(key)) {
				throw new Error(`Scripted KV delete failure for ${key}`);
			}
			await testEnv.BICKR_KV.delete(key);
		},
	};
}

async function humanNotificationExists(id: string): Promise<boolean> {
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT notification_id AS id
		 FROM human_notifications
		 WHERE notification_id = ?`,
	)
		.bind(id)
		.first<{ id: string }>();
	return row !== null;
}

async function insertBotSeenContentForRetention(input: {
	id: string;
	lastSeenAt: string;
	botId?: string;
	objectType?: "thread" | "comment" | "bot";
}): Promise<void> {
	const botId = input.botId ?? "bot_seen_retention";
	const objectType = input.objectType ?? "thread";
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bot_seen_content (
			bot_id, object_type, object_id, seen_via, first_seen_at, last_seen_at, source_id
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			botId,
			objectType,
			input.id,
			"retention-test",
			input.lastSeenAt,
			input.lastSeenAt,
			null,
		)
		.run();
}

async function botSeenContentRowIds(): Promise<string[]> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT object_id AS id
		 FROM bot_seen_content
		 ORDER BY object_id`,
	).all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

async function staleBotSeenContentRowCount(now: string): Promise<number> {
	const cutoff = daysBefore(now, 90);
	const row = await testEnv.BICKR_D1.prepare(
		`SELECT COUNT(*) AS count
		 FROM bot_seen_content
		 WHERE last_seen_at < ?`,
	)
		.bind(cutoff)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function insertBotInferenceUsageForRetention(input: { sourceUsageId: number; createdAt: string }): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bot_inference_usage (
			bot_id, owner_user_id, home_world_id, home_world_handle, source_usage_id,
			run_id, request_seq, created_at, requested_model, response_model, model,
			context_window_tokens, provider_base_url, provider_name, prompt_tokens,
			completion_tokens, total_tokens, cached_tokens, reasoning_tokens, cost, exported_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			"bot_retention_usage",
			"usr_retention_usage",
			"wld_retention",
			"retention-world",
			input.sourceUsageId,
			`run-retention-${input.sourceUsageId}`,
			input.sourceUsageId,
			input.createdAt,
			"test/model",
			null,
			"test/model",
			16_000,
			"https://provider.example.test",
			null,
			100,
			20,
			120,
			0,
			0,
			null,
			input.createdAt,
		)
		.run();
}

async function botInferenceUsageSourceIds(): Promise<number[]> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT source_usage_id AS sourceUsageId
		 FROM bot_inference_usage
		 ORDER BY source_usage_id`,
	).all<{ sourceUsageId: number }>();
	return (result.results ?? []).map((row) => row.sourceUsageId);
}

async function insertSpotlightDeliveryForRetention(input: {
	spotlightId: string;
	createdAt: string;
	botId?: string;
	status?: string;
}): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO spotlight_deliveries (
			spotlight_id, user_id, bot_id, world_id, forum_id, thread_id,
			target_type, target_ids_json, focus_text, injected_text, status, error_message, created_at
		) VALUES (?, 'usr_retention', ?, 'wld_retention', 'frm_retention', NULL,
			'thread', '["thr_retention"]', NULL, 'Injected text', ?, NULL, ?)`,
	)
		.bind(input.spotlightId, input.botId ?? "bot_retention_spotlight", input.status ?? "injected", input.createdAt)
		.run();
}

async function spotlightDeliverySpotlightIds(): Promise<string[]> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT spotlight_id AS id FROM spotlight_deliveries ORDER BY spotlight_id`,
	).all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

async function insertHumanNotificationForRetention(input: {
	id: string;
	createdAt: string;
	readAt?: string | null;
	archivedAt?: string | null;
	eventKey?: string;
	notificationType?: string;
}): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO human_notifications (
			notification_id, user_id, world_id, event_key, notification_type,
			actor_bot_id, actor_handle, actor_display_name, source_type, source_id,
			target_type, target_id, title, body, url_path, spotlight_id, spotlight_label,
			created_at, read_at, archived_at
		) VALUES (?, 'usr_retention', 'wld_retention', ?, ?, NULL, NULL, NULL, NULL, NULL,
			NULL, NULL, 'Title', 'Body', '/', NULL, NULL, ?, ?, ?)`,
	)
		.bind(
			input.id,
			input.eventKey ?? `event:${input.id}`,
			input.notificationType ?? "mention",
			input.createdAt,
			input.readAt ?? null,
			input.archivedAt ?? null,
		)
		.run();
}

async function humanNotificationRowIds(): Promise<string[]> {
	const result = await testEnv.BICKR_D1.prepare(
		`SELECT notification_id AS id FROM human_notifications ORDER BY notification_id`,
	).all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}

function daysBefore(now: string, days: number): string {
	return new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("Forum coordinator", () => {

	it("supports bot-authored threads, replies, votes, follows, notifications, and search", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums",
					"POST",
					{ handle: "debate", description: "Arguments with indexes" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const forum = ((await forumResponse.json()) as { data: { forum: { id: string } } }).data.forum;

		const botOne = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "index-bard",
						displayName: "Index Bard",
						shortBio: "Turns indexes into couplets.",
						prompt: "Post about indexes.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const botTwo = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "cache-critic",
						displayName: "Cache Critic",
						shortBio: "Complains about stale reads.",
						prompt: "Reply to threads.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const botOneId = ((await botOne.json()) as { data: { bot: BotBody } }).data.bot.id;
		const botTwoId = ((await botTwo.json()) as { data: { bot: BotBody } }).data.bot.id;

		const threadResponse = await handleForumCoordinatorRequest(
			jsonRequest(
				`http://example.com/forums/${forum.id}/threads`,
				"POST",
				{ title: requiredLt("Index repair ballad"), body: requiredLt("Every stale row needs a chorus.") },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
		);
		expect(threadResponse.status).toBe(401);

		const threadRequest = jsonRequest(
			`http://example.com/forums/${forum.id}/threads`,
			"POST",
			{ title: requiredLt("Index repair ballad"), body: requiredLt("Every stale row needs a chorus.") },
		);
		threadRequest.headers.set("x-bickr-bot-id", botOneId);
		const createdThreadResponse = await handleForumCoordinatorRequest(threadRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(createdThreadResponse.status).toBe(201);
		const thread = (await createdThreadResponse.json()) as { data: { thread: { id: string; rootCommentId: string } } };

		const commentRequest = jsonRequest(
			`http://example.com/threads/${thread.data.thread.id}/comments`,
			"POST",
			{ body: requiredLt("This chorus needs a fresher cache.") },
		);
		commentRequest.headers.set("x-bickr-bot-id", botTwoId);
		const commentResponse = await handleForumCoordinatorRequest(commentRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(commentResponse.status).toBe(201);
		const commentPayload = (await commentResponse.json()) as {
			data: { thread: { comments: Array<{ id: string; body: LocalizedText }> } };
		};
		const commentId = commentPayload.data.thread.comments.find((comment) => localizedTextString(comment.body) === "This chorus needs a fresher cache.")?.id;
		if (!commentId) {
			throw new Error("Created comment ID not found.");
		}

		const voteRequest = jsonRequest(
			"http://example.com/votes",
			"POST",
			{ threadId: thread.data.thread.id, value: 1, reason: requiredLt("The root comment is useful.") },
		);
		voteRequest.headers.set("x-bickr-bot-id", botTwoId);
		const voteResponse = await handleForumCoordinatorRequest(voteRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(voteResponse.status).toBe(200);

		const commentVoteRequest = jsonRequest(
			"http://example.com/votes",
			"POST",
			{ commentId, value: -1 },
		);
		commentVoteRequest.headers.set("x-bickr-bot-id", botOneId);
		const commentVoteResponse = await handleForumCoordinatorRequest(commentVoteRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(commentVoteResponse.status).toBe(200);

		const commentVotesResponse = await commentVotes(
			contextFor<typeof commentVotes>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/debate/threads/${thread.data.thread.id}/comments/${commentId}/votes`,
					{ headers: { cookie } },
				),
				{
					worldHandle: "patch-notes",
					forumHandle: "debate",
					threadId: thread.data.thread.id,
					commentId: commentId ?? "",
				},
			),
		);
		expect(commentVotesResponse.status).toBe(200);
		const commentVotesPayload = (await commentVotesResponse.json()) as {
			data: { votes: Array<{ handle: string; displayName: string; value: number }> };
		};
		expect(commentVotesPayload.data.votes).toMatchObject([
			{ handle: "index-bard", displayName: lt("Index Bard"), value: -1 },
		]);

		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, botTwoId, botOneId, undefined, {
			reason: "Index Bard keeps writing useful index notes.",
		});
		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, botOneId);
		expect(notifications.map((notification) => notification.notificationType)).toEqual(
			expect.arrayContaining(["reply", "vote", "follow"]),
		);
		const search = await searchThreads(testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "chorus");
		expect(search.some((result) => result.threadId === thread.data.thread.id)).toBe(true);

		const botSearch = await searchBots(testEnv.BICKR_KV, testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "stale");
		expect(botSearch.find((result) => result.handle === "cache-critic")).toMatchObject({
			displayName: lt("Cache Critic"),
			shortBio: lt("Complains about stale reads."),
			source: "text",
		});
		expect(botSearch.some((result) => "prompt" in result || "inferenceSettings" in result)).toBe(false);
		await expect(searchThreads(testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "%_".repeat(500))).resolves.toEqual([]);
		await expect(searchBots(testEnv.BICKR_KV, testEnv.BICKR_D1, notifications[0]?.worldId ?? "", "%_".repeat(500))).resolves.toEqual([]);

		const profile = await botPublicProfileByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"cache-critic",
		);
		expect(profile).toMatchObject({
			handle: "cache-critic",
			displayName: lt("Cache Critic"),
			shortBio: lt("Complains about stale reads."),
		});
		expect("prompt" in profile).toBe(false);

		const activity = await botActivityFeedByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"cache-critic",
		);
		expect(activity.activities.map((item) => item.type)).toEqual(
			expect.arrayContaining(["comment", "vote", "follow"]),
		);
		expect(activity.activities).toEqual(expect.arrayContaining([
			expect.objectContaining({
				type: "comment",
				parentComment: {
					commentId: thread.data.thread.rootCommentId,
					authorHandle: "index-bard",
					authorDisplayName: lt("Index Bard"),
					bodyPreview: lt("Every stale row needs a chorus."),
				},
			}),
			expect.objectContaining({
				type: "vote",
				targetComment: {
					commentId: thread.data.thread.rootCommentId,
					authorHandle: "index-bard",
					authorDisplayName: lt("Index Bard"),
					bodyPreview: lt("Every stale row needs a chorus."),
				},
			}),
		]));

		const followGraph = await botFollowGraphByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"cache-critic",
		);
		expect(followGraph.following.map((bot) => bot.handle)).toEqual(["index-bard"]);
		expect(followGraph.followers).toEqual([]);

		const reverseFollowGraph = await botFollowGraphByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			notifications[0]?.worldId ?? "",
			"index-bard",
		);
		expect(reverseFollowGraph.followers.map((bot) => bot.handle)).toEqual(["cache-critic"]);

		const activityResponse = await botActivity(
			contextFor<typeof botActivity>(
				new Request("http://example.com/api/worlds/patch-notes/bots/cache-critic/activity"),
				{ worldHandle: "patch-notes", botHandle: "cache-critic" },
			),
		);
		expect(await activityResponse.json()).toMatchObject({
			ok: true,
			data: {
				feed: {
					bot: { handle: "cache-critic" },
					activities: expect.arrayContaining([
						expect.objectContaining({ type: "comment" }),
						expect.objectContaining({
							type: "vote",
							id: `vote:comment:${thread.data.thread.rootCommentId}`,
							reason: requiredLt("The root comment is useful."),
							targetComment: expect.objectContaining({
								commentId: thread.data.thread.rootCommentId,
								authorHandle: "index-bard",
								bodyPreview: lt("Every stale row needs a chorus."),
							}),
						}),
						expect.objectContaining({
							type: "follow",
							bot: expect.objectContaining({ handle: "index-bard" }),
							reason: unspecifiedLt("Index Bard keeps writing useful index notes."),
						}),
					]),
				},
			},
		});
		const followsResponse = await botFollows(
			contextFor<typeof botFollows>(
				new Request("http://example.com/api/worlds/patch-notes/bots/cache-critic/follows"),
				{ worldHandle: "patch-notes", botHandle: "cache-critic" },
			),
		);
			expect(await followsResponse.json()).toMatchObject({
				ok: true,
				data: {
					graph: {
						bot: { handle: "cache-critic" },
						following: [expect.objectContaining({ handle: "index-bard" })],
						followers: [],
					},
				},
			});

			const otherWorldResponse = await createWorld(
				contextFor<typeof createWorld>(
					jsonRequest(
						"http://example.com/api/worlds",
						"POST",
						{
							handle: "elsewhere",
							name: "Elsewhere",
							description: "Activity that must not leak into patch notes.",
						},
						cookie,
					),
				),
			);
			expect(otherWorldResponse.status).toBe(201);
			const otherForumResponse = await createForum(
				contextFor<typeof createForum>(
					jsonRequest(
						"http://example.com/api/worlds/elsewhere/forums",
						"POST",
						{ handle: "offsite", description: "A separate forum" },
						cookie,
					),
					{ worldHandle: "elsewhere" },
				),
			);
			const otherForum = ((await otherForumResponse.json()) as { data: { forum: { id: string } } }).data.forum;
			const otherBotResponse = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/elsewhere/bots",
						"POST",
						{
							handle: "offworld-poster",
							displayName: "Offworld Poster",
							shortBio: "Posts somewhere else.",
							prompt: "Post elsewhere.",
						},
						cookie,
					),
					{ worldHandle: "elsewhere" },
				),
			);
			const otherBotId = ((await otherBotResponse.json()) as { data: { bot: BotBody } }).data.bot.id;
			const otherThreadRequest = jsonRequest(
				`http://example.com/forums/${otherForum.id}/threads`,
				"POST",
				{ title: requiredLt("Elsewhere only"), body: requiredLt("This should not appear in patch notes activity.") },
			);
			otherThreadRequest.headers.set("x-bickr-bot-id", otherBotId);
			await handleForumCoordinatorRequest(otherThreadRequest, {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			});

			await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, botTwoId, botOneId, undefined, {
				reason: "Index Bard no longer needs close tracking.",
			});
			const worldActivityFeed = await worldActivityFeedByHandle(
				testEnv.BICKR_D1,
				notifications[0]?.worldId ?? "",
				"patch-notes",
				100,
			);
			expect(worldActivityFeed.activities).toEqual(expect.arrayContaining([
				expect.objectContaining({
					type: "thread",
					actor: expect.objectContaining({ handle: "index-bard" }),
					title: lt("Index repair ballad"),
				}),
				expect.objectContaining({
					type: "comment",
					actor: expect.objectContaining({ handle: "cache-critic" }),
					bodyPreview: lt("This chorus needs a fresher cache."),
				}),
				expect.objectContaining({
					type: "vote",
					actor: expect.objectContaining({ handle: "cache-critic" }),
					commentId: thread.data.thread.rootCommentId,
				}),
				expect.objectContaining({
					type: "follow",
					actor: expect.objectContaining({ handle: "cache-critic" }),
					bot: expect.objectContaining({ handle: "index-bard" }),
				}),
				expect.objectContaining({
					type: "unfollow",
					actor: expect.objectContaining({ handle: "cache-critic" }),
					bot: expect.objectContaining({ handle: "index-bard" }),
					reason: unspecifiedLt("Index Bard no longer needs close tracking."),
				}),
			]));
			expect(worldActivityFeed.activities.some((item) => item.actor.handle === "offworld-poster")).toBe(false);

			const worldActivityResponse = await worldActivity(
				contextFor<typeof worldActivity>(
					new Request("http://example.com/api/worlds/patch-notes/activity?limit=100"),
					{ worldHandle: "patch-notes" },
				),
			);
			expect(await worldActivityResponse.json()).toMatchObject({
				ok: true,
				data: {
					feed: {
						world: { handle: "patch-notes" },
						activities: expect.arrayContaining([
							expect.objectContaining({
								type: "unfollow",
								actor: expect.objectContaining({ handle: "cache-critic" }),
							}),
						]),
					},
				},
			});

			const myBotsResponse = await meBots(
				contextFor<typeof meBots>(new Request("http://example.com/api/me/bots", { headers: { cookie } })),
		);
		const myBotsPayload = (await myBotsResponse.json()) as { data: { bots: BotBody[] } };
		const activeBot = myBotsPayload.data.bots.find((bot) => bot.handle === "cache-critic");
		expect(activeBot?.lastActiveAt).toBeDefined();
		expect(Date.parse(activeBot?.lastActiveAt ?? "")).toBeGreaterThanOrEqual(Date.parse(activeBot?.createdAt ?? ""));

		const humanNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, url_path AS urlPath
			 FROM human_notifications
			 ORDER BY created_at ASC`,
		).all<{ body: string; notificationType: string; title: string; urlPath: string }>();
		expect((humanNotifications.results ?? []).map((row) => row.notificationType)).toEqual(
			expect.arrayContaining(["thread_created", "comment_created", "vote_cast", "bot_followed"]),
		);
		const followNotice = (humanNotifications.results ?? []).find((row) => row.notificationType === "bot_followed");
		expect(followNotice?.body).toBe("u/cache-critic followed u/index-bard.\nIndex Bard keeps writing useful index notes.");
		expect(followNotice?.urlPath).toMatch(/^\/w\/patch-notes\/u\/cache-critic\?tab=activity&activity=act_/);
		const voteNotice = (humanNotifications.results ?? []).find((row) => row.notificationType === "vote_cast");
		expect(voteNotice?.title).toBe("Cache Critic upvoted a comment in");
		expect(voteNotice?.body).toBe("Index repair ballad\nThe root comment is useful.");
		expect(voteNotice?.urlPath).toBe(`/w/patch-notes/u/cache-critic?tab=activity&activity=vote%3Acomment%3A${thread.data.thread.rootCommentId}`);
	});

	it("orders hot threads by the query-time formula and expires threads outside the decay window", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "hot-decay");
		const author = await createBotForTest(cookie, "hot-author");
		const now = "2026-05-08T12:00:00.000Z";
		vi.useFakeTimers();
		try {
			const createAt = async (createdAt: string, title: string): Promise<TestThread> => {
				vi.setSystemTime(new Date(createdAt));
				return createThreadForTest(forum.id, author.id, title, `${title} body.`);
			};
			const expired = await createAt("2026-05-01T12:00:00.000Z", "Expired hot thread");
			const revived = await createAt("2026-05-01T00:00:00.000Z", "Revived hot thread");
			const almostExpired = await createAt("2026-05-01T13:00:00.000Z", "Almost expired hot thread");
			const halfAge = await createAt("2026-05-05T00:00:00.000Z", "Half age hot thread");
			const fresh = await createAt(now, "Fresh hot thread");

			vi.setSystemTime(new Date(now));
			await createCommentForTest(revived.id, author.id, "A fresh comment revives this older thread.");
			await refreshThreadHotScores(testEnv.BICKR_D1, now);
			const inputs = new Map<string, { voteScore: number; recentCommentCount: number; lastActivityAt: string }>([
				[fresh.id, { voteScore: 1, recentCommentCount: 0, lastActivityAt: now }],
				[halfAge.id, { voteScore: 4, recentCommentCount: 0, lastActivityAt: "2026-05-05T00:00:00.000Z" }],
				[almostExpired.id, { voteScore: 100, recentCommentCount: 0, lastActivityAt: "2026-05-01T13:00:00.000Z" }],
				[revived.id, { voteScore: 0, recentCommentCount: 1, lastActivityAt: now }],
			]);
			for (const [threadId, input] of inputs) {
				await testEnv.BICKR_D1.prepare(
					`UPDATE threads_index
					 SET vote_score = ?, recent_comment_count = ?, last_activity_at = ?
					 WHERE thread_id = ?`,
				)
					.bind(input.voteScore, input.recentCommentCount, input.lastActivityAt, threadId)
					.run();
			}

			const hot = await listThreads(testEnv.BICKR_D1, forum.id, "hot", 10, 0, now);
			const hotIds = hot.map((thread) => thread.id);
			const expectedIds = [...inputs]
				.sort(([, left], [, right]) => threadHotScore(right, now) - threadHotScore(left, now))
				.map(([threadId]) => threadId);
			expect(hotIds).toEqual(expectedIds);
			expect(hotIds).not.toContain(expired.id);
			expect((await listHotThreads(testEnv.BICKR_D1, forum.worldId, 10, now)).map((thread) => thread.id)).toEqual(expectedIds);
			expect(threadHotScore({
				voteScore: 100,
				recentCommentCount: 100,
				lastActivityAt: "2026-05-01T12:00:00.000Z",
			}, now)).toBe(0);
			const recent = await listThreads(testEnv.BICKR_D1, forum.id, "recent", 10);
			expect(recent.map((thread) => thread.id)).toContain(expired.id);
			await expect(readThread(testEnv.BICKR_KV, expired.id)).resolves.toMatchObject({ id: expired.id });
		} finally {
			vi.useRealTimers();
		}
	});

	it("marks thread summaries locked at the effective comment limit", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "thread-lock-summary");
		await setForumThreadCommentLimit(forum.id, 2);
		const author = await createBotForTest(cookie, "thread-lock-author");
		const thread = await createThreadForTest(forum.id, author.id, "Thread lock summary", "Root body.");
		await createCommentForTest(thread.id, author.id, "Comment at the limit.");

		await expect(listThreads(testEnv.BICKR_D1, forum.id, "recent", 10)).resolves.toEqual([
			expect.objectContaining({
				id: thread.id,
				commentCount: 2,
				lock: { kind: "comment_limit", limit: 2 },
			}),
		]);
		await expect(listHotThreads(testEnv.BICKR_D1, forum.worldId, 10)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: thread.id,
					lock: { kind: "comment_limit", limit: 2 },
				}),
			]),
		);
	});

	it("maintains query-time hot-score inputs for votes and comment mutations", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "hot-mutations");
		const author = await createBotForTest(cookie, "hot-root-author");
		const voter = await createBotForTest(cookie, "hot-voter");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
			const thread = await createThreadForTest(forum.id, author.id, "Mutable hot thread", "Root body.");
			const reply = await createCommentForTest(thread.id, author.id, "Reply body.");

			const voteNow = "2026-05-05T00:00:00.000Z";
			vi.setSystemTime(new Date(voteNow));
			const beforeVote = await readThread(testEnv.BICKR_KV, thread.id);
			const rootVoted = await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
				botId: voter.id,
				targetType: "comment",
				targetId: thread.rootCommentId,
				value: 1,
			}, voteNow);
			expect(rootVoted.voteScore).toBe(1);
			expect(rootVoted.recentCommentCount).toBe(beforeVote.recentCommentCount);

			const commentVoted = await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
				botId: voter.id,
				targetType: "comment",
				targetId: reply.id,
				value: -1,
			}, voteNow);
			expect(commentVoted.voteScore).toBe(rootVoted.voteScore);

			const expiredNow = "2026-05-09T12:00:00.000Z";
			vi.setSystemTime(new Date(expiredNow));
			await createCommentForTest(thread.id, voter.id, "Fresh follow-up.");
			const revivedThread = await readThread(testEnv.BICKR_KV, thread.id);
			expect(revivedThread.recentCommentCount).toBe(1);
			expect((await listHotThreads(testEnv.BICKR_D1, forum.worldId, 10, expiredNow)).map((item) => item.id)).toContain(thread.id);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refreshes recent comment counts from the forum coordinator cron", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "hot-cron");
		const author = await createBotForTest(cookie, "hot-cron-author");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
			const thread = await createThreadForTest(forum.id, author.id, "Cron refreshed hot thread", "Root body.");
			const storedRecentCommentCount = async (): Promise<number> => {
				const row = await testEnv.BICKR_D1.prepare(
					`SELECT recent_comment_count AS recentCommentCount FROM threads_index WHERE thread_id = ?`,
				)
					.bind(thread.id)
					.first<{ recentCommentCount: number }>();
				if (!row) {
					throw new Error("Thread index row was not found.");
				}
				return row.recentCommentCount;
			};

			const firstRefresh = "2026-05-02T00:00:00.000Z";
			await runForumCoordinatorScheduled(firstRefresh);
			expect(await storedRecentCommentCount()).toBe(1);

			await runForumCoordinatorScheduled("2026-05-08T00:00:00.000Z");
			expect(await storedRecentCommentCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("prunes expired bot notifications from the dedicated prune cron", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		await insertBotNotificationForRetention({
			id: "ntf_expired_pending",
			status: "pending",
			createdAt: daysBefore(now, 15),
		});
		// Rows the retired statuses left behind expire whatever their age: nothing
		// writes them any more, and nothing can deliver them.
		await insertBotNotificationForRetention({
			id: "ntf_expired_delivered",
			status: "delivered_to_loop",
			createdAt: daysBefore(now, 1),
		});
		await insertBotNotificationForRetention({
			id: "ntf_expired_read",
			status: "read_or_consumed",
			createdAt: daysBefore(now, 1),
		});
		await insertBotNotificationForRetention({
			id: "ntf_expired_archived",
			status: "archived",
			createdAt: daysBefore(now, 1),
		});
		await insertBotNotificationForRetention({
			id: "ntf_young_pending",
			status: "pending",
			createdAt: daysBefore(now, 13),
		});
		await insertHumanNotificationForRetention({ id: "hnt_old_out_of_scope", createdAt: daysBefore(now, 120) });

		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		let pruneLog: Record<string, unknown> | undefined;
		try {
			await runForumCoordinatorScheduled(now, forumCoordinatorNotificationPruneCronExpression);
			pruneLog = scheduledLogs(consoleLog).find((payload) => payload.event === "notification_prune");
		} finally {
			consoleLog.mockRestore();
		}

		expect(await botNotificationRowIds()).toEqual(["ntf_young_pending"]);
		for (const id of ["ntf_expired_pending", "ntf_expired_delivered", "ntf_expired_read", "ntf_expired_archived"]) {
			expect(await botNotificationKvExists(id)).toBe(false);
		}
		expect(await botNotificationKvExists("ntf_young_pending")).toBe(true);
		expect(await humanNotificationExists("hnt_old_out_of_scope")).toBe(true);
		expect(pruneLog).toMatchObject({
			event: "notification_prune",
			notificationPrune: {
				deletedRows: 4,
				kvDeleteFailures: 0,
				orphanedBotRows: 0,
			},
		});
	});

	it("keeps the notification prune off the daily maintenance cron", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		await insertBotNotificationForRetention({
			id: "ntf_expired_for_daily_run",
			status: "pending",
			createdAt: daysBefore(now, 15),
		});
		await insertBotSeenContentForRetention({
			id: "thr_seen_expired",
			lastSeenAt: daysBefore(now, 91),
		});
		await insertBotSeenContentForRetention({
			id: "thr_seen_retained",
			lastSeenAt: daysBefore(now, 89),
		});
		await insertBotInferenceUsageForRetention({
			sourceUsageId: 1,
			createdAt: daysBefore(now, botInferenceUsageRetentionDays + 1),
		});
		await insertBotInferenceUsageForRetention({
			sourceUsageId: 2,
			createdAt: daysBefore(now, botInferenceUsageRetentionDays - 1),
		});
		await insertSpotlightDeliveryForRetention({
			spotlightId: "spl_daily_expired",
			createdAt: daysBefore(now, spotlightDeliveryRetentionDays + 1),
		});
		await insertSpotlightDeliveryForRetention({
			spotlightId: "spl_daily_retained",
			createdAt: daysBefore(now, spotlightDeliveryRetentionDays - 1),
		});
		await insertHumanNotificationForRetention({
			id: "hnt_daily_expired",
			createdAt: daysBefore(now, humanNotificationRetentionDays + 1),
			readAt: daysBefore(now, humanNotificationRetentionDays + 1),
		});
		await insertHumanNotificationForRetention({
			id: "hnt_daily_retained",
			createdAt: daysBefore(now, humanNotificationRetentionDays - 1),
		});

		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		let retentionLog: Record<string, unknown> | undefined;
		try {
			await runForumCoordinatorScheduled(now);
			retentionLog = scheduledLogs(consoleLog).find((payload) => payload.event === "retention_prune");
		} finally {
			consoleLog.mockRestore();
		}

		// The daily run does its own sweeps and leaves notifications to the 6-hourly
		// trigger, which is what gives that pass a subrequest budget of its own.
		expect(await botNotificationRowIds()).toEqual(["ntf_expired_for_daily_run"]);
		expect(await botSeenContentRowIds()).toEqual(["thr_seen_retained"]);
		expect(await botInferenceUsageSourceIds()).toEqual([2]);
		expect(await spotlightDeliverySpotlightIds()).toEqual(["spl_daily_retained"]);
		expect(await humanNotificationRowIds()).toEqual(["hnt_daily_retained"]);
		expect(retentionLog).toMatchObject({
			event: "retention_prune",
			hotScores: { recentCommentCountsRefreshed: true },
			botSeenContentPrune: {
				deletedRows: 1,
			},
			inferenceUsagePrune: {
				deletedRows: 1,
			},
			spotlightDeliveryPrune: {
				deletedRows: 1,
				budgetExhausted: false,
			},
			humanNotificationPrune: {
				expired: {
					deletedRows: 1,
					budgetExhausted: false,
				},
				orphanedSources: {
					scannedRows: 0,
					deletedRows: 0,
					budgetExhausted: false,
				},
			},
			indexRepair: {
				scanned: 0,
				repaired: 0,
				budgetExhausted: false,
			},
		});
		expect(retentionLog).not.toHaveProperty("notificationPrune");
	});

	it("logs the retention_prune summary before a failed maintenance task propagates", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		await testEnv.BICKR_D1.prepare(`ALTER TABLE bot_seen_content RENAME TO bot_seen_content_hidden`).run();

		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		let retentionLog: Record<string, unknown> | undefined;
		try {
			await expect(runForumCoordinatorScheduled(now)).rejects.toThrow();
			retentionLog = scheduledLogs(consoleLog).find((payload) => payload.event === "retention_prune");
		} finally {
			consoleLog.mockRestore();
			await testEnv.BICKR_D1.prepare(`ALTER TABLE bot_seen_content_hidden RENAME TO bot_seen_content`).run();
		}

		expect(retentionLog).toMatchObject({
			event: "retention_prune",
			indexRepair: { scanned: 0, repaired: 0, budgetExhausted: false },
		});
		expect((retentionLog?.botSeenContentPrune as { error?: string })?.error).toContain("bot_seen_content");
	});

	it("logs the notification prune counters before a failed prune propagates", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		await testEnv.BICKR_D1.prepare(`ALTER TABLE notifications RENAME TO notifications_hidden`).run();

		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		let pruneLog: Record<string, unknown> | undefined;
		try {
			await expect(runForumCoordinatorScheduled(now, forumCoordinatorNotificationPruneCronExpression)).rejects.toThrow();
			pruneLog = scheduledLogs(consoleLog).find((payload) => payload.event === "notification_prune");
		} finally {
			consoleLog.mockRestore();
			await testEnv.BICKR_D1.prepare(`ALTER TABLE notifications_hidden RENAME TO notifications`).run();
		}

		// A partial run's counters are the only evidence of how far it got, so they
		// are logged before the failure is rethrown.
		expect((pruneLog?.notificationPrune as { error?: string })?.error).toContain("notifications");
	});

	it("prunes bot seen-content rows older than the retention cutoff", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		await insertBotSeenContentForRetention({
			id: "thr_old_seen",
			lastSeenAt: daysBefore(now, 91),
		});
		await insertBotSeenContentForRetention({
			id: "thr_cutoff_seen",
			lastSeenAt: daysBefore(now, 90),
		});
		await insertBotSeenContentForRetention({
			id: "thr_recent_seen",
			lastSeenAt: daysBefore(now, 89),
		});

		const result = await pruneExpiredBotSeenContent(testEnv.BICKR_D1, {
			now,
			batchSize: 10,
			maxRowsPerRun: 10,
		});

		expect(result).toEqual({
			deletedRows: 1,
			batches: 1,
			budgetExhausted: false,
		});
		expect(await botSeenContentRowIds()).toEqual(["thr_cutoff_seen", "thr_recent_seen"]);
	});

	it("prunes spotlight deliveries older than the retention cutoff", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		await insertSpotlightDeliveryForRetention({
			spotlightId: "spl_old",
			createdAt: daysBefore(now, spotlightDeliveryRetentionDays + 1),
		});
		await insertSpotlightDeliveryForRetention({
			spotlightId: "spl_cutoff",
			createdAt: daysBefore(now, spotlightDeliveryRetentionDays),
		});
		await insertSpotlightDeliveryForRetention({
			spotlightId: "spl_recent",
			createdAt: daysBefore(now, spotlightDeliveryRetentionDays - 1),
		});

		const result = await pruneExpiredSpotlightDeliveries(testEnv.BICKR_D1, {
			now,
			batchSize: 10,
			maxRowsPerRun: 10,
		});

		// Exactly at the cutoff is retained: the predicate is strictly older-than.
		expect(result).toEqual({ deletedRows: 1, batches: 1, budgetExhausted: false });
		expect(await spotlightDeliverySpotlightIds()).toEqual(["spl_cutoff", "spl_recent"]);
	});

	it("resumes spotlight delivery pruning after hitting the per-run row budget", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		for (let index = 0; index < 5; index += 1) {
			await insertSpotlightDeliveryForRetention({
				spotlightId: `spl_budget_${index}`,
				createdAt: daysBefore(now, 30 + index),
			});
		}
		await insertSpotlightDeliveryForRetention({ spotlightId: "spl_budget_recent", createdAt: now });

		const firstRun = await pruneExpiredSpotlightDeliveries(testEnv.BICKR_D1, {
			now,
			batchSize: 2,
			maxRowsPerRun: 3,
		});
		expect(firstRun).toEqual({ deletedRows: 3, batches: 2, budgetExhausted: true });

		const secondRun = await pruneExpiredSpotlightDeliveries(testEnv.BICKR_D1, {
			now,
			batchSize: 2,
			maxRowsPerRun: 3,
		});
		expect(secondRun).toEqual({ deletedRows: 2, batches: 1, budgetExhausted: false });
		expect(await spotlightDeliverySpotlightIds()).toEqual(["spl_budget_recent"]);
	});

	it("prunes human notifications older than the cutoff regardless of read or archived state", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		const expired = daysBefore(now, humanNotificationRetentionDays + 1);
		await insertHumanNotificationForRetention({ id: "hnt_old_unread", createdAt: expired });
		await insertHumanNotificationForRetention({ id: "hnt_old_read", createdAt: expired, readAt: expired });
		await insertHumanNotificationForRetention({ id: "hnt_old_archived", createdAt: expired, archivedAt: expired });
		await insertHumanNotificationForRetention({
			id: "hnt_cutoff",
			createdAt: daysBefore(now, humanNotificationRetentionDays),
		});
		await insertHumanNotificationForRetention({
			id: "hnt_recent",
			createdAt: daysBefore(now, humanNotificationRetentionDays - 1),
		});

		const result = await pruneExpiredHumanNotifications(testEnv.BICKR_D1, {
			now,
			batchSize: 10,
			maxRowsPerRun: 10,
		});

		expect(result).toEqual({ deletedRows: 3, batches: 1, budgetExhausted: false });
		expect(await humanNotificationRowIds()).toEqual(["hnt_cutoff", "hnt_recent"]);
	});

	it("frees an aged-out human notification event key for a fresh notification", async () => {
		// Accepted behavior change (§2.6): bot_followed event keys are id-scoped, so
		// deleting the expired row lets an unfollow -> re-follow after the retention
		// window notify again instead of being suppressed forever.
		const now = "2026-07-01T00:00:00.000Z";
		const eventKey = "bot_followed:bot_follower:bot_followed";
		await insertHumanNotificationForRetention({
			id: "hnt_first_follow",
			createdAt: daysBefore(now, humanNotificationRetentionDays + 1),
			eventKey,
			notificationType: "bot_followed",
		});

		await pruneExpiredHumanNotifications(testEnv.BICKR_D1, { now, batchSize: 10, maxRowsPerRun: 10 });

		await insertHumanNotificationForRetention({
			id: "hnt_second_follow",
			createdAt: now,
			eventKey,
			notificationType: "bot_followed",
		});
		expect(await humanNotificationRowIds()).toEqual(["hnt_second_follow"]);
	});

	it("resumes human notification pruning after hitting the per-run row budget", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		for (let index = 0; index < 5; index += 1) {
			await insertHumanNotificationForRetention({
				id: `hnt_budget_${index}`,
				createdAt: daysBefore(now, 40 + index),
			});
		}
		await insertHumanNotificationForRetention({ id: "hnt_budget_recent", createdAt: now });

		const firstRun = await pruneExpiredHumanNotifications(testEnv.BICKR_D1, {
			now,
			batchSize: 2,
			maxRowsPerRun: 3,
		});
		expect(firstRun).toEqual({ deletedRows: 3, batches: 2, budgetExhausted: true });

		const secondRun = await pruneExpiredHumanNotifications(testEnv.BICKR_D1, {
			now,
			batchSize: 2,
			maxRowsPerRun: 3,
		});
		expect(secondRun).toEqual({ deletedRows: 2, batches: 1, budgetExhausted: false });
		expect(await humanNotificationRowIds()).toEqual(["hnt_budget_recent"]);
	});

	it("resumes bot seen-content pruning after hitting the per-run row budget", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		for (let index = 0; index < 5; index += 1) {
			await insertBotSeenContentForRetention({
				id: `thr_seen_budget_${index}`,
				lastSeenAt: daysBefore(now, 100 + index),
			});
		}
		await insertBotSeenContentForRetention({
			id: "thr_seen_budget_recent",
			lastSeenAt: daysBefore(now, 10),
		});

		const firstRun = await pruneExpiredBotSeenContent(testEnv.BICKR_D1, {
			now,
			batchSize: 2,
			maxRowsPerRun: 3,
		});

		expect(firstRun).toEqual({
			deletedRows: 3,
			batches: 2,
			budgetExhausted: true,
		});
		expect(await staleBotSeenContentRowCount(now)).toBe(2);
		expect(await botSeenContentRowIds()).toContain("thr_seen_budget_recent");

		const secondRun = await pruneExpiredBotSeenContent(testEnv.BICKR_D1, {
			now,
			batchSize: 2,
			maxRowsPerRun: 3,
		});

		expect(secondRun).toEqual({
			deletedRows: 2,
			batches: 1,
			budgetExhausted: false,
		});
		expect(await staleBotSeenContentRowCount(now)).toBe(0);
		expect(await botSeenContentRowIds()).toEqual(["thr_seen_budget_recent"]);
	});

	it("deletes both stores for every expired notification, without a phase split", async () => {
		const now = "2026-08-13T00:00:00.000Z";
		await insertBotNotificationForRetention({
			id: "ntf_expired_old",
			status: "pending",
			createdAt: daysBefore(now, 30),
		});
		await insertBotNotificationForRetention({
			id: "ntf_expired_recent",
			status: "pending",
			createdAt: daysBefore(now, 15),
		});
		await insertBotNotificationForRetention({
			id: "ntf_inside_window",
			status: "pending",
			createdAt: daysBefore(now, 13),
		});
		const kv = kvWithScriptedDeletes();

		const result = await pruneExpiredNotifications(kv, testEnv.BICKR_D1, {
			now,
			selectLimit: 10,
			maxRowsPerRun: 10,
		});

		// Every pruned row's document is deleted explicitly; the KV TTL is only the
		// backstop for a delete that failed.
		expect(result).toMatchObject({
			deletedRows: 2,
			selectedRows: 2,
			kvDeleteFailures: 0,
			orphanedBotRows: 0,
			budgetExhausted: false,
		});
		expect(kv.deletedKeys).toEqual([
			botNotificationKvKey("ntf_expired_old"),
			botNotificationKvKey("ntf_expired_recent"),
		]);
		expect(await botNotificationRowIds()).toEqual(["ntf_inside_window"]);
	});

	it("retains D1 rows when their KV delete fails", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		const failedKey = botNotificationKvKey("ntf_failed_kv_delete");
		await insertBotNotificationForRetention({
			id: "ntf_failed_kv_delete",
			status: "pending",
			createdAt: daysBefore(now, 100),
		});
		await insertBotNotificationForRetention({
			id: "ntf_successful_kv_delete",
			status: "pending",
			createdAt: daysBefore(now, 99),
		});
		const failingKv = kvWithScriptedDeletes(new Set([failedKey]));

		const firstRun = await pruneExpiredNotifications(failingKv, testEnv.BICKR_D1, {
			now,
			selectLimit: 10,
			maxRowsPerRun: 10,
			kvDeleteChunkSize: 2,
		});

		// Documents go first in the prune precisely so the row survives to select
		// the document again: the row is the only record that the document exists.
		expect(firstRun).toMatchObject({
			selectedRows: 2,
			deletedRows: 1,
			kvDeleteFailures: 1,
			budgetExhausted: false,
		});
		expect(await botNotificationRowIds()).toEqual(["ntf_failed_kv_delete"]);
		expect(await botNotificationKvExists("ntf_failed_kv_delete")).toBe(true);
		expect(await botNotificationKvExists("ntf_successful_kv_delete")).toBe(false);

		const retryRun = await pruneExpiredNotifications(kvWithScriptedDeletes(), testEnv.BICKR_D1, {
			now,
			selectLimit: 10,
			maxRowsPerRun: 10,
		});

		expect(retryRun).toMatchObject({
			selectedRows: 1,
			deletedRows: 1,
			kvDeleteFailures: 0,
		});
		expect(await botNotificationRowIds()).toEqual([]);
		expect(await botNotificationKvExists("ntf_failed_kv_delete")).toBe(false);
	});

	it("exempts pending bootstrap notifications from expiry", async () => {
		const now = "2026-12-01T00:00:00.000Z";
		await insertBotNotificationForRetention({
			id: "ntf_bootstrap_pending",
			notificationType: "bootstrap",
			status: "pending",
			createdAt: "2026-06-01T00:00:00.000Z",
		});
		// A bootstrap row carrying a retired status is left alone too. During a
		// deploy window an old-build instance can still be marking a bootstrap
		// delivered, and deleting that row at any age would leave the adoption shim
		// nothing to adopt and let the bootstrap be created a second time.
		await insertBotNotificationForRetention({
			id: "ntf_bootstrap_delivered",
			notificationType: "bootstrap",
			status: "delivered_to_loop",
			createdAt: "2026-06-01T00:00:00.000Z",
		});
		// Control: pending rows of every other type still expire.
		await insertBotNotificationForRetention({
			id: "ntf_system_pending",
			status: "pending",
			createdAt: "2026-06-02T00:00:00.000Z",
		});
		const kv = kvWithScriptedDeletes();

		const result = await pruneExpiredNotifications(kv, testEnv.BICKR_D1, {
			now,
			selectLimit: 10,
			maxRowsPerRun: 10,
		});

		expect(result).toMatchObject({
			deletedRows: 1,
			selectedRows: 1,
			kvDeleteFailures: 0,
		});
		// The pending bootstrap document carries no TTL, so a deleted row would
		// strand it behind a flag that blocks any replacement.
		expect(await botNotificationRowIds()).toEqual(["ntf_bootstrap_delivered", "ntf_bootstrap_pending"]);
		expect(kv.deletedKeys).toEqual([botNotificationKvKey("ntf_system_pending")]);
		expect(await botNotificationKvExists("ntf_bootstrap_pending")).toBe(true);
		expect(await botNotificationKvExists("ntf_bootstrap_delivered")).toBe(true);
	});

	it("deletes every notification of a tombstoned bot, at any age or type", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		const tombstoned = "bot_tombstoned";
		const missing = "bot_missing_index_row";
		await insertBotNotificationForRetention({
			id: "ntf_tombstoned_bootstrap",
			botId: tombstoned,
			notificationType: "bootstrap",
			status: "pending",
			createdAt: daysBefore(now, 1),
		});
		await testEnv.BICKR_D1
			.prepare(`UPDATE bots_index SET deleted_at = ? WHERE bot_id = ?`)
			.bind(daysBefore(now, 1), tombstoned)
			.run();
		// A bot whose index row was hard-deleted cannot be enumerated from the bot
		// side at all, so this pass leaves it alone: that residue predates soft
		// deletion and is the one-off's (O2, epic #184) to clear. Its pending row
		// still expires on the ordinary fourteen-day cutoff.
		await insertBotNotificationForRetention({
			id: "ntf_missing_bot_recent",
			botId: missing,
			status: "pending",
			createdAt: daysBefore(now, 1),
		});
		await testEnv.BICKR_D1.prepare(`DELETE FROM bots_index WHERE bot_id = ?`).bind(missing).run();
		// A live bot's fresh notification is untouched by both passes.
		await insertBotNotificationForRetention({
			id: "ntf_live_bot_recent",
			status: "pending",
			createdAt: daysBefore(now, 1),
		});
		// The rowless half: a crash between the TTL-free bootstrap document and its
		// D1 batch leaves a document no row can ever name.
		const rowlessBootstrapId = await bootstrapNotificationId(tombstoned);
		await testEnv.BICKR_KV.put(
			kvKeys.notification(tombstoned, rowlessBootstrapId),
			JSON.stringify({ id: rowlessBootstrapId, botId: tombstoned, notificationType: "bootstrap", status: "pending" }),
		);

		const result = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			now,
			selectLimit: 10,
			maxRowsPerRun: 10,
		});

		expect(result).toMatchObject({
			deletedRows: 1,
			orphanedBotRows: 1,
			kvDeleteFailures: 0,
			tombstonedBotsSwept: 1,
		});
		expect(await botNotificationRowIds()).toEqual(["ntf_live_bot_recent", "ntf_missing_bot_recent"]);
		expect(await botNotificationKvExists("ntf_tombstoned_bootstrap", tombstoned)).toBe(false);
		expect(await botNotificationKvExists(rowlessBootstrapId, tombstoned)).toBe(false);
		expect(await botNotificationKvExists("ntf_live_bot_recent")).toBe(true);
		expect(await botNotificationKvExists("ntf_missing_bot_recent", missing)).toBe(true);
	});

	it("pages the retired-status arm across every status in one run", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		// Statuses spanning the arm's keyset order, with two rows each so a page
		// boundary falls inside a status as well as between statuses.
		const leftovers: Array<{ id: string; status: BotNotificationStatus }> = [
			{ id: "ntf_leftover_archived_1", status: "archived" },
			{ id: "ntf_leftover_archived_2", status: "archived" },
			{ id: "ntf_leftover_delivered_1", status: "delivered_to_loop" },
			{ id: "ntf_leftover_delivered_2", status: "delivered_to_loop" },
			{ id: "ntf_leftover_read_1", status: "read_or_consumed" },
			{ id: "ntf_leftover_read_2", status: "read_or_consumed" },
		];
		for (const [index, leftover] of leftovers.entries()) {
			await insertBotNotificationForRetention({
				id: leftover.id,
				status: leftover.status,
				// Recent on purpose: a retired status is a pre-redesign leftover and
				// expired whatever its age.
				createdAt: new Date(Date.parse(daysBefore(now, 1)) + index * 1000).toISOString(),
			});
		}
		await insertBotNotificationForRetention({
			id: "ntf_leftover_control_pending",
			status: "pending",
			createdAt: daysBefore(now, 1),
		});

		const result = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			now,
			selectLimit: 2,
			maxRowsPerRun: 100,
		});

		// Three pages of two, then a page that selects nothing: the keyset carries
		// the status, so pagination advances instead of restarting at the first one.
		expect(result).toMatchObject({
			selectedRows: 6,
			deletedRows: 6,
			batches: 3,
			budgetExhausted: false,
		});
		expect(await botNotificationRowIds()).toEqual(["ntf_leftover_control_pending"]);
	});

	it("rotates the tombstoned-bot pass across invocations instead of reselecting its head", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		// More tombstoned bots than one invocation walks: without a persisted
		// cursor every invocation would sweep the same oldest prefix forever and
		// the rest would never be reached.
		const tombstonedBots = ["bot_gone_a", "bot_gone_b", "bot_gone_c", "bot_gone_d", "bot_gone_e"];
		for (const [index, botId] of tombstonedBots.entries()) {
			await insertBotNotificationForRetention({
				id: `ntf_${botId}`,
				botId,
				notificationType: "bootstrap",
				status: "pending",
				createdAt: daysBefore(now, 1),
			});
			await testEnv.BICKR_D1
				.prepare(`UPDATE bots_index SET deleted_at = ? WHERE bot_id = ?`)
				// Distinct tombstone timestamps, oldest first, so the rotation order is
				// the one the cursor claims to follow.
				.bind(new Date(Date.parse(daysBefore(now, 2)) + index * 1000).toISOString(), botId)
				.run();
		}
		const sweepTwoBots = { now, selectLimit: 10, maxRowsPerRun: 10, tombstonedBotsPerRun: 2 };
		const cursorKey = kvKeys.notificationTombstonedBotSweepCursor;

		const firstRun = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, sweepTwoBots);
		expect(firstRun).toMatchObject({ orphanedBotRows: 2, tombstonedBotsSwept: 2 });
		expect(await testEnv.BICKR_KV.get(cursorKey, { type: "json" })).toMatchObject({ botId: "bot_gone_b" });
		expect(await botNotificationRowIds()).toEqual([
			"ntf_bot_gone_c",
			"ntf_bot_gone_d",
			"ntf_bot_gone_e",
		]);

		const secondRun = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, sweepTwoBots);
		expect(secondRun).toMatchObject({ orphanedBotRows: 2, tombstonedBotsSwept: 2 });
		expect(await testEnv.BICKR_KV.get(cursorKey, { type: "json" })).toMatchObject({ botId: "bot_gone_d" });
		expect(await botNotificationRowIds()).toEqual(["ntf_bot_gone_e"]);

		// The last page ends the rotation, so the cursor is removed and the next
		// invocation starts again from the oldest tombstone.
		const thirdRun = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, sweepTwoBots);
		expect(thirdRun).toMatchObject({ orphanedBotRows: 1, tombstonedBotsSwept: 1 });
		expect(await testEnv.BICKR_KV.get(cursorKey, { type: "json" })).toBeNull();
		expect(await botNotificationRowIds()).toEqual([]);

		const fourthRun = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, sweepTwoBots);
		expect(fourthRun).toMatchObject({ orphanedBotRows: 0, tombstonedBotsSwept: 2 });
	});

	it("pages the tombstone rotation by seeking the cursor, not by walking up to it", async () => {
		// Enough tombstones that a page taken near the end of the rotation is far
		// from its head. A seek reads its own page; a walk reads every tombstone
		// ahead of the cursor as well, and only the second grows as bots are
		// deleted — which is the cost this rotation exists to avoid paying.
		const total = 60;
		const pageSize = 5;
		const botId = (index: number) => `bot_rotation_${String(index).padStart(3, "0")}`;
		const deletedAt = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
		for (let index = 0; index < total; index += 1) {
			await insertBotForRetention(botId(index), { deletedAt: deletedAt(index) });
		}
		// A live bot is not a tombstone: the partial index must not carry it, and
		// no page may return it.
		await insertBotForRetention("bot_rotation_live");

		const firstPage = await testEnv.BICKR_D1
			.prepare(selectTombstonedBotsFirstPageSql)
			.bind(pageSize)
			.all<{ botId: string; deletedAt: string }>();
		expect(firstPage.results.map((row) => row.botId)).toEqual([0, 1, 2, 3, 4].map(botId));

		const cursorIndex = total - pageSize - 1;
		const resumed = await testEnv.BICKR_D1
			.prepare(selectTombstonedBotsAfterCursorSql)
			.bind(deletedAt(cursorIndex), deletedAt(cursorIndex), botId(cursorIndex), pageSize)
			.all<{ botId: string; deletedAt: string }>();
		expect(resumed.results.map((row) => row.botId)).toEqual([55, 56, 57, 58, 59].map(botId));

		// `rows_read` counts the index entries the statement examined, so it is the
		// page's real cost rather than a claim about its plan. Both pages must pay
		// for their own rows only; a page that walked to the cursor would read the
		// ~55 tombstones before it too. The plan string cannot make this
		// distinction — a walk reports the same `SEARCH ... (deleted_at>?)`, since
		// that seek is the `IS NOT NULL` term the partial index implies.
		expect(firstPage.meta.rows_read).toBeLessThanOrEqual(pageSize + 1);
		expect(resumed.meta.rows_read).toBeLessThanOrEqual(pageSize + 1);

		const planDetails = async (sql: string, binds: unknown[]): Promise<string[]> => {
			const plan = await testEnv.BICKR_D1
				.prepare(`EXPLAIN QUERY PLAN ${sql}`)
				.bind(...binds)
				.all<{ detail: string }>();
			return (plan.results ?? []).map((row) => row.detail);
		};
		for (const details of [
			await planDetails(selectTombstonedBotsFirstPageSql, [pageSize]),
			await planDetails(
				selectTombstonedBotsAfterCursorSql,
				[deletedAt(cursorIndex), deletedAt(cursorIndex), botId(cursorIndex), pageSize],
			),
		]) {
			// Covering the index means the page never touches a bot's row, and
			// ordering with it means the page is never sorted.
			expect(details.some((detail) => detail.includes("bots_index_tombstoned"))).toBe(true);
			expect(details.some((detail) => /\bSCAN bots_index\b/u.test(detail))).toBe(false);
			expect(details.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);
		}
	});

	it("keeps expiry progressing when a deleted bot's backlog exceeds the orphan sub-budget", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		const tombstoned = "bot_gone_backlog";
		for (let index = 0; index < 4; index += 1) {
			await insertBotNotificationForRetention({
				id: `ntf_gone_${index}`,
				botId: tombstoned,
				status: "pending",
				createdAt: daysBefore(now, 1),
			});
		}
		await testEnv.BICKR_D1
			.prepare(`UPDATE bots_index SET deleted_at = ? WHERE bot_id = ?`)
			.bind(daysBefore(now, 1), tombstoned)
			.run();
		await insertBotNotificationForRetention({
			id: "ntf_expired_behind_backlog",
			status: "pending",
			createdAt: daysBefore(now, 30),
		});

		const result = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			now,
			selectLimit: 2,
			maxRowsPerRun: 10,
			orphanMaxRowsPerRun: 2,
		});

		// The deleted bot's backlog is capped at its sub-budget, so the ordinary
		// expiry pass still runs in the same invocation instead of waiting for as
		// many invocations as that backlog lasts.
		expect(result).toMatchObject({
			orphanedBotRows: 2,
			deletedRows: 3,
			budgetExhausted: false,
		});
		expect(await botNotificationRowIds()).toEqual(["ntf_gone_2", "ntf_gone_3"]);
	});

	it("resumes bot notification pruning after hitting the per-run row budget", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		for (let index = 0; index < 5; index += 1) {
			await insertBotNotificationForRetention({
				id: `ntf_budget_${index}`,
				status: "pending",
				createdAt: new Date(Date.parse(daysBefore(now, 100)) + index * 1000).toISOString(),
			});
		}

		const firstRun = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			now,
			selectLimit: 2,
			maxRowsPerRun: 3,
			kvDeleteChunkSize: 2,
		});

		expect(firstRun).toMatchObject({
			selectedRows: 3,
			deletedRows: 3,
			kvDeleteFailures: 0,
			batches: 2,
			budgetExhausted: true,
		});
		expect(await botNotificationRowIds()).toEqual(["ntf_budget_3", "ntf_budget_4"]);
		for (const id of ["ntf_budget_0", "ntf_budget_1", "ntf_budget_2"]) {
			expect(await botNotificationKvExists(id)).toBe(false);
		}
		expect(await botNotificationKvExists("ntf_budget_3")).toBe(true);
		expect(await botNotificationKvExists("ntf_budget_4")).toBe(true);

		const secondRun = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			now,
			selectLimit: 2,
			maxRowsPerRun: 3,
			kvDeleteChunkSize: 2,
		});

		expect(secondRun).toMatchObject({
			selectedRows: 2,
			deletedRows: 2,
			kvDeleteFailures: 0,
			batches: 1,
			budgetExhausted: false,
		});
		expect(await botNotificationRowIds()).toEqual([]);
		expect(await botNotificationKvExists("ntf_budget_3")).toBe(false);
		expect(await botNotificationKvExists("ntf_budget_4")).toBe(false);
	});

	it("redirects standalone thread and comment refs to canonical forum routes", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "short-ref-routes");
		const author = await createBotForTest(cookie, "short-ref-author");
		const thread = await createThreadForTest(forum.id, author.id, "Short ref route target", "Root body.");
		const comment = await createCommentForTest(thread.id, author.id, "Linked reply.");

		const threadResponse = await threadRefResolver(contextFor<typeof threadRefResolver>(
			new Request(`http://example.com/t/${thread.id.toUpperCase()}`),
			{ threadRef: thread.id.toUpperCase() },
		));
		expect(threadResponse.status).toBe(302);
		expect(threadResponse.headers.get("location")).toBe(`http://example.com/w/patch-notes/f/short-ref-routes/t/${thread.id}`);

		const commentResponse = await commentRefResolver(contextFor<typeof commentRefResolver>(
			new Request(`http://example.com/c/${comment.id.toUpperCase()}`),
			{ commentRef: comment.id.toUpperCase() },
		));
		expect(commentResponse.status).toBe(302);
		expect(commentResponse.headers.get("location")).toBe(`http://example.com/w/patch-notes/f/short-ref-routes/t/${thread.id}/c/${comment.id}`);
	});

	it("uses the coordinator only for explicitly fresh thread detail reads", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "fresh-detail");
		const author = await createBotForTest(cookie, "fresh-author");
		const thread = await createThreadForTest(forum.id, author.id, "Fresh detail", "KV is the default path.");
		const kvThread = await readThread(testEnv.BICKR_KV, thread.id);
		const freshThread = {
			...kvThread,
			comments: [
				{
					id: "cmt_fresh_detail",
					threadId: kvThread.id,
					worldId: kvThread.worldId,
					forumId: kvThread.forumId,
					authorBotId: author.id,
					authorHandle: author.handle,
					authorDisplayName: author.displayName,
					body: lt("Fresh coordinator comment."),
					voteScore: 0,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			],
			commentCount: 1,
			lastActivityAt: new Date().toISOString(),
			revision: kvThread.revision + 1,
			updatedAt: new Date().toISOString(),
		};
		const blockedCoordinator = vi.fn(async () => {
			throw new Error("Coordinator should not be called for default thread reads.");
		});

		const defaultResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/fresh-detail/threads/${thread.id}`),
				{ worldHandle: "patch-notes", forumHandle: "fresh-detail", threadId: thread.id },
				{ FORUM_COORDINATOR_SERVICE: { fetch: blockedCoordinator } as unknown as Fetcher },
			),
		);
		expect(defaultResponse.status).toBe(200);
		expect(blockedCoordinator).not.toHaveBeenCalled();
		const defaultPayload = (await defaultResponse.json()) as { data: { thread: { comments: unknown[] } } };
		expect(defaultPayload.data.thread.comments).toHaveLength(1);

		const freshCoordinator = vi.fn(async (request: Request) => {
			expect(new URL(request.url).pathname).toBe(`/threads/${thread.id}`);
			return Response.json({ ok: true, data: { thread: freshThread } });
		});
		const freshResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/fresh-detail/threads/${thread.id}?fresh=1`),
				{ worldHandle: "patch-notes", forumHandle: "fresh-detail", threadId: thread.id },
				{ FORUM_COORDINATOR_SERVICE: { fetch: freshCoordinator } as unknown as Fetcher },
			),
		);
		expect(freshResponse.status).toBe(200);
		expect(freshCoordinator).toHaveBeenCalledTimes(1);
		const freshPayload = (await freshResponse.json()) as {
			data: { thread: { comments: Array<{ body: LocalizedText }> } };
		};
		expect(freshPayload.data.thread.comments.map((comment) => localizedTextString(comment.body))).toEqual([
			"Fresh coordinator comment.",
		]);
	});

	it("serves recent thread writes from the coordinator cache until the freshness window expires", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "fresh-cache");
		const author = await createBotForTest(cookie, "cache-author");
		const replier = await createBotForTest(cookie, "cache-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Fresh cache", "The KV copy can lag.");
		const initialThread = await readThread(testEnv.BICKR_KV, thread.id);
		const storage = memoryDurableStorage();
		const cache = { entry: null as ThreadFreshCacheEntryForTest | null };
		const context = {
			cache,
			objectId: "thread-cache-test",
			storage: storage.storage,
		};

		const firstComment = jsonRequest(
			`http://example.com/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("First fresh comment.") },
		);
		firstComment.headers.set("x-bickr-bot-id", replier.id);
		expect(await handleForumCoordinatorRequest(firstComment, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		}, context)).toHaveProperty("status", 201);

		await testEnv.BICKR_KV.put(`v1:thread:${thread.id}`, JSON.stringify(initialThread));
		const secondComment = jsonRequest(
			`http://example.com/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("Second fresh comment.") },
		);
		secondComment.headers.set("x-bickr-bot-id", replier.id);
		const secondResponse = await handleForumCoordinatorRequest(secondComment, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		}, context);
		const secondPayload = (await secondResponse.json()) as {
			data: { thread: { comments: Array<{ body: LocalizedText }> } };
		};
		expect(secondPayload.data.thread.comments.map((comment) => localizedTextString(comment.body))).toEqual([
			"The KV copy can lag.",
			"First fresh comment.",
			"Second fresh comment.",
		]);

		await testEnv.BICKR_KV.put(`v1:thread:${thread.id}`, JSON.stringify(initialThread));
		const cachedRead = await handleForumCoordinatorRequest(
			new Request(`http://example.com/threads/${thread.id}`),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			context,
		);
		const cachedPayload = (await cachedRead.json()) as {
			data: { thread: { comments: Array<{ body: LocalizedText }> } };
		};
		expect(cachedPayload.data.thread.comments.map((comment) => localizedTextString(comment.body))).toEqual([
			"The KV copy can lag.",
			"First fresh comment.",
			"Second fresh comment.",
		]);

		const storedEntry = storage.values.get("thread-fresh-cache") as ThreadFreshCacheEntryForTest;
		const expiredEntry = {
			...storedEntry,
			expiresAt: new Date(Date.now() - 1_000).toISOString(),
		};
		storage.values.set("thread-fresh-cache", expiredEntry);
		cache.entry = expiredEntry;
		const expiredRead = await handleForumCoordinatorRequest(
			new Request(`http://example.com/threads/${thread.id}`),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			context,
	);
	const expiredPayload = (await expiredRead.json()) as { data: { thread: { comments: unknown[] } } };
	expect(expiredPayload.data.thread.comments).toHaveLength(1);
});

	it("serializes concurrent replies to the same comment through the coordinator queue", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "reply-serialization");
		const author = await createBotForTest(cookie, "serialization-author");
		const firstReplier = await createBotForTest(cookie, "serialization-one");
		const secondReplier = await createBotForTest(cookie, "serialization-two");
		const thread = await createThreadForTest(forum.id, author.id, "Concurrent replies", "Root body.");
		const parent = await createCommentForTest(thread.id, author.id, "Parent for concurrent replies.");
		const storage = memoryDurableStorage();
		const firstThreadPutStarted = deferred<void>();
		const releaseFirstThreadPut = deferred<void>();
		const context = {
			cache: { entry: null as ThreadFreshCacheEntryForTest | null },
			objectId: "reply-serialization-test",
			queue: new ExclusiveOperationQueue(),
			storage: storage.storage,
		};
		const kv = kvWithDelayedFirstPut(
			testEnv.BICKR_KV,
			`v1:thread:${thread.id}`,
			firstThreadPutStarted,
			releaseFirstThreadPut,
		);

		const firstRequest = jsonRequest(
			`http://example.com/comments/${parent.id}/replies`,
			"POST",
			{ body: requiredLt("First concurrent reply.") },
		);
		firstRequest.headers.set("x-bickr-bot-id", firstReplier.id);
		const secondRequest = jsonRequest(
			`http://example.com/comments/${parent.id}/replies`,
			"POST",
			{ body: requiredLt("Second concurrent reply.") },
		);
		secondRequest.headers.set("x-bickr-bot-id", secondReplier.id);

		const firstResponse = handleForumCoordinatorRequest(firstRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: kv,
		}, context);
		await firstThreadPutStarted.promise;
		const secondResponse = handleForumCoordinatorRequest(secondRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: kv,
		}, context);
		releaseFirstThreadPut.resolve();

		const responses = await Promise.all([firstResponse, secondResponse]);
		expect(responses.map((response) => response.status)).toEqual([201, 201]);
		const updated = await readThread(testEnv.BICKR_KV, thread.id);
		const replyBodies = updated.comments
			.filter((comment) => comment.parentCommentId === parent.id)
			.map((comment) => localizedTextString(comment.body));
		expect(replyBodies).toEqual([
			"First concurrent reply.",
			"Second concurrent reply.",
		]);
	});

	it("serializes the final comment slot so only one concurrent reply reaches the cap", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "thread-lock-serialization");
		await setForumThreadCommentLimit(forum.id, 2);
		const author = await createBotForTest(cookie, "thread-lock-root-author");
		const firstReplier = await createBotForTest(cookie, "thread-lock-first");
		const secondReplier = await createBotForTest(cookie, "thread-lock-second");
		const thread = await createThreadForTest(forum.id, author.id, "One final slot", "Root body.");
		const context = {
			cache: { entry: null as ThreadFreshCacheEntryForTest | null },
			objectId: "thread-lock-serialization-test",
			queue: new ExclusiveOperationQueue(),
			storage: memoryDurableStorage().storage,
		};
		const request = (botId: string, body: string) => {
			const commentRequest = jsonRequest(
				`http://example.com/threads/${thread.id}/comments`,
				"POST",
				{ body: requiredLt(body) },
			);
			commentRequest.headers.set("x-bickr-bot-id", botId);
			return commentRequest;
		};

		const responses = await Promise.all([
			handleForumCoordinatorRequest(request(firstReplier.id, "Claims the final slot."), {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			}, context),
			handleForumCoordinatorRequest(request(secondReplier.id, "Arrives after the lock."), {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			}, context),
		]);

		expect(responses.map((response) => response.status)).toEqual([201, 409]);
		const updated = await readThread(testEnv.BICKR_KV, thread.id);
		expect(updated.commentCount).toBe(2);
		expect(updated.comments.map((comment) => localizedTextString(comment.body))).toEqual([
			"Root body.",
			"Claims the final slot.",
		]);
	});

	it("releases the coordinator queue after a failed same-thread mutation", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "reply-error-queue");
		const author = await createBotForTest(cookie, "error-queue-author");
		const replier = await createBotForTest(cookie, "error-queue-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Failed reply queue", "Root body.");
		const context = {
			cache: { entry: null as ThreadFreshCacheEntryForTest | null },
			objectId: "reply-error-queue-test",
			queue: new ExclusiveOperationQueue(),
			storage: memoryDurableStorage().storage,
		};

		const failedRequest = jsonRequest(
			`http://example.com/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("This reply should fail."), parentCommentId: "missing-comment" },
		);
		failedRequest.headers.set("x-bickr-bot-id", replier.id);
		const validRequest = jsonRequest(
			`http://example.com/threads/${thread.id}/comments`,
			"POST",
			{ body: requiredLt("Reply after failed mutation.") },
		);
		validRequest.headers.set("x-bickr-bot-id", replier.id);

		const [failedResponse, validResponse] = await Promise.all([
			handleForumCoordinatorRequest(failedRequest, {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			}, context),
			handleForumCoordinatorRequest(validRequest, {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			}, context),
		]);

		expect(failedResponse.status).toBe(404);
		expect(validResponse.status).toBe(201);
		const updated = await readThread(testEnv.BICKR_KV, thread.id);
		expect(updated.comments.map((comment) => localizedTextString(comment.body))).toContain("Reply after failed mutation.");
	});

	it("routes comment votes through the owning thread coordinator", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "vote-routing");
		const author = await createBotForTest(cookie, "vote-author");
		const voter = await createBotForTest(cookie, "vote-router");
		const thread = await createThreadForTest(forum.id, author.id, "Vote routing", "Comments route by thread.");
		const comment = await createCommentForTest(thread.id, author.id, "Vote on this comment.");
		const routed: { name?: string; threadHeader?: string } = {};
		const namespace = {
			idFromName(name: string): DurableObjectId {
				routed.name = name;
				return name as unknown as DurableObjectId;
			},
			get(): Fetcher {
				return {
					fetch: async (request: Request) => {
						routed.threadHeader = request.headers.get("x-bickr-thread-id") ?? undefined;
						return Response.json({ ok: true });
					},
				} as unknown as Fetcher;
			},
		};
		const voteRequest = jsonRequest("https://internal.bickr/votes", "POST", {
			commentId: comment.id,
			value: 1,
		});
		voteRequest.headers.set("x-bickr-bot-id", voter.id);
		voteRequest.headers.set(internalServiceAuthHeader, "test-internal-service-secret");

		const response = await forumCoordinatorWorker.fetch(
			voteRequest as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				FORUM_COORDINATOR: namespace,
				INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
				WORLD_COORDINATOR: namespace,
			} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);

		expect(response.status).toBe(200);
		expect(routed.name).toBe(thread.id);
		expect(routed.threadHeader).toBe(thread.id);
	});

	it("allows forum, world, and bot owners to moderate owned surfaces", async () => {
		const worldOwnerCookie = await authCookie();
		const botOwnerCookie = await authCookieFor({
			subject: "222",
			login: "reply-owner",
			displayName: "Reply Owner",
		});
		const outsiderCookie = await authCookieFor({
			subject: "333",
			login: "outsider",
			displayName: "Out Sider",
		});
		await seedWorld(worldOwnerCookie);
		const forum = await createForumForTest(worldOwnerCookie, "moderation");
		const ownerBot = await createBotForTest(worldOwnerCookie, "owner-bot");
		const otherBot = await createBotForTest(botOwnerCookie, "other-bot");
		const thread = await createThreadForTest(forum.id, otherBot.id, "Moderate this", "Needs a close read.");
		const outsiderDelete = await deleteThreadRoute(
			contextFor<typeof deleteThreadRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/moderation/threads/${thread.id}`,
					{ method: "DELETE", headers: { cookie: outsiderCookie } },
				),
				{ worldHandle: "patch-notes", forumHandle: "moderation", threadId: thread.id },
			),
		);
		expect(outsiderDelete.status).toBe(403);

		const comment = await createCommentForTest(thread.id, otherBot.id, "Owner of the bot can remove this.");
		const commentDelete = await deleteCommentRoute(
			contextFor<typeof deleteCommentRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/moderation/threads/${thread.id}/comments/${comment.id}`,
					{ method: "DELETE", headers: { cookie: botOwnerCookie } },
				),
				{ worldHandle: "patch-notes", forumHandle: "moderation", threadId: thread.id, commentId: comment.id },
			),
		);
		expect(commentDelete.status).toBe(200);
		const commentIndex = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM comments_index WHERE comment_id = ?`,
		)
			.bind(comment.id)
			.first<{ deletedAt: string | null }>();
		expect(commentIndex?.deletedAt).toBeTruthy();

		const threadDelete = await deleteThreadRoute(
			contextFor<typeof deleteThreadRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/forums/moderation/threads/${thread.id}`,
					{ method: "DELETE", headers: { cookie: botOwnerCookie } },
				),
				{ worldHandle: "patch-notes", forumHandle: "moderation", threadId: thread.id },
			),
		);
		expect(threadDelete.status).toBe(200);
		const deletedThreadDetail = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/moderation/threads/${thread.id}`),
				{ worldHandle: "patch-notes", forumHandle: "moderation", threadId: thread.id },
			),
		);
		expect(deletedThreadDetail.status).toBe(404);

		const patchForumResponse = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/moderation",
					"PATCH",
					{ description: "Moderation edits landed" },
					worldOwnerCookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "moderation" },
			),
		);
		expect(patchForumResponse.status).toBe(200);
		expect(await patchForumResponse.json()).toMatchObject({
			data: { forum: { handle: "moderation", description: lt("Moderation edits landed") } },
		});

		const otherForumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums",
					"POST",
					{ handle: "tenant-forum", description: "Created by another human." },
					botOwnerCookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const otherForum = ((await otherForumResponse.json()) as { data: { forum: TestForum } }).data.forum;
		const otherForumThread = await createThreadForTest(otherForum.id, otherBot.id, "Tenant post", "World owner can remove the forum.");
		const worldOwnerForumDelete = await deleteForumRoute(
			contextFor<typeof deleteForumRoute>(
				new Request("http://example.com/api/worlds/patch-notes/forums/tenant-forum", {
					method: "DELETE",
					headers: { cookie: worldOwnerCookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "tenant-forum" },
			),
		);
		expect(worldOwnerForumDelete.status).toBe(200);
		const deletedForumThread = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM threads_index WHERE thread_id = ?`,
		)
			.bind(otherForumThread.id)
			.first<{ deletedAt: string | null }>();
		expect(deletedForumThread?.deletedAt).toBeTruthy();

		const patchWorldResponse = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes",
					"PATCH",
					{ name: "Patch Notes Edited", description: "Updated world text." },
					worldOwnerCookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(patchWorldResponse.status).toBe(200);
		expect(await patchWorldResponse.json()).toMatchObject({
			data: { world: { handle: "patch-notes", name: lt("Patch Notes Edited") } },
		});

		const blockedWorldDelete = await deleteWorldRoute(
			contextFor<typeof deleteWorldRoute>(
				new Request("http://example.com/api/worlds/patch-notes", {
					method: "DELETE",
					headers: { cookie: worldOwnerCookie },
				}),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(blockedWorldDelete.status).toBe(403);

		for (const [bot, cookie] of [
			[ownerBot, worldOwnerCookie],
			[otherBot, botOwnerCookie],
		] as const) {
			const response = await deleteBot(
				contextFor<typeof deleteBot>(
					new Request(`http://example.com/api/me/bots/${bot.id}`, {
						method: "DELETE",
						headers: { cookie },
					}),
					{ botId: bot.id },
				),
			);
			expect(response.status).toBe(200);
		}

		const worldDelete = await deleteWorldRoute(
			contextFor<typeof deleteWorldRoute>(
				new Request("http://example.com/api/worlds/patch-notes", {
					method: "DELETE",
					headers: { cookie: worldOwnerCookie },
				}),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(worldDelete.status).toBe(200);
		const listAfterDelete = await worlds(
			contextFor<typeof worlds>(new Request("http://example.com/api/worlds")),
		);
		expect(await listAfterDelete.json()).toMatchObject({ data: { worlds: [] } });
	});

	it("returns and advances human read markers for forum and thread views", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "debate");
		const author = await createBotForTest(cookie, "read-bard");
		const replier = await createBotForTest(cookie, "reply-scribe");
		const thread = await createThreadForTest(forum.id, author.id, "Unread thread", "A root post.");

		const firstList = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request("http://example.com/api/worlds/patch-notes/forums/debate/threads", {
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "debate" },
			),
		);
		const firstListPayload = (await firstList.json()) as ThreadListPayload;
		expect(firstListPayload.data.threads.find((item) => item.id === thread.id)?.readState).toMatchObject({
			isNew: true,
			hasNewComments: false,
		});

		await pause(5);
		const comment = await createCommentForTest(thread.id, replier.id, "A reply after the forum read marker.");

		const secondList = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request("http://example.com/api/worlds/patch-notes/forums/debate/threads", {
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "debate" },
			),
		);
		const secondListPayload = (await secondList.json()) as ThreadListPayload;
		expect(secondListPayload.data.threads.find((item) => item.id === thread.id)?.readState).toMatchObject({
			isNew: false,
			hasNewComments: true,
			newCommentCount: 1,
		});

		const firstDetail = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/debate/threads/${thread.id}`, {
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "debate", threadId: thread.id },
			),
		);
		const firstDetailPayload = (await firstDetail.json()) as ThreadDetailPayload;
		expect(firstDetailPayload.data.thread.comments.find((item) => item.id === comment.id)?.readState).toEqual({
			isNew: true,
		});

		const secondDetail = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/debate/threads/${thread.id}`, {
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", forumHandle: "debate", threadId: thread.id },
			),
		);
		const secondDetailPayload = (await secondDetail.json()) as ThreadDetailPayload;
		expect(secondDetailPayload.data.thread.comments.find((item) => item.id === comment.id)?.readState).toEqual({
			isNew: false,
		});
	});

	it("marks human notifications read by world and bot section scopes", async () => {
		const cookie = await authCookie();
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const now = new Date().toISOString();
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO human_notifications (
				notification_id, user_id, world_id, event_key, notification_type,
				actor_bot_id, actor_handle, actor_display_name,
				source_type, source_id, target_type, target_id,
				title, body, url_path, spotlight_id, spotlight_label,
				created_at, read_at, archived_at
			) VALUES
				('hnt_world_a', ?, 'world_one', 'event:world:a', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'A', 'A', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_world_b', ?, 'world_one', 'event:world:b', 'thread_created', 'bot_b', 'bot-b', 'Bot B', NULL, NULL, NULL, NULL, 'B', 'B', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_bot_a', ?, 'world_two', 'event:bot:a', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'C', 'C', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_read', ?, 'world_two', 'event:read', 'thread_created', 'bot_b', 'bot-b', 'Bot B', NULL, NULL, NULL, NULL, 'D', 'D', '/', NULL, NULL, ?, ?, NULL)`,
		)
			.bind(user.id, now, user.id, now, user.id, now, user.id, now, now)
			.run();

		const worldResponse = await markAllNotificationsReadRoute(
			contextFor<typeof markAllNotificationsReadRoute>(
				jsonRequest(
					"http://example.com/api/me/notifications/read-all",
					"POST",
					{ scopeType: "world", scopeId: "world_one" },
					cookie,
				),
			),
		);
		expect(await worldResponse.json()).toMatchObject({ data: { readAll: true, readCount: 2 } });

		const afterWorld = await testEnv.BICKR_D1.prepare(
			`SELECT notification_id AS id, read_at AS readAt
			 FROM human_notifications
			 WHERE user_id = ?
			 ORDER BY notification_id`,
		)
			.bind(user.id)
			.all<{ id: string; readAt: string | null }>();
		expect(afterWorld.results).toEqual([
			{ id: "hnt_bot_a", readAt: null },
			expect.objectContaining({ id: "hnt_read", readAt: now }),
			expect.objectContaining({ id: "hnt_world_a", readAt: expect.any(String) }),
			expect.objectContaining({ id: "hnt_world_b", readAt: expect.any(String) }),
		]);

		const botResponse = await markAllNotificationsReadRoute(
			contextFor<typeof markAllNotificationsReadRoute>(
				jsonRequest(
					"http://example.com/api/me/notifications/read-all",
					"POST",
					{ scopeType: "bot", scopeId: "bot_a" },
					cookie,
				),
			),
		);
		expect(await botResponse.json()).toMatchObject({ data: { readAll: true, readCount: 1 } });

		const unread = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND read_at IS NULL`,
		)
			.bind(user.id)
			.first<{ count: number }>();
		expect(unread?.count).toBe(0);
	});

	it("bounds mark-all by the requested cutoff and clamps a future one", async () => {
		const cookie = await authCookie();
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const cutoff = "2026-05-06T12:00:00.000Z";
		const afterCutoff = "2026-05-06T12:00:01.000Z";
		const forwardDated = "2099-01-01T00:00:00.000Z";
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO human_notifications (
				notification_id, user_id, world_id, event_key, notification_type,
				actor_bot_id, actor_handle, actor_display_name,
				source_type, source_id, target_type, target_id,
				title, body, url_path, spotlight_id, spotlight_label,
				created_at, read_at, archived_at
			) VALUES
				('hnt_cutoff_old', ?, 'world_one', 'event:cutoff:old', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'A', 'A', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_cutoff_new', ?, 'world_one', 'event:cutoff:new', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'B', 'B', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_cutoff_other', ?, 'world_two', 'event:cutoff:other', 'thread_created', 'bot_b', 'bot-b', 'Bot B', NULL, NULL, NULL, NULL, 'C', 'C', '/', NULL, NULL, ?, NULL, NULL),
				('hnt_cutoff_future', ?, 'world_two', 'event:cutoff:future', 'thread_created', 'bot_b', 'bot-b', 'Bot B', NULL, NULL, NULL, NULL, 'D', 'D', '/', NULL, NULL, ?, NULL, NULL)`,
		)
			.bind(user.id, cutoff, user.id, afterCutoff, user.id, afterCutoff, user.id, forwardDated)
			.run();

		const readAll = async (body: Record<string, unknown>): Promise<Response> =>
			markAllNotificationsReadRoute(
				contextFor<typeof markAllNotificationsReadRoute>(
					jsonRequest("http://example.com/api/me/notifications/read-all", "POST", body, cookie),
				),
			);
		const unreadIds = async (): Promise<string[]> => {
			const result = await testEnv.BICKR_D1.prepare(
				`SELECT notification_id AS id
				 FROM human_notifications
				 WHERE user_id = ? AND read_at IS NULL
				 ORDER BY notification_id`,
			)
				.bind(user.id)
				.all<{ id: string }>();
			return (result.results ?? []).map((row) => row.id);
		};

		// Two scoped calls of one gesture share a cutoff, so a notification the
		// second scope gained after the gesture started still survives it.
		const worldResponse = await readAll({ scopeType: "world", scopeId: "world_one", asOf: cutoff });
		expect(await worldResponse.json()).toMatchObject({ data: { readCount: 1 } });
		const botResponse = await readAll({ scopeType: "bot", scopeId: "bot_b", asOf: cutoff });
		expect(await botResponse.json()).toMatchObject({ data: { readCount: 0 } });
		expect(await unreadIds()).toEqual(["hnt_cutoff_future", "hnt_cutoff_new", "hnt_cutoff_other"]);

		const invalidResponse = await readAll({ scopeType: "all", asOf: "sometime yesterday" });
		expect(invalidResponse.status).toBe(400);
		await expect(invalidResponse.json()).resolves.toMatchObject({ error: "bad_request" });
		expect(await unreadIds()).toEqual(["hnt_cutoff_future", "hnt_cutoff_new", "hnt_cutoff_other"]);

		// A future cutoff is clamped to server now, so it cannot reach forward.
		const clampedResponse = await readAll({ scopeType: "all", asOf: forwardDated });
		expect(await clampedResponse.json()).toMatchObject({ data: { readCount: 2 } });
		expect(await unreadIds()).toEqual(["hnt_cutoff_future"]);

		// An absent cutoff still defaults to server now.
		const defaultResponse = await readAll({ scopeType: "all" });
		expect(await defaultResponse.json()).toMatchObject({ data: { readCount: 0 } });
		expect(await unreadIds()).toEqual(["hnt_cutoff_future"]);
	});

	it("lists human notifications by world and bot scopes", async () => {
		const cookie = await authCookie();
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO human_notifications (
				notification_id, user_id, world_id, event_key, notification_type,
				actor_bot_id, actor_handle, actor_display_name,
				source_type, source_id, target_type, target_id,
				title, body, url_path, spotlight_id, spotlight_label,
				created_at, read_at, archived_at
			) VALUES
				('hnt_world_unread', ?, 'world_one', 'event:list:world:unread', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'World unread', 'A', '/', NULL, NULL, '2026-01-01T00:00:03.000Z', NULL, NULL),
				('hnt_world_read', ?, 'world_one', 'event:list:world:read', 'thread_created', 'bot_b', 'bot-b', 'Bot B', NULL, NULL, NULL, NULL, 'World read', 'B', '/', NULL, NULL, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:05.000Z', NULL),
				('hnt_bot_a_other_world', ?, 'world_two', 'event:list:bot:a', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'Bot A other world', 'C', '/', NULL, NULL, '2026-01-01T00:00:02.000Z', NULL, NULL),
				('hnt_archived', ?, 'world_one', 'event:list:archived', 'thread_created', 'bot_a', 'bot-a', 'Bot A', NULL, NULL, NULL, NULL, 'Archived', 'D', '/', NULL, NULL, '2026-01-01T00:00:01.000Z', NULL, '2026-01-01T00:00:06.000Z')`,
		)
			.bind(user.id, user.id, user.id, user.id)
			.run();

		const worldResponse = await getNotificationsRoute(
			contextFor<typeof getNotificationsRoute>(
				new Request("http://example.com/api/me/notifications?status=all&scopeType=world&scopeId=world_one", {
					headers: { cookie },
				}),
			),
		);
		const worldPayload = (await worldResponse.json()) as {
			data: { unreadCount: number; notifications: Array<{ id: string }> };
		};
		expect(worldResponse.status).toBe(200);
		expect(worldPayload.data.unreadCount).toBe(1);
		expect(worldPayload.data.notifications.map((notification) => notification.id)).toEqual([
			"hnt_world_read",
			"hnt_world_unread",
		]);

		const botResponse = await getNotificationsRoute(
			contextFor<typeof getNotificationsRoute>(
				new Request("http://example.com/api/me/notifications?status=all&scopeType=bot&scopeId=bot_a", {
					headers: { cookie },
				}),
			),
		);
		const botPayload = (await botResponse.json()) as {
			data: { unreadCount: number; notifications: Array<{ id: string }> };
		};
		expect(botResponse.status).toBe(200);
		expect(botPayload.data.unreadCount).toBe(2);
		expect(botPayload.data.notifications.map((notification) => notification.id)).toEqual([
			"hnt_world_unread",
			"hnt_bot_a_other_world",
		]);

		const missingScopeIdResponse = await getNotificationsRoute(
			contextFor<typeof getNotificationsRoute>(
				new Request("http://example.com/api/me/notifications?scopeType=world", {
					headers: { cookie },
				}),
			),
		);
		expect(missingScopeIdResponse.status).toBe(400);
		await expect(missingScopeIdResponse.json()).resolves.toMatchObject({
			error: "bad_request",
		});

		const invalidScopeResponse = await getNotificationsRoute(
			contextFor<typeof getNotificationsRoute>(
				new Request("http://example.com/api/me/notifications?scopeType=forum&scopeId=forum_a", {
					headers: { cookie },
				}),
			),
		);
		expect(invalidScopeResponse.status).toBe(400);
		await expect(invalidScopeResponse.json()).resolves.toMatchObject({
			error: "bad_request",
		});
	});

	it("lists active subscriptions as a resolved nested tree", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "watch-room");
		const author = await createBotForTest(cookie, "watch-author");
		const replier = await createBotForTest(cookie, "watch-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Watched thread", "Root subscription text.");
		const comment = await createCommentForTest(thread.id, replier.id, "Needle subscription comment text.");
		const userId = await userIdForHandle("octocat");
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO human_subscriptions (
				subscription_id, user_id, world_id, scope_type, scope_id,
				active, auto_created, created_at, updated_at
			) VALUES
				('hsb_forum', ?, ?, 'forum', ?, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
				('hsb_thread', ?, ?, 'thread', ?, 1, 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
				('hsb_comment', ?, ?, 'comment', ?, 1, 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
				('hsb_missing_comment', ?, ?, 'comment', 'missing-comment', 1, 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z')`,
		)
			.bind(
				userId, forum.worldId, forum.id,
				userId, forum.worldId, thread.id,
				userId, forum.worldId, comment.id,
				userId, forum.worldId,
			)
			.run();

		const response = await getSubscriptionsRoute(
			contextFor<typeof getSubscriptionsRoute>(
				new Request("http://example.com/api/me/subscriptions?view=tree", {
					headers: { cookie },
				}),
			),
		);
		const payload = (await response.json()) as { data: HumanSubscriptionTreeResponse };

		expect(response.status).toBe(200);
		expect(payload.data.subscriptions.map((subscription) => subscription.id)).not.toContain("hsb_missing_comment");
		const world = payload.data.tree.worlds.find((item) => item.world.handle === "patch-notes");
		expect(world).toBeTruthy();
		expect(world?.subscription).toBeUndefined();
		expect(world?.bots.map((bot) => bot.bot.handle)).toEqual(expect.arrayContaining(["watch-author", "watch-replier"]));
		const forumNode = world?.forums.find((item) => item.forum.id === forum.id);
		expect(forumNode?.subscription?.id).toBe("hsb_forum");
		const threadNode = forumNode?.threads.find((item) => item.thread.id === thread.id);
		expect(threadNode?.subscription?.id).toBe("hsb_thread");
		expect(threadNode?.comments).toEqual([
			expect.objectContaining({
				comment: expect.objectContaining({
					id: comment.id,
					bodyPreview: lt("Needle subscription comment text."),
					authorHandle: "watch-replier",
				}),
				subscription: expect.objectContaining({ id: "hsb_comment" }),
			}),
		]);
	});

	it("validates subscription scopes against their claimed world before upserting", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "validated-watch");

		const valid = await setSubscriptionRoute(
			contextFor<typeof setSubscriptionRoute>(
				jsonRequest(
					"http://example.com/api/me/subscriptions",
					"PUT",
					{ scopeType: "forum", scopeId: forum.id, worldId: forum.worldId },
					cookie,
				),
			),
		);
		expect(valid.status, await valid.clone().text()).toBe(200);
		expect(await valid.json()).toMatchObject({
			data: { subscription: { scopeType: "forum", scopeId: forum.id, worldId: forum.worldId } },
		});

		const wrongWorld = await setSubscriptionRoute(
			contextFor<typeof setSubscriptionRoute>(
				jsonRequest(
					"http://example.com/api/me/subscriptions",
					"PUT",
					{ scopeType: "forum", scopeId: forum.id, worldId: "w_wrong" },
					cookie,
				),
			),
		);
		expect(wrongWorld.status).toBe(400);
		expect(await wrongWorld.json()).toMatchObject({
			error: "bad_request",
			message: "Subscription scope does not belong to the specified world.",
		});

		const nonexistent = await setSubscriptionRoute(
			contextFor<typeof setSubscriptionRoute>(
				jsonRequest(
					"http://example.com/api/me/subscriptions",
					"PUT",
					{ scopeType: "forum", scopeId: "frm_missing", worldId: forum.worldId },
					cookie,
				),
			),
		);
		expect(nonexistent.status).toBe(404);
		expect(await nonexistent.json()).toMatchObject({
			error: "not_found",
			message: "Subscription forum scope not found.",
		});
	});

	it("applies subscription updates only through the batch update route", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "batch-watch");
		const bot = await createBotForTest(cookie, "batch-bot");
		const userId = await userIdForHandle("octocat");

		const response = await patchSubscriptionsRoute(
			contextFor<typeof patchSubscriptionsRoute>(
				jsonRequest(
					"http://example.com/api/me/subscriptions",
					"PATCH",
					{
						changes: [
							{ scopeType: "bot", scopeId: bot.id, worldId: forum.worldId, active: false },
							{ scopeType: "forum", scopeId: forum.id, worldId: forum.worldId, active: true },
						],
					},
					cookie,
				),
			),
		);
		const payload = (await response.json()) as { data: HumanSubscriptionTreeResponse };
		expect(response.status).toBe(200);
		expect(payload.data.tree.worlds[0]?.bots.some((node) => node.bot.id === bot.id)).toBe(false);
		expect(payload.data.tree.worlds[0]?.forums.find((node) => node.forum.id === forum.id)?.subscription).toMatchObject({
			active: true,
			scopeType: "forum",
		});

		const rows = await testEnv.BICKR_D1.prepare(
			`SELECT scope_type AS scopeType, scope_id AS scopeId, active
			 FROM human_subscriptions
			 WHERE user_id = ? AND scope_id IN (?, ?)
			 ORDER BY scope_type`,
		)
			.bind(userId, bot.id, forum.id)
			.all<{ scopeType: string; scopeId: string; active: number }>();
		expect(rows.results).toEqual([
			{ scopeType: "bot", scopeId: bot.id, active: 0 },
			{ scopeType: "forum", scopeId: forum.id, active: 1 },
		]);
	});

	it("marks bot seen content from full-thread and search tool results", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "tool-seen");
		const bot = await createBotForTest(cookie, "seen-reader");
		const otherBot = await createBotForTest(cookie, "seen-writer");
		const thread = await createThreadForTest(forum.id, otherBot.id, "Readable thread", "Root body.");
		const comment = await createCommentForTest(thread.id, otherBot.id, "Needle comment.");

		await markBotSeenFromResult(
			testEnv.BICKR_D1,
			bot.id,
			await readThread(testEnv.BICKR_KV, thread.id),
			"tool:read_thread",
			"run-read",
		);

		const readRows = await testEnv.BICKR_D1.prepare(
			`SELECT object_type AS objectType, object_id AS objectId, seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ?
			 ORDER BY object_type, object_id`,
		)
			.bind(bot.id)
			.all<{ objectType: string; objectId: string; seenVia: string }>();
		expect(readRows.results).toEqual(
			expect.arrayContaining([
				{ objectType: "comment", objectId: comment.id, seenVia: "tool:read_thread" },
				{ objectType: "thread", objectId: thread.id, seenVia: "tool:read_thread" },
			]),
		);

		await markBotSeenFromResult(
			testEnv.BICKR_D1,
			bot.id,
			await searchThreads(testEnv.BICKR_D1, forum.worldId, "Needle"),
			"tool:search_threads",
			"run-search",
		);
		const searchSeen = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'comment' AND object_id = ?`,
		)
			.bind(bot.id, comment.id)
			.first<{ seenVia: string }>();
		expect(searchSeen).toEqual({ seenVia: "tool:search_threads" });

		await markBotSeenFromResult(
			testEnv.BICKR_D1,
			bot.id,
			{
				operation: "read_comment_by_id",
				thread: { id: thread.id, threadId: thread.id, forumHandle: forum.handle, title: "Readable thread" },
				targetCommentId: comment.id,
				content: [
					{ type: "thread", id: thread.id, threadId: thread.id, forumHandle: forum.handle },
					{ type: "comment", id: comment.id, commentId: comment.id, threadId: thread.id, forumHandle: forum.handle },
				],
			},
			"tool:read_comment_by_id",
			"run-comment",
		);
		const readCommentSeen = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'comment' AND object_id = ?`,
		)
			.bind(bot.id, comment.id)
			.first<{ seenVia: string }>();
		expect(readCommentSeen).toEqual({ seenVia: "tool:read_comment_by_id" });
	});

	it("creates structured u/ mention notifications", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "mentions");
		const author = await createBotForTest(cookie, "mention-author");
		const recipient = await createBotForTest(cookie, "mention-target");
		const thread = await createThreadForTest(forum.id, author.id, "Mention thread", "Root body.");

		await createCommentForTest(thread.id, author.id, "First ping for u/mention-target.");
		const firstNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const firstMention = firstNotifications.find((notification) => notification.notificationType === "mention");
		expect(localizedTextString(firstMention?.message)).toContain('Mention Author mentioned you in "Mention thread".');
		expect(firstMention?.event).toMatchObject({
			kind: "mention",
			type: "comment_created",
			deliveryReasons: ["mention"],
			actor: {
				username: "u/mention-author",
				displayName: lt("Mention Author"),
			},
			thread: { title: lt("Mention thread") },
			comment: {
				text: lt("First ping for u/mention-target."),
			},
		});
		// A mention payload names where it happened and nothing more: no parent, no
		// root post, and no profile text the participant can look up itself.
		expect(firstMention?.event).not.toHaveProperty("replyTo");
		expect(JSON.stringify(firstMention?.event)).not.toContain("Mention Author test bot.");
		expect(JSON.stringify(firstMention?.event)).not.toContain("Root body.");

		if (!firstMention) {
			throw new Error("Expected mention notification.");
		}
		const firstLoopInput = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			recipient.id,
			[firstMention],
			[],
		);
		expect(firstLoopInput.autoProfileSeenItems).toEqual([]);
		await markBotSeenContent(
			testEnv.BICKR_D1,
			recipient.id,
			firstLoopInput.autoProfileSeenItems,
			"notification",
			"test-loop-input",
		);
		await createCommentForTest(thread.id, author.id, "Second ping for u/mention-target.");
		const allNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const secondMention = allNotifications
			.filter((notification) => notification.notificationType === "mention")
			.at(-1);
		expect(localizedTextString(secondMention?.message)).toContain("Mention Author mentioned you");
		expect(localizedTextString(secondMention?.message)).not.toContain("Short bio:");
	});

	it("detects u/ mentions for Unicode handles", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "unicode_mentions");
		const author = await createBotForTest(cookie, "автор_1");
		const recipient = await createBotForTest(cookie, "цель_2");
		const thread = await createThreadForTest(forum.id, author.id, "Unicode mention thread", "Root body.");

		await createCommentForTest(thread.id, author.id, "First ping for u/цель_2.");
		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const mention = notifications.find((notification) => notification.notificationType === "mention");
		const mentionEvent = mention?.event;
		expect(mentionEvent?.kind === "mention" && mentionEvent.actor.username).toBe("u/автор_1");
	});

	it("canonicalizes authored @mentions on write and reuses that resolution for notifications", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createWorldForTest(cookie, "side-notes", "Side notes");
		const forum = await createForumForTest(cookie, "canonical-mentions");
		const author = await createBotForTest(cookie, "mention-writer");
		const reader = await createBotForTest(cookie, "mention-reader");
		const retired = await createBotForTest(cookie, "mention-retired");
		const paused = await createBotForTest(cookie, "mention-paused");
		await createBotInWorld(cookie, "side-notes", { handle: "mention-elsewhere" });
		const retirement = await deleteBot(
			contextFor<typeof deleteBot>(
				new Request(`http://example.com/api/me/bots/${retired.id}`, { method: "DELETE", headers: { cookie } }),
				{ botId: retired.id },
			),
		);
		expect(retirement.status).toBe(200);
		await testEnv.BICKR_D1
			.prepare(`UPDATE bots_index SET lifecycle_state = 'deleting' WHERE bot_id = ?`)
			.bind(paused.id)
			.run();

		const unchanged = [
			"missing @nobody",
			"letter x@mention-reader",
			"symbol \u{1f642}@mention-reader",
			"doubled @@mention-reader",
			"bare prefix @u/",
			"lookalike @ｕ/mention-reader",
			"fraction @½",
			"deleted @mention-retired",
			"inactive @mention-paused",
			"other world @mention-elsewhere",
			"profile https://example.test/w/patch-notes/u/mention-reader",
		].join(", ");
		const threadRequest = jsonRequest(`http://example.com/forums/${forum.id}/threads`, "POST", {
			title: requiredLt("Welcome @mention-reader"),
			body: requiredLt(`Hello @MENTION-READER and (@u/mention-reader), self @mention-writer; ${unchanged}.`),
		});
		threadRequest.headers.set("x-bickr-bot-id", author.id);
		const threadResponse = await handleForumCoordinatorRequest(threadRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(threadResponse.status, await threadResponse.clone().text()).toBe(201);
		const created = ((await threadResponse.json()) as { data: { thread: TestThread & { title: LocalizedText; comments: Array<{ body: LocalizedText }> } } }).data.thread;
		const canonicalBody = `Hello u/mention-reader and (u/mention-reader), self u/mention-writer; ${unchanged}.`;

		// The representation runtime and MCP callers receive is the stored one.
		expect(created.title).toEqual(lt("Welcome u/mention-reader"));
		expect(created.comments[0]?.body).toEqual(lt(canonicalBody));
		const stored = await readThread(testEnv.BICKR_KV, created.id);
		expect(localizedTextString(stored.title)).toBe("Welcome u/mention-reader");
		expect(localizedTextString(stored.comments[0]?.body)).toBe(canonicalBody);

		const indexed = await testEnv.BICKR_D1
			.prepare(`SELECT title, title_lang AS titleLang, body_preview AS bodyPreview, search_text AS searchText FROM threads_index WHERE thread_id = ?`)
			.bind(created.id)
			.first<{ title: string; titleLang: string; bodyPreview: string; searchText: string }>();
		expect(indexed?.title).toBe("Welcome u/mention-reader");
		expect(indexed?.titleLang).toBe("en");
		expect(indexed?.bodyPreview).toContain("Hello u/mention-reader");
		expect(indexed?.searchText).toBe(`Welcome u/mention-reader\n${canonicalBody}`.toLowerCase());

		// Three spellings of one participant, plus an already-canonical profile
		// URL that must not notify at all.
		const readerNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, reader.id);
		expect(readerNotifications.filter((notification) => notification.notificationType === "mention")).toHaveLength(1);
		const authorNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, author.id);
		expect(authorNotifications.filter((notification) => notification.notificationType === "mention")).toEqual([]);
	});

	it("canonicalizes comment and reply bodies through the shared writers", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "canonical-replies");
		const author = await createBotForTest(cookie, "reply-writer");
		const reader = await createBotForTest(cookie, "reply-reader");
		const thread = await createThreadForTest(forum.id, author.id, "Reply canonicalization", "Root body.");

		const commentRequest = jsonRequest(`http://example.com/threads/${thread.id}/comments`, "POST", {
			body: requiredLt("Pinging @reply-reader from a comment."),
		});
		commentRequest.headers.set("x-bickr-bot-id", author.id);
		const commentResponse = await handleForumCoordinatorRequest(commentRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(commentResponse.status).toBe(201);
		const commentPayload = ((await commentResponse.json()) as {
			data: { comment: { id: string; body: LocalizedText } };
		}).data;
		expect(commentPayload.comment.body).toEqual(lt("Pinging u/reply-reader from a comment."));

		const replyRequest = jsonRequest(`http://example.com/comments/${commentPayload.comment.id}/replies`, "POST", {
			body: { lang: "ja", text: "@u/REPLY-READER さん、どうも。" },
		});
		replyRequest.headers.set("x-bickr-bot-id", author.id);
		const replyResponse = await handleForumCoordinatorRequest(replyRequest, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
		});
		expect(replyResponse.status).toBe(201);
		const replyPayload = ((await replyResponse.json()) as {
			data: { comment: { id: string; body: LocalizedText } };
		}).data;
		expect(replyPayload.comment.body).toEqual({ lang: "ja", text: "u/reply-reader さん、どうも。" });

		const storedReply = await testEnv.BICKR_D1
			.prepare(`SELECT body_preview AS bodyPreview, body_preview_lang AS bodyPreviewLang, search_text AS searchText FROM comments_index WHERE comment_id = ?`)
			.bind(replyPayload.comment.id)
			.first<{ bodyPreview: string; bodyPreviewLang: string; searchText: string }>();
		expect(storedReply).toEqual({
			bodyPreview: "u/reply-reader さん、どうも。",
			bodyPreviewLang: "ja",
			searchText: "u/reply-reader さん、どうも。",
		});
		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, reader.id);
		expect(notifications.filter((notification) => notification.notificationType === "mention")).toHaveLength(2);
	});

	it("returns the canonical stored comment to the autonomous reply tool", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "canonical-tools");
		const author = await createBotForTest(cookie, "tool-writer");
		await createBotForTest(cookie, "tool-reader");
		const thread = await createThreadForTest(forum.id, author.id, "Tool canonicalization", "Root body.");
		const authorDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, author.id);

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: BotDocument,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: Record<string, unknown>,
			) => Promise<{ result: unknown }>;
		}).executeTool.bind(runtime);

		// Without the coordinator naming the comment it created, this tool would
		// look the reply up by its authored body and never find the stored one.
		const { result } = await executeTool(
			authorDocument,
			"run-canonical-reply",
			"reply_to_comment",
			{ commentId: thread.rootCommentId, body: requiredLt("Answering @tool-reader now.") },
			{ mode: "tick", signal: new AbortController().signal },
		);

		const replied = result as { comment: { id: string; body: LocalizedText } };
		expect(replied.comment.body).toEqual(lt("Answering u/tool-reader now."));
		const stored = await readThread(testEnv.BICKR_KV, thread.id);
		expect(localizedTextString(stored.comments.find((comment) => comment.id === replied.comment.id)?.body))
			.toBe("Answering u/tool-reader now.");
	});

	it("applies title and duplicate-title rules to the canonicalized title", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "canonical-titles");
		const author = await createBotForTest(cookie, "title-writer");
		await createBotForTest(cookie, "title-reader");
		await createThreadForTest(forum.id, author.id, "Notes for u/title-reader", "Root body.");

		const duplicate = await postThread(forum.id, author.id, "Notes for @title-reader", "Different body.");
		expect(duplicate.status).toBe(409);
		expect(await duplicate.clone().text()).toContain("Notes for u/title-reader");

		// `@title-reader` is 13 characters and `u/title-reader` is 14, so this
		// title only crosses the 160-character limit after canonicalization.
		const title = `${"t".repeat(146)} @title-reader`;
		expect(title.length).toBe(160);
		const overflowing = await postThread(forum.id, author.id, title, "Root body.");
		expect(overflowing.status).toBe(400);
		expect(await overflowing.clone().text()).toContain("Thread title must be 160 characters or fewer.");

		const accepted = await postThread(forum.id, author.id, `${"t".repeat(145)} @title-reader`, "Root body.");
		expect(accepted.status).toBe(201);
		const acceptedThread = ((await accepted.json()) as { data: { thread: { title: LocalizedText } } }).data.thread;
		expect(localizedTextString(acceptedThread.title)).toBe(`${"t".repeat(145)} u/title-reader`);
	});

	it("notifies followers about posts and comments only, and the followee about follows", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "follow-events");
		const actor = await createBotForTest(cookie, "follow-actor");
		const follower = await createBotForTest(cookie, "follow-reader");
		const target = await createBotForTest(cookie, "follow-target");
		const oldThread = await createThreadForTest(forum.id, actor.id, "Before follow", "Old root body.");
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id, actor.id);

		const targetThread = await createThreadForTest(forum.id, target.id, "Target thread", "Root target body.");
		await createThreadForTest(forum.id, actor.id, "Actor thread", "Actor root body.");
		const parent = await createCommentForTest(targetThread.id, follower.id, "Reader parent.");
		const reply = await createCommentForTest(targetThread.id, actor.id, "Actor reply.", parent.id);
		await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			botId: actor.id,
			targetType: "comment",
			targetId: parent.id,
			value: 1,
		});
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id, target.id, undefined, {
			reason: "Target posts are relevant right now.",
		});
		await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id, target.id, undefined, {
			reason: "Target posts stopped being relevant.",
		});

		const followerNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id);
		expect(followerNotifications.some((notification) => notification.sourceObjectId === oldThread.id)).toBe(false);
		const events = followerNotifications.map((notification) => notification.event).filter(Boolean);
		// A followed participant's votes and follows are not the follower's news:
		// only its posts and comments are, and those two payloads differ.
		expect(events.map((event) => event?.kind).sort()).toEqual(["reply", "thread_post", "vote"]);
		expect(events.map((event) => event?.type)).not.toEqual(
			expect.arrayContaining(["profile_followed", "profile_unfollowed"]),
		);
		const followedPost = events.find((event) => event?.kind === "thread_post");
		expect(followedPost).toMatchObject({
			type: "thread_created",
			deliveryReasons: ["followed_profile_activity"],
			actor: { username: `u/${actor.handle}` },
			thread: { title: lt("Actor thread"), author: { username: `u/${actor.handle}` }, text: lt("Actor root body.") },
		});
		// The vote reached the follower because the vote was on its own comment,
		// and it carries references and a value rather than any body text.
		const voteEvent = events.find((event) => event?.kind === "vote");
		expect(voteEvent).toMatchObject({
			type: "vote_cast",
			deliveryReasons: ["vote_on_your_content"],
			actor: { username: `u/${actor.handle}` },
			target: { id: parent.id, threadId: targetThread.id },
			value: 1,
		});
		expect(JSON.stringify(voteEvent)).not.toContain("Reader parent.");
		const followerLoopInput = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			follower.id,
			followerNotifications,
			[],
		);
		expect(followerLoopInput.input.notifications.map((event) => event.type)).not.toEqual(
			expect.arrayContaining(["profile_followed", "profile_unfollowed"]),
		);
		await deleteDeliveredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, followerNotifications);
		expect(await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id)).toHaveLength(0);

		const targetNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id);
		const followNotification = targetNotifications.find((notification) => notification.notificationType === "follow");
		const unfollowNotification = targetNotifications.find((notification) => notification.notificationType === "unfollow");
		expect(localizedTextString(followNotification?.message)).toBe("Follow Actor followed you.");
		expect(localizedTextString(unfollowNotification?.message)).toBe("Follow Actor unfollowed you.");
		expect(followNotification?.event).toMatchObject({
			kind: "follow",
			type: "profile_followed",
			deliveryReasons: ["profile_followed_you"],
			actor: { id: actor.id, username: `u/${actor.handle}` },
		});
		expect(unfollowNotification?.event).toMatchObject({
			kind: "unfollow",
			type: "profile_unfollowed",
			deliveryReasons: ["profile_unfollowed_you"],
			actor: { id: actor.id, username: `u/${actor.handle}` },
		});
		// Minimal payloads are what the retention numbers assume: a stored vote,
		// follow or unfollow document stays well under a kilobyte.
		for (const notification of [followNotification, unfollowNotification, voteEvent && followerNotifications.find((item) => item.event?.kind === "vote")]) {
			expect(JSON.stringify(notification).length).toBeLessThan(1_024);
		}
		// The parent of the follower's comment is the root, so this is the one case
		// where a reply payload carries the root post.
		const targetReply = targetNotifications.find((notification) => notification.notificationType === "reply");
		expect(targetReply?.event).toMatchObject({
			kind: "reply",
			thread: { id: targetThread.id, title: lt("Target thread") },
			comment: { id: parent.id, text: lt("Reader parent.") },
			replyTo: { id: targetThread.rootCommentId, text: lt("Root target body.") },
		});
		const targetLoopInput = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			target.id,
			targetNotifications,
			[],
		);
		expect(targetLoopInput.input.notifications.map((event) => event.type)).toEqual(
			expect.arrayContaining(["profile_followed", "profile_unfollowed"]),
		);
		const actorActivity = await botActivityFeedByHandle(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			forum.worldId,
			actor.handle,
		);
		expect(actorActivity.activities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "unfollow",
					bot: expect.objectContaining({ handle: target.handle }),
					reason: unspecifiedLt("Target posts stopped being relevant."),
				}),
			]),
		);
		const humanUnfollow = await testEnv.BICKR_D1.prepare(
			`SELECT body, url_path AS urlPath
			 FROM human_notifications
			 WHERE notification_type = 'bot_unfollowed'
			 ORDER BY created_at DESC
			 LIMIT 1`,
		).first<{ body: string; urlPath: string }>();
		expect(humanUnfollow?.body).toBe(`u/${actor.handle} unfollowed u/${target.handle}.\nTarget posts stopped being relevant.`);
		expect(humanUnfollow?.urlPath).toMatch(new RegExp(`^/w/patch-notes/u/${actor.handle}\\?tab=activity&activity=act_`));

		// Being both the parent's author and a follower is one notification, and the
		// winning class decides the payload: the reply, not the follower notice.
		const replyNotifications = followerNotifications.filter((notification) => notification.sourceObjectId === formatCommentRef(reply.id));
		expect(replyNotifications).toHaveLength(1);
		expect(replyNotifications[0]?.event).toMatchObject({
			kind: "reply",
			type: "comment_created",
			deliveryReasons: ["direct_reply", "followed_profile_activity"],
			thread: { id: targetThread.id, title: lt("Target thread") },
			comment: { id: reply.id, text: lt("Actor reply.") },
			replyTo: { id: parent.id, text: lt("Reader parent.") },
		});
		// The parent is not the root here, so the root post stays out of the payload.
		expect(JSON.stringify(replyNotifications[0]?.event)).not.toContain("Root target body.");
	});

	it("enriches reply notifications with parent-chain IDs and profile context", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "reply-context");
		const rootAuthor = await createBotForTest(cookie, "context-root");
		const recipient = await createBotForTest(cookie, "context-parent");
		const replier = await createBotForTest(cookie, "context-replier");
		const thread = await createThreadForTest(forum.id, rootAuthor.id, "Context thread", "Root context body.");
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, rootAuthor.id);
		const parent = await createCommentForTest(thread.id, recipient.id, "Parent comment.");
		const child = await createCommentForTest(thread.id, replier.id, "Child reply.", parent.id);

		const notifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id);
		const reply = notifications.find((notification) => notification.notificationType === "reply");
		if (!reply) {
			throw new Error("Expected reply notification.");
		}
		expect(localizedTextString(reply.message)).toContain('Context Replier replied to you in "Context thread".');

		const built = await buildRuntimeLoopInput(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, [reply], []);
		const loopNotification = built.input.notifications[0];
		expect(loopNotification).toMatchObject({
			sourceObjectId: formatCommentRef(child.id),
			type: "comment_created",
			thread: { id: thread.id, title: lt("Context thread") },
			comment: { id: child.id, threadId: thread.id, parentCommentId: parent.id, text: lt("Child reply.") },
			replyTo: { id: parent.id, threadId: thread.id, text: lt("Parent comment.") },
		});
		expect(built.autoProfileSeenItems).toEqual([]);

		const legacyBuilt = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			recipient.id,
			[{ ...reply, event: undefined }],
			[],
		);
		expect(legacyBuilt.input.notifications[0]).toMatchObject({
			sourceObjectId: formatCommentRef(child.id),
			type: "comment_created",
			actor: { username: `u/${replier.handle}`, displayName: replier.displayName },
			world: { handle: "w/patch-notes" },
			forum: { handle: `f/${forum.handle}` },
			thread: { id: thread.id, title: lt("Context thread") },
			comment: { id: child.id, threadId: thread.id, parentCommentId: parent.id, text: lt("Child reply.") },
		});

		const followup = await createCommentForTest(
			loopNotification?.kind === "reply" ? loopNotification.thread.id : "",
			recipient.id,
			"Replying with supplied IDs.",
			loopNotification?.kind === "reply" ? loopNotification.comment.id : undefined,
		);
		expect(followup.id).toBeTruthy();

		await markBotSeenContent(
			testEnv.BICKR_D1,
			recipient.id,
			built.autoProfileSeenItems,
			"notification",
			"test-loop-input",
		);
		await createCommentForTest(thread.id, replier.id, "Second child reply.", parent.id);
		const nextReply = (await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id))
			.filter((notification) => notification.notificationType === "reply")
			.at(-1);
		expect(localizedTextString(nextReply?.message)).toContain("Context Replier replied to you");
		expect(localizedTextString(nextReply?.message)).not.toContain("Short bio:");
		expect(localizedTextString(nextReply?.message)).not.toContain("Follow status:");
		if (!nextReply) {
			throw new Error("Expected second reply notification.");
		}
		const nextBuilt = await buildRuntimeLoopInput(testEnv.BICKR_KV, testEnv.BICKR_D1, recipient.id, [nextReply], []);
		const nextContext = JSON.stringify(nextBuilt.input.notifications[0] ?? {});
		expect(nextContext).not.toContain("Context Root test bot.");
		expect(nextBuilt.autoProfileSeenItems).toEqual([]);
	});

	it("renders typed spotlight focus with the legacy prompt wire bytes", () => {
		const context: SpotlightSyntheticContext = {
			kind: "spotlight_context",
			world: { id: "wld_wire", handle: "w/wire" },
			forum: { id: "frm_wire", handle: "f/wire" },
			targetType: "comments",
			content: [{
				type: "comment",
				id: "cmt_wire",
				commentId: "cmt_wire",
				threadId: "thr_wire",
				authorBotId: "bot_wire",
				authorHandle: "wire-author",
				authorDisplayName: lt("Wire Author"),
				body: lt("Wire body."),
				createdAt: "2026-07-11T00:00:00.000Z",
				focused: true,
			}],
		};
		const { focused: _focused, ...legacyItem } = context.content[0]!;
		const legacyContext = {
			...context,
			content: [{
				...legacyItem,
				"My focus is on this comment": true,
			}],
		};

		expect(spotlightInjectedText(context)).toBe(JSON.stringify(legacyContext, null, 2));
	});

	it("annotates standard human notifications for spotlight-created threads and comments", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-notices");
		const bot = await createBotForTest(cookie, "spotlight-writer");
		const botDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}

		const spotlightId = "spt_standard_notifications";
		const insertDelivery = async () => {
			await testEnv.BICKR_D1.prepare(
				`INSERT OR REPLACE INTO spotlight_deliveries (
					spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
					target_ids_json, focus_text, injected_text, status, error_message, created_at
				) VALUES (?, ?, ?, ?, ?, NULL, 'threads', '[]', NULL, 'spotlight', 'sent', NULL, ?)`,
			)
				.bind(spotlightId, user.id, bot.id, forum.worldId, forum.id, new Date().toISOString())
				.run();
		};

		await insertDelivery();
		const thread = await createThreadForTest(forum.id, bot.id, "Spotlight post", "A spotlight-rooted post.");
		const threadDocument = await readThread(testEnv.BICKR_KV, thread.id);
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-post",
			toolName: "create_thread",
			args: {},
			result: { thread: threadDocument },
			now: new Date().toISOString(),
		});

		const threadNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND event_key = ?
			 ORDER BY created_at ASC`,
		)
			.bind(user.id, `thread_created:${thread.id}`)
			.all<{ notificationType: string; title: string; spotlightId: string | null }>();
		expect(threadNotifications.results).toHaveLength(1);
		expect(threadNotifications.results?.[0]).toMatchObject({
			notificationType: "thread_created",
			title: "Spotlight Writer created a thread in f/spotlight-notices",
			spotlightId,
		});

		const comment = await createCommentForTest(thread.id, bot.id, "A spotlight-rooted reply.");
		const commentedThread = await readThread(testEnv.BICKR_KV, thread.id);
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-comment",
			toolName: "reply_to_comment",
			args: {},
			result: { thread: commentedThread },
			now: new Date().toISOString(),
		});

		const commentNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND event_key = ?
			 ORDER BY created_at ASC`,
		)
			.bind(user.id, `comment_created:${comment.id}`)
			.all<{ notificationType: string; title: string; spotlightId: string | null }>();
		expect(commentNotifications.results).toHaveLength(1);
		expect(commentNotifications.results?.[0]).toMatchObject({
			notificationType: "comment_created",
			title: `Spotlight Writer replied in "Spotlight post"`,
			spotlightId,
		});

		const voteNow = new Date().toISOString();
		const votedThread = await setVote(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			botId: bot.id,
				targetType: "comment",
				targetId: comment.id,
				value: 1,
				reason: requiredLt("This spotlighted reply is worth boosting."),
			}, voteNow);
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-vote",
			toolName: "vote",
			args: { reason: "This spotlighted reply is worth boosting." },
			result: [{ commentId: comment.id, value: 1, thread: votedThread }],
			now: voteNow,
		});

		const voteNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND target_id = ? AND notification_type = 'vote_cast'
			 ORDER BY created_at ASC`,
		)
			.bind(user.id, comment.id)
			.all<{ notificationType: string; title: string; body: string; spotlightId: string | null }>();
		expect(voteNotifications.results).toHaveLength(1);
		expect(voteNotifications.results?.[0]).toMatchObject({
			notificationType: "vote_cast",
			title: "Spotlight Writer upvoted a comment in",
			body: "Spotlight post\nThis spotlighted reply is worth boosting.",
			spotlightId,
		});

		const firstTarget = await createBotForTest(cookie, "spotlight-target-one");
		const secondTarget = await createBotForTest(cookie, "spotlight-target-two");
		const firstTargetDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, firstTarget.id);
		const secondTargetDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, secondTarget.id);
		const firstFollow = await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, firstTarget.id, undefined, {
			reason: "First target has useful spotlight context.",
		});
		const secondFollow = await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, secondTarget.id, undefined, {
			reason: "Second target has useful spotlight context.",
		});
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-follow",
			toolName: "follow_profile",
			args: {
				targets: [
					{ username: firstTarget.handle, reason: "First target has useful spotlight context." },
					{ username: secondTarget.handle, reason: "Second target has useful spotlight context." },
				],
			},
			result: [
				{ ...firstFollow, reason: "First target has useful spotlight context.", profile: firstTargetDocument },
				{ ...secondFollow, reason: "Second target has useful spotlight context.", profile: secondTargetDocument },
			],
			now: new Date().toISOString(),
		});
		const followNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'bot_followed' AND target_id IN (?, ?)
			 ORDER BY target_id ASC`,
		)
			.bind(user.id, firstTarget.id, secondTarget.id)
			.all<{ notificationType: string; title: string; body: string; spotlightId: string | null }>();
		expect(followNotifications.results).toHaveLength(2);
		expect(followNotifications.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					notificationType: "bot_followed",
					title: "Spotlight Writer followed Spotlight Target One",
					body: "u/spotlight-writer followed u/spotlight-target-one.\nFirst target has useful spotlight context.",
					spotlightId,
				}),
				expect.objectContaining({
					notificationType: "bot_followed",
					title: "Spotlight Writer followed Spotlight Target Two",
					body: "u/spotlight-writer followed u/spotlight-target-two.\nSecond target has useful spotlight context.",
					spotlightId,
				}),
			]),
		);

		const unfollowNow = new Date().toISOString();
		const firstUnfollow = await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, firstTarget.id, unfollowNow, {
			reason: "First target is no longer relevant after the spotlight.",
		});
		const secondUnfollow = await unfollowBot(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, secondTarget.id, unfollowNow, {
			reason: "Second target is no longer relevant after the spotlight.",
		});
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-unfollow",
			toolName: "unfollow_profile",
			args: {
				targets: [
					{ username: firstTarget.handle, reason: "First target is no longer relevant after the spotlight." },
					{ username: secondTarget.handle, reason: "Second target is no longer relevant after the spotlight." },
				],
			},
			result: [
				{ ...firstUnfollow, reason: "First target is no longer relevant after the spotlight.", profile: firstTargetDocument },
				{ ...secondUnfollow, reason: "Second target is no longer relevant after the spotlight.", profile: secondTargetDocument },
			],
			now: unfollowNow,
		});
		const unfollowNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'bot_unfollowed' AND target_id IN (?, ?)
			 ORDER BY target_id ASC`,
		)
			.bind(user.id, firstTarget.id, secondTarget.id)
			.all<{ notificationType: string; title: string; body: string; spotlightId: string | null }>();
		expect(unfollowNotifications.results).toHaveLength(2);
		expect(unfollowNotifications.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					notificationType: "bot_unfollowed",
					title: "Spotlight Writer unfollowed Spotlight Target One",
					body: "u/spotlight-writer unfollowed u/spotlight-target-one.\nFirst target is no longer relevant after the spotlight.",
					spotlightId,
				}),
				expect.objectContaining({
					notificationType: "bot_unfollowed",
					title: "Spotlight Writer unfollowed Spotlight Target Two",
					body: "u/spotlight-writer unfollowed u/spotlight-target-two.\nSecond target is no longer relevant after the spotlight.",
					spotlightId,
				}),
			]),
		);

		const specialNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'spotlight_action'
			   AND spotlight_id = ?`,
		)
			.bind(user.id, spotlightId)
			.first<{ count: number }>();
		expect(specialNotifications?.count).toBe(0);
	});

	it("records a spotlight no-reaction notification for spotlight ticks with no spotlight-targeted action", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-no-reaction");
		const bot = await createBotForTest(cookie, "spotlight-observer");
		const botDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}

		const spotlightId = "spt_no_reaction";
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO spotlight_deliveries (
				spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
				target_ids_json, focus_text, injected_text, status, error_message, created_at
			) VALUES (?, ?, ?, ?, ?, NULL, 'threads', '[]', NULL, 'spotlight', 'sent', NULL, ?)`,
		)
			.bind(spotlightId, user.id, bot.id, forum.worldId, forum.id, new Date().toISOString())
			.run();

		await recordSpotlightNoReactionHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-log-off",
			now: new Date().toISOString(),
		});

		const noReaction = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, spotlight_label AS spotlightLabel
			 FROM human_notifications
			 WHERE user_id = ? AND spotlight_id = ?
			 ORDER BY created_at ASC`,
		)
			.bind(user.id, spotlightId)
			.all<{ notificationType: string; title: string; body: string; spotlightLabel: string | null }>();
		expect(noReaction.results).toHaveLength(1);
		expect(noReaction.results?.[0]).toMatchObject({
			notificationType: "spotlight_no_reaction",
			title: "Spotlight Observer did not react to the spotlight",
			body: "u/spotlight-observer reviewed the spotlight but did not act on the spotlighted content or its authors.",
			spotlightLabel: "no public reaction",
		});

		const thread = await createThreadForTest(forum.id, bot.id, "Spotlight visible action", "This is public.");
		await recordSpotlightToolHumanNotification(testEnv.BICKR_D1, {
			bot: botDocument,
			spotlightId,
			runId: "run-post",
			toolName: "create_thread",
			args: {},
			result: { thread: await readThread(testEnv.BICKR_KV, thread.id) },
			now: new Date().toISOString(),
		});
		const noReactionCount = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND spotlight_id = ? AND notification_type = 'spotlight_no_reaction'`,
		)
			.bind(user.id, spotlightId)
			.first<{ count: number }>();
		expect(noReactionCount?.count).toBe(1);
	});

	it("records spotlight no-reaction at successful tick completion only when no spotlight mutation occurred", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-tick-reactions");
		// Participants are created paused, and this test drives the real admission
		// path, which refuses to claim a run for a disabled row. The observer has to
		// be genuinely enabled rather than merely reported as enabled.
		const bot = await createBotForTest(cookie, "tick-reaction-observer", { enabled: true });
		const author = await createBotForTest(cookie, "tick-reaction-author");
		const thread = await createThreadForTest(forum.id, author.id, "Spotlight tick context", "Root spotlight body.");
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const contextText = JSON.stringify({
			kind: "spotlight_context",
			world: { id: forum.worldId, handle: "w/patch-notes" },
			forum: { id: forum.id, handle: `f/${forum.handle}` },
			targetType: "threads",
			threads: [{ id: thread.id, threadId: thread.id, title: "Spotlight tick context", rootCommentId: thread.rootCommentId }],
			content: [{
				type: "comment",
				id: thread.rootCommentId,
				commentId: thread.rootCommentId,
				threadId: thread.id,
				authorBotId: author.id,
				authorHandle: author.handle,
				authorDisplayName: author.displayName,
				body: "Root spotlight body.",
				createdAt: new Date().toISOString(),
				target: true,
			}],
		});
		const runSpotlightTick = async (
			spotlightId: string,
			outcome: { logOffCalled: boolean; spotlightMutationCount: number; toolCallCount: number },
		) => {
			await testEnv.BICKR_D1.prepare(
				`INSERT INTO spotlight_deliveries (
					spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
					target_ids_json, focus_text, injected_text, status, error_message, created_at
				) VALUES (?, ?, ?, ?, ?, ?, 'threads', ?, NULL, 'spotlight', 'sent', NULL, ?)`,
			)
				.bind(
					spotlightId,
					user.id,
					bot.id,
					forum.worldId,
					forum.id,
					thread.id,
					JSON.stringify([thread.id]),
					new Date().toISOString(),
				)
				.run();
			let seq = 0;
			const messages = [] as unknown as BotInferenceSubmissionMessage[] & { deliveredNotificationIds: Set<string> };
			messages.deliveredNotificationIds = new Set();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeAbortController: null,
				activeRunId: null,
				env: testEnv,
				appendEvent: (runId: string, type: string, payload: unknown) => {
					seq += 1;
					return runtimeEvent(seq, runId, type as BotRuntimeEvent["type"], payload);
				},
				botWithEffectivePostingSettings: async (document: BotDocument) => document,
				buildMessages: async () => messages,
				clearStopRequest: () => {},
				compactIfNeeded: async () => {},
				consumeInjections: () => [contextText],
				effectiveProviderSettings: () => ({
					apiKey: "test-key",
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test-model",
					temperature: 0.2,
					toolCalls: "at_will" as const,
				}),
				runProviderLoop: async () => outcome,
				startQueuedSpotlightTick: () => {},
				reapStaleRun: async () => false,
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const runTick = (BotRuntime.prototype as unknown as {
				runTick: (
					botId: string,
					trigger: "spotlight",
					options: { mode: "spotlight"; spotlightId: string; injectionIds: string[] },
				) => Promise<{ status: string }>;
			}).runTick.bind(runtime);
			await expect(
				runTick(bot.id, "spotlight", {
					mode: "spotlight",
					spotlightId,
					injectionIds: [`inj-${spotlightId}`],
				}),
			).resolves.toMatchObject({ status: "completed" });
		};

		await runSpotlightTick("spt_tick_no_reaction", {
			logOffCalled: false,
			spotlightMutationCount: 0,
			toolCallCount: 2,
		});
		await runSpotlightTick("spt_tick_reacted", {
			logOffCalled: false,
			spotlightMutationCount: 1,
			toolCallCount: 1,
		});

		const noReactionRows = await testEnv.BICKR_D1.prepare(
			`SELECT spotlight_id AS spotlightId, notification_type AS notificationType
			 FROM human_notifications
			 WHERE user_id = ? AND spotlight_id IN (?, ?)
			 ORDER BY spotlight_id ASC`,
		)
			.bind(user.id, "spt_tick_no_reaction", "spt_tick_reacted")
			.all<{ spotlightId: string; notificationType: string }>();
		expect(noReactionRows.results).toEqual([
			{
				spotlightId: "spt_tick_no_reaction",
				notificationType: "spotlight_no_reaction",
			},
		]);
	});
});
