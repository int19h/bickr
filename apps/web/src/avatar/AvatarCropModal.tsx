import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type SyntheticEvent as ReactSyntheticEvent,
} from "react";
import type { AvatarCrop, BotSummary } from "@bickr/shared/model";

import { api } from "../api";
import {
	avatarCropOverlayStyle,
	centeredAvatarCrop,
	clampAvatarCrop,
	moveAvatarCrop,
	normalizedCropDimensions,
	resizeAvatarCrop,
	type AvatarCropCorner,
	type AvatarCropDisplayBox,
} from "../avatar-crop";
import { runApiAction } from "../use-api";
import { Modal } from "../ui";
import type { AvatarTarget } from "./target";

type AvatarCropDragState = {
	corner?: AvatarCropCorner;
	imageRect: DOMRect;
	pointerId: number;
	startCrop: AvatarCrop;
	startX: number;
	startY: number;
	type: "move" | "resize";
};

function sameAvatarCropDisplayBox(left: AvatarCropDisplayBox | null, right: AvatarCropDisplayBox): boolean {
	return Boolean(
		left &&
			Math.abs(left.left - right.left) < 0.5 &&
			Math.abs(left.top - right.top) < 0.5 &&
			Math.abs(left.width - right.width) < 0.5 &&
			Math.abs(left.height - right.height) < 0.5,
	);
}

function throwApiError(message: string): never {
	throw new Error(message);
}

export function AvatarCropModal<TMutationResponse, TSaved>({
	onClose,
	onSaved,
	open,
	target,
}: {
	onClose: () => void;
	onSaved: (saved: TSaved, affectedBots?: BotSummary[]) => void;
	open: boolean;
	target: AvatarTarget<TMutationResponse, TSaved>;
}) {
	const frameRef = useRef<HTMLDivElement | null>(null);
	const imageRef = useRef<HTMLImageElement | null>(null);
	const dragRef = useRef<AvatarCropDragState | null>(null);
	const [draft, setDraft] = useState<AvatarCrop | null>(null);
	const [cropDisplayBox, setCropDisplayBox] = useState<AvatarCropDisplayBox | null>(null);
	const [saving, setSaving] = useState(false);
	const [imageReady, setImageReady] = useState(false);
	const [error, setError] = useState("");

	const measureCropDisplayBox = useCallback(() => {
		const frame = frameRef.current;
		const image = imageRef.current;
		if (!frame || !image) {
			setCropDisplayBox(null);
			return;
		}
		const frameRect = frame.getBoundingClientRect();
		const imageRect = image.getBoundingClientRect();
		if (frameRect.width <= 0 || frameRect.height <= 0 || imageRect.width <= 0 || imageRect.height <= 0) {
			setCropDisplayBox(null);
			return;
		}
		const next = {
			height: imageRect.height,
			left: imageRect.left - frameRect.left,
			top: imageRect.top - frameRect.top,
			width: imageRect.width,
		};
		setCropDisplayBox((current) => sameAvatarCropDisplayBox(current, next) ? current : next);
	}, []);

	useEffect(() => {
		if (!open) {
			setDraft(null);
			setCropDisplayBox(null);
			setSaving(false);
			setImageReady(false);
			setError("");
			dragRef.current = null;
		}
	}, [open]);

	useEffect(() => {
		if (open) {
			setDraft(null);
			setCropDisplayBox(null);
			setImageReady(false);
			setError("");
			dragRef.current = null;
		}
	}, [target.owner.avatarUrl, open]);

	useLayoutEffect(() => {
		if (!open || !imageReady) {
			return;
		}
		measureCropDisplayBox();
	}, [draft?.imageHeight, draft?.imageWidth, imageReady, measureCropDisplayBox, open]);

	useEffect(() => {
		if (!open || !imageReady) {
			return undefined;
		}
		const measure = () => measureCropDisplayBox();
		window.addEventListener("resize", measure);
		window.addEventListener("orientationchange", measure);
		let observer: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(measure);
			if (frameRef.current) {
				observer.observe(frameRef.current);
			}
			if (imageRef.current) {
				observer.observe(imageRef.current);
			}
		}
		measure();
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("orientationchange", measure);
			observer?.disconnect();
		};
	}, [imageReady, measureCropDisplayBox, open]);

	function handleImageLoad(event: ReactSyntheticEvent<HTMLImageElement>): void {
		const image = event.currentTarget;
		if (!image.naturalWidth || !image.naturalHeight) {
			setImageReady(false);
			setDraft(null);
			setError("This avatar does not expose usable image dimensions.");
			return;
		}
		const dimensions = normalizedCropDimensions(image.naturalWidth, image.naturalHeight);
		const existing =
			target.owner.avatarCrop?.imageWidth === dimensions.imageWidth && target.owner.avatarCrop.imageHeight === dimensions.imageHeight ?
				target.owner.avatarCrop
			:	null;
		setDraft(existing ? clampAvatarCrop(existing) : centeredAvatarCrop(dimensions.imageWidth, dimensions.imageHeight));
		setImageReady(true);
		setError("");
	}

	function beginCropDrag(
		event: ReactPointerEvent<HTMLElement>,
		type: AvatarCropDragState["type"],
		corner?: AvatarCropCorner,
	): void {
		if (!draft || !imageRef.current) {
			return;
		}
		const imageRect = imageRef.current.getBoundingClientRect();
		if (imageRect.width <= 0 || imageRect.height <= 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			imageRect,
			pointerId: event.pointerId,
			startCrop: draft,
			startX: event.clientX,
			startY: event.clientY,
			type,
			...(corner ? { corner } : {}),
		};
	}

	function updateCropDrag(event: ReactPointerEvent<HTMLElement>): void {
		const drag = dragRef.current;
		if (!drag || event.pointerId !== drag.pointerId) {
			return;
		}
		event.preventDefault();
		const dx = ((event.clientX - drag.startX) * drag.startCrop.imageWidth) / drag.imageRect.width;
		const dy = ((event.clientY - drag.startY) * drag.startCrop.imageHeight) / drag.imageRect.height;
		setDraft(
			drag.type === "move" ?
				moveAvatarCrop(drag.startCrop, dx, dy)
			:	resizeAvatarCrop(drag.startCrop, drag.corner ?? "se", dx, dy),
		);
	}

	function endCropDrag(event: ReactPointerEvent<HTMLElement>): void {
		const drag = dragRef.current;
		if (!drag || event.pointerId !== drag.pointerId) {
			return;
		}
		try {
			event.currentTarget.releasePointerCapture(event.pointerId);
		} catch {
			// The pointer may already have been released by the browser when the gesture is cancelled.
		}
		dragRef.current = null;
	}

	async function saveCrop(): Promise<void> {
		if (!draft) {
			return;
		}
		setSaving(true);
		setError("");
		try {
			const result = await runApiAction(throwApiError, () => api<TMutationResponse>(target.endpoints.crop, {
				method: "PATCH",
				body: { crop: draft },
			}));
			const saved = target.readSaved(result.data);
			onSaved(saved.saved, saved.affectedBots);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not save avatar crop.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal
			className="avatar-crop-modal"
			foot={
				<>
					<span className="meta">{draft ? `${draft.size} x ${draft.size}` : ""}</span>
					<div className="right">
						<button className="btn ghost" disabled={saving} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!draft || !imageReady || saving} onClick={() => void saveCrop()} type="button">
							{saving ? "Saving..." : "Save"}
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title="Crop avatar"
			wide
		>
			{target.owner.avatarUrl ?
				<div className="avatar-crop-stage">
					<div className="avatar-crop-frame" ref={frameRef}>
						<img
							alt=""
							className="avatar-crop-image"
							onError={() => {
								setImageReady(false);
								setDraft(null);
								setCropDisplayBox(null);
								setError("This avatar image could not be loaded.");
							}}
							onLoad={handleImageLoad}
							ref={imageRef}
							src={target.owner.avatarUrl}
						/>
						{draft && imageReady && cropDisplayBox && (
							<div
								className="avatar-crop-selection"
								onPointerCancel={endCropDrag}
								onPointerDown={(event) => beginCropDrag(event, "move")}
								onPointerMove={updateCropDrag}
								onPointerUp={endCropDrag}
								style={avatarCropOverlayStyle(draft, cropDisplayBox)}
							>
								{(["nw", "ne", "sw", "se"] as const).map((corner) => (
									<span
										aria-hidden="true"
										className={`avatar-crop-handle ${corner}`}
										key={corner}
										onPointerCancel={endCropDrag}
										onPointerDown={(event) => beginCropDrag(event, "resize", corner)}
										onPointerMove={updateCropDrag}
										onPointerUp={endCropDrag}
									/>
								))}
							</div>
						)}
					</div>
				</div>
			:	<div className="empty compact-empty">{target.uiText.cropEmpty}</div>
			}
			{error && <div className="runtime-message error">{error}</div>}
		</Modal>
	);
}
