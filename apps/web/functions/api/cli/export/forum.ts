import { InputError } from "@bickr/shared/validation";
import { type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { boundedLimit, boundedOffset } from "../../_query";
import { exportForumRef, exportResponse } from "./_export";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const url = new URL(request.url);
		const ref = url.searchParams.get("ref")?.trim();
		if (!ref) {
			throw new InputError("Forum reference is required.");
		}
		return exportResponse(
			await exportForumRef(env, ref, {
				limit: boundedLimit(url.searchParams.get("limit"), 40, 1_000),
				offset: boundedOffset(url.searchParams.get("offset")),
			}),
			url.searchParams.get("format"),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
