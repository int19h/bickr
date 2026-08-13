import { describe, expect, it } from "vitest";
import { classifyActivation, serializeSelectedContents } from "./spotlight-selection-dom";

describe("serializeSelectedContents", () => {
	it("omits selection-excluded popup text while preserving the selected reference label", () => {
		const selected = fragment(
			text("Ask "),
			element("span", {
				children: [
					element("a", { children: [text("u/alice")] }),
					element("span", {
						attributes: { "data-selection-exclude": "true" },
						children: [text("Alice"), text("u/alice"), text("Short bio that was hidden.")],
					}),
				],
			}),
			text(" about this."),
		);

		expect(serializeSelectedContents(selected)).toBe("Ask u/alice about this.");
	});

	it("omits the translation controls a comment body renders alongside its text", () => {
		const selected = fragment(
			element("span", { children: [line(text("the claim"))] }),
			element("span", {
				attributes: { "data-selection-exclude": "true" },
				children: [element("button", { children: [text("Translate")] })],
			}),
		);

		expect(serializeSelectedContents(selected)).toBe("the claim");
	});

	it("preserves explicit selected line breaks", () => {
		const selected = fragment(line(text("first"), element("br"), text("second")));

		expect(serializeSelectedContents(selected)).toBe("first\nsecond");
	});

	it("joins the separate block elements a comment body renders per line", () => {
		const selected = fragment(line(text("first line")), line(text("second line")));

		expect(serializeSelectedContents(selected)).toBe("first line\nsecond line");
	});

	it("keeps an empty rendered line as a blank line rather than its layout filler", () => {
		const selected = fragment(
			line(text("first line")),
			line(element("span", { attributes: { "data-selection-exclude": "true" }, children: [text("\u00a0")] })),
			line(text("third line")),
		);

		expect(serializeSelectedContents(selected)).toBe("first line\n\nthird line");
	});

	it("does not open a clipped selection with a blank line", () => {
		const selected = fragment(line(text("second half of a line")), line(text("the next line")));

		expect(serializeSelectedContents(selected)).toBe("second half of a line\nthe next line");
	});
});

describe("classifyActivation", () => {
	it("treats a Spotlight target checkbox as Spotlight's own activation", () => {
		const checkbox = chain(
			{ tagName: "div" },
			{ tagName: "input", attributes: { "data-spotlight-toggle": "true", type: "checkbox" } },
		);

		expect(classifyActivation(checkbox)).toEqual({ kind: "spotlight" });
	});

	it("treats a control inside the Spotlight panel as Spotlight's own activation", () => {
		const clearButton = chain(
			{ tagName: "aside", attributes: { "data-spotlight-ui": "true" } },
			{ tagName: "button" },
			{ tagName: "span" },
		);

		expect(classifyActivation(clearButton)).toEqual({ kind: "spotlight" });
	});

	it("treats a control elsewhere in the thread as unrelated", () => {
		const voteButton = chain({ tagName: "div" }, { tagName: "button" });
		const referenceLink = chain({ tagName: "div" }, { tagName: "a", attributes: { href: "/w/sandbox" } });

		expect(classifyActivation(voteButton)).toEqual({ kind: "unrelated" });
		expect(classifyActivation(referenceLink)).toEqual({ kind: "unrelated" });
	});

	it("reports no activation for a tap on comment text", () => {
		// On mobile this tap is usually the selection being dismissed, which the
		// capture has to survive rather than treat as the reader moving on.
		const commentText = chain(
			{ tagName: "div", attributes: { "data-comment-body": "cmt_reply" } },
			{ tagName: "span", attributes: { "data-text-line": "true" } },
		);

		expect(classifyActivation(commentText)).toBeNull();
		expect(classifyActivation(null)).toBeNull();
	});
});

function fragment(...childNodes: Node[]): Node {
	return { childNodes, nodeType: 11 } as unknown as Node;
}

function text(nodeValue: string): Node {
	return { childNodes: [], nodeType: 3, nodeValue } as unknown as Node;
}

function element(
	tagName: string,
	{ attributes = {}, children = [] }: { attributes?: Record<string, string>; children?: Node[] } = {},
): Node {
	return {
		childNodes: children,
		getAttribute: (name: string) => attributes[name] ?? null,
		hasAttribute: (name: string) => name in attributes,
		nodeType: 1,
		tagName: tagName.toUpperCase(),
	} as unknown as Node;
}

/** One rendered visual line, as a comment body's bidi line markup produces it. */
function line(...children: Node[]): Node {
	return element("span", { attributes: { "data-text-line": "true" }, children });
}

type TestElementSpec = {
	readonly tagName: string;
	readonly attributes?: Record<string, string>;
};

type TestElement = {
	readonly attributes: Record<string, string>;
	readonly parent: TestElement | null;
	readonly tagName: string;
	closest(selector: string): TestElement | null;
};

/** Builds an ancestor chain, outermost first, and returns the innermost element. */
function chain(...specs: readonly TestElementSpec[]): Element {
	let element: TestElement | null = null;
	for (const spec of specs) {
		const parent: TestElement | null = element;
		element = {
			attributes: spec.attributes ?? {},
			parent,
			tagName: spec.tagName.toUpperCase(),
			closest(selector: string): TestElement | null {
				for (let node: TestElement | null = this; node; node = node.parent) {
					if (matchesSelector(node, selector)) {
						return node;
					}
				}
				return null;
			},
		};
	}
	return element as unknown as Element;
}

/**
 * Implements only the selector forms the capture adapter uses: comma-separated
 * tag names, `tag[attribute]`, `[attribute]`, and `[attribute='value']`.
 */
function matchesSelector(element: TestElement, selector: string): boolean {
	return selector.split(",").some((part) => matchesCompoundSelector(element, part.trim()));
}

function matchesCompoundSelector(element: TestElement, selector: string): boolean {
	const parsed = /^([a-z]*)(?:\[([\w-]+)(?:='([^']*)')?\])?$/.exec(selector);
	if (!parsed) {
		throw new Error(`unsupported test selector: ${selector}`);
	}
	const [, tagName, attribute, value] = parsed;
	if (tagName && element.tagName !== tagName.toUpperCase()) {
		return false;
	}
	if (!attribute) {
		return Boolean(tagName);
	}
	const actual = element.attributes[attribute];
	return actual !== undefined && (value === undefined || actual === value);
}
