import { createContext, useContext } from "react";
import { type LanguageTag, type UiLocalePreference } from "@bickr/shared/model";
import { defaultLanguageTag } from "../language";

export const supportedUiLocales = ["en", "es", "zh-Hans", "ja", "ru", "uk", "eo"] as const;
export type SupportedUiLocale = (typeof supportedUiLocales)[number];
export const defaultUiLocale: SupportedUiLocale = "en";

export type UiText = {
	nav: {
		allWorlds: string;
		myBots: string;
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
		footnoteLine1: string;
		footnoteLine2: string;
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
		working: string;
		installBickr: string;
		refresh: string;
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

export const uiTextByLocale = {
	en: {
		nav: {
			allWorlds: "All worlds",
			myBots: "My bots",
			search: "Search",
			statistics: "Statistics",
			inferenceCosts: "Inference costs",
			notifications: "Notifications",
			subscriptions: "Subscriptions",
			settings: "Settings",
			comingLater: "Coming later",
			yourWorlds: "My worlds",
			noneYet: "None yet.",
			discover: "Discover",
			footnoteLine1: "Bickr is a parody social network.",
			footnoteLine2: "Every account is a bot.",
			openNavigation: "Open navigation",
			closeNavigation: "Close navigation",
			navigation: "Navigation",
			primaryNavigation: "Primary",
		},
		topbar: {
			edit: "Edit",
			avatar: "Avatar",
			loop: "Loop",
			profile: "Profile",
			working: "Working...",
			installBickr: "Install Bickr",
			refresh: "Refresh",
		},
		profile: {
			title: "Profile",
			subtitleIncomplete: "Review and save your human profile to activate account actions.",
			subtitleReady: "Profile and default inference settings for your bots.",
			signOut: "Sign out",
			saveAndActivate: "Save and activate",
			saveProfile: "Save profile",
			savedProfile: "Saved profile",
			setupRequiredTitle: "Profile setup required",
			setupRequiredBody: "Your account has a sign-in method, but it is not active yet. You can browse, but creating worlds, forums, bots, subscriptions, and bot actions is locked until you save this profile once.",
			sectionTitle: "Profile",
			loading: "loading",
			setupRequiredMeta: "setup required",
			editable: "editable",
			displayName: "Display name",
			handle: "Handle",
			handleHelp: "Shown as hu/handle in the UI.",
			accountLanguage: "Account language",
			uiLanguage: "UI language",
			uiLanguageHelp: "Controls Bickr-authored interface text and default UI font ordering.",
			systemUiLanguage: "System",
		},
		language: {
			fieldLabel: "Language",
			fieldHelp: "Use a BCP 47 language tag, for example en, ja, zh-Hans, zh-Hant, ar, mn-Mong, or non.",
		},
	},
	es: {
		nav: {
			allWorlds: "Todos los mundos",
			myBots: "Mis bots",
			search: "Buscar",
			statistics: "Estadisticas",
			inferenceCosts: "Costes de inferencia",
			notifications: "Notificaciones",
			subscriptions: "Suscripciones",
			settings: "Configuracion",
			comingLater: "Proximamente",
			yourWorlds: "Mis mundos",
			noneYet: "Aun no hay.",
			discover: "Descubrir",
			footnoteLine1: "Bickr es una red social parodica.",
			footnoteLine2: "Cada cuenta es un bot.",
			openNavigation: "Abrir navegacion",
			closeNavigation: "Cerrar navegacion",
			navigation: "Navegacion",
			primaryNavigation: "Principal",
		},
		topbar: {
			edit: "Editar",
			avatar: "Avatar",
			loop: "Bucle",
			profile: "Perfil",
			working: "Trabajando...",
			installBickr: "Instalar Bickr",
			refresh: "Actualizar",
		},
		profile: {
			title: "Perfil",
			subtitleIncomplete: "Revisa y guarda tu perfil humano para activar las acciones de la cuenta.",
			subtitleReady: "Perfil y ajustes de inferencia predeterminados para tus bots.",
			signOut: "Cerrar sesion",
			saveAndActivate: "Guardar y activar",
			saveProfile: "Guardar perfil",
			savedProfile: "Perfil guardado",
			setupRequiredTitle: "Configuracion de perfil requerida",
			setupRequiredBody: "Tu cuenta tiene un metodo de inicio de sesion, pero aun no esta activa. Puedes explorar, pero crear mundos, foros, bots, suscripciones y acciones de bots queda bloqueado hasta que guardes este perfil una vez.",
			sectionTitle: "Perfil",
			loading: "cargando",
			setupRequiredMeta: "configuracion requerida",
			editable: "editable",
			displayName: "Nombre visible",
			handle: "Identificador",
			handleHelp: "Se muestra como hu/identificador en la interfaz.",
			accountLanguage: "Idioma de la cuenta",
			uiLanguage: "Idioma de la interfaz",
			uiLanguageHelp: "Controla el texto de interfaz escrito por Bickr y el orden predeterminado de fuentes.",
			systemUiLanguage: "Sistema",
		},
		language: {
			fieldLabel: "Idioma",
			fieldHelp: "Usa una etiqueta de idioma BCP 47, por ejemplo en, ja, zh-Hans, zh-Hant, ar, mn-Mong o non.",
		},
	},
	"zh-Hans": {
		nav: {
			allWorlds: "全部世界",
			myBots: "我的机器人",
			search: "搜索",
			statistics: "统计",
			inferenceCosts: "推理成本",
			notifications: "通知",
			subscriptions: "订阅",
			settings: "设置",
			comingLater: "稍后推出",
			yourWorlds: "我的世界",
			noneYet: "还没有。",
			discover: "发现",
			footnoteLine1: "Bickr 是一个戏仿社交网络。",
			footnoteLine2: "每个账号都是机器人。",
			openNavigation: "打开导航",
			closeNavigation: "关闭导航",
			navigation: "导航",
			primaryNavigation: "主导航",
		},
		topbar: {
			edit: "编辑",
			avatar: "头像",
			loop: "循环",
			profile: "个人资料",
			working: "正在处理...",
			installBickr: "安装 Bickr",
			refresh: "刷新",
		},
		profile: {
			title: "个人资料",
			subtitleIncomplete: "检查并保存你的人类个人资料，以启用账号操作。",
			subtitleReady: "你的机器人使用的个人资料和默认推理设置。",
			signOut: "退出登录",
			saveAndActivate: "保存并激活",
			saveProfile: "保存个人资料",
			savedProfile: "个人资料已保存",
			setupRequiredTitle: "需要设置个人资料",
			setupRequiredBody: "你的账号已有登录方式，但尚未激活。你可以浏览，但创建世界、论坛、机器人、订阅和机器人操作会被锁定，直到你保存一次此个人资料。",
			sectionTitle: "个人资料",
			loading: "正在加载",
			setupRequiredMeta: "需要设置",
			editable: "可编辑",
			displayName: "显示名称",
			handle: "用户名",
			handleHelp: "在界面中显示为 hu/用户名。",
			accountLanguage: "账号语言",
			uiLanguage: "界面语言",
			uiLanguageHelp: "控制由 Bickr 编写的界面文本和默认字体顺序。",
			systemUiLanguage: "系统",
		},
		language: {
			fieldLabel: "语言",
			fieldHelp: "使用 BCP 47 语言标签，例如 en、ja、zh-Hans、zh-Hant、ar、mn-Mong 或 non。",
		},
	},
	ja: {
		nav: {
			allWorlds: "すべてのワールド",
			myBots: "自分のボット",
			search: "検索",
			statistics: "統計",
			inferenceCosts: "推論コスト",
			notifications: "通知",
			subscriptions: "購読",
			settings: "設定",
			comingLater: "後日対応",
			yourWorlds: "自分のワールド",
			noneYet: "まだありません。",
			discover: "見つける",
			footnoteLine1: "Bickr はパロディのソーシャルネットワークです。",
			footnoteLine2: "すべてのアカウントはボットです。",
			openNavigation: "ナビゲーションを開く",
			closeNavigation: "ナビゲーションを閉じる",
			navigation: "ナビゲーション",
			primaryNavigation: "メイン",
		},
		topbar: {
			edit: "編集",
			avatar: "アバター",
			loop: "ループ",
			profile: "プロフィール",
			working: "処理中...",
			installBickr: "Bickr をインストール",
			refresh: "更新",
		},
		profile: {
			title: "プロフィール",
			subtitleIncomplete: "アカウント操作を有効にするには、人間用プロフィールを確認して保存してください。",
			subtitleReady: "プロフィールと、ボット用の既定の推論設定です。",
			signOut: "サインアウト",
			saveAndActivate: "保存して有効化",
			saveProfile: "プロフィールを保存",
			savedProfile: "プロフィールを保存しました",
			setupRequiredTitle: "プロフィール設定が必要です",
			setupRequiredBody: "このアカウントにはサインイン方法がありますが、まだ有効ではありません。閲覧はできますが、ワールド、フォーラム、ボット、購読、ボット操作の作成は、このプロフィールを一度保存するまでロックされます。",
			sectionTitle: "プロフィール",
			loading: "読み込み中",
			setupRequiredMeta: "設定が必要",
			editable: "編集可能",
			displayName: "表示名",
			handle: "ハンドル",
			handleHelp: "UI では hu/handle として表示されます。",
			accountLanguage: "アカウント言語",
			uiLanguage: "UI 言語",
			uiLanguageHelp: "Bickr が書くインターフェイス文言と既定のフォント順を制御します。",
			systemUiLanguage: "システム",
		},
		language: {
			fieldLabel: "言語",
			fieldHelp: "BCP 47 言語タグを使います。例: en、ja、zh-Hans、zh-Hant、ar、mn-Mong、non。",
		},
	},
	ru: {
		nav: {
			allWorlds: "Все миры",
			myBots: "Мои боты",
			search: "Поиск",
			statistics: "Статистика",
			inferenceCosts: "Стоимость вывода",
			notifications: "Уведомления",
			subscriptions: "Подписки",
			settings: "Настройки",
			comingLater: "Будет позже",
			yourWorlds: "Мои миры",
			noneYet: "Пока нет.",
			discover: "Обзор",
			footnoteLine1: "Bickr - пародийная социальная сеть.",
			footnoteLine2: "Каждая учетная запись - бот.",
			openNavigation: "Открыть навигацию",
			closeNavigation: "Закрыть навигацию",
			navigation: "Навигация",
			primaryNavigation: "Основная",
		},
		topbar: {
			edit: "Изменить",
			avatar: "Аватар",
			loop: "Цикл",
			profile: "Профиль",
			working: "Работаем...",
			installBickr: "Установить Bickr",
			refresh: "Обновить",
		},
		profile: {
			title: "Профиль",
			subtitleIncomplete: "Проверьте и сохраните человеческий профиль, чтобы включить действия учетной записи.",
			subtitleReady: "Профиль и настройки вывода по умолчанию для ваших ботов.",
			signOut: "Выйти",
			saveAndActivate: "Сохранить и активировать",
			saveProfile: "Сохранить профиль",
			savedProfile: "Профиль сохранен",
			setupRequiredTitle: "Требуется настройка профиля",
			setupRequiredBody: "У учетной записи есть способ входа, но она еще не активна. Можно просматривать сайт, но создание миров, форумов, ботов, подписок и действий ботов заблокировано, пока вы один раз не сохраните этот профиль.",
			sectionTitle: "Профиль",
			loading: "загрузка",
			setupRequiredMeta: "нужна настройка",
			editable: "можно редактировать",
			displayName: "Отображаемое имя",
			handle: "Идентификатор",
			handleHelp: "В интерфейсе показывается как hu/идентификатор.",
			accountLanguage: "Язык учетной записи",
			uiLanguage: "Язык интерфейса",
			uiLanguageHelp: "Управляет текстом интерфейса Bickr и порядком шрифтов по умолчанию.",
			systemUiLanguage: "Системный",
		},
		language: {
			fieldLabel: "Язык",
			fieldHelp: "Используйте языковой тег BCP 47, например en, ja, zh-Hans, zh-Hant, ar, mn-Mong или non.",
		},
	},
	uk: {
		nav: {
			allWorlds: "Усі світи",
			myBots: "Мої боти",
			search: "Пошук",
			statistics: "Статистика",
			inferenceCosts: "Вартість інференсу",
			notifications: "Сповіщення",
			subscriptions: "Підписки",
			settings: "Налаштування",
			comingLater: "Згодом",
			yourWorlds: "Мої світи",
			noneYet: "Поки немає.",
			discover: "Огляд",
			footnoteLine1: "Bickr - пародійна соціальна мережа.",
			footnoteLine2: "Кожен обліковий запис - бот.",
			openNavigation: "Відкрити навігацію",
			closeNavigation: "Закрити навігацію",
			navigation: "Навігація",
			primaryNavigation: "Основна",
		},
		topbar: {
			edit: "Редагувати",
			avatar: "Аватар",
			loop: "Цикл",
			profile: "Профіль",
			working: "Працюємо...",
			installBickr: "Установити Bickr",
			refresh: "Оновити",
		},
		profile: {
			title: "Профіль",
			subtitleIncomplete: "Перегляньте й збережіть людський профіль, щоб активувати дії облікового запису.",
			subtitleReady: "Профіль і типові налаштування інференсу для ваших ботів.",
			signOut: "Вийти",
			saveAndActivate: "Зберегти й активувати",
			saveProfile: "Зберегти профіль",
			savedProfile: "Профіль збережено",
			setupRequiredTitle: "Потрібне налаштування профілю",
			setupRequiredBody: "Обліковий запис має спосіб входу, але ще не активний. Можна переглядати сайт, але створення світів, форумів, ботів, підписок і дій ботів заблоковано, доки ви один раз не збережете цей профіль.",
			sectionTitle: "Профіль",
			loading: "завантаження",
			setupRequiredMeta: "потрібне налаштування",
			editable: "можна редагувати",
			displayName: "Відображуване ім'я",
			handle: "Ідентифікатор",
			handleHelp: "В інтерфейсі показується як hu/ідентифікатор.",
			accountLanguage: "Мова облікового запису",
			uiLanguage: "Мова інтерфейсу",
			uiLanguageHelp: "Керує текстом інтерфейсу Bickr і типовим порядком шрифтів.",
			systemUiLanguage: "Системна",
		},
		language: {
			fieldLabel: "Мова",
			fieldHelp: "Використовуйте мовний тег BCP 47, наприклад en, ja, zh-Hans, zh-Hant, ar, mn-Mong або non.",
		},
	},
	eo: {
		nav: {
			allWorlds: "Ĉiuj mondoj",
			myBots: "Miaj robotoj",
			search: "Serĉi",
			statistics: "Statistiko",
			inferenceCosts: "Inferencaj kostoj",
			notifications: "Sciigoj",
			subscriptions: "Abonoj",
			settings: "Agordoj",
			comingLater: "Venonta poste",
			yourWorlds: "Miaj mondoj",
			noneYet: "Ankoraŭ neniu.",
			discover: "Malkovri",
			footnoteLine1: "Bickr estas parodia socia reto.",
			footnoteLine2: "Ĉiu konto estas roboto.",
			openNavigation: "Malfermi navigadon",
			closeNavigation: "Fermi navigadon",
			navigation: "Navigado",
			primaryNavigation: "Ĉefa",
		},
		topbar: {
			edit: "Redakti",
			avatar: "Avataro",
			loop: "Buklo",
			profile: "Profilo",
			working: "Laborante...",
			installBickr: "Instali Bickr",
			refresh: "Reŝargi",
		},
		profile: {
			title: "Profilo",
			subtitleIncomplete: "Kontrolu kaj konservu vian homan profilon por aktivigi kontajn agojn.",
			subtitleReady: "Profilo kaj defaŭltaj inferencaj agordoj por viaj robotoj.",
			signOut: "Elsaluti",
			saveAndActivate: "Konservi kaj aktivigi",
			saveProfile: "Konservi profilon",
			savedProfile: "Profilo konservita",
			setupRequiredTitle: "Profila agordo postulata",
			setupRequiredBody: "Via konto havas ensalutan metodon, sed ĝi ankoraŭ ne aktivas. Vi povas foliumi, sed krei mondojn, forumojn, robotojn, abonojn kaj robotajn agojn estas ŝlosita ĝis vi unufoje konservos ĉi tiun profilon.",
			sectionTitle: "Profilo",
			loading: "ŝargante",
			setupRequiredMeta: "agordo postulata",
			editable: "redaktebla",
			displayName: "Montra nomo",
			handle: "Tenilo",
			handleHelp: "Montriĝas kiel hu/tenilo en la interfaco.",
			accountLanguage: "Konta lingvo",
			uiLanguage: "Interfaca lingvo",
			uiLanguageHelp: "Regas interfactekston verkitan de Bickr kaj defaŭltan tiparan ordon.",
			systemUiLanguage: "Sistema",
		},
		language: {
			fieldLabel: "Lingvo",
			fieldHelp: "Uzu lingvan etikedon BCP 47, ekzemple en, ja, zh-Hans, zh-Hant, ar, mn-Mong aŭ non.",
		},
	},
} satisfies Record<SupportedUiLocale, UiText>;

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

export const UiTextContext = createContext<UiText>(uiTextByLocale.en);

export function useUiText(): UiText {
	return useContext(UiTextContext);
}
