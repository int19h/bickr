import { enqueueBotNotificationFanout, runBotNotificationFanout } from '@bickr/shared/bot-notification-fanout';
import { kvKeys, writeJson, type D1DatabaseLike } from '@bickr/shared/storage';
import type { NotificationDocument } from '@bickr/shared/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearKv, resetD1Schema } from './helpers/d1-schema';
import { authCookie, createBotForTest, createForumForTest, createThreadForTest, createCommentForTest, seedWorld, testEnv } from './helpers/index-harness';
import { acknowledgeFollowerActivity, followerActivityAcknowledgement, followerActivityHighWater, followerActivityInsertStatement,
	followerActivityProbeSql, followerActivityEventsSql, followerActivityReceiptId, selectFollowerActivity, pruneFollowerActivity } from '@bickr/shared/follower-activity';
import { listOwnedBotPendingNotifications, markOwnedBotNotificationsRead, preparePendingNotificationDelivery } from '@bickr/shared/social';
import { notificationSourceDeleteStatements } from '@bickr/shared/notification-source-deletes';

const db: D1DatabaseLike = testEnv.BICKR_D1;
const kv = testEnv.BICKR_KV;
beforeEach(async () => { await resetD1Schema(testEnv.BICKR_D1); await clearKv(kv); });
async function fixtures() {
	const cookie = await authCookie(); await seedWorld(cookie);
	const forum = await createForumForTest(cookie, 'cursor-activity');
	const actor = await createBotForTest(cookie, 'cursor-author');
	const follower = await createBotForTest(cookie, 'cursor-reader', { enabled: false });
	const owner = (await db.prepare('SELECT owner_user_id AS id FROM bots_index WHERE bot_id=?').bind(follower.id).first<{ id: string }>())!.id;
	return { cookie, forum, actor, follower, owner };
}
async function follow(followerId: string, actorId: string) {
	await db.prepare(`INSERT INTO follows(world_id,follower_bot_id,followed_bot_id,created_at)
		SELECT home_world_id, bot_id, ?, created_at FROM bots_index WHERE bot_id=?`).bind(actorId, followerId).run();
}
async function position(follower: string, actor: string) {
	return (await db.prepare('SELECT activity_delivered_sequence AS position FROM follows WHERE follower_bot_id=? AND followed_bot_id=?')
		.bind(follower, actor).first<{ position: number }>())?.position;
}
async function count(table: 'notifications' | 'follower_activity_events', predicate = '1=1') {
	return (await db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${predicate}`).first<{ count: number }>())!.count;
}

describe('shared follower activity publication and delivery', () => {
	it('stores each action once with no recipient rows or payload copies', async () => {
		const { cookie, forum, actor, follower } = await fixtures();
		const second = await createBotForTest(cookie, 'cursor-second-reader');
		await follow(follower.id, actor.id); await follow(second.id, actor.id);
		const thread = await createThreadForTest(forum.id, actor.id, 'Shared once', 'Full body is not copied to the stream.');
		await createCommentForTest(thread.id, actor.id, 'A comment');
		expect(await count('follower_activity_events')).toBe(2);
		expect(await count('notifications', "type='followed_activity'")).toBe(0);
		const columns = (await db.prepare('SELECT * FROM follower_activity_events ORDER BY sequence').all()).results;
		expect(JSON.stringify(columns)).not.toContain('Full body is not copied');
		const first = await selectFollowerActivity(db, follower.id);
		const other = await selectFollowerActivity(db, second.id);
		expect(first.notices).toHaveLength(1); expect(other.notices).toHaveLength(1);
		expect(first.notices[0]!.document.event).toMatchObject({ kind: 'follower_activity_digest', olderActivityOmitted: false,
			activities: [{ kind: 'comment', comment: { id: expect.any(String) } }, { kind: 'thread', thread: { id: thread.id } }] });
		expect(await position(follower.id, actor.id)).toBe(0);
		await acknowledgeFollowerActivity(db, [first.notices[0]!.receipt]);
		expect((await selectFollowerActivity(db, follower.id)).notices).toHaveLength(0);
		expect((await selectFollowerActivity(db, second.id)).notices).toHaveLength(1);
		expect((await kv.list({ prefix: `v1:notification:${follower.id}:` })).keys).toHaveLength(0);
	});

	it('captures only committed sequences, keeps later posts pending, and makes old refollow receipts harmless', async () => {
		const { forum, actor, follower } = await fixtures(); await follow(follower.id, actor.id);
		await createThreadForTest(forum.id, actor.id, 'Before capture', 'one');
		const captured = (await selectFollowerActivity(db, follower.id)).notices[0]!.receipt;
		await createThreadForTest(forum.id, actor.id, 'After capture', 'two');
		await acknowledgeFollowerActivity(db, [captured]);
		expect((await selectFollowerActivity(db, follower.id)).notices[0]!.receipt.throughSequence).toBeGreaterThan(captured.throughSequence);
		await db.prepare('DELETE FROM follows WHERE follower_bot_id=? AND followed_bot_id=?').bind(follower.id, actor.id).run();
		await follow(follower.id, actor.id);
		const baseline = await position(follower.id, actor.id);
		await acknowledgeFollowerActivity(db, [captured]);
		expect(await position(follower.id, actor.id)).toBe(baseline);
		expect((await selectFollowerActivity(db, follower.id)).notices).toHaveLength(0);
		await createThreadForTest(forum.id, actor.id, 'After refollow', 'three');
		expect((await selectFollowerActivity(db, follower.id)).notices).toHaveLength(1);
	});

	it('keeps the high-water after expiry and rejects future endpoints even in the write statement', async () => {
		const { forum, actor, follower } = await fixtures(); await follow(follower.id, actor.id);
		await createThreadForTest(forum.id, actor.id, 'Published counter', 'one');
		const receipt = (await selectFollowerActivity(db, follower.id)).notices[0]!.receipt;
		const high = await followerActivityHighWater(db);
		await db.prepare('DELETE FROM follower_activity_events').run();
		expect(await followerActivityHighWater(db)).toBe(high);
		await db.prepare('DELETE FROM follows WHERE follower_bot_id=? AND followed_bot_id=?').bind(follower.id, actor.id).run();
		await follow(follower.id, actor.id); expect(await position(follower.id, actor.id)).toBe(high);
		const forged = { ...receipt, throughSequence: high + 10000 };
		expect((await followerActivityAcknowledgement(db, forged).run()).meta?.changes).toBe(0);
		await createThreadForTest(forum.id, actor.id, 'After empty stream', 'two');
		expect((await selectFollowerActivity(db, follower.id)).notices[0]!.receipt.throughSequence).toBeGreaterThan(high);
	});

	it('reports omitted older activity even when the newest raw event is a direct duplicate', async () => {
		const { forum, actor, follower } = await fixtures(); await follow(follower.id, actor.id);
		for (let index = 0; index < 7; index++) await createThreadForTest(forum.id, actor.id, `Burst ${index}`, 'body');
		await db.prepare(`UPDATE follower_activity_events SET direct_recipient_ids_json=? WHERE sequence=(SELECT MAX(sequence) FROM follower_activity_events)`)
			.bind(JSON.stringify([follower.id])).run();
		const selected = await selectFollowerActivity(db, follower.id);
		expect(selected.notices[0]!.document.event).toMatchObject({ kind: 'follower_activity_digest', olderActivityOmitted: true, activities: expect.any(Array) });
		const event = selected.notices[0]!.document.event;
		if (event?.kind !== 'follower_activity_digest') throw new Error('Expected typed digest.');
		expect(event.activities).toHaveLength(4);
		await acknowledgeFollowerActivity(db, [selected.notices[0]!.receipt]);
		expect((await selectFollowerActivity(db, follower.id)).notices).toHaveLength(0);
	});

	it('suppresses direct recipients before direct jobs finish, without consuming on reads', async () => {
		const { forum, actor, follower } = await fixtures(); await follow(follower.id, actor.id);
		const thread = await createThreadForTest(forum.id, follower.id, 'Reply target', 'root');
		await createCommentForTest(thread.id, actor.id, 'A direct reply', thread.rootCommentId);
		const row = (await db.prepare("SELECT notification_id AS id FROM notifications WHERE type='reply' AND bot_id=?").bind(follower.id).first<{id:string}>())!;
		const notification = (await kv.get<NotificationDocument>(kvKeys.notification(follower.id,row.id),'json'))!;
		if (notification.event?.kind !== 'reply') throw new Error('Expected a typed direct reply.');
		const deferred: D1DatabaseLike = { writesDeferred:true,prepare:db.prepare.bind(db),batch:db.batch.bind(db) };
		await enqueueBotNotificationFanout(kv,deferred,{id:'delayed-direct',actorBotId:actor.id,worldId:actor.homeWorldId,createdAt:new Date().toISOString(),
			templates:[{notificationType:'reply',sourceObjectId:notification.sourceObjectId,message:notification.message,payload:notification.event}],
			direct:[{botId:follower.id,template:0,reasons:['direct_reply']}]});
		await db.prepare('DELETE FROM notifications WHERE notification_id=?').bind(row.id).run();
		const selected = await selectFollowerActivity(db, follower.id);
		expect(selected.notices).toHaveLength(0); expect(selected.silentReceipts).toHaveLength(1);
		expect(await position(follower.id, actor.id)).toBeLessThan(selected.silentReceipts[0]!.throughSequence);
		expect(await count('notifications', `type='reply' AND bot_id='${follower.id}'`)).toBe(0); // staged direct job is durable, not yet published
		expect(await db.prepare('SELECT event_id FROM bot_notification_fanouts LIMIT 1').first()).not.toBeNull();
		await runBotNotificationFanout(kv,db,new Date(Date.now()+60_000).toISOString());
		expect(await count('notifications', `type='reply' AND bot_id='${follower.id}'`)).toBe(1);
	});

	it('keeps temporarily inactive relationships pending and retracts deleted sources', async () => {
		const { forum, actor, follower } = await fixtures(); await follow(follower.id, actor.id);
		const thread = await createThreadForTest(forum.id, actor.id, 'Source lifecycle', 'body');
		await db.prepare("UPDATE bots_index SET lifecycle_state='deleting' WHERE bot_id=?").bind(actor.id).run();
		const inactive = await selectFollowerActivity(db, follower.id);
		expect(inactive.notices).toHaveLength(0); expect(inactive.silentReceipts).toHaveLength(0);
		expect(await position(follower.id, actor.id)).toBe(0);
		await db.prepare("UPDATE bots_index SET lifecycle_state='active' WHERE bot_id=?").bind(actor.id).run();
		await db.batch(notificationSourceDeleteStatements(db, [{ type: 'thread', id: thread.id }]));
		expect(await count('follower_activity_events')).toBe(0);
	});

	it.each(['missing-event-world', 'missing-source-world', 'deleted-world', 'inactive-world'])(
		'suppresses permanent world loss but defers temporary inactivity: %s', async state => {
			const { forum, actor, follower } = await fixtures(); await follow(follower.id, actor.id);
			const thread = await createThreadForTest(forum.id, actor.id, 'World lifecycle', 'body');
			if (state === 'missing-event-world') await db.prepare("UPDATE follower_activity_events SET world_id='missing-world'").run();
			else if (state === 'missing-source-world') await db.prepare("UPDATE threads_index SET world_id='missing-world' WHERE thread_id=?").bind(thread.id).run();
			else if (state === 'deleted-world') await db.prepare('UPDATE worlds_index SET deleted_at=? WHERE world_id=?').bind(new Date().toISOString(),actor.homeWorldId).run();
			else await db.prepare("UPDATE worlds_index SET lifecycle_state='deleting' WHERE world_id=?").bind(actor.homeWorldId).run();
			const result = await selectFollowerActivity(db,follower.id);
			expect(result.notices).toHaveLength(0);
			expect(result.silentReceipts).toHaveLength(state === 'inactive-world' ? 0 : 1);
			if (result.silentReceipts.length) {
				await acknowledgeFollowerActivity(db,result.silentReceipts);
				expect(await position(follower.id,actor.id)).toBeGreaterThan(0);
			}
		});

	it('publishes stream and direct work transactionally and deduplicates source identity', async () => {
		const { actor } = await fixtures();
		const input = { actorBotId: actor.id, worldId: actor.homeWorldId, source: { type: 'thread' as const, id: 'rollback' }, createdAt: new Date().toISOString(), directRecipientIds: [] };
		await expect(db.batch([followerActivityInsertStatement(db, input), db.prepare("INSERT INTO follower_activity_events(source_ref,actor_bot_id,world_id,created_at,direct_recipient_ids_json) VALUES(NULL,'x','x','x','[]')")])).rejects.toThrow();
		expect(await count('follower_activity_events')).toBe(0);
		await followerActivityInsertStatement(db, input).run(); await followerActivityInsertStatement(db, input).run();
		expect(await count('follower_activity_events')).toBe(1);
	});

	it('rotates beyond a full quiet raw page and uses the bounded indexes', async () => {
		const { forum, actor, follower } = await fixtures(); await follow(follower.id, actor.id);
		await createThreadForTest(forum.id, actor.id, 'Beyond quiet prefix', 'body');
		for (let offset = 0; offset < 510; offset += 50) await db.batch(Array.from({ length: Math.min(50,510-offset) }, (_, i) => db.prepare(`INSERT INTO follows(world_id,follower_bot_id,followed_bot_id,created_at) VALUES (?,?,?,?)`)
			.bind(actor.homeWorldId, follower.id, `aaa-${String(offset+i).padStart(4,'0')}`, new Date().toISOString())));
		const first = await selectFollowerActivity(db, follower.id);
		expect(first.notices).toHaveLength(0); expect(first.nextAfter).toBe('aaa-0499');
		const next = await selectFollowerActivity(db, follower.id, { after: first.nextAfter });
		expect(next.notices).toHaveLength(1);
		const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${followerActivityProbeSql}`).bind(follower.id,'',500).all<{ detail: string }>()).results?.map(r=>r.detail).join(' ') ?? '';
		expect(plan).toContain('MATERIALIZE raw'); expect(plan).toContain('follower_activity_actor_sequence');
		const eventsPlan = (await db.prepare(`EXPLAIN QUERY PLAN ${followerActivityEventsSql}`).bind(JSON.stringify([{ followedBotId: actor.id,cursor:0,head:100 }]),follower.id).all<{ detail: string }>()).results?.map(r=>r.detail).join(' ') ?? '';
		expect(eventsPlan).toContain('follower_activity_actor_sequence');
	});

	it('lists without consuming, dismisses only the captured range, and rejects mixed foreign or future IDs atomically', async () => {
		const { cookie, forum, actor, follower, owner } = await fixtures(); await follow(follower.id, actor.id);
		await createThreadForTest(forum.id, actor.id, 'Owner snapshot', 'body');
		const page = await listOwnedBotPendingNotifications(kv,db,{ ownerUserId: owner,botId:follower.id });
		expect(page.notifications[0]!.kind).toBe('follower_activity'); expect(await position(follower.id,actor.id)).toBe(0);
		const before = (await selectFollowerActivity(db,follower.id)).notices[0]!.receipt;
		const other = await createBotForTest(cookie,'cursor-other-reader'); await follow(other.id,actor.id);
		await createThreadForTest(forum.id,actor.id,'Later owner activity','body');
		const foreign = (await selectFollowerActivity(db,other.id)).notices[0]!.document.id;
		const rejected = await markOwnedBotNotificationsRead(kv,db,{ownerUserId:owner,botId:follower.id,notificationIds:[page.notifications[0]!.id,foreign]});
		expect(rejected.kind).toBe('rejected'); expect(await position(follower.id,actor.id)).toBe(0);
		const future = followerActivityReceiptId({ ...before, throughSequence:999999 });
		expect((await markOwnedBotNotificationsRead(kv,db,{ownerUserId:owner,botId:follower.id,notificationIds:[page.notifications[0]!.id,future]})).kind).toBe('rejected');
		expect(await position(follower.id,actor.id)).toBe(0);
		const marked = await markOwnedBotNotificationsRead(kv,db,{ownerUserId:owner,botId:follower.id,notificationIds:[page.notifications[0]!.id]});
		expect(marked).toMatchObject({kind:'marked',result:{markedReadCount:1}});
		expect((await selectFollowerActivity(db,follower.id)).notices).toHaveLength(1);
		expect(await markOwnedBotNotificationsRead(kv,db,{ownerUserId:owner,botId:follower.id,notificationIds:[page.notifications[0]!.id]})).toMatchObject({kind:'marked',result:{markedReadCount:0,notPendingCount:1}});
	});

	it('pages stored notices before shared summaries and dismisses mixed storage atomically', async () => {
		const { forum,actor,follower,owner } = await fixtures(); await follow(follower.id,actor.id);
		const thread = await createThreadForTest(forum.id,follower.id,'Mixed target','root');
		await createCommentForTest(thread.id,actor.id,'Reply',thread.rootCommentId);
		await createThreadForTest(forum.id,actor.id,'Independent follower activity','body');
		const first = await listOwnedBotPendingNotifications(kv,db,{ownerUserId:owner,botId:follower.id,limit:1});
		expect(first.notifications[0]!.kind).toBe('stored'); expect(first.nextCursor).toBeDefined();
		const second = await listOwnedBotPendingNotifications(kv,db,{ownerUserId:owner,botId:follower.id,limit:1,cursor:first.nextCursor});
		expect(second.notifications[0]!.kind).toBe('follower_activity');
		const prepared = await preparePendingNotificationDelivery(kv,db,follower.id,'');
		expect(prepared.candidates.map(candidate=>candidate.kind)).toEqual(['stored','follower_activity']);
		const result = await markOwnedBotNotificationsRead(kv,db,{ownerUserId:owner,botId:follower.id,notificationIds:[first.notifications[0]!.id,second.notifications[0]!.id]});
		expect(result).toMatchObject({kind:'marked',result:{markedReadCount:2,notPendingCount:0}});
		expect((await preparePendingNotificationDelivery(kv,db,follower.id,'')).candidates).toHaveLength(0);
	});

	it('keeps direct delivery priority and ranks digests before legacy and unknown stored types', async () => {
		const { forum,actor,follower } = await fixtures(); await follow(follower.id,actor.id);
		await createThreadForTest(forum.id,actor.id,'Current shared activity','body');
		const types = ['follow','vote','followed_activity',...Array.from({length:22},()=> 'future_kind')];
		for (const [index,type] of types.entries()) {
			const id = `rank-${index}`;
			const createdAt = new Date(Date.now() + index * 1000).toISOString();
			await db.prepare("INSERT INTO notifications(notification_id,world_id,bot_id,type,status,message,created_at) VALUES(?,?,?,?,'pending','Notice',?)")
				.bind(id,actor.homeWorldId,follower.id,type,createdAt).run();
			await writeJson(kv,kvKeys.notification(follower.id,id),{id,type:'notification',schemaVersion:2,revision:1,
				botId:follower.id,worldId:actor.homeWorldId,notificationType:type,status:'pending',message:{text:'Notice',lang:null},createdAt,updatedAt:createdAt});
		}
		const result = await preparePendingNotificationDelivery(kv,db,follower.id,'');
		expect(result.candidates).toHaveLength(20);
		expect(result.candidates.slice(0,4).map(item=>item.document.notificationType)).toEqual(['follow','vote','followed_activity','followed_activity']);
		expect(result.candidates[2]!.kind).toBe('follower_activity');
		expect(result.candidates[3]!.kind).toBe('stored');
	});

	it('prunes expired events without resetting the stream counter', async () => {
		const { forum,actor,follower } = await fixtures(); await follow(follower.id,actor.id);
		await createThreadForTest(forum.id,actor.id,'Expiry','body'); const high = await followerActivityHighWater(db);
		await db.prepare("UPDATE follower_activity_events SET created_at='2020-01-01T00:00:00.000Z'").run();
		expect(await pruneFollowerActivity(kv,db,new Date().toISOString())).toMatchObject({expired:1});
		expect(await followerActivityHighWater(db)).toBe(high);
	});
	it('reports only actual orphan deletes when canonical deletion wins the race', async () => {
		const {forum,actor} = await fixtures();const thread=await createThreadForTest(forum.id,actor.id,'Delete race','body');
		await db.prepare('UPDATE threads_index SET deleted_at=? WHERE thread_id=?').bind(new Date().toISOString(),thread.id).run();
		const racing: D1DatabaseLike={prepare:db.prepare.bind(db),batch:async statements=>{
			await db.prepare('DELETE FROM follower_activity_events').run();
			return db.batch(statements);
		}};
		expect(await pruneFollowerActivity(kv,racing,new Date().toISOString())).toMatchObject({orphaned:0});
	});

});
