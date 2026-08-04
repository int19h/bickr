import { describe, expect, it } from 'vitest';
import { CompactionAttemptPlan, type CompactionAttemptPlanConfig } from './plan';

const config = {
	initialReasoning: {
		runtimeFallback: { kind: 'unknown_model', selection: { kind: 'model_default', effort: 'minimal' } },
		selection: { kind: 'reasoning_disabled' },
		source: 'custom_provider',
	},
	maxProviderAttempts: 3,
	maxSchemaRepairAttempts: 2,
} as const satisfies CompactionAttemptPlanConfig;

describe('CompactionAttemptPlan', () => {
	it('starts with an initial request using the configured reasoning mode', () => {
		const request = CompactionAttemptPlan.start(config).request();

		expect(request).toMatchObject({
			calibrationAttempt: 1,
			isolatedReductionRepairAttempts: 0,
			messageSet: { kind: 'initial' },
			providerAttempt: 1,
			reasoning: {
				runtimeFallback: { kind: 'unknown_model' },
				selection: { kind: 'reasoning_disabled' },
				source: 'custom_provider',
			},
			schemaAttempt: 0,
			toolSet: 'base',
		});
	});

	it('lands success in the succeeded terminal state', () => {
		const plan = CompactionAttemptPlan.start(config).transition({ kind: 'success' });

		expect(plan.state).toEqual({
			kind: 'terminal',
			terminal: 'succeeded',
			counters: {
				calibrationAttempt: 1,
				isolatedReductionRepairAttempts: 0,
				providerAttempt: 1,
				schemaAttempt: 0,
			},
		});
	});

	it('retries reasoning rejection once with the model-default selection', () => {
		const plan = CompactionAttemptPlan.start(config).transition({
			kind: 'reasoning_rejected',
			cause: { kind: 'provider_request', status: 400 },
			reason: 'typed provider rejection',
		});

		expect(plan.request()).toMatchObject({
			calibrationAttempt: 2,
			providerAttempt: 2,
			reasoning: {
				runtimeFallback: { kind: 'none' },
				selection: { kind: 'model_default', effort: 'minimal' },
				source: 'runtime_fallback',
			},
			retry: {
				attempt: 2,
				delayMs: 0,
				maxAttempts: 3,
				reason: {
					kind: 'reasoning_fallback',
					from: { kind: 'reasoning_disabled' },
					to: { kind: 'model_default', effort: 'minimal' },
				},
			},
		});
	});

	it('treats server-tool crashes as the same reasoning fallback transition', () => {
		const plan = CompactionAttemptPlan.start(config).transition({
			kind: 'server_tool_crash',
			cause: { kind: 'provider_request', status: 500 },
			reason: 'known compaction server-tool crash',
		});

		expect(plan.request()).toMatchObject({
			providerAttempt: 2,
			reasoning: expect.objectContaining({
				selection: { kind: 'model_default', effort: 'minimal' },
			}),
			retry: expect.objectContaining({ delayMs: 0 }),
		});
	});

	it('does not keep retrying reasoning fallback once model-default reasoning is active', () => {
		const plan = CompactionAttemptPlan.start(config)
			.transition({
				kind: 'reasoning_rejected',
				cause: { kind: 'provider_request', status: 400 },
				reason: 'typed provider rejection',
			})
			.transition({
				kind: 'reasoning_rejected',
				cause: { kind: 'provider_request', status: 400 },
				reason: 'typed provider rejection',
			});

		expect(plan.state).toMatchObject({
			kind: 'terminal',
			terminal: 'failed',
			cause: { kind: 'reasoning_rejected' },
		});
	});

	it('retries transport errors while the retry key is stable', () => {
		const retried = CompactionAttemptPlan.start(config).transition({
			kind: 'transport_error',
			cause: { kind: 'provider_request', status: 503 },
			retry: { kind: 'retry_key', retryKey: '503:overloaded', delayMs: 6000, reason: '503:overloaded' },
		});

		expect(retried.request()).toMatchObject({
			calibrationAttempt: 2,
			previousRetryKey: '503:overloaded',
			providerAttempt: 2,
			retry: {
				attempt: 2,
				delayMs: 6000,
				maxAttempts: 3,
				reason: { kind: 'provider', detail: '503:overloaded' },
			},
		});

		const retriedAgain = retried.transition({
			kind: 'transport_error',
			cause: { kind: 'provider_request', status: 503 },
			retry: { kind: 'retry_key', retryKey: '503:overloaded', delayMs: 9000, reason: '503:overloaded' },
		});

		expect(retriedAgain.request()).toMatchObject({
			calibrationAttempt: 3,
			providerAttempt: 3,
			retry: expect.objectContaining({ delayMs: 9000 }),
		});
	});

	it('fails transport retry when the retry key changes', () => {
		const plan = CompactionAttemptPlan.start(config)
			.transition({
				kind: 'transport_error',
				cause: { kind: 'provider_request', status: 503 },
				retry: { kind: 'retry_key', retryKey: '503:overloaded', delayMs: 6000, reason: '503:overloaded' },
			})
			.transition({
				kind: 'transport_error',
				cause: { kind: 'provider_request', status: 429 },
				retry: { kind: 'retry_key', retryKey: '429:rate_limit', delayMs: 9000, reason: '429:rate_limit' },
			});

		expect(plan.state).toMatchObject({
			kind: 'terminal',
			terminal: 'failed',
			cause: { kind: 'provider_failure' },
		});
	});

	it('retries transport errors with updated provider routing when an upstream provider is ignored', () => {
		const providerRouting = { ignore: ['slow-provider'] };
		const plan = CompactionAttemptPlan.start(config).transition({
			kind: 'transport_error',
			cause: { kind: 'provider_request', status: 429 },
			retry: { kind: 'upstream_provider_ignored', providerRouting, reason: '429:rate_limit; ignoring upstream provider slow-provider' },
		});

		expect(plan.request()).toMatchObject({
			previousRetryKey: null,
			providerAttempt: 2,
			settingsPatch: { providerRouting },
			retry: expect.objectContaining({
				delayMs: 0,
				reason: { kind: 'provider', detail: '429:rate_limit; ignoring upstream provider slow-provider' },
			}),
		});
	});

	it('preserves an explicit selection through routing, schema, shortening, and isolated repairs', () => {
		const explicitReasoning = {
			runtimeFallback: { kind: 'none' },
			selection: { kind: 'explicit_effort', effort: 'low' },
			source: 'openrouter_semantic_override',
		} as const;
		let plan = CompactionAttemptPlan.start({
			...config,
			initialReasoning: explicitReasoning,
			maxProviderAttempts: 5,
			maxSchemaRepairAttempts: 5,
		});
		const expectExplicitReasoning = () => expect(plan.request().reasoning).toEqual(explicitReasoning);

		expectExplicitReasoning();
		plan = plan.transition({
			kind: 'transport_error',
			cause: { kind: 'provider_request', status: 429 },
			retry: { kind: 'upstream_provider_ignored', providerRouting: { ignore: ['slow-provider'] }, reason: 'ignore route' },
		});
		expectExplicitReasoning();
		plan = plan.transition({
			kind: 'schema_invalid',
			cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'bad JSON' },
			previousMessages: [{ role: 'user', content: 'Compact this.' }],
			repairMessages: [{ role: 'assistant', content: 'Actually, I must reply with JSON.' }],
		});
		expectExplicitReasoning();
		plan = plan.transition({
			kind: 'schema_invalid',
			cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'too long' },
			outputText: 'A long prior summary.',
			previousMessages: [],
			repairMessages: [],
		});
		expectExplicitReasoning();
		plan = plan.transition({
			kind: 'success_but_not_shorter',
			cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'not shorter' },
			canIsolate: true,
			outputText: 'Still too much retained context.',
		});
		expectExplicitReasoning();
		expect(plan.request()).toMatchObject({
			messageSet: { kind: 'isolated_reduction_repair' },
			toolSet: 'isolated_reduction_repair',
		});
	});

	it('repairs schema-invalid outputs by appending typed repair messages', () => {
		const previousMessages = [{ role: 'user' as const, content: 'Compact this.' }];
		const repairMessages = [{ role: 'assistant' as const, content: 'Actually, I must reply with JSON.' }];
		const plan = CompactionAttemptPlan.start(config).transition({
			kind: 'schema_invalid',
			cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'bad JSON' },
			previousMessages,
			repairMessages,
		});

		expect(plan.request()).toMatchObject({
			calibrationAttempt: 2,
			messageSet: { kind: 'schema_repair', messages: [...previousMessages, ...repairMessages] },
			providerAttempt: 1,
			schemaAttempt: 1,
		});
	});

	it('uses shorten messages for schema-invalid outputs with recovered text', () => {
		const plan = CompactionAttemptPlan.start(config).transition({
			kind: 'schema_invalid',
			cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'too long' },
			outputText: 'A long prior summary.',
			previousMessages: [],
			repairMessages: [],
		});

		expect(plan.request()).toMatchObject({
			messageSet: { kind: 'shorten_previous_summary', previousSummary: 'A long prior summary.' },
			providerAttempt: 1,
			schemaAttempt: 1,
			toolSet: 'base',
		});
	});

	it('uses isolated repair for successful summaries that do not shorten the compacted context', () => {
		const plan = CompactionAttemptPlan.start(config).transition({
			kind: 'success_but_not_shorter',
			cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'not shorter' },
			canIsolate: true,
			outputText: 'Still too much retained context.',
		});

		expect(plan.request()).toMatchObject({
			isolatedReductionRepairAttempts: 1,
			messageSet: { kind: 'isolated_reduction_repair', previousSummary: 'Still too much retained context.' },
			providerAttempt: 1,
			schemaAttempt: 1,
			toolSet: 'isolated_reduction_repair',
		});
	});

	it('lands repeated isolated non-reduction in the named auto-pause terminal state', () => {
		const plan = CompactionAttemptPlan.start({ ...config, maxSchemaRepairAttempts: 1 })
			.transition({
				kind: 'success_but_not_shorter',
				cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'not shorter' },
				canIsolate: true,
				outputText: 'Still too much retained context.',
			})
			.transition({
				kind: 'success_but_not_shorter',
				cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'not shorter' },
				canIsolate: true,
				outputText: 'Still too much retained context.',
			});

		expect(plan.state).toMatchObject({
			kind: 'terminal',
			terminal: 'paused_persistent_reduction_failure',
			attempts: 1,
		});
	});

	it('fails non-reducing summaries without auto-pause when isolated repair was unavailable', () => {
		const plan = CompactionAttemptPlan.start({ ...config, maxSchemaRepairAttempts: 0 }).transition({
			kind: 'success_but_not_shorter',
			cause: { kind: 'provider_structured_output_validation', outputKind: 'compaction', repairMessage: 'not shorter' },
			canIsolate: false,
			outputText: 'Still too much retained context.',
		});

		expect(plan.state).toMatchObject({
			kind: 'terminal',
			terminal: 'failed',
			cause: { kind: 'schema_invalid' },
		});
	});

	it('lands output limit directly in failed terminal state', () => {
		const plan = CompactionAttemptPlan.start(config).transition({
			kind: 'output_limit',
			cause: { kind: 'provider_compaction_output_limit', finishReason: 'length', nativeFinishReason: '', rawResponse: '{}' },
		});

		expect(plan.state).toMatchObject({
			kind: 'terminal',
			terminal: 'failed',
			cause: { kind: 'output_limit' },
		});
	});
});
