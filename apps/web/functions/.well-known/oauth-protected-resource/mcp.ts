import { type AppEnv } from "../../api/_auth";
import { protectedResourceMetadataResponse } from "../oauth-protected-resource";

export const onRequestGet: PagesFunction<AppEnv> = async ({ request }) => {
	return protectedResourceMetadataResponse(request);
};
