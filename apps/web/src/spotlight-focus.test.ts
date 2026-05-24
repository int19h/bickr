import { describe, expect, it } from "vitest";
import { quoteSpotlightFocusText, selectedTextFromClonedContents } from "./spotlight-focus";

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

describe("selectedTextFromClonedContents", () => {
	it("omits selection-excluded popup text while preserving the selected reference label", () => {
		const selected = fragment(
			text("Ask "),
			element("span",
				element("a", text("u/alice")),
				element("span", { selectionExcluded: true }, text("Alice"), text("u/alice"), text("Short bio that was hidden.")),
			),
			text(" about this."),
		);

		expect(selectedTextFromClonedContents(selected)).toBe("Ask u/alice about this.");
	});

	it("preserves explicit selected line breaks", () => {
		const selected = fragment(text("first"), element("br"), text("second"));

		expect(selectedTextFromClonedContents(selected)).toBe("first\nsecond");
	});
});

function fragment(...childNodes: Node[]): DocumentFragment {
	return { childNodes } as unknown as DocumentFragment;
}

function text(nodeValue: string): Node {
	return { childNodes: [], nodeType: 3, nodeValue } as unknown as Node;
}

function element(tagName: string, ...children: Node[]): Node;
function element(tagName: string, options: { selectionExcluded?: boolean }, ...children: Node[]): Node;
function element(tagName: string, optionsOrChild?: { selectionExcluded?: boolean } | Node, ...restChildren: Node[]): Node {
	const options = isTestElementOptions(optionsOrChild) ? optionsOrChild : {};
	const childNodes = isTestElementOptions(optionsOrChild) ? restChildren : [optionsOrChild, ...restChildren].filter(Boolean);
	return {
		childNodes,
		matches: () => Boolean(options.selectionExcluded),
		nodeType: 1,
		tagName: tagName.toUpperCase(),
	} as unknown as Node;
}

function isTestElementOptions(value: unknown): value is { selectionExcluded?: boolean } {
	return Boolean(value && typeof value === "object" && "selectionExcluded" in value);
}
