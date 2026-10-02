import { authKey, type AuthRecordKind } from "./auth-store";
import { type D1DatabaseLike, type D1PreparedStatementLike, type KVNamespaceLike } from "./storage";

export const legacyAuthPrefixes = {
	session: "v1:session:", cli_token: "v1:cli-token:", mcp_client: "v1:mcp-client:",
	cli_request: "v1:cli-auth-request:", mcp_code: "v1:mcp-authorization-code:",
	mcp_access: "v1:mcp-access-token:", mcp_refresh: "v1:mcp-refresh-token:", mcp_grant: "v1:mcp-grant:",
} as const;
export type LegacyAuthPrefix = keyof typeof legacyAuthPrefixes;
export type AuthMigrationKV = KVNamespaceLike & {
	list(options: { prefix: string; cursor?: string; limit: number }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
};
export type AuthMigrationPage = { prefix: LegacyAuthPrefix; scanned: number; copied: number; retired: number; invalid: number; cursor: string | null; done: boolean; dryRun: boolean };

/** One explicit maintenance page, never called by an authentication reader.
 * Run after old writers stop. Dry runs neither copy/delete KV nor advance D1.
 * The next page can safely retry: imports never overwrite existing/revoked rows. */
export async function migrateLegacyAuthPage(kv: AuthMigrationKV, db: D1DatabaseLike,
	options: { prefix: LegacyAuthPrefix; dryRun: boolean; cursor?: string; now?: Date },
): Promise<AuthMigrationPage> {
	const now = (options.now ?? new Date()).toISOString();
	const prefix = legacyAuthPrefixes[options.prefix];
	const progress = await db.prepare("SELECT cursor, completed_at AS completedAt FROM auth_migration_progress WHERE prefix = ?")
		.bind(options.prefix).first<{ cursor: string | null; completedAt: string | null }>();
	if (!progress) throw new Error("Auth migration prefix is unavailable.");
	const result: AuthMigrationPage = { prefix: options.prefix, scanned: 0, copied: 0, retired: 0, invalid: 0, cursor: null, done: false, dryRun: options.dryRun };
	if (!options.dryRun && progress.completedAt) return { ...result, done: true };
	const cursor = options.dryRun ? options.cursor : progress.cursor ?? undefined;
	const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}), limit: 50 });
	const transition = await db.prepare("SELECT legacy_until AS until FROM auth_storage_transition WHERE id = 1").first<{ until: string }>();
	if (!transition) throw new Error("Auth storage transition is unavailable.");
	const statements: D1PreparedStatementLike[] = [];
	for (const key of page.keys) {
		result.scanned++;
		if (options.prefix === "session" || options.prefix === "cli_token" || options.prefix === "mcp_client") {
			const raw = await kv.get(key.name, { type: "json" });
			const document = legacyDocument(raw, options.prefix, transition.until, now);
			if (document) {
				result.copied++;
				const id = key.name.slice(prefix.length);
				statements.push(db.prepare(`INSERT INTO auth_records(record_key, kind, user_id, expires_at, document)
					SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM auth_records WHERE record_key = ?)
					ON CONFLICT(record_key) DO NOTHING`)
					.bind(authKey(options.prefix, id), options.prefix, document.userId ?? null, document.expiresAt,
						JSON.stringify(document), authKey("revoked_legacy", id)));
			} else if (raw !== null) result.invalid++;
		} else result.retired++;
	}
	result.done = page.list_complete;
	result.cursor = page.list_complete ? null : page.cursor ?? null;
	if (!page.list_complete && !result.cursor) throw new Error("KV returned an incomplete auth page without a cursor.");
	if (!options.dryRun) {
		// Keep source keys until after the complete D1 batch commits. Retries use
		// INSERT DO NOTHING, so they cannot undo logout or family revocation.
		if (statements.length) await db.batch(statements);
		for (const key of page.keys) await kv.delete(key.name);
		await db.prepare(`UPDATE auth_migration_progress SET cursor = ?, completed_at = ?
			WHERE prefix = ? AND cursor IS ? AND completed_at IS NULL`)
			.bind(result.cursor, result.done ? now : null, options.prefix, progress.cursor).run();
	}
	return result;
}

// A single adapter recognizes the pre-D1 documents. Invalid/expired rows are
// retired, not repaired into apparently valid credentials.
function legacyDocument(value: unknown, kind: Extract<AuthRecordKind, "session" | "cli_token" | "mcp_client">, clientExpiry: string, now: string): (Record<string, unknown> & { userId?: string; expiresAt: string }) | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const expectedType = { session: "session", cli_token: "cliToken", mcp_client: "mcpClient" }[kind];
	if (row.type !== expectedType || typeof row.id !== "string" || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))) return null;
	if (kind === "mcp_client") {
		if (!Array.isArray(row.redirectUris) || !row.redirectUris.every((uri) => typeof uri === "string") || typeof row.clientName !== "string" || clientExpiry <= now) return null;
		return { ...row, expiresAt: clientExpiry };
	}
	if (typeof row.userId !== "string" || typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt)) || row.expiresAt <= now) return null;
	return { ...row, userId: row.userId, expiresAt: row.expiresAt };
}

export async function finishLegacyAuthMigration(db: D1DatabaseLike): Promise<boolean> {
	const result = await db.prepare(`UPDATE auth_storage_transition SET schema_version = 3 WHERE id = 1
		AND NOT EXISTS (SELECT 1 FROM auth_migration_progress WHERE completed_at IS NULL)`).run();
	return Boolean(result.meta?.changes);
}
