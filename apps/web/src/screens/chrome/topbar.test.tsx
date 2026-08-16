import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultFontScalePercent } from "../../font-scale";
import { Topbar } from "./index";

/**
 * The top bar after the status chip was removed.
 *
 * The chip used to be the app's status surface and the Refresh button used to
 * borrow the global `busy` flag, which unrelated mutations also set. What is
 * left has to hold: no chip at all, and a spinning Refresh icon exactly when a
 * refresh is in flight.
 */

function topbarMarkup(overrides: { busy?: boolean; refreshing?: boolean } = {}): string {
	return renderToStaticMarkup(
		<Topbar
			activeWorldHandle={null}
			bot={null}
			busy={overrides.busy ?? false}
			fontScalePercent={defaultFontScalePercent}
			forum={null}
			installAvailable={false}
			notifications={{ unreadCount: 0, notifications: [] }}
			onFontScale={() => undefined}
			onInstall={() => undefined}
			onMarkAllNotificationsRead={() => undefined}
			onNotificationDismiss={() => Promise.resolve(true)}
			onNotificationOpen={() => undefined}
			onRefresh={() => undefined}
			onRefreshNotifications={() => undefined}
			onTheme={() => undefined}
			refreshing={overrides.refreshing ?? false}
			route="worlds"
			themePreference="system"
			thread={null}
			user={null}
			world={null}
			worlds={[]}
		/>,
	);
}

function refreshButton(markup: string): string {
	const match = /<button[^>]*topbar-refresh[\s\S]*?<\/button>/.exec(markup);
	expect(match).not.toBeNull();
	return match![0];
}

describe("Topbar", () => {
	it("no longer renders a status chip", () => {
		expect(topbarMarkup()).not.toContain("status-chip");
		expect(topbarMarkup({ busy: true })).not.toContain("status-chip");
	});

	it("leaves the refresh icon still while nothing is refreshing", () => {
		const button = refreshButton(topbarMarkup());
		expect(button).not.toContain("icon-spin");
		expect(button).not.toContain("disabled");
	});

	it("spins and disables the refresh button while a refresh is in flight", () => {
		const button = refreshButton(topbarMarkup({ refreshing: true }));
		expect(button).toContain("icon-spin");
		expect(button).toContain("disabled");
	});

	it("does not spin for unrelated work that only sets the global busy flag", () => {
		const button = refreshButton(topbarMarkup({ busy: true }));
		expect(button).not.toContain("icon-spin");
		// A mutation still blocks a concurrent refresh, as it did before.
		expect(button).toContain("disabled");
	});
});
