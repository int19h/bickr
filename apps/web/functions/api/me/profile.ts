import { ok, readJsonBody } from "@bickr/shared/api";
import { listUserAuthIdentities, userProfile } from "@bickr/shared/repository";
import { InputError, parseUpdateUserProfileInput } from "@bickr/shared/validation";
import type { TranslationInferenceAnnotation } from "@bickr/shared/model";
import { clearCookieHeader, type AppEnv, requireUser, sessionCookieName } from "../_auth";
import { pageErrorResponse } from "../_errors";
import { fetchServiceJson, serviceRequest } from "../_proxy";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const [authIdentities, annotationPayload] = await Promise.all([
			listUserAuthIdentities(env.BICKR_D1, user.id),
			fetchServiceJson(env.AGENT_RUNTIME, serviceRequest(
				env,
				request,
				`/users/${encodeURIComponent(user.id)}/inference-translation/annotation`,
				user.id,
			)).then(({ response, payload }) => {
				if (!response.ok) throw new Error("Agent runtime could not resolve the translation inference annotation.");
				return translationAnnotationFromServicePayload(payload);
			}),
		]);
		const profile = userProfile(user, authIdentities);
		return ok({ profile: { ...profile, ...(annotationPayload ? { translationInference: annotationPayload } : {}) } });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function translationAnnotationFromServicePayload(value: unknown): TranslationInferenceAnnotation | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent runtime returned an invalid translation annotation envelope.");
	const envelope = value as { ok?: unknown; data?: unknown };
	if (envelope.ok !== true || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
		throw new Error("Agent runtime returned an invalid translation annotation envelope.");
	}
	const annotation = (envelope.data as { annotation?: unknown }).annotation;
	if (annotation === null) return null;
	if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
		throw new Error("Agent runtime returned an invalid translation annotation.");
	}
	const record = annotation as Record<string, unknown>;
	if (typeof record.selectedConfigurationId !== "string" || typeof record.selectedDisplayName !== "string" ||
		typeof record.selectionRevision !== "number" || typeof record.effectiveModel !== "string" ||
		typeof record.effectiveRevisionFingerprint !== "string" || typeof record.credentialAvailable !== "boolean") {
		throw new Error("Agent runtime returned an invalid translation annotation.");
	}
	return record as TranslationInferenceAnnotation;
}

export const onRequestPatch: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const input = parseUpdateUserProfileInput(await request.json());
		return env.AGENT_RUNTIME.fetch(serviceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/profile`,
			user.id,
			JSON.stringify(input),
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const input = await readJsonBody(request);
		if (!input || typeof input !== "object" || Array.isArray(input) || (input as { confirmCascade?: unknown }).confirmCascade !== true) {
			throw new InputError("Profile deletion requires confirmCascade: true.");
		}
		const response = await env.AGENT_RUNTIME.fetch(
			serviceRequest(
				env,
				request,
				`/users/${encodeURIComponent(user.id)}/profile`,
				user.id,
				JSON.stringify({ confirmCascade: true }),
			),
		);
		if (!response.ok) {
			return response;
		}
		const next = new Response(response.body, response);
		next.headers.append("set-cookie", clearCookieHeader(request, sessionCookieName));
		return next;
	} catch (error) {
		return pageErrorResponse(error);
	}
};
