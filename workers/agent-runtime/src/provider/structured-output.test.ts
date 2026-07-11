import { describe, expect, it, vi } from 'vitest';
import { BotRuntime } from '../index';
import { providerCompactionSummaryProperty } from '../prompt-and-tools';

describe('Structured output', () => {
	it("recovers structured-output compaction JSON wrapped in a markdown fence", async () => {
		const originalFetch = globalThis.fetch;
		const summary = "I remember the important parts from a fenced response.";
		const validResponse = {
			choices: [{
				message: {
					content: `\`\`\`json\n${JSON.stringify({ [providerCompactionSummaryProperty]: summary }, null, 2)}\n\`\`\``,
				},
			}],
			usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
		};
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: vi.fn(),
				throwIfStopped: vi.fn(),
			});
			const callProviderForCompaction = (BotRuntime.prototype as unknown as {
				callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
			}).callProviderForCompaction.bind(runtime);

			const response = await callProviderForCompaction(
				{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
				[{ role: "user", content: "Compact the retained activity." }],
				"run-compaction-fenced-json",
				new AbortController().signal,
				{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
			);

			expect(response.content).toBe(summary);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("accepts valid structured-output compaction JSON containing escaped quotes", async () => {
		const originalFetch = globalThis.fetch;
		const summary = `I read "A Brief Word on "Economic Jihad" and Other Digital Delusions" and remembered it.`;
		const validResponse = {
			choices: [{
				message: {
					content: JSON.stringify({ [providerCompactionSummaryProperty]: summary }),
				},
			}],
			usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
		};
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: vi.fn(),
				throwIfStopped: vi.fn(),
			});
			const callProviderForCompaction = (BotRuntime.prototype as unknown as {
				callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
			}).callProviderForCompaction.bind(runtime);

			const response = await callProviderForCompaction(
				{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
				[{ role: "user", content: "Compact the retained activity." }],
				"run-compaction-valid-json-quotes",
				new AbortController().signal,
				{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
			);

			expect(response.content).toBe(summary);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("repairs structured-output compaction JSON with unescaped quotes in the summary string", async () => {
		const originalFetch = globalThis.fetch;
		const summary = `I read the thread titled 'A Brief Word on "Economic Jihad" and Other Digital Delusions' and remembered it.`;
		const invalidButRepairableResponse = {
			choices: [{
				message: {
					content: `{\n  "${providerCompactionSummaryProperty}": "${summary}"\n}`,
				},
			}],
			usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
		};
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(invalidButRepairableResponse));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: vi.fn(),
				throwIfStopped: vi.fn(),
			});
			const callProviderForCompaction = (BotRuntime.prototype as unknown as {
				callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
			}).callProviderForCompaction.bind(runtime);

			const response = await callProviderForCompaction(
				{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
				[{ role: "user", content: "Compact the retained activity." }],
				"run-compaction-loose-json-quotes",
				new AbortController().signal,
				{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
			);

			expect(response.content).toBe(summary);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("does not repair malformed structured-output compaction JSON by dropping extra fields", async () => {
		const originalFetch = globalThis.fetch;
		const validSummary = "I remember the important parts after retry.";
		const invalidMultiFieldResponse = {
			choices: [{
				message: {
					content: `{"${providerCompactionSummaryProperty}":"First value" "extra":"must not be dropped"}`,
				},
			}],
			usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
		};
		const validResponse = {
			choices: [{
				message: {
					content: JSON.stringify({ [providerCompactionSummaryProperty]: validSummary }),
				},
			}],
			usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
		};
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(Response.json(invalidMultiFieldResponse))
			.mockResolvedValueOnce(Response.json(validResponse));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: vi.fn(),
				throwIfStopped: vi.fn(),
			});
			const callProviderForCompaction = (BotRuntime.prototype as unknown as {
				callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
			}).callProviderForCompaction.bind(runtime);

			const response = await callProviderForCompaction(
				{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
				[{ role: "user", content: "Compact the retained activity." }],
				"run-compaction-loose-json-extra-field",
				new AbortController().signal,
				{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
			);

			expect(response.content).toBe(validSummary);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("recovers structured-output compaction JSON surrounded by ordinary text", async () => {
		const originalFetch = globalThis.fetch;
		const summary = "I remember the important parts from a text-wrapped response.";
		const validResponse = {
			choices: [{
				message: {
					content: `Here is the compacted memory:\n${JSON.stringify({ [providerCompactionSummaryProperty]: summary })}\nDone.`,
				},
			}],
			usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
		};
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(validResponse));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const runtime = Object.assign(Object.create(BotRuntime.prototype), {
				appendEvent: vi.fn(),
				throwIfStopped: vi.fn(),
			});
			const callProviderForCompaction = (BotRuntime.prototype as unknown as {
				callProviderForCompaction: (...args: unknown[]) => Promise<{ content: string }>;
			}).callProviderForCompaction.bind(runtime);

			const response = await callProviderForCompaction(
				{ baseUrl: "https://provider.example/api/v1", model: "test-model", temperature: 0.2 },
				[{ role: "user", content: "Compact the retained activity." }],
				"run-compaction-text-wrapped-json",
				new AbortController().signal,
				{ minLength: 1, maxLength: 4000, maxCompletionTokens: 1000 },
			);

			expect(response.content).toBe(summary);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});
});
