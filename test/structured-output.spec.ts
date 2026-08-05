import {
	BotRuntime,
	compactionReasoningPolicyForModel,
	customProviderBaseUrl,
	describe,
	expect,
	fakeBotDocument,
	it,
	lt,
	metaCompactionToolName,
	PersistentCompactionReductionFailureError,
	providerAvatarDescriptionReasoningForSettings,
	providerCompactionMessages,
	providerCompactionRequest,
	providerCompactionSummaryLimitsForChat,
	providerCompactionSummaryProperty,
	providerCompactionSummaryPropertyDescription,
	providerCompactionSummarySchemaDescription,
	providerContextCompletionReserveTokens,
	runtimeFailureLogs,
	sseStream,
	toolDefinitionsForProviderRound,
	vi,
} from "./helpers/index-harness";
import type {
	BotInferenceSubmissionMessage,
	ProviderToolDefinition,
} from "./helpers/index-harness";

// TODO(#12): move next to module on extraction.
describe("Structured output", () => {

		it("builds structured-output provider compaction requests by default over the verbatim compacted chat", () => {
			const bot = fakeBotDocument({
				id: "bot_release",
				handle: "release-sage",
				displayName: "Release Sage",
				shortBio: "Summarizes release work.",
				prompt: "Prefer concise changelog memory.",
			});
			const compactedMessages: Parameters<typeof providerCompactionMessages>[1] = [
				{
					role: "assistant",
					content: "I decided to read a thread about changelogs.",
				},
				{
					role: "tool",
					tool_call_id: "call_read",
					content: JSON.stringify({
						thread: { title: "Release notes", author: { username: "muller" } },
					}),
				},
			];
			const messages = providerCompactionMessages(bot, compactedMessages);
			const request = providerCompactionRequest(
				{
					model: "test-model",
					providerRouting: { sort: "price" },
					reasoningEffort: "high",
				},
				messages,
			);

			expect(request).toMatchObject({
				model: "test-model",
				provider: { sort: "price" },
				stream: false,
				temperature: 0.2,
				parallel_tool_calls: false,
			});
			expect(request.reasoning).toBeUndefined();
			expect(request.tool_choice).toBe("none");
			const requestTools = request.tools ?? [];
			expect(requestTools.some((tool) => tool.type === "function" && tool.function.name === "read_thread")).toBe(true);
			expect(requestTools.some((tool) => tool.type === "function" && tool.function.name === metaCompactionToolName)).toBe(false);
			expect(request.response_format).toMatchObject({
				type: "json_schema",
				json_schema: {
					name: "compaction_summary",
					description: providerCompactionSummarySchemaDescription,
					strict: true,
					schema: {
						type: "object",
						description: providerCompactionSummarySchemaDescription,
						properties: {
							[providerCompactionSummaryProperty]: {
								type: "string",
								description: providerCompactionSummaryPropertyDescription,
								minLength: 1,
								maxLength: 4000,
							},
						},
						required: [providerCompactionSummaryProperty],
						additionalProperties: false,
					},
				},
			});
			const summaryProperty = request.response_format?.json_schema.schema.properties[providerCompactionSummaryProperty];
			expect(summaryProperty?.description).toContain("must never be a verbatim copy");
			expect(summaryProperty?.description).toContain("prior summary passages");
			expect(messages[0]?.role).toBe("system");
			expect(messages[0]?.content).toContain("Your Bickr handle is u/release-sage");
			expect(messages[0]?.content).toContain("read_thread");
			expect(messages.slice(1, 3)).toEqual(compactedMessages);
			expect(messages[3]).toMatchObject({ role: "user" });
			expect(messages[3]?.content).toContain("META: Context compaction required.");
			expect(messages[3]?.content).toContain("Don't spend any time thinking about this; respond immediately with JSON summary.");
			expect(messages[3]?.content).toContain("structured output schema");
			expect(messages[3]?.content).toContain("do not use any Bickr control");
			expect(messages[3]?.content).toContain("u/release-sage");
			expect(messages[3]?.content).toContain(`"${providerCompactionSummaryProperty}" field`);
			expect(messages[3]?.content).toContain("only the recent events being compacted");
			expect(messages[3]?.content).toContain("excluding the system instructions and persona prompt");
			expect(messages[3]?.content).toContain("long-term memory");
			expect(messages[3]?.content).toContain("4000 characters");
			expect(messages[3]?.content).not.toMatch(/\bbot\b|\bAI\b|\bmodel\b|\bassistant\b|\bagent\b/i);
			expect(messages).toHaveLength(4);
		});

		it("omits no-thinking compaction wording for every enabled reasoning selection", () => {
			const bot = fakeBotDocument({ handle: "release-sage" });
			const compactedMessages = [{ role: "assistant" as const, content: "I remember a long release discussion." }];
			const explicitMessages = providerCompactionMessages(
				bot,
				compactedMessages,
				undefined,
				undefined,
				"structured_output",
				compactionReasoningPolicyForModel("deepseek/deepseek-v4-flash-0731", true).selection,
			);
			const modelDefaultMessages = providerCompactionMessages(
				bot,
				compactedMessages,
				undefined,
				undefined,
				"structured_output",
				{ kind: "model_default", effort: "minimal" },
			);

			expect(explicitMessages.at(-1)?.content).not.toContain("Don't spend any time thinking about this");
			expect(modelDefaultMessages.at(-1)?.content).not.toContain("Don't spend any time thinking about this");
			expect(providerAvatarDescriptionReasoningForSettings({
				baseUrl: "https://openrouter.ai/api/v1",
				model: "deepseek/deepseek-v4-flash-0731",
			})).toEqual({ effort: "none", exclude: false });
		});

		it("builds isolated tool-call provider compaction requests when selected", () => {
			const bot = { ...fakeBotDocument({ prompt: "Prefer concise changelog memory." }), handle: "release-sage", displayName: lt("Release Sage") };
			const compactedMessages: Parameters<typeof providerCompactionMessages>[1] = [
				{ role: "assistant", content: "I decided to read a thread about changelogs." },
			];
			const limits = { minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 };
			const messages = providerCompactionMessages(bot, compactedMessages, limits, undefined, "tool_call");
			const request = providerCompactionRequest({ model: "test-model" }, messages, limits, undefined, "tool_call");

			expect(request.tool_choice).toBe("required");
			const requestTools = request.tools ?? [];
			expect(requestTools).toHaveLength(1);
			const metaTool = requestTools.find((tool) => tool.type === "function" && tool.function.name === metaCompactionToolName);
			expect(metaTool).toMatchObject({
				type: "function",
				function: {
					name: metaCompactionToolName,
					description: expect.stringContaining("Use only when directed."),
				},
			});
			expect(metaTool?.type === "function" ? metaTool.function.parameters.description : undefined)
				.toBe(providerCompactionSummarySchemaDescription);
			expect(metaTool?.type === "function" ? metaTool.function.parameters.properties[providerCompactionSummaryProperty] : undefined).toMatchObject({
				type: "string",
				description: providerCompactionSummaryPropertyDescription,
				minLength: 1,
				maxLength: 4000,
			});
			expect(metaTool?.type === "function" ? metaTool.function.parameters.properties[providerCompactionSummaryProperty].description : undefined)
				.toContain("must never be a verbatim copy");
			expect(requestTools.some((tool) => tool.type === "function" && tool.function.name === "read_thread")).toBe(false);
			expect("response_format" in request).toBe(false);
			expect(messages.at(-2)?.content).toContain("only the recent events being compacted");
			expect(messages.at(-2)?.content).toContain("excluding the system instructions and persona prompt");
			expect(messages.at(-1)).toEqual({
				role: "user",
				content: `You must respond by calling the ${metaCompactionToolName} tool. Put the summary in the "${providerCompactionSummaryProperty}" argument. You must produce a _summary_ of the events, and it MUST be shorter than the input, so don't just repeat it with minor modifications; you MUST shorten it, even if it's already a summary! Use between 1 and 4000 characters. Do not reply as plain text.`,
			});
			const railroadRequest = providerCompactionRequest(
				{
					model: "test-model",
					toolCalls: "railroad",
				},
				messages,
				limits,
				undefined,
				"tool_call",
			);
			const coercedAtWillRequest = providerCompactionRequest(
				{
					model: "test-model",
					toolCalls: "at_will",
				},
				messages,
				limits,
				undefined,
				"tool_call",
			);
			expect("tool_choice" in railroadRequest).toBe(false);
			expect("tool_choice" in coercedAtWillRequest).toBe(false);
			expect(messages[0]?.content).toContain(`You MUST use ${metaCompactionToolName}.`);
			expect(messages[0]?.content).not.toContain("read_thread");
		});

		it("builds cache-friendly provider compaction requests with the shared tool schema", () => {
			const bot = fakeBotDocument({ prompt: "Prefer concise changelog memory." });
			const compactedMessages: Parameters<typeof providerCompactionMessages>[1] = [
				{ role: "assistant", content: "I decided to read a thread about changelogs." },
			];
			const limits = { minLength: 250, maxLength: 4000 };
			const tools = toolDefinitionsForProviderRound(limits.maxLength, { includeMetaCompactionTool: true });
			const messages = providerCompactionMessages(bot, compactedMessages, limits, tools, "tool_call_cache_friendly");
			const request = providerCompactionRequest(
				{ model: "test-model" },
				messages,
				{ ...limits, maxCompletionTokens: 1000 },
				tools,
				"tool_call_cache_friendly",
			);

			const requestTools = request.tools ?? [];
			expect(requestTools).toHaveLength(toolDefinitionsForProviderRound().length);
			expect(requestTools.some((tool) => tool.type === "function" && tool.function.name === "read_thread")).toBe(true);
			const metaTool = requestTools.find((tool) => tool.type === "function" && tool.function.name === metaCompactionToolName);
			expect(metaTool?.type === "function" ? metaTool.function.parameters.description : undefined)
				.toBe(providerCompactionSummarySchemaDescription);
			expect(metaTool?.type === "function" ? metaTool.function.parameters.properties[providerCompactionSummaryProperty] : undefined).toMatchObject({
				description: providerCompactionSummaryPropertyDescription,
				minLength: 1,
				maxLength: 4000,
			});
			expect(metaTool?.type === "function" ? metaTool.function.parameters.properties[providerCompactionSummaryProperty].description : undefined)
				.toContain("must never be a verbatim copy");
			expect(messages).toHaveLength(3);
			expect(messages[0]?.content).toContain(`${metaCompactionToolName} may only be used when directed.`);
		});

		it("derives provider compaction prompt lengths from settings and compacted characters", () => {
			const bot = fakeBotDocument({
				contextWindowTokens: 50_000,
				compactionSummaryPercent: 10,
				compactionMaxCharacters: 20_000,
			});
			const compactedMessages = [{ role: "assistant" as const, content: "x".repeat(30_000) }];
			const limits = providerCompactionSummaryLimitsForChat(
				bot,
				compactedMessages,
				{ tokensPerCharacter: 0.25, sampleCount: 3 },
			);
			const messages = providerCompactionMessages(bot, compactedMessages, limits);
			const request = providerCompactionRequest({ model: "test-model" }, messages, limits);

			expect(limits).toMatchObject({
				minLength: 3001,
				maxLength: 20_000,
				configuredMaxCharacters: 20_000,
				compactionSummaryPercent: 10,
			});
			expect(limits.anticipatedSummaryTokens).toBe(Math.ceil(limits.minLength * limits.tokensPerCharacter));
			expect(limits.maxSummaryTokens).toBe(Math.ceil(limits.maxLength * limits.tokensPerCharacter));
			expect(limits.maxCompletionTokens).toBeGreaterThan(5_000);
			expect(limits.nextCompactionTokens).toBe(50_000 - providerContextCompletionReserveTokens);
			expect(limits.compactionInputTokens).toBeGreaterThan(40_000);
			expect(request.max_completion_tokens).toBe(limits.maxCompletionTokens);
			expect((request.tools ?? []).some((item) => item.type === "function" && item.function.name === metaCompactionToolName)).toBe(false);
			expect(request.response_format?.json_schema.schema.properties[providerCompactionSummaryProperty]).toMatchObject({
				minLength: 1,
				maxLength: 20_000,
			});
			expect(messages[2]?.content).toContain("between 3001 and 20000 characters");
		});

		it("keeps fixed prompt overhead out of the normal compaction cutoff", () => {
			const compactedMessages = [{ role: "assistant" as const, content: "x".repeat(30_000) }];
			const calibration = { tokensPerCharacter: 0.25, sampleCount: 3 };
			const shortPromptLimits = providerCompactionSummaryLimitsForChat(
				fakeBotDocument({ contextWindowTokens: 20_000 }),
				compactedMessages,
				calibration,
				toolDefinitionsForProviderRound(),
			);
			const longPromptLimits = providerCompactionSummaryLimitsForChat(
				fakeBotDocument({ contextWindowTokens: 20_000, prompt: "x".repeat(25_000) }),
				compactedMessages,
				calibration,
				toolDefinitionsForProviderRound(),
			);

			expect(longPromptLimits.nextCompactionTokens).toBe(shortPromptLimits.nextCompactionTokens);
			expect(longPromptLimits.compactionInputTokens).toBeLessThan(shortPromptLimits.compactionInputTokens);
			expect(longPromptLimits.nextCompactionTokens).toBe(20_000 - providerContextCompletionReserveTokens);
		});

		it("wraps failed compaction provider calls with request and response diagnostics", async () => {
			const originalFetch = globalThis.fetch;
			const responseBody = "{\"error\":\"schema rejected\"}";
			const fetchMock = vi.fn(async () => new Response(responseBody, { status: 400 }));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (
						settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
						messages: Parameters<typeof providerCompactionRequest>[1],
						runId: string,
						signal: AbortSignal,
					) => Promise<unknown>;
				}).callProviderForCompaction.bind(runtime);

				let thrown: unknown;
				try {
					await callProviderForCompaction(
						{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
						[{ role: "user", content: "Compact the retained activity." }],
						"run-compaction-provider-failed",
						new AbortController().signal,
					);
				} catch (error) {
					thrown = error;
				}

				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(thrown).toMatchObject({
					name: "ProviderCompactionRequestError",
					message: `Inference request failed with status 400. Response: ${responseBody}`,
					responseBody,
				});
				expect((thrown as { requestBody?: string }).requestBody).toContain("\"tools\"");
				expect((thrown as { requestBody?: string }).requestBody).toContain("\"response_format\"");
				expect((thrown as { requestBody?: string }).requestBody).not.toContain(`"${metaCompactionToolName}"`);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("falls back to minimal compaction reasoning when a model rejects disabled reasoning", async () => {
			const originalFetch = globalThis.fetch;
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const runtimeState = new Map<string, unknown>();
			const unsupportedBody = JSON.stringify({
				error: {
					message: "reasoning effort none is not supported for this model",
				},
			});
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
				async () => Response.json(validResponse),
			);
			fetchMock.mockResolvedValueOnce(new Response(unsupportedBody, { status: 400 }));
			vi.stubGlobal("fetch", fetchMock);
			try {
					const runtime = Object.assign(Object.create(BotRuntime.prototype), {
						appendEvent: (_runId: string, type: string, payload: Record<string, unknown>) => {
							events.push({ type, payload });
							return {
							seq: events.length,
							runId: _runId,
							type,
							payload,
							tokenEstimate: 0,
							createdAt: new Date().toISOString(),
						};
					},
						runtimeStateRecord: (key: string) => {
							const value = runtimeState.get(key);
							return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
						},
						deleteRuntimeState: (key: string) => {
							runtimeState.delete(key);
						},
						setRuntimeState: (key: string, value: unknown) => {
							runtimeState.set(key, value);
						},
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const settings = {
					baseUrl: customProviderBaseUrl,
					model: "openai/gpt-5.1-codex-mini",
					temperature: 0.2,
				};
				const response = await callProviderForCompaction(
					settings,
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-reasoning-fallback",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning?: unknown };
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { reasoning?: unknown };
				expect(firstBody.reasoning).toEqual({ effort: "none", exclude: false });
				expect(secondBody.reasoning).toEqual({ effort: "minimal", exclude: false });
				expect([...runtimeState.values()][0]).toMatchObject({
					model: "openai/gpt-5.1-codex-mini",
					mode: "minimal",
				});
				expect(Object.keys([...runtimeState.values()][0] as Record<string, unknown>).sort()).toEqual([
					"mode",
					"model",
					"reason",
					"updatedAt",
				]);
				expect(events).toContainEqual({
					type: "provider_retry",
					payload: expect.objectContaining({
						attempt: 2,
						compactionReasoningFallback: {
							from: { kind: "reasoning_disabled" },
							to: { kind: "explicit_effort", effort: "minimal" },
						},
						delayMs: 0,
						reason: "provider rejected compaction reasoning=none; retrying with minimal",
					}),
				});

				fetchMock.mockClear();
				await callProviderForCompaction(
					{
						...settings,
						reasoningEffort: "high",
						compactionReasoning: { kind: "model_default" },
					},
					[{ role: "user", content: "Compact the retained activity again." }],
					"run-compaction-cached-reasoning-fallback",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);
				expect(fetchMock).toHaveBeenCalledTimes(1);
				const cachedBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning?: unknown };
				expect(cachedBody.reasoning).toEqual({ effort: "minimal", exclude: false });
				expect(runtimeState.size).toBe(1);

				fetchMock.mockClear();
				await callProviderForCompaction(
					{ ...settings, model: "google/gemini-3.1-flash-lite-preview" },
					[{ role: "user", content: "Compact the retained activity after a model change." }],
					"run-compaction-model-changed",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);
				expect(fetchMock).toHaveBeenCalledTimes(1);
					const changedModelBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { model?: string; reasoning?: unknown };
					expect(changedModelBody.model).toBe("google/gemini-3.1-flash-lite-preview");
					expect(changedModelBody.reasoning).toEqual({ effort: "none", exclude: false });
					expect(runtimeState.size).toBe(0);
				} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("falls back to minimal compaction reasoning when OpenRouter server tools hide the rejection as a 500", async () => {
			const originalFetch = globalThis.fetch;
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const runtimeState = new Map<string, unknown>();
			const opaqueBody = JSON.stringify({
				error: {
					message: "Internal Server Error",
					code: 500,
				},
			});
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
				.mockResolvedValueOnce(new Response(opaqueBody, { status: 500 }))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: (_runId: string, type: string, payload: Record<string, unknown>) => {
						events.push({ type, payload });
						return {
							seq: events.length,
							runId: _runId,
							type,
							payload,
							tokenEstimate: 0,
							createdAt: new Date().toISOString(),
						};
					},
					runtimeStateRecord: (key: string) => {
						const value = runtimeState.get(key);
						return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
					},
					deleteRuntimeState: (key: string) => {
						runtimeState.delete(key);
					},
					setRuntimeState: (key: string, value: unknown) => {
						runtimeState.set(key, value);
					},
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{
						baseUrl: customProviderBaseUrl,
						model: "google/gemini-2.5-pro",
						temperature: 0.2,
					},
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-opaque-reasoning-fallback",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
					[
						...toolDefinitionsForProviderRound(),
						{ type: "openrouter:web_search", parameters: { max_results: 3 } } satisfies ProviderToolDefinition,
					],
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning?: unknown; tools?: ProviderToolDefinition[] };
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { reasoning?: unknown; tools?: ProviderToolDefinition[] };
				expect(firstBody.reasoning).toEqual({ effort: "none", exclude: false });
				expect(secondBody.reasoning).toEqual({ effort: "minimal", exclude: false });
				expect(firstBody.tools?.some((tool) => tool.type === "openrouter:web_search")).toBe(true);
				expect([...runtimeState.values()][0]).toMatchObject({
					model: "google/gemini-2.5-pro",
					mode: "minimal",
				});
				expect(events).toContainEqual({
					type: "provider_retry",
					payload: expect.objectContaining({
						attempt: 2,
						delayMs: 0,
						reason: "provider rejected compaction reasoning=none; retrying with minimal",
					}),
				});
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("serializes explicit provider-default reasoning for unknown and free OpenRouter compaction requests", async () => {
			const originalFetch = globalThis.fetch;
			const validResponse = {
				choices: [{
					message: {
						content: "",
						tool_calls: [{
							id: "call_conservative_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
							},
						}],
					},
				}],
			};
			const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
				async () => Response.json(validResponse),
			);
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				for (const model of ["unknown/provider-model", "openrouter/free"]) {
					const response = await callProviderForCompaction(
						{ baseUrl: "https://openrouter.ai/api/v1", model, temperature: 0.2 },
						[{ role: "user", content: "Compact the retained activity." }],
						`run-compaction-conservative-${model}`,
						new AbortController().signal,
						{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
						undefined,
						"tool_call_cache_friendly",
					);
					expect(response.content).toBe("I remember the important parts.");
				}

				expect(fetchMock).toHaveBeenCalledTimes(2);
				for (const call of fetchMock.mock.calls) {
					const body = JSON.parse(String(call[1]?.body)) as { reasoning?: unknown };
					expect(body.reasoning).toEqual({ exclude: false });
				}
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("starts Xiaomi FP8 routed compaction with provider-default reasoning from the capability table", async () => {
			const originalFetch = globalThis.fetch;
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const validResponse = {
				choices: [{
					message: {
						content: "",
						tool_calls: [{
							id: "call_xiaomi_fp8_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
							},
						}],
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: (_runId: string, type: string, payload: Record<string, unknown>) => {
						events.push({ type, payload });
						return {
							seq: events.length,
							runId: _runId,
							type,
							payload,
							tokenEstimate: 0,
							createdAt: new Date().toISOString(),
						};
					},
					recordProviderTokenCalibrationSample: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{
						baseUrl: "https://openrouter.ai/api/v1",
						model: "xiaomi/mimo-v2.5",
						providerRouting: { only: ["xiaomi/fp8"] },
						temperature: 0.2,
					},
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-xiaomi-fp8-reasoning-policy",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
					[
						...toolDefinitionsForProviderRound(),
						{ type: "openrouter:web_search", parameters: { max_results: 3 } } satisfies ProviderToolDefinition,
					],
					"tool_call_cache_friendly",
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(1);
				const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning?: unknown; provider?: unknown };
				expect(body.provider).toEqual({ only: ["xiaomi/fp8"] });
				expect(body.reasoning).toEqual({ exclude: false });
				expect(events.some((event) => event.type === "provider_retry")).toBe(false);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("keeps configured compaction reasoning independent of ordinary-loop reasoning", async () => {
			const originalFetch = globalThis.fetch;
			const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
				.mockResolvedValueOnce(Response.json({
					choices: [{
						message: {
							content: JSON.stringify({
								[providerCompactionSummaryProperty]: "I remember the important parts.",
							}),
						},
					}],
				}));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{
						baseUrl: "https://openrouter.ai/api/v1",
						model: "openai/gpt-5-mini",
						reasoningEffort: "minimal",
						compactionReasoning: { kind: "explicit_effort", effort: "high" },
						temperature: 0.2,
					},
					[{ role: "user", content: "Compact the retained activity." }],
					"run-independent-compaction-reasoning",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning?: unknown };
				expect(body.reasoning).toEqual({ effort: "high", exclude: false });
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("wraps empty loop provider streams with request and response diagnostics", async () => {
			const emptyChunk = {
				id: "chatcmpl-empty",
				model: "test-model-concrete",
				object: "chat.completion.chunk",
				choices: [{}],
				usage: { prompt_tokens: 77, completion_tokens: 0, total_tokens: 77 },
			};
			const responseBody = `data: ${JSON.stringify(emptyChunk)}\n\ndata: [DONE]\n\n`;
			const fetchProviderResponse = vi.fn(async () => sseStream([emptyChunk, "[DONE]"]));
			const recordProviderTokenCalibrationSample = vi.fn();
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				recordProviderTokenCalibrationSample,
				throwIfStopped: vi.fn(),
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
					messages: Array<Record<string, unknown>>,
					tools: ProviderToolDefinition[],
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<unknown>;
			}).callProvider.bind(runtime);

			let thrown: unknown;
			try {
				await callProvider(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Use a page control." }],
					toolDefinitionsForProviderRound(),
					"run-empty-provider-stream",
					1,
					new AbortController().signal,
				);
			} catch (error) {
				thrown = error;
			}

			expect(fetchProviderResponse).toHaveBeenCalledTimes(1);
			expect(thrown).toMatchObject({
				name: "ProviderLoopRequestError",
				message: expect.stringContaining("Inference provider returned an empty response"),
				responseBody,
			});
			expect(recordProviderTokenCalibrationSample).toHaveBeenCalledWith(expect.objectContaining({
				attempt: 1,
				purpose: "loop",
				responseModel: "test-model-concrete",
				usage: expect.objectContaining({ promptTokens: 77 }),
			}));
			expect((thrown as { requestBody?: string }).requestBody).toContain("\"tool_choice\":\"required\"");
			expect((thrown as { requestBody?: string }).requestBody).toContain("\"tools\"");
		});

		it("retries compaction provider 429s with the reported upstream provider ignored", async () => {
			const originalFetch = globalThis.fetch;
			const rateLimitResponse = {
				error: {
					message: "Provider returned error",
					code: 429,
					metadata: {
						provider_name: "DeepInfra",
						raw: "google/gemma is temporarily rate-limited upstream.",
					},
				},
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(rateLimitResponse, { status: 429 }))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: (_runId: string, type: string, payload: Record<string, unknown>) => {
						events.push({ type, payload });
						return {
							seq: events.length,
							runId: _runId,
							type,
							payload,
							tokenEstimate: 0,
							createdAt: new Date().toISOString(),
						};
					},
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{
						baseUrl: "https://openrouter.ai/api/v1",
						model: "deepseek/deepseek-v4-flash-0731",
						temperature: 0.2,
						providerRouting: { order: ["openrouter/fallback"], ignore: ["A"] },
					},
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-provider-rate-limit",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { provider?: Record<string, unknown>; reasoning?: unknown };
				const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { provider?: Record<string, unknown>; reasoning?: unknown };
				expect(firstBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A"] });
				expect(secondBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A", "DeepInfra"] });
				expect(firstBody.reasoning).toEqual({ effort: "high", exclude: false });
				expect(secondBody.reasoning).toEqual({ effort: "high", exclude: false });
				expect(events).toContainEqual({
					type: "provider_retry",
					payload: expect.objectContaining({
						attempt: 2,
						delayMs: 0,
						reason: expect.stringContaining("ignoring upstream provider DeepInfra"),
					}),
				});
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("accepts structured-output compaction responses without the summary tool or minimum requested length", async () => {
			const originalFetch = globalThis.fetch;
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-structured",
					new AbortController().signal,
					{ minLength: 3403, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { response_format?: unknown; tools: ProviderToolDefinition[] };
				expect(requestBody.response_format).toBeTruthy();
				expect(requestBody.tools.some((tool) => tool.type === "function" && tool.function.name === metaCompactionToolName)).toBe(false);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("accepts over-max compaction summaries when they reduce the estimated context", async () => {
			const originalFetch = globalThis.fetch;
			const overMaxSummary = "I retain the useful context from a much larger span. ".repeat(3);
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: overMaxSummary }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSample: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-soft-max",
					new AbortController().signal,
					{
						minLength: 1,
						maxLength: 20,
						maxCompletionTokens: 1000,
						compactedCharacterCount: 2_000,
						tokensPerCharacter: 0.25,
					},
				);

				expect(overMaxSummary.length).toBeGreaterThan(20);
				expect(response.content).toBe(overMaxSummary);
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("retries compaction summaries that do not reduce the estimated context", async () => {
			const originalFetch = globalThis.fetch;
			const bot = fakeBotDocument({
				displayName: "Memory Keeper",
				handle: "memory-keeper",
				prompt: "Remember without repeating.",
				shortBio: "Compacts memory.",
			});
			const nonCompactingSummary = "This summary is still longer than the retained context.";
			const invalidResponse = {
				id: "compaction-non-reducing",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: nonCompactingSummary }),
					},
				}],
				usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
			};
			const validResponse = {
				id: "compaction-reducing",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "Short." }),
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(invalidResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSample: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[
						{ role: "system", content: "System prompt." },
						{ role: "assistant", content: "Old retained activity that should not be repeated in the retry." },
						{ role: "user", content: "META: Context compaction required." },
					],
					"run-compaction-non-reducing",
					new AbortController().signal,
					{
						minLength: 1,
						maxLength: 100,
						maxCompletionTokens: 1000,
						compactedCharacterCount: 20,
						tokensPerCharacter: 1,
					},
					undefined,
					"structured_output",
					0,
					undefined,
					bot,
				);

				expect(response.content).toBe("Short.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
					messages: BotInferenceSubmissionMessage[];
					tools?: ProviderToolDefinition[];
				};
				expect(retryBody.messages).toEqual([
					expect.objectContaining({
						role: "system",
						content: expect.stringContaining("META: Context compaction repair required."),
					}),
					{ role: "user", content: "Bickr Terminal is ready for my next step." },
					{ role: "assistant", content: nonCompactingSummary },
					{ role: "user", content: "Produce the replacement memory summary now." },
				]);
				expect(retryBody.tools).toBeUndefined();
				const retrySystem = retryBody.messages[0]?.content ?? "";
				expect(retrySystem.startsWith("META: Context compaction repair required.")).toBe(true);
				expect(retrySystem).toContain("The previous compaction attempt did not reduce the context.");
				expect(retrySystem).toContain("Verbatim copying from the input is absolutely prohibited");
				expect(retrySystem).toContain("Your Bickr handle is u/memory-keeper");
				expect(retrySystem).toContain("Your persona is:\nRemember without repeating.");
				expect(retrySystem).not.toContain("Make all decisions autonomously");
				expect(retrySystem).not.toContain("You MUST use one of the following tools");
				expect(JSON.stringify(retryBody.messages)).not.toContain("Old retained activity");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("raises a persistent compaction failure after isolated repair keeps failing to reduce context", async () => {
			const originalFetch = globalThis.fetch;
			const bot = fakeBotDocument({
				displayName: "Memory Keeper",
				handle: "memory-keeper",
				prompt: "Remember without repeating.",
				shortBio: "Compacts memory.",
			});
			const nonCompactingSummary = "This summary is still longer than the retained context.";
			const invalidResponse = {
				id: "compaction-non-reducing",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: nonCompactingSummary }),
					},
				}],
				usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
			};
			const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(invalidResponse)));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSampleFromError: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const rejection = await callProviderForCompaction(
					{
						baseUrl: "https://openrouter.ai/api/v1",
						model: "deepseek/deepseek-v4-flash-0731",
						temperature: 0.2,
					},
					[
						{ role: "system", content: "System prompt." },
						{ role: "assistant", content: "Old retained activity that should not be repeated in the retry." },
						{ role: "user", content: "META: Context compaction required." },
					],
					"run-compaction-non-reducing-persistent",
					new AbortController().signal,
					{
						minLength: 1,
						maxLength: 100,
						maxCompletionTokens: 1000,
						compactedCharacterCount: 20,
						tokensPerCharacter: 1,
					},
					undefined,
					"structured_output",
					0,
					undefined,
					bot,
				).catch((error: unknown) => error);
				expect(rejection).toBeInstanceOf(PersistentCompactionReductionFailureError);
				expect(rejection).toMatchObject({ attempts: 4 });

				expect(fetchMock).toHaveBeenCalledTimes(5);
				const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as {
					messages: BotInferenceSubmissionMessage[];
					reasoning?: unknown;
					tools?: ProviderToolDefinition[];
				});
				for (const body of bodies) {
					expect(body.reasoning).toEqual({ effort: "high", exclude: false });
				}
				const isolatedBodies = bodies.slice(1);
				expect(isolatedBodies).toHaveLength(4);
				const finalRequest = JSON.parse(String((rejection as PersistentCompactionReductionFailureError).requestBody)) as {
					messages: BotInferenceSubmissionMessage[];
					tools?: ProviderToolDefinition[];
				};
				const finalResponse = JSON.parse(String((rejection as PersistentCompactionReductionFailureError).responseBody)) as typeof invalidResponse;
				expect(finalRequest).toEqual(isolatedBodies.at(-1));
				expect(finalResponse).toEqual(invalidResponse);
				expect(runtimeFailureLogs(rejection)).toEqual([
					{ kind: "compaction_request", text: (rejection as PersistentCompactionReductionFailureError).requestBody },
					{ kind: "compaction_response", text: (rejection as PersistentCompactionReductionFailureError).responseBody },
				]);
				for (const body of isolatedBodies) {
					expect(body.tools).toBeUndefined();
					expect(body.messages[0]?.content).toContain("META: Context compaction repair required.");
					expect(body.messages[0]?.content).toContain("Verbatim copying from the input is absolutely prohibited");
					expect(body.messages[0]?.content).not.toContain("Don't spend any time thinking about this");
					expect(JSON.stringify(body.messages)).not.toContain("Old retained activity");
				}
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("records calibration samples for schema-invalid compaction attempts with usage", async () => {
			const originalFetch = globalThis.fetch;
			const invalidResponse = {
				id: "compaction-invalid",
				model: "test-model-concrete",
				choices: [{ message: { content: "not json" } }],
				usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
			};
			const validResponse = {
				id: "compaction-valid",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
				usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(invalidResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const recordProviderTokenCalibrationSample = vi.fn();
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSample,
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-schema-calibration",
					new AbortController().signal,
					{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(recordProviderTokenCalibrationSample).toHaveBeenCalledTimes(2);
				expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(1, expect.objectContaining({
					attempt: 1,
					purpose: "compaction",
					responseModel: "test-model-concrete",
					usage: expect.objectContaining({ promptTokens: 40 }),
				}));
				expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(2, expect.objectContaining({
					attempt: 2,
					purpose: "compaction",
					responseModel: "test-model-concrete",
					usage: expect.objectContaining({ promptTokens: 50 }),
				}));
				const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(JSON.stringify(retryBody.messages)).toContain("Actually, I must reply with the required structured output.");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("repairs structured-output compaction tool calls with the schema summary prompt", async () => {
			const originalFetch = globalThis.fetch;
			const ordinaryToolResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_read_in_structured_compaction",
							type: "function",
							function: { name: "read_thread", arguments: JSON.stringify({ threadId: "thr_1" }) },
						}],
					},
				}],
			};
			const validResponse = {
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
					},
				}],
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(ordinaryToolResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{
						baseUrl: "https://openrouter.ai/api/v1",
						model: "deepseek/deepseek-v4-flash-0731",
						temperature: 0.2,
					},
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-structured-tool-repair",
					new AbortController().signal,
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as {
					messages: BotInferenceSubmissionMessage[];
					reasoning?: unknown;
				});
				for (const body of bodies) {
					expect(body.reasoning).toEqual({ effort: "high", exclude: false });
				}
				const retryBody = bodies[1]!;
				const repairToolMessage = retryBody.messages.find((message) => message.role === "tool");
				expect(repairToolMessage?.content).toContain("META: don't make any tool calls. You must reply with the structured detailed first-person summary strictly following the required JSON schema.");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("accepts tool-call compaction responses below the requested minimum length", async () => {
			const originalFetch = globalThis.fetch;
			const validResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_short_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "Short summary." }),
							},
						}],
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-tool-short",
					new AbortController().signal,
					{ minLength: 3403, maxLength: 4000, maxCompletionTokens: 1000 },
					undefined,
					"tool_call",
				);

				expect(response.content).toBe("Short summary.");
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("retries schema-invalid compaction tool calls with a repair tool result", async () => {
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
			const validResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_good_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
							},
						}],
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(invalidResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-repair",
					new AbortController().signal,
					undefined,
					undefined,
					"tool_call",
				);

				expect(response.content).toBe("I remember the important parts.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				const repairedBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				expect(repairedBody.messages).toEqual(expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						tool_calls: [
							expect.objectContaining({
								id: "call_1",
								function: invalidResponse.choices[0]!.message.tool_calls[0]!.function,
							}),
						],
					}),
					expect.objectContaining({
						role: "tool",
						tool_call_id: "call_1",
						content: expect.stringContaining("schema_invalid"),
					}),
				]));
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("retries overlong compaction summaries by shortening only the previous summary", async () => {
			const originalFetch = globalThis.fetch;
			const overlongSummary = "I remember this, but with too many characters.";
			const overlongResponse = {
				id: "compaction-overlong",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: overlongSummary }),
					},
				}],
				usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
			};
			const validResponse = {
				id: "compaction-shortened",
				model: "test-model-concrete",
				choices: [{
					message: {
						content: JSON.stringify({ [providerCompactionSummaryProperty]: "Short." }),
					},
				}],
				usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(overlongResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const recordProviderTokenCalibrationSample = vi.fn();
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					recordProviderTokenCalibrationSample,
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{
						baseUrl: "https://openrouter.ai/api/v1",
						model: "deepseek/deepseek-v4-flash-0731",
						temperature: 0.2,
					},
					[
						{ role: "system", content: "System prompt." },
						{ role: "assistant", content: "Old retained activity that should not be repeated in the shorten retry." },
						{ role: "user", content: "META: Context compaction required." },
					],
					"run-compaction-shorten",
					new AbortController().signal,
					{ minLength: 1, maxLength: 10, maxCompletionTokens: 100 },
					undefined,
					"structured_output",
				);

				expect(response.content).toBe("Short.");
				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(recordProviderTokenCalibrationSample).toHaveBeenCalledTimes(2);
				expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(1, expect.objectContaining({
					attempt: 1,
					usage: expect.objectContaining({ promptTokens: 60 }),
				}));
				expect(recordProviderTokenCalibrationSample).toHaveBeenNthCalledWith(2, expect.objectContaining({
					attempt: 2,
					usage: expect.objectContaining({ promptTokens: 30 }),
				}));
				const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as {
					messages: BotInferenceSubmissionMessage[];
					reasoning?: unknown;
				});
				for (const body of bodies) {
					expect(body.reasoning).toEqual({ effort: "high", exclude: false });
				}
				const retryBody = bodies[1]!;
				expect(retryBody.messages).toEqual([
					{ role: "system", content: "System prompt." },
					{ role: "user", content: "Bickr Terminal is ready for my next step." },
					{ role: "assistant", content: overlongSummary },
					expect.objectContaining({
						role: "user",
						content: expect.stringContaining("previous context compaction attempt produced a summary that was too long"),
					}),
				]);
				expect(retryBody.messages.at(-1)?.content).toContain("Verbatim copying from the input is absolutely prohibited");
				expect(retryBody.messages.at(-1)?.content).not.toContain("Don't spend any time thinking about this");
				expect(JSON.stringify(retryBody.messages)).not.toContain("Old retained activity");
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});

		it("repairs ordinary tool calls during compaction without executing them", async () => {
			const originalFetch = globalThis.fetch;
			const ordinaryToolResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_read_in_compaction",
							type: "function",
							function: { name: "read_thread", arguments: JSON.stringify({ threadId: "thr_1" }) },
						}],
					},
				}],
			};
			const validResponse = {
				choices: [{
					message: {
						tool_calls: [{
							id: "call_good_compaction",
							type: "function",
							function: {
								name: metaCompactionToolName,
								arguments: JSON.stringify({ [providerCompactionSummaryProperty]: "I remember the important parts." }),
							},
						}],
					},
				}],
			};
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(Response.json(ordinaryToolResponse))
				.mockResolvedValueOnce(Response.json(validResponse));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const runtime = Object.assign(Object.create(BotRuntime.prototype), {
					appendEvent: vi.fn(),
					throwIfStopped: vi.fn(),
				});
				const callProviderForCompaction = (BotRuntime.prototype as unknown as {
					callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string; requestBody?: string }>;
				}).callProviderForCompaction.bind(runtime);

				const response = await callProviderForCompaction(
					{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
					[{ role: "user", content: "Compact the retained activity." }],
					"run-compaction-ordinary-tool-repair",
					new AbortController().signal,
					undefined,
					undefined,
					"tool_call",
				);

				expect(response.content).toBe("I remember the important parts.");
				const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: BotInferenceSubmissionMessage[] };
				const repairToolMessage = retryBody.messages.find((message) => message.role === "tool");
				expect(repairToolMessage?.tool_call_id).toBe("call_1");
				expect(repairToolMessage?.content).toContain(`Only ${metaCompactionToolName} may be used`);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		});
});
