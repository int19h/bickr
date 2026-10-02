export const mathLimits = { sourceBytes: 16_384, svgBytes: 524_288, elements: 5000, pathBytes: 409_600, coordinate: 500_000, widthEx: 256, heightEx: 128 } as const;
export type MathRequest = { kind: "render"; id: number; source: string; display: boolean };
export type MathResult = { kind: "rendered"; svg: string } | { kind: "rejected" };
export type MathResponse = { kind: "result"; id: number; result: MathResult };
export function validMathSource(source: string): boolean { return source.length <= mathLimits.sourceBytes && new TextEncoder().encode(source).length <= mathLimits.sourceBytes; }
export function isMathRequest(value: unknown): value is MathRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<MathRequest>;
	return request.kind === "render" && Number.isSafeInteger(request.id) && typeof request.source === "string" && validMathSource(request.source) && typeof request.display === "boolean";
}
export function isMathResponse(value: unknown): value is MathResponse {
	if (!value || typeof value !== "object") return false;
	const response = value as Partial<MathResponse>;
	const result = response.result;
	return response.kind === "result" && Number.isSafeInteger(response.id) && !!result && (result.kind === "rejected" || (result.kind === "rendered" && typeof result.svg === "string" && result.svg.length <= mathLimits.svgBytes));
}
