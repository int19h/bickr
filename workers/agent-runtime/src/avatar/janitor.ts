import { type BotDocument, type UserDocument, type WorldDocument } from '@bickr/shared/model';
import { kvKeys, readJson, type D1DatabaseLike, type D1PreparedStatementLike, type KVNamespaceLike } from '@bickr/shared/storage';

export const avatarJanitorIntervalMs = 7 * 24 * 60 * 60 * 1_000;
export const avatarJanitorGraceMs = 7 * 24 * 60 * 60 * 1_000;
export const avatarJanitorRowPageSize = 10;
export const avatarJanitorMaxDeletesPerRun = 100;
export const avatarJanitorStepsPerRun = 4;
export const avatarJanitorReportedKeyLimit = 20;
const avatarJanitorMaxCloneChainDepth = 16;
const leaseMs = 15 * 60_000;
const cleanupPageSize = 1_000;

export type AvatarJanitorBucket = {
	list(options?: { cursor?: string; limit?: number }): Promise<{
		objects: readonly { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string;
	}>;
	delete(keys: string[]): Promise<void>;
};
export type AvatarJanitorEnv = { BICKR_D1: D1DatabaseLike; BICKR_KV: KVNamespaceLike; BICKR_R2?: AvatarJanitorBucket; BICKR_R2_PUBLIC_BASE_URL?: string };
export type EntityKind = 'bot' | 'world' | 'user';
export type CloneChainFailureReason = 'missing_source' | 'cycle' | 'depth_exhausted';
export type AvatarJanitorFailure =
	| { kind: 'read_error'; phase: 'mark' | 'sweep'; errorName: string }
	| { kind: 'missing_document'; entity: EntityKind; id: string }
	| { kind: 'unresolved_clone_chain'; reason: CloneChainFailureReason; botId: string; sourceBotId: string }
	| { kind: 'list_cursor'; reason: 'missing' | 'repeated'; listed: number };
type Counts = { entities: number; cloneSourceReads: number; objects: number; deleted: number; retainedInGrace: number; deletedSample: string[] };
type Phase = 'list' | 'mark' | 'sweep' | 'cleanup';
type Checkpoint = Counts & { version: 1; startedAt: string; cursor: string; entity: EntityKind; failure?: AvatarJanitorFailure };
type State = { epoch: string; phase: Phase; checkpoint: Checkpoint; token: string };
type Control = { epoch: string | null; phase: Phase | 'idle'; checkpoint: string | null; token: string | null; leaseUntil: string | null; lastRunAt: string | null };
export type AvatarJanitorResult =
	| { kind: 'avatar_janitor'; status: 'skipped_not_due'; lastRunAt: string; dueAt: string }
	| { kind: 'avatar_janitor'; status: 'skipped_unconfigured'; missing: 'bucket' | 'public_base_url' }
	| { kind: 'avatar_janitor'; status: 'skipped_inactive' | 'skipped_busy' }
	| { kind: 'avatar_janitor'; status: 'in_progress'; phase: Phase; entities: number; objects: number; deleted: number }
	| { kind: 'avatar_janitor'; status: 'aborted'; failure: AvatarJanitorFailure }
	| ({ kind: 'avatar_janitor'; status: 'swept' } & Counts);
type AvatarJanitorMarker = { lastRunAt: string };
type AvatarEntityRow = { id: string; avatarUrl: string | null; homeWorldId?: string; lifecycleState?: string };
type CloneSourceRow = { botId: string; sourceBotId: string; linked: number };
type CloneChainResolution = { kind: 'resolved'; key: string | null } | { kind: 'unresolved'; reason: CloneChainFailureReason; sourceBotId: string };
const entityWalks: Record<EntityKind, { table: string; idColumn: string }> = {
	bot: { table: 'bots_index', idColumn: 'bot_id' }, world: { table: 'worlds_index', idColumn: 'world_id' }, user: { table: 'users_index', idColumn: 'user_id' },
};
class JanitorRefusal extends Error {
	readonly failure: AvatarJanitorFailure;
	constructor(failure: AvatarJanitorFailure) { super('Avatar cleanup cannot prove that deletion is safe.'); this.failure = failure; }
}
class JanitorLeaseLost extends Error {
	constructor() { super('Avatar cleanup lease was replaced.'); this.name = 'JanitorLeaseLost'; }
}

/**
 * A persisted epoch lists the bucket, marks every live index/KV witness, then
 * sweeps. No partial mark set can authorize deletion. Avatar-index triggers pin
 * old and new references throughout an epoch. New objects use immutable keys;
 * the epoch-start grace cutoff protects publication before its index write.
 *
 * Each invocation has bounded work. A D1 compare-and-set lease serializes cursor
 * updates across cron requests; every durable write checks that lease again.
 * The daily cron starts epochs and the five-minute cron resumes active ones.
 */
export async function runAvatarJanitor(env: AvatarJanitorEnv, options: { now?: string; force?: boolean; resumeOnly?: boolean } = {}): Promise<AvatarJanitorResult> {
	const now = options.now ?? new Date().toISOString();
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) throw new Error('now must be an ISO timestamp.');
	if (!env.BICKR_R2) return { kind: 'avatar_janitor', status: 'skipped_unconfigured', missing: 'bucket' };
	if (!env.BICKR_R2_PUBLIC_BASE_URL?.trim()) return { kind: 'avatar_janitor', status: 'skipped_unconfigured', missing: 'public_base_url' };
	const db = env.BICKR_D1;
	let state: State | undefined;
	let leaseToken: string | undefined;
	try {
		const control = await db.prepare(`SELECT epoch, phase, checkpoint_json AS checkpoint, lease_token AS token, lease_until AS leaseUntil, last_run_at AS lastRunAt FROM avatar_janitor_control WHERE id = 1`).first<Control>();
		if (!control) throw new Error('Avatar cleanup control row is missing.');
		if (control.phase === 'idle' && options.resumeOnly) return { kind: 'avatar_janitor', status: 'skipped_inactive' };
		const token = crypto.randomUUID();
		const claimed = await db.prepare(`UPDATE avatar_janitor_control SET lease_token = ?, lease_until = ? WHERE id = 1 AND (lease_token IS NULL OR lease_until <= ?) RETURNING epoch, phase, checkpoint_json AS checkpoint, last_run_at AS lastRunAt`).bind(token, new Date(nowMs + leaseMs).toISOString(), now).first<Control>();
		if (!claimed) return { kind: 'avatar_janitor', status: 'skipped_busy' };
		leaseToken = token;
		if (claimed.phase === 'idle') {
			// Another invocation may finish between the first read and this claim.
			// Both start conditions must use the state protected by our lease.
			if (options.resumeOnly) return { kind: 'avatar_janitor', status: 'skipped_inactive' };
			const legacyMarker = claimed.lastRunAt === null ? await readJanitorMarker(env.BICKR_KV) : null;
			const last = Date.parse(claimed.lastRunAt ?? legacyMarker?.lastRunAt ?? '');
			if (!options.force && Number.isFinite(last) && last + avatarJanitorIntervalMs > nowMs) {
				return { kind: 'avatar_janitor', status: 'skipped_not_due', lastRunAt: new Date(last).toISOString(), dueAt: new Date(last + avatarJanitorIntervalMs).toISOString() };
			}
			state = { epoch: crypto.randomUUID(), token, phase: 'list', checkpoint: { version: 1, startedAt: now, cursor: '', entity: 'bot', entities: 0, cloneSourceReads: 0, objects: 0, deleted: 0, retainedInGrace: 0, deletedSample: [] } };
			await save(db, state);
		} else {
			if (!claimed.epoch || !claimed.checkpoint) throw new Error('Avatar cleanup checkpoint is missing.');
			const checkpoint = JSON.parse(claimed.checkpoint) as Checkpoint;
			if (checkpoint.version !== 1) throw new Error('Unknown avatar cleanup checkpoint version.');
			state = { epoch: claimed.epoch, phase: claimed.phase, token, checkpoint };
		}
		for (let step = 0; step < avatarJanitorStepsPerRun; step++) {
			switch (state.phase) {
				case 'list': await listPage(env, state); break;
				case 'mark': await markPage(env, state); break;
				case 'sweep': await sweepPage(env, state); break;
				case 'cleanup': {
					const complete = await cleanupPage(db, state);
					if (!complete) break;
					const result: AvatarJanitorResult = state.checkpoint.failure
						? { kind: 'avatar_janitor', status: 'aborted', failure: state.checkpoint.failure }
						: { kind: 'avatar_janitor', status: 'swept', ...counts(state.checkpoint) };
					const completed = await db.prepare(`UPDATE avatar_janitor_control SET phase = 'idle', epoch = NULL, checkpoint_json = NULL, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END WHERE id = 1 AND lease_token = ?`).bind(state.checkpoint.failure ? 0 : 1, now, token).run();
					if (completed.meta?.changes !== 1) throw new JanitorLeaseLost();
					return result;
				}
			}
			// Keep deletion throughput bounded independently of phase transitions.
			if (state.phase === 'sweep' && state.checkpoint.deleted > 0) break;
		}
		return { kind: 'avatar_janitor', status: 'in_progress', phase: state.phase, entities: state.checkpoint.entities, objects: state.checkpoint.objects, deleted: state.checkpoint.deleted };
	} catch (error) {
		const failure: AvatarJanitorFailure = error instanceof JanitorRefusal ? error.failure : { kind: 'read_error', phase: state?.phase === 'mark' ? 'mark' : 'sweep', errorName: errorName(error) };
		if (state && error instanceof JanitorRefusal) {
			state.phase = 'cleanup'; state.checkpoint.failure = failure; state.checkpoint.cursor = '';
			await save(db, state);
		}
		return { kind: 'avatar_janitor', status: 'aborted', failure };
	} finally {
		if (leaseToken) await db.prepare(`UPDATE avatar_janitor_control SET lease_token = NULL, lease_until = NULL WHERE id = 1 AND lease_token = ?`).bind(leaseToken).run();
	}
}
function counts(value: Counts): Counts { return { entities: value.entities, cloneSourceReads: value.cloneSourceReads, objects: value.objects, deleted: value.deleted, retainedInGrace: value.retainedInGrace, deletedSample: value.deletedSample }; }

async function save(db: D1DatabaseLike, state: State, statements: D1PreparedStatementLike[] = []): Promise<void> {
	const result = await db.batch([...statements, db.prepare(`UPDATE avatar_janitor_control SET epoch = ?, phase = ?, checkpoint_json = ? WHERE id = 1 AND lease_token = ?`).bind(state.epoch, state.phase, JSON.stringify(state.checkpoint), state.token)]);
	if (result.at(-1)?.meta?.changes !== 1) throw new JanitorLeaseLost();
}
function insertKeys(db: D1DatabaseLike, state: State, table: 'avatar_janitor_marks' | 'avatar_janitor_objects', keys: readonly string[]): D1PreparedStatementLike {
	return db.prepare(`INSERT OR IGNORE INTO ${table}(epoch, object_key) SELECT ?, value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM avatar_janitor_control WHERE id = 1 AND lease_token = ?)`).bind(state.epoch, JSON.stringify(keys), state.token);
}
async function listPage(env: AvatarJanitorEnv, state: State): Promise<void> {
	const cp = state.checkpoint;
	const page = await env.BICKR_R2!.list({ limit: 1_000, ...(cp.cursor ? { cursor: cp.cursor } : {}) });
	const statements: D1PreparedStatementLike[] = [];
	if (page.truncated) {
		const next = page.cursor;
		if (!next) throw new JanitorRefusal({ kind: 'list_cursor', reason: 'missing', listed: cp.objects + page.objects.length });
		const seen = await env.BICKR_D1.prepare(`SELECT 1 AS seen FROM avatar_janitor_cursors WHERE epoch = ? AND cursor = ?`).bind(state.epoch, next).first();
		if (seen) throw new JanitorRefusal({ kind: 'list_cursor', reason: 'repeated', listed: cp.objects + page.objects.length });
		statements.push(env.BICKR_D1.prepare(`INSERT INTO avatar_janitor_cursors(epoch, cursor) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM avatar_janitor_control WHERE id = 1 AND lease_token = ?)`).bind(state.epoch, next, state.token));
		cp.cursor = next;
	} else { state.phase = 'mark'; cp.cursor = ''; }
	const cutoff = Date.parse(cp.startedAt) - avatarJanitorGraceMs;
	const old: string[] = [];
	for (const object of page.objects) {
		if (!Number.isFinite(object.uploaded.getTime())) throw new Error('Avatar object upload timestamp is invalid.');
		if (object.uploaded.getTime() > cutoff) cp.retainedInGrace++;
		else old.push(object.key);
	}
	cp.objects += page.objects.length;
	statements.push(insertKeys(env.BICKR_D1, state, 'avatar_janitor_objects', old));
	await save(env.BICKR_D1, state, statements);
}

async function markPage(env: AvatarJanitorEnv, state: State): Promise<void> {
	const cp = state.checkpoint;
	const { table, idColumn } = entityWalks[cp.entity];
	const result = await env.BICKR_D1.prepare(`SELECT ${idColumn} AS id, avatar_url AS avatarUrl${cp.entity === 'bot' ? ', home_world_id AS homeWorldId, lifecycle_state AS lifecycleState' : ''} FROM ${table} WHERE deleted_at IS NULL AND ${idColumn} > ? ORDER BY ${idColumn} ASC LIMIT ?`).bind(cp.cursor, avatarJanitorRowPageSize).all<AvatarEntityRow>();
	const rows = result.results ?? [];
	const keys = new Set<string>();
	const documents = new Map<string, BotDocument | null>();
	const loaded = await Promise.all(rows.map((row) => readEntityDocument(env.BICKR_KV, cp.entity, row.id)));
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!; const document = loaded[i];
		if (!document) throw new JanitorRefusal({ kind: 'missing_document', entity: cp.entity, id: row.id });
		addKeyFromUrl(keys, env.BICKR_R2_PUBLIC_BASE_URL!, row.avatarUrl);
		if (document.avatar?.key) keys.add(document.avatar.key);
		const override = (document as BotDocument).localOverrides?.avatar?.key;
		if (override) keys.add(override);
		if (cp.entity === 'bot') {
			documents.set(row.id, document as BotDocument);
			// Resumable imports reuse a deterministic key. A pending import may be
			// older than the grace window and has not yet published its avatar in KV.
			if (row.lifecycleState !== 'active' && row.homeWorldId) {
				for (const extension of ['jpg', 'png', 'webp']) keys.add(`worlds/${encodeURIComponent(row.homeWorldId)}/bots/${encodeURIComponent(row.id)}/avatars/lifecycle-import.${extension}`);
			}
		}
	}
	if (cp.entity === 'bot' && rows.length) {
		const chain = await env.BICKR_D1.prepare(`WITH RECURSIVE chain(botId, sourceBotId, linked, depth) AS (
   SELECT bot_id, source_bot_id, linked, 0 FROM bot_clone_sources WHERE bot_id IN (SELECT value FROM json_each(?))
   UNION ALL
   SELECT source.bot_id, source.source_bot_id, source.linked, chain.depth + 1 FROM chain JOIN bot_clone_sources source ON source.bot_id = chain.sourceBotId WHERE chain.linked != 0 AND chain.depth < ?
  ) SELECT DISTINCT botId, sourceBotId, linked FROM chain`).bind(JSON.stringify(rows.map((row) => row.id)), avatarJanitorMaxCloneChainDepth).all<CloneSourceRow>();
		const byId = new Map((chain.results ?? []).map((row) => [row.botId, row]));
		cp.cloneSourceReads += byId.size;
		for (const row of rows) {
			const link = byId.get(row.id);
			if (!link?.linked || documents.get(row.id)?.avatar?.key) continue;
			const inherited = await inheritedAvatarKey(env.BICKR_KV, documents, byId, link.sourceBotId);
			if (inherited.kind === 'unresolved') throw new JanitorRefusal({ kind: 'unresolved_clone_chain', reason: inherited.reason, botId: row.id, sourceBotId: inherited.sourceBotId });
			if (inherited.key) keys.add(inherited.key);
		}
	}
	cp.entities += rows.length;
	cp.cursor = rows.at(-1)?.id ?? cp.cursor;
	if (rows.length < avatarJanitorRowPageSize) {
		cp.cursor = '';
		if (cp.entity === 'bot') cp.entity = 'world';
		else if (cp.entity === 'world') cp.entity = 'user';
		else state.phase = 'sweep';
	}
	await save(env.BICKR_D1, state, [insertKeys(env.BICKR_D1, state, 'avatar_janitor_marks', [...keys])]);
}
async function sweepPage(env: AvatarJanitorEnv, state: State): Promise<void> {
	const result = await env.BICKR_D1.prepare(`SELECT objects.object_key AS key, marks.object_key AS marked FROM avatar_janitor_objects objects LEFT JOIN avatar_janitor_marks marks ON marks.epoch = objects.epoch AND marks.object_key = objects.object_key WHERE objects.epoch = ? AND objects.object_key > ? ORDER BY objects.object_key LIMIT ?`).bind(state.epoch, state.checkpoint.cursor, avatarJanitorMaxDeletesPerRun).all<{ key: string; marked: string | null }>();
	const rows = result.results ?? [];
	const keys = rows.filter((row) => !row.marked).map((row) => row.key);
	if (keys.length) {
		const lease = await env.BICKR_D1.prepare(`SELECT 1 FROM avatar_janitor_control WHERE id = 1 AND epoch = ? AND phase = 'sweep' AND lease_token = ?`).bind(state.epoch, state.token).first();
		if (!lease) throw new JanitorLeaseLost();
		// Recheck after acquiring the page: index triggers can add marks at any time.
		const marked = await env.BICKR_D1.prepare(`SELECT object_key AS key FROM avatar_janitor_marks WHERE epoch = ? AND object_key IN (SELECT value FROM json_each(?))`).bind(state.epoch, JSON.stringify(keys)).all<{ key: string }>();
		const retained = new Set((marked.results ?? []).map((row) => row.key));
		const deletable = keys.filter((key) => !retained.has(key));
		if (deletable.length) await env.BICKR_R2!.delete(deletable);
		state.checkpoint.deleted += deletable.length;
		state.checkpoint.deletedSample.push(...deletable.slice(0, Math.max(0, avatarJanitorReportedKeyLimit - state.checkpoint.deletedSample.length)));
	}
	state.checkpoint.cursor = rows.at(-1)?.key ?? state.checkpoint.cursor;
	if (rows.length < avatarJanitorMaxDeletesPerRun) { state.phase = 'cleanup'; state.checkpoint.cursor = ''; }
	await save(env.BICKR_D1, state);
}
async function cleanupPage(db: D1DatabaseLike, state: State): Promise<boolean> {
	const results = await db.batch(['avatar_janitor_objects', 'avatar_janitor_marks', 'avatar_janitor_cursors'].map((table) => {
		const key = table === 'avatar_janitor_cursors' ? 'cursor' : 'object_key';
		return db.prepare(`DELETE FROM ${table} WHERE epoch = ? AND ${key} IN (SELECT ${key} FROM ${table} WHERE epoch = ? LIMIT ?) AND EXISTS (SELECT 1 FROM avatar_janitor_control WHERE id = 1 AND lease_token = ?)`).bind(state.epoch, state.epoch, cleanupPageSize, state.token);
	}));
	return results.every((result) => (result.meta?.changes ?? 0) < cleanupPageSize);
}

/** Resolve inherited avatars from raw KV, including tombstoned sources. */
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

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : 'UnknownError';
}
