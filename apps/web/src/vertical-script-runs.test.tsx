import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { localizedText, type LanguageTag } from "@bickr/shared/model";
import { PlainText, RichText, segmentVerticalScriptRuns, TranslatableText, verticalBlockScriptKindForLanguage } from "./components/content";

const en = "en" as LanguageTag;
const mn = "mn" as LanguageTag;
const mnCyrl = "mn-Cyrl" as LanguageTag;
const mnMong = "mn-Mong" as LanguageTag;
const xalMong = "xal-Mong" as LanguageTag;

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

describe("vertical block language detection", () => {
	it("requires an explicit vertical script subtag", () => {
		expect(verticalBlockScriptKindForLanguage(mnMong)).toBe("mong");
		expect(verticalBlockScriptKindForLanguage(xalMong)).toBe("mong");
		expect(verticalBlockScriptKindForLanguage("mn-Phag")).toBe("phag");
		expect(verticalBlockScriptKindForLanguage(mn)).toBeNull();
		expect(verticalBlockScriptKindForLanguage(mnCyrl)).toBeNull();
		expect(verticalBlockScriptKindForLanguage(en)).toBeNull();
		expect(verticalBlockScriptKindForLanguage("ar")).toBeNull();
		expect(verticalBlockScriptKindForLanguage("ja")).toBeNull();
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

	it("renders explicitly Mongolian-script localized text as one vertical block", () => {
		const html = renderToStaticMarkup(
			<TranslatableText
				as="div"
				directionMode="lines"
				text={localizedText("ᠴᠢᠩᠭᠢᠰ ᠬᠠᠭᠠᠨ᠂", mnMong)}
				verticalScriptLayout="block"
			/>,
		);

		expect(html).toContain("vertical-script-block vertical-script-block-mong");
		expect(html).toContain('lang="mn-Mong"');
		expect(html).not.toContain("vertical-script-run");
		expect(html).not.toContain("bidi-line");
	});

	it("does not use block layout for bare Mongolian or Cyrillic Mongolian tags", () => {
		const bare = renderToStaticMarkup(
			<TranslatableText
				as="div"
				text={localizedText("ᠴᠢᠩᠭᠢᠰ", mn)}
				verticalScriptLayout="block"
			/>,
		);
		const cyrl = renderToStaticMarkup(
			<TranslatableText
				as="div"
				text={localizedText("Чингис хаан", mnCyrl)}
				verticalScriptLayout="block"
			/>,
		);

		expect(bare).not.toContain("vertical-script-block");
		expect(bare).toContain("vertical-script-run");
		expect(cyrl).not.toContain("vertical-script-block");
		expect(cyrl).not.toContain("vertical-script-run");
	});

	it("keeps mixed horizontal text on the inline vertical-run path", () => {
		const html = renderToStaticMarkup(
			<TranslatableText
				as="div"
				text={localizedText("A ᠴᠢᠩᠭᠢᠰ phrase", en)}
				verticalScriptLayout="block"
			/>,
		);

		expect(html).not.toContain("vertical-script-block");
		expect(html).toContain("vertical-script-run vertical-script-run-mong");
	});

	it("preserves rich references inside a vertical block without nested vertical runs", () => {
		const html = renderToStaticMarkup(
			<TranslatableText
				as="div"
				onReference={() => undefined}
				rich
				text={localizedText("ᠴᠢᠩᠭᠢᠰ u/alice", mnMong)}
				verticalScriptLayout="block"
			/>,
		);

		expect(html).toContain("vertical-script-block vertical-script-block-mong");
		expect(html).toContain("ref-button");
		expect(html).toContain('<span class="pre">u/</span>alice');
		expect(html).not.toContain("vertical-script-run");
	});
});
