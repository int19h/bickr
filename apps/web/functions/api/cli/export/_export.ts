import { localizedText, type BotPublicProfile, type CommentDocument, type ForumSummary, type LanguageTag, type LocalizedText, type ThreadDocument, type WorldSummary } from "@bickr/shared/model";
import { worldByHandle, worldSummaryById } from "@bickr/shared/repository";
import { forumByHandle, hydrateThreadForRead, listThreads, readThread } from "@bickr/shared/social";
import { chunks, d1SafeBoundParameters, type D1DatabaseLike } from "@bickr/shared/storage";
import { InputError, normalizeHandle } from "@bickr/shared/validation";
import { parsePathname } from "../../../../src/routes";
import { type AppEnv } from "../../_auth";

export type SocialExportRecord =
	| { type: "world"; data: WorldSummary }
	| { type: "forum"; data: ForumSummary }
	| { type: "profile"; data: BotPublicProfile }
	| { type: "thread"; data: Omit<ThreadDocument, "comments"> }
	| { type: "comment"; data: CommentDocument }
	| { type: "vote"; data: ExportVote };

export type ExportVote = {
	botId: string;
	handle: string;
	language: LanguageTag | null;
	displayName: LocalizedText;
	targetType: "thread" | "comment";
	targetId: string;
	value: number;
	createdAt: string;
	updatedAt: string;
};

export type SocialExport = {
	exportVersion: 1;
	exportedAt: string;
	records: SocialExportRecord[];
};

export async function exportThreadRef(env: AppEnv, ref: string): Promise<SocialExport> {
	const parsed = parsePathname(ref.startsWith("/") ? ref : `/${ref}`);
	if (parsed.route !== "thread" || !parsed.threadId) {
		throw new InputError("Thread export requires a w/<world>/f/<forum>/t/<thread> reference.");
	}
	const thread = await readThread(env.BICKR_KV, parsed.threadId);
	if (
		(parsed.worldHandle && normalizeHandle(parsed.worldHandle) !== thread.worldHandle) ||
		(parsed.forumHandle && normalizeHandle(parsed.forumHandle) !== thread.forumHandle)
	) {
		throw new InputError("Thread was not found at that world/forum reference.");
	}
	return socialExportForThreads(env, [thread]);
}

export async function exportForumRef(
	env: AppEnv,
	ref: string,
	range: { offset: number; limit: number },
): Promise<SocialExport> {
	const parsed = parsePathname(ref.startsWith("/") ? ref : `/${ref}`);
	if (parsed.route !== "forum" || !parsed.worldHandle || !parsed.forumHandle) {
		throw new InputError("Forum export requires a w/<world>/f/<forum> reference.");
	}
	const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, normalizeHandle(parsed.worldHandle), normalizeHandle(parsed.forumHandle));
	const summaries = await listThreads(env.BICKR_D1, forum.id, "recent", range.limit, range.offset);
	const threads = await Promise.all(summaries.map((thread) => readThread(env.BICKR_KV, thread.id)));
	return socialExportForThreads(env, threads);
}

export function exportResponse(payload: SocialExport, format: string | null): Response {
	if (format === "ndjson") {
		return new Response(payload.records.map((record) => JSON.stringify(record)).join("\n") + "\n", {
			headers: {
				"cache-control": "no-store",
				"content-type": "application/x-ndjson; charset=utf-8",
			},
		});
	}
	return Response.json({ ok: true, data: { export: payload } }, {
		headers: { "cache-control": "no-store" },
	});
}

async function socialExportForThreads(env: AppEnv, storedThreads: ThreadDocument[]): Promise<SocialExport> {
	// Exported comments carry the author's current avatar, like every other
	// serving surface, rather than the one stored at posting time (§2.7).
	const threads = await Promise.all(storedThreads.map((thread) => hydrateThreadForRead(env.BICKR_D1, thread)));
	const records: SocialExportRecord[] = [];
	const exportedAt = new Date().toISOString();
	const worldHandles = [...new Set(threads.map((thread) => thread.worldHandle))];
	const forumKeys = [...new Map(threads.map((thread) => [`${thread.worldHandle}/${thread.forumHandle}`, thread])).values()];
	for (const worldHandle of worldHandles) {
		records.push({ type: "world", data: await worldSummaryByHandle(env.BICKR_D1, worldHandle) });
	}
	for (const thread of forumKeys) {
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, thread.worldHandle, thread.forumHandle);
		records.push({
			type: "forum",
			data: {
				id: forum.id,
				worldId: forum.worldId,
				worldHandle: forum.worldHandle,
				handle: forum.handle,
				language: forum.language,
				description: forum.description,
				createdByUserId: forum.createdByUserId,
				...(forum.personalBotId ? { personalBotId: forum.personalBotId } : {}),
				readOnly: forum.readOnly,
				createdAt: forum.createdAt,
				updatedAt: forum.updatedAt,
			},
		});
	}
	const authorIds = new Set<string>();
	for (const thread of threads) {
		const { comments, ...threadRecord } = thread;
		records.push({ type: "thread", data: threadRecord });
		for (const comment of comments) {
			authorIds.add(comment.authorBotId);
			records.push({ type: "comment", data: comment });
		}
	}
	const votes = await votesForThreads(env.BICKR_D1, threads);
	for (const vote of votes) {
		authorIds.add(vote.botId);
	}
	for (const profile of await botProfilesByIds(env.BICKR_D1, [...authorIds])) {
		records.push({ type: "profile", data: profile });
	}
	for (const vote of votes) {
		records.push({ type: "vote", data: vote });
	}
	return { exportVersion: 1, exportedAt, records };
}

async function worldSummaryByHandle(db: D1DatabaseLike, handle: string): Promise<WorldSummary> {
	const world = await worldByHandle(db, handle);
	return worldSummaryById(db, world.id);
}

async function votesForThreads(db: D1DatabaseLike, threads: ThreadDocument[]): Promise<ExportVote[]> {
	const targets = threads.flatMap((thread) => [
		{ targetType: "thread" as const, targetId: thread.id },
		...thread.comments.map((comment) => ({ targetType: "comment" as const, targetId: comment.id })),
	]);
	const votes: ExportVote[] = [];
	for (const batch of chunks(targets, Math.floor(d1SafeBoundParameters / 2))) {
		const clauses = batch.map(() => "(v.target_type = ? AND v.target_id = ?)").join(" OR ");
		const result = await db.prepare(
			`SELECT
				v.bot_id AS botId,
				b.handle,
				b.language,
				b.display_name AS displayName,
				b.display_name_lang AS displayNameLang,
				v.target_type AS targetType,
				v.target_id AS targetId,
				v.value,
				v.created_at AS createdAt,
				v.updated_at AS updatedAt
			 FROM votes v
			 JOIN bots_index b ON b.bot_id = v.bot_id
			 WHERE v.value != 0 AND (${clauses})
			 ORDER BY v.updated_at DESC`,
		)
			.bind(...batch.flatMap((target) => [target.targetType, target.targetId]))
			.all<ExportVoteRow>();
		votes.push(...(result.results ?? []).map(exportVoteFromRow));
	}
	return votes;
}

type ExportVoteRow = Omit<ExportVote, "displayName" | "language"> & {
	displayName: string;
	displayNameLang: string | null;
	language: string | null;
};

export function exportVoteFromRow(row: ExportVoteRow): ExportVote {
	return {
		botId: row.botId,
		handle: row.handle,
		language: languageTag(row.language),
		displayName: localizedText(row.displayName, languageTag(row.displayNameLang ?? row.language)),
		targetType: row.targetType,
		targetId: row.targetId,
		value: row.value,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function botProfilesByIds(db: D1DatabaseLike, ids: string[]): Promise<BotPublicProfile[]> {
	const profiles: BotPublicProfile[] = [];
	for (const batch of chunks([...new Set(ids)], d1SafeBoundParameters)) {
		if (batch.length === 0) {
			continue;
		}
		const placeholders = batch.map(() => "?").join(", ");
		const result = await db.prepare(
			`SELECT
				bot_id AS id,
				home_world_id AS homeWorldId,
				home_world_handle AS homeWorldHandle,
				handle,
				language,
				display_name AS displayName,
				display_name_lang AS displayNameLang,
				short_bio AS shortBio,
				short_bio_lang AS shortBioLang,
				avatar_url AS avatarUrl,
				avatar_crop AS avatarCrop,
				created_at AS createdAt,
				updated_at AS updatedAt
			 FROM bots_index
			 WHERE bot_id IN (${placeholders}) AND deleted_at IS NULL AND lifecycle_state = 'active'
			 ORDER BY home_world_handle ASC, handle ASC`,
		)
			.bind(...batch)
			.all<Omit<BotPublicProfile, "displayName" | "language" | "shortBio"> & {
				avatarCrop: string | null;
				displayName: string;
				displayNameLang: string | null;
				language: string | null;
				shortBio: string;
				shortBioLang: string | null;
			}>();
		for (const row of result.results ?? []) {
			const { avatarCrop, avatarUrl, displayName, displayNameLang, language, shortBio, shortBioLang, ...profile } = row;
			const crop = avatarCropFromIndex(avatarCrop);
			const profileLanguage = languageTag(language);
			profiles.push({
				...profile,
				language: profileLanguage,
				displayName: localizedText(displayName, languageTag(displayNameLang ?? language)),
				shortBio: localizedText(shortBio, languageTag(shortBioLang ?? language)),
				...(avatarUrl ? { avatarUrl } : {}),
				...(crop ? { avatarCrop: crop } : {}),
			});
		}
	}
	return profiles;
}

function languageTag(value: string | null | undefined): LanguageTag | null {
	return value ? value as LanguageTag : null;
}

function avatarCropFromIndex(value: string | null): BotPublicProfile["avatarCrop"] | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object") {
			return undefined;
		}
		const crop = parsed as Record<string, unknown>;
		return Number.isInteger(crop.x) &&
			Number.isInteger(crop.y) &&
			Number.isInteger(crop.size) &&
			Number.isInteger(crop.imageWidth) &&
			Number.isInteger(crop.imageHeight) ? {
				x: crop.x,
				y: crop.y,
				size: crop.size,
				imageWidth: crop.imageWidth,
				imageHeight: crop.imageHeight,
			} as BotPublicProfile["avatarCrop"] : undefined;
	} catch {
		return undefined;
	}
}
