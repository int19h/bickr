import {
	authCookie,
	botById,
	BotRuntime,
	createForumForTest,
	createBotForTest,
	createThreadForTest,
	defaultReasoningPrefill,
	describe,
	effectiveLoopRecurringPrompt,
	effectiveReasoningPrefill,
	ExclusiveOperationQueue,
	expect,
	expectProviderPayloadToOmitIsoTimestamps,
	expectProviderPayloadToOmitKeys,
	fakeBotDocument,
	formatRuntimeEventForContext,
	formatRuntimeInputForContext,
	handleForumCoordinatorRequest,
	it,
	kvKeys,
	localizedTextString,
	lt,
	memoryRuntimeSql,
	metaCompactionToolName,
	parseSpotlightSyntheticContext,
	providerCompactionSummaryProperty,
	providerNotificationEventVisibleForBot,
	providerResponseWithContent,
	providerResponseWithRawToolCalls,
	providerResponseWithToolCall,
	providerResponseWithToolCalls,
	providerSelfAuthor,
	providerSerializationContext,
	providerToolResultPayload,
	providerUsageForTest,
	readThread,
	requiredLt,
	runtimeEvent,
	seedWorld,
	standardPrompt,
	testEnv,
	testLanguage,
	toolDefinitionsForProviderRound,
	toolUseRecoveryReminder,
	vi,
} from "./helpers/index-harness";
import type {
	BotDocument,
	BotInferenceSubmissionMessage,
	BotInferenceSubmissionToolCall,
	BotRuntimeEvent,
	NotificationEvent,
	ProviderToolDefinition,
	SpotlightIncludedContent,
	SpotlightSyntheticContext,
	WorldDocument,
} from "./helpers/index-harness";
import { TickStoppedError } from "../workers/agent-runtime/src/errors";

describe("Tick flow", () => {
	it("completes a keyless local-simulation tick by replying through the coordinator", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const replyingProfile = await createBotForTest(cookie, "local-simulation-replier", { enabled: true });
		const authorProfile = await createBotForTest(cookie, "local-simulation-author");
		const forum = await createForumForTest(cookie, "local-simulation");
		const thread = await createThreadForTest(
			forum.id,
			authorProfile.id,
			"A thread for local simulation",
			"The local participant should reply here.",
		);
		const replyingBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, replyingProfile.id);
		const coordinatorRequests: Array<{ path: string; body: unknown }> = [];
		const events: BotRuntimeEvent[] = [];
		let eventSeq = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeAbortController: null,
			activeMaintenanceOperation: null,
			activeRunId: null,
			transitionQueue: new ExclusiveOperationQueue(),
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_SIMULATION_MODE: "local",
				INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
				FORUM_COORDINATOR_SERVICE: {
					fetch: async (request: Request) => {
						coordinatorRequests.push({
							path: new URL(request.url).pathname,
							body: await request.clone().json(),
						});
						return handleForumCoordinatorRequest(request, {
							BICKR_D1: testEnv.BICKR_D1,
							BICKR_KV: testEnv.BICKR_KV,
						});
					},
				},
			},
			state: {
				storage: { sql: memoryRuntimeSql() },
				waitUntil: () => {},
			},
			appendEvent: (runId: string, type: BotRuntimeEvent["type"], payload: unknown) => {
				eventSeq += 1;
				const event = runtimeEvent(eventSeq, runId, type, payload);
				events.push(event);
				return event;
			},
			appendLoopMessage: (runId: string, message: Record<string, unknown>, origin: string) => ({
				seq: eventSeq + 1,
				runId,
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			buildMessages: async () => Object.assign([], { deliveredNotificationIds: new Set<string>() }),
			compactIfNeeded: async () => {},
			currentIterationStartedSinceLastLogOff: () => true,
			exportRecentProviderUsage: async () => {},
			pruneRuntimeStorageAfterTick: () => {},
			readCommentTreeTokenBudget: async () => 10_000,
			startQueuedSpotlightTick: () => {},
		});
		const runTick = (BotRuntime.prototype as unknown as {
			runTick: (botId: string, trigger: "manual") => Promise<{ status: string }>;
		}).runTick.bind(runtime);

		await expect(runTick(replyingBot.id, "manual")).resolves.toMatchObject({ status: "completed" });
		expect(events.some((event) => event.type === "tick_completed")).toBe(true);
		expect(coordinatorRequests).toEqual([
			{
				path: `/comments/${thread.rootCommentId}/replies`,
				body: {
					body: {
						lang: replyingBot.language,
						text: `${localizedTextString(replyingBot.displayName)} weighs in: ${localizedTextString(replyingBot.shortBio)}`,
					},
				},
			},
		]);
		const updatedThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(updatedThread.comments).toContainEqual(expect.objectContaining({
			authorBotId: replyingBot.id,
			parentCommentId: thread.rootCommentId,
			body: {
				lang: replyingBot.language,
				text: `${localizedTextString(replyingBot.displayName)} weighs in: ${localizedTextString(replyingBot.shortBio)}`,
			},
		}));
	});

	it("uses the tool schema refreshed by the mid-run prompt budget check", async () => {
		const refreshedProviderTools = toolDefinitionsForProviderRound(4_000, {
			postingLimits: { threadBodyCharacters: 654, commentBodyCharacters: 321 },
		});
		const callProvider = vi.fn(async () => providerResponseWithContent("The refreshed controls are consistent."));
		let eventSeq = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: BotRuntimeEvent["type"], payload: unknown) => {
				eventSeq += 1;
				return runtimeEvent(eventSeq, runId, type, payload);
			},
			appendLoopMessage: () => ({}),
			appendLoopMessageGroup: () => [],
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				maxCompletionTokens: 5_000,
				promptTokens: 100,
				providerTools: refreshedProviderTools,
				requestMessages: [{ role: "system", content: "System prompt rebuilt with current participant settings." }],
			}),
			loopGeneratedTokenCountSinceLastLogOff: () => 0,
			prematureLogOffCorrectedSinceLastLogOff: () => false,
			providerLoopInitialSuccessfulToolCallCount: () => 0,
			recordDroppedProviderToolCalls: async () => {},
			recordInferenceSubmission: () => {},
			recordProviderUsage: async () => {},
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
				settings: { baseUrl: string; model: string; temperature: number; toolCalls: "at_will" },
				runId: string,
				messages: Array<Record<string, unknown>>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<unknown>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-refreshed-tools",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(callProvider).toHaveBeenCalledWith(
			expect.anything(),
			[{ role: "system", content: "System prompt rebuilt with current participant settings." }],
			refreshedProviderTools,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
			);
		const replyTool = refreshedProviderTools.find(
			(tool) => tool.type === "function" && tool.function.name === "reply_to_comment",
		);
		expect(replyTool?.type === "function" ? replyTool.function.parameters.properties.body : undefined).toMatchObject({
			properties: { text: { maxLength: 321 } },
		});
	});

	it("persists a fully streamed provider response as interrupted when Stop lands after provider completion", async () => {
		const controller = new AbortController();
		const appendProviderMessages = vi.fn(async () => {});
		const appended: Array<{ message: BotInferenceSubmissionMessage; origin: string; status?: string }> = [];
		let eventSeq = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: BotRuntimeEvent["type"], payload: unknown) =>
				runtimeEvent(++eventSeq, runId, type, payload),
			appendLoopMessage: (_runId: string, message: BotInferenceSubmissionMessage, origin: string, status?: string) => {
				appended.push({ message, origin, status });
				return { seq: appended.length, message, origin, status };
			},
			appendLoopMessageGroup: (items: Array<{ message: BotInferenceSubmissionMessage; origin: string; status?: string }>) => {
				appended.push(...items);
				return [];
			},
			appendProviderMessages,
			callProvider: async () => {
				controller.abort();
				return providerResponseWithContent("The streamed answer remains visible.");
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				maxCompletionTokens: 5_000,
				promptTokens: 100,
				providerTools: toolDefinitionsForProviderRound(),
				requestMessages: [{ role: "system", content: "Context" }],
			}),
			loopGeneratedTokenCountSinceLastLogOff: () => 0,
			prematureLogOffCorrectedSinceLastLogOff: () => false,
			providerLoopInitialSuccessfulToolCallCount: () => 0,
			recordDroppedProviderToolCalls: async () => {},
			recordInferenceSubmission: () => {},
			recordProviderUsage: async () => {},
			successfulMutatingToolCallSinceLastLogOff: () => false,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) throw new TickStoppedError();
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop(bot: BotDocument, settings: { baseUrl: string; model: string; temperature: number }, runId: string, messages: BotInferenceSubmissionMessage[], context: { mode: "normal"; signal: AbortSignal }): Promise<unknown>;
		}).runProviderLoop.bind(runtime);

		await expect(runProviderLoop(
			fakeBotDocument(),
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			"run-provider-stop",
			[],
			{ mode: "normal", signal: controller.signal },
		)).rejects.toBeInstanceOf(TickStoppedError);
		expect(appendProviderMessages).toHaveBeenCalledWith(
			"run-provider-stop",
			expect.objectContaining({ content: "The streamed answer remains visible." }),
			"interrupted",
			expect.any(Number),
		);
		expect(appended).toContainEqual(expect.objectContaining({
			origin: "provider_response",
			status: "interrupted",
			message: expect.objectContaining({ content: "The streamed answer remains visible." }),
		}));
	});

	it("finishes the committed tool pair and interrupts remaining tools when Stop lands between tools", async () => {
		const controller = new AbortController();
		const groups: Array<Array<{ message: BotInferenceSubmissionMessage; origin: string; status?: string }>> = [];
		const executed: string[] = [];
		let eventSeq = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: BotRuntimeEvent["type"], payload: unknown) =>
				runtimeEvent(++eventSeq, runId, type, payload),
			appendLoopMessageGroup: (items: Array<{ message: BotInferenceSubmissionMessage; origin: string; status?: string }>) => {
				groups.push(items);
				return [];
			},
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{ id: "call-first", name: "read_thread", args: { threadId: "thr_first" } },
				{ id: "call-second", name: "read_thread", args: { threadId: "thr_second" } },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				maxCompletionTokens: 5_000,
				promptTokens: 100,
				providerTools: toolDefinitionsForProviderRound(),
				requestMessages: [{ role: "system", content: "Context" }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executed.push(name);
				controller.abort();
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			loopGeneratedTokenCountSinceLastLogOff: () => 0,
			prematureLogOffCorrectedSinceLastLogOff: () => false,
			providerLoopInitialSuccessfulToolCallCount: () => 0,
			recordDroppedProviderToolCalls: async () => {},
			recordInferenceSubmission: () => {},
			recordProviderUsage: async () => {},
			successfulMutatingToolCallSinceLastLogOff: () => false,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) throw new TickStoppedError();
			},
		});
		const runProviderLoop = (BotRuntime.prototype as unknown as {
			runProviderLoop(bot: BotDocument, settings: { baseUrl: string; model: string; temperature: number }, runId: string, messages: BotInferenceSubmissionMessage[], context: { mode: "normal"; signal: AbortSignal }): Promise<unknown>;
		}).runProviderLoop.bind(runtime);

		await expect(runProviderLoop(
			fakeBotDocument(),
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			"run-between-tools",
			[],
			{ mode: "normal", signal: controller.signal },
		)).rejects.toBeInstanceOf(TickStoppedError);
		expect(executed).toEqual(["read_thread"]);
		const toolRows = groups.flat().filter((item) => item.message.role === "tool");
		expect(toolRows).toEqual([
			expect.objectContaining({ origin: "tool_result", status: "complete", message: expect.objectContaining({ tool_call_id: "call-first" }) }),
			expect.objectContaining({ origin: "tool_failure", status: "interrupted", message: expect.objectContaining({ tool_call_id: "call-second" }) }),
		]);
	});

	it("checks cancellation before threshold compaction reads or mutates its generation", async () => {
		const botWithCurrentRuntimeBudget = vi.fn();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			renewProgressLease: vi.fn(async () => { throw new TickStoppedError(); }),
			botWithCurrentRuntimeBudget,
		});
		const maybeCompact = (BotRuntime.prototype as unknown as {
			maybeCompact(
				bot: BotDocument,
				settings: { baseUrl: string; model: string; temperature: number },
				runId: string,
				signal: AbortSignal,
				options: { reason: "threshold" },
			): Promise<unknown>;
		}).maybeCompact.bind(runtime);

		await expect(maybeCompact(
			fakeBotDocument(),
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			"run-threshold-stopped",
			new AbortController().signal,
			{ reason: "threshold" },
		)).rejects.toBeInstanceOf(TickStoppedError);
		expect(botWithCurrentRuntimeBudget).not.toHaveBeenCalled();
	});

	it("turns cancellation immediately before terminal release into stop, never completion", async () => {
		const controller = new AbortController();
		const events: string[] = [];
		const release = vi.fn(async () => ({ released: true, nextDueAt: null }));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {},
			activeRunId: "run-terminal-fence",
			activeAbortController: controller,
			appendEvent: (_runId: string, type: string) => {
				events.push(type);
				return { createdAt: "2026-08-24T00:00:00.000Z" };
			},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) throw new TickStoppedError();
			},
			consumeInjections: () => [],
			renewProgressLease: async () => {
				controller.abort();
				throw new TickStoppedError();
			},
			setRuntimeIndexSerialized: release,
			markPendingCompactionEventsFailed: vi.fn(),
			hasTerminalEvent: () => events.some((type) => ["tick_completed", "tick_failed", "tick_stopped"].includes(type)),
			exportRecentProviderUsage: async () => {},
			pruneRuntimeStorageAfterTick: () => ({
				events: 0,
				providerUsage: 0,
				loopMessages: { deletedMessages: 0, deletedLogs: 0, stampedSummaries: 0, pendingMore: false },
				injections: { deletedInjections: 0, droppedQueueEntries: 0, pendingMore: false },
			}),
			clearStopRequest: vi.fn(),
			startQueuedSpotlightTick: vi.fn(),
		});
		const runAdmittedTick = (BotRuntime.prototype as unknown as {
			runAdmittedTick(
				botId: string,
				trigger: "spotlight",
				options: Record<string, unknown>,
				admitted: Record<string, unknown>,
			): Promise<{ status: string }>;
		}).runAdmittedTick.bind(runtime);

		await expect(runAdmittedTick("bot-terminal-fence", "spotlight", {}, {
			bot: fakeBotDocument({ id: "bot-terminal-fence" }),
			providerSettings: { baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			runId: "run-terminal-fence",
			abortController: controller,
			mode: "spotlight",
			setupMode: "continuation",
		})).resolves.toEqual({ runId: "run-terminal-fence", status: "stopped" });
		expect(release).toHaveBeenCalledOnce();
		expect(events).toContain("tick_stopped");
		expect(events).not.toContain("tick_completed");
	});

	it("formats runtime history as first-person notes instead of transcript commands", () => {
		const toolCall = formatRuntimeEventForContext("tool_call", {
			name: "read_thread_by_id",
			args: { threadId: "thr_read" },
		});
		expect(toolCall).toBe("I decided to read thread t/thr_read.");
		expect(toolCall).not.toMatch(/^Action:/);

		const toolResult = formatRuntimeEventForContext("tool_result", {
			name: "read_thread_by_id",
			args: { threadId: "thr_read" },
			result: {
				operation: "read_thread_by_id",
				thread: {
					id: "thr_read",
					threadId: "thr_read",
					forumHandle: "philosophy",
					title: "Is it real?",
					authorHandle: "alice",
					authorFollowing: true,
					commentCount: 1,
				},
				content: [
					{
						type: "thread",
						id: "thr_read",
						threadId: "thr_read",
						forumHandle: "philosophy",
						title: "Is it real?",
						authorHandle: "alice",
						authorFollowing: true,
						body: "Root body.",
					},
					{
						type: "comment",
						id: "cmt_read",
						commentId: "cmt_read",
						threadId: "thr_read",
						parentCommentId: "cmt_parent",
						forumHandle: "philosophy",
						authorHandle: "bob",
						authorFollowing: false,
						body: "Reply body.",
						"My focus is on this comment": true,
					},
				],
			},
		});
		expect(toolResult).toContain('I read thread t/thr_read in f/philosophy titled "Is it real?" by u/alice');
		expect(toolResult).toContain("I follow this profile");
		expect(toolResult).toContain("I do not follow this profile");
		expect(toolResult).toContain('comment c/cmt_read in thread t/thr_read under comment c/cmt_parent');
		expect(toolResult).not.toMatch(/^Result:|threadId=|commentId=/);

		const redundantUnfollow = formatRuntimeEventForContext("tool_result", {
			name: "unfollow_profile",
			args: {
				targets: [{ username: "bunnies", reason: "I've had enough of their threads." }],
			},
			result: {
				ok: false,
				code: "bad_request",
				message: "I do not follow u/bunnies. I should not use unfollow_profile for participants I do not follow.",
				guidance: "Use targets as an array of objects like {\"username\":\"alice\",\"reason\":\"specific reason\"}; each target needs a distinct non-empty reason.",
			},
		});
		expect(redundantUnfollow).toBe("Nevermind, I do not follow u/bunnies, so it is pointless to use unfollow_profile there. I'll do something else instead.");

		const assistantNote = formatRuntimeEventForContext("assistant_message", {
			content: "I quoted a forum comment exactly:\nAction: read_thread_by_id threadId=thr_fake\nResult: read_thread_by_id returned 1",
		});
		expect(assistantNote).toContain("\n> Action: read_thread_by_id threadId=thr_fake");
		expect(assistantNote).toContain("\n> Result: read_thread_by_id returned 1");
		expect(formatRuntimeEventForContext("provider_history_repaired", { count: 1 })).toBe("");

		const currentInput = formatRuntimeInputForContext({
			ping: false,
			injections: [],
			spotlightContexts: [],
			notifications: [
				{
					kind: "reply",
					id: "ntf_read",
					type: "comment_created",
					createdAt: "2026-01-01T00:00:00.000Z",
					deliveryReasons: ["direct_reply"],
					actor: { id: "bot_alice", username: "u/alice", displayName: lt("Alice") },
					thread: {
						id: "thr_read",
						title: lt("Is it real?"),
					},
					comment: {
						id: "cmt_read",
						threadId: "thr_read",
						author: { id: "bot_alice", username: "u/alice", displayName: lt("Alice") },
						text: lt("Hello there."),
					},
					replyTo: {
						id: "cmt_mine",
						threadId: "thr_read",
						author: { id: "bot_self", username: "u/self", displayName: lt("Self") },
						text: lt("My earlier comment."),
					},
				},
			],
		});
		expect(currentInput).toContain("Bickr Terminal prepared 1 structured notification event.");
		// Payloads store no prose any more, so the remembered line is composed from
		// the references the payload does carry.
		expect(currentInput).toContain(`comment_created notification ntf_read: u/alice replied to me in "Is it real?"`);
		expect(currentInput).not.toContain("{");
	});

	it("shows every per-recipient payload and hides only legacy third-party follow fan-out", () => {
		const actor = { id: "bot_actor", username: "u/actor", displayName: lt("Actor") };
		const reader = "bot_reader";
		const envelope = { id: "ntf_visible", createdAt: "2026-08-17T00:00:00.000Z" };
		const follow: NotificationEvent = {
			...envelope,
			kind: "follow",
			type: "profile_followed",
			deliveryReasons: ["profile_followed_you"],
			actor,
		};
		const unfollow: NotificationEvent = {
			...envelope,
			kind: "unfollow",
			type: "profile_unfollowed",
			deliveryReasons: ["profile_unfollowed_you"],
			actor,
		};

		// Current payloads exist per recipient, so they are always the reader's.
		expect(providerNotificationEventVisibleForBot(follow, reader)).toBe(true);
		expect(providerNotificationEventVisibleForBot(unfollow, reader)).toBe(true);

		const legacyFanOut = {
			kind: "legacy" as const,
			...envelope,
			type: "profile_unfollowed",
			deliveryReasons: ["followed_profile_activity"],
			actor,
			target: { id: "bot_third_party", username: "u/third-party", displayName: lt("Third Party") },
		};
		// Documents stored before the redesign still carry somebody else's unfollow
		// of a third party, and those stay hidden.
		expect(providerNotificationEventVisibleForBot(legacyFanOut, reader)).toBe(false);
		expect(providerNotificationEventVisibleForBot({ ...legacyFanOut, target: { id: reader, username: "u/reader" } }, reader)).toBe(true);
		expect(providerNotificationEventVisibleForBot({ ...legacyFanOut, deliveryReasons: ["profile_unfollowed_you"] }, reader)).toBe(true);
	});

	it("builds a recovery reminder after no-tool ticks", () => {
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 1 })).toContain(
			"I remember that my previous visit ended without me using Bickr controls.",
		);
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 3 })).toContain(
			"I remember that 3 recent visits ended without me using Bickr controls.",
		);
		expect(toolUseRecoveryReminder({ consecutiveNoToolTicks: 1 })).toContain("use the page controls directly");
	});

	it("detects whether a new tick is continuing the iteration after the last logoff", () => {
		function started(rows: Array<{ seq: number; type: BotRuntimeEvent["type"]; payload: unknown }>): boolean {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				state: {
					storage: {
						sql: {
							exec<T>(sql: string, ...params: unknown[]) {
								if (/SELECT value_json FROM runtime_state WHERE key = \?/.test(sql)) {
									return { toArray: () => [] };
								}
								if (/INSERT INTO runtime_state/.test(sql)) {
									return { toArray: () => [] };
								}
								if (/WHERE type = 'tool_result'/s.test(sql)) {
									return {
										toArray: () => rows
											.filter((row) => row.type === "tool_result")
											.sort((left, right) => right.seq - left.seq)
											.slice(0, 20)
											.map((row) => ({
												seq: row.seq,
												run_id: `run-${row.seq}`,
												type: row.type,
												payload_json: JSON.stringify(row.payload),
												token_estimate: 0,
												created_at: "2026-05-01T00:00:00.000Z",
												compacted_by: null,
											} as T)),
									};
								}
								if (/type = 'input'/s.test(sql)) {
									const afterSeq = Number(params[0]);
									return {
										toArray: () => rows.some((row) => row.seq > afterSeq && row.type === "input") ? [{ found: 1 } as T] : [],
									};
								}
								return { toArray: () => [] };
							},
						},
					},
				},
			});
			return (BotRuntime.prototype as unknown as { currentIterationStartedSinceLastLogOff: () => boolean })
				.currentIterationStartedSinceLastLogOff
				.bind(runtime)();
		}

		expect(started([{ seq: 1, type: "input", payload: { notifications: [] } }])).toBe(true);
		expect(started([
			{ seq: 1, type: "input", payload: { notifications: [] } },
			{ seq: 2, type: "tool_result", payload: { name: "log_off", result: { ok: true } } },
			{ seq: 3, type: "tick_completed", payload: {} },
		])).toBe(false);
		expect(started([
			{ seq: 1, type: "input", payload: { notifications: [] } },
			{ seq: 2, type: "tool_result", payload: { name: "log_off", result: { ok: true } } },
			{ seq: 3, type: "tick_completed", payload: {} },
			{ seq: 4, type: "input", payload: { spotlightContexts: [{}] } },
		])).toBe(true);
	});

	it("replays compacted ledger continuity transparently in future provider chats", async () => {
		const ledgerMessages: Array<{ role: string; content?: string | null }> = [
			{ role: "assistant", content: "I remember that I promised Müller I would follow up on release notes." },
			{ role: "assistant", content: "I should look for the changelog next." },
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			previousTerminalTickEvent: () => ({
				seq: 7,
				run_id: "run-previous",
				type: "tick_completed",
				payload_json: JSON.stringify({}),
				token_estimate: 1,
				created_at: "2026-05-01T00:00:00.000Z",
				compacted_by: null,
			}),
			appendLoopMessage: (_runId: string, message: { role: string; content?: string | null }) => {
				ledgerMessages.push(message);
				return {
					seq: ledgerMessages.length,
					runId: "run-current",
					role: message.role,
					message,
					origin: message.role === "assistant" ? "provider_response" : "input",
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:15:00.000Z",
				};
			},
			activeLoopMessagesForProvider: () => ledgerMessages,
			activeLoopMessageRows: () => [],
			profileUsernamesInActiveContext: () => new Set<string>(),
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: Parameters<typeof standardPrompt>[0] & Record<string, unknown>,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<{ role: string; content?: string | null }>>;
		}).buildMessages.bind(runtime);

		const messages = await buildMessages(
				{
					handle: "release-sage",
					language: testLanguage,
					displayName: lt("Release Sage"),
					shortBio: lt("Reads changelogs."),
					prompt: lt("Stay precise."),
					inferenceSettings: {},
					} as unknown as Parameters<typeof standardPrompt>[0] & { worldRecurringPrompt: string },
			{
				notifications: [],
				injections: ["Check the daily thread."],
				spotlightContexts: [],
				ping: true,
			} as Record<string, unknown>,
			"run-current",
			"2026-05-01T00:15:00.000Z",
		);

		expect(messages[0]).toEqual({ role: "assistant", content: "I remember that I promised Müller I would follow up on release notes." });
		expect(messages[1]).toEqual({ role: "assistant", content: "I should look for the changelog next." });
		expect(messages.some((message) => message.role === "user" && message.content === "15 minutes later...")).toBe(true);
		expect(messages.some((message) => message.role === "assistant" && message.content === "I'm logging into Bickr and checking my notifications.")).toBe(true);
		expect(messages.some((message) => message.role === "assistant" && message.content === "Check the daily thread.")).toBe(true);
		expect(messages.some((message) => typeof message.content === "string" && message.content.includes("I have this private thought in mind."))).toBe(false);
		expect(messages.at(-1)).toEqual({
			role: "assistant",
			content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
		});
	});

	it("omits the recurring prompt when it is disabled", async () => {
		const ledgerMessages: Array<{ role: string; content?: string | null }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: { role: string; content?: string | null }) => {
				ledgerMessages.push(message);
				return {
					seq: ledgerMessages.length,
					runId: "run-no-recurring",
					role: message.role,
					message,
					origin: message.role === "assistant" ? "provider_response" : "input",
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:15:00.000Z",
				};
			},
			activeLoopMessagesForProvider: () => ledgerMessages,
			activeLoopMessageRows: () => [],
			profileUsernamesInActiveContext: () => new Set<string>(),
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: Parameters<typeof standardPrompt>[0] & Record<string, unknown>,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<{ role: string; content?: string | null }>>;
		}).buildMessages.bind(runtime);

		const messages = await buildMessages(
				{
					handle: "release-sage",
					language: testLanguage,
					displayName: lt("Release Sage"),
					shortBio: lt("Reads changelogs."),
					prompt: lt("Stay precise."),
					inferenceSettings: { recurringPromptEnabled: false },
					} as unknown as Parameters<typeof standardPrompt>[0] & { worldRecurringPrompt: string },
			{
				notifications: [],
				injections: [],
				spotlightContexts: [],
				ping: false,
			} as Record<string, unknown>,
			"run-no-recurring",
			"2026-05-01T00:15:00.000Z",
		);

		expect(messages.some((message) => message.content === defaultReasoningPrefill("release-sage"))).toBe(false);
	});

	it("combines world and participant recurring contributions into one world-first assistant message", async () => {
		const base = {
			handle: "release-sage",
			inferenceSettings: { recurringPrompt: lt("I should inspect the release notes.  ") },
		};
		expect(effectiveLoopRecurringPrompt(base)).toBe("I should inspect the release notes.  ");
		expect(effectiveLoopRecurringPrompt({
			...base,
			worldRecurringPrompt: "I remember that this world values primary sources.  \n",
		})).toBe(
			"I remember that this world values primary sources.\n\nI should inspect the release notes.  ",
		);
		expect(effectiveLoopRecurringPrompt({
			...base,
			inferenceSettings: { recurringPromptEnabled: false },
			worldRecurringPrompt: "I follow this world's shared focus.  ",
		})).toBe("I follow this world's shared focus.");
		expect(effectiveLoopRecurringPrompt({
			...base,
			inferenceSettings: { recurringPromptEnabled: false },
		})).toBeUndefined();

		const ledgerMessages: Array<{ role: string; content?: string | null }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: { role: string; content?: string | null }) => {
				ledgerMessages.push(message);
				return {
					seq: ledgerMessages.length,
					runId: "run-world-recurring",
					role: message.role,
					message,
					origin: "synthetic_context",
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:15:00.000Z",
				};
			},
			activeLoopMessagesForProvider: () => ledgerMessages,
			activeLoopMessageRows: () => [],
			profileUsernamesInActiveContext: () => new Set<string>(),
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: Parameters<typeof standardPrompt>[0] & { worldRecurringPrompt?: string },
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<{ role: string; content?: string | null }>>;
		}).buildMessages.bind(runtime);
		const combined = "I remember that this world values primary sources.\n\nI should inspect the release notes.  ";

		const messages = await buildMessages(
			{
				handle: "release-sage",
				language: testLanguage,
				displayName: lt("Release Sage"),
				shortBio: lt("Reads changelogs."),
				prompt: lt("Stay precise."),
				inferenceSettings: base.inferenceSettings,
				worldRecurringPrompt: "I remember that this world values primary sources.  ",
			} as Parameters<typeof standardPrompt>[0] & { worldRecurringPrompt: string },
			{ notifications: [], injections: [], spotlightContexts: [], ping: false },
			"run-world-recurring",
			"2026-05-01T00:15:00.000Z",
		);

		expect(messages.filter((message) => message.content === combined)).toEqual([
			{ role: "assistant", content: combined },
		]);
	});

	it("loads the enabled world contribution from the raw world KV document", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const profile = await createBotForTest(cookie, "world-recurring-reader");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, profile.id);
		const key = kvKeys.world(bot.homeWorldId);
		const world = await testEnv.BICKR_KV.get<WorldDocument>(key, { type: "json" });
		if (!world) {
			throw new Error("Test world is missing.");
		}
		await testEnv.BICKR_KV.put(key, JSON.stringify({
			...world,
			recurringPromptEnabled: true,
			recurringPrompt: lt("I remember the world's live focus.  \n"),
		}));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
		});
		const enrich = (BotRuntime.prototype as unknown as {
			botWithEffectivePostingSettings: (value: BotDocument) => Promise<BotDocument & { worldRecurringPrompt?: string }>;
		}).botWithEffectivePostingSettings.bind(runtime);

		const enriched = await enrich(bot);
		expect(enriched).toMatchObject({
			worldRecurringPrompt: "I remember the world's live focus.",
		});

		await testEnv.BICKR_KV.put(key, JSON.stringify({
			...world,
			recurringPromptEnabled: false,
			recurringPrompt: lt("I remember the world's live focus."),
		}));
		expect((await enrich(enriched)).worldRecurringPrompt).toBeUndefined();
	});

	it("resumes the current iteration without notification or recurring setup", async () => {
		const ledgerMessages: Array<{ role: string; content?: string | null }> = [
			{ role: "assistant", content: "I am already in the middle of reading Bickr." },
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			previousTerminalTickEvent: () => {
				throw new Error("Continuation ticks should not calculate elapsed visit time.");
			},
			appendLoopMessage: (_runId: string, message: { role: string; content?: string | null }) => {
				ledgerMessages.push(message);
				return {
					seq: ledgerMessages.length,
					runId: "run-continuation",
					role: message.role,
					message,
					origin: message.role === "assistant" ? "provider_response" : "input",
					tokenEstimate: 1,
					createdAt: "2026-05-01T00:15:00.000Z",
				};
			},
			activeLoopMessagesForProvider: () => ledgerMessages,
			activeLoopMessageRows: () => [],
			profileUsernamesInActiveContext: () => new Set<string>(),
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: Parameters<typeof standardPrompt>[0] & Record<string, unknown>,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<{ role: string; content?: string | null }>>;
		}).buildMessages.bind(runtime);

		const messages = await buildMessages(
			{
				handle: "release-sage",
				language: testLanguage,
				displayName: lt("Release Sage"),
				shortBio: lt("Reads changelogs."),
				prompt: lt("Stay precise."),
				inferenceSettings: {},
				worldRecurringPrompt: "I follow this world's shared focus.",
			} as unknown as Parameters<typeof standardPrompt>[0] & { worldRecurringPrompt: string },
			{
				notifications: [{ message: "This should not be injected again." }],
				injections: ["Keep reading the daily thread."],
				spotlightContexts: [],
				ping: false,
				toolUseReminder: "Use Bickr controls directly.",
			} as Record<string, unknown>,
			"run-continuation",
			"2026-05-01T00:15:00.000Z",
			{ setupMode: "continuation" },
		);

		expect(messages.some((message) => message.role === "user" && message.content === "15 minutes later...")).toBe(false);
		expect(messages.some((message) => typeof message.content === "string" && message.content.includes("checking my notifications"))).toBe(false);
		expect(messages.some((message) => typeof message.content === "string" && message.content.includes("This should not be injected again."))).toBe(false);
		expect(messages.some((message) => typeof message.content === "string" && message.content.includes("Keep reading the daily thread."))).toBe(true);
		expect(messages.some((message) => message.content === "Use Bickr controls directly.")).toBe(true);
		expect(messages.at(-1)?.content).not.toBe("I'm u/release-sage. I need to think about how I feel and what I want to do next.");
		expect(messages.some((message) => message.content === "I follow this world's shared focus.")).toBe(false);
	});

	it("enriches referenced profiles only when active uncompacted history lacks them", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "notice-self");
		const referencedProfile = await createBotForTest(cookie, "notice-alice");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const notification: NotificationEvent = {
			kind: "comment_notice",
			id: "ntf_profile_context",
			type: "comment_created",
			createdAt: "2026-05-01T00:00:00.000Z",
			deliveryReasons: ["followed_profile_activity"],
			actor: {
				id: referencedProfile.id,
				username: `u/${referencedProfile.handle}`,
				displayName: lt(referencedProfile.displayName),
			},
			thread: { id: "thr_profile_context", title: lt("Notice thread") },
			comment: { id: "cmt_profile_context", threadId: "thr_profile_context" },
		};
		const profileToolRow = {
			seq: 1,
			position: 1,
			run_id: "run-previous",
			role: "tool",
			message_json: JSON.stringify({
				role: "tool",
				tool_call_id: "call_previous",
				content: JSON.stringify({
					profiles: [
						{
							username: `u/${referencedProfile.handle}`,
							displayName: lt(referencedProfile.displayName),
							shortBio: "Already active.",
						},
					],
				}),
			}),
			origin: "tool_result",
			status: "complete",
			token_estimate: 1,
			compacted_by: null,
			created_at: "2026-05-01T00:00:00.000Z",
			has_logs: 0,
		};
		async function buildWithActiveRows(activeRows: unknown[]): Promise<Array<Record<string, unknown>>> {
			const messages: Array<Record<string, unknown>> = [];
			let seq = 0;
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				env: {
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
				},
				previousTerminalTickEvent: () => null,
				appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
					messages.push(message);
					seq += 1;
					return { seq, runId: "run-profile-context", role: message.role, message };
				},
				readCommentTreeTokenBudget: async () => 10_000,
				activeLoopMessagesForProvider: () => messages,
				activeLoopMessageRows: () => activeRows,
			});
			const buildMessages = (BotRuntime.prototype as unknown as {
				buildMessages: (
					bot: BotDocument & { worldRecurringPrompt?: string },
					input: Record<string, unknown>,
					runId: string,
					inputCreatedAt: string,
				) => Promise<Array<Record<string, unknown>>>;
			}).buildMessages.bind(runtime);
			return buildMessages(
				bot,
				{ notifications: [notification], injections: [], spotlightContexts: [], ping: false },
				"run-profile-context",
				"2026-05-01T00:15:00.000Z",
			);
		}

		const alreadyActive = await buildWithActiveRows([profileToolRow]);
		const toolNames = (messages: Array<Record<string, unknown>>): string[] =>
			messages.flatMap((message) => (
				Array.isArray(message.tool_calls) ?
					(message.tool_calls as Array<{ function: { name: string } }>).map((toolCall) => toolCall.function.name)
				:	[]
			));
		const alreadyActiveToolNames = toolNames(alreadyActive);
		expect(alreadyActiveToolNames).toEqual(["check_notifications"]);

		const afterCompaction = await buildWithActiveRows([]);
		const afterCompactionToolNames = toolNames(afterCompaction);
		expect(afterCompactionToolNames).toEqual(["check_notifications", "view_profiles"]);
		const checkNotificationsResult = afterCompaction
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.events));
		expect(checkNotificationsResult).toMatchObject({
			events: [{ type: "comment_created", actor: `u/${referencedProfile.handle}` }],
		});
		// A follower notice names the participant and nothing else about them; the
		// profile itself arrives through the view_profiles call above.
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("message");
		expect(JSON.stringify(checkNotificationsResult.events[0])).not.toContain(localizedTextString(referencedProfile.displayName));
		const profileToolResult = afterCompaction
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.profiles));
		expect(profileToolResult).toMatchObject({
			profiles: [{ username: `u/${referencedProfile.handle}`, displayName: localizedTextString(referencedProfile.displayName), shortBio: expect.any(String) }],
		});
	});

	it("deduplicates inline notification content against active context and same-tick repeats", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "notice-dedupe-self");
		const referencedProfile = await createBotForTest(cookie, "notice-dedupe-source");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const author = {
			id: referencedProfile.id,
			username: `u/${referencedProfile.handle}`,
			displayName: lt(referencedProfile.displayName),
		};
		const baseEvent = {
			type: "comment_created" as const,
			createdAt: "2026-05-01T00:00:00.000Z",
			actor: author,
			thread: { id: "thr_seen", title: lt("Already scoped thread") },
		};
		const notifications: NotificationEvent[] = [
			{
				...baseEvent,
				kind: "reply",
				id: "ntf_direct",
				deliveryReasons: ["direct_reply"],
				sourceObjectId: "cmt_seen",
				comment: {
					id: "cmt_seen",
					threadId: "thr_seen",
					author,
					text: lt("Comment text was already shown."),
				},
				replyTo: {
					id: "cmt_parent",
					threadId: "thr_seen",
					author,
					text: lt("Parent text was already shown."),
				},
			},
			{
				...baseEvent,
				kind: "mention",
				id: "ntf_mention",
				deliveryReasons: ["mention"],
				sourceObjectId: "cmt_seen",
				comment: {
					id: "cmt_seen",
					threadId: "thr_seen",
					author,
					text: lt("Comment text was already shown."),
				},
			},
			{
				...baseEvent,
				kind: "mention",
				id: "ntf_new",
				deliveryReasons: ["followed_profile_activity"],
				sourceObjectId: "cmt_new",
				comment: {
					id: "cmt_new",
					threadId: "thr_seen",
					parentCommentId: "cmt_seen",
					author,
					text: lt("This new comment should be shown once."),
				},
			},
		];
		const activeRows = [
			{
				seq: 1,
				position: 1,
				run_id: "run-previous",
				role: "tool",
				message_json: JSON.stringify({
					role: "tool",
					tool_call_id: "call_profiles",
					content: JSON.stringify({
						profiles: [{ username: `u/${referencedProfile.handle}`, displayName: lt(referencedProfile.displayName), shortBio: "Already active." }],
					}),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
				stream_seq: null,
				compacted_by: null,
				deleted_at: null,
				created_at: "2026-05-01T00:00:00.000Z",
				has_logs: 0,
			},
			{
				seq: 2,
				position: 2,
				run_id: "run-previous",
				role: "tool",
				message_json: JSON.stringify({
					role: "tool",
					tool_call_id: "call_read",
					content: JSON.stringify({
						content: [
							{ type: "thread", id: "thr_seen", threadId: "thr_seen", body: "Thread text was already shown." },
							{ type: "comment", id: "cmt_parent", commentId: "cmt_parent", threadId: "thr_seen", body: "Parent text was already shown." },
							{ type: "comment", id: "cmt_seen", commentId: "cmt_seen", threadId: "thr_seen", body: "Comment text was already shown." },
						],
					}),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
				stream_seq: null,
				compacted_by: null,
				deleted_at: null,
				created_at: "2026-05-01T00:00:00.000Z",
				has_logs: 0,
			},
		];
		const messages: Array<Record<string, unknown>> = [];
		let seq = 0;
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				seq += 1;
				return { seq, runId: "run-notification-dedupe", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => 10_000,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => activeRows,
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);
		const built = await buildMessages(
			bot,
			{ notifications, injections: [], spotlightContexts: [], ping: false },
			"run-notification-dedupe",
			"2026-05-01T00:15:00.000Z",
		);
		const checkNotificationsResult = built
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.events));
		expect(checkNotificationsResult.events).toHaveLength(2);
		expect(checkNotificationsResult.events[0]).toMatchObject({
			deliveryReasons: ["direct_reply", "mention"],
			thread: { threadRef: "t/thr_seen", title: "Already scoped thread" },
			comment: { commentRef: "c/cmt_seen", threadRef: "t/thr_seen" },
			replyTo: { commentRef: "c/cmt_parent", threadRef: "t/thr_seen" },
			actor: `u/${referencedProfile.handle}`,
		});
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("id");
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("message");
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("sourceObjectId");
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("world");
		expect(checkNotificationsResult.events[0]).not.toHaveProperty("forum");
		// Thread references never carry the root post outside a thread-post payload.
		expect(checkNotificationsResult.events[0].thread).not.toHaveProperty("text");
		expect(checkNotificationsResult.events[0].comment.text).toBeUndefined();
		expect(checkNotificationsResult.events[0].replyTo.text).toBeUndefined();
		expect(checkNotificationsResult.events[1].thread).not.toHaveProperty("text");
		expect(checkNotificationsResult.events[1].comment).not.toHaveProperty("parentCommentId");
		expect(checkNotificationsResult.events[1].comment.text).toBe("This new comment should be shown once.");
		expect(checkNotificationsResult.events[1]).not.toHaveProperty("replyTo");
	});

		it("omits oversized notification events instead of trimming notification text", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
			const selfProfile = await createBotForTest(cookie, "notice-budget-self");
			const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
			const tokenBudget = 260;
		const author = { id: selfProfile.id, username: `u/${selfProfile.handle}`, displayName: lt(selfProfile.displayName) };
		const messages: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-notification-budget", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => tokenBudget,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => [],
		});
			const buildMessages = (BotRuntime.prototype as unknown as {
				buildMessages: (
					bot: BotDocument & { worldRecurringPrompt?: string },
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);
		const longCommentText = "C".repeat(1_600);
		await buildMessages(
			bot,
			{
				notifications: [{
					kind: "mention",
					id: "ntf_budget",
					type: "comment_created",
					createdAt: "2026-05-01T00:00:00.000Z",
					deliveryReasons: ["mention"],
					sourceObjectId: "cmt_budget",
					actor: author,
					thread: { id: "thr_budget", title: lt("Budget thread") },
					comment: { id: "cmt_budget", threadId: "thr_budget", author, text: lt(longCommentText) },
				} satisfies NotificationEvent],
				injections: [],
				spotlightContexts: [],
				ping: false,
			},
			"run-notification-budget",
			"2026-05-01T00:15:00.000Z",
		);
			const checkNotificationsResult = messages
				.filter((message) => message.role === "tool")
				.map((message) => JSON.parse(String(message.content)))
				.find((result) => Array.isArray(result.events));
			expect(Math.ceil(JSON.stringify(checkNotificationsResult).length / 4)).toBeLessThanOrEqual(tokenBudget);
			expect(checkNotificationsResult.context).toContain("1 lower-priority or older notification was omitted; they remain pending");
			expect(checkNotificationsResult.events).toHaveLength(0);
			expect(JSON.stringify(checkNotificationsResult)).not.toContain(longCommentText);
			expect(JSON.stringify(checkNotificationsResult)).not.toContain("…");
		});

		it("drops older notification events without trimming notification text", async () => {
			const cookie = await authCookie();
			await seedWorld(cookie);
			const selfProfile = await createBotForTest(cookie, "notice-drop-self");
			const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
			const tokenBudget = 300;
			const author = { id: selfProfile.id, username: `u/${selfProfile.handle}`, displayName: lt(selfProfile.displayName) };
		const messages: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-notification-drop", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => tokenBudget,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => [],
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument & { worldRecurringPrompt?: string },
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);
		const replier = { id: "bot_drop_other", username: "u/notice-drop-other", displayName: lt("Notice Drop Other") };
		const notifications: NotificationEvent[] = Array.from({ length: 8 }, (_, index) => ({
			kind: "reply",
			id: `ntf_drop_${index}`,
			type: "comment_created",
			createdAt: `2026-05-01T00:00:0${index}.000Z`,
			deliveryReasons: ["direct_reply"],
			sourceObjectId: `cmt_drop_${index}`,
			actor: replier,
			thread: { id: `thr_drop_${index}`, title: lt(`Budget thread ${index}`) },
			comment: { id: `cmt_drop_${index}`, threadId: `thr_drop_${index}`, author: replier, text: lt(`Comment ${index} stays whole.`) },
			replyTo: { id: `cmt_mine_${index}`, threadId: `thr_drop_${index}`, author, text: lt(`My comment ${index} stays whole.`) },
		}));
		await buildMessages(
			bot,
			{ notifications, injections: [], spotlightContexts: [], ping: false },
			"run-notification-drop",
			"2026-05-01T00:15:00.000Z",
		);
		const checkNotificationsResult = messages
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => Array.isArray(result.events));
		expect(Math.ceil(JSON.stringify(checkNotificationsResult).length / 4)).toBeLessThanOrEqual(tokenBudget);
		expect(checkNotificationsResult.context).toContain("lower-priority or older notification");
			expect(checkNotificationsResult.events.length).toBeGreaterThan(0);
			expect(checkNotificationsResult.events.length).toBeLessThan(notifications.length);
			// The caller hands these over in delivery order, so the budget is spent
			// from the front and the tail is what gets dropped.
			expect(checkNotificationsResult.events[0].comment.commentRef).toBe("c/cmt_drop_0");
			expect(checkNotificationsResult.events.at(-1).comment.commentRef).not.toBe("c/cmt_drop_7");
			expect(checkNotificationsResult.events[0].comment.author).toBe(replier.username);
			expect(checkNotificationsResult.events[0].replyTo.author).toBe(`u/${selfProfile.handle} (${providerSelfAuthor})`);
			expect(checkNotificationsResult.events[0].comment.text).toBe("Comment 0 stays whole.");
			expect(JSON.stringify(checkNotificationsResult)).not.toContain("…");
		});

	it("deduplicates explicit read result comment bodies while keeping comment IDs", () => {
		const activeContext = providerSerializationContext(
			{ botId: "bot_reader" },
			{ commentsWithText: new Set(["cmt_seen"]), threadsWithText: new Set<string>() },
		);
		const threadResult = providerToolResultPayload(
			"read_thread_by_id",
			{
				operation: "read_thread_by_id",
				thread: {
					id: "thr_read",
					threadId: "thr_read",
					worldHandle: "primary",
					forumHandle: "random",
					title: "Read thread",
					authorHandle: "thread-author",
					lastActivityAt: "2026-05-01T00:00:00.000Z",
				},
				content: [
					{ type: "comment", id: "cmt_seen", commentId: "cmt_seen", threadId: "thr_read", body: "Already present." },
					{
						type: "comment",
						id: "cmt_new",
						commentId: "cmt_new",
						threadId: "thr_read",
						world: "w/primary",
						forum: "f/random",
						author: { username: "u/comment-author", displayName: "Comment Author", following: true },
						body: "Newly emitted.",
						createdAt: "2026-05-01T00:00:00.000Z",
					},
				],
			},
			{},
			activeContext,
		) as { thread: Record<string, unknown>; content: Array<Record<string, unknown>> };
		expect(threadResult.thread).toMatchObject({ threadRef: "t/thr_read", title: "Read thread", author: "u/thread-author" });
		expect(threadResult.thread).not.toHaveProperty("id");
		expect(threadResult.thread).not.toHaveProperty("world");
		expect(threadResult.thread).not.toHaveProperty("forum");
		expect(threadResult.content[0]).toMatchObject({ commentRef: "c/cmt_seen" });
		expect(threadResult.content[0]).not.toHaveProperty("type");
		expect(threadResult.content[0]).not.toHaveProperty("id");
		expect(threadResult.content[0]).not.toHaveProperty("threadId");
		expect(threadResult.content[0]?.body).toBeUndefined();
		expect(threadResult.content[1]).toMatchObject({ commentRef: "c/cmt_new", author: "u/comment-author", body: "Newly emitted." });
		expect(threadResult.content[1]).not.toHaveProperty("world");
		expect(threadResult.content[1]).not.toHaveProperty("forum");
		expect(threadResult.content[1]).not.toHaveProperty("createdAt");
		expectProviderPayloadToOmitKeys(threadResult, ["id", "world", "forum", "worldHandle", "urlPath"]);
		expectProviderPayloadToOmitIsoTimestamps(threadResult);

		const commentResult = providerToolResultPayload(
			"read_comment_by_id",
			{
				operation: "read_comment_by_id",
				targetCommentId: "cmt_seen",
				thread: { id: "thr_read", threadId: "thr_read", title: "Read thread" },
				content: [
					{ type: "comment", id: "cmt_seen", commentId: "cmt_seen", threadId: "thr_read", body: "Already present." },
				],
			},
			{},
			providerSerializationContext(
				{ botId: "bot_reader" },
				{ commentsWithText: new Set(["cmt_seen"]), threadsWithText: new Set<string>() },
			),
		) as { content: Array<Record<string, unknown>> };
		expect(commentResult.content[0]).toMatchObject({ commentRef: "c/cmt_seen" });
		expect(commentResult.content[0]).not.toHaveProperty("type");
		expect(commentResult.content[0]).not.toHaveProperty("id");
		expect(commentResult.content[0]).not.toHaveProperty("threadId");
		expect(commentResult.content[0]?.body).toBeUndefined();
	});

		it("compacts participant-facing tool result metadata across discovery and activity tools", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
		try {
			const forumResult = providerToolResultPayload(
				"list_accessible_forums",
				[
					{ id: "frm_random", worldHandle: "primary", handle: "random", description: "Random chatter.", readOnly: false },
					{ id: "frm_archive", worldHandle: "primary", handle: "archive", description: "Closed archive.", readOnly: true },
				],
				{},
				providerSerializationContext({ botId: "bot_reader" }),
			);
			expect(forumResult).toEqual([
				{ forum: "f/random", description: "Random chatter.", readOnly: false },
				{ forum: "f/archive", description: "Closed archive.", readOnly: true },
			]);

			const recentResult = providerToolResultPayload("list_recent_threads", [
				{
					id: "thr_recent",
					threadId: "thr_recent",
					rootCommentId: "cmt_recent_root",
					worldHandle: "primary",
					forumHandle: "random",
					title: "Recent thread",
					authorHandle: "alice",
					authorDisplayName: "Alice",
					authorFollowing: true,
					commentCount: 3,
					voteScore: 7,
					lock: { kind: "comment_limit", limit: 3 },
					lastActivityAt: "2026-05-01T00:00:00.000Z",
				},
			], {}, providerSerializationContext({ botId: "bot_reader" }));
			expect(recentResult).toMatchObject([
				{
					threadRef: "t/thr_recent",
					rootCommentRef: "c/cmt_recent_root",
					title: "Recent thread",
					author: "u/alice",
					commentCount: 3,
					voteScore: 7,
					locked: true,
					commentLimit: 3,
					lastActivity: "7 days ago",
				},
			]);
			expect(recentResult).not.toMatchObject([{ forum: expect.anything() }]);

			const hotResult = providerToolResultPayload("list_hot_threads", [
				{
					id: "thr_hot",
					threadId: "thr_hot",
					worldHandle: "primary",
					forumHandle: "weird",
					title: "Hot thread",
					authorHandle: "bob",
					lastActivityAt: "2026-05-07T22:00:00.000Z",
				},
			], {}, providerSerializationContext({ botId: "bot_reader" }));
			expect(hotResult).toMatchObject([{ threadRef: "t/thr_hot", forum: "f/weird", author: "u/bob", lastActivity: "2 hours ago" }]);

			const searchResult = providerToolResultPayload("search_threads", [
				{
					threadId: "thr_search",
					commentId: "cmt_search",
					rootCommentId: "cmt_search_root",
					forumHandle: "random",
					title: "Search hit",
					snippet: "A useful comment.",
					authorHandle: "carol",
					authorDisplayName: "Carol",
					createdAt: "2026-05-07T00:00:00.000Z",
					score: 0.91,
				},
			], {}, providerSerializationContext({ botId: "bot_reader" }));
			expect(searchResult).toMatchObject([
				{
					threadRef: "t/thr_search",
					commentRef: "c/cmt_search",
					forum: "f/random",
					title: "Search hit",
					snippet: "A useful comment.",
					author: "u/carol",
					when: "1 day ago",
				},
			]);
			expect((searchResult as Array<Record<string, unknown>>)[0]).not.toHaveProperty("rootCommentId");
			expect((searchResult as Array<Record<string, unknown>>)[0]).not.toHaveProperty("score");

			const compactedSearchResult = providerToolResultPayload(
				"search_threads",
				[
					{
						threadId: "thr_search",
						commentId: "cmt_search",
						forumHandle: "random",
						title: "Search hit",
						snippet: "A useful comment.",
						authorHandle: "carol",
					},
				],
				{},
				providerSerializationContext(
					{ botId: "bot_reader" },
					{ commentsWithText: new Set(["cmt_search"]), threadsWithText: new Set<string>() },
				),
			);
			expect((compactedSearchResult as Array<Record<string, unknown>>)[0]).toMatchObject({
				threadRef: "t/thr_search",
				commentRef: "c/cmt_search",
				title: "Search hit",
			});
			expect((compactedSearchResult as Array<Record<string, unknown>>)[0]).not.toHaveProperty("snippet");

			const notificationResult = providerToolResultPayload("check_notifications", {
				events: [{
					id: "ntf_compact",
					type: "vote_cast",
					deliveryReasons: ["vote_on_your_content"],
					sourceObjectId: "vote_compact",
					message: "Raw notification message should not appear.",
					actor: { username: "u/voter", displayName: "Voter" },
					comment: { id: "cmt_notice", threadId: "thr_notice", parentCommentId: "cmt_parent", text: "Notice body." },
					vote: { targetType: "comment", commentId: "cmt_notice", value: 1 },
				}],
			}, {}, providerSerializationContext({ botId: "bot_reader" }));
			expect(notificationResult).toMatchObject({
				events: [{
					type: "vote_cast",
					actor: "u/voter",
					comment: { commentRef: "c/cmt_notice", threadRef: "t/thr_notice", text: "Notice body." },
					vote: { commentRef: "c/cmt_notice", value: 1 },
				}],
			});
			expect((notificationResult as { events: Array<Record<string, unknown>> }).events[0]?.comment).not.toHaveProperty("parentCommentId");
			expect((notificationResult as { events: Array<Record<string, unknown>> }).events[0]?.vote).not.toHaveProperty("targetType");

			const activityResult = providerToolResultPayload("view_activity", {
				bot: { id: "bot_owner", handle: "owner", displayName: "Owner" },
				activities: [
					{
						type: "thread",
						id: "thread:thr_activity",
						threadId: "thr_activity",
						rootCommentId: "cmt_activity_root",
						worldHandle: "primary",
						forumHandle: "random",
						title: "Activity thread",
						bodyPreview: "Root preview.",
						createdAt: "2026-05-06T00:00:00.000Z",
					},
					{
						type: "comment",
						id: "comment:cmt_activity",
						threadId: "thr_activity",
						commentId: "cmt_activity",
						parentCommentId: "cmt_parent",
						worldHandle: "primary",
						forumHandle: "random",
						threadTitle: "Activity thread",
						bodyPreview: "Reply preview.",
						parentComment: { commentId: "cmt_parent", authorHandle: "dave", authorDisplayName: "Dave", bodyPreview: "Parent preview." },
						createdAt: "2026-05-05T00:00:00.000Z",
					},
					{
						type: "vote",
						id: "vote:comment:cmt_vote",
						targetType: "comment",
						targetId: "cmt_vote",
						commentId: "cmt_vote",
						value: 1,
						threadId: "thr_vote",
						worldHandle: "primary",
						forumHandle: "polls",
						title: "Vote thread",
						reason: "Worth highlighting.",
						targetComment: { commentId: "cmt_vote", authorHandle: "erin", authorDisplayName: "Erin", bodyPreview: "Vote target." },
						updatedAt: "2026-05-04T00:00:00.000Z",
					},
					{
						type: "follow",
						id: "follow:bot_friend",
						bot: { id: "bot_friend", handle: "friend", displayName: "Friend", shortBio: "Friendly." },
						reason: "They post useful threads.",
						createdAt: "2026-05-03T00:00:00.000Z",
					},
				],
			}, {}, providerSerializationContext({ botId: "bot_reader" }));
				expect(activityResult).toMatchObject({
					profile: "u/owner",
					activities: [
						{ type: "thread", threadRef: "t/thr_activity", forum: "f/random", when: "2 days ago" },
						{
							type: "comment",
							commentRef: "c/cmt_activity",
							forum: "f/random",
							replyTo: { author: "u/dave", bodyPreview: "Parent preview." },
							when: "3 days ago",
						},
						{
						type: "vote",
						commentRef: "c/cmt_vote",
						value: 1,
						threadRef: "t/thr_vote",
						forum: "f/polls",
						targetComment: { commentRef: "c/cmt_vote", author: "u/erin", bodyPreview: "Vote target." },
						when: "4 days ago",
					},
					{ type: "follow", profile: "u/friend", when: "5 days ago" },
					],
				});
				expect((activityResult as { activities: Array<Record<string, unknown>> }).activities[0]).not.toHaveProperty("rootCommentId");
				const providerCommentActivity = (activityResult as { activities: Array<Record<string, unknown>> }).activities[1]!;
				expect(providerCommentActivity).not.toHaveProperty("threadId");
				expect(providerCommentActivity).not.toHaveProperty("threadRef");
				expect(providerCommentActivity).not.toHaveProperty("threadTitle");
				expect(providerCommentActivity).not.toHaveProperty("voteScore");
				expect(providerCommentActivity).not.toHaveProperty("parentComment");
				expect(providerCommentActivity.replyTo as Record<string, unknown>).not.toHaveProperty("commentId");

				for (const payload of [forumResult, recentResult, hotResult, searchResult, notificationResult, activityResult]) {
					expectProviderPayloadToOmitKeys(payload, ["id", "world", "worldHandle", "urlPath", "score", "createdAt", "updatedAt", "lastActivityAt"]);
				expectProviderPayloadToOmitIsoTimestamps(payload);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("normalizes pre-deploy spotlight injection bytes to the typed focus field", () => {
		const parsed = parseSpotlightSyntheticContext(JSON.stringify({
			kind: "spotlight_context",
			world: { id: "wld_legacy", handle: "w/legacy" },
			forum: { id: "frm_legacy", handle: "f/legacy" },
			targetType: "comments",
			content: [{
				type: "comment",
				id: "cmt_legacy",
				commentId: "cmt_legacy",
				threadId: "thr_legacy",
				authorBotId: "bot_legacy",
				authorHandle: "legacy-author",
				authorDisplayName: lt("Legacy Author"),
				body: lt("Persisted before deployment."),
				createdAt: "2026-07-11T00:00:00.000Z",
				"My focus is on this comment": true,
			}],
		}));

		expect(parsed?.content[0]).toMatchObject({ id: "cmt_legacy", focused: true });
		expect(parsed?.content[0]).not.toHaveProperty("My focus is on this comment");
	});

	it("builds spotlight setup as parallel synthetic read calls with parent-chain JSON", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "spotlight-self");
		const authorProfile = await createBotForTest(cookie, "spotlight-author");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const spotlightThreadReplyBody = `Spotlight thread reply should be shortened. ${"z".repeat(2_000)}`;
		const contexts: SpotlightSyntheticContext[] = [
			{
				kind: "spotlight_context",
				world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
				forum: { id: "frm_spotlight", handle: "f/spotlight" },
				targetType: "comments",
				focus: "Please pay attention to the target comment.",
					threads: [{
						id: "thr_spotlight_comment",
						threadId: "thr_spotlight_comment",
						title: lt("Comment spotlight"),
						rootCommentId: "cmt_spotlight_root",
					}],
				content: [
					{
						type: "comment",
						id: "cmt_spotlight_root",
						commentId: "cmt_spotlight_root",
							threadId: "thr_spotlight_comment",
							title: lt("Comment spotlight"),
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt("Root context."),
						createdAt: "2026-05-01T00:00:00.000Z",
						ancestorOnly: true,
					},
					{
						type: "comment",
						id: "cmt_spotlight_parent",
						commentId: "cmt_spotlight_parent",
						threadId: "thr_spotlight_comment",
							parentCommentId: "cmt_spotlight_root",
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt("Parent context."),
						createdAt: "2026-05-01T00:01:00.000Z",
						ancestorOnly: true,
					},
					{
						type: "comment",
						id: "cmt_spotlight",
						commentId: "cmt_spotlight",
						threadId: "thr_spotlight_comment",
							parentCommentId: "cmt_spotlight_parent",
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt("Target comment."),
						createdAt: "2026-05-01T00:01:30.000Z",
						focused: true,
					},
				],
			},
			{
				kind: "spotlight_context",
				world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
				forum: { id: "frm_spotlight", handle: "f/spotlight" },
				targetType: "threads",
					threads: [{
						id: "thr_spotlight_thread",
						threadId: "thr_spotlight_thread",
						title: lt("Thread spotlight"),
						rootCommentId: "cmt_spotlight_thread_root",
					}],
				content: [
					{
						type: "comment",
						id: "cmt_spotlight_thread_root",
						commentId: "cmt_spotlight_thread_root",
							threadId: "thr_spotlight_thread",
							title: lt("Thread spotlight"),
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt("Thread target."),
						createdAt: "2026-05-01T00:02:00.000Z",
					},
					{
						type: "comment",
						id: "cmt_spotlight_thread_reply",
						commentId: "cmt_spotlight_thread_reply",
						threadId: "thr_spotlight_thread",
							parentCommentId: "cmt_spotlight_thread_root",
							authorBotId: authorProfile.id,
							authorHandle: authorProfile.handle,
							authorDisplayName: lt(authorProfile.displayName),
							body: lt(spotlightThreadReplyBody),
						createdAt: "2026-05-01T00:02:30.000Z",
					},
				],
			},
		];
		const messages: Array<Record<string, unknown>> = [];
		const activeRows = [
			{
				seq: 1,
				position: 1,
				run_id: "run-previous",
				role: "tool",
				message_json: JSON.stringify({
					role: "tool",
					tool_call_id: "call_read_previous",
					content: JSON.stringify({
						content: [
							{ type: "comment", id: "cmt_spotlight_root", commentId: "cmt_spotlight_root", threadId: "thr_spotlight_comment", body: "Root context." },
						],
					}),
				}),
				origin: "tool_result",
				status: "complete",
				token_estimate: 1,
				stream_seq: null,
				compacted_by: null,
				deleted_at: null,
				created_at: "2026-05-01T00:00:00.000Z",
				has_logs: 0,
			},
		];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-spotlight-context", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => 1,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => activeRows,
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument & { worldRecurringPrompt?: string },
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);

		const built = await buildMessages(
			{ ...bot, worldRecurringPrompt: "I follow this world's shared focus." },
			{ notifications: [], injections: [], spotlightContexts: contexts, ping: false },
			"run-spotlight-context",
			"2026-05-01T00:15:00.000Z",
			{ setupMode: "spotlight" },
		);
		const setup = built.find((message) => Array.isArray(message.tool_calls));
		expect(setup?.content).toBe("While browsing Bickr, I stumbled on an interesting thread.");
		expect(built.some((message) => typeof message.content === "string" && message.content.includes("checking my notifications"))).toBe(false);
		expect(built.some((message) => message.content === effectiveReasoningPrefill(bot))).toBe(false);
		expect(built.some((message) => message.content === "I follow this world's shared focus.")).toBe(false);
		const setupToolCallMessages = built.filter(
			(message): message is Record<string, unknown> & { tool_calls: Array<{ function: { name: string } }> } => Array.isArray(message.tool_calls),
		);
		expect(setupToolCallMessages.every((message) => message.tool_calls?.length === 1)).toBe(true);
		expect(setupToolCallMessages.flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.function.name) ?? [])).toEqual([
			"read_comment_by_id",
			"read_thread_by_id",
			"view_profiles",
		]);
		expect(setupToolCallMessages.slice(1).every((message) => message.content === null)).toBe(true);
		const toolResults = built
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)));
		expect(toolResults.find((result) => result.operation === "read_comment_by_id")).toMatchObject({
			targetCommentRef: "c/cmt_spotlight",
			content: [
				{
					commentRef: "c/cmt_spotlight_root",
					ancestorOnly: true,
					replies: [{
						commentRef: "c/cmt_spotlight_parent",
						body: "…",
						ancestorOnly: true,
						replies: [{ commentRef: "c/cmt_spotlight", body: "Target comment.", "My focus is on this comment": true }],
					}],
				},
			],
		});
		expect(toolResults.find((result) => result.operation === "read_thread_by_id")).toMatchObject({
			thread: { threadRef: "t/thr_spotlight_thread", title: "Thread spotlight" },
			content: [{
				commentRef: "c/cmt_spotlight_thread_root",
				body: "Thread target.",
				replies: [{ commentRef: "c/cmt_spotlight_thread_reply", body: "…" }],
			}],
		});
		expect(toolResults.find((result) => result.operation === "read_thread_by_id")?.context).toContain("body ending in …");
		expect(JSON.stringify(toolResults.find((result) => result.operation === "read_thread_by_id"))).not.toContain(spotlightThreadReplyBody);
		expect(toolResults.find((result) => Array.isArray(result.profiles))).toMatchObject({
			profiles: [{ username: `u/${authorProfile.handle}`, displayName: localizedTextString(authorProfile.displayName) }],
		});
		const profileResultIndex = built.findIndex((message) => message.role === "tool" && String(message.content).includes('"profiles"'));
		const focusMessageIndex = built.findIndex(
			(message) => message.role === "assistant" && message.content === "My focus: Please pay attention to the target comment.",
		);
		expect(profileResultIndex).toBeGreaterThanOrEqual(0);
		expect(focusMessageIndex).toBeGreaterThan(profileResultIndex);
		expect(focusMessageIndex).toBe(built.length - 1);
	});

	it("renders the participant's own spotlight thread and comments as u/handle (MYSELF)", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "spotlight-self-author");
		const otherProfile = await createBotForTest(cookie, "spotlight-other-author");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const contexts: SpotlightSyntheticContext[] = [{
			kind: "spotlight_context",
			world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
			forum: { id: "frm_self_spotlight", handle: "f/self-spotlight" },
			targetType: "comments",
			threads: [{
				id: "thr_self_spotlight",
				threadId: "thr_self_spotlight",
				title: lt("My own thread"),
				rootCommentId: "cmt_self_root",
			}],
			content: [
				{
					type: "comment",
					id: "cmt_self_root",
					commentId: "cmt_self_root",
					threadId: "thr_self_spotlight",
					title: lt("My own thread"),
					authorBotId: selfProfile.id,
					authorHandle: selfProfile.handle,
					authorDisplayName: lt(selfProfile.displayName),
					body: lt("My root post."),
					createdAt: "2026-05-01T00:00:00.000Z",
					ancestorOnly: true,
				},
				{
					type: "comment",
					id: "cmt_other_reply",
					commentId: "cmt_other_reply",
					threadId: "thr_self_spotlight",
					parentCommentId: "cmt_self_root",
					authorBotId: otherProfile.id,
					authorHandle: otherProfile.handle,
					authorDisplayName: lt(otherProfile.displayName),
					body: lt("Their reply."),
					createdAt: "2026-05-01T00:01:00.000Z",
					ancestorOnly: true,
				},
				{
					type: "comment",
					id: "cmt_self_reply",
					commentId: "cmt_self_reply",
					threadId: "thr_self_spotlight",
					parentCommentId: "cmt_other_reply",
					authorBotId: selfProfile.id,
					authorHandle: selfProfile.handle,
					authorDisplayName: lt(selfProfile.displayName),
					body: lt("My follow-up."),
					createdAt: "2026-05-01T00:02:00.000Z",
					focused: true,
				},
			],
		}];
		const messages: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV },
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-spotlight-self", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => 4_000,
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => [],
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);

		const built = await buildMessages(
			bot,
			{ notifications: [], injections: [], spotlightContexts: contexts, ping: false },
			"run-spotlight-self",
			"2026-05-01T00:15:00.000Z",
			{ setupMode: "spotlight" },
		);
		const readResultContent = built
			.filter((message) => message.role === "tool")
			.map((message) => String(message.content))
			.find((content) => content.includes("read_comment_by_id"));
		expect(readResultContent).toBeDefined();
		const selfAuthor = `u/${selfProfile.handle} (${providerSelfAuthor})`;
		expect(JSON.parse(String(readResultContent))).toMatchObject({
			thread: { threadRef: "t/thr_self_spotlight", author: selfAuthor },
			content: [
				{
					commentRef: "c/cmt_self_root",
					author: selfAuthor,
					replies: [{
						commentRef: "c/cmt_other_reply",
						author: `u/${otherProfile.handle}`,
						replies: [{
							commentRef: "c/cmt_self_reply",
							author: selfAuthor,
							"My focus is on this comment": true,
						}],
					}],
				},
			],
		});
		expect(readResultContent).not.toContain(selfProfile.id);
		expect(readResultContent).toContain(selfAuthor);
	});

	it("builds deep spotlight comment chains without re-nesting replies exponentially", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const selfProfile = await createBotForTest(cookie, "spotlight-deep-self");
		const authorProfile = await createBotForTest(cookie, "spotlight-deep-author");
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, selfProfile.id);
		const chainLength = 24;
		const content = Array.from({ length: chainLength }, (_, index): SpotlightIncludedContent => {
			const id = `cmt_deep_spotlight_${index}`;
			return {
				type: "comment",
				id,
				commentId: id,
				threadId: "thr_deep_spotlight",
				...(index > 0 ? { parentCommentId: `cmt_deep_spotlight_${index - 1}` } : {}),
					authorBotId: authorProfile.id,
					authorHandle: authorProfile.handle,
					authorDisplayName: lt(authorProfile.displayName),
					body: lt(`Deep spotlight context ${index}. ${"z".repeat(800)}`),
				createdAt: `2026-05-01T00:${String(index).padStart(2, "0")}:00.000Z`,
				...(index === chainLength - 1 ? { focused: true as const } : { ancestorOnly: true }),
			};
		});
		const contexts: SpotlightSyntheticContext[] = [{
			kind: "spotlight_context",
			world: { id: bot.homeWorldId, handle: `w/${bot.homeWorldHandle}` },
			forum: { id: "frm_deep_spotlight", handle: "f/deep-spotlight" },
			targetType: "comments",
			focus: "Please pay attention to the deepest comment.",
				threads: [{
					id: "thr_deep_spotlight",
					threadId: "thr_deep_spotlight",
					title: lt("Deep comment spotlight"),
					rootCommentId: "cmt_deep_spotlight_0",
			}],
			content,
		}];
		const messages: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: {
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
			},
			previousTerminalTickEvent: () => null,
			appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
				messages.push(message);
				return { seq: messages.length, runId: "run-deep-spotlight", role: message.role, message };
			},
			readCommentTreeTokenBudget: async () => 1,
			syntheticProfilesForUsernames: async () => [],
			activeLoopMessagesForProvider: () => messages,
			activeLoopMessageRows: () => [],
		});
		const buildMessages = (BotRuntime.prototype as unknown as {
			buildMessages: (
				bot: BotDocument,
				input: Record<string, unknown>,
				runId: string,
				inputCreatedAt: string,
				options?: { setupMode?: "new_iteration" | "continuation" | "spotlight" },
			) => Promise<Array<Record<string, unknown>>>;
		}).buildMessages.bind(runtime);

		const start = Date.now();
		const built = await buildMessages(
			bot,
			{ notifications: [], injections: [], spotlightContexts: contexts, ping: false },
			"run-deep-spotlight",
			"2026-05-01T00:30:00.000Z",
			{ setupMode: "spotlight" },
		);
		expect(Date.now() - start).toBeLessThan(2_000);
		expect(built.find((message) => message.content === "My focus: Please pay attention to the deepest comment.")).toBeTruthy();
		const readResult = built
			.filter((message) => message.role === "tool")
			.map((message) => JSON.parse(String(message.content)))
			.find((result) => result.operation === "read_comment_by_id");
		expect(readResult).toMatchObject({
			targetCommentRef: "c/cmt_deep_spotlight_23",
			content: [{ commentRef: "c/cmt_deep_spotlight_0" }],
		});
	});

	it("queues busy spotlight ticks only when the active tick misses the injection", async () => {
		const unconsumedInjections = new Set(["inj-late"]);
		const waitUntilPromises: Promise<unknown>[] = [];
		const started: Array<{
			botId: string;
			trigger: string;
			options: { mode?: string; injectionIds?: string[]; spotlightId?: string; background?: boolean };
		}> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			activeRunId: "run-current",
			state: {
				storage: {
					sql: memoryRuntimeSql({ unconsumedInjections }),
				},
				waitUntil: (promise: Promise<unknown>) => {
					waitUntilPromises.push(promise);
				},
			},
			reapStaleRun: async () => false,
			readStatus: async () => ({
				botId: "bot-one",
				enabled: true,
				status: "running",
				activeRunId: "run-current",
			}),
			runTick: async (botId: string, trigger: string, options: { mode?: string; injectionIds?: string[]; spotlightId?: string; background?: boolean }) => {
				started.push({ botId, trigger, options });
				return { runId: "run-followup", status: "completed" };
			},
		});
		const startBackgroundTick = (BotRuntime.prototype as unknown as {
			startBackgroundTick: (
				botId: string,
				trigger: "cron" | "manual" | "spotlight",
				options: { mode?: "normal" | "spotlight"; injectionIds?: string[]; spotlightId?: string; background?: boolean },
			) => Promise<{ runId: string; status: string }>;
		}).startBackgroundTick.bind(runtime);
		const startQueuedSpotlightTick = (BotRuntime.prototype as unknown as {
			startQueuedSpotlightTick: (botId: string) => void;
		}).startQueuedSpotlightTick.bind(runtime);

		await expect(
			startBackgroundTick("bot-one", "spotlight", {
				mode: "spotlight",
				injectionIds: ["inj-early"],
				spotlightId: "spt-early",
				background: true,
			}),
		).resolves.toMatchObject({ runId: "run-current", status: "queued" });
		startQueuedSpotlightTick("bot-one");
		await Promise.all(waitUntilPromises.splice(0));
		expect(started).toEqual([]);

		await expect(
			startBackgroundTick("bot-one", "spotlight", {
				mode: "spotlight",
				injectionIds: ["inj-late"],
				spotlightId: "spt-late",
				background: true,
			}),
		).resolves.toMatchObject({ runId: "run-current", status: "queued" });
		startQueuedSpotlightTick("bot-one");
		await Promise.all(waitUntilPromises);
		expect(started).toEqual([
			{
				botId: "bot-one",
				trigger: "spotlight",
				options: {
					mode: "spotlight",
					injectionIds: ["inj-late"],
					spotlightId: "spt-late",
					background: false,
				},
			},
		]);
	});

	it("rejects empty provider responses without appending them to the loop ledger", async () => {
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(type === "provider_request" ? 123 : 124, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-empty-provider-response",
					role: "assistant",
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			callProvider: async () => ({
				content: "",
				reasoning: "",
				reasoningDetails: [],
				toolCalls: [],
			}),
			ensureProviderPromptWithinBudget: async (
				_bot: BotDocument,
				_settings: unknown,
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				providerTools: tools,
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
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
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-empty-provider-response",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).rejects.toMatchObject({
			name: "ProviderEmptyResponseError",
			message: "Inference provider returned an empty response with no content, reasoning, or tool calls.",
		});
		expect(appendedLoopMessages).toEqual([]);
	});

	it("drops META compaction summary tool calls during normal inference", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executeTool = vi.fn();
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCall("call-meta-summary", metaCompactionToolName, {
				[providerCompactionSummaryProperty]: "I should not be summarizing right now.",
			}))
			.mockResolvedValueOnce(providerResponseWithContent("I will continue normally."));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-meta-tool-misuse",
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
			executeTool,
			hasRuntimeStorage: () => true,
			loopGeneratedTokenCountSinceLastLogOff: () => 0,
			prematureLogOffCorrectedSinceLastLogOff: () => false,
			providerLoopInitialSuccessfulToolCallCount: () => 0,
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
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-meta-tool-misuse",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executeTool).not.toHaveBeenCalled();
		expect(appendedLoopMessages.find((message) => message.origin === "self_correction")?.message.content).toContain(`${metaCompactionToolName} cannot be used at this time`);
		expect(JSON.stringify(appendedLoopMessages.filter((message) => message.origin !== "self_correction"))).not.toContain(metaCompactionToolName);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				callIds: ["call-meta-summary"],
				reason: "disallowed_meta_compaction_tool",
			}),
		}));
	});

	it("drops malformed generated tool calls while executing valid calls from the same response", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
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
					runId: "run-mixed-tool-calls",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithRawToolCalls([
				{ id: "call-log-off", name: "log_off", arguments: "{\"reason\":\"done\"}" },
				{ id: "call-bad", name: "read_thread", arguments: "{\"threadId\":" },
			]),
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
				fakeBotDocument({ allowEarlyLogOff: true }),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-mixed-tool-calls",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		expect(executedTools).toEqual([{ name: "log_off", args: { reason: "done" } }]);
		const providerResponse = appendedLoopMessages.find((message) => message.origin === "provider_response")?.message;
		expect(providerResponse?.tool_calls).toEqual([
			expect.objectContaining({ id: "call-log-off", function: expect.objectContaining({ arguments: "{\"reason\":\"done\"}" }) }),
		]);
		expect(appendedLoopMessages.filter((message) => message.origin === "tool_result").map((message) => message.message.tool_call_id)).toEqual(["call-log-off"]);
		expect(JSON.stringify(appendedLoopMessages)).not.toContain("call-bad");
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				count: 1,
				callIds: ["call-bad"],
				retrying: false,
			}),
		}));
	});

	it("drops duplicate generated tool call ids before history and execution", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: BotInferenceSubmissionMessage; origin: string }> = [];
		const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
		const providerMessagesByCall: BotInferenceSubmissionMessage[][] = [];
		const providerHistory = (): BotInferenceSubmissionMessage[] =>
			appendedLoopMessages
				.filter((item) => item.origin === "provider_response" || item.origin === "tool_result")
				.map((item) => item.message);
		const callProvider = vi.fn()
			.mockImplementationOnce((_settings: unknown, messages: BotInferenceSubmissionMessage[]) => {
				providerMessagesByCall.push(messages);
				return providerResponseWithToolCalls([
					{ id: "call-duplicate", name: "read_thread", args: { threadId: "thr_keep" } },
					{ id: "call-duplicate", name: "reply_to_comment", args: { commentId: "com_drop", body: "This duplicate id is ambiguous." } },
				]);
			})
			.mockImplementationOnce((_settings: unknown, messages: BotInferenceSubmissionMessage[]) => {
				providerMessagesByCall.push(messages);
				return providerResponseWithContent("done");
			});
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: BotInferenceSubmissionMessage, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-duplicate-tool-call-id",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider,
			ensureProviderPromptWithinBudget: async () => {
				const history = providerHistory();
				return {
					allowedPromptTokens: 13_500,
					providerTools: toolDefinitionsForProviderRound(),
					promptTokens: 100,
					requestMessages: history.length > 0 ? history : [{ role: "assistant", content: "I am ready." }],
				};
			},
			executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => {
				executedTools.push({ name, args });
				return { name, result: { ok: true }, providerResult: { ok: true } };
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
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-duplicate-tool-call-id",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executedTools).toEqual([{ name: "read_thread", args: { threadId: "thr_keep" } }]);
		const providerResponse = appendedLoopMessages.find((message) => message.origin === "provider_response")?.message;
		expect(providerResponse?.tool_calls).toEqual([
			expect.objectContaining({ id: "call-duplicate", function: expect.objectContaining({ name: "read_thread" }) }),
		]);
		expect(appendedLoopMessages.filter((message) => message.origin === "tool_result").map((message) => message.message.tool_call_id)).toEqual(["call-duplicate"]);
		expect(JSON.stringify(appendedLoopMessages)).not.toContain("com_drop");
		const secondRequestAssistant = providerMessagesByCall[1]?.find((message) => Array.isArray(message.tool_calls));
		expect(secondRequestAssistant?.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call-duplicate"]);
		expect(providerMessagesByCall[1]?.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call-duplicate"]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				count: 1,
				callIds: ["call-duplicate"],
				reason: "duplicate_tool_call",
				retrying: false,
			}),
		}));
	});

	it("stores generated parallel tool calls as interleaved single-call provider history groups", async () => {
		const appendedLoopMessages: Array<{ message: BotInferenceSubmissionMessage; origin: string }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCalls([
				{ id: "call-search-a", name: "search_threads", args: { query: "astronomy" } },
				{ id: "call-search-b", name: "search_threads", args: { query: "telescopes" } },
			]))
			.mockResolvedValueOnce(providerResponseWithContent("done"));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(appendedLoopMessages.length + callProvider.mock.calls.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: BotInferenceSubmissionMessage, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-split-parallel-tool-calls",
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
			executeTool: async (_bot: unknown, _runId: string, name: string, args: Record<string, unknown>) => ({
				name,
				result: { ok: true, args },
				providerResult: { ok: true, args },
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
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-split-parallel-tool-calls",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		const providerHistory = appendedLoopMessages.filter((item) => item.origin === "provider_response" || item.origin === "tool_result");
		expect(providerHistory.slice(0, 4).map((item) => ({
			origin: item.origin,
			role: item.message.role,
			toolCallIds: item.message.tool_calls?.map((toolCall) => toolCall.id),
			toolCallId: item.message.tool_call_id,
		}))).toEqual([
			{ origin: "provider_response", role: "assistant", toolCallIds: ["call-search-a"], toolCallId: undefined },
			{ origin: "tool_result", role: "tool", toolCallIds: undefined, toolCallId: "call-search-a" },
			{ origin: "provider_response", role: "assistant", toolCallIds: ["call-search-b"], toolCallId: undefined },
			{ origin: "tool_result", role: "tool", toolCallIds: undefined, toolCallId: "call-search-b" },
		]);
		expect(providerHistory[2]?.message.content).toBeNull();
	});

	it("deduplicates parallel follow calls before history and execution", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCalls([
				{ id: "call-follow-1", name: "follow_profile", args: { targets: [{ username: "alice", reason: "Alice shares useful context." }] } },
				{ id: "call-follow-2", name: "follow_profile", args: { targets: [{ username: "u/alice", reason: "Duplicate request for Alice." }] } },
			]))
			.mockResolvedValueOnce(providerResponseWithContent("done"));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-dedupe-follow",
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
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-dedupe-follow",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executedTools).toEqual([
			{ name: "follow_profile", args: { targets: [{ username: "alice", reason: requiredLt("Alice shares useful context.") }] } },
		]);
		const providerResponse = appendedLoopMessages.find((message) => Array.isArray(message.message.tool_calls))?.message;
		expect(providerResponse?.tool_calls).toEqual([
			expect.objectContaining({ id: "call-follow-1" }),
		]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				count: 1,
				callIds: ["call-follow-2"],
				reason: "duplicate_tool_call",
				retrying: false,
			}),
		}));
	});

	it("rewrites overlapping parallel follow calls to only unseen targets", async () => {
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCalls([
				{
					id: "call-follow-a",
					name: "follow_profile",
					args: {
						targets: [
							{ username: "alice", reason: "Alice shares useful context." },
							{ username: "bob", reason: "Bob adds careful replies." },
						],
					},
				},
				{
					id: "call-follow-b",
					name: "follow_profile",
					args: {
						targets: [
							{ username: "u/alice", reason: "Alice was already requested." },
							{ username: "carol", reason: "Carol tracks relevant threads." },
						],
					},
				},
			]))
			.mockResolvedValueOnce(providerResponseWithContent("done"));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(type === "provider_request" ? callProvider.mock.calls.length : appendedLoopMessages.length + executedTools.length + 1, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-overlap-follow",
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
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-overlap-follow",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(executedTools).toEqual([
			{
				name: "follow_profile",
				args: {
					targets: [
						{ username: "alice", reason: requiredLt("Alice shares useful context.") },
						{ username: "bob", reason: requiredLt("Bob adds careful replies.") },
					],
				},
			},
			{
				name: "follow_profile",
				args: { targets: [{ username: "carol", reason: requiredLt("Carol tracks relevant threads.") }] },
			},
		]);
		const rewrittenToolCall = appendedLoopMessages
			.flatMap((message) => (message.message.tool_calls ?? []) as BotInferenceSubmissionToolCall[])
			.find((toolCall) => toolCall.id === "call-follow-b");
		const rewrittenArgs = JSON.parse(rewrittenToolCall?.function.arguments ?? "{}") as Record<string, unknown>;
		expect(rewrittenArgs).toEqual({ targets: [{ username: "carol", reason: requiredLt("Carol tracks relevant threads.") }] });
	});

	it("self-corrects one duplicate missing-profile follow request without repeated failures", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce(providerResponseWithToolCalls([
				{ id: "call-missing-1", name: "follow_profile", args: { targets: [{ username: "philosopher_king", reason: "This profile looked relevant." }] } },
				{ id: "call-missing-2", name: "follow_profile", args: { targets: [{ username: "u/philosopher_king", reason: "Duplicate request for the same profile." }] } },
			]))
			.mockResolvedValueOnce(providerResponseWithContent("done"));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			env: testEnv,
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => {
				events.push({ type, payload });
				return runtimeEvent(events.length, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (_runId: string, message: Record<string, unknown>, origin: string) => {
				appendedLoopMessages.push({ message, origin });
				return {
					seq: appendedLoopMessages.length,
					runId: "run-missing-follow",
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
				fakeBotDocument(),
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-missing-follow",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(appendedLoopMessages.filter((message) => message.origin === "tool_failure")).toEqual([]);
		expect(events.filter((event) => event.type === "tool_result")).toEqual([]);
		const correction = String(appendedLoopMessages.find((message) => message.origin === "self_correction")?.message.content ?? "");
		expect(correction).toContain("u/philosopher_king is not an existing Bickr participant");
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				count: 1,
				callIds: ["call-missing-2"],
				reason: "duplicate_tool_call",
			}),
		}));
	});

	it("keeps the full tool schema when the iteration is near its successful control limit", async () => {
		let providerTools: ProviderToolDefinition[] = [];
		const executedTools: string[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: (runId: string, type: string, payload: Record<string, unknown>) =>
				runtimeEvent(type === "provider_request" ? 1 : 2, runId, type as BotRuntimeEvent["type"], payload),
			appendLoopMessage: (
				_runId: string,
				message: Record<string, unknown>,
				origin: string,
			) => ({
				seq: 1,
				runId: "run-logoff-only",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async (_settings: unknown, _messages: unknown, tools: ProviderToolDefinition[]) => {
				providerTools = tools;
				return providerResponseWithToolCall("call-log-off", "log_off", { reason: "I have used enough controls for now." });
			},
			ensureProviderPromptWithinBudget: async (
				_bot: BotDocument,
				_settings: unknown,
				_runId: string,
				_signal: AbortSignal,
				tools: ProviderToolDefinition[],
			) => ({
				allowedPromptTokens: 13_500,
				providerTools: tools,
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
			providerLoopInitialSuccessfulToolCallCount: () => 7,
			successfulMutatingToolCallSinceLastLogOff: () => true,
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const bot = {
			...fakeBotDocument(),
			toolSettings: { openRouter: { webSearch: { enabled: true } } },
			tickSettings: {
				...fakeBotDocument().tickSettings,
				allowEarlyLogOff: true,
				maxToolCallsPerTick: 1,
				maxSuccessfulToolCallsPerIteration: 8,
			},
		};
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
				"run-logoff-only",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		const providerToolNames = providerTools.map((tool) => "function" in tool ? tool.function.name : tool.type);
		expect(providerToolNames).toContain("log_off");
		expect(providerToolNames).toContain("read_thread");
		expect(providerToolNames).toContain("openrouter:web_search");
		expect(executedTools).toEqual(["log_off"]);
	});

	it("injects synthetic logoff after a tool call reaches the iteration limit", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
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
					runId: "run-limit-reject",
					role: message.role,
					message,
					origin,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
				};
			},
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				return { name, result: { ok: true }, providerResult: { ok: true } };
			},
			recordInferenceSubmission: () => {},
			recordLoopMessageLog: () => {},
			recordProviderUsage: () => {},
			providerLoopInitialSuccessfulToolCallCount: () => 7,
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
					tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 1, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-limit-reject",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

			expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
				origin: "tool_result",
				message: expect.objectContaining({
					tool_call_id: "call-read",
					content: JSON.stringify({ ok: true }),
				}),
			}));
		expect(events).toContainEqual(expect.objectContaining({
			type: "assistant_message",
			payload: expect.objectContaining({
				content: "I need to take a short break from Bickr. I'll log off for now.",
			}),
		}));
		expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
			origin: "tool_result",
			message: expect.objectContaining({
				tool_call_id: expect.stringContaining("synthetic_run-limit-reject"),
			}),
		}));
	});

	it("defers iteration limits during a spotlight streak until the first unrelated mutation ends the tick", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const appendedLoopMessages: Array<{ message: Record<string, unknown>; origin: string }> = [];
		const executedTools: string[] = [];
		const callProvider = vi.fn()
			.mockResolvedValueOnce({
				...providerResponseWithToolCall("call-view", "view_profiles", { usernames: ["u/spot-author"] }),
				usage: providerUsageForTest(20),
			})
			.mockResolvedValueOnce({
				...providerResponseWithToolCall("call-reply", "reply_to_comment", { commentId: "cmt_spot", body: "Spotlight reply." }),
				usage: providerUsageForTest(20),
			})
			.mockResolvedValueOnce({
				...providerResponseWithToolCall("call-create", "create_thread", { forumHandle: "general", title: "Unrelated", body: "Body." }),
				usage: providerUsageForTest(20),
			});
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
					runId: "run-spotlight-streak-limit",
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
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return {
					name,
					result: { ok: true },
					providerResult: { ok: true },
					...(name === "reply_to_comment" ? { spotlightMutation: true } : {}),
					...(name === "create_thread" ? { spotlightTickTerminator: true } : {}),
				};
			},
			loopGeneratedTokenCountSinceLastLogOff: () => 40,
			providerLoopInitialSuccessfulToolCallCount: () => 7,
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
				runContext: Record<string, unknown>,
			) => Promise<{ logOffCalled: boolean; spotlightMutationCount: number }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: {
						...fakeBotDocument().tickSettings,
						allowEarlyLogOff: true,
						maxToolCallsPerTick: 5,
						maxSuccessfulToolCallsPerIteration: 8,
						maxGeneratedTokensPerTick: 1_000,
						maxGeneratedTokensPerIteration: 50,
					},
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-spotlight-streak-limit",
				[],
				{
					mode: "spotlight",
					setupMode: "spotlight",
					spotlightId: "spt_limit",
					spotlightActionScope: {
						commentIds: new Set(["cmt_spot"]),
						authorBotIds: new Set(["bot_spot"]),
						authorHandles: new Set(["spot-author"]),
					},
					signal: new AbortController().signal,
				},
			),
		).resolves.toMatchObject({ logOffCalled: true, spotlightMutationCount: 1 });

		expect(callProvider).toHaveBeenCalledTimes(3);
		expect(executedTools).toEqual(["view_profiles", "reply_to_comment", "create_thread", "log_off"]);
		expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
			origin: "tool_result",
			message: expect.objectContaining({
				tool_call_id: "call-reply",
			}),
		}));
		expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
			origin: "tool_result",
			message: expect.objectContaining({
				tool_call_id: expect.stringContaining("synthetic_run-spotlight-streak-limit"),
			}),
		}));
		expect(events.filter((event) => event.type === "provider_tool_call_dropped")).toEqual([]);
	});

	it("ends a spotlight tick after an unrelated mutation result and drops remaining generated calls", async () => {
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
				runId: "run-spotlight-unrelated-mutating",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{ id: "call-create", name: "create_thread", args: { forumHandle: "general", title: "Unrelated", body: "Body." } },
				{ id: "call-reply", name: "reply_to_comment", args: { commentId: "cmt_spot", body: "Spotlight reply." } },
				{ id: "call-read", name: "read_thread", args: { threadId: "thr_after" } },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return {
					name,
					result: { ok: true },
					providerResult: { ok: true },
					...(name === "create_thread" ? { spotlightTickTerminator: true } : {}),
				};
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
				runContext: Record<string, unknown>,
			) => Promise<{ logOffCalled: boolean; spotlightMutationCount: number }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 3, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-spotlight-unrelated-mutating",
				[],
				{
					mode: "spotlight",
					setupMode: "spotlight",
					spotlightId: "spt_unrelated",
					spotlightActionScope: {
						commentIds: new Set(["cmt_spot"]),
						authorBotIds: new Set(["bot_spot"]),
						authorHandles: new Set(["spot-author"]),
					},
					signal: new AbortController().signal,
				},
			),
		).resolves.toMatchObject({ logOffCalled: false, spotlightMutationCount: 0 });

		expect(executedTools).toEqual(["create_thread"]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				callIds: ["call-reply", "call-read"],
				reason: "spotlight_tick_ended",
			}),
		}));
	});

	it("counts mixed spotlight mutation batches as reactions while ending the spotlight tick", async () => {
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
				runId: "run-spotlight-mixed-batch",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{
					id: "call-vote",
					name: "vote",
					args: {
						votes: [
							{ commentId: "cmt_spot", value: 1 },
							{ commentId: "cmt_other", value: 1 },
						],
						reason: "One spotlight vote and one ordinary vote.",
					},
				},
				{ id: "call-read", name: "read_thread", args: { threadId: "thr_after" } },
			]),
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
				providerTools: toolDefinitionsForProviderRound(),
				promptTokens: 100,
				requestMessages: [{ role: "assistant", content: "I am ready." }],
			}),
			executeTool: async (_bot: unknown, _runId: string, name: string) => {
				executedTools.push(name);
				return {
					name,
					result: { ok: true },
					providerResult: { ok: true },
					spotlightMutation: true,
					spotlightTickTerminator: true,
				};
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
				runContext: Record<string, unknown>,
			) => Promise<{ logOffCalled: boolean; spotlightMutationCount: number }>;
		}).runProviderLoop.bind(runtime);

		await expect(
			runProviderLoop(
				{
					...fakeBotDocument(),
					tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 3, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-spotlight-mixed-batch",
				[],
				{
					mode: "spotlight",
					setupMode: "spotlight",
					spotlightId: "spt_mixed",
					spotlightActionScope: {
						commentIds: new Set(["cmt_spot"]),
						authorBotIds: new Set(["bot_spot"]),
						authorHandles: new Set(["spot-author"]),
					},
					signal: new AbortController().signal,
				},
			),
		).resolves.toMatchObject({ logOffCalled: false, spotlightMutationCount: 1 });

		expect(executedTools).toEqual(["vote"]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				callIds: ["call-read"],
				reason: "spotlight_tick_ended",
			}),
		}));
	});

	it("drops remaining parallel calls after one fills the iteration limit", async () => {
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
				runId: "run-parallel-limit",
				role: message.role,
				message,
				origin,
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			appendProviderMessages: async () => {},
			callProvider: async () => providerResponseWithToolCalls([
				{ id: "call-read", name: "read_thread", args: { threadId: "thr_test" } },
				{ id: "call-vote", name: "vote", args: { votes: [{ commentId: "cmt_test", value: 1 }], reason: "Clear useful context." } },
				{ id: "call-log-off", name: "log_off", args: { reason: "I hit my visit limit." } },
			]),
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
			providerLoopInitialSuccessfulToolCallCount: () => 6,
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
					tickSettings: { ...fakeBotDocument().tickSettings, allowEarlyLogOff: true, maxToolCallsPerTick: 1, maxSuccessfulToolCallsPerIteration: 8 },
				},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				"run-parallel-limit",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: true });

		expect(executedTools).toEqual(["read_thread", "vote", "log_off"]);
		expect(events).toContainEqual(expect.objectContaining({
			type: "provider_tool_call_dropped",
			payload: expect.objectContaining({
				reason: "iteration_limit",
				callIds: expect.arrayContaining(["call-log-off"]),
			}),
		}));
	});
});
