import type { ParticipantTimeSettings } from "./model";

export const defaultParticipantTimeSettings = Object.freeze({ mode: "relative" as const, timezone: "UTC" });

export const removedDatetimeToolMessage = "The datetime tool was removed. Use timeSettings.mode and timeSettings.timezone instead.";

export function hasRemovedDatetimeTool(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const toolSettings = (value as Record<string, unknown>).toolSettings;
	if (!toolSettings || typeof toolSettings !== "object" || Array.isArray(toolSettings)) return false;
	const openRouter = (toolSettings as Record<string, unknown>).openRouter;
	return Boolean(openRouter && typeof openRouter === "object" && Object.hasOwn(openRouter, "datetime"));
}

export function isParticipantTimezone(value: string): boolean {
	// Intl also accepts numeric offsets. The setting requires a named IANA zone.
	if (!value || /^[+-]/.test(value)) return false;
	try {
		new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
		return true;
	} catch {
		return false;
	}
}

export function participantTimeSettings(current?: Partial<ParticipantTimeSettings>, patch?: Partial<ParticipantTimeSettings>): ParticipantTimeSettings {
	return {
		mode: patch?.mode ?? current?.mode ?? defaultParticipantTimeSettings.mode,
		timezone: patch?.timezone ?? current?.timezone ?? defaultParticipantTimeSettings.timezone,
	};
}

/** Calendar months use the creation day, clamped to the target month's last day. */
function monthAnniversary(origin: Date, months: number): number {
	const target = new Date(origin.getTime());
	target.setUTCDate(1);
	target.setUTCMonth(origin.getUTCMonth() + months);
	const lastDay = new Date(target.getTime());
	lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
	target.setUTCDate(Math.min(origin.getUTCDate(), lastDay.getUTCDate()));
	return target.getTime();
}

export function formatParticipantTime(instant: string | number | Date, settings: ParticipantTimeSettings, accountCreatedAt: string | number | Date): string {
	const timestamp = new Date(instant).getTime();
	const creation = new Date(accountCreatedAt).getTime();
	if (!Number.isFinite(timestamp) || !Number.isFinite(creation)) throw new RangeError("Participant time requires valid instants.");
	if (settings.mode === "absolute") {
		const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: settings.timezone, calendar: "iso8601", numberingSystem: "latn",
			year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
			hourCycle: "h23", timeZoneName: "longOffset",
		}).formatToParts(timestamp);
		const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
		const offset = part("timeZoneName").replace(/^GMT/, "") || "+00:00";
		return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}${offset}`;
	}
	const negative = timestamp < creation;
	const origin = new Date(creation);
	const endDate = new Date(timestamp);
	const direction = negative ? -1 : 1;
	let months = Math.abs((endDate.getUTCFullYear() - origin.getUTCFullYear()) * 12 + endDate.getUTCMonth() - origin.getUTCMonth());
	if (direction * (monthAnniversary(origin, direction * months) - timestamp) > 0) months -= 1;
	let remaining = Math.floor(Math.abs(timestamp - monthAnniversary(origin, direction * months)) / 60_000);
	const days = Math.floor(remaining / 1440);
	remaining %= 1440;
	const years = Math.floor(months / 12);
	const monthPart = months % 12;
	return `${negative ? "-" : ""}${years ? `${years}y` : ""}${monthPart ? `${monthPart}m` : ""}${days}d${Math.floor(remaining / 60)}h${remaining % 60}m`;
}
