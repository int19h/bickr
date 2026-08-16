import { ok, readJsonBody } from "@bickr/shared/api";
import { listUserBots } from "@bickr/shared/repository";
import { requireCompleteUser, type AppEnv } from "../../_auth";
import { botTargetErrorResponse, parseBulkBotSelection, resolveBulkBotTargets } from "../_bot-targets";

/**
 * Expands the bot target grammar without doing anything with the result.
 *
 * Commands that act per participant — spotlight batches its selection and
 * reports progress bot by bot — need the concrete bots on the client. They read
 * them here rather than reimplementing what `w/<world>/g/<group>` means, so the
 * grammar keeps a single implementation and one place to grow.
 */
export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const body = await readJsonBody(request);
		const selection = parseBulkBotSelection(body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {});
		const ownedBots = await listUserBots(env.BICKR_KV, env.BICKR_D1, user.id);
		const bots = await resolveBulkBotTargets(env, user.id, ownedBots, selection);
		return ok({ bots });
	} catch (error) {
		return botTargetErrorResponse(error);
	}
};
