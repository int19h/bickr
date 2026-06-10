import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlainText, RichText, segmentVerticalScriptRuns } from "./App";

describe("segmentVerticalScriptRuns", () => {
	it("groups Mongolian words across spaces and Mongolian punctuation", () => {
		expect(segmentVerticalScriptRuns("hello ᠴᠢᠩᠭᠢᠰ ᠬᠠᠭᠠᠨ᠂ world")).toEqual([
			{ text: "hello ", verticalScript: null },
			{ text: "ᠴᠢᠩᠭᠢᠰ ᠬᠠᠭᠠᠨ᠂", verticalScript: "mong" },
			{ text: " world", verticalScript: null },
		]);
	});

	it("groups Phags-Pa words across spaces and Phags-Pa punctuation", () => {
		expect(segmentVerticalScriptRuns("x ꡀꡁ ꡂꡃ꡴ y")).toEqual([
			{ text: "x ", verticalScript: null },
			{ text: "ꡀꡁ ꡂꡃ꡴", verticalScript: "phag" },
			{ text: " y", verticalScript: null },
		]);
	});

	it("leaves Latin and Cyrillic text horizontal", () => {
		expect(segmentVerticalScriptRuns("Temujin Чингис Хаан")).toEqual([
			{ text: "Temujin Чингис Хаан", verticalScript: null },
		]);
	});

	it("does not verticalize shared punctuation without script letters", () => {
		expect(segmentVerticalScriptRuns("᠂ ᠃ ")).toEqual([{ text: "᠂ ᠃ ", verticalScript: null }]);
	});

	it("does not merge adjacent Mongolian and Phags-Pa runs", () => {
		expect(segmentVerticalScriptRuns("ᠠ ᠡ ꡀ ꡁ")).toEqual([
			{ text: "ᠠ ᠡ", verticalScript: "mong" },
			{ text: " ", verticalScript: null },
			{ text: "ꡀ ꡁ", verticalScript: "phag" },
		]);
	});
});

describe("vertical script rendering", () => {
	it("renders Mongolian and Phags-Pa runs as isolated vertical spans", () => {
		const html = renderToStaticMarkup(<PlainText text="A ᠴᠢᠩᠭᠢᠰ and ꡀꡁ" />);

		expect(html).toContain('class="vertical-script-run vertical-script-run-mong"');
		expect(html).toContain('class="vertical-script-run vertical-script-run-phag"');
		expect(html).toContain('dir="ltr"');
	});

	it("preserves rich references while wrapping nearby vertical script text", () => {
		const html = renderToStaticMarkup(
			<RichText onReference={() => undefined} text="See u/alice ᠴᠢᠩᠭᠢᠰ" />,
		);

		expect(html).toContain("ref-button");
		expect(html).toContain('<span class="pre">u/</span>alice');
		expect(html).toContain('class="vertical-script-run vertical-script-run-mong"');
	});
});
