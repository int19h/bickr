import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertChecks, migrationState, releasePlan, repoRoot, sha256, workerDeploymentMatches } from "./release-support.mjs";

const commit = "a".repeat(40);

describe("release environment selection", () => {
	it("requires both a named environment and an exact commit", () => {
		expect(() => releasePlan(undefined, commit)).toThrow();
		expect(() => releasePlan("staging", commit)).toThrow();
		expect(() => releasePlan("test", "main")).toThrow();
	});

	it("uses isolated test Workers and the Pages test branch", () => {
		const plan = releasePlan("test", commit);
		expect(plan.workers.every((worker) => worker.name.endsWith("-test"))).toBe(true);
		expect(plan.workers.every((worker) => worker.config.at(-1) === "test")).toBe(true);
		expect(plan.pages).toContain("--branch=test");
		expect(plan.pages).toContain(`--commit-hash=${commit}`);
		expect(plan.pages).toContain("--commit-dirty=false");
		expect(plan.migrations).toContain("--remote");
	});

	it("uses production configs and an explicit main Pages branch", () => {
		const plan = releasePlan("production", commit);
		expect(plan.workers.every((worker) => worker.config[3].endsWith("wrangler.deploy.jsonc"))).toBe(true);
		expect(plan.workers.every((worker) => worker.config.at(-1) === "")).toBe(true);
		expect(plan.pages).toContain("--branch=main");
		expect(plan.origin).toBe("https://bickr.social");
	});

	it.each(["test", "production"])("runs %s custom builds from each Worker's directory", (environment) => {
		const plan = releasePlan(environment, commit);
		for (const worker of plan.workers) {
			const cwd = worker.config[worker.config.indexOf("--cwd") + 1];
			const config = worker.config[worker.config.indexOf("--config") + 1];
			expect(worker.config).toContain("--cwd");
			expect(isAbsolute(cwd)).toBe(true);
			expect(isAbsolute(config)).toBe(true);
			expect(cwd).toBe(dirname(config));
		}
		expect(plan.migrations).toEqual(expect.arrayContaining(plan.workers[0].config));
	});
});

describe("release evidence", () => {
	const manifest = { "index.html": "checked-output" };
	const checks = { kind: "release-checks", schemaVersion: 1, status: "passed", commit,
		lockfileSha256: sha256(readFileSync(join(repoRoot, "package-lock.json"))), build: manifest };

	it("accepts only checks for the same commit, lockfile, and build", () => {
		expect(() => assertChecks(checks, commit, manifest)).not.toThrow();
		expect(() => assertChecks({ ...checks, commit: "b".repeat(40) }, commit, manifest)).toThrow();
		expect(() => assertChecks({ ...checks, status: "failed" }, commit, manifest)).toThrow();
		expect(() => assertChecks({ ...checks, lockfileSha256: "old-lock" }, commit, manifest)).toThrow();
		expect(() => assertChecks(checks, commit, { "index.html": "rebuilt-output" })).toThrow();
	});

	it("rejects a mixed or replaced Worker deployment", () => {
		expect(workerDeploymentMatches({ versions: [{ version_id: "expected", percentage: 100 }] }, "expected")).toBe(true);
		expect(workerDeploymentMatches({ versions: [{ version_id: "other", percentage: 100 }] }, "expected")).toBe(false);
		expect(workerDeploymentMatches({ versions: [{ version_id: "expected", percentage: 50 }, { version_id: "other", percentage: 50 }] }, "expected")).toBe(false);
	});
});

describe("migration preflight", () => {
	it("requires every checked-in migration, including files that share an old prefix", () => {
		const local = ["0008_a.sql", "0008_b.sql", "0009_c.sql"];
		expect(migrationState(local, ["0008_a.sql"]).pending).toEqual(["0008_b.sql", "0009_c.sql"]);
		expect(migrationState(local, local).pending).toEqual([]);
	});

	it("refuses a source rollback when the database contains unknown migrations", () => {
		expect(() => migrationState(["0001_a.sql"], ["0001_a.sql", "0002_b.sql"])).toThrow("absent from this commit");
	});
});
