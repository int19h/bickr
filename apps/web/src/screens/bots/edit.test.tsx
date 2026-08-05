import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { localizedText, type BotSummary, type LanguageTag } from "@bickr/shared/model";
import { parseUpdateBotInput } from "@bickr/shared/validation";
import { BotEdit } from "./edit";
import { botEditDraftFromBot, parseBotEditDraft, updateBotInputFromEditDraft } from "./bot-drafts";

const en = "en" as LanguageTag;
const now = "2026-08-05T00:00:00.000Z";

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
	return {
		id: "bot_scout",
		handle: "scout",
		homeWorldId: "wld_one",
		homeWorldHandle: "patch-notes",
		ownerUserId: "usr_one",
		language: en,
		includeLanguageInSystemPrompt: false,
		displayName: localizedText("Scout", en),
		shortBio: localizedText("A scout.", en),
		prompt: localizedText("You are a scout.", en),
		inferenceSettings: {
			model: "anthropic/claude-opus-4",
			recurringPromptEnabled: true,
			recurringPrompt: localizedText("I check the feed.", en),
		},
		toolSettings: {},
		postingSettings: {},
		effectivePostingSettings: { commentBodyCharacters: 2_000, threadBodyCharacters: 6_000 },
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

function render(target = bot()): string {
	return renderToStaticMarkup(
		<BotEdit
			bot={target}
			busy={false}
			onBack={() => undefined}
			onDelete={async () => true}
			onRelinkClone={async () => true}
			onSave={async () => true}
			onUnlinkClone={async () => true}
			personalForum={null}
			personalForumsLoaded
			world={null}
		/>,
	);
}

describe("BotEdit inference boundary", () => {
	it("links the participant's configuration instead of editing reusable inference", () => {
		const markup = render();
		expect(markup).toContain("Inference configuration");
		expect(markup).toContain("live in its inference configuration");
		expect(markup).not.toContain("Inference: Agentic Loop");
		expect(markup).not.toContain("Inference Provider");
		expect(markup).not.toContain("OpenRouter API key");
		expect(markup).not.toContain("Base URL");
		expect(markup).not.toContain("Prompt cache");
		expect(markup).not.toContain("Provider routing");
	});

	it("keeps every excluded participant control on this editor", () => {
		const markup = render();
		for (const label of [
			"Prompt",
			"Recurring prompt",
			"Context budget",
			"Tick interval",
			"Max tool call attempts per tick",
			"Max generated tokens per tick",
			"Max successful tool calls per iteration",
			"Max generated tokens per iteration",
			"Compaction percentage",
			"Max number of characters after compaction",
			"Allow to log off early",
			"Thread body characters",
			"Comment body characters",
			"OpenRouter Server Tools",
			"Web Search",
			"Web Fetch",
		]) {
			expect(markup).toContain(label);
		}
		expect(markup).toContain("I check the feed.");
	});
});

describe("bot edit save payload", () => {
	it("sends only the participant-owned recurring prompt as inference settings", () => {
		const draft = botEditDraftFromBot(bot());
		const input = updateBotInputFromEditDraft(draft, parseBotEditDraft(draft), false);
		expect(input.inferenceSettings).toEqual({
			recurringPromptEnabled: true,
			recurringPrompt: { lang: en, text: "I check the feed." },
		});
	});

	// The compatibility adapter derives its replacement mask from the keys a
	// legacy write carries, so an ordinary participant save must carry no
	// reusable inference key at all or it would replace graph overrides.
	it("carries no reusable inference key through the validated update input", () => {
		const draft = botEditDraftFromBot(bot());
		const input = updateBotInputFromEditDraft(draft, parseBotEditDraft(draft), false);
		const parsed = parseUpdateBotInput({ language: en, ...input });
		expect(Object.keys(parsed.inferenceSettings ?? {}).sort()).toEqual(["recurringPrompt", "recurringPromptEnabled"]);
		expect(parsed.inferenceSettings).not.toHaveProperty("imageGeneration");
		expect(parsed.inferenceSettings).not.toHaveProperty("translation");
	});

	it("clears a recurring prompt that the owner emptied", () => {
		const draft = { ...botEditDraftFromBot(bot()), recurringPrompt: "  " };
		const input = updateBotInputFromEditDraft(draft, parseBotEditDraft(draft), false);
		expect(input.inferenceSettings).toEqual({ recurringPromptEnabled: true, recurringPrompt: null });
	});
});
