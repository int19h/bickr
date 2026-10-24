import { RepositoryError } from '@bickr/shared/repository';
import { agentLogFailure } from './agent-log-store';

function validationMessage(issue: string | null): string {
	switch (issue) {
		case 'non_reducing_compaction': return 'Compaction could not produce a shorter summary. Add new history or reduce the summary size before you try again.';
		case 'missing_compaction_summary': return 'Compaction did not produce a summary. Try again after you add new history.';
		case 'transcript_like_compaction': return 'Compaction returned a transcript instead of a summary. Change the compaction configuration before you try again.';
		case 'provider_compaction_output_limit': return 'Compaction reached the provider output limit. Increase the output budget before you try again.';
		case 'provider_empty_response': return 'The inference provider returned an empty compaction response. Try again later.';
		case 'response_body_size_limit': return 'The compaction response exceeded the response size limit. Reduce the summary size before you try again.';
		case 'prompt_context_budget_exceeded': case 'prompt_context_compaction_limit': return 'The history exceeds the compaction context budget. Increase the context budget before you try again.';
		case 'no_supported_effort': return 'The inference provider does not support the required compaction reasoning level. Change the compaction configuration before you try again.';
		case 'invalid_url': return 'The inference provider URL for compaction is invalid. Set a valid provider URL before you try again.';
		case 'insecure_url': return 'The inference provider URL for compaction must use HTTPS, except for a local loopback server.';
		case 'embedded_credentials': return 'The inference provider URL for compaction must not contain credentials.';
		default: return 'Compaction returned an invalid result. Change the compaction configuration before you try again.';
	}
}

// Owner messages use structured causes. Session logs retain diagnostic messages.
export function manualCompactionError(error: unknown): RepositoryError | null {
	if (error instanceof RepositoryError) return error;
	const failure = agentLogFailure(error);
	switch (failure.kind) {
		case 'validation': {
			const message = validationMessage(failure.issue);
			return new RepositoryError('bad_request', message, 422, { compactionFailure: { kind: 'validation', issue: failure.issue, message } });
		}
		case 'timeout': return new RepositoryError('bad_request', 'Compaction timed out. Try again later.', 408, { compactionFailure: { kind: 'timeout' } });
		case 'interrupted': return new RepositoryError('conflict', 'Compaction was interrupted.', 409, { compactionFailure: { kind: 'interrupted' } });
		case 'provider_error': {
			const message = failure.errorType === 'connection'
				? 'Compaction could not connect to the inference provider. Try again later.'
				: failure.errorType === 'redirect'
					? 'The inference provider redirected the compaction request. Set its final HTTPS URL before you try again.'
					: failure.status !== null
						? `The inference provider rejected the compaction request with HTTP ${failure.status}. Try again later.`
						: 'Compaction failed at the inference provider. Try again later.';
			return new RepositoryError('server_error', message, 502, { compactionFailure: { kind: 'provider_error', status: failure.status, errorType: failure.errorType, message } });
		}
		case 'unknown': case 'runtime_error': case 'dropped_invalid_output': return null;
	}
}
