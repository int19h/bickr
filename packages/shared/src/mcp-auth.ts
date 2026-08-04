import { randomToken, sha256Hex } from "./ids";
import { schemaVersion, type UserDocument } from "./model";
import { deleteKey, kvKeys, readJson, type KVNamespaceLike, writeJson } from "./storage";

export const mcpScopes = ["bickr.read", "bickr.write", "bickr.runtime"] as const;
export type McpScope = (typeof mcpScopes)[number];

declare const redirectUriCspSourceBrand: unique symbol;
export type RedirectUriCspSource = string & { readonly [redirectUriCspSourceBrand]: true };

export type McpClientDocument = {
	id: string;
	type: "mcpClient";
	schemaVersion: number;
	clientName: string;
	redirectUris: string[];
	tokenEndpointAuthMethod: "none";
	createdAt: string;
	updatedAt: string;
};

export type McpAuthorizationCodeDocument = {
	id: string;
	type: "mcpAuthorizationCode";
	clientId: string;
	redirectUri: string;
	resource: string;
	userId: string;
	scopes: McpScope[];
	codeChallenge: string;
	codeChallengeMethod: "S256";
	createdAt: string;
	expiresAt: string;
};

export type McpGrantDocument = {
	id: string;
	type: "mcpGrant";
	schemaVersion: number;
	clientId: string;
	userId: string;
	resource: string;
	scopes: McpScope[];
	createdAt: string;
	updatedAt: string;
	revokedAt?: string;
};

export type McpAccessTokenDocument = {
	id: string;
	type: "mcpAccessToken";
	grantId: string;
	clientId: string;
	userId: string;
	resource: string;
	scopes: McpScope[];
	createdAt: string;
	expiresAt: string;
};

export type McpRefreshTokenDocument = {
	id: string;
	type: "mcpRefreshToken";
	grantId: string;
	clientId: string;
	userId: string;
	resource: string;
	scopes: McpScope[];
	createdAt: string;
	expiresAt: string;
};

export type McpTokenSet = {
	accessToken: string;
	refreshToken: string;
	tokenType: "Bearer";
	expiresIn: number;
	scope: string;
};

export type McpAuthContext = {
	user: UserDocument;
	grant: McpGrantDocument;
	token: McpAccessTokenDocument;
	scopes: Set<McpScope>;
};

export class McpOAuthError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "McpOAuthError";
		this.code = code;
		this.status = status;
	}
}

const authorizationCodeTtlSeconds = 10 * 60;
const accessTokenTtlSeconds = 60 * 60;
const refreshTokenTtlSeconds = 60 * 60 * 24 * 90;
const maxClientNameLength = 120;
const maxRedirectUris = 20;

export async function registerMcpClient(
	kv: KVNamespaceLike,
	input: { clientName?: string; redirectUris: string[]; tokenEndpointAuthMethod?: string },
	now = new Date(),
): Promise<McpClientDocument> {
	const redirectUris = normalizedRedirectUris(input.redirectUris);
	if (input.tokenEndpointAuthMethod && input.tokenEndpointAuthMethod !== "none") {
		throw new McpOAuthError("invalid_client_metadata", "Bickr MCP supports public OAuth clients only.");
	}
	const clientId = `bckr_mcp_client_${randomToken(18)}`;
	const createdAt = now.toISOString();
	const client: McpClientDocument = {
		id: clientId,
		type: "mcpClient",
		schemaVersion,
		clientName: normalizedClientName(input.clientName),
		redirectUris,
		tokenEndpointAuthMethod: "none",
		createdAt,
		updatedAt: createdAt,
	};
	await writeJson(kv, kvKeys.mcpClient(client.id), client);
	return client;
}

export async function readMcpClient(kv: KVNamespaceLike, clientId: string): Promise<McpClientDocument | null> {
	const id = clientId.trim();
	return id ? readJson<McpClientDocument>(kv, kvKeys.mcpClient(id)) : null;
}

export async function createMcpAuthorizationCode(
	kv: KVNamespaceLike,
	input: {
		clientId: string;
		redirectUri: string;
		resource: string;
		userId: string;
		scopes: readonly string[];
		codeChallenge: string;
		codeChallengeMethod: string;
	},
	now = new Date(),
): Promise<{ code: string; document: McpAuthorizationCodeDocument }> {
	const client = await requireMcpClient(kv, input.clientId);
	if (!client.redirectUris.includes(input.redirectUri)) {
		throw new McpOAuthError("invalid_request", "Redirect URI is not registered for this MCP client.");
	}
	if (input.codeChallengeMethod !== "S256" || !input.codeChallenge.trim()) {
		throw new McpOAuthError("invalid_request", "MCP authorization requires PKCE S256.");
	}
	const code = `bckr_mcp_code_${randomToken(24)}`;
	const codeHash = await sha256Hex(code);
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + authorizationCodeTtlSeconds * 1000).toISOString();
	const document: McpAuthorizationCodeDocument = {
		id: `mcp_code_${codeHash.slice(0, 32)}`,
		type: "mcpAuthorizationCode",
		clientId: client.id,
		redirectUri: input.redirectUri,
		resource: normalizedResource(input.resource),
		userId: input.userId,
		scopes: normalizeMcpScopes(input.scopes),
		codeChallenge: input.codeChallenge,
		codeChallengeMethod: "S256",
		createdAt,
		expiresAt,
	};
	await writeJson(kv, kvKeys.mcpAuthorizationCode(codeHash), document, { expirationTtl: authorizationCodeTtlSeconds });
	console.info({
		event: "mcp_oauth_authorization_code_issued",
		codeDocumentId: document.id,
		clientId: document.clientId,
	});
	return { code, document };
}

export async function exchangeMcpAuthorizationCode(
	kv: KVNamespaceLike,
	input: {
		code: string;
		clientId: string;
		redirectUri: string;
		codeVerifier: string;
		resource: string;
	},
	now = new Date(),
): Promise<McpTokenSet> {
	const codeHash = await sha256Hex(input.code);
	const code = await readJson<McpAuthorizationCodeDocument>(kv, kvKeys.mcpAuthorizationCode(codeHash));
	await deleteKey(kv, kvKeys.mcpAuthorizationCode(codeHash));
	if (!code || Date.parse(code.expiresAt) <= now.getTime()) {
		throw new McpOAuthError("invalid_grant", "Authorization code is invalid or expired.");
	}
	if (
		code.clientId !== input.clientId ||
		code.redirectUri !== input.redirectUri ||
		code.resource !== normalizedResource(input.resource)
	) {
		throw new McpOAuthError("invalid_grant", "Authorization code was issued for different client parameters.");
	}
	if (await pkceS256(input.codeVerifier) !== code.codeChallenge) {
		throw new McpOAuthError("invalid_grant", "PKCE verifier did not match this authorization code.");
	}
	const grant = await createMcpGrant(kv, {
		clientId: code.clientId,
		userId: code.userId,
		resource: code.resource,
		scopes: code.scopes,
	}, now);
	const tokenSet = await issueMcpTokenSet(kv, grant, now);
	console.info({
		event: "mcp_oauth_authorization_code_redeemed",
		codeDocumentId: code.id,
		clientId: code.clientId,
	});
	return tokenSet;
}

export async function refreshMcpTokenSet(
	kv: KVNamespaceLike,
	input: { refreshToken: string; clientId: string; resource: string },
	now = new Date(),
): Promise<McpTokenSet> {
	const tokenHash = await sha256Hex(input.refreshToken);
	const refresh = await readJson<McpRefreshTokenDocument>(kv, kvKeys.mcpRefreshToken(tokenHash));
	await deleteKey(kv, kvKeys.mcpRefreshToken(tokenHash));
	if (!refresh || Date.parse(refresh.expiresAt) <= now.getTime()) {
		throw new McpOAuthError("invalid_grant", "Refresh token is invalid or expired.");
	}
	if (refresh.clientId !== input.clientId || refresh.resource !== normalizedResource(input.resource)) {
		throw new McpOAuthError("invalid_grant", "Refresh token was issued for different client parameters.");
	}
	const grant = await readJson<McpGrantDocument>(kv, kvKeys.mcpGrant(refresh.grantId));
	if (!grant || grant.revokedAt) {
		throw new McpOAuthError("invalid_grant", "Refresh token grant is no longer active.");
	}
	return issueMcpTokenSet(kv, grant, now);
}

export async function revokeMcpToken(
	kv: KVNamespaceLike,
	input: { token: string; clientId: string; resource: string },
	now = new Date(),
): Promise<void> {
	const tokenHash = await sha256Hex(input.token);
	const normalized = normalizedResource(input.resource);
	const refresh = await readJson<McpRefreshTokenDocument>(kv, kvKeys.mcpRefreshToken(tokenHash));
	const access = refresh ? null : await readJson<McpAccessTokenDocument>(kv, kvKeys.mcpAccessToken(tokenHash));
	const tokenDocument = refresh ?? access;
	await deleteKey(kv, kvKeys.mcpRefreshToken(tokenHash));
	await deleteKey(kv, kvKeys.mcpAccessToken(tokenHash));
	if (!tokenDocument || tokenDocument.clientId !== input.clientId || tokenDocument.resource !== normalized) {
		return;
	}
	const grant = await readJson<McpGrantDocument>(kv, kvKeys.mcpGrant(tokenDocument.grantId));
	if (!grant || grant.revokedAt) {
		return;
	}
	const revokedAt = now.toISOString();
	await writeJson(kv, kvKeys.mcpGrant(grant.id), {
		...grant,
		updatedAt: revokedAt,
		revokedAt,
	});
}

export async function authForMcpAccessToken(
	kv: KVNamespaceLike,
	token: string | null | undefined,
	resource: string,
	now = new Date(),
): Promise<McpAuthContext | null> {
	if (!token) {
		return null;
	}
	const document = await readJson<McpAccessTokenDocument>(kv, kvKeys.mcpAccessToken(await sha256Hex(token)));
	if (!document || Date.parse(document.expiresAt) <= now.getTime() || document.resource !== normalizedResource(resource)) {
		return null;
	}
	const grant = await readJson<McpGrantDocument>(kv, kvKeys.mcpGrant(document.grantId));
	if (!grant || grant.revokedAt) {
		return null;
	}
	const user = await readJson<UserDocument>(kv, kvKeys.user(document.userId));
	if (!user || user.deletedAt) {
		return null;
	}
	return {
		user,
		grant,
		token: document,
		scopes: new Set(document.scopes),
	};
}

export function normalizeMcpScopes(values: readonly string[] | string | null | undefined): McpScope[] {
	const raw = typeof values === "string" ? values.split(/\s+/) : values ?? [];
	const scopes = raw.filter((scope): scope is McpScope => (mcpScopes as readonly string[]).includes(scope));
	return scopes.length ? [...new Set(scopes)] : ["bickr.read"];
}

export function mcpScopeString(scopes: readonly McpScope[]): string {
	return scopes.join(" ");
}

async function requireMcpClient(kv: KVNamespaceLike, clientId: string): Promise<McpClientDocument> {
	const client = await readMcpClient(kv, clientId);
	if (!client) {
		throw new McpOAuthError("invalid_client", "MCP client is not registered.", 401);
	}
	return client;
}

async function createMcpGrant(
	kv: KVNamespaceLike,
	input: { clientId: string; userId: string; resource: string; scopes: readonly McpScope[] },
	now: Date,
): Promise<McpGrantDocument> {
	const createdAt = now.toISOString();
	const grant: McpGrantDocument = {
		id: `mcp_grant_${randomToken(18)}`,
		type: "mcpGrant",
		schemaVersion,
		clientId: input.clientId,
		userId: input.userId,
		resource: input.resource,
		scopes: [...input.scopes],
		createdAt,
		updatedAt: createdAt,
	};
	await writeJson(kv, kvKeys.mcpGrant(grant.id), grant);
	return grant;
}

async function issueMcpTokenSet(kv: KVNamespaceLike, grant: McpGrantDocument, now: Date): Promise<McpTokenSet> {
	const accessToken = `bckr_mcp_at_${randomToken(32)}`;
	const refreshToken = `bckr_mcp_rt_${randomToken(32)}`;
	const createdAt = now.toISOString();
	const accessExpiresAt = new Date(now.getTime() + accessTokenTtlSeconds * 1000).toISOString();
	const refreshExpiresAt = new Date(now.getTime() + refreshTokenTtlSeconds * 1000).toISOString();
	const accessTokenHash = await sha256Hex(accessToken);
	const refreshTokenHash = await sha256Hex(refreshToken);
	const accessDocument: McpAccessTokenDocument = {
		id: `mcp_at_${accessTokenHash.slice(0, 32)}`,
		type: "mcpAccessToken",
		grantId: grant.id,
		clientId: grant.clientId,
		userId: grant.userId,
		resource: grant.resource,
		scopes: [...grant.scopes],
		createdAt,
		expiresAt: accessExpiresAt,
	};
	const refreshDocument: McpRefreshTokenDocument = {
		id: `mcp_rt_${refreshTokenHash.slice(0, 32)}`,
		type: "mcpRefreshToken",
		grantId: grant.id,
		clientId: grant.clientId,
		userId: grant.userId,
		resource: grant.resource,
		scopes: [...grant.scopes],
		createdAt,
		expiresAt: refreshExpiresAt,
	};
	await writeJson(kv, kvKeys.mcpAccessToken(accessTokenHash), accessDocument, { expirationTtl: accessTokenTtlSeconds });
	await writeJson(kv, kvKeys.mcpRefreshToken(refreshTokenHash), refreshDocument, { expirationTtl: refreshTokenTtlSeconds });
	return {
		accessToken,
		refreshToken,
		tokenType: "Bearer",
		expiresIn: accessTokenTtlSeconds,
		scope: mcpScopeString(grant.scopes),
	};
}

function normalizedClientName(value: string | undefined): string {
	const name = value?.trim();
	return name ? name.slice(0, maxClientNameLength) : "MCP client";
}

function normalizedRedirectUris(values: readonly string[]): string[] {
	const uris = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
	if (uris.length === 0 || uris.length > maxRedirectUris) {
		throw new McpOAuthError("invalid_client_metadata", "MCP client must register one to twenty redirect URIs.");
	}
	for (const uri of uris) {
		const result = redirectUriCspSourceResult(uri);
		switch (result.kind) {
			case "valid":
				break;
			case "invalid_url":
				throw new McpOAuthError("invalid_client_metadata", "Redirect URIs must be absolute URLs.");
			case "fragment":
				throw new McpOAuthError("invalid_client_metadata", "Redirect URIs must not include fragments.");
			case "unsupported_origin":
				throw new McpOAuthError("invalid_client_metadata", "Redirect URIs must use HTTPS or localhost HTTP.");
			case "ipv6_literal":
				throw new McpOAuthError(
					"invalid_client_metadata",
					"IPv6 literal redirect hosts are unsupported because Content Security Policy cannot express them.",
				);
		}
	}
	return uris;
}

type RedirectUriCspSourceResult =
	| { kind: "valid"; source: RedirectUriCspSource }
	| { kind: "invalid_url" }
	| { kind: "fragment" }
	| { kind: "unsupported_origin" }
	| { kind: "ipv6_literal" };

export function redirectUriCspSource(uri: string): RedirectUriCspSource | null {
	const result = redirectUriCspSourceResult(uri);
	return result.kind === "valid" ? result.source : null;
}

function redirectUriCspSourceResult(uri: string): RedirectUriCspSourceResult {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return { kind: "invalid_url" };
	}
	if (url.hash) {
		return { kind: "fragment" };
	}
	// CSP3 host-source grammar cannot represent bracketed IPv6 literals. The
	// old ::1 comparison was unreachable because WHATWG hostname includes the
	// brackets; reject all IPv6 literal origins instead of registering a callback
	// that the consent page could never authorize.
	if (/[\[\]:]/.test(url.hostname)) {
		return { kind: "ipv6_literal" };
	}
	const isHttps = url.protocol === "https:";
	const isLoopbackHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (!isHttps && !isLoopbackHttp) {
		return { kind: "unsupported_origin" };
	}
	// The origin is the intentional CSP granularity. URL serialization drops
	// userinfo and path/query delimiters, normalizes IDNs, and preserves an exact
	// non-default port without splicing any request text into a response header.
	return { kind: "valid", source: url.origin as RedirectUriCspSource };
}

function normalizedResource(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new McpOAuthError("invalid_request", "MCP resource must be an absolute URL.");
	}
	url.hash = "";
	url.search = "";
	if (url.pathname.endsWith("/") && url.pathname !== "/") {
		url.pathname = url.pathname.replace(/\/+$/, "");
	}
	return url.toString().replace(/\/+$/, "");
}

async function pkceS256(codeVerifier: string): Promise<string> {
	const encoded = new TextEncoder().encode(codeVerifier);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return base64Url(new Uint8Array(digest));
}

function base64Url(data: Uint8Array): string {
	let binary = "";
	for (const byte of data) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
