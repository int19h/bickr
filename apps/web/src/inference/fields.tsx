import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
	InferenceConfigurationField,
	InferenceCredentialUnavailableReason,
} from "@bickr/shared/inference-configuration";
import type {
	InferenceConfigurationPathEntry,
	RedactedInferenceCredentialResolution,
	RedactedInferenceFieldDto,
} from "@bickr/shared/inference-configuration-owner";
import {
	adjustmentText,
	applyCheckboxDomState,
	booleanCheckboxDomState,
	booleanCycleFromDraft,
	draftFromBooleanCycleState,
	effectiveValueText,
	explicitStateLabel,
	explicitStatesForField,
	fieldValueText,
	inferenceFieldControl,
	inferenceFieldLabels,
	modeCheckboxDomState,
	nextBooleanCycleState,
	sourceLabel,
	type CheckboxDomState,
	type InferenceExplicitState,
	type InferenceFieldDraft,
} from "./field-model";

export type InferenceFieldProps = {
	dto: RedactedInferenceFieldDto<InferenceConfigurationField>;
	draft: InferenceFieldDraft;
	field: InferenceConfigurationField;
	isAccountDefault: boolean;
	help?: ReactNode;
	onChange: (draft: InferenceFieldDraft) => void;
	path: readonly InferenceConfigurationPathEntry[];
	/** Non-binding completions; a custom value is always sent as typed. */
	suggestions?: readonly InferenceFieldSuggestion[];
};

export type InferenceFieldSuggestion = { value: string; label?: string };

/** Effective value plus its provenance, shown visually and as the description. */
function statusText(props: InferenceFieldProps): string {
	const effective = effectiveValueText(props.field, props.dto.effective);
	return `Effective ${effective} from ${sourceLabel(props.dto.source, props.path)}`;
}

function useControlledCheckbox(state: CheckboxDomState) {
	const ref = useRef<HTMLInputElement | null>(null);
	// The mixed state is a DOM property, so it is re-applied from component
	// state on every render as well as on every ref attachment.
	useEffect(() => {
		applyCheckboxDomState(ref.current, state);
	});
	return (element: HTMLInputElement | null) => {
		ref.current = element;
		applyCheckboxDomState(element, state);
	};
}

export function InferenceField(props: InferenceFieldProps) {
	const control = inferenceFieldControl(props.field);
	switch (control.control) {
		case "boolean": return <BooleanInferenceField {...props} />;
		case "enum": return <EnumInferenceField {...props} options={control.options} />;
		case "json": return <TextualInferenceField {...props} multiline />;
		case "number": return <TextualInferenceField {...props} numeric={{ ...control.domain, step: control.step }} />;
		case "text": return <TextualInferenceField {...props} />;
	}
}

function FieldShell({
	adjustment,
	children,
	control,
	help,
	labelRow,
	statusId,
	status,
}: {
	adjustment: string | null;
	children: ReactNode;
	control: string;
	help?: ReactNode;
	labelRow: ReactNode;
	statusId: string;
	status: string;
}) {
	return (
		<div className={`inference-field inference-field-${control}`}>
			{labelRow}
			{children}
			<p className="help inference-field-status" id={statusId}>{status}</p>
			{adjustment && <p className="runtime-message inference-field-adjustment">{adjustment}</p>}
			{help && <div className="help">{help}</div>}
		</div>
	);
}

function BooleanInferenceField(props: InferenceFieldProps) {
	const inputId = useId();
	const statusId = useId();
	const [announcement, setAnnouncement] = useState("");
	// Every render reads the cycle back from the draft it is rendering, so the
	// checkbox is the same control after a rerender as it was before one.
	const cycle = booleanCycleFromDraft(props.draft);
	const domState = booleanCheckboxDomState(cycle);
	const setCheckbox = useControlledCheckbox(domState);
	const label = inferenceFieldLabels[props.field];
	const status = statusText(props);
	const inheritedValue = props.dto.effective === true;

	function apply(next: ReturnType<typeof nextBooleanCycleState>): void {
		props.onChange(draftFromBooleanCycleState(next));
		setAnnouncement(
			next.mode === "inherit"
				? `${label} inherits: ${status}.`
				: `${label} set explicitly to ${next.value ? "on" : "off"}.`,
		);
	}

	return (
		<FieldShell
			adjustment={adjustmentText(props.field, props.dto.adjustment)}
			control="boolean"
			help={props.help}
			labelRow={
				<div className="inference-field-head">
					{/* One native checkbox carries all three states; the browser maps
					    `indeterminate` to mixed, so no redundant aria-checked is set.
					    `checked` is React-controlled from the draft; `indeterminate`
					    has no attribute form and is applied by the same state on every
					    render and ref update. */}
					<input
						aria-describedby={statusId}
						checked={domState.checked}
						id={inputId}
						onChange={() => apply(nextBooleanCycleState(cycle, inheritedValue))}
						ref={setCheckbox}
						type="checkbox"
					/>
					<label htmlFor={inputId}>{label}</label>
					<button
						className="btn ghost compact inference-inherit-reset"
						disabled={cycle.mode === "inherit"}
						onClick={() => apply({ mode: "inherit" })}
						type="button"
					>
						Inherit
					</button>
				</div>
			}
			status={status}
			statusId={statusId}
		>
			<span aria-live="polite" className="sr-only">{announcement}</span>
		</FieldShell>
	);
}

function EnumInferenceField(props: InferenceFieldProps & { options: readonly { value: string; label: string }[] }) {
	const inputId = useId();
	const statusId = useId();
	const label = inferenceFieldLabels[props.field];
	const status = statusText(props);
	const selected = props.draft.mode === "explicit" && props.draft.state === "value" ? props.draft.text : "";
	return (
		<FieldShell
			adjustment={adjustmentText(props.field, props.dto.adjustment)}
			control="enum"
			help={props.help}
			labelRow={
				<div className="inference-field-head">
					<label htmlFor={inputId}>{label}</label>
				</div>
			}
			status={status}
			statusId={statusId}
		>
			<select
				aria-describedby={statusId}
				className="input"
				id={inputId}
				onChange={(event) =>
					props.onChange(
						event.target.value === ""
							? { mode: "inherit" }
							: { mode: "explicit", state: "value", text: event.target.value },
					)
				}
				value={selected}
			>
				<option value="">
					{`Inherit — ${effectiveValueText(props.field, props.dto.effective)} from ${sourceLabel(props.dto.source, props.path)}`}
				</option>
				<option disabled value="__separator">──────────</option>
				{props.options.map((option) => (
					<option key={option.value} value={option.value}>{option.label}</option>
				))}
			</select>
		</FieldShell>
	);
}

function TextualInferenceField(
	props: InferenceFieldProps & {
		multiline?: boolean;
		numeric?: { min: number; max: number; step: number };
	},
) {
	const inputId = useId();
	const statusId = useId();
	const stateId = useId();
	const listId = useId();
	const label = inferenceFieldLabels[props.field];
	const status = statusText(props);
	const draft = props.draft;
	const explicit = draft.mode === "explicit";
	const states = explicitStatesForField(props.field, props.isAccountDefault);
	const setModeCheckbox = useControlledCheckbox(modeCheckboxDomState(draft));
	const text = draft.mode === "explicit" && draft.state === "value" ? draft.text : "";
	const editable = draft.mode === "explicit" && draft.state === "value";
	const inheritedPlaceholder = effectiveValueText(props.field, props.dto.effective);

	function toggleMode(): void {
		props.onChange(
			explicit
				? { mode: "inherit" }
				// Seeding copies what is inherited today and records it explicitly, so
				// a later parent change cannot silently move this value.
				: { mode: "explicit", state: "value", text: fieldValueText(props.field, props.dto.effective) },
		);
	}

	return (
		<FieldShell
			adjustment={adjustmentText(props.field, props.dto.adjustment)}
			control={props.multiline ? "json" : props.numeric ? "number" : "text"}
			help={props.help}
			labelRow={
				<div className="inference-field-head">
					{/* Adjacent to the label, never nested inside it: an owner reaches the
					    input and its mode control as two separate stops. */}
					<input
						aria-describedby={statusId}
						aria-label={`Override ${label}`}
						onChange={toggleMode}
						ref={setModeCheckbox}
						type="checkbox"
					/>
					<label htmlFor={inputId}>{label}</label>
					{explicit && states.length > 1 && (
						<select
							aria-label={`${label} explicit state`}
							className="input compact inference-explicit-state"
							id={stateId}
							onChange={(event) => props.onChange(explicitDraft(props, event.target.value as InferenceExplicitState))}
							value={draft.mode === "explicit" ? draft.state : "value"}
						>
							{states.map((state) => (
								<option key={state} value={state}>{explicitStateLabel(state)}</option>
							))}
						</select>
					)}
				</div>
			}
			status={status}
			statusId={statusId}
		>
			{props.multiline ? (
				<textarea
					aria-describedby={statusId}
					className="textarea provider-routing-editor"
					disabled={!editable}
					id={inputId}
					onChange={(event) => props.onChange({ mode: "explicit", state: "value", text: event.target.value })}
					placeholder={inheritedPlaceholder}
					rows={6}
					spellCheck={false}
					value={text}
				/>
			) : (
				<>
					<input
						aria-describedby={statusId}
						className="input"
						disabled={!editable}
						id={inputId}
						{...(props.suggestions?.length ? { list: listId } : {})}
						onChange={(event) => props.onChange({ mode: "explicit", state: "value", text: event.target.value })}
						placeholder={inheritedPlaceholder}
						value={text}
						{...(props.numeric
							? { type: "number", min: props.numeric.min, max: props.numeric.max, step: props.numeric.step }
							: {})}
					/>
					{props.suggestions && props.suggestions.length > 0 && (
						<datalist id={listId}>
							{props.suggestions.map((suggestion) => (
								<option key={suggestion.value} value={suggestion.value} {...(suggestion.label ? { label: suggestion.label } : {})} />
							))}
						</datalist>
					)}
				</>
			)}
		</FieldShell>
	);
}

function explicitDraft(props: InferenceFieldProps, state: InferenceExplicitState): InferenceFieldDraft {
	if (state !== "value") return { mode: "explicit", state };
	return { mode: "explicit", state: "value", text: fieldValueText(props.field, props.dto.effective) };
}

export type CredentialAction = "replace" | "inherit" | "account_default" | "none";

/**
 * Status-only credential control. It renders resolved availability and typed
 * actions; the current value, its length, and any digest of it never reach the
 * browser, so there is nothing here to leak.
 */
export function CredentialField({
	busy,
	isAccountDefault,
	mode,
	onAction,
	path,
	resolution,
}: {
	busy: boolean;
	isAccountDefault: boolean;
	mode: "inherit" | "account_default" | "value" | "none";
	onAction: (action: CredentialAction, secret?: string) => void;
	path: readonly InferenceConfigurationPathEntry[];
	resolution: RedactedInferenceCredentialResolution;
}) {
	const [replacing, setReplacing] = useState(false);
	const [secret, setSecret] = useState("");
	const inputId = useId();
	const statusId = useId();

	return (
		<div className="inference-field inference-field-secret">
			<div className="inference-field-head">
				<span className="inference-field-label">Provider credential</span>
				<span className="hint">{credentialModeLabel(mode)}</span>
			</div>
			<p className="help" id={statusId}>{credentialResolutionText(resolution, path)}</p>
			{replacing ? (
				<div className="inline-form">
					<input
						aria-describedby={statusId}
						aria-label="New provider credential"
						autoComplete="off"
						className="input"
						id={inputId}
						onChange={(event) => setSecret(event.target.value)}
						placeholder="sk-or-..."
						type="password"
						value={secret}
					/>
					<button
						className="btn primary compact"
						disabled={busy || !secret.trim()}
						onClick={() => {
							onAction("replace", secret.trim());
							setSecret("");
							setReplacing(false);
						}}
						type="button"
					>
						Save key
					</button>
					<button className="btn ghost compact" onClick={() => { setSecret(""); setReplacing(false); }} type="button">
						Cancel
					</button>
				</div>
			) : (
				<div className="inference-secret-actions">
					<button className="btn compact" disabled={busy} onClick={() => setReplacing(true)} type="button">
						Replace
					</button>
					<button className="btn ghost compact" disabled={busy || mode === "inherit"} onClick={() => onAction("inherit")} type="button">
						Inherit
					</button>
					{!isAccountDefault && (
						<button
							className="btn ghost compact"
							disabled={busy || mode === "account_default"}
							onClick={() => onAction("account_default")}
							type="button"
						>
							Use Account default
						</button>
					)}
					<button className="btn ghost compact" disabled={busy || mode === "none"} onClick={() => onAction("none")} type="button">
						Use no key
					</button>
				</div>
			)}
		</div>
	);
}

function credentialModeLabel(mode: "inherit" | "account_default" | "value" | "none"): string {
	switch (mode) {
		case "inherit": return "inherited";
		case "account_default": return "Account default";
		case "value": return "saved key here";
		case "none": return "explicitly no key";
	}
}

export function credentialResolutionText(
	resolution: RedactedInferenceCredentialResolution,
	path: readonly InferenceConfigurationPathEntry[],
): string {
	switch (resolution.kind) {
		case "available":
			return `A saved key from ${sourceLabel(resolution.source, path)} is in effect.`;
		case "explicit_none":
			return `${sourceLabel(resolution.source, path)} explicitly sends no key.`;
		case "unavailable":
			return credentialUnavailableText(resolution.reason);
	}
}

function credentialUnavailableText(reason: InferenceCredentialUnavailableReason): string {
	switch (reason) {
		case "missing_saved_secret": return "A key was expected here but no saved key is stored.";
		case "no_credential": return "No key is available, so only Bickr's default provider can be used.";
		case "deployment_credential_suppressed_for_owner_base_url":
			return "Bickr's deployment key is not sent to an owner-selected base URL. Save a key for this endpoint.";
	}
}
