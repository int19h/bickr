export const fontScaleStorageKey = "bickr.fontScalePercent";
export const defaultFontScalePercent = 100;
export const fontScalePercents = [80, 90, 100, 110, 120, 130, 140] as const;

export type FontScalePercent = typeof fontScalePercents[number];

type FontScaleStorageReader = Pick<Storage, "getItem">;
type FontScaleStorageWriter = Pick<Storage, "setItem">;

const fontScalePercentSet = new Set<number>(fontScalePercents);

export function parseFontScalePercent(value: unknown): FontScalePercent {
	const numericValue = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	return Number.isInteger(numericValue) && fontScalePercentSet.has(numericValue) ?
			numericValue as FontScalePercent
		:	defaultFontScalePercent;
}

export function decreaseFontScalePercent(value: FontScalePercent): FontScalePercent {
	return fontScaleAtOffset(value, -1);
}

export function increaseFontScalePercent(value: FontScalePercent): FontScalePercent {
	return fontScaleAtOffset(value, 1);
}

export function readFontScalePercent(storage: FontScaleStorageReader): FontScalePercent {
	try {
		return parseFontScalePercent(storage.getItem(fontScaleStorageKey));
	} catch {
		return defaultFontScalePercent;
	}
}

export function writeFontScalePercent(storage: FontScaleStorageWriter, value: FontScalePercent): void {
	try {
		storage.setItem(fontScaleStorageKey, String(value));
	} catch {
		// Browser storage can be unavailable; the scale still applies for this render.
	}
}

export function fontScaleCssValue(value: FontScalePercent): string {
	return String(value / 100);
}

function fontScaleAtOffset(value: FontScalePercent, offset: -1 | 1): FontScalePercent {
	const currentIndex = fontScalePercents.indexOf(value);
	const nextIndex = Math.max(0, Math.min(fontScalePercents.length - 1, currentIndex + offset));
	return fontScalePercents[nextIndex] ?? defaultFontScalePercent;
}
