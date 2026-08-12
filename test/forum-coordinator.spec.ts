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
	createCommentForTest,
	createForum,
	createForumForTest,
	createThreadForTest,
	createWorld,
	deferred,
	deleteBot,
	deleteCommentRoute,
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
	markNotificationsDelivered,
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
	spotlightPreview,
	spotlightSend,
	spotlightInjectedText,
	testEnv,
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
	SpotlightPreviewPayload,
	SpotlightSendPayload,
	SpotlightSyntheticContext,
	TestForum,
	TestThread,
	ThreadDetailPayload,
	ThreadFreshCacheEntryForTest,
	ThreadListPayload,
} from "./helpers/index-harness";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import { notificationKvTtlSince, pruneExpiredBotSeenContent, pruneExpiredNotifications } from "@bickr/shared/social";
import { botInferenceUsageRetentionDays } from "@bickr/shared/token-spend";
import type { KVNamespaceLike } from "@bickr/shared/storage";
import type { ForumDocument } from "@bickr/shared/model";

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

async function runForumCoordinatorScheduled(scheduledTime: string): Promise<void> {
	if (!forumCoordinatorWorker.scheduled) {
		throw new Error("Forum coordinator scheduled handler is missing.");
	}
	const pending: Array<Promise<unknown>> = [];
	const controller = {
		scheduledTime: Date.parse(scheduledTime),
		cron: "0 0 * * *",
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

type BotNotificationStatus = "pending" | "delivered_to_loop" | "read_or_consumed" | "archived";

async function insertBotNotificationForRetention(input: {
	id: string;
	status: BotNotificationStatus;
	createdAt: string;
	botId?: string;
}): Promise<void> {
	const botId = input.botId ?? "bot_retention";
	await testEnv.BICKR_KV.put(kvKeys.notification(botId, input.id), JSON.stringify({
		id: input.id,
		type: "notification",
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
			"system",
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

async function insertHumanNotificationForRetention(id: string, createdAt: string): Promise<void> {
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO human_notifications (
			notification_id, user_id, world_id, event_key, notification_type,
			actor_bot_id, actor_handle, actor_display_name, title, body, url_path, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			"usr_retention",
			"wld_retention",
			`retention:${id}`,
			"thread_created",
			"bot_retention",
			"retention-bot",
			"Retention Bot",
			"Old human notification",
			"Out of scope",
			"/",
			createdAt,
		)
		.run();
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

	it("prunes expired bot notifications from the forum coordinator cron", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		await insertBotNotificationForRetention({
			id: "ntf_expired_pending",
			status: "pending",
			createdAt: daysBefore(now, 91),
		});
		await insertBotNotificationForRetention({
			id: "ntf_expired_delivered",
			status: "delivered_to_loop",
			createdAt: daysBefore(now, 31),
		});
		await insertBotNotificationForRetention({
			id: "ntf_expired_read",
			status: "read_or_consumed",
			createdAt: daysBefore(now, 31),
		});
		await insertBotNotificationForRetention({
			id: "ntf_expired_archived",
			status: "archived",
			createdAt: daysBefore(now, 31),
		});
		await insertBotNotificationForRetention({
			id: "ntf_recent_delivered",
			status: "delivered_to_loop",
			createdAt: daysBefore(now, 29),
		});
		await insertBotNotificationForRetention({
			id: "ntf_young_pending",
			status: "pending",
			createdAt: daysBefore(now, 89),
		});
		await insertHumanNotificationForRetention("hnt_old_out_of_scope", daysBefore(now, 120));
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

		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		let retentionLog: Record<string, unknown> | undefined;
		try {
			await runForumCoordinatorScheduled(now);
			retentionLog = consoleLog.mock.calls
				.map(([message]) => {
					try {
						return JSON.parse(String(message)) as Record<string, unknown>;
					} catch {
						return {};
					}
				})
				.find((payload) => payload.event === "retention_prune");
		} finally {
			consoleLog.mockRestore();
		}

		expect(await botNotificationRowIds()).toEqual(["ntf_recent_delivered", "ntf_young_pending"]);
		for (const id of ["ntf_expired_pending", "ntf_expired_delivered", "ntf_expired_read", "ntf_expired_archived"]) {
			expect(await botNotificationKvExists(id)).toBe(false);
		}
		expect(await botNotificationKvExists("ntf_recent_delivered")).toBe(true);
		expect(await botNotificationKvExists("ntf_young_pending")).toBe(true);
		expect(await humanNotificationExists("hnt_old_out_of_scope")).toBe(true);
		expect(await botSeenContentRowIds()).toEqual(["thr_seen_retained"]);
		expect(await botInferenceUsageSourceIds()).toEqual([2]);
		expect(retentionLog).toMatchObject({
			event: "retention_prune",
			hotScores: { recentCommentCountsRefreshed: true },
			notificationPrune: {
				deletedRows: 4,
				kvDeleteFailures: 0,
			},
			botSeenContentPrune: {
				deletedRows: 1,
			},
			inferenceUsagePrune: {
				deletedRows: 1,
			},
			indexRepair: {
				scanned: 0,
				repaired: 0,
				budgetExhausted: false,
			},
		});
	});

	it("logs the retention_prune summary before a failed maintenance task propagates", async () => {
		const now = "2026-07-01T00:00:00.000Z";
		await insertBotNotificationForRetention({
			id: "ntf_expired_for_failure_run",
			status: "delivered_to_loop",
			createdAt: daysBefore(now, 31),
		});
		await testEnv.BICKR_D1.prepare(`ALTER TABLE bot_seen_content RENAME TO bot_seen_content_hidden`).run();

		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		let retentionLog: Record<string, unknown> | undefined;
		try {
			await expect(runForumCoordinatorScheduled(now)).rejects.toThrow();
			retentionLog = consoleLog.mock.calls
				.map(([message]) => {
					try {
						return JSON.parse(String(message)) as Record<string, unknown>;
					} catch {
						return {};
					}
				})
				.find((payload) => payload.event === "retention_prune");
		} finally {
			consoleLog.mockRestore();
			await testEnv.BICKR_D1.prepare(`ALTER TABLE bot_seen_content_hidden RENAME TO bot_seen_content`).run();
		}

		expect(retentionLog).toMatchObject({
			event: "retention_prune",
			notificationPrune: { deletedRows: 1 },
			indexRepair: { scanned: 0, repaired: 0, budgetExhausted: false },
		});
		expect((retentionLog?.botSeenContentPrune as { error?: string })?.error).toContain("bot_seen_content");
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

	it("uses D1-only pruning only for TTL-backed notification rows at or after the cutover", async () => {
		const now = "2026-08-13T00:00:00.000Z";
		await insertBotNotificationForRetention({
			id: "ntf_pre_cutover",
			status: "delivered_to_loop",
			createdAt: "2026-07-11T23:59:59.999Z",
		});
		await insertBotNotificationForRetention({
			id: "ntf_at_cutover",
			status: "delivered_to_loop",
			createdAt: notificationKvTtlSince,
		});

		const result = await pruneExpiredNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			now,
			maxRowsPerRun: 0,
		});

		expect(result).toMatchObject({
			deletedRows: 1,
			phase1DeletedRows: 1,
			phase2DeletedRows: 0,
			selectedRows: 0,
			kvDeleteFailures: 0,
			budgetExhausted: false,
		});
		expect(await botNotificationRowIds()).toEqual(["ntf_pre_cutover"]);
		expect(await botNotificationKvExists("ntf_pre_cutover")).toBe(true);
		expect(await botNotificationKvExists("ntf_at_cutover")).toBe(true);
	});

	it("keeps legacy KV deletes below the TTL cutover boundary", async () => {
		const now = "2026-08-13T00:00:00.000Z";
		await insertBotNotificationForRetention({
			id: "ntf_legacy_boundary",
			status: "delivered_to_loop",
			createdAt: "2026-07-11T23:59:59.999Z",
		});
		await insertBotNotificationForRetention({
			id: "ntf_ttl_boundary",
			status: "delivered_to_loop",
			createdAt: notificationKvTtlSince,
		});
		const kv = kvWithScriptedDeletes();

		const result = await pruneExpiredNotifications(kv, testEnv.BICKR_D1, {
			now,
			selectLimit: 10,
			maxRowsPerRun: 10,
		});

		expect(result).toMatchObject({
			deletedRows: 2,
			phase1DeletedRows: 1,
			phase2DeletedRows: 1,
			selectedRows: 1,
			kvDeleteFailures: 0,
		});
		expect(kv.deletedKeys).toEqual([botNotificationKvKey("ntf_legacy_boundary")]);
		expect(await botNotificationRowIds()).toEqual([]);
		expect(await botNotificationKvExists("ntf_legacy_boundary")).toBe(false);
		expect(await botNotificationKvExists("ntf_ttl_boundary")).toBe(true);
	});

	it("retains legacy D1 rows when their KV delete fails", async () => {
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

		expect(firstRun).toMatchObject({
			selectedRows: 2,
			deletedRows: 1,
			phase1DeletedRows: 0,
			phase2DeletedRows: 1,
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
			phase2DeletedRows: 1,
			kvDeleteFailures: 0,
		});
		expect(await botNotificationRowIds()).toEqual([]);
		expect(await botNotificationKvExists("ntf_failed_kv_delete")).toBe(false);
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
			type: "comment_created",
			deliveryReasons: ["mention"],
			actor: {
				username: "u/mention-author",
				displayName: lt("Mention Author"),
				shortBio: lt("Mention Author test bot."),
			},
			comment: {
				text: lt("First ping for u/mention-target."),
			},
		});

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
		expect(mention?.event?.actor?.username).toBe("u/автор_1");
	});

	it("fans followed public activity into one structured notification per action", async () => {
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
		expect(events.map((event) => event?.type)).toEqual(
			expect.arrayContaining(["thread_created", "comment_created", "vote_cast", "profile_followed", "profile_unfollowed"]),
		);
		expect(events.every((event) => event?.deliveryReasons.includes("followed_profile_activity"))).toBe(true);
		expect(events.find((event) => event?.type === "vote_cast")).toMatchObject({
			target: { id: parent.id, author: { username: `u/${follower.handle}` } },
			vote: { targetType: "comment", commentId: parent.id, value: 1 },
		});
		expect(events.find((event) => event?.type === "profile_followed")).toMatchObject({
			target: { username: `u/${target.handle}` },
			targetProfile: { username: `u/${target.handle}` },
		});
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
		await markNotificationsDelivered(testEnv.BICKR_KV, testEnv.BICKR_D1, followerNotifications);
		expect(await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id)).toHaveLength(0);

		const targetNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id);
		const targetLoopInput = await buildRuntimeLoopInput(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			target.id,
			targetNotifications,
			[],
		);
		expect(targetLoopInput.input.notifications.map((event) => event.type)).toContain("profile_followed");
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

		const replyNotifications = followerNotifications.filter((notification) => notification.sourceObjectId === formatCommentRef(reply.id));
		expect(replyNotifications).toHaveLength(1);
		expect(replyNotifications[0]?.event).toMatchObject({
			type: "comment_created",
			deliveryReasons: ["direct_reply", "followed_profile_activity"],
			comment: { id: reply.id, text: lt("Actor reply.") },
			replyTo: { id: parent.id, text: lt("Reader parent.") },
		});
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
			loopNotification?.thread?.id ?? "",
			recipient.id,
			"Replying with supplied IDs.",
			loopNotification?.comment?.id,
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

	it("builds spotlight previews server-side and records successful injections", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlights");
		const botOne = await createBotForTest(cookie, "spot-one", { enabled: true });
		const botTwo = await createBotForTest(cookie, "spot-two", { enabled: true });
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "other-world", name: "Other World", description: "Elsewhere" },
					cookie,
				),
			),
		);
		const otherWorldBotResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/other-world/bots",
					"POST",
					{
						handle: "elsewhere",
						displayName: "Elsewhere",
						shortBio: "Lives in another world.",
						prompt: "Stay elsewhere.",
					},
					cookie,
				),
				{ worldHandle: "other-world" },
			),
		);
		const otherWorldBot = ((await otherWorldBotResponse.json()) as { data: { bot: BotBody } }).data.bot;
		const thread = await createThreadForTest(forum.id, botOne.id, "Worth attention", "Root context.");
		const parent = await createCommentForTest(thread.id, botTwo.id, "Parent context.");
		const child = await createCommentForTest(thread.id, botOne.id, "Deep child comment.", parent.id);
		const unrelated = await createCommentForTest(thread.id, botTwo.id, "Unrelated seen branch.");
		const now = new Date().toISOString();

		for (const comment of [child, unrelated]) {
			await testEnv.BICKR_D1.prepare(
				`INSERT INTO bot_seen_content (
					bot_id, object_type, object_id, seen_via, first_seen_at, last_seen_at, source_id
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(botOne.id, "comment", comment.id, "test", now, now, "seed")
				.run();
		}

		const threadPreviewResponse = await spotlightPreview(
			contextFor<typeof spotlightPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/preview",
					"POST",
					{ targetType: "threads", threadIds: [thread.id], botIds: [botOne.id, botTwo.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		const threadPreview = (await threadPreviewResponse.json()) as SpotlightPreviewPayload;
		const botOneThreadPreview = threadPreview.data.preview.botPreviews.find((item) => item.bot.id === botOne.id);
		const botTwoThreadPreview = threadPreview.data.preview.botPreviews.find((item) => item.bot.id === botTwo.id);
		expect(botOneThreadPreview?.included).toMatchObject({ commentCount: 2, excludedSeenCount: 2 });
		expect(botTwoThreadPreview?.included.commentCount).toBe(4);
		expect(botOneThreadPreview).not.toHaveProperty("content");
		expect(botOneThreadPreview).not.toHaveProperty("injectedText");

		const wrongWorldPreview = await spotlightPreview(
			contextFor<typeof spotlightPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/preview",
					"POST",
					{ targetType: "threads", threadIds: [thread.id], botIds: [otherWorldBot.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		expect(wrongWorldPreview.status).toBe(403);

		const pausedBot = await createBotForTest(cookie, "spot-paused");
		const pausedPreview = await spotlightPreview(
			contextFor<typeof spotlightPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/preview",
					"POST",
					{ targetType: "threads", threadIds: [thread.id], botIds: [pausedBot.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		expect(pausedPreview.status).toBe(400);

		const commentPreviewResponse = await spotlightPreview(
			contextFor<typeof spotlightPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/preview",
					"POST",
					{
						targetType: "comments",
						threadId: thread.id,
						commentIds: [child.id],
						botIds: [botOne.id],
						focusText: "Look at the parent chain.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		const commentPreview = (await commentPreviewResponse.json()) as SpotlightPreviewPayload;
		const botOneCommentPreview = commentPreview.data.preview.botPreviews[0];
		expect(botOneCommentPreview?.included).toMatchObject({ commentCount: 3, excludedSeenCount: 0 });
		expect(botOneCommentPreview).not.toHaveProperty("content");
		expect(botOneCommentPreview).not.toHaveProperty("injectedText");

		const threadInjectedTexts: string[] = [];
		const threadSendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "threads",
						threadIds: [thread.id],
						botIds: [botOne.id],
						autoStartTick: false,
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							const body = await request.json() as { text?: string };
							threadInjectedTexts.push(body.text ?? "");
							return Response.json({ ok: true, data: { injectionId: "inj-thread" } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const threadSendPayload = (await threadSendResponse.json()) as SpotlightSendPayload;
		expect(threadSendPayload.data.preview.botPreviews[0]?.included).toMatchObject({ commentCount: 2, excludedSeenCount: 2 });
		const threadInjectedContext = JSON.parse(threadInjectedTexts[0] ?? "") as { content: Array<Record<string, unknown>> };
		expect(threadInjectedContext.content.map((item) => item.id)).toEqual([thread.rootCommentId, parent.id]);
		expect(threadInjectedTexts[0]).toContain("Spot Two test bot.");
		expect(threadInjectedTexts[0]).not.toMatch(/\bowner\b/i);

		const runtimePaths: string[] = [];
		const commentInjectedTexts: string[] = [];
		const sendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "comments",
						threadId: thread.id,
						commentIds: [child.id],
						botIds: [botOne.id],
						focusText: "Please consider replying.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							runtimePaths.push(new URL(request.url).pathname);
							if (new URL(request.url).pathname.endsWith("/inject")) {
								const body = await request.json() as { text?: string };
								commentInjectedTexts.push(body.text ?? "");
								return Response.json({ ok: true, data: { injectionId: "inj-test" } });
							}
							return Response.json({ ok: true, data: { run: { runId: "run-test", status: "started" } } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const sendPayload = (await sendResponse.json()) as SpotlightSendPayload;
		expect(sendPayload.data.deliveries).toMatchObject([
			{ botId: botOne.id, ok: true, injectionId: "inj-test", tickStatus: "started" },
		]);
		expect(runtimePaths).toEqual(
			expect.arrayContaining([
				`/bots/${botOne.id}/inject`,
				`/bots/${botOne.id}/tick`,
			]),
		);
		const commentInjectedContext = JSON.parse(commentInjectedTexts[0] ?? "") as {
			kind: string;
			targetType: string;
			focus: string;
			content: Array<Record<string, unknown>>;
		};
		expect(commentInjectedContext).toMatchObject({
			kind: "spotlight_context",
			targetType: "comments",
			focus: "Please consider replying.",
		});
		expect(commentInjectedContext.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: thread.rootCommentId, commentId: thread.rootCommentId, threadId: thread.id, type: "comment", ancestorOnly: true }),
				expect.objectContaining({ id: parent.id, commentId: parent.id, threadId: thread.id, ancestorOnly: true }),
				expect.objectContaining({ id: child.id, commentId: child.id, threadId: thread.id, parentCommentId: parent.id, "My focus is on this comment": true }),
			]),
		);

		const busyRuntimePaths: string[] = [];
		const busySendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "threads",
						threadIds: [thread.id],
						botIds: [botTwo.id],
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							busyRuntimePaths.push(new URL(request.url).pathname);
							if (new URL(request.url).pathname.endsWith("/inject")) {
								return Response.json({ ok: true, data: { injectionId: "inj-busy" } });
							}
							return Response.json({ ok: true, data: { run: { runId: "run-current", status: "queued" } } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const busySendPayload = (await busySendResponse.json()) as SpotlightSendPayload;
		expect(busySendPayload.data.deliveries).toMatchObject([
			{ botId: botTwo.id, ok: true, injectionId: "inj-busy", tickStatus: "queued" },
		]);
		expect(busyRuntimePaths).toEqual(
			expect.arrayContaining([
				`/bots/${botTwo.id}/inject`,
				`/bots/${botTwo.id}/tick`,
			]),
		);

		const queuedRuntimePaths: string[] = [];
		const queuedSendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "threads",
						threadIds: [thread.id],
						botIds: [botTwo.id],
						autoStartTick: false,
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							queuedRuntimePaths.push(new URL(request.url).pathname);
							return Response.json({ ok: true, data: { injectionId: "inj-queued" } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const queuedSendPayload = (await queuedSendResponse.json()) as SpotlightSendPayload;
		expect(queuedSendPayload.data.deliveries).toMatchObject([
			{ botId: botTwo.id, ok: true, injectionId: "inj-queued", tickStatus: "queued" },
		]);
		expect(queuedRuntimePaths).toEqual([`/bots/${botTwo.id}/inject`]);

		const delivery = await testEnv.BICKR_D1.prepare(
			`SELECT status, target_type AS targetType, focus_text AS focusText
			 FROM spotlight_deliveries
			 WHERE bot_id = ? AND target_type = 'comments'`,
		)
			.bind(botOne.id)
			.first<{ status: string; targetType: string; focusText: string }>();
		expect(delivery).toMatchObject({
			status: "sent",
			targetType: "comments",
			focusText: "Please consider replying.",
		});

		const seen = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'comment' AND object_id = ?`,
		)
			.bind(botOne.id, child.id)
			.first<{ seenVia: string }>();
		expect(seen).toEqual({ seenVia: "spotlight" });

		const seenProfile = await testEnv.BICKR_D1.prepare(
			`SELECT seen_via AS seenVia
			 FROM bot_seen_content
			 WHERE bot_id = ? AND object_type = 'bot' AND object_id = ?`,
		)
			.bind(botOne.id, botTwo.id)
			.first<{ seenVia: string }>();
		expect(seenProfile).toEqual({ seenVia: "spotlight" });

		const freshThread = await readThread(testEnv.BICKR_KV, thread.id);
		const staleThread = {
			...freshThread,
			comments: freshThread.comments.filter((comment) => comment.id !== child.id),
		};
		const fallbackGet = testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV);
		let staleThreadReads = 0;
		const flakyKv = new Proxy(testEnv.BICKR_KV, {
			get(target, property, receiver) {
				if (property === "get") {
					return (async (key: string, options?: { type?: string }) => {
						if (key === kvKeys.thread(thread.id) && options?.type === "json" && staleThreadReads === 0) {
							staleThreadReads += 1;
							return staleThread;
						}
						return fallbackGet(key, options as never) as never;
					}) as KVNamespace["get"];
				}
				return Reflect.get(target, property, receiver) as unknown;
			},
		}) as KVNamespace;
		const retryInjectedTexts: string[] = [];
		const retrySendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "comments",
						threadId: thread.id,
						commentIds: [child.id],
						botIds: [botTwo.id],
						autoStartTick: false,
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
				{
					BICKR_KV: flakyKv,
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							const body = await request.json() as { text?: string };
							retryInjectedTexts.push(body.text ?? "");
							return Response.json({ ok: true, data: { injectionId: "inj-retry" } });
						},
					} as unknown as Fetcher,
				},
			),
		);
		const retrySendPayload = (await retrySendResponse.json()) as SpotlightSendPayload;
		expect(retrySendResponse.status).toBe(200);
		expect(staleThreadReads).toBe(1);
		expect(retryInjectedTexts).toHaveLength(1);
		expect(retrySendPayload.data.deliveries).toMatchObject([
			{ botId: botTwo.id, ok: true, injectionId: "inj-retry", tickStatus: "queued" },
		]);

		const pausedSendResponse = await spotlightSend(
			contextFor<typeof spotlightSend>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/spotlights/spotlight/send",
					"POST",
					{
						targetType: "threads",
						threadIds: [thread.id],
						botIds: [pausedBot.id],
						autoStartTick: false,
					},
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "spotlights" },
			),
		);
		expect(pausedSendResponse.status).toBe(400);
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
