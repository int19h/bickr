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
	BotInferenceSubmissionMessage,
	BotInferenceSubmissionToolCall,
	BotRuntimeEvent,
	BotTokenSpendSummary,
	BotTokenUsageStats,
	ProviderToolDefinition,
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

		it("emits baseline-plus-delta prompt estimates for stored sanitized tool-call prefixes", async () => {
			const sql = promptEstimateSqlForTest();
			const baselineLoopMessages = notificationToolPrefixMessages("synthetic_run_baseline_0");
			const nextLoopMessages = [
				...baselineLoopMessages,
				{ role: "assistant" as const, content: "I will check the forum activity next." },
			];
			let activeLoopMessages = baselineLoopMessages;
			const events: BotRuntimeEvent[] = [];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql,
					},
				},
				activeLoopMessagesForProvider: () => activeLoopMessages,
				appendEvent: async (runId: string, type: BotRuntimeEvent["type"], payload: unknown) => {
					const event = runtimeEvent(events.length + 1, runId, type, payload);
					events.push(event);
					return event;
				},
				botWithCurrentRuntimeBudget: async (bot: BotDocument) => bot,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 2 }),
			});
			const settings = promptEstimateSettings();
			const bot = fakeBotDocument({ contextWindowTokens: 80_000 });
			const activeProviderRequestMessages = (BotRuntime.prototype as unknown as {
				activeProviderRequestMessages: (bot: BotDocument) => BotInferenceSubmissionMessage[];
			}).activeProviderRequestMessages.bind(runtime);
			const recordInferenceSubmission = (BotRuntime.prototype as unknown as {
				recordInferenceSubmission: (input: {
					seq: number;
					runId: string;
					purpose: "loop" | "compaction";
					settings: ReturnType<typeof promptEstimateSettings>;
					messages: BotInferenceSubmissionMessage[];
					createdAt: string;
				}) => void;
			}).recordInferenceSubmission.bind(runtime);
			const ensureProviderPromptWithinBudget = (BotRuntime.prototype as unknown as {
				ensureProviderPromptWithinBudget: (
					bot: BotDocument,
					settings: ReturnType<typeof promptEstimateSettings>,
					runId: string,
					signal: AbortSignal,
					providerTools: ProviderToolDefinition[],
				) => Promise<unknown>;
			}).ensureProviderPromptWithinBudget.bind(runtime);

			recordInferenceSubmission({
				seq: 10,
				runId: "run-baseline",
				purpose: "loop",
				settings,
				messages: activeProviderRequestMessages(bot),
				createdAt: "2026-05-01T00:00:00.000Z",
			});
			sql.addProviderUsage({ requestSeq: 10, runId: "run-baseline", promptTokens: 2_000 });

			activeLoopMessages = nextLoopMessages;
			await ensureProviderPromptWithinBudget(bot, settings, "run-next", new AbortController().signal, []);

			const payload = events.find((event) => event.type === "provider_token_estimate")?.payload as Record<string, unknown> | undefined;
			expect(payload).toMatchObject({
				source: "baseline_plus_delta",
				baselinePromptTokens: 2_000,
				calibrationSampleCount: 2,
			});
			expect(payload?.baselineMessageCount).toBeGreaterThan(0);
			expect(payload?.estimatedDeltaTokens).toBeGreaterThan(0);
			expect(payload?.promptTokens).toBeGreaterThan(2_000);
		});

		it("falls back to full prompt estimates for incompatible stored histories", () => {
			const sql = promptEstimateSqlForTest();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql,
					},
				},
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 1 }),
			});
			const settings = promptEstimateSettings();
			recordPromptEstimateBaseline(runtime, sql, {
				seq: 20,
				runId: "run-incompatible",
				settings,
				messages: [{ role: "user", content: "Original history." }],
				promptTokens: 1_500,
			});
			const estimateProviderPromptTokens = promptTokenEstimator(runtime);

			const estimate = estimateProviderPromptTokens(settings, [{ role: "user", content: "Diverged history." }], []);

			expect(estimate).toMatchObject({
				source: "full_estimate",
				calibrationSampleCount: 1,
			});
			expect(estimate.baselinePromptTokens).toBeUndefined();
			expect(estimate.estimatedDeltaTokens).toBeUndefined();
		});

		it("matches sanitized prefixes when live messages keep null content and synthetic tool-call ids", () => {
			const sql = promptEstimateSqlForTest();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql,
					},
				},
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const settings = promptEstimateSettings();
			const storedPrefix = notificationToolPrefixMessages("synthetic_original_run_0");
			recordPromptEstimateBaseline(runtime, sql, {
				seq: 30,
				runId: "run-sanitized-prefix",
				settings,
				messages: storedPrefix,
				promptTokens: 1_750,
			});
			const storedMessages = sql.submissionMessages(30);
			expect(storedMessages?.find((message) => Array.isArray(message.tool_calls))?.content).toBe("");
			expect(storedMessages?.flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.id) ?? [])).toEqual(["call_1"]);
			expect(storedMessages?.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call_1"]);

			const estimate = promptTokenEstimator(runtime)(
				settings,
				[
					...storedPrefix,
					{ role: "assistant", content: "I have the latest notifications now." },
				],
				[],
			);

			expect(estimate).toMatchObject({
				source: "baseline_plus_delta",
				baselinePromptTokens: 1_750,
			});
			expect(estimate.estimatedDeltaTokens).toBeGreaterThan(0);
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

type ProviderPromptTokenEstimateForTest = {
	promptTokens: number;
	source: "baseline_plus_delta" | "full_estimate";
	baselinePromptTokens?: number;
	baselineMessageCount?: number;
	estimatedDeltaTokens?: number;
	calibrationSampleCount: number;
};

function promptEstimateSettings() {
	return {
		baseUrl: "https://openrouter.ai/api/v1",
		model: "test/prompt-estimate",
		supportsPrefill: true,
		temperature: 0.2,
	};
}

function promptTokenEstimator(runtime: BotRuntime) {
	return (BotRuntime.prototype as unknown as {
		estimateProviderPromptTokens: (
			settings: ReturnType<typeof promptEstimateSettings>,
			messages: BotInferenceSubmissionMessage[],
			providerTools: ProviderToolDefinition[],
		) => ProviderPromptTokenEstimateForTest;
	}).estimateProviderPromptTokens.bind(runtime);
}

function recordPromptEstimateBaseline(
	runtime: BotRuntime,
	sql: ReturnType<typeof promptEstimateSqlForTest>,
	input: {
		seq: number;
		runId: string;
		settings: ReturnType<typeof promptEstimateSettings>;
		messages: BotInferenceSubmissionMessage[];
		promptTokens: number;
	},
): void {
	const recordInferenceSubmission = (BotRuntime.prototype as unknown as {
		recordInferenceSubmission: (record: {
			seq: number;
			runId: string;
			purpose: "loop" | "compaction";
			settings: ReturnType<typeof promptEstimateSettings>;
			messages: BotInferenceSubmissionMessage[];
			createdAt: string;
		}) => void;
	}).recordInferenceSubmission.bind(runtime);
	recordInferenceSubmission({
		seq: input.seq,
		runId: input.runId,
		purpose: "loop",
		settings: input.settings,
		messages: input.messages,
		createdAt: "2026-05-01T00:00:00.000Z",
	});
	sql.addProviderUsage({ requestSeq: input.seq, runId: input.runId, promptTokens: input.promptTokens });
}

function promptEstimateSqlForTest() {
	type SubmissionRow = {
		id: string;
		event_seq: number;
		run_id: string;
		purpose: string;
		model: string;
		provider_base_url: string;
		message_count: number;
		messages_json: string;
		display_messages_json: string | null;
		created_at: string;
	};
	type ProviderUsageRow = {
		request_seq: number;
		run_id: string;
		prompt_tokens: number;
	};
	let submissions: SubmissionRow[] = [];
	const usages: ProviderUsageRow[] = [];
	return {
		addProviderUsage(input: { requestSeq: number; runId: string; promptTokens: number }) {
			usages.push({
				request_seq: input.requestSeq,
				run_id: input.runId,
				prompt_tokens: input.promptTokens,
			});
		},
		submissionMessages(seq: number): BotInferenceSubmissionMessage[] | null {
			const row = submissions.find((submission) => submission.event_seq === seq);
			return row ? (JSON.parse(row.messages_json) as BotInferenceSubmissionMessage[]) : null;
		},
		exec<T>(sql: string, ...params: unknown[]) {
			if (/INSERT INTO inference_submissions/.test(sql)) {
				const row: SubmissionRow = {
					id: String(params[0]),
					event_seq: Number(params[1]),
					run_id: String(params[2]),
					purpose: String(params[3]),
					model: String(params[4]),
					provider_base_url: String(params[5]),
					message_count: Number(params[6]),
					messages_json: String(params[7]),
					display_messages_json: params[8] === null ? null : String(params[8]),
					created_at: String(params[9]),
				};
				submissions = [...submissions.filter((submission) => submission.event_seq !== row.event_seq), row];
			} else if (/DELETE FROM inference_submissions\s+WHERE id NOT IN/.test(sql)) {
				const keep = new Set(
					[...submissions]
						.sort((left, right) => right.event_seq - left.event_seq)
						.slice(0, Number(params[0]))
						.map((row) => row.id),
				);
				submissions = submissions.filter((row) => keep.has(row.id));
			} else if (/FROM inference_submissions s\s+JOIN provider_usage u/.test(sql)) {
				const model = String(params[0]);
				const providerBaseUrl = String(params[1]);
				const rows = submissions
					.flatMap((submission) => {
						if (submission.purpose !== "loop" || submission.model !== model || submission.provider_base_url !== providerBaseUrl) {
							return [];
						}
						return usages
							.filter((usage) => usage.request_seq === submission.event_seq && usage.run_id === submission.run_id && usage.prompt_tokens > 0)
							.map((usage) => ({
								event_seq: submission.event_seq,
								run_id: submission.run_id,
								purpose: submission.purpose,
								messages_json: submission.messages_json,
								model: submission.model,
								provider_base_url: submission.provider_base_url,
								prompt_tokens: usage.prompt_tokens,
							}));
					})
					.sort((left, right) => right.event_seq - left.event_seq)
					.slice(0, 20);
				return {
					one: () => (rows[0] ?? {}) as T,
					toArray: () => rows as T[],
				};
			}
			return {
				one: () => ({} as T),
				toArray: () => [],
			};
		},
	};
}

function notificationToolPrefixMessages(toolCallId: string): BotInferenceSubmissionMessage[] {
	return [
		{
			role: "assistant",
			content: null,
			tool_calls: [toolCallForPromptEstimate(toolCallId, "check_notifications", { after: 0 })],
		},
		{
			role: "tool",
			tool_call_id: toolCallId,
			content: deeplyNestedToolResultContent(),
		},
	];
}

function toolCallForPromptEstimate(id: string, name: string, args: Record<string, unknown>): BotInferenceSubmissionToolCall {
	return {
		id,
		type: "function",
		function: {
			name,
			arguments: JSON.stringify(args),
		},
	};
}

function deeplyNestedToolResultContent(): string {
	let value: unknown = { unreadCount: 1, notifications: [{ id: "ntf_1", text: "New activity." }] };
	for (let index = 0; index < 40; index += 1) {
		value = { nested: value };
	}
	return JSON.stringify(value);
}
