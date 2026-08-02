// Guards apps/web/public/_headers and _routes.json against silent drift from
// the build output. Both files pin literal asset paths (notably the
// content-hashed workbox-*.js emitted by vite-plugin-pwa); if a pinned file
// stops existing, or a new workbox bundle appears unlisted, the affected asset
// silently falls back to Function routing and loses its _headers rules.
// Runs as part of `npm run build -w @bickr/web`, after `vite build`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(repoRoot, "apps", "web");
const distClient = join(webRoot, "dist", "client");
const routesPath = join(webRoot, "public", "_routes.json");
const headersPath = join(webRoot, "public", "_headers");

const failures = [];

if (!existsSync(distClient)) {
	fail(`Build output ${distClient} does not exist; run vite build first.`);
}

const routes = JSON.parse(readFileSync(routesPath, "utf8"));
const excludePaths = Array.isArray(routes.exclude) ? routes.exclude : [];
const headerRules = parseHeaderRules(readFileSync(headersPath, "utf8"));
const headerPaths = [...headerRules.keys()];

for (const path of [...excludePaths, ...headerPaths]) {
	if (path.includes("*")) {
		continue;
	}
	if (!existsSync(join(distClient, ...path.split("/").filter(Boolean)))) {
		failures.push(`${path} is pinned in _routes.json/_headers but missing from dist/client.`);
	}
}

for (const name of readdirSync(distClient)) {
	if (!/^workbox-.*\.js$/.test(name)) {
		continue;
	}
	const path = `/${name}`;
	if (!excludePaths.includes(path)) {
		failures.push(`${path} exists in dist/client but is not excluded in _routes.json.`);
	}
	if (!headerPaths.includes(path)) {
		failures.push(`${path} exists in dist/client but has no _headers rule.`);
	}
}

const serviceWorkerPath = join(distClient, "sw.js");
if (existsSync(serviceWorkerPath)) {
	const serviceWorker = readFileSync(serviceWorkerPath, "utf8");
	if (/NavigationRoute|createHandlerBoundToURL/.test(serviceWorker)) {
		failures.push("/sw.js still installs a navigation fallback that can bypass Pages Functions gates.");
	}
	if (/url\s*:\s*["']\/?index\.html["']/.test(serviceWorker)) {
		failures.push("/sw.js still precaches the HTML app shell.");
	}
}

const serviceWorkerHeaders = headerRules.get("/sw.js") ?? [];
if (!serviceWorkerHeaders.includes("cache-control: no-cache, no-store, must-revalidate")) {
	failures.push("/sw.js must be served with Cache-Control: no-cache, no-store, must-revalidate.");
}

if (failures.length > 0) {
	fail([
		"Pages static config is out of sync with the build output:",
		...failures.map((failure) => `  - ${failure}`),
		"Update apps/web/public/_routes.json and apps/web/public/_headers (the workbox filename changes with its content hash).",
	].join("\n"));
}

console.log("Pages static config matches build output.");

function fail(message) {
	console.error(message);
	process.exit(1);
}

function parseHeaderRules(contents) {
	const rules = new Map();
	let currentPath = null;
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (/^\/\S*$/.test(trimmed)) {
			currentPath = trimmed;
			rules.set(currentPath, []);
			continue;
		}
		if (currentPath && trimmed && !trimmed.startsWith("/*")) {
			rules.get(currentPath).push(trimmed.toLowerCase());
		}
	}
	return rules;
}
