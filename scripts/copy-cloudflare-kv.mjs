#!/usr/bin/env node

const accountId = requiredEnvironment('CLOUDFLARE_ACCOUNT_ID');
const sourceNamespaceId = requiredEnvironment('SOURCE_NAMESPACE_ID');
const destinationNamespaceId = requiredEnvironment('DESTINATION_NAMESPACE_ID');
const dryRun = process.argv.includes('--dry-run');

if (sourceNamespaceId === destinationNamespaceId) {
	throw new Error('Source and destination KV namespaces must differ.');
}

const authHeaders = cloudflareAuthHeaders();
const apiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`;
const maximumBulkEntries = 500;
const maximumBulkBytes = 45 * 1024 * 1024;
const maximumBulkReadEntries = 100;
// A KV value can be 25 MiB. Bound raw fallback reads so a batch containing
// binary values cannot create an unbounded in-memory response set.
const rawReadConcurrency = 4;
let bulkReadsAvailable = true;

class NonRetryableRequestError extends Error {}

if (!dryRun) {
	const confirmation = `${sourceNamespaceId}->${destinationNamespaceId}`;
	if (process.env.CONFIRM_KV_COPY !== confirmation) {
		throw new Error(`Set CONFIRM_KV_COPY=${confirmation} to authorize this exact copy.`);
	}
	if (process.env.CONFIRM_MAINTENANCE_FREEZE !== 'enabled') {
		throw new Error('Set CONFIRM_MAINTENANCE_FREEZE=enabled only after Bickr maintenance mode is active.');
	}
	const destinationFirstPage = await listKeyPage(destinationNamespaceId);
	if (destinationFirstPage.result.length > 0) {
		throw new Error('The destination KV namespace is not empty; refusing to merge or overwrite a backup.');
	}
}

let sourceKeys = 0;
let copiedKeys = 0;
let copiedBytes = 0;
let writeBatch = [];
let writeBatchRequestBytes = 0;
let writeBatchRawBytes = 0;
const prefixCounts = new Map();

for await (const keys of listAllKeys(sourceNamespaceId)) {
	for (const key of keys) {
		sourceKeys += 1;
		const prefix = keyPrefix(key.name);
		prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
	}
	if (dryRun) {
		continue;
	}

	for (let offset = 0; offset < keys.length; offset += maximumBulkReadEntries) {
		const group = keys.slice(offset, offset + maximumBulkReadEntries);
		const values = await readKeys(sourceNamespaceId, group);
		for (const value of values) {
			const approximateRequestBytes =
				Buffer.byteLength(value.key) +
				Math.ceil(value.raw.byteLength / 3) * 4 +
				Buffer.byteLength(JSON.stringify(value.metadata ?? null)) +
				256;
			if (
				writeBatch.length > 0 &&
				(writeBatch.length >= maximumBulkEntries || writeBatchRequestBytes + approximateRequestBytes > maximumBulkBytes)
			) {
				await flushBatch();
			}
			writeBatch.push(toBulkWrite(value));
			writeBatchRequestBytes += approximateRequestBytes;
			writeBatchRawBytes += value.raw.byteLength;
		}
	}
}

if (!dryRun) {
	await flushBatch();
}

console.log(
	JSON.stringify(
		{
			dryRun,
			sourceNamespaceId,
			destinationNamespaceId,
			sourceKeys,
			copiedKeys,
			copiedBytes,
			prefixCounts: Object.fromEntries([...prefixCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
		},
		null,
		2,
	),
);

async function flushBatch() {
	if (writeBatch.length === 0) {
		return;
	}
	await cloudflareRequest(`${apiBase}/${destinationNamespaceId}/bulk`, {
		method: 'PUT',
		headers: { ...authHeaders, 'content-type': 'application/json' },
		body: JSON.stringify(writeBatch),
	});
	copiedKeys += writeBatch.length;
	copiedBytes += writeBatchRawBytes;
	writeBatch = [];
	writeBatchRequestBytes = 0;
	writeBatchRawBytes = 0;
}

async function* listAllKeys(namespaceId) {
	let cursor;
	const seenCursors = new Set();
	do {
		const page = await listKeyPage(namespaceId, cursor);
		yield page.result;
		cursor = page.result_info?.cursor || undefined;
		if (cursor && seenCursors.has(cursor)) {
			throw new Error('Cloudflare KV key pagination returned a repeated cursor.');
		}
		if (cursor) {
			seenCursors.add(cursor);
		}
	} while (cursor);
}

async function listKeyPage(namespaceId, cursor) {
	const url = new URL(`${apiBase}/${namespaceId}/keys`);
	url.searchParams.set('limit', '1000');
	if (cursor) {
		url.searchParams.set('cursor', cursor);
	}
	return cloudflareRequest(url);
}

async function readKey(namespaceId, key) {
	const url = `${apiBase}/${namespaceId}/values/${encodeURIComponent(key.name)}`;
	const response = await fetchWithRetry(url, { headers: authHeaders });
	return {
		key: key.name,
		raw: Buffer.from(await response.arrayBuffer()),
		expiration: key.expiration,
		metadata: key.metadata,
	};
}

async function readKeys(namespaceId, keys) {
	if (!bulkReadsAvailable) {
		return readKeysIndividually(namespaceId, keys);
	}
	try {
		const response = await cloudflareRequest(`${apiBase}/${namespaceId}/bulk/get`, {
			method: 'POST',
			headers: { ...authHeaders, 'content-type': 'application/json' },
			body: JSON.stringify({
				keys: keys.map((key) => key.name),
				type: 'text',
			}),
		});
		const values = response.result?.values;
		if (!values || typeof values !== 'object' || Array.isArray(values)) {
			throw new Error('Cloudflare KV bulk read returned an invalid values map.');
		}
		return keys.map((key) => {
			const value = values[key.name];
			if (typeof value !== 'string') {
				throw new Error(`Cloudflare KV bulk read omitted or changed the type of key ${key.name}.`);
			}
			return {
				key: key.name,
				raw: Buffer.from(value, 'utf8'),
				expiration: key.expiration,
				metadata: key.metadata,
			};
		});
	} catch (error) {
		// The REST bulk-read endpoint accepts only text values. Preserve the
		// original byte-for-byte path for an entire batch if Cloudflare rejects
		// it or reports a non-text value, so a future binary KV record cannot make
		// a launch backup incomplete.
		if (!(error instanceof NonRetryableRequestError)) {
			bulkReadsAvailable = false;
			console.warn('Cloudflare KV bulk reads are unavailable; using bounded raw reads for the remaining backup.');
		}
		return readKeysIndividually(namespaceId, keys);
	}
}

async function readKeysIndividually(namespaceId, keys) {
	const values = [];
	for (let offset = 0; offset < keys.length; offset += rawReadConcurrency) {
		values.push(...await Promise.all(
			keys.slice(offset, offset + rawReadConcurrency).map((key) => readKey(namespaceId, key)),
		));
	}
	return values;
}

function toBulkWrite(value) {
	const output = {
		key: value.key,
		value: value.raw.toString('base64'),
		base64: true,
	};
	if (typeof value.expiration === 'number') {
		output.expiration = value.expiration;
	}
	if (value.metadata !== undefined && value.metadata !== null) {
		output.metadata = value.metadata;
	}
	return output;
}

async function cloudflareRequest(url, init = {}) {
	const response = await fetchWithRetry(url, { ...init, headers: init.headers ?? authHeaders });
	const body = await response.json();
	if (!body.success) {
		throw new Error(`Cloudflare API rejected the request: ${JSON.stringify(body.errors)}`);
	}
	return body;
}

async function fetchWithRetry(url, init) {
	let lastError;
	for (let attempt = 0; attempt < 7; attempt += 1) {
		try {
			const response = await fetch(url, init);
			if (response.ok) {
				return response;
			}
			const body = await response.text();
			if (response.status !== 429 && response.status < 500) {
				throw new NonRetryableRequestError(`Cloudflare request failed with ${response.status}: ${body}`);
			}
			lastError = new Error(`Cloudflare request failed with ${response.status}: ${body}`);
		} catch (error) {
			if (error instanceof NonRetryableRequestError) {
				throw error;
			}
			lastError = error;
		}
		if (attempt < 6) {
			await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
		}
	}
	throw lastError;
}
function cloudflareAuthHeaders() {
	const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (apiToken) {
		return { authorization: `Bearer ${apiToken}` };
	}
	const apiKey = requiredEnvironment('CLOUDFLARE_API_KEY');
	const email = requiredEnvironment('CLOUDFLARE_EMAIL');
	return { 'x-auth-email': email, 'x-auth-key': apiKey };
}

function requiredEnvironment(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable ${name}.`);
	}
	return value;
}

function keyPrefix(key) {
	const parts = key.split(':');
	return parts[0] === 'v1' && parts.length > 1 ? `${parts[0]}:${parts[1]}` : parts[0];
}
