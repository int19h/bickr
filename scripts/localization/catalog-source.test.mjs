import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogSourceError, readCatalogGroup } from './catalog-source.ts';
import { catalogRoots, generateLocalization } from '../generate-localization.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = join(repository, '.wrangler/localization-tests');
const fixtures = [];
function fixture() {
	mkdirSync(temporaryRoot, { recursive: true });
	const root = mkdtempSync(join(temporaryRoot, 'fixture-'));
	fixtures.push(root);
	return root;
}
function read(source, extraFiles = {}) {
	const root = fixture();
	writeFileSync(join(root, 'group.yaml'), source);
	for (const [name, text] of Object.entries(extraFiles)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), text);
	}
	const keys = ['strip', 'clip', 'keep', 'space', 'separator', 'main', 'a', 'b'];
	const definitions = Object.fromEntries(keys.map((key) => [key, { kind: key === 'a' && source.includes('  other:') ? 'plural' : 'text', parameters: [] }]));
	return readCatalogGroup(join(root, 'group.yaml'), root, definitions);
}
afterEach(() => {
	for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('readable catalog sources', () => {
	it('preserves literal escapes, paragraph breaks, and each trailing-newline mode', () => {
		const group = read('strip: |-\n  Keep `code`, "quotes", {{name}}, ${literal}, and \\frac{a}{b}.\n\n  Another paragraph.\n\nclip: |\n  One final newline.\n\nkeep: |+\n  Two final newlines.\n\nspace: " "\nseparator: ", "\n');
		expect(group.messages).toEqual({
			strip: 'Keep `code`, "quotes", {{name}}, ${literal}, and \\frac{a}{b}.\n\nAnother paragraph.',
			clip: 'One final newline.\n', keep: 'Two final newlines.\n\n', space: ' ', separator: ', ',
		});
		expect(group.locations.strip.line).toBe(1);
	});

	it('loads Markdown without trimming, rendering, or interpreting its contents', () => {
		const markdown = '\n## Heading\n\nOne whole paragraph with {{name}}, `code`, and \\$5.\n\n```math\nE = mc^2\n```\n';
		const group = read('main:\n  file: system/main.md\n', { 'system/main.md': markdown });
		expect(group.messages.main).toBe(markdown);
		expect(group.includes).toHaveLength(1);
		expect(group.locations.main.templateFile).toBe(group.includes[0]);
	});

	it.each([
		['duplicate message', 'a: |-\n  First\na: |-\n  Second\n'],
		['duplicate count', 'a:\n  other: |-\n    First\n  other: |-\n    Second\n'],
		['folded text', 'a: >-\n  First\n  Second\n'],
		['plain text', 'a: hello\n'],
		['quoted prose', 'a: "hello"\n'],
		['tag', 'a: !!str |-\n  hello\n'],
		['alias', 'a: &a |-\n  hello\nb: *a\n'],
		['sequence', 'a: [hello]\n'],
		['extra include field', 'a:\n  file: main.md\n  other: |-\n    hello\n'],
		['parent include', 'a:\n  file: ../main.md\n'],
		['absolute include', 'a:\n  file: /main.md\n'],
		['non-Markdown include', 'a:\n  file: main.ts\n'],
		['CR', 'a: |-\r\n  hello\r\n'],
		['tab', 'a: |-\n  hello\tworld\n'],
		['BOM', '\ufeffa: |-\n  hello\n'],
		['flow mapping', 'a: {file: main.md}\n'],
		['old YAML version', '%YAML 1.1\n---\na: |-\n  hello\n'],
	])('rejects %s instead of silently changing text', (_name, source) => {
		expect(() => read(source)).toThrow(CatalogSourceError);
	});

	it('rejects symlink includes and Markdown EOF changes', () => {
		const root = fixture();
		writeFileSync(join(root, 'group.yaml'), 'main:\n  file: linked.md\n');
		writeFileSync(join(root, 'main.md'), 'Prompt text.\n');
		symlinkSync(join(root, 'main.md'), join(root, 'linked.md'));
		expect(() => readCatalogGroup(join(root, 'group.yaml'), root, { main: { kind: 'text', parameters: [] } })).toThrow(CatalogSourceError);
		for (const value of ['Prompt text.', 'Prompt text.\n\n']) {
			expect(() => read('main:\n  file: main.md\n', { 'main.md': value })).toThrow(CatalogSourceError);
		}
	});

	it('publishes deterministic typed modules and leaves them intact after invalid source edits', () => {
		const root = fixture();
		for (const directory of catalogRoots) cpSync(join(repository, directory), join(root, directory), { recursive: true });
		expect(generateLocalization(root)).toBe(38);
		const output = join(root, 'workers/agent-runtime/src/.generated/localization/en.ts');
		const before = readFileSync(output, 'utf8');
		const modifiedAt = statSync(output).mtimeMs;
		expect(before).toContain('satisfies MessageCatalog<typeof messageParameters>');
		expect(generateLocalization(root)).toBe(0);
		expect(statSync(output).mtimeMs).toBe(modifiedAt);
		expect(generateLocalization(root, { check: true })).toBe(0);
		writeFileSync(output, before + '// stale edit\n');
		expect(() => generateLocalization(root, { check: true })).toThrow('Generated catalogs are stale');
		expect(generateLocalization(root)).toBe(1);
		const source = join(root, 'workers/agent-runtime/src/localization/en/system.yaml');
		const original = readFileSync(source, 'utf8');
		writeFileSync(source, original.replace('Your native language is', 'Your speaking language is'));
		expect(generateLocalization(root)).toBe(1);
		expect(readFileSync(output, 'utf8')).toContain('Your speaking language is');
		writeFileSync(source, original);
		expect(generateLocalization(root)).toBe(1);
		writeFileSync(source, original.replace('{{language}}', '{{misspelledLanguage}}'));
		expect(() => generateLocalization(root)).toThrow('Unknown instruction template parameter');
		expect(readFileSync(output, 'utf8')).toBe(before);
		writeFileSync(source, original);
		const anotherGroup = join(root, 'workers/agent-runtime/src/localization/en/avatar.yaml');
		writeFileSync(anotherGroup, readFileSync(anotherGroup, 'utf8') + '\nsystem.nativeLanguage: |-\n  {{language}}\n');
		expect(() => generateLocalization(root)).toThrow('Duplicate catalog message');
		expect(readFileSync(output, 'utf8')).toBe(before);
	}, 20000);
});
