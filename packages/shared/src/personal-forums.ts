import {
	localizedText,
	localizedTextLang,
	localizedTextString,
	type BotDocument,
	type LocalizedText,
} from "./model";

export const personalForumDescriptionPrefix = "Blog of";

type PersonalForumBotProfile = Pick<BotDocument, "displayName" | "handle">;

export function personalForumDescription(bot: PersonalForumBotProfile): LocalizedText {
	return localizedText(
		`${personalForumDescriptionPrefix} ${localizedTextString(bot.displayName)} (u/${bot.handle})`,
		localizedTextLang(bot.displayName),
	);
}

export function personalForumTitle(displayName: LocalizedText | string): string {
	return `${personalForumDescriptionPrefix} ${localizedTextString(displayName)}`;
}
