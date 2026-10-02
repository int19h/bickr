import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslatableText, TranslationContext } from "./content";
import { translationCache } from "./translation-cache";
let root: Root;
let box: HTMLDivElement;
const json = (translation: string) => new Response(JSON.stringify({ ok: true, data: { translation } }));
async function render(text: string) {
	await act(async () => root.render(<TranslationContext.Provider value={{ enabled: true, identity: "test", model: "test", prompt: "Translate" }}><TranslatableText text={text} /></TranslationContext.Provider>));
}
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	window.localStorage.clear(); translationCache.invalidate();
	box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.unstubAllGlobals(); });
it("never displays a cached translation for a colliding old hash", async () => {
	const fetch = vi.fn(async () => json("Translation of Aa")); vi.stubGlobal("fetch", fetch);
	await render("You owe Aa."); await act(async () => box.querySelector<HTMLButtonElement>("button")!.click());
	expect(box.querySelector(".translatable-content")?.textContent).toBe("Translation of Aa");
	await render("You owe BB.");
	expect(box.querySelector(".translatable-content")?.textContent).toBe("You owe BB.");
	expect(fetch).toHaveBeenCalledTimes(1);
	await render("You owe Aa."); expect(box.querySelector(".translatable-content")?.textContent).toBe("Translation of Aa");
});
it("ignores a pending translation after its source changes", async () => {
	let finish!: (response: Response) => void;
	vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
	await render("First source"); await act(async () => box.querySelector<HTMLButtonElement>("button")!.click());
	await render("Second source"); await act(async () => finish(json("First translation")));
	expect(box.querySelector(".translatable-content")?.textContent).toBe("Second source");
	expect(box.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
});
