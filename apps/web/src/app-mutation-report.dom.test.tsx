import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/**
 * One click, one report.
 *
 * Now that outcomes are toasts, a mutation reported by both `App` and the
 * screen that triggered it stacks two toasts saying the same thing — and, when
 * the two messages disagree, contradicts itself. `App` owns these mutations and
 * reports for every entry point, so it is the single reporter; this drives a
 * real screen-initiated mutation through the real `App` and counts what the
 * user ends up seeing.
 */

type Handler = (path: string, init: RequestInit | undefined) => { ok: boolean; payload: unknown };

const user = {
	id: "usr_self",
	handle: "self",
	language: null,
	displayName: { text: "Self", language: null },
	profileComplete: true,
};

const createdWorld = {
	id: "wld_new",
	handle: "saltmarsh",
	language: "en",
	name: { text: "Saltmarsh", language: "en" },
	description: { text: "A failing literary magazine.", language: "en" },
	prompt: { text: "", language: "en" },
	recurringPromptEnabled: false,
	recurringPrompt: { text: "", language: "en" },
	initialBotNotification: { text: "", language: "en" },
	createdByUserId: user.id,
	createdAt: "2026-08-16T00:00:00.000Z",
	updatedAt: "2026-08-16T00:00:00.000Z",
};

/** Only the routes this flow actually touches; anything else answers empty. */
const routes: Array<[RegExp, Handler]> = [
	[/^\/api\/session/, () => ({ ok: true, payload: { ok: true, data: { authenticated: true, user } } })],
	[/^\/api\/worlds$/, (_path, init) =>
		init?.method === "POST" ?
			{ ok: true, payload: { ok: true, data: { world: createdWorld } } }
		:	{ ok: true, payload: { ok: true, data: { worlds: [] } } }],
	// Creating a world navigates into it, which loads these three.
	[/^\/api\/worlds\/[^/]+\/forums/, () => ({ ok: true, payload: { ok: true, data: { forums: [] } } })],
	[/^\/api\/worlds\/[^/]+\/bots/, () => ({ ok: true, payload: { ok: true, data: { bots: [] } } })],
	[/^\/api\/worlds\/[^/]+\/groups/, () => ({ ok: true, payload: { ok: true, data: { groups: [] } } })],
	[/^\/api\/me\/profile/, () => ({ ok: true, payload: { ok: true, data: { profile: { user, inferenceSettings: {} } } } })],
	[/^\/api\/me\/bots/, () => ({ ok: true, payload: { ok: true, data: { bots: [] } } })],
	[/^\/api\/me\/notifications/, () => ({ ok: true, payload: { ok: true, data: { unreadCount: 0, notifications: [] } } })],
	[/^\/api\/me\/subscriptions/, () => ({ ok: true, payload: { ok: true, data: { subscriptions: [] } } })],
];

let container: HTMLDivElement;
let root: Root;

function respond(path: string, init: RequestInit | undefined): Response {
	const route = routes.find(([pattern]) => pattern.test(path));
	const result = route ? route[1](path, init) : { ok: true, payload: { ok: true, data: {} } };
	return new Response(JSON.stringify(result.payload), { status: result.ok ? 200 : 500 });
}

async function flush(): Promise<void> {
	for (let pass = 0; pass < 6; pass += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

function button(label: string, selector = ""): HTMLButtonElement {
	const found = Array.from(container.querySelectorAll(`${selector} button`.trim())).find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	expect(found, `no button labelled ${label}`).toBeDefined();
	return found as HTMLButtonElement;
}

/** Controlled inputs only see a value written through the native setter. */
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	window.history.replaceState({}, "", "/");
	vi.stubGlobal("fetch", (input: string, init?: RequestInit) => Promise.resolve(respond(String(input), init)));
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root.render(<App />);
	});
	await flush();
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
	vi.unstubAllGlobals();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("screen-driven mutations", () => {
	it("reports creating a world exactly once", async () => {
		act(() => {
			button("New world").click();
		});

		const name = container.querySelector<HTMLInputElement>(".modal input.input");
		const description = container.querySelector<HTMLTextAreaElement>(".modal textarea.textarea");
		expect(name).not.toBeNull();
		expect(description).not.toBeNull();
		act(() => {
			type(name!, "Saltmarsh");
		});
		act(() => {
			type(description!, "A failing literary magazine.");
		});

		act(() => {
			button("Create world", ".modal-foot").click();
		});
		await flush();

		const toasts = Array.from(container.querySelectorAll(".toast"));
		expect(toasts.map((toast) => toast.querySelector(".toast-message")?.textContent)).toEqual([
			"Created world saltmarsh.",
		]);
	});
});
