import { type ApiErrorCode, type ApiErrorDetails, type ApiErrorPayload, type ApiSuccessPayload } from "./model";

export function ok<T>(data: T, init?: ResponseInit): Response {
	return Response.json(
		{
			ok: true,
			data,
		} satisfies ApiSuccessPayload<T>,
		{
			headers: {
				"cache-control": "no-store",
			},
			...init,
		},
	);
}

export function fail(code: ApiErrorCode, message: string, status: number, details?: ApiErrorDetails): Response {
	return Response.json(
		{
			ok: false,
			error: code,
			message,
			...(details ? { details } : {}),
		} satisfies ApiErrorPayload,
		{
			status,
			headers: {
				"cache-control": "no-store",
			},
		},
	);
}

export async function readJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		throw new Error("Expected an application/json request body.");
	}

	return request.json();
}
