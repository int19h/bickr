import { attemptAttribution, attemptMessages, attemptUsage, type AttemptUsageRow } from './agent-log-attempt-details';
import { agentLogReasoningDetailKey, type AgentLogPartialResponse, type AgentLogStreamDelta, type AgentLogReasoningPart, type InferenceAttribution } from '@bickr/shared/model';
import { logAttemptOutcome, readLogAttemptOutcome, readLogAttemptKind, readLogCompactionOutcome, logAuthor, logCompactionOutcome, logToolDelta, logTrigger, logPartial, logStreamDelta, storedLogValue } from './agent-log-codecs';
import { runtimeStorageClearedStateKey } from '../constants';
import { assertExecutionPublication } from './execution-scope';
import { agentLogAuthor, type AgentLogAuthor, type AgentLogAttempt, type AgentLogAttemptOutcome, type AgentLogAttemptSummary, type AgentLogCompactionOutcome, type AgentLogCompactionSession, type AgentLogCompactionTrigger, type AgentLogEntry, type AgentLogFailure, type AgentLogRequest, type AgentLogSource, type AgentLogRequestSummary, type BotLoopMessage } from '@bickr/shared/model';
import { loopMessageContributesToProviderHistory } from '../provider/sanitize';
import { RepositoryError } from '@bickr/shared/repository';
import { InputError } from '@bickr/shared/validation';
import { ProviderTransportError } from '@bickr/shared/provider-transport';
import {
	CompactionReasoningRefusalError, CompactionSummaryMissingError, PersistentCompactionReductionFailureError,
	PromptContextBudgetExceededError, PromptContextCompactionLimitError,
	ProviderCompactionOutputLimitError, ProviderCompactionRequestError, ProviderEmptyResponseError,
	ProviderLoopRequestError, ProviderRequestError, ProviderRequestTimeoutError,
	ProviderResponseBodyTimeoutError, ProviderResponseInterruptedError, ProviderStreamIdleTimeoutError,
	ProviderStreamIncompleteError, ProviderStructuredOutputValidationError, ResponseBodySizeLimitError,
	RuntimeOperationTimeoutError, TickStoppedError,
} from '../errors';
import type { RuntimeStorage, RuntimeMessageStore } from './message-store';

// Requests, attempts, and body chunks stay for the newest three pages.
// Beyond those pages, a bounded alarm sweep removes them after seven days.
// Successful and partly successful sessions share their summaries' lifetime.
// Failed sessions share their page's lifetime.
export const agentLogSchema = `
CREATE TABLE IF NOT EXISTS inference_requests (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event_seq INTEGER NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('loop', 'compaction')), state TEXT NOT NULL CHECK(state IN ('pending', 'succeeded', 'failed')), position REAL NOT NULL,
 anchor_seq INTEGER, message_seq INTEGER, session_id TEXT, created_at TEXT NOT NULL,
 UNIQUE(run_id, event_seq)
);
CREATE INDEX IF NOT EXISTS inference_requests_anchor ON inference_requests(anchor_seq, position);
CREATE INDEX IF NOT EXISTS inference_requests_age ON inference_requests(created_at, id);
CREATE INDEX IF NOT EXISTS inference_requests_session ON inference_requests(session_id, created_at);
CREATE TABLE IF NOT EXISTS inference_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, event_seq INTEGER NOT NULL, started_at TEXT NOT NULL,
 -- These nullable fields share attempt retention. A removed usage row resolves to null.
 usage_id INTEGER, attribution_json TEXT,
 outcome_json TEXT, partial_response TEXT, base_id INTEGER, prefix_length INTEGER NOT NULL DEFAULT 0,
 CHECK(base_id IS NULL OR base_id < id)
);
CREATE INDEX IF NOT EXISTS inference_attempts_request ON inference_attempts(request_id, id);
CREATE INDEX IF NOT EXISTS inference_attempts_event ON inference_attempts(event_seq, id);
CREATE INDEX IF NOT EXISTS inference_attempts_base ON inference_attempts(base_id, id);
CREATE TABLE IF NOT EXISTS inference_body_chunks (
 attempt_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('body', 'outcome', 'partial')), chunk_index INTEGER NOT NULL, text TEXT NOT NULL,
 PRIMARY KEY(attempt_id, kind, chunk_index)
);
CREATE TABLE IF NOT EXISTS compaction_sessions (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, trigger_json TEXT NOT NULL,
 position REAL NOT NULL, anchor_seq INTEGER, outcome_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS compaction_sessions_anchor ON compaction_sessions(anchor_seq, position);
CREATE INDEX IF NOT EXISTS compaction_sessions_age ON compaction_sessions(created_at, id);
`;

type RequestRow = { id: string; run_id: string; event_seq: number; purpose: AgentLogRequest['purpose']; state: AgentLogRequest['state']; position: number; anchor_seq: number | null; message_seq: number | null; session_id: string | null; created_at: string };
type AttemptRow = { usage_id: number | null; attribution_json: string | null; event_seq: number; id: number; request_id: string; started_at: string; outcome_json: string | null; partial_response: string | null; base_id: number | null; prefix_length: number };
type SessionRow = { id: string; run_id: string; trigger_json: string; position: number; anchor_seq: number | null; outcome_json: string; created_at: string };
const chunkLength = 64_000;
export const agentLogDeltaDepthLimit = 16;
const partialFlushBytes = 4_096;
const partialFlushMs = 1_000;
type PartialText = AgentLogPartialResponse;
type LiveAttempt = { requestId: string; attemptId: number; text: PartialText; reasoningSlots: Map<string, number>; unflushedBytes: number; flushedAt: number; revision: number };

// SQLite encodes strings as UTF-8. Keep both halves of each surrogate pair together.
function textBoundary(text: string, offset: number): number {
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? offset - 1 : offset;
}

export function agentLogFailure(error: unknown): AgentLogFailure {
	if (error instanceof ProviderCompactionRequestError || error instanceof ProviderLoopRequestError) return agentLogFailure(error.originalError);
	if (error instanceof ProviderTransportError) {
		return error.kind === 'connection' || error.kind === 'redirect'
			? { kind: 'provider_error', status: null, errorType: error.kind, message: error.message }
			: { kind: 'validation', issue: error.kind, message: error.message };
	}
	if (error instanceof CompactionSummaryMissingError) return { kind: 'validation', issue: error.kind, message: error.message };
	if (error instanceof PersistentCompactionReductionFailureError) return { kind: 'validation', issue: 'non_reducing_compaction', message: error.message };
	if (error instanceof ProviderStructuredOutputValidationError) return { kind: 'validation', issue: error.validationIssue ?? null, message: error.message };
	if (error instanceof CompactionReasoningRefusalError) return { kind: 'validation', issue: error.refusal.kind, message: error.message };
	if (error instanceof PromptContextBudgetExceededError || error instanceof PromptContextCompactionLimitError || error instanceof ProviderCompactionOutputLimitError || error instanceof ProviderEmptyResponseError) return { kind: 'validation', issue: error.kind, message: error.message };
	if (error instanceof ResponseBodySizeLimitError) return { kind: 'validation', issue: 'response_body_size_limit', message: error.message };
	if (error instanceof InputError) return { kind: 'validation', issue: null, message: error.message };
	if (error instanceof RepositoryError && error.code === 'bad_request') return { kind: 'validation', issue: error.code, message: error.message };
	if (error instanceof ProviderRequestTimeoutError || error instanceof ProviderResponseBodyTimeoutError || error instanceof ProviderStreamIdleTimeoutError || error instanceof RuntimeOperationTimeoutError) return { kind: 'timeout' };
	if (error instanceof ProviderResponseInterruptedError || error instanceof ProviderStreamIncompleteError || error instanceof TickStoppedError || (error instanceof Error && error.name === 'AbortError')) return { kind: 'interrupted' };
	if (error instanceof ProviderRequestError) return { kind: 'provider_error', status: error.status, errorType: error.providerError?.errorType ?? null, message: error.message };
	return { kind: 'runtime_error', message: error instanceof Error ? error.message : String(error) };
}

// Retention: one unfinished response per participant. History writes or recovery
// remove this marker. History erasure and full storage erasure remove it too.
const responsePublicationKey = 'pending_response_v1';
export type ResponsePublication = { kind: 'provider_response'; runId: string; requestId: string; eventSeq: number; attemptId: number; assistantSeq: number | null; pendingCallIds: string[] };

export class AgentLogStore {
	private readonly storage: RuntimeStorage;
	private readonly liveAttempts = new Map<string, LiveAttempt>();
	private readonly assertWritable: () => void;
	constructor(storage: RuntimeStorage, assertWritable: () => void = () => {}) { this.storage = storage; this.assertWritable = assertWritable; }

	assertCanWrite(): void {
		assertExecutionPublication();
		this.assertWritable();
		const cleared = this.storage.sql.exec<{ value_json: string }>('SELECT value_json FROM runtime_state WHERE key = ? LIMIT 1', runtimeStorageClearedStateKey).toArray()[0];
		if (cleared && JSON.parse(cleared.value_json)) throw new RepositoryError('conflict', 'This runtime storage was erased and cannot accept new activity.', 409);
	}

	initialize(): void {
		for (const statement of agentLogSchema.split(';')) if (statement.trim()) this.storage.sql.exec(statement);
		const attemptColumns = new Set(this.storage.sql.exec<{ name: string }>('PRAGMA table_info(inference_attempts)').toArray().map(row => row.name));
		for (const [name, type] of [['usage_id', 'INTEGER'], ['attribution_json', 'TEXT']] as const) if (!attemptColumns.has(name)) this.storage.sql.exec(`ALTER TABLE inference_attempts ADD COLUMN ${name} ${type}`);
		this.storage.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS inference_attempts_usage ON inference_attempts(usage_id)');
		const columns = new Set(this.storage.sql.exec<{ name: string }>('PRAGMA table_info(loop_messages)').toArray().map(row => row.name));
		// These columns share the retention of their loop row.
		for (const name of ['author_json', 'request_id', 'session_id']) if (!columns.has(name)) this.storage.sql.exec(`ALTER TABLE loop_messages ADD COLUMN ${name} TEXT`);
		this.storage.sql.exec('CREATE INDEX IF NOT EXISTS loop_messages_agent_request ON loop_messages(request_id, seq)');
		this.storage.sql.exec('CREATE INDEX IF NOT EXISTS loop_messages_agent_session ON loop_messages(session_id, seq)');
		this.storage.sql.exec('CREATE INDEX IF NOT EXISTS loop_messages_agent_author ON loop_messages(author_json, seq)');
	}

	begin(input: { runId: string; eventSeq: number; purpose: AgentLogRequest['purpose']; sessionId?: string; createdAt?: string; existingId?: string }): string {
		this.assertCanWrite();
		if (input.existingId) {
			this.storage.sql.exec("UPDATE inference_requests SET event_seq = ?, state = 'pending' WHERE id = ? AND run_id = ?", input.eventSeq, input.existingId, input.runId);
			return input.existingId;
		}
		const existing = this.byEvent(input.runId, input.eventSeq);
		if (existing) return existing.id;
		const anchor = this.anchor();
		const id = crypto.randomUUID();
		this.storage.sql.exec(`INSERT INTO inference_requests(id, run_id, event_seq, purpose, state, position, anchor_seq, session_id, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`, id, input.runId, input.eventSeq, input.purpose, anchor.position + 0.5, anchor.seq, input.sessionId ?? null, input.createdAt ?? new Date().toISOString());
		return id;
	}

	byEvent(runId: string, eventSeq: number): RequestRow | undefined {
		return this.storage.sql.exec<RequestRow>('SELECT * FROM inference_requests WHERE run_id = ? AND event_seq = ? LIMIT 1', runId, eventSeq).toArray()[0];
	}

	startAttempt(requestId: string, body: string, startedAt = new Date().toISOString()): number {
		this.assertCanWrite();
		return this.storage.transactionSync(() => {
			const base = this.storage.sql.exec<AttemptRow>('SELECT * FROM inference_attempts ORDER BY id DESC LIMIT 1').toArray()[0];
			const baseText = base && this.deltaDepth(base.id) < agentLogDeltaDepthLimit ? this.body(base.id) : null;
			let prefix = 0;
			if (baseText !== null) while (prefix < body.length && prefix < baseText.length && body[prefix] === baseText[prefix]) prefix++;
			prefix = textBoundary(body, prefix);
			const useBase = base && baseText !== null && prefix > 64;
			const attempt = this.storage.sql.exec<{ id: number }>(`INSERT INTO inference_attempts(request_id, event_seq, started_at, base_id, prefix_length) VALUES (?, (SELECT event_seq FROM inference_requests WHERE id = ?), ?, ?, ?) RETURNING id`, requestId, requestId, startedAt, useBase ? base.id : null, useBase ? prefix : 0).one().id;
			this.writeChunks(attempt, useBase ? body.slice(prefix) : body);
			this.storage.sql.exec("UPDATE inference_requests SET state = 'pending' WHERE id = ?", requestId);
			const request = this.storage.sql.exec<RequestRow>('SELECT * FROM inference_requests WHERE id = ? LIMIT 1', requestId).one();
			this.liveAttempts.set(JSON.stringify([request.run_id, request.event_seq]), { requestId, attemptId: attempt, text: { content: '', reasoning: '', reasoningParts: [], toolCalls: [] }, reasoningSlots: new Map(), unflushedBytes: 0, flushedAt: Date.now(), revision: 0 });
			return attempt;
		});
	}

	private writeChunks(attemptId: number, text: string, kind: 'body' | 'outcome' | 'partial' = 'body'): void {
		this.storage.sql.exec('DELETE FROM inference_body_chunks WHERE attempt_id = ? AND kind = ?', attemptId, kind);
		let index = 0;
		for (let offset = 0; offset < text.length;) {
			const end = textBoundary(text, Math.min(text.length, offset + chunkLength));
			this.storage.sql.exec('INSERT INTO inference_body_chunks(attempt_id, kind, chunk_index, text) VALUES (?, ?, ?, ?)', attemptId, kind, index++, text.slice(offset, end));
			offset = end;
		}
	}

	private deltaDepth(id: number): number {
		let next: number | null = id;
		let depth = 0;
		while (next !== null && depth < agentLogDeltaDepthLimit) {
			const row: { base_id: number | null } | undefined = this.storage.sql.exec<{ base_id: number | null }>('SELECT base_id FROM inference_attempts WHERE id = ? LIMIT 1', next).toArray()[0];
			next = row?.base_id ?? null;
			if (next !== null) depth++;
		}
		return depth;
	}

	body(id: number): string | null {
		const chain: AttemptRow[] = [];
		let next: number | null = id;
		while (next !== null) {
			if (chain.length && next >= chain[chain.length - 1]!.id) throw new Error('The request body chain is invalid.');
			const row: AttemptRow | undefined = this.storage.sql.exec<AttemptRow>('SELECT * FROM inference_attempts WHERE id = ? LIMIT 1', next).toArray()[0];
			if (!row) return null;
			chain.push(row);
			next = row.base_id;
		}
		let text = '';
		for (const row of chain.reverse()) {
			const suffix = this.readChunks(row.id, 'body');
			text = text.slice(0, row.prefix_length) + suffix;
		}
		return text;
	}

	settle(attemptId: number, outcome: AgentLogAttemptOutcome): void {
		this.assertCanWrite();
		this.storage.transactionSync(() => {
			if (!this.storage.sql.exec('SELECT id FROM inference_attempts WHERE id = ? LIMIT 1', attemptId).toArray().length) throw new RepositoryError('not_found', 'The inference attempt is not retained.', 404);
			this.flushAttempt(attemptId);
			this.writeChunks(attemptId, JSON.stringify(logAttemptOutcome(outcome)), 'outcome');
			this.storage.sql.exec('UPDATE inference_attempts SET outcome_json = ? WHERE id = ?', JSON.stringify({ kind: outcome.kind }), attemptId);
			this.forgetAttempt(attemptId);
		});
	}

	linkUsage(attemptId: number, usageId: number): void {
		this.assertCanWrite();
		const updated = this.storage.sql.exec(`UPDATE inference_attempts SET usage_id = ?
		 WHERE id = ? AND (usage_id IS NULL OR usage_id = ?)
		 AND NOT EXISTS (SELECT 1 FROM inference_attempts owned WHERE owned.usage_id = ? AND owned.id != ?)
		 AND EXISTS (SELECT 1 FROM provider_usage u JOIN inference_requests r ON r.id = inference_attempts.request_id
		 WHERE u.id = ? AND u.run_id = r.run_id AND u.request_seq = inference_attempts.event_seq AND r.state = 'pending')
		 RETURNING id`, usageId, attemptId, usageId, usageId, attemptId, usageId).toArray();
		if (updated.length !== 1) throw new RepositoryError('conflict', 'The usage row does not belong to this inference attempt.', 409);
	}

	recordAttribution(attemptId: number, attribution: InferenceAttribution | undefined): void {
		this.assertCanWrite();
		const projected = attemptAttribution(attribution);
		const updated = this.storage.sql.exec(`UPDATE inference_attempts SET attribution_json = ? WHERE id = ?
		 AND (? IS NULL OR (event_seq = ? AND EXISTS (SELECT 1 FROM inference_requests r WHERE r.id = inference_attempts.request_id AND r.run_id = ?))) RETURNING id`,
		 projected ? JSON.stringify(projected) : null, attemptId, projected?.source.runId ?? null, projected?.source.requestSeq ?? null, projected?.source.runId ?? null).toArray();
		if (updated.length !== 1) throw new RepositoryError('conflict', 'The attribution does not belong to this inference attempt.', 409);
	}

	stageResponsePublication(publication: ResponsePublication): void {
		this.assertCanWrite();
		const current = this.storage.sql.exec<{ value_json: string }>('SELECT value_json FROM runtime_state WHERE key = ? LIMIT 1', responsePublicationKey).toArray()[0];
		if (current && (JSON.parse(current.value_json) as ResponsePublication).requestId !== publication.requestId) throw new RepositoryError('conflict', 'The previous response still needs a history row.', 409);
		this.storage.sql.exec('INSERT INTO runtime_state(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', responsePublicationKey, JSON.stringify(publication));
	}

	responsePublication(runId: string): ResponsePublication | null {
		const row = this.storage.sql.exec<{ value_json: string }>("SELECT value_json FROM runtime_state WHERE key = ? AND json_extract(value_json, '$.runId') = ? LIMIT 1", responsePublicationKey, runId).toArray()[0];
		if (!row) return null;
		const value = JSON.parse(row.value_json) as ResponsePublication;
		if (value.kind !== 'provider_response') throw new RepositoryError('conflict', 'The pending response has an unsupported kind.', 409);
		return value;
	}

	completeResponsePublication(runId: string, assistantSeq: number | null, callIds: string[]): void {
		this.assertCanWrite();
		const publication = this.responsePublication(runId);
		if (!publication) return;
		publication.assistantSeq = assistantSeq ?? publication.assistantSeq;
		publication.pendingCallIds = publication.pendingCallIds.filter(id => !callIds.includes(id));
		if (publication.assistantSeq !== null && publication.pendingCallIds.length === 0) this.discardResponsePublication(runId);
		else this.stageResponsePublication(publication);
	}

	discardResponsePublication(runId: string): void {
		this.assertCanWrite();
		this.storage.sql.exec("DELETE FROM runtime_state WHERE key = ? AND json_extract(value_json, '$.runId') = ?", responsePublicationKey, runId);
	}

	completedResponse(attemptId: number): string {
		const row = this.storage.sql.exec<{ outcome_json: string | null }>('SELECT outcome_json FROM inference_attempts WHERE id = ? LIMIT 1', attemptId).toArray()[0];
		const outcome = row && row.outcome_json !== null ? this.outcome(attemptId, row.outcome_json) : null;
		if (outcome?.kind === 'success') return outcome.response;
		if (outcome?.kind === 'interrupted' && outcome.response !== undefined) return outcome.response;
		throw new RepositoryError('conflict', 'The completed response is not retained.', 409);
	}

	finish(requestId: string, state: 'succeeded' | 'failed'): void {
		this.assertCanWrite();
		this.storage.sql.exec('UPDATE inference_requests SET state = ? WHERE id = ?', state, requestId);
	}

	latestAttempt(requestId: string): number | null {
		return this.storage.sql.exec<{ id: number }>('SELECT id FROM inference_attempts WHERE request_id = ? ORDER BY id DESC LIMIT 1', requestId).toArray()[0]?.id ?? null;
	}

	partial(runId: string, eventSeq: number, delta: AgentLogStreamDelta): string | null {
		this.assertCanWrite();
		const payload = logStreamDelta(delta);
		const live = this.liveAttempts.get(JSON.stringify([runId, eventSeq]));
		if (!live) return null;
		live.revision++;
		let added = '';
		if (payload.kind === 'content' && typeof payload.text === 'string') {
			live.text.content += payload.text;
			added = payload.text;
		}
		if (payload.kind === 'reasoning') {
			const part: AgentLogReasoningPart = payload.source === 'plain' ? { kind: 'text', text: payload.text } : payload.part;
			if (part.kind === 'text') live.text.reasoning += part.text;
			const key = part.kind === 'text' ? null : agentLogReasoningDetailKey(part);
			const slot = key === null ? undefined : live.reasoningSlots.get(key);
			const last = live.text.reasoningParts.at(-1);
			const previous = part.kind === 'text' && last?.kind === 'text' ? last : slot === undefined ? undefined : live.text.reasoningParts[slot];
			if (previous?.kind === 'text' && part.kind === 'text') {
				previous.text += part.text;
				added = part.text;
			} else if (previous?.kind === 'readable' && part.kind === 'readable') {
				previous.text += part.text;
				if (part.id !== undefined) previous.id = part.id;
				added = part.text;
			} else if (previous === undefined) {
				if (key !== null) live.reasoningSlots.set(key, live.text.reasoningParts.length);
				live.text.reasoningParts.push(part);
				added = JSON.stringify(part);
			}
		}
		if (payload.kind === 'tool_call') {
			const part = logToolDelta(payload.part);
			live.text.toolCalls.push(part);
			added = JSON.stringify(part);
		}
		live.unflushedBytes += new TextEncoder().encode(added).byteLength;
		if (live.unflushedBytes >= partialFlushBytes || Date.now() - live.flushedAt >= partialFlushMs) this.flushAttempt(live.attemptId);
		return live.requestId;
	}

	streamState(runId: string, eventSeq: number): { kind: 'stream'; attemptId: number; revision: number } | { kind: 'none' } {
		const live = this.liveAttempts.get(JSON.stringify([runId, eventSeq]));
		return live ? { kind: 'stream', attemptId: live.attemptId, revision: live.revision } : { kind: 'none' };
	}

	private flushAttempt(id: number): void {
		const live = [...this.liveAttempts.values()].find(attempt => attempt.attemptId === id);
		if (!live || !live.unflushedBytes) return;
		this.storage.transactionSync(() => {
			this.writeChunks(id, JSON.stringify(live.text), 'partial');
			this.storage.sql.exec("UPDATE inference_attempts SET partial_response = 'retained' WHERE id = ? AND outcome_json IS NULL", id);
		});
		live.unflushedBytes = 0;
		live.flushedAt = Date.now();
	}

	private forgetAttempt(id: number): void {
		for (const [key, live] of this.liveAttempts) if (live.attemptId === id) this.liveAttempts.delete(key);
	}

	private partialText(id: number, retained: string | null, stored?: string): string | null {
		const live = [...this.liveAttempts.values()].find(attempt => attempt.attemptId === id);
		if (live && (live.unflushedBytes || retained)) return JSON.stringify(live.text);
		return retained ? JSON.stringify(logPartial(storedLogValue(stored ?? this.readChunks(id, 'partial')))) : null;
	}

	request(id: string): AgentLogRequest {
		const row = this.storage.sql.exec<RequestRow>('SELECT * FROM inference_requests WHERE id = ? LIMIT 1', id).toArray()[0];
		if (!row) throw new RepositoryError('not_found', 'The inference request is not retained.', 404);
		const rows = this.storage.sql.exec<AttemptRow>('SELECT * FROM inference_attempts WHERE request_id = ? ORDER BY id LIMIT 1000', id).toArray();
		const usageRows = rows.some(attempt => attempt.usage_id !== null) ? this.storage.sql.exec<AttemptUsageRow & { id: number }>(
			`SELECT u.id, u.prompt_tokens, u.cached_tokens, u.completion_tokens, u.total_tokens, u.cost, u.usage_json
			 FROM inference_attempts a JOIN provider_usage u ON u.id = a.usage_id AND u.request_seq = a.event_seq
			 JOIN inference_requests r ON r.id = a.request_id AND r.run_id = u.run_id
			 WHERE a.request_id = ? ORDER BY a.id LIMIT 1000`, id,
		).toArray() : [];
		const usages = new Map(usageRows.map(usage => [usage.id, usage]));
		const attempts = rows.map((attempt): AgentLogAttempt => {
			const body = this.body(attempt.id);
			const usageRow = attempt.usage_id === null ? undefined : usages.get(attempt.usage_id);
			const usage = usageRow ? attemptUsage(usageRow) : null;
			return { id: attempt.id, startedAt: attempt.started_at, body, usage, attribution: attemptAttribution(attempt.attribution_json ? storedLogValue(attempt.attribution_json) : null), messages: attemptMessages(body, usage), partialResponse: this.partialText(attempt.id, attempt.partial_response), outcome: attempt.outcome_json !== null ? this.outcome(attempt.id, attempt.outcome_json) : null };
		});
		return { id: row.id, runId: row.run_id, purpose: row.purpose, state: row.state, createdAt: row.created_at, messageSeq: row.message_seq, sessionId: row.session_id, attempts };
	}

	// A new object instance cannot retain a network call from its previous instance.
	recoverInterrupted(): void {
		this.assertCanWrite();
		this.storage.transactionSync(() => {
			for (const row of this.storage.sql.exec<{ run_id: string }>("SELECT DISTINCT run_id FROM inference_requests WHERE state = 'pending' LIMIT 100").toArray()) this.failPending(row.run_id, { kind: 'interrupted' });
			for (const row of this.storage.sql.exec<{ id: string }>("SELECT id FROM compaction_sessions WHERE CASE WHEN json_valid(outcome_json) THEN json_extract(outcome_json, '$.kind') END = 'pending' ORDER BY created_at LIMIT 100").toArray()) this.settleSession(row.id, { kind: 'failed', error: { kind: 'interrupted' } });
		});
	}

	clear(): void {
		this.assertCanWrite();
		this.storage.transactionSync(() => {
			this.liveAttempts.clear();
			this.storage.sql.exec('DELETE FROM runtime_state WHERE key = ?', responsePublicationKey);
			for (const table of ['inference_body_chunks', 'inference_attempts', 'inference_requests', 'compaction_sessions']) this.storage.sql.exec(`DELETE FROM ${table}`);
		});
	}

	migrationStatus(): { partialReasoningPending: boolean; authorsPending: boolean; requestsPending: boolean; legacySubmissionsRemain: boolean; legacyAuthorsRemain: boolean; legacyPendingRequestsRemain: boolean } {
		return {
			partialReasoningPending: !this.migrationDone('agent_log_partial_reasoning_v1'),
			authorsPending: !this.migrationDone('agent_log_authors_v1'),
			requestsPending: !this.migrationDone('agent_log_request_store_v1'),
			legacySubmissionsRemain: this.storage.sql.exec('SELECT id FROM inference_submissions LIMIT 1').toArray().length > 0,
			legacyPendingRequestsRemain: this.storage.sql.exec("SELECT key FROM runtime_state WHERE key IN ('pending_tool_v1', 'pending_tool_v2', 'pending_tool_v3') AND (key != 'pending_tool_v3' OR json_extract(value_json, '$.requestId') IS NULL OR json_extract(value_json, '$.requestEventSeq') IS NULL) LIMIT 1").toArray().length > 0,
			legacyAuthorsRemain: this.storage.sql.exec(`SELECT seq FROM loop_messages WHERE author_json = ? LIMIT 1`, JSON.stringify({ kind: 'legacy_synthetic' })).toArray().length > 0,
		};
	}

	requestForMessage(seq: number): AgentLogRequest | null {
		const row = this.storage.sql.exec<{ id: string }>('SELECT r.id FROM inference_requests r JOIN loop_messages m ON m.request_id = r.id WHERE m.seq = ? LIMIT 1', seq).toArray()[0];
		return row ? this.request(row.id) : null;
	}

	list(): AgentLogRequestSummary[] {
		const rows = this.storage.sql.exec<RequestRow>('SELECT * FROM inference_requests ORDER BY created_at DESC, id LIMIT 100').toArray();
		const summaries = this.summaries(rows.map(row => row.id));
		return rows.map(row => ({ id: row.id, runId: row.run_id, purpose: row.purpose, state: row.state, createdAt: row.created_at, messageSeq: row.message_seq, sessionId: row.session_id, attempts: summaries.get(row.id) ?? { count: 0, failures: [] } }));
	}

	private readChunks(id: number, kind: 'body' | 'outcome' | 'partial'): string {
		return this.storage.sql.exec<{ text: string }>('SELECT text FROM inference_body_chunks WHERE attempt_id = ? AND kind = ? ORDER BY chunk_index LIMIT 10000', id, kind).toArray().map(chunk => chunk.text).join('');
	}

	private outcome(id: number, metadata: string): AgentLogAttemptOutcome {
		return readLogAttemptOutcome(this.readChunks(id, 'outcome') || metadata);
	}

	summary(requestId: string): AgentLogAttemptSummary {
		return this.summaries([requestId]).get(requestId) ?? { count: 0, failures: [] };
	}

	private chunkTexts(ids: number[], kind: 'outcome' | 'partial'): Map<number, string> {
		const texts = new Map<number, string>();
		if (!ids.length) return texts;
		for (const chunk of this.storage.sql.exec<{ attempt_id: number; text: string }>(`SELECT attempt_id, text FROM inference_body_chunks WHERE attempt_id IN (SELECT value FROM json_each(?)) AND kind = ? ORDER BY attempt_id, chunk_index`, JSON.stringify(ids), kind).toArray()) texts.set(chunk.attempt_id, (texts.get(chunk.attempt_id) ?? '') + chunk.text);
		return texts;
	}

	private summaries(requestIds: string[]): Map<string, AgentLogAttemptSummary> {
		const summaries = new Map<string, AgentLogAttemptSummary>();
		if (!requestIds.length) return summaries;
		// One JSON parameter keeps the page below SQLite's bound-parameter limit.
		const attempts = this.storage.sql.exec<Pick<AttemptRow, 'id' | 'outcome_json'> & { request_id: string }>(`SELECT id, request_id, outcome_json FROM inference_attempts WHERE request_id IN (SELECT value FROM json_each(?)) ORDER BY request_id, id`, JSON.stringify(requestIds)).toArray();
		const failed = attempts.filter(row => row.outcome_json !== null && readLogAttemptKind(row.outcome_json) !== 'success');
		const texts = this.chunkTexts(failed.map(row => row.id), 'outcome');
		for (const row of attempts) {
			const summary: AgentLogAttemptSummary = summaries.get(row.request_id) ?? { count: 0, failures: [] };
			summary.count++;
			summaries.set(row.request_id, summary);
		}
		for (const row of failed) {
			const outcome = readLogAttemptOutcome(texts.get(row.id) ?? row.outcome_json!);
			if (outcome.kind !== 'success') summaries.get(row.request_id)!.failures.push({ attemptId: row.id, outcome });
		}
		return summaries;
	}

	link(messageSeq: number, runId: string, eventSeq: number | undefined, origin: string): void {
		this.assertCanWrite();
		if (eventSeq === undefined) return;
		const request = this.byEvent(runId, eventSeq);
		if (!request) return;
		this.linkRequest(messageSeq, runId, request.id, origin);
	}

	linkRequest(messageSeq: number, runId: string, requestId: string, origin: string): void {
		this.assertCanWrite();
		const request = this.storage.sql.exec<RequestRow>('SELECT * FROM inference_requests WHERE id = ? AND run_id = ? LIMIT 1', requestId, runId).toArray()[0];
		if (!request) return;
		this.storage.sql.exec('UPDATE loop_messages SET request_id = ?, session_id = ? WHERE seq = ?', request.id, request.session_id, messageSeq);
		if (origin === 'provider_response' || origin === 'compaction') this.storage.sql.exec('UPDATE inference_requests SET message_seq = ? WHERE id = ?', messageSeq, request.id);
	}

	failPending(runId: string, failure: AgentLogFailure): void {
		this.assertCanWrite();
		for (const row of this.storage.sql.exec<{ id: string }>("SELECT id FROM inference_requests WHERE run_id = ? AND state = 'pending' ORDER BY created_at LIMIT 100", runId).toArray()) {
			const attempt = this.latestAttempt(row.id);
			if (attempt !== null) {
				this.flushAttempt(attempt);
				this.storage.sql.exec('UPDATE inference_attempts SET outcome_json = ? WHERE id = ? AND outcome_json IS NULL', JSON.stringify(logAttemptOutcome(failure)), attempt);
				this.forgetAttempt(attempt);
			}
			this.finish(row.id, 'failed');
		}
		for (const row of this.storage.sql.exec<{ id: string }>("SELECT id FROM compaction_sessions WHERE run_id = ? AND CASE WHEN json_valid(outcome_json) THEN json_extract(outcome_json, '$.kind') END = 'pending' ORDER BY created_at LIMIT 100", runId).toArray()) this.settleSession(row.id, { kind: 'failed', error: failure });
	}

	private anchor(): { seq: number | null; position: number } {
		return this.storage.sql.exec<{ seq: number; position: number }>('SELECT seq, position FROM loop_messages WHERE compacted_by IS NULL AND deleted_at IS NULL ORDER BY position DESC, seq DESC LIMIT 1').toArray()[0] ?? { seq: null, position: 0 };
	}

	anchorUnattachedNotices(seq: number, position: number, createdAt: string): void {
		this.assertCanWrite();
		for (const table of ['inference_requests', 'compaction_sessions']) this.storage.sql.exec(`UPDATE ${table} SET anchor_seq = ? WHERE anchor_seq IS NULL AND position <= ? AND created_at <= ?`, seq, position, createdAt);
	}

	startSession(runId: string, trigger: AgentLogCompactionTrigger): string {
		this.assertCanWrite();
		const id = crypto.randomUUID();
		const anchor = this.anchor();
		this.storage.sql.exec('INSERT INTO compaction_sessions(id, run_id, trigger_json, position, anchor_seq, outcome_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, runId, JSON.stringify(logTrigger(trigger)), anchor.position + 0.5, anchor.seq, JSON.stringify({ kind: 'pending' }), new Date().toISOString());
		return id;
	}

	settleSession(id: string, outcome: AgentLogCompactionOutcome): void {
		this.assertCanWrite();
		if (outcome.kind === 'failed') {
			const summaries = this.storage.sql.exec<{ seq: number }>("SELECT seq FROM loop_messages WHERE session_id = ? AND origin = 'compaction' ORDER BY position, seq LIMIT 1000", id).toArray();
			if (summaries.length) outcome = { kind: 'partial', summarySeqs: summaries.map(row => row.seq), failedBatchCount: 1, error: outcome.error };
		}
		this.storage.sql.exec('UPDATE compaction_sessions SET outcome_json = ? WHERE id = ?', JSON.stringify(logCompactionOutcome(outcome)), id);
		if (outcome.kind === 'succeeded') this.storage.sql.exec('UPDATE loop_messages SET session_id = ? WHERE seq = ?', id, outcome.summarySeq);
	}

	session(id: string): AgentLogCompactionSession {
		const row = this.storage.sql.exec<SessionRow>('SELECT * FROM compaction_sessions WHERE id = ? LIMIT 1', id).toArray()[0];
		if (!row) throw new RepositoryError('not_found', 'The compaction session is not retained.', 404);
		return { id: row.id, trigger: logTrigger(storedLogValue(row.trigger_json)), position: row.position, createdAt: row.created_at, outcome: readLogCompactionOutcome(row.outcome_json), requests: this.storage.sql.exec<{ id: string }>('SELECT id FROM inference_requests WHERE session_id = ? ORDER BY event_seq LIMIT 1000', id).toArray().map(request => this.request(request.id)) };
	}

	private pageAuthor(value: string | null, message: BotLoopMessage): AgentLogAuthor {
		try { return logAuthor(value ? storedLogValue(value) : agentLogAuthor(message.origin, message.role)); }
		catch (error) {
			if (error instanceof RepositoryError && error.status === 409) return { kind: 'unknown' };
			throw error;
		}
	}

	entries(messages: BotLoopMessage[], source: number | null, activeRunId: string | null = null): AgentLogEntry[] {
		type References = { seq: number; author_json: string | null; request_id: string | null; session_id: string | null };
		const refs = new Map(this.storage.sql.exec<References>('SELECT seq, author_json, request_id, session_id FROM loop_messages WHERE seq IN (SELECT value FROM json_each(?))', JSON.stringify(messages.map(message => message.seq))).toArray().map(row => [row.seq, row]));
		const pagePredicate = source === null ? 'm.compacted_by IS NULL' : 'm.compacted_by = ?';
		const bindings = source === null ? [] : [source];
		type UnlinkedRequest = RequestRow & { attempt_id: number | null; partial_response: string | null; outcome_json: string | null };
		const unlinked = this.storage.sql.exec<UnlinkedRequest>(`SELECT r.*, a.id AS attempt_id, a.partial_response, a.outcome_json
		 FROM inference_requests r LEFT JOIN loop_messages m ON m.seq = r.anchor_seq
		 LEFT JOIN inference_attempts a ON a.id = (SELECT id FROM inference_attempts WHERE request_id = r.id ORDER BY id DESC LIMIT 1)
		 WHERE r.purpose = 'loop' AND r.message_seq IS NULL AND (r.state != 'succeeded' OR r.run_id = ?) AND (${source === null ? "r.state IN ('pending', 'succeeded') OR " : ''}${pagePredicate})
		 ORDER BY r.position, r.created_at LIMIT 2000`, activeRunId, ...bindings).toArray();
		const summaries = this.summaries([...new Set([...refs.values()].flatMap(row => row.request_id ? [row.request_id] : []).concat(unlinked.map(row => row.id)))]);
		const summary = (id: string): AgentLogAttemptSummary => summaries.get(id) ?? { count: 0, failures: [] };
		const entries: AgentLogEntry[] = messages.flatMap((message): AgentLogEntry[] => {
			const ref = refs.get(message.seq);
			if (message.origin === 'runtime_error' || message.origin === 'dropped_provider_response') {
				if (message.origin === 'dropped_provider_response' && ref?.request_id) return [];
				return [{ kind: 'notice', position: message.position ?? message.seq, notice: { kind: message.origin === 'runtime_error' ? 'runtime_error' : 'dropped_output', message: message.message.content ?? '', messageSeq: message.seq } }];
			}
			if (!loopMessageContributesToProviderHistory(message.origin, message.message)) return [];
			return [{ kind: 'message', position: message.position ?? message.seq, message, author: this.pageAuthor(ref?.author_json ?? null, message), requestId: ref?.request_id ?? null, sessionId: ref?.session_id ?? null, attempts: ref?.request_id ? summary(ref.request_id) : null }];
		});
		const live = source === null ? unlinked.filter(row => row.state === 'pending' || row.state === 'succeeded') : [];
		const partials = this.chunkTexts(live.flatMap(row => row.attempt_id !== null && row.partial_response ? [row.attempt_id] : []), 'partial');
		const responses = this.chunkTexts(live.flatMap(row => row.attempt_id !== null && row.state === 'succeeded' && row.outcome_json !== null ? [row.attempt_id] : []), 'outcome');
		for (const row of unlinked) {
			if ((row.state === 'pending' || row.state === 'succeeded') && source === null) {
				const outcome = row.state === 'succeeded' && row.outcome_json !== null ? readLogAttemptOutcome(responses.get(row.attempt_id!) ?? row.outcome_json) : null;
				const response = outcome?.kind === 'success' ? outcome.response : outcome?.kind === 'interrupted' ? outcome.response ?? null : null;
				entries.push({ kind: 'live', position: Number.MAX_SAFE_INTEGER, requestId: row.id, runId: row.run_id, attempts: summary(row.id), partialResponse: row.attempt_id !== null ? this.partialText(row.attempt_id, row.partial_response, partials.get(row.attempt_id)) : null, response, attemptId: row.attempt_id ?? undefined, deltaRevision: [...this.liveAttempts.values()].find(attempt => attempt.attemptId === row.attempt_id)?.revision ?? 0 });
			} else if (row.state === 'failed') entries.push({ kind: 'notice', position: row.position, notice: { kind: 'request_failed', requestId: row.id, attempts: summary(row.id) } });
		}
		for (const row of this.storage.sql.exec<SessionRow>(`SELECT s.* FROM compaction_sessions s LEFT JOIN loop_messages m ON m.seq = s.anchor_seq WHERE ${pagePredicate} ORDER BY s.position, s.created_at LIMIT 2000`, ...bindings).toArray()) entries.push({ kind: 'notice', position: row.position, notice: { kind: 'compaction_started', sessionId: row.id, outcome: readLogCompactionOutcome(row.outcome_json) } });
		return entries.sort((a, b) => a.position - b.position);
	}

	writeAuthor(seq: number, origin: BotLoopMessage['origin'], role: string, source?: AgentLogSource, legacy = false): void {
		this.assertCanWrite();
		if (!legacy && origin === 'synthetic_context' && role === 'assistant' && !source) throw new Error('Synthetic assistant content requires a source.');
		this.storage.sql.exec('UPDATE loop_messages SET author_json = ? WHERE seq = ?', JSON.stringify(agentLogAuthor(origin, role, source)), seq);
	}
	// agent_log_request_store_v1 and agent_log_authors_v1 run only on startup and maintenance.
	// After the fleet sweep reaches zero, advance schemaVersion to 2 and remove both adapters.
	// Keep legacy_synthetic until its census reaches zero through retention or owner deletion.
	migrate(messages: RuntimeMessageStore): void {
		this.assertCanWrite();
		this.storage.transactionSync(() => {
			this.migratePartialReasoning();
			const authorsDone = this.migrationDone('agent_log_authors_v1');
			const requestsDone = this.migrationDone('agent_log_request_store_v1');
			const rows = authorsDone ? [] : this.storage.sql.exec<{ seq: number; origin: BotLoopMessage['origin']; role: string; message_json: string }>('SELECT seq, origin, role, message_json FROM loop_messages WHERE author_json IS NULL ORDER BY seq LIMIT 100').toArray();
			for (const row of rows) this.writeAuthor(row.seq, row.origin, row.role, row.origin === 'synthetic_context' && Array.isArray(JSON.parse(row.message_json).tool_calls) ? 'synthetic_tool_call' : undefined, true);
			if (!authorsDone && rows.length < 100) this.markMigration('agent_log_authors_v1');
			const logs = requestsDone ? [] : this.storage.sql.exec<{ id: number; message_seq: number; kind: string; created_at: string; run_id: string; stream_seq: number | null }>("SELECT l.id, l.message_seq, l.kind, l.created_at, m.run_id, m.stream_seq FROM loop_message_logs l JOIN loop_messages m ON m.seq = l.message_seq WHERE l.kind IN ('provider_request', 'compaction_request') ORDER BY l.id LIMIT 100").toArray();
			for (const log of logs) {
				const body = messages.reconstructLoopMessageLogText(log.id);
				const id = this.begin({ runId: log.run_id, eventSeq: log.stream_seq ?? -log.id, purpose: log.kind === 'compaction_request' ? 'compaction' : 'loop', createdAt: log.created_at });
				this.storage.sql.exec('UPDATE inference_requests SET anchor_seq = ?, position = (SELECT position FROM loop_messages WHERE seq = ?) WHERE id = ?', log.message_seq, log.message_seq, id);
				const attempt = this.startAttempt(id, body, log.created_at);
				const response = this.storage.sql.exec<{ id: number }>("SELECT id FROM loop_message_logs WHERE message_seq = ? AND kind IN ('provider_response', 'compaction_response') ORDER BY id DESC LIMIT 1", log.message_seq).toArray()[0];
				const message = this.storage.sql.exec<{ origin: string }>('SELECT origin FROM loop_messages WHERE seq = ? LIMIT 1', log.message_seq).one();
				if (message.origin === 'dropped_provider_response') {
					// This adapter reads the former diagnostic shape once, before removing it.
					const payload = response ? JSON.parse(messages.reconstructLoopMessageLogText(response.id)) as { droppedToolCalls?: Array<{ id?: string; name?: string; reason?: string; argumentsPreview?: string }> } : {};
					this.settle(attempt, { kind: 'dropped_invalid_output', droppedCalls: (payload.droppedToolCalls ?? []).map(call => ({ id: call.id ?? '', name: call.name ?? '', reason: call.reason ?? 'legacy_invalid_output', argumentsPreview: call.argumentsPreview ?? '' })) });
				} else if (message.origin === 'runtime_error') this.settle(attempt, { kind: 'runtime_error', message: 'This historical request failed.' });
				else if (response) this.settle(attempt, { kind: 'success', response: messages.reconstructLoopMessageLogText(response.id) });
				else this.settle(attempt, { kind: 'interrupted' });
				this.link(log.message_seq, log.run_id, log.stream_seq ?? -log.id, message.origin);
				this.finish(id, message.origin === 'runtime_error' || message.origin === 'dropped_provider_response' ? 'failed' : 'succeeded');
				messages.removeLog(log.id);
			}
			if (!requestsDone && logs.length < 100) this.markMigration('agent_log_request_store_v1');
		});
	}


	// This one runtime_state record stays until the schema-version-2 retirement.
	// Startup and the fleet retention sweep each visit at most 100 attempts.
	private migratePartialReasoning(): void {
		const key = 'agent_log_partial_reasoning_v1';
		if (this.migrationDone(key)) return;
		const state = this.storage.sql.exec<{ value_json: string }>('SELECT value_json FROM runtime_state WHERE key = ? LIMIT 1', key).toArray()[0];
		const cursor = state ? (JSON.parse(state.value_json) as { cursor: number }).cursor : 0;
		const rows = this.storage.sql.exec<{ id: number; partial_response: string | null }>('SELECT id, partial_response FROM inference_attempts WHERE id > ? ORDER BY id LIMIT 100', cursor).toArray();
		for (const row of rows) {
			if (!row.partial_response) continue;
			const value = storedLogValue(this.readChunks(row.id, 'partial')) as { reasoningParts?: unknown };
			if (!Array.isArray(value.reasoningParts)) this.writeChunks(row.id, JSON.stringify(logPartial(value)), 'partial');
		}
		if (rows.length < 100) this.markMigration(key);
		else this.storage.sql.exec('INSERT INTO runtime_state(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', key, JSON.stringify({ schemaVersion: 1, complete: false, cursor: rows.at(-1)!.id }));
	}

	private migrationDone(key: string): boolean {
		return this.storage.sql.exec<{ value_json: string }>('SELECT value_json FROM runtime_state WHERE key = ? LIMIT 1', key).toArray().some(row => JSON.parse(row.value_json).complete === true);
	}

	private markMigration(key: string): void {
		this.storage.sql.exec('INSERT INTO runtime_state(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', key, JSON.stringify({ schemaVersion: 1, complete: true }));
	}

	prune(messages: RuntimeMessageStore, now = new Date()): void {
		this.assertCanWrite();
		const pages = messages.loopMessagePageIndex().descriptors.slice(0, 3).flatMap(page => page.sourceCompactionSeq === null ? [] : [page.sourceCompactionSeq]);
		const protectedPage = `m.seq IS NOT NULL AND (m.compacted_by IS NULL${pages.length ? ` OR m.compacted_by IN (${pages.map(() => '?').join(',')})` : ''})`;
		const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString();
		const expired = this.storage.sql.exec<{ id: string }>(`SELECT r.id FROM inference_requests r LEFT JOIN loop_messages m ON m.seq = COALESCE(r.message_seq, r.anchor_seq) WHERE r.created_at < ? AND r.state != 'pending' AND NOT ((r.anchor_seq IS NULL AND r.message_seq IS NULL) OR (${protectedPage})) ORDER BY r.created_at, r.id LIMIT 100`, cutoff, ...pages).toArray();
		this.storage.transactionSync(() => {
			for (const request of expired) {
				const attempts = this.storage.sql.exec<{ id: number }>('SELECT id FROM inference_attempts WHERE request_id = ? ORDER BY id LIMIT 1000', request.id).toArray();
				for (const attempt of attempts) this.removeAttempt(attempt.id);
				this.storage.sql.exec('DELETE FROM inference_requests WHERE id = ?', request.id);
			}
			const sessions = this.storage.sql.exec<{ id: string }>(`SELECT s.id FROM compaction_sessions s LEFT JOIN loop_messages m ON m.seq = s.anchor_seq
			 WHERE (CASE WHEN json_valid(s.outcome_json) THEN json_extract(s.outcome_json, '$.kind') END IN ('succeeded', 'partial') AND NOT EXISTS (SELECT 1 FROM loop_messages summary WHERE summary.session_id = s.id AND summary.origin = 'compaction'))
			 OR (CASE WHEN json_valid(s.outcome_json) THEN json_extract(s.outcome_json, '$.kind') END = 'failed' AND s.created_at < ? AND NOT (s.anchor_seq IS NULL OR (${protectedPage})))
			 ORDER BY s.created_at, s.id LIMIT 100`, new Date(now.getTime() - 14 * 86400000).toISOString(), ...pages).toArray();
			for (const session of sessions) this.storage.sql.exec('DELETE FROM compaction_sessions WHERE id = ?', session.id);
		});
		messages.pruneExpiredRawLogs(cutoff, pages);
		// The obsolete messages-only store receives no writes. After a zero-row fleet census,
		// advance schemaVersion to 2 and remove its schema, readers, and retirement sweep.
		this.storage.sql.exec('DELETE FROM inference_submissions WHERE id IN (SELECT id FROM inference_submissions WHERE created_at < ? ORDER BY created_at LIMIT 100)', cutoff);
	}

	private removeAttempt(id: number): void {
		const dependents = this.storage.sql.exec<{ id: number }>('SELECT id FROM inference_attempts WHERE base_id = ? ORDER BY id LIMIT 1000', id).toArray();
		for (const dependent of dependents) {
			const body = this.body(dependent.id);
			if (body === null) throw new Error('A retained request body lost its base.');
			this.writeChunks(dependent.id, body);
			this.storage.sql.exec('UPDATE inference_attempts SET base_id = NULL, prefix_length = 0 WHERE id = ?', dependent.id);
		}
		this.storage.sql.exec('DELETE FROM inference_body_chunks WHERE attempt_id = ?', id);
		this.storage.sql.exec('DELETE FROM inference_attempts WHERE id = ?', id);
	}

}
