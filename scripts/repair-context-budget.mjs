#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const legacyContextWindowTokens = 16_000;
const botKeyPrefix = "v1:bot:";
const maxParallelKvReads = 8;
const maxSqlIdsPerChunk = 50;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const wranglerBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

const envConfigs = {
	test: {
		kvNamespaceId: "f153e4189e40485488cbbe0ca4ba91eb",
		d1Database: "BICKR_D1",
		d1Config: "workers/forum-coordinator/wrangler.jsonc",
		d1Env: "test",
	},
};

const options = parseArgs(process.argv.slice(2));
const config = {
	...(envConfigs[options.env] ?? {}),
	...definedValues({
		kvNamespaceId: options.kvNamespaceId,
		d1Database: options.d1Database,
		d1Config: options.d1Config,
		d1Env: options.d1Env,
	}),
};

if (!config.kvNamespaceId || !config.d1Database || !config.d1Config) {
	throw new Error(`Unknown or incomplete environment "${options.env}". Pass --kv-namespace-id, --d1-database, and --d1-config.`);
}

const beforeD1 = await d1ContextWindowSummary();
const keys = await listBotKeys();
console.log(`Scanning ${keys.length} participant profiles in ${options.env} KV.`);

let tempDir;
try {
	if (!options.dryRun) {
		tempDir = await mkdtemp(path.join(tmpdir(), "bickr-context-budget-"));
	}
	const repairs = await mapLimit(keys, maxParallelKvReads, (key) => repairBotKey(key, tempDir));
	const kvRepairs = repairs.filter((repair) => repair.repairedLegacyOverride);
	const sourceUnsetIds = repairs
		.filter((repair) => repair.botId && repair.contextWindowTokens === undefined)
		.map((repair) => repair.botId);
	const sourceExplicitByValue = groupExplicitContextWindowTokens(repairs);
	const desiredRuntimeContext = desiredRuntimeContextByBotId({ sourceUnsetIds, sourceExplicitByValue });

	console.log(`KV profiles with legacy ${legacyContextWindowTokens} override: ${kvRepairs.length}.`);
	if (kvRepairs.length > 0) {
		console.log(`Unset override for: ${kvRepairs.map((repair) => repair.botId).join(", ")}`);
	}

	const d1Changes =
		options.dryRun ?
			await countRuntimeIndexChanges(desiredRuntimeContext)
		:	await syncRuntimeIndex({ sourceUnsetIds, sourceExplicitByValue });
	const afterD1 = options.dryRun ? beforeD1 : await d1ContextWindowSummary();

	console.log(`D1 context budget summary before: ${formatSummary(beforeD1)}`);
	console.log(`D1 context budget summary after: ${formatSummary(afterD1)}`);
	console.log(`${options.dryRun ? "Would update" : "Updated"} ${kvRepairs.length} KV profile(s) and ${d1Changes} D1 runtime row(s).`);
} finally {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function parseArgs(args) {
	const parsed = { env: "test", dryRun: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--dry-run") {
			parsed.dryRun = true;
			continue;
		}
		const next = args[index + 1];
		if (next === undefined) {
			throw new Error(`Missing value for ${arg}.`);
		}
		switch (arg) {
			case "--env":
				parsed.env = next;
				break;
			case "--kv-namespace-id":
				parsed.kvNamespaceId = next;
				break;
			case "--d1-database":
				parsed.d1Database = next;
				break;
			case "--d1-config":
				parsed.d1Config = next;
				break;
			case "--d1-env":
				parsed.d1Env = next;
				break;
			default:
				throw new Error(`Unknown argument ${arg}.`);
		}
		index += 1;
	}
	return parsed;
}

function definedValues(record) {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

async function listBotKeys() {
	const output = await wranglerJson([
		"kv",
		"key",
		"list",
		"--namespace-id",
		config.kvNamespaceId,
		"--remote",
		"--prefix",
		botKeyPrefix,
	], "list bot KV keys");
	if (!Array.isArray(output)) {
		throw new Error("Wrangler returned an unexpected KV key list shape.");
	}
	return output.map((item) => item?.name).filter((name) => typeof name === "string");
}

async function repairBotKey(key, tempDir) {
	const text = await wranglerText([
		"kv",
		"key",
		"get",
		key,
		"--namespace-id",
		config.kvNamespaceId,
		"--remote",
		"--text",
	], `read ${key}`);
	const bot = JSON.parse(text);
	const botId = typeof bot?.id === "string" ? bot.id : key.slice(botKeyPrefix.length);
	const tickSettings = isRecord(bot?.tickSettings) ? bot.tickSettings : undefined;
	const contextWindowTokens =
		typeof tickSettings?.contextWindowTokens === "number" ?
			tickSettings.contextWindowTokens
		:	undefined;
	if (contextWindowTokens !== legacyContextWindowTokens) {
		return { botId, contextWindowTokens, repairedLegacyOverride: false };
	}

	const repaired = {
		...bot,
		tickSettings: {
			...tickSettings,
		},
	};
	delete repaired.tickSettings.contextWindowTokens;

	if (!options.dryRun) {
		const tempFile = path.join(tempDir, `${encodeURIComponent(key)}.json`);
		await writeFile(tempFile, JSON.stringify(repaired), "utf8");
		await wranglerText([
			"kv",
			"key",
			"put",
			key,
			"--namespace-id",
			config.kvNamespaceId,
			"--remote",
			"--path",
			tempFile,
		], `write repaired ${key}`);
	}

	return { botId, contextWindowTokens: undefined, repairedLegacyOverride: true };
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function groupExplicitContextWindowTokens(repairs) {
	const groups = new Map();
	for (const repair of repairs) {
		if (!repair.botId || repair.contextWindowTokens === undefined) {
			continue;
		}
		const tokens = Math.max(1, Math.floor(repair.contextWindowTokens));
		const ids = groups.get(tokens) ?? [];
		ids.push(repair.botId);
		groups.set(tokens, ids);
	}
	return groups;
}

function desiredRuntimeContextByBotId({ sourceUnsetIds, sourceExplicitByValue }) {
	const desired = new Map();
	for (const botId of sourceUnsetIds) {
		desired.set(botId, null);
	}
	for (const [tokens, botIds] of sourceExplicitByValue.entries()) {
		for (const botId of botIds) {
			desired.set(botId, tokens);
		}
	}
	return desired;
}

async function countRuntimeIndexChanges(desiredRuntimeContext) {
	const output = await d1Execute(
		`SELECT bot_id AS botId, context_window_tokens AS contextWindowTokens
		 FROM bot_runtime_index`,
	);
	const rows = output[0]?.results ?? [];
	return rows.filter((row) => {
		if (typeof row.botId !== "string" || !desiredRuntimeContext.has(row.botId)) {
			return false;
		}
		return desiredRuntimeContext.get(row.botId) !== (row.contextWindowTokens ?? null);
	}).length;
}

async function syncRuntimeIndex({ sourceUnsetIds, sourceExplicitByValue }) {
	let changes = 0;
	for (const ids of chunks(sourceUnsetIds, maxSqlIdsPerChunk)) {
		changes += await d1ExecuteChanges(
			`UPDATE bot_runtime_index
			 SET context_window_tokens = NULL
			 WHERE context_window_tokens IS NOT NULL
			   AND bot_id IN (${ids.map(sqlString).join(", ")})`,
		);
	}
	for (const [tokens, idsForValue] of sourceExplicitByValue.entries()) {
		for (const ids of chunks(idsForValue, maxSqlIdsPerChunk)) {
			changes += await d1ExecuteChanges(
				`UPDATE bot_runtime_index
				 SET context_window_tokens = ${tokens}
				 WHERE (context_window_tokens IS NULL OR context_window_tokens != ${tokens})
				   AND bot_id IN (${ids.map(sqlString).join(", ")})`,
			);
		}
	}
	return changes;
}

async function d1ContextWindowSummary() {
	const output = await d1Execute(
		`SELECT
			COALESCE(CAST(context_window_tokens AS TEXT), '<unset>') AS contextWindowTokens,
			COUNT(*) AS count
		 FROM bot_runtime_index
		 GROUP BY context_window_tokens
		 ORDER BY context_window_tokens`,
	);
	return output[0]?.results ?? [];
}

async function d1ExecuteChanges(command) {
	const output = await d1Execute(command);
	return Number(output[0]?.meta?.changes ?? 0);
}

async function d1Execute(command) {
	return wranglerJson([
		"d1",
		"execute",
		config.d1Database,
		"--remote",
		"--config",
		config.d1Config,
		...(config.d1Env ? ["--env", config.d1Env] : []),
		"--json",
		"--command",
		command,
	], "execute D1 SQL");
}

function sqlString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function chunks(values, size) {
	const result = [];
	for (let index = 0; index < values.length; index += size) {
		result.push(values.slice(index, index + size));
	}
	return result;
}

function formatSummary(rows) {
	return rows.map((row) => `${row.contextWindowTokens}:${row.count}`).join(", ") || "<empty>";
}

async function mapLimit(values, limit, callback) {
	const results = new Array(values.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= values.length) {
				return;
			}
			results[index] = await callback(values[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function wranglerJson(args, operation) {
	const text = await wranglerText(args, operation);
	return JSON.parse(text);
}

async function wranglerText(args, operation) {
	return retry(operation, () => execWrangler(args));
}

async function retry(operation, run) {
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return await run();
		} catch (error) {
			lastError = error;
			if (attempt === 3) {
				break;
			}
			await delay(1_000 * attempt);
		}
	}
	throw new Error(`${operation} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function execWrangler(args) {
	return new Promise((resolve, reject) => {
		execFile(wranglerBin, args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
				return;
			}
			resolve(stdout.trim());
		});
	});
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
