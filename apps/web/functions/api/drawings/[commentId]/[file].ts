import type { AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { drawingPreviewResponse } from "../../../_drawing-previews";

/** `GET /api/drawings/<commentId>/<index>.png`: the link preview image of one drawing. */
export const onRequestGet: PagesFunction<AppEnv, "commentId" | "file"> = async ({ env, request, params }) => {
	try {
		const commentId = Array.isArray(params.commentId) ? params.commentId[0] : params.commentId;
		const file = Array.isArray(params.file) ? params.file[0] : params.file;
		const index = /^(\d{1,3})\.png$/.exec(file ?? "")?.[1];
		if (!commentId || !/^[A-Za-z0-9_-]{1,80}$/.test(commentId) || index === undefined) {
			return new Response("Not found.", { status: 404 });
		}
		return await drawingPreviewResponse(env, request, commentId, Number(index));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
