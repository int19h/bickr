export type ApiSuccess<T> = {
	ok: true;
	data: T;
};

export type ApiFailure = {
	ok: false;
	error: string;
	message: string;
	details?: unknown;
};

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export type RequestOptions = {
	method?: string;
	body?: unknown;
	headers?: HeadersInit;
	auth?: boolean;
	/** Caller-owned cancellation, e.g. a run the owner interrupted. */
	signal?: AbortSignal;
	/** Upper bound on the whole request, after which it is reported as a timeout. */
	timeoutMs?: number;
};

export class BickrClient {
	readonly host: string;
	readonly token?: string;

	constructor(input: { host: string; token?: string }) {
		this.host = input.host.replace(/\/+$/, "");
		this.token = input.token;
	}

	async request<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
		const response = await this.send(this.apiUrl(path), options);
		const contentType = response.headers.get("content-type") ?? "";
		const payload = contentType.includes("application/json") ?
			await response.json() as unknown
		:	undefined;
		if (isApiEnvelope<T>(payload)) {
			return payload;
		}
		if (!response.ok) {
			throw new ApiError("server_error", response.statusText || `HTTP ${response.status}`, response.status);
		}
		throw new ApiError("server_error", "Bickr API response was not JSON.", response.status);
	}

	async stream(path: string, options: RequestOptions = {}): Promise<Response> {
		const response = await this.send(this.apiUrl(path), options);
		if (!response.ok) {
			const text = await response.text();
			throw new ApiError("server_error", text || response.statusText || `HTTP ${response.status}`, response.status);
		}
		return response;
	}

	async download(url: string): Promise<Response> {
		const response = await this.send(url, { auth: false });
		if (!response.ok) {
			throw new ApiError("download_failed", `Download failed with HTTP ${response.status}.`, response.status);
		}
		return response;
	}

	apiUrl(path: string): string {
		if (!path.startsWith("/")) {
			throw new Error("API path must start with '/'.");
		}
		return `${this.host}/api${path}`;
	}

	/**
	 * One request, with the caller's cancellation and its deadline folded into a
	 * single controller rather than `AbortSignal.any`, so the failure can say
	 * which of the two fired: a run the owner stopped is not the same outcome as
	 * one that ran out of time, and a spotlight batch reports them differently.
	 */
	private async send(url: string, options: RequestOptions): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const deadline =
			options.timeoutMs === undefined ? undefined : (
				setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, options.timeoutMs)
			);
		const abortFromCaller = () => controller.abort();
		options.signal?.addEventListener("abort", abortFromCaller, { once: true });
		if (options.signal?.aborted) {
			controller.abort();
		}
		try {
			return await fetch(url, { ...this.fetchInit(options), signal: controller.signal });
		} catch (error) {
			throw requestFailure(error, { timedOut, cancelled: Boolean(options.signal?.aborted), timeoutMs: options.timeoutMs });
		} finally {
			if (deadline !== undefined) {
				clearTimeout(deadline);
			}
			options.signal?.removeEventListener("abort", abortFromCaller);
		}
	}

	private fetchInit(options: RequestOptions): RequestInit {
		const headers = new Headers(options.headers);
		if (options.auth !== false && this.token) {
			headers.set("authorization", `Bearer ${this.token}`);
		}
		let body: BodyInit | undefined;
		if (options.body !== undefined) {
			if (typeof options.body === "string" || options.body instanceof FormData) {
				body = options.body;
			} else {
				body = JSON.stringify(options.body);
				headers.set("content-type", "application/json");
			}
		}
		return {
			method: options.method ?? "GET",
			headers,
			body,
		};
	}
}

export function unwrap<T>(envelope: ApiEnvelope<T>): T {
	if (envelope.ok) {
		return envelope.data;
	}
	throw new ApiError(envelope.error, envelope.message, 1, envelope.details);
}

/**
 * Why a request produced no response at all. The distinction is the caller's to
 * act on — a timeout may be worth a longer `--timeout`, a cancellation is what
 * the owner asked for, and a network failure is neither — so it is decided here
 * where the cause is known, not read back out of a message later.
 */
function requestFailure(
	error: unknown,
	context: { timedOut: boolean; cancelled: boolean; timeoutMs?: number },
): ApiError {
	if (context.timedOut) {
		const seconds = Math.round((context.timeoutMs ?? 0) / 1_000);
		return new ApiError("timeout", `The request took longer than ${seconds}s and was stopped.`, 0);
	}
	if (context.cancelled) {
		return new ApiError("aborted", "The request was cancelled.", 0);
	}
	return new ApiError("network_error", error instanceof Error ? error.message : "Network request failed.", 0);
}

/** `status` is 0 when the failure happened before any response arrived. */
export class ApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: unknown;

	constructor(code: string, message: string, status: number, details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

function isApiEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return record.ok === true || (record.ok === false && typeof record.error === "string" && typeof record.message === "string");
}
