import { env } from "cloudflare:test";
import { resetD1Schema } from "../helpers/d1-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { localizedText } from "../../packages/shared/src/model";
import { type UserDocument } from "../../packages/shared/src/model";
import {
	approveCliAuthRequest,
	createCliAuthRequest,
	deleteCliToken,
	pollCliAuthRequest,
	readCliAuthRequest,
	userForCliToken,
} from "../../packages/shared/src/repository";
import { kvKeys, type KVNamespaceLike } from "../../packages/shared/src/storage";

const db = env.BICKR_D1;
beforeEach(async () => {
	await resetD1Schema(db);
	await db.prepare("INSERT INTO entity_lifecycle_identity_claims(key_kind,key_scope,key_value,entity_kind,entity_id,owner_user_id,claim_state,created_at,updated_at) VALUES ('user_handle','global','user','account',?,?,'active','2026-01-01','2026-01-01')").bind("usr_cli","usr_cli").run();
	await db.prepare("INSERT INTO users_index(user_id,handle,display_name,created_at,updated_at,lifecycle_state) VALUES (?,?,?,?,?,?)").bind("usr_cli", "user", "User", "2026-01-01", "2026-01-01", "active").run();
});

describe("CLI auth tokens", () => {
	it("issues one-time CLI tokens and stores only hashed token state", async () => {
		const kv = new MapKV();
		await kv.put(kvKeys.user("usr_cli"), JSON.stringify(testUser()));

		const started = await createCliAuthRequest(db, { label: " laptop " }, new Date("2026-05-25T00:00:00.000Z"));
		expect(started.request.label).toBe("laptop");
		expect(await pollCliAuthRequest(db, started.deviceCode, new Date("2026-05-25T00:01:00.000Z"))).toEqual({
			status: "pending",
			expiresAt: "2026-05-25T00:10:00.000Z",
		});

		await approveCliAuthRequest(db, started.deviceCode, "usr_cli", new Date("2026-05-25T00:02:00.000Z"));
		const completed = await pollCliAuthRequest(db, started.deviceCode, new Date("2026-05-25T00:03:00.000Z"));
		expect(completed.status).toBe("complete");
		if (completed.status !== "complete") {
			throw new Error("Expected completed CLI auth poll.");
		}
		expect(completed.token).toMatch(/^bckr_cli_/);
		const stored = JSON.stringify((await db.prepare("SELECT * FROM auth_records").all()).results);
		expect(stored).not.toContain(completed.token);
		expect(stored).not.toContain(started.deviceCode);
		expect((await userForCliToken(kv, completed.token, db, new Date("2026-05-25T00:04:00.000Z")))?.id).toBe("usr_cli");

		await deleteCliToken(db, completed.token);
		expect(await userForCliToken(kv, completed.token, db, new Date("2026-05-25T00:05:00.000Z"))).toBeNull();
	});

	it("treats expired approval-page requests as absent without mutating timestamps on read", async () => {
		const started = await createCliAuthRequest(db, { label: "terminal" }, new Date("2026-05-25T00:00:00.000Z"));

		expect(await readCliAuthRequest(db, started.deviceCode, new Date("2026-05-25T00:11:00.000Z"))).toBeNull();
		expect((await db.prepare("SELECT document FROM auth_records WHERE kind = 'cli_request'").first<{document:string}>())?.document).toContain('"updatedAt":"2026-05-25T00:00:00.000Z"');
	});
});

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

function testUser(): UserDocument {
	return {
		id: "usr_cli",
		type: "user",
		schemaVersion: 1,
		revision: 1,
		handle: "cli-user",
		language: null,
		displayName: localizedText("CLI User", null),
		profileCompletedAt: "2026-05-01T00:00:00.000Z",
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
	};
}
