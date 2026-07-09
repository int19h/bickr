import {
	BotRuntime,
	cachedGlobalInferenceCostStats,
	capturingProviderUsageSql,
	centralUsageRecordForTest,
	describe,
	expect,
	fakeBotDocument,
	globalInferenceCostStatsCacheMaxAgeMs,
	globalInferenceCostStatsFromUsage,
	it,
	listOwnerBotTokenSpendSummaries,
	memoryInferenceSubmissionSql,
	promptContextBudgetCacheFingerprint,
	promptContextBudgetFromCounts,
	providerCompactionSummaryLimitsForChat,
	providerContextCompletionReserveTokens,
	providerLoopUsageRowForTest,
	providerUsageInputForTest,
	publicGlobalInferenceCostStats,
	recordBotInferenceUsageBatch,
	refreshGlobalInferenceCostStatsCacheIfStale,
	runtimeEvent,
	sseStream,
	testEnv,
	toolDefinitionsForProviderRound,
	vi,
} from "./helpers/index-harness";
import type {
	BotDocument,
	BotRuntimeEvent,
	BotTokenSpendSummary,
	BotTokenUsageStats,
	RecordProviderUsageInputForTest,
} from "./helpers/index-harness";

// TODO(#12): move next to module on extraction.
describe("Submissions and usage", () => {

	it("groups token usage breakdown by requested model and provider", () => {
		const rows = [
			{
				...providerLoopUsageRowForTest(1, "2026-05-01T00:00:00.000Z", 100),
				model: "provider/concrete-a",
				requested_model: "requested/model-a",
				response_model: "provider/concrete-a",
				provider_name: "Provider One",
				total_tokens: 150,
			},
			{
				...providerLoopUsageRowForTest(2, "2026-05-01T00:05:00.000Z", 200),
				model: "provider/concrete-b",
				requested_model: "requested/model-a",
				response_model: "provider/concrete-b",
				provider_name: "Provider One",
				total_tokens: 275,
				context_window_tokens: 32_000,
			},
			{
				...providerLoopUsageRowForTest(3, "2026-05-01T00:10:00.000Z", 50),
				model: "provider/concrete-c",
				requested_model: "requested/model-a",
				response_model: "provider/concrete-c",
				provider_name: "Provider Two",
				total_tokens: 75,
			},
			{
				...providerLoopUsageRowForTest(4, "2026-05-01T00:15:00.000Z", 500),
				requested_model: "requested/model-z",
				provider_name: null,
				total_tokens: 550,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			providerUsageRows: () => rows,
			tokenUsageChangeMarkers: () => [],
			latestActiveLoopCompactionBoundary: () => null,
			latestLoopProviderUsage: () => null,
		});
		const tokenUsageStats = (BotRuntime.prototype as unknown as {
			tokenUsageStats: (bot: BotDocument, now?: Date) => BotTokenUsageStats;
		}).tokenUsageStats.bind(runtime);

		const usage = tokenUsageStats(fakeBotDocument({ contextWindowTokens: 16_000 }), new Date("2026-05-01T01:00:00.000Z"));

		expect(usage.last7Days.totalTokens).toBe(1_050);
		expect(usage.models.map((model) => [model.model, model.providerName, model.totalTokens])).toEqual([
			["requested/model-a", "Provider One", 425],
			["requested/model-a", "Provider Two", 75],
		]);
	});

	type ProviderUsageRowForSpendTest = Omit<ReturnType<typeof providerLoopUsageRowForTest>, "cost" | "requested_model"> & {
		cost: number | null;
		requested_model: string;
	};

	it("summarizes token spend over 24h and the current model period", () => {
		const rows: ProviderUsageRowForSpendTest[] = [
			{
				...providerLoopUsageRowForTest(1, "2026-05-03T00:00:00.000Z", 100),
				requested_model: "requested/old",
				cost: 0.9,
			},
			{
				...providerLoopUsageRowForTest(2, "2026-05-06T00:00:00.000Z", 100),
				requested_model: "requested/current",
				cost: 0.5,
			},
			{
				...providerLoopUsageRowForTest(3, "2026-05-07T12:00:00.000Z", 100),
				requested_model: "requested/current",
				cost: 0.25,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {});
		const tokenSpendSummaryForRows = (BotRuntime.prototype as unknown as {
			tokenSpendSummaryForRows: (
				botId: string,
				currentModel: string,
				rows: ProviderUsageRowForSpendTest[],
				now?: Date,
			) => BotTokenSpendSummary;
		}).tokenSpendSummaryForRows.bind(runtime);

		const spend = tokenSpendSummaryForRows("bot-spend", "requested/current", rows, new Date("2026-05-08T00:00:00.000Z"));

		expect(spend.last24Hours).toMatchObject({
			cost: 0.25,
			requestCount: 1,
			unknownCost: false,
		});
		expect(spend.average.requestCount).toBe(2);
		expect(spend.average.dayCount).toBe(2);
		expect(spend.average.costPerDay).toBeCloseTo(0.375);
		expect(spend.average.periodStart).toBe("2026-05-06T00:00:00.000Z");
	});

	it("reports zero average spend when the configured model has no tracked usage", () => {
		const rows: ProviderUsageRowForSpendTest[] = [
			{
				...providerLoopUsageRowForTest(1, "2026-05-07T12:00:00.000Z", 100),
				requested_model: "requested/old",
				cost: 0.25,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {});
		const tokenSpendSummaryForRows = (BotRuntime.prototype as unknown as {
			tokenSpendSummaryForRows: (
				botId: string,
				currentModel: string,
				rows: ProviderUsageRowForSpendTest[],
				now?: Date,
			) => BotTokenSpendSummary;
		}).tokenSpendSummaryForRows.bind(runtime);

		const spend = tokenSpendSummaryForRows("bot-spend", "requested/current", rows, new Date("2026-05-08T00:00:00.000Z"));

		expect(spend.last24Hours.cost).toBe(0.25);
		expect(spend.average).toMatchObject({
			costPerDay: 0,
			dayCount: 0,
			noCurrentModelUsage: true,
			requestCount: 0,
			unknownCost: false,
		});
	});

	it("marks token spend as unknown when provider usage omits cost", () => {
		const rows: ProviderUsageRowForSpendTest[] = [
			{
				...providerLoopUsageRowForTest(1, "2026-05-07T12:00:00.000Z", 100),
				requested_model: "requested/current",
				cost: null,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {});
		const tokenSpendSummaryForRows = (BotRuntime.prototype as unknown as {
			tokenSpendSummaryForRows: (
				botId: string,
				currentModel: string,
				rows: ProviderUsageRowForSpendTest[],
				now?: Date,
			) => BotTokenSpendSummary;
		}).tokenSpendSummaryForRows.bind(runtime);

		const spend = tokenSpendSummaryForRows("bot-spend", "requested/current", rows, new Date("2026-05-08T00:00:00.000Z"));

		expect(spend.last24Hours).toMatchObject({
			cost: null,
			requestCount: 1,
			unknownCost: true,
		});
		expect(spend.average).toMatchObject({
			costPerDay: null,
			requestCount: 1,
			unknownCost: true,
		});
	});

	it("lists owner token spend summaries from central D1 usage rows", async () => {
		const exportedAt = "2026-05-08T00:00:00.000Z";
		await recordBotInferenceUsageBatch(testEnv.BICKR_D1, [
			centralUsageRecordForTest({
				botId: "bot-a",
				ownerUserId: "user-spend",
				sourceUsageId: 1,
				runId: "run-old",
				requestSeq: 1,
				createdAt: "2026-05-05T00:00:00.000Z",
				requestedModel: "model/old",
				cost: 0.8,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-a",
				ownerUserId: "user-spend",
				sourceUsageId: 2,
				runId: "run-a",
				requestSeq: 10,
				createdAt: "2026-05-06T00:00:00.000Z",
				requestedModel: "model/current",
				cost: 0.4,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-a",
				ownerUserId: "user-spend",
				sourceUsageId: 3,
				runId: "run-a",
				requestSeq: 11,
				createdAt: "2026-05-07T12:00:00.000Z",
				requestedModel: "model/current",
				cost: 0.2,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-b",
				ownerUserId: "user-spend",
				sourceUsageId: 1,
				runId: "run-b",
				requestSeq: 1,
				createdAt: "2026-05-07T18:00:00.000Z",
				requestedModel: "model/current",
				cost: null,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-c",
				ownerUserId: "other-user",
				sourceUsageId: 1,
				runId: "run-c",
				requestSeq: 1,
				createdAt: "2026-05-07T18:00:00.000Z",
				requestedModel: "model/current",
				cost: 9,
				exportedAt,
			}),
		]);

		const summaries = await listOwnerBotTokenSpendSummaries(
			testEnv.BICKR_D1,
			"user-spend",
			[
				{ botId: "bot-a", currentModel: "model/current" },
				{ botId: "bot-b", currentModel: "model/current" },
				{ botId: "bot-empty", currentModel: "model/current" },
			],
			new Date("2026-05-08T00:00:00.000Z"),
		);
		const byId = new Map(summaries.map((summary) => [summary.botId, summary]));

		expect(byId.get("bot-a")?.last24Hours).toMatchObject({
			cost: 0.2,
			requestCount: 1,
			unknownCost: false,
		});
		expect(byId.get("bot-a")?.average.costPerDay).toBeCloseTo(0.3);
		expect(byId.get("bot-b")?.last24Hours).toMatchObject({
			cost: null,
			requestCount: 1,
			unknownCost: true,
		});
		expect(byId.get("bot-empty")?.last24Hours).toMatchObject({
			cost: 0,
			requestCount: 0,
			unknownCost: false,
		});
	});

	it("aggregates global effective inference costs by model and provider", async () => {
		const exportedAt = "2026-05-08T00:00:00.000Z";
		await recordBotInferenceUsageBatch(testEnv.BICKR_D1, [
			centralUsageRecordForTest({
				botId: "bot-global-a",
				ownerUserId: "user-a",
				sourceUsageId: 1,
				runId: "run-a",
				requestSeq: 1,
				createdAt: "2026-05-07T00:00:00.000Z",
				requestedModel: "model/cheap",
				providerName: "Provider A",
				totalTokens: 1_000_000,
				cost: 0.5,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-global-b",
				ownerUserId: "user-b",
				sourceUsageId: 1,
				runId: "run-b",
				requestSeq: 1,
				createdAt: "2026-05-07T01:00:00.000Z",
				requestedModel: "model/cheap",
				providerName: "Provider A",
				totalTokens: 500_000,
				cost: null,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-global-c",
				ownerUserId: "user-c",
				sourceUsageId: 1,
				runId: "run-c",
				requestSeq: 1,
				createdAt: "2026-05-07T02:00:00.000Z",
				requestedModel: "model/cheap",
				providerName: "Provider B",
				totalTokens: 250_000,
				cost: 0.5,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-global-d",
				ownerUserId: "user-d",
				sourceUsageId: 1,
				runId: "run-d",
				requestSeq: 1,
				createdAt: "2026-05-07T03:00:00.000Z",
				requestedModel: "model/unknown-provider",
				providerName: " ",
				totalTokens: 100_000,
				cost: 0.1,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-global-e",
				ownerUserId: "user-e",
				sourceUsageId: 1,
				runId: "run-e",
				requestSeq: 1,
				createdAt: "2026-05-07T04:00:00.000Z",
				requestedModel: "model/no-cost",
				providerName: "Provider C",
				totalTokens: 100_000,
				cost: null,
				exportedAt,
			}),
			centralUsageRecordForTest({
				botId: "bot-global-old",
				ownerUserId: "user-old",
				sourceUsageId: 1,
				runId: "run-old",
				requestSeq: 1,
				createdAt: "2026-04-30T23:59:59.000Z",
				requestedModel: "model/old",
				providerName: "Provider Old",
				totalTokens: 9_000_000,
				cost: 9,
				exportedAt,
			}),
		]);

		const stats = await globalInferenceCostStatsFromUsage(testEnv.BICKR_D1, new Date("2026-05-08T00:00:00.000Z"));

		expect(stats.totals).toMatchObject({
			knownCost: 1.1,
			pricedRequestCount: 3,
			pricedTokens: 1_350_000,
			requestCount: 5,
			totalTokens: 1_950_000,
			unpricedRequestCount: 2,
			unpricedTokens: 600_000,
		});
		expect(stats.rows.map((row) => [row.model, row.providerName, row.effectiveCostPerMillionTokens])).toEqual([
			["model/cheap", "Provider A", 0.5],
			["model/unknown-provider", "Unknown provider", 1],
			["model/cheap", "Provider B", 2],
			["model/no-cost", "Provider C", null],
		]);
		expect(stats.rows[0]).toMatchObject({
			knownCost: 0.5,
			pricedTokens: 1_000_000,
			totalTokens: 1_500_000,
			unpricedTokens: 500_000,
		});
	});

	it("caches global inference cost stats and refreshes them only after the cache age", async () => {
		const firstNow = new Date("2026-05-08T00:00:00.000Z");
		const exportedAt = firstNow.toISOString();
		await recordBotInferenceUsageBatch(testEnv.BICKR_D1, [
			centralUsageRecordForTest({
				botId: "bot-cache-a",
				ownerUserId: "user-cache",
				sourceUsageId: 1,
				runId: "run-cache-a",
				requestSeq: 1,
				createdAt: "2026-05-07T00:00:00.000Z",
				requestedModel: "model/cache-a",
				providerName: "Provider Cache",
				totalTokens: 100_000,
				cost: 0.1,
				exportedAt,
			}),
		]);

		expect(await cachedGlobalInferenceCostStats(testEnv.BICKR_D1)).toBeNull();
		const first = await refreshGlobalInferenceCostStatsCacheIfStale(testEnv.BICKR_D1, firstNow);
		expect(first.rows.map((row) => row.model)).toEqual(["model/cache-a"]);

		await recordBotInferenceUsageBatch(testEnv.BICKR_D1, [
			centralUsageRecordForTest({
				botId: "bot-cache-b",
				ownerUserId: "user-cache",
				sourceUsageId: 1,
				runId: "run-cache-b",
				requestSeq: 1,
				createdAt: "2026-05-07T01:00:00.000Z",
				requestedModel: "model/cache-b",
				providerName: "Provider Cache",
				totalTokens: 100_000,
				cost: 0.1,
				exportedAt,
			}),
		]);

		const stillCached = await refreshGlobalInferenceCostStatsCacheIfStale(testEnv.BICKR_D1, new Date(firstNow.getTime() + 60 * 60 * 1000));
		expect(stillCached.rows.map((row) => row.model)).toEqual(["model/cache-a"]);

		const refreshed = await refreshGlobalInferenceCostStatsCacheIfStale(
			testEnv.BICKR_D1,
			new Date(firstNow.getTime() + globalInferenceCostStatsCacheMaxAgeMs + 1),
		);
		expect(refreshed.rows.map((row) => row.model)).toEqual(["model/cache-a", "model/cache-b"]);
		expect((await cachedGlobalInferenceCostStats(testEnv.BICKR_D1))?.generatedAt).toBe(refreshed.generatedAt);

		const publicStats = publicGlobalInferenceCostStats(refreshed);
		expect(publicStats).not.toHaveProperty("totals");
		expect(publicStats?.rows).toEqual([
			{ effectiveCostPerMillionTokens: 1, model: "model/cache-a", providerName: "Provider Cache" },
			{ effectiveCostPerMillionTokens: 1, model: "model/cache-b", providerName: "Provider Cache" },
		]);
		expect(publicStats?.rows[0]).not.toHaveProperty("knownCost");
		expect(publicStats?.rows[0]).not.toHaveProperty("pricedTokens");
		expect(publicStats?.rows[0]).not.toHaveProperty("requestCount");
	});

	it("stores routed OpenRouter provider names with provider usage", async () => {
		const sql = capturingProviderUsageSql();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const recordProviderUsage = (BotRuntime.prototype as unknown as {
			recordProviderUsage: (input: RecordProviderUsageInputForTest) => Promise<void>;
		}).recordProviderUsage.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { provider_name: "Together" } })));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await recordProviderUsage(providerUsageInputForTest({
				providerResponseId: "gen-provider",
				settings: {
					apiKey: "sk-or-test",
					baseUrl: "https://openrouter.ai/api/v1",
					model: "requested/model",
					temperature: 0.2,
				},
			}));
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(fetchMock).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/generation?id=gen-provider",
			expect.objectContaining({
				headers: expect.objectContaining({ authorization: "Bearer sk-or-test" }),
			}),
		);
		expect(sql.providerNames()).toEqual(["Together"]);
	});

	it("stores OpenRouter router metadata provider names without generation lookup", async () => {
		const sql = capturingProviderUsageSql();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const recordProviderUsage = (BotRuntime.prototype as unknown as {
			recordProviderUsage: (input: RecordProviderUsageInputForTest) => Promise<void>;
		}).recordProviderUsage.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			await recordProviderUsage(providerUsageInputForTest({
				providerName: "Google AI Studio",
				providerResponseId: "gen-provider",
			}));
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sql.providerNames()).toEqual(["Google AI Studio"]);
	});

	it("opts OpenRouter streaming requests into router metadata and keeps the generation id header", async () => {
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {});
		const fetchProviderResponse = (BotRuntime.prototype as unknown as {
			fetchProviderResponse: (
				settings: Record<string, unknown>,
				endpoint: string,
				body: string,
				signal: AbortSignal,
			) => Promise<{ stream: ReadableStream<Uint8Array>; responseId?: string }>;
		}).fetchProviderResponse.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response(sseStream(["[DONE]"]), {
			headers: { "x-generation-id": "gen-header" },
		}));
		vi.stubGlobal("fetch", fetchMock);
		let response: { responseId?: string } | undefined;
		try {
			response = await fetchProviderResponse(
				{
					apiKey: "sk-or-test",
					baseUrl: "https://openrouter.ai/api/v1",
					model: "requested/model",
					temperature: 0.2,
				},
				"https://openrouter.ai/api/v1/chat/completions",
				"{}",
				new AbortController().signal,
			);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(fetchMock).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/chat/completions",
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-OpenRouter-Experimental-Metadata": "enabled",
					authorization: "Bearer sk-or-test",
				}),
			}),
		);
		expect(response?.responseId).toBe("gen-header");
	});

	it("keeps provider usage when OpenRouter provider metadata is unavailable", async () => {
		const sql = capturingProviderUsageSql();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const recordProviderUsage = (BotRuntime.prototype as unknown as {
			recordProviderUsage: (input: RecordProviderUsageInputForTest) => Promise<void>;
		}).recordProviderUsage.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })))
			.mockResolvedValueOnce(new Response("missing", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await recordProviderUsage(providerUsageInputForTest({ providerResponseId: "gen-missing" }));
			await recordProviderUsage(providerUsageInputForTest({ providerResponseId: "gen-failed" }));
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(sql.providerNames()).toEqual([null, null]);
	});

	it("stores direct provider hosts without OpenRouter metadata lookups", async () => {
		const sql = capturingProviderUsageSql();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const recordProviderUsage = (BotRuntime.prototype as unknown as {
			recordProviderUsage: (input: RecordProviderUsageInputForTest) => Promise<void>;
		}).recordProviderUsage.bind(runtime);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			await recordProviderUsage(providerUsageInputForTest({
				settings: {
					apiKey: "direct-key",
					baseUrl: "https://api.provider.example/v1",
					model: "requested/model",
					temperature: 0.2,
				},
			}));
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sql.providerNames()).toEqual(["api.provider.example"]);
	});

	it("calculates prompt context budget segments and over-budget counts", () => {
		const totalReservedTokens = 2_000 + 1_500 + providerContextCompletionReserveTokens;
		expect(
			promptContextBudgetFromCounts({
				contextWindowTokens: 10_000,
				fixedSystemTokens: 2_000,
				personaPromptTokens: 1_500,
				responseReserveTokens: providerContextCompletionReserveTokens,
			}),
		).toMatchObject({
			remainingLoopTokens: Math.max(0, 10_000 - totalReservedTokens),
			overBudgetTokens: 0,
			totalReservedTokens,
		});

		expect(
			promptContextBudgetFromCounts({
				contextWindowTokens: 3_000,
				fixedSystemTokens: 2_000,
				personaPromptTokens: 1_500,
				responseReserveTokens: providerContextCompletionReserveTokens,
			}),
		).toMatchObject({
			remainingLoopTokens: 0,
			overBudgetTokens: Math.max(0, totalReservedTokens - 3_000),
			totalReservedTokens,
		});
	});

		it("reports context window breakdown from latest normal loop inference", () => {
			const baseline = providerLoopUsageRowForTest(10, "2026-05-01T00:00:00.000Z", 4_000);
			const latest = providerLoopUsageRowForTest(12, "2026-05-01T00:10:00.000Z", 6_500);
			const bot = fakeBotDocument({ contextWindowTokens: 20_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const expectedLimits = providerCompactionSummaryLimitsForChat(bot, [], calibration, toolDefinitionsForProviderRound());
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				providerUsageRows: () => [],
				tokenUsageChangeMarkers: () => [],
				textTokenCalibration: () => calibration,
				latestActiveLoopCompactionBoundary: () => null,
				latestLoopProviderUsage: () => latest,
				firstLoopProviderUsageAfterSeq: vi.fn(() => baseline),
			});
			const tokenUsageStats = (BotRuntime.prototype as unknown as {
				tokenUsageStats: (bot: BotDocument, now?: Date) => BotTokenUsageStats;
			}).tokenUsageStats.bind(runtime);

			const usage = tokenUsageStats(bot);

			expect(usage.contextWindow).toMatchObject({
				usedAt: latest.created_at,
				runId: latest.run_id,
				requestSeq: 12,
				promptTokens: 6_500,
				baselinePromptTokens: 4_000,
				initialTokens: 4_000,
				ongoingTokens: 2_500,
				freeTokens: 13_500,
				contextWindowTokens: 20_000,
				compactionCutoffTokens: expectedLimits.nextCompactionTokens,
				responseReserveTokens: providerContextCompletionReserveTokens,
			});
		});

		it("omits context window breakdown when the latest normal inference predates active compaction", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				providerUsageRows: () => [],
				tokenUsageChangeMarkers: () => [],
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
				latestActiveLoopCompactionBoundary: () => ({ messageSeq: 20, requestSeq: 120, created_at: "2026-05-01T00:05:00.000Z" }),
				latestLoopProviderUsage: () => providerLoopUsageRowForTest(12, "2026-05-01T00:20:00.000Z", 6_500),
				firstLoopProviderUsageAfterSeq: vi.fn(),
			});
			const tokenUsageStats = (BotRuntime.prototype as unknown as {
				tokenUsageStats: (bot: BotDocument, now?: Date) => BotTokenUsageStats;
			}).tokenUsageStats.bind(runtime);

			const usage = tokenUsageStats(fakeBotDocument({ contextWindowTokens: 16_000 }));

			expect(usage.contextWindow).toBeUndefined();
			expect(runtime.firstLoopProviderUsageAfterSeq).not.toHaveBeenCalled();
		});

		it("uses the first normal inference after active compaction as the context baseline", () => {
			const firstLoopProviderUsageAfterSeq = vi.fn(() => providerLoopUsageRowForTest(121, "2026-05-01T00:06:00.000Z", 5_500));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				providerUsageRows: () => [],
				tokenUsageChangeMarkers: () => [],
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
				latestActiveLoopCompactionBoundary: () => ({ messageSeq: 20, requestSeq: 120, created_at: "2026-05-01T00:05:00.000Z" }),
				latestLoopProviderUsage: () => providerLoopUsageRowForTest(124, "2026-05-01T00:20:00.000Z", 8_000),
				firstLoopProviderUsageAfterSeq,
			});
			const tokenUsageStats = (BotRuntime.prototype as unknown as {
				tokenUsageStats: (bot: BotDocument, now?: Date) => BotTokenUsageStats;
			}).tokenUsageStats.bind(runtime);

			const usage = tokenUsageStats(fakeBotDocument({ contextWindowTokens: 16_000 }));

			expect(firstLoopProviderUsageAfterSeq).toHaveBeenCalledWith(120);
			expect(usage.contextWindow).toMatchObject({
				baselineRequestSeq: 121,
				baselinePromptTokens: 5_500,
				initialTokens: 5_500,
				ongoingTokens: 2_500,
			});
		});

		it("queries context window usage from normal loop submissions only", () => {
			const queries: string[] = [];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: {
							exec: <T,>(sql: string) => {
								queries.push(sql);
								return { toArray: () => [providerLoopUsageRowForTest(31, "2026-05-01T00:30:00.000Z", 7_000) as T] };
							},
						},
					},
				},
			});
			const latestLoopProviderUsage = (BotRuntime.prototype as unknown as {
				latestLoopProviderUsage: () => unknown;
			}).latestLoopProviderUsage.bind(runtime);

			expect(latestLoopProviderUsage()).toMatchObject({ request_seq: 31, prompt_tokens: 7_000 });
			expect(queries[0]).toContain("s.purpose = 'loop'");
		});

		it("includes prompt, model, provider, and system fingerprints in context budget cache keys", async () => {
		const base = {
			botId: "bot_one",
			compactionMode: "structured_output" as const,
			effectiveModel: "openrouter/auto",
			fixedSystemFingerprint: "system-a",
			personaPromptFingerprint: "prompt-a",
			providerBaseUrl: "https://openrouter.ai/api/v1",
			supportsPrefill: true,
		};

		const original = await promptContextBudgetCacheFingerprint(base);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, personaPromptFingerprint: "prompt-b" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, worldPromptFingerprint: "world-b" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, effectiveModel: "anthropic/claude" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, providerBaseUrl: "https://example.test/v1" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, providerRouting: { max_price: { prompt: 0.25 } } }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, fixedSystemFingerprint: "system-b" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, compactionMode: "tool_call_cache_friendly" }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({ ...base, supportsPrefill: false }),
		).resolves.not.toBe(original);
		await expect(
			promptContextBudgetCacheFingerprint({
				...base,
				fixedSystemFingerprint: JSON.stringify({
					system: "system-a",
					reasoningPrefill:
						"I'm u/bot-a. I need to think about how I feel and what I want to do next.",
				}),
			}),
		).resolves.not.toBe(
			await promptContextBudgetCacheFingerprint({
				...base,
				fixedSystemFingerprint: JSON.stringify({
					system: "system-a",
					reasoningPrefill:
						"I'm u/bot-b. I need to think about how I feel and what I want to do next.",
				}),
			}),
		);
	});

		it("retains, reads, deletes, and clears bounded inference submissions", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: memoryInferenceSubmissionSql(),
					},
				},
			});
			const recordInferenceSubmission = (BotRuntime.prototype as unknown as {
				recordInferenceSubmission: (input: {
					seq: number;
					runId: string;
					purpose: "loop" | "compaction";
					settings: { baseUrl: string; model: string; supportsPrefill?: boolean; temperature: number };
					messages: Array<{ role: "assistant" | "user"; content: string }>;
					displayMessages?: Array<{ role: "user" | "assistant"; content: string }>;
					createdAt: string;
				}) => void;
			}).recordInferenceSubmission.bind(runtime);
			const updateInferenceSubmissionDisplayMessages = (BotRuntime.prototype as unknown as {
				updateInferenceSubmissionDisplayMessages: (
					seq: number,
					messages: Array<{ role: "user" | "assistant"; content: string }>,
				) => void;
			}).updateInferenceSubmissionDisplayMessages.bind(runtime);
			const inferenceSubmissionSummaries = (BotRuntime.prototype as unknown as {
				inferenceSubmissionSummaries: () => Array<{ seq: number; purpose: string; messageCount: number }>;
			}).inferenceSubmissionSummaries.bind(runtime);
			const inferenceSubmissionForSeq = (BotRuntime.prototype as unknown as {
				inferenceSubmissionForSeq: (seq: number) => {
					seq: number;
					messages: Array<{ content: string }>;
					displayMessages?: Array<{ content: string }>;
				};
			}).inferenceSubmissionForSeq.bind(runtime);
			const deleteInferenceSubmissionsForSeq = (BotRuntime.prototype as unknown as {
				deleteInferenceSubmissionsForSeq: (seq: number) => number;
			}).deleteInferenceSubmissionsForSeq.bind(runtime);
			const clearInferenceSubmissions = (BotRuntime.prototype as unknown as {
				clearInferenceSubmissions: () => number;
			}).clearInferenceSubmissions.bind(runtime);

			for (let seq = 1; seq <= 55; seq += 1) {
				recordInferenceSubmission({
					seq,
					runId: "run-submissions",
					purpose: seq === 55 ? "compaction" : "loop",
					settings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "test/model",
						...(seq === 55 ? { supportsPrefill: false } : {}),
						temperature: 0.7,
					},
					messages: seq === 55 ?
						[{ role: "assistant", content: "Trailing participant narration." }]
					:	[{ role: "user", content: `Müller message ${seq}` }],
					createdAt: `2026-05-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
				});
			}

			const summaries = inferenceSubmissionSummaries();
			expect(summaries).toHaveLength(50);
			expect(summaries[0]?.seq).toBe(6);
			expect(summaries.at(-1)).toMatchObject({ seq: 55, purpose: "compaction", messageCount: 2 });
			expect(inferenceSubmissionForSeq(55).messages.map((message) => message.content)).toEqual([
				"Trailing participant narration.",
				"Bickr Terminal is ready for my next step.",
			]);
			expect(inferenceSubmissionForSeq(55).displayMessages).toBeUndefined();
			updateInferenceSubmissionDisplayMessages(55, [
				{ role: "user", content: "Submitted compaction chat." },
				{ role: "assistant", content: "Compacted continuity summary." },
			]);
			expect(inferenceSubmissionForSeq(55).displayMessages?.map((message) => message.content)).toEqual([
				"Submitted compaction chat.",
				"Compacted continuity summary.",
			]);
			expect(deleteInferenceSubmissionsForSeq(55)).toBe(1);
			expect(inferenceSubmissionSummaries().map((submission) => submission.seq)).not.toContain(55);
			expect(clearInferenceSubmissions()).toBe(49);
			expect(inferenceSubmissionSummaries()).toEqual([]);
		});

		it("streams provider reasoning through live deltas and persistent messages", async () => {
		type TestProviderResponse = {
			content: string;
			reasoning: string;
			reasoningDetails: Array<Record<string, unknown>>;
			toolCalls: Array<Record<string, unknown>>;
		};
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const deltas: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, _runId, type as BotRuntimeEvent["type"], payload);
			},
			broadcastProviderDelta: (_runId: string, streamSeq: number, event: Record<string, unknown>) => {
				deltas.push({ ...event, streamSeq });
			},
			clearProviderStreamActive: () => {},
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const consumeProviderResponse = (BotRuntime.prototype as unknown as {
			consumeProviderResponse: (
				runId: string,
				streamSeq: number,
				stream: ReadableStream<Uint8Array>,
				signal: AbortSignal,
			) => Promise<TestProviderResponse>;
		}).consumeProviderResponse.bind(runtime);
		const appendProviderMessages = (BotRuntime.prototype as unknown as {
				appendProviderMessages: (
					runId: string,
					response: TestProviderResponse,
					status: "complete" | "interrupted",
					streamSeq: number,
				) => Promise<void>;
		}).appendProviderMessages.bind(runtime);

		const response = await consumeProviderResponse(
			"run-reasoning",
			42,
			sseStream([
				{ choices: [{ delta: { reasoning: "I should inspect the thread. " } }] },
				{ choices: [{ delta: { reasoning_content: "Then I can decide. " } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning.summary", summary: "Summary says to compare options. ", format: "openai-responses-v1", index: 0 }] } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "I will use ", format: "unknown", index: 0 }] } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "a tool. ", format: "unknown", index: 0 }] } }] },
				{ choices: [{ delta: { reasoning_details: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Responses-style summary. " }], format: "openai-responses-v1", index: 1 }] } }] },
				{ choices: [{ delta: { content: " Checking now." } }] },
				"[DONE]",
			]),
			new AbortController().signal,
		);
			await appendProviderMessages("run-reasoning", response, "complete", 42);

		expect(response).toMatchObject({
			content: " Checking now.",
			reasoning: "I should inspect the thread. Then I can decide. Summary says to compare options. I will use a tool. Responses-style summary. ",
			reasoningDetails: [
				{ type: "reasoning.summary", summary: "Summary says to compare options. ", format: "openai-responses-v1", index: 0 },
				{ type: "reasoning.text", text: "I will use a tool. ", format: "unknown", index: 0 },
				{ type: "reasoning", summary: [{ type: "summary_text", text: "Responses-style summary. " }], format: "openai-responses-v1", index: 1 },
			],
			toolCalls: [],
		});
		expect(deltas).toEqual([
			{ kind: "reasoning", streamSeq: 42, text: "I should inspect the thread. " },
			{ kind: "reasoning", streamSeq: 42, text: "Then I can decide. " },
			{ kind: "reasoning", streamSeq: 42, text: "Summary says to compare options. " },
			{ kind: "reasoning", streamSeq: 42, text: "I will use " },
			{ kind: "reasoning", streamSeq: 42, text: "a tool. " },
			{ kind: "reasoning", streamSeq: 42, text: "Responses-style summary. " },
			{ kind: "content", streamSeq: 42, text: " Checking now." },
		]);
		expect(events).toEqual([
			{
				type: "reasoning_message",
				payload: {
					content: "I should inspect the thread. Then I can decide. Summary says to compare options. I will use a tool. Responses-style summary. ",
					status: "complete",
					streamSeq: 42,
				},
			},
			{
					type: "assistant_message",
					payload: {
						content: " Checking now.",
						status: "complete",
						streamSeq: 42,
					},
			},
		]);
	});
});
