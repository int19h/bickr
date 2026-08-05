import { useCallback, useEffect, useState } from "react";
import type { InferenceConfigurationSummary } from "@bickr/shared/inference-configuration-owner";
import { api, type ApiFailure } from "../api";
import { FilterBox } from "../ui";
import type { InferenceReturnTarget } from "../routes";
import {
	inferenceGraphErrorCause,
	inferenceGraphUnavailable,
	inferenceTranslationPath,
	translationCandidatesPath,
	updateTranslationSelection,
	type TranslationSelectionResponse,
} from "./api";
import { ConfigurationCardBody } from "./links";
import { useConfigurationPage } from "./use-configuration-page";

/**
 * Chooses which ordinary configuration answers translation requests. The
 * candidate list is the server's, which admits only Account default and custom
 * entries; world and participant configurations are never offered here, and
 * this control owns no translation-only inference fields.
 */
export function TranslationConfigurationSelector({
	onSelectionSaved,
	returnTo,
}: {
	onSelectionSaved: () => void;
	returnTo?: InferenceReturnTarget;
}) {
	const [current, setCurrent] = useState<TranslationSelectionResponse | null>(null);
	const [loadError, setLoadError] = useState<ApiFailure | null>(null);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");

	const load = useCallback(async () => {
		const result = await api<TranslationSelectionResponse>(inferenceTranslationPath);
		if (result.ok) {
			setCurrent(result.data);
			setLoadError(null);
		} else {
			setLoadError(result);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const candidates = useConfigurationPage<{ items: InferenceConfigurationSummary[]; nextCursor?: string }>(
		(cursor) => translationCandidatesPath({ ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) }),
		(payload) => {
			const page = (payload as { candidates?: { items: InferenceConfigurationSummary[]; nextCursor?: string } }).candidates;
			return page && Array.isArray(page.items) ? page : null;
		},
		[query],
		{ enabled: !loadError },
	);

	async function select(configurationId: string): Promise<void> {
		if (!current) return;
		setBusy(true);
		setError("");
		setMessage("");
		const result = await updateTranslationSelection({
			configurationId,
			expectedRevision: current.selection.revision,
		});
		setBusy(false);
		if (!result.ok) {
			if (inferenceGraphErrorCause(result) === "stale_revision") {
				await load();
				setError("The translation selection changed elsewhere. The current selection has been reloaded.");
				return;
			}
			setError(result.message);
			return;
		}
		setCurrent(result.data);
		setMessage("Translation configuration saved.");
		onSelectionSaved();
	}

	if (loadError) {
		return (
			<div className="runtime-message error">
				{inferenceGraphUnavailable(loadError)
					? "This account has not been moved onto inference configurations yet, so the translation configuration cannot be chosen here."
					: loadError.message}
			</div>
		);
	}

	return (
		<div className="field-stack inference-translation-selector">
			<p className="help">
				Translation uses this configuration's fully resolved provider, model, routing, reasoning, tool-call, and
				sampling values. Only Account default and your custom configurations can be selected; create a custom
				configuration if translation needs different inference.
			</p>
			{current ? (
				<ConfigurationCardBody configuration={current.configuration} returnTo={returnTo} />
			) : (
				<div className="runtime-message">Loading the selected configuration...</div>
			)}
			<FilterBox
				label="Search translation configurations"
				onChange={setQuery}
				placeholder="Search Account default and custom configurations"
				value={query}
			/>
			{candidates.loading ? (
				<div className="runtime-message">Loading candidates...</div>
			) : candidates.error ? (
				<div className="runtime-message error">{candidates.error.message}</div>
			) : candidates.items.length === 0 ? (
				<div className="runtime-message">No configuration matches this search.</div>
			) : (
				<ul className="inference-parent-options">
					{candidates.items.map((candidate) => (
						<li key={candidate.id}>
							<button
								aria-pressed={candidate.id === current?.selection.configurationId}
								className={`btn compact ${candidate.id === current?.selection.configurationId ? "primary" : "ghost"}`}
								disabled={busy}
								onClick={() => void select(candidate.id)}
								type="button"
							>
								{candidate.displayName}
								{candidate.id === current?.selection.configurationId ? " (selected)" : ""}
							</button>
						</li>
					))}
				</ul>
			)}
			{candidates.nextCursor && (
				<button className="btn ghost compact" disabled={candidates.loadingMore} onClick={candidates.loadMore} type="button">
					{candidates.loadingMore ? "Loading..." : "Load more"}
				</button>
			)}
			{error && <div className="runtime-message error">{error}</div>}
			{message && <div className="runtime-message">{message}</div>}
		</div>
	);
}
