import { RepositoryError } from "@bickr/shared/repository";
import type { AppEnv } from "../api/_auth";
import { redirectToResolvedPath, resolveThreadRef } from "../_content-refs";

export const onRequestGet: PagesFunction<AppEnv, "threadRef"> = handleThreadRefRedirect;
export const onRequestHead: PagesFunction<AppEnv, "threadRef"> = handleThreadRefRedirect;

async function handleThreadRefRedirect({ env, params, request }: EventContext<AppEnv, "threadRef", unknown>): Promise<Response> {
	try {
		const resolved = await resolveThreadRef(env, singleParam(params.threadRef));
		return redirectToResolvedPath(resolved.path, request);
	} catch (error) {
		if (error instanceof RepositoryError && error.status === 404) {
			return new Response("Thread not found.", { status: 404 });
		}
		throw error;
	}
}

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? value[0] ?? "" : value;
}
