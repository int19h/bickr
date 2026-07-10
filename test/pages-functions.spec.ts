import {
	addBotGroupMembersRoute,
	agentRuntimeWorker,
	authCookie,
	authCookieFor,
	bootstrap,
	botById,
	BotRuntime,
	buildServiceRequest,
	contextBudgetGetRoute,
	contextBudgetRoute,
	contextFor,
	createBot,
	createBotForTest,
	createBotGroupRoute,
	createBotInWorld,
	createCommentForTest,
	createForum,
	createForumForTest,
	createSession,
	createThreadForTest,
	createWorld,
	createWorldForTest,
	defaultTranslationPrompt,
	deleteBot,
	deleteBotGroupRoute,
	deleteProfileRoute,
	describe,
	ensureBootstrapNotification,
	expect,
	forumCoordinatorWorker,
	forums,
	forumThreads,
	getHumanProfile,
	getProfile,
	githubCallback,
	githubStart,
	googleCallback,
	googleOauthFetchMock,
	googleStart,
	handleAgentRuntimeRequest,
	health,
	htmlTitle,
	isValidHandleText,
	it,
	jsonRequest,
	listForums,
	listPendingNotifications,
	localizedTextString,
	logout,
	lt,
	maxProviderRoutingJsonLength,
	meBots,
	memoryRuntimeSql,
	metaContent,
	oauthCookieNames,
	oauthFetchMock,
	pageHtml,
	parsePathname,
	patchBot,
	patchBotGroupRoute,
	patchForum,
	patchProfile,
	patchWorld,
	providerChatCompletionRequest,
	providerContextCompletionReserveTokens,
	readThread,
	removeBotGroupMemberRoute,
	routePath,
	runtimeHealth,
	runtimeMessagesRoute,
	runtimeMonitorRoute,
	sanitizeHandleInput,
	seedWorld,
	session,
	sessionCookieName,
	setBotAvatarForTest,
	setUserAvatarForTest,
	spreadBotTicksRoute,
	testEnv,
	testLanguage,
	testLogin,
	testServiceProxy,
	testSpaShell,
	threadDetail,
	translateText,
	unlinkAuthIdentity,
	unspecifiedLt,
	updateUserProfile,
	upsertProviderUser,
	userIdForHandle,
	vi,
	worldBotGroups,
	worldBots,
	worlds,
} from "./helpers/index-harness";
import type {
	BotBody,
	BotDocument,
	BotGroupSummary,
	ThreadDocument,
	UserProfile,
	WorldSummary,
} from "./helpers/index-harness";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";

describe("Pages functions", () => {
	it("returns an API health payload", async () => {
		const response = await health(contextFor<typeof health>(new Request("http://example.com/api/health")));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			app: "Bickr",
			bindings: {
				agentRuntime: true,
				botRuntime: false,
				forumCoordinator: false,
				forumCoordinatorService: true,
			},
			ok: true,
			runtime: "cloudflare-pages-functions",
		});
	});

	it("canonicalizes shared SPA route parsing for legacy bot paths", () => {
		expect(routePath(parsePathname("/w/primary/b/release-sage"))).toBe("/w/primary/u/release-sage");
		expect(routePath(parsePathname("/w/primary/b/release-sage/avatar"))).toBe("/w/primary/u/release-sage/avatar");
		expect(routePath(parsePathname("/w/primary", "?tab=bots"))).toBe("/w/primary?tab=bots");
	});

	it("rewrites SPA shell metadata with entity titles, descriptions, and account avatars", async () => {
		const cookie = await authCookie();
		await setUserAvatarForTest(await userIdForHandle("octocat"), "https://assets-test.bickr.social/humans/octocat.png");
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "release-room");
		const author = await createBotForTest(cookie, "release-sage");
		const replier = await createBotForTest(cookie, "reply-scribe");
		await setBotAvatarForTest(author, "https://assets-test.bickr.social/bots/release-sage.png");
		await setBotAvatarForTest(replier, "https://assets-test.bickr.social/bots/reply-scribe.png");
		const thread = await createThreadForTest(forum.id, author.id, "Release notes", "Release notes from u/release-sage.");
		const longReplyBody = [
			"This comment should be the embed description.",
			"Embed consumers have different title and description limits, so Bickr should send the complete normalized text.",
			"Platforms can then trim according to their own cards, previews, and notification surfaces without losing source context here.",
		].join(" ");
		const reply = await createCommentForTest(thread.id, replier.id, longReplyBody);

		const worldHtml = await pageHtml("/w/patch-notes?tab=bots");
		expect(htmlTitle(worldHtml)).toBe("w/patch-notes: bots - Bickr");
		expect(metaContent(worldHtml, "property", "og:description")).toContain("Change discussion");

		const botHtml = await pageHtml("/w/patch-notes/u/release-sage?tab=follows");
		expect(htmlTitle(botHtml)).toBe("u/release-sage: follows - Bickr");
		expect(metaContent(botHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/bots/release-sage.png");
		expect(metaContent(botHtml, "name", "twitter:image")).toBe("https://assets-test.bickr.social/bots/release-sage.png");

		const threadHtml = await pageHtml(`/w/patch-notes/f/release-room/t/${thread.id}`);
		expect(htmlTitle(threadHtml)).toBe("Release notes - Bickr");
		expect(metaContent(threadHtml, "name", "description")).toBe("Release notes from u/release-sage.");
		expect(metaContent(threadHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/bots/release-sage.png");

		const commentHtml = await pageHtml(`/w/patch-notes/f/release-room/t/${thread.id}/c/${reply.id}`);
		expect(htmlTitle(commentHtml)).toBe("u/reply-scribe on Release notes - Bickr");
		expect(metaContent(commentHtml, "property", "og:description")).toBe(longReplyBody);
		expect(metaContent(commentHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/bots/reply-scribe.png");

		const humanHtml = await pageHtml("/hu/octocat");
		expect(htmlTitle(humanHtml)).toBe("hu/octocat - Bickr");
		expect(metaContent(humanHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/humans/octocat.png");

		const privateHtml = await pageHtml("/me/profile", cookie);
		expect(htmlTitle(privateHtml)).toBe("hu/octocat: profile - Bickr");
		expect(metaContent(privateHtml, "name", "robots")).toBe("noindex,nofollow");
		expect(metaContent(privateHtml, "property", "og:image")).toBe("https://assets-test.bickr.social/humans/octocat.png");
	});

	it("does not rewrite API or static asset-looking requests as HTML pages", async () => {
		const apiRootHtml = await pageHtml("/api");
		expect(apiRootHtml).toBe(testSpaShell);
		expect(apiRootHtml).not.toContain("og:title");

		const apiHtml = await pageHtml("/api/missing");
		expect(apiHtml).toBe(testSpaShell);
		expect(apiHtml).not.toContain("og:title");

		const assetHtml = await pageHtml("/assets/app.js");
		expect(assetHtml).toBe(testSpaShell);
		expect(assetHtml).not.toContain("og:title");
	});

	it("returns the bootstrap payload", async () => {
		const response = await bootstrap(
			contextFor<typeof bootstrap>(new Request("http://example.com/api/bootstrap")),
		);
		const payload = (await response.json()) as {
			app: { name: string };
			pillars: Array<unknown>;
			seedForums: Array<{ name: string }>;
		};

		expect(response.status).toBe(200);
		expect(payload.app.name).toBe("Bickr");
		expect(payload.pillars).toHaveLength(3);
		expect(payload.seedForums.map((forum) => forum.name)).toContain("r/shipwars");
	});

	it("returns bound Worker runtime health", async () => {
		const response = await runtimeHealth(
			contextFor<typeof runtimeHealth>(new Request("http://example.com/api/runtime/health")),
		);
		const payload = (await response.json()) as {
			services: {
				agentRuntime: { ok: boolean };
				forumCoordinator: { ok: boolean };
			};
		};

		expect(response.status).toBe(200);
		expect(payload.services.agentRuntime.ok).toBe(true);
		expect(payload.services.forumCoordinator.ok).toBe(true);
	});

	it("rebuilds Pages service requests from safe protocol headers", () => {
		const browserRequest = new Request("https://test.bickr.social/api/me/bots/bot_1/runtime/messages", {
			headers: {
				accept: "text/event-stream",
				authorization: "Bearer browser-token",
				connection: "Upgrade",
				"content-type": "text/plain",
				cookie: "bickr_session=browser-session",
				"sec-websocket-key": "websocket-key",
				"sec-websocket-protocol": "chat",
				"sec-websocket-version": "13",
				upgrade: "websocket",
				"x-bickr-bot-id": "spoofed-bot",
				"x-bickr-scheduler": "1",
				"x-bickr-user-id": "spoofed-user",
			},
			method: "GET",
		});
		const proxied = buildServiceRequest(
			{ INTERNAL_SERVICE_SECRET: "service-secret" },
			browserRequest,
			"/bots/bot_1/messages",
			"server-user",
		);

		expect(proxied.url).toBe("https://internal.bickr/bots/bot_1/messages");
		expect(proxied.headers.get("x-bickr-user-id")).toBe("server-user");
		expect(proxied.headers.get(internalServiceAuthHeader)).toBe("service-secret");
		expect(proxied.headers.get("accept")).toBe("text/event-stream");
		expect(proxied.headers.get("upgrade")).toBe("websocket");
		expect(proxied.headers.get("connection")).toBe("Upgrade");
		expect(proxied.headers.get("sec-websocket-key")).toBe("websocket-key");
		expect(proxied.headers.get("sec-websocket-protocol")).toBe("chat");
		expect(proxied.headers.get("sec-websocket-version")).toBe("13");
		expect(proxied.headers.get("authorization")).toBeNull();
		expect(proxied.headers.get("cookie")).toBeNull();
		expect(proxied.headers.get("x-bickr-bot-id")).toBeNull();
		expect(proxied.headers.get("x-bickr-scheduler")).toBeNull();
		expect(proxied.headers.get("content-type")).toBeNull();

		const jsonProxied = buildServiceRequest(
			{ INTERNAL_SERVICE_SECRET: "service-secret" },
			new Request("https://test.bickr.social/api/me/profile", {
				headers: { "content-type": "application/json;charset=UTF-8" },
				method: "PATCH",
			}),
			"/users/server-user/profile",
			"server-user",
		);
		expect(jsonProxied.headers.get("content-type")).toBe("application/json");
	});

	it("does not forward privileged browser headers through Pages runtime routes", async () => {
		const cookie = await authCookieFor({
			displayName: "Header Smuggle",
			login: "header-smuggle",
			subject: "header-smuggle",
		});
		const userId = await userIdForHandle("header-smuggle");
		const forwarded: Request[] = [];
		const response = await runtimeMessagesRoute(
			contextFor<typeof runtimeMessagesRoute>(
				new Request("http://example.com/api/me/bots/bot_header/runtime/messages", {
					headers: {
						authorization: "Bearer attacker",
						cookie,
						"x-bickr-bot-id": "spoofed-bot",
						"x-bickr-scheduler": "1",
						"x-bickr-user-id": "spoofed-user",
					},
				}),
				{ botId: "bot_header" },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							forwarded.push(request);
							return Response.json({ ok: true, data: { messages: [] } });
						},
					} as unknown as Fetcher,
				},
			),
		);

		expect(response.status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0]!.url).toBe("https://internal.bickr/bots/bot_header/messages");
		expect(forwarded[0]!.headers.get("x-bickr-user-id")).toBe(userId);
		expect(forwarded[0]!.headers.get("x-bickr-scheduler")).toBeNull();
		expect(forwarded[0]!.headers.get("x-bickr-bot-id")).toBeNull();
		expect(forwarded[0]!.headers.get("authorization")).toBeNull();
		expect(forwarded[0]!.headers.get("cookie")).toBeNull();
	});

	it("rejects public-style Worker hosts before honoring internal debug headers", async () => {
		const spoofedAgent = await agentRuntimeWorker.fetch(
			new Request("https://bickr-agent-runtime-test.example.workers.dev/health", {
				headers: {
					"x-bickr-scheduler": "1",
					"x-bickr-user-id": "spoofed-user",
				},
			}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			{} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);
		expect(spoofedAgent.status).toBe(404);

		const internalAgent = await agentRuntimeWorker.fetch(
			new Request("https://internal.bickr/health") as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			{} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);
		expect(internalAgent.status).toBe(200);

		const spoofedForumHealth = await forumCoordinatorWorker.fetch(
			new Request("https://bickr-forum-coordinator-test.example.workers.dev/health", {
				headers: { "x-bickr-scheduler": "1" },
			}) as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			{} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);
		expect(spoofedForumHealth.status).toBe(404);

		const spoofedForumBot = await forumCoordinatorWorker.fetch(
			jsonRequest(
				"https://bickr-forum-coordinator-test.example.workers.dev/forums/forum_1/threads",
				"POST",
				{ title: "Spoofed thread", body: "Public Worker URL" },
				undefined,
				{ "x-bickr-bot-id": "spoofed-bot" },
			) as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			{} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);
		expect(spoofedForumBot.status).toBe(404);

		const internalForum = await forumCoordinatorWorker.fetch(
			new Request("https://internal.bickr/health") as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[0],
			{} as unknown as Parameters<typeof forumCoordinatorWorker.fetch>[1],
		);
		expect(internalForum.status).toBe(200);
	});

	it("requires scheduler intent for internal vector reindexing", async () => {
		const response = await handleAgentRuntimeRequest(
			new Request("https://internal.bickr/search/reindex-vectors", {
				headers: { "x-bickr-user-id": "service-user" },
				method: "POST",
			}),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
	});

	it("rejects unauthenticated mutations", async () => {
		const response = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", {
					handle: "alpha",
					name: "Alpha",
					description: "A world",
				}),
			),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
	});

	it("notifies distinct bot owners when world settings change without spamming unread notifications", async () => {
		const ownerCookie = await authCookieFor({ subject: "world-settings-owner", login: "world-settings-owner", displayName: "World Owner" });
		const guestCookie = await authCookieFor({ subject: "world-settings-guest", login: "world-settings-guest", displayName: "World Guest" });
		await createWorldForTest(ownerCookie, "settings-lab", "Settings Lab");
		const ownerBot = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/settings-lab/bots",
					"POST",
					{ handle: "owner-bot", displayName: "Owner Bot", shortBio: "Owner participant.", prompt: "Watch settings." },
					ownerCookie,
				),
				{ worldHandle: "settings-lab" },
			),
		);
		expect(ownerBot.status, await ownerBot.clone().text()).toBe(201);
		for (const handle of ["guest-one", "guest-two"]) {
			const guestBot = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/settings-lab/bots",
						"POST",
						{ handle, displayName: handle, shortBio: "Guest participant.", prompt: "Watch settings." },
						guestCookie,
					),
					{ worldHandle: "settings-lab" },
				),
			);
			expect(guestBot.status, await guestBot.clone().text()).toBe(201);
		}
		const ownerId = await userIdForHandle("world-settings-owner");
		const guestId = await userIdForHandle("world-settings-guest");

		const firstPatch = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest("http://example.com/api/worlds/settings-lab", "PATCH", { prompt: "A brighter setting." }, ownerCookie),
				{ worldHandle: "settings-lab" },
			),
		);
		expect(firstPatch.status, await firstPatch.clone().text()).toBe(200);
		let rows = await testEnv.BICKR_D1.prepare(
			`SELECT notification_id AS id, user_id AS userId, body, read_at AS readAt
			 FROM human_notifications
			 WHERE notification_type = 'world_settings_changed'
			 ORDER BY created_at ASC`,
		).all<{ id: string; userId: string; body: string; readAt: string | null }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results?.[0]).toMatchObject({ userId: guestId, readAt: null });
		expect(rows.results?.[0]?.body).toContain("prompt");
		expect(rows.results?.some((row) => row.userId === ownerId)).toBe(false);
		const unreadId = rows.results?.[0]?.id ?? "";

		const secondPatch = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest("http://example.com/api/worlds/settings-lab", "PATCH", { description: "Updated visible description." }, ownerCookie),
				{ worldHandle: "settings-lab" },
			),
		);
		expect(secondPatch.status, await secondPatch.clone().text()).toBe(200);
		rows = await testEnv.BICKR_D1.prepare(
			`SELECT notification_id AS id, user_id AS userId, body, read_at AS readAt
			 FROM human_notifications
			 WHERE notification_type = 'world_settings_changed'
			 ORDER BY created_at ASC`,
		).all<{ id: string; userId: string; body: string; readAt: string | null }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results?.[0]?.id).toBe(unreadId);
		expect(rows.results?.[0]?.body).toContain("short description");

		await testEnv.BICKR_D1.prepare(`UPDATE human_notifications SET read_at = ? WHERE notification_id = ?`)
			.bind("2026-05-01T00:00:00.000Z", unreadId)
			.run();
		const thirdPatch = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest("http://example.com/api/worlds/settings-lab", "PATCH", { name: "Settings Lab Revised" }, ownerCookie),
				{ worldHandle: "settings-lab" },
			),
		);
		expect(thirdPatch.status, await thirdPatch.clone().text()).toBe(200);
		rows = await testEnv.BICKR_D1.prepare(
			`SELECT notification_id AS id, user_id AS userId, body, read_at AS readAt
			 FROM human_notifications
			 WHERE notification_type = 'world_settings_changed'
			 ORDER BY created_at ASC`,
		).all<{ id: string; userId: string; body: string; readAt: string | null }>();
		expect(rows.results).toHaveLength(2);
		expect(rows.results?.[1]).toMatchObject({ userId: guestId, readAt: null });
		expect(rows.results?.[1]?.body).toContain("name");
	});

	it("keeps the local test login route disabled unless explicitly configured", async () => {
		const disabled = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest("http://localhost/api/__test__/login", "POST", {
					login: "manual-test-user",
				}),
			),
		);
		expect(disabled.status).toBe(404);

		const remoteHost = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest("http://example.com/api/__test__/login", "POST", {
					login: "manual-test-user",
				}),
				{},
				{ TEST_AUTH_SECRET: "secret" },
			),
		);
		expect(remoteHost.status).toBe(404);
	});

	it("allows test login on configured test hosts with the correct secret", async () => {
		const response = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/login",
					"POST",
					{
						subject: "configured-test-login",
						login: "configured-test-login",
						handle: "configured-test-login",
						displayName: "Configured Test Login",
					},
					undefined,
					{ "x-test-auth-secret": "test-secret" },
				),
				{},
				{
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "test-secret",
				},
			),
		);

		expect(response.status).toBe(201);
		expect(response.headers.getSetCookie().join(";")).toContain(`${sessionCookieName}=`);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { profile: { handle: "configured-test-login" } },
		});
	});

	it("rejects local test login requests with the wrong secret", async () => {
		const response = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest(
					"http://127.0.0.1/api/__test__/login",
					"POST",
					{ login: "manual-test-user" },
					undefined,
					{ "x-test-auth-secret": "wrong" },
				),
				{},
				{ TEST_AUTH_SECRET: "correct" },
			),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
	});

	it("protects the test service proxy and allowlists services, paths, and headers", async () => {
		const disabled = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{ service: "agent-runtime", method: "GET", path: "/health" },
					undefined,
					{ "x-test-auth-secret": "secret" },
				),
			),
		);
		expect(disabled.status).toBe(404);

		const wrongSecret = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{ service: "agent-runtime", method: "GET", path: "/health" },
					undefined,
					{ "x-test-auth-secret": "wrong" },
				),
				{},
				{
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "secret",
				},
			),
		);
		expect(wrongSecret.status).toBe(401);

		const unsafePath = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{ service: "agent-runtime", method: "GET", path: "//example.com/health" },
					undefined,
					{ "x-test-auth-secret": "secret" },
				),
				{},
				{
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "secret",
				},
			),
		);
		expect(unsafePath.status).toBe(400);

		const unsafeHeader = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{
						service: "agent-runtime",
						method: "GET",
						path: "/health",
						headers: { cookie: "bickr_session=stolen" },
					},
					undefined,
					{ "x-test-auth-secret": "secret" },
				),
				{},
				{
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "secret",
				},
			),
		);
		expect(unsafeHeader.status).toBe(400);

		const proxiedRequests: Request[] = [];
		const agentRuntime = {
			fetch: async (request: Request) => {
				proxiedRequests.push(request);
				return new Response("healthy", {
					headers: {
						"content-type": "text/plain",
						"set-cookie": "unsafe=1",
						"x-debug": "hidden",
					},
					status: 202,
				});
			},
		} as unknown as Fetcher;
		const success = await testServiceProxy(
			contextFor<typeof testServiceProxy>(
				jsonRequest(
					"https://test.bickr.social/api/__test__/service-proxy",
					"POST",
					{
						service: "agent-runtime",
						method: "GET",
						path: "/health",
						headers: {
							accept: "application/json",
							"x-bickr-scheduler": "1",
							"x-bickr-user-id": "usr_debug",
						},
					},
					undefined,
					{ "x-test-auth-secret": "secret" },
				),
				{},
				{
					AGENT_RUNTIME: agentRuntime,
					INTERNAL_SERVICE_SECRET: "service-secret",
					TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev",
					TEST_AUTH_SECRET: "secret",
				},
			),
		);

		expect(success.status).toBe(202);
		expect(await success.text()).toBe("healthy");
		expect(success.headers.get("content-type")).toBe("text/plain");
		expect(success.headers.get("cache-control")).toBe("no-store");
		expect(success.headers.get("set-cookie")).toBeNull();
		expect(success.headers.get("x-debug")).toBeNull();
		expect(proxiedRequests).toHaveLength(1);
		expect(proxiedRequests[0]!.url).toBe("https://internal.bickr/health");
		expect(proxiedRequests[0]!.headers.get("accept")).toBe("application/json");
		expect(proxiedRequests[0]!.headers.get(internalServiceAuthHeader)).toBe("service-secret");
		expect(proxiedRequests[0]!.headers.get("x-bickr-scheduler")).toBe("1");
		expect(proxiedRequests[0]!.headers.get("x-bickr-user-id")).toBe("usr_debug");
		expect(proxiedRequests[0]!.headers.get("cookie")).toBeNull();
		expect(proxiedRequests[0]!.headers.get("authorization")).toBeNull();
	});

	it("supports local test login, session lookup, protected mutations, incomplete setup, and logout", async () => {
		const completeLogin = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest(
					"http://127.0.0.1/api/__test__/login",
					"POST",
					{
						subject: "manual-test-complete",
						login: "manual-test-complete",
						handle: "manual-test-complete",
						displayName: "Manual Test Complete",
					},
					undefined,
					{ "x-test-auth-secret": "local-secret" },
				),
				{},
				{ TEST_AUTH_SECRET: "local-secret" },
			),
		);
		expect(completeLogin.status).toBe(201);
		const completeCookie = completeLogin.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(completeCookie).toBeDefined();
		expect(await completeLogin.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					handle: "manual-test-complete",
					displayName: lt("Manual Test Complete"),
					profileComplete: true,
				},
			},
		});

		const sessionResponse = await session(
			contextFor<typeof session>(
				new Request("http://example.com/api/session", {
					headers: { cookie: completeCookie! },
				}),
			),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: {
				authenticated: true,
				user: {
					handle: "manual-test-complete",
					profileComplete: true,
				},
			},
		});

		const createdWorld = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "manual-test-auth", name: "Manual Test Auth", description: "Local auth test" },
					completeCookie!,
				),
			),
		);
		expect(createdWorld.status).toBe(201);

		const logoutResponse = await logout(
			contextFor<typeof logout>(
				new Request("http://example.com/api/auth/logout", {
					method: "POST",
					headers: { cookie: completeCookie! },
				}),
			),
		);
		expect(logoutResponse.status).toBe(200);
		expect(logoutResponse.headers.getSetCookie().join(";")).toContain("Max-Age=0");

		const incompleteLogin = await testLogin(
			contextFor<typeof testLogin>(
				jsonRequest(
					"http://127.0.0.1/api/__test__/login",
					"POST",
					{
						subject: "manual-test-incomplete",
						login: "manual-test-incomplete",
						displayName: "Manual Test Incomplete",
						profileComplete: false,
					},
					undefined,
					{ "x-test-auth-secret": "local-secret" },
				),
				{},
				{ TEST_AUTH_SECRET: "local-secret" },
			),
		);
		const incompleteCookie = incompleteLogin.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(incompleteCookie).toBeDefined();
		expect(await incompleteLogin.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					handle: "manual-test-incomplete",
					profileComplete: false,
				},
			},
		});

		const blockedWorld = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "manual-test-blocked", name: "Manual Test Blocked", description: "Incomplete setup" },
					incompleteCookie!,
				),
			),
		);
		expect(blockedWorld.status).toBe(403);
		expect(await blockedWorld.json()).toMatchObject({
			ok: false,
			error: "forbidden",
			message: expect.stringContaining("Complete your profile"),
		});
	});

	it("supports GitHub OAuth callback user upsert, session lookup, and logout", async () => {
		const githubCookies = oauthCookieNames("github");
		const startResponse = await githubStart(
			contextFor<typeof githubStart>(
				new Request(
					"http://example.com/api/auth/github/start?returnTo=%2Fw%2Fprimary%2Ff%2Fphilosophy%2Ft%2Fthr_1",
				),
				{},
				{ GITHUB_CLIENT_ID: "client-id" },
			),
		);
		expect(startResponse.status).toBe(302);
		expect(startResponse.headers.get("location")).toContain("github.com/login/oauth/authorize");
		expect(startResponse.headers.getSetCookie().join(";")).toContain(
			`${githubCookies.returnTo}=%2Fw%2Fprimary%2Ff%2Fphilosophy%2Ft%2Fthr_1`,
		);

		const callbackResponse = await githubCallback(
			contextFor<typeof githubCallback>(
				new Request("http://example.com/api/auth/github/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							`${githubCookies.state}=state-1; ${githubCookies.returnTo}=%2Fw%2Fprimary%2Ff%2Fphilosophy%2Ft%2Fthr_1; ${githubCookies.pkce}=verifier-1`,
					},
				}),
				{},
				{
					GITHUB_CLIENT_ID: "client-id",
					GITHUB_CLIENT_SECRET: "client-secret",
					OAUTH_FETCH: oauthFetchMock,
				},
			),
		);
		expect(callbackResponse.status).toBe(302);
		expect(callbackResponse.headers.get("location")).toBe("/w/primary/f/philosophy/t/thr_1");
		const sessionCookie = callbackResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(sessionCookie).toBeDefined();

		const sessionResponse = await session(
			contextFor<typeof session>(
				new Request("http://example.com/api/session", {
					headers: { cookie: sessionCookie! },
				}),
			),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: {
				authenticated: true,
				user: {
					handle: "octocat",
					displayName: unspecifiedLt("Octo Cat"),
					profileComplete: false,
				},
			},
		});

		const blockedWorld = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "blocked", name: "Blocked", description: "Requires setup" },
					sessionCookie!,
				),
			),
		);
		expect(blockedWorld.status).toBe(403);
		expect(await blockedWorld.json()).toMatchObject({
			ok: false,
			error: "forbidden",
			message: expect.stringContaining("Complete your profile"),
		});

		const logoutResponse = await logout(
			contextFor<typeof logout>(
				new Request("http://example.com/api/auth/logout", {
					method: "POST",
					headers: { cookie: sessionCookie! },
				}),
			),
		);
		expect(logoutResponse.status).toBe(200);
		expect(logoutResponse.headers.getSetCookie().join(";")).toContain("Max-Age=0");
	});

	it("supports Google OAuth sign-in with authentication-only scopes", async () => {
		const googleCookies = oauthCookieNames("google");
		const startResponse = await googleStart(
			contextFor<typeof googleStart>(
				new Request("http://example.com/api/auth/google/start?returnTo=%2Fme%2Fprofile"),
				{},
				{ GOOGLE_CLIENT_ID: "google-client", OAUTH_FETCH: googleOauthFetchMock() },
			),
		);
		expect(startResponse.status).toBe(302);
		const startLocation = new URL(startResponse.headers.get("location")!);
		expect(startLocation.origin).toBe("https://accounts.google.com");
		expect(startLocation.searchParams.get("scope")).toBe("openid email profile");
		expect(startLocation.searchParams.get("access_type")).toBeNull();
		expect(startLocation.searchParams.get("prompt")).toBeNull();
		expect(startLocation.searchParams.get("code_challenge_method")).toBe("S256");
		const googleStartCookies = startResponse.headers.getSetCookie().join(";");
		expect(googleStartCookies).toContain(`${googleCookies.returnTo}=%2Fme%2Fprofile`);
		expect(googleStartCookies).toContain(`${googleCookies.pkce}=`);
		expect(googleStartCookies).toContain(`${googleCookies.nonce}=`);

		const callbackResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							`${googleCookies.state}=state-1; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-1; ${googleCookies.nonce}=nonce-1`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock(),
				},
			),
		);
		expect(callbackResponse.status).toBe(302);
		expect(callbackResponse.headers.get("location")).toBe("/me/profile");
		const sessionCookie = callbackResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(sessionCookie).toBeDefined();

		const profileResponse = await getProfile(
			contextFor<typeof getProfile>(
				new Request("http://example.com/api/me/profile", {
					headers: { cookie: sessionCookie! },
				}),
			),
		);
		expect(await profileResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					displayName: unspecifiedLt("Google Octo"),
					authIdentities: [
						{
							provider: "google",
							providerLogin: "google-octo@example.com",
							email: "google-octo@example.com",
							avatarUrl: "https://example.com/google-octo.png",
						},
					],
				},
			},
		});
	});

	it("links and unlinks providers without removing the last sign-in method", async () => {
		const githubCookie = await authCookieFor({
			subject: "github-link-1",
			login: "github-link",
			displayName: "GitHub Link",
		});
		const googleCookies = oauthCookieNames("google");
		const linkGoogleResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							`${githubCookie}; ${googleCookies.state}=state-1; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-1; ${googleCookies.nonce}=nonce-1`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock({ subject: "google-link-1", email: "google-link@example.com" }),
				},
			),
		);
		expect(linkGoogleResponse.status).toBe(302);
		expect(linkGoogleResponse.headers.get("location")).toBe("/me/profile");

		let profileResponse = await getProfile(
			contextFor<typeof getProfile>(
				new Request("http://example.com/api/me/profile", { headers: { cookie: githubCookie } }),
			),
		);
		expect(await profileResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					authIdentities: expect.arrayContaining([
						expect.objectContaining({ provider: "github", providerLogin: "github-link" }),
						expect.objectContaining({ provider: "google", providerLogin: "google-link@example.com" }),
					]),
				},
			},
		});

		const unlinkGoogleResponse = await unlinkAuthIdentity(
			contextFor<typeof unlinkAuthIdentity>(
				new Request("http://example.com/api/me/auth/identities/google", {
					method: "DELETE",
					headers: { cookie: githubCookie },
				}),
				{ provider: "google" },
			),
		);
		expect(unlinkGoogleResponse.status).toBe(200);
		expect(await unlinkGoogleResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					authIdentities: [expect.objectContaining({ provider: "github" })],
				},
			},
		});

		const unlinkMissingResponse = await unlinkAuthIdentity(
			contextFor<typeof unlinkAuthIdentity>(
				new Request("http://example.com/api/me/auth/identities/google", {
					method: "DELETE",
					headers: { cookie: githubCookie },
				}),
				{ provider: "google" },
			),
		);
		expect(unlinkMissingResponse.status).toBe(404);

		const unlinkLastResponse = await unlinkAuthIdentity(
			contextFor<typeof unlinkAuthIdentity>(
				new Request("http://example.com/api/me/auth/identities/github", {
					method: "DELETE",
					headers: { cookie: githubCookie },
				}),
				{ provider: "github" },
			),
		);
		expect(unlinkLastResponse.status).toBe(409);

		const googleFirstResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-2", {
					headers: {
						cookie:
							`${googleCookies.state}=state-2; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-2; ${googleCookies.nonce}=nonce-2`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock({
						subject: "google-first",
						email: "google-first@example.com",
						nonce: "nonce-2",
					}),
				},
			),
		);
		const googleFirstCookie = googleFirstResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(googleFirstCookie).toBeDefined();
		const githubCookies = oauthCookieNames("github");
		const linkGithubResponse = await githubCallback(
			contextFor<typeof githubCallback>(
				new Request("http://example.com/api/auth/github/callback?code=abc&state=state-3", {
					headers: {
						cookie:
							`${googleFirstCookie}; ${githubCookies.state}=state-3; ${githubCookies.returnTo}=%2Fme%2Fprofile; ${githubCookies.pkce}=verifier-3`,
					},
				}),
				{},
				{
					GITHUB_CLIENT_ID: "client-id",
					GITHUB_CLIENT_SECRET: "client-secret",
					OAUTH_FETCH: oauthFetchMock,
				},
			),
		);
		expect(linkGithubResponse.status).toBe(302);
		profileResponse = await getProfile(
			contextFor<typeof getProfile>(
				new Request("http://example.com/api/me/profile", { headers: { cookie: googleFirstCookie! } }),
			),
		);
		expect(await profileResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					authIdentities: expect.arrayContaining([
						expect.objectContaining({ provider: "google", providerLogin: "google-first@example.com" }),
						expect.objectContaining({ provider: "github", providerLogin: "octocat" }),
					]),
				},
			},
		});
	});

	it("does not auto-link providers by email and rejects links owned by another account", async () => {
		const githubUser = await upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
			provider: "github",
			subject: "github-shared-email",
			login: "shared-github",
			displayName: "Shared GitHub",
			email: "shared@example.com",
		});
		await updateUserProfile(testEnv.BICKR_KV, testEnv.BICKR_D1, githubUser.id, {
			handle: githubUser.handle,
			displayName: githubUser.displayName,
		});
		const githubSession = await createSession(testEnv.BICKR_KV, githubUser.id);
		const githubCookie = `${sessionCookieName}=${encodeURIComponent(githubSession.cookieValue)}`;
		const googleCookies = oauthCookieNames("google");
		const googleSignInResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-1", {
					headers: {
						cookie:
							`${googleCookies.state}=state-1; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-1; ${googleCookies.nonce}=nonce-1`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock({ subject: "google-shared-email", email: "shared@example.com" }),
				},
			),
		);
		const googleCookie = googleSignInResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
		expect(googleCookie).toBeDefined();
		const googleSessionResponse = await session(
			contextFor<typeof session>(
				new Request("http://example.com/api/session", { headers: { cookie: googleCookie! } }),
			),
		);
		const googleSessionPayload = await googleSessionResponse.json() as {
			data: { authenticated: boolean; user: { id: string } | null };
		};
		expect(googleSessionPayload).toMatchObject({
			ok: true,
			data: {
				authenticated: true,
			},
		});
		expect(googleSessionPayload.data.user?.id).not.toBe(githubUser.id);

		const conflictResponse = await googleCallback(
			contextFor<typeof googleCallback>(
				new Request("http://example.com/api/auth/google/callback?code=abc&state=state-2", {
					headers: {
						cookie:
							`${githubCookie}; ${googleCookies.state}=state-2; ${googleCookies.returnTo}=%2Fme%2Fprofile; ${googleCookies.pkce}=verifier-2; ${googleCookies.nonce}=nonce-2`,
					},
				}),
				{},
				{
					GOOGLE_CLIENT_ID: "google-client",
					GOOGLE_CLIENT_SECRET: "google-secret",
					OAUTH_FETCH: googleOauthFetchMock({
						subject: "google-shared-email",
						email: "shared@example.com",
						nonce: "nonce-2",
					}),
				},
			),
		);
		expect(conflictResponse.status).toBe(302);
		expect(conflictResponse.headers.get("location")).toBe("/me/profile?authError=identity_conflict");
	});

	it("renames world handles across route metadata", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "release-room");
		const bot = await createBotForTest(cookie, "release-sage");
		const thread = await createThreadForTest(forum.id, bot.id, "World rename route", "World route body.");
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "taken-world", name: "Taken World", description: "Already exists." },
					cookie,
				),
			),
		);

		const conflict = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes",
					"PATCH",
					{ handle: "taken-world" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(conflict.status).toBe(409);

		const response = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes",
					"PATCH",
					{ handle: "release-notes", name: "Release Notes" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { world: { handle: "release-notes", name: lt("Release Notes") } },
		});

		const worldsResponse = await worlds(contextFor<typeof worlds>(new Request("http://example.com/api/worlds")));
		expect(await worldsResponse.json()).toMatchObject({
			ok: true,
			data: { worlds: expect.arrayContaining([expect.objectContaining({ handle: "release-notes" })]) },
		});

		const forumsResponse = await forums(
			contextFor<typeof forums>(
				new Request("http://example.com/api/worlds/release-notes/forums"),
				{ worldHandle: "release-notes" },
			),
		);
		const forumsPayload = (await forumsResponse.json()) as { data: { forums: Array<{ handle: string; worldHandle: string }> } };
		expect(forumsPayload.data.forums.find((item) => item.handle === "release-room")).toMatchObject({
			worldHandle: "release-notes",
		});

		const botsResponse = await worldBots(
			contextFor<typeof worldBots>(
				new Request("http://example.com/api/worlds/release-notes/bots"),
				{ worldHandle: "release-notes" },
			),
		);
		const botsPayload = (await botsResponse.json()) as { data: { bots: Array<{ handle: string; homeWorldHandle: string }> } };
		expect(botsPayload.data.bots.find((item) => item.handle === "release-sage")).toMatchObject({
			homeWorldHandle: "release-notes",
		});

		const threadResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/release-notes/forums/release-room/threads/${thread.id}`),
				{ worldHandle: "release-notes", forumHandle: "release-room", threadId: thread.id },
			),
		);
		expect(threadResponse.status, await threadResponse.clone().text()).toBe(200);
		expect(await threadResponse.json()).toMatchObject({
			ok: true,
			data: { thread: { id: thread.id, worldHandle: "release-notes", forumHandle: "release-room" } },
		});
	});

	it("persists configurable posting settings in world and bot summaries", async () => {
		const cookie = await authCookie();
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{
						handle: "limits-world",
						name: "Limits World",
						description: "Posting limits.",
						postingSettings: {
							threadBodyCharacters: 6000,
							commentBodyCharacters: 3000,
						},
					},
					cookie,
				),
			),
		);
		expect(worldResponse.status, await worldResponse.clone().text()).toBe(201);
		expect(await worldResponse.json()).toMatchObject({
			ok: true,
			data: {
				world: {
					handle: "limits-world",
					postingSettings: {
						threadBodyCharacters: 6000,
						commentBodyCharacters: 3000,
					},
				},
			},
		});

		const worldsResponse = await worlds(contextFor<typeof worlds>(new Request("http://example.com/api/worlds")));
		expect(await worldsResponse.json()).toMatchObject({
			ok: true,
			data: {
				worlds: expect.arrayContaining([
					expect.objectContaining({
						handle: "limits-world",
						postingSettings: {
							threadBodyCharacters: 6000,
							commentBodyCharacters: 3000,
						},
					}),
				]),
			},
		});

		const tooLargeBotResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/limits-world/bots",
					"POST",
					{
						handle: "too-large-limits",
						displayName: "Too Large Limits",
						shortBio: "Limit test.",
						prompt: "Post within the configured limits.",
						postingSettings: { threadBodyCharacters: 7000 },
					},
					cookie,
				),
				{ worldHandle: "limits-world" },
			),
		);
		expect(tooLargeBotResponse.status).toBe(400);

		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/limits-world/bots",
					"POST",
					{
						handle: "limits-bot",
						displayName: "Limits Bot",
						shortBio: "Limit test.",
						prompt: "Post within the configured limits.",
						postingSettings: {
							threadBodyCharacters: 5000,
						},
					},
					cookie,
				),
				{ worldHandle: "limits-world" },
			),
		);
		expect(botResponse.status, await botResponse.clone().text()).toBe(201);
		const botPayload = (await botResponse.json()) as { data: { bot: BotBody } };
		expect(botPayload.data.bot.postingSettings).toEqual({ threadBodyCharacters: 5000 });
		expect(botPayload.data.bot.effectivePostingSettings).toEqual({
			threadBodyCharacters: 5000,
			commentBodyCharacters: 3000,
		});

		const patchedBotResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${botPayload.data.bot.id}`,
					"PATCH",
					{
						postingSettings: {
							threadBodyCharacters: null,
							commentBodyCharacters: 2000,
						},
					},
					cookie,
				),
				{ botId: botPayload.data.bot.id },
			),
		);
		expect(patchedBotResponse.status, await patchedBotResponse.clone().text()).toBe(200);
		expect(await patchedBotResponse.json()).toMatchObject({
			ok: true,
			data: {
				bot: {
					postingSettings: { commentBodyCharacters: 2000 },
					effectivePostingSettings: {
						threadBodyCharacters: 6000,
						commentBodyCharacters: 2000,
					},
				},
			},
		});

		const clearedWorldResponse = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/limits-world",
					"PATCH",
					{
						postingSettings: {
							threadBodyCharacters: null,
							commentBodyCharacters: null,
						},
					},
					cookie,
				),
				{ worldHandle: "limits-world" },
			),
		);
		expect(clearedWorldResponse.status, await clearedWorldResponse.clone().text()).toBe(200);
		const clearedWorldPayload = (await clearedWorldResponse.json()) as { data: { world: WorldSummary } };
		expect(clearedWorldPayload.data.world.postingSettings).toBeUndefined();
	});

	it("renames forum handles without rewriting old textual references", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "dev-log");
		const bot = await createBotForTest(cookie, "scribe");
		const thread = await createThreadForTest(
			forum.id,
			bot.id,
			"Forum rename route",
			"Older prose still says f/dev-log and should stay that way.",
		);
		await createForumForTest(cookie, "taken-forum");

		const conflict = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/dev-log",
					"PATCH",
					{ handle: "taken-forum" },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "dev-log" },
			),
		);
		expect(conflict.status).toBe(409);

		const response = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums/dev-log",
					"PATCH",
					{ handle: "release-log" },
					cookie,
				),
				{ worldHandle: "patch-notes", forumHandle: "dev-log" },
			),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { forum: { handle: "release-log" } },
		});

		const threadResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/release-log/threads/${thread.id}`),
				{ worldHandle: "patch-notes", forumHandle: "release-log", threadId: thread.id },
			),
		);
		expect(threadResponse.status, await threadResponse.clone().text()).toBe(200);
		const payload = (await threadResponse.json()) as { data: { thread: ThreadDocument } };
		expect(payload.data.thread.forumHandle).toBe("release-log");
		expect(localizedTextString(payload.data.thread.comments.find((comment) => comment.id === payload.data.thread.rootCommentId)?.body)).toContain("f/dev-log");
	});

	it("renames bot handles and matching personal forums without rewriting old authors", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "release-sage");
		const personalForum = (await listForums(testEnv.BICKR_D1, "patch-notes")).find((forum) => forum.personalBotId === bot.id);
		expect(personalForum).toMatchObject({ handle: "release-sage" });
		if (!personalForum) {
			throw new Error("Personal forum missing.");
		}
		const thread = await createThreadForTest(
			personalForum.id,
			bot.id,
			"Bot rename route",
			"Older prose still says u/release-sage and f/release-sage.",
		);

		const response = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}`,
					"PATCH",
					{ handle: "release-oracle" },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { bot: { handle: "release-oracle" } },
		});

		const forumsAfter = await listForums(testEnv.BICKR_D1, "patch-notes");
		expect(forumsAfter.find((forum) => forum.personalBotId === bot.id)).toMatchObject({
			handle: "release-oracle",
			description: lt("Blog of Release Sage (u/release-oracle)"),
		});

		const storedThread = await readThread(testEnv.BICKR_KV, thread.id);
		const root = storedThread.comments.find((comment) => comment.id === storedThread.rootCommentId);
		expect(storedThread.forumHandle).toBe("release-oracle");
	expect(root).toMatchObject({
		authorHandle: "release-sage",
		body: lt("Older prose still says u/release-sage and f/release-sage."),
	});

		const threadResponse = await threadDetail(
			contextFor<typeof threadDetail>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/release-oracle/threads/${thread.id}`),
				{ worldHandle: "patch-notes", forumHandle: "release-oracle", threadId: thread.id },
			),
		);
		expect(threadResponse.status, await threadResponse.clone().text()).toBe(200);
	});

	it("rejects bot rename conflicts for bot and personal forum handles", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "first-bot");
		await createBotForTest(cookie, "second-bot");

		const botConflict = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}`,
					"PATCH",
					{ handle: "second-bot" },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(botConflict.status).toBe(409);

		await createForumForTest(cookie, "forum-taken");
		const forumConflict = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}`,
					"PATCH",
					{ handle: "forum-taken" },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(forumConflict.status).toBe(409);
	});

	it("accepts Unicode letters, numbers, hyphens, and underscores in handles", async () => {
		const cookie = await authCookieFor({
			subject: "unicode-handles",
			login: "Müller_42",
			displayName: "Unicode User",
		});
		expect(isValidHandleText("x")).toBe(true);
		expect(isValidHandleText("_")).toBe(true);
		expect(isValidHandleText("-a")).toBe(true);
		expect(isValidHandleText("a-")).toBe(true);
		expect(sanitizeHandleInput("_a-")).toBe("_a-");

		const profileResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{ handle: "δοκιμή_42", displayName: "Unicode User" },
					cookie,
				),
			),
		);
		expect(profileResponse.status).toBe(200);
		expect(await profileResponse.json()).toMatchObject({
			ok: true,
			data: { profile: { handle: "δοκιμή_42" } },
		});

		const worldHandle = "мир_2026";
		const encodedWorldHandle = encodeURIComponent(worldHandle);
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: worldHandle, name: "Unicode World", description: "Non-Latin handle coverage." },
					cookie,
				),
			),
		);
		expect(worldResponse.status).toBe(201);
		expect(await worldResponse.json()).toMatchObject({
			ok: true,
			data: { world: { handle: worldHandle } },
		});

		const forumHandle = "форум_2-β";
		const encodedForumHandle = encodeURIComponent(forumHandle);
		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					`http://example.com/api/worlds/${encodedWorldHandle}/forums`,
					"POST",
					{ handle: forumHandle, description: "Unicode forum handle." },
					cookie,
				),
				{ worldHandle: encodedWorldHandle },
			),
		);
		expect(forumResponse.status).toBe(201);
		expect(await forumResponse.json()).toMatchObject({
			ok: true,
			data: { forum: { handle: forumHandle, worldHandle } },
		});

		const forumThreadsResponse = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request(`http://example.com/api/worlds/${encodedWorldHandle}/forums/${encodedForumHandle}/threads`),
				{ worldHandle: encodedWorldHandle, forumHandle: encodedForumHandle },
			),
		);
		expect(forumThreadsResponse.status).toBe(200);
		expect(await forumThreadsResponse.json()).toMatchObject({
			ok: true,
			data: { forum: { handle: forumHandle, worldHandle } },
		});

		const botHandle = "бот_7-δ";
		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					`http://example.com/api/worlds/${encodedWorldHandle}/bots`,
					"POST",
					{
						handle: botHandle,
						displayName: "Unicode Bot",
						shortBio: "Exercises non-Latin bot handles.",
						prompt: "Stay concise.",
					},
					cookie,
				),
				{ worldHandle: encodedWorldHandle },
			),
		);
		expect(botResponse.status).toBe(201);
		expect(await botResponse.json()).toMatchObject({
			ok: true,
			data: { bot: { handle: botHandle, homeWorldHandle: worldHandle } },
		});

		const shortProfileResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest("http://example.com/api/me/profile", "PATCH", { handle: "x", displayName: "Unicode User" }, cookie),
			),
		);
		expect(shortProfileResponse.status).toBe(200);

		const shortWorldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", { handle: "_", name: "Underscore", description: "Short handle world." }, cookie),
			),
		);
		expect(shortWorldResponse.status).toBe(201);
		const shortForumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest("http://example.com/api/worlds/_/forums", "POST", { handle: "-", description: "One character forum." }, cookie),
				{ worldHandle: "_" },
			),
		);
		expect(shortForumResponse.status).toBe(201);
		const shortBotResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest("http://example.com/api/worlds/_/bots", "POST", {
					handle: "_-",
					displayName: "Short Bot",
					shortBio: "Short handle bot.",
					prompt: "Stay concise.",
				}, cookie),
				{ worldHandle: "_" },
			),
		);
		expect(shortBotResponse.status).toBe(201);
	});

	it("returns public human profile ownership grouped by world", async () => {
		const cookie = await authCookieFor({
			subject: "human-profile-owner",
			login: "profile-owner",
			displayName: "Profile Owner",
		});
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", {
					handle: "owned-world",
					name: "Owned World",
					description: "A world owned by the profile.",
				}, cookie),
			),
		);
		await createForum(
			contextFor<typeof createForum>(
				jsonRequest("http://example.com/api/worlds/owned-world/forums", "POST", {
					handle: "manual-forum",
					description: "A manually owned forum.",
				}, cookie),
				{ worldHandle: "owned-world" },
			),
		);
		await createBot(
			contextFor<typeof createBot>(
				jsonRequest("http://example.com/api/worlds/owned-world/bots", "POST", {
					handle: "profile-bot",
					displayName: "Profile Bot",
					shortBio: "Owned by the human profile.",
					prompt: "Stay concise.",
				}, cookie),
				{ worldHandle: "owned-world" },
			),
		);

		const response = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/profile-owner", { headers: { cookie } }),
				{ humanHandle: "profile-owner" },
			),
		);
		expect(response.status).toBe(200);
		const payload = await response.json() as {
			data: {
				profile: {
					user: Record<string, unknown>;
					worlds: Array<{ handle: string }>;
					forumsByWorld: Array<{ world: { handle: string }; forums: Array<{ handle: string }> }>;
					botsByWorld: Array<{ world: { handle: string }; bots: Array<BotBody> }>;
					totals: { worlds: number; forums: number; bots: number };
					isSelf: boolean;
					deleteEligibility?: { canDelete: boolean };
				};
			};
		};
		expect(payload.data.profile.user).toMatchObject({
			handle: "profile-owner",
			displayName: unspecifiedLt("Profile Owner"),
		});
		expect(payload.data.profile.user).not.toHaveProperty("authIdentities");
		expect(payload.data.profile.user).not.toHaveProperty("inferenceSettings");
		expect(payload.data.profile.worlds.map((world) => world.handle)).toEqual(["owned-world"]);
		expect(payload.data.profile.forumsByWorld[0]).toMatchObject({
			world: { handle: "owned-world" },
			forums: expect.arrayContaining([
				expect.objectContaining({ handle: "intro" }),
				expect.objectContaining({ handle: "manual-forum" }),
			]),
		});
		expect(payload.data.profile.forumsByWorld[0]?.forums.map((forum) => forum.handle)).not.toContain("profile-bot");
		expect(payload.data.profile.botsByWorld).toEqual([
			expect.objectContaining({
				world: expect.objectContaining({ handle: "owned-world" }),
				bots: [expect.objectContaining({ handle: "profile-bot", owner: expect.objectContaining({ handle: "profile-owner" }) })],
			}),
		]);
		expect(payload.data.profile.totals).toEqual({ worlds: 1, forums: 2, bots: 1 });
		expect(payload.data.profile.isSelf).toBe(true);
		expect(payload.data.profile.deleteEligibility).toMatchObject({ canDelete: true });

		const missingResponse = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/missing-profile", { headers: { cookie } }),
				{ humanHandle: "missing-profile" },
			),
		);
		expect(missingResponse.status).toBe(404);
	});

	it("cascades self profile deletion and frees the sign-in identity", async () => {
		const cookie = await authCookieFor({
			subject: "delete-profile-subject",
			login: "delete-profile",
			displayName: "Delete Profile",
		});
		const viewerCookie = await authCookieFor({
			subject: "delete-profile-viewer",
			login: "delete-profile-viewer",
			displayName: "Delete Profile Viewer",
		});
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", {
					handle: "delete-world",
					name: "Delete World",
					description: "Owned by the deleted profile.",
				}, cookie),
			),
		);
		const worldPayload = await worldResponse.json() as { data: { world: WorldSummary } };
		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest("http://example.com/api/worlds/delete-world/bots", "POST", {
					handle: "delete-bot",
					displayName: "Delete Bot",
					shortBio: "Deleted with the profile.",
					prompt: "Stay concise.",
				}, cookie),
				{ worldHandle: "delete-world" },
			),
		);
		const botPayload = await botResponse.json() as { data: { bot: BotBody } };

		const missingConfirm = await deleteProfileRoute(
			contextFor<typeof deleteProfileRoute>(
				jsonRequest("http://example.com/api/me/profile", "DELETE", {}, cookie),
			),
		);
		expect(missingConfirm.status).toBe(400);

		const deleteResponse = await deleteProfileRoute(
			contextFor<typeof deleteProfileRoute>(
				jsonRequest("http://example.com/api/me/profile", "DELETE", { confirmCascade: true }, cookie),
			),
		);
		expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(200);
		expect(deleteResponse.headers.getSetCookie().join(";")).toContain("Max-Age=0");

		const sessionResponse = await session(
			contextFor<typeof session>(new Request("http://example.com/api/session", { headers: { cookie } })),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: { authenticated: false, user: null },
		});
		const rows = await testEnv.BICKR_D1.prepare(
			`SELECT
				(SELECT deleted_at FROM users_index WHERE handle LIKE 'deleted-%') AS userDeletedAt,
				(SELECT deleted_at FROM worlds_index WHERE world_id = ?) AS worldDeletedAt,
				(SELECT deleted_at FROM bots_index WHERE bot_id = ?) AS botDeletedAt,
				(SELECT COUNT(*) FROM provider_identities WHERE provider_subject = 'delete-profile-subject') AS identityCount`,
		)
			.bind(worldPayload.data.world.id, botPayload.data.bot.id)
			.first<{ userDeletedAt: string | null; worldDeletedAt: string | null; botDeletedAt: string | null; identityCount: number }>();
		expect(rows?.userDeletedAt).toEqual(expect.any(String));
		expect(rows?.worldDeletedAt).toEqual(expect.any(String));
		expect(rows?.botDeletedAt).toEqual(expect.any(String));
		expect(rows?.identityCount).toBe(0);

		const deletedProfileResponse = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/delete-profile", { headers: { cookie: viewerCookie } }),
				{ humanHandle: "delete-profile" },
			),
		);
		expect(deletedProfileResponse.status).toBe(404);

		const replacementCookie = await authCookieFor({
			subject: "delete-profile-subject",
			login: "delete-profile",
			displayName: "Delete Profile Again",
		});
		const replacementSession = await session(
			contextFor<typeof session>(new Request("http://example.com/api/session", { headers: { cookie: replacementCookie } })),
		);
		expect(await replacementSession.json()).toMatchObject({
			ok: true,
			data: {
				authenticated: true,
				user: { handle: "delete-profile", displayName: unspecifiedLt("Delete Profile Again") },
			},
		});
	});

	it("blocks profile deletion when owned worlds contain bots owned by other profiles", async () => {
		const ownerCookie = await authCookieFor({
			subject: "delete-block-owner",
			login: "delete-block-owner",
			displayName: "Delete Block Owner",
		});
		const guestCookie = await authCookieFor({
			subject: "delete-block-guest",
			login: "delete-block-guest",
			displayName: "Delete Block Guest",
		});
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest("http://example.com/api/worlds", "POST", {
					handle: "blocked-world",
					name: "Blocked World",
					description: "Contains another profile's bot.",
				}, ownerCookie),
			),
		);
		await createBot(
			contextFor<typeof createBot>(
				jsonRequest("http://example.com/api/worlds/blocked-world/bots", "POST", {
					handle: "guest-bot",
					displayName: "Guest Bot",
					shortBio: "Blocks profile deletion.",
					prompt: "Stay concise.",
				}, guestCookie),
				{ worldHandle: "blocked-world" },
			),
		);

		const deleteResponse = await deleteProfileRoute(
			contextFor<typeof deleteProfileRoute>(
				jsonRequest("http://example.com/api/me/profile", "DELETE", { confirmCascade: true }, ownerCookie),
			),
		);
		expect(deleteResponse.status).toBe(409);
		const payload = await deleteResponse.json() as {
			details?: { profileDeleteBlockers?: Array<{ world: { handle: string }; bots: Array<{ handle: string }> }> };
		};
		expect(payload.details?.profileDeleteBlockers).toEqual([
			expect.objectContaining({
				world: expect.objectContaining({ handle: "blocked-world" }),
				bots: [expect.objectContaining({ handle: "guest-bot" })],
			}),
		]);
		const world = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM worlds_index WHERE handle = 'blocked-world'`,
		).first<{ deletedAt: string | null }>();
		const owner = await testEnv.BICKR_D1.prepare(
			`SELECT deleted_at AS deletedAt FROM users_index WHERE handle = 'delete-block-owner'`,
		).first<{ deletedAt: string | null }>();
		expect(world?.deletedAt).toBeNull();
		expect(owner?.deletedAt).toBeNull();
	});

	it("creates, lists, edits, and soft-deletes current-user bots", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);

		const createResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "release-sage",
						displayName: "Release Sage",
						shortBio: "Reads changelogs too closely.",
						prompt: "Treat every patch note like a prophecy.",
						inferenceSettings: {
							openRouterApiKey: "sk-or-bot-secret",
							model: "openrouter/auto",
							compactionMode: "tool_call_cache_friendly",
							reasoningPrefill: "I'm Release Sage, and I  ",
							supportsPrefill: false,
							providerRouting: {
								max_price: {
									prompt: 0.25,
									completion: 0.75,
								},
							},
							temperature: 0.4,
							topP: 0.8,
							frequency_penalty: -0.2,
							presencePenalty: 0.45,
							repetition_penalty: 1.1,
							toolCalls: "railroad",
						},
						toolSettings: {
							openRouter: {
								datetime: { enabled: true, timezone: "America/Los_Angeles" },
								webSearch: {
									enabled: true,
									engine: "exa",
									maxResults: 4,
									maxTotalResults: 12,
									searchContextSize: "medium",
									userLocation: {
										city: "San Francisco",
										region: "California",
										country: "US",
										timezone: "America/Los_Angeles",
									},
									allowedDomains: [" Example.com ", "docs.example.com"],
									excludedDomains: ["reddit.com"],
								},
								webFetch: {
									enabled: true,
									engine: "openrouter",
									maxUses: 3,
									maxContentTokens: 50_000,
									allowedDomains: ["docs.example.com"],
									blockedDomains: ["private.example.com"],
								},
							},
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(createResponse.status).toBe(201);
		const created = (await createResponse.json()) as { data: { bot: BotBody } };
		expect(created.data.bot.handle).toBe("release-sage");
		expect(created.data.bot.owner).toMatchObject({ handle: "octocat", displayName: unspecifiedLt("Octo Cat") });
		expect(created.data.bot.inferenceSettings).toMatchObject({
			openRouterApiKeySet: true,
			model: "openrouter/auto",
			compactionMode: "tool_call_cache_friendly",
			recurringPrompt: lt("I'm Release Sage, and I  "),
			supportsPrefill: false,
			providerRouting: {
				max_price: {
					prompt: 0.25,
					completion: 0.75,
				},
			},
			temperature: 0.4,
			topP: 0.8,
			frequencyPenalty: -0.2,
			presencePenalty: 0.45,
			repetitionPenalty: 1.1,
			toolCalls: "railroad",
		});
		expect(created.data.bot.inferenceSettings.openRouterApiKey).toBeUndefined();
		expect(created.data.bot.inferenceSettings.recurringPromptEnabled).toBeUndefined();
		expect(created.data.bot.toolSettings).toMatchObject({
			openRouter: {
				datetime: { enabled: true, timezone: "America/Los_Angeles" },
				webSearch: {
					enabled: true,
					engine: "exa",
					maxResults: 4,
					maxTotalResults: 12,
					searchContextSize: "medium",
					userLocation: {
						type: "approximate",
						city: "San Francisco",
						region: "California",
						country: "US",
						timezone: "America/Los_Angeles",
					},
					allowedDomains: ["example.com", "docs.example.com"],
					excludedDomains: ["reddit.com"],
				},
				webFetch: {
					enabled: true,
					engine: "openrouter",
					maxUses: 3,
					maxContentTokens: 50_000,
					allowedDomains: ["docs.example.com"],
					blockedDomains: ["private.example.com"],
				},
			},
		});

		const noKeyModelResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "default-only",
						displayName: "Default Only",
						shortBio: "Uses the shared default.",
						prompt: "Do not customize provider settings.",
						inferenceSettings: {
							model: "anthropic/claude-3.5-haiku",
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(noKeyModelResponse.status).toBe(201);
		const noKeyModel = (await noKeyModelResponse.json()) as { data: { bot: BotBody } };
		expect(noKeyModel.data.bot.inferenceSettings.model).toBeUndefined();

		const customBaseModelResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "custom-base",
						displayName: "Custom Base",
						shortBio: "Uses a local endpoint.",
						prompt: "Use the custom endpoint.",
						inferenceSettings: {
							baseUrl: "http://localhost:11434/v1",
							model: "local/model",
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(customBaseModelResponse.status).toBe(201);
		const customBaseModel = (await customBaseModelResponse.json()) as { data: { bot: BotBody } };
		expect(customBaseModel.data.bot.inferenceSettings).toMatchObject({
			baseUrl: "http://localhost:11434/v1",
			model: "local/model",
		});
		expect(customBaseModel.data.bot.inferenceSettings.openRouterApiKeySet).toBeUndefined();

		const worldBotsResponse = await worldBots(
			contextFor<typeof worldBots>(
				new Request("http://example.com/api/worlds/patch-notes/bots"),
				{ worldHandle: "patch-notes" },
			),
		);
		const worldBotsPayload = (await worldBotsResponse.json()) as { data: { bots: BotBody[] } };
		expect(worldBotsPayload.data.bots.find((bot) => bot.handle === "release-sage")?.prompt).toBeUndefined();
		expect(worldBotsPayload.data.bots.find((bot) => bot.handle === "release-sage")?.owner).toMatchObject({
			handle: "octocat",
			displayName: unspecifiedLt("Octo Cat"),
		});

		const clearedToolSettingsResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{
						toolSettings: {
							openRouter: {
								datetime: { timezone: null },
								webSearch: { allowedDomains: null, userLocation: null },
								webFetch: null,
							},
						},
					},
					cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(clearedToolSettingsResponse.status, await clearedToolSettingsResponse.clone().text()).toBe(200);
		const clearedToolSettings = (await clearedToolSettingsResponse.json()) as { data: { bot: BotBody } };
		expect(clearedToolSettings.data.bot.toolSettings).toMatchObject({
			openRouter: {
				datetime: { enabled: true },
				webSearch: { enabled: true },
			},
		});
		const clearedOpenRouterTools = clearedToolSettings.data.bot.toolSettings?.openRouter as Record<string, unknown>;
		expect(clearedOpenRouterTools).not.toHaveProperty("webFetch");
		expect(clearedOpenRouterTools.webSearch).not.toHaveProperty("userLocation");
		expect(clearedOpenRouterTools.webSearch).not.toHaveProperty("allowedDomains");

		const runtimeRow = await testEnv.BICKR_D1.prepare(
			`SELECT
				enabled,
				status,
					tick_interval_seconds AS tickIntervalSeconds,
					context_window_tokens AS contextWindowTokens,
					compaction_summary_percent AS compactionSummaryPercent,
					compaction_max_characters AS compactionMaxCharacters,
					max_tool_calls_per_tick AS maxToolCallsPerTick,
					max_successful_tool_calls_per_iteration AS maxSuccessfulToolCallsPerIteration,
					max_generated_tokens_per_tick AS maxGeneratedTokensPerTick,
					max_generated_tokens_per_iteration AS maxGeneratedTokensPerIteration,
					next_due_at AS nextDueAt
				 FROM bot_runtime_index
				 WHERE bot_id = ?`,
			)
				.bind(created.data.bot.id)
				.first<{
					enabled: number;
					status: string;
					tickIntervalSeconds: number;
					contextWindowTokens: number | null;
					compactionSummaryPercent: number;
					compactionMaxCharacters: number;
					maxToolCallsPerTick: number;
					maxSuccessfulToolCallsPerIteration: number;
					maxGeneratedTokensPerTick: number;
					maxGeneratedTokensPerIteration: number;
					nextDueAt: string | null;
				}>();
			expect(created.data.bot.tickSettings).toMatchObject({
				enabled: false,
				intervalSeconds: 86_400,
		});
			expect(created.data.bot.tickSettings).not.toHaveProperty("allowEarlyLogOff");
			expect(created.data.bot.tickSettings).not.toHaveProperty("contextWindowTokens");
			expect(created.data.bot.tickSettings).not.toHaveProperty("compactionSummaryPercent");
			expect(created.data.bot.tickSettings).not.toHaveProperty("compactionMaxCharacters");
			expect(created.data.bot.tickSettings).not.toHaveProperty("maxToolCallsPerTick");
			expect(created.data.bot.tickSettings).not.toHaveProperty("maxSuccessfulToolCallsPerIteration");
			expect(created.data.bot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerTick");
			expect(created.data.bot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerIteration");
			expect(created.data.bot.effectiveTickSettings).toMatchObject({
				allowEarlyLogOff: true,
				contextWindowTokens: 30_000,
				compactionSummaryPercent: 10,
				compactionMaxCharacters: 4_000,
				maxToolCallsPerTick: 10,
				maxSuccessfulToolCallsPerIteration: 8,
				maxGeneratedTokensPerTick: 15_000,
				maxGeneratedTokensPerIteration: 30_000,
			});
			const storedCreatedBot = await testEnv.BICKR_KV.get(`v1:bot:${created.data.bot.id}`, { type: "json" }) as BotDocument;
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("allowEarlyLogOff");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("contextWindowTokens");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("compactionSummaryPercent");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("compactionMaxCharacters");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("maxToolCallsPerTick");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("maxSuccessfulToolCallsPerIteration");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerTick");
			expect(storedCreatedBot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerIteration");
		expect(created.data.bot.nextDueAt).toBeNull();
		expect(runtimeRow).toMatchObject({
			enabled: 0,
			status: "idle",
			tickIntervalSeconds: 86_400,
				contextWindowTokens: null,
				compactionSummaryPercent: 10,
				compactionMaxCharacters: 4_000,
				maxToolCallsPerTick: 10,
				maxSuccessfulToolCallsPerIteration: 8,
				maxGeneratedTokensPerTick: 15_000,
				maxGeneratedTokensPerIteration: 30_000,
				nextDueAt: null,
			});
		const personalForums = await listForums(testEnv.BICKR_D1, "patch-notes");
		const personalForum = personalForums.find((forum) => forum.personalBotId === created.data.bot.id);
		expect(personalForum).toMatchObject({
			description: lt("Blog of Release Sage (u/release-sage)"),
			handle: "release-sage",
		});
		expect(personalForums.some((forum) => forum.handle === "intro")).toBe(true);
		await ensureBootstrapNotification(
			testEnv.BICKR_KV,
			testEnv.BICKR_D1,
			await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.data.bot.id),
		);
		const bootstrapNotifications = await listPendingNotifications(testEnv.BICKR_KV, testEnv.BICKR_D1, created.data.bot.id);
		expect(localizedTextString(bootstrapNotifications.find((notification) => notification.notificationType === "bootstrap")?.message)).toContain("f/intro");

		await testEnv.BICKR_D1.prepare(
			`UPDATE forums_index SET deleted_at = ?, updated_at = ? WHERE world_handle = ? AND handle = ?`,
		)
			.bind(new Date().toISOString(), new Date().toISOString(), "patch-notes", "intro")
			.run();

		const duplicate = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "release-sage",
						displayName: "Release Sage",
						shortBio: "Reads changelogs too closely.",
						prompt: "Treat every patch note like a prophecy.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(duplicate.status).toBe(409);

		for (const extraBot of [noKeyModel.data.bot, customBaseModel.data.bot]) {
			const extraDelete = await deleteBot(
				contextFor<typeof deleteBot>(
					new Request(`http://example.com/api/me/bots/${extraBot.id}`, {
						method: "DELETE",
						headers: { cookie },
					}),
					{ botId: extraBot.id },
				),
			);
			expect(extraDelete.status).toBe(200);
		}

		const listResponse = await meBots(
			contextFor<typeof meBots>(new Request("http://example.com/api/me/bots", { headers: { cookie } })),
		);
		const listPayload = (await listResponse.json()) as { ok: true; data: { bots: BotBody[] } };
		expect(listPayload).toMatchObject({
			ok: true,
			data: { bots: [{ handle: "release-sage", lastActiveAt: created.data.bot.createdAt, nextDueAt: null }] },
		});
		expect(listPayload.data.bots.find((bot) => bot.handle === "release-sage")?.prompt).toStrictEqual(lt("Treat every patch note like a prophecy."));

		const runtimeBeforePatch = await testEnv.BICKR_D1.prepare(
			`SELECT next_due_at AS nextDueAt
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(created.data.bot.id)
			.first<{ nextDueAt: string | null }>();
		expect(runtimeBeforePatch).toEqual({ nextDueAt: null });
		const beforeUnpause = Date.now();

		const patchResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{
						displayName: "Release Oracle",
							inferenceSettings: {
								compactionMode: null,
								recurringPrompt: null,
								recurringPromptEnabled: false,
								supportsPrefill: null,
							providerRouting: null,
							frequencyPenalty: null,
							presencePenalty: null,
							repetitionPenalty: null,
						},
							tickSettings: {
									enabled: true,
									allowEarlyLogOff: true,
									intervalSeconds: 60,
									contextWindowTokens: 32_000,
									compactionSummaryPercent: 25,
									compactionMaxCharacters: 8_000,
									maxToolCallsPerTick: 12,
								maxSuccessfulToolCallsPerIteration: 9,
								maxGeneratedTokensPerTick: 22_000,
								maxGeneratedTokensPerIteration: 44_000,
							},
						},
						cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		const patchPayload = (await patchResponse.json()) as { ok: true; data: { bot: BotBody } };
		expect(patchPayload).toMatchObject({
			ok: true,
			data: {
				bot: {
					displayName: lt("Release Oracle"),
					tickSettings: {
						enabled: true,
						allowEarlyLogOff: true,
						intervalSeconds: 60,
								contextWindowTokens: 32_000,
								compactionSummaryPercent: 25,
								compactionMaxCharacters: 8_000,
								maxToolCallsPerTick: 12,
							maxSuccessfulToolCallsPerIteration: 9,
							maxGeneratedTokensPerTick: 22_000,
							maxGeneratedTokensPerIteration: 44_000,
						},
					},
				},
		});
		expect(Date.parse(patchPayload.data.bot.nextDueAt ?? "")).toBeGreaterThanOrEqual(beforeUnpause - 1_000);
		expect(Date.parse(patchPayload.data.bot.nextDueAt ?? "")).toBeLessThanOrEqual(Date.now() + 1_000);
			expect(patchPayload.data.bot.inferenceSettings.frequencyPenalty).toBeUndefined();
			expect(patchPayload.data.bot.inferenceSettings.presencePenalty).toBeUndefined();
			expect(patchPayload.data.bot.inferenceSettings.repetitionPenalty).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.compactionMode).toBeUndefined();
			expect(patchPayload.data.bot.inferenceSettings.recurringPrompt).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.recurringPromptEnabled).toBe(false);
		expect(patchPayload.data.bot.inferenceSettings.supportsPrefill).toBeUndefined();
		expect(patchPayload.data.bot.inferenceSettings.providerRouting).toBeUndefined();

		const runtimeAfterPatch = await testEnv.BICKR_D1.prepare(
			`SELECT
						enabled,
						tick_interval_seconds AS tickIntervalSeconds,
						compaction_summary_percent AS compactionSummaryPercent,
						compaction_max_characters AS compactionMaxCharacters,
						max_successful_tool_calls_per_iteration AS maxSuccessfulToolCallsPerIteration,
					max_generated_tokens_per_tick AS maxGeneratedTokensPerTick,
					max_generated_tokens_per_iteration AS maxGeneratedTokensPerIteration,
					next_due_at AS nextDueAt
				 FROM bot_runtime_index
				 WHERE bot_id = ?`,
			)
				.bind(created.data.bot.id)
				.first<{
						enabled: number;
						tickIntervalSeconds: number;
						compactionSummaryPercent: number;
						compactionMaxCharacters: number;
						maxSuccessfulToolCallsPerIteration: number;
					maxGeneratedTokensPerTick: number;
					maxGeneratedTokensPerIteration: number;
					nextDueAt: string | null;
				}>();
			expect(runtimeAfterPatch).toMatchObject({
					enabled: 1,
					tickIntervalSeconds: 60,
					compactionSummaryPercent: 25,
					compactionMaxCharacters: 8_000,
					maxSuccessfulToolCallsPerIteration: 9,
				maxGeneratedTokensPerTick: 22_000,
				maxGeneratedTokensPerIteration: 44_000,
			});
		expect(Date.parse(runtimeAfterPatch?.nextDueAt ?? "")).toBeGreaterThanOrEqual(beforeUnpause - 1_000);
		expect(Date.parse(runtimeAfterPatch?.nextDueAt ?? "")).toBeLessThanOrEqual(Date.now() + 1_000);

		const clearTickDefaultsResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{
									tickSettings: {
										allowEarlyLogOff: null,
										contextWindowTokens: null,
										compactionSummaryPercent: null,
										compactionMaxCharacters: null,
										maxToolCallsPerTick: null,
								maxSuccessfulToolCallsPerIteration: null,
								maxGeneratedTokensPerTick: null,
								maxGeneratedTokensPerIteration: null,
							},
						},
						cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(clearTickDefaultsResponse.status, await clearTickDefaultsResponse.clone().text()).toBe(200);
		const clearedTickDefaults = (await clearTickDefaultsResponse.json()) as { ok: true; data: { bot: BotBody } };
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("contextWindowTokens");
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("allowEarlyLogOff");
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("compactionSummaryPercent");
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("compactionMaxCharacters");
				expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("maxToolCallsPerTick");
			expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("maxSuccessfulToolCallsPerIteration");
			expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerTick");
			expect(clearedTickDefaults.data.bot.tickSettings).not.toHaveProperty("maxGeneratedTokensPerIteration");
			expect(clearedTickDefaults.data.bot.effectiveTickSettings).toMatchObject({
				allowEarlyLogOff: true,
				contextWindowTokens: 30_000,
				compactionSummaryPercent: 10,
				compactionMaxCharacters: 4_000,
				maxToolCallsPerTick: 10,
				maxSuccessfulToolCallsPerIteration: 8,
				maxGeneratedTokensPerTick: 15_000,
				maxGeneratedTokensPerIteration: 30_000,
			});
			const runtimeAfterClearingDefaults = await testEnv.BICKR_D1.prepare(
				`SELECT
						context_window_tokens AS contextWindowTokens,
						compaction_summary_percent AS compactionSummaryPercent,
						compaction_max_characters AS compactionMaxCharacters,
						max_tool_calls_per_tick AS maxToolCallsPerTick,
					max_successful_tool_calls_per_iteration AS maxSuccessfulToolCallsPerIteration,
					max_generated_tokens_per_tick AS maxGeneratedTokensPerTick,
					max_generated_tokens_per_iteration AS maxGeneratedTokensPerIteration
				 FROM bot_runtime_index
				 WHERE bot_id = ?`,
			)
				.bind(created.data.bot.id)
				.first<{
					contextWindowTokens: number | null;
						compactionSummaryPercent: number;
						compactionMaxCharacters: number;
						maxToolCallsPerTick: number;
					maxSuccessfulToolCallsPerIteration: number;
					maxGeneratedTokensPerTick: number;
					maxGeneratedTokensPerIteration: number;
				}>();
				expect(runtimeAfterClearingDefaults).toEqual({
					contextWindowTokens: null,
					compactionSummaryPercent: 10,
					compactionMaxCharacters: 4_000,
					maxToolCallsPerTick: 10,
					maxSuccessfulToolCallsPerIteration: 8,
					maxGeneratedTokensPerTick: 15_000,
					maxGeneratedTokensPerIteration: 30_000,
				});

		const invalidCompactionSettings = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{ tickSettings: { compactionSummaryPercent: 51, compactionMaxCharacters: 0 } },
					cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(invalidCompactionSettings.status).toBe(400);

		const invalidContextBudget = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{ tickSettings: { contextWindowTokens: 14_999 } },
					cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(invalidContextBudget.status).toBe(400);

		const pauseResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}`,
					"PATCH",
					{ tickSettings: { enabled: false } },
					cookie,
				),
				{ botId: created.data.bot.id },
			),
		);
		expect(pauseResponse.status, await pauseResponse.clone().text()).toBe(200);
		const pausePayload = (await pauseResponse.json()) as { ok: true; data: { bot: BotBody } };
		expect(pausePayload.data.bot.nextDueAt).toBeNull();
		const runtimeAfterPause = await testEnv.BICKR_D1.prepare(
			`SELECT enabled, next_due_at AS nextDueAt
			 FROM bot_runtime_index
			 WHERE bot_id = ?`,
		)
			.bind(created.data.bot.id)
			.first<{ enabled: number; nextDueAt: string | null }>();
		expect(runtimeAfterPause).toEqual({ enabled: 0, nextDueAt: null });

		const deleteResponse = await deleteBot(
			contextFor<typeof deleteBot>(
				new Request(`http://example.com/api/me/bots/${created.data.bot.id}`, {
					method: "DELETE",
					headers: { cookie },
				}),
				{ botId: created.data.bot.id },
			),
		);
		expect(deleteResponse.status).toBe(200);

		const afterDelete = await meBots(
			contextFor<typeof meBots>(new Request("http://example.com/api/me/bots", { headers: { cookie } })),
		);
		expect(await afterDelete.json()).toMatchObject({
			ok: true,
			data: { bots: [] },
		});
	});

	it("spreads enabled non-running owned bot ticks and leaves paused or running bots unchanged", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		async function createScheduledBot(handle: string, intervalSeconds: number, enabled = true): Promise<BotBody> {
			const response = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/bots",
						"POST",
						{
							handle,
							displayName: handle,
							shortBio: `${handle} bot.`,
							prompt: `You are ${handle}.`,
							tickSettings: { enabled, intervalSeconds },
						},
						cookie,
					),
					{ worldHandle: "patch-notes" },
				),
			);
			expect(response.status, await response.clone().text()).toBe(201);
			const payload = (await response.json()) as { data: { bot: BotBody } };
			return payload.data.bot;
		}

		const anchor = await createScheduledBot("spread-anchor", 120);
		const later = await createScheduledBot("spread-later", 60);
		const running = await createScheduledBot("spread-running", 90);
		const paused = await createScheduledBot("spread-paused", 60, false);
		const otherCookie = await authCookieFor({ subject: "spread-other", login: "spread-other", displayName: "Spread Other" });
		await createWorldForTest(otherCookie, "spread-other-world", "Spread Other World");
		const other = await createBotInWorld(otherCookie, "spread-other-world", {
			handle: "other-spread-bot",
			displayName: "Other Spread Bot",
		});
		const originalRunningDue = "2026-05-21T12:00:10.000Z";
		const originalOtherDue = "2026-05-21T12:00:20.000Z";
		const updatedAt = "2026-05-21T11:59:00.000Z";
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind("2026-05-21T12:01:00.000Z", updatedAt, anchor.id),
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind("2026-05-21T12:05:00.000Z", updatedAt, later.id),
			testEnv.BICKR_D1.prepare(
				`UPDATE bot_runtime_index
				 SET status = 'running', active_run_id = 'run-spread-test', lease_expires_at = ?, next_due_at = ?, updated_at = ?
				 WHERE bot_id = ?`,
			)
				.bind("2026-05-21T12:30:00.000Z", originalRunningDue, updatedAt, running.id),
			testEnv.BICKR_D1.prepare(`UPDATE bot_runtime_index SET next_due_at = ?, updated_at = ? WHERE bot_id = ?`)
				.bind(originalOtherDue, updatedAt, other.id),
		]);

		const before = Date.now();
		const response = await handleAgentRuntimeRequest(
			new Request(`https://internal.bickr/users/${encodeURIComponent(userId)}/bots/spread-ticks`, {
				method: "POST",
				headers: { "x-bickr-user-id": userId },
			}),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
		);
		const after = Date.now();
		expect(response.status, await response.clone().text()).toBe(200);
		const payload = (await response.json()) as {
			ok: true;
			data: {
				spread: {
					anchorBotId?: string;
					bots: BotBody[];
					scheduled: Array<{ botId: string; nextDueAt: string; offsetSeconds: number; orderRelaxed: boolean }>;
					skipped: { paused: number; running: number };
				};
			};
		};

		expect(payload.data.spread.anchorBotId).toBe(anchor.id);
		expect(payload.data.spread.scheduled.map((schedule) => schedule.botId)).toEqual([anchor.id, later.id]);
		expect(payload.data.spread.scheduled[0]).toMatchObject({ botId: anchor.id, offsetSeconds: 0, orderRelaxed: false });
		expect(payload.data.spread.skipped).toEqual({ paused: 1, running: 1 });

		const rows = await testEnv.BICKR_D1.prepare(
			`SELECT bot_id AS botId, enabled, status, next_due_at AS nextDueAt
			 FROM bot_runtime_index
			 WHERE bot_id IN (?, ?, ?, ?, ?)`,
		)
			.bind(anchor.id, later.id, running.id, paused.id, other.id)
			.all<{ botId: string; enabled: number; status: string; nextDueAt: string | null }>();
		const byId = new Map((rows.results ?? []).map((row) => [row.botId, row]));
		const anchorDue = Date.parse(byId.get(anchor.id)?.nextDueAt ?? "");
		expect(anchorDue).toBeGreaterThanOrEqual(before - 1_000);
		expect(anchorDue).toBeLessThanOrEqual(after + 1_000);
		expect(Date.parse(byId.get(later.id)?.nextDueAt ?? "")).toBeGreaterThan(anchorDue);
		expect(byId.get(running.id)).toMatchObject({ enabled: 1, status: "running", nextDueAt: originalRunningDue });
		expect(byId.get(paused.id)).toMatchObject({ enabled: 0, status: "idle", nextDueAt: null });
		expect(byId.get(other.id)).toMatchObject({ nextDueAt: originalOtherDue });
		expect(payload.data.spread.bots.find((bot) => bot.id === anchor.id)?.nextDueAt).toBe(byId.get(anchor.id)?.nextDueAt);
	});

	it("proxies spread tick requests to the agent runtime service", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const proxied: { method?: string; path?: string; userId?: string | null } = {};
		const response = await spreadBotTicksRoute(
			contextFor<typeof spreadBotTicksRoute>(
				jsonRequest("http://example.com/api/me/bots/spread-ticks", "POST", {}, cookie),
				{},
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							proxied.method = request.method;
							proxied.path = new URL(request.url).pathname;
							proxied.userId = request.headers.get("x-bickr-user-id");
							return Response.json({
								ok: true,
								data: {
									spread: {
										bots: [],
										scheduled: [],
										skipped: { paused: 0, running: 0 },
										usedApproximateHorizon: false,
									},
								},
							});
						},
					} as unknown as Fetcher,
				},
			),
		);

		expect(response.status).toBe(200);
		expect(proxied).toEqual({
			method: "POST",
			path: `/users/${userId}/bots/spread-ticks`,
			userId,
		});
	});

		it("proxies prompt context budget requests to the agent runtime service", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
		const createResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "budget-sage",
						displayName: "Budget Sage",
						shortBio: "Counts context.",
						prompt: "Stay inside the window.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const created = (await createResponse.json()) as { data: { bot: BotBody } };
		const proxied: { body?: unknown; path?: string; userId?: string | null } = {};
		const response = await contextBudgetRoute(
			contextFor<typeof contextBudgetRoute>(
				jsonRequest(
					`http://example.com/api/me/bots/${created.data.bot.id}/runtime/context-budget`,
					"POST",
					{
						prompt: "Stay inside the larger window.",
						tickSettings: { contextWindowTokens: 64_000 },
					},
					cookie,
				),
				{ botId: created.data.bot.id },
				{
					AGENT_RUNTIME: {
						fetch: async (request: Request) => {
							proxied.path = new URL(request.url).pathname;
							proxied.userId = request.headers.get("x-bickr-user-id");
							proxied.body = await request.json();
							return Response.json({
								ok: true,
								data: {
									budget: {
										botId: created.data.bot.id,
										cached: false,
										contextWindowTokens: 64_000,
										effectiveModel: "openrouter/auto",
										fingerprint: "budget-test",
										fixedSystemTokens: 1_000,
										minimumCompactedPromptOverageTokens: 0,
										minimumCompactedPromptTokens: 2_000,
										nextCompactionTokens: 58_000,
										overBudgetTokens: 0,
										personaPromptTokens: 100,
										providerBaseUrl: "https://openrouter.ai/api/v1",
										remainingLoopTokens: 60_400,
										responseReserveTokens: providerContextCompletionReserveTokens,
										totalReservedTokens: 3_600,
									},
								},
							});
						},
					} as unknown as Fetcher,
				},
			),
		);

		expect(response.status).toBe(200);
		expect(proxied.path).toBe(`/bots/${created.data.bot.id}/context-budget`);
		expect(proxied.userId).toBeTruthy();
		expect(proxied.body).toMatchObject({
			prompt: "Stay inside the larger window.",
			tickSettings: { contextWindowTokens: 64_000 },
			});
		});

		it("proxies cached prompt context budget reads to the agent runtime service", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
			const createResponse = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/bots",
						"POST",
						{
							handle: "cached-budget-sage",
							displayName: "Cached Budget Sage",
							shortBio: "Remembers context counts.",
							prompt: "Stay inside the window.",
						},
						cookie,
					),
					{ worldHandle: "patch-notes" },
				),
			);
			const created = (await createResponse.json()) as { data: { bot: BotBody } };
			const proxied: { path?: string; method?: string; userId?: string | null } = {};
			const response = await contextBudgetGetRoute(
				contextFor<typeof contextBudgetGetRoute>(
					new Request(`http://example.com/api/me/bots/${created.data.bot.id}/runtime/context-budget`, {
						headers: { cookie },
					}),
					{ botId: created.data.bot.id },
					{
						AGENT_RUNTIME: {
							fetch: async (request: Request) => {
								proxied.path = new URL(request.url).pathname;
								proxied.method = request.method;
								proxied.userId = request.headers.get("x-bickr-user-id");
								return Response.json({ ok: true, data: { budget: null } });
							},
						} as unknown as Fetcher,
					},
				),
			);

			expect(response.status).toBe(200);
			expect(proxied).toMatchObject({
				method: "GET",
				path: `/bots/${created.data.bot.id}/context-budget`,
			});
			expect(proxied.userId).toBeTruthy();
		});

		it("preserves loop message and monitor query parameters when proxying runtime requests", async () => {
			const cookie = await authCookie();
			const proxiedUrls: URL[] = [];
			const envOverride = {
				AGENT_RUNTIME: {
					fetch: async (request: Request) => {
						proxiedUrls.push(new URL(request.url));
						return Response.json({
							ok: true,
							data: {
								messages: [],
								page: { currentPage: 1, pageCount: 1, pages: [], compactionPageBySeq: {} },
							},
						});
					},
				} as unknown as Fetcher,
			};

			await runtimeMessagesRoute(
				contextFor<typeof runtimeMessagesRoute>(
					new Request("http://example.com/api/me/bots/bot-query/runtime/messages?page=3&after=42", {
						headers: { cookie },
					}),
					{ botId: "bot-query" },
					envOverride,
				),
			);
			await runtimeMonitorRoute(
				contextFor<typeof runtimeMonitorRoute>(
					new Request("http://example.com/api/me/bots/bot-query/runtime/monitor?afterEvent=12&afterMessage=34", {
						headers: { cookie },
					}),
					{ botId: "bot-query" },
					envOverride,
				),
			);

			expect(proxiedUrls[0]?.pathname).toBe("/bots/bot-query/messages");
			expect(proxiedUrls[0]?.searchParams.get("page")).toBe("3");
			expect(proxiedUrls[0]?.searchParams.get("after")).toBe("42");
			expect(proxiedUrls[1]?.pathname).toBe("/bots/bot-query/monitor");
			expect(proxiedUrls[1]?.searchParams.get("afterEvent")).toBe("12");
			expect(proxiedUrls[1]?.searchParams.get("afterMessage")).toBe("34");
		});

		it("computes and caches prompt context budgets from mocked provider usage", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
		const createResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "count-sage",
						language: testLanguage,
						displayName: "Count Sage",
						shortBio: "Measures prompts.",
						prompt: "Stay brief.",
						inferenceSettings: {
							baseUrl: "https://provider.example/v1",
							model: "provider/test-model",
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		const created = (await createResponse.json()) as { data: { bot: BotBody } };
		const promptTokens = [200, 260, 260, 210, 285, 285, 205, 265, 265];
		const calls: Array<{ content: string }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			fetchPromptTokenProbeUsage: async (_settings: unknown, messages: Array<{ content?: string | null }>) => {
				calls.push({ content: messages[0]?.content ?? "" });
				const promptTokenCount = promptTokens.shift() ?? 999;
				return {
					promptTokens: promptTokenCount,
					completionTokens: 1,
					totalTokens: promptTokenCount + 1,
					cachedTokens: 0,
					reasoningTokens: 0,
					cost: null,
					raw: { prompt_tokens: promptTokenCount, completion_tokens: 1, total_tokens: promptTokenCount + 1 },
				};
			},
			state: {
				storage: {
					sql: memoryRuntimeSql(),
				},
			},
			textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
		});
		const promptContextBudget = (BotRuntime.prototype as unknown as {
			promptContextBudget: (botId: string, input: unknown) => Promise<{
				cached: boolean;
				fixedSystemTokens: number;
				minimumCompactedPromptOverageTokens: number;
				minimumCompactedPromptTokens: number;
				nextCompactionTokens: number;
				personaPromptTokens: number;
				remainingLoopTokens: number;
				responseReserveTokens: number;
				worldPromptTokens: number;
			}>;
		}).promptContextBudget.bind(runtime);
		const cachedPromptContextBudget = (BotRuntime.prototype as unknown as {
			cachedPromptContextBudget: (botId: string) => Promise<{
				cached: boolean;
				fixedSystemTokens: number;
				personaPromptTokens: number;
				remainingLoopTokens: number;
				worldPromptTokens: number;
			} | null>;
		}).cachedPromptContextBudget.bind(runtime);

		const first = await promptContextBudget(created.data.bot.id, {
			prompt: "Stay brief.",
			tickSettings: { contextWindowTokens: 15_000 },
		});
		expect(first).toMatchObject({
			cached: false,
			fixedSystemTokens: 200,
			minimumCompactedPromptOverageTokens: expect.any(Number),
			minimumCompactedPromptTokens: expect.any(Number),
			nextCompactionTokens: expect.any(Number),
			personaPromptTokens: 60,
			worldPromptTokens: 0,
			remainingLoopTokens: 15_000 - 200 - 60 - providerContextCompletionReserveTokens,
			responseReserveTokens: providerContextCompletionReserveTokens,
		});
		const defaultLoopRequest = providerChatCompletionRequest(
			{ baseUrl: "https://provider.example/v1", model: "provider/test-model", temperature: 0.2 },
			[{ role: "user", content: "hello" }],
			[],
		);
		expect(first.responseReserveTokens).toBe(defaultLoopRequest.max_completion_tokens);
		expect(calls).toHaveLength(3);
		expect(calls[0]?.content).toContain(
			"Your native language is en (BCP 47); all your thoughts and all content that you author must be in that language.",
		);
		expect(calls[0]?.content).not.toContain("Stay brief.");
		expect(calls[1]?.content).toContain("Stay brief.");
		expect(calls[2]?.content).toContain("Stay brief.");
		expect(calls[2]?.content).not.toContain("Setting:");

		const second = await promptContextBudget(created.data.bot.id, {
			prompt: "Stay brief.",
			tickSettings: { contextWindowTokens: 15_000 },
		});
		expect(second.cached).toBe(true);
		expect(second.personaPromptTokens).toBe(60);
		expect(second.worldPromptTokens).toBe(0);
		expect(calls).toHaveLength(3);

		const cachedCurrent = await cachedPromptContextBudget(created.data.bot.id);
		expect(cachedCurrent).toMatchObject({
			cached: true,
			fixedSystemTokens: 200,
			personaPromptTokens: 60,
			worldPromptTokens: 0,
		});
		expect(calls).toHaveLength(3);

		const changed = await promptContextBudget(created.data.bot.id, {
			prompt: "Stay brief with exact counts.",
			tickSettings: { contextWindowTokens: 15_000 },
		});
		expect(changed.cached).toBe(false);
		expect(calls).toHaveLength(6);

		const languageSettingChanged = await promptContextBudget(created.data.bot.id, {
			includeLanguageInSystemPrompt: false,
			prompt: "Stay brief.",
			tickSettings: { contextWindowTokens: 15_000 },
		});
		expect(languageSettingChanged.cached).toBe(false);
		expect(calls).toHaveLength(9);
		expect(calls[6]?.content).not.toContain("Your native language is en");
	});

	it("allows bot prompts up to 64000 characters and rejects longer prompts", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const exactLimit = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "long-prompt",
						displayName: "Long Prompt",
						shortBio: "Uses the full prompt limit.",
						prompt: "x".repeat(64_000),
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(exactLimit.status).toBe(201);

		const tooLong = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "too-long-prompt",
						displayName: "Too Long Prompt",
						shortBio: "Should be rejected.",
						prompt: "x".repeat(64_001),
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(tooLong.status).toBe(400);
		expect(await tooLong.json()).toMatchObject({
			ok: false,
			message: "Prompt must be 64000 characters or fewer.",
		});
	});

	it("validates OpenRouter server tool settings", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);

		const validResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "tool-smith",
						displayName: "Tool Smith",
						shortBio: "Checks settings carefully.",
						prompt: "Keep your tools tidy.",
						toolSettings: {
							openRouter: {
								webSearch: {
									enabled: false,
									allowedDomains: [],
								},
							},
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(validResponse.status).toBe(201);
		const valid = (await validResponse.json()) as { data: { bot: BotBody } };
		expect(valid.data.bot.toolSettings).toEqual({});

		const enabledResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "tool-toggle",
						displayName: "Tool Toggle",
						shortBio: "Checks disabling.",
						prompt: "Keep your tools easy to switch off.",
						toolSettings: {
							openRouter: {
								datetime: { enabled: true },
								webSearch: { enabled: true },
								webFetch: { enabled: true },
							},
						},
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(enabledResponse.status).toBe(201);
		const enabled = (await enabledResponse.json()) as { data: { bot: BotBody } };
		expect(enabled.data.bot.toolSettings).toMatchObject({
			openRouter: {
				datetime: { enabled: true },
				webSearch: { enabled: true },
				webFetch: { enabled: true },
			},
		});

		const disabledResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${enabled.data.bot.id}`,
					"PATCH",
					{
						toolSettings: {
							openRouter: {
								datetime: { enabled: false, timezone: null },
								webSearch: {
									enabled: false,
									engine: null,
									maxResults: null,
									maxTotalResults: null,
									searchContextSize: null,
									userLocation: null,
									allowedDomains: null,
									excludedDomains: null,
								},
								webFetch: {
									enabled: false,
									engine: null,
									maxUses: null,
									maxContentTokens: null,
									allowedDomains: null,
									blockedDomains: null,
								},
							},
						},
					},
					cookie,
				),
				{ botId: enabled.data.bot.id },
			),
		);
		expect(disabledResponse.status, await disabledResponse.clone().text()).toBe(200);
		const disabled = (await disabledResponse.json()) as { data: { bot: BotBody } };
		expect(disabled.data.bot.toolSettings).toEqual({});

		for (const toolSettings of [
			{ openRouter: { datetime: { enabled: true, timezone: "Mars/Olympus" } } },
			{ openRouter: { webSearch: { enabled: true, engine: "ask-jeeves" } } },
			{ openRouter: { webSearch: { enabled: true, maxResults: 26 } } },
			{ openRouter: { webSearch: { enabled: true, searchContextSize: "massive" } } },
			{ openRouter: { webSearch: { enabled: true, allowedDomains: ["example.com", ""] } } },
			{ openRouter: { webFetch: { enabled: true, engine: "wget" } } },
			{ openRouter: { webFetch: { enabled: true, maxUses: 0 } } },
		]) {
			const response = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/bots",
						"POST",
						{
							handle: `bad-tools-${crypto.randomUUID().slice(0, 8)}`,
							displayName: "Bad Tools",
							shortBio: "Invalid configuration.",
							prompt: "This should be rejected.",
							toolSettings,
						},
						cookie,
					),
					{ worldHandle: "patch-notes" },
				),
			);
			expect(response.status).toBe(400);
		}
	});

	it("edits user profile defaults and redacts inference API keys", async () => {
		const cookie = await authCookie();
		const profileResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						handle: "octo-admin",
						displayName: "Octo Admin",
						inferenceSettings: {
							openRouterApiKey: "sk-or-user-secret",
							model: "anthropic/claude-3.5-haiku",
							compactionMode: "tool_call",
							translation: {
								enabled: true,
								model: "openai/gpt-4o-mini",
								toolCalls: "railroad",
							},
							supportsPrefill: false,
							toolCalls: "at_will",
							providerRouting: {
								max_price: {
									prompt: 0.25,
									completion: 0.75,
								},
							},
							temperature: 0.7,
							topK: 40,
							topP: 0.92,
							minP: 0.04,
							frequencyPenalty: -0.35,
							presence_penalty: 0.65,
							repetition_penalty: 1.05,
						},
					},
					cookie,
				),
			),
		);
		expect(profileResponse.status).toBe(200);
		const profilePayload = (await profileResponse.json()) as {
			data: { profile: { handle: string; displayName: string; inferenceSettings: Record<string, unknown> } };
		};
		expect(profilePayload.data.profile).toMatchObject({
			handle: "octo-admin",
			displayName: lt("Octo Admin"),
			profileComplete: true,
				inferenceSettings: {
					openRouterApiKeySet: true,
					model: "anthropic/claude-3.5-haiku",
					compactionMode: "tool_call",
					translation: {
						enabled: true,
						model: "openai/gpt-4o-mini",
						prompt: unspecifiedLt(defaultTranslationPrompt),
						toolCalls: "railroad",
					},
					supportsPrefill: false,
					toolCalls: "at_will",
				providerRouting: {
					max_price: {
						prompt: 0.25,
						completion: 0.75,
					},
				},
				temperature: 0.7,
				topK: 40,
				topP: 0.92,
				minP: 0.04,
				frequencyPenalty: -0.35,
				presencePenalty: 0.65,
				repetitionPenalty: 1.05,
			},
		});
		expect(profilePayload.data.profile.inferenceSettings.openRouterApiKey).toBeUndefined();

		for (const inferenceSettings of [
			{ frequencyPenalty: -2.1 },
			{ presence_penalty: 2.1 },
			{ repetitionPenalty: 2.1 },
			{ translation: { toolCalls: "at_will" } },
			{ compactionMode: "cache_friendly" },
			{ cacheFriendlyCompaction: "yes" },
			{ supportsPrefill: "yes" },
			{ providerRouting: "openai" },
			{ providerRouting: ["openai"] },
			{ providerRouting: { note: "x".repeat(maxProviderRoutingJsonLength) } },
		]) {
			const invalidPenaltyResponse = await patchProfile(
				contextFor<typeof patchProfile>(
					jsonRequest(
						"http://example.com/api/me/profile",
						"PATCH",
						{ inferenceSettings },
						cookie,
					),
				),
			);
			expect(invalidPenaltyResponse.status).toBe(400);
		}

		const getProfileResponse = await getProfile(
			contextFor<typeof getProfile>(new Request("http://example.com/api/me/profile", { headers: { cookie } })),
		);
		expect(await getProfileResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					handle: "octo-admin",
					inferenceSettings: { openRouterApiKeySet: true },
				},
			},
		});

		const clearedPenaltiesResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							frequencyPenalty: null,
							presencePenalty: null,
							providerRouting: null,
							repetitionPenalty: null,
						},
					},
					cookie,
				),
			),
		);
		expect(clearedPenaltiesResponse.status).toBe(200);
		const clearedPenaltiesPayload = (await clearedPenaltiesResponse.json()) as {
			data: { profile: { inferenceSettings: Record<string, unknown> } };
		};
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.frequencyPenalty).toBeUndefined();
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.presencePenalty).toBeUndefined();
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.providerRouting).toBeUndefined();
		expect(clearedPenaltiesPayload.data.profile.inferenceSettings.repetitionPenalty).toBeUndefined();

		const sessionResponse = await session(
			contextFor<typeof session>(new Request("http://example.com/api/session", { headers: { cookie } })),
		);
		expect(await sessionResponse.json()).toMatchObject({
			ok: true,
			data: { user: { handle: "octo-admin", displayName: lt("Octo Admin"), profileComplete: true } },
		});

		const noKeyModelResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							openRouterApiKey: null,
							baseUrl: null,
							model: "anthropic/claude-3.5-haiku",
							translation: {
								model: "openai/gpt-4o-mini",
							},
						},
					},
					cookie,
				),
			),
		);
		expect(noKeyModelResponse.status).toBe(200);
		const noKeyModelPayload = (await noKeyModelResponse.json()) as {
			data: { profile: { inferenceSettings: Record<string, unknown> } };
			};
			expect(noKeyModelPayload.data.profile.inferenceSettings.model).toBeUndefined();
			expect(noKeyModelPayload.data.profile.inferenceSettings.translation).toMatchObject({
				enabled: true,
				prompt: unspecifiedLt(defaultTranslationPrompt),
			});
			expect((noKeyModelPayload.data.profile.inferenceSettings.translation as Record<string, unknown>).model).toBeUndefined();
		expect(noKeyModelPayload.data.profile.inferenceSettings.openRouterApiKeySet).toBeUndefined();

		const customBaseModelResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							baseUrl: "http://localhost:11434/v1",
							model: "local/model",
							translation: {
								enabled: true,
								model: "local/translator",
								prompt: "Translate into Scots.",
							},
						},
					},
					cookie,
				),
			),
		);
		expect(customBaseModelResponse.status, await customBaseModelResponse.clone().text()).toBe(200);
		expect(await customBaseModelResponse.json()).toMatchObject({
			ok: true,
			data: {
				profile: {
					inferenceSettings: {
						baseUrl: "http://localhost:11434/v1",
						model: "local/model",
							translation: {
								enabled: true,
								model: "local/translator",
								prompt: lt("Translate into Scots."),
							},
					},
				},
			},
		});
	});

	it("translates text through the authenticated profile translation route", async () => {
		const cookie = await authCookie();
		const profileResponse = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							openRouterApiKey: "sk-or-translation-secret",
							translation: {
								enabled: true,
								model: "openai/gpt-4o-mini",
								prompt: "Translate into French.",
								providerRouting: {
									max_price: {
										prompt: 0.2,
										completion: 0.4,
									},
								},
							},
						},
					},
					cookie,
				),
			),
		);
			expect(profileResponse.status).toBe(200);
			const profilePayload = (await profileResponse.json()) as { data: { profile: UserProfile } };
			const providerRequests: Request[] = [];
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const request = new Request(input, init);
				providerRequests.push(request);
				return Response.json({
					choices: [{
						message: {
							tool_calls: [{
								id: "call_translation",
								type: "function",
								function: { name: "save_translation", arguments: JSON.stringify({ translation: "Bonjour." }) },
							}],
						},
					}],
				});
			});
		try {
			const response = await translateText(
				contextFor<typeof translateText>(
					jsonRequest("http://example.com/api/me/translate", "POST", { text: "Hello." }, cookie),
				),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				data: { translation: "Bonjour." },
			});

			const serviceRequest = jsonRequest(
				`https://internal.bickr/users/${encodeURIComponent(profilePayload.data.profile.id)}/translate`,
				"POST",
				{ text: "Hello." },
			);
			serviceRequest.headers.set("x-bickr-user-id", profilePayload.data.profile.id);
			const serviceResponse = await agentRuntimeWorker.fetch(
				serviceRequest as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
				} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
			);
			expect(serviceResponse.status).toBe(200);
			expect(await serviceResponse.json()).toMatchObject({
				ok: true,
				data: { translation: "Bonjour." },
			});

			expect(providerRequests).toHaveLength(2);
			expect(providerRequests[0]?.headers.get("authorization")).toBe("Bearer sk-or-translation-secret");
			const providerBody = await providerRequests[0]!.json() as Record<string, unknown>;
			expect(providerBody).toMatchObject({
				model: "openai/gpt-4o-mini",
				provider: {
					max_price: {
						prompt: 0.2,
						completion: 0.4,
					},
					},
					stream: false,
					temperature: 0,
					tool_choice: "required",
				});
				expect((providerBody.tools as Array<{ function?: { name?: string } }>)[0]?.function?.name).toBe("save_translation");
			} finally {
				fetchSpy.mockRestore();
			}
		});

	it("creates, edits, lists, and deletes world-scoped bot groups with owned and other-owned bots", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const mine = await createBotForTest(cookie, "group-mine");
		const otherCookie = await authCookieFor({ subject: "222", login: "group-other-owner", displayName: "Group Other Owner" });
		const otherOwned = await createBotInWorld(otherCookie, "patch-notes", {
			handle: "group-other",
			displayName: "Group Other",
			shortBio: "Other owned group member.",
			prompt: "I can be grouped by someone else.",
		});

		const createResponse = await createBotGroupRoute(
			contextFor<typeof createBotGroupRoute>(
				jsonRequest("http://example.com/api/worlds/patch-notes/groups", "POST", { customTitle: "" }, cookie),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(createResponse.status).toBe(201);
		const created = (await createResponse.json()) as { data: { group: BotGroupSummary } };
		expect(created.data.group).toMatchObject({
			customTitle: null,
			displayTitle: "Empty group",
			titleSource: "members",
			bots: [],
		});

		const addResponse = await addBotGroupMembersRoute(
			contextFor<typeof addBotGroupMembersRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots`,
					"POST",
					{ botIds: [otherOwned.id, mine.id, mine.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(addResponse.status).toBe(200);
		const added = (await addResponse.json()) as { data: { group: BotGroupSummary } };
		expect(added.data.group.bots.map((bot) => bot.handle)).toEqual(["group-mine", "group-other"]);
		expect(added.data.group.displayTitle).toBe("u/group-mine, u/group-other");

		const titleResponse = await patchBotGroupRoute(
			contextFor<typeof patchBotGroupRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}`,
					"PATCH",
					{ customTitle: "Favorites" },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		const titled = (await titleResponse.json()) as { data: { group: BotGroupSummary } };
		expect(titled.data.group).toMatchObject({
			customTitle: lt("Favorites"),
			displayTitle: "Favorites",
			titleSource: "custom",
		});

		const generatedTitleResponse = await patchBotGroupRoute(
			contextFor<typeof patchBotGroupRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}`,
					"PATCH",
					{ customTitle: "   " },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		const generated = (await generatedTitleResponse.json()) as { data: { group: BotGroupSummary } };
		expect(generated.data.group).toMatchObject({
			customTitle: null,
			displayTitle: "u/group-mine, u/group-other",
			titleSource: "members",
		});

		const removeResponse = await removeBotGroupMemberRoute(
			contextFor<typeof removeBotGroupMemberRoute>(
				new Request(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots/${otherOwned.id}`,
					{ method: "DELETE", headers: { cookie } },
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id, botId: otherOwned.id },
			),
		);
		const removed = (await removeResponse.json()) as { data: { group: BotGroupSummary } };
		expect(removed.data.group.bots.map((bot) => bot.handle)).toEqual(["group-mine"]);
		expect(removed.data.group.displayTitle).toBe("u/group-mine");

		const listResponse = await worldBotGroups(
			contextFor<typeof worldBotGroups>(
				new Request("http://example.com/api/worlds/patch-notes/groups", { headers: { cookie } }),
				{ worldHandle: "patch-notes" },
			),
		);
		const listed = (await listResponse.json()) as { data: { groups: BotGroupSummary[] } };
		expect(listed.data.groups.map((group) => group.id)).toEqual([created.data.group.id]);

		const deleteResponse = await deleteBotGroupRoute(
			contextFor<typeof deleteBotGroupRoute>(
				new Request(`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}`, {
					method: "DELETE",
					headers: { cookie },
				}),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(deleteResponse.status).toBe(200);
		const emptyListResponse = await worldBotGroups(
			contextFor<typeof worldBotGroups>(
				new Request("http://example.com/api/worlds/patch-notes/groups", { headers: { cookie } }),
				{ worldHandle: "patch-notes" },
			),
		);
		const emptyList = (await emptyListResponse.json()) as { data: { groups: BotGroupSummary[] } };
		expect(emptyList.data.groups).toEqual([]);
	});

	it("rejects wrong-world group members and hides groups from other users", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createWorldForTest(cookie, "other-groups", "Other Groups");
		const owned = await createBotForTest(cookie, "group-owned");
		const wrongWorld = await createBotInWorld(cookie, "other-groups", { handle: "wrong-world-group-bot" });
		const createResponse = await createBotGroupRoute(
			contextFor<typeof createBotGroupRoute>(
				jsonRequest("http://example.com/api/worlds/patch-notes/groups", "POST", { customTitle: null }, cookie),
				{ worldHandle: "patch-notes" },
			),
		);
		const created = (await createResponse.json()) as { data: { group: BotGroupSummary } };

		const wrongWorldAdd = await addBotGroupMembersRoute(
			contextFor<typeof addBotGroupMembersRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots`,
					"POST",
					{ botIds: [wrongWorld.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(wrongWorldAdd.status).toBe(400);

		const otherCookie = await authCookieFor({ subject: "333", login: "group-viewer", displayName: "Group Viewer" });
		const otherList = await worldBotGroups(
			contextFor<typeof worldBotGroups>(
				new Request("http://example.com/api/worlds/patch-notes/groups", { headers: { cookie: otherCookie } }),
				{ worldHandle: "patch-notes" },
			),
		);
		const otherGroups = (await otherList.json()) as { data: { groups: BotGroupSummary[] } };
		expect(otherGroups.data.groups).toEqual([]);

		const otherPatch = await patchBotGroupRoute(
			contextFor<typeof patchBotGroupRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}`,
					"PATCH",
					{ customTitle: "Not mine" },
					otherCookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(otherPatch.status).toBe(404);

		const ownerAdd = await addBotGroupMembersRoute(
			contextFor<typeof addBotGroupMembersRoute>(
				jsonRequest(
					`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots`,
					"POST",
					{ botIds: [owned.id] },
					cookie,
				),
				{ worldHandle: "patch-notes", groupId: created.data.group.id },
			),
		);
		expect(ownerAdd.status).toBe(200);
		const otherRemove = await removeBotGroupMemberRoute(
			contextFor<typeof removeBotGroupMemberRoute>(
				new Request(`http://example.com/api/worlds/patch-notes/groups/${created.data.group.id}/bots/${owned.id}`, {
					method: "DELETE",
					headers: { cookie: otherCookie },
				}),
				{ worldHandle: "patch-notes", groupId: created.data.group.id, botId: owned.id },
			),
		);
		expect(otherRemove.status).toBe(404);
	});
});
