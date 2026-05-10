import { ok } from "@bickr/shared/api";
import { type AppEnv, requireCompleteUser } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestGet: PagesFunction<AppEnv> = async ({ request, env }) => {
	try {
		await requireCompleteUser(env, request);
		const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=image", {
			headers: { accept: "application/json" },
		});
		if (!response.ok) {
			return Response.json(
				{ ok: false, error: "provider_error", message: `OpenRouter model list returned HTTP ${response.status}.` },
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}
		const payload = await response.json() as { data?: unknown };
		const data = Array.isArray(payload.data) ? payload.data : [];
		const models = data
			.map(openRouterImageModel)
			.filter((model): model is OpenRouterImageModel => Boolean(model));
		return ok({ models }, { headers: { "cache-control": "private, max-age=300" } });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

type OpenRouterImageModel = {
	id: string;
	name: string;
	inputModalities: string[];
	outputModalities: string[];
};

function openRouterImageModel(value: unknown): OpenRouterImageModel | null {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const architecture =
		record.architecture && typeof record.architecture === "object" && !Array.isArray(record.architecture) ?
			record.architecture as Record<string, unknown>
		:	{};
	const outputModalities = stringArray(architecture.output_modalities);
	if (!outputModalities.includes("image")) {
		return null;
	}
	const id = stringValue(record.id);
	if (!id) {
		return null;
	}
	return {
		id,
		name: stringValue(record.name) ?? id,
		inputModalities: stringArray(architecture.input_modalities),
		outputModalities,
	};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
