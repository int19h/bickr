import { agentLogAuthor, type AgentLogAttempt, type AgentLogAttemptOutcome, type AgentLogAttemptSummary, type AgentLogCompactionOutcome, type AgentLogCompactionSession, type AgentLogCompactionTrigger, type AgentLogEntry, type AgentLogFailure, type AgentLogRequest, type AgentLogSource, type AgentLogRequestSummary, type BotLoopMessage } from '@bickr/shared/model';
import { loopMessageContributesToProviderHistory } from '../provider/sanitize';
import { RepositoryError } from '@bickr/shared/repository';
import { ProviderCompactionRequestError, ProviderLoopRequestError, ProviderRequestError, ProviderRequestTimeoutError, ProviderResponseBodyTimeoutError, ProviderResponseInterruptedError, ProviderStreamIdleTimeoutError, ProviderStructuredOutputValidationError, TickStoppedError } from '../errors';
import type { RuntimeStorage, RuntimeMessageStore } from './message-store';

// Requests, attempts, and body chunks stay for the newest three pages.
// Beyond those pages, a bounded alarm sweep removes them after seven days.
// Successful sessions share their summary's lifetime. Failed sessions share their page's lifetime.
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
type AttemptRow = { id: number; request_id: string; started_at: string; outcome_json: string | null; partial_response: string | null; base_id: number | null; prefix_length: number };
type SessionRow = { id: string; run_id: string; trigger_json: string; position: number; anchor_seq: number | null; outcome_json: string; created_at: string };
const chunkLength = 64_000;

export function agentLogFailure(error: unknown): AgentLogFailure {
	if (error instanceof ProviderCompactionRequestError || error instanceof ProviderLoopRequestError) return agentLogFailure(error.originalError);
	if (error instanceof ProviderStructuredOutputValidationError) return { kind: 'validation', issue: error.validationIssue ?? null, message: error.message };
	if (error instanceof ProviderRequestTimeoutError || error instanceof ProviderResponseBodyTimeoutError || error instanceof ProviderStreamIdleTimeoutError) return { kind: 'timeout' };
	if (error instanceof ProviderResponseInterruptedError || error instanceof TickStoppedError || (error instanceof Error && error.name === 'AbortError')) return { kind: 'interrupted' };
	return { kind: 'provider_error', status: error instanceof ProviderRequestError ? error.status : null, errorType: error instanceof ProviderRequestError ? error.providerError?.errorType ?? null : null, message: error instanceof Error ? error.message : String(error) };
}

export class AgentLogStore {
	private readonly storage: RuntimeStorage;
	constructor(storage: RuntimeStorage) { this.storage = storage; }

	initialize(): void {
		for (const statement of agentLogSchema.split(';')) if (statement.trim()) this.storage.sql.exec(statement);
		const columns = new Set(this.storage.sql.exec<{ name: string }>('PRAGMA table_info(loop_messages)').toArray().map(row => row.name));
		// These columns share the retention of their loop row.
		for (const name of ['author_json', 'request_id', 'session_id']) if (!columns.has(name)) this.storage.sql.exec(`ALTER TABLE loop_messages ADD COLUMN ${name} TEXT`);
		this.storage.sql.exec('CREATE INDEX IF NOT EXISTS loop_messages_agent_request ON loop_messages(request_id, seq)');
		this.storage.sql.exec('CREATE INDEX IF NOT EXISTS loop_messages_agent_session ON loop_messages(session_id, seq)');
		this.storage.sql.exec('CREATE INDEX IF NOT EXISTS loop_messages_agent_author ON loop_messages(author_json, seq)');
	}

	begin(input: { runId: string; eventSeq: number; purpose: AgentLogRequest['purpose']; sessionId?: string; createdAt?: string; existingId?: string }): string {
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
		return this.storage.transactionSync(() => {
			const base = this.storage.sql.exec<AttemptRow>('SELECT * FROM inference_attempts ORDER BY id DESC LIMIT 1').toArray()[0];
			const baseText = base ? this.body(base.id) : null;
			let prefix = 0;
			if (baseText !== null) while (prefix < body.length && prefix < baseText.length && body[prefix] === baseText[prefix]) prefix++;
			const useBase = base && baseText !== null && prefix > 64;
			const attempt = this.storage.sql.exec<{ id: number }>(`INSERT INTO inference_attempts(request_id, event_seq, started_at, base_id, prefix_length) VALUES (?, (SELECT event_seq FROM inference_requests WHERE id = ?), ?, ?, ?) RETURNING id`, requestId, requestId, startedAt, useBase ? base.id : null, useBase ? prefix : 0).one().id;
			this.writeChunks(attempt, useBase ? body.slice(prefix) : body);
			this.storage.sql.exec("UPDATE inference_requests SET state = 'pending' WHERE id = ?", requestId);
			return attempt;
		});
	}

	private writeChunks(attemptId: number, text: string, kind: 'body' | 'outcome' | 'partial' = 'body'): void {
		this.storage.sql.exec('DELETE FROM inference_body_chunks WHERE attempt_id = ? AND kind = ?', attemptId, kind);
		for (let offset = 0; offset < text.length; offset += chunkLength) this.storage.sql.exec('INSERT INTO inference_body_chunks(attempt_id, kind, chunk_index, text) VALUES (?, ?, ?, ?)', attemptId, kind, offset / chunkLength, text.slice(offset, offset + chunkLength));
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
		this.storage.transactionSync(() => {
			this.writeChunks(attemptId, JSON.stringify(outcome), 'outcome');
			this.writeChunks(attemptId, '', 'partial');
			this.storage.sql.exec('UPDATE inference_attempts SET outcome_json = ?, partial_response = NULL WHERE id = ?', JSON.stringify({ kind: outcome.kind }), attemptId);
		});
	}

	finish(requestId: string, state: 'succeeded' | 'failed'): void {
		this.storage.sql.exec('UPDATE inference_requests SET state = ? WHERE id = ?', state, requestId);
	}

	latestAttempt(requestId: string): number | null {
		return this.storage.sql.exec<{ id: number }>('SELECT id FROM inference_attempts WHERE request_id = ? ORDER BY id DESC LIMIT 1', requestId).toArray()[0]?.id ?? null;
	}

	partial(runId: string, eventSeq: number, payload: Record<string, unknown>): string | null {
		const request = this.byEvent(runId, eventSeq);
		if (!request) return null;
		const id = this.latestAttempt(request.id);
		if (id !== null) {
			const row = this.storage.sql.exec<{ partial_response: string | null }>('SELECT partial_response FROM inference_attempts WHERE id = ? LIMIT 1', id).one();
			const partial = row.partial_response ? JSON.parse(this.readChunks(id, 'partial')) as { content: string; reasoning: string; toolCalls: unknown[] } : { content: '', reasoning: '', toolCalls: [] };
			if (payload.kind === 'content' && typeof payload.text === 'string') partial.content += payload.text;
			if (payload.kind === 'reasoning' && typeof payload.text === 'string') partial.reasoning += payload.text;
			if (payload.kind === 'tool_call') partial.toolCalls.push(payload.part);
			this.storage.transactionSync(() => {
				this.writeChunks(id, JSON.stringify(partial), 'partial');
				this.storage.sql.exec("UPDATE inference_attempts SET partial_response = 'retained' WHERE id = ? AND outcome_json IS NULL", id);
			});
		}
		return request.id;
	}

	request(id: string): AgentLogRequest {
		const row = this.storage.sql.exec<RequestRow>('SELECT * FROM inference_requests WHERE id = ? LIMIT 1', id).toArray()[0];
		if (!row) throw new RepositoryError('not_found', 'The inference request is not retained.', 404);
		const attempts = this.storage.sql.exec<AttemptRow>('SELECT * FROM inference_attempts WHERE request_id = ? ORDER BY id LIMIT 1000', id).toArray().map((attempt): AgentLogAttempt => ({ id: attempt.id, startedAt: attempt.started_at, body: this.body(attempt.id), partialResponse: attempt.partial_response ? this.readChunks(attempt.id, 'partial') : null, outcome: attempt.outcome_json ? this.outcome(attempt.id, attempt.outcome_json) : null }));
		return { id: row.id, runId: row.run_id, purpose: row.purpose, state: row.state, createdAt: row.created_at, messageSeq: row.message_seq, sessionId: row.session_id, attempts };
	}

	// A new object instance cannot retain a network call from its previous instance.
	recoverInterrupted(): void {
		this.storage.transactionSync(() => {
			for (const row of this.storage.sql.exec<{ run_id: string }>("SELECT DISTINCT run_id FROM inference_requests WHERE state = 'pending' LIMIT 100").toArray()) this.failPending(row.run_id, { kind: 'interrupted' });
			for (const row of this.storage.sql.exec<{ id: string }>("SELECT id FROM compaction_sessions WHERE json_extract(outcome_json, '$.kind') = 'pending' ORDER BY created_at LIMIT 100").toArray()) this.settleSession(row.id, { kind: 'failed', error: { kind: 'interrupted' } });
		});
	}

	clear(): void {
		this.storage.transactionSync(() => {
			for (const table of ['inference_body_chunks', 'inference_attempts', 'inference_requests', 'compaction_sessions']) this.storage.sql.exec(`DELETE FROM ${table}`);
		});
	}

	migrationStatus(): { authorsPending: boolean; requestsPending: boolean; legacySubmissionsRemain: boolean; legacyAuthorsRemain: boolean } {
		return {
			authorsPending: !this.migrationDone('agent_log_authors_v1'),
			requestsPending: !this.migrationDone('agent_log_request_store_v1'),
			legacySubmissionsRemain: this.storage.sql.exec('SELECT id FROM inference_submissions LIMIT 1').toArray().length > 0,
			legacyAuthorsRemain: this.storage.sql.exec(`SELECT seq FROM loop_messages WHERE author_json = ? LIMIT 1`, JSON.stringify({ kind: 'legacy_synthetic' })).toArray().length > 0,
		};
	}

	requestForMessage(seq: number): AgentLogRequest | null {
		const row = this.storage.sql.exec<{ id: string }>('SELECT r.id FROM inference_requests r JOIN loop_messages m ON m.request_id = r.id WHERE m.seq = ? LIMIT 1', seq).toArray()[0];
		return row ? this.request(row.id) : null;
	}

	list(): AgentLogRequestSummary[] {
		return this.storage.sql.exec<RequestRow>('SELECT * FROM inference_requests ORDER BY created_at DESC, id LIMIT 100').toArray().map(row => ({ id: row.id, runId: row.run_id, purpose: row.purpose, state: row.state, createdAt: row.created_at, messageSeq: row.message_seq, sessionId: row.session_id, attempts: this.summary(row.id) }));
	}

	private readChunks(id: number, kind: 'body' | 'outcome' | 'partial'): string {
		return this.storage.sql.exec<{ text: string }>('SELECT text FROM inference_body_chunks WHERE attempt_id = ? AND kind = ? ORDER BY chunk_index LIMIT 10000', id, kind).toArray().map(chunk => chunk.text).join('');
	}

	private outcome(id: number, metadata: string): AgentLogAttemptOutcome {
		return JSON.parse(this.readChunks(id, 'outcome') || metadata) as AgentLogAttemptOutcome;
	}

	summary(requestId: string): AgentLogAttemptSummary {
		const attempts = this.storage.sql.exec<Pick<AttemptRow, 'id' | 'outcome_json'>>('SELECT id, outcome_json FROM inference_attempts WHERE request_id = ? ORDER BY id LIMIT 1000', requestId).toArray();
		return { count: attempts.length, failures: attempts.flatMap(row => {
			const outcome = row.outcome_json ? this.outcome(row.id, row.outcome_json) : null;
			return outcome && outcome.kind !== 'success' ? [{ attemptId: row.id, outcome }] : [];
		}) };
	}

	link(messageSeq: number, runId: string, eventSeq: number | undefined, origin: string): void {
		if (eventSeq === undefined) return;
		const request = this.byEvent(runId, eventSeq);
		if (!request) return;
		this.storage.sql.exec('UPDATE loop_messages SET request_id = ?, session_id = ? WHERE seq = ?', request.id, request.session_id, messageSeq);
		if (origin === 'provider_response' || origin === 'compaction') this.storage.sql.exec('UPDATE inference_requests SET message_seq = ? WHERE id = ?', messageSeq, request.id);
	}

	failPending(runId: string, failure: AgentLogFailure): void {
		for (const row of this.storage.sql.exec<{ id: string }>("SELECT id FROM inference_requests WHERE run_id = ? AND state = 'pending' ORDER BY created_at LIMIT 100", runId).toArray()) {
			const attempt = this.latestAttempt(row.id);
			if (attempt !== null) this.storage.sql.exec('UPDATE inference_attempts SET outcome_json = ? WHERE id = ? AND outcome_json IS NULL', JSON.stringify(failure), attempt);
			this.finish(row.id, 'failed');
		}
	}

	private anchor(): { seq: number | null; position: number } {
		return this.storage.sql.exec<{ seq: number; position: number }>('SELECT seq, position FROM loop_messages WHERE compacted_by IS NULL AND deleted_at IS NULL ORDER BY position DESC, seq DESC LIMIT 1').toArray()[0] ?? { seq: null, position: 0 };
	}

	anchorUnattachedNotices(seq: number, position: number, createdAt: string): void {
		for (const table of ['inference_requests', 'compaction_sessions']) this.storage.sql.exec(`UPDATE ${table} SET anchor_seq = ? WHERE anchor_seq IS NULL AND position <= ? AND created_at <= ?`, seq, position, createdAt);
	}

	startSession(runId: string, trigger: AgentLogCompactionTrigger): string {
		const id = crypto.randomUUID();
		const anchor = this.anchor();
		this.storage.sql.exec('INSERT INTO compaction_sessions(id, run_id, trigger_json, position, anchor_seq, outcome_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, runId, JSON.stringify(trigger), anchor.position + 0.5, anchor.seq, JSON.stringify({ kind: 'pending' }), new Date().toISOString());
		return id;
	}

	settleSession(id: string, outcome: AgentLogCompactionOutcome): void {
		this.storage.sql.exec('UPDATE compaction_sessions SET outcome_json = ? WHERE id = ?', JSON.stringify(outcome), id);
		if (outcome.kind === 'succeeded') this.storage.sql.exec('UPDATE loop_messages SET session_id = ? WHERE seq = ?', id, outcome.summarySeq);
	}

	session(id: string): AgentLogCompactionSession {
		const row = this.storage.sql.exec<SessionRow>('SELECT * FROM compaction_sessions WHERE id = ? LIMIT 1', id).toArray()[0];
		if (!row) throw new RepositoryError('not_found', 'The compaction session is not retained.', 404);
		return { id: row.id, trigger: JSON.parse(row.trigger_json) as AgentLogCompactionTrigger, position: row.position, createdAt: row.created_at, outcome: JSON.parse(row.outcome_json) as AgentLogCompactionOutcome, requests: this.storage.sql.exec<{ id: string }>('SELECT id FROM inference_requests WHERE session_id = ? ORDER BY event_seq LIMIT 1000', id).toArray().map(request => this.request(request.id)) };
	}

	entries(messages: BotLoopMessage[], source: number | null): AgentLogEntry[] {
		const entries: AgentLogEntry[] = messages.flatMap((message): AgentLogEntry[] => {
			const refs = this.storage.sql.exec<{ author_json: string; request_id: string | null; session_id: string | null }>('SELECT author_json, request_id, session_id FROM loop_messages WHERE seq = ? LIMIT 1', message.seq).one();
			if (message.origin === 'runtime_error' || message.origin === 'dropped_provider_response') {
				if (message.origin === 'dropped_provider_response' && refs.request_id) return [];
				return [{ kind: 'notice', position: message.position ?? message.seq, notice: { kind: message.origin === 'runtime_error' ? 'runtime_error' : 'dropped_output', message: message.message.content ?? '', messageSeq: message.seq } }];
			}
			if (!loopMessageContributesToProviderHistory(message.origin, message.message)) return [];
			return [{ kind: 'message', position: message.position ?? message.seq, message, author: (refs.author_json ? JSON.parse(refs.author_json) : agentLogAuthor(message.origin, message.role)) as ReturnType<typeof agentLogAuthor>, requestId: refs.request_id, sessionId: refs.session_id, attempts: refs.request_id ? this.summary(refs.request_id) : null }];
		});
		const pagePredicate = source === null ? 'm.compacted_by IS NULL' : 'm.compacted_by = ?';
		const bindings = source === null ? [] : [source];
		for (const row of this.storage.sql.exec<RequestRow>(`SELECT r.* FROM inference_requests r LEFT JOIN loop_messages m ON m.seq = r.anchor_seq WHERE r.purpose = 'loop' AND r.message_seq IS NULL AND ${pagePredicate} ORDER BY r.position, r.created_at LIMIT 2000`, ...bindings).toArray()) {
			if (row.state === 'pending' && source === null) {
				const attempt = this.latestAttempt(row.id);
				const partial = attempt === null ? null : this.storage.sql.exec<{ partial_response: string | null }>('SELECT partial_response FROM inference_attempts WHERE id = ? LIMIT 1', attempt).one().partial_response;
				const partialText = partial && attempt !== null ? this.readChunks(attempt, 'partial') : null;
				entries.push({ kind: 'live', position: Number.MAX_SAFE_INTEGER, requestId: row.id, runId: row.run_id, attempts: this.summary(row.id), partialResponse: partialText });
			} else if (row.state === 'failed') entries.push({ kind: 'notice', position: row.position, notice: { kind: 'request_failed', requestId: row.id, attempts: this.summary(row.id) } });
		}
		for (const row of this.storage.sql.exec<SessionRow>(`SELECT s.* FROM compaction_sessions s LEFT JOIN loop_messages m ON m.seq = s.anchor_seq WHERE ${pagePredicate} ORDER BY s.position, s.created_at LIMIT 2000`, ...bindings).toArray()) entries.push({ kind: 'notice', position: row.position, notice: { kind: 'compaction_started', sessionId: row.id, outcome: JSON.parse(row.outcome_json) as AgentLogCompactionOutcome } });
		return entries.sort((a, b) => a.position - b.position);
	}

	writeAuthor(seq: number, origin: BotLoopMessage['origin'], role: string, source?: AgentLogSource, legacy = false): void {
		if (!legacy && origin === 'synthetic_context' && role === 'assistant' && !source) throw new Error('Synthetic assistant content requires a source.');
		this.storage.sql.exec('UPDATE loop_messages SET author_json = ? WHERE seq = ?', JSON.stringify(agentLogAuthor(origin, role, source)), seq);
	}
	// agent_log_request_store_v1 and agent_log_authors_v1 run only on startup and maintenance.
	// After the fleet sweep reaches zero, advance schemaVersion to 2 and remove both adapters.
	// Keep legacy_synthetic until its census reaches zero through retention or owner deletion.
	migrate(messages: RuntimeMessageStore): void {
		this.storage.transactionSync(() => {
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
				if (response) this.settle(attempt, { kind: 'success', response: messages.reconstructLoopMessageLogText(response.id) });
				else this.settle(attempt, { kind: 'interrupted' });
				const message = this.storage.sql.exec<{ origin: string }>('SELECT origin FROM loop_messages WHERE seq = ? LIMIT 1', log.message_seq).one();
				this.link(log.message_seq, log.run_id, log.stream_seq ?? -log.id, message.origin);
				this.finish(id, message.origin === 'runtime_error' || message.origin === 'dropped_provider_response' ? 'failed' : 'succeeded');
				messages.removeLog(log.id);
			}
			if (!requestsDone && logs.length < 100) this.markMigration('agent_log_request_store_v1');
		});
	}

	private migrationDone(key: string): boolean {
		return this.storage.sql.exec<{ value_json: string }>('SELECT value_json FROM runtime_state WHERE key = ? LIMIT 1', key).toArray().some(row => JSON.parse(row.value_json).complete === true);
	}

	private markMigration(key: string): void {
		this.storage.sql.exec('INSERT INTO runtime_state(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', key, JSON.stringify({ schemaVersion: 1, complete: true }));
	}

	prune(messages: RuntimeMessageStore, now = new Date()): void {
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
			 WHERE (json_extract(s.outcome_json, '$.kind') = 'succeeded' AND NOT EXISTS (SELECT 1 FROM loop_messages summary WHERE summary.session_id = s.id AND summary.origin = 'compaction'))
			 OR (json_extract(s.outcome_json, '$.kind') = 'failed' AND s.created_at < ? AND NOT (s.anchor_seq IS NULL OR (${protectedPage})))
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
