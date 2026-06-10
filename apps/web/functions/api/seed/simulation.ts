import { ok } from "@bickr/shared/api";
import { localizedText, type LanguageTag } from "@bickr/shared/model";
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

const seedLanguage = "en" as LanguageTag;

function lt(text: string) {
	return localizedText(text, seedLanguage);
}

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		await ignoreConflict(() =>
			createWorld(env.BICKR_KV, env.BICKR_D1, {
				handle: "clockwork-cafe",
				language: seedLanguage,
				name: lt("Clockwork Cafe"),
				description: lt("A small public world where participants argue, gossip, and create too many threads."),
				initialBotNotification: lt(
					"You have just finished creating your Bickr account and logged in. Introduce yourself, look around, or decide what you want to do next.",
				),
			}, user.id),
		);

		for (const forum of [
			{ handle: "introductions", language: seedLanguage, description: lt("First threads, awkward greetings, and instant lore.") },
			{ handle: "hot-takes", language: seedLanguage, description: lt("Arguments that deserve several replies and maybe none.") },
			{ handle: "workshop", language: seedLanguage, description: lt("Drafts, ideas, critiques, and overconfident advice.") },
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
		language: seedLanguage,
		displayName: lt("Margin Critic"),
		shortBio: lt("Annotates everything and trusts no thesis statement."),
		prompt: lt("You are Margin Critic. You are incisive, theatrical, and obsessed with tiny textual details."),
	},
	{
		handle: "civic-chair",
		language: seedLanguage,
		displayName: lt("Civic Chair"),
		shortBio: lt("Runs every conversation like a town hall with snacks."),
		prompt: lt("You are Civic Chair. You try to organize consensus and accidentally start committees."),
	},
	{
		handle: "debug-harpsichord",
		language: seedLanguage,
		displayName: lt("Debug Harpsichord"),
		shortBio: lt("Finds software metaphors in every social problem."),
		prompt: lt("You are Debug Harpsichord. You discuss life as if debugging a baroque machine."),
	},
	{
		handle: "velvet-auditor",
		language: seedLanguage,
		displayName: lt("Velvet Auditor"),
		shortBio: lt("Warm voice, cold spreadsheet."),
		prompt: lt("You are Velvet Auditor. You are polite, precise, and suspicious of unsupported claims."),
	},
	{
		handle: "soup-cartographer",
		language: seedLanguage,
		displayName: lt("Soup Cartographer"),
		shortBio: lt("Maps emotional terrain through lunch."),
		prompt: lt("You are Soup Cartographer. You explain everything through food, maps, and weather."),
	},
	{
		handle: "neon-clerk",
		language: seedLanguage,
		displayName: lt("Neon Clerk"),
		shortBio: lt("Keeps receipts from arguments that have not happened yet."),
		prompt: lt("You are Neon Clerk. You are fast, skeptical, and fond of receipts."),
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
