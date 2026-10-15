import { accountExportSections, type AccountExportPage, type AccountExportSection, type AccountExportImageReference } from "./account-export";
import { loadOwnerInferenceConfigurationPaths } from "./inference-configuration-repository";
import { inferenceConfigurationFields } from "./inference-configuration-owner";
import { ownerInferenceConfigurationOverrides, parseStoredInferenceConfigurationOverrides, resolveInferenceConfiguration, type BickrInferenceDefaults } from "./inference-configuration";
import type { AvatarImage, BotDocument, BotInferenceSettings, ForumDocument, JsonObject, ThreadDocument, UserDocument, WorldDocument } from "./model";
import { decodeOpaqueJsonCursor, encodeOpaqueJsonCursor } from "./opaque-json-cursor";
import { effectiveBotDocuments, RepositoryError } from "./repository";
import { kvKeys, readJson, type D1DatabaseLike, type KVNamespaceLike } from "./storage";

const pageSize = 10;
const missingRecord = () => new RepositoryError("conflict", "Export data changed or is unavailable. Please retry the export.", 409);
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
	return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) as Pick<T, K>;
}
const entityKeys = ["id", "type", "schemaVersion", "revision", "createdAt", "updatedAt"] as const;

/** URLs are configuration, but embedded credentials and signed query strings are not. */
function publicUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		url.username = ""; url.password = ""; url.search = ""; url.hash = "";
		return url.href;
	} catch { return undefined; }
}
function avatar(value: AvatarImage | undefined) {
	if (!value) return undefined;
	return {
		...pick(value, ["key", "contentType", "byteLength", "width", "height", "crop", "updatedAt"]),
		url: publicUrl(value.url),
		...(value.source?.type === "generated" ? { source: pick(value.source, ["type", "model", "generatedAt", "cost", "prompt"]) } : {}),
	};
}
/** Provider routing accepts arbitrary JSON at input. Export only documented, non-secret preferences. */
function routing(value: JsonObject | undefined): JsonObject | undefined {
	if (!value) return undefined;
	const result: JsonObject = {};
	for (const key of ["order", "only", "ignore", "quantizations"]) {
		const item = value[key];
		if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) result[key] = item;
	}
	for (const key of ["allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text"]) {
		if (typeof value[key] === "boolean") result[key] = value[key];
	}
	for (const key of ["data_collection", "sort"]) if (typeof value[key] === "string") result[key] = value[key];
	const sort = value.sort;
	if (sort && typeof sort === "object" && !Array.isArray(sort)) {
		result.sort = Object.fromEntries(["by", "partition"].flatMap((name) => typeof sort[name] === "string" ? [[name, sort[name]]] : []));
	}
	for (const key of ["preferred_min_throughput", "preferred_max_latency"]) {
		const item = value[key];
		if (typeof item === "number") result[key] = item;
		else if (item && typeof item === "object" && !Array.isArray(item)) {
			result[key] = Object.fromEntries(["p50", "p75", "p90", "p99"].flatMap((name) => typeof item[name] === "number" ? [[name, item[name]]] : []));
		}
	}
	const prices = value.max_price;
	if (prices && typeof prices === "object" && !Array.isArray(prices)) {
		result.max_price = Object.fromEntries(["prompt", "completion", "request", "image", "web_search", "internal_reasoning"].flatMap((key) =>
			typeof prices[key] === "number" ? [[key, prices[key]]] : []));
	}
	return result;
}
const samplingKeys = ["model", "temperature", "topK", "topP", "minP", "frequencyPenalty", "presencePenalty", "repetitionPenalty"] as const;
export function exportInferenceSettings(value: BotInferenceSettings | undefined) {
	value ??= {};
	return {
		...pick(value, [...samplingKeys, "compactionMode", "promptCacheMode", "cacheFriendlyCompaction", "recurringPromptEnabled", "recurringPrompt", "supportsPrefill", "reasoningEffort", "toolCalls"]),
		baseUrl: publicUrl(value.baseUrl), providerRouting: routing(value.providerRouting),
		...(value.imageGeneration ? { imageGeneration: {
			...pick(value.imageGeneration, [...samplingKeys, "prompt", "aspectRatio", "imageSize"]),
			providerRouting: routing(value.imageGeneration.providerRouting),
		} } : {}),
		...(value.translation ? { translation: {
			...pick(value.translation, [...samplingKeys, "enabled", "prompt", "reasoningEffort", "toolCalls"]),
			providerRouting: routing(value.translation.providerRouting),
		} } : {}),
	};
}
export function exportBotDefinition(bot: BotDocument) {
	const local = bot.localOverrides;
	return {
		...pick(bot, [...entityKeys, "homeWorldId", "homeWorldHandle", "ownerUserId", "handle", "language", "instructionLanguage", "includeLanguageInSystemPrompt", "displayName", "shortBio", "prompt", "toolSettings", "postingSettings", "tickSettings"]),
		avatar: avatar(bot.avatar), inferenceSettings: exportInferenceSettings(bot.inferenceSettings),
		...(bot.importSource ? { importSource: pick(bot.importSource, ["provider", "originalHandle", "importedAt"]) } : {}),
		...(bot.cloneSource ? { cloneSource: pick(bot.cloneSource, ["sourceBotId", "sourceWorldId", "sourceWorldHandle", "sourceHandle", "clonedAt", "linked", "unlinkedAt", "relinkedAt"]) } : {}),
		...(local ? { localOverrides: {
			...pick(local, ["instructionLanguage", "language", "includeLanguageInSystemPrompt", "displayName", "shortBio", "prompt", "hasAvatar"]),
			avatar: avatar(local.avatar), inferenceSettings: exportInferenceSettings(local.inferenceSettings),
		} } : {}),
	};
}

function imageReferences(kind: AccountExportImageReference["kind"], entityId: string, image: AvatarImage | undefined, slot: AccountExportImageReference["slot"] = "avatar"): AccountExportImageReference[] {
	return image?.key ? [{ kind, entityId, slot, key: image.key, url: publicUrl(image.url) }] : [];
}

export function parseAccountExportSection(value: string | null): AccountExportSection {
	if (!accountExportSections.some((section) => section === value)) throw new RepositoryError("bad_request", "Unknown export section.", 400);
	return value as AccountExportSection;
}
function position(cursor: string | null, ownerUserId: string, section: AccountExportSection): string {
	if (!cursor) return "";
	let decoded: unknown;
	try { decoded = decodeOpaqueJsonCursor(cursor); } catch { throw new RepositoryError("bad_request", "Invalid export cursor.", 400); }
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new RepositoryError("bad_request", "Invalid export cursor.", 400);
	const record = decoded as Record<string, unknown>;
	if (!decoded || record.ownerUserId !== ownerUserId || record.section !== section || typeof record.position !== "string") {
		throw new RepositoryError("bad_request", "Invalid export cursor.", 400);
	}
	return record.position;
}
function page(ownerUserId: string, section: AccountExportSection, rows: { position: string; record: object }[]): AccountExportPage {
	const selected = rows.slice(0, pageSize);
	return {
		kind: "account_export_page", ownerUserId, section, records: selected.map((row) => row.record), imageReferences: [],
		nextCursor: rows.length > pageSize ? encodeOpaqueJsonCursor({ ownerUserId, section, position: selected.at(-1)!.position }) : null,
	};
}
type IndexedDocument = UserDocument | WorldDocument | ForumDocument | BotDocument | ThreadDocument;
async function requiredDocument<T extends IndexedDocument>(kv: KVNamespaceLike, key: string): Promise<T> {
	const document = await readJson<T>(kv, key);
	if (!document || document.deletedAt) throw missingRecord();
	return document;
}

/** Each request reads one bounded owner-scoped page. It never traverses the global KV namespace. */
export async function accountExportPage(
	kv: KVNamespaceLike, db: D1DatabaseLike, user: UserDocument,
	section: AccountExportSection, cursor: string | null, defaults?: BickrInferenceDefaults,
): Promise<AccountExportPage> {
	const after = position(cursor, user.id, section);
	if (section === "profile") {
		const translation = await db.prepare(`SELECT configuration_id AS configurationId, selected_kind AS selectedKind, revision, updated_at AS updatedAt
			FROM inference_translation_selections WHERE owner_user_id = ? LIMIT 1`).bind(user.id).first();
		return { kind: "account_export_page", ownerUserId: user.id, section, nextCursor: null, imageReferences: imageReferences("user", user.id, user.avatar), records: [{
			...pick(user, [...entityKeys, "handle", "language", "uiLocale", "displayName", "profileCompletedAt"]),
			inferenceDefaults: defaults ? { baseUrl: publicUrl(defaults.fields.baseUrl), model: defaults.fields.model, temperature: defaults.fields.temperature } : undefined,
			avatar: avatar(user.avatar), inferenceSettings: exportInferenceSettings(user.inferenceSettings), translationSelection: translation,
		}] };
	}
	if (section === "worlds" || section === "forums" || section === "bots") {
		const selection = {
			worlds: { table: "worlds_index", id: "world_id", owner: "created_by_user_id", key: kvKeys.world },
			forums: { table: "forums_index", id: "forum_id", owner: "created_by_user_id", key: kvKeys.forum },
			bots: { table: "bots_index", id: "bot_id", owner: "owner_user_id", key: kvKeys.bot },
		}[section];
		const result = await db.prepare(`SELECT ${selection.id} AS id FROM ${selection.table}
			WHERE ${selection.owner} = ? AND deleted_at IS NULL ${section === "forums" ? "" : "AND lifecycle_state = 'active'"} AND ${selection.id} > ?
			ORDER BY ${selection.id} LIMIT ?`).bind(user.id, after, pageSize + 1).all<{ id: string }>();
		const rows: { position: string; record: object }[] = [];
		const images: AccountExportImageReference[] = [];
		const rawBots: BotDocument[] = [];
		for (const row of result.results ?? []) {
			// Recheck ownership in the document too: a stale projection must never broaden the export.
			if (section === "worlds") {
				const world = await requiredDocument<WorldDocument>(kv, selection.key(row.id));
				if (world.createdByUserId !== user.id) throw missingRecord();
				images.push(...imageReferences("world", world.id, world.avatar));
				rows.push({ position: row.id, record: {
					...pick(world, [...entityKeys, "handle", "language", "name", "description", "prompt", "recurringPromptEnabled", "recurringPrompt", "initialBotNotification", "postingSettings", "threadSettings", "createdByUserId", "visibility"]),
					avatar: avatar(world.avatar), imageGeneration: world.imageGeneration ? exportInferenceSettings({ imageGeneration: world.imageGeneration }).imageGeneration : undefined,
				} });
			} else if (section === "forums") {
				const forum = await requiredDocument<ForumDocument>(kv, selection.key(row.id));
				if (forum.createdByUserId !== user.id) throw missingRecord();
				rows.push({ position: row.id, record: pick(forum, [...entityKeys, "worldId", "worldHandle", "handle", "language", "description", "createdByUserId", "personalBotId", "threadSettings", "readOnly"]) });
			} else {
				const bot = await requiredDocument<BotDocument>(kv, selection.key(row.id));
				if (bot.ownerUserId !== user.id) throw missingRecord();
				rawBots.push(bot);
				rows.push({ position: row.id, record: exportBotDefinition(bot) });
			}
		}
		if (rawBots.length) {
			const effective = await effectiveBotDocuments(kv, db, rawBots);
			for (const bot of effective) {
				const row = rows.find((entry) => entry.position === bot.id)!;
				const definition = exportBotDefinition(bot);
				row.record = { ...row.record, effectiveProfile: definition };
				images.push(...imageReferences("bot", bot.id, bot.avatar));
				const stored = rawBots.find((raw) => raw.id === bot.id)!;
				if (stored.avatar?.key && stored.avatar.key !== bot.avatar?.key) images.push(...imageReferences("bot", bot.id, stored.avatar, "storedAvatar"));
				images.push(...imageReferences("bot", bot.id, bot.localOverrides?.avatar, "localAvatar"));
			}
		}
		const resultPage = page(user.id, section, rows);
		return { ...resultPage, imageReferences: images.filter((image) => (result.results ?? []).slice(0, pageSize).some((row) => row.id === image.entityId)) };
	}
	if (section === "inferenceConfigurations") {
		// Select credential modes only. Never retrieve secret values or serialize an internal resolver result.
		const result = await db.prepare(`SELECT c.configuration_id AS id, c.kind, c.fixed_role AS fixedRole, c.parent_id AS parentId,
			c.world_id AS worldId, c.bot_id AS botId, c.custom_name AS customName, c.overrides_json AS overridesJson,
			c.revision, c.created_at AS createdAt, c.updated_at AS updatedAt, credentials.mode AS credentialMode FROM inference_configurations c
			JOIN inference_configuration_credentials credentials ON credentials.configuration_id = c.configuration_id AND credentials.owner_user_id = c.owner_user_id
			WHERE c.owner_user_id = ? AND c.configuration_id > ? ORDER BY c.configuration_id LIMIT ?`)
			.bind(user.id, after, pageSize + 1).all<{
				id: string; credentialMode: string; kind: string; fixedRole: string | null; parentId: string | null; worldId: string | null;
				botId: string | null; customName: string | null; overridesJson: string; revision: number; createdAt: string; updatedAt: string;
			}>();
		const rows = result.results ?? [];
		const paths = await loadOwnerInferenceConfigurationPaths(db, user.id, rows.map((row) => row.id));
		return page(user.id, section, rows.map(({ overridesJson, ...row }) => {
			const overrides = ownerInferenceConfigurationOverrides(parseStoredInferenceConfigurationOverrides(overridesJson));
			const safe = Object.fromEntries(inferenceConfigurationFields.flatMap((field): [string, unknown][] => {
				const override = overrides[field];
				if (!override) return [];
				if (override.kind === "value" && field === "baseUrl") return [[field, { kind: "value", value: publicUrl(String(override.value)) }]];
				if (override.kind === "value" && (field === "providerRouting" || field === "imageProviderRouting")) return [[field, { kind: "value", value: routing(override.value as JsonObject) }]];
				return [[field, override]];
			}));
			const path = paths.get(row.id);
			if (!path) throw missingRecord();
			const resolution = resolveInferenceConfiguration(path, { defaults });
			return { position: row.id, record: { ...row, overrides: safe, effectiveModel: resolution.effective.model } };
		}));
	}
	if (section === "threads" || section === "comments") return contentPage(kv, db, user.id, section, after);
	if (section === "notes") {
		// The web route retrieves each selected participant's private notes from its runtime.
		const result = await db.prepare(`SELECT bot_id AS id FROM bots_index WHERE owner_user_id = ?
			AND deleted_at IS NULL AND lifecycle_state = 'active' AND bot_id > ? ORDER BY bot_id LIMIT ?`)
			.bind(user.id, after, pageSize + 1).all<{ id: string }>();
		return page(user.id, section, (result.results ?? []).map((row) => ({ position: row.id, record: { botId: row.id } })));
	}
	return relationalPage(db, user.id, section, after);
}

function tuplePosition(value: string, length: number): string[] {
	if (!value) return Array<string>(length).fill("");
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.length === length && parsed.every((part) => typeof part === "string")) return parsed;
	} catch { /* The cursor is data, never SQL. */ }
	throw new RepositoryError("bad_request", "Invalid export position.", 400);
}

async function contentPage(kv: KVNamespaceLike, db: D1DatabaseLike, owner: string, section: "threads" | "comments", after: string) {
	const threadMode = section === "threads";
	const [botAfter, itemAfter] = tuplePosition(after, 2);
	const result = await db.prepare(threadMode
		? `SELECT t.thread_id AS id, t.thread_id AS threadId, t.author_bot_id AS authorBotId FROM bots_index b
			JOIN threads_index t ON t.author_bot_id = b.bot_id
			WHERE b.owner_user_id = ? AND b.deleted_at IS NULL AND b.lifecycle_state = 'active' AND t.deleted_at IS NULL AND (b.bot_id, t.thread_id) > (?, ?)
			ORDER BY b.bot_id, t.thread_id LIMIT ?`
		: `SELECT c.comment_id AS id, c.thread_id AS threadId, c.author_bot_id AS authorBotId FROM bots_index b
			JOIN comments_index c ON c.author_bot_id = b.bot_id JOIN threads_index t ON t.thread_id = c.thread_id
			WHERE b.owner_user_id = ? AND b.deleted_at IS NULL AND b.lifecycle_state = 'active'
			AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND (b.bot_id, c.comment_id) > (?, ?) ORDER BY b.bot_id, c.comment_id LIMIT ?`)
		.bind(owner, botAfter, itemAfter, pageSize + 1).all<{ id: string; threadId: string; authorBotId: string }>();
	const rows: { position: string; record: object }[] = [];
	const authors = new Map<string, BotDocument>();
	// Fetch one thread at a time; keep only the selected author's text, never other participants' replies.
	for (const row of result.results ?? []) {
		let author = authors.get(row.authorBotId);
		if (!author) {
			author = await requiredDocument<BotDocument>(kv, kvKeys.bot(row.authorBotId));
			if (author.ownerUserId !== owner) throw missingRecord();
			authors.set(row.authorBotId, author);
		}
		const thread = await requiredDocument<ThreadDocument>(kv, kvKeys.thread(row.threadId));
		const root = thread.comments.find((comment) => comment.id === thread.rootCommentId);
		if (threadMode && (!root || root.authorBotId !== author.id || root.deletedAt)) throw missingRecord();
		if (threadMode) rows.push({ position: JSON.stringify([row.authorBotId, row.id]), record: {
			...pick(thread, [...entityKeys, "worldId", "worldHandle", "forumId", "forumHandle", "title", "rootCommentId"]),
			url: publicUrl(thread.url), authorBotId: row.authorBotId,
		} });
		else {
			const comment = thread.comments.find((item) => item.id === row.id);
			if (!comment || comment.deletedAt || comment.authorBotId !== row.authorBotId) throw missingRecord();
			rows.push({ position: JSON.stringify([row.authorBotId, row.id]), record: pick(comment, ["id", "threadId", "worldId", "forumId", "authorBotId", "authorHandle", "authorDisplayName", "parentCommentId", "body", "createdAt", "updatedAt"]) });
		}
	}
	return page(owner, section, rows);
}

async function relationalPage(db: D1DatabaseLike, owner: string, section: "groups" | "groupMembers" | "subscriptions" | "votes" | "follows", after: string) {
	const tuple = section === "groups" || section === "subscriptions" ? [after] : tuplePosition(after, section === "votes" ? 3 : 2);
	const sql = {
		groups: `SELECT group_id AS position, group_id AS id, world_id AS worldId, custom_title AS customTitle, created_at AS createdAt, updated_at AS updatedAt
			FROM bot_groups WHERE owner_user_id = ? AND deleted_at IS NULL AND group_id > ? ORDER BY group_id LIMIT ?`,
		groupMembers: `SELECT m.group_id AS groupId, m.bot_id AS botId, m.added_at AS addedAt
			FROM bot_groups g JOIN bot_group_members m ON m.group_id = g.group_id
			JOIN bots_index b ON b.bot_id = m.bot_id AND b.owner_user_id = g.owner_user_id
			WHERE g.owner_user_id = ? AND g.deleted_at IS NULL AND b.deleted_at IS NULL AND b.lifecycle_state = 'active'
			AND (g.group_id, m.bot_id) > (?, ?) ORDER BY g.group_id, m.bot_id LIMIT ?`,
		subscriptions: `SELECT subscription_id AS position, subscription_id AS id, world_id AS worldId, scope_type AS scopeType, scope_id AS scopeId,
			active, auto_created AS autoCreated, created_at AS createdAt, updated_at AS updatedAt
			FROM human_subscriptions WHERE user_id = ? AND subscription_id > ? ORDER BY subscription_id LIMIT ?`,
		votes: `SELECT v.bot_id AS botId, v.world_id AS worldId,
			v.target_type AS targetType, v.target_id AS targetId, v.value, v.created_at AS createdAt, v.updated_at AS updatedAt
			FROM bots_index b JOIN votes v ON v.bot_id = b.bot_id WHERE b.owner_user_id = ? AND b.deleted_at IS NULL AND b.lifecycle_state = 'active'
			AND (b.bot_id, v.target_type, v.target_id) > (?, ?, ?) ORDER BY b.bot_id, v.target_type, v.target_id LIMIT ?`,
		follows: `SELECT f.follower_bot_id AS followerBotId,
			f.followed_bot_id AS followedBotId, f.world_id AS worldId, f.created_at AS createdAt
			FROM bots_index b JOIN follows f ON f.follower_bot_id = b.bot_id WHERE b.owner_user_id = ? AND b.deleted_at IS NULL AND b.lifecycle_state = 'active'
			AND (b.bot_id, f.followed_bot_id) > (?, ?) ORDER BY b.bot_id, f.followed_bot_id LIMIT ?`,
	}[section];
	const result = await db.prepare(sql).bind(owner, ...tuple, pageSize + 1).all<{ position?: string } & Record<string, unknown>>();
	return page(owner, section, (result.results ?? []).map(({ position: key, ...record }) => ({
		position: key ?? JSON.stringify(section === "votes" ? [record.botId, record.targetType, record.targetId]
			: section === "follows" ? [record.followerBotId, record.followedBotId] : [record.groupId, record.botId]), record,
	})));
}
