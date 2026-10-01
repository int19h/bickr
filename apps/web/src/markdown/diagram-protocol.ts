export const mermaidSourceLimit = 16_384;
export type DiagramRequest = { kind: "render"; token: string; source: string };
export type DiagramResponse = { kind: "ready"; token: string; height: number } | { kind: "error"; token: string };
export function validDiagramSource(source: string): boolean {
	return source.length <= mermaidSourceLimit && new TextEncoder().encode(source).length <= mermaidSourceLimit && !/%%\s*\{|^\s*---/.test(source);
}
export function isDiagramRequest(value: unknown): value is DiagramRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Partial<DiagramRequest>;
	return request.kind === "render" && typeof request.token === "string" && request.token.length <= 100 && typeof request.source === "string" && validDiagramSource(request.source);
}
export function isDiagramResponse(value: unknown): value is DiagramResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const response = value as Partial<DiagramResponse>;
	return typeof response.token === "string" && response.token.length <= 100 && (response.kind === "error" || (response.kind === "ready" && typeof response.height === "number" && Number.isFinite(response.height) && response.height > 0));
}
