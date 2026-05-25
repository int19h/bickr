import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHost, runtimeConfig, saveToken } from "./config.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI config", () => {
	it("defaults to production host", async () => {
		const dir = await tempConfigDir();
		const config = await runtimeConfig({ env: { BICKR_CONFIG_DIR: dir } });
		expect(config.host).toBe(defaultHost);
	});

	it("prefers explicit host over env and stored host", async () => {
		const dir = await tempConfigDir();
		await saveToken("https://stored.example", "stored-token", { BICKR_CONFIG_DIR: dir });
		const config = await runtimeConfig({
			env: { BICKR_CONFIG_DIR: dir, BICKR_HOST: "https://env.example" },
			host: "https://cli.example/",
		});
		expect(config.host).toBe("https://cli.example");
		expect(config.token).toBeUndefined();
	});

	it("uses the token stored for the selected host", async () => {
		const dir = await tempConfigDir();
		await saveToken("https://stored.example", "stored-token", { BICKR_CONFIG_DIR: dir });
		const config = await runtimeConfig({ env: { BICKR_CONFIG_DIR: dir, BICKR_HOST: "https://stored.example" } });
		expect(config.token).toBe("stored-token");
	});
});

async function tempConfigDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "bickr-cli-test-"));
	tempDirs.push(dir);
	return dir;
}
