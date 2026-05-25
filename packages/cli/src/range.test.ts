import { describe, expect, it } from "vitest";
import { CliUsageError } from "./args.ts";
import { parseRange } from "./range.ts";

describe("CLI ranges", () => {
	it("uses 1-based inclusive default ranges", () => {
		expect(parseRange(undefined)).toEqual({ start: 1, end: 40, offset: 0, limit: 40 });
	});

	it("converts inclusive ranges to offset and limit", () => {
		expect(parseRange("41-80")).toEqual({ start: 41, end: 80, offset: 40, limit: 40 });
	});

	it("rejects invalid ranges", () => {
		expect(() => parseRange("0-10")).toThrow(CliUsageError);
		expect(() => parseRange("10-1")).toThrow(CliUsageError);
		expect(() => parseRange("10")).toThrow(CliUsageError);
	});
});
