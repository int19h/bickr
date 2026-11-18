import { mermaidLimits } from '@bickr/shared/content-limits';
import mermaid from "mermaid";
import { isDiagramRequest, mermaidExportLimit, type DiagramResponse } from "./diagram-protocol";
import { observeDiagramHeight } from "./diagram-layout";

// All parsing, CSS, and layout measurement occur in the opaque sandbox frame.
// Its CSP blocks network access even during Mermaid's pre-sanitization work.
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, maxTextSize: mermaidLimits.sourceBytes, maxEdges: mermaidLimits.edges, htmlLabels: false, flowchart: { htmlLabels: false }, theme: "neutral", fontFamily: "sans-serif" });
// One frame renders one diagram. After that it answers only export requests
// that carry the token of that render.
let rendered: { token: string; svg: string | null } | null = null;
function reply(response: DiagramResponse): void { window.parent.postMessage(response, "*"); }
window.addEventListener("message", async (event: MessageEvent<unknown>) => {
	if (event.source !== window.parent || window.parent === window || !isDiagramRequest(event.data)) return;
	const request = event.data;
	if (request.kind === "export") {
		if (rendered?.token !== request.token) return;
		if (rendered.svg) reply({ kind: "exported", token: request.token, svg: rendered.svg });
		else reply({ kind: "error", token: request.token });
		return;
	}
	if (rendered) return;
	const { layout, source, token } = request;
	rendered = { token, svg: null };
	try {
		const host = document.getElementById("drawing")!;
		const { svg } = await mermaid.render("diagram", source, host);
		// Mermaid sanitizes strict-mode output. Even a library regression remains
		// confined to this frame, which has no same-origin or network privileges.
		host.innerHTML = svg;
		const drawing = host.querySelector("svg");
		if (!drawing) throw new Error("Missing diagram");
		for (const link of host.querySelectorAll("a")) link.replaceWith(...link.childNodes);
		// The export is the drawing as shown, without links, before the layout
		// styles below that only fit it into this frame.
		const exported = drawing.outerHTML;
		rendered.svg = exported.length <= mermaidExportLimit ? exported : null;
		if (layout === "viewer") {
			// The viewer frame has a fixed size: fit the whole diagram into it.
			document.body.classList.add("viewer");
			drawing.style.maxWidth = "100%";
			drawing.style.width = "100%";
			drawing.style.height = "100%";
			reply({ kind: "ready", token, height: Math.max(1, Math.ceil(host.getBoundingClientRect().height)) });
			return;
		}
		// Mermaid caps width at its natural layout size. Keep that cap so tall,
		// narrow diagrams do not stretch to the full width of the post.
		drawing.style.height = "auto";
		const stopObserving = observeDiagramHeight(host, (height) => reply({ kind: "ready", token, height }));
		window.addEventListener("pagehide", stopObserving, { once: true });
	} catch {
		document.getElementById("drawing")!.replaceChildren();
		reply({ kind: "error", token });
	}
});
// Parent waits for module initialization, not merely iframe navigation load.
window.parent.postMessage({ kind: "loaded" }, "*");
