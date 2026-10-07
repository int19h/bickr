import { InstructionTemplates, type MessageCatalog } from '../instruction-template.ts';
import type { InstructionLocale } from '../instruction-language.ts';
import { sharedMessageDefinitions } from './messages.ts';
import en from './en/index.ts';
import ru from './ru/index.ts';
import ja from './ja/index.ts';
import ar from './ar/index.ts';
import ko from './ko/index.ts';
import zh from './zh/index.ts';
import eo from './eo/index.ts';
import fr from './fr/index.ts';
import de from './de/index.ts';
import pt from './pt/index.ts';
import it from './it/index.ts';
import da from './da/index.ts';
import uk from './uk/index.ts';
import be from './be/index.ts';
import id from './id/index.ts';
import tr from './tr/index.ts';
import hi from './hi/index.ts';
import vi from './vi/index.ts';
import ga from './ga/index.ts';

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
