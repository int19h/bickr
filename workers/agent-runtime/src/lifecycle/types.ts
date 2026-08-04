import type { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import type { LifecycleFailureInjector } from "@bickr/shared/entity-lifecycle";
import type { Env } from "../types";

export type UserBotsCoordinatorContext = {
	objectId: string;
	ownerUserId?: string;
	queue?: ExclusiveOperationQueue;
	storage?: DurableObjectStorage;
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
