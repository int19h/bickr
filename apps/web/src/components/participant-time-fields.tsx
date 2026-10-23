import { isParticipantTimezone } from "@bickr/shared/participant-time";
import type { ParticipantTimeSettings } from "@bickr/shared/model";
import { Field } from "../ui";

export function ParticipantTimeFields({ value, onChange }: {
	value: ParticipantTimeSettings;
	onChange: (value: ParticipantTimeSettings) => void;
}) {
	const validTimezone = isParticipantTimezone(value.timezone);
	return (
		<div className="field-row">
			<label>
				<input
					type="checkbox"
					checked={value.mode === "absolute"}
					onChange={event => onChange({ mode: event.target.checked ? "absolute" : "relative", timezone: value.timezone })}
				/>
				Absolute time
			</label>
			<Field
				label="Timezone"
				help={validTimezone ? "IANA timezone name, such as America/Los_Angeles." : "Enter a valid IANA timezone name."}
			>
				<input
					className="input"
					aria-label="Timezone"
					aria-invalid={!validTimezone}
					disabled={value.mode === "relative"}
					value={value.timezone}
					onChange={event => onChange({ mode: value.mode, timezone: event.target.value })}
				/>
			</Field>
		</div>
	);
}
