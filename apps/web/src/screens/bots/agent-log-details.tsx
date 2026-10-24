import type { AgentLogAttempt, AgentLogAttemptOutcome, AgentLogCompactionSession, AgentLogRequest } from '@bickr/shared/model';
import type { ReactNode } from 'react';
import { TimeAgoLabel } from '../../components/record-display';
import { Modal } from '../../ui';
import { RawInferenceSubmissionMessageView, SubmissionJsonBlock } from './loop-log-formatting';

export function attemptCause(outcome: AgentLogAttemptOutcome | null): string {
	if (!outcome) return 'In progress';
	switch (outcome.kind) {
		case 'success':
			return 'Succeeded';
		case 'provider_error':
			return ['Provider error', outcome.status, outcome.errorType].filter((value) => value !== null).join(' · ');
		case 'dropped_invalid_output':
			return 'Invalid output';
		case 'validation':
			return `Validation failed${outcome.issue ? ` · ${outcome.issue}` : ''}`;
		case 'interrupted':
			return 'Interrupted';
		case 'timeout':
			return 'Timed out';
		default:
			return 'Unknown outcome';
	}
}

function AttemptDetails({ attempt, number }: { attempt: AgentLogAttempt; number: number }) {
	return (
		<details className="agent-log-attempt">
			<summary>
				Attempt {number} · <TimeAgoLabel value={attempt.startedAt} /> · {attemptCause(attempt.outcome)}
			</summary>
			<details>
				<summary>Raw outcome</summary>
				<SubmissionJsonBlock label="Outcome" value={attempt.outcome} />
			</details>
			{attempt.body ? (
				<details>
					<summary>Request as sent</summary>
					<StoredRequestBody body={attempt.body} />
				</details>
			) : (
				<p>The exact request is not retained.</p>
			)}
			{attempt.partialResponse && <SubmissionJsonBlock label="Partial response" value={attempt.partialResponse} />}
		</details>
	);
}

export function AgentLogAttempts({ request }: { request: AgentLogRequest }) {
	return (
		<div className="agent-log-attempts">
			{request.attempts.map((attempt, index) => (
				<AttemptDetails key={attempt.id} attempt={attempt} number={index + 1} />
			))}
			<p className={request.state === 'succeeded' ? 'agent-log-success' : request.state === 'failed' ? 'agent-log-error' : ''}>
				{request.state === 'succeeded'
					? `Attempt ${request.attempts.findIndex((attempt) => attempt.outcome?.kind === 'success') + 1 || request.attempts.length} succeeded`
					: request.state === 'failed'
						? `Gave up after ${request.attempts.length} attempts`
						: request.state === 'pending'
							? 'Request in progress'
							: 'Unknown request state'}
			</p>
		</div>
	);
}

// This adapter reads only the stored request. It never rebuilds history from current rows.
function StoredRequestBody({ body }: { body: string }) {
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return <SubmissionJsonBlock label="Request as sent" value={body} />;
	}
	return (
		<>
			{Array.isArray(parsed?.messages) &&
				parsed.messages.map((message: Parameters<typeof RawInferenceSubmissionMessageView>[0]['message'], index: number) =>
					message.role === 'system' ? (
						<details key={index}>
							<summary>Message {index + 1} · system prompt</summary>
							<RawInferenceSubmissionMessageView position={index + 1} message={message} />
						</details>
					) : (
						<RawInferenceSubmissionMessageView key={index} position={index + 1} message={message} />
					),
				)}
			<details>
				<summary>Exact request body</summary>
				<pre>{body}</pre>
			</details>
		</>
	);
}

export function attemptRequestMetadata(_attempt: AgentLogAttempt | undefined): ReactNode {
	// R8 will supply usage, attribution, and messages after the runtime rebase.
	return null;
}

export function AgentLogRequestDetails({ request }: { request: AgentLogRequest }) {
	const selected = request.attempts.find((attempt) => attempt.outcome?.kind === 'success') ?? request.attempts.at(-1);
	const response = selected?.outcome?.kind === 'success' || selected?.outcome?.kind === 'interrupted' ? selected.outcome.response : null;
	return (
		<div className="submission-chat-log">
			{attemptRequestMetadata(selected) ??
				(selected?.body ? <StoredRequestBody body={selected.body} /> : <p>The exact request is not retained.</p>)}
			{response ? (
				<SubmissionJsonBlock label="Response" value={response} />
			) : selected?.partialResponse ? (
				<SubmissionJsonBlock label="Partial response" value={selected.partialResponse} />
			) : (
				<p>No response yet.</p>
			)}
			{request.attempts.length > 1 && (
				<section>
					<h3>Earlier attempts</h3>
					{request.attempts
						.filter((attempt) => attempt !== selected)
						.map((attempt) => (
							<AttemptDetails key={attempt.id} attempt={attempt} number={request.attempts.indexOf(attempt) + 1} />
						))}
				</section>
			)}
		</div>
	);
}

export function AgentLogRequestModal({
	request,
	errors,
	onClose,
}: {
	request: AgentLogRequest | null;
	errors: boolean;
	onClose: () => void;
}) {
	return (
		request && (
			<Modal
				className="submission-modal agent-log-modal"
				open
				onClose={onClose}
				title={errors ? 'Request attempts' : 'Inference request'}
				wide
			>
				{errors ? <AgentLogAttempts request={request} /> : <AgentLogRequestDetails request={request} />}
			</Modal>
		)
	);
}

export function AgentLogSessionModal({ session, onClose }: { session: AgentLogCompactionSession | null; onClose: () => void }) {
	if (!session) return null;
	const outcome = session.outcome;
	const success = outcome.kind === 'succeeded';
	return (
		<Modal className="submission-modal agent-log-modal" open onClose={onClose} title="Compaction session log" wide>
			<p>
				<TimeAgoLabel value={session.createdAt} /> · {session.trigger.kind} · {session.requests.length} calls
			</p>
			{session.requests.map((request, index) => (
				<details key={request.id} className="agent-log-session-call">
					<summary>
						Call {index + 1} · {request.attempts.length} attempts · {request.state}
					</summary>
					<AgentLogAttempts request={request} />
					<AgentLogRequestDetails request={request} />
				</details>
			))}
			<p className={success ? 'agent-log-success' : outcome.kind === 'pending' ? '' : 'agent-log-error'}>
				{success
					? 'Compaction succeeded'
					: outcome.kind === 'partial'
						? `Compaction partly succeeded · ${outcome.failedBatchCount} ${outcome.failedBatchCount === 1 ? 'batch' : 'batches'} failed`
						: outcome.kind === 'failed'
							? 'Compaction failed'
							: outcome.kind === 'pending'
								? 'Compaction in progress'
								: 'Unknown compaction outcome'}
			</p>
			{(outcome.kind === 'failed' || outcome.kind === 'partial') && (
				<>
					<p>{attemptCause(outcome.error)}</p>
					<SubmissionJsonBlock label="Failure" value={outcome.error} />
				</>
			)}
		</Modal>
	);
}
