import { bootstrapPayload } from "@bickr/shared/bootstrap";
import { json } from "./_json";

export const onRequestGet: PagesFunction<Env> = () => {
	return json(bootstrapPayload);
};
