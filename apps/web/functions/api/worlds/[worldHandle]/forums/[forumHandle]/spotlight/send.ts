import { ok, readJsonBody } from "@bickr/shared/api";
import { forumByHandle, sendSpotlightBatch, type SpotlightTickOutcome } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";
import { fetchServiceJson, ServiceRequestTimeoutError, serviceRequest } from "../../../../../_proxy";
import { parseSpotlightSendInput } from "./_input";

export const onRequestPost: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const input = parseSpotlightSendInput(await readJsonBody(request));
		const result = await sendSpotlightBatch(env.BICKR_KV, env.BICKR_D1, user.id, forum, input, {
			inject: async ({ botId, text, spotlightId }) => {
				try {
					const { response, payload } = await fetchServiceJson(
						env.AGENT_RUNTIME,
						serviceRequest(
							env,
							request,
							`/bots/${encodeURIComponent(botId)}/inject`,
							user.id,
							JSON.stringify({ text, kind: "spotlight", sourceId: spotlightId, spotlightId }),
						),
					);
					const body = payload as { ok?: boolean; data?: { injectionId?: string }; message?: string };
					const injectionId = body.data?.injectionId;
					if (!response.ok || body.ok === false || !injectionId) {
						return {
							kind: "failed",
							cause: "inject_error",
							message: body.message ?? `Injection failed with status ${response.status}.`,
						};
					}
					return { kind: "injected", injectionId };
				} catch (error) {
					if (error instanceof ServiceRequestTimeoutError) {
						return { kind: "failed", cause: "timeout", message: error.message };
					}
					return {
						kind: "failed",
						cause: "inject_error",
						message: error instanceof Error ? error.message : "Spotlight injection failed.",
					};
				}
			},
			startTick: async ({ botId, injectionId, spotlightId, deferred }) =>
				startSpotlightTick(env, request, user.id, { botId, injectionId, spotlightId, deferred }),
		});
		return ok(result);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

async function startSpotlightTick(
	env: AppEnv,
	request: Request,
	userId: string,
	input: { botId: string; injectionId: string; spotlightId: string; deferred: boolean },
): Promise<SpotlightTickOutcome> {
	try {
		const { response, payload } = await fetchServiceJson(
			env.AGENT_RUNTIME,
			serviceRequest(
				env,
				request,
				`/bots/${encodeURIComponent(input.botId)}/tick`,
				userId,
				JSON.stringify({
					mode: "spotlight",
					injectionIds: [input.injectionId],
					spotlightId: input.spotlightId,
					...(input.deferred ? { deferred: true } : { background: true }),
				}),
			),
		);
		const body = payload as {
			ok?: boolean;
			data?: { run?: { status?: string; error?: string } };
			message?: string;
		};
		if (!response.ok || body.ok === false) {
			return { kind: "failed", message: body.message ?? `Tick start failed with status ${response.status}.` };
		}
		return spotlightTickOutcome(body.data?.run, input.deferred);
	} catch (error) {
		return { kind: "failed", message: error instanceof Error ? error.message : "Tick start failed." };
	}
}

function spotlightTickOutcome(
	run: { status?: string; error?: string } | undefined,
	deferred: boolean,
): SpotlightTickOutcome {
	switch (run?.status) {
		case "started":
		case "completed":
			return { kind: "started" };
		case "queued":
			// A deferred request is queued by definition; an immediate one is queued
			// only because the participant is mid-visit. Both are read at the end of
			// the visit that is running or due, but the owner-facing reasons differ.
			return { kind: "pending", reason: deferred ? "deferred" : "queued_behind_run" };
		case "already_running":
			return {
				kind: "failed",
				message: "This participant is already in a visit that will not read the spotlight.",
			};
		case "paused":
			return { kind: "failed", message: "This participant is paused, so its spotlight visit did not start." };
		default:
			return { kind: "failed", message: run?.error ?? "The spotlight visit did not start." };
	}
}
