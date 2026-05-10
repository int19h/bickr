import { isCloudflareRateLimitError, retryCloudflareOperation } from "./cloudflare";
import {
	type BotSummary,
	type ForumSummary,
	type SearchEntityType,
	type SearchMode,
	type SearchResponse,
	type SearchResult,
	type SearchResultSource,
	type WorldSummary,
} from "./model";
import { type D1DatabaseLike, type D1Result } from "./storage";
import { InputError, normalizeHandle } from "./validation";

export const searchPageSize = 20;
export const searchSuggestionLimit = 8;
export const searchEmbeddingModel = "@cf/google/embeddinggemma-300m";

const searchVectorTimeoutMs = 10_000;
const searchVectorRetryMaxAttempts = 3;
const searchVectorRetryInitialDelayMs = 1_100;
const searchVectorRetryMaxDelayMs = 8_000;
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
	description?: string;
	displayName?: string;
	handle: string;
	id: string;
	name?: string;
	personalBotId?: string;
	shortBio?: string;
	type: SearchEntityType;
	updatedAt: string;
	worldHandle?: string;
	worldId?: string;
};

type SearchSqlRow = {
	botDisplayName: string | null;
	botHandle: string | null;
	botId: string | null;
	botShortBio: string | null;
	forumDescription: string | null;
	forumHandle: string | null;
	forumId: string | null;
	forumPersonalBotId: string | null;
	id: string;
	score: number | null;
	total: number;
	type: SearchEntityType;
	worldDescription: string;
	worldHandle: string;
	worldId: string;
	worldName: string;
};

type SearchVectorMatch = {
	id: string;
	metadata?: unknown;
	score: number;
};

type SearchVectorMatches = {
	matches: SearchVectorMatch[];
};

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
	BICKR_BOT_VECTORIZE?: SearchVectorizeIndexLike;
	BICKR_SEARCH_VECTORIZE?: SearchVectorizeIndexLike;
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
	return "substring";
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
	return searchEntitiesText(db, {
		mode: "substring",
		page: 1,
		query: options.query,
		types: searchTypes,
	}, Math.max(1, Math.min(20, Math.floor(options.limit ?? searchSuggestionLimit))));
}

export async function searchEntitiesText(
	db: D1DatabaseLike,
	options: SearchQueryOptions,
	overrideLimit?: number,
): Promise<SearchResponse> {
	const page = boundedSearchPage(options.page);
	const types = normalizeSearchTypes(options.types);
	const limit = overrideLimit ?? searchPageSize;
	const query = options.mode === "fts" ? normalizeSearchText(options.query) : normalizeSearchQuery(options.query);
	if (!query || types.length === 0) {
		return emptySearchResponse(options.query, page, limit);
	}

	if (options.mode === "fts") {
		return ftsSearchEntities(db, { ...options, page, query, types }, limit);
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

	const vectorIndex = searchVectorIndex(env);
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

export async function upsertForumSearchVector(env: SearchVectorEnv, forum: Pick<ForumSummary, "description" | "handle" | "id" | "worldHandle" | "worldId">): Promise<void> {
	await upsertSearchVector(env, { type: "forum", forum });
}

export async function upsertBotSearchVector(env: SearchVectorEnv, bot: Pick<BotSummary, "displayName" | "handle" | "homeWorldHandle" | "homeWorldId" | "id" | "shortBio">): Promise<void> {
	await upsertSearchVector(env, { type: "bot", bot });
}

export async function deleteSearchVector(env: SearchVectorEnv, type: SearchEntityType, id: string): Promise<void> {
	const vectorIndex = searchVectorIndex(env);
	if (!vectorIndex) {
		return;
	}
	const vectorId = type === "bot" ? `bot:${id}` : vectorIdForEntity(type, id);
	const ids = type === "bot" ? [id, vectorId] : [vectorId];
	try {
		await retrySearchBinding("Search vector delete", () =>
			withSearchBindingTimeout("Search vector delete", () => vectorIndex.deleteByIds(ids)),
		);
	} catch (error) {
		console.warn("search vector delete failed", error);
	}
}

export async function reindexSearchVectors(
	db: D1DatabaseLike,
	env: SearchVectorEnv,
	limit = 100,
): Promise<{ attempted: number }> {
	const boundedLimit = Math.max(1, Math.min(250, Math.floor(limit)));
	const rows = await db
		.prepare(
			`SELECT object_id AS id, object_type AS type
			 FROM objects_index
			 WHERE deleted_at IS NULL
			   AND object_type IN ('world', 'forum', 'bot')
			 ORDER BY updated_at DESC
			 LIMIT ?`,
		)
		.bind(boundedLimit)
		.all<{ id: string; type: SearchEntityType }>();
	let attempted = 0;
	for (const row of rows.results ?? []) {
		const entity = await searchVectorEntityById(db, row.type, row.id);
		if (entity) {
			attempted += 1;
			await upsertSearchVector(env, entity);
		}
	}
	return { attempted };
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
	const normalized = normalizeSearchQuery(options.query);
	const prefixPattern = `${escapeLike(normalized.replaceAll("*", ""))}%`;
	const scoreBinds = [
		normalized,
		prefixPattern,
		prefixPattern,
		normalized,
		prefixPattern,
		normalized,
		prefixPattern,
		prefixPattern,
	];
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
	limit: number,
): Promise<SearchResponse> {
	const conditions = ["type IN (${typePlaceholders})"];
	const binds: unknown[] = [];
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
			.bind(options.query, ...options.types, ...binds, limit, offset)
			.all<SearchSqlRow>();
		return responseFromRows(options.query, options.page, limit, result.results ?? [], "fts");
	} catch (error) {
		if (isFtsSyntaxError(error)) {
			throw new InputError("FTS query syntax is invalid.");
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
					w.description AS worldDescription,
					NULL AS forumId,
					NULL AS forumHandle,
					NULL AS forumDescription,
					NULL AS forumPersonalBotId,
					NULL AS botId,
					NULL AS botHandle,
					NULL AS botDisplayName,
					NULL AS botShortBio,
					fts.score AS score,
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
					w.description AS worldDescription,
					f.forum_id AS forumId,
					f.handle AS forumHandle,
					f.description AS forumDescription,
					f.personal_bot_id AS forumPersonalBotId,
					NULL AS botId,
					NULL AS botHandle,
					NULL AS botDisplayName,
					NULL AS botShortBio,
					fts.score AS score,
					lower(f.handle) AS sortHandle,
					lower(f.description) AS sortName
				 FROM fts_matches fts
				 JOIN forums_index f ON fts.entity_type = 'forum' AND fts.entity_id = f.forum_id
				 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
				 WHERE f.deleted_at IS NULL
				 UNION ALL
				SELECT
					'bot' AS type,
					b.bot_id AS id,
					w.world_id AS worldId,
					w.handle AS worldHandle,
					w.name AS worldName,
					w.description AS worldDescription,
					NULL AS forumId,
					NULL AS forumHandle,
					NULL AS forumDescription,
					NULL AS forumPersonalBotId,
					b.bot_id AS botId,
					b.handle AS botHandle,
					b.display_name AS botDisplayName,
					b.short_bio AS botShortBio,
					fts.score AS score,
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
					w.description AS worldDescription,
					NULL AS forumId,
					NULL AS forumHandle,
					NULL AS forumDescription,
					NULL AS forumPersonalBotId,
					NULL AS botId,
					NULL AS botHandle,
					NULL AS botDisplayName,
					NULL AS botShortBio,
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
					w.description AS worldDescription,
					f.forum_id AS forumId,
					f.handle AS forumHandle,
					f.description AS forumDescription,
					f.personal_bot_id AS forumPersonalBotId,
					NULL AS botId,
					NULL AS botHandle,
					NULL AS botDisplayName,
					NULL AS botShortBio,
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
				 UNION ALL
				SELECT
					'bot' AS type,
					b.bot_id AS id,
					w.world_id AS worldId,
					w.handle AS worldHandle,
					w.name AS worldName,
					w.description AS worldDescription,
					NULL AS forumId,
					NULL AS forumHandle,
					NULL AS forumDescription,
					NULL AS forumPersonalBotId,
					b.bot_id AS botId,
					b.handle AS botHandle,
					b.display_name AS botDisplayName,
					b.short_bio AS botShortBio,
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
			worldDescription AS worldDescription,
			forumId AS forumId,
			forumHandle AS forumHandle,
			forumDescription AS forumDescription,
			forumPersonalBotId AS forumPersonalBotId,
			botId AS botId,
			botHandle AS botHandle,
			botDisplayName AS botDisplayName,
			botShortBio AS botShortBio,
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
		  AND filter_forum.handle = ?
		UNION ALL
		SELECT 1
		FROM comments_index filter_comment
		JOIN forums_index filter_forum ON filter_forum.forum_id = filter_comment.forum_id
		WHERE filter_comment.author_bot_id = ${botIdExpression}
		  AND filter_comment.deleted_at IS NULL
		  AND filter_forum.deleted_at IS NULL
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
				w.description AS worldDescription,
				NULL AS forumId,
				NULL AS forumHandle,
				NULL AS forumDescription,
				NULL AS forumPersonalBotId,
				NULL AS botId,
				NULL AS botHandle,
				NULL AS botDisplayName,
				NULL AS botShortBio,
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
				w.description AS worldDescription,
				f.forum_id AS forumId,
				f.handle AS forumHandle,
				f.description AS forumDescription,
				f.personal_bot_id AS forumPersonalBotId,
				NULL AS botId,
				NULL AS botHandle,
				NULL AS botDisplayName,
				NULL AS botShortBio,
				0 AS score,
				0 AS total
			 FROM forums_index f
			 JOIN worlds_index w ON w.world_id = f.world_id AND w.deleted_at IS NULL
			 WHERE f.forum_id IN (${placeholders})
			   AND f.deleted_at IS NULL${whereTail}`
		:	`SELECT
				'bot' AS type,
				b.bot_id AS id,
				w.world_id AS worldId,
				w.handle AS worldHandle,
				w.name AS worldName,
				w.description AS worldDescription,
				NULL AS forumId,
				NULL AS forumHandle,
				NULL AS forumDescription,
				NULL AS forumPersonalBotId,
				b.bot_id AS botId,
				b.handle AS botHandle,
				b.display_name AS botDisplayName,
				b.short_bio AS botShortBio,
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
	if (entity.deletedAt) {
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
				entity.type === "world" ? entity.name ?? "" : "",
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

async function searchVectorEntityById(
	db: D1DatabaseLike,
	type: SearchEntityType,
	id: string,
): Promise<SearchVectorEntity | null> {
	if (type === "world") {
		const row = await db
			.prepare(
				`SELECT world_id AS id, handle, name, description
				 FROM worlds_index
				 WHERE world_id = ? AND deleted_at IS NULL`,
			)
			.bind(id)
			.first<Pick<WorldSummary, "description" | "handle" | "id" | "name">>();
		return row ? { type, world: row } : null;
	}
	if (type === "forum") {
		const row = await db
			.prepare(
				`SELECT forum_id AS id, world_id AS worldId, world_handle AS worldHandle, handle, description
				 FROM forums_index
				 WHERE forum_id = ? AND deleted_at IS NULL`,
			)
			.bind(id)
			.first<Pick<ForumSummary, "description" | "handle" | "id" | "worldHandle" | "worldId">>();
		return row ? { type, forum: row } : null;
	}
	const row = await db
		.prepare(
			`SELECT
				bot_id AS id,
				home_world_id AS homeWorldId,
				home_world_handle AS homeWorldHandle,
				handle,
				display_name AS displayName,
				short_bio AS shortBio
			 FROM bots_index
			 WHERE bot_id = ? AND deleted_at IS NULL`,
		)
		.bind(id)
		.first<Pick<BotSummary, "displayName" | "handle" | "homeWorldHandle" | "homeWorldId" | "id" | "shortBio">>();
	return row ? { type, bot: row } : null;
}

async function upsertSearchVector(env: SearchVectorEnv, entity: SearchVectorEntity): Promise<void> {
	if (!env.AI) {
		return;
	}
	const vectorIndex = searchVectorIndex(env);
	if (!vectorIndex) {
		return;
	}
	try {
		const vector = await embedSearchText(env.AI, searchVectorText(entity));
		if (!vector) {
			return;
		}
		await retrySearchBinding("Search vector upsert", () =>
			withSearchBindingTimeout("Search vector upsert", () =>
				vectorIndex.upsert([
					{
						id: vectorIdForSearchEntity(entity),
						values: vector,
						metadata: searchVectorMetadata(entity),
					},
				]),
			),
		);
	} catch (error) {
		console.warn("search vector upsert failed", error);
	}
}

async function embedSearchText(ai: SearchAiLike, text: string): Promise<number[] | null> {
	const response = await retrySearchBinding("Search embedding", () =>
		withSearchBindingTimeout(
			"Search embedding",
			() => ai.run(searchEmbeddingModel, { text: [text] }),
		),
	);
	return response.data?.[0] ?? null;
}

function searchVectorIndex(env: SearchVectorEnv): SearchVectorizeIndexLike | undefined {
	return env.BICKR_SEARCH_VECTORIZE ?? env.BICKR_BOT_VECTORIZE;
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
	const entityId = stringMetadata(metadata, "entityId") ?? stringMetadata(metadata, "objectId");
	if (isSearchEntityType(metadataType)) {
		return { type: metadataType, id: entityId ?? legacyVectorId(match.id, metadataType) };
	}
	for (const type of searchTypes) {
		const prefix = `${type}:`;
		if (match.id.startsWith(prefix)) {
			return { type, id: match.id.slice(prefix.length) };
		}
	}
	return null;
}

function legacyVectorId(id: string, type: SearchEntityType): string {
	const prefix = `${type}:`;
	return id.startsWith(prefix) ? id.slice(prefix.length) : id;
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
		return [entity.world.name, `w/${entity.world.handle}`, entity.world.description].join("\n");
	}
	if (entity.type === "forum") {
		return [`f/${entity.forum.handle}`, entity.forum.description].join("\n");
	}
	return [entity.bot.displayName, `u/${entity.bot.handle}`, entity.bot.shortBio].join("\n");
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
		return [`w/${entity.handle}`, entity.name ?? ""].filter(Boolean).join(" ");
	}
	if (entity.type === "forum") {
		return `f/${entity.handle}`;
	}
	return [`u/${entity.handle}`, entity.displayName ?? ""].filter(Boolean).join(" ");
}

function searchBody(entity: SearchIndexEntity): string {
	if (entity.type === "bot") {
		return entity.shortBio ?? "";
	}
	return entity.description ?? "";
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
	const base = {
		id: row.id,
		rank,
		...(row.score !== null ? { score: row.score } : {}),
		source,
		urlPath: searchResultUrlPath(row),
		world: {
			id: row.worldId,
			handle: row.worldHandle,
			name: row.worldName,
			description: row.worldDescription,
			matched: row.type === "world",
		},
	};
	if (row.type === "world") {
		return {
			...base,
			type: "world",
			description: row.worldDescription,
			handle: row.worldHandle,
			name: row.worldName,
		};
	}
	if (row.type === "forum") {
		return {
			...base,
			type: "forum",
			description: row.forumDescription ?? "",
			handle: row.forumHandle ?? "",
			...(row.forumPersonalBotId ? { personalBotId: row.forumPersonalBotId } : {}),
		};
	}
	return {
		...base,
		type: "bot",
		displayName: row.botDisplayName ?? row.botHandle ?? "",
		handle: row.botHandle ?? "",
		shortBio: row.botShortBio ?? "",
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

function likePatternForAdvancedSearch(query: string): string | null {
	const normalized = normalizeSearchQuery(query);
	if (normalized.length < 2 && normalized !== "*") {
		return null;
	}
	const escaped = Array.from(normalized).map((char) => char === "*" ? "%" : escapeLike(char)).join("");
	return `%${escaped}%`;
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
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
