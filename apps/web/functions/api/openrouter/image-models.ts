import { BodyReadTimeoutError, BodySizeLimitError } from "@bickr/shared/bounded-body";
import { loadOpenRouterImageCatalog, OpenRouterImageCatalogError } from "@bickr/shared/openrouter-image-models";
import { ok } from "@bickr/shared/api";
import { type AppEnv, requireCompleteUser } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestGet: PagesFunction<AppEnv> = async ({ request, env }) => {
	try {
		await requireCompleteUser(env, request);
		const catalog = await loadOpenRouterImageCatalog(request.signal);
		const models = catalog.models.filter((model) => model.outputModalities.includes("image")).map(({ supportsStreaming: _streaming, ...model }) => model);
		return ok({ models }, { headers: { "cache-control": "private, max-age=300" } });
	} catch (error) {
		if (error instanceof OpenRouterImageCatalogError || error instanceof BodyReadTimeoutError || error instanceof BodySizeLimitError) {
			return Response.json({ ok: false, error: "provider_error", message: "OpenRouter model list is unavailable. Try again later." },
				{ status: 502, headers: { "cache-control": "no-store" } });
		}
		return pageErrorResponse(error);
	}
};
