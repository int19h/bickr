import { facetFingerprint } from '../workers/agent-runtime/src/runtime/result-context-scope';
import { resultViewBuildRenderContext } from '../workers/agent-runtime/src/runtime/tool-result-views';
import { testViewRenderContext } from '../workers/agent-runtime/src/runtime/result-render-context.test-support';
import { RuntimeMessageStore } from '../workers/agent-runtime/src/runtime/message-store';
import { attachToolResultView } from '../workers/agent-runtime/src/runtime/result-messages';
import { authCookie, seedWorld, createBotForTest, botById, testEnv, BotRuntime, describe, expect, it, withRuntimeSqliteForTest } from './helpers/index-harness';
import { updateBot } from './helpers/coordinator-mutations';
import { botText } from '../workers/agent-runtime/src/localization';
import { buildResultRenderContext } from '../workers/agent-runtime/src/runtime/result-render-context';
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
			return renderToolResultView(view, await buildResultRenderContext(testEnv.BICKR_D1, current, [view]));
		};
		expect(await render()).not.toContain('2026-10-22T17:00-07:00');
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, document.ownerUserId, { timeSettings: { mode: 'absolute', timezone: 'America/Los_Angeles' } });
		expect(await render()).toContain('2026-10-22T17:00-07:00');
	});

	it('builds repeated provider requests when a stored reference has no index row', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const created = await createBotForTest(cookie, 'gone-ref-reader');
		const document = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id);
		const text = botText('en');
		const bot = { ...document, text };
		await withRuntimeSqliteForTest(async state => {
			const ref = { kind: 'forum' as const, entityId: 'frm_removed_index_row', handle: 'saved-forum' };
			const view: ToolResultView = { ...resultViewBase(text), kind: 'list_accessible_forums', forums: [{ ref, description: 0, readOnly: false }], facets: [
				{ entityId: ref.entityId, facet: 'forum_description', state: 'shown', fingerprint: await facetFingerprint('An old forum'), value: 'An old forum' },
			] };
			const initial = resultViewBuildRenderContext(view, { text, time: { settings: { mode: 'relative', timezone: 'UTC' }, createdAt: bot.createdAt } });
			const store = new RuntimeMessageStore(state.storage);
			store.appendLoopMessageGroup(initial, [
				{ runId: 'before-delete', origin: 'provider_response', message: { role: 'assistant', tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'list_accessible_forums', arguments: '{}' } }] } },
				{ runId: 'before-delete', origin: 'tool_result', message: attachToolResultView({ role: 'tool', tool_call_id: 'old-call', content: '' }, view) },
			]);
			const runtime = Object.assign(Object.create(BotRuntime.prototype), { state, env: testEnv, renewProgressLease: async () => {}, appendEvent: () => ({ seq: 1 }) });
			const settings = { text, baseUrl: 'https://provider.test/v1', model: 'test/model', temperature: 0.2, toolCalls: 'at_will' };
			const first = await runtime.ensureProviderPromptWithinBudget(bot, settings, 'first-request', new AbortController().signal, []);
			const second = await runtime.ensureProviderPromptWithinBudget(bot, settings, 'second-request', new AbortController().signal, []);
			const content = first.requestMessages.find((message: { role: string }) => message.role === 'tool')?.content;
			expect(content).toContain(`| f/saved-forum ${text.format('result.reference.deleted')} | An old forum |`);
			expect(second.requestMessages).toEqual(first.requestMessages);
			expect(first.promptTokens).toBeLessThan(first.allowedPromptTokens);
		});
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
			const written = store.appendLoopMessage(testViewRenderContext(view, text), 'run', attachToolResultView({ role: 'tool', tool_call_id: 'owner', content: '' }, view), 'tool_result');
			const rows = [store.loopMessageRow(written.seq)!];
			const runtime = Object.assign(Object.create(BotRuntime.prototype), { env: testEnv });
			const first = await runtime.resultRenderContextForRows(created.id, rows);
			const providerMessages = renderToolResultView(view, first);
			await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, document.ownerUserId, { handle: 'owner-renamed' });
			const second = await runtime.resultRenderContextForRows(created.id, rows);
			expect(renderToolResultView(view, first)).toContain('- u/owner-reader');
			expect(renderToolResultView(view, second)).toContain('- u/owner-renamed');
			expect(renderToolResultView(view, first)).toBe(providerMessages);
		});
	});

});
