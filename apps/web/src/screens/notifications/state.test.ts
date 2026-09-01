import type { HumanNotification, HumanNotificationSummary, LocalizedText } from "@bickr/shared/model";
import { describe, expect, it } from "vitest";
import { humanNotificationReadAnchorFor, reloadHumanNotificationPages } from "./state";

const before = "2026-05-06T11:59:00.000Z";
const anchorAt = "2026-05-06T12:00:00.000Z";

function notification(id: string, createdAt: string, overrides: Partial<HumanNotification> = {}): HumanNotification {
	return {
		id,
		userId: "usr_one",
		worldId: "wld_one",
		eventKey: `event:${id}`,
		notificationType: "thread_created",
		actorBotId: "bot_a",
		title: localized(id),
		body: localized(id),
		urlPath: "/",
		createdAt,
		...overrides,
	};
}

function localized(text: string): LocalizedText {
	return { lang: null, text };
}

/**
 * The one thing this client contributes to a mark-all: the ceiling the server
 * sweeps up to. It says nothing about which rows came back read — that is the
 * refetch's answer, and the client keeps no predicate of its own beside it.
 */
describe("humanNotificationReadAnchorFor", () => {
	it("takes the newest rendered notification as the anchor, breaking a tie by id", () => {
		expect(humanNotificationReadAnchorFor([])).toBeNull();
		expect(
			humanNotificationReadAnchorFor([
				notification("hnt_b", anchorAt),
				notification("hnt_c", anchorAt),
				notification("hnt_a", before),
			]),
		).toEqual({ notificationId: "hnt_c", createdAt: anchorAt });
	});
});

/**
 * The reconciling walk after a mark-all. It has to end on every page shape a
 * server can hand it, including shapes that never say "done": the bound on it is
 * the page budget, which is fixed before the first request and cannot be moved
 * by anything a page contains.
 */
describe("reloadHumanNotificationPages", () => {
	function pageOf(ids: string[], hasMore: boolean, nextOffset?: number): HumanNotificationSummary {
		return {
			hasMore,
			...(nextOffset === undefined ? {} : { nextOffset }),
			unreadCount: ids.length,
			notifications: ids.map((id) => notification(id, before)),
		};
	}

	it("stops on nonempty pages that keep repeating rows and promising more", async () => {
		const offsets: number[] = [];
		const result = await reloadHumanNotificationPages(
			async (offset) => {
				offsets.push(offset);
				// A walk that outruns this is one that never ends: throwing keeps a
				// regression here a failing test rather than a hanging suite.
				expect(offsets.length, "the page budget did not bound the walk").toBeLessThan(50);
				// Every page: the same two rows, a moving offset, and `hasMore` that
				// never settles. Nothing here can ever end the walk.
				return pageOf(["hnt_a", "hnt_b"], true, offset + 2);
			},
			{ loadedCount: 6, pageSize: 2 },
		);

		expect(offsets).toEqual([0, 2, 4, 6]);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_a", "hnt_b"]);
		expect(result.failed).toBe(false);
		expect(result.cancelled).toBe(false);
	});

	it("stops on a page that repeats rows without advancing the offset either", async () => {
		let loads = 0;
		const result = await reloadHumanNotificationPages(
			async () => {
				loads += 1;
				expect(loads, "the page budget did not bound the walk").toBeLessThan(50);
				return pageOf(["hnt_a"], true, 0);
			},
			{ loadedCount: 100, pageSize: 10 },
		);

		expect(loads).toBe(11);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_a"]);
	});

	it("walks several pages and settles on a final short page", async () => {
		const pages = [
			pageOf(["hnt_a", "hnt_b"], true, 2),
			pageOf(["hnt_c", "hnt_d"], true, 4),
			pageOf(["hnt_e"], false, 5),
		];
		const offsets: number[] = [];

		const result = await reloadHumanNotificationPages(
			async (offset) => {
				offsets.push(offset);
				return pages[offsets.length - 1] ?? null;
			},
			{ loadedCount: 6, pageSize: 2 },
		);

		expect(offsets).toEqual([0, 2, 4]);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual([
			"hnt_a",
			"hnt_b",
			"hnt_c",
			"hnt_d",
			"hnt_e",
		]);
		expect(result.summary?.hasMore).toBe(false);
		expect(result.failed).toBe(false);
	});

	it("stops on an empty page even while the server still claims more", async () => {
		const pages = [pageOf(["hnt_a", "hnt_b"], true, 2), pageOf([], true, 2)];
		let loads = 0;

		const result = await reloadHumanNotificationPages(
			async () => {
				loads += 1;
				return pages[loads - 1] ?? null;
			},
			{ loadedCount: 20, pageSize: 2 },
		);

		expect(loads).toBe(2);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_a", "hnt_b"]);
	});

	it("stops once it has collected what was loaded", async () => {
		let loads = 0;
		const result = await reloadHumanNotificationPages(
			async (offset) => {
				loads += 1;
				return pageOf([`hnt_${offset}`, `hnt_${offset + 1}`], true, offset + 2);
			},
			{ loadedCount: 4, pageSize: 2 },
		);

		expect(loads).toBe(2);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_0", "hnt_1", "hnt_2", "hnt_3"]);
	});

	it("reports a failed page and keeps the pages it already has", async () => {
		let loads = 0;
		const result = await reloadHumanNotificationPages(
			async (offset) => {
				loads += 1;
				return loads === 1 ? pageOf(["hnt_a", "hnt_b"], true, offset + 2) : null;
			},
			{ loadedCount: 6, pageSize: 2 },
		);

		expect(result.failed).toBe(true);
		expect(result.summary?.notifications.map((item) => item.id)).toEqual(["hnt_a", "hnt_b"]);
	});

	it("abandons the walk when a newer load has taken over", async () => {
		let loads = 0;
		const result = await reloadHumanNotificationPages(
			async (offset) => {
				loads += 1;
				return pageOf([`hnt_${offset}`], true, offset + 1);
			},
			{ isCancelled: () => loads >= 2, loadedCount: 10, pageSize: 1 },
		);

		expect(loads).toBe(2);
		expect(result.cancelled).toBe(true);
		expect(result.summary).toBeNull();
	});
});
