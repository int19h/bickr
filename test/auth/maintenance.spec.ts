import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { handleAgentRuntimeRequest } from "../../workers/agent-runtime/src/routes";
import { clearKv, resetD1Schema } from "../helpers/d1-schema";

const secret = "auth-maintenance-test-secret";
beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

function call(body: unknown, headers: Record<string, string> = {}) {
	return handleAgentRuntimeRequest(new Request("https://internal.bickr/auth/maintenance", {
		method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
	}), { ...testEnv, INTERNAL_SERVICE_SECRET: secret } as never);
}
const authorized = { "x-bickr-internal-auth": secret, "x-bickr-scheduler": "1" };

describe("protected authentication maintenance", () => {
	it("requires both service authentication and scheduler authority", async () => {
		expect((await call({ kind: "status" })).status).toBe(401);
		expect((await call({ kind: "status" }, { "x-bickr-internal-auth": secret })).status).toBe(401);
		expect((await call({ kind: "status" }, authorized)).status).toBe(200);
	});

	it("allows read-only inspection but requires site maintenance for the persisted sweep", async () => {
		expect((await call({ kind: "dry_run", prefix: "session" }, authorized)).status).toBe(200);
		expect((await call({ kind: "migrate", prefix: "session" }, authorized)).status).toBe(409);
		expect((await call({ kind: "finish" }, authorized)).status).toBe(409);
		await testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = ? WHERE id = 1")
			.bind(new Date().toISOString()).run();
		expect((await call({ kind: "migrate", prefix: "session", cursor: "caller-cursor" }, authorized)).status).toBe(400);
		expect((await call({ kind: "migrate", prefix: "session" }, authorized)).status).toBe(200);
		const finish = await call({ kind: "finish" }, authorized);
		expect(await finish.json()).toMatchObject({ data: { complete: false } });
		const progress = await testEnv.BICKR_D1.prepare("SELECT completed_at AS completedAt FROM auth_migration_progress WHERE prefix = 'session'").first<{ completedAt: string }>();
		expect(progress?.completedAt).toBeTruthy();
	});

	it("keeps bounded retention available during site maintenance", async () => {
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = ? WHERE id = 1").bind(new Date().toISOString()),
			testEnv.BICKR_D1.prepare("INSERT INTO auth_records(record_key, kind, expires_at, document) VALUES ('session:expired', 'session', '2000-01-01T00:00:00.000Z', '{}')"),
		]);
		const response = await call({ kind: "cleanup" }, authorized);
		expect(await response.json()).toMatchObject({ data: { deleted: 1 } });
	});
});
