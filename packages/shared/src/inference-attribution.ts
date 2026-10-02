import type { InferenceAttribution, JsonObject, JsonValue } from "./model";
import { InputError } from "./validation";

// This is an explicit public allowlist. Request messages, schemas, tools,
// session identifiers, credentials, and custom endpoints never enter attribution.
const scalarParameters = ["temperature", "top_k", "top_p", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "max_completion_tokens", "max_tokens", "tool_choice", "parallel_tool_calls"] as const;
const reasoningParameters = ["effort", "max_tokens", "enabled", "exclude"] as const;
const providerParameters = ["order", "only", "ignore", "allow_fallbacks", "require_parameters", "data_collection", "sort", "quantizations", "zdr", "enforce_distillable_text"] as const;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicParameterValue(value: unknown): JsonValue | undefined {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) return [...value];
	// Objects require their own allowlist below. This prevents a secret nested
	// under an otherwise allowed provider key from becoming public metadata.
	return undefined;
}

function pick(value: unknown, keys: readonly string[]): JsonObject {
	const input = record(value);
	const output: JsonObject = {};
	for (const key of keys) {
		const safe = publicParameterValue(input[key]);
		if (safe !== undefined) output[key] = safe;
	}
	return output;
}

export function inferenceAttributionForRequest(request: unknown, source: InferenceAttribution["source"]): InferenceAttribution {
	const input = record(request);
	if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 512) throw new InputError("Inference model is required.");
	const parameters = pick(input, scalarParameters);
	const runtime = pick(input.bickr, ["contextWindowTokens", "compactionThreshold", "compactionSummaryPercent", "compactionMaxCharacters", "maxToolCallsPerTick", "maxSuccessfulToolCallsPerIteration", "maxGeneratedTokensPerTick", "maxGeneratedTokensPerIteration"]);
	if (Object.keys(runtime).length) parameters.bickr = runtime;
	const cache = pick(input.cache_control, ["type", "ttl"]);
	if (Object.keys(cache).length) parameters.cache_control = cache;
	for (const [key, keys] of [["reasoning", reasoningParameters], ["provider", providerParameters]] as const) {
		const values = pick(input[key], keys);
		if (key === "provider") {
			const provider = record(input.provider);
			for (const name of ["max_price", "preferred_min_throughput", "preferred_max_latency"]) {
				const value = provider[name];
				if (typeof value === "number" && Number.isFinite(value)) values[name] = value;
				else {
					const fields = pick(value, ["prompt", "completion", "p50", "p75", "p90", "p99"]);
					if (Object.keys(fields).length) values[name] = fields;
				}
			}
			if (typeof provider.sort !== "string") {
				delete values.sort;
				const sort = pick(provider.sort, ["by", "partition"]);
				if (Object.keys(sort).length) values.sort = sort;
			}
		}
		if (Object.keys(values).length) parameters[key] = values;
	}
	return { model: input.model, parameters, source: { ...source } };
}

/** Internal service boundary only. Public input parsers deliberately discard this field. */
export function parseInferenceAttribution(value: unknown, botId: string): InferenceAttribution | undefined {
	if (value === undefined || value === null) return undefined;
	const input = record(value);
	const source = record(input.source);
	if (source.botId !== botId || typeof source.worldHandle !== "string" || typeof source.botHandle !== "string" || typeof source.runId !== "string" || !Number.isSafeInteger(source.requestSeq) || Number(source.requestSeq) < 1 || [source.worldHandle, source.botHandle, source.runId].some(value => typeof value !== "string" || !value || value.length > 128)) {
		throw new InputError("Inference attribution must identify the author and request.");
	}
	return inferenceAttributionForRequest({ ...record(input.parameters), model: input.model }, {
		botId, worldHandle: source.worldHandle, botHandle: source.botHandle, runId: source.runId, requestSeq: Number(source.requestSeq),
	});
}

export function storedInferenceAttribution(json: string | null | undefined): { inferenceAttribution?: InferenceAttribution } {
	return json ? { inferenceAttribution: JSON.parse(json) as InferenceAttribution } : {};
}
