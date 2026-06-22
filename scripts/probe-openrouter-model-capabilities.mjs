#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultOutputPath = path.join(repoRoot, "packages/shared/src/openrouter-model-capabilities.generated.ts");
const defaultDevVarsPath = path.join(repoRoot, "workers/agent-runtime/.dev.vars");
const openRouterModelsUrl = "https://openrouter.ai/api/v1/models";
const openRouterChatCompletionsUrl = "https://openrouter.ai/api/v1/chat/completions";
const probeMaxCompletionTokens = 256;
const capabilityNames = ["prefill", "structuredOutputs", "requiredToolCalls", "disabledReasoning", "cacheControl"];
const capabilityCliNames = new Map([
	["prefill", "prefill"],
	["structuredOutputs", "structured-outputs"],
	["requiredToolCalls", "required-tool-calls"],
	["disabledReasoning", "disabled-reasoning"],
	["cacheControl", "cache-control"],
]);
const capabilityNameAliases = new Map([
	["prefill", "prefill"],
	["structured-outputs", "structuredOutputs"],
	["structured_outputs", "structuredOutputs"],
	["structuredOutputs", "structuredOutputs"],
	["required-tool-calls", "requiredToolCalls"],
	["required_tool_calls", "requiredToolCalls"],
	["requiredToolCalls", "requiredToolCalls"],
	["disabled-reasoning", "disabledReasoning"],
	["disabled_reasoning", "disabledReasoning"],
	["disabledReasoning", "disabledReasoning"],
	["cache-control", "cacheControl"],
	["cache_control", "cacheControl"],
	["cacheControl", "cacheControl"],
]);
const pinnedCapabilityEntries = new Map([
	[
		"openrouter/free",
		{ prefill: false, structuredOutputs: false, requiredToolCalls: false, disabledReasoning: false, cacheControl: false },
	],
]);

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const mode = stringOption(args, "mode", "new");
	if (mode !== "full" && mode !== "new") {
		throw new Error(`--mode must be "full" or "new", got ${JSON.stringify(mode)}.`);
	}
	const outputPath = path.resolve(stringOption(args, "output", defaultOutputPath));
	const delayMs = numberOption(args, "delay-ms", 1500);
	const timeoutMs = numberOption(args, "timeout-ms", 20_000);
	const concurrency = numberOption(args, "concurrency", 1);
	const dryRun = booleanOption(args, "dry-run");
	const onlyAffected = booleanOption(args, "only-affected");
	const capabilityFilter = capabilityFilterOption(args);
	const modelFilter = stringArrayOption(args, "model");
	const key = await openRouterApiKey();
	const limiter = new RequestLimiter(delayMs);

	const existing = await readExistingEntries(outputPath);
	applyPinnedCapabilityEntries(existing);
	const models = await fetchOpenRouterTextModels(key);
	const currentIds = new Set(models.map((model) => model.id));
	const requestedIds = modelFilter.length > 0 ? new Set(modelFilter) : currentIds;
	const idsToProbe = models
		.map((model) => model.id)
		.filter((id) => requestedIds.has(id))
		.filter((id) => !pinnedCapabilityEntries.has(id))
		.filter((id) => {
			const capabilities = existing.get(id);
			if (onlyAffected) {
				return capabilities !== undefined && capabilitiesNeedProbe(capabilities, capabilityFilter, true);
			}
			return mode === "full" || capabilities === undefined || capabilitiesNeedProbe(capabilities, capabilityFilter, false);
		});

	const next = mode === "full" && !onlyAffected && capabilityFilter.size === capabilityNames.length ? new Map() : new Map(existing);
	let completed = 0;
	console.log(`OpenRouter returned ${models.length} text-output models.`);
	console.log(
		`Probing ${idsToProbe.length} model(s) in ${mode} mode with concurrency=${concurrency}, delay=${delayMs}ms, onlyAffected=${onlyAffected}, capabilities=${capabilityFilterLabel(capabilityFilter)}.`,
	);
	console.log(`Preserving ${pinnedCapabilityEntries.size} pinned capability entr${pinnedCapabilityEntries.size === 1 ? "y" : "ies"}.`);
	if (!key) {
		console.log("No OpenRouter key found; relying on unauthenticated OpenRouter access.");
	}

	await runWithConcurrency(idsToProbe, Math.max(1, concurrency), async (id) => {
		const capabilities = await probeModel(id, key, limiter, timeoutMs, existing.get(id), capabilityFilter, mode, onlyAffected);
		next.set(id, capabilities);
		completed += 1;
		console.log(`${completed}/${idsToProbe.length} ${id}: ${capabilitySummary(capabilities)}`);
	});

	if (!dryRun) {
		applyPinnedCapabilityEntries(next);
		const written = [...next.entries()].filter(([id]) => mode !== "full" || currentIds.has(id));
		await writeGeneratedTable(outputPath, written);
		console.log(`Wrote ${written.length} capability entr${written.length === 1 ? "y" : "ies"} to ${path.relative(repoRoot, outputPath)}.`);
	}
}

function parseArgs(values) {
	const parsed = new Map();
	for (let index = 0; index < values.length; index += 1) {
		const item = values[index];
		if (!item.startsWith("--")) {
			throw new Error(`Unexpected positional argument ${JSON.stringify(item)}.`);
		}
		const raw = item.slice(2);
		const equalsIndex = raw.indexOf("=");
		const key = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
		const value = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : values[index + 1]?.startsWith("--") || values[index + 1] === undefined ? "true" : values[++index];
		const current = parsed.get(key);
		if (current === undefined) {
			parsed.set(key, [value]);
		} else {
			current.push(value);
		}
	}
	return parsed;
}

function stringOption(options, key, fallback) {
	return options.get(key)?.at(-1) ?? fallback;
}

function numberOption(options, key, fallback) {
	const value = options.get(key)?.at(-1);
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`--${key} must be a non-negative number.`);
	}
	return parsed;
}

function booleanOption(options, key) {
	return options.get(key)?.at(-1) === "true";
}

function stringArrayOption(options, key) {
	return options.get(key) ?? [];
}

function capabilityFilterOption(options) {
	const raw = stringArrayOption(options, "capability");
	if (raw.length === 0 || raw.includes("all")) {
		return new Set(capabilityNames);
	}
	const filter = new Set();
	for (const item of raw) {
		const capability = capabilityNameAliases.get(item);
		if (!capability) {
			throw new Error(`Unknown --capability ${JSON.stringify(item)}. Expected all, ${[...capabilityNameAliases.keys()].join(", ")}.`);
		}
		filter.add(capability);
	}
	return filter;
}

function capabilityFilterLabel(filter) {
	return [...filter].map((capability) => capabilityCliNames.get(capability) ?? capability).join(",");
}

function capabilitiesNeedProbe(capabilities, capabilityFilter, onlyAffected) {
	for (const capability of capabilityFilter) {
		if (capabilities[capability] === undefined) {
			return true;
		}
		if (onlyAffected && capabilities[capability] !== true) {
			return true;
		}
	}
	return false;
}

function shouldProbeCapability(capability, previous, capabilityFilter, mode, onlyAffected) {
	if (!previous) {
		return true;
	}
	if (!capabilityFilter.has(capability)) {
		return false;
	}
	if (mode === "full" && !onlyAffected) {
		return true;
	}
	if (previous[capability] === undefined) {
		return true;
	}
	return onlyAffected && previous[capability] !== true;
}

function capabilitySummary(capabilities) {
	return [
		`prefill=${capabilities.prefill}`,
		`structured=${capabilities.structuredOutputs}`,
		`required_tools=${capabilities.requiredToolCalls}`,
		`reasoning_none=${capabilities.disabledReasoning}`,
		`cache_control=${capabilities.cacheControl}`,
	].join(" ");
}

function applyPinnedCapabilityEntries(entries) {
	// openrouter/free is a multi-dispatch route. A single successful probe only
	// describes the backend selected for that request, so keep the generated
	// table aligned with the conservative runtime policy.
	for (const [model, capabilities] of pinnedCapabilityEntries) {
		entries.set(model, capabilities);
	}
}

async function openRouterApiKey() {
	if (process.env.OPENROUTER_API_KEY) {
		return process.env.OPENROUTER_API_KEY.trim();
	}
	try {
		const text = await fs.readFile(defaultDevVarsPath, "utf8");
		for (const line of text.split(/\r?\n/)) {
			const match = /^\s*OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
			if (match?.[1]) {
				return match[1].replace(/^['"]|['"]$/g, "").trim();
			}
		}
	} catch {
		// A missing local dev vars file is fine; OpenRouter also exposes public model metadata.
	}
	return "";
}

async function readExistingEntries(filePath) {
	try {
		const text = await fs.readFile(filePath, "utf8");
		const match = /generatedOpenRouterModelCapabilityEntries(?:\s*:\s*readonly\s+GeneratedOpenRouterModelCapabilityEntry\[\])?\s*=\s*(\[[\s\S]*?\n\])(?:\s*as const)?/.exec(text);
		if (!match) {
			return new Map();
		}
		const entries = JSON.parse(match[1].replace(/,\s*\]/g, "\n]"));
		return new Map(entries);
	} catch (error) {
		if (error?.code === "ENOENT") {
			return new Map();
		}
		throw error;
	}
}

async function fetchOpenRouterTextModels(apiKey) {
	const response = await fetch(openRouterModelsUrl, {
		headers: {
			accept: "application/json",
			...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		},
	});
	if (!response.ok) {
		throw new Error(`OpenRouter model list returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
	}
	const payload = await response.json();
	const data = Array.isArray(payload.data) ? payload.data : [];
	return data
		.map((value) => {
			const record = recordValue(value);
			const id = stringValue(record.id);
			const architecture = recordValue(record.architecture);
			const outputModalities = stringArray(architecture.output_modalities);
			return id && outputModalities.includes("text") ? { id } : null;
		})
		.filter(Boolean)
		.sort((left, right) => left.id.localeCompare(right.id));
}

async function probeModel(model, apiKey, limiter, timeoutMs, previous, capabilityFilter, mode, onlyAffected) {
	return {
		prefill: shouldProbeCapability("prefill", previous, capabilityFilter, mode, onlyAffected)
			? await probeCapability(apiKey, limiter, timeoutMs, providerPrefillRequest(model), prefillSupported)
			: Boolean(previous?.prefill),
		structuredOutputs:
			shouldProbeCapability("structuredOutputs", previous, capabilityFilter, mode, onlyAffected)
				? await probeCapability(apiKey, limiter, timeoutMs, providerStructuredOutputRequest(model), structuredOutputSupported)
				: Boolean(previous?.structuredOutputs),
		requiredToolCalls:
			shouldProbeCapability("requiredToolCalls", previous, capabilityFilter, mode, onlyAffected)
				? await probeCapability(apiKey, limiter, timeoutMs, providerRequiredToolCallRequest(model), requiredToolCallSupported)
				: Boolean(previous?.requiredToolCalls),
		disabledReasoning:
			shouldProbeCapability("disabledReasoning", previous, capabilityFilter, mode, onlyAffected)
				? await probeCapability(apiKey, limiter, timeoutMs, providerDisabledReasoningRequest(model), responseOk)
				: Boolean(previous?.disabledReasoning),
		cacheControl:
			shouldProbeCapability("cacheControl", previous, capabilityFilter, mode, onlyAffected)
				? await probeCacheControlCapability(model, apiKey, limiter, timeoutMs)
				: Boolean(previous?.cacheControl),
	};
}

async function probeCacheControlCapability(model, apiKey, limiter, timeoutMs) {
	// OpenRouter currently accepts top-level cache_control on some models where
	// it is not documented to create a cache entry. Treat the live request as a
	// confirmation step for documented top-level automatic cache_control models,
	// not as proof that any 2xx response means caching works.
	if (!topLevelCacheControlCandidate(model)) {
		return false;
	}
	return probeCapability(apiKey, limiter, timeoutMs, providerCacheControlRequest(model), responseOk);
}

async function probeCapability(apiKey, limiter, timeoutMs, requestBody, supported) {
	const response = await postOpenRouter(apiKey, limiter, timeoutMs, requestBody);
	if (!response.ok) {
		return false;
	}
	return supported(response.payload);
}

async function postOpenRouter(apiKey, limiter, timeoutMs, body) {
	const headers = {
		"content-type": "application/json",
		accept: "application/json",
		...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
	};
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await limiter.wait();
		let response;
		let text;
		try {
			response = await fetch(openRouterChatCompletionsUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			text = await response.text();
		} catch (error) {
			if (error?.name === "TimeoutError" || error?.name === "AbortError") {
				return { ok: false, status: 0, payload: {} };
			}
			if (attempt < 3) {
				await sleep(attempt * 3000);
				continue;
			}
			return { ok: false, status: 0, payload: {} };
		}
		let payload;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			payload = {};
		}
		if (response.ok) {
			return { ok: true, status: response.status, payload };
		}
		if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
			const retryAfter = Number(response.headers.get("retry-after"));
			await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 3000);
			continue;
		}
		return { ok: false, status: response.status, payload };
	}
	return { ok: false, status: 0, payload: {} };
}

function providerPrefillRequest(model) {
	return {
		model,
		messages: [
			{ role: "user", content: "Complete this lowercase word with no punctuation: o" },
			{ role: "assistant", content: "o" },
		],
		stream: false,
		max_completion_tokens: 32,
		temperature: 0,
	};
}

function providerStructuredOutputRequest(model) {
	return {
		model,
		messages: [{ role: "user", content: "Return JSON with ok set to true." }],
		stream: false,
		max_completion_tokens: probeMaxCompletionTokens,
		temperature: 0,
		response_format: {
			type: "json_schema",
			json_schema: {
				name: "capability_probe",
				strict: true,
				schema: {
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
					additionalProperties: false,
				},
			},
		},
	};
}

function providerRequiredToolCallRequest(model) {
	return {
		model,
		messages: [{ role: "user", content: "Use the capability_probe tool now." }],
		stream: false,
		max_completion_tokens: probeMaxCompletionTokens,
		temperature: 0,
		tools: [capabilityProbeTool()],
		tool_choice: "required",
		parallel_tool_calls: false,
	};
}

function providerDisabledReasoningRequest(model) {
	return {
		model,
		messages: [{ role: "user", content: "Reply with ok." }],
		stream: false,
		max_completion_tokens: 32,
		temperature: 0,
		reasoning: { effort: "none", exclude: false },
	};
}

function providerCacheControlRequest(model) {
	return {
		model,
		messages: [{ role: "user", content: "Reply with ok." }],
		stream: false,
		max_completion_tokens: 16,
		temperature: 0,
		cache_control: { type: "ephemeral" },
	};
}

function topLevelCacheControlCandidate(model) {
	const normalized = model.trim().toLowerCase();
	return normalized.startsWith("anthropic/claude") || normalized.startsWith("~anthropic/claude");
}

function capabilityProbeTool() {
	return {
		type: "function",
		function: {
			name: "capability_probe",
			description: "Record that the model can call the required probe tool.",
			parameters: {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				additionalProperties: false,
			},
		},
	};
}

function responseOk() {
	return true;
}

function prefillSupported(payload) {
	return providerMessage(payload) !== null;
}

function structuredOutputSupported(payload) {
	const message = providerMessage(payload);
	const content = typeof message?.content === "string" ? message.content.trim() : "";
	if (!content) {
		return false;
	}
	try {
		return JSON.parse(content).ok === true;
	} catch {
		return false;
	}
}

function requiredToolCallSupported(payload) {
	const message = providerMessage(payload);
	const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
	return toolCalls.some((toolCall) => recordValue(recordValue(toolCall).function).name === "capability_probe");
}

function providerMessage(payload) {
	const choices = Array.isArray(recordValue(payload).choices) ? recordValue(payload).choices : [];
	const first = recordValue(choices[0]);
	const message = recordValue(first.message);
	return Object.keys(message).length > 0 ? message : null;
}

async function runWithConcurrency(items, count, worker) {
	let index = 0;
	await Promise.all(Array.from({ length: count }, async () => {
		for (;;) {
			const current = index;
			index += 1;
			if (current >= items.length) {
				return;
			}
			await worker(items[current]);
		}
	}));
}

async function writeGeneratedTable(filePath, entries) {
	const sorted = entries.sort(([left], [right]) => left.localeCompare(right));
	const lines = [
		"export type GeneratedOpenRouterModelCapabilities = {",
		"\tprefill: boolean;",
		"\tstructuredOutputs: boolean;",
		"\trequiredToolCalls: boolean;",
		"\tdisabledReasoning: boolean;",
		"\tcacheControl: boolean;",
		"};",
		"",
		"export type GeneratedOpenRouterModelCapabilityEntry = readonly [string, GeneratedOpenRouterModelCapabilities];",
		"",
		"export const generatedOpenRouterModelCapabilityEntries: readonly GeneratedOpenRouterModelCapabilityEntry[] = [",
		...sorted.map(([model, capabilities], index) => `\t${JSON.stringify([model, capabilities])}${index === sorted.length - 1 ? "" : ","}`),
		"];",
		"",
	];
	await fs.writeFile(filePath, `${lines.join("\n")}`);
}

class RequestLimiter {
	next = 0;

	constructor(delay) {
		this.delay = delay;
	}

	async wait() {
		const now = Date.now();
		const waitMs = Math.max(0, this.next - now);
		this.next = Math.max(this.next, now) + this.delay;
		if (waitMs > 0) {
			await sleep(waitMs);
		}
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordValue(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

await main();
