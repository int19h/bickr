import {
	providerBodyReadTimeoutMs,
	providerFailureRawResponseMaxCharacters,
	providerStreamIdleTimeoutMs,
} from '../constants';
import {
	ProviderEmptyResponseError,
	ProviderRequestTimeoutError,
	ProviderResponseBodyTimeoutError,
	ProviderResponseInterruptedError,
	ProviderStreamIdleTimeoutError,
	ResponseBodySizeLimitError,
	RuntimeOperationTimeoutError,
	TickStoppedError,
} from '../errors';
import type { ProviderResponse, ProviderUsage, ReasoningDetail, ToolCall } from '../types';

type ReadTextOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
	timeoutError?: () => Error;
};

type ReadTextResult = {
	text: string;
	truncated: boolean;
};

type SseEvent = { data: string; raw: string };

type ProviderSseChunk = {
	id?: unknown;
	model?: unknown;
	usage?: unknown;
	error?: unknown;
	openrouter_metadata?: unknown;
	choices?: Array<{
		delta?: {
			content?: string;
			reasoning?: string;
			reasoning_content?: string;
			reasoning_details?: ReasoningDetail[];
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: 'function';
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
};

export type ProviderSseRuntime = {
	stringValue(value: unknown): string | undefined;
	usageFromValue(value: unknown): ProviderUsage | undefined;
	metadataProviderName(value: unknown): string | null;
	streamErrorFromChunk(chunk: ProviderSseChunk): Error | null;
	normalizeReasoningDetails(details: readonly unknown[]): ReasoningDetail[];
	reasoningTextFromDetails(details: ReasoningDetail[]): string;
	repairInvalidUnicodeText(text: string): string;
	repairInvalidUnicodeValue<T>(value: T): { value: T };
	isAbortError(error: unknown): boolean;
	throwIfStopped(runId: string, signal: AbortSignal): void;
	broadcastProviderDelta(runId: string, streamSeq: number, payload: Record<string, unknown>): void;
};

export async function readProviderErrorBody(response: Response, signal: AbortSignal): Promise<string> {
	try {
		return await readLimitedText(response.body, 1_200, {
			signal,
			timeoutMs: providerBodyReadTimeoutMs,
			timeoutError: () => new ProviderResponseBodyTimeoutError(providerBodyReadTimeoutMs),
		});
	} catch (error) {
		if (error instanceof TickStoppedError || isAbortError(error)) {
			throw error;
		}
		if (error instanceof ProviderResponseBodyTimeoutError) {
			return 'Timed out while reading provider error response.';
		}
		return 'Could not read provider error response.';
	}
}

export async function readJsonResponse(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
	timeoutMs: number,
	timeoutError: () => Error,
): Promise<unknown> {
	return JSON.parse(await readJsonResponseText(response, maxBytes, signal, timeoutMs, timeoutError));
}

export async function readJsonResponseText(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
	timeoutMs: number,
	timeoutError: () => Error,
): Promise<string> {
	const result = await readTextFromStream(response.body, maxBytes, {
		signal,
		timeoutMs,
		timeoutError,
	});
	if (result.truncated) {
		throw new ResponseBodySizeLimitError(maxBytes);
	}
	return result.text;
}

export async function readLimitedText(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	options: ReadTextOptions = {},
): Promise<string> {
	const result = await readTextFromStream(stream, maxBytes, options);
	const trimmed = result.text.trim();
	return result.truncated ? `${trimmed}...` : trimmed;
}

export async function readTextFromStream(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	options: ReadTextOptions = {},
): Promise<ReadTextResult> {
	if (!stream) {
		return { text: '', truncated: false };
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let bytesRead = 0;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const cancelReader = (reason: string) => {
		void reader.cancel(reason).catch(() => {
			// The stream may already have completed or been canceled by the peer.
		});
	};
	const timeoutMs = options.timeoutMs;
	const timeoutPromise =
		timeoutMs === undefined
			? undefined
			: new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						const error = options.timeoutError ? options.timeoutError() : new RuntimeOperationTimeoutError('Response body read', timeoutMs);
						cancelReader(error.message);
						reject(error);
					}, timeoutMs);
				});
	let abortPromise: Promise<never> | undefined;
	if (options.signal) {
		if (options.signal.aborted) {
			cancelReader('This Bickr visit was stopped.');
			throw new TickStoppedError();
		}
		abortPromise = new Promise<never>((_, reject) => {
			abortListener = () => {
				cancelReader('This Bickr visit was stopped.');
				reject(new TickStoppedError());
			};
			options.signal?.addEventListener('abort', abortListener, { once: true });
		});
	}
	const read = () => Promise.race([reader.read(), ...(timeoutPromise ? [timeoutPromise] : []), ...(abortPromise ? [abortPromise] : [])]);
	try {
		while (true) {
			if (bytesRead >= maxBytes) {
				const { done } = await read();
				if (done) {
					text += decoder.decode();
					return { text, truncated: false };
				}
				cancelReader('Response body byte limit reached.');
				return { text, truncated: true };
			}
			const { done, value } = await read();
			if (done) {
				text += decoder.decode();
				return { text, truncated: false };
			}
			const remaining = maxBytes - bytesRead;
			const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
			bytesRead += chunk.byteLength;
			const truncated = value.byteLength > remaining;
			text += decoder.decode(chunk, { stream: !truncated });
			if (value.byteLength > remaining) {
				cancelReader('Response body byte limit reached.');
				return { text, truncated: true };
			}
		}
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (options.signal && abortListener) {
			options.signal.removeEventListener('abort', abortListener);
		}
		try {
			reader.releaseLock();
		} catch {
			// A canceled read can still be settling after the caller has moved on.
		}
	}
}

export function isAbortError(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError');
}

const sseEventBoundaryPattern = /\r?\n\r?\n/;

function sseEventData(raw: string): string {
	return raw
		.split(/\r?\n/)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())
		.join('\n');
}

export async function* readSse(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	idleTimeoutMs = providerStreamIdleTimeoutMs,
): AsyncGenerator<SseEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	function* drainCompleteEvents(): Generator<SseEvent> {
		let boundary = buffer.match(sseEventBoundaryPattern);
		while (boundary?.index !== undefined) {
			const raw = buffer.slice(0, boundary.index);
			const boundaryText = boundary[0];
			buffer = buffer.slice(boundary.index + boundaryText.length);
			const data = sseEventData(raw);
			if (data) {
				yield { data, raw: `${raw}${boundaryText}` };
			}
			boundary = buffer.match(sseEventBoundaryPattern);
		}
	}
	function residualEvent(): SseEvent | null {
		if (!buffer) {
			return null;
		}
		const raw = buffer;
		buffer = '';
		const data = sseEventData(raw);
		return data ? { data, raw } : null;
	}
	try {
		while (true) {
			if (signal?.aborted) {
				throw new TickStoppedError();
			}
			const { done, value } = await readStreamChunk(reader, idleTimeoutMs, () => new ProviderStreamIdleTimeoutError(idleTimeoutMs), signal);
			if (signal?.aborted) {
				throw new TickStoppedError();
			}
			if (done) {
				buffer += decoder.decode();
				yield* drainCompleteEvents();
				const event = residualEvent();
				if (event) {
					yield event;
				}
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			yield* drainCompleteEvents();
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// A timed-out read can still be settling after we have rejected the provider stream.
		}
	}
}

async function readStreamChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	idleTimeoutMs: number,
	timeoutError: () => Error = () => new ProviderStreamIdleTimeoutError(idleTimeoutMs),
	signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal?.aborted) {
		void reader.cancel('This Bickr visit was stopped.').catch(() => {
			// The stream may already be closed or aborted by the provider.
		});
		throw new TickStoppedError();
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const cancelReader = (reason: string) => {
		void reader.cancel(reason).catch(() => {
			// The stream may already be closed or aborted by the provider.
		});
	};
	const abortPromise = signal
		? new Promise<never>((_, reject) => {
				abortListener = () => {
					cancelReader('This Bickr visit was stopped.');
					reject(new TickStoppedError());
				};
				signal.addEventListener('abort', abortListener, { once: true });
			})
		: undefined;
	try {
		return await Promise.race([
			reader.read(),
			...(abortPromise ? [abortPromise] : []),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					const error = timeoutError();
					cancelReader(error.message);
					reject(error);
				}, idleTimeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (signal && abortListener) {
			signal.removeEventListener('abort', abortListener);
		}
	}
}

export async function providerFetchWithHeaderTimeout(
	endpoint: string,
	init: RequestInit,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<Response> {
	return withAbortableTimeout(
		signal,
		timeoutMs,
		() => new ProviderRequestTimeoutError(timeoutMs),
		(timeoutSignal) => fetch(endpoint, { ...init, signal: timeoutSignal }),
	);
}

export async function withStandaloneTimeout<T>(operation: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
	const parent = new AbortController();
	return withAbortableTimeout(
		parent.signal,
		timeoutMs,
		() => new RuntimeOperationTimeoutError(operation, timeoutMs),
		() => run(),
	);
}

export async function withAbortableTimeout<T>(
	signal: AbortSignal,
	timeoutMs: number,
	timeoutError: () => Error,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (signal.aborted) {
		throw new TickStoppedError();
	}
	const controller = new AbortController();
	let timedOut = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortFromParent: (() => void) | undefined;
	const abortPromise = new Promise<never>((_, reject) => {
		abortFromParent = () => {
			controller.abort();
			reject(new TickStoppedError());
		};
		signal.addEventListener('abort', abortFromParent, { once: true });
	});
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			reject(timeoutError());
		}, timeoutMs);
	});
	try {
		return await Promise.race([run(controller.signal), abortPromise, timeoutPromise]);
	} catch (error) {
		if (timedOut) {
			throw timeoutError();
		}
		if (signal.aborted) {
			throw new TickStoppedError();
		}
		throw error;
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (abortFromParent) {
			signal.removeEventListener('abort', abortFromParent);
		}
	}
}

export function providerResponseIsEmpty(response: Pick<ProviderResponse, 'content' | 'reasoning' | 'reasoningDetails' | 'toolCalls'>): boolean {
	return providerResponsePartsAreEmpty(response.content, response.reasoning, response.reasoningDetails, response.toolCalls);
}

function providerResponsePartsAreEmpty(
	content: unknown,
	reasoning: unknown,
	reasoningDetails: readonly unknown[],
	toolCalls: readonly unknown[],
): boolean {
	return !hasProviderHistoryText(content) && !hasProviderHistoryText(reasoning) && reasoningDetails.length === 0 && toolCalls.length === 0;
}

export function hasProviderHistoryText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function appendRawResponsePreview(current: string, next: string): string {
	if (current.length >= providerFailureRawResponseMaxCharacters) {
		return current;
	}
	return `${current}${next}`.slice(0, providerFailureRawResponseMaxCharacters);
}

export async function consumeProviderResponse(
	runId: string,
	streamSeq: number,
	stream: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	runtime: ProviderSseRuntime,
	generationResponseId?: string,
): Promise<ProviderResponse> {
	let content = '';
	let reasoning = '';
	const reasoningDetails: ReasoningDetail[] = [];
	const toolCalls = new Map<number, ToolCall>();
	let usage: ProviderUsage | undefined;
	let responseId: string | undefined = generationResponseId;
	let responseModel: string | undefined;
	let responseProviderName: string | undefined;
	let rawResponse = '';
	let skippedRawResponse = '';
	try {
		for await (const event of readSse(stream, signal)) {
			runtime.throwIfStopped(runId, signal);
			const rawPreviewCaptured = providerResponsePartsAreEmpty(content, reasoning, reasoningDetails, [...toolCalls.values()]);
			if (rawPreviewCaptured) {
				rawResponse = appendRawResponsePreview(rawResponse, event.raw);
			}
			if (event.data === '[DONE]') {
				break;
			}
			let chunk: ProviderSseChunk;
			try {
				chunk = JSON.parse(event.data) as typeof chunk;
			} catch {
				if (!rawPreviewCaptured) {
					rawResponse = appendRawResponsePreview(rawResponse, event.raw);
				}
				skippedRawResponse = appendRawResponsePreview(skippedRawResponse, event.raw);
				continue;
			}
			responseId = responseId ?? runtime.stringValue(chunk.id);
			responseModel = runtime.stringValue(chunk.model) ?? responseModel;
			usage = runtime.usageFromValue(chunk.usage) ?? usage;
			responseProviderName = runtime.metadataProviderName(chunk.openrouter_metadata) ?? responseProviderName;
			const providerError = runtime.streamErrorFromChunk(chunk);
			if (providerError) {
				throw providerError;
			}
			const delta = chunk.choices?.[0]?.delta;
			if (!delta) {
				continue;
			}
			if (delta.content) {
				content += delta.content;
				runtime.broadcastProviderDelta(runId, streamSeq, { kind: 'content', text: delta.content });
			}
			const plainReasoning = delta.reasoning ?? delta.reasoning_content;
			let detailsReasoning = '';
			if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
				const mergedReasoningDetails = runtime.normalizeReasoningDetails([...reasoningDetails, ...delta.reasoning_details]);
				reasoningDetails.length = 0;
				reasoningDetails.push(...mergedReasoningDetails);
				detailsReasoning = runtime.reasoningTextFromDetails(delta.reasoning_details);
			}
			const deltaReasoning = plainReasoning || detailsReasoning;
			if (deltaReasoning) {
				reasoning += deltaReasoning;
				runtime.broadcastProviderDelta(runId, streamSeq, { kind: 'reasoning', text: deltaReasoning });
			}
			for (const part of delta.tool_calls ?? []) {
				const current =
					toolCalls.get(part.index) ??
					({
						id: part.id ?? `tool-${part.index}`,
						type: 'function',
						function: { name: '', arguments: '' },
					} satisfies ToolCall);
				if (part.id) {
					current.id = part.id;
				}
				if (part.function?.name) {
					current.function.name += part.function.name;
				}
				if (part.function?.arguments) {
					current.function.arguments += part.function.arguments;
				}
				toolCalls.set(part.index, current);
				runtime.broadcastProviderDelta(runId, streamSeq, { kind: 'tool_call', part });
			}
		}
	} catch (error) {
		if (error instanceof ProviderStreamIdleTimeoutError) {
			throw error;
		}
		if (error instanceof TickStoppedError || runtime.isAbortError(error)) {
			throw new ProviderResponseInterruptedError(
				{
					content,
					reasoning,
					reasoningDetails,
					toolCalls: [...toolCalls.values()].filter((tool) => tool.function.name),
					...(rawResponse ? { rawResponse } : {}),
					...(skippedRawResponse ? { skippedRawResponse } : {}),
					...(usage ? { usage } : {}),
					...(responseId ? { responseId } : {}),
					...(responseModel ? { responseModel } : {}),
					...(responseProviderName ? { responseProviderName } : {}),
				},
				error,
			);
		}
		throw error;
	}
	const response = {
		content: runtime.repairInvalidUnicodeText(content),
		reasoning: runtime.repairInvalidUnicodeText(reasoning),
		reasoningDetails: runtime.repairInvalidUnicodeValue(reasoningDetails).value,
		toolCalls: [...toolCalls.values()].filter((tool) => tool.function.name),
		...(rawResponse ? { rawResponse } : {}),
		...(skippedRawResponse ? { skippedRawResponse } : {}),
		...(usage ? { usage } : {}),
		...(responseId ? { responseId } : {}),
		...(responseModel ? { responseModel } : {}),
		...(responseProviderName ? { responseProviderName } : {}),
	};
	if (providerResponseIsEmpty(response)) {
		throw new ProviderEmptyResponseError(response.rawResponse, {
			...(responseId ? { responseId } : {}),
			...(responseModel ? { responseModel } : {}),
			...(usage ? { usage } : {}),
		});
	}
	return response;
}
