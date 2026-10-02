import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { internalServiceAuthHeader } from "@bickr/shared/internal-service";
import { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/routes";
import { accountIndexRepairEnvironment } from "../workers/agent-runtime/src/index-repair-owner";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

const secret = "repair-test-secret";
const ownerId = "usr_repair";
const env = { ...testEnv, INTERNAL_SERVICE_SECRET: secret };

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("account index repair ownership", () => {
	it("requires service authentication, scheduler identity, and the exact account coordinator", async () => {
		const headers = { [internalServiceAuthHeader]: secret, "x-bickr-scheduler": "1", "x-bickr-user-id": ownerId };
		for (const omitted of [internalServiceAuthHeader, "x-bickr-scheduler", "x-bickr-user-id"]) {
			const invalid = new Headers(headers);
			invalid.delete(omitted);
			expect((await callRepair(invalid, ownerId)).status).toBe(401);
		}
		expect((await callRepair(new Headers(headers), "usr_other")).status).toBe(403);
		expect((await callRepair(new Headers(headers), ownerId)).status).toBe(200);
	});

	it("repairs its own account without routing back into the held account queue", async () => {
		let forwarded = 0;
		const service = { fetch: async () => {
			forwarded += 1;
			return Response.json({ data: { repair: { kind: "missing" } } });
		} };
		const owned = accountIndexRepairEnvironment({ ...env, FORUM_COORDINATOR_SERVICE: service }, ownerId);
		expect(await owned.repairOwnedObject({ entityType: "user", id: ownerId })).toEqual({ kind: "missing" });
		expect(forwarded).toBe(0);
		await owned.repairOwnedObject({ entityType: "user", id: "usr_other" });
		expect(forwarded).toBe(1);
	});

	it("refuses repairs for other writers when the service binding is absent", async () => {
		const owned = accountIndexRepairEnvironment({ BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV }, ownerId);
		await expect(owned.repairOwnedObject({ entityType: "thread", id: "thr_other" })).rejects.toMatchObject({ code: "server_error" });
	});
});

function callRepair(headers: Headers, coordinatorOwner: string) {
	return handleAgentRuntimeRequest(new Request(`https://internal.bickr/users/${ownerId}/repair-index`, {
		method: "POST", headers, body: "{}",
	}), env as never, { objectId: coordinatorOwner, ownerUserId: coordinatorOwner });
}
