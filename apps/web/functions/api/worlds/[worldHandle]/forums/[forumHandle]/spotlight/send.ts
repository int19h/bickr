import { ok, readJsonBody } from "@bickr/shared/api";
import { type SpotlightDeliveryResult, type SpotlightSendInput } from "@bickr/shared/model";
import { forumByHandle, sendSpotlight } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";
import { fetchServiceJson, serviceRequest } from "../../../../../_proxy";

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
		const input = parseSpotlightInput(await readJsonBody(request));
		const result = await sendSpotlight(
			env.BICKR_KV,
			env.BICKR_D1,
			user.id,
			forum,
			input,
			async (botId, text, spotlightId) => {
				const { response, payload } = await fetchServiceJson(
					env.AGENT_RUNTIME,
					serviceRequest(
						request,
						`/bots/${encodeURIComponent(botId)}/inject`,
						user.id,
						JSON.stringify({ text, kind: "spotlight", sourceId: spotlightId, spotlightId }),
					),
				);
				const body = payload as {
					ok?: boolean;
					data?: { injectionId?: string };
					message?: string;
				};
				if (!response.ok || body.ok === false) {
					throw new Error(body.message ?? `Injection failed with status ${response.status}.`);
				}
				return { injectionId: body.data?.injectionId };
			},
		);
		if (input.autoStartTick ?? true) {
			await Promise.all(result.deliveries
				.filter((delivery) => delivery.ok && delivery.injectionId)
				.map(async (delivery) => {
					const tick = await startSpotlightTick(env, request, user.id, delivery.botId, delivery.injectionId!, delivery.spotlightId);
					delivery.tickStatus = tick.status;
					if (tick.error) {
						delivery.tickError = tick.error;
					}
				}));
		} else {
			for (const delivery of result.deliveries) {
				if (delivery.ok && delivery.injectionId) {
					delivery.tickStatus = "queued";
				}
			}
		}
		return ok(result);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

async function startSpotlightTick(
	env: AppEnv,
	request: Request,
	userId: string,
	botId: string,
	injectionId: string,
	spotlightId: string,
): Promise<{ status: NonNullable<SpotlightDeliveryResult["tickStatus"]>; error?: string }> {
	const { response, payload } = await fetchServiceJson(
		env.AGENT_RUNTIME,
		serviceRequest(
			request,
			`/bots/${encodeURIComponent(botId)}/tick`,
			userId,
			JSON.stringify({ mode: "spotlight", injectionIds: [injectionId], spotlightId, background: true }),
		),
	);
	const body = payload as {
		ok?: boolean;
		data?: { run?: { status?: string; error?: string } };
		message?: string;
	};
	if (!response.ok || body.ok === false) {
		return { status: "failed", error: body.message ?? `Tick start failed with status ${response.status}.` };
	}
	const run = body.data?.run;
	return {
		status: spotlightTickStatus(run?.status),
		...(run?.error ? { error: run.error } : {}),
	};
}

function spotlightTickStatus(status: string | undefined): NonNullable<SpotlightDeliveryResult["tickStatus"]> {
	switch (status) {
		case "already_running":
		case "completed":
		case "failed":
		case "paused":
		case "queued":
		case "started":
			return status;
		default:
			return "failed";
	}
}

function parseSpotlightInput(value: unknown): SpotlightSendInput {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const targetType = record.targetType === "comments" ? "comments" : "threads";
	return {
		targetType,
		threadIds: Array.isArray(record.threadIds) ? record.threadIds.filter(isString) : undefined,
		threadId: typeof record.threadId === "string" ? record.threadId : undefined,
		commentIds: Array.isArray(record.commentIds) ? record.commentIds.filter(isString) : undefined,
		botIds: Array.isArray(record.botIds) ? record.botIds.filter(isString) : [],
		focusText: typeof record.focusText === "string" ? record.focusText : undefined,
		autoStartTick: typeof record.autoStartTick === "boolean" ? record.autoStartTick : undefined,
	};
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
