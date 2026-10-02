import { randomToken, sha256Hex } from "./ids";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./storage";

export type AuthRecordKind = "session" | "cli_token" | "cli_request" | "mcp_client" | "mcp_code" |
	"mcp_grant" | "mcp_access" | "mcp_refresh" | "revoked_legacy";
export type AuthRecord<T> = { document: T; consumedBy: string | null; revokedAt: string | null; expiresAt: string };

export function authKey(kind: AuthRecordKind, id: string): string { return `${kind}:${id}`; }

export async function readAuthRecord<T>(db: D1DatabaseLike, kind: AuthRecordKind, id: string): Promise<AuthRecord<T> | null> {
	const row = await db.prepare(`SELECT document, consumed_by AS consumedBy, revoked_at AS revokedAt, expires_at AS expiresAt
		FROM auth_records WHERE record_key = ? AND kind = ?`).bind(authKey(kind, id), kind)
		.first<{ document: string; consumedBy: string | null; revokedAt: string | null; expiresAt: string }>();
	return row ? { ...row, document: JSON.parse(row.document) as T } : null;
}

export function insertAuthRecord(
	db: D1DatabaseLike, kind: AuthRecordKind, id: string, document: unknown, expiresAt: string,
	owner: { userId?: string; grantId?: string } = {},
): D1PreparedStatementLike {
	return db.prepare(`INSERT INTO auth_records(record_key, kind, user_id, grant_id, expires_at, document)
		VALUES (?, ?, ?, ?, ?, ?)`).bind(authKey(kind, id), kind, owner.userId ?? null, owner.grantId ?? null, expiresAt, JSON.stringify(document));
}

/** The caller must use this in the same D1 batch as the conditional consume.
 * Only the request whose random claim won can create a successor credential. */
export function insertClaimedAuthRecord(
	db: D1DatabaseLike, kind: AuthRecordKind, id: string, document: unknown, expiresAt: string,
	owner: { userId: string; grantId?: string }, sourceKey: string, claim: string,
): D1PreparedStatementLike {
	return db.prepare(`INSERT INTO auth_records(record_key, kind, user_id, grant_id, expires_at, document)
		SELECT ?, ?, ?, ?, ?, ? FROM auth_records WHERE record_key = ? AND consumed_by = ?`)
		.bind(authKey(kind, id), kind, owner.userId, owner.grantId ?? null, expiresAt, JSON.stringify(document), sourceKey, claim);
}

export async function cleanupAuthRecords(db: D1DatabaseLike, now = new Date()): Promise<number> {
	const results = await db.batch([
		db.prepare(`DELETE FROM auth_records WHERE record_key IN
			(SELECT record_key FROM auth_records WHERE expires_at <= ? ORDER BY expires_at, record_key LIMIT 500)`).bind(now.toISOString()),
		db.prepare(`DELETE FROM auth_rate_buckets WHERE bucket_key IN
			(SELECT bucket_key FROM auth_rate_buckets WHERE expires_at <= ? ORDER BY expires_at, bucket_key LIMIT 500)`).bind(now.toISOString()),
	]);
	return results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
}

/** Counts attempts atomically, with fixed retention and no IP address storage.
 * Global admission bounds storage growth even when callers change addresses. */
export async function consumeAuthRateLimit(db: D1DatabaseLike, operation: "register" | "cli_start", address: string, now = new Date()): Promise<boolean> {
	const window = Math.floor(now.getTime() / 3_600_000);
	const expiresAt = new Date((window + 2) * 3_600_000).toISOString();
	const subject = await sha256Hex(address);
	const globalKey = `${operation}:${window}:global`;
	const addressKey = `${operation}:${window}:${subject}`;
	const claim = randomToken(18);
	// Rejecting one address must not drain the global allowance. Rejecting the
	// global allowance must not create unlimited rows for random addresses.
	const results = await db.batch([
		db.prepare(`INSERT INTO auth_rate_buckets(bucket_key, hits, expires_at, last_admission)
			SELECT ?, 1, ?, ? WHERE COALESCE((SELECT hits FROM auth_rate_buckets WHERE bucket_key = ?), 0) < 20
			ON CONFLICT(bucket_key) DO UPDATE SET hits = hits + 1, last_admission = excluded.last_admission WHERE hits < 200`)
			.bind(globalKey, expiresAt, claim, addressKey),
		db.prepare(`INSERT INTO auth_rate_buckets(bucket_key, hits, expires_at)
			SELECT ?, 1, ? WHERE EXISTS (SELECT 1 FROM auth_rate_buckets WHERE bucket_key = ? AND last_admission = ?)
			ON CONFLICT(bucket_key) DO UPDATE SET hits = hits + 1`)
			.bind(addressKey, expiresAt, globalKey, claim),
	]);
	return Boolean(results[1]?.meta?.changes);
}
