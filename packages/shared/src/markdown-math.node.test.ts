import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { math } from "micromark-extension-math";
import { remarkBickrMath } from "./markdown-math";

const processor = () => unified().use(remarkParse).use(remarkBickrMath);

describe("math parser isolation across a long session", () => {
	it("leaves the upstream construct and earlier processors unchanged", () => {
		const upstream = math().flow![36];
		if (Array.isArray(upstream) || !upstream) throw new Error("Expected one flow construct");
		const original = upstream.tokenize;
		const early = processor();
		const expected = early.parse("$$x^2$$\n\n$$\ny^2\n$$");
		const earlyFlow = early.data().micromarkExtensions![0]!.flow![36];
		expect(earlyFlow).not.toBe(upstream);
		for (let index = 0; index < 12_000; index++) {
			const next = processor();
			next.parse("Ordinary content without math.");
			expect(next.data().micromarkExtensions![0]!.flow![36]).not.toBe(earlyFlow);
		}
		expect(math().flow![36]).toBe(upstream);
		expect(upstream.tokenize).toBe(original);
		expect(early.parse("$$x^2$$\n\n$$\ny^2\n$$")).toEqual(expected);
		for (const text of ["$5", "$x$", "$$x^2$$", "$`x_$y`$"]) {
			expect(() => processor().parse(text)).not.toThrow();
		}
	}, 30_000);
});
