export type CloudflareRetryOptions<T> = {
	operation: string;
	run: () => Promise<T>;
	maxAttempts?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	backoffFactor?: number;
	jitterRatio?: number;
	shouldRetry?: (error: unknown) => boolean;
	sleep?: (milliseconds: number) => Promise<void>;
	random?: () => number;
};

type CloudflareRetryTestHooks = {
	sleep?: (milliseconds: number) => Promise<void>;
	random?: () => number;
};

const defaultMaxAttempts = 3;
const defaultInitialDelayMs = 1_000;
const defaultMaxDelayMs = 8_000;
const defaultBackoffFactor = 2;
const defaultJitterRatio = 0.25;

let retrySleep = (milliseconds: number) =>
	new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
let retryRandom = Math.random;

export async function retryCloudflareOperation<T>(options: CloudflareRetryOptions<T>): Promise<T> {
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? defaultMaxAttempts));
	const initialDelayMs = Math.max(0, options.initialDelayMs ?? defaultInitialDelayMs);
	const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? defaultMaxDelayMs);
	const backoffFactor = Math.max(1, options.backoffFactor ?? defaultBackoffFactor);
	const jitterRatio = Math.max(0, options.jitterRatio ?? defaultJitterRatio);
	const shouldRetry = options.shouldRetry ?? isCloudflareRateLimitError;
	const sleep = options.sleep ?? retrySleep;
	const random = options.random ?? retryRandom;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await options.run();
		} catch (error) {
			if (attempt >= maxAttempts || !shouldRetry(error)) {
				throw error;
			}
			await sleep(retryDelayMs({
				attempt,
				backoffFactor,
				initialDelayMs,
				jitterRatio,
				maxDelayMs,
				random,
			}));
		}
	}

	throw new Error(`${options.operation} failed without producing a result.`);
}

export function isCloudflareRateLimitError(error: unknown): boolean {
	const status = numericProperty(error, "status") ?? numericProperty(error, "code");
	if (status === 429) {
		return true;
	}
	const message =
		error instanceof Error ? error.message
		: typeof error === "string" ? error
		: "";
	return /\b429\b/.test(message) && /(too many requests|rate[ -]?limit)/i.test(message);
}

export function setCloudflareRetryTestHooks(hooks: CloudflareRetryTestHooks): () => void {
	const previousSleep = retrySleep;
	const previousRandom = retryRandom;
	if (hooks.sleep) {
		retrySleep = hooks.sleep;
	}
	if (hooks.random) {
		retryRandom = hooks.random;
	}
	return () => {
		retrySleep = previousSleep;
		retryRandom = previousRandom;
	};
}

function retryDelayMs(input: {
	attempt: number;
	backoffFactor: number;
	initialDelayMs: number;
	jitterRatio: number;
	maxDelayMs: number;
	random: () => number;
}): number {
	const baseDelay = input.initialDelayMs * input.backoffFactor ** Math.max(0, input.attempt - 1);
	const cappedDelay = Math.min(input.maxDelayMs, baseDelay);
	const jitter = Math.floor(cappedDelay * input.jitterRatio * input.random());
	return Math.min(input.maxDelayMs, cappedDelay + jitter);
}

function numericProperty(value: unknown, key: "code" | "status"): number | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const property = (value as Record<string, unknown>)[key];
	return typeof property === "number" ? property : null;
}
