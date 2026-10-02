import { beforeEach, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { pruneExpiredNotifications } from "@bickr/shared/social";
import type { KVNamespaceLike } from "@bickr/shared/storage";
import { resetD1Schema } from "./helpers/d1-schema";

const now = "2026-10-02T00:00:00.000Z";
const old = "2026-09-01T00:00:00.000Z";
const db = env.BICKR_D1;
const kv: KVNamespaceLike = { get: async () => null, put: async () => {}, delete: async () => {} };

beforeEach(async () => { await resetD1Schema(db); });

it("gives expired pending rows the full budget before tombstone work and reports remaining age", async () => {
	await db.prepare(`INSERT INTO entity_lifecycle_identity_claims
		(key_kind,key_scope,key_value,entity_kind,entity_id,owner_user_id,claim_state,created_at,updated_at)
		VALUES ('bot_handle','wld_retention','gone','bot','bot_gone','usr_retention','active',?,?)`).bind(old, old).run();
	await db.prepare(`INSERT INTO bots_index
		(bot_id,home_world_id,home_world_handle,handle,display_name,owner_user_id,short_bio,created_at,updated_at,deleted_at)
		VALUES ('bot_gone','wld_retention','retention','gone','Gone','usr_retention','',?,?,?)`).bind(old, now, now).run();
	await db.batch([
		...["a", "b", "c"].map(id => db.prepare(`INSERT INTO notifications
			(notification_id,world_id,bot_id,type,status,message,created_at) VALUES (?, 'wld_retention','bot_live','reply','pending','old',?)`).bind(id, old)),
		...["x", "y"].map(id => db.prepare(`INSERT INTO notifications
			(notification_id,world_id,bot_id,type,status,message,created_at) VALUES (?, 'wld_retention','bot_gone','reply','pending','orphan',?)`).bind(id, now)),
	]);
	const options = { now, maxRowsPerRun: 2, orphanMaxRowsPerRun: 2, sourceSweep: { maxRowsPerRun: 0 } };
	const first = await pruneExpiredNotifications(kv, db, options);
	expect(first).toMatchObject({ selectedRows: 2, deletedRows: 2, orphanedBotRows: 0, oldestExpiredPendingAt: old, budgetExhausted: true });
	expect((await db.prepare("SELECT notification_id FROM notifications ORDER BY notification_id").all()).results).toEqual([
		{ notification_id: "c" }, { notification_id: "x" }, { notification_id: "y" },
	]);
	const second = await pruneExpiredNotifications(kv, db, options);
	expect(second).toMatchObject({ deletedRows: 2, orphanedBotRows: 1, oldestExpiredPendingAt: null });
});
