import { useEffect, useRef } from "react";

/**
 * A Spotlight target checkbox.
 *
 * Every Spotlight toggle renders through this component so that the structural
 * marker cannot be forgotten on a new one: an unmarked toggle would read as an
 * unrelated activation and retire the selection capture it was supposed to
 * consume. See `selection-markers.ts`.
 */
export function SpotlightTargetCheckbox({
	checked,
	indeterminate = false,
	label,
	onToggle,
}: {
	checked: boolean;
	indeterminate?: boolean;
	label: string;
	onToggle: (checked: boolean) => void;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.indeterminate = indeterminate;
		}
	}, [indeterminate]);
	return (
		<input
			aria-label={label}
			checked={checked}
			className="cb"
			data-spotlight-toggle="true"
			onChange={(event) => onToggle(event.target.checked)}
			ref={inputRef}
			title={label}
			type="checkbox"
		/>
	);
}
