import { readBoundedBytes, withBodyDeadline } from "./bounded-body";
import { fetchProviderResponse } from "./provider-transport";

export type OpenRouterImageModel = {
	readonly id: string;
	readonly name: string;
	readonly inputModalities: readonly string[];
	readonly outputModalities: readonly string[];
	readonly supportsStreaming: boolean;
};

export type OpenRouterImageCatalog = {
	readonly models: readonly OpenRouterImageModel[];
	model(id: string): OpenRouterImageModel | undefined;
};

export class OpenRouterImageCatalogError extends Error {
	readonly kind: "http" | "invalid_response";
	readonly status?: number;
	constructor(kind: "http" | "invalid_response", status?: number) {
		super(kind === "http" ? `OpenRouter model list returned HTTP ${status}.` : "OpenRouter returned an invalid model list.");
		this.name = "OpenRouterImageCatalogError";
		this.kind = kind;
		this.status = status;
	}
}

const cacheTtlMs = 5 * 60_000;
const maxCatalogBytes = 2_000_000;

export function createOpenRouterImageCatalogLoader(
	fetcher: typeof fetchProviderResponse = fetchProviderResponse,
	now: () => number = Date.now,
): { (signal?: AbortSignal): Promise<OpenRouterImageCatalog>; clear(): void } {
	// Only completed, public data crosses requests. Workers cannot share a
	// pending request's I/O promise with another request in the same isolate.
	let cached: { value: OpenRouterImageCatalog; expiresAt: number } | undefined;
	const load = async (signal?: AbortSignal): Promise<OpenRouterImageCatalog> => {
		signal?.throwIfAborted();
		if (cached && cached.expiresAt > now()) return cached.value;
		const value = await withBodyDeadline(10_000, signal, async (requestSignal) => {
			const response = await fetcher("https://openrouter.ai/api/v1/images/models", {
				headers: { accept: "application/json" }, signal: requestSignal,
			});
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				throw new OpenRouterImageCatalogError("http", response.status);
			}
			const bytes = await readBoundedBytes(response.body, { maxBytes: maxCatalogBytes, signal: requestSignal });
			let payload: unknown;
			try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
			catch { throw new OpenRouterImageCatalogError("invalid_response"); }
			const data = record(payload).data;
			if (!Array.isArray(data)) throw new OpenRouterImageCatalogError("invalid_response");
			const models: OpenRouterImageModel[] = [];
			const byId = new Map<string, OpenRouterImageModel>();
			for (const item of data) {
				const value = record(item);
				const id = text(value.id);
				if (!id) continue;
				const architecture = record(value.architecture);
				const model = Object.freeze({
					id, name: text(value.name) ?? id,
					inputModalities: strings(architecture.input_modalities),
					outputModalities: strings(architecture.output_modalities),
					supportsStreaming: value.supports_streaming === true,
				});
				models.push(model);
				byId.set(normalizedModelId(id), model);
			}
			return Object.freeze({ models: Object.freeze(models), model: (id: string) => byId.get(normalizedModelId(id)) });
		});
		cached = { value, expiresAt: now() + cacheTtlMs };
		return value;
	};
	return Object.assign(load, { clear: () => { cached = undefined; } });
}

export const loadOpenRouterImageCatalog = createOpenRouterImageCatalogLoader();

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function strings(value: unknown): readonly string[] { return Object.freeze(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); }
function normalizedModelId(id: string): string { return id.trim().toLowerCase().split(":")[0] ?? ""; }
