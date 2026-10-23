import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compileResultTemplates, templateDirectory } from './result-template-compiler.ts';
import { repository } from './paths.ts';
import { messageParameters } from './fixtures/result-messages.ts';
import { InstructionTemplates } from '../../packages/shared/src/instruction-template.ts';
import { cell, code } from '../../workers/agent-runtime/src/localization/result-template.ts';
import { readCatalogGroup } from './catalog-source.ts';
import { catalog, context } from './fixtures/result-render-context.ts';

const roots = [];
const header = '{{! view: FixtureView }}\n';
function fixture(source, partials = {}) {
	const directory = join(repository, '.wrangler/result-template-tests');
	mkdirSync(directory, { recursive: true });
	const root = mkdtempSync(join(directory, 'fixture-'));
	roots.push(root);
	const runtime = join(root, 'workers/agent-runtime/src/localization');
	mkdirSync(join(root, templateDirectory, 'partials'), { recursive: true });
	symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
	writeFileSync(join(runtime, 'result-template.ts'), `export * from ${JSON.stringify(join(repository, 'workers/agent-runtime/src/localization/result-template.ts'))};\n`);
	writeFileSync(join(root, templateDirectory, 'example.md'), header + source);
	for (const [name, value] of Object.entries(partials)) writeFileSync(join(root, templateDirectory, 'partials', `${name}.md`), value);
	return root;
}
function compile(root) {
	return compileResultTemplates(root, messageParameters, {
		viewModule: join(repository, 'scripts/localization/fixtures/result-views.ts'),
		definitionsModule: join(repository, 'scripts/localization/fixtures/result-messages.ts'),
	});
}
async function renderer(source, partials) {
	const root = fixture(source, partials);
	const [output] = compile(root);
	mkdirSync(dirname(output.file), { recursive: true });
	writeFileSync(output.file, output.content);
	// Use a child module with static imports so that tests follow the import boundary.
	const harness = join(root, 'render.mjs');
	writeFileSync(harness, `import { example } from './workers/agent-runtime/src/.generated/localization/result-templates.ts';
import { context } from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/localization/fixtures/result-render-context.ts')).href)};
import { readFileSync } from 'node:fs';
process.stdout.write(example(JSON.parse(readFileSync(0, 'utf8')), context));
`);
	return (view) => execFileSync(process.execPath, [harness], { input: JSON.stringify(view), encoding: 'utf8' });
}
const hostile = '---\n### fake\n> quote\n| table |\n``` `` `\n\n{{t "x"}}';
const view = {
	ref: { kind: 'threadRef', value: { ref: 't/a', title: 'Title' } }, body: hostile,
	message: catalog.format('label'), note: { kind: 'noteId', value: 'my `note`' }, cursor: { kind: 'cursor', value: 'next cursor' },
	author: { kind: 'author', value: { ref: 'u/a', displayName: 'Name', person: 'other' } },
	count: { kind: 'count', value: 2 }, score: { kind: 'score', value: 6 }, timestamp: { kind: 'timestamp', value: '1d0h' },
	profile: { kind: 'profileRef', value: 'u/a' }, forum: { kind: 'forumRef', value: 'f/a' },
	show: true, number: 1, items: [{ ref: { kind: 'commentRef', value: 'c/one' }, body: 'one' }, { ref: { kind: 'commentRef', value: 'c/two' }, body: 'two' }],
	item: { ref: { kind: 'commentRef', value: 'c/one' }, body: 'one' }, state: 'up', event: { kind: 'post', ref: { kind: 'commentRef', value: 'c/one' } },
	privateCredential: 'MUST NOT LEAK', futureInternal: { diagnostic: 'MUST NOT LEAK' },
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('result template compiler', { timeout: 30000 }, () => {
	it('renders inline forms and catalog parameters field by field', async () => {
		const render = await renderer('{{ref}} {{profile}} {{forum}} {{note}} {{cursor}} {{count}} {{score}} {{timestamp}} {{author}}\n{{t "ref" ref=profile}}\n{{t "count" count=count}}\n{{t "person" author=author}}\n{{t "vote" state=state}}');
		expect(render(view, context)).toBe('t/a 「Title」 u/a f/a `` my `note` `` `next cursor` 2 +6 1d0h Name u/a\nRef u/a\n2 items\nName u/a posted\nup up');
		expect(render({ ...view, author: { ...view.author, value: { ...view.author.value, person: 'self' } } }, context)).toContain('I posted');
		expect(render({ ...view, score: { kind: 'score', value: -2 } }, context)).toContain(' -2 ');
		expect(render({ ...view, score: { kind: 'score', value: 0 } }, context)).toContain(' 0 ');
	});
	it('keeps hostile inserted text literal through every free-text filter', async () => {
		const forms = [
			['quote', '> ---\n> ### fake\n> > quote\n> | table |\n> ``` `` `\n>\n> {{t "x"}}'],
			['cell', '--- ### fake > quote \\| table \\| ``` `` `  {{t "x"}}'],
			['line', '「--- ### fake > quote | table | ``` `` `  {{t "x"}}」'],
			['code', '````--- ### fake > quote | table | ``` `` `  {{t "x"}}````'],
			['text', hostile],
			['raw_last', hostile],
		];
		const render = await renderer(forms.map(([filter]) => `{{${filter === 'text' ? 'message' : 'body'} | ${filter}}}`).join('\n---\n'));
		expect(render({ ...view, message: hostile }, context)).toBe(forms.map(([, expected]) => expected).join('\n---\n'));
	});
	it('pads code fences according to CommonMark', () => {
		for (const [input, expected] of [['`x`', '`` `x` ``'], [' x ', '`  x  `'], ['   ', '`   `'], ['a\nb', '`a b`'], ['`````', '`````` ````` ``````']]) expect(code(input)).toBe(expected);
	});
	it('handles every block form, list truthiness, numbers, optional fields, and standalone lines', async () => {
		const render = await renderer('{{! multi\nline comment }}\n{{t "label"}}\n\n{{#if optional}}\n{{optional}}\n{{else if items}}\n{{#each items}}\n{{#unless @first}}\n---\n{{/unless}}\n{{this.ref}}\n{{/each}}\n{{else}}\n{{t "label"}}\n{{/if}}\n\n{{#if number}}{{t "label"}}{{/if}}');
		expect(render(view, context)).toBe('Result\n\nc/one\n---\nc/two\n\nResult');
		expect(render({ ...view, items: [], number: 0 }, context)).toBe('Result\n\nResult\n\n');
		expect(render({ ...view, optional: { kind: 'commentRef', value: 'c/opt' }, number: -1 }, context)).toBe('Result\n\nc/opt\n\nResult');
	});
	it('strips only standalone tag lines and preserves explicit blank lines', async () => {
		const render = await renderer('  {{! gone }}\n\n{{#if show}}\n### {{t "label"}} {{! inline }}\n\n{{/if}}\n---\n');
		expect(render(view, context)).toBe('\n### Result \n\n---\n');
		expect(render({ ...view, show: false }, context)).toBe('\n---\n');
	});
	it('checks partial views and renders named and current values', async () => {
		const render = await renderer('{{> same}}\n{{> item item}}\n{{#each items}}{{> item}}{{/each}}', {
			same: header + '{{profile}}', item: '{{! view: ItemView }}\n{{ref}}',
		});
		expect(render(view, context)).toBe('u/ac/onec/onec/two');
	});
	it('narrows kind unions and string unions with exhaustive switches', async () => {
		const render = await renderer('{{#kind event}}{{:case post}}{{event.ref}}{{:case empty}}{{/kind}} {{#kind state}}{{:case up}}{{t "label"}}{{:case down}}{{:case cleared}}{{/kind}}');
		expect(render(view, context)).toBe('c/one Result');
		expect(render({ ...view, event: { kind: 'empty' }, state: 'cleared' }, context)).toBe(' ');
	});
	it.each([
		['{{body}}', 'InlineValue'], ['{{missing}}', 'does not exist'], ['{{body | text}}', 'InstructionText'],
		['{{message | quote}}', 'FreeText'], ['{{body | unknown}}', 'filter does not exist'],
		['{{t "missing"}}', 'catalog message does not exist'], ['{{t "ref" wrong=profile}}', 'parameters do not match'],
		['{{t "ref" ref=body}}', 'overload'], ['{{#kind event}}{{:case post}}{{event.ref}}{{/kind}}', 'never'],
		['{{#kind state}}{{:case up}}{{/kind}}', 'never'], ['{{@first}}', '@first'],
		['{{#if show}}', 'needs a /if'], ['{{/each}}', 'unexpected block'], ['{{! bad {{ stuff }}', 'delimiters'],
		['{{! comment }} extra }}', 'delimiter'], ['{{> missing}}', 'partial does not exist'], ['Unlocalized words', 'catalog'],
	])('rejects invalid source %s with its file and line', (source, problem) => {
		const root = fixture(source);
		expect(() => compile(root)).toThrow(new RegExp(`example\\.md: 2:.*${problem}`));
	});
	it.each([
		'{{body | raw_last}}\n', '{{body | raw_last}}{{profile}}',
		'{{#if show}}{{body | raw_last}}{{/if}}---',
		'{{#each items}}{{body | raw_last}}{{/each}}', '{{> raw}}---',
	])('rejects output after raw_last through enclosing blocks and partials: %s', (source) => {
		expect(() => compile(fixture(source, { raw: header + '{{body | raw_last}}' }))).toThrow('raw_last');
	});
	it('accepts raw_last in terminal alternatives and rejects recursive partials', async () => {
		const render = await renderer('{{#if show}}{{body | raw_last}}{{else}}{{message | text}}{{/if}}');
		expect(render(view, context)).toBe(hostile);
		expect(() => compile(fixture('{{> loop}}', { loop: header + '{{> loop}}' }))).toThrow('cannot call itself');
	});
	it('loads select sources and rejects missing variants in every language', () => {
		const root = fixture('');
		const file = join(root, 'select.yaml');
		writeFileSync(file, 'person:\n  self: |-\n    I posted\n  other: |-\n    {{author}} posted\n');
		const { messages } = readCatalogGroup(file, root, messageParameters);
		expect(messages.person).toEqual({ self: 'I posted', other: '{{author}} posted' });
		for (const locale of ['en', 'ru', 'ja', 'ar', 'ko', 'zh', 'eo', 'fr', 'de', 'pt', 'it', 'da', 'uk', 'be', 'id', 'tr', 'hi', 'vi', 'ga']) {
			expect(() => new InstructionTemplates(locale, { person: messageParameters.person }, messages)).not.toThrow();
			expect(() => new InstructionTemplates(locale, { person: messageParameters.person }, { person: { self: 'I posted' } })).toThrow('select variants');
		}
		expect(() => catalog.format('vote', { state: 'invalid' })).toThrow('select value');
	});
});

it('retains blank lines before kind cases and permits empty blocks after raw_last', async () => {
	const render = await renderer('{{#kind state}}\n\n{{:case up}}\n{{t "label"}}\n{{:case down}}\n{{:case cleared}}\n{{/kind}}\n{{body | raw_last}}{{#if show}}{{/if}}');
	expect(render(view, context)).toBe('\nResult\n' + hostile);
}, 30000);

it('keeps inline count formatting in plural parameters', async () => {
	const render = await renderer('{{count}} {{t "count" count=count}}');
	expect(render({ ...view, count: { kind: 'count', value: 1200 } }, context)).toBe('1,200 1,200 items');
}, 30000);


it('keeps an authored backslash from opening another table cell', () => {
	expect(cell(' x\\|y ')).toBe('x' + '\\'.repeat(3) + '|y');
});

it('uses the runtime TypeScript configuration for view dependencies', () => {
	const root = fixture('{{ref}}');
	const runtime = join(root, 'workers/agent-runtime');
	writeFileSync(join(runtime, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { strict: true, types: ['./template-types'], lib: ['es2024'] }, include: ['src'],
	}));
	writeFileSync(join(runtime, 'template-types.d.ts'), `import type { InlineValue } from ${JSON.stringify(join(repository, 'workers/agent-runtime/src/localization/result-template.ts'))};\ndeclare global { type TemplateReference = InlineValue<'profileRef'>; }\n`);
	const views = join(runtime, 'src/localization/views.ts');
	writeFileSync(views, 'export type FixtureView = { readonly ref: TemplateReference };\n');
	expect(compileResultTemplates(root, messageParameters, {
		viewModule: views, definitionsModule: join(repository, 'scripts/localization/fixtures/result-messages.ts'),
	})[0].content).toContain('view.ref');
}, 30000);
