import {
	localizedText,
	localizedTextLang,
	type LanguageTag,
	type LocalizedText,
} from "@bickr/shared/model";
import { handleHelpText, isValidHandleText } from "@bickr/shared/validation";
import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import {
	languageInputValue,
	useUiText,
} from "./ui-text";
import { slugify } from "../screens/bots";
import {
	Field,
	Modal,
	type TextLike,
} from "../ui";

export type IncludeLanguageInSystemPromptDraft = "include" | "exclude" | "inherit";

const languageExamples = [
	{ label: "English", value: "en" },
	{ label: "Spanish", value: "es" },
	{ label: "Chinese (Simplified)", value: "zh-Hans" },
	{ label: "Chinese (Traditional)", value: "zh-Hant" },
	{ label: "Japanese", value: "ja" },
	{ label: "Russian", value: "ru" },
	{ label: "Ukrainian", value: "uk" },
	{ label: "Esperanto", value: "eo" },
	{ label: "Arabic", value: "ar" },
	{ label: "Mongolian (Mongolian script)", value: "mn-Mong" },
	{ label: "Old Norse", value: "non" },
] as const;

export function localizedDraft(text: string, language: string): LocalizedText {
	return localizedText(text, languageInputValue(language));
}
export function textLang(value: TextLike | null | undefined): LanguageTag | null {
	return localizedTextLang(value);
}

export function RenameHandleModal({
	busy,
	kind,
	oldHandle,
	routeHelp,
	onClose,
	onSave,
	open,
	warning,
}: {
	busy: boolean;
	kind: "forum" | "bot";
	oldHandle: string;
	routeHelp: (handle: string) => string;
	onClose: () => void;
	onSave: (handle: string) => Promise<boolean>;
	open: boolean;
	warning: ReactNode;
}) {
	const [handle, setHandle] = useState(oldHandle);
	const label = kind === "forum" ? "Forum handle" : "Bot handle";
	const prefix = kind === "forum" ? "f/" : "u/";

	useEffect(() => {
		if (open) {
			setHandle(oldHandle);
		}
	}, [oldHandle, open]);

	const valid = isValidHandleText(handle);
	const dirty = handle !== oldHandle;

	async function submit(): Promise<void> {
		const ok = await onSave(handle);
		if (ok) {
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">{prefix}{oldHandle} will stop being the canonical handle.</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void submit()} type="button">
							Save
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title={`Change ${kind} handle`}
		>
			<div className="rename-warning">⚠️ {warning}</div>
			<Field help={handle ? routeHelp(handle) : handleHelpText} label={label}>
				<div className="input-prefix">
					<span className="prefix">{prefix}</span>
					<input
						autoFocus
						className="input"
						onChange={(event) => setHandle(slugify(event.target.value))}
						value={handle}
					/>
				</div>
			</Field>
		</Modal>
	);
}

export function LanguageField({
	disabled,
	hint,
	label,
	onChange,
	placeholder = "en",
	systemPromptControl,
	value,
}: {
	disabled?: boolean;
	hint?: string;
	label?: string;
	onChange: (value: string) => void;
	placeholder?: string;
	systemPromptControl?: LanguageSystemPromptControlProps;
	value: string;
}) {
	const inputId = useId();
	const listId = `${inputId}-languages`;
	const t = useUiText();
	return (
		<Field
			help={t.language.fieldHelp}
			hint={hint}
			label={label ?? t.language.fieldLabel}
			labelAction={systemPromptControl ? <LanguageSystemPromptControl {...systemPromptControl} /> : undefined}
		>
			<input
				className="input"
				disabled={disabled}
				dir="ltr"
				lang="en"
				list={listId}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				value={value}
			/>
			<datalist id={listId}>
				{languageExamples.map((language) => (
					<option key={language.value} label={language.label} value={language.value} />
				))}
			</datalist>
		</Field>
	);
}

type LanguageSystemPromptControlProps = {
	allowInherit: boolean;
	disabled?: boolean;
	inheritedValue?: boolean | null;
	onChange: (value: IncludeLanguageInSystemPromptDraft) => void;
	value: IncludeLanguageInSystemPromptDraft;
};

function LanguageSystemPromptControl({
	allowInherit,
	disabled,
	inheritedValue,
	onChange,
	value,
}: LanguageSystemPromptControlProps) {
	const checkboxRef = useRef<HTMLInputElement | null>(null);
	const normalizedValue = allowInherit ? value : value === "include" ? "include" : "exclude";
	const indeterminate = normalizedValue === "inherit";
	useEffect(() => {
		if (checkboxRef.current) {
			checkboxRef.current.indeterminate = indeterminate;
		}
	}, [indeterminate]);
	const inheritedText =
		inheritedValue === true ? "inherits checked"
		: inheritedValue === false ? "inherits unchecked"
		: "inherits source";
	const title = indeterminate ? `Add to system prompt (${inheritedText})` : "Add to system prompt";
	return (
		<label className="language-system-prompt-control" title={title}>
			<input
				aria-checked={indeterminate ? "mixed" : normalizedValue === "include"}
				checked={normalizedValue === "include"}
				className="cb"
				disabled={disabled}
				onChange={() => {
					if (!disabled) {
						onChange(nextIncludeLanguageInSystemPromptDraft(normalizedValue, allowInherit));
					}
				}}
				ref={checkboxRef}
				type="checkbox"
			/>
			<span>Add to system prompt</span>
		</label>
	);
}

function nextIncludeLanguageInSystemPromptDraft(
	value: IncludeLanguageInSystemPromptDraft,
	allowInherit: boolean,
): IncludeLanguageInSystemPromptDraft {
	if (!allowInherit) {
		return value === "include" ? "exclude" : "include";
	}
	if (value === "inherit") {
		return "include";
	}
	return value === "include" ? "exclude" : "inherit";
}
