import type { BotLoopMessagePage } from "@bickr/shared/model";

export type LoopContinuationPlacement = Readonly<{
	position: "start" | "end";
	label: "continued from" | "continued on";
	page: number;
}>;

export function loopContinuationRowsForPage(page: BotLoopMessagePage | null): LoopContinuationPlacement[] {
	if (!page) {
		return [];
	}
	return [
		...(page.olderPage ? [{ position: "start" as const, label: "continued from" as const, page: page.olderPage }] : []),
		...(page.newerPage ? [{ position: "end" as const, label: "continued on" as const, page: page.newerPage }] : []),
	];
}
