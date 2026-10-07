import { describe, expect, it } from "vitest";
import { authCookie, testEnv, userIdForHandle } from "../helpers/index-harness";
import { listAccountCredentials, renameAccountCredential } from "../../packages/shared/src/auth-credentials";
import { browserSessionDetails, createSession } from "../../packages/shared/src/auth-sessions";
import { authKey, insertAuthRecord } from "../../packages/shared/src/auth-store";
import { registerMcpClient } from "../../packages/shared/src/mcp-auth";

const db = testEnv.BICKR_D1;
const now = new Date("2026-10-10T12:00:00.000Z");
const expiresAt = "2026-11-10T12:00:00.000Z";
async function account() {
	await authCookie();
	const userId = await userIdForHandle("octocat");
	await db.prepare("DELETE FROM auth_records WHERE user_id = ?").bind(userId).run();
	return userId;
}

describe("active account access inventory", () => {
	it("keeps names and kind-specific details without raw headers or tokens", async () => {
		const userId = await account();
		await createSession(db, userId, now, browserSessionDetails("Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0"));
		await createSession(db, userId, now);
		const client = await registerMcpClient(db, { clientName: "Claude Desktop", redirectUris: ["https://client.example/callback"] }, now);
		await insertAuthRecord(db, "mcp_grant", "grant", { clientId: client.id, scopes: ["bickr.read"], createdAt: now.toISOString() }, expiresAt, { userId }).run();
		const page = await listAccountCredentials(db, userId, "", now);
		const app = page.credentials.find((credential) => credential.kind === "mcp_grant");
		expect(app).toMatchObject({ kind: "mcp_grant", clientName: "Claude Desktop", clientId: client.id, scopes: ["bickr.read"], customName: null });
		expect(page.credentials.filter((credential) => credential.kind === "session").map((credential) => credential.browserDetails))
			.toEqual(expect.arrayContaining([null, { browser: "Firefox", operatingSystem: "Linux" }]));
		expect(JSON.stringify(page)).not.toContain("Mozilla");
		expect(JSON.stringify(page)).not.toContain("cookieValue");
		await db.prepare("DELETE FROM auth_records WHERE record_key = ?").bind(authKey("mcp_client", client.id)).run();
		expect((await listAccountCredentials(db, userId, "", now)).credentials.find((credential) => credential.kind === "mcp_grant"))
			.toMatchObject({ clientName: null });
	});

	it("filters inactive entries before pagination across more than 100 active entries", async () => {
		const userId = await account();
		await db.prepare(`INSERT INTO auth_records(record_key,kind,user_id,expires_at,revoked_at,document)
			WITH RECURSIVE count(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM count WHERE n < 206)
			SELECT 'cli_token:page-' || printf('%03d', n), 'cli_token', ?, ?,
			CASE WHEN n % 2 = 0 THEN ? ELSE NULL END, '{"createdAt":"2026-10-10T12:00:00.000Z","label":"CLI"}' FROM count`)
			.bind(userId, expiresAt, now.toISOString()).run();
		await insertAuthRecord(db, "cli_token", "expired", { createdAt: now.toISOString() }, now.toISOString(), { userId }).run();
		const first = await listAccountCredentials(db, userId, "", now);
		const last = await listAccountCredentials(db, userId, first.nextCursor!, now);
		expect(first.credentials).toHaveLength(100);
		expect(last.credentials).toHaveLength(3);
		expect(last.nextCursor).toBeNull();
		expect(new Set([...first.credentials, ...last.credentials].map((row) => row.id)).size).toBe(103);
		expect(first.credentials.every((row) => Number(row.id.slice(-3)) % 2 === 1)).toBe(true);
	});

	it("excludes the account cutoff inclusively and admits later access", async () => {
		const userId = await account();
		await insertAuthRecord(db, "cli_token", "old", { createdAt: now.toISOString() }, expiresAt, { userId }).run();
		await insertAuthRecord(db, "cli_token", "new", { createdAt: "2026-10-10T12:00:01.000Z" }, expiresAt, { userId }).run();
		await db.prepare("INSERT INTO auth_user_revocations(user_id,revoked_before) VALUES (?,?)").bind(userId, now.toISOString()).run();
		expect((await listAccountCredentials(db, userId, "", now)).credentials.map((row) => row.id)).toEqual(["cli_token:new"]);
	});

	it("renames and resets each kind while preserving its original identity and expiry", async () => {
		const userId = await account();
		const client = await registerMcpClient(db, { clientName: "Registered app", redirectUris: ["https://client.example/callback"] }, now);
		for (const kind of ["session", "cli_token", "mcp_grant"] as const) {
			const id = authKey(kind, kind);
			const document = { createdAt: now.toISOString(), updatedAt: now.toISOString(), label: "Original CLI", clientId: client.id,
				browserDetails: { browser: "Firefox", operatingSystem: "Linux" }, scopes: ["bickr.read"] };
			await insertAuthRecord(db, kind, kind, document, expiresAt, { userId }).run();
			await renameAccountCredential(db, userId, id, "  Work laptop  ", now);
			expect((await listAccountCredentials(db, userId, "", now)).credentials.find((row) => row.id === id)?.customName).toBe("Work laptop");
			await renameAccountCredential(db, userId, id, "   ", now);
			const stored = await db.prepare("SELECT document, expires_at AS expiresAt FROM auth_records WHERE record_key = ?").bind(id).first<{ document: string; expiresAt: string }>();
			expect(JSON.parse(stored!.document)).toEqual(document);
			expect(stored!.expiresAt).toBe(expiresAt);
		}
	});

	it("rejects invalid names and inactive, foreign, or non-credential targets", async () => {
		const userId = await account();
		await insertAuthRecord(db, "cli_token", "valid", { createdAt: now.toISOString() }, expiresAt, { userId }).run();
		for (const name of ["x".repeat(121), "line\nbreak", "control\u0000", "control\u0085"]) {
			await expect(renameAccountCredential(db, userId, "cli_token:valid", name, now)).rejects.toMatchObject({ status: 400 });
		}
		await renameAccountCredential(db, userId, "cli_token:valid", "x".repeat(120), now);
		for (const [key, owner, expiry, revokedAt, createdAt] of [
			["foreign", "other", expiresAt, null, now.toISOString()],
			["expired", userId, now.toISOString(), null, now.toISOString()],
			["revoked", userId, expiresAt, now.toISOString(), now.toISOString()],
			["cutoff", userId, expiresAt, null, "2026-10-09T12:00:00.000Z"],
		]) {
			await db.prepare("INSERT INTO auth_records(record_key,kind,user_id,expires_at,revoked_at,document) VALUES (?,'cli_token',?,?,?,?)")
				.bind(`cli_token:${key}`, owner, expiry, revokedAt, JSON.stringify({ createdAt })).run();
		}
		await db.prepare("INSERT INTO auth_user_revocations(user_id,revoked_before) VALUES (?,?)").bind(userId, "2026-10-09T12:00:00.000Z").run();
		await insertAuthRecord(db, "cli_request", "pending", { createdAt: now.toISOString() }, expiresAt, { userId }).run();
		for (const id of ["cli_token:foreign", "cli_token:expired", "cli_token:revoked", "cli_token:cutoff", "cli_request:pending"]) {
			await expect(renameAccountCredential(db, userId, id, "Changed", now)).rejects.toMatchObject({ status: 404 });
		}
		await db.prepare("UPDATE users_index SET lifecycle_state = 'deleting' WHERE user_id = ?").bind(userId).run();
		await expect(renameAccountCredential(db, userId, "cli_token:valid", "Changed", now)).rejects.toMatchObject({ status: 404 });
	});
});
