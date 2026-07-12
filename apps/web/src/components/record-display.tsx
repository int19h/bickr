import {
	localizedTextString,
	type BotSummary,
} from "@bickr/shared/model";
import {
	formatShortDate,
	timeAgo,
	timeAgoWithAgo,
	timestampTitle,
} from "../screens/chrome";
import type { TextLike } from "../ui";

function formatNextDueAt(nextDueAt: string | null | undefined, enabled: boolean, loaded: boolean): string {
	if (!enabled) {
		return "not scheduled";
	}
	if (!loaded) {
		return "loading...";
	}
	if (!nextDueAt) {
		return "not scheduled";
	}
	const date = new Date(nextDueAt);
	return Number.isFinite(date.getTime()) ? date.toLocaleString() : "not scheduled";
}
export function TimeAgoLabel({ className, suffix = false, value }: { className?: string; suffix?: boolean; value: string }) {
	return (
		<span className={className} title={timestampTitle(value)}>
			{suffix ? timeAgoWithAgo(value) : timeAgo(value)}
		</span>
	);
}

export function TimeUntilLabel({ value }: { value: string | null | undefined }) {
	return <span title={timestampTitle(value)}>{timeUntil(value)}</span>;
}

export function ShortDateLabel({ value }: { value: string }) {
	return <span title={timestampTitle(value)}>{formatShortDate(value)}</span>;
}

export function NextDueAtLabel({
	enabled,
	loaded,
	value,
}: {
	enabled: boolean;
	loaded: boolean;
	value: string | null | undefined;
}) {
	return <span title={enabled && loaded ? timestampTitle(value) : undefined}>{formatNextDueAt(value, enabled, loaded)}</span>;
}

export function parsePositiveInteger(value: string): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

export function parseOptionalPositiveInteger(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

export function compareHandles(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: "base" });
}

export function sortByHandle<T extends { handle: string }>(items: T[]): T[] {
	return [...items].sort((left, right) => compareHandles(left.handle, right.handle));
}

function compareBotCardOrder(left: BotSummary, right: BotSummary): number {
	const leftPaused = !left.tickSettings.enabled;
	const rightPaused = !right.tickSettings.enabled;
	if (leftPaused !== rightPaused) {
		return leftPaused ? -1 : 1;
	}
	return compareHandles(left.handle, right.handle);
}

export function sortBotsForCards<T extends BotSummary>(items: T[]): T[] {
	return [...items].sort(compareBotCardOrder);
}

function normalizeFilterText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

export function matchesFilter(query: string, ...values: Array<TextLike | null | undefined>): boolean {
	const normalizedQuery = normalizeFilterText(query.trim());
	if (!normalizedQuery) {
		return true;
	}
	return values.some((value) => value !== undefined && value !== null && normalizeFilterText(typeof value === "string" ? value : localizedTextString(value)).includes(normalizedQuery));
}

export function authorLabel(displayName: TextLike | undefined, handle: string): string {
	const cleanName = displayName ? (typeof displayName === "string" ? displayName : localizedTextString(displayName)).trim() : "";
	return cleanName ? `${cleanName} (u/${handle})` : `u/${handle}`;
}

function timeUntil(value: string | null | undefined): string {
	if (!value) {
		return "not scheduled";
	}
	const date = new Date(value);
	const diff = date.getTime() - Date.now();
	if (!Number.isFinite(diff)) {
		return "not scheduled";
	}
	if (diff <= 0) {
		return "now";
	}
	const minutes = Math.max(1, Math.ceil(diff / 60_000));
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) {
		return `in ${hours}h`;
	}
	const days = Math.ceil(hours / 24);
	return `in ${days}d`;
}
