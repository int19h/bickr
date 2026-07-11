// Each value versions the complete D1/FTS/Vectorize projection for one KV
// entity type. Bump only the affected type when that projection shape changes.
export const entityIndexVersions = {
	user: 1,
	world: 1,
	forum: 1,
	bot: 1,
	thread: 1,
} as const;

export type IndexedEntityType = keyof typeof entityIndexVersions;
