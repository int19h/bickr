import { randomToken, sha256Hex } from "./ids";
import { schemaVersion, type UserDocument } from "./model";
import { type D1DatabaseLike, type KVNamespaceLike } from "./storage";
import { activeUser } from "./auth-principal";
import { authKey, insertAuthRecord, insertClaimedAuthRecord, readAuthRecord } from "./auth-store";

export const mcpScopes = ["bickr.read", "bickr.write", "bickr.runtime"] as const;
export type McpScope = (typeof mcpScopes)[number];

declare const mcpRedirectOriginBrand: unique symbol;
export type McpRedirectOrigin = string & { readonly [mcpRedirectOriginBrand]: true };

export type McpClientDocument = {
	id: string;
	type: "mcpClient";
	schemaVersion: number;
	clientName: string;
	redirectUris: string[];
	tokenEndpointAuthMethod: "none";
	expiresAt: string;
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
	expiresAt: string;
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
	db: D1DatabaseLike,
	input: { clientName?: string; redirectUris: string[]; tokenEndpointAuthMethod?: string },
	now = new Date(),
): Promise<McpClientDocument> {
	const redirectUris = normalizedRedirectUris(input.redirectUris);
	if (input.tokenEndpointAuthMethod && input.tokenEndpointAuthMethod !== "none") {
		throw new McpOAuthError("invalid_client_metadata", "Bickr MCP supports public OAuth clients only.");
	}
	const client: McpClientDocument = {
		id: `bckr_mcp_client_${randomToken(18)}`, type: "mcpClient", schemaVersion,
		clientName: normalizedClientName(input.clientName), redirectUris, tokenEndpointAuthMethod: "none",
		createdAt: now.toISOString(), updatedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 30 * 86400_000).toISOString(),
	};
	await insertAuthRecord(db, "mcp_client", client.id, client, client.expiresAt).run();
	return client;
}

export async function readMcpClient(db: D1DatabaseLike, clientId: string, now = new Date()): Promise<McpClientDocument | null> {
	const row = await readAuthRecord<McpClientDocument>(db, "mcp_client", clientId.trim());
	return row && row.expiresAt > now.toISOString() ? { ...row.document, expiresAt: row.expiresAt } : null;
}

export async function createMcpAuthorizationCode(
	db: D1DatabaseLike,
	input: {
		clientId: string; redirectUri: string; resource: string; userId: string;
		scopes: readonly string[]; codeChallenge: string; codeChallengeMethod: string;
	},
	now = new Date(),
): Promise<{ code: string; document: McpAuthorizationCodeDocument }> {
	const client = await readMcpClient(db, input.clientId, now);
	if (!client) throw new McpOAuthError("invalid_client", "MCP client is not registered or has expired.", 401);
	if (!client.redirectUris.includes(input.redirectUri)) {
		throw new McpOAuthError("invalid_request", "Redirect URI is not registered for this MCP client.");
	}
	if (input.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
		throw new McpOAuthError("invalid_request", "MCP authorization requires a valid PKCE S256 challenge.");
	}
	const code = `bckr_mcp_code_${randomToken(24)}`;
	const codeHash = await sha256Hex(code);
	const document: McpAuthorizationCodeDocument = {
		id: `mcp_code_${codeHash.slice(0, 32)}`, type: "mcpAuthorizationCode", clientId: client.id,
		redirectUri: input.redirectUri, resource: normalizedResource(input.resource), userId: input.userId,
		scopes: normalizeMcpScopes(input.scopes), codeChallenge: input.codeChallenge, codeChallengeMethod: "S256",
		createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + authorizationCodeTtlSeconds * 1000).toISOString(),
	};
	const results = await db.batch([
		db.prepare(`INSERT INTO auth_records(record_key, kind, user_id, expires_at, document)
			SELECT ?, 'mcp_code', ?, ?, ? WHERE EXISTS
			(SELECT 1 FROM users_index WHERE user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL)
			AND EXISTS (SELECT 1 FROM auth_records WHERE record_key = ? AND expires_at > ?)`)
			.bind(authKey("mcp_code", codeHash), input.userId, document.expiresAt, JSON.stringify(document), input.userId,
				authKey("mcp_client", client.id), now.toISOString()),
		db.prepare(`UPDATE auth_records SET expires_at = ? WHERE record_key = ?
			AND EXISTS (SELECT 1 FROM auth_records WHERE record_key = ?)`)
			.bind(new Date(now.getTime() + 180 * 86400_000).toISOString(), authKey("mcp_client", client.id), authKey("mcp_code", codeHash)),
	]);
	if (!results[0]?.meta?.changes) throw new McpOAuthError("access_denied", "The account or MCP client is no longer active.", 403);
	console.info({ event: "mcp_oauth_authorization_code_issued", codeDocumentId: document.id, clientId: client.id });
	return { code, document };
}

export async function exchangeMcpAuthorizationCode(
	db: D1DatabaseLike,
	input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; resource: string },
	now = new Date(),
): Promise<McpTokenSet> {
	const codeHash = await sha256Hex(input.code);
	const row = await readAuthRecord<McpAuthorizationCodeDocument>(db, "mcp_code", codeHash);
	const code = row?.document;
	if (!row || !code || row.expiresAt <= now.toISOString()) throw invalidGrant("Authorization code is invalid or expired.");
	if (code.clientId !== input.clientId || code.redirectUri !== input.redirectUri || code.resource !== normalizedResource(input.resource)) {
		throw invalidGrant("Authorization code was issued for different client parameters.");
	}
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) || await pkceS256(input.codeVerifier) !== code.codeChallenge) {
		throw invalidGrant("PKCE verifier did not match this authorization code.");
	}
	const createdAt = now.toISOString();
	const grant: McpGrantDocument = {
		id: `mcp_grant_${randomToken(18)}`, type: "mcpGrant", schemaVersion, clientId: code.clientId,
		userId: code.userId, resource: code.resource, scopes: code.scopes, createdAt, updatedAt: createdAt,
		expiresAt: new Date(now.getTime() + refreshTokenTtlSeconds * 1000).toISOString(),
	};
	const claim = randomToken(24);
	const sourceKey = authKey("mcp_code", codeHash);
	const tokens = await prepareTokenSet(grant, now);
	const results = await db.batch([
		revokeReplayedGrant(db, sourceKey, now),
		db.prepare(`UPDATE auth_records SET consumed_by = ?, grant_id = ? WHERE record_key = ?
			AND consumed_by IS NULL AND revoked_at IS NULL AND expires_at > ? AND EXISTS
			(SELECT 1 FROM users_index WHERE user_id = auth_records.user_id AND lifecycle_state = 'active' AND deleted_at IS NULL)`)
			.bind(claim, grant.id, sourceKey, createdAt),
		insertClaimedAuthRecord(db, "mcp_grant", grant.id, grant, grant.expiresAt, { userId: grant.userId }, sourceKey, claim),
		...tokenStatements(db, tokens, sourceKey, claim),
	]);
	if (!results[1]?.meta?.changes) throw invalidGrant("Authorization code is expired, consumed, or belongs to an inactive account.");
	console.info({ event: "mcp_oauth_authorization_code_redeemed", codeDocumentId: code.id, clientId: code.clientId });
	return tokens.response;
}

export async function refreshMcpTokenSet(
	db: D1DatabaseLike,
	input: { refreshToken: string; clientId: string; resource: string },
	now = new Date(),
): Promise<McpTokenSet> {
	const hash = await sha256Hex(input.refreshToken);
	const row = await readAuthRecord<McpRefreshTokenDocument>(db, "mcp_refresh", hash);
	const refresh = row?.document;
	if (!row || !refresh || row.expiresAt <= now.toISOString()) throw invalidGrant("Refresh token is invalid or expired.");
	if (refresh.clientId !== input.clientId || refresh.resource !== normalizedResource(input.resource)) {
		throw invalidGrant("Refresh token was issued for different client parameters.");
	}
	const grantRow = await readAuthRecord<McpGrantDocument>(db, "mcp_grant", refresh.grantId);
	if (!grantRow || grantRow.revokedAt || grantRow.expiresAt <= now.toISOString()) throw invalidGrant("Refresh token grant is no longer active.");
	const grant = grantRow.document;
	const claim = randomToken(24);
	const sourceKey = authKey("mcp_refresh", hash);
	const tokens = await prepareTokenSet(grant, now);
	const results = await db.batch([
		revokeReplayedGrant(db, sourceKey, now),
		db.prepare(`UPDATE auth_records SET consumed_by = ? WHERE record_key = ? AND consumed_by IS NULL AND revoked_at IS NULL AND expires_at > ?
			AND EXISTS (SELECT 1 FROM users_index WHERE user_id = auth_records.user_id AND lifecycle_state = 'active' AND deleted_at IS NULL)
			AND EXISTS (SELECT 1 FROM auth_records AS grant_row WHERE grant_row.record_key = ? AND grant_row.revoked_at IS NULL AND grant_row.expires_at > ?)`)
			.bind(claim, sourceKey, now.toISOString(), authKey("mcp_grant", grant.id), now.toISOString()),
		...tokenStatements(db, tokens, sourceKey, claim),
	]);
	if (!results[1]?.meta?.changes) throw invalidGrant("Refresh token was consumed or its grant is no longer active. Authorize the client again.");
	return tokens.response;
}

function revokeReplayedGrant(db: D1DatabaseLike, sourceKey: string, now: Date) {
	// This runs inside the exchange transaction, including when two callers
	// initially read the same unused token. The losing caller revokes the winner.
	return db.prepare(`UPDATE auth_records SET revoked_at = ? WHERE kind = 'mcp_grant' AND record_key =
		(SELECT 'mcp_grant:' || grant_id FROM auth_records WHERE record_key = ? AND consumed_by IS NOT NULL)`)
		.bind(now.toISOString(), sourceKey);
}

export async function revokeMcpToken(
	db: D1DatabaseLike, input: { token: string; clientId: string; resource: string }, now = new Date(),
): Promise<void> {
	const hash = await sha256Hex(input.token);
	await db.prepare(`UPDATE auth_records SET revoked_at = ? WHERE kind = 'mcp_grant' AND grant_id IS NULL AND record_key IN
		(SELECT 'mcp_grant:' || grant_id FROM auth_records WHERE record_key IN (?, ?)
		AND json_extract(document, '$.clientId') = ? AND json_extract(document, '$.resource') = ?)`)
		.bind(now.toISOString(), authKey("mcp_refresh", hash), authKey("mcp_access", hash), input.clientId, normalizedResource(input.resource)).run();
}

export async function authForMcpAccessToken(
	kv: KVNamespaceLike, db: D1DatabaseLike, token: string | null | undefined, resource: string, now = new Date(),
): Promise<McpAuthContext | null> {
	if (!token) return null;
	const row = await db.prepare(`SELECT token.document AS token, grant_row.document AS grantDocument FROM auth_records AS token
		JOIN auth_records AS grant_row ON grant_row.record_key = 'mcp_grant:' || token.grant_id
		WHERE token.record_key = ? AND token.kind = 'mcp_access' AND token.expires_at > ? AND token.revoked_at IS NULL
		AND grant_row.revoked_at IS NULL AND grant_row.expires_at > ?`)
		.bind(authKey("mcp_access", await sha256Hex(token)), now.toISOString(), now.toISOString())
		.first<{ token: string; grantDocument: string }>();
	if (!row) return null;
	const document = JSON.parse(row.token) as McpAccessTokenDocument;
	if (document.resource !== normalizedResource(resource)) return null;
	const user = await activeUser(kv, db, document.userId);
	return user ? { user, grant: JSON.parse(row.grantDocument) as McpGrantDocument, token: document, scopes: new Set(document.scopes) } : null;
}

function invalidGrant(message: string): McpOAuthError { return new McpOAuthError("invalid_grant", message); }

export function normalizeMcpScopes(values: readonly string[] | string | null | undefined): McpScope[] {
	const raw = typeof values === "string" ? values.split(/\s+/) : values ?? [];
	const scopes = raw.filter((scope): scope is McpScope => (mcpScopes as readonly string[]).includes(scope));
	return scopes.length ? [...new Set(scopes)] : ["bickr.read"];
}

export function mcpScopeString(scopes: readonly McpScope[]): string {
	return scopes.join(" ");
}

async function prepareTokenSet(grant: McpGrantDocument, now: Date) {
	const accessToken = `bckr_mcp_at_${randomToken(32)}`;
	const refreshToken = `bckr_mcp_rt_${randomToken(32)}`;
	const accessHash = await sha256Hex(accessToken);
	const refreshHash = await sha256Hex(refreshToken);
	const expiresIn = Math.min(accessTokenTtlSeconds, Math.floor((Date.parse(grant.expiresAt) - now.getTime()) / 1000));
	const common = { grantId: grant.id, clientId: grant.clientId, userId: grant.userId, resource: grant.resource,
		scopes: [...grant.scopes], createdAt: now.toISOString() };
	const access: McpAccessTokenDocument = { ...common, id: `mcp_at_${accessHash.slice(0, 32)}`, type: "mcpAccessToken",
		expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString() };
	const refresh: McpRefreshTokenDocument = { ...common, id: `mcp_rt_${refreshHash.slice(0, 32)}`, type: "mcpRefreshToken", expiresAt: grant.expiresAt };
	return { accessHash, refreshHash, access, refresh,
		response: { accessToken, refreshToken, tokenType: "Bearer", expiresIn, scope: mcpScopeString(grant.scopes) } satisfies McpTokenSet };
}

function tokenStatements(db: D1DatabaseLike, tokens: Awaited<ReturnType<typeof prepareTokenSet>>, sourceKey: string, claim: string) {
	const owner = { userId: tokens.access.userId, grantId: tokens.access.grantId };
	return [
		insertClaimedAuthRecord(db, "mcp_access", tokens.accessHash, tokens.access, tokens.access.expiresAt, owner, sourceKey, claim),
		insertClaimedAuthRecord(db, "mcp_refresh", tokens.refreshHash, tokens.refresh, tokens.refresh.expiresAt, owner, sourceKey, claim),
	];
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
		if (uri.length > 2048) throw new McpOAuthError("invalid_client_metadata", "Redirect URI exceeds 2048 characters.");
		const result = mcpRedirectOriginResult(uri);
		switch (result.kind) {
			case "valid":
				break;
			case "invalid_url":
				throw new McpOAuthError("invalid_client_metadata", "Redirect URIs must be absolute URLs.");
			case "fragment":
				throw new McpOAuthError("invalid_client_metadata", "Redirect URIs must not include fragments.");
			case "unsupported_origin":
				throw new McpOAuthError("invalid_client_metadata", "Redirect URIs must use HTTPS or localhost HTTP.");
			case "credentials":
				throw new McpOAuthError("invalid_client_metadata", "Redirect URIs must not contain credentials.");
		}
	}
	return uris;
}

type McpRedirectOriginResult =
	| { kind: "valid"; source: McpRedirectOrigin }
	| { kind: "invalid_url" }
	| { kind: "fragment" }
	| { kind: "unsupported_origin" }
	| { kind: "credentials" };

export function mcpRedirectOrigin(uri: string): McpRedirectOrigin | null {
	const result = mcpRedirectOriginResult(uri);
	return result.kind === "valid" ? result.source : null;
}

function mcpRedirectOriginResult(uri: string): McpRedirectOriginResult {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return { kind: "invalid_url" };
	}
	if (url.hash) {
		return { kind: "fragment" };
	}
	if (url.username || url.password) return { kind: "credentials" };
	const isHttps = url.protocol === "https:";
	const isLoopbackHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
	if (!isHttps && !isLoopbackHttp) {
		return { kind: "unsupported_origin" };
	}
	return { kind: "valid", source: url.origin as McpRedirectOrigin };
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
