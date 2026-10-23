import type { ChatMessage } from '../types';
import { botText } from '../localization';
import { renderToolResultView, toolResultViewSchemaVersion, type ToolResultView } from './tool-result-views';

const resultView = Symbol('toolResultView');
type MessageWithView = ChatMessage & { [resultView]?: ToolResultView };
export type StoredResultViewColumns = { tool_result_view_json?: string | null; tool_result_view_version?: number | null };
export type ResultViewRenderer = (view: ToolResultView) => string;

/** The symbol stays on this message. It never enters provider JSON. */
export function attachToolResultView(message: ChatMessage, view: ToolResultView): ChatMessage {
	if (message.role !== 'tool' || !message.tool_call_id) throw new Error('A result view needs a tool message and its call ID.');
	Object.defineProperty(message, resultView, { value: view });
	return message;
}
export function toolResultViewForMessage(message: ChatMessage): ToolResultView | undefined { return (message as MessageWithView)[resultView]; }

export function toolResultViewFromRow(row: StoredResultViewColumns): ToolResultView | null {
	if (!row.tool_result_view_json) return null;
	if (row.tool_result_view_version !== toolResultViewSchemaVersion) throw new Error('The tool result view schema version is not supported.');
	return JSON.parse(row.tool_result_view_json) as ToolResultView;
}
export function defaultResultViewRenderer(view: ToolResultView): string { return renderToolResultView(view, botText(view.instructionLocale)); }

export function renderStoredLoopMessage(row: { message_json: string } & StoredResultViewColumns, render: ResultViewRenderer = defaultResultViewRenderer): ChatMessage {
	const message = JSON.parse(row.message_json) as ChatMessage;
	const view = toolResultViewFromRow(row);
	if (view) return { role: 'tool', tool_call_id: message.tool_call_id, content: render(view) };
	// Legacy rows retain their text. After the active-row census and WI-F forced
	// compaction, advance the view schema version and remove this branch.
	return message;
}
