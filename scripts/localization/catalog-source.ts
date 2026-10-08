import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isMap, isScalar, LineCounter, parseDocument, type Node } from 'yaml';
import type { MessageDefinitions } from '../../packages/shared/src/instruction-template.ts';

export type SourceMessage = string | Record<string, string>;
export type CatalogGroup = {
	readonly messages: Record<string, SourceMessage>;
	readonly locations: Record<string, { file: string; line: number; templateFile?: string }>;
	readonly includes: readonly string[];
};

export class CatalogSourceError extends Error {
	readonly file: string;
	constructor(file: string, message: string, options?: ErrorOptions) {
		super(`${file}: ${message}`, options);
		this.file = file;
		this.name = 'CatalogSourceError';
	}
}

/** Read authoring sources only. Inserted participant content never enters this loader. */
export function readCatalogGroup(file: string, localeDirectory: string, definitions: MessageDefinitions): CatalogGroup {
	const lineCounter = new LineCounter();
	const source = readFileSync(file, 'utf8');
	assertSourceCharacters(file, source);
	const document = parseDocument(source, {
		version: '1.2', schema: 'failsafe', uniqueKeys: true, stringKeys: true, lineCounter,
	});
	if (document.errors.length || document.warnings.length) {
		throw new CatalogSourceError(file, 'Invalid catalog YAML.', { cause: document.errors[0] ?? document.warnings[0] });
	}
	if (document.directives.yaml.version !== '1.2' || !isMap(document.contents) || document.contents.flow) {
		throw new CatalogSourceError(file, 'A catalog must be a YAML 1.2 message mapping.');
	}
	function plainNode(node: Node | null | undefined): void {
		if (!node || node.anchor || node.tag) throw new CatalogSourceError(file, 'Catalog aliases, anchors, and tags are not allowed.');
	}
	function key(node: unknown): string {
		if (!isScalar(node) || typeof node.value !== 'string' || node.anchor || node.tag) {
			throw new CatalogSourceError(file, 'A catalog key must be a string.');
		}
		return node.value;
	}
	function text(node: unknown): string {
		if (!isScalar(node) || typeof node.value !== 'string' || node.anchor || node.tag) {
			throw new CatalogSourceError(file, 'A message must be literal text.');
		}
		assertSourceCharacters(file, node.value);
		// Quotes make whitespace-only text and edge spaces visible without trailing
		// whitespace in the source, for example the separator ", ".
		const quotedWhitespace = (!node.value.trim() || /^[ \t]|[ \t]$/.test(node.value))
			&& (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE');
		if (node.type === 'BLOCK_LITERAL' && /^[ \t]|[ \t]$/.test(node.value)) {
			throw new CatalogSourceError(file, 'Quote values with spaces at their edges.');
		}
		if (node.type !== 'BLOCK_LITERAL' && !quotedWhitespace) {
			throw new CatalogSourceError(file, 'Use a literal block for message text. Quote whitespace-only text and edge spaces.');
		}
		return node.value;
	}
	plainNode(document.contents);
	const messages: Record<string, SourceMessage> = Object.create(null);
	const locations: CatalogGroup['locations'] = Object.create(null);
	const includes: string[] = [];
	for (const pair of document.contents.items) {
		const id = key(pair.key);
		const definition = definitions[id];
		if (!definition) throw new CatalogSourceError(file, `Unknown catalog message: ${id}.`);
		const value = pair.value;
		const location: { file: string; line: number; templateFile?: string } = {
			file, line: lineCounter.linePos(isScalar(pair.key) ? pair.key.range![0] : 0).line,
		};
		if (isMap(value)) {
			plainNode(value);
			if (value.flow) throw new CatalogSourceError(file, 'Use block mappings in catalogs.');
			const names = value.items.map((entry) => key(entry.key));
			switch (definition.kind) {
			case 'text': {
				if (names.length !== 1 || names[0] !== 'file') throw new CatalogSourceError(file, `Invalid Markdown reference for ${id}.`);
				const reference = value.items[0]!.value;
				if (!isScalar(reference) || typeof reference.value !== 'string' || reference.anchor || reference.tag) {
					throw new CatalogSourceError(file, `Invalid Markdown path for ${id}.`);
				}
				const path = reference.value;
				if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.') || !path.endsWith('.md')) {
					throw new CatalogSourceError(file, `Markdown path must stay inside its language directory: ${id}.`);
				}
				const target = resolve(dirname(file), path);
				const lexicalPath = relative(resolve(localeDirectory), target);
				if (isAbsolute(lexicalPath) || lexicalPath.startsWith('..')) {
					throw new CatalogSourceError(file, `Markdown path leaves its language directory: ${id}.`);
				}
				let current = resolve(localeDirectory);
				for (const segment of lexicalPath.split(sep)) {
					if (!readdirSync(current).includes(segment)) throw new CatalogSourceError(file, `Markdown path must match an existing filename exactly: ${id}.`);
					current = resolve(current, segment);
					if (lstatSync(current).isSymbolicLink()) throw new CatalogSourceError(file, 'Markdown paths cannot contain symbolic links.');
				}
				if (!lstatSync(target).isFile()) throw new CatalogSourceError(file, `Markdown path must name a file: ${id}.`);
				const withinLocale = relative(realpathSync(localeDirectory), realpathSync(target));
				if (isAbsolute(withinLocale) || withinLocale.startsWith('..')) {
					throw new CatalogSourceError(file, `Markdown path leaves its language directory: ${id}.`);
				}
				// Preserve source bytes, including leading and trailing newlines. Never trim or render Markdown.
				const markdown = readFileSync(target, 'utf8');
				assertSourceCharacters(target, markdown);
				if (!markdown.endsWith('\n') || markdown.endsWith('\n\n')) {
					throw new CatalogSourceError(target, 'A Markdown prompt must end with exactly one newline.');
				}
				messages[id] = markdown;
				location.templateFile = target;
				includes.push(target);
				break;
			}
			case 'plural': {
				const variants: Record<string, string> = Object.create(null);
				for (const entry of value.items) variants[key(entry.key)] = text(entry.value);
				messages[id] = variants;
				break;
			}
			}
		} else {
			if (definition.kind !== 'text') throw new CatalogSourceError(file, `Plural message needs a count mapping: ${id}.`);
			messages[id] = text(value);
		}
		locations[id] = location;
	}
	return { messages, locations, includes };
}

function assertSourceCharacters(file: string, source: string): void {
	// YAML normalizes several line endings. Reject them before parsing, so an
	// editor cannot change decoded prompt bytes without a visible failure.
	if (/[\u0000-\u0009\u000b-\u001f\u007f\u0085\u2028\u2029\ufeff]/u.test(source)) {
		throw new CatalogSourceError(file, 'Catalog sources must use LF newlines without tabs, BOM, or control characters.');
	}
}
