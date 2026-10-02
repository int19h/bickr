import { describe, expect, it } from "vitest";
import { selectWorldAvatarMembers, worldAvatarMembersPromptUserContent } from "./avatar-prompts";
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

	it("bounds member profiles and discloses sampling", () => {
		const members = Array.from({ length: 1_000 }, (_, i) => ({
			handle: `member-${i}`, displayName: localizedText(`Member ${i}`, null), shortBio: localizedText("Profile", null),
		}));
		const selected = selectWorldAvatarMembers(members);
		expect(selected.kind).toBe("sample");
		expect(selected.members).toHaveLength(100);
		const text = worldAvatarMembersPromptUserContent({ handle: "world", name: localizedText("World", null), description: localizedText("", null) }, members);
		expect(text).toContain("sample of 100; more members exist");
		expect(text).toContain("u/member-99 -");
		expect(text).not.toContain("u/member-100 -");
	});
});
