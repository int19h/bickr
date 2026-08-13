import { describe, expect, it } from "vitest";
import { spotlightTargetCommentIds } from "./comment-tree";
import {
	captureSelectedComments,
	consumeSpotlightFocusText,
	createSpotlightSelectionController,
	emptySpotlightSelection,
	observeActivation,
	observeSelection,
	quoteSpotlightFocusText,
	retireSelection,
	type CommentSelectionCapture,
	type SelectionCaptureReader,
	type SelectionObservation,
	type SpotlightSelectionState,
} from "./spotlight-selection";

const collapsed: SelectionObservation = { kind: "collapsed" };
const neutral: SelectionObservation = { kind: "neutral" };

function selected(...captures: CommentSelectionCapture[]): Extract<SelectionObservation, { kind: "selected" }> {
	return { kind: "selected", captures };
}

/**
 * Stands in for the document's one live selection. Tests move it and deliver
 * `selectionchange` separately, which is what makes the mobile ordering — the
 * selection collapsing before, or without, the event that reports it —
 * reproducible rather than timing-dependent.
 */
function liveSelection(initial: SelectionObservation = collapsed) {
	let current = initial;
	return {
		set(next: SelectionObservation) {
			current = next;
		},
		read: () => current,
	};
}

const threadCommentIds = ["cmt_root", "cmt_reply", "cmt_other"];

describe("Spotlight selection capture", () => {
	it("quotes a selection that collapsed before the whole-thread checkbox changed", () => {
		const selection = liveSelection();
		const controller = createSpotlightSelectionController(selection.read);

		selection.set(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		controller.observeSelectionChange();
		// The selection handles are dismissed and focus moves to the checkbox.
		selection.set(collapsed);
		controller.observeSelectionChange();

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
	});

	it("quotes a selection that collapses without ever reporting the collapse", () => {
		const selection = liveSelection();
		const controller = createSpotlightSelectionController(selection.read);

		selection.set(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		controller.observeSelectionChange();
		// `selectionchange` is queued as a task, so activation can win the race.
		selection.set(collapsed);

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
	});

	it("quotes a collapsed selection for a reply chain including its implied ancestors", () => {
		const parentById = new Map<string, string | null>([
			["cmt_root", null],
			["cmt_reply", "cmt_root"],
			["cmt_other", null],
		]);
		const selection = liveSelection();
		const controller = createSpotlightSelectionController(selection.read);

		selection.set(selected(
			{ commentId: "cmt_root", text: "the opening claim" },
			{ commentId: "cmt_reply", text: "the rebuttal" },
			{ commentId: "cmt_other", text: "an unrelated aside" },
		));
		controller.observeSelectionChange();
		selection.set(collapsed);

		expect(controller.consumeFocusText(spotlightTargetCommentIds(["cmt_reply"], parentById))).toBe(
			"> the opening claim\n> the rebuttal",
		);
	});

	it("prefers the live selection over a capture the queued event has not replaced yet", () => {
		const selection = liveSelection();
		const controller = createSpotlightSelectionController(selection.read);

		selection.set(selected({ commentId: "cmt_reply", text: "the first thought" }));
		controller.observeSelectionChange();
		// Extended with the keyboard, which never collapses the selection; the
		// `selectionchange` for this has not been delivered yet.
		selection.set(selected({ commentId: "cmt_reply", text: "the first thought and the second" }));

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> the first thought and the second");
	});

	it("consumes a capture exactly once", () => {
		const selection = liveSelection();
		const controller = createSpotlightSelectionController(selection.read);

		selection.set(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		controller.observeSelectionChange();
		selection.set(collapsed);

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
		expect(controller.consumeFocusText(threadCommentIds)).toBe("");
	});

	// The browser does not retire a selection just because Spotlight consumed it.
	// A keyboard selection never collapses, and a touch selection only collapses
	// if the platform dismisses it, so `live` is routinely still the same
	// highlighted text at the next activation. These four cover each way the
	// capture stops being eligible while that text is still standing on screen.

	it("consumes a still-highlighted selection exactly once", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
		expect(controller.consumeFocusText(threadCommentIds)).toBe("");
		expect(controller.snapshot().freshness).toBe("retired");
	});

	it("does not requote a still-highlighted selection after an explicit clear", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();

		// Unchecking the last Spotlight target, or clearing the panel.
		controller.reset();

		expect(controller.consumeFocusText(threadCommentIds)).toBe("");
	});

	it("does not requote a still-highlighted selection after an unrelated activation", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();

		controller.observeActivation({ kind: "unrelated" });

		expect(controller.consumeFocusText(threadCommentIds)).toBe("");
	});

	it("retires a selection the reader made and abandoned before the queued event arrived", () => {
		const selection = liveSelection();
		const controller = createSpotlightSelectionController(selection.read);

		// Selected and then followed by an unrelated activation, all before
		// `selectionchange` was delivered for it.
		selection.set(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		controller.observeActivation({ kind: "unrelated" });
		controller.observeSelectionChange();

		expect(controller.consumeFocusText(threadCommentIds)).toBe("");
	});

	it("still prefers a genuinely new selection made after an earlier consume", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "the first thought" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();
		expect(controller.consumeFocusText(threadCommentIds)).toBe("> the first thought");

		// Extended with the keyboard, so nothing collapsed and the
		// `selectionchange` for it has not been delivered yet.
		selection.set(selected({ commentId: "cmt_reply", text: "the first thought and the second" }));

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> the first thought and the second");
	});

	it("rearms when the reader selects the same words again after the spent one is gone", () => {
		const capture = { commentId: "cmt_reply", text: "worth spotlighting" };
		const selection = liveSelection(selected(capture));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();
		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");

		selection.set(collapsed);
		controller.observeSelectionChange();
		selection.set(selected(capture));
		controller.observeSelectionChange();

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
	});

	it("rearms the same words again after an unrelated activation dismissed the selection", () => {
		const capture = { commentId: "cmt_reply", text: "worth spotlighting" };
		const selection = liveSelection(selected(capture));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();

		// Tapping the unrelated control dismissed the selection, so nothing is
		// left that a later read could confuse with the reader's next one.
		selection.set(collapsed);
		controller.observeActivation({ kind: "unrelated" });
		selection.set(selected(capture));
		controller.observeSelectionChange();

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
	});

	it("keeps the capture when the selection only collapses", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();

		selection.set(collapsed);
		controller.observeSelectionChange();

		expect(controller.snapshot().captures).toEqual([{ commentId: "cmt_reply", text: "worth spotlighting" }]);
	});

	it("keeps the capture while the reader selects inside the Spotlight panel", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();

		selection.set(neutral);
		controller.observeSelectionChange();

		expect(controller.snapshot().captures).toEqual([{ commentId: "cmt_reply", text: "worth spotlighting" }]);
		selection.set(collapsed);
		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
	});

	it("drops the capture when a new selection lands outside every comment body", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();

		selection.set(selected());
		controller.observeSelectionChange();
		selection.set(collapsed);

		expect(controller.consumeFocusText(threadCommentIds)).toBe("");
	});

	it("drops the capture on an unrelated activation", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();
		selection.set(collapsed);

		controller.observeActivation({ kind: "unrelated" });

		expect(controller.consumeFocusText(threadCommentIds)).toBe("");
	});

	it("survives a Spotlight activation observed before the toggle consumes it", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();
		selection.set(collapsed);

		// The capture-phase listener always sees the checkbox's own click before
		// React runs the toggle's `change` handler; classifying it as Spotlight's
		// own is what keeps that ordering harmless.
		controller.observeActivation({ kind: "spotlight" });

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
	});

	it("drops the capture on an explicit clear", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "worth spotlighting" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();
		selection.set(collapsed);

		controller.reset();

		expect(controller.consumeFocusText(threadCommentIds)).toBe("");
	});

	it("quotes only the comments the chosen Spotlight target covers", () => {
		const selection = liveSelection();
		const controller = createSpotlightSelectionController(selection.read);

		selection.set(selected(
			{ commentId: "cmt_root", text: "the opening claim" },
			{ commentId: "cmt_other", text: "an unrelated aside" },
		));
		controller.observeSelectionChange();
		selection.set(collapsed);

		expect(controller.consumeFocusText(["cmt_root"])).toBe("> the opening claim");
	});

	it("quotes a multi-line capture line by line", () => {
		const selection = liveSelection(selected({ commentId: "cmt_reply", text: "first line\n\nthird line" }));
		const controller = createSpotlightSelectionController(selection.read);
		controller.observeSelectionChange();
		selection.set(collapsed);

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> first line\n> \n> third line");
	});
});

function armed(...captures: CommentSelectionCapture[]): SpotlightSelectionState {
	return { captures, freshness: "armed" };
}

describe("consumeSpotlightFocusText", () => {
	it("retires the capture even when it produced no quotable text", () => {
		const state = armed({ commentId: "cmt_other", text: "an unrelated aside" });

		const consumption = consumeSpotlightFocusText(state, { live: null, targetCommentIds: ["cmt_root"] });

		expect(consumption.focusText).toBe("");
		expect(consumption.state.freshness).toBe("retired");
	});

	it("ignores a live selection that only collapsed", () => {
		const state = armed({ commentId: "cmt_root", text: "the opening claim" });

		expect(consumeSpotlightFocusText(state, { live: collapsed, targetCommentIds: ["cmt_root"] }).focusText).toBe(
			"> the opening claim",
		);
	});

	it("quotes nothing from a retired state, however the live selection reads", () => {
		const state = retireSelection(armed({ commentId: "cmt_root", text: "the opening claim" }), null);
		const targetCommentIds = ["cmt_root"];

		expect(consumeSpotlightFocusText(state, { live: null, targetCommentIds }).focusText).toBe("");
		expect(consumeSpotlightFocusText(state, { live: collapsed, targetCommentIds }).focusText).toBe("");
		expect(
			consumeSpotlightFocusText(state, {
				live: selected({ commentId: "cmt_root", text: "the opening claim" }),
				targetCommentIds,
			}).focusText,
		).toBe("");
	});
});

describe("observeSelection", () => {
	it("replaces the capture only for a new non-collapsed selection", () => {
		const captured = observeSelection(emptySpotlightSelection, selected({ commentId: "cmt_root", text: "claim" }));

		expect(observeSelection(captured, collapsed)).toBe(captured);
		expect(observeSelection(captured, neutral)).toBe(captured);
		expect(observeSelection(captured, selected()).captures).toEqual([]);
	});

	it("does not rearm a retired state by re-reading the same selection", () => {
		const retired = retireSelection(armed({ commentId: "cmt_root", text: "claim" }), null);

		expect(observeSelection(retired, selected({ commentId: "cmt_root", text: "claim" }))).toBe(retired);
		expect(observeSelection(retired, selected({ commentId: "cmt_root", text: "claim and more" }))).toEqual(
			armed({ commentId: "cmt_root", text: "claim and more" }),
		);
	});

	it("forgets a retired fingerprint once its selection leaves the document", () => {
		const retired = retireSelection(armed({ commentId: "cmt_root", text: "claim" }), null);

		expect(observeSelection(retired, collapsed)).toEqual(emptySpotlightSelection);
		expect(observeSelection(retired, neutral)).toEqual(emptySpotlightSelection);
	});
});

describe("retireSelection", () => {
	const captured = armed({ commentId: "cmt_root", text: "claim" });

	it("fingerprints the selection that is still standing", () => {
		const live = selected({ commentId: "cmt_root", text: "claim and more" });

		expect(retireSelection(captured, live)).toEqual({ captures: live.captures, freshness: "retired" });
	});

	it("keeps no fingerprint when nothing is selected to mistake for a new one", () => {
		expect(retireSelection(captured, collapsed)).toEqual(emptySpotlightSelection);
		expect(retireSelection(captured, neutral)).toEqual(emptySpotlightSelection);
	});

	it("keeps the captures as the fingerprint when the live selection is unknown", () => {
		expect(retireSelection(captured, null)).toEqual({ captures: captured.captures, freshness: "retired" });
	});
});

describe("observeActivation", () => {
	const captured = armed({ commentId: "cmt_root", text: "claim" });

	it("leaves Spotlight's own activation alone", () => {
		expect(observeActivation(captured, { activation: { kind: "spotlight" }, live: null })).toBe(captured);
	});

	it("retires the live selection an unrelated activation interrupts", () => {
		const live = selected({ commentId: "cmt_root", text: "claim and more" });

		const next = observeActivation(captured, { activation: { kind: "unrelated" }, live });

		expect(next).toEqual({ captures: [{ commentId: "cmt_root", text: "claim and more" }], freshness: "retired" });
	});
});

type TestBody = { readonly commentId: string | null; readonly position: number };
type TestRange = { readonly start: number; readonly covers: Readonly<Record<string, string>> };

/** Bodies are declared out of document order so ordering cannot pass by luck. */
const testBodies: TestBody[] = [
	{ commentId: "cmt_second", position: 2 },
	{ commentId: "cmt_first", position: 1 },
	{ commentId: null, position: 3 },
];

const testReader: SelectionCaptureReader<TestRange, TestBody> = {
	compareRanges: (left, right) => left.start - right.start,
	compareBodies: (left, right) => left.position - right.position,
	candidateBodies: (range) => testBodies.filter((body) => (body.commentId ?? "unmarked") in range.covers),
	commentIdOf: (body) => body.commentId,
	textWithin: (range, body) => range.covers[body.commentId ?? "unmarked"] ?? "",
};

describe("captureSelectedComments", () => {
	it("orders captures and their ranges by document position", () => {
		const captures = captureSelectedComments(
			[
				{ start: 20, covers: { cmt_second: "second comment, later range" } },
				{ start: 5, covers: { cmt_first: "first comment", cmt_second: "second comment, earlier range" } },
			],
			testReader,
		);

		expect(captures).toEqual([
			{ commentId: "cmt_first", text: "first comment" },
			{ commentId: "cmt_second", text: "second comment, earlier range\nsecond comment, later range" },
		]);
	});

	it("skips unmarked bodies and ranges that cover only whitespace", () => {
		const captures = captureSelectedComments(
			[{ start: 1, covers: { cmt_first: "  \n ", unmarked: "chrome between comments" } }],
			testReader,
		);

		expect(captures).toEqual([]);
	});
});

describe("quoteSpotlightFocusText", () => {
	it("quotes a single selected line", () => {
		expect(quoteSpotlightFocusText("Focus this thought")).toBe("> Focus this thought");
	});

	it("quotes every selected line", () => {
		expect(quoteSpotlightFocusText("first line\nsecond line")).toBe("> first line\n> second line");
	});

	it("keeps internal blank selected lines quoted", () => {
		expect(quoteSpotlightFocusText("first line\n\nsecond line")).toBe("> first line\n> \n> second line");
	});

	it("normalizes line endings and trims outer whitespace", () => {
		expect(quoteSpotlightFocusText(" \r\n first line\r\nsecond line \r\n ")).toBe("> first line\n> second line");
	});
});
