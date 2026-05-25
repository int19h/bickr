import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

export const defaultHost = "https://bickr.social";

export type CliConfig = {
	defaultHost?: string;
	tokens?: Record<string, { token: string; createdAt: string }>;
};

export type RuntimeConfig = {
	host: string;
	token?: string;
	configPath: string;
};

export async function runtimeConfig(input: { host?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RuntimeConfig> {
	const env = input.env ?? process.env;
	const configPath = bickrConfigPath(env);
	const config = await loadConfig(configPath);
	const host = normalizeHost(input.host ?? env.BICKR_HOST ?? config.defaultHost ?? defaultHost);
	return {
		host,
		token: env.BICKR_TOKEN || config.tokens?.[host]?.token,
		configPath,
	};
}

export async function saveToken(host: string, token: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const configPath = bickrConfigPath(env);
	const config = await loadConfig(configPath);
	const normalizedHost = normalizeHost(host);
	const next: CliConfig = {
		...config,
		defaultHost: normalizedHost,
		tokens: {
			...(config.tokens ?? {}),
			[normalizedHost]: { token, createdAt: new Date().toISOString() },
		},
	};
	await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
	await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export async function deleteToken(host: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const configPath = bickrConfigPath(env);
	const config = await loadConfig(configPath);
	const normalizedHost = normalizeHost(host);
	if (!config.tokens?.[normalizedHost]) {
		return;
	}
	const tokens = { ...config.tokens };
	delete tokens[normalizedHost];
	const next: CliConfig = { ...config, tokens };
	if (Object.keys(tokens).length === 0) {
		delete next.tokens;
	}
	await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
	await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export async function clearConfig(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	await rm(bickrConfigPath(env), { force: true });
}

export function normalizeHost(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) {
		return defaultHost;
	}
	const url = new URL(trimmed);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("BICKR host must be an HTTP(S) URL.");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/+$/, "");
}

export function bickrConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.BICKR_CONFIG) {
		return env.BICKR_CONFIG;
	}
	if (env.BICKR_CONFIG_DIR) {
		return join(env.BICKR_CONFIG_DIR, "config.json");
	}
	if (platform() === "win32" && env.APPDATA) {
		return join(env.APPDATA, "bickr", "config.json");
	}
	return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "bickr", "config.json");
}

async function loadConfig(configPath: string): Promise<CliConfig> {
	try {
		const text = await readFile(configPath, "utf8");
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CliConfig : {};
	} catch (error) {
		if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
			return {};
		}
		throw error;
	}
}
