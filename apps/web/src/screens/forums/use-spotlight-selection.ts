import { useEffect, useRef } from 'react';
import { classifyActivation, readDocumentSelection } from './spotlight-selection-dom';
import { createSpotlightSelectionController, type SpotlightSelectionController } from './spotlight-selection';

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
		let expiry: ReturnType<typeof setTimeout> | undefined;
		const isToggle = (target: EventTarget | null) =>
			target instanceof Element &&
			Boolean(target.closest('[data-spotlight-toggle]') || target.closest('label')?.querySelector('[data-spotlight-toggle]'));
		const cancel = () => {
			clearTimeout(expiry);
			controller.cancelActivation();
		};
		const begin = () => {
			clearTimeout(expiry);
			controller.beginActivation();
			expiry = setTimeout(cancel, 5000);
		};
		const onPointerDown = (event: PointerEvent) => {
			if (isToggle(event.target)) begin();
			else cancel();
		};
		const onPointerUp = (event: PointerEvent) => {
			if (!isToggle(event.target)) cancel();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (isToggle(event.target) && (event.key === ' ' || event.key === 'Enter')) begin();
			else cancel();
		};
		const onClick = (event: MouseEvent) => {
			const activation = classifyActivation(event.target instanceof Element ? event.target : null);
			if (activation) {
				controller.observeActivation(activation);
				// Firefox can run microtasks between native event listeners. Wait
				// until the next task so React's click listener can consume capture.
				clearTimeout(expiry);
				expiry = setTimeout(cancel, 0);
			}
		};
		document.addEventListener('selectionchange', onSelectionChange);
		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('pointerup', onPointerUp, true);
		document.addEventListener('pointercancel', cancel, true);
		document.addEventListener('keydown', onKeyDown, true);
		window.addEventListener('blur', cancel);
		// Capture phase, not bubble. Thread controls — content references, author
		// and ordinary references, translation controls — call `stopPropagation()`
		// from their React handlers, which stops the native event at React's root
		// container, below `document`. Those clicks are precisely the unrelated
		// activations that must retire the capture, so a bubble-phase listener
		// misses the ones that matter most.
		//
		// Only a pointer/key activation that already targets Spotlight can
		// preserve capture across focus collapse. Cancellation expires it.

		document.addEventListener('click', onClick, true);
		return () => {
			document.removeEventListener('selectionchange', onSelectionChange);
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('pointerup', onPointerUp, true);
			document.removeEventListener('pointercancel', cancel, true);
			document.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('blur', cancel);
			clearTimeout(expiry);
			document.removeEventListener('click', onClick, true);
			controller.reset();
		};
	}, [controller]);

	return controller;
}
