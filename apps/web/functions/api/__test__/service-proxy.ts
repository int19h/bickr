import { readJsonBody } from "@bickr/shared/api";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { mutationMaintenanceResponse } from "@bickr/shared/maintenance";
import { asRecord, InputError, requiredText } from "@bickr/shared/validation";
import { type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";
import { testAuthFailureResponse } from "./_test-auth";

type ServiceProxyService = "agent-runtime" | "forum-coordinator";

type ServiceProxyInput = {
	service: ServiceProxyService;
	method: string;
	path: string;
	headers: Headers;
	body?: BodyInit;
};

const serviceProxyMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const serviceProxyRequestHeaders = new Set([
	"accept",
	"x-bickr-bot-id",
	"x-bickr-scheduler",
	"x-bickr-thread-id",
	"x-bickr-user-id",
]);
const pathControlPattern = /[\u0000-\u001f\u007f]/;
const headerValueControlPattern = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const authFailure = await testAuthFailureResponse(env, request);
		if (authFailure) {
			return authFailure;
		}

		const input = parseServiceProxyInput(await readJsonBody(request));
		const host = new URL(request.url).hostname;
		console.log("test service proxy request", {
			host,
			method: input.method,
			path: input.path,
			service: input.service,
		});

		const serviceRequest = new Request(internalServiceUrl(input.path), {
			body: input.body,
			headers: serviceProxyHeaders(input.headers, env.INTERNAL_SERVICE_SECRET),
			method: input.method,
		});
		// These scheduler-authenticated operations require maintenance in their
		// agent-runtime handlers. The test proxy must let them reach that stricter
		// gate; every other mutation retains the shared maintenance rejection.
		const maintenanceResponse = isInferenceGraphMaintenanceOperation(input) ? null : await mutationMaintenanceResponse(serviceRequest, env.BICKR_D1, {
			allowRuntimeStop: true,
		});
		if (maintenanceResponse) {
			return maintenanceResponse;
		}
		const response = await serviceBinding(env, input.service).fetch(serviceRequest);
		return safeServiceProxyResponse(response);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function isInferenceGraphMaintenanceOperation(input: ServiceProxyInput): boolean {
	if (input.service !== "agent-runtime" || input.method !== "POST") return false;
	return /^\/users\/[^/]+\/inference-graph\/(?:migrate|rollback|reactivate)$/.test(input.path) ||
		/^\/users\/[^/]+\/inference-translation-role\/migrate$/.test(input.path) ||
		/^\/inference-graph\/(?:cleanup|activate-lifecycle)$/.test(input.path);
}

function parseServiceProxyInput(input: unknown): ServiceProxyInput {
	const record = asRecord(input);
	const service = parseService(record.service);
	const method = requiredText(record.method ?? "GET", "Method", 12).toUpperCase();
	if (!serviceProxyMethods.has(method)) {
		throw new InputError("Service proxy method is not allowed.");
	}
	const path = parseServicePath(record.path);
	const headers = parseServiceHeaders(record.headers);
	const body = parseServiceBody(record, method, headers);
	return {
		service,
		method,
		path,
		headers,
		...(body === undefined ? {} : { body }),
	};
}

function parseService(value: unknown): ServiceProxyService {
	if (value === "agent-runtime" || value === "forum-coordinator") {
		return value;
	}
	throw new InputError("Service must be agent-runtime or forum-coordinator.");
}

function parseServicePath(value: unknown): string {
	const path = requiredString(value, "Path", 2_000);
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || pathControlPattern.test(path)) {
		throw new InputError("Path must be a relative service path.");
	}
	try {
		new URL(path, internalServiceUrl("/"));
	} catch {
		throw new InputError("Path must be a valid service path.");
	}
	return path;
}

function parseServiceHeaders(value: unknown): Headers {
	const headers = new Headers();
	if (value === undefined || value === null) {
		return headers;
	}
	const record = asRecord(value);
	for (const [rawName, rawValue] of Object.entries(record)) {
		const name = rawName.toLowerCase();
		if (!serviceProxyRequestHeaders.has(name)) {
			throw new InputError(`Header ${rawName} is not allowed.`);
		}
		if (typeof rawValue !== "string") {
			throw new InputError(`Header ${rawName} must be a string.`);
		}
		if (headerValueControlPattern.test(rawValue)) {
			throw new InputError(`Header ${rawName} contains invalid characters.`);
		}
		if (name === "x-bickr-scheduler" && rawValue !== "1") {
			throw new InputError("x-bickr-scheduler must be 1.");
		}
		headers.set(name, rawValue);
	}
	return headers;
}

function parseServiceBody(record: Record<string, unknown>, method: string, headers: Headers): BodyInit | undefined {
	const hasJsonBody = Object.hasOwn(record, "body");
	const hasRawBody = Object.hasOwn(record, "bodyText");
	if (hasJsonBody && hasRawBody) {
		throw new InputError("Specify either body or bodyText, not both.");
	}
	if (!hasJsonBody && !hasRawBody) {
		if (record.contentType !== undefined) {
			throw new InputError("contentType requires bodyText or body.");
		}
		return undefined;
	}
	if (method === "GET") {
		throw new InputError("GET service proxy requests cannot include a body.");
	}
	if (hasRawBody) {
		const bodyText = requiredString(record.bodyText, "Body text", 1_000_000, true);
		headers.set("content-type", parseContentType(record.contentType ?? "text/plain;charset=UTF-8"));
		return bodyText;
	}

	headers.set("content-type", parseContentType(record.contentType ?? "application/json"));
	return JSON.stringify(record.body);
}

function serviceProxyHeaders(inputHeaders: Headers, internalServiceSecret: string | undefined): Headers {
	const headers = new Headers(inputHeaders);
	addInternalServiceAuthHeader(headers, internalServiceSecret);
	return headers;
}

function parseContentType(value: unknown): string {
	const contentType = requiredText(value, "Content type", 200);
	if (headerValueControlPattern.test(contentType)) {
		throw new InputError("Content type contains invalid characters.");
	}
	return contentType;
}

function serviceBinding(env: AppEnv, service: ServiceProxyService): Fetcher {
	return service === "agent-runtime" ? env.AGENT_RUNTIME : env.FORUM_COORDINATOR_SERVICE;
}

function requiredString(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new InputError(`${label} is required.`);
	}
	if (value.length > maxLength) {
		throw new InputError(`${label} must be ${maxLength} characters or fewer.`);
	}
	return value;
}

function safeServiceProxyResponse(response: Response): Response {
	const headers = new Headers({
		"cache-control": "no-store",
	});
	const contentType = response.headers.get("content-type");
	if (contentType !== null) {
		headers.set("content-type", contentType);
	}
	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}
