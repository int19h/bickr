import { describe, expect, it } from 'vitest';
import * as worker from './index';
import { BotRuntime } from './runtime/bot-runtime';
import { UserBotsCoordinator } from './coordinator';
import handler from './routes';

// Named exports become Worker entrypoints. This exhaustive map also makes the
// TypeScript build reject accidental helper exports before deployment.
const expectedExports = {
	BotRuntime,
	UserBotsCoordinator,
	default: handler,
} satisfies Record<keyof typeof worker, unknown>;

describe('Worker entrypoint contract', () => {
	it('exports only the handler and the configured Durable Object classes', () => {
		expect(Object.keys(worker).sort()).toEqual(Object.keys(expectedExports).sort());
		for (const name of Object.keys(expectedExports) as (keyof typeof expectedExports)[]) {
			expect(worker[name]).toBe(expectedExports[name]);
		}
	});
});
