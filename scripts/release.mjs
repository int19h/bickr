import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	assertChecks, assertCommit, buildDirectory, buildManifest, checksPath, migrationState,
	releasePlan, repoRoot, run, workerDeploymentMatches,
} from "./release-support.mjs";
import { verifyPublicRelease } from "./verify-release.mjs";

const { values } = parseArgs({ options: {
	environment: { type: "string" }, commit: { type: "string" },
	checks: { type: "string", default: checksPath },
	record: { type: "string" }, plan: { type: "boolean", default: false },
	"apply-migrations": { type: "boolean", default: false },
} });
const plan = releasePlan(values.environment, values.commit);
if (values.plan) {
	console.log(JSON.stringify(plan, null, 2));
} else {
	await release();
}

async function release() {
	assertCommit(plan.commit);
	const checks = JSON.parse(readFileSync(values.checks, "utf8"));
	assertChecks(checks, plan.commit, buildManifest());
	const startedAt = new Date().toISOString();
	const recordPath = resolve(values.record ?? join(repoRoot, ".wrangler/release", `${plan.environment}-${startedAt.replaceAll(":", "-")}.json`));
	const outputPath = `${recordPath}.wrangler.jsonl`;
	mkdirSync(dirname(recordPath), { recursive: true });
	// Exclusive creation avoids overwriting evidence from a previous attempt.
	writeFileSync(recordPath, "", { flag: "wx" });
	writeFileSync(outputPath, "", { flag: "wx" });
	const record = { kind: "release", schemaVersion: 1, status: "running", startedAt, ...plan, checks, steps: [] };
	const save = () => writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
	const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: plan.accountId, WRANGLER_OUTPUT_FILE_PATH: outputPath, CI: "true" };
	// The command's explicit config/environment is authoritative.
	delete env.CLOUDFLARE_ENV;
	const wrangler = (args, options = {}) => run(process.execPath, [join(repoRoot, "node_modules/wrangler/bin/wrangler.js"), ...args], { env, ...options });
	const step = (name, action) => {
		const entry = { name, status: "running", startedAt: new Date().toISOString() };
		record.steps.push(entry);
		save();
		const result = action();
		entry.status = "completed";
		entry.completedAt = new Date().toISOString();
		save();
		return result;
	};
	const localMigrations = readdirSync(join(repoRoot, "migrations")).filter((name) => name.endsWith(".sql")).sort();
	const readMigrations = () => {
		const output = JSON.parse(wrangler(["d1", "execute", "BICKR_D1", "--remote", ...plan.workers[0].config,
			"--command", "SELECT name FROM d1_migrations ORDER BY id LIMIT 10001", "--json"]));
		if (!Array.isArray(output) || output.length !== 1 || output[0].success !== true || !Array.isArray(output[0].results)) {
			throw new Error("Unexpected D1 migration response.");
		}
		const names = output[0].results.map((row) => row.name);
		if (names.length > 10000 || names.some((name) => typeof name !== "string")) throw new Error("Invalid or oversized migration history.");
		return migrationState(localMigrations, names);
	};
	try {
		save();
		for (const worker of plan.workers) {
			step(`${worker.name}: secret preflight`, () => {
				const secrets = JSON.parse(wrangler(["secret", "list", ...worker.config]));
				if (!secrets.some((secret) => secret.name === "INTERNAL_SERVICE_SECRET")) throw new Error(`${worker.name} is missing INTERNAL_SERVICE_SECRET.`);
			});
		}
		record.migrationsBefore = step("migration preflight", readMigrations);
		save();
		if (record.migrationsBefore.pending.length) {
			if (!values["apply-migrations"]) throw new Error(`Pending migrations: ${record.migrationsBefore.pending.join(", ")}. Review them, then add --apply-migrations.`);
			step("apply migrations", () => wrangler(plan.migrations, { stdio: "inherit" }));
		}
		record.migrationsAfter = step("verify migrations", readMigrations);
		if (record.migrationsAfter.pending.length) throw new Error("Migrations remain pending; no code was deployed.");
		for (const worker of plan.workers) {
			assertCommit(plan.commit);
			step(`${worker.name}: deploy`, () => wrangler(["deploy", ...worker.config, "--tag", plan.commit, "--message", `Release ${plan.commit}`], { stdio: "inherit" }));
		}
		assertCommit(plan.commit);
		assertChecks(checks, plan.commit, buildManifest());
		step("Pages: deploy", () => wrangler(plan.pages, { cwd: join(repoRoot, "apps/web"), stdio: "inherit" }));
		const outputs = readFileSync(outputPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		record.deployments = outputs.filter((entry) => entry.type === "deploy" || entry.type === "pages-deploy-detailed");
		for (const worker of plan.workers) {
			const deployed = record.deployments.find((entry) => entry.type === "deploy" && entry.worker_name === worker.name);
			if (!deployed?.version_id) throw new Error(`No version ID recorded for ${worker.name}.`);
			step(`${worker.name}: verify version`, () => {
				const active = JSON.parse(wrangler(["deployments", "status", ...worker.config, "--json"]));
				if (!workerDeploymentMatches(active, deployed.version_id)) throw new Error(`${worker.name} changed during release.`);
			});
		}
		const pages = record.deployments.find((entry) => entry.type === "pages-deploy-detailed");
		if (pages?.deployment_trigger?.metadata?.commit_hash !== plan.commit || pages?.environment !== (plan.environment === "test" ? "preview" : "production")) {
			throw new Error("Pages deployment source or environment does not match the release.");
		}
		await verifyPublicRelease(plan, checks, readFileSync(join(buildDirectory, "index.html"), "utf8"));
		record.status = "verified";
		record.verifiedAt = new Date().toISOString();
	} catch (error) {
		// A failed upload can leave changes in Cloudflare. Keep the started step and raw
		// Wrangler operation records. Do not retry or roll back automatically.
		record.status = "failed";
		record.failedAt = new Date().toISOString();
		throw error;
	} finally {
		save();
		console.log(`Release record: ${recordPath}`);
	}
}
