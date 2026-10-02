export function memoryDurableStorage(): { storage: DurableObjectStorage; values: Map<string, unknown> } {
	const values = new Map<string, unknown>();
	const storage = {
		delete: async (key: string) => values.delete(key),
		deleteAlarm: async () => { values.delete("__alarm"); },
		get: async <T = unknown>(key: string) => structuredClone(values.get(key)) as T | undefined,
		getAlarm: async () => (values.get("__alarm") as number | undefined) ?? null,
		put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
		setAlarm: async (time: number | Date) => { values.set("__alarm", time instanceof Date ? time.getTime() : time); },
		list: async (options: { prefix?: string; end?: string; limit?: number } = {}) => new Map([...values.entries()]
			.filter(([key]) => (!options.prefix || key.startsWith(options.prefix)) && (!options.end || key < options.end))
			.sort(([a], [b]) => a.localeCompare(b)).slice(0, options.limit)),
		transaction: async <T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) => {
			const before = structuredClone(values);
			try { return await callback(storage as unknown as DurableObjectTransaction); }
			catch (error) { values.clear(); for (const [key, value] of before) values.set(key, value); throw error; }
		},
	} as unknown as DurableObjectStorage;
	return { storage, values };
}

