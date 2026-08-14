import {
	claimInferenceProviderDefaultBarrierSweepFleetOwners,
	type InferenceProviderDefaultBarrierSweepFleetStatus,
} from '@bickr/shared/inference-configuration-migration';
import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import type { D1DatabaseLike } from '@bickr/shared/storage';
import { scheduledDispatchTimeoutMs } from '../constants';
import { RuntimeOperationTimeoutError } from '../errors';
import { withAbortableTimeout } from '../provider/sse';

// All dispatches run concurrently and each has the shared ten-second scheduler
// timeout. This keeps one step far below Cron's wall-time allowance while the
// five-minute trigger supplies restartability for unfinished or failed owners.
export const inferenceProviderDefaultBarrierFleetStepLimit = 25;

type UserCoordinatorNamespace<ObjectId> = {
	idFromName(name: string): ObjectId;
	get(id: ObjectId): { fetch(request: Request): Promise<Response> };
};

export type InferenceProviderDefaultBarrierFleetStepEnv<ObjectId> = {
	BICKR_D1: D1DatabaseLike;
	USER_BOTS: UserCoordinatorNamespace<ObjectId>;
	INTERNAL_SERVICE_SECRET?: string;
};

export type InferenceProviderDefaultBarrierFleetDispatch =
	| {
		kind: 'provider_default_barrier_sweep_dispatch';
		ownerUserId: string;
		status: 'accepted';
		httpStatus: number;
	}
	| {
		kind: 'provider_default_barrier_sweep_dispatch';
		ownerUserId: string;
		status: 'failed';
		httpStatus: number;
		failure: { kind: 'http_response' };
	}
	| {
		kind: 'provider_default_barrier_sweep_dispatch';
		ownerUserId: string;
		status: 'failed';
		httpStatus: null;
		failure:
			| { kind: 'timeout'; timeoutMs: number }
			| { kind: 'dispatch_error'; errorName: string };
	};

export type InferenceProviderDefaultBarrierFleetStepResult = {
	kind: 'inference_provider_default_barrier_fleet_sweep';
	processedOwners: number;
	complete: boolean;
	attempts: InferenceProviderDefaultBarrierFleetDispatch[];
};

export async function runInferenceProviderDefaultBarrierFleetStep<ObjectId>(
	env: InferenceProviderDefaultBarrierFleetStepEnv<ObjectId>,
	input: { limit?: number; now?: string } = {},
): Promise<InferenceProviderDefaultBarrierFleetStepResult> {
	const limit = Math.min(
		Math.max(1, Math.floor(input.limit ?? inferenceProviderDefaultBarrierFleetStepLimit)),
		inferenceProviderDefaultBarrierFleetStepLimit,
	);
	// Owners are claimed least-recently-attempted first rather than paged by
	// owner ID from an empty cursor, so a prefix of deterministically failing
	// owners is retried on its turn instead of consuming every step forever.
	const owners = await claimInferenceProviderDefaultBarrierSweepFleetOwners(env.BICKR_D1, {
		limit,
		now: input.now ?? new Date().toISOString(),
	});
	const attempts = await Promise.all(owners.map((owner) => dispatchOwnerSweep(env, owner)));
	return {
		kind: 'inference_provider_default_barrier_fleet_sweep',
		processedOwners: attempts.length,
		// No pending owner remained to claim. A failed dispatch leaves its owner
		// pending, so it is still counted here and reached again on a later step.
		complete: owners.length === 0,
		attempts,
	};
}

async function dispatchOwnerSweep<ObjectId>(
	env: InferenceProviderDefaultBarrierFleetStepEnv<ObjectId>,
	item: InferenceProviderDefaultBarrierSweepFleetStatus,
): Promise<InferenceProviderDefaultBarrierFleetDispatch> {
	// This is a fresh bodyless internal request, not a forwarded one. Nothing
	// from an operator's own request belongs on it: a stale content-length,
	// cookies, authorization, idempotency keys, and arbitrary tracing headers
	// would all reach the coordinator unreviewed.
	const headers = new Headers();
	headers.set('x-bickr-scheduler', '1');
	headers.set('x-bickr-user-id', item.ownerUserId);
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const objectId = env.USER_BOTS.idFromName(item.ownerUserId);
	try {
		const parentSignal = new AbortController().signal;
		const response = await withAbortableTimeout(
			parentSignal,
			scheduledDispatchTimeoutMs,
			() => new RuntimeOperationTimeoutError('Scheduled provider-default barrier sweep dispatch', scheduledDispatchTimeoutMs),
			(signal) => env.USER_BOTS.get(objectId).fetch(new Request(
				internalServiceUrl(`/users/${encodeURIComponent(item.ownerUserId)}/inference-graph/provider-default-barrier-sweep`),
				{ method: 'POST', headers, signal },
			)),
		);
		return response.ok
			? {
				kind: 'provider_default_barrier_sweep_dispatch',
				ownerUserId: item.ownerUserId,
				status: 'accepted',
				httpStatus: response.status,
			}
			: {
				kind: 'provider_default_barrier_sweep_dispatch',
				ownerUserId: item.ownerUserId,
				status: 'failed',
				httpStatus: response.status,
				failure: { kind: 'http_response' },
			};
	} catch (error) {
		return {
			kind: 'provider_default_barrier_sweep_dispatch',
			ownerUserId: item.ownerUserId,
			status: 'failed',
			httpStatus: null,
			failure: error instanceof RuntimeOperationTimeoutError
				? { kind: 'timeout', timeoutMs: error.timeoutMs }
				: { kind: 'dispatch_error', errorName: error instanceof Error ? error.name : 'UnknownError' },
		};
	}
}
