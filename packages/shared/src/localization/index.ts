import { InstructionTemplates, type MessageCatalog } from '../instruction-template.ts';
import type { InstructionLocale } from '../instruction-language.ts';
import { sharedMessageDefinitions } from './messages.ts';
import en from '../.generated/localization/en.ts';
import ru from '../.generated/localization/ru.ts';
import ja from '../.generated/localization/ja.ts';
import ar from '../.generated/localization/ar.ts';
import ko from '../.generated/localization/ko.ts';
import zh from '../.generated/localization/zh.ts';
import eo from '../.generated/localization/eo.ts';
import fr from '../.generated/localization/fr.ts';
import de from '../.generated/localization/de.ts';
import pt from '../.generated/localization/pt.ts';
import it from '../.generated/localization/it.ts';
import da from '../.generated/localization/da.ts';
import uk from '../.generated/localization/uk.ts';
import be from '../.generated/localization/be.ts';
import id from '../.generated/localization/id.ts';
import tr from '../.generated/localization/tr.ts';
import hi from '../.generated/localization/hi.ts';
import vi from '../.generated/localization/vi.ts';
import ga from '../.generated/localization/ga.ts';

export { sharedMessageDefinitions } from './messages.ts';

// Shared factories need only these strings. The browser never imports the full
// runtime catalog. A structural interface also accepts the larger BotText context.
export type FactoryText = Pick<InstructionTemplates<typeof sharedMessageDefinitions>, 'format' | 'locale'>;

const catalogs = { en, ru, ja, ar, ko, zh, eo, fr, de, pt, it, da, uk, be, id, tr, hi, vi, ga } satisfies Readonly<Record<InstructionLocale, MessageCatalog<typeof sharedMessageDefinitions>>>;
const contexts = new Map<InstructionLocale, FactoryText>();

export function factoryText(locale: InstructionLocale): FactoryText {
	const existing = contexts.get(locale);
	if (existing) return existing;
	const context = new InstructionTemplates(locale, sharedMessageDefinitions, catalogs[locale]);
	contexts.set(locale, context);
	return context;
}
