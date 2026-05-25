import { InputError } from "@bickr/shared/validation";
import { type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { exportResponse, exportThreadRef } from "./_export";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const url = new URL(request.url);
		const ref = url.searchParams.get("ref")?.trim();
		if (!ref) {
			throw new InputError("Thread reference is required.");
		}
		return exportResponse(await exportThreadRef(env, ref), url.searchParams.get("format"));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
