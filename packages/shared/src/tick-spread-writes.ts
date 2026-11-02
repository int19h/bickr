import type { BotTickSpreadResult } from "./model";
import type { D1Result } from "./storage";
import type { TickSpreadPlan } from "./tick-spread";

export function botTickSpreadWriteOutcome(
	plan: TickSpreadPlan,
	batchResults: readonly D1Result[],
	skipped: Pick<BotTickSpreadResult["skipped"], "paused" | "running">,
): Pick<BotTickSpreadResult, "anchorBotId" | "scheduled" | "skipped"> {
	const scheduled = plan.scheduled.filter((_, index) => (batchResults[index]?.meta?.changes ?? 0) > 0);
	const anchorWritten = plan.anchorBotId !== undefined && scheduled.some((schedule) => schedule.botId === plan.anchorBotId);
	return {
		scheduled,
		skipped: {
			...skipped,
			changed: plan.scheduled.length - scheduled.length,
		},
		...(anchorWritten ? { anchorBotId: plan.anchorBotId } : {}),
	};
}
