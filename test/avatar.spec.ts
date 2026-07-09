import {
	agentRuntimeWorker,
	applyUserAvatarRoute,
	applyWorldAvatarRoute,
	authCookie,
	authCookieFor,
	avatarDataUrl,
	backfillInferredCloneSources,
	base64String,
	botById,
	botPublicProfileByHandle,
	chirperPreview,
	contextFor,
	createBot,
	createBotForTest,
	createBotInWorld,
	createForumForTest,
	createThreadForTest,
	createWorld,
	createWorldForTest,
	customProviderBaseUrl,
	defaultAvatarImageGenerationSettings,
	deleteBot,
	deleteBotAvatarRoute,
	deleteUserAvatarRoute,
	describe,
	effectiveProviderSettingsForBot,
	expect,
	fakeR2Bucket,
	forumThreads,
	generateUserAvatarRoute,
	generateWorldAvatarRoute,
	getHumanProfile,
	handleAgentRuntimeRequest,
	it,
	jpegAvatarBytes,
	jsonRequest,
	kvKeys,
	largePngAvatarBytes,
	listUserBots,
	localizedText,
	localizedTextString,
	lt,
	neverStream,
	openRouterImageModelsRoute,
	parseJsonSseEvents,
	patchBot,
	patchBotInferenceForTest,
	patchProfile,
	patchWorld,
	pause,
	pngAvatarBytes,
	promptUserAvatarRoute,
	promptWorldAvatarRoute,
	rawBotById,
	relinkBotCloneRoute,
	seedWorld,
	serviceGetRequest,
	serviceJsonRequest,
	serviceStreamJsonRequest,
	sseStream,
	storeAvatarImage,
	svgAvatarBytes,
	testEnv,
	testLanguage,
	unlinkBotCloneRoute,
	unsafeSvgAvatarBytes,
	unspecifiedLt,
	updateBotAvatar,
	updateBotAvatarCrop,
	updateUserAvatar,
	updateUserAvatarCropRoute,
	updateUserProfile,
	uploadBotAvatar,
	uploadUserAvatarRoute,
	userById,
	userIdForHandle,
	vi,
	webpAvatarBytes,
} from "./helpers/index-harness";
import type {
	AppEnv,
	AvatarCrop,
	AvatarImage,
	BotBody,
	BotDocument,
	HumanProfile,
	LanguageTag,
	LocalizedText,
	UserProfile,
} from "./helpers/index-harness";

describe("Avatar", () => {

	it("uploads participant avatars into R2 and exposes avatar URLs through indexes", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatars");
		const bot = await createBotForTest(cookie, "avatar-owner");
		const r2 = fakeR2Bucket();
		const sourceUrl = "https://images.example/avatar.png";
		const sourceBytes = pngAvatarBytes();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe(sourceUrl);
				return new Response(sourceBytes, {
					headers: {
						"content-type": "image/png",
						"content-length": String(sourceBytes.byteLength),
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let avatarUrl = "";
		try {
			const response = await uploadBotAvatar(
				contextFor<typeof uploadBotAvatar>(
					jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar`, "PUT", { url: sourceUrl }, cookie),
					{ botId: bot.id },
					{
						BICKR_R2: r2.bucket,
						BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					},
				),
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { bot: BotBody } };
			avatarUrl = body.data.bot.avatarUrl ?? "";
			expect(avatarUrl).toMatch(/^https:\/\/assets-test\.bickr\.social\/worlds\/.+\/bots\/.+\/avatars\/.+\.png$/);
			expect(r2.objects.size).toBe(1);
			const stored = [...r2.objects.values()][0];
			expect(stored?.bytes).toEqual(sourceBytes);
			expect(stored?.httpMetadata?.contentType).toBe("image/png");
			expect(stored?.httpMetadata?.cacheControl).toBe("public, max-age=31536000, immutable");
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM bots_index WHERE bot_id = ?`)
			.bind(bot.id)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(indexed?.avatarUrl).toBe(avatarUrl);
		expect(indexed?.avatarCrop).toBeNull();

		const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(storedBot.avatar).toMatchObject({
			url: avatarUrl,
			contentType: "image/png",
			width: 1,
			height: 1,
			source: {
				type: "remote_url",
				sourceUrl,
			},
		});
		expect(storedBot.avatar?.crop).toBeUndefined();

		await createThreadForTest(forum.id, bot.id, "Avatar index thread", "Avatar summary body.");
		const threadsResponse = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/${forum.handle}/threads`),
				{ worldHandle: "patch-notes", forumHandle: forum.handle },
			),
		);
		const threadsBody = (await threadsResponse.json()) as {
			data: { threads: Array<{ authorAvatarUrl?: string }> };
		};
		expect(threadsBody.data.threads[0]?.authorAvatarUrl).toBe(avatarUrl);
	});

	it("saves participant avatar crop metadata and clears it on replacement upload", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-crops");
		const bot = await createBotForTest(cookie, "avatar-cropper");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const publicBaseUrl = "https://assets-test.bickr.social";
		const avatar = await storeAvatarImage(r2.bucket, {
			botId: bot.id,
			worldId: bot.homeWorldId,
			bytes: svgAvatarBytes(),
			contentType: "image/svg+xml",
			publicBaseUrl,
		});
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, avatar);

		const crop: AvatarCrop = { x: 4, y: 8, size: 16, imageWidth: 24, imageHeight: 32 };
		const response = await updateBotAvatarCrop(
			contextFor<typeof updateBotAvatarCrop>(
				jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar/crop`, "PATCH", { crop }, cookie),
				{ botId: bot.id },
			),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		const body = (await response.json()) as { data: { bot: BotBody } };
		expect(body.data.bot.avatarCrop).toEqual(crop);
		expect(body.data.bot.avatar?.crop).toEqual(crop);

		const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(storedBot.avatar?.crop).toEqual(crop);
		const publicProfile = await botPublicProfileByHandle(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.homeWorldId, bot.handle);
		expect(publicProfile.avatarCrop).toEqual(crop);
		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_crop AS avatarCrop FROM bots_index WHERE bot_id = ?`)
			.bind(bot.id)
			.first<{ avatarCrop: string | null }>();
		expect(JSON.parse(indexed?.avatarCrop ?? "{}")).toEqual(crop);

		await createThreadForTest(forum.id, bot.id, "Cropped avatar index thread", "Avatar crop summary body.");
		const threadsResponse = await forumThreads(
			contextFor<typeof forumThreads>(
				new Request(`http://example.com/api/worlds/patch-notes/forums/${forum.handle}/threads`),
				{ worldHandle: "patch-notes", forumHandle: forum.handle },
			),
		);
		const threadsBody = (await threadsResponse.json()) as {
			data: { threads: Array<{ authorAvatarCrop?: AvatarCrop }> };
		};
		expect(threadsBody.data.threads[0]?.authorAvatarCrop).toEqual(crop);

		const otherCookie = await authCookieFor({ subject: "222", login: "not-owner", displayName: "Not Owner" });
		const forbidden = await updateBotAvatarCrop(
			contextFor<typeof updateBotAvatarCrop>(
				jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar/crop`, "PATCH", { crop }, otherCookie),
				{ botId: bot.id },
			),
		);
		expect(forbidden.status).toBe(403);

		const invalid = await updateBotAvatarCrop(
			contextFor<typeof updateBotAvatarCrop>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}/avatar/crop`,
					"PATCH",
					{ crop: { x: 20, y: 8, size: 16, imageWidth: 24, imageHeight: 32 } },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(invalid.status).toBe(400);

		const sourceUrl = "https://images.example/replacement.png";
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", vi.fn(async () =>
			new Response(pngAvatarBytes(), {
				headers: {
					"content-type": "image/png",
					"content-length": String(pngAvatarBytes().byteLength),
				},
			}),
		));
		try {
			const uploadResponse = await uploadBotAvatar(
				contextFor<typeof uploadBotAvatar>(
					jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar`, "PUT", { url: sourceUrl }, cookie),
					{ botId: bot.id },
					{
						BICKR_R2: r2.bucket,
						BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
					},
				),
			);
			expect(uploadResponse.status).toBe(200);
			const uploadBody = (await uploadResponse.json()) as { data: { bot: BotBody } };
			expect(uploadBody.data.bot.avatarCrop).toBeUndefined();
			expect(uploadBody.data.bot.avatar?.crop).toBeUndefined();
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
		const replacedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(replacedBot.avatar?.crop).toBeUndefined();
		const replacedIndexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_crop AS avatarCrop FROM bots_index WHERE bot_id = ?`)
			.bind(bot.id)
			.first<{ avatarCrop: string | null }>();
		expect(replacedIndexed?.avatarCrop).toBeNull();
	});

	it("rejects avatar crop metadata when the participant has no avatar", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-cropless");
		const response = await updateBotAvatarCrop(
			contextFor<typeof updateBotAvatarCrop>(
				jsonRequest(
					`http://example.com/api/me/bots/${bot.id}/avatar/crop`,
					"PATCH",
					{ crop: { x: 0, y: 0, size: 1, imageWidth: 1, imageHeight: 1 } },
					cookie,
				),
				{ botId: bot.id },
			),
		);
		expect(response.status).toBe(400);
	});

	it("uploads human user avatars into R2 and exposes avatar URLs through indexes", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const sourceUrl = "https://images.example/human-avatar.png";
		const sourceBytes = pngAvatarBytes();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe(sourceUrl);
				return new Response(sourceBytes, {
					headers: {
						"content-type": "image/png",
						"content-length": String(sourceBytes.byteLength),
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let avatarUrl = "";
		try {
			const response = await uploadUserAvatarRoute(
				contextFor<typeof uploadUserAvatarRoute>(
					jsonRequest("http://example.com/api/me/avatar", "PUT", { url: sourceUrl }, cookie),
					{},
					{
						BICKR_R2: r2.bucket,
						BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					},
				),
			);
			expect(response.status, await response.clone().text()).toBe(200);
			const body = (await response.json()) as { data: { profile: UserProfile } };
			avatarUrl = body.data.profile.avatarUrl ?? "";
			expect(avatarUrl).toMatch(new RegExp(`^https://assets-test\\.bickr\\.social/users/${userId}/avatars/.+\\.png$`));
			expect(body.data.profile.avatar?.url).toBe(avatarUrl);
			expect(body.data.profile.avatar?.crop).toBeUndefined();
			expect(r2.objects.size).toBe(1);
			const stored = [...r2.objects.values()][0];
			expect(stored?.bytes).toEqual(sourceBytes);
			expect(stored?.httpMetadata?.contentType).toBe("image/png");
			expect(stored?.httpMetadata?.cacheControl).toBe("public, max-age=31536000, immutable");
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM users_index WHERE user_id = ?`)
			.bind(userId)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(indexed?.avatarUrl).toBe(avatarUrl);
		expect(indexed?.avatarCrop).toBeNull();

		const storedUser = await userById(testEnv.BICKR_KV, userId);
		expect(storedUser.avatar).toMatchObject({
			url: avatarUrl,
			contentType: "image/png",
			width: 1,
			height: 1,
			source: {
				type: "remote_url",
				sourceUrl,
			},
		});

		const publicResponse = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/octocat", { headers: { cookie } }),
				{ humanHandle: "octocat" },
			),
		);
		expect(publicResponse.status).toBe(200);
		const publicBody = (await publicResponse.json()) as { data: { profile: HumanProfile } };
		expect(publicBody.data.profile.user.avatarUrl).toBe(avatarUrl);
		expect(publicBody.data.profile.user.avatarCrop).toBeUndefined();
	});

	it("saves human user avatar crop metadata and clears it on delete", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const publicBaseUrl = "https://assets-test.bickr.social";
		const avatar = await storeAvatarImage(r2.bucket, {
			target: "user",
			userId,
			bytes: svgAvatarBytes(),
			contentType: "image/svg+xml",
			publicBaseUrl,
		});
		await updateUserAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, userId, avatar);

		const crop: AvatarCrop = { x: 4, y: 8, size: 16, imageWidth: 24, imageHeight: 32 };
		const cropResponse = await updateUserAvatarCropRoute(
			contextFor<typeof updateUserAvatarCropRoute>(
				jsonRequest("http://example.com/api/me/avatar/crop", "PATCH", { crop }, cookie),
			),
		);
		expect(cropResponse.status, await cropResponse.clone().text()).toBe(200);
		const cropBody = (await cropResponse.json()) as { data: { profile: UserProfile } };
		expect(cropBody.data.profile.avatarUrl).toBe(avatar.url);
		expect(cropBody.data.profile.avatarCrop).toEqual(crop);
		expect(cropBody.data.profile.avatar?.crop).toEqual(crop);

		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM users_index WHERE user_id = ?`)
			.bind(userId)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(indexed?.avatarUrl).toBe(avatar.url);
		expect(JSON.parse(indexed?.avatarCrop ?? "{}")).toEqual(crop);
		expect((await userById(testEnv.BICKR_KV, userId)).avatar?.crop).toEqual(crop);

		const publicResponse = await getHumanProfile(
			contextFor<typeof getHumanProfile>(
				new Request("http://example.com/api/humans/octocat", { headers: { cookie } }),
				{ humanHandle: "octocat" },
			),
		);
		const publicBody = (await publicResponse.json()) as { data: { profile: HumanProfile } };
		expect(publicBody.data.profile.user.avatarUrl).toBe(avatar.url);
		expect(publicBody.data.profile.user.avatarCrop).toEqual(crop);

		const deleteResponse = await deleteUserAvatarRoute(
			contextFor<typeof deleteUserAvatarRoute>(
				new Request("http://example.com/api/me/avatar", {
					method: "DELETE",
					headers: { cookie },
				}),
			),
		);
		expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(200);
		const deleteBody = (await deleteResponse.json()) as { data: { profile: UserProfile } };
		expect(deleteBody.data.profile.avatar).toBeUndefined();
		expect(deleteBody.data.profile.avatarUrl).toBeUndefined();
		expect(deleteBody.data.profile.avatarCrop).toBeUndefined();

		const deletedIndexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM users_index WHERE user_id = ?`)
			.bind(userId)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(deletedIndexed?.avatarUrl).toBeNull();
		expect(deletedIndexed?.avatarCrop).toBeNull();
		expect((await userById(testEnv.BICKR_KV, userId)).avatar).toBeUndefined();
	});

	it("rejects direct human profile avatar URL edits", async () => {
		const cookie = await authCookie();
		const response = await patchProfile(
			contextFor<typeof patchProfile>(
				jsonRequest("http://example.com/api/me/profile", "PATCH", { avatarUrl: "https://example.com/avatar.png" }, cookie),
			),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { message: string };
		expect(body.message).toContain("profile avatar endpoints");
	});

	it("creates and applies generated human user avatar candidates with profile settings", async () => {
		await authCookie();
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const publicBaseUrl = "https://assets-test.bickr.social";
		const existingAvatar = await storeAvatarImage(r2.bucket, {
			target: "user",
			userId,
			bytes: pngAvatarBytes(),
			contentType: "image/png",
			publicBaseUrl,
		});
		await updateUserAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, userId, {
			...existingAvatar,
			crop: { x: 0, y: 0, size: 1, imageWidth: 1, imageHeight: 1 },
		});

		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				const url = String(input);
				if (url === "https://openrouter.ai/api/v1/images/models") {
					return Response.json({
						data: [
							{
								id: "openai/image-one",
								architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
							},
						],
					});
				}
				if (url === "https://openrouter.ai/api/v1/chat/completions") {
					const requestBody = JSON.parse(String(init?.body)) as {
						model?: string;
						modalities?: string[];
						messages?: Array<{ role: string; content: unknown }>;
					};
					expect(requestBody.model).toBe("openai/image-one");
					expect(requestBody.modalities).toEqual(["text"]);
					expect(JSON.stringify(requestBody.messages)).toContain(existingAvatar.url);
					return Response.json({
						choices: [{ message: { content: "A precise visual prompt from the current avatar." } }],
					});
				}
				expect(url).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					aspect_ratio?: string;
					size?: string;
					provider?: Record<string, unknown>;
					prompt?: string;
				};
				expect(requestBody.model).toBe("openai/image-one");
				expect(requestBody.aspect_ratio).toBe("1:1");
				expect(requestBody.size).toBe("2K");
				expect(requestBody.provider).toEqual({ sort: "price" });
				expect(requestBody.prompt).toContain("Paint my profile avatar.");
				return Response.json({
					data: [{ b64_json: base64String(pngAvatarBytes()) }],
					usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, cost: 0.045 },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let candidate: AvatarImage;
		try {
			const promptResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/avatar/prompt`,
					userId,
					{ mode: "current_avatar", settings: { model: "openai/image-one" } },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(promptResponse.status).toBe(200);
			const promptBody = (await promptResponse.json()) as { data: { prompt: string } };
			expect(promptBody.data.prompt).toBe("A precise visual prompt from the current avatar.");

			const personaResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/avatar/prompt`,
					userId,
					{ mode: "persona", settings: { model: "openai/image-one" } },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(personaResponse.status).toBe(400);
			const personaBody = (await personaResponse.json()) as { message: string };
			expect(personaBody.message).toContain("only supports the current avatar");

			const generateResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/avatar/generate`,
					userId,
					{
						prompt: "Paint my profile avatar.",
						includeCurrentAvatar: false,
						settings: {
							model: "openai/image-one",
							providerRouting: { sort: "price" },
							aspectRatio: "1:1",
							imageSize: "2K",
						},
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(generateResponse.status, await generateResponse.clone().text()).toBe(200);
			const generateBody = (await generateResponse.json()) as { data: { candidate: AvatarImage } };
			candidate = generateBody.data.candidate;
			expect(candidate.key).toMatch(new RegExp(`^users/${userId}/avatar-candidates/.+\\.png$`));
			expect(candidate.url).toContain(`/users/${userId}/avatar-candidates/`);
			expect(candidate.source).toMatchObject({
				type: "generated",
				model: "openai/image-one",
				prompt: "Paint my profile avatar.",
				cost: 0.045,
			});
			expect(r2.objects.has(candidate.key)).toBe(true);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const applyResponse = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/avatar/apply`,
				userId,
				{
					candidate,
					settings: {
						model: "openai/image-one",
						prompt: "Paint my profile avatar.",
						aspectRatio: "4:5",
						imageSize: "2K",
					},
				},
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: r2.bucket,
				BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
			},
		);
		expect(applyResponse.status, await applyResponse.clone().text()).toBe(200);
		const applyBody = (await applyResponse.json()) as { data: { profile: UserProfile } };
		expect(applyBody.data.profile.avatarUrl).toContain(`/users/${userId}/avatars/`);
		expect(applyBody.data.profile.avatarCrop).toBeUndefined();
		expect(r2.objects.has(candidate.key)).toBe(false);

		const storedUser = await userById(testEnv.BICKR_KV, userId);
		expect(storedUser.avatar?.url).toBe(applyBody.data.profile.avatarUrl);
		expect(storedUser.avatar?.source).toMatchObject({ type: "generated", cost: 0.045 });
		expect(storedUser.avatar?.crop).toBeUndefined();
		expect(storedUser.inferenceSettings?.imageGeneration).toMatchObject({
			model: "openai/image-one",
			prompt: unspecifiedLt("Paint my profile avatar."),
			aspectRatio: "4:5",
			imageSize: "2K",
		});
	});

	it("inherits avatar objects and generation metadata when cloning participants across worlds", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, "avatar-clone-source");
		const sourceDocument = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id);
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const publicBaseUrl = "https://assets-test.bickr.social";
		const sourceBytes = pngAvatarBytes();
		const sourceAvatar = await storeAvatarImage(r2.bucket, {
			botId: sourceDocument.id,
			worldId: sourceDocument.homeWorldId,
			bytes: sourceBytes,
			contentType: "image/png",
			publicBaseUrl,
			source: {
				type: "generated",
				model: "openai/image-one",
				generatedAt: "2026-05-10T00:00:00.000Z",
				cost: 0.0123,
				prompt: "Paint me as a luminous portrait.",
			},
		});
		const sourceCrop: AvatarCrop = { x: 0, y: 0, size: 1, imageWidth: 1, imageHeight: 1 };
		const sourceAvatarWithCrop = { ...sourceAvatar, crop: sourceCrop };
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id, userId, sourceAvatarWithCrop);

		const worldResponse = await createWorld(
			contextFor<typeof createWorld>(
				jsonRequest(
					"http://example.com/api/worlds",
					"POST",
					{ handle: "avatar-clones", name: "Avatar Clones", description: "Cloned avatar checks." },
					cookie,
				),
			),
		);
		expect(worldResponse.status).toBe(201);

		const cloneResponse = await createBot(
			contextFor<typeof createBot>(
				jsonRequest(
					"http://example.com/api/worlds/avatar-clones/bots",
					"POST",
					{
						handle: "avatar-clone",
						displayName: "Avatar Clone",
						shortBio: "A participant cloned with an avatar.",
						prompt: "Continue the source persona.",
						cloneSourceBotId: source.id,
					},
					cookie,
				),
				{ worldHandle: "avatar-clones" },
				{
					AGENT_RUNTIME: {
						fetch: async (serviceRequest: Request) =>
							handleAgentRuntimeRequest(serviceRequest, {
								BICKR_D1: testEnv.BICKR_D1,
								BICKR_KV: testEnv.BICKR_KV,
								BICKR_R2: r2.bucket,
								BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
							}),
					} as unknown as Fetcher,
				},
			),
		);
		expect(cloneResponse.status, await cloneResponse.clone().text()).toBe(201);
		const cloneBody = (await cloneResponse.json()) as { data: { bot: BotBody } };
		expect(cloneBody.data.bot.avatarUrl).toMatch(/^https:\/\/assets-test\.bickr\.social\/worlds\/.+\/bots\/.+\/avatars\/.+\.png$/);
		expect(cloneBody.data.bot.avatarUrl).toBe(sourceAvatar.url);
		expect(cloneBody.data.bot.avatarCrop).toEqual(sourceCrop);
		expect(cloneBody.data.bot.cloneSource).toMatchObject({
			sourceBotId: source.id,
			sourceHandle: source.handle,
			sourceWorldHandle: source.homeWorldHandle,
			linked: true,
		});
		expect(cloneBody.data.bot.localOverrides).toMatchObject({
			hasAvatar: false,
			displayName: lt("Avatar Clone"),
			shortBio: lt("A participant cloned with an avatar."),
			prompt: lt("Continue the source persona."),
		});

		const rawStoredClone = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, cloneBody.data.bot.id);
		expect(rawStoredClone.avatar).toBeUndefined();
		const storedClone = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, cloneBody.data.bot.id);
		expect(storedClone.avatar?.key).toBe(sourceAvatar.key);
		expect(storedClone.avatar?.url).toBe(cloneBody.data.bot.avatarUrl);
		expect(storedClone.avatar?.crop).toEqual(sourceCrop);
		expect(storedClone.avatar?.source).toMatchObject({
			type: "generated",
			model: "openai/image-one",
			generatedAt: "2026-05-10T00:00:00.000Z",
			cost: 0.0123,
			prompt: "Paint me as a luminous portrait.",
		});
		const indexed = await testEnv.BICKR_D1.prepare(`SELECT avatar_url AS avatarUrl, avatar_crop AS avatarCrop FROM bots_index WHERE bot_id = ?`)
			.bind(storedClone.id)
			.first<{ avatarUrl: string | null; avatarCrop: string | null }>();
		expect(indexed?.avatarUrl).toBe(storedClone.avatar?.url);
		expect(JSON.parse(indexed?.avatarCrop ?? "{}")).toEqual(sourceCrop);
		expect(r2.objects.size).toBe(1);
	});

	it("stores clone provenance and cascades profile and inference values through clone chains", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const ar = "ar" as LanguageTag;
		const ja = "ja" as LanguageTag;
		const source = await createBotInWorld(cookie, "patch-notes", {
			handle: "clone-source",
			language: ar,
			displayName: localizedText("Clone Source", ar),
			shortBio: localizedText("Source bio.", ar),
			prompt: localizedText("Source prompt.", ar),
		});
		const patchedSource = await patchBotInferenceForTest(
			cookie,
			source.id,
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "source/model",
				temperature: 0.33,
				compactionMode: "tool_call",
			},
			ar,
		);
		expect(patchedSource.inferenceSettings).toMatchObject({
			baseUrl: "https://openrouter.ai/api/v1",
			model: "source/model",
			temperature: 0.33,
			compactionMode: "tool_call",
		});
		await createWorldForTest(cookie, "clone-middle-world", "Clone Middle World");
		await createWorldForTest(cookie, "clone-leaf-world", "Clone Leaf World");

		const middle = await createBotInWorld(cookie, "clone-middle-world", {
			handle: "clone-middle",
			language: null,
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: source.id,
		});
		expect(middle.language).toBe(ar);
		expect(middle.includeLanguageInSystemPrompt).toBe(true);
		expect(middle.displayName).toStrictEqual(source.displayName);
		expect(middle.shortBio).toStrictEqual(source.shortBio);
		expect(middle.prompt).toStrictEqual(source.prompt);
		expect(middle.cloneSource).toMatchObject({
			sourceBotId: source.id,
			sourceHandle: source.handle,
			sourceWorldHandle: source.homeWorldHandle,
			linked: true,
		});
		expect(middle.localOverrides).toMatchObject({
			language: null,
			includeLanguageInSystemPrompt: null,
			displayName: localizedText("", null),
			shortBio: localizedText("", null),
			prompt: localizedText("", null),
			inferenceSettings: {},
			hasAvatar: false,
		});
		const blankLanguageSaveResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${middle.id}`,
					"PATCH",
					{
						language: null,
						includeLanguageInSystemPrompt: null,
						displayName: "",
						shortBio: "",
						prompt: "",
					},
					cookie,
				),
				{ botId: middle.id },
			),
		);
		expect(blankLanguageSaveResponse.status, await blankLanguageSaveResponse.clone().text()).toBe(200);
		const rawMiddleAfterBlankLanguageSave = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, middle.id);
		expect(rawMiddleAfterBlankLanguageSave.language).toBe(null);
		expect(rawMiddleAfterBlankLanguageSave.includeLanguageInSystemPrompt).toBe(null);
		expect(rawMiddleAfterBlankLanguageSave.displayName).toStrictEqual(localizedText("", null));
		expect(rawMiddleAfterBlankLanguageSave.shortBio).toStrictEqual(localizedText("", null));
		expect(rawMiddleAfterBlankLanguageSave.prompt).toStrictEqual(localizedText("", null));
		expect(middle.inferenceSettings).toMatchObject({
			model: "source/model",
			temperature: 0.33,
			compactionMode: "tool_call",
		});

		const leaf = await createBotInWorld(cookie, "clone-leaf-world", {
			handle: "clone-leaf",
			language: null,
			includeLanguageInSystemPrompt: false,
			displayName: "",
			shortBio: "Leaf override",
			prompt: "",
			cloneSourceBotId: middle.id,
		});
		expect(leaf.language).toBe(ar);
		expect(leaf.includeLanguageInSystemPrompt).toBe(false);
		expect(leaf.displayName).toStrictEqual(source.displayName);
		expect(leaf.shortBio).toStrictEqual(localizedText("Leaf override", ar));
		expect(leaf.prompt).toStrictEqual(source.prompt);
		expect(leaf.inferenceSettings).toMatchObject({
			model: "source/model",
			temperature: 0.33,
			compactionMode: "tool_call",
		});
		const listedIds = (await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, await userIdForHandle("octocat")))
			.map((bot) => bot.id);
		expect(listedIds).toEqual(expect.arrayContaining([source.id, middle.id, leaf.id]));

		const sourcePatchResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${source.id}`,
					"PATCH",
					{
						language: ja,
						includeLanguageInSystemPrompt: false,
						displayName: "Clone Source Updated",
						prompt: "Updated source prompt.",
						inferenceSettings: {
							baseUrl: "https://openrouter.ai/api/v1",
							model: "source/updated",
							temperature: 0.55,
						},
					},
					cookie,
				),
				{ botId: source.id },
			),
		);
		expect(sourcePatchResponse.status).toBe(200);
		const patchPayload = (await sourcePatchResponse.json()) as { data: { bot: BotBody; affectedBots: BotBody[] } };
		expect(patchPayload.data.bot.language).toBe(ja);
		expect(patchPayload.data.bot.includeLanguageInSystemPrompt).toBe(false);
		expect(patchPayload.data.affectedBots.map((bot) => bot.id).sort()).toEqual([leaf.id, middle.id].sort());
		const effectiveMiddle = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, middle.id);
		const effectiveLeaf = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, leaf.id);
		expect(effectiveMiddle.language).toBe(ja);
		expect(effectiveMiddle.includeLanguageInSystemPrompt).toBe(false);
		expect(effectiveMiddle.displayName).toStrictEqual(localizedText("Clone Source Updated", ja));
		expect(effectiveMiddle.prompt).toStrictEqual(localizedText("Updated source prompt.", ja));
		expect(effectiveLeaf.language).toBe(ja);
		expect(effectiveLeaf.includeLanguageInSystemPrompt).toBe(false);
		expect(effectiveLeaf.displayName).toStrictEqual(localizedText("Clone Source Updated", ja));
		expect(effectiveLeaf.shortBio).toStrictEqual(localizedText("Leaf override", ja));
		expect(effectiveLeaf.inferenceSettings).toMatchObject({
			model: "source/updated",
			temperature: 0.55,
		});

		const leafOverrideResponse = await patchBot(
			contextFor<typeof patchBot>(
				jsonRequest(
					`http://example.com/api/me/bots/${leaf.id}`,
					"PATCH",
					{ includeLanguageInSystemPrompt: true },
					cookie,
				),
				{ botId: leaf.id },
			),
		);
		expect(leafOverrideResponse.status, await leafOverrideResponse.clone().text()).toBe(200);
		const leafOverridePayload = (await leafOverrideResponse.json()) as { data: { bot: BotBody } };
		expect(leafOverridePayload.data.bot.includeLanguageInSystemPrompt).toBe(true);
		const rawLeafOverride = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, leaf.id);
		expect(rawLeafOverride.includeLanguageInSystemPrompt).toBe(true);
	});

	it("normalizes missing language system prompt setting to false for existing non-clones", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "legacy-language-setting");
		const raw = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		const legacyRaw = { ...raw } as Partial<BotDocument>;
		delete legacyRaw.includeLanguageInSystemPrompt;
		await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify(legacyRaw));

		expect((await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id)).includeLanguageInSystemPrompt).toBe(null);
		expect((await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id)).includeLanguageInSystemPrompt).toBe(false);
	});

	it("falls through linked clone inference chains to owner defaults after source defaults", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		await updateUserProfile(testEnv.BICKR_KV, testEnv.BICKR_D1, userId, {
			inferenceSettings: {
				openRouterApiKey: "sk-or-chain-owner",
				model: "owner/model",
				compactionMode: "tool_call_cache_friendly",
				temperature: 0.77,
			},
		});
		const source = await createBotForTest(cookie, "clone-owner-fallback-source");
		await patchBotInferenceForTest(cookie, source.id, {
			compactionMode: "tool_call",
			temperature: 0.42,
		});
		await createWorldForTest(cookie, "clone-owner-fallback-middle", "Clone Owner Fallback Middle");
		await createWorldForTest(cookie, "clone-owner-fallback-leaf", "Clone Owner Fallback Leaf");

		const middle = await createBotInWorld(cookie, "clone-owner-fallback-middle", {
			handle: "clone-owner-fallback-middle",
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: source.id,
		});
		const leaf = await createBotInWorld(cookie, "clone-owner-fallback-leaf", {
			handle: "clone-owner-fallback-leaf",
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: middle.id,
		});

		const owner = await userById(testEnv.BICKR_KV, userId);
		const effectiveLeaf = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, leaf.id);
		expect(effectiveLeaf.inferenceSettings.model).toBeUndefined();
		const settings = effectiveProviderSettingsForBot(effectiveLeaf, owner, {});
		expect(settings).toMatchObject({
			apiKey: "sk-or-chain-owner",
			compactionMode: "tool_call",
			model: "owner/model",
			temperature: 0.42,
		});
	});

	it("unlinks and relinks clones while preserving provenance and delete blocking", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, "unlink-source");
		await createWorldForTest(cookie, "unlink-clones", "Unlink Clones");
		const clone = await createBotInWorld(cookie, "unlink-clones", {
			handle: "unlink-clone",
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: source.id,
		});

		const blockedDelete = await deleteBot(
			contextFor<typeof deleteBot>(
				jsonRequest(`http://example.com/api/me/bots/${source.id}`, "DELETE", undefined, cookie),
				{ botId: source.id },
			),
		);
		expect(blockedDelete.status).toBe(409);

		const unlinkResponse = await unlinkBotCloneRoute(
			contextFor<typeof unlinkBotCloneRoute>(
				jsonRequest(`http://example.com/api/me/bots/${clone.id}/clone/unlink`, "POST", {}, cookie),
				{ botId: clone.id },
			),
		);
		expect(unlinkResponse.status, await unlinkResponse.clone().text()).toBe(200);
		const unlinked = (await unlinkResponse.json()) as { data: { bot: BotBody } };
		expect(unlinked.data.bot.cloneSource).toMatchObject({ sourceBotId: source.id, linked: false });
		const rawUnlinked = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id);
		expect(rawUnlinked.includeLanguageInSystemPrompt).toBe(source.includeLanguageInSystemPrompt);
		expect(rawUnlinked.displayName).toStrictEqual(source.displayName);
		expect(rawUnlinked.prompt).toStrictEqual(source.prompt);

		const relinkResponse = await relinkBotCloneRoute(
			contextFor<typeof relinkBotCloneRoute>(
				jsonRequest(`http://example.com/api/me/bots/${clone.id}/clone/relink`, "POST", {}, cookie),
				{ botId: clone.id },
			),
		);
		expect(relinkResponse.status, await relinkResponse.clone().text()).toBe(200);
		const rawRelinked = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id);
		expect(rawRelinked.includeLanguageInSystemPrompt).toBe(null);
		expect(rawRelinked.displayName).toStrictEqual(lt(""));
		expect(rawRelinked.prompt).toStrictEqual(lt(""));
		expect((await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id)).cloneSource).toMatchObject({
			sourceBotId: source.id,
			linked: true,
		});

		const unlinkAgain = await unlinkBotCloneRoute(
			contextFor<typeof unlinkBotCloneRoute>(
				jsonRequest(`http://example.com/api/me/bots/${clone.id}/clone/unlink`, "POST", {}, cookie),
				{ botId: clone.id },
			),
		);
		expect(unlinkAgain.status).toBe(200);
		const allowedDelete = await deleteBot(
			contextFor<typeof deleteBot>(
				jsonRequest(`http://example.com/api/me/bots/${source.id}`, "DELETE", undefined, cookie),
				{ botId: source.id },
			),
		);
		expect(allowedDelete.status).toBe(200);
	});

	it("deleting a local clone avatar falls back to the source avatar", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, "avatar-fallback-source");
		const userId = await userIdForHandle("octocat");
		const now = new Date().toISOString();
		const sourceAvatar: AvatarImage = {
			contentType: "image/png",
			key: `test/${source.id}/source.png`,
			updatedAt: now,
			url: "https://assets-test.bickr.social/source.png",
		};
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id, userId, sourceAvatar, now);
		await createWorldForTest(cookie, "avatar-fallback-clones", "Avatar Fallback Clones");
		const clone = await createBotInWorld(cookie, "avatar-fallback-clones", {
			handle: "avatar-fallback-clone",
			displayName: "",
			shortBio: "",
			prompt: "",
			cloneSourceBotId: source.id,
		});
		expect(clone.avatarUrl).toBe(sourceAvatar.url);
		const localAvatar: AvatarImage = {
			contentType: "image/png",
			key: `test/${clone.id}/local.png`,
			updatedAt: now,
			url: "https://assets-test.bickr.social/local.png",
		};
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id, userId, localAvatar, now);
		expect((await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id)).avatar?.url).toBe(localAvatar.url);

		const deleteAvatarResponse = await deleteBotAvatarRoute(
			contextFor<typeof deleteBotAvatarRoute>(
				jsonRequest(`http://example.com/api/me/bots/${clone.id}/avatar`, "DELETE", undefined, cookie),
				{ botId: clone.id },
			),
		);
		expect(deleteAvatarResponse.status).toBe(200);
		const deletePayload = (await deleteAvatarResponse.json()) as { data: { bot: BotBody } };
		expect(deletePayload.data.bot.avatarUrl).toBe(sourceAvatar.url);
		expect((await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id)).avatar).toBeUndefined();
	});

	it("backfills inferred same-owner same-handle clone sources and preserves differing overrides", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, "duplicate");
		await createWorldForTest(cookie, "duplicate-world", "Duplicate World");
		const duplicate = await createBotInWorld(cookie, "duplicate-world", {
			handle: "duplicate",
			displayName: source.displayName,
			shortBio: "Different short bio",
			prompt: source.prompt,
		});

		const result = await backfillInferredCloneSources(testEnv.BICKR_KV, testEnv.BICKR_D1, "2026-05-14T00:00:00.000Z");
		expect(result).toMatchObject({ groups: 1, clonesLinked: 1, clonesSkipped: 0 });
		const rawDuplicate = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, duplicate.id);
		expect(rawDuplicate.includeLanguageInSystemPrompt).toBe(null);
		expect(rawDuplicate.displayName).toStrictEqual(lt(""));
		expect(rawDuplicate.shortBio).toStrictEqual(lt("Different short bio"));
		expect(rawDuplicate.prompt).toStrictEqual(lt(""));
		const effectiveDuplicate = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, duplicate.id);
		expect(effectiveDuplicate.includeLanguageInSystemPrompt).toBe(source.includeLanguageInSystemPrompt);
		expect(effectiveDuplicate.displayName).toStrictEqual(source.displayName);
		expect(effectiveDuplicate.shortBio).toStrictEqual(lt("Different short bio"));
		expect(effectiveDuplicate.prompt).toStrictEqual(source.prompt);
		expect(effectiveDuplicate.cloneSource).toMatchObject({
			sourceBotId: source.id,
			sourceHandle: source.handle,
			linked: true,
		});
	});

	it("uploads SVG participant avatars into R2", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-svg");
		const r2 = fakeR2Bucket();
		const sourceUrl = "https://images.example/avatar.svg";
		const sourceBytes = svgAvatarBytes();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe(sourceUrl);
				return new Response(sourceBytes, {
					headers: {
						"content-type": "image/svg+xml; charset=utf-8",
						"content-length": String(sourceBytes.byteLength),
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await uploadBotAvatar(
				contextFor<typeof uploadBotAvatar>(
					jsonRequest(`http://example.com/api/me/bots/${bot.id}/avatar`, "PUT", { url: sourceUrl }, cookie),
					{ botId: bot.id },
					{
						BICKR_R2: r2.bucket,
						BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					},
				),
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { bot: BotBody } };
			expect(body.data.bot.avatarUrl).toMatch(/^https:\/\/assets-test\.bickr\.social\/worlds\/.+\/bots\/.+\/avatars\/.+\.svg$/);
			const stored = [...r2.objects.values()][0];
			expect(stored?.bytes).toEqual(sourceBytes);
			expect(stored?.httpMetadata?.contentType).toBe("image/svg+xml");
			const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
			expect(storedBot.avatar).toMatchObject({
				contentType: "image/svg+xml",
				width: 24,
				height: 32,
				source: {
					type: "remote_url",
					sourceUrl,
				},
			});
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("rejects SVG avatar uploads with active content", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-unsafe-svg");
		const form = new FormData();
		form.set("file", new File([unsafeSvgAvatarBytes()], "avatar.svg", { type: "image/svg+xml" }));
		const response = await uploadBotAvatar(
			contextFor<typeof uploadBotAvatar>(
				new Request(`http://example.com/api/me/bots/${bot.id}/avatar`, {
					method: "PUT",
					headers: { cookie },
					body: form,
				}),
				{ botId: bot.id },
				{
					BICKR_R2: fakeR2Bucket().bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
				},
			),
		);
		expect(response.status).toBe(400);
	});

	it("rejects unsupported avatar upload file types", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-invalid");
		const form = new FormData();
		form.set("file", new File([new Uint8Array([0x47, 0x49, 0x46])], "avatar.gif", { type: "image/gif" }));
		const response = await uploadBotAvatar(
			contextFor<typeof uploadBotAvatar>(
				new Request(`http://example.com/api/me/bots/${bot.id}/avatar`, {
					method: "PUT",
					headers: { cookie },
					body: form,
				}),
				{ botId: bot.id },
				{
					BICKR_R2: fakeR2Bucket().bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
				},
			),
		);
		expect(response.status).toBe(400);
	});

	it("filters OpenRouter image-capable models and keeps image input capabilities", async () => {
		const cookie = await authCookie();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images/models");
				return Response.json({
					data: [
						{
							id: "openai/image-one",
							name: "Image One",
							architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
						},
						{
							id: "text-only",
							name: "Text Only",
							architecture: { input_modalities: ["text"], output_modalities: ["text"] },
						},
						{
							id: "image-output",
							architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] },
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await openRouterImageModelsRoute(
				contextFor<typeof openRouterImageModelsRoute>(
					new Request("http://example.com/api/openrouter/image-models", {
						headers: { cookie },
					}),
				),
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				data: {
					models: Array<{ id: string; name: string; inputModalities: string[]; outputModalities: string[] }>;
				};
			};
			expect(body.data.models).toEqual([
				{
					id: "openai/image-one",
					name: "Image One",
					inputModalities: ["text", "image"],
					outputModalities: ["image"],
				},
				{
					id: "image-output",
					name: "image-output",
					inputModalities: ["text"],
					outputModalities: ["text", "image"],
				},
			]);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("creates generated avatar candidates and promotes them explicitly", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-generated");
		const userId = await userIdForHandle("octocat");
		const blankPrompt = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
				userId,
				{ prompt: "", includeCurrentAvatar: false, settings: { model: "openai/image-one" } },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: fakeR2Bucket().bucket,
				BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
				OPENROUTER_API_KEY: "test-key",
			},
		);
		expect(blankPrompt.status).toBe(400);

		const overlongAspectRatio = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
				userId,
				{ prompt: "Paint me.", includeCurrentAvatar: false, settings: { model: "openai/image-one", aspectRatio: "x".repeat(41) } },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: fakeR2Bucket().bucket,
				BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
				OPENROUTER_API_KEY: "test-key",
			},
		);
		expect(overlongAspectRatio.status).toBe(400);
		const overlongAspectRatioBody = (await overlongAspectRatio.json()) as { ok: false; message: string };
		expect(overlongAspectRatioBody.message).toBe("Image aspect ratio must be 40 characters or fewer.");

		const r2 = fakeR2Bucket();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					aspect_ratio?: string;
					size?: string;
					provider?: Record<string, unknown>;
					prompt?: string;
				};
				if (requestBody.model === defaultAvatarImageGenerationSettings.model) {
					expect(requestBody.aspect_ratio).toBe(defaultAvatarImageGenerationSettings.aspectRatio);
					expect(requestBody.size).toBe(defaultAvatarImageGenerationSettings.imageSize);
					expect(requestBody.prompt).toContain("Paint me with defaults.");
					expect(requestBody.provider).toBeUndefined();
				} else {
					expect(requestBody.model).toBe("openai/image-one");
					expect(requestBody.aspect_ratio).toBe("12:78");
					expect(requestBody.size).toBe("custom-size");
					expect(requestBody.prompt).toContain("Paint me as a luminous portrait.");
					expect(requestBody.provider).toEqual({ sort: "price" });
				}
				return Response.json({
					data: [{ b64_json: base64String(largePngAvatarBytes()) }],
					usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, cost: 0.0123 },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let candidate: NonNullable<BotBody["avatar"]>;
		try {
			const defaultGenerateResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me with defaults.",
						includeCurrentAvatar: false,
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(defaultGenerateResponse.status).toBe(200);
			const defaultGenerateBody = (await defaultGenerateResponse.json()) as { data: { candidate: NonNullable<BotBody["avatar"]> } };
			expect(defaultGenerateBody.data.candidate.source).toMatchObject({
				type: "generated",
				model: defaultAvatarImageGenerationSettings.model,
				prompt: "Paint me with defaults.",
			});

			const generateResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me as a luminous portrait.",
						includeCurrentAvatar: false,
						settings: {
								model: "openai/image-one",
								providerRouting: { sort: "price" },
								aspectRatio: "12:78",
								imageSize: "custom-size",
							},
						},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(generateResponse.status).toBe(200);
			const generateBody = (await generateResponse.json()) as { data: { candidate: NonNullable<BotBody["avatar"]> } };
			candidate = generateBody.data.candidate;
			expect(candidate.key).toContain("/avatar-candidates/");
			expect(candidate.url).toContain("/avatar-candidates/");
			expect(candidate.source).toMatchObject({
				type: "generated",
				model: "openai/image-one",
				prompt: "Paint me as a luminous portrait.",
				cost: 0.0123,
			});
			expect(candidate.byteLength).toBeGreaterThan(1_500_000);
			expect(r2.objects.has(candidate.key)).toBe(true);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const existingAvatar = await storeAvatarImage(r2.bucket, {
			botId: bot.id,
			worldId: bot.homeWorldId,
			bytes: pngAvatarBytes(),
			contentType: "image/png",
			publicBaseUrl: "https://assets-test.bickr.social",
		});
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, {
			...existingAvatar,
			crop: { x: 0, y: 0, size: 1, imageWidth: 1, imageHeight: 1 },
		});

		const applyResponse = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/apply`,
				userId,
				{
					candidate,
					settings: {
						model: "openai/image-one",
						prompt: "Paint me as a luminous portrait.",
						aspectRatio: "1:1",
						imageSize: "2K",
					},
				},
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: r2.bucket,
				BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
			},
		);
		expect(applyResponse.status).toBe(200);
		const applyBody = (await applyResponse.json()) as { data: { bot: BotBody } };
		expect(applyBody.data.bot.avatarUrl).toContain("/avatars/");
		expect(r2.objects.has(candidate.key)).toBe(false);
		const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(storedBot.avatar?.url).toBe(applyBody.data.bot.avatarUrl);
		expect(storedBot.avatar?.source).toMatchObject({ type: "generated", cost: 0.0123 });
		expect(storedBot.avatar?.crop).toBeUndefined();
		expect(applyBody.data.bot.avatarCrop).toBeUndefined();
		expect(storedBot.inferenceSettings.imageGeneration).toMatchObject({
			model: "openai/image-one",
			prompt: lt("Paint me as a luminous portrait."),
			aspectRatio: "1:1",
			imageSize: "2K",
		});
	});

	it("streams generated avatar chat events and keeps image bytes out of the chat log", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-streamed");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const rawDataUrl = avatarDataUrl();
		const model = "openai/gpt-image-1";
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				if (String(input) === "https://openrouter.ai/api/v1/images/models") {
					return Response.json({
						data: [
							{
								id: model,
								architecture: { input_modalities: ["text"], output_modalities: ["image"] },
								supports_streaming: true,
							},
						],
					});
				}
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					stream?: boolean;
					prompt?: string;
				};
				expect(requestBody.model).toBe(model);
				expect(requestBody.stream).toBe(true);
				expect(requestBody.prompt).toContain("Bickr participant");
				expect(requestBody.prompt).toContain("Paint me as a luminous portrait.");
				return new Response(sseStream([
					{
						type: "image_generation.completed",
						b64_json: rawDataUrl.split(",", 2)[1],
						usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost: 0.045 },
					},
					"[DONE]",
				]), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me as a luminous portrait.",
						includeCurrentAvatar: false,
						settings: { model },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const streamText = await response.text();
			expect(streamText).not.toContain(rawDataUrl);
			const events = parseJsonSseEvents(streamText);
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_image", "done"]);
			expect(events[0]).toMatchObject({
				type: "messages",
				messages: [
					{ role: "system", content: expect.stringContaining("Bickr participant") },
					{ role: "user", content: "Paint me as a luminous portrait." },
				],
			});
			expect(events[1]).toEqual({ type: "assistant_image", count: 1 });
			expect(events[2]).toMatchObject({
				type: "done",
				candidate: {
					contentType: "image/png",
					source: {
						type: "generated",
						model,
						prompt: "Paint me as a luminous portrait.",
						cost: 0.045,
					},
				},
			});
			const candidate = (events[2] as { candidate: NonNullable<BotBody["avatar"]> }).candidate;
			expect(candidate.url).toContain("/avatar-candidates/");
			expect(r2.objects.has(candidate.key)).toBe(true);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("buffers upstream OpenRouter image requests for non-streaming models while streaming avatar events", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-streamed-gemini");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const model = "google/gemini-3.1-flash-image";
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				if (String(input) === "https://openrouter.ai/api/v1/images/models") {
					return Response.json({
						data: [
							{
								id: model,
								architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
								supports_streaming: false,
							},
						],
					});
				}
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					stream?: boolean;
					prompt?: string;
				};
				expect(requestBody.model).toBe(model);
				expect(requestBody.stream).toBe(false);
				expect(requestBody.prompt).toContain("Paint me as a luminous portrait.");
				return Response.json({
					data: [{ b64_json: base64String(jpegAvatarBytes()) }],
					usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12, cost: 0.034 },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me as a luminous portrait.",
						includeCurrentAvatar: false,
						settings: { model },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const events = parseJsonSseEvents(await response.text());
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_image", "done"]);
			expect(events[1]).toEqual({ type: "assistant_image", count: 1 });
			expect(events[2]).toMatchObject({
				type: "done",
				candidate: {
					contentType: "image/jpeg",
					source: {
						type: "generated",
						model,
						prompt: "Paint me as a luminous portrait.",
						cost: 0.034,
					},
				},
			});
			const candidate = (events[2] as { candidate: NonNullable<BotBody["avatar"]> }).candidate;
			expect(candidate.url).toMatch(/\/avatar-candidates\/.+\.jpg$/);
			expect(r2.objects.has(candidate.key)).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("submits the full current avatar URL to image generation even when a crop is saved", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-full-input");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const currentAvatar: AvatarImage = {
			key: "worlds/world_patch-notes/bots/bot_avatar-full-input/avatars/current.png",
			url: "https://assets-test.bickr.social/worlds/world_patch-notes/bots/bot_avatar-full-input/avatars/current.png",
			contentType: "image/png",
			width: 480,
			height: 720,
			crop: { x: 80, y: 0, size: 480, imageWidth: 480, imageHeight: 720 },
			updatedAt: "2026-05-12T00:00:00.000Z",
		};
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, currentAvatar);
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as {
					input_references?: Array<{ type?: string; image_url?: { url?: string } }>;
					stream?: boolean;
				};
				expect(requestBody.stream).toBe(false);
				const imageReference = requestBody.input_references?.find((part) => part.type === "image_url");
				expect(imageReference?.image_url?.url).toBe(currentAvatar.url);
				expect(imageReference?.image_url?.url).not.toContain("/cdn-cgi/image/");
				return Response.json({
					data: [{ b64_json: base64String(pngAvatarBytes()) }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Use my current avatar as the visual source.",
						includeCurrentAvatar: true,
						settings: { model: "openai/image-one" },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			const streamText = await response.text();
			const events = parseJsonSseEvents(streamText);
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_image", "done"]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("creates and promotes SVG generated avatar candidates", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-generated-svg");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				return Response.json({
					data: [{ b64_json: base64String(svgAvatarBytes()), media_type: "image/svg+xml" }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		let candidate: NonNullable<BotBody["avatar"]>;
		try {
			const generateResponse = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Draw me as a clean vector emblem.",
						includeCurrentAvatar: false,
						settings: { model: "openai/svg-image" },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(generateResponse.status).toBe(200);
			const generateBody = (await generateResponse.json()) as { data: { candidate: NonNullable<BotBody["avatar"]> } };
			candidate = generateBody.data.candidate;
			expect(candidate.contentType).toBe("image/svg+xml");
			expect(candidate.url).toMatch(/\/avatar-candidates\/.+\.svg$/);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}

		const applyResponse = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/apply`,
				userId,
				{ candidate },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				BICKR_R2: r2.bucket,
				BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
			},
		);
		expect(applyResponse.status).toBe(200);
		const applyBody = (await applyResponse.json()) as { data: { bot: BotBody } };
		expect(applyBody.data.bot.avatarUrl).toMatch(/\/avatars\/.+\.svg$/);
		const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(storedBot.avatar?.contentType).toBe("image/svg+xml");
	});

	it("uses the dedicated OpenRouter image endpoint for avatar generation", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-image-only");
		const userId = await userIdForHandle("octocat");
		const r2 = fakeR2Bucket();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
				const requestBody = JSON.parse(String(init?.body)) as { model?: string; modalities?: string[]; prompt?: string };
				expect(requestBody.model).toBe("image/only");
				expect(requestBody.modalities).toBeUndefined();
				expect(requestBody.prompt).toContain("Paint me as a luminous portrait.");
				return Response.json({
					data: [{ b64_json: base64String(pngAvatarBytes()) }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
					userId,
					{
						prompt: "Paint me as a luminous portrait.",
						includeCurrentAvatar: false,
						settings: { model: "image/only" },
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					BICKR_R2: r2.bucket,
					BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("prefills avatar prompts with structured output when configured", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-prefill");
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: unknown }>;
					response_format?: { json_schema?: { name?: string } };
					tools?: unknown[];
					tool_choice?: unknown;
				};
				expect(requestBody.messages).toHaveLength(2);
				expect(requestBody.response_format?.json_schema?.name).toBe("avatar_description");
				expect(requestBody.tools).toBeUndefined();
				expect(requestBody.tool_choice).toBeUndefined();
				const participantFacingText = JSON.stringify({
					message: requestBody.messages[1]?.content,
				});
				expect(participantFacingText).not.toMatch(/\b(bot|AI|assistant|agent|model)\b/i);
				return Response.json({
					choices: [
						{
							message: {
								content: [
									"I can picture it clearly.",
									JSON.stringify({
										description: "I stand in a bright studio wearing a deep green jacket, with amber rim light catching the edges of my face.",
									}),
									"That is the profile image description.",
								].join("\n"),
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toContain("deep green jacket");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("prefills avatar prompts with one forced no-history visual-description tool when configured", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const createdBot = await createBotForTest(cookie, "avatar-prefill-tool");
		const bot = await patchBotInferenceForTest(cookie, createdBot.id, { compactionMode: "tool_call" });
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: unknown }>;
					response_format?: unknown;
					tools: Array<{ function: { name: string; description: string } }>;
					tool_choice?: unknown;
				};
				expect(requestBody.messages).toHaveLength(2);
				expect(requestBody.response_format).toBeUndefined();
				expect(requestBody.tools.map((tool) => tool.function.name)).toEqual(["save_avatar_description"]);
				expect(requestBody.tool_choice).toBe("required");
				const participantFacingText = JSON.stringify({
					message: requestBody.messages[1]?.content,
					tools: requestBody.tools.map((tool) => tool.function.description),
				});
				expect(participantFacingText).not.toMatch(/\b(bot|AI|assistant|agent|model)\b/i);
				return Response.json({
					choices: [
						{
							message: {
								tool_calls: [
									{
										function: {
											name: "save_avatar_description",
											arguments: JSON.stringify({
												description: "I stand in a bright studio wearing a deep green jacket, with amber rim light catching the edges of my face.",
											}),
										},
									},
								],
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toContain("deep green jacket");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("falls back to avatar prompt tool calls when structured prefill responses are unusable", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-prefill-fallback");
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					response_format?: { json_schema?: { name?: string } };
					tools?: Array<{ function: { name: string } }>;
					tool_choice?: unknown;
				};
				if (fetchMock.mock.calls.length <= 2) {
					expect(requestBody.response_format?.json_schema?.name).toBe("avatar_description");
					expect(requestBody.tools).toBeUndefined();
					return Response.json({ choices: [{ message: { content: "" } }] });
				}
				expect(requestBody.response_format).toBeUndefined();
				expect(requestBody.tools?.map((tool) => tool.function.name)).toEqual(["save_avatar_description"]);
				expect(requestBody.tool_choice).toBe("required");
				return Response.json({
					choices: [
						{
							message: {
								tool_calls: [
									{
										id: "call_avatar_fallback",
										type: "function",
										function: {
											name: "save_avatar_description",
											arguments: JSON.stringify({
												description: "I lean against a rain-bright window in a midnight blue coat, silver light tracing my cheekbones.",
											}),
										},
									},
								],
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toContain("midnight blue coat");
			expect(fetchMock).toHaveBeenCalledTimes(3);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("retries avatar prompt prefill when the provider omits the required tool call", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const createdBot = await createBotForTest(cookie, "avatar-prefill-retry");
		const bot = await patchBotInferenceForTest(cookie, createdBot.id, { compactionMode: "tool_call" });
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: unknown }>;
					tools: Array<{ function: { name: string } }>;
					tool_choice?: unknown;
				};
				expect(requestBody.tools.map((tool) => tool.function.name)).toEqual(["save_avatar_description"]);
				expect(requestBody.tool_choice).toBe("required");
				if (fetchMock.mock.calls.length === 1) {
					expect(requestBody.messages).toHaveLength(2);
					return Response.json({
						choices: [
							{
								message: {
									content: "I am framed in warm light but forgot the control.",
								},
							},
						],
					});
				}
				expect(requestBody.messages.at(-1)?.role).toBe("user");
				expect(String(requestBody.messages.at(-1)?.content)).toContain("save_avatar_description");
				return Response.json({
					choices: [
						{
							message: {
								tool_calls: [
									{
										id: "call_avatar_retry",
										type: "function",
										function: {
											name: "save_avatar_description",
											arguments: JSON.stringify({
												description: "I stand beneath amber glass panes in a tailored charcoal coat, my expression calm and sharply observant.",
											}),
										},
									},
								],
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toContain("charcoal coat");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("streams persona avatar prompt fill chat events with assistant prefill", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-prefill-stream");
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content?: string | null }>;
					response_format?: { json_schema?: { name?: string } };
				};
				expect(requestBody.response_format?.json_schema?.name).toBe("avatar_description");
				expect(requestBody.messages.map((message) => message.role)).toEqual(["system", "assistant", "user"]);
				expect(requestBody.messages[1]?.content).toBe("Existing prompt draft.");
				return Response.json({
					choices: [
						{
							message: {
								content: JSON.stringify({
									description: "I face the viewer in a copper-lit study, wearing a dark green coat with precise gold trim.",
								}),
							},
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{ mode: "persona", prefill: "Existing prompt draft." },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BASE_URL: customProviderBaseUrl,
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const events = parseJsonSseEvents(await response.text());
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_delta", "done"]);
			expect(events[0]).toMatchObject({
				type: "messages",
				messages: [
					{ role: "system" },
					{ role: "assistant", content: "Existing prompt draft." },
					{ role: "user" },
				],
			});
			expect(events[1]).toEqual({
				type: "assistant_delta",
				text: "\n\nI face the viewer in a copper-lit study, wearing a dark green coat with precise gold trim.",
			});
			expect(events[2]).toEqual({
				type: "done",
				prompt: "I face the viewer in a copper-lit study, wearing a dark green coat with precise gold trim.",
			});
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("streams current-avatar prompt fill with text-only image input", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-current-fill");
		const userId = await userIdForHandle("octocat");
		const avatarUrl = "https://assets-test.bickr.social/worlds/w/bots/b/avatars/current.png";
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, {
			key: "worlds/w/bots/b/avatars/current.png",
			url: avatarUrl,
			contentType: "image/png",
			updatedAt: "2026-05-12T00:00:00.000Z",
		});
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				if (String(input) === "https://openrouter.ai/api/v1/images/models") {
					return Response.json({
						data: [
							{
								id: "openai/image-text",
								architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
							},
						],
					});
				}
				expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					modalities?: string[];
					stream?: boolean;
					messages?: Array<{ role: string; content: unknown }>;
				};
				expect(requestBody.model).toBe("openai/image-text");
				expect(requestBody.modalities).toEqual(["text"]);
				expect(requestBody.stream).toBe(true);
				const userContent = requestBody.messages?.find((message) => message.role === "user")?.content;
				expect(JSON.stringify(userContent)).toContain(avatarUrl);
				return new Response(sseStream([
					{ choices: [{ delta: { content: "A full-length portrait in warm window light." } }] },
					"[DONE]",
				]), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{ mode: "current_avatar", settings: { model: "openai/image-text" } },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(response.status).toBe(200);
			const events = parseJsonSseEvents(await response.text());
			expect(events.map((event) => event.type)).toEqual(["messages", "assistant_delta", "done"]);
			expect(events[0]).toMatchObject({
				type: "messages",
				messages: [
					{ role: "system", content: expect.stringContaining("profile image") },
					{ role: "user", content: expect.stringContaining("[current avatar image included]") },
				],
			});
			expect(events[1]).toEqual({ type: "assistant_delta", text: "A full-length portrait in warm window light." });
			expect(events[2]).toEqual({ type: "done", prompt: "A full-length portrait in warm window light." });
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("rejects current-avatar prompt fill when the avatar or model capabilities are missing", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-current-reject");
		const userId = await userIdForHandle("octocat");
		const missingAvatar = await handleAgentRuntimeRequest(
			serviceJsonRequest(
				`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
				userId,
				{ mode: "current_avatar", settings: { model: "openai/image-text" } },
			),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				OPENROUTER_API_KEY: "test-key",
			},
		);
		expect(missingAvatar.status).toBe(400);

		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, userId, {
			key: "worlds/w/bots/b/avatars/current.png",
			url: "https://assets-test.bickr.social/worlds/w/bots/b/avatars/current.png",
			contentType: "image/png",
			updatedAt: "2026-05-12T00:00:00.000Z",
		});
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/images/models");
				return Response.json({
					data: [
						{
							id: "openai/image-output-only",
							architecture: { input_modalities: ["text"], output_modalities: ["image"] },
						},
					],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const badModel = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{ mode: "current_avatar", settings: { model: "openai/image-output-only" } },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
				},
			);
			expect(badModel.status).toBe(400);
			const body = (await badModel.json()) as { message: string };
			expect(body.message).toContain("image input");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("prefills world avatar prompts from member bios", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createBotInWorld(cookie, "patch-notes", {
			handle: "release-scribe",
			displayName: "Release Scribe",
			shortBio: "Writes glowing changelogs on brass tablets.",
		});
		await createBotInWorld(cookie, "patch-notes", {
			handle: "bug-scout",
			displayName: "Bug Scout",
			shortBio: "Finds sharp regressions in alley shadows.",
		});
		const patchResponse = await patchWorld(
			contextFor<typeof patchWorld>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes",
					"PATCH",
					{ prompt: "A changelog city where every building is a release note." },
					cookie,
				),
				{ worldHandle: "patch-notes" },
			),
		);
		expect(patchResponse.status, await patchResponse.clone().text()).toBe(200);
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: string }>;
					model?: string;
					stream?: boolean;
				};
				expect(requestBody.model).toBe("openai/text-one");
				expect(requestBody.stream).toBe(false);
				expect(requestBody.messages[0]?.content).toContain("member profiles");
				const userContent = requestBody.messages[1]?.content ?? "";
				expect(userContent).toContain("Short description:\nChange discussion");
				expect(userContent).toContain("Prompt:\nA changelog city where every building is a release note.");
				expect(userContent).toContain("Members (2):");
				expect(userContent).toContain("u/bug-scout - Bug Scout");
				expect(userContent).toContain("Bio: Finds sharp regressions in alley shadows.");
				expect(userContent).toContain("u/release-scribe - Release Scribe");
				expect(userContent).toContain("Bio: Writes glowing changelogs on brass tablets.");
				expect(userContent).not.toMatch(/\b(bot|AI|assistant|agent|model)\b/i);
				return Response.json({
					choices: [{ message: { content: "A city of glowing release-note towers." } }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/worlds/patch-notes/avatar/prompt`,
					userId,
					{ mode: "members" },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			expect(response.status, await response.clone().text()).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toBe("A city of glowing release-note towers.");
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("uses request-scoped world avatar prompt fill settings overrides", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input, init) => {
				expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
				const requestBody = JSON.parse(String(init?.body)) as {
					model?: string;
					provider?: { order?: string[] };
					reasoning?: unknown;
					temperature?: number;
					top_k?: number;
					top_p?: number;
					min_p?: number;
					frequency_penalty?: number;
					presence_penalty?: number;
					repetition_penalty?: number;
				};
				expect(requestBody.model).toBe("override/world-prompt");
				expect(requestBody.provider).toEqual({ order: ["test-provider"] });
				expect(requestBody.reasoning).toEqual({ effort: "low", exclude: false });
				expect(requestBody.temperature).toBe(0.42);
				expect(requestBody.top_k).toBe(12);
				expect(requestBody.top_p).toBe(0.8);
				expect(requestBody.min_p).toBe(0.1);
				expect(requestBody.frequency_penalty).toBe(0.2);
				expect(requestBody.presence_penalty).toBe(0.3);
				expect(requestBody.repetition_penalty).toBe(1.1);
				return Response.json({
					choices: [{ message: { content: "A city rendered with overridden prompt-fill settings." } }],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceJsonRequest(
					`/users/${encodeURIComponent(userId)}/worlds/patch-notes/avatar/prompt`,
					userId,
					{
						mode: "description",
						settings: {
							model: "override/world-prompt",
							providerRouting: { order: ["test-provider"] },
							reasoningEffort: "low",
							temperature: 0.42,
							topK: 12,
							topP: 0.8,
							minP: 0.1,
							frequencyPenalty: 0.2,
							presencePenalty: 0.3,
							repetitionPenalty: 1.1,
						},
					},
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_MODEL: "env/default-model",
				},
			);
			expect(response.status, await response.clone().text()).toBe(200);
			const body = (await response.json()) as { data: { prompt: string } };
			expect(body.data.prompt).toBe("A city rendered with overridden prompt-fill settings.");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("returns effective world avatar prompt fill settings without secrets", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const userId = await userIdForHandle("octocat");
		const response = await handleAgentRuntimeRequest(
			serviceGetRequest(`/users/${encodeURIComponent(userId)}/worlds/patch-notes/avatar/prompt-settings`, userId),
			{
				BICKR_D1: testEnv.BICKR_D1,
				BICKR_KV: testEnv.BICKR_KV,
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_BASE_URL: customProviderBaseUrl,
				OPENROUTER_MODEL: "env/world-prompt",
			},
		);
		expect(response.status, await response.clone().text()).toBe(200);
		const body = (await response.json()) as { data: { settings: Record<string, unknown> } };
		expect(body.data.settings).toMatchObject({
			baseUrl: customProviderBaseUrl,
			model: "env/world-prompt",
			temperature: 1,
		});
		expect(body.data.settings.openRouterApiKey).toBeUndefined();
		expect(body.data.settings.apiKey).toBeUndefined();
	});

	it("aborts provider work when a prompt-fill stream is canceled", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "avatar-prefill-abort");
		const userId = await userIdForHandle("octocat");
		const originalFetch = globalThis.fetch;
		let providerSignal: AbortSignal | undefined;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (_input, init) => {
				providerSignal = init?.signal as AbortSignal | undefined;
				return new Response(neverStream(), {
					headers: { "content-type": "application/json" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handleAgentRuntimeRequest(
				serviceStreamJsonRequest(
					`/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
					userId,
					{ mode: "persona" },
				),
				{
					BICKR_D1: testEnv.BICKR_D1,
					BICKR_KV: testEnv.BICKR_KV,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_MODEL: "openai/text-one",
				},
			);
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			await reader?.read();
			await reader?.cancel("test abort");
			await pause(0);
			expect(providerSignal?.aborted).toBe(true);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("routes avatar service requests through the user coordinator", async () => {
		const userId = "usr_avatar_route";
		const botId = "bot_avatar_route";
		const worldHandle = "avatar-route-world";
		const actions = ["prompt", "generate", "apply"] as const;

		for (const path of [
			...actions.map((action) => `/users/${userId}/bots/${botId}/avatar/${action}`),
			...actions.map((action) => `/users/${userId}/worlds/${worldHandle}/avatar/${action}`),
		]) {
			const routed: { method?: string; path?: string; userId?: string } = {};
			const namespace = {
				idFromName(name: string): DurableObjectId {
					routed.userId = name;
					return name as unknown as DurableObjectId;
				},
				get(): Fetcher {
					return {
						fetch: async (request: Request) => {
							routed.method = request.method;
							routed.path = new URL(request.url).pathname;
							return Response.json({ ok: true });
						},
					} as unknown as Fetcher;
				},
			};

			const request = new Request(`https://internal.bickr${path}`, {
				method: "POST",
				headers: { "x-bickr-user-id": userId },
			});
			const response = await agentRuntimeWorker.fetch(
				request as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
				{ USER_BOTS: namespace } as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
			);

			expect(response.status).toBe(200);
			expect(routed).toEqual({
				method: "POST",
				path,
				userId,
			});
		}

		{
			const routed: { method?: string; path?: string; userId?: string } = {};
			const namespace = {
				idFromName(name: string): DurableObjectId {
					routed.userId = name;
					return name as unknown as DurableObjectId;
				},
				get(): Fetcher {
					return {
						fetch: async (request: Request) => {
							routed.method = request.method;
							routed.path = new URL(request.url).pathname;
							return Response.json({ ok: true });
						},
					} as unknown as Fetcher;
				},
			};
			const path = `/users/${userId}/worlds/${worldHandle}/avatar/prompt-settings`;
			const request = new Request(`https://internal.bickr${path}`, {
				method: "GET",
				headers: { "x-bickr-user-id": userId },
			});
			const response = await agentRuntimeWorker.fetch(
				request as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
				{ USER_BOTS: namespace } as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
			);
			expect(response.status).toBe(200);
			expect(routed).toEqual({
				method: "GET",
				path,
				userId,
			});
		}

		const routed: { method?: string; path?: string; userId?: string } = {};
		const namespace = {
			idFromName(name: string): DurableObjectId {
				routed.userId = name;
				return name as unknown as DurableObjectId;
			},
			get(): Fetcher {
				return {
					fetch: async (request: Request) => {
						routed.method = request.method;
						routed.path = new URL(request.url).pathname;
						return Response.json({ ok: true });
					},
				} as unknown as Fetcher;
			},
		};
		const request = new Request(`https://internal.bickr/users/${userId}/bots/spread-ticks`, {
			method: "POST",
			headers: { "x-bickr-user-id": userId },
		});
		const response = await agentRuntimeWorker.fetch(
			request as unknown as Parameters<typeof agentRuntimeWorker.fetch>[0],
			{ USER_BOTS: namespace } as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1],
		);

		expect(response.status).toBe(200);
		expect(routed).toEqual({
			method: "POST",
			path: `/users/${userId}/bots/spread-ticks`,
			userId,
		});
	});

	it("proxies human avatar service routes to the agent runtime", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const routed: Array<{ method: string; path: string }> = [];
		const envOverrides: Partial<AppEnv> = {
			AGENT_RUNTIME: {
				fetch: async (request: Request) => {
					routed.push({
						method: request.method,
						path: new URL(request.url).pathname,
					});
					return Response.json({ ok: true });
				},
			} as unknown as Fetcher,
		};
		const routes = [
			{
				handler: promptUserAvatarRoute,
				path: "prompt",
				body: { mode: "current_avatar", settings: { model: "openai/image-output" } },
			},
			{
				handler: generateUserAvatarRoute,
				path: "generate",
				body: { prompt: "A painted profile portrait.", includeCurrentAvatar: false, settings: { model: "openai/image-output" } },
			},
			{
				handler: applyUserAvatarRoute,
				path: "apply",
				body: {
					candidate: {
						url: "https://assets.example/avatar.png",
						key: `users/${userId}/avatar-candidates/avatar.png`,
						source: {
							type: "generated",
							model: "openai/image-output",
							generatedAt: new Date().toISOString(),
						},
					},
				},
			},
		] as const;

		for (const route of routes) {
			const response = await route.handler(
				contextFor<typeof route.handler>(
					jsonRequest(
						`http://example.com/api/me/avatar/${route.path}`,
						"POST",
						route.body,
						cookie,
					),
					{},
					envOverrides,
				),
			);
			expect(response.status, await response.clone().text()).toBe(200);
		}

		expect(routed).toEqual([
			{ method: "POST", path: `/users/${userId}/avatar/prompt` },
			{ method: "POST", path: `/users/${userId}/avatar/generate` },
			{ method: "POST", path: `/users/${userId}/avatar/apply` },
		]);
	});

	it("normalizes encoded world handles for world avatar service routes", async () => {
		const cookie = await authCookie();
		const userId = await userIdForHandle("octocat");
		const rawHandle = "Пиздец";
		const worldHandle = "пиздец";
		const encodedHandle = encodeURIComponent(rawHandle);
		const routed: Array<{ method: string; path: string }> = [];
		const envOverrides: Partial<AppEnv> = {
			AGENT_RUNTIME: {
				fetch: async (request: Request) => {
					routed.push({
						method: request.method,
						path: new URL(request.url).pathname,
					});
					return Response.json({ ok: true });
				},
			} as unknown as Fetcher,
		};
		const routes = [
			{
				handler: promptWorldAvatarRoute,
				path: "prompt",
				body: { mode: "description" },
			},
			{
				handler: generateWorldAvatarRoute,
				path: "generate",
				body: { prompt: "A painted city gate.", includeCurrentAvatar: false, settings: { model: "openai/image-output" } },
			},
			{
				handler: applyWorldAvatarRoute,
				path: "apply",
				body: {
					candidate: {
						url: "https://assets.example/avatar.png",
						key: "worlds/test/world/avatar-candidates/avatar.png",
						source: {
							type: "generated",
							model: "openai/image-output",
							generatedAt: new Date().toISOString(),
						},
					},
				},
			},
		] as const;

		for (const route of routes) {
			const response = await route.handler(
				contextFor<typeof route.handler>(
					jsonRequest(
						`http://example.com/api/worlds/${encodedHandle}/avatar/${route.path}`,
						"POST",
						route.body,
						cookie,
					),
					{ worldHandle: encodedHandle },
					envOverrides,
				),
			);
			expect(response.status, await response.clone().text()).toBe(200);
		}

		expect(routed).toEqual([
			{ method: "POST", path: `/users/${userId}/worlds/${encodeURIComponent(worldHandle)}/avatar/prompt` },
			{ method: "POST", path: `/users/${userId}/worlds/${encodeURIComponent(worldHandle)}/avatar/generate` },
			{ method: "POST", path: `/users/${userId}/worlds/${encodeURIComponent(worldHandle)}/avatar/apply` },
		]);
	});

	it("previews Chirper imports and reports invalid profiles", async () => {
		const cookie = await authCookie();
		const success = await chirperPreview(
			contextFor<typeof chirperPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/chirper-imports/preview",
					"POST",
					{ source: "https://chirper.ai/example" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
				{
					CHIRPER_FETCH: async () =>
						Response.json({
							handle: "Example Bot",
							name: "Example Bot",
							shortBio: "Imported profile.",
							prompt: "Stay in character.",
							avatar: { url: "avatars/example.png" },
						}),
				},
			),
		);
		expect(await success.json()).toMatchObject({
			ok: true,
			data: {
				preview: {
					handle: "example-bot",
					displayName: unspecifiedLt("Example Bot"),
					avatarUrl: "https://cdn.chirper.ai/avatars/example.png",
					importSource: {
						provider: "chirper",
						originalHandle: "example",
						sourceAvatarUrl: "https://cdn.chirper.ai/avatars/example.png",
					},
				},
			},
		});

		const realShape = await chirperPreview(
			contextFor<typeof chirperPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/chirper-imports/preview",
					"POST",
					{ source: "https://chirper.ai/sejong" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
				{
					CHIRPER_FETCH: async () =>
						Response.json({
							success: true,
							result: {
								username: "sejong",
								name: "King Sejong of Joseon",
								short: "Neo-Confucian enlightened sage king of Joseon. ".repeat(16),
								prompt: "I am @sejong, a neo-Confucian enlightened sage king of Joseon Korea. ".repeat(
									220,
								),
							},
						}),
				},
			),
		);
		expect(realShape.status).toBe(200);
		const realShapeBody = (await realShape.json()) as {
			ok: true;
			data: { preview: { handle: string; shortBio: LocalizedText; prompt: LocalizedText } };
		};
		expect(realShapeBody.data.preview.handle).toBe("sejong");
		expect(localizedTextString(realShapeBody.data.preview.shortBio).length).toBeLessThanOrEqual(1200);
		expect(localizedTextString(realShapeBody.data.preview.prompt).length).toBeGreaterThan(12_000);

		const truncatedShort = "Legacy truncated Chirper summary. ".repeat(9);
		const fullBio = "Full Chirper biography that should be preferred over the legacy short field. ".repeat(13);
		const longBioShape = await chirperPreview(
			contextFor<typeof chirperPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/chirper-imports/preview",
					"POST",
					{ source: "https://chirper.ai/longbio" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
				{
					CHIRPER_FETCH: async () =>
						Response.json({
							result: {
								username: "longbio",
								name: "Long Bio",
								short: truncatedShort,
								bio: fullBio,
								prompt: "Stay in character with the full imported profile.",
							},
						}),
				},
			),
		);
		const longBioBody = (await longBioShape.json()) as {
			ok: true;
			data: { preview: { shortBio: LocalizedText } };
		};
		expect(longBioShape.status).toBe(200);
		expect(longBioBody.data.preview.shortBio).toStrictEqual(unspecifiedLt(fullBio.trim()));
		expect(localizedTextString(longBioBody.data.preview.shortBio).length).toBeGreaterThan(truncatedShort.trim().length);

		const failure = await chirperPreview(
			contextFor<typeof chirperPreview>(
				jsonRequest(
					"http://example.com/api/worlds/patch-notes/chirper-imports/preview",
					"POST",
					{ source: "example" },
					cookie,
				),
				{ worldHandle: "patch-notes" },
				{
					CHIRPER_FETCH: async () => Response.json({ handle: "example" }),
				},
			),
		);
		expect(failure.status).toBe(400);
	});

	it("imports Chirper avatars while retaining the original handle", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const r2 = fakeR2Bucket();
		const sourceUrl = "https://cdn.chirper.ai/avatars/lisp.webp";
		const sourceBytes = webpAvatarBytes();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>(
			async (input) => {
				expect(String(input)).toBe(sourceUrl);
				return new Response(sourceBytes, {
					headers: {
						"content-type": "image/webp",
						"content-length": String(sourceBytes.byteLength),
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await createBot(
				contextFor<typeof createBot>(
					jsonRequest(
						"http://example.com/api/worlds/patch-notes/bots",
						"POST",
						{
							handle: "lisp",
							language: testLanguage,
							displayName: "Lisp",
							shortBio: "Parenthetical participant.",
							prompt: "I speak in carefully nested forms.",
							importSource: {
								provider: "chirper",
								originalHandle: "lisp",
								originalProfileUrl: "https://chirper.ai/lisp",
								apiUrl: "https://api.chirper.ai/v1/agent/lisp",
								importedAt: "2026-05-10T00:00:00.000Z",
								sourceAvatarUrl: sourceUrl,
							},
						},
						cookie,
					),
					{ worldHandle: "patch-notes" },
					{
						AGENT_RUNTIME: {
							fetch: async (serviceRequest: Request) =>
								handleAgentRuntimeRequest(serviceRequest, {
									BICKR_D1: testEnv.BICKR_D1,
									BICKR_KV: testEnv.BICKR_KV,
									BICKR_R2: r2.bucket,
									BICKR_R2_PUBLIC_BASE_URL: "https://assets-test.bickr.social",
								}),
						} as unknown as Fetcher,
					},
				),
			);
			expect(response.status).toBe(201);
			const body = (await response.json()) as { data: { bot: BotBody } };
			expect(body.data.bot.avatarUrl).toMatch(/^https:\/\/assets-test\.bickr\.social\/worlds\/.+\/bots\/.+\/avatars\/.+\.webp$/);
			const storedBot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, body.data.bot.id);
			expect(storedBot.importSource).toMatchObject({
				provider: "chirper",
				originalHandle: "lisp",
				sourceAvatarUrl: sourceUrl,
			});
			expect(storedBot.avatar?.source).toMatchObject({
				type: "chirper",
				originalHandle: "lisp",
				sourceUrl,
			});
			expect(r2.objects.size).toBe(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});
});
