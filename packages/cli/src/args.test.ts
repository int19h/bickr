import { describe, expect, it } from "vitest";
import { CliUsageError, flagBoolean, flagString, parseCommandOptions, parseGlobalArgs } from "./args.ts";

describe("CLI argument parsing", () => {
	it("extracts global output and host flags without consuming command arguments", () => {
		const parsed = parseGlobalArgs(["--host", "https://test.bickr.social", "--json", "worlds", "list"]);
		expect(parsed.globals.host).toBe("https://test.bickr.social");
		expect(parsed.globals.json).toBe(true);
		expect(parsed.args).toEqual(["worlds", "list"]);
	});

	it("rejects raw and json together", () => {
		expect(() => parseGlobalArgs(["--raw", "--json", "worlds", "list"])).toThrow(CliUsageError);
	});

	it("parses command positionals, string flags, and boolean flags", () => {
		const parsed = parseCommandOptions(["w/main", "--model", "openai/gpt-5", "--yes"], new Set(["yes"]));
		expect(parsed.positionals).toEqual(["w/main"]);
		expect(flagString(parsed.flags, "model")).toBe("openai/gpt-5");
		expect(flagBoolean(parsed.flags, "yes")).toBe(true);
	});
});
