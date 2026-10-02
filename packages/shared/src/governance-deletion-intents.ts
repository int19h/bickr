import type { ForumDocument, WorldDocument } from "./model";
import { entityIndexVersions } from "./index-versions";
import { tombstoneHandle } from "./handles";
import { upsertForumSearchIndex, upsertWorldSearchIndex } from "./search";
import { kvKeys, putObjectIndex, readJson, writeJson, type D1DatabaseLike, type KVNamespaceLike } from "./storage";

export type GovernanceDeletionIntent = {
	kind: "world" | "forum";
	id: string;
	deletedAt: string;
	documentJson: string | null;
};

/** Include this statement in the transaction that hides the parent in D1. */
export function governanceDeletionIntentStatement(db: D1DatabaseLike, document: WorldDocument | ForumDocument) {
	if (!document.deletedAt) throw new Error("A deletion intent requires a tombstone.");
	return db.prepare(
		`INSERT INTO governance_deletion_intents (scope_kind, scope_id, deleted_at, document_json, next_attempt_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(scope_kind, scope_id) DO NOTHING`,
	).bind(document.type, document.id, document.deletedAt, JSON.stringify(document), document.deletedAt);
}

export async function readGovernanceDeletionIntent(db: D1DatabaseLike, kind: "world" | "forum", id: string) {
	return db.prepare(
		`SELECT scope_kind AS kind, scope_id AS id, deleted_at AS deletedAt, document_json AS documentJson
		 FROM governance_deletion_intents WHERE scope_kind = ? AND scope_id = ?`,
	).bind(kind, id).first<GovernanceDeletionIntent>();
}

/** Replay only under the owning coordinator's queue. Tombstones never become live again. */
export async function projectGovernanceDeletionIntent(kv: KVNamespaceLike, db: D1DatabaseLike, intent: GovernanceDeletionIntent): Promise<void> {
	const key = intent.kind === "world" ? kvKeys.world(intent.id) : kvKeys.forum(intent.id);
	const previous = intent.documentJson ? JSON.parse(intent.documentJson) as WorldDocument | ForumDocument
		: await readJson<WorldDocument | ForumDocument>(kv, key);
	if (!previous || previous.id !== intent.id || previous.type !== intent.kind) {
		throw new Error("Deletion intent document is missing or has a different identity.");
	}
	const document = previous.deletedAt ? previous : {
		...previous,
		handle: tombstoneHandle(previous.id),
		handleAtDeletion: previous.handleAtDeletion ?? previous.handle,
		deletedAt: intent.deletedAt,
		updatedAt: intent.deletedAt,
		revision: previous.revision + 1,
	};
	await writeJson(kv, key, document);
	if (document.type === "world") {
		await upsertWorldSearchIndex(db, document);
		await putObjectIndex(db, document, "world", entityIndexVersions.world, document.id);
	} else {
		await upsertForumSearchIndex(db, document);
		await putObjectIndex(db, document, "forum", entityIndexVersions.forum, document.worldId);
	}
}
