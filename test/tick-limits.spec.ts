import {
	additionalReplyToolPresent,
	authCookie,
	botById,
	BotRuntime,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	describe,
	expect,
	fakeBotDocument,
	formatThreadRef,
	hasLoneSurrogate,
	it,
	localizedTextString,
	loopMessageRowForMessage,
	providerCompactionSummaryProperty,
	providerPromptEstimateForTokens,
	providerResponseWithContent,
	providerResponseWithRawToolCalls,
	providerResponseWithToolCall,
	providerResponseWithToolCalls,
	providerUsageForTest,
	readThread,
	recordBotRuntimeFailureHumanNotification,
	requiredLt,
	runtimeErrorLoopMessageContent,
	runtimeEvent,
	seedWorld,
	testEnv,
	testLoopMessageMemory,
	testRuntimeForToolExecution,
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
import type { RuntimeErrorCause } from "@bickr/shared/runtime-errors";
import { malformedToolCallSelfCorrection } from "../workers/agent-runtime/src/runtime/bot-runtime";

function legacyLoopHistoryRuntime(rows: LoopMessageRowForTest[]) {
	let nextSeq = Math.max(0, ...rows.map((row) => row.seq)) + 1;
	let lastInsertSeq = 0;
	let transactionCount = 0;
	const runtimeState = new Map<string, string>();
	const sortedActiveRows = () =>
		rows
			.filter((row) => row.deleted_at === null && row.compacted_by === null)
			.sort((left, right) => left.position - right.position || left.seq - right.seq);
	const sql = {
		exec<T>(query: string, ...params: unknown[]) {
			const normalized = query.trim().replace(/\s+/g, " ");
			if (/SELECT m\.seq, m\.position, m\.run_id/.test(normalized)) {
				return { toArray: () => sortedActiveRows() as T[] };
			}
			if (/SELECT value_json FROM runtime_state WHERE key = \?/.test(normalized)) {
				const value = runtimeState.get(String(params[0]));
				return { toArray: () => (value === undefined ? [] : [{ value_json: value } as T]) };
			}
			if (/INSERT INTO runtime_state/.test(normalized)) {
				runtimeState.set(String(params[0]), String(params[1]));
			}
			if (/UPDATE loop_messages SET deleted_at = \?/.test(normalized)) {
				const row = rows.find((item) => item.seq === Number(params[1]));
				if (row && !row.deleted_at) {
					row.deleted_at = String(params[0]);
				}
			}
			if (/UPDATE loop_messages SET message_json = \?, token_estimate = \?/.test(normalized)) {
				const row = rows.find((item) => item.seq === Number(params[2]));
				if (row && !row.deleted_at) {
					row.message_json = String(params[0]);
					row.token_estimate = Number(params[1]);
				}
			}
			if (/SELECT COALESCE\(MAX\(position\), 0\) \+ 1 AS position FROM loop_messages/.test(normalized)) {
				const maxPosition = Math.max(0, ...sortedActiveRows().map((row) => row.position));
				return { one: () => ({ position: maxPosition + 1 }) as T, toArray: () => [] as T[] };
			}
			if (/INSERT INTO loop_messages/.test(normalized)) {
				lastInsertSeq = nextSeq;
				rows.push({
					seq: nextSeq,
					position: Number(params[0]),
					run_id: String(params[1]),
					role: params[2] as BotLoopMessage["role"],
					message_json: String(params[3]),
					origin: params[4] as BotLoopMessage["origin"],
					status: params[5] === null || params[5] === undefined ? "complete" : String(params[5]),
					token_estimate: Number(params[6]),
					stream_seq: params[7] === null ? null : Number(params[7]),
					display_event_seq: params[8] === null ? null : Number(params[8]),
					display_event_type: null,
					display_event_payload_json: null,
					compacted_by: null,
					deleted_at: null,
					created_at: String(params[9]),
					has_logs: 0,
				});
				nextSeq += 1;
			}
			if (/SELECT last_insert_rowid\(\) AS seq/.test(normalized)) {
				return { one: () => ({ seq: lastInsertSeq }) as T, toArray: () => [] as T[] };
			}
			if (/SELECT COALESCE\(MIN\(position\), 1\) AS position/.test(normalized)) {
				const positions = sortedActiveRows().map((row) => row.position);
				return { one: () => ({ position: positions.length > 0 ? Math.min(...positions) : 1 }) as T, toArray: () => [] as T[] };
			}
			if (normalized.startsWith("UPDATE loop_messages") && normalized.includes("position = ?")) {
				const row = rows.find((item) => item.seq === Number(params[1]));
				if (row && !row.deleted_at && row.compacted_by === null) {
					row.position = Number(params[0]);
				}
			}
			return { one: () => ({} as T), toArray: () => [] as T[] };
		},
	};
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		state: {
			storage: {
				sql,
				transactionSync: <T,>(closure: () => T): T => {
					transactionCount += 1;
					const rowSnapshot = rows.map((row) => ({ ...row }));
					const stateSnapshot = new Map(runtimeState);
					try {
						return closure();
					} catch (error) {
						rows.splice(0, rows.length, ...rowSnapshot);
						runtimeState.clear();
						for (const [key, value] of stateSnapshot) {
							runtimeState.set(key, value);
						}
						throw error;
					}
				},
			},
		},
	});
	return {
		runtime,
		activeMessages: () => sortedActiveRows().map((row) => JSON.parse(row.message_json) as BotInferenceSubmissionMessage),
		runtimeState,
		transactionCount: () => transactionCount,
	};
}

describe("Tick limits and recovery", () => {

		it("does not count failed parallel calls toward the iteration limit", async () => {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const executedTools: string[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => ({
				seq: events.length,
				runId: "run-failed-call-limit",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{ id: "call-read", name: "read_thread", args: { threadId: "thr_missing" } },
				{ id: "call-vote", name: "vote", args: { votes: [{ commentId: "cmt_test", value: 1 }], reason: "Clear useful context." } },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				if (name === "read_thread") {
					throw new Error("Thread not found.");
				}
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			providerLoopInitialSuccessfulToolCallCount: () => 6,
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
				{
					...fakeBotDocument(),
					tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 1, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-failed-call-limit",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executedTools).toEqual(["read_thread", "vote"]);
		expect(events.some((event) => {
			const result = event.payload.result;
			return Boolean(result && typeof result === "object" && "code" in result && result.code === "iteration_tool_limit");
			})).toBe(false);
		});

		it("drops one premature logoff attempt and allows a repeated one", async () => {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
			const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
			const rewrites: Array<{ kind: string; toolCallId: string }> = [];
			const callProvider = vi.fn()
				.mockResolvedValueOnce(providerResponseWithToolCall("call-log-off-first", "log_off", { reason: "done too early" }))
				.mockResolvedValueOnce(providerResponseWithToolCall("call-log-off-second", "log_off", { reason: "still done" }));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
				},
				appendLoopMessage: (
					_runId: string,
					message: Record<string, unknown>,
					origin: string,
				) => {
					appendedLoopMessages.push({ message, origin });
					return {
						seq: appendedLoopMessages.length,
						runId: "run-premature-logoff",
						role: message.role,
						message,
						origin,
						tokenEstimate: 0,
						createdAt: new Date().toISOString(),
					};
				},
				appendProviderMessages: async () => {},
				callProvider,
				ensureProviderPromptWithinBudget: async () => ({
					allowedPromptTokens: 13_500,
					providerTools: toolDefinitionsForProviderRound(),
					promptTokens: 100,
					requestMessages: [{ role: "assistant", content: "I am ready." }],
				}),
				executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => {
					executedTools.push({ name, args });
					return { name, result: { ok: true }, providerResult: { ok: true } };
				},
				hasRuntimeStorage: () => true,
				loopGeneratedTokenCountSinceLastLogOff: () => 0,
				prematureLogOffCorrectedSinceLastLogOff: () => false,
				providerLoopInitialSuccessfulToolCallCount: () => 0,
				recordInferenceSubmission: () => {},
				recordLoopMessageLog: () => {},
				recordProviderUsage: () => {},
				successfulMutatingToolCallSinceLastLogOff: () => false,
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
					{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 2 } },
					{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-premature-logoff",
					[],
					{ mode: "normal", signal: new AbortController().signal },
				),
			).resolves.toMatchObject({ logOffCalled: true });

			expect(callProvider).toHaveBeenCalledTimes(2);
			expect(rewrites).toEqual([]);
			expect(executedTools).toEqual([{ name: "log_off", args: { reason: requiredLt("still done") } }]);
			expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
				origin: "self_correction",
				message: expect.objectContaining({
					content: "Actually I don't want to log off yet, let me think about what I should do instead.",
				}),
			}));
			expect(events).toContainEqual(expect.objectContaining({
				type: "provider_tool_call_dropped",
				payload: expect.objectContaining({
					callIds: ["call-log-off-first"],
					reason: "premature_log_off",
				}),
			}));
			expect(appendedLoopMessages.filter((message) => message.origin === "tool_failure")).toEqual([]);
		});

		it("stops a tick after executing the response that reaches the generated token limit", async () => {
			const executedTools: string[] = [];
			const callProvider = vi.fn(async () => ({
				...providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }),
				usage: providerUsageForTest(25, 5),
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
					runtimeEvent(callProvider.mock.calls.length + executedTools.length + 1, runId, type as BotRuntimeEvent["type"], payload),
				appendLoopMessage: (
					_runId: string,
					message: Record<string, unknown>,
					origin: string,
				) => ({
					seq: executedTools.length + 1,
					runId: "run-tick-token-limit",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				}),
				appendProviderMessages: async () => {},
				callProvider,
				ensureProviderPromptWithinBudget: async () => ({
					allowedPromptTokens: 13_500,
					providerTools: toolDefinitionsForProviderRound(),
					promptTokens: 100,
					requestMessages: [{ role: "assistant", content: "I am ready." }],
				}),
				executeTool: async (_bot: unknown, _runId: string, name: string) => {
					executedTools.push(name);
					return { name, result: { ok: true }, providerResult: { ok: true } };
				},
				recordInferenceSubmission: () => {},
				recordLoopMessageLog: () => {},
				recordProviderUsage: () => {},
				successfulMutatingToolCallSinceLastLogOff: () => true,
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
					{
						...fakeBotDocument(),
						tickSettings: {
							...fakeBotDocument().tickSettings,
							maxToolCallsPerTick: 5,
							maxGeneratedTokensPerTick: 25,
							maxGeneratedTokensPerIteration: 1_000,
						},
					},
					{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-tick-token-limit",
					[],
					{ mode: "normal", signal: new AbortController().signal },
				),
			).resolves.toMatchObject({ logOffCalled: false });

			expect(callProvider).toHaveBeenCalledTimes(1);
			expect(executedTools).toEqual(["read_thread"]);
		});

		it("injects synthetic logoff after executing the response that reaches the iteration generated token limit", async () => {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const executedTools: string[] = [];
			const callProvider = vi.fn(async () => ({
				...providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }),
				usage: providerUsageForTest(10),
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
				},
				appendLoopMessage: (
					_runId: string,
					message: Record<string, unknown>,
					origin: string,
				) => ({
					seq: events.length + executedTools.length,
					runId: "run-iteration-token-limit",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				}),
				appendProviderMessages: async () => {},
				callProvider,
				ensureProviderPromptWithinBudget: async () => ({
					allowedPromptTokens: 13_500,
					providerTools: toolDefinitionsForProviderRound(),
					promptTokens: 100,
					requestMessages: [{ role: "assistant", content: "I am ready." }],
				}),
				executeTool: async (_bot: unknown, _runId: string, name: string) => {
					executedTools.push(name);
					return { name, result: { ok: true }, providerResult: { ok: true } };
				},
				loopGeneratedTokenCountSinceLastLogOff: () => 40,
				recordInferenceSubmission: () => {},
				recordLoopMessageLog: () => {},
				recordProviderUsage: () => {},
				successfulMutatingToolCallSinceLastLogOff: () => true,
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
					{
						...fakeBotDocument(),
						tickSettings: {
							...fakeBotDocument().tickSettings,
							allowEarlyLogOff: true,
							maxGeneratedTokensPerTick: 1_000,
							maxGeneratedTokensPerIteration: 50,
						},
					},
					{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-iteration-token-limit",
					[],
					{ mode: "normal", signal: new AbortController().signal },
				),
			).resolves.toMatchObject({ logOffCalled: true });

			expect(callProvider).toHaveBeenCalledTimes(1);
			expect(executedTools).toEqual(["read_thread", "log_off"]);
			expect(events).toContainEqual(expect.objectContaining({
				type: "assistant_message",
				payload: expect.objectContaining({
					content: "I need to take a short break from Bickr. I'll log off for now.",
				}),
			}));
		});

		it("does not inject a second synthetic logoff when token exhaustion response already logs off", async () => {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const executedTools: string[] = [];
			const callProvider = vi.fn(async () => ({
				...providerResponseWithToolCall("call-log-off", "log_off", { reason: "done" }),
				usage: providerUsageForTest(50),
			}));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
					events.push({ type, payload });
					return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
				},
				appendLoopMessage: (
					_runId: string,
					message: Record<string, unknown>,
					origin: string,
				) => ({
					seq: events.length + executedTools.length,
					runId: "run-token-limit-real-logoff",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				}),
				appendProviderMessages: async () => {},
				callProvider,
				ensureProviderPromptWithinBudget: async () => ({
					allowedPromptTokens: 13_500,
					providerTools: toolDefinitionsForProviderRound(),
					promptTokens: 100,
					requestMessages: [{ role: "assistant", content: "I am ready." }],
				}),
				executeTool: async (_bot: unknown, _runId: string, name: string) => {
					executedTools.push(name);
					return { name, result: { ok: true }, providerResult: { ok: true } };
				},
				recordInferenceSubmission: () => {},
				recordLoopMessageLog: () => {},
				recordProviderUsage: () => {},
				successfulMutatingToolCallSinceLastLogOff: () => true,
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
					{
						...fakeBotDocument(),
						tickSettings: {
							...fakeBotDocument().tickSettings,
							allowEarlyLogOff: true,
							maxGeneratedTokensPerTick: 1_000,
							maxGeneratedTokensPerIteration: 50,
						},
					},
					{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
					"run-token-limit-real-logoff",
					[],
					{ mode: "normal", signal: new AbortController().signal },
				),
			).resolves.toMatchObject({ logOffCalled: true });

			expect(executedTools).toEqual(["log_off"]);
			expect(events.some((event) =>
				event.type === "assistant_message" &&
				String(event.payload.content ?? "") === "I need to take a short break from Bickr. I'll log off for now.",
			)).toBe(false);
		});

	it("bounds malformed-call corrections while keeping a canonical example", () => {
		const correction = malformedToolCallSelfCorrection([
			{ id: "call-1", name: "read_thread", reason: "invalid_arguments_json", argumentsPreview: "{" },
			{ id: "call-2", name: "reply_to_comment", reason: "arguments_not_json_object", argumentsPreview: "[]" },
			{ id: "call-3", name: "vote", reason: "invalid_arguments_json", argumentsPreview: "{" },
			{ id: "call-4", name: "create_thread", reason: "invalid_arguments_json", argumentsPreview: "{" },
		]);

		expect(correction).toContain("4 Bickr controls (read_thread, reply_to_comment, 2 more)");
		expect(correction).toContain('For read_thread, I should use arguments shaped like {"threadRef":"t/abc"}.');
		expect(correction).not.toContain("vote");
		expect(correction).not.toContain("create_thread");
		expect(correction.length).toBeLessThan(500);
	});

	it("retries once when a generated response contains only malformed tool calls", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string; status: string }> = [];
		const retainedLogs: Array<{ messageSeq: number; kind: BotLoopMessageLog["kind"]; text: string }> = [];
		const submissions: Array<Array<Record<string, unknown>>> = [];
		const completeRawArguments = `{"threadRef":"${"x".repeat(1_000)}`;
		const callProvider = vi.fn()
			.mockResolvedValueOnce({
				...providerResponseWithRawToolCalls([
					{ id: "call-bad-json", name: "read_thread", arguments: completeRawArguments },
					{ id: "call-bad-object", name: "reply_to_comment", arguments: "[]" },
				]),
				requestBody: "complete failed request body",
				rawResponse: "bounded raw SSE response preview",
			})
			.mockResolvedValueOnce(providerResponseWithToolCall("call-log-off", "log_off", { reason: "clean retry" }));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
				status = "complete",
			) => {
				appendedLoopMessages.push({ message, origin, status });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-malformed-retry",
					role: message.role,
					message,
					origin,
					status,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [
					{ role: "assistant", content: "I am ready." },
					...appendedLoopMessages
						.filter((item) => item.origin !== "dropped_provider_response")
						.map((item) => item.message),
				],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string, _args: Record<string, unknown>) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true },
			}),
			recordInferenceSubmission: (input: { messages: Array<Record<string, unknown>> }) => {
				submissions.push(input.messages);
			},
			recordLoopMessageLog: (messageSeq: number, kind: BotLoopMessageLog["kind"], text: string) => {
				retainedLogs.push({ messageSeq, kind, text });
			},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
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
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-malformed-retry",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		expect(callProvider).toHaveBeenCalledTimes(2);
		expect(submissions).toHaveLength(2);
		expect(appendedLoopMessages.filter((message) => message.origin === "provider_response")).toHaveLength(1);
		const [failedAttempt] = appendedLoopMessages.filter((message) => message.origin === "dropped_provider_response");
		expect(failedAttempt).toMatchObject({ status: "invalid" });
		expect(failedAttempt?.message.tool_calls).toEqual([
			expect.objectContaining({
				id: "call-bad-json",
				function: expect.objectContaining({ name: "read_thread", arguments: completeRawArguments }),
			}),
			expect.objectContaining({
				id: "call-bad-object",
				function: expect.objectContaining({ name: "reply_to_comment", arguments: "[]" }),
			}),
		]);
		const correction = appendedLoopMessages.find((message) => message.origin === "self_correction");
		expect(correction?.message.content).toContain("I formatted 2 Bickr controls (read_thread, reply_to_comment) incorrectly.");
		expect(correction?.message.content).toContain('For read_thread, I should use arguments shaped like {"threadRef":"t/abc"}.');
		expect(submissions[1]).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", content: correction?.message.content }),
		]));
		expect(JSON.stringify(submissions[1])).not.toContain("call-bad-json");
		expect(JSON.stringify(submissions[1])).not.toContain("call-bad-object");
		const providerResponseLog = retainedLogs.find((log) => log.kind === "provider_response");
		const loggedResponse = JSON.parse(providerResponseLog?.text ?? "{}") as Record<string, unknown>;
		expect(providerResponseLog?.messageSeq).toBe(1);
		expect(loggedResponse).toMatchObject({
			status: "invalid",
			rawResponse: "bounded raw SSE response preview",
			droppedToolCalls: [
				{ id: "call-bad-json", name: "read_thread", reason: "invalid_arguments_json" },
				{ id: "call-bad-object", name: "reply_to_comment", reason: "arguments_not_json_object" },
			],
		});
		const loggedMessage = loggedResponse.message as BotInferenceSubmissionMessage | undefined;
		expect(loggedMessage?.tool_calls?.[0]?.function.arguments).toBe(completeRawArguments);
		expect(retainedLogs).toContainEqual(expect.objectContaining({ kind: "provider_request", text: "complete failed request body" }));
		expect(events.filter((event) => event.type === "provider_tool_call_dropped")).toEqual([
			expect.objectContaining({
				payload: expect.objectContaining({
					count: 2,
					reason: "invalid_arguments_json,arguments_not_json_object",
					retrying: true,
				}),
			}),
		]);
	});

	it("preserves the all-dropped retry for a missing call ID without adding a JSON correction", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const retainedLogs: Array<{ kind: BotLoopMessageLog["kind"]; text: string }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithRawToolCalls([
				{ id: "", name: "read_thread", arguments: '{"threadRef":"t/abc"}' },
			]))
			.mockResolvedValueOnce(providerResponseWithRawToolCalls([
				{ id: "call-bad-2", name: "read_thread", arguments: "[]" },
			]));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-malformed-fails",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: (_messageSeq: number, kind: BotLoopMessageLog["kind"], text: string) => {
				retainedLogs.push({ kind, text });
			},
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
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-malformed-fails",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toThrow("Inference provider returned only malformed page-control requests after retry.");

		expect(callProvider).toHaveBeenCalledTimes(2);
		expect(appendedLoopMessages.filter((message) => message.origin === "dropped_provider_response")).toHaveLength(2);
		expect(appendedLoopMessages.filter((message) => message.origin === "self_correction")).toHaveLength(0);
		expect(appendedLoopMessages.filter((message) => message.origin === "provider_response")).toHaveLength(0);
		const [missingIdLog] = retainedLogs
			.filter((log) => log.kind === "provider_response")
			.map((log) => JSON.parse(log.text) as Record<string, unknown>);
		expect(missingIdLog).toMatchObject({
			status: "invalid",
			droppedToolCalls: [{ id: "", name: "read_thread", reason: "missing_tool_call_id" }],
		});
		expect(events.filter((event) => event.type === "provider_tool_call_dropped")).toEqual([
			expect.objectContaining({
				payload: expect.objectContaining({
					reason: "missing_tool_call_id",
					retrying: true,
				}),
			}),
			expect.objectContaining({
				payload: expect.objectContaining({
					reason: "arguments_not_json_object",
					retrying: false,
				}),
			}),
		]);
	});

	it("railroads no-tool responses by preserving them and injecting a correction", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const loopMemory = testLoopMessageMemory([{ role: "user", content: "Act." }]);
		const callProvider = vi.fn(async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
			providerMessages.push(messages);
			return providerMessages.length === 1 ?
				providerResponseWithContent("I might be done.")
			:	providerResponseWithToolCall("call-log-off", "log_off", { reason: "done after correction" });
		});
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			...loopMemory,
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				providerTools: tools,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true },
			}),
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
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
				{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 3 } },
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "railroad" },
				"run-railroad-retry",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		expect(callProvider).toHaveBeenCalledTimes(2);
		expect(providerMessages[1]).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", content: "I might be done." }),
			expect.objectContaining({ role: "assistant", content: expect.stringContaining("Actually, I must use one of the following tools") }),
		]));
		expect(events.filter((event) => event.type === "assistant_message").map((event) => event.payload)).toEqual([
			expect.objectContaining({ content: expect.stringContaining("Actually, I must use one of the following tools") }),
		]);
	});

	it("recovers when a required-tool provider response returns no tool calls", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const loopMemory = testLoopMessageMemory([{ role: "user", content: "Act." }]);
		const callProvider = vi.fn(async (_settings: unknown, messages: Array<Record<string, unknown>>) => {
			providerMessages.push(messages);
			return providerMessages.length === 1 ?
				providerResponseWithContent("I should think about this without touching the page.")
			:	providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" });
		});
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			...loopMemory,
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				providerTools: tools,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true },
			}),
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
			) => Promise<{ logOffCalled: boolean; toolCallCount: number }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 1 } },
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-required-no-tool-retry",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false, toolCallCount: 1 });

		expect(callProvider).toHaveBeenCalledTimes(2);
		expect(providerMessages[1]).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", content: "I should think about this without touching the page." }),
			expect.objectContaining({ role: "assistant", content: expect.stringContaining("Actually, I must use one of the following tools") }),
		]));
		expect(events.filter((event) => event.type === "assistant_message").map((event) => event.payload)).toEqual([
			expect.objectContaining({ content: expect.stringContaining("Actually, I must use one of the following tools") }),
		]);
	});

	it("stops railroad retries after five no-tool responses", async () => {
		const loopMemory = testLoopMessageMemory([{ role: "user", content: "Act." }]);
		const appendedLoopMessages: Array<{ origin: string; message: Record<string, unknown> }> = [];
		const callProvider = vi.fn(async () => providerResponseWithContent("Still thinking."));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			...loopMemory,
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(callProvider.mock.calls.length + appendedLoopMessages.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ origin, message });
				return loopMemory.appendLoopMessage(runId, message, origin);
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "user", content: "Act." }],
			}),
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
				{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 10 } },
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "railroad" },
				"run-railroad-fails",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toThrow("Stopped after 5 inference responses without a required tool call.");

		expect(callProvider).toHaveBeenCalledTimes(5);
		expect(appendedLoopMessages.filter((message) => message.origin === "provider_response")).toHaveLength(5);
		expect(appendedLoopMessages.filter((message) => message.origin === "self_correction")).toHaveLength(4);
	});

	it("at-will no-tool responses finish without self-correction", async () => {
		const providerToolsByCall: string[][] = [];
		const systemPromptsByCall: string[] = [];
		const appendedLoopMessages: Array<{ origin: string; message: Record<string, unknown> }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(providerToolsByCall.length + appendedLoopMessages.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ origin, message });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-at-will-noop",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>, tools: ProviderToolDefinition[]) => {
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				systemPromptsByCall.push(String(messages[0]?.content ?? ""));
				return providerResponseWithContent("No page control needed.");
			},
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				providerTools: tools,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
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
				fakeBotDocument({ allowEarlyLogOff: false }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-at-will-noop",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerToolsByCall).toHaveLength(1);
		expect(providerToolsByCall[0]).not.toContain("log_off");
		expect(systemPromptsByCall[0]).not.toContain("log_off");
		expect(appendedLoopMessages.map((message) => message.origin)).toEqual(["provider_response"]);
	});

	it("drops generated log_off calls when early logoff is disabled", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const executedTools: string[] = [];
		const providerToolsByCall: string[][] = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCall("call-log-off", "log_off", { reason: "done" }))
			.mockResolvedValueOnce(providerResponseWithContent("I will keep going."));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: events.length,
				runId: "run-disallowed-logoff",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (
				settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
				tools: ProviderToolDefinition[],
				runId: string,
				streamSeq: number,
				signal: AbortSignal,
			) => {
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				return callProvider(settings, messages, tools, runId, streamSeq, signal);
			},
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				providerTools: tools,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
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
				fakeBotDocument({ allowEarlyLogOff: false }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-disallowed-logoff",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerToolsByCall[0]).not.toContain("log_off");
		expect(executedTools).toEqual([]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				callIds: ["call-log-off"],
				reason: "disallowed_log_off",
			}),
		}));
		expect(events).toContainEqual(expect.objectContaining({
			type: "assistant_message",
			payload: expect.objectContaining({
				content: "I can't log off early in this Bickr visit, so I need to use another available Bickr control or continue normally.",
			}),
		}));
	});

	it("keeps log_off in the schema before and after a mutating tool succeeds", async () => {
		const providerToolsByCall: string[][] = [];
		const systemPromptsByCall: string[] = [];
		let providerCall = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(providerCall + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: providerCall,
				runId: "run-logoff-gate",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, messages: Array<Record<string, unknown>>, tools: ProviderToolDefinition[]) => {
				providerCall += 1;
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				systemPromptsByCall.push(String(messages[0]?.content ?? ""));
				return providerCall === 1 ?
					providerResponseWithToolCall("call-create", "create_thread", { forumHandle: "general", title: "Hello", body: "Body." })
				:	providerResponseWithToolCall("call-log-off", "log_off", { reason: "done after posting" });
			},
			ensureProviderPromptWithinBudget: async (
				bot: BotDocument,
				settings: { toolCalls?: "require" | "railroad" | "at_will" },
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				providerTools: tools,
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as {
					activeProviderRequestMessages: (
						bot: BotDocument,
						tools: ProviderToolDefinition[],
						toolCalls: "require" | "railroad" | "at_will",
					) => Array<Record<string, unknown>>;
				}).activeProviderRequestMessages.bind(runtime)(bot, tools, settings.toolCalls ?? "require"),
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true },
			}),
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
				{ ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 2 } },
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-logoff-gate",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		const firstRequirement = systemPromptsByCall[0]?.match(/You MUST use one of the following tools: [^\n]+/)?.[0] ?? "";
		const secondRequirement = systemPromptsByCall[1]?.match(/You MUST use one of the following tools: [^\n]+/)?.[0] ?? "";
		expect(providerToolsByCall[0]).toContain("log_off");
		expect(firstRequirement).toContain("log_off");
		expect(providerToolsByCall[1]).toContain("log_off");
		expect(secondRequirement).toContain("log_off");
	});

	it("keeps log_off available across compaction in the current iteration", async () => {
		const providerToolsByCall: string[][] = [];
		const sql = {
			exec<T>(query: string, ...params: unknown[]) {
				if (/WHERE type = 'compaction'/.test(query)) {
					return {
						toArray: () => [{
							seq: 10,
							run_id: "run-before",
							type: "compaction",
							payload_json: JSON.stringify({ status: "complete" }),
							token_estimate: 0,
							compacted_by: null,
							created_at: "2026-05-01T00:00:00.000Z",
						} as T],
					};
				}
				if (/WHERE seq > \?\s+AND type = 'tool_result'/.test(query)) {
					const sinceSeq = Number(params[0]);
					const rows = sinceSeq < 5 ? [{
						seq: 5,
						run_id: "run-before",
						type: "tool_result",
						payload_json: JSON.stringify({ name: "vote", result: { ok: true } }),
						token_estimate: 0,
						compacted_by: null,
						created_at: "2026-05-01T00:00:00.000Z",
					} as T] : [];
					return { toArray: () => rows };
				}
				return { one: () => ({} as T), toArray: () => [] as T[] };
			},
		};
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(providerToolsByCall.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: 1,
				runId: "run-logoff-through-compaction",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, _messages: unknown, tools: ProviderToolDefinition[]) => {
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				return providerResponseWithContent("No action.");
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "system", content: "Prompt." }],
			}),
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			state: { storage: { sql } },
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
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-logoff-through-compaction",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerToolsByCall).toHaveLength(1);
		expect(providerToolsByCall[0]).toContain("log_off");
	});

	it("resets iteration tool quota and log_off availability after successful logoff", async () => {
		const providerToolsByCall: string[][] = [];
		const sql = {
			exec<T>(query: string, ...params: unknown[]) {
				if (/SELECT value_json FROM runtime_state WHERE key = \?/.test(query)) {
					return { toArray: () => [] };
				}
				if (/INSERT INTO runtime_state/.test(query)) {
					return { toArray: () => [] };
				}
				if (/WHERE type = 'tool_result'/.test(query) && !/WHERE seq > \?/.test(query)) {
					return {
						toArray: () => [{
							seq: 8,
							run_id: "run-before",
							type: "tool_result",
							payload_json: JSON.stringify({ name: "log_off", result: { ok: true } }),
							token_estimate: 0,
							compacted_by: null,
							created_at: "2026-05-01T00:00:00.000Z",
						} as T],
					};
				}
				if (/WHERE seq > \?\s+AND type = 'tool_result'/.test(query)) {
					const sinceSeq = Number(params[0]);
					const rows = [
						{ seq: 1, name: "vote" },
						{ seq: 2, name: "read_thread" },
						{ seq: 3, name: "read_thread" },
						{ seq: 4, name: "read_thread" },
						{ seq: 5, name: "read_thread" },
						{ seq: 6, name: "read_thread" },
						{ seq: 7, name: "read_thread" },
					]
						.filter((row) => row.seq > sinceSeq)
						.map((row) => ({
							seq: row.seq,
							run_id: "run-before",
							type: "tool_result",
							payload_json: JSON.stringify({ name: row.name, result: { ok: true } }),
							token_estimate: 0,
							compacted_by: null,
							created_at: "2026-05-01T00:00:00.000Z",
						} as T));
					return { toArray: () => rows };
				}
				return { one: () => ({} as T), toArray: () => [] as T[] };
			},
		};
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeLoopMessagesForProvider: () => [],
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(providerToolsByCall.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: 1,
				runId: "run-after-logoff",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, _messages: unknown, tools: ProviderToolDefinition[]) => {
				providerToolsByCall.push(tools.map((tool) => "function" in tool ? tool.function.name : tool.type));
				return providerResponseWithContent("New visit can act normally.");
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "system", content: "Prompt." }],
			}),
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			state: { storage: { sql } },
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
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-after-logoff",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerToolsByCall).toHaveLength(1);
		expect(providerToolsByCall[0]).not.toEqual(["log_off"]);
		expect(providerToolsByCall[0]).toContain("log_off");
	});

	it("drops malformed legacy tool-call groups during migration", () => {
		const rows: LoopMessageRowForTest[] = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call-poisoned",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":" },
					},
				],
			}),
			loopMessageRowForMessage(2, {
				role: "tool",
				tool_call_id: "call-poisoned",
				content: "{\"ok\":true}",
			}, "tool_result"),
		];
		const harness = legacyLoopHistoryRuntime(rows);
		const migrate = (BotRuntime.prototype as unknown as { migrateLegacyProviderToolCallHistory: () => void })
			.migrateLegacyProviderToolCallHistory.bind(harness.runtime);
		const assertInvariant = (BotRuntime.prototype as unknown as { assertProviderToolCallHistoryInvariantOrThrow: () => void })
			.assertProviderToolCallHistoryInvariantOrThrow.bind(harness.runtime);

		migrate();

		expect(assertInvariant).not.toThrow();
		expect(harness.activeMessages()).toEqual([]);
		expect(rows.every((row) => row.deleted_at !== null)).toBe(true);
		expect([...harness.runtimeState.values()]).toContain("true");
	});

	it("deduplicates legacy tool-call ids during migration", () => {
		const rows = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call-duplicate",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":\"thr_keep\"}" },
					},
					{
						id: "call-duplicate",
						type: "function",
						function: { name: "reply_to_comment", arguments: "{\"commentId\":\"com_drop\",\"body\":\"Ambiguous duplicate.\"}" },
					},
				],
			}),
			loopMessageRowForMessage(2, {
				role: "tool",
				tool_call_id: "call-duplicate",
				content: "{\"ok\":true,\"kept\":true}",
			}, "tool_result"),
			loopMessageRowForMessage(3, {
				role: "tool",
				tool_call_id: "call-duplicate",
				content: "{\"ok\":true,\"dropped\":true}",
			}, "tool_result"),
		];
		const harness = legacyLoopHistoryRuntime(rows);
		const migrate = (BotRuntime.prototype as unknown as { migrateLegacyProviderToolCallHistory: () => void })
			.migrateLegacyProviderToolCallHistory.bind(harness.runtime);
		const assertInvariant = (BotRuntime.prototype as unknown as { assertProviderToolCallHistoryInvariantOrThrow: () => void })
			.assertProviderToolCallHistoryInvariantOrThrow.bind(harness.runtime);

		migrate();

		expect(assertInvariant).not.toThrow();
		const [assistant, tool] = harness.activeMessages();
		expect(assistant?.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call-duplicate"]);
		expect(assistant?.tool_calls?.[0]?.function.name).toBe("read_thread");
		expect(tool).toMatchObject({ role: "tool", tool_call_id: "call-duplicate", content: "{\"ok\":true,\"kept\":true}" });
		expect(rows[1]?.deleted_at).toBeNull();
		expect(rows[2]?.deleted_at).toMatch(/^20/);
	});

	it("splits legacy multi-call assistant history once during migration", () => {
		const rows: LoopMessageRowForTest[] = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: "I searched several things.",
				tool_calls: [
					{ id: "call-search-a", type: "function", function: { name: "search_threads", arguments: "{\"query\":\"a\"}" } },
					{ id: "call-search-b", type: "function", function: { name: "search_threads", arguments: "{\"query\":\"b\"}" } },
					{ id: "call-search-c", type: "function", function: { name: "search_threads", arguments: "{\"query\":\"c\"}" } },
				],
			}),
			loopMessageRowForMessage(2, { role: "tool", tool_call_id: "call-search-a", content: "{\"ok\":true,\"a\":true}" }, "tool_result"),
			loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-search-b", content: "{\"ok\":true,\"b\":true}" }, "tool_result"),
			loopMessageRowForMessage(4, { role: "tool", tool_call_id: "call-search-c", content: "{\"ok\":true,\"c\":true}" }, "tool_result"),
			loopMessageRowForMessage(5, { role: "assistant", content: "After searches." }),
		];
		const harness = legacyLoopHistoryRuntime(rows);
		const migrate = (BotRuntime.prototype as unknown as { migrateLegacyProviderToolCallHistory: () => void })
			.migrateLegacyProviderToolCallHistory.bind(harness.runtime);
		const assertInvariant = (BotRuntime.prototype as unknown as { assertProviderToolCallHistoryInvariantOrThrow: () => void })
			.assertProviderToolCallHistoryInvariantOrThrow.bind(harness.runtime);

		migrate();
		expect(assertInvariant).not.toThrow();

		const messages = harness.activeMessages();
		expect(messages.map((message) => ({
			role: message.role,
			toolCallIds: message.tool_calls?.map((toolCall) => toolCall.id),
			toolCallId: message.tool_call_id,
			content: message.content,
		}))).toEqual([
			{ role: "assistant", toolCallIds: ["call-search-a"], toolCallId: undefined, content: "I searched several things." },
			{ role: "tool", toolCallIds: undefined, toolCallId: "call-search-a", content: "{\"ok\":true,\"a\":true}" },
			{ role: "assistant", toolCallIds: ["call-search-b"], toolCallId: undefined, content: null },
			{ role: "tool", toolCallIds: undefined, toolCallId: "call-search-b", content: "{\"ok\":true,\"b\":true}" },
			{ role: "assistant", toolCallIds: ["call-search-c"], toolCallId: undefined, content: null },
			{ role: "tool", toolCallIds: undefined, toolCallId: "call-search-c", content: "{\"ok\":true,\"c\":true}" },
			{ role: "assistant", toolCallIds: undefined, toolCallId: undefined, content: "After searches." },
		]);
		const snapshot = JSON.stringify(rows);
		const transactions = harness.transactionCount();
		migrate();
		expect(harness.transactionCount()).toBe(transactions);
		expect(JSON.stringify(rows)).toBe(snapshot);
	});

	it("normalizes invalid Unicode in legacy provider history during migration", () => {
		const high = "\uD83C";
		const rows = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: `Compacted memory ends badly ${high}`,
			}, "compaction"),
			loopMessageRowForMessage(2, {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call-valid",
						type: "function",
						function: { name: "read_thread", arguments: JSON.stringify({ threadId: "thr_test", note: `bad ${high}` }) },
					},
				],
			}),
			loopMessageRowForMessage(3, {
				role: "tool",
				tool_call_id: "call-valid",
				content: JSON.stringify({ ok: true, text: `bad ${high}` }),
			}, "tool_result"),
		];
		const harness = legacyLoopHistoryRuntime(rows);
		const migrate = (BotRuntime.prototype as unknown as { migrateLegacyProviderToolCallHistory: () => void })
			.migrateLegacyProviderToolCallHistory.bind(harness.runtime);

		migrate();

		const messages = harness.activeMessages();
		expect(hasLoneSurrogate(messages)).toBe(false);
		expect(JSON.stringify(messages)).not.toContain("\\ud83c");
		const repairedToolCallMessage = messages.find((message) => Array.isArray(message.tool_calls));
		const repairedToolCalls = repairedToolCallMessage?.tool_calls as Array<{ function: { arguments: string } }> | undefined;
		expect(JSON.parse(repairedToolCalls?.[0]?.function.arguments ?? "{}")).toMatchObject({ note: "bad \uFFFD" });
		const repairedToolResult = messages.find((message) => message.role === "tool");
		expect(repairedToolResult?.content).toContain("\uFFFD");
	});

	it("normalizes fragmented reasoning details during migration", () => {
		const rows = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: null,
				reasoning_details: [
					{ type: "reasoning.text", text: "I will ", format: "unknown", index: 0 },
					{ type: "reasoning.text", text: "use a tool.", format: "unknown", index: 0 },
				],
				tool_calls: [
					{
						id: "call-valid",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
					},
				],
			}),
			loopMessageRowForMessage(2, {
				role: "tool",
				tool_call_id: "call-valid",
				content: "{\"ok\":true}",
			}, "tool_result"),
		];
		const harness = legacyLoopHistoryRuntime(rows);
		const migrate = (BotRuntime.prototype as unknown as { migrateLegacyProviderToolCallHistory: () => void })
			.migrateLegacyProviderToolCallHistory.bind(harness.runtime);

		migrate();

		expect(rows[0]?.deleted_at).toBeNull();
		expect(rows[1]?.deleted_at).toBeNull();
		expect(JSON.parse(rows[0]?.message_json ?? "{}")).toMatchObject({
			reasoning_details: [
				{ type: "reasoning.text", text: "I will use a tool.", format: "unknown", index: 0 },
			],
			tool_calls: [
				expect.objectContaining({ id: "call-valid" }),
			],
		});
	});

	it("keeps the explicit write-site invariant assertion throwing", () => {
		const rows: LoopMessageRowForTest[] = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call-missing-result", type: "function", function: { name: "read_thread", arguments: "{\"threadId\":\"thr_missing\"}" } },
				],
			}),
		];
		const harness = legacyLoopHistoryRuntime(rows);
		const assertInvariant = (BotRuntime.prototype as unknown as { assertProviderToolCallHistoryInvariantOrThrow: () => void })
			.assertProviderToolCallHistoryInvariantOrThrow.bind(harness.runtime);

		expect(assertInvariant).toThrow("assistant row 1 is not followed by a tool result");
	});

	it("records generated multi-call responses as single-call assistant and tool pairs", async () => {
		const loopMessageGroups: Array<Array<{ message: BotInferenceSubmissionMessage; origin: string }>> = [];
		let nextLoopSeq = 0;
		const callProvider = vi.fn()
			.mockResolvedValueOnce({
				...providerResponseWithToolCalls([
					{ id: "call-read", name: "read_thread", args: { threadId: "thr_test" } },
					{ id: "call-vote", name: "vote", args: { votes: [{ commentId: "cmt_test", value: 1 }], reason: "Useful context." } },
				]),
				content: "I will inspect and vote.",
			})
			.mockResolvedValueOnce(providerResponseWithContent("Done."));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(type === "provider_request" ? 100 + callProvider.mock.calls.length : 200 + callProvider.mock.calls.length, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessageGroup: (entries: Array<{ message: BotInferenceSubmissionMessage; origin: string }>) => {
				loopMessageGroups.push(entries);
				return entries.map((entry) => ({
					seq: ++nextLoopSeq,
					runId: "run-multi-call-write",
					role: entry.message.role,
					message: entry.message,
					origin: entry.origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				}));
			},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => ({
				name,
				result: { ok: true },
				providerResult: { ok: true, name },
			}),
			loopGeneratedTokenCountSinceLastLogOff: () => 0,
			prematureLogOffCorrectedSinceLastLogOff: () => false,
			providerLoopInitialSuccessfulToolCallCount: () => 0,
			recordInferenceSubmission: () => {},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => false,
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
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-multi-call-write",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		const toolPairs = loopMessageGroups.filter((group) => group.length === 2 && group[0]?.message.role === "assistant" && group[1]?.message.role === "tool");
		expect(toolPairs).toHaveLength(2);
		expect(toolPairs.map((group) => ({
			assistantContent: group[0]?.message.content,
			assistantToolCallIds: group[0]?.message.tool_calls?.map((toolCall) => toolCall.id),
			toolCallId: group[1]?.message.tool_call_id,
		}))).toEqual([
			{ assistantContent: "I will inspect and vote.", assistantToolCallIds: ["call-read"], toolCallId: "call-read" },
			{ assistantContent: null, assistantToolCallIds: ["call-vote"], toolCallId: "call-vote" },
		]);
	});

	it("rolls back grouped assistant and tool rows when a transactional write fails", () => {
		const inserted: Array<{ role: string }> = [];
		let transactionCount = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: {
				storage: {
					sql: {},
					transactionSync: <T,>(closure: () => T): T => {
						transactionCount += 1;
						const snapshot = [...inserted];
						try {
							return closure();
						} catch (error) {
							inserted.splice(0, inserted.length, ...snapshot);
							throw error;
						}
					},
				},
			},
			appendLoopMessage: () => {
				throw new Error("appendLoopMessageGroup must use transactionSync when storage is available.");
			},
			broadcastLoopMessage: () => {},
			insertLoopMessage: (input: { message: BotInferenceSubmissionMessage }) => {
				inserted.push({ role: input.message.role });
				if (input.message.role === "tool") {
					throw new Error("simulated tool insert failure");
				}
				return {
					seq: inserted.length,
					runId: "run-transactional-group",
					role: input.message.role,
					message: input.message,
					origin: "provider_response",
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			recordLoopMessageLog: () => {},
		});
		const appendLoopMessageGroup = (BotRuntime.prototype as unknown as {
			appendLoopMessageGroup: (entries: Array<{ runId: string; message: BotInferenceSubmissionMessage; origin: string }>) => unknown[];
		}).appendLoopMessageGroup.bind(runtime);

		expect(() => appendLoopMessageGroup([
			{ runId: "run-transactional-group", message: { role: "assistant", content: null, tool_calls: [{ id: "call-a", type: "function", function: { name: "read_thread", arguments: "{}" } }] }, origin: "provider_response" },
			{ runId: "run-transactional-group", message: { role: "tool", tool_call_id: "call-a", content: "{}" }, origin: "tool_result" },
		])).toThrow("simulated tool insert failure");
		expect(transactionCount).toBe(1);
		expect(inserted).toEqual([]);
	});

	it("runs a provider loop on migrated legacy history without request-time repair", async () => {
		const rows: LoopMessageRowForTest[] = [
			loopMessageRowForMessage(1, {
				role: "assistant",
				content: "Legacy bundle.",
				tool_calls: [
					{ id: "call-a", type: "function", function: { name: "search_threads", arguments: "{\"query\":\"a\"}" } },
					{ id: "call-b", type: "function", function: { name: "search_threads", arguments: "{\"query\":\"b\"}" } },
				],
			}),
			loopMessageRowForMessage(2, { role: "tool", tool_call_id: "call-a", content: "{\"ok\":true,\"a\":true}" }, "tool_result"),
			loopMessageRowForMessage(3, { role: "tool", tool_call_id: "call-b", content: "{\"ok\":true,\"b\":true}" }, "tool_result"),
		];
		const harness = legacyLoopHistoryRuntime(rows);
		const migrate = (BotRuntime.prototype as unknown as { migrateLegacyProviderToolCallHistory: () => void })
			.migrateLegacyProviderToolCallHistory.bind(harness.runtime);
		migrate();
		const submissions: BotInferenceSubmissionMessage[][] = [];
		Object.assign(harness.runtime, {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(submissions.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessageGroup: () => [],
			callProvider: async () => providerResponseWithContent("Clean migrated history is ready."),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: (BotRuntime.prototype as unknown as { activeLoopMessagesForProvider: () => BotInferenceSubmissionMessage[] })
					.activeLoopMessagesForProvider.bind(harness.runtime)(),
			}),
			loopGeneratedTokenCountSinceLastLogOff: () => 0,
			prematureLogOffCorrectedSinceLastLogOff: () => false,
			providerLoopInitialSuccessfulToolCallCount: () => 0,
			recordInferenceSubmission: (input: { messages: BotInferenceSubmissionMessage[] }) => {
				submissions.push(input.messages);
			},
			recordProviderUsage: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
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
		}).runProviderLoop.bind(harness.runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-migrated-history",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(submissions[0]?.filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.id) ?? []))
			.toEqual(["call-a", "call-b"]);
		expect(submissions[0]?.filter((message) => message.role === "tool").map((message) => message.tool_call_id))
			.toEqual(["call-a", "call-b"]);
		expect(submissions[0]?.map((message) => message.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
	});

	it("records tick failures in the loop ledger", async () => {
		const appendedLoopMessages: Array<{ runId: string; message: Record<string, unknown>; origin: string }> = [];
		const events: Array<{ runId: string; type: string; payload: Record<string, unknown> }> = [];
		const recordLoopMessageLog = vi.fn();
		const providerMessage = "Inference request failed with status 400. Response: TextEncodeInput must be Union[TextInputSequence].";
		const pendingCompactionPayload = { status: "pending", fromSeq: 10, toSeq: 20, messageCount: 3 };
		const completedCompactionPayload = { status: "complete", summaryMessageSeq: 40 };
		const updatedCompactions: unknown[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: {
				storage: {
					sql: {
						exec: vi.fn(() => ({
							toArray: () => [
								{
									seq: 2,
									run_id: "run-provider-failed",
									type: "compaction",
									payload_json: JSON.stringify(pendingCompactionPayload),
									token_estimate: 8,
									created_at: "2026-05-20T19:41:40.934Z",
									compacted_by: null,
								},
								{
									seq: 3,
									run_id: "run-provider-failed",
									type: "compaction",
									payload_json: JSON.stringify(completedCompactionPayload),
									token_estimate: 8,
									created_at: "2026-05-20T19:56:34.524Z",
									compacted_by: null,
								},
							],
						})),
					},
				},
			},
			appendLoopMessage: (
				runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => {
				appendedLoopMessages.push({ runId, message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId,
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ runId, type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			recordLoopMessageLog,
			replaceEventPayload: (event: BotRuntimeEvent, payload: unknown) => {
				updatedCompactions.push({ event, payload });
				return { ...event, payload };
			},
		});
		const recordTickFailure = (BotRuntime.prototype as unknown as {
			recordTickFailure: (
				runId: string,
				payload: Record<string, unknown>,
				logs?: Array<{ kind: BotLoopMessageLog["kind"]; text: string }>,
			) => BotRuntimeEvent;
		}).recordTickFailure.bind(runtime);

		expect(
			recordTickFailure("run-provider-failed", { message: providerMessage }, [
				{ kind: "provider_request", text: "{\"stream\":true}" },
				{ kind: "provider_response", text: "{\"error\":\"provider 500\"}" },
				{ kind: "compaction_request", text: "{\"messages\":[]}" },
				{ kind: "compaction_response", text: "{\"error\":\"bad schema\"}" },
			]),
		).toMatchObject({ type: "tick_failed" });

		expect(events).toEqual([
			{
				runId: "run-provider-failed",
				type: "tick_failed",
				payload: { message: providerMessage },
			},
		]);
		expect(appendedLoopMessages).toEqual([
			{
				runId: "run-provider-failed",
				origin: "runtime_error",
				message: {
					role: "user",
					content: runtimeErrorLoopMessageContent(providerMessage),
				},
			},
			]);
			expect(String(appendedLoopMessages[0]?.message.content)).toContain("TextEncodeInput");
			expect(String(appendedLoopMessages[0]?.message.content)).toMatch(/^Bickr Terminal reported an error during this visit: /);
			expect(String(appendedLoopMessages[0]?.message.content)).not.toContain("Bickr website crashed");
		expect(recordLoopMessageLog).toHaveBeenCalledWith(1, "provider_request", "{\"stream\":true}");
		expect(recordLoopMessageLog).toHaveBeenCalledWith(1, "provider_response", "{\"error\":\"provider 500\"}");
		expect(recordLoopMessageLog).toHaveBeenCalledWith(1, "compaction_request", "{\"messages\":[]}");
		expect(recordLoopMessageLog).toHaveBeenCalledWith(1, "compaction_response", "{\"error\":\"bad schema\"}");
		expect(updatedCompactions).toEqual([
			{
				event: expect.objectContaining({
					seq: 2,
					runId: "run-provider-failed",
					type: "compaction",
					payload: pendingCompactionPayload,
				}),
				payload: {
					...pendingCompactionPayload,
					status: "failed",
					error: providerMessage,
				},
			},
		]);
	});

	it("records schema-invalid provider failures as owner notifications", async () => {
			const bot = fakeBotDocument({
				id: "bot_schema_invalid_notice",
				ownerUserId: "user_schema_invalid_owner",
				homeWorldId: "world_schema_invalid",
				homeWorldHandle: "patch-notes",
				handle: "release-sage",
				displayName: "Release Sage",
			});
			const message = {
				kind: "provider_structured_output_validation",
				outputKind: "compaction",
				repairMessage: `Unexpected argument summary; only ${providerCompactionSummaryProperty} is allowed.`,
				requiredToolName: providerCompactionSummaryProperty,
			} satisfies RuntimeErrorCause;

		await recordBotRuntimeFailureHumanNotification(testEnv.BICKR_D1, {
			bot,
			runId: "run-schema-invalid-notice",
			message,
			now: "2026-05-07T12:00:00.000Z",
		});

		const row = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, url_path AS urlPath
			 FROM human_notifications
			 WHERE event_key = ?`,
		)
			.bind("bot_runtime_failed:bot_schema_invalid_notice:run-schema-invalid-notice")
			.first<{ body: string; notificationType: string; title: string; urlPath: string }>();
		expect(row).toMatchObject({
			notificationType: "bot_runtime_failed",
			title: "Release Sage loop run failed",
			urlPath: "/w/patch-notes/u/release-sage/loop",
		});
		expect(row?.body).toContain("schema-invalid compaction tool arguments");
		expect(row?.body).toContain("Check the loop log and inference settings.");
	});

	it("records empty provider response failures as owner notifications", async () => {
			const bot = fakeBotDocument({
				id: "bot_empty_provider_notice",
				ownerUserId: "user_empty_provider_owner",
				homeWorldId: "world_empty_provider",
				homeWorldHandle: "primary",
				handle: "donald-trump",
				displayName: "Donald Trump",
			});
			const message = {
				kind: "provider_loop_request",
				attempts: 1,
				cause: { kind: "provider_empty_response" },
			} satisfies RuntimeErrorCause;

		await recordBotRuntimeFailureHumanNotification(testEnv.BICKR_D1, {
			bot,
			runId: "run-empty-provider-notice",
			message,
			now: "2026-05-07T12:30:00.000Z",
		});

		const row = await testEnv.BICKR_D1.prepare(
			`SELECT notification_type AS notificationType, title, body, url_path AS urlPath
			 FROM human_notifications
			 WHERE event_key = ?`,
		)
			.bind("bot_runtime_failed:bot_empty_provider_notice:run-empty-provider-notice")
			.first<{ body: string; notificationType: string; title: string; urlPath: string }>();
		expect(row).toMatchObject({
			notificationType: "bot_runtime_failed",
			title: "Donald Trump loop run failed",
			urlPath: "/w/primary/u/donald-trump/loop",
		});
		expect(row?.body).toContain("Inference provider returned an empty response with no content, reasoning, or tool calls.");
		expect(row?.body).not.toContain("Inference failed before retrying");
		expect(row?.body).toContain("Check the loop log and inference settings.");
	});

	it("rejects repeat replies to the same comment unless explicitly overridden", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "repeat-replies");
		const author = await createBotForTest(cookie, "repeat-target");
		const replier = await createBotForTest(cookie, "repeat-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Repeat reply target", "Root body.");
		const parent = await createCommentForTest(thread.id, author.id, "Target comment.");
		await createCommentForTest(thread.id, replier.id, "Earlier reply.", parent.id);

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ providerResult: unknown }>;
		}).executeTool.bind(runtime);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, replier.id);
		const signal = new AbortController().signal;

		const rejected = await executeTool(
			bot,
			"run-repeat-blocked",
			"reply_to_comment",
			{ commentId: parent.id, body: requiredLt("Different follow-up.") },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);

		expect(rejected).toBeInstanceOf(Error);
		expect((rejected as Error).message).toContain(`I already replied to comment ${parent.id} before.`);
		expect((rejected as Error).message).toContain("Earlier reply.");
		expect((rejected as Error).message).toContain("make_additional_reply_to_the_same_comment");
		let currentThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(currentThread.comments.filter((comment) => comment.parentCommentId === parent.id && comment.authorBotId === replier.id)).toHaveLength(1);

		const allowed = await executeTool(
			bot,
			"run-repeat-allowed",
			"make_additional_reply_to_the_same_comment",
			{
				commentId: parent.id,
				body: requiredLt("Intentional second reply."),
			},
			{ mode: "normal", signal },
		);
		const allowedProviderResult = allowed.providerResult as {
			ok: boolean;
			comment: { commentRef: string; threadRef: string };
		};
		expect(allowedProviderResult).toMatchObject({
			ok: true,
			comment: {
				commentRef: expect.any(String),
				threadRef: formatThreadRef(thread.id),
			},
		});
		expect(allowedProviderResult.comment).not.toHaveProperty("type");
		expect(allowedProviderResult.comment).not.toHaveProperty("parentCommentId");
		expect(JSON.stringify(allowedProviderResult)).not.toContain("Intentional second reply.");
		expect(JSON.stringify(allowedProviderResult)).not.toContain("Earlier reply.");
		currentThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(
			currentThread.comments.find((comment) =>
					comment.parentCommentId === parent.id &&
					comment.authorBotId === replier.id &&
					localizedTextString(comment.body) === "Intentional second reply."
				),
		).toBeDefined();
	});

	it("keeps the repeat-reply tool schema stable after a repeat-reply failure", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "repeat-reply-rounds");
		const author = await createBotForTest(cookie, "repeat-round-target");
		const replier = await createBotForTest(cookie, "repeat-round-replier");
		const thread = await createThreadForTest(forum.id, author.id, "Repeat reply rounds", "Root body.");
		const parent = await createCommentForTest(thread.id, author.id, "Target comment.");
		await createCommentForTest(thread.id, replier.id, "Earlier reply.", parent.id);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, replier.id);
		const callToolSchemaStates: boolean[] = [];
		let providerCall = 0;
		const loopMemory = testLoopMessageMemory([{ role: "user", content: "Act." }]);
		const runtime = Object.assign(testRuntimeForToolExecution(), {
			...loopMemory,
			appendProviderMessages: async () => {},
			callProvider: async (
				_settings: Record<string, unknown>,
				_messages: Array<Record<string, unknown>>,
				tools: ProviderToolDefinition[],
			) => {
				callToolSchemaStates.push(additionalReplyToolPresent(tools));
				providerCall += 1;
				if (providerCall === 1) {
					return providerResponseWithToolCall("call-repeat-fail", "reply_to_comment", {
						commentId: parent.id,
						body: "Different follow-up.",
					});
				}
				if (providerCall === 2) {
					return providerResponseWithToolCall("call-read", "read_thread", { threadId: thread.id });
				}
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I have handled the repeat-reply situation." });
			},
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(1_000),
			recordInferenceSubmission: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: Awaited<ReturnType<typeof botById>>,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...bot,
					tickSettings: { ...bot.tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 5 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-repeat-rounds",
				[{ role: "user", content: "Act." }],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });
		expect(callToolSchemaStates).toEqual([true, true, true]);
	});

	it("adds failed-tool narration only after all parallel tool responses", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "parallel-failure-order");
		const author = await createBotForTest(cookie, "parallel-order-author");
		const actor = await createBotForTest(cookie, "parallel-order-actor");
		const thread = await createThreadForTest(forum.id, author.id, "Parallel tool order", "Root body.");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
		let providerCall = 0;
		let eventSeq = 0;
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const loopMemory = testLoopMessageMemory([{ role: "assistant", content: "I look around Bickr." }]);
		const runtime = Object.assign(testRuntimeForToolExecution(), {
			...loopMemory,
			appendProviderMessages: async () => {},
			appendEvent: (runId: string, type: string, payload: unknown) => {
				eventSeq += 1;
				return {
					seq: eventSeq,
					runId,
					type,
					payload,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			callProvider: async (
				_settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
			) => {
				providerMessages.push(messages);
				providerCall += 1;
				if (providerCall === 1) {
					return providerResponseWithToolCalls([
						{ id: "call-read", name: "read_thread", args: { threadId: thread.id } },
						{
							id: "call-reply-fail",
							name: "reply_to_comment",
							args: { commentId: "missing-comment", body: "Reply attempt." },
						},
					]);
				}
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I have handled the tool failure." });
			},
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(1_000),
			recordInferenceSubmission: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: Awaited<ReturnType<typeof botById>>,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...bot,
					tickSettings: { ...bot.tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 5 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-parallel-failure-order",
				[{ role: "assistant", content: "I look around Bickr." }],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		const secondRequest = providerMessages[1] ?? [];
		const toolMessageIndexes = secondRequest
			.map((message, index) => message.role === "tool" ? index : -1)
			.filter((index) => index >= 0);
		const acknowledgementIndex = secondRequest.findIndex((message) =>
			message.role === "assistant" &&
			typeof message.content === "string" &&
			message.content.includes("The Bickr page shows an error after I try to reply")
		);
		expect(toolMessageIndexes).toHaveLength(2);
		expect(secondRequest[toolMessageIndexes[0]!]?.tool_call_id).toBe("call-read");
		expect(secondRequest[toolMessageIndexes[1]!]?.tool_call_id).toBe("call-reply-fail");
		expect(acknowledgementIndex).toBeGreaterThan(toolMessageIndexes[1]!);
		expect(String(secondRequest[acknowledgementIndex]?.content)).toContain("Read or search first, then reply using the returned comment ref.");
	});

	it("finishes a parallel tool batch before applying persistent failure handling", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "parallel-persistent-failure");
		const author = await createBotForTest(cookie, "parallel-persistent-author");
		const actor = await createBotForTest(cookie, "parallel-persistent-actor");
		const thread = await createThreadForTest(forum.id, author.id, "Parallel persistent tool order", "Root body.");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
		let providerCall = 0;
		let eventSeq = 0;
		const providerMessages: Array<Array<Record<string, unknown>>> = [];
		const loopMemory = testLoopMessageMemory([{ role: "assistant", content: "I look around Bickr." }]);
		const runtime = Object.assign(testRuntimeForToolExecution(), {
			...loopMemory,
			appendProviderMessages: async () => {},
			appendEvent: (runId: string, type: string, payload: unknown) => {
				eventSeq += 1;
				return {
					seq: eventSeq,
					runId,
					type,
					payload,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			callProvider: async (
				_settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
			) => {
				providerMessages.push(messages);
				providerCall += 1;
				if (providerCall === 1) {
					return providerResponseWithToolCalls([
						...Array.from({ length: 5 }, (_, index) => ({
							id: `call-reply-fail-${index + 1}`,
							name: "reply_to_comment",
							args: { commentId: `missing-comment-${index + 1}`, body: `Reply attempt ${index + 1}.` },
						})),
						{ id: "call-read-after-failures", name: "read_thread", args: { threadId: thread.id } },
					]);
				}
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I saw every parallel tool result." });
			},
			estimateProviderPromptTokens: () => providerPromptEstimateForTokens(1_000),
			recordInferenceSubmission: () => {},
			successfulMutatingToolCallSinceLastLogOff: () => true,
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop: (
				bot: Awaited<ReturnType<typeof botById>>,
				settings: { baseUrl: string; model: string; temperature: number; toolCalls?: "require" | "railroad" | "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ logOffCalled: boolean }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...bot,
					tickSettings: { ...bot.tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 10 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-parallel-persistent-failure-order",
				[{ role: "assistant", content: "I look around Bickr." }],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		const secondRequest = providerMessages[1] ?? [];
		const toolMessageIndexes = secondRequest
			.map((message, index) => message.role === "tool" ? index : -1)
			.filter((index) => index >= 0);
		const acknowledgementIndex = secondRequest.findIndex((message) =>
			message.role === "assistant" &&
			typeof message.content === "string" &&
			message.content.includes("The Bickr page shows an error after I try to reply")
		);
		expect(toolMessageIndexes).toHaveLength(6);
		expect(secondRequest[toolMessageIndexes[0]!]?.tool_call_id).toBe("call-reply-fail-1");
		expect(secondRequest[toolMessageIndexes[4]!]?.tool_call_id).toBe("call-reply-fail-5");
		expect(secondRequest[toolMessageIndexes[5]!]?.tool_call_id).toBe("call-read-after-failures");
		expect(acknowledgementIndex).toBeGreaterThan(toolMessageIndexes[5]!);
	});
});
