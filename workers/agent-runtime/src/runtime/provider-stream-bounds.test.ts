import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeProviderResponse, providerFetchWithHeaderTimeout, readJsonResponseText, readSse, type ProviderSseRuntime } from '../provider/sse';
import { ProviderResponseBodyTimeoutError, ProviderResponseInterruptedError, ProviderStreamIdleTimeoutError, ProviderStreamIncompleteError, ResponseBodySizeLimitError, TickStoppedError } from '../errors';
import { StreamReasoningDetails } from '../provider/reasoning-stream';
import { agentLogFailure } from './agent-log-store';

afterEach(() => vi.unstubAllGlobals());

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
	it('keeps a body connection failure typed after a streamed delta', async () => {
		const error = new TypeError('Connection broke after a delta.');
		let sent = false;
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
			if (sent) controller.error(error);
			else { sent = true; controller.enqueue(new TextEncoder().encode(frame({ content: 'partial' }))); }
		} }, { highWaterMark: 0 }))));
		const signal = new AbortController().signal;
		const response = await providerFetchWithHeaderTimeout('https://provider.test', {}, signal, 1000);
		const broadcast = vi.fn();
		const failure = await consumeProviderResponse('run', 1, response.body!, signal, { ...runtime, broadcastProviderDelta: broadcast }).catch(error => error);
		expect(broadcast).toHaveBeenCalledWith('run', 1, { kind: 'content', text: 'partial' });
		expect(failure).toMatchObject({ kind: 'connection', cause: error });
		expect(agentLogFailure(failure)).toEqual({ kind: 'provider_error', status: null, errorType: 'connection', message: error.message });
	});
	it.each(['json timeout', 'stream timeout', 'json stop', 'stream stop'] as const)('preserves %s through the provider body wrapper', async mode => {
		const cancel = vi.fn();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
		const controller = new AbortController();
		const response = await providerFetchWithHeaderTimeout('https://provider.test', {}, controller.signal, 1000);
		const reading = mode.startsWith('json')
			? readJsonResponseText(response, 1000, controller.signal, 10, () => new ProviderResponseBodyTimeoutError(10))
			: readSse(response.body!, controller.signal, 10).next();
		const expected = mode.endsWith('stop') ? TickStoppedError : mode.startsWith('json') ? ProviderResponseBodyTimeoutError : ProviderStreamIdleTimeoutError;
		const assertion = expect(reading).rejects.toBeInstanceOf(expected);
		if (mode.endsWith('stop')) controller.abort();
		await assertion;
		expect(cancel).toHaveBeenCalledOnce();
	});
	it('does not repeatedly slice a growing event when the provider sends tiny chunks', async () => {
		const slice = String.prototype.slice;
		for (const length of [32_768, 65_536]) {
			const text = `data: ${'x'.repeat(length - 8)}\n\n`;
			const chunks = Array.from({ length: length / 16 }, (_, index) => text.slice(index * 16, (index + 1) * 16));
			let slicedCharacters = 0;
			const spy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (this: string, start, end) {
				if (this.startsWith('data:')) slicedCharacters += this.length;
				return slice.call(this, start, end);
			});
			try {
				expect(await readAll(stream(chunks).body, { maxBytes: length })).toEqual(['x'.repeat(length - 8)]);
				expect(slicedCharacters).toBeLessThanOrEqual(length * 2);
			} finally { spy.mockRestore(); }
		}
	});
	it('cancels an oversized incomplete frame', async () => {
		const input = stream(['data: ', 'a'.repeat(11)], false);
		await expect(readAll(input.body, { maxBytes: 100, maxEventBytes: 10 })).rejects.toBeInstanceOf(ResponseBodySizeLimitError);
		expect(input.cancel).toHaveBeenCalledOnce();
	});
	it('limits the whole response across many small frames', async () => {
		await expect(readAll(stream(Array(20).fill('data: x\n\n')).body, { maxBytes: 100 })).rejects.toBeInstanceOf(ResponseBodySizeLimitError);
	});
	it.each([['data: abc\n\n'], ['data: abc\n', '\n']])('enforces the same event bound across delimiter splits (%j)', async (...frames: string[]) => {
		await expect(readAll(stream(frames).body, { maxBytes: 100, maxEventBytes: 10 })).rejects.toBeInstanceOf(ResponseBodySizeLimitError);
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
