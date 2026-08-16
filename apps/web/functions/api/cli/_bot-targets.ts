import { fail } from "@bickr/shared/api";
import { type BotSummary } from "@bickr/shared/model";
import { RepositoryError, worldByHandle } from "@bickr/shared/repository";
import { InputError, normalizeHandle, requiredText } from "@bickr/shared/validation";
import { parsePathname } from "../../../src/routes";
import { type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";

/**
 * The CLI's one way of naming a set of owned participants.
 *
 * Every multi-bot command sends the same reference strings to the server and
 * gets concrete bots back, so the grammar has a single implementation: adding a
 * form here adds it to bulk updates, group membership, and spotlight at once,
 * and no client ever re-derives what a reference expands to.
 */
export type BulkBotTarget =
	/** Every owned bot whose home world is this one. */
	| { kind: "world"; worldHandle: string }
	/** Every owned bot in one of the owner's groups in this world. */
	| { kind: "group"; worldHandle: string; groupRef: string }
	| { kind: "bot-in-world"; worldHandle: string; botHandle: string }
	| { kind: "bot-handle"; botHandle: string }
	| { kind: "bot-id"; botId: string };

/**
 * A whole selection: the union of the parsed references, or — with `all` — the
 * owner's entire fleet, narrowed to the named worlds when any are given.
 */
export type BulkBotSelection = {
	targets: BulkBotTarget[];
	all: boolean;
};

/** Bounds the fan-out of one request; each reference may still expand to many bots. */
export const maxBulkBotTargets = 500;

/** A reference is a path or a group title, not a document. */
const maxBulkBotTargetLength = 500;

export function parseBulkBotSelection(record: Record<string, unknown>): BulkBotSelection {
	const all = record.all === true;
	const rawTargets = Array.isArray(record.targets) ? record.targets : [];
	if (rawTargets.length > maxBulkBotTargets) {
		throw new InputError(`A bot selection supports at most ${maxBulkBotTargets} target references.`);
	}
	const targets = rawTargets.map((target) => parseBulkBotTarget(requiredText(target, "Target", maxBulkBotTargetLength)));
	if (targets.length === 0 && !all) {
		throw new InputError("At least one bot target is required.");
	}
	// With `all` the references are not a union but a narrowing, so anything
	// that is not a world would silently mean something else than it does on
	// its own.
	const narrowing = targets.find((target) => target.kind !== "world");
	if (all && narrowing) {
		throw new InputError("All-bots selection can only be narrowed by world references.");
	}
	return { targets, all };
}

export function parseBulkBotTarget(target: string): BulkBotTarget {
	const group = parseGroupTarget(target);
	if (group) {
		return group;
	}
	const path = target.startsWith("/") ? target : `/${target}`;
	const parsed = parsePathname(path);
	if (parsed.route === "world" && parsed.worldHandle) {
		return { kind: "world", worldHandle: normalizeHandle(parsed.worldHandle) };
	}
	if (
		(parsed.route === "bot-profile" || parsed.route === "bot-avatar" || parsed.route === "bot-loop" || parsed.route === "bot-edit") &&
		parsed.worldHandle &&
		parsed.botHandle
	) {
		return {
			kind: "bot-in-world",
			worldHandle: normalizeHandle(parsed.worldHandle),
			botHandle: normalizeHandle(parsed.botHandle),
		};
	}
	const [prefix, handle] = target.split("/", 2);
	if (prefix === "u" && handle) {
		return { kind: "bot-handle", botHandle: normalizeHandle(handle) };
	}
	if (target.startsWith("bot_")) {
		return { kind: "bot-id", botId: target };
	}
	throw new InputError(`Unsupported bot target: ${target}`);
}

/**
 * `w/<world>/g/<group>`, where the group part is a group id or the exact text of
 * the group's custom title. The title is taken verbatim rather than split on
 * `/`, since it is free text the owner chose and may contain anything.
 */
function parseGroupTarget(target: string): BulkBotTarget | null {
	const match = /^\/?w\/([^/]+)\/g\/(.+)$/.exec(target);
	if (!match) {
		return null;
	}
	const [, worldSegment = "", groupSegment = ""] = match;
	return {
		kind: "group",
		worldHandle: normalizeHandle(decodeTargetSegment(worldSegment, target)),
		groupRef: decodeTargetSegment(groupSegment, target).trim(),
	};
}

function decodeTargetSegment(segment: string, target: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new InputError(`Bot target is not a valid reference: ${target}`);
	}
}

export async function resolveBulkBotTargets(
	env: AppEnv,
	userId: string,
	ownedBots: BotSummary[],
	selection: BulkBotSelection,
): Promise<BotSummary[]> {
	if (selection.all && selection.targets.length === 0) {
		return sortedBots(ownedBots);
	}
	const ownedById = new Map(ownedBots.map((bot) => [bot.id, bot]));
	const selected = new Map<string, BotSummary>();
	const worlds = worldLookup(env);
	const groups = ownedGroupLookup(env, userId);
	for (const target of selection.targets) {
		const bots = await resolveBulkBotTarget(env, userId, ownedBots, worlds, groups, target);
		for (const bot of bots) {
			selected.set(bot.id, ownedById.get(bot.id) ?? bot);
		}
	}
	return sortedBots([...selected.values()]);
}

function sortedBots(bots: BotSummary[]): BotSummary[] {
	return [...bots].sort((left, right) =>
		left.homeWorldHandle.localeCompare(right.homeWorldHandle) || left.handle.localeCompare(right.handle));
}

async function resolveBulkBotTarget(
	env: AppEnv,
	userId: string,
	ownedBots: BotSummary[],
	worlds: (worldHandle: string) => Promise<string>,
	groups: (worldId: string) => Promise<OwnedGroup[]>,
	target: BulkBotTarget,
): Promise<BotSummary[]> {
	switch (target.kind) {
		case "world": {
			// Confirms the world exists: an owner with no bots there should hear
			// that the reference is wrong, not that it matched nothing.
			await worlds(target.worldHandle);
			return ownedBots.filter((bot) => bot.homeWorldHandle === target.worldHandle);
		}
		case "group":
			return resolveGroup(ownedBots, groups, await worlds(target.worldHandle), target);
		case "bot-in-world":
			return [await resolveExplicitBot(env, userId, ownedBots, target.worldHandle, target.botHandle)];
		case "bot-handle":
			return [await resolveShortBot(env, userId, ownedBots, target.botHandle)];
		case "bot-id":
			return [await resolveBotId(env, userId, ownedBots, target.botId)];
		default:
			return assertNeverTarget(target);
	}
}

function assertNeverTarget(target: never): never {
	throw new InputError(`Unsupported bot target: ${JSON.stringify(target)}`);
}

async function resolveGroup(
	ownedBots: BotSummary[],
	groups: (worldId: string) => Promise<OwnedGroup[]>,
	worldId: string,
	target: { worldHandle: string; groupRef: string },
): Promise<BotSummary[]> {
	const matched = matchGroups(await groups(worldId), target.groupRef);
	const reference = `w/${target.worldHandle}/g/${target.groupRef}`;
	if (matched.length === 0) {
		throw new RepositoryError("not_found", `Group reference was not found: ${reference}`, 404);
	}
	if (matched.length > 1) {
		throw new AmbiguousRefError(
			`Group reference is ambiguous: ${reference}`,
			matched.map((group) => `/w/${encodeURIComponent(target.worldHandle)}/g/${encodeURIComponent(group.id)}`),
		);
	}
	const members = new Set(matched[0]?.botIds ?? []);
	return ownedBots.filter((bot) => members.has(bot.id));
}

/**
 * An id wins over a title outright: ids are minted, so a title equal to one is
 * the owner naming a group after an identifier rather than a real collision.
 * Titles are compared case-insensitively but otherwise exactly, so two groups
 * sharing one title are reported as ambiguous instead of one being guessed.
 *
 * The folding is `toLowerCase`, not the locale-sensitive form: which groups a
 * reference names must not depend on where the server happens to be running.
 */
function matchGroups(groups: OwnedGroup[], groupRef: string): OwnedGroup[] {
	const byId = groups.filter((group) => group.id === groupRef);
	if (byId.length > 0) {
		return byId;
	}
	const folded = groupRef.toLowerCase();
	return groups.filter((group) => group.customTitle !== null && group.customTitle.trim().toLowerCase() === folded);
}

type OwnedGroup = {
	id: string;
	customTitle: string | null;
	botIds: string[];
};

/**
 * The owner's groups in one world, with their membership, in a single query —
 * and once per world however many group references name it, so a selection
 * never turns into a query per group or per member.
 */
function ownedGroupLookup(env: AppEnv, userId: string): (worldId: string) => Promise<OwnedGroup[]> {
	const byWorld = new Map<string, Promise<OwnedGroup[]>>();
	return (worldId) => {
		const pending = byWorld.get(worldId);
		if (pending) {
			return pending;
		}
		const loaded = loadOwnedGroups(env, userId, worldId);
		byWorld.set(worldId, loaded);
		return loaded;
	};
}

async function loadOwnedGroups(env: AppEnv, userId: string, worldId: string): Promise<OwnedGroup[]> {
	const result = await env.BICKR_D1.prepare(
		`SELECT g.group_id AS groupId, g.custom_title AS customTitle, m.bot_id AS botId
		 FROM bot_groups g
		 LEFT JOIN bot_group_members m ON m.group_id = g.group_id AND m.world_id = g.world_id
		 WHERE g.world_id = ? AND g.owner_user_id = ? AND g.deleted_at IS NULL
		 ORDER BY g.created_at ASC, g.group_id ASC`,
	)
		.bind(worldId, userId)
		.all<{ groupId: string; customTitle: string | null; botId: string | null }>();
	const groups = new Map<string, OwnedGroup>();
	for (const row of result.results ?? []) {
		const group = groups.get(row.groupId) ?? { id: row.groupId, customTitle: row.customTitle, botIds: [] };
		if (row.botId) {
			group.botIds.push(row.botId);
		}
		groups.set(row.groupId, group);
	}
	return [...groups.values()];
}

/** One world lookup per handle, however many references name that world. */
function worldLookup(env: AppEnv): (worldHandle: string) => Promise<string> {
	const byHandle = new Map<string, Promise<string>>();
	return (worldHandle) => {
		const pending = byHandle.get(worldHandle);
		if (pending) {
			return pending;
		}
		const loaded = worldByHandle(env.BICKR_D1, worldHandle).then((world) => world.id);
		byHandle.set(worldHandle, loaded);
		return loaded;
	};
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
		 WHERE home_world_handle = ? AND handle = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
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
		 WHERE handle = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
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
		 WHERE bot_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
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

/**
 * A reference that names more than one thing is the owner's to disambiguate, so
 * the candidates travel with the error rather than being described in prose.
 */
export class AmbiguousRefError extends Error {
	readonly references: string[];

	constructor(message: string, references: string[]) {
		super(message);
		this.name = "AmbiguousRefError";
		this.references = references;
	}
}

/** Shared by every route that expands the grammar, so they answer alike. */
export function botTargetErrorResponse(error: unknown): Response {
	if (error instanceof AmbiguousRefError) {
		return fail("conflict", error.message, 409, { references: error.references });
	}
	return pageErrorResponse(error);
}
