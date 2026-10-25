import type { AgentLogEntry, AgentLogRequest, BotRuntimeEvent } from '@bickr/shared/model';

// This test bridge keeps Worker globals out of the web type check.
export function reasoningRuntimeOutput(completed: boolean, scenario?: 'mixed' | 'plain-opaque' | 'plain-summary' | 'summary-only' | 'text-summary' | 'opaque-only' | 'interleaved'): Promise<{
	events: BotRuntimeEvent[];
	snapshots: AgentLogEntry[][];
	settled: AgentLogEntry[];
	history: AgentLogEntry[];
	requestId: string;
	request: AgentLogRequest;
}>;
