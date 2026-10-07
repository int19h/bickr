import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InstructionLanguageField } from "./instruction-language-field";

it("offers source inheritance only for linked clones and keeps fixed languages separate from Auto", async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const box = document.createElement("div"); document.body.append(box);
	const root = createRoot(box); const onChange = vi.fn();
	try {
		await act(async () => root.render(<InstructionLanguageField value={{ kind: "auto" }} onChange={onChange} linkedClone={false} />));
		expect(box.querySelector('option[value="source"]')).toBeNull();
		const select = box.querySelector("select")!;
		await act(async () => { select.value = "ja"; select.dispatchEvent(new Event("change", { bubbles: true })); });
		expect(onChange).toHaveBeenLastCalledWith({ kind: "fixed", locale: "ja" });
		await act(async () => root.render(<InstructionLanguageField value={{ kind: "source" }} onChange={onChange} linkedClone />));
		expect(box.querySelector("select")?.value).toBe("source");
		await act(async () => { select.value = "auto"; select.dispatchEvent(new Event("change", { bubbles: true })); });
		expect(onChange).toHaveBeenLastCalledWith({ kind: "auto" });
	} finally { await act(async () => root.unmount()); box.remove(); }
});
