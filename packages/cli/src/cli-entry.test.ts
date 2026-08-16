import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const entry = join(import.meta.dirname, "index.ts");

/**
 * The CLI is executed by Node itself, not by a bundler, so it is the one place
 * where an extensionless relative import inside `@bickr/shared` is fatal:
 * Node's ESM resolver will not guess the `.ts`. Vitest resolves those specifiers
 * happily, so no amount of unit testing sees it — only actually starting the
 * program does.
 */
describe("bickr entry point", () => {
	it("starts under Node and prints its usage", async () => {
		const { stdout } = await run(process.execPath, ["--experimental-strip-types", entry, "--help"]);
		expect(stdout).toContain("Usage: bickr");
		expect(stdout).toContain("bickr spotlight send");
	}, 30_000);
});
