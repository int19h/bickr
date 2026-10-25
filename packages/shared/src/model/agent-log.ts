import type { BotLoopMessage, BotLoopMessageOrigin, BotLoopMessageRequestUsage, BotLoopMessageRequestLogMessage, InferenceAttribution } from './runtime.ts';

export type AgentLogReasoningDetail =
	| { kind: 'readable'; type: 'reasoning.text' | 'reasoning.summary'; text: string; index?: number; id?: string }
	| { kind: 'opaque'; type: string | null; index?: number; id?: string };
export function agentLogReasoningDetailKey(part: AgentLogReasoningDetail): string | null {
	return part.index !== undefined ? JSON.stringify([part.type, 'index', part.index])
		: part.id !== undefined ? JSON.stringify([part.type, 'id', part.id]) : null;
}
export type AgentLogReasoningPart = { kind: 'text'; text: string } | AgentLogReasoningDetail;
export type AgentLogToolDelta = { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } };
export type AgentLogStreamDelta =
	| { kind: 'content'; text: string }
	| { kind: 'reasoning'; source: 'plain'; text: string }
	| { kind: 'reasoning'; source: 'detail'; part: Extract<AgentLogReasoningDetail, { kind: 'readable' }>; text: string }
	| { kind: 'reasoning'; source: 'detail'; part: Extract<AgentLogReasoningDetail, { kind: 'opaque' }>; text?: never }
	| { kind: 'tool_call'; part: AgentLogToolDelta };
export type AgentLogStreamPayload = AgentLogStreamDelta & {
	streamSeq: number;
	requestId: string | null;
	deltaRevision?: number;
	attemptId?: number;
	ephemeral: true;
};
export type AgentLogPartialResponse = {
	content: string;
	// This compatibility field contains plain reasoning and readable detail text in stream order.
	reasoning: string;
	reasoningParts: AgentLogReasoningPart[];
	toolCalls: AgentLogToolDelta[];
};

export type AgentLogAuthor =
	| { kind: 'model' | 'owner_injection' | 'reminder' | 'self_correction' | 'recurring_prompt' | 'spotlight_focus' | 'synthetic_tool_call' | 'local_simulation' | 'compaction_summary' | 'legacy_summary' | 'bickr_report' | 'legacy_synthetic' }
	| { kind: 'tool_result'; synthetic: boolean }
	| { kind: 'unknown' };

export type AgentLogFailure =
	| { kind: 'unknown' }
	| { kind: 'runtime_error'; message: string }
	| { kind: 'provider_error'; status: number | null; errorType: string | null; message: string }
	| { kind: 'dropped_invalid_output'; droppedCalls: Array<{ id: string; name: string; reason: string; argumentsPreview: string }> }
	| { kind: 'validation'; issue: string | null; message: string }
	| { kind: 'interrupted'; response?: string }
	| { kind: 'timeout' };
export type AgentLogAttemptOutcome = AgentLogFailure | { kind: 'success'; response: string };
export type AgentLogAttempt = {
	id: number;
	startedAt: string;
	body: string | null;
	usage: BotLoopMessageRequestUsage | null;
	attribution: InferenceAttribution | null;
	messages: BotLoopMessageRequestLogMessage[];
	partialResponse: string | null;
	outcome: AgentLogAttemptOutcome | null;
};
export type AgentLogRequest = {
	id: string;
	runId: string;
	purpose: 'loop' | 'compaction';
	state: 'pending' | 'succeeded' | 'failed';
	createdAt: string;
	messageSeq: number | null;
	sessionId: string | null;
	attempts: AgentLogAttempt[];
};
export type AgentLogAttemptSummary = { count: number; failures: Array<{ attemptId: number; outcome: AgentLogFailure }> };
export type AgentLogRequestSummary = Omit<AgentLogRequest, 'attempts'> & { attempts: AgentLogAttemptSummary };
export type AgentLogCompactionTrigger = { kind: 'visit' | 'admission' | 'manual' | 'legacy_forced' };
export type AgentLogCompactionOutcome = { kind: 'pending' } | { kind: 'succeeded'; summarySeq: number } | { kind: 'failed'; error: AgentLogFailure } | { kind: 'partial'; summarySeqs: number[]; failedBatchCount: number; error: AgentLogFailure };
export type AgentLogCompactionSession = {
	id: string;
	trigger: AgentLogCompactionTrigger;
	position: number;
	createdAt: string;
	outcome: AgentLogCompactionOutcome;
	requests: AgentLogRequest[];
};
export type AgentLogNotice =
	| { kind: 'runtime_error' | 'dropped_output'; message: string; messageSeq: number }
	| { kind: 'request_failed'; requestId: string; attempts: AgentLogAttemptSummary }
	| { kind: 'compaction_started'; sessionId: string; outcome: AgentLogCompactionOutcome };
export type AgentLogEntry =
	| { kind: 'message'; position: number; message: BotLoopMessage; author: AgentLogAuthor; requestId: string | null; sessionId: string | null; attempts: AgentLogAttemptSummary | null }
	| { kind: 'live'; position: number; requestId: string; runId: string; attempts: AgentLogAttemptSummary; partialResponse: string | null; response: string | null; deltaRevision?: number; attemptId?: number }
	| { kind: 'notice'; position: number; notice: AgentLogNotice };

export type AgentLogSource = 'recurring_prompt' | 'spotlight_focus' | 'synthetic_tool_call';

export function agentLogAuthor(origin: BotLoopMessageOrigin, role: string, source?: AgentLogSource): AgentLogAuthor {
	if (role === 'tool') return { kind: 'tool_result', synthetic: origin === 'synthetic_context' || origin === 'local_simulation' };
	switch (origin) {
		case 'provider_response': return { kind: 'model' };
		case 'injection': return { kind: 'owner_injection' };
		case 'reminder': return { kind: 'reminder' };
		case 'self_correction': return { kind: 'self_correction' };
		case 'synthetic_context': return { kind: source ?? 'legacy_synthetic' };
		case 'local_simulation': return { kind: 'local_simulation' };
		case 'compaction': return { kind: 'compaction_summary' };
		case 'legacy_migration': return { kind: 'legacy_summary' };
		case 'input': case 'tool_result': case 'tool_failure': case 'runtime_error': case 'dropped_provider_response': return { kind: 'bickr_report' };
	}
}
