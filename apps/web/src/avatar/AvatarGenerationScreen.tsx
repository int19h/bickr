import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	localizedTextString,
	type AvatarImage,
	type BotSummary,
	type LanguageTag,
} from "@bickr/shared/model";

import { api, apiResponseErrorMessage, type ApiFailure } from "../api";
import { inferenceGraphErrorCause, updateConfiguration } from "../inference/api";
import { ConfigurationLinkCard, useFixedConfiguration } from "../inference/links";
import type { InferenceReturnTarget } from "../routes";
import {
	applyAvatarGenerationStreamEvent,
	readAvatarGenerationEventStream,
	type AvatarGenerationChatEntry,
} from "../avatar-generation-stream";
import { avatarPreviewUrl } from "../avatar-image-urls";
import { normalizeReadableText } from "../reasoning-formatting";
import { FallbackImage, ImageLightbox } from "../ui";
import { runApiAction, useApiQuery } from "../use-api";
import {
	avatarEffectiveDraftModel,
	avatarImageSettingsFields,
	avatarPromptFillSettingsFields,
	avatarResetDrafts,
	avatarSettingsChanged,
	avatarSettingsError,
	avatarSettingsOverridden,
	avatarSettingsPatch,
	imageSettingsRequestBundle,
	promptFillSettingsRequestBundle,
	type AvatarSettingsDrafts,
} from "./generation-settings";
import {
	AvatarImageAdvancedFields,
	AvatarImageBasicFields,
	AvatarPromptFillFields,
} from "./image-settings-fields";
import type { AvatarPromptFillMode, AvatarTarget } from "./target";

export type OpenRouterImageModel = {
	id: string;
	inputModalities: string[];
	name: string;
	outputModalities: string[];
};

function throwApiError(message: string): never {
	throw new Error(message);
}

function generatedAvatarCost(candidate: AvatarImage | null): number | null {
	if (candidate?.source?.type !== "generated" || candidate.source.cost === undefined) {
		return null;
	}
	return Number.isFinite(candidate.source.cost) ? candidate.source.cost : null;
}

function formatTokenCost(value: number): string {
	if (!Number.isFinite(value)) {
		return "$0.00";
	}
	const fractionDigits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
	return new Intl.NumberFormat(undefined, {
		currency: "USD",
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
		style: "currency",
	}).format(value);
}

function AvatarGenerationChatLog({ entries }: { entries: AvatarGenerationChatEntry[] }) {
	return (
		<section className="avatar-chat-log" aria-label="Image generation chat log">
			<div className="section-head compact">
				<h2>Chat log</h2>
			</div>
			{entries.length === 0 ?
				<div className="empty compact-empty">No generation request yet.</div>
			:	<div className="avatar-chat-log-rows">
					{entries.map((entry, index) => (
						<div className={`avatar-chat-row role-${entry.role}`} key={`${entry.role}-${index}`}>
							<div className="avatar-chat-role">
								<span>{entry.role}</span>
								{entry.status && entry.role === "assistant" && <span className={`streaming-pill ${entry.status}`}>{entry.status}</span>}
							</div>
							<div className="avatar-chat-content">
								{entry.content ?
									<span>{normalizeReadableText(entry.content)}</span>
								: entry.status === "streaming" ?
									<span className="muted">Waiting for response...</span>
								:	null}
								{entry.imageCount ? (
									<span className="avatar-chat-image-marker">
										[{entry.imageCount === 1 ? "image received" : `${entry.imageCount} images received`}]
									</span>
								) : null}
								{entry.statusMessage && <span className="avatar-chat-status-message">{entry.statusMessage}</span>}
							</div>
						</div>
					))}
				</div>
			}
		</section>
	);
}

export type AvatarGenerationScreenProps<TMutationResponse, TSaved> = {
	breadcrumb: ReactNode;
	fallbackAvatar: ReactNode;
	membersPrompt?: { available: boolean; title: string };
	onBack: () => void;
	// Prompt-only saves go to the entity PATCH endpoints, which validate
	// localized text against the language carried in the same request body —
	// these saves carry none, so localized fields must be stamped null. Only
	// the generation/apply payloads (validated by the avatar endpoints against
	// the entity's effective language chain) use target.owner.language.
	onSavePrompt: (prompt: string, language: LanguageTag | null) => Promise<boolean>;
	onSaved: (saved: TSaved, affectedBots?: BotSummary[]) => void;
	returnTo: InferenceReturnTarget;
	target: AvatarTarget<TMutationResponse, TSaved>;
};

export function AvatarGenerationScreen<TMutationResponse, TSaved>({
	breadcrumb,
	fallbackAvatar,
	membersPrompt,
	onBack,
	onSavePrompt,
	onSaved,
	returnTo,
	target,
}: AvatarGenerationScreenProps<TMutationResponse, TSaved>) {
	// Image inference is not editable here: the canonical resolved settings for
	// this target come from its configuration and are shown read-only.
	const configuration = useFixedConfiguration(target.generation.configuration);
	const modelsQuery = useApiQuery<{ models: OpenRouterImageModel[] }>("/api/openrouter/image-models", []);
	const models = modelsQuery.data?.models ?? [];
	const [prompt, setPrompt] = useState(target.generation.prompt);
	const [settingsDrafts, setSettingsDrafts] = useState<AvatarSettingsDrafts>({});
	const [includeCurrentAvatar, setIncludeCurrentAvatar] = useState(Boolean(target.owner.avatarUrl));
	const [candidate, setCandidate] = useState<AvatarImage | null>(null);
	const [chatEntries, setChatEntries] = useState<AvatarGenerationChatEntry[]>([]);
	const [generating, setGenerating] = useState(false);
	const [activePromptFill, setActivePromptFill] = useState<AvatarPromptFillMode | null>(null);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
	const [currentAvatarFailed, setCurrentAvatarFailed] = useState(false);
	const generationAbortRef = useRef<AbortController | null>(null);
	const promptFillAbortRef = useRef<AbortController | null>(null);
	const language = target.owner.language;
	const effectiveImage = configuration.configuration?.imagePreviews[target.generation.imageTarget];
	const configurationFields = configuration.configuration?.fields;
	const editableFields = target.generation.editablePromptFillSettings
		? [...avatarImageSettingsFields, ...avatarPromptFillSettingsFields]
		: avatarImageSettingsFields;

	useEffect(() => {
		setPrompt(target.generation.prompt);
		setIncludeCurrentAvatar(Boolean(target.owner.avatarUrl));
		setCurrentAvatarFailed(false);
		setCandidate(null);
		setChatEntries([]);
		setSettingsDrafts({});
		setMessage("");
		setError("");
	}, [target.generation.prompt, target.owner.avatarUrl, target.owner.key]);

	useEffect(() => {
		return () => {
			generationAbortRef.current?.abort();
			promptFillAbortRef.current?.abort();
		};
	}, []);

	const effectiveModel = configurationFields
		? avatarEffectiveDraftModel(settingsDrafts, configurationFields, "imageModel", effectiveImage?.model)
		: effectiveImage?.model ?? "";
	const selectedModel = models.find((model) => model.id === effectiveModel);
	const selectedSupportsImageInput = Boolean(selectedModel?.inputModalities.includes("image"));
	const selectedSupportsTextOutput = Boolean(selectedModel?.outputModalities.includes("text"));
	const currentAvatarAvailable = Boolean(target.owner.avatarUrl && !currentAvatarFailed);
	useEffect(() => {
		if (!selectedSupportsImageInput || !currentAvatarAvailable) {
			setIncludeCurrentAvatar(false);
			return;
		}
		setIncludeCurrentAvatar(true);
	}, [currentAvatarAvailable, selectedSupportsImageInput]);

	const model = effectiveModel;
	const promptAllowed = prompt.trim().length > 0 || (includeCurrentAvatar && currentAvatarAvailable);
	const settingsDraftError = configurationFields ? avatarSettingsError(editableFields, settingsDrafts, configurationFields) : "";
	const generationSettingsError = modelsQuery.error || settingsDraftError;
	const candidateCost = generatedAvatarCost(candidate);
	const promptFillActive = activePromptFill !== null;
	const currentAvatarPromptFillAvailable = Boolean(
		!prompt.trim() &&
		currentAvatarAvailable &&
		model &&
		!settingsDraftError &&
		selectedSupportsImageInput &&
		selectedSupportsTextOutput,
	);
	const canGenerate = Boolean(model) && promptAllowed && !settingsDraftError && !generating && !promptFillActive;

	function promptFillAvailable(mode: AvatarPromptFillMode): boolean {
		const option = target.generation.promptFillOptions.find((item) => item.mode === mode);
		if (option?.requirement === "current-avatar") {
			return currentAvatarPromptFillAvailable;
		}
		if (option?.requirement === "members") {
			return Boolean(membersPrompt?.available);
		}
		return true;
	}

	async function fillPrompt(mode: AvatarPromptFillMode): Promise<void> {
		const controller = new AbortController();
		promptFillAbortRef.current = controller;
		setActivePromptFill(mode);
		setChatEntries([]);
		setError("");
		setMessage("");
		let streamError = "";
		let finalPrompt = "";
		try {
			// Unsaved edits ride along as a one-shot `settings` bundle; with no
			// edits the server resolves inference purely from the target's own
			// configuration.
			const textMode = mode === "persona" || mode === "description" || mode === "members";
			const fillSettings = configurationFields === undefined ? undefined
				: mode === "current_avatar" ? imageSettingsRequestBundle(settingsDrafts, configurationFields)
				: mode === "description" || mode === "members"
					? promptFillSettingsRequestBundle(settingsDrafts, configurationFields)
					: undefined;
			const body = {
				mode,
				...(textMode && prompt.trim() ? { prefill: prompt } : {}),
				...(fillSettings ? { settings: fillSettings } : {}),
			};
			const response = await fetch(target.endpoints.prompt, {
				method: "POST",
				headers: { accept: "text/event-stream", "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
				throw new Error(await apiResponseErrorMessage(response));
			}
			await readAvatarGenerationEventStream(response, (event) => {
				setChatEntries((current) => applyAvatarGenerationStreamEvent(current, event));
				if (event.type === "done" && "prompt" in event) {
					finalPrompt = event.prompt;
				}
				if (event.type === "error") {
					streamError = event.message;
					setError(event.message);
				}
			});
			if (streamError) {
				throw new Error(streamError);
			}
			if (finalPrompt) {
				setPrompt(finalPrompt);
			}
		} catch (caught) {
			if (controller.signal.aborted) {
				setChatEntries((current) => applyAvatarGenerationStreamEvent(current, { type: "aborted", message: "Prompt fill aborted." }));
			} else {
				setError(caught instanceof Error ? caught.message : "Could not fill prompt.");
			}
		} finally {
			if (promptFillAbortRef.current === controller) {
				promptFillAbortRef.current = null;
			}
			setActivePromptFill(null);
		}
	}

	async function generate(): Promise<void> {
		const controller = new AbortController();
		generationAbortRef.current = controller;
		setGenerating(true);
		setCandidate(null);
		setChatEntries([]);
		setError("");
		setMessage("");
		let streamError = "";
		try {
			const generationSettings = configurationFields
				? imageSettingsRequestBundle(settingsDrafts, configurationFields)
				: undefined;
			const response = await fetch(target.endpoints.generate, {
				method: "POST",
				headers: { accept: "text/event-stream", "content-type": "application/json" },
				body: JSON.stringify({
					prompt,
					includeCurrentAvatar,
					...(generationSettings ? { settings: generationSettings } : {}),
				}),
				signal: controller.signal,
			});
			if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
				throw new Error(await apiResponseErrorMessage(response));
			}
			await readAvatarGenerationEventStream(response, (event) => {
				setChatEntries((current) => applyAvatarGenerationStreamEvent(current, event));
				if (event.type === "done" && "candidate" in event) {
					setCandidate(event.candidate);
				}
				if (event.type === "error") {
					streamError = event.message;
					setError(event.message);
				}
			});
			if (streamError) {
				throw new Error(streamError);
			}
		} catch (caught) {
			if (controller.signal.aborted) {
				setChatEntries((current) => applyAvatarGenerationStreamEvent(current, { type: "aborted", message: "Avatar generation aborted." }));
			} else {
				setError(caught instanceof Error ? caught.message : "Could not generate avatar.");
			}
		} finally {
			if (generationAbortRef.current === controller) {
				generationAbortRef.current = null;
			}
			setGenerating(false);
		}
	}

	function abortGeneration(): void {
		generationAbortRef.current?.abort();
		setChatEntries((current) => applyAvatarGenerationStreamEvent(current, { type: "aborted", message: "Avatar generation aborted." }));
	}

	function abortPromptFill(): void {
		promptFillAbortRef.current?.abort();
		setChatEntries((current) => applyAvatarGenerationStreamEvent(current, { type: "aborted", message: "Prompt fill aborted." }));
	}

	/**
	 * Writes the changed image (and, for worlds, prompt fill) field overrides
	 * to the target's fixed configuration. Returns false when nothing was
	 * saved because of a failure; an unchanged draft trivially succeeds.
	 */
	async function saveSettingsOverrides(): Promise<boolean> {
		const dto = configuration.configuration;
		if (!dto || !avatarSettingsChanged(editableFields, settingsDrafts, dto.fields)) {
			return true;
		}
		const parsed = avatarSettingsPatch(editableFields, settingsDrafts, dto.fields);
		if (!parsed.ok) {
			setError(parsed.message);
			return false;
		}
		const result = await updateConfiguration({
			configurationId: dto.id,
			expectedRevision: dto.revision,
			overrides: parsed.patch,
		});
		if (!result.ok) {
			setError(settingsSaveErrorMessage(result));
			configuration.reload();
			return false;
		}
		setSettingsDrafts({});
		configuration.reload();
		return true;
	}

	function settingsSaveErrorMessage(failure: ApiFailure): string {
		// The generation screen holds no stale-comparison UI; the reload beside
		// this message re-seeds the form from the newer revision, and unsaved
		// drafts stay applied on top of it.
		return inferenceGraphErrorCause(failure) === "stale_revision"
			? "The configuration changed elsewhere; its newer values were reloaded. Review and save again."
			: failure.message;
	}

	async function save(): Promise<void> {
		setSaving(true);
		setError("");
		setMessage("");
		try {
			if (!(await saveSettingsOverrides())) {
				return;
			}
			if (candidate) {
				const promptToSave = candidate.source?.type === "generated" && candidate.source.prompt ? candidate.source.prompt : prompt;
				const result = await runApiAction(throwApiError, () => api<TMutationResponse>(target.endpoints.apply, {
					method: "POST",
					// Only the entity-owned image prompt is persisted with the avatar;
					// reusable image inference stays in the configuration graph.
					body: { candidate, settings: { prompt: { lang: language, text: promptToSave } } },
				}));
				const saved = target.readSaved(result.data);
				onSaved(saved.saved, saved.affectedBots);
				setCandidate(null);
				setMessage("Avatar saved.");
			} else {
				const ok = await onSavePrompt(prompt, null);
				if (ok) {
					setMessage("Image generation settings saved.");
				}
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not save avatar.");
		} finally {
			setSaving(false);
		}
	}

	/**
	 * Returns every editable field to inherit and saves that immediately, the
	 * way the old Reset discarded the entity-owned settings bundle. Unsaved
	 * field edits are discarded with it; the entity-owned prompt is untouched.
	 */
	async function resetSettings(): Promise<void> {
		const dto = configuration.configuration;
		if (!dto) {
			return;
		}
		setSaving(true);
		setError("");
		setMessage("");
		try {
			const drafts = avatarResetDrafts(editableFields);
			const parsed = avatarSettingsPatch(editableFields, drafts, dto.fields);
			if (!parsed.ok) {
				setError(parsed.message);
				return;
			}
			if (Object.keys(parsed.patch).length === 0) {
				setSettingsDrafts({});
				setMessage(target.uiText.discardedSettings);
				return;
			}
			const result = await updateConfiguration({
				configurationId: dto.id,
				expectedRevision: dto.revision,
				overrides: parsed.patch,
			});
			if (!result.ok) {
				setError(settingsSaveErrorMessage(result));
				configuration.reload();
				return;
			}
			setSettingsDrafts({});
			configuration.reload();
			setMessage(target.uiText.discardedSettings);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="main-inner avatar-generation-screen">
			{breadcrumb}
			<div className="page-header">
				<div>
					<h1>Generate Avatar</h1>
					<p>{target.uiText.handlePrefix}{target.owner.handle}</p>
				</div>
				<div className="actions">
					<button className="btn ghost" onClick={onBack} type="button">Back</button>
					{/* The image prompt belongs to this entity while the non-prompt
					    fields save into the linked configuration; a prompt-only save
					    still works when no image model resolves — that is exactly when
					    an owner writes the prompt first and chooses a model afterwards. */}
					<button className="btn primary" disabled={saving || Boolean(settingsDraftError)} onClick={() => void save()} type="button">
						{saving ? "Saving..." : "Save"}
					</button>
				</div>
			</div>
			<ConfigurationLinkCard
				description={
					target.generation.imageTarget === "world"
						? "World avatars use this configuration's resolved image fields, with world image defaults applied after resolution."
						: "This avatar uses the configuration's resolved image fields, with participant image defaults applied after resolution."
				}
				returnTo={returnTo}
				state={configuration}
				title="Image inference configuration"
			/>
			<section className="section">
				<div className="section-head">
					<h2>Image Generation</h2>
					<button
						className="btn ghost compact"
						disabled={
							saving ||
							!configurationFields ||
							!(avatarSettingsOverridden(editableFields, configurationFields) ||
								avatarSettingsChanged(editableFields, settingsDrafts, configurationFields))
						}
						onClick={() => void resetSettings()}
						type="button"
					>
						Reset
					</button>
				</div>
				{generationSettingsError && <div className="runtime-message error">{generationSettingsError}</div>}
				{configurationFields ? (
					<>
						<AvatarImageBasicFields
							drafts={settingsDrafts}
							effectiveModel={effectiveModel}
							fields={configurationFields}
							models={models}
							modelsError={modelsQuery.error}
							onDraftChange={(field, draft) => setSettingsDrafts((current) => ({ ...current, [field]: draft }))}
						/>
						<details className="advanced-panel">
							<summary>
								<span className="advanced-panel-summary">
									<span className="advanced-panel-chevron">
										<svg fill="none" height={14} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} viewBox="0 0 24 24" width={14}>
											<path d="m9 6 6 6-6 6" />
										</svg>
									</span>
									<span>Advanced generation parameters</span>
								</span>
							</summary>
							<div className="advanced-panel-body">
								<AvatarImageAdvancedFields
									drafts={settingsDrafts}
									effectiveModel={effectiveModel}
									fields={configurationFields}
									onDraftChange={(field, draft) => setSettingsDrafts((current) => ({ ...current, [field]: draft }))}
								/>
							</div>
						</details>
						{target.generation.editablePromptFillSettings && (
							<details className="advanced-panel">
								<summary>
									<span className="advanced-panel-summary">
										<span className="advanced-panel-chevron">
											<svg fill="none" height={14} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} viewBox="0 0 24 24" width={14}>
												<path d="m9 6 6 6-6 6" />
											</svg>
										</span>
										<span>Prompt fill inference</span>
									</span>
								</summary>
								<div className="advanced-panel-body">
									<AvatarPromptFillFields
										drafts={settingsDrafts}
										fields={configurationFields}
										onDraftChange={(field, draft) => setSettingsDrafts((current) => ({ ...current, [field]: draft }))}
									/>
								</div>
							</details>
						)}
					</>
				) : configuration.loading ? (
					<div className="empty compact-empty">Loading image generation settings...</div>
				) : null}
				{!model && !configuration.loading && (
					<div className="runtime-message">
						Choose an image model before generating an avatar.
					</div>
				)}
				<div className="field avatar-prompt-field">
					<div className="avatar-prompt-head">
						<label htmlFor={target.uiText.promptId}>Prompt</label>
						<div className="avatar-prompt-actions">
							{target.generation.promptFillOptions.map((option) => {
								const available = promptFillAvailable(option.mode);
								const active = activePromptFill === option.mode;
								if (!option.visibleWhenUnavailable && !available && !active) {
									return null;
								}
								return (
									<button
										className={`btn compact ${active ? "danger" : "ghost"}`}
										disabled={active ? false : generating || promptFillActive || !available}
										key={option.mode}
										onClick={() => (active ? abortPromptFill() : void fillPrompt(option.mode))}
										title={option.requirement === "members" ? membersPrompt?.title : undefined}
										type="button"
									>
										{active ? "Abort" : option.idleLabel}
									</button>
								);
							})}
						</div>
					</div>
					<textarea
						className="textarea avatar-prompt"
						id={target.uiText.promptId}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder={includeCurrentAvatar ? "Optional when current avatar is included" : "Describe the avatar to generate"}
						rows={5}
						value={prompt}
					/>
				</div>
				{error && <div className="runtime-message error">{error}</div>}
				{message && <div className="runtime-message">{message}</div>}
			</section>
			<section className="avatar-compare">
				<div className="avatar-pane">
					<div className="avatar-pane-head">
						<span>Current avatar</span>
						<label className="checkbox-line">
							<input checked={includeCurrentAvatar} disabled={!currentAvatarAvailable || !selectedSupportsImageInput} onChange={(event) => setIncludeCurrentAvatar(event.target.checked)} type="checkbox" />
							<span>Use as input</span>
						</label>
					</div>
					<button className="avatar-large-preview" disabled={!target.owner.avatarUrl || currentAvatarFailed} onClick={() => target.owner.avatarUrl && !currentAvatarFailed ? setLightboxUrl(target.owner.avatarUrl) : undefined} type="button">
						{target.owner.avatarUrl && !currentAvatarFailed ?
							<FallbackImage
								alt=""
								fallbackSrc={target.owner.avatarUrl}
								onFinalError={() => setCurrentAvatarFailed(true)}
								src={avatarPreviewUrl(target.owner.avatar ?? target.owner.avatarUrl)}
							/>
						:	fallbackAvatar}
					</button>
				</div>
				<div className="avatar-pane generated">
					<div className="avatar-pane-head">
						<span className="avatar-pane-title">
							<span>Generated avatar</span>
							{candidateCost !== null && <span className="avatar-generation-cost">{formatTokenCost(candidateCost)}</span>}
							{candidate && <span className="unsaved-tag">unsaved</span>}
						</span>
						<button className={`btn compact generate-avatar-btn ${generating ? "danger" : "primary"}`} disabled={generating ? false : !canGenerate} onClick={() => generating ? abortGeneration() : void generate()} type="button">
							{generating ? "Abort" : "Generate"}
						</button>
					</div>
					<div className={`avatar-large-preview ${generating ? "busy" : ""}`}>
						{candidate ?
							<button className="avatar-preview-click" onClick={() => setLightboxUrl(candidate.url)} type="button">
								<FallbackImage alt="" fallbackSrc={candidate.url} src={avatarPreviewUrl(candidate)} />
							</button>
						:	<span className="empty-generated">{generating ? "Generating..." : "No image generated"}</span>
						}
						{generating && <span className="avatar-spinner" />}
					</div>
				</div>
			</section>
			<AvatarGenerationChatLog entries={chatEntries} />
			<ImageLightbox onClose={() => setLightboxUrl(null)} title={localizedTextString(target.owner.displayName)} url={lightboxUrl} />
		</div>
	);
}
