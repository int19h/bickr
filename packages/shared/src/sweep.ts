export type BoundedSweepChunk<Item, Cursor> = {
	items: Item[];
	done: boolean;
	nextCursor?: Cursor;
};

export type BoundedSweepResult = {
	scanned: number;
	budgetExhausted: boolean;
};

export type BoundedSweepChunkOutcome<Cursor> =
	| { kind: "continue" }
	| { kind: "stop"; processedItems: number; cursor: Cursor };

export async function runBoundedSweep<Item, Cursor>(options: {
	chunkSize: number;
	maxItemsPerRun: number;
	initialCursor?: Cursor;
	loadChunk: (cursor: Cursor | undefined, limit: number) => Promise<BoundedSweepChunk<Item, Cursor>>;
	processChunk: (items: Item[]) => Promise<BoundedSweepChunkOutcome<Cursor>>;
	checkpoint: (cursor: Cursor) => Promise<void>;
	complete: () => Promise<void>;
}): Promise<BoundedSweepResult> {
	const chunkSize = positiveInteger(options.chunkSize, "chunkSize");
	const maxItemsPerRun = nonNegativeInteger(options.maxItemsPerRun, "maxItemsPerRun");
	let cursor = options.initialCursor;
	let scanned = 0;

	while (scanned < maxItemsPerRun) {
		const limit = Math.min(chunkSize, maxItemsPerRun - scanned);
		const chunk = await options.loadChunk(cursor, limit);
		if (chunk.items.length > limit) {
			throw new Error(`Sweep chunk exceeded its requested limit of ${limit}.`);
		}
		if (chunk.items.length === 0) {
			if (!chunk.done) {
				throw new Error("Sweep returned an empty chunk before completion.");
			}
			await options.complete();
			return { scanned, budgetExhausted: false };
		}

		const outcome = await options.processChunk(chunk.items);
		if (outcome.kind === "stop") {
			if (
				!Number.isInteger(outcome.processedItems) ||
				outcome.processedItems <= 0 ||
				outcome.processedItems > chunk.items.length
			) {
				throw new Error("Sweep early-stop count must cover part or all of the current chunk.");
			}
			scanned += outcome.processedItems;
			await options.checkpoint(outcome.cursor);
			return { scanned, budgetExhausted: true };
		}
		scanned += chunk.items.length;
		if (chunk.done) {
			await options.complete();
			return { scanned, budgetExhausted: false };
		}
		if (chunk.nextCursor === undefined) {
			throw new Error("Sweep chunk did not provide a continuation cursor.");
		}
		cursor = chunk.nextCursor;
		await options.checkpoint(cursor);
	}

	return {
		scanned,
		budgetExhausted: maxItemsPerRun > 0,
	};
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer.`);
	}
	return value;
}
