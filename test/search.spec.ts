import {
	agentRuntimeWorker,
	authCookie,
	botById,
	contextFor,
	createBot,
	createBotForTest,
	createForum,
	createForumForTest,
	createThreadForTest,
	createWorld,
	deleteBot,
	deleteForumRoute,
	deleteSearchVector,
	deleteWorldRoute,
	describe,
	expect,
	fakeSearchBindings,
	forums,
	it,
	jsonRequest,
	listForums,
	lt,
	normalizeSearchFilters,
	patchBot,
	patchForum,
	patchWorld,
	reindexSearchVectors,
	searchEntitiesSemantic,
	searchEntitiesText,
	searchRoute,
	searchSuggestRoute,
	seedWorld,
	testEnv,
	upsertBotSearchVector,
	upsertForumSearchVector,
	upsertWorldSearchVector,
	worlds,
} from "./helpers/index-harness";
import type {
	BotBody,
	SearchResponse,
	TestForum,
	WorldSummary,
} from "./helpers/index-harness";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import { parseSearchMode } from "@bickr/shared/search";
import { kvKeys } from "@bickr/shared/storage";

describe("Search", () => {

	it("creates and lists worlds and forums with duplicate conflicts", async () => {
		const cookie = await authCookie();
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "patch-notes", name: "Patch Notes", description: "Change discussion" },
					cookie,
				),
			),
		);
		expect(worldResponse.status).toBe(201);
		expect(await worldResponse.json()).toMatchObject({
			ok: true,
			data: { world: { handle: "patch-notes" } },
		});

		const duplicateWorld = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "patch-notes", name: "Patch Notes", description: "Change discussion" },
					cookie,
				),
			),
		);
		expect(duplicateWorld.status).toBe(409);

		const worldsResponse = await worlds(
			contextFor<typeof worlds>(new Request("http://example.com/api/worlds")),
		);
		expect(await worldsResponse.json()).toMatchObject({
			ok: true,
			data: { worlds: [{ handle: "patch-notes", forumCount: 1, botCount: 0 }] },
		});
		const initialForums = await listForums(testEnv.BICKR_D1, "patch-notes");
		expect(initialForums.find((forum) => forum.handle === "intro")).toMatchObject({
			description: lt("Introductions, first threads, and orientation for new participants in this world."),
		});

		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums",
					"POST",
					{ handle: "announcements", description: "Official updates" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(forumResponse.status).toBe(201);

		const duplicateForum = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/forums",
					"POST",
					{ handle: "announcements", description: "Official updates" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(duplicateForum.status).toBe(409);

		const worldsAfterForumResponse = await worlds(
			contextFor<typeof worlds>(new Request("http://example.com/api/worlds")),
		);
		expect(await worldsAfterForumResponse.json()).toMatchObject({
			ok: true,
			data: { worlds: [{ handle: "patch-notes", forumCount: 2, botCount: 0 }] },
		});

		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/bots",
					"POST",
					{
						handle: "release-sage",
						displayName: "Release Sage",
						shortBio: "Summarizes release discussions.",
						prompt: "Track release notes and summarize changes.",
					},
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(botResponse.status).toBe(201);

		const worldsAfterBotResponse = await worlds(
			contextFor<typeof worlds>(new Request("http://example.com/api/worlds")),
		);
		expect(await worldsAfterBotResponse.json()).toMatchObject({
			ok: true,
			data: { worlds: [{ handle: "patch-notes", forumCount: 2, botCount: 1 }] },
		});

		const forumsResponse = await forums(
			contextFor<typeof forums>(
				new Request("http://example.com/api/worlds/patch-notes/forums"),
				{ worldHandle: "patch-notes" },
			),
		);
		const forumsPayload = (await forumsResponse.json()) as { ok: true; data: { forums: Array<{ handle: string }> } };
		expect(forumsPayload.ok).toBe(true);
		expect(forumsPayload.data.forums.map((forum) => forum.handle)).toEqual(expect.arrayContaining(["announcements", "intro"]));
	});

	it("searches active worlds, forums, and bots by default FTS, explicit substring, suggestions, escaped substrings, globs, and exact filters", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "literal-percent", name: "100% Pure", description: "Literal percent world." },
					cookie,
				),
			),
		);
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "literal-number", name: "1000 Pure", description: "Literal number world." },
					cookie,
				),
			),
		);
		await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "body-match-lab", name: "Body Match Lab", description: "Mentions release-sage exactly in the description." },
					cookie,
				),
			),
		);
		const forum = await createForumForTest(cookie, "release-room");
		const bot = await createBotForTest(cookie, "release-sage");
		await createThreadForTest(forum.id, bot.id, "Release notes", "Release notes from u/release-sage.");

		const suggestions = await searchSuggestRoute(
			contextFor<typeof searchSuggestRoute>(
				new Request("http://example.com/api/search/suggest?q=rel"),
			),
		);
		expect(suggestions.status, await suggestions.clone().text()).toBe(200);
		const suggestionsPayload = await suggestions.json() as { data: Pick<SearchResponse, "query" | "results"> };
		expect(suggestionsPayload.data.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual(
			expect.arrayContaining(["forum:release-room", "bot:release-sage"]),
		);
		expect(suggestionsPayload.data.results.every((result) => result.source === "fts")).toBe(true);
		expect(suggestionsPayload.data.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).not.toContain("forum:release-sage");

		expect(parseSearchMode(undefined)).toBe("fts");
		expect(parseSearchMode("text")).toBe("fts");

		const publicDefaultFts = await searchRoute(
			contextFor<typeof searchRoute>(
				new Request("http://example.com/api/search?q=release&types=forum,bot"),
			),
		);
		expect(publicDefaultFts.status, await publicDefaultFts.clone().text()).toBe(200);
		const publicDefaultFtsPayload = await publicDefaultFts.json() as { data: { search: SearchResponse } };
		const publicDefaultOrder = publicDefaultFtsPayload.data.search.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`);
		expect(publicDefaultFtsPayload.data.search.results.every((result) => result.source === "fts")).toBe(true);
		expect(publicDefaultOrder).toEqual(["bot:release-sage", "forum:release-room"]);

		const publicSubstring = await searchRoute(
			contextFor<typeof searchRoute>(
				new Request("http://example.com/api/search?q=release&mode=substring&types=forum,bot"),
			),
		);
		expect(publicSubstring.status, await publicSubstring.clone().text()).toBe(200);
		const publicSubstringPayload = await publicSubstring.json() as { data: { search: SearchResponse } };
		const publicSubstringOrder = publicSubstringPayload.data.search.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`);
		expect(publicSubstringPayload.data.search.results.every((result) => result.source === "substring")).toBe(true);
		expect(publicSubstringOrder).toEqual(["forum:release-room", "bot:release-sage"]);
		expect(new Set(publicSubstringOrder)).toEqual(new Set(publicDefaultOrder));

		const exactHandleFts = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "release-sage",
			types: ["world", "bot"],
		});
		expect(exactHandleFts.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`).slice(0, 2)).toEqual([
			"bot:release-sage",
			"world:body-match-lab",
		]);
		expect(exactHandleFts.results[0]?.score ?? 0).toBeGreaterThan(exactHandleFts.results[1]?.score ?? 0);

		const escaped = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "substring",
			query: "100%",
			types: ["world"],
		});
		expect(escaped.results.map((result) => result.type === "world" ? result.handle : "")).toEqual(["literal-percent"]);

		const glob = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "substring",
			query: "patch*notes",
			types: ["world"],
		});
		expect(glob.results.map((result) => result.type === "world" ? result.handle : "")).toEqual(["patch-notes"]);

		const literalWildcard = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "substring",
			query: "patch%notes",
			types: ["world"],
		});
		expect(literalWildcard.results).toEqual([]);

		const usernameFilteredWorld = await searchEntitiesText(testEnv.BICKR_D1, {
			...normalizeSearchFilters({ username: "u/release-sage" }),
			mode: "substring",
			query: "patch",
			types: ["world"],
		});
		expect(usernameFilteredWorld.results.map((result) => result.type === "world" ? result.handle : "")).toEqual(["patch-notes"]);

		const usernameFilteredForum = await searchEntitiesText(testEnv.BICKR_D1, {
			...normalizeSearchFilters({ username: "@release-sage" }),
			mode: "substring",
			query: "release",
			types: ["forum"],
		});
		expect(usernameFilteredForum.results.map((result) => result.type === "forum" ? result.handle : "")).toEqual(["release-room"]);
		expect(usernameFilteredForum.results[0]?.world.matched).toBe(false);

		const forumFilteredBot = await searchEntitiesText(testEnv.BICKR_D1, {
			...normalizeSearchFilters({ forum: "f/release-room" }),
			mode: "substring",
			query: "release",
			types: ["bot"],
		});
		expect(forumFilteredBot.results.map((result) => result.type === "bot" ? result.handle : "")).toEqual(["release-sage"]);

		const personalForumSearch = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "substring",
			query: "release-sage",
			types: ["forum"],
		});
		expect(personalForumSearch.results).toEqual([]);
	});

	it("supports FTS search, literal operator input, syntax-safe injection, and 20-result pagination", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		for (let index = 0; index < 21; index += 1) {
			const padded = String(index).padStart(2, "0");
			const response = await createForum(
				contextFor<typeof createForum>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/forums",
						"POST",
						{ handle: `pager-${padded}`, description: `Pagination needle ${padded}` },
						cookie,
					),
					{ worldHandle: "patch-notes" },
				),
			);
			expect(response.status, await response.clone().text()).toBe(201);
		}

		const firstPage = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			page: 1,
			query: "pagination",
			types: ["forum"],
		});
		expect(firstPage.total).toBe(21);
		expect(firstPage.results).toHaveLength(20);
		expect(firstPage.hasNextPage).toBe(true);
		expect(firstPage.results.every((result) => result.type === "forum" && !result.world.matched)).toBe(true);

		const multiTermQuery = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			page: 1,
			query: "Pagination needle",
			types: ["forum"],
		});
		expect(multiTermQuery.total).toBe(21);

		const literalOperatorQuery = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			page: 1,
			query: "Pagination OR needle",
			types: ["forum"],
		});
		expect(literalOperatorQuery.total).toBe(0);

		const secondPage = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			page: 2,
			query: "pagination",
			types: ["forum"],
		});
		expect(secondPage.results).toHaveLength(1);
		expect(secondPage.hasNextPage).toBe(false);

		const publicFts = await searchRoute(
			contextFor<typeof searchRoute>(
				new Request("http://example.com/api/search?q=pagination&mode=fts&types=forum"),
			),
		);
		expect(publicFts.status, await publicFts.clone().text()).toBe(200);
		const publicFtsPayload = await publicFts.json() as { data: { search: SearchResponse } };
		expect(publicFtsPayload.data.search.total).toBe(21);
		expect(publicFtsPayload.data.search.results).toHaveLength(20);

		for (const query of ['"', "*", "NEAR(", "(pagination", "-"]) {
			const invalid = await searchRoute(
				contextFor<typeof searchRoute>(
					new Request(`http://example.com/api/search?q=${encodeURIComponent(query)}&mode=fts&types=world`, { headers: { cookie } }),
				),
			);
			expect(invalid.status, await invalid.clone().text()).toBe(200);
			const invalidPayload = await invalid.json() as { data: { search: SearchResponse } };
			expect(invalidPayload.data.search.results).toEqual(expect.any(Array));
		}
	});

	it("keeps FTS rows current on world, forum, and bot rename and soft-delete paths", async () => {
		const cookie = await authCookie();
		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "index-lab", name: "Old Search Needle", description: "Old world search row." },
					cookie,
				),
			),
		);
		const worldPayload = await worldResponse.json() as { data: { world: WorldSummary } };
		const forumResponse = await createForum(
			contextFor<typeof createForum>(
				jsonRequest(
					"http://example.com/api/worlds/index-lab/forums",
					"POST",
					{ handle: "old-forum-needle", description: "Old forum search row." },
					cookie,
				),
				{ worldHandle: "index-lab" },
			),
		);
		const forumPayload = await forumResponse.json() as { data: { forum: TestForum } };
		const botResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/index-lab/bots",
					"POST",
					{
						handle: "old-bot-needle",
						displayName: "Old Bot Needle",
						shortBio: "Old bot search row.",
						prompt: "Stay concise.",
					},
					cookie,
				),
				{ worldHandle: "index-lab" },
			),
		);
		const botPayload = await botResponse.json() as { data: { bot: BotBody } };
		const oldMatches = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "old",
			types: ["world", "forum", "bot"],
		});
		expect(oldMatches.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual(
			expect.arrayContaining(["world:index-lab", "forum:old-forum-needle", "bot:old-bot-needle"]),
		);
		expect(oldMatches.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).not.toContain("forum:old-bot-needle");

		const worldPatch = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/index-lab",
					"PATCH",
					{ handle: "index-lab-new", name: "New Search Needle", description: "New world search row." },
					cookie,
				),
				{ worldHandle: "index-lab" },
			),
		);
		expect(worldPatch.status, await worldPatch.clone().text()).toBe(200);
		const forumPatch = await patchForum(
			contextFor<typeof patchForum>(
				jsonRequest(
					"http://example.com/api/worlds/index-lab-new/forums/old-forum-needle",
					"PATCH",
					{ handle: "new-forum-needle", description: "New forum search row." },
					cookie,
				),
				{ worldHandle: "index-lab-new", forumHandle: "old-forum-needle" },
			),
		);
		expect(forumPatch.status, await forumPatch.clone().text()).toBe(200);
		const botPatch = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${botPayload.data.bot.id}`,
					"PATCH",
					{ handle: "new-bot-needle", displayName: "New Bot Needle", shortBio: "New bot search row." },
					cookie,
				),
				{ botId: botPayload.data.bot.id },
			),
		);
		expect(botPatch.status, await botPatch.clone().text()).toBe(200);

		const afterRenameOld = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "old",
			types: ["world", "forum", "bot"],
		});
		expect(afterRenameOld.results.filter((result) => result.id === worldPayload.data.world.id || result.id === forumPayload.data.forum.id || result.id === botPayload.data.bot.id)).toEqual([]);
		const afterRenameNew = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "new",
			types: ["world", "forum", "bot"],
		});
		expect(afterRenameNew.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual(
			expect.arrayContaining(["world:index-lab-new", "forum:new-forum-needle", "bot:new-bot-needle"]),
		);

		const botDelete = await deleteBot(
			contextFor<typeof deleteBot>(
				new Request(`http://example.com/api/me/bots/${botPayload.data.bot.id}`, { method: "DELETE", headers: { cookie } }),
				{ botId: botPayload.data.bot.id },
			),
		);
		expect(botDelete.status, await botDelete.clone().text()).toBe(200);
		const forumDelete = await deleteForumRoute(
			contextFor<typeof deleteForumRoute>(
				new Request("http://example.com/api/worlds/index-lab-new/forums/new-forum-needle", { method: "DELETE", headers: { cookie } }),
				{ worldHandle: "index-lab-new", forumHandle: "new-forum-needle" },
			),
		);
		expect(forumDelete.status, await forumDelete.clone().text()).toBe(200);
		const worldDelete = await deleteWorldRoute(
			contextFor<typeof deleteWorldRoute>(
				new Request("http://example.com/api/worlds/index-lab-new", { method: "DELETE", headers: { cookie } }),
				{ worldHandle: "index-lab-new" },
			),
		);
		expect(worldDelete.status, await worldDelete.clone().text()).toBe(200);
		const afterDelete = await searchEntitiesText(testEnv.BICKR_D1, {
			mode: "fts",
			query: "new",
			types: ["world", "forum", "bot"],
		});
		expect(afterDelete.results.filter((result) => result.id === worldPayload.data.world.id || result.id === forumPayload.data.forum.id || result.id === botPayload.data.bot.id)).toEqual([]);
	});

	it("indexes and searches semantic entities with exact-filter hydration and score ordering", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "semantic-room");
		const bot = await createBotForTest(cookie, "semantic-sage");
		await createThreadForTest(forum.id, bot.id, "Semantic trail", "Semantic coverage post.");
		const publicSemantic = await searchRoute(
			contextFor<typeof searchRoute>(
				new Request("http://example.com/api/search?q=semantic%20coverage&mode=semantic&types=forum"),
			),
		);
		expect(publicSemantic.status).toBe(401);
		const worldResponse = await worlds(contextFor<typeof worlds>(new Request("http://example.com/api/worlds")));
		const worldPayload = await worldResponse.json() as { data: { worlds: WorldSummary[] } };
		const world = worldPayload.data.worlds.find((item) => item.handle === "patch-notes");
		const forumSummaries = await listForums(testEnv.BICKR_D1, "patch-notes");
		const forumSummary = forumSummaries.find((item) => item.id === forum.id);
		const personalForum = forumSummaries.find((item) => item.personalBotId === bot.id);
		const botDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		if (!world || !forumSummary || !personalForum) {
			throw new Error("Semantic fixture missing world or forum.");
		}

		const bindings = fakeSearchBindings();
		await upsertWorldSearchVector(bindings.env, world);
		await upsertForumSearchVector(bindings.env, forumSummary);
		await upsertBotSearchVector(bindings.env, botDocument);
		expect(bindings.upserted.map((item) => item.id)).toEqual([
			`world:${world.id}`,
			`forum:${forum.id}`,
			bot.id,
		]);
		expect(bindings.upserted.map((item) => item.metadata?.type)).toEqual(["world", "forum", "bot"]);
		await upsertForumSearchVector(bindings.env, personalForum);
		expect(bindings.upserted.map((item) => item.id)).toEqual([
			`world:${world.id}`,
			`forum:${forum.id}`,
			bot.id,
		]);
		expect(bindings.deleted).toContain(`forum:${personalForum.id}`);

		const reindex = await reindexSearchVectors(testEnv.BICKR_D1, {
			...bindings.env,
			BICKR_KV: testEnv.BICKR_KV,
		}, 20);
		expect(reindex.attempted).toBeGreaterThanOrEqual(3);
		expect(reindex.done).toBe(true);
		expect(reindex.budgetExhausted).toBe(false);
		expect(bindings.deleted).toContain(`forum:${personalForum.id}`);

		bindings.matches = [
			{ id: `world:${world.id}`, metadata: { entityId: world.id, type: "world" }, score: 0.5 },
			{ id: bot.id, metadata: { entityId: bot.id, type: "bot" }, score: 0.8 },
			{ id: `forum:${forum.id}`, metadata: { entityId: forum.id, type: "forum" }, score: 0.9 },
		];
		const semantic = await searchEntitiesSemantic(testEnv.BICKR_D1, bindings.env, {
			mode: "semantic",
			query: "semantic coverage",
			types: ["world", "forum", "bot"],
			...normalizeSearchFilters({ username: "semantic-sage" }),
		});
		expect(semantic.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual([
			"forum:semantic-room",
			"bot:semantic-sage",
			"world:patch-notes",
		]);
		expect(semantic.results.map((result) => result.score)).toEqual([0.9, 0.8, 0.5]);

		bindings.matches = [
			{ id: `forum:${personalForum.id}`, metadata: { entityId: personalForum.id, type: "forum" }, score: 0.99 },
			{ id: `forum:${forum.id}`, metadata: { entityId: forum.id, type: "forum" }, score: 0.9 },
		];
		const semanticForums = await searchEntitiesSemantic(testEnv.BICKR_D1, bindings.env, {
			mode: "semantic",
			query: "semantic coverage",
			types: ["forum"],
		});
		expect(semanticForums.results.map((result) => `${result.type}:${"handle" in result ? result.handle : ""}`)).toEqual(["forum:semantic-room"]);

		const serviceResponse = await agentRuntimeWorker.fetch(
			new Request("https://internal.bickr/search/entities?mode=semantic&q=semantic%20coverage&types=forum", {
				headers: {
					[internalServiceAuthHeader]: "test-internal-service-secret",
					"x-bickr-user-id": "semantic-test-user",
				},
			}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				AI: bindings.env.AI,
				BICKR_SEARCH_VECTORIZE: bindings.env.BICKR_SEARCH_VECTORIZE,
				INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
			} as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);
		expect(serviceResponse.status, await serviceResponse.clone().text()).toBe(200);
		expect(await serviceResponse.json()).toMatchObject({
			ok: true,
			data: { search: { results: [{ type: "forum", handle: "semantic-room" }] } },
		});

		const filteredOut = await searchEntitiesSemantic(testEnv.BICKR_D1, bindings.env, {
			mode: "semantic",
			query: "semantic coverage",
			types: ["world", "forum", "bot"],
			...normalizeSearchFilters({ forum: "missing-forum" }),
		});
		expect(filteredOut.results).toEqual([]);
	});

	it("round-trips current vector IDs and metadata through upsert, query, and delete", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "vector-round-trip");
		const botDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		const bindings = fakeSearchBindings();

		await upsertBotSearchVector(bindings.env, botDocument);
		const written = bindings.upserted[0];
		expect(written).toMatchObject({
			id: bot.id,
			metadata: { entityId: bot.id, type: "bot" },
		});
		if (!written) {
			throw new Error("Current-format vector fixture was not written.");
		}
		bindings.matches = [{ id: written.id, metadata: written.metadata, score: 0.77 }];

		const result = await searchEntitiesSemantic(testEnv.BICKR_D1, bindings.env, {
			mode: "semantic",
			query: "vector round trip",
			types: ["bot"],
		});
		expect(result.results).toMatchObject([{ type: "bot", handle: "vector-round-trip", score: 0.77 }]);

		await deleteSearchVector(bindings.env, "bot", bot.id);
		expect(bindings.deleted).toEqual([written.id]);
	});

	it("does not advertise semantic pages or an exact total beyond the Vectorize retrieval window", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bindings = fakeSearchBindings();
		const bots: BotBody[] = [];
		for (let index = 0; index < 55; index += 1) {
			bots.push(await createBotForTest(cookie, `semantic-window-${index}`));
		}
		bindings.matches = bots.map((bot, index) => ({
			id: bot.id,
			metadata: { entityId: bot.id, type: "bot" },
			score: 1 - index / 100,
		}));

		const beyondWindow = await searchEntitiesSemantic(testEnv.BICKR_D1, bindings.env, {
			mode: "semantic",
			page: 4,
			query: "semantic window",
			types: ["bot"],
		});

		expect(beyondWindow).toMatchObject({
			hasNextPage: false,
			page: 4,
			results: [],
			total: 50,
			totalRelation: "lower_bound",
		});
	});

	it("persists and resumes a stable full-pass vector reindex cursor", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "reindex-cursor");
		const bot = await createBotForTest(cookie, "reindex-cursor-bot");
		const bindings = fakeSearchBindings();
		const env = {
			...testEnv,
			...bindings.env,
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		};
		const firstResponse = await agentRuntimeWorker.fetch(
			new Request("https://internal.bickr/search/reindex-vectors?limit=1", {
				method: "POST",
				headers: {
					[internalServiceAuthHeader]: "test-internal-service-secret",
					"x-bickr-scheduler": "1",
				},
			}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			env as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);
		const firstPayload = await firstResponse.json() as {
			data: { reindex: { attempted: number; budgetExhausted: boolean; done: boolean } };
		};
		expect(firstResponse.status).toBe(200);
		expect(firstPayload.data.reindex).toEqual({ attempted: 1, budgetExhausted: true, done: false });
		expect(await testEnv.BICKR_KV.get(kvKeys.searchVectorReindexCursor, { type: "json" }))
			.toMatchObject({ afterKey: expect.stringMatching(/^0:/) });

		let attempted = firstPayload.data.reindex.attempted;
		let final = firstPayload.data.reindex;
		for (let invocation = 0; invocation < 20 && !final.done; invocation += 1) {
			final = await reindexSearchVectors(testEnv.BICKR_D1, env, 1);
			attempted += final.attempted;
		}
		expect(final).toMatchObject({ budgetExhausted: false, done: true });
		expect(attempted).toBeGreaterThanOrEqual(3);
		expect(await testEnv.BICKR_KV.get(kvKeys.searchVectorReindexCursor, { type: "json" })).toBeNull();
		expect(bindings.upserted.map((vector) => vector.id)).toEqual(expect.arrayContaining([
			`world:${forum.worldId}`,
			`forum:${forum.id}`,
			bot.id,
		]));

		const secondPass = await reindexSearchVectors(testEnv.BICKR_D1, env, 250);
		expect(secondPass).toMatchObject({ budgetExhausted: false, done: true });
		expect(secondPass.attempted).toBeGreaterThanOrEqual(3);
	});
});
