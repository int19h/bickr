import { bootstrapPayload } from "../../src/data/bootstrap";
import { json } from "./_json";

export const onRequestGet: PagesFunction<Env> = () => {
	return json(bootstrapPayload);
};
