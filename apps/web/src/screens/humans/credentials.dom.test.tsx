import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountCredentials } from "./credentials";

let root: Root;
let container: HTMLDivElement;
const credential = { id: "session:hash", kind: "session", label: "Browser session", createdAt: "2026-10-02T00:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z", revokedAt: null };
const page = { credentials: [credential], nextCursor: null, legacyMigrationComplete: false };
const response = (data: unknown) => Response.json({ ok: true, data });

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
function button(label: string) {
	return [...document.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
}

describe("account credential access", () => {
	it("keeps access visible and reports a failed revocation", async () => {
		const signedOut = vi.fn();
		vi.stubGlobal("fetch", vi.fn(async (_path, init) => init.method === "DELETE"
			? Response.json({ ok: false, error: "server_error", message: "Storage unavailable" }, { status: 503 }) : response(page)));
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={signedOut} />));
		expect(container.textContent).toContain("Some older credentials are not listed yet");
		await act(async () => button("Revoke all access").click());
		await act(async () => button("Revoke").click());
		expect(container.textContent).toContain("Storage unavailable");
		expect(container.textContent).toContain("Browser session");
		expect(signedOut).not.toHaveBeenCalled();
	});

	it("signs out only after the server accepts all-access revocation", async () => {
		const signedOut = vi.fn();
		const fetcher = vi.fn(async (_path, init) => init.method === "DELETE" ? response({ revoked: true }) : response(page));
		vi.stubGlobal("fetch", fetcher);
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={signedOut} />));
		await act(async () => button("Revoke all access").click());
		await act(async () => button("Revoke").click());
		expect(signedOut).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls.find((call) => call[1].method === "DELETE")?.[1].body).toBe('{"kind":"all"}');
	});

	it("ignores a late credential response after the account changes", async () => {
		let finish!: (value: Response) => void;
		const old = new Promise<Response>((resolve) => { finish = resolve; });
		let reads = 0;
		vi.stubGlobal("fetch", () => ++reads === 1 ? old : Promise.resolve(response({ ...page, credentials: [] })));
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={() => undefined} />));
		await act(async () => root.render(<AccountCredentials userId="usr_two" onSessionRevoked={() => undefined} />));
		await act(async () => finish(response(page)));
		expect(container.textContent).toContain("No credentials on this page");
		expect(container.textContent).not.toContain("Expires");
	});
});
