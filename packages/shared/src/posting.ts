import {
	type BotEffectivePostingSettings,
	type PostingSettings,
	type PostingSettingsInput,
} from "./model";

export const defaultThreadBodyCharacters = 8_000;
export const defaultCommentBodyCharacters = 4_000;

export const defaultPostingSettings: BotEffectivePostingSettings = {
	threadBodyCharacters: defaultThreadBodyCharacters,
	commentBodyCharacters: defaultCommentBodyCharacters,
};

export function postingHardLimit(softLimit: number): number {
	return softLimit * 2;
}

export function postingSettingsHasValues(settings: PostingSettings | undefined): settings is PostingSettings {
	return settings?.threadBodyCharacters !== undefined || settings?.commentBodyCharacters !== undefined;
}

export function mergePostingSettings(
	current: PostingSettings | undefined,
	patch: PostingSettingsInput | undefined,
): PostingSettings {
	const merged: PostingSettings = { ...(current ?? {}) };
	if (!patch) {
		return merged;
	}
	if (patch.threadBodyCharacters !== undefined) {
		if (patch.threadBodyCharacters === null) {
			delete merged.threadBodyCharacters;
		} else {
			merged.threadBodyCharacters = patch.threadBodyCharacters;
		}
	}
	if (patch.commentBodyCharacters !== undefined) {
		if (patch.commentBodyCharacters === null) {
			delete merged.commentBodyCharacters;
		} else {
			merged.commentBodyCharacters = patch.commentBodyCharacters;
		}
	}
	return merged;
}

export function effectivePostingSettings(
	worldSettings: PostingSettings | undefined,
	botSettings: PostingSettings | undefined,
): BotEffectivePostingSettings {
	return {
		threadBodyCharacters: effectivePostingLimit(
			defaultThreadBodyCharacters,
			worldSettings?.threadBodyCharacters,
			botSettings?.threadBodyCharacters,
		),
		commentBodyCharacters: effectivePostingLimit(
			defaultCommentBodyCharacters,
			worldSettings?.commentBodyCharacters,
			botSettings?.commentBodyCharacters,
		),
	};
}

function effectivePostingLimit(defaultLimit: number, worldLimit: number | undefined, botLimit: number | undefined): number {
	return Math.min(
		defaultLimit,
		positiveIntegerOrDefault(worldLimit, defaultLimit),
		positiveIntegerOrDefault(botLimit, defaultLimit),
	);
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	return Number.isInteger(value) && value > 0 ? value : fallback;
}
