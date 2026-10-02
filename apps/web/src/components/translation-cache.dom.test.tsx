import { expect, it, vi } from "vitest";
import { TranslationCache, translationCacheKey, translationCacheLimits, translationStorageKey } from "./translation-cache";

function cache() {
	const entries = new Map<string, string>();
	const storage = { getItem: vi.fn((key: string) => entries.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }), removeItem: vi.fn((key: string) => { entries.delete(key); }) };
	return { cache: new TranslationCache(() => storage), storage, entries };
}
it("uses exact text, prompt, and configuration identities", () => {
	const { cache: value } = cache();
	const key = translationCacheKey("You owe Aa.", "config", "Translate");
	value.write(key, "Translation of Aa");
	expect(value.read(translationCacheKey("You owe BB.", "config", "Translate"))).toBeNull();
	expect(value.read(translationCacheKey("You owe Aa.", "other", "Translate"))).toBeNull();
	expect(translationCacheKey("c", "a\nb", "")).not.toBe(translationCacheKey("c", "a", "b\n"));
	expect(value.read(key)?.translation).toBe("Translation of Aa");
});
it("hydrates once and performs many lookups without reading the whole store", () => {
	const { cache: value, storage } = cache();
	value.write("key", "translation");
	const reads = storage.getItem.mock.calls.length;
	for (let i = 0; i < 10000; i++) expect(value.read("key")?.translation).toBe("translation");
	expect(storage.getItem).toHaveBeenCalledTimes(reads);
	value.invalidate(); expect(value.read("key")?.translation).toBe("translation");
	expect(storage.getItem).toHaveBeenCalledTimes(reads + 1);
});
it("evicts oldest entries and enforces serialized byte bounds", () => {
	const { cache: value, entries } = cache();
	for (let i = 0; i < 300; i++) value.write(`key-${i}`, "text");
	expect(value.read("key-0")).toBeNull(); expect(value.read("key-299")?.translation).toBe("text");
	expect(JSON.parse(entries.get(translationStorageKey)!).length).toBe(translationCacheLimits.entries);
	for (let i = 0; i < 100; i++) value.write(`large-${i}`, "a".repeat(10000));
	expect(entries.get(translationStorageKey)!.length * 2).toBeLessThanOrEqual(translationCacheLimits.bytes);
	expect(value.read("key-299")).toBeNull();
	value.write("too-large", "a".repeat(translationCacheLimits.bytes));
	expect(value.read("too-large")).toBeNull();
});
it("preserves visibility through persistence and survives blocked storage", () => {
	const { cache: value } = cache(); value.write("key", "translation"); value.setVisible("key", false); value.invalidate();
	expect(value.read("key")).toEqual({ translation: "translation", show: false });
	const blocked = new TranslationCache(() => { throw new Error("Storage blocked"); });
	blocked.write("key", "text"); expect(blocked.read("key")?.translation).toBe("text");
});
