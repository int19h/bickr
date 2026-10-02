import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localizedText, type LanguageTag, type ForumSummary } from "@bickr/shared/model";
import type { WorldView } from "../../components/content";
import { ForumPage } from "./forum-page";
const language = "en" as LanguageTag;
const now = "2026-07-14T12:00:00.000Z";

const world: WorldView = {
	id: "wld_public",
	handle: "public",
	language,
	name: localizedText("Public", language),
	description: localizedText("A public world.", language),
	prompt: localizedText("Public world prompt.", language),
	recurringPromptEnabled: false,
	recurringPrompt: localizedText("", language),
	initialBotNotification: localizedText("Welcome.", language),
	createdByUserId: "usr_owner",
	createdAt: now,
	updatedAt: now,
	forumCount: 1,
	botCount: 1,
	bannerIdx: 0,
	isMine: false,
	myBotCount: 0,
};

const forum: ForumSummary = {
	id: "frm_public",
	worldId: world.id,
	worldHandle: world.handle,
	handle: "general",
	language,
	description: localizedText("Public discussion.", language),
	createdByUserId: world.createdByUserId,
	readOnly: false,
	createdAt: now,
	updatedAt: now,
};


let root: Root;
let box: HTMLDivElement;
let pending: Map<string, (data: unknown) => void>;
async function render(value = forum) {
	await act(async () => root.render(<ForumPage forum={value} world={world} currentUserId={null} loading={false} threads={[]} ownedBots={[]} subscribed={false} onDeleteForum={async () => true} onDeleteThread={async () => true} onReference={() => {}} onRefresh={async () => []} onToggleSubscription={async () => {}} onUpdateForum={async () => true} />));
}
async function search(value: string) {
	await act(async () => {
		const input = box.querySelector<HTMLInputElement>(".forum-search input")!;
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => vi.advanceTimersByTime(250));
}
async function respond(query: string) {
	await act(async () => pending.get(`/api/worlds/public/forums/general/search?q=${query}`)!({ threads: [{ threadId: `thr_${query}`, title: `${query} result`, snippet: "Snippet", authorHandle: "author", createdAt: now }] }));
}
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers(); pending = new Map();
	vi.stubGlobal("fetch", (url: string) => new Promise<Response>((resolve) => pending.set(url, (data) => resolve(new Response(JSON.stringify({ ok: true, data }))))));
	box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("keeps the newest search when responses arrive out of order", async () => {
	await render(); await search("alpha"); await search("beta"); await respond("beta"); await respond("alpha");
	expect(box.querySelector(".search-results")?.textContent).toContain("beta result");
	expect(box.querySelector(".search-results")?.textContent).not.toContain("alpha result");
});
it("ignores pending results after clearing the query or changing forum", async () => {
	await render(); await search("alpha"); await search(""); await respond("alpha");
	expect(box.querySelector(".search-results")).toBeNull();
	await search("beta"); await render({ ...forum, id: "frm_other", handle: "other" }); await respond("beta");
	expect(box.querySelector<HTMLInputElement>(".forum-search input")?.value).toBe("");
	expect(box.querySelector(".search-results")).toBeNull();
});
