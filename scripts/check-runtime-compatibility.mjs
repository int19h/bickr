#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { unstable_readConfig as readConfig } from 'wrangler';

// TypeScript and the Vitest pool do not establish deployment compatibility.
// Every alternate configuration that can load this module must enable its ALS
// authority scope, including transfer/rollback configurations and the test pool.
const configs = readdirSync('workers/agent-runtime')
	.filter((name) => /^wrangler(?:\..+)?\.jsonc$/.test(name))
	.map((name) => `workers/agent-runtime/${name}`);
configs.push('apps/web/wrangler.test.jsonc');
for (const path of configs) {
	const config = readConfig({ config: path }, { hideWarnings: true });
	if (!config.compatibility_flags.includes('nodejs_als')) {
		throw new Error(`${path} must explicitly enable nodejs_als for runtime execution scopes.`);
	}
}
console.log(`Runtime AsyncLocalStorage compatibility verified in ${configs.length} configurations.`);
