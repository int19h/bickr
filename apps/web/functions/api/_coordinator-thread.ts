import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { type ApiErrorCode, type ThreadDocument } from "@bickr/shared/model";
import { RepositoryError } from "@bickr/shared/repository";
import type { AppEnv } from "./_auth";
import { fetchServiceJson } from "./_proxy";

/**
 * Reads a thread from its coordinator. Unlike the KV document, which edge
 * caches can serve for up to a minute after a write, this copy includes every
 * committed comment.
 */
export async function readCoordinatorThread(
	env: AppEnv,
	threadId: string,
	accept: string | null = null,
): Promise<ThreadDocument> {
	const headers = new Headers();
	if (accept !== null) {
		headers.set("accept", accept);
	}
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const { response, payload } = await fetchServiceJson(
		env.FORUM_COORDINATOR_SERVICE,
		new Request(internalServiceUrl(`/threads/${encodeURIComponent(threadId)}`), {
			headers,
			method: "GET",
		}),
	);
	if (isThreadPayload(payload)) {
		return payload.data.thread;
	}
	if (isErrorPayload(payload)) {
		throw new RepositoryError(repositoryErrorCode(payload.error), payload.message, response.status);
	}
	throw new RepositoryError("server_error", response.statusText || "Thread response was invalid.", response.status || 500);
}

function isThreadPayload(value: unknown): value is { ok: true; data: { thread: ThreadDocument } } {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value as { ok?: unknown }).ok === true &&
		Boolean((value as { data?: unknown }).data) &&
		typeof (value as { data?: unknown }).data === "object" &&
		Boolean(((value as { data: { thread?: unknown } }).data.thread))
	);
}

function isErrorPayload(value: unknown): value is { ok: false; error: ApiErrorCode; message: string } {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value as { ok?: unknown }).ok === false &&
		typeof (value as { error?: unknown }).error === "string" &&
		typeof (value as { message?: unknown }).message === "string"
	);
}

function repositoryErrorCode(value: ApiErrorCode): RepositoryError["code"] {
	return value === "oauth_error" ? "server_error" : value;
}
