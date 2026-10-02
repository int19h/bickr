import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/js/svg.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import { mathLimits, validMathSource, type MathResult } from "./math-protocol";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
class MathParseError extends Error {}
export function renderMath(source: string, display: boolean): MathResult {
	if (!validMathSource(source)) return { kind: "rejected" };
	try {
		// A fresh input instance prevents definitions and equation tags from leaking
		// across participants. No HTML, require, autoload, or external loader runs.
		const input = new TeX({ packages: ["base", "ams", "newcommand"], maxBuffer: mathLimits.sourceBytes, maxMacros: 1000,
			formatError: () => { throw new MathParseError(); } });
		const output = new SVG({ font: new MathJaxTexFont(), fontCache: "none", linebreaks: { inline: false } });
		const document = mathjax.document("", { InputJax: input, OutputJax: output });
		const node = document.convert(source, { display, em: 16, ex: 8, containerWidth: 1280 });
		const svg = adaptor.tags(node, "svg")[0];
		if (!svg) return { kind: "rejected" };
		const markup = adaptor.outerHTML(svg);
		return new TextEncoder().encode(markup).length <= mathLimits.svgBytes ? { kind: "rendered", svg: markup } : { kind: "rejected" };
	} catch {
		// MathJax is a third-party boundary. Parsing and conversion failures retain
		// literal source. No error-message text determines product behavior.
		return { kind: "rejected" };
	}
}
