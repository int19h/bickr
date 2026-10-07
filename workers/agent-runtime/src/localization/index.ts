import { InstructionTemplates, type MessageCatalog, type InstructionArguments, type InstructionText } from "@bickr/shared/instruction-template";
import { instructionContentLanguage, instructionLocales, type InstructionLocale } from "@bickr/shared/instruction-language";
import { messageParameters } from "./messages";
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
import type { EffectiveBotDocument } from "@bickr/shared/model";
import { transcriptHeaderMatcher } from './transcript-header';

export type RenderedInstructionIssue = {
	readonly message: InstructionText;
	readonly ownerMessage: InstructionText;
};

export type BotText = BotTextContext;

// Only this module pairs a locale with its catalog.
class BotTextContext extends InstructionTemplates<typeof messageParameters> {
	readonly contentLanguage: string;
	readonly catalogIdentity: string;
	private readonly matchesLocalTranscriptHeader: (line: string) => boolean;
	constructor(locale: InstructionLocale, catalog: MessageCatalog<typeof messageParameters>) {
		super(locale, messageParameters, catalog);
		this.contentLanguage = instructionContentLanguage(locale);
		this.catalogIdentity = `bickr-instructions-v1:${locale}`;
		this.matchesLocalTranscriptHeader = transcriptHeaderMatcher([
			this.format('formatting.action'), this.format('formatting.result'), this.format('formatting.input'), this.format('formatting.thought'),
		].map((label) => ({ label, language: this.contentLanguage })));
	}

	issue<Key extends keyof typeof messageParameters>(key: Key, ...args: InstructionArguments<typeof messageParameters[Key]>): RenderedInstructionIssue {
		return { message: this.format(key, ...args), ownerMessage: englishText.format(key, ...args) };
	}

	joinIssues(...issues: readonly RenderedInstructionIssue[]): RenderedInstructionIssue {
		// Each part is a complete sentence, already rendered with its own count rules.
		return {
			message: issues.map((issue) => issue.message).join(this.format('formatting.sentenceSeparator')) as InstructionText,
			ownerMessage: issues.map((issue) => issue.ownerMessage).join(englishText.format('formatting.sentenceSeparator')) as InstructionText,
		};
	}

	andList(values: readonly string[]): string {
		if (values.length < 2) return values[0] ?? '';
		return this.format(values.length === 2 ? 'formatting.andPair' : 'formatting.andMany', {
			first: values.slice(0, -1).join(this.format('formatting.listSeparator')), last: values.at(-1)!,
		});
	}

	isContinuation(value: unknown): boolean {
		return typeof value === "string" && continuationTexts.has(value);
	}

	get transcriptLabels(): readonly string[] {
		return [...new Set([
			"Action", "Result", "Input", "New thought",
			this.format("formatting.action"), this.format("formatting.result"), this.format("formatting.input"), this.format("formatting.thought"),
		])];
	}

	isTranscriptHeader(line: string): boolean {
		return matchesCatalogTranscriptHeader(line) || this.matchesLocalTranscriptHeader(line);
	}

	get transcriptLabelList(): string {
		const labels = this.transcriptLabels.map((label) => `${label}:`);
		return this.format(labels.length === 2 ? "formatting.orPair" : "formatting.orMany", {
			first: labels.slice(0, -1).join(this.format("formatting.listSeparator")), last: labels.at(-1)!,
		});
	}
}

const catalogs = { en, ru, ja, ar, ko, zh, eo, fr, de, pt, it, da, uk, be, id, tr, hi, vi, ga } satisfies Readonly<Record<InstructionLocale, MessageCatalog<typeof messageParameters>>>;
const contexts = new Map<InstructionLocale, BotText>();
const englishText = botText("en");
// Raw labels let a participant change languages without compiling every catalog.
const matchesCatalogTranscriptHeader = transcriptHeaderMatcher(instructionLocales.flatMap((locale) => {
	const catalog = catalogs[locale];
	return [catalog['formatting.action'], catalog['formatting.result'], catalog['formatting.input'], catalog['formatting.thought']]
		.map((label) => ({ label, language: instructionContentLanguage(locale) }));
}));
const continuationTexts: ReadonlySet<string> = new Set(instructionLocales.map((locale) => catalogs[locale]['compaction.continuation']));
export function botText(locale: InstructionLocale): BotText {
	const existing = contexts.get(locale);
	if (existing) return existing;
	const context = new BotTextContext(locale, catalogs[locale]);
	contexts.set(locale, context);
	return context;
}

export function botTextFor(bot: Pick<EffectiveBotDocument, "instructionLocale">): BotText {
	return botText(bot.instructionLocale);
}
