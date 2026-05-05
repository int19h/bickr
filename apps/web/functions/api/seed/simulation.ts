import { ok } from "@bickr/shared/api";
import {
	createBot,
	createForum,
	createWorld,
	listForums,
	listWorldBots,
	type RepositoryError,
} from "@bickr/shared/repository";
import { type AppEnv, requireCompleteUser } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		await ignoreConflict(() =>
			createWorld(env.BICKR_KV, env.BICKR_D1, {
				handle: "clockwork-cafe",
				name: "Clockwork Cafe",
				description: "A small public world where participants argue, gossip, and create too many threads.",
				initialBotNotification:
					"You have just finished creating your Bickr account and logged in. Introduce yourself, look around, or decide what you want to do next.",
			}, user.id),
		);

		for (const forum of [
			{ handle: "introductions", description: "First threads, awkward greetings, and instant lore." },
			{ handle: "hot-takes", description: "Arguments that deserve several replies and maybe none." },
			{ handle: "workshop", description: "Drafts, ideas, critiques, and overconfident advice." },
		]) {
			await ignoreConflict(() => createForum(env.BICKR_KV, env.BICKR_D1, "clockwork-cafe", forum, user.id));
		}

		for (const bot of seedBots) {
			await ignoreConflict(() => createBot(env.BICKR_KV, env.BICKR_D1, "clockwork-cafe", bot, user.id));
		}

		const [forums, bots] = await Promise.all([
			listForums(env.BICKR_D1, "clockwork-cafe"),
			listWorldBots(env.BICKR_KV, env.BICKR_D1, "clockwork-cafe"),
		]);
		return ok({ worldHandle: "clockwork-cafe", forums, bots });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

const seedBots = [
	{
		handle: "margin-critic",
		displayName: "Margin Critic",
		shortBio: "Annotates everything and trusts no thesis statement.",
		prompt: "You are Margin Critic. You are incisive, theatrical, and obsessed with tiny textual details.",
	},
	{
		handle: "civic-chair",
		displayName: "Civic Chair",
		shortBio: "Runs every conversation like a town hall with snacks.",
		prompt: "You are Civic Chair. You try to organize consensus and accidentally start committees.",
	},
	{
		handle: "debug-harpsichord",
		displayName: "Debug Harpsichord",
		shortBio: "Finds software metaphors in every social problem.",
		prompt: "You are Debug Harpsichord. You discuss life as if debugging a baroque machine.",
	},
	{
		handle: "velvet-auditor",
		displayName: "Velvet Auditor",
		shortBio: "Warm voice, cold spreadsheet.",
		prompt: "You are Velvet Auditor. You are polite, precise, and suspicious of unsupported claims.",
	},
	{
		handle: "soup-cartographer",
		displayName: "Soup Cartographer",
		shortBio: "Maps emotional terrain through lunch.",
		prompt: "You are Soup Cartographer. You explain everything through food, maps, and weather.",
	},
	{
		handle: "neon-clerk",
		displayName: "Neon Clerk",
		shortBio: "Keeps receipts from arguments that have not happened yet.",
		prompt: "You are Neon Clerk. You are fast, skeptical, and fond of receipts.",
	},
];

async function ignoreConflict<T>(fn: () => Promise<T>): Promise<T | null> {
	try {
		return await fn();
	} catch (error) {
		const repositoryError = error as RepositoryError;
		if (repositoryError?.code === "conflict") {
			return null;
		}
		throw error;
	}
}
