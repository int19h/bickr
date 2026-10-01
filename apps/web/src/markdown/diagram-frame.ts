import mermaid from "mermaid";
import { isDiagramRequest, type DiagramResponse } from "./diagram-protocol";

// All parsing, CSS, and layout measurement occur in the opaque sandbox frame.
// Its CSP blocks network access even during Mermaid's pre-sanitization work.
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, maxTextSize: 16_384, maxEdges: 300, htmlLabels: false, flowchart: { htmlLabels: false }, theme: "neutral", fontFamily: "sans-serif" });
let rendered = false;
window.addEventListener("message", async (event: MessageEvent<unknown>) => {
	if (event.source !== window.parent || window.parent === window || rendered || !isDiagramRequest(event.data)) return;
	rendered = true;
	const { source, token } = event.data;
	function reply(response: DiagramResponse): void { window.parent.postMessage(response, "*"); }
	try {
		const host = document.getElementById("drawing")!;
		const { svg } = await mermaid.render("diagram", source, host);
		// Mermaid sanitizes strict-mode output. Even a library regression remains
		// confined to this frame, which has no same-origin or network privileges.
		host.innerHTML = svg;
		const drawing = host.querySelector("svg");
		if (!drawing) throw new Error("Missing diagram");
		drawing.style.maxWidth = "100%";
		drawing.style.height = "auto";
		for (const link of host.querySelectorAll("a")) link.replaceWith(...link.childNodes);
		const height = Math.min(1200, Math.max(80, Math.ceil(host.getBoundingClientRect().height)));
		reply({ kind: "ready", token, height });
	} catch {
		document.getElementById("drawing")!.replaceChildren();
		reply({ kind: "error", token });
	}
});
// Parent waits for module initialization, not merely iframe navigation load.
window.parent.postMessage({ kind: "loaded" }, "*");
