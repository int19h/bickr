import type { BotDocument, ParticipantTimeSettings } from "./model";
import { participantTimeSettings } from "./participant-time";

// Complete the bot KV sweep census before you remove these adapters.
// The census must find no legacy datetime fields or missing timeSettings.
// Then retire rollback writers and advance schemaVersion past 2.
// Remove these adapters, both migration routes, and the bot sweep callback together.
export function participantTimeSettingsOf(document: { timeSettings?: ParticipantTimeSettings; toolSettings?: BotDocument["toolSettings"] }): ParticipantTimeSettings {
	if (document.timeSettings) return { mode: document.timeSettings.mode, timezone: document.timeSettings.timezone };
	const legacy = document.toolSettings?.openRouter as { datetime?: { enabled?: boolean; timezone?: string } } | undefined;
	return legacy?.datetime?.enabled
		? { mode: "absolute", timezone: legacy.datetime.timezone || "UTC" }
		: participantTimeSettings();
}

export function migrateParticipantTime(document: BotDocument): BotDocument {
	const { datetime: _removed, ...openRouter } = (document.toolSettings?.openRouter ?? {}) as NonNullable<BotDocument["toolSettings"]["openRouter"]> & { datetime?: unknown };
	return {
		...document,
		timeSettings: participantTimeSettings(participantTimeSettingsOf(document)),
		toolSettings: { ...document.toolSettings, ...(document.toolSettings?.openRouter ? { openRouter } : {}) },
	};
}
