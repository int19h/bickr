import { instructionContentLanguage, type InstructionLocale } from '@bickr/shared/instruction-language';
import type { InstructionText, InstructionTemplates, MessageDefinitions, SelectValue, PluralValue } from '@bickr/shared/instruction-template';

export type FreeText = string & { readonly __freeText: unique symbol };
export type InlineKind = 'threadRef' | 'commentRef' | 'profileRef' | 'forumRef' | 'noteId' | 'cursor' | 'count' | 'score' | 'timestamp' | 'author';
type InlinePayloads = {
	threadRef: { readonly ref: string; readonly title?: FreeText };
	commentRef: string;
	profileRef: string;
	forumRef: string;
	noteId: string;
	cursor: string;
	count: number;
	score: number;
	timestamp: string;
	author: { readonly ref: string; readonly displayName?: FreeText; readonly person: 'self' | 'other' };
};
/** Each wrapper brands its payload and selects exactly one inline renderer. */
export type InlineValue<Kind extends InlineKind = InlineKind> = {
	[K in Kind]: { readonly kind: K; readonly value: InlinePayloads[K] }
}[Kind];
export type InlineRenderers = { readonly [K in InlineKind]: (value: InlinePayloads[K]) => string };
export interface RenderContext<Definitions extends MessageDefinitions = MessageDefinitions> {
	readonly catalog: InstructionTemplates<Definitions>;
	readonly inline: InlineRenderers;
	readonly quotationMarks: { readonly open: InstructionText; readonly close: InstructionText };
}

type InlineContext = Pick<RenderContext, 'inline' | 'quotationMarks'>;
export function quote(value: FreeText): string {
	return value.split(/\r\n|\r|\n/).map((line) => line ? `> ${line}` : '>').join('\n');
}
export function cell(value: FreeText, context?: InlineContext): string;
export function cell(value: InlineValue, context: InlineContext): string;
export function cell(value: FreeText | InlineValue, context?: InlineContext): string {
	if (typeof value !== 'string' && !context) throw new Error('An inline cell needs a render context.');
	const rendered = typeof value === 'string' ? value : inline(value, context!);
	// Escape backslashes first so that an authored backslash cannot cancel a pipe escape.
	return rendered.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ').trim();
}
export function line(value: FreeText, context: InlineContext): string {
	return `${context.quotationMarks.open}${value.replace(/\r\n|\r|\n/g, ' ')}${context.quotationMarks.close}`;
}
export function code(value: FreeText | InlineValue<'noteId' | 'cursor'>): string {
	const text = typeof value === 'string' ? value : value.value;
	const normalized = text.replace(/\r\n|\r|\n/g, ' ');
	if (!normalized) return '';
	let fenceLength = 1;
	for (const run of normalized.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run[0].length + 1);
	const fence = '`'.repeat(fenceLength);
	// CommonMark removes one padding space from each end of a code span.
	const padding = /^`|`$/.test(normalized) || (/^ .* $/.test(normalized) && /[^ ]/.test(normalized)) ? ' ' : '';
	return `${fence}${padding}${normalized}${padding}${fence}`;
}
export function text(value: InstructionText): string { return value; }
export function rawLast(value: FreeText): string { return value; }
export function inline(value: InlineValue, context: InlineContext): string {
	// The kind field selects the renderer and its payload type.
	// This cast keeps their link at the registry boundary.
	const render = context.inline[value.kind] as (payload: InlinePayloads[InlineKind]) => string;
	return render(value.value);
}
export function parameter(value: InlineValue<'count'>, context: InlineContext): PluralValue;
export function parameter(value: Exclude<InlineValue, InlineValue<'count'>>, context: InlineContext): string;
export function parameter(value: InlineValue, context: InlineContext): string | PluralValue {
	return value.kind === 'count' ? { kind: 'plural', count: value.value, text: inline(value, context) } : inline(value, context);
}
export function selectParameter<V extends string>(value: V, context: InlineContext): V;
export function selectParameter(value: InlineValue<'author'>, context: InlineContext): SelectValue<'self' | 'other'>;
export function selectParameter(value: string | InlineValue<'author'>, context: InlineContext): string | SelectValue<'self' | 'other'> {
	return typeof value === 'string' ? value : { kind: 'select', select: value.value.person, text: inline(value, context) };
}
export function each<T>(values: readonly T[]): readonly T[] { return values; }
export function truthy(value: boolean | number | readonly unknown[] | object | string | null | undefined): boolean {
	if (Array.isArray(value)) return value.length !== 0;
	// Numeric inline wrappers keep the zero rule when used as conditions.
	if (value && typeof value === 'object' && 'kind' in value && (value.kind === 'count' || value.kind === 'score')) {
		return (value as InlineValue<'count' | 'score'>).value !== 0;
	}
	return Boolean(value);
}
export type KindValue<Value> = Value extends string
	? { readonly kind: Value; readonly value: Value }
	: Value extends { readonly kind: string }
		? { readonly kind: Value['kind']; readonly value: Value }
		: never;
/** Keep the kind field and its value together so that TypeScript can narrow both. */
export function kind<Value extends string | { readonly kind: string }>(value: Value): KindValue<Value> {
	return { kind: typeof value === 'string' ? value : value.kind, value } as KindValue<Value>;
}
export function assertNever(value: never): never { throw new Error(`The result variant does not exist: ${String(value)}`); }

/** Quotation marks must come from the instruction language catalog. */
export function createInlineRenderers(context: Pick<RenderContext, 'quotationMarks'> & { readonly catalog: { readonly locale: InstructionLocale } }): InlineRenderers {
	const number = new Intl.NumberFormat(instructionContentLanguage(context.catalog.locale));
	return {
		threadRef: (value) => value.title === undefined ? value.ref : `${value.ref} ${context.quotationMarks.open}${value.title.replace(/\r\n|\r|\n/g, ' ')}${context.quotationMarks.close}`,
		commentRef: (value) => value,
		profileRef: (value) => value,
		forumRef: (value) => value,
		noteId: (value) => code({ kind: 'noteId', value }),
		cursor: (value) => code({ kind: 'cursor', value }),
		count: (value) => number.format(value),
		score: (value) => value > 0 ? `+${number.format(value)}` : value === 0 ? '0' : number.format(value),
		timestamp: (value) => value,
		author: (value) => value.displayName === undefined ? value.ref : `${value.displayName.replace(/\r\n|\r|\n/g, ' ')} ${value.ref}`,
	};
}
