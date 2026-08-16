import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastStack, toastDurationMs, useToasts, type ToastHandle } from "./ui";

/**
 * Toasts as the app's only report surface.
 *
 * With the top-bar status chip gone, a failed request is visible only as an
 * error toast, so severity has to survive the round trip from `push` to the
 * DOM, errors have to outlive transient confirmations, and a dismissed toast
 * must not leave a timer behind that sweeps a later one away. All of that is a
 * sequence of renders over time, so this drives a real render loop.
 */

let container: HTMLElement;
let root: Root;
let toasts: ToastHandle;

function Harness() {
	const state = useToasts();
	toasts = state.handle;
	return <ToastStack dismiss={state.dismiss} toasts={state.toasts} />;
}

function stack(): HTMLElement[] {
	return Array.from(container.querySelectorAll(".toast"));
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root.render(<Harness />);
	});
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
	vi.useRealTimers();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("toasts", () => {
	it("defaults to info and carries the severity as a class and a live-region role", () => {
		act(() => {
			toasts.push("Opening link...");
			toasts.push("Saved profile.", "success");
			toasts.push("Request failed.", "error");
		});

		expect(stack().map((toast) => toast.className)).toEqual([
			"toast toast-info",
			"toast toast-success",
			"toast toast-error",
		]);
		expect(stack().map((toast) => toast.getAttribute("role"))).toEqual(["status", "status", "alert"]);
		expect(stack().map((toast) => toast.querySelector(".toast-message")?.textContent)).toEqual([
			"Opening link...",
			"Saved profile.",
			"Request failed.",
		]);
	});

	it("keeps errors up after transient toasts have expired", () => {
		act(() => {
			toasts.push("Saved profile.", "success");
			toasts.push("Request failed.", "error");
		});
		expect(stack()).toHaveLength(2);

		act(() => {
			vi.advanceTimersByTime(toastDurationMs.success);
		});
		expect(stack().map((toast) => toast.className)).toEqual(["toast toast-error"]);

		act(() => {
			vi.advanceTimersByTime(toastDurationMs.error - toastDurationMs.success);
		});
		expect(stack()).toHaveLength(0);
	});

	it("offers a dismiss control on errors only", () => {
		act(() => {
			toasts.push("Saved profile.", "success");
			toasts.push("Request failed.", "error");
		});

		const [success, error] = stack();
		expect(success?.querySelector(".toast-dismiss")).toBeNull();
		const dismiss = error?.querySelector<HTMLButtonElement>(".toast-dismiss");
		expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss");

		act(() => {
			dismiss?.click();
		});
		expect(stack().map((toast) => toast.className)).toEqual(["toast toast-success"]);
	});

	it("drops the expiry timer of a manually dismissed toast", () => {
		act(() => {
			toasts.push("Request failed.", "error");
		});
		act(() => {
			container.querySelector<HTMLButtonElement>(".toast-dismiss")?.click();
		});
		expect(stack()).toHaveLength(0);

		// A second error pushed after the dismissal must not be swept away by the
		// first one's timer firing on its original schedule.
		act(() => {
			vi.advanceTimersByTime(toastDurationMs.error - 1);
			toasts.push("Another failure.", "error");
			vi.advanceTimersByTime(1);
		});
		expect(stack().map((toast) => toast.querySelector(".toast-message")?.textContent)).toEqual([
			"Another failure.",
		]);
	});
});
