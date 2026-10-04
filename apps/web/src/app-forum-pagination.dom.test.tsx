import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import App from "./App";
import { localizedText, type LanguageTag } from "@bickr/shared/model";

it("retains the committed forum page after failures and ignores late page responses", async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const language = "en" as LanguageTag;
	const text = (value: string) => localizedText(value, language);
	const now = "2026-10-03T00:00:00.000Z";
	const world = {id: "w_pages", handle: "pages", language, name: text("Pages"), description: text("Pages"), prompt: text(""),
		recurringPromptEnabled: false, recurringPrompt: text(""), initialBotNotification: text(""), createdByUserId: "usr_owner", createdAt: now, updatedAt: now, forumCount: 1, botCount: 0};
	const forum = {id: "f_pages", worldId: world.id, worldHandle: world.handle, handle: "pages", language,
		description: text("Pages"), createdByUserId: "usr_owner", readOnly: false, createdAt: now, updatedAt: now};
	const requests: Array<{url: URL; respond: (page: number | null) => void}> = [];
	const oldPath = window.location.pathname;
	window.history.replaceState(null, "", "/w/pages/f/pages");
	vi.stubGlobal("fetch", (input: string) => {
		const url = new URL(String(input), "http://localhost");
		if (url.pathname.endsWith("/threads")) return new Promise<Response>((resolve) => requests.push({url, respond: (page) => resolve(Response.json(page === null
			? {ok: false, error: "server_error", message: "Page failed."}
			: {ok: true, data: {threads: [], loadedAt: now, pagination: {currentPage: page, pageCount: 3, pageSize: 40, total: 81, offset: (page-1)*40, hasMore: page < 3}}}, {status: page === null ? 500 : 200}))}));
		const data = url.pathname === "/api/session" ? {authenticated: false, user: null}
			: url.pathname === "/api/worlds" ? {worlds: [world]}
			: url.pathname.endsWith("/forums") ? {forums: [forum]}
			: url.pathname.endsWith("/bots") ? {bots: []}
			: url.pathname.endsWith("/groups") ? {groups: []} : {};
		return Promise.resolve(Response.json({ok: true, data}));
	});
	const box = document.createElement("div"); document.body.append(box); const root = createRoot(box);
	try {
		await act(async () => root.render(<App />));
		expect(requests).toHaveLength(1);
		await act(async () => requests[0]!.respond(1));
		const select = () => box.querySelector<HTMLButtonElement>('.forum-page-pager button[aria-label="Open page 2"]')!;
		await act(async () => select().click());
		expect(requests[1]!.url.searchParams.get("page")).toBe("2");
		await act(async () => requests[1]!.respond(null));
		expect(box.querySelector('[aria-current="page"]')?.textContent).toBe("1");
		await act(async () => select().click());
		await act(async () => box.querySelector<HTMLButtonElement>(".topbar-refresh")!.click());
		expect(requests[3]!.url.searchParams.get("page")).toBe("1");
		await act(async () => requests[3]!.respond(1));
		await act(async () => requests[2]!.respond(2));
		expect(box.querySelector('[aria-current="page"]')?.textContent).toBe("1");
	} finally {
		await act(async () => root.unmount()); box.remove(); vi.unstubAllGlobals();
		window.history.replaceState(null, "", oldPath);
	}
});
