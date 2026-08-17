/**
 * The forum-coordinator Worker's cron triggers.
 *
 * Two schedules with different jobs share one `scheduled` handler, so the
 * handler has to know which trigger fired. These expressions are the contract
 * with `wrangler.jsonc` (every environment), `wrangler.deploy.jsonc` and
 * `wrangler.recreate-test.jsonc`; the cron test asserts each declared trigger
 * set matches this map exactly, so a trigger added to the configuration without
 * a task set here fails the build rather than silently running the wrong work.
 */

/** Daily maintenance: hot scores, index repair, and the other capped sweeps. */
export const forumCoordinatorDailyCronExpression = "0 0 * * *";

/**
 * The notification prune, on its own trigger (design doc §2.3). It is capped at
 * 8k rows per invocation because each row costs a KV delete subrequest, and the
 * daily run's remaining work already claims most of one invocation's budget.
 * Four invocations a day give it 32k rows/day of capacity — comfortably above
 * the 5-10k rows/day of undelivered expiry the redesign leaves behind — each
 * with a subrequest budget of its own.
 */
export const forumCoordinatorNotificationPruneCronExpression = "0 */6 * * *";

export type ForumCoordinatorCronTaskSet = "daily" | "notification_prune";

/**
 * Both expressions fire at midnight, which is fine: cron triggers are delivered
 * as separate invocations with separate budgets, and the two task sets share no
 * work.
 */
export const forumCoordinatorCronTaskSets = {
	[forumCoordinatorDailyCronExpression]: "daily",
	[forumCoordinatorNotificationPruneCronExpression]: "notification_prune",
} as const satisfies Record<string, ForumCoordinatorCronTaskSet>;

export type ForumCoordinatorCronExpression = keyof typeof forumCoordinatorCronTaskSets;

export const forumCoordinatorCronExpressions = Object.keys(forumCoordinatorCronTaskSets) as ForumCoordinatorCronExpression[];

/**
 * The task set a trigger expression selects, or `null` for an expression this
 * deployment does not know. Cron expressions arrive as opaque strings from the
 * runtime, so an unknown one is a real possibility during a configuration
 * change, and the caller decides what to do with it.
 */
export function forumCoordinatorCronTaskSet(cron: string | undefined): ForumCoordinatorCronTaskSet | null {
	if (cron === undefined) {
		return null;
	}
	const normalized = cron.trim().replace(/\s+/g, " ");
	return isForumCoordinatorCronExpression(normalized) ? forumCoordinatorCronTaskSets[normalized] : null;
}

function isForumCoordinatorCronExpression(cron: string): cron is ForumCoordinatorCronExpression {
	return Object.hasOwn(forumCoordinatorCronTaskSets, cron);
}
