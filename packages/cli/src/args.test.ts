import { describe, expect, it } from "vitest";
import { CliUsageError, flagBoolean, flagString, flagStrings, parseCommandOptions, parseGlobalArgs } from "./args.ts";

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

	it("keeps every value of a repeatable flag, which flagString cannot", () => {
		const parsed = parseCommandOptions(["--to", "u/alice", "--to=w/main/g/critics", "--to", "bot_7"]);
		expect(flagStrings(parsed.flags, "to")).toEqual(["u/alice", "w/main/g/critics", "bot_7"]);
		expect(flagString(parsed.flags, "to")).toBe("bot_7");
	});

	it("reads a once-given repeatable flag as a single-value list", () => {
		const parsed = parseCommandOptions(["--to", "u/alice"]);
		expect(flagStrings(parsed.flags, "to")).toEqual(["u/alice"]);
		expect(flagStrings(parsed.flags, "missing")).toEqual([]);
	});

	it("parses no-open as an auth login boolean flag", () => {
		const parsed = parseCommandOptions(["--no-open"], new Set(["no-open"]));
		expect(parsed.positionals).toEqual([]);
		expect(flagBoolean(parsed.flags, "no-open")).toBe(true);
	});
});
