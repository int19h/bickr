export function serviceRequest(
	request: Request,
	path: string,
	userId: string,
	body?: string,
): Request {
	const headers = new Headers(request.headers);
	headers.set("x-bickr-user-id", userId);
	headers.delete("content-length");
	if (body !== undefined) {
		headers.set("content-type", "application/json");
	} else {
		headers.delete("content-type");
	}

	return new Request(`https://internal.bickr${path}`, {
		method: request.method,
		headers,
		body,
	});
}

const serviceFetchTimeoutMs = 30_000;
const serviceJsonBodyMaxBytes = 1_000_000;

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
			throw new Error(`Bickr service request did not finish within ${Math.round(serviceFetchTimeoutMs / 1000)} seconds.`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function readServiceJson(response: Response, signal: AbortSignal): Promise<unknown> {
	return JSON.parse(await readServiceText(response, signal));
}

async function readServiceText(response: Response, signal: AbortSignal): Promise<string> {
	if (!response.body) {
		return "";
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytesRead = 0;
	let abortListener: (() => void) | undefined;
	if (signal.aborted) {
		void reader.cancel("Bickr service request timed out.").catch(() => {});
		throw new Error("Bickr service request timed out.");
	}
	const abortPromise = new Promise<never>((_, reject) => {
		abortListener = () => {
			void reader.cancel("Bickr service request timed out.").catch(() => {});
			reject(new Error("Bickr service request timed out."));
		};
		signal.addEventListener("abort", abortListener, { once: true });
	});
	try {
		while (true) {
			if (bytesRead >= serviceJsonBodyMaxBytes) {
				const { done } = await Promise.race([reader.read(), abortPromise]);
				if (done) {
					return text + decoder.decode();
				}
				await reader.cancel("Bickr service response byte limit reached.");
				throw new Error("Bickr service response was too large.");
			}
			const { done, value } = await Promise.race([reader.read(), abortPromise]);
			if (done) {
				return text + decoder.decode();
			}
			const remaining = serviceJsonBodyMaxBytes - bytesRead;
			if (value.byteLength > remaining) {
				await reader.cancel("Bickr service response byte limit reached.");
				throw new Error("Bickr service response was too large.");
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

function isAbortError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"name" in error &&
			(error as { name?: unknown }).name === "AbortError",
	);
}
