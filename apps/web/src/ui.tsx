import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

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
