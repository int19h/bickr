import { StrictMode, act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SpotlightSelectionController } from "./spotlight-selection";
import { SpotlightTargetCheckbox } from "./spotlight-target-checkbox";
import { useSpotlightSelectionCapture } from "./use-spotlight-selection";

/**
 * The document listeners, exercised through real event dispatch.
 *
 * Which listener phase the capture uses is not a property of the classifier:
 * every reference, content link, and translation control in a thread calls
 * `stopPropagation()` from its React handler, which stops the native event at
 * React's root container. A bubble-phase listener on `document` therefore never
 * sees the activations that matter most, and only a real event path through a
 * real renderer can tell the two phases apart.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const commentId = "cmt_reply";

type Harness = {
	controller: SpotlightSelectionController | null;
	readonly seeds: string[];
};

/**
 * A thread in miniature: a comment body with a reference inside it, a Spotlight
 * target checkbox, and Spotlight's own panel region. The reference and the
 * panel control stop propagation exactly the way `components/content.tsx` and
 * the real panel controls do.
 */
function ThreadHarness({ harness }: { harness: Harness }) {
	const controller = useSpotlightSelectionCapture();
	const [checked, setChecked] = useState(false);
	useEffect(() => {
		harness.controller = controller;
	}, [controller, harness]);
	return (
		<div>
			<label>
				<SpotlightTargetCheckbox
					checked={checked}
					label="Spotlight this entire thread"
					onToggle={(next) => {
						setChecked(next);
						harness.seeds.push(controller.consumeFocusText([commentId]));
					}}
				/>
			</label>
			<div data-comment-body={commentId}>
				<span data-text-line="true">worth spotlighting</span>
				<span data-text-line="true">
					ask{" "}
					<a className="ref-button" href="/w/public" id="reference" onClick={stopLikeAThreadControl}>
						u/author
					</a>{" "}
					about it
				</span>
			</div>
			<aside data-spotlight-ui="true">
				<button id="panel-clear" onClick={stopLikeAThreadControl} type="button">
					clear
				</button>
			</aside>
		</div>
	);
}

function stopLikeAThreadControl(event: { preventDefault: () => void; stopPropagation: () => void }): void {
	event.preventDefault();
	event.stopPropagation();
}

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(() => {
	if (mounted) {
		const { container, root } = mounted;
		act(() => root.unmount());
		container.remove();
		mounted = null;
	}
	window.getSelection()?.removeAllRanges();
});

function mountThread(): Harness {
	const harness: Harness = { controller: null, seeds: [] };
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	act(() => {
		root.render(
			<StrictMode>
				<ThreadHarness harness={harness} />
			</StrictMode>,
		);
	});
	return harness;
}

function container(): HTMLElement {
	if (!mounted) {
		throw new Error("nothing is mounted");
	}
	return mounted.container;
}

/** Selects the first rendered line of the comment body, as a reader would. */
function selectCommentText(): void {
	const line = container().querySelector("[data-text-line]");
	if (!line) {
		throw new Error("no rendered line to select");
	}
	const range = document.createRange();
	range.selectNodeContents(line);
	const selection = window.getSelection();
	if (!selection) {
		throw new Error("no document selection");
	}
	selection.removeAllRanges();
	selection.addRange(range);
	// Dispatched explicitly so the test does not depend on when the platform
	// schedules its own `selectionchange`.
	act(() => {
		document.dispatchEvent(new Event("selectionchange"));
	});
}

function click(selector: string): void {
	const target = container().querySelector(selector);
	if (!(target instanceof HTMLElement)) {
		throw new Error(`no element for ${selector}`);
	}
	act(() => {
		target.click();
	});
}

function freshness(harness: Harness): string {
	if (!harness.controller) {
		throw new Error("the harness never published its controller");
	}
	return harness.controller.snapshot().freshness;
}

describe("Spotlight selection document listeners", () => {
	it("retires the capture for a thread control that stops propagation", () => {
		const harness = mountThread();
		selectCommentText();
		expect(freshness(harness)).toBe("armed");

		click("#reference");

		expect(freshness(harness)).toBe("retired");
		click("[data-spotlight-toggle]");
		expect(harness.seeds).toEqual([""]);
	});

	it("observes that click even though it never reaches a bubble-phase document listener", () => {
		const harness = mountThread();
		selectCommentText();
		const bubbled: string[] = [];
		const onBubble = (event: Event) => bubbled.push(event.type);
		document.addEventListener("click", onBubble);

		click("#reference");

		document.removeEventListener("click", onBubble);
		// The regression this guards: the same listener registered on the bubble
		// phase is dead code for exactly the controls that must invalidate.
		expect(bubbled).toEqual([]);
		expect(freshness(harness)).toBe("retired");
	});

	it("leaves the capture for the Spotlight toggle's own click and spends it once", () => {
		const harness = mountThread();
		selectCommentText();

		click("[data-spotlight-toggle]");
		// Nothing collapsed the selection, so the second activation reads the very
		// same live selection the first one quoted.
		click("[data-spotlight-toggle]");

		expect(harness.seeds).toEqual(["> worth spotlighting", ""]);
	});

	it("leaves the capture for a control inside the Spotlight panel", () => {
		const harness = mountThread();
		selectCommentText();

		click("#panel-clear");

		expect(freshness(harness)).toBe("armed");
		click("[data-spotlight-toggle]");
		expect(harness.seeds).toEqual(["> worth spotlighting"]);
	});

	it("leaves the capture for a tap on comment text", () => {
		const harness = mountThread();
		selectCommentText();

		click("[data-comment-body]");

		expect(freshness(harness)).toBe("armed");
	});

	it("keeps exactly one of each document listener across a StrictMode mount and unmount", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		// React installs its own document listeners when the root first renders,
		// so the counting starts after that.
		act(() => root.render(<div />));
		const live = countDocumentListeners();

		act(() => {
			root.render(
				<StrictMode>
					<ThreadHarness harness={{ controller: null, seeds: [] }} />
				</StrictMode>,
			);
		});
		expect(live.net()).toEqual({ "click/capture": 1, selectionchange: 1 });

		act(() => root.render(<div />));
		expect(live.net()).toEqual({ "click/capture": 0, selectionchange: 0 });

		live.stop();
		act(() => root.unmount());
		container.remove();
	});
});

/**
 * Counts the `document` listeners the capture hook owns, by name and phase, so
 * a StrictMode remount that leaked or dropped one is visible as a count.
 */
function countDocumentListeners() {
	const counts: Record<string, number> = { "click/capture": 0, selectionchange: 0 };
	const key = (type: string, options?: boolean | AddEventListenerOptions): string | null => {
		if (type === "selectionchange") {
			return "selectionchange";
		}
		const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
		return type === "click" && capture ? "click/capture" : null;
	};
	const add = document.addEventListener.bind(document);
	const remove = document.removeEventListener.bind(document);
	document.addEventListener = (type: string, listener: never, options?: boolean | AddEventListenerOptions) => {
		const counted = key(type, options);
		if (counted) {
			counts[counted] += 1;
		}
		add(type, listener, options);
	};
	document.removeEventListener = (type: string, listener: never, options?: boolean | AddEventListenerOptions) => {
		const counted = key(type, options);
		if (counted) {
			counts[counted] -= 1;
		}
		remove(type, listener, options);
	};
	return {
		net: () => ({ ...counts }),
		stop: () => {
			document.addEventListener = add;
			document.removeEventListener = remove;
		},
	};
}
