import { describe, expect, it } from "vitest";
import {
	notificationSwipeIntent,
	notificationSwipeOffset,
	notificationSwipeShouldDismiss,
	notificationSwipeShouldSuppressClick,
} from "../apps/web/src/notification-swipe";

describe("notification swipe helpers", () => {
	it("dismisses a left swipe beyond the width-based threshold", () => {
		expect(notificationSwipeShouldDismiss({ deltaX: -130, deltaY: 12, widthPx: 360 })).toBe(true);
		expect(notificationSwipeOffset({ deltaX: -130, deltaY: 12, widthPx: 360 })).toBe(-130);
	});

	it("keeps a short left drag from dismissing", () => {
		expect(notificationSwipeIntent({ deltaX: -42, deltaY: 4 })).toBe("swipe");
		expect(notificationSwipeShouldDismiss({ deltaX: -42, deltaY: 4, widthPx: 360 })).toBe(false);
	});

	it("ignores rightward horizontal movement", () => {
		expect(notificationSwipeIntent({ deltaX: 130, deltaY: 8 })).toBe("ignore");
		expect(notificationSwipeOffset({ deltaX: 130, deltaY: 8, widthPx: 360 })).toBe(0);
		expect(notificationSwipeShouldDismiss({ deltaX: 130, deltaY: 8, widthPx: 360 })).toBe(false);
	});

	it("treats mostly vertical movement as scrolling", () => {
		expect(notificationSwipeIntent({ deltaX: -28, deltaY: 54 })).toBe("scroll");
		expect(notificationSwipeShouldDismiss({ deltaX: -150, deltaY: 190, widthPx: 360 })).toBe(false);
	});

	it("suppresses click handling after real movement but not a tap", () => {
		expect(notificationSwipeShouldSuppressClick({ deltaX: -7, deltaY: 0 })).toBe(false);
		expect(notificationSwipeShouldSuppressClick({ deltaX: -8, deltaY: 0 })).toBe(true);
	});
});
