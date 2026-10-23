import type { ParticipantTimeSettings } from "@bickr/shared/model";
import { isParticipantTimezone } from "@bickr/shared/participant-time";
import { CliUsageError, flagString } from "./args.ts";

export function timeSettingsFromFlags(flags: Map<string, string | boolean | string[]>): Partial<ParticipantTimeSettings> | undefined {
	const mode = flagString(flags, "time-mode");
	const timezone = flagString(flags, "time-timezone");
	if (mode !== undefined && mode !== "relative" && mode !== "absolute") throw new CliUsageError("Use --time-mode relative or absolute.");
	if (timezone !== undefined && !isParticipantTimezone(timezone)) throw new CliUsageError("Use an IANA timezone name for --time-timezone.");
	return mode !== undefined || timezone !== undefined ? { ...(mode !== undefined ? { mode } : {}), ...(timezone !== undefined ? { timezone } : {}) } : undefined;
}
