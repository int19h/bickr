import {
	authProviders,
	defaultTranslationPrompt,
	localizedText,
	type AuthProvider,
	type LinkedAuthIdentity,
	type PublicUser,
	type UpdateUserProfileInput,
	type UserProfile,
} from "@bickr/shared/model";
import { useContext, useEffect, useState } from "react";
import { api } from "../../api";
import { avatarImagePixels, cloudflareImageUrl } from "../../avatar-image-urls";
import { AvatarCropModal } from "../../avatar/AvatarCropModal";
import { AvatarUploadModal } from "../../avatar/AvatarUploadModal";
import { userAvatarTarget } from "../../avatar/target";
import { languageDraftValue, languageInputValue, uiLocaleOptions, useUiText } from "../../components/ui-text";
import { defaultLanguageTag } from "../../language";
import { runApiAction } from "../../use-api";
import { Avatar, Confirm, FallbackImage, Field, Icon, ImageLightbox, ToastContext, textValue } from "../../ui";
import { RuntimeRow, isValidHandle, slugify } from "../bots";
import { authProviderLabel, authStartHref } from "../chrome";
import { FixedConfigurationAction, fixedConfigurationReference, useFixedConfiguration } from "../../inference/links";
import { LanguageField, textLang } from "../../components/form-fields";
import { TimeAgoLabel } from "../../components/record-display";

type UserMutationResponse = { profile: UserProfile };

export type ProfileDraft = {
	handle: string;
	language: string;
	uiLocale: string;
	displayName: string;
	/** Prompt-adjacent translation data stays here; inference does not. */
	translationEnabled: boolean;
	translationPrompt: string;
};

export function ProfileScreen({
	busy,
	onAuthIdentityUnlink,
	onAvatarUpdated,
	onOpenAvatarGeneration,
	onSave,
	onSignOut,
	user,
}: {
	busy: boolean;
	onAuthIdentityUnlink: (provider: AuthProvider) => Promise<UserProfile | null>;
	onAvatarUpdated: (profile: UserProfile) => void;
	onOpenAvatarGeneration: () => void;
	onSave: (draft: UpdateUserProfileInput) => Promise<UserProfile | null>;
	onSignOut: () => void;
	user: PublicUser;
}) {
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [draft, setDraft] = useState<ProfileDraft>(() => profileDraftFromUser(user));
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState("");
	const [pendingUnlinkProvider, setPendingUnlinkProvider] = useState<AuthProvider | null>(null);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [cropOpen, setCropOpen] = useState(false);
	const [deleteAvatarConfirm, setDeleteAvatarConfirm] = useState(false);
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
	const [profileAvatarFailed, setProfileAvatarFailed] = useState(false);
	const toast = useContext(ToastContext);
	const t = useUiText();

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void api<{ profile: UserProfile }>("/api/me/profile").then((result) => {
			if (cancelled) {
				return;
			}
			if (result.ok) {
				setProfile(result.data.profile);
				setDraft(profileDraftFromProfile(result.data.profile));
				setMessage("");
			} else {
				setMessage(result.message);
			}
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [user.id]);

	useEffect(() => {
		setProfileAvatarFailed(false);
	}, [profile?.avatarUrl, user.avatarUrl]);

	const profileIncomplete = !(profile?.profileComplete ?? user.profileComplete);
	const avatarProfile = profile ?? user;
	const authIdentities = profile?.authIdentities ?? [];
	const dirty = profile ? profileDraftChanged(draft, profile) : true;
	const valid = isValidHandle(draft.handle) && draft.displayName.trim().length > 0;
	const canSave = (dirty || profileIncomplete) && valid && !busy && !loading;
	const accountConfigurationTarget = { kind: "account_default" } as const;
	const accountConfiguration = useFixedConfiguration(fixedConfigurationReference(accountConfigurationTarget));
	const translationConfigurationTarget = { kind: "translation" } as const;
	const savedTranslationReference = savedTranslationConfigurationReference(profile);
	const savedTranslationEnabled = savedTranslationReference !== null;
	const translationConfiguration = useFixedConfiguration(
		savedTranslationReference,
	);

	async function save(): Promise<void> {
		const language = languageInputValue(draft.language);
		const saved = await onSave({
			handle: draft.handle,
			language,
			uiLocale: draft.uiLocale === "system" ? "system" : languageInputValue(draft.uiLocale) ?? defaultLanguageTag,
			displayName: localizedText(draft.displayName, language),
			// Only the prompt-owned translation fields travel with the profile; the
			// reusable inference fields live in the graph and are never rewritten by
			// an ordinary profile save.
			inferenceSettings: {
				translation: {
					enabled: draft.translationEnabled,
					prompt: draft.translationPrompt.trim() ? localizedText(draft.translationPrompt, language) : null,
				},
			},
		});
		if (saved) {
			setProfile(saved);
			setDraft(profileDraftFromProfile(saved));
			toast.push(t.profile.savedProfile);
		}
	}

	async function unlinkAuthIdentity(provider: AuthProvider): Promise<void> {
		const saved = await onAuthIdentityUnlink(provider);
		if (saved) {
			setProfile(saved);
			toast.push(`Unlinked ${authProviderLabel(provider)}`);
		}
	}

	function applySavedAvatarProfile(saved: UserProfile): void {
		setProfile(saved);
		onAvatarUpdated(saved);
	}

	async function deleteAvatar(): Promise<void> {
		const target = userAvatarTarget(avatarProfile);
		const result = await runApiAction(setMessage, () => api<UserMutationResponse>(target.endpoints.clear, { method: "DELETE" }));
		if (!result) {
			return;
		}
		applySavedAvatarProfile(result.data.profile);
		setDeleteAvatarConfirm(false);
		toast.push("Deleted avatar");
	}

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<h1>
						<Avatar
							actor="user"
							colorSeed={draft.handle || user.handle}
							crop={avatarProfile.avatarCrop}
							imageUrl={avatarProfile.avatarUrl}
							name={draft.displayName || user.displayName}
							size="lg"
						/>
						<span>{draft.displayName || textValue(user.displayName)}</span>
					</h1>
					<p className="sub">
						{profileIncomplete ?
							t.profile.subtitleIncomplete
						:	t.profile.subtitleReady}
					</p>
				</div>
				<div className="actions">
					<button className="btn ghost" disabled={busy} onClick={onSignOut} type="button">
						{t.profile.signOut}
					</button>
					<button className="btn primary" disabled={!canSave} onClick={() => void save()} type="button">
						{profileIncomplete ? t.profile.saveAndActivate : t.profile.saveProfile}
					</button>
				</div>
			</div>

			{profileIncomplete && (
				<div className="setup-banner">
					<Icon name="info" size={16} />
					<div>
						<b>{t.profile.setupRequiredTitle}</b>
						<span>
							{t.profile.setupRequiredBody}
						</span>
					</div>
				</div>
			)}

			<div className="edit-layout">
				<div>
					<section className="section">
						<div className="section-head">
							<h2>{t.profile.sectionTitle}</h2>
							<span className="meta">{loading ? t.profile.loading : profileIncomplete ? t.profile.setupRequiredMeta : t.profile.editable}</span>
						</div>
						<div className="field-stack">
							<div className="field-row">
								<Field label={t.profile.displayName}>
									<input
										className="input"
										maxLength={80}
										onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
										value={draft.displayName}
									/>
								</Field>
								<Field help={t.profile.handleHelp} label={t.profile.handle}>
									<div className="input-prefix">
										<span className="prefix">hu/</span>
										<input
											className="input"
											onChange={(event) => setDraft((current) => ({ ...current, handle: slugify(event.target.value) }))}
											value={draft.handle}
										/>
									</div>
								</Field>
							</div>
								<div className="profile-avatar-editor">
									<div className="profile-avatar-column">
										<button
											aria-label={avatarProfile.avatarUrl && !profileAvatarFailed ? "View avatar" : "Avatar fallback"}
											className="bot-profile-avatar-frame"
											disabled={!avatarProfile.avatarUrl || profileAvatarFailed}
											onClick={() => avatarProfile.avatarUrl && !profileAvatarFailed ? setLightboxUrl(avatarProfile.avatarUrl) : undefined}
											type="button"
										>
											{avatarProfile.avatarUrl && !profileAvatarFailed ?
												<FallbackImage
													alt=""
													fallbackSrc={avatarProfile.avatarUrl}
													onFinalError={() => setProfileAvatarFailed(true)}
													src={cloudflareImageUrl(avatarProfile.avatarUrl, { width: avatarImagePixels(220), format: "auto" })}
												/>
											:	<Avatar actor="user" colorSeed={draft.handle || user.handle} name={draft.displayName || user.displayName} size="hero" />
											}
										</button>
										<div className="profile-avatar-actions">
											<button
												className="btn icon-only"
												disabled={!avatarProfile.avatarUrl || profileAvatarFailed}
												onClick={() => setCropOpen(true)}
												title="Crop avatar"
												type="button"
											>
												<Icon name="crop" size={16} />
											</button>
											<button className="btn icon-only" onClick={() => setUploadOpen(true)} title="Upload avatar" type="button">
												<Icon name="upload" size={16} />
											</button>
											<button className="btn icon-only" onClick={onOpenAvatarGeneration} title="Generate avatar" type="button">
												<Icon name="sparkles" size={16} />
											</button>
											<button
												className="btn icon-only danger"
												disabled={!avatarProfile.avatarUrl}
												onClick={() => setDeleteAvatarConfirm(true)}
												title="Delete avatar"
												type="button"
											>
												<Icon name="trash" size={16} />
											</button>
										</div>
									</div>
								</div>
								<div className="field-row">
									<LanguageField
										label={t.profile.accountLanguage}
										onChange={(language) => setDraft((current) => ({ ...current, language }))}
										value={draft.language}
									/>
									<Field help={t.profile.uiLanguageHelp} label={t.profile.uiLanguage}>
										<select
											className="input"
											onChange={(event) => setDraft((current) => ({ ...current, uiLocale: event.target.value }))}
											value={draft.uiLocale}
										>
											{uiLocaleOptions.map((option) => (
												<option key={option.value} value={option.value}>
													{option.value === "system" ? t.profile.systemUiLanguage : option.label}
												</option>
											))}
										</select>
									</Field>
								</div>
								{message && <div className="runtime-message">{message}</div>}
							</div>
						</section>

					<section className="section">
						<div className="section-head">
							<h2>Account default configuration</h2>
							<span className="meta">reusable inference</span>
						</div>
						<p className="help">
							Account default supplies provider, model, loop, compaction, and image inference for everything you own that does not override it.
						</p>
						<FixedConfigurationAction state={accountConfiguration} target={accountConfigurationTarget} />
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Inline translations</h2>
							<span className="meta">profile and inference</span>
						</div>
						<div className="field-stack">
							<label className="checkbox-line">
								<input
									checked={draft.translationEnabled}
									onChange={(event) => setDraft((current) => ({ ...current, translationEnabled: event.target.checked }))}
									type="checkbox"
								/>
								<span>Inline translations</span>
							</label>
							<Field help="Sent with the source text for each translation request." label="Translation prompt">
								<textarea
									className="textarea"
									onChange={(event) => setDraft((current) => ({ ...current, translationPrompt: event.target.value }))}
									placeholder={defaultTranslationPrompt}
									rows={4}
									value={draft.translationPrompt}
								/>
							</Field>
							{savedTranslationEnabled ?
								<FixedConfigurationAction state={translationConfiguration} target={translationConfigurationTarget} />
							: 	<p className="help">Save with inline translations enabled to create and edit the Translation configuration.</p>}
						</div>
					</section>
				</div>

				<aside className="edit-aside">
					<section className="section">
						<div className="section-head">
							<h2>Account</h2>
						</div>
						<div className="card runtime-card">
							<RuntimeRow label="User" value={`hu/${draft.handle || user.handle}`} />
							<RuntimeRow label="Status" value={profileIncomplete ? "setup required" : "active"} />
							{authProviders.map((provider) => (
								<AuthIdentityRuntimeRow
									busy={busy || loading}
									identity={authIdentities.find((item) => item.provider === provider) ?? null}
									key={provider}
									onUnlink={(nextProvider) => setPendingUnlinkProvider(nextProvider)}
									provider={provider}
									unlinkable={authIdentities.length > 1}
								/>
							))}
							<RuntimeRow
								label="Inference"
								value={accountConfiguration.configuration?.effectiveModel ?? "..."}
							/>
							<RuntimeRow label="Created" value={profile ? <TimeAgoLabel value={profile.createdAt} /> : "..."} />
							<RuntimeRow label="Updated" value={profile ? <TimeAgoLabel value={profile.updatedAt} /> : "..."} />
						</div>
					</section>
				</aside>
			</div>
			<Confirm
				body={
					pendingUnlinkProvider ?
						`Remove ${authProviderLabel(pendingUnlinkProvider)} as a sign-in method for this account?`
					:	"Remove this sign-in method?"
				}
				confirmText="Unlink"
				danger
				onClose={() => setPendingUnlinkProvider(null)}
				onConfirm={() => {
					if (pendingUnlinkProvider) {
						void unlinkAuthIdentity(pendingUnlinkProvider);
					}
				}}
				open={Boolean(pendingUnlinkProvider)}
				title="Unlink sign-in method?"
			/>
			<AvatarUploadModal
				onClose={() => setUploadOpen(false)}
				onSaved={(saved) => applySavedAvatarProfile(saved)}
				open={uploadOpen}
				target={userAvatarTarget(avatarProfile)}
			/>
			<AvatarCropModal
				onClose={() => setCropOpen(false)}
				onSaved={(saved) => applySavedAvatarProfile(saved)}
				open={cropOpen}
				target={userAvatarTarget(avatarProfile)}
			/>
			<Confirm
				body="Delete this profile avatar? You can upload or generate a new one later."
				confirmText="Delete avatar"
				danger
				onClose={() => setDeleteAvatarConfirm(false)}
				onConfirm={() => void deleteAvatar()}
				open={deleteAvatarConfirm}
				title="Delete avatar?"
			/>
			<ImageLightbox onClose={() => setLightboxUrl(null)} title={draft.displayName || textValue(user.displayName)} url={lightboxUrl} />
		</div>
	);
}

function AuthIdentityRuntimeRow({
	busy,
	identity,
	onUnlink,
	provider,
	unlinkable,
}: {
	busy: boolean;
	identity: LinkedAuthIdentity | null;
	onUnlink: (provider: AuthProvider) => void;
	provider: AuthProvider;
	unlinkable: boolean;
}) {
	return (
		<RuntimeRow
			label={authProviderLabel(provider)}
			value={
				<div className="auth-provider-value">
					<span className="auth-provider-login">{identity ? identity.providerLogin : "not linked"}</span>
					{identity ?
						<button
							className="btn ghost compact"
							disabled={busy || !unlinkable}
							onClick={() => onUnlink(provider)}
							title={unlinkable ? `Unlink ${authProviderLabel(provider)}` : "Link another sign-in method first"}
							type="button"
						>
							Unlink
						</button>
					:	<a className={`btn ghost compact ${busy ? "disabled" : ""}`} href={authStartHref(provider, "/me/profile")}>
							Link
						</a>
					}
				</div>
			}
		/>
	);
}

function profileDraftFromUser(user: PublicUser): ProfileDraft {
	return {
		handle: user.handle,
		language: languageDraftValue(user.language, textLang(user.displayName) ?? defaultLanguageTag),
		uiLocale: user.uiLocale ?? "system",
		displayName: textValue(user.displayName),
		translationEnabled: false,
		translationPrompt: "",
	};
}

export function profileDraftFromProfile(profile: UserProfile): ProfileDraft {
	return {
		handle: profile.handle,
		language: languageDraftValue(profile.language, textLang(profile.displayName) ?? defaultLanguageTag),
		uiLocale: profile.uiLocale ?? "system",
		displayName: textValue(profile.displayName),
		translationEnabled: profile.translationInference?.enabled ?? Boolean(profile.inferenceSettings.translation?.enabled),
		translationPrompt: textValue(profile.inferenceSettings.translation?.prompt ?? ""),
	};
}

export function savedTranslationConfigurationReference(profile: UserProfile | null) {
	return profile?.translationInference?.enabled === true ? ({ kind: "translation" } as const) : null;
}

function profileDraftChanged(draft: ProfileDraft, profile: UserProfile): boolean {
	const language = languageInputValue(draft.language);
	const uiLocale = draft.uiLocale === "system" ? "system" : languageInputValue(draft.uiLocale) ?? defaultLanguageTag;
	const saved = profileDraftFromProfile(profile);
	return (
		draft.handle !== profile.handle ||
		language !== profile.language ||
		uiLocale !== (profile.uiLocale ?? "system") ||
		draft.displayName !== textValue(profile.displayName) ||
		draft.translationEnabled !== saved.translationEnabled ||
		draft.translationPrompt !== saved.translationPrompt
	);
}
