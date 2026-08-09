import { useCallback, useEffect, useState } from "react";
import type {
	FixedInferenceConfigurationReference,
	RedactedInferenceConfigurationDto,
} from "@bickr/shared/inference-configuration-owner";
import type { ApiFailure } from "../api";
import type { InferenceReturnTarget } from "../routes";
import { SpaLink } from "../components/navigation";
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
 * participant. The screen names only the entity it already displays; the server
 * authorizes that entity against the owner and answers with the configuration's
 * own identity metadata, so no configuration address is derived here.
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
		void api<{ configuration: RedactedInferenceConfigurationDto }>(fixedConfigurationPath(reference)).then((result) => {
			if (cancelled) return;
			setState(
				result.ok
					? { configuration: result.data.configuration, error: null, loading: false }
					: { configuration: null, error: result, loading: false },
			);
		});
		return () => {
			cancelled = true;
		};
	}, [key, token]);

	return { ...state, reload };
}

function referenceEntityId(reference: FixedInferenceConfigurationReference): string {
	switch (reference.kind) {
		case "account_default": return "";
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

/**
 * The participant editor deliberately exposes one action instead of repeating
 * the reusable configuration's model, parent, and credential summary. The
 * configuration address always comes from a loaded owner DTO for the current
 * participant; the handle is presentation and return-navigation state only.
 */
export function BotInferenceConfigurationAction({
	botHandle,
	botId,
	state,
	worldHandle,
}: {
	botHandle: string;
	botId: string;
	state: FixedConfigurationState;
	worldHandle: string;
}) {
	const label = `Open inference configuration for u/${botHandle}`;
	const configuration = state.configuration;
	const readyConfiguration = !state.loading && configuration?.kind === "bot" && configuration.identity.botId === botId
		? configuration
		: null;
	const action = readyConfiguration ? (
		<SpaLink
			className="btn primary"
			to={{
				route: "inference-configuration",
				configurationId: readyConfiguration.id,
				returnTo: { route: "bot-edit", worldHandle, botHandle },
			}}
		>
			{label}
		</SpaLink>
	) : (
		<button className="btn primary" disabled type="button">{label}</button>
	);

	return (
		<>
			{action}
			{state.loading ? (
				<div className="runtime-message">Loading the linked configuration...</div>
			) : state.error ? (
				<div className="runtime-message error">
					{inferenceGraphUnavailable(state.error)
						? "This account has not been moved onto inference configurations yet."
						: state.error.message}
				</div>
			) : null}
		</>
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
