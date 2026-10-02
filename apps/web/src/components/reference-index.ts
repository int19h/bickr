import type { BotSummary, ForumSummary, PublicUser } from "@bickr/shared/model";
import type { ReferenceData, WorldView } from "./content";

const indices = new WeakMap<ReferenceData, ReferenceIndex>();
type ReferenceIndex = {
	worlds: Map<string, WorldView>;
	forums: Map<string, Map<string, ForumSummary>>;
	bots: Map<string, BotSummary>;
	botsByHandle: Map<string, BotSummary>;
	worldBots: Map<string, Map<string, BotSummary>>;
	humans: Map<string, PublicUser>;
	ownedWorlds: Map<string, string[]>;
	ownedBotCounts: Map<string, number>;
};

function byHandle<T extends { handle: string }>(items: readonly T[]): Map<string, T> {
	const index = new Map<string, T>();
	for (const item of items) if (!index.has(item.handle)) index.set(item.handle, item);
	return index;
}

/** ReferenceData is an immutable render snapshot. Build each index once per snapshot. */
export function referenceIndex(data: ReferenceData): ReferenceIndex {
	const cached = indices.get(data);
	if (cached) return cached;
	const bots = new Map<string, BotSummary>();
	for (const bot of data.bots) bots.set(bot.id, bot);
	for (const list of Object.values(data.botsByWorld)) for (const bot of list) bots.set(bot.id, bot);
	const ownedWorlds = new Map<string, string[]>();
	for (const world of data.worlds) {
		const handles = ownedWorlds.get(world.createdByUserId) ?? [];
		handles.push(`w/${world.handle}`);
		ownedWorlds.set(world.createdByUserId, handles);
	}
	const ownedBotCounts = new Map<string, number>();
	for (const bot of bots.values()) ownedBotCounts.set(bot.ownerUserId, (ownedBotCounts.get(bot.ownerUserId) ?? 0) + 1);
	const index: ReferenceIndex = {
		worlds: byHandle(data.worlds), humans: byHandle(data.humans), bots,
		botsByHandle: byHandle([...bots.values()]),
		forums: new Map(Object.entries(data.forumsByWorld).map(([world, list]) => [world, byHandle(list)])),
		worldBots: new Map(Object.entries(data.botsByWorld).map(([world, list]) => [world, byHandle(list)])),
		ownedWorlds, ownedBotCounts,
	};
	indices.set(data, index);
	return index;
}

export function referenceBot(data: ReferenceData, name: string, explicitWorld?: string): BotSummary | undefined {
	const index = referenceIndex(data);
	const world = explicitWorld ?? data.activeWorldHandle;
	return (world ? index.worldBots.get(world)?.get(name) : undefined)
		?? (explicitWorld ? undefined : index.botsByHandle.get(name));
}
