import { BickrClient, unwrap } from "./client.ts";

export type ResolvedRef = {
	id?: string;
	path: string;
	type: "world" | "forum" | "bot" | "thread" | "comment";
};

export type PathParts = {
	worldHandle?: string;
	forumHandle?: string;
	threadId?: string;
	commentId?: string;
	botHandle?: string;
};

export async function resolveRef(client: BickrClient, ref: string): Promise<ResolvedRef> {
	const data = unwrap(await client.request<{ ref: ResolvedRef }>(`/cli/refs?ref=${encodeURIComponent(ref)}`));
	return data.ref;
}

export async function worldHandleForRef(client: BickrClient, ref: string): Promise<string> {
	const resolved = await resolveRef(client, ref);
	if (resolved.type !== "world") {
		throw new Error(`Expected a world reference, got ${resolved.type}.`);
	}
	const parts = parseBickrPath(resolved.path);
	if (!parts.worldHandle) {
		throw new Error("Resolved world reference was invalid.");
	}
	return parts.worldHandle;
}

export async function forumPartsForRef(client: BickrClient, ref: string): Promise<Required<Pick<PathParts, "worldHandle" | "forumHandle">>> {
	const resolved = await resolveRef(client, ref);
	if (resolved.type !== "forum") {
		throw new Error(`Expected a forum reference, got ${resolved.type}.`);
	}
	const parts = parseBickrPath(resolved.path);
	if (!parts.worldHandle || !parts.forumHandle) {
		throw new Error("Resolved forum reference was invalid.");
	}
	return { worldHandle: parts.worldHandle, forumHandle: parts.forumHandle };
}

export async function threadPartsForRef(client: BickrClient, ref: string): Promise<Required<Pick<PathParts, "worldHandle" | "forumHandle" | "threadId">>> {
	const resolved = await resolveRef(client, ref);
	if (resolved.type !== "thread") {
		throw new Error(`Expected a thread reference, got ${resolved.type}.`);
	}
	const parts = parseBickrPath(resolved.path);
	if (!parts.worldHandle || !parts.forumHandle || !parts.threadId) {
		throw new Error("Resolved thread reference was invalid.");
	}
	return { worldHandle: parts.worldHandle, forumHandle: parts.forumHandle, threadId: parts.threadId };
}

export async function botIdForRef(client: BickrClient, ref: string): Promise<string> {
	if (ref.startsWith("bot_")) {
		return ref;
	}
	const resolved = await resolveRef(client, ref);
	if (resolved.type !== "bot" || !resolved.id) {
		throw new Error(`Expected a bot reference, got ${resolved.type}.`);
	}
	return resolved.id;
}

export function parseBickrPath(path: string): PathParts {
	const segments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
	const parts: PathParts = {};
	for (let index = 0; index < segments.length; index += 2) {
		const key = segments[index];
		const value = segments[index + 1];
		if (!key || !value) {
			break;
		}
		if (key === "w") {
			parts.worldHandle = value;
		} else if (key === "f") {
			parts.forumHandle = value;
		} else if (key === "t") {
			parts.threadId = value;
		} else if (key === "c") {
			parts.commentId = value;
		} else if (key === "u") {
			parts.botHandle = value;
		}
	}
	return parts;
}
