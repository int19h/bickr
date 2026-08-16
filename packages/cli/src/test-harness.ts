import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * Test-only support for running the CLI as a program.
 *
 * What a command writes to stdout versus stderr, and what it exits with, is a
 * contract with whoever scripts it — and none of it is observable from inside
 * the process. These start a stub API on a loopback port and run the real entry
 * point against it.
 */

const entry = join(import.meta.dirname, "index.ts");

export type StubRequest = {
	method: string;
	pathname: string;
	searchParams: URLSearchParams;
	body: Record<string, unknown>;
};

export type StubReply = {
	status?: number;
	body: unknown;
};

export type StubApi = {
	server: Server;
	port: number;
	requests: StubRequest[];
	close: () => Promise<void>;
};

/** Serves one loopback API; an unmatched route answers a typed 404 like the real one. */
export function startStubApi(route: (request: StubRequest) => StubReply | undefined): Promise<StubApi> {
	const requests: StubRequest[] = [];
	const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
		const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const request: StubRequest = {
				method: incoming.method ?? "GET",
				pathname: url.pathname,
				searchParams: url.searchParams,
				body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {},
			};
			requests.push(request);
			const reply = route(request) ?? {
				status: 404,
				body: { ok: false, error: "not_found", message: `No stub for ${url.pathname}` },
			};
			response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
			response.end(JSON.stringify(reply.body));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				server,
				port: typeof address === "object" && address ? address.port : 0,
				requests,
				close: () => new Promise<void>((closed) => server.close(() => closed())),
			});
		});
	});
}

export type CliRun = {
	code: number;
	stdout: string;
	stderr: string;
};

export function runCli(port: number, args: string[]): Promise<CliRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...args], {
			env: {
				...process.env,
				BICKR_HOST: `http://127.0.0.1:${port}`,
				BICKR_TOKEN: "test-token",
				// Never read or write the developer's own CLI configuration.
				BICKR_CONFIG: join(import.meta.dirname, "no-such-cli-config.json"),
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});
}
