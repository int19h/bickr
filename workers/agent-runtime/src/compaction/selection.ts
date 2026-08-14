import type { BotInferenceSubmissionMessage } from '@bickr/shared/model';
import { compactionRowTokenFraction, estimateChatMessageTokens, type TextTokenCalibration } from './limits';

type ChatMessage = BotInferenceSubmissionMessage;

export type CompactionMessageRow = {
	message_json: string;
};

export type CompactionCandidateEstimate<Row extends CompactionMessageRow = CompactionMessageRow> = {
	row: Row;
	tokens: number;
};

export type CompactionRowSelection<Row extends CompactionMessageRow = CompactionMessageRow> = {
	rows: Row[];
	overBudgetFallback: boolean;
};

export type CompactionSelectionOptions<Row extends CompactionMessageRow = CompactionMessageRow> = {
	canIncludeRows?: (rows: readonly Row[]) => boolean;
	requireMinimumSelectedTokens?: boolean;
};

const compactionOverBudgetFallbackMinSelectedTokens = 1_000;

export function compactionRowsForEstimatedBudget<Row extends CompactionMessageRow>(
	rows: readonly CompactionCandidateEstimate<Row>[],
	limitTokens: number,
	options: CompactionSelectionOptions<Row> = {},
): Row[] {
	return compactionRowSelectionForEstimatedBudget(rows, limitTokens, options).rows;
}

export function compactionRowSelectionForEstimatedBudget<Row extends CompactionMessageRow>(
	rows: readonly CompactionCandidateEstimate<Row>[],
	limitTokens: number,
	options: CompactionSelectionOptions<Row> = {},
): CompactionRowSelection<Row> {
	const groups = loopMessageCompactionGroups(rows);
	const promptLimitTokens = Math.max(1, Math.floor(limitTokens));
	const targetTokens = Math.max(1, Math.ceil(promptLimitTokens * compactionRowTokenFraction));
	const selected: Row[] = [];
	let selectedTokens = 0;
	for (const group of groups) {
		const nextTokens = selectedTokens + group.tokens;
		const nextRows = [...selected, ...group.rows];
		if (options.canIncludeRows?.(nextRows) === false) {
			return {
				rows: selected,
				overBudgetFallback: false,
			};
		}
		if (nextTokens > promptLimitTokens) {
			if (selectedTokens < compactionOverBudgetFallbackMinSelectedTokens && group.rows.length > 0) {
				return {
					rows: nextRows,
					overBudgetFallback: true,
				};
			}
			return {
				rows: selected,
				overBudgetFallback: false,
			};
		}
		if (nextTokens >= targetTokens) {
			return {
				rows: selectedTokens < compactionOverBudgetFallbackMinSelectedTokens ? nextRows : selected,
				overBudgetFallback: false,
			};
		}
		selected.push(...group.rows);
		selectedTokens = nextTokens;
	}
	return {
		rows: options.requireMinimumSelectedTokens && selectedTokens < compactionOverBudgetFallbackMinSelectedTokens ? [] : selected,
		overBudgetFallback: false,
	};
}

export function oldestRowsForTokenFraction<T>(rows: readonly { row: T; tokens: number }[], fraction: number): T[] {
	const totalTokens = rows.reduce((total, item) => total + Math.max(0, item.tokens), 0);
	if (totalTokens <= 0 || fraction <= 0) {
		return [];
	}
	const targetTokens = Math.ceil(totalTokens * Math.min(1, fraction));
	const selected: T[] = [];
	let selectedTokens = 0;
	for (const item of rows) {
		selected.push(item.row);
		selectedTokens += Math.max(0, item.tokens);
		if (selectedTokens >= targetTokens) {
			break;
		}
	}
	return selected;
}

export function reducedCompactionRowsAfterOutputLimit<Row extends CompactionMessageRow>(
	rows: readonly Row[],
	calibration: TextTokenCalibration,
): Row[] {
	const estimates = rows.map((row) => ({
		row,
		tokens: estimateChatMessageTokens(loopMessageChatMessageFromRow(row), calibration),
	}));
	const groups = loopMessageCompactionGroups(estimates);
	if (groups.length <= 1) {
		return [...rows];
	}
	const totalTokens = groups.reduce((total, group) => total + Math.max(0, group.tokens), 0);
	const targetTokens = Math.max(1, Math.floor(totalTokens / 2));
	let selectedGroups: Array<{ rows: Row[]; tokens: number }> = [];
	let selectedTokens = 0;
	for (const group of groups) {
		if (
			selectedGroups.length > 0 &&
			selectedTokens >= compactionOverBudgetFallbackMinSelectedTokens &&
			selectedTokens + group.tokens > targetTokens
		) {
			break;
		}
		selectedGroups.push(group);
		selectedTokens += group.tokens;
		if (selectedTokens >= targetTokens) {
			break;
		}
	}
	if (selectedGroups.length === 0 || selectedGroups.length >= groups.length) {
		selectedGroups = groups.slice(0, -1);
	}
	const reducedTokens = selectedGroups.reduce((total, group) => total + Math.max(0, group.tokens), 0);
	if (reducedTokens < compactionOverBudgetFallbackMinSelectedTokens) {
		return [...rows];
	}
	return selectedGroups.flatMap((group) => group.rows);
}

function loopMessageCompactionGroups<Row extends CompactionMessageRow>(
	rows: readonly CompactionCandidateEstimate<Row>[],
): Array<{ rows: Row[]; tokens: number }> {
	const groups: Array<{ rows: Row[]; tokens: number }> = [];
	for (let index = 0; index < rows.length; index += 1) {
		const current = rows[index]!;
		const message = loopMessageChatMessageFromRow(current.row);
		if (message.role !== 'assistant' || !message.tool_calls?.length) {
			groups.push({ rows: [current.row], tokens: current.tokens });
			continue;
		}
		const expectedToolCallIds = new Set(message.tool_calls.map((toolCall) => toolCall.id));
		const groupRows = [current.row];
		let tokens = current.tokens;
		let scan = index + 1;
		while (scan < rows.length) {
			const next = rows[scan]!;
			const nextMessage = loopMessageChatMessageFromRow(next.row);
			if (nextMessage.role !== 'tool' || !nextMessage.tool_call_id || !expectedToolCallIds.has(nextMessage.tool_call_id)) {
				break;
			}
			groupRows.push(next.row);
			tokens += next.tokens;
			expectedToolCallIds.delete(nextMessage.tool_call_id);
			scan += 1;
			if (expectedToolCallIds.size === 0) {
				break;
			}
		}
		groups.push({ rows: groupRows, tokens });
		index = scan - 1;
	}
	return groups;
}

export function loopMessageChatMessageFromRow(row: Pick<CompactionMessageRow, 'message_json'>): ChatMessage {
	const parsed = JSON.parse(row.message_json) as unknown;
	const record = runtimeRecord(parsed);
	const role = record.role;
	if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
		return { role: 'assistant', content: '' };
	}
	return parsed as ChatMessage;
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
