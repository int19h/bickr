import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./app-error-boundary";

let container: HTMLDivElement;
let root: Root;
let diagnostics: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function Failure({ error }: { error: Error }): never { throw error; }

it("renders healthy descendants", () => {
	act(() => root.render(<AppErrorBoundary><p>Healthy app</p></AppErrorBoundary>));
	expect(container.textContent).toBe("Healthy app");
});

it.each([new RangeError("Maximum call stack size exceeded"), new Error("private diagnostic")])(
	"retains an explicit recovery screen after %s", error => {
		const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
		act(() => root.render(<StrictMode><AppErrorBoundary><Failure error={error} /></AppErrorBoundary></StrictMode>));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Bickr could not display this page.");
		expect(container.textContent).toContain("Unsaved changes can be lost.");
		expect(container.textContent).not.toContain(error.message);
		const reports = diagnostics.mock.calls.filter((args: unknown[]) => args[0] === "Bickr rendering failed");
		expect(reports).toHaveLength(1);
		expect(reports[0]![1]).toBe(error);
		expect(reports[0]![2]).toContain("Failure");
		act(() => root.render(<StrictMode><AppErrorBoundary><p>Retry</p></AppErrorBoundary></StrictMode>));
		expect(container.textContent).not.toContain("Retry");
		expect(reload).not.toHaveBeenCalled();
		act(() => container.querySelector('button')!.click());
		expect(reload).toHaveBeenCalledTimes(1);
	},
);
