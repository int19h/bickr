export const schemaVersion = 1;
export const indexVersion = 1;

export type EntityType = "user" | "providerIdentity" | "session" | "world" | "forum" | "bot";

export type EntityDocument = {
	id: string;
	type: EntityType;
	schemaVersion: number;
	revision: number;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string;
};

export type UserDocument = EntityDocument & {
	type: "user";
	handle: string;
	displayName: string;
	avatarUrl?: string;
};

export type ProviderIdentityDocument = EntityDocument & {
	type: "providerIdentity";
	provider: "github";
	providerSubject: string;
	userId: string;
	providerLogin: string;
	email?: string;
	avatarUrl?: string;
};

export type SessionDocument = EntityDocument & {
	type: "session";
	userId: string;
	expiresAt: string;
};

export type WorldDocument = EntityDocument & {
	type: "world";
	handle: string;
	name: string;
	description: string;
	createdByUserId: string;
	visibility: "public";
};

export type ForumDocument = EntityDocument & {
	type: "forum";
	worldId: string;
	worldHandle: string;
	handle: string;
	description: string;
	createdByUserId: string;
};

export type ChirperImportSource = {
	provider: "chirper";
	originalHandle: string;
	originalProfileUrl: string;
	apiUrl: string;
	importedAt: string;
};

export type BotDocument = EntityDocument & {
	type: "bot";
	homeWorldId: string;
	homeWorldHandle: string;
	ownerUserId: string;
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	importSource?: ChirperImportSource;
};

export type PublicUser = {
	id: string;
	handle: string;
	displayName: string;
	avatarUrl?: string;
};

export type SessionPayload = {
	authenticated: boolean;
	user: PublicUser | null;
};

export type WorldSummary = {
	id: string;
	handle: string;
	name: string;
	description: string;
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
};

export type ForumSummary = {
	id: string;
	worldId: string;
	worldHandle: string;
	handle: string;
	description: string;
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
};

export type BotSummary = {
	id: string;
	homeWorldId: string;
	homeWorldHandle: string;
	ownerUserId: string;
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	importSource?: ChirperImportSource;
	createdAt: string;
	updatedAt: string;
};

export type ChirperImportPreview = {
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	importSource: ChirperImportSource;
};

export type CreateWorldInput = {
	handle: string;
	name: string;
	description: string;
};

export type CreateForumInput = {
	handle: string;
	description: string;
};

export type CreateBotInput = {
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	importSource?: ChirperImportSource;
};

export type UpdateBotInput = Partial<Pick<CreateBotInput, "displayName" | "shortBio" | "prompt">>;

export type ApiErrorCode =
	| "bad_request"
	| "conflict"
	| "forbidden"
	| "not_found"
	| "oauth_error"
	| "server_error"
	| "unauthorized";

export type ApiErrorPayload = {
	ok: false;
	error: ApiErrorCode;
	message: string;
};

export type ApiSuccessPayload<T> = {
	ok: true;
	data: T;
};
