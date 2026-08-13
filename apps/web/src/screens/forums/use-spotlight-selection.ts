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
		// Capture is not coalesced. Deferring serialization to a frame or an idle
		// callback would have to re-read `window.getSelection()` when it finally
		// ran, and the collapse this feature exists to survive can land first —
		// the flush would then serialize nothing and lose exactly the last
		// selection before activation. Retaining the `Range` to serialize later is
		// no better: the same collapse invalidates it. Each read is already scoped
		// to the selection rather than to the thread (see `candidateBodies`).
		const onSelectionChange = () => controller.observeSelectionChange();
		const onClick = (event: MouseEvent) => {
			const activation = classifyActivation(event.target instanceof Element ? event.target : null);
			if (activation) {
				controller.observeActivation(activation);
			}
		};
		document.addEventListener("selectionchange", onSelectionChange);
		// Capture phase, not bubble. Thread controls — content references, author
		// and ordinary references, translation controls — call `stopPropagation()`
		// from their React handlers, which stops the native event at React's root
		// container, below `document`. Those clicks are precisely the unrelated
		// activations that must retire the capture, so a bubble-phase listener
		// misses the ones that matter most.
		//
		// Seeing a click before the activated control handles it cannot race a
		// Spotlight toggle: activations are classified by where the target sits in
		// the document, so a toggle's own click classifies as `spotlight` and
		// leaves the capture alone for the `change` handler that follows. Nothing
		// here calls `preventDefault` or `stopPropagation`, so running first
		// changes no other behavior. Selection dismissal is still deliberately not
		// observed — on mobile the tap that clears the selection frequently lands
		// somewhere other than the eventual checkbox, and invalidating on it is
		// exactly the bug this replaces.
		document.addEventListener("click", onClick, true);
		return () => {
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("click", onClick, true);
			controller.reset();
		};
	}, [controller]);

	return controller;
}
