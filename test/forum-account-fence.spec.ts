import { beforeEach, expect, it } from "vitest";
import { upsertHumanSubscription, applyHumanSubscriptionChanges } from "@bickr/shared/social";
import type { ForumDocument } from "@bickr/shared/model";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { authCookie, createForumForTest, handleForumCoordinatorRequest, jsonRequest, kvKeys, requiredLt, seedWorld, testEnv } from "./helpers/index-harness";

beforeEach(async () => { await resetD1Schema(testEnv.BICKR_D1); await clearKv(testEnv.BICKR_KV); });

async function fixture() {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const forum = await createForumForTest(cookie, "account-fence");
	const document = await testEnv.BICKR_KV.get<ForumDocument>(kvKeys.forum(forum.id), { type: "json" });
	await testEnv.BICKR_D1.prepare(`UPDATE users_index SET lifecycle_state = 'deleting' WHERE user_id = ?`).bind(document!.createdByUserId).run();
	return document!;
}

it("rejects forum publication by a deleting account with a live KV user", async () => {
	const forum = await fixture();
	const request = jsonRequest(`https://internal.bickr/worlds/${forum.worldHandle}/forums`, "POST", { handle: "closed-account-created", language: "en", description: requiredLt("Cannot publish") }, undefined, { "x-bickr-user-id": forum.createdByUserId });
	const response = await handleForumCoordinatorRequest(request, { BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV });
	expect(response.status).toBe(403);
	expect(await testEnv.BICKR_D1.prepare(`SELECT forum_id FROM forums_index WHERE handle = 'closed-account-created'`).first()).toBeNull();
});

it("fences both subscription writers at the same D1 write that would activate the scope", async () => {
	const forum = await fixture();
	const input = { userId: forum.createdByUserId, worldId: forum.worldId, scopeType: "forum" as const, scopeId: forum.id };
	await expect(upsertHumanSubscription(testEnv.BICKR_D1, input)).rejects.toMatchObject({ status: 403 });
	await expect(applyHumanSubscriptionChanges(testEnv.BICKR_D1, forum.createdByUserId, [{ ...input, active: true }])).rejects.toMatchObject({ status: 403 });
	expect(await testEnv.BICKR_D1.prepare(`SELECT subscription_id FROM human_subscriptions WHERE user_id = ? AND scope_type = 'forum' AND scope_id = ?`).bind(forum.createdByUserId, forum.id).first()).toBeNull();
});
