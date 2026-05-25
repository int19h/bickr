export type GlobalOptions = {
	host?: string;
	json: boolean;
	raw: boolean;
	format?: OutputFormat;
	help: boolean;
};

export type OutputFormat = "human" | "json" | "ndjson";

export type ParsedCommandOptions = {
	positionals: string[];
	flags: Map<string, string | boolean | string[]>;
};

export function parseGlobalArgs(argv: string[]): { globals: GlobalOptions; args: string[] } {
	const globals: GlobalOptions = { json: false, raw: false, help: false };
	const args: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--") {
			args.push(...argv.slice(index + 1));
			break;
		}
		if (arg === "--json") {
			globals.json = true;
			globals.format = "json";
			continue;
		}
		if (arg === "--raw") {
			globals.raw = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			globals.help = true;
			continue;
		}
		if (arg === "--host") {
			globals.host = requiredFlagValue(argv, index, "--host");
			index += 1;
			continue;
		}
		if (arg.startsWith("--host=")) {
			globals.host = arg.slice("--host=".length);
			continue;
		}
		if (arg === "--format") {
			globals.format = parseOutputFormat(requiredFlagValue(argv, index, "--format"));
			if (globals.format === "json") {
				globals.json = true;
			}
			index += 1;
			continue;
		}
		if (arg.startsWith("--format=")) {
			globals.format = parseOutputFormat(arg.slice("--format=".length));
			if (globals.format === "json") {
				globals.json = true;
			}
			continue;
		}
		args.push(arg);
	}
	if (globals.raw && globals.json) {
		throw new CliUsageError("--raw and --json cannot be used together.");
	}
	return { globals, args };
}

export function parseCommandOptions(args: string[], booleanFlags = new Set<string>()): ParsedCommandOptions {
	const positionals: string[] = [];
	const flags = new Map<string, string | boolean | string[]>();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--") || arg === "-") {
			positionals.push(arg);
			continue;
		}
		const equalIndex = arg.indexOf("=");
		const name = equalIndex === -1 ? arg.slice(2) : arg.slice(2, equalIndex);
		if (!name) {
			throw new CliUsageError("Flag name is empty.");
		}
		const value =
			equalIndex === -1 ?
				booleanFlags.has(name) ?
					true
				:	requiredFlagValue(args, index, `--${name}`)
			:	arg.slice(equalIndex + 1);
		if (equalIndex === -1 && value !== true) {
			index += 1;
		}
		appendFlag(flags, name, value);
	}
	return { positionals, flags };
}

export function flagString(flags: Map<string, string | boolean | string[]>, name: string): string | undefined {
	const value = flags.get(name);
	if (Array.isArray(value)) {
		const last = value.at(-1);
		return typeof last === "string" ? last : undefined;
	}
	return typeof value === "string" ? value : undefined;
}

export function flagBoolean(flags: Map<string, string | boolean | string[]>, name: string): boolean {
	return flags.get(name) === true;
}

function appendFlag(flags: Map<string, string | boolean | string[]>, name: string, value: string | boolean): void {
	const current = flags.get(name);
	if (current === undefined) {
		flags.set(name, value);
	} else if (Array.isArray(current)) {
		current.push(String(value));
	} else {
		flags.set(name, [String(current), String(value)]);
	}
}

function parseOutputFormat(value: string): OutputFormat {
	if (value === "human" || value === "json" || value === "ndjson") {
		return value;
	}
	throw new CliUsageError("--format must be human, json, or ndjson.");
}

function requiredFlagValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new CliUsageError(`${flag} requires a value.`);
	}
	return value;
}

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}
