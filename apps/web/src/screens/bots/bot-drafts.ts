import {
	defaultReasoningPrefill,
	localizedText,
	type BotInferenceSettings,
	type BotSummary,
	type BotToolSettings,
	type ChirperImportPreview,
	type CreateBotInput,
	type LanguageTag,
	type UpdateBotInput,
} from "@bickr/shared/model";
import { isOpenRouterProviderBaseUrl } from "@bickr/shared/inference-settings";
import { isValidHandleText, maxBotPromptLength, sanitizeHandleInput } from "@bickr/shared/validation";
import { parseOptionalPositiveInteger, parsePositiveInteger } from "../../components/record-display";
import { textLang } from "../../components/form-fields";
import { languageDraftValue, languageInputValue } from "../../components/ui-text";
import { defaultLanguageTag } from "../../language";
import {
	effectiveInferenceSettingsModel,
	inferenceInheritanceContext,
	numericDraftValue,
} from "../../settings-drafts/common";
import { toolInputFromDraft, type BotToolDraft } from "../../tool-settings-draft";
import { textValue } from "../../ui";
import { secondsToMinutes } from "./runtime-utils";

export type IncludeLanguageInSystemPromptDraft = "include" | "exclude" | "inherit";
export const providerRoutingPlaceholder = "{\n\n}";

export type BotDraft = {
	handle: string;
	language: string;
	includeLanguageInSystemPrompt: IncludeLanguageInSystemPromptDraft;
	displayName: string;
	shortBio: string;
	prompt: string;
	cloneSourceBotId?: string;
	avatarUrl?: string;
	importSource?: ChirperImportPreview["importSource"];
};

export type BotEditDraft = {
	language: string;
	includeLanguageInSystemPrompt: IncludeLanguageInSystemPromptDraft;
	displayName: string;
	shortBio: string;
	prompt: string;
	recurringPromptEnabled: boolean;
	recurringPrompt: string;
	tools: BotToolDraft;
	threadBodyCharacters: string;
	commentBodyCharacters: string;
	tickIntervalMinutes: string;
	allowEarlyLogOff: boolean;
	contextWindowTokens: string;
	compactionSummaryPercent: string;
	compactionMaxCharacters: string;
	maxToolCallsPerTick: string;
	maxSuccessfulToolCallsPerIteration: string;
	maxGeneratedTokensPerTick: string;
	maxGeneratedTokensPerIteration: string;
};

export type BotEditParsedDraft = {
	tickIntervalMinutes: number;
	contextWindowTokens: number | null;
	compactionSummaryPercent: number | null;
	compactionMaxCharacters: number | null;
	maxToolCallsPerTick: number | null;
	maxSuccessfulToolCallsPerIteration: number | null;
	maxGeneratedTokensPerTick: number | null;
	maxGeneratedTokensPerIteration: number | null;
	threadBodyCharacters: number | null;
	commentBodyCharacters: number | null;
};

const emptyBotDraft: BotDraft = {
	handle: "",
	language: "en",
	includeLanguageInSystemPrompt: "include",
	displayName: "",
	shortBio: "",
	prompt: "",
};

export function emptyBotDraftForLanguage(language: LanguageTag | string | null | undefined): BotDraft {
	return {
		...emptyBotDraft,
		language: languageDraftValue(language, defaultLanguageTag),
	};
}

export function toolDraftFromSettings(settings?: BotToolSettings): BotToolDraft {
	const openRouter = settings?.openRouter;
	return {
		openRouter: {
			datetime: {
				enabled: Boolean(openRouter?.datetime?.enabled),
				timezone: openRouter?.datetime?.timezone ?? "",
			},
			webSearch: {
				enabled: Boolean(openRouter?.webSearch?.enabled),
				engine: openRouter?.webSearch?.engine ?? "",
				maxResults: numericDraftValue(openRouter?.webSearch?.maxResults),
				maxTotalResults: numericDraftValue(openRouter?.webSearch?.maxTotalResults),
				searchContextSize: openRouter?.webSearch?.searchContextSize ?? "",
				userLocationCity: openRouter?.webSearch?.userLocation?.city ?? "",
				userLocationRegion: openRouter?.webSearch?.userLocation?.region ?? "",
				userLocationCountry: openRouter?.webSearch?.userLocation?.country ?? "",
				userLocationTimezone: openRouter?.webSearch?.userLocation?.timezone ?? "",
				allowedDomains: domainDraftValue(openRouter?.webSearch?.allowedDomains),
				excludedDomains: domainDraftValue(openRouter?.webSearch?.excludedDomains),
			},
			webFetch: {
				enabled: Boolean(openRouter?.webFetch?.enabled),
				engine: openRouter?.webFetch?.engine ?? "",
				maxUses: numericDraftValue(openRouter?.webFetch?.maxUses),
				maxContentTokens: numericDraftValue(openRouter?.webFetch?.maxContentTokens),
				allowedDomains: domainDraftValue(openRouter?.webFetch?.allowedDomains),
				blockedDomains: domainDraftValue(openRouter?.webFetch?.blockedDomains),
			},
		},
	};
}

export function toolDraftChanged(draft: BotToolDraft, settings?: BotToolSettings): boolean {
	return JSON.stringify(toolInputFromDraft(draft)) !== JSON.stringify(toolInputFromDraft(toolDraftFromSettings(settings)));
}

export function toolDraftValid(draft: BotToolDraft): boolean {
	return (
		validOptionalTimezone(draft.openRouter.datetime.timezone) &&
		validOptionalInteger(draft.openRouter.webSearch.maxResults, 1, 25) &&
		validOptionalInteger(draft.openRouter.webSearch.maxTotalResults, 1) &&
		validOptionalTimezone(draft.openRouter.webSearch.userLocationTimezone) &&
		validOptionalTextLength(draft.openRouter.webSearch.userLocationCountry, 2) &&
		validOptionalInteger(draft.openRouter.webFetch.maxUses, 1) &&
		validOptionalInteger(draft.openRouter.webFetch.maxContentTokens, 1)
	);
}

export function isOpenRouterBaseUrlForTools(draftBaseUrl: string, inheritedBaseUrl?: string): boolean {
	return isOpenRouterProviderBaseUrl(draftBaseUrl.trim() || inheritedBaseUrl?.trim() || "https://openrouter.ai/api/v1");
}

/**
 * Identity of everything a computed context budget depends on. Provider and
 * model inputs now come from the participant's inference configuration, so its
 * fingerprint stands in for them: a configuration edit invalidates the cached
 * budget without the editor resolving any inference value itself.
 */
export function botPromptBudgetRequestKey(
	botId: string,
	botHandle: string,
	draft: {
		allowEarlyLogOff: boolean;
		compactionMaxCharacters: string;
		compactionSummaryPercent: string;
		contextWindowTokens: string;
		displayName: string;
		language: string;
		includeLanguageInSystemPrompt: boolean;
		recurringPromptEnabled: boolean;
		recurringPrompt: string;
		prompt: string;
		worldPrompt: string;
		commentBodyCharacters: string;
		shortBio: string;
		threadBodyCharacters: string;
		tools: BotToolDraft;
	},
	inferenceFingerprint: string,
): string {
	return JSON.stringify({
		botId,
		displayName: draft.displayName,
		language: draft.language,
		includeLanguageInSystemPrompt: draft.includeLanguageInSystemPrompt,
		inferenceFingerprint,
		prompt: draft.prompt,
		worldPrompt: draft.worldPrompt,
		allowEarlyLogOff: draft.allowEarlyLogOff,
		compactionMaxCharacters: draft.compactionMaxCharacters.trim(),
		compactionSummaryPercent: draft.compactionSummaryPercent.trim(),
		contextWindowTokens: draft.contextWindowTokens.trim(),
		commentBodyCharacters: draft.commentBodyCharacters.trim(),
		recurringPrompt:
			draft.recurringPromptEnabled ?
				draft.recurringPrompt.trim() ? draft.recurringPrompt : defaultReasoningPrefill(botHandle)
			:	null,
		recurringPromptEnabled: draft.recurringPromptEnabled,
		shortBio: draft.shortBio,
		threadBodyCharacters: draft.threadBodyCharacters.trim(),
		tools: toolInputFromDraft(draft.tools),
	});
}

export function includeLanguageInSystemPromptDraftFromStored(
	value: boolean | null | undefined,
	linkedClone: boolean,
): IncludeLanguageInSystemPromptDraft {
	if (linkedClone && value === null) {
		return "inherit";
	}
	return value ? "include" : "exclude";
}

export function includeLanguageInSystemPromptInputFromDraft(
	value: IncludeLanguageInSystemPromptDraft,
	linkedClone: boolean,
): boolean | null {
	if (value === "inherit") {
		return linkedClone ? null : false;
	}
	return value === "include";
}

export function effectiveIncludeLanguageInSystemPromptDraft(
	value: IncludeLanguageInSystemPromptDraft,
	inheritedValue: boolean | null | undefined,
): boolean {
	return value === "inherit" ? inheritedValue === true : value === "include";
}

export function botEditDraftFromBot(bot: BotSummary): BotEditDraft {
	const profileOverrides = bot.localOverrides;
	const linkedClone = Boolean(bot.cloneSource?.linked);
	const inferenceSettings = botEditableInferenceSettings(bot);
	return {
		language:
			profileOverrides ?
				profileOverrides.language ?? ""
			:	languageDraftValue(bot.language, textLang(bot.displayName) ?? defaultLanguageTag),
		includeLanguageInSystemPrompt: includeLanguageInSystemPromptDraftFromStored(
			linkedClone ? profileOverrides?.includeLanguageInSystemPrompt ?? null : bot.includeLanguageInSystemPrompt,
			linkedClone,
		),
		displayName: textValue(profileOverrides?.displayName ?? bot.displayName),
		shortBio: textValue(profileOverrides?.shortBio ?? bot.shortBio),
		prompt: textValue(profileOverrides?.prompt ?? bot.prompt ?? ""),
		recurringPromptEnabled: inferenceSettings.recurringPromptEnabled !== false,
		recurringPrompt: textValue(inferenceSettings.recurringPrompt ?? ""),
		tools: toolDraftFromSettings(bot.toolSettings),
		threadBodyCharacters: optionalNumberDraftValue(bot.postingSettings.threadBodyCharacters),
		commentBodyCharacters: optionalNumberDraftValue(bot.postingSettings.commentBodyCharacters),
		tickIntervalMinutes: String(secondsToMinutes(bot.tickSettings.intervalSeconds)),
		allowEarlyLogOff: bot.effectiveTickSettings.allowEarlyLogOff,
		contextWindowTokens: optionalNumberDraftValue(bot.tickSettings.contextWindowTokens),
		compactionSummaryPercent: optionalNumberDraftValue(bot.tickSettings.compactionSummaryPercent),
		compactionMaxCharacters: optionalNumberDraftValue(bot.tickSettings.compactionMaxCharacters),
		maxToolCallsPerTick: optionalNumberDraftValue(bot.tickSettings.maxToolCallsPerTick),
		maxSuccessfulToolCallsPerIteration: optionalNumberDraftValue(bot.tickSettings.maxSuccessfulToolCallsPerIteration),
		maxGeneratedTokensPerTick: optionalNumberDraftValue(bot.tickSettings.maxGeneratedTokensPerTick),
		maxGeneratedTokensPerIteration: optionalNumberDraftValue(bot.tickSettings.maxGeneratedTokensPerIteration),
	};
}

export function parseBotEditDraft(draft: BotEditDraft): BotEditParsedDraft {
	return {
		tickIntervalMinutes: parsePositiveInteger(draft.tickIntervalMinutes),
		contextWindowTokens: parseOptionalPositiveInteger(draft.contextWindowTokens),
		compactionSummaryPercent: parseOptionalPositiveInteger(draft.compactionSummaryPercent),
		compactionMaxCharacters: parseOptionalPositiveInteger(draft.compactionMaxCharacters),
		maxToolCallsPerTick: parseOptionalPositiveInteger(draft.maxToolCallsPerTick),
		maxSuccessfulToolCallsPerIteration: parseOptionalPositiveInteger(draft.maxSuccessfulToolCallsPerIteration),
		maxGeneratedTokensPerTick: parseOptionalPositiveInteger(draft.maxGeneratedTokensPerTick),
		maxGeneratedTokensPerIteration: parseOptionalPositiveInteger(draft.maxGeneratedTokensPerIteration),
		threadBodyCharacters: parseOptionalPositiveInteger(draft.threadBodyCharacters),
		commentBodyCharacters: parseOptionalPositiveInteger(draft.commentBodyCharacters),
	};
}

export function updateBotInputFromEditDraft(
	draft: BotEditDraft,
	parsed: BotEditParsedDraft,
	linkedClone: boolean,
): UpdateBotInput {
	const language = languageInputValue(draft.language) ?? (linkedClone ? null : defaultLanguageTag);
	return {
		language,
		includeLanguageInSystemPrompt: includeLanguageInSystemPromptInputFromDraft(
			draft.includeLanguageInSystemPrompt,
			linkedClone,
		),
		displayName: localizedText(draft.displayName, language),
		shortBio: localizedText(draft.shortBio, language),
		prompt: localizedText(draft.prompt, language),
		// Only the participant-owned recurring prompt travels here. Reusable
		// inference fields live in the configuration graph, and an empty legacy
		// mask leaves every graph field untouched.
		inferenceSettings: {
			recurringPromptEnabled: draft.recurringPromptEnabled,
			recurringPrompt: draft.recurringPrompt.trim() ? localizedText(draft.recurringPrompt, language) : null,
		},
		toolSettings: toolInputFromDraft(draft.tools),
		postingSettings: {
			threadBodyCharacters: parsed.threadBodyCharacters,
			commentBodyCharacters: parsed.commentBodyCharacters,
		},
		tickSettings: {
			intervalSeconds: parsed.tickIntervalMinutes * 60,
			allowEarlyLogOff: draft.allowEarlyLogOff,
			contextWindowTokens: parsed.contextWindowTokens,
			compactionSummaryPercent: parsed.compactionSummaryPercent,
			compactionMaxCharacters: parsed.compactionMaxCharacters,
			maxToolCallsPerTick: parsed.maxToolCallsPerTick,
			maxSuccessfulToolCallsPerIteration: parsed.maxSuccessfulToolCallsPerIteration,
			maxGeneratedTokensPerTick: parsed.maxGeneratedTokensPerTick,
			maxGeneratedTokensPerIteration: parsed.maxGeneratedTokensPerIteration,
		},
	};
}

export function createBotInputFromDraft(draft: BotDraft): CreateBotInput {
	const language = languageInputValue(draft.language) ?? (draft.cloneSourceBotId ? null : defaultLanguageTag);
	return {
		handle: draft.handle,
		language,
		includeLanguageInSystemPrompt: includeLanguageInSystemPromptInputFromDraft(
			draft.includeLanguageInSystemPrompt,
			Boolean(draft.cloneSourceBotId),
		),
		displayName: localizedText(draft.displayName, language),
		shortBio: localizedText(draft.shortBio, language),
		prompt: localizedText(draft.prompt, language),
		...(draft.cloneSourceBotId ? { cloneSourceBotId: draft.cloneSourceBotId } : {}),
		...(draft.importSource ? { importSource: draft.importSource } : {}),
	};
}

export function botEditableInferenceSettings(bot: BotSummary): BotInferenceSettings {
	return bot.localOverrides?.inferenceSettings ?? bot.inferenceSettings;
}

export function effectiveBotModel(bot: BotSummary, inherited?: BotInferenceSettings | null): string {
	return effectiveInferenceSettingsModel(bot.inferenceSettings, inferenceInheritanceContext(inherited));
}

export function optionalNumberDraftValue(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

export function domainDraftValue(value: string[] | undefined): string {
	return value?.join(", ") ?? "";
}

export function validOptionalInteger(value: string, min: number, max = Number.MAX_SAFE_INTEGER): boolean {
	const trimmed = value.trim();
	if (!trimmed) {
		return true;
	}
	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

export function validOptionalTimezone(value: string): boolean {
	const timezone = value.trim();
	if (!timezone) {
		return true;
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
		return true;
	} catch {
		return false;
	}
}

export function validOptionalTextLength(value: string, maxLength: number): boolean {
	const trimmed = value.trim();
	return trimmed.length === 0 || trimmed.length <= maxLength;
}

export function isValidBotDraft(draft: BotDraft): boolean {
	return (
		isValidHandle(draft.handle) &&
		draft.language.trim().length > 0 &&
		draft.displayName.trim().length > 0 &&
		draft.shortBio.trim().length > 0 &&
		draft.prompt.trim().length > 0 &&
		draft.prompt.length <= maxBotPromptLength
	);
}

export function isValidCloneBotDraft(draft: BotDraft): boolean {
	return isValidHandle(draft.handle) && draft.prompt.length <= maxBotPromptLength;
}

export function botDraftFromExistingBot(bot: BotSummary): BotDraft {
	return {
		handle: bot.handle,
		language: "",
		includeLanguageInSystemPrompt: "inherit",
		displayName: "",
		shortBio: "",
		prompt: "",
		cloneSourceBotId: bot.id,
	};
}

export function isValidHandle(value: string): boolean {
	return isValidHandleText(value);
}


export function slugify(value: string): string {
	return sanitizeHandleInput(value);
}
