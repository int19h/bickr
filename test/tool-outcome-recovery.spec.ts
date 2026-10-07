import { BotRuntime, describe, expect, fakeBotDocument, it, providerResponseWithToolCalls, testToolExecutor, toolDefinitionsForProviderRound, withTestRunLiveness, withRuntimeSqliteForTest } from './helpers/index-harness';
import { ToolBatchOutcomeError, ToolOutcomeUnknownError, TickStoppedError } from '../workers/agent-runtime/src/errors';
import { botText } from '../workers/agent-runtime/src/localization';
import type { RuntimeBotDocument, ProviderLoopOutcome, ChatMessage, RunContext } from '../workers/agent-runtime/src/types';
import type { LocalizedProviderSettings } from '../workers/agent-runtime/src/provider-requests';

const text = botText('en');

function fixture(errors: readonly unknown[], state: DurableObjectState) {
	let round = 0;
	const executed: string[] = [];
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const runtime = withTestRunLiveness(Object.assign(Object.create(BotRuntime.prototype), {
		state,
		appendEvent: (runId: string, type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); return Reflect.get(BotRuntime.prototype, 'appendEvent').call(runtime, runId, type, payload); },
		appendProviderMessages: async () => {},
		finishToolBookkeeping: async () => {},
		callProvider: async () => {
			round += 1;
			return providerResponseWithToolCalls([
				{ id: `action-${round}`, name: 'vote', args: { votes: [{ commentId: `target-${round}`, value: 1 }], reason: 'A reason' } },
				{ id: `sibling-${round}`, name: 'read_thread', args: { threadId: 'thread' } },
			]);
		},
		ensureProviderPromptWithinBudget: async () => ({ allowedPromptTokens: 13_500, providerTools: toolDefinitionsForProviderRound(text), promptTokens: 100, requestMessages: [{ role: 'assistant', content: 'Ready' }] }),
		executeTool: testToolExecutor(async (_bot: unknown, runId: string, name: string, _args: unknown, context: RunContext) => {
			executed.push(name);
			if (name === 'vote') { runtime.markPendingToolDispatched(runId, context.toolCallId); throw errors[round - 1]; }
			return { name, result: { ok: true }, providerResult: { ok: true } };
		}),
		recordInferenceSubmission: () => {}, recordLoopMessageLog: () => {}, recordProviderUsage: () => {},
		providerLoopInitialSuccessfulToolCallCount: () => 0,
		throwIfStopped: () => {},
	}));
	const loop = (BotRuntime.prototype as unknown as { runProviderLoop(bot: RuntimeBotDocument, settings: LocalizedProviderSettings, runId: string, messages: ChatMessage[], context: RunContext): Promise<ProviderLoopOutcome> }).runProviderLoop.bind(runtime);
	const run = () => loop({  ...fakeBotDocument(), tickSettings: { ...fakeBotDocument().tickSettings, maxToolCallsPerTick: 4 } },
		{ text, baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', temperature: 0.2 } as LocalizedProviderSettings,
		'run-outcomes', [], { mode: 'normal', setupMode: 'new_iteration', signal: new AbortController().signal });
	return { run, executed, events, messages: () => state.storage.sql.exec<{ message_json: string }>('SELECT message_json FROM loop_messages ORDER BY seq').toArray().map((row) => JSON.parse(row.message_json) as ChatMessage) };
}

describe('unknown tool outcome visit recovery', () => {
	it('records unknown writes, does not dispatch siblings, and pauses after two unknown events', async () => {
		await withRuntimeSqliteForTest(async (state) => {
			const f = fixture([new ToolOutcomeUnknownError(new Error('lost first')), new ToolOutcomeUnknownError(new Error('lost second'))], state);
			await expect(f.run()).resolves.toMatchObject({ logOffCalled: true, unknownOutcomeCount: 2 });
			expect(f.executed).toEqual(['vote', 'vote', 'log_off']);
			const tools = f.messages().filter((message) => message.role === 'tool').map((message) => JSON.parse(String(message.content)));
			expect(tools.map((result) => result.kind).filter(Boolean)).toEqual(['outcome_unknown', 'not_attempted', 'outcome_unknown', 'not_attempted']);
			expect(f.events.some((event) => event.type === 'tick_failed')).toBe(false);
			expect(f.messages().some((message) => String(message.content).includes('I will pause this visit because Bickr did not confirm'))).toBe(true);
		});
	});
	it('propagates a stop behind a single dispatched unknown result', async () => {
		await withRuntimeSqliteForTest(async (state) => {
			const f = fixture([new ToolOutcomeUnknownError(new TickStoppedError())], state);
			await expect(f.run()).rejects.toBeInstanceOf(TickStoppedError);
			expect(f.executed).toEqual(['vote']);
			expect(f.messages().filter((message) => message.role === 'tool').map((message) => JSON.parse(String(message.content)).kind)).toEqual(['outcome_unknown', 'not_attempted']);
		});
	});
	it('propagates a stop behind a partial batch while retaining each target outcome', async () => {
		await withRuntimeSqliteForTest(async (state) => {
			const error = new ToolBatchOutcomeError([
				{ kind: 'unknown', target: 'c/target-1', error: new TickStoppedError(), scope: { related: true, unrelated: false } },
				{ kind: 'not_attempted', target: 'c/other' },
			], new ToolOutcomeUnknownError(new TickStoppedError()));
			const f = fixture([error], state);
			await expect(f.run()).rejects.toBeInstanceOf(TickStoppedError);
			const message = f.messages().find((message) => message.role === 'tool');
			expect(JSON.parse(String(message?.content))).toMatchObject({ kind: 'batch_outcome', items: [{ kind: 'unknown' }, { kind: 'not_attempted' }] });
		});
	});
});
