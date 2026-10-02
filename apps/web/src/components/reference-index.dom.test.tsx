import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { localizedText, type BotSummary } from "@bickr/shared/model";
import { Reference, ReferenceDataContext, referenceMeta, type ReferenceData } from "./content";
import { referenceBot } from "./reference-index";

function data(bots: BotSummary[]): ReferenceData {
	return { activeWorldHandle: "world", bots: [], botsByWorld: { world: bots }, forumsByWorld: {}, humans: [], worlds: [] };
}
it("renders a growing list with a linear number of reference lookups", () => {
	for (const n of [100, 1000, 2000]) {
		let reads = 0;
		const bots = Array.from({ length: n }, (_, i) => ({ id: `bot_${i}`, get handle() { reads++; return `b${i}`; }, homeWorldHandle: "world", displayName: "Name", shortBio: "Bio" } as unknown as BotSummary));
		const snapshot = data(bots);
		renderToStaticMarkup(<ReferenceDataContext.Provider value={snapshot}>{bots.map((_, i) => <Reference key={i} kind="bot" name={`b${i}`} worldHandle="world" />)}</ReferenceDataContext.Provider>);
		expect(reads).toBeLessThanOrEqual(n * 5);
		const afterBuild = reads;
		for (let i = 0; i < n; i++) referenceMeta(snapshot, "bot", `b${i}`, "world");
		expect(reads).toBe(afterBuild);
	}
});
it("preserves explicit world isolation and rebuilds for a new snapshot", () => {
	const bot = { id: "a", handle: "same", homeWorldHandle: "world", shortBio: localizedText("old", null) } as unknown as BotSummary;
	const first = data([bot]);
	expect(referenceBot(first, "same", "other")).toBeUndefined();
	expect(referenceBot(first, "same")).toBe(bot);
	const next = data([{ ...bot, shortBio: localizedText("new", null) }]);
	expect(referenceMeta(next, "bot", "same")?.description).toEqual(localizedText("new", null));
	expect(referenceMeta(first, "bot", "same")?.description).toEqual(localizedText("old", null));
});
