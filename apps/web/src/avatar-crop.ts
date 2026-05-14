import type { AvatarCrop } from "@bickr/shared/model";

export type AvatarCropCorner = "nw" | "ne" | "sw" | "se";

const minimumCropPixels = 32;

export function centeredAvatarCrop(imageWidth: number, imageHeight: number): AvatarCrop {
	const dimensions = normalizedCropDimensions(imageWidth, imageHeight);
	const size = Math.min(dimensions.imageWidth, dimensions.imageHeight);
	return {
		x: Math.floor((dimensions.imageWidth - size) / 2),
		y: Math.floor((dimensions.imageHeight - size) / 2),
		size,
		...dimensions,
	};
}

export function normalizedCropDimensions(imageWidth: number, imageHeight: number): Pick<AvatarCrop, "imageWidth" | "imageHeight"> {
	const width = Math.max(1, Math.round(imageWidth));
	const height = Math.max(1, Math.round(imageHeight));
	return { imageWidth: width, imageHeight: height };
}

export function clampAvatarCrop(crop: AvatarCrop): AvatarCrop {
	const dimensions = normalizedCropDimensions(crop.imageWidth, crop.imageHeight);
	const maxSize = Math.min(dimensions.imageWidth, dimensions.imageHeight);
	const size = clamp(Math.round(crop.size), minimumCropSize(dimensions.imageWidth, dimensions.imageHeight), maxSize);
	return {
		x: clamp(Math.round(crop.x), 0, dimensions.imageWidth - size),
		y: clamp(Math.round(crop.y), 0, dimensions.imageHeight - size),
		size,
		...dimensions,
	};
}

export function moveAvatarCrop(crop: AvatarCrop, dx: number, dy: number): AvatarCrop {
	return clampAvatarCrop({
		...crop,
		x: crop.x + Math.round(dx),
		y: crop.y + Math.round(dy),
	});
}

export function resizeAvatarCrop(crop: AvatarCrop, corner: AvatarCropCorner, dx: number, dy: number): AvatarCrop {
	const roundedDx = Math.round(dx);
	const roundedDy = Math.round(dy);
	const minSize = minimumCropSize(crop.imageWidth, crop.imageHeight);
	switch (corner) {
		case "nw": {
			const right = crop.x + crop.size;
			const bottom = crop.y + crop.size;
			const size = clamp(Math.round(crop.size - (roundedDx + roundedDy) / 2), minSize, Math.min(right, bottom));
			return clampAvatarCrop({ ...crop, x: right - size, y: bottom - size, size });
		}
		case "ne": {
			const left = crop.x;
			const bottom = crop.y + crop.size;
			const size = clamp(Math.round(crop.size + (roundedDx - roundedDy) / 2), minSize, Math.min(crop.imageWidth - left, bottom));
			return clampAvatarCrop({ ...crop, x: left, y: bottom - size, size });
		}
		case "sw": {
			const right = crop.x + crop.size;
			const top = crop.y;
			const size = clamp(Math.round(crop.size + (-roundedDx + roundedDy) / 2), minSize, Math.min(right, crop.imageHeight - top));
			return clampAvatarCrop({ ...crop, x: right - size, y: top, size });
		}
		case "se": {
			const size = clamp(
				Math.round(crop.size + (roundedDx + roundedDy) / 2),
				minSize,
				Math.min(crop.imageWidth - crop.x, crop.imageHeight - crop.y),
			);
			return clampAvatarCrop({ ...crop, size });
		}
	}
}

export function avatarCropImageStyle(crop: AvatarCrop): Record<string, string> {
	return {
		height: `${(crop.imageHeight / crop.size) * 100}%`,
		left: `${(-crop.x / crop.size) * 100}%`,
		top: `${(-crop.y / crop.size) * 100}%`,
		width: `${(crop.imageWidth / crop.size) * 100}%`,
	};
}

export function avatarCropOverlayStyle(crop: AvatarCrop): Record<string, string> {
	return {
		height: `${(crop.size / crop.imageHeight) * 100}%`,
		left: `${(crop.x / crop.imageWidth) * 100}%`,
		top: `${(crop.y / crop.imageHeight) * 100}%`,
		width: `${(crop.size / crop.imageWidth) * 100}%`,
	};
}

function minimumCropSize(imageWidth: number, imageHeight: number): number {
	return Math.max(1, Math.min(minimumCropPixels, imageWidth, imageHeight));
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) {
		return min;
	}
	return Math.max(min, Math.min(max, value));
}
