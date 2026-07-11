import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(repoRoot, "migrations");
const selfTestDuplicate = process.argv.length === 3 && process.argv[2] === "--self-test-duplicate";
const allowedDuplicatePrefixFiles = new Map([
	// #64 incident: both 0008 migrations were already applied before duplicate-prefix enforcement existed.
	[8, ["0008_root_comments.sql", "0008_world_activity_indexes.sql"]],
]);

if (process.argv.length > (selfTestDuplicate ? 3 : 2)) {
	fail(`Usage: node scripts/check-migrations.mjs [--self-test-duplicate]`);
}

const migrationNames = readdirSync(migrationsDir)
	.filter((name) => name.endsWith(".sql"))
	.sort();

if (selfTestDuplicate) {
	const lastNumberedMigration = migrationNames.findLast((name) => /^\d+_/.test(name));
	if (!lastNumberedMigration) {
		fail("Cannot synthesize a duplicate without an existing numbered migration.");
	}
	const prefix = /^\d+/.exec(lastNumberedMigration)?.[0];
	migrationNames.push(`${prefix}_synthetic_duplicate.sql`);
}

const failures = migrationNumberingFailures(migrationNames);
if (failures.length > 0) {
	fail([
		"Migration numbering check failed:",
		...failures.map((failure) => `  - ${failure}`),
	].join("\n"));
}

console.log(`Migration numbering is contiguous across ${migrationNames.length} files.`);

function migrationNumberingFailures(names) {
	const failures = [];
	const namesByPrefix = new Map();

	for (const name of names) {
		const match = /^(\d+)_.*\.sql$/.exec(name);
		if (!match) {
			failures.push(`${name} must start with a numeric prefix followed by an underscore.`);
			continue;
		}
		const prefix = Number.parseInt(match[1], 10);
		const matchingNames = namesByPrefix.get(prefix) ?? [];
		matchingNames.push(name);
		namesByPrefix.set(prefix, matchingNames);
	}

	for (const [prefix, matchingNames] of namesByPrefix) {
		if (matchingNames.length < 2 || isAllowedDuplicate(prefix, matchingNames)) {
			continue;
		}
		failures.push(`prefix ${prefixLabel(prefix)} is used by ${matchingNames.sort().join(", ")}.`);
	}

	const prefixes = new Set(namesByPrefix.keys());
	const lastPrefix = Math.max(0, ...prefixes);
	for (let prefix = 1; prefix <= lastPrefix; prefix += 1) {
		if (!prefixes.has(prefix)) {
			failures.push(`missing migration prefix ${prefixLabel(prefix)}.`);
		}
	}

	return failures;
}

function isAllowedDuplicate(prefix, names) {
	const allowedNames = allowedDuplicatePrefixFiles.get(prefix);
	return allowedNames !== undefined && arraysEqual(names.toSorted(), allowedNames);
}

function arraysEqual(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function prefixLabel(prefix) {
	return String(prefix).padStart(4, "0");
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
