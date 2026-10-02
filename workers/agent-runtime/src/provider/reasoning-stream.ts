import type { ReasoningDetail } from '../types';

type Detail = { value: ReasoningDetail; textChunks?: string[] };

/** Retains provider detail order and opaque signatures without rescanning history.
 * Text chunks are joined and Unicode-normalized only when the response settles. */
export class StreamReasoningDetails {
	private readonly details: Detail[] = [];

	get empty(): boolean { return this.details.length === 0; }

	append(incoming: readonly ReasoningDetail[]): void {
		for (const value of incoming) {
			const last = this.details[this.details.length - 1];
			if (last?.textChunks && value.type === 'reasoning.text' && typeof value.text === 'string'
				&& value.index === last.value.index && value.format === last.value.format) {
				last.textChunks.push(value.text);
			} else {
				this.details.push({
					value: { ...value },
					...(value.type === 'reasoning.text' && typeof value.text === 'string' ? { textChunks: [value.text] } : {}),
				});
			}
		}
	}

	finish(normalize: (details: readonly unknown[]) => ReasoningDetail[]): ReasoningDetail[] {
		return normalize(this.details.map(({ value, textChunks }) => textChunks ? { ...value, text: textChunks.join('') } : value));
	}
}
