import { type BotDocument, type UserDocument, type WorldDocument } from '@bickr/shared/model';
import {
	chunks,
	kvKeys,
	readJson,
	writeJson,
	type D1DatabaseLike,
	type KVNamespaceLike,
} from '@bickr/shared/storage';

/**
 * How often the janitor actually sweeps. The cron that carries it is daily
 * (§2.4), so the gate lives in KV rather than in the schedule.
 */
export const avatarJanitorIntervalMs = 7 * 24 * 60 * 60 * 1_000;

/**
 * How long an unreferenced object is kept before it may be deleted.
 *
 * Nothing outside R2 records an avatar candidate — the browser holds the only
 * reference between generating one and applying it — and a resumable
 * `lifecycle-import.*` upload is likewise referenced by an in-flight operation
 * rather than by any document. The grace window is what protects both, and it
 * also absorbs the gap between a fresh upload and the KV write that names it.
 */
export const avatarJanitorGraceMs = 7 * 24 * 60 * 60 * 1_000;

/**
 * Hard budget for one invocation (§2.7).
 *
 * The sweep is single-invocation by construction: the referenced set has to be
 * complete before anything is deleted, so a run that cannot finish the mark
 * phase must delete nothing at all. These ceilings are asserted before the work
 * starts and are set well above the current fleet (~1k entities, ~550 objects).
 * Exceeding one is not an error to retry — it means the fleet outgrew this
 * design and needs the epoch-based mark table §2.7 specifies as the escape
 * hatch — so the run is skipped for the week and logged.
 */
export const avatarJanitorMaxEntities = 2_000;
export const avatarJanitorMaxCloneSources = 2_000;
export const avatarJanitorMaxObjects = 5_000;

/**
 * Deletions one run may perform. The mark phase is the only thing standing
 * between a bug and an empty bucket, so a run that suddenly wants to delete
 * many times the known orphan count (~121 at design time) stops instead and
 * leaves the evidence for an owner.
 */
export const avatarJanitorMaxDeletesPerRun = 1_000;

/** D1 keyset page size for the entity walks. */
export const avatarJanitorRowPageSize = 100;

/** Entity documents read from KV concurrently. */
export const avatarJanitorDocumentChunkSize = 25;

/** Keys per R2 delete call. */
export const avatarJanitorDeleteBatchSize = 500;

/** Deleted keys reported in the result, so one run cannot produce one huge log line. */
export const avatarJanitorReportedKeyLimit = 20;

/** Clone chain depth, matching the repository's own effective-document limit. */
const avatarJanitorMaxCloneChainDepth = 16;

export type AvatarJanitorBucket = {
	list(options?: { cursor?: string; limit?: number }): Promise<{
		objects: readonly { key: string; uploaded: Date }[];
		truncated: boolean;
		cursor?: string;
	}>;
	delete(keys: string[]): Promise<void>;
};

export type AvatarJanitorEnv = {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
	BICKR_R2?: AvatarJanitorBucket;
	BICKR_R2_PUBLIC_BASE_URL?: string;
};

export type AvatarJanitorBudgetOverrun = {
	kind: 'entities' | 'clone_sources' | 'objects';
	counted: number;
	limit: number;
};

export type AvatarJanitorFailure =
	| { kind: 'read_error'; phase: 'mark' | 'sweep'; errorName: string }
	| { kind: 'delete_volume'; deletable: number; limit: number };

export type AvatarJanitorResult =
	| { kind: 'avatar_janitor'; status: 'skipped_not_due'; lastRunAt: string; dueAt: string }
	| { kind: 'avatar_janitor'; status: 'skipped_unconfigured'; missing: 'bucket' | 'public_base_url' }
	| { kind: 'avatar_janitor'; status: 'skipped_over_budget'; overrun: AvatarJanitorBudgetOverrun }
	| { kind: 'avatar_janitor'; status: 'aborted'; failure: AvatarJanitorFailure }
	| {
			kind: 'avatar_janitor';
			status: 'swept';
			entities: number;
			cloneSources: number;
			referencedKeys: number;
			objects: number;
			deleted: number;
			retainedInGrace: number;
			deletedSample: string[];
	  };

type AvatarJanitorMarker = { lastRunAt: string };

type AvatarEntityRow = { id: string; avatarUrl: string | null };

type CloneSourceRow = { botId: string; sourceBotId: string; linked: number };

type EntityKind = 'bot' | 'world' | 'user';

const entityWalks: Record<EntityKind, { table: string; idColumn: string }> = {
	bot: { table: 'bots_index', idColumn: 'bot_id' },
	world: { table: 'worlds_index', idColumn: 'world_id' },
	user: { table: 'users_index', idColumn: 'user_id' },
};

/**
 * Weekly mark-and-sweep over the avatar bucket (design §2.7).
 *
 * The whole referenced set is built before a single object is deleted, from
 * both the D1 index tables and the KV documents they index: documents are the
 * source of truth and the index can lag, so neither alone is safe to mark from.
 * A live linked clone inherits its source's avatar, and the source may already
 * be tombstoned while the clone is still live (the account-cascade window), so
 * clone chains resolve through a raw KV load that ignores lifecycle state
 * rather than through `effectiveBotDocument`, which 404s on a tombstoned source
 * (#192).
 *
 * Everything about this is fail-closed. Any read, list, or resolution error
 * aborts the deletion phase for the run — a week of unreclaimed objects costs
 * nothing, and deleting a referenced avatar is unrecoverable. An aborted run
 * leaves the weekly marker alone so tomorrow's cron retries it; a run skipped
 * for exceeding the budget writes the marker, because retrying an unchanged
 * fleet daily would only repeat the same refusal.
 */
export async function runAvatarJanitor(
	env: AvatarJanitorEnv,
	options: { now?: string; force?: boolean } = {},
): Promise<AvatarJanitorResult> {
	const now = options.now ?? new Date().toISOString();
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) {
		throw new Error('now must be an ISO timestamp.');
	}
	const bucket = env.BICKR_R2;
	if (!bucket) {
		return { kind: 'avatar_janitor', status: 'skipped_unconfigured', missing: 'bucket' };
	}
	const publicBaseUrl = env.BICKR_R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
	if (!publicBaseUrl) {
		return { kind: 'avatar_janitor', status: 'skipped_unconfigured', missing: 'public_base_url' };
	}
	if (!options.force) {
		const marker = await readJanitorMarker(env.BICKR_KV);
		const lastRunMs = marker ? Date.parse(marker.lastRunAt) : Number.NaN;
		if (Number.isFinite(lastRunMs) && lastRunMs + avatarJanitorIntervalMs > nowMs) {
			return {
				kind: 'avatar_janitor',
				status: 'skipped_not_due',
				lastRunAt: new Date(lastRunMs).toISOString(),
				dueAt: new Date(lastRunMs + avatarJanitorIntervalMs).toISOString(),
			};
		}
	}

	// Both halves of the budget are asserted before the mark phase does any work,
	// and the bucket is enumerated first for a second reason: an object uploaded
	// after this listing cannot be a deletion candidate at all, whatever the mark
	// phase concludes about it.
	let entities: number;
	let objects: readonly { key: string; uploaded: Date }[];
	try {
		const counts = await liveEntityCounts(env.BICKR_D1);
		entities = counts.bots + counts.worlds + counts.users;
		if (entities > avatarJanitorMaxEntities) {
			await writeJanitorMarker(env.BICKR_KV, now);
			return {
				kind: 'avatar_janitor',
				status: 'skipped_over_budget',
				overrun: { kind: 'entities', counted: entities, limit: avatarJanitorMaxEntities },
			};
		}
		const listed = await listAllObjects(bucket);
		if (listed.kind === 'over_budget') {
			await writeJanitorMarker(env.BICKR_KV, now);
			return { kind: 'avatar_janitor', status: 'skipped_over_budget', overrun: listed.overrun };
		}
		objects = listed.objects;
	} catch (error) {
		return {
			kind: 'avatar_janitor',
			status: 'aborted',
			failure: { kind: 'read_error', phase: 'sweep', errorName: errorName(error) },
		};
	}

	let mark: MarkPhaseResult;
	try {
		mark = await markReferencedAvatars(env);
	} catch (error) {
		return {
			kind: 'avatar_janitor',
			status: 'aborted',
			failure: { kind: 'read_error', phase: 'mark', errorName: errorName(error) },
		};
	}
	if (mark.kind === 'over_budget') {
		await writeJanitorMarker(env.BICKR_KV, now);
		return { kind: 'avatar_janitor', status: 'skipped_over_budget', overrun: mark.overrun };
	}

	const graceCutoffMs = nowMs - avatarJanitorGraceMs;
	let retainedInGrace = 0;
	const deletable: string[] = [];
	for (const object of objects) {
		if (mark.referencedKeys.has(object.key)) {
			continue;
		}
		if (object.uploaded.getTime() > graceCutoffMs) {
			retainedInGrace += 1;
			continue;
		}
		deletable.push(object.key);
	}
	if (deletable.length > avatarJanitorMaxDeletesPerRun) {
		return {
			kind: 'avatar_janitor',
			status: 'aborted',
			failure: { kind: 'delete_volume', deletable: deletable.length, limit: avatarJanitorMaxDeletesPerRun },
		};
	}

	try {
		for (const batch of chunks(deletable, avatarJanitorDeleteBatchSize)) {
			await bucket.delete(batch);
		}
	} catch (error) {
		// Deletion is idempotent, so the run simply does not claim the week: the
		// next cron rebuilds the referenced set and finishes the remainder.
		return {
			kind: 'avatar_janitor',
			status: 'aborted',
			failure: { kind: 'read_error', phase: 'sweep', errorName: errorName(error) },
		};
	}
	await writeJanitorMarker(env.BICKR_KV, now);
	return {
		kind: 'avatar_janitor',
		status: 'swept',
		entities,
		cloneSources: mark.cloneSources,
		referencedKeys: mark.referencedKeys.size,
		objects: objects.length,
		deleted: deletable.length,
		retainedInGrace,
		deletedSample: deletable.slice(0, avatarJanitorReportedKeyLimit),
	};
}

type MarkPhaseResult =
	| { kind: 'over_budget'; overrun: AvatarJanitorBudgetOverrun }
	| { kind: 'marked'; referencedKeys: Set<string>; cloneSources: number };

async function markReferencedAvatars(env: AvatarJanitorEnv): Promise<MarkPhaseResult> {
	const publicBaseUrl = env.BICKR_R2_PUBLIC_BASE_URL ?? '';
	const referencedKeys = new Set<string>();
	const liveIds: Record<EntityKind, string[]> = { bot: [], world: [], user: [] };
	for (const kind of ['bot', 'world', 'user'] as const) {
		for (const row of await liveEntityRows(env.BICKR_D1, kind)) {
			liveIds[kind].push(row.id);
			// The index URL is a second, independent witness of a live avatar: a
			// document write that has not landed yet still leaves the reference here.
			addKeyFromUrl(referencedKeys, publicBaseUrl, row.avatarUrl);
		}
	}

	const botDocuments = new Map<string, BotDocument | null>();
	for (const kind of ['bot', 'world', 'user'] as const) {
		for (const batch of chunks(liveIds[kind], avatarJanitorDocumentChunkSize)) {
			const documents = await Promise.all(batch.map((id) => readEntityDocument(env.BICKR_KV, kind, id)));
			for (let index = 0; index < batch.length; index += 1) {
				const document = documents[index];
				const id = batch[index];
				if (kind === 'bot' && id !== undefined) {
					botDocuments.set(id, (document as BotDocument | null) ?? null);
				}
				const key = document?.avatar?.key;
				if (key) {
					referencedKeys.add(key);
				}
				// `localOverrides.avatar` is normally derived at read time and equals
				// the document's own avatar, but the stored shape permits it. Marking
				// it costs one set insertion and removes a way to be wrong.
				const overriddenKey = (document as BotDocument | null)?.localOverrides?.avatar?.key;
				if (overriddenKey) {
					referencedKeys.add(overriddenKey);
				}
			}
		}
	}

	const cloneSources = await allCloneSources(env.BICKR_D1);
	if (cloneSources.length > avatarJanitorMaxCloneSources) {
		return {
			kind: 'over_budget',
			overrun: { kind: 'clone_sources', counted: cloneSources.length, limit: avatarJanitorMaxCloneSources },
		};
	}
	const sourceByBotId = new Map<string, CloneSourceRow>();
	for (const row of cloneSources) {
		sourceByBotId.set(row.botId, row);
	}
	// A live linked clone renders its source's avatar whenever it has none of its
	// own, and it keeps doing so while the source is tombstoned — during an
	// account cascade a deleted owner's bot can briefly outlive its own delete as
	// somebody else's clone source. Those keys are referenced.
	for (const botId of liveIds.bot) {
		const clone = sourceByBotId.get(botId);
		if (!clone || clone.linked === 0) {
			continue;
		}
		if (botDocuments.get(botId)?.avatar?.key) {
			continue;
		}
		const inherited = await inheritedAvatarKey(env.BICKR_KV, botDocuments, sourceByBotId, clone.sourceBotId);
		if (inherited) {
			referencedKeys.add(inherited);
		}
	}

	return { kind: 'marked', referencedKeys, cloneSources: cloneSources.length };
}

/**
 * Walk a clone chain with a tombstone-capable loader.
 *
 * `rawBotById` refuses a deleted or unindexed bot, and `effectiveBotDocument`
 * turns that refusal into a 500 (#192) — neither can answer the question the
 * janitor is asking, which is what a live clone currently renders. The KV
 * document is read directly, ignoring lifecycle state entirely.
 */
async function inheritedAvatarKey(
	kv: KVNamespaceLike,
	botDocuments: Map<string, BotDocument | null>,
	sourceByBotId: Map<string, CloneSourceRow>,
	sourceBotId: string,
): Promise<string | null> {
	const visited = new Set<string>();
	let currentId: string | undefined = sourceBotId;
	for (let depth = 0; depth < avatarJanitorMaxCloneChainDepth && currentId; depth += 1) {
		if (visited.has(currentId)) {
			return null;
		}
		visited.add(currentId);
		let document = botDocuments.get(currentId);
		if (document === undefined) {
			document = await readJson<BotDocument>(kv, kvKeys.bot(currentId)) ?? null;
			botDocuments.set(currentId, document);
		}
		const key = document?.avatar?.key;
		if (key) {
			return key;
		}
		// A source with no avatar of its own inherits from its own source, exactly
		// as effective-document resolution would. A missing document ends the walk:
		// there is no key to protect behind it.
		const next: CloneSourceRow | undefined = document ? sourceByBotId.get(currentId) : undefined;
		currentId = next && next.linked !== 0 ? next.sourceBotId : undefined;
	}
	return null;
}

async function liveEntityCounts(db: D1DatabaseLike): Promise<{ bots: number; worlds: number; users: number }> {
	const row = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM bots_index WHERE deleted_at IS NULL) AS bots,
				(SELECT COUNT(*) FROM worlds_index WHERE deleted_at IS NULL) AS worlds,
				(SELECT COUNT(*) FROM users_index WHERE deleted_at IS NULL) AS users`,
		)
		.first<{ bots: number; worlds: number; users: number }>();
	if (!row) {
		throw new Error('Live entity counts returned no row.');
	}
	return row;
}

/**
 * Every live entity of one kind, walked by keyset so no single statement has to
 * return the whole fleet.
 *
 * Live means "not tombstoned", whatever the lifecycle state: a `pending` entity
 * has an avatar upload that its own creation has not finished naming, and a
 * `deleting` one is still readable until its cascade completes.
 */
async function liveEntityRows(db: D1DatabaseLike, kind: EntityKind): Promise<AvatarEntityRow[]> {
	const { table, idColumn } = entityWalks[kind];
	const rows: AvatarEntityRow[] = [];
	let cursor: string | undefined;
	// The count assertion above bounds the fleet, so this walk terminates well
	// before the guard; the guard exists so a concurrently growing table cannot
	// turn it into an unbounded loop.
	const maxPages = Math.ceil(avatarJanitorMaxEntities / avatarJanitorRowPageSize) + 1;
	for (let page = 0; page < maxPages; page += 1) {
		const statement = cursor === undefined
			? db.prepare(
				`SELECT ${idColumn} AS id, avatar_url AS avatarUrl
				 FROM ${table}
				 WHERE deleted_at IS NULL
				 ORDER BY ${idColumn} ASC
				 LIMIT ?`,
			).bind(avatarJanitorRowPageSize)
			: db.prepare(
				`SELECT ${idColumn} AS id, avatar_url AS avatarUrl
				 FROM ${table}
				 WHERE deleted_at IS NULL AND ${idColumn} > ?
				 ORDER BY ${idColumn} ASC
				 LIMIT ?`,
			).bind(cursor, avatarJanitorRowPageSize);
		const result = await statement.all<AvatarEntityRow>();
		const items = result.results ?? [];
		rows.push(...items);
		if (items.length < avatarJanitorRowPageSize) {
			return rows;
		}
		cursor = items[items.length - 1]?.id;
		if (cursor === undefined) {
			return rows;
		}
	}
	throw new Error(`Live ${kind} walk did not terminate within its page budget.`);
}

/**
 * Every clone link, including those of tombstoned clones.
 *
 * Filtering to live clones in SQL would save rows but lose the chain: an
 * intermediate clone in a chain may itself be tombstoned while the live clone
 * at the end of it still renders the avatar at the root.
 */
async function allCloneSources(db: D1DatabaseLike): Promise<CloneSourceRow[]> {
	const result = await db
		.prepare(
			`SELECT bot_id AS botId, source_bot_id AS sourceBotId, linked
			 FROM bot_clone_sources
			 ORDER BY bot_id ASC
			 LIMIT ?`,
		)
		.bind(avatarJanitorMaxCloneSources + 1)
		.all<CloneSourceRow>();
	return result.results ?? [];
}

async function readEntityDocument(
	kv: KVNamespaceLike,
	kind: EntityKind,
	id: string,
): Promise<BotDocument | WorldDocument | UserDocument | null> {
	switch (kind) {
		case 'bot':
			return await readJson<BotDocument>(kv, kvKeys.bot(id));
		case 'world':
			return await readJson<WorldDocument>(kv, kvKeys.world(id));
		case 'user':
			return await readJson<UserDocument>(kv, kvKeys.user(id));
	}
}

type ListResult =
	| { kind: 'over_budget'; overrun: AvatarJanitorBudgetOverrun }
	| { kind: 'listed'; objects: readonly { key: string; uploaded: Date }[] };

async function listAllObjects(bucket: AvatarJanitorBucket): Promise<ListResult> {
	const objects: { key: string; uploaded: Date }[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ limit: 1_000, ...(cursor ? { cursor } : {}) });
		objects.push(...page.objects);
		if (objects.length > avatarJanitorMaxObjects) {
			return {
				kind: 'over_budget',
				overrun: { kind: 'objects', counted: objects.length, limit: avatarJanitorMaxObjects },
			};
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return { kind: 'listed', objects };
}

/**
 * The object key an index row's avatar URL points at.
 *
 * Keys are matched by path rather than by whole-URL prefix: the public base has
 * changed before (test and production serve the same key shape from different
 * hosts), and a marked key that no object matches is harmless while a missed
 * one is not.
 */
function addKeyFromUrl(referencedKeys: Set<string>, publicBaseUrl: string, url: string | null): void {
	if (!url) {
		return;
	}
	try {
		const path = new URL(url, publicBaseUrl || undefined).pathname.replace(/^\/+/, '');
		if (path) {
			referencedKeys.add(path);
		}
	} catch {
		// An index row whose avatar URL is not a URL names no object. The
		// document's own `avatar.key` is the authoritative reference either way.
	}
}

async function readJanitorMarker(kv: KVNamespaceLike): Promise<AvatarJanitorMarker | null> {
	const value = await readJson<unknown>(kv, kvKeys.avatarJanitorLastRun);
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const lastRunAt = (value as Record<string, unknown>).lastRunAt;
	return typeof lastRunAt === 'string' && lastRunAt.length > 0 ? { lastRunAt } : null;
}

async function writeJanitorMarker(kv: KVNamespaceLike, now: string): Promise<void> {
	await writeJson(kv, kvKeys.avatarJanitorLastRun, { lastRunAt: now } satisfies AvatarJanitorMarker);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : 'UnknownError';
}
