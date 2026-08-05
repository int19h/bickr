import { useCallback, useEffect, useState } from "react";
import type { InferenceConfigurationSummary } from "@bickr/shared/inference-configuration-owner";
import { api, type ApiFailure } from "../api";

export type ConfigurationPageState<TExtra> = {
	error: ApiFailure | null;
	extra: TExtra | null;
	items: InferenceConfigurationSummary[];
	loading: boolean;
	loadingMore: boolean;
	nextCursor: string | null;
};

export type ConfigurationPageResult<TExtra> = ConfigurationPageState<TExtra> & {
	loadMore: () => void;
	reload: () => void;
};

type PagePayload = { items: InferenceConfigurationSummary[]; nextCursor?: string };

function emptyPageState<TExtra>(loading: boolean): ConfigurationPageState<TExtra> {
	return { error: null, extra: null, items: [], loading, loadingMore: false, nextCursor: null };
}

/**
 * Incremental cursor pagination over one bounded owner listing. The whole
 * library is never fetched to render a group: each section, picker, and child
 * list owns its own cursor and keeps the current search query.
 */
export function useConfigurationPage<TPayload extends PagePayload>(
	path: (cursor?: string) => string,
	select: (payload: unknown) => TPayload | null,
	deps: readonly unknown[],
	options: { enabled?: boolean } = {},
): ConfigurationPageResult<Omit<TPayload, "items" | "nextCursor">> {
	type Extra = Omit<TPayload, "items" | "nextCursor">;
	const enabled = options.enabled !== false;
	const [state, setState] = useState<ConfigurationPageState<Extra>>(() => emptyPageState<Extra>(enabled));
	const [reloadToken, setReloadToken] = useState(0);
	const [cursor, setCursor] = useState<string | null>(null);

	const reload = useCallback(() => {
		setCursor(null);
		setReloadToken((current) => current + 1);
	}, []);

	// A dependency change is a new query, so the accumulated page is dropped
	// rather than appended to a list built from a different search.
	useEffect(() => {
		setCursor(null);
		setState(emptyPageState<Extra>(enabled));
	}, [enabled, reloadToken, ...deps]);

	useEffect(() => {
		if (!enabled) {
			setState(emptyPageState<Extra>(false));
			return undefined;
		}
		let cancelled = false;
		setState((current) => (cursor ? { ...current, loadingMore: true } : { ...current, loading: true, error: null }));
		void api<unknown>(path(cursor ?? undefined)).then((result) => {
			if (cancelled) return;
			if (!result.ok) {
				setState((current) => ({ ...current, error: result, loading: false, loadingMore: false }));
				return;
			}
			const page = select(result.data);
			if (!page) {
				setState((current) => ({
					...current,
					error: { ok: false, error: "server_error", message: "The inference library response was malformed." },
					loading: false,
					loadingMore: false,
				}));
				return;
			}
			const { items, nextCursor, ...extra } = page;
			setState((current) => ({
				error: null,
				extra: extra as Extra,
				items: cursor ? [...current.items, ...items] : items,
				loading: false,
				loadingMore: false,
				nextCursor: nextCursor ?? null,
			}));
		});
		return () => {
			cancelled = true;
		};
	}, [cursor, enabled, reloadToken, ...deps]);

	return {
		...state,
		loadMore: () => setCursor(state.nextCursor),
		reload,
	};
}
