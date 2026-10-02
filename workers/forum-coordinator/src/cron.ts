/**
 * The forum-coordinator Worker's cron triggers.
 *
 * Three schedules with different jobs share one `scheduled` handler, so the
 * handler has to know which trigger fired. These expressions are the contract
 * with `wrangler.jsonc` (every environment), `wrangler.deploy.jsonc` and
 * `wrangler.recreate-test.jsonc`; the cron test asserts each declared trigger
 * set matches this map exactly, so a trigger added to the configuration without
 * a task set here fails the build rather than silently running the wrong work.
 */

/** Daily maintenance: hot scores, index repair, and the other capped sweeps. */
export const forumCoordinatorDailyCronExpression = "0 0 * * *";

/**
 * Each prune has its own 8k-row subrequest budget. Running every five minutes
 * gives expiry a fixed share of capacity even while orphan cleanup is busy.
 * The one-minute offset separates it from the recovery queue's schedule.
 */
export const forumCoordinatorNotificationPruneCronExpression = "1-59/5 * * * *";

/** Bounded recovery of persisted work whose original invocation was lost. */
export const forumCoordinatorRecoveryCronExpression = "*/5 * * * *";

export type ForumCoordinatorCronTaskSet = "daily" | "notification_prune" | "recovery";

/**
 * Cloudflare delivers each trigger as a separate invocation with its own
 * budget. The task map keeps maintenance work attached to its intended budget.
 */
export const forumCoordinatorCronTaskSets = {
	[forumCoordinatorDailyCronExpression]: "daily",
	[forumCoordinatorNotificationPruneCronExpression]: "notification_prune",
	[forumCoordinatorRecoveryCronExpression]: "recovery",
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
