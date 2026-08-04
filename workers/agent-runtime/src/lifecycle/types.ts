import type { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import type { LifecycleFailureInjector } from "@bickr/shared/entity-lifecycle";
import type { Env } from "../types";

// UserBotsCoordinator lifecycle code needs only this storage surface. Keeping
// it explicit lets recovery tests model the real alarm boundary without
// pretending a partial object implements every DurableObjectStorage method.
export type UserBotsCoordinatorStorage = {
	get<T = unknown>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<boolean>;
	setAlarm(scheduledTime: number | Date): Promise<void>;
	deleteAlarm(): Promise<void>;
};

export type UserBotsCoordinatorContext = {
	objectId: string;
	ownerUserId?: string;
	queue?: ExclusiveOperationQueue;
	storage?: UserBotsCoordinatorStorage;
	failureInjector?: LifecycleFailureInjector;
};

export type AgentRuntimeRouteEnv = Pick<
	Env,
	| "BICKR_D1"
	| "BICKR_KV"
	| "BICKR_R2"
	| "BICKR_R2_PUBLIC_BASE_URL"
	| "AI"
	| "BICKR_SEARCH_VECTORIZE"
	| "OPENROUTER_API_KEY"
	| "OPENROUTER_BASE_URL"
	| "OPENROUTER_MODEL"
> &
	Partial<Pick<Env, "FORUM_COORDINATOR_SERVICE" | "INTERNAL_SERVICE_SECRET">>;

export type AgentRuntimeRouteContext = {
	request: Request;
	env: AgentRuntimeRouteEnv;
	url: URL;
	coordinator: UserBotsCoordinatorContext;
	objectId: string;
	match: RegExpExecArray;
};

export type LifecycleRuntimeContext = {
	env: AgentRuntimeRouteEnv;
	coordinator: UserBotsCoordinatorContext;
};
