import { readMaintenanceState } from '@bickr/shared/maintenance';
import { json } from './_json';
import type { AppEnv } from './_auth';

export const onRequestGet: PagesFunction<AppEnv> = async ({ env }) => {
	try {
		return json({
			ok: true,
			maintenance: await readMaintenanceState(env.BICKR_D1),
		});
	} catch (error) {
		console.error('maintenance status read failed', error);
		return json(
			{
				ok: false,
				error: 'maintenance',
				message: 'The maintenance control is unavailable.',
			},
			{ status: 503 },
		);
	}
};
