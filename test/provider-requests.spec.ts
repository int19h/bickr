import {
	authCookie,
	botById,
	BotRuntime,
	capableOpenRouterModel,
	compactionReasoningNonePolicyForModel,
	contextFor,
	createBotForTest,
	createBotInWorld,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	createWorldForTest,
	customProviderBaseUrl,
	defaultCommentBodyCharacters,
	defaultReasoningPrefill,
	defaultThreadBodyCharacters,
	describe,
	effectiveCompactionModeForModel,
	effectiveProviderSettingsForBot,
	effectiveProviderSettingsForTranslation,
	effectiveReasoningEffortForModel,
	effectiveReasoningPrefill,
	effectiveStructuredToolCallsForModel,
	effectiveSupportsPrefillForModel,
	effectiveToolCallsForModel,
	expect,
	fakeBotDocument,
	followBot,
	formatCommentRef,
	formatThreadRef,
	hasLoneSurrogate,
	isOpenRouterProviderBaseUrl,
	it,
	jsonRequest,
	localizedText,
	localizedTextString,
	loopMessageContributesToProviderHistory,
	lt,
	memoryExistingLoopMessageSchemaSql,
	memoryLoopMessageInsertSql,
	metaCompactionToolName,
	modelSupportsCompactionReasoningNone,
	modelSupportsPrefill,
	modelSupportsPromptCacheControl,
	modelSupportsRequiredToolCalls,
	modelSupportsStructuredCompaction,
	modelSupportsStructuredOutputs,
	neverStream,
	openRouterFreeModel,
	openRouterModelPolicy,
	openRouterServerToolSelection,
	patchProfile,
	providerChatCompletionRequest,
	providerCompactionRequest,
	providerCompactionSummaryProperty,
	providerCompactionSystemInstruction,
	providerContextCompletionReserveTokens,
	providerMessagesWithReasoningPrefill,
	providerResponseMessageForHistory,
	providerResponseWithContent,
	providerResponseWithToolCall,
	providerTokenProbeRequest,
	providerToolResultPayload,
	pruneStreamEventsForPersistentEvents,
	readThread,
	repairInvalidUnicodeText,
	requiredLt,
	runtimeErrorLoopMessageContent,
	runtimeEvent,
	sanitizeProviderToolCalls,
	seedWorld,
	sseStream,
	standardPrompt,
	streamedProviderRateLimit,
	testEnv,
	testLanguage,
	testRuntimeForToolExecution,
	toolDefinitions,
	toolDefinitionsForProviderRound,
	translateText,
	truncateForContext,
	vi,
} from "./helpers/index-harness";
import type {
	BotDocument,
	BotInferenceSubmissionMessage,
	BotLoopMessage,
	BotRuntimeEvent,
	LanguageTag,
	ProviderToolDefinition,
} from "./helpers/index-harness";

// TODO(#12): move next to module on extraction.
describe("Provider requests", () => {

	it("declares provider tool schemas with typed required properties", () => {
		for (const definition of toolDefinitions) {
			expect(definition.function.description).not.toMatch(/\b(owner|human)\b/i);
			const { parameters } = definition.function;
			for (const requiredProperty of parameters.required) {
				expect(parameters.properties[requiredProperty]).toBeDefined();
			}
			for (const property of Object.values(parameters.properties)) {
				expect(property.type).toBeTruthy();
			}
		}
		const expectBotAuthoredTextSchema = (
			schema: Record<string, unknown> | undefined,
			description: string,
			maxLength?: number,
		) => {
			expect(schema).toMatchObject({
				type: "object",
				additionalProperties: false,
				required: ["lang", "text"],
				properties: {
					lang: {
						type: "string",
						description: expect.stringContaining("BCP 47"),
					},
					text: {
						type: "string",
						description,
						minLength: 1,
						...(maxLength ? { maxLength } : {}),
					},
				},
			});
			expect(schema?.description).toEqual(expect.stringContaining("lang first and text second"));
			expect(schema?.description).toEqual(expect.stringContaining("do not use und"));
		};

		const vote = toolDefinitions.find((definition) => definition.function.name === "vote");
		expect(vote?.function.parameters.required).toEqual(["votes", "reason"]);
		expectBotAuthoredTextSchema(
			vote?.function.parameters.properties.reason,
			"Why I am voting this way. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.",
		);
		expect(vote?.function.parameters.properties.votes).toMatchObject({
			type: "array",
			items: {
				type: "object",
				required: ["commentRef", "value"],
			},
		});
		const voteItem = vote?.function.parameters.properties.votes?.type === "array" ?
			vote.function.parameters.properties.votes.items
		:	undefined;
		expect(voteItem?.type).toBe("object");
		if (voteItem?.type === "object") {
			expect(voteItem.properties.commentRef).toEqual({
				type: "string",
			});
			expect(voteItem.properties.value).toEqual({
				type: "integer",
				minimum: -1,
				maximum: 1,
			});
		}

		const follow = toolDefinitions.find((definition) => definition.function.name === "follow_profile");
		expect(follow?.function.parameters.required).toEqual(["targets"]);
		expect(follow?.function.parameters.properties.targets).toMatchObject({
			type: "array",
			description: "One or more participants to start following, each with its own specific reason.",
			items: {
				type: "object",
				required: ["username", "reason"],
			},
		});
		const followTargets = follow?.function.parameters.properties.targets;
		const followTargetItem = followTargets?.type === "array" ? followTargets.items : undefined;
		expect(followTargetItem?.type).toBe("object");
		if (followTargetItem?.type === "object") {
			expect(followTargetItem.properties.username).toEqual({
				type: "string",
				description: "The u/username to start following.",
			});
			expectBotAuthoredTextSchema(
				followTargetItem.properties.reason,
				"Why I want to follow this participant. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.",
			);
		}
		const unfollow = toolDefinitions.find((definition) => definition.function.name === "unfollow_profile");
		expect(unfollow?.function.parameters.required).toEqual(["targets"]);
		expect(unfollow?.function.parameters.properties.targets).toMatchObject({
			type: "array",
			description: "One or more participants to unfollow, each with its own specific reason.",
			items: {
				type: "object",
				required: ["username", "reason"],
			},
		});
		const listProfiles = toolDefinitions.find((definition) => definition.function.name === "list_profiles");
		expect(listProfiles?.function.parameters.required).toEqual(["mode"]);
		expect(listProfiles?.function.description).toContain("offset/limit");
		expect(listProfiles?.function.description).toContain("random");
		expect(listProfiles?.function.description).toContain("may return overlapping profiles");
		expect(listProfiles?.function.parameters.properties).toMatchObject({
			mode: {
				type: "string",
				enum: ["window", "random"],
			},
			limit: {
				type: "integer",
				minimum: 1,
				maximum: 50,
			},
			offset: {
				type: "integer",
				minimum: 0,
			},
		});
		const viewProfiles = toolDefinitions.find((definition) => definition.function.name === "view_profiles");
		expect(viewProfiles?.function.parameters.required).toEqual(["usernames"]);
		expect(viewProfiles?.function.parameters.properties.usernames).toEqual({
			type: "array",
			description: "One or more u/usernames to view.",
			items: { type: "string" },
		});
		expect(viewProfiles?.function.description).toContain("query_followers");
		const queryFollowers = toolDefinitions.find((definition) => definition.function.name === "query_followers");
		expect(queryFollowers?.function.parameters.required).toEqual([]);
		expect(queryFollowers?.function.description).toContain("exactly one of isFollowing or isFollowedBy");
		expect(queryFollowers?.function.parameters.properties).toMatchObject({
			isFollowing: {
				type: "string",
				description: "The u/username whose followers I want to list.",
			},
			isFollowedBy: {
				type: "string",
				description: "The u/username whose followed profiles I want to list.",
			},
			usernameGlob: {
				type: "string",
			},
		});
		const viewActivity = toolDefinitions.find((definition) => definition.function.name === "view_activity");
		expect(viewActivity?.function.parameters.properties.limit).toMatchObject({
			type: "number",
			minimum: 1,
			maximum: 20,
		});

		const recentThreads = toolDefinitions.find((definition) => definition.function.name === "list_recent_threads");
		expect(recentThreads?.function.parameters.properties.limit?.type).toBe("number");
		expect(recentThreads?.function.parameters.required).not.toContain("limit");

		for (const name of ["read_thread", "read_thread_by_id", "read_comment_by_id"]) {
			const readTool = toolDefinitions.find((definition) => definition.function.name === name);
			expect(readTool?.function.description).toContain("when replies is a number");
			expect(readTool?.function.description).toContain("read_comment_by_id with that comment ref");
			expect(readTool?.function.description).toContain("end with …");
			expect(readTool?.function.description).toContain("full comment");
		}

		const reply = toolDefinitions.find((definition) => definition.function.name === "reply_to_comment");
		const additionalReply = toolDefinitions.find((definition) => definition.function.name === "make_additional_reply_to_the_same_comment");
		expect(reply?.function.parameters.properties.commentRef).toEqual({ type: "string" });
		expectBotAuthoredTextSchema(
			reply?.function.parameters.properties.body,
			"Reply body",
			defaultCommentBodyCharacters,
		);
		expect(additionalReply?.function.parameters.properties).toEqual(reply?.function.parameters.properties);
		expect(additionalReply?.function.parameters.required).toEqual(["commentRef", "body"]);
		const createThread = toolDefinitions.find((definition) => definition.function.name === "create_thread");
		expectBotAuthoredTextSchema(createThread?.function.parameters.properties.title, "Thread title");
		expectBotAuthoredTextSchema(
			createThread?.function.parameters.properties.body,
			"Root comment body",
			defaultThreadBodyCharacters,
		);
		const customPostingTools = toolDefinitionsForProviderRound(1234, {
			includeMetaCompactionTool: false,
			postingLimits: { threadBodyCharacters: 123, commentBodyCharacters: 45 },
		});
		expectBotAuthoredTextSchema(
			customPostingTools.find((definition) => definition.function.name === "create_thread")?.function.parameters.properties.body,
			"Root comment body",
			123,
		);
		expectBotAuthoredTextSchema(
			customPostingTools.find((definition) => definition.function.name === "reply_to_comment")?.function.parameters.properties.body,
			"Reply body",
			45,
		);
		const roundTools = toolDefinitionsForProviderRound(1234);
		expect(roundTools.slice(0, -1)).toEqual(toolDefinitions);
		const metaTool = roundTools.at(-1);
		expect(metaCompactionToolName).toBe("provide_summary");
		expect(metaTool?.function.name).toBe(metaCompactionToolName);
		expect(metaTool?.function.description).toContain("Use only when directed.");
		expect(metaTool?.function.parameters.properties[providerCompactionSummaryProperty]).toMatchObject({
			type: "string",
			minLength: 1,
			maxLength: 1234,
		});
		expect(metaTool?.function.parameters.additionalProperties).toBe(false);
		expect(toolDefinitionsForProviderRound(1234, { includeMetaCompactionTool: false })).toEqual(toolDefinitions);
		expect(toolDefinitionsForProviderRound(1234, { includeLogOffTool: false }).map((definition) => definition.function.name)).not.toContain("log_off");
		expect(toolDefinitionsForProviderRound(1234, { compactionMinCharacters: 321 }).at(-1)?.function.parameters.properties[providerCompactionSummaryProperty]).toMatchObject({
			minLength: 1,
			maxLength: 1234,
		});

		const logOff = toolDefinitions.find((definition) => definition.function.name === "log_off");
		expect(logOff?.function.parameters.required).toEqual(["reason"]);
		expectBotAuthoredTextSchema(
			logOff?.function.parameters.properties.reason,
			"Why I am finished with this Bickr visit. Must not be empty. Must be specific to this particular interaction and not repeat other reasons.",
		);
	});

	it("executes bulk vote and profile follow tool calls", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "bulk-tools");
		const author = await createBotForTest(cookie, "bulk-author");
		const voter = await createBotForTest(cookie, "bulk-voter");
		const firstProfile = await createBotForTest(cookie, "bulk-target-one");
		const secondProfile = await createBotForTest(cookie, "bulk-target-two");
		await createWorldForTest(cookie, "bulk-elsewhere", "Bulk Elsewhere");
		await createBotInWorld(cookie, "bulk-elsewhere", { handle: "bulk-target-away" });
		const thread = await createThreadForTest(forum.id, author.id, "Bulk vote target", "Root body.");
		const comment = await createCommentForTest(thread.id, author.id, "Comment body.");
		const childComment = await createCommentForTest(thread.id, author.id, "Child comment body.", comment.id);

		const runtime = testRuntimeForToolExecution() as BotRuntime & { events: BotRuntimeEvent[] };
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ result: unknown; providerResult: unknown; displayEventSeq?: number }>;
		}).executeTool.bind(runtime);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, voter.id);
		const signal = new AbortController().signal;

		const cachedBudgetRuntime = Object.assign(testRuntimeForToolExecution(), {
			contextBudgetCachedCounts: () => ({ fixedSystemTokens: 2_000, personaPromptTokens: 1_500 }),
		});
		const readCommentTreeTokenBudget = (BotRuntime.prototype as unknown as {
			readCommentTreeTokenBudget: (bot: BotDocument) => Promise<number>;
		}).readCommentTreeTokenBudget.bind(cachedBudgetRuntime);
		const expectedReadCommentTreeTokenBudget = Math.max(
			1,
			Math.floor(Math.max(0, 10_000 - 2_000 - 1_500 - providerContextCompletionReserveTokens) / 4),
		);
		await expect(
			readCommentTreeTokenBudget({
				...bot,
				tickSettings: { ...bot.tickSettings, contextWindowTokens: 10_000 },
			}),
		).resolves.toBe(expectedReadCommentTreeTokenBudget);

		const missingReason = await executeTool(
			bot,
			"run-vote-missing-reason",
			"vote",
			{
				votes: [{ commentId: thread.rootCommentId, value: 1 }],
			},
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(missingReason).toBeInstanceOf(Error);
		expect((missingReason as Error).message).toContain("reason must be an object with lang first and text second");

		const voteResult = await executeTool(
			bot,
			"run-bulk-votes",
			"vote",
			{
				reason: requiredLt("The thread is useful and the comment is off-topic."),
				votes: [
					{ commentId: thread.rootCommentId, value: 1 },
					{ commentId: comment.id, value: -1 },
				],
			},
			{ mode: "normal", signal },
		);
		expect(Array.isArray(voteResult.result)).toBe(true);
		expect(Array.isArray(voteResult.providerResult)).toBe(true);
		expect(voteResult.providerResult).toHaveLength(2);
		expect(voteResult.providerResult).toMatchObject([
			{
				value: 1,
				target: { commentRef: formatCommentRef(thread.rootCommentId), threadRef: formatThreadRef(thread.id) },
			},
			{
				value: -1,
				target: { commentRef: formatCommentRef(comment.id), threadRef: formatThreadRef(thread.id) },
			},
		]);
		expect(JSON.stringify(voteResult.providerResult)).not.toContain("Comment body.");
		expect(JSON.stringify(voteResult.providerResult)).not.toContain("Child comment body.");
		const updatedThread = await readThread(testEnv.BICKR_KV, thread.id);
		expect(updatedThread.comments.find((item) => item.id === thread.rootCommentId)?.voteScore).toBe(1);
		expect(updatedThread.comments.find((item) => item.id === comment.id)?.voteScore).toBe(-1);

		const createThreadResult = await executeTool(
			bot,
			"run-create-thread-compact-result",
			"create_thread",
			{ forumHandle: forum.handle, title: requiredLt("Compact provider result"), body: requiredLt("This thread body should not be echoed back.") },
			{ mode: "normal", signal },
			);
			expect(createThreadResult.providerResult).toMatchObject({
				ok: true,
				thread: { title: "Compact provider result" },
			});
			expect(JSON.stringify(createThreadResult.providerResult)).not.toContain("This thread body should not be echoed back.");

			await createThreadForTest(forum.id, author.id, "Needle provider result one", "Needle body one.");
			await createThreadForTest(forum.id, author.id, "Needle provider result two", "Needle body two.");
			const tinyProviderBudgetRuntime = Object.assign(testRuntimeForToolExecution(), {
				readCommentTreeTokenBudget: async () => 50,
			}) as BotRuntime & { events: BotRuntimeEvent[] };
			const executeToolWithTinyProviderBudget = (BotRuntime.prototype as unknown as {
				executeTool: (
					bot: Awaited<ReturnType<typeof botById>>,
					runId: string,
					name: string,
					args: Record<string, unknown>,
					runContext: { mode: "normal"; signal: AbortSignal },
				) => Promise<{ result: unknown; providerResult: unknown; displayEventSeq?: number }>;
			}).executeTool.bind(tinyProviderBudgetRuntime);
			const searchToolResult = await executeToolWithTinyProviderBudget(
				bot,
				"run-search-pruned-provider-result",
				"search_threads",
				{ query: "Needle provider" },
				{ mode: "normal", signal },
			);
			expect(Array.isArray(searchToolResult.result)).toBe(true);
			expect(Array.isArray(searchToolResult.providerResult)).toBe(true);
			expect((searchToolResult.providerResult as unknown[]).length).toBeLessThan((searchToolResult.result as unknown[]).length);
			expect(tinyProviderBudgetRuntime.events.find((event) => event.seq === searchToolResult.displayEventSeq)?.payload).toMatchObject({
				name: "search_threads",
				result: searchToolResult.result,
			});

			const readThreadResult = await executeTool(
				bot,
				"run-read-thread-tree",
				"read_thread_by_id",
				{ threadId: thread.id },
				{ mode: "normal", signal },
		);
		expect(readThreadResult.displayEventSeq).toEqual(expect.any(Number));
		expect(runtime.events.find((event) => event.seq === readThreadResult.displayEventSeq)?.payload).toMatchObject({
			displayContext: { worldHandle: bot.homeWorldHandle },
			name: "read_thread_by_id",
			result: readThreadResult.result,
		});
		const readThreadContent = (readThreadResult.providerResult as { content: Array<Record<string, unknown>> }).content;
		expect(readThreadContent.map((item) => item.commentRef)).toEqual([formatCommentRef(thread.rootCommentId)]);
		expect(readThreadContent).toMatchObject([
			{
				commentRef: formatCommentRef(thread.rootCommentId),
				body: "Root body.",
				replies: [{
					commentRef: formatCommentRef(comment.id),
					body: "Comment body.",
					replies: [{ commentRef: formatCommentRef(childComment.id), body: "Child comment body." }],
				}],
			},
		]);

		const readCommentResult = await executeTool(
			bot,
			"run-read-comment-tree",
			"read_comment_by_id",
			{ commentId: childComment.id },
			{ mode: "normal", signal },
		);
		expect((readCommentResult.providerResult as { content: Array<Record<string, unknown>> }).content).toMatchObject([
			{
				commentRef: formatCommentRef(thread.rootCommentId),
				ancestorOnly: true,
				replies: [{
					commentRef: formatCommentRef(comment.id),
					ancestorOnly: true,
					replies: [{ commentRef: formatCommentRef(childComment.id), "My focus is on this comment": true }],
				}],
			},
		]);

		const readBranchResult = await executeTool(
			bot,
			"run-read-comment-branch",
			"read_comment_by_id",
			{ commentId: comment.id },
			{ mode: "normal", signal },
		);
		expect((readBranchResult.providerResult as { content: Array<Record<string, unknown>> }).content).toMatchObject([
			{
				commentRef: formatCommentRef(thread.rootCommentId),
				ancestorOnly: true,
				replies: [{
					commentRef: formatCommentRef(comment.id),
					"My focus is on this comment": true,
					replies: [{ commentRef: formatCommentRef(childComment.id), body: "Child comment body." }],
				}],
			},
		]);

		const pruningRuntime = Object.assign(testRuntimeForToolExecution(), {
			readCommentTreeTokenBudget: async () => 1,
		});
		const executeToolWithTinyReadBudget = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ result: unknown; providerResult: unknown }>;
		}).executeTool.bind(pruningRuntime);

		const largeThread = await createThreadForTest(forum.id, author.id, "Large branch", "Root body stays visible.");
		const immediateReplyBody = `Immediate reply should be shortened. ${"x".repeat(2_000)}`;
		const immediateReply = await createCommentForTest(largeThread.id, author.id, immediateReplyBody);
		await createCommentForTest(largeThread.id, author.id, `Grandchild should be collapsed. ${"x".repeat(2_000)}`, immediateReply.id);
		const prunedReadResult = await executeToolWithTinyReadBudget(
			bot,
			"run-read-pruned-thread",
			"read_thread_by_id",
			{ threadId: largeThread.id },
			{ mode: "normal", signal },
		);
		const prunedProviderResult = prunedReadResult.providerResult as { context: string; content: Array<Record<string, unknown>> };
		expect(prunedProviderResult.context).toContain("numeric replies value");
		expect(prunedProviderResult.context).toContain("body ending in …");
		expect(prunedProviderResult.content).toMatchObject([
			{
				commentRef: formatCommentRef(largeThread.rootCommentId),
				body: "Root body stays visible.",
				replies: [{
					commentRef: formatCommentRef(immediateReply.id),
					body: "…",
					replies: 1,
				}],
			},
		]);
		expect(JSON.stringify(prunedProviderResult)).not.toContain(immediateReplyBody);
		expect(JSON.stringify(prunedProviderResult)).not.toContain("Grandchild should be collapsed.");

		const focusedThread = await createThreadForTest(forum.id, author.id, "Focused branch", "Focused root stays visible.");
		const targetReply = await createCommentForTest(focusedThread.id, author.id, "Focused target body stays visible.");
		const descendantBody = `Focused descendant should be shortened. ${"y".repeat(2_000)}`;
		const descendantReply = await createCommentForTest(focusedThread.id, author.id, descendantBody, targetReply.id);
		const prunedBranchResult = await executeToolWithTinyReadBudget(
			bot,
			"run-read-pruned-comment-branch",
			"read_comment_by_id",
			{ commentId: targetReply.id },
			{ mode: "normal", signal },
		);
		const prunedBranchContent = (prunedBranchResult.providerResult as { context: string; content: Array<Record<string, unknown>> }).content;
		expect(prunedBranchContent).toMatchObject([
			{
				commentRef: formatCommentRef(focusedThread.rootCommentId),
				body: "Focused root stays visible.",
				replies: [{
					commentRef: formatCommentRef(targetReply.id),
					body: "Focused target body stays visible.",
					"My focus is on this comment": true,
					replies: [{
						commentRef: formatCommentRef(descendantReply.id),
						body: "…",
					}],
				}],
			},
		]);
		expect(JSON.stringify(prunedBranchContent)).not.toContain(descendantBody);

		const profilesResult = await executeTool(
			bot,
			"run-view-profiles",
			"view_profiles",
			{ usernames: [firstProfile.handle, `u/${secondProfile.handle}`] },
			{ mode: "normal", signal },
		);
		expect(profilesResult.providerResult).toMatchObject({
			profiles: [
				{ username: `u/${firstProfile.handle}`, displayName: localizedTextString(firstProfile.displayName), shortBio: expect.any(String), isFollowedByMe: false, isFollowingMe: false, followers: 0 },
				{ username: `u/${secondProfile.handle}`, displayName: localizedTextString(secondProfile.displayName), shortBio: expect.any(String), isFollowedByMe: false, isFollowingMe: false, followers: 0 },
			],
		});
		for (const profile of (profilesResult.providerResult as { profiles: Array<Record<string, unknown>> }).profiles) {
			expect(profile).not.toHaveProperty("id");
			expect(profile).not.toHaveProperty("world");
			expect(profile).not.toHaveProperty("createdAt");
			expect(profile).not.toHaveProperty("updatedAt");
			expect(profile).not.toHaveProperty("following");
		}
		const legacyProfileResult = await executeTool(
			bot,
			"run-view-profile-legacy",
			"view_profile",
			{ username: firstProfile.handle },
			{ mode: "normal", signal },
		);
		expect(legacyProfileResult.providerResult).toMatchObject({
			profiles: [{ username: `u/${firstProfile.handle}` }],
		});
		const listWindowResult = await executeTool(
			bot,
			"run-list-profiles-window",
			"list_profiles",
			{ mode: "window", limit: 2, offset: 1 },
			{ mode: "normal", signal },
		);
		expect(listWindowResult.providerResult).toMatchObject({
			mode: "window",
			offset: 1,
			limit: 2,
			total: 3,
			hasMore: false,
			profiles: [
				{ username: `u/${firstProfile.handle}`, displayName: localizedTextString(firstProfile.displayName), shortBio: expect.any(String), isFollowedByMe: false, isFollowingMe: false, followers: 0 },
				{ username: `u/${secondProfile.handle}`, displayName: localizedTextString(secondProfile.displayName), shortBio: expect.any(String), isFollowedByMe: false, isFollowingMe: false, followers: 0 },
			],
		});
		const seenProfiles = await testEnv.BICKR_D1
			.prepare(
				`SELECT object_id AS id, seen_via AS seenVia
				 FROM bot_seen_content
				 WHERE bot_id = ?
				   AND object_type = 'bot'
				   AND object_id IN (?, ?)`,
			)
			.bind(bot.id, firstProfile.id, secondProfile.id)
			.all<{ id: string; seenVia: string }>();
		expect(seenProfiles.results ?? []).toEqual(expect.arrayContaining([
			{ id: firstProfile.id, seenVia: "tool:list_profiles" },
			{ id: secondProfile.id, seenVia: "tool:list_profiles" },
		]));
		expect(seenProfiles.results ?? []).toHaveLength(2);
		const randomListResult = await executeTool(
			bot,
			"run-list-profiles-random",
			"list_profiles",
			{ mode: "random", limit: 2 },
			{ mode: "normal", signal },
		);
		const randomProviderResult = randomListResult.providerResult as { mode: string; limit: number; total: number; profiles: Array<{ username: string }> };
		expect(randomProviderResult).toMatchObject({
			mode: "random",
			limit: 2,
			total: 3,
		});
		expect(randomProviderResult.profiles.length).toBeLessThanOrEqual(2);
		expect(new Set(randomProviderResult.profiles.map((profile) => profile.username)).size).toBe(randomProviderResult.profiles.length);
		expect(randomProviderResult.profiles.map((profile) => profile.username)).not.toContain(`u/${bot.handle}`);
		expect(randomProviderResult.profiles.map((profile) => profile.username)).not.toContain("u/bulk-target-away");
		const randomOffset = await executeTool(
			bot,
			"run-list-profiles-random-offset",
			"list_profiles",
			{ mode: "random", limit: 2, offset: 1 },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(randomOffset).toBeInstanceOf(Error);
		expect((randomOffset as Error).message).toContain("offset is only valid");
		await expect(
			executeTool(bot, "run-check-notifications", "check_notifications", {}, { mode: "normal", signal }),
		).resolves.toMatchObject({ providerResult: { events: [] } });

		const followResult = await executeTool(
			bot,
			"run-bulk-follow",
			"follow_profile",
			{
				targets: [
					{ username: firstProfile.handle, reason: requiredLt("Their threads are relevant to my interests.") },
					{ username: `u/${firstProfile.handle}`, reason: requiredLt("This duplicate should be ignored before following.") },
					{ username: `u/${secondProfile.handle}`, reason: requiredLt("Their comments add useful context to recent threads.") },
				],
			},
			{ mode: "normal", signal },
		);
		expect(followResult.providerResult).toHaveLength(2);
		expect(followResult.providerResult).toMatchObject([
			{ following: true, profile: `u/${firstProfile.handle}` },
			{ following: true, profile: `u/${secondProfile.handle}` },
		]);

		const redundantFollow = await executeTool(
			bot,
			"run-bulk-follow-again",
			"follow_profile",
			{ targets: [{ username: firstProfile.handle, reason: requiredLt("I want to follow them again.") }] },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(redundantFollow).toBeInstanceOf(Error);
		expect((redundantFollow as Error).message).toContain(`I already follow u/${firstProfile.handle}`);
		expect((redundantFollow as Error).message).toContain("follow_profile");

		const unfollowResult = await executeTool(
			bot,
			"run-bulk-unfollow",
			"unfollow_profile",
			{
				targets: [
					{ username: firstProfile.handle, reason: requiredLt("I no longer want their activity in my feed.") },
					{ username: secondProfile.handle, reason: requiredLt("Their recent posts no longer match my interests.") },
				],
			},
			{ mode: "normal", signal },
		);
		expect(unfollowResult.providerResult).toMatchObject([
			{ following: false, profile: `u/${firstProfile.handle}` },
			{ following: false, profile: `u/${secondProfile.handle}` },
		]);

		const redundantUnfollow = await executeTool(
			bot,
			"run-bulk-unfollow-again",
			"unfollow_profile",
			{ targets: [{ username: firstProfile.handle, reason: requiredLt("I want to unfollow them again.") }] },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(redundantUnfollow).toBeInstanceOf(Error);
		expect((redundantUnfollow as Error).message).toContain(`I do not follow u/${firstProfile.handle}`);
		expect((redundantUnfollow as Error).message).toContain("unfollow_profile");
	});

	it("classifies spotlight vote and follow mutations per effective target", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-tool-scope");
		const actor = await createBotForTest(cookie, "scope-actor");
		const spotlightAuthor = await createBotForTest(cookie, "scope-spot-author");
		const unrelatedAuthor = await createBotForTest(cookie, "scope-other-author");
		const spotlightProfile = await createBotForTest(cookie, "scope-spot-profile");
		const unrelatedProfile = await createBotForTest(cookie, "scope-other-profile");
		const spotlightThread = await createThreadForTest(forum.id, spotlightAuthor.id, "Spotlight vote thread", "Spotlight root.");
		const unrelatedThread = await createThreadForTest(forum.id, unrelatedAuthor.id, "Ordinary vote thread", "Ordinary root.");
		const actorDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const spotlightId = "spt_tool_scope";
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO spotlight_deliveries (
				spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
				target_ids_json, focus_text, injected_text, status, error_message, created_at
			) VALUES (?, ?, ?, ?, ?, ?, 'threads', ?, NULL, 'spotlight', 'sent', NULL, ?)`,
		)
			.bind(
				spotlightId,
				user.id,
				actor.id,
				forum.worldId,
				forum.id,
				spotlightThread.id,
				JSON.stringify([spotlightThread.id]),
				new Date().toISOString(),
			)
			.run();

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: Record<string, unknown>,
			) => Promise<{
				result: unknown;
				providerResult: unknown;
				spotlightMutation?: boolean;
				spotlightTickTerminator?: boolean;
			}>;
		}).executeTool.bind(runtime);
		const signal = new AbortController().signal;
		const spotlightRunContext = {
			mode: "spotlight",
			setupMode: "spotlight",
			spotlightId,
			spotlightActionScope: {
				commentIds: new Set([spotlightThread.rootCommentId]),
				authorBotIds: new Set([spotlightAuthor.id, spotlightProfile.id]),
				authorHandles: new Set([spotlightAuthor.handle, spotlightProfile.handle]),
			},
			signal,
		};

		const voteResult = await executeTool(
			actorDocument,
			"run-spotlight-mixed-vote",
			"vote",
			{
				reason: requiredLt("The spotlight target is useful; this ordinary target is also useful."),
				votes: [
					{ commentId: spotlightThread.rootCommentId, value: 1 },
					{ commentId: unrelatedThread.rootCommentId, value: 1 },
				],
			},
			spotlightRunContext,
		);
		expect(voteResult).toMatchObject({
			spotlightMutation: true,
			spotlightTickTerminator: true,
		});
		const voteNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT target_id AS targetId, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'vote_cast'
			   AND target_id IN (?, ?)`,
		)
			.bind(user.id, spotlightThread.rootCommentId, unrelatedThread.rootCommentId)
			.all<{ targetId: string; spotlightId: string | null }>();
		const voteSpotlightIds = new Map(voteNotifications.results?.map((row) => [row.targetId, row.spotlightId]));
		expect(voteSpotlightIds.get(spotlightThread.rootCommentId)).toBe(spotlightId);
		expect(voteSpotlightIds.get(unrelatedThread.rootCommentId)).toBeNull();

		const followResult = await executeTool(
			actorDocument,
			"run-spotlight-mixed-follow",
			"follow_profile",
			{
				targets: [
					{ username: spotlightProfile.handle, reason: requiredLt("The spotlight profile is relevant.") },
					{ username: unrelatedProfile.handle, reason: requiredLt("The ordinary profile is relevant too.") },
				],
			},
			spotlightRunContext,
		);
		expect(followResult).toMatchObject({
			spotlightMutation: true,
			spotlightTickTerminator: true,
		});
		const followNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT target_id AS targetId, spotlight_id AS spotlightId
			 FROM human_notifications
			 WHERE user_id = ? AND notification_type = 'bot_followed'
			   AND target_id IN (?, ?)`,
		)
			.bind(user.id, spotlightProfile.id, unrelatedProfile.id)
			.all<{ targetId: string; spotlightId: string | null }>();
		const followSpotlightIds = new Map(followNotifications.results?.map((row) => [row.targetId, row.spotlightId]));
		expect(followSpotlightIds.get(spotlightProfile.id)).toBe(spotlightId);
		expect(followSpotlightIds.get(unrelatedProfile.id)).toBeNull();
	});

	it("does not record spotlight labels for unrelated create-thread mutations during spotlight ticks", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "spotlight-unrelated-posts");
		const actor = await createBotForTest(cookie, "unrelated-post-actor");
		const spotlightAuthor = await createBotForTest(cookie, "unrelated-post-spot-author");
		const spotlightThread = await createThreadForTest(forum.id, spotlightAuthor.id, "Existing spotlight context", "Spotlight root.");
		const actorDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, actor.id);
		const user = await testEnv.BICKR_D1.prepare(`SELECT user_id AS id FROM users_index LIMIT 1`).first<{ id: string }>();
		if (!user) {
			throw new Error("Test user was not created.");
		}
		const spotlightId = "spt_unrelated_post";
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO spotlight_deliveries (
				spotlight_id, user_id, bot_id, world_id, forum_id, thread_id, target_type,
				target_ids_json, focus_text, injected_text, status, error_message, created_at
			) VALUES (?, ?, ?, ?, ?, ?, 'threads', ?, NULL, 'spotlight', 'sent', NULL, ?)`,
		)
			.bind(
				spotlightId,
				user.id,
				actor.id,
				forum.worldId,
				forum.id,
				spotlightThread.id,
				JSON.stringify([spotlightThread.id]),
				new Date().toISOString(),
			)
			.run();

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: Record<string, unknown>,
			) => Promise<{
				result: unknown;
				providerResult: unknown;
				spotlightMutation?: boolean;
				spotlightTickTerminator?: boolean;
			}>;
		}).executeTool.bind(runtime);
		const createResult = await executeTool(
			actorDocument,
			"run-spotlight-unrelated-post",
			"create_thread",
			{ forumHandle: forum.handle, title: requiredLt("Ordinary thread"), body: requiredLt("This is not in a spotlight author's personal forum.") },
			{
				mode: "spotlight",
				setupMode: "spotlight",
				spotlightId,
				spotlightActionScope: {
					commentIds: new Set([spotlightThread.rootCommentId]),
					authorBotIds: new Set([spotlightAuthor.id]),
					authorHandles: new Set([spotlightAuthor.handle]),
				},
				signal: new AbortController().signal,
			},
		);
		expect(createResult.spotlightMutation).toBeUndefined();
		expect(createResult.spotlightTickTerminator).toBe(true);

		const spotlightNotifications = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM human_notifications
			 WHERE user_id = ? AND spotlight_id = ?`,
		)
			.bind(user.id, spotlightId)
			.first<{ count: number }>();
		expect(spotlightNotifications?.count).toBe(0);
	});

	it("exposes profile follow relationships and queries follower usernames", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const viewer = await createBotForTest(cookie, "query-viewer");
		const target = await createBotForTest(cookie, "query-hub");
		const rankAlpha = await createBotForTest(cookie, "query-rank-alpha");
		const rankBeta = await createBotForTest(cookie, "query-rank-beta");
		const rankGamma = await createBotForTest(cookie, "query-rank-gamma");
		const followedPopular = await createBotForTest(cookie, "query-followed-popular");
		const followedPlain = await createBotForTest(cookie, "query-followed-plain");
		const fanOne = await createBotForTest(cookie, "query-fan-one");
		const fanTwo = await createBotForTest(cookie, "query-fan-two");
		const fanThree = await createBotForTest(cookie, "query-fan-three");

		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, viewer.id, target.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id, viewer.id);
		for (const follower of [rankAlpha, rankBeta, rankGamma]) {
			await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id, target.id);
		}
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanOne.id, rankAlpha.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanTwo.id, rankAlpha.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanThree.id, rankBeta.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id, followedPopular.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, target.id, followedPlain.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanOne.id, followedPopular.id);
		await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, fanTwo.id, followedPopular.id);

		for (let index = 0; index < 52; index += 1) {
			const follower = await createBotForTest(cookie, `query-cap-follower-${String(index).padStart(2, "0")}`);
			await followBot(testEnv.BICKR_KV, testEnv.BICKR_D1, follower.id, target.id);
		}

		const runtime = testRuntimeForToolExecution();
		const executeTool = (BotRuntime.prototype as unknown as {
			executeTool: (
				bot: Awaited<ReturnType<typeof botById>>,
				runId: string,
				name: string,
				args: Record<string, unknown>,
				runContext: { mode: "normal"; signal: AbortSignal },
			) => Promise<{ result: unknown; providerResult: unknown }>;
		}).executeTool.bind(runtime);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, viewer.id);
		const signal = new AbortController().signal;

		const profileResult = await executeTool(
			bot,
			"run-profile-relationships",
			"view_profiles",
			{ usernames: [target.handle] },
			{ mode: "normal", signal },
		);
		expect(profileResult.providerResult).toMatchObject({
			profiles: [{
				username: `u/${target.handle}`,
				isFollowedByMe: true,
				isFollowingMe: true,
				followers: 56,
			}],
		});
		expect((profileResult.providerResult as { profiles: Array<Record<string, unknown>> }).profiles[0]).not.toHaveProperty("following");

		const searchResult = await executeTool(
			bot,
			"run-profile-search-relationships",
			"search_profiles",
			{ query: target.handle },
			{ mode: "normal", signal },
		);
		const searchedProfile = (searchResult.providerResult as Array<Record<string, unknown>>).find((profile) => profile.username === `u/${target.handle}`);
		expect(searchedProfile).toMatchObject({
			isFollowedByMe: true,
			isFollowingMe: true,
			followers: 56,
		});
		expect(searchedProfile).not.toHaveProperty("following");

		const rankedFollowers = await executeTool(
			bot,
			"run-query-ranked-followers",
			"query_followers",
			{ isFollowing: target.handle, usernameGlob: "query-rank-*" },
			{ mode: "normal", signal },
		);
		expect(rankedFollowers.providerResult).toEqual({
			total: 3,
			usernames: [`u/${rankAlpha.handle}`, `u/${rankBeta.handle}`, `u/${rankGamma.handle}`],
		});

		const followedByTarget = await executeTool(
			bot,
			"run-query-followed-by-target",
			"query_followers",
			{ isFollowedBy: `u/${target.handle}`, usernameGlob: "u/query-followed-*" },
			{ mode: "normal", signal },
		);
		expect(followedByTarget.providerResult).toEqual({
			total: 2,
			usernames: [`u/${followedPopular.handle}`, `u/${followedPlain.handle}`],
		});

		const cappedFollowers = await executeTool(
			bot,
			"run-query-capped-followers",
			"query_followers",
			{ isFollowing: target.handle, usernameGlob: "query-cap-*" },
			{ mode: "normal", signal },
		);
		const cappedResult = cappedFollowers.providerResult as { total: number; usernames: string[] };
		expect(cappedResult.total).toBe(52);
		expect(cappedResult.usernames).toHaveLength(50);
		expect(cappedResult.usernames[0]).toBe("u/query-cap-follower-00");
		expect(cappedResult.usernames.at(-1)).toBe("u/query-cap-follower-49");

		const tooShortGlob = await executeTool(
			bot,
			"run-query-too-short-glob",
			"query_followers",
			{ isFollowing: target.handle, usernameGlob: "q" },
			{ mode: "normal", signal },
		);
		expect(tooShortGlob.providerResult).toEqual({ total: 0, usernames: [] });

		const missingDirection = await executeTool(
			bot,
			"run-query-missing-direction",
			"query_followers",
			{},
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(missingDirection).toBeInstanceOf(Error);
		expect((missingDirection as Error).message).toContain("exactly one of isFollowing or isFollowedBy");

		const bothDirections = await executeTool(
			bot,
			"run-query-both-directions",
			"query_followers",
			{ isFollowing: target.handle, isFollowedBy: target.handle },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(bothDirections).toBeInstanceOf(Error);
		expect((bothDirections as Error).message).toContain("exactly one of isFollowing or isFollowedBy");

		const missingProfile = await executeTool(
			bot,
			"run-query-missing-profile",
			"query_followers",
			{ isFollowing: "u/query-missing-profile" },
			{ mode: "normal", signal },
		).catch((error: unknown) => error);
		expect(missingProfile).toBeInstanceOf(Error);
		expect((missingProfile as Error).message).toContain("Bot not found");
	});

	it("tells participants not to make duplicate replies in the fixed prompt", () => {
			const promptBot = {
				handle: "prompt-tester",
				language: testLanguage,
				includeLanguageInSystemPrompt: false,
				displayName: lt("Prompt Tester"),
				shortBio: lt("Tests prompts."),
				prompt: lt("Stay terse."),
			} as Parameters<typeof standardPrompt>[0];
		const prompt = standardPrompt(promptBot);
		expect(prompt).toContain("Avoid duplicate replies");
		expect(prompt).toContain("already replied to that same comment");
		expect(prompt).toContain("finish this Bickr visit with log_off");
	});

	it("adds only non-empty world prompt text as setting context", () => {
			const promptBot = {
				handle: "prompt-tester",
				language: testLanguage,
				includeLanguageInSystemPrompt: false,
				displayName: lt("Prompt Tester"),
				shortBio: lt("Tests prompts."),
				prompt: lt("Stay terse."),
			} as Parameters<typeof standardPrompt>[0];
		const prompt = standardPrompt(promptBot, "The city is built on glass canals.");
		expect(prompt).toContain("Stay terse.\n\nSetting:\nThe city is built on glass canals.");
		expect(standardPrompt(promptBot, "  ")).not.toContain("Setting:");
	});

	it("includes the native-language prompt line only when enabled with a language", () => {
		const promptBot = {
			handle: "prompt-tester",
			language: "ja" as LanguageTag,
			includeLanguageInSystemPrompt: true,
			displayName: localizedText("Prompt Tester", "ja" as LanguageTag),
			shortBio: localizedText("Tests prompts.", "ja" as LanguageTag),
			prompt: localizedText("Stay terse.", "ja" as LanguageTag),
		} as Parameters<typeof standardPrompt>[0];
		const nativeLanguageLine =
			"Your native language is ja (BCP 47); all your thoughts and all content that you author must be in that language.";
		expect(standardPrompt(promptBot)).toContain(nativeLanguageLine);
		expect(standardPrompt({ ...promptBot, includeLanguageInSystemPrompt: false })).not.toContain(nativeLanguageLine);
		expect(standardPrompt({ ...promptBot, language: null })).not.toContain(nativeLanguageLine);

		const compactionPrompt = providerCompactionSystemInstruction(promptBot, [], "tool_call");
		expect(compactionPrompt).toContain(nativeLanguageLine);
		expect(providerCompactionSystemInstruction({ ...promptBot, includeLanguageInSystemPrompt: false }, [], "tool_call"))
			.not.toContain(nativeLanguageLine);
	});

	it("keeps later live stream deltas when reconciling earlier persistent assistant messages", () => {
		const previousTurn = runtimeEvent(11, "run-1", "assistant_message", { content: "Earlier complete turn." });
		const currentLiveDelta = runtimeEvent(20.000001, "run-1", "provider_delta", {
			kind: "content",
			text: "Current turn prefix",
			ephemeral: true,
		});
		const currentCompleted = runtimeEvent(21, "run-1", "assistant_message", { content: "Current turn prefix and suffix." });

		expect(pruneStreamEventsForPersistentEvents([currentLiveDelta], [previousTurn])).toEqual([currentLiveDelta]);
		expect(pruneStreamEventsForPersistentEvents([currentLiveDelta], [currentCompleted])).toEqual([]);
	});

	it("initializes existing loop message tables before creating indexes on new columns", async () => {
		const sql = memoryExistingLoopMessageSchemaSql();
		const pending: Promise<void>[] = [];
		const state = {
			blockConcurrencyWhile: (callback: () => Promise<void>) => {
				pending.push(callback());
			},
			storage: { sql },
		};

		new BotRuntime(state as unknown as DurableObjectState, {} as never);
		await Promise.all(pending);

		expect(sql.columns("loop_messages")).toContain("deleted_at");
		expect(sql.columns("loop_messages")).toContain("stream_seq");
		expect(sql.columns("loop_messages")).toContain("display_event_seq");
		expect(sql.statements()).toEqual(expect.arrayContaining([
			expect.stringMatching(/^ALTER TABLE loop_messages ADD COLUMN deleted_at TEXT$/),
			expect.stringMatching(/^ALTER TABLE loop_messages ADD COLUMN stream_seq INTEGER$/),
			expect.stringMatching(/^ALTER TABLE loop_messages ADD COLUMN display_event_seq INTEGER$/),
			expect.stringMatching(/^CREATE INDEX IF NOT EXISTS loop_messages_visible/),
		]));
		expect(sql.indexCreatedBeforeDeletedAt()).toBe(false);
	});

	it("records constructor-detected provider tool-call invariant violations without throwing", async () => {
		const activeRows = [{
			seq: 1,
			position: 1,
			run_id: "run-constructor-violation",
			role: "assistant",
			message_json: JSON.stringify({
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call-missing-tool", type: "function", function: { name: "read_thread", arguments: "{\"threadId\":\"thr_missing\"}" } },
				],
			}),
			origin: "provider_response",
			status: "complete",
			token_estimate: 0,
			stream_seq: null,
			compacted_by: null,
			deleted_at: null,
			created_at: "2026-07-10T00:00:00.000Z",
			has_logs: 0,
		}];
		const runtimeState = new Map<string, string>([
			["loop_messages_provider_tool_call_history_normalized_v1", "true"],
			["provider_token_calibration_samples_backfilled", "true"],
		]);
		const columnsByTable = new Map<string, string[]>([
			["injections", ["id", "text", "kind", "source_id", "spotlight_id", "created_at", "consumed_at"]],
			["provider_usage", ["id", "request_seq", "run_id", "provider_name"]],
			["inference_submissions", ["id", "event_seq", "run_id", "display_messages_json"]],
			["loop_messages", ["seq", "position", "run_id", "role", "message_json", "origin", "status", "token_estimate", "stream_seq", "display_event_seq", "compacted_by", "deleted_at", "created_at"]],
		]);
		const sql = {
			runtimeStateValue(key: string): unknown {
				const value = runtimeState.get(key);
				return value === undefined ? undefined : JSON.parse(value);
			},
			exec<T>(query: string, ...params: unknown[]) {
				const normalized = query.trim().replace(/\s+/g, " ");
				const tableInfo = /^PRAGMA table_info\(([^)]+)\)$/.exec(normalized);
				if (tableInfo) {
					return { toArray: () => (columnsByTable.get(tableInfo[1] ?? "") ?? []).map((name) => ({ name }) as T) };
				}
				if (/SELECT COUNT\(\*\) AS count FROM loop_messages/.test(normalized)) {
					return { one: () => ({ count: activeRows.length }) as T, toArray: () => [] as T[] };
				}
				if (/SELECT value_json FROM runtime_state WHERE key = \?/.test(normalized)) {
					const value = runtimeState.get(String(params[0]));
					return { toArray: () => (value === undefined ? [] : [{ value_json: value } as T]) };
				}
				if (/INSERT INTO runtime_state/.test(normalized)) {
					runtimeState.set(String(params[0]), String(params[1]));
				}
				if (/DELETE FROM runtime_state WHERE key = \?/.test(normalized)) {
					runtimeState.delete(String(params[0]));
				}
				if (/SELECT m\.seq, m\.position, m\.run_id/.test(normalized)) {
					return { toArray: () => activeRows as T[] };
				}
				if (/SELECT payload_json FROM events WHERE type = 'tick_started'/.test(normalized)) {
					return { toArray: () => [{ payload_json: JSON.stringify({ botId: "bot_constructor_violation" }) } as T] };
				}
				return { one: () => ({} as T), toArray: () => [] as T[] };
			},
		};
		const pending: Promise<void>[] = [];
		const state = {
			id: { toString: () => "do_constructor_violation" },
			blockConcurrencyWhile: (callback: () => Promise<void>) => {
				pending.push(callback());
			},
			storage: { sql },
		};
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() => new BotRuntime(state as unknown as DurableObjectState, {} as never)).not.toThrow();
			await expect(Promise.all(pending)).resolves.toEqual([undefined]);
			expect(consoleError).toHaveBeenCalledWith(
				"BotRuntime provider tool-call history invariant violation after startup migration",
				expect.objectContaining({
					botId: "bot_constructor_violation",
					objectId: "do_constructor_violation",
					violation: expect.stringContaining("assistant row 1 is not followed by a tool result"),
				}),
			);
		} finally {
			consoleError.mockRestore();
		}
		expect(sql.runtimeStateValue("provider_tool_call_history_invariant_violation")).toMatchObject({
			botId: "bot_constructor_violation",
			objectId: "do_constructor_violation",
			violation: expect.stringContaining("assistant row 1 is not followed by a tool result"),
		});
		expect(sql.runtimeStateValue("loop_messages_provider_tool_call_history_normalized_v1")).toBeUndefined();
	});

	it("stores display event sequence when inserting rich tool result loop messages", () => {
		const displayPayload = {
			name: "read_thread_by_id",
			args: { threadId: "thr_display" },
			result: {
				thread: { threadId: "thr_display", forumHandle: "rules", title: "Display thread" },
				content: [{ commentId: "cmt_display", body: "Full owner-facing body." }],
			},
			displayContext: { worldHandle: "sandbox" },
		};
		const sql = memoryLoopMessageInsertSql(42, displayPayload);
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage: { sql } },
		});
		const insertLoopMessage = (BotRuntime.prototype as unknown as {
			insertLoopMessage: (input: {
				runId: string;
				message: BotInferenceSubmissionMessage;
				origin: BotLoopMessage["origin"];
				status?: BotLoopMessage["status"];
				displayEventSeq?: number;
				broadcast: boolean;
			}) => BotLoopMessage;
		}).insertLoopMessage.bind(runtime);
		const minimizedContent = JSON.stringify({ content: [{ commentId: "cmt_display" }] });

		const inserted = insertLoopMessage({
			runId: "run-display",
			message: { role: "tool", tool_call_id: "call-read", content: minimizedContent },
			origin: "tool_result",
			status: "complete",
			displayEventSeq: 42,
			broadcast: false,
		});

		expect(sql.inserted()?.display_event_seq).toBe(42);
		expect(inserted.message.content).toBe(minimizedContent);
		expect(inserted.display).toEqual({
			kind: "tool_result",
			eventSeq: 42,
			name: "read_thread_by_id",
			args: displayPayload.args,
			result: displayPayload.result,
			context: { worldHandle: "sandbox" },
		});
	});

	it("builds provider chat requests with explicit tool-call and output controls", () => {
		const request = providerChatCompletionRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				providerRouting: { max_price: { prompt: 0.25, completion: 0.75 } },
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
		);

		expect(request.tool_choice).toBe("required");
		expect(request.parallel_tool_calls).toBe(true);
		expect(request.stream).toBe(true);
		expect(request.stream_options.include_usage).toBe(true);
		expect(request.max_completion_tokens).toBe(providerContextCompletionReserveTokens);
		expect(request.provider).toEqual({ max_price: { prompt: 0.25, completion: 0.75 } });
		expect(request.reasoning).toEqual({ effort: "minimal", exclude: false });
		expect(request.tools).toBe(toolDefinitions);
		expect(request.messages).toEqual([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			},
		]);
		expect(
			providerChatCompletionRequest(
				{
					baseUrl: customProviderBaseUrl,
					model: "test-model",
					supportsPrefill: false,
					temperature: 0.2,
				},
				[{ role: "user", content: "hello" }],
				toolDefinitions,
				"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			).messages,
		).toEqual([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			},
			{ role: "user", content: "Bickr Terminal is ready for my next step." },
		]);
		expect(
			providerChatCompletionRequest(
				{
					baseUrl: customProviderBaseUrl,
					model: "test-model",
					temperature: 0.2,
				},
				[{ role: "system", content: "System prompt." }],
				toolDefinitions,
				"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			).messages,
		).toEqual([
			{ role: "system", content: "System prompt." },
			{ role: "user", content: "Bickr Terminal is ready for my next step." },
			{
				role: "assistant",
				content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			},
		]);
		expect("frequency_penalty" in request).toBe(false);
		expect("presence_penalty" in request).toBe(false);
		expect("repetition_penalty" in request).toBe(false);

		const railroadRequest = providerChatCompletionRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			undefined,
			"railroad",
		);
		const atWillRequest = providerChatCompletionRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			undefined,
			"at_will",
		);
		expect("tool_choice" in railroadRequest).toBe(false);
		expect("tool_choice" in atWillRequest).toBe(false);

		const tunedRequest = providerChatCompletionRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				temperature: 0.2,
				frequencyPenalty: -0.25,
				presencePenalty: 0.5,
				repetitionPenalty: 1.15,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			);
		expect(tunedRequest).toMatchObject({
			frequency_penalty: -0.25,
			presence_penalty: 0.5,
			repetition_penalty: 1.15,
		});

		const claudeCacheRequest = providerChatCompletionRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "~anthropic/claude-sonnet-latest",
				promptCacheMode: "openrouter_anthropic_1h",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			undefined,
			"railroad",
			"bot:cache-test",
		);
		expect(claudeCacheRequest.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(claudeCacheRequest.session_id).toBe("bot:cache-test");

		const nonClaudeCacheRequest = providerChatCompletionRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "openai/gpt-5-mini",
				promptCacheMode: "openrouter_anthropic_5m",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			undefined,
			"railroad",
			"bot:cache-test",
		);
		expect("cache_control" in nonClaudeCacheRequest).toBe(false);
		expect("session_id" in nonClaudeCacheRequest).toBe(false);
	});

	it("applies conservative request policy for unknown OpenRouter models", () => {
		const request = providerChatCompletionRequest(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "unknown/provider-model",
				temperature: 0.2,
			},
			[{ role: "user", content: "hello" }],
			toolDefinitions,
			"Continue from here.",
		);

		expect(request.tool_choice).toBeUndefined();
		expect(request.reasoning).toBeUndefined();
		expect(request.messages.at(-1)).toEqual({
			role: "user",
			content: "Bickr Terminal is ready for my next step.",
		});
	});

		it("appends tool requirement prompt text only for require and railroad modes", () => {
			const tools = [
				toolDefinitions.find((definition) => definition.function.name === "read_thread")!,
				toolDefinitions.find((definition) => definition.function.name === "vote")!,
				toolDefinitionsForProviderRound().find((definition) => definition.function.name === metaCompactionToolName)!,
				{ type: "openrouter:web_search" } as ProviderToolDefinition,
			];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				activeLoopMessagesForProvider: () => [],
			});
			const activeProviderRequestMessages = (BotRuntime.prototype as unknown as {
				activeProviderRequestMessages: (
					bot: BotDocument,
					tools?: ProviderToolDefinition[],
					toolCalls?: "require" | "railroad" | "at_will",
				) => Array<{ role: string; content?: string }>;
			}).activeProviderRequestMessages.bind(runtime);

			const defaultSystem = activeProviderRequestMessages(fakeBotDocument())[0]?.content ?? "";
			const requireSystem = activeProviderRequestMessages(fakeBotDocument(), tools, "require")[0]?.content ?? "";
			const railroadSystem = activeProviderRequestMessages(fakeBotDocument(), tools, "railroad")[0]?.content ?? "";
			const atWillSystem = activeProviderRequestMessages(fakeBotDocument(), tools, "at_will")[0]?.content ?? "";

			expect(defaultSystem).not.toContain(metaCompactionToolName);
			expect(requireSystem).toContain("You MUST use one of the following tools: read_thread, vote, openrouter:web_search.");
			expect(requireSystem).toContain(`${metaCompactionToolName} may only be used when directed.`);
			expect(railroadSystem).toContain("You MUST use one of the following tools: read_thread, vote, openrouter:web_search.");
			expect(railroadSystem).toContain(`${metaCompactionToolName} may only be used when directed.`);
			expect(atWillSystem).not.toContain("You MUST use one of the following tools");
		});

		it("adds blank assistant content only in provider requests", () => {
			const reasoningOnlyMessage: BotInferenceSubmissionMessage = {
				role: "assistant",
				reasoning_details: [
					{ type: "reasoning.text", text: "I will choose a Bickr control.", format: "unknown", index: 0 },
				],
			};
			const toolCallMessage: BotInferenceSubmissionMessage = {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_read",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
					},
				],
			};

			const chatRequest = providerChatCompletionRequest(
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
				[reasoningOnlyMessage, toolCallMessage],
				toolDefinitions,
			);
			const compactionRequest = providerCompactionRequest(
				{ model: "test-model" },
				[reasoningOnlyMessage],
			);

			expect(chatRequest.messages[0]).toEqual({
				...reasoningOnlyMessage,
				content: "",
			});
			expect(chatRequest.messages[1]).toEqual({
				...toolCallMessage,
				content: "",
				tool_calls: [
					{
						...toolCallMessage.tool_calls![0]!,
						id: "call_1",
					},
				],
			});
			expect(compactionRequest.messages[0]).toEqual({
				...reasoningOnlyMessage,
				content: "",
			});
			expect("content" in reasoningOnlyMessage).toBe(false);
			expect(toolCallMessage.content).toBeNull();
		});

		it("flattens deeply nested tool result JSON only in provider requests", () => {
			const nestedJson = (depth: number): unknown => {
				let value: unknown = "leaf";
				for (let index = 0; index < depth; index += 1) {
					value = { child: value };
				}
				return value;
			};
			const deepContent = JSON.stringify(nestedJson(40));
			const shallowContent = JSON.stringify(nestedJson(4));
			const messages: BotInferenceSubmissionMessage[] = [
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_deep",
							type: "function",
							function: { name: "read_comment_by_id", arguments: "{\"commentRef\":\"c/deep\"}" },
						},
						{
							id: "call_shallow",
							type: "function",
							function: { name: "read_comment_by_id", arguments: "{\"commentRef\":\"c/shallow\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_deep", content: deepContent },
				{ role: "tool", tool_call_id: "call_shallow", content: shallowContent },
			];

			const request = providerCompactionRequest({ model: "test-model" }, messages);

			expect(request.messages[0]).toMatchObject({
				role: "assistant",
				content: "",
				tool_calls: [
					expect.objectContaining({ id: "call_1" }),
					expect.objectContaining({ id: "call_2" }),
				],
			});
			expect(request.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
			expect(request.messages[2]).toEqual({ role: "tool", tool_call_id: "call_2", content: shallowContent });
			const flattened = JSON.parse(request.messages[1]?.content as string) as { text: string };
			expect(flattened).toEqual({ text: deepContent });
			expect(JSON.parse(flattened.text) as unknown).toEqual(nestedJson(40));
			expect(messages[1]?.content).toBe(deepContent);
		});

	it("builds reasoning prefill defaults and preserves explicit trailing whitespace", () => {
		expect(defaultReasoningPrefill("release-sage")).toBe(
			"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
		);
		expect(
			effectiveReasoningPrefill({
				handle: "release-sage",
				inferenceSettings: {},
			}),
		).toBe("I'm u/release-sage. I need to think about how I feel and what I want to do next.");
		expect(
			effectiveReasoningPrefill({
				handle: "release-sage",
				inferenceSettings: { recurringPrompt: { lang: null, text: "I am Release Sage, and I  " } },
			}),
		).toBe("I am Release Sage, and I  ");
		expect(
			effectiveReasoningPrefill({
				handle: "release-sage",
				inferenceSettings: { recurringPromptEnabled: false },
			}),
		).toBeUndefined();
		expect(
			providerMessagesWithReasoningPrefill(
				[{ role: "user", content: "hello" }],
				"I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			),
		).toEqual([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "I'm u/release-sage. I need to think about how I feel and what I want to do next.",
			},
		]);
	});

	it("builds minimal provider probes for exact prompt-token counts", () => {
		const request = providerTokenProbeRequest(
			{
				baseUrl: customProviderBaseUrl,
				model: "test-model",
				providerRouting: { ignore: ["deepinfra"] },
				temperature: 0.2,
			},
			[{ role: "system", content: "Count this." }],
			toolDefinitions,
		);

			expect(request.stream).toBe(false);
			expect(request.max_tokens).toBe(1);
			expect(request.reasoning).toEqual({ effort: "minimal", exclude: false });
		expect(request.provider).toEqual({ ignore: ["deepinfra"] });
		expect(request.tool_choice).toBe("auto");
		expect(request.tools).toBe(toolDefinitions);

		const tunedRequest = providerTokenProbeRequest(
			{
				baseUrl: customProviderBaseUrl,
					model: "test-model",
					temperature: 0.2,
					reasoningEffort: "none",
					frequencyPenalty: -0.25,
				presencePenalty: 0.5,
				repetitionPenalty: 1.15,
			},
			[{ role: "system", content: "Count this." }],
			toolDefinitions,
		);
			expect(tunedRequest).toMatchObject({
				reasoning: { effort: "none", exclude: false },
				frequency_penalty: -0.25,
			presence_penalty: 0.5,
			repetition_penalty: 1.15,
		});
	});

	it("normalizes OpenRouter model capabilities for generated, unknown, free, and custom models", () => {
		const known = openRouterModelPolicy(capableOpenRouterModel);
		expect(known).toMatchObject({
			prefill: true,
			structuredOutputs: true,
			structuredOutputCompaction: true,
			compactionReasoningNone: true,
			requiredToolCalls: true,
			disabledReasoning: true,
			defaultCompactionMode: "structured_output",
			defaultReasoningEffort: "minimal",
			defaultToolCalls: "require",
		});
		expect(modelSupportsPrefill(capableOpenRouterModel, true)).toBe(true);
		expect(modelSupportsRequiredToolCalls(capableOpenRouterModel, true)).toBe(true);
		expect(modelSupportsStructuredOutputs(capableOpenRouterModel, true)).toBe(true);
		expect(modelSupportsCompactionReasoningNone(capableOpenRouterModel, true)).toBe(true);
		expect(effectiveReasoningEffortForModel(capableOpenRouterModel, true, "none")).toBe("none");

		const unknown = openRouterModelPolicy("unknown/provider-model");
		expect(unknown).toMatchObject({
			prefill: false,
			structuredOutputs: false,
			compactionReasoningNone: false,
			requiredToolCalls: false,
			disabledReasoning: false,
			defaultCompactionMode: "tool_call_cache_friendly",
			defaultToolCalls: "railroad",
		});
		expect(unknown.defaultReasoningEffort).toBeUndefined();
		expect(effectiveReasoningEffortForModel("unknown/provider-model", true, undefined)).toBeUndefined();
		expect(effectiveReasoningEffortForModel("unknown/provider-model", true, "none")).toBe("minimal");

		const free = openRouterModelPolicy(openRouterFreeModel);
		expect(free).toMatchObject({
			prefill: false,
			structuredOutputs: false,
			structuredOutputCompaction: false,
			compactionReasoningNone: false,
			requiredToolCalls: false,
			disabledReasoning: false,
			defaultCompactionMode: "tool_call_cache_friendly",
			defaultToolCalls: "railroad",
		});
		expect(free.defaultReasoningEffort).toBeUndefined();
		expect(effectiveCompactionModeForModel(openRouterFreeModel, true, "structured_output")).toBe("tool_call_cache_friendly");
		expect(effectiveSupportsPrefillForModel(openRouterFreeModel, true, true)).toBe(false);
		expect(effectiveStructuredToolCallsForModel(openRouterFreeModel, true, "require")).toBe("railroad");
		expect(effectiveToolCallsForModel(openRouterFreeModel, true, "at_will")).toBe("at_will");
		expect(modelSupportsPromptCacheControl("~anthropic/claude-sonnet-latest", true)).toBe(true);
		expect(modelSupportsPromptCacheControl("anthropic/claude-opus-4.1", true)).toBe(true);
		expect(modelSupportsPromptCacheControl("openai/gpt-5-mini", true)).toBe(false);

		const xiaomiFp8Routing = { only: ["xiaomi/fp8"] };
		const xiaomiFp8 = openRouterModelPolicy("xiaomi/mimo-v2.5", xiaomiFp8Routing);
		expect(xiaomiFp8).toMatchObject({
			structuredOutputs: true,
			structuredOutputCompaction: false,
			compactionReasoningNone: false,
			requiredToolCalls: true,
			defaultCompactionMode: "tool_call_cache_friendly",
			defaultToolCalls: "require",
		});
		expect(compactionReasoningNonePolicyForModel("xiaomi/mimo-v2.5", true, xiaomiFp8Routing)).toMatchObject({
			knownFailure: "server_tool_crash",
			runtimeFallback: "none",
			source: "openrouter_generated",
			supported: false,
		});
		expect(modelSupportsStructuredOutputs("xiaomi/mimo-v2.5", true, xiaomiFp8Routing)).toBe(true);
		expect(modelSupportsStructuredCompaction("xiaomi/mimo-v2.5", true, xiaomiFp8Routing)).toBe(false);
		expect(modelSupportsCompactionReasoningNone("xiaomi/mimo-v2.5", true, xiaomiFp8Routing)).toBe(false);
		expect(effectiveCompactionModeForModel("xiaomi/mimo-v2.5", true, "structured_output", xiaomiFp8Routing)).toBe(
			"tool_call_cache_friendly",
		);
		expect(effectiveStructuredToolCallsForModel("xiaomi/mimo-v2.5", true, "require", xiaomiFp8Routing)).toBe("require");

		expect(effectiveCompactionModeForModel("local/model", false, undefined)).toBe("structured_output");
		expect(effectiveReasoningEffortForModel("local/model", false, undefined)).toBe("minimal");
		expect(effectiveSupportsPrefillForModel("local/model", false, undefined)).toBe(true);
		expect(effectiveToolCallsForModel("local/model", false, undefined)).toBe("require");
		expect(compactionReasoningNonePolicyForModel("local/model", false)).toMatchObject({
			runtimeFallback: "unknown_model",
			source: "custom_provider",
			supported: true,
		});
	});

	it("resolves inference penalty settings from bot overrides before profile defaults", () => {
		const settings = effectiveProviderSettingsForBot(
			{ inferenceSettings: { frequencyPenalty: -0.25, repetitionPenalty: 1.2 } },
			{ inferenceSettings: { frequencyPenalty: 0.75, presencePenalty: 0.5, repetitionPenalty: 1.5 } },
			{},
		);

		expect(settings).toMatchObject({
			frequencyPenalty: -0.25,
			presencePenalty: 0.5,
			repetitionPenalty: 1.2,
		});
	});

	it("resolves tool-call mode settings and coerces translation at-will to railroad", () => {
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: {} },
				{},
			).toolCalls,
		).toBe("railroad");
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: {} },
				{ OPENROUTER_BASE_URL: customProviderBaseUrl },
			).toolCalls,
		).toBe("require");
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: { toolCalls: "railroad" } },
				{},
			).toolCalls,
		).toBe("railroad");
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { toolCalls: "at_will" } },
				{ inferenceSettings: { toolCalls: "railroad" } },
				{},
			).toolCalls,
		).toBe("at_will");

		expect(
			effectiveProviderSettingsForTranslation(
				{ inferenceSettings: { toolCalls: "at_will", translation: { enabled: true } } },
				{},
			)?.toolCalls,
		).toBe("railroad");
		expect(
			effectiveProviderSettingsForTranslation(
				{ inferenceSettings: { translation: { enabled: true, model: "translator/model", toolCalls: "railroad" } } },
				{},
			)?.toolCalls,
		).toBe("railroad");
	});

	it("resolves compaction mode and prefill support settings from bot overrides before profile defaults", () => {
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: {} },
				{},
			),
		).toMatchObject({
			compactionMode: "tool_call_cache_friendly",
			supportsPrefill: false,
		});
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: {} },
				{ OPENROUTER_BASE_URL: customProviderBaseUrl },
			),
		).toMatchObject({
			compactionMode: "structured_output",
			supportsPrefill: true,
		});
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: { compactionMode: "tool_call_cache_friendly", cacheFriendlyCompaction: true, supportsPrefill: false } },
				{},
			),
		).toMatchObject({
			compactionMode: "tool_call_cache_friendly",
			supportsPrefill: false,
		});
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { compactionMode: "tool_call", supportsPrefill: true } },
				{ inferenceSettings: { compactionMode: "tool_call_cache_friendly", supportsPrefill: false } },
				{},
			),
		).toMatchObject({
			compactionMode: "tool_call",
			supportsPrefill: false,
		});
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { cacheFriendlyCompaction: true } },
				{ inferenceSettings: { cacheFriendlyCompaction: true } },
				{},
			).compactionMode,
		).toBe("tool_call_cache_friendly");
		expect(
			effectiveProviderSettingsForBot(
				{
					inferenceSettings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "xiaomi/mimo-v2.5",
						compactionMode: "structured_output",
						providerRouting: { only: ["xiaomi/fp8"] },
					},
				},
				{ inferenceSettings: {} },
				{},
			),
		).toMatchObject({
			compactionMode: "tool_call_cache_friendly",
			providerRouting: { only: ["xiaomi/fp8"] },
		});
	});

	it("resolves prompt-cache mode only for OpenRouter Claude models", () => {
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{
					inferenceSettings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "~anthropic/claude-sonnet-latest",
						promptCacheMode: "openrouter_anthropic_5m",
					},
				},
				{},
			).promptCacheMode,
		).toBe("openrouter_anthropic_5m");
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { model: "~anthropic/claude-sonnet-latest", promptCacheMode: "openrouter_anthropic_1h" } },
				{
					inferenceSettings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "~anthropic/claude-sonnet-latest",
						promptCacheMode: "openrouter_anthropic_5m",
					},
				},
				{},
			).promptCacheMode,
		).toBe("openrouter_anthropic_1h");
		expect(
			effectiveProviderSettingsForBot(
				{
					inferenceSettings: {
						baseUrl: "https://openrouter.ai/api/v1",
						model: "openai/gpt-5-mini",
						promptCacheMode: "openrouter_anthropic_1h",
					},
				},
				{ inferenceSettings: {} },
				{},
			).promptCacheMode,
		).toBeUndefined();
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { baseUrl: customProviderBaseUrl, model: "anthropic/claude-opus-4.1", promptCacheMode: "openrouter_anthropic_1h" } },
				{ inferenceSettings: {} },
				{},
			).promptCacheMode,
		).toBeUndefined();
	});

	it("resolves OpenRouter provider routing from bot overrides before profile defaults", () => {
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: {} },
				{ inferenceSettings: { providerRouting: { max_price: { prompt: 0.25, completion: 0.75 } } } },
				{},
			).providerRouting,
		).toEqual({ max_price: { prompt: 0.25, completion: 0.75 } });
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { providerRouting: { order: ["openai"] } } },
				{ inferenceSettings: { providerRouting: { order: ["anthropic"] } } },
				{},
			).providerRouting,
		).toEqual({ order: ["openai"] });
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { providerRouting: {} } },
				{ inferenceSettings: { providerRouting: { order: ["anthropic"] } } },
				{},
			).providerRouting,
		).toBeUndefined();
		expect(
			effectiveProviderSettingsForBot(
				{ inferenceSettings: { baseUrl: "http://localhost:11434/v1", providerRouting: { order: ["openai"] } } },
				{ inferenceSettings: {} },
				{},
			).providerRouting,
		).toBeUndefined();
	});

	it("uses global inference defaults instead of profile fallbacks when a bot model is set", () => {
		const profileSettings = {
			openRouterApiKey: "sk-or-user",
			model: "profile/model",
			compactionMode: "tool_call_cache_friendly" as const,
			providerRouting: { order: ["anthropic"] },
			reasoningEffort: "high" as const,
			supportsPrefill: false,
			temperature: 0.4,
			toolCalls: "at_will" as const,
			topK: 12,
			topP: 0.7,
			minP: 0.1,
			frequencyPenalty: -0.5,
			presencePenalty: 0.25,
			repetitionPenalty: 1.2,
		};

		const inheritedBlocked = effectiveProviderSettingsForBot(
			{ inferenceSettings: { model: "bot/model" } },
			{ inferenceSettings: profileSettings },
			{},
		);

		expect(inheritedBlocked).toMatchObject({
			apiKey: "sk-or-user",
			baseUrl: "https://openrouter.ai/api/v1",
			compactionMode: "tool_call_cache_friendly",
			model: "bot/model",
			supportsPrefill: false,
			temperature: 1,
			toolCalls: "railroad",
		});
		expect(inheritedBlocked.providerRouting).toBeUndefined();
		expect(inheritedBlocked.reasoningEffort).toBeUndefined();
		expect(inheritedBlocked.topK).toBeUndefined();
		expect(inheritedBlocked.topP).toBeUndefined();
		expect(inheritedBlocked.minP).toBeUndefined();
		expect(inheritedBlocked.frequencyPenalty).toBeUndefined();
		expect(inheritedBlocked.presencePenalty).toBeUndefined();
		expect(inheritedBlocked.repetitionPenalty).toBeUndefined();

		expect(
			effectiveProviderSettingsForBot(
				{
					inferenceSettings: {
						model: "bot/model",
						compactionMode: "tool_call",
						providerRouting: { order: ["openai"] },
						reasoningEffort: "low",
						supportsPrefill: false,
						temperature: 0.2,
						toolCalls: "railroad",
						topP: 0.5,
					},
				},
				{ inferenceSettings: profileSettings },
				{},
			),
		).toMatchObject({
			apiKey: "sk-or-user",
			compactionMode: "tool_call",
			model: "bot/model",
			providerRouting: { order: ["openai"] },
			reasoningEffort: "low",
			supportsPrefill: false,
			temperature: 0.2,
			toolCalls: "railroad",
			topP: 0.5,
		});
	});

	it("builds OpenRouter server tool request entries only for OpenRouter base URLs", () => {
		const settings = {
			openRouter: {
				datetime: { enabled: true, timezone: "America/Los_Angeles" },
				webSearch: {
					enabled: true,
					engine: "exa" as const,
					maxResults: 3,
					maxTotalResults: 9,
					searchContextSize: "high" as const,
					userLocation: { type: "approximate" as const, city: "San Francisco", country: "US" },
					allowedDomains: ["example.com"],
					excludedDomains: ["reddit.com"],
				},
				webFetch: {
					enabled: true,
					engine: "openrouter" as const,
					maxUses: 2,
					maxContentTokens: 50_000,
					allowedDomains: ["docs.example.com"],
					blockedDomains: ["private.example.com"],
				},
			},
		};

		expect(isOpenRouterProviderBaseUrl("https://openrouter.ai/api/v1")).toBe(true);
		expect(isOpenRouterProviderBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(true);
		expect(isOpenRouterProviderBaseUrl("https://openrouter.ai/api/v1/images")).toBe(true);
		expect(isOpenRouterProviderBaseUrl("http://localhost:11434/v1")).toBe(false);

		const selection = openRouterServerToolSelection("https://openrouter.ai/api/v1/", settings);
		expect(selection.suppressed).toEqual([]);
		expect(selection.emitted).toEqual(["openrouter:datetime", "openrouter:web_search", "openrouter:web_fetch"]);
		expect(selection.tools).toEqual([
			{ type: "openrouter:datetime", parameters: { timezone: "America/Los_Angeles" } },
			{
				type: "openrouter:web_search",
				parameters: {
					engine: "exa",
					max_results: 3,
					max_total_results: 9,
					search_context_size: "high",
					user_location: { type: "approximate", city: "San Francisco", country: "US" },
					allowed_domains: ["example.com"],
					excluded_domains: ["reddit.com"],
				},
			},
			{
				type: "openrouter:web_fetch",
				parameters: {
					engine: "openrouter",
					max_uses: 2,
					max_content_tokens: 50_000,
					allowed_domains: ["docs.example.com"],
					blocked_domains: ["private.example.com"],
				},
			},
		]);

		const suppressed = openRouterServerToolSelection("http://localhost:11434/v1", settings);
		expect(suppressed.tools).toEqual([]);
		expect(suppressed.suppressed).toEqual(selection.emitted);

		const disabled = openRouterServerToolSelection("https://openrouter.ai/api/v1", {});
		expect(disabled.tools).toEqual([]);
		expect([...toolDefinitions, ...disabled.tools].some((definition) => definition.type === "function")).toBe(true);
	});

	it("retries provider stream idle timeouts", async () => {
		vi.useFakeTimers();
		try {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const fetchProviderResponse = vi
				.fn<() => Promise<ReadableStream<Uint8Array>>>()
				.mockResolvedValueOnce(neverStream())
				.mockResolvedValueOnce(sseStream([
					{
						id: "response-recovered",
						model: "test/model",
						choices: [{ delta: { content: "Recovered." } }],
					},
					"[DONE]",
				]));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
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
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: Record<string, unknown>,
					messages: Array<Record<string, unknown>>,
					tools: Array<Record<string, unknown>>,
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<{ content: string; toolCalls: unknown[] }>;
			}).callProvider.bind(runtime);

			const response = callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-retry",
				77,
				new AbortController().signal,
			);
			await vi.advanceTimersByTimeAsync(90_000);

			await expect(response).resolves.toMatchObject({ content: "Recovered.", toolCalls: [] });
			expect(fetchProviderResponse).toHaveBeenCalledTimes(2);
			expect(events).toContainEqual({
				type: "provider_retry",
				payload: expect.objectContaining({
					attempt: 2,
					maxAttempts: 5,
					reason: "Inference stream stopped responding after 60 seconds.",
				}),
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries retryable provider errors reported inside streamed chunks", async () => {
		vi.useFakeTimers();
		try {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const streamedProviderError = (id: string) => ({
				id,
				object: "chat.completion.chunk",
				created: 1777968809,
				model: "google/gemma-4-26b-a4b-it-20260403",
				provider: "DeepInfra",
				choices: [],
				error: {
					code: 502,
					message: "Provider returned error",
					metadata: { error_type: "provider_unavailable" },
				},
			});
			const fetchProviderResponse = vi
				.fn<() => Promise<ReadableStream<Uint8Array>>>()
				.mockResolvedValueOnce(sseStream([streamedProviderError("gen-first")]))
				.mockResolvedValueOnce(sseStream([streamedProviderError("gen-second")]))
				.mockResolvedValueOnce(sseStream([
					{
						id: "response-recovered",
						model: "test/model",
						choices: [{ delta: { content: "Recovered." } }],
					},
					"[DONE]",
				]));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
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
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: Record<string, unknown>,
					messages: Array<Record<string, unknown>>,
					tools: Array<Record<string, unknown>>,
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<{ content: string; toolCalls: unknown[] }>;
			}).callProvider.bind(runtime);

			const response = callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-provider-error-retry",
				77,
				new AbortController().signal,
			);
			await vi.advanceTimersByTimeAsync(90_000);

			await expect(response).resolves.toMatchObject({ content: "Recovered.", toolCalls: [] });
			expect(fetchProviderResponse).toHaveBeenCalledTimes(3);
			expect(events.filter((event) => event.type === "provider_retry").map((event) => event.payload.reason)).toEqual([
				"502:Provider returned error (provider_unavailable)",
				"502:Provider returned error (provider_unavailable)",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries upstream-provider 429s with request-local provider ignore routing", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const fetchProviderResponse = vi
			.fn<(_settings: unknown, _endpoint: string, _body: string, _signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>>()
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-limit", "DeepInfra")]))
			.mockResolvedValueOnce(sseStream([
				{
					id: "response-recovered",
					model: "test/model",
					choices: [{ delta: { content: "Recovered." } }],
				},
				"[DONE]",
			]));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
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
			broadcastProviderDelta: () => {},
			clearProviderStreamActive: () => {},
			fetchProviderResponse,
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const callProvider = (BotRuntime.prototype as unknown as {
			callProvider: (
				settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
				tools: Array<Record<string, unknown>>,
				runId: string,
				streamSeq: number,
				signal: AbortSignal,
			) => Promise<{ content: string; toolCalls: unknown[] }>;
		}).callProvider.bind(runtime);

		const response = await callProvider(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "test/model",
				temperature: 0.7,
			},
			[{ role: "user", content: "Act." }],
			[],
			"run-stream-provider-rate-limit",
			77,
			new AbortController().signal,
		);

		expect(response).toMatchObject({ content: "Recovered.", toolCalls: [] });
		expect(fetchProviderResponse).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(String(fetchProviderResponse.mock.calls[0]?.[2])) as { provider?: Record<string, unknown> };
		const secondBody = JSON.parse(String(fetchProviderResponse.mock.calls[1]?.[2])) as { provider?: Record<string, unknown> };
		expect(firstBody.provider).toBeUndefined();
		expect(secondBody.provider).toEqual({ ignore: ["DeepInfra"] });
		expect(events).toContainEqual({
			type: "provider_retry",
			payload: expect.objectContaining({
				attempt: 2,
				maxAttempts: 5,
				delayMs: 0,
				reason: expect.stringContaining("ignoring upstream provider DeepInfra"),
			}),
		});
	});

	it("does not reroute provider 429s without structured upstream provider metadata", async () => {
		vi.useFakeTimers();
		try {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const provider429WithoutProviderName = {
				id: "gen-limit-without-provider",
				object: "chat.completion.chunk",
				model: "google/gemma-4-31b-it",
				choices: [],
				error: {
					code: 429,
					message: "Provider returned error",
					metadata: {
						error_type: "provider_rate_limited",
						raw: "An upstream provider is temporarily rate-limited.",
					},
				},
			};
			const fetchProviderResponse = vi
				.fn<(_settings: unknown, _endpoint: string, _body: string, _signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>>()
				.mockResolvedValueOnce(sseStream([provider429WithoutProviderName]))
				.mockResolvedValueOnce(sseStream([
					{
						id: "response-recovered",
						model: "test/model",
						choices: [{ delta: { content: "Recovered." } }],
					},
					"[DONE]",
				]));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
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
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: Record<string, unknown>,
					messages: Array<Record<string, unknown>>,
					tools: Array<Record<string, unknown>>,
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<{ content: string; toolCalls: unknown[] }>;
			}).callProvider.bind(runtime);

			const response = callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-provider-rate-limit-no-provider",
				77,
				new AbortController().signal,
			);
			await vi.advanceTimersByTimeAsync(90_000);

			await expect(response).resolves.toMatchObject({ content: "Recovered.", toolCalls: [] });
			const firstBody = JSON.parse(String(fetchProviderResponse.mock.calls[0]?.[2])) as { provider?: Record<string, unknown> };
			const secondBody = JSON.parse(String(fetchProviderResponse.mock.calls[1]?.[2])) as { provider?: Record<string, unknown> };
			expect(firstBody.provider).toBeUndefined();
			expect(secondBody.provider).toBeUndefined();
			expect(events).toContainEqual({
				type: "provider_retry",
				payload: expect.objectContaining({
					attempt: 2,
					maxAttempts: 5,
					reason: "429:Provider returned error (provider_rate_limited)",
				}),
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("accumulates newly reported upstream providers without replacing existing routing", async () => {
		const fetchProviderResponse = vi
			.fn<(_settings: unknown, _endpoint: string, _body: string, _signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>>()
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-deepinfra", "DeepInfra")]))
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-fireworks", "Fireworks")]))
			.mockResolvedValueOnce(sseStream([
				{
					id: "response-recovered",
					model: "test/model",
					choices: [{ delta: { content: "Recovered." } }],
				},
				"[DONE]",
			]));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async () => ({
				seq: 1,
				runId: "run-stream-provider-rate-limit-accumulate",
				type: "provider_retry",
				payload: {},
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			broadcastProviderDelta: () => {},
			clearProviderStreamActive: () => {},
			fetchProviderResponse,
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const callProvider = (BotRuntime.prototype as unknown as {
			callProvider: (
				settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
				tools: Array<Record<string, unknown>>,
				runId: string,
				streamSeq: number,
				signal: AbortSignal,
			) => Promise<{ content: string; toolCalls: unknown[] }>;
		}).callProvider.bind(runtime);

		await expect(callProvider(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "test/model",
				temperature: 0.7,
				providerRouting: { order: ["openrouter/fallback"], ignore: ["A"] },
			},
			[{ role: "user", content: "Act." }],
			[],
			"run-stream-provider-rate-limit-accumulate",
			77,
			new AbortController().signal,
		)).resolves.toMatchObject({ content: "Recovered.", toolCalls: [] });

		const firstBody = JSON.parse(String(fetchProviderResponse.mock.calls[0]?.[2])) as { provider?: Record<string, unknown> };
		const secondBody = JSON.parse(String(fetchProviderResponse.mock.calls[1]?.[2])) as { provider?: Record<string, unknown> };
		const thirdBody = JSON.parse(String(fetchProviderResponse.mock.calls[2]?.[2])) as { provider?: Record<string, unknown> };
		expect(firstBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A"] });
		expect(secondBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A", "DeepInfra"] });
		expect(thirdBody.provider).toEqual({ order: ["openrouter/fallback"], ignore: ["A", "DeepInfra", "Fireworks"] });
	});

	it("stops upstream-provider 429 retries when the ignored provider repeats", async () => {
		const fetchProviderResponse = vi
			.fn<(_settings: unknown, _endpoint: string, _body: string, _signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>>()
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-limit-first", "DeepInfra")]))
			.mockResolvedValueOnce(sseStream([streamedProviderRateLimit("gen-limit-second", "DeepInfra")]));
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async () => ({
				seq: 1,
				runId: "run-stream-provider-rate-limit-repeat",
				type: "provider_retry",
				payload: {},
				tokenEstimate: 0,
				createdAt: new Date().toISOString(),
			}),
			broadcastProviderDelta: () => {},
			clearProviderStreamActive: () => {},
			fetchProviderResponse,
			markProviderStreamActive: () => {},
			throwIfStopped: (_runId: string, signal: AbortSignal) => {
				if (signal.aborted) {
					throw new Error("Unexpected abort.");
				}
			},
		});
		const callProvider = (BotRuntime.prototype as unknown as {
			callProvider: (
				settings: Record<string, unknown>,
				messages: Array<Record<string, unknown>>,
				tools: Array<Record<string, unknown>>,
				runId: string,
				streamSeq: number,
				signal: AbortSignal,
			) => Promise<{ content: string; toolCalls: unknown[] }>;
		}).callProvider.bind(runtime);

		let thrown: unknown;
		try {
			await callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-provider-rate-limit-repeat",
				77,
				new AbortController().signal,
			);
		} catch (error) {
			thrown = error;
		}

		expect(fetchProviderResponse).toHaveBeenCalledTimes(2);
		const secondBody = JSON.parse(String(fetchProviderResponse.mock.calls[1]?.[2])) as { provider?: Record<string, unknown> };
		expect(secondBody.provider).toEqual({ ignore: ["DeepInfra"] });
		expect(thrown).toMatchObject({
			name: "ProviderLoopRequestError",
			attempts: 2,
		});
		expect((thrown as Error).message).toContain("Inference request failed with status 429: Provider returned error (provider_rate_limited)");
	});

	it("wraps exhausted loop provider retries with request and response diagnostics", async () => {
		vi.useFakeTimers();
		try {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const streamedProviderError = {
				id: "response-failed",
				model: "test/model",
				choices: [],
				error: {
					code: 500,
					message: "Internal Server Error",
				},
			};
			const fetchProviderResponse = vi.fn(async () => sseStream([streamedProviderError]));
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: async (_runId: string, type: string, payload: Record<string, unknown>) => {
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
				broadcastProviderDelta: () => {},
				clearProviderStreamActive: () => {},
				fetchProviderResponse,
				markProviderStreamActive: () => {},
				throwIfStopped: (_runId: string, signal: AbortSignal) => {
					if (signal.aborted) {
						throw new Error("Unexpected abort.");
					}
				},
			});
			const callProvider = (BotRuntime.prototype as unknown as {
				callProvider: (
					settings: Record<string, unknown>,
					messages: Array<Record<string, unknown>>,
					tools: Array<Record<string, unknown>>,
					runId: string,
					streamSeq: number,
					signal: AbortSignal,
				) => Promise<{ content: string; toolCalls: unknown[] }>;
			}).callProvider.bind(runtime);

			let thrown: unknown;
			const response = callProvider(
				{
					baseUrl: "https://openrouter.ai/api/v1",
					model: "test/model",
					temperature: 0.7,
				},
				[{ role: "user", content: "Act." }],
				[],
				"run-stream-provider-error-exhausted",
				77,
				new AbortController().signal,
			).catch((error: unknown) => {
				thrown = error;
			});
			await vi.advanceTimersByTimeAsync(300_000);
			await response;

			const rawResponse = JSON.stringify(streamedProviderError);
			expect(fetchProviderResponse).toHaveBeenCalledTimes(5);
			expect(events.filter((event) => event.type === "provider_retry").map((event) => event.payload.attempt)).toEqual([2, 3, 4, 5]);
			expect(thrown).toMatchObject({
				name: "ProviderLoopRequestError",
				attempts: 5,
				responseBody: rawResponse,
			});
			expect((thrown as Error).message).toContain("Inference failed after 5 provider attempts (4 retries); last error from provider:");
			expect((thrown as Error).message).toContain("Inference request failed with status 500: Internal Server Error");
			expect((thrown as { requestBody?: string }).requestBody).toContain("\"stream\":true");
			expect((thrown as { requestBody?: string }).requestBody).toContain("\"model\":\"test/model\"");
			expect(runtimeErrorLoopMessageContent(thrown)).toMatch(/^Bickr Terminal tried 5 times to reach the configured service\. Last error: /);
		} finally {
			vi.useRealTimers();
		}
	});

	it("captures OpenRouter router metadata from streamed final chunks", async () => {
		type TestProviderResponse = {
			content: string;
			responseId?: string;
			responseProviderName?: string;
			toolCalls: Array<Record<string, unknown>>;
		};
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			broadcastProviderDelta: () => {},
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
				generationResponseId?: string,
			) => Promise<TestProviderResponse>;
		}).consumeProviderResponse.bind(runtime);

		const response = await consumeProviderResponse(
			"run-router-metadata",
			42,
			sseStream([
				{
					id: "chatcmpl-upstream",
					model: "test/model",
					choices: [{ delta: { content: "Done." } }],
				},
				{
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
					openrouter_metadata: {
						endpoints: {
							available: [
								{ provider: "DeepInfra", model: "test/model", selected: true },
							],
						},
					},
				},
				"[DONE]",
			]),
			new AbortController().signal,
			"gen-header",
		);

		expect(response).toMatchObject({
			content: "Done.",
			responseId: "gen-header",
			responseProviderName: "DeepInfra",
			toolCalls: [],
		});
	});

	it("uses the provider request sequence as the live stream identity for final loop messages", async () => {
		const events: Array<{ seq: number; type: string; payload: Record<string, unknown> }> = [];
		let providerStreamSeq: number | undefined;
		const appendedLoopMessages: Array<{
			message: Record<string, unknown>;
			origin: string;
			status: string | undefined;
			streamSeq: number | undefined;
		}> = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			appendEvent: async (runId: string, type: string, payload: Record<string, unknown>) => {
				const seq = type === "provider_request" ? 123 : 123 + events.length + 1;
				events.push({ seq, type, payload });
				return runtimeEvent(seq, runId, type as BotRuntimeEvent["type"], payload);
			},
			appendLoopMessage: (
				runId: string,
				message: Record<string, unknown>,
				origin: string,
				status?: string,
				options?: { streamSeq?: number },
			) => {
				appendedLoopMessages.push({ message, origin, status, streamSeq: options?.streamSeq });
				return {
					seq: 200,
					runId,
					role: "assistant",
					message,
					origin,
					status,
					tokenEstimate: 0,
					createdAt: new Date().toISOString(),
					...(options?.streamSeq !== undefined ? { streamSeq: options.streamSeq } : {}),
				};
			},
			callProvider: async (_settings: unknown, _messages: unknown, _tools: unknown, _runId: string, streamSeq: number) => {
				providerStreamSeq = streamSeq;
				return providerResponseWithContent("I have finished this round.");
			},
			ensureProviderPromptWithinBudget: async () => ({
				allowedPromptTokens: 13_500,
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
					{
						...fakeBotDocument({
							id: "bot_stream",
							handle: "stream-sage",
							displayName: "Stream Sage",
							shortBio: "Watches loop streams.",
							prompt: "Keep stream state coherent.",
						}),
							tickSettings: {
								enabled: true,
								intervalSeconds: 300,
								compactionThreshold: 0.75,
								maxToolCallsPerTick: 1,
								maxSuccessfulToolCallsPerIteration: 8,
								contextWindowTokens: 16_000,
							},
					},
				{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2, toolCalls: "at_will" },
				"run-loop-stream",
				[],
				{ mode: "normal", signal: new AbortController().signal },
			),
		).resolves.toMatchObject({ logOffCalled: false });

		expect(providerStreamSeq).toBe(123);
		expect(events).toContainEqual(expect.objectContaining({
			type: "assistant_message",
			payload: expect.objectContaining({ streamSeq: 123 }),
		}));
		expect(appendedLoopMessages).toContainEqual(expect.objectContaining({
			origin: "provider_response",
			streamSeq: 123,
		}));
	});

	it("does not retain empty provider responses in provider history", async () => {
		expect(providerResponseMessageForHistory({
			content: "",
			reasoning: "",
			reasoningDetails: [],
			toolCalls: [],
		})).toBeNull();
		expect(providerResponseMessageForHistory({
			content: "",
			reasoning: "I am deciding what to do next.",
			reasoningDetails: [],
			toolCalls: [],
		})).toEqual({ role: "assistant", reasoning: "I am deciding what to do next." });
		expect(providerResponseMessageForHistory(providerResponseWithToolCall("call-read", "read_thread", { threadId: "thr_test" }))).toMatchObject({
			role: "assistant",
			content: null,
			tool_calls: [
				expect.objectContaining({
					id: "call-read",
					function: expect.objectContaining({ name: "read_thread" }),
				}),
			],
		});
		expect(loopMessageContributesToProviderHistory("provider_response", { role: "assistant", content: null })).toBe(false);
		expect(loopMessageContributesToProviderHistory("provider_response", { role: "assistant", content: "" })).toBe(false);
		expect(loopMessageContributesToProviderHistory("runtime_error", { role: "user", content: "Bickr Terminal reported an error." })).toBe(false);
		expect(loopMessageContributesToProviderHistory("synthetic_context", { role: "assistant", content: null })).toBe(true);
	});

	it("validates provider tool-call arguments before history or execution", () => {
		const sanitized = sanitizeProviderToolCalls([
			{
				id: "call-malformed",
				type: "function",
				function: { name: "read_thread", arguments: "{\"threadId\":" },
			},
			{
				id: "call-array",
				type: "function",
				function: { name: "read_thread", arguments: "[]" },
			},
			{
				id: "call-null",
				type: "function",
				function: { name: "read_thread", arguments: "null" },
			},
			{
				id: "call-string",
				type: "function",
				function: { name: "read_thread", arguments: "\"x\"" },
			},
			{
				id: "call-valid",
				type: "function",
				function: { name: "read_thread", arguments: "{ \"threadId\": \"thr_test\" }" },
			},
			{
				id: "call-valid",
				type: "function",
				function: { name: "reply_to_comment", arguments: "{ \"commentId\": \"com_test\", \"body\": \"Duplicate id.\" }" },
			},
		]);

		expect(sanitized.dropped.map((call) => [call.id, call.reason])).toEqual([
			["call-malformed", "invalid_arguments_json"],
			["call-array", "arguments_not_json_object"],
			["call-null", "arguments_not_json_object"],
			["call-string", "arguments_not_json_object"],
			["call-valid", "duplicate_tool_call"],
		]);
		expect(sanitized.toolCalls).toEqual([
			{
				id: "call-valid",
				type: "function",
				function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
			},
		]);
	});

	it("compacts duplicate request-local tool call ids without repairing history", () => {
		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{
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
				},
				{ role: "tool", tool_call_id: "call-duplicate", content: "{\"ok\":true,\"kept\":true}" },
				{ role: "tool", tool_call_id: "call-duplicate", content: "{\"ok\":true,\"dropped\":true}" },
			],
			[],
		);

		const assistant = request.messages.find((message) => Array.isArray(message.tool_calls));
		expect(assistant?.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call_1", "call_2"]);
		expect(assistant?.tool_calls?.map((toolCall) => toolCall.function.name)).toEqual(["read_thread", "reply_to_comment"]);
		expect(request.messages.filter((message) => message.role === "tool").map((message) => message.content)).toEqual([
			"{\"ok\":true,\"kept\":true}",
			"{\"ok\":true,\"dropped\":true}",
		]);
		expect(request.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call_1", "call_2"]);
	});

	it("adds stable initial user context before prior activity for provider compatibility", () => {
		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{ role: "system", content: "System prompt." },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-read",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_test\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call-read", content: "{\"ok\":true}" },
			],
			[],
		);

		expect(request.messages[1]).toEqual({
			role: "user",
			content: "Bickr Terminal is ready for my next step.",
		});
		expect(request.messages.at(-1)).toMatchObject({
			role: "tool",
			tool_call_id: "call_1",
			content: "{\"ok\":true}",
		});
	});

	it("rewrites provider request tool call ids to compact request-local ids", () => {
		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-repeat",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_first\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call-repeat", content: "{\"ok\":true,\"first\":true}" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-repeat",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_second\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call-repeat", content: "{\"ok\":true,\"second\":true}" },
			],
			[],
		);

		const assistantIds = request.messages
			.filter((message) => Array.isArray(message.tool_calls))
			.flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.id) ?? []);
		const toolIds = request.messages
			.filter((message) => message.role === "tool")
			.map((message) => message.tool_call_id);

		expect(assistantIds).toEqual(["call_1", "call_2"]);
		expect(toolIds).toEqual(["call_1", "call_2"]);
		expect(new Set(assistantIds).size).toBe(assistantIds.length);
	});

	it("shortens long synthetic provider request ids that differ only near the end", () => {
		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{
					role: "assistant",
					content: "I check two things.",
					tool_calls: [
						{
							id: "synthetic_a444be5d-a813-48cf-be41-10c161645fc7_0",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_first\"}" },
						},
						{
							id: "synthetic_a444be5d-a813-48cf-be41-10c161645fc7_1",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_second\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "synthetic_a444be5d-a813-48cf-be41-10c161645fc7_0", content: "{\"ok\":true,\"first\":true}" },
				{ role: "tool", tool_call_id: "synthetic_a444be5d-a813-48cf-be41-10c161645fc7_1", content: "{\"ok\":true,\"second\":true}" },
			],
			[],
		);

		const assistant = request.messages.find((message) => Array.isArray(message.tool_calls));
		expect(assistant?.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call_1", "call_2"]);
		expect(request.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call_1", "call_2"]);
		expect(JSON.stringify(request.messages)).not.toContain("synthetic_a444be5d");
	});

	it("keeps rewritten provider request ids stable when new messages append", () => {
		const initialMessages: BotInferenceSubmissionMessage[] = [
			{ role: "system", content: "System prompt." },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "synthetic_first_long_id_that_may_be_provider_normalized_0",
						type: "function",
						function: { name: "read_thread", arguments: "{\"threadId\":\"thr_first\"}" },
					},
				],
			},
			{ role: "tool", tool_call_id: "synthetic_first_long_id_that_may_be_provider_normalized_0", content: "{\"ok\":true,\"first\":true}" },
		];
		const initialRequest = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			initialMessages,
			[],
		);
		const extendedRequest = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				...initialMessages,
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "synthetic_second_long_id_that_may_be_provider_normalized_0",
							type: "function",
							function: { name: "read_thread", arguments: "{\"threadId\":\"thr_second\"}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "synthetic_second_long_id_that_may_be_provider_normalized_0", content: "{\"ok\":true,\"second\":true}" },
			],
			[],
		);

		expect(initialRequest.messages[1]).toEqual({
			role: "user",
			content: "Bickr Terminal is ready for my next step.",
		});
		expect(extendedRequest.messages.slice(0, initialRequest.messages.length)).toEqual(initialRequest.messages);
		expect(extendedRequest.messages.flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.id) ?? [])).toEqual(["call_1", "call_2"]);
		expect(extendedRequest.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call_1", "call_2"]);
	});

	it("repairs invalid Unicode and truncates without splitting surrogate pairs", () => {
		const high = "\uD83C";
		const low = "\uDF0C";
		const galaxy = "🌌";

		expect(repairInvalidUnicodeText(`a${high}b${low}c${galaxy}`)).toBe(`a\uFFFDb\uFFFDc${galaxy}`);
		expect(repairInvalidUnicodeText(galaxy)).toBe(galaxy);

		const truncated = truncateForContext(galaxy.repeat(2_100), 4_000);
		expect(truncated.endsWith("…")).toBe(true);
		expect(hasLoneSurrogate(truncated)).toBe(false);

		const request = providerChatCompletionRequest(
			{ baseUrl: "https://openrouter.ai/api/v1", model: "test-model", temperature: 0.2 },
			[
				{ role: "assistant", content: `bad saved text ${high}` },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_unicode",
							type: "function",
							function: { name: "read_thread", arguments: JSON.stringify({ threadId: "thr_test", note: `bad ${high}` }) },
						},
					],
				},
			],
			[],
		);
		expect(hasLoneSurrogate(request.messages)).toBe(false);
		expect(JSON.stringify(request)).not.toContain("\\ud83c");
		expect(JSON.parse(request.messages[1]?.tool_calls?.[0]?.function.arguments ?? "{}")).toMatchObject({ note: "bad \uFFFD" });
	});

		it("prunes provider-facing discovery arrays to the token budget", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
			try {
				const scope = { commentsWithText: new Set<string>(), threadsWithText: new Set<string>() };
				const searchResult = providerToolResultPayload(
					"search_threads",
					[
						{ threadId: "thr_new", commentId: "cmt_new", forumHandle: "random", title: "New", authorHandle: "alice", createdAt: "2026-05-08T00:00:00.000Z" },
						{ threadId: "thr_mid", commentId: "cmt_mid", forumHandle: "random", title: "Middle", authorHandle: "bob", createdAt: "2026-05-07T00:00:00.000Z" },
						{ threadId: "thr_old", commentId: "cmt_old", forumHandle: "random", title: "Old", authorHandle: "carol", createdAt: "2026-05-06T00:00:00.000Z" },
					],
					{},
					scope,
					{ tokenBudget: 45 },
				) as Array<Record<string, unknown>>;
				expect(searchResult.map((item) => item.threadRef)).toEqual(["t/thr_new"]);

				const semanticSearchResult = providerToolResultPayload(
					"search_threads_semantic",
					[
						{ threadId: "thr_semantic_new", commentId: "cmt_semantic_new", forumHandle: "random", title: "New semantic hit", authorHandle: "alice" },
						{ threadId: "thr_semantic_old", commentId: "cmt_semantic_old", forumHandle: "random", title: "Old semantic hit", authorHandle: "bob" },
					],
					{},
					scope,
					{ tokenBudget: 45 },
				) as Array<Record<string, unknown>>;
				expect(semanticSearchResult.map((item) => item.threadRef)).toEqual(["t/thr_semantic_new"]);

				const profilesResult = providerToolResultPayload(
					"view_profiles",
					{
						profiles: [
							{ handle: "alpha", displayName: "Alpha", shortBio: "Profile alpha." },
							{ handle: "beta", displayName: "Beta", shortBio: "Profile beta." },
							{ handle: "gamma", displayName: "Gamma", shortBio: "Profile gamma." },
						],
					},
					{},
					scope,
					{ tokenBudget: 45 },
				) as { profiles: Array<Record<string, unknown>> };
				expect(profilesResult.profiles.map((item) => item.username)).toEqual(["u/alpha"]);

				const listProfilesResult = providerToolResultPayload(
					"list_profiles",
					{
						mode: "window",
						offset: 0,
						limit: 3,
						total: 3,
						hasMore: false,
						profiles: [
							{ handle: "alpha", displayName: "Alpha", shortBio: "Profile alpha." },
							{ handle: "beta", displayName: "Beta", shortBio: "Profile beta." },
							{ handle: "gamma", displayName: "Gamma", shortBio: "Profile gamma." },
						],
					},
					{},
					scope,
					{ tokenBudget: 45 },
				) as { mode: string; offset: number; limit: number; total: number; hasMore: boolean; profiles: Array<Record<string, unknown>> };
				expect(listProfilesResult).toMatchObject({
					mode: "window",
					offset: 0,
					limit: 3,
					total: 3,
					hasMore: false,
				});
				expect(listProfilesResult.profiles.map((item) => item.username)).toEqual(["u/alpha"]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("trims activity previews with ellipses before pruning oldest activity entries", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
			try {
				const unbudgetedActivityResult = providerToolResultPayload("view_activity", {
					bot: { handle: "owner" },
					activities: [{ type: "thread", threadId: "thr_preview", forumHandle: "random", bodyPreview: "p".repeat(240), createdAt: "2026-05-08T00:00:00.000Z" }],
				}) as { activities: Array<Record<string, unknown>> };
				expect(unbudgetedActivityResult.activities[0]?.bodyPreview).toBe(`${"p".repeat(240)}…`);

				const activityResult = providerToolResultPayload(
					"view_activity",
					{
						bot: { handle: "owner" },
						activities: [
							{
								type: "comment",
								commentId: "cmt_new",
								forumHandle: "random",
								bodyPreview: "n".repeat(240),
								parentComment: { authorHandle: "parent", bodyPreview: "p".repeat(240) },
								createdAt: "2026-05-08T00:00:00.000Z",
							},
							{
								type: "comment",
								commentId: "cmt_old",
								forumHandle: "random",
								bodyPreview: "o".repeat(240),
								parentComment: { authorHandle: "parent", bodyPreview: "older parent" },
								createdAt: "2026-05-07T00:00:00.000Z",
							},
						],
					},
					{},
					{ commentsWithText: new Set<string>(), threadsWithText: new Set<string>() },
					{ tokenBudget: 70 },
				) as { activities: Array<Record<string, unknown>> };

				expect(activityResult.activities).toHaveLength(1);
				expect(activityResult.activities[0]).toMatchObject({
					type: "comment",
					commentRef: "c/cmt_new",
					bodyPreview: "…",
					replyTo: { author: "u/parent", bodyPreview: "…" },
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it("omits older notification events without trimming notification text", () => {
			const notifications = [
				{
					id: "ntf_old",
					type: "comment_created",
					deliveryReasons: ["mention"],
					sourceObjectId: "cmt_old",
					actor: { username: "u/old" },
					comment: { id: "cmt_old", threadId: "thr_old", text: "Old text that should be omitted rather than shortened. " + "x".repeat(400) },
				},
				{
					id: "ntf_new",
					type: "comment_created",
					deliveryReasons: ["mention"],
					sourceObjectId: "cmt_new",
					actor: { username: "u/new" },
					comment: { id: "cmt_new", threadId: "thr_new", text: "Newest notification text stays whole." },
				},
			];
			const notificationResult = providerToolResultPayload(
				"check_notifications",
				{ events: notifications },
				{},
				{ commentsWithText: new Set<string>(), threadsWithText: new Set<string>() },
				{ tokenBudget: 90 },
			) as { context?: string; events: Array<Record<string, unknown>> };

			expect(notificationResult.context).toContain("1 older notification event was omitted");
			expect(JSON.stringify(notificationResult)).not.toContain("Old text that should be omitted");
			expect(JSON.stringify(notificationResult)).not.toContain("…");
			expect(notificationResult.events).toHaveLength(1);
			expect(notificationResult.events[0]).toMatchObject({
				actor: "u/new",
				comment: { commentRef: "c/cmt_new", text: "Newest notification text stays whole." },
			});
		});

		it("returns only included notification IDs for delivery marking", async () => {
			const appendedMessages: Array<Record<string, unknown>> = [];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				readCommentTreeTokenBudget: async () => 90,
				appendLoopMessage: (_runId: string, message: Record<string, unknown>) => {
					appendedMessages.push(message);
					return { seq: appendedMessages.length };
				},
			});
			const appendNotificationSyntheticContext = (BotRuntime.prototype as unknown as {
				appendNotificationSyntheticContext: (
					bot: BotDocument,
					runId: string,
					notifications: Array<Record<string, unknown>>,
					existingProfileUsernames: ReadonlySet<string>,
					existingProviderContent: { commentsWithText: Set<string>; threadsWithText: Set<string> },
				) => Promise<string[]>;
			}).appendNotificationSyntheticContext.bind(runtime);
			const includedIds = await appendNotificationSyntheticContext(
				fakeBotDocument(),
				"run-notification-prune",
				[
					{
						id: "ntf_old",
						type: "comment_created",
						deliveryReasons: ["mention"],
						sourceObjectId: "cmt_old",
						actor: { username: "u/old" },
						comment: { id: "cmt_old", threadId: "thr_old", text: "Old text " + "x".repeat(400) },
					},
					{
						id: "ntf_new",
						type: "comment_created",
						deliveryReasons: ["mention"],
						sourceObjectId: "cmt_new",
						actor: { username: "u/new" },
						comment: { id: "cmt_new", threadId: "thr_new", text: "Newest notification text stays whole." },
					},
				],
				new Set(["new"]),
				{ commentsWithText: new Set<string>(), threadsWithText: new Set<string>() },
			);

			expect(includedIds).toEqual(["ntf_new"]);
			const checkNotificationResult = appendedMessages.find((message) => message.role === "tool");
			expect(JSON.parse(String(checkNotificationResult?.content))).toMatchObject({
				events: [{ actor: "u/new" }],
			});
		});

	it("rejects translation without auth, configured model, or parseable provider JSON", async () => {
		const unauthorized = await translateText(
			contextFor<typeof translateText>(
				jsonRequest("http://example.com/api/me/translate", "POST", { text: "Hello." }),
			),
		);
		expect(unauthorized.status).toBe(401);

		const cookie = await authCookie();
		const missingModel = await translateText(
			contextFor<typeof translateText>(
				jsonRequest("http://example.com/api/me/translate", "POST", { text: "Hello." }, cookie),
			),
		);
		expect(missingModel.status).toBe(400);

		await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest(
					"http://example.com/api/me/profile",
					"PATCH",
					{
						inferenceSettings: {
							openRouterApiKey: "sk-or-translation-secret",
							translation: {
								model: "openai/gpt-4o-mini",
							},
						},
					},
					cookie,
				),
			),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				choices: [{ message: { content: "not json" } }],
			}),
		);
		try {
			const malformed = await translateText(
				contextFor<typeof translateText>(
					jsonRequest("http://example.com/api/me/translate", "POST", { text: "Hello." }, cookie),
				),
			);
			expect(malformed.status).toBe(502);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
