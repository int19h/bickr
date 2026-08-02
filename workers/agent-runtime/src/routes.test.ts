import { describe, expect, it } from 'vitest';
import { agentRuntimeRouteTable, matchAgentRuntimeRoute } from './routes';

const routeCases = [
	{ method: 'GET', path: '/health', handlerId: 'health' },
	{ method: 'GET', path: '/provider-settings/environment', handlerId: 'provider-environment' },
	{ method: 'POST', path: '/users/user-1/translate', handlerId: 'translate' },
	{ method: 'GET', path: '/search/entities', handlerId: 'search-entities' },
	{ method: 'POST', path: '/search/reindex-vectors', handlerId: 'reindex-search-vectors' },
	{ method: 'GET', path: '/statistics/inference-costs', handlerId: 'inference-cost-statistics' },
	{ method: 'GET', path: '/users/user-1/bots/token-spend', handlerId: 'owned-bot-token-spend' },
	{ method: 'POST', path: '/users/user-1/bots/spread-ticks', handlerId: 'spread-owned-bot-ticks' },
	{ method: 'POST', path: '/users/user-1/avatar/prompt', handlerId: 'user-avatar-prompt' },
	{ method: 'POST', path: '/users/user-1/avatar/generate', handlerId: 'user-avatar-generate' },
	{ method: 'POST', path: '/users/user-1/avatar/apply', handlerId: 'user-avatar-apply' },
	{ method: 'POST', path: '/users/user-1/worlds/world-1/bots', handlerId: 'create-bot' },
	{ method: 'PATCH', path: '/users/user-1/bots/bot-1', handlerId: 'update-bot' },
	{ method: 'POST', path: '/users/user-1/bots/bot-1/clone/unlink', handlerId: 'unlink-bot-clone' },
	{ method: 'POST', path: '/users/user-1/bots/bot-1/clone/relink', handlerId: 'relink-bot-clone' },
	{ method: 'POST', path: '/users/user-1/bots/bot-1/avatar/prompt', handlerId: 'bot-avatar-prompt' },
	{ method: 'POST', path: '/users/user-1/bots/bot-1/avatar/generate', handlerId: 'bot-avatar-generate' },
	{ method: 'POST', path: '/users/user-1/bots/bot-1/avatar/apply', handlerId: 'bot-avatar-apply' },
	{ method: 'POST', path: '/users/user-1/worlds/world-1/avatar/prompt', handlerId: 'world-avatar-prompt' },
	{
		method: 'GET',
		path: '/users/user-1/worlds/world-1/avatar/prompt-settings',
		handlerId: 'world-avatar-prompt-settings',
	},
	{ method: 'POST', path: '/users/user-1/worlds/world-1/avatar/generate', handlerId: 'world-avatar-generate' },
	{ method: 'POST', path: '/users/user-1/worlds/world-1/avatar/apply', handlerId: 'world-avatar-apply' },
	{ method: 'DELETE', path: '/users/user-1/bots/bot-1', handlerId: 'delete-bot' },
	{ method: 'DELETE', path: '/users/user-1/profile', handlerId: 'delete-profile' },
	{ method: 'POST', path: '/bots/bot-1/tick', handlerId: 'bot-runtime' },
] as const;

describe('agent runtime route matching', () => {
	it.each(routeCases)('$method $path resolves to $handlerId', ({ method, path, handlerId }) => {
		expect(matchAgentRuntimeRoute(path, method)?.handlerId).toBe(handlerId);
	});

	it('has one path-and-method assertion for every declarative route entry', () => {
		expect(routeCases.map(({ handlerId }) => handlerId)).toEqual(agentRuntimeRouteTable.map(({ id }) => id));
	});

	it('does not match a route under the wrong method', () => {
		expect(matchAgentRuntimeRoute('/users/user-1/translate', 'GET')).toBeNull();
	});

	it('preserves the raw BotRuntime path segment used to name the Durable Object', () => {
		expect(matchAgentRuntimeRoute('/bots/bot%2F1/tick', 'POST')?.params).toEqual(['bot%2F1']);
		expect(matchAgentRuntimeRoute('/bots/', 'GET')?.handlerId).toBe('bot-runtime');
	});
});
