export type NotificationSwipeIntent = "ignore" | "pending" | "scroll" | "swipe";

export type NotificationSwipeInput = {
	deltaX: number;
	deltaY: number;
	widthPx: number;
};

export type NotificationSwipeConfig = {
	dismissWidthRatio: number;
	horizontalIntentRatio: number;
	intentDistancePx: number;
	maxDismissDistancePx: number;
	maxVisibleOffsetPx: number;
	minDismissDistancePx: number;
	verticalIntentRatio: number;
};

export const notificationSwipeConfig = {
	dismissWidthRatio: 0.32,
	horizontalIntentRatio: 1.2,
	intentDistancePx: 8,
	maxDismissDistancePx: 160,
	maxVisibleOffsetPx: 180,
	minDismissDistancePx: 72,
	verticalIntentRatio: 1.15,
} as const satisfies NotificationSwipeConfig;

export function notificationSwipeIntent(
	input: Pick<NotificationSwipeInput, "deltaX" | "deltaY">,
	config: NotificationSwipeConfig = notificationSwipeConfig,
): NotificationSwipeIntent {
	const absX = Math.abs(input.deltaX);
	const absY = Math.abs(input.deltaY);
	if (Math.max(absX, absY) < config.intentDistancePx) {
		return "pending";
	}
	if (absY >= absX * config.verticalIntentRatio) {
		return "scroll";
	}
	if (input.deltaX < 0 && absX >= absY * config.horizontalIntentRatio) {
		return "swipe";
	}
	return "ignore";
}

export function notificationSwipeOffset(
	input: NotificationSwipeInput,
	config: NotificationSwipeConfig = notificationSwipeConfig,
): number {
	if (notificationSwipeIntent(input, config) !== "swipe") {
		return 0;
	}
	const visibleLimit = Math.min(config.maxVisibleOffsetPx, Math.max(config.minDismissDistancePx, input.widthPx));
	return -Math.min(Math.abs(input.deltaX), visibleLimit);
}

export function notificationSwipeDismissDistance(
	widthPx: number,
	config: NotificationSwipeConfig = notificationSwipeConfig,
): number {
	return Math.max(
		config.minDismissDistancePx,
		Math.min(config.maxDismissDistancePx, Math.round(widthPx * config.dismissWidthRatio)),
	);
}

export function notificationSwipeShouldDismiss(
	input: NotificationSwipeInput,
	config: NotificationSwipeConfig = notificationSwipeConfig,
): boolean {
	return (
		notificationSwipeIntent(input, config) === "swipe" &&
		Math.abs(input.deltaX) >= notificationSwipeDismissDistance(input.widthPx, config)
	);
}

export function notificationSwipeShouldSuppressClick(
	input: Pick<NotificationSwipeInput, "deltaX" | "deltaY">,
	config: NotificationSwipeConfig = notificationSwipeConfig,
): boolean {
	return Math.hypot(input.deltaX, input.deltaY) >= config.intentDistancePx;
}
