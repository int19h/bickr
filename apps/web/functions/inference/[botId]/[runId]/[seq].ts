import type { AppEnv } from "../../../api/_auth";
import { redirectToResolvedPath } from "../../../_content-refs";

// Resolve current handles by stable identity. A rename or handle reuse must not
// send an artifact's source link to a different participant's loop.
export const onRequestGet: PagesFunction<AppEnv, "botId" | "runId" | "seq"> = async ({ env, params, request }) => {
	const botId = single(params.botId);
	const runId = single(params.runId);
	const seq = Number(single(params.seq));
	if (!Number.isSafeInteger(seq) || seq < 1) return new Response("Invalid inference request sequence.", { status: 400 });
	const bot = await env.BICKR_D1.prepare("SELECT home_world_handle AS worldHandle, handle FROM bots_index WHERE bot_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active' LIMIT 1")
		.bind(botId).first<{ worldHandle: string; handle: string }>();
	if (!bot) return new Response("The inference author is no longer available.", { status: 404 });
	return redirectToResolvedPath(`/w/${encodeURIComponent(bot.worldHandle)}/u/${encodeURIComponent(bot.handle)}/loop?inference=${seq}&sourceBot=${encodeURIComponent(botId)}&runId=${encodeURIComponent(runId)}`, request);
};

function single(value: string | string[]): string {
	return Array.isArray(value) ? value[0] ?? "" : value;
}
