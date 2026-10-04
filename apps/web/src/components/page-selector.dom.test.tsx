import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PageSelector } from "./page-selector";

it("keeps large selectors bounded, marks the current page, and disables requests during loading", async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const box = document.createElement("div"); document.body.append(box);
	const root = createRoot(box); const onSelect = vi.fn();
	try {
		await act(async () => root.render(<PageSelector currentPage={50} pageCount={1000} disabled={false} label="Forum pages" onSelect={onSelect} />));
		expect(box.querySelectorAll("button")).toHaveLength(27);
		expect(box.querySelector('[aria-current="page"]')?.textContent).toBe("50");
		await act(async () => box.querySelector<HTMLButtonElement>('button[aria-label="Open page 51"]')!.click());
		expect(onSelect).toHaveBeenCalledWith(51);
		await act(async () => root.render(<PageSelector currentPage={50} pageCount={1000} disabled label="Forum pages" onSelect={onSelect} />));
		expect([...box.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
		await act(async () => root.render(<PageSelector currentPage={1} pageCount={1} disabled={false} label="Forum pages" onSelect={onSelect} />));
		expect(box.querySelector("nav")).toBeNull();
	} finally { await act(async () => root.unmount()); box.remove(); }
});
