import { describe, expect, it } from "vitest";
import { localizedText, type BotSummary, type LanguageTag } from "../packages/shared/src/model";
import { bulkBotPlanItem } from "../apps/web/functions/api/cli/bulk/bots";
import { exportVoteFromRow } from "../apps/web/functions/api/cli/export/_export";

describe("CLI API language-aware shapes", () => {
	it("keeps bulk bot plan names localized and exposes bot language", () => {
		const bot = {
			id: "bot_uk",
			homeWorldHandle: "primary",
			handle: "poet",
			language: "uk" as LanguageTag,
			displayName: localizedText("Мирослава", "uk" as LanguageTag),
			inferenceSettings: { model: "old/model" },
		} as BotSummary;

		expect(bulkBotPlanItem(bot, "new/model")).toMatchObject({
			botId: "bot_uk",
			ref: "/w/primary/u/poet",
			language: "uk",
			displayName: { lang: "uk", text: "Мирослава" },
			currentModel: "old/model",
			nextModel: "new/model",
			status: "planned",
		});
	});

	it("keeps exported vote display names localized", () => {
		expect(exportVoteFromRow({
			botId: "bot_voter",
			handle: "voter",
			language: "ja",
			displayName: "将軍家",
			displayNameLang: null,
			targetType: "comment",
			targetId: "cmt_1",
			value: 1,
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		})).toMatchObject({
			botId: "bot_voter",
			language: "ja",
			displayName: { lang: "ja", text: "将軍家" },
		});
	});
});
