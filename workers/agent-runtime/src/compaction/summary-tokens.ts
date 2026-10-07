import { instructionContentLanguage, type InstructionLocale } from '@bickr/shared/instruction-language';

/** Conservative prior for future summary text. This is an estimate, not a tokenizer bound. */
export function summaryLanguageTokenFloor(tag: string | null | undefined): number {
	if (!tag) return 0.5;
	try {
		const locale = new Intl.Locale(tag);
		const script = locale.script ?? (locale.language === 'und' ? undefined : locale.maximize().script);
		if (!script) return 0.5;
		if (script === 'Latn') return locale.language === 'vi' ? 1 : 0.25;
		if (['Cyrl', 'Grek', 'Arab', 'Hebr', 'Armn', 'Syrc', 'Thaa'].includes(script)) return 1;
		return 1.5;
	} catch { return 0.5; }
}

export function summaryTokenAllowance(primaryLanguage: string | null | undefined, instructionLocale: InstructionLocale, modelRatio: number): number {
	const instructionFloor = summaryLanguageTokenFloor(instructionContentLanguage(instructionLocale));
	const primaryFloor = primaryLanguage ? summaryLanguageTokenFloor(primaryLanguage) : instructionFloor;
	// The compaction instructions and the participant's speaking language can
	// both influence generated text. Reserve the larger approximate allowance.
	const floor = Math.max(primaryFloor, instructionFloor);
	return Math.max(floor, modelRatio || 0.25);
}
