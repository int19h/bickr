import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { repository } from './paths.ts';

/** Map a generated diagnostic to the template line recorded by the compiler. */
export function formatDiagnostic(diagnostic: ts.Diagnostic, root = repository): string {
	const file = diagnostic.file;
	if (file && diagnostic.start !== undefined && file.fileName.replaceAll('\\', '/').endsWith('/src/.generated/localization/result-templates.ts')) {
		const position = file.getLineAndCharacterOfPosition(diagnostic.start);
		const sourceLine = file.text.split('\n')[position.line] ?? '';
		const marker = / \/\/ @result-template (\[.*\])$/.exec(sourceLine);
		if (marker) {
			const location: unknown = JSON.parse(marker[1]!);
			if (Array.isArray(location) && location.length === 2 && typeof location[0] === 'string' && Number.isSafeInteger(location[1])) {
				return `${resolve(root, location[0])}: ${location[1]}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}\n`;
			}
		}
	}
	return ts.formatDiagnostics([diagnostic], {
		getCanonicalFileName: (file) => file,
		getCurrentDirectory: () => root,
		getNewLine: () => '\n',
	});
}

/** Use the normal project build with all declarations and its existing cache. */
export function buildTypes(root = repository, report: (message: string) => void = (message) => process.stderr.write(message)): ts.ExitStatus {
	const host = ts.createSolutionBuilderHost({ ...ts.sys, getCurrentDirectory: () => root }, undefined,
		(diagnostic) => report(formatDiagnostic(diagnostic, root)),
		(diagnostic) => report(formatDiagnostic(diagnostic, root)));
	return ts.createSolutionBuilder(host, [resolve(root, 'tsconfig.json')], {}).build();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = buildTypes();
}
