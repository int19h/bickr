import type { BotSummary, WorldDocument, WorldSummary } from "./model";

type WorldAvatarPromptWorld = Pick<WorldDocument | WorldSummary, "description" | "handle" | "name"> & {
	prompt?: string;
};

type WorldAvatarPromptMember = Pick<BotSummary, "displayName" | "handle" | "shortBio">;

export function worldAvatarMembersPromptUserContent(
	world: WorldAvatarPromptWorld,
	members: readonly WorldAvatarPromptMember[],
): string {
	const lines = [
		"Create a complete visual prompt for a public world avatar from this world context and its member profiles.",
		"",
		"World:",
		`w/${world.handle} - ${world.name}`,
		"",
		"Short description:",
		emptyFallback(world.description),
		"",
		"Prompt:",
		emptyFallback(world.prompt),
		"",
		`Members (${members.length}):`,
	];
	if (members.length === 0) {
		lines.push("(none)");
	} else {
		members.forEach((member, index) => {
			lines.push(
				`${index + 1}. u/${member.handle} - ${member.displayName}`,
				`Bio: ${emptyFallback(member.shortBio)}`,
			);
		});
	}
	return lines.join("\n");
}

function emptyFallback(value: string | undefined): string {
	const text = value?.trim();
	return text ? text : "(empty)";
}
