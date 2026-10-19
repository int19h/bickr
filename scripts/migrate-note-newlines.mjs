import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releasePlan, repoRoot } from "./release-support.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const terminal = new Set(["applied", "already_applied", "cleared"]);

export function fleetQuery(cursor = "", limit = 100) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Fleet page size must be 1 through 100.");
	return `SELECT bot_id FROM bots_index WHERE bot_id > '${cursor.replaceAll("'", "''")}' AND deleted_at IS NULL AND lifecycle_state IN ('active', 'pending') ORDER BY bot_id LIMIT ${limit}`;
}

export function migrationPlan(environment, proxyOrigin) {
	const plan = releasePlan(environment, "0".repeat(40));
	if (proxyOrigin !== undefined) {
		const url = new URL(proxyOrigin);
		if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
			url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
			throw new Error("--proxy-origin must name a loopback HTTP origin without a path or credentials.");
		}
		plan.origin = url.origin;
	}
	return plan;
}

export function privateReportPath(path) {
	const absolute = resolve(path);
	const parent = realpathSync(dirname(absolute));
	if (!parent.startsWith("/build/") || parent.includes("/worktrees/")) {
		throw new Error("Report files must use an existing private directory under /build, outside worktrees.");
	}
	if (existsSync(absolute)) {
		const stat = lstatSync(absolute);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
			throw new Error("Existing report files must be regular files with mode 0600.");
		}
	}
	return absolute;
}

// Write and sync the backup before a mutation. Rename keeps interrupted progress
// updates from leaving a partly written report.
export function saveReport(path, value, create = false) {
	const json = `${JSON.stringify(value, null, 2)}\n`;
	const temporary = create ? path : `${path}.next`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, json);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	if (!create) renameSync(temporary, path);
	const directory = openSync(dirname(path), "r");
	try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function assertManifest(manifest, environment) {
	if (manifest?.kind !== "note-newlines-preview" || manifest.schemaVersion !== 1 || manifest.environment !== environment || !Array.isArray(manifest.bots)) {
		throw new Error("The preview manifest does not match this environment or schema.");
	}
	const ids = new Set();
	for (const bot of manifest.bots) {
		if (typeof bot.botId !== "string" || ids.has(bot.botId)) throw new Error("The manifest contains an invalid bot ID.");
		ids.add(bot.botId);
		if (bot.migration?.kind === "ready") assertReady(bot.migration);
	}
}

function assertReady(migration) {
	if (migration.schemaVersion !== 1 || typeof migration.digest !== "string" || !migration.digest ||
		!Array.isArray(migration.notes) || !Array.isArray(migration.messages) ||
		!Array.isArray(migration.ambiguousNotes) || !Array.isArray(migration.ambiguousMessages)) {
		throw new Error("The runtime returned an invalid migration snapshot.");
	}
}

export function classifyFailure(status, payload) {
	const cause = payload?.details?.noteMigrationCause;
	if (status === 409) return { kind: cause === "snapshot_changed" ? "snapshot_changed" : cause === "pending_tool" ? "pending_tool" : "busy", status };
	return { kind: "failed", status };
}

export function createProxy(plan, secret, fetcher = fetch, timeout = 30_000) {
	return async (botId, body) => {
		try {
			const response = await fetcher(`${plan.origin}/api/__test__/service-proxy`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-test-auth-secret": secret,
					...(plan.environment === "test" ? { cookie: "bickr_test_environment=1" } : {}) },
				body: JSON.stringify({ service: "agent-runtime", method: "POST",
					path: `/bots/${encodeURIComponent(botId)}/notes/newlines-migration`,
					headers: { "x-bickr-scheduler": "1" }, body }),
				signal: AbortSignal.timeout(timeout), redirect: "error",
			});
			const payload = await response.json();
			if (!response.ok || payload?.ok === false) return classifyFailure(response.status, payload);
			const migration = payload?.data?.migration;
			if (!migration || !["ready", "applied", "already_applied", "cleared"].includes(migration.kind)) return { kind: "invalid_response" };
			if (migration.kind === "ready") assertReady(migration);
			return migration;
		} catch {
			// Do not include response text, credentials, or private note prose in logs.
			return { kind: "request_uncertain" };
		}
	};
}

export async function applyManifest(manifest, report, proxy, persist) {
	for (const bot of manifest.bots) {
		if (bot.migration?.kind !== "ready") {
			report.results[bot.botId] ??= bot.migration;
			await persist(report);
			continue;
		}
		if (terminal.has(report.results[bot.botId]?.kind)) continue;
		// Always resolve a previous uncertain request through the durable marker.
		const current = await proxy(bot.botId, { mode: "inspect" });
		let result = current;
		if (current.kind === "ready") {
			if (current.digest !== bot.migration.digest) result = { kind: "snapshot_changed" };
			else {
				result = await proxy(bot.botId, { mode: "apply", expectedDigest: bot.migration.digest });
				if (result.kind === "request_uncertain") {
					const durable = await proxy(bot.botId, { mode: "inspect" });
					if (terminal.has(durable.kind)) result = durable;
				}
			}
		}
		report.results[bot.botId] = result;
		await persist(report);
	}
	return report;
}

function fleetPage(plan, cursor) {
	const { TEST_AUTH_SECRET: _secret, ...wranglerEnvironment } = process.env;
	const result = spawnSync(process.execPath, [resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js"),
		"d1", "execute", "BICKR_D1", "--remote", "--json", "--command", fleetQuery(cursor), ...plan.workers[0].config], {
		cwd: repoRoot, env: { ...wranglerEnvironment, CLOUDFLARE_ACCOUNT_ID: plan.accountId },
		encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) throw new Error("The bounded fleet query failed. No query output was printed.");
	const payload = JSON.parse(result.stdout);
	if (!Array.isArray(payload) || payload.length !== 1 || payload[0].success !== true || !Array.isArray(payload[0].results)) {
		throw new Error("Wrangler returned an invalid fleet page.");
	}
	const ids = payload[0].results.map((row) => row.bot_id);
	if (ids.length > 100 || ids.some((id, i) => typeof id !== "string" || id <= (ids[i - 1] ?? cursor))) {
		throw new Error("Wrangler returned an invalid fleet cursor.");
	}
	return ids;
}

export async function main(args = process.argv.slice(2)) {
	const { values } = parseArgs({ args, options: { environment: { type: "string" }, report: { type: "string" },
		apply: { type: "boolean", default: false }, manifest: { type: "string" }, "proxy-origin": { type: "string" } }, strict: true });
	const plan = migrationPlan(values.environment, values["proxy-origin"]);
	if (!values.report) throw new Error("--report is required.");
	const path = privateReportPath(values.report);
	const secret = process.env.TEST_AUTH_SECRET?.trim();
	if (!secret) throw new Error("Set TEST_AUTH_SECRET in the environment before this command.");
	const proxy = createProxy(plan, secret);
	let report;
	if (values.apply) {
		if (!values.manifest) throw new Error("--apply requires --manifest from a preview.");
		const source = privateReportPath(values.manifest);
		if (source === path) throw new Error("The apply report must differ from the preview backup.");
		const original = readFileSync(source, "utf8");
		const manifest = JSON.parse(original);
		assertManifest(manifest, values.environment);
		if (manifest.proxyOrigin !== plan.origin) throw new Error("The proxy origin differs from the preview backup.");
		if (!manifest.complete) throw new Error("Finish the preview before applying its manifest.");
		const sourceDigest = digest(original);
		report = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {
			kind: "note-newlines-apply", schemaVersion: 1, environment: values.environment, proxyOrigin: plan.origin, sourceDigest, results: {},
		};
		if (report.kind !== "note-newlines-apply" || report.schemaVersion !== 1 || report.environment !== values.environment || report.sourceDigest !== sourceDigest || report.proxyOrigin !== plan.origin || !report.results) {
			throw new Error("The apply report does not match the preview backup or environment.");
		}
		if (!existsSync(path)) saveReport(path, report, true);
		await applyManifest(manifest, report, proxy, (value) => saveReport(path, value));
	} else {
		if (values.manifest) throw new Error("--manifest requires --apply.");
		if (existsSync(path)) throw new Error("Use a new preview report path to preserve earlier backups.");
		report = { kind: "note-newlines-preview", schemaVersion: 1, environment: values.environment,
			proxyOrigin: plan.origin, createdAt: new Date().toISOString(), complete: false, bots: [] };
		saveReport(path, report, true);
		let cursor = "";
		while (true) {
			const ids = fleetPage(plan, cursor);
			for (const botId of ids) {
				report.bots.push({ botId, migration: await proxy(botId, { mode: "inspect" }) });
				saveReport(path, report);
			}
			if (ids.length < 100) break;
			cursor = ids.at(-1);
		}
		report.complete = true;
		saveReport(path, report);
	}
	const counts = {};
	for (const result of values.apply ? Object.values(report.results) : report.bots.map((bot) => bot.migration)) {
		counts[result.kind] = (counts[result.kind] ?? 0) + 1;
	}
	process.stdout.write(`${JSON.stringify({ environment: values.environment, mode: values.apply ? "apply" : "preview", counts })}\n`);
	if (Object.keys(counts).some((kind) => !terminal.has(kind) && kind !== "ready")) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(() => { process.stderr.write("Migration stopped. Keep the private reports and inspect the command arguments or runtime status.\n"); process.exitCode = 1; });
}
