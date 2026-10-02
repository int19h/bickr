export class BodySizeLimitError extends Error {
	constructor(readonly maxBytes: number) {
		super(`Body exceeds the ${maxBytes} byte limit.`);
		this.name = "BodySizeLimitError";
	}
}

export class BodyReadTimeoutError extends Error {
	constructor() {
		super("Body read timed out.");
		this.name = "BodyReadTimeoutError";
	}
}

export type BodyReadOptions = {
	maxBytes: number;
	timeoutMs?: number;
	signal?: AbortSignal;
};

/** One deadline covers headers and body when the caller puts both in operation. */
export async function withBodyDeadline<T>(
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new BodyReadTimeoutError()), timeoutMs);
	let rejectAbort: (() => void) | undefined;
	try {
		controller.signal.throwIfAborted();
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = () => reject(controller.signal.reason);
			controller.signal.addEventListener("abort", rejectAbort, { once: true });
		});
		// Some custom fetchers and streams ignore AbortSignal. The deadline must
		// still release the caller; the operation also receives the abort signal.
		return await Promise.race([operation(controller.signal), aborted]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
	}
}

export async function readBoundedBytes(
	body: ReadableStream<Uint8Array> | null,
	options: BodyReadOptions,
): Promise<Uint8Array> {
	return withBodyDeadline(options.timeoutMs, options.signal, async (signal) => {
		if (!body) return new Uint8Array();
		const reader = body.getReader();
		const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
		signal.addEventListener("abort", cancel, { once: true });
		const chunks: Uint8Array[] = [];
		let total = 0;
		let complete = false;
		try {
			while (true) {
				signal.throwIfAborted();
				const { done, value } = await reader.read();
				signal.throwIfAborted();
				if (done) {
					complete = true;
					break;
				}
				total += value.byteLength;
				if (total > options.maxBytes) throw new BodySizeLimitError(options.maxBytes);
				chunks.push(value);
			}
			const bytes = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return bytes;
		} finally {
			signal.removeEventListener("abort", cancel);
			// Do not wait for a remote source to acknowledge cancellation.
			if (!complete) void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	});
}

export async function readBoundedRequest(request: Request, options: BodyReadOptions): Promise<Uint8Array> {
	const length = request.headers.get("content-length");
	if (length && Number(length) > options.maxBytes) {
		void request.body?.cancel().catch(() => {});
		throw new BodySizeLimitError(options.maxBytes);
	}
	const signal = options.signal ? AbortSignal.any([request.signal, options.signal]) : request.signal;
	return readBoundedBytes(request.body, { ...options, signal });
}
