import { describe, expect, it } from "vitest";
import { type UserDocument } from "../packages/shared/src/model";
import {
	createMcpAuthorizationCode,
	exchangeMcpAuthorizationCode,
	registerMcpClient,
} from "../packages/shared/src/mcp-auth";
import { kvKeys, type KVNamespaceLike } from "../packages/shared/src/storage";
import { onRequestGet as onAuthorizationServerGet } from "../apps/web/functions/.well-known/oauth-authorization-server";
import { onRequestGet as onProtectedResourceGet } from "../apps/web/functions/.well-known/oauth-protected-resource";
import { onRequestGet as onPathProtectedResourceGet } from "../apps/web/functions/.well-known/oauth-protected-resource/mcp";
import { mcpToolMetadataForTest, onRequestPost } from "../apps/web/functions/mcp";
import { onRequestPost as onRegisterPost } from "../apps/web/functions/oauth/register";

type TestPagesContext = Parameters<typeof onRequestPost>[0];

describe("MCP endpoint", () => {
	it("serves protected resource and authorization server metadata", async () => {
		const protectedResource = await jsonResponse(await onProtectedResourceGet(pagesContext(new Request("https://bickr.social/.well-known/oauth-protected-resource"))));
		expect(protectedResource).toMatchObject({
			resource: "https://bickr.social/mcp",
			authorization_servers: ["https://bickr.social"],
			bearer_methods_supported: ["header"],
		});
		expect(protectedResource.scopes_supported).toContain("bickr.read");
		expect(protectedResource.scopes_supported).toContain("bickr.write");
		expect(protectedResource.scopes_supported).toContain("bickr.runtime");

		const pathProtectedResource = await jsonResponse(await onPathProtectedResourceGet(pagesContext(new Request("https://bickr.social/.well-known/oauth-protected-resource/mcp"))));
		expect(pathProtectedResource).toMatchObject({
			resource: "https://bickr.social/mcp",
			authorization_servers: ["https://bickr.social"],
			bearer_methods_supported: ["header"],
		});

		const authorizationServer = await jsonResponse(await onAuthorizationServerGet(pagesContext(new Request("https://bickr.social/.well-known/oauth-authorization-server"))));
		expect(authorizationServer).toMatchObject({
			issuer: "https://bickr.social",
			authorization_endpoint: "https://bickr.social/oauth/authorize",
			token_endpoint: "https://bickr.social/oauth/token",
			revocation_endpoint: "https://bickr.social/oauth/revoke",
			registration_endpoint: "https://bickr.social/oauth/register",
			token_endpoint_auth_methods_supported: ["none"],
			resource_indicators_supported: true,
		});
	});

	it("returns OAuth-shaped client registration errors", async () => {
		const response = await onRegisterPost(pagesContext(new Request("https://bickr.social/oauth/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ redirect_uris: ["not a url"] }),
		}), { BICKR_KV: new MapKV() }));
		const body = await jsonResponse(response);

		expect(response.status).toBe(400);
		expect(body).toMatchObject({
			error: "invalid_client_metadata",
		});
	});

	it("returns OAuth protected-resource metadata when unauthenticated", async () => {
		const response = await callMcp(new MapKV(), null, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		});

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
	});

	it("discovers typed Bickr tools, annotations, and no raw API tool", () => {
		const tools = mcpToolMetadataForTest();
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const expectedToolAnnotations = [
			["get_profile", "bickr.read", true, false, true],
			["update_profile", "bickr.write", false, false, false],
			["list_worlds", "bickr.read", true, false, true],
			["list_my_worlds", "bickr.read", true, false, true],
			["create_world", "bickr.write", false, false, false],
			["update_world", "bickr.write", false, false, false],
			["delete_world", "bickr.write", false, true, false],
			["list_forums", "bickr.read", true, false, true],
			["create_forum", "bickr.write", false, false, false],
			["update_forum", "bickr.write", false, false, false],
			["delete_forum", "bickr.write", false, true, false],
			["list_threads", "bickr.read", true, false, true],
			["get_thread", "bickr.read", true, false, true],
			["create_thread", "bickr.write", false, false, false],
			["create_comment", "bickr.write", false, false, false],
			["vote", "bickr.write", false, false, false],
			["delete_thread", "bickr.write", false, true, false],
			["delete_comment", "bickr.write", false, true, false],
			["list_my_bots", "bickr.read", true, false, true],
			["list_world_bots", "bickr.read", true, false, true],
			["get_bot", "bickr.read", true, false, true],
			["create_bot", "bickr.write", false, false, false],
			["update_bot", "bickr.write", false, false, false],
			["delete_bot", "bickr.write", false, true, false],
			["set_bot_avatar_url", "bickr.write", false, false, false],
			["clear_bot_avatar", "bickr.write", false, true, false],
			["update_bot_avatar_crop", "bickr.write", false, false, false],
			["unlink_bot_clone", "bickr.write", false, false, false],
			["relink_bot_clone", "bickr.write", false, false, false],
			["list_groups", "bickr.read", true, false, true],
			["create_group", "bickr.write", false, false, false],
			["update_group", "bickr.write", false, false, false],
			["add_group_bots", "bickr.write", false, false, false],
			["remove_group_bot", "bickr.write", false, true, false],
			["delete_group", "bickr.write", false, true, false],
			["search", "bickr.read", true, false, true],
			["export_thread", "bickr.read", true, false, true],
			["export_forum", "bickr.read", true, false, true],
			["list_notifications", "bickr.read", true, false, true],
			["mark_notifications_read", "bickr.write", false, false, false],
			["list_subscriptions", "bickr.read", true, false, true],
			["set_subscription", "bickr.write", false, false, false],
			["delete_subscription", "bickr.write", false, true, false],
			["get_runtime_status", "bickr.read", true, false, true],
			["list_runtime_messages", "bickr.read", true, false, true],
			["list_runtime_events", "bickr.read", true, false, true],
			["list_runtime_submissions", "bickr.read", true, false, true],
			["get_runtime_token_spend", "bickr.read", true, false, true],
			["get_runtime_token_usage", "bickr.read", true, false, true],
			["get_runtime_context_budget", "bickr.read", true, false, true],
			["run_runtime_tick", "bickr.runtime", false, true, false],
			["stop_runtime", "bickr.runtime", false, true, false],
			["compact_runtime", "bickr.runtime", false, true, false],
			["inject_runtime", "bickr.runtime", false, true, false],
			["update_runtime_context_budget", "bickr.runtime", false, true, false],
		] as const;

		expect([...byName.keys()]).not.toContain("api");
		expect([...byName.keys()]).not.toContain("raw_api");
		expect(tools).toHaveLength(expectedToolAnnotations.length);
		expect(new Set(tools.map((tool) => tool.name))).toEqual(new Set(expectedToolAnnotations.map(([name]) => name)));
		for (const [name, scope, readOnlyHint, destructiveHint, idempotentHint] of expectedToolAnnotations) {
			expect(byName.get(name)).toMatchObject({
				scopes: [scope],
				annotations: {
					readOnlyHint,
					destructiveHint,
					idempotentHint,
				},
			});
		}
	});

	it("returns structured tool content before compatibility text content", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "get_profile",
				arguments: {},
			},
		}, { BICKR_D1: emptyD1() });
		const body = await jsonResponse(response);
		const result = body.result as Record<string, unknown>;
		const resultKeys = Object.keys(result);

		expect(response.status).toBe(200);
		expect(resultKeys.indexOf("structuredContent")).toBeLessThan(resultKeys.indexOf("content"));
		expect(result).toMatchObject({
			structuredContent: {
				profile: {
					handle: "mcp-user",
				},
			},
			content: [{ type: "text" }],
		});
	});

	it("rejects write tools before execution when the token has read scope only", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "create_world",
				arguments: {
					handle: "new-world",
					name: "New World",
					description: "A new world",
				},
			},
		});

		expect(response.status).toBe(403);
		expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
		expect(response.headers.get("www-authenticate")).toContain("bickr.write");
	});
});

async function callMcp(kv: KVNamespaceLike, accessToken: string | null, body: unknown, env: Record<string, unknown> = {}): Promise<Response> {
	const headers = new Headers({ "content-type": "application/json" });
	if (accessToken) {
		headers.set("authorization", `Bearer ${accessToken}`);
	}
	return onRequestPost(pagesContext(new Request("https://bickr.social/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	}), { BICKR_KV: kv, ...env }));
}

function pagesContext(request: Request, env: Record<string, unknown> = {}): TestPagesContext {
	return {
		env,
		request,
		params: {},
		data: {},
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
		next: () => Promise.resolve(new Response(null)),
		functionPath: new URL(request.url).pathname,
	} as unknown as TestPagesContext;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

async function issueAccessToken(kv: KVNamespaceLike, scopes: string[]): Promise<string> {
	await kv.put(kvKeys.user("usr_mcp"), JSON.stringify(testUser()));
	const now = new Date();
	const client = await registerMcpClient(kv, {
		clientName: "MCP Inspector",
		redirectUris: ["http://localhost:5173/callback"],
	}, now);
	const codeVerifier = "correct-horse-battery-staple-correct-horse-battery-staple";
	const issued = await createMcpAuthorizationCode(kv, {
		clientId: client.id,
		redirectUri: "http://localhost:5173/callback",
		resource: "https://bickr.social/mcp",
		userId: "usr_mcp",
		scopes,
		codeChallenge: await pkceS256(codeVerifier),
		codeChallengeMethod: "S256",
	}, now);
	const tokens = await exchangeMcpAuthorizationCode(kv, {
		code: issued.code,
		clientId: client.id,
		redirectUri: "http://localhost:5173/callback",
		codeVerifier,
		resource: "https://bickr.social/mcp",
	}, now);
	return tokens.accessToken;
}

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

function emptyD1(): unknown {
	const statement = {
		bind() {
			return statement;
		},
		first: async () => null,
		all: async () => ({ success: true, results: [] }),
		run: async () => ({ success: true, meta: { changes: 0 } }),
	};
	return {
		batch: async () => [],
		prepare: () => statement,
	};
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
