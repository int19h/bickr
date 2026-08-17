import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import { lifecycleOperationById } from "@bickr/shared/entity-lifecycle";
import { localizedText } from "@bickr/shared/model";
import { parseLanguageTag } from "@bickr/shared/validation";
import { reserveBotDelete, runBotDeleteOperation } from "../workers/agent-runtime/src/lifecycle/bot";
import type { AgentRuntimeRouteEnv } from "../workers/agent-runtime/src/lifecycle/types";
import { handleForumCoordinatorRequest } from "../workers/forum-coordinator/src/index";
import { createBot, createWorld, upsertProviderUser } from "./helpers/coordinator-mutations";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

/**
 * Deleting a participant used to leave its BotRuntime object holding the whole
 * inner loop forever: the runtime row survives deletion, and nothing ever went
 * back to the object. These cover the delete step that closes that, including
 * what happens when the object refuses.
 */

const internalSecret = "bot-delete-runtime-storage-secret";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("bot delete runtime storage clear", () => {
	it("clears the participant's runtime storage and records the marker", async () => {
		const { botId, env, requests } = await seedDeletableBot("clear", () => Response.json({ ok: true, data: {} }));

		await runDelete(env, botId);

		expect(requests).toEqual([`DELETE /bots/${botId}/storage`]);
		expect(await runtimeStorageClearedAt(botId)).toEqual(expect.any(String));
	});

	it("finishes the deletion and leaves the marker unset when the object refuses the clear", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { botId, env, requests } = await seedDeletableBot("busy", () => new Response("busy", { status: 409 }));

		const operation = await runDelete(env, botId);

		expect(requests).toEqual([`DELETE /bots/${botId}/storage`]);
		// Deletion liveness comes first: the daily fleet sweep retries every
		// tombstoned participant until the marker is set.
		expect(await runtimeStorageClearedAt(botId)).toBeNull();
		expect(await lifecycleOperationById(testEnv.BICKR_D1, operation)).toMatchObject({ phase: "terminal" });
		expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
			event: "bot_delete_runtime_storage_clear_failed",
			botId,
			failure: { kind: "http_response", httpStatus: 409 },
		});
		vi.restoreAllMocks();
	});
});

async function seedDeletableBot(
	suffix: string,
	respond: (request: Request) => Response,
): Promise<{ botId: string; env: AgentRuntimeRouteEnv; requests: string[] }> {
	const owner = await upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
		provider: "github",
		subject: `runtime-clear-${suffix}`,
		login: `runtime-clear-${suffix}`,
	});
	const language = parseLanguageTag("en");
	const world = await createWorld(testEnv.BICKR_KV, testEnv.BICKR_D1, {
		handle: `runtime-clear-${suffix}-home`,
		language,
		name: localizedText(`runtime-clear-${suffix}`, language),
		description: localizedText("Retention world", language),
	}, owner.id);
	const bot = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, world.handle, {
		handle: `runtime-clear-${suffix}`,
		language,
		displayName: localizedText(`runtime-clear-${suffix}`, language),
		shortBio: localizedText("Retention bio", language),
		prompt: localizedText("Retention prompt", language),
	}, owner.id);
	const requests: string[] = [];
	return {
		botId: bot.id,
		requests,
		env: {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			BICKR_R2: testEnv.BICKR_R2,
			BICKR_R2_PUBLIC_BASE_URL: testEnv.BICKR_R2_PUBLIC_BASE_URL,
			INTERNAL_SERVICE_SECRET: internalSecret,
			BOT_RUNTIME: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({
					fetch: async (request: Request) => {
						const url = new URL(request.url);
						requests.push(`${request.method} ${url.pathname}`);
						expect(request.headers.get("x-bickr-scheduler")).toBe("1");
						expect(request.headers.get("x-bickr-user-id")).toBeNull();
						return respond(request);
					},
				}),
			} as unknown as AgentRuntimeRouteEnv["BOT_RUNTIME"],
			FORUM_COORDINATOR_SERVICE: {
				fetch: (request: Request) => handleForumCoordinatorRequest(request, {
					...testEnv,
					INTERNAL_SERVICE_SECRET: internalSecret,
				}, {
					objectId: "runtime-clear-world-coordinator",
					queue: new ExclusiveOperationQueue(),
				}),
				connect: () => {
					throw new Error("Retention tests do not open sockets.");
				},
			},
		},
	};
}

async function runDelete(env: AgentRuntimeRouteEnv, botId: string): Promise<string> {
	const coordinator = {
		objectId: "runtime-clear-user-coordinator",
		ownerUserId: undefined,
		queue: new ExclusiveOperationQueue(),
	};
	const ownerUserId = await botOwnerUserId(botId);
	const request = new Request(`https://agent.internal/users/${ownerUserId}/bots/${botId}`, {
		method: "DELETE",
		headers: { "idempotency-key": `runtime-clear:${botId}`, "x-bickr-user-id": ownerUserId },
	});
	const operation = await reserveBotDelete({ request, env, coordinator }, ownerUserId, botId);
	await runBotDeleteOperation({ env, coordinator }, operation);
	return operation.operationId;
}

async function botOwnerUserId(botId: string): Promise<string> {
	const row = await testEnv.BICKR_D1.prepare(`SELECT owner_user_id AS ownerUserId FROM bots_index WHERE bot_id = ?`)
		.bind(botId)
		.first<{ ownerUserId: string }>();
	if (!row) {
		throw new Error("Seeded participant is missing from bots_index.");
	}
	return row.ownerUserId;
}

async function runtimeStorageClearedAt(botId: string): Promise<string | null> {
	const row = await testEnv.BICKR_D1
		.prepare(`SELECT runtime_storage_cleared_at AS clearedAt FROM bot_runtime_index WHERE bot_id = ?`)
		.bind(botId)
		.first<{ clearedAt: string | null }>();
	return row?.clearedAt ?? null;
}
