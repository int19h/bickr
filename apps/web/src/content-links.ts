import { parseCommentRef, parseThreadRef } from "@bickr/shared/ids";
import { parsePathname, type ParsedRoute } from "./routes";

export type BickrContentUrlMatch = {
	end: number;
	href: string;
	route: ParsedRoute;
	start: number;
	text: string;
};

const contentUrlCandidatePattern = /https?:\/\/[^\s<>"']+|\/(?:[ct]\/[A-Za-z0-9_-]+|w\/[^\s<>"']+)/giu;

export function findBickrContentUrlMatches(
	text: string,
	options: { origin?: string } = {},
): BickrContentUrlMatch[] {
	const origin = options.origin ?? browserOrigin();
	if (!origin) {
		return [];
	}
	const matches: BickrContentUrlMatch[] = [];
	for (const match of text.matchAll(contentUrlCandidatePattern)) {
		const raw = match[0] ?? "";
		const start = match.index ?? 0;
		const candidate = trimContentUrlCandidate(raw);
		if (!candidate.text) {
			continue;
		}
		const route = routeForContentUrl(candidate.text, origin);
		if (!route) {
			continue;
		}
		matches.push({
			end: start + candidate.text.length,
			href: candidate.text,
			route,
			start,
			text: candidate.text,
		});
	}
	return matches;
}

function routeForContentUrl(value: string, origin: string): ParsedRoute | null {
	let url: URL;
	try {
		url = new URL(value, origin);
	} catch {
		return null;
	}
	if (url.origin !== origin) {
		return null;
	}
	const route = parsePathname(url.pathname, url.search);
	return isContentRoute(route) ? route : null;
}

function isContentRoute(route: ParsedRoute): boolean {
	if (route.route === "thread") {
		return Boolean(
			route.threadId &&
			parseThreadRef(route.threadId) &&
			(!route.commentId || parseCommentRef(route.commentId)),
		);
	}
	if (route.route === "thread-ref") {
		return Boolean(route.threadId && parseThreadRef(route.threadId));
	}
	if (route.route === "comment-ref") {
		return Boolean(route.commentId && parseCommentRef(route.commentId));
	}
	return false;
}

function trimContentUrlCandidate(value: string): { text: string } {
	let text = value;
	while (/[.,!?;:]$/.test(text)) {
		text = text.slice(0, -1);
	}
	while (hasUnmatchedTrailingCloser(text)) {
		text = text.slice(0, -1);
	}
	return { text };
}

function hasUnmatchedTrailingCloser(value: string): boolean {
	const last = value.at(-1);
	if (!last || !")]}>".includes(last)) {
		return false;
	}
	const pairs: Record<string, string> = {
		")": "(",
		"]": "[",
		"}": "{",
		">": "<",
	};
	const opener = pairs[last];
	if (!opener) {
		return false;
	}
	return countChar(value, last) > countChar(value, opener);
}

function countChar(value: string, char: string): number {
	let count = 0;
	for (const current of value) {
		if (current === char) {
			count += 1;
		}
	}
	return count;
}

function browserOrigin(): string | undefined {
	return typeof window === "undefined" ? undefined : window.location.origin;
}
