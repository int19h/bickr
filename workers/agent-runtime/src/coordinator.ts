import { ExclusiveOperationQueue } from '@bickr/shared/exclusive-operation-queue';
import { isTrustedInternalServiceRequest } from '@bickr/shared/internal-service';
import { deferAlarmDuringMaintenance } from '@bickr/shared/maintenance';
import { handleAgentRuntimeRequest, runUserBotsConvergenceAlarm } from './routes';
import { agentRuntimeNotFoundResponse } from './runtime/bot-runtime';
import type { Env } from './types';

export class UserBotsCoordinator {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private readonly queue = new ExclusiveOperationQueue();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		if (!isTrustedInternalServiceRequest(request, this.env.INTERNAL_SERVICE_SECRET)) {
			return agentRuntimeNotFoundResponse();
		}
		return handleAgentRuntimeRequest(request, this.env, {
			objectId: this.state.id.toString(),
			ownerUserId: this.state.id.name,
			queue: this.queue,
			storage: this.state.storage,
		});
	}

	async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		if (await deferAlarmDuringMaintenance(this.env.BICKR_D1, this.state.storage)) {
			return;
		}
		await runUserBotsConvergenceAlarm(this.env, {
			objectId: this.state.id.toString(),
			ownerUserId: this.state.id.name,
			queue: this.queue,
			storage: this.state.storage,
		}, alarmInfo);
	}
}
