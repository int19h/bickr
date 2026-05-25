import { CliUsageError } from "./args.ts";

export type InclusiveRange = {
	start: number;
	end: number;
	offset: number;
	limit: number;
};

export function parseRange(value: string | undefined, defaultRange = "1-40"): InclusiveRange {
	const raw = value?.trim() || defaultRange;
	const match = /^(\d+)-(\d+)$/.exec(raw);
	if (!match) {
		throw new CliUsageError("Range must use 1-based inclusive form, for example 1-40.");
	}
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
		throw new CliUsageError("Range must start at 1 and end at or after the start.");
	}
	return {
		start,
		end,
		offset: start - 1,
		limit: end - start + 1,
	};
}
