import { BotRuntime } from '../../../../../workers/agent-runtime/src/runtime/bot-runtime';
import { AgentLogStore } from '../../../../../workers/agent-runtime/src/runtime/agent-log-store';
import { RuntimeMessageStore } from '../../../../../workers/agent-runtime/src/runtime/message-store';
import { createRuntimeTestStorage } from '../../../../../workers/agent-runtime/src/runtime/sqlite-test-helper';
import { testResultContext } from '../../../../../workers/agent-runtime/src/runtime/result-render-context.test-support';
import { ProviderResponseInterruptedError } from '../../../../../workers/agent-runtime/src/errors';
// Card inputs come from the runtime consumer, broadcaster, SQLite store, and history publisher.
export async function reasoningRuntimeOutput(completed, scenario = 'mixed') {
    const storage = createRuntimeTestStorage();
    try {
        const store = new AgentLogStore(storage);
        store.initialize();
        const messages = new RuntimeMessageStore(storage);
        const requestId = store.begin({ runId: 'typed-run', eventSeq: 1, purpose: 'loop' });
        const attempt = store.startAttempt(requestId, '{}');
        const events = [], snapshots = [];
        const runtime = Object.assign(Object.create(BotRuntime.prototype), {
            state: { storage }, agentLogs: store, ephemeralStreamSeq: 0,
            liveness: { stream() { } }, throwIfStopped() { }, clearPendingTool() { },
            runtimeMessageStore: () => messages,
            broadcastControl: (payload) => {
                events.push(payload.event);
                snapshots.push(store.entries([], null));
            },
        });
        const deltas = scenario === 'plain-opaque' ? [
            { reasoning: 'Readable plain thought.' },
            { reasoning_details: [{ type: 'reasoning.encrypted', data: 'PRIVATE_ENCRYPTED_BYTES' }] },
            { content: 'A public reply.' },
        ] : scenario === 'interleaved' ? [
            { reasoning_details: [{ type: 'reasoning.summary', index: 0, summary: 'First.' }] },
            { reasoning_details: [{ type: 'reasoning.text', index: 1, text: 'Second.' }] },
            { reasoning_details: [{ type: 'reasoning.summary', index: 0, summary: 'Third.' }] },
            { content: 'A public reply.' },
        ] : [
            { reasoning: 'Readable thought.', reasoning_details: [{ type: 'reasoning.text', index: 0, id: 'thought', text: 'Readable thought.' }] },
            { reasoning: 'Look', reasoning_details: [{ type: 'reasoning.summary', id: 'summary', summary: 'Look' }] },
            { reasoning: 'ing at the result.', reasoning_details: [{ type: 'reasoning.summary', id: 'summary', text: 'ing at the result.' }] },
            { reasoning_details: [{ type: 'reasoning.encrypted', index: 2, data: 'PRIVATE_ENCRYPTED_BYTES' }] },
            { reasoning_details: [{ type: 'future.type', id: 'unknown', text: 'PRIVATE_FUTURE_TEXT' }] },
            { content: 'A public reply.' },
        ];
        const frames = deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join('');
        const stream = new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode(frames + (completed ? 'data: [DONE]\n\n' : '')));
                controller.close();
            } });
        let response;
        try {
            response = await runtime.consumeProviderResponse('typed-run', 1, stream, new AbortController().signal);
        }
        catch (error) {
            if (completed || !(error instanceof ProviderResponseInterruptedError))
                throw error;
            response = error.response;
        }
        const raw = JSON.stringify({ message: { role: 'assistant', content: response.content, reasoning: response.reasoning, reasoning_details: response.reasoningDetails } });
        store.settle(attempt, { kind: completed ? 'success' : 'interrupted', response: raw });
        const settled = store.entries([], null);
        store.stageResponsePublication({ kind: 'provider_response', runId: 'typed-run', requestId, eventSeq: 1, attemptId: attempt, assistantSeq: null, pendingCallIds: [] });
        runtime.settleResponsePublication(testResultContext, 'typed-run', null);
        const rows = messages.loopMessagesAfter(testResultContext, 0);
        return { events, snapshots, settled, history: store.entries(rows, null), requestId };
    }
    finally {
        storage.database.close();
    }
}
