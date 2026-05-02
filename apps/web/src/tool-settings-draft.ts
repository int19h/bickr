import type {
	BotToolSettingsInput,
	OpenRouterSearchContextSize,
	OpenRouterWebFetchEngine,
	OpenRouterWebSearchEngine,
} from "@bickr/shared/model";

export type OpenRouterDatetimeToolDraft = {
	enabled: boolean;
	timezone: string;
};

export type OpenRouterWebSearchToolDraft = {
	enabled: boolean;
	engine: string;
	maxResults: string;
	maxTotalResults: string;
	searchContextSize: string;
	userLocationCity: string;
	userLocationRegion: string;
	userLocationCountry: string;
	userLocationTimezone: string;
	allowedDomains: string;
	excludedDomains: string;
};

export type OpenRouterWebFetchToolDraft = {
	enabled: boolean;
	engine: string;
	maxUses: string;
	maxContentTokens: string;
	allowedDomains: string;
	blockedDomains: string;
};

export type BotToolDraft = {
	openRouter: {
		datetime: OpenRouterDatetimeToolDraft;
		webSearch: OpenRouterWebSearchToolDraft;
		webFetch: OpenRouterWebFetchToolDraft;
	};
};

type OpenRouterToolInput = NonNullable<BotToolSettingsInput["openRouter"]>;
type OpenRouterDatetimeToolInput = NonNullable<OpenRouterToolInput["datetime"]>;
type OpenRouterWebSearchToolInput = NonNullable<OpenRouterToolInput["webSearch"]>;
type OpenRouterWebSearchUserLocationInput = NonNullable<OpenRouterWebSearchToolInput["userLocation"]>;
type OpenRouterWebFetchToolInput = NonNullable<OpenRouterToolInput["webFetch"]>;

export function toolInputFromDraft(draft: BotToolDraft): BotToolSettingsInput {
	return {
		openRouter: {
			datetime: openRouterDatetimeInputFromDraft(draft.openRouter.datetime),
			webSearch: openRouterWebSearchInputFromDraft(draft.openRouter.webSearch),
			webFetch: openRouterWebFetchInputFromDraft(draft.openRouter.webFetch),
		},
	};
}

function openRouterDatetimeInputFromDraft(draft: OpenRouterDatetimeToolDraft): OpenRouterDatetimeToolInput {
	return {
		enabled: draft.enabled,
		timezone: nullableTextInput(draft.timezone),
	};
}

function openRouterWebSearchInputFromDraft(draft: OpenRouterWebSearchToolDraft): OpenRouterWebSearchToolInput {
	return {
		enabled: draft.enabled,
		engine: nullableTextInput(draft.engine) as OpenRouterWebSearchEngine | null,
		maxResults: nullableIntegerInput(draft.maxResults),
		maxTotalResults: nullableIntegerInput(draft.maxTotalResults),
		searchContextSize: nullableTextInput(draft.searchContextSize) as OpenRouterSearchContextSize | null,
		userLocation: userLocationInputFromDraft(draft),
		allowedDomains: domainListInput(draft.allowedDomains),
		excludedDomains: domainListInput(draft.excludedDomains),
	};
}

function userLocationInputFromDraft(draft: OpenRouterWebSearchToolDraft): OpenRouterWebSearchUserLocationInput | null {
	const city = nullableTextInput(draft.userLocationCity);
	const region = nullableTextInput(draft.userLocationRegion);
	const country = nullableTextInput(draft.userLocationCountry);
	const timezone = nullableTextInput(draft.userLocationTimezone);
	return city || region || country || timezone ?
			{
				city,
				region,
				country,
				timezone,
			}
		:	null;
}

function openRouterWebFetchInputFromDraft(draft: OpenRouterWebFetchToolDraft): OpenRouterWebFetchToolInput {
	return {
		enabled: draft.enabled,
		engine: nullableTextInput(draft.engine) as OpenRouterWebFetchEngine | null,
		maxUses: nullableIntegerInput(draft.maxUses),
		maxContentTokens: nullableIntegerInput(draft.maxContentTokens),
		allowedDomains: domainListInput(draft.allowedDomains),
		blockedDomains: domainListInput(draft.blockedDomains),
	};
}

function nullableTextInput(value: string): string | null {
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function nullableIntegerInput(value: string): number | null {
	const trimmed = value.trim();
	return trimmed ? Math.trunc(Number(trimmed)) : null;
}

function domainListInput(value: string): string[] | null {
	const domains = value
		.split(/[,\n]/)
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	return domains.length > 0 ? domains : null;
}
