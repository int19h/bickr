import { describe, expect, it } from "vitest";
import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import { botById } from "@bickr/shared/repository";
import { kvKeys } from "@bickr/shared/storage";
import { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/index";
import {
	authCookie,
	createBotForTest,
	deferred,
	jsonRequest,
	kvWithDelayedFirstPut,
	localizedTextString,
	seedWorld,
	testEnv,
} from "./helpers/index-harness";

describe("UserBotsCoordinator", () => {
	it("serializes racing mutations so the second observes the first write", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "user-coordinator-race");
		const owner = await testEnv.BICKR_D1.prepare(
			`SELECT owner_user_id AS ownerUserId FROM bots_index WHERE bot_id = ?`,
		)
			.bind(bot.id)
			.first<{ ownerUserId: string }>();
		if (!owner) {
			throw new Error("Seeded bot owner was not indexed.");
		}

		const firstPutStarted = deferred<void>();
		const releaseFirstPut = deferred<void>();
		const kv = kvWithDelayedFirstPut(testEnv.BICKR_KV, kvKeys.bot(bot.id), firstPutStarted, releaseFirstPut);
		const context = {
			objectId: "user-coordinator-race",
			queue: new ExclusiveOperationQueue(),
		};
		const env = { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: kv };
		const first = handleAgentRuntimeRequest(
			patchBotRequest(owner.ownerUserId, bot.id, { shortBio: "First mutation committed." }),
			env,
			context,
		);
		await firstPutStarted.promise;
		const second = handleAgentRuntimeRequest(
			patchBotRequest(owner.ownerUserId, bot.id, { displayName: "Second Mutation" }),
			env,
			context,
		);

		// Give an unserialized second request time to read the pre-mutation KV
		// document while the first write is paused. The coordinator queue keeps
		// it outside the handler until the first request has fully committed.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		releaseFirstPut.resolve();

		const [firstResponse, secondResponse] = await Promise.all([first, second]);
		expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
		expect(secondResponse.status, await secondResponse.clone().text()).toBe(200);
		const secondPayload = (await secondResponse.json()) as {
			data: { bot: { displayName: Parameters<typeof localizedTextString>[0]; shortBio: Parameters<typeof localizedTextString>[0] } };
		};
		expect(localizedTextString(secondPayload.data.bot.displayName)).toBe("Second Mutation");
		expect(localizedTextString(secondPayload.data.bot.shortBio)).toBe("First mutation committed.");

		const stored = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id);
		expect(localizedTextString(stored.displayName)).toBe("Second Mutation");
		expect(localizedTextString(stored.shortBio)).toBe("First mutation committed.");
	});
});

function patchBotRequest(userId: string, botId: string, update: { displayName?: string; shortBio?: string }): Request {
	return jsonRequest(
		`https://internal.bickr/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(botId)}`,
		"PATCH",
		{ language: "en", ...update },
		undefined,
		{ "x-bickr-user-id": userId },
	);
}
