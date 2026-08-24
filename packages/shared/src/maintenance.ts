import type { D1DatabaseLike } from './storage';

export const maintenanceControlId = 1;
export const maintenanceAlarmRetryMs = 5 * 60 * 1000;

export type MaintenanceState = {
	enabled: boolean;
	message: string;
	activatedAt: string | null;
	updatedAt: string;
};

type MaintenanceRow = {
	enabled: number;
	message: string;
	activatedAt: string | null;
	updatedAt: string;
};

type DurableObjectAlarmStorageLike = {
	setAlarm(scheduledTime: number | Date): Promise<void>;
};

export class MaintenanceModeEnabledError extends Error {
	readonly state: MaintenanceState;

	constructor(state: MaintenanceState) {
		super(state.message);
		this.name = 'MaintenanceModeEnabledError';
		this.state = state;
	}
}

export class MaintenanceControlUnavailableError extends Error {
	constructor(message = 'The maintenance control is unavailable.', options?: ErrorOptions) {
		super(message, options);
		this.name = 'MaintenanceControlUnavailableError';
	}
}

export async function readMaintenanceState(db: D1DatabaseLike): Promise<MaintenanceState> {
	let row: MaintenanceRow | null;
	try {
		row = await db
			.prepare(
				`SELECT enabled,
			        message,
			        activated_at AS activatedAt,
			        updated_at AS updatedAt
			 FROM maintenance_control
			 WHERE id = ?`,
			)
			.bind(maintenanceControlId)
			.first<MaintenanceRow>();
	} catch (error) {
		throw new MaintenanceControlUnavailableError('The maintenance control could not be read.', { cause: error });
	}
	if (!row || (row.enabled !== 0 && row.enabled !== 1) || !row.message || !row.updatedAt) {
		throw new MaintenanceControlUnavailableError('The maintenance control row is missing or invalid.');
	}
	return {
		enabled: row.enabled === 1,
		message: row.message,
		activatedAt: row.activatedAt,
		updatedAt: row.updatedAt,
	};
}

export async function requireMaintenanceDisabled(db: D1DatabaseLike): Promise<MaintenanceState> {
	const state = await readMaintenanceState(db);
	if (state.enabled) {
		throw new MaintenanceModeEnabledError(state);
	}
	return state;
}

export function isSafeHttpMethod(method: string): boolean {
	return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

export function isRuntimeStopRequest(request: Request): boolean {
	if (request.method !== 'POST') {
		return false;
	}
	const pathname = new URL(request.url).pathname;
	return /^\/bots\/[^/]+\/stop$/.test(pathname) || /^\/api\/me\/bots\/[^/]+\/runtime\/stop$/.test(pathname);
}

export function isRuntimeStaleRunRecoveryRequest(request: Request): boolean {
	if (request.method !== 'POST' || request.headers.get('x-bickr-scheduler') !== '1') {
		return false;
	}
	return /^\/bots\/[^/]+\/recover-stale-run$/.test(new URL(request.url).pathname);
}

export function maintenanceFailureResponse(error: unknown): Response {
	const enabled = error instanceof MaintenanceModeEnabledError;
	const message = enabled ? error.message : 'Bickr cannot safely accept changes because the maintenance control is unavailable.';
	return Response.json(
		{
			ok: false,
			error: 'maintenance',
			message,
		},
		{
			status: 503,
			headers: {
				'cache-control': 'no-store',
				'retry-after': '300',
			},
		},
	);
}

export async function mutationMaintenanceResponse(
	request: Request,
	db: D1DatabaseLike,
	options: { allowRuntimeStop?: boolean; allowRuntimeStaleRunRecovery?: boolean } = {},
): Promise<Response | null> {
	if (
		isSafeHttpMethod(request.method) ||
		(options.allowRuntimeStop && isRuntimeStopRequest(request)) ||
		(options.allowRuntimeStaleRunRecovery && isRuntimeStaleRunRecoveryRequest(request))
	) {
		return null;
	}
	try {
		await requireMaintenanceDisabled(db);
		return null;
	} catch (error) {
		if (!(error instanceof MaintenanceModeEnabledError) && !(error instanceof MaintenanceControlUnavailableError)) {
			throw error;
		}
		return maintenanceFailureResponse(error);
	}
}

export async function deferAlarmDuringMaintenance(
	db: D1DatabaseLike,
	storage: DurableObjectAlarmStorageLike,
	now = Date.now(),
): Promise<boolean> {
	try {
		const state = await readMaintenanceState(db);
		if (!state.enabled) {
			return false;
		}
	} catch (error) {
		if (!(error instanceof MaintenanceControlUnavailableError)) {
			throw error;
		}
		console.error('maintenance control check failed during Durable Object alarm', error);
	}
	// An alarm must be replaced before the current invocation returns or the
	// durable task would lose its wake-up. The bounded retry creates no business
	// mutation and lets pending work resume after maintenance without a sweep.
	await storage.setAlarm(now + maintenanceAlarmRetryMs);
	return true;
}
