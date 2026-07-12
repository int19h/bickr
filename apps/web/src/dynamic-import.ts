import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const dynamicImportRetryDelayMs = 1_000;

export async function retryDynamicImport<T>(
	load: () => Promise<T>,
	retryDelayMs = dynamicImportRetryDelayMs,
): Promise<T> {
	try {
		return await load();
	} catch {
		// Pages deployments can briefly serve an HTML shell before every hashed asset
		// reaches the same edge. Give that propagation window one chance to close.
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		return load();
	}
}

export function lazyWithRetry<T extends ComponentType<any>>(
	load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
	return lazy(() => retryDynamicImport(load));
}
