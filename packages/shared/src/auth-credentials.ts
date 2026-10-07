import { activeAccountProjectionExists } from "./auth-principal";
import type { BrowserSessionDetails } from "./model";
import type { McpScope } from "./mcp-auth";
import { RepositoryError } from "./repository-error";
import type { D1DatabaseLike } from "./storage";

type CredentialBase = {
	id: string; customName: string | null; createdAt: string; expiresAt: string;
};

export type AccountCredential = CredentialBase & (
	| { kind: "session"; browserDetails: BrowserSessionDetails | null; isCurrent: boolean }
	| { kind: "cli_token"; label: string }
	| { kind: "mcp_grant"; clientId: string; clientName: string | null; scopes: McpScope[] }
);

export type AccountCredentialPage = {
	credentials: AccountCredential[]; nextCursor: string | null; legacyMigrationComplete: boolean;
};

type CredentialRow = CredentialBase & {
	kind: AccountCredential["kind"]; label: string | null; browserDetails: string | null;
	clientId: string | null; clientName: string | null; scopes: string | null;
};

export async function listAccountCredentials(db: D1DatabaseLike, userId: string, after = "", now = new Date(), currentSessionId: string | null = null): Promise<AccountCredentialPage> {
	const result = await db.prepare(`SELECT credential.record_key AS id, credential.kind,
		json_extract(credential.document, '$.customName') AS customName,
		json_extract(credential.document, '$.label') AS label,
		json_extract(credential.document, '$.browserDetails') AS browserDetails,
		json_extract(credential.document, '$.clientId') AS clientId,
		json_extract(client.document, '$.clientName') AS clientName,
		json_extract(credential.document, '$.scopes') AS scopes,
		json_extract(credential.document, '$.createdAt') AS createdAt, credential.expires_at AS expiresAt
		FROM auth_records AS credential
		LEFT JOIN auth_records AS client ON credential.kind = 'mcp_grant' AND client.kind = 'mcp_client'
			AND client.record_key = 'mcp_client:' || json_extract(credential.document, '$.clientId')
		LEFT JOIN auth_user_revocations AS revocation ON revocation.user_id = credential.user_id
		WHERE credential.user_id = ? AND credential.kind IN ('session', 'cli_token', 'mcp_grant')
		AND credential.record_key > ? AND credential.expires_at > ? AND credential.revoked_at IS NULL
		AND (revocation.revoked_before IS NULL OR revocation.revoked_before < json_extract(credential.document, '$.createdAt'))
		ORDER BY credential.record_key LIMIT 101`)
		.bind(userId, after, now.toISOString()).all<CredentialRow>();
	const rows = result.results ?? [];
	const credentials = rows.slice(0, 100).map((row): AccountCredential => {
		const base: CredentialBase = { id: row.id, customName: row.customName, createdAt: row.createdAt, expiresAt: row.expiresAt };
		switch (row.kind) {
			case "session": return { ...base, kind: row.kind, browserDetails: row.browserDetails ? JSON.parse(row.browserDetails) as BrowserSessionDetails : null, isCurrent: row.id === currentSessionId };
			case "cli_token": return { ...base, kind: row.kind, label: row.label || "Bickr CLI" };
			case "mcp_grant": return { ...base, kind: row.kind, clientId: row.clientId!, clientName: row.clientName, scopes: row.scopes ? JSON.parse(row.scopes) as McpScope[] : [] };
		}
	});
	const transition = await db.prepare("SELECT schema_version FROM auth_storage_transition WHERE id = 1").first<{ schema_version: number }>();
	return { credentials, nextCursor: rows.length > 100 ? rows[99]!.id : null, legacyMigrationComplete: transition?.schema_version === 3 };
}

export async function renameAccountCredential(db: D1DatabaseLike, userId: string, id: string, name: string, now = new Date()): Promise<void> {
	const customName = name.trim();
	if (customName.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
		throw new RepositoryError("bad_request", "Use a name of at most 120 characters without control characters.", 400);
	}
	// Keep the original issuer label/metadata intact. Reset removes only the override.
	const document = customName ? "json_set(document, '$.customName', ?, '$.updatedAt', ?)"
		: "json_set(json_remove(document, '$.customName'), '$.updatedAt', ?)";
	const statement = db.prepare(`UPDATE auth_records SET document = ${document}
		WHERE record_key = ? AND user_id = ? AND kind IN ('session', 'cli_token', 'mcp_grant')
		AND revoked_at IS NULL AND expires_at > ? AND NOT EXISTS
		(SELECT 1 FROM auth_user_revocations WHERE user_id = auth_records.user_id
		AND revoked_before >= json_extract(auth_records.document, '$.createdAt')) AND EXISTS
		(SELECT 1 FROM users_index WHERE user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL)`);
	const parameters = customName ? [customName, now.toISOString()] : [now.toISOString()];
	const result = await statement.bind(...parameters, id, userId, now.toISOString(), userId).run();
	if (!result.meta?.changes) throw new RepositoryError("not_found", "Active access not found.", 404);
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
