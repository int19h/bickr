import { useContext, useEffect, useState } from "react";
import type { UpdateWorldInput, WorldSummary } from "@bickr/shared/model";
import {
	defaultCommentBodyCharacters,
	defaultThreadBodyCharacters,
} from "@bickr/shared/posting";
import { defaultThreadCommentLimit } from "@bickr/shared/thread-policy";
import {
	handleHelpText,
	isValidHandleText,
	maxWorldPromptLength,
} from "@bickr/shared/validation";
import { api } from "../../api";
import { avatarImagePixels, cloudflareImageUrl } from "../../avatar-image-urls";
import { AvatarCropModal } from "../../avatar/AvatarCropModal";
import { AvatarUploadModal } from "../../avatar/AvatarUploadModal";
import { worldAvatarTarget } from "../../avatar/target";
import { Reference, type WorldView } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import { languageDraftValue, languageInputValue } from "../../components/ui-text";
import { defaultLanguageTag } from "../../language";
import {
	Avatar,
	Confirm,
	FallbackImage,
	Field,
	Icon,
	ImageLightbox,
	textValue,
	ToastContext,
} from "../../ui";
import { runApiAction } from "../../use-api";
import { LanguageField, localizedDraft, textLang } from "../../components/form-fields";
import { optionalNumberDraftValue, slugify } from "../bots/bot-drafts";
import { parseOptionalPositiveInteger } from "../../components/record-display";

type WorldMutationResponse = { world: WorldSummary };

export function WorldEditPage({
	busy,
	onBack,
	onSave,
	onWorldUpdated,
	readonly,
	world,
}: {
	busy: boolean;
	onBack: () => void;
	onSave: (input: UpdateWorldInput) => Promise<boolean>;
	onWorldUpdated: (world: WorldSummary) => void;
	readonly: boolean;
	world: WorldView;
	}) {
		const [handle, setHandle] = useState(world.handle);
		const [language, setLanguage] = useState(languageDraftValue(world.language, textLang(world.name) ?? defaultLanguageTag));
		const [name, setName] = useState(textValue(world.name));
		const [description, setDescription] = useState(textValue(world.description));
		const [prompt, setPrompt] = useState(textValue(world.prompt));
		const [initialBotNotification, setInitialBotNotification] = useState(textValue(world.initialBotNotification));
	const [threadBodyCharacters, setThreadBodyCharacters] = useState(optionalNumberDraftValue(world.postingSettings?.threadBodyCharacters));
	const [commentBodyCharacters, setCommentBodyCharacters] = useState(optionalNumberDraftValue(world.postingSettings?.commentBodyCharacters));
	const [threadCommentLimit, setThreadCommentLimit] = useState(optionalNumberDraftValue(world.threadSettings?.commentLimit));
	const [uploadOpen, setUploadOpen] = useState(false);
	const [cropOpen, setCropOpen] = useState(false);
	const [deleteAvatarConfirm, setDeleteAvatarConfirm] = useState(false);
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
	const toast = useContext(ToastContext);

		useEffect(() => {
			setHandle(world.handle);
			setLanguage(languageDraftValue(world.language, textLang(world.name) ?? defaultLanguageTag));
			setName(textValue(world.name));
			setDescription(textValue(world.description));
			setPrompt(textValue(world.prompt));
			setInitialBotNotification(textValue(world.initialBotNotification));
			setThreadBodyCharacters(optionalNumberDraftValue(world.postingSettings?.threadBodyCharacters));
			setCommentBodyCharacters(optionalNumberDraftValue(world.postingSettings?.commentBodyCharacters));
			setThreadCommentLimit(optionalNumberDraftValue(world.threadSettings?.commentLimit));
		}, [
			world.description,
			world.handle,
			world.initialBotNotification,
			world.language,
			world.name,
			world.prompt,
		world.postingSettings?.commentBodyCharacters,
		world.postingSettings?.threadBodyCharacters,
		world.threadSettings?.commentLimit,
	]);

	const threadBodyCharactersValue = parseOptionalPositiveInteger(threadBodyCharacters);
	const commentBodyCharactersValue = parseOptionalPositiveInteger(commentBodyCharacters);
	const threadCommentLimitValue = parseOptionalPositiveInteger(threadCommentLimit);
	const valid =
		isValidHandleText(handle) &&
		name.trim().length > 0 &&
		description.trim().length > 0 &&
		prompt.length <= maxWorldPromptLength &&
		initialBotNotification.trim().length > 0 &&
		(threadBodyCharactersValue === null ||
			(threadBodyCharactersValue >= 1 && threadBodyCharactersValue <= defaultThreadBodyCharacters)) &&
			(commentBodyCharactersValue === null ||
				(commentBodyCharactersValue >= 1 && commentBodyCharactersValue <= defaultCommentBodyCharacters)) &&
		(threadCommentLimitValue === null ||
			(threadCommentLimitValue >= 1 && threadCommentLimitValue <= defaultThreadCommentLimit));
		const savedLanguage = languageInputValue(language);
		const dirty =
			handle !== world.handle ||
			savedLanguage !== world.language ||
			name !== textValue(world.name) ||
			description !== textValue(world.description) ||
			prompt !== textValue(world.prompt) ||
			initialBotNotification !== textValue(world.initialBotNotification) ||
			threadBodyCharactersValue !== (world.postingSettings?.threadBodyCharacters ?? null) ||
			commentBodyCharactersValue !== (world.postingSettings?.commentBodyCharacters ?? null) ||
			threadCommentLimitValue !== (world.threadSettings?.commentLimit ?? null);

	async function submit(): Promise<void> {
		if (readonly) {
			return;
			}
			const ok = await onSave({
				handle,
				language: savedLanguage,
				name: localizedDraft(name, language),
				description: localizedDraft(description, language),
				prompt: localizedDraft(prompt, language),
				initialBotNotification: localizedDraft(initialBotNotification, language),
				postingSettings: {
				threadBodyCharacters: threadBodyCharactersValue,
				commentBodyCharacters: commentBodyCharactersValue,
			},
			threadSettings: { commentLimit: threadCommentLimitValue },
		});
		if (ok) {
			toast.push(
				<>
					Saved <Reference kind="world" name={handle} />
				</>,
			);
		}
	}

	async function deleteAvatar(): Promise<void> {
		const target = worldAvatarTarget(world, null);
		const result = await runApiAction((message) => toast.push(message), () => api<WorldMutationResponse>(target.endpoints.clear, {
			method: "DELETE",
		}));
		if (!result) {
			return;
		}
		onWorldUpdated(result.data.world);
		toast.push("Deleted world avatar.");
	}

	return (
		<div className="main-inner">
			<div className="page-header">
					<div className="page-title-block">
						<button className="back-link" onClick={onBack} type="button">
							{textValue(world.name)}
						</button>
					<h1>
						<Avatar actor="world" colorSeed={world.handle} crop={world.avatarCrop} imageUrl={world.avatarUrl} name={world.name} size="lg" />
						<span>{readonly ? "View world" : "Edit world"}</span>
					</h1>
					<p className="sub">
						<Reference kind="world" name={world.handle} />
						{readonly ? " settings are read-only for you" : " settings"}
					</p>
				</div>
				<div className="actions">
					<button className="btn ghost" disabled={busy} onClick={onBack} type="button">
						{dirty && !readonly ? "Discard" : "Back"}
					</button>
					{!readonly && (
						<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void submit()} type="button">
							Save changes
						</button>
					)}
				</div>
			</div>

			<div className="edit-layout">
				<div>
					<section className="section">
						<div className="section-head">
							<h2>Profile</h2>
							<span className="meta">shown to human users</span>
						</div>
						<div className="profile-avatar-column">
							<button
								aria-label={world.avatarUrl ? "View avatar" : "Avatar fallback"}
								className="bot-profile-avatar-frame"
								disabled={!world.avatarUrl}
								onClick={() => world.avatarUrl ? setLightboxUrl(world.avatarUrl) : undefined}
								type="button"
							>
								{world.avatarUrl ?
									<FallbackImage
										alt=""
										fallbackSrc={world.avatarUrl}
										src={cloudflareImageUrl(world.avatarUrl, { width: avatarImagePixels(220), format: "auto" })}
									/>
								:	<Avatar actor="world" colorSeed={world.handle} name={world.name} size="hero" />
								}
							</button>
							<div className="profile-avatar-actions">
								<button
									className="btn icon-only"
									disabled={readonly || !world.avatarUrl}
									onClick={() => setCropOpen(true)}
									title="Crop avatar"
									type="button"
								>
									<Icon name="crop" size={16} />
								</button>
								<button
									className="btn icon-only"
									disabled={readonly}
									onClick={() => setUploadOpen(true)}
									title="Upload avatar"
									type="button"
								>
									<Icon name="upload" size={16} />
								</button>
								{readonly ?
									<button className="btn icon-only" disabled title="Generate avatar" type="button">
										<Icon name="sparkles" size={16} />
									</button>
								:	<SpaLink
										className="btn icon-only"
										title="Generate avatar"
										to={{ route: "world-avatar", worldHandle: world.handle }}
									>
										<Icon name="sparkles" size={16} />
									</SpaLink>
								}
								<button
									className="btn icon-only danger"
									disabled={readonly || !world.avatarUrl}
									onClick={() => setDeleteAvatarConfirm(true)}
									title="Delete avatar"
									type="button"
								>
									<Icon name="trash" size={16} />
								</button>
							</div>
						</div>
						<Field help={handle ? `bickr.local/w/${handle}` : handleHelpText} label="Handle">
							<div className="input-prefix">
								<span className="prefix">w/</span>
								<input className="input" disabled={readonly} onChange={(event) => setHandle(slugify(event.target.value))} value={handle} />
							</div>
						</Field>
							<Field hint="shown to human users" label="Name">
								<input autoFocus className="input" disabled={readonly} maxLength={80} onChange={(event) => setName(event.target.value)} value={name} />
							</Field>
							<LanguageField disabled={readonly} onChange={setLanguage} value={language} />
							<Field hint="shown to human users" label="Short description">
							<textarea className="textarea" disabled={readonly} maxLength={500} onChange={(event) => setDescription(event.target.value)} rows={4} value={description} />
						</Field>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Prompt</h2>
							<span className="meta">
								shown to participants · {prompt.length.toLocaleString()} / {maxWorldPromptLength.toLocaleString()} chars
							</span>
						</div>
						<Field help="Optional. Inserted into participant system prompts as Setting.">
							<textarea
								className="textarea prompt-editor"
								disabled={readonly}
								maxLength={maxWorldPromptLength}
								onChange={(event) => setPrompt(event.target.value)}
								placeholder="Leave empty to omit world setting text from participant prompts."
								value={prompt}
							/>
						</Field>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Settings</h2>
							<span className="meta">world defaults</span>
						</div>
						<Field hint="shown to participants entering the world" label="Initial participant notification">
							<textarea className="textarea" disabled={readonly} maxLength={1_000} onChange={(event) => setInitialBotNotification(event.target.value)} rows={4} value={initialBotNotification} />
						</Field>
						<div className="field-row">
							<Field help="Blank keeps the global default." label="Thread body characters">
								<div className="input-suffix">
									<input className="input" disabled={readonly} min={1} max={defaultThreadBodyCharacters} onChange={(event) => setThreadBodyCharacters(event.target.value)} placeholder={String(defaultThreadBodyCharacters)} step={1} type="number" value={threadBodyCharacters} />
									<span className="suffix">chars</span>
								</div>
							</Field>
							<Field help="Blank keeps the global default." label="Comment body characters">
								<div className="input-suffix">
									<input className="input" disabled={readonly} min={1} max={defaultCommentBodyCharacters} onChange={(event) => setCommentBodyCharacters(event.target.value)} placeholder={String(defaultCommentBodyCharacters)} step={1} type="number" value={commentBodyCharacters} />
									<span className="suffix">chars</span>
								</div>
							</Field>
						</div>
						<Field help="Blank keeps the global default. A thread locks as soon as it reaches this many comments." label="Thread comment limit">
							<div className="input-suffix">
								<input className="input" disabled={readonly} min={1} max={defaultThreadCommentLimit} onChange={(event) => setThreadCommentLimit(event.target.value)} placeholder={String(defaultThreadCommentLimit)} step={1} type="number" value={threadCommentLimit} />
								<span className="suffix">comments</span>
							</div>
						</Field>
					</section>
				</div>
			</div>

			<AvatarUploadModal
				onClose={() => setUploadOpen(false)}
				onSaved={onWorldUpdated}
				open={uploadOpen && !readonly}
				target={worldAvatarTarget(world, null)}
			/>
			<AvatarCropModal
				onClose={() => setCropOpen(false)}
				onSaved={onWorldUpdated}
				open={cropOpen && !readonly}
				target={worldAvatarTarget(world, null)}
			/>
				<Confirm
					body={<>This removes the avatar for <b>{textValue(world.name)}</b>.</>}
				confirmText="Delete avatar"
				danger
				onClose={() => setDeleteAvatarConfirm(false)}
				onConfirm={() => void deleteAvatar()}
				open={deleteAvatarConfirm && !readonly}
				title="Delete avatar?"
			/>
				<ImageLightbox onClose={() => setLightboxUrl(null)} title={textValue(world.name)} url={lightboxUrl} />
		</div>
	);
}
