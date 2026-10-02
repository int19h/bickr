import { randomToken, sha256Hex } from "./ids";
import { schemaVersion, type SessionDocument, type UserDocument } from "./model";
import { kvKeys, readJson, type KVNamespaceLike, type D1DatabaseLike } from "./storage";
import { RepositoryError } from "./repository-error";
import { activeUser } from "./auth-principal";
import { authKey, insertClaimedAuthRecord, readAuthRecord } from "./auth-store";

export type SessionCreateResult = {
	cookieValue: string;
	session: SessionDocument;
};

export type CliAuthRequestDocument = {
	id: string;
	type: "cliAuthRequest";
	label: string;
	userId?: string;
	approvedAt?: string;
	consumedAt?: string;
	createdAt: string;
	expiresAt: string;
	updatedAt: string;
};

export type CliAuthStartResult = {
	deviceCode: string;
	request: CliAuthRequestDocument;
};

export type CliAuthPollResult =
	| { status: "pending"; expiresAt: string }
	| { status: "expired"; expiresAt: string }
	| { status: "complete"; token: string; expiresAt: string };

export type CliTokenDocument = {
	id: string;
	type: "cliToken";
	userId: string;
	label: string;
	createdAt: string;
	expiresAt: string;
	updatedAt: string;
};

const sessionTtlSeconds = 60 * 60 * 24 * 30;
const cliAuthRequestTtlSeconds = 10 * 60;
const cliTokenTtlSeconds = 60 * 60 * 24 * 90;

export async function createSession(db: D1DatabaseLike, userId: string, now = new Date()): Promise<SessionCreateResult> {
	const cookieValue = `bckr_session_v2_${randomToken()}`;
	const hash = await sha256Hex(cookieValue);
	const createdAt = now.toISOString();
	const session: SessionDocument = {
		id: `sid_${hash.slice(0, 32)}`, type: "session", schemaVersion, revision: 1, userId,
		createdAt, updatedAt: createdAt, expiresAt: new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString(),
	};
	const result = await db.prepare(`INSERT INTO auth_records(record_key, kind, user_id, expires_at, document)
		SELECT ?, 'session', ?, ?, ? WHERE EXISTS
		(SELECT 1 FROM users_index WHERE user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL)`)
		.bind(authKey("session", hash), userId, session.expiresAt, JSON.stringify(session), userId).run();
	if (!result.meta?.changes) throw new RepositoryError("unauthorized", "The account is no longer active.", 401);
	return { cookieValue, session };
}

export async function createCliAuthRequest(db: D1DatabaseLike, input: { label?: string } = {}, now = new Date()): Promise<CliAuthStartResult> {
	const deviceCode = randomToken(24);
	const hash = await sha256Hex(deviceCode);
	const request: CliAuthRequestDocument = {
		id: `car_${hash.slice(0, 32)}`, type: "cliAuthRequest", label: input.label?.trim().slice(0, 120) || "Bickr CLI",
		createdAt: now.toISOString(), updatedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + cliAuthRequestTtlSeconds * 1000).toISOString(),
	};
	await db.prepare(`INSERT INTO auth_records(record_key, kind, expires_at, document) VALUES (?, 'cli_request', ?, ?)`)
		.bind(authKey("cli_request", hash), request.expiresAt, JSON.stringify(request)).run();
	return { deviceCode, request };
}

export async function readCliAuthRequest(db: D1DatabaseLike, deviceCode: string, now = new Date()): Promise<CliAuthRequestDocument | null> {
	const row = await readAuthRecord<CliAuthRequestDocument>(db, "cli_request", await sha256Hex(deviceCode));
	return row && row.expiresAt > now.toISOString() && !row.consumedBy && !row.revokedAt ? row.document : null;
}

export async function approveCliAuthRequest(db: D1DatabaseLike, deviceCode: string, userId: string, now = new Date()): Promise<CliAuthRequestDocument> {
	const result = await db.prepare(`UPDATE auth_records SET user_id = ?,
		document = json_set(document, '$.userId', ?, '$.approvedAt', ?, '$.updatedAt', ?)
		WHERE record_key = ? AND consumed_by IS NULL AND revoked_at IS NULL AND expires_at > ? AND (user_id IS NULL OR user_id = ?)
		AND EXISTS (SELECT 1 FROM users_index WHERE user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL)
		RETURNING document`)
		.bind(userId, userId, now.toISOString(), now.toISOString(), authKey("cli_request", await sha256Hex(deviceCode)), now.toISOString(), userId, userId)
		.first<{ document: string }>();
	if (!result) throw new RepositoryError("conflict", "This CLI request is expired, completed, or already approved by another account.", 409);
	return JSON.parse(result.document) as CliAuthRequestDocument;
}

export async function pollCliAuthRequest(db: D1DatabaseLike, deviceCode: string, now = new Date()): Promise<CliAuthPollResult> {
	const hash = await sha256Hex(deviceCode);
	const row = await readAuthRecord<CliAuthRequestDocument>(db, "cli_request", hash);
	if (!row || row.expiresAt <= now.toISOString() || row.consumedBy || row.revokedAt) return { status: "expired", expiresAt: row?.expiresAt ?? now.toISOString() };
	const request = row.document;
	if (!request.userId || !request.approvedAt) return { status: "pending", expiresAt: row.expiresAt };
	const token = `bckr_cli_v2_${randomToken(32)}`;
	const tokenHash = await sha256Hex(token);
	const document: CliTokenDocument = {
		id: `cli_${tokenHash.slice(0, 32)}`, type: "cliToken", userId: request.userId, label: request.label,
		createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + cliTokenTtlSeconds * 1000).toISOString(),
	};
	const key = authKey("cli_request", hash);
	const results = await db.batch([
		db.prepare(`UPDATE auth_records SET consumed_by = ?, document = json_set(document, '$.consumedAt', ?, '$.updatedAt', ?)
			WHERE record_key = ? AND consumed_by IS NULL AND revoked_at IS NULL AND expires_at > ? AND user_id = ?
			AND EXISTS (SELECT 1 FROM users_index WHERE user_id = auth_records.user_id AND lifecycle_state = 'active' AND deleted_at IS NULL)`)
			.bind(tokenHash, now.toISOString(), now.toISOString(), key, now.toISOString(), request.userId),
		insertClaimedAuthRecord(db, "cli_token", tokenHash, document, document.expiresAt, { userId: document.userId }, key, tokenHash),
	]);
	return results[0]?.meta?.changes ? { status: "complete", token, expiresAt: document.expiresAt } : { status: "expired", expiresAt: row.expiresAt };
}

type Credential = SessionDocument | CliTokenDocument;

/** Temporary schema-v2 adapter. It never repairs or writes on reads. The fixed
 * migration cutoff and removal procedure are in docs/auth-storage.md. */
async function readCredential(kv: KVNamespaceLike, db: D1DatabaseLike, kind: "session" | "cli_token", token: string, now: Date): Promise<Credential | null> {
	const hash = await sha256Hex(token);
	const row = await readAuthRecord<Credential>(db, kind, hash);
	let document: Credential;
	if (row) {
		if (row.revokedAt || row.expiresAt <= now.toISOString()) return null;
		document = row.document;
	} else {
		if (token.startsWith("bckr_session_v2_") || token.startsWith("bckr_cli_v2_")) return null;
		const transition = await db.prepare(`SELECT id FROM auth_storage_transition
			WHERE id = 1 AND schema_version = 2 AND legacy_until > ?`).bind(now.toISOString()).first();
		if (!transition) return null;
		const legacy = await readJson<Credential>(kv, kind === "session" ? kvKeys.session(hash) : kvKeys.cliToken(hash));
		if (!legacy || legacy.expiresAt <= now.toISOString()) return null;
		document = legacy;
	}
	// Check the primary after any KV wait, including after a migrated row read.
	// A delayed migration can never restore a token revoked during its scan.
	const revoked = await db.prepare(`SELECT 1 FROM auth_records WHERE record_key = ?
		UNION ALL SELECT 1 FROM auth_user_revocations WHERE user_id = ? AND revoked_before >= ? LIMIT 1`)
		.bind(authKey("revoked_legacy", hash), document.userId, document.createdAt).first();
	return revoked ? null : document;
}

export async function userForSessionToken(kv: KVNamespaceLike, token: string | null | undefined, db: D1DatabaseLike, now = new Date()): Promise<UserDocument | null> {
	if (!token) return null;
	const document = await readCredential(kv, db, "session", token, now);
	return document ? activeUser(kv, db, document.userId) : null;
}

export async function userForCliToken(kv: KVNamespaceLike, token: string | null | undefined, db: D1DatabaseLike, now = new Date()): Promise<UserDocument | null> {
	if (!token) return null;
	const document = await readCredential(kv, db, "cli_token", token, now);
	return document ? activeUser(kv, db, document.userId) : null;
}

async function revokeCredential(kv: KVNamespaceLike, db: D1DatabaseLike, kind: "session" | "cli_token", token: string | null | undefined, now = new Date()): Promise<void> {
	if (!token) return;
	// This exported boundary must remain safe even if a future caller does not
	// authenticate first. Unknown values must not allocate revocation records.
	const credential = await readCredential(kv, db, kind, token, now);
	if (!credential) return;
	const hash = await sha256Hex(token);
	const statements = [db.prepare(`UPDATE auth_records SET revoked_at = ? WHERE record_key = ?`)
		.bind(now.toISOString(), authKey(kind, hash))];
	if (!token.startsWith("bckr_session_v2_") && !token.startsWith("bckr_cli_v2_")) {
		// Only a proven legacy credential needs a marker while KV retires. Keep
		// it until that credential expires, never for a new fixed lifetime.
		statements.push(db.prepare(`INSERT INTO auth_records(record_key, kind, expires_at, document) VALUES (?, 'revoked_legacy', ?, '{}')
			ON CONFLICT(record_key) DO NOTHING`).bind(authKey("revoked_legacy", hash), credential.expiresAt));
	}
	await db.batch(statements);
}

export async function deleteSession(kv: KVNamespaceLike, db: D1DatabaseLike, token: string | null | undefined, now = new Date()): Promise<void> {
	await revokeCredential(kv, db, "session", token, now);
}
export async function deleteCliToken(kv: KVNamespaceLike, db: D1DatabaseLike, token: string | null | undefined, now = new Date()): Promise<void> {
	await revokeCredential(kv, db, "cli_token", token, now);
}
