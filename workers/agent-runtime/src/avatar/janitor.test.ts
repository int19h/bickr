import { describe, expect, it } from 'vitest';
import { kvKeys } from '@bickr/shared/storage';
import {
	avatarJanitorGraceMs,
	avatarJanitorIntervalMs,
	avatarJanitorMaxDeletesPerRun,
	avatarJanitorMaxEntities,
	runAvatarJanitor,
	type AvatarJanitorEnv,
} from './janitor';

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
	failDelete?: boolean;
};

type JanitorHarness = {
	env: AvatarJanitorEnv;
	deleted: string[];
	listCalls: number;
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
	const state = { listCalls: 0 };
	const live = (table: keyof typeof rows) => rows[table].filter((row) => row.deletedAt === null);
	const tableOf = (sql: string): keyof typeof rows | null =>
		sql.includes('FROM bots_index') ? 'bots_index'
		: sql.includes('FROM worlds_index') ? 'worlds_index'
		: sql.includes('FROM users_index') ? 'users_index'
		: null;

	const env: AvatarJanitorEnv = {
		BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
		BICKR_KV: {
			async get(key: string) {
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
		BICKR_D1: {
			prepare(sql: string) {
				if (fixture.failD1?.(sql)) {
					throw new Error(`D1 query failed: ${sql}`);
				}
				const bindable = {
					bind(...values: unknown[]) {
						return {
							async first<T>() {
								return {
									bots: live('bots_index').length,
									worlds: live('worlds_index').length,
									users: live('users_index').length,
								} as T;
							},
							async all<T>() {
								if (sql.includes('FROM bot_clone_sources')) {
									return { success: true, results: [...clones] as T[] };
								}
								const table = tableOf(sql);
								if (!table) {
									throw new Error(`Unexpected janitor query: ${sql}`);
								}
								const keyed = sql.includes('> ?');
								const after = keyed ? String(values[0]) : '';
								const limit = Number(values[keyed ? 1 : 0]);
								const page = live(table)
									.slice()
									.sort((left, right) => left.id.localeCompare(right.id))
									.filter((row) => row.id > after)
									.slice(0, limit)
									.map((row) => ({ id: row.id, avatarUrl: row.avatarUrl }));
								return { success: true, results: page as T[] };
							},
							async run() {
								return { success: true };
							},
						};
					},
				};
				return { ...bindable, ...bindable.bind() };
			},
		} as unknown as AvatarJanitorEnv['BICKR_D1'],
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

	it('skips the week when the fleet exceeds the single-invocation budget', async () => {
		const bots = Array.from({ length: avatarJanitorMaxEntities + 1 }, (_item, index) => bot(`bot_${index}`));
		const test = harness({ bots, objects: [{ key: 'worlds/w1/bots/bot_a/avatars/orphan.png', agedDays: 30 }] });

		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({
			status: 'skipped_over_budget',
			overrun: { kind: 'entities', counted: avatarJanitorMaxEntities + 1, limit: avatarJanitorMaxEntities },
		});
		// Nothing was read past the assertion, and nothing was deleted.
		expect(test.listCalls).toBe(0);
		expect(test.deleted).toEqual([]);
		// The marker moves: an unchanged fleet would only repeat this refusal daily.
		expect(markerOf(test.kvValues)).toBe(now);
	});

	it('refuses a run that wants to delete implausibly many objects', async () => {
		const objects = Array.from({ length: avatarJanitorMaxDeletesPerRun + 1 }, (_item, index) => ({
			key: `worlds/w1/bots/bot_a/avatars/orphan-${index}.png`,
			agedDays: 30,
		}));
		const test = harness({ objects });

		expect(await runAvatarJanitor(test.env, { now })).toMatchObject({
			status: 'aborted',
			failure: {
				kind: 'delete_volume',
				deletable: avatarJanitorMaxDeletesPerRun + 1,
				limit: avatarJanitorMaxDeletesPerRun,
			},
		});
		expect(test.deleted).toEqual([]);
		expect(markerOf(test.kvValues)).toBeUndefined();
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
