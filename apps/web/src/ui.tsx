import { createContext, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { localizedTextString, type AvatarCrop, type LocalizedText } from "@bickr/shared/model";
import { avatarCropImageStyle } from "./avatar-crop";
import {
	avatarCroppedThumbnailUrl,
	avatarDisplayPixels,
	avatarImagePixels,
	avatarThumbnailUrl,
} from "./avatar-image-urls";

export type TextLike = string | LocalizedText;

export function textValue(value: TextLike | null | undefined): string {
	return localizedTextString(value);
}

export type IconName =
	| "plus"
	| "menu"
	| "search"
	| "chev"
	| "x"
	| "edit"
	| "trash"
	| "minusCircle"
	| "world"
	| "forum"
	| "bot"
	| "bell"
	| "checklist"
	| "link"
	| "settings"
	| "github"
	| "discord"
	| "google"
	| "chirper"
	| "info"
	| "install"
	| "crop"
	| "upload"
	| "refresh"
	| "clock"
	| "play"
	| "sun"
	| "moon"
	| "monitor"
	| "sparkles"
	| "translate"
	| "original"
	| "chat"
	| "arrowUp"
	| "arrowDown";

export function Modal({
	children,
	className,
	foot,
	onClose,
	open,
	title,
	wide,
}: {
	children: ReactNode;
	className?: string;
	foot?: ReactNode;
	onClose: () => void;
	open: boolean;
	title: string;
	wide?: boolean;
}) {
	useEffect(() => {
		if (!open) {
			return undefined;
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, open]);

	if (!open) {
		return null;
	}

	return (
		<div
			className="modal-veil"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div className={["modal", wide ? "wide" : "", className ?? ""].filter(Boolean).join(" ")}>
				<div className="modal-head">
					<h2>{title}</h2>
					<button aria-label="Close" className="x" onClick={onClose} type="button">
						<svg
							fill="none"
							height={16}
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.6}
							viewBox="0 0 24 24"
							width={16}
						>
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</div>
				<div className="modal-body">{children}</div>
				{foot && <div className="modal-foot">{foot}</div>}
			</div>
		</div>
	);
}

export function Field({
	children,
	className,
	help,
	hint,
	label,
	labelAction,
}: {
	children: ReactNode;
	className?: string;
	help?: ReactNode;
	hint?: string;
	label?: ReactNode;
	labelAction?: ReactNode;
}) {
	return (
		<div className={className ? `field ${className}` : "field"}>
			{label && labelAction ? (
				<div className="field-label-row">
					<label>
						{label}
						{hint && <span className="hint">{hint}</span>}
					</label>
					{labelAction}
				</div>
			) : label ? (
				<label>
					<span className="field-label-main">
						{label}
						{hint && <span className="hint">{hint}</span>}
					</span>
				</label>
			) : null}
			{children}
			{help && <div className="help">{help}</div>}
		</div>
	);
}

export function FallbackImage({
	alt,
	className,
	fallbackSrc,
	onFinalError,
	src,
	style,
}: {
	alt: string;
	className?: string;
	fallbackSrc?: string;
	onFinalError?: () => void;
	src: string;
	style?: CSSProperties;
}) {
	const [usingFallback, setUsingFallback] = useState(false);
	useEffect(() => {
		setUsingFallback(false);
	}, [fallbackSrc, src]);
	const activeSrc = usingFallback && fallbackSrc ? fallbackSrc : src;
	return (
		<img
			alt={alt}
			className={className}
			onError={() => {
				if (!usingFallback && fallbackSrc && fallbackSrc !== src) {
					setUsingFallback(true);
					return;
				}
				onFinalError?.();
			}}
			src={activeSrc}
			style={style}
		/>
	);
}

export function ImageLightbox({
	onClose,
	title,
	url,
}: {
	onClose: () => void;
	title: string;
	url: string | null;
}) {
	return (
		<Modal className="image-lightbox" onClose={onClose} open={Boolean(url)} title={title} wide>
			{url && <img alt="" src={url} />}
		</Modal>
	);
}

export function useViewportConstrainedPopout<T extends HTMLElement>(active: boolean) {
	const ref = useRef<T | null>(null);
	const update = useCallback(() => {
		const element = ref.current;
		if (!active || !element) {
			return;
		}
		const viewportMargin = 8;
		const maxWidth = Math.max(1, window.innerWidth - viewportMargin * 2);
		element.style.setProperty("--popout-max-width", `${Math.floor(maxWidth)}px`);
		element.style.setProperty("--popout-shift-x", "0px");

		const rect = element.getBoundingClientRect();
		let shiftX = 0;
		if (rect.left < viewportMargin) {
			shiftX = viewportMargin - rect.left;
		}
		const rightOverflow = rect.right + shiftX - (window.innerWidth - viewportMargin);
		if (rightOverflow > 0) {
			shiftX -= rightOverflow;
		}
		element.style.setProperty("--popout-shift-x", `${Math.round(shiftX)}px`);
	}, [active]);

	useLayoutEffect(() => {
		if (!active) {
			return undefined;
		}
		const frame = window.requestAnimationFrame(update);
		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
		};
	}, [active, update]);

	return ref;
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
	const stroke = {
		fill: "none",
		stroke: "currentColor",
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		strokeWidth: 1.6,
	};
	const icons: Record<IconName, ReactNode> = {
		plus: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 5v14M5 12h14" />
			</svg>
		),
		menu: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 7h16M4 12h16M4 17h16" />
			</svg>
		),
		search: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="11" cy="11" r="6.5" />
				<path d="m20 20-3.5-3.5" />
			</svg>
		),
		chev: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="m9 6 6 6-6 6" />
			</svg>
		),
		x: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M6 6l12 12M18 6 6 18" />
			</svg>
		),
		edit: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 20h4l10-10-4-4L4 16v4z" />
				<path d="m13.5 6.5 4 4" />
			</svg>
		),
		trash: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
			</svg>
		),
		minusCircle: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="9" />
				<path d="M8 12h8" />
			</svg>
		),
		world: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="9" />
				<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
			</svg>
		),
		forum: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z" />
			</svg>
		),
		bot: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<rect height="13" rx="2" width="16" x="4" y="7" />
				<path d="M9 12h.01M15 12h.01M12 3v4M8 17h8" />
			</svg>
		),
		bell: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2H4.5z" />
				<path d="M10 21h4" />
			</svg>
		),
		checklist: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="m4 7 2 2 4-4" />
				<path d="M12 8h8" />
				<path d="m4 16 2 2 4-4" />
				<path d="M12 17h8" />
			</svg>
		),
		link: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
				<path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
			</svg>
		),
		settings: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
			</svg>
		),
		github: (
			<svg fill="currentColor" height={size} viewBox="0 0 24 24" width={size}>
				<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.17a11 11 0 0 1 5.74 0c2.18-1.48 3.14-1.17 3.14-1.17.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.07 0 4.4-2.68 5.36-5.24 5.65.42.36.79 1.06.79 2.13v3.16c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
			</svg>
		),
		discord: (
			<svg fill="currentColor" height={size} viewBox="0 0 64 48" width={size * 4 / 3}>
				<path d="M40.575 0C39.9562 1.09866 39.4006 2.2352 38.8954 3.397C34.0967 2.67719 29.2096 2.67719 24.3982 3.397C23.9057 2.2352 23.3374 1.09866 22.7186 0C18.2104 0.770324 13.8157 2.12155 9.64839 4.02841C1.38951 16.2652 -0.845688 28.1863 0.265599 39.9432C5.10222 43.517 10.5197 46.2447 16.2909 47.9874C17.5916 46.2447 18.7407 44.3883 19.7257 42.4562C17.8568 41.7616 16.0509 40.8903 14.3208 39.88C14.7755 39.5517 15.2175 39.2107 15.6468 38.8824C25.7873 43.6559 37.5316 43.6559 47.6847 38.8824C48.1141 39.236 48.5561 39.577 49.0107 39.88C47.2806 40.9029 45.4748 41.7616 43.5931 42.4688C44.5781 44.4009 45.7273 46.2573 47.028 48C52.7991 46.2573 58.2167 43.5422 63.0533 39.9684C64.3666 26.3299 60.8055 14.5099 53.6452 4.04104C49.4905 2.13418 45.0959 0.782952 40.5876 0.0252565L40.575 0ZM21.1401 32.7072C18.0209 32.7072 15.4321 29.8785 15.4321 26.3804C15.4321 22.8824 17.9199 20.041 21.1275 20.041C24.3351 20.041 26.886 22.895 26.8354 26.3804C26.7849 29.8658 24.3224 32.7072 21.1401 32.7072ZM42.1788 32.7072C39.047 32.7072 36.4834 29.8785 36.4834 26.3804C36.4834 22.8824 38.9712 20.041 42.1788 20.041C45.3864 20.041 47.9246 22.895 47.8741 26.3804C47.8236 29.8658 45.3611 32.7072 42.1788 32.7072Z" />
			</svg>
		),
		google: (
			<svg fill="currentColor" height={size} viewBox="0 0 24 24" width={size}>
				<path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" />
				<path d="M12 22c2.7 0 5-0.9 6.6-2.5L15.4 17c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
				<path d="M6.4 13.8a6 6 0 0 1 0-3.6V7.6H3.1a10 10 0 0 0 0 8.8z" />
				<path d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.8-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.9 5.6l3.3 2.6C7.2 7.9 9.4 6.1 12 6.1z" />
			</svg>
		),
		chirper: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 3 8 9l-4 1 4 1 1 4 1-4 4-1-4-1z" />
				<circle cx="17" cy="15" r="3" />
			</svg>
		),
		info: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 8h.01M11 12h1v5h1" />
			</svg>
		),
		install: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 3v11M7 9l5 5 5-5" />
				<path d="M5 17v3h14v-3" />
			</svg>
		),
		crop: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M6 2v16h16" />
				<path d="M2 6h16v16" />
				<path d="M10 6v8h8" />
			</svg>
		),
		upload: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 16V4M6 10l6-6 6 6M4 21h16" />
			</svg>
		),
		refresh: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M20 11a8 8 0 0 0-14.6-4M4 7V3m0 4h4M4 13a8 8 0 0 0 14.6 4M20 17v4m0-4h-4" />
			</svg>
		),
		clock: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 7v5l3 2" />
			</svg>
		),
		play: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M8 5v14l11-7z" />
			</svg>
		),
		sun: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
			</svg>
		),
		moon: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M20 14.5A7.5 7.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
			</svg>
		),
		monitor: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<rect height="12" rx="2" width="18" x="3" y="4" />
				<path d="M8 20h8M12 16v4" />
			</svg>
		),
		sparkles: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />
				<path d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7zM5 2l.7 2.3L8 5l-2.3.7L5 8l-.7-2.3L2 5l2.3-.7z" />
			</svg>
		),
		translate: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 5h9M8.5 3v2M10 5c-.7 3.6-2.7 6.4-6 8" />
				<path d="M5.8 8.8c1 1.4 2.3 2.5 3.8 3.3M13 21l4-10 4 10M14.4 17.5h5.2" />
			</svg>
		),
			original: (
				<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
					<path d="M7 4h7l4 4v12H7z" />
					<path d="M14 4v4h4M10 13h5M10 17h4" />
				</svg>
			),
			chat: (
				<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
					<path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v5A3.5 3.5 0 0 1 15.5 15H10l-5 4v-4.8A3.5 3.5 0 0 1 3 11V6.5z" />
					<path d="M8 7h8M8 11h5" />
				</svg>
			),
			arrowUp: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 19V5M6 11l6-6 6 6" />
			</svg>
		),
		arrowDown: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 5v14M6 13l6 6 6-6" />
			</svg>
		),
	};
	return icons[name];
}

export function Avatar({
	actor = "bot",
	colorSeed,
	crop,
	displayPixels,
	fit = "cover",
	imageUrl,
	name,
	size = "md",
}: {
	actor?: "bot" | "user" | "world";
	colorSeed?: string | number;
	crop?: AvatarCrop;
	displayPixels?: number;
	fit?: "cover" | "contain";
	imageUrl?: string;
	name: TextLike;
	size?: "sm" | "md" | "lg" | "xl" | "hero";
}) {
	const [imageFailed, setImageFailed] = useState(false);
	useEffect(() => {
		setImageFailed(false);
	}, [crop, imageUrl]);
	const displayName = typeof name === "string" ? name : localizedTextString(name);
	const className = `avatar ${size === "sm" ? "sm" : size === "lg" ? "lg" : size === "xl" ? "xl" : size === "hero" ? "hero" : ""}`.trim();
	const cropActive = Boolean(crop && fit === "cover");
	const targetPixels = avatarImagePixels(avatarDisplayPixels(size, displayPixels));
	const imageSrc = imageUrl && !imageFailed ?
		cropActive && crop ? avatarCroppedThumbnailUrl(imageUrl, targetPixels, crop) : avatarThumbnailUrl(imageUrl, targetPixels, fit)
	:	"";
	return (
		<span className={className} data-actor={actor} style={avatarStyle(colorSeed ?? displayName)}>
			{imageSrc ?
				<FallbackImage
					alt=""
					className={`avatar-img ${cropActive ? "crop" : fit}`}
					fallbackSrc={imageUrl}
					onFinalError={() => setImageFailed(true)}
					src={imageSrc}
					style={cropActive && crop ? avatarCropImageStyle(crop) as CSSProperties : undefined}
				/>
			:	initials(displayName)
			}
		</span>
	);
}

export function hash(value: string): number {
	let current = 0;
	for (let index = 0; index < value.length; index += 1) {
		current = (current * 31 + value.charCodeAt(index)) | 0;
	}
	return Math.abs(current);
}

export function initials(name: TextLike): string {
	const parts = (typeof name === "string" ? name : localizedTextString(name)).trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return "?";
	}
	if (parts.length === 1) {
		return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
	}
	return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

export function avatarStyle(seed: string | number): CSSProperties {
	const hue = typeof seed === "number" ? seed : hash(seed) % 360;
	return {
		background: `oklch(0.86 0.06 ${hue})`,
		color: `oklch(0.30 0.10 ${hue})`,
	};
}

export const ToastContext = createContext<{ push: (message: ReactNode) => void }>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Array<{ id: string; message: ReactNode }>>([]);

	function push(message: ReactNode): void {
		const id = crypto.randomUUID();
		setToasts((current) => [...current, { id, message }]);
		window.setTimeout(() => {
			setToasts((current) => current.filter((toast) => toast.id !== id));
		}, 2400);
	}

	return (
		<ToastContext.Provider value={{ push }}>
			{children}
			<div className="toast-stack">
				{toasts.map((toast) => (
					<div className="toast" key={toast.id}>
						{toast.message}
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}

export function SubscriptionButton({
	active,
	label = "Watch",
	onToggle,
	title,
}: {
	active: boolean;
	label?: string;
	onToggle: (active: boolean) => void;
	title?: string;
}) {
	return (
		<button
			aria-pressed={active}
			className={`btn watch-btn ${active ? "active" : ""}`}
			onClick={() => onToggle(!active)}
			title={title}
			type="button"
		>
			<Icon name="bell" size={13} />
			{active ? "Watching" : label}
		</button>
	);
}

export function ActivityBanner({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button className="activity-banner" onClick={onClick} type="button">
			<Icon name="refresh" size={14} />
			<span>{label}</span>
		</button>
	);
}

export function FilterBox({
	label,
	onChange,
	placeholder,
	value,
}: {
	label: string;
	onChange: (value: string) => void;
	placeholder: string;
	value: string;
}) {
	return (
		<div className="list-filter">
			<Icon name="search" size={14} />
			<input
				aria-label={label}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				value={value}
			/>
			{value && (
				<button aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange("")} type="button">
					<Icon name="x" size={13} />
				</button>
			)}
		</div>
	);
}

export function EmptyState({
	actionLabel,
	children,
	onAction,
	title,
}: {
	actionLabel?: string;
	children: ReactNode;
	onAction?: () => void;
	title: string;
}) {
	return (
		<div className="empty">
			<h3>{title}</h3>
			<p>{children}</p>
			{actionLabel && onAction && (
				<button className="btn primary" onClick={onAction} type="button">
					<Icon name="plus" size={14} />
					{actionLabel}
				</button>
			)}
		</div>
	);
}

export function PermissionState({ children, title }: { children: ReactNode; title: string }) {
	return (
		<div className="main-inner">
			<EmptyState title={title}>{children}</EmptyState>
		</div>
	);
}

export function Confirm({
	body,
	confirmText = "Confirm",
	danger,
	onClose,
	onConfirm,
	open,
	title,
}: {
	body: ReactNode;
	confirmText?: string;
	danger?: boolean;
	onClose: () => void;
	onConfirm: () => void;
	open: boolean;
	title: string;
}) {
	return (
		<Modal
			foot={
				<>
					<span />
					<div className="right">
						<button className="btn ghost" onClick={onClose} type="button">
							Cancel
						</button>
						<button
							className={`btn ${danger ? "danger solid" : "primary"}`}
							onClick={() => {
								onConfirm();
								onClose();
							}}
							type="button"
						>
							{confirmText}
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title={title}
		>
			<div className="confirm-body">{body}</div>
		</Modal>
	);
}
