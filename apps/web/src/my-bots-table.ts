import { type BotSummary, type BotTokenSpendSummary } from "@bickr/shared/model";

export type MyBotsSortKey = "displayName" | "handle" | "lastActive" | "model" | "nextDue" | "spend";
export type MyBotsSortDirection = "asc" | "desc";

export type MyBotsSortState = {
	direction: MyBotsSortDirection;
	key: MyBotsSortKey;
};

export type MyBotSpendLoadState =
	| { status: "loading" }
	| { status: "loaded"; summary: BotTokenSpendSummary }
	| { status: "error"; message: string };

export type MyBotTableRecordForSort = {
	bot: Pick<BotSummary, "displayName" | "handle">;
	effectiveModel: string;
	lastActiveSort: number | null;
	nextDueSort: number | null;
	spend?: MyBotSpendLoadState;
};

export type MyBotsSpendTotal = {
	cost: number | null;
	errorCount: number;
	knownCost: number;
	pendingCount: number;
	requestCount: number;
	unknownCost: boolean;
};

export const defaultMyBotsSortState: MyBotsSortState = { direction: "asc", key: "handle" };
export const myBotsSortStorageKey = "bickr.myBots.sort";

export function parseMyBotsSortState(raw: string | null | undefined): MyBotsSortState {
	if (!raw) {
		return defaultMyBotsSortState;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") {
			return defaultMyBotsSortState;
		}
		const record = parsed as Record<string, unknown>;
		const key = record.key;
		const direction = record.direction;
		if (isMyBotsSortKey(key) && isMyBotsSortDirection(direction)) {
			return { key, direction };
		}
	} catch {
		return defaultMyBotsSortState;
	}
	return defaultMyBotsSortState;
}

export function compareMyBotTableRecords(
	left: MyBotTableRecordForSort,
	right: MyBotTableRecordForSort,
	sort: MyBotsSortState,
): number {
	let result = 0;
	switch (sort.key) {
		case "displayName":
			result = compareSortText(left.bot.displayName, right.bot.displayName, sort.direction);
			break;
		case "handle":
			result = compareSortText(left.bot.handle, right.bot.handle, sort.direction);
			break;
		case "lastActive":
			result = compareNullableNumberSort(left.lastActiveSort, right.lastActiveSort, sort.direction);
			break;
		case "model":
			result = compareSortText(left.effectiveModel, right.effectiveModel, sort.direction);
			break;
		case "nextDue":
			result = compareNullableNumberSort(left.nextDueSort, right.nextDueSort, sort.direction);
			break;
		case "spend":
			result = compareNullableNumberSort(myBotSpendSortCost(left.spend), myBotSpendSortCost(right.spend), sort.direction);
			break;
	}
	return result || compareHandles(left.bot.handle, right.bot.handle);
}

function myBotSpendSortCost(spend: MyBotSpendLoadState | undefined): number | null {
	if (spend?.status !== "loaded") {
		return null;
	}
	return spend.summary.last24Hours.unknownCost ? null : spend.summary.last24Hours.cost;
}

export function myBotsSpendTotal(records: readonly { spend?: MyBotSpendLoadState }[]): MyBotsSpendTotal {
	let errorCount = 0;
	let knownCost = 0;
	let pendingCount = 0;
	let requestCount = 0;
	let unknownCost = false;
	for (const record of records) {
		const spend = record.spend;
		if (!spend || spend.status === "loading") {
			pendingCount += 1;
			continue;
		}
		if (spend.status === "error") {
			errorCount += 1;
			continue;
		}
		requestCount += spend.summary.last24Hours.requestCount;
		if (spend.summary.last24Hours.unknownCost) {
			unknownCost = true;
		} else {
			knownCost += spend.summary.last24Hours.cost ?? 0;
		}
	}
	return {
		cost: unknownCost || errorCount > 0 ? null : knownCost,
		errorCount,
		knownCost,
		pendingCount,
		requestCount,
		unknownCost,
	};
}

export function modelColorHue(model: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < model.length; index += 1) {
		hash ^= model.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % 360;
}

function isMyBotsSortKey(value: unknown): value is MyBotsSortKey {
	return value === "displayName" || value === "handle" || value === "lastActive" || value === "model" || value === "nextDue" || value === "spend";
}

function isMyBotsSortDirection(value: unknown): value is MyBotsSortDirection {
	return value === "asc" || value === "desc";
}

function compareSortText(left: string, right: string, direction: MyBotsSortDirection): number {
	const result = left.localeCompare(right, undefined, { sensitivity: "base" });
	return direction === "asc" ? result : -result;
}

function compareNullableNumberSort(
	left: number | null,
	right: number | null,
	direction: MyBotsSortDirection,
): number {
	if (left === null && right === null) {
		return 0;
	}
	if (left === null) {
		return 1;
	}
	if (right === null) {
		return -1;
	}
	const result = left - right;
	return direction === "asc" ? result : -result;
}

function compareHandles(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: "base" });
}
