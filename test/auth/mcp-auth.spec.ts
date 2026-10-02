import { env } from "cloudflare:test";
import { resetD1Schema } from "../helpers/d1-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { localizedText, type UserDocument } from "../../packages/shared/src/model";
import {
	McpOAuthError,
	authForMcpAccessToken,
	createMcpAuthorizationCode,
	exchangeMcpAuthorizationCode,
	refreshMcpTokenSet,
	registerMcpClient,
	revokeMcpToken,
} from "../../packages/shared/src/mcp-auth";
import { kvKeys, type KVNamespaceLike } from "../../packages/shared/src/storage";

const db = env.BICKR_D1;
beforeEach(async () => {
	await resetD1Schema(db);
	await db.prepare("INSERT INTO entity_lifecycle_identity_claims(key_kind,key_scope,key_value,entity_kind,entity_id,owner_user_id,claim_state,created_at,updated_at) VALUES ('user_handle','global','user','account',?,?,'active','2026-01-01','2026-01-01')").bind("usr_mcp","usr_mcp").run();
	await db.prepare("INSERT INTO users_index(user_id,handle,display_name,created_at,updated_at,lifecycle_state) VALUES (?,?,?,?,?,?)").bind("usr_mcp", "user", "User", "2026-01-01", "2026-01-01", "active").run();
});

describe("MCP OAuth tokens", () => {
	it("registers clients, exchanges PKCE codes, rotates refresh tokens, and stores only hashes", async () => {
		const kv = new MapKV();
		await kv.put(kvKeys.user("usr_mcp"), JSON.stringify(testUser()));
		const now = new Date("2026-06-01T00:00:00.000Z");
		const client = await registerMcpClient(db, {
			clientName: " Claude Desktop ",
			redirectUris: ["http://localhost:5173/callback"],
		}, now);

		expect(client.clientName).toBe("Claude Desktop");
		expect(client.tokenEndpointAuthMethod).toBe("none");

		const codeVerifier = "correct-horse-battery-staple-correct-horse-battery-staple";
		const codeChallenge = await pkceS256(codeVerifier);
		const issued = await createMcpAuthorizationCode(db, {
			clientId: client.id,
			redirectUri: "http://localhost:5173/callback",
			resource: "https://bickr.social/mcp",
			userId: "usr_mcp",
			scopes: ["bickr.read", "bickr.runtime"],
			codeChallenge,
			codeChallengeMethod: "S256",
		}, now);
		expect(issued.code).toMatch(/^bckr_mcp_code_/);
		expect(JSON.stringify((await db.prepare("SELECT * FROM auth_records").all()).results)).not.toContain(issued.code);

		const tokens = await exchangeMcpAuthorizationCode(db, {
			code: issued.code,
			clientId: client.id,
			redirectUri: "http://localhost:5173/callback",
			codeVerifier,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:01:00.000Z"));
		expect(tokens.accessToken).toMatch(/^bckr_mcp_at_/);
		expect(tokens.refreshToken).toMatch(/^bckr_mcp_rt_/);
		expect(tokens.scope).toBe("bickr.read bickr.runtime");
		const stored = JSON.stringify((await db.prepare("SELECT * FROM auth_records").all()).results);
		expect(stored).not.toContain(tokens.accessToken);
		expect(stored).not.toContain(tokens.refreshToken);

		const auth = await authForMcpAccessToken(kv, db, tokens.accessToken, "https://bickr.social/mcp", new Date("2026-06-01T00:02:00.000Z"));
		expect(auth?.user.id).toBe("usr_mcp");
		expect(auth?.scopes.has("bickr.read")).toBe(true);
		expect(auth?.scopes.has("bickr.runtime")).toBe(true);
		expect(await authForMcpAccessToken(kv, db, tokens.accessToken, "https://bickr.social/mcp", new Date("2026-06-01T01:02:00.000Z"))).toBeNull();

		const refreshed = await refreshMcpTokenSet(db, {
			refreshToken: tokens.refreshToken,
			clientId: client.id,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:03:00.000Z"));
		expect(refreshed.accessToken).not.toBe(tokens.accessToken);
		expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
		await expect(refreshMcpTokenSet(db, {
			refreshToken: tokens.refreshToken,
			clientId: client.id,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:04:00.000Z"))).rejects.toMatchObject({ code: "invalid_grant" });

		expect(await authForMcpAccessToken(kv, db, refreshed.accessToken, "https://bickr.social/mcp", new Date("2026-06-01T00:05:00.000Z"))).toBeNull();
		await revokeMcpToken(db, {
			token: refreshed.refreshToken,
			clientId: client.id,
			resource: "https://bickr.social/mcp",
		}, new Date("2026-06-01T00:06:00.000Z"));
		expect(await authForMcpAccessToken(kv, db, refreshed.accessToken, "https://bickr.social/mcp", new Date("2026-06-01T00:07:00.000Z"))).toBeNull();
	});

	it("rejects invalid redirect metadata as OAuth client metadata errors", async () => {
		await expect(registerMcpClient(db, {
			redirectUris: ["not a url"],
		})).rejects.toBeInstanceOf(McpOAuthError);
		await expect(registerMcpClient(db, {
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

}

function testUser(): UserDocument {
	return {
		id: "usr_mcp",
		type: "user",
		schemaVersion: 1,
		revision: 1,
		handle: "mcp-user",
		language: null,
		displayName: localizedText("MCP User", null),
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
