import { beforeEach, describe, expect, it } from "vitest";
import forumWorker from "../workers/forum-coordinator/src/index";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { contextFor, jsonRequest, testEnv, testServiceProxy } from "./helpers/index-harness";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
	await testEnv.BICKR_D1.prepare(`UPDATE maintenance_control SET enabled = 1, activated_at = '2026-10-02T00:00:00Z' WHERE id = 1`).run();
});

const env = () => ({ BICKR_D1: testEnv.BICKR_D1, BICKR_KV: testEnv.BICKR_KV, INTERNAL_SERVICE_SECRET: "warmup-secret" }) as Parameters<typeof forumWorker.fetch>[1];

function request(path: string, method = "POST", scheduler = true) {
	return new Request(`https://internal.bickr${path}`, { method, headers: {
		"x-bickr-internal-auth": "warmup-secret", ...(scheduler ? { "x-bickr-scheduler": "1" } : {}),
	} });
}

describe("forum search maintenance routes", () => {
	it("allows bounded warmup while maintenance remains enabled and rejects ordinary mutations", async () => {
		expect((await forumWorker.fetch(request("/maintenance/search-index/rebuild", "POST", false) as never, env())).status).toBe(403);
		expect((await forumWorker.fetch(new Request("https://public.example/maintenance/search-index/rebuild", { method: "POST" }) as never, env())).status).toBe(404);
		const result = await forumWorker.fetch(request("/maintenance/search-index/rebuild") as never, env());
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({ data: { processed: 0, remaining: false } });
		const status = await forumWorker.fetch(request("/maintenance/search-index/status", "GET") as never, env());
		expect(await status.json()).toMatchObject({ data: { ready: true } });
		expect((await forumWorker.fetch(request("/worlds/patch-notes/forums") as never, env())).status).toBe(503);
		expect((await forumWorker.fetch(request("/maintenance/search-index/status") as never, env())).status).toBe(503);
	});

	it("uses the same exact route classification in the authenticated test proxy", async () => {
		const invoke = (service: string, path: string) => testServiceProxy(contextFor<typeof testServiceProxy>(jsonRequest(
			"https://test.bickr.social/api/__test__/service-proxy", "POST",
			{ service, method: "POST", path, headers: { "x-bickr-scheduler": "1" } }, undefined, { "x-test-auth-secret": "test-secret" },
		), {}, {
			TEST_AUTH_SECRET: "test-secret", TEST_AUTH_ALLOWED_HOSTS: "test.bickr.social,test.bickr.pages.dev", INTERNAL_SERVICE_SECRET: "warmup-secret",
			FORUM_COORDINATOR_SERVICE: { fetch: (inner: Request) => forumWorker.fetch(inner as never, env()) } as Fetcher,
		}));
		expect((await invoke("forum-coordinator", "/maintenance/search-index/rebuild")).status).toBe(200);
		expect((await invoke("forum-coordinator", "/maintenance/search-index/rebuild/other")).status).toBe(503);
		expect((await invoke("agent-runtime", "/maintenance/search-index/rebuild")).status).toBe(503);
	});
});
