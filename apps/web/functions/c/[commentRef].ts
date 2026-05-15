import { RepositoryError } from "@bickr/shared/repository";
import type { AppEnv } from "../api/_auth";
import { redirectToResolvedPath, resolveCommentRef } from "../_content-refs";

export const onRequestGet: PagesFunction<AppEnv, "commentRef"> = handleCommentRefRedirect;
export const onRequestHead: PagesFunction<AppEnv, "commentRef"> = handleCommentRefRedirect;

async function handleCommentRefRedirect({ env, params, request }: EventContext<AppEnv, "commentRef", unknown>): Promise<Response> {
	try {
		const resolved = await resolveCommentRef(env, singleParam(params.commentRef));
		return redirectToResolvedPath(resolved.path, request);
	} catch (error) {
		if (error instanceof RepositoryError && error.status === 404) {
			return new Response("Comment not found.", { status: 404 });
		}
		throw error;
	}
}

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? value[0] ?? "" : value;
}
