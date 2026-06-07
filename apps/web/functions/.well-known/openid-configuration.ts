import { type AppEnv } from "../api/_auth";
import { authorizationServerMetadata } from "./oauth-authorization-server";

export const onRequestGet: PagesFunction<AppEnv> = async ({ request }) => {
	return Response.json(authorizationServerMetadata(request), {
		headers: {
			"cache-control": "no-store",
		},
	});
};
