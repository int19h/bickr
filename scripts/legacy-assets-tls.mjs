import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function tlsPlan(config) {
	return {
		method: "PUT",
		url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(config.bucket)}/domains/custom/${encodeURIComponent(config.domain)}`,
		body: { minTLS: config.minTLS },
	};
}

export async function inspectTLS(config, token, request = fetch) {
	if (!token) throw new Error("Set CLOUDFLARE_API_TOKEN without putting it in command arguments or logs.");
	const response = await request(tlsPlan(config).url, {
		headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`R2 custom domain read failed (HTTP ${response.status}).`);
	const body = await response.json();
	if (body.success !== true || body.result?.domain !== config.domain) throw new Error("R2 returned an unexpected domain configuration.");
	return body.result;
}

export async function applyTLS(config, token, request = fetch) {
	const before = await inspectTLS(config, token, request);
	if (before.minTLS === config.minTLS || before.minTLS === "1.3") return { kind: "already-secure", before };
	if (before.minTLS !== config.expectedMinTLS || before.enabled !== true) throw new Error("The domain state changed; review a fresh plan before writing.");
	const plan = tlsPlan(config);
	const response = await request(plan.url, {
		method: plan.method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(plan.body), signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok || (await response.json()).success !== true) throw new Error(`R2 TLS update failed (HTTP ${response.status}); inspect the domain before retrying.`);
	const after = await inspectTLS(config, token, request);
	if (after.minTLS !== config.minTLS) throw new Error("R2 did not return the requested minimum TLS version.");
	return { kind: "updated", before, after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { values } = parseArgs({ options: { inspect: { type: "boolean" }, apply: { type: "boolean" } } });
	if (values.inspect && values.apply) throw new Error("Select --inspect or --apply, not both.");
	const config = JSON.parse(readFileSync(new URL("../ops/legacy-assets-tls.json", import.meta.url), "utf8"));
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const result = values.apply ? await applyTLS(config, token) : values.inspect ? await inspectTLS(config, token) : tlsPlan(config);
	console.log(JSON.stringify(result, null, 2));
}
