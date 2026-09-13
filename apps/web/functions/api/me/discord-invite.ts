import { ok } from "@bickr/shared/api";
import { discordInviteState } from "@bickr/shared/discord-invite";
import { requireUser, type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";
import { serviceRequest } from "../_proxy";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		return ok(await discordInviteState(env.BICKR_D1, user.id));
	} catch (error) { return pageErrorResponse(error); }
};

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		return env.AGENT_RUNTIME.fetch(serviceRequest(env, request,
			`/users/${encodeURIComponent(user.id)}/discord-invite/dismiss`, user.id));
	} catch (error) { return pageErrorResponse(error); }
};
