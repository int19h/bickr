// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslatableText, TranslationContext } from "./content";
import type { MarkdownSourceAccess } from "./markdown-source-view";
import type { LanguageTag } from "@bickr/shared/model";
import { translationCache } from "./translation-cache";

let root: Root;
let box: HTMLDivElement;
const text = "Some **bold** text.";

async function render(access: MarkdownSourceAccess | undefined, value = text, translation = false) {
	await act(async () => root.render(
		<TranslationContext.Provider value={{ enabled: translation, identity: "test", model: "test", prompt: "Translate" }}>
			<TranslatableText as="div" markdown sourceAccess={access} text={{ lang: "en" as LanguageTag, text: value }} />
		</TranslationContext.Provider>,
	));
}
const sourceButton = () => box.querySelector<HTMLButtonElement>('button[aria-label="Show source"], button[aria-label="Show rendered"]');
const textarea = () => box.querySelector<HTMLTextAreaElement>("textarea");
function type(value: string) {
	const area = textarea()!;
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
	setter.call(area, value);
	area.dispatchEvent(new Event("input", { bubbles: true }));
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	window.localStorage.clear(); translationCache.invalidate();
	box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); });

it("shows a Source button only for Markdown with source access, even with translation off", async () => {
	await render(undefined);
	expect(sourceButton()).toBeNull();
	await render({ kind: "readOnly" });
	expect(sourceButton()).not.toBeNull();
	expect(box.querySelector('button[aria-label="Translate"]')).toBeNull();
});

it("shows the stored source read-only to a reader", async () => {
	await render({ kind: "readOnly" });
	expect(box.querySelector("strong")?.textContent).toBe("bold");
	await act(async () => sourceButton()!.click());
	expect(textarea()?.value).toBe(text);
	expect(textarea()?.readOnly).toBe(true);
	expect(button("Save")).toBeUndefined();
	expect(sourceButton()?.getAttribute("aria-pressed")).toBe("true");
	await act(async () => sourceButton()!.click());
	expect(textarea()).toBeNull();
	expect(box.querySelector("strong")?.textContent).toBe("bold");
});

it("hides the translation controls while the source shows", async () => {
	await render({ kind: "readOnly" }, text, true);
	expect(box.querySelector('button[aria-label="Translate"]')).not.toBeNull();
	await act(async () => sourceButton()!.click());
	expect(box.querySelector('button[aria-label="Translate"]')).toBeNull();
});

it("lets the owner edit and save the source", async () => {
	const onSave = vi.fn(async () => true);
	await render({ kind: "editable", onSave });
	await act(async () => sourceButton()!.click());
	expect(textarea()?.readOnly).toBe(false);
	expect(button("Save")?.disabled).toBe(true);
	await act(async () => type("New *text*."));
	expect(button("Save")?.disabled).toBe(false);
	await act(async () => button("Save")!.click());
	// The save names the stored text that the edit started from.
	expect(onSave).toHaveBeenCalledWith("New *text*.", text);
	expect(textarea()).toBeNull();
	await render({ kind: "editable", onSave }, "New *text*.");
	expect(textarea()).toBeNull();
	expect(box.querySelector("em")?.textContent).toBe("text");
});

it("keeps a draft when the stored text changes, and says that a save replaces it", async () => {
	const onSave = vi.fn(async () => true);
	await render({ kind: "editable", onSave });
	await act(async () => sourceButton()!.click());
	await act(async () => type("My draft."));
	await render({ kind: "editable", onSave }, "Edited elsewhere.");
	expect(textarea()?.value).toBe("My draft.");
	expect(box.textContent).toContain("changed while you edited");
	await act(async () => button("Save")!.click());
	expect(onSave).toHaveBeenCalledWith("My draft.", "Edited elsewhere.");
});

it("follows a stored text change when the source view has no unsaved changes", async () => {
	await render({ kind: "readOnly" });
	await act(async () => sourceButton()!.click());
	await render({ kind: "readOnly" }, "Newer text.");
	expect(textarea()?.value).toBe("Newer text.");
	expect(box.textContent).not.toContain("changed while you edited");
});

it("saves with Ctrl+Enter and keeps the draft when the save fails", async () => {
	const onSave = vi.fn(async () => false);
	await render({ kind: "editable", onSave });
	await act(async () => sourceButton()!.click());
	await act(async () => type("Draft."));
	await act(async () => textarea()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
	expect(onSave).toHaveBeenCalledWith("Draft.", text);
	expect(textarea()?.value).toBe("Draft.");
});

it("asks before it discards unsaved changes", async () => {
	await render({ kind: "editable", onSave: async () => true });
	await act(async () => sourceButton()!.click());
	await act(async () => type("Unsaved."));
	await act(async () => sourceButton()!.click());
	expect(document.querySelector('[role="dialog"]')?.textContent).toContain("not saved");
	expect(textarea()?.value).toBe("Unsaved.");
	await act(async () => button("Cancel")!.click());
	expect(textarea()?.value).toBe("Unsaved.");
	await act(async () => sourceButton()!.click());
	await act(async () => button("Discard changes")!.click());
	expect(textarea()).toBeNull();
	await act(async () => sourceButton()!.click());
	expect(textarea()?.value).toBe(text);
});
