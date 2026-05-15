import { ok } from "@bickr/shared/api";
import type { AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { resolveCommentRef } from "../../../_content-refs";

export const onRequestGet: PagesFunction<AppEnv, "commentRef"> = async ({ env, params }) => {
	try {
		const resolved = await resolveCommentRef(env, singleParam(params.commentRef));
		return ok({ path: resolved.path });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? value[0] ?? "" : value;
}
