import { localizedTextString, type BotSummary, type LocalizedText, type WorldDocument, type WorldSummary } from "./model";

type WorldAvatarPromptWorld = Pick<WorldDocument | WorldSummary, "description" | "handle" | "name"> & {
	prompt?: LocalizedText | string;
};

export type WorldAvatarPromptMember = Pick<BotSummary, "displayName" | "handle" | "shortBio">;
export const worldAvatarMemberLimit = 100;
export type WorldAvatarMemberSelection =
	| { kind: "all"; members: readonly WorldAvatarPromptMember[] }
	| { kind: "sample"; members: readonly WorldAvatarPromptMember[] };

export function selectWorldAvatarMembers(members: readonly WorldAvatarPromptMember[]): WorldAvatarMemberSelection {
	return members.length > worldAvatarMemberLimit
		? { kind: "sample", members: members.slice(0, worldAvatarMemberLimit) }
		: { kind: "all", members };
}

export function worldAvatarMembersPromptUserContent(
	world: WorldAvatarPromptWorld,
	input: readonly WorldAvatarPromptMember[],
): string {
	return worldAvatarSelectedMembersPromptUserContent(world, selectWorldAvatarMembers(input));
}

export function worldAvatarSelectedMembersPromptUserContent(world: WorldAvatarPromptWorld, selection: WorldAvatarMemberSelection): string {
	const members = selection.members;
	const lines = [
		"Create a complete visual prompt for a public world avatar from this world context and its member profiles.",
		"",
		"World:",
		`w/${world.handle} - ${localizedTextString(world.name)}`,
		"",
		"Short description:",
		emptyFallback(world.description),
		"",
		"Prompt:",
		emptyFallback(world.prompt),
		"",
		selection.kind === "sample"
			? `Members (sample of ${members.length}; more members exist):`
			: `Members (${members.length}):`,
	];
	if (members.length === 0) {
		lines.push("(none)");
	} else {
		members.forEach((member, index) => {
			lines.push(
				`${index + 1}. u/${member.handle} - ${localizedTextString(member.displayName)}`,
				`Bio: ${emptyFallback(member.shortBio)}`,
			);
		});
	}
	return lines.join("\n");
}

function emptyFallback(value: LocalizedText | string | undefined): string {
	const text = localizedTextString(value).trim();
	return text ? text : "(empty)";
}
