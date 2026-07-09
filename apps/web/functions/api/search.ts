import { ok } from "@bickr/shared/api";
import {
	boundedSearchPage,
	normalizeSearchFilters,
	parseSearchMode,
	parseSearchTypes,
	searchEntitiesText,
} from "@bickr/shared/search";
import { type AppEnv, requireCompleteUser } from "./_auth";
import { pageErrorResponse } from "./_errors";
import { serviceRequest } from "./_proxy";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const url = new URL(request.url);
		const mode = parseSearchMode(url.searchParams.get("mode"));
		if (mode === "semantic") {
			const user = await requireCompleteUser(env, request);
			return env.AGENT_RUNTIME.fetch(serviceRequest(env, request, `/search/entities?${url.searchParams.toString()}`, user.id));
		}
		const search = await searchEntitiesText(env.BICKR_D1, {
			...normalizeSearchFilters({
				forum: url.searchParams.get("forum"),
				username: url.searchParams.get("username"),
				world: url.searchParams.get("world"),
			}),
			mode,
			page: boundedSearchPage(url.searchParams.get("page")),
			query: url.searchParams.get("q") ?? "",
			types: parseSearchTypes(url.searchParams.get("types")),
		});
		return ok({ search });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
