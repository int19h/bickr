import { RuntimeMessageStore } from '../workers/agent-runtime/src/runtime/message-store';
import { attachToolResultView } from '../workers/agent-runtime/src/runtime/result-messages';
import { authCookie, seedWorld, createBotForTest, botById, testEnv, BotRuntime, describe, expect, it, withRuntimeSqliteForTest } from './helpers/index-harness';
import { updateBot } from './helpers/coordinator-mutations';
import { botText } from '../workers/agent-runtime/src/localization';
import { participantTimeSettingsOf } from '@bickr/shared/participant-time-migration';
import { renderToolResultView, resultViewBase, type ToolResultView } from '../workers/agent-runtime/src/runtime/tool-result-views';

describe('current time configuration for stored results', () => {
	it('uses an owner change before the next provider request in the same visit', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const created = await createBotForTest(cookie, 'time-reader');
		const document = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id);
		const text = botText('en');
		const bot = { ...document, text, instructionLocale: 'en' as const };
		const runtime = Object.assign(Object.create(BotRuntime.prototype), { env: testEnv });
		const ref = { kind: 'participant' as const, entityId: created.id, handle: created.handle };
		const view: ToolResultView = { ...resultViewBase(text), kind: 'view_activity', profile: ref, activities: [{ kind: 'follow', profile: ref, when: { instant: '2026-10-23T00:00:00Z', writtenAt: '2026-10-23T10:00:00Z' } }] };
		const render = async () => {
			const current = await runtime.botWithCurrentRuntimeBudget(bot);
			return renderToolResultView(view, text, new Map(), { settings: participantTimeSettingsOf(current), createdAt: current.createdAt });
		};
		expect(await render()).not.toContain('2026-10-22T17:00-07:00');
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, document.ownerUserId, { timeSettings: { mode: 'absolute', timezone: 'America/Los_Angeles' } });
		expect(await render()).toContain('2026-10-22T17:00-07:00');
	});
	it('keeps owner history renders separate from provider render data', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const created = await createBotForTest(cookie, 'owner-reader');
		const document = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id);
		await withRuntimeSqliteForTest(async state => {
			const store = new RuntimeMessageStore(state.storage);
			const text = botText('en');
			const ref = { kind: 'participant' as const, entityId: created.id, handle: created.handle };
			const view: ToolResultView = { ...resultViewBase(text), kind: 'read_note', id: 'one', content: 'Authored text', links: [{ ref, deleted: false }] };
			const written = store.appendLoopMessage('run', attachToolResultView({ role: 'tool', tool_call_id: 'owner', content: '' }, view), 'tool_result');
			const rows = [store.loopMessageRow(written.seq)!];
			const providerHandles = new Map();
			const providerTime = { settings: { mode: 'relative', timezone: 'UTC' }, createdAt: document.createdAt };
			const runtime = Object.assign(Object.create(BotRuntime.prototype), { env: testEnv, resultViewHandles: providerHandles, resultViewTime: providerTime });
			const first = await runtime.ownerResultRenderer(created.id, rows);
			await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, document.ownerUserId, { handle: 'owner-renamed' });
			const second = await runtime.ownerResultRenderer(created.id, rows);
			expect(JSON.parse(first(view)).links[0].handle).toBe('owner-reader');
			expect(JSON.parse(second(view)).links[0].handle).toBe('owner-renamed');
			expect(runtime.resultViewHandles).toBe(providerHandles);
			expect(runtime.resultViewTime).toBe(providerTime);
		});
	});

});
