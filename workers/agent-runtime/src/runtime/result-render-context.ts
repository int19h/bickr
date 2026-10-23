import type { EffectiveBotDocument } from '@bickr/shared/model';
import type { D1DatabaseLike } from '@bickr/shared/storage';
import { participantTimeSettingsOf } from '@bickr/shared/participant-time-migration';
import { botTextFor } from '../localization';
import { currentResultHandles, resultHandleKey, type CurrentResultHandle } from './result-handles';
import { toolResultViewFromRow, type StoredResultViewColumns } from './result-messages';
import { resultViewReferences, type ResultRenderContext, type ToolResultView, producedResultHandles } from './tool-result-views';

/** Each reader loads one snapshot for its complete set of views. */
export async function buildResultRenderContext(db: D1DatabaseLike, bot: EffectiveBotDocument, views: readonly ToolResultView[]): Promise<ResultRenderContext> {
	const references = views.flatMap(resultViewReferences);
	const current = await currentResultHandles(db, references);
	const handles = new Map(references.map(ref => {
		// Keep absent rows deleted when new results extend this request.
		const state = current.get(resultHandleKey(ref));
		return [resultHandleKey(ref), Object.freeze(state ?? { kind: 'deleted' as const })] as const;
	}));
	const time = participantTimeSettingsOf(bot);
	return Object.freeze({ text: botTextFor(bot), time: Object.freeze({ settings: Object.freeze({ mode: time.mode, timezone: time.timezone }), createdAt: bot.createdAt }), handles });
}

export function resultViewsFromRows(rows: readonly StoredResultViewColumns[]): ToolResultView[] {
	return rows.flatMap(row => { const view = toolResultViewFromRow(row); return view ? [view] : []; });
}

/** New results supply current references. Existing references keep the request snapshot. */
export function contextWithProducedReferences(context: ResultRenderContext, views: readonly ToolResultView[]): ResultRenderContext {
	const handles: Map<string, CurrentResultHandle> = new Map(views.flatMap(view => [...producedResultHandles(view)]));
	for (const [key, value] of context.handles) handles.set(key, value);
	return Object.freeze({ text: context.text, time: context.time, handles });
}
