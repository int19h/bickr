import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/**
 * Boot as the one place status text survives.
 *
 * The top-bar chip used to carry both the boot progress line and the
 * init-failure message. The chip is gone, so this pins the two halves that
 * replaced it: the boot screen keeps its own status string, and a boot that
 * fails still reports — as an error toast — rather than failing silently.
 */

type PendingResponse = { path: string; respond: (result: { ok: boolean; payload: unknown }) => void };

let container: HTMLDivElement;
let root: Root;
let pending: PendingResponse[];

function respondTo(path: string, result: { ok: boolean; payload: unknown }): void {
	const entry = pending.find((request) => request.path.startsWith(path));
	expect(entry, `no pending request for ${path}`).toBeDefined();
	pending = pending.filter((request) => request !== entry);
	entry!.respond(result);
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

async function boot(): Promise<void> {
	act(() => {
		root.render(<App />);
	});
	await flush();
	respondTo("/api/session", { ok: true, payload: { ok: true, data: { authenticated: false, user: null } } });
	respondTo("/api/worlds", { ok: true, payload: { ok: true, data: { worlds: [] } } });
	await flush();
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	pending = [];
	vi.stubGlobal("fetch", (input: string) =>
		new Promise<Response>((resolve) => {
			pending.push({
				path: String(input),
				respond: ({ ok, payload }) => resolve(new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })),
			});
		}),
	);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
	vi.unstubAllGlobals();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("App boot", () => {
	it("shows the boot status on the loading screen while the first load is in flight", () => {
		act(() => {
			root.render(<App />);
		});

		expect(container.querySelector(".loading-card .sub")?.textContent).toBe("Loading local data...");
	});

	it("reports a failed boot as an error toast instead of a status chip", async () => {
		act(() => {
			root.render(<App />);
		});
		await flush();

		respondTo("/api/session", { ok: true, payload: { ok: true, data: { authenticated: false, user: null } } });
		respondTo("/api/worlds", { ok: false, payload: { ok: false, error: "server_error", message: "Worlds are unavailable." } });
		await flush();

		const toast = container.querySelector(".toast");
		expect(toast?.className).toBe("toast toast-error");
		expect(toast?.querySelector(".toast-message")?.textContent).toBe("Worlds are unavailable.");
		expect(container.querySelector(".status-chip")).toBeNull();
		expect(container.querySelector(".loading-card")).toBeNull();
	});

	it("says nothing at all when the boot succeeds", async () => {
		await boot();

		expect(container.querySelector(".toast")).toBeNull();
		expect(container.querySelector(".status-chip")).toBeNull();
	});

	it("spins the refresh icon for the duration of a refresh and toasts its failure", async () => {
		await boot();

		const refresh = container.querySelector<HTMLButtonElement>(".topbar-refresh");
		expect(refresh?.disabled).toBe(false);
		expect(refresh?.querySelector(".icon-spin")).toBeNull();

		await act(async () => {
			refresh?.click();
		});
		expect(container.querySelector<HTMLButtonElement>(".topbar-refresh")?.disabled).toBe(true);
		expect(container.querySelector(".topbar-refresh .icon-spin")).not.toBeNull();

		respondTo("/api/session", { ok: true, payload: { ok: true, data: { authenticated: false, user: null } } });
		respondTo("/api/worlds", { ok: false, payload: { ok: false, error: "server_error", message: "Worlds are unavailable." } });
		await flush();

		expect(container.querySelector<HTMLButtonElement>(".topbar-refresh")?.disabled).toBe(false);
		expect(container.querySelector(".topbar-refresh .icon-spin")).toBeNull();
		const toast = container.querySelector(".toast");
		expect(toast?.className).toBe("toast toast-error");
		expect(toast?.querySelector(".toast-message")?.textContent).toBe("Worlds are unavailable.");
	});
});
