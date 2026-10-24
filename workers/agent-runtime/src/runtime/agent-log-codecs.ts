import type { AgentLogAuthor, AgentLogAttemptOutcome, AgentLogCompactionOutcome, AgentLogCompactionTrigger, AgentLogFailure } from '@bickr/shared/model';
import { RepositoryError } from '@bickr/shared/repository';

function invalid(): never {
	throw new RepositoryError('conflict', 'The stored agent log has an unsupported shape.', 409);
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}

function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : invalid(); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : invalid(); }

export function storedLogValue(value: string): unknown {
	try { return JSON.parse(value); } catch { return invalid(); }
}

// Every stored union crosses the API boundary through an explicit field list.
export function logFailure(value: unknown): AgentLogFailure {
	const item = record(value);
	switch (item.kind) {
		case 'provider_error': return { kind: 'provider_error', status: item.status === null ? null : number(item.status), errorType: item.errorType === null ? null : text(item.errorType), message: text(item.message) };
		case 'validation': return { kind: 'validation', issue: item.issue === null ? null : text(item.issue), message: text(item.message) };
		case 'dropped_invalid_output': return { kind: 'dropped_invalid_output', droppedCalls: array(item.droppedCalls).map(value => {
			const call = record(value);
			return { id: text(call.id), name: text(call.name), reason: text(call.reason), argumentsPreview: text(call.argumentsPreview) };
		}) };
		case 'interrupted': return { kind: 'interrupted', ...(item.response === undefined ? {} : { response: text(item.response) }) };
		case 'timeout': return { kind: 'timeout' };
		default: return invalid();
	}
}

export function logAttemptOutcome(value: unknown): AgentLogAttemptOutcome {
	const item = record(value);
	return item.kind === 'success' ? { kind: 'success', response: text(item.response) } : logFailure(item);
}

export function logAttemptKind(value: unknown): AgentLogAttemptOutcome['kind'] {
	const item = record(value);
	switch (item.kind) {
		case 'success': case 'provider_error': case 'validation': case 'dropped_invalid_output': case 'interrupted': case 'timeout': return item.kind;
		default: return invalid();
	}
}

export function logCompactionOutcome(value: unknown): AgentLogCompactionOutcome {
	const item = record(value);
	switch (item.kind) {
		case 'pending': return { kind: 'pending' };
		case 'succeeded': return { kind: 'succeeded', summarySeq: number(item.summarySeq) };
		case 'failed': return { kind: 'failed', error: logFailure(item.error) };
		case 'partial': return { kind: 'partial', summarySeqs: array(item.summarySeqs).map(number), failedBatchCount: number(item.failedBatchCount), error: logFailure(item.error) };
		default: return invalid();
	}
}

export function logTrigger(value: unknown): AgentLogCompactionTrigger {
	const item = record(value);
	switch (item.kind) {
		case 'visit': case 'admission': case 'manual': case 'legacy_forced': return { kind: item.kind };
		default: return invalid();
	}
}

export function logAuthor(value: unknown): AgentLogAuthor {
	const item = record(value);
	switch (item.kind) {
		case 'model': case 'owner_injection': case 'reminder': case 'self_correction': case 'recurring_prompt': case 'spotlight_focus': case 'synthetic_tool_call': case 'local_simulation': case 'compaction_summary': case 'legacy_summary': case 'bickr_report': case 'legacy_synthetic': return { kind: item.kind };
		case 'tool_result': return { kind: 'tool_result', synthetic: typeof item.synthetic === 'boolean' ? item.synthetic : invalid() };
		default: return invalid();
	}
}

export function logToolDelta(value: unknown) {
	const item = record(value);
	const fn = item.function == null ? null : record(item.function);
	return {
		...(item.index == null ? {} : { index: number(item.index) }),
		...(item.id == null ? {} : { id: text(item.id) }),
		...(item.type == null ? {} : { type: text(item.type) }),
		...(fn === null ? {} : { function: {
			...(fn.name == null ? {} : { name: text(fn.name) }),
			...(fn.arguments == null ? {} : { arguments: text(fn.arguments) }),
		} }),
	};
}

export function logPartial(value: unknown) {
	const item = record(value);
	return { content: text(item.content), reasoning: text(item.reasoning), toolCalls: array(item.toolCalls).map(logToolDelta) };
}
