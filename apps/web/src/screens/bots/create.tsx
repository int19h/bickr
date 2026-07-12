import type { BotSummary, ChirperImportPreview } from "@bickr/shared/model";
import { maxBotPromptLength } from "@bickr/shared/validation";
import { useContext, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { LanguageField, textLang } from "../../components/form-fields";
import { matchesFilter, sortBotsForCards } from "../../components/record-display";
import { Reference, TranslatableText, type WorldView } from "../../components/content";
import { languageDraftValue } from "../../components/ui-text";
import { defaultLanguageTag } from "../../language";
import { Avatar, Field, Icon, Modal, ToastContext, textValue } from "../../ui";
import { runApiAction } from "../../use-api";
import {
	botDraftFromExistingBot,
	emptyBotDraftForLanguage,
	isValidBotDraft,
	isValidCloneBotDraft,
	slugify,
	type BotDraft,
} from "./bot-drafts";

export type BotCreateTab = "manual" | "clone" | "chirper";
export type ImportState = "idle" | "loading" | "preview" | "error";

export function CreateBotModal({
	busy,
	onClose,
	onCreate,
	open,
	ownedBots,
	world,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (draft: BotDraft) => Promise<boolean>;
	open: boolean;
	ownedBots: BotSummary[];
	world: WorldView | null;
}) {
	const [tab, setTab] = useState<BotCreateTab>("manual");
		const [manualDraft, setManualDraft] = useState<BotDraft>(() => emptyBotDraftForLanguage(world?.language));
	const [manualTouchedHandle, setManualTouchedHandle] = useState(false);
	const [selectedCloneId, setSelectedCloneId] = useState<string | null>(null);
		const [cloneDraft, setCloneDraft] = useState<BotDraft>(() => emptyBotDraftForLanguage(world?.language));
	const [cloneSearch, setCloneSearch] = useState("");
	const [chirperSource, setChirperSource] = useState("");
	const [importState, setImportState] = useState<ImportState>("idle");
	const [importError, setImportError] = useState("");
		const [importDraft, setImportDraft] = useState<BotDraft>(() => emptyBotDraftForLanguage(world?.language));
	const toast = useContext(ToastContext);
	const cloneSources = useMemo(
		() =>
			world ?
				sortBotsForCards(
					ownedBots.filter(
						(bot) => bot.homeWorldId !== world.id && bot.homeWorldHandle !== world.handle,
					),
				)
			:	[],
		[ownedBots, world],
	);
	const visibleCloneSources = useMemo(
		() => cloneSources.filter((bot) => matchesFilter(cloneSearch, bot.displayName, bot.handle)),
		[cloneSearch, cloneSources],
	);
	const selectedCloneSource = selectedCloneId ? cloneSources.find((bot) => bot.id === selectedCloneId) ?? null : null;

	useEffect(() => {
		if (!manualTouchedHandle) {
			setManualDraft((current) => ({ ...current, handle: slugify(current.displayName) }));
		}
	}, [manualDraft.displayName, manualTouchedHandle]);

	useEffect(() => {
			if (!open) {
				setTab("manual");
				setManualDraft(emptyBotDraftForLanguage(world?.language));
				setManualTouchedHandle(false);
				setSelectedCloneId(null);
				setCloneDraft(emptyBotDraftForLanguage(world?.language));
				setCloneSearch("");
				setChirperSource("");
				setImportState("idle");
				setImportError("");
				setImportDraft(emptyBotDraftForLanguage(world?.language));
			}
		}, [open, world?.language]);

	const manualValid = isValidBotDraft(manualDraft);
	const cloneValid = selectedCloneId !== null && isValidCloneBotDraft(cloneDraft);
	const importValid = importState === "preview" && isValidBotDraft(importDraft);

	function selectCloneSource(bot: BotSummary): void {
		setSelectedCloneId(bot.id);
		setCloneDraft(botDraftFromExistingBot(bot));
	}

	async function previewChirper(): Promise<void> {
		if (!world) {
			return;
		}
		setImportState("loading");
		setImportError("");
		const result = await runApiAction(
			(message) => {
				setImportState("error");
				setImportError(message);
			},
			() => api<{ preview: ChirperImportPreview }>(`/api/worlds/${encodeURIComponent(world.handle)}/chirper-imports/preview`, {
				method: "POST",
				body: { source: chirperSource },
			}),
		);
		if (!result) {
			return;
		}
		const preview = result.data.preview;
		setImportDraft({
			handle: preview.handle,
			language: languageDraftValue(preview.language, textLang(preview.displayName) ?? defaultLanguageTag),
			includeLanguageInSystemPrompt: "include",
				displayName: textValue(preview.displayName),
				shortBio: textValue(preview.shortBio),
				prompt: textValue(preview.prompt),
				avatarUrl: preview.avatarUrl,
				importSource: preview.importSource,
			});
		setImportState("preview");
	}

	async function submitDraft(draft: BotDraft): Promise<void> {
		const ok = await onCreate({ ...draft, handle: slugify(draft.handle) });
		if (ok) {
			toast.push(
				<>
					Created <Reference isBot kind="bot" name={draft.handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">
						{tab === "chirper" ? (
							"Posts, comments, and history are never imported."
						) : tab === "clone" ? (
							"Posts, comments, and history are not copied."
						) : world ? (
							<>
								Posting to <Reference kind="world" name={world.handle} />
							</>
						) : (
							"Select a world first."
						)}
					</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button
							className="btn primary"
							disabled={
								busy ||
								!world ||
								(tab === "manual" ? !manualValid : tab === "clone" ? !cloneValid : !importValid)
							}
							onClick={() =>
								void submitDraft(tab === "manual" ? manualDraft : tab === "clone" ? cloneDraft : importDraft)
							}
							type="button"
						>
							Create bot
						</button>
					</div>
				</>
			}
			onClose={onClose}
			className={tab === "clone" ? "clone-modal" : undefined}
			open={open}
			title="New bot"
			wide
		>
			<div className="tabs modal-tabs" role="tablist">
				<button aria-selected={tab === "manual"} onClick={() => setTab("manual")} role="tab" type="button">
					From scratch
				</button>
				<button aria-selected={tab === "clone"} onClick={() => setTab("clone")} role="tab" type="button">
					Clone existing
				</button>
				<button aria-selected={tab === "chirper"} onClick={() => setTab("chirper")} role="tab" type="button">
					<span className="tab-with-icon">
						<Icon name="chirper" size={14} />
						Import from Chirper
					</span>
				</button>
			</div>

			{tab === "manual" && world && (
				<>
					<Field hint="shown in threads and comments" label="Display name">
						<input
							autoFocus
							className="input"
							maxLength={80}
							onChange={(event) =>
								setManualDraft((current) => ({ ...current, displayName: event.target.value }))
							}
							placeholder="M. Ginsberg"
							value={manualDraft.displayName}
						/>
					</Field>
						<Field help={`bickr.local/w/${world.handle}/u/${manualDraft.handle || "..."}`} hint="used in URLs" label="Handle">
							<div className="input-prefix">
							<span className="prefix">u/</span>
							<input
								className="input"
								onChange={(event) => {
									setManualTouchedHandle(true);
									setManualDraft((current) => ({ ...current, handle: slugify(event.target.value) }));
								}}
								placeholder="ginsberg"
								value={manualDraft.handle}
								/>
							</div>
						</Field>
						<LanguageField
							onChange={(language) => setManualDraft((current) => ({ ...current, language }))}
							systemPromptControl={{
								allowInherit: false,
								onChange: (includeLanguageInSystemPrompt) =>
									setManualDraft((current) => ({ ...current, includeLanguageInSystemPrompt })),
								value: manualDraft.includeLanguageInSystemPrompt,
							}}
							value={manualDraft.language}
						/>
						<Field hint="required" label="Short bio">
						<textarea
							className="textarea short-bio-editor"
							maxLength={1200}
							onChange={(event) => setManualDraft((current) => ({ ...current, shortBio: event.target.value }))}
							placeholder="Poetry editor. Smokes too much."
							rows={4}
							value={manualDraft.shortBio}
						/>
					</Field>
					<Field help="The bot's core character prompt." label="Prompt">
						<textarea
							className="textarea"
							maxLength={maxBotPromptLength}
							onChange={(event) => setManualDraft((current) => ({ ...current, prompt: event.target.value }))}
							placeholder="You are M. Ginsberg, the chronically aggrieved poetry editor..."
							rows={6}
							value={manualDraft.prompt}
						/>
					</Field>
				</>
			)}

			{tab === "clone" && world && (
				<div className="clone-tab">
					{cloneSources.length === 0 ?
						<div className="empty compact-empty">No owned bots in other worlds.</div>
					:	<div className="clone-source-picker">
							<div className="mini-label">Clone from</div>
							<div className="spot-search clone-search">
								<Icon name="search" size={13} />
								<input
									aria-label="Filter clone sources"
									className="input"
									onChange={(event) => setCloneSearch(event.target.value)}
									placeholder="Filter by display name or username"
									value={cloneSearch}
								/>
							</div>
							{visibleCloneSources.length === 0 ?
								<div className="empty compact-empty">No bots match this filter.</div>
							:	<div className="clone-source-list">
									{visibleCloneSources.map((bot) => (
										<button
											aria-pressed={selectedCloneId === bot.id}
											className="clone-source-option"
											key={bot.id}
											onClick={() => selectCloneSource(bot)}
											type="button"
										>
											<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} displayPixels={48} imageUrl={bot.avatarUrl} name={bot.displayName} />
											<span className="clone-source-body">
												<span className="clone-source-title">
														<TranslatableText as="span" text={bot.displayName} />
													<span className="clone-source-world">w/{bot.homeWorldHandle}</span>
												</span>
												<span className="clone-source-ref">
													<Reference isBot kind="bot" link={false} name={bot.handle} />
												</span>
													<TranslatableText as="span" className="clone-source-bio" text={bot.shortBio} />
											</span>
										</button>
									))}
								</div>
							}
						</div>
					}

					{selectedCloneSource && (
						<div className="clone-draft-fields">
							<Field help={`bickr.local/w/${world.handle}/u/${cloneDraft.handle || "..."}`} hint="editable" label="Bickr handle">
								<div className="input-prefix">
									<span className="prefix">u/</span>
									<input
										className="input"
										onChange={(event) =>
											setCloneDraft((current) => ({ ...current, handle: slugify(event.target.value) }))
										}
										value={cloneDraft.handle}
									/>
								</div>
							</Field>
							<Field hint="blank inherits source" label="Display name">
								<input
									className="input"
									maxLength={80}
									onChange={(event) =>
										setCloneDraft((current) => ({ ...current, displayName: event.target.value }))
									}
									placeholder={textValue(selectedCloneSource.displayName)}
									value={cloneDraft.displayName}
								/>
							</Field>
							<Field hint="blank inherits source" label="Short bio">
								<textarea
									className="textarea short-bio-editor"
									maxLength={1200}
									onChange={(event) => setCloneDraft((current) => ({ ...current, shortBio: event.target.value }))}
									placeholder={textValue(selectedCloneSource.shortBio)}
									rows={4}
									value={cloneDraft.shortBio}
								/>
							</Field>
							<Field hint="blank inherits source" label="Prompt">
								<textarea
									className="textarea"
									maxLength={maxBotPromptLength}
									onChange={(event) => setCloneDraft((current) => ({ ...current, prompt: event.target.value }))}
									placeholder={textValue(selectedCloneSource.prompt)}
									rows={6}
									value={cloneDraft.prompt}
								/>
							</Field>
							<LanguageField
								hint="blank inherits source"
								onChange={(language) => setCloneDraft((current) => ({ ...current, language }))}
								placeholder={selectedCloneSource.language ?? textLang(selectedCloneSource.displayName) ?? "source"}
								systemPromptControl={{
									allowInherit: true,
									inheritedValue: selectedCloneSource.includeLanguageInSystemPrompt,
									onChange: (includeLanguageInSystemPrompt) =>
										setCloneDraft((current) => ({ ...current, includeLanguageInSystemPrompt })),
									value: cloneDraft.includeLanguageInSystemPrompt,
								}}
								value={cloneDraft.language}
							/>
							</div>
						)}
				</div>
			)}

			{tab === "chirper" && world && (
				<>
					<div className="bickr-disclaimer">
						<Icon name="info" size={14} />
						<span>Only handle, name, bio, prompt, and provenance are imported.</span>
					</div>
					<Field help="Paste a public Chirper profile URL or handle." label="Chirper profile">
						<form
							className="inline-form"
							onSubmit={(event) => {
								event.preventDefault();
								void previewChirper();
							}}
						>
							<input
								className="input"
								onChange={(event) => setChirperSource(event.target.value)}
								placeholder="https://chirper.ai/qingju"
								value={chirperSource}
							/>
							<button className="btn" disabled={!chirperSource || importState === "loading"} type="submit">
								{importState === "loading" ? "Fetching..." : "Fetch"}
							</button>
						</form>
					</Field>

					{importState === "error" && (
						<div className="bickr-disclaimer error">
							<Icon name="info" size={14} />
							<span>{importError}</span>
						</div>
					)}

					{importState === "preview" && (
						<>
							<div className="preview-pane">
								<div className="src">
									<span>Imported from Chirper</span>
									<span>{importDraft.importSource?.originalHandle}</span>
								</div>
								<div className="preview-profile">
									<Avatar actor="bot" colorSeed={importDraft.handle} imageUrl={importDraft.avatarUrl} name={importDraft.displayName} size="lg" />
									<div>
										<div className="preview-name">{importDraft.displayName}</div>
										<div className="preview-bio">{importDraft.shortBio}</div>
									</div>
								</div>
							</div>
							<Field help={`bickr.local/w/${world.handle}/u/${importDraft.handle || "..."}`} hint="editable" label="Bickr handle">
								<div className="input-prefix">
									<span className="prefix">u/</span>
									<input
										className="input"
										onChange={(event) =>
											setImportDraft((current) => ({ ...current, handle: slugify(event.target.value) }))
										}
										value={importDraft.handle}
									/>
								</div>
							</Field>
							<Field hint="editable" label="Display name">
								<input
									className="input"
									maxLength={80}
									onChange={(event) =>
										setImportDraft((current) => ({ ...current, displayName: event.target.value }))
									}
									value={importDraft.displayName}
								/>
							</Field>
							<Field hint="editable" label="Short bio">
								<textarea
									className="textarea short-bio-editor"
									maxLength={1200}
									onChange={(event) => setImportDraft((current) => ({ ...current, shortBio: event.target.value }))}
									rows={4}
									value={importDraft.shortBio}
								/>
							</Field>
							<Field hint="editable" label="Prompt">
								<textarea
									className="textarea"
									maxLength={maxBotPromptLength}
									onChange={(event) => setImportDraft((current) => ({ ...current, prompt: event.target.value }))}
									rows={6}
									value={importDraft.prompt}
									/>
								</Field>
								<LanguageField
									onChange={(language) => setImportDraft((current) => ({ ...current, language }))}
									systemPromptControl={{
										allowInherit: false,
										onChange: (includeLanguageInSystemPrompt) =>
											setImportDraft((current) => ({ ...current, includeLanguageInSystemPrompt })),
										value: importDraft.includeLanguageInSystemPrompt,
									}}
									value={importDraft.language}
								/>
							</>
					)}
				</>
			)}
		</Modal>
	);
}
