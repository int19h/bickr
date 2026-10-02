import { sha256 } from "./release-support.mjs";

function entryAssets(html) {
	return [...new Set(Array.from(html.matchAll(/(?:src|href)\s*=\s*["'](\/assets\/[^"'?#]+)["']/g), (match) => match[1]))];
}

export async function verifyPublicRelease(plan, checks, localHtml, request = fetch) {
	// Test's migration gateway requires the same explicit opt-in as a browser.
	// Send it on the entry and asset requests; it grants no account identity.
	const headers = plan.environment === "test" ? { cookie: "bickr_test_environment=1" } : {};
	const get = (path, timeout) => request(`${plan.origin}${path}`, { headers, cache: "no-store", signal: AbortSignal.timeout(timeout) });
	const health = await get("/api/runtime/health", 40_000);
	if (!health.ok || (await health.json()).ok !== true) throw new Error("The custom domain runtime health check failed.");
	const index = await get(`/?release=${plan.commit}`, 30_000);
	if (!index.ok) throw new Error("The custom domain entry page failed.");
	const html = await index.text();
	// Pages rewrites titles, metadata, and the test notice. A source marker and
	// immutable entry asset hashes survive those expected HTML transformations.
	const markers = html.match(/<meta\b[^>]*>/gi) ?? [];
	const content = new RegExp(`\\bcontent=["']${plan.commit}["']`);
	if (!markers.some((tag) => /\bname=["']bickr-release["']/.test(tag) && content.test(tag))) {
		throw new Error("The custom domain does not serve the checked release marker.");
	}
	const paths = entryAssets(localHtml);
	const published = new Set(entryAssets(html));
	if (!paths.length || paths.some((path) => !published.has(path))) throw new Error("The custom domain entry assets differ from the checked build.");
	for (const path of paths) {
		const asset = await get(path, 30_000);
		if (!asset.ok || sha256(Buffer.from(await asset.arrayBuffer())) !== checks.build[path.slice(1)]) {
			throw new Error(`The custom domain asset does not match: ${path}`);
		}
	}
}
