import { memoryDurableStorage } from "./durable-storage";
import type { AppEnv } from "../../apps/web/functions/api/_auth";
import type { LifecycleFailureInjector } from "@bickr/shared/entity-lifecycle";
import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import agentRuntimeWorker, { handleAgentRuntimeRequest } from "../../workers/agent-runtime/src/routes";
import forumCoordinatorWorker, { handleForumCoordinatorRequest, runPendingObjectIndexConvergenceTask, runPendingGovernanceDeletionTask, type Env as ForumCoordinatorEnv } from "../../workers/forum-coordinator/src/index";

type TestCoordinatorHandler = (name: string, request: Request) => Promise<Response>;

function testCoordinatorNamespace(handler: TestCoordinatorHandler): DurableObjectNamespace {
	return {
		idFromName: (name: string) => ({
			name,
			toString: () => name,
		}) as unknown as DurableObjectId,
		get: (id: DurableObjectId) => ({
			fetch: (request: Request) => handler((id as DurableObjectId & { name?: string }).name ?? id.toString(), request),
		}) as unknown as DurableObjectStub,
	} as unknown as DurableObjectNamespace;
}

export function testServiceBindings(
	env: Partial<AppEnv>,
	options: { failureInjector?: LifecycleFailureInjector } = {},
): Pick<
	AppEnv,
	"AGENT_RUNTIME" | "BOT_RUNTIME" | "FORUM_COORDINATOR" | "FORUM_COORDINATOR_SERVICE" | "USER_BOTS" | "WORLD_COORDINATOR"
> {
	const internalServiceSecret = "test-internal-service-secret";
	const forumQueues = new Map<string, ExclusiveOperationQueue>();
	const forumStorage = new Map<string, ReturnType<typeof memoryDurableStorage>>();
	let activeAgentCalls = 0;
	let draining = false;
	const forumRouteEnv = () => ({
		...env,
		FORUM_COORDINATOR: env.FORUM_COORDINATOR ?? forumCoordinator,
		WORLD_COORDINATOR: env.WORLD_COORDINATOR ?? worldCoordinator,
		AGENT_RUNTIME_SERVICE: env.AGENT_RUNTIME ?? agentRuntime,
		INTERNAL_SERVICE_SECRET: env.INTERNAL_SERVICE_SECRET ?? internalServiceSecret,
	}) as ForumCoordinatorEnv;
	const coordinatorContext = (name: string) => ({
		objectId: name,
		storage: (forumStorage.get(name) ?? (() => { const durable = memoryDurableStorage(); forumStorage.set(name, durable); return durable; })()).storage,
		queue: forumQueues.get(name) ?? (() => {
			const queue = new ExclusiveOperationQueue();
			forumQueues.set(name, queue);
			return queue;
		})(),
	});
	const worldCoordinator = testCoordinatorNamespace((name, request) =>
		handleForumCoordinatorRequest(request, forumRouteEnv(), coordinatorContext(name)));
	const forumCoordinator = testCoordinatorNamespace((name, request) =>
		handleForumCoordinatorRequest(request, forumRouteEnv(), coordinatorContext(name)));
	const drainTasks = async () => {
		if (activeAgentCalls > 0 || draining) return;
		draining = true;
		try {
			for (const [name, durable] of forumStorage) {
				let rounds = 0;
				while (durable.values.has("object-index-convergence-task") || durable.values.has("governance-deletion-task")) {
					if (++rounds > 100) throw new Error("Test coordinator tasks did not converge.");
					const context = coordinatorContext(name);
					await context.queue.run(async () => {
						await runPendingObjectIndexConvergenceTask(forumRouteEnv(), context);
						await runPendingGovernanceDeletionTask(forumRouteEnv(), context);
					});
				}
			}
		} finally { draining = false; }
	};
	const forumCoordinatorService = {
		fetch: async (request: Request) => {
			const response = await forumCoordinatorWorker.fetch(request as never, forumRouteEnv());
			await drainTasks();
			return response;
		},
	} as unknown as Fetcher;

	const userQueues = new Map<string, ExclusiveOperationQueue>();
	let userBots: DurableObjectNamespace;
	let botRuntime: DurableObjectNamespace;
	const agentWorkerEnv = () => ({
		...env,
		BOT_RUNTIME: env.BOT_RUNTIME ?? botRuntime,
		FORUM_COORDINATOR_SERVICE: env.FORUM_COORDINATOR_SERVICE ?? forumCoordinatorService,
		INTERNAL_SERVICE_SECRET: env.INTERNAL_SERVICE_SECRET ?? internalServiceSecret,
		USER_BOTS: env.USER_BOTS ?? userBots,
	}) as unknown as Parameters<typeof agentRuntimeWorker.fetch>[1];
	userBots = testCoordinatorNamespace((name, request) => handleAgentRuntimeRequest(request, agentWorkerEnv(), {
		objectId: name,
		ownerUserId: name,
		failureInjector: options.failureInjector,
		queue: userQueues.get(name) ?? (() => {
			const queue = new ExclusiveOperationQueue();
			userQueues.set(name, queue);
			return queue;
		})(),
	}));
	botRuntime = testCoordinatorNamespace((_name, request) => handleAgentRuntimeRequest(request, agentWorkerEnv()));
	const agentRuntime = {
		fetch: async (request: Request) => {
			activeAgentCalls += 1;
			let response: Response;
			try { response = await agentRuntimeWorker.fetch(request as never, agentWorkerEnv()); }
			finally { activeAgentCalls -= 1; }
			await drainTasks();
			return response;
		},
	} as unknown as Fetcher;
	return {
		AGENT_RUNTIME: agentRuntime,
		BOT_RUNTIME: botRuntime,
		FORUM_COORDINATOR: forumCoordinator,
		FORUM_COORDINATOR_SERVICE: forumCoordinatorService,
		USER_BOTS: userBots,
		WORLD_COORDINATOR: worldCoordinator,
	};
}

