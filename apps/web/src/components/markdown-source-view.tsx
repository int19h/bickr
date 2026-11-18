import { useLayoutEffect, useRef, useState } from "react";

/**
 * How a Markdown body shows its source. `readOnly` is for every viewer who
 * does not own the author. `editable` saves through `onSave`, which resolves
 * to true when the new text is stored.
 */
export type MarkdownSourceAccess =
	| { kind: "readOnly" }
	| { kind: "editable"; onSave: (text: string) => Promise<boolean> };

/**
 * The source of a Markdown body in a textarea. The draft lives in the parent,
 * so the parent can ask before it throws away unsaved changes.
 */
export function MarkdownSourceView({
	access,
	draft,
	lang,
	onDraftChange,
	saved,
}: {
	access: MarkdownSourceAccess;
	draft: string;
	lang: string | undefined;
	onDraftChange: (text: string) => void;
	saved: string;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	const [saving, setSaving] = useState(false);
	const editable = access.kind === "editable";
	const changed = draft !== saved;
	// The textarea grows with its text; CSS caps it, and then it scrolls.
	useLayoutEffect(() => {
		const node = area.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${node.scrollHeight + 2}px`;
	}, [draft]);
	async function save(): Promise<void> {
		if (access.kind !== "editable" || !changed || saving || !draft.trim()) return;
		setSaving(true);
		const stored = await access.onSave(draft);
		// The parent replaces `saved` on success; a failure keeps the draft.
		if (!stored) area.current?.focus();
		setSaving(false);
	}
	return (
		<div className="markdown-source" data-selection-exclude="true">
			<textarea
				aria-label={editable ? "Markdown source, editable" : "Markdown source"}
				className="markdown-source-text"
				dir="auto"
				disabled={saving}
				lang={lang}
				onChange={(event) => onDraftChange(event.target.value)}
				onKeyDown={(event) => {
					if (editable && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
						event.preventDefault();
						void save();
					}
				}}
				readOnly={!editable}
				ref={area}
				spellCheck={editable}
				value={draft}
			/>
			{editable && (
				<div className="markdown-source-actions">
					<button className="btn ghost" disabled={!changed || saving} onClick={() => onDraftChange(saved)} type="button">
						Discard
					</button>
					<button className="btn primary" disabled={!changed || saving || !draft.trim()} onClick={() => void save()} title="Save (Ctrl+Enter)" type="button">
						{saving && <span className="spinner" />}
						Save
					</button>
				</div>
			)}
		</div>
	);
}
