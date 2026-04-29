import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { type ChirperImportPreview } from "@bickr/shared/model";
import {
	InputError,
	asRecord,
	maxBotPromptLength,
	maxBotShortBioLength,
	requiredText,
} from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";

export const onRequestPost: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request }) => {
	try {
		await requireCompleteUser(env, request);
		const body = asRecord(await readJsonBody(request));
		const source = requiredText(body.source, "Chirper URL or handle", 500);
		const originalHandle = chirperHandle(source);
		const apiUrl = `https://api.chirper.ai/v1/agent/${encodeURIComponent(originalHandle)}`;
		const response = await (env.CHIRPER_FETCH ?? fetch)(apiUrl, {
			headers: {
				accept: "application/json",
				"user-agent": "bickr-local-dev",
			},
		});

		if (!response.ok) {
			return fail("bad_request", `Chirper profile fetch failed with ${response.status}.`, 400);
		}

		const preview = chirperPreview(await response.json(), originalHandle, apiUrl);
		return ok({ preview });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function chirperHandle(source: string): string {
	const trimmed = source.trim();
	if (trimmed.length === 0) {
		throw new InputError("Chirper URL or handle is required.");
	}

	try {
		const url = new URL(trimmed);
		const pathHandle = url.pathname.split("/").filter(Boolean).at(0);
		if (pathHandle) {
			return decodeURIComponent(pathHandle);
		}
	} catch {
		// Treat non-URL input as a raw handle below.
	}

	return trimmed.replace(/^@/, "");
}

function chirperPreview(raw: unknown, originalHandle: string, apiUrl: string): ChirperImportPreview {
	const profile = chirperProfileRecord(raw);
	const displayName = firstString(profile.name, profile.displayName, profile.display_name, originalHandle);
	const shortBio = bestBioString(
		profile.short,
		profile.shortBio,
		profile.short_bio,
		profile.bio,
		profile.description,
	);
	const prompt = firstString(profile.prompt, profile.systemPrompt, profile.system_prompt, profile.persona);

	if (!shortBio || !prompt) {
		throw new InputError("Chirper profile did not include the required bio and prompt fields.");
	}

	return {
		handle: suggestedBickrHandle(firstString(profile.handle, profile.username, originalHandle) ?? originalHandle),
		displayName: requiredText(limitText(displayName, 80), "Chirper name", 80),
		shortBio: requiredText(limitText(shortBio, maxBotShortBioLength), "Chirper short bio", maxBotShortBioLength),
		prompt: requiredText(prompt, "Chirper prompt", maxBotPromptLength),
		importSource: {
			provider: "chirper",
			originalHandle,
			originalProfileUrl: `https://chirper.ai/${encodeURIComponent(originalHandle)}`,
			apiUrl,
			importedAt: new Date().toISOString(),
		},
	};
}

function chirperProfileRecord(raw: unknown): Record<string, unknown> {
	let current = asRecord(raw);
	for (let index = 0; index < 4; index += 1) {
		const nested =
			candidateRecord(current.result) ??
			candidateRecord(current.data) ??
			candidateRecord(current.agent) ??
			candidateRecord(current.profile);
		if (!nested) {
			return current;
		}
		current = nested;
	}

	return current;
}

function candidateRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	return undefined;
}

function bestBioString(...values: unknown[]): string | undefined {
	const candidates = values
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean);
	return candidates.sort((left, right) => right.length - left.length)[0];
}

function limitText(value: string | undefined, maxLength: number): string | undefined {
	if (value === undefined || value.length <= maxLength) {
		return value;
	}

	return value.slice(0, maxLength).trimEnd();
}

function suggestedBickrHandle(value: string): string {
	const ascii = value
		.normalize("NFKD")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.slice(0, 28);
	const base = ascii.length >= 3 ? ascii : "chirper-bot";
	return base.replaceAll(/^-+|-+$/g, "") || "chirper-bot";
}
