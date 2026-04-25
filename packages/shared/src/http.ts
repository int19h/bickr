export function json(data: unknown, init?: ResponseInit): Response {
	return Response.json(data, {
		headers: {
			"cache-control": "no-store",
		},
		...init,
	});
}
