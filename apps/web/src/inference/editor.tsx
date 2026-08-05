import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InferenceConfigurationField } from "@bickr/shared/inference-configuration";
import type {
	EffectiveImageSettings,
	InferenceConfigurationSummary,
	InferenceDeleteImpact,
	InferenceImmediateChildrenPage,
	InferenceImpactWarning,
	InferenceParentImpact,
	RedactedInferenceConfigurationDto,
} from "@bickr/shared/inference-configuration-owner";
import type { ApiFailure } from "../api";
import { SpaLink } from "../components/navigation";
import type { InferenceReturnTarget, ParsedRoute } from "../routes";
import { Confirm, EmptyState, FilterBox, Icon, Modal, ToastContext } from "../ui";
import {
	childrenPath,
	deleteConfiguration,
	inferenceGraphErrorCause,
	inferenceGraphUnavailable,
	loadConfiguration,
	loadDeleteImpact,
	loadParentImpact,
	parentCandidatesPath,
	renameConfiguration,
	reparentConfiguration,
	updateConfiguration,
} from "./api";
import {
	CredentialField,
	InferenceField,
	credentialResolutionText,
	type CredentialAction,
	type InferenceFieldSuggestion,
} from "./fields";
import {
	compactionRequestedText,
	compactionReasoningEffectiveText,
	draftMapFromFields,
	draftsChanged,
	effectiveValueText,
	inferenceEditorFields,
	inferenceFieldGroups,
	inferenceFieldLabels,
	overridePatchFromDrafts,
	sameDraft,
	draftFromOverride,
	type InferenceFieldDraft,
	type InferenceFieldDraftMap,
} from "./field-model";
import {
	openRouterSuggestedImageAspectRatios,
	openRouterSuggestedImageSizes,
} from "@bickr/shared/model";
import { useApiQuery } from "../use-api";
import { ConfigurationSummaryRow, KindBadge } from "./summary";
import { useConfigurationPage } from "./use-configuration-page";
import { createErrorMessage } from "./library";

export type StaleConflict = {
	fields: string[];
	nameChanged: boolean;
	/** The server copy, held for comparison only until the owner chooses. */
	server: RedactedInferenceConfigurationDto;
};

/** What a reload may do to the drafts an owner is holding. */
export type RefreshDecision = "adopt" | "keep_drafts" | "conflict";

/**
 * A reload never resolves a conflict on the owner's behalf. Clean drafts adopt
 * the server copy; drafts held against the same revision keep their edits while
 * the refreshed effective and inherited values are adopted around them; a
 * newer revision under dirty drafts is a conflict the owner must resolve, so
 * the loaded revision — the one a save is still expected against — stays put.
 */
export function refreshDecision(input: { currentRevision: number; nextRevision: number; dirty: boolean }): RefreshDecision {
	if (!input.dirty) return "adopt";
	return input.nextRevision === input.currentRevision ? "keep_drafts" : "conflict";
}

export function InferenceConfigurationEditorScreen({
	configurationId,
	modelSuggestions = [],
	onInferenceChanged,
	onNavigate,
	returnTo,
}: {
	configurationId: string;
	/** Nonbinding completions from the models this owner's participants use. */
	modelSuggestions?: readonly string[];
	/**
	 * Any successful mutation here can move the effective result of the
	 * configuration translation selected, so the account's translation
	 * annotation is refreshed rather than left to a later page load.
	 */
	onInferenceChanged?: () => void;
	onNavigate: (route: ParsedRoute) => void;
	returnTo?: InferenceReturnTarget;
}) {
	const [dto, setDto] = useState<RedactedInferenceConfigurationDto | null>(null);
	const [loadError, setLoadError] = useState<ApiFailure | null>(null);
	const [drafts, setDrafts] = useState<InferenceFieldDraftMap | null>(null);
	const [nameDraft, setNameDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [stale, setStale] = useState<StaleConflict | null>(null);
	const [deleteImpact, setDeleteImpact] = useState<InferenceDeleteImpact | null>(null);
	const [parentPickerOpen, setParentPickerOpen] = useState(false);
	const toast = useContext(ToastContext);
	// The same catalogue the previous editor offered, kept as non-binding
	// completions: a custom value is still stored exactly as typed.
	const imageModelsQuery = useApiQuery<{ models: { id: string; name?: string }[] }>("/api/openrouter/image-models", []);

	// Read by the focus listener, which must see the drafts as they are when the
	// window comes back rather than the ones its subscription closed over.
	const latest = useRef<{
		dto: RedactedInferenceConfigurationDto | null;
		drafts: InferenceFieldDraftMap | null;
		nameDraft: string;
	}>({ dto: null, drafts: null, nameDraft: "" });
	useEffect(() => {
		latest.current = { dto, drafts, nameDraft };
	});

	/**
	 * `drafts` says whether the owner's field edits are replaced; `name` says the
	 * same for an unsaved rename. A rename is only ever adopted from the response
	 * that saved it, so no other refresh can drop what the owner is typing.
	 */
	const apply = useCallback(
		(next: RedactedInferenceConfigurationDto, options: { drafts: "keep" | "reset"; name: "keep" | "adopt" }) => {
			setDto(next);
			if (options.name === "adopt") {
				setNameDraft(next.kind === "custom" ? next.identity.name : next.displayName);
			}
			if (options.drafts === "reset") {
				setDrafts(draftMapFromFields(next.fields));
				setStale(null);
			}
		},
		[],
	);

	const refresh = useCallback(
		async () => {
			const result = await loadConfiguration(configurationId);
			if (!result.ok) {
				setLoadError(result);
				return null;
			}
			setLoadError(null);
			apply(result.data, { drafts: "reset", name: "adopt" });
			setError("");
			return result.data;
		},
		[apply, configurationId],
	);

	useEffect(() => {
		setDto(null);
		setDrafts(null);
		setStale(null);
		setMessage("");
		setError("");
		void refresh();
	}, [refresh]);

	// Navigation and successful saves already refresh; a refocus catches edits
	// made in another tab without promising realtime cross-tab updates. A failed
	// refocus load is not allowed to replace an editor that holds unsaved edits.
	const refreshOnFocus = useCallback(async () => {
		const held = latest.current;
		if (!held.dto || !held.drafts) return;
		const result = await loadConfiguration(configurationId);
		if (!result.ok) return;
		const nameDirty = held.dto.kind === "custom" && held.nameDraft.trim() !== held.dto.identity.name;
		const decision = refreshDecision({
			currentRevision: held.dto.revision,
			nextRevision: result.data.revision,
			dirty: draftsChanged(held.drafts, held.dto.fields) || nameDirty,
		});
		if (decision === "conflict") {
			setStale(staleConflict(result.data, held.drafts, held.nameDraft));
			return;
		}
		apply(result.data, decision === "adopt" ? { drafts: "reset", name: "adopt" } : { drafts: "keep", name: "keep" });
	}, [apply, configurationId]);

	useEffect(() => {
		function onFocus(): void {
			void refreshOnFocus();
		}
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refreshOnFocus]);

	if (loadError) {
		return (
			<div className="main-inner">
				<EmptyState title={inferenceGraphUnavailable(loadError) ? "Inference library is not ready" : "Configuration unavailable"}>
					{inferenceGraphUnavailable(loadError)
						? "This account has not been moved onto inference configurations yet."
						: loadError.message}
				</EmptyState>
			</div>
		);
	}
	if (!dto || !drafts) {
		return (
			<div className="main-inner">
				<EmptyState title="Loading configuration">Reading the current effective values.</EmptyState>
			</div>
		);
	}

	const suggestions = fieldSuggestions(dto, imageModelsQuery.data?.models ?? [], modelSuggestions);
	const isAccountDefault = dto.kind === "account_default";
	const isCustom = dto.kind === "custom";
	const parentEntry = dto.path[1] ?? null;
	const dirty = draftsChanged(drafts, dto.fields);
	const nameDirty = isCustom && nameDraft.trim() !== dto.identity.name;

	/**
	 * The patch is always the difference between the drafts and the copy those
	 * drafts were loaded from, so resolving a conflict by saving over a newer
	 * revision still sends only the fields this owner actually edited.
	 */
	async function saveOverrides(expectedRevision?: number): Promise<void> {
		if (!dto || !drafts) return;
		const patch = overridePatchFromDrafts(drafts, dto.fields, inferenceFieldLabels);
		if (!patch.ok) {
			setError(patch.message);
			return;
		}
		if (Object.keys(patch.patch).length === 0) {
			setError("");
			setMessage("No field changes to save.");
			return;
		}
		setBusy(true);
		setError("");
		setMessage("");
		const result = await updateConfiguration({
			configurationId: dto.id,
			expectedRevision: expectedRevision ?? dto.revision,
			overrides: patch.patch,
		});
		setBusy(false);
		if (!result.ok) {
			await handleMutationFailure(result);
			return;
		}
		apply(result.data, { drafts: "reset", name: nameDirty ? "keep" : "adopt" });
		onInferenceChanged?.();
		setMessage("Saved. Effective values below are recomputed from the server.");
		toast.push("Saved inference configuration");
	}

	async function handleMutationFailure(failure: ApiFailure): Promise<void> {
		if (inferenceGraphErrorCause(failure) !== "stale_revision") {
			setError(createErrorMessage(failure));
			return;
		}
		// The draft is never discarded on a conflict, and the newer revision is
		// not adopted either: adopting it would let the next save overwrite the
		// other copy without the owner ever choosing to. The server copy is held
		// beside the drafts for comparison until they do.
		const fresh = await loadConfiguration(configurationId);
		if (!fresh.ok) {
			setError(failure.message);
			return;
		}
		setStale(staleConflict(fresh.data, drafts, nameDraft));
		setError("");
	}

	/**
	 * Explicit owner choice: keep these edits and write them over the newer copy.
	 * Field edits go first; the response adopts the revision they were written
	 * against, so an unsaved rename beside them is saved from the ordinary
	 * Rename button afterwards rather than guessed at here.
	 */
	async function overwriteWithDrafts(): Promise<void> {
		if (!stale) return;
		const serverRevision = stale.server.revision;
		setStale(null);
		if (dirty) {
			await saveOverrides(serverRevision);
			return;
		}
		if (nameDirty) await saveName(serverRevision);
	}

	async function saveName(expectedRevision?: number): Promise<void> {
		if (!dto || dto.kind !== "custom") return;
		setBusy(true);
		setError("");
		const result = await renameConfiguration({
			configurationId: dto.id,
			name: nameDraft.trim(),
			expectedRevision: expectedRevision ?? dto.revision,
		});
		setBusy(false);
		if (!result.ok) {
			await handleMutationFailure(result);
			return;
		}
		// The saved name is the one the owner typed, so this is the only refresh
		// allowed to replace the name draft.
		apply(result.data, { drafts: "keep", name: "adopt" });
		onInferenceChanged?.();
		toast.push("Renamed configuration");
	}

	async function saveParent(parentId: string): Promise<void> {
		if (!dto) return;
		setBusy(true);
		setError("");
		const result = await reparentConfiguration({ configurationId: dto.id, parentId, expectedRevision: dto.revision });
		setBusy(false);
		if (!result.ok) {
			await handleMutationFailure(result);
			return;
		}
		apply(result.data, { drafts: "keep", name: "keep" });
		onInferenceChanged?.();
		setParentPickerOpen(false);
		setMessage("Parent changed. Inherited values below are recomputed from the server.");
		toast.push("Changed parent configuration");
	}

	async function confirmDelete(): Promise<void> {
		if (!dto || !deleteImpact) return;
		setBusy(true);
		const result = await deleteConfiguration({ configurationId: dto.id, expectedRevision: dto.revision });
		setBusy(false);
		if (!result.ok) {
			setDeleteImpact(null);
			await handleMutationFailure(result);
			return;
		}
		// Deleting the selected custom entry resets translation to Account default
		// in the same transaction, so the annotation must be reread.
		onInferenceChanged?.();
		toast.push(`Deleted ${dto.displayName}`);
		onNavigate({ route: "inference-library", ...(returnTo ? { returnTo } : {}) });
	}

	async function applyCredential(action: CredentialAction, secret?: string): Promise<void> {
		if (!dto) return;
		setBusy(true);
		setError("");
		const result = await updateConfiguration({
			configurationId: dto.id,
			expectedRevision: dto.revision,
			credential:
				action === "replace" ? { mode: "value", secret: secret ?? "" }
				: action === "account_default" ? { mode: "account_default" }
				: action === "none" ? { mode: "none" }
				: { mode: "inherit" },
		});
		setBusy(false);
		if (!result.ok) {
			await handleMutationFailure(result);
			return;
		}
		apply(result.data, { drafts: "keep", name: "keep" });
		onInferenceChanged?.();
		toast.push("Updated provider credential");
	}

	function patchDraft(field: InferenceConfigurationField, draft: InferenceFieldDraft): void {
		setDrafts((current) => (current ? { ...current, [field]: draft } : current));
	}

	return (
		<div className="main-inner inference-editor">
			<div className="page-header">
				<div className="page-title-block">
					<h1>
						<span>{dto.displayName}</span>
						<KindBadge kind={dto.kind} />
					</h1>
					<p className="sub">
						Effective model <b>{dto.effectiveModel}</b> · {credentialResolutionText(dto.credential.resolution, dto.path)}
					</p>
				</div>
				<div className="actions">
					<SpaLink className="btn ghost" to={returnTo ?? { route: "inference-library" }}>
						{returnTo ? "Done" : "Back to library"}
					</SpaLink>
					<button className="btn primary" disabled={busy || !dirty} onClick={() => void saveOverrides()} type="button">
						{busy ? "Saving..." : "Save changes"}
					</button>
				</div>
			</div>

			{stale && (
				<div className="runtime-message error inference-stale">
					<p>
						This configuration changed elsewhere and is now at revision {stale.server.revision}. Your edits are still
						here and were not sent, and the values below are still the copy you loaded.
					</p>
					<p>{staleComparisonText(stale)}</p>
					<div className="inline-controls">
						<button className="btn compact" onClick={() => void refresh()} type="button">
							Reload saved values (discards your edits)
						</button>
						<button
							className="btn compact"
							disabled={busy || !(dirty || nameDirty)}
							onClick={() => void overwriteWithDrafts()}
							type="button"
						>
							Keep my edits and save over revision {stale.server.revision}
						</button>
					</div>
				</div>
			)}
			{error && <div className="runtime-message error">{error}</div>}
			{message && <div className="runtime-message">{message}</div>}

			<section className="section">
				<div className="section-head">
					<h2>Identity</h2>
					<span className="meta">{isCustom ? "renameable" : "derived from the account, world, or participant"}</span>
				</div>
				<div className="field-stack">
					{isCustom ? (
						<div className="field">
							<label htmlFor="inference-name">Name</label>
							<div className="inline-form">
								<input
									className="input"
									id="inference-name"
									maxLength={120}
									onChange={(event) => setNameDraft(event.target.value)}
									value={nameDraft}
								/>
								<button className="btn" disabled={busy || !nameDirty || !nameDraft.trim()} onClick={() => void saveName()} type="button">
									Rename
								</button>
							</div>
						</div>
					) : (
						<p className="help">
							This name follows the account, world, or participant it belongs to and cannot drift from a rename.
						</p>
					)}
					<div className="field">
						<span className="inference-field-label">Parent</span>
						{isAccountDefault ? (
							<p className="help">
								<span className="inference-parent-fixed">Bickr defaults</span> — Account default inherits the
								deployment defaults and has no owner parent.
							</p>
						) : (
							<div className="inline-controls">
								{parentEntry ? (
									<SpaLink
										className="linklike"
										to={{
											route: "inference-configuration",
											configurationId: parentEntry.id,
											...(returnTo ? { returnTo } : {}),
										}}
									>
										{parentEntry.displayName}
									</SpaLink>
								) : (
									<span>Bickr defaults</span>
								)}
								<button className="btn compact" disabled={busy} onClick={() => setParentPickerOpen(true)} type="button">
									Change parent
								</button>
							</div>
						)}
					</div>
				</div>
			</section>

			<section className="section">
				<div className="section-head">
					<h2>Provider credential</h2>
					<span className="meta">status only</span>
				</div>
				<CredentialField
					busy={busy}
					isAccountDefault={isAccountDefault}
					mode={dto.credential.mode}
					onAction={(action, secret) => void applyCredential(action, secret)}
					path={dto.path}
					resolution={dto.credential.resolution}
				/>
			</section>

			{inferenceFieldGroups.map((group) => (
				<section className="section" key={group.key}>
					<div className="section-head">
						<h2>{group.title}</h2>
					</div>
					<p className="help">{group.description}</p>
					{group.key === "compaction" && <CompactionSummary dto={dto} />}
					{group.key === "image" && <ImagePreviews previews={dto.imagePreviews} />}
					<div className="inference-field-grid">
						{group.fields.map((field) => (
							<InferenceField
								draft={drafts[field]}
								dto={dto.fields[field]}
								field={field}
								isAccountDefault={isAccountDefault}
								key={field}
								onChange={(draft) => patchDraft(field, draft)}
								path={dto.path}
								{...(suggestions[field] ? { suggestions: suggestions[field] } : {})}
								{...(fieldHelp(field, isAccountDefault) ? { help: fieldHelp(field, isAccountDefault) } : {})}
							/>
						))}
					</div>
				</section>
			))}

			<ImmediateChildren configurationId={dto.id} returnTo={returnTo} />

			{isCustom && (
				<section className="danger-zone">
					<h3>Danger zone</h3>
					<p>
						Deleting this configuration reparents its immediate children to its own parent. Values are not copied
						down, so effective values may change.
					</p>
					<button
						className="btn danger solid"
						disabled={busy}
						onClick={() => {
							void (async () => {
								const impact = await loadDeleteImpact(dto.id);
								if (impact.ok) setDeleteImpact(impact.data);
								else setError(impact.message);
							})();
						}}
						type="button"
					>
						<Icon name="trash" size={14} />
						Delete configuration
					</button>
				</section>
			)}

			{parentPickerOpen && (
				<ParentPickerModal
					busy={busy}
					configuration={dto}
					onClose={() => setParentPickerOpen(false)}
					onConfirm={(parentId) => void saveParent(parentId)}
				/>
			)}

			<Confirm
				body={
					deleteImpact ? (
						<div className="field-stack">
							{deleteImpactLines(dto.displayName, parentEntry?.displayName ?? "its parent", deleteImpact).map((line) => (
								<p key={line}>{line}</p>
							))}
							<ImpactWarnings warnings={deleteImpact.warnings} />
						</div>
					) : (
						<p>Loading deletion impact...</p>
					)
				}
				confirmText="Delete configuration"
				danger
				onClose={() => setDeleteImpact(null)}
				onConfirm={() => void confirmDelete()}
				open={Boolean(deleteImpact)}
				title="Delete this configuration?"
			/>
		</div>
	);
}

const providerRoutingDocsUrl = "https://openrouter.ai/docs/guides/routing/provider-selection";

function fieldHelp(field: InferenceConfigurationField, isAccountDefault: boolean): ReactNode {
	if (field === "baseUrl" && !isAccountDefault) {
		return "Inherit continues through the immediate parent. Use Account default skips intervening entries for this field only and keeps the provenance of whatever Account default or Bickr defaults supply.";
	}
	if (field === "providerRouting" || field === "imageProviderRouting") {
		return (
			<>
				Sent as OpenRouter's <code>provider</code> request-body object. See{" "}
				<a href={providerRoutingDocsUrl} rel="noreferrer" target="_blank">
					OpenRouter provider routing docs
				</a>
				.
			</>
		);
	}
	return null;
}

/**
 * Completions only. Image aspect ratios and sizes are model-specific, so they
 * follow the configuration's resolved image model rather than a fixed list.
 */
export function fieldSuggestions(
	dto: RedactedInferenceConfigurationDto,
	imageModels: readonly { id: string; name?: string }[],
	ownedModels: readonly string[] = [],
): Partial<Record<InferenceConfigurationField, InferenceFieldSuggestion[]>> {
	const imageModel = dto.imagePreviews.participant.model ?? "";
	return {
		model: [...new Set([...ownedModels, dto.effectiveModel].filter(Boolean))]
			.sort((left, right) => left.localeCompare(right))
			.map((value) => ({ value })),
		imageModel: imageModels.map((model) => ({ value: model.id, ...(model.name ? { label: `${model.name} (${model.id})` } : {}) })),
		imageAspectRatio: openRouterSuggestedImageAspectRatios(imageModel).map((value) => ({ value })),
		imageSize: openRouterSuggestedImageSizes(imageModel).map((value) => ({ value })),
	};
}

function childCountText(count: number): string {
	return count === 1 ? "1 immediate child" : `${count} immediate children`;
}

/**
 * Deletion names the replacement parent, both dependent counts, and the fact
 * that inheritance is repaired rather than flattened. A translation reset is
 * disclosed here because the same transaction performs it.
 */
export function deleteImpactLines(
	displayName: string,
	parentName: string,
	impact: InferenceDeleteImpact,
): string[] {
	return [
		`${displayName} will be removed. Its ${childCountText(impact.immediateDependentCount)} will be reparented to ${parentName}.`,
		`${impact.transitiveDependentCount} configuration${impact.transitiveDependentCount === 1 ? "" : "s"} depend on this entry. Inherited effective values may change, because deletion repairs links rather than copying values down.`,
		...(impact.resetsTranslationSelection
			? ["Inline translation currently uses this configuration and will switch to Account default."]
			: []),
	];
}

/**
 * The comparison an owner is shown before choosing. It names every field whose
 * draft differs from the server copy, plus the name when an unsaved rename or a
 * rename made elsewhere disagrees with it.
 */
export function staleConflict(
	server: RedactedInferenceConfigurationDto,
	drafts: InferenceFieldDraftMap | null,
	nameDraft: string,
): StaleConflict {
	return {
		fields: conflictingFieldLabels(drafts, server),
		nameChanged: server.kind === "custom" && nameDraft.trim() !== server.identity.name,
		server,
	};
}

export function staleComparisonText(stale: Pick<StaleConflict, "fields" | "nameChanged">): string {
	const differing = [...stale.fields, ...(stale.nameChanged ? ["Name"] : [])];
	return differing.length > 0
		? `Differs from the saved copy: ${differing.join(", ")}.`
		: "Your edited fields match the saved copy; only the revision moved.";
}

export function conflictingFieldLabels(
	drafts: InferenceFieldDraftMap | null,
	server: RedactedInferenceConfigurationDto,
): string[] {
	if (!drafts) return [];
	return inferenceEditorFields
		.filter((field) => !sameDraft(drafts[field], draftFromOverride(field, server.fields[field].override)))
		.map((field) => inferenceFieldLabels[field]);
}

function CompactionSummary({ dto }: { dto: RedactedInferenceConfigurationDto }) {
	const adjustment = dto.fields.compactionReasoning.adjustment;
	const resolution = adjustment && adjustment.kind === "compaction_policy" ? adjustment.resolution : undefined;
	return (
		<div className="card runtime-card inference-compaction-summary">
			<div className="runtime-row">
				<span className="label">Requested</span>
				<span className="value">{compactionRequestedText(dto)}</span>
			</div>
			<div className="runtime-row">
				<span className="label">Effective</span>
				<span className="value">{compactionReasoningEffectiveText(resolution)}</span>
			</div>
			{resolution && (
				<div className="runtime-row">
					<span className="label">Contributors</span>
					<span className="value">
						{`configuration ${resolution.provenance.configuration ? "requested" : "inherited"}, model default ${resolution.provenance.modelDefault.kind}, safety floor ${resolution.provenance.safetyFloor.kind}${
							resolution.provenance.learnedFloor ? ", learned runtime floor" : ""
						}`}
					</span>
				</div>
			)}
		</div>
	);
}

function ImagePreviews({ previews }: { previews: { participant: EffectiveImageSettings; world: EffectiveImageSettings } }) {
	return (
		<div className="inference-image-previews">
			<ImagePreview label="Participant and account avatars" settings={previews.participant} />
			<ImagePreview label="World avatars" settings={previews.world} />
		</div>
	);
}

function ImagePreview({ label, settings }: { label: string; settings: EffectiveImageSettings }) {
	return (
		<div className="card runtime-card">
			<div className="runtime-row">
				<span className="label">{label}</span>
				<span className="value">{settings.model ?? "no image model"}</span>
			</div>
			<div className="runtime-row">
				<span className="label">Aspect ratio</span>
				<span className="value">{settings.aspectRatio ?? "provider default"}</span>
			</div>
			<div className="runtime-row">
				<span className="label">Image size</span>
				<span className="value">{settings.imageSize ?? "provider default"}</span>
			</div>
		</div>
	);
}

export function impactWarningText(warning: InferenceImpactWarning): string {
	switch (warning.kind) {
		case "effective_model_changes":
			return `${warning.configurations} configuration${warning.configurations === 1 ? "" : "s"} would resolve a different model.`;
		case "effective_base_url_changes":
			return `${warning.configurations} configuration${warning.configurations === 1 ? "" : "s"} would resolve a different base URL.`;
		case "credential_availability_changes":
			return `${warning.configurations} configuration${warning.configurations === 1 ? "" : "s"} would gain or lose credential availability.`;
		case "credential_source_changes":
			return `${warning.configurations} configuration${warning.configurations === 1 ? "" : "s"} would take their credential from a different entry.`;
		case "provider_access_changes":
			return `${warning.configurations} configuration${warning.configurations === 1 ? "" : "s"} would change provider authorization, so their stored model may fall back.`;
	}
}

/** Provider or credential loss is the only change that needs a confirmation. */
export function impactRequiresConfirmation(warnings: readonly InferenceImpactWarning[]): boolean {
	return warnings.some(
		(warning) =>
			warning.kind === "credential_availability_changes" ||
			warning.kind === "credential_source_changes" ||
			warning.kind === "provider_access_changes",
	);
}

function ImpactWarnings({ warnings }: { warnings: readonly InferenceImpactWarning[] }) {
	if (warnings.length === 0) {
		return <p className="help">No provider, credential, or effective-model change was detected.</p>;
	}
	return (
		<ul className="inference-impact-warnings">
			{warnings.map((warning) => (
				<li key={warning.kind}>{impactWarningText(warning)}</li>
			))}
		</ul>
	);
}

function ParentPickerModal({
	busy,
	configuration,
	onClose,
	onConfirm,
}: {
	busy: boolean;
	configuration: RedactedInferenceConfigurationDto;
	onClose: () => void;
	onConfirm: (parentId: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [candidateId, setCandidateId] = useState<string | null>(null);
	const [answer, setAnswer] = useState<ParentImpactAnswer | null>(null);
	const [impactError, setImpactError] = useState("");
	const [loadingImpact, setLoadingImpact] = useState(false);
	const [confirmed, setConfirmed] = useState(false);

	const candidates = useConfigurationPage<{ items: InferenceConfigurationSummary[]; nextCursor?: string }>(
		(cursor) => parentCandidatesPath(configuration.id, { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) }),
		(payload) => {
			const page = (payload as { candidates?: { items: InferenceConfigurationSummary[]; nextCursor?: string } }).candidates;
			return page && Array.isArray(page.items) ? page : null;
		},
		[configuration.id, query],
	);

	// Recent choices and Account default come first: the current parent and the
	// account root are the entries an owner reaches for most often.
	const ordered = useMemo(() => orderedParentCandidates(candidates.items, configuration.parentId), [candidates.items, configuration.parentId]);

	// An impact preview belongs to the candidate it was requested for: a slower
	// answer for an earlier candidate must never describe, or confirm, the
	// current selection.
	const selectedCandidateRef = useRef<string | null>(null);
	const impact = impactForSelection(answer, candidateId);

	async function selectCandidate(id: string): Promise<void> {
		selectedCandidateRef.current = id;
		setCandidateId(id);
		setAnswer(null);
		setConfirmed(false);
		setImpactError("");
		setLoadingImpact(true);
		const result = await loadParentImpact(configuration.id, id);
		if (selectedCandidateRef.current !== id) return;
		setLoadingImpact(false);
		if (result.ok) setAnswer({ candidateId: id, impact: result.data });
		else setImpactError(result.message);
	}

	const needsConfirmation = impact ? impactRequiresConfirmation(impact.warnings) : false;

	return (
		<Modal
			foot={
				<>
					<span />
					<div className="right">
						<button className="btn ghost" onClick={onClose} type="button">Cancel</button>
						<button
							className="btn primary"
							disabled={busy || !candidateId || !impact || (needsConfirmation && !confirmed)}
							onClick={() => candidateId && onConfirm(candidateId)}
							type="button"
						>
							Change parent
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open
			title="Change parent configuration"
			wide
		>
			<div className="field-stack">
				<FilterBox label="Search parent candidates" onChange={setQuery} placeholder="Search candidates" value={query} />
				{candidates.loading ? (
					<div className="runtime-message">Loading candidates...</div>
				) : candidates.error ? (
					<div className="runtime-message error">{candidates.error.message}</div>
				) : ordered.length === 0 ? (
					<div className="runtime-message">No candidate matches this search.</div>
				) : (
					<ul className="inference-parent-options">
						{ordered.map((candidate) => (
							<li key={candidate.id}>
								<button
									aria-pressed={candidateId === candidate.id}
									className={`btn compact ${candidateId === candidate.id ? "primary" : "ghost"}`}
									onClick={() => void selectCandidate(candidate.id)}
									type="button"
								>
									{candidate.displayName}
									{candidate.id === configuration.parentId ? " (current)" : ""}
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
				{loadingImpact && <div className="runtime-message">Checking impact...</div>}
				{impactError && <div className="runtime-message error">{impactError}</div>}
				{impact && (
					<div className="card runtime-card inference-impact">
						<p>
							{impact.immediateDependentCount} immediate and {impact.transitiveDependentCount} total dependent
							configurations would be affected.
						</p>
						<ImpactWarnings warnings={impact.warnings} />
						{needsConfirmation && (
							<label className="checkbox-line">
								<input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
								<span>I understand that provider or credential access changes for those configurations.</span>
							</label>
						)}
					</div>
				)}
			</div>
		</Modal>
	);
}

/** An impact preview, kept together with the candidate it was requested for. */
export type ParentImpactAnswer = { candidateId: string; impact: InferenceParentImpact };

/**
 * Only the selected candidate's own preview is shown, and only that preview can
 * enable the reparent. An answer that arrives for a candidate the owner has
 * already moved off cannot describe or confirm the current selection.
 */
export function impactForSelection(
	answer: ParentImpactAnswer | null,
	candidateId: string | null,
): InferenceParentImpact | null {
	return answer && candidateId && answer.candidateId === candidateId ? answer.impact : null;
}

export function orderedParentCandidates(
	items: readonly InferenceConfigurationSummary[],
	currentParentId: string | null,
): InferenceConfigurationSummary[] {
	return [...items].sort((left, right) => rank(left, currentParentId) - rank(right, currentParentId));
}

function rank(summary: InferenceConfigurationSummary, currentParentId: string | null): number {
	if (summary.id === currentParentId) return 0;
	if (summary.kind === "account_default") return 1;
	return 2;
}

function ImmediateChildren({
	configurationId,
	returnTo,
}: {
	configurationId: string;
	returnTo?: InferenceReturnTarget;
}) {
	const [query, setQuery] = useState("");
	const children = useConfigurationPage<InferenceImmediateChildrenPage>(
		(cursor) => childrenPath(configurationId, { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) }),
		(payload) => {
			const page = (payload as { children?: InferenceImmediateChildrenPage }).children;
			return page && Array.isArray(page.items) ? page : null;
		},
		[configurationId, query],
	);
	const total = children.extra?.totalImmediateChildren ?? 0;

	return (
		<section className="section">
			<div className="section-head">
				<h2>Immediate children</h2>
				<span className="meta">{total === 1 ? "1 configuration" : `${total} configurations`}</span>
			</div>
			<FilterBox label="Search immediate children" onChange={setQuery} placeholder="Search children" value={query} />
			{children.loading ? (
				<div className="runtime-message">Loading children...</div>
			) : children.error ? (
				<div className="runtime-message error">{children.error.message}</div>
			) : children.items.length === 0 ? (
				<EmptyState title={query ? "No matches" : "No children"}>
					{query ? "No immediate child matches this search." : "No configuration inherits directly from this entry."}
				</EmptyState>
			) : (
				<ul className="inference-summary-list">
					{children.items.map((summary) => (
						<ConfigurationSummaryRow key={summary.id} returnTo={returnTo} summary={summary} />
					))}
				</ul>
			)}
			{children.nextCursor && (
				<button className="btn ghost compact" disabled={children.loadingMore} onClick={children.loadMore} type="button">
					{children.loadingMore ? "Loading..." : "Load more"}
				</button>
			)}
		</section>
	);
}

export { effectiveValueText };
