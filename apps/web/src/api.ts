import type { ApiErrorDetails } from "@bickr/shared/model";

export type ApiSuccess<T> = { ok: true; data: T };
/** `details` carries typed causes; owner screens branch on it, never on `message`. */
export type ApiFailure = { ok: false; error: string; message: string; details?: ApiErrorDetails };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export async function api<T = unknown>(
	path: string,
	options?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
	const hasBody = options ? Object.prototype.hasOwnProperty.call(options, "body") && options.body !== undefined : false;
	const body =
		hasBody && options?.body instanceof FormData ? options.body
		: hasBody ? JSON.stringify(options?.body)
		: undefined;
	const headers = hasBody && !(options?.body instanceof FormData) ? { "content-type": "application/json" } : undefined;
	let response: Response;
	try {
		response = await fetch(path, {
			body,
			headers,
			method: options?.method ?? "GET",
		});
	} catch {
		return {
			ok: false,
			error: "network_error",
			message: "Network request failed.",
		};
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		return {
			ok: false,
			error: "network_error",
			message: "Network response could not be read.",
		};
	}
	let payload: unknown = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		return {
			ok: false,
			error: "server_error",
			message: response.ok ? "Response was not JSON." : response.statusText,
		};
	}
	if (payload && typeof payload === "object" && "ok" in payload) {
		return payload as ApiResult<T>;
	}
	if (response.ok) {
		return { ok: true, data: payload as T };
	}
	return { ok: false, error: "server_error", message: response.statusText || "Request failed." };
}

export async function apiResponseErrorMessage(response: Response): Promise<string> {
	let text = "";
	try {
		text = await response.text();
	} catch {
		return response.statusText || "Network response could not be read.";
	}
	try {
		const payload = text ? JSON.parse(text) as unknown : null;
		if (payload && typeof payload === "object" && "message" in payload && typeof (payload as { message?: unknown }).message === "string") {
			return (payload as { message: string }).message;
		}
	} catch {
		return response.ok ? "Response was not JSON." : response.statusText || text || "Request failed.";
	}
	return response.statusText || "Request failed.";
}
