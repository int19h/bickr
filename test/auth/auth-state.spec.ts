import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { clearKv, resetD1Schema } from "../helpers/d1-schema";
import { localizedText, type UserDocument } from "../../packages/shared/src/model";
import { kvKeys, type D1DatabaseLike } from "../../packages/shared/src/storage";
import { sha256Hex } from "../../packages/shared/src/ids";
import { authKey, cleanupAuthRecords, consumeAuthRateLimit } from "../../packages/shared/src/auth-store";
import { createMcpAuthorizationCode, exchangeMcpAuthorizationCode, registerMcpClient, refreshMcpTokenSet, authForMcpAccessToken } from "../../packages/shared/src/mcp-auth";
import { approveCliAuthRequest, createCliAuthRequest, pollCliAuthRequest, createSession, userForSessionToken, userForCliToken, deleteCliToken, deleteSession } from "../../packages/shared/src/auth-sessions";
import { listAccountCredentials, revokeAccountCredential, revokeAllAccountCredentials } from "../../packages/shared/src/auth-credentials";
import { migrateLegacyAuthPage, finishLegacyAuthMigration, legacyAuthPrefixes } from "../../packages/shared/src/auth-migration";

const db = env.BICKR_D1;
const kv = env.BICKR_KV;
const resource = "https://bickr.social/mcp";
const now = new Date("2026-10-02T12:00:00.000Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const user: UserDocument = { id: "usr_auth", type: "user", schemaVersion: 1, revision: 1, handle: "auth-user", language: null,
	displayName: localizedText("Auth User", null), profileCompletedAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() };

beforeEach(async () => {
	await resetD1Schema(db);
	await clearKv(kv);
	await db.prepare(`INSERT INTO entity_lifecycle_identity_claims(key_kind,key_scope,key_value,entity_kind,entity_id,owner_user_id,claim_state,created_at,updated_at)
		VALUES ('user_handle','global',?,'account',?,?,'active',?,?)`).bind(user.handle, user.id, user.id, user.createdAt, user.updatedAt).run();
	await db.prepare(`INSERT INTO users_index(user_id,handle,display_name,created_at,updated_at,lifecycle_state)
		VALUES (?,?,'Auth User',?,?,'active')`).bind(user.id, user.handle, user.createdAt, user.updatedAt).run();
	await kv.put(kvKeys.user(user.id), JSON.stringify(user));
});

async function authorization() {
	const client = await registerMcpClient(db, { redirectUris: ["https://client.example/callback"] }, now);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	const challenge = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	const issued = await createMcpAuthorizationCode(db, { clientId: client.id, redirectUri: client.redirectUris[0]!, resource,
		userId: user.id, scopes: ["bickr.read"], codeChallenge: challenge, codeChallengeMethod: "S256" }, now);
	const exchange = { code: issued.code, clientId: client.id, redirectUri: client.redirectUris[0]!, resource, codeVerifier: verifier };
	return { client, issued, exchange };
}

describe("atomic authentication state", () => {
	it("allows only one concurrent code exchange and revokes the grant on replay", async () => {
		const { exchange } = await authorization();
		const results = await Promise.allSettled([exchangeMcpAuthorizationCode(db, exchange, later(1)), exchangeMcpAuthorizationCode(db, exchange, later(1))]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((await db.prepare("SELECT COUNT(*) AS count FROM auth_records WHERE kind = 'mcp_grant'").first<{ count: number }>())?.count).toBe(1);
		for (const result of results) if (result.status === "fulfilled") expect(await authForMcpAccessToken(kv, db, result.value.accessToken, resource, later(2))).toBeNull();
	});

	it("retains refresh lineage and revokes every successor after sequential replay", async () => {
		const { exchange } = await authorization();
		const first = await exchangeMcpAuthorizationCode(db, exchange, later(1));
		const refresh = { refreshToken: first.refreshToken, clientId: exchange.clientId, resource };
		const second = await refreshMcpTokenSet(db, refresh, later(2));
		const third = await refreshMcpTokenSet(db, { ...refresh, refreshToken: second.refreshToken }, later(3));
		await expect(refreshMcpTokenSet(db, refresh, later(4))).rejects.toMatchObject({ code: "invalid_grant" });
		for (const token of [first, second, third]) expect(await authForMcpAccessToken(kv, db, token.accessToken, resource, later(5))).toBeNull();
		await expect(refreshMcpTokenSet(db, { ...refresh, refreshToken: third.refreshToken }, later(5))).rejects.toMatchObject({ code: "invalid_grant" });
	});

	it("does not branch a refresh family under concurrent requests", async () => {
		const { exchange } = await authorization();
		const first = await exchangeMcpAuthorizationCode(db, exchange, later(1));
		const input = { refreshToken: first.refreshToken, clientId: exchange.clientId, resource };
		const results = await Promise.allSettled([refreshMcpTokenSet(db, input, later(2)), refreshMcpTokenSet(db, input, later(2))]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect((await db.prepare("SELECT COUNT(*) AS count FROM auth_records WHERE kind = 'mcp_refresh'").first<{ count: number }>())?.count).toBe(2);
		for (const result of results) if (result.status === "fulfilled") expect(await authForMcpAccessToken(kv, db, result.value.accessToken, resource, later(3))).toBeNull();
	});

	it("does not consume codes or revoke grants for incorrect binding or PKCE parameters", async () => {
		const { exchange } = await authorization();
		await expect(exchangeMcpAuthorizationCode(db, { ...exchange, codeVerifier: "x".repeat(43) }, later(1))).rejects.toMatchObject({ code: "invalid_grant" });
		const tokens = await exchangeMcpAuthorizationCode(db, exchange, later(1));
		await expect(refreshMcpTokenSet(db, { refreshToken: tokens.refreshToken, clientId: "other", resource }, later(2))).rejects.toMatchObject({ code: "invalid_grant" });
		expect(await authForMcpAccessToken(kv, db, tokens.accessToken, resource, later(2))).not.toBeNull();
	});

	it("rolls back consumption if credential creation fails in the transaction", async () => {
		const { exchange } = await authorization();
		const failing: D1DatabaseLike = { prepare: (sql) => db.prepare(sql), batch: (statements) => db.batch([
			...statements, db.prepare("SELECT no_such_column FROM auth_records"),
		] as Parameters<typeof db.batch>[0]) };
		await expect(exchangeMcpAuthorizationCode(failing, exchange, later(1))).rejects.toThrow();
		expect((await exchangeMcpAuthorizationCode(db, exchange, later(2))).accessToken).toMatch(/^bckr_mcp_at_/);
	});

	it("rejects deleting accounts across sessions, CLI, MCP, refresh, and a code read before deletion", async () => {
		const session = await createSession(db, user.id, now);
		const device = await createCliAuthRequest(db, {}, now);
		await approveCliAuthRequest(db, device.deviceCode, user.id, later(1));
		const cli = await pollCliAuthRequest(db, device.deviceCode, later(2));
		if (cli.status !== "complete") throw new Error("CLI approval did not complete.");
		const { exchange } = await authorization();
		const tokens = await exchangeMcpAuthorizationCode(db, exchange, later(1));
		const pending = await authorization();
		await db.prepare("UPDATE users_index SET lifecycle_state = 'deleting' WHERE user_id = ?").bind(user.id).run();
		expect(await userForSessionToken(kv, session.cookieValue, db, later(3))).toBeNull();
		expect(await userForCliToken(kv, cli.token, db, later(3))).toBeNull();
		expect(await authForMcpAccessToken(kv, db, tokens.accessToken, resource, later(3))).toBeNull();
		await expect(refreshMcpTokenSet(db, { refreshToken: tokens.refreshToken, clientId: exchange.clientId, resource }, later(3))).rejects.toMatchObject({ code: "invalid_grant" });
		await expect(exchangeMcpAuthorizationCode(db, pending.exchange, later(3))).rejects.toMatchObject({ code: "invalid_grant" });
	});

	it.each([60, 59, 1])("approves and consumes a CLI request with %i seconds left", async (remaining) => {
		const device = await createCliAuthRequest(db, {}, now);
		await approveCliAuthRequest(db, device.deviceCode, user.id, later(600 - remaining));
		const results = await Promise.all([pollCliAuthRequest(db, device.deviceCode, later(600 - remaining)), pollCliAuthRequest(db, device.deviceCode, later(600 - remaining))]);
		expect(results.filter((result) => result.status === "complete")).toHaveLength(1);
		expect((await db.prepare("SELECT COUNT(*) AS count FROM auth_records WHERE kind = 'cli_token'").first<{ count: number }>())?.count).toBe(1);
	});

	it("preserves legacy CLI access without read repairs, then honors revocation before migration", async () => {
		const token = "bckr_cli_legacy";
		const hash = await sha256Hex(token);
		await kv.put(kvKeys.cliToken(hash), JSON.stringify({ id: "cli_legacy", type: "cliToken", userId: user.id, label: "Old CLI", createdAt: now.toISOString(), expiresAt: later(3600).toISOString() }));
		expect((await userForCliToken(kv, token, db, later(1)))?.id).toBe(user.id);
		expect(await db.prepare("SELECT 1 FROM auth_records WHERE kind = 'cli_token'").first()).toBeNull();
		const dry = await migrateLegacyAuthPage(kv, db, { prefix: "cli_token", dryRun: true, now: later(2) });
		expect(dry.copied).toBe(1);
		expect(await db.prepare("SELECT 1 FROM auth_records WHERE kind = 'cli_token'").first()).toBeNull();
		await deleteCliToken(kv, db, token, later(3));
		await migrateLegacyAuthPage(kv, db, { prefix: "cli_token", dryRun: false, now: later(4) });
		expect(await userForCliToken(kv, token, db, later(5))).toBeNull();
	});

	it("enforces the fixed legacy cutoff and revokes unindexed legacy credentials with all-access revocation", async () => {
		const token = "legacy-session";
		await kv.put(kvKeys.session(await sha256Hex(token)), JSON.stringify({ id: "sid_old", type: "session", userId: user.id, createdAt: now.toISOString(), expiresAt: later(3600).toISOString() }));
		await revokeAllAccountCredentials(db, user.id, later(1));
		expect(await userForSessionToken(kv, token, db, later(2))).toBeNull();
		await db.prepare("DELETE FROM auth_user_revocations").run();
		await db.prepare("UPDATE auth_storage_transition SET legacy_until = ?").bind(later(3).toISOString()).run();
		expect(await userForSessionToken(kv, token, db, later(4))).toBeNull();
	});

	it("revokes pending approvals as well as inventoried credentials", async () => {
		await createSession(db, user.id, now);
		const { exchange } = await authorization();
		const device = await createCliAuthRequest(db, {}, now);
		await approveCliAuthRequest(db, device.deviceCode, user.id, later(1));
		expect((await listAccountCredentials(db, user.id, "", later(1))).credentials).toHaveLength(1);
		await revokeAllAccountCredentials(db, user.id, later(2));
		await expect(exchangeMcpAuthorizationCode(db, exchange, later(3))).rejects.toMatchObject({ code: "invalid_grant" });
		expect((await pollCliAuthRequest(db, device.deviceCode, later(3))).status).toBe("expired");
	});

	it("bounds registration attempts and expired-row cleanup", async () => {
		const admitted = await Promise.all(Array.from({ length: 25 }, () => consumeAuthRateLimit(db, "register", "203.0.113.1", now)));
		expect(admitted.filter(Boolean)).toHaveLength(20);
		await db.prepare(`INSERT INTO auth_records(record_key,kind,expires_at,document)
			WITH RECURSIVE count(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM count WHERE n < 510)
			SELECT 'session:expired-' || n, 'session', ?, '{}' FROM count`).bind(now.toISOString()).run();
		await cleanupAuthRecords(db, later(1));
		expect((await db.prepare("SELECT COUNT(*) AS count FROM auth_records").first<{ count: number }>())?.count).toBe(10);
		expect(await db.prepare("SELECT 1 FROM auth_records WHERE record_key = ?").bind(authKey("mcp_access", "absent")).first()).toBeNull();
	});
	it("preserves valid legacy credentials in bounded pages and closes the reader only after every prefix", async () => {
		for (let n = 0; n < 51; n++) {
			await kv.put(kvKeys.session(await sha256Hex(`legacy-${n}`)), JSON.stringify({ id: `sid_${n}`, type: "session", userId: user.id,
				createdAt: now.toISOString(), expiresAt: later(3600).toISOString() }));
		}
		expect(await finishLegacyAuthMigration(db)).toBe(false);
		const first = await migrateLegacyAuthPage(kv, db, { prefix: "session", dryRun: false, now: later(1) });
		expect(first.scanned).toBe(50);
		expect(first.done).toBe(false);
		const second = await migrateLegacyAuthPage(kv, db, { prefix: "session", dryRun: false, now: later(2) });
		expect(second.scanned).toBe(1);
		expect(second.done).toBe(true);
		for (const prefix of Object.keys(legacyAuthPrefixes) as Array<keyof typeof legacyAuthPrefixes>) {
			await migrateLegacyAuthPage(kv, db, { prefix, dryRun: false, now: later(3) });
		}
		expect(await finishLegacyAuthMigration(db)).toBe(true);
		expect((await userForSessionToken(kv, "legacy-0", db, later(4)))?.id).toBe(user.id);
		expect((await userForSessionToken(kv, "legacy-50", db, later(4)))?.id).toBe(user.id);
		expect((await listAccountCredentials(db, user.id, "", later(4))).legacyMigrationComplete).toBe(true);
	});

	it("does not extend a refresh family's absolute expiry", async () => {
		const { exchange } = await authorization();
		const first = await exchangeMcpAuthorizationCode(db, exchange, now);
		const next = await refreshMcpTokenSet(db, { refreshToken: first.refreshToken, clientId: exchange.clientId, resource }, later(90 * 86400 - 30));
		expect(next.expiresIn).toBe(30);
		expect(await authForMcpAccessToken(kv, db, next.accessToken, resource, later(90 * 86400))).toBeNull();
		await expect(refreshMcpTokenSet(db, { refreshToken: next.refreshToken, clientId: exchange.clientId, resource }, later(90 * 86400)))
			.rejects.toMatchObject({ code: "invalid_grant" });
	});

	it("revokes only an owned credential and bounds inventory with a stable cursor", async () => {
		const own = await createSession(db, user.id, now);
		const otherKey = "session:other-account";
		await db.prepare("INSERT INTO auth_records(record_key,kind,user_id,expires_at,document) VALUES (?,'session','other',?,'{}')")
			.bind(otherKey, later(100).toISOString()).run();
		await expect(revokeAccountCredential(db, user.id, otherKey, later(1))).rejects.toMatchObject({ status: 404 });
		const inventory = await listAccountCredentials(db, user.id, "", later(1));
		expect(inventory.credentials).toHaveLength(1);
		await revokeAccountCredential(db, user.id, inventory.credentials[0]!.id, later(2));
		expect(await userForSessionToken(kv, own.cookieValue, db, later(3))).toBeNull();
		await db.prepare(`INSERT INTO auth_records(record_key,kind,user_id,expires_at,document)
			WITH RECURSIVE count(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM count WHERE n < 102)
			SELECT 'cli_token:page-' || n, 'cli_token', ?, ?, '{"createdAt":"2026-10-02T12:00:00.000Z","label":"CLI"}' FROM count`)
			.bind(user.id, later(100).toISOString()).run();
		const page = await listAccountCredentials(db, user.id, "", later(3));
		expect(page.credentials).toHaveLength(100);
		const end = await listAccountCredentials(db, user.id, page.nextCursor!, later(3));
		expect(end.credentials).toHaveLength(3);
		expect(end.nextCursor).toBeNull();
		expect(new Set([...page.credentials, ...end.credentials].map((row) => row.id)).size).toBe(103);
	});

	it("keeps rate-counter storage bounded when addresses rotate after global admission closes", async () => {
		for (let n = 0; n < 210; n++) await consumeAuthRateLimit(db, "register", `address-${n}`, now);
		expect((await db.prepare("SELECT COUNT(*) AS count FROM auth_rate_buckets").first<{ count: number }>())?.count).toBe(201);
		expect(await consumeAuthRateLimit(db, "register", "address-210", later(3600))).toBe(true);
	});

	it("does not allocate revocation records for unknown credentials or new-format logout", async () => {
		for (const token of ["random", "bckr_cli_v2_unknown", "bckr_session_v2_unknown"]) {
			await deleteCliToken(kv, db, token, now);
			await deleteSession(kv, db, token, now);
		}
		expect(await db.prepare("SELECT 1 FROM auth_records").first()).toBeNull();
		const session = await createSession(db, user.id, now);
		await deleteSession(kv, db, session.cookieValue, later(1));
		expect(await db.prepare("SELECT 1 FROM auth_records WHERE kind = 'revoked_legacy'").first()).toBeNull();
		expect(await userForSessionToken(kv, session.cookieValue, db, later(2))).toBeNull();
	});

	it("reports malformed legacy JSON without pinning the migration page", async () => {
		const key = kvKeys.cliToken("malformed");
		await kv.put(key, "{");
		expect(await migrateLegacyAuthPage(kv, db, { prefix: "cli_token", dryRun: true, now })).toMatchObject({ scanned: 1, invalid: 1 });
		expect(await kv.get(key)).toBe("{");
		expect(await migrateLegacyAuthPage(kv, db, { prefix: "cli_token", dryRun: false, now })).toMatchObject({ scanned: 1, invalid: 1, done: true });
		expect(await kv.get(key)).toBeNull();
	});

});
