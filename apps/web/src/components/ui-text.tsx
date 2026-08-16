import { createContext, useContext, useEffect, useState } from "react";
import { type LanguageTag, type UiLocalePreference } from "@bickr/shared/model";
import { defaultLanguageTag } from "../language";
import { retryDynamicImport } from "../dynamic-import";
import enUiText from "./locales/en";

export const supportedUiLocales = ["en", "es", "zh-Hans", "ja", "ru", "uk", "eo"] as const;
export type SupportedUiLocale = (typeof supportedUiLocales)[number];
export const defaultUiLocale: SupportedUiLocale = "en";

export type UiText = {
	nav: {
		allWorlds: string;
		myBots: string;
		inferenceLibrary: string;
		search: string;
		statistics: string;
		inferenceCosts: string;
		notifications: string;
		subscriptions: string;
		settings: string;
		comingLater: string;
		yourWorlds: string;
		noneYet: string;
		discover: string;
		footnote: string;
		githubLink: string;
		discordLink: string;
		openNavigation: string;
		closeNavigation: string;
		navigation: string;
		primaryNavigation: string;
	};
	topbar: {
		edit: string;
		avatar: string;
		loop: string;
		profile: string;
		installBickr: string;
		refresh: string;
	};
	toast: {
		dismiss: string;
	};
	profile: {
		title: string;
		subtitleIncomplete: string;
		subtitleReady: string;
		signOut: string;
		saveAndActivate: string;
		saveProfile: string;
		savedProfile: string;
		setupRequiredTitle: string;
		setupRequiredBody: string;
		sectionTitle: string;
		loading: string;
		setupRequiredMeta: string;
		editable: string;
		displayName: string;
		handle: string;
		handleHelp: string;
		accountLanguage: string;
		uiLanguage: string;
		uiLanguageHelp: string;
		systemUiLanguage: string;
	};
	language: {
		fieldLabel: string;
		fieldHelp: string;
	};
};

type NonEnglishUiLocale = Exclude<SupportedUiLocale, "en">;
type LoadedUiText = { locale: SupportedUiLocale; text: UiText };

const uiTextLoaders = {
	es: () => import("./locales/es"),
	"zh-Hans": () => import("./locales/zh-Hans"),
	ja: () => import("./locales/ja"),
	ru: () => import("./locales/ru"),
	uk: () => import("./locales/uk"),
	eo: () => import("./locales/eo"),
} satisfies Record<NonEnglishUiLocale, () => Promise<{ default: UiText }>>;

export async function loadUiTextLocale(locale: SupportedUiLocale): Promise<UiText> {
	if (locale === "en") {
		return enUiText;
	}
	return (await retryDynamicImport(uiTextLoaders[locale])).default;
}

export function uiTextForLocale(locale: SupportedUiLocale, loaded: LoadedUiText): UiText {
	return loaded.locale === locale ? loaded.text : enUiText;
}

export function useUiTextLocale(locale: SupportedUiLocale): UiText {
	const [loaded, setLoaded] = useState<LoadedUiText>({ locale: "en", text: enUiText });

	useEffect(() => {
		if (locale === "en") {
			return undefined;
		}
		let active = true;
		void loadUiTextLocale(locale)
			.then((text) => {
				if (active) {
					setLoaded({ locale, text });
				}
			})
			.catch(() => {
				if (active) {
					setLoaded({ locale: "en", text: enUiText });
				}
			});
		return () => {
			active = false;
		};
	}, [locale]);

	return uiTextForLocale(locale, loaded);
}

export const uiLocaleOptions = [
	{ label: "System", value: "system" },
	{ label: "English", value: "en" },
	{ label: "Español", value: "es" },
	{ label: "中文（简体）", value: "zh-Hans" },
	{ label: "日本語", value: "ja" },
	{ label: "Русский", value: "ru" },
	{ label: "Українська", value: "uk" },
	{ label: "Esperanto", value: "eo" },
] as const;

export function languageDraftValue(value: LanguageTag | string | null | undefined, fallback: LanguageTag | string = defaultLanguageTag): string {
	return value ?? fallback;
}

export function languageInputValue(value: string): LanguageTag | null {
	const trimmed = value.trim();
	return trimmed ? trimmed as LanguageTag : null;
}

export function supportedUiLocale(value: string | null | undefined): SupportedUiLocale | null {
	if (!value || value === "system") {
		return null;
	}
	let canonical = value;
	try {
		canonical = Intl.getCanonicalLocales(value)[0] ?? value;
	} catch {
		canonical = value;
	}
	const lower = canonical.toLowerCase();
	const matched =
		lower.startsWith("es") ? "es"
		: lower === "zh" || lower.startsWith("zh-hans") || lower === "zh-cn" || lower === "zh-sg" ? "zh-Hans"
		: lower.startsWith("ja") ? "ja"
		: lower.startsWith("ru") ? "ru"
		: lower.startsWith("uk") ? "uk"
		: lower.startsWith("eo") ? "eo"
		: lower.startsWith("en") ? "en"
		: null;
	return matched && (supportedUiLocales as readonly string[]).includes(matched) ? matched as SupportedUiLocale : null;
}

export function effectiveUiLocalePreference(preference: UiLocalePreference | null | undefined): SupportedUiLocale {
	return supportedUiLocale(preference) ?? supportedUiLocale(navigator.language) ?? defaultUiLocale;
}

export function languageDirection(language: string | null | undefined): "ltr" | "rtl" {
	const base = language?.split("-")[0]?.toLowerCase();
	return base && ["ar", "fa", "he", "ps", "ur"].includes(base) ? "rtl" : "ltr";
}

export function textDirectionForLanguage(language: string | null | undefined): "auto" | "ltr" | "rtl" {
	return language ? languageDirection(language) : "auto";
}

export function canonicalLanguageTag(value: string): string {
	try {
		return Intl.getCanonicalLocales(value)[0] ?? value;
	} catch {
		return value;
	}
}

export function explicitScriptSubtag(language: string | null | undefined): string | null {
	if (!language) {
		return null;
	}
	const canonical = canonicalLanguageTag(language);
	return canonical.split("-").find((subtag, index) => index > 0 && /^[A-Z][a-z]{3}$/.test(subtag)) ?? null;
}

export function textLanguageDomProps(language: string | null | undefined): { dir: "auto"; lang?: string } {
	return {
		dir: "auto",
		...(language ? { lang: language } : {}),
	};
}

export const UiTextContext = createContext<UiText>(enUiText);

export function useUiText(): UiText {
	return useContext(UiTextContext);
}
