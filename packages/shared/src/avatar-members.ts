import { selectWorldAvatarMembers, worldAvatarMemberLimit, type WorldAvatarMemberSelection, type WorldAvatarPromptMember } from "./avatar-prompts";
import { localizedText, type LanguageTag } from "./model";
import type { D1DatabaseLike } from "./storage";

/** Avatar prompts need profile text, not runtime activity or account details. */
export async function worldAvatarMembers(db: D1DatabaseLike, worldId: string): Promise<WorldAvatarMemberSelection> {
	const result = await db.prepare(`
		SELECT handle, display_name AS displayName, display_name_lang AS displayNameLang,
		       short_bio AS shortBio, short_bio_lang AS shortBioLang
		FROM bots_index
		WHERE home_world_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL
		ORDER BY handle ASC LIMIT ?
	`).bind(worldId, worldAvatarMemberLimit + 1).all<{
		handle: string; displayName: string; displayNameLang: LanguageTag | null;
		shortBio: string; shortBioLang: LanguageTag | null;
	}>();
	// Writers project effective linked-clone profile text into bots_index.
	// Reading that projection avoids a second per-member KV/clone traversal.
	const members: WorldAvatarPromptMember[] = (result.results ?? []).map((row) => ({
		handle: row.handle, displayName: localizedText(row.displayName, row.displayNameLang), shortBio: localizedText(row.shortBio, row.shortBioLang),
	}));
	return selectWorldAvatarMembers(members);
}
