import type { AgentLogAttempt, AgentLogAttemptOutcome, AgentLogCompactionSession, AgentLogRequest } from '@bickr/shared/model';
import type { ReactNode } from 'react';
import { InferenceAttributionFields } from '../../components/inference-attribution';
import { TimeAgoLabel } from '../../components/record-display';
import { Modal } from '../../ui';
import { RawInferenceSubmissionMessageView, LoopMessageRequestUsageLine, SubmissionJsonBlock } from './loop-log-formatting';

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
			{attemptRequestMetadata(attempt)}
			<AttemptResponse attempt={attempt} />
		</details>
	);
}

export function AgentLogAttempts({ request }: { request: AgentLogRequest }) {
	const succeeded = request.attempts.findIndex((attempt) => attempt.outcome?.kind === 'success');
	return (
		<div className="agent-log-attempts">
			{request.attempts.map((attempt, index) => (
				<AttemptDetails key={attempt.id} attempt={attempt} number={index + 1} />
			))}
			<p className={request.state === 'succeeded' ? 'agent-log-success' : request.state === 'failed' ? 'agent-log-error' : ''}>
				{request.state === 'succeeded'
					? succeeded >= 0
						? `Attempt ${succeeded + 1} succeeded`
						: 'Request succeeded'
					: request.state === 'failed'
						? `Gave up after ${request.attempts.length} ${request.attempts.length === 1 ? 'attempt' : 'attempts'}`
						: request.state === 'pending'
							? 'Request in progress'
							: 'Unknown request state'}
			</p>
		</div>
	);
}

export function attemptRequestMetadata(attempt: AgentLogAttempt | undefined): ReactNode {
	if (!attempt) return null;
	return (
		<>
			{attempt.usage && <LoopMessageRequestUsageLine usage={attempt.usage} />}
			{attempt.attribution && <InferenceAttributionFields attribution={attempt.attribution} />}
			{attempt.messages.map((item) =>
				item.message.role === 'system' ? (
					<details key={item.position}>
						<summary>Message {item.position} · system prompt</summary>
						<RawInferenceSubmissionMessageView position={item.position} message={item.message} cacheStatus={item.cacheStatus} />
					</details>
				) : (
					<RawInferenceSubmissionMessageView
						key={item.position}
						position={item.position}
						message={item.message}
						cacheStatus={item.cacheStatus}
					/>
				),
			)}
			{attempt.body === null ? (
				<p>The exact request is not retained.</p>
			) : attempt.messages.length === 0 ? (
				<SubmissionJsonBlock label="Request as sent" value={attempt.body} />
			) : (
				<details>
					<summary>Exact request body</summary>
					<pre>{attempt.body}</pre>
				</details>
			)}
		</>
	);
}

function AttemptResponse({ attempt }: { attempt: AgentLogAttempt }) {
	const response = attempt.outcome?.kind === 'success' || attempt.outcome?.kind === 'interrupted' ? attempt.outcome.response : null;
	return response ? (
		<SubmissionJsonBlock label="Response" value={response} />
	) : attempt.partialResponse ? (
		<SubmissionJsonBlock label="Partial response" value={attempt.partialResponse} />
	) : null;
}

export function AgentLogRequestDetails({ request }: { request: AgentLogRequest }) {
	const selected =
		request.attempts.find((attempt) => attempt.outcome?.kind === 'success') ??
		request.attempts.findLast((attempt) => attempt.outcome === null);
	if (!selected)
		return (
			<div className="submission-chat-log">
				{request.attempts.length === 0 && <p>The exact request is not retained.</p>}
				<AgentLogAttempts request={request} />
			</div>
		);
	return (
		<div className="submission-chat-log">
			{attemptRequestMetadata(selected)}
			<AttemptResponse attempt={selected} />
			{selected.outcome === null && !selected.partialResponse && <p>No response yet.</p>}
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
				<TimeAgoLabel value={session.createdAt} /> · {session.trigger.kind} · {session.requests.length}{' '}
				{session.requests.length === 1 ? 'call' : 'calls'}
			</p>
			{session.requests.map((request, index) => (
				<details key={request.id} className="agent-log-session-call">
					<summary>
						Call {index + 1} · {request.attempts.length} {request.attempts.length === 1 ? 'attempt' : 'attempts'} · {request.state}
					</summary>
					<AgentLogAttempts request={request} />
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
