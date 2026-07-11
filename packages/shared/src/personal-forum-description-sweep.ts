import { entityIndexVersions } from "./index-versions";
import {
	localizedText,
	type ForumDocument,
	type LanguageTag,
	type LocalizedText,
} from "./model";
import { personalForumDescription } from "./personal-forums";
import { normalizeForumDefaults, upsertForumIndexProjection } from "./repository";
import {
	deleteKey,
	type D1DatabaseLike,
	kvKeys,
	type KVNamespaceLike,
	putObjectIndex,
	readJson,
	writeJson,
} from "./storage";
import { runBoundedSweep } from "./sweep";

export const personalForumDescriptionSweepChunkSize = 50;
export const personalForumDescriptionSweepMaxRowsPerRun = 250;
export const personalForumDescriptionSweepMaxWritesPerRun = 75;

export type PersonalForumDescriptionSweepEnv = {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
};

export type PersonalForumDescriptionSweepOptions = {
	maxRowsPerRun?: number;
	maxWritesPerRun?: number;
	now?: string;
};

export type PersonalForumDescriptionSweepResult = {
	scanned: number;
	rewritten: number;
	done: boolean;
};

type PersonalForumRow = {
	forumId: string;
	botId: string | null;
	botHandle: string | null;
	botLanguage: string | null;
	botDisplayName: string | null;
	botDisplayNameLang: string | null;
};

type PersonalForumDescriptionSweepCursor = {
	afterForumId: string;
};

export async function resyncPersonalForumDescriptions(
	env: PersonalForumDescriptionSweepEnv,
	options: PersonalForumDescriptionSweepOptions = {},
): Promise<PersonalForumDescriptionSweepResult> {
	const maxRowsPerRun = boundedPositiveInteger(
		options.maxRowsPerRun ?? personalForumDescriptionSweepMaxRowsPerRun,
		"maxRowsPerRun",
		personalForumDescriptionSweepMaxRowsPerRun,
	);
	const maxWritesPerRun = boundedPositiveInteger(
		options.maxWritesPerRun ?? personalForumDescriptionSweepMaxWritesPerRun,
		"maxWritesPerRun",
		personalForumDescriptionSweepMaxWritesPerRun,
	);
	const now = options.now ?? new Date().toISOString();
	const storedCursor = await readPersonalForumDescriptionSweepCursor(env.BICKR_KV);
	let rewritten = 0;
	let changedDuringSweep = false;
	const iteration = await runBoundedSweep<PersonalForumRow, string>({
		chunkSize: personalForumDescriptionSweepChunkSize,
		maxItemsPerRun: maxRowsPerRun,
		...(storedCursor ? { initialCursor: storedCursor.afterForumId } : {}),
		loadChunk: (cursor, limit) => loadPersonalForumChunk(env.BICKR_D1, cursor, limit),
		processChunk: async (rows) => {
			const documents = await Promise.all(rows.map((row) =>
				readJson<ForumDocument>(env.BICKR_KV, kvKeys.forum(row.forumId)),
			));
			for (let index = 0; index < rows.length; index += 1) {
				const row = rows[index];
				const document = documents[index];
				if (
					!row ||
					!document ||
					document.deletedAt ||
					document.personalBotId !== row.botId ||
					!row.botId ||
					!row.botHandle ||
					row.botDisplayName === null
				) {
					continue;
				}
				const current = normalizeForumDefaults(document);
				const botLanguage = row.botLanguage as LanguageTag | null;
				const description = personalForumDescription({
					handle: row.botHandle,
					displayName: localizedText(row.botDisplayName, row.botDisplayNameLang as LanguageTag | null),
				});
				if (
					current.language === botLanguage &&
					localizedTextEqual(current.description, description)
				) {
					continue;
				}
				const latest = await readJson<ForumDocument>(env.BICKR_KV, kvKeys.forum(row.forumId));
				if (!latest || latest.deletedAt || !sameDocumentVersion(document, latest)) {
					changedDuringSweep = true;
					continue;
				}
				const updated: ForumDocument = {
					...normalizeForumDefaults(latest),
					language: botLanguage,
					description,
					revision: latest.revision + 1,
					updatedAt: now,
				};
				await writeJson(env.BICKR_KV, kvKeys.forum(updated.id), updated);
				await upsertForumIndexProjection(env.BICKR_D1, updated);
				await putObjectIndex(
					env.BICKR_D1,
					updated,
					"forum",
					entityIndexVersions.forum,
					updated.worldId,
				);
				rewritten += 1;
				if (rewritten >= maxWritesPerRun) {
					return { kind: "stop", processedItems: index + 1, cursor: row.forumId };
				}
			}
			return { kind: "continue" };
		},
		checkpoint: (afterForumId) => writeJson(
			env.BICKR_KV,
			kvKeys.personalForumDescriptionSweepCursor,
			{ afterForumId } satisfies PersonalForumDescriptionSweepCursor,
		),
		complete: () => deleteKey(env.BICKR_KV, kvKeys.personalForumDescriptionSweepCursor),
	});

	return {
		scanned: iteration.scanned,
		rewritten,
		done: !iteration.budgetExhausted && !changedDuringSweep,
	};
}

async function loadPersonalForumChunk(
	db: D1DatabaseLike,
	cursor: string | undefined,
	limit: number,
) {
	const statement = cursor ?
		db
			.prepare(
				`SELECT
					f.forum_id AS forumId,
					b.bot_id AS botId,
					b.handle AS botHandle,
					b.language AS botLanguage,
					b.display_name AS botDisplayName,
					b.display_name_lang AS botDisplayNameLang
				 FROM forums_index f
				 LEFT JOIN bots_index b ON b.bot_id = f.personal_bot_id AND b.deleted_at IS NULL
				 WHERE f.personal_bot_id IS NOT NULL AND f.deleted_at IS NULL AND f.forum_id > ?
				 ORDER BY f.forum_id ASC
				 LIMIT ?`,
			)
			.bind(cursor, limit)
	:	db
			.prepare(
				`SELECT
					f.forum_id AS forumId,
					b.bot_id AS botId,
					b.handle AS botHandle,
					b.language AS botLanguage,
					b.display_name AS botDisplayName,
					b.display_name_lang AS botDisplayNameLang
				 FROM forums_index f
				 LEFT JOIN bots_index b ON b.bot_id = f.personal_bot_id AND b.deleted_at IS NULL
				 WHERE f.personal_bot_id IS NOT NULL AND f.deleted_at IS NULL
				 ORDER BY f.forum_id ASC
				 LIMIT ?`,
			)
			.bind(limit);
	const result = await statement.all<PersonalForumRow>();
	const items = result.results ?? [];
	const nextCursor = items.at(-1)?.forumId;
	return {
		items,
		done: items.length < limit,
		...(nextCursor ? { nextCursor } : {}),
	};
}

async function readPersonalForumDescriptionSweepCursor(
	kv: KVNamespaceLike,
): Promise<PersonalForumDescriptionSweepCursor | null> {
	const value = await readJson<unknown>(kv, kvKeys.personalForumDescriptionSweepCursor);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const afterForumId = (value as Record<string, unknown>).afterForumId;
	return typeof afterForumId === "string" && afterForumId.length > 0 ? { afterForumId } : null;
}

function localizedTextEqual(left: LocalizedText, right: LocalizedText): boolean {
	return left.text === right.text && left.lang === right.lang;
}

function sameDocumentVersion(left: ForumDocument, right: ForumDocument): boolean {
	return left.revision === right.revision && left.updatedAt === right.updatedAt;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
	if (!Number.isInteger(value) || value <= 0 || value > maximum) {
		throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
	}
	return value;
}
