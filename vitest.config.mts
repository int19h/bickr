import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

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
					],
				},
			},
		],
	},
});
