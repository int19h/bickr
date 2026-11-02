import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, BotTickSpreadResult } from "@bickr/shared/model";
import { MyBotsScreen } from "./index";

let container: HTMLDivElement;
let root: Root;
let onSpreadBotTicks: ReturnType<typeof vi.fn<(bots: BotSummary[]) => Promise<BotTickSpreadResult | null>>>;

function bot(handle: string, options: { enabled?: boolean } = {}): BotSummary {
	return {
		id: `bot_${handle}`,
		handle,
		homeWorldId: "wld_test",
		homeWorldHandle: "test-world",
		ownerUserId: "usr_test",
		displayName: { lang: "en", text: handle },
		shortBio: { lang: "en", text: `${handle} bio` },
		tickSettings: { enabled: options.enabled ?? true, intervalSeconds: 60 },
		nextDueAt: "2026-05-21T12:00:00.000Z",
		createdAt: "2026-05-21T11:00:00.000Z",
		updatedAt: "2026-05-21T11:00:00.000Z",
	} as BotSummary;
}

async function flush(): Promise<void> {
	for (let pass = 0; pass < 5; pass += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

function button(text: string): HTMLButtonElement | null {
	return [...container.querySelectorAll<HTMLButtonElement>(".page-header button")]
		.find((candidate) => candidate.textContent?.trim() === text) ?? null;
}

async function select(handle: string): Promise<void> {
	const checkbox = container.querySelector<HTMLInputElement>(`input[aria-label="Select u/${handle}"]`);
	expect(checkbox, `checkbox for ${handle}`).not.toBeNull();
	await act(async () => checkbox!.click());
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
		const path = String(input);
		if (path === "/api/me/bots/token-spend") {
			return Response.json({ ok: true, data: { spendByBotId: {} } });
		}
		if (path.startsWith("/api/me/inference-configurations/effective-models?")) {
			return Response.json({ ok: true, data: { effectiveModels: { models: [] } } });
		}
		throw new Error(`Unexpected test request: ${path}`);
	}));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	onSpreadBotTicks = vi.fn(async () => null);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function render(bots: BotSummary[]): Promise<void> {
	await act(async () => root.render(
		<MyBotsScreen
			bots={bots}
			onDeleteBots={async () => ({ deleted: [], failed: [] })}
			onRunBotTicks={async () => undefined}
			onSpreadBotTicks={onSpreadBotTicks}
			worlds={[]}
		/>,
	));
	await flush();
}

describe("My bots spread selection", () => {
	it("hides spread with no selection and sends only checked bot IDs", async () => {
		const first = bot("first");
		const unchecked = bot("unchecked");
		const second = bot("second");
		await render([first, unchecked, second]);
		expect(button("Spread ticks")).toBeNull();

		await select("first");
		await select("second");
		expect(button("Spread ticks")?.disabled).toBe(false);
		await act(async () => button("Spread ticks")!.click());
		expect(container.querySelector(".confirm-body")?.textContent).toContain("This will reschedule 2 checked bots");

		await act(async () => {
			[...container.querySelectorAll<HTMLButtonElement>("button.primary")]
				.find((candidate) => candidate.textContent?.trim() === "Spread ticks")!
				.click();
		});
		expect(onSpreadBotTicks).toHaveBeenCalledTimes(1);
		expect(onSpreadBotTicks.mock.calls[0]![0].map((entry) => entry.id)).toEqual([first.id, second.id]);
	});

	it("disables spread when every checked bot is paused", async () => {
		await render([
			bot("paused-one", { enabled: false }),
			bot("paused-two", { enabled: false }),
			bot("unchecked"),
		]);

		await select("paused-one");
		await select("paused-two");
		const spread = button("Spread ticks");
		expect(spread?.disabled).toBe(true);
		expect(spread?.title).toContain("All checked bots are paused");
	});

	it("counts selected paused bots and warns that running bots stay unchanged", async () => {
		const active = bot("active");
		const paused = bot("paused", { enabled: false });
		await render([active, paused]);

		await select("active");
		await select("paused");
		await act(async () => button("Spread ticks")!.click());

		const confirmation = container.querySelector(".confirm-body")?.textContent ?? "";
		expect(confirmation).toContain("This will reschedule 1 checked bot");
		expect(confirmation).toContain("1 checked bot stays unchanged because it is paused");
		expect(confirmation).toContain("A checked bot that is running when you confirm stays unchanged");
		expect(confirmation).not.toContain("unchecked");
	});
});
