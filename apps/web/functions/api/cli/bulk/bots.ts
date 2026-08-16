import { ok, readJsonBody } from "@bickr/shared/api";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { type BotSummary, type LanguageTag, type LocalizedText, type UpdateBotInput } from "@bickr/shared/model";
import { listUserBots } from "@bickr/shared/repository";
import { InputError, parseUpdateBotInput } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../_auth";
import { fetchServiceJson } from "../../_proxy";
import {
	botTargetErrorResponse,
	parseBulkBotSelection,
	resolveBulkBotTargets,
	type BulkBotSelection,
} from "../_bot-targets";

type BulkBotsRequest = {
	selection: BulkBotSelection;
	update: UpdateBotInput;
	apply: boolean;
};

type BulkBotPlanItem = {
	botId: string;
	ref: string;
	handle: string;
	worldHandle: string;
	language: LanguageTag | null;
	displayName: LocalizedText;
	currentModel: string | null;
	nextModel: string | null;
	status: "planned" | "updated" | "failed";
	affectedBotRefs?: string[];
	error?: {
		code: string;
		message: string;
	};
};

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const input = parseBulkBotsRequest(await readJsonBody(request));
		const ownedBots = await listUserBots(env.BICKR_KV, env.BICKR_D1, user.id);
		const selected = await resolveBulkBotTargets(env, user.id, ownedBots, input.selection);
		const nextModel = Object.prototype.hasOwnProperty.call(input.update.inferenceSettings ?? {}, "model") ?
			input.update.inferenceSettings?.model ?? null
		:	undefined;
		const items: BulkBotPlanItem[] = selected.map((bot) => bulkBotPlanItem(bot, nextModel));
		if (!input.apply) {
			return ok({
				bulk: {
					operation: "bots.update",
					dryRun: true,
					targetCount: selected.length,
					update: input.update,
					bots: items,
				},
			});
		}

		const body = JSON.stringify(input.update);
		for (const item of items) {
			try {
				const headers = new Headers({
					"content-type": "application/json",
					"x-bickr-user-id": user.id,
				});
				addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
				const { response, payload } = await fetchServiceJson(
					env.AGENT_RUNTIME,
					new Request(internalServiceUrl(`/users/${encodeURIComponent(user.id)}/bots/${encodeURIComponent(item.botId)}`), {
						body,
						headers,
						method: "PATCH",
						signal: request.signal,
					}),
				);
				if (isBotUpdatePayload(payload)) {
					item.status = "updated";
					item.currentModel = payload.data.bot.inferenceSettings.model ?? null;
					item.affectedBotRefs = payload.data.affectedBots.map(botRef);
				} else if (isApiErrorPayload(payload)) {
					item.status = "failed";
					item.error = { code: payload.error, message: payload.message };
				} else {
					item.status = "failed";
					item.error = {
						code: "server_error",
						message: response.statusText || "Bot update response was invalid.",
					};
				}
			} catch (error) {
				item.status = "failed";
				item.error = {
					code: "server_error",
					message: error instanceof Error ? error.message : "Bot update failed.",
				};
			}
		}

		return ok({
			bulk: {
				operation: "bots.update",
				dryRun: false,
				targetCount: selected.length,
				updatedCount: items.filter((item) => item.status === "updated").length,
				failedCount: items.filter((item) => item.status === "failed").length,
				update: input.update,
				bots: items,
			},
		});
	} catch (error) {
		return botTargetErrorResponse(error);
	}
};

export function bulkBotPlanItem(bot: BotSummary, nextModel: string | null | undefined): BulkBotPlanItem {
	return {
		botId: bot.id,
		ref: botRef(bot),
		handle: bot.handle,
		worldHandle: bot.homeWorldHandle,
		language: bot.language,
		displayName: bot.displayName,
		currentModel: bot.inferenceSettings.model ?? null,
		nextModel: nextModel ?? bot.inferenceSettings.model ?? null,
		status: "planned",
	};
}

function parseBulkBotsRequest(value: unknown): BulkBotsRequest {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const selection = parseBulkBotSelection(record);
	const update = parseUpdateBotInput(record.update);
	if (Object.keys(update).some((key) => key !== "inferenceSettings")) {
		throw new InputError("Bulk bot update currently supports inference settings only.");
	}
	if (!update.inferenceSettings || !Object.prototype.hasOwnProperty.call(update.inferenceSettings, "model")) {
		throw new InputError("Bulk bot update currently requires an inference model change.");
	}
	return {
		selection,
		update,
		apply: record.apply === true,
	};
}

function botRef(bot: Pick<BotSummary, "homeWorldHandle" | "handle">): string {
	return `/w/${encodeURIComponent(bot.homeWorldHandle)}/u/${encodeURIComponent(bot.handle)}`;
}

function isBotUpdatePayload(value: unknown): value is { ok: true; data: { bot: BotSummary; affectedBots: BotSummary[] } } {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
	return record.ok === true && Boolean(data.bot) && Array.isArray(data.affectedBots);
}

function isApiErrorPayload(value: unknown): value is { ok: false; error: string; message: string } {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return record.ok === false && typeof record.error === "string" && typeof record.message === "string";
}
