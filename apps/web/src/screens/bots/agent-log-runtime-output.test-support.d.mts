import type { AgentLogEntry, BotRuntimeEvent } from '@bickr/shared/model';

// This test bridge keeps Worker globals out of the web type check.
export function reasoningRuntimeOutput(completed: boolean, scenario?: 'mixed' | 'plain-opaque' | 'interleaved'): Promise<{
	events: BotRuntimeEvent[];
	snapshots: AgentLogEntry[][];
	settled: AgentLogEntry[];
	history: AgentLogEntry[];
	requestId: string;
}>;
