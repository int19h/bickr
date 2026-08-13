import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Browser-environment specs. Most web code is tested in the workerd pool with
 * plain values, but event propagation and React commit ordering are properties
 * of a real document and a real renderer, so those specs need a DOM.
 */
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
				test: {
					name: "dom",
					environment: "jsdom",
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
						domTests,
						"packages/cli/src/**/*.test.ts",
						"scripts/**/*.test.mjs",
						"workers/agent-runtime/src/runtime/**/*.test.ts",
					],
				},
			},
		],
	},
});
