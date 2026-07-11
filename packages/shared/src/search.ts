import { isCloudflareRateLimitError, retryCloudflareOperation } from "./cloudflare";
import {
	avatarCropFromJson,
	localizedTextFromStored,
	localizedTextString,
	type BotSummary,
	type AvatarCrop,
	type ForumSummary,
	type SearchEntityType,
	type SearchMode,
	type SearchResponse,
	type SearchResult,
	type SearchResultSource,
	type WorldSummary,
	type LocalizedText,
} from "./model";
import {
	deleteKey,
	type D1DatabaseLike,
	type D1Result,
	kvKeys,
	type KVNamespaceLike,
	readJson,
	writeJson,
} from "./storage";
import { runBoundedSweep } from "./sweep";
import { InputError, normalizeHandle } from "./validation";

const searchPageSize = 20;
const searchSuggestionLimit = 8;
const searchEmbeddingModel = "@cf/google/embeddinggemma-300m";

const searchVectorTimeoutMs = 10_000;
const searchVectorRetryMaxAttempts = 3;
const searchVectorRetryInitialDelayMs = 1_100;
const searchVectorRetryMaxDelayMs = 8_000;
const searchVectorDeleteBatchSize = 100;
const searchVectorReindexBatchSize = 20;
const searchVectorReindexMaxItemsPerRun = 250;
const searchTypes = ["world", "forum", "bot"] as const satisfies readonly SearchEntityType[];

type SearchFilters = {
	forumHandle?: string;
	usernameHandle?: string;
	worldHandle?: string;
};

export type SearchQueryOptions = SearchFilters & {
	mode: SearchMode;
	page?: number;
	query: string;
	types?: readonly SearchEntityType[];
};

export type SearchSuggestionOptions = {
	limit?: number;
	query: string;
};

type SearchIndexEntity = {
	deletedAt?: string;
	description?: LocalizedText | string;
	displayName?: LocalizedText | string;
	handle: string;
	id: string;
	name?: LocalizedText | string;
	personalBotId?: string;
	shortBio?: LocalizedText | string;
	type: SearchEntityType;
	updatedAt: string;
	worldHandle?: string;
	worldId?: string;
};

type SearchSqlRow = {
	botDisplayName: string | null;
	botDisplayNameLang: string | null;
	botHandle: string | null;
	botId: string | null;
	botShortBio: string | null;
	botShortBioLang: string | null;
	botAvatarUrl: string | null;
	botAvatarCrop: string | null;
	forumDescription: string | null;
	forumDescriptionLang: string | null;
	forumHandle: string | null;
	forumId: string | null;
	forumPersonalBotId: string | null;
	id: string;
	score: number | null;
	total: number;
	type: SearchEntityType;
	worldDescription: string;
	worldDescriptionLang: string | null;
	worldHandle: string;
	worldId: string;
	worldName: string;
	worldNameLang: string | null;
};

type SearchVectorMatch = {
	id: string;
	metadata?: unknown;
	score: number;
};

type SearchVectorMatches = {
	matches: SearchVectorMatch[];
};

type FtsExpressionOptions = {
	prefixFinalTerm?: boolean;
};

function searchBotAvatarFields(avatarUrl: string | null | undefined, avatarCrop: string | null | undefined): { avatarUrl?: string; avatarCrop?: AvatarCrop } {
	const crop = avatarCropFromJson(avatarCrop);
	return {
		...(avatarUrl ? { avatarUrl } : {}),
		...(crop ? { avatarCrop: crop } : {}),
	};
}

type SearchVectorizeIndexLike = {
	deleteByIds(ids: string[]): Promise<unknown>;
	query(vector: number[], options?: {
		filter?: Record<string, unknown>;
		returnMetadata?: boolean | "all" | "indexed" | "none";
		returnValues?: boolean;
		topK?: number;
	}): Promise<SearchVectorMatches>;
	upsert(vectors: Array<{ id: string; metadata?: Record<string, string | number | boolean>; values: number[] }>): Promise<unknown>;
};

type SearchAiLike = {
	run(model: typeof searchEmbeddingModel, input: { text: string[] }): Promise<{ data?: number[][]; shape?: number[] }>;
};

export type SearchVectorEnv = {
	AI?: SearchAiLike;
	BICKR_SEARCH_VECTORIZE?: SearchVectorizeIndexLike;
};

export type SearchVectorReindexEnv = SearchVectorEnv & {
	BICKR_KV: KVNamespaceLike;
};

export type SearchVectorReindexResult = {
	attempted: number;
	budgetExhausted: boolean;
	done: boolean;
};

type SearchVectorReindexCursor = {
	afterKey: string;
};

type SearchVectorReindexRow = {
	cursorKey: string;
	description: string | null;
	descriptionLang: string | null;
	displayName: string | null;
	displayNameLang: string | null;
	handle: string;
	id: string;
	name: string | null;
	nameLang: string | null;
	personalBotId: string | null;
	shortBio: string | null;
	shortBioLang: string | null;
	type: SearchEntityType;
	worldHandle: string | null;
	worldId: string | null;
};

type SemanticCandidate = {
	id: string;
	order: number;
	score: number;
	type: SearchEntityType;
};

type SearchVectorEntity =
	| { type: "world"; world: Pick<WorldSummary, "description" | "handle" | "id" | "name"> }
	| { type: "forum"; forum: Pick<ForumSummary, "description" | "handle" | "id" | "worldHandle" | "worldId"> }
	| { type: "bot"; bot: Pick<BotSummary, "displayName" | "handle" | "homeWorldHandle" | "homeWorldId" | "id" | "shortBio"> };

export function parseSearchMode(value: string | null | undefined): SearchMode {
	if (value === "fts" || value === "semantic" || value === "substring") {
		return value;
	}
	return "fts";
}

export function parseSearchTypes(value: string | null | undefined): SearchEntityType[] {
	if (!value?.trim()) {
		return [...searchTypes];
	}
	const parsed = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const types: SearchEntityType[] = [];
	for (const type of parsed) {
		if (!isSearchEntityType(type)) {
			throw new InputError(`Unknown search result type: ${type}.`);
		}
		if (!types.includes(type)) {
			types.push(type);
		}
	}
	return types.length > 0 ? types : [...searchTypes];
}

export function normalizeSearchFilters(input: {
	forum?: string | null;
	username?: string | null;
	world?: string | null;
}): SearchFilters {
	return {
		...(input.forum?.trim() ? { forumHandle: normalizePrefixedHandle(input.forum, ["f/"]) } : {}),
		...(input.username?.trim() ? { usernameHandle: normalizePrefixedHandle(input.username, ["u/", "@"]) } : {}),
		...(input.world?.trim() ? { worldHandle: normalizePrefixedHandle(input.world, ["w/"]) } : {}),
	};
}

export function boundedSearchPage(value: string | number | null | undefined): number {
	const parsed = Number(value ?? 1);
	return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
}

export async function searchSuggestions(
	db: D1DatabaseLike,
	options: SearchSuggestionOptions,
): Promise<SearchResponse> {
	return searchEntitiesTextInternal(db, {
		mode: "fts",
		page: 1,
		query: options.query,
		types: searchTypes,
	}, Math.max(1, Math.min(20, Math.floor(options.limit ?? searchSuggestionLimit))), { prefixFinalTerm: true });
}

export async function searchEntitiesText(
	db: D1DatabaseLike,
	options: SearchQueryOptions,
	overrideLimit?: number,
): Promise<SearchResponse> {
	return searchEntitiesTextInternal(db, options, overrideLimit, {});
}

async function searchEntitiesTextInternal(
	db: D1DatabaseLike,
	options: SearchQueryOptions,
	overrideLimit: number | undefined,
	ftsOptions: FtsExpressionOptions,
): Promise<SearchResponse> {
	const page = boundedSearchPage(options.page);
	const types = normalizeSearchTypes(options.types);
	const limit = overrideLimit ?? searchPageSize;
	const query = options.mode === "fts" ? normalizeSearchText(options.query) : normalizeSearchQuery(options.query);
	if (!query || types.length === 0) {
		return emptySearchResponse(options.query, page, limit);
	}

	if (options.mode === "fts") {
		const ftsQuery = ftsExpressionFromUserSearch(query, ftsOptions);
		if (!ftsQuery) {
			return emptySearchResponse(query, page, limit);
		}
		return ftsSearchEntities(db, { ...options, page, query, types }, ftsQuery, limit);
	}
	return substringSearchEntities(db, { ...options, mode: "substring", page, query, types }, limit);
}

export async function searchEntitiesSemantic(
	db: D1DatabaseLike,
	env: SearchVectorEnv,
	options: SearchQueryOptions,
): Promise<SearchResponse> {
	const page = boundedSearchPage(options.page);
	const types = normalizeSearchTypes(options.types);
	const query = normalizeSearchText(options.query);
	if (!query || types.length === 0) {
		return emptySearchResponse(options.query, page, searchPageSize);
	}

	const vectorIndex = env.BICKR_SEARCH_VECTORIZE;
	if (!env.AI || !vectorIndex) {
		return emptySearchResponse(options.query, page, searchPageSize);
	}

	const vector = await embedSearchText(env.AI, query);
	if (!vector) {
		return emptySearchResponse(options.query, page, searchPageSize);
	}

	const requested = new Set(types);
	const matches = await retrySearchBinding("Search vector query", () =>
		withSearchBindingTimeout("Search vector query", () =>
			vectorIndex.query(vector, {
				topK: Math.max(searchPageSize, Math.min(50, page * searchPageSize + searchPageSize)),
				returnMetadata: "all",
			}),
		),
	);
	const candidates = vectorMatchesToCandidates(matches.matches)
		.filter((candidate) => requested.has(candidate.type));
	const rows = await hydrateSemanticCandidates(db, candidates, options);
	const byKey = new Map(candidates.map((candidate) => [searchEntityKey(candidate.type, candidate.id), candidate]));
	const sorted = rows
		.map((row) => {
			const candidate = byKey.get(searchEntityKey(row.type, row.id));
			return {
				row,
				score: candidate?.score ?? 0,
				order: candidate?.order ?? Number.MAX_SAFE_INTEGER,
			};
		})
		.sort((left, right) => (right.score - left.score) || (left.order - right.order));
	const total = sorted.length;
	const offset = (page - 1) * searchPageSize;
	const results = sorted
		.slice(offset, offset + searchPageSize)
		.map((item, index) => searchResultFromRow({ ...item.row, score: item.score, total }, "semantic", offset + index + 1));

	return {
		hasNextPage: offset + searchPageSize < total,
		page,
		pageSize: searchPageSize,
		query: options.query,
		results,
		total,
	};
}

export async function upsertWorldSearchIndex(
	db: D1DatabaseLike,
	world: Pick<WorldSummary, "description" | "handle" | "id" | "name" | "updatedAt"> & { deletedAt?: string },
): Promise<void> {
	await replaceSearchIndexEntity(db, {
		...world,
		type: "world",
	});
}

export async function upsertForumSearchIndex(
	db: D1DatabaseLike,
	forum: Pick<ForumSummary, "description" | "handle" | "id" | "personalBotId" | "updatedAt" | "worldHandle" | "worldId"> & { deletedAt?: string },
): Promise<void> {
	await replaceSearchIndexEntity(db, {
		...forum,
		...(forum.personalBotId ? { deletedAt: forum.deletedAt ?? forum.updatedAt } : {}),
		type: "forum",
	});
}

export async function upsertBotSearchIndex(
	db: D1DatabaseLike,
	bot: Pick<BotSummary, "displayName" | "handle" | "homeWorldHandle" | "homeWorldId" | "id" | "shortBio" | "updatedAt"> & { deletedAt?: string },
): Promise<void> {
	await replaceSearchIndexEntity(db, {
		handle: bot.handle,
		id: bot.id,
		shortBio: bot.shortBio,
		displayName: bot.displayName,
		type: "bot",
		updatedAt: bot.updatedAt,
		worldHandle: bot.homeWorldHandle,
		worldId: bot.homeWorldId,
		...(bot.deletedAt ? { deletedAt: bot.deletedAt } : {}),
	});
}

export async function upsertWorldSearchVector(env: SearchVectorEnv, world: Pick<WorldSummary, "description" | "handle" | "id" | "name">): Promise<void> {
	await upsertSearchVector(env, { type: "world", world });
}

export async function upsertForumSearchVector(
	env: SearchVectorEnv,
	forum: Pick<ForumSummary, "description" | "handle" | "id" | "worldHandle" | "worldId"> & { personalBotId?: string },
): Promise<void> {
	if (forum.personalBotId) {
		await deleteSearchVector(env, "forum", forum.id);
		return;
	}
	await upsertSearchVector(env, { type: "forum", forum });
}

export async function upsertBotSearchVector(env: SearchVectorEnv, bot: Pick<BotSummary, "displayName" | "handle" | "homeWorldHandle" | "homeWorldId" | "id" | "shortBio">): Promise<void> {
	await upsertSearchVector(env, { type: "bot", bot });
}

export async function deleteSearchVector(env: SearchVectorEnv, type: SearchEntityType, id: string): Promise<void> {
	await deleteSearchVectors(env, [{ id, type }]);
}

async function deleteSearchVectors(
	env: SearchVectorEnv,
	entities: Array<{ id: string; type: SearchEntityType }>,
): Promise<void> {
	const vectorIndex = env.BICKR_SEARCH_VECTORIZE;
	if (!vectorIndex || entities.length === 0) {
		return;
	}
	const ids = entities.map((entity) => vectorIdForEntity(entity.type, entity.id));
	try {
		for (let index = 0; index < ids.length; index += searchVectorDeleteBatchSize) {
			const batch = ids.slice(index, index + searchVectorDeleteBatchSize);
			await retrySearchBinding("Search vector delete", () =>
				withSearchBindingTimeout("Search vector delete", () => vectorIndex.deleteByIds(batch)),
			);
		}
	} catch (error) {
		console.warn("search vector delete failed", error);
	}
}

export async function reindexSearchVectors(
	db: D1DatabaseLike,
	env: SearchVectorReindexEnv,
	limit = 100,
): Promise<SearchVectorReindexResult> {
	const boundedLimit = Math.max(1, Math.min(searchVectorReindexMaxItemsPerRun, Math.floor(limit)));
	const cursorKey = kvKeys.searchVectorReindexCursor;
	const storedCursor = await readSearchVectorReindexCursor(env.BICKR_KV, cursorKey);
	let attempted = 0;
	const iteration = await runBoundedSweep<SearchVectorReindexRow, string>({
		chunkSize: searchVectorReindexBatchSize,
		maxItemsPerRun: boundedLimit,
		...(storedCursor ? { initialCursor: storedCursor.afterKey } : {}),
		loadChunk: (cursor, chunkLimit) => loadSearchVectorReindexChunk(db, cursor, chunkLimit),
		processChunk: async (rows) => {
			const entities = rows
				.map(searchVectorEntityFromReindexRow)
				.filter((entity): entity is SearchVectorEntity => entity !== null);
			attempted += entities.length;
			await upsertSearchVectors(env, entities);
			await deleteSearchVectors(env, rows
				.filter((row) => row.type === "forum" && row.personalBotId !== null)
				.map((row) => ({ id: row.id, type: "forum" })));
			return { kind: "continue" };
		},
		checkpoint: (afterKey) => writeJson(
			env.BICKR_KV,
			cursorKey,
			{ afterKey } satisfies SearchVectorReindexCursor,
		),
		complete: () => deleteKey(env.BICKR_KV, cursorKey),
	});
	return {
		attempted,
		budgetExhausted: iteration.budgetExhausted,
		done: !iteration.budgetExhausted,
	};
}

async function loadSearchVectorReindexChunk(
	db: D1DatabaseLike,
	afterKey: string | undefined,
	limit: number,
): Promise<{ items: SearchVectorReindexRow[]; done: boolean; nextCursor?: string }> {
	const result = await db.prepare(
		`SELECT *
		 FROM (
			SELECT
				'0:' || world_id AS cursorKey,
				world_id AS id,
				'world' AS type,
				handle,
				name,
				name_lang AS nameLang,
				description,
				description_lang AS descriptionLang,
				NULL AS worldId,
				NULL AS worldHandle,
				NULL AS personalBotId,
				NULL AS displayName,
				NULL AS displayNameLang,
				NULL AS shortBio,
				NULL AS shortBioLang
			 FROM worlds_index
			 WHERE deleted_at IS NULL
			 UNION ALL
			 SELECT
				'1:' || forum_id AS cursorKey,
				forum_id AS id,
				'forum' AS type,
				handle,
				NULL AS name,
				NULL AS nameLang,
				description,
				description_lang AS descriptionLang,
				world_id AS worldId,
				world_handle AS worldHandle,
				personal_bot_id AS personalBotId,
				NULL AS displayName,
				NULL AS displayNameLang,
				NULL AS shortBio,
				NULL AS shortBioLang
			 FROM forums_index
			 WHERE deleted_at IS NULL
			 UNION ALL
			 SELECT
				'2:' || bot_id AS cursorKey,
				bot_id AS id,
				'bot' AS type,
				handle,
				NULL AS name,
				NULL AS nameLang,
				NULL AS description,
				NULL AS descriptionLang,
				home_world_id AS worldId,
				home_world_handle AS worldHandle,
				NULL AS personalBotId,
				display_name AS displayName,
				display_name_lang AS displayNameLang,
				short_bio AS shortBio,
				short_bio_lang AS shortBioLang
			 FROM bots_index
			 WHERE deleted_at IS NULL
		 )
		 WHERE cursorKey > ?
		 ORDER BY cursorKey ASC
		 LIMIT ?`,
	)
		.bind(afterKey ?? "", limit)
		.all<SearchVectorReindexRow>();
	const items = result.results ?? [];
	const nextCursor = items.at(-1)?.cursorKey;
	return {
		items,
		done: items.length < limit,
		...(nextCursor ? { nextCursor } : {}),
	};
}

function searchVectorEntityFromReindexRow(row: SearchVectorReindexRow): SearchVectorEntity | null {
	if (row.type === "world") {
		return {
			type: "world",
			world: {
				id: row.id,
				handle: row.handle,
				name: localizedTextFromStored({ lang: row.nameLang, text: row.name }),
				description: localizedTextFromStored({ lang: row.descriptionLang, text: row.description }),
			},
		};
	}
	if (row.type === "forum") {
		return row.personalBotId ? null : {
			type: "forum",
			forum: {
				id: row.id,
				worldId: row.worldId ?? "",
				worldHandle: row.worldHandle ?? "",
				handle: row.handle,
				description: localizedTextFromStored({ lang: row.descriptionLang, text: row.description }),
			},
		};
	}
	return {
		type: "bot",
		bot: {
			id: row.id,
			homeWorldId: row.worldId ?? "",
			homeWorldHandle: row.worldHandle ?? "",
			handle: row.handle,
			displayName: localizedTextFromStored({ lang: row.displayNameLang, text: row.displayName }),
			shortBio: localizedTextFromStored({ lang: row.shortBioLang, text: row.shortBio }),
		},
	};
}

async function readSearchVectorReindexCursor(
	kv: KVNamespaceLike,
	key: string,
): Promise<SearchVectorReindexCursor | null> {
	const value = await readJson<unknown>(kv, key);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const afterKey = (value as Record<string, unknown>).afterKey;
	return typeof afterKey === "string" && afterKey.length > 0 ? { afterKey } : null;
}

async function substringSearchEntities(
	db: D1DatabaseLike,
	options: SearchQueryOptions & { mode: "substring"; page: number; query: string; types: readonly SearchEntityType[] },
	limit: number,
): Promise<SearchResponse> {
	const pattern = likePatternForAdvancedSearch(options.query);
	if (!pattern) {
		return emptySearchResponse(options.query, options.page, limit);
	}
	const scoreBinds = searchScoreBinds(options.query);
	const conditions = ["type IN (${typePlaceholders})", "search_text LIKE ? ESCAPE '\\'"];
	const binds: unknown[] = [pattern];
	appendSearchFilters(conditions, binds, options);
	const sql = searchRowsSql({
		source: "substring",
		where: conditions.join(" AND "),
		typeCount: options.types.length,
	});
	const offset = (options.page - 1) * limit;
	const result = await safeSearchQuery(() =>
		db
			.prepare(sql)
			.bind(...scoreBinds, ...options.types, ...binds, limit, offset)
			.all<SearchSqlRow>(),
	);
	return responseFromRows(options.query, options.page, limit, result.results ?? [], "substring");
}

async function ftsSearchEntities(
	db: D1DatabaseLike,
	options: SearchQueryOptions & { page: number; query: string; types: readonly SearchEntityType[] },
	ftsQuery: string,
	limit: number,
): Promise<SearchResponse> {
	const conditions = ["type IN (${typePlaceholders})"];
	const binds: unknown[] = [];
	const scoreBinds = searchScoreBinds(options.query);
	appendSearchFilters(conditions, binds, options);
	const sql = searchRowsSql({
		source: "fts",
		where: conditions.join(" AND "),
		typeCount: options.types.length,
	});
	const offset = (options.page - 1) * limit;
	try {
		const result = await db
			.prepare(sql)
			.bind(ftsQuery, ...scoreBinds, ...options.types, ...binds, limit, offset)
			.all<SearchSqlRow>();
		return responseFromRows(options.query, options.page, limit, result.results ?? [], "fts");
	} catch (error) {
		if (isFtsSyntaxError(error)) {
			// The expression builder quotes user text, but tokenizer-only edge cases can still
			// leave SQLite with no valid phrase. Returning no matches avoids a substring scan.
			return emptySearchResponse(options.query, options.page, limit);
		}
		throw error;
	}
}

function searchRowsSql(input: {
	source: SearchResultSource;
	typeCount: number;
	where: string;
}): string {
	const typePlaceholders = input.typeCount > 0 ? Array.from({ length: input.typeCount }, () => "?").join(", ") : "NULL";
	const where = input.where.replace("${typePlaceholders}", typePlaceholders);
	const candidates =
		input.source === "fts" ?
			`fts_matches AS (
				SELECT entity_type, entity_id, 0 - bm25(search_entities_fts) AS score
				FROM search_entities_fts
				WHERE search_entities_fts MATCH ?
			 ),
			 candidates AS (
				SELECT
					'world' AS type,
					w.world_id AS id,
					w.world_id AS worldId,
					w.handle AS worldHandle,
					w.name AS worldName,
					w.name_lang AS worldNameLang,
					w.description AS worldDescription,
					w.description_lang AS worldDescriptionLang,
					NULL AS forumId,
					NULL AS forumHandle,
					NULL AS forumDescription,
					NULL AS forumDescriptionLang,
					NULL AS forumPersonalBotId,
					NULL AS botId,
					NULL AS botHandle,
					NULL AS botDisplayName,
					NULL AS botDisplayNameLang,
					NULL AS botShortBio,
					NULL AS botShortBioLang,
					NULL AS botAvatarUrl,
					NULL AS botAvatarCrop,
					CASE
						WHEN lower(w.handle) = ? THEN 100
						WHEN lower(w.handle) LIKE ? ESCAPE '\\' THEN 80
						WHEN lower(w.name) LIKE ? ESCAPE '\\' THEN 70
						ELSE 0
					END + fts.score AS score,
					lower(w.handle) AS sortHandle,
					lower(w.name) AS sortName
				 FROM fts_matches fts
				 JOIN worlds_index w ON fts.entity_type = 'world' AND fts.entity_id = w.world_id
				 WHERE w.deleted_at IS NULL
				 UNION ALL
				SELECT
					'forum' AS type,
					f.forum_id AS id,
					w.world_id AS worldId,
					w.handle AS worldHandle,
					w.name AS worldName,
					w.name_lang AS worldNameLang,
					w.description AS worldDescription,
					w.description_lang AS worldDescriptionLang,
					f.forum_id AS forumId,
					f.handle AS forumHandle,
					f.description AS forumDescription,
					f.description_lang AS forumDescriptionLang,
					f.personal_bot_id AS forumPersonalBotId,
					NULL AS botId,
					NULL AS botHandle,
					NULL AS botDisplayName,
					NULL AS botDisplayNameLang,
					NULL AS botShortBio,
					NULL AS botShortBioLang,
					NULL AS botAvatarUrl,
					NULL AS botAvatarCrop,
					CASE
						WHEN lower(f.handle) = ? THEN 100
						WHEN lower(f.handle) LIKE ? ESCAPE '\\' THEN 80
						ELSE 0
					END + fts.score AS score,
					lower(f.handle) AS sortHandle,
					lower(f.description) AS sortName
				 FROM fts_matches fts
				 JOIN forums_index f ON fts.entity_type = 'forum' AND fts.entity_id = f.forum_id
				 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
				 WHERE f.deleted_at IS NULL
				   AND f.personal_bot_id IS NULL
				 UNION ALL
				SELECT
					'bot' AS type,
					b.bot_id AS id,
					w.world_id AS worldId,
					w.handle AS worldHandle,
					w.name AS worldName,
					w.name_lang AS worldNameLang,
					w.description AS worldDescription,
					w.description_lang AS worldDescriptionLang,
					NULL AS forumId,
					NULL AS forumHandle,
					NULL AS forumDescription,
					NULL AS forumDescriptionLang,
					NULL AS forumPersonalBotId,
					b.bot_id AS botId,
					b.handle AS botHandle,
					b.display_name AS botDisplayName,
					b.display_name_lang AS botDisplayNameLang,
					b.short_bio AS botShortBio,
					b.short_bio_lang AS botShortBioLang,
					b.avatar_url AS botAvatarUrl,
					b.avatar_crop AS botAvatarCrop,
					CASE
						WHEN lower(b.handle) = ? THEN 100
						WHEN lower(b.handle) LIKE ? ESCAPE '\\' THEN 80
						WHEN lower(b.display_name) LIKE ? ESCAPE '\\' THEN 70
						ELSE 0
					END + fts.score AS score,
					lower(b.handle) AS sortHandle,
					lower(b.display_name) AS sortName
				 FROM fts_matches fts
				 JOIN bots_index b ON fts.entity_type = 'bot' AND fts.entity_id = b.bot_id
				 JOIN worlds_index w ON w.world_id = b.home_world_id AND w.deleted_at IS NULL
				 WHERE b.deleted_at IS NULL
			 )`
		:	`candidates AS (
				SELECT
					'world' AS type,
					w.world_id AS id,
					w.world_id AS worldId,
					w.handle AS worldHandle,
					w.name AS worldName,
					w.name_lang AS worldNameLang,
					w.description AS worldDescription,
					w.description_lang AS worldDescriptionLang,
					NULL AS forumId,
					NULL AS forumHandle,
					NULL AS forumDescription,
					NULL AS forumDescriptionLang,
					NULL AS forumPersonalBotId,
					NULL AS botId,
					NULL AS botHandle,
					NULL AS botDisplayName,
					NULL AS botDisplayNameLang,
					NULL AS botShortBio,
					NULL AS botShortBioLang,
					NULL AS botAvatarUrl,
					NULL AS botAvatarCrop,
					CASE
						WHEN lower(w.handle) = ? THEN 100
						WHEN lower(w.handle) LIKE ? ESCAPE '\\' THEN 80
						WHEN lower(w.name) LIKE ? ESCAPE '\\' THEN 70
						ELSE 30
					END AS score,
					lower(w.handle || ' ' || w.name || ' ' || w.description) AS search_text,
					lower(w.handle) AS sortHandle,
					lower(w.name) AS sortName
				 FROM worlds_index w
				 WHERE w.deleted_at IS NULL
				 UNION ALL
				SELECT
					'forum' AS type,
					f.forum_id AS id,
					w.world_id AS worldId,
					w.handle AS worldHandle,
					w.name AS worldName,
					w.name_lang AS worldNameLang,
					w.description AS worldDescription,
					w.description_lang AS worldDescriptionLang,
					f.forum_id AS forumId,
					f.handle AS forumHandle,
					f.description AS forumDescription,
					f.description_lang AS forumDescriptionLang,
					f.personal_bot_id AS forumPersonalBotId,
					NULL AS botId,
					NULL AS botHandle,
					NULL AS botDisplayName,
					NULL AS botDisplayNameLang,
					NULL AS botShortBio,
					NULL AS botShortBioLang,
					NULL AS botAvatarUrl,
					NULL AS botAvatarCrop,
					CASE
						WHEN lower(f.handle) = ? THEN 100
						WHEN lower(f.handle) LIKE ? ESCAPE '\\' THEN 80
						ELSE 30
					END AS score,
					lower(f.handle || ' ' || f.description) AS search_text,
					lower(f.handle) AS sortHandle,
					lower(f.description) AS sortName
				 FROM forums_index f
				 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
				 WHERE f.deleted_at IS NULL
				   AND f.personal_bot_id IS NULL
				 UNION ALL
				SELECT
					'bot' AS type,
					b.bot_id AS id,
					w.world_id AS worldId,
					w.handle AS worldHandle,
					w.name AS worldName,
					w.name_lang AS worldNameLang,
					w.description AS worldDescription,
					w.description_lang AS worldDescriptionLang,
					NULL AS forumId,
					NULL AS forumHandle,
					NULL AS forumDescription,
					NULL AS forumDescriptionLang,
					NULL AS forumPersonalBotId,
					b.bot_id AS botId,
					b.handle AS botHandle,
					b.display_name AS botDisplayName,
					b.display_name_lang AS botDisplayNameLang,
					b.short_bio AS botShortBio,
					b.short_bio_lang AS botShortBioLang,
					b.avatar_url AS botAvatarUrl,
					b.avatar_crop AS botAvatarCrop,
					CASE
						WHEN lower(b.handle) = ? THEN 100
						WHEN lower(b.handle) LIKE ? ESCAPE '\\' THEN 80
						WHEN lower(b.display_name) LIKE ? ESCAPE '\\' THEN 70
						ELSE 30
					END AS score,
					lower(b.handle || ' ' || b.display_name || ' ' || b.short_bio) AS search_text,
					lower(b.handle) AS sortHandle,
					lower(b.display_name) AS sortName
				 FROM bots_index b
				 JOIN worlds_index w ON w.world_id = b.home_world_id AND w.deleted_at IS NULL
				 WHERE b.deleted_at IS NULL
			 )`;
	return `WITH ${candidates},
		filtered AS (
			SELECT *
			FROM candidates
			WHERE ${where}
		)
		SELECT
			type,
			id,
			worldId AS worldId,
			worldHandle AS worldHandle,
			worldName AS worldName,
			worldNameLang AS worldNameLang,
			worldDescription AS worldDescription,
			worldDescriptionLang AS worldDescriptionLang,
			forumId AS forumId,
			forumHandle AS forumHandle,
			forumDescription AS forumDescription,
			forumDescriptionLang AS forumDescriptionLang,
			forumPersonalBotId AS forumPersonalBotId,
			botId AS botId,
			botHandle AS botHandle,
			botDisplayName AS botDisplayName,
			botDisplayNameLang AS botDisplayNameLang,
			botShortBio AS botShortBio,
			botShortBioLang AS botShortBioLang,
			botAvatarUrl AS botAvatarUrl,
			botAvatarCrop AS botAvatarCrop,
			score,
			COUNT(*) OVER() AS total
		FROM filtered
		ORDER BY
			score DESC,
			CASE type WHEN 'world' THEN 0 WHEN 'forum' THEN 1 ELSE 2 END,
			worldHandle ASC,
			sortHandle ASC,
			sortName ASC
		LIMIT ? OFFSET ?`;
}

function appendSearchFilters(conditions: string[], binds: unknown[], options: SearchFilters): void {
	if (options.worldHandle) {
		conditions.push("worldHandle = ?");
		binds.push(options.worldHandle);
	}
	if (options.forumHandle) {
		conditions.push(`(
			(type = 'forum' AND forumHandle = ?)
			OR (type = 'world' AND EXISTS (
				SELECT 1 FROM forums_index filter_forum
				WHERE filter_forum.world_id = candidates.worldId
				  AND filter_forum.handle = ?
				  AND filter_forum.personal_bot_id IS NULL
				  AND filter_forum.deleted_at IS NULL
			))
			OR (type = 'bot' AND ${botPostedInForumSql("candidates.botId")})
		)`);
		binds.push(options.forumHandle, options.forumHandle, options.forumHandle, options.forumHandle);
	}
	if (options.usernameHandle) {
		conditions.push(`(
			(type = 'bot' AND botHandle = ?)
			OR (type = 'world' AND EXISTS (
				SELECT 1 FROM bots_index filter_bot
				WHERE filter_bot.home_world_id = candidates.worldId
				  AND filter_bot.handle = ?
				  AND filter_bot.deleted_at IS NULL
			))
			OR (type = 'forum' AND ${forumHasUsernameSql("candidates.forumId")})
		)`);
		binds.push(options.usernameHandle, options.usernameHandle, options.usernameHandle, options.usernameHandle);
	}
}

function botPostedInForumSql(botIdExpression: string): string {
	return `EXISTS (
		SELECT 1
		FROM threads_index filter_thread
		JOIN forums_index filter_forum ON filter_forum.forum_id = filter_thread.forum_id
		WHERE filter_thread.author_bot_id = ${botIdExpression}
		  AND filter_thread.deleted_at IS NULL
		  AND filter_forum.deleted_at IS NULL
		  AND filter_forum.personal_bot_id IS NULL
		  AND filter_forum.handle = ?
		UNION ALL
		SELECT 1
		FROM comments_index filter_comment
		JOIN forums_index filter_forum ON filter_forum.forum_id = filter_comment.forum_id
		WHERE filter_comment.author_bot_id = ${botIdExpression}
		  AND filter_comment.deleted_at IS NULL
		  AND filter_forum.deleted_at IS NULL
		  AND filter_forum.personal_bot_id IS NULL
		  AND filter_forum.handle = ?
	)`;
}

function forumHasUsernameSql(forumIdExpression: string): string {
	return `EXISTS (
		SELECT 1
		FROM threads_index filter_thread
		JOIN bots_index filter_bot ON filter_bot.bot_id = filter_thread.author_bot_id
		WHERE filter_thread.forum_id = ${forumIdExpression}
		  AND filter_thread.deleted_at IS NULL
		  AND filter_bot.deleted_at IS NULL
		  AND filter_bot.handle = ?
		UNION ALL
		SELECT 1
		FROM comments_index filter_comment
		JOIN bots_index filter_bot ON filter_bot.bot_id = filter_comment.author_bot_id
		WHERE filter_comment.forum_id = ${forumIdExpression}
		  AND filter_comment.deleted_at IS NULL
		  AND filter_bot.deleted_at IS NULL
		  AND filter_bot.handle = ?
	)`;
}

async function hydrateSemanticCandidates(
	db: D1DatabaseLike,
	candidates: SemanticCandidate[],
	filters: SearchFilters,
): Promise<SearchSqlRow[]> {
	const byType = new Map<SearchEntityType, SemanticCandidate[]>();
	for (const candidate of candidates) {
		const list = byType.get(candidate.type) ?? [];
		list.push(candidate);
		byType.set(candidate.type, list);
	}
	const rows = await Promise.all(
		searchTypes.map(async (type) => {
			const list = byType.get(type) ?? [];
			if (list.length === 0) {
				return [] as SearchSqlRow[];
			}
			return hydrateSemanticType(db, type, list, filters);
		}),
	);
	return rows.flat();
}

async function hydrateSemanticType(
	db: D1DatabaseLike,
	type: SearchEntityType,
	candidates: SemanticCandidate[],
	filters: SearchFilters,
): Promise<SearchSqlRow[]> {
	const placeholders = candidates.map(() => "?").join(", ");
	const ids = candidates.map((candidate) => candidate.id);
	const conditions: string[] = [];
	const binds: unknown[] = [];
	if (filters.worldHandle) {
		conditions.push("w.handle = ?");
		binds.push(filters.worldHandle);
	}
	if (filters.forumHandle) {
		if (type === "forum") {
			conditions.push("f.handle = ?");
			binds.push(filters.forumHandle);
		} else if (type === "world") {
			conditions.push(`EXISTS (
				SELECT 1 FROM forums_index filter_forum
				WHERE filter_forum.world_id = w.world_id
				  AND filter_forum.handle = ?
				  AND filter_forum.personal_bot_id IS NULL
				  AND filter_forum.deleted_at IS NULL
			)`);
			binds.push(filters.forumHandle);
		} else {
			conditions.push(botPostedInForumSql("b.bot_id"));
			binds.push(filters.forumHandle, filters.forumHandle);
		}
	}
	if (filters.usernameHandle) {
		if (type === "bot") {
			conditions.push("b.handle = ?");
			binds.push(filters.usernameHandle);
		} else if (type === "world") {
			conditions.push(`EXISTS (
				SELECT 1 FROM bots_index filter_bot
				WHERE filter_bot.home_world_id = w.world_id
				  AND filter_bot.handle = ?
				  AND filter_bot.deleted_at IS NULL
			)`);
			binds.push(filters.usernameHandle);
		} else {
			conditions.push(forumHasUsernameSql("f.forum_id"));
			binds.push(filters.usernameHandle, filters.usernameHandle);
		}
	}
	const whereTail = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";
	const sql =
		type === "world" ?
			`SELECT
				'world' AS type,
				w.world_id AS id,
				w.world_id AS worldId,
				w.handle AS worldHandle,
				w.name AS worldName,
				w.name_lang AS worldNameLang,
				w.description AS worldDescription,
				w.description_lang AS worldDescriptionLang,
				NULL AS forumId,
				NULL AS forumHandle,
				NULL AS forumDescription,
				NULL AS forumDescriptionLang,
				NULL AS forumPersonalBotId,
				NULL AS botId,
				NULL AS botHandle,
				NULL AS botDisplayName,
				NULL AS botDisplayNameLang,
				NULL AS botShortBio,
				NULL AS botShortBioLang,
				NULL AS botAvatarUrl,
				NULL AS botAvatarCrop,
				0 AS score,
				0 AS total
			 FROM worlds_index w
			 WHERE w.world_id IN (${placeholders})
			   AND w.deleted_at IS NULL${whereTail}`
		: type === "forum" ?
			`SELECT
				'forum' AS type,
				f.forum_id AS id,
				w.world_id AS worldId,
				w.handle AS worldHandle,
				w.name AS worldName,
				w.name_lang AS worldNameLang,
				w.description AS worldDescription,
				w.description_lang AS worldDescriptionLang,
				f.forum_id AS forumId,
				f.handle AS forumHandle,
				f.description AS forumDescription,
				f.description_lang AS forumDescriptionLang,
				f.personal_bot_id AS forumPersonalBotId,
				NULL AS botId,
				NULL AS botHandle,
				NULL AS botDisplayName,
				NULL AS botDisplayNameLang,
				NULL AS botShortBio,
				NULL AS botShortBioLang,
				NULL AS botAvatarUrl,
				NULL AS botAvatarCrop,
				0 AS score,
				0 AS total
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
			 WHERE f.forum_id IN (${placeholders})
			   AND f.deleted_at IS NULL
			   AND f.personal_bot_id IS NULL${whereTail}`
		:	`SELECT
				'bot' AS type,
				b.bot_id AS id,
				w.world_id AS worldId,
				w.handle AS worldHandle,
				w.name AS worldName,
				w.name_lang AS worldNameLang,
				w.description AS worldDescription,
				w.description_lang AS worldDescriptionLang,
				NULL AS forumId,
				NULL AS forumHandle,
				NULL AS forumDescription,
				NULL AS forumDescriptionLang,
				NULL AS forumPersonalBotId,
				b.bot_id AS botId,
				b.handle AS botHandle,
				b.display_name AS botDisplayName,
				b.display_name_lang AS botDisplayNameLang,
				b.short_bio AS botShortBio,
				b.short_bio_lang AS botShortBioLang,
				b.avatar_url AS botAvatarUrl,
				b.avatar_crop AS botAvatarCrop,
				0 AS score,
				0 AS total
			 FROM bots_index b
			 JOIN worlds_index w ON w.world_id = b.home_world_id AND w.deleted_at IS NULL
			 WHERE b.bot_id IN (${placeholders})
			   AND b.deleted_at IS NULL${whereTail}`;
	const result = await db.prepare(sql).bind(...ids, ...binds).all<SearchSqlRow>();
	return result.results ?? [];
}

async function replaceSearchIndexEntity(db: D1DatabaseLike, entity: SearchIndexEntity): Promise<void> {
	const deleteStatement = db
		.prepare(`DELETE FROM search_entities_fts WHERE entity_type = ? AND entity_id = ?`)
		.bind(entity.type, entity.id);
	if (entity.deletedAt || (entity.type === "forum" && entity.personalBotId)) {
		await deleteStatement.run();
		return;
	}
	await db.batch([
		deleteStatement,
		db
			.prepare(
				`INSERT INTO search_entities_fts (
					entity_type, entity_id, world_id, world_handle, world_name,
					forum_id, forum_handle, bot_id, bot_handle, title, body, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				entity.type,
				entity.id,
				entity.type === "world" ? entity.id : entity.worldId ?? null,
				entity.type === "world" ? entity.handle : entity.worldHandle ?? "",
				entity.type === "world" ? localizedTextString(entity.name) : "",
				entity.type === "forum" ? entity.id : null,
				entity.type === "forum" ? entity.handle : null,
				entity.type === "bot" ? entity.id : null,
				entity.type === "bot" ? entity.handle : null,
				searchTitle(entity),
				searchBody(entity),
				entity.updatedAt,
			),
	]);
}

async function upsertSearchVector(env: SearchVectorEnv, entity: SearchVectorEntity): Promise<void> {
	await upsertSearchVectors(env, [entity]);
}

async function upsertSearchVectors(env: SearchVectorEnv, entities: SearchVectorEntity[]): Promise<void> {
	if (!env.AI) {
		return;
	}
	const vectorIndex = env.BICKR_SEARCH_VECTORIZE;
	if (!vectorIndex || entities.length === 0) {
		return;
	}
	for (let index = 0; index < entities.length; index += searchVectorReindexBatchSize) {
		const batch = entities.slice(index, index + searchVectorReindexBatchSize);
		try {
			const vectors = await embedSearchTexts(env.AI, batch.map(searchVectorText));
			const upserts = batch.flatMap((entity, vectorIndexInBatch) => {
				const vector = vectors[vectorIndexInBatch];
				return vector ?
					[{
						id: vectorIdForSearchEntity(entity),
						values: vector,
						metadata: searchVectorMetadata(entity),
					}]
				:	[];
			});
			if (upserts.length === 0) {
				continue;
			}
			await retrySearchBinding("Search vector upsert", () =>
				withSearchBindingTimeout("Search vector upsert", () => vectorIndex.upsert(upserts)),
			);
		} catch (error) {
			console.warn("search vector upsert failed", error);
		}
	}
}

async function embedSearchText(ai: SearchAiLike, text: string): Promise<number[] | null> {
	return (await embedSearchTexts(ai, [text]))[0] ?? null;
}

async function embedSearchTexts(ai: SearchAiLike, texts: string[]): Promise<number[][]> {
	const response = await retrySearchBinding("Search embedding", () =>
		withSearchBindingTimeout(
			"Search embedding",
			() => ai.run(searchEmbeddingModel, { text: texts }),
		),
	);
	return response.data ?? [];
}

function vectorMatchesToCandidates(matches: SearchVectorMatch[]): SemanticCandidate[] {
	const byKey = new Map<string, SemanticCandidate>();
	matches.forEach((match, order) => {
		const key = vectorMatchEntity(match);
		if (!key) {
			return;
		}
		const existing = byKey.get(searchEntityKey(key.type, key.id));
		if (!existing || match.score > existing.score) {
			byKey.set(searchEntityKey(key.type, key.id), {
				id: key.id,
				order,
				score: match.score,
				type: key.type,
			});
		}
	});
	return [...byKey.values()];
}

function vectorMatchEntity(match: SearchVectorMatch): { id: string; type: SearchEntityType } | null {
	const metadata = recordMetadata(match.metadata);
	const metadataType = stringMetadata(metadata, "type");
	const entityId = stringMetadata(metadata, "entityId");
	return isSearchEntityType(metadataType) && entityId ? { type: metadataType, id: entityId } : null;
}

function recordMetadata(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
	const value = metadata[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function searchVectorMetadata(entity: SearchVectorEntity): Record<string, string> {
	if (entity.type === "world") {
		return {
			entityId: entity.world.id,
			type: "world",
			worldHandle: entity.world.handle,
			worldId: entity.world.id,
		};
	}
	if (entity.type === "forum") {
		return {
			entityId: entity.forum.id,
			forumHandle: entity.forum.handle,
			forumId: entity.forum.id,
			type: "forum",
			worldHandle: entity.forum.worldHandle,
			worldId: entity.forum.worldId,
		};
	}
	return {
		botHandle: entity.bot.handle,
		botId: entity.bot.id,
		entityId: entity.bot.id,
		handle: entity.bot.handle,
		type: "bot",
		worldHandle: entity.bot.homeWorldHandle,
		worldId: entity.bot.homeWorldId,
	};
}

function searchVectorText(entity: SearchVectorEntity): string {
	if (entity.type === "world") {
		return [localizedTextString(entity.world.name), `w/${entity.world.handle}`, localizedTextString(entity.world.description)].join("\n");
	}
	if (entity.type === "forum") {
		return [`f/${entity.forum.handle}`, localizedTextString(entity.forum.description)].join("\n");
	}
	return [localizedTextString(entity.bot.displayName), `u/${entity.bot.handle}`, localizedTextString(entity.bot.shortBio)].join("\n");
}

function vectorIdForSearchEntity(entity: SearchVectorEntity): string {
	if (entity.type === "bot") {
		return entity.bot.id;
	}
	return vectorIdForEntity(entity.type, entity.type === "world" ? entity.world.id : entity.forum.id);
}

function vectorIdForEntity(type: SearchEntityType, id: string): string {
	return type === "bot" ? id : `${type}:${id}`;
}

function searchTitle(entity: SearchIndexEntity): string {
	if (entity.type === "world") {
		return [`w/${entity.handle}`, localizedTextString(entity.name)].filter(Boolean).join(" ");
	}
	if (entity.type === "forum") {
		return `f/${entity.handle}`;
	}
	return [`u/${entity.handle}`, localizedTextString(entity.displayName)].filter(Boolean).join(" ");
}

function searchBody(entity: SearchIndexEntity): string {
	if (entity.type === "bot") {
		return localizedTextString(entity.shortBio);
	}
	return localizedTextString(entity.description);
}

function responseFromRows(
	query: string,
	page: number,
	pageSize: number,
	rows: SearchSqlRow[],
	source: SearchResultSource,
): SearchResponse {
	const total = rows[0]?.total ?? 0;
	const offset = (page - 1) * pageSize;
	return {
		hasNextPage: offset + pageSize < total,
		page,
		pageSize,
		query,
		results: rows.map((row, index) => searchResultFromRow(row, source, offset + index + 1)),
		total,
	};
}

function searchResultFromRow(row: SearchSqlRow, source: SearchResultSource, rank: number): SearchResult {
	const worldName = localizedTextFromStored({ lang: row.worldNameLang, text: row.worldName });
	const worldDescription = localizedTextFromStored({ lang: row.worldDescriptionLang, text: row.worldDescription });
	const base = {
		id: row.id,
		rank,
		...(row.score !== null ? { score: row.score } : {}),
		source,
		urlPath: searchResultUrlPath(row),
		world: {
			id: row.worldId,
			handle: row.worldHandle,
			name: worldName,
			description: worldDescription,
			matched: row.type === "world",
		},
	};
	if (row.type === "world") {
		return {
			...base,
			type: "world",
			description: worldDescription,
			handle: row.worldHandle,
			name: worldName,
		};
	}
	if (row.type === "forum") {
		return {
			...base,
			type: "forum",
			description: localizedTextFromStored({ lang: row.forumDescriptionLang, text: row.forumDescription ?? "" }),
			handle: row.forumHandle ?? "",
			...(row.forumPersonalBotId ? { personalBotId: row.forumPersonalBotId } : {}),
		};
	}
	return {
		...base,
		type: "bot",
		displayName: localizedTextFromStored({ lang: row.botDisplayNameLang, text: row.botDisplayName ?? row.botHandle ?? "" }),
		handle: row.botHandle ?? "",
		shortBio: localizedTextFromStored({ lang: row.botShortBioLang, text: row.botShortBio ?? "" }),
		...searchBotAvatarFields(row.botAvatarUrl, row.botAvatarCrop),
	};
}

function searchResultUrlPath(row: SearchSqlRow): string {
	if (row.type === "world") {
		return `/w/${encodeURIComponent(row.worldHandle)}`;
	}
	if (row.type === "forum") {
		return `/w/${encodeURIComponent(row.worldHandle)}/f/${encodeURIComponent(row.forumHandle ?? "")}`;
	}
	return `/w/${encodeURIComponent(row.worldHandle)}/u/${encodeURIComponent(row.botHandle ?? "")}`;
}

function emptySearchResponse(query: string, page: number, pageSize: number): SearchResponse {
	return {
		hasNextPage: false,
		page,
		pageSize,
		query,
		results: [],
		total: 0,
	};
}

export function likePatternForSearchGlob(query: string): string | null {
	const normalized = normalizeSearchQuery(query);
	if (normalized.length < 2 && normalized !== "*") {
		return null;
	}
	const escaped = Array.from(normalized).map((char) => char === "*" ? "%" : escapeLike(char)).join("");
	return `%${escaped}%`;
}

const likePatternForAdvancedSearch = likePatternForSearchGlob;

export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function searchScoreBinds(query: string): unknown[] {
	const normalized = normalizeSearchQuery(query);
	const prefixPattern = `${escapeLike(normalized.replaceAll("*", ""))}%`;
	return [
		normalized,
		prefixPattern,
		prefixPattern,
		normalized,
		prefixPattern,
		normalized,
		prefixPattern,
		prefixPattern,
	];
}

function ftsExpressionFromUserSearch(query: string, options: FtsExpressionOptions): string | null {
	const terms = normalizeSearchText(query).split(" ").filter(Boolean);
	if (terms.length === 0) {
		return null;
	}
	return terms
		.map((term, index) => {
			const quoted = `"${term.replaceAll('"', '""')}"`;
			return options.prefixFinalTerm && index === terms.length - 1 ? `${quoted} *` : quoted;
		})
		.join(" AND ");
}

function normalizeSearchQuery(query: string): string {
	return normalizeSearchText(query).toLowerCase();
}

function normalizeSearchText(query: string): string {
	return query
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 200);
}

function normalizePrefixedHandle(value: string, prefixes: readonly string[]): string {
	let trimmed = value.trim();
	const lower = trimmed.toLowerCase();
	for (const prefix of prefixes) {
		if (lower.startsWith(prefix)) {
			trimmed = trimmed.slice(prefix.length);
			break;
		}
	}
	return normalizeHandle(trimmed);
}

function normalizeSearchTypes(types: readonly SearchEntityType[] | undefined): SearchEntityType[] {
	const next: SearchEntityType[] = [];
	for (const type of types ?? searchTypes) {
		if (!next.includes(type)) {
			next.push(type);
		}
	}
	return next;
}

function isSearchEntityType(value: unknown): value is SearchEntityType {
	return typeof value === "string" && (searchTypes as readonly string[]).includes(value);
}

async function safeSearchQuery<T>(query: () => Promise<D1Result<T>>): Promise<D1Result<T>> {
	try {
		return await query();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("LIKE or GLOB pattern too complex")) {
			return { success: true, results: [] };
		}
		throw error;
	}
}

function isFtsSyntaxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /fts5|MATCH|syntax|unterminated string/i.test(message);
}

function searchEntityKey(type: SearchEntityType, id: string): string {
	return `${type}:${id}`;
}

function retrySearchBinding<T>(operation: string, run: () => Promise<T>): Promise<T> {
	return retryCloudflareOperation({
		operation,
		run,
		maxAttempts: searchVectorRetryMaxAttempts,
		initialDelayMs: searchVectorRetryInitialDelayMs,
		maxDelayMs: searchVectorRetryMaxDelayMs,
		shouldRetry: isCloudflareRateLimitError,
	});
}

function withSearchBindingTimeout<T>(operation: string, run: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = globalThis.setTimeout(() => reject(new Error(`${operation} timed out.`)), searchVectorTimeoutMs);
		run().then(
			(value) => {
				globalThis.clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				globalThis.clearTimeout(timeout);
				reject(error);
			},
		);
	});
}
