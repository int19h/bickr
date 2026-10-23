import { cpSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Copy the real project sources without caches, dependencies, or browser assets. */
export function copyResultProject(repository, root) {
	const excluded = new Set(['node_modules', '.wrangler', '.git', 'dist', 'coverage', 'public']);
	for (const directory of ['packages', 'workers', 'scripts', 'test', 'apps']) {
		cpSync(join(repository, directory), join(root, directory), { recursive: true, filter: (file) => {
			if (excluded.has(basename(file))) return false;
			const entry = lstatSync(file);
			return entry.isDirectory() || (entry.isFile() && /\.(?:[cm]?tsx?|jsonc?|yaml|md)$/.test(file));
		} });
	}
	for (const file of ['package.json', 'tsconfig.base.json']) cpSync(join(repository, file), join(root, file));
	symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
	mkdirSync(join(root, '.wrangler'), { recursive: true });
	writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './workers/agent-runtime' }] }));
	const configFile = join(root, 'workers/agent-runtime/tsconfig.json');
	const configuration = JSON.parse(readFileSync(configFile, 'utf8'));
	configuration.compilerOptions.tsBuildInfoFile = '../../.wrangler/template-project.tsbuildinfo';
	writeFileSync(configFile, JSON.stringify(configuration));
}
