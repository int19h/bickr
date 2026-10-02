import type { UserDocument } from "./model";
import { kvKeys, readJson, type D1DatabaseLike, type KVNamespaceLike } from "./storage";

/** Use the primary D1 binding for authorization. Do not use a read replica or KV
 * projection to decide whether an account can act while deletion is pending. */
export async function activeAccountProjectionExists(db: D1DatabaseLike, userId: string): Promise<boolean> {
	return Boolean(await db.prepare(`SELECT user_id FROM users_index
		WHERE user_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active' LIMIT 1`)
		.bind(userId).first());
}

export async function activeUser(kv: KVNamespaceLike, db: D1DatabaseLike, userId: string): Promise<UserDocument | null> {
	const user = await readJson<UserDocument>(kv, kvKeys.user(userId));
	return user && !user.deletedAt && await activeAccountProjectionExists(db, userId) ? user : null;
}
