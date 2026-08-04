import type { RedirectUriCspSource } from "@bickr/shared/mcp-auth";

export const cspDirectiveOrder = [
	"default-src",
	"script-src",
	"style-src",
	"font-src",
	"img-src",
	"connect-src",
	"worker-src",
	"manifest-src",
	"frame-ancestors",
	"base-uri",
	"form-action",
] as const;

export type CspDirective = (typeof cspDirectiveOrder)[number];

type StaticCspSource =
	| "'self'"
	| "'unsafe-inline'"
	| "'none'"
	| "https://fonts.googleapis.com"
	| "https://fonts.gstatic.com"
	| "https://cdn.jsdelivr.net"
	| "data:"
	| "blob:"
	| "https:"
	| "wss:";

export type CspSource = StaticCspSource | RedirectUriCspSource;
export type CspPolicy = Readonly<{ [Directive in CspDirective]: readonly CspSource[] }>;

export const ordinaryCspPolicy = {
	"default-src": ["'self'"],
	"script-src": ["'self'"],
	"style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
	"font-src": ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
	"img-src": ["'self'", "data:", "blob:", "https:"],
	"connect-src": ["'self'", "wss:"],
	"worker-src": ["'self'"],
	"manifest-src": ["'self'"],
	"frame-ancestors": ["'none'"],
	"base-uri": ["'self'"],
	"form-action": ["'self'"],
} as const satisfies CspPolicy;

export function consentCspPolicy(callbackSource: RedirectUriCspSource, requestOrigin: string): CspPolicy {
	// Blink and WebKit may check form-action against every redirect hop. This
	// policy intentionally permits only the exact registered callback origin,
	// so an HTTPS callback that later redirects to a custom scheme can still be
	// blocked. Do not add scheme/client allowlists here; that is follow-up #136.
	const formAction: readonly CspSource[] = callbackSource === requestOrigin ? ["'self'"] : ["'self'", callbackSource];
	return {
		...ordinaryCspPolicy,
		"form-action": formAction,
	};
}

export function serializeCspPolicy(policy: CspPolicy): string {
	return cspDirectiveOrder
		.map((directive) => `${directive} ${policy[directive].join(" ")}`)
		.join("; ");
}

export const contentSecurityPolicy = serializeCspPolicy(ordinaryCspPolicy);
