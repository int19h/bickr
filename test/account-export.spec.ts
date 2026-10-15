import { onRequestGet as exportRoute } from "../apps/web/functions/api/me/export";
import { onRequestGet as imageRoute } from "../apps/web/functions/api/me/export/image";
import { accountExportPage, exportBotDefinition, exportInferenceSettings } from "@bickr/shared/account-export-repository";
import { accountDefaultConfigurationId, inferenceConfigurationMutations, insertAccountDefaultConfigurationStatement } from "@bickr/shared/inference-configuration-repository";
import { userById } from "@bickr/shared/repository";
import type { AccountExportPage, AccountExportSection } from "@bickr/shared/account-export";
import type { BotDocument } from "@bickr/shared/model";
import {
	authCookie, authCookieFor, contextFor, createBotForTest, createForumForTest, createThreadForTest,
	createCommentForTest, describe, expect, it, kvKeys, seedWorld, testEnv, userIdForHandle, fakeR2Bucket, pngAvatarBytes,
} from "./helpers/index-harness";

async function read(cookie: string, userId: string, section: string, cursor?: string) {
	const query = new URLSearchParams({ ownerUserId: userId, section });
	if (cursor) query.set("cursor", cursor);
	return exportRoute(contextFor<typeof exportRoute>(new Request(`https://example.com/api/me/export?${query}`, { headers: { cookie } })));
}
async function payload(cookie: string, userId: string, section: AccountExportSection, cursor?: string): Promise<AccountExportPage> {
	const response = await read(cookie, userId, section, cursor);
	expect(response.status, await response.clone().text()).toBe(200);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	return ((await response.json()) as { data: AccountExportPage }).data;
}

describe("account data export", () => {
	it("requires authentication, binds each page to its starting account, and rejects invalid selectors/cursors", async () => {
		expect((await read("", "any", "profile")).status).toBe(401);
		const cookie = await authCookie();
		const owner = await userIdForHandle("octocat");
		expect((await read(cookie, "other-account", "profile")).status).toBe(409);
		expect((await read(cookie, owner, "auth_records")).status).toBe(400);
		expect((await read(cookie, owner, "bots", "not-base64!")).status).toBe(400);
	});

	it("exports exact text and safe inference metadata without authentication or nested legacy secrets", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "export-text");
		const owner = await userIdForHandle("octocat");
		const raw = JSON.parse((await testEnv.BICKR_KV.get(kvKeys.bot(bot.id)))!) as BotDocument;
		raw.prompt.text = 'Keep this exact: API key example sk-user-text\n日本語 "quoted"';
		raw.inferenceSettings = {
			openRouterApiKey: "secret-runtime-key", baseUrl: "https://user:password@provider.test/v1?token=secret-query",
			providerRouting: { order: ["provider-a"], api_key: "secret-routing", max_price: { prompt: 0.5, auth: "secret-nested" } },
			imageGeneration: { model: "image/model", providerRouting: { token: "secret-image-routing", allow_fallbacks: false } },
		};
		raw.localOverrides = {
			language: raw.language, includeLanguageInSystemPrompt: null, displayName: raw.displayName,
			shortBio: raw.shortBio, prompt: raw.prompt, hasAvatar: false,
			inferenceSettings: { openRouterApiKey: "secret-local-key" },
		};
		const safe = JSON.stringify(exportBotDefinition(raw));
		for (const secret of ["secret-runtime-key", "password", "secret-query", "secret-routing", "secret-nested", "secret-image-routing", "secret-local-key"]) expect(safe).not.toContain(secret);
		expect(JSON.parse(safe).prompt.text).toBe(raw.prompt.text);
		expect(exportInferenceSettings(raw.inferenceSettings)).toMatchObject({ baseUrl: "https://provider.test/v1", providerRouting: { order: ["provider-a"], max_price: { prompt: 0.5 } } });
		const root = await accountDefaultConfigurationId(owner);
		await insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, { configurationId: root, ownerUserId: owner, now: new Date().toISOString() }).run();
		const custom = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, owner, {
			name: "Export model", parentId: root,
			overrides: { model: { kind: "value", value: "test/model" }, temperature: { kind: "value", value: 0.4 } },
			credential: { mode: "value", secret: "secret-canonical-key" },
		});
		const configs = await payload(cookie, owner, "inferenceConfigurations");
		expect(configs.records).toContainEqual(expect.objectContaining({ id: custom.id, parentId: root, credentialMode: "value", effectiveModel: "test/model" }));
		expect(JSON.stringify(configs)).not.toContain("secret-canonical-key");
		const profile = await payload(cookie, owner, "profile");
		expect(profile.records).toHaveLength(1);
		expect(profile.records[0]).not.toHaveProperty("authIdentities");
		for (const section of ["worlds", "forums", "bots", "groups", "groupMembers", "subscriptions", "votes", "follows", "notes"] as const) {
			expect((await payload(cookie, owner, section)).kind).toBe("account_export_page");
		}
	});

	it("exports more than 100 bots with stable owner-scoped cursors and excludes inactive or foreign records", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const first = await createBotForTest(cookie, "export-many");
		const owner = await userIdForHandle("octocat");
		const user = await userById(testEnv.BICKR_KV, owner);
		const raw = JSON.parse((await testEnv.BICKR_KV.get(kvKeys.bot(first.id)))!) as BotDocument;
		for (let index = 0; index < 103; index++) {
			const id = `bot_export_${String(index).padStart(3, "0")}`;
			await testEnv.BICKR_KV.put(kvKeys.bot(id), JSON.stringify({ ...raw, id, handle: id }));
			await testEnv.BICKR_D1.prepare(`INSERT INTO entity_lifecycle_identity_claims(key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id, claim_state, created_at, updated_at)
				VALUES ('bot_handle', ?, ?, 'bot', ?, ?, 'active', ?, ?)`).bind(raw.homeWorldId, id, id, owner, raw.createdAt, raw.updatedAt).run();
			await testEnv.BICKR_D1.prepare(`INSERT INTO bots_index(bot_id, home_world_id, home_world_handle, handle, display_name, owner_user_id, short_bio, created_at, updated_at, lifecycle_state)
				VALUES (?, ?, ?, ?, 'Export', ?, 'Bio', ?, ?, 'active')`).bind(id, raw.homeWorldId, raw.homeWorldHandle, id, owner, raw.createdAt, raw.updatedAt).run();
		}
		await testEnv.BICKR_D1.prepare("UPDATE bots_index SET lifecycle_state = 'deleting', deleted_at = ? WHERE bot_id = 'bot_export_102'").bind(new Date().toISOString()).run();
		const ids: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await accountExportPage(testEnv.BICKR_KV, testEnv.BICKR_D1, user, "bots", cursor);
			ids.push(...page.records.map((record) => (record as { id: string }).id));
			cursor = page.nextCursor;
			if (cursor) {
				await expect(accountExportPage(testEnv.BICKR_KV, testEnv.BICKR_D1, user, "worlds", cursor)).rejects.toMatchObject({ status: 400 });
				await expect(accountExportPage(testEnv.BICKR_KV, testEnv.BICKR_D1, { ...user, id: "foreign" }, "bots", cursor)).rejects.toMatchObject({ status: 400 });
			}
		} while (cursor);
		expect(ids).toHaveLength(103);
		expect(new Set(ids).size).toBe(103);
		expect(ids).not.toContain("bot_export_102");
	});

	it("exports only owned authors, including comments on foreign posts, and refuses stale author ownership", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const own = await createBotForTest(cookie, "author-own");
		const otherCookie = await authCookieFor({ subject: "other", login: "other", displayName: "Other" });
		const other = await createBotForTest(otherCookie, "author-other");
		const forum = await createForumForTest(cookie, "export-content");
		const ownThread = await createThreadForTest(forum.id, own.id, "Own post", "Own root");
		await createCommentForTest(ownThread.id, other.id, "Foreign reply excluded");
		const otherThread = await createThreadForTest(forum.id, other.id, "Foreign post excluded", "Foreign root excluded");
		await createCommentForTest(otherThread.id, own.id, "Owned reply included");
		const owner = await userIdForHandle("octocat");
		const threads = await payload(cookie, owner, "threads");
		expect(threads.records).toHaveLength(1);
		expect(threads.records[0]).toMatchObject({ id: ownThread.id });
		const comments = await payload(cookie, owner, "comments");
		expect(comments.records).toHaveLength(2);
		expect(JSON.stringify(comments)).toContain("Owned reply included");
		expect(JSON.stringify(comments)).not.toContain("Foreign");
		const raw = JSON.parse((await testEnv.BICKR_KV.get(kvKeys.bot(own.id)))!) as BotDocument;
		await testEnv.BICKR_KV.put(kvKeys.bot(own.id), JSON.stringify({ ...raw, ownerUserId: other.id }));
		expect((await read(cookie, owner, "comments")).status).toBe(409);
	});

	it("serves only currently referenced owned images and keeps failures non-cacheable", async () => {
		const cookie = await authCookie();
		const owner = await userIdForHandle("octocat");
		const user = await userById(testEnv.BICKR_KV, owner);
		const key = `users/${owner}/avatars/export.png`;
		await testEnv.BICKR_KV.put(kvKeys.user(owner), JSON.stringify({ ...user, avatar: { key, url: `https://images.test/${key}`, contentType: "image/png", updatedAt: user.updatedAt } }));
		const storage = fakeR2Bucket();
		await storage.bucket.put(key, pngAvatarBytes());
		const streamBucket = { ...storage.bucket, get: async (objectKey: string) => {
			const object = storage.objects.get(objectKey);
			return object ? { size: object.bytes.byteLength, body: new Response(object.bytes).body } : null;
		} } as unknown as R2Bucket;
		const image = (extra: Record<string, string> = {}) => imageRoute(contextFor<typeof imageRoute>(new Request(`https://example.com/api/me/export/image?${new URLSearchParams({ ownerUserId: owner, kind: "user", entityId: owner, slot: "avatar", expectedKey: key, ...extra })}`, { headers: { cookie } }), {}, { BICKR_R2: streamBucket }));
		const response = await image();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngAvatarBytes());
		expect((await image({ entityId: "foreign" })).status).toBe(403);
		expect((await image({ expectedKey: "arbitrary-secret-key" })).status).toBe(409);
		await storage.bucket.delete(key);
		const missing = await image();
		expect(missing.status).toBe(409);
		expect(missing.headers.get("cache-control")).toContain("no-store");
	});
});
