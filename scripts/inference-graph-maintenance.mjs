const [action, ...argumentsList] = process.argv.slice(2);
const options = parseOptions(argumentsList);
const origin = requiredOption(options, "origin").replace(/\/$/, "");
const secret = process.env.TEST_AUTH_SECRET?.trim();
if (!secret) throw new Error("TEST_AUTH_SECRET is required.");

switch (action) {
	case "status-user":
		print(await proxy("GET", `/users/${encodeURIComponent(requiredOption(options, "user"))}/inference-graph/migration`));
		break;
	case "migrate-user":
		await migrateUser(requiredOption(options, "user"));
		break;
	case "translation-status-user":
		print(await proxy("GET", `/users/${encodeURIComponent(requiredOption(options, "user"))}/inference-translation-role/migration`));
		break;
	case "migrate-translation-user":
		print(await proxy("POST", `/users/${encodeURIComponent(requiredOption(options, "user"))}/inference-translation-role/migrate`));
		break;
	case "migrate-translation-fleet":
		await migrateTranslationFleet();
		break;
	case "provider-default-barrier-status": {
		const params = new URLSearchParams();
		if (options.get("cursor")) params.set("cursor", options.get("cursor"));
		if (options.get("limit")) params.set("limit", options.get("limit"));
		print(await proxy("GET", `/inference-graph/provider-default-barrier-sweep/status${params.size ? `?${params}` : ""}`));
		break;
	}
	case "sweep-provider-default-barriers-user":
		await sweepProviderDefaultBarriersUser(requiredOption(options, "user"));
		break;
	case "sweep-provider-default-barriers-fleet":
		await sweepProviderDefaultBarriersFleet();
		break;
	case "rollback-user":
		print(await proxy("POST", `/users/${encodeURIComponent(requiredOption(options, "user"))}/inference-graph/rollback`));
		break;
	case "reactivate-user":
		print(await proxy("POST", `/users/${encodeURIComponent(requiredOption(options, "user"))}/inference-graph/reactivate`));
		break;
	case "fleet-status": {
		const params = new URLSearchParams();
		if (options.get("cursor")) params.set("cursor", options.get("cursor"));
		if (options.get("limit")) params.set("limit", options.get("limit"));
		print(await proxy("GET", `/inference-graph/fleet-status${params.size ? `?${params}` : ""}`));
		break;
	}
	case "cleanup":
		print(await proxy("POST", "/inference-graph/cleanup", { limit: optionalPositiveInteger(options, "limit") ?? 100 }));
		break;
	case "activate-lifecycle":
		print(await proxy("POST", "/inference-graph/activate-lifecycle"));
		break;
	default:
		throw new Error("Usage: inference-graph-maintenance <status-user|migrate-user|translation-status-user|migrate-translation-user|migrate-translation-fleet|provider-default-barrier-status|sweep-provider-default-barriers-user|sweep-provider-default-barriers-fleet|rollback-user|reactivate-user|fleet-status|cleanup|activate-lifecycle> --origin URL [--user ID] [--limit N] [--cursor CURSOR] [--max-steps N]");
}

async function migrateUser(userId) {
	const maximumSteps = optionalPositiveInteger(options, "max-steps") ?? 1_000;
	for (let step = 0; step < maximumSteps; step += 1) {
		const payload = await proxy("POST", `/users/${encodeURIComponent(userId)}/inference-graph/migrate`);
		print(payload);
		const migration = payload?.data?.migration;
		if (migration?.complete === true) return;
	}
	throw new Error(`Migration did not reach terminal state within ${maximumSteps} steps.`);
}

async function sweepProviderDefaultBarriersUser(userId) {
	const maximumSteps = optionalPositiveInteger(options, "max-steps") ?? 1_000;
	for (let step = 0; step < maximumSteps; step += 1) {
		const payload = await proxy("POST", `/users/${encodeURIComponent(userId)}/inference-graph/provider-default-barrier-sweep`);
		print(payload);
		if (payload?.data?.sweep?.phase === "terminal" || payload?.data?.sweep?.phase === "not_needed") return;
	}
	throw new Error(`Provider-default barrier sweep did not reach terminal state within ${maximumSteps} steps.`);
}

// The fleet step claims the least recently attempted pending owners itself, so
// this driver just repeats it. Owners that keep failing surface in every step's
// printed attempts and are bounded by --max-steps rather than by a cursor.
async function sweepProviderDefaultBarriersFleet() {
	const maximumSteps = optionalPositiveInteger(options, "max-steps") ?? 1_000;
	const limit = optionalPositiveInteger(options, "limit") ?? 25;
	for (let step = 0; step < maximumSteps; step += 1) {
		const payload = await proxy("POST", "/inference-graph/provider-default-barrier-sweep", { limit });
		print(payload);
		if (payload?.data?.sweep?.complete === true) return;
	}
	throw new Error(`Provider-default barrier fleet sweep did not complete within ${maximumSteps} steps.`);
}

async function migrateTranslationFleet() {
	const limit = optionalPositiveInteger(options, "limit") ?? 100;
	let cursor = options.get("cursor") ?? "";
	let failures = 0;
	do {
		const params = new URLSearchParams({ limit: String(limit) });
		if (cursor) params.set("cursor", cursor);
		const page = await proxy("GET", `/inference-graph/fleet-status?${params}`);
		for (const owner of page?.data?.status?.items ?? []) {
			try {
				const status = await proxy("GET", `/users/${encodeURIComponent(owner.ownerUserId)}/inference-translation-role/migration`);
				print(status);
				const migration = status?.data?.migration;
				if (migration?.state === "corrupt") {
					failures += 1;
					continue;
				}
				if (migration?.state === "migration_needed") {
					print(await proxy("POST", `/users/${encodeURIComponent(owner.ownerUserId)}/inference-translation-role/migrate`));
				}
			} catch (error) {
				failures += 1;
				print({
					ownerUserId: owner.ownerUserId,
					state: "request_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		cursor = page?.data?.status?.nextCursor ?? "";
	} while (cursor);
	if (failures) throw new Error(`Translation role fleet migration completed with ${failures} owner failure(s).`);
}

async function proxy(method, path, body) {
	const pathUser = /^\/users\/([^/]+)\//.exec(path)?.[1];
	const userId = pathUser ? decodeURIComponent(pathUser) : options.get("user") ?? "usr_inference_graph_maintenance";
	const response = await fetch(`${origin}/api/__test__/service-proxy`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-test-auth-secret": secret,
		},
		body: JSON.stringify({
			service: "agent-runtime",
			method,
			path,
			headers: {
				"x-bickr-scheduler": "1",
				"x-bickr-user-id": userId,
			},
			...(body === undefined ? {} : { body }),
		}),
	});
	const payload = await response.json();
	if (!response.ok || payload?.ok === false) {
		throw new Error(`Inference graph maintenance request failed with HTTP ${response.status}.`);
	}
	return payload;
}

function parseOptions(values) {
	const result = new Map();
	for (let index = 0; index < values.length; index += 2) {
		const name = values[index];
		const value = values[index + 1];
		if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid option ${name ?? ""}.`);
		result.set(name.slice(2), value);
	}
	return result;
}

function requiredOption(values, name) {
	const value = values.get(name)?.trim();
	if (!value) throw new Error(`--${name} is required.`);
	return value;
}

function optionalPositiveInteger(values, name) {
	const value = values.get(name);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
	return parsed;
}

function print(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}
