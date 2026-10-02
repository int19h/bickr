import { describe, expect, it, vi } from 'vitest';
import { consumeProviderResponse, readSse, type ProviderSseRuntime } from '../provider/sse';
import { ProviderResponseInterruptedError, ProviderStreamIncompleteError, ResponseBodySizeLimitError } from '../errors';
import { StreamReasoningDetails } from '../provider/reasoning-stream';

function stream(frames: string[], close = true) {
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>({ start(controller) {
		for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
		if (close) controller.close();
	}, cancel });
	return { body, cancel };
}
const frame = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const runtime: ProviderSseRuntime = {
	stringValue: value => typeof value === 'string' ? value : undefined,
	usageFromValue: () => undefined, metadataProviderName: () => null, streamErrorFromChunk: () => null,
	normalizeReasoningDetails: details => details as Record<string, unknown>[], reasoningTextFromDetails: () => '',
	repairInvalidUnicodeText: value => value, repairInvalidUnicodeValue: value => ({ value }),
	isAbortError: () => false, throwIfStopped: () => {}, broadcastProviderDelta: () => {},
};
async function readAll(body: ReadableStream<Uint8Array>, options: { maxBytes: number; maxEventBytes?: number }) {
	const events = [];
	for await (const event of readSse(body, undefined, 1000, options)) events.push(event.data);
	return events;
}

describe('provider stream bounds and completion', () => {
	it('cancels an oversized incomplete frame', async () => {
		const input = stream(['data: ', 'a'.repeat(11)], false);
		await expect(readAll(input.body, { maxBytes: 100, maxEventBytes: 10 })).rejects.toBeInstanceOf(ResponseBodySizeLimitError);
		expect(input.cancel).toHaveBeenCalledOnce();
	});
	it('limits the whole response across many small frames', async () => {
		await expect(readAll(stream(Array(20).fill('data: x\n\n')).body, { maxBytes: 100 })).rejects.toBeInstanceOf(ResponseBodySizeLimitError);
	});
	it('accepts exact byte bounds and split Unicode with split CRLF framing', async () => {
		const text = 'data: é\r\n\r\n';
		const bytes = new TextEncoder().encode(text);
		const body = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
		expect(await readAll(body, { maxBytes: bytes.length })).toEqual(['é']);
	});
	it('preserves partial tools as interrupted output without accepting EOF', async () => {
		const input = stream([frame({ tool_calls: [{ index: 0, id: 'one', function: { name: 'write_note', arguments: '{"id":"memo","content":"text"}' } }] })]);
		try {
			await consumeProviderResponse('run', 1, input.body, new AbortController().signal, runtime);
			throw new Error('Incomplete response unexpectedly succeeded');
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderResponseInterruptedError);
			const interrupted = error as ProviderResponseInterruptedError;
			expect(interrupted.originalError).toBeInstanceOf(ProviderStreamIncompleteError);
			expect(interrupted.response.toolCalls).toHaveLength(1);
		}
	});
	it('cancels unread input after the completion marker', async () => {
		const input = stream([frame({ content: 'complete' }), 'data: [DONE]\n\n'], false);
		const result = await consumeProviderResponse('run', 1, input.body, new AbortController().signal, runtime);
		expect(result.content).toBe('complete');
		expect(input.cancel).toHaveBeenCalledOnce();
	});
	it('normalizes reasoning once after linear accumulation and retains opaque details', () => {
		const accumulator = new StreamReasoningDetails();
		for (let index = 0; index < 2000; index++) accumulator.append([{ type: 'reasoning.text', index: 0, text: '0123456789' }]);
		accumulator.append([{ type: 'reasoning.encrypted', data: 'signed' }]);
		accumulator.append([{ type: 'reasoning.text', index: 1, text: '\uD83D' }]);
		accumulator.append([{ type: 'reasoning.text', index: 1, text: '\uDE00' }]);
		let scanned = 0;
		const result = accumulator.finish(details => {
			scanned += details.reduce<number>((sum, detail) => sum + String((detail as Record<string, unknown>).text ?? '').length, 0);
			return details as Record<string, unknown>[];
		});
		expect(scanned).toBe(20_002);
		expect(result).toHaveLength(3);
		expect(result[1]).toEqual({ type: 'reasoning.encrypted', data: 'signed' });
		expect(result[2]?.text).toBe('😀');
	});
});
