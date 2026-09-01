import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	HumanNotification,
	HumanNotificationReadAnchor,
	HumanNotificationReadScope,
	HumanNotificationSummary,
} from "@bickr/shared/model";
import { NotificationsScreen } from "./index";

/**
 * What the user is looking at after a mark-all, driven through the real screen.
 *
 * The server bounds the sweep by the anchor row's `rowid`, and no response
 * carries a rowid — so a row the client was already showing can be one the
 * server deliberately left unread, and no predicate over the client's own list
 * can tell which. The screen therefore predicts nothing: it sends the anchor,
 * waits, and renders the read state and the unread count the refetch brought
 * back. What these pin down is that the displayed state is always a state the
 * server reported — the one before the gesture until the refetch lands, the one
 * after it once it has, and never a third one this client composed.
 */

const anchorAt = "2026-05-06T12:00:00.000Z";
const before = "2026-05-06T11:59:00.000Z";

type ServerRow = { id: string; createdAt: string; readAt?: string };

let serverRows: ServerRow[];
/**
 * Stands in for the rowids the server bounds on and no response carries. The
 * list is served `(createdAt DESC, id DESC)`, so `hnt_b` is the anchor and
 * `hnt_a` renders below it — but `hnt_a` was *inserted* after `hnt_b`, which is
 * what this order records and the client cannot see. Ids are random UUIDs, so
 * this direction is as likely as the other.
 */
let serverInsertionOrder: string[];
/** A notification the server writes while the mark-all request is in flight. */
let arrivesDuringSweep: ServerRow | null;
let heldLoads: Array<() => void>;
let holdLoads: boolean;
let failLoads: boolean;
let heldMarkAll: Array<() => void>;
let holdMarkAll: boolean;
let anchorsSent: Array<HumanNotificationReadAnchor | null | undefined>;
let container: HTMLDivElement;
let root: Root;

function notification(row: ServerRow): HumanNotification {
	return {
		id: row.id,
		userId: "usr_self",
		worldId: "wld_one",
		eventKey: `evt_${row.id}`,
		notificationType: "comment_created",
		actorBotId: "bot_a",
		actorHandle: "anchor-bot",
		worldHandle: "anchor-world",
		title: { lang: null, text: row.id },
		body: { lang: null, text: "Body" },
		urlPath: "/",
		createdAt: row.createdAt,
		...(row.readAt ? { readAt: row.readAt } : {}),
	};
}

/** `listHumanNotifications`' order and paging, over whatever the server holds now. */
function page(limit: number, offset: number): HumanNotificationSummary {
	const ordered = [...serverRows].sort((left, right) =>
		left.createdAt === right.createdAt ?
			right.id.localeCompare(left.id)
		:	right.createdAt.localeCompare(left.createdAt),
	);
	const slice = ordered.slice(offset, offset + limit);
	return {
		hasMore: offset + slice.length < ordered.length,
		nextOffset: offset + slice.length,
		unreadCount: serverRows.filter((row) => !row.readAt).length,
		notifications: slice.map(notification),
	};
}

async function onLoadNotifications(
	_status: "unread" | "all",
	limit = 50,
	offset = 0,
): Promise<HumanNotificationSummary | null> {
	if (holdLoads) {
		await new Promise<void>((resolve) => heldLoads.push(resolve));
	}
	return failLoads ? null : page(limit, offset);
}

/**
 * The sweep the server actually performs: everything at or below the anchor's
 * insertion position and no later than the rendered timestamp. `hnt_a` fails the
 * first half, so it comes back unread whatever the client was showing.
 */
async function onMarkAllRead(
	_scope?: HumanNotificationReadScope,
	anchor?: HumanNotificationReadAnchor | null,
): Promise<number | null> {
	anchorsSent.push(anchor);
	if (holdMarkAll) {
		await new Promise<void>((resolve) => heldMarkAll.push(resolve));
	}
	if (!anchor) {
		return 0;
	}
	const anchorPosition = serverInsertionOrder.indexOf(anchor.notificationId);
	const swept = serverRows.filter(
		(row) =>
			!row.readAt &&
			serverInsertionOrder.indexOf(row.id) <= anchorPosition &&
			row.createdAt <= anchor.createdAt,
	);
	for (const row of swept) {
		row.readAt = "2026-05-06T12:00:09.000Z";
	}
	if (arrivesDuringSweep) {
		serverRows.push(arrivesDuringSweep);
		serverInsertionOrder.push(arrivesDuringSweep.id);
		arrivesDuringSweep = null;
	}
	return swept.length;
}

async function flush(): Promise<void> {
	for (let pass = 0; pass < 6; pass += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

function releaseHeldMarkAll(): void {
	holdMarkAll = false;
	const held = heldMarkAll;
	heldMarkAll = [];
	for (const resolve of held) {
		resolve();
	}
}

function releaseHeldLoads(): void {
	holdLoads = false;
	const held = heldLoads;
	heldLoads = [];
	for (const resolve of held) {
		resolve();
	}
}

/** Every card the list is showing, and whether it is showing it as unread. */
function renderedReadState(): Record<string, "read" | "unread"> {
	const cards = Array.from(container.querySelectorAll<HTMLElement>(".notification-page-card"));
	return Object.fromEntries(
		cards.map((card) => [
			card.querySelector(".notification-title")?.textContent ?? "",
			card.classList.contains("unread") ? "unread" : "read",
		]),
	);
}

function unreadBadge(): string {
	return container.querySelector(".notification-page-summary span")?.textContent ?? "";
}

function summaryLine(): string {
	return container.querySelector(".notification-page-summary")?.textContent ?? "";
}

function refreshButton(): HTMLButtonElement {
	const found = Array.from(container.querySelectorAll(".page-header button")).find(
		(candidate) => candidate.textContent?.trim() === "Refresh",
	);
	expect(found, "no Refresh button").toBeDefined();
	return found as HTMLButtonElement;
}

function markAllReadButton(): HTMLButtonElement {
	const found = Array.from(container.querySelectorAll(".page-header button")).find(
		(candidate) => candidate.textContent?.trim() === "Mark all read",
	);
	expect(found, "no Mark all read button").toBeDefined();
	return found as HTMLButtonElement;
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	serverRows = [
		{ id: "hnt_older", createdAt: before },
		{ id: "hnt_b", createdAt: anchorAt },
		{ id: "hnt_a", createdAt: anchorAt },
	];
	serverInsertionOrder = ["hnt_older", "hnt_b", "hnt_a"];
	arrivesDuringSweep = null;
	heldLoads = [];
	holdLoads = false;
	failLoads = false;
	heldMarkAll = [];
	holdMarkAll = false;
	anchorsSent = [];
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root.render(
			<NotificationsScreen
				grouped={false}
				onDismiss={async () => true}
				onLoadNotifications={onLoadNotifications}
				onMarkAllRead={onMarkAllRead}
				onMarkRead={async () => "2026-05-06T12:00:09.000Z"}
				onOpenNotification={() => undefined}
			/>,
		);
	});
	await flush();
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("mark all read", () => {
	it("waits for the refetch and then shows the read state the server reports", async () => {
		expect(renderedReadState()).toEqual({ hnt_b: "unread", hnt_a: "unread", hnt_older: "unread" });

		// Hold the refetch open, so whatever is on screen in the meantime is the
		// screen speaking for itself and can be caught inventing an answer.
		holdLoads = true;
		act(() => {
			markAllReadButton().click();
		});
		await flush();

		expect(anchorsSent).toEqual([{ notificationId: "hnt_b", createdAt: anchorAt }]);
		// The sweep has run; the screen has no way to know what it covered, so it
		// keeps showing the last state the server gave it and says it is working.
		expect(renderedReadState()).toEqual({ hnt_b: "unread", hnt_a: "unread", hnt_older: "unread" });
		expect(unreadBadge()).toBe("3 unread");
		expect(summaryLine()).toContain("Loading...");

		releaseHeldLoads();
		await flush();

		// `hnt_a` shares the anchor's millisecond and sorts below its id, and the
		// server left it unread. The screen shows that, because the server said it.
		expect(serverRows.find((row) => row.id === "hnt_a")?.readAt).toBeUndefined();
		expect(renderedReadState()).toEqual({ hnt_b: "read", hnt_a: "unread", hnt_older: "read" });
		expect(unreadBadge()).toBe("1 unread");
		expect(summaryLine()).not.toContain("Loading...");
	});

	it("takes the settled list and badge from the server, not from what it assumed", async () => {
		// A notification written while the request is in flight: the sweep cannot
		// reach it and the client has never seen it, so only the refetch can put it
		// on screen — unread, and counted.
		arrivesDuringSweep = { id: "hnt_late", createdAt: "2026-05-06T12:00:05.000Z" };

		act(() => {
			markAllReadButton().click();
		});
		await flush();

		expect(renderedReadState()).toEqual({
			hnt_late: "unread",
			hnt_b: "read",
			hnt_a: "unread",
			hnt_older: "read",
		});
		expect(unreadBadge()).toBe("2 unread");
	});

	/**
	 * The row a timestamp cannot rule out. A writer captures `now` before its
	 * INSERT, so a notification written after the gesture can carry an older
	 * `created_at` than the anchor and a later rowid — the server's `rowid <=`
	 * bound leaves it unread. Any client-side predicate over `created_at` marks it
	 * read; the screen has no predicate, so it reports what came back.
	 */
	it("shows a backdated row the sweep left unread as unread", async () => {
		arrivesDuringSweep = { id: "hnt_backdated", createdAt: before };

		act(() => {
			markAllReadButton().click();
		});
		await flush();

		expect(serverRows.find((row) => row.id === "hnt_backdated")?.readAt).toBeUndefined();
		expect(renderedReadState()).toEqual({
			hnt_b: "read",
			hnt_a: "unread",
			hnt_older: "read",
			hnt_backdated: "unread",
		});
		expect(unreadBadge()).toBe("2 unread");
	});

	it("keeps the pre-gesture state when the refetch fails, until a load succeeds", async () => {
		holdMarkAll = true;
		act(() => {
			markAllReadButton().click();
		});
		await flush();

		failLoads = true;
		releaseHeldMarkAll();
		await flush();

		// The sweep landed, but nothing came back to say what it did. The screen
		// keeps the state the server last gave it rather than composing one: three
		// unread rows and a badge of three, stale but never invented.
		expect(serverRows.filter((row) => row.readAt).map((row) => row.id)).toEqual(["hnt_older", "hnt_b"]);
		expect(renderedReadState()).toEqual({ hnt_b: "unread", hnt_a: "unread", hnt_older: "unread" });
		expect(unreadBadge()).toBe("3 unread");
		expect(summaryLine()).toContain("Could not refresh notifications.");

		failLoads = false;
		act(() => {
			refreshButton().click();
		});
		await flush();

		expect(renderedReadState()).toEqual({ hnt_b: "read", hnt_a: "unread", hnt_older: "read" });
		expect(unreadBadge()).toBe("1 unread");
	});
});
