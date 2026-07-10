import { useCallback, useEffect, useState, type DependencyList } from "react";

import { api, type ApiResult, type ApiSuccess } from "./api";

type ApiQueryState<T> = {
	data: T | null;
	error: string;
	loading: boolean;
};

export function useApiQuery<T>(
	path: string | null,
	deps: DependencyList,
): ApiQueryState<T> & { reload: () => void } {
	const [reloadVersion, setReloadVersion] = useState(0);
	const [state, setState] = useState<ApiQueryState<T>>({
		data: null,
		error: "",
		loading: Boolean(path),
	});
	const reload = useCallback(() => {
		setReloadVersion((current) => current + 1);
	}, []);

	useEffect(() => {
		if (!path) {
			setState({ data: null, error: "", loading: false });
			return undefined;
		}
		let cancelled = false;
		setState((current) => ({ ...current, error: "", loading: true }));
		void api<T>(path).then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setState({ data: result.data, error: "", loading: false });
				return;
			}
			setState((current) => ({ ...current, error: result.message, loading: false }));
		});
		return () => {
			cancelled = true;
		};
	}, [path, reloadVersion, ...deps]);

	return { ...state, reload };
}

export async function runApiAction<T>(
	setError: (message: string) => never,
	fn: () => Promise<ApiResult<T>>,
): Promise<ApiSuccess<T>>;
export async function runApiAction<T>(
	setError: (message: string) => void,
	fn: () => Promise<ApiResult<T>>,
): Promise<ApiSuccess<T> | null>;
export async function runApiAction<T>(
	setError: (message: string) => void,
	fn: () => Promise<ApiResult<T>>,
): Promise<ApiSuccess<T> | null> {
	const result = await fn();
	if (result.ok) {
		return result;
	}
	setError(result.message);
	return null;
}
