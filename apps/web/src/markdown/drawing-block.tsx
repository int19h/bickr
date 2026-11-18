import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Icon, Modal, OverlayPortal } from "../ui";
import { prepareSvg } from "./svg-policy";
import { isDiagramResponse, validDiagramSource, type DiagramLayout, type DiagramRequest } from "./diagram-protocol";

type DrawingLanguage = "svg" | "mermaid";
type DrawingState = { kind: "pending" } | { kind: "ready" } | { kind: "error"; reason: string };
/** A viewer that its owner controls, for example through the URL. */
export type DrawingViewerControl = { open: boolean; onOpen: () => void; onClose: () => void };
type DrawingProps = { language: DrawingLanguage; source: string; viewer?: DrawingViewerControl; "data-md-start"?: number; "data-md-end"?: number; "data-md-atomic"?: boolean };

/**
 * Reads the SVG that a surface shows, for a download. It resolves to null if
 * the surface has no drawing, or if the renderer does not answer.
 */
type ExportSvg = () => Promise<string | null>;

const drawingNames: Record<DrawingLanguage, string> = { svg: "SVG drawing", mermaid: "Mermaid diagram" };
const sourceFileNames: Record<DrawingLanguage, string> = { svg: "drawing.svg", mermaid: "diagram.mmd" };
const renderedFileNames: Record<DrawingLanguage, string> = { svg: "drawing.svg", mermaid: "diagram.svg" };

export function DrawingBlock(props: DrawingProps) {
	// Measurement and readiness belong to one source and language.
	return <DrawingContent key={`${props.language}:${props.source}`} {...props} />;
}

function DrawingContent({ language, source, viewer, ...sourceAttributes }: DrawingProps) {
	const container = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [started, setStarted] = useState(false);
	const [state, setState] = useState<DrawingState>({ kind: "pending" });
	const [height, setHeight] = useState(180);
	const [localViewerOpen, setLocalViewerOpen] = useState(false);
	const viewerOpen = viewer ? viewer.open : localViewerOpen;
	const openViewer = viewer ? viewer.onOpen : () => setLocalViewerOpen(true);
	const closeViewer = viewer ? viewer.onClose : () => setLocalViewerOpen(false);
	useEffect(() => {
		if (!container.current) return;
		if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
		const observer = new IntersectionObserver((entries) => { setVisible(entries.some((entry) => entry.isIntersecting)); }, { rootMargin: "200px" });
		observer.observe(container.current);
		return () => observer.disconnect();
	}, []);
	useEffect(() => { if (visible) setStarted(true); }, [visible]);
	const label = `Open ${drawingNames[language].toLowerCase()}`;
	return <div className="drawing-block" ref={container} {...sourceAttributes}>
		{!visible && started && state.kind !== "error" && <div aria-hidden="true" data-selection-exclude="true" style={{ height: language === "svg" ? 360 : height }} />}
		{visible && <DrawingSurface height={height} language={language} layout="inline" onHeight={setHeight} onState={setState} source={source} />}
		{state.kind === "pending" && <span data-selection-exclude="true">{visible ? "Rendering drawing…" : "Drawing loads when visible."}</span>}
		{state.kind === "error" && <p data-selection-exclude="true" role="status">{state.reason}</p>}
		{/* A cover over the whole block, because the cross-origin Mermaid frame takes every click on it. */}
		<button aria-label={label} className="drawing-open" data-selection-exclude="true" onClick={openViewer} title={label} type="button">
			<span className="drawing-open-badge"><Icon name="expand" size={14} /></span>
		</button>
		{viewerOpen && <DrawingViewer initialView={state.kind === "error" ? "source" : "rendered"} language={language} onClose={closeViewer} source={source} />}
	</div>;
}

/**
 * Renders one drawing. SVG goes through the drawing policy into the page.
 * Mermaid renders in an opaque sandboxed frame. The inline layout keeps the
 * natural size of a Mermaid diagram and reports its height. The viewer layout
 * fits the drawing into the space that its parent gives it.
 */
function DrawingSurface({ exportRef, height, language, layout, onHeight, onState, source }: {
	exportRef?: RefObject<ExportSvg | null>;
	height?: number;
	language: DrawingLanguage;
	layout: DiagramLayout;
	onHeight?: (height: number) => void;
	onState: (state: DrawingState) => void;
	source: string;
}) {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const svgHost = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const [failed, setFailed] = useState(false);
	// The callbacks are state setters, so only the identity of the drawing
	// restarts a render.
	useEffect(() => {
		onState({ kind: "pending" });
		setFailed(false);
		if (language === "svg") {
			const result = prepareSvg(source, `bickr-svg-${id}`);
			if (result.kind === "rejected") { setFailed(true); onState({ kind: "error", reason: result.reason }); return; }
			const host = svgHost.current;
			host?.replaceChildren(result.fragment);
			onState({ kind: "ready" });
			if (exportRef) exportRef.current = async () => {
				const drawing = host?.querySelector("svg");
				return drawing ? new XMLSerializer().serializeToString(drawing) : null;
			};
			return () => { host?.replaceChildren(); if (exportRef) exportRef.current = null; };
		}
		if (!validDiagramSource(source)) { setFailed(true); onState({ kind: "error", reason: "Mermaid source must be at most 16 KiB and cannot contain configuration directives." }); return; }
		const token = crypto.randomUUID();
		let sent = false;
		let ready = false;
		const exports = new Set<(svg: string | null) => void>();
		const settleExports = (svg: string | null) => { for (const settle of exports) settle(svg); exports.clear(); };
		const timeout = setTimeout(() => { setFailed(true); onState({ kind: "error", reason: "The Mermaid renderer did not respond." }); }, 15_000);
		function receive(event: MessageEvent<unknown>): void {
			if (event.source !== frame.current?.contentWindow) return;
			if (!sent && event.data && typeof event.data === "object" && "kind" in event.data && event.data.kind === "loaded") {
				sent = true;
				const request: DiagramRequest = { kind: "render", token, source, layout };
				frame.current?.contentWindow?.postMessage(request, "*");
				return;
			}
			if (!isDiagramResponse(event.data) || event.data.token !== token) return;
			switch (event.data.kind) {
				case "exported":
					settleExports(event.data.svg);
					return;
				case "error":
					// After a render, an error answers an export that has no SVG.
					if (ready) { settleExports(null); return; }
					clearTimeout(timeout);
					setFailed(true);
					onState({ kind: "error", reason: "Mermaid could not render this diagram." });
					return;
				case "ready":
					clearTimeout(timeout);
					ready = true;
					onHeight?.(Math.max(80, Math.min(1200, event.data.height)));
					onState({ kind: "ready" });
			}
		}
		if (exportRef) exportRef.current = () => new Promise<string | null>((resolve) => {
			const target = frame.current?.contentWindow;
			if (!ready || !target) { resolve(null); return; }
			const settle = (svg: string | null) => { clearTimeout(expiry); resolve(svg); };
			const expiry = setTimeout(() => { exports.delete(settle); resolve(null); }, 5_000);
			exports.add(settle);
			const request: DiagramRequest = { kind: "export", token };
			target.postMessage(request, "*");
		});
		window.addEventListener("message", receive);
		return () => {
			clearTimeout(timeout);
			window.removeEventListener("message", receive);
			settleExports(null);
			if (exportRef) exportRef.current = null;
		};
	}, [id, language, layout, source]);
	if (language === "svg") return <div className={layout === "viewer" ? "svg-drawing svg-drawing-viewer" : "svg-drawing"} ref={svgHost} />;
	if (failed) return null;
	return <iframe ref={frame} src="/diagram-renderer" sandbox="allow-scripts" referrerPolicy="no-referrer" title={drawingNames.mermaid} style={layout === "inline" ? { height } : undefined} />;
}

type ViewerTab = "rendered" | "source";

function DrawingViewer({ initialView, language, onClose, source }: { initialView: ViewerTab; language: DrawingLanguage; onClose: () => void; source: string }) {
	const [view, setView] = useState<ViewerTab>(initialView);
	// Until the reader picks a tab, a drawing that does not render opens on its
	// source. The inline block may not have failed yet when the viewer opens,
	// for example from a link, so the viewer follows its own render.
	const [tabChosen, setTabChosen] = useState(false);
	const chooseView = (next: ViewerTab) => { setTabChosen(true); setView(next); };
	const [state, setState] = useState<DrawingState>({ kind: "pending" });
	const [downloading, setDownloading] = useState(false);
	const exportSvg = useRef<ExportSvg | null>(null);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	async function download(): Promise<void> {
		if (view === "source") { saveFile(sourceFileNames[language], source); return; }
		const read = exportSvg.current;
		if (!read) return;
		setDownloading(true);
		const svg = await read();
		if (!mounted.current) return;
		setDownloading(false);
		if (svg) saveFile(renderedFileNames[language], svg);
	}
	useEffect(() => { if (state.kind === "error" && !tabChosen) setView("source"); }, [state.kind, tabChosen]);
	const canDownload = view === "source" || (state.kind === "ready" && !downloading);
	return <OverlayPortal><Modal
		className="drawing-viewer"
		headActions={<>
			<div aria-label="View" className="tabs drawing-viewer-tabs" role="tablist">
				<button aria-selected={view === "rendered"} onClick={() => chooseView("rendered")} role="tab" type="button">Rendered</button>
				<button aria-selected={view === "source"} onClick={() => chooseView("source")} role="tab" type="button">Source</button>
			</div>
			<button className="btn ghost drawing-viewer-download" disabled={!canDownload} onClick={() => void download()} type="button">
				{downloading ? <span className="spinner" /> : <Icon name="download" size={14} />}
				Download
			</button>
		</>}
		onClose={onClose}
		open
		title={drawingNames[language]}
	>
		{/* The rendered surface stays mounted while Source shows, so switching back does not render again. */}
		<div className="drawing-viewer-stage" hidden={view !== "rendered"} role="tabpanel">
			<DrawingSurface exportRef={exportSvg} language={language} layout="viewer" onState={setState} source={source} />
			{state.kind === "pending" && <span className="drawing-viewer-status">Rendering drawing…</span>}
			{state.kind === "error" && <p className="drawing-viewer-status" role="status">{state.reason}</p>}
		</div>
		{view === "source" && <pre className="drawing-viewer-source" role="tabpanel"><code>{source}</code></pre>}
	</Modal></OverlayPortal>;
}

/**
 * Saves text as a file. The blob is `application/octet-stream`, and the link
 * carries `download`, so the browser stores the file and never opens it: the
 * SVG text must not run as a document in the app origin. The URL is revoked
 * after a delay, because some browsers start the download asynchronously.
 */
function saveFile(name: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
