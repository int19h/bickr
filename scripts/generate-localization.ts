import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { instructionLocales } from '../packages/shared/src/instruction-language.ts';
import { InstructionTemplates, type MessageCatalog, type MessageDefinitions } from '../packages/shared/src/instruction-template.ts';
import { sharedMessageDefinitions } from '../packages/shared/src/localization/messages.ts';
import { messageParameters } from '../workers/agent-runtime/src/localization/messages.ts';
import { CatalogSourceError, readCatalogGroup, type SourceMessage } from './localization/catalog-source.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const header = '// Generated from localization YAML and Markdown. Do not edit.\n';
export const catalogRoots = ['packages/shared/src/localization', 'workers/agent-runtime/src/localization'] as const;

export function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new CatalogSourceError(path, 'Catalog sources cannot be symbolic links.');
		if (entry.isDirectory()) return sourceFiles(path);
		if (!entry.isFile() || !/\.(yaml|md)$/.test(entry.name)) throw new CatalogSourceError(path, 'Unexpected catalog source file.');
		return [path];
	}).sort();
}

function readLanguage(directory: string, definitions: MessageDefinitions): Record<string, SourceMessage> {
	const messages: Record<string, SourceMessage> = Object.create(null);
	const files = sourceFiles(directory);
	const included = new Set<string>();
	for (const file of files.filter((file) => file.endsWith('.yaml'))) {
		const group = readCatalogGroup(file, directory, definitions);
		for (const [id, value] of Object.entries(group.messages)) {
			if (Object.hasOwn(messages, id)) throw new CatalogSourceError(file, `Duplicate catalog message: ${id}.`);
			messages[id] = value;
		}
		for (const file of group.includes) {
			if (included.has(file)) throw new CatalogSourceError(file, 'A Markdown template must belong to one message.');
			included.add(file);
		}
	}
	for (const file of files.filter((file) => file.endsWith('.md'))) {
		if (!included.has(file)) throw new CatalogSourceError(file, 'Markdown template has no catalog message.');
	}
	return messages;
}

/** Validate the entire source set before publishing any generated module. */
function compileLocalization(root: string): { file: string; content: string }[] {
	const catalogs = catalogRoots.map((directory, index) => {
		const path = join(root, directory);
		const locales = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
		if (JSON.stringify(locales) !== JSON.stringify([...instructionLocales].sort())) {
			throw new CatalogSourceError(path, 'Catalog language directories must match the supported languages.');
		}
		const englishFiles = sourceFiles(join(path, 'en')).map((file) => relative(join(path, 'en'), file));
		return instructionLocales.map((locale) => {
			const directory = join(path, locale);
			const files = sourceFiles(directory).map((file) => relative(directory, file));
			if (JSON.stringify(files) !== JSON.stringify(englishFiles)) {
				throw new CatalogSourceError(directory, 'Catalog files must match the English group layout.');
			}
			return readLanguage(directory, index === 0 ? sharedMessageDefinitions : messageParameters);
		});
	});
	const outputs: { file: string; content: string }[] = [];
	for (const [index, locale] of instructionLocales.entries()) {
		const shared = catalogs[0]![index]!;
		const worker = catalogs[1]![index]!;
		for (const id of Object.keys(worker)) {
			if (Object.hasOwn(shared, id)) throw new CatalogSourceError(locale, `Worker message duplicates a shared message: ${id}.`);
		}
		// The source loader is the one untyped data boundary. The constructor checks
		// exact keys, value kinds, parameters, and all native plural categories.
		new InstructionTemplates(locale, sharedMessageDefinitions, shared as MessageCatalog<typeof sharedMessageDefinitions>);
		new InstructionTemplates(locale, messageParameters, { ...shared, ...worker } as MessageCatalog<typeof messageParameters>);
		for (const [packagePath, value, definitions, sharedImport] of [
			['packages/shared', shared, 'sharedMessageDefinitions', ''],
			['workers/agent-runtime', worker, 'messageParameters', `import shared from '@bickr/shared/localization/${locale}';\n`],
		] as const) {
			const typePath = packagePath === 'packages/shared' ? '../../instruction-template.ts' : '@bickr/shared/instruction-template';
			outputs.push({
				file: join(root, packagePath, 'src/.generated/localization', `${locale}.ts`),
				content: `${header}import type { MessageCatalog } from '${typePath}';\nimport type { ${definitions} } from '../../localization/messages.ts';\n${sharedImport}export default {\n${sharedImport ? '\t...shared,\n' : ''}${Object.entries(value).map(([id, text]) => `\t${JSON.stringify(id)}: ${JSON.stringify(text)},`).join('\n')}\n} as const satisfies MessageCatalog<typeof ${definitions}>;\n`,
			});
		}
	}
	return outputs;
}

function publish(outputs: readonly { file: string; content: string }[], check: boolean): number {
	const expected = new Set(outputs.map((output) => output.file));
	const obsolete: string[] = [];
	for (const directory of new Set(outputs.map((output) => dirname(output.file)))) {
		if (!existsSync(directory)) continue;
		for (const name of readdirSync(directory)) {
			const file = join(directory, name);
			if (!name.endsWith('.ts') || expected.has(file)) continue;
			if (!readFileSync(file, 'utf8').startsWith(header)) throw new CatalogSourceError(file, 'Unexpected file in generated catalog directory.');
			obsolete.push(file);
		}
	}
	const changes = outputs.filter((output) => !existsSync(output.file) || readFileSync(output.file, 'utf8') !== output.content);
	if (check) {
		const stale = changes[0]?.file ?? obsolete[0];
		if (stale) throw new CatalogSourceError(stale, 'Generated catalogs are stale. Run npm run localization:generate.');
		return 0;
	}
	for (const output of outputs) {
		if (existsSync(output.file) && readFileSync(output.file, 'utf8') === output.content) continue;
		mkdirSync(dirname(output.file), { recursive: true });
		// Unique temporary paths make simultaneous build and dev invocations safe.
		const temporary = `${output.file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, output.content);
			renameSync(temporary, output.file);
		} finally { rmSync(temporary, { force: true }); }
	}
	for (const file of obsolete) rmSync(file, { force: true });
	return changes.length + obsolete.length;
}

function inputFingerprint(root: string): string {
	const hash = createHash('sha256');
	for (const directory of catalogRoots) {
		for (const locale of instructionLocales) {
			for (const file of sourceFiles(join(root, directory, locale))) {
				hash.update(JSON.stringify(relative(root, file))).update('\0').update(readFileSync(file)).update('\0');
			}
		}
	}
	return hash.digest('hex');
}

/** Concurrent writers publish identical immutable modules. If an editor changes
 * a source during compilation, retry that snapshot before returning to a caller. */
export function generateLocalization(root = repository, { check = false } = {}): number {
	for (let attempt = 0; attempt < 3; attempt++) {
		const fingerprint = inputFingerprint(root);
		const outputs = compileLocalization(root);
		if (fingerprint !== inputFingerprint(root)) continue;
		const changed = publish(outputs, check);
		if (fingerprint === inputFingerprint(root)) return changed;
	}
	throw new CatalogSourceError(root, 'Catalog sources changed repeatedly during compilation. Retry after the edits finish.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
	console.log(`Localization catalogs ready. Updated ${generateLocalization(repository, { check: values.check })} generated modules.`);
}
