import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { type ChirperImportPreview } from "@bickr/shared/model";
import { InputError, asRecord, requiredText } from "@bickr/shared/validation";
import { type AppEnv, requireUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";

export const onRequestPost: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request }) => {
	try {
		await requireUser(env, request);
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
	const root = asRecord(raw);
	const profile = candidateRecord(root.data) ?? candidateRecord(root.agent) ?? root;
	const displayName = firstString(profile.name, profile.displayName, profile.display_name, originalHandle);
	const shortBio = firstString(
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
		displayName: requiredText(displayName, "Chirper name", 80),
		shortBio: requiredText(shortBio, "Chirper short bio", 280),
		prompt: requiredText(prompt, "Chirper prompt", 12_000),
		importSource: {
			provider: "chirper",
			originalHandle,
			originalProfileUrl: `https://chirper.ai/${encodeURIComponent(originalHandle)}`,
			apiUrl,
			importedAt: new Date().toISOString(),
		},
	};
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
