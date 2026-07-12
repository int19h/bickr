import {
	defaultProviderModel,
	defaultTextGenerationTemperature,
	defaultTranslationPrompt,
	openRouterSuggestedImageAspectRatios,
	openRouterSuggestedImageSizes,
	type BotCompactionMode,
	type BotInferenceSettings,
	type BotInferenceSettingsInput,
	type BotPromptCacheMode,
} from "@bickr/shared/model";
import { useEffect, useId, useMemo, useState } from "react";
import type {
	AvatarGenerationDraftAdapter,
	OpenRouterImageModel,
} from "../avatar/AvatarGenerationScreen";
import type { AvatarTextPromptFillMode } from "../avatar/target";
import {
	effectiveNumberPlaceholder,
	effectiveOptionalNumberPlaceholder,
	providerRoutingPlaceholderForInheritance,
	rebaseInferenceDraftForFallbackChange,
} from "../screens/bots";
import {
	effectiveInferenceDraftBaseUrl,
	effectiveInferenceDraftModel,
	inferenceCapabilityContext,
	inferenceCapabilityContextForDraft,
	inferenceFallbackContextForDraft,
	providerRoutingDraftError,
} from "../settings-drafts/common";
import { imageGenerationInputFromDraft } from "../settings-drafts/image-generation-draft";
import {
	inferenceDraftFromSettings,
	normalizeInferenceDraftForCapabilities,
	promptFillSettingsInputFromDraft,
	type InferenceDraft,
} from "../settings-drafts/inference-draft";
import { normalizeTranslationDraftForCapabilities } from "../settings-drafts/translation-draft";
import {
	type BotToolDraft,
	type OpenRouterDatetimeToolDraft,
	type OpenRouterWebFetchToolDraft,
	type OpenRouterWebSearchToolDraft,
} from "../tool-settings-draft";
import { Field, Modal } from "../ui";
import { useApiQuery } from "../use-api";

export const avatarGenerationDraftAdapter: AvatarGenerationDraftAdapter<InferenceDraft> = {
	configError: imageGenerationConfigDraftError,
	fromSettings: inferenceDraftFromSettings,
	imageGenerationInput: imageGenerationInputFromDraft,
	model: (draft) => draft.imageGenerationModel,
	providerRoutingError: (draft) => providerRoutingDraftError(draft.imageGenerationProviderRouting),
	renderAdvancedFields: (draft, onChange) => <ImageGenerationAdvancedFields draft={draft} onChange={onChange} />,
	renderBasicFields: (draft, models, onChange) => <ImageGenerationBasicFields draft={draft} models={models} onChange={onChange} />,
	withPrompt: (draft, prompt) => ({ ...draft, imageGenerationPrompt: prompt }),
};

export function WorldAvatarPromptFillSettingsModal({
	error,
	initialSettings,
	loading,
	mode,
	modelSuggestions,
	onClose,
	onGenerate,
}: {
	error: string;
	initialSettings: BotInferenceSettings | null;
	loading: boolean;
	mode: AvatarTextPromptFillMode | null;
	modelSuggestions: string[];
	onClose: () => void;
	onGenerate: (settings: BotInferenceSettingsInput) => void;
}) {
	const [draft, setDraft] = useState<InferenceDraft>(() => inferenceDraftFromSettings(initialSettings ?? {}));
	const modelListId = useId();
	const open = mode !== null;
	const title = mode === "members" ? "Fill from members" : "Fill from description";
	const routingError = providerRoutingDraftError(draft.providerRouting);
	const canGenerate = Boolean(initialSettings && !loading && !routingError && draft.model.trim());
	const capabilityContext = inferenceCapabilityContextForDraft(draft);
	const modelOptions = useMemo(
		() => Array.from(new Set([defaultProviderModel, ...modelSuggestions, draft.model.trim()].filter(Boolean))),
		[draft.model, modelSuggestions],
	);

	useEffect(() => {
		if (open && initialSettings) {
			setDraft(inferenceDraftFromSettings(initialSettings));
		}
	}, [initialSettings, open]);

	function patch(update: Partial<InferenceDraft>): void {
		setDraft((current) => normalizeInferenceDraftForCapabilities({ ...current, ...update }));
	}

	function submit(): void {
		if (!canGenerate) {
			return;
		}
		onGenerate(promptFillSettingsInputFromDraft(draft));
	}

	return (
		<Modal
			className="avatar-prompt-settings-modal"
			foot={
				<>
					<span />
					<div className="right">
						<button className="btn ghost" onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!canGenerate} onClick={submit} type="button">
							Generate
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title={title}
			wide
		>
			{loading && <div className="runtime-message">Loading generation parameters...</div>}
			{error && <div className="runtime-message error">{error}</div>}
			{initialSettings && (
				<div className="field-stack">
					<div className="inference-row two">
						<Field label="Model">
							<input
								className="input"
								list={modelOptions.length > 0 ? modelListId : undefined}
								onChange={(event) => patch({ model: event.target.value })}
								value={draft.model}
							/>
							{modelOptions.length > 0 && (
								<datalist id={modelListId}>
									{modelOptions.map((model) => (
										<option key={model} value={model} />
									))}
								</datalist>
							)}
						</Field>
						<Field label="Base URL">
							<input
								className="input"
								onChange={(event) => patch({ baseUrl: event.target.value })}
								value={draft.baseUrl}
							/>
						</Field>
					</div>
					<div className="inference-row two">
						<Field label="Reasoning">
							<select
								className="input reasoning-select"
								onChange={(event) => patch({ reasoningEffort: event.target.value })}
								value={draft.reasoningEffort}
							>
								{reasoningEffortOptions.map((option) => (
									<option disabled={option.value === "none" && !capabilityContext.supportsReasoningNone} key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</Field>
						<Field label="Temperature">
							<input
								className="input"
								max="2"
								min="0"
								onChange={(event) => patch({ temperature: event.target.value })}
								step="0.05"
								type="number"
								value={draft.temperature}
							/>
						</Field>
					</div>
					<div className="inference-row three">
						<Field label="Top K">
							<input className="input" min="0" onChange={(event) => patch({ topK: event.target.value })} step="1" type="number" value={draft.topK} />
						</Field>
						<Field label="Top P">
							<input className="input" max="1" min="0" onChange={(event) => patch({ topP: event.target.value })} step="0.01" type="number" value={draft.topP} />
						</Field>
						<Field label="Min P">
							<input className="input" max="1" min="0" onChange={(event) => patch({ minP: event.target.value })} step="0.01" type="number" value={draft.minP} />
						</Field>
					</div>
					<div className="inference-row three">
						<Field label="Frequency penalty">
							<input className="input" max="2" min="-2" onChange={(event) => patch({ frequencyPenalty: event.target.value })} step="0.05" type="number" value={draft.frequencyPenalty} />
						</Field>
						<Field label="Presence penalty">
							<input className="input" max="2" min="-2" onChange={(event) => patch({ presencePenalty: event.target.value })} step="0.05" type="number" value={draft.presencePenalty} />
						</Field>
						<Field label="Repetition penalty">
							<input className="input" max="2" min="0" onChange={(event) => patch({ repetitionPenalty: event.target.value })} step="0.05" type="number" value={draft.repetitionPenalty} />
						</Field>
					</div>
					<ProviderRoutingField onChange={(providerRouting) => patch({ providerRouting })} value={draft.providerRouting} />
				</div>
			)}
		</Modal>
	);
}

export function InferenceProviderFields({
	draft,
	inheritedSettings,
	onChange,
	scope,
}: {
	draft: InferenceDraft;
	inheritedSettings?: BotInferenceSettings | null;
	onChange: (draft: InferenceDraft) => void;
	scope: "bot" | "profile";
}) {
	function patch(update: Partial<InferenceDraft>): void {
		onChange({ ...draft, ...update });
	}
	const baseUrlPlaceholder = effectiveInferenceDraftBaseUrl(draft, inheritedSettings);

	return (
		<div className="field-stack">
			<Field
				help={
					draft.openRouterApiKeySet ?
						"Leave blank to keep the saved key. Use Clear saved key to remove it."
					:	"Stored privately in your Bickr data and used for OpenRouter inference."
				}
				hint={draft.openRouterApiKeySet ? "saved" : undefined}
				label="OpenRouter API key"
			>
				<div className="inline-form">
					<input
						autoComplete="off"
						className="input"
						onChange={(event) =>
							patch({
								openRouterApiKey: event.target.value,
								clearOpenRouterApiKey: false,
							})
						}
						placeholder={draft.openRouterApiKeySet ? "Saved key unchanged" : "sk-or-..."}
						type="password"
						value={draft.openRouterApiKey}
					/>
					<button
						className="btn ghost"
						disabled={!draft.openRouterApiKeySet && !draft.openRouterApiKey}
						onClick={() =>
							patch({
								openRouterApiKey: "",
								openRouterApiKeySet: false,
								clearOpenRouterApiKey: true,
							})
						}
						type="button"
					>
						Clear saved key
					</button>
				</div>
				{draft.clearOpenRouterApiKey && <div className="help">The saved key will be removed on save.</div>}
			</Field>
			<Field help={scope === "bot" ? "Blank inherits the profile or OpenRouter default URL." : "Blank uses OpenRouter's default URL."} label="Base URL">
				<input
					className="input"
					onChange={(event) => patch({ baseUrl: event.target.value })}
					placeholder={baseUrlPlaceholder}
					value={draft.baseUrl}
				/>
			</Field>
		</div>
	);
}

export function AgenticLoopInferenceFields({
	draft,
	inheritedSettings,
	modelSuggestions = [],
	onChange,
	scope,
}: {
	draft: InferenceDraft;
	inheritedSettings?: BotInferenceSettings | null;
	modelSuggestions?: string[];
	onChange: (draft: InferenceDraft) => void;
	scope: "bot" | "profile";
}) {
	const modelListId = useId();
	const fallbackContext = inferenceFallbackContextForDraft(draft, inheritedSettings);
	const modelPlaceholder = effectiveInferenceDraftModel(draft, fallbackContext);
	const temperaturePlaceholder = effectiveNumberPlaceholder(fallbackContext?.temperature, defaultTextGenerationTemperature);
	const topKPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.topK);
	const topPPlaceholder = effectiveNumberPlaceholder(fallbackContext?.topP, 1);
	const minPPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.minP);
	const frequencyPenaltyPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.frequencyPenalty);
	const presencePenaltyPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.presencePenalty);
	const repetitionPenaltyPlaceholder = effectiveOptionalNumberPlaceholder(fallbackContext?.repetitionPenalty);
	const capabilityContext = inferenceCapabilityContextForDraft(draft, inheritedSettings);
	function patch(update: Partial<InferenceDraft>): void {
		const updated = { ...draft, ...update };
		const rebased = rebaseInferenceDraftForFallbackChange(
			draft,
			updated,
			fallbackContext,
			inferenceFallbackContextForDraft(updated, inheritedSettings),
		);
		onChange(normalizeInferenceDraftForCapabilities(rebased, inheritedSettings));
	}

	return (
		<div className="field-stack">
			<div className="inference-row model-reasoning-row">
				<Field
					help={
						scope === "bot" ?
							"Blank inherits the linked source, profile, or environment model."
						:	"Blank uses the environment model."
					}
					label="Model"
				>
					<input
						className="input"
						list={modelSuggestions.length > 0 ? modelListId : undefined}
						onChange={(event) => patch({ model: event.target.value })}
						placeholder={modelPlaceholder}
						value={draft.model}
					/>
					{modelSuggestions.length > 0 && (
						<datalist id={modelListId}>
							{modelSuggestions.map((model) => (
								<option key={model} value={model} />
							))}
						</datalist>
					)}
				</Field>
				<Field label="Reasoning">
					<select
						className="input reasoning-select"
						onChange={(event) => patch({ reasoningEffort: event.target.value })}
						value={draft.reasoningEffort}
					>
						{reasoningEffortOptions.map((option) => (
							<option disabled={option.value === "none" && !capabilityContext.supportsReasoningNone} key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
				<Field label="Tool calls">
					<select
						className="input reasoning-select"
						onChange={(event) => patch({ toolCalls: event.target.value })}
						value={draft.toolCalls}
					>
						{toolCallOptions.map((option) => (
							<option disabled={option.value === "require" && !capabilityContext.supportsRequiredToolCalls} key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
			</div>
			<div className="inference-row three">
				<Field className="checkbox-help-field" help="Turn off for providers that reject tool-enabled requests ending with participant narration.">
					<label className="checkbox-line">
						<input
							checked={draft.supportsPrefill}
							disabled={!capabilityContext.supportsPrefill}
							onChange={(event) => patch({ supportsPrefill: event.target.checked })}
							type="checkbox"
						/>
						<span>Supports prefill</span>
					</label>
				</Field>
				<Field help="How context compaction asks for the memory summary." label="Compaction mode">
					<select
						className="input reasoning-select"
						onChange={(event) => patch({ compactionMode: event.target.value as BotCompactionMode })}
						value={draft.compactionMode}
					>
						{compactionModeOptions.map((option) => (
							<option disabled={option.value === "structured_output" && !capabilityContext.supportsStructuredCompaction} key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
				<Field help="OpenRouter prompt caching for Claude loop requests. Writes cost more than normal input tokens." label="Prompt cache">
					<select
						className="input"
						onChange={(event) => patch({ promptCacheMode: event.target.value as BotPromptCacheMode })}
						value={draft.promptCacheMode}
					>
						{promptCacheModeOptions.map((option) => (
							<option disabled={option.value !== "off" && !capabilityContext.supportsPromptCacheControl} key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
			</div>
			<div className="inference-row four">
				<Field label="Temperature">
					<input
						className="input"
						max="2"
						min="0"
						onChange={(event) => patch({ temperature: event.target.value })}
						placeholder={temperaturePlaceholder}
						step="0.05"
						type="number"
						value={draft.temperature}
					/>
				</Field>
				<Field label="Top K">
					<input
						className="input"
						min="0"
						onChange={(event) => patch({ topK: event.target.value })}
						placeholder={topKPlaceholder}
						step="1"
						type="number"
						value={draft.topK}
					/>
				</Field>
				<Field label="Top P">
					<input
						className="input"
						max="1"
						min="0"
						onChange={(event) => patch({ topP: event.target.value })}
						placeholder={topPPlaceholder}
						step="0.01"
						type="number"
						value={draft.topP}
					/>
				</Field>
				<Field label="Min P">
					<input
						className="input"
						max="1"
						min="0"
						onChange={(event) => patch({ minP: event.target.value })}
						placeholder={minPPlaceholder}
						step="0.01"
						type="number"
						value={draft.minP}
					/>
				</Field>
			</div>
			<div className="inference-row three">
				<Field label="Frequency penalty">
					<input
						className="input"
						max="2"
						min="-2"
						onChange={(event) => patch({ frequencyPenalty: event.target.value })}
						placeholder={frequencyPenaltyPlaceholder}
						step="0.05"
						type="number"
						value={draft.frequencyPenalty}
					/>
				</Field>
				<Field label="Presence penalty">
					<input
						className="input"
						max="2"
						min="-2"
						onChange={(event) => patch({ presencePenalty: event.target.value })}
						placeholder={presencePenaltyPlaceholder}
						step="0.05"
						type="number"
						value={draft.presencePenalty}
					/>
				</Field>
				<Field label="Repetition penalty">
					<input
						className="input"
						max="2"
						min="0"
						onChange={(event) => patch({ repetitionPenalty: event.target.value })}
						placeholder={repetitionPenaltyPlaceholder}
						step="0.05"
						type="number"
						value={draft.repetitionPenalty}
					/>
				</Field>
			</div>
			<ProviderRoutingField
				onChange={(providerRouting) => patch({ providerRouting })}
				placeholder={providerRoutingPlaceholderForInheritance(fallbackContext)}
				value={draft.providerRouting}
			/>
		</div>
	);
}

const openRouterProviderRoutingDocsUrl = "https://openrouter.ai/docs/guides/routing/provider-selection";

const openRouterImageGenerationDocsUrl = "https://openrouter.ai/docs/guides/overview/multimodal/image-generation#aspect-ratio";

export const providerRoutingPlaceholder = "{\n\n}";

const reasoningEffortOptions = [
	{ value: "default", label: "Default" },
	{ value: "none", label: "None" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "XHigh" },
] as const;

const imageAspectRatioLabels: Record<string, string> = {
	"1:1": "1:1 - square, 1024x1024",
	"2:3": "2:3 - portrait, 832x1248",
	"3:2": "3:2 - landscape, 1248x832",
	"3:4": "3:4 - portrait, 864x1184",
	"4:3": "4:3 - landscape, 1184x864",
	"4:5": "4:5 - portrait, 896x1152",
	"5:4": "5:4 - landscape, 1152x896",
	"9:16": "9:16 - vertical, 768x1344",
	"16:9": "16:9 - wide, 1344x768",
	"21:9": "21:9 - ultrawide, 1536x672",
	"1:4": "1:4 - extended tall",
	"4:1": "4:1 - extended wide",
	"1:8": "1:8 - extended extra tall",
	"8:1": "8:1 - extended extra wide",
	"2:1": "2:1 - banner",
	"1:2": "1:2 - tall banner",
	"19.5:9": "19.5:9 - phone wide",
	"9:19.5": "9:19.5 - phone vertical",
	"20:9": "20:9 - ultrawide phone",
	"9:20": "9:20 - ultra-tall phone",
	auto: "Auto - Grok chooses",
};

const imageSizeLabels: Record<string, string> = {
	"0.5K": "0.5K - lower resolution",
	"1K": "1K - standard",
	"2K": "2K - higher resolution",
	"4K": "4K - highest resolution",
	"1024x1024": "Square (1024x1024)",
	"1024x1536": "Portrait (1024x1536)",
	"1536x1024": "Landscape (1536x1024)",
	"2560x1440": "2K (2560x1440)",
	"3840x2160": "4K (3840x2160)",
};

function imageAspectRatioLabel(value: string): string {
	return imageAspectRatioLabels[value] ?? value;
}

function imageSizeLabel(value: string): string {
	return imageSizeLabels[value] ?? value;
}

function ImageConfigHelp({ text }: { text: string }) {
	return (
		<>
			{text}{" "}
			<a href={openRouterImageGenerationDocsUrl} rel="noreferrer" target="_blank">
				Docs
			</a>
			.
		</>
	);
}

function imageGenerationConfigDraftError(draft: InferenceDraft): string {
	const aspectRatio = draft.imageGenerationAspectRatio.trim();
	const imageSize = draft.imageGenerationImageSize.trim();
	if (aspectRatio.length > 40) {
		return "Image generation aspect ratio must be 40 characters or fewer.";
	}
	if (imageSize.length > 40) {
		return "Image generation size must be 40 characters or fewer.";
	}
	return "";
}

const toolCallOptions = [
	{ value: "require", label: "Require" },
	{ value: "railroad", label: "Railroad" },
	{ value: "at_will", label: "At will" },
] as const;

const compactionModeOptions = [
	{ value: "structured_output", label: "Structured output" },
	{ value: "tool_call", label: "Tool call" },
	{ value: "tool_call_cache_friendly", label: "Tool call (cache-friendly)" },
] as const satisfies readonly { value: BotCompactionMode; label: string }[];

const promptCacheModeOptions = [
	{ value: "off", label: "Off" },
	{ value: "openrouter_anthropic_5m", label: "Claude 5m (1.25x write)" },
	{ value: "openrouter_anthropic_1h", label: "Claude 1h (2x write)" },
] as const satisfies readonly { value: BotPromptCacheMode; label: string }[];

const structuredToolCallOptions = toolCallOptions.filter((option) => option.value !== "at_will");

function ProviderRoutingField({
	onChange,
	placeholder = providerRoutingPlaceholder,
	value,
}: {
	onChange: (value: string) => void;
	placeholder?: string;
	value: string;
}) {
	const error = providerRoutingDraftError(value);
	return (
		<div className="provider-routing-field">
			<Field label="Provider routing">
				<textarea
					className={`textarea provider-routing-editor ${error ? "invalid" : ""}`}
					onChange={(event) => onChange(event.target.value)}
					placeholder={placeholder}
					rows={7}
					spellCheck={false}
					value={value}
				/>
				{error ?
					<div className="runtime-message error">{error}</div>
				:	<div className="help">
						Sent as OpenRouter's <code>provider</code> request-body object. See{" "}
						<a href={openRouterProviderRoutingDocsUrl} rel="noreferrer" target="_blank">
							OpenRouter provider routing docs
						</a>
						.
					</div>
					}
				</Field>
		</div>
	);
}

export function ImageGenerationInferenceFields({
	draft,
	models,
	onChange,
}: {
	draft: InferenceDraft;
	models?: OpenRouterImageModel[];
	onChange: (draft: InferenceDraft) => void;
}) {
	return (
		<div className="field-stack">
			<ImageGenerationBasicFields draft={draft} models={models} onChange={onChange} />
			<ImageGenerationAdvancedFields draft={draft} onChange={onChange} />
		</div>
	);
}

function ImageGenerationBasicFields({
	draft,
	models,
	onChange,
}: {
	draft: InferenceDraft;
	models?: OpenRouterImageModel[];
	onChange: (draft: InferenceDraft) => void;
}) {
	const loadedModelsQuery = useApiQuery<{ models: OpenRouterImageModel[] }>(
		models ? null : "/api/openrouter/image-models",
		[models],
	);
	const loadedModels = models ?? loadedModelsQuery.data?.models ?? [];
	const loadError = models ? "" : loadedModelsQuery.error;
	function patch(update: Partial<InferenceDraft>): void {
		onChange({ ...draft, ...update });
	}
	function patchModel(model: string): void {
		patch({ imageGenerationModel: model });
	}
	const modelSelected = draft.imageGenerationModel.trim().length > 0;
	const aspectRatioListId = useId();
	const imageSizeListId = useId();
	const suggestedAspectRatios = openRouterSuggestedImageAspectRatios(draft.imageGenerationModel);
	const suggestedImageSizes = openRouterSuggestedImageSizes(draft.imageGenerationModel);
	return (
		<div className="inference-row three">
			<Field help={loadError || "Only OpenRouter models that advertise image output are listed."} label="Model">
				<select
					className="input"
					onChange={(event) => patchModel(event.target.value)}
					value={draft.imageGenerationModel}
					>
						<option value="">Choose a model</option>
						{loadedModels.map((model) => (
							<option key={model.id} value={model.id}>
								{model.name ? `${model.name} (${model.id})` : model.id}
							</option>
						))}
					</select>
				</Field>
				<Field
					help={<ImageConfigHelp text="OpenRouter uses the selected model's default when this is left blank. Suggested ratios are model-specific; custom values are sent as typed." />}
					label="Aspect ratio"
				>
					<input
						className="input"
						disabled={!modelSelected}
						list={aspectRatioListId}
						onChange={(event) => patch({ imageGenerationAspectRatio: event.target.value })}
						placeholder="Default"
						value={draft.imageGenerationAspectRatio}
					/>
					<datalist id={aspectRatioListId}>
						{suggestedAspectRatios.map((ratio) => (
							<option key={ratio} label={imageAspectRatioLabel(ratio)} value={ratio} />
						))}
					</datalist>
				</Field>
				<Field
					help={<ImageConfigHelp text="OpenRouter uses the selected model's default when this is left blank. Suggested sizes are model-specific; custom values are sent as typed." />}
					label="Image size"
				>
					<input
						className="input"
						disabled={!modelSelected}
						list={imageSizeListId}
						onChange={(event) => patch({ imageGenerationImageSize: event.target.value })}
						placeholder="Default"
						value={draft.imageGenerationImageSize}
					/>
					<datalist id={imageSizeListId}>
						{suggestedImageSizes.map((size) => (
							<option key={size} label={imageSizeLabel(size)} value={size} />
						))}
					</datalist>
				</Field>
			</div>
		);
	}

function ImageGenerationAdvancedFields({
	draft,
	onChange,
}: {
	draft: InferenceDraft;
	onChange: (draft: InferenceDraft) => void;
}) {
	function patch(update: Partial<InferenceDraft>): void {
		onChange({ ...draft, ...update });
	}
	const modelSelected = draft.imageGenerationModel.trim().length > 0;
	return (
		<div className="field-stack">
			<div className="inference-row four">
				<Field label="Temperature">
					<input
						className="input"
						disabled={!modelSelected}
						max="2"
						min="0"
						onChange={(event) => patch({ imageGenerationTemperature: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.imageGenerationTemperature}
					/>
				</Field>
				<Field label="Top K">
					<input
						className="input"
						disabled={!modelSelected}
						min="0"
						onChange={(event) => patch({ imageGenerationTopK: event.target.value })}
						placeholder="default"
						step="1"
						type="number"
						value={draft.imageGenerationTopK}
					/>
				</Field>
				<Field label="Top P">
					<input
						className="input"
						disabled={!modelSelected}
						max="1"
						min="0"
						onChange={(event) => patch({ imageGenerationTopP: event.target.value })}
						placeholder="default"
						step="0.01"
						type="number"
						value={draft.imageGenerationTopP}
					/>
				</Field>
				<Field label="Min P">
					<input
						className="input"
						disabled={!modelSelected}
						max="1"
						min="0"
						onChange={(event) => patch({ imageGenerationMinP: event.target.value })}
						placeholder="default"
						step="0.01"
						type="number"
						value={draft.imageGenerationMinP}
					/>
				</Field>
			</div>
			<div className="inference-row three">
				<Field label="Frequency penalty">
					<input
						className="input"
						disabled={!modelSelected}
						max="2"
						min="-2"
						onChange={(event) => patch({ imageGenerationFrequencyPenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.imageGenerationFrequencyPenalty}
					/>
				</Field>
				<Field label="Presence penalty">
					<input
						className="input"
						disabled={!modelSelected}
						max="2"
						min="-2"
						onChange={(event) => patch({ imageGenerationPresencePenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.imageGenerationPresencePenalty}
					/>
				</Field>
				<Field label="Repetition penalty">
					<input
						className="input"
						disabled={!modelSelected}
						max="2"
						min="0"
						onChange={(event) => patch({ imageGenerationRepetitionPenalty: event.target.value })}
						placeholder="default"
						step="0.05"
						type="number"
						value={draft.imageGenerationRepetitionPenalty}
					/>
				</Field>
			</div>
			<fieldset disabled={!modelSelected}>
				<ProviderRoutingField
					onChange={(imageGenerationProviderRouting) => patch({ imageGenerationProviderRouting })}
					value={draft.imageGenerationProviderRouting}
				/>
			</fieldset>
		</div>
	);
}

export function TranslationInferenceFields({
	draft,
	modelSuggestions = [],
	onChange,
}: {
	draft: InferenceDraft;
	modelSuggestions?: string[];
	onChange: (draft: InferenceDraft) => void;
}) {
	const modelListId = useId();
	const effectiveLoopModel = effectiveInferenceDraftModel(draft);
	const translationModelSet = draft.translationModel.trim().length > 0;
	const translationModel = draft.translationModel.trim() || effectiveLoopModel;
	const translationBaseUrl = effectiveInferenceDraftBaseUrl(draft);
	const capabilityContext = inferenceCapabilityContext(translationModel, translationBaseUrl);
	const controlsDisabled = !translationModelSet;
	function patch(update: Partial<InferenceDraft>): void {
		onChange(normalizeTranslationDraftForCapabilities({ ...draft, ...update }));
	}

	return (
		<div className="field-stack">
			<div className="inference-row translation-enable-row">
				<label className="checkbox-line">
					<input
						checked={draft.translationEnabled}
						onChange={(event) => patch({ translationEnabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Inline translations</span>
				</label>
			</div>
			{draft.translationEnabled && (
				<>
					<Field help="Sent with the source text for each translation request." label="Translation prompt">
						<textarea
							className="textarea"
							onChange={(event) => patch({ translationPrompt: event.target.value })}
							placeholder={defaultTranslationPrompt}
							rows={4}
							value={draft.translationPrompt}
						/>
					</Field>
					<div className="inference-row model-reasoning-row">
						<Field hint={translationModelSet ? undefined : effectiveLoopModel} label="Model">
							<input
								className="input"
								list={modelSuggestions.length > 0 ? modelListId : undefined}
								onChange={(event) => patch({ translationModel: event.target.value })}
								placeholder={effectiveLoopModel}
								value={draft.translationModel}
							/>
							{modelSuggestions.length > 0 && (
								<datalist id={modelListId}>
									{modelSuggestions.map((model) => (
										<option key={model} value={model} />
									))}
								</datalist>
							)}
						</Field>
						<Field label="Reasoning">
							<select
								className="input reasoning-select"
								disabled={controlsDisabled}
								onChange={(event) => patch({ translationReasoningEffort: event.target.value })}
								value={draft.translationReasoningEffort}
							>
								{reasoningEffortOptions.map((option) => (
									<option disabled={option.value === "none" && !capabilityContext.supportsReasoningNone} key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</Field>
						<Field label="Tool calls">
							<select
								className="input reasoning-select"
								disabled={controlsDisabled}
								onChange={(event) => patch({ translationToolCalls: event.target.value })}
								value={draft.translationToolCalls}
							>
								{structuredToolCallOptions.map((option) => (
									<option disabled={option.value === "require" && !capabilityContext.supportsRequiredToolCalls} key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</Field>
					</div>
					<div className="inference-row four">
						<Field label="Temperature">
							<input
								className="input"
								disabled={controlsDisabled}
								max="2"
								min="0"
								onChange={(event) => patch({ translationTemperature: event.target.value })}
								placeholder="0"
								step="0.05"
								type="number"
								value={draft.translationTemperature}
							/>
						</Field>
						<Field label="Top K">
							<input
								className="input"
								disabled={controlsDisabled}
								min="0"
								onChange={(event) => patch({ translationTopK: event.target.value })}
								placeholder="default"
								step="1"
								type="number"
								value={draft.translationTopK}
							/>
						</Field>
						<Field label="Top P">
							<input
								className="input"
								disabled={controlsDisabled}
								max="1"
								min="0"
								onChange={(event) => patch({ translationTopP: event.target.value })}
								placeholder="default"
								step="0.01"
								type="number"
								value={draft.translationTopP}
							/>
						</Field>
						<Field label="Min P">
							<input
								className="input"
								disabled={controlsDisabled}
								max="1"
								min="0"
								onChange={(event) => patch({ translationMinP: event.target.value })}
								placeholder="default"
								step="0.01"
								type="number"
								value={draft.translationMinP}
							/>
						</Field>
					</div>
					<div className="inference-row three">
						<Field label="Frequency penalty">
							<input
								className="input"
								disabled={controlsDisabled}
								max="2"
								min="-2"
								onChange={(event) => patch({ translationFrequencyPenalty: event.target.value })}
								placeholder="default"
								step="0.05"
								type="number"
								value={draft.translationFrequencyPenalty}
							/>
						</Field>
						<Field label="Presence penalty">
							<input
								className="input"
								disabled={controlsDisabled}
								max="2"
								min="-2"
								onChange={(event) => patch({ translationPresencePenalty: event.target.value })}
								placeholder="default"
								step="0.05"
								type="number"
								value={draft.translationPresencePenalty}
							/>
						</Field>
						<Field label="Repetition penalty">
							<input
								className="input"
								disabled={controlsDisabled}
								max="2"
								min="0"
								onChange={(event) => patch({ translationRepetitionPenalty: event.target.value })}
								placeholder="default"
								step="0.05"
								type="number"
								value={draft.translationRepetitionPenalty}
							/>
						</Field>
					</div>
					<fieldset disabled={controlsDisabled}>
						<ProviderRoutingField
							onChange={(translationProviderRouting) => patch({ translationProviderRouting })}
							value={draft.translationProviderRouting}
						/>
					</fieldset>
				</>
			)}
		</div>
	);
}

const webSearchEngineOptions = ["auto", "native", "exa", "firecrawl", "parallel"];

const webFetchEngineOptions = ["auto", "native", "exa", "openrouter", "firecrawl"];

const searchContextSizeOptions = ["low", "medium", "high"];

export function OpenRouterServerToolFields({
	available,
	draft,
	onChange,
}: {
	available: boolean;
	draft: BotToolDraft;
	onChange: (draft: BotToolDraft) => void;
}) {
	function patchOpenRouter(update: Partial<BotToolDraft["openRouter"]>): void {
		onChange({ openRouter: { ...draft.openRouter, ...update } });
	}

	function patchDatetime(update: Partial<OpenRouterDatetimeToolDraft>): void {
		patchOpenRouter({ datetime: { ...draft.openRouter.datetime, ...update } });
	}

	function patchWebSearch(update: Partial<OpenRouterWebSearchToolDraft>): void {
		patchOpenRouter({ webSearch: { ...draft.openRouter.webSearch, ...update } });
	}

	function patchWebFetch(update: Partial<OpenRouterWebFetchToolDraft>): void {
		patchOpenRouter({ webFetch: { ...draft.openRouter.webFetch, ...update } });
	}

	return (
		<div className="field-stack">
			{!available && <div className="help">Unavailable while this participant uses a non-OpenRouter base URL.</div>}
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.datetime.enabled}
						onChange={(event) => patchDatetime({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Datetime</span>
				</label>
				<Field help="IANA timezone name. Blank uses OpenRouter's default." label="Timezone">
					<input
						className="input"
						disabled={!draft.openRouter.datetime.enabled}
						onChange={(event) => patchDatetime({ timezone: event.target.value })}
						placeholder="America/Los_Angeles"
						value={draft.openRouter.datetime.timezone}
					/>
				</Field>
			</fieldset>
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.webSearch.enabled}
						onChange={(event) => patchWebSearch({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Web Search</span>
				</label>
				<div className="field-row">
					<Field label="Engine">
						<select
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ engine: event.target.value })}
							value={draft.openRouter.webSearch.engine}
						>
							<option value="">default</option>
							{webSearchEngineOptions.map((engine) => (
								<option key={engine} value={engine}>
									{engine}
								</option>
							))}
						</select>
					</Field>
					<Field label="Context size">
						<select
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ searchContextSize: event.target.value })}
							value={draft.openRouter.webSearch.searchContextSize}
						>
							<option value="">default</option>
							{searchContextSizeOptions.map((size) => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Max results">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							max={25}
							min={1}
							onChange={(event) => patchWebSearch({ maxResults: event.target.value })}
							placeholder="5"
							type="number"
							value={draft.openRouter.webSearch.maxResults}
						/>
					</Field>
					<Field label="Max total results">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							min={1}
							onChange={(event) => patchWebSearch({ maxTotalResults: event.target.value })}
							placeholder="default"
							type="number"
							value={draft.openRouter.webSearch.maxTotalResults}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Allowed domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ allowedDomains: event.target.value })}
							placeholder="example.com, docs.example.com"
							rows={2}
							value={draft.openRouter.webSearch.allowedDomains}
						/>
					</Field>
					<Field label="Excluded domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ excludedDomains: event.target.value })}
							placeholder="reddit.com"
							rows={2}
							value={draft.openRouter.webSearch.excludedDomains}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Location city">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationCity: event.target.value })}
							placeholder="San Francisco"
							value={draft.openRouter.webSearch.userLocationCity}
						/>
					</Field>
					<Field label="Location region">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationRegion: event.target.value })}
							placeholder="California"
							value={draft.openRouter.webSearch.userLocationRegion}
						/>
					</Field>
				</div>
				<div className="field-row">
					<Field label="Location country">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							maxLength={2}
							onChange={(event) => patchWebSearch({ userLocationCountry: event.target.value })}
							placeholder="US"
							value={draft.openRouter.webSearch.userLocationCountry}
						/>
					</Field>
					<Field label="Location timezone">
						<input
							className="input"
							disabled={!draft.openRouter.webSearch.enabled}
							onChange={(event) => patchWebSearch({ userLocationTimezone: event.target.value })}
							placeholder="America/Los_Angeles"
							value={draft.openRouter.webSearch.userLocationTimezone}
						/>
					</Field>
				</div>
			</fieldset>
			<fieldset className="tool-group" disabled={!available}>
				<label className="tool-group-title">
					<input
						checked={draft.openRouter.webFetch.enabled}
						onChange={(event) => patchWebFetch({ enabled: event.target.checked })}
						type="checkbox"
					/>
					<span>Web Fetch</span>
				</label>
				<div className="field-row">
					<Field label="Engine">
						<select
							className="input"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ engine: event.target.value })}
							value={draft.openRouter.webFetch.engine}
						>
							<option value="">default</option>
							{webFetchEngineOptions.map((engine) => (
								<option key={engine} value={engine}>
									{engine}
								</option>
							))}
						</select>
					</Field>
					<Field label="Max uses">
						<input
							className="input"
							disabled={!draft.openRouter.webFetch.enabled}
							min={1}
							onChange={(event) => patchWebFetch({ maxUses: event.target.value })}
							placeholder="default"
							type="number"
							value={draft.openRouter.webFetch.maxUses}
						/>
					</Field>
				</div>
				<Field label="Max content tokens">
					<input
						className="input"
						disabled={!draft.openRouter.webFetch.enabled}
						min={1}
						onChange={(event) => patchWebFetch({ maxContentTokens: event.target.value })}
						placeholder="50000"
						type="number"
						value={draft.openRouter.webFetch.maxContentTokens}
					/>
				</Field>
				<div className="field-row">
					<Field label="Allowed domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ allowedDomains: event.target.value })}
							placeholder="docs.example.com"
							rows={2}
							value={draft.openRouter.webFetch.allowedDomains}
						/>
					</Field>
					<Field label="Blocked domains">
						<textarea
							className="textarea domain-list"
							disabled={!draft.openRouter.webFetch.enabled}
							onChange={(event) => patchWebFetch({ blockedDomains: event.target.value })}
							placeholder="private.example.com"
							rows={2}
							value={draft.openRouter.webFetch.blockedDomains}
						/>
					</Field>
				</div>
			</fieldset>
		</div>
	);
}
