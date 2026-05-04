import { ok } from "@bickr/shared/api";
import { type ApiErrorCode, type ThreadDocument } from "@bickr/shared/model";
import { RepositoryError } from "@bickr/shared/repository";
import { forumByHandle, readThreadWithReadState, recordThreadRead, threadWithReadState } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { currentUser, requireCompleteUser, type AppEnv } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";
import { serviceRequest } from "../../../../../_proxy";

export const onRequestGet: PagesFunction<
	AppEnv,
	"worldHandle" | "forumHandle" | "threadId"
> = async ({ env, params, request }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const user = await currentUser(env, request);
		const loadedAt = new Date().toISOString();
		const fresh = new URL(request.url).searchParams.get("fresh") === "1";
		const thread =
			fresh ?
				await threadWithReadState(
					env.BICKR_D1,
					await readCoordinatorThread(env, request, threadId),
					user?.id ?? null,
				)
			:	await readThreadWithReadState(env.BICKR_KV, env.BICKR_D1, threadId, user?.id ?? null);
		if (thread.forumId !== forum.id) {
			return Response.json(
				{ ok: false, error: "not_found", message: "Thread not found." },
				{ status: 404 },
			);
		}
		if (user) {
			await recordThreadRead(env.BICKR_D1, user.id, thread.id, loadedAt);
		}
		return ok({ thread, loadedAt });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

async function readCoordinatorThread(
	env: AppEnv,
	request: Request,
	threadId: string,
): Promise<ThreadDocument> {
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	headers.delete("content-type");
	const response = await env.FORUM_COORDINATOR_SERVICE.fetch(
		new Request(`https://internal.bickr/threads/${encodeURIComponent(threadId)}`, {
			headers,
			method: "GET",
		}),
	);
	const payload = await readJsonResponse(response);
	if (isThreadPayload(payload)) {
		return payload.data.thread;
	}
	if (isErrorPayload(payload)) {
		throw new RepositoryError(repositoryErrorCode(payload.error), payload.message, response.status);
	}
	throw new RepositoryError("server_error", response.statusText || "Thread response was invalid.", response.status || 500);
}

async function readJsonResponse(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
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

export const onRequestDelete: PagesFunction<
	AppEnv,
	"worldHandle" | "forumHandle" | "threadId"
> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		return env.FORUM_COORDINATOR_SERVICE.fetch(
			serviceRequest(
				request,
				`/forums/${encodeURIComponent(forum.id)}/threads/${encodeURIComponent(threadId)}`,
				user.id,
			),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};
