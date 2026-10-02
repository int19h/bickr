import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertCommit, buildManifest, checksPath, repoRoot, run, sha256 } from "./release-support.mjs";

const { values } = parseArgs({ options: { commit: { type: "string" } } });
assertCommit(values.commit);
// A failed check must not leave a previous success available for release.
rmSync(checksPath, { force: true });
run("npm", ["ci"], { stdio: "inherit" });
run("npm", ["test", "--", "--maxWorkers=2"], { stdio: "inherit" });
run("npm", ["run", "build"], { stdio: "inherit", env: { ...process.env, BICKR_RELEASE_COMMIT: values.commit } });
assertCommit(values.commit);
const checks = {
	kind: "release-checks", schemaVersion: 1, status: "passed", commit: values.commit,
	completedAt: new Date().toISOString(), nodeVersion: process.version,
	lockfileSha256: sha256(readFileSync(join(repoRoot, "package-lock.json"))),
	build: buildManifest(),
};
mkdirSync(dirname(checksPath), { recursive: true });
writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
console.log(`Checks passed for ${values.commit}. Record: ${checksPath}`);
