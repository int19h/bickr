import type { AvatarCrop, AvatarImage } from "@bickr/shared/model";

type CloudflareImageFit = "cover" | "contain" | "scale-down";

type CloudflareImageOptions = {
	width?: number;
	height?: number;
	fit?: CloudflareImageFit;
	format?: "auto";
};

type AvatarPreviewSource = Pick<AvatarImage, "url" | "width" | "height"> | string;

export function avatarDisplayPixels(size: "sm" | "md" | "lg" | "xl" | "hero", override?: number): number {
	if (override && Number.isFinite(override) && override > 0) {
		return Math.ceil(override);
	}
	return (
		size === "sm" ? 22
		: size === "lg" ? 56
		: size === "xl" ? 96
		: size === "hero" ? 180
		: 32
	);
}

export function avatarImagePixels(cssPixels: number): number {
	return Math.ceil(cssPixels * devicePixelRatioBucket());
}

export function devicePixelRatioBucket(): number {
	if (typeof window === "undefined") {
		return 1;
	}
	const ratio = window.devicePixelRatio;
	if (!Number.isFinite(ratio) || ratio <= 1) {
		return 1;
	}
	return Math.min(4, Math.ceil(ratio));
}

export function avatarThumbnailUrl(url: string, pixels: number, fit: "cover" | "contain" = "cover"): string {
	return cloudflareImageUrl(url, { width: pixels, height: pixels, fit, format: "auto" });
}

export function avatarCroppedThumbnailUrl(url: string, pixels: number, crop: AvatarCrop): string {
	const imageWidth = Math.min(2048, Math.ceil((pixels * crop.imageWidth) / crop.size));
	return cloudflareImageUrl(url, { width: imageWidth, format: "auto" });
}

export function avatarPreviewUrl(source: AvatarPreviewSource): string {
	const url = typeof source === "string" ? source : source.url;
	const width = typeof source === "string" ? undefined : source.width;
	const height = typeof source === "string" ? undefined : source.height;
	const pixels = Math.min(2048, avatarImagePixels(720));
	if (width && height && height > width) {
		return cloudflareImageUrl(url, { height: pixels, fit: "scale-down", format: "auto" });
	}
	return cloudflareImageUrl(url, { width: pixels, fit: "scale-down", format: "auto" });
}

export function cloudflareImageUrl(url: string, options: CloudflareImageOptions = {}): string {
	try {
		const parsed = new URL(url);
		if (parsed.pathname.toLowerCase().endsWith(".svg")) {
			return url;
		}
		const directives = [
			options.width ? `width=${Math.trunc(options.width)}` : "",
			options.height ? `height=${Math.trunc(options.height)}` : "",
			options.fit ? `fit=${options.fit}` : "",
			options.format ? `format=${options.format}` : "",
		].filter(Boolean);
		if (directives.length === 0) {
			return url;
		}
		return `${parsed.origin}/cdn-cgi/image/${directives.join(",")}${parsed.pathname}${parsed.search}`;
	} catch {
		return url;
	}
}
