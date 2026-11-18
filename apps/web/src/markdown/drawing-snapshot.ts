import { mermaidLimits } from "@bickr/shared/content-limits";
import mermaid from "mermaid";
import { decodeDrawingSnapshot } from "./drawing-snapshot-protocol";
import { prepareSvg } from "./svg-policy";
import { validDiagramSource } from "./diagram-protocol";

// The preview renderer screenshots this page at 1200x630. The drawing comes in
// the URL fragment, which never reaches a server. The page has the policy of
// the diagram frame: no network, no same-origin access, and it runs the same
// SVG policy and Mermaid configuration as the page that shows the post.
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, maxTextSize: mermaidLimits.sourceBytes, maxEdges: mermaidLimits.edges, htmlLabels: false, flowchart: { htmlLabels: false }, theme: "neutral", fontFamily: "sans-serif" });

function finish(state: "ready" | "error"): void {
	document.documentElement.dataset.snapshot = state;
}

async function render(): Promise<void> {
	const drawing = decodeDrawingSnapshot(location.hash.slice(1));
	const host = document.getElementById("drawing")!;
	if (!drawing) return finish("error");
	if (drawing.language === "svg") {
		const result = prepareSvg(drawing.source, "bickr-snapshot");
		if (result.kind === "rejected") return finish("error");
		host.replaceChildren(result.fragment);
		return finish("ready");
	}
	if (!validDiagramSource(drawing.source)) return finish("error");
	const { svg } = await mermaid.render("diagram", drawing.source, host);
	host.innerHTML = svg;
	const element = host.querySelector("svg");
	if (!element) return finish("error");
	// Mermaid caps the width at its natural size; the preview fills the card.
	element.style.maxWidth = "100%";
	return finish("ready");
}

render().catch(() => finish("error"));
