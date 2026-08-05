import {
	contextWindowTokensMax,
	contextWindowTokensMin,
	defaultReasoningPrefill,
	localizedText,
	type BotContextBudget,
	type BotSummary,
	type ForumSummary,
	type LanguageTag,
	type UpdateBotInput,
} from "@bickr/shared/model";
import { effectivePostingSettings } from "@bickr/shared/posting";
import { maxBotPromptLength, maxBotReasoningPrefillLength } from "@bickr/shared/validation";
import { useContext, useEffect, useState } from "react";
import { isOpenRouterProviderBaseUrl } from "@bickr/shared/inference-settings";
import { api } from "../../api";
import { OpenRouterServerToolFields } from "../../components/openrouter-tool-fields";
import { ConfigurationLinkCard, useFixedConfiguration } from "../../inference/links";
import { LanguageField, RenameHandleModal, textLang } from "../../components/form-fields";
import { TimeAgoLabel } from "../../components/record-display";
import { BotSourceValue, Reference, type WorldView } from "../../components/content";
import { languageInputValue, textLanguageDomProps } from "../../components/ui-text";
import { defaultLanguageTag } from "../../language";
import { toolInputFromDraft } from "../../tool-settings-draft";
import { Avatar, Confirm, Field, Icon, ToastContext, textValue } from "../../ui";
import {
	botEditDraftFromBot,
	botEditableInferenceSettings,
	botPromptBudgetRequestKey,
	effectiveIncludeLanguageInSystemPromptDraft,
	includeLanguageInSystemPromptInputFromDraft,
	parseBotEditDraft,
	toolDraftChanged,
	toolDraftValid,
	updateBotInputFromEditDraft,
	type BotEditDraft,
} from "./bot-drafts";
import { RuntimeRow } from "./runtime-row";
import { secondsToMinutes } from "./runtime-utils";
import { formatExactTokenCount, formatTokenCount } from "./token-usage";

export type PromptBudgetState =
	| { status: "idle" }
	| { status: "loading"; requestKey: string }
	| { status: "ready"; budget: BotContextBudget; requestKey: string }
	| { status: "error"; message: string; requestKey: string };

export function BotEdit({
	bot,
	busy,
	onBack,
	onDelete,
	onRelinkClone,
	onSave,
	onUnlinkClone,
	personalForum,
	personalForumsLoaded,
	world,
}: {
	bot: BotSummary;
	busy: boolean;
	onBack: () => void;
	onDelete: (bot: BotSummary) => Promise<boolean>;
	onRelinkClone: (bot: BotSummary) => Promise<boolean>;
	onSave: (botId: string, draft: UpdateBotInput) => Promise<boolean>;
	onUnlinkClone: (bot: BotSummary) => Promise<boolean>;
	personalForum: ForumSummary | null;
	personalForumsLoaded: boolean;
	world: WorldView | null;
}) {
	const [draft, setDraft] = useState<BotEditDraft>(() => botEditDraftFromBot(bot));
	const configuration = useFixedConfiguration({ kind: "bot", botId: bot.id });
	const [confirm, setConfirm] = useState(false);
	const [cloneLinkConfirm, setCloneLinkConfirm] = useState<"unlink" | "relink" | null>(null);
	const [renameOpen, setRenameOpen] = useState(false);
	const [promptBudget, setPromptBudget] = useState<PromptBudgetState>({ status: "idle" });
	const toast = useContext(ToastContext);

	useEffect(() => {
		setDraft(botEditDraftFromBot(bot));
	}, [
		bot.displayName,
		bot.id,
		bot.includeLanguageInSystemPrompt,
		bot.inferenceSettings,
		bot.language,
		bot.localOverrides,
		bot.prompt,
		bot.shortBio,
		bot.postingSettings.commentBodyCharacters,
		bot.postingSettings.threadBodyCharacters,
		bot.toolSettings,
		bot.effectiveTickSettings.allowEarlyLogOff,
		bot.tickSettings.contextWindowTokens,
		bot.tickSettings.compactionSummaryPercent,
		bot.tickSettings.compactionMaxCharacters,
		bot.tickSettings.intervalSeconds,
		bot.tickSettings.maxToolCallsPerTick,
		bot.tickSettings.maxSuccessfulToolCallsPerIteration,
		bot.tickSettings.maxGeneratedTokensPerTick,
		bot.tickSettings.maxGeneratedTokensPerIteration,
		bot.updatedAt,
	]);

	const parsedDraft = parseBotEditDraft(draft);
	const {
		tickIntervalMinutes,
		contextWindowTokens,
		compactionSummaryPercent,
		compactionMaxCharacters,
		maxToolCallsPerTick,
		maxSuccessfulToolCallsPerIteration,
		maxGeneratedTokensPerTick,
		maxGeneratedTokensPerIteration,
		threadBodyCharacters,
		commentBodyCharacters,
	} = parsedDraft;
	const inheritedPostingSettings = effectivePostingSettings(world?.postingSettings, undefined);
	const resolvedContextWindowTokens = contextWindowTokens ?? bot.effectiveTickSettings.contextWindowTokens;
	const linkedClone = Boolean(bot.cloneSource?.linked);
	const savedLanguage = bot.localOverrides ? bot.localOverrides.language : bot.language;
	const savedIncludeLanguageInSystemPrompt = linkedClone ?
		bot.localOverrides?.includeLanguageInSystemPrompt ?? null
	:	bot.includeLanguageInSystemPrompt ?? false;
	const savedDisplayName = textValue(bot.localOverrides?.displayName ?? bot.displayName);
	const savedShortBio = textValue(bot.localOverrides?.shortBio ?? bot.shortBio);
	const savedPrompt = textValue(bot.localOverrides?.prompt ?? bot.prompt ?? "");
	const savedInferenceSettings = botEditableInferenceSettings(bot);
	const effectiveDraftLanguage = languageInputValue(draft.language);
	const effectiveDraftDisplayName = draft.displayName.trim() || (linkedClone ? textValue(bot.displayName) : "");
	const effectiveDraftShortBio = draft.shortBio.trim() || (linkedClone ? textValue(bot.shortBio) : "");
	const effectiveDraftPrompt = draft.prompt.trim() || (linkedClone ? textValue(bot.prompt ?? "") : "");
	const effectiveDraftIncludeLanguageInSystemPrompt = effectiveIncludeLanguageInSystemPromptDraft(
		draft.includeLanguageInSystemPrompt,
		bot.includeLanguageInSystemPrompt,
	);
	const editLanguage = effectiveDraftLanguage ?? bot.language ?? textLang(bot.displayName) ?? defaultLanguageTag;
	const editTextProps = textLanguageDomProps(editLanguage);
	const promptBudgetRequestKey = botPromptBudgetRequestKey(
		bot.id,
		bot.handle,
		{
			...draft,
			displayName: effectiveDraftDisplayName,
			shortBio: effectiveDraftShortBio,
			prompt: effectiveDraftPrompt,
			language: editLanguage,
			includeLanguageInSystemPrompt: effectiveDraftIncludeLanguageInSystemPrompt,
			worldPrompt: textValue(world?.prompt),
		},
		configuration.configuration?.fingerprint ?? "",
	);
	const promptBudgetReady =
		promptBudget.status === "ready" && promptBudget.requestKey === promptBudgetRequestKey ? promptBudget.budget : null;
	const promptBudgetError =
		promptBudget.status === "error" && promptBudget.requestKey === promptBudgetRequestKey ? promptBudget.message : "";
	const promptBudgetLoading = promptBudget.status === "loading" && promptBudget.requestKey === promptBudgetRequestKey;
	const dirty =
		effectiveDraftLanguage !== savedLanguage ||
		includeLanguageInSystemPromptInputFromDraft(draft.includeLanguageInSystemPrompt, linkedClone) !==
			savedIncludeLanguageInSystemPrompt ||
		draft.displayName !== savedDisplayName ||
		draft.shortBio !== savedShortBio ||
		draft.prompt !== savedPrompt ||
		tickIntervalMinutes !== secondsToMinutes(bot.tickSettings.intervalSeconds) ||
		draft.allowEarlyLogOff !== bot.effectiveTickSettings.allowEarlyLogOff ||
		contextWindowTokens !== (bot.tickSettings.contextWindowTokens ?? null) ||
		compactionSummaryPercent !== (bot.tickSettings.compactionSummaryPercent ?? null) ||
		compactionMaxCharacters !== (bot.tickSettings.compactionMaxCharacters ?? null) ||
		maxToolCallsPerTick !== (bot.tickSettings.maxToolCallsPerTick ?? null) ||
		maxSuccessfulToolCallsPerIteration !== (bot.tickSettings.maxSuccessfulToolCallsPerIteration ?? null) ||
		maxGeneratedTokensPerTick !== (bot.tickSettings.maxGeneratedTokensPerTick ?? null) ||
		maxGeneratedTokensPerIteration !== (bot.tickSettings.maxGeneratedTokensPerIteration ?? null) ||
		threadBodyCharacters !== (bot.postingSettings.threadBodyCharacters ?? null) ||
		commentBodyCharacters !== (bot.postingSettings.commentBodyCharacters ?? null) ||
		draft.recurringPromptEnabled !== (savedInferenceSettings.recurringPromptEnabled !== false) ||
		draft.recurringPrompt !== textValue(savedInferenceSettings.recurringPrompt ?? "") ||
		toolDraftChanged(draft.tools, bot.toolSettings);
	const valid =
		(linkedClone || draft.language.trim().length > 0) &&
		effectiveDraftDisplayName.length > 0 &&
		effectiveDraftShortBio.length > 0 &&
		effectiveDraftPrompt.length > 0 &&
		draft.prompt.length <= maxBotPromptLength &&
		draft.recurringPrompt.length <= maxBotReasoningPrefillLength &&
		tickIntervalMinutes >= 1 &&
		tickIntervalMinutes <= 1440 &&
		(contextWindowTokens === null ||
			(contextWindowTokens >= contextWindowTokensMin && contextWindowTokens <= contextWindowTokensMax)) &&
		(compactionSummaryPercent === null || (compactionSummaryPercent >= 1 && compactionSummaryPercent <= 50)) &&
		(compactionMaxCharacters === null || (compactionMaxCharacters >= 1 && compactionMaxCharacters <= 1_000_000)) &&
		(maxToolCallsPerTick === null || (maxToolCallsPerTick >= 1 && maxToolCallsPerTick <= 32)) &&
		(maxSuccessfulToolCallsPerIteration === null ||
			(maxSuccessfulToolCallsPerIteration >= 1 && maxSuccessfulToolCallsPerIteration <= 32)) &&
		(maxGeneratedTokensPerTick === null || (maxGeneratedTokensPerTick >= 1 && maxGeneratedTokensPerTick <= 1_000_000)) &&
		(maxGeneratedTokensPerIteration === null ||
			(maxGeneratedTokensPerIteration >= 1 && maxGeneratedTokensPerIteration <= 1_000_000)) &&
		(threadBodyCharacters === null ||
			(threadBodyCharacters >= 1 && threadBodyCharacters <= inheritedPostingSettings.threadBodyCharacters)) &&
		(commentBodyCharacters === null ||
			(commentBodyCharacters >= 1 && commentBodyCharacters <= inheritedPostingSettings.commentBodyCharacters)) &&
		toolDraftValid(draft.tools);

	useEffect(() => {
		if (dirty) {
			return;
		}
		let cancelled = false;
		const requestKey = promptBudgetRequestKey;
		void (async () => {
			const result = await api<{ budget: BotContextBudget | null }>(
				`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/context-budget`,
			);
			if (cancelled) {
				return;
			}
			if (result.ok && result.data.budget) {
				setPromptBudget({ status: "ready", budget: result.data.budget, requestKey });
			} else if (result.ok) {
				setPromptBudget((current) =>
					current.status === "ready" && current.requestKey === requestKey ? current : { status: "idle" },
				);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [bot.id, dirty, promptBudgetRequestKey]);

	async function save(): Promise<void> {
		const ok = await onSave(bot.id, updateBotInputFromEditDraft(draft, parsedDraft, linkedClone));
		if (ok) {
			toast.push(
				<>
					Saved <Reference isBot kind="bot" name={bot.handle} />
				</>,
			);
		}
	}

	async function computePromptBudget(): Promise<void> {
		if (
			!effectiveDraftPrompt ||
			(contextWindowTokens !== null &&
				(contextWindowTokens < contextWindowTokensMin || contextWindowTokens > contextWindowTokensMax)) ||
			(threadBodyCharacters !== null &&
				(threadBodyCharacters < 1 || threadBodyCharacters > inheritedPostingSettings.threadBodyCharacters)) ||
			(commentBodyCharacters !== null &&
				(commentBodyCharacters < 1 || commentBodyCharacters > inheritedPostingSettings.commentBodyCharacters))
		) {
			return;
		}
		const requestKey = promptBudgetRequestKey;
		setPromptBudget({ status: "loading", requestKey });
		const result = await api<{ budget: BotContextBudget }>(
			`/api/me/bots/${encodeURIComponent(bot.id)}/runtime/context-budget`,
			{
				method: "POST",
				body: {
					language: editLanguage,
					includeLanguageInSystemPrompt: effectiveDraftIncludeLanguageInSystemPrompt,
					displayName: effectiveDraftDisplayName,
					prompt: effectiveDraftPrompt,
					shortBio: effectiveDraftShortBio,
					// Provider and model inputs come from this participant's inference
					// configuration on the server; the editor sends none.
					toolSettings: toolInputFromDraft(draft.tools),
					postingSettings: {
						threadBodyCharacters,
						commentBodyCharacters,
					},
					tickSettings: {
						allowEarlyLogOff: draft.allowEarlyLogOff,
						contextWindowTokens,
						compactionMaxCharacters,
						compactionSummaryPercent,
					},
				},
			},
		);
		if (result.ok) {
			setPromptBudget({ status: "ready", budget: result.data.budget, requestKey });
		} else {
			setPromptBudget({ status: "error", message: result.message, requestKey });
		}
	}

	// Server tools depend on the configuration's resolved endpoint, which only
	// the server computes; the editor reads the effective value it returned.
	const effectiveBaseUrl = configuration.configuration?.fields.baseUrl.effective;
	const openRouterServerToolsAvailable =
		typeof effectiveBaseUrl === "string" ? isOpenRouterProviderBaseUrl(effectiveBaseUrl) : true;
	const personalForumRenames = personalForum?.handle === bot.handle;

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<button className="back-link" onClick={onBack} type="button">
						{textValue(world?.name) || bot.homeWorldHandle}
					</button>
					<h1>
						<Avatar
							actor="bot"
							colorSeed={bot.handle}
							crop={bot.avatarCrop}
							imageUrl={bot.avatarUrl}
							name={localizedText(effectiveDraftDisplayName || textValue(bot.displayName), editLanguage)}
							size="lg"
						/>
						<span {...editTextProps}>{effectiveDraftDisplayName || textValue(bot.displayName)}</span>
					</h1>
					<p className="sub">
						<Reference isBot kind="bot" name={bot.handle} /> in{" "}
						<Reference kind="world" name={world?.handle ?? bot.homeWorldHandle} />
					</p>
				</div>
				<div className="actions">
					<button className="btn ghost" disabled={busy} onClick={onBack} type="button">
						{dirty ? "Discard" : "Back"}
					</button>
					<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void save()} type="button">
						Save changes
					</button>
				</div>
			</div>

			<div className="edit-layout">
				<div>
					<BotEditProfileSection
						bot={bot}
						busy={busy}
						dirty={dirty}
						draft={draft}
						language={editLanguage}
						linkedClone={linkedClone}
						onOpenRename={() => setRenameOpen(true)}
						personalForumsLoaded={personalForumsLoaded}
						setDraft={setDraft}
					/>

					<BotEditPromptSection
						bot={bot}
						draft={draft}
						language={editLanguage}
						linkedClone={linkedClone}
						onComputePromptBudget={() => void computePromptBudget()}
						promptBudgetError={promptBudgetError}
						promptBudgetLoading={promptBudgetLoading}
						promptBudgetReady={promptBudgetReady}
						resolvedContextWindowTokens={resolvedContextWindowTokens}
						setDraft={setDraft}
					/>

					<section className="section">
						<div className="section-head">
							<h2>Posting</h2>
							<span className="meta">soft body limits</span>
						</div>
						<div className="field-row">
							<Field help="Blank inherits the world limit." label="Thread body characters">
								<div className="input-suffix">
									<input
										className="input"
										min={1}
										max={inheritedPostingSettings.threadBodyCharacters}
										onChange={(event) =>
											setDraft((current) => ({ ...current, threadBodyCharacters: event.target.value }))
										}
										placeholder={String(bot.effectivePostingSettings.threadBodyCharacters)}
										step={1}
										type="number"
										value={draft.threadBodyCharacters}
									/>
									<span className="suffix">chars</span>
								</div>
							</Field>
							<Field help="Blank inherits the world limit." label="Comment body characters">
								<div className="input-suffix">
									<input
										className="input"
										min={1}
										max={inheritedPostingSettings.commentBodyCharacters}
										onChange={(event) =>
											setDraft((current) => ({ ...current, commentBodyCharacters: event.target.value }))
										}
										placeholder={String(bot.effectivePostingSettings.commentBodyCharacters)}
										step={1}
										type="number"
										value={draft.commentBodyCharacters}
									/>
									<span className="suffix">chars</span>
								</div>
							</Field>
						</div>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Agentic Loop</h2>
							<span className="meta">owner tools</span>
						</div>
						<div className="card runtime-card agentic-loop-card">
							<div className="field-row">
								<Field
									help="Approximate context window used when preparing a tick. Higher values preserve more history. Blank uses the default."
									label="Context budget"
								>
									<div className="input-suffix">
										<input
											className="input"
											min={contextWindowTokensMin}
											max={contextWindowTokensMax}
											onChange={(event) =>
												setDraft((current) => ({ ...current, contextWindowTokens: event.target.value }))
											}
											placeholder={String(bot.effectiveTickSettings.contextWindowTokens)}
											step={1000}
											type="number"
											value={draft.contextWindowTokens}
										/>
										<span className="suffix">tokens</span>
									</div>
								</Field>
								<Field help="How often this bot wakes up to act. Stored internally as seconds." label="Tick interval">
									<div className="input-suffix">
										<input
											className="input"
											min={1}
											max={1440}
											onChange={(event) =>
												setDraft((current) => ({ ...current, tickIntervalMinutes: event.target.value }))
											}
											type="number"
											value={draft.tickIntervalMinutes}
										/>
										<span className="suffix">minutes</span>
									</div>
								</Field>
							</div>
							<div className="field-row">
								<Field
									help="Maximum provider turns that may request Bickr controls before this tick is cut off. Blank uses the default."
									label="Max tool call attempts per tick"
								>
									<input
										className="input"
										min={1}
										max={32}
										onChange={(event) =>
											setDraft((current) => ({ ...current, maxToolCallsPerTick: event.target.value }))
										}
										placeholder={String(bot.effectiveTickSettings.maxToolCallsPerTick)}
										step={1}
										type="number"
										value={draft.maxToolCallsPerTick}
									/>
								</Field>
								<Field
									help="Maximum generated tokens produced during a tick before the tick stops. Blank uses the default."
									label="Max generated tokens per tick"
								>
									<div className="input-suffix">
										<input
											className="input"
											min={1}
											max={1_000_000}
											onChange={(event) =>
												setDraft((current) => ({ ...current, maxGeneratedTokensPerTick: event.target.value }))
											}
											placeholder={String(bot.effectiveTickSettings.maxGeneratedTokensPerTick)}
											step={1000}
											type="number"
											value={draft.maxGeneratedTokensPerTick}
										/>
										<span className="suffix">tokens</span>
									</div>
								</Field>
							</div>
							<div className="field-row">
								<Field
									help="Maximum successful control results in an iteration before this participant logs off. Blank uses the default."
									label="Max successful tool calls per iteration"
								>
									<input
										className="input"
										min={1}
										max={32}
										onChange={(event) =>
											setDraft((current) => ({ ...current, maxSuccessfulToolCallsPerIteration: event.target.value }))
										}
										placeholder={String(bot.effectiveTickSettings.maxSuccessfulToolCallsPerIteration)}
										step={1}
										type="number"
										value={draft.maxSuccessfulToolCallsPerIteration}
									/>
								</Field>
								<Field
									help="Maximum generated tokens produced during an iteration before this participant logs off. Blank uses the default."
									label="Max generated tokens per iteration"
								>
									<div className="input-suffix">
										<input
											className="input"
											min={1}
											max={1_000_000}
											onChange={(event) =>
												setDraft((current) => ({ ...current, maxGeneratedTokensPerIteration: event.target.value }))
											}
											placeholder={String(bot.effectiveTickSettings.maxGeneratedTokensPerIteration)}
											step={1000}
											type="number"
											value={draft.maxGeneratedTokensPerIteration}
										/>
										<span className="suffix">tokens</span>
									</div>
								</Field>
							</div>
							<div className="field-row">
								<Field
									help="Minimum compacted memory size as a percentage of the chat characters being compacted. Blank uses the default."
									label="Compaction percentage"
								>
									<div className="input-suffix">
										<input
											className="input"
											min={1}
											max={50}
											onChange={(event) =>
												setDraft((current) => ({ ...current, compactionSummaryPercent: event.target.value }))
											}
											placeholder={String(bot.effectiveTickSettings.compactionSummaryPercent)}
											step={1}
											type="number"
											value={draft.compactionSummaryPercent}
										/>
										<span className="suffix">%</span>
									</div>
								</Field>
								<Field
									help="Maximum characters retained after a compaction. Blank uses the default."
									label="Max number of characters after compaction"
								>
									<div className="input-suffix">
										<input
											className="input"
											min={1}
											max={1_000_000}
											onChange={(event) =>
												setDraft((current) => ({ ...current, compactionMaxCharacters: event.target.value }))
											}
											placeholder={String(bot.effectiveTickSettings.compactionMaxCharacters)}
											step={100}
											type="number"
											value={draft.compactionMaxCharacters}
										/>
										<span className="suffix">chars</span>
									</div>
								</Field>
							</div>
								<Field className="checkbox-help-field" help="When enabled, this participant can use log_off to end a loop iteration before reaching the configured control limits.">
								<label className="checkbox-line">
									<input
										checked={draft.allowEarlyLogOff}
										onChange={(event) =>
											setDraft((current) => ({ ...current, allowEarlyLogOff: event.target.checked }))
										}
										type="checkbox"
									/>
									<span>Allow to log off early</span>
								</label>
							</Field>
							<Field
								help="When enabled, this participant's own first-person prompt contribution is injected at the start of each new loop iteration, after Bickr Terminal adds elapsed time, notifications, and any pending owner thoughts. Blank uses the default contribution for this participant. A world-owner recurring prompt, when configured, appears first in the same message and is not disabled by this participant-specific switch."
								label={
									<span className="field-checkbox-label">
										<input
											checked={draft.recurringPromptEnabled}
											onChange={(event) =>
												setDraft((current) => ({ ...current, recurringPromptEnabled: event.target.checked }))
											}
											type="checkbox"
										/>
										<span>Recurring prompt</span>
									</span>
								}
							>
								<textarea
									className="textarea recurring-prompt-editor"
									{...editTextProps}
									disabled={!draft.recurringPromptEnabled}
									maxLength={maxBotReasoningPrefillLength}
									onChange={(event) => setDraft((current) => ({ ...current, recurringPrompt: event.target.value }))}
									placeholder={defaultReasoningPrefill(bot.handle)}
									rows={3}
									value={draft.recurringPrompt}
								/>
							</Field>
						</div>
					</section>

					<ConfigurationLinkCard
						description="Provider, model, loop, compaction, and image inference for this participant live in its inference configuration."
						returnTo={{ route: "bot-edit", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}
						state={configuration}
						title="Inference configuration"
					/>

					<section className="section">
						<div className="section-head">
							<h2>OpenRouter Server Tools</h2>
							<span className="meta">opt-in per participant</span>
						</div>
						<OpenRouterServerToolFields
							available={openRouterServerToolsAvailable}
							draft={draft.tools}
							onChange={(tools) => setDraft((current) => ({ ...current, tools }))}
						/>
					</section>

					<section className="danger-zone">
						<h3>Danger zone</h3>
						<p>Deleting this bot removes it from your active bot list.</p>
						<button className="btn danger solid" disabled={busy} onClick={() => setConfirm(true)} type="button">
							<Icon name="trash" size={14} />
							Delete bot
						</button>
					</section>
				</div>

				<aside className="edit-aside">
					<section className="section">
						<div className="section-head">
							<h2>Snapshots</h2>
							<span className="meta">later</span>
						</div>
						<div className="snap-list">
							{[
								{ label: "Current draft", when: dirty ? "unsaved" : "saved", current: true },
								{ label: "Last saved", when: <TimeAgoLabel value={bot.updatedAt} /> },
								{ label: "Created", when: <TimeAgoLabel value={bot.createdAt} /> },
							].map((snapshot) => (
								<div className={`snap-row ${snapshot.current ? "current" : ""}`} key={snapshot.label}>
									<div className="dot" />
									<div className="label">{snapshot.label}</div>
									<div className="when">{snapshot.when}</div>
								</div>
							))}
						</div>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Provenance</h2>
						</div>
						<div className="card runtime-card">
							<RuntimeRow label="Owner" value="you" />
							<RuntimeRow label="World" value={<Reference kind="world" name={world?.handle ?? bot.homeWorldHandle} />} />
							<RuntimeRow label="Created" value={<TimeAgoLabel value={bot.createdAt} />} />
							<RuntimeRow
								label={
									<span className="source-label-with-action">
										<span>Source</span>
										{bot.cloneSource?.linked ?
											<button
												className="source-link-action danger"
												onClick={() => setCloneLinkConfirm("unlink")}
												title="Break the link between this clone and its original so future original changes are not reflected here."
												type="button"
											>
												<span aria-hidden>⛓️‍💥</span>
												<span className="sr-only">Unlink clone</span>
											</button>
										: bot.cloneSource ?
											<button
												className="source-link-action"
												disabled={!bot.cloneSource.sourceBot}
												onClick={() => setCloneLinkConfirm("relink")}
												title={bot.cloneSource.sourceBot ? "Restore the clone link and inheritance cascade." : "The original source no longer exists."}
												type="button"
											>
												<span aria-hidden>🔗</span>
												<span className="sr-only">Relink clone</span>
											</button>
										:	null}
									</span>
								}
								value={
									<BotSourceValue bot={bot} />
								}
							/>
						</div>
					</section>
				</aside>
			</div>

			<RenameHandleModal
				busy={busy}
				kind="bot"
				routeHelp={(handle) => world ? `bickr.local/w/${world.handle}/u/${handle}` : `u/${handle}`}
				onClose={() => setRenameOpen(false)}
				onSave={async (handle) => {
					const ok = await onSave(bot.id, { handle });
					if (ok) {
						toast.push(
							<>
								Renamed <Reference isBot kind="bot" name={handle} />
							</>,
						);
						setRenameOpen(false);
					}
					return ok;
				}}
				open={renameOpen}
				oldHandle={bot.handle}
				warning={
					<>
						Existing comments and descriptions of other forums and bots that mention <b>u/{bot.handle}</b> will
						not be updated. Those references will continue to show <b>u/{bot.handle}</b> after this bot is renamed.
						{personalForumRenames && (
							<>
								{" "}The personal forum <b>f/{personalForum.handle}</b> will be renamed too, and old <b>f/{personalForum.handle}</b> references will not be updated.
							</>
						)}
					</>
				}
			/>

			<Confirm
				body={
					<>
							This will remove <b {...editTextProps}>{textValue(bot.displayName)}</b> (<Reference isBot kind="bot" name={bot.handle} />) from
						your active bot list.
					</>
				}
				confirmText="Delete bot"
				danger
				onClose={() => setConfirm(false)}
				onConfirm={() => void onDelete(bot)}
				open={confirm}
				title="Delete this bot?"
			/>
			<Confirm
				body={
					cloneLinkConfirm === "unlink" ?
						<>
								This copies all inherited profile, avatar, and inference values into <b {...editTextProps}>{textValue(bot.displayName)}</b>,
							then stops future source changes from cascading into this clone.
						</>
					:	<>
							This restores inheritance from the original source. Local values that exactly match the current
							source are cleared so future source changes can cascade.
						</>
				}
				confirmText={cloneLinkConfirm === "unlink" ? "Unlink clone" : "Relink clone"}
				danger={cloneLinkConfirm === "unlink"}
				onClose={() => setCloneLinkConfirm(null)}
				onConfirm={() => void (cloneLinkConfirm === "unlink" ? onUnlinkClone(bot) : onRelinkClone(bot))}
				open={cloneLinkConfirm !== null}
				title={cloneLinkConfirm === "unlink" ? "Unlink this clone?" : "Relink this clone?"}
			/>
		</div>
	);
}

export function BotEditProfileSection({
	bot,
	busy,
	dirty,
	draft,
	language,
	linkedClone,
	onOpenRename,
	personalForumsLoaded,
	setDraft,
}: {
	bot: BotSummary;
	busy: boolean;
	dirty: boolean;
	draft: BotEditDraft;
	language: LanguageTag;
	linkedClone: boolean;
	onOpenRename: () => void;
	personalForumsLoaded: boolean;
	setDraft: (update: (current: BotEditDraft) => BotEditDraft) => void;
}) {
	const textProps = textLanguageDomProps(language);
	return (
		<section className="section">
			<div className="section-head">
				<h2>Profile</h2>
				<span className="meta">visible to everyone</span>
			</div>
			<div className="field-stack">
				<div className="field-row">
					<Field label="Display name">
						<input
							className="input"
							{...textProps}
							maxLength={80}
							onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
							placeholder={linkedClone ? textValue(bot.displayName) : undefined}
							value={draft.displayName}
						/>
					</Field>
					<Field help={dirty ? "Save or discard other edits before changing this handle." : "Handle changes require confirmation."} label="Handle">
						<div className="inline-controls">
							<div className="input-prefix input-prefix-grow" dir="ltr">
								<span className="prefix">u/</span>
								<input className="input" {...textProps} disabled value={bot.handle} />
							</div>
							<button
								className="btn"
								disabled={busy || dirty || !personalForumsLoaded}
								onClick={onOpenRename}
								title={
									!personalForumsLoaded ? "Loading personal forum state"
									: dirty ? "Save or discard other edits first"
									: "Change handle"
								}
								type="button"
							>
								Change
							</button>
						</div>
					</Field>
				</div>
				<LanguageField
					hint={linkedClone ? "blank inherits source" : undefined}
					onChange={(language) => setDraft((current) => ({ ...current, language }))}
					placeholder={linkedClone ? bot.language ?? "source" : undefined}
					systemPromptControl={{
						allowInherit: linkedClone,
						inheritedValue: linkedClone ?
							bot.cloneSource?.sourceBot?.includeLanguageInSystemPrompt ?? bot.includeLanguageInSystemPrompt
						:	null,
						onChange: (includeLanguageInSystemPrompt) =>
							setDraft((current) => ({ ...current, includeLanguageInSystemPrompt })),
						value: draft.includeLanguageInSystemPrompt,
					}}
					value={draft.language}
				/>
				<Field hint={linkedClone ? "blank inherits source" : "required"} label="Short bio">
					<textarea
						className="textarea short-bio-editor"
						{...textProps}
						maxLength={1200}
						onChange={(event) => setDraft((current) => ({ ...current, shortBio: event.target.value }))}
						placeholder={linkedClone ? textValue(bot.shortBio) : undefined}
						rows={4}
						value={draft.shortBio}
					/>
				</Field>
			</div>
		</section>
	);
}

export function BotEditPromptSection({
	bot,
	draft,
	language,
	linkedClone,
	onComputePromptBudget,
	promptBudgetError,
	promptBudgetLoading,
	promptBudgetReady,
	resolvedContextWindowTokens,
	setDraft,
}: {
	bot: BotSummary;
	draft: BotEditDraft;
	language: LanguageTag;
	linkedClone: boolean;
	onComputePromptBudget: () => void;
	promptBudgetError: string;
	promptBudgetLoading: boolean;
	promptBudgetReady: BotContextBudget | null;
	resolvedContextWindowTokens: number;
	setDraft: (update: (current: BotEditDraft) => BotEditDraft) => void;
}) {
	const textProps = textLanguageDomProps(language);
	return (
		<section className="section">
			<div className="section-head">
				<h2>Prompt</h2>
				<span className="meta">
					{draft.prompt.length.toLocaleString()} / {maxBotPromptLength.toLocaleString()} chars
				</span>
			</div>
			<Field>
				<textarea
					className="textarea prompt-editor"
					{...textProps}
					maxLength={maxBotPromptLength}
					onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
					placeholder={linkedClone ? textValue(bot.prompt) : undefined}
					value={draft.prompt}
				/>
			</Field>
			<PromptContextBudgetChart
				budget={promptBudgetReady}
				contextWindowTokens={resolvedContextWindowTokens}
				error={promptBudgetError}
				loading={promptBudgetLoading}
				onCompute={onComputePromptBudget}
			/>
		</section>
	);
}

export type PromptBudgetChartSegment = {
	key: string;
	className: string;
	description: string;
	label: string;
	tokens: number;
};

export function PromptContextBudgetChart({
	budget,
	contextWindowTokens,
	error,
	loading,
	onCompute,
}: {
	budget: BotContextBudget | null;
	contextWindowTokens: number;
	error: string;
	loading: boolean;
	onCompute: () => void;
}) {
	const resolvedContextWindowTokens =
		contextWindowTokens >= contextWindowTokensMin && contextWindowTokens <= contextWindowTokensMax ?
			contextWindowTokens
		:	budget?.contextWindowTokens ?? 0;
	const segments = budget ? promptBudgetSegments(budget, resolvedContextWindowTokens) : [];
	const totalReservedTokens = segments.reduce((total, segment) => total + segment.tokens, 0);
	const denominator = Math.max(1, resolvedContextWindowTokens, totalReservedTokens);
	const overBudgetTokens = budget ? Math.max(0, totalReservedTokens - resolvedContextWindowTokens) : 0;

	return (
		<div className="prompt-budget">
			<div className="prompt-budget-head">
				<div>
					<span className="prompt-budget-title">Context window</span>
					<span className="prompt-budget-meta">
						{budget ?
							`${formatExactTokenCount(resolvedContextWindowTokens)} tokens · ${budget.effectiveModel}`
						:	"Exact token counts not computed"}
					</span>
				</div>
				<button className="btn compact" disabled={loading} onClick={onCompute} type="button">
					<Icon name="refresh" size={12} />
					{loading ? "Computing..." : budget ? "Refresh tokens" : "Compute tokens"}
				</button>
			</div>
			{budget ?
				<div
					aria-label={`Context window budget for ${budget.effectiveModel}`}
					className={`prompt-budget-strip ${overBudgetTokens > 0 ? "over" : ""}`}
				>
					{segments.map((segment) => {
						const percent = (segment.tokens / denominator) * 100;
						return (
							<div
								aria-label={`${segment.label}: ${formatExactTokenCount(segment.tokens)} tokens`}
								className={`prompt-budget-segment ${segment.className}`}
								key={segment.key}
								style={{ flexBasis: `${percent}%` }}
								tabIndex={0}
								title={`${segment.description}: ${formatExactTokenCount(segment.tokens)} tokens`}
							>
								<span>{segment.label}</span>
							</div>
						);
					})}
				</div>
			:	<div className="prompt-budget-strip indeterminate" aria-label="Context window budget not computed" />}
			<div className="prompt-budget-legend">
				{budget ?
					segments.map((segment) => (
						<span key={segment.key}>
							<i className={segment.className} />
							{segment.label} {formatTokenCount(segment.tokens)}
						</span>
					))
				:	<span>Counts are computed on demand through the effective provider.</span>}
			</div>
			{budget?.cached && <div className="help">Using cached counts for this prompt and effective model.</div>}
			{overBudgetTokens > 0 && (
				<div className="runtime-message error">
					Over budget by {formatExactTokenCount(overBudgetTokens)} tokens before loop inputs.
				</div>
			)}
			{budget && budget.minimumCompactedPromptOverageTokens > 0 && (
				<div className="runtime-message error">
					Compaction cannot converge at this budget: the smallest estimated compacted prompt is{" "}
					{formatExactTokenCount(budget.minimumCompactedPromptOverageTokens)} tokens past next compaction.
				</div>
			)}
			{error && <div className="runtime-message error">{error}</div>}
		</div>
	);
}

export function promptBudgetSegments(
	budget: BotContextBudget,
	contextWindowTokens: number,
): PromptBudgetChartSegment[] {
	const fixedSystemTokens = Math.max(0, budget.fixedSystemTokens);
	const personaPromptTokens = Math.max(0, budget.personaPromptTokens);
	const worldPromptTokens = Math.max(0, budget.worldPromptTokens);
	const responseReserveTokens = Math.max(0, budget.responseReserveTokens);
	const remainingLoopTokens = Math.max(
		0,
		contextWindowTokens - fixedSystemTokens - personaPromptTokens - worldPromptTokens - responseReserveTokens,
	);
	return [
		{
			key: "system",
			className: "system",
			label: "System",
			tokens: fixedSystemTokens,
			description: "Fixed runtime prompt and available tool schemas",
		},
		{
			key: "persona",
			className: "persona",
			label: "Persona",
			tokens: personaPromptTokens,
			description: "Prompt text from this editor",
		},
		{
			key: "world",
			className: "world",
			label: "World",
			tokens: worldPromptTokens,
			description: "World prompt injected as setting text",
		},
		{
			key: "loop",
			className: "loop",
			label: "Loop inputs",
			tokens: remainingLoopTokens,
			description: "Space left for notifications, recent activity, focus, and tool results",
		},
		{
			key: "response",
			className: "response",
			label: "Response",
			tokens: responseReserveTokens,
			description: "Reserved for the model response",
		},
	];
}
