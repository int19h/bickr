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
};

export class BickrClient {
	readonly host: string;
	readonly token?: string;

	constructor(input: { host: string; token?: string }) {
		this.host = input.host.replace(/\/+$/, "");
		this.token = input.token;
	}

	async request<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
		const response = await fetch(this.apiUrl(path), this.fetchInit(options));
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
		const response = await fetch(this.apiUrl(path), this.fetchInit(options));
		if (!response.ok) {
			const text = await response.text();
			throw new ApiError("server_error", text || response.statusText || `HTTP ${response.status}`, response.status);
		}
		return response;
	}

	async download(url: string): Promise<Response> {
		const response = await fetch(url);
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
