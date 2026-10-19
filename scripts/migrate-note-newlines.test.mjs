import { describe, expect, it, vi } from "vitest";
import { applyManifest, assertManifest, classifyFailure, createProxy, fleetQuery, migrationPlan } from "./migrate-note-newlines.mjs";

const ready = (digest = "digest-a") => ({ kind: "ready", schemaVersion: 1, digest, notes: [{ id: "PLAN", before: "private\\ntext", after: "private\ntext" }], messages: [], ambiguousNotes: [], ambiguousMessages: [] });
const manifest = () => ({ kind: "note-newlines-preview", schemaVersion: 1, environment: "test", complete: true, bots: [{ botId: "bot-a", migration: ready() }] });
const report = () => ({ results: {} });

describe("note newline fleet driver", () => {
	it("bounds the indexed keyset query and escapes cursors", () => {
		expect(fleetQuery("bot'z")).toContain("bot_id > 'bot''z'");
		expect(fleetQuery()).toContain("deleted_at IS NULL AND lifecycle_state IN ('active', 'pending') ORDER BY bot_id LIMIT 100");
		expect(() => fleetQuery("", 101)).toThrow();
	});

	it("binds every environment to the release configuration", () => {
		expect(migrationPlan("test").origin).toBe("https://test.bickr.social");
		expect(migrationPlan("production").workers[0].config[3]).toContain("wrangler.deploy.jsonc");
		expect(() => migrationPlan("staging")).toThrow();
		expect(migrationPlan("production", "http://127.0.0.1:8788").origin).toBe("http://127.0.0.1:8788");
		expect(() => migrationPlan("production", "https://other.example")).toThrow();
		expect(() => migrationPlan("production", "http://localhost/private")).toThrow();
		expect(() => migrationPlan("production", "http://secret@localhost")).toThrow();
		expect(() => assertManifest(manifest(), "production")).toThrow();
		expect(() => assertManifest({ ...manifest(), bots: [{ botId: "bot-a", migration: { kind: "ready" } }] }, "test")).toThrow();
	});

	it("sends an explicit test cookie without leaking the secret into the payload", async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { migration: ready() } })));
		await createProxy(migrationPlan("test"), "secret", fetcher)("bot/a", { mode: "inspect" });
		const [url, request] = fetcher.mock.calls[0];
		expect(url).toBe("https://test.bickr.social/api/__test__/service-proxy");
		expect(request.headers.cookie).toBe("bickr_test_environment=1");
		expect(request.headers["x-test-auth-secret"]).toBe("secret");
		expect(request.body).not.toContain("secret");
		expect(JSON.parse(request.body).path).toBe("/bots/bot%2Fa/notes/newlines-migration");
		expect(request.signal).toBeInstanceOf(AbortSignal);
		expect(request.redirect).toBe("error");
	});

	it("uses structured pending and conflict causes", () => {
		expect(classifyFailure(409, { details: { noteMigrationCause: "pending_tool" } }).kind).toBe("pending_tool");
		expect(classifyFailure(409, { details: { noteMigrationCause: "snapshot_changed" } }).kind).toBe("snapshot_changed");
		expect(classifyFailure(409, { error: { message: "anything" } }).kind).toBe("busy");
		expect(classifyFailure(500, {}).kind).toBe("failed");
	});

	it("refuses a changed snapshot and leaves busy participants for a later pass", async () => {
		for (const current of [ready("new-digest"), { kind: "busy" }, { kind: "pending_tool" }]) {
			const proxy = vi.fn(async () => current);
			const output = await applyManifest(manifest(), report(), proxy, vi.fn());
			expect(proxy).toHaveBeenCalledTimes(1);
			expect(output.results["bot-a"].kind).toBe(current.kind === "ready" ? "snapshot_changed" : current.kind);
		}
	});

	it("uses only the backed-up digest and persists each result", async () => {
		const proxy = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce({ kind: "applied", completion: { schemaVersion: 1 } });
		const persist = vi.fn();
		await applyManifest(manifest(), report(), proxy, persist);
		expect(proxy.mock.calls[1]).toEqual(["bot-a", { mode: "apply", expectedDigest: "digest-a" }]);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("resolves uncertain writes through durable status without replaying apply", async () => {
		const proxy = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce({ kind: "request_uncertain" }).mockResolvedValueOnce({ kind: "already_applied", completion: { schemaVersion: 1 } });
		const output = await applyManifest(manifest(), report(), proxy, vi.fn());
		expect(proxy.mock.calls.map((call) => call[1].mode)).toEqual(["inspect", "apply", "inspect"]);
		expect(output.results["bot-a"].kind).toBe("already_applied");
	});

	it("keeps preview failures visible in the apply report", async () => {
		const input = { ...manifest(), bots: [{ botId: "busy-bot", migration: { kind: "busy" } }] };
		const proxy = vi.fn();
		const output = await applyManifest(input, report(), proxy, vi.fn());
		expect(output.results["busy-bot"].kind).toBe("busy");
		expect(proxy).not.toHaveBeenCalled();
	});

	it("resumes without rewriting completed participants or replacing their backups", async () => {
		const input = manifest();
		const original = JSON.stringify(input);
		const proxy = vi.fn();
		await applyManifest(input, { results: { "bot-a": { kind: "applied" } } }, proxy, vi.fn());
		expect(proxy).not.toHaveBeenCalled();
		expect(JSON.stringify(input)).toBe(original);
	});
});
