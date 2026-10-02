import { activeAccountProjectionExists } from "./auth-principal";
import { RepositoryError } from "./repository-error";
import type { D1DatabaseLike } from "./storage";

export type AccountCredential = {
	id: string; kind: "session" | "cli_token" | "mcp_grant"; label: string;
	createdAt: string; expiresAt: string; revokedAt: string | null;
};

export async function listAccountCredentials(db: D1DatabaseLike, userId: string, after = "", now = new Date()): Promise<{ credentials: AccountCredential[]; nextCursor: string | null; legacyMigrationComplete: boolean }> {
	const result = await db.prepare(`SELECT record_key AS id, kind,
		COALESCE(json_extract(document, '$.label'), json_extract(document, '$.clientId'), 'Browser session') AS label,
		json_extract(document, '$.createdAt') AS createdAt, expires_at AS expiresAt,
		COALESCE(revoked_at, (SELECT revoked_before FROM auth_user_revocations WHERE user_id = ?
		AND revoked_before >= json_extract(document, '$.createdAt'))) AS revokedAt
		FROM auth_records WHERE user_id = ? AND kind IN ('session', 'cli_token', 'mcp_grant')
		AND record_key > ? AND expires_at > ? ORDER BY record_key LIMIT 101`)
		.bind(userId, userId, after, now.toISOString()).all<AccountCredential>();
	const rows = result.results ?? [];
	const transition = await db.prepare("SELECT schema_version FROM auth_storage_transition WHERE id = 1").first<{ schema_version: number }>();
	return { credentials: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99]!.id : null, legacyMigrationComplete: transition?.schema_version === 3 };
}

export async function revokeAccountCredential(db: D1DatabaseLike, userId: string, id: string, now = new Date()): Promise<void> {
	const result = await db.prepare(`UPDATE auth_records SET revoked_at = ? WHERE record_key = ? AND user_id = ?
		AND kind IN ('session', 'cli_token', 'mcp_grant') AND EXISTS
		(SELECT 1 FROM users_index WHERE user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL)`)
		.bind(now.toISOString(), id, userId, userId).run();
	if (!result.meta?.changes) throw new RepositoryError("not_found", "Credential not found.", 404);
}

export async function revokeAllAccountCredentials(db: D1DatabaseLike, userId: string, now = new Date()): Promise<void> {
	if (!await activeAccountProjectionExists(db, userId)) throw new RepositoryError("unauthorized", "The account is no longer active.", 401);
	await db.batch([
		db.prepare(`INSERT INTO auth_user_revocations(user_id, revoked_before) VALUES (?, ?)
			ON CONFLICT(user_id) DO UPDATE SET revoked_before = MAX(revoked_before, excluded.revoked_before)`)
			.bind(userId, now.toISOString()),
		// Pending consent/device approvals are revoked too. A previously read
		// request must not mint a fresh grant after the owner revokes all access.
		db.prepare("UPDATE auth_records SET revoked_at = ? WHERE user_id = ?").bind(now.toISOString(), userId),
	]);
}
