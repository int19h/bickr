import { useCallback, useEffect, useState } from "react";
import type {
	FixedInferenceConfigurationReference,
	RedactedInferenceConfigurationDto,
} from "@bickr/shared/inference-configuration-owner";
import type { ApiFailure } from "../api";
import type { InferenceReturnTarget } from "../routes";
import { fixedConfigurationPath, inferenceGraphUnavailable } from "./api";
import { api } from "../api";
import { ConfigurationLink, KindBadge } from "./summary";
import { credentialResolutionText } from "./fields";

export type FixedConfigurationState = {
	configuration: RedactedInferenceConfigurationDto | null;
	error: ApiFailure | null;
	loading: boolean;
	reload: () => void;
};

/**
 * Loads the fixed configuration that belongs to one account, world, or
 * participant. The address is derived from the entity id through the shared
 * owner module, so a settings screen never has to search the library or join
 * unrelated APIs to find its own entry.
 */
export function useFixedConfiguration(reference: FixedInferenceConfigurationReference | null): FixedConfigurationState {
	const [state, setState] = useState<Omit<FixedConfigurationState, "reload">>({
		configuration: null,
		error: null,
		loading: Boolean(reference),
	});
	const [token, setToken] = useState(0);
	const reload = useCallback(() => setToken((current) => current + 1), []);
	const key = reference ? `${reference.kind}:${referenceEntityId(reference)}` : "";

	useEffect(() => {
		if (!reference) {
			setState({ configuration: null, error: null, loading: false });
			return undefined;
		}
		let cancelled = false;
		setState((current) => ({ ...current, error: null, loading: true }));
		void (async () => {
			const path = await fixedConfigurationPath(reference);
			const result = await api<{ configuration: RedactedInferenceConfigurationDto }>(path);
			if (cancelled) return;
			setState(
				result.ok
					? { configuration: result.data.configuration, error: null, loading: false }
					: { configuration: null, error: result, loading: false },
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [key, token]);

	return { ...state, reload };
}

function referenceEntityId(reference: FixedInferenceConfigurationReference): string {
	switch (reference.kind) {
		case "account_default": return reference.ownerUserId;
		case "world": return reference.worldId;
		case "bot": return reference.botId;
	}
}

export function ConfigurationLinkCard({
	description,
	returnTo,
	state,
	title,
}: {
	description: string;
	returnTo?: InferenceReturnTarget;
	state: FixedConfigurationState;
	title: string;
}) {
	return (
		<section className="section inference-link-card">
			<div className="section-head">
				<h2>{title}</h2>
				<span className="meta">reusable inference</span>
			</div>
			<p className="help">{description}</p>
			{state.loading ? (
				<div className="runtime-message">Loading the linked configuration...</div>
			) : state.error ? (
				<div className="runtime-message error">
					{inferenceGraphUnavailable(state.error)
						? "This account has not been moved onto inference configurations yet."
						: state.error.message}
				</div>
			) : state.configuration ? (
				<ConfigurationCardBody configuration={state.configuration} returnTo={returnTo} />
			) : null}
		</section>
	);
}

export function ConfigurationCardBody({
	configuration,
	returnTo,
}: {
	configuration: RedactedInferenceConfigurationDto;
	returnTo?: InferenceReturnTarget;
}) {
	const parent = configuration.path[1] ?? null;
	return (
		<div className="card runtime-card inference-link-card-body">
			<div className="runtime-row">
				<span className="label">Configuration</span>
				<span className="value">
					<ConfigurationLink className="linklike" configurationId={configuration.id} returnTo={returnTo}>
						{configuration.displayName}
					</ConfigurationLink>
					<KindBadge kind={configuration.kind} />
				</span>
			</div>
			<div className="runtime-row">
				<span className="label">Effective model</span>
				<span className="value">{configuration.effectiveModel}</span>
			</div>
			<div className="runtime-row">
				<span className="label">Parent</span>
				<span className="value">
					{parent ? (
						<ConfigurationLink className="linklike" configurationId={parent.id} returnTo={returnTo}>
							{parent.displayName}
						</ConfigurationLink>
					) : (
						"Bickr defaults"
					)}
				</span>
			</div>
			<div className="runtime-row">
				<span className="label">Credential</span>
				<span className="value">{credentialResolutionText(configuration.credential.resolution, configuration.path)}</span>
			</div>
		</div>
	);
}
