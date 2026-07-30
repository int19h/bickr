import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { localizedText, type LanguageTag } from "@bickr/shared/model";
import type { WorldView } from "../../components/content";
import { WorldEditPage, worldRecurringPromptIsValid } from "./world-edit";

const en = "en" as LanguageTag;
const now = "2026-07-30T12:00:00.000Z";

function world(overrides: Partial<WorldView> = {}): WorldView {
	return {
		id: "wld_recurring",
		handle: "recurring",
		language: en,
		name: localizedText("Recurring World", en),
		description: localizedText("Shared loop narration.", en),
		prompt: localizedText("A careful setting.", en),
		recurringPromptEnabled: true,
		recurringPrompt: localizedText("I remember this world's shared focus.", en),
		initialBotNotification: localizedText("Welcome.", en),
		createdByUserId: "usr_owner",
		createdAt: now,
		updatedAt: now,
		forumCount: 1,
		botCount: 1,
		bannerIdx: 0,
		isMine: true,
		myBotCount: 1,
		...overrides,
	};
}

function render(worldValue: WorldView, readonly = false): string {
	return renderToStaticMarkup(
		<WorldEditPage
			busy={false}
			onBack={() => undefined}
			onSave={async () => true}
			onWorldUpdated={() => undefined}
			readonly={readonly}
			world={worldValue}
		/>,
	);
}

describe("WorldEditPage recurring prompt", () => {
	it("shows the enabled world text and explains world-first single-message behavior", () => {
		const markup = render(world());

		expect(markup).toContain("I remember this world&#x27;s shared focus.");
		expect(markup).toContain("this world text appears first in the same assistant message");
		expect(markup).toMatch(/class="textarea recurring-prompt-editor"(?! disabled)/);
	});

	it("disables the textarea when the world contribution is off or read-only", () => {
		expect(render(world({
			recurringPromptEnabled: false,
			recurringPrompt: localizedText("Saved for later.", en),
		}))).toMatch(/class="textarea recurring-prompt-editor" disabled=""/);
		expect(render(world(), true)).toMatch(/class="textarea recurring-prompt-editor" disabled=""/);
	});

	it("requires nonblank enabled text while allowing disabled drafts", () => {
		expect(worldRecurringPromptIsValid(true, "   ")).toBe(false);
		expect(worldRecurringPromptIsValid(false, "   ")).toBe(true);
		expect(worldRecurringPromptIsValid(true, "I remember the shared focus.")).toBe(true);
	});
});
