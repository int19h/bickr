// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeDiagramHeight } from "./diagram-layout";
afterEach(() => vi.unstubAllGlobals());
describe("diagram height measurement", () => {
	it("batches geometry changes, bounds height and stops observation", () => {
		let height = 30;
		let notify: () => void = () => {};
		const disconnect = vi.fn();
		vi.stubGlobal("ResizeObserver", class {
			constructor(callback: () => void) { notify = callback; }
			observe = vi.fn(); disconnect = disconnect;
		});
		let nextId = 0;
		const frames = new Map<number, FrameRequestCallback>();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
		const cancel = vi.fn((id: number) => frames.delete(id)); vi.stubGlobal("cancelAnimationFrame", cancel);
		function flush() { for (const [id, callback] of frames) { frames.delete(id); callback(0); } }
		const host = document.createElement("div");
		vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => ({ height }) as DOMRect);
		const report = vi.fn(); const stop = observeDiagramHeight(host, report);
		expect(report.mock.calls).toEqual([[80]]);
		height = 200; notify(); height = 400.2; notify();
		expect(frames.size).toBe(1); flush(); expect(report.mock.calls).toEqual([[80], [401]]);
		notify(); flush(); expect(report).toHaveBeenCalledTimes(2);
		height = 1800; notify(); flush(); expect(report).toHaveBeenLastCalledWith(1200);
		height = 100; notify(); flush(); expect(report).toHaveBeenLastCalledWith(100);
		height = 500; notify(); stop(); expect(disconnect).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
		flush(); notify(); expect(frames.size).toBe(0); expect(report).toHaveBeenCalledTimes(4);
	});
});
