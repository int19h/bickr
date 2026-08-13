import { useEffect, useRef } from "react";
import { classifyActivation, readDocumentSelection } from "./spotlight-selection-dom";
import { createSpotlightSelectionController, type SpotlightSelectionController } from "./spotlight-selection";

/**
 * Wires the thread's Spotlight selection capture to the document.
 *
 * The controller lives in a ref rather than in state: capture runs on every
 * `selectionchange` and must not re-render the thread, and it must survive a
 * render that lands between the reader's selection and the checkbox activation
 * that consumes it. Both listeners are added and removed by the same effect, so
 * a StrictMode remount leaves exactly one of each.
 */
export function useSpotlightSelectionCapture(): SpotlightSelectionController {
	const controllerRef = useRef<SpotlightSelectionController | null>(null);
	controllerRef.current ??= createSpotlightSelectionController(readDocumentSelection);
	const controller = controllerRef.current;

	useEffect(() => {
		const onSelectionChange = () => controller.observeSelectionChange();
		const onClick = (event: MouseEvent) => {
			const activation = classifyActivation(event.target instanceof Element ? event.target : null);
			if (activation) {
				controller.observeActivation(activation);
			}
		};
		document.addEventListener("selectionchange", onSelectionChange);
		// Bubble phase: React handles a checkbox toggle during the click dispatch
		// at its root container, so the Spotlight prefill is already consumed by
		// the time this listener sees the same event. Selection dismissal is
		// deliberately not observed here — on mobile the tap that clears the
		// selection frequently lands somewhere other than the eventual checkbox,
		// and invalidating on it is exactly the bug this replaces.
		document.addEventListener("click", onClick);
		return () => {
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("click", onClick);
			controller.reset();
		};
	}, [controller]);

	return controller;
}
