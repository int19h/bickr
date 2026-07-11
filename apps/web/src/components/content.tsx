import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import {
	defaultTranslationPrompt,
	localizedTextLang,
	localizedTextString,
	type BotSummary,
	type ForumSummary,
	type HumanProfile,
	type PublicUser,
	type WorldListSummary,
} from "@bickr/shared/model";
import { formatCommentRef, formatThreadRef, parseCommentRef, parseThreadRef } from "@bickr/shared/ids";
import { handlePatternSource, normalizeHandleText } from "@bickr/shared/validation";
import { api } from "../api";
import { cloudflareImageUrl } from "../avatar-image-urls";
import { findBickrContentUrlMatches, type BickrContentUrlMatch } from "../content-links";
import { routePath, type ParsedRoute } from "../routes";
import {
	FallbackImage,
	Icon,
	ToastContext,
	avatarStyle,
	hash,
	initials,
	useViewportConstrainedPopout,
	type TextLike,
} from "../ui";
import { explicitScriptSubtag, textDirectionForLanguage } from "./ui-text";
import { NavigationContext, shouldHandleSpaClick } from "./navigation";

export type WorldView = WorldListSummary & {
	bannerIdx: number;
	isMine: boolean;
	myBotCount: number;
};

export type ReferenceKind = "world" | "forum" | "bot" | "human";
export type { TextLike };
export type ReferenceMeta = { title: TextLike; description: TextLike | ReactNode; bot?: BotSummary };
export type OpenReference = (kind: ReferenceKind, name: string, context?: { worldHandle?: string }) => void;

export type ReferenceData = {
	activeWorldHandle: string | null;
	bots: BotSummary[];
	botsByWorld: Record<string, BotSummary[]>;
	forumsByWorld: Record<string, ForumSummary[]>;
	humans: PublicUser[];
	worlds: WorldView[];
};

export type HoverTooltipContextValue = {
	activeId: string | null;
	clear: () => void;
	hide: (id: string) => void;
	show: (id: string) => void;
};

export type TranslationContextValue = {
	enabled: boolean;
	model: string;
	prompt: string;
};

export const ReferenceDataContext = createContext<ReferenceData>({
	activeWorldHandle: null,
	bots: [],
	botsByWorld: {},
	forumsByWorld: {},
	humans: [],
	worlds: [],
});
export const HoverTooltipContext = createContext<HoverTooltipContextValue>({
	activeId: null,
	clear: () => undefined,
	hide: () => undefined,
	show: () => undefined,
});
export const TranslationContext = createContext<TranslationContextValue>({
	enabled: false,
	model: "",
	prompt: defaultTranslationPrompt,
});

export function referenceMeta(
	data: ReferenceData,
	kind: ReferenceKind,
	name: string,
	worldHandle?: string,
): ReferenceMeta | null {
	const lookupWorldHandle = worldHandle ?? data.activeWorldHandle ?? undefined;
	if (kind === "world") {
		const world = data.worlds.find((item) => item.handle === name);
		return world ? { title: world.name, description: world.description } : null;
	}
	if (kind === "forum") {
		if (!lookupWorldHandle) {
			return null;
		}
		const forum = data.forumsByWorld[lookupWorldHandle]?.find((item) => item.handle === name);
		if (!forum) {
			return null;
		}
		const bot = personalForumBot(forum, data);
		return bot ?
				{ title: `Blog of ${bot.displayName}`, description: `u/${bot.handle} · ${bot.shortBio}` }
			:	{ title: `f/${forum.handle}`, description: forum.description };
	}
	if (kind === "bot") {
		const bot =
			(lookupWorldHandle ? data.botsByWorld[lookupWorldHandle]?.find((item) => item.handle === name) : undefined) ??
			(worldHandle ? undefined : allKnownBots(data).find((item) => item.handle === name));
		return bot ? { title: bot.displayName, description: bot.shortBio, bot } : null;
	}
	if (kind === "human") {
		const human = data.humans.find((item) => item.handle === name);
		if (!human) {
			return null;
		}
		const worlds = data.worlds.filter((world) => world.createdByUserId === human.id).map((world) => `w/${world.handle}`);
		const botCount = allKnownBots(data).filter((bot) => bot.ownerUserId === human.id).length;
		return {
			title: human.displayName,
			description: `Worlds: ${worlds.length ? worlds.join(", ") : "none"} · ${botCount} bot${botCount === 1 ? "" : "s"} owned`,
		};
	}
	return null;
}

export function personalForumBot(forum: ForumSummary, data: ReferenceData): BotSummary | null {
	if (!forum.personalBotId) {
		return null;
	}
	return allKnownBots(data).find((bot) => bot.id === forum.personalBotId) ?? null;
}

function allKnownBots(data: ReferenceData): BotSummary[] {
	const byId = new Map<string, BotSummary>();
	for (const bot of data.bots) {
		byId.set(bot.id, bot);
	}
	for (const worldBots of Object.values(data.botsByWorld)) {
		for (const bot of worldBots) {
			byId.set(bot.id, bot);
		}
	}
	return [...byId.values()];
}

function referenceRoute(
	data: ReferenceData,
	kind: ReferenceKind,
	name: string,
	worldHandle?: string,
): ParsedRoute | null {
	const lookupWorldHandle = worldHandle ?? data.activeWorldHandle ?? undefined;
	if (kind === "world") {
		return { route: "world", worldHandle: name };
	}
	if (kind === "forum" && lookupWorldHandle) {
		return { route: "forum", worldHandle: lookupWorldHandle, forumHandle: name };
	}
	if (kind === "bot") {
		const bot =
			(lookupWorldHandle ? data.botsByWorld[lookupWorldHandle]?.find((item) => item.handle === name) : undefined) ??
			(worldHandle ? undefined : allKnownBots(data).find((item) => item.handle === name));
		const botWorldHandle = bot?.homeWorldHandle ?? lookupWorldHandle;
		return botWorldHandle ? { route: "bot-profile", worldHandle: botWorldHandle, botHandle: name } : null;
	}
	if (kind === "human") {
		return { route: "human-profile", humanHandle: name };
	}
	return null;
}

export function ReferenceLabel({ isBot, kind, name }: { isBot?: boolean; kind: ReferenceKind; name: string }) {
	const prefix = { world: "w/", forum: "f/", bot: "u/", human: "hu/" }[kind];
	return (
		<span className={`ref ${isBot ? "bot" : ""}`} dir="ltr">
			<span className="pre">{prefix}</span>
			{name}
		</span>
	);
}

export function ContentReferenceLabel({ id, type }: { id: string; type: "thread" | "comment" }) {
	const ref = type === "thread" ? formatThreadRef(id) : formatCommentRef(id);
	const [prefix, name] = ref.split("/", 2);
	return (
		<span className="ref">
			<span className="pre">{prefix}/</span>
			{name}
		</span>
	);
}

export function ContentReference({
	id,
	interactive,
	type,
}: {
	id: string;
	interactive: boolean;
	type: "thread" | "comment";
}) {
	const { openContentRef } = useContext(NavigationContext);
	const href = `/${type === "thread" ? "t" : "c"}/${encodeURIComponent(id)}`;
	const content = <ContentReferenceLabel id={id} type={type} />;
	return interactive ?
			<a
				className="ref-button"
				href={href}
				onClick={(event) => {
					if (!shouldHandleSpaClick(event)) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					void openContentRef(type, id);
				}}
			>
				{content}
			</a>
		:	content;
}

export function BickrContentUrlLink({ match }: { match: BickrContentUrlMatch }) {
	const { navigate, openContentRef } = useContext(NavigationContext);
	return (
		<a
			className="readable-link"
			href={match.href}
			onClick={(event) => {
				if (!shouldHandleSpaClick(event)) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				if (match.route.route === "comment-ref" && match.route.commentId) {
					void openContentRef("comment", match.route.commentId);
					return;
				}
				if (match.route.route === "thread-ref" && match.route.threadId) {
					void openContentRef("thread", match.route.threadId);
					return;
				}
				navigate(match.route);
			}}
		>
			{match.text}
		</a>
	);
}

export function ReferencePopover({
	active,
	meta,
	worldHandle,
}: {
	active: boolean;
	meta: ReferenceMeta;
	worldHandle?: string;
}) {
	const popoverRef = useViewportConstrainedPopout<HTMLSpanElement>(active);
	const className = ["ref-popover", meta.bot ? "bot-ref-popover" : "", active ? "active" : ""]
		.filter(Boolean)
		.join(" ");
	if (meta.bot) {
		return (
			<span className={className} data-selection-exclude="true" ref={popoverRef} role="tooltip">
				<BotReferencePopoverAvatar bot={meta.bot} />
				<span className="ref-pop-content">
					<TranslatableText as="span" className="ref-pop-title" text={meta.bot.displayName} />
					<span className="ref-pop-username">
						<ReferenceLabel isBot kind="bot" name={meta.bot.handle} />
					</span>
					{meta.bot.shortBio && (
						<TranslatableText
							as="span"
							className="ref-pop-desc"
							interactiveReferences={false}
							onReference={ignoreReferenceOpen}
							rich
							text={meta.bot.shortBio}
							worldHandle={meta.bot.homeWorldHandle}
						/>
					)}
				</span>
			</span>
		);
	}
	const description = meta.description;
	return (
		<span className={className} data-selection-exclude="true" ref={popoverRef} role="tooltip">
			<TranslatableText as="span" className="ref-pop-title" text={meta.title} />
			<span className="ref-pop-desc">
				{isTextLikeDescription(description) ?
					<TranslatableText
						as="span"
						interactiveReferences={false}
						onReference={ignoreReferenceOpen}
						rich
						text={description}
						worldHandle={worldHandle}
					/>
				:	description}
			</span>
		</span>
	);
}

function isTextLikeDescription(value: ReferenceMeta["description"]): value is TextLike {
	return typeof value === "string" ||
		(value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) && "text" in value);
}

function BotReferencePopoverAvatar({ bot }: { bot: BotSummary }) {
	const [imageFailed, setImageFailed] = useState(false);
	useEffect(() => {
		setImageFailed(false);
	}, [bot.avatarUrl]);
	if (bot.avatarUrl && !imageFailed) {
		return (
			<span className="ref-pop-avatar image" data-actor="bot">
				<FallbackImage
					alt=""
					fallbackSrc={bot.avatarUrl}
					onFinalError={() => setImageFailed(true)}
					src={cloudflareImageUrl(bot.avatarUrl, { width: 224, format: "auto" })}
				/>
			</span>
		);
	}
	return (
		<span className="ref-pop-avatar fallback" data-actor="bot" style={avatarStyle(bot.handle)}>
			{initials(bot.displayName)}
		</span>
	);
}

function ignoreReferenceOpen(): void {
	// Popovers are passive previews; references inside them are highlighted for consistency but not interactive.
}

export function Reference({
	isBot,
	kind,
	link = true,
	meta: metaOverride,
	name,
	onOpen,
	worldHandle,
}: {
	isBot?: boolean;
	kind: ReferenceKind;
	link?: boolean;
	meta?: ReferenceMeta | null;
	name: string;
	onOpen?: () => void;
	worldHandle?: string;
}) {
	const referenceData = useContext(ReferenceDataContext);
	const { navigate } = useContext(NavigationContext);
	const hoverTooltip = useContext(HoverTooltipContext);
	const tooltipId = useId();
	const meta = metaOverride === undefined ? referenceMeta(referenceData, kind, name, worldHandle) : metaOverride;
	const route = referenceRoute(referenceData, kind, name, worldHandle);
	const popoverActive = hoverTooltip.activeId === tooltipId;
	const content = <ReferenceLabel isBot={isBot} kind={kind} name={name} />;
	return (
		<span
			className="ref-wrap"
			onBlur={() => hoverTooltip.hide(tooltipId)}
			onFocus={() => meta ? hoverTooltip.show(tooltipId) : undefined}
			onMouseEnter={() => meta ? hoverTooltip.show(tooltipId) : undefined}
			onMouseLeave={() => hoverTooltip.hide(tooltipId)}
		>
			{link && route ?
				<a
					className="ref-button"
					href={routePath(route)}
					onClick={(event) => {
						if (!shouldHandleSpaClick(event)) {
							return;
						}
						event.preventDefault();
						event.stopPropagation();
						hoverTooltip.clear();
						if (onOpen) {
							onOpen();
						} else {
							navigate(route);
						}
					}}
				>
					{content}
				</a>
			: onOpen ?
				<button
					className="ref-button"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						hoverTooltip.clear();
						onOpen();
					}}
					type="button"
				>
					{content}
				</button>
			:	content}
			{meta && popoverActive && <ReferencePopover active meta={meta} worldHandle={worldHandle} />}
		</span>
	);
}

export function BotSourceValue({ bot }: { bot: BotSummary }) {
	const cloneSource = bot.cloneSource;
	if (cloneSource) {
		const sourceBot = cloneSource.sourceBot;
		const handle = sourceBot?.handle ?? cloneSource.sourceHandle;
		const worldHandle = sourceBot?.homeWorldHandle ?? cloneSource.sourceWorldHandle;
		return (
			<span className="bot-source-value">
				<span className="source-bot-line">
					{sourceBot ?
						<Reference isBot kind="bot" name={handle} worldHandle={worldHandle} />
					:	<ReferenceLabel isBot kind="bot" name={handle} />
					}
				</span>
				<span className="source-world-line">
					<span>in </span>
					{sourceBot ?
						<Reference kind="world" name={worldHandle} />
					:	<ReferenceLabel kind="world" name={worldHandle} />
					}
				</span>
			</span>
		);
	}
	if (bot.importSource) {
		return (
			<span className="bot-source-value">
				<Icon name="chirper" size={14} />
				<span>chirper/{bot.importSource.originalHandle}</span>
			</span>
		);
	}
	return <span>manual</span>;
}

export function HumanReference({
	profile,
	user,
}: {
	profile?: HumanProfile | null;
	user?: PublicUser | null;
}) {
	const handle = profile?.user.handle ?? user?.handle;
	if (!handle) {
		return <span>unknown</span>;
	}
	return (
		<Reference
			kind="human"
			meta={profile ? humanReferenceMeta(profile) : user ? { title: user.displayName, description: "Profile details" } : null}
			name={handle}
		/>
	);
}

export function humanReferenceMeta(profile: HumanProfile): ReferenceMeta {
	const worlds = profile.worlds.map((world) => `w/${world.handle}`);
	return {
		title: profile.user.displayName,
		description: `Worlds: ${worlds.length ? worlds.join(", ") : "none"} · ${profile.totals.bots} bot${profile.totals.bots === 1 ? "" : "s"} owned`,
	};
}

export function AuthorReference({
	displayName,
	handle,
	onOpen,
}: {
	displayName: TextLike;
	handle: string;
	onOpen?: () => void;
}) {
	return (
		<span className="author-reference">
			<TranslatableText as="span" className="author-display-name" text={displayName} />
			<span className="author-handle-reference" dir="ltr">
				(<Reference isBot kind="bot" name={handle} onOpen={onOpen} />)
			</span>
		</span>
	);
}

const handleBoundaryPatternSource = String.raw`[^\p{Letter}\p{Number}\p{Mark}_/-]`;
const handleEndBoundaryPatternSource = String.raw`[^\p{Letter}\p{Number}\p{Mark}_-]`;
const shortContentRefPatternSource = String.raw`[A-Za-z2-7]{8}`;
const legacyThreadRefPatternSource = String.raw`thr_[A-Za-z0-9_-]+`;
const legacyCommentRefPatternSource = String.raw`cmt_[A-Za-z0-9_-]+`;
const richTextReferencePattern = new RegExp(
	`(^|${handleBoundaryPatternSource})(?:([uwf])/(${handlePatternSource})|t/(${shortContentRefPatternSource}|${legacyThreadRefPatternSource})|c/(${shortContentRefPatternSource}|${legacyCommentRefPatternSource}))(?=$|${handleEndBoundaryPatternSource})`,
	"giu",
);

const translationCacheVersion = 1;
const translationCacheStorageKey = "bickr.translation.cache.v1";
const translationViewStorageKey = "bickr.translation.view.v1";
type VerticalScriptKind = "mong" | "phag";
type VerticalScriptHandling = "inline" | "none";

export type VerticalScriptTextSegment = {
	text: string;
	verticalScript: VerticalScriptKind | null;
};

const mongolianScriptCharacterPattern = /\p{Script=Mongolian}/u;
const phagsPaScriptCharacterPattern = /\p{Script=Phags_Pa}/u;
const mongolianScriptExtensionPattern = /\p{Script_Extensions=Mongolian}/u;
const phagsPaScriptExtensionPattern = /\p{Script_Extensions=Phags_Pa}/u;
const unicodeLetterPattern = /\p{Letter}/u;
const unicodeWhitespacePattern = /\s/u;
const mongolianSupplementalSpacingCharacters = new Set(["\u180E", "\u202F"]);
const mongolianBlockConnectorPattern = /[\u1800-\u180F]/u;

export function verticalBlockScriptKindForLanguage(language: string | null | undefined): VerticalScriptKind | null {
	const script = explicitScriptSubtag(language);
	if (script === "Mong") {
		return "mong";
	}
	if (script === "Phag") {
		return "phag";
	}
	return null;
}

export function segmentVerticalScriptRuns(text: string): VerticalScriptTextSegment[] {
	const segments: VerticalScriptTextSegment[] = [];
	let normalStart = 0;
	let runStart: number | null = null;
	let runEnd = 0;
	let runKind: VerticalScriptKind | null = null;

	function flushRun(): void {
		if (runStart === null || !runKind) {
			return;
		}
		if (runStart > normalStart) {
			segments.push({ text: text.slice(normalStart, runStart), verticalScript: null });
		}
		if (runEnd > runStart) {
			segments.push({ text: text.slice(runStart, runEnd), verticalScript: runKind });
		}
		normalStart = runEnd;
		runStart = null;
		runEnd = 0;
		runKind = null;
	}

	for (let index = 0; index < text.length;) {
		const character = codePointAt(text, index);
		const end = index + character.length;
		const characterKind = verticalScriptAnchorKind(character);
		if (runKind) {
			if (characterKind === runKind) {
				runEnd = end;
			} else if (characterKind) {
				flushRun();
				runStart = index;
				runEnd = end;
				runKind = characterKind;
			} else if (isVerticalScriptRunConnector(character)) {
				if (isTrailingVerticalScriptRunConnector(character)) {
					runEnd = end;
				}
			} else {
				flushRun();
			}
		} else if (characterKind) {
			runStart = index;
			runEnd = end;
			runKind = characterKind;
		}
		index = end;
	}
	flushRun();
	if (normalStart < text.length) {
		segments.push({ text: text.slice(normalStart), verticalScript: null });
	}
	return segments.length ? segments : [{ text, verticalScript: null }];
}

function codePointAt(text: string, index: number): string {
	const codePoint = text.codePointAt(index);
	if (codePoint === undefined) {
		return "";
	}
	return String.fromCodePoint(codePoint);
}

function verticalScriptAnchorKind(character: string): VerticalScriptKind | null {
	if (!unicodeLetterPattern.test(character)) {
		return null;
	}
	if (mongolianScriptCharacterPattern.test(character)) {
		return "mong";
	}
	if (phagsPaScriptCharacterPattern.test(character)) {
		return "phag";
	}
	return null;
}

function isVerticalScriptRunConnector(character: string): boolean {
	return (
		unicodeWhitespacePattern.test(character) ||
		mongolianSupplementalSpacingCharacters.has(character) ||
		mongolianBlockConnectorPattern.test(character) ||
		mongolianScriptExtensionPattern.test(character) ||
		phagsPaScriptExtensionPattern.test(character)
	);
}

function isTrailingVerticalScriptRunConnector(character: string): boolean {
	return (
		mongolianSupplementalSpacingCharacters.has(character) ||
		mongolianBlockConnectorPattern.test(character) ||
		(!unicodeWhitespacePattern.test(character) &&
			(mongolianScriptExtensionPattern.test(character) || phagsPaScriptExtensionPattern.test(character)))
	);
}

export function TranslatableText({
	as,
	className,
	directionMode = "element",
	interactiveReferences = true,
	onReference,
	rich = false,
	text,
	verticalScriptLayout = "inline",
	worldHandle,
}: {
	as?: "div" | "h1" | "p" | "span";
	className?: string;
	directionMode?: "element" | "lines";
	interactiveReferences?: boolean;
	onReference?: OpenReference;
	rich?: boolean;
	text: TextLike;
	verticalScriptLayout?: "inline" | "block";
	worldHandle?: string;
}) {
	const translationConfig = useContext(TranslationContext);
	const toast = useContext(ToastContext);
	const sourceText = typeof text === "string" ? text : localizedTextString(text);
	const sourceLang = typeof text === "string" ? null : localizedTextLang(text);
	const cacheKey =
		translationConfig.enabled && sourceText.trim() ?
			translationCacheKey(sourceText, translationConfig.model, translationConfig.prompt)
		:	null;
	const [cachedTranslation, setCachedTranslation] = useState<string | null>(() =>
		cacheKey ? readTranslationCacheValue(cacheKey) : null,
	);
	const [showTranslation, setShowTranslation] = useState(() => {
		if (!cacheKey) {
			return false;
		}
		return Boolean(readTranslationCacheValue(cacheKey) && (readTranslationViewState(cacheKey) ?? true));
	});
	const [loading, setLoading] = useState(false);
	const Tag = as ?? "span";
	const visibleText = showTranslation && cachedTranslation ? cachedTranslation : sourceText;
	const visibleLang = showTranslation && cachedTranslation ? null : sourceLang;
	const enabled = Boolean(cacheKey);
	const verticalBlockScript =
		verticalScriptLayout === "block" ? verticalBlockScriptKindForLanguage(visibleLang) : null;
	const dir =
		verticalBlockScript ? textDirectionForLanguage(visibleLang)
		: directionMode === "lines" ? undefined
		: textDirectionForLanguage(visibleLang);

	useEffect(() => {
		if (!cacheKey) {
			setCachedTranslation(null);
			setShowTranslation(false);
			setLoading(false);
			return;
		}
		const nextTranslation = readTranslationCacheValue(cacheKey);
		setCachedTranslation(nextTranslation);
		setShowTranslation(Boolean(nextTranslation && (readTranslationViewState(cacheKey) ?? true)));
		setLoading(false);
	}, [cacheKey]);

	async function translate(): Promise<void> {
		if (!cacheKey || loading) {
			return;
		}
		setLoading(true);
		const result = await api<{ translation: string }>("/api/me/translate", {
			method: "POST",
			body: { text: sourceText },
		});
		setLoading(false);
		if (!result.ok) {
			toast.push(result.message);
			return;
		}
		writeTranslationCacheValue(cacheKey, result.data.translation);
		writeTranslationViewState(cacheKey, true);
		setCachedTranslation(result.data.translation);
		setShowTranslation(true);
	}

	function toggle(): void {
		if (!cacheKey || !cachedTranslation) {
			return;
		}
		const next = !showTranslation;
		writeTranslationViewState(cacheKey, next);
		setShowTranslation(next);
	}

	const content =
		verticalBlockScript ?
			rich && onReference ?
				<RichText
					interactive={interactiveReferences}
					onReference={onReference}
					text={visibleText}
					verticalScriptHandling="none"
					worldHandle={worldHandle}
				/>
			:	<PlainText text={visibleText} verticalScriptHandling="none" />
		: directionMode === "lines" ?
			<DirectionalTextLines
				interactiveReferences={interactiveReferences}
				onReference={onReference}
				rich={rich}
				text={visibleText}
				worldHandle={worldHandle}
			/>
		: rich && onReference ?
			<RichText interactive={interactiveReferences} onReference={onReference} text={visibleText} worldHandle={worldHandle} />
		:	<PlainText text={visibleText} />;

	return (
		<Tag
			className={[
				"translatable-text",
				directionMode === "lines" && !verticalBlockScript ? "bidi-line-text" : "",
				verticalBlockScript ? "vertical-script-block" : "",
				verticalBlockScript ? `vertical-script-block-${verticalBlockScript}` : "",
				className ?? "",
			].filter(Boolean).join(" ")}
			dir={dir}
			lang={visibleLang ?? undefined}
		>
			<span className="translatable-content">{content}</span>
			{enabled && (
				<span className="translation-controls">
					<button
						aria-label={cachedTranslation ? "Re-translate" : "Translate"}
						className="translation-action"
						disabled={loading}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void translate();
						}}
						title={cachedTranslation ? "Re-translate" : "Translate"}
						type="button"
					>
						{loading ? <span className="spinner" /> : <Icon name={cachedTranslation ? "refresh" : "translate"} size={13} />}
					</button>
					{cachedTranslation && (
						<button
							aria-label={showTranslation ? "Show original" : "Show translation"}
							className="translation-action"
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								toggle();
							}}
							title={showTranslation ? "Show original" : "Show translation"}
							type="button"
						>
							<Icon name={showTranslation ? "original" : "translate"} size={13} />
						</button>
					)}
				</span>
			)}
		</Tag>
	);
}

function DirectionalTextLines({
	interactiveReferences,
	onReference,
	rich,
	text,
	worldHandle,
}: {
	interactiveReferences: boolean;
	onReference?: OpenReference;
	rich: boolean;
	text: string;
	worldHandle?: string;
}) {
	const lines = text.split(/\r\n|\n|\r/);
	return (
		<>
				{lines.map((line, index) => (
					<span className={line ? "bidi-line" : "bidi-line bidi-line-empty"} dir="auto" key={index}>
					{line ?
						rich && onReference ?
							<RichText interactive={interactiveReferences} onReference={onReference} text={line} worldHandle={worldHandle} />
						:	<PlainText text={line} />
					:	"\u00a0"}
				</span>
			))}
		</>
	);
}

export function PlainText({
	text,
	verticalScriptHandling = "inline",
}: {
	text: string;
	verticalScriptHandling?: VerticalScriptHandling;
}) {
	const parts: ReactNode[] = [];
	appendRichTextPlainSegment(parts, text, 0, { verticalScriptHandling });
	return <>{parts}</>;
}

export function RichText({
	interactive = true,
	onReference,
	text,
	verticalScriptHandling = "inline",
	worldHandle,
}: {
	interactive?: boolean;
	onReference: OpenReference;
	text: string;
	verticalScriptHandling?: VerticalScriptHandling;
	worldHandle?: string;
}) {
	const parts: ReactNode[] = [];
	let cursor = 0;
	for (const match of text.matchAll(richTextReferencePattern)) {
		const index = match.index ?? 0;
		const boundary = match[1] ?? "";
		const refStart = index + boundary.length;
		if (refStart > cursor) {
			appendRichTextPlainSegment(parts, text.slice(cursor, refStart), cursor, { linkifyContentUrls: interactive, verticalScriptHandling });
		}
		const handlePrefix = (match[2] ?? "").toLowerCase();
		const handleName = match[3];
		const threadBody = match[4];
		const commentBody = match[5];
		const matchedRefText = text.slice(refStart, index + match[0].length);
		if (handlePrefix && handleName) {
			const name = normalizeHandleText(handleName);
			const kind: ReferenceKind = handlePrefix === "u" ? "bot" : handlePrefix === "w" ? "world" : "forum";
			parts.push(
				interactive ?
					<Reference
						isBot={kind === "bot"}
						key={`${refStart}:${handlePrefix}:${name}`}
						kind={kind}
						name={name}
						onOpen={() => onReference(kind, name, { worldHandle })}
						worldHandle={worldHandle}
					/>
				:	<ReferenceLabel isBot={kind === "bot"} key={`${refStart}:${handlePrefix}:${name}`} kind={kind} name={name} />,
			);
		} else if (threadBody) {
			const id = parseThreadRef(`t/${threadBody}`);
			if (id) {
				parts.push(<ContentReference id={id} interactive={interactive} key={`${refStart}:t:${id}`} type="thread" />);
			} else {
				appendRichTextPlainSegment(parts, matchedRefText, refStart, { linkifyContentUrls: interactive, verticalScriptHandling });
			}
		} else if (commentBody) {
			const id = parseCommentRef(`c/${commentBody}`);
			if (id) {
				parts.push(<ContentReference id={id} interactive={interactive} key={`${refStart}:c:${id}`} type="comment" />);
			} else {
				appendRichTextPlainSegment(parts, matchedRefText, refStart, { linkifyContentUrls: interactive, verticalScriptHandling });
			}
		}
		cursor = index + match[0].length;
	}
	if (cursor < text.length) {
		appendRichTextPlainSegment(parts, text.slice(cursor), cursor, { linkifyContentUrls: interactive, verticalScriptHandling });
	}
	if (parts.length === 0) {
		return null;
	}
	return <>{parts}</>;
}

function appendRichTextPlainSegment(
	parts: ReactNode[],
	text: string,
	offset: number,
	options: { linkifyContentUrls?: boolean; verticalScriptHandling?: VerticalScriptHandling } = {},
): void {
	const lines = text.split(/\r\n|\n|\r/);
	let lineOffset = offset;
	for (let index = 0; index < lines.length; index += 1) {
		if (index > 0) {
			parts.push(<br key={`br:${offset}:${index}`} />);
			lineOffset += 1;
		}
		const line = lines[index] ?? "";
		if (line) {
			if (options.linkifyContentUrls) {
				appendContentUrlLinkedText(parts, line, lineOffset, options.verticalScriptHandling ?? "inline");
			} else {
				appendVerticalScriptText(parts, line, lineOffset, options.verticalScriptHandling ?? "inline");
			}
		}
		lineOffset += line.length;
	}
}

function appendContentUrlLinkedText(
	parts: ReactNode[],
	text: string,
	offset: number,
	verticalScriptHandling: VerticalScriptHandling,
): void {
	const matches = findBickrContentUrlMatches(text);
	let cursor = 0;
	for (const match of matches) {
		if (match.start > cursor) {
			appendVerticalScriptText(parts, text.slice(cursor, match.start), offset + cursor, verticalScriptHandling);
		}
		parts.push(<BickrContentUrlLink key={`url:${offset + match.start}`} match={match} />);
		cursor = match.end;
	}
	if (cursor < text.length) {
		appendVerticalScriptText(parts, text.slice(cursor), offset + cursor, verticalScriptHandling);
	}
}

function appendVerticalScriptText(
	parts: ReactNode[],
	text: string,
	offset: number,
	verticalScriptHandling: VerticalScriptHandling,
): void {
	if (verticalScriptHandling === "none") {
		parts.push(text);
		return;
	}
	let cursor = 0;
	for (const segment of segmentVerticalScriptRuns(text)) {
		if (!segment.text) {
			continue;
		}
		if (segment.verticalScript) {
			parts.push(
				<span
					className={`vertical-script-run vertical-script-run-${segment.verticalScript}`}
					dir="ltr"
					key={`vs:${offset + cursor}:${segment.verticalScript}`}
				>
					{segment.text}
				</span>,
			);
		} else {
			parts.push(segment.text);
		}
		cursor += segment.text.length;
	}
}

function translationCacheKey(text: string, model: string, prompt: string): string {
	return `${translationCacheVersion}:${hash(`${model}\n${prompt}\n${text}`)}:${text.length}`;
}

function readTranslationCacheValue(key: string): string | null {
	const value = readTranslationStorage(translationCacheStorageKey)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function writeTranslationCacheValue(key: string, translation: string): void {
	const cache = readTranslationStorage(translationCacheStorageKey);
	cache[key] = translation;
	writeTranslationStorage(translationCacheStorageKey, cache);
}

function readTranslationViewState(key: string): boolean | null {
	const value = readTranslationStorage(translationViewStorageKey)[key];
	return typeof value === "boolean" ? value : null;
}

function writeTranslationViewState(key: string, showTranslation: boolean): void {
	const state = readTranslationStorage(translationViewStorageKey);
	state[key] = showTranslation;
	writeTranslationStorage(translationViewStorageKey, state);
}

function readTranslationStorage(key: string): Record<string, string | boolean> {
	try {
		const raw = window.localStorage.getItem(key);
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
				(parsed as Record<string, string | boolean>)
			:	{};
	} catch {
		return {};
	}
}

function writeTranslationStorage(key: string, value: Record<string, string | boolean>): void {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Browser storage can be unavailable or full; translation still works for the current render.
	}
}
