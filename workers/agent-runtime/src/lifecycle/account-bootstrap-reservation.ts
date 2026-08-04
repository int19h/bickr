import {
	hashLifecycleRequest,
	lifecycleOperationById,
	reserveCreateLifecycle,
	serializedLifecycleRequest,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import {
	accountBootstrapReservationRepositoryMutations,
	RepositoryError,
	type ProviderUserBootstrap,
	type ProviderUserProfile,
} from "@bickr/shared/repository";
import type { D1DatabaseLike } from "@bickr/shared/storage";

const {
	prepareProviderUserBootstrap,
	providerBootstrapClaim,
} = accountBootstrapReservationRepositoryMutations;

export const accountBootstrapOperationHeader = "x-bickr-account-bootstrap-operation-id";

export type AccountBootstrapLifecycleRequest = {
	kind: "account_create";
	bootstrap: ProviderUserBootstrap;
};

export type AccountBootstrapDispatchReservation =
	| {
		kind: "active";
		userId: string;
		profile: ProviderUserProfile;
	}
	| {
		kind: "pending";
		userId: string;
		operation: LifecycleOperation;
		profile: ProviderUserProfile;
	};

export async function reserveOrJoinAccountBootstrap(
	db: D1DatabaseLike,
	input: {
		candidateUserId: string;
		idempotencyKey: string;
		profile: ProviderUserProfile;
		now: string;
	},
): Promise<AccountBootstrapDispatchReservation> {
	const existing = await accountBootstrapDispatchReservation(db, input.profile);
	if (existing) return existing;

	const bootstrap = await prepareProviderUserBootstrap(db, input.profile, input.candidateUserId, input.now);
	const requestHash = await accountBootstrapRequestHash(bootstrap.profile);
	const request: AccountBootstrapLifecycleRequest = { kind: "account_create", bootstrap };

	try {
		const reserved = await reserveCreateLifecycle(db, {
			ownerUserId: input.candidateUserId,
			idempotencyKey: input.idempotencyKey,
			requestHash,
			requestJson: serializedLifecycleRequest(request),
			entityKind: "account",
			entityId: input.candidateUserId,
			reservations: [
				{ kind: "provider_subject", scope: bootstrap.profile.provider, value: bootstrap.profile.subject },
				{ kind: "user_handle", scope: "global", value: bootstrap.user.handle },
			],
			now: input.now,
		});
		return {
			kind: "pending",
			userId: input.candidateUserId,
			operation: reserved.operation,
			profile: bootstrap.profile,
		};
	} catch (error) {
		if (!(error instanceof RepositoryError) || error.code !== "conflict") throw error;
		const raced = await accountBootstrapDispatchReservation(db, bootstrap.profile, requestHash);
		if (raced) return raced;
		throw error;
	}
}

export async function reservedAccountBootstrapOperation(
	db: D1DatabaseLike,
	input: {
		operationId: string;
		profile: ProviderUserProfile;
		userId: string;
	},
): Promise<LifecycleOperation> {
	const operation = await lifecycleOperationById(db, input.operationId);
	if (!operation || operation.entityKind !== "account" || operation.action !== "create") {
		throw new RepositoryError("conflict", "Account bootstrap reservation is not available.", 409);
	}
	if (operation.entityId !== input.userId || operation.ownerUserId !== input.userId) {
		throw new RepositoryError("forbidden", "Account bootstrap was dispatched to the wrong coordinator.", 403);
	}
	const requestHash = await accountBootstrapRequestHash(input.profile);
	if (operation.requestHash !== requestHash) {
		throw new RepositoryError("conflict", "Idempotency key was reused with different account input.", 409);
	}
	return operation;
}

export function parseAccountBootstrapLifecycleRequest(serialized: string): AccountBootstrapLifecycleRequest {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RepositoryError("server_error", "Account lifecycle request is invalid.", 500);
	}
	const request = value as Partial<AccountBootstrapLifecycleRequest>;
	if (request.kind !== "account_create" || !request.bootstrap) {
		throw new RepositoryError("server_error", "Account lifecycle request is invalid.", 500);
	}
	return request as AccountBootstrapLifecycleRequest;
}

async function accountBootstrapDispatchReservation(
	db: D1DatabaseLike,
	profile: ProviderUserProfile,
	expectedRequestHash?: string,
): Promise<AccountBootstrapDispatchReservation | null> {
	const claim = await providerBootstrapClaim(db, profile.provider, profile.subject);
	if (!claim) return null;
	if (claim.kind === "active") {
		return { kind: "active", userId: claim.userId, profile };
	}
	if (claim.kind === "active_without_projection") {
		throw new RepositoryError("conflict", "Provider identity is currently being deleted.", 409);
	}
	const operation = await lifecycleOperationById(db, claim.operationId);
	if (
		!operation ||
		operation.entityKind !== "account" ||
		operation.entityId !== claim.userId ||
		operation.ownerUserId !== claim.userId ||
		operation.action !== "create"
	) {
		throw new RepositoryError("server_error", "Pending account reservation is inconsistent.", 500);
	}
	const requestHash = expectedRequestHash ?? await accountBootstrapRequestHash(profile);
	if (operation.requestHash !== requestHash) {
		throw new RepositoryError("conflict", "Provider identity is reserved with different account input.", 409);
	}
	if (!operation.requestJson) {
		throw new RepositoryError("conflict", "Account bootstrap reservation is no longer pending.", 409);
	}
	const request = parseAccountBootstrapLifecycleRequest(operation.requestJson);
	return {
		kind: "pending",
		userId: claim.userId,
		operation,
		profile: request.bootstrap.profile,
	};
}

function accountBootstrapRequestHash(profile: ProviderUserProfile): Promise<string> {
	return hashLifecycleRequest({ kind: "account_create", profile });
}
