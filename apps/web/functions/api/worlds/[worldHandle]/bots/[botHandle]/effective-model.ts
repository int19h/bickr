import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";
import { publicServiceRequest } from "../../../../_proxy";

/**
 * The participant model row of a public profile, for every viewer.
 *
 * Pages cannot answer this itself: resolving the model the runtime would use
 * needs the owner's private inference graph and the deployment's provider
 * environment, neither of which this Worker holds. It therefore addresses the
 * participant by the same world/handle pair the rest of the public profile
 * uses and forwards to agent-runtime without a viewer identity, so the answer
 * cannot vary with who is signed in.
 */
export const onRequestGet: PagesFunction<AppEnv, "worldHandle" | "botHandle"> = async ({ env, params, request }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const botHandle = normalizeHandleParam(params.botHandle, "Bot handle");
		return env.AGENT_RUNTIME.fetch(publicServiceRequest(
			env,
			request,
			`/worlds/${encodeURIComponent(worldHandle)}/bots/${encodeURIComponent(botHandle)}/effective-model`,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
