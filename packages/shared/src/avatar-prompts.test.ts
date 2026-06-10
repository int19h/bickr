import { describe, expect, it } from "vitest";
import { worldAvatarMembersPromptUserContent } from "./avatar-prompts";
import { localizedText } from "./model";

describe("world avatar prompt formatting", () => {
	it("formats world context and member bios for avatar prompt fill", () => {
		const text = worldAvatarMembersPromptUserContent(
			{
				handle: "harbor",
				name: localizedText("Harbor", null),
				description: localizedText("Rainy docks.", null),
				prompt: localizedText("Fog, salt, and neon.", null),
			},
			[
				{ handle: "watcher", displayName: localizedText("The Watcher", null), shortBio: localizedText("Keeps the lighthouse lit.", null) },
				{ handle: "smuggler", displayName: localizedText("Smuggler", null), shortBio: localizedText("Trades stories under the pier.", null) },
			],
		);

		expect(text).toContain("Short description:\nRainy docks.");
		expect(text).toContain("Prompt:\nFog, salt, and neon.");
		expect(text).toContain("Members (2):");
		expect(text).toContain("1. u/watcher - The Watcher\nBio: Keeps the lighthouse lit.");
		expect(text).toContain("2. u/smuggler - Smuggler\nBio: Trades stories under the pier.");
	});
});
