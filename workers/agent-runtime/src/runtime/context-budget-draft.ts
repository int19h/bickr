import type { BotContextBudgetInput, EffectiveBotDocument } from '@bickr/shared/model';
import { resolveInstructionLocale } from '@bickr/shared/instruction-language';
import { mergeTickSettings, mergeToolSettings } from '@bickr/shared/repository';
import { mergePostingSettings } from '@bickr/shared/posting';

/** Build the same draft the editor will save before composing provider prompts. */
export function contextBudgetDraft(current: EffectiveBotDocument, input?: BotContextBudgetInput): EffectiveBotDocument {
	const language = input?.language === undefined ? current.language : input.language;
	const instructionLanguage = input?.instructionLanguage ?? current.instructionLanguage;
	return {
		...current,
		language,
		instructionLanguage,
		instructionLocale: resolveInstructionLocale(instructionLanguage, language,
			current.cloneSource?.linked ? current.cloneSource.sourceBot?.instructionLocale ?? null : null),
		includeLanguageInSystemPrompt: input?.includeLanguageInSystemPrompt ?? current.includeLanguageInSystemPrompt ?? false,
		displayName: input?.displayName === undefined ? current.displayName : { lang: language, text: input.displayName },
		prompt: input?.prompt === undefined ? current.prompt : { lang: language, text: input.prompt },
		shortBio: input?.shortBio === undefined ? current.shortBio : { lang: language, text: input.shortBio },
		toolSettings: mergeToolSettings(current.toolSettings, input?.toolSettings),
		postingSettings: mergePostingSettings(current.postingSettings, input?.postingSettings),
		tickSettings: mergeTickSettings(current.tickSettings, input?.tickSettings),
	};
}
