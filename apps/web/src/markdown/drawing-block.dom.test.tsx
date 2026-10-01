// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrawingBlock } from "./drawing-block";
import { MarkdownBody } from "./markdown-body";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(source: string, lazy = false) {
	if (!lazy) vi.stubGlobal("IntersectionObserver", undefined);
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
	await act(async () => root!.render(<DrawingBlock language="mermaid" source={source} />));
	return container.querySelector("iframe")!;
}
async function message(source: Window, data: unknown) { await act(async () => window.dispatchEvent(new MessageEvent("message", { source, data }))); }
describe("Mermaid frame lifecycle", () => {
	it("binds messages to the exact frame and token and clamps the height", async () => {
		const frame = await mount("graph TD; A-->B");
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(frame.getAttribute("src")).toBe("/diagram-renderer");
		const send = vi.spyOn(frame.contentWindow!, "postMessage");
		await message(window, { kind: "loaded" }); expect(send).not.toHaveBeenCalled();
		await message(frame.contentWindow!, { kind: "loaded" });
		const request = send.mock.calls[0]![0] as { token: string };
		await message(frame.contentWindow!, { kind: "ready", token: "wrong", height: 200 });
		expect(container.textContent).toContain("Rendering drawing");
		await message(frame.contentWindow!, { kind: "ready", token: request.token, height: 100000 });
		expect(frame.style.height).toBe("1200px");
		expect(container.textContent).not.toContain("Rendering drawing");
	});
	it("retains escaped source if the frame fails to start", async () => {
		vi.useFakeTimers(); await mount("graph TD; A-->B");
		await act(async () => vi.advanceTimersByTime(15000));
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector("details")?.open).toBe(true);
		expect(container.querySelector("code")?.textContent).toBe("graph TD; A-->B");
	});
	it("rejects author configuration before creating a frame", async () => {
		await mount('%%{init: {"securityLevel":"loose"}}%%\ngraph TD; A-->B');
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector("[role=status]")?.textContent).toContain("configuration");
	});
	it("accepts later height updates without replacing the frame", async () => {
		const frame = await mount("graph TD; A-->B");
		const send = vi.spyOn(frame.contentWindow!, "postMessage"); await message(frame.contentWindow!, { kind: "loaded" });
		const token = (send.mock.calls[0]![0] as { token: string }).token;
		await message(frame.contentWindow!, { kind: "ready", token, height: 700 });
		await message(frame.contentWindow!, { kind: "ready", token, height: 150 });
		expect(container.querySelector("iframe")).toBe(frame); expect(frame.style.height).toBe("150px");
	});
	it("reserves measured geometry during offscreen suspension", async () => {
		let visibility: (entries: { isIntersecting: boolean }[]) => void = () => {};
		vi.stubGlobal("IntersectionObserver", class {
			constructor(callback: typeof visibility) { visibility = callback; }
			observe() {} disconnect() {}
		});
		await mount("graph TD; A-->B", true);
		expect(container.querySelector("iframe")).toBeNull();
		await act(async () => visibility([{ isIntersecting: true }]));
		const frame = container.querySelector("iframe")!;
		const send = vi.spyOn(frame.contentWindow!, "postMessage"); await message(frame.contentWindow!, { kind: "loaded" });
		const token = (send.mock.calls[0]![0] as { token: string }).token;
		await message(frame.contentWindow!, { kind: "ready", token, height: 728 });
		await act(async () => visibility([{ isIntersecting: false }]));
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector<HTMLElement>('[aria-hidden="true"]')?.style.height).toBe("728px");
		await act(async () => visibility([{ isIntersecting: true }]));
		expect(container.querySelector<HTMLIFrameElement>("iframe")?.style.height).toBe("728px");
	});
	it("resets measurement and rejects old messages when source changes", async () => {
		const frame = await mount("graph TD; A-->B");
		const send = vi.spyOn(frame.contentWindow!, "postMessage"); await message(frame.contentWindow!, { kind: "loaded" });
		const token = (send.mock.calls[0]![0] as { token: string }).token;
		await message(frame.contentWindow!, { kind: "ready", token, height: 700 });
		await act(async () => root!.render(<DrawingBlock language="mermaid" source="graph LR; C-->D" />));
		const replacement = container.querySelector("iframe")!;
		expect(replacement).not.toBe(frame); expect(replacement.style.height).toBe("180px");
		await message(frame.contentWindow!, { kind: "ready", token, height: 1000 });
		expect(replacement.style.height).toBe("180px");
	});
	it("keeps root and nested-list frames across unchanged Markdown renders", async () => {
		for (const source of ["```mermaid\ngraph TD; A-->B\n```", "- Diagram\n\n  ```mermaid\n  graph TD; A-->B\n  ```"]) {
			await mount("graph TD; A-->B");
			const render = () => <MarkdownBody text={source} referencePattern={/never/g} renderText={(value) => value} renderPlain={(value) => value} />;
			await act(async () => root!.render(render())); const frame = container.querySelector("iframe")!;
			expect(frame).not.toBeNull(); await act(async () => root!.render(render()));
			expect(container.querySelector("iframe")).toBe(frame);
			await act(async () => root!.unmount()); root = undefined; container.remove();
		}
	});

	it("preserves selection and loaded images while using current callbacks", async () => {
		await mount("graph TD; A-->B");
		const text = "Selectable verse\nsecond line\n\n![Picture](https://example.invalid/image.svg)";
		const render = (value = text, suffix = "") => <MarkdownBody text={value} referencePattern={/never/g} renderText={(value) => value} renderPlain={(value) => value + suffix} />;
		await act(async () => root!.render(render()));
		const paragraph = container.querySelector("p")!;
		const node = paragraph.querySelector("span span")!.firstChild!;
		const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 10);
		const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
		const image = container.querySelector("img")!;
		await act(async () => root!.render(render()));
		expect(container.querySelector("p")).toBe(paragraph);
		expect(paragraph.querySelector("span span")!.firstChild).toBe(node);
		expect(selection.toString()).toBe("Selectable");
		expect(container.querySelector("img")).toBe(image);
		await act(async () => root!.render(render(text, " updated")));
		expect(container.textContent).toContain("second line updated");
		await act(async () => root!.render(render("Changed text")));
		expect(container.textContent).toBe("Changed text");
	});

});
