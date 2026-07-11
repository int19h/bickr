import { describe, expect, it } from "vitest";
import {
	readOptionalJsonBody,
	runtimeMonitorBackfillCursor,
	runtimeMonitorInitialBackfillLimit,
} from "../workers/agent-runtime/src/index";
import { InputError } from "../packages/shared/src/validation";

describe("runtime monitor backfill", () => {
	it("caps initial monitor backfills and leaves positive reconnect cursors uncapped", () => {
		expect(runtimeMonitorBackfillCursor(new URL("https://example.test/monitor"), "afterMessage")).toEqual({
			afterSeq: 0,
			initialLimit: runtimeMonitorInitialBackfillLimit,
		});
		expect(runtimeMonitorBackfillCursor(new URL("https://example.test/monitor?afterMessage=42"), "afterMessage")).toEqual({
			afterSeq: 42,
		});
		expect(runtimeMonitorBackfillCursor(new URL("https://example.test/monitor?after=7"), "afterEvent")).toEqual({
			afterSeq: 7,
		});
		expect(runtimeMonitorBackfillCursor(new URL("https://example.test/monitor?afterMessage=0"), "afterMessage")).toEqual({
			afterSeq: 0,
			initialLimit: runtimeMonitorInitialBackfillLimit,
		});
	});

});

describe("readOptionalJsonBody", () => {
	it("wraps malformed optional JSON as a typed input error", async () => {
		await expect(readOptionalJsonBody(new Request("https://example.test", {
			method: "POST",
			body: "{",
			headers: { "content-type": "application/json" },
		}))).rejects.toBeInstanceOf(InputError);
		await expect(readOptionalJsonBody(new Request("https://example.test", {
			method: "POST",
			body: "{",
			headers: { "content-type": "application/json" },
		}))).rejects.toMatchObject({
			message: "Request body must be valid JSON.",
		});
	});
});
