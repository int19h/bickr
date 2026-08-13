import { describe, expect, it } from 'vitest';
import { agentRuntimeRouteTable, matchAgentRuntimeRoute } from './routes';

const routeCases = [
	{ method: 'POST', path: '/accounts/bootstrap', handlerId: 'account-bootstrap-dispatch' },
	{ method: 'POST', path: '/users/user-1/lifecycle/recover', handlerId: 'lifecycle-recovery' },
	{ method: 'PUT', path: '/users/user-1/avatar', handlerId: 'user-avatar-upload' },
	{ method: 'DELETE', path: '/users/user-1/avatar', handlerId: 'user-avatar-delete' },
	{ method: 'PATCH', path: '/users/user-1/avatar/crop', handlerId: 'user-avatar-crop' },
	{ method: 'PUT', path: '/users/user-1/bots/bot-1/avatar', handlerId: 'bot-avatar-upload' },
	{ method: 'DELETE', path: '/users/user-1/bots/bot-1/avatar', handlerId: 'bot-avatar-delete' },
	{ method: 'PATCH', path: '/users/user-1/bots/bot-1/avatar/crop', handlerId: 'bot-avatar-crop' },
	{ method: 'PUT', path: '/users/user-1/worlds/world-1/avatar', handlerId: 'world-avatar-upload' },
	{ method: 'DELETE', path: '/users/user-1/worlds/world-1/avatar', handlerId: 'world-avatar-delete' },
	{ method: 'PATCH', path: '/users/user-1/worlds/world-1/avatar/crop', handlerId: 'world-avatar-crop' },
	{ method: 'POST', path: '/users/user-1/account/bootstrap', handlerId: 'account-bootstrap' },
	{ method: 'GET', path: '/users/user-1/inference-graph/migration', handlerId: 'inference-graph-migration-status' },
	{ method: 'POST', path: '/users/user-1/inference-graph/migrate', handlerId: 'run-inference-graph-migration' },
	{ method: 'GET', path: '/users/user-1/inference-translation-role/migration', handlerId: 'translation-role-migration-status' },
	{ method: 'POST', path: '/users/user-1/inference-translation-role/migrate', handlerId: 'migrate-translation-role' },
	{ method: 'POST', path: '/users/user-1/inference-graph/rollback', handlerId: 'rollback-inference-graph' },
	{ method: 'POST', path: '/users/user-1/inference-graph/reactivate', handlerId: 'reactivate-inference-graph' },
	{ method: 'GET', path: '/users/user-1/inference-configurations', handlerId: 'list-inference-configurations' },
	{ method: 'POST', path: '/users/user-1/inference-configurations', handlerId: 'create-inference-configuration' },
	{ method: 'GET', path: '/users/user-1/inference-configurations/config-1/parent-candidates', handlerId: 'inference-configuration-parent-candidates' },
	{ method: 'GET', path: '/users/user-1/inference-configurations/config-1/children', handlerId: 'inference-configuration-children' },
	{ method: 'GET', path: '/users/user-1/inference-configurations/config-1/impact', handlerId: 'inference-configuration-impact' },
	{ method: 'POST', path: '/users/user-1/inference-configurations/config-1/rename', handlerId: 'rename-inference-configuration' },
	{ method: 'POST', path: '/users/user-1/inference-configurations/config-1/reparent', handlerId: 'reparent-inference-configuration' },
	{ method: 'POST', path: '/users/user-1/inference-consumers/annotations', handlerId: 'get-inference-consumer-annotations' },
	{ method: 'GET', path: '/users/user-1/inference-configurations/effective-models', handlerId: 'inference-configuration-bot-effective-models' },
	{ method: 'GET', path: '/worlds/world-1/bots/bot-1/effective-model', handlerId: 'public-bot-effective-model' },
	{ method: 'GET', path: '/users/user-1/inference-configurations/fixed/bot/bot-1', handlerId: 'get-fixed-inference-configuration' },
	{ method: 'GET', path: '/users/user-1/inference-configurations/config-1', handlerId: 'get-inference-configuration' },
	{ method: 'PATCH', path: '/users/user-1/inference-configurations/config-1', handlerId: 'update-inference-configuration' },
	{ method: 'DELETE', path: '/users/user-1/inference-configurations/config-1', handlerId: 'delete-inference-configuration' },
	{ method: 'GET', path: '/users/user-1/inference-translation/annotation', handlerId: 'get-inference-translation-annotation' },
	{ method: 'GET', path: '/inference-graph/fleet-status', handlerId: 'inference-graph-fleet-status' },
	{ method: 'POST', path: '/inference-graph/cleanup', handlerId: 'inference-graph-cleanup' },
	{ method: 'POST', path: '/inference-graph/activate-lifecycle', handlerId: 'activate-inference-graph-lifecycle' },
	{ method: 'GET', path: '/health', handlerId: 'health' },
	{ method: 'POST', path: '/users/user-1/translate', handlerId: 'translate' },
	{ method: 'PATCH', path: '/users/user-1/profile', handlerId: 'update-profile' },
	{ method: 'POST', path: '/users/user-1/auth/identities', handlerId: 'link-provider-identity' },
	{ method: 'DELETE', path: '/users/user-1/auth/identities/github', handlerId: 'unlink-provider-identity' },
	{ method: 'GET', path: '/search/entities', handlerId: 'search-entities' },
	{ method: 'POST', path: '/search/reindex-vectors', handlerId: 'reindex-search-vectors' },
	{ method: 'GET', path: '/statistics/inference-costs', handlerId: 'inference-cost-statistics' },
	{ method: 'GET', path: '/users/user-1/bots/token-spend', handlerId: 'owned-bot-token-spend' },
	{ method: 'POST', path: '/users/user-1/bots/spread-ticks', handlerId: 'spread-owned-bot-ticks' },
	{ method: 'POST', path: '/users/user-1/avatar/prompt', handlerId: 'user-avatar-prompt' },
	{ method: 'POST', path: '/users/user-1/avatar/generate', handlerId: 'user-avatar-generate' },
	{ method: 'POST', path: '/users/user-1/avatar/apply', handlerId: 'user-avatar-apply' },
	{ method: 'POST', path: '/users/user-1/worlds/world-1/bots', handlerId: 'create-bot' },
	{ method: 'POST', path: '/users/user-1/worlds', handlerId: 'create-world' },
	{ method: 'PATCH', path: '/users/user-1/worlds/world-1', handlerId: 'update-world' },
	{ method: 'DELETE', path: '/users/user-1/worlds/world-1', handlerId: 'delete-world' },
	{ method: 'POST', path: '/users/user-1/worlds/world-1/groups', handlerId: 'create-bot-group' },
	{ method: 'PATCH', path: '/users/user-1/worlds/world-1/groups/group-1', handlerId: 'update-bot-group' },
	{ method: 'DELETE', path: '/users/user-1/worlds/world-1/groups/group-1', handlerId: 'delete-bot-group' },
	{ method: 'POST', path: '/users/user-1/worlds/world-1/groups/group-1/bots', handlerId: 'add-bot-group-members' },
	{ method: 'DELETE', path: '/users/user-1/worlds/world-1/groups/group-1/bots/bot-1', handlerId: 'remove-bot-group-member' },
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

	it('matches the fixed-entry lookup for every entity kind without shadowing a configuration id', () => {
		for (const path of [
			'/users/user-1/inference-configurations/fixed/account_default',
			'/users/user-1/inference-configurations/fixed/translation',
			'/users/user-1/inference-configurations/fixed/world/world-1',
			'/users/user-1/inference-configurations/fixed/bot/bot-1',
		]) {
			expect(matchAgentRuntimeRoute(path, 'GET')?.handlerId).toBe('get-fixed-inference-configuration');
		}
		expect(matchAgentRuntimeRoute('/users/user-1/inference-configurations/config-1', 'GET')?.handlerId)
			.toBe('get-inference-configuration');
		expect(matchAgentRuntimeRoute('/users/user-1/inference-configurations/config-1/children', 'GET')?.handlerId)
			.toBe('inference-configuration-children');
		// The set-oriented model lookup shares the single-configuration shape, so
		// its own route has to win the path segment.
		expect(matchAgentRuntimeRoute('/users/user-1/inference-configurations/effective-models', 'GET')?.handlerId)
			.toBe('inference-configuration-bot-effective-models');
	});

	// The public model row is one addressed participant, resolved without a
	// coordinator. It must stay a single read: no batch shape underneath it, and
	// no write method reachable through the same path.
	it('exposes the public participant model as one read-only participant-scoped route', () => {
		expect(matchAgentRuntimeRoute('/worlds/world-1/bots/bot-1/effective-model', 'GET')).toEqual({
			handlerId: 'public-bot-effective-model',
			dispatch: 'direct',
			params: ['world-1', 'bot-1'],
		});
		for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
			expect(matchAgentRuntimeRoute('/worlds/world-1/bots/bot-1/effective-model', method)).toBeNull();
		}
		for (const path of [
			'/worlds/world-1/bots/effective-model',
			'/worlds/world-1/bots/effective-models',
			'/worlds/world-1/bots',
			'/worlds/world-1/effective-model',
		]) {
			expect(matchAgentRuntimeRoute(path, 'GET')).toBeNull();
		}
	});

	it('does not match a route under the wrong method', () => {
		expect(matchAgentRuntimeRoute('/users/user-1/translate', 'GET')).toBeNull();
		expect(matchAgentRuntimeRoute('/users/user-1/inference-translation', 'GET')).toBeNull();
		expect(matchAgentRuntimeRoute('/users/user-1/inference-translation/candidates', 'GET')).toBeNull();
		expect(matchAgentRuntimeRoute('/users/user-1/inference-translation', 'PUT')).toBeNull();
	});

	it('preserves the raw BotRuntime path segment used to name the Durable Object', () => {
		expect(matchAgentRuntimeRoute('/bots/bot%2F1/tick', 'POST')?.params).toEqual(['bot%2F1']);
		expect(matchAgentRuntimeRoute('/bots/', 'GET')?.handlerId).toBe('bot-runtime');
	});
});
