/**
 * The document adapter for Spotlight selection capture.
 *
 * This is the only layer that knows about `Selection`, `Range`, and `Node`. It
 * turns the live selection into the plain values in `spotlight-selection.ts`
 * and turns a click target into an activation classification; everything else
 * about capture lifetime is decided there.
 */
import {
	commentBodyAttribute,
	commentBodySelector,
	selectionExcludeAttribute,
	selectionExcludeValue,
	spotlightRegionSelector,
	spotlightUiAttribute,
	textLineAttribute,
} from "../../selection-markers";
import {
	captureSelectedComments,
	type ActivationObservation,
	type SelectionCaptureReader,
	type SelectionObservation,
} from "./spotlight-selection";

const elementNodeType = 1;
const textNodeType = 3;

/**
 * Controls whose activation means the reader moved on to something other than
 * Spotlight. A tap that lands on ordinary text is deliberately not in this set:
 * on mobile that tap is usually just the selection being dismissed, which is
 * the very event the capture has to survive.
 */
const interactiveControlSelector = "a[href],button,input,select,textarea,summary,[role='button'],[role='link']";

const spotlightUiSelector = `[${spotlightUiAttribute}]`;

export function readDocumentSelection(): SelectionObservation {
	const selection = typeof window === "undefined" ? null : window.getSelection();
	if (!selection) {
		return { kind: "collapsed" };
	}
	const ranges: Range[] = [];
	for (let index = 0; index < selection.rangeCount; index += 1) {
		const range = selection.getRangeAt(index);
		if (!range.collapsed) {
			ranges.push(range);
		}
	}
	if (ranges.length === 0) {
		return { kind: "collapsed" };
	}
	if (ranges.every(isWithinSpotlightUi)) {
		return { kind: "neutral" };
	}
	return { kind: "selected", captures: captureSelectedComments(ranges, documentSelectionReader) };
}

/**
 * Classifies a completed activation, or returns `null` when the event was not
 * an activation of an interactive control and therefore says nothing about the
 * capture's continued relevance.
 */
export function classifyActivation(target: Element | null): ActivationObservation | null {
	const control = target?.closest(interactiveControlSelector);
	if (!control) {
		return null;
	}
	return control.closest(spotlightRegionSelector) ? { kind: "spotlight" } : { kind: "unrelated" };
}

const documentSelectionReader: SelectionCaptureReader<Range, Element> = {
	compareRanges: (left, right) => left.compareBoundaryPoints(Range.START_TO_START, right),
	compareBodies: (left, right) =>
		left === right ? 0
		: (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1
		: 1,
	candidateBodies: (range) => {
		const ancestor = elementFor(range.commonAncestorContainer);
		if (!ancestor) {
			return [];
		}
		// A selection inside a single comment — by far the common case — shares
		// that comment body as its common ancestor and needs no search at all.
		// Only a cross-comment selection searches, and it searches just the
		// subtree the selection spans rather than every comment in the thread.
		const enclosing = ancestor.closest(commentBodySelector);
		if (enclosing) {
			return [enclosing];
		}
		return Array.from(ancestor.querySelectorAll(commentBodySelector)).filter((body) => range.intersectsNode(body));
	},
	commentIdOf: (body) => body.getAttribute(commentBodyAttribute),
	textWithin: (range, body) => selectedTextWithinNode(range, body),
};

function isWithinSpotlightUi(range: Range): boolean {
	return Boolean(elementFor(range.commonAncestorContainer)?.closest(spotlightUiSelector));
}

function elementFor(node: Node): Element | null {
	return node.nodeType === elementNodeType ? (node as Element) : node.parentElement;
}

function selectedTextWithinNode(range: Range, node: Element): string {
	if (!range.intersectsNode(node)) {
		return "";
	}
	const documentRef = node.ownerDocument;
	const nodeRange = documentRef.createRange();
	nodeRange.selectNodeContents(node);
	const clippedRange = range.cloneRange();
	if (range.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
		clippedRange.setStart(nodeRange.startContainer, nodeRange.startOffset);
	}
	if (range.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
		clippedRange.setEnd(nodeRange.endContainer, nodeRange.endOffset);
	}
	return serializeSelectedContents(clippedRange.cloneContents());
}

/**
 * Serializes selected markup to the text a reader sees.
 *
 * Comment bodies render one block element per source line, so a selection
 * spanning several lines arrives as sibling line elements with no text node
 * between them. Rejoining those with newlines is what makes the Spotlight
 * prefill quote line by line instead of running every line together.
 */
export function serializeSelectedContents(node: Node): string {
	return serializeSelectedNode(node, { emittedLine: false });
}

type LineJoinState = { emittedLine: boolean };

function serializeSelectedNode(node: Node, lines: LineJoinState): string {
	if (node.nodeType === textNodeType) {
		return node.nodeValue ?? "";
	}
	if (isElementNode(node)) {
		if (node.getAttribute(selectionExcludeAttribute) === selectionExcludeValue) {
			return "";
		}
		if (node.tagName === "BR") {
			return "\n";
		}
		if (node.hasAttribute(textLineAttribute)) {
			// Separator, not terminator: a selection that starts mid-body must not
			// open with a stray blank quoted line.
			const separator = lines.emittedLine ? "\n" : "";
			lines.emittedLine = true;
			return separator + serializeChildNodes(node, lines);
		}
	}
	return serializeChildNodes(node, lines);
}

function serializeChildNodes(node: Node, lines: LineJoinState): string {
	return Array.from(node.childNodes).map((child) => serializeSelectedNode(child, lines)).join("");
}

function isElementNode(node: Node): node is Element {
	return node.nodeType === elementNodeType;
}
