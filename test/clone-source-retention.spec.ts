import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { localizedText, type BotDocument } from "@bickr/shared/model";
import { botById, rawBotById } from "@bickr/shared/repository";
import { parseLanguageTag } from "@bickr/shared/validation";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";
import { createBot, createWorld, upsertProviderUser } from "./helpers/coordinator-mutations";

const language = parseLanguageTag("en");

beforeEach(async () => {
	await resetD1Schema(env.BICKR_D1);
	await clearKv(env.BICKR_KV);
});

async function fixture() {
	const owner = await upsertProviderUser(env.BICKR_KV, env.BICKR_D1, { provider: "github", subject: "clone-retention", login: "clone-retention" });
	const world = await createWorld(env.BICKR_KV, env.BICKR_D1, {
		handle: "clone-retention", language, name: localizedText("Clones", language), description: localizedText("Clone fixture", language),
	}, owner.id);
	const source = await createBot(env.BICKR_KV, env.BICKR_D1, world.handle, {
		handle: "source", language, displayName: localizedText("Source profile", language),
		shortBio: localizedText("Source biography", language), prompt: localizedText("Source prompt", language),
	}, owner.id);
	const clone = await createBot(env.BICKR_KV, env.BICKR_D1, world.handle, {
		handle: "clone", language, displayName: localizedText("", language),
		shortBio: localizedText("", language), prompt: localizedText("", language), cloneSourceBotId: source.id,
	}, owner.id);
	return { owner, source, clone };
}

describe("retained linked clone sources", () => {
	it("renders a live clone after its source tombstone without exposing the source as active", async () => {
		const { source, clone } = await fixture();
		const original = await rawBotById(env.BICKR_KV, env.BICKR_D1, source.id);
		const now = new Date().toISOString();
		const tombstone: BotDocument = { ...original, handle: `deleted-${source.id}`, handleAtDeletion: source.handle, deletedAt: now, revision: original.revision + 1 };
		await env.BICKR_KV.put(`v1:bot:${source.id}`, JSON.stringify(tombstone));
		await env.BICKR_D1.prepare("UPDATE bots_index SET deleted_at = ?, handle = ?, lifecycle_state = 'deleting' WHERE bot_id = ?")
			.bind(now, tombstone.handle, source.id).run();
		const rendered = await botById(env.BICKR_KV, env.BICKR_D1, clone.id);
		expect(rendered.displayName.text).toBe("Source profile");
		expect(rendered.prompt.text).toBe("Source prompt");
		expect(rendered.cloneSource?.sourceBot?.handle).toBe("source");
		await expect(botById(env.BICKR_KV, env.BICKR_D1, source.id)).rejects.toMatchObject({ code: "not_found" });
		await expect(rawBotById(env.BICKR_KV, env.BICKR_D1, source.id)).rejects.toMatchObject({ code: "not_found" });
	});

	it("rejects retained source data with a different owner", async () => {
		const { source, clone } = await fixture();
		const original = await rawBotById(env.BICKR_KV, env.BICKR_D1, source.id);
		await env.BICKR_KV.put(`v1:bot:${source.id}`, JSON.stringify({ ...original, ownerUserId: "another-owner" }));
		await expect(botById(env.BICKR_KV, env.BICKR_D1, clone.id)).rejects.toMatchObject({
			code: "server_error", message: "Linked clone source belongs to a different profile.",
		});
	});
});
