import { useState } from "react";
import { createPortal } from "react-dom";
import type { InferenceAttribution } from "@bickr/shared/model";
import { Modal } from "../ui";

export function shortModelName(model: string): string {
	return model.slice(model.lastIndexOf("/") + 1);
}

export function InferenceAttributionFields({ attribution }: { attribution: InferenceAttribution }) {
	return <div className="inference-attribution-fields">
		<label className="field"><span>Model</span><input className="input" readOnly value={attribution.model} /></label>
		{Object.entries(attribution.parameters).map(([name, value]) => <label className="field" key={name}>
			<span>{name}</span>
			<input className="input" readOnly value={typeof value === "string" ? value : JSON.stringify(value)} />
		</label>)}
	</div>;
}

export function inferenceSourceHref(attribution: InferenceAttribution): string {
	const { botId, runId, requestSeq } = attribution.source;
	return `/inference/${encodeURIComponent(botId)}/${encodeURIComponent(runId)}/${requestSeq}`;
}

export function InferenceBadge({ attribution }: { attribution?: InferenceAttribution }) {
	const [open, setOpen] = useState(false);
	if (!attribution) return null;
	return <>
		<span className="inference-model-separator"> · </span>
		<button className="inference-model-name" onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(true); }} title={attribution.model} type="button">
			{shortModelName(attribution.model)}
		</button>
		{open && createPortal(<div onClick={event => event.stopPropagation()}><Modal open onClose={() => setOpen(false)} title="Inference details" foot={<a className="btn" href={inferenceSourceHref(attribution)}>Open inference in loop</a>}>
			<InferenceAttributionFields attribution={attribution} />
		</Modal></div>, document.body)}
	</>;
}
