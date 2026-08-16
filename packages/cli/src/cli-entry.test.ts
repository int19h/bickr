import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const entry = join(import.meta.dirname, "index.ts");

async function usage(): Promise<string> {
	const { stdout } = await run(process.execPath, ["--experimental-strip-types", entry, "--help"]);
	return stdout;
}

/**
 * The CLI is executed by Node itself, not by a bundler, so it is the one place
 * where an extensionless relative import inside `@bickr/shared` is fatal:
 * Node's ESM resolver will not guess the `.ts`. Vitest resolves those specifiers
 * happily, so no amount of unit testing sees it — only actually starting the
 * program does.
 *
 * This test asserts nothing about what the program says, so that it can only
 * ever fail for that reason.
 */
describe("bickr entry point", () => {
	it("starts under Node", async () => {
		expect(await usage()).toContain("Usage: bickr");
	}, 30_000);
});

describe("bickr usage", () => {
	it("documents the spotlight command and the shared bot target grammar", async () => {
		const text = await usage();
		expect(text).toContain("bickr spotlight send");
		expect(text).toContain("w/world/g/GROUP");
	}, 30_000);
});
