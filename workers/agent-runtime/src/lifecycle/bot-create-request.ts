import type { CreateBotInput } from "@bickr/shared/model";
import { RepositoryError } from "@bickr/shared/repository";

type CredentialFreeCreateBotInput = Omit<CreateBotInput, "inferenceSettings"> & {
	inferenceSettings?: Omit<NonNullable<CreateBotInput["inferenceSettings"]>, "openRouterApiKey">;
};

export type BotCreateLifecycleRequest = {
	kind: "bot_create" | "clone_create";
	userId: string;
	worldId: string;
	worldHandle: string;
	botId: string;
	personalForumId: string;
	createdAt: string;
	input: CredentialFreeCreateBotInput;
};

export function parseBotCreateLifecycleRequest(serialized: string): BotCreateLifecycleRequest {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepositoryError("server_error", "Participant lifecycle request is invalid.", 500);
	const request = value as Partial<BotCreateLifecycleRequest>;
	if ((request.kind !== "bot_create" && request.kind !== "clone_create") || typeof request.userId !== "string" || typeof request.worldId !== "string" || typeof request.worldHandle !== "string" || typeof request.botId !== "string" || typeof request.personalForumId !== "string" || typeof request.createdAt !== "string" || !request.input) {
		throw new RepositoryError("server_error", "Participant lifecycle request is invalid.", 500);
	}
	return request as BotCreateLifecycleRequest;
}
