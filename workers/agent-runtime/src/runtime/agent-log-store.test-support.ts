import { AgentLogStore } from './agent-log-store';
import { agentLogAuthor, type BotLoopMessage } from '@bickr/shared/model';
import type { RuntimeStorage } from './message-store';

// Protocol tests replace storage here. Store tests use a real SQLite database.
export function agentLogStoreStub(this: { state?: { storage?: RuntimeStorage } }) {
	const storage = this.state?.storage;
	if (storage?.sql) {
		try {
			if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'inference_requests'").toArray().length) return new AgentLogStore(storage);
		} catch { /* The protocol fixture implements only its own queries. */ }
	}
	return {
		begin: () => 'request', startAttempt: () => 1, latestAttempt: () => 1,
		stageResponsePublication: () => {}, responsePublication: () => null, completeResponsePublication: () => {}, discardResponsePublication: () => {},
		settle: () => {}, finish: () => {}, partial: () => 'request', streamState: () => ({ kind: 'none' }),
		failPending: () => {}, migrate: () => {}, prune: () => {}, body: () => null,
		anchorUnattachedNotices: () => {}, clear: () => {}, migrationStatus: () => ({}),
		startSession: () => 'session', settleSession: () => {}, requestForMessage: () => null,
		entries: (messages: BotLoopMessage[]) => messages.map(message => ({ kind: 'message', position: message.position ?? message.seq, message, author: agentLogAuthor(message.origin, message.role), requestId: null, sessionId: null, attempts: null })),
	};
}

// Protocol fixtures do not use SQLite. Store tests use real transactions.
export function protocolStorageTransaction<T>(this: { state?: { storage?: RuntimeStorage } }, operation: () => T): T {
	return this.state?.storage?.transactionSync ? this.state.storage.transactionSync(operation) : operation();
}
