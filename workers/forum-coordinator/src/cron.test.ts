import { describe, expect, it } from "vitest";
import { unstable_readConfig as readConfig } from "wrangler";
import {
	forumCoordinatorCronExpressions,
	forumCoordinatorCronTaskSet,
	forumCoordinatorDailyCronExpression,
	forumCoordinatorNotificationPruneCronExpression,
} from "./cron";

// Every forum-coordinator Wrangler configuration that declares triggers, and the
// environment it declares them for. A trigger set that drifts from the task-set
// map would deploy a cron the scheduled handler cannot route.
const triggerConfigurations = [
	{ label: "local/production default", path: "workers/forum-coordinator/wrangler.jsonc" },
	{ label: "test environment", path: "workers/forum-coordinator/wrangler.jsonc", environment: "test" },
	{ label: "production deploy", path: "workers/forum-coordinator/wrangler.deploy.jsonc" },
	{ label: "post-transfer test recreate", path: "workers/forum-coordinator/wrangler.recreate-test.jsonc" },
] as const;

describe("forum-coordinator cron triggers", () => {
	it.each(triggerConfigurations)("declares exactly the known task sets in the $label configuration", ({ path, ...rest }) => {
		const environment = "environment" in rest ? rest.environment : undefined;
		const config = readConfig({ config: path, ...(environment ? { env: environment } : {}) }, { hideWarnings: true });

		expect(config.triggers?.crons).toEqual(forumCoordinatorCronExpressions);
	});

	it("maps each declared expression to its task set and nothing else", () => {
		expect(forumCoordinatorCronTaskSet(forumCoordinatorDailyCronExpression)).toBe("daily");
		expect(forumCoordinatorCronTaskSet(forumCoordinatorNotificationPruneCronExpression)).toBe("notification_prune");
		expect(forumCoordinatorCronTaskSet("  0   */6  *  *  * ")).toBe("notification_prune");
		expect(forumCoordinatorCronTaskSet("*/5 * * * *")).toBeNull();
		expect(forumCoordinatorCronTaskSet(undefined)).toBeNull();
	});

	it("gives the prune four invocations a day, each with its own subrequest budget", () => {
		const [minute, hour] = forumCoordinatorNotificationPruneCronExpression.split(" ");
		expect(minute).toBe("0");
		expect(hour).toBe("*/6");
	});
});
