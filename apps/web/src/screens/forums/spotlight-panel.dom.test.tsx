import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	localizedText,
	maxSpotlightSendBots,
	type BotSummary,
	type ForumSummary,
	type LanguageTag,
	type SpotlightDeliveryResult,
} from "@bickr/shared/model";
import { ToastContext } from "../../ui";
import type { WorldView } from "../../components/content";
import { SpotlightPanel } from "./spotlight-panel";

/**
 * The panel as a sequence of renders: a send is a run with its own progress,
 * its own snapshot of the selection, and a retry that must exclude whoever the
 * run already reached. Only a real render loop can tell those states apart.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const language = "en" as LanguageTag;
const now = "2026-08-16T12:00:00.000Z";

const world: WorldView = {
	id: "wld_spot",
	handle: "spot",
	language,
	name: localizedText("Spot", language),
	description: localizedText("A world.", language),
	prompt: localizedText("Prompt.", language),
	recurringPromptEnabled: false,
	recurringPrompt: localizedText("", language),
	initialBotNotification: localizedText("Welcome.", language),
	createdByUserId: "usr_owner",
	createdAt: now,
	updatedAt: now,
	forumCount: 1,
	botCount: 1,
	bannerIdx: 0,
	isMine: true,
	myBotCount: 1,
};

const forum: ForumSummary = {
	id: "frm_spot",
	worldId: world.id,
	worldHandle: world.handle,
	handle: "general",
	language,
	description: localizedText("Discussion.", language),
	createdByUserId: world.createdByUserId,
	readOnly: false,
	createdAt: now,
	updatedAt: now,
};

function bot(index: number): BotSummary {
	const handle = `bot-${String(index).padStart(2, "0")}`;
	return {
		id: `bot_${index}`,
		homeWorldId: world.id,
		homeWorldHandle: world.handle,
		handle,
		language,
		displayName: localizedText(`Bot ${index}`, language),
		shortBio: localizedText("A participant.", language),
		ownerUserId: world.createdByUserId,
		tickSettings: { enabled: true, intervalSeconds: 600, compactionThreshold: 0.75 },
		lastActiveAt: now,
		createdAt: now,
		updatedAt: now,
	} as unknown as BotSummary;
}

type SendCall = {
	botIds: string[];
	spotlightId?: string;
	autoStartTick?: boolean;
};

type FetchHarness = {
	calls: SendCall[];
	/** Resolves the request that is waiting, so a test can observe mid-run state. */
	release(): void;
};

function stubFetch(
	respond: (call: SendCall, index: number) => { spotlightId?: string; deliveries: SpotlightDeliveryResult[] } | "error",
	options: { hold?: boolean } = {},
): FetchHarness {
	const calls: SendCall[] = [];
	const waiting: Array<() => void> = [];
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as SendCall;
		const index = calls.length;
		calls.push(body);
		if (options.hold) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		const answer = respond(body, index);
		if (answer === "error") {
			return new Response(JSON.stringify({ ok: false, error: "server_error", message: "Delivery service is down." }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(
			JSON.stringify({
				ok: true,
				data: { spotlightId: answer.spotlightId ?? `spt_${index}`, deliveries: answer.deliveries },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
	return {
		calls,
		release: () => {
			for (const resolve of waiting.splice(0, waiting.length)) {
				resolve();
			}
		},
	};
}

let mounted: { container: HTMLElement; root: Root } | null = null;
const toasts: string[] = [];
let cleared = 0;

beforeEach(() => {
	toasts.length = 0;
	cleared = 0;
	window.localStorage.clear();
});

afterEach(() => {
	if (mounted) {
		const { container, root } = mounted;
		act(() => root.unmount());
		container.remove();
		mounted = null;
	}
});

function mountPanel(bots: BotSummary[]): void {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	act(() => {
		root.render(
			<StrictMode>
				<ToastContext.Provider value={{ push: (message) => toasts.push(String(message)) }}>
					<SpotlightPanel
						commentIds={["cmt_one"]}
						forum={forum}
						onClear={() => {
							cleared += 1;
						}}
						ownedBots={bots}
						targetType="comments"
						threadId="thr_one"
						threadIds={[]}
						world={world}
					/>
				</ToastContext.Provider>
			</StrictMode>,
		);
	});
}

function container(): HTMLElement {
	if (!mounted) {
		throw new Error("nothing is mounted");
	}
	return mounted.container;
}

function checkboxes(): HTMLInputElement[] {
	return [...container().querySelectorAll<HTMLInputElement>(".bot-pick-row .cb")];
}

function clickText(text: string): void {
	const target = [...container().querySelectorAll("button")].find((button) => button.textContent?.includes(text));
	if (!target) {
		throw new Error(`no button matching ${text}`);
	}
	act(() => {
		target.click();
	});
}

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

const started = (botId: string): SpotlightDeliveryResult => ({
	status: "tick_started",
	botId,
	injectionId: `inj_${botId}`,
});

describe("Spotlight panel", () => {
	it("selects and unselects the participants the filter currently shows", () => {
		mountPanel([bot(1), bot(2), bot(3)]);

		clickText("Select all (3)");
		expect(checkboxes().every((box) => box.checked)).toBe(true);

		const search = container().querySelector<HTMLInputElement>(".spot-search .input");
		act(() => {
			if (search) {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "Bot 2");
				search.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		expect(checkboxes()).toHaveLength(1);

		// Acting on the visible set alone: unselecting the one match must not
		// disturb the two the filter is hiding.
		clickText("Unselect all (1)");
		act(() => {
			if (search) {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "");
				search.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		expect(checkboxes().map((box) => box.checked)).toEqual([true, false, true]);
	});

	it("splits a selection above the cap into consecutive batches sharing one run", async () => {
		const bots = Array.from({ length: maxSpotlightSendBots + 2 }, (_, index) => bot(index + 1));
		const harness = stubFetch((call) => ({
			spotlightId: "spt_run",
			deliveries: call.botIds.map(started),
		}));
		mountPanel(bots);

		clickText(`Select all (${bots.length})`);
		clickText("Send");
		await settle();

		expect(harness.calls.map((call) => call.botIds.length)).toEqual([maxSpotlightSendBots, 2]);
		expect(harness.calls[0]?.spotlightId).toBeUndefined();
		// Every later batch continues the run the first one opened, which is what
		// makes a replay idempotent per participant.
		expect(harness.calls[1]?.spotlightId).toBe("spt_run");
		expect(toasts).toEqual([`Spotlight sent to ${bots.length} bots.`]);
		expect(cleared).toBe(1);
	});

	it("shows progress against the selection it started with and locks its inputs", async () => {
		const bots = Array.from({ length: maxSpotlightSendBots + 1 }, (_, index) => bot(index + 1));
		const harness = stubFetch((call) => ({ spotlightId: "spt_run", deliveries: call.botIds.map(started) }), { hold: true });
		mountPanel(bots);
		clickText(`Select all (${bots.length})`);
		clickText("Send");
		await settle();

		const progress = container().querySelector("[role='progressbar']");
		expect(progress?.getAttribute("aria-valuemax")).toBe(String(bots.length));
		expect(progress?.getAttribute("aria-valuenow")).toBe("0");
		expect(checkboxes().every((box) => box.disabled)).toBe(true);
		expect(container().querySelector<HTMLInputElement>(".spot-search .input")?.disabled).toBe(true);
		expect(container().querySelector<HTMLTextAreaElement>(".textarea")?.disabled).toBe(true);

		// First batch lands: its participants are unchecked and counted.
		harness.release();
		await settle();
		expect(container().querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe(
			String(maxSpotlightSendBots),
		);

		harness.release();
		await settle();
		expect(container().querySelector("[role='progressbar']")).toBeNull();
		expect(cleared).toBe(1);
	});

	it("keeps only the participants that failed selected, and retries them under the same run", async () => {
		const bots = [bot(1), bot(2)];
		const harness = stubFetch((call, index) => ({
			spotlightId: "spt_run",
			deliveries: call.botIds.map((botId) =>
				index === 0 && botId === "bot_2" ?
					{ status: "injected_tick_failed", botId, injectionId: "inj_2", message: "The visit never started." }
				:	started(botId),
			),
		}));
		mountPanel(bots);
		clickText("Select all (2)");
		clickText("Send");
		await settle();

		// The panel stays open on a partial failure, holding exactly the retry.
		expect(cleared).toBe(0);
		expect(checkboxes().map((box) => box.checked)).toEqual([false, true]);
		expect(container().querySelector(".spot-failures")?.textContent).toContain("The visit never started.");
		expect(toasts).toEqual(["Spotlight reached 1 of 2 bots. 1 still selected for retry."]);

		clickText("Retry");
		await settle();

		expect(harness.calls[1]).toMatchObject({ botIds: ["bot_2"], spotlightId: "spt_run" });
		expect(cleared).toBe(1);
	});

	it("reports a batch that never answered and leaves its participants selected", async () => {
		stubFetch(() => "error");
		mountPanel([bot(1)]);
		clickText("Select all (1)");
		clickText("Send");
		await settle();

		expect(cleared).toBe(0);
		expect(checkboxes().map((box) => box.checked)).toEqual([true]);
		expect(container().querySelector(".spot-status")?.textContent).toBe("Delivery service is down.");
		expect(container().querySelector(".spot-failures")?.textContent).toContain("Delivery service is down.");
	});

	it("stops the batches that have not been sent when the panel is closed mid-run", async () => {
		const bots = Array.from({ length: maxSpotlightSendBots + 1 }, (_, index) => bot(index + 1));
		const harness = stubFetch((call) => ({ spotlightId: "spt_run", deliveries: call.botIds.map(started) }), { hold: true });
		mountPanel(bots);
		clickText(`Select all (${bots.length})`);
		clickText("Send");
		await settle();

		const close = container().querySelector<HTMLButtonElement>("[aria-label='Close spotlight panel']");
		act(() => close?.click());
		expect(cleared).toBe(1);

		harness.release();
		await settle();

		// The batch already in flight is allowed to finish; the one behind it is
		// never sent, so its participants keep their spotlight for a later run.
		expect(harness.calls).toHaveLength(1);
		expect(toasts).toEqual([]);
	});
});
