import { useLayoutEffect, useRef, useState } from "react";

/**
 * How a Markdown body shows its source. `readOnly` is for every viewer who
 * does not own the author. `editable` saves through `onSave`, which gets the
 * new text and the stored text that the edit started from, and resolves to
 * true when the new text is stored.
 */
export type MarkdownSourceAccess =
	| { kind: "readOnly" }
	| { kind: "editable"; onSave: (text: string, expectedBody: string) => Promise<boolean> };

/**
 * The source of a Markdown body in a textarea. The parent owns the draft, so
 * it survives a refresh of the stored text and the parent can ask before it
 * throws away unsaved changes.
 */
export function MarkdownSourceView({
	changedWhileEditing,
	draft,
	editable,
	lang,
	onDiscard,
	onDraftChange,
	onSave,
	saved,
}: {
	changedWhileEditing: boolean;
	draft: string;
	editable: boolean;
	lang: string | undefined;
	onDiscard: () => void;
	onDraftChange: (text: string) => void;
	onSave: () => Promise<void>;
	saved: string;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	const [saving, setSaving] = useState(false);
	const mounted = useRef(true);
	useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const changed = draft !== saved;
	// The textarea grows with its text; CSS caps it, and then it scrolls.
	useLayoutEffect(() => {
		const node = area.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${node.scrollHeight + 2}px`;
	}, [draft]);
	async function save(): Promise<void> {
		if (!editable || !changed || saving || !draft.trim()) return;
		setSaving(true);
		await onSave();
		// A stored save closes this view; a failure keeps the draft here.
		if (!mounted.current) return;
		setSaving(false);
		area.current?.focus();
	}
	return (
		<div className="markdown-source" data-selection-exclude="true">
			{editable && changedWhileEditing && (
				<p className="markdown-source-notice" role="status">The comment changed while you edited it. Saving replaces the new text with your draft.</p>
			)}
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
					<button className="btn ghost" disabled={!changed || saving} onClick={onDiscard} type="button">
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
