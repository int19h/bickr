import type { ApiErrorDetails } from "@bickr/shared/model";

export type ApiSuccess<T> = { ok: true; data: T };
/** `details` carries typed causes; owner screens branch on it, never on `message`. */
export type ApiFailure = { ok: false; error: string; message: string; details?: ApiErrorDetails };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type ApiRequestOptions = {
	method?: string;
	body?: unknown;
	/** Caller-owned cancellation, e.g. a panel closing mid-request. */
	signal?: AbortSignal;
	/** Upper bound on the whole request, after which it is reported as a timeout. */
	timeoutMs?: number;
};

export async function api<T = unknown>(
	path: string,
	options?: ApiRequestOptions,
): Promise<ApiResult<T>> {
	// The caller's signal and the deadline are folded into one controller rather
	// than `AbortSignal.any`, so the result can say which of the two fired: a
	// request the caller cancelled is not the same failure as one that ran out.
	const controller = new AbortController();
	let timedOut = false;
	const timeout =
		options?.timeoutMs === undefined ? undefined : (
			setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, options.timeoutMs)
		);
	const abortFromCaller = () => controller.abort();
	options?.signal?.addEventListener("abort", abortFromCaller, { once: true });
	if (options?.signal?.aborted) {
		controller.abort();
	}
	try {
		return await requestJson<T>(path, options, controller.signal, () => timedOut);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		options?.signal?.removeEventListener("abort", abortFromCaller);
	}
}

async function requestJson<T>(
	path: string,
	options: ApiRequestOptions | undefined,
	signal: AbortSignal,
	timedOut: () => boolean,
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
			signal,
		});
	} catch {
		return abortedOrNetworkFailure(timedOut(), signal, "Network request failed.");
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		return abortedOrNetworkFailure(timedOut(), signal, "Network response could not be read.");
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

function abortedOrNetworkFailure(timedOut: boolean, signal: AbortSignal, networkMessage: string): ApiFailure {
	if (timedOut) {
		return { ok: false, error: "timeout", message: "The request took too long and was stopped." };
	}
	if (signal.aborted) {
		return { ok: false, error: "aborted", message: "The request was cancelled." };
	}
	return { ok: false, error: "network_error", message: networkMessage };
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
