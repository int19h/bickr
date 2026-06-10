import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { localizedText, type BotSummary, type LanguageTag } from "@bickr/shared/model";
import { BotSourceValue, ReferenceDataContext } from "./App";

const en = "en" as LanguageTag;
const now = "2026-05-21T12:00:00.000Z";

function lt(text: string) {
	return localizedText(text, en);
}

function testBot(overrides: Partial<BotSummary> & Pick<BotSummary, "handle" | "homeWorldHandle" | "id">): BotSummary {
	return {
		homeWorldId: "world_clone",
		ownerUserId: "usr_owner",
		language: en,
		displayName: lt("Test Bot"),
		shortBio: lt("Test participant."),
		inferenceSettings: {},
		postingSettings: {},
		effectivePostingSettings: { commentBodyCharacters: 2000, threadBodyCharacters: 6000 },
		tickSettings: { enabled: false, intervalSeconds: 86_400, compactionThreshold: 0.75 },
		effectiveTickSettings: {
			enabled: false,
			intervalSeconds: 86_400,
			compactionThreshold: 0.75,
			allowEarlyLogOff: true,
			contextWindowTokens: 16_000,
			compactionSummaryPercent: 15,
			compactionMaxCharacters: 12_000,
			maxToolCallsPerTick: 16,
			maxSuccessfulToolCallsPerIteration: 8,
			maxGeneratedTokensPerTick: 16_000,
			maxGeneratedTokensPerIteration: 4_000,
		},
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("BotSourceValue", () => {
	it("links a clone's source participant in the source world", () => {
		const source = testBot({
			id: "bot_source",
			homeWorldId: "world_source",
			homeWorldHandle: "source-world",
			handle: "source-handle",
			displayName: lt("Source Handle"),
			shortBio: lt("Original participant."),
		});
		const clone = testBot({
			id: "bot_clone",
			homeWorldId: "world_clone",
			homeWorldHandle: "clone-world",
			handle: "source-handle",
			displayName: lt("Clone Handle"),
			shortBio: lt("Clone participant."),
			cloneSource: {
				sourceBotId: "bot_source",
				sourceWorldId: "world_source",
				sourceWorldHandle: "source-world",
				sourceHandle: "source-handle",
				clonedAt: "2026-05-21T12:00:00.000Z",
				linked: true,
				sourceBot: source,
			},
		});

		const html = renderToStaticMarkup(
			<ReferenceDataContext.Provider
				value={{
					activeWorldHandle: "clone-world",
					bots: [clone],
					botsByWorld: { "clone-world": [clone] },
					forumsByWorld: {},
					humans: [],
					worlds: [],
				}}
			>
				<BotSourceValue bot={clone} />
			</ReferenceDataContext.Provider>,
		);

		expect(html).toContain('href="/w/source-world/u/source-handle"');
		expect(html).not.toContain('href="/w/clone-world/u/source-handle"');
		expect(html).not.toContain('href="/w/clone-world/u/source-handle?');
	});
});
