import type { BotLoopMessage } from "@bickr/shared/model";

export function loopMessageSort(left: BotLoopMessage, right: BotLoopMessage): number {
	const positionDelta = loopMessageSortPosition(left) - loopMessageSortPosition(right);
	return positionDelta || left.seq - right.seq;
}

function loopMessageSortPosition(message: BotLoopMessage): number {
	return typeof message.position === "number" && Number.isFinite(message.position) ?
			message.position
		:	Number.POSITIVE_INFINITY;
}
