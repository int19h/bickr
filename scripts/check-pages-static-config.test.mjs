import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const mathPolicy = "Content-Security-Policy: default-src 'none'; script-src 'none'; connect-src 'none'; worker-src 'none'";
const framePolicy = "Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'none'; frame-ancestors 'self'; sandbox allow-scripts";
function runGuard({ omitRoute = false, inconsistentPolicy = false, omitMathPolicy = false, splitMathWorker = false } = {}) {
	const scratch = join(process.cwd(), ".wrangler/test-scratch");
	mkdirSync(scratch, { recursive: true });
	const root = mkdtempSync(join(scratch, "pages-route-"));
	try {
		const web = join(root, "apps/web");
		mkdirSync(join(web, "public"), { recursive: true });
		mkdirSync(join(web, "dist/client"), { recursive: true });
		mkdirSync(join(root, "scripts"));
		mkdirSync(join(web, "dist/client/math-assets"));
		writeFileSync(join(web, "dist/client/math-assets/math-worker-test.js"), "(()=>{})()");
		if (splitMathWorker) writeFileSync(join(web, "dist/client/math-assets/chunk-test.js"), "export const x = 1;");
		writeFileSync(join(root, "scripts/check-pages-static-config.mjs"), readFileSync(new URL("./check-pages-static-config.mjs", import.meta.url)));
		writeFileSync(join(web, "dist/client/diagram-renderer.html"), "<!doctype html>");
		writeFileSync(join(web, "dist/client/sw.js"), "// no navigation or asset cache");
		writeFileSync(join(web, "public/_routes.json"), JSON.stringify({ version: 1, include: ["/*"], exclude: ["/math-assets/*", "/sw.js", "/diagram-renderer.html", ...(omitRoute ? [] : ["/diagram-renderer"])] }));
		writeFileSync(join(web, "public/_headers"), `/math-assets/*\n  ${omitMathPolicy ? "" : mathPolicy}\n/sw.js\n  Cache-Control: no-cache, no-store, must-revalidate\n/diagram-renderer.html\n  ${framePolicy}\n/diagram-renderer\n  ${inconsistentPolicy ? "Content-Security-Policy: default-src 'self'" : framePolicy}\n`);
		return spawnSync(process.execPath, [join(root, "scripts/check-pages-static-config.mjs")], { encoding: "utf8" });
	} finally { rmSync(root, { recursive: true, force: true }); }
}
describe("Pages diagram route policy guard", () => {
	it("accepts extensionless HTML aliases backed by the emitted file", () => { expect(runGuard().status).toBe(0); });
	it("rejects a canonical frame route that passes through Functions", () => {
		const result = runGuard({ omitRoute: true });
		expect(result.status).toBe(1); expect(result.stderr).toContain("/diagram-renderer must bypass Pages Functions");
	});
	it("rejects a canonical frame route with a different security policy", () => {
		const result = runGuard({ inconsistentPolicy: true });
		expect(result.status).toBe(1); expect(result.stderr).toContain("identical headers");
	});
});

it("rejects a math worker without its restrictive response policy", () => {
	const result = runGuard({ omitMathPolicy: true });
	expect(result.status).toBe(1); expect(result.stderr).toContain("Math worker assets must bypass Functions");
});
it("rejects split math worker output that requires script loading", () => {
	const result = runGuard({ splitMathWorker: true });
	expect(result.status).toBe(1); expect(result.stderr).toContain("one self-contained script");
});
