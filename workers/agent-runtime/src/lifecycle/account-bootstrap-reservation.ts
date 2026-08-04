import {
	hashLifecycleRequest,
	lifecycleOperationById,
	reserveAccountCreateLifecycle,
	serializedLifecycleRequest,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import {
	accountBootstrapReservationRepositoryMutations,
	type NormalizedProviderUserProfile,
	RepositoryError,
	type ProviderUserBootstrap,
	type ProviderUserProfile,
} from "@bickr/shared/repository";
import type { D1DatabaseLike } from "@bickr/shared/storage";

const {
	normalizeProviderUserProfile,
	prepareProviderUserBootstrap,
	providerBootstrapClaim,
} = accountBootstrapReservationRepositoryMutations;

const automaticHandleReservationAttempts = 8;
const orderedHandleReservationAttempts = 3;

export const accountBootstrapOperationHeader = "x-bickr-account-bootstrap-operation-id";

export type AccountBootstrapLifecycleRequest = {
	kind: "account_create";
	bootstrap: ProviderUserBootstrap;
};

export type AccountBootstrapDispatchReservation =
	| {
		kind: "active";
		userId: string;
		profile: NormalizedProviderUserProfile;
	}
	| {
		kind: "pending";
		userId: string;
		operation: LifecycleOperation;
		profile: NormalizedProviderUserProfile;
	};

export type ReservedAccountBootstrapOperation = {
	operation: LifecycleOperation;
	profile: NormalizedProviderUserProfile;
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
	const profile = normalizeProviderUserProfile(input.profile);
	const requestHash = await accountBootstrapRequestHash(profile);
	const existing = await accountBootstrapDispatchReservation(db, profile, requestHash);
	if (existing) return existing;

	// The provider subject and automatically chosen handle are claimed in one D1
	// batch. A conflict can therefore mean either another login won the provider
	// subject or an unrelated login chose the same handle from an earlier read.
	// Re-read the provider claim first, then bound handle retries and move to
	// randomized candidates so synchronized callers cannot remain in lockstep.
	for (let attempt = 0; attempt < automaticHandleReservationAttempts; attempt += 1) {
		const handleStrategy = attempt < orderedHandleReservationAttempts ? "ordered" : "randomized";
		const bootstrap = await prepareProviderUserBootstrap(
			db,
			profile,
			input.candidateUserId,
			input.now,
			handleStrategy,
		);
		const request: AccountBootstrapLifecycleRequest = { kind: "account_create", bootstrap };

		try {
			const reserved = await reserveAccountCreateLifecycle(db, {
				ownerUserId: input.candidateUserId,
				idempotencyKey: input.idempotencyKey,
				requestHash,
				requestJson: serializedLifecycleRequest(request),
				entityKind: "account",
				entityId: input.candidateUserId,
				reservations: [
					{ kind: "provider_subject", scope: profile.provider, value: profile.subject },
					{ kind: "user_handle", scope: "global", value: bootstrap.user.handle },
				],
				now: input.now,
			});
			return {
				kind: "pending",
				userId: input.candidateUserId,
				operation: reserved.operation,
				profile,
			};
		} catch (error) {
			if (!(error instanceof RepositoryError) || error.code !== "conflict") throw error;
			const raced = await accountBootstrapDispatchReservation(db, profile, requestHash);
			if (raced) return raced;
		}
	}

	throw new RepositoryError("conflict", "Unable to reserve a unique account handle.", 409);
}

export async function reservedAccountBootstrapOperation(
	db: D1DatabaseLike,
	input: {
		operationId: string;
		profile: ProviderUserProfile;
		userId: string;
	},
): Promise<ReservedAccountBootstrapOperation> {
	const profile = normalizeProviderUserProfile(input.profile);
	const operation = await lifecycleOperationById(db, input.operationId);
	if (!operation || operation.entityKind !== "account" || operation.action !== "create") {
		throw new RepositoryError("conflict", "Account bootstrap reservation is not available.", 409);
	}
	if (operation.entityId !== input.userId || operation.ownerUserId !== input.userId) {
		throw new RepositoryError("forbidden", "Account bootstrap was dispatched to the wrong coordinator.", 403);
	}
	const requestHash = await accountBootstrapRequestHash(profile);
	if (operation.requestHash !== requestHash) {
		throw new RepositoryError("conflict", "Idempotency key was reused with different account input.", 409);
	}
	return { operation, profile };
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
	profile: NormalizedProviderUserProfile,
	expectedRequestHash?: string,
): Promise<AccountBootstrapDispatchReservation | null> {
	const claim = await providerBootstrapClaim(db, profile);
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
	parseAccountBootstrapLifecycleRequest(operation.requestJson);
	return {
		kind: "pending",
		userId: claim.userId,
		operation,
		profile,
	};
}

function accountBootstrapRequestHash(profile: NormalizedProviderUserProfile): Promise<string> {
	// Provider presentation changes independently of the stable login identity.
	// Keeping it out of the reservation hash lets an interrupted first login
	// resume with current provider data while retaining its allocated ID/handle.
	return hashLifecycleRequest({
		kind: "account_create",
		provider: profile.provider,
		subject: profile.subject,
	});
}
