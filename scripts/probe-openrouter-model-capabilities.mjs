#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultOutputPath = path.join(repoRoot, "packages/shared/src/openrouter-model-capabilities.generated.ts");
const defaultDevVarsPath = path.join(repoRoot, "workers/agent-runtime/.dev.vars");
const openRouterModelsUrl = "https://openrouter.ai/api/v1/models";
const openRouterChatCompletionsUrl = "https://openrouter.ai/api/v1/chat/completions";
const probeMaxCompletionTokens = 256;
const prefillCapabilityVersion = 2;
const requiredToolCapabilityVersion = 2;
const checkpointSchemaVersion = 4;
const contextLengthCapabilityName = "contextLength";
const compactionReasoningCapabilityName = "compactionReasoning";
const capabilityNames = [
	"prefill",
	"structuredOutputs",
	"requiredToolCalls",
	"disabledReasoning",
	"cacheControl",
	compactionReasoningCapabilityName,
	contextLengthCapabilityName,
];
const capabilityCliNames = new Map([
	["prefill", "prefill"],
	["structuredOutputs", "structured-outputs"],
	["requiredToolCalls", "required-tool-calls"],
	["disabledReasoning", "disabled-reasoning"],
	["cacheControl", "cache-control"],
	[compactionReasoningCapabilityName, "compaction-reasoning"],
	[contextLengthCapabilityName, "context-length"],
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
	["compaction-reasoning", compactionReasoningCapabilityName],
	["compaction_reasoning", compactionReasoningCapabilityName],
	[compactionReasoningCapabilityName, compactionReasoningCapabilityName],
	["context-length", contextLengthCapabilityName],
	["context_length", contextLengthCapabilityName],
	[contextLengthCapabilityName, contextLengthCapabilityName],
]);
const allowedOptionNames = new Set([
	"allow-removals", "artifact", "batch-size", "capability", "checkpoint", "concurrency",
	"delay-ms", "dry-run", "help", "input", "mode", "model", "only-affected", "output", "reset-checkpoint", "timeout-ms",
]);
const pinnedCapabilityEntries = new Map([
	[
		"openrouter/free",
		{
			prefill: legacyPrefillCapabilities(false, "conservative_policy"),
			structuredOutputs: false,
			requiredToolCalls: legacyRequiredToolCapabilities(false, "conservative_policy"),
			disabledReasoning: false,
			cacheControl: false,
			compactionReasoning: {
				support: { kind: "unknown" },
				modelDefault: { kind: "provider_default", relativeOrder: "unknown" },
			},
		},
	],
]);

const compactionReasoningEffortOrder = ["minimal", "low", "medium", "high", "xhigh"];
const compactionReasoningEfforts = new Set(compactionReasoningEffortOrder);

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (booleanOption(args, "help")) {
		console.log(usageText());
		return;
	}
	const mode = stringOption(args, "mode", "new");
	if (mode !== "full" && mode !== "new") {
		throw new Error(`--mode must be "full" or "new", got ${JSON.stringify(mode)}.`);
	}
	const outputPath = path.resolve(stringOption(args, "output", defaultOutputPath));
	const inputPath = path.resolve(stringOption(args, "input", outputPath));
	const delayMs = nonNegativeIntegerOption(args, "delay-ms", 1500);
	const timeoutMs = positiveIntegerOption(args, "timeout-ms", 20_000);
	const concurrency = positiveIntegerOption(args, "concurrency", 1);
	const dryRun = booleanOption(args, "dry-run");
	const onlyAffected = booleanOption(args, "only-affected");
	const allowRemovals = booleanOption(args, "allow-removals");
	const batchSize = positiveIntegerOption(args, "batch-size", Number.POSITIVE_INFINITY);
	const checkpointPath = path.resolve(stringOption(args, "checkpoint", path.join("/build/bickr/scratch/issue-171", "openrouter-capability-checkpoint.json")));
	const artifactPath = stringOption(args, "artifact", "");
	if (booleanOption(args, "reset-checkpoint")) await fs.rm(checkpointPath, { force: true });
	const capabilityFilter = capabilityFilterOption(args);
	const modelFilter = stringArrayOption(args, "model");
	const key = await openRouterApiKey();
	const limiter = new RequestLimiter(delayMs);

	const existing = await readExistingEntries(inputPath);
	applyPinnedCapabilityEntries(existing);
	const models = await fetchOpenRouterTextModels(key);
	assertCatalogRemovalIsSafe(existing, models, allowRemovals);
	const catalogFingerprint = sha256(models.map(({ id }) => id).join("\n"));
	const checkpoint = await readCheckpoint(checkpointPath, catalogFingerprint);
	for (const [id, capabilities] of checkpoint.entries) existing.set(id, capabilities);
	const passKey = capabilityProbePassKey(mode, onlyAffected, capabilityFilter, modelFilter);
	const completedForPass = checkpoint.completedPasses.get(passKey) ?? new Set();
	checkpoint.completedPasses.set(passKey, completedForPass);
	const modelsById = new Map(models.map((model) => [model.id, model]));
	const currentIds = new Set(models.map((model) => model.id));
	const requestedIds = modelFilter.length > 0 ? new Set(modelFilter) : currentIds;
	const canCreateCompleteEntry = capabilityNames.every((capability) => capabilityFilter.has(capability));
	const eligibleIds = models
		.map((model) => model.id)
		.filter((id) => requestedIds.has(id))
		.filter((id) => !pinnedCapabilityEntries.has(id))
		// A selective refresh has no observations for the other required
		// dimensions. Defer new rows until a complete probe rather than
		// manufacturing false capability values for them.
		.filter((id) => existing.has(id) || canCreateCompleteEntry)
		.filter((id) => {
			const capabilities = existing.get(id);
			if (onlyAffected) {
				return capabilities !== undefined && capabilitiesNeedProbe(capabilities, capabilityFilter, true);
			}
			return mode === "full" || capabilities === undefined || capabilitiesNeedProbe(capabilities, capabilityFilter, false);
		});
	const idsToProbe = remainingProbeBatch(eligibleIds, completedForPass, batchSize);
	const totals = {
		requests: checkpoint.requests,
		metadataRequests: checkpoint.metadataRequests,
		promptTokens: checkpoint.promptTokens,
		completionTokens: checkpoint.completionTokens,
		spendUsd: checkpoint.spendUsd,
	};
	const providerCatalogs = new Map();
	const capabilityProjection = emptyCapabilityProbeProjection();
	const projectedOrProbedIds = dryRun ? eligibleIds : idsToProbe;
	const idsNeedingProviderCatalog = projectedOrProbedIds.filter((id) =>
		["prefill", "structuredOutputs", "requiredToolCalls", "disabledReasoning", "cacheControl"].some((capability) => shouldProbeCapability(
			capability,
			existing.get(id),
			capabilityFilter,
			mode,
			onlyAffected,
		)),
	);
	await runWithConcurrency(idsNeedingProviderCatalog, Math.min(4, Math.max(1, concurrency)), async (id) => {
		const model = modelsById.get(id);
		const catalog = await fetchEligibleOpenRouterProviderCatalog(id, key, timeoutMs, totals);
		providerCatalogs.set(id, catalog);
	});
	for (const id of projectedOrProbedIds) {
		const selectedCapabilities = new Set(capabilityNames.filter((capability) => shouldProbeCapability(
			capability,
			existing.get(id),
			capabilityFilter,
			mode,
			onlyAffected,
		)));
		// Count reasoning-off as applicable for planning. The live disabled-
		// reasoning probe can only reduce this conservative request estimate.
		addCapabilityProbeProjection(capabilityProjection, projectCapabilityProbe(
			modelsById.get(id),
			providerCatalogs.get(id) ?? [],
			selectedCapabilities,
			true,
		));
	}
	const catalogCoverage = capabilityProbeCatalogCoverage(models, projectedOrProbedIds);
	if (dryRun && mode === "full" && !onlyAffected && modelFilter.length === 0 &&
		capabilityNames.every((capability) => capabilityFilter.has(capability)) && !catalogCoverage.complete) {
		throw new Error(
			`Full capability projection does not cover the current catalog: ${catalogCoverage.uncoveredModelIds.join(", ")}.`,
		);
	}

	// Full mode means replace every selected observation, not discard rows that
	// have not reached the current bounded batch yet. Catalog removal happens in
	// entriesForCurrentModels after the complete current listing is known.
	const next = new Map(existing);
	let completed = 0;
	const startedAt = checkpoint.startedAt;
	let checkpointWrite = Promise.resolve();
	console.log(`OpenRouter returned ${models.length} text-output models.`);
	console.log(
		`${dryRun ? "Projecting" : "Probing"} ${projectedOrProbedIds.length} model(s) in ${mode} mode with concurrency=${concurrency}, delay=${delayMs}ms, onlyAffected=${onlyAffected}, capabilities=${capabilityFilterLabel(capabilityFilter)}.`,
	);
	console.log(`Preserving ${pinnedCapabilityEntries.size} pinned capability entr${pinnedCapabilityEntries.size === 1 ? "y" : "ies"}.`);
	console.log(
		`Catalog coverage: ${catalogCoverage.projectedModelCount} projected/probed + ` +
		`${catalogCoverage.pinnedModelCount} pinned = ${catalogCoverage.catalogModelCount}; ` +
		`complete=${catalogCoverage.complete}.`,
	);
	console.log(
		`Capability projection: ${capabilityProjection.providerCatalogEntries} provider endpoint tag(s), ` +
		`${capabilityProjection.logicalProbes} logical probe(s), ` +
		`${capabilityProjection.minimumActualHttpRequests}-${capabilityProjection.maximumActualHttpRequests} actual HTTP request(s), ` +
		`${capabilityProjection.unknownPricedPairs} unknown-priced provider/shape pair(s), ` +
		`${capabilityProjection.unknownPricedModelProbes} unknown-priced model probe(s), ` +
		`known-priced upper subtotal $${capabilityProjection.knownPricedUpperSubtotalUsd.toFixed(6)}.`,
	);
	if (!key) {
		console.log("No OpenRouter key found; relying on unauthenticated OpenRouter access.");
	}
	if (dryRun) {
		if (artifactPath) {
			await writeRefreshArtifact(path.resolve(artifactPath), {
				schemaVersion: checkpointSchemaVersion,
				dryRun: true,
				startedAt,
				finishedAt: new Date().toISOString(),
				catalogFingerprint,
				catalogModelCount: models.length,
				processedModelCount: 0,
				processedProbeCount: 0,
				completedPassCount: 0,
				catalogCoverage,
				capabilityProbeProjection: capabilityProjection,
				requests: 0,
				metadataRequests: totals.metadataRequests,
				promptTokens: 0,
				completionTokens: 0,
				spendUsd: 0,
			});
		}
		console.log(
			`Dry run: provider metadata was enumerated, no chat capability requests were sent, and no generated output or checkpoint was written${artifactPath ? "; the requested projection artifact was written" : ""}.`,
		);
		return;
	}

	await runWithConcurrency(idsToProbe, Math.max(1, concurrency), async (id) => {
		const model = modelsById.get(id);
		const capabilities = await probeModel(
			model,
			key,
			limiter,
			timeoutMs,
			existing.get(id),
			capabilityFilter,
			mode,
			onlyAffected,
			totals,
			providerCatalogs.get(id),
			checkpoint.prefillProgress.get(`${passKey}\n${id}`),
			async (progress) => {
				checkpoint.prefillProgress.set(`${passKey}\n${id}`, progress);
				Object.assign(checkpoint, totals);
				checkpointWrite = checkpointWrite.then(() => writeCheckpoint(checkpointPath, checkpoint, catalogFingerprint));
				await checkpointWrite;
			},
			checkpoint.requiredToolProgress.get(`${passKey}\n${id}`),
			async (progress) => {
				checkpoint.requiredToolProgress.set(`${passKey}\n${id}`, progress);
				Object.assign(checkpoint, totals);
				checkpointWrite = checkpointWrite.then(() => writeCheckpoint(checkpointPath, checkpoint, catalogFingerprint));
				await checkpointWrite;
			},
		);
		next.set(id, { ...capabilities, contextLength: modelContextLengthForModel(model) });
		checkpoint.entries.set(id, next.get(id));
		checkpoint.processedModels.add(id);
		checkpoint.processedProbeCount += 1;
		checkpoint.prefillProgress.delete(`${passKey}\n${id}`);
		checkpoint.requiredToolProgress.delete(`${passKey}\n${id}`);
		completedForPass.add(id);
		Object.assign(checkpoint, totals);
		// Checkpoint writes are serialized even when probes run concurrently, so
		// a slower earlier write can never overwrite a later completion set.
		checkpointWrite = checkpointWrite.then(() => writeCheckpoint(checkpointPath, checkpoint, catalogFingerprint));
		await checkpointWrite;
		completed += 1;
		console.log(`${completed}/${idsToProbe.length} ${id}: ${capabilitySummary(capabilities)}`);
	});

	applyPinnedCapabilityEntries(next);
	for (const [id, capabilities] of next) {
		if (!currentIds.has(id) || pinnedCapabilityEntries.has(id)) {
			continue;
		}
		const contextLength = modelContextLengthForModel(modelsById.get(id));
		if (contextLength === undefined || capabilities?.contextLength === contextLength) {
			continue;
		}
		next.set(id, { ...capabilities, contextLength });
	}
	const written = entriesForCurrentModels(next, currentIds);
	await writeGeneratedTable(outputPath, written);
	const finalCatalogCoverage = capabilityProbeCatalogCoverage(models, written.map(([id]) => id));
	console.log(`Wrote ${written.length} capability entr${written.length === 1 ? "y" : "ies"} to ${path.relative(repoRoot, outputPath)}.`);
	if (artifactPath) {
		await writeRefreshArtifact(path.resolve(artifactPath), {
			schemaVersion: checkpointSchemaVersion,
			dryRun: false,
			startedAt,
			finishedAt: new Date().toISOString(),
			catalogFingerprint,
			catalogModelCount: models.length,
			processedModelCount: checkpoint.processedModels.size,
			processedProbeCount: checkpoint.processedProbeCount,
			completedPassCount: checkpoint.completedPasses.size,
			catalogCoverage: finalCatalogCoverage,
			capabilityProbeProjection: capabilityProjection,
			...totals,
		});
	}
}

export function parseArgs(values) {
	const parsed = new Map();
	for (let index = 0; index < values.length; index += 1) {
		const item = values[index];
		if (!item.startsWith("--")) {
			throw new Error(`Unexpected positional argument ${JSON.stringify(item)}.`);
		}
		const raw = item.slice(2);
		const equalsIndex = raw.indexOf("=");
		const key = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
		if (!allowedOptionNames.has(key)) {
			throw new Error(`Unknown option --${key}.\n${usageText()}`);
		}
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

function usageText() {
	return [
		"Usage: node scripts/probe-openrouter-model-capabilities.mjs [options]",
		"  --mode new|full --capability NAME --model MODEL",
		"  --batch-size N --checkpoint PATH --reset-checkpoint",
		"  --artifact PATH --allow-removals --dry-run --only-affected",
		"  --concurrency N --delay-ms N --timeout-ms N --input PATH --output PATH",
	].join("\n");
}

function stringOption(options, key, fallback) {
	return options.get(key)?.at(-1) ?? fallback;
}

function nonNegativeIntegerOption(options, key, fallback) {
	const value = options.get(key)?.at(-1);
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`--${key} must be a non-negative integer.`);
	}
	return parsed;
}

function positiveIntegerOption(options, key, fallback) {
	const value = options.get(key)?.at(-1);
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${key} must be a positive integer.`);
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

export function capabilitiesNeedProbe(capabilities, capabilityFilter, onlyAffected) {
	for (const capability of capabilityFilter) {
		if (capabilities[capability] === undefined) {
			return true;
		}
		if (capability === compactionReasoningCapabilityName) {
			if (onlyAffected && capabilities.compactionReasoning.support?.kind === "unknown") {
				return true;
			}
			continue;
		}
		if (capability === "requiredToolCalls" && onlyAffected) {
			const observation = capabilities.requiredToolCalls;
			if (observation.providers.length === 0 ||
				requiredToolObservations(observation).some(({ status }) => status === "unknown")) {
				return true;
			}
			continue;
		}
		if (capability === "prefill" && onlyAffected) {
			if (capabilities.prefill.providers.length === 0 ||
				prefillObservations(capabilities.prefill).some(({ status }) => status === "unknown")) {
				return true;
			}
			continue;
		}
		if (onlyAffected && capabilities[capability] !== true) {
			return true;
		}
	}
	return false;
}

function shouldProbeCapability(capability, previous, capabilityFilter, mode, onlyAffected) {
	if (!capabilityFilter.has(capability)) {
		return false;
	}
	if (!previous) {
		return true;
	}
	if (capability === compactionReasoningCapabilityName) {
		return mode === "full" || previous[capability] === undefined ||
			(onlyAffected && previous.compactionReasoning.support?.kind === "unknown");
	}
	if (capability === "requiredToolCalls") {
		if (mode === "full") return true;
		return onlyAffected && (previous.requiredToolCalls.providers.length === 0 || requiredToolObservations(previous.requiredToolCalls)
			.some(({ status }) => status === "unknown"));
	}
	if (capability === "prefill") {
		if (mode === "full") return true;
		return onlyAffected && (previous.prefill.providers.length === 0 || prefillObservations(previous.prefill)
			.some(({ status }) => status === "unknown"));
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
	const requiredTools = requiredToolObservations(capabilities.requiredToolCalls).map(({ status }) => status).join("/");
	return [
		`prefill=${capabilities.prefill.providers.length}_providers:${prefillObservations(capabilities.prefill).map(({ status }) => status).join("/") || "unobserved"}`,
		`structured=${capabilities.structuredOutputs}`,
		`required_tools=${capabilities.requiredToolCalls.providers.length}_providers:${requiredTools || "unobserved"}`,
		`reasoning_none=${capabilities.disabledReasoning}`,
		`cache_control=${capabilities.cacheControl}`,
		`compaction_reasoning=${capabilities.compactionReasoning.support.kind}`,
		`compaction_default=${capabilities.compactionReasoning.modelDefault.kind}`,
		`context_length=${capabilities.contextLength}`,
	].join(" ");
}

function requiredToolObservations(capabilities) {
	return capabilities.providers.flatMap((provider) => [provider.providerDefault, provider.reasoningOff, provider.reasoningOn]);
}

function prefillObservations(capabilities) {
	return capabilities.providers.flatMap((provider) => [provider.providerDefault, provider.reasoningOff, provider.reasoningOn]);
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

export async function readExistingEntries(filePath) {
	try {
		const text = await fs.readFile(filePath, "utf8");
		const match = /generatedOpenRouterModelCapabilityEntries(?:\s*:\s*readonly\s+GeneratedOpenRouterModelCapabilityEntry\[\])?\s*=\s*(\[[\s\S]*?\n\])(?:\s*as const)?/.exec(text);
		if (!match) {
			throw new Error(`Existing generated capability file is malformed: ${filePath}`);
		}
		const entries = JSON.parse(match[1].replace(/,\s*\]/g, "\n]"));
		validateCapabilityEntriesInput(entries, filePath);
		const upgraded = entries.map(([model, capabilities]) => [model, upgradeLegacyModelCapabilities(capabilities)]);
		validateCapabilityEntries(upgraded, filePath);
		return new Map(upgraded);
	} catch (error) {
		if (error?.code === "ENOENT") {
			return new Map();
		}
		throw error;
	}
}

export function validateCapabilityEntries(entries, source = "capability entries") {
	if (!Array.isArray(entries)) throw new Error(`Generated capability entries are malformed: ${source}`);
	const ids = new Set();
	for (const entry of entries) {
		if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0] || ids.has(entry[0])) {
			throw new Error(`Generated capability entry is malformed or duplicated: ${source}`);
		}
		ids.add(entry[0]);
		validateModelCapabilities(entry[1], `${source} (${entry[0]})`);
	}
}

function validateModelCapabilities(value, source) {
	assertExactRecord(value, [
		"cacheControl", "compactionReasoning", "contextLength", "disabledReasoning",
		"prefill", "requiredToolCalls", "structuredOutputs",
	], ["cacheControl", "compactionReasoning", "disabledReasoning", "prefill", "requiredToolCalls", "structuredOutputs"], source);
	for (const key of ["cacheControl", "disabledReasoning", "structuredOutputs"]) {
		if (typeof value[key] !== "boolean") throw new Error(`Generated capability ${source}.${key} must be boolean.`);
	}
	if (value.contextLength !== undefined && (!Number.isSafeInteger(value.contextLength) || value.contextLength < 1)) {
		throw new Error(`Generated capability ${source}.contextLength must be a positive integer.`);
	}
	validateCompactionReasoningCapabilities(value.compactionReasoning, source);
	validatePrefillCapabilities(value.prefill, source);
	validateRequiredToolCapabilities(value.requiredToolCalls, source);
}

/**
 * The checked-in table historically used booleans for provider-interaction
 * capabilities. Accept those shapes only while reading an old table, then
 * upgrade them before they can enter checkpoints, probe decisions, or output.
 */
function validateCapabilityEntriesInput(entries, source) {
	if (!Array.isArray(entries)) throw new Error(`Generated capability entries are malformed: ${source}`);
	const ids = new Set();
	for (const entry of entries) {
		if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0] || ids.has(entry[0])) {
			throw new Error(`Generated capability entry is malformed or duplicated: ${source}`);
		}
		ids.add(entry[0]);
		const capabilities = entry[1];
		const prefill = capabilities?.prefill;
		const requiredToolCalls = capabilities?.requiredToolCalls;
		if (typeof requiredToolCalls !== "boolean" && requiredToolCalls?.version === 1) {
			validateLegacyRequiredToolCapabilities(requiredToolCalls, `${source} (${entry[0]}).requiredToolCalls`);
		}
		if (typeof prefill !== "boolean" && prefill?.version !== prefillCapabilityVersion) {
			throw new Error(`Legacy prefill capability is malformed: ${source} (${entry[0]}).prefill`);
		}
		validateModelCapabilities(upgradeLegacyModelCapabilities(capabilities), `${source} (${entry[0]})`);
	}
}

function upgradeLegacyModelCapabilities(capabilities) {
	const prefill = capabilities?.prefill;
	const requiredToolCalls = capabilities?.requiredToolCalls;
	return {
		...capabilities,
		prefill: typeof prefill === "boolean" ? legacyPrefillCapabilities(prefill, "legacy_boolean") : prefill,
		requiredToolCalls: typeof requiredToolCalls === "boolean" || requiredToolCalls?.version === 1
			? legacyRequiredToolCapabilities(
				typeof requiredToolCalls === "boolean" ? requiredToolCalls : Boolean(requiredToolCalls.fallback?.supported),
				typeof requiredToolCalls === "boolean" ? "legacy_boolean" : requiredToolCalls.fallback?.source ?? "legacy_boolean",
			)
			: requiredToolCalls,
	};
}

function validatePrefillCapabilities(value, source) {
	assertExactRecord(value, ["fallback", "kind", "providers", "version"], ["fallback", "kind", "providers", "version"], `${source}.prefill`);
	if (value.kind !== "provider_matrix" || value.version !== prefillCapabilityVersion || !Array.isArray(value.providers)) {
		throw new Error(`Generated capability ${source} has an unsupported prefill schema version.`);
	}
	let previousProvider;
	const providerNames = new Set();
	for (const row of value.providers) {
		assertExactRecord(row, ["provider", "providerDefault", "reasoningOff", "reasoningOn"],
			["provider", "providerDefault", "reasoningOff", "reasoningOn"], `${source}.prefill.providers`);
		if (typeof row.provider !== "string" || !row.provider || row.provider !== row.provider.trim().toLowerCase() || providerNames.has(row.provider) ||
			previousProvider !== undefined && codeUnitCompare(previousProvider, row.provider) >= 0) {
			throw new Error(`Generated capability ${source} has a malformed, duplicate, or unordered prefill provider slug.`);
		}
		providerNames.add(row.provider);
		previousProvider = row.provider;
		validateRequiredToolObservation(row.providerDefault, false, `${source}.prefill.${row.provider}.providerDefault`);
		validateRequiredToolObservation(row.reasoningOff, false, `${source}.prefill.${row.provider}.reasoningOff`);
		validateRequiredToolObservation(row.reasoningOn, true, `${source}.prefill.${row.provider}.reasoningOn`);
	}
	assertExactRecord(value.fallback, ["source", "supported"], ["source", "supported"], `${source}.prefill.fallback`);
	if (typeof value.fallback.supported !== "boolean" || !["legacy_boolean", "custom_provider_policy", "conservative_policy"].includes(value.fallback.source)) {
		throw new Error(`Generated capability ${source} has an invalid prefill fallback.`);
	}
}

function validateLegacyRequiredToolCapabilities(value, source) {
	assertExactRecord(value, ["fallback", "providerDefault", "reasoningOff", "reasoningOn", "version"],
		["fallback", "providerDefault", "reasoningOff", "reasoningOn", "version"], source);
	if (value.version !== 1 || typeof value.fallback?.supported !== "boolean") {
		throw new Error(`Legacy required-tool capability is malformed: ${source}`);
	}
}

function validateCompactionReasoningCapabilities(value, source) {
	assertExactRecord(value, ["modelDefault", "support"], ["modelDefault", "support"], `${source}.compactionReasoning`);
	const support = value.support;
	assertExactRecord(support, ["efforts", "kind"], ["kind"], `${source}.compactionReasoning.support`);
	if (!new Set(["known", "partially_known", "unknown", "unsupported"]).has(support.kind)) {
		throw new Error(`Generated capability ${source} has an invalid compaction support kind.`);
	}
	if (support.kind === "known" || support.kind === "partially_known") {
		if (!Array.isArray(support.efforts) || support.efforts.some((effort) => !compactionReasoningEfforts.has(effort)) ||
			new Set(support.efforts).size !== support.efforts.length || support.kind === "known" && support.efforts.length === 0) {
			throw new Error(`Generated capability ${source} has invalid compaction efforts.`);
		}
	} else if (support.efforts !== undefined) {
		throw new Error(`Generated capability ${source} has efforts for a non-effort support kind.`);
	}
	const modelDefault = value.modelDefault;
	assertExactRecord(modelDefault, ["effort", "kind", "relativeOrder"], ["kind"], `${source}.compactionReasoning.modelDefault`);
	switch (modelDefault.kind) {
		case "absent":
			if (Object.keys(modelDefault).length !== 1) throw new Error(`Generated capability ${source} has malformed absent model-default metadata.`);
			break;
		case "explicit_effort":
			if (!compactionReasoningEfforts.has(modelDefault.effort) || Object.keys(modelDefault).length !== 2) {
				throw new Error(`Generated capability ${source} has malformed explicit model-default metadata.`);
			}
			break;
		case "provider_default":
			if (!["below_minimal", "above_xhigh", "unknown"].includes(modelDefault.relativeOrder) || Object.keys(modelDefault).length !== 2) {
				throw new Error(`Generated capability ${source} has malformed provider-default metadata.`);
			}
			break;
		default: throw new Error(`Generated capability ${source} has an invalid model-default kind.`);
	}
}

function validateRequiredToolCapabilities(value, source) {
	assertExactRecord(
		value,
		["fallback", "kind", "providers", "version"],
		["fallback", "kind", "providers", "version"],
		`${source}.requiredToolCalls`,
	);
	if (value.kind !== "provider_matrix" || value.version !== requiredToolCapabilityVersion || !Array.isArray(value.providers)) {
		throw new Error(`Generated capability ${source} has an unsupported required-tool schema version.`);
	}
	const providerNames = new Set();
	let previousProvider;
	for (const provider of value.providers) {
		assertExactRecord(provider, ["provider", "providerDefault", "reasoningOff", "reasoningOn"],
			["provider", "providerDefault", "reasoningOff", "reasoningOn"], `${source}.requiredToolCalls.providers`);
		if (typeof provider.provider !== "string" || !provider.provider || provider.provider !== provider.provider.trim().toLowerCase() || providerNames.has(provider.provider)) {
			throw new Error(`Generated capability ${source} has a malformed or duplicate provider slug.`);
		}
		providerNames.add(provider.provider);
		if (previousProvider !== undefined && codeUnitCompare(previousProvider, provider.provider) >= 0) {
			throw new Error(`Generated capability ${source} provider rows must be in canonical order.`);
		}
		previousProvider = provider.provider;
		validateRequiredToolObservation(provider.providerDefault, false, `${source}.requiredToolCalls.${provider.provider}.providerDefault`);
		validateRequiredToolObservation(provider.reasoningOff, false, `${source}.requiredToolCalls.${provider.provider}.reasoningOff`);
		validateRequiredToolObservation(provider.reasoningOn, true, `${source}.requiredToolCalls.${provider.provider}.reasoningOn`);
	}
	assertExactRecord(value.fallback, ["source", "supported"], ["source", "supported"], `${source}.requiredToolCalls.fallback`);
	if (typeof value.fallback.supported !== "boolean" || value.fallback.source === "probe" || !requiredToolSources.has(value.fallback.source)) {
		throw new Error(`Generated capability ${source} has an invalid required-tool fallback.`);
	}
}

const requiredToolStatuses = new Set(["supported", "unsupported", "unknown", "not_applicable"]);
const requiredToolSources = new Set(["probe", "legacy_boolean", "custom_provider_policy", "conservative_policy"]);

function validateRequiredToolObservation(value, reasoningOn, source) {
	assertExactRecord(value, ["effort", "source", "status"], ["source", "status", ...(reasoningOn ? ["effort"] : [])], source);
	if (!requiredToolStatuses.has(value.status) || value.source !== "probe") {
		throw new Error(`Generated capability ${source} has an invalid required-tool observation.`);
	}
	if (reasoningOn && (value.status === "not_applicable" ? value.effort !== null : !compactionReasoningEfforts.has(value.effort))) {
		throw new Error(`Generated capability ${source} has invalid reasoning-on effort evidence.`);
	}
}

function assertExactRecord(value, allowedKeys, requiredKeys, source) {
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		Object.keys(value).some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
		throw new Error(`Generated capability shape is malformed: ${source}`);
	}
}

export function assertCatalogRemovalIsSafe(existing, models, allowRemovals) {
	const current = new Set(models.map(({ id }) => id));
	const removed = [...existing.keys()].filter((id) => !current.has(id) && !pinnedCapabilityEntries.has(id)).sort(codeUnitCompare);
	if (removed.length === 0) return;
	console.log(`OpenRouter catalog no longer lists ${removed.length} generated model(s): ${removed.join(", ")}`);
	const suspiciousLimit = Math.max(5, Math.floor(existing.size * 0.1));
	if (!allowRemovals && removed.length > suspiciousLimit) {
		throw new Error(`Refusing suspicious catalog shrinkage (${removed.length}/${existing.size}); inspect it and rerun with --allow-removals.`);
	}
}

export async function readCheckpoint(filePath, catalogFingerprint) {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
		if (
			parsed?.schemaVersion !== checkpointSchemaVersion
			|| parsed.catalogFingerprint !== catalogFingerprint
			|| !Array.isArray(parsed.entries)
			|| !Array.isArray(parsed.completedPasses)
			|| !Array.isArray(parsed.processedModels)
			|| !Array.isArray(parsed.prefillProgress)
			|| !Array.isArray(parsed.requiredToolProgress)
			|| !checkpointEntriesAreValid(parsed.entries, filePath)
			|| parsed.completedPasses.some((item) =>
				!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string"
				|| !Array.isArray(item[1]) || item[1].some((id) => typeof id !== "string")
			)
			|| parsed.processedModels.some((id) => typeof id !== "string")
			|| !prefillCheckpointProgressIsValid(parsed.prefillProgress)
			|| !requiredToolCheckpointProgressIsValid(parsed.requiredToolProgress, filePath)
		) {
			throw new Error(`Capability checkpoint does not match the current schema/catalog: ${filePath}`);
		}
		return {
			entries: new Map(parsed.entries),
			completedPasses: new Map(parsed.completedPasses.map(([key, ids]) => [key, new Set(ids)])),
			processedModels: new Set(parsed.processedModels),
			prefillProgress: new Map(parsed.prefillProgress.map(([key, progress]) => [key, {
				providers: progress.providers,
				observations: new Map(progress.observations),
			}])),
			requiredToolProgress: new Map(parsed.requiredToolProgress.map(([key, progress]) => [key, {
				providers: progress.providers,
				observations: new Map(progress.observations),
			}])),
			processedProbeCount: nonNegativeNumber(parsed.processedProbeCount),
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString(),
			requests: nonNegativeNumber(parsed.requests),
			metadataRequests: nonNegativeNumber(parsed.metadataRequests),
			promptTokens: nonNegativeNumber(parsed.promptTokens),
			completionTokens: nonNegativeNumber(parsed.completionTokens),
			spendUsd: nonNegativeNumber(parsed.spendUsd),
		};
	} catch (error) {
		if (error?.code === "ENOENT") {
			return {
				entries: new Map(),
				completedPasses: new Map(),
				processedModels: new Set(),
				prefillProgress: new Map(),
				requiredToolProgress: new Map(),
				processedProbeCount: 0,
				startedAt: new Date().toISOString(),
				requests: 0,
				metadataRequests: 0,
				promptTokens: 0,
				completionTokens: 0,
				spendUsd: 0,
			};
		}
		throw error;
	}
}

function checkpointEntriesAreValid(entries, source) {
	try {
		validateCapabilityEntries(entries, source);
		return true;
	} catch {
		return false;
	}
}

async function writeCheckpoint(filePath, checkpoint, catalogFingerprint) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const value = {
		schemaVersion: checkpointSchemaVersion,
		catalogFingerprint,
		entries: [...checkpoint.entries].sort(([left], [right]) => codeUnitCompare(left, right)),
		completedPasses: [...checkpoint.completedPasses]
			.sort(([left], [right]) => codeUnitCompare(left, right))
			.map(([key, ids]) => [key, [...ids].sort(codeUnitCompare)]),
		processedModels: [...checkpoint.processedModels].sort(codeUnitCompare),
		prefillProgress: [...checkpoint.prefillProgress]
			.sort(([left], [right]) => codeUnitCompare(left, right))
			.map(([key, progress]) => [key, {
				providers: [...progress.providers],
				observations: [...progress.observations].sort(([left], [right]) => codeUnitCompare(left, right)),
			}]),
		requiredToolProgress: [...checkpoint.requiredToolProgress]
			.sort(([left], [right]) => codeUnitCompare(left, right))
			.map(([key, progress]) => [key, {
				providers: [...progress.providers],
				observations: [...progress.observations].sort(([left], [right]) => codeUnitCompare(left, right)),
			}]),
		processedProbeCount: checkpoint.processedProbeCount,
		startedAt: checkpoint.startedAt,
		requests: checkpoint.requests,
		metadataRequests: checkpoint.metadataRequests,
		promptTokens: checkpoint.promptTokens,
		completionTokens: checkpoint.completionTokens,
		spendUsd: checkpoint.spendUsd,
	};
	await fs.writeFile(filePath, `${canonicalGeneratedJson(value)}\n`);
}

function prefillCheckpointProgressIsValid(entries) {
	return requiredToolCheckpointProgressIsValid(entries, "prefill checkpoint");
}

function requiredToolCheckpointProgressIsValid(entries, source) {
	try {
		const keys = new Set();
		for (const item of entries) {
			if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !item[0] || keys.has(item[0])) {
				throw new Error("duplicate progress key");
			}
			keys.add(item[0]);
			const progress = item[1];
			if (!progress || !Array.isArray(progress.providers) || !Array.isArray(progress.observations) ||
				progress.providers.some((provider) => typeof provider !== "string") ||
				progress.providers.join("\n") !== [...new Set(progress.providers)].sort(codeUnitCompare).join("\n")) {
				throw new Error("malformed provider catalog");
			}
			const observationKeys = new Set();
			for (const observationEntry of progress.observations) {
				if (!Array.isArray(observationEntry) || observationEntry.length !== 2 || typeof observationEntry[0] !== "string" || observationKeys.has(observationEntry[0])) {
					throw new Error("malformed observation key");
				}
				observationKeys.add(observationEntry[0]);
				const [provider, shape] = observationEntry[0].split("\n");
				if (!progress.providers.includes(provider) || !["providerDefault", "reasoningOff", "reasoningOn"].includes(shape)) {
					throw new Error("observation does not match provider catalog");
				}
				validateRequiredToolObservation(observationEntry[1], shape === "reasoningOn", `${source}.providerProgress`);
			}
		}
		return true;
	} catch {
		return false;
	}
}

export function capabilityProbePassKey(mode, onlyAffected, capabilityFilter, modelFilter = []) {
	return sha256(canonicalGeneratedJson({
		mode,
		onlyAffected,
		capabilities: [...capabilityFilter].sort(codeUnitCompare),
		models: [...modelFilter].sort(codeUnitCompare),
	}));
}

export function remainingProbeBatch(ids, completedIds, batchSize) {
	const remaining = ids.filter((id) => !completedIds.has(id));
	return Number.isFinite(batchSize) ? remaining.slice(0, Math.floor(batchSize)) : remaining;
}

async function writeRefreshArtifact(filePath, artifact) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${canonicalGeneratedJson(artifact)}\n`);
}

function recordProbeUsage(totals, payload) {
	if (!totals) return;
	const usage = recordValue(recordValue(payload).usage);
	totals.promptTokens += nonNegativeNumber(usage.prompt_tokens);
	totals.completionTokens += nonNegativeNumber(usage.completion_tokens);
	totals.spendUsd += nonNegativeNumber(usage.cost);
}

function nonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
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
			return id && outputModalities.includes("text")
				? {
						id,
						contextLength: modelContextLengthForModel(record),
						reasoning: record.reasoning,
						supportedParameters: Array.isArray(record.supported_parameters)
							? stringArray(record.supported_parameters)
							: undefined,
					}
				: null;
		})
		.filter(Boolean)
		.sort((left, right) => codeUnitCompare(left.id, right.id));
}

async function fetchEligibleOpenRouterProviderCatalog(model, apiKey, timeoutMs, totals) {
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) {
		throw new Error(`Cannot enumerate OpenRouter providers for malformed model id ${JSON.stringify(model)}.`);
	}
	const author = encodeURIComponent(model.slice(0, separator));
	const slug = encodeURIComponent(model.slice(separator + 1));
	const url = `${openRouterModelsUrl}/${author}/${slug}/endpoints`;
	let response;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		if (totals) totals.metadataRequests += 1;
		try {
			response = await fetch(url, {
				headers: {
					accept: "application/json",
					...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
				},
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			if (attempt < 3 && (error?.name === "TimeoutError" || error?.name === "AbortError" || error instanceof TypeError)) {
				await sleep(attempt * 1000);
				continue;
			}
			throw new Error(`OpenRouter provider endpoint request failed for ${model}.`, { cause: error });
		}
		if (response.ok) break;
		if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
			await sleep(attempt * 1000);
			continue;
		}
		throw new Error(`OpenRouter provider endpoints for ${model} returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
	}
	if (!response?.ok) {
		throw new Error(`OpenRouter provider endpoint enumeration was exhausted for ${model}.`);
	}
	return eligibleOpenRouterProviderCatalog(await response.json());
}

/**
 * OpenRouter's per-model endpoint data is the source of truth for the possible
 * provider set. supported_parameters is diagnostic only: default routing may
 * still send a request to a provider that ignores an unknown parameter unless
 * the caller opts into require_parameters, which Bickr deliberately does not
 * use as a substitute for probing this parameter interaction.
 *
 * The endpoint feed uses status -2 for unavailable endpoints and 0 for active
 * endpoints. Unknown or missing statuses stay eligible by construction; a new
 * status must never silently shrink the conservative runtime provider set.
 */
export function eligibleOpenRouterProviderCatalog(payload) {
	const endpoints = Array.isArray(recordValue(payload).data?.endpoints)
		? recordValue(payload).data.endpoints
		: Array.isArray(recordValue(recordValue(payload).data).endpoints)
			? recordValue(recordValue(payload).data).endpoints
			: [];
	const rows = endpoints.map((value) => {
		const endpoint = recordValue(value);
		const provider = stringValue(endpoint.tag)?.toLowerCase();
		const availability = openRouterEndpointAvailability(endpoint.status);
		if (!provider || availability === "unavailable") return null;
		const supportedParameters = uniqueStrings(endpoint.supported_parameters);
		const pricing = recordValue(endpoint.pricing);
		return {
			provider,
			availability,
			supportsTools: supportedParameters.includes("tools"),
			promptPrice: nonNegativePrice(pricing.prompt),
			completionPrice: nonNegativePrice(pricing.completion),
			requestPrice: nonNegativePrice(pricing.request),
		};
	}).filter(Boolean);
	const grouped = new Map();
	for (const row of rows) {
		const current = grouped.get(row.provider);
		grouped.set(row.provider, {
			provider: row.provider,
			advertisesTools: Boolean(current?.advertisesTools || row.supportsTools),
			hasUnknownAvailability: Boolean(current?.hasUnknownAvailability || row.availability === "unknown_included"),
			promptPrice: maximumKnownPrice(current?.promptPrice, row.promptPrice),
			completionPrice: maximumKnownPrice(current?.completionPrice, row.completionPrice),
			requestPrice: maximumKnownPrice(current?.requestPrice, row.requestPrice),
		});
	}
	return [...grouped.values()].sort((left, right) => codeUnitCompare(left.provider, right.provider));
}

export function openRouterEndpointAvailability(status) {
	if (status === -2) return "unavailable";
	if (status === 0) return "active";
	return "unknown_included";
}

function nonNegativePrice(value) {
	const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(number) && number >= 0 ? number : null;
}

function maximumKnownPrice(left, right) {
	if (left === null || left === undefined) return right ?? null;
	if (right === null || right === undefined) return left;
	return Math.max(left, right);
}

function emptyCapabilityProbeBreakdown() {
	return {
		logicalProbes: 0,
		minimumActualHttpRequests: 0,
		maximumActualHttpRequests: 0,
		unknownPricedPairs: 0,
		unknownPricedModelProbes: 0,
		knownPricedUpperSubtotalUsd: 0,
	};
}

function emptyCapabilityProbeProjection() {
	return {
		models: 0,
		providerCatalogEntries: 0,
		...emptyCapabilityProbeBreakdown(),
		byCapability: Object.fromEntries(capabilityNames.map((capability) => [capability, emptyCapabilityProbeBreakdown()])),
	};
}

/**
 * Project logical observations separately from wire requests. A provider-shape
 * observation is one logical probe even though the paired control and test are
 * separate posts. The maximum includes all three postOpenRouter attempts and,
 * for required tool calls, the extra weak-success confirmation post.
 */
export function projectCapabilityProbe(model, providerCatalog, selectedCapabilities, disabledReasoning = true) {
	const projection = emptyCapabilityProbeProjection();
	projection.models = 1;
	projection.providerCatalogEntries = providerCatalog.length;
	const matrix = requiredToolProbeMatrix(model, providerCatalog, disabledReasoning)
		.filter(({ notApplicable }) => !notApplicable);

	if (selectedCapabilities.has("prefill")) {
		projectProviderShapeCapability(projection.byCapability.prefill, matrix, providerCatalog, 2, 6);
	}
	if (selectedCapabilities.has("requiredToolCalls")) {
		projectProviderShapeCapability(projection.byCapability.requiredToolCalls, matrix, providerCatalog, 2, 9);
	}
	if (selectedCapabilities.has("structuredOutputs")) {
		projectModelCapability(projection.byCapability.structuredOutputs, providerCatalog, probeMaxCompletionTokens, true);
	}
	if (selectedCapabilities.has("disabledReasoning")) {
		projectModelCapability(projection.byCapability.disabledReasoning, providerCatalog, 32, true);
	}
	if (selectedCapabilities.has("cacheControl")) {
		projectModelCapability(projection.byCapability.cacheControl, providerCatalog, 16, topLevelCacheControlCandidate(model.id), true);
	}
	if (selectedCapabilities.has(compactionReasoningCapabilityName)) {
		projection.byCapability.compactionReasoning.logicalProbes = 1;
	}
	if (selectedCapabilities.has(contextLengthCapabilityName)) {
		projection.byCapability.contextLength.logicalProbes = 1;
	}
	for (const breakdown of Object.values(projection.byCapability)) {
		addCapabilityProbeBreakdown(projection, breakdown);
	}
	return projection;
}

function projectProviderShapeCapability(breakdown, matrix, providerCatalog, minimumPosts, maximumPosts) {
	const catalogByProvider = new Map(providerCatalog.map((provider) => [provider.provider, provider]));
	breakdown.logicalProbes = matrix.length;
	breakdown.minimumActualHttpRequests = matrix.length * minimumPosts;
	breakdown.maximumActualHttpRequests = matrix.length * maximumPosts;
	for (const { provider } of matrix) {
		const price = maximumProbeRequestPrice(catalogByProvider.get(provider), probeMaxCompletionTokens);
		if (price === null) {
			breakdown.unknownPricedPairs += 1;
		} else {
			breakdown.knownPricedUpperSubtotalUsd += price * maximumPosts;
		}
	}
}

function projectModelCapability(breakdown, providerCatalog, maxCompletionTokens, sendsRequest) {
	breakdown.logicalProbes = 1;
	if (!sendsRequest) return;
	breakdown.minimumActualHttpRequests = 1;
	breakdown.maximumActualHttpRequests = 3;
	const prices = providerCatalog.map((provider) => maximumProbeRequestPrice(provider, maxCompletionTokens));
	const knownPrices = prices.filter((price) => price !== null);
	breakdown.unknownPricedPairs = prices.filter((price) => price === null).length;
	if (providerCatalog.length === 0 || breakdown.unknownPricedPairs > 0) {
		breakdown.unknownPricedModelProbes = 1;
	}
	if (knownPrices.length > 0) {
		breakdown.knownPricedUpperSubtotalUsd = Math.max(...knownPrices) * 3;
	}
}

function maximumProbeRequestPrice(provider, maxCompletionTokens) {
	if (!provider || provider.promptPrice === null || provider.completionPrice === null) {
		return null;
	}
	return (provider.requestPrice ?? 0) + maxCompletionTokens * (provider.promptPrice + provider.completionPrice);
}

function addCapabilityProbeBreakdown(total, value) {
	for (const key of [
		"logicalProbes", "minimumActualHttpRequests", "maximumActualHttpRequests",
		"unknownPricedPairs", "unknownPricedModelProbes", "knownPricedUpperSubtotalUsd",
	]) {
		total[key] += value[key];
	}
}

function addCapabilityProbeProjection(total, value) {
	total.models += value.models;
	total.providerCatalogEntries += value.providerCatalogEntries;
	for (const key of capabilityNames) {
		addCapabilityProbeBreakdown(total.byCapability[key], value.byCapability[key]);
	}
	for (const key of [
		"logicalProbes", "minimumActualHttpRequests", "maximumActualHttpRequests",
		"unknownPricedPairs", "unknownPricedModelProbes", "knownPricedUpperSubtotalUsd",
	]) {
		total[key] += value[key];
	}
}

export function projectRequiredToolProbe(model, providerCatalog, disabledReasoning = true) {
	const projection = projectCapabilityProbe(model, providerCatalog, new Set(["requiredToolCalls"]), disabledReasoning);
	const required = projection.byCapability.requiredToolCalls;
	return {
		models: 1,
		providers: providerCatalog.length,
		providerShapes: required.logicalProbes,
		minimumChatRequests: required.minimumActualHttpRequests,
		maximumChatRequests: required.maximumActualHttpRequests,
		unknownPricedPairs: required.unknownPricedPairs,
		knownPricedUpperSubtotalUsd: required.knownPricedUpperSubtotalUsd,
		projectedMaximumSpendUsd: required.unknownPricedPairs > 0 ? null : required.knownPricedUpperSubtotalUsd,
	};
}

export function capabilityProbeCatalogCoverage(models, projectedIds) {
	const currentIds = new Set(models.map(({ id }) => id));
	const pinned = new Set([...pinnedCapabilityEntries.keys()].filter((id) => currentIds.has(id)));
	const projected = new Set(projectedIds.filter((id) => currentIds.has(id) && !pinned.has(id)));
	const uncoveredModelIds = [...currentIds]
		.filter((id) => !projected.has(id) && !pinned.has(id))
		.sort(codeUnitCompare);
	return {
		catalogModelCount: currentIds.size,
		projectedModelCount: projected.size,
		pinnedModelCount: pinned.size,
		complete: uncoveredModelIds.length === 0 && projected.size + pinned.size === currentIds.size,
		uncoveredModelIds,
	};
}

async function probeModel(
	model,
	apiKey,
	limiter,
	timeoutMs,
	previous,
	capabilityFilter,
	mode,
	onlyAffected,
	totals,
	providerCatalog,
	prefillProgress,
	onPrefillProgress,
	requiredToolProgress,
	onRequiredToolProgress,
) {
	const modelId = model?.id;
	if (!modelId) {
		throw new Error("Missing model id.");
	}
	const disabledReasoning = shouldProbeCapability("disabledReasoning", previous, capabilityFilter, mode, onlyAffected)
		? await probeCapability(apiKey, limiter, timeoutMs, providerDisabledReasoningRequest(modelId), responseOk, totals)
		: Boolean(previous?.disabledReasoning);
	return {
		prefill: shouldProbeCapability("prefill", previous, capabilityFilter, mode, onlyAffected)
			? await probePrefillCapabilities(
				model,
				disabledReasoning,
				legacyPrefillFallback(previous?.prefill),
				providerCatalog,
				apiKey,
				limiter,
				timeoutMs,
				totals,
				prefillProgress,
				onPrefillProgress,
			)
			: previous?.prefill ?? legacyPrefillCapabilities(false, "conservative_policy"),
		structuredOutputs:
			shouldProbeCapability("structuredOutputs", previous, capabilityFilter, mode, onlyAffected)
				? await probeCapability(apiKey, limiter, timeoutMs, providerStructuredOutputRequest(modelId), structuredOutputSupported, totals)
				: Boolean(previous?.structuredOutputs),
		requiredToolCalls:
			shouldProbeCapability("requiredToolCalls", previous, capabilityFilter, mode, onlyAffected)
				? await probeRequiredToolCapabilities(
					model,
					disabledReasoning,
					legacyRequiredToolFallback(previous?.requiredToolCalls),
					providerCatalog,
					apiKey,
					limiter,
					timeoutMs,
					totals,
					requiredToolProgress,
					onRequiredToolProgress,
				)
				: previous?.requiredToolCalls ?? legacyRequiredToolCapabilities(false, "conservative_policy"),
		disabledReasoning,
		cacheControl:
			shouldProbeCapability("cacheControl", previous, capabilityFilter, mode, onlyAffected)
				? await probeCacheControlCapability(modelId, apiKey, limiter, timeoutMs, totals)
				: Boolean(previous?.cacheControl),
		compactionReasoning:
			shouldProbeCapability(compactionReasoningCapabilityName, previous, capabilityFilter, mode, onlyAffected)
				? compactionReasoningCapabilitiesFromModelMetadata(model)
				: previous?.compactionReasoning ?? compactionReasoningCapabilitiesFromModelMetadata(model),
	};
}

export function compactionReasoningCapabilitiesFromModelMetadata(model) {
	const reasoningValue = model?.reasoning;
	const reasoning = recordValue(reasoningValue);
	const supportedParametersObserved = Array.isArray(model?.supportedParameters);
	const supportsReasoningParameter = stringArray(model?.supportedParameters).includes("reasoning");
	const hasSupportedEfforts = Object.prototype.hasOwnProperty.call(reasoning, "supported_efforts");
	let support;
	if (reasoning.supported_efforts === null && hasSupportedEfforts) {
		// OpenRouter defines null as accepting every gateway effort value. Store
		// the intersection with Phase 2's modelled ladder; see the reasoning guide:
		// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
		support = { kind: "known", efforts: [...compactionReasoningEfforts].sort(codeUnitCompare) };
	} else if (Array.isArray(reasoning.supported_efforts)) {
		const observedEffortValues = uniqueStrings(reasoning.supported_efforts);
		const observedModelledEfforts = observedEffortValues
			.filter((effort) => compactionReasoningEfforts.has(effort))
			.sort(codeUnitCompare);
		const hasUnmodelledEffort = observedEffortValues.some((effort) => !compactionReasoningEfforts.has(effort));
		if (reasoning.supported_efforts.length === 0) {
			support = { kind: "unsupported" };
		} else if (observedEffortValues.length === 0) {
			support = { kind: "unknown" };
		} else if (hasUnmodelledEffort) {
			support = { kind: "partially_known", efforts: observedModelledEfforts };
		} else {
			support = { kind: "known", efforts: observedModelledEfforts };
		}
	} else if (reasoningValue === null || reasoningValue === undefined) {
		support = !supportedParametersObserved || supportsReasoningParameter
			? { kind: "unknown" }
			: { kind: "unsupported" };
	} else {
		support = { kind: "unknown" };
	}
	const defaultEffort = stringValue(reasoning.default_effort);
	// default_effort is only the preselection when reasoning is enabled;
	// default_enabled is the on/off state when the caller has not selected one.
	// Explicit off evidence must therefore win over every enabled effort hint:
	// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
	const modelDefault = defaultEffort === "none" || reasoning.default_enabled === false
		? { kind: "provider_default", relativeOrder: "below_minimal" }
		: defaultEffort && compactionReasoningEfforts.has(defaultEffort)
			? { kind: "explicit_effort", effort: defaultEffort }
			: defaultEffort === "max"
				? { kind: "provider_default", relativeOrder: "above_xhigh" }
		: Object.keys(reasoning).length > 0 || supportsReasoningParameter
			? { kind: "provider_default", relativeOrder: "unknown" }
			: { kind: "absent" };
	return { support, modelDefault };
}

async function probeRequiredToolCapabilities(
	model,
	disabledReasoning,
	fallback,
	providerCatalog,
	apiKey,
	limiter,
	timeoutMs,
	totals,
	resume,
	onProgress,
) {
	if (!Array.isArray(providerCatalog)) {
		throw new Error(`Provider catalog was not enumerated for ${model.id}.`);
	}
	const providerNames = providerCatalog.map(({ provider }) => provider);
	const progress = resumableRequiredToolProgress(providerNames, resume);
	for (const { provider, key, reasoning: reasoningConfig, notApplicable, effort } of requiredToolProbeMatrix(
		model,
		providerCatalog,
		disabledReasoning,
	)) {
		const progressKey = `${provider}\n${key}`;
		if (progress.observations.has(progressKey)) continue;
		const result = notApplicable
			? { status: "not_applicable", source: "probe" }
			: await probeRequiredToolShape(model.id, provider, reasoningConfig, apiKey, limiter, timeoutMs, totals);
		const observation = key === "reasoningOn"
			? { ...result, effort: notApplicable ? null : effort }
			: result;
		progress.observations.set(progressKey, observation);
		await onProgress?.(progress);
	}
	return {
		kind: "provider_matrix",
		version: requiredToolCapabilityVersion,
		providers: providerNames.map((provider) => ({
			provider,
			providerDefault: progress.observations.get(`${provider}\nproviderDefault`),
			reasoningOff: progress.observations.get(`${provider}\nreasoningOff`),
			reasoningOn: progress.observations.get(`${provider}\nreasoningOn`),
		})),
		fallback,
	};
}

async function probePrefillCapabilities(
	model,
	disabledReasoning,
	fallback,
	providerCatalog,
	apiKey,
	limiter,
	timeoutMs,
	totals,
	resume,
	onProgress,
) {
	if (!Array.isArray(providerCatalog)) {
		throw new Error(`Provider catalog was not enumerated for ${model.id}.`);
	}
	const providerNames = providerCatalog.map(({ provider }) => provider);
	const progress = resumablePrefillProgress(providerNames, resume);
	for (const { provider, key, reasoning, notApplicable, effort } of requiredToolProbeMatrix(model, providerCatalog, disabledReasoning)) {
		const progressKey = `${provider}\n${key}`;
		if (progress.observations.has(progressKey)) continue;
		if (notApplicable) {
			progress.observations.set(progressKey, key === "reasoningOn"
				? { status: "not_applicable", source: "probe", effort: null }
				: { status: "not_applicable", source: "probe" });
			await onProgress?.(progress);
			continue;
		}
		const control = await postOpenRouter(
			apiKey,
			limiter,
			timeoutMs,
			providerPrefillControlRequest(model.id, reasoning, provider),
			totals,
		);
		const controlIsUsable = control.ok && providerMessage(control.payload) !== null;
		const tested = controlIsUsable
			? await postOpenRouter(
				apiKey,
				limiter,
				timeoutMs,
				providerPrefillRequest(model.id, reasoning, provider),
				totals,
			)
			: undefined;
		const result = { status: classifyPrefillProbePair(control, tested), source: "probe" };
		progress.observations.set(progressKey, key === "reasoningOn" ? { ...result, effort } : result);
		await onProgress?.(progress);
	}
	return {
		kind: "provider_matrix",
		version: prefillCapabilityVersion,
		providers: providerNames.map((provider) => ({
			provider,
			providerDefault: progress.observations.get(`${provider}\nproviderDefault`),
			reasoningOff: progress.observations.get(`${provider}\nreasoningOff`),
			reasoningOn: progress.observations.get(`${provider}\nreasoningOn`),
		})),
		fallback,
	};
}

export function resumablePrefillProgress(providerNames, resume) {
	return resume && resume.providers.join("\n") === providerNames.join("\n")
		? resume
		: { providers: [...providerNames], observations: new Map() };
}

export function resumableRequiredToolProgress(providerNames, resume) {
	return resume && resume.providers.join("\n") === providerNames.join("\n")
		? resume
		: { providers: [...providerNames], observations: new Map() };
}

export function requiredToolProbeShapes(model, disabledReasoning) {
	const reasoning = recordValue(model?.reasoning);
	const reasoningCapabilities = compactionReasoningCapabilitiesFromModelMetadata(model);
	const reasoningEffort = requiredToolProbeEffort(reasoningCapabilities);
	return [
		{ key: "providerDefault", reasoning: undefined, notApplicable: false, effort: null },
		{
			key: "reasoningOff",
			reasoning: { effort: "none", exclude: false },
			notApplicable: reasoning.mandatory === true && !disabledReasoning,
			effort: null,
		},
		{
			key: "reasoningOn",
			reasoning: { effort: reasoningEffort, exclude: false },
			notApplicable: reasoningCapabilities.support.kind === "unsupported",
			effort: reasoningEffort,
		},
	];
}

export function requiredToolProbeMatrix(model, providerCatalog, disabledReasoning = true) {
	const shapes = requiredToolProbeShapes(model, disabledReasoning);
	return providerCatalog.flatMap(({ provider }) => shapes.map((shape) => ({ provider, ...shape })));
}

async function probeRequiredToolShape(model, provider, reasoning, apiKey, limiter, timeoutMs, totals) {
	const control = await postOpenRouter(
		apiKey,
		limiter,
		timeoutMs,
		providerRequiredToolControlRequest(model, reasoning, provider),
		totals,
	);
	if (!control.ok) return { status: "unknown", source: "probe" };
	const request = providerRequiredToolCallRequest(model, reasoning, provider);
	const first = await postOpenRouter(apiKey, limiter, timeoutMs, request, totals);
	const firstStatus = classifyRequiredToolProbeResponse(first);
	if (firstStatus !== "weak_success") return { status: firstStatus, source: "probe" };
	// A single compliant HTTP response that ignores tool_choice is weak evidence:
	// retry the identical pinned request before recording unsupported.
	const second = await postOpenRouter(apiKey, limiter, timeoutMs, request, totals);
	return {
		status: classifyRequiredToolProbeAttempts(first, second),
		source: "probe",
	};
}

export function classifyRequiredToolProbeAttempts(first, second) {
	const firstStatus = classifyRequiredToolProbeResponse(first);
	if (firstStatus !== "weak_success") return firstStatus;
	if (!second) return "unknown";
	const secondStatus = classifyRequiredToolProbeResponse(second);
	return secondStatus === "weak_success" ? "unsupported" : secondStatus;
}

export function classifyRequiredToolProbeResponse(response) {
	if (response.ok) return requiredToolCallSupported(response.payload) ? "supported" : "weak_success";
	// Only request-shape validation failures after a successful paired control
	// are evidence of unsupported. Authentication, quota, contention, timeout,
	// routing, and exhausted server failures remain unknown.
	return response.status === 400 || response.status === 422 ? "unsupported" : "unknown";
}

function requiredToolProbeEffort(capabilities) {
	if (capabilities.support.kind === "known" || capabilities.support.kind === "partially_known") {
		for (const effort of compactionReasoningEffortOrder) {
			if (capabilities.support.efforts.includes(effort)) return effort;
		}
	}
	return "minimal";
}

function legacyRequiredToolFallback(previous) {
	if (typeof previous === "boolean") return { supported: previous, source: "legacy_boolean" };
	return previous?.fallback ?? { supported: false, source: "conservative_policy" };
}

function legacyPrefillFallback(previous) {
	if (typeof previous === "boolean") return { supported: previous, source: "legacy_boolean" };
	return previous?.fallback ?? { supported: false, source: "conservative_policy" };
}

export function legacyPrefillCapabilities(supported, source) {
	return {
		kind: "provider_matrix",
		version: prefillCapabilityVersion,
		providers: [],
		fallback: { supported, source },
	};
}

export function legacyRequiredToolCapabilities(supported, source) {
	return {
		kind: "provider_matrix",
		version: requiredToolCapabilityVersion,
		providers: [],
		fallback: { supported, source },
	};
}

async function probeCacheControlCapability(model, apiKey, limiter, timeoutMs, totals) {
	// OpenRouter currently accepts top-level cache_control on some models where
	// it is not documented to create a cache entry. Treat the live request as a
	// confirmation step for documented top-level automatic cache_control models,
	// not as proof that any 2xx response means caching works.
	if (!topLevelCacheControlCandidate(model)) {
		return false;
	}
	return probeCapability(apiKey, limiter, timeoutMs, providerCacheControlRequest(model), responseOk, totals);
}

async function probeCapability(apiKey, limiter, timeoutMs, requestBody, supported, totals) {
	const response = await postOpenRouter(apiKey, limiter, timeoutMs, requestBody, totals);
	if (!response.ok) {
		return false;
	}
	return supported(response.payload);
}

async function postOpenRouter(apiKey, limiter, timeoutMs, body, totals) {
	const headers = {
		"content-type": "application/json",
		accept: "application/json",
		...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
	};
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await limiter.wait();
		if (totals) totals.requests += 1;
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
			recordProbeUsage(totals, payload);
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

export function providerPrefillControlRequest(model, reasoning, provider) {
	return {
		model,
		messages: [
			{ role: "system", content: "Continue the participant's first-person narration or use the available tool when appropriate." },
			{ role: "user", content: "Continue briefly." },
		],
		stream: false,
		max_completion_tokens: probeMaxCompletionTokens,
		temperature: 0,
		tools: [capabilityProbeTool()],
		tool_choice: "auto",
		parallel_tool_calls: true,
		provider: { only: [provider], allow_fallbacks: false },
		...(reasoning ? { reasoning } : {}),
	};
}

export function providerPrefillRequest(model, reasoning, provider) {
	const control = providerPrefillControlRequest(model, reasoning, provider);
	return {
		...control,
		messages: [...control.messages, { role: "assistant", content: "I" }],
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

export function providerRequiredToolControlRequest(model, reasoning, provider) {
	return {
		model,
		messages: [{ role: "user", content: "Use the capability_probe tool now." }],
		stream: false,
		max_completion_tokens: probeMaxCompletionTokens,
		temperature: 0,
		tools: [capabilityProbeTool()],
		parallel_tool_calls: false,
		provider: { only: [provider], allow_fallbacks: false },
		...(reasoning ? { reasoning } : {}),
	};
}

export function providerRequiredToolCallRequest(model, reasoning, provider) {
	return {
		...providerRequiredToolControlRequest(model, reasoning, provider),
		tool_choice: "required",
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

export function classifyPrefillProbeResponse(response) {
	if (response.ok) return providerMessage(response.payload) === null ? "unknown" : "supported";
	return response.status === 400 || response.status === 422 ? "unsupported" : "unknown";
}

export function classifyPrefillProbePair(control, tested) {
	if (!control?.ok || providerMessage(control.payload) === null || !tested) return "unknown";
	return classifyPrefillProbeResponse(tested);
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

export function entriesForCurrentModels(entries, currentIds) {
	return [...entries.entries()].filter(([id]) => currentIds.has(id));
}

export async function writeGeneratedTable(filePath, entries) {
	await fs.writeFile(filePath, generatedTableText(entries));
}

export function generatedTableText(entries) {
	validateCapabilityEntries(entries, "generated output");
	const sorted = [...entries].sort(([left], [right]) => codeUnitCompare(left, right));
	const lines = [
		"export type GeneratedCompactionReasoningEffort = \"minimal\" | \"low\" | \"medium\" | \"high\" | \"xhigh\";",
		"",
		"export type GeneratedCompactionReasoningCapabilities = {",
		"\tsupport:",
		"\t\t| { kind: \"known\"; efforts: readonly GeneratedCompactionReasoningEffort[] }",
		"\t\t| { kind: \"partially_known\"; efforts: readonly GeneratedCompactionReasoningEffort[] }",
		"\t\t| { kind: \"unknown\" }",
		"\t\t| { kind: \"unsupported\" };",
		"\tmodelDefault:",
		"\t\t| { kind: \"absent\" }",
		"\t\t| { kind: \"provider_default\"; relativeOrder: \"below_minimal\" | \"above_xhigh\" | \"unknown\" }",
		"\t\t| { kind: \"explicit_effort\"; effort: GeneratedCompactionReasoningEffort };",
		"};",
		"",
		"export type GeneratedOpenRouterModelCapabilities = {",
		"\tprefill: GeneratedPrefillCapabilities;",
		"\tstructuredOutputs: boolean;",
		"\trequiredToolCalls: GeneratedRequiredToolCallCapabilities;",
		"\tdisabledReasoning: boolean;",
		"\tcacheControl: boolean;",
		"\tcompactionReasoning: GeneratedCompactionReasoningCapabilities;",
		"\tcontextLength?: number;",
		"};",
		"",
		"export type GeneratedPrefillCapabilities = {",
		"\tkind: \"provider_matrix\";",
		"\tversion: 2;",
		"\tproviders: readonly {",
		"\t\tprovider: string;",
		"\t\tproviderDefault: GeneratedRequiredToolCallObservation;",
		"\t\treasoningOff: GeneratedRequiredToolCallObservation;",
		"\t\treasoningOn:",
		"\t\t\t| (GeneratedRequiredToolCallObservation & { status: Exclude<GeneratedRequiredToolCallObservation[\"status\"], \"not_applicable\">; effort: GeneratedCompactionReasoningEffort })",
		"\t\t\t| (GeneratedRequiredToolCallObservation & { status: \"not_applicable\"; effort: null });",
		"\t}[];",
		"\tfallback: { supported: boolean; source: \"legacy_boolean\" | \"custom_provider_policy\" | \"conservative_policy\" };",
		"};",
		"",
		"export type GeneratedRequiredToolCallObservation = {",
		"\tstatus: \"supported\" | \"unsupported\" | \"unknown\" | \"not_applicable\";",
		"\tsource: \"probe\";",
		"};",
		"",
		"export type GeneratedRequiredToolCallProviderCapabilities = {",
		"\tprovider: string;",
		"\tproviderDefault: GeneratedRequiredToolCallObservation;",
		"\treasoningOff: GeneratedRequiredToolCallObservation;",
		"\treasoningOn:",
		"\t\t| (GeneratedRequiredToolCallObservation & { status: Exclude<GeneratedRequiredToolCallObservation[\"status\"], \"not_applicable\">; effort: GeneratedCompactionReasoningEffort })",
		"\t\t| (GeneratedRequiredToolCallObservation & { status: \"not_applicable\"; effort: null });",
		"};",
		"",
		"export type GeneratedRequiredToolCallCapabilities = {",
		"\tkind: \"provider_matrix\";",
		"\tversion: 2;",
		"\tproviders: readonly GeneratedRequiredToolCallProviderCapabilities[];",
		"\tfallback: { supported: boolean; source: \"legacy_boolean\" | \"custom_provider_policy\" | \"conservative_policy\" };",
		"};",
		"",
		"export type GeneratedOpenRouterModelCapabilityEntry = readonly [string, GeneratedOpenRouterModelCapabilities];",
		"",
		"export const generatedOpenRouterModelCapabilityEntries: readonly GeneratedOpenRouterModelCapabilityEntry[] = [",
		...sorted.map(([model, capabilities], index) => `\t${canonicalGeneratedJson([model, capabilities])}${index === sorted.length - 1 ? "" : ","}`),
		"];",
		"",
	];
	return lines.join("\n");
}

/** Stable across hosts regardless of their installed ICU locale data. */
function codeUnitCompare(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalGeneratedJson(value) {
	return JSON.stringify(canonicalGeneratedValue(value));
}

function canonicalGeneratedValue(value) {
	if (Array.isArray(value)) {
		return value.map(canonicalGeneratedValue);
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	return Object.fromEntries(Object.entries(value)
		.sort(([left], [right]) => codeUnitCompare(left, right))
		.map(([key, child]) => [key, canonicalGeneratedValue(child)]));
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

function uniqueStrings(value) {
	return [...new Set(stringArray(value).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function modelContextLengthForModel(model) {
	const contextLength = numberValue(model?.context_length ?? model?.contextLength);
	return contextLength === undefined ? undefined : Math.max(1, Math.floor(contextLength));
}

function numberValue(value) {
	const parsed = typeof value === "number" && Number.isFinite(value) ? value : undefined;
	return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
