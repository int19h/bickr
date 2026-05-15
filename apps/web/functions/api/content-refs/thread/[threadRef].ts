import { ok } from "@bickr/shared/api";
import type { AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { resolveThreadRef } from "../../../_content-refs";

export const onRequestGet: PagesFunction<AppEnv, "threadRef"> = async ({ env, params }) => {
	try {
		const resolved = await resolveThreadRef(env, singleParam(params.threadRef));
		return ok({ path: resolved.path });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? value[0] ?? "" : value;
}
