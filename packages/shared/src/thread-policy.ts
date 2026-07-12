import {
	type EffectiveThreadSettings,
	type ThreadLock,
	type ThreadSettings,
	type ThreadSettingsInput,
} from "./model";

export const defaultThreadCommentLimit = 200;

export const defaultThreadSettings: EffectiveThreadSettings = {
	commentLimit: defaultThreadCommentLimit,
};

export function threadSettingsHasValues(settings: ThreadSettings | undefined): settings is ThreadSettings {
	return settings?.commentLimit !== undefined;
}

export function mergeThreadSettings(
	current: ThreadSettings | undefined,
	patch: ThreadSettingsInput | undefined,
): ThreadSettings {
	const merged: ThreadSettings = { ...(current ?? {}) };
	if (patch?.commentLimit === null) {
		delete merged.commentLimit;
	} else if (patch?.commentLimit !== undefined) {
		merged.commentLimit = patch.commentLimit;
	}
	return merged;
}

export function effectiveThreadSettings(
	worldSettings: ThreadSettings | undefined,
	forumSettings: ThreadSettings | undefined,
): EffectiveThreadSettings {
	return {
		commentLimit: Math.min(
			defaultThreadCommentLimit,
			positiveIntegerOrDefault(worldSettings?.commentLimit, defaultThreadCommentLimit),
			positiveIntegerOrDefault(forumSettings?.commentLimit, defaultThreadCommentLimit),
		),
	};
}

export function threadLock(commentCount: number, settings: EffectiveThreadSettings): ThreadLock | undefined {
	return commentCount >= settings.commentLimit ? { kind: "comment_limit", limit: settings.commentLimit } : undefined;
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
