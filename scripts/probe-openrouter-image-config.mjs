#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultOutputPath = path.join(repoRoot, "packages/shared/src/openrouter-image-model-config.generated.ts");
const defaultDevVarsPath = path.join(repoRoot, "workers/agent-runtime/.dev.vars");
const openRouterModelsUrl = "https://openrouter.ai/api/v1/images/models";
const openRouterImagesUrl = "https://openrouter.ai/api/v1/images";

const standardAspectRatios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const maiAspectRatios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
const gemini31ExtendedAspectRatios = ["1:4", "4:1", "1:8", "8:1"];
const grokAspectRatios = ["2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"];
const standardImageSizes = ["1K", "2K", "4K"];
const gemini31ImageSizes = ["0.5K", ...standardImageSizes];
const openAiGptImage1Sizes = ["1024x1024", "1024x1536", "1536x1024"];
const openAiGptImage2Sizes = [...openAiGptImage1Sizes, "2560x1440", "3840x2160"];
const dimensionImageSizeCandidates = ["512x512", ...openAiGptImage2Sizes, "2048x2048"];

const defaultTargetModels = new Set([
	"google/gemini-3.1-flash-image",
	"google/gemini-3.1-flash-image-preview",
	"google/gemini-3-pro-image",
	"google/gemini-3-pro-image-preview",
	"microsoft/mai-image-2.5",
	"x-ai/grok-imagine-image-quality",
	"sourceful/riverflow-v2.5-pro",
	"sourceful/riverflow-v2.5-fast",
	"sourceful/riverflow-v2-pro",
	"sourceful/riverflow-v2-fast",
	"black-forest-labs/flux.2-pro",
	"black-forest-labs/flux.2-flex",
	"recraft/recraft-v4.1",
	"recraft/recraft-v4.1-pro",
	"openai/gpt-5-image",
	"openai/gpt-5.4-image-2",
	"openai/gpt-image-2",
	"openai/gpt-image-1",
	"openai/gpt-image-1-mini",
]);

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const mode = stringOption(args, "mode", "targeted");
	if (mode !== "metadata" && mode !== "targeted" && mode !== "full") {
		throw new Error(`--mode must be "metadata", "targeted", or "full", got ${JSON.stringify(mode)}.`);
	}
	const outputPath = path.resolve(stringOption(args, "output", defaultOutputPath));
	const dryRun = booleanOption(args, "dry-run");
	const delayMs = numberOption(args, "delay-ms", 2500);
	const timeoutMs = numberOption(args, "timeout-ms", 120_000);
	const modelFilter = new Set(stringArrayOption(args, "model").map(normalizedModelId));
	const explicitRatios = stringArrayOption(args, "aspect-ratio");
	const explicitSizes = stringArrayOption(args, "image-size");
	const apiKey = await openRouterApiKey();
	const limiter = new RequestLimiter(delayMs);
	const existing = await readExistingEntries(outputPath);
	const models = await fetchOpenRouterImageModels(apiKey);
	const entries = new Map(models.map((model) => [model.id, existing.get(model.id) ?? candidateConfigForModel(model.id)]));
	const targetModels = models.filter((model) => {
		if (mode === "metadata") {
			return false;
		}
		if (modelFilter.size > 0) {
			return modelFilter.has(normalizedModelId(model.id));
		}
		return defaultTargetModels.has(normalizedModelId(model.id));
	});

	console.log(`OpenRouter returned ${models.length} image-output models.`);
	console.log(`Writing advisory config entries for ${entries.size} model(s).`);
	console.log(`Probing ${targetModels.length} model(s) in ${mode} mode with delay=${delayMs}ms.`);
	if (!apiKey && mode !== "metadata") {
		throw new Error("OPENROUTER_API_KEY was not found in the environment or workers/agent-runtime/.dev.vars.");
	}

	for (const model of targetModels) {
		const current = entries.get(model.id) ?? { aspectRatios: [], imageSizes: [] };
		const aspectRatios = unique(current.aspectRatios);
		const imageSizes = unique(current.imageSizes);
		const ratiosToProbe = explicitRatios.length > 0 ? explicitRatios
			: mode === "full" ? aspectRatios
			: targetedAspectRatios(aspectRatios);
		const sizesToProbe = explicitSizes.length > 0 ? explicitSizes
			: mode === "full" ? unique([...imageSizes, ...dimensionImageSizeCandidates])
			: targetedImageSizes(imageSizes);
		const supportedRatios = new Set(aspectRatios);
		const supportedSizes = new Set(imageSizes);
		for (const ratio of ratiosToProbe) {
			const supported = await probeImageConfig(apiKey, limiter, timeoutMs, model, { aspect_ratio: ratio });
			if (supported === true) {
				supportedRatios.add(ratio);
			} else if (supported === false) {
				supportedRatios.delete(ratio);
			}
			console.log(`${model.id} aspect_ratio=${ratio} supported=${supported}`);
		}
		for (const size of sizesToProbe) {
			const supported = await probeImageConfig(apiKey, limiter, timeoutMs, model, { image_size: size });
			if (supported === true) {
				supportedSizes.add(size);
			} else if (supported === false) {
				supportedSizes.delete(size);
			}
			console.log(`${model.id} image_size=${size} supported=${supported}`);
		}
		entries.set(model.id, {
			aspectRatios: sortByKnownOrder([...supportedRatios], [...standardAspectRatios, ...gemini31ExtendedAspectRatios, ...grokAspectRatios]),
			imageSizes: sortByKnownOrder([...supportedSizes], [...gemini31ImageSizes, ...dimensionImageSizeCandidates]),
		});
		if (!dryRun) {
			await writeGeneratedTable(outputPath, [...entries.entries()]);
		}
	}

	if (!dryRun) {
		await writeGeneratedTable(outputPath, [...entries.entries()]);
		console.log(`Wrote ${entries.size} image config entr${entries.size === 1 ? "y" : "ies"} to ${path.relative(repoRoot, outputPath)}.`);
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

async function openRouterApiKey() {
	if (process.env.OPENROUTER_API_KEY?.trim()) {
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
		// Missing dev vars are fine for metadata-only mode.
	}
	return "";
}

async function fetchOpenRouterImageModels(apiKey) {
	const response = await fetch(openRouterModelsUrl, {
		headers: {
			accept: "application/json",
			...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		},
	});
	if (!response.ok) {
		throw new Error(`OpenRouter image model list returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
	}
	const payload = await response.json();
	const data = Array.isArray(payload.data) ? payload.data : [];
	return data
		.map((value) => {
			const record = recordValue(value);
			const id = stringValue(record.id);
			const architecture = recordValue(record.architecture);
			const outputModalities = stringArray(architecture.output_modalities);
			const inputModalities = stringArray(architecture.input_modalities);
			return id && outputModalities.includes("image") ? { id, inputModalities, outputModalities } : null;
		})
		.filter(Boolean)
		.sort((left, right) => left.id.localeCompare(right.id));
}

async function readExistingEntries(filePath) {
	try {
		const text = await fs.readFile(filePath, "utf8");
		const match = /generatedOpenRouterImageModelConfigEntries(?:\s*:\s*readonly\s+GeneratedOpenRouterImageModelConfigEntry\[\])?\s*=\s*(\[[\s\S]*?\n\])(?:\s*as const)?/.exec(text);
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

function candidateConfigForModel(model) {
	const id = normalizedModelId(model);
	if (id === "microsoft/mai-image-2.5") {
		return { aspectRatios: maiAspectRatios, imageSizes: [] };
	}
	if (id === "openai/gpt-image-1" || id === "openai/gpt-image-1-mini") {
		return { aspectRatios: standardAspectRatios, imageSizes: openAiGptImage1Sizes };
	}
	if (id === "openai/gpt-image-2" || id === "openai/gpt-5.4-image-2") {
		return { aspectRatios: standardAspectRatios, imageSizes: openAiGptImage2Sizes };
	}
	if (id === "google/gemini-3.1-flash-image" || id === "google/gemini-3.1-flash-image-preview") {
		return { aspectRatios: [...standardAspectRatios, ...gemini31ExtendedAspectRatios], imageSizes: gemini31ImageSizes };
	}
	if (id.startsWith("google/gemini-")) {
		return { aspectRatios: standardAspectRatios, imageSizes: standardImageSizes };
	}
	if (id.startsWith("x-ai/grok-imagine-image")) {
		return { aspectRatios: [...standardAspectRatios, ...grokAspectRatios], imageSizes: ["1K", "2K"] };
	}
	if (id.startsWith("sourceful/riverflow-")) {
		return { aspectRatios: standardAspectRatios, imageSizes: sourcefulImageSizes(id) };
	}
	if (id.startsWith("recraft/")) {
		return { aspectRatios: standardAspectRatios, imageSizes: recraftImageSizes(id) };
	}
	if (id.startsWith("black-forest-labs/") || id.startsWith("bytedance-seed/") || id.startsWith("openai/")) {
		return { aspectRatios: standardAspectRatios, imageSizes: [] };
	}
	return { aspectRatios: standardAspectRatios, imageSizes: standardImageSizes };
}

function sourcefulImageSizes(id) {
	if (id.includes("-pro") || id.includes("-max")) {
		return standardImageSizes;
	}
	return ["1K", "2K"];
}

function recraftImageSizes(id) {
	if (id.includes("vector")) {
		return [];
	}
	if (id.includes("-pro")) {
		return ["2K"];
	}
	return ["1K"];
}

function targetedAspectRatios(values) {
	const wanted = ["1:1", "16:9", "4:5", "21:9", "1:4", "8:1", "auto", "20:9"];
	return wanted.filter((value) => values.includes(value));
}

function targetedImageSizes(values) {
	return unique([
		...values,
		...(values.length === 0 ? ["1K"] : []),
		"1024x1024",
	]);
}

async function probeImageConfig(apiKey, limiter, timeoutMs, model, imageConfig) {
	const body = {
		model: model.id,
		prompt: "Create a simple blue circle icon on a plain white background.",
		stream: false,
		...(imageConfig.aspect_ratio ? { aspect_ratio: imageConfig.aspect_ratio } : {}),
		...(imageConfig.image_size ? { size: imageConfig.image_size } : {}),
	};
	const response = await postOpenRouter(apiKey, limiter, timeoutMs, body);
	return response.ok ? true : response.unsupported ? false : null;
}

async function postOpenRouter(apiKey, limiter, timeoutMs, body) {
	const headers = {
		"content-type": "application/json",
		accept: "application/json",
		authorization: `Bearer ${apiKey}`,
	};
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		await limiter.wait();
		let response;
		let text;
		try {
			response = await fetch(openRouterImagesUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			text = await response.text();
		} catch {
			if (attempt < 2) {
				await sleep(attempt * 5000);
				continue;
			}
			return { ok: false, unsupported: false };
		}
		if (response.ok) {
			return { ok: true, unsupported: false };
		}
		if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
			const retryAfter = Number(response.headers.get("retry-after"));
			await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 5000);
			continue;
		}
		const message = errorMessage(text);
		if (message) {
			console.log(`OpenRouter rejected ${body.model}: HTTP ${response.status} ${message}`);
		}
		return { ok: false, unsupported: isUnsupportedConfigError(response.status, text) };
	}
	return { ok: false, unsupported: false };
}

function errorMessage(text) {
	const redacted = text.replace(/\/keys\/[A-Za-z0-9_-]+/g, "/keys/[redacted]");
	try {
		const payload = JSON.parse(redacted);
		const message = recordValue(payload.error).message ?? payload.message;
		return typeof message === "string" ? message.slice(0, 240) : "";
	} catch {
		return redacted.slice(0, 240);
	}
}

function isUnsupportedConfigError(status, text) {
	if (status !== 400) {
		return false;
	}
	return /not supported|invalid_value|Invalid option|expected one of/i.test(text);
}

async function writeGeneratedTable(filePath, entries) {
	const sorted = entries
		.map(([model, config]) => [model, { aspectRatios: unique(config.aspectRatios), imageSizes: unique(config.imageSizes) }])
		.sort(([left], [right]) => left.localeCompare(right));
	const lines = [
		"export type GeneratedOpenRouterImageModelConfig = {",
		"\taspectRatios: readonly string[];",
		"\timageSizes: readonly string[];",
		"};",
		"",
		"export type GeneratedOpenRouterImageModelConfigEntry = readonly [string, GeneratedOpenRouterImageModelConfig];",
		"",
		"export const generatedOpenRouterImageModelConfigEntries: readonly GeneratedOpenRouterImageModelConfigEntry[] = [",
		...sorted.map(([model, config], index) => `\t${JSON.stringify([model, config])}${index === sorted.length - 1 ? "" : ","}`),
		"];",
		"",
	];
	await fs.writeFile(filePath, lines.join("\n"));
}

function sortByKnownOrder(values, order) {
	const orderIndex = new Map(order.map((value, index) => [value, index]));
	return unique(values).sort((left, right) => {
		const leftIndex = orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER;
		const rightIndex = orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER;
		return leftIndex === rightIndex ? left.localeCompare(right) : leftIndex - rightIndex;
	});
}

function unique(values) {
	return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function normalizedModelId(model) {
	return model.trim().toLowerCase().split(":")[0];
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
	return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stringArray(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
