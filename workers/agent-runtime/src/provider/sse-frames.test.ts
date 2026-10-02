import { describe, expect, it, vi } from 'vitest';
import { SseFrameBuffer } from './sse-frames';
import { ResponseBodySizeLimitError } from '../errors';

describe('SSE frame buffering', () => {
	it.each([1, 2, 3, 16, 1000])('preserves mixed delimiters and Unicode with %i-byte chunks', (chunkSize) => {
		const expected = ['data: é\r\n\r\n', 'data: one\n\n', 'data: 😀\n\r\n', 'data: final'];
		const bytes = new TextEncoder().encode(expected.join(''));
		const frames = new SseFrameBuffer(bytes.length);
		const actual: string[] = [];
		for (let offset = 0; offset < bytes.length; offset += chunkSize) actual.push(...frames.push(bytes.subarray(offset, offset + chunkSize)));
		actual.push(frames.finish());
		expect(actual).toEqual(expected);
	});

	it('copies each fragmented frame byte at most twice as the frame grows', () => {
		const set = Uint8Array.prototype.set;
		const copies: number[] = [];
		for (const length of [32_768, 65_536]) {
			const bytes = new TextEncoder().encode(`data: ${'x'.repeat(length - 8)}\n\n`);
			let copied = 0;
			const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, source, offset) {
				copied += source.length;
				return set.call(this, source, offset);
			});
			try {
				const frames = new SseFrameBuffer(length);
				let emitted = '';
				for (let offset = 0; offset < bytes.length; offset += 16) {
					for (const frame of frames.push(bytes.subarray(offset, offset + 16))) emitted = frame;
				}
				expect(emitted).toHaveLength(length);
				expect(copied).toBeLessThanOrEqual(length * 2);
				copies.push(copied);
			} finally { spy.mockRestore(); }
		}
		expect(copies[1]).toBe(copies[0]! * 2);
	});

	it('counts framing against the event limit before emitting a frame', () => {
		const frames = new SseFrameBuffer(8);
		expect([...frames.push(new TextEncoder().encode('data: x\n'))]).toEqual([]);
		expect(() => [...frames.push(new TextEncoder().encode('\n'))]).toThrow(ResponseBodySizeLimitError);
	});
});
