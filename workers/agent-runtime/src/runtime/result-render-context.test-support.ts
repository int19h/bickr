import { botText, type BotText } from '../localization';
import { resultViewBuildRenderContext, type ResultRenderContext, type ResultTimeContext, type ToolResultView } from './tool-result-views';

export const testResultTime: ResultTimeContext = { settings: { mode: 'relative', timezone: 'UTC' }, createdAt: '2026-10-01T00:00:00Z' };
export const testResultContext: ResultRenderContext = Object.freeze({ text: botText('en'), time: testResultTime, handles: new Map() });
export function testViewRenderContext(view: ToolResultView, text: BotText, handles?: ResultRenderContext['handles'], time: ResultTimeContext = testResultTime): ResultRenderContext {
	const initial = resultViewBuildRenderContext(view, { text, time });
	return Object.freeze({ text, time, handles: handles ?? initial.handles });
}
