import { instructionLocales, instructionLanguageNames, isInstructionLocale, type InstructionLanguagePreference } from "@bickr/shared/instruction-language";
import { useId } from "react";
import { Field } from "../ui";

export function InstructionLanguageField({ value, onChange, linkedClone }: {
	value: InstructionLanguagePreference;
	onChange: (value: InstructionLanguagePreference) => void;
	linkedClone: boolean;
}) {
	const inputId = useId();
	const helpId = `${inputId}-help`;
	return (
		<Field htmlFor={inputId} label="Instructions language">
			<select id={inputId} aria-describedby={helpId} className="input" value={value.kind === "fixed" ? value.locale : value.kind} onChange={(event) => {
				const selected = event.target.value;
				if (selected === "auto") onChange({ kind: "auto" });
				else if (selected === "source" && linkedClone) onChange({ kind: "source" });
				else if (isInstructionLocale(selected)) onChange({ kind: "fixed", locale: selected });
			}}>
				<option value="auto">Auto: match primary language</option>
				{linkedClone && <option value="source">Inherit source</option>}
				{instructionLocales.map((locale) => <option key={locale} value={locale}>{instructionLanguageNames[locale]}</option>)}
			</select>
			<p id={helpId} className="help">Language for Bickr instructions and tool descriptions. Auto uses the primary language, or English when it is unset or unsupported. The speaking language stays separate.</p>
		</Field>
	);
}
