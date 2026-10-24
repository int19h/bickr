import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryError } from '@bickr/shared/repository';
import { InputError } from '@bickr/shared/validation';
import type { AgentLogFailure } from '@bickr/shared/model';
import {
	CompactionReasoningRefusalError, PersistentCompactionReductionFailureError,
	PromptContextBudgetExceededError, PromptContextCompactionLimitError,
	ProviderCompactionOutputLimitError, ProviderCompactionRequestError, ProviderEmptyResponseError,
	ProviderLoopRequestError, ProviderRequestError, ProviderRequestTimeoutError,
	ProviderResponseBodyTimeoutError, ProviderResponseInterruptedError, ProviderStreamIdleTimeoutError,
	ProviderStreamIncompleteError, ProviderStructuredOutputValidationError, ResponseBodySizeLimitError,
	RuntimeOperationTimeoutError, TickStoppedError, type CompactionReasoningDiagnostic,
} from '../errors';
import { botText } from '../localization';
import { AgentLogStore, agentLogFailure } from './agent-log-store';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { testResultContext } from './result-render-context.test-support';

const diagnostic: CompactionReasoningDiagnostic = {
	decision: { kind: 'baseline', selection: { kind: 'model_default' } },
	selection: { kind: 'model_default' },
	provenance: {
		configuration: null, modelDefault: { kind: 'absent' }, safetyFloor: { kind: 'model_default' },
		learnedFloor: null, baselineSelection: { kind: 'model_default' }, support: 'unknown', policySource: 'custom_provider',
	},
};
const validation = new ProviderStructuredOutputValidationError(botText('en'), 'compaction', botText('en').issue('structured_output.nonreducing.before', { compactedTokens: 100 }), { validationIssue: 'non_reducing_compaction' });
const persistent = new PersistentCompactionReductionFailureError(3, '{}', diagnostic, 'Long summary');
const validations: Array<[Error, string | null]> = [
	[persistent, 'non_reducing_compaction'],
	[validation, 'non_reducing_compaction'],
	[new CompactionReasoningRefusalError({ kind: 'no_supported_effort', required: { kind: 'explicit_effort', effort: 'high' }, supportedEfforts: [] }, diagnostic.provenance), 'no_supported_effort'],
	[new PromptContextBudgetExceededError(200, 100), 'prompt_context_budget_exceeded'],
	[new PromptContextCompactionLimitError(200, 100, 3), 'prompt_context_compaction_limit'],
	[new ProviderCompactionOutputLimitError('{}', 'length', ''), 'provider_compaction_output_limit'],
	[new ProviderEmptyResponseError('{}'), 'provider_empty_response'],
	[new ResponseBodySizeLimitError(1024), 'response_body_size_limit'],
	[new InputError('Invalid input.'), null],
	[new RepositoryError('bad_request', 'Invalid batch.', 400), 'bad_request'],
];

describe('agent log failure causes', () => {
	it.each(validations)('keeps the validation cause of %s', (error, issue) => {
		expect(agentLogFailure(error)).toEqual({ kind: 'validation', issue, message: error.message });
	});

	it.each([
		new ProviderRequestTimeoutError(1000), new ProviderResponseBodyTimeoutError(1000),
		new ProviderStreamIdleTimeoutError(1000), new RuntimeOperationTimeoutError('Compaction', 1000),
	])('keeps %s as a timeout', error => {
		expect(agentLogFailure(error)).toEqual({ kind: 'timeout' });
	});

	it.each([
		new ProviderStreamIncompleteError(), new TickStoppedError(), new DOMException('Stopped.', 'AbortError'),
		new ProviderResponseInterruptedError({ content: 'Partial', reasoning: '', reasoningDetails: [], toolCalls: [] }, new TickStoppedError()),
	])('keeps %s as an interruption', error => {
		expect(agentLogFailure(error)).toEqual({ kind: 'interrupted' });
	});

	it.each([
		new ProviderCompactionRequestError(persistent, '{}', diagnostic),
		new ProviderLoopRequestError(new ProviderCompactionRequestError(persistent, '{}', diagnostic), '{}', 3),
	])('keeps the typed cause through %s', error => {
		expect(agentLogFailure(error)).toEqual({ kind: 'validation', issue: 'non_reducing_compaction', message: persistent.message });
	});

	it('keeps provider status and error type through request wrappers', () => {
		const error = new ProviderRequestError(429, 'test', 'https://provider.test', 'Busy.', { providerError: { kind: 'provider_error', status: 429, errorType: 'rate_limit' } });
		const expected: AgentLogFailure = { kind: 'provider_error', status: 429, errorType: 'rate_limit', message: error.message };
		expect(agentLogFailure(error)).toEqual(expected);
		expect(agentLogFailure(new ProviderLoopRequestError(error, '{}', 3))).toEqual(expected);
		expect(agentLogFailure(new ProviderCompactionRequestError(error, '{}', diagnostic))).toEqual(expected);
	});

	it.each([new Error('Local failure.'), new RepositoryError('server_error', 'Storage failed.', 500), 'Unknown failure.'])('keeps local failures separate from provider errors: %s', error => {
		expect(agentLogFailure(error)).toEqual({ kind: 'runtime_error', message: error instanceof Error ? error.message : error });
	});
});

let storage: RuntimeTestStorage | undefined;
afterEach(() => { storage?.database.close(); storage = undefined; vi.restoreAllMocks(); });

it('retains the non-reducing issue on the failed session and its request attempts', async () => {
	storage = createRuntimeTestStorage();
	storage.database.exec(runtimeSchema);
	const logs = new AgentLogStore(storage);
	const instance = Object.assign(Object.create(BotRuntime.prototype), {
		state: { storage }, agentLogs: logs,
		compactLoopMessageBatchesForSession: async () => {
			const sessionId = storage!.sql.exec<{ id: string }>('SELECT id FROM compaction_sessions LIMIT 1').one().id;
			const requestId = logs.begin({ runId: 'run', eventSeq: 1, purpose: 'compaction', sessionId });
			for (let index = 0; index < 3; index++) logs.settle(logs.startAttempt(requestId, '{}'), agentLogFailure(validation));
			logs.finish(requestId, 'failed');
			throw persistent;
		},
	});
	await expect(instance.compactLoopMessageRowsInBatches(testResultContext, {}, {}, 'run', new AbortController().signal, [], 'manual', {})).rejects.toBe(persistent);
	const id = storage.sql.exec<{ id: string }>('SELECT id FROM compaction_sessions LIMIT 1').one().id;
	const session = logs.session(id);
	expect(session.outcome).toEqual({ kind: 'failed', error: { kind: 'validation', issue: 'non_reducing_compaction', message: persistent.message } });
	expect(session.requests[0]?.attempts.map(attempt => attempt.outcome)).toEqual(Array.from({ length: 3 }, () => ({ kind: 'validation', issue: 'non_reducing_compaction', message: validation.message })));
});
