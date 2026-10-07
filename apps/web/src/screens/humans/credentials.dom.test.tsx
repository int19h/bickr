import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountCredentials } from "./credentials";
import type { AccountCredential } from "@bickr/shared/auth-credentials";

let root: Root;
let container: HTMLDivElement;
const credential: AccountCredential = { id: "session:hash", kind: "session", browserDetails: null, isCurrent: true, customName: null, createdAt: "2026-10-02T00:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z" };
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
		expect(container.textContent).toContain("Some older access is not listed");
		await act(async () => button("Revoke all access").click());
		await act(async () => button("Revoke").click());
		expect(container.textContent).toContain("Storage unavailable");
		expect(container.textContent).toContain("Browser session");
		expect(signedOut).not.toHaveBeenCalled();
	});

	it("signs out only after the server accepts all-access revocation", async () => {
		const signedOut = vi.fn();
		const fetcher = vi.fn(async (_path, init) => init.method === "DELETE" ? response({ revoked: true, sessionRevoked: true }) : response(page));
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
		expect(container.textContent).toContain("No active access to show");
		expect(container.textContent).not.toContain("Expires");
	});
});


describe("recognizable account access", () => {
	it("shows app names, browser identity and one kind label per entry", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response({ ...page, credentials: [
			{ ...credential, browserDetails: { browser: "Firefox", operatingSystem: "Linux" } },
			{ ...credential, id: "mcp_grant:one", kind: "mcp_grant", clientId: "bckr_mcp_client_opaque", clientName: "Claude Desktop", scopes: ["bickr.read"] },
			{ ...credential, id: "mcp_grant:two", kind: "mcp_grant", clientId: "bckr_mcp_client_unknown", clientName: null, scopes: [] },
			{ ...credential, id: "cli_token:one", kind: "cli_token", label: "Work terminal" },
		] })));
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={() => undefined} />));
		expect([...container.querySelectorAll(".credential-title")].map((node) => node.textContent))
			.toEqual(["Firefox on Linux", "Claude Desktop", "Unnamed MCP app", "Work terminal"]);
		expect(container.querySelectorAll(".credential-current")).toHaveLength(1);
		expect((container.textContent?.match(/Browser session/g) ?? [])).toHaveLength(1);
		expect(container.querySelectorAll("details")).toHaveLength(4);
		expect(container.textContent).toContain("Read Bickr content");
		expect(button("Sign out")).toBeDefined();
		expect(button("Disconnect")).toBeDefined();
		expect(button("Revoke token")).toBeDefined();
	});

	it("identifies a custom-named connection in its disconnect confirmation", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response({ ...page, credentials: [
			{ ...credential, id: "mcp_grant:one", kind: "mcp_grant", clientId: "client", clientName: "Claude Desktop", customName: "Claude at work", scopes: [] },
		] })));
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={() => undefined} />));
		expect(container.querySelector("details")?.textContent).toContain("Original name: Claude Desktop");
		await act(async () => button("Disconnect").click());
		expect(document.querySelector(".confirm-body")?.textContent).toContain("Claude at work");
		expect(document.querySelector(".confirm-body")?.textContent).toContain("Its access and refresh tokens will no longer work");
		expect(document.querySelector(".confirm-body")?.textContent).not.toContain("browser");
	});

	it("signs out immediately after accepted current-session revocation", async () => {
		const signedOut = vi.fn();
		const fetcher = vi.fn(async (_path, init) => init.method === "DELETE"
			? response({ revoked: true, sessionRevoked: true }) : response(page));
		vi.stubGlobal("fetch", fetcher);
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={signedOut} />));
		await act(async () => button("Sign out").click());
		expect(document.querySelector(".confirm-body")?.textContent).toContain("This signs you out of this browser");
		await act(async () => [...document.querySelectorAll("button")].filter((entry) => entry.textContent === "Sign out").at(-1)!.click());
		expect(signedOut).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls).toHaveLength(2);
	});

	it("reloads the first page after revoking an item on the final page", async () => {
		const fetcher = vi.fn(async (path, init) => init.method === "DELETE" ? response({ revoked: true, sessionRevoked: false })
			: response({ ...page, credentials: [{ ...credential, isCurrent: false }], nextCursor: path.endsWith("after=") ? "page-two" : null }));
		vi.stubGlobal("fetch", fetcher);
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={() => undefined} />));
		await act(async () => button("Next page").click());
		await act(async () => button("Sign out").click());
		expect(document.querySelector(".confirm-body")?.textContent).toContain("selected browser session");
		await act(async () => [...document.querySelectorAll("button")].filter((entry) => entry.textContent === "Sign out").at(-1)!.click());
		expect(fetcher.mock.calls.at(-1)?.[0]).toBe("/api/me/auth/credentials?after=");
	});

	it("keeps a labeled rename editor and its value after a failed write", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_path, init) => init.method === "PATCH"
			? Response.json({ ok: false, error: "server_error", message: "Storage unavailable" }, { status: 503 })
			: response({ ...page, credentials: [{ ...credential, customName: "Work laptop" }] })));
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={() => undefined} />));
		await act(async () => button("Rename").click());
		const input = container.querySelector("input")!;
		expect(container.querySelector("label")?.htmlFor).toBe(input.id);
		expect(input.value).toBe("Work laptop");
		await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Storage unavailable");
		expect(container.querySelector("input")?.value).toBe("Work laptop");
		expect(input.disabled).toBe(false);
	});

	it("ignores a late rename response after the account changes", async () => {
		let finish!: (value: Response) => void;
		const pending = new Promise<Response>((resolve) => { finish = resolve; });
		let reads = 0;
		const fetcher = vi.fn((_path, init) => init.method === "PATCH" ? pending
			: Promise.resolve(response({ ...page, credentials: ++reads === 1 ? [{ ...credential, customName: "Work laptop" }] : [] })));
		vi.stubGlobal("fetch", fetcher);
		await act(async () => root.render(<AccountCredentials userId="usr_one" onSessionRevoked={() => undefined} />));
		await act(async () => button("Rename").click());
		await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
		await act(async () => root.render(<AccountCredentials userId="usr_two" onSessionRevoked={() => undefined} />));
		await act(async () => finish(response({ renamed: true })));
		expect(container.textContent).toContain("No active access to show");
		expect(container.textContent).not.toContain("Work laptop");
		expect(reads).toBe(2);
	});
});
