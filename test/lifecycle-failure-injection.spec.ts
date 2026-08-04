import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import {
	InjectedLifecycleFailure,
	type LifecycleFailurePoint,
	type LifecycleFailureInjector,
} from "@bickr/shared/entity-lifecycle";
import { deterministicId } from "@bickr/shared/ids";
import { localizedText } from "@bickr/shared/model";
import { listUserBots, listWorlds, rawBotById } from "@bickr/shared/repository";
import { parseLanguageTag } from "@bickr/shared/validation";
import { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/routes";
import { handleForumCoordinatorRequest } from "../workers/forum-coordinator/src/index";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { createBot, createWorld, upsertProviderUser } from "./helpers/coordinator-mutations";

const accountCreatePoints: LifecycleFailurePoint[] = [
	"account.reserve.d1",
	"account.materialize.kv",
	"account.activate.d1",
];
const worldCreatePoints: LifecycleFailurePoint[] = [
	"world.reserve.d1",
	"world.materialize.kv",
	"world.materialize.indexes.d1",
	"world.materialize.intro_forum",
	"world.materialize.search",
	"world.activate.d1",
];
const worldDeletePoints: LifecycleFailurePoint[] = [
	"world.delete.hide.d1",
	"world.delete.kv",
	"world.delete.indexes.d1",
	"world.delete.forum_search",
	"world.delete.finish.d1",
];
const botCreatePoints: LifecycleFailurePoint[] = [
	"bot.reserve.d1",
	"bot.materialize.kv",
	"bot.materialize.indexes.d1",
	"bot.materialize.personal_forum",
	"bot.materialize.vector",
	"bot.activate.d1",
];
const cloneCreatePoints = botCreatePoints.map((point) => point.replace(/^bot\./u, "clone.")) as LifecycleFailurePoint[];

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("lifecycle failure injection", () => {
	it.each(accountCreatePoints)("converges account create after %s", async (point) => {
		const profile = { provider: "github" as const, subject: `subject-${point}`, login: `user-${point.replaceAll(".", "-")}` };
		const userId = await deterministicId("usr", `provider:${profile.provider}:${profile.subject}`);
		const result = await failOnceThenRetry(userId, "/account/bootstrap", "POST", profile, `account-${point}`, point);
		expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
		expect(await activeProjectionCount("users_index", "user_id", userId)).toBe(1);
	});

	it.each(worldCreatePoints)("converges world create without duplicate world or intro forum after %s", async (point) => {
		const user = await seedAccount(`world-${point}`);
		const handle = testHandle(`world-${point.replaceAll(".", "-")}`);
		const result = await failOnceThenRetry(user.id, "/worlds", "POST", worldInput(handle), `world-${point}`, point);
		expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
		const row = await testEnv.BICKR_D1.prepare(`SELECT world_id AS id FROM worlds_index WHERE handle = ? AND lifecycle_state = 'active'`).bind(handle).first<{ id: string }>();
		expect(row).not.toBeNull();
		expect((await testEnv.BICKR_D1.prepare(`SELECT COUNT(*) AS count FROM forums_index WHERE world_id = ? AND handle = 'intro'`).bind(row?.id).first<{ count: number }>())?.count).toBe(1);
		expect((await listWorlds(testEnv.BICKR_D1)).filter((world) => world.id === row?.id)).toHaveLength(1);
	});

	it("does not expose a materialized world before its activation batch", async () => {
		const user = await seedAccount("pending-world-visibility");
		const handle = "pending-world-visibility";
		const injector = new FailOnce("world.materialize.search");
		const first = await coordinatorRequest(user.id, "/worlds", "POST", worldInput(handle), "pending-world-key", injector);
		expect(first.ok).toBe(false);
		expect((await listWorlds(testEnv.BICKR_D1)).some((world) => world.handle === handle)).toBe(false);
		const second = await coordinatorRequest(user.id, "/worlds", "POST", worldInput(handle), "pending-world-key", injector);
		expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
		expect((await listWorlds(testEnv.BICKR_D1)).filter((world) => world.handle === handle)).toHaveLength(1);
	});

	it("preserves world and intro-forum timestamps, revisions, and identities across materialization retry", async () => {
		const user = await seedAccount("stable-world-materialization");
		const input = worldInput("stable-world-materialization");
		const key = "stable-world-materialization-key";
		const injector = new FailOnce("world.materialize.search");
		const first = await coordinatorRequest(user.id, "/worlds", "POST", input, key, injector);
		expect(first.ok).toBe(false);
		const request = await lifecycleRequestByKey(user.id, key) as { worldId: string; introForumId: string; createdAt: string };
		const beforeWorld = await testEnv.BICKR_KV.get(`v1:world:${request.worldId}`, { type: "json" });
		const beforeForum = await testEnv.BICKR_KV.get(`v1:forum:${request.introForumId}`, { type: "json" });
		expect(beforeWorld).toMatchObject({ id: request.worldId, revision: 1, createdAt: request.createdAt, updatedAt: request.createdAt });
		expect(beforeForum).toMatchObject({ id: request.introForumId, revision: 1, createdAt: request.createdAt, updatedAt: request.createdAt });
		const second = await coordinatorRequest(user.id, "/worlds", "POST", input, key, injector);
		expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
		expect(await testEnv.BICKR_KV.get(`v1:world:${request.worldId}`, { type: "json" })).toEqual(beforeWorld);
		expect(await testEnv.BICKR_KV.get(`v1:forum:${request.introForumId}`, { type: "json" })).toEqual(beforeForum);
	});

	it.each([...botCreatePoints, ...cloneCreatePoints])("converges participant create without duplicate entity or personal forum after %s", async (point) => {
		const user = await seedAccount(`bot-${point}`);
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput(testHandle(`home-${point.replaceAll(".", "-")}`)), user.id);
		const clone = point.startsWith("clone.");
		const source = clone ? await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("source"), user.id) : null;
		const input = botInput(testHandle(`target-${point.replaceAll(".", "-")}`), source?.id);
		const result = await failOnceThenRetry(user.id, `/worlds/${encodeURIComponent(world.handle)}/bots`, "POST", input, `bot-${point}`, point);
		expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
		const row = await testEnv.BICKR_D1.prepare(`SELECT bot_id AS id FROM bots_index WHERE home_world_id = ? AND handle = ? AND lifecycle_state = 'active'`).bind(world.id, input.handle).first<{ id: string }>();
		expect(row).not.toBeNull();
		expect((await testEnv.BICKR_D1.prepare(`SELECT COUNT(*) AS count FROM forums_index WHERE personal_bot_id = ?`).bind(row?.id).first<{ count: number }>())?.count).toBe(1);
	});

	it("preserves participant and personal-forum timestamps, revisions, and identities across materialization retry", async () => {
		const user = await seedAccount("stable-bot-materialization");
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("stable-bot-home"), user.id);
		const input = botInput("stable-bot-materialization");
		const key = "stable-bot-materialization-key";
		const injector = new FailOnce("bot.materialize.vector");
		const first = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, key, injector);
		expect(first.ok).toBe(false);
		const request = await lifecycleRequestByKey(user.id, key) as { botId: string; personalForumId: string; createdAt: string };
		const beforeBot = await testEnv.BICKR_KV.get(`v1:bot:${request.botId}`, { type: "json" });
		const beforeForum = await testEnv.BICKR_KV.get(`v1:forum:${request.personalForumId}`, { type: "json" });
		expect(beforeBot).toMatchObject({ id: request.botId, revision: 1, createdAt: request.createdAt, updatedAt: request.createdAt });
		expect(beforeForum).toMatchObject({ id: request.personalForumId, revision: 1, createdAt: request.createdAt, updatedAt: request.createdAt });
		const second = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, key, injector);
		expect(second.ok).toBe(true);
		expect(await testEnv.BICKR_KV.get(`v1:bot:${request.botId}`, { type: "json" })).toEqual(beforeBot);
		expect(await testEnv.BICKR_KV.get(`v1:forum:${request.personalForumId}`, { type: "json" })).toEqual(beforeForum);
	});

	it.each(worldDeletePoints)("converges world deletion and never leaks the deleting world after %s", async (point) => {
		const user = await seedAccount(`world-delete-${point}`);
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput(testHandle(`world-delete-${point.replaceAll(".", "-")}`)), user.id);
		const result = await failOnceThenRetry(user.id, `/worlds/${encodeURIComponent(world.handle)}`, "DELETE", undefined, `world-delete-${point}`, point);
		expect(result.ok).toBe(true);
		expect((await listWorlds(testEnv.BICKR_D1)).some((candidate) => candidate.id === world.id)).toBe(false);
	});

	it.each([
		"account.delete.hide.d1",
		"account.delete.kv",
		"account.delete.indexes.d1",
		"account.delete.finish.d1",
	] satisfies LifecycleFailurePoint[])("converges account deletion after %s", async (point) => {
		const user = await seedAccount(`account-delete-${point}`);
		const result = await failOnceThenRetry(user.id, "/profile", "DELETE", { confirmCascade: true }, `account-delete-${point}`, point);
		expect(result.ok).toBe(true);
		expect((await testEnv.BICKR_D1.prepare(`SELECT deleted_at AS deletedAt FROM users_index WHERE user_id = ?`).bind(user.id).first<{ deletedAt: string | null }>())?.deletedAt).not.toBeNull();
	});

	it.each([
		"account.delete.hide.d1",
		"account.delete.kv",
		"account.delete.indexes.d1",
		"account.delete.finish.d1",
	] satisfies LifecycleFailurePoint[])("handles terminal account deletion failure after %s without leaking a deleting account", async (point) => {
		const user = await seedAccount(`account-terminal-delete-${point}`);
		const firstKey = `account-terminal-delete-${point}`;
		const first = await coordinatorRequest(user.id, "/profile", "DELETE", { confirmCascade: true }, firstKey, new FailOnce(point, false));
		expect(first.ok).toBe(false);
		expect(await activeProjectionCount("users_index", "user_id", user.id)).toBe(point.endsWith("hide.d1") ? 1 : 0);
		const claims = await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM entity_lifecycle_identity_claims
			 WHERE entity_kind = 'account' AND entity_id = ?`,
		).bind(user.id).first<{ count: number }>();
		expect(claims?.count ?? 0).toBe(point.endsWith("finish.d1") ? 0 : 2);
		const second = await coordinatorRequest(user.id, "/profile", "DELETE", { confirmCascade: true }, point.endsWith("hide.d1") ? `${firstKey}-replacement` : firstKey);
		expect(second.ok).toBe(true);
		expect(await activeProjectionCount("users_index", "user_id", user.id)).toBe(0);
	});

	it("hides a participant as soon as deletion enters its serialized D1 transition", async () => {
		const user = await seedAccount("deleting-bot-visibility");
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("deleting-bot-home"), user.id);
		const bot = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("deleting-bot"), user.id);
		const injector = new FailOnce("bot.delete.hide.d1");
		const first = await coordinatorRequest(user.id, `/bots/${encodeURIComponent(bot.id)}`, "DELETE", undefined, "deleting-bot-key", injector);
		expect(first.ok).toBe(false);
		expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).some((candidate) => candidate.id === bot.id)).toBe(false);
		const second = await coordinatorRequest(user.id, `/bots/${encodeURIComponent(bot.id)}`, "DELETE", undefined, "deleting-bot-key", injector);
		expect(second.ok).toBe(true);
	});

	it.each([
		"bot.delete.hide.d1",
		"bot.delete.kv",
		"bot.delete.indexes.d1",
		"bot.delete.runtime_vector",
		"bot.delete.finish.d1",
		"clone.delete.hide.d1",
		"clone.delete.kv",
		"clone.delete.indexes.d1",
		"clone.delete.runtime_vector",
		"clone.delete.finish.d1",
	] satisfies LifecycleFailurePoint[])("converges participant deletion and never leaks deleting rows after %s", async (point) => {
		const user = await seedAccount(`delete-${point}`);
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput(testHandle(`delete-home-${point.replaceAll(".", "-")}`)), user.id);
		const clone = point.startsWith("clone.");
		const source = clone ? await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("delete-source"), user.id) : null;
		const bot = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("delete-target", source?.id), user.id);
		const result = await failOnceThenRetry(user.id, `/bots/${encodeURIComponent(bot.id)}`, "DELETE", undefined, `delete-${point}`, point);
		expect(result.ok).toBe(true);
		expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).some((candidate) => candidate.id === bot.id)).toBe(false);
	});

	it.each(worldDeletePoints)("handles terminal world deletion failure after %s without leaking a deleting world", async (point) => {
		const user = await seedAccount(`world-terminal-delete-${point}`);
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput(testHandle(`world-terminal-delete-${point.replaceAll(".", "-")}`)), user.id);
		const firstKey = `world-terminal-delete-${point}`;
		const first = await coordinatorRequest(user.id, `/worlds/${world.handle}`, "DELETE", undefined, firstKey, new FailOnce(point, false));
		expect(first.ok).toBe(false);
		expect((await listWorlds(testEnv.BICKR_D1)).some((candidate) => candidate.id === world.id)).toBe(point.endsWith("hide.d1"));
		const second = await coordinatorRequest(user.id, `/worlds/${world.handle}`, "DELETE", undefined, point.endsWith("hide.d1") ? `${firstKey}-replacement` : firstKey);
		expect(second.ok).toBe(true);
		expect((await listWorlds(testEnv.BICKR_D1)).some((candidate) => candidate.id === world.id)).toBe(false);
	});

	it.each([
		"bot.delete.hide.d1",
		"bot.delete.kv",
		"bot.delete.indexes.d1",
		"bot.delete.runtime_vector",
		"bot.delete.finish.d1",
		"clone.delete.hide.d1",
		"clone.delete.kv",
		"clone.delete.indexes.d1",
		"clone.delete.runtime_vector",
		"clone.delete.finish.d1",
	] satisfies LifecycleFailurePoint[])("handles terminal participant deletion failure after %s without leaking a deleting participant", async (point) => {
		const user = await seedAccount(`participant-terminal-delete-${point}`);
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput(testHandle(`participant-terminal-home-${point.replaceAll(".", "-")}`)), user.id);
		const clone = point.startsWith("clone.");
		const source = clone ? await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("participant-terminal-source"), user.id) : null;
		const bot = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput("participant-terminal-target", source?.id), user.id);
		const firstKey = `participant-terminal-delete-${point}`;
		const first = await coordinatorRequest(user.id, `/bots/${bot.id}`, "DELETE", undefined, firstKey, new FailOnce(point, false));
		expect(first.ok).toBe(false);
		expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).some((candidate) => candidate.id === bot.id)).toBe(point.endsWith("hide.d1"));
		const second = await coordinatorRequest(user.id, `/bots/${bot.id}`, "DELETE", undefined, point.endsWith("hide.d1") ? `${firstKey}-replacement` : firstKey);
		expect(second.ok).toBe(true);
		expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).some((candidate) => candidate.id === bot.id)).toBe(false);
	});

	it.each(accountCreatePoints)("terminal account compensation after %s hides the account and releases its provider subject", async (point) => {
		const suffix = point.replaceAll(".", "-");
		const profile = { provider: "github" as const, subject: `terminal-account-${suffix}`, login: `terminal-account-${suffix}`.slice(0, 60) };
		const userId = await deterministicId("usr", `provider:${profile.provider}:${profile.subject}`);
		const first = await coordinatorRequest(userId, "/account/bootstrap", "POST", profile, `terminal-account-first-${point}`, new FailOnce(point, false));
		expect(first.ok).toBe(false);
		expect(await activeProjectionCount("users_index", "user_id", userId)).toBe(0);
		const second = await coordinatorRequest(userId, "/account/bootstrap", "POST", profile, `terminal-account-second-${point}`);
		expect(second.ok).toBe(true);
		expect(await activeProjectionCount("users_index", "user_id", userId)).toBe(1);
	});

	it.each(worldCreatePoints)("terminal world compensation after %s hides the world and releases its handle", async (point) => {
		const suffix = point.replaceAll(".", "-");
		const user = await seedAccount(`terminal-world-${suffix}`);
		const input = worldInput(testHandle(`terminal-world-${suffix}`));
		const first = await coordinatorRequest(user.id, "/worlds", "POST", input, `terminal-world-first-${point}`, new FailOnce(point, false));
		expect(first.ok).toBe(false);
		expect((await listWorlds(testEnv.BICKR_D1)).some((world) => world.handle === input.handle)).toBe(false);
		const second = await coordinatorRequest(user.id, "/worlds", "POST", input, `terminal-world-second-${point}`);
		expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
		expect((await listWorlds(testEnv.BICKR_D1)).filter((world) => world.handle === input.handle)).toHaveLength(1);
	});

	it.each([...botCreatePoints, ...cloneCreatePoints])("terminal participant compensation after %s hides the participant and releases its handle", async (point) => {
		const suffix = point.replaceAll(".", "-");
		const user = await seedAccount(`terminal-bot-${suffix}`);
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput(testHandle(`terminal-home-${suffix}`)), user.id);
		const clone = point.startsWith("clone.");
		const source = clone ? await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, botInput(testHandle(`source-${suffix}`)), user.id) : null;
		const input = botInput(testHandle(`terminal-target-${suffix}`), source?.id);
		const first = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, `terminal-bot-first-${point}`, new FailOnce(point, false));
		expect(first.ok).toBe(false);
		expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).some((bot) => bot.handle === input.handle)).toBe(false);
		const second = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, `terminal-bot-second-${point}`);
		expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
		expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).filter((bot) => bot.handle === input.handle)).toHaveLength(1);
	});

	it("reuses one immutable import-avatar snapshot after retryable bot.materialize.import_avatar", async () => {
		const point = "bot.materialize.import_avatar" satisfies LifecycleFailurePoint;
		const user = await seedAccount(`import-retry-${point}`);
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput(testHandle(`import-retry-home-${point.replaceAll(".", "-")}`)), user.id);
		const input = importedBotInput("import-retry-bot");
		const fetchMock = vi.fn(async () => new Response(pngAvatarBytes(), { headers: { "content-type": "image/png" } }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await failOnceThenRetry(user.id, `/worlds/${world.handle}/bots`, "POST", input, `import-retry-${point}`, point);
			expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const summary = (await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).find((bot) => bot.handle === input.handle);
			expect(summary).toBeDefined();
			const stored = await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, summary?.id ?? "");
			expect(stored.avatar?.key).toContain("lifecycle-import.png");
			expect(stored.revision).toBe(2);
			expect(stored.updatedAt).toBe(stored.createdAt);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("terminal bot.materialize.import_avatar compensates the snapshot and releases the participant handle", async () => {
		const point = "bot.materialize.import_avatar" satisfies LifecycleFailurePoint;
		const user = await seedAccount(`import-terminal-${point}`);
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput(testHandle(`import-terminal-home-${point.replaceAll(".", "-")}`)), user.id);
		const input = importedBotInput("import-terminal-bot");
		vi.stubGlobal("fetch", vi.fn(async () => new Response(pngAvatarBytes(), { headers: { "content-type": "image/png" } })));
		try {
			const first = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, `import-terminal-first-${point}`, new FailOnce(point, false));
			expect(first.ok).toBe(false);
			expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).some((bot) => bot.handle === input.handle)).toBe(false);
			const second = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, `import-terminal-second-${point}`);
			expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps a create credential out of request JSON and replays it from the short-lived secret store", async () => {
		const user = await seedAccount("credential-retry");
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("credential-retry-home"), user.id);
		const key = "credential-retry-key";
		const credential = "sk-lifecycle-retry-secret";
		const input = {
			...botInput("credential-retry-bot"),
			inferenceSettings: { openRouterApiKey: credential },
		};
		const injector = new FailOnce("bot.reserve.d1");
		const first = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, key, injector);
		expect(first.ok).toBe(false);
		const operation = await testEnv.BICKR_D1.prepare(
			`SELECT operation_id AS operationId, request_json AS requestJson
			 FROM entity_lifecycle_operations
			 WHERE owner_user_id = ? AND idempotency_key = ?`,
		).bind(user.id, key).first<{ operationId: string; requestJson: string }>();
		expect(operation?.requestJson).not.toContain(credential);
		expect(operation?.requestJson).not.toContain("openRouterApiKey");
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT secret_value AS value FROM entity_lifecycle_secrets
			 WHERE operation_id = ? AND secret_kind = 'bot_openrouter_api_key'`,
		).bind(operation?.operationId).first<{ value: string }>())?.value).toBe(credential);

		const second = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, key, injector);
		expect(second.ok).toBe(true);
		const bot = (await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, user.id)).find((candidate) => candidate.handle === input.handle);
		expect((await rawBotById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot?.id ?? "")).inferenceSettings.openRouterApiKey).toBe(credential);
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM entity_lifecycle_secrets WHERE operation_id = ?`,
		).bind(operation?.operationId).first<{ count: number }>())?.count).toBe(0);
	});

	it("hard-deletes a create credential during terminal compensation", async () => {
		const user = await seedAccount("credential-terminal");
		const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, worldInput("credential-terminal-home"), user.id);
		const key = "credential-terminal-key";
		const input = {
			...botInput("credential-terminal-bot"),
			inferenceSettings: { openRouterApiKey: "sk-terminal-secret" },
		};
		const first = await coordinatorRequest(
			user.id,
			`/worlds/${world.handle}/bots`,
			"POST",
			input,
			key,
			new FailOnce("bot.materialize.kv", false),
		);
		expect(first.ok).toBe(false);
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count
			 FROM entity_lifecycle_secrets secrets
			 JOIN entity_lifecycle_operations operations ON operations.operation_id = secrets.operation_id
			 WHERE operations.owner_user_id = ? AND operations.idempotency_key = ?`,
		).bind(user.id, key).first<{ count: number }>())?.count).toBe(0);
		const replacement = await coordinatorRequest(user.id, `/worlds/${world.handle}/bots`, "POST", input, `${key}-replacement`);
		expect(replacement.ok).toBe(true);
	});
});

class FailOnce implements LifecycleFailureInjector {
	private failed = false;
	private readonly point: LifecycleFailurePoint;
	private readonly retryable: boolean;

	constructor(point: LifecycleFailurePoint, retryable = true) {
		this.point = point;
		this.retryable = retryable;
	}
	checkpoint(point: LifecycleFailurePoint): void {
		if (point !== this.point || this.failed) return;
		this.failed = true;
		throw new InjectedLifecycleFailure(point, {
			category: this.retryable ? "external_retryable" : "external_terminal",
			code: `injected_${point}`,
			retryable: this.retryable,
		});
	}
}

async function failOnceThenRetry(
	userId: string,
	path: string,
	method: string,
	body: unknown,
	key: string,
	point: LifecycleFailurePoint,
): Promise<Record<string, unknown>> {
	const injector = new FailOnce(point);
	const first = await coordinatorRequest(userId, path, method, body, key, injector);
	expect(first.ok).toBe(false);
	return coordinatorRequest(userId, path, method, body, key, injector);
}

async function coordinatorRequest(
	userId: string,
	path: string,
	method: string,
	body: unknown,
	key: string,
	injector?: LifecycleFailureInjector,
): Promise<Record<string, unknown>> {
	const forumService = {
		fetch: (request: Request) => handleForumCoordinatorRequest(request, testEnv, {
			objectId: "failure-world-coordinator",
			queue: new ExclusiveOperationQueue(),
			failureInjector: injector,
		}),
	};
	const response = await handleAgentRuntimeRequest(new Request(`https://agent.internal/users/${encodeURIComponent(userId)}${path}`, {
		method,
		headers: { "content-type": "application/json", "x-bickr-user-id": userId, "idempotency-key": key },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	}), {
		...testEnv,
		BICKR_D1: testEnv.BICKR_D1,
		BICKR_KV: testEnv.BICKR_KV,
		BICKR_R2: testEnv.BICKR_R2,
		BICKR_R2_PUBLIC_BASE_URL: testEnv.BICKR_R2_PUBLIC_BASE_URL,
		FORUM_COORDINATOR_SERVICE: forumService,
	} as never, {
		objectId: "failure-user-coordinator",
		ownerUserId: userId,
		queue: new ExclusiveOperationQueue(),
		failureInjector: injector,
	});
	return await response.json() as Record<string, unknown>;
}

async function seedAccount(suffix: string) {
	return upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
		provider: "github",
		subject: `seed-${suffix}`,
		login: `seed-${suffix}`.replaceAll(".", "-").slice(0, 60),
	});
}

function testHandle(value: string): string {
	return value.slice(0, 32);
}

function worldInput(handle: string) {
	const language = parseLanguageTag("en");
	return {
		handle,
		language,
		name: localizedText(handle, language),
		description: localizedText("Description", language),
	};
}

function botInput(handle: string, cloneSourceBotId?: string) {
	const language = parseLanguageTag("en");
	return {
		handle,
		language,
		displayName: localizedText(handle, language),
		shortBio: localizedText("Short bio", language),
		prompt: localizedText("Prompt", language),
		...(cloneSourceBotId ? { cloneSourceBotId } : {}),
	};
}

function importedBotInput(handle: string) {
	return {
		...botInput(handle),
		importSource: {
			provider: "chirper" as const,
			originalHandle: handle,
			originalProfileUrl: `https://chirper.ai/${handle}`,
			apiUrl: `https://api.chirper.ai/v1/agent/${handle}`,
			importedAt: "2026-08-04T00:00:00.000Z",
			sourceAvatarUrl: `https://cdn.chirper.ai/avatars/${handle}.png`,
		},
	};
}

function pngAvatarBytes(): Uint8Array {
	const binary = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function activeProjectionCount(table: string, idColumn: string, id: string): Promise<number> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${idColumn} = ? AND lifecycle_state = 'active'`).bind(id).first<{ count: number }>();
	return row?.count ?? 0;
}

async function lifecycleRequestByKey(userId: string, key: string): Promise<Record<string, unknown>> {
	const row = await testEnv.BICKR_D1
		.prepare(`SELECT request_json AS requestJson FROM entity_lifecycle_operations WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1`)
		.bind(userId, key)
		.first<{ requestJson: string | null }>();
	if (!row?.requestJson) throw new Error(`Lifecycle request ${key} not found.`);
	return JSON.parse(row.requestJson) as Record<string, unknown>;
}
