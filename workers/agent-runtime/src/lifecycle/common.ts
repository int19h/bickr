import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { RepositoryError } from "@bickr/shared/repository";
import { apiErrorPayload, repositoryErrorCode, runtimeRecord } from "../runtime/bot-runtime";
import type { AgentRuntimeRouteEnv, UserBotsCoordinatorContext } from "./types";

export async function scheduleUserLifecycleAlarm(coordinator: UserBotsCoordinatorContext): Promise<void> {
	await coordinator.storage?.setAlarm(Date.now() + 5_000);
}

export async function requestCoordinatorGovernanceDeletion(
	env: Partial<Pick<AgentRuntimeRouteEnv, "FORUM_COORDINATOR_SERVICE" | "INTERNAL_SERVICE_SECRET">>,
	path: string,
	userId: string,
): Promise<void> {
	if (!env.FORUM_COORDINATOR_SERVICE) {
		throw new RepositoryError("server_error", "Forum coordinator service is unavailable.", 500);
	}
	const headers = new Headers({ "x-bickr-user-id": userId });
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const response = await env.FORUM_COORDINATOR_SERVICE.fetch(
		new Request(internalServiceUrl(path), { method: "DELETE", headers }),
	);
	if (response.ok) return;
	const payload = runtimeRecord(await response.json());
	const apiError = apiErrorPayload(payload);
	if (apiError) {
		throw new RepositoryError(repositoryErrorCode(apiError.error), apiError.message, response.status || 500, apiError.details);
	}
	throw new RepositoryError("server_error", "Governance deletion coordinator request failed.", response.status || 500);
}
