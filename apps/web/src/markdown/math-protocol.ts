import { mathLimits } from "@bickr/shared/content-limits";
export { mathLimits } from "@bickr/shared/content-limits";
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
