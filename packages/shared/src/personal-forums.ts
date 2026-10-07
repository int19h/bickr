import { factoryText } from './localization';
import { automaticInstructionLocale, instructionContentLanguage } from './instruction-language';
import { localizedText, localizedTextString, type BotDocument, type LocalizedText } from './model';

type PersonalForumBotProfile = Pick<BotDocument, 'displayName' | 'handle' | 'language'>;

export function personalForumDescription(bot: PersonalForumBotProfile): LocalizedText {
	const text = factoryText(automaticInstructionLocale(bot.language));
	return localizedText(text.format('factory.personalForumDescription', {
		displayName: localizedTextString(bot.displayName), username: `u/${bot.handle}`,
	}), instructionContentLanguage(text.locale));
}

export function personalForumTitle(bot: PersonalForumBotProfile): string {
	return factoryText(automaticInstructionLocale(bot.language)).format('factory.personalForumTitle', {
		displayName: localizedTextString(bot.displayName),
	});
}
