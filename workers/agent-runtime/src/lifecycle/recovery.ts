import {
	claimDueLifecycleRecoveryOwners,
	lifecycleRecoveryLeaseMs,
	lifecycleRecoveryOwnerBatchLimit,
	nextDueLifecycleOperation,
	nextLifecycleAlarmAt,
	type LifecycleOperation,
} from "@bickr/shared/entity-lifecycle";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { readMaintenanceState } from "@bickr/shared/maintenance";
import { RepositoryError } from "@bickr/shared/repository";
import type { D1DatabaseLike } from "@bickr/shared/storage";
import { scheduledDispatchTimeoutMs } from "../constants";
import { RuntimeOperationTimeoutError } from "../errors";
import { withAbortableTimeout } from "../provider/sse";
import { runAccountBootstrapOperation, runAccountDeleteOperation } from "./account";
import { runBotCreateOperation, runBotDeleteOperation } from "./bot";
import type { LifecycleRuntimeContext, UserBotsCoordinatorContext } from "./types";
import { runWorldCreateOperation, runWorldDeleteOperation } from "./world";

export type LifecycleRecoveryWakeRequest = {
	kind: "lifecycle_recovery_wake";
	scheduledAt: string;
};

export type LifecycleRecoveryWakeResult = {
	kind: "lifecycle_recovery_wake_complete";
	ownerUserId: string;
	operationId: string | null;
};

export type LifecycleRecoveryRunResult = {
	claimed: number;
	dispatched: number;
	failed: number;
	maintenanceDeferred: boolean;
};

export type LifecycleRecoveryCoordinatorNamespace<Id> = {
	idFromName(name: string): Id;
	get(id: Id): {
		fetch(request: Request): Promise<Response>;
	};
};

export type LifecycleRecoveryEnv<Id> = {
	BICKR_D1: D1DatabaseLike;
	USER_BOTS: LifecycleRecoveryCoordinatorNamespace<Id>;
	INTERNAL_SERVICE_SECRET?: string;
};

const recoveryErrorCodes = new Set([
	"bad_request",
	"conflict",
	"forbidden",
	"maintenance",
	"not_found",
	"oauth_error",
	"server_error",
	"unauthorized",
]);

export async function resumeDueUserLifecycleOperation(
	context: LifecycleRuntimeContext,
	scheduledAt: string,
): Promise<LifecycleRecoveryWakeResult> {
	const ownerUserId = context.coordinator.ownerUserId;
	if (!ownerUserId) {
		throw new RepositoryError("server_error", "Lifecycle recovery requires a named user coordinator.", 500);
	}
	const lifecycle = await nextDueLifecycleOperation(context.env.BICKR_D1, ownerUserId, scheduledAt);
	if (!lifecycle) {
		return { kind: "lifecycle_recovery_wake_complete", ownerUserId, operationId: null };
	}
	await resumeLifecycleOperation(context, lifecycle);
	return {
		kind: "lifecycle_recovery_wake_complete",
		ownerUserId,
		operationId: lifecycle.operationId,
	};
}

export async function armNextUserLifecycleAlarm(
	db: D1DatabaseLike,
	coordinator: UserBotsCoordinatorContext,
): Promise<void> {
	if (!coordinator.ownerUserId || !coordinator.storage) return;
	const lifecycleAlarmAt = await nextLifecycleAlarmAt(db, coordinator.ownerUserId);
	if (!lifecycleAlarmAt) return;
	const lifecycleAlarmMs = Date.parse(lifecycleAlarmAt);
	await coordinator.storage.setAlarm(Math.max(
		Date.now() + 1,
		Math.min(Date.now() + 5_000, lifecycleAlarmMs),
	));
}

export async function recoverDueLifecycleOwners<Id>(
	env: LifecycleRecoveryEnv<Id>,
	scheduledTime: number,
	options: { limit?: number; leaseMs?: number } = {},
): Promise<LifecycleRecoveryRunResult> {
	if ((await readMaintenanceState(env.BICKR_D1)).enabled) {
		return { claimed: 0, dispatched: 0, failed: 0, maintenanceDeferred: true };
	}
	const now = new Date(scheduledTime).toISOString();
	const leaseMs = Math.max(1_000, Math.trunc(options.leaseMs ?? lifecycleRecoveryLeaseMs));
	const leases = await claimDueLifecycleRecoveryOwners(env.BICKR_D1, {
		now,
		leaseToken: `lifecycle-recovery:${crypto.randomUUID()}`,
		leaseExpiresAt: new Date(scheduledTime + leaseMs).toISOString(),
		limit: options.limit ?? lifecycleRecoveryOwnerBatchLimit,
	});
	let dispatched = 0;
	let failed = 0;
	await Promise.all(leases.map(async (lease) => {
		try {
			await dispatchLifecycleRecoveryWake(env, lease.ownerUserId, now);
			dispatched += 1;
		} catch (error) {
			failed += 1;
			console.warn("lifecycle recovery owner dispatch failed", lease.ownerUserId, error);
		}
	}));
	return {
		claimed: leases.length,
		dispatched,
		failed,
		maintenanceDeferred: false,
	};
}

export function lifecycleRecoveryWakeRequestFromUnknown(value: unknown): LifecycleRecoveryWakeRequest {
	const record = recordValue(value);
	if (record.kind !== "lifecycle_recovery_wake" || typeof record.scheduledAt !== "string") {
		throw new RepositoryError("bad_request", "Lifecycle recovery wake request is invalid.", 400);
	}
	const scheduledAtMs = Date.parse(record.scheduledAt);
	if (!Number.isFinite(scheduledAtMs) || new Date(scheduledAtMs).toISOString() !== record.scheduledAt) {
		throw new RepositoryError("bad_request", "Lifecycle recovery wake time is invalid.", 400);
	}
	return { kind: "lifecycle_recovery_wake", scheduledAt: record.scheduledAt };
}

async function resumeLifecycleOperation(
	context: LifecycleRuntimeContext,
	operation: LifecycleOperation,
): Promise<void> {
	switch (operation.entityKind) {
		case "account":
			if (operation.action === "create") {
				await runAccountBootstrapOperation(context, operation);
			} else {
				await runAccountDeleteOperation(context, operation);
			}
			return;
		case "world":
			if (operation.action === "create") {
				await runWorldCreateOperation(context, operation);
			} else {
				await runWorldDeleteOperation(context, operation);
			}
			return;
		case "bot":
			if (operation.action === "create") {
				await runBotCreateOperation(context, operation);
			} else {
				await runBotDeleteOperation(context, operation);
			}
	}
}

async function dispatchLifecycleRecoveryWake<Id>(
	env: LifecycleRecoveryEnv<Id>,
	ownerUserId: string,
	scheduledAt: string,
): Promise<LifecycleRecoveryWakeResult> {
	const headers = new Headers({
		"content-type": "application/json",
		"x-bickr-scheduler": "1",
		"x-bickr-user-id": ownerUserId,
	});
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const id = env.USER_BOTS.idFromName(ownerUserId);
	const parentSignal = new AbortController().signal;
	const response = await withAbortableTimeout(
		parentSignal,
		scheduledDispatchTimeoutMs,
		() => new RuntimeOperationTimeoutError("Lifecycle recovery coordinator dispatch", scheduledDispatchTimeoutMs),
		(signal) => env.USER_BOTS.get(id).fetch(new Request(
			internalServiceUrl(`/users/${encodeURIComponent(ownerUserId)}/lifecycle/recover`),
			{
				method: "POST",
				headers,
				signal,
				body: JSON.stringify({
					kind: "lifecycle_recovery_wake",
					scheduledAt,
				} satisfies LifecycleRecoveryWakeRequest),
			},
		)),
	);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new LifecycleRecoveryServiceError(
			error instanceof SyntaxError ? "invalid_json_payload" : "response_read_failed",
			502,
		);
	}
	if (!response.ok) {
		const error = recoveryServiceError(payload);
		throw new LifecycleRecoveryServiceError(
			error?.code ?? "server_error",
			response.status || 500,
		);
	}
	return lifecycleRecoveryWakeResultFromUnknown(payload, ownerUserId);
}

function lifecycleRecoveryWakeResultFromUnknown(
	value: unknown,
	expectedOwnerUserId: string,
): LifecycleRecoveryWakeResult {
	const envelope = recordValue(value);
	const data = recordValue(envelope.data);
	if (
		envelope.ok !== true ||
		data.kind !== "lifecycle_recovery_wake_complete" ||
		data.ownerUserId !== expectedOwnerUserId ||
		!(typeof data.operationId === "string" || data.operationId === null)
	) {
		throw new LifecycleRecoveryServiceError("invalid_success_payload", 502);
	}
	return {
		kind: "lifecycle_recovery_wake_complete",
		ownerUserId: expectedOwnerUserId,
		operationId: data.operationId,
	};
}

function recoveryServiceError(value: unknown): { code: string } | null {
	const record = recordValue(value);
	return record.ok === false && typeof record.error === "string" && recoveryErrorCodes.has(record.error)
		? { code: record.error }
		: null;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

class LifecycleRecoveryServiceError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, status: number) {
		super(`Lifecycle recovery service dispatch failed (${code}, HTTP ${status}).`);
		this.name = "LifecycleRecoveryServiceError";
		this.code = code;
		this.status = status;
	}
}
