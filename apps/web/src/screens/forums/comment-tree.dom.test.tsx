import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localizedText, type LanguageTag } from "@bickr/shared/model";
import { CommentTree } from "./comment-tree";
import type { CommentTreeNode } from "./comment-layout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const language = "en" as LanguageTag;
function comment(id: string, parentCommentId?: string, replies: CommentTreeNode[] = []): CommentTreeNode {
	return { id, parentCommentId, replies, threadId: "thr_test", worldId: "wld_test", forumId: "frm_test",
		authorBotId: "bot_test", authorHandle: "tester", authorDisplayName: localizedText("Tester", language),
		body: localizedText(`Body ${id}`, language), voteScore: 0, createdAt: "2026-10-02", updatedAt: "2026-10-02" };
}
const roots = [comment("r", undefined, [comment("a", "r", [comment("b", "a", [comment("c", "b")])])])];
let host: HTMLDivElement;
let root: Root;
let treeWidth: number;
let bodyCap: number;
let viewportWidth: number;
let notifyResize: () => void;
const scroll = vi.fn();
const disconnect = vi.fn();
const props = { forumHandle: "general", implied: new Set<string>(), onReference: () => undefined,
	rootCommentId: "r", selected: { c: true }, subscriptions: [], targetCommentId: null, threadId: "thr_test", worldHandle: "public" };

beforeEach(() => {
	vi.useFakeTimers();
	treeWidth = 358; bodyCap = 1200; viewportWidth = 390;
	vi.spyOn(window, "innerWidth", "get").mockImplementation(() => viewportWidth);
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: () => void) { notifyResize = callback; }
		observe() {} disconnect = disconnect;
	});
	vi.stubGlobal("getComputedStyle", () => ({ gridTemplateColumns: "18px 334px", columnGap: "6px" }));
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return { width: this.classList.contains("comment-width-probe") ? bodyCap : treeWidth } as DOMRect;
	});
	vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scroll);
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount()); host.remove();
	vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); scroll.mockClear(); disconnect.mockClear();
});
async function render(selectable = true, tree = roots) {
	await act(async () => root.render(<CommentTree {...props} roots={tree} onToggle={selectable ? () => undefined : undefined} />));
}
function row(id: string) { return host.querySelector<HTMLElement>(`#comment-${id}`)!; }
function parentButton(id: string) { return row(id).querySelector<HTMLButtonElement>(".comment-parent-link")!; }

describe("responsive comment tree", () => {
	it("keeps rows, text selection, and checkbox identity when indentation changes", async () => {
		await render();
		const original = row("c");
		const checkbox = original.querySelector<HTMLInputElement>("input")!;
		const text = original.querySelector(".markdown-body p")!.firstChild!;
		const range = document.createRange(); range.selectNodeContents(text);
		window.getSelection()!.addRange(range);
		expect(original.dataset.displayDepth).toBe("1");
		await act(async () => { treeWidth = 700; viewportWidth = 732; notifyResize(); });
		expect(original.dataset.displayDepth).toBe("3");
		expect(row("c")).toBe(original);
		expect(original.querySelector("input")).toBe(checkbox);
		expect(checkbox.checked).toBe(true);
		expect(window.getSelection()!.toString()).toBe("Body c");
		await render();
		expect(row("c")).toBe(original);
	});
	it("recalculates for font cap and viewport changes even if container width stays constant", async () => {
		await render();
		await act(async () => { bodyCap = 290; notifyResize(); });
		expect(row("a").dataset.displayDepth).toBe("0");
		await act(async () => { bodyCap = 1200; window.dispatchEvent(new Event("resize")); });
		expect(row("a").dataset.displayDepth).toBe("1");
		await act(async () => { viewportWidth = 1000; window.dispatchEvent(new Event("resize")); });
		expect(row("a").dataset.displayDepth).toBe("0");
	});
	it("scrolls to and highlights the actual parent without navigation, including repeated keyboard activation", async () => {
		await render(false);
		const url = window.location.href;
		expect(parentButton("r")).toBeNull();
		expect(parentButton("c").closest('[aria-hidden="true"]')).toBeNull();
		parentButton("c").focus();
		expect(document.activeElement).toBe(parentButton("c"));
		await act(async () => parentButton("c").click());
		expect(scroll.mock.instances[0]).toBe(row("b"));
		expect(row("b").classList.contains("parent-highlight")).toBe(true);
		expect(row("a").classList.contains("parent-highlight")).toBe(false);
		expect(window.location.href).toBe(url);
		await act(async () => vi.advanceTimersByTime(1000));
		await act(async () => parentButton("c").click());
		await act(async () => vi.advanceTimersByTime(1000));
		expect(row("b").classList.contains("parent-highlight")).toBe(true);
		await act(async () => vi.advanceTimersByTime(800));
		expect(host.querySelector(".parent-highlight")).toBeNull();
	});
	it("disables unavailable parents and cleans observers and highlight timers on unmount", async () => {
		await render(false, [...roots, comment("orphan", "missing")]);
		expect(parentButton("orphan").disabled).toBe(true);
		expect(parentButton("orphan").getAttribute("aria-label")).toBe("Parent comment is unavailable");
		await act(async () => parentButton("c").click());
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		await act(async () => root.unmount());
		expect(disconnect).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		root = createRoot(host);
	});
});
