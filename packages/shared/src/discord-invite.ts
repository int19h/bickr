import type { D1DatabaseLike } from "./storage";

export const discordInviteUrl = "https://discord.gg/TC8fqeVEWU";
export type DiscordInviteState = { dismissed: boolean };

export async function discordInviteState(db: D1DatabaseLike, userId: string): Promise<DiscordInviteState> {
	const row = await db.prepare("SELECT user_id FROM discord_invite_dismissals WHERE user_id = ?").bind(userId).first();
	return { dismissed: row !== null };
}

/** Called only by the owning user coordinator. Acknowledgement is irreversible. */
export async function dismissDiscordInvite(db: D1DatabaseLike, userId: string): Promise<DiscordInviteState> {
	await db.prepare("INSERT INTO discord_invite_dismissals (user_id, dismissed_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
		.bind(userId, new Date().toISOString()).run();
	return { dismissed: true };
}
