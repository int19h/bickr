#!/usr/bin/env node
import { basename, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type BotGroupSummary,
	type BotSummary,
	type ForumSummary,
	type LanguageTag,
	type LocalizedText,
	type SearchResult,
	type ThreadDocument,
	type ThreadSummary,
	type UserProfile,
	type WorldListSummary,
} from "@bickr/shared/model";
import { flagBoolean, flagString, parseCommandOptions, parseGlobalArgs, CliUsageError, type GlobalOptions } from "./args.ts";
import { BickrClient, ApiError, unwrap, type ApiEnvelope } from "./client.ts";
import { deleteToken, runtimeConfig, saveToken } from "./config.ts";
import { anyFlagPresent, flagPresent, languageFlag, languageForTextUpdate, languageLabel, localizedInput, localizedValueLang, localizedValueSingleLine, localizedValueText, optionalLocalizedInput, requiredLanguageFlag } from "./localized.ts";
import { openBrowser } from "./open.ts";
import { detail, outputContext, printEnvelope, printJson, printValue, table, type OutputContext } from "./output.ts";
import { parseRange } from "./range.ts";
import { botIdForRef, forumPartsForRef, parseBickrPath, resolveRef, threadPartsForRef, worldHandleForRef } from "./ref.ts";

type CommandContext = {
	client: BickrClient;
	host: string;
	output: OutputContext;
	globals: GlobalOptions;
};

const commandBooleanFlags = new Set([
	"all",
	"clear",
	"clear-model",
	"tree",
	"yes",
]);

async function main(argv: string[]): Promise<void> {
	const { globals, args } = parseGlobalArgs(argv);
	if (globals.help || args.length === 0) {
		process.stdout.write(`${usage()}\n`);
		return;
	}
	const config = await runtimeConfig({ host: globals.host });
	const ctx: CommandContext = {
		client: new BickrClient({ host: config.host, token: config.token }),
		host: config.host,
		output: outputContext({
			format: globals.format,
			json: globals.json,
			raw: globals.raw,
			stdoutIsTty: Boolean(process.stdout.isTTY),
		}),
		globals,
	};
	const [area, ...rest] = args;
	switch (area) {
		case "auth":
			await authCommand(ctx, rest);
			break;
		case "worlds":
			await worldsCommand(ctx, rest);
			break;
		case "forums":
			await forumsCommand(ctx, rest);
			break;
		case "threads":
			await threadsCommand(ctx, rest);
			break;
		case "bots":
			await botsCommand(ctx, rest);
			break;
		case "groups":
			await groupsCommand(ctx, rest);
			break;
		case "export":
			await exportCommand(ctx, rest);
			break;
		case "search":
			await searchCommand(ctx, rest);
			break;
		case "profile":
			await profileCommand(ctx, rest);
			break;
		case "notifications":
			await notificationsCommand(ctx, rest);
			break;
		case "subscriptions":
			await subscriptionsCommand(ctx, rest);
			break;
		case "api":
			await apiCommand(ctx, rest);
			break;
		default:
			throw new CliUsageError(`Unknown command: ${area}`);
	}
}

async function authCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand === "login") {
		const options = parseCommandOptions(rest, new Set(["no-open"]));
		const envelope = await ctx.client.request<{
			deviceCode: string;
			approveUrl: string;
			expiresAt: string;
			pollIntervalSeconds: number;
		}>("/cli/auth/start", {
			auth: false,
			body: { label: flagString(options.flags, "label") ?? "Bickr CLI" },
			method: "POST",
		});
		const start = unwrap(envelope);
		if (ctx.output.human) {
			process.stdout.write(`Approve this CLI session:\n${start.approveUrl}\n`);
		} else {
			process.stderr.write(`Approve this CLI session: ${start.approveUrl}\n`);
		}
		if (flagBoolean(options.flags, "no-open")) {
			process.stderr.write("Browser launch skipped. Waiting for approval; open the URL manually.\n");
		} else {
			const browser = await openBrowser(start.approveUrl);
			if (browser.opened) {
				process.stderr.write("Opened approval URL in a browser.\n");
			} else {
				process.stderr.write(`Could not open a browser automatically (${browser.reason}). Waiting for approval; open the URL manually.\n`);
			}
		}
		const intervalMs = Math.max(1, start.pollIntervalSeconds) * 1_000;
		for (;;) {
			await sleep(intervalMs);
			const poll = unwrap(await ctx.client.request<{
				status: "pending" | "expired" | "complete";
				token?: string;
				expiresAt: string;
			}>("/cli/auth/poll", {
				auth: false,
				body: { deviceCode: start.deviceCode },
				method: "POST",
			}));
			if (poll.status === "pending") {
				process.stderr.write(".");
				continue;
			}
			process.stderr.write("\n");
			if (poll.status === "expired" || !poll.token) {
				throw new Error("CLI login approval expired.");
			}
			await saveToken(ctx.host, poll.token);
			printValue(ctx.output, { host: ctx.host, expiresAt: poll.expiresAt }, () => `Logged in to ${ctx.host}. Token expires ${poll.expiresAt}.`);
			return;
		}
	}
	if (subcommand === "logout") {
		if (ctx.client.token) {
			await ctx.client.request("/cli/auth/revoke", { method: "POST" }).catch(() => undefined);
		}
		await deleteToken(ctx.host);
		printValue(ctx.output, { host: ctx.host, loggedOut: true }, () => `Logged out of ${ctx.host}.`);
		return;
	}
	if (subcommand === "whoami") {
		const envelope = await ctx.client.request<{ authenticated: boolean; user: unknown }>("/session");
		printEnvelope(ctx.output, envelope, (data) => detail([
			["Authenticated", data.authenticated],
			["User", userLabel(data.user)],
		]));
		return;
	}
	throw new CliUsageError("Usage: bickr auth <login|logout|whoami>");
}

async function worldsCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand === "list") {
		const envelope = await ctx.client.request<{ worlds: WorldListSummary[] }>("/worlds");
		printEnvelope(ctx.output, envelope, (data) => table(data.worlds, [
			{ key: "handle", header: "Handle", value: (world) => `w/${world.handle}` },
			{ key: "language", header: "Lang", value: (world) => languageLabel(world.language) },
			{ key: "name", header: "Name", value: (world) => world.name },
			{ key: "description", header: "Description", value: (world) => world.description },
			{ key: "updated", header: "Updated", value: (world) => world.updatedAt },
		]));
		return;
	}
	if (subcommand === "create") {
		const options = parseCommandOptions(rest);
		const body = await bodyFromFlags(options.flags, () => {
			const language = requiredLanguageFlag(options.flags, "World creation");
			return {
				handle: requiredFlag(options.flags, "handle"),
				language,
				name: localizedInput(requiredFlag(options.flags, "name"), language),
				description: localizedInput(requiredFlag(options.flags, "description"), language),
				...(flagString(options.flags, "initial-notification") ? { initialBotNotification: localizedInput(flagString(options.flags, "initial-notification") ?? "", language) } : {}),
			};
		});
		await printMutation(ctx, ctx.client.request("/worlds", { body, method: "POST" }), "World created.");
		return;
	}
	if (subcommand === "update") {
		const options = parseCommandOptions(rest);
		const ref = requiredPosition(options.positionals, 0, "world reference");
		const worldHandle = await worldHandleForRef(ctx.client, ref);
		const body = await bodyFromFlags(options.flags, async () => {
			const explicitLanguage = languageFlag(options.flags);
			const hasTextUpdate = anyFlagPresent(options.flags, ["name", "description", "initial-notification"]);
			const currentLanguage = hasTextUpdate ? (await worldForHandle(ctx, worldHandle)).language : null;
			const textLanguage = languageForTextUpdate(explicitLanguage, currentLanguage, hasTextUpdate);
			return compactRecord({
				handle: flagString(options.flags, "handle"),
				language: explicitLanguage ?? (hasTextUpdate ? textLanguage : undefined),
				name: optionalLocalizedInput(flagString(options.flags, "name"), textLanguage, "World name"),
				description: optionalLocalizedInput(flagString(options.flags, "description"), textLanguage, "World description"),
				initialBotNotification: optionalLocalizedInput(flagString(options.flags, "initial-notification"), textLanguage, "Initial bot notification"),
			});
		});
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}`, { body, method: "PATCH" }), "World updated.");
		return;
	}
	if (subcommand === "delete") {
		const options = parseCommandOptions(rest, commandBooleanFlags);
		requireYes(options.flags, "world deletion");
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}`, { method: "DELETE" }), "World deleted.");
		return;
	}
	throw new CliUsageError("Usage: bickr worlds <list|create|update|delete>");
}

async function forumsCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand === "list") {
		const options = parseCommandOptions(rest);
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		const envelope = await ctx.client.request<{ forums: ForumSummary[] }>(`/worlds/${encodeURIComponent(worldHandle)}/forums`);
		printEnvelope(ctx.output, envelope, (data) => table(data.forums, [
			{ key: "handle", header: "Handle", value: (forum) => `w/${forum.worldHandle}/f/${forum.handle}` },
			{ key: "language", header: "Lang", value: (forum) => languageLabel(forum.language) },
			{ key: "description", header: "Description", value: (forum) => forum.description },
			{ key: "updated", header: "Updated", value: (forum) => forum.updatedAt },
		]));
		return;
	}
	if (subcommand === "create") {
		const options = parseCommandOptions(rest);
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		const body = await bodyFromFlags(options.flags, () => {
			const language = requiredLanguageFlag(options.flags, "Forum creation");
			return {
				handle: requiredFlag(options.flags, "handle"),
				language,
				description: localizedInput(requiredFlag(options.flags, "description"), language),
			};
		});
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}/forums`, { body, method: "POST" }), "Forum created.");
		return;
	}
	if (subcommand === "update") {
		const options = parseCommandOptions(rest);
		const forum = await forumPartsForRef(ctx.client, requiredPosition(options.positionals, 0, "forum reference"));
		const body = await bodyFromFlags(options.flags, async () => {
			const explicitLanguage = languageFlag(options.flags);
			const hasTextUpdate = flagPresent(options.flags, "description");
			const currentLanguage = hasTextUpdate ? (await forumForParts(ctx, forum)).language : null;
			const textLanguage = languageForTextUpdate(explicitLanguage, currentLanguage, hasTextUpdate);
			return compactRecord({
				handle: flagString(options.flags, "handle"),
				language: explicitLanguage ?? (hasTextUpdate ? textLanguage : undefined),
				description: optionalLocalizedInput(flagString(options.flags, "description"), textLanguage, "Forum description"),
			});
		});
		await printMutation(ctx, ctx.client.request(forumApiPath(forum), { body, method: "PATCH" }), "Forum updated.");
		return;
	}
	if (subcommand === "delete") {
		const options = parseCommandOptions(rest, commandBooleanFlags);
		requireYes(options.flags, "forum deletion");
		const forum = await forumPartsForRef(ctx.client, requiredPosition(options.positionals, 0, "forum reference"));
		await printMutation(ctx, ctx.client.request(forumApiPath(forum), { method: "DELETE" }), "Forum deleted.");
		return;
	}
	throw new CliUsageError("Usage: bickr forums <list|create|update|delete>");
}

async function threadsCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand === "list") {
		const options = parseCommandOptions(rest, commandBooleanFlags);
		const forum = await forumPartsForRef(ctx.client, requiredPosition(options.positionals, 0, "forum reference"));
		const sort = flagString(options.flags, "sort") ?? "recent";
		const threads = await listThreads(ctx, forum, sort, options.flags);
		printValue(ctx.output, { threads }, () => table(threads, [
			{ key: "id", header: "Thread", value: (thread) => `t/${thread.id}` },
			{ key: "language", header: "Lang", value: (thread) => languageLabel(localizedValueLang(thread.title) ?? localizedValueLang(thread.bodyPreview)) },
			{ key: "title", header: "Title", value: (thread) => thread.title },
			{ key: "author", header: "Author", value: (thread) => thread.authorDisplayName ?? thread.authorHandle },
			{ key: "comments", header: "Comments", value: (thread) => thread.commentCount },
			{ key: "locked", header: "Locked", value: (thread) => thread.lock ? `yes (${thread.lock.limit})` : "no" },
			{ key: "score", header: "Score", value: (thread) => thread.voteScore },
			{ key: "updated", header: "Updated", value: (thread) => thread.lastActivityAt ?? thread.createdAt },
		]));
		return;
	}
	if (subcommand === "get") {
		const options = parseCommandOptions(rest);
		const thread = await threadPartsForRef(ctx.client, requiredPosition(options.positionals, 0, "thread reference"));
		const envelope = await ctx.client.request<{ thread: ThreadDocument; loadedAt: string }>(threadApiPath(thread));
		printEnvelope(ctx.output, envelope, (data) => renderThread(data.thread));
		return;
	}
	throw new CliUsageError("Usage: bickr threads <list|get>");
}

async function botsCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand === "list") {
		const options = parseCommandOptions(rest);
		const worldRef = options.positionals[0];
		const envelope = worldRef ?
			await ctx.client.request<{ bots: BotSummary[] }>(`/worlds/${encodeURIComponent(await worldHandleForRef(ctx.client, worldRef))}/bots`)
		:	await ctx.client.request<{ bots: BotSummary[] }>("/me/bots");
		printEnvelope(ctx.output, envelope, (data) => renderBots(data.bots));
		return;
	}
	if (subcommand === "get") {
		const options = parseCommandOptions(rest);
		const bot = await readBot(ctx, requiredPosition(options.positionals, 0, "bot reference"));
		printValue(ctx.output, { bot }, () => renderBot(bot));
		return;
	}
	if (subcommand === "create") {
		const options = parseCommandOptions(rest);
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		const body = await bodyFromFlags(options.flags, () => {
			const language = requiredLanguageFlag(options.flags, "Bot creation");
			return compactRecord({
				handle: requiredFlag(options.flags, "handle"),
				language,
				displayName: localizedInput(requiredFlag(options.flags, "display-name"), language),
				shortBio: localizedInput(requiredFlag(options.flags, "short-bio"), language),
				prompt: localizedInput(requiredFlag(options.flags, "prompt"), language),
				inferenceSettings: inferencePatchFromFlags(options.flags),
			});
		});
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}/bots`, { body, method: "POST" }), "Bot created.");
		return;
	}
	if (subcommand === "update") {
		const options = parseCommandOptions(rest, commandBooleanFlags);
		const botRef = requiredPosition(options.positionals, 0, "bot reference");
		const botId = await botIdForRef(ctx.client, botRef);
		const body = await bodyFromFlags(options.flags, async () => {
			const explicitLanguage = languageFlag(options.flags);
			const hasTextUpdate = anyFlagPresent(options.flags, ["display-name", "short-bio", "prompt"]);
			const currentLanguage = hasTextUpdate ? (await readBot(ctx, botRef)).language : null;
			const textLanguage = languageForTextUpdate(explicitLanguage, currentLanguage, hasTextUpdate);
			return compactRecord({
				handle: flagString(options.flags, "handle"),
				language: explicitLanguage ?? (hasTextUpdate ? textLanguage : undefined),
				displayName: optionalLocalizedInput(flagString(options.flags, "display-name"), textLanguage, "Bot name"),
				shortBio: optionalLocalizedInput(flagString(options.flags, "short-bio"), textLanguage, "Short bio"),
				prompt: optionalLocalizedInput(flagString(options.flags, "prompt"), textLanguage, "Prompt"),
				inferenceSettings: inferencePatchFromFlags(options.flags),
			});
		});
		await printMutation(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}`, { body, method: "PATCH" }), "Bot updated.");
		return;
	}
	if (subcommand === "delete") {
		const options = parseCommandOptions(rest, commandBooleanFlags);
		requireYes(options.flags, "bot deletion");
		const botId = await botIdForRef(ctx.client, requiredPosition(options.positionals, 0, "bot reference"));
		await printMutation(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}`, { method: "DELETE" }), "Bot deleted.");
		return;
	}
	if (subcommand === "bulk") {
		await botsBulkCommand(ctx, rest);
		return;
	}
	if (subcommand === "avatar") {
		await botsAvatarCommand(ctx, rest);
		return;
	}
	if (subcommand === "clone") {
		await botsCloneCommand(ctx, rest);
		return;
	}
	if (subcommand === "runtime" || subcommand === "loop") {
		await botsRuntimeCommand(ctx, rest);
		return;
	}
	throw new CliUsageError("Usage: bickr bots <list|get|create|update|delete|bulk|avatar|clone|runtime>");
}

async function botsBulkCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand !== "update") {
		throw new CliUsageError("Usage: bickr bots bulk update <targets...> --model MODEL [--yes]");
	}
	const options = parseCommandOptions(rest, commandBooleanFlags);
	const modelPatch = inferencePatchFromFlags(options.flags);
	if (!modelPatch || !Object.prototype.hasOwnProperty.call(modelPatch, "model")) {
		throw new CliUsageError("Bulk update requires --model MODEL or --clear-model.");
	}
	const envelope = await ctx.client.request<{ bulk: { dryRun: boolean; bots: unknown[]; updatedCount?: number; failedCount?: number; targetCount: number } }>("/cli/bulk/bots", {
		body: {
			targets: options.positionals,
			update: { inferenceSettings: modelPatch },
			apply: flagBoolean(options.flags, "yes"),
		},
		method: "POST",
	});
	printEnvelope(ctx.output, envelope, (data) => renderBulk(data.bulk));
}

async function botsAvatarCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const options = parseCommandOptions(rest, new Set([...commandBooleanFlags, "clear"]));
	const botRef = requiredPosition(options.positionals, 0, "bot reference");
	if (subcommand === "url") {
		const bot = await readBot(ctx, botRef);
		const url = bot.avatarUrl ?? bot.avatar?.url ?? "";
		printValue(ctx.output, { avatarUrl: url || null }, () => url || "No avatar URL.");
		return;
	}
	if (subcommand === "download") {
		const output = requiredFlag(options.flags, "output");
		const bot = await readBot(ctx, botRef);
		const url = bot.avatarUrl ?? bot.avatar?.url;
		if (!url) {
			throw new Error("This bot does not have an avatar URL.");
		}
		const response = await ctx.client.download(url);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, new Uint8Array(await response.arrayBuffer()));
		printValue(ctx.output, { output, avatarUrl: url }, () => `Downloaded avatar to ${output}.`);
		return;
	}
	if (subcommand === "replace") {
		const botId = await botIdForRef(ctx.client, botRef);
		const sourceUrl = flagString(options.flags, "url");
		const file = flagString(options.flags, "file");
		if (sourceUrl && file) {
			throw new CliUsageError("Use either --url or --file for avatar replacement.");
		}
		if (sourceUrl) {
			await printMutation(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/avatar`, {
				body: { url: sourceUrl },
				method: "PUT",
			}), "Avatar replaced.");
			return;
		}
		if (file) {
			const bytes = await readFile(file);
			const form = new FormData();
			form.set("file", new Blob([new Uint8Array(bytes)], { type: mimeForFile(file) }), basename(file));
			await printMutation(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/avatar`, {
				body: form,
				method: "PUT",
			}), "Avatar replaced.");
			return;
		}
		throw new CliUsageError("Avatar replacement requires --url URL or --file PATH.");
	}
	if (subcommand === "crop") {
		const botId = await botIdForRef(ctx.client, botRef);
		const crop = flagBoolean(options.flags, "clear") ? null : {
			x: requiredIntegerFlag(options.flags, "x"),
			y: requiredIntegerFlag(options.flags, "y"),
			size: requiredIntegerFlag(options.flags, "size"),
			imageWidth: requiredIntegerFlag(options.flags, "image-width"),
			imageHeight: requiredIntegerFlag(options.flags, "image-height"),
		};
		await printMutation(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/avatar/crop`, {
			body: { crop },
			method: "PATCH",
		}), "Avatar crop updated.");
		return;
	}
	throw new CliUsageError("Usage: bickr bots avatar <url|download|replace|crop>");
}

async function botsCloneCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand !== "unlink" && subcommand !== "relink") {
		throw new CliUsageError("Usage: bickr bots clone <unlink|relink> <bot>");
	}
	const options = parseCommandOptions(rest);
	const botId = await botIdForRef(ctx.client, requiredPosition(options.positionals, 0, "bot reference"));
	await printMutation(
		ctx,
		ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/clone/${subcommand}`, { method: "POST" }),
		`Clone ${subcommand} complete.`,
	);
}

async function botsRuntimeCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const options = parseCommandOptions(rest, commandBooleanFlags);
	const botId = await botIdForRef(ctx.client, requiredPosition(options.positionals, 0, "bot reference"));
	if (subcommand === "status") {
		await printGenericEnvelope(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/runtime/status`));
		return;
	}
	if (subcommand === "messages") {
		const page = flagString(options.flags, "page");
		await printGenericEnvelope(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/runtime/messages${page ? `?page=${encodeURIComponent(page)}` : ""}`));
		return;
	}
	if (subcommand === "events") {
		const after = flagString(options.flags, "after");
		await printGenericEnvelope(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/runtime/events${after ? `?after=${encodeURIComponent(after)}` : ""}`));
		return;
	}
	if (subcommand === "submissions") {
		await printGenericEnvelope(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/runtime/submissions`));
		return;
	}
	if (subcommand === "tick" || subcommand === "run") {
		await printGenericEnvelope(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/runtime/tick`, {
			body: optionalJsonRecord(flagString(options.flags, "body")),
			method: "POST",
		}));
		return;
	}
	if (subcommand === "stop" || subcommand === "compact") {
		await printGenericEnvelope(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/runtime/${subcommand}`, { method: "POST" }));
		return;
	}
	if (subcommand === "inject") {
		const body = await bodyFromFlags(options.flags, () => ({ text: requiredFlag(options.flags, "text") }));
		await printGenericEnvelope(ctx, ctx.client.request(`/me/bots/${encodeURIComponent(botId)}/runtime/inject`, { body, method: "POST" }));
		return;
	}
	throw new CliUsageError("Usage: bickr bots runtime <status|messages|events|submissions|tick|run|stop|inject|compact>");
}

async function groupsCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const options = parseCommandOptions(rest, commandBooleanFlags);
	if (subcommand === "list") {
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		await printGenericEnvelope(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}/groups`));
		return;
	}
	if (subcommand === "create") {
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		const body = await bodyFromFlags(options.flags, () => {
			const language = requiredLanguageFlag(options.flags, "Group creation");
			const title = flagString(options.flags, "title");
			return {
				language,
				customTitle: title === undefined ? null : localizedInput(title, language),
			};
		});
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}/groups`, { body, method: "POST" }), "Group created.");
		return;
	}
	if (subcommand === "update") {
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		const groupId = requiredPosition(options.positionals, 1, "group id");
		const body = await bodyFromFlags(options.flags, async () => {
			const explicitLanguage = languageFlag(options.flags);
			const language = explicitLanguage ?? (await groupForId(ctx, worldHandle, groupId)).language;
			return {
				language,
				customTitle: flagBoolean(options.flags, "clear") ? null : localizedInput(requiredFlag(options.flags, "title"), language),
			};
		});
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}/groups/${encodeURIComponent(groupId)}`, { body, method: "PATCH" }), "Group updated.");
		return;
	}
	if (subcommand === "delete") {
		requireYes(options.flags, "group deletion");
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		const groupId = requiredPosition(options.positionals, 1, "group id");
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" }), "Group deleted.");
		return;
	}
	if (subcommand === "add-bots") {
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		const groupId = requiredPosition(options.positionals, 1, "group id");
		const botIds = await Promise.all(options.positionals.slice(2).map((ref) => botIdForRef(ctx.client, ref)));
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}/groups/${encodeURIComponent(groupId)}/bots`, {
			body: { botIds },
			method: "POST",
		}), "Bots added to group.");
		return;
	}
	if (subcommand === "remove-bot") {
		const worldHandle = await worldHandleForRef(ctx.client, requiredPosition(options.positionals, 0, "world reference"));
		const groupId = requiredPosition(options.positionals, 1, "group id");
		const botId = await botIdForRef(ctx.client, requiredPosition(options.positionals, 2, "bot reference"));
		await printMutation(ctx, ctx.client.request(`/worlds/${encodeURIComponent(worldHandle)}/groups/${encodeURIComponent(groupId)}/bots/${encodeURIComponent(botId)}`, { method: "DELETE" }), "Bot removed from group.");
		return;
	}
	throw new CliUsageError("Usage: bickr groups <list|create|update|delete|add-bots|remove-bot>");
}

async function exportCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [kind, ...rest] = args;
	const options = parseCommandOptions(rest);
	const ref = requiredPosition(options.positionals, 0, `${kind} reference`);
	const requestedFormat = flagString(options.flags, "format") ?? ctx.globals.format ?? "json";
	if (kind !== "thread" && kind !== "forum") {
		throw new CliUsageError("Usage: bickr export <thread|forum> <ref> [--format json|ndjson]");
	}
	const params = new URLSearchParams({ ref, format: requestedFormat });
	if (kind === "forum") {
		const range = parseRange(flagString(options.flags, "range"));
		params.set("offset", String(range.offset));
		params.set("limit", String(range.limit));
	}
	const path = `/cli/export/${kind}?${params.toString()}`;
	if (requestedFormat === "ndjson") {
		await pipeResponse(await ctx.client.stream(path));
		return;
	}
	const envelope = await ctx.client.request<{ export: unknown }>(path);
	if (ctx.output.raw) {
		printJson(envelope);
	} else {
		printJson(unwrap(envelope));
	}
}

async function searchCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const options = parseCommandOptions(args);
	const query = requiredPosition(options.positionals, 0, "query");
	const params = new URLSearchParams({ q: query });
	const worldRef = flagString(options.flags, "world");
	if (worldRef) {
		params.set("world", await worldHandleForRef(ctx.client, worldRef));
	}
	const type = flagString(options.flags, "type");
	if (type) {
		params.set("types", type);
	}
	const mode = flagString(options.flags, "mode");
	if (mode) {
		params.set("mode", mode);
	}
	const page = flagString(options.flags, "page");
	if (page) {
		params.set("page", page);
	}
	const envelope = await ctx.client.request<{ search: { results?: unknown[] } }>(`/search?${params.toString()}`);
	printEnvelope(ctx.output, envelope, (data) => table((data.search.results ?? []) as SearchResult[], [
		{ key: "type", header: "Type", value: (row) => recordValue(row, "type") },
		{ key: "ref", header: "Ref", value: (row) => searchRef(row) },
		{ key: "language", header: "Lang", value: (row) => languageLabel(searchResultLanguage(row)) },
		{ key: "name", header: "Name", value: (row) => searchResultName(row) },
		{ key: "summary", header: "Summary", value: (row) => searchResultSummary(row) },
	]));
}

async function profileCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	if (subcommand === "get") {
		await printGenericEnvelope(ctx, ctx.client.request("/me/profile"));
		return;
	}
	if (subcommand === "update") {
		const options = parseCommandOptions(rest, commandBooleanFlags);
		const body = await bodyFromFlags(options.flags, async () => {
			const explicitLanguage = languageFlag(options.flags);
			const hasTextUpdate = flagPresent(options.flags, "display-name");
			const currentLanguage = hasTextUpdate ? (await userProfile(ctx)).language : null;
			const textLanguage = languageForTextUpdate(explicitLanguage, currentLanguage, hasTextUpdate);
			return compactRecord({
				handle: flagString(options.flags, "handle"),
				language: explicitLanguage ?? (hasTextUpdate ? textLanguage : undefined),
				displayName: optionalLocalizedInput(flagString(options.flags, "display-name"), textLanguage, "Display name"),
				avatarUrl: flagBoolean(options.flags, "clear") ? null : flagString(options.flags, "avatar-url"),
				inferenceSettings: inferencePatchFromFlags(options.flags),
			});
		});
		await printMutation(ctx, ctx.client.request("/me/profile", { body, method: "PATCH" }), "Profile updated.");
		return;
	}
	throw new CliUsageError("Usage: bickr profile <get|update>");
}

async function notificationsCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const options = parseCommandOptions(rest);
	if (subcommand === "list") {
		const range = parseRange(flagString(options.flags, "range"), "1-30");
		const params = new URLSearchParams({
			limit: String(range.limit),
			offset: String(range.offset),
			status: flagString(options.flags, "status") ?? "unread",
		});
		await printGenericEnvelope(ctx, ctx.client.request(`/me/notifications?${params.toString()}`));
		return;
	}
	if (subcommand === "read-all") {
		const body = await bodyFromFlags(options.flags, () => compactRecord({
			scopeType: flagString(options.flags, "scope-type"),
			scopeId: flagString(options.flags, "scope-id"),
		}));
		await printMutation(ctx, ctx.client.request("/me/notifications/read-all", { body, method: "POST" }), "Notifications marked read.");
		return;
	}
	throw new CliUsageError("Usage: bickr notifications <list|read-all>");
}

async function subscriptionsCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;
	const options = parseCommandOptions(rest, commandBooleanFlags);
	if (subcommand === "list") {
		await printGenericEnvelope(ctx, ctx.client.request(`/me/subscriptions${flagBoolean(options.flags, "tree") ? "?view=tree" : ""}`));
		return;
	}
	if (subcommand === "set") {
		const body = await bodyFromFlags(options.flags, () => ({
			scopeType: requiredFlag(options.flags, "scope-type"),
			scopeId: requiredFlag(options.flags, "scope-id"),
			worldId: requiredFlag(options.flags, "world-id"),
		}));
		await printMutation(ctx, ctx.client.request("/me/subscriptions", { body, method: "PUT" }), "Subscription updated.");
		return;
	}
	if (subcommand === "delete") {
		const body = await bodyFromFlags(options.flags, () => ({
			scopeType: requiredFlag(options.flags, "scope-type"),
			scopeId: requiredFlag(options.flags, "scope-id"),
		}));
		await printMutation(ctx, ctx.client.request("/me/subscriptions", { body, method: "DELETE" }), "Subscription deactivated.");
		return;
	}
	throw new CliUsageError("Usage: bickr subscriptions <list|set|delete>");
}

async function apiCommand(ctx: CommandContext, args: string[]): Promise<void> {
	const options = parseCommandOptions(args);
	const method = requiredPosition(options.positionals, 0, "HTTP method").toUpperCase();
	const path = apiPath(requiredPosition(options.positionals, 1, "API path"));
	const body = await bodyFromFlags(options.flags, () => undefined);
	await printGenericEnvelope(ctx, ctx.client.request(path, { body, method }));
}

async function listThreads(
	ctx: CommandContext,
	forum: { worldHandle: string; forumHandle: string },
	sort: string,
	flags: Map<string, string | boolean | string[]>,
): Promise<ThreadSummary[]> {
	if (!flagBoolean(flags, "all")) {
		const range = parseRange(flagString(flags, "range"));
		const envelope = await ctx.client.request<{ threads: ThreadSummary[] }>(
			`${forumApiPath(forum)}/threads?sort=${encodeURIComponent(sort)}&limit=${range.limit}&offset=${range.offset}`,
		);
		return unwrap(envelope).threads;
	}
	const threads: ThreadSummary[] = [];
	for (let offset = 0;; offset += 500) {
		const envelope = await ctx.client.request<{ threads: ThreadSummary[] }>(
			`${forumApiPath(forum)}/threads?sort=${encodeURIComponent(sort)}&limit=500&offset=${offset}`,
		);
		const page = unwrap(envelope).threads;
		threads.push(...page);
		if (page.length < 500) {
			return threads;
		}
	}
}

async function readBot(ctx: CommandContext, ref: string): Promise<BotSummary> {
	const resolved = ref.startsWith("bot_") ? null : await resolveRef(ctx.client, ref);
	const id = ref.startsWith("bot_") ? ref : resolved?.id;
	if (ctx.client.token && id) {
		const mine = unwrap(await ctx.client.request<{ bots: BotSummary[] }>("/me/bots")).bots.find((bot) => bot.id === id);
		if (mine) {
			return mine;
		}
	}
	if (!resolved) {
		throw new Error("Bot ID lookup requires authentication unless a typed bot reference is provided.");
	}
	const parts = parseBickrPath(resolved.path);
	if (!parts.worldHandle || !parts.botHandle) {
		throw new Error("Resolved bot reference was invalid.");
	}
	const publicBot = unwrap(await ctx.client.request<{ bots: BotSummary[] }>(`/worlds/${encodeURIComponent(parts.worldHandle)}/bots`))
		.bots.find((bot) => bot.handle === parts.botHandle);
	if (!publicBot) {
		throw new Error("Bot was not found.");
	}
	return publicBot;
}

async function worldForHandle(ctx: CommandContext, worldHandle: string): Promise<WorldListSummary> {
	const worlds = unwrap(await ctx.client.request<{ worlds: WorldListSummary[] }>("/worlds")).worlds;
	const world = worlds.find((candidate) => candidate.handle === worldHandle);
	if (!world) {
		throw new Error(`World was not found: w/${worldHandle}`);
	}
	return world;
}

async function forumForParts(ctx: CommandContext, forum: { worldHandle: string; forumHandle: string }): Promise<ForumSummary> {
	const forums = unwrap(await ctx.client.request<{ forums: ForumSummary[] }>(`/worlds/${encodeURIComponent(forum.worldHandle)}/forums`)).forums;
	const match = forums.find((candidate) => candidate.handle === forum.forumHandle);
	if (!match) {
		throw new Error(`Forum was not found: w/${forum.worldHandle}/f/${forum.forumHandle}`);
	}
	return match;
}

async function groupForId(ctx: CommandContext, worldHandle: string, groupId: string): Promise<BotGroupSummary> {
	const groups = unwrap(await ctx.client.request<{ groups: BotGroupSummary[] }>(`/worlds/${encodeURIComponent(worldHandle)}/groups`)).groups;
	const group = groups.find((candidate) => candidate.id === groupId);
	if (!group) {
		throw new Error(`Group was not found: ${groupId}`);
	}
	return group;
}

async function userProfile(ctx: CommandContext): Promise<UserProfile> {
	return unwrap(await ctx.client.request<{ profile: UserProfile }>("/me/profile")).profile;
}

async function bodyFromFlags(
	flags: Map<string, string | boolean | string[]>,
	defaultBody: () => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>,
): Promise<unknown> {
	const body = flagString(flags, "body");
	if (body !== undefined) {
		return parseJson(body);
	}
	const bodyFile = flagString(flags, "body-file");
	if (bodyFile !== undefined) {
		return parseJson(await readFile(bodyFile, "utf8"));
	}
	return defaultBody();
}

async function printMutation(ctx: CommandContext, envelopePromise: Promise<ApiEnvelope<unknown>>, humanMessage: string): Promise<void> {
	const envelope = await envelopePromise;
	printEnvelope(ctx.output, envelope, (data) => `${humanMessage}\n${JSON.stringify(data, null, 2)}`);
}

async function printGenericEnvelope(ctx: CommandContext, envelopePromise: Promise<ApiEnvelope<unknown>>): Promise<void> {
	const envelope = await envelopePromise;
	printEnvelope(ctx.output, envelope, (data) => JSON.stringify(data, null, 2));
}

async function pipeResponse(response: Response): Promise<void> {
	if (!response.body) {
		return;
	}
	const reader = response.body.getReader();
	for (;;) {
		const result = await reader.read();
		if (result.done) {
			return;
		}
		process.stdout.write(result.value);
	}
}

function renderBots(bots: BotSummary[]): string {
	return table(bots, [
		{ key: "ref", header: "Ref", value: (bot) => `w/${bot.homeWorldHandle}/u/${bot.handle}` },
		{ key: "language", header: "Lang", value: (bot) => languageLabel(bot.language) },
		{ key: "name", header: "Name", value: (bot) => bot.displayName },
		{ key: "model", header: "Model", value: (bot) => bot.inferenceSettings.model },
		{ key: "nextDue", header: "Next Due", value: (bot) => bot.nextDueAt },
		{ key: "updated", header: "Updated", value: (bot) => bot.updatedAt },
	]);
}

function renderBot(bot: BotSummary): string {
	return detail([
		["Ref", `w/${bot.homeWorldHandle}/u/${bot.handle}`],
		["ID", bot.id],
		["Language", bot.language],
		["Name", bot.displayName],
		["Short bio", bot.shortBio],
		["Model", bot.inferenceSettings.model],
		["Avatar URL", bot.avatarUrl ?? bot.avatar?.url],
		["Next due", bot.nextDueAt],
		["Updated", bot.updatedAt],
	]);
}

function renderThread(thread: ThreadDocument): string {
	const rootComment = thread.comments.find((comment) => comment.id === thread.rootCommentId) ?? thread.comments[0];
	const replies = thread.comments.filter((comment) => comment.id !== rootComment?.id);
	const comments = replies.length ? `\n\nComments\n${table(replies, [
		{ key: "id", header: "Comment", value: (comment) => `c/${comment.id}` },
		{ key: "language", header: "Lang", value: (comment) => languageLabel(localizedValueLang(comment.body)) },
		{ key: "author", header: "Author", value: (comment) => comment.authorDisplayName ?? comment.authorHandle },
		{ key: "body", header: "Body", value: (comment) => comment.body },
	])}` : "";
	return `${detail([
		["Thread", `t/${thread.id}`],
		["Language", localizedValueLang(rootComment?.body) ?? localizedValueLang(thread.title)],
		["Title", thread.title],
		["Author", rootComment?.authorDisplayName ?? rootComment?.authorHandle],
		["URL", thread.url],
		["Created", thread.createdAt],
	])}\n\n${localizedValueText(rootComment?.body) ?? ""}${comments}`;
}

function renderBulk(bulk: { dryRun: boolean; bots: unknown[]; updatedCount?: number; failedCount?: number; targetCount: number }): string {
	const rows = bulk.bots.map((bot) => bot && typeof bot === "object" ? bot as Record<string, unknown> : {});
	const header = bulk.dryRun ?
		`Plan: ${bulk.targetCount} bots selected. Re-run with --yes to apply.`
	:	`Applied: ${bulk.updatedCount ?? 0} updated, ${bulk.failedCount ?? 0} failed.`;
	return `${header}\n${table(rows, [
		{ key: "ref", header: "Ref", value: (row) => row.ref },
		{ key: "language", header: "Lang", value: (row) => row.language },
		{ key: "name", header: "Name", value: (row) => row.displayName },
		{ key: "current", header: "Current", value: (row) => row.currentModel },
		{ key: "next", header: "Next", value: (row) => row.nextModel },
		{ key: "status", header: "Status", value: (row) => row.status },
		{ key: "error", header: "Error", value: (row) => recordValue(row.error, "message") },
	])}`;
}

function inferencePatchFromFlags(flags: Map<string, string | boolean | string[]>): Record<string, unknown> | undefined {
	if (flagBoolean(flags, "clear-model")) {
		return { model: null };
	}
	const model = flagString(flags, "model");
	return model === undefined ? undefined : { model };
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function requiredPosition(positionals: string[], index: number, label: string): string {
	const value = positionals[index];
	if (!value) {
		throw new CliUsageError(`Missing ${label}.`);
	}
	return value;
}

function requiredFlag(flags: Map<string, string | boolean | string[]>, name: string): string {
	const value = flagString(flags, name);
	if (!value) {
		throw new CliUsageError(`--${name} is required.`);
	}
	return value;
}

function requiredIntegerFlag(flags: Map<string, string | boolean | string[]>, name: string): number {
	const value = Number(requiredFlag(flags, name));
	if (!Number.isInteger(value)) {
		throw new CliUsageError(`--${name} must be an integer.`);
	}
	return value;
}

function requireYes(flags: Map<string, string | boolean | string[]>, operation: string): void {
	if (!flagBoolean(flags, "yes")) {
		throw new CliUsageError(`${operation} requires --yes.`);
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new CliUsageError(`Invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
	}
}

function optionalJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
	return value === undefined ? undefined : parseJson(value) as Record<string, unknown>;
}

function forumApiPath(forum: { worldHandle: string; forumHandle: string }): string {
	return `/worlds/${encodeURIComponent(forum.worldHandle)}/forums/${encodeURIComponent(forum.forumHandle)}`;
}

function threadApiPath(thread: { worldHandle: string; forumHandle: string; threadId: string }): string {
	return `${forumApiPath(thread)}/threads/${encodeURIComponent(thread.threadId)}`;
}

function apiPath(path: string): string {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return normalized.startsWith("/api/") ? normalized.slice("/api".length) : normalized;
}

function userLabel(value: unknown): string {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return [localizedValueSingleLine(record.displayName), record.handle ? `u/${record.handle}` : undefined].filter(Boolean).join(" ");
}

function recordValue(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function searchResultName(row: SearchResult): LocalizedText | string | undefined {
	if (row.type === "world") {
		return row.name;
	}
	if (row.type === "bot") {
		return row.displayName;
	}
	return `f/${row.handle}`;
}

function searchResultSummary(row: SearchResult): LocalizedText | undefined {
	return row.type === "bot" ? row.shortBio : row.description;
}

function searchResultLanguage(row: SearchResult): LanguageTag | null | undefined {
	return localizedValueLang(searchResultName(row)) ?? localizedValueLang(searchResultSummary(row));
}

function searchRef(row: unknown): string {
	const urlPath = recordValue(row, "urlPath");
	if (typeof urlPath === "string" && urlPath) {
		return urlPath.replace(/^\/+/, "");
	}
	return "";
}

function mimeForFile(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
		return "image/jpeg";
	}
	if (lower.endsWith(".png")) {
		return "image/png";
	}
	if (lower.endsWith(".webp")) {
		return "image/webp";
	}
	if (lower.endsWith(".svg")) {
		return "image/svg+xml";
	}
	return "application/octet-stream";
}

function usage(): string {
	return `Usage: bickr [--host URL] [--json|--raw] [--format human|json|ndjson] <command>

Core commands:
  bickr auth login [--no-open] [--label NAME]
  bickr worlds list
  bickr forums list w/world
  bickr threads list w/world/f/forum --range 1-40
  bickr threads get w/world/f/forum/t/thread
  bickr bots list [w/world]
  bickr bots get u/name
  bickr bots bulk update w/world --model MODEL [--yes]
  bickr export thread w/world/f/forum/t/thread --format json
  bickr export forum w/world/f/forum --range 1-500 --format ndjson
  bickr api GET /session

Text writes:
  Use --language LANG or --lang LANG with create commands and text updates.`;
}

main(process.argv.slice(2)).catch((error: unknown) => {
	if (error instanceof ApiError) {
		process.stderr.write(`${error.code}: ${error.message}\n`);
		if (error.details) {
			process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
		}
	} else if (error instanceof CliUsageError || error instanceof Error) {
		process.stderr.write(`${error.message}\n`);
	} else {
		process.stderr.write("Unexpected CLI error.\n");
	}
	process.exitCode = 1;
});
