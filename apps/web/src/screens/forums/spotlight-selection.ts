/**
 * Spotlight selection capture state, with no DOM dependency.
 *
 * Mobile browsers collapse a text selection while dismissing the selection
 * handles and moving focus into a checkbox, so by the time a Spotlight
 * checkbox's `change` handler runs the live selection is routinely already
 * gone — and no pointer event reliably precedes that collapse. Capture is
 * therefore eager: every relevant `selectionchange` is serialized immediately
 * into raw per-comment strings that outlive the collapse, and activation only
 * consumes what was captured earlier.
 *
 * Nothing here touches `Range`, `Node`, or `document`; live `Range` objects are
 * never retained, because they are invalidated by exactly the collapse this
 * feature exists to survive. The adapter in `spotlight-selection-dom.ts`
 * classifies the live selection into a `SelectionObservation`, and every
 * capture, invalidation, and consumption rule lives here as a pure transition.
 */

/** Raw, unquoted selected text from exactly one comment body. */
export type CommentSelectionCapture = {
	readonly commentId: string;
	readonly text: string;
};

/**
 * One `selectionchange`, classified by the adapter.
 *
 * `collapsed` and `neutral` deliberately retain the previous capture: a
 * collapse is the mobile failure this feature exists to survive, and a
 * selection inside Spotlight's own UI is not the reader replacing their thread
 * selection. Only `selected` replaces the capture, and it replaces it even when
 * it carries no captures at all — a fresh selection outside every comment body
 * means the reader moved on, so the old text must not resurface.
 */
export type SelectionObservation =
	| { readonly kind: "collapsed" }
	| { readonly kind: "neutral" }
	| { readonly kind: "selected"; readonly captures: readonly CommentSelectionCapture[] };

/**
 * A completed activation, classified by the adapter. `spotlight` activations
 * drive the capture/consume cycle; `unrelated` ones are interactive controls
 * elsewhere on the page and retire the capture so that a much later Spotlight
 * toggle cannot quote text the reader has since navigated away from.
 */
export type ActivationObservation =
	| { readonly kind: "spotlight" }
	| { readonly kind: "unrelated" };

/** Captures ordered by the document position of the comments they came from. */
export type SpotlightSelectionState = {
	readonly captures: readonly CommentSelectionCapture[];
};

export const emptySpotlightSelection: SpotlightSelectionState = { captures: [] };

export function observeSelection(
	state: SpotlightSelectionState,
	observation: SelectionObservation,
): SpotlightSelectionState {
	switch (observation.kind) {
		case "collapsed":
		case "neutral":
			return state;
		case "selected":
			return { captures: observation.captures };
	}
}

export function observeActivation(
	state: SpotlightSelectionState,
	activation: ActivationObservation,
): SpotlightSelectionState {
	return activation.kind === "unrelated" ? emptySpotlightSelection : state;
}

export type SpotlightFocusConsumption = {
	readonly state: SpotlightSelectionState;
	readonly focusText: string;
};

/**
 * Quotes the selection covered by `targetCommentIds` and retires the capture.
 *
 * `live` is the selection as it stands at activation time, or `null` when the
 * caller has none to offer. It is applied first because `selectionchange` is
 * queued as a task: a selection the reader just made — keyboard activation in
 * particular never collapses one — can still be ahead of the retained capture.
 * Applying it through the same replacement rule the queued event would have
 * used keeps live-first and eager capture from disagreeing.
 *
 * The capture is cleared unconditionally, whether or not it produced text: one
 * capture seeds exactly one Spotlight prefill, so a second consume can never
 * reuse it.
 */
export function consumeSpotlightFocusText(
	state: SpotlightSelectionState,
	{
		live,
		targetCommentIds,
	}: {
		readonly live: SelectionObservation | null;
		readonly targetCommentIds: readonly string[];
	},
): SpotlightFocusConsumption {
	const current = live ? observeSelection(state, live) : state;
	return {
		state: emptySpotlightSelection,
		focusText: quoteSpotlightFocusText(selectedTextForComments(current.captures, targetCommentIds)),
	};
}

function selectedTextForComments(
	captures: readonly CommentSelectionCapture[],
	targetCommentIds: readonly string[],
): string {
	const targets = new Set(targetCommentIds);
	return captures
		.filter((capture) => targets.has(capture.commentId))
		.map((capture) => capture.text)
		.filter((text) => text.trim())
		.join("\n");
}

export function quoteSpotlightFocusText(text: string): string {
	const trimmed = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.split("\n").map((line) => `> ${line}`).join("\n");
}

/**
 * Everything the capture rules need from a live selection, so that the merge
 * and ordering rules below stay free of `Range` and `Element`. The adapter
 * supplies the document-backed implementation; tests supply plain values.
 */
export type SelectionCaptureReader<TRange, TBody> = {
	/** Document order of two selection ranges. */
	readonly compareRanges: (left: TRange, right: TRange) => number;
	/** Document order of two comment bodies. */
	readonly compareBodies: (left: TBody, right: TBody) => number;
	/**
	 * Comment bodies this range could touch. Implementations resolve these from
	 * the range itself rather than from the thread, so cost tracks the size of
	 * the selection instead of the size of the thread.
	 */
	readonly candidateBodies: (range: TRange) => readonly TBody[];
	readonly commentIdOf: (body: TBody) => string | null;
	/** The part of `body` that `range` actually covers, as raw text. */
	readonly textWithin: (range: TRange, body: TBody) => string;
};

/**
 * Serializes one selection into at most one capture per comment.
 *
 * Both the bodies and the ranges are placed in document order, so a
 * multi-range selection — several ranges within one comment, or ranges spanning
 * several comments — reads back the way the thread reads rather than the way
 * the selection happened to be built up.
 */
export function captureSelectedComments<TRange, TBody>(
	ranges: readonly TRange[],
	reader: SelectionCaptureReader<TRange, TBody>,
): CommentSelectionCapture[] {
	const orderedRanges = [...ranges].sort(reader.compareRanges);
	const bodies: TBody[] = [];
	for (const range of orderedRanges) {
		for (const body of reader.candidateBodies(range)) {
			if (!bodies.includes(body)) {
				bodies.push(body);
			}
		}
	}
	bodies.sort(reader.compareBodies);

	const captures: CommentSelectionCapture[] = [];
	for (const body of bodies) {
		const commentId = reader.commentIdOf(body);
		if (!commentId) {
			continue;
		}
		const parts = orderedRanges
			.map((range) => reader.textWithin(range, body))
			.filter((text) => text.trim());
		if (parts.length > 0) {
			captures.push({ commentId, text: parts.join("\n") });
		}
	}
	return captures;
}

export type SpotlightSelectionController = {
	/** Re-reads the live selection and applies it to the retained capture. */
	readonly observeSelectionChange: () => void;
	readonly observeActivation: (activation: ActivationObservation) => void;
	/** Quotes the capture for these comments and retires it. */
	readonly consumeFocusText: (targetCommentIds: readonly string[]) => string;
	/** Drops the capture: thread replacement, Spotlight clear, or unmount. */
	readonly reset: () => void;
	readonly snapshot: () => SpotlightSelectionState;
};

/**
 * Holds the capture outside React state. Capture must not re-render the thread
 * — it happens on every `selectionchange` — and must not be lost to a render
 * that lands between the selection and the activation that consumes it.
 */
export function createSpotlightSelectionController(
	readSelection: () => SelectionObservation,
): SpotlightSelectionController {
	let state = emptySpotlightSelection;
	return {
		observeSelectionChange: () => {
			state = observeSelection(state, readSelection());
		},
		observeActivation: (activation) => {
			state = observeActivation(state, activation);
		},
		consumeFocusText: (targetCommentIds) => {
			const consumption = consumeSpotlightFocusText(state, { live: readSelection(), targetCommentIds });
			state = consumption.state;
			return consumption.focusText;
		},
		reset: () => {
			state = emptySpotlightSelection;
		},
		snapshot: () => state,
	};
}
