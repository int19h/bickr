import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const accountId = "fe55e0fbc7fbba2097b5f1e31957470f";
export const checksPath = join(repoRoot, ".wrangler/release/checks.json");
export const buildDirectory = join(repoRoot, "apps/web/dist/client");

export function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? result.signal}).`);
	return result.stdout?.trim() ?? "";
}

export function assertCommit(commit) {
	if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("--commit must be a full Git commit SHA.");
	if (run("git", ["rev-parse", "HEAD"]) !== commit) throw new Error("HEAD does not match --commit.");
	if (run("git", ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("The release worktree must be clean.");
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function buildManifest(directory = buildDirectory) {
	const files = {};
	function visit(relative) {
		for (const name of readdirSync(join(directory, relative)).sort()) {
			const path = join(relative, name);
			const stat = lstatSync(join(directory, path));
			if (stat.isSymbolicLink()) throw new Error(`Build contains a symbolic link: ${path}`);
			if (stat.isDirectory()) visit(path);
			else files[path] = sha256(readFileSync(join(directory, path)));
		}
	}
	visit("");
	if (!files["index.html"]) throw new Error("The Pages build has no index.html.");
	return files;
}

export function assertChecks(checks, commit, manifest) {
	if (checks.kind !== "release-checks" || checks.schemaVersion !== 1 || checks.status !== "passed" || checks.commit !== commit) {
		throw new Error("Run npm run check:release for this exact commit first.");
	}
	if (checks.lockfileSha256 !== sha256(readFileSync(join(repoRoot, "package-lock.json")))) {
		throw new Error("The dependency lockfile differs from the checked version.");
	}
	if (JSON.stringify(checks.build) !== JSON.stringify(manifest)) throw new Error("The Pages build differs from the checked build.");
}

export function releasePlan(environment, commit) {
	if (environment !== "test" && environment !== "production") throw new Error("--environment must be test or production.");
	if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("--commit must be a full Git commit SHA.");
	const test = environment === "test";
	const workers = ["forum-coordinator", "agent-runtime"].map((name) => ({
		name: `bickr-${name}${test ? "-test" : ""}`,
		config: [`--config`, `workers/${name}/wrangler${test ? "" : ".deploy"}.jsonc`, "--env", test ? "test" : ""],
	}));
	return {
		environment, commit, accountId,
		origin: test ? "https://test.bickr.social" : "https://bickr.social",
		workers,
		migrations: ["d1", "migrations", "apply", "BICKR_D1", "--remote", ...workers[0].config],
		pages: ["pages", "deploy", "dist/client", "--project-name=bickr", `--branch=${test ? "test" : "main"}`,
			`--commit-hash=${commit}`, "--commit-dirty=false", `--commit-message=Release ${commit}`],
	};
}

export function migrationState(local, remote) {
	const applied = new Set(remote);
	const known = new Set(local);
	const unknown = remote.filter((name) => !known.has(name));
	if (unknown.length) throw new Error(`Remote migrations are absent from this commit: ${unknown.join(", ")}`);
	return { applied: remote, pending: local.filter((name) => !applied.has(name)) };
}

export function workerDeploymentMatches(deployment, versionId) {
	return deployment.versions?.length === 1 && deployment.versions[0].version_id === versionId && deployment.versions[0].percentage === 100;
}
