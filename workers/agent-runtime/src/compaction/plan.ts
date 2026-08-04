import type { JsonObject, BotInferenceSubmissionMessage } from '@bickr/shared/model';
import type {
	CompactionReasoningPolicy,
	CompactionReasoningRuntimeFallback,
	CompactionReasoningSelection,
} from '@bickr/shared/openrouter-model-capabilities';
import type { RuntimeErrorCause } from '@bickr/shared/runtime-errors';

export type CompactionAttemptReasoningState = {
	runtimeFallback: CompactionReasoningRuntimeFallback;
	selection: CompactionReasoningSelection;
	source: CompactionReasoningPolicy['source'] | 'runtime_fallback';
};

export type CompactionAttemptMessageSet =
	| { kind: 'initial' }
	| { kind: 'schema_repair'; messages: BotInferenceSubmissionMessage[] }
	| { kind: 'shorten_previous_summary'; previousSummary: string }
	| { kind: 'isolated_reduction_repair'; previousSummary: string };

export type CompactionAttemptToolSet = 'base' | 'isolated_reduction_repair';

export type CompactionAttemptCounters = {
	calibrationAttempt: number;
	isolatedReductionRepairAttempts: number;
	providerAttempt: number;
	schemaAttempt: number;
};

export type CompactionAttemptRetryInstruction = {
	attempt: number;
	delayMs: number;
	maxAttempts: number;
	reason: CompactionAttemptRetryReason | null;
};

export type CompactionAttemptRetryReason =
	| { kind: 'provider'; detail: string }
	| {
			kind: 'reasoning_fallback';
			from: Extract<CompactionReasoningSelection, { kind: 'reasoning_disabled' }>;
			to: Extract<CompactionReasoningSelection, { kind: 'model_default' }>;
	  };

export type CompactionAttemptSettingsPatch = {
	providerRouting: JsonObject;
};

export type CompactionAttemptRequestState = CompactionAttemptCounters & {
	kind: 'requesting';
	messageSet: CompactionAttemptMessageSet;
	previousRetryKey: string | null;
	reasoning: CompactionAttemptReasoningState;
	retry?: CompactionAttemptRetryInstruction;
	settingsPatch?: CompactionAttemptSettingsPatch;
	toolSet: CompactionAttemptToolSet;
};

export type CompactionAttemptTerminalState =
	| {
			kind: 'terminal';
			terminal: 'succeeded';
			counters: CompactionAttemptCounters;
	  }
	| {
			kind: 'terminal';
			terminal: 'paused_persistent_reduction_failure';
			attempts: number;
			counters: CompactionAttemptCounters;
	  }
	| {
			kind: 'terminal';
			terminal: 'failed';
			cause: CompactionAttemptFailureCause;
			counters: CompactionAttemptCounters;
	  };

export type CompactionAttemptState = CompactionAttemptRequestState | CompactionAttemptTerminalState;

export type CompactionAttemptFailureCause =
	| { kind: 'output_limit'; cause: RuntimeErrorCause | string }
	| { kind: 'schema_invalid'; cause: RuntimeErrorCause | string }
	| { kind: 'provider_failure'; cause: RuntimeErrorCause | string }
	| { kind: 'reasoning_rejected'; cause: RuntimeErrorCause | string; reason: string }
	| { kind: 'server_tool_crash'; cause: RuntimeErrorCause | string; reason: string }
	| { kind: 'timeout'; cause: RuntimeErrorCause | string };

export type CompactionAttemptTransitionInput =
	| { kind: 'success' }
	| {
			kind: 'schema_invalid';
			cause: RuntimeErrorCause | string;
			outputText?: string;
			previousMessages: BotInferenceSubmissionMessage[];
			repairMessages: BotInferenceSubmissionMessage[];
	  }
	| { kind: 'output_limit'; cause: RuntimeErrorCause | string }
	| { kind: 'reasoning_rejected'; cause: RuntimeErrorCause | string; reason: string }
	| { kind: 'server_tool_crash'; cause: RuntimeErrorCause | string; reason: string }
	| { kind: 'success_but_not_shorter'; cause: RuntimeErrorCause | string; outputText: string; canIsolate: boolean }
	| {
			kind: 'transport_error';
			cause: RuntimeErrorCause | string;
			retry?:
				| { kind: 'retry_key'; delayMs: number; reason: string; retryKey: string }
				| { kind: 'upstream_provider_ignored'; providerRouting: JsonObject; reason: string };
	  };

export type CompactionAttemptPlanConfig = {
	initialReasoning: CompactionAttemptReasoningState;
	maxProviderAttempts: number;
	maxSchemaRepairAttempts: number;
};

type NextRequestInput = {
	messageSet?: CompactionAttemptMessageSet;
	previousRetryKey?: string | null;
	reasoning?: CompactionAttemptReasoningState;
	retry?: CompactionAttemptRetryInstruction;
	settingsPatch?: CompactionAttemptSettingsPatch;
	toolSet?: CompactionAttemptToolSet;
} & Partial<Pick<CompactionAttemptCounters, 'isolatedReductionRepairAttempts' | 'providerAttempt' | 'schemaAttempt'>>;

export class CompactionAttemptPlan {
	private readonly config: CompactionAttemptPlanConfig;
	readonly state: CompactionAttemptState;

	private constructor(config: CompactionAttemptPlanConfig, state: CompactionAttemptState) {
		this.config = config;
		this.state = state;
	}

	static start(config: CompactionAttemptPlanConfig): CompactionAttemptPlan {
		return new CompactionAttemptPlan(config, {
			kind: 'requesting',
			calibrationAttempt: 1,
			isolatedReductionRepairAttempts: 0,
			messageSet: { kind: 'initial' },
			previousRetryKey: null,
			providerAttempt: 1,
			reasoning: config.initialReasoning,
			schemaAttempt: 0,
			toolSet: 'base',
		});
	}

	request(): CompactionAttemptRequestState {
		if (this.state.kind !== 'requesting') {
			throw new Error(`Compaction attempt plan is terminal: ${this.state.terminal}`);
		}
		return this.state;
	}

	transition(input: CompactionAttemptTransitionInput): CompactionAttemptPlan {
		if (this.state.kind !== 'requesting') {
			throw new Error(`Cannot transition terminal compaction attempt plan: ${this.state.terminal}`);
		}
		switch (input.kind) {
			case 'success':
				return this.terminal({ kind: 'terminal', terminal: 'succeeded', counters: counters(this.state) });
			case 'output_limit':
				return this.failed({ kind: 'output_limit', cause: input.cause });
			case 'reasoning_rejected':
				return this.reasoningFallback(input);
			case 'server_tool_crash':
				return this.reasoningFallback(input);
			case 'success_but_not_shorter':
				return this.repairNonReducingSummary(input);
			case 'schema_invalid':
				return this.repairSchemaInvalid(input);
			case 'transport_error':
				return this.retryTransport(input);
		}
	}

	private reasoningFallback(
		input: Extract<CompactionAttemptTransitionInput, { kind: 'reasoning_rejected' | 'server_tool_crash' }>,
	): CompactionAttemptPlan {
		if (
			this.state.kind !== 'requesting' ||
			this.state.reasoning.selection.kind !== 'reasoning_disabled' ||
			this.state.reasoning.runtimeFallback.kind !== 'unknown_model'
		) {
			return this.failed({
				kind: input.kind,
				cause: input.cause,
				reason: input.reason,
			});
		}
		if (this.state.providerAttempt >= this.config.maxProviderAttempts) {
			return this.failed({
				kind: input.kind,
				cause: input.cause,
				reason: input.reason,
			});
		}
		return this.nextRequest({
			previousRetryKey: null,
			providerAttempt: this.state.providerAttempt + 1,
			reasoning: {
				runtimeFallback: { kind: 'none' },
				selection: this.state.reasoning.runtimeFallback.selection,
				source: 'runtime_fallback',
			},
			retry: {
				attempt: this.state.providerAttempt + 1,
				delayMs: 0,
				maxAttempts: this.config.maxProviderAttempts,
				reason: {
					kind: 'reasoning_fallback',
					from: this.state.reasoning.selection,
					to: this.state.reasoning.runtimeFallback.selection,
				},
			},
		});
	}

	private repairNonReducingSummary(input: Extract<CompactionAttemptTransitionInput, { kind: 'success_but_not_shorter' }>): CompactionAttemptPlan {
		if (this.state.kind !== 'requesting') {
			return this;
		}
		if (this.state.schemaAttempt >= this.config.maxSchemaRepairAttempts) {
			if (this.state.isolatedReductionRepairAttempts > 0) {
				return this.terminal({
					kind: 'terminal',
					terminal: 'paused_persistent_reduction_failure',
					attempts: this.state.isolatedReductionRepairAttempts,
					counters: counters(this.state),
				});
			}
			return this.failed({ kind: 'schema_invalid', cause: input.cause });
		}
		if (input.canIsolate) {
			return this.nextRequest({
				isolatedReductionRepairAttempts: this.state.isolatedReductionRepairAttempts + 1,
				messageSet: { kind: 'isolated_reduction_repair', previousSummary: input.outputText },
				previousRetryKey: null,
				providerAttempt: 1,
				schemaAttempt: this.state.schemaAttempt + 1,
				toolSet: 'isolated_reduction_repair',
			});
		}
		return this.nextRequest({
			messageSet: { kind: 'shorten_previous_summary', previousSummary: input.outputText },
			previousRetryKey: null,
			providerAttempt: 1,
			schemaAttempt: this.state.schemaAttempt + 1,
		});
	}

	private repairSchemaInvalid(input: Extract<CompactionAttemptTransitionInput, { kind: 'schema_invalid' }>): CompactionAttemptPlan {
		if (this.state.kind !== 'requesting') {
			return this;
		}
		if (this.state.schemaAttempt >= this.config.maxSchemaRepairAttempts) {
			return this.failed({ kind: 'schema_invalid', cause: input.cause });
		}
		return this.nextRequest({
			messageSet: input.outputText
				? { kind: 'shorten_previous_summary', previousSummary: input.outputText }
				: { kind: 'schema_repair', messages: [...input.previousMessages, ...input.repairMessages] },
			previousRetryKey: null,
			providerAttempt: 1,
			schemaAttempt: this.state.schemaAttempt + 1,
		});
	}

	private retryTransport(input: Extract<CompactionAttemptTransitionInput, { kind: 'transport_error' }>): CompactionAttemptPlan {
		if (this.state.kind !== 'requesting' || !input.retry || this.state.providerAttempt >= this.config.maxProviderAttempts) {
			return this.failed({ kind: 'provider_failure', cause: input.cause });
		}
		if (input.retry.kind === 'retry_key') {
			if (this.state.previousRetryKey !== null && this.state.previousRetryKey !== input.retry.retryKey) {
				return this.failed({ kind: 'provider_failure', cause: input.cause });
			}
			return this.nextRequest({
				previousRetryKey: input.retry.retryKey,
				providerAttempt: this.state.providerAttempt + 1,
				retry: {
					attempt: this.state.providerAttempt + 1,
					delayMs: input.retry.delayMs,
					maxAttempts: this.config.maxProviderAttempts,
					reason: { kind: 'provider', detail: input.retry.reason },
				},
			});
		}
		return this.nextRequest({
			previousRetryKey: null,
			providerAttempt: this.state.providerAttempt + 1,
			retry: {
				attempt: this.state.providerAttempt + 1,
				delayMs: 0,
				maxAttempts: this.config.maxProviderAttempts,
				reason: { kind: 'provider', detail: input.retry.reason },
			},
			settingsPatch: { providerRouting: input.retry.providerRouting },
		});
	}

	private nextRequest(input: NextRequestInput): CompactionAttemptPlan {
		if (this.state.kind !== 'requesting') {
			return this;
		}
		return new CompactionAttemptPlan(this.config, {
			kind: 'requesting',
			calibrationAttempt: this.state.calibrationAttempt + 1,
			isolatedReductionRepairAttempts: input.isolatedReductionRepairAttempts ?? this.state.isolatedReductionRepairAttempts,
			messageSet: input.messageSet ?? this.state.messageSet,
			previousRetryKey: 'previousRetryKey' in input ? input.previousRetryKey ?? null : this.state.previousRetryKey,
			providerAttempt: input.providerAttempt ?? this.state.providerAttempt,
			reasoning: input.reasoning ?? this.state.reasoning,
			schemaAttempt: input.schemaAttempt ?? this.state.schemaAttempt,
			toolSet: input.toolSet ?? this.state.toolSet,
			...(input.retry ? { retry: input.retry } : {}),
			...(input.settingsPatch ? { settingsPatch: input.settingsPatch } : {}),
		});
	}

	private failed(cause: CompactionAttemptFailureCause): CompactionAttemptPlan {
		if (this.state.kind !== 'requesting') {
			return this;
		}
		return this.terminal({ kind: 'terminal', terminal: 'failed', cause, counters: counters(this.state) });
	}

	private terminal(state: CompactionAttemptTerminalState): CompactionAttemptPlan {
		return new CompactionAttemptPlan(this.config, state);
	}
}

function counters(state: CompactionAttemptRequestState): CompactionAttemptCounters {
	return {
		calibrationAttempt: state.calibrationAttempt,
		isolatedReductionRepairAttempts: state.isolatedReductionRepairAttempts,
		providerAttempt: state.providerAttempt,
		schemaAttempt: state.schemaAttempt,
	};
}
