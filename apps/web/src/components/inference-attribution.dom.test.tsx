import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferenceBadge } from "./inference-attribution";
import { BotActivityCard } from "../screens/bots/activity-feed";
import { parseLanguageTag } from "@bickr/shared/validation";
import { ReferencePopover } from "./content";
import type { BotActivityItem, BotSummary } from "@bickr/shared/model";

const attribution = { model: "vendor/model-full", parameters: { temperature: 0.7, reasoning: { effort: "high" } }, source: { botId: "bot-a", worldHandle: "primary", botHandle: "alice", runId: "run-a", requestSeq: 7 } };
let cleanup = async () => {};
afterEach(async () => { await cleanup(); vi.unstubAllGlobals(); });

describe("artifact model badge", () => {
	it("shows copyable immutable parameters and opens the source instead of following the activity card", async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
		const activity: BotActivityItem = { type: "follow", id: "act-a", createdAt: "2026-10-01T00:00:00Z", inferenceAttribution: attribution,
			bot: { id: "bot-b", homeWorldId: "world-a", homeWorldHandle: "primary", handle: "bob", displayName: { text: "Bob", lang: parseLanguageTag("en") }, shortBio: { text: "Bio", lang: parseLanguageTag("en") }, language: parseLanguageTag("en"), createdAt: "", updatedAt: "" } };
		await act(async () => root.render(<BotActivityCard activity={activity} highlighted={false} onReference={() => {}} />));
		const button = host.querySelector<HTMLButtonElement>("button.inference-model-name")!;
		expect(button.textContent).toBe("model-full");
		await act(async () => button.click());
		const fields = [...document.querySelectorAll<HTMLInputElement>(".modal input")];
		expect(fields.map(field => field.value)).toEqual(["vendor/model-full", "0.7", '{"effort":"high"}']);
		expect(fields.every(field => field.readOnly)).toBe(true);
		expect(document.querySelector<HTMLAnchorElement>(".modal a")?.getAttribute("href")).toBe("/inference/bot-a/run-a/7");
		await act(async () => root.render(<InferenceBadge />));
		expect(host.textContent).toBe("");
	});
	it("shows the current effective model in a profile hover card", async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { model: { botId: "bot-a", effectiveModel: "vendor/current-model" } } }), { headers: { "content-type": "application/json" } })));
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
		const bot = { id: "bot-a", homeWorldHandle: "primary", handle: "alice", displayName: { text: "Alice", lang: parseLanguageTag("en") }, shortBio: { text: "Bio", lang: parseLanguageTag("en") } } as BotSummary;
		await act(async () => root.render(<ReferencePopover active meta={{ bot, title: bot.displayName, description: bot.shortBio }} />));
		expect(host.querySelector(".ref-pop-username")?.textContent).toBe("u/alice · current-model");
		expect(host.querySelector(".inference-model-name")?.getAttribute("title")).toBe("vendor/current-model");
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/worlds/primary/bots/alice/effective-model");
	});

});
