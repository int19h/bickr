import { ProviderResponseInterruptedError } from '../workers/agent-runtime/src/errors';
import type { AgentLogStreamDelta } from '@bickr/shared/model';
import { describe, expect, it } from "vitest";
import {
	consumeProviderResponse as consumeProviderSseResponse,
	readLimitedText,
	readSse,
	withAbortableTimeout,
	type ProviderSseRuntime,
} from "../workers/agent-runtime/src/provider/sse";

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

	it("bounds buffered stream reads", async () => {
		await expect(readLimitedText(streamFromTextChunks(["abcdef"]), 3)).resolves.toBe("abc...");
	});

	it("rejects an already-aborted timeout parent", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(withAbortableTimeout(controller.signal, 100, () => new Error("timeout"), async () => "unused")).rejects.toMatchObject({
			name: "TickStoppedError",
		});
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
	it.each([true, false])('keeps only readable reasoning when completed=%s', async completed => {
		const details = [
			{ type: 'reasoning.text', index: 0, text: 'Text' },
			{ type: 'reasoning.summary', index: 1, summary: [{ text: 'Summary' }] },
			{ type: 'reasoning.encrypted', index: 2, text: 'OPAQUE_ENCRYPTED', data: 'EXACT_SIGNATURE' },
			{ type: 'future.type', index: 3, text: 'OPAQUE_FUTURE', summary: 'OPAQUE_SUMMARY' },
		];
		const deltas: AgentLogStreamDelta[] = [];
		const frames = [
			`data: ${JSON.stringify({ choices: [{ delta: { content: 'Reply', reasoning: 'Plain', reasoning_details: details } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'future.type', text: 'OPAQUE_LATE' }] } }] })}\n\n`,
			...(completed ? ['data: [DONE]\n\n'] : []),
		];
		let response: TestProviderResponse;
		try {
			response = await consumeProviderResponse(frames, deltas);
			expect(completed).toBe(true);
		} catch (error) {
			expect(completed).toBe(false);
			expect(error).toBeInstanceOf(ProviderResponseInterruptedError);
			response = (error as ProviderResponseInterruptedError).response;
		}
		expect(response.reasoning).toBe('PlainTextSummary');
		expect(response.reasoningDetails).toEqual([...details, { type: 'future.type', text: 'OPAQUE_LATE' }]);
		const legacyText = deltas.filter(delta => delta.kind === 'reasoning').map(delta => delta.text ?? '').join('');
		expect(legacyText).toBe(response.reasoning);
		expect(JSON.stringify(deltas)).not.toContain('OPAQUE');
		expect(JSON.stringify(deltas)).not.toContain('EXACT_SIGNATURE');
	});

	it('streams typed reasoning without opaque bytes and retains the provider details', async () => {
		const deltas: AgentLogStreamDelta[] = [];
		const details = [
			{ type: 'reasoning.text', index: 0, id: 'thought', text: 'Readable thought', internal: 'PRIVATE' },
			{ type: 'reasoning.summary', index: 1, id: 'summary', summary: 'Readable summary', internal: 'PRIVATE' },
			{ type: 'reasoning.encrypted', index: 2, id: 'encrypted', text: 'OPAQUE_TEXT', data: 'OPAQUE_DATA' },
			{ type: 'future.type', index: 3, id: 'future', text: 'OPAQUE_FUTURE', summary: 'OPAQUE_SUMMARY' },
		];
		const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
		const response = await consumeProviderResponse([
			frame({ reasoning: 'Plain thought', reasoning_details: details }),
			frame({ reasoning_details: [{ ...details[2], data: 'OPAQUE_MORE' }, { type: 'future.type', id: 'id-only', text: 'OPAQUE_ID' }] }),
			'data: [DONE]\n\n',
		], deltas);
		expect(deltas).toEqual([
			{ kind: 'reasoning', source: 'plain', text: 'Plain thought' },
			{ kind: 'reasoning', source: 'detail', text: 'Readable thought', part: { kind: 'readable', type: 'reasoning.text', index: 0, id: 'thought', text: 'Readable thought' } },
			{ kind: 'reasoning', source: 'detail', text: 'Readable summary', part: { kind: 'readable', type: 'reasoning.summary', index: 1, id: 'summary', text: 'Readable summary' } },
			{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'reasoning.encrypted', index: 2, id: 'encrypted' } },
			{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'future.type', index: 3, id: 'future' } },
			{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'reasoning.encrypted', index: 2, id: 'encrypted' } },
			{ kind: 'reasoning', source: 'detail', part: { kind: 'opaque', type: 'future.type', id: 'id-only' } },
		]);
		expect(JSON.stringify(deltas)).not.toContain('OPAQUE');
		expect(JSON.stringify(deltas)).not.toContain('PRIVATE');
		expect(response.reasoning).toBe('Plain thoughtReadable thoughtReadable summary');
		expect(response.reasoningDetails).toEqual([...details, { ...details[2], data: 'OPAQUE_MORE' }, { type: 'future.type', id: 'id-only', text: 'OPAQUE_ID' }]);
	});

});

async function collectSseData(chunks: string[]): Promise<string[]> {
	const events: string[] = [];
	for await (const event of readSse(streamFromTextChunks(chunks), new AbortController().signal)) {
		events.push(event.data);
	}
	return events;
}

async function consumeProviderResponse(frames: string[], deltas: AgentLogStreamDelta[] = []): Promise<TestProviderResponse> {
	const runtime = {
		stringValue: (value: unknown) => typeof value === "string" ? value : undefined,
		usageFromValue: () => undefined,
		metadataProviderName: () => null,
		streamErrorFromChunk: () => null,
		normalizeReasoningDetails: (details: readonly unknown[]) => details.filter(
			(detail): detail is Record<string, unknown> => Boolean(detail && typeof detail === "object"),
		),
		repairInvalidUnicodeText: (text: string) => text,
		repairInvalidUnicodeValue: <T>(value: T) => ({ value }),
		isAbortError: (error: unknown) => Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError"),
		broadcastProviderDelta: (_runId, _seq, delta) => { deltas.push(delta); },
		throwIfStopped: (_runId: string, signal: AbortSignal) => {
			if (signal.aborted) {
				throw new Error("Unexpected abort.");
			}
		},
	} satisfies ProviderSseRuntime;
	return consumeProviderSseResponse("run-provider-sse", 1, streamFromTextChunks(frames), new AbortController().signal, runtime);
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
