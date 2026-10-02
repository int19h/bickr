import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { kvKeys } from '@bickr/shared/storage';
import {
	avatarJanitorGraceMs,
	avatarJanitorIntervalMs,
	avatarJanitorMaxDeletesPerRun,
	runAvatarJanitor as runStep,
	type AvatarJanitorEnv,
	type EntityKind,
} from './janitor';

const connections: DatabaseSync[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
async function runAvatarJanitor(...args: Parameters<typeof runStep>) {
	for (let i = 0; i < 1_000; i++) {
		const result = await runStep(...args);
		if (result.status !== 'in_progress') return result;
	}
	throw new Error('Janitor failed to finish within the test budget.');
}

const now = '2026-08-17T03:23:00.000Z';
const nowMs = Date.parse(now);
const publicBaseUrl = 'https://test-assets.bickr.social';

type IndexRow = { id: string; avatarUrl: string | null; deletedAt: string | null };
type CloneRow = { botId: string; sourceBotId: string; linked: number };

type Fixture = {
	bots?: IndexRow[];
	worlds?: IndexRow[];
	users?: IndexRow[];
	clones?: CloneRow[];
	/** KV documents by key, including tombstoned ones no index row points at. */
	documents?: Record<string, unknown>;
	objects?: { key: string; agedDays: number }[];
	marker?: string;
	failD1?: (sql: string) => boolean;
	failKv?: (key: string) => boolean;
	failList?: boolean;
	/** Report every page as truncated, with a cursor the janitor cannot use. */
	brokenListCursor?: 'missing' | 'repeated';
	failDelete?: boolean;
};

type JanitorHarness = {
	env: AvatarJanitorEnv;
	deleted: string[];
	listCalls: number;
	kvReads: number;
	kvValues: Map<string, string>;
};

function bot(id: string, options: { avatarUrl?: string; deletedAt?: string } = {}): IndexRow {
	return { id, avatarUrl: options.avatarUrl ?? null, deletedAt: options.deletedAt ?? null };
}

function botDocument(id: string, options: { key?: string; deletedAt?: string } = {}): unknown {
	return {
		id,
		type: 'bot',
		...(options.key ? { avatar: { key: options.key, url: `${publicBaseUrl}/${options.key}`, contentType: 'image/png', updatedAt: now } } : {}),
		...(options.deletedAt ? { deletedAt: options.deletedAt } : {}),
	};
}

function harness(fixture: Fixture): JanitorHarness {
	const rows: Record<'bots_index' | 'worlds_index' | 'users_index', IndexRow[]> = {
		bots_index: fixture.bots ?? [],
		worlds_index: fixture.worlds ?? [],
		users_index: fixture.users ?? [],
	};
	const clones = fixture.clones ?? [];
	const documents = new Map(Object.entries(fixture.documents ?? {}));
	const kvValues = new Map<string, string>();
	if (fixture.marker) {
		kvValues.set(kvKeys.avatarJanitorLastRun, JSON.stringify({ lastRunAt: fixture.marker }));
	}
	const deleted: string[] = [];
	const state = { listCalls: 0, kvReads: 0 };
	const db = new DatabaseSync(':memory:');
	connections.push(db);
	db.exec(`CREATE TABLE bots_index (bot_id TEXT PRIMARY KEY, avatar_url TEXT, deleted_at TEXT, home_world_id TEXT DEFAULT 'w1', lifecycle_state TEXT DEFAULT 'active');
	 CREATE TABLE worlds_index (world_id TEXT PRIMARY KEY, avatar_url TEXT, deleted_at TEXT);
	 CREATE TABLE users_index (user_id TEXT PRIMARY KEY, avatar_url TEXT, deleted_at TEXT);
	 CREATE TABLE bot_clone_sources (bot_id TEXT PRIMARY KEY, source_bot_id TEXT, linked INTEGER);`);
	db.exec(readFileSync(new NodeURL('../../../../migrations/0063_avatar_janitor_epochs.sql', import.meta.url), 'utf8'));
	for (const [table, column] of [['bots_index', 'bot_id'], ['worlds_index', 'world_id'], ['users_index', 'user_id']] as const) {
		const insert = db.prepare(`INSERT INTO ${table} (${column}, avatar_url, deleted_at) VALUES (?, ?, ?)`);
		for (const row of rows[table]) insert.run(row.id, row.avatarUrl, row.deletedAt);
	}
	for (const row of clones) db.prepare('INSERT INTO bot_clone_sources VALUES (?, ?, ?)').run(row.botId, row.sourceBotId, row.linked);
	const database: AvatarJanitorEnv['BICKR_D1'] = {
		prepare(sql) {
			if (fixture.failD1?.(sql)) throw new Error('D1 read failed');
			let values: SQLInputValue[] = [];
			const statement = {
				bind(...args: unknown[]) { values = args as SQLInputValue[]; return statement; },
				async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null; },
				async all<T>() { return { success: true, results: db.prepare(sql).all(...values) as T[] }; },
				async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
			};
			return statement;
		},
		async batch(statements) {
			db.exec('BEGIN');
			try {
				const results = [];
				for (const statement of statements) results.push(await statement.run());
				db.exec('COMMIT');
				return results;
			} catch (error) { db.exec('ROLLBACK'); throw error; }
		},
	};

	const env: AvatarJanitorEnv = {
		BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
		BICKR_KV: {
			async get(key: string) {
				state.kvReads += 1;
				if (fixture.failKv?.(key)) {
					throw new Error(`KV read failed for ${key}`);
				}
				if (key === kvKeys.avatarJanitorLastRun) {
					const stored = kvValues.get(key);
					return stored === undefined ? null : (JSON.parse(stored) as unknown);
				}
				return documents.get(key) ?? null;
			},
			async put(key: string, value: string) {
				kvValues.set(key, value);
			},
			async delete(key: string) {
				kvValues.delete(key);
			},
		},
		BICKR_D1: database,
		BICKR_R2: {
			async list(options?: { cursor?: string; limit?: number }) {
				state.listCalls += 1;
				if (fixture.failList) {
					throw new Error('R2 list failed');
				}
				const objects = (fixture.objects ?? []).map((object) => ({
					key: object.key,
					uploaded: new Date(nowMs - object.agedDays * 24 * 60 * 60 * 1_000),
				}));
				const start = options?.cursor ? Number(options.cursor) : 0;
				const limit = options?.limit ?? 1_000;
				const page = objects.slice(start, start + limit);
				const next = start + page.length;
				if (fixture.brokenListCursor === 'missing') {
					return { objects: page, truncated: true as const };
				}
				if (fixture.brokenListCursor === 'repeated') {
					// A cursor that never advances: the same page, forever.
					return { objects: page, truncated: true as const, cursor: 'stuck' };
				}
				return next < objects.length
					? { objects: page, truncated: true as const, cursor: String(next) }
					: { objects: page, truncated: false as const };
			},
			async delete(keys: string[]) {
				if (fixture.failDelete) {
					throw new Error('R2 delete failed');
				}
				deleted.push(...keys);
			},
		},
	};
	return {
		env,
		deleted,
		kvValues,
		get kvReads() { return state.kvReads; },
		get listCalls() {
			return state.listCalls;
		},
	} as JanitorHarness;
}

function markerOf(kvValues: Map<string, string>): string | undefined {
	const stored = kvValues.get(kvKeys.avatarJanitorLastRun);
	return stored ? (JSON.parse(stored) as { lastRunAt: string }).lastRunAt : undefined;
}

describe('R2 avatar janitor', () => {
	it('deletes only objects that are unreferenced and past the grace period', async () => {
		const test = harness({
			bots: [
				bot('bot_a', { avatarUrl: `${publicBaseUrl}/worlds/w1/bots/bot_a/avatars/live.png` }),
				// Indexed but with the document as the only witness of its avatar.
				bot('bot_b'),
			],
			worlds: [bot('w1', { avatarUrl: `${publicBaseUrl}/worlds/w1/world/avatars/world.png` })],
			users: [bot('usr_1')],
			documents: {
				[kvKeys.bot('bot_a')]: botDocument('bot_a', { key: 'worlds/w1/bots/bot_a/avatars/live.png' }),
				[kvKeys.bot('bot_b')]: botDocument('bot_b', { key: 'worlds/w1/bots/bot_b/avatars/doc-only.png' }),
				[kvKeys.world('w1')]: { id: 'w1', type: 'world', avatar: { key: 'worlds/w1/world/avatars/world.png' } },
				[kvKeys.user('usr_1')]: { id: 'usr_1', type: 'user', avatar: { key: 'users/usr_1/avatars/user.png' } },
			},
			objects: [
				{ key: 'worlds/w1/bots/bot_a/avatars/live.png', agedDays: 30 },
				{ key: 'worlds/w1/bots/bot_b/avatars/doc-only.png', agedDays: 30 },
				{ key: 'worlds/w1/world/avatars/world.png', agedDays: 30 },
				{ key: 'users/usr_1/avatars/user.png', agedDays: 30 },
				{ key: 'worlds/w1/bots/bot_a/avatars/replaced.png', agedDays: 30 },
				{ key: 'worlds/w1/bots/bot_a/avatar-candidates/in-flight.png', agedDays: 2 },
				{ key: 'worlds/w1/bots/bot_a/avatars/lifecycle-import.jpg', agedDays: 1 },
			],
		});

		const result = await runAvatarJanitor(test.env, { now });

		expect(result).toMatchObject({
			status: 'swept',
			entities: 4,
			objects: 7,
			deleted: 1,
			retainedInGrace: 2,
		});
		expect(test.deleted).toEqual(['worlds/w1/bots/bot_a/avatars/replaced.png']);
		expect(markerOf(test.kvValues)).toBe(now);
	});

	it('keeps the avatar a live linked clone inherits from a tombstoned source', async () => {
		const test = harness({
			// The source is tombstoned — mid account cascade — while the clone that
			// renders its avatar is still live. `effectiveBotDocument` cannot resolve
			// this at all (#192), so the janitor loads the raw document.
			bots: [bot('bot_clone'), bot('bot_source', { deletedAt: '2026-08-16T00:00:00.000Z' })],
			clones: [{ botId: 'bot_clone', sourceBotId: 'bot_source', linked: 1 }],
			documents: {
				[kvKeys.bot('bot_clone')]: botDocument('bot_clone'),
				[kvKeys.bot('bot_source')]: botDocument('bot_source', {
					key: 'worlds/w1/bots/bot_source/avatars/inherited.png',
					deletedAt: '2026-08-16T00:00:00.000Z',
				}),
			},
			objects: [{ key: 'worlds/w1/bots/bot_source/avatars/inherited.png', agedDays: 30 }],
		});

		const result = await runAvatarJanitor(test.env, { now });

		expect(result).toMatchObject({ status: 'swept', deleted: 0 });
		expect(test.deleted).toEqual([]);
	});

	it('follows a clone chain through a tombstoned intermediate clone', async () => {
		const test = harness({
			bots: [
				bot('bot_leaf'),
				bot('bot_middle', { deletedAt: '2026-08-16T00:00:00.000Z' }),
				bot('bot_root', { deletedAt: '2026-08-16T00:00:00.000Z' }),
			],
			clones: [
				{ botId: 'bot_leaf', sourceBotId: 'bot_middle', linked: 1 },
				{ botId: 'bot_middle', sourceBotId: 'bot_root', linked: 1 },
			],
			documents: {
				[kvKeys.bot('bot_leaf')]: botDocument('bot_leaf'),
				[kvKeys.bot('bot_middle')]: botDocument('bot_middle', { deletedAt: '2026-08-16T00:00:00.000Z' }),
				[kvKeys.bot('bot_root')]: botDocument('bot_root', {
					key: 'worlds/w1/bots/bot_root/avatars/root.png',
					deletedAt: '2026-08-16T00:00:00.000Z',
				}),
			},
			objects: [{ key: 'worlds/w1/bots/bot_root/avatars/root.png', agedDays: 30 }],
		});

		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({ status: 'swept', deleted: 0 });
		expect(test.deleted).toEqual([]);
	});

	it('stops protecting a source once the clone is unlinked or has its own avatar', async () => {
		const test = harness({
			bots: [bot('bot_unlinked'), bot('bot_own')],
			clones: [
				{ botId: 'bot_unlinked', sourceBotId: 'bot_source_a', linked: 0 },
				{ botId: 'bot_own', sourceBotId: 'bot_source_b', linked: 1 },
			],
			documents: {
				[kvKeys.bot('bot_unlinked')]: botDocument('bot_unlinked'),
				[kvKeys.bot('bot_own')]: botDocument('bot_own', { key: 'worlds/w1/bots/bot_own/avatars/local.png' }),
				[kvKeys.bot('bot_source_a')]: botDocument('bot_source_a', {
					key: 'worlds/w1/bots/bot_source_a/avatars/dropped.png',
					deletedAt: '2026-08-16T00:00:00.000Z',
				}),
				[kvKeys.bot('bot_source_b')]: botDocument('bot_source_b', {
					key: 'worlds/w1/bots/bot_source_b/avatars/shadowed.png',
					deletedAt: '2026-08-16T00:00:00.000Z',
				}),
			},
			objects: [
				{ key: 'worlds/w1/bots/bot_own/avatars/local.png', agedDays: 30 },
				{ key: 'worlds/w1/bots/bot_source_a/avatars/dropped.png', agedDays: 30 },
				{ key: 'worlds/w1/bots/bot_source_b/avatars/shadowed.png', agedDays: 30 },
			],
		});

		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({ status: 'swept', deleted: 2 });
		expect(test.deleted.sort()).toEqual([
			'worlds/w1/bots/bot_source_a/avatars/dropped.png',
			'worlds/w1/bots/bot_source_b/avatars/shadowed.png',
		]);
	});

	it('keeps unreferenced objects until the grace period expires', async () => {
		const grace = avatarJanitorGraceMs / (24 * 60 * 60 * 1_000);
		const test = harness({
			objects: [
				{ key: 'worlds/w1/bots/bot_a/avatar-candidates/fresh.png', agedDays: grace - 1 },
				{ key: 'worlds/w1/bots/bot_a/avatar-candidates/expired.png', agedDays: grace + 1 },
			],
		});

		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({
			status: 'swept',
			deleted: 1,
			retainedInGrace: 1,
		});
		expect(test.deleted).toEqual(['worlds/w1/bots/bot_a/avatar-candidates/expired.png']);
	});

	it('runs at most weekly and records the run that swept', async () => {
		const objects = [{ key: 'worlds/w1/bots/bot_a/avatars/orphan.png', agedDays: 30 }];
		const recent = harness({ objects, marker: new Date(nowMs - avatarJanitorIntervalMs + 60_000).toISOString() });
		const skipped = await runAvatarJanitor(recent.env, { now });
		expect(skipped).toMatchObject({ status: 'skipped_not_due' });
		expect(recent.listCalls).toBe(0);
		expect(recent.deleted).toEqual([]);

		const due = harness({ objects, marker: new Date(nowMs - avatarJanitorIntervalMs - 60_000).toISOString() });
		expect(await runAvatarJanitor(due.env, { now })).toMatchObject({ status: 'swept', deleted: 1 });
		expect(markerOf(due.kvValues)).toBe(now);
	});

	it('aborts the deletion phase when any read fails, and retries on the next run', async () => {
		const objects = [{ key: 'worlds/w1/bots/bot_a/avatars/orphan.png', agedDays: 30 }];
		const documents = { [kvKeys.bot('bot_a')]: botDocument('bot_a') };
		const bots = [bot('bot_a')];

		const d1Failure = harness({ bots, documents, objects, failD1: (sql) => sql.includes('FROM bot_clone_sources') });
		expect(await runAvatarJanitor(d1Failure.env, { now })).toMatchObject({
			status: 'aborted',
			failure: { kind: 'read_error', phase: 'mark' },
		});
		expect(d1Failure.deleted).toEqual([]);
		// No marker: a transient failure must not cost the fleet a whole week.
		expect(markerOf(d1Failure.kvValues)).toBeUndefined();

		const kvFailure = harness({ bots, documents, objects, failKv: (key) => key === kvKeys.bot('bot_a') });
		expect(await runAvatarJanitor(kvFailure.env, { now })).toMatchObject({
			status: 'aborted',
			failure: { kind: 'read_error', phase: 'mark' },
		});
		expect(kvFailure.deleted).toEqual([]);

		const listFailure = harness({ bots, documents, objects, failList: true });
		expect(await runAvatarJanitor(listFailure.env, { now })).toMatchObject({
			status: 'aborted',
			failure: { kind: 'read_error', phase: 'sweep' },
		});
		expect(listFailure.deleted).toEqual([]);
		expect(markerOf(listFailure.kvValues)).toBeUndefined();

		const deleteFailure = harness({ bots, documents, objects, failDelete: true });
		expect(await runAvatarJanitor(deleteFailure.env, { now })).toMatchObject({
			status: 'aborted',
			failure: { kind: 'read_error', phase: 'sweep' },
		});
		expect(markerOf(deleteFailure.kvValues)).toBeUndefined();
	});

	it('resolves a clone chain that simply ends, and keeps sweeping', async () => {
		// The distinction the refusals below depend on: a source with no avatar and
		// no source of its own is a complete answer, not an unresolved one.
		const test = harness({
			bots: [bot('bot_clone')],
			clones: [{ botId: 'bot_clone', sourceBotId: 'bot_source', linked: 1 }],
			documents: {
				[kvKeys.bot('bot_clone')]: botDocument('bot_clone'),
				[kvKeys.bot('bot_source')]: botDocument('bot_source', { deletedAt: '2026-08-16T00:00:00.000Z' }),
			},
			objects: [{ key: 'worlds/w1/bots/bot_a/avatars/orphan.png', agedDays: 30 }],
		});

		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({ status: 'swept', deleted: 1 });
		expect(markerOf(test.kvValues)).toBe(now);
	});

	it('aborts without deleting when a live indexed entity has no document', async () => {
		const objects = [{ key: 'worlds/w1/bots/bot_a/avatars/orphan.png', agedDays: 30 }];
		// An index row with no document is an avatar this run cannot see, which is
		// not the same observation as an entity that has none.
		const cases: { entity: EntityKind; id: string; fixture: Fixture }[] = [
			{ entity: 'bot', id: 'bot_a', fixture: { bots: [bot('bot_a')] } },
			{ entity: 'world', id: 'w1', fixture: { worlds: [bot('w1')] } },
			{ entity: 'user', id: 'usr_1', fixture: { users: [bot('usr_1')] } },
		];

		for (const { entity, id, fixture } of cases) {
			const test = harness({ ...fixture, objects });
			expect(await runAvatarJanitor(test.env, { now })).toMatchObject({
				status: 'aborted',
				failure: { kind: 'missing_document', entity, id },
			});
			expect(test.deleted).toEqual([]);
			// No marker: the refusal is re-derived and re-logged daily until an owner
			// reconciles the index with the documents.
			expect(markerOf(test.kvValues)).toBeUndefined();
		}
	});

	it('aborts without deleting when a clone chain cannot be resolved', async () => {
		const objects = [{ key: 'worlds/w1/bots/bot_a/avatars/orphan.png', agedDays: 30 }];

		const missingSource = harness({
			bots: [bot('bot_clone')],
			clones: [{ botId: 'bot_clone', sourceBotId: 'bot_source', linked: 1 }],
			documents: { [kvKeys.bot('bot_clone')]: botDocument('bot_clone') },
			objects,
		});
		expect(await runAvatarJanitor(missingSource.env, { now })).toMatchObject({
			status: 'aborted',
			failure: {
				kind: 'unresolved_clone_chain',
				reason: 'missing_source',
				botId: 'bot_clone',
				sourceBotId: 'bot_source',
			},
		});
		expect(missingSource.deleted).toEqual([]);
		expect(markerOf(missingSource.kvValues)).toBeUndefined();

		const cycle = harness({
			bots: [bot('bot_clone')],
			clones: [
				{ botId: 'bot_clone', sourceBotId: 'bot_left', linked: 1 },
				{ botId: 'bot_left', sourceBotId: 'bot_right', linked: 1 },
				{ botId: 'bot_right', sourceBotId: 'bot_left', linked: 1 },
			],
			documents: {
				[kvKeys.bot('bot_clone')]: botDocument('bot_clone'),
				[kvKeys.bot('bot_left')]: botDocument('bot_left'),
				[kvKeys.bot('bot_right')]: botDocument('bot_right'),
			},
			objects,
		});
		expect(await runAvatarJanitor(cycle.env, { now })).toMatchObject({
			status: 'aborted',
			failure: { kind: 'unresolved_clone_chain', reason: 'cycle', botId: 'bot_clone' },
		});
		expect(cycle.deleted).toEqual([]);
		expect(markerOf(cycle.kvValues)).toBeUndefined();

		// A chain longer than the repository's own effective-document limit: the
		// janitor cannot see where it ends, so it does not guess that it ends here.
		const links = Array.from({ length: 40 }, (_item, index) => `bot_link_${String(index).padStart(2, '0')}`);
		const deepChain = harness({
			bots: [bot('bot_clone')],
			clones: [
				{ botId: 'bot_clone', sourceBotId: links[0] ?? '', linked: 1 },
				...links.slice(0, -1).map((id, index) => ({ botId: id, sourceBotId: links[index + 1] ?? '', linked: 1 })),
			],
			documents: {
				[kvKeys.bot('bot_clone')]: botDocument('bot_clone'),
				...Object.fromEntries(links.map((id) => [kvKeys.bot(id), botDocument(id)])),
			},
			objects,
		});
		expect(await runAvatarJanitor(deepChain.env, { now })).toMatchObject({
			status: 'aborted',
			failure: { kind: 'unresolved_clone_chain', reason: 'depth_exhausted', botId: 'bot_clone' },
		});
		expect(deepChain.deleted).toEqual([]);
		expect(markerOf(deepChain.kvValues)).toBeUndefined();
	});

	it('aborts a truncated listing it cannot continue', async () => {
		const objects = [{ key: 'worlds/w1/bots/bot_a/avatars/orphan.png', agedDays: 30 }];

		const missing = harness({ objects, brokenListCursor: 'missing' });
		expect(await runAvatarJanitor(missing.env, { now })).toMatchObject({
			status: 'aborted',
			failure: { kind: 'list_cursor', reason: 'missing', listed: 1 },
		});
		expect(missing.listCalls).toBe(1);
		expect(missing.deleted).toEqual([]);
		expect(markerOf(missing.kvValues)).toBeUndefined();

		// A cursor that does not advance would otherwise spin until the invocation
		// is killed, or sweep against a bucket listed twice and truncated anyway.
		const repeated = harness({ objects, brokenListCursor: 'repeated' });
		expect(await runAvatarJanitor(repeated.env, { now })).toMatchObject({
			status: 'aborted',
			failure: { kind: 'list_cursor', reason: 'repeated' },
		});
		expect(repeated.listCalls).toBe(2);
		expect(repeated.deleted).toEqual([]);
		expect(markerOf(repeated.kvValues)).toBeUndefined();
	});

	it('resumes a fleet larger than the old ceiling without restarting the listing', async () => {
		const bots = Array.from({ length: 2_001 }, (_, index) => bot(`bot_${index}`));
		const documents = Object.fromEntries(bots.map((row) => [kvKeys.bot(row.id), botDocument(row.id)]));
		const test = harness({ bots, documents, objects: [{ key: 'worlds/w1/bots/bot_a/avatars/orphan.png', agedDays: 30 }] });
		expect(await runStep(test.env, { now })).toMatchObject({ status: 'in_progress', phase: 'mark' });
		expect(test.deleted).toEqual([]);
		expect(test.kvReads).toBeLessThanOrEqual(41);
		let finished = false;
		for (let invocation = 0; invocation < 100; invocation++) {
			const before = test.kvReads;
			const result = await runStep(test.env, { now });
			expect(test.kvReads - before).toBeLessThanOrEqual(40);
			if (result.status === 'swept') {
				expect(result).toMatchObject({ entities: 2_001, deleted: 1 });
				finished = true;
				break;
			}
			expect(result.status).toBe('in_progress');
		}
		expect(finished).toBe(true);
		expect(test.listCalls).toBe(1);
		expect(markerOf(test.kvValues)).toBe(now);
	});

	it('reclaims many old objects in bounded batches', async () => {
		const objects = Array.from({ length: avatarJanitorMaxDeletesPerRun * 11 }, (_, index) => ({
			key: `worlds/w1/bots/bot_a/avatars/orphan-${index}.png`, agedDays: 30,
		}));
		const test = harness({ objects });
		let previous = 0;
		for (let i = 0; i < 100; i++) {
			const result = await runStep(test.env, { now });
			expect(test.deleted.length - previous).toBeLessThanOrEqual(avatarJanitorMaxDeletesPerRun);
			previous = test.deleted.length;
			if (result.status === 'swept') break;
			expect(result.status).toBe('in_progress');
		}
		expect(new Set(test.deleted).size).toBe(objects.length);
		expect(test.listCalls).toBe(2);
	});

	it('pins index references changed after their mark page', async () => {
		const oldKey = 'worlds/w1/bots/bot_a/avatars/old.png';
		const newKey = 'worlds/w1/bots/bot_a/avatars/new.png';
		const test = harness({
			bots: [bot('bot_a', { avatarUrl: `${publicBaseUrl}/${oldKey}` })],
			documents: { [kvKeys.bot('bot_a')]: botDocument('bot_a', { key: oldKey }) },
			objects: [{ key: oldKey, agedDays: 30 }, { key: newKey, agedDays: 30 }],
		});
		expect(await runStep(test.env, { now })).toMatchObject({ status: 'in_progress', phase: 'sweep' });
		await test.env.BICKR_D1.prepare('UPDATE bots_index SET avatar_url = ? WHERE bot_id = ?').bind(`${publicBaseUrl}/${newKey}`, 'bot_a').run();
		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({ status: 'swept', deleted: 0 });
		expect(test.deleted).toEqual([]);
		for (const table of ['avatar_janitor_marks', 'avatar_janitor_objects', 'avatar_janitor_cursors']) {
			expect(await test.env.BICKR_D1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toMatchObject({ n: 0 });
		}
	});

	it('pins the old source URL when it changes before that source is marked', async () => {
		const oldKey = 'worlds/w1/bots/zz_source/avatars/old.png';
		const newKey = 'worlds/w1/bots/zz_source/avatars/new.png';
		const bots = [...Array.from({ length: 40 }, (_, i) => bot(`bot_${i}`)), bot('zz_source', { avatarUrl: `${publicBaseUrl}/${oldKey}` })];
		const source = botDocument('zz_source', { key: oldKey }) as { avatar: { key: string } };
		const documents = Object.fromEntries(bots.map((row) => [kvKeys.bot(row.id), row.id === 'zz_source' ? source : botDocument(row.id)]));
		const test = harness({ bots, documents, objects: [{ key: oldKey, agedDays: 30 }] });
		expect(await runStep(test.env, { now })).toMatchObject({ status: 'in_progress', phase: 'mark' });
		source.avatar.key = newKey;
		await test.env.BICKR_D1.prepare('UPDATE bots_index SET avatar_url = ? WHERE bot_id = ?').bind(`${publicBaseUrl}/${newKey}`, 'zz_source').run();
		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({ status: 'swept', deleted: 0 });
	});

	it('protects an interrupted deterministic import older than the grace window', async () => {
		const key = 'worlds/w1/bots/bot_a/avatars/lifecycle-import.png';
		const test = harness({ bots: [bot('bot_a')], documents: { [kvKeys.bot('bot_a')]: botDocument('bot_a') }, objects: [{ key, agedDays: 90 }] });
		await test.env.BICKR_D1.prepare("UPDATE bots_index SET lifecycle_state = 'pending' WHERE bot_id = 'bot_a'").run();
		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({ status: 'swept', deleted: 0 });
	});

	it('does not start a new epoch for a resume-only call', async () => {
		const test = harness({});
		expect(await runStep(test.env, { now, resumeOnly: true })).toMatchObject({ status: 'skipped_inactive' });
		expect(test.listCalls).toBe(0);
	});

	it('serializes concurrent calls and fences an expired lease', async () => {
		const test = harness({});
		let release!: (value: { objects: []; truncated: false }) => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		let calls = 0;
		test.env.BICKR_R2!.list = async () => {
			if (++calls === 1) { entered(); return new Promise((resolve) => { release = resolve; }); }
			return { objects: [], truncated: false };
		};
		const original = runStep(test.env, { now });
		await started;
		expect(await runStep(test.env, { now })).toMatchObject({ status: 'skipped_busy' });
		const later = new Date(nowMs + 16 * 60_000).toISOString();
		expect(await runStep(test.env, { now: later })).toMatchObject({ status: 'in_progress', phase: 'sweep' });
		release({ objects: [], truncated: false });
		expect(await original).toMatchObject({ status: 'aborted', failure: { errorName: 'JanitorLeaseLost' } });
		expect(await test.env.BICKR_D1.prepare('SELECT phase FROM avatar_janitor_control WHERE id = 1').first()).toMatchObject({ phase: 'sweep' });
		expect(await runAvatarJanitor(test.env, { now: later })).toMatchObject({ status: 'swept' });
	});

	it('reports a missing bucket or public base URL instead of sweeping blind', async () => {
		const test = harness({});
		const noBucket = { ...test.env };
		delete noBucket.BICKR_R2;
		expect(await runAvatarJanitor(noBucket, { now })).toMatchObject({
			status: 'skipped_unconfigured',
			missing: 'bucket',
		});

		const noBase = { ...test.env, BICKR_R2_PUBLIC_BASE_URL: '  ' };
		expect(await runAvatarJanitor(noBase, { now })).toMatchObject({
			status: 'skipped_unconfigured',
			missing: 'public_base_url',
		});
	});
});
