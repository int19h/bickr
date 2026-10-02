import type { BotContextBudgetInput, BotDocument } from '@bickr/shared/model';
import { mergeTickSettings, mergeToolSettings } from '@bickr/shared/repository';
import { mergePostingSettings } from '@bickr/shared/posting';

/** Build the same draft the editor will save before composing provider prompts. */
export function contextBudgetDraft(current: BotDocument, input?: BotContextBudgetInput): BotDocument {
	const language = input?.language === undefined ? current.language : input.language;
	return {
		...current,
		language,
		includeLanguageInSystemPrompt: input?.includeLanguageInSystemPrompt ?? current.includeLanguageInSystemPrompt ?? false,
		displayName: input?.displayName === undefined ? current.displayName : { lang: language, text: input.displayName },
		prompt: input?.prompt === undefined ? current.prompt : { lang: language, text: input.prompt },
		shortBio: input?.shortBio === undefined ? current.shortBio : { lang: language, text: input.shortBio },
		toolSettings: mergeToolSettings(current.toolSettings, input?.toolSettings),
		postingSettings: mergePostingSettings(current.postingSettings, input?.postingSettings),
		tickSettings: mergeTickSettings(current.tickSettings, input?.tickSettings),
	};
}
