import { mkdtemp, rm, writeFile, stat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHost, runtimeConfig, saveToken, deleteToken } from "./config.ts";

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
	it("replaces existing credentials with a private complete file on save and deletion", async () => {
		const dir = await tempConfigDir();
		const path = join(dir, "config.json");
		await writeFile(path, JSON.stringify({ tokens: { "https://other.example": { token: "other" } } }), { mode: 0o644 });
		const env = { BICKR_CONFIG: path };
		await saveToken("https://stored.example", "stored-token", env);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await runtimeConfig({ env })).token).toBe("stored-token");
		await deleteToken("https://stored.example", env);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(path, "utf8")).tokens).toEqual({ "https://other.example": { token: "other" } });
		expect(await readdir(dir)).toEqual(["config.json"]);
	});
});

async function tempConfigDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "bickr-cli-test-"));
	tempDirs.push(dir);
	return dir;
}
