import { bootstrapPayload } from "@bickr/shared/bootstrap";
import type { AppEnv } from "./_auth";
import { json } from "./_json";

export const onRequestGet: PagesFunction<AppEnv> = () => {
	return json(bootstrapPayload);
};
