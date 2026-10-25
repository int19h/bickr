import { describe, expect, it } from "vitest";
import { StreamReasoningDetails } from "../workers/agent-runtime/src/provider/reasoning-stream";
import { normalizeReadableText, reasoningDetailForDisplay, reasoningDetailsForDisplay, reasoningDetailsTextForDisplay, textValueForDisplay } from "../apps/web/src/reasoning-formatting";

describe("reasoningDetailsTextForDisplay", () => {
	it("keeps readable parts in order with blank lines", () => {
		expect(reasoningDetailsTextForDisplay([
			{ type: 'reasoning.text', text: 'First thought.' },
			{ type: 'reasoning.encrypted', data: 'opaque bytes' },
			{ type: 'reasoning.summary', summary: 'A summary.' },
		])).toBe('First thought.\n\nA summary.');
	});
	it('joins indexed stream fragments before separating distinct parts', () => {
		expect(reasoningDetailsTextForDisplay([
			{ type: 'reasoning.summary', index: 0, summary: 'First' },
			{ type: 'reasoning.summary', index: 0, summary: ' ' },
			{ type: 'reasoning.summary', index: 0, summary: 'thought.' },
			{ type: 'reasoning.encrypted', index: 0, data: 'opaque' },
			{ type: 'reasoning.text', index: 1, text: 'Next thought.' },
		])).toBe('First thought.\n\nNext thought.');
	});
	it("extracts summary text arrays", () => {
		expect(reasoningDetailsTextForDisplay([{ type: 'reasoning.summary', summary: [{ text: 'First. ' }, { text: 'Second.' }] }])).toBe('First. Second.');
	});
	it.each([
		[{ type: 'reasoning.text', text: 'Words' }, { kind: 'text', text: 'Words' }],
		[{ type: 'reasoning.summary', summary: 'Summary' }, { kind: 'summary', text: 'Summary' }],
		[{ type: 'reasoning.encrypted', data: 'secret', text: 'opaque' }, { kind: 'encrypted' }],
		[{ type: 'future.type', text: 'opaque' }, { kind: 'unknown' }],
		['untyped bytes', { kind: 'unknown' }],
	])('classifies %j', (input, expected) => expect(reasoningDetailForDisplay(input)).toEqual(expected));
	it('classifies mixed and empty details without exposing opaque text', () => {
		expect(reasoningDetailsForDisplay([])).toEqual({ text: '', hasText: false, hasSummary: false, encryptedParts: 0, opaqueParts: 0 });
		expect(reasoningDetailsForDisplay([{ type: 'reasoning.text', text: 'Visible' }, { type: 'future', text: 'Hidden' }, { type: 'reasoning.encrypted', data: 'Hidden' }])).toEqual({ text: 'Visible', hasText: true, hasSummary: false, encryptedParts: 1, opaqueParts: 2 });
	});

	it("preserves public text whitespace for loop display", () => {
		expect(textValueForDisplay("  body with intentional spacing\n")).toBe("  body with intentional spacing\n");
		expect(textValueForDisplay(" ")).toBe(" ");
		expect(textValueForDisplay("")).toBeUndefined();
	});

	it("collapses pathological tiny-line chunks for readable loop display", () => {
		expect(normalizeReadableText("См\nел\nо \nпи\nш\nе\nш\nь,\n ко\nгд\nа")).toBe("Смело пишешь, когда");
		expect(normalizeReadableText("First paragraph.\n\nLine one\nLine two")).toBe("First paragraph.\n\nLine one\nLine two");
	});
});

it('joins fragments by type, index, ID, and format, including the default stream', () => {
	expect(reasoningDetailsTextForDisplay([
		{ type: 'reasoning.summary', summary: 'Look' },
		{ type: 'reasoning.summary', id: 'other', summary: 'Separate.' },
		{ type: 'reasoning.summary', summary: 'ing at the result.' },
		{ type: 'reasoning.summary', format: 'other', summary: 'Another format.' },
	])).toBe('Looking at the result.\n\nSeparate.\n\nAnother format.');
});

it('joins unindexed summaries after the provider stream adapter retains their fragments', () => {
	const stream = new StreamReasoningDetails();
	stream.append([{ type: 'reasoning.summary', summary: 'Look' }]);
	stream.append([{ type: 'reasoning.summary', summary: 'ing at the result.' }]);
	const details = stream.finish(values => values.map(value => value as Record<string, unknown>));
	expect(reasoningDetailsTextForDisplay(details)).toBe('Looking at the result.');
});
