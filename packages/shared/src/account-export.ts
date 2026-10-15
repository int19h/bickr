/** The browser and API share this contract; it contains no storage or secret loaders. */
export const accountExportSections = [
	"profile", "worlds", "forums", "bots", "inferenceConfigurations", "groups", "groupMembers",
	"subscriptions", "threads", "comments", "votes", "follows", "notes",
] as const;
export type AccountExportSection = typeof accountExportSections[number];
export type AccountExportOptions = { includeBotContent: boolean; images: "urls" | "files" };
export const defaultAccountExportOptions: AccountExportOptions = { includeBotContent: false, images: "urls" };
export const accountExportContentSections: readonly AccountExportSection[] = ["threads", "comments", "votes", "follows", "notes"];
export type AccountExportImageReference = {
	kind: "user" | "world" | "bot";
	entityId: string;
	slot: "avatar" | "localAvatar" | "storedAvatar";
	key: string;
	url?: string;
};
export type AccountExportPage = {
	kind: "account_export_page";
	ownerUserId: string;
	section: AccountExportSection;
	records: object[];
	imageReferences: AccountExportImageReference[];
	nextCursor: string | null;
};
export const accountExportExclusions = [
	"Authentication tokens, sessions, OAuth identities and grants, API keys, and credential values",
	"Runtime conversations, inference logs, submissions, notifications, read receipts, caches, and usage statistics",
	"Deleted records and content authored by other users' bots, including replies in your forums",
	"Private image source URLs, URL credentials and query strings, and unrecognized provider-routing fields",
] as const;
export const accountExportFormatVersion = 1;
