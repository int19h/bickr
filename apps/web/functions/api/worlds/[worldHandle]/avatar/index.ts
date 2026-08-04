import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";
import { streamingServiceRequest } from "../../../_proxy";

async function avatarMutation(env: AppEnv, request: Request, value: string | string[]): Promise<Response> {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(value, "World handle");
		return env.AGENT_RUNTIME.fetch(streamingServiceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/worlds/${encodeURIComponent(worldHandle)}/avatar`,
			user.id,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
}

export const onRequestPut: PagesFunction<AppEnv, "worldHandle"> = ({ env, request, params }) => avatarMutation(env, request, params.worldHandle);
export const onRequestDelete: PagesFunction<AppEnv, "worldHandle"> = ({ env, request, params }) => avatarMutation(env, request, params.worldHandle);
