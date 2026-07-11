import type { ReactNode } from "react";

export function RuntimeRow({
	description,
	label,
	value,
}: {
	description?: string;
	label: ReactNode;
	value: ReactNode;
}) {
	return (
		<div className="kvrow">
			<div>
				<div className="k">{label}</div>
				{description && <div className="desc">{description}</div>}
			</div>
			<div className="v">{value}</div>
		</div>
	);
}
