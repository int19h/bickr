import { mermaidLimits } from '@bickr/shared/content-limits';
export const mermaidSourceLimit = mermaidLimits.sourceBytes;
/**
 * The largest SVG text the frame may return for a download. Mermaid output for
 * a source within its limits stays well below this; the bound keeps a faulty
 * frame from handing the page an unbounded string.
 */
export const mermaidExportLimit = 4 * 1024 * 1024;
/**
 * `inline` keeps the natural width of the diagram inside a post. `viewer` fits
 * the whole diagram into the frame, for the full-screen viewer.
 */
export type DiagramLayout = "inline" | "viewer";
export type DiagramRequest =
	| { kind: "render"; token: string; source: string; layout: DiagramLayout }
	| { kind: "export"; token: string };
export type DiagramResponse =
	| { kind: "ready"; token: string; height: number }
	| { kind: "error"; token: string }
	| { kind: "exported"; token: string; svg: string };
export function validDiagramSource(source: string): boolean {
	return source.length <= mermaidSourceLimit && new TextEncoder().encode(source).length <= mermaidSourceLimit && !/%%\s*\{|^\s*---/.test(source);
}
function validToken(value: unknown): value is string {
	return typeof value === "string" && value.length <= 100;
}
export function isDiagramRequest(value: unknown): value is DiagramRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	if (!validToken(request.token)) return false;
	if (request.kind === "export") return true;
	return request.kind === "render" && (request.layout === "inline" || request.layout === "viewer") && typeof request.source === "string" && validDiagramSource(request.source);
}
export function isDiagramResponse(value: unknown): value is DiagramResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const response = value as Record<string, unknown>;
	if (!validToken(response.token)) return false;
	switch (response.kind) {
		case "error": return true;
		case "ready": return typeof response.height === "number" && Number.isFinite(response.height) && response.height > 0;
		case "exported": return typeof response.svg === "string" && response.svg.length > 0 && response.svg.length <= mermaidExportLimit;
		default: return false;
	}
}
