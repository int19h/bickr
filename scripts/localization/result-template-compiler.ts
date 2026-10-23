import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { MessageDefinitions } from '../../packages/shared/src/instruction-template.ts';
import { CatalogSourceError } from './catalog-source.ts';

export const templateDirectory = 'workers/agent-runtime/src/localization/templates';
const runtimeDirectory = 'workers/agent-runtime/src/localization';
type Token = { readonly value: string; readonly line: number; readonly tag: boolean };
type Node =
	| { kind: 'literal' | 'value' | 'partial'; token: Token }
	| { kind: 'if'; token: Token; unless: boolean; branches: { condition?: string; nodes: Node[] }[] }
	| { kind: 'each'; token: Token; value: string; nodes: Node[] }
	| { kind: 'switch'; token: Token; value: string; prefix: Node[]; cases: { name: string; nodes: Node[] }[] };
type Template = { file: string; view: string; nodes: Node[] };
export type GeneratedTemplate = { file: string; content: string };
function fail(file: string, line: number, problem: string): never {
	throw new CatalogSourceError(file, `${line}: ${problem}`);
}

function parse(file: string, source: string): Template {
	const header = /^\s*{{!\s*view:\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/.exec(source);
	if (!header) fail(file, 1, 'Start the template with a view type comment.');
	const tokens: Token[] = [];
	let cursor = 0;
	const lineAt = (offset: number) => source.slice(0, offset).split('\n').length;
	while (cursor < source.length) {
		const start = source.indexOf('{{', cursor);
		if (start < 0) { tokens.push({ value: source.slice(cursor), line: lineAt(cursor), tag: false }); break; }
		const end = source.indexOf('}}', start + 2);
		if (end < 0) fail(file, lineAt(start), 'The template tag is not closed.');
		const value = source.slice(start + 2, end).trim();
		if (value.includes('{{')) fail(file, lineAt(start), 'A tag or comment cannot contain template delimiters.');
		const lineStart = source.lastIndexOf('\n', start - 1) + 1;
		const after = end + 2;
		const nextLine = source.indexOf('\n', after);
		const lineEnd = nextLine < 0 ? source.length : nextLine;
		const standalone = /^[!#/:>]/.test(value) || /^else(?:\s|$)/.test(value);
		const strip = standalone && /^[ \t]*$/.test(source.slice(lineStart, start)) && /^[ \t]*$/.test(source.slice(after, lineEnd));
		const literalEnd = strip ? Math.max(cursor, lineStart) : start;
		if (literalEnd > cursor) tokens.push({ value: source.slice(cursor, literalEnd), line: lineAt(cursor), tag: false });
		if (!value.startsWith('!')) tokens.push({ value, line: lineAt(start), tag: true });
		cursor = strip ? (nextLine < 0 ? source.length : nextLine + 1) : after;
	}
	let position = 0;
	function sequence(stops: readonly string[] = []): Node[] {
		const nodes: Node[] = [];
		while (position < tokens.length) {
			const token = tokens[position]!;
			if (token.tag && stops.some((stop) => token.value === stop || token.value.startsWith(`${stop} `))) break;
			position++;
			if (!token.tag) {
				if (token.value.includes('}}')) fail(file, token.line, 'The template contains an unexpected comment or tag delimiter.');
				if (/\p{L}/u.test(token.value)) fail(file, token.line, 'Put words in the catalog.');
				nodes.push({ kind: 'literal', token });
			} else if (/^#(?:if|unless) /.test(token.value)) {
				const unless = token.value.startsWith('#unless ');
				const close = unless ? '/unless' : '/if';
				const branches: Extract<Node, { kind: 'if' }>['branches'] = [];
				branches.push({ condition: token.value.slice(unless ? 8 : 4).trim(), nodes: sequence(['else', close]) });
				while (tokens[position]?.value.startsWith('else')) {
					const next = tokens[position++]!;
					if (branches.at(-1)?.condition === undefined) fail(file, next.line, 'An else branch must be last.');
					if (next.value !== 'else' && !next.value.startsWith('else if ')) fail(file, next.line, 'The else tag is not valid.');
					branches.push({ condition: next.value === 'else' ? undefined : next.value.slice(8).trim(), nodes: sequence(['else', close]) });
				}
				if (tokens[position++]?.value !== close) fail(file, token.line, `The block needs a ${close} tag.`);
				nodes.push({ kind: 'if', token, unless, branches });
			} else if (token.value.startsWith('#each ')) {
				const children = sequence(['/each']);
				if (tokens[position++]?.value !== '/each') fail(file, token.line, 'The block needs an /each tag.');
				nodes.push({ kind: 'each', token, value: token.value.slice(6).trim(), nodes: children });
			} else if (token.value.startsWith('#kind ')) {
				const before = sequence([':case', '/kind']);
				if (before.some((node) => node.kind !== 'literal' || node.token.value.trim())) fail(file, token.line, 'Output must follow a case tag.');
				const cases: Extract<Node, { kind: 'switch' }>['cases'] = [];
				while (tokens[position]?.value.startsWith(':case ')) {
					const next = tokens[position++]!;
					const name = next.value.slice(6).trim();
					if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || cases.some((entry) => entry.name === name)) fail(file, next.line, 'The kind case is not valid or repeats another case.');
					cases.push({ name, nodes: sequence([':case', '/kind']) });
				}
				if (!cases.length || tokens[position++]?.value !== '/kind') fail(file, token.line, 'The switch needs a case and a /kind tag.');
				nodes.push({ kind: 'switch', token, value: token.value.slice(6).trim(), prefix: before, cases });
			} else if (token.value.startsWith('> ')) nodes.push({ kind: 'partial', token });
			else if (/^[#/:]|^else(?:\s|$)/.test(token.value)) fail(file, token.line, 'The template contains an unexpected block tag.');
			else nodes.push({ kind: 'value', token });
		}
		return nodes;
	}
	return { file, view: header[1]!, nodes: sequence() };
}

/** Compile templates into functions that read typed fields and join strings. */
export function compileResultTemplates(root: string, definitions: MessageDefinitions, options: { viewModule?: string; definitionsModule?: string } = {}): GeneratedTemplate[] {
	const directory = join(root, templateDirectory);
	const templates = new Map<string, Template>();
	function read(directory: string, partial = false): void {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
			const file = join(directory, entry.name);
			if (entry.name === '.gitkeep') continue;
			if (entry.isDirectory() && !partial && entry.name === 'partials') { read(file, true); continue; }
			if (!entry.isFile() || !/^[a-z][a-z0-9_-]*\.md$/.test(entry.name)) fail(file, 1, 'Use Markdown templates or the partials directory.');
			templates.set(`${partial ? 'partials/' : ''}${entry.name.slice(0, -3)}`, parse(file, readFileSync(file, 'utf8')));
		}
	}
	read(directory);
	if (!templates.size) return [];
	const outputFile = join(root, 'workers/agent-runtime/src/.generated/localization/result-templates.ts');
	const modulePath = (path: string) => {
		const value = relative(join(outputFile, '..'), resolve(root, path)).replaceAll('\\', '/');
		return value.startsWith('.') ? value : `./${value}`;
	};
	const viewModule = modulePath(options.viewModule ?? `${runtimeDirectory}/result-template-views.ts`);
	const definitionsModule = modulePath(options.definitionsModule ?? `${runtimeDirectory}/messages.ts`);
	const lines: string[] = [];
	const locations = new Map<number, { file: string; line: number }>();
	const used = new Set<string>();
	const imports = new Set<string>();
	const add = (value: string, template: Template, token: Token) => {
		lines.push(value); locations.set(lines.length, { file: template.file, line: token.line });
	};
	let serial = 0;
	function expression(value: string, current: string, first: string | undefined, template: Template, token: Token): string {
		if (value === '@first') {
			if (!first) fail(template.file, token.line, '@first needs an each block.');
			return first;
		}
		if (!/^(?:this|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) fail(template.file, token.line, 'Use a field path.');
		return value === 'this' ? current : value.startsWith('this.') ? `${current}${value.slice(4)}` : `${current}.${value}`;
	}
	function emit(nodes: readonly Node[], template: Template, current: string, first: string | undefined, stack: readonly string[]): { raw: boolean; output: boolean } {
		let raw = false;
		let output = false;
		for (const node of nodes) {
			const token = node.token;
			const at = (code: string) => add(code, template, token);
			const expr = (value: string) => expression(value, current, first, template, token);
			const previousRaw: boolean = raw;
			const previousOutput: boolean = output;
			raw = false;
			output = false;
			switch (node.kind) {
				case 'literal': at(`out += ${JSON.stringify(token.value)};`); output ||= token.value.length > 0; break;
				case 'value': {
					if (token.value.startsWith('t ')) {
						const match = /^t "([^"]+)"((?: [A-Za-z_][A-Za-z0-9_]*=[A-Za-z_@][A-Za-z0-9_.@]*)*)$/.exec(token.value);
						if (!match) fail(template.file, token.line, 'The catalog message tag is not valid.');
						const key = match[1]!;
						const definition = Object.hasOwn(definitions, key) ? definitions[key] : undefined;
						if (!definition) fail(template.file, token.line, `The catalog message does not exist: ${key}.`);
						const args = [...match[2]!.matchAll(/ ([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z_@][A-Za-z0-9_.@]*)/g)];
						const names = args.map((arg) => arg[1]!);
						if (names.length !== definition.parameters.length || new Set(names).size !== names.length || names.some((name) => !definition.parameters.includes(name))) fail(template.file, token.line, `The parameters do not match ${key}.`);
						const values = args.map((arg) => {
							const value = expr(arg[2]!);
							const selected = definition.kind === 'select' && definition.select === arg[1];
							used.add(selected ? 'selectParameter' : 'parameter');
							return `[${JSON.stringify(arg[1])}]: ${`${selected ? 'selectParameter' : 'parameter'}(${value}, context)`}`;
						});
						at(`out += context.catalog.format(${JSON.stringify(key)}${values.length ? `, { ${values.join(', ')} }` : ''});`);
					} else {
						const parts = token.value.split('|').map((part) => part.trim());
						if (parts.length > 2) fail(template.file, token.line, 'Use one filter per value.');
						const value = expr(parts[0]!);
						const filter = parts[1] ?? 'inline';
						const helpers: Record<string, string> = { inline: 'inline', quote: 'quote', cell: 'cell', line: 'line', code: 'code', text: 'text', raw_last: 'rawLast' };
						const helper = Object.hasOwn(helpers, filter) ? helpers[filter] : undefined;
						if (!helper) fail(template.file, token.line, `The filter does not exist: ${filter}.`);
						used.add(helper);
						at(`out += ${helper}(${value}${filter === 'inline' || filter === 'line' ? ', context' : ''});`);
						raw = filter === 'raw_last';
					}
					output = true;
					break;
				}
				case 'partial': {
					const match = /^> ([a-z][a-z0-9_-]*)(?: ([A-Za-z_][A-Za-z0-9_.]*))?$/.exec(token.value);
					if (!match) fail(template.file, token.line, 'The partial tag is not valid.');
					const key = `partials/${match[1]}`;
					const partial = templates.get(key);
					if (!partial) fail(template.file, token.line, `The partial does not exist: ${match[1]}.`);
					if (stack.includes(key)) fail(template.file, token.line, 'A partial cannot call itself directly or through another partial.');
					const variable = `part${serial++}`;
					imports.add(partial.view);
					at(`{ const ${variable}: ${partial.view} = ${match[2] ? expr(match[2]) : current}; void ${variable};`);
					const result = emit(partial.nodes, partial, variable, undefined, [...stack, key]);
					at('}'); raw ||= result.raw; output ||= result.output;
					break;
				}
				case 'if': {
					used.add('truthy');
					for (const [index, branch] of node.branches.entries()) {
						const value = branch.condition === undefined ? undefined : expr(branch.condition);
						const condition = value === undefined ? '' : `${node.unless && index === 0 ? '!' : ''}(${value} && truthy(${value}))`;
						at(`${index ? '} else ' : ''}${value === undefined ? '' : `if (${condition}) `}{`);
						const result = emit(branch.nodes, template, current, first, stack);
						raw ||= result.raw; output ||= result.output;
					}
					at('}'); break;
				}
				case 'each': {
					const id = serial++;
					used.add('each');
					at(`for (const [index${id}, item${id}] of each(${expr(node.value)}).entries()) {\nvoid index${id}; void item${id};`);
					const result = emit(node.nodes, template, `item${id}`, `(index${id} === 0)`, stack);
					if (result.raw) fail(template.file, token.line, 'raw_last cannot appear in a repeating block.');
					at('}'); output ||= result.output; break;
				}
				case 'switch': {
					const prefix = emit(node.prefix, template, current, first, stack);
					output ||= prefix.output;
					const value = expr(node.value);
					at(`switch (${value}.kind) {`);
					for (const entry of node.cases) {
						if (!entry.nodes.length && entry !== node.cases.at(-1)) {
							at(`case ${JSON.stringify(entry.name)}:`);
							continue;
						}
						at(`case ${JSON.stringify(entry.name)}: {`);
						const result = emit(entry.nodes, template, current, first, stack);
						// Adjacent empty cases share the next case body, as in a normal switch.
						at('break;');
						at('}'); raw ||= result.raw; output ||= result.output;
					}
					used.add('assertNever');
					at(`default: assertNever(${value});\n}`); break;
				}
			}
			if (previousRaw && output) fail(template.file, token.line, 'No output can follow raw_last, including output outside its block.');
			raw ||= previousRaw;
			output ||= previousOutput;
		}
		return { raw, output };
	}
	for (const [name, template] of templates) {

		imports.add(template.view);
		const token: Token = { value: '', tag: true, line: 1 };
		add(`export function ${name.replace('partials/', 'partial_').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}(view: ${template.view}, context: RenderContext<typeof messageParameters>): string {\nlet out = '';\nvoid view; void context;`, template, token);
		emit(template.nodes, template, 'view', undefined, [name]);
		add('return out;\n}', template, token);
	}
	// Split generated statements into lines so that each error points to its template line.
	const bodyLines: string[] = [];
	const bodyLocations: { file: string; line: number }[] = [];
	lines.forEach((line, index) => { for (const part of line.split('\n')) { bodyLines.push(part); bodyLocations.push(locations.get(index + 1)!); } });
	const prefix = [
		`import { ${[...used].sort().join(', ')}${used.size ? ', ' : ''}type RenderContext } from ${JSON.stringify(modulePath(`${runtimeDirectory}/result-template.ts`))};`,
		`import type { ${[...imports].sort().join(', ')} } from ${JSON.stringify(viewModule)};`,
		`import type { messageParameters } from ${JSON.stringify(definitionsModule)};`,
	];
	let content = [...prefix, ...bodyLines].join('\n') + '\n';
	const optionsTs: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true };
	function program(previous?: ts.Program): ts.Program {
		const host = ts.createCompilerHost(optionsTs);
		const original = host.getSourceFile.bind(host);
		host.getSourceFile = (file, language, error, create) => resolve(file) === resolve(outputFile) ? ts.createSourceFile(file, content, language, true) : original(file, language, error, create);
		return ts.createProgram([outputFile], optionsTs, host, previous);
	}
	// Object unions narrow on .kind. String unions switch on the value itself.
	// Use TypeScript to choose the switch form for each declared view.
	const probe = program();
	const checker = probe.getTypeChecker();
	const changes: { start: number; end: number; text: string }[] = [];
	function visit(node: ts.Node): void {
		if (ts.isSwitchStatement(node) && ts.isPropertyAccessExpression(node.expression)) {
			const access = node.expression;
			const type = checker.getTypeAtLocation(access.expression);
			if (!type.getProperty('kind')) changes.push({ start: access.expression.end, end: access.end, text: '' });
		}
		ts.forEachChild(node, visit);
	}
	visit(probe.getSourceFile(outputFile)!);
	for (const change of changes.sort((a, b) => b.start - a.start)) content = content.slice(0, change.start) + change.text + content.slice(change.end);
	for (const diagnostic of ts.getPreEmitDiagnostics(changes.length ? program(probe) : probe)) {
		if (diagnostic.file?.fileName !== outputFile) {
			fail(diagnostic.file?.fileName ?? directory, diagnostic.file ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1 : 1, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
		}
		const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
		const location = bodyLocations[line - prefix.length] ?? { file: directory, line: 1 };
		fail(location.file, location.line, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
	}
	return [{ file: outputFile, content }];
}
