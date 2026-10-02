// Retention: at most 256 entries and 1 MiB of serialized UTF-16 storage per browser.
// Old hash-keyed caches cannot prove source identity, so version 2 discards them.
export const translationCacheLimits = { entries: 256, bytes: 1024 * 1024 } as const;
export const translationStorageKey = "bickr.translation.v2";
type Entry = Readonly<{ translation: string; show: boolean }>;
type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Exact tuples avoid both hash collisions and separator ambiguities. */
export function translationCacheKey(text: string, identity: string, prompt: string): string {
	return JSON.stringify([identity, prompt, text]);
}

export class TranslationCache {
	private entries = new Map<string, Entry>();
	private sizes = new Map<string, number>();
	private bytes = 0;
	private loaded = false;
	private discardedLegacy = false;
	private readonly storage: () => StorageAccess | null;
	constructor(storage: () => StorageAccess | null) { this.storage = storage; }

	invalidate(): void { this.loaded = false; }

	read(key: string): Entry | null {
		this.load();
		return this.entries.get(key) ?? null;
	}

	write(key: string, translation: string, show = true): void {
		this.load();
		const entry = { translation, show };
		const size = JSON.stringify([key, entry]).length * 2 + 2;
		if (!translation || size > translationCacheLimits.bytes - 4) return;
		this.remove(key);
		this.entries.set(key, entry);
		this.sizes.set(key, size);
		this.bytes += size;
		while (this.entries.size > translationCacheLimits.entries || this.bytes > translationCacheLimits.bytes - 4) {
			this.remove(this.entries.keys().next().value!);
		}
		try { this.storage()?.setItem(translationStorageKey, JSON.stringify([...this.entries])); } catch { /* Keep the bounded memory cache when storage is unavailable. */ }
	}

	setVisible(key: string, show: boolean): void {
		const entry = this.read(key);
		if (entry) this.write(key, entry.translation, show);
	}

	private remove(key: string): void {
		this.bytes -= this.sizes.get(key) ?? 0;
		this.entries.delete(key);
		this.sizes.delete(key);
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.entries.clear(); this.sizes.clear(); this.bytes = 0;
		try {
			const storage = this.storage();
			if (!this.discardedLegacy) {
				storage?.removeItem("bickr.translation.cache.v1");
				storage?.removeItem("bickr.translation.view.v1");
				this.discardedLegacy = true;
			}
			const raw = storage?.getItem(translationStorageKey);
			if (!raw || raw.length * 2 > translationCacheLimits.bytes) return;
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed) || parsed.length > translationCacheLimits.entries) return;
			for (const item of parsed) {
				if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") continue;
				const [key, entry] = item;
				if (!entry || typeof entry !== "object" || typeof entry.translation !== "string" || !entry.translation || typeof entry.show !== "boolean") continue;
				const size = JSON.stringify(item).length * 2 + 2;
				this.remove(key);
				this.entries.set(key, { translation: entry.translation, show: entry.show });
				this.sizes.set(key, size); this.bytes += size;
			}
		} catch { /* Invalid or inaccessible browser storage is an empty cache. */ }
	}
}

export const translationCache = new TranslationCache(() => typeof window === "undefined" ? null : window.localStorage);
if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key === translationStorageKey || event.key === null) translationCache.invalidate();
	});
}
