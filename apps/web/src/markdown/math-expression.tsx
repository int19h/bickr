import { useEffect, useRef, useState } from "react";
import { mathService } from "./math-service";
import { prepareMathSvg } from "./math-svg";
type Props = { source: string; display: boolean; interactive?: boolean };
export function MathExpression(props: Props) { return <MathContent key={`${props.display}:${props.source}`} {...props} />; }
function MathContent({ source, display, interactive = true }: Props) {
	const host = useRef<HTMLSpanElement>(null);
	const [state, setState] = useState<"pending" | "ready" | "rejected">("pending");
	useEffect(() => {
		return mathService.render(source, display, (result) => {
			const prepared = result.kind === "rendered" ? prepareMathSvg(result.svg) : { kind: "rejected" as const };
			if (prepared.kind === "ready") { host.current?.replaceChildren(prepared.fragment); setState("ready"); }
			else setState("rejected");
		});
	}, [source, display]);
	return <span className={`math-expression${display ? " math-display" : ""}`} data-math-state={state}>
		<span ref={host} className="math-output" role="img" aria-label={`Formula: ${source}`} hidden={state !== "ready"} />
		{state !== "ready" && <code className="math-fallback" title={state === "pending" ? "Rendering formula" : "Formula could not render"}>{source}</code>}
		{interactive && <MathSource source={source} />}
	</span>;
}

export function MathSource({ source }: { source: string }) {
	const [showSource, setShowSource] = useState(false);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "selected">("idle");
	const sourceCode = useRef<HTMLElement>(null);
	return <span>
		<span className="math-controls" data-selection-exclude="true"><button type="button" aria-label="View math source" aria-expanded={showSource} onClick={() => setShowSource(!showSource)}>TeX</button></span>
		{showSource && <span className="math-source"><code ref={sourceCode}>{source}</code><button type="button" data-selection-exclude="true" onClick={() => {
			void (async () => {
				try { await navigator.clipboard.writeText(source); setCopyState("copied"); }
				catch {
					if (sourceCode.current) {
						const range = document.createRange(); range.selectNodeContents(sourceCode.current);
						const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
						setCopyState("selected");
					}
				}
			})();
		}}>{copyState === "copied" ? "Copied" : copyState === "selected" ? "Source selected" : "Copy formula"}</button></span>}
	</span>;
}
