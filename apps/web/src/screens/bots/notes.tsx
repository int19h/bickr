import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { planNoteId } from "@bickr/shared/note-settings";
import { RichText, type OpenReference } from "../../components/content";
import { Confirm, FilterBox, Modal } from "../../ui";

type NoteLink = { kind: "participant" | "forum"; entityId: string; handle: string; deleted: boolean };
type Note = { id: string; content: string; createdAt: string; updatedAt: string; revision: number; links: NoteLink[] };
type Editor = { mode: "create" | "edit"; original: Note | null; title: string; content: string };

export function BotNotesPanel({ botId, enabled, onReference, onRegisterRefresh, worldHandle }: {
	botId: string;
	enabled: boolean;
	onReference: OpenReference;
	onRegisterRefresh?: (botId: string, refresh: (() => Promise<void>) | null) => void;
	worldHandle: string;
}) {
	const [ids, setIds] = useState<string[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [filter, setFilter] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [note, setNote] = useState<Note | null>(null);
	const [noteLoading, setNoteLoading] = useState(false);
	const [noteError, setNoteError] = useState("");
	const [editor, setEditor] = useState<Editor | null>(null);
	const [editorError, setEditorError] = useState("");
	const [saving, setSaving] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const basePath = `/api/me/bots/${encodeURIComponent(botId)}/notes`;
	const listRequest = useRef(0);
	const noteRequest = useRef(0);
	const selectedIdRef = useRef(selectedId);
	selectedIdRef.current = selectedId;

	useEffect(() => {
		listRequest.current += 1;
		noteRequest.current += 1;
		setIds([]);
		setLoaded(false);
		setSelectedId(null);
		setNote(null);
		setFilter("");
	}, [botId]);

	const loadNotes = useCallback(async (): Promise<string[] | null> => {
		const request = ++listRequest.current;
		setLoading(true);
		setError("");
		const result = await api<{ ids: string[] }>(basePath);
		if (request !== listRequest.current) return null;
		if (result.ok) {
			setIds(result.data.ids);
			setSelectedId((current) => current && result.data.ids.includes(current) ? current : null);
			setLoaded(true);
		} else {
			setError(result.message);
		}
		setLoading(false);
		return result.ok ? result.data.ids : null;
	}, [basePath]);

	const loadNote = useCallback(async (id: string): Promise<void> => {
		const request = ++noteRequest.current;
		setNote((current) => current?.id === id ? current : null);
		setNoteLoading(true);
		setNoteError("");
		const result = await api<{ note: Note }>(`${basePath}/read`, { method: "POST", body: { id } });
		if (request !== noteRequest.current) return;
		if (result.ok) setNote(result.data.note);
		else setNoteError(result.message);
		setNoteLoading(false);
	}, [basePath]);

	useEffect(() => {
		void loadNotes();
		return () => { listRequest.current += 1; };
	}, [loadNotes]);

	useEffect(() => {
		if (!selectedId) {
			setNoteLoading(false);
			return;
		}
		void loadNote(selectedId);
		return () => { noteRequest.current += 1; };
	}, [loadNote, selectedId]);

	const refreshNotes = useCallback(async (): Promise<void> => {
		const freshIds = await loadNotes();
		const currentId = selectedIdRef.current;
		if (currentId && freshIds?.includes(currentId)) await loadNote(currentId);
	}, [loadNote, loadNotes]);

	useEffect(() => {
		onRegisterRefresh?.(botId, refreshNotes);
		return () => onRegisterRefresh?.(botId, null);
	}, [botId, onRegisterRefresh, refreshNotes]);

	const filteredIds = useMemo(() => ids.filter((id) => id.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [filter, ids]);
	const deleteSelected = async () => {
		if (!selectedId) return;
		setDeleting(true);
		const result = await api<{ outcome: "deleted" | "not_found" | "reset" }>(`${basePath}/delete`, { method: "POST", body: { id: selectedId } });
		setDeleting(false);
		setDeleteConfirm(false);
		if (!result.ok) {
			setNoteError(result.message);
			return;
		}
		if (result.data.outcome === "reset") {
			void loadNote(selectedId);
		} else {
			setIds((current) => current.filter((id) => id !== selectedId));
			setSelectedId(null);
			setNote(null);
		}
	};
	const saveEditor = async () => {
		if (!editor || saving) return;
		setSaving(true);
		setEditorError("");
		const result = editor.mode === "create"
			? await api<{ note: Note }>(`${basePath}/create`, { method: "POST", body: { id: editor.title, content: editor.content } })
			: await api<{ note: Note }>(`${basePath}/edit`, { method: "POST", body: {
				id: editor.original!.id, nextId: editor.title, content: editor.content, expectedRevision: editor.original!.revision,
			} });
		setSaving(false);
		if (!result.ok) {
			setEditorError(result.details?.noteCause === "stale_revision" ? "This note changed. Reload it before editing." : result.message);
			return;
		}
		setEditor(null);
		setNote(result.data.note);
		setSelectedId(result.data.note.id);
		void loadNotes();
	};

	return (
		<section aria-busy={loading || noteLoading} className="profile-tab-panel" role="tabpanel">
			{!enabled && <p className="help">Note tools are disabled for this participant. Existing notes remain here.</p>}
			{error && <p role="alert">{error} <button className="btn compact" onClick={() => void loadNotes()} type="button">Retry</button></p>}
			{loaded && (
				<>
					<div className="bot-notes-summary">
						<p className="muted">{ids.length} private {ids.length === 1 ? "note" : "notes"}.</p>
						<button
							className="btn primary"
							onClick={() => { setEditor({ mode: "create", original: null, title: "", content: "" }); setEditorError(""); }}
							type="button"
						>
							Add note
							</button>
					</div>
					{ids.length === 0 ? <p>No notes yet. This participant can create notes during a visit.</p> : (
						<div className="bot-notes-layout">
							<div className="bot-notes-list">
								<FilterBox label="Search note IDs" onChange={setFilter} placeholder="Search note IDs" value={filter} />
								{filteredIds.length === 0 ? <p>No matching note IDs.</p> : filteredIds.map((id) => (
									<button aria-current={selectedId === id ? "true" : undefined} className={selectedId === id ? "selected" : ""} key={id} onClick={() => setSelectedId(id)} type="button">{id}</button>
								))}
							</div>
							<div className="bot-notes-detail">
								{!selectedId && <p>Select a note to read it.</p>}
								{selectedId && noteLoading && note?.id !== selectedId && <p className="muted">Loading note…</p>}
								{selectedId && noteError && <p role="alert">{noteError}</p>}
								{note && note.id === selectedId && (
									<>
										<div className="bot-notes-detail-head">
											<h3>{note.id}</h3>
											<div className="bot-notes-actions">
												<button
													className="btn"
													onClick={() => { setEditor({ mode: "edit", original: note, title: note.id, content: note.content }); setEditorError(""); }}
													type="button"
												>
													Edit note
												</button>
												<button className="btn danger" onClick={() => setDeleteConfirm(true)} type="button">
													{note.id === planNoteId ? "Reset PLAN" : "Delete note"}
												</button>
											</div>
										</div>
										<div className="bot-notes-content"><RichText onReference={onReference} text={note.content} worldHandle={worldHandle} /></div>
										{note.links.length > 0 && <p className="muted">Linked to {note.links.map((link) => `${link.kind === "forum" ? "f" : "u"}/${link.handle}${link.deleted ? " (deleted)" : ""}`).join(", ")}</p>}
										<p className="muted">Updated {new Date(note.updatedAt).toLocaleString()}</p>
									</>
								)}
							</div>
						</div>
					)}
				</>
			)}
			<Confirm body={selectedId === planNoteId ? "Reset PLAN to its default list?" : `Delete note ${selectedId ?? ""}? This cannot be undone.`} confirmText={selectedId === planNoteId ? "Reset PLAN" : "Delete note"} danger onClose={() => setDeleteConfirm(false)} onConfirm={() => void deleteSelected()} open={deleteConfirm && !deleting} title={selectedId === planNoteId ? "Reset PLAN?" : "Delete this note?"} />
			<Modal
				foot={
					<div className="right">
						<button className="btn ghost" disabled={saving} onClick={() => setEditor(null)} type="button">Cancel</button>
						<button
							className="btn primary"
							disabled={saving || !editor?.title.trim() || !editor?.content}
							onClick={() => void saveEditor()}
							type="button"
						>
							{saving ? "Saving…" : "Save note"}
						</button>
					</div>
				}
				onClose={() => { if (!saving) setEditor(null); }}
				open={editor !== null}
				title={editor?.mode === "create" ? "Add note" : "Edit note"}
			>
				<label className="field">
					<span>Title</span>
					<input autoFocus className="input" disabled={saving || editor?.original?.id === planNoteId} onChange={(event) => setEditor((current) => current ? { ...current, title: event.target.value } : current)} value={editor?.title ?? ""} />
				</label>
				<label className="field">
					<span>Content</span>
					<textarea className="textarea" disabled={saving} onChange={(event) => setEditor((current) => current ? { ...current, content: event.target.value } : current)} rows={10} value={editor?.content ?? ""} />
				</label>
				{editor?.original?.id === planNoteId && <p className="help">You can edit PLAN content, but its title stays PLAN.</p>}
				{editorError && <p role="alert">{editorError}</p>}
			</Modal>
		</section>
	);
}
