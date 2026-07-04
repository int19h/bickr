import { ok } from "@bickr/shared/api";
import { type SearchSuggestResponse } from "@bickr/shared/model";
import { searchSuggestions } from "@bickr/shared/search";
import { type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const url = new URL(request.url);
		const query = url.searchParams.get("q") ?? "";
		const suggestions = await searchSuggestions(env.BICKR_D1, { query });
		return ok({
			query: suggestions.query,
			results: suggestions.results,
		} satisfies SearchSuggestResponse);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
