import { fileURLToPath } from 'node:url';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const catalogRoots = ['packages/shared/src/localization', 'workers/agent-runtime/src/localization'] as const;
export const sourceDirectories = catalogRoots.map((path) => fileURLToPath(new URL(`${path}/`, new URL('../../', import.meta.url))));
