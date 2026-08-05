import { useEffect, useState } from "react";
import { maximumInferenceBotEffectiveModelBatch } from "@bickr/shared/inference-configuration-owner";
import type { ApiFailure } from "../api";
import { loadBotEffectiveModels } from "./api";

export type BotEffectiveModels = {
	/** Resolved model per participant; a participant is absent until answered. */
	modelByBotId: Record<string, string>;
	loading: boolean;
	error: ApiFailure | null;
};

/** Set-oriented request bound, so a large table asks in whole batches. */
export function botEffectiveModelBatches(botIds: readonly string[]): string[][] {
	const batches: string[][] = [];
	for (let start = 0; start < botIds.length; start += maximumInferenceBotEffectiveModelBatch) {
		batches.push([...botIds.slice(start, start + maximumInferenceBotEffectiveModelBatch)]);
	}
	return batches;
}

/**
 * Canonical model labels for the participants a screen renders.
 *
 * Owner surfaces show what the runtime would actually resolve, which only the
 * server can compute; a participant's stored legacy settings stop being that
 * answer as soon as its configuration, an ancestor, or Account default is
 * edited. The request set is the participants already on screen, batched to the
 * server's bound, so the whole table costs a fixed number of requests.
 */
export function useBotEffectiveModels(botIds: readonly string[]): BotEffectiveModels {
	const key = [...new Set(botIds)].sort().join(",");
	const [state, setState] = useState<BotEffectiveModels>({ modelByBotId: {}, loading: false, error: null });

	useEffect(() => {
		const ids = key ? key.split(",") : [];
		if (ids.length === 0) {
			setState({ modelByBotId: {}, loading: false, error: null });
			return undefined;
		}
		let cancelled = false;
		setState((current) => ({ ...current, loading: true }));
		void (async () => {
			const results = await Promise.all(botEffectiveModelBatches(ids).map((batch) => loadBotEffectiveModels(batch)));
			if (cancelled) return;
			const modelByBotId: Record<string, string> = {};
			let error: ApiFailure | null = null;
			for (const result of results) {
				if (!result.ok) {
					error ??= result;
					continue;
				}
				for (const entry of result.data.models) {
					modelByBotId[entry.botId] = entry.effectiveModel;
				}
			}
			setState({ modelByBotId, loading: false, error });
		})();
		return () => {
			cancelled = true;
		};
	}, [key]);

	return state;
}
