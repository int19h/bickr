const commentElementId = (commentId: string) => `comment-${commentId}`;
const elementNodeType = 1;
const textNodeType = 3;
const selectionExcludedSelector = "[data-selection-exclude='true']";

export function quoteSpotlightFocusText(text: string): string {
	const trimmed = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.split("\n").map((line) => `> ${line}`).join("\n");
}

export function spotlightFocusSeedFromSelection(commentIds: Iterable<string>): string {
	const selection = typeof window === "undefined" ? null : window.getSelection();
	const documentRef = typeof document === "undefined" ? null : document;
	if (!selection || selection.rangeCount === 0 || !documentRef) {
		return "";
	}

	const selectedText: string[] = [];
	const selectedBodies = new Set<Element>();
	for (const commentId of commentIds) {
		const body = documentRef
			.getElementById(commentElementId(commentId))
			?.querySelector(":scope > .comment-main > .body");
		if (!body || selectedBodies.has(body)) {
			continue;
		}
		selectedBodies.add(body);
		for (let index = 0; index < selection.rangeCount; index += 1) {
			const text = selectedTextWithinNode(selection.getRangeAt(index), body);
			if (text.trim()) {
				selectedText.push(text);
			}
		}
	}
	return quoteSpotlightFocusText(selectedText.join("\n"));
}

function selectedTextWithinNode(range: Range, node: Node): string {
	if (!range.intersectsNode(node)) {
		return "";
	}
	const documentRef = node.ownerDocument;
	if (!documentRef) {
		return "";
	}
	const nodeRange = documentRef.createRange();
	nodeRange.selectNodeContents(node);
	const clippedRange = range.cloneRange();
	if (range.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
		clippedRange.setStart(nodeRange.startContainer, nodeRange.startOffset);
	}
	if (range.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
		clippedRange.setEnd(nodeRange.endContainer, nodeRange.endOffset);
	}
	return selectedTextFromClonedContents(clippedRange.cloneContents());
}

export function selectedTextFromClonedContents(fragment: DocumentFragment): string {
	return selectedTextFromNode(fragment);
}

function selectedTextFromNode(node: Node): string {
	if (node.nodeType === textNodeType) {
		return node.nodeValue ?? "";
	}
	if (isElementNode(node)) {
		if (node.matches(selectionExcludedSelector)) {
			return "";
		}
		if (node.tagName === "BR") {
			return "\n";
		}
	}
	return Array.from(node.childNodes).map(selectedTextFromNode).join("");
}

function isElementNode(node: Node): node is Element {
	return node.nodeType === elementNodeType && "matches" in node && typeof node.matches === "function";
}
