import type {
	InferenceConfigurationEntryIdentity,
	InferenceConfigurationSummary,
	InferenceEffectiveCredentialAvailability,
} from "@bickr/shared/inference-configuration-owner";
import type { InferenceReturnTarget } from "../routes";
import { SpaLink } from "../components/navigation";

export function configurationKindLabel(kind: InferenceConfigurationEntryIdentity["kind"]): string {
	switch (kind) {
		case "account_default": return "Account default";
		case "translation": return "Translation";
		case "world": return "World";
		case "bot": return "Participant";
		case "custom": return "Custom";
	}
}

export function KindBadge({ kind }: { kind: InferenceConfigurationEntryIdentity["kind"] }) {
	return <span className={`inference-kind-badge kind-${kind}`}>{configurationKindLabel(kind)}</span>;
}

export function credentialAvailabilityLabel(availability: InferenceEffectiveCredentialAvailability): string {
	switch (availability.kind) {
		case "available": return "key available";
		case "explicit_none": return "explicitly no key";
		case "unavailable": return "no key available";
	}
}

export function ConfigurationLink({
	children,
	className,
	configurationId,
	returnTo,
}: {
	children: React.ReactNode;
	className?: string;
	configurationId: string;
	returnTo?: InferenceReturnTarget;
}) {
	return (
		<SpaLink
			className={className}
			to={{ route: "inference-configuration", configurationId, ...(returnTo ? { returnTo } : {}) }}
		>
			{children}
		</SpaLink>
	);
}

/** One bounded summary row shared by the library, pickers, and child lists. */
export function ConfigurationSummaryRow({
	returnTo,
	summary,
}: {
	returnTo?: InferenceReturnTarget;
	summary: InferenceConfigurationSummary;
}) {
	return (
		<li className="inference-summary-row">
			<div className="inference-summary-identity">
				<ConfigurationLink className="linklike" configurationId={summary.id} returnTo={returnTo}>
					{summary.displayName}
				</ConfigurationLink>
				<KindBadge kind={summary.kind} />
			</div>
			<div className="inference-summary-meta">
				<span className="inference-summary-model">{summary.effectiveModel}</span>
				<span className="inference-summary-credential">{credentialAvailabilityLabel(summary.credentialAvailability)}</span>
				<span className="inference-summary-parent">
					{summary.parent ? (
						<>
							Inherit settings from:{" "}
							<ConfigurationLink className="linklike" configurationId={summary.parent.id} returnTo={returnTo}>
								{summary.parent.displayName}
							</ConfigurationLink>
						</>
					) : (
						"Inherit settings from: Bickr defaults"
					)}
				</span>
				<span className="inference-summary-children">
					{summary.immediateChildCount === 1 ? "1 child" : `${summary.immediateChildCount} children`}
				</span>
			</div>
		</li>
	);
}
