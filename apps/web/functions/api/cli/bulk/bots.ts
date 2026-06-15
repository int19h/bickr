import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { internalServiceUrl } from "@bickr/shared/internal-service";
import { type BotSummary, type LanguageTag, type LocalizedText, type UpdateBotInput } from "@bickr/shared/model";
import { listUserBots, RepositoryError, worldByHandle } from "@bickr/shared/repository";
import { InputError, normalizeHandle, parseUpdateBotInput, requiredText } from "@bickr/shared/validation";
import { parsePathname } from "../../../../src/routes";
import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { fetchServiceJson } from "../../_proxy";

type BulkBotsRequest = {
	targets: string[];
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
		const selected = await resolveBulkBotTargets(env, user.id, ownedBots, input.targets);
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
				const { response, payload } = await fetchServiceJson(
					env.AGENT_RUNTIME,
					new Request(internalServiceUrl(`/users/${encodeURIComponent(user.id)}/bots/${encodeURIComponent(item.botId)}`), {
						body,
						headers: {
							"content-type": "application/json",
							"x-bickr-user-id": user.id,
						},
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
		if (error instanceof AmbiguousRefError) {
			return fail("conflict", error.message, 409, { references: error.references });
		}
		return pageErrorResponse(error);
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
	const targets = Array.isArray(record.targets) ?
		record.targets.map((target) => requiredText(target, "Target", 500))
	:	[];
	if (targets.length === 0) {
		throw new InputError("At least one bot target is required.");
	}
	const update = parseUpdateBotInput(record.update);
	if (Object.keys(update).some((key) => key !== "inferenceSettings")) {
		throw new InputError("Bulk bot update currently supports inference settings only.");
	}
	if (!update.inferenceSettings || !Object.prototype.hasOwnProperty.call(update.inferenceSettings, "model")) {
		throw new InputError("Bulk bot update currently requires an inference model change.");
	}
	if (targets.length > 500) {
		throw new InputError("Bulk bot update supports at most 500 target references.");
	}
	return {
		targets,
		update,
		apply: record.apply === true,
	};
}

async function resolveBulkBotTargets(
	env: AppEnv,
	userId: string,
	ownedBots: BotSummary[],
	targets: string[],
): Promise<BotSummary[]> {
	const ownedById = new Map(ownedBots.map((bot) => [bot.id, bot]));
	const selected = new Map<string, BotSummary>();
	for (const target of targets) {
		const bots = await resolveBulkBotTarget(env, userId, ownedBots, target);
		for (const bot of bots) {
			selected.set(bot.id, ownedById.get(bot.id) ?? bot);
		}
	}
	return [...selected.values()].sort((left, right) =>
		left.homeWorldHandle.localeCompare(right.homeWorldHandle) || left.handle.localeCompare(right.handle));
}

async function resolveBulkBotTarget(
	env: AppEnv,
	userId: string,
	ownedBots: BotSummary[],
	target: string,
): Promise<BotSummary[]> {
	const path = target.startsWith("/") ? target : `/${target}`;
	const parsed = parsePathname(path);
	if (parsed.route === "world" && parsed.worldHandle) {
		const worldHandle = normalizeHandle(parsed.worldHandle);
		await worldByHandle(env.BICKR_D1, worldHandle);
		return ownedBots.filter((bot) => bot.homeWorldHandle === worldHandle);
	}
	if (
		(parsed.route === "bot-profile" || parsed.route === "bot-avatar" || parsed.route === "bot-loop" || parsed.route === "bot-edit") &&
		parsed.worldHandle &&
		parsed.botHandle
	) {
		return [await resolveExplicitBot(env, userId, ownedBots, normalizeHandle(parsed.worldHandle), normalizeHandle(parsed.botHandle))];
	}
	const [prefix, handle] = target.split("/", 2);
	if (prefix === "u" && handle) {
		return [await resolveShortBot(env, userId, ownedBots, normalizeHandle(handle))];
	}
	if (target.startsWith("bot_")) {
		return [await resolveBotId(env, userId, ownedBots, target)];
	}
	throw new InputError(`Unsupported bot bulk target: ${target}`);
}

async function resolveExplicitBot(
	env: AppEnv,
	userId: string,
	ownedBots: BotSummary[],
	worldHandle: string,
	botHandle: string,
): Promise<BotSummary> {
	const row = await env.BICKR_D1.prepare(
		`SELECT bot_id AS id, owner_user_id AS ownerUserId
		 FROM bots_index
		 WHERE home_world_handle = ? AND handle = ? AND deleted_at IS NULL
		 LIMIT 1`,
	)
		.bind(worldHandle, botHandle)
		.first<{ id: string; ownerUserId: string }>();
	if (!row) {
		throw new RepositoryError("not_found", `Bot reference was not found: w/${worldHandle}/u/${botHandle}`, 404);
	}
	if (row.ownerUserId !== userId) {
		throw new RepositoryError("forbidden", `You do not own bot reference: w/${worldHandle}/u/${botHandle}`, 403);
	}
	const bot = ownedBots.find((candidate) => candidate.id === row.id);
	if (!bot) {
		throw new RepositoryError("not_found", `Bot reference was not found: w/${worldHandle}/u/${botHandle}`, 404);
	}
	return bot;
}

async function resolveShortBot(
	env: AppEnv,
	userId: string,
	ownedBots: BotSummary[],
	botHandle: string,
): Promise<BotSummary> {
	const result = await env.BICKR_D1.prepare(
		`SELECT bot_id AS id, owner_user_id AS ownerUserId, home_world_handle AS worldHandle, handle
		 FROM bots_index
		 WHERE handle = ? AND deleted_at IS NULL
		 ORDER BY home_world_handle ASC`,
	)
		.bind(botHandle)
		.all<{ id: string; ownerUserId: string; worldHandle: string; handle: string }>();
	const rows: { id: string; ownerUserId: string; worldHandle: string; handle: string }[] = result.results ?? [];
	if (rows.length === 0) {
		throw new RepositoryError("not_found", `Bot reference was not found: u/${botHandle}`, 404);
	}
	if (rows.length > 1) {
		throw new AmbiguousRefError(
			`Bot reference is ambiguous: u/${botHandle}`,
			rows.map((row) => `/w/${encodeURIComponent(row.worldHandle)}/u/${encodeURIComponent(row.handle)}`),
		);
	}
	const row = rows[0];
	if (!row || row.ownerUserId !== userId) {
		throw new RepositoryError("forbidden", `You do not own bot reference: u/${botHandle}`, 403);
	}
	const bot = ownedBots.find((candidate) => candidate.id === row.id);
	if (!bot) {
		throw new RepositoryError("not_found", `Bot reference was not found: u/${botHandle}`, 404);
	}
	return bot;
}

async function resolveBotId(
	env: AppEnv,
	userId: string,
	ownedBots: BotSummary[],
	botId: string,
): Promise<BotSummary> {
	const row = await env.BICKR_D1.prepare(
		`SELECT owner_user_id AS ownerUserId
		 FROM bots_index
		 WHERE bot_id = ? AND deleted_at IS NULL
		 LIMIT 1`,
	)
		.bind(botId)
		.first<{ ownerUserId: string }>();
	if (!row) {
		throw new RepositoryError("not_found", `Bot was not found: ${botId}`, 404);
	}
	if (row.ownerUserId !== userId) {
		throw new RepositoryError("forbidden", `You do not own bot: ${botId}`, 403);
	}
	const bot = ownedBots.find((candidate) => candidate.id === botId);
	if (!bot) {
		throw new RepositoryError("not_found", `Bot was not found: ${botId}`, 404);
	}
	return bot;
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

class AmbiguousRefError extends Error {
	readonly references: string[];

	constructor(message: string, references: string[]) {
		super(message);
		this.name = "AmbiguousRefError";
		this.references = references;
	}
}
