import { instructionContentLanguage, type InstructionLocale } from "./instruction-language.ts";

export type InstructionText = string & { readonly __instructionText: unique symbol };
export type PluralValue = { readonly kind: "plural"; readonly count: number; readonly text: string };
export type SelectValue<Variant extends string = string> = { readonly kind: "select"; readonly select: Variant; readonly text: string };
export type PluralCategory = Intl.LDMLPluralRule;
export type MessageDefinition =
	| { readonly kind: "text"; readonly parameters: readonly string[] }
	| { readonly kind: "plural"; readonly parameters: readonly string[]; readonly count: string }
	| { readonly kind: "select"; readonly parameters: readonly string[]; readonly select: string; readonly variants: readonly string[] };
export type MessageDefinitions = Readonly<Record<string, MessageDefinition>>;
export type PluralMessage = Readonly<Partial<Record<PluralCategory, string>>> & { readonly other: string };
export type MessageCatalog<Definitions extends MessageDefinitions> = {
	readonly [Key in keyof Definitions]: Definitions[Key]["kind"] extends "plural" ? PluralMessage : Definitions[Key] extends { readonly kind: "select"; readonly variants: readonly (infer Variant extends string)[] } ? Readonly<Record<Variant, string>> : string;
};
type Values<Definition extends MessageDefinition> =
	{ readonly [Name in Definition["parameters"][number]]: string | number | SelectValue | PluralValue } &
	(Definition extends { readonly kind: "plural"; readonly count: infer Count extends string } ? { readonly [Name in Count]: number | PluralValue } : unknown) &
	(Definition extends { readonly kind: "select"; readonly select: infer Select extends string; readonly variants: readonly (infer Variant extends string)[] } ? { readonly [Name in Select]: Variant | SelectValue<Variant> } : unknown);
export type InstructionArguments<Definition extends MessageDefinition> = Definition["parameters"] extends readonly [] ? [] : [values: Values<Definition>];
export type MessageDescriptor<Definitions extends MessageDefinitions> = {
	[Key in keyof Definitions]: { readonly key: Key; readonly parameters: Values<Definitions[Key]> };
}[keyof Definitions];
type Segment = { kind: "literal"; text: string } | { kind: "parameter"; name: string };
type CompiledMessage =
	| { kind: "select"; select: string; cases: ReadonlyMap<string, readonly Segment[]> }
	| { kind: "text"; segments: readonly Segment[] }
	| { kind: "plural"; count: string; rules: Intl.PluralRules; cases: ReadonlyMap<PluralCategory, readonly Segment[]> };

/** Parse only catalog templates. Inserted participant text never goes through the parser. */
function compileTemplate(template: string, names: readonly string[], optional?: string): readonly Segment[] {
	const segments: Segment[] = [];
	const found = new Set<string>();
	let cursor = 0;
	while (cursor < template.length) {
		const start = template.indexOf("{{", cursor);
		if (start < 0) { segments.push({ kind: "literal", text: template.slice(cursor) }); break; }
		if (start > cursor) segments.push({ kind: "literal", text: template.slice(cursor, start) });
		const end = template.indexOf("}}", start + 2);
		if (end < 0) throw new Error("Unclosed instruction template parameter.");
		const name = template.slice(start + 2, end);
		if (!names.includes(name)) throw new Error(`Unknown instruction template parameter: ${name}`);
		found.add(name);
		segments.push({ kind: "parameter", name });
		cursor = end + 2;
	}
	if (names.some((name) => name !== optional && !found.has(name))) throw new Error("Instruction template omits a required parameter.");
	return segments;
}

/** A complete immutable language context. There is no missing-message or English fallback. */
export class InstructionTemplates<Definitions extends MessageDefinitions> {
	readonly locale: InstructionLocale;
	private readonly compiled: ReadonlyMap<keyof Definitions, CompiledMessage>;
	private readonly definitions: Definitions;

	constructor(locale: InstructionLocale, definitions: Definitions, catalog: MessageCatalog<Definitions>) {
		this.locale = locale;
		this.definitions = definitions;
		const expected = Object.keys(definitions);
		const actual = Object.keys(catalog);
		if (expected.length !== actual.length || actual.some((key) => !Object.hasOwn(definitions, key))) {
			throw new Error("Instruction catalog does not match its message definitions.");
		}
		const compiled = new Map<keyof Definitions, CompiledMessage>();
		let rules: Intl.PluralRules | undefined;
		for (const key of expected) {
			const definition = definitions[key]!;
			const entry = catalog[key];
			switch (definition.kind) {
				case "text": {
					if (typeof entry !== "string") throw new Error(`Instruction message must be text: ${key}`);
					compiled.set(key, { kind: "text", segments: compileTemplate(entry, definition.parameters) });
					break;
				}
				case "select": {
					if (!definition.parameters.includes(definition.select) || !definition.variants.length || new Set(definition.variants).size !== definition.variants.length) throw new Error(`The instruction select definition is not valid: ${key}`);
					if (!entry || typeof entry !== "object") throw new Error(`The instruction message needs select variants: ${key}`);
					const supplied = Object.keys(entry);
					if (supplied.length !== definition.variants.length || supplied.some((variant) => !definition.variants.includes(variant))) throw new Error(`The instruction message omits select variants: ${key}`);
					const variants = entry as Readonly<Record<string, string>>;
					compiled.set(key, { kind: "select", select: definition.select, cases: new Map(definition.variants.map((variant) => {
						const template = variants[variant];
						if (typeof template !== "string") throw new Error(`The instruction select variant is missing: ${key}.${variant}`);
						return [variant, compileTemplate(template, definition.parameters, definition.select)] as const;
					})) });
					break;
				}
				case "plural": {
					if (!definition.parameters.includes(definition.count)) throw new Error(`Invalid instruction count parameter: ${key}`);
					if (!entry || typeof entry !== "object") throw new Error(`Instruction message needs count variants: ${key}`);
					rules ??= new Intl.PluralRules(instructionContentLanguage(locale));
					const categories = rules.resolvedOptions().pluralCategories;
					const supplied = Object.keys(entry);
					if (categories.length !== supplied.length || supplied.some((category) => !categories.includes(category as PluralCategory))) {
						throw new Error(`Instruction message omits native count variants: ${key}`);
					}
					const variants = entry as PluralMessage;
					const cases = new Map(categories.map((category) => {
						const template = variants[category];
						if (typeof template !== "string") throw new Error(`Missing instruction count variant: ${key}.${category}`);
						return [category, compileTemplate(template, definition.parameters)] as const;
					}));
					compiled.set(key, { kind: "plural", count: definition.count, rules, cases });
					break;
				}
			}
		}
		this.compiled = compiled;
	}

	format<Key extends keyof Definitions>(key: Key, ...args: InstructionArguments<Definitions[Key]>): InstructionText {
		return this.render(key, args[0] as Readonly<Record<string, string | number | SelectValue | PluralValue>> | undefined);
	}

	formatDescriptor(descriptor: MessageDescriptor<Definitions>): InstructionText {
		return this.render(descriptor.key, descriptor.parameters);
	}

	private render(key: keyof Definitions, values: Readonly<Record<string, string | number | SelectValue | PluralValue>> | undefined): InstructionText {
		const message = this.compiled.get(key);
		if (!message) throw new Error(`Unknown instruction message: ${String(key)}`);
		const expected = this.definitions[key]!.parameters;
		const supplied = Object.keys(values ?? {});
		if (expected.length !== supplied.length || supplied.some((name) => !expected.includes(name))) {
			throw new Error('Instruction values do not match the message parameters.');
		}
		let segments: readonly Segment[];
		switch (message.kind) {
			case "text": segments = message.segments; break;
			case "select": {
				const value = values?.[message.select];
				const selected = typeof value === "string" ? message.cases.get(value) : value && typeof value === "object" ? message.cases.get(value.kind === "select" ? value.select : "") : undefined;
				if (!selected) throw new Error(`The instruction select value is not valid: ${message.select}`);
				segments = selected;
				break;
			}
			case "plural": {
				const suppliedCount = values?.[message.count];
				const count = suppliedCount && typeof suppliedCount === "object" && suppliedCount.kind === "plural" ? suppliedCount.count : suppliedCount;
				if (typeof count !== "number" || !Number.isSafeInteger(count)) throw new Error(`Invalid instruction count: ${message.count}`);
				const selected = message.cases.get(message.rules.select(count));
				if (!selected) throw new Error("Missing native instruction count variant.");
				segments = selected;
				break;
			}
		}
		return segments.map((segment) => {
			if (segment.kind === "literal") return segment.text;
			const suppliedValue = values?.[segment.name];
			const value = suppliedValue && typeof suppliedValue === "object" ? suppliedValue.text : suppliedValue;
			if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
				throw new Error(`Invalid instruction template parameter: ${segment.name}`);
			}
			return String(value);
		}).join("") as InstructionText;
	}
}
