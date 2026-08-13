import { describe, expect, it } from "vitest";
import { spotlightTargetCommentIds } from "./comment-tree";
import {
	captureSelectedComments,
	consumeSpotlightFocusText,
	createSpotlightSelectionController,
	emptySpotlightSelection,
	observeSelection,
	quoteSpotlightFocusText,
	type CommentSelectionCapture,
	type SelectionCaptureReader,
	type SelectionObservation,
} from "./spotlight-selection";

const collapsed: SelectionObservation = { kind: "collapsed" };
const neutral: SelectionObservation = { kind: "neutral" };

function selected(...captures: CommentSelectionCapture[]): SelectionObservation {
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

		// The document-level listener may see the checkbox's own click before
		// React runs the toggle's `change` handler; classifying it as Spotlight's
		// own is what keeps that ordering harmless.
		controller.observeActivation({ kind: "spotlight" });

		expect(controller.consumeFocusText(threadCommentIds)).toBe("> worth spotlighting");
	});

	it("drops the capture when the rendered thread is replaced", () => {
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

describe("consumeSpotlightFocusText", () => {
	it("retires the capture even when it produced no quotable text", () => {
		const state = { captures: [{ commentId: "cmt_other", text: "an unrelated aside" }] };

		const consumption = consumeSpotlightFocusText(state, { live: null, targetCommentIds: ["cmt_root"] });

		expect(consumption.focusText).toBe("");
		expect(consumption.state).toEqual(emptySpotlightSelection);
	});

	it("ignores a live selection that only collapsed", () => {
		const state = { captures: [{ commentId: "cmt_root", text: "the opening claim" }] };

		expect(consumeSpotlightFocusText(state, { live: collapsed, targetCommentIds: ["cmt_root"] }).focusText).toBe(
			"> the opening claim",
		);
	});
});

describe("observeSelection", () => {
	it("replaces the capture only for a new non-collapsed selection", () => {
		const captured = observeSelection(emptySpotlightSelection, selected({ commentId: "cmt_root", text: "claim" }));

		expect(observeSelection(captured, collapsed)).toBe(captured);
		expect(observeSelection(captured, neutral)).toBe(captured);
		expect(observeSelection(captured, selected()).captures).toEqual([]);
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
