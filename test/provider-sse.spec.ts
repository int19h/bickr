import { describe, expect, it } from "vitest";
import { BotRuntime, readSse } from "../workers/agent-runtime/src/index";

type TestProviderResponse = {
	content: string;
	reasoning: string;
	reasoningDetails: Array<Record<string, unknown>>;
	toolCalls: Array<Record<string, unknown>>;
	rawResponse?: string;
	skippedRawResponse?: string;
};

describe("provider SSE parsing", () => {
	it.each([
		{
			name: "LF framing",
			chunks: ["data: one\n\n", "data: two\n\n"],
			data: ["one", "two"],
		},
		{
			name: "CRLF framing",
			chunks: ["data: one\r\n\r\n", "data: two\r\n\r\n"],
			data: ["one", "two"],
		},
		{
			name: "mixed framing",
			chunks: ["data: one\n\n", "data: two\r\n\r\n", "data: three\n\r\n"],
			data: ["one", "two", "three"],
		},
		{
			name: "CRLF boundary split across chunks",
			chunks: ["data: split\r", "\n", "\r", "\n"],
			data: ["split"],
		},
		{
			name: "final event without trailing blank line",
			chunks: ["data: final"],
			data: ["final"],
		},
	])("reads $name", async ({ chunks, data }) => {
		await expect(collectSseData(chunks)).resolves.toEqual(data);
	});

	it("combines multi-line data events", async () => {
		await expect(collectSseData(["data: hello\r\ndata: world\r\n\r\n"])).resolves.toEqual(["hello\nworld"]);
	});

	it("skips malformed provider chunks without losing streamed content", async () => {
		const clean = await consumeProviderResponse([
			providerContentFrame("hello "),
			providerContentFrame("world"),
			"data: [DONE]\n\n",
		]);
		const withGarbage = await consumeProviderResponse([
			providerContentFrame("hello "),
			"data: not-json\n\n",
			providerContentFrame("world"),
			"data: [DONE]\n\n",
		]);

		expect(withGarbage.content).toBe(clean.content);
		expect(withGarbage.content).toBe("hello world");
		expect(withGarbage.toolCalls).toEqual([]);
		expect(withGarbage.rawResponse).toContain("data: not-json");
		expect(withGarbage.skippedRawResponse).toContain("data: not-json");
	});
});

async function collectSseData(chunks: string[]): Promise<string[]> {
	const events: string[] = [];
	for await (const event of readSse(streamFromTextChunks(chunks), new AbortController().signal)) {
		events.push(event.data);
	}
	return events;
}

async function consumeProviderResponse(frames: string[]): Promise<TestProviderResponse> {
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		broadcastProviderDelta: () => {},
		clearProviderStreamActive: () => {},
		markProviderStreamActive: () => {},
		throwIfStopped: (_runId: string, signal: AbortSignal) => {
			if (signal.aborted) {
				throw new Error("Unexpected abort.");
			}
		},
	});
	const consume = (BotRuntime.prototype as unknown as {
		consumeProviderResponse: (
			runId: string,
			streamSeq: number,
			stream: ReadableStream<Uint8Array>,
			signal: AbortSignal,
		) => Promise<TestProviderResponse>;
	}).consumeProviderResponse.bind(runtime);
	return consume("run-provider-sse", 1, streamFromTextChunks(frames), new AbortController().signal);
}

function providerContentFrame(content: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function streamFromTextChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}
