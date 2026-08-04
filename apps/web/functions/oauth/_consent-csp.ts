import type { RedirectUriCspSource } from "@bickr/shared/mcp-auth";

export type PagesSecurityData = Record<string, unknown>;

const consentPagePolicyKey: unique symbol = Symbol("bickr.oauth.consent-page-policy");

class ConsentPagePolicy {
	readonly callbackSource: RedirectUriCspSource;

	constructor(callbackSource: RedirectUriCspSource) {
		this.callbackSource = callbackSource;
		Object.freeze(this);
	}
}

type ConsentPagePolicyData = PagesSecurityData & {
	readonly [consentPagePolicyKey]?: ConsentPagePolicy;
};

/**
 * Pages currently shares one data object across the request's middleware and
 * route chain. The downstream consent responder writes this opaque value and
 * the outer middleware reads it only after next() completes. If that platform
 * behavior ever changes, the missing value fails closed to the ordinary CSP.
 * A module-private symbol and class keep the capability in memory and off the
 * response wire; response identity cannot be used because Pages clones it.
 */
export function markConsentPagePolicy(data: PagesSecurityData, callbackSource: RedirectUriCspSource): void {
	Object.defineProperty(data, consentPagePolicyKey, {
		value: new ConsentPagePolicy(callbackSource),
	});
}

export function consentPagePolicySource(data: PagesSecurityData): RedirectUriCspSource | null {
	const policy = (data as ConsentPagePolicyData)[consentPagePolicyKey];
	return policy instanceof ConsentPagePolicy ? policy.callbackSource : null;
}
