import { ResponseBodySizeLimitError } from '../errors';

/** Scan each byte once. Keep bounded blocks until a complete frame is ready. */
export class SseFrameBuffer {
	private readonly maxBytes: number;
	private readonly decoder = new TextDecoder();
	private blocks: Uint8Array[] = [];
	private block = new Uint8Array(256);
	private used = 0;
	private length = 0;
	private previous = -1;
	private beforePrevious = -1;

	constructor(maxBytes: number) { this.maxBytes = maxBytes; }

	*push(chunk: Uint8Array): Generator<string> {
		let start = 0;
		for (let index = 0; index < chunk.length; index++) {
			if (++this.length > this.maxBytes) throw new ResponseBodySizeLimitError(this.maxBytes);
			const byte = chunk[index]!;
			// A blank line ends with LF LF or LF CR LF. The first line's
			// optional CR remains in the frame, as does all other framing.
			const boundary = byte === 10 && (this.previous === 10 || (this.previous === 13 && this.beforePrevious === 10));
			this.beforePrevious = this.previous;
			this.previous = byte;
			if (boundary) {
				this.append(chunk.subarray(start, index + 1));
				yield this.take(false);
				start = index + 1;
			}
		}
		this.append(chunk.subarray(start));
	}

	finish(): string { return this.take(true); }

	private append(bytes: Uint8Array): void {
		let offset = 0;
		while (offset < bytes.length) {
			if (this.used === this.block.length) {
				this.blocks.push(this.block);
				this.block = new Uint8Array(Math.min(this.block.length * 2, 16_384));
				this.used = 0;
			}
			const count = Math.min(this.block.length - this.used, bytes.length - offset);
			this.block.set(bytes.subarray(offset, offset + count), this.used);
			this.used += count;
			offset += count;
		}
	}

	private take(final: boolean): string {
		const bytes = new Uint8Array(this.length);
		let offset = 0;
		for (const block of this.blocks) {
			bytes.set(block, offset);
			offset += block.length;
		}
		bytes.set(this.block.subarray(0, this.used), offset);
		const raw = this.decoder.decode(bytes, { stream: !final });
		this.blocks = [];
		this.block = new Uint8Array(256);
		this.used = this.length = 0;
		this.previous = this.beforePrevious = -1;
		return raw;
	}
}
