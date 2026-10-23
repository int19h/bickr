import type { BotDocument } from "./model";
import { participantTimeSettings } from "./participant-time";

// Complete the bot KV sweep census before you remove this adapter.
// The census must find no legacy datetime fields or missing timeSettings.
// Then retire rollback writers and advance schemaVersion past 2.
// Remove this adapter, both migration routes, and the bot sweep callback together.
export function migrateParticipantTime(document: BotDocument): BotDocument {
	const legacy = document.toolSettings?.openRouter as (NonNullable<BotDocument["toolSettings"]["openRouter"]> & {
		datetime?: { enabled?: boolean; timezone?: string };
	}) | undefined;
	const settings = document.timeSettings ?? (legacy?.datetime?.enabled
		? { mode: "absolute" as const, timezone: legacy.datetime.timezone || "UTC" }
		: participantTimeSettings());
	const { datetime: _removed, ...openRouter } = legacy ?? {};
	return {
		...document,
		timeSettings: { mode: settings.mode, timezone: settings.timezone },
		toolSettings: {
			...document.toolSettings,
			...(legacy ? { openRouter } : {}),
		},
	};
}
