/** The current avatar URL of an active bot, or undefined. */
export async function botAvatarUrl(db: D1Database, botId: string): Promise<string | undefined> {
	const row = await db
		.prepare(`SELECT avatar_url AS avatarUrl FROM bots_index WHERE bot_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active'`)
		.bind(botId)
		.first<{ avatarUrl: string | null }>();
	return row?.avatarUrl ?? undefined;
}
