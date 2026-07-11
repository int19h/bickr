import type { JsonObject } from '@bickr/shared/model';
import { providerRetryBaseDelayMs } from '../constants';
import {
	ProviderRequestError,
	ProviderRequestTimeoutError,
	ProviderResponseBodyTimeoutError,
	ProviderStreamIdleTimeoutError,
} from '../errors';

export type ProviderUpstreamRateLimitRetry = {
	providerName: string;
	retryKey: string;
};

function isRetryableProviderStatus(status: number): boolean {
	return (
		status === 408 ||
		status === 409 ||
		status === 425 ||
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504 ||
		status === 529
	);
}

export function providerRetryKey(error: unknown): string | null {
	if (
		error instanceof ProviderRequestTimeoutError ||
		error instanceof ProviderResponseBodyTimeoutError ||
		error instanceof ProviderStreamIdleTimeoutError
	) {
		return error.message;
	}
	if (error instanceof ProviderRequestError && isRetryableProviderStatus(error.status)) {
		return `${error.status}:${error.body}`;
	}
	return null;
}

export function providerRetryKeyForAttempt(error: unknown, previousRetryKey: string | null): string | null {
	const retryKey = providerRetryKey(error);
	return retryKey && (previousRetryKey === null || previousRetryKey === retryKey) ? retryKey : null;
}

export function providerRetryDelayMsForAttempt(attempt: number): number {
	return jitteredDelay(providerRetryBaseDelayMs * 3 ** Math.max(0, attempt - 2));
}

export function providerUpstreamRateLimitRetry(error: unknown): ProviderUpstreamRateLimitRetry | null {
	if (!(error instanceof ProviderRequestError)) {
		return null;
	}
	const providerError = error.providerError;
	const status = providerError?.status ?? error.status;
	if (status !== 429 || !providerError?.providerName) {
		return null;
	}
	return {
		providerName: providerError.providerName,
		retryKey: providerRetryKey(error) ?? `${error.status}:${error.body}`,
	};
}

export function providerRoutingWithIgnoredProvider(
	providerRouting: JsonObject | undefined,
	providerName: string,
): { providerRouting: JsonObject; changed: boolean } {
	const trimmedProviderName = providerName.trim();
	const existingIgnore = Array.isArray(providerRouting?.ignore)
		? providerRouting.ignore.filter((value): value is string => typeof value === 'string').filter((value) => value.trim().length > 0)
		: [];
	const existingNames = new Set(existingIgnore.map((value) => value.trim().toLowerCase()));
	if (existingNames.has(trimmedProviderName.toLowerCase())) {
		return {
			providerRouting: { ...(providerRouting ?? {}), ignore: existingIgnore },
			changed: false,
		};
	}
	return {
		providerRouting: { ...(providerRouting ?? {}), ignore: [...existingIgnore, trimmedProviderName] },
		changed: true,
	};
}

export function providerIgnoreRetryReason(retry: ProviderUpstreamRateLimitRetry): string {
	return `${retry.retryKey}; ignoring upstream provider ${retry.providerName}`;
}

function jitteredDelay(baseMs: number): number {
	const factor = 1 + (Math.random() * 2 - 1) / 3;
	return Math.max(0, Math.round(baseMs * factor));
}
