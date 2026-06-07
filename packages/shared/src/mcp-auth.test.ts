import { describe, expect, it } from "vitest";
import { type UserDocument } from "./model";
import {
	McpOAuthError,
	authForMcpAccessToken,
	createMcpAuthorizationCode,
	exchangeMcpAuthorizationCode,
	refreshMcpTokenSet,
	registerMcpClient,
	revokeMcpToken,
} from "./mcp-auth";
import { kvKeys, type KVNamespaceLike } from "./storage";

describe("MCP OAuth tokens", () => {
	it("registers clients, exchanges PKCE codes, rotates refresh tokens, and stores only hashes", async () => {
		const kv = new MapKV();
		await kv.put(kvKeys.user("usr_mcp"), JSON.stringify(testUser()));
		const now = new Date("2026-06-01T00:00:00.000Z");
		const client = await registerMcpClient(kv, {
			clientName: " Claude Desktop ",
			redirectUris: ["http://localhost:5173/callback"],
		}, now);

		expect(client.clientName).toBe("Claude Desktop");
		expect(client.tokenEndpointAuthMethod).toBe("none");

		const codeVerifier = "correct-horse-battery-staple-correct-horse-battery-staple";
		const codeChallenge = await pkceS256(codeVerifier);
		const issued = await createMcpAuthorizationCode(kv, {
			clientId: client.id,
			redirectUri: "http://localhost:5173/callback",
			resource: "https://bickr.social/mcp",
			userId: "usr_mcp",
			scopes: ["bickr.read", "bickr.runtime"],
			codeChallenge,
			codeChallengeMethod: "S256",
		}, now);
		expect(issued.code).toMatch(/^bckr_mcp_code_/);
		expect(kv.serializedValues().some((value) => value.includes(issued.code))).toBe(false);

		const tokens = await exchangeMcpAuthorizationCode(kv, {
			code: issued.code,
			clientId: client.id,
			redirectUri: "http://localhost:5173/callback",
			codeVerifier,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:01:00.000Z"));
		expect(tokens.accessToken).toMatch(/^bckr_mcp_at_/);
		expect(tokens.refreshToken).toMatch(/^bckr_mcp_rt_/);
		expect(tokens.scope).toBe("bickr.read bickr.runtime");
		expect(kv.serializedValues().some((value) => value.includes(tokens.accessToken))).toBe(false);
		expect(kv.serializedValues().some((value) => value.includes(tokens.refreshToken))).toBe(false);

		await expect(exchangeMcpAuthorizationCode(kv, {
			code: issued.code,
			clientId: client.id,
			redirectUri: "http://localhost:5173/callback",
			codeVerifier,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:02:00.000Z"))).rejects.toMatchObject({ code: "invalid_grant" });

		const auth = await authForMcpAccessToken(kv, tokens.accessToken, "https://bickr.social/mcp", new Date("2026-06-01T00:02:00.000Z"));
		expect(auth?.user.id).toBe("usr_mcp");
		expect(auth?.scopes.has("bickr.read")).toBe(true);
		expect(auth?.scopes.has("bickr.runtime")).toBe(true);
		expect(await authForMcpAccessToken(kv, tokens.accessToken, "https://bickr.social/mcp", new Date("2026-06-01T01:02:00.000Z"))).toBeNull();

		const refreshed = await refreshMcpTokenSet(kv, {
			refreshToken: tokens.refreshToken,
			clientId: client.id,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:03:00.000Z"));
		expect(refreshed.accessToken).not.toBe(tokens.accessToken);
		expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
		await expect(refreshMcpTokenSet(kv, {
			refreshToken: tokens.refreshToken,
			clientId: client.id,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:04:00.000Z"))).rejects.toMatchObject({ code: "invalid_grant" });

		expect(await authForMcpAccessToken(kv, refreshed.accessToken, "https://bickr.social/mcp", new Date("2026-06-01T00:05:00.000Z"))).not.toBeNull();
		await revokeMcpToken(kv, {
			token: refreshed.refreshToken,
			clientId: client.id,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:06:00.000Z"));
		expect(await authForMcpAccessToken(kv, refreshed.accessToken, "https://bickr.social/mcp", new Date("2026-06-01T00:07:00.000Z"))).toBeNull();
	});

	it("rejects invalid redirect metadata as OAuth client metadata errors", async () => {
		const kv = new MapKV();
		await expect(registerMcpClient(kv, {
			redirectUris: ["not a url"],
		})).rejects.toBeInstanceOf(McpOAuthError);
		await expect(registerMcpClient(kv, {
			redirectUris: ["not a url"],
		})).rejects.toMatchObject({ code: "invalid_client_metadata" });
	});
});

class MapKV implements KVNamespaceLike {
	private readonly data = new Map<string, string>();

	async get(key: string, options?: { type: "json" }): Promise<unknown> {
		const value = this.data.get(key);
		if (value === undefined) {
			return null;
		}
		return options?.type === "json" ? JSON.parse(value) as unknown : value;
	}

	async put(key: string, value: string): Promise<void> {
		this.data.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.data.delete(key);
	}

	serializedValues(): string[] {
		return [...this.data.values()];
	}
}

function testUser(): UserDocument {
	return {
		id: "usr_mcp",
		type: "user",
		schemaVersion: 1,
		revision: 1,
		handle: "mcp-user",
		displayName: "MCP User",
		profileCompletedAt: "2026-05-01T00:00:00.000Z",
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
	};
}

async function pkceS256(codeVerifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
	return base64Url(new Uint8Array(digest));
}

function base64Url(data: Uint8Array): string {
	let binary = "";
	for (const byte of data) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
