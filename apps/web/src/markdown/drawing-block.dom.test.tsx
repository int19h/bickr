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
	it("opens the viewer on the escaped source if the frame fails to start", async () => {
		vi.useFakeTimers(); await mount("graph TD; A-->B");
		await act(async () => vi.advanceTimersByTime(15000));
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector("details")).toBeNull();
		expect(container.querySelector("code")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".drawing-open")!.click());
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Source");
		expect(dialog.querySelector("pre code")?.textContent).toBe("graph TD; A-->B");
		await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
		expect(document.querySelector('[role="dialog"]')).toBeNull();
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
		const node = paragraph.querySelector("[data-md-leaf]")!.firstChild!;
		const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 10);
		const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
		const image = container.querySelector("img")!;
		await act(async () => root!.render(render()));
		expect(container.querySelector("p")).toBe(paragraph);
		expect(paragraph.querySelector("[data-md-leaf]")!.firstChild).toBe(node);
		expect(selection.toString()).toBe("Selectable");
		expect(container.querySelector("img")).toBe(image);
		await act(async () => root!.render(render(text, " updated")));
		expect(container.textContent).toContain("second line updated");
		await act(async () => root!.render(render("Changed text")));
		expect(container.textContent).toBe("Changed text");
	});

});

describe("drawing viewer", () => {
	function stubDownloads() {
		const blobs: Blob[] = [];
		const names: string[] = [];
		vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:test"; }, revokeObjectURL: () => undefined }));
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
		return { blobs, names };
	}
	it("opens a Mermaid diagram full screen and downloads its rendered SVG through the frame", async () => {
		await mount("graph TD; A-->B");
		await act(async () => container.querySelector<HTMLButtonElement>(".drawing-open")!.click());
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog.querySelector("h2")?.textContent).toBe("Mermaid diagram");
		const frame = dialog.querySelector("iframe")!;
		const send = vi.spyOn(frame.contentWindow!, "postMessage");
		await message(frame.contentWindow!, { kind: "loaded" });
		const render = send.mock.calls[0]![0] as { token: string; layout: string };
		expect(render.layout).toBe("viewer");
		const download = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Download"))!;
		expect(download.disabled).toBe(true);
		await message(frame.contentWindow!, { kind: "ready", token: render.token, height: 400 });
		expect(download.disabled).toBe(false);
		const files = stubDownloads();
		await act(async () => download.click());
		expect(send.mock.calls[1]![0]).toEqual({ kind: "export", token: render.token });
		await message(frame.contentWindow!, { kind: "exported", token: "wrong", svg: "<svg/>" });
		expect(files.names).toEqual([]);
		await message(frame.contentWindow!, { kind: "exported", token: render.token, svg: "<svg>drawn</svg>" });
		expect(files.names).toEqual(["diagram.svg"]);
		expect(files.blobs[0]!.type).toBe("application/octet-stream");
		expect(await files.blobs[0]!.text()).toBe("<svg>drawn</svg>");
	});
	it("downloads the source from the Source tab and keeps the rendered frame", async () => {
		await mount("graph TD; A-->B");
		await act(async () => container.querySelector<HTMLButtonElement>(".drawing-open")!.click());
		const dialog = document.querySelector('[role="dialog"]')!;
		const frame = dialog.querySelector("iframe")!;
		await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Source")!.click());
		expect(dialog.querySelector("pre code")?.textContent).toBe("graph TD; A-->B");
		expect(dialog.querySelector("iframe")).toBe(frame);
		const files = stubDownloads();
		await act(async () => [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Download"))!.click());
		expect(files.names).toEqual(["diagram.mmd"]);
		expect(await files.blobs[0]!.text()).toBe("graph TD; A-->B");
	});
	it("serializes the sanitized SVG drawing for a download", async () => {
		vi.stubGlobal("IntersectionObserver", undefined);
		container = document.createElement("div"); document.body.append(container); root = createRoot(container);
		const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="5" height="5" fill="url(#g)"/></svg>';
		await act(async () => root!.render(<DrawingBlock language="svg" source={source} />));
		await act(async () => container.querySelector<HTMLButtonElement>(".drawing-open")!.click());
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog.querySelector(".svg-drawing-viewer svg rect")).not.toBeNull();
		const files = stubDownloads();
		await act(async () => [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Download"))!.click());
		expect(files.names).toEqual(["drawing.svg"]);
		const text = await files.blobs[0]!.text();
		// The download is the prepared drawing, with its IDs scoped to the page.
		expect(text).toMatch(/<rect[^>]*fill="url\(#bickr-svg-[^)]+-g\)"/);
	});
	it("follows a viewer that its owner controls", async () => {
		vi.stubGlobal("IntersectionObserver", undefined);
		container = document.createElement("div"); document.body.append(container); root = createRoot(container);
		const onOpen = vi.fn(); const onClose = vi.fn();
		const render = (open: boolean) => <DrawingBlock language="mermaid" source="graph TD; A-->B" viewer={{ open, onOpen, onClose }} />;
		await act(async () => root!.render(render(false)));
		await act(async () => container.querySelector<HTMLButtonElement>(".drawing-open")!.click());
		expect(onOpen).toHaveBeenCalledOnce();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => root!.render(render(true)));
		await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')!.click());
		expect(onClose).toHaveBeenCalledOnce();
	});
	it("switches a viewer that a link opened to Source when the drawing does not render", async () => {
		vi.stubGlobal("IntersectionObserver", undefined);
		container = document.createElement("div"); document.body.append(container); root = createRoot(container);
		const render = () => <DrawingBlock language="mermaid" source="not a diagram" viewer={{ open: true, onOpen: () => undefined, onClose: () => undefined }} />;
		await act(async () => root!.render(render()));
		const dialog = document.querySelector('[role="dialog"]')!;
		const selected = () => dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
		expect(selected()).toBe("Rendered");
		const frame = dialog.querySelector("iframe")!;
		const send = vi.spyOn(frame.contentWindow!, "postMessage");
		await message(frame.contentWindow!, { kind: "loaded" });
		const token = (send.mock.calls[0]![0] as { token: string }).token;
		await message(frame.contentWindow!, { kind: "error", token });
		expect(selected()).toBe("Source");
	});
	it("keeps the tab that the reader chose when the drawing fails later", async () => {
		vi.stubGlobal("IntersectionObserver", undefined);
		container = document.createElement("div"); document.body.append(container); root = createRoot(container);
		await act(async () => root!.render(<DrawingBlock language="mermaid" source="not a diagram" viewer={{ open: true, onOpen: () => undefined, onClose: () => undefined }} />));
		const dialog = document.querySelector('[role="dialog"]')!;
		const tab = (name: string) => [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === name)!;
		await act(async () => tab("Source").click());
		await act(async () => tab("Rendered").click());
		const frame = dialog.querySelector("iframe")!;
		const send = vi.spyOn(frame.contentWindow!, "postMessage");
		await message(frame.contentWindow!, { kind: "loaded" });
		await message(frame.contentWindow!, { kind: "error", token: (send.mock.calls[0]![0] as { token: string }).token });
		expect(tab("Rendered").getAttribute("aria-selected")).toBe("true");
	});
});
