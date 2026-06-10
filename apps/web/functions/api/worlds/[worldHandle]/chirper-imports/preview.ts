import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { localizedText, type ChirperImportPreview, type LanguageTag } from "@bickr/shared/model";
import {
	InputError,
	asRecord,
	maxBotPromptLength,
	maxBotShortBioLength,
	requiredText,
	slugifyHandle,
} from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";
import { isAbortError, readLimitedResponseText } from "../../../_proxy";

const chirperFetchTimeoutMs = 15_000;
const chirperResponseBodyMaxBytes = 1_000_000;

export const onRequestPost: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request }) => {
	try {
		await requireCompleteUser(env, request);
		const body = asRecord(await readJsonBody(request));
		const source = requiredText(body.source, "Chirper URL or handle", 500);
		const originalHandle = chirperHandle(source);
		const apiUrl = `https://api.chirper.ai/v1/agent/${encodeURIComponent(originalHandle)}`;
		const profile = await fetchChirperProfile(env.CHIRPER_FETCH ?? fetch, apiUrl);

		if (!profile.ok) {
			return fail("bad_request", `Chirper profile fetch failed with ${profile.status}.`, 400);
		}

		const preview = chirperPreview(profile.payload, originalHandle, apiUrl);
		return ok({ preview });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

type ChirperFetchResult =
	| { ok: true; payload: unknown }
	| { ok: false; status: number };

async function fetchChirperProfile(fetcher: typeof fetch, apiUrl: string): Promise<ChirperFetchResult> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, chirperFetchTimeoutMs);
	try {
		const response = await fetcher(apiUrl, {
			signal: controller.signal,
			headers: {
				accept: "application/json",
				"user-agent": "bickr-local-dev",
			},
		});
		if (!response.ok) {
			void response.body?.cancel("Chirper profile fetch failed.").catch(() => {});
			return { ok: false, status: response.status };
		}
		return { ok: true, payload: await readChirperJson(response, controller.signal) };
	} catch (error) {
		if (timedOut || isAbortError(error)) {
			throw new InputError("Chirper profile fetch timed out.");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function readChirperJson(response: Response, signal: AbortSignal): Promise<unknown> {
	return JSON.parse(await readLimitedResponseText(response, signal, {
		maxBytes: chirperResponseBodyMaxBytes,
		timeoutCancelReason: "Chirper profile fetch timed out.",
		timeoutMessage: "Chirper profile fetch timed out.",
		tooLargeCancelReason: "Chirper response body byte limit reached.",
		tooLargeMessage: "Chirper profile response was too large.",
		error: (message) => new InputError(message),
	}));
}

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
	const language = chirperLanguage(profile);
	const displayName = firstString(profile.name, profile.displayName, profile.display_name, originalHandle);
	const shortBio = bestBioString(
		profile.short,
		profile.shortBio,
		profile.short_bio,
		profile.bio,
		profile.description,
	);
	const prompt = firstString(profile.prompt, profile.systemPrompt, profile.system_prompt, profile.persona);
	const avatarUrl = chirperAvatarUrl(profile);

	if (!shortBio || !prompt) {
		throw new InputError("Chirper profile did not include the required bio and prompt fields.");
	}

	return {
		handle: suggestedBickrHandle(firstString(profile.handle, profile.username, originalHandle) ?? originalHandle),
		language,
		displayName: localizedText(requiredText(limitText(displayName, 80), "Chirper name", 80), language),
		shortBio: localizedText(requiredText(limitText(shortBio, maxBotShortBioLength), "Chirper short bio", maxBotShortBioLength), language),
		prompt: localizedText(requiredText(prompt, "Chirper prompt", maxBotPromptLength), language),
		...(avatarUrl ? { avatarUrl } : {}),
		importSource: {
			provider: "chirper",
			originalHandle,
			originalProfileUrl: `https://chirper.ai/${encodeURIComponent(originalHandle)}`,
			apiUrl,
			importedAt: new Date().toISOString(),
			...(avatarUrl ? { sourceAvatarUrl: avatarUrl } : {}),
		},
	};
}

function chirperLanguage(profile: Record<string, unknown>): LanguageTag | null {
	const raw = firstString(profile.language, profile.lang, profile.locale);
	if (!raw) {
		return null;
	}
	try {
		const [canonical] = Intl.getCanonicalLocales(raw);
		return canonical ? canonical as LanguageTag : null;
	} catch {
		return null;
	}
}

function chirperAvatarUrl(profile: Record<string, unknown>): string | undefined {
	const avatar = candidateRecord(profile.avatar);
	const rawUrl = firstString(avatar?.url, profile.avatarUrl, profile.avatar_url);
	if (!rawUrl) {
		return undefined;
	}
	try {
		return new URL(rawUrl, "https://cdn.chirper.ai/").toString();
	} catch {
		return undefined;
	}
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
	return slugifyHandle(value, "chirper-bot", 28);
}
