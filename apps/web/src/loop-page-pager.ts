import type { BotLoopMessagePage } from "@bickr/shared/model";

export type LoopPagePagerItem =
	| Readonly<{
		kind: "page";
		page: number;
		current: boolean;
		messageCount: number;
	}>
	| Readonly<{
		kind: "ellipsis";
		page: number;
		direction: "backward" | "forward";
	}>;

const defaultLoopPageWindowSize = 25;
const defaultLoopPageJumpSize = 25;

export function loopPagePagerItems(
	page: BotLoopMessagePage | null,
	options: { windowSize?: number; jumpSize?: number } = {},
): LoopPagePagerItem[] {
	if (!page) {
		return [];
	}
	const pageCount = positiveInteger(page.pageCount, 1);
	if (pageCount <= 1) {
		return [];
	}
	const currentPage = clampPage(page.currentPage, pageCount);
	const windowSize = positiveInteger(options.windowSize ?? defaultLoopPageWindowSize, defaultLoopPageWindowSize);
	const jumpSize = positiveInteger(options.jumpSize ?? defaultLoopPageJumpSize, defaultLoopPageJumpSize);
	const visibleCount = Math.min(pageCount, windowSize);
	const beforeCount = Math.floor((visibleCount - 1) / 2);
	let firstPage = currentPage - beforeCount;
	let lastPage = firstPage + visibleCount - 1;
	if (firstPage < 1) {
		lastPage += 1 - firstPage;
		firstPage = 1;
	}
	if (lastPage > pageCount) {
		firstPage = Math.max(1, firstPage - (lastPage - pageCount));
		lastPage = pageCount;
	}

	const summariesByPage = new Map(page.pages.map((summary) => [summary.page, summary]));
	const items: LoopPagePagerItem[] = [];
	if (firstPage > 1) {
		items.push({ kind: "ellipsis", page: clampPage(currentPage - jumpSize, pageCount), direction: "backward" });
	}
	for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
		items.push({
			kind: "page",
			page: pageNumber,
			current: pageNumber === currentPage,
			messageCount: Math.max(0, Math.floor(summariesByPage.get(pageNumber)?.messageCount ?? 0)),
		});
	}
	if (lastPage < pageCount) {
		items.push({ kind: "ellipsis", page: clampPage(currentPage + jumpSize, pageCount), direction: "forward" });
	}
	return items;
}

function clampPage(page: number, pageCount: number): number {
	const normalized = Number.isFinite(page) ? Math.floor(page) : 1;
	return Math.max(1, Math.min(pageCount, normalized));
}

function positiveInteger(value: number, fallback: number): number {
	return Math.max(1, Number.isFinite(value) ? Math.floor(value) : fallback);
}
