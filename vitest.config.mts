import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// One glob, so a file can never be claimed by both the DOM and workerd projects.
const domTests = "apps/web/src/**/*.dom.test.tsx";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					environment: "node",
					include: ["packages/cli/src/**/*.test.ts", "scripts/**/*.test.mjs", "workers/agent-runtime/src/runtime/**/*.test.ts"],
					exclude: [...configDefaults.exclude],
				},
			},
			{
				// Browser components whose behavior is a sequence of renders rather
				// than one output: hook state across a prop change, effect ordering,
				// cleanup. They need a real React render loop, which needs a
				// document, so they run here instead of in workerd. Static markup
				// assertions stay in the cloudflare project with the rest.
				//
				// The `dom` glob is `.dom.test.tsx` rather than a directory so that a
				// subsystem's render-sequence tests stay next to the subsystem.
				test: {
					name: "dom",
					environment: "happy-dom",
					include: [domTests],
					exclude: [...configDefaults.exclude],
				},
			},
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./apps/web/wrangler.test.jsonc" },
					}),
				],
				test: {
					name: "cloudflare",
					exclude: [
						...configDefaults.exclude,
						"packages/cli/src/**/*.test.ts",
						"scripts/**/*.test.mjs",
						"workers/agent-runtime/src/runtime/**/*.test.ts",
						domTests,
					],
				},
			},
		],
	},
});
