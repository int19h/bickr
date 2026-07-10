import {
	BotRuntime,
	customProviderBaseUrl,
	defaultReasoningPrefill,
	describe,
	expect,
	fakeBotDocument,
	it,
	loopMessageRowForMessage,
	loopMessageRowForTest,
	memoryLoopMessageLogSql,
	memoryLoopMessagePageSql,
	messageListText,
	metaCompactionToolName,
	oldestRowsForTokenFraction,
	providerCompactionSummaryLimitsForChat,
	providerCompactionSummaryProperty,
	providerContextCompletionReserveTokens,
	providerPromptEstimateForTokens,
	providerResponseWithContent,
	providerTranslationRequest,
	runtimeErrorLoopMessageContent,
	runtimeEvent,
	textTokenCalibrationFromPromptHistory,
	textTokenCalibrationFromProviderTokenCalibrationSamples,
	toolDefinitionsForProviderRound,
	vi,
} from "./helpers/index-harness";
import type {
	BotDocument,
	BotInferenceSubmissionMessage,
	BotLoopMessage,
	BotLoopMessageLog,
	BotRuntimeEvent,
	LoopMessageRowForTest,
	ProviderToolDefinition,
} from "./helpers/index-harness";

// TODO(#12): move next to module on extraction.
describe("Compaction", () => {

		it("surfaces final schema-invalid compaction failures as owner-visible inference diagnostics", async () => {
			const originalFetch = globalThis.fetch;
			const invalidResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_bad_compaction",
							type: "function",
							function: { name: metaCompactionToolName, arguments: JSON.stringify({ summary: "Wrong key." }) },
						}],
					},
				}],
			};
			const fetchMock = vi.fn(async () => Response.json(invalidResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<unknown>;
				}).callProviderForCompaction.bind(runtime);

				let thrown: unknown;
				try {
					await callProviderForCompaction(
						{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
						[{ role: "user", content: "Compact the retained activity." }],
						"run-compaction-repair-failed",
						new AbortController().signal,
						undefined,
						undefined,
						"tool_call",
					);
				} catch (error) {
					thrown = error;
				}

				expect(fetchMock).toHaveBeenCalledTimes(5);
				expect(thrown).toMatchObject({
					name: "ProviderCompactionRequestError",
					message: expect.stringContaining("schema-invalid compaction tool arguments"),
				});
				expect(runtimeErrorLoopMessageContent(thrown)).toMatch(/^Inference provider returned an error: /);
				expect(runtimeErrorLoopMessageContent(thrown)).toContain("schema-invalid compaction tool arguments");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("selects compaction rows by oldest token fraction instead of row count", () => {
			const selected = oldestRowsForTokenFraction(
				[
					{ row: { seq: 1 }, tokens: 25 },
					{ row: { seq: 2 }, tokens: 25 },
					{ row: { seq: 3 }, tokens: 25 },
					{ row: { seq: 4 }, tokens: 25 },
				],
				0.7,
			);

			expect(selected.map((row) => row.seq)).toEqual([1, 2, 3]);
		});

		it("stops before the atomic tool-call group that crosses the compaction prompt budget", () => {
			const large = (char: string) => char.repeat(4_000);
			const rows: LoopMessageRowForTest[] = [
				loopMessageRowForMessage(1, { role: "assistant", content: large("a") }),
				loopMessageRowForMessage(2, {
					role: "assistant",
					content: large("b"),
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-read", content: large("c") }, "tool_result"),
				loopMessageRowForMessage(4, { role: "assistant", content: large("d") }),
				loopMessageRowForMessage(5, { role: "assistant", content: large("e") }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowsForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowsForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => Array<{ seq: number }>;
			}).compactionRowsForEstimatedBudget.bind(runtime);

			const selected = compactionRowsForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 8_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.map((row) => row.seq)).toEqual([1]);
		});

		it("compacts malformed visible tool history without blocking on missing matches", () => {
			const large = (char: string) => char.repeat(4_000);
			const rows: LoopMessageRowForTest[] = [
				loopMessageRowForMessage(1, {
					role: "assistant",
					content: large("a"),
					tool_calls: [
						{
							id: "call-missing-result",
							type: "function",
							function: { name: "read_thread", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(2, { role: "tool", tool_call_id: "call-orphan", content: large("b") }, "tool_result"),
				loopMessageRowForMessage(3, { role: "assistant", content: large("c") }),
				loopMessageRowForMessage(4, { role: "assistant", content: large("d") }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowsForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowsForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => Array<{ seq: number }>;
			}).compactionRowsForEstimatedBudget.bind(runtime);

			const selected = compactionRowsForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 8_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.map((row) => row.seq)).toEqual([1]);
		});

		it("allows one over-budget compaction group when the normal prefix would be too small", () => {
			const huge = (char: string) => char.repeat(20_000);
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "a" }),
				loopMessageRowForMessage(2, {
					role: "assistant",
					content: huge("b"),
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-read", content: huge("c") }, "tool_result"),
				loopMessageRowForMessage(4, { role: "assistant", content: huge("d") }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowSelectionForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowSelectionForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => { rows: Array<{ seq: number }>; overBudgetFallback: boolean };
			}).compactionRowSelectionForEstimatedBudget.bind(runtime);

			const selected = compactionRowSelectionForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 8_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
			expect(selected.overBudgetFallback).toBe(true);
		});

		it("includes the next fitting atomic group instead of compacting a tiny prefix", () => {
			const large = (char: string) => char.repeat(60_000);
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "small runtime note" }),
				loopMessageRowForMessage(2, {
					role: "assistant",
					content: large("b"),
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-read", content: large("c") }, "tool_result"),
				loopMessageRowForMessage(4, { role: "assistant", content: large("d") }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowSelectionForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowSelectionForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => { rows: Array<{ seq: number }>; overBudgetFallback: boolean };
			}).compactionRowSelectionForEstimatedBudget.bind(runtime);

			const selected = compactionRowSelectionForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 64_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
			expect(selected.overBudgetFallback).toBe(false);
		});

		it("does not auto-compact a tiny complete provider history", () => {
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "I remember a short summary." }, "compaction"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const compactionRowSelectionForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowSelectionForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => { rows: Array<{ seq: number }>; overBudgetFallback: boolean };
			}).compactionRowSelectionForEstimatedBudget.bind(runtime);

			const selected = compactionRowSelectionForEstimatedBudget(
				fakeBotDocument({ contextWindowTokens: 20_000 }),
				toolDefinitionsForProviderRound(),
				"tool_call_cache_friendly",
			);

			expect(selected.rows).toEqual([]);
			expect(selected.overBudgetFallback).toBe(false);
		});

		it("excludes a prefix group that would leave too little compaction output budget", () => {
			const text = (char: string, length: number) => char.repeat(length);
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: text("a", 3_200) }),
				loopMessageRowForMessage(2, { role: "assistant", content: text("b", 420) }),
				loopMessageRowForMessage(3, {
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call-hot",
							type: "function",
							function: { name: "list_hot_threads", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(4, { role: "tool", tool_call_id: "call-hot", content: text("c", 8_000) }, "tool_result"),
				loopMessageRowForMessage(5, {
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread_by_id", arguments: "{}" },
						},
					],
				}),
				loopMessageRowForMessage(6, { role: "tool", tool_call_id: "call-read", content: text("d", 10_500) }, "tool_result"),
			];
			const calibration = { tokensPerCharacter: 0.325, sampleCount: 50 };
			const tools = toolDefinitionsForProviderRound();
			const bot = fakeBotDocument({
				contextWindowTokens: 20_000,
				compactionMaxCharacters: 20_000,
				prompt: "Long persona. ".repeat(900),
			});
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => calibration,
			});
			const compactionRowsForEstimatedBudget = (BotRuntime.prototype as unknown as {
				compactionRowsForEstimatedBudget: (
					bot: BotDocument,
					providerTools?: ProviderToolDefinition[],
					mode?: "structured_output" | "tool_call" | "tool_call_cache_friendly",
				) => Array<{ seq: number; message_json: string }>;
			}).compactionRowsForEstimatedBudget.bind(runtime);

			const selected = compactionRowsForEstimatedBudget(bot, tools, "structured_output");
			const selectedMessages = selected.map(
				(row) => JSON.parse(row.message_json) as Parameters<typeof providerCompactionSummaryLimitsForChat>[1][number],
			);
			const selectedLimits = providerCompactionSummaryLimitsForChat(bot, selectedMessages, calibration, tools, "structured_output");
			const rejectedMessages = rows.slice(0, 6).map(
				(row) => JSON.parse(row.message_json) as Parameters<typeof providerCompactionSummaryLimitsForChat>[1][number],
			);
			const rejectedLimits = providerCompactionSummaryLimitsForChat(bot, rejectedMessages, calibration, tools, "structured_output");
			const compactionOutputSafetyTokens = 512;

			expect(selected.map((row) => row.seq)).toEqual([1, 2]);
			expect(selectedLimits.maxCompletionTokens).toBeGreaterThanOrEqual(selectedLimits.maxSummaryTokens + compactionOutputSafetyTokens);
			expect(rejectedLimits.maxCompletionTokens).toBeLessThan(rejectedLimits.maxSummaryTokens + compactionOutputSafetyTokens);
		});

		it("uses the provider-history filter for compaction candidates", () => {
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "Provider-visible old context." }),
				loopMessageRowForMessage(
					2,
					{ role: "user", content: runtimeErrorLoopMessageContent("Inference request failed with status 400. Response: provider rejected the request.") },
					"runtime_error",
				),
				loopMessageRowForMessage(3, { role: "assistant", content: defaultReasoningPrefill("budget-bot") }, "synthetic_context"),
				loopMessageRowForMessage(4, { role: "assistant", content: "Provider-visible newer context." }),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessageRows: () => rows,
				textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
			});
			const activeLoopMessagesForProvider = (BotRuntime.prototype as unknown as {
				activeLoopMessagesForProvider: () => Array<{ content?: unknown }>;
			}).activeLoopMessagesForProvider.bind(runtime);
			const compactionCandidateRows = (BotRuntime.prototype as unknown as {
				compactionCandidateRows: () => Array<{ seq: number }>;
			}).compactionCandidateRows.bind(runtime);

			expect(activeLoopMessagesForProvider().map((message) => message.content)).toEqual([
				"Provider-visible old context.",
				defaultReasoningPrefill("budget-bot"),
				"Provider-visible newer context.",
			]);
			expect(compactionCandidateRows().map((row) => row.seq)).toEqual([1, 3, 4]);
		});

			it("derives row token estimates from recent provider prompt history", () => {
				const previous = "a".repeat(400);
				const appended = "b".repeat(400);
				const calibration = textTokenCalibrationFromPromptHistory([
				{
					event_seq: 10,
					run_id: "run-calibration",
					purpose: "loop",
					messages_json: JSON.stringify([{ role: "user", content: previous }]),
					prompt_tokens: 100,
				},
				{
					event_seq: 11,
					run_id: "run-calibration",
					purpose: "loop",
					messages_json: JSON.stringify([
						{ role: "user", content: previous },
						{ role: "assistant", content: appended },
					]),
					prompt_tokens: 200,
				},
			]);

				expect(calibration.sampleCount).toBe(2);
				expect(calibration.tokensPerCharacter).toBeGreaterThan(0.2);
				expect(calibration.tokensPerCharacter).toBeLessThan(0.3);
			});

			it("derives calibration directly from retained request samples", () => {
				const calibration = textTokenCalibrationFromProviderTokenCalibrationSamples([
					{ prompt_tokens: 120, request_characters: 600 },
					{ prompt_tokens: 800, request_characters: 1_600 },
				]);

				expect(calibration.sampleCount).toBe(2);
				expect(calibration.tokensPerCharacter).toBeCloseTo(0.35);
			});

			it("uses only requested-model calibration samples for prompt estimates", () => {
				const queries: Array<{ sql: string; params: unknown[] }> = [];
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					state: {
						storage: {
							sql: {
								exec: <T,>(sql: string, ...params: unknown[]) => {
									queries.push({ sql, params });
									const requestedModel = String(params[0] ?? "");
									const rows =
										requestedModel === "model-a" ?
											[
												{
													id: 1,
													run_id: "run-a",
													request_seq: 10,
													attempt: 1,
													purpose: "loop",
													requested_model: "model-a",
													response_model: null,
													provider_base_url: "https://provider.example/api/v1",
													prompt_tokens: 500,
													request_characters: 1_000,
													created_at: "2026-05-01T00:00:00.000Z",
												},
											]
										:	[];
									return { toArray: () => rows as T[] };
								},
							},
						},
					},
				});
				const textTokenCalibration = (BotRuntime.prototype as unknown as {
					textTokenCalibration: (requestedModel?: string) => { tokensPerCharacter: number; sampleCount: number };
				}).textTokenCalibration.bind(runtime);

				expect(textTokenCalibration("model-a")).toEqual({ tokensPerCharacter: 0.5, sampleCount: 1 });
				expect(textTokenCalibration("model-b")).toEqual({ tokensPerCharacter: 0.25, sampleCount: 0 });
				expect(queries.map((query) => query.params[0])).toEqual(["model-a", "model-b"]);
				expect(queries[0]?.sql).toContain("FROM provider_token_calibration_samples");
				expect(queries[0]?.sql).toContain("requested_model = ?");
			});

			it("backfills calibration samples from retained legacy submissions by requested model", () => {
				const inserted: unknown[][] = [];
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					state: {
						storage: {
							sql: {
								exec: <T,>(sql: string, ...params: unknown[]) => {
									if (/SELECT value_json FROM runtime_state/.test(sql)) {
										return { toArray: () => [] as T[] };
									}
									if (/FROM inference_submissions s\s+JOIN provider_usage u/.test(sql)) {
										return {
											toArray: () => [
												{
													event_seq: 10,
													run_id: "run-a",
													purpose: "loop",
													messages_json: JSON.stringify([{ role: "user", content: "A".repeat(100) }]),
													requested_model: "model-a",
													response_model: "model-a-concrete",
													provider_base_url: "https://provider.example/api/v1",
													prompt_tokens: 50,
													created_at: "2026-05-01T00:00:00.000Z",
												},
												{
													event_seq: 11,
													run_id: "run-b",
													purpose: "compaction",
													messages_json: JSON.stringify([{ role: "assistant", content: "B".repeat(120) }]),
													requested_model: "model-b",
													response_model: null,
													provider_base_url: "https://provider.example/api/v1",
													prompt_tokens: 80,
													created_at: "2026-05-01T00:01:00.000Z",
												},
											] as T[],
										};
									}
									if (/INSERT INTO provider_token_calibration_samples/.test(sql)) {
										inserted.push(params);
									}
									return { toArray: () => [] as T[], one: () => ({}) as T };
								},
							},
						},
					},
					setRuntimeState: vi.fn(),
				});
				const backfillProviderTokenCalibrationSamples = (BotRuntime.prototype as unknown as {
					backfillProviderTokenCalibrationSamples: () => void;
				}).backfillProviderTokenCalibrationSamples.bind(runtime);

				backfillProviderTokenCalibrationSamples();

				expect(inserted).toHaveLength(2);
				expect(inserted[0]).toEqual(expect.arrayContaining(["run-a", 10, "loop", "model-a", "model-a-concrete"]));
				expect(inserted[1]).toEqual(expect.arrayContaining(["run-b", 11, "compaction", "model-b", null]));
				expect(runtime.setRuntimeState).toHaveBeenCalledWith("provider_token_calibration_samples_backfilled", true);
			});

			it("records compaction submissions before provider failures and marks the row failed", async () => {
				const candidates = Array.from({ length: 12 }, (_, index) => ({
					seq: index + 1,
					position: index + 1,
					run_id: "run-compaction-failure",
					role: "assistant",
					message_json: JSON.stringify({ role: "assistant", content: `Recent activity ${index + 1}` }),
					origin: "provider_response",
					status: "complete",
					token_estimate: 10,
					compacted_by: null,
					created_at: "2026-05-01T00:00:00.000Z",
					has_logs: 0,
				}));
				const appendEvent = vi.fn(async (runId: string, type: string, payload: unknown) => ({
					seq: 101,
					runId,
					type,
					payload,
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:00:01.000Z",
				}));
				const recordInferenceSubmission = vi.fn();
				const replaceEventPayload = vi.fn();
				const providerError = new Error("Provider returned an empty compaction response.");
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					env: {},
					state: {
						storage: {
							sql: {
								exec: <T,>(sql: string) => {
									if (/FROM events\s+WHERE compacted_by IS NULL/.test(sql)) {
										return { toArray: () => candidates as T[] };
									}
									return { one: () => ({} as T), toArray: () => [] as T[] };
								},
							},
						},
					},
					appendEvent,
					recordInferenceSubmission,
					callProviderForCompaction: async () => {
						throw providerError;
					},
					replaceEventPayload,
				});
				const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
					compactLoopMessageRows: (
						bot: { tickSettings: { contextWindowTokens: number } },
						settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
						runId: string,
						signal: AbortSignal,
						rows: unknown[],
						mode: "auto" | "manual",
						metrics: { estimatedContextTokens?: number; threshold?: number },
					) => Promise<void>;
				}).compactLoopMessageRows.bind(runtime);

			await expect(
				compactLoopMessageRows(
					{ tickSettings: { contextWindowTokens: 100 } },
					{ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-compaction-failure",
					new AbortController().signal,
					candidates,
					"auto",
					{ estimatedContextTokens: 10_000, threshold: 80 },
				),
			).rejects.toThrow("empty compaction response");

			expect(appendEvent).toHaveBeenCalledWith("run-compaction-failure", "compaction", expect.objectContaining({ status: "pending" }));
			expect(recordInferenceSubmission).toHaveBeenCalledWith(expect.objectContaining({
				seq: 101,
				purpose: "compaction",
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "system" }),
					expect.objectContaining({ role: "user" }),
				]),
			}));
			expect(replaceEventPayload).toHaveBeenCalledWith(expect.objectContaining({ seq: 101 }), expect.objectContaining({
				status: "failed",
				error: "Provider returned an empty compaction response.",
			}));
		});

		it("does not clamp over-budget fallback compaction output limits to the prompt budget", async () => {
			const candidates = [
				{
					seq: 1,
					position: 1,
					run_id: "run-compaction-over-budget-fallback",
					role: "assistant",
					message_json: JSON.stringify({ role: "assistant", content: "Huge atomic group." + "x".repeat(20_000) }),
					origin: "provider_response",
					status: "complete",
					token_estimate: 5_000,
					compacted_by: null,
					created_at: "2026-05-01T00:00:00.000Z",
					has_logs: 0,
				},
			];
			let capturedLimits: { maxLength: number; maxCompletionTokens: number } | null = null;
			const appendEvent = vi.fn(async (runId: string, type: string, payload: unknown) => ({
				seq: 102,
				runId,
				type,
				payload,
				tokenEstimate: 1,
				createdAt: "2026-05-01T00:00:01.000Z",
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				env: {},
				state: {
					storage: {
						sql: {
							exec: <T,>(sql: string) => {
								if (/FROM events\s+WHERE compacted_by IS NULL/.test(sql)) {
									return { toArray: () => candidates as T[] };
								}
								return { one: () => ({} as T), toArray: () => [] as T[] };
							},
						},
					},
				},
				appendEvent,
				recordInferenceSubmission: vi.fn(),
				callProviderForCompaction: async (_settings: unknown, _messages: unknown, _runId: string, _signal: AbortSignal, limits: { maxLength: number; maxCompletionTokens: number }) => {
					capturedLimits = limits;
					throw new Error("stop after capturing limits");
				},
				replaceEventPayload: vi.fn(),
			});
			const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
				compactLoopMessageRows: (
					bot: BotDocument,
					settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
					runId: string,
					signal: AbortSignal,
					rows: unknown[],
					mode: "auto" | "manual",
					metrics: { compactionOverBudgetFallback?: boolean },
				) => Promise<void>;
			}).compactLoopMessageRows.bind(runtime);

			await expect(
				compactLoopMessageRows(
					fakeBotDocument({ contextWindowTokens: 100, compactionMaxCharacters: 4_000 }),
					{ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-compaction-over-budget-fallback",
					new AbortController().signal,
					candidates,
					"auto",
					{ compactionOverBudgetFallback: true },
				),
			).rejects.toThrow("stop after capturing limits");

			expect(capturedLimits).toMatchObject({
				maxLength: 4_000,
			});
			const limits = capturedLimits as { maxLength: number; maxCompletionTokens: number } | null;
			if (!limits) {
				throw new Error("Expected compaction limits to be captured.");
			}
			expect(limits.maxCompletionTokens).toBeGreaterThan(100);
			expect(appendEvent).toHaveBeenCalledWith(
				"run-compaction-over-budget-fallback",
				"compaction",
				expect.objectContaining({ overBudgetFallback: true, status: "pending" }),
			);
		});

		it("reconstructs retained loop message logs from full, append, and tail-replacement entries", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: memoryLoopMessageLogSql(),
					},
				},
			});
			const recordLoopMessageLog = (BotRuntime.prototype as unknown as {
				recordLoopMessageLog: (messageSeq: number, kind: string, text: string) => void;
			}).recordLoopMessageLog.bind(runtime);
			const loopMessageLogsForSeq = (BotRuntime.prototype as unknown as {
				loopMessageLogsForSeq: (seq: number) => { logs: BotLoopMessageLog[] };
			}).loopMessageLogsForSeq.bind(runtime);

			const requestBase = "short request";
			const requestAppend = `${requestBase} with appended body`;
			const responseBase = `${"A".repeat(320)}old response tail`;
			const responseReplacement = `${"A".repeat(320)}new response tail`;
			recordLoopMessageLog(1, "provider_request", requestBase);
			recordLoopMessageLog(1, "provider_request", requestAppend);
			recordLoopMessageLog(1, "provider_response", responseBase);
			recordLoopMessageLog(1, "provider_response", responseReplacement);

			const logs = loopMessageLogsForSeq(1).logs;
			expect(logs.map((log) => log.encoding)).toEqual(["full", "append", "full", "replace_tail"]);
			expect(logs.map((log) => log.text)).toEqual([requestBase, requestAppend, responseBase, responseReplacement]);
			expect(logs[1]?.baseLogId).toBe(logs[0]?.id);
			expect(logs[3]?.baseLogId).toBe(logs[2]?.id);
			expect(logs[3]?.prefixLength).toBe(320);
		});

		it("adds request usage and cache badges to retained loop message logs", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: memoryLoopMessageLogSql({
							streamSeq: 77,
							providerUsage: {
								requestSeq: 77,
								promptTokens: 20,
								completionTokens: 5,
								totalTokens: 25,
								cachedTokens: 12,
								cost: 0.006,
								usageJson: {
									prompt_tokens: 20,
									completion_tokens: 5,
									total_tokens: 25,
									prompt_tokens_details: { cached_tokens: 12 },
									cost: 0.006,
									cost_details: {
										upstream_inference_prompt_cost: 0.003,
										upstream_inference_completions_cost: 0.003,
									},
								},
							},
						}),
					},
				},
				textTokenCalibration: () => ({ tokensPerCharacter: 1, sampleCount: 1 }),
			});
			const recordLoopMessageLog = (BotRuntime.prototype as unknown as {
				recordLoopMessageLog: (messageSeq: number, kind: string, text: string) => void;
			}).recordLoopMessageLog.bind(runtime);
			const loopMessageLogsForSeq = (BotRuntime.prototype as unknown as {
				loopMessageLogsForSeq: (seq: number) => {
					requestMessages?: Array<{ cacheStatus?: string; message: Record<string, unknown> }>;
					requestUsage?: {
						cachedInputTokens: number;
						uncachedInputTokens: number;
						outputTokens: number;
						cachedInputCost: number | null;
						uncachedInputCost: number | null;
						outputCost: number | null;
						totalCost: number | null;
						estimatedCostSplit: boolean;
					};
				};
			}).loopMessageLogsForSeq.bind(runtime);

			recordLoopMessageLog(1, "provider_request", JSON.stringify({
				messages: [
					{ role: "system", content: "aaaa" },
					{ role: "user", content: "bbbb" },
				],
			}));

			const result = loopMessageLogsForSeq(1);
			expect(result.requestUsage).toMatchObject({
				cachedInputTokens: 12,
				uncachedInputTokens: 8,
				outputTokens: 5,
				outputCost: 0.003,
				totalCost: 0.006,
				estimatedCostSplit: true,
			});
			expect(result.requestUsage?.cachedInputCost).toBeCloseTo(0.0018);
			expect(result.requestUsage?.uncachedInputCost).toBeCloseTo(0.0012);
			expect(result.requestMessages?.map((message) => message.cacheStatus)).toEqual(["cached", "partially_cached"]);
		});

		it("soft-deletes loop messages without removing retained raw logs", async () => {
			const sql = memoryLoopMessageLogSql();
			const broadcastControl = vi.fn();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql } },
				status: async () => ({ status: "idle" }),
				broadcastControl,
			});
			const recordLoopMessageLog = (BotRuntime.prototype as unknown as {
				recordLoopMessageLog: (messageSeq: number, kind: string, text: string) => void;
			}).recordLoopMessageLog.bind(runtime);
			const loopMessageLogsForSeq = (BotRuntime.prototype as unknown as {
				loopMessageLogsForSeq: (seq: number) => { message: BotLoopMessage; logs: BotLoopMessageLog[] };
			}).loopMessageLogsForSeq.bind(runtime);
			const deleteLoopMessage = (BotRuntime.prototype as unknown as {
				deleteLoopMessage: (botId: string, seq: number) => Promise<{ seq: number; deletedAt: string }>;
			}).deleteLoopMessage.bind(runtime);

			recordLoopMessageLog(1, "provider_request", "request body");
			recordLoopMessageLog(1, "provider_response", "response body");
			const deleted = await deleteLoopMessage("bot_log", 1);
			const retained = loopMessageLogsForSeq(1);

			expect(deleted.seq).toBe(1);
			expect(deleted.deletedAt).toMatch(/^20/);
			expect(retained.message.deletedAt).toBe(deleted.deletedAt);
			expect(retained.logs.map((log) => log.text)).toEqual(["request body", "response body"]);
			expect(broadcastControl).toHaveBeenCalledWith({
				type: "loop_message_deleted",
				seq: 1,
				deletedAt: deleted.deletedAt,
			});
		});

		it("pages retained loop messages by compaction boundaries", () => {
			const rows = [
				{ ...loopMessageRowForTest(1, "run-old", "Old event"), compacted_by: 10 },
				{ ...loopMessageRowForTest(10, "run-compact-1", "Previous summary"), origin: "compaction" as BotLoopMessage["origin"], compacted_by: 20 },
				{ ...loopMessageRowForTest(11, "run-middle", "Middle event"), compacted_by: 20 },
				{ ...loopMessageRowForTest(12, "run-deleted", "Deleted middle event"), compacted_by: 20, deleted_at: "2026-05-05T01:00:00.000Z" },
				{ ...loopMessageRowForTest(20, "run-compact-2", "Current summary"), origin: "compaction" as BotLoopMessage["origin"] },
				loopMessageRowForTest(21, "run-current", "Current event"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number; pageCount: number; newerPage?: number; olderPage?: number; compactionPageBySeq: Record<string, number> } };
			}).loopMessagesPage.bind(runtime);

			const page1 = loopMessagesPage({ page: 1 });
			const page2 = loopMessagesPage({ page: 2 });
			const page3 = loopMessagesPage({ page: 3 });

			expect(page1.messages.map((message) => message.seq)).toEqual([20, 21]);
			expect(page1.page).toMatchObject({
				currentPage: 1,
				pageCount: 3,
				olderPage: 2,
				compactionPageBySeq: { "20": 2, "10": 3 },
			});
			expect(page2.messages.map((message) => message.seq)).toEqual([10, 11]);
			expect(page2.page).toMatchObject({ currentPage: 2, newerPage: 1, olderPage: 3 });
			expect(page3.messages.map((message) => message.seq)).toEqual([1]);
			expect(page3.page).toMatchObject({ currentPage: 3, newerPage: 2 });
		});

		it("shows every active row on page one in context order", () => {
			const rows = [
				{ ...loopMessageRowForTest(1, "run-old", "Old event"), compacted_by: 10 },
				{ ...loopMessageRowForTest(10, "run-compact-1", "Previous active summary"), origin: "compaction" as BotLoopMessage["origin"] },
				{ ...loopMessageRowForTest(11, "run-middle", "Middle event"), compacted_by: 20 },
				{ ...loopMessageRowForTest(20, "run-compact-2", "Current summary"), origin: "compaction" as BotLoopMessage["origin"] },
				loopMessageRowForTest(21, "run-current", "Current event"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number; pageCount: number; newerPage?: number; olderPage?: number; compactionPageBySeq: Record<string, number> } };
			}).loopMessagesPage.bind(runtime);

			const page1 = loopMessagesPage({ page: 1 });
			const page2 = loopMessagesPage({ page: 2 });
			const page3 = loopMessagesPage({ page: 3 });

			expect(page1.messages.map((message) => message.seq)).toEqual([10, 20, 21]);
			expect(page1.page).toMatchObject({
				currentPage: 1,
				pageCount: 3,
				olderPage: 2,
				compactionPageBySeq: { "20": 2, "10": 3 },
			});
			expect(page2.messages.map((message) => message.seq)).toEqual([11]);
			expect(page2.page).toMatchObject({ currentPage: 2, newerPage: 1 });
			expect(page3.messages.map((message) => message.seq)).toEqual([1]);
			expect(page3.page).toMatchObject({ currentPage: 3, newerPage: 1 });
		});

		it("serializes loop message positions and orders active compaction summaries by context position", () => {
			const rows = [
				{ ...loopMessageRowForTest(1, "run-old", "Old event"), compacted_by: 100 },
				{ ...loopMessageRowForTest(20, "run-current", "Current event"), position: 10 },
				{ ...loopMessageRowForTest(100, "run-compact", "Current summary"), position: 5, origin: "compaction" as BotLoopMessage["origin"] },
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number } };
			}).loopMessagesPage.bind(runtime);

			const page1 = loopMessagesPage({ page: 1 });

			expect(page1.messages.map((message) => ({ seq: message.seq, position: message.position }))).toEqual([
				{ seq: 100, position: 5 },
				{ seq: 20, position: 10 },
			]);
		});

		it("keeps incremental loop message fetches on the active page only", () => {
			const rows = [
				{ ...loopMessageRowForTest(1, "run-old", "Old event"), compacted_by: 10 },
				{ ...loopMessageRowForTest(10, "run-compact", "Current summary"), origin: "compaction" as BotLoopMessage["origin"] },
				loopMessageRowForTest(11, "run-current", "Current event"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number } };
			}).loopMessagesPage.bind(runtime);

			expect(loopMessagesPage({ page: 1, after: 10 }).messages.map((message) => message.seq)).toEqual([11]);
			expect(loopMessagesPage({ page: 2, after: 99 }).messages.map((message) => message.seq)).toEqual([1]);
		});

		it("hydrates linked rich tool display payloads without changing minimized tool content", () => {
			const minimizedContent = JSON.stringify([
				{ threadId: "thr_rule", commentId: "cmt_match", forum: "f/rules", title: "Rule 82", author: "u/alice" },
			]);
			const displayPayload = {
				name: "search_threads",
				args: { query: "potato" },
				result: [{
					threadId: "thr_rule",
					commentId: "cmt_match",
					forumHandle: "rules",
					title: "Rule 82",
					snippet: "mashed potato discourse",
					authorHandle: "alice",
					authorDisplayName: "Alice",
				}],
				displayContext: { worldHandle: "sandbox" },
			};
			const rows: LoopMessageRowForTest[] = [
				{
					...loopMessageRowForMessage(1, { role: "tool", tool_call_id: "call-search", content: minimizedContent }, "tool_result"),
					display_event_seq: 42,
					display_event_type: "tool_result",
					display_event_payload_json: JSON.stringify(displayPayload),
				},
				loopMessageRowForMessage(2, { role: "tool", tool_call_id: "call-legacy", content: "{}" }, "tool_result"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number } };
			}).loopMessagesPage.bind(runtime);

			const [richMessage, legacyMessage] = loopMessagesPage({ page: 1 }).messages;

			expect(richMessage?.message.content).toBe(minimizedContent);
			expect(richMessage?.display).toEqual({
				kind: "tool_result",
				eventSeq: 42,
				name: "search_threads",
				args: displayPayload.args,
				result: displayPayload.result,
				context: { worldHandle: "sandbox" },
			});
			expect(legacyMessage?.display).toBeUndefined();
		});

		it("keeps compacted runtime diagnostics behind the active compaction summary", () => {
			const rows: LoopMessageRowForTest[] = [
				{ ...loopMessageRowForTest(1, "run-old", "Old provider event"), compacted_by: 10 },
				{
					...loopMessageRowForMessage(
						2,
						{ role: "user", content: runtimeErrorLoopMessageContent("Inference request failed with status 400.") },
						"runtime_error",
					),
					compacted_by: 10,
					origin: "runtime_error" as BotLoopMessage["origin"],
				},
				{ ...loopMessageRowForTest(10, "run-compact", "Current summary"), origin: "compaction" as BotLoopMessage["origin"] },
				loopMessageRowForTest(11, "run-current", "Current event"),
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql: memoryLoopMessagePageSql(rows) } },
			});
			const loopMessagesPage = (BotRuntime.prototype as unknown as {
				loopMessagesPage: (input: { page: number; after?: number }) => { messages: BotLoopMessage[]; page: { currentPage: number; olderPage?: number } };
			}).loopMessagesPage.bind(runtime);

			const page1 = loopMessagesPage({ page: 1 });
			const page2 = loopMessagesPage({ page: 2 });

			expect(page1.messages.map((message) => message.seq)).toEqual([10, 11]);
			expect(page1.page).toMatchObject({ currentPage: 1, olderPage: 2 });
			expect(page2.messages.map((message) => message.seq)).toEqual([1, 2]);
		});

		it("uses the latest successful compaction summary after a failed compaction row", () => {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: {
							exec: <T,>(sql: string) => {
								if (/FROM events\s+WHERE type = 'compaction'/.test(sql)) {
									return {
										toArray: () => [
											{ payload_json: JSON.stringify({ status: "failed", error: "No response." }) },
											{ payload_json: JSON.stringify({ status: "complete", summary: "I owe Müller a follow-up." }) },
										] as T[],
									};
								}
								return { one: () => ({} as T), toArray: () => [] as T[] };
							},
						},
					},
				},
			});
			const latestCompactionSummary = (BotRuntime.prototype as unknown as {
				latestCompactionSummary: () => string;
			}).latestCompactionSummary.bind(runtime);

			expect(latestCompactionSummary()).toBe("I owe Müller a follow-up.");
		});

		it("stores provider compaction summaries without adding a memory prefix", async () => {
			const candidates = [
				{
					...loopMessageRowForTest(1, "run-compaction-success", "I read the changelog thread."),
					position: 3,
					token_estimate: 10,
				},
				{
					...loopMessageRowForTest(2, "run-compaction-success", "I checked the replies."),
					position: 7,
					token_estimate: 10,
				},
			];
			const appendEvent = vi.fn(async (runId: string, type: string, payload: unknown) => ({
				seq: 101,
				runId,
				type,
				payload,
				tokenEstimate: 1,
				createdAt: "2026-05-01T00:00:01.000Z",
			}));
			const insertLoopMessage = vi.fn((input: { runId: string; message: unknown; position: number }) => ({
				seq: 102,
				runId: input.runId,
				message: input.message,
				position: input.position,
				createdAt: "2026-05-01T00:00:02.000Z",
			}));
			const replaceEventPayload = vi.fn();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				env: {},
				state: {
					storage: {
						sql: {
							exec: vi.fn(() => ({ one: () => ({}), toArray: () => [] })),
						},
					},
				},
				appendEvent,
				recordInferenceSubmission: vi.fn(),
				callProviderForCompaction: async () => ({
					content: "I chose to follow up with Müller about concise release notes.",
					requestBody: "{}",
					rawResponse: "{}",
				}),
				replaceEventPayload,
				insertLoopMessage,
				recordLoopMessageLog: vi.fn(),
				nextLoopMessagePosition: () => 50,
			});
			const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
				compactLoopMessageRows: (
					bot: BotDocument,
					settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
					runId: string,
					signal: AbortSignal,
					rows: unknown[],
					mode: "auto" | "manual",
					metrics: { estimatedContextTokens?: number; threshold?: number },
				) => Promise<void>;
			}).compactLoopMessageRows.bind(runtime);

			await compactLoopMessageRows(
				fakeBotDocument({
					id: "bot_release",
					handle: "release-sage",
					displayName: "Release Sage",
					shortBio: "Summarizes release work.",
					prompt: "Prefer concise changelog memory.",
				}),
				{ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-compaction-success",
				new AbortController().signal,
				candidates,
				"auto",
				{ estimatedContextTokens: 10_000, threshold: 80 },
			);

			expect(insertLoopMessage).toHaveBeenCalledWith(expect.objectContaining({
				message: {
					role: "assistant",
					content: "I chose to follow up with Müller about concise release notes.",
				},
				position: 7,
			}));
			expect(replaceEventPayload).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 101 }), expect.objectContaining({
				status: "complete",
				summary: "I chose to follow up with Müller about concise release notes.",
			}));
		});

		it("marks runtime diagnostics in the compacted ledger span while sending provider-visible synthetic context", async () => {
			const rows: LoopMessageRowForTest[] = [
				loopMessageRowForTest(1, "run-ledger-compact", "Provider-visible old context."),
				{
					...loopMessageRowForMessage(
						2,
						{ role: "assistant", content: defaultReasoningPrefill("budget-bot") },
						"synthetic_context",
					),
					origin: "synthetic_context" as BotLoopMessage["origin"],
				},
				{
					...loopMessageRowForMessage(
						3,
						{ role: "user", content: runtimeErrorLoopMessageContent("Inference request failed with status 400.") },
						"runtime_error",
					),
					origin: "runtime_error" as BotLoopMessage["origin"],
				},
				loopMessageRowForTest(4, "run-ledger-compact", "Provider-visible newer context."),
				{
					...loopMessageRowForMessage(
						5,
						{ role: "user", content: runtimeErrorLoopMessageContent("Inference request failed with status 404.") },
						"runtime_error",
					),
					origin: "runtime_error" as BotLoopMessage["origin"],
				},
			];
			const appendEvent = vi.fn(async (runId: string, type: string, payload: unknown) => ({
				seq: 101,
				runId,
				type,
				payload,
				tokenEstimate: 1,
				createdAt: "2026-05-01T00:00:01.000Z",
			}));
			const recordInferenceSubmission = vi.fn();
			const callProviderForCompaction = vi.fn(async (_settings: unknown, _messages: unknown[]) => ({
				content: "I kept the provider-visible context.",
				requestBody: "{}",
				rawResponse: "{}",
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				env: {},
				state: {
					storage: {
						sql: {
							exec: vi.fn(<T,>(sql: string, ...params: unknown[]) => {
								if (/FROM loop_messages m\s+WHERE m\.compacted_by IS NULL/.test(sql)) {
									return {
										toArray: () =>
											rows
												.filter((row) => row.compacted_by === null && row.deleted_at === null)
												.sort((left, right) => left.position - right.position || left.seq - right.seq) as T[],
									};
								}
								if (/UPDATE loop_messages\s+SET compacted_by = \?/.test(sql)) {
									const row = rows.find((item) => item.seq === Number(params[1]));
									if (row && row.compacted_by === null) {
										row.compacted_by = Number(params[0]);
									}
								}
								return { one: () => ({} as T), toArray: () => [] as T[] };
							}),
						},
					},
				},
				appendEvent,
				recordInferenceSubmission,
				callProviderForCompaction,
				replaceEventPayload: vi.fn(),
				insertLoopMessage: vi.fn((input: { runId: string; message: unknown; position: number }) => ({
					seq: 102,
					runId: input.runId,
					message: input.message,
					position: input.position,
					createdAt: "2026-05-01T00:00:02.000Z",
				})),
				recordLoopMessageLog: vi.fn(),
				updateInferenceSubmissionDisplayMessages: vi.fn(),
				broadcastControl: vi.fn(),
			});
			const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
				compactLoopMessageRows: (
					bot: BotDocument,
					settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
					runId: string,
					signal: AbortSignal,
					rows: unknown[],
					mode: "auto" | "manual",
					metrics: { estimatedContextTokens?: number; threshold?: number },
				) => Promise<void>;
			}).compactLoopMessageRows.bind(runtime);

			await compactLoopMessageRows(
				fakeBotDocument(),
				{ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-ledger-compact",
				new AbortController().signal,
				[rows[0], rows[1], rows[3]],
				"auto",
				{ estimatedContextTokens: 10_000, threshold: 80 },
			);

			const providerMessages = callProviderForCompaction.mock.calls[0]?.[1] as Array<{ content?: unknown }> | undefined;
			const providerText = JSON.stringify(providerMessages);
			expect(providerText).toContain("Provider-visible old context.");
			expect(providerText).toContain(defaultReasoningPrefill("budget-bot"));
			expect(providerText).toContain("Provider-visible newer context.");
			expect(providerText).not.toContain("Inference request failed with status 400");
			expect(rows.map((row) => row.compacted_by)).toEqual([102, 102, 102, 102, null]);
			expect(recordInferenceSubmission).toHaveBeenCalledWith(expect.objectContaining({
				messages: providerMessages,
			}));
		});

		it("shrinks the compaction row batch after provider output length exhaustion", async () => {
			const originalFetch = globalThis.fetch;
			const large = (label: string) => `${label} ${"x".repeat(4_000)}`;
			const rows = [
				loopMessageRowForTest(1, "run-old", large("Old context one that can be compacted.")),
				loopMessageRowForTest(2, "run-old", large("Old context two that should remain active after the shrink retry.")),
				loopMessageRowForTest(3, "run-old", large("Old context three that should remain active after the shrink retry.")),
			];
			const lengthResponse = {
				choices: [{
					finish_reason: "length",
					native_finish_reason: "max_output_tokens",
					message: { role: "assistant", content: null },
				}],
				usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember old context one." }),
					},
				}],
				usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(lengthResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
				vi.stubGlobal("fetch", fetchMock);
				try {
					const replaceEventPayload = vi.fn();
					const recordProviderTokenCalibrationSample = vi.fn();
					const runtime = Object.assign(Object.create(BotRuntime.prototype), {
						env: { BICKR_SIMULATION_MODE: "provider" },
					state: {
						storage: {
							sql: {
								exec: vi.fn((sql: string, ...params: unknown[]) => {
									if (/UPDATE loop_messages/i.test(sql)) {
										const compactedBy = Number(params[0]);
										const seq = Number(params[1]);
										const row = rows.find((item) => item.seq === seq);
										if (row) {
											row.compacted_by = compactedBy;
										}
									}
									return { one: () => ({}), toArray: () => [] };
								}),
							},
						},
						},
						appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
							runtimeEvent(500, runId, type as BotRuntimeEvent["type"], payload),
						broadcastControl: vi.fn(),
						compactionLedgerRows: (providerRows: typeof rows) => providerRows,
					insertLoopMessage: vi.fn((input: { runId: string; message: unknown; position: number }) => ({
						seq: 900,
						runId: input.runId,
						message: input.message,
						position: input.position,
						createdAt: "2026-05-01T00:00:02.000Z",
					})),
						recordInferenceSubmission: vi.fn(),
						recordLoopMessageLog: vi.fn(),
						recordProviderTokenCalibrationSample,
						recordProviderUsage: vi.fn(),
					repairDanglingCommentReferencesAfterCompaction: vi.fn(),
					replaceEventPayload,
					textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
					throwIfStopped: (_runId: string, signal: AbortSignal) => {
						if (signal.aborted) {
							throw new Error("Unexpected abort.");
						}
					},
					updateInferenceSubmissionDisplayMessages: vi.fn(),
				});
				const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
					compactLoopMessageRows: (
						bot: BotDocument,
						settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
						runId: string,
						signal: AbortSignal,
						rows: unknown[],
						mode: "auto" | "manual",
						metrics: Record<string, unknown>,
					) => Promise<void>;
				}).compactLoopMessageRows.bind(runtime);

				await compactLoopMessageRows(
					fakeBotDocument(),
					{ apiKey: "test-key", baseUrl: customProviderBaseUrl, model: "test-model", temperature: 0.2 },
					"run-output-limit-shrink",
					new AbortController().signal,
					rows,
					"auto",
					{},
				);

				expect(fetchMock).toHaveBeenCalledTimes(2);
				const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(JSON.stringify(firstBody.messages)).toContain("Old context three");
				expect(JSON.stringify(secondBody.messages)).toContain("Old context one");
				expect(JSON.stringify(secondBody.messages)).not.toContain("Old context two");
				expect(rows.map((row) => row.compacted_by)).toEqual([900, null, null]);
					expect(recordProviderTokenCalibrationSample).toHaveBeenCalledTimes(2);
					expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(1, expect.objectContaining({
						attempt: 1,
						usage: expect.objectContaining({ promptTokens: 100 }),
					}));
					expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(2, expect.objectContaining({
						attempt: 1,
						usage: expect.objectContaining({ promptTokens: 80 }),
					}));
					expect(replaceEventPayload).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
					status: "complete",
					fromSeq: 1,
					toSeq: 1,
					outputLimitShrinkAttempts: 1,
				}));
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("does not shrink output-limit retries down to a tiny prefix", async () => {
			const originalFetch = globalThis.fetch;
			const large = (char: string) => char.repeat(8_000);
			const rows = [
				loopMessageRowForMessage(1, { role: "assistant", content: "Tiny summary." }, "compaction"),
				loopMessageRowForMessage(2, {
					role: "assistant",
					content: large("a"),
					tool_calls: [{
						id: "call-read",
						type: "function",
						function: { name: "read_thread", arguments: "{}" },
					}],
				}),
				loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-read", content: `Large read result ${large("b")}` }, "tool_result"),
				loopMessageRowForMessage(4, { role: "assistant", content: `Later context ${large("c")}` }),
			] as LoopMessageRowForTest[];
			const lengthResponse = {
				choices: [{
					finish_reason: "length",
					native_finish_reason: "max_output_tokens",
					message: { role: "assistant", content: null },
				}],
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the tiny summary and large read result." }),
					},
				}],
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(lengthResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const replaceEventPayload = vi.fn();
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					env: { BICKR_SIMULATION_MODE: "provider" },
					state: {
						storage: {
							sql: {
								exec: vi.fn((sql: string, ...params: unknown[]) => {
									if (/UPDATE loop_messages/i.test(sql)) {
										const compactedBy = Number(params[0]);
										const seq = Number(params[1]);
										const row = rows.find((item) => item.seq === seq);
										if (row) {
											row.compacted_by = compactedBy;
										}
									}
									return { one: () => ({}), toArray: () => [] };
								}),
							},
						},
					},
					appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) =>
						runtimeEvent(501, runId, type as BotRuntimeEvent["type"], payload),
					broadcastControl: vi.fn(),
					compactionLedgerRows: (providerRows: typeof rows) => providerRows,
					insertLoopMessage: vi.fn((input: { runId: string; message: unknown; position: number }) => ({
						seq: 901,
						runId: input.runId,
						message: input.message,
						position: input.position,
						createdAt: "2026-05-01T00:00:02.000Z",
					})),
					recordInferenceSubmission: vi.fn(),
					recordLoopMessageLog: vi.fn(),
					recordProviderTokenCalibrationSample: vi.fn(),
					recordProviderUsage: vi.fn(),
					repairDanglingCommentReferencesAfterCompaction: vi.fn(),
					replaceEventPayload,
					textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
					throwIfStopped: (_runId: string, signal: AbortSignal) => {
						if (signal.aborted) {
							throw new Error("Unexpected abort.");
						}
					},
					updateInferenceSubmissionDisplayMessages: vi.fn(),
				});
				const compactLoopMessageRows = (BotRuntime.prototype as unknown as {
					compactLoopMessageRows: (
						bot: BotDocument,
						settings: { apiKey: string; baseUrl: string; model: string; temperature: number },
						runId: string,
						signal: AbortSignal,
						rows: unknown[],
						mode: "auto" | "manual",
						metrics: Record<string, unknown>,
					) => Promise<void>;
				}).compactLoopMessageRows.bind(runtime);

				await compactLoopMessageRows(
					fakeBotDocument(),
					{ apiKey: "test-key", baseUrl: customProviderBaseUrl, model: "test-model", temperature: 0.2 },
					"run-output-limit-tiny-prefix",
					new AbortController().signal,
					rows,
					"auto",
					{},
				);

				expect(fetchMock).toHaveBeenCalledTimes(2);
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(JSON.stringify(secondBody.messages)).toContain("Tiny summary.");
				expect(JSON.stringify(secondBody.messages)).toContain("Large read result");
				expect(JSON.stringify(secondBody.messages)).not.toContain("Later context");
				expect(rows.map((row) => row.compacted_by)).toEqual([901, 901, 901, null]);
				expect(replaceEventPayload).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
					status: "complete",
					fromSeq: 1,
					toSeq: 3,
					messageCount: 3,
					outputLimitShrinkAttempts: 1,
				}));
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("uses the computed next compaction point for soft compaction", async () => {
			const row = loopMessageRowForTest(1, "run-threshold", "Old context.");
			const compactLoopMessageRows = vi.fn();
			const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const expectedLimits = providerCompactionSummaryLimitsForChat(
				bot,
				[{ role: "assistant", content: "Old context." }],
				calibration,
			);
			let promptTokens = expectedLimits.nextCompactionTokens;
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeProviderRequestMessages: () => [{ role: "system", content: "System." }, { role: "assistant", content: "Old context." }],
				currentCompactionContextEstimate: () => ({ totalTokens: 4, rowTokens: 4, rows: [{ row, tokens: 4 }], calibration }),
				compactionRowsForEstimatedBudget: () => [row],
				compactLoopMessageRows,
				estimateProviderPromptTokens: () => providerPromptEstimateForTokens(promptTokens),
			});
			const compactIfNeeded = (BotRuntime.prototype as unknown as {
				compactIfNeeded: (
					bot: BotDocument,
					settings: Record<string, unknown>,
					runId: string,
					signal: AbortSignal,
				) => Promise<void>;
			}).compactIfNeeded.bind(runtime);

			await compactIfNeeded(bot, {}, "run-threshold", new AbortController().signal);
			expect(compactLoopMessageRows).not.toHaveBeenCalled();

			promptTokens = expectedLimits.nextCompactionTokens + 1;
			await compactIfNeeded(bot, {}, "run-threshold", new AbortController().signal);
			expect(compactLoopMessageRows).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"run-threshold",
				expect.any(AbortSignal),
				[row],
				"auto",
				expect.objectContaining({
					estimatedContextTokens: 4,
					estimatedPromptTokens: expectedLimits.nextCompactionTokens + 1,
					threshold: expectedLimits.nextCompactionTokens,
				}),
			);
		});

		it("hydrates only the newest dangling comment reference after compaction", () => {
			const toolRow = (seq: number, position: number, content: unknown) => ({
				seq,
				position,
				run_id: "run-repair",
				role: "tool",
				message_json: JSON.stringify({
					role: "tool",
					tool_call_id: `call_${seq}`,
					content: JSON.stringify(content),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
				stream_seq: null,
				compacted_by: null,
				deleted_at: null,
				created_at: "2026-05-01T00:00:00.000Z",
				has_logs: 0,
			});
			const rows = [
				toolRow(20, 20, { content: [{ type: "comment", id: "cmt_a", commentId: "cmt_a", threadId: "thr_repair" }] }),
				toolRow(21, 21, {
					content: [
						{ type: "comment", id: "cmt_b", commentId: "cmt_b", threadId: "thr_repair" },
						{ type: "comment", id: "cmt_c", commentId: "cmt_c", threadId: "thr_repair", body: "Still anchored." },
					],
				}),
				toolRow(22, 22, {
					content: [
						{ type: "comment", id: "cmt_a", commentId: "cmt_a", threadId: "thr_repair" },
						{ type: "comment", id: "cmt_b", commentId: "cmt_b", threadId: "thr_repair" },
					],
				}),
			];
			const sql = {
				exec: vi.fn(<T,>(query: string, ...params: unknown[]) => {
					const normalized = query.trim().replace(/\s+/g, " ");
					if (/FROM loop_messages m WHERE m\.compacted_by IS NULL/.test(normalized)) {
						const minPosition = Number(params[0]);
						const samePosition = Number(params[1]);
						const minSeq = Number(params[2]);
						return {
							toArray: () =>
								rows
									.filter((row) => row.compacted_by === null && row.deleted_at === null && row.role === "tool")
									.filter((row) => row.position > minPosition || (row.position === samePosition && row.seq > minSeq))
									.sort((left, right) => left.position - right.position || left.seq - right.seq) as T[],
						};
					}
					if (/UPDATE loop_messages SET message_json = \?, token_estimate = \? WHERE seq = \?/.test(normalized)) {
						const row = rows.find((item) => item.seq === Number(params[2]));
						if (row) {
							row.message_json = String(params[0]);
							row.token_estimate = Number(params[1]);
						}
					}
					return {
						one: () => ({} as T),
						toArray: () => [] as T[],
					};
				}),
			};
			const recordLoopMessageLog = vi.fn();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: { storage: { sql } },
				recordLoopMessageLog,
			});
			const repair = (BotRuntime.prototype as unknown as {
				repairDanglingCommentReferencesAfterCompaction: (
					summarySeq: number,
					summaryPosition: number,
					summaryMessage: { role: "assistant"; content: string },
					compactedCommentBodies: ReadonlyMap<string, string>,
				) => void;
			}).repairDanglingCommentReferencesAfterCompaction.bind(runtime);

			repair(
				10,
				10,
				{ role: "assistant", content: "Compacted summary without structured comment JSON." },
				new Map([
					["cmt_a", "Hydrated A."],
					["cmt_b", "Hydrated B."],
					["cmt_c", "Hydrated C."],
				]),
			);

			const contentForRow = (seq: number) =>
				JSON.parse(JSON.parse(rows.find((row) => row.seq === seq)?.message_json ?? "{}").content) as { content: Array<Record<string, unknown>> };
			expect(contentForRow(20).content[0]?.body).toBeUndefined();
			expect(contentForRow(21).content[0]?.body).toBeUndefined();
			expect(contentForRow(21).content[1]?.body).toBe("Still anchored.");
			expect(contentForRow(22).content).toEqual([
				expect.objectContaining({ id: "cmt_a", commentId: "cmt_a", body: "Hydrated A." }),
				expect.objectContaining({ id: "cmt_b", commentId: "cmt_b", body: "Hydrated B." }),
			]);
			expect(rows.find((row) => row.seq === 22)?.token_estimate).toBeGreaterThan(1);
			expect(recordLoopMessageLog.mock.calls.map((call) => call.slice(0, 2))).toEqual([
				[22, "message"],
				[22, "tool_result"],
			]);
		});

		it("builds translation requests with required tool output", () => {
			const request = providerTranslationRequest(
				{
					baseUrl: customProviderBaseUrl,
					model: "openai/gpt-4o-mini",
					providerRouting: { max_price: { prompt: 0.2, completion: 0.4 } },
					prompt: "Translate to Pirate.",
					reasoningEffort: "low",
					temperature: 0,
				},
				"Hello world.",
			);

			expect(request.model).toBe("openai/gpt-4o-mini");
			expect(request.messages).toEqual([
				{ role: "system", content: "Translate to Pirate.\n\nYou MUST use one of the following tools: save_translation." },
				{
					role: "user",
					content: "Translate the following text. You must respond by calling the save_translation tool with the translated text in the translation argument. Do not reply as plain text.\n\nText:\nHello world.",
				},
			]);
			expect(request.provider).toEqual({ max_price: { prompt: 0.2, completion: 0.4 } });
			const translationTool = request.tools[0] as Extract<ProviderToolDefinition, { type: "function" }>;
			expect(translationTool.function.name).toBe("save_translation");
			expect(request.tool_choice).toBe("required");
			expect(request.parallel_tool_calls).toBe(false);
			expect(request.stream).toBe(false);
			expect(request.temperature).toBe(0);
			expect(request.reasoning).toEqual({ effort: "low", exclude: false });
			expect(translationTool.function.parameters).toEqual({
				type: "object",
				properties: {
					translation: { type: "string" },
				},
				required: ["translation"],
				additionalProperties: false,
			});
			expect("response_format" in request).toBe(false);

			const railroadRequest = providerTranslationRequest(
				{
					baseUrl: customProviderBaseUrl,
					model: "openai/gpt-4o-mini",
					prompt: "Translate to Pirate.",
					temperature: 0,
					toolCalls: "railroad",
				},
				"Hello world.",
			);
			expect("tool_choice" in railroadRequest).toBe(false);
			expect(railroadRequest.messages[0]?.content).toContain("You MUST use one of the following tools: save_translation.");
		});

		it("compacts old context from local token estimates before provider inference", async () => {
			const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const allowedPromptTokens = providerCompactionSummaryLimitsForChat(bot, [], calibration).nextCompactionTokens;
			let activeMessages: Array<Record<string, unknown>> = [
			{ role: "assistant", content: "Old history that can be compacted." },
			{ role: "assistant", content: "Current notification setup must remain." },
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerRequests: Array<Array<Record<string, unknown>>> = [];
		const callProviderForTokenProbe = vi.fn();
		const recordInferenceSubmission = vi.fn();
		const compactedRows: unknown[][] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => activeMessages,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return { seq: events.length, runId, type, payload, tokenEstimate: 0, createdAt: new Date().toISOString() };
			},
			appendLoopMessage: () => ({ seq: 99, runId: "run-budget", role: "assistant", message: {}, origin: "provider_response", tokenEstimate: 0, createdAt: new Date().toISOString() }),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
				providerRequests.push(messages);
				return providerResponseWithContent("I have enough context now.");
			},
			callProviderForTokenProbe,
				estimateProviderPromptTokens: (_settings: unknown, messages: Array<Record<string, unknown>>) =>
					providerPromptEstimateForTokens(messages.some((message) => String(message.content).includes("Old history")) ? 20_000 : 10_000),
				textTokenCalibration: () => calibration,
				compactLoopMessageRows: async (_bot: unknown, _settings: unknown, _runId: string, _signal: AbortSignal, rows: unknown[]) => {
				compactedRows.push(rows);
				activeMessages = [
					{ role: "assistant", content: "I remember the old history as a concise summary." },
					{ role: "assistant", content: "Current notification setup must remain." },
				];
			},
				compactionRowSelectionForEstimatedBudget: () => ({
					rows: activeMessages.some((message) => String(message.content).includes("Old history")) ? [loopMessageRowForTest(1, "run-old", "Old history that can be compacted.")] : [],
					overBudgetFallback: false,
				}),
			recordInferenceSubmission,
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
				runProviderLoop(
					bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-budget",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(callProviderForTokenProbe).not.toHaveBeenCalled();
		expect(compactedRows).toHaveLength(1);
		expect(providerRequests).toHaveLength(1);
		expect(messageListText(providerRequests[0] ?? [])).not.toContain("Old history that can be compacted.");
		expect(messageListText(providerRequests[0] ?? [])).toContain("I remember the old history");
		expect(recordInferenceSubmission).toHaveBeenCalledTimes(1);
		expect(events.map((event) => event.type)).toEqual(["provider_token_estimate", "provider_token_estimate", "provider_request"]);
			expect(events[0]?.payload).toMatchObject({
				promptTokens: 20_000,
				allowedPromptTokens,
				overBudgetTokens: 20_000 - allowedPromptTokens,
			});
		});

		it("compacts current tick messages when local prompt estimates overflow", async () => {
			const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const allowedPromptTokens = providerCompactionSummaryLimitsForChat(bot, [], calibration).nextCompactionTokens;
			let activeMessages: Array<Record<string, unknown>> = [
			{ role: "assistant", content: "Current notification setup must remain." },
			{ role: "tool", content: "Large current thread read result that overflowed the prompt." },
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerRequests: Array<Array<Record<string, unknown>>> = [];
		let compactionSelectionCalls = 0;
		const compactionMetrics: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => activeMessages,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return { seq: events.length, runId, type, payload, tokenEstimate: 0, createdAt: new Date().toISOString() };
			},
			appendLoopMessage: () => ({ seq: 99, runId: "run-current-compact", role: "assistant", message: {}, origin: "provider_response", tokenEstimate: 0, createdAt: new Date().toISOString() }),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
				providerRequests.push(messages);
				return providerResponseWithContent("The large thread read is now summarized.");
			},
			callProviderForTokenProbe: vi.fn(),
				estimateProviderPromptTokens: (_settings: unknown, messages: Array<Record<string, unknown>>) =>
					providerPromptEstimateForTokens(messageListText(messages).includes("Large current thread read result") ? 20_000 : 10_000),
				textTokenCalibration: () => calibration,
				compactLoopMessageRows: async (
				_bot: unknown,
				_settings: unknown,
				_runId: string,
				_signal: AbortSignal,
				_rows: unknown[],
				_mode: string,
				metrics: Record<string, unknown>,
			) => {
				compactionMetrics.push(metrics);
				activeMessages = [
					{ role: "assistant", content: "Current notification setup must remain." },
					{ role: "assistant", content: "I remember the large current thread read as a concise summary." },
				];
			},
				compactionRowSelectionForEstimatedBudget: () => {
					compactionSelectionCalls += 1;
					return {
						rows: activeMessages.some((message) => String(message.content).includes("Large current")) ?
							[loopMessageRowForTest(7, "run-current-compact", "Large current thread read result that overflowed the prompt.")]
						:	[],
						overBudgetFallback: false,
					};
				},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
				runProviderLoop(
					bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-current-compact",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(compactionSelectionCalls).toBe(1);
			expect(compactionMetrics).toEqual([
				expect.objectContaining({ estimatedPromptTokens: 20_000, overBudgetTokens: 20_000 - allowedPromptTokens }),
			]);
		expect(compactionMetrics[0]).not.toHaveProperty("currentRunIncluded");
		expect(providerRequests).toHaveLength(1);
		expect(messageListText(providerRequests[0] ?? [])).not.toContain("Large current thread read result");
		expect(messageListText(providerRequests[0] ?? [])).toContain("large current thread read as a concise summary");
		expect(events.map((event) => event.type)).toEqual(["provider_token_estimate", "provider_token_estimate", "provider_request"]);
	});

	it("compacts a contiguous provider-history prefix when recurring context precedes current tool results", async () => {
		const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
		const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
		const currentRunId = "run-recurring-current-tool";
		const rows = [
			{
				...loopMessageRowForMessage(
					1,
					{ role: "assistant", content: defaultReasoningPrefill("budget-bot") },
					"synthetic_context",
				),
				run_id: "run-old-recurring-context",
			},
			{
				...loopMessageRowForMessage(
					2,
					{
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: "call-current-read",
								type: "function",
								function: { name: "read_thread", arguments: "{}" },
							},
						],
					},
				),
				run_id: currentRunId,
			},
			{
				...loopMessageRowForMessage(
					3,
					{
						role: "tool",
						tool_call_id: "call-current-read",
						content: "Large current thread read result.\n".repeat(4_000),
					},
					"tool_result",
				),
				run_id: currentRunId,
			},
			{
				...loopMessageRowForMessage(
					4,
					{ role: "user", content: runtimeErrorLoopMessageContent("Context compaction did not reduce the prompt.") },
					"runtime_error",
				),
				run_id: currentRunId,
			},
		];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const compactedSeqs: number[][] = [];
		let compacted = false;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessageRows: () => rows,
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			botWithCurrentRuntimeBudget: async (current: BotDocument) => current,
			compactLoopMessageRows: async (
				_bot: unknown,
				_settings: unknown,
				_runId: string,
				_signal: AbortSignal,
				selected: Array<{ seq: number }>,
			) => {
				compactedSeqs.push(selected.map((row) => row.seq));
				compacted = true;
				return selected;
			},
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(compacted ? 10_000 : 20_000),
			textTokenCalibration: () => calibration,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const ensureProviderPromptWithinBudget = (BotRuntime.prototype as unknown as {
			ensureProviderPromptWithinBudget: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				signal: AbortSignal,
				providerTools: ProviderToolDefinition[],
			) => Promise<{ contextWindowTokens?: number; promptTokens: number }>;
		}).ensureProviderPromptWithinBudget.bind(runtime);

		const result = await ensureProviderPromptWithinBudget(
			bot,
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			currentRunId,
			new AbortController().signal,
			toolDefinitionsForProviderRound(),
		);

		expect(result.promptTokens).toBe(10_000);
			expect(compactedSeqs).toEqual([[1, 2, 3]]);
		expect(events.map((event) => event.type)).toEqual(["provider_token_estimate", "provider_token_estimate"]);
	});

	it("applies the current context budget during prompt budget checks", async () => {
		const staleBot = fakeBotDocument({ contextWindowTokens: 16_000 });
		const currentBot = fakeBotDocument({ contextWindowTokens: 64_000 });
		const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			botWithCurrentRuntimeBudget: async () => currentBot,
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(15_000),
			textTokenCalibration: () => calibration,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const ensureProviderPromptWithinBudget = (BotRuntime.prototype as unknown as {
			ensureProviderPromptWithinBudget: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				signal: AbortSignal,
				providerTools: ProviderToolDefinition[],
			) => Promise<{ contextWindowTokens?: number; promptTokens: number }>;
		}).ensureProviderPromptWithinBudget.bind(runtime);

		const result = await ensureProviderPromptWithinBudget(
			staleBot,
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			"run-fresh-budget",
			new AbortController().signal,
			toolDefinitionsForProviderRound(),
		);

		expect(result).toMatchObject({ contextWindowTokens: 64_000, promptTokens: 15_000 });
		expect(events[0]?.payload).toMatchObject({
			contextWindowTokens: 64_000,
			overBudgetTokens: 0,
		});
	});

	it("leaves the completion reserve available at the compaction cutoff", async () => {
		const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
		const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
		const limits = providerCompactionSummaryLimitsForChat(bot, [], calibration, toolDefinitionsForProviderRound());
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			botWithCurrentRuntimeBudget: async (current: BotDocument) => current,
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(limits.nextCompactionTokens),
			textTokenCalibration: () => calibration,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const ensureProviderPromptWithinBudget = (BotRuntime.prototype as unknown as {
			ensureProviderPromptWithinBudget: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				signal: AbortSignal,
				providerTools: ProviderToolDefinition[],
			) => Promise<{ allowedPromptTokens: number; maxCompletionTokens: number; promptTokens: number }>;
		}).ensureProviderPromptWithinBudget.bind(runtime);

		const result = await ensureProviderPromptWithinBudget(
			bot,
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			"run-cutoff-reserve",
			new AbortController().signal,
			toolDefinitionsForProviderRound(),
		);

		expect(result).toMatchObject({
			allowedPromptTokens: limits.nextCompactionTokens,
			maxCompletionTokens: providerContextCompletionReserveTokens,
			promptTokens: limits.nextCompactionTokens,
		});
		expect(result.maxCompletionTokens).toBeGreaterThanOrEqual(providerContextCompletionReserveTokens);
		expect(events[0]?.payload).toMatchObject({
			allowedPromptTokens: limits.nextCompactionTokens,
			maxCompletionTokens: providerContextCompletionReserveTokens,
			promptTokens: limits.nextCompactionTokens,
		});
	});

	it("stops prompt-budget compaction after three unsuccessful attempts", async () => {
		const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
		const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
		const row = loopMessageRowForTest(1, "run-stuck-compaction", "Old summary that still cannot fit.");
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		let compactCalls = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [{ role: "assistant", content: "Still too large after compaction." }],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			botWithCurrentRuntimeBudget: async (current: BotDocument) => current,
			compactLoopMessageRows: async () => {
				compactCalls += 1;
				return [row];
			},
				compactionRowSelectionForEstimatedBudget: () => ({ rows: [row], overBudgetFallback: false }),
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(20_000),
			textTokenCalibration: () => calibration,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const ensureProviderPromptWithinBudget = (BotRuntime.prototype as unknown as {
			ensureProviderPromptWithinBudget: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				signal: AbortSignal,
				providerTools: ProviderToolDefinition[],
			) => Promise<unknown>;
		}).ensureProviderPromptWithinBudget.bind(runtime);

		await expect(
			ensureProviderPromptWithinBudget(
				bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-stuck-compaction",
				new AbortController().signal,
				toolDefinitionsForProviderRound(),
			),
		).rejects.toThrow("after 3 attempts");

		expect(compactCalls).toBe(3);
		expect(events.map((event) => event.type)).toEqual([
			"provider_token_estimate",
			"provider_token_estimate",
			"provider_token_estimate",
			"provider_token_estimate",
		]);
	});

		it("fails before provider inference when current context alone exceeds the estimated budget", async () => {
			const bot = fakeBotDocument({ contextWindowTokens: 16_000 });
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 0 };
			const allowedPromptTokens = providerCompactionSummaryLimitsForChat(bot, [], calibration).nextCompactionTokens;
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const callProvider = vi.fn();
		const recordInferenceSubmission = vi.fn();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [{ role: "assistant", content: "Current setup is already too large." }],
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return { seq: events.length, runId, type, payload, tokenEstimate: 0, createdAt: new Date().toISOString() };
			},
			callProvider,
				callProviderForTokenProbe: vi.fn(),
				estimateProviderPromptTokens: () => providerPromptEstimateForTokens(20_000),
				textTokenCalibration: () => calibration,
					compactionRowSelectionForEstimatedBudget: () => ({ rows: [], overBudgetFallback: false }),
			recordInferenceSubmission,
			recordProviderUsage: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
				runProviderLoop(
					bot,
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-current-too-large",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toThrow("Prompt context is too large");

		expect(callProvider).not.toHaveBeenCalled();
			expect(recordInferenceSubmission).not.toHaveBeenCalled();
			expect(events.map((event) => event.type)).toEqual(["provider_token_estimate"]);
			expect(events[0]?.payload).toMatchObject({ promptTokens: 20_000, allowedPromptTokens });
		});
});
