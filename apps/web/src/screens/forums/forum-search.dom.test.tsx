import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localizedText, type LanguageTag, type ForumSummary, type ThreadSummary } from "@bickr/shared/model";
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
async function render(value = forum, extra: Partial<ComponentProps<typeof ForumPage>> = {}) {
	await act(async () => root.render(<ForumPage forum={value} world={world} currentUserId={null} loading={false} threads={[]} ownedBots={[]} subscribed={false} onDeleteForum={async () => true} onDeleteThread={async () => true} onReference={() => {}} onRefresh={async () => []} onToggleSubscription={async () => {}} onUpdateForum={async () => true} {...extra} />));
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

it("requests numbered forum pages, preserves state on failure, and clears page selections on success", async () => {
	const thread: ThreadSummary = { id: "thr_page", rootCommentId: "cmt_page", worldId: world.id, worldHandle: world.handle,
		forumId: forum.id, forumHandle: forum.handle, authorBotId: "bot_author", authorHandle: "author",
		authorDisplayName: localizedText("Author", language), title: localizedText("Page thread", language),
		bodyPreview: localizedText("Preview", language), voteScore: 1, commentCount: 2, createdAt: now, lastActivityAt: now };
	const onRefresh = vi.fn(async () => []);
	const base = {currentUserId: "usr_reader", threads: [thread], onRefresh,
		pagination: {sort: "recent", currentPage: 2, pageCount: 3, pageSize: 40, total: 81, offset: 40, hasMore: true}};
	await render(forum, base);
	await act(async () => box.querySelector<HTMLInputElement>(`.thread-row input[type="checkbox"]`)!.click());
	expect(box.querySelector(".spot-select-head")?.textContent).toContain("1 selected");
	await act(async () => box.querySelector<HTMLButtonElement>('.forum-page-pager button[aria-label="Open page 3"]')!.click());
	expect(onRefresh).toHaveBeenLastCalledWith("recent", 3);
	await render(forum, {...base, loading: true});
	expect(box.querySelector('[aria-current="page"]')?.textContent).toBe("2");
	expect(box.querySelector<HTMLButtonElement>('.forum-page-pager button')?.disabled).toBe(true);
	// Failed requests leave the same committed props, rows, and selection.
	await render(forum, base);
	expect(box.querySelector('[aria-current="page"]')?.textContent).toBe("2");
	expect(box.querySelector(".spot-select-head")?.textContent).toContain("1 selected");
	await render(forum, {...base, pagination: {...base.pagination, currentPage: 3, offset: 80, hasMore: false}, threads: [{...thread, id: "thr_next"}]});
	expect(box.querySelector('[aria-current="page"]')?.textContent).toBe("3");
	expect(box.querySelector<HTMLInputElement>('.thread-row input[type="checkbox"]')?.checked).toBe(false);
	await act(async () => [...box.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === "Hot")!.click());
	expect(onRefresh).toHaveBeenLastCalledWith("hot", 1);
});
