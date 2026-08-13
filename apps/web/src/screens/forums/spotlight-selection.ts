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

/**
 * Whether the captured selection may still seed a Spotlight prefill.
 *
 * The browser does not retire a selection when we consume it: a keyboard
 * selection never collapses at all, and a touch selection only collapses if the
 * platform happens to dismiss it. So "already spent" has to be state we keep
 * rather than something a fresh read of the document can tell us — otherwise
 * every later consume re-reads the same still-highlighted text and quotes it
 * again, and clearing or invalidating the capture achieves nothing.
 */
export type SelectionFreshness = "armed" | "retired";

/**
 * Captures ordered by the document position of the comments they came from,
 * plus whether they are still allowed to seed a prefill.
 *
 * A `retired` state keeps captures on purpose. They are no longer eligible
 * text; they are the fingerprint of whatever was still selected when the state
 * was retired, so that reading that same selection again recognizes it as spent
 * instead of rearming it. When nothing was selected there is nothing to
 * fingerprint and the state is empty, which is why reselecting the very same
 * words after a collapse arms a genuinely new capture.
 */
export type SpotlightSelectionState = {
	readonly captures: readonly CommentSelectionCapture[];
	readonly freshness: SelectionFreshness;
};

export const emptySpotlightSelection: SpotlightSelectionState = { captures: [], freshness: "retired" };

export function observeSelection(
	state: SpotlightSelectionState,
	observation: SelectionObservation,
): SpotlightSelectionState {
	switch (observation.kind) {
		case "collapsed":
		case "neutral":
			// A collapse never invalidates an armed capture — that is the mobile
			// dismissal this feature exists to survive — and neither does the reader
			// selecting inside Spotlight's own UI. Both do drop a retired
			// fingerprint: the spent selection is gone from the document, so
			// whatever the reader selects next is a new selection even when it is
			// the very same words.
			return state.freshness === "armed" ? state : emptySpotlightSelection;
		case "selected":
			// Reading the same selection again is not a new selection, whether it
			// arrives as the queued `selectionchange` for one already consumed live
			// or as a live read after the capture was retired. Only different
			// content rearms — including no content at all, which is the reader
			// selecting outside every comment body and moving on.
			return sameCaptures(state.captures, observation.captures) ?
					state
				:	{ captures: observation.captures, freshness: "armed" };
	}
}

/**
 * Marks the selection spent: an explicit clear, an unrelated activation, or the
 * consume that just quoted it.
 *
 * `live` is what the document has selected at that moment, or `null` when the
 * caller cannot say. Its content becomes the retirement fingerprint, because it
 * is exactly what a later read could mistake for a fresh selection. A collapsed
 * or Spotlight-internal selection leaves nothing to mistake, so the state goes
 * empty and the next selection rearms whatever it says.
 */
export function retireSelection(
	state: SpotlightSelectionState,
	live: SelectionObservation | null,
): SpotlightSelectionState {
	if (!live) {
		return state.freshness === "retired" ? state : { captures: state.captures, freshness: "retired" };
	}
	return live.kind === "selected" ? { captures: live.captures, freshness: "retired" } : emptySpotlightSelection;
}

/**
 * Applies a completed activation.
 *
 * An unrelated activation retires whatever is selected right now rather than
 * only what a delivered `selectionchange` has reported: a selection made and
 * abandoned within one task would otherwise still be waiting when a Spotlight
 * toggle is activated much later.
 */
export function observeActivation(
	state: SpotlightSelectionState,
	{
		activation,
		live,
	}: {
		readonly activation: ActivationObservation;
		readonly live: SelectionObservation | null;
	},
): SpotlightSelectionState {
	return activation.kind === "spotlight" ? state : retireSelection(state, live);
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
 * used keeps live-first and eager capture from disagreeing, and is also what
 * stops the live read from resurrecting a selection this state already spent:
 * `observeSelection` rearms only for content it has not already accounted for.
 *
 * The state is retired unconditionally, whether or not it produced text: one
 * capture seeds exactly one Spotlight prefill.
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
		state: retireSelection(current, live),
		focusText:
			current.freshness === "armed" ?
				quoteSpotlightFocusText(selectedTextForComments(current.captures, targetCommentIds))
			:	"",
	};
}

function sameCaptures(
	left: readonly CommentSelectionCapture[],
	right: readonly CommentSelectionCapture[],
): boolean {
	return (
		left.length === right.length
		&& left.every((capture, index) => capture.commentId === right[index].commentId && capture.text === right[index].text)
	);
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
	/** Retires the capture: a Spotlight clear or unmount. */
	readonly reset: () => void;
	readonly snapshot: () => SpotlightSelectionState;
};

/**
 * Holds the capture outside React state. Capture must not re-render the thread
 * — it happens on every `selectionchange` — and must not be lost to a render
 * that lands between the selection and the activation that consumes it.
 *
 * Every entry point that spends or invalidates the capture reads the live
 * selection first and folds it in, so the state always knows about whatever is
 * selected at that moment and can recognize it later as already spent.
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
			state = observeActivation(state, { activation, live: readSelection() });
		},
		consumeFocusText: (targetCommentIds) => {
			const consumption = consumeSpotlightFocusText(state, { live: readSelection(), targetCommentIds });
			state = consumption.state;
			return consumption.focusText;
		},
		reset: () => {
			state = retireSelection(state, readSelection());
		},
		snapshot: () => state,
	};
}
