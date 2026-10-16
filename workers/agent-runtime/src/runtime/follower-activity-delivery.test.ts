import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowerActivityReceipt, FollowerActivitySelection } from '@bickr/shared/follower-activity';
import type { D1DatabaseLike, D1PreparedStatementLike } from '@bickr/shared/storage';
import { BotRuntime } from './bot-runtime';
import { RuntimeFollowerActivityDelivery } from './follower-activity-delivery';
import { RuntimeMessageStore } from './message-store';
import { RuntimeInputHistory } from './input-history';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
let storage: RuntimeTestStorage;
beforeEach(() => { storage = createRuntimeTestStorage(); });
afterEach(() => storage.database.close());
const receipt: FollowerActivityReceipt = { kind:'follower_activity', version:1, followerBotId:'reader', followedBotId:'writer', fromSequence:0, throughSequence:7 };
function selection(receipts: FollowerActivityReceipt[] = [receipt]): FollowerActivitySelection {
	return { notices:[],silentReceipts:receipts,nextAfter:'writer',hasMore:true };
}
function db(batch: D1DatabaseLike['batch']): D1DatabaseLike {
	const statement: D1PreparedStatementLike = { bind: () => statement, first: async () => null, all: async () => ({success:true,results:[]}), run: async () => ({success:true}) };
	return { prepare: () => statement, batch };
}
function commit(delivery: RuntimeFollowerActivityDelivery, input = selection(), fail = false) {
	new RuntimeMessageStore(storage).appendLoopMessageGroup([{ runId:'run',origin:'input',message:{role:'user',content:'Saved activity summary'} }], () => {
		new RuntimeInputHistory(storage).commit(9);
		delivery.commit(input,[],new Set());
		if (fail) throw new Error('Injected history commit failure');
	});
}

describe('durable follower receipt recovery', () => {
	it('rolls input, receipt, and scan position back together on a failed history commit', () => {
		const delivery = new RuntimeFollowerActivityDelivery(storage);
		expect(() => commit(delivery,selection(),true)).toThrow('Injected history commit failure');
		expect(delivery.hasPending()).toBe(false); expect(delivery.after()).toBe('');
		expect(new RuntimeInputHistory(storage).startedAfter(0)).toBe(false);
		expect(storage.sql.exec('SELECT seq FROM loop_messages').toArray()).toHaveLength(0);
	});
	it('retains failed acknowledgements and settles a zero-row retry without losing scan progress', async () => {
		const delivery = new RuntimeFollowerActivityDelivery(storage); commit(delivery);
		expect(delivery.after()).toBe('writer'); expect(delivery.hasPending()).toBe(true);
		await expect(delivery.acknowledge(db(async () => { throw new Error('Injected D1 outage'); }))).rejects.toThrow();
		expect(delivery.hasPending()).toBe(true);
		expect(() => commit(delivery,selection([]))).toThrow();
		await delivery.acknowledge(db(async () => [{success:true,meta:{changes:0}}]));
		expect(delivery.hasPending()).toBe(false); expect(delivery.after()).toBe('writer');
	});
	it('advances a quiet or fully omitted page without a journal or D1 call', async () => {
		const delivery = new RuntimeFollowerActivityDelivery(storage); commit(delivery,selection([]));
		expect(delivery.hasPending()).toBe(false); expect(delivery.after()).toBe('writer');
		let calls = 0; await delivery.acknowledge(db(async () => {calls++;return [];})); expect(calls).toBe(0);
	});
	it('journals only digest IDs present in saved input, while omitted digests still rotate', () => {
		const delivery = new RuntimeFollowerActivityDelivery(storage);
		const notice = { kind:'follower_activity' as const,receipt,document:{
			id:'digest',type:'notification' as const,schemaVersion:2,revision:1,botId:'reader',worldId:'world',
			createdAt:'2026-10-16',updatedAt:'2026-10-16',status:'pending' as const,notificationType:'followed_activity' as const,message:{text:'Summary',lang:null},
			event:{kind:'follower_activity_digest' as const,type:'followed_activity' as const,id:'digest',createdAt:'2026-10-16',
				deliveryReasons:['followed_profile_activity' as const],actor:{id:'writer',username:'u/writer',displayName:{text:'Writer',lang:null}},activities:[],olderActivityOmitted:true},
		} };
		new RuntimeMessageStore(storage).appendLoopMessageGroup([{runId:'omitted',origin:'input',message:{role:'user',content:'Only other notices fit'}}],()=>{
			delivery.commit(selection([]),[notice],new Set());
		});
		expect(delivery.hasPending()).toBe(false);expect(delivery.after()).toBe('writer');
		new RuntimeMessageStore(storage).appendLoopMessageGroup([{runId:'included',origin:'input',message:{role:'user',content:'The digest fits'}}],()=>{
			delivery.commit(selection([]),[notice],new Set(['digest']));
		});
		expect(delivery.hasPending()).toBe(true);
	});

	it('refuses history erase and preserves input when pending acknowledgement fails', async () => {
		const delivery = new RuntimeFollowerActivityDelivery(storage); commit(delivery);
		const erase = vi.fn();
		const finish = vi.fn();
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			state: { storage }, env: { BICKR_D1: db(async () => { throw new Error('Injected D1 outage'); }) },
			beginMaintenanceOperation: vi.fn(async () => {}), finishMaintenanceOperation: finish,
			clearInferenceSubmissions: erase,
		});
		await expect(runtime.clearHistory('reader')).rejects.toThrow('Injected D1 outage');
		expect(erase).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledWith('clear_history');
		expect(delivery.hasPending()).toBe(true);
		expect(storage.sql.exec('SELECT seq FROM loop_messages').toArray()).toHaveLength(1);
	});

	it('does not delete a newer journal after an old acknowledgement crosses an await', async () => {
		const delivery = new RuntimeFollowerActivityDelivery(storage); commit(delivery);
		await delivery.acknowledge(db(async () => {
			storage.sql.exec("UPDATE runtime_state SET value_json=? WHERE key='follower_activity_receipts_v1'",JSON.stringify([{...receipt,throughSequence:8}]));
			return [{success:true}];
		}));
		expect(delivery.hasPending()).toBe(true);
	});
});
