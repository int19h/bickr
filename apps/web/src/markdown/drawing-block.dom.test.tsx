// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrawingBlock } from "./drawing-block";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(source: string) {
	vi.stubGlobal("IntersectionObserver", undefined);
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
});
