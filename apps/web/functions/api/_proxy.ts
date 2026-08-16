import {
	addInternalServiceAuthHeader,
	type InternalServiceAuthEnv,
	internalServiceUrl,
} from "@bickr/shared/internal-service";

const forwardedServiceRequestHeaders = [
	"accept",
	"idempotency-key",
	"upgrade",
	"connection",
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-protocol",
	"sec-websocket-extensions",
];

export function serviceRequest(
	env: InternalServiceAuthEnv,
	request: Request,
	path: string,
	userId: string,
	body?: string,
): Request {
	const headers = new Headers();
	for (const name of forwardedServiceRequestHeaders) {
		const value = request.headers.get(name);
		if (value !== null) {
			headers.set(name, value);
		}
	}
	headers.set("x-bickr-user-id", userId);
	if (body !== undefined) {
		headers.set("content-type", "application/json");
	} else if (request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
		headers.set("content-type", "application/json");
	}
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);

	return new Request(internalServiceUrl(path), {
		method: request.method,
		headers,
		body,
		signal: request.signal,
	});
}

/**
 * A service request that deliberately carries no viewer identity.
 *
 * Public reads must answer identically for the owner, a signed-in visitor, and
 * an anonymous one, so this proxy omits `x-bickr-user-id` instead of
 * forwarding whoever happens to hold a session. A receiving route therefore
 * authorizes on the addressed entity alone and can never widen its answer for
 * the caller — `requireUserMatch` and `requireAuthenticatedServiceRequest`
 * reject anything reached this way.
 */
export function publicServiceRequest(
	env: InternalServiceAuthEnv,
	request: Request,
	path: string,
): Request {
	const headers = new Headers();
	const accept = request.headers.get("accept");
	if (accept !== null) {
		headers.set("accept", accept);
	}
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);

	return new Request(internalServiceUrl(path), {
		method: request.method,
		headers,
		signal: request.signal,
	});
}

export async function forwardServiceJsonRequest(
	service: Fetcher,
	env: InternalServiceAuthEnv,
	request: Request,
	path: string,
	userId: string,
): Promise<Response> {
	const body = await request.text();
	return service.fetch(serviceRequest(env, request, path, userId, body));
}

export function streamingServiceRequest(
	env: InternalServiceAuthEnv,
	request: Request,
	path: string,
	userId: string,
): Request {
	const headers = new Headers();
	for (const name of [...forwardedServiceRequestHeaders, "content-type"]) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	headers.set("x-bickr-user-id", userId);
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	return new Request(internalServiceUrl(path), {
		method: request.method,
		headers,
		body: request.body,
		signal: request.signal,
	});
}

const serviceFetchTimeoutMs = 30_000;
const serviceJsonBodyMaxBytes = 1_000_000;

/**
 * A service call that ran out its own budget. Typed so callers that treat a
 * slow participant differently from a broken one — spotlight batches report it
 * per participant — branch on the class rather than the message.
 */
export class ServiceRequestTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Bickr service request did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
		this.name = "ServiceRequestTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export async function fetchServiceJson(
	service: Fetcher,
	request: Request,
): Promise<{ response: Response; payload: unknown }> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, serviceFetchTimeoutMs);
	try {
		const response = await service.fetch(new Request(request, { signal: controller.signal }));
		const payload = await readServiceJson(response, controller.signal);
		return { response, payload };
	} catch (error) {
		if (timedOut || isAbortError(error)) {
			throw new ServiceRequestTimeoutError(serviceFetchTimeoutMs);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function readServiceJson(response: Response, signal: AbortSignal): Promise<unknown> {
	return JSON.parse(await readLimitedResponseText(response, signal, {
		maxBytes: serviceJsonBodyMaxBytes,
		timeoutCancelReason: "Bickr service request timed out.",
		timeoutMessage: "Bickr service request timed out.",
		tooLargeCancelReason: "Bickr service response byte limit reached.",
		tooLargeMessage: "Bickr service response was too large.",
	}));
}

export type LimitedResponseTextOptions = {
	maxBytes: number;
	timeoutCancelReason: string;
	timeoutMessage: string;
	tooLargeCancelReason: string;
	tooLargeMessage: string;
	error?: (message: string) => Error;
};

export async function readLimitedResponseText(
	response: Response,
	signal: AbortSignal,
	options: LimitedResponseTextOptions,
): Promise<string> {
	if (!response.body) {
		return "";
	}
	const makeError = options.error ?? ((message: string) => new Error(message));
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytesRead = 0;
	let abortListener: (() => void) | undefined;
	if (signal.aborted) {
		void reader.cancel(options.timeoutCancelReason).catch(() => {});
		throw makeError(options.timeoutMessage);
	}
	const abortPromise = new Promise<never>((_, reject) => {
		abortListener = () => {
			void reader.cancel(options.timeoutCancelReason).catch(() => {});
			reject(makeError(options.timeoutMessage));
		};
		signal.addEventListener("abort", abortListener, { once: true });
	});
	try {
		while (true) {
			if (bytesRead >= options.maxBytes) {
				const { done } = await Promise.race([reader.read(), abortPromise]);
				if (done) {
					return text + decoder.decode();
				}
				await reader.cancel(options.tooLargeCancelReason);
				throw makeError(options.tooLargeMessage);
			}
			const { done, value } = await Promise.race([reader.read(), abortPromise]);
			if (done) {
				return text + decoder.decode();
			}
			const remaining = options.maxBytes - bytesRead;
			if (value.byteLength > remaining) {
				await reader.cancel(options.tooLargeCancelReason);
				throw makeError(options.tooLargeMessage);
			}
			bytesRead += value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		if (abortListener) {
			signal.removeEventListener("abort", abortListener);
		}
		try {
			reader.releaseLock();
		} catch {
			// The body may already be canceled by the timeout path.
		}
	}
}

export function isAbortError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"name" in error &&
			(error as { name?: unknown }).name === "AbortError",
	);
}
