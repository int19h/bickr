import { useId } from "react";
import type { InferenceConfigurationField } from "@bickr/shared/inference-configuration";
import type { RedactedInferenceFieldDtoMap } from "@bickr/shared/inference-configuration-owner";
import {
	openRouterSuggestedImageAspectRatios,
	openRouterSuggestedImageSizes,
} from "@bickr/shared/model";

import {
	inferenceFieldControl,
	inferenceFieldLabels,
	overrideFromDraft,
	type InferenceFieldDraft,
} from "../inference/field-model";
import { Field } from "../ui";
import {
	avatarClearedDraft,
	avatarDraftText,
	avatarFieldDraft,
	avatarFieldPlaceholder,
} from "./generation-settings";
import type { OpenRouterImageModel } from "./AvatarGenerationScreen";

const openRouterImageGenerationDocsUrl =
	"https://openrouter.ai/docs/guides/overview/multimodal/image-generation#aspect-ratio";
const openRouterProviderRoutingDocsUrl = "https://openrouter.ai/docs/features/provider-routing";

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

export type AvatarSettingsFieldsProps = {
	drafts: Partial<Record<InferenceConfigurationField, InferenceFieldDraft>>;
	fields: RedactedInferenceFieldDtoMap;
	onDraftChange: (field: InferenceConfigurationField, draft: InferenceFieldDraft) => void;
};

function textDraft(
	fields: RedactedInferenceFieldDtoMap,
	field: InferenceConfigurationField,
	text: string,
): InferenceFieldDraft {
	return text.trim() ? { mode: "explicit", state: "value", text } : avatarClearedDraft(fields, field);
}

function AvatarSettingsNumberField({
	disabled,
	drafts,
	field,
	fields,
	label,
	onDraftChange,
}: AvatarSettingsFieldsProps & {
	disabled: boolean;
	field: InferenceConfigurationField;
	label: string;
}) {
	const control = inferenceFieldControl(field);
	const domain = control.control === "number" ? control.domain : undefined;
	return (
		<Field label={label}>
			<input
				className="input"
				disabled={disabled}
				max={domain?.max}
				min={domain?.min}
				onChange={(event) => onDraftChange(field, textDraft(fields, field, event.target.value))}
				placeholder={avatarFieldPlaceholder(drafts, fields, field)}
				step={control.control === "number" ? control.step : undefined}
				type="number"
				value={avatarDraftText(avatarFieldDraft(drafts, fields, field))}
			/>
		</Field>
	);
}

function AvatarProviderRoutingField({
	disabled,
	drafts,
	field,
	fields,
	onDraftChange,
}: AvatarSettingsFieldsProps & {
	disabled: boolean;
	field: Extract<InferenceConfigurationField, "providerRouting" | "imageProviderRouting">;
}) {
	const draft = avatarFieldDraft(drafts, fields, field);
	const parsed = overrideFromDraft(field, draft, inferenceFieldLabels[field]);
	return (
		<fieldset disabled={disabled}>
			<div className="provider-routing-field">
				<Field label="Provider routing">
					<textarea
						className={`textarea provider-routing-editor ${parsed.ok ? "" : "invalid"}`}
						onChange={(event) => onDraftChange(field, textDraft(fields, field, event.target.value))}
						placeholder={avatarFieldPlaceholder(drafts, fields, field)}
						rows={7}
						spellCheck={false}
						value={avatarDraftText(draft)}
					/>
					{parsed.ok ?
						<div className="help">
							Sent as OpenRouter's <code>provider</code> request-body object. See{" "}
							<a href={openRouterProviderRoutingDocsUrl} rel="noreferrer" target="_blank">
								OpenRouter provider routing docs
							</a>
							.
						</div>
					:	<div className="runtime-message error">{parsed.message}</div>}
				</Field>
			</div>
		</fieldset>
	);
}

export function AvatarImageBasicFields({
	drafts,
	effectiveModel,
	fields,
	models,
	modelsError,
	onDraftChange,
}: AvatarSettingsFieldsProps & {
	effectiveModel: string;
	models: OpenRouterImageModel[];
	modelsError: string;
}) {
	const modelDraftText = avatarDraftText(avatarFieldDraft(drafts, fields, "imageModel"));
	const modelSelected = effectiveModel.trim().length > 0;
	const aspectRatioListId = useId();
	const imageSizeListId = useId();
	const suggestedAspectRatios = openRouterSuggestedImageAspectRatios(effectiveModel);
	const suggestedImageSizes = openRouterSuggestedImageSizes(effectiveModel);
	const knownModel = models.some((model) => model.id === modelDraftText);
	return (
		<div className="inference-row three">
			<Field help={modelsError || "Only OpenRouter models that advertise image output are listed."} label="Model">
				<select
					className="input"
					onChange={(event) => onDraftChange("imageModel", textDraft(fields, "imageModel", event.target.value))}
					value={modelDraftText}
				>
					<option value="">
						{`Inherit - ${avatarFieldPlaceholder(drafts, fields, "imageModel")}`}
					</option>
					{modelDraftText && !knownModel && <option value={modelDraftText}>{modelDraftText}</option>}
					{models.map((model) => (
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
					onChange={(event) => onDraftChange("imageAspectRatio", textDraft(fields, "imageAspectRatio", event.target.value))}
					placeholder={avatarFieldPlaceholder(drafts, fields, "imageAspectRatio")}
					value={avatarDraftText(avatarFieldDraft(drafts, fields, "imageAspectRatio"))}
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
					onChange={(event) => onDraftChange("imageSize", textDraft(fields, "imageSize", event.target.value))}
					placeholder={avatarFieldPlaceholder(drafts, fields, "imageSize")}
					value={avatarDraftText(avatarFieldDraft(drafts, fields, "imageSize"))}
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

export function AvatarImageAdvancedFields({
	drafts,
	effectiveModel,
	fields,
	onDraftChange,
}: AvatarSettingsFieldsProps & { effectiveModel: string }) {
	const modelSelected = effectiveModel.trim().length > 0;
	const shared = { drafts, fields, onDraftChange, disabled: !modelSelected };
	return (
		<div className="field-stack">
			<div className="inference-row four">
				<AvatarSettingsNumberField {...shared} field="imageTemperature" label="Temperature" />
				<AvatarSettingsNumberField {...shared} field="imageTopK" label="Top K" />
				<AvatarSettingsNumberField {...shared} field="imageTopP" label="Top P" />
				<AvatarSettingsNumberField {...shared} field="imageMinP" label="Min P" />
			</div>
			<div className="inference-row three">
				<AvatarSettingsNumberField {...shared} field="imageFrequencyPenalty" label="Frequency penalty" />
				<AvatarSettingsNumberField {...shared} field="imagePresencePenalty" label="Presence penalty" />
				<AvatarSettingsNumberField {...shared} field="imageRepetitionPenalty" label="Repetition penalty" />
			</div>
			<AvatarProviderRoutingField {...shared} field="imageProviderRouting" />
		</div>
	);
}

/**
 * The text-inference fields a world's description/members prompt fill
 * actually uses, edited against the same fixed configuration. Base URL and
 * credential deliberately stay in the configuration editor.
 */
export function AvatarPromptFillFields({
	drafts,
	fields,
	onDraftChange,
}: AvatarSettingsFieldsProps) {
	const reasoningControl = inferenceFieldControl("reasoning");
	const reasoningDraft = avatarFieldDraft(drafts, fields, "reasoning");
	const shared = { drafts, fields, onDraftChange, disabled: false };
	return (
		<div className="field-stack">
			<div className="inference-row">
				<Field help="OpenRouter model used to write the avatar prompt." label="Model">
					<input
						className="input"
						onChange={(event) => onDraftChange("model", textDraft(fields, "model", event.target.value))}
						placeholder={avatarFieldPlaceholder(drafts, fields, "model")}
						value={avatarDraftText(avatarFieldDraft(drafts, fields, "model"))}
					/>
				</Field>
				<Field label="Reasoning">
					<select
						className="input"
						onChange={(event) => onDraftChange("reasoning", textDraft(fields, "reasoning", event.target.value))}
						value={avatarDraftText(reasoningDraft)}
					>
						<option value="">
							{`Inherit - ${avatarFieldPlaceholder(drafts, fields, "reasoning")}`}
						</option>
						{reasoningControl.control === "enum" && reasoningControl.options.map((option) => (
							<option key={option.value} value={option.value}>{option.label}</option>
						))}
					</select>
				</Field>
			</div>
			<div className="inference-row four">
				<AvatarSettingsNumberField {...shared} field="temperature" label="Temperature" />
				<AvatarSettingsNumberField {...shared} field="topK" label="Top K" />
				<AvatarSettingsNumberField {...shared} field="topP" label="Top P" />
				<AvatarSettingsNumberField {...shared} field="minP" label="Min P" />
			</div>
			<div className="inference-row three">
				<AvatarSettingsNumberField {...shared} field="frequencyPenalty" label="Frequency penalty" />
				<AvatarSettingsNumberField {...shared} field="presencePenalty" label="Presence penalty" />
				<AvatarSettingsNumberField {...shared} field="repetitionPenalty" label="Repetition penalty" />
			</div>
			<AvatarProviderRoutingField {...shared} field="providerRouting" />
		</div>
	);
}
