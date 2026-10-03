import { useEffect, useId, useRef, useState } from "react";
import { prepareSvg } from "./svg-policy";
import { isDiagramResponse, validDiagramSource, type DiagramRequest } from "./diagram-protocol";

type DrawingState = { kind: "pending" } | { kind: "ready" } | { kind: "error"; reason: string };
type DrawingProps = { language: "svg" | "mermaid"; source: string; "data-md-start"?: number; "data-md-end"?: number; "data-md-atomic"?: boolean };
export function DrawingBlock(props: DrawingProps) {
	// Measurement and readiness belong to one source and language.
	return <DrawingContent key={`${props.language}:${props.source}`} {...props} />;
}
function DrawingContent({ language, source, ...sourceAttributes }: DrawingProps) {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const container = useRef<HTMLDivElement>(null);
	const svgHost = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const [visible, setVisible] = useState(false);
	const [started, setStarted] = useState(false);
	const [state, setState] = useState<DrawingState>({ kind: "pending" });
	const [height, setHeight] = useState(180);
	useEffect(() => {
		if (!container.current) return;
		if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
		const observer = new IntersectionObserver((entries) => { setVisible(entries.some((entry) => entry.isIntersecting)); }, { rootMargin: "200px" });
		observer.observe(container.current);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (!visible) return;
		setStarted(true);
		setState({ kind: "pending" });
		if (language === "svg") {
			const result = prepareSvg(source, `bickr-svg-${id}`);
			if (result.kind === "rejected") setState({ kind: "error", reason: result.reason });
			else { svgHost.current?.replaceChildren(result.fragment); setState({ kind: "ready" }); }
			return () => svgHost.current?.replaceChildren();
		}
		if (!validDiagramSource(source)) { setState({ kind: "error", reason: "Mermaid source must be at most 16 KiB and cannot contain configuration directives." }); return; }
		const token = crypto.randomUUID();
		let sent = false;
		const timeout = setTimeout(() => setState({ kind: "error", reason: "The Mermaid renderer did not respond." }), 15_000);
		function receive(event: MessageEvent<unknown>): void {
			if (event.source !== frame.current?.contentWindow) return;
			if (!sent && event.data && typeof event.data === "object" && "kind" in event.data && event.data.kind === "loaded") {
				sent = true;
				const request: DiagramRequest = { kind: "render", token, source };
				frame.current?.contentWindow?.postMessage(request, "*");
				return;
			}
			if (!isDiagramResponse(event.data) || event.data.token !== token) return;
			clearTimeout(timeout);
			if (event.data.kind === "error") setState({ kind: "error", reason: "Mermaid could not render this diagram." });
			else { setHeight(Math.max(80, Math.min(1200, event.data.height))); setState({ kind: "ready" }); }
		}
		window.addEventListener("message", receive);
		return () => { clearTimeout(timeout); window.removeEventListener("message", receive); };
	}, [id, language, source, visible]);
	return <div className="drawing-block" ref={container} {...sourceAttributes}>
		{!visible && started && state.kind !== "error" && <div aria-hidden="true" data-selection-exclude="true" style={{ height: language === "svg" ? 360 : height }} />}
		{visible && language === "svg" && <div className="svg-drawing" ref={svgHost} />}
		{visible && language === "mermaid" && state.kind !== "error" && <iframe key={source} ref={frame} src="/diagram-renderer" sandbox="allow-scripts" referrerPolicy="no-referrer" title="Mermaid diagram" style={{ height }} />}
		{state.kind === "pending" && <span data-selection-exclude="true">{visible ? "Rendering drawing…" : "Drawing loads when visible."}</span>}
		{state.kind === "error" && <p data-selection-exclude="true" role="status">{state.reason}</p>}
		<details open={state.kind === "error"} data-selection-exclude="true"><summary>View {language === "svg" ? "SVG" : "Mermaid"} source</summary><pre><code>{source}</code></pre></details>
	</div>;
}
