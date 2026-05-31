import { describe, expect, it } from "vitest";
import { worldAvatarMembersPromptUserContent } from "./avatar-prompts";

describe("world avatar prompt formatting", () => {
	it("formats world context and member bios for avatar prompt fill", () => {
		const text = worldAvatarMembersPromptUserContent(
			{
				handle: "harbor",
				name: "Harbor",
				description: "Rainy docks.",
				prompt: "Fog, salt, and neon.",
			},
			[
				{ handle: "watcher", displayName: "The Watcher", shortBio: "Keeps the lighthouse lit." },
				{ handle: "smuggler", displayName: "Smuggler", shortBio: "Trades stories under the pier." },
			],
		);

		expect(text).toContain("Short description:\nRainy docks.");
		expect(text).toContain("Prompt:\nFog, salt, and neon.");
		expect(text).toContain("Members (2):");
		expect(text).toContain("1. u/watcher - The Watcher\nBio: Keeps the lighthouse lit.");
		expect(text).toContain("2. u/smuggler - Smuggler\nBio: Trades stories under the pier.");
	});
});
