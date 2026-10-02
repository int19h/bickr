import {
	repairOwnedObjectIndex,
	requestObjectIndexRepair,
	type ObjectIndexRepairOwnerEnv,
	type OwnedObjectIndexRepairRequest,
} from "@bickr/shared/index-repair";
import { RepositoryError } from "@bickr/shared/repository";

type RepairEnvironment = ObjectIndexRepairOwnerEnv & {
	FORUM_COORDINATOR_SERVICE?: { fetch(request: Request): Promise<Response> };
	INTERNAL_SERVICE_SECRET?: string;
};

export async function indexedObjectOwner(env: ObjectIndexRepairOwnerEnv, request: OwnedObjectIndexRepairRequest): Promise<string | null> {
	if (request.entityType === "user") return request.id;
	if (request.entityType !== "bot") return null;
	return (await env.BICKR_D1.prepare(
		"SELECT owner_user_id AS ownerId FROM bots_index WHERE bot_id = ? LIMIT 1",
	).bind(request.id).first<{ ownerId: string }>())?.ownerId ?? null;
}

/** The caller holds the account queue throughout the convergence step. */
export function accountIndexRepairEnvironment(env: RepairEnvironment, ownerUserId?: string) {
	return {
		...env,
		repairOwnedObject: async (request: OwnedObjectIndexRepairRequest) => {
			if (ownerUserId && await indexedObjectOwner(env, request) === ownerUserId) {
				return repairOwnedObjectIndex(env, request);
			}
			if (!env.FORUM_COORDINATOR_SERVICE) {
				throw new RepositoryError("server_error", "Index repair requires the forum coordinator service.", 500);
			}
			return requestObjectIndexRepair(env.FORUM_COORDINATOR_SERVICE, env.INTERNAL_SERVICE_SECRET, request);
		},
	};
}
