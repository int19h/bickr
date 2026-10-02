import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { handleAgentRuntimeRequest } from "../../workers/agent-runtime/src/routes";
import { onRequestPost as serviceProxy } from "../../apps/web/functions/api/__test__/service-proxy";
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

	it("rejects oversized input before parsing it", async () => {
		expect((await call({ kind: "status", extra: "x".repeat(8192) }, authorized)).status).toBe(413);
	});

	it("ends a stalled body read at the request deadline", async () => {
		vi.useFakeTimers();
		try {
			let cancelled = false;
			const response = handleAgentRuntimeRequest(new Request("https://internal.bickr/auth/maintenance", {
				method: "POST", headers: authorized,
				body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
			}), { ...testEnv, INTERNAL_SERVICE_SECRET: secret } as never);
			await vi.advanceTimersByTimeAsync(10_000);
			expect((await response).status).toBe(408);
			expect(cancelled).toBe(true);
		} finally { vi.useRealTimers(); }
	});

	it("routes protected auth maintenance through the test proxy during maintenance", async () => {
		await testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = '2026-10-02T00:00:00.000Z' WHERE id = 1").run();
		const proxyEnv = {
			...testEnv, INTERNAL_SERVICE_SECRET: secret, TEST_AUTH_SECRET: "proxy-secret", TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social",
			AGENT_RUNTIME: { fetch(request: Request) { return handleAgentRuntimeRequest(request, { ...testEnv, INTERNAL_SERVICE_SECRET: secret } as never); } },
		};
		const proxyCall = (path: string, headers: Record<string, string>) => serviceProxy({ env: proxyEnv, request: new Request("https://test.bickr.social/api/__test__/service-proxy", {
			method: "POST", headers: { "content-type": "application/json", "x-test-auth-secret": "proxy-secret" },
			body: JSON.stringify({ service: "agent-runtime", method: "POST", path, headers, body: { kind: "migrate", prefix: "session" } }),
		}) } as never);
		expect((await proxyCall("/auth/maintenance", { "x-bickr-scheduler": "1" })).status).toBe(200);
		expect((await proxyCall("/auth/maintenance", {})).status).toBe(401);
		expect((await proxyCall("/bots/example/tick", { "x-bickr-scheduler": "1" })).status).toBe(503);
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
