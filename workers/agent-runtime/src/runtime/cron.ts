/**
 * The agent-runtime Worker's cron triggers.
 *
 * Two schedules with different jobs share one `scheduled` handler, so the
 * handler has to know which trigger fired. These expressions are the contract
 * with `wrangler.jsonc` (every environment) and `wrangler.deploy.jsonc`; the
 * cron test asserts each declared trigger set matches this map exactly, so a
 * trigger added to the configuration without a task set here fails the build
 * rather than silently running the wrong work.
 */

/** Fleet dispatch: the participant visit scheduler and its lifecycle recovery. */
export const agentRuntimeFrequentCronExpression = '*/5 * * * *';

/**
 * Daily maintenance. Deliberately off both the hour boundary the
 * forum-coordinator's daily cron uses and every five-minute mark, so it never
 * shares an invocation window with the frequent trigger or the other Worker's
 * daily D1 work.
 */
export const agentRuntimeDailyCronExpression = '23 3 * * *';

export type AgentRuntimeCronTaskSet = 'frequent' | 'daily';

export const agentRuntimeCronTaskSets = {
	[agentRuntimeFrequentCronExpression]: 'frequent',
	[agentRuntimeDailyCronExpression]: 'daily',
} as const satisfies Record<string, AgentRuntimeCronTaskSet>;

export type AgentRuntimeCronExpression = keyof typeof agentRuntimeCronTaskSets;

export const agentRuntimeCronExpressions = Object.keys(agentRuntimeCronTaskSets) as AgentRuntimeCronExpression[];

/**
 * The task set a trigger expression selects, or `null` for an expression this
 * deployment does not know. Cron expressions arrive as opaque strings from the
 * runtime, so an unknown one is a real possibility during a configuration change
 * and the caller decides what to do with it.
 */
export function agentRuntimeCronTaskSet(cron: string | undefined): AgentRuntimeCronTaskSet | null {
	if (cron === undefined) {
		return null;
	}
	const normalized = cron.trim().replace(/\s+/g, ' ');
	return isAgentRuntimeCronExpression(normalized) ? agentRuntimeCronTaskSets[normalized] : null;
}

function isAgentRuntimeCronExpression(cron: string): cron is AgentRuntimeCronExpression {
	return Object.hasOwn(agentRuntimeCronTaskSets, cron);
}
