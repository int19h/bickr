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
	/** A live indexed entity has no KV document, so its avatar is unknowable. */
	| { kind: 'missing_document'; entity: EntityKind; id: string }
	/** A live linked clone's inherited avatar could not be resolved. */
	| { kind: 'unresolved_clone_chain'; reason: CloneChainFailureReason; botId: string; sourceBotId: string }
	/** R2 said there was more to list but gave no usable way to ask for it. */
	| { kind: 'list_cursor'; reason: 'missing' | 'repeated'; listed: number }
	| { kind: 'delete_volume'; deletable: number; limit: number };

export type CloneChainFailureReason = 'missing_source' | 'cycle' | 'depth_exhausted';

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

export type EntityKind = 'bot' | 'world' | 'user';

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
 * nothing, and deleting a referenced avatar is unrecoverable. So does anything
 * that leaves the referenced set incomplete rather than merely empty: a live
 * indexed entity whose KV document is missing, a clone chain that cannot be
 * walked to its end, an R2 listing that says it is truncated but cannot be
 * continued. "No avatar" and "an avatar this run cannot see" are the same
 * observation to the mark phase and opposite instructions to the sweep.
 *
 * An aborted run deliberately does *not* write the weekly marker, including for
 * the states above that no retry can clear on its own. That is the point: an
 * inconsistency between an index row and its document is an owner's problem,
 * and the daily cron re-deriving and re-logging the same refusal is how the
 * evidence stays in front of somebody until one of them intervenes. Claiming
 * the week instead would silence it for six days and reclaim nothing anyway. A
 * run skipped for exceeding the budget does write the marker, because there the
 * fleet is consistent and only the design has run out — repeating that refusal
 * daily adds nothing to the first one.
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
		if (listed.kind === 'unusable_cursor') {
			return {
				kind: 'avatar_janitor',
				status: 'aborted',
				failure: { kind: 'list_cursor', reason: listed.reason, listed: listed.listed },
			};
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
	if (mark.kind === 'unresolved') {
		return { kind: 'avatar_janitor', status: 'aborted', failure: mark.failure };
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
	| { kind: 'unresolved'; failure: AvatarJanitorFailure }
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
				if (id === undefined) {
					continue;
				}
				// An index row with no document is not "an entity with no avatar": it
				// is an entity whose avatar this run cannot see, and marking from an
				// incomplete set is how a referenced object gets deleted. Whatever
				// produced the divergence — an interrupted write, a lost KV value, an
				// index row that outlived its document — the sweep has no business
				// guessing, so the whole run refuses.
				if (document === null) {
					return { kind: 'unresolved', failure: { kind: 'missing_document', entity: kind, id } };
				}
				if (kind === 'bot') {
					botDocuments.set(id, document as BotDocument);
				}
				const key = document.avatar?.key;
				if (key) {
					referencedKeys.add(key);
				}
				// `localOverrides.avatar` is normally derived at read time and equals
				// the document's own avatar, but the stored shape permits it. Marking
				// it costs one set insertion and removes a way to be wrong.
				const overriddenKey = (document as BotDocument).localOverrides?.avatar?.key;
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
		if (inherited.kind === 'unresolved') {
			return {
				kind: 'unresolved',
				failure: {
					kind: 'unresolved_clone_chain',
					reason: inherited.reason,
					botId,
					sourceBotId: inherited.sourceBotId,
				},
			};
		}
		if (inherited.key) {
			referencedKeys.add(inherited.key);
		}
	}

	return { kind: 'marked', referencedKeys, cloneSources: cloneSources.length };
}

type CloneChainResolution =
	| { kind: 'resolved'; key: string | null }
	| { kind: 'unresolved'; reason: CloneChainFailureReason; sourceBotId: string };

/**
 * Walk a clone chain with a tombstone-capable loader.
 *
 * `rawBotById` refuses a deleted or unindexed bot, and `effectiveBotDocument`
 * turns that refusal into a 500 (#192) — neither can answer the question the
 * janitor is asking, which is what a live clone currently renders. The KV
 * document is read directly, ignoring lifecycle state entirely.
 *
 * A chain that simply ends — a source with neither an avatar of its own nor an
 * onward link — resolves to no key. A chain that cannot be walked to its end
 * does not: a missing source document, a cycle, or a chain longer than the
 * repository's own resolution limit each leave an avatar this run cannot see,
 * and the caller turns that into a refusal rather than into a deletion.
 */
async function inheritedAvatarKey(
	kv: KVNamespaceLike,
	botDocuments: Map<string, BotDocument | null>,
	sourceByBotId: Map<string, CloneSourceRow>,
	sourceBotId: string,
): Promise<CloneChainResolution> {
	const visited = new Set<string>();
	let currentId: string | undefined = sourceBotId;
	let depth = 0;
	while (currentId !== undefined) {
		if (depth >= avatarJanitorMaxCloneChainDepth) {
			return { kind: 'unresolved', reason: 'depth_exhausted', sourceBotId: currentId };
		}
		depth += 1;
		if (visited.has(currentId)) {
			return { kind: 'unresolved', reason: 'cycle', sourceBotId: currentId };
		}
		visited.add(currentId);
		let document = botDocuments.get(currentId);
		if (document === undefined) {
			document = await readJson<BotDocument>(kv, kvKeys.bot(currentId)) ?? null;
			botDocuments.set(currentId, document);
		}
		if (document === null) {
			return { kind: 'unresolved', reason: 'missing_source', sourceBotId: currentId };
		}
		const key = document.avatar?.key;
		if (key) {
			return { kind: 'resolved', key };
		}
		// A source with no avatar of its own inherits from its own source, exactly
		// as effective-document resolution would.
		const next = sourceByBotId.get(currentId);
		currentId = next && next.linked !== 0 ? next.sourceBotId : undefined;
	}
	return { kind: 'resolved', key: null };
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
	| { kind: 'unusable_cursor'; reason: 'missing' | 'repeated'; listed: number }
	| { kind: 'listed'; objects: readonly { key: string; uploaded: Date }[] };

/**
 * Enumerate the bucket, or refuse to.
 *
 * A truncated page with no cursor, or with one already used, means the listing
 * cannot be completed. Stopping there would hand the sweep a partial bucket,
 * which is the same shape of mistake as a partial referenced set: it silently
 * reduces what the run considers, and then the run claims the week as swept. A
 * repeated cursor would also spin forever, so it is checked rather than merely
 * bounded.
 */
async function listAllObjects(bucket: AvatarJanitorBucket): Promise<ListResult> {
	const objects: { key: string; uploaded: Date }[] = [];
	const usedCursors = new Set<string>();
	let cursor: string | undefined;
	// Every exit is a return: the loop ends by finishing the listing, by refusing
	// it, or by outgrowing the budget, never by running out of cursor.
	for (;;) {
		const page = await bucket.list({ limit: 1_000, ...(cursor ? { cursor } : {}) });
		objects.push(...page.objects);
		if (objects.length > avatarJanitorMaxObjects) {
			return {
				kind: 'over_budget',
				overrun: { kind: 'objects', counted: objects.length, limit: avatarJanitorMaxObjects },
			};
		}
		if (!page.truncated) {
			return { kind: 'listed', objects };
		}
		const next = page.cursor;
		if (!next) {
			return { kind: 'unusable_cursor', reason: 'missing', listed: objects.length };
		}
		if (usedCursors.has(next)) {
			return { kind: 'unusable_cursor', reason: 'repeated', listed: objects.length };
		}
		usedCursors.add(next);
		cursor = next;
	}
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
