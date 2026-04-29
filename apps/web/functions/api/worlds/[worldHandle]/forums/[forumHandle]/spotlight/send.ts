import { ok, readJsonBody } from "@bickr/shared/api";
import { type SpotlightPreviewInput } from "@bickr/shared/model";
import { forumByHandle, sendSpotlight } from "@bickr/shared/social";
import { normalizeHandle } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";
import { serviceRequest } from "../../../../../_proxy";

export const onRequestPost: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	request,
	params,
	waitUntil,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandle(params.worldHandle);
		const forumHandle = normalizeHandle(params.forumHandle);
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const input = parseSpotlightInput(await readJsonBody(request));
		const result = await sendSpotlight(
			env.BICKR_KV,
			env.BICKR_D1,
			user.id,
			forum,
			input,
			async (botId, text, spotlightId) => {
				const response = await env.AGENT_RUNTIME.fetch(
					serviceRequest(
						request,
						`/bots/${encodeURIComponent(botId)}/inject`,
						user.id,
						JSON.stringify({ text, kind: "spotlight", sourceId: spotlightId, spotlightId }),
					),
				);
				const payload = (await response.json()) as {
					ok?: boolean;
					data?: { injectionId?: string };
					message?: string;
				};
				if (!response.ok || payload.ok === false) {
					throw new Error(payload.message ?? `Injection failed with status ${response.status}.`);
				}
				return { injectionId: payload.data?.injectionId };
			},
		);
		const tickStarts = result.deliveries
			.filter((delivery) => delivery.ok && delivery.injectionId)
			.map((delivery) => {
				delivery.tickStatus = "started";
				return startSpotlightTick(env, request, user.id, delivery.botId, delivery.injectionId!, delivery.spotlightId);
			});
		if (tickStarts.length > 0) {
			waitUntil(Promise.allSettled(tickStarts));
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
): Promise<void> {
	await env.AGENT_RUNTIME.fetch(
		serviceRequest(
			request,
			`/bots/${encodeURIComponent(botId)}/tick`,
			userId,
			JSON.stringify({ mode: "spotlight", injectionIds: [injectionId], spotlightId, background: true }),
		),
	);
}

function parseSpotlightInput(value: unknown): SpotlightPreviewInput {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const targetType = record.targetType === "comments" ? "comments" : "threads";
	return {
		targetType,
		threadIds: Array.isArray(record.threadIds) ? record.threadIds.filter(isString) : undefined,
		threadId: typeof record.threadId === "string" ? record.threadId : undefined,
		commentIds: Array.isArray(record.commentIds) ? record.commentIds.filter(isString) : undefined,
		botIds: Array.isArray(record.botIds) ? record.botIds.filter(isString) : [],
		focusText: typeof record.focusText === "string" ? record.focusText : undefined,
	};
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
