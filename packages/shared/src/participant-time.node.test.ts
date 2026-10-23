import { describe, expect, it } from "vitest";
import { formatParticipantTime, isParticipantTimezone, participantTimeSettings } from "./participant-time";
import { parseParticipantTimeSettings, parseUpdateBotInput, InputError } from "./validation";
import { migrateParticipantTime, participantTimeSettingsOf } from "./participant-time-migration";
import type { BotDocument } from "./model";

const relative = participantTimeSettings();
describe("participant time", () => {
	it.each([
		["2024-01-31T10:20:30Z", "2024-01-31T10:41:29Z", "0d0h20m"],
		["2024-01-31T10:20:30Z", "2024-02-29T10:20:30Z", "1m0d0h0m"],
		["2023-01-31T10:20:30Z", "2023-02-28T10:20:30Z", "1m0d0h0m"],
		["2024-01-31T10:20:30Z", "2024-03-30T10:20:30Z", "1m30d0h0m"],
		["2024-02-29T10:20:30Z", "2025-02-28T10:20:30Z", "1y0d0h0m"],
		["2024-02-29T10:20:30Z", "2028-02-29T10:20:30Z", "4y0d0h0m"],
		["2024-01-01T00:00:00Z", "2026-11-05T05:30:59Z", "2y10m4d5h30m"],
		["2026-03-31T00:00:00Z", "2026-02-28T00:00:00Z", "-1m0d0h0m"],
		["2026-03-31T00:00:00Z", "2025-01-28T00:00:00Z", "-1y2m3d0h0m"],
		["2026-03-31T00:00:30Z", "2026-03-31T00:00:00Z", "-0d0h0m"],
	])("formats %s to %s", (creation, instant, expected) => {
		expect(formatParticipantTime(instant, relative, creation)).toBe(expected);
	});
	it.each([
		["UTC", "2026-10-23T08:07:59Z", "2026-10-23T08:07+00:00"],
		["Asia/Kolkata", "2026-10-23T08:07:59Z", "2026-10-23T13:37+05:30"],
		["America/St_Johns", "2026-01-23T08:07:59Z", "2026-01-23T04:37-03:30"],
		["America/Los_Angeles", "2026-03-08T09:59:59Z", "2026-03-08T01:59-08:00"],
		["America/Los_Angeles", "2026-03-08T10:00:00Z", "2026-03-08T03:00-07:00"],
		["America/Los_Angeles", "2026-11-01T08:30:00Z", "2026-11-01T01:30-07:00"],
		["America/Los_Angeles", "2026-11-01T09:30:00Z", "2026-11-01T01:30-08:00"],
	])("formats absolute time in %s", (timezone, instant, expected) => {
		expect(formatParticipantTime(instant, { mode: "absolute", timezone }, "2026-12-01T00:00:00Z")).toBe(expected);
	});
	it("ignores the timezone in relative mode and preserves it on a mode update", () => {
		expect(formatParticipantTime(60000, { mode: "relative", timezone: "Asia/Kolkata" }, 0)).toBe("0d0h1m");
		expect(participantTimeSettings({ mode: "absolute", timezone: "Asia/Kolkata" }, { mode: "relative" })).toEqual({ mode: "relative", timezone: new Intl.DateTimeFormat("en", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone });
	});
	it.each(["Mars/Olympus", "", "+02:00"])("rejects invalid named timezone %s", timezone => {
		expect(isParticipantTimezone(timezone)).toBe(false);
		expect(() => parseParticipantTimeSettings({ mode: "relative", timezone })).toThrow(InputError);
	});
	it.each([["utc", "UTC"], ["america/los_angeles", "America/Los_Angeles"]])("stores the canonical name for %s", (timezone, expected) => {
		expect(parseParticipantTimeSettings({ timezone })).toEqual({ timezone: expected });
		expect(participantTimeSettings(undefined, { timezone }).timezone).toBe(expected);
	});

	it("rejects the removed datetime input with the new setting name", () => {
		expect(() => parseUpdateBotInput({ toolSettings: { openRouter: { datetime: { enabled: false } } } })).toThrow(/timeSettings/);
	});
	it("does not copy unknown time fields", () => {
		expect(parseParticipantTimeSettings({ mode: "absolute", timezone: "UTC", secret: "internal" })).toEqual({ mode: "absolute", timezone: "UTC" });
	});
});

describe("participant datetime migration", () => {
	it.each([
		[{ enabled: true, timezone: "america/los_angeles" }, { mode: "absolute", timezone: "America/Los_Angeles" }],
		[{ enabled: true }, { mode: "absolute", timezone: "UTC" }],
		[{ enabled: true, timezone: "" }, { mode: "absolute", timezone: "UTC" }],
		[{ enabled: false, timezone: "Asia/Kolkata" }, relative],
		[undefined, relative],
	])("converts %j once", (datetime, expected) => {
		const document = { toolSettings: { openRouter: { datetime, webSearch: { enabled: true } } } } as unknown as BotDocument;
		const migrated = migrateParticipantTime(document);
		expect(migrated.timeSettings).toEqual(expected);
		expect(migrated.toolSettings.openRouter).toEqual({ webSearch: { enabled: true } });
		expect(migrateParticipantTime(migrated)).toEqual(migrated);
		expect(document.toolSettings.openRouter).toHaveProperty("datetime");
	});
	it("reads the legacy preference without changing the document", () => {
		const document = { toolSettings: { openRouter: { datetime: { enabled: true, timezone: "Europe/Paris" } } } } as unknown as BotDocument;
		const before = JSON.stringify(document);
		expect(participantTimeSettingsOf(document)).toEqual({ mode: "absolute", timezone: "Europe/Paris" });
		expect(JSON.stringify(document)).toBe(before);
		expect(participantTimeSettingsOf({ ...document, timeSettings: relative })).toEqual(relative);
	});

	it("keeps an already migrated preference", () => {
		const document = { timeSettings: { mode: "relative", timezone: "Europe/Paris" }, toolSettings: {} } as BotDocument;
		expect(migrateParticipantTime(document)).toEqual(document);
	});
});
