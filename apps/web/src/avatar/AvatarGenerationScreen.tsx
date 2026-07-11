import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	localizedTextString,
	type AvatarImage,
	type BotInferenceSettings,
	type BotInferenceSettingsInput,
	type BotSummary,
	type LanguageTag,
} from "@bickr/shared/model";

import { api, apiResponseErrorMessage } from "../api";
import {
	applyAvatarGenerationStreamEvent,
	readAvatarGenerationEventStream,
	type AvatarGenerationChatEntry,
} from "../avatar-generation-stream";
import { avatarPreviewUrl } from "../avatar-image-urls";
import { normalizeReadableText } from "../reasoning-formatting";
import { FallbackImage, ImageLightbox } from "../ui";
import { runApiAction, useApiQuery } from "../use-api";
import type { AvatarPromptFillMode, AvatarTarget, AvatarTextPromptFillMode } from "./target";

export type OpenRouterImageModel = {
	id: string;
	inputModalities: string[];
	name: string;
	outputModalities: string[];
};

export type AvatarGenerationDraftAdapter<TDraft> = {
	configError(draft: TDraft): string;
	fromSettings(settings: BotInferenceSettings): TDraft;
	imageGenerationInput(draft: TDraft, prompt: string, language: LanguageTag | null): BotInferenceSettingsInput["imageGeneration"];
	model(draft: TDraft): string;
	providerRoutingError(draft: TDraft): string;
	renderAdvancedFields(draft: TDraft, onChange: (draft: TDraft) => void): ReactNode;
	renderBasicFields(draft: TDraft, models: OpenRouterImageModel[], onChange: (draft: TDraft) => void): ReactNode;
	withPrompt(draft: TDraft, prompt: string): TDraft;
};

type PromptFillSettingsModalProps = {
	error: string;
	initialSettings: BotInferenceSettings | null;
	loading: boolean;
	mode: AvatarTextPromptFillMode | null;
	onClose: () => void;
	onGenerate: (settings: BotInferenceSettingsInput) => void;
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

export function AvatarGenerationScreen<TDraft, TMutationResponse, TSaved>({
	adapter,
	breadcrumb,
	fallbackAvatar,
	membersPrompt,
	onBack,
	onDiscardSettings,
	onSaveSettings,
	onSaved,
	renderPromptFillSettingsModal,
	target,
}: {
	adapter: AvatarGenerationDraftAdapter<TDraft>;
	breadcrumb: ReactNode;
	fallbackAvatar: ReactNode;
	membersPrompt?: { available: boolean; title: string };
	onBack: () => void;
	onDiscardSettings: () => Promise<boolean>;
	// Settings-only saves go to the entity PATCH endpoints, which validate
	// localized text against the language carried in the same request body —
	// these saves carry none, so localized fields must be stamped null. Only
	// the generation/apply payloads (validated by the avatar endpoints against
	// the entity's effective language chain) use target.owner.language.
	onSaveSettings: (draft: TDraft, language: LanguageTag | null) => Promise<boolean>;
	onSaved: (saved: TSaved, affectedBots?: BotSummary[]) => void;
	renderPromptFillSettingsModal?: (props: PromptFillSettingsModalProps) => ReactNode;
	target: AvatarTarget<TMutationResponse, TSaved>;
}) {
	const initialSettings = target.generation.defaultSettings;
	const [draft, setDraft] = useState<TDraft>(() => adapter.fromSettings(initialSettings));
	const modelsQuery = useApiQuery<{ models: OpenRouterImageModel[] }>("/api/openrouter/image-models", []);
	const promptSettingsQuery = useApiQuery<{ settings: BotInferenceSettings }>(
		target.endpoints.promptSettings,
		[target.endpoints.promptSettings],
	);
	const models = modelsQuery.data?.models ?? [];
	const [prompt, setPrompt] = useState(localizedTextString(initialSettings.imageGeneration?.prompt));
	const [includeCurrentAvatar, setIncludeCurrentAvatar] = useState(Boolean(target.owner.avatarUrl));
	const [candidate, setCandidate] = useState<AvatarImage | null>(null);
	const [chatEntries, setChatEntries] = useState<AvatarGenerationChatEntry[]>([]);
	const [generating, setGenerating] = useState(false);
	const [activePromptFill, setActivePromptFill] = useState<AvatarPromptFillMode | null>(null);
	const [pendingPromptFill, setPendingPromptFill] = useState<AvatarTextPromptFillMode | null>(null);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
	const [currentAvatarFailed, setCurrentAvatarFailed] = useState(false);
	const generationAbortRef = useRef<AbortController | null>(null);
	const promptFillAbortRef = useRef<AbortController | null>(null);
	const language = target.owner.language;

	useEffect(() => {
		const effectiveSettings = target.generation.defaultSettings;
		setDraft(adapter.fromSettings(effectiveSettings));
		setPrompt(localizedTextString(effectiveSettings.imageGeneration?.prompt));
		setIncludeCurrentAvatar(Boolean(target.owner.avatarUrl));
		setCurrentAvatarFailed(false);
		setCandidate(null);
		setChatEntries([]);
		setMessage("");
		setError("");
	}, [adapter, target.generation.settingsKey, target.owner.avatarUrl, target.owner.key]);

	useEffect(() => {
		return () => {
			generationAbortRef.current?.abort();
			promptFillAbortRef.current?.abort();
		};
	}, []);

	const selectedModel = models.find((model) => model.id === adapter.model(draft));
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

	const model = adapter.model(draft);
	const promptAllowed = prompt.trim().length > 0 || (includeCurrentAvatar && currentAvatarAvailable);
	const imageProviderRoutingError = adapter.providerRoutingError(draft);
	const imageConfigError = adapter.configError(draft);
	const generationSettingsError = modelsQuery.error || imageProviderRoutingError || imageConfigError;
	const candidateCost = generatedAvatarCost(candidate);
	const promptFillActive = activePromptFill !== null;
	const currentAvatarPromptFillAvailable = Boolean(
		!prompt.trim() &&
		currentAvatarAvailable &&
		model.trim() &&
		selectedSupportsImageInput &&
		selectedSupportsTextOutput &&
		!imageProviderRoutingError &&
		!imageConfigError,
	);
	const canGenerate = Boolean(model.trim()) &&
		promptAllowed &&
		!imageProviderRoutingError &&
		!imageConfigError &&
		!generating &&
		!promptFillActive;

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

	async function fillPrompt(mode: AvatarPromptFillMode, promptSettings?: BotInferenceSettingsInput): Promise<void> {
		const controller = new AbortController();
		promptFillAbortRef.current = controller;
		setActivePromptFill(mode);
		setPendingPromptFill(null);
		setChatEntries([]);
		setError("");
		setMessage("");
		let streamError = "";
		let finalPrompt = "";
		try {
			const textMode = mode === "persona" || mode === "description" || mode === "members";
			const body = {
				mode,
				...(textMode && prompt.trim() ? { prefill: prompt } : {}),
				...(textMode && promptSettings ? { settings: promptSettings } : {}),
				...(mode === "current_avatar" ? { settings: adapter.imageGenerationInput(draft, prompt, language) } : {}),
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
			const response = await fetch(target.endpoints.generate, {
				method: "POST",
				headers: { accept: "text/event-stream", "content-type": "application/json" },
				body: JSON.stringify({
					prompt,
					includeCurrentAvatar,
					settings: adapter.imageGenerationInput(draft, prompt, language),
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

	async function save(): Promise<void> {
		setSaving(true);
		setError("");
		setMessage("");
		try {
			if (candidate) {
				const promptToSave = candidate.source?.type === "generated" && candidate.source.prompt ? candidate.source.prompt : prompt;
				const result = await runApiAction(throwApiError, () => api<TMutationResponse>(target.endpoints.apply, {
					method: "POST",
					body: {
						candidate,
						settings: adapter.imageGenerationInput(draft, promptToSave, language),
					},
				}));
				const saved = target.readSaved(result.data);
				onSaved(saved.saved, saved.affectedBots);
				setCandidate(null);
				setMessage("Avatar saved.");
			} else {
				const ok = await onSaveSettings(adapter.withPrompt(draft, prompt), null);
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

	async function discard(): Promise<void> {
		const ok = await onDiscardSettings();
		if (ok) {
			const effectiveSettings = target.generation.resetSettings;
			setDraft(adapter.fromSettings(effectiveSettings));
			setPrompt(localizedTextString(effectiveSettings.imageGeneration?.prompt));
			setMessage(target.uiText.discardedSettings);
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
					<button className="btn primary" disabled={saving || Boolean(imageProviderRoutingError) || Boolean(imageConfigError) || (!candidate && !model.trim())} onClick={() => void save()} type="button">
						{saving ? "Saving..." : "Save"}
					</button>
				</div>
			</div>
			<section className="section">
				<div className="section-head">
					<h2>Image Generation</h2>
					<button className="btn ghost compact" disabled={saving || !target.generation.hasOwnSettings} onClick={() => void discard()} type="button">Reset</button>
				</div>
				{generationSettingsError && <div className="runtime-message error">{generationSettingsError}</div>}
				{adapter.renderBasicFields(draft, models, setDraft)}
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
					<div className="advanced-panel-body">{adapter.renderAdvancedFields(draft, setDraft)}</div>
				</details>
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
										onClick={() => {
											if (active) {
												abortPromptFill();
											} else if (option.settingsDialog) {
												setPendingPromptFill(option.mode);
											} else {
												void fillPrompt(option.mode);
											}
										}}
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
			{renderPromptFillSettingsModal?.({
				error: promptSettingsQuery.error,
				initialSettings: promptSettingsQuery.data?.settings ?? null,
				loading: promptSettingsQuery.loading,
				mode: pendingPromptFill,
				onClose: () => setPendingPromptFill(null),
				onGenerate: (settings) => pendingPromptFill ? void fillPrompt(pendingPromptFill, settings) : undefined,
			})}
			<ImageLightbox onClose={() => setLightboxUrl(null)} title={localizedTextString(target.owner.displayName)} url={lightboxUrl} />
		</div>
	);
}
