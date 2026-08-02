import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const sourceName = `bickr-do-xfer-source-${suffix}`;
const targetName = `bickr-do-xfer-target-${suffix}`;
const workDir = await mkdtemp(join(tmpdir(), 'bickr-do-transfer-'));
const sourceConfig = join(workDir, 'source.jsonc');
const targetConfig = join(workDir, 'target.jsonc');
const workerPath = join(workDir, 'worker.mjs');
const tombstoneWorkerPath = join(workDir, 'tombstone-worker.mjs');
const marker = `preserved-${suffix}`;

await writeFile(
	workerPath,
	`
export class TransferProbe {
	constructor(state) {
		this.state = state;
		state.blockConcurrencyWhile(async () => {
			state.storage.sql.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)");
		});
	}

	async fetch(request) {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/seed" && request.method === "POST") {
			const { value } = await request.json();
			this.state.storage.sql.exec("INSERT OR REPLACE INTO probe (id, value) VALUES (1, ?)", value);
			await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
			return Response.json({ ok: true });
		}
		if (pathname === "/read" && request.method === "GET") {
			const row = this.state.storage.sql.exec("SELECT value FROM probe WHERE id = 1").toArray()[0] ?? null;
			return Response.json({
				alarmScheduled: (await this.state.storage.getAlarm()) !== null,
				objectId: this.state.id.toString(),
				value: row?.value ?? null,
			});
		}
		return new Response("Not found", { status: 404 });
	}

	async alarm() {
		this.state.storage.sql.exec("UPDATE probe SET value = value || '-alarm' WHERE id = 1");
	}
}

export default {
	async fetch(request, env) {
		if (new URL(request.url).pathname === "/health") {
			return Response.json({ ok: true });
		}
		return env.PROBE.getByName("launch").fetch(request);
	},
};
`,
	'utf8',
);
await writeFile(
	tombstoneWorkerPath,
	`
export default {
	async fetch() {
		return new Response("Lifecycle tombstone only", { status: 503 });
	},
};
`,
	'utf8',
);

function liveExport() {
	return { type: 'durable-object', storage: 'sqlite' };
}

function config(name, exportEntry, binding, main = workerPath) {
	return {
		$schema: fileURLToPath(new URL('../node_modules/wrangler/config-schema.json', import.meta.url)),
		name,
		main,
		compatibility_date: '2026-08-02',
		workers_dev: true,
		preview_urls: false,
		exports: { TransferProbe: exportEntry },
		...(binding ? { durable_objects: { bindings: [binding] } } : {}),
	};
}

async function writeConfig(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

async function wrangler(args, { bestEffort = false } = {}) {
	const child = spawn(process.execPath, [wranglerBin, ...args], {
		cwd: workDir,
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding('utf8');
		stream.on('data', (chunk) => {
			output += chunk;
			process.stdout.write(chunk);
		});
	}
	const exitCode = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	if (exitCode !== 0 && !bestEffort) {
		throw new Error(`Wrangler exited with status ${exitCode}.`);
	}
	return { exitCode, output };
}

async function deploy(configPath) {
	const result = await wrangler(['deploy', '--config', configPath]);
	const url = result.output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
	return url;
}

async function requestJson(url, path, init) {
	let lastFailure = 'No response';
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const response = await fetch(`${url}${path}`, init);
		const text = await response.text();
		if (response.ok) {
			try {
				return JSON.parse(text);
			} catch {
				lastFailure = `returned non-JSON content: ${text.slice(0, 120)}`;
			}
		} else {
			lastFailure = `returned ${response.status}: ${text.slice(0, 120)}`;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`${url}${path} ${lastFailure}`);
}

async function waitForProbe(url, predicate, description) {
	let lastBody;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		lastBody = await requestJson(url, '/read');
		if (predicate(lastBody)) {
			return lastBody;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`${description}; last response: ${JSON.stringify(lastBody)}`);
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

let sourceUrl;
let targetUrl;
try {
	console.log(`Rehearsal Workers: ${sourceName}, ${targetName}`);

	// 1. Create the source namespace and seed SQLite data plus an alarm.
	await writeConfig(
		sourceConfig,
		config(sourceName, liveExport(), {
			name: 'PROBE',
			class_name: 'TransferProbe',
		}),
	);
	sourceUrl = await deploy(sourceConfig);
	assert(sourceUrl, 'Wrangler did not report the source workers.dev URL.');
	await requestJson(sourceUrl, '/seed', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ value: marker }),
	});
	const original = await requestJson(sourceUrl, '/read');
	assert(original.value === marker && original.alarmScheduled, 'The source probe was not seeded correctly.');

	// 2. Target declares the pending transfer without a self binding.
	await writeConfig(
		targetConfig,
		config(targetName, {
			type: 'durable-object',
			state: 'expecting-transfer',
			storage: 'sqlite',
			transfer_from: sourceName,
		}),
	);
	targetUrl = await deploy(targetConfig);
	assert(targetUrl, 'Wrangler did not report the target workers.dev URL.');
	await requestJson(targetUrl, '/health');

	// 3. The source deployment commits the transfer and routes its old binding
	// through the target namespace during the rollout window.
	await writeConfig(
		sourceConfig,
		config(
			sourceName,
			{
				type: 'durable-object',
				state: 'transferred',
				transferred_to: targetName,
			},
			{
				name: 'PROBE',
				class_name: 'TransferProbe',
				script_name: targetName,
			},
		),
	);
	await deploy(sourceConfig);
	const throughSource = await waitForProbe(
		sourceUrl,
		(value) => value.objectId === original.objectId && value.value === marker,
		'The source binding did not converge on the transferred namespace',
	);
	assert(
		throughSource.objectId === original.objectId && throughSource.value === marker,
		'The committed transfer changed the object identity or data.',
	);

	// 4. Target becomes the live owner with a self binding.
	await writeConfig(
		targetConfig,
		config(targetName, liveExport(), {
			name: 'PROBE',
			class_name: 'TransferProbe',
		}),
	);
	await deploy(targetConfig);
	const forward = await waitForProbe(
		targetUrl,
		(value) => value.objectId === original.objectId && value.value === marker && value.alarmScheduled,
		'The target did not converge on the transferred namespace',
	);
	assert(
		forward.objectId === original.objectId && forward.value === marker && forward.alarmScheduled,
		'Forward transfer did not preserve identity, SQLite data, and alarm state.',
	);

	// Re-deploying the source's old live declaration after transfer creates a
	// fresh empty namespace. This is the production rollback hazard we need the
	// runbook to recognize and remove before a reverse transfer.
	await writeConfig(
		sourceConfig,
		config(sourceName, liveExport(), {
			name: 'PROBE',
			class_name: 'TransferProbe',
		}),
	);
	await deploy(sourceConfig);
	const recreated = await waitForProbe(
		sourceUrl,
		(value) => value.objectId !== original.objectId && value.value === null,
		'The source did not converge on its recreated empty namespace',
	);
	assert(
		recreated.objectId !== original.objectId && recreated.value === null,
		'The source recreation behavior did not match the expected empty namespace hazard.',
	);

	await writeConfig(
		sourceConfig,
		config(
			sourceName,
			{
				type: 'durable-object',
				state: 'deleted',
			},
			undefined,
			tombstoneWorkerPath,
		),
	);
	await deploy(sourceConfig);

	// Reverse the transfer as the supported rollback: source expects, target
	// commits, then source restores its live declaration and self binding.
	await writeConfig(
		sourceConfig,
		config(sourceName, {
			type: 'durable-object',
			state: 'expecting-transfer',
			storage: 'sqlite',
			transfer_from: targetName,
		}),
	);
	await deploy(sourceConfig);

	await writeConfig(
		targetConfig,
		config(
			targetName,
			{
				type: 'durable-object',
				state: 'transferred',
				transferred_to: sourceName,
			},
			{
				name: 'PROBE',
				class_name: 'TransferProbe',
				script_name: sourceName,
			},
		),
	);
	await deploy(targetConfig);

	await writeConfig(
		sourceConfig,
		config(sourceName, liveExport(), {
			name: 'PROBE',
			class_name: 'TransferProbe',
		}),
	);
	await deploy(sourceConfig);
	const reversed = await waitForProbe(
		sourceUrl,
		(value) => value.objectId === original.objectId && value.value === marker && value.alarmScheduled,
		'The source did not converge on the reverse-transferred namespace',
	);
	assert(
		reversed.objectId === original.objectId && reversed.value === marker && reversed.alarmScheduled,
		'Reverse transfer did not restore the original namespace intact.',
	);

	console.log(
		JSON.stringify({
			event: 'do_transfer_rehearsal_passed',
			forwardPreserved: ['object_id', 'sqlite_data', 'alarm'],
			reversePreserved: ['object_id', 'sqlite_data', 'alarm'],
			sourceRecreationCreatedEmptyNamespace: true,
		}),
	);
} finally {
	// Every name includes a random suffix and exists solely for this rehearsal.
	// Remove the target first so a reverse-transfer external binding cannot block
	// deletion of the source namespace, then tombstone and remove the source.
	await wrangler(['delete', targetName, '--force'], { bestEffort: true });
	await writeConfig(sourceConfig, config(sourceName, { type: 'durable-object', state: 'deleted' }, undefined, tombstoneWorkerPath));
	await wrangler(['deploy', '--config', sourceConfig], { bestEffort: true });
	await wrangler(['delete', sourceName, '--force'], { bestEffort: true });
}
