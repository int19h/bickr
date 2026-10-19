import { describe, expect, it } from 'vitest';
import { repairNoteMessage, repairNoteNewlines } from './note-newline-repair';
import type { ChatMessage } from '../types';

const broken = '- First task\\n- Second task\\n- Third task\\n\\nNotes: remember u/alice.';
const fixed = '- First task\n- Second task\n- Third task\n\nNotes: remember u/alice.';

describe('one-off note newline repair', () => {
	it('repairs a list and its trailing prose and is safe to repeat', () => {
		expect(repairNoteNewlines(broken)).toEqual({ kind: 'repaired', content: fixed, replacements: 4 });
		expect(repairNoteNewlines(fixed)).toEqual({ kind: 'unchanged' });
	});
	it('accepts mixed actual and escaped list boundaries and numbered lists', () => {
		expect(repairNoteNewlines('- One\n- Two\\n- Three\\n- Four')).toMatchObject({ kind: 'repaired', content: '- One\n- Two\n- Three\n- Four' });
		expect(repairNoteNewlines('1. One\\n2. Two\\n3. Three')).toMatchObject({ kind: 'repaired', content: '1. One\n2. Two\n3. Three' });
	});
	it.each(['Use \\n in JSON.', '- One\\n- Two', '{"content":"- One\\n- Two\\n- Three"}', '- Code `unclosed\\n- Two\\n- Three'])('leaves uncertain text for inspection: %s', content => {
		expect(repairNoteNewlines(content)).toEqual({ kind: 'ambiguous' });
	});
	it('preserves inline code, code fences, and runs of multiple backslashes', () => {
		const content = '- Use `a\\nb`\\n- Keep \\\\n literal\\n- Next\n```js\nconst text = "a\\nb";\n```\n';
		expect(repairNoteNewlines(content)).toEqual({ kind: 'repaired', content: '- Use `a\\nb`\n- Keep \\\\n literal\n- Next\n```js\nconst text = "a\\nb";\n```\n', replacements: 2 });
	});
	it('preserves quoted escape examples inside an otherwise eligible list', () => {
		expect(repairNoteNewlines('- Use "a\\nb"\\n- Two\\n- Three')).toEqual({ kind: 'repaired', content: '- Use "a\\nb"\n- Two\n- Three', replacements: 2 });
	});
	it('refuses escaped fence line endings', () => {
		expect(repairNoteNewlines('- One\\n- Two\\n- Three\\n```js\\nconst n = 1;\\n```')).toEqual({ kind: 'ambiguous' });
	});
	it('does not use code sample list markers as evidence', () => {
		expect(repairNoteNewlines('- Example `one\\n- Two\\n- Three`')).toEqual({ kind: 'ambiguous' });
		expect(repairNoteNewlines('- Example\n```\n- One\\n- Two\\n- Three\n```')).toEqual({ kind: 'ambiguous' });
	});
	it('preserves non-note assistant calls, reasoning, and unrelated argument fields', () => {
		const message: ChatMessage = { role: 'assistant', reasoning: 'Opaque original', reasoning_details: [{ signature: 'same' }], tool_calls: [
			{ id: 'one', type: 'function', function: { name: 'write_note', arguments: JSON.stringify({ id: 'PLAN', content: broken, extra: '\\n' }) } },
			{ id: 'two', type: 'function', function: { name: 'create_thread', arguments: JSON.stringify({ content: broken }) } },
		] };
		const result = repairNoteMessage(message);
		expect(result.kind).toBe('repaired');
		if (result.kind !== 'repaired') throw new Error('Expected repair.');
		expect(result.message.reasoning_details).toBe(message.reasoning_details);
		expect(result.message.reasoning).toBe(message.reasoning);
		expect(result.message.tool_calls![1]).toBe(message.tool_calls![1]);
		expect(JSON.parse(result.message.tool_calls![0]!.function.arguments)).toEqual({ id: 'PLAN', content: fixed, extra: '\\n' });
		expect(JSON.parse(message.tool_calls![0]!.function.arguments).content).toBe(broken);
	});
	it('changes only correlated note result content', () => {
		const message: ChatMessage = { role: 'tool', tool_call_id: 'read', content: JSON.stringify({ id: 'PLAN', content: broken, links: [], extra: '\\n' }) };
		expect(repairNoteMessage(message)).toEqual({ kind: 'unchanged' });
		expect(repairNoteMessage(message, 'read_thread')).toEqual({ kind: 'unchanged' });
		const result = repairNoteMessage(message, 'read_note');
		if (result.kind !== 'repaired') throw new Error('Expected repair.');
		expect(JSON.parse(result.message.content!)).toEqual({ id: 'PLAN', content: fixed, links: [], extra: '\\n' });
		expect(result.message.tool_call_id).toBe('read');
	});
	it('does not guess nested legacy payloads or malformed JSON', () => {
		expect(repairNoteMessage({ role: 'tool', content: JSON.stringify({ note: { id: 'PLAN', content: broken } }) }, 'read_note')).toEqual({ kind: 'unchanged' });
		expect(repairNoteMessage({ role: 'tool', content: '{' }, 'read_note')).toEqual({ kind: 'ambiguous' });
	});
});

describe('code and quoted escape safety regressions', () => {
	it.each(['    ', '\t', '  \t'])('preserves actual indented code after a list: %j', indent => {
		const suffix = '\n\n' + indent + String.raw`const re = /\n/; const other = /\n/;`;
		expect(repairNoteNewlines(String.raw`- One\n- Two\n- Three` + suffix)).toEqual({
			kind: 'repaired', content: '- One\n- Two\n- Three' + suffix, replacements: 2,
		});
	});
	it('preserves paired single-quoted escape examples', () => {
		expect(repairNoteNewlines(String.raw`- Use 'a\nb'\n- Two\n- Three`)).toEqual({
			kind: 'repaired', content: String.raw`- Use 'a\nb'` + '\n- Two\n- Three', replacements: 2,
		});
	});
	it('allows word apostrophes and plural possessives in ordinary list text', () => {
		expect(repairNoteNewlines(String.raw`- A participant's note\n- Other participants' notes\n- Last task`)).toEqual({
			kind: 'repaired', content: "- A participant's note\n- Other participants' notes\n- Last task", replacements: 2,
		});
	});
	it('preserves a single quote inside a double-quoted example', () => {
		expect(repairNoteNewlines(String.raw`- Use "a'\nb"\n- Two\n- Three`)).toEqual({
			kind: 'repaired', content: String.raw`- Use "a'\nb"` + '\n- Two\n- Three', replacements: 2,
		});
	});
});
