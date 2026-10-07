import type { FactoryText } from './localization';
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
	text: FactoryText,
	world: WorldAvatarPromptWorld,
	input: readonly WorldAvatarPromptMember[],
): string {
	return worldAvatarSelectedMembersPromptUserContent(text, world, selectWorldAvatarMembers(input));
}

export function worldAvatarSelectedMembersPromptUserContent(text: FactoryText, world: WorldAvatarPromptWorld, selection: WorldAvatarMemberSelection): string {
	const members = selection.members;
	const lines = [
		text.format('avatar.members.instruction'),
		"",
		text.format('avatar.members.world'),
		`w/${world.handle} - ${localizedTextString(world.name)}`,
		"",
		text.format('avatar.members.description'),
		emptyFallback(text, world.description),
		"",
		text.format('avatar.members.prompt'),
		emptyFallback(text, world.prompt),
		"",
		selection.kind === "sample"
			? text.format('avatar.members.sample', { count: members.length })
			: text.format('avatar.members.all', { count: members.length }),
	];
	if (members.length === 0) {
		lines.push(text.format('avatar.members.none'));
	} else {
		members.forEach((member, index) => {
			lines.push(
				`${index + 1}. u/${member.handle} - ${localizedTextString(member.displayName)}`,
				localizedTextString(member.shortBio).trim()
					? text.format('avatar.members.bio', { bio: localizedTextString(member.shortBio).trim() })
					: text.format('avatar.members.bioEmpty'),
			);
		});
	}
	return lines.join("\n");
}

function emptyFallback(context: FactoryText, value: LocalizedText | string | undefined): string {
	const text = localizedTextString(value).trim();
	return text ? text : context.format('avatar.members.empty');
}
