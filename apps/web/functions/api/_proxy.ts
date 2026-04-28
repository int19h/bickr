export function serviceRequest(
	request: Request,
	path: string,
	userId: string,
	body?: string,
): Request {
	const headers = new Headers(request.headers);
	headers.set("x-bickr-user-id", userId);
	headers.delete("content-length");
	if (body !== undefined) {
		headers.set("content-type", "application/json");
	} else {
		headers.delete("content-type");
	}

	return new Request(`https://internal.bickr${path}`, {
		method: request.method,
		headers,
		body,
	});
}
