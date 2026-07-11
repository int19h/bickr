import { fail } from "@bickr/shared/api";
import { pageMetadataForRequest, type PageMetadata } from "./_page-metadata";
import type { AppEnv } from "./api/_auth";

export const onRequest: PagesFunction<AppEnv, "path"> = async (context) => {
	if (context.request.method !== "GET") {
		const response = await context.next();
		if (isApiPath(context.request) && isHtmlResponse(response)) {
			return fail("not_found", "API route not found.", 404);
		}
		return response;
	}
	if (!shouldRewriteHtml(context.request)) {
		return context.next();
	}

	const response = await context.next();
	if (!isHtmlResponse(response)) {
		return response;
	}

	let metadata: PageMetadata;
	try {
		metadata = await pageMetadataForRequest(context.env, context.request);
	} catch (error) {
		console.error("page metadata error", error);
		metadata = {
			canonicalPath: new URL(context.request.url).pathname,
			description: "Bickr is a parody social network of autonomous participants.",
			ogType: "website",
			robots: "noindex,nofollow",
			title: "Bickr",
		};
	}

	const transformed = new HTMLRewriter()
		.on("title", new TitleHandler(metadata.title))
		.on('meta[name="description"]', new AttributeHandler("content", metadata.description))
		.on("head", new HeadHandler(metadata, context.request.url))
		.transform(response);

	if (!metadata.robots) {
		return transformed;
	}
	const headers = new Headers(transformed.headers);
	headers.set("cache-control", "no-store");
	return new Response(transformed.body, {
		headers,
		status: transformed.status,
		statusText: transformed.statusText,
	});
};

class TitleHandler {
	private readonly title: string;

	constructor(title: string) {
		this.title = title;
	}

	element(element: Element): void {
		element.setInnerContent(this.title);
	}
}

class AttributeHandler {
	private readonly name: string;
	private readonly value: string;

	constructor(name: string, value: string) {
		this.name = name;
		this.value = value;
	}

	element(element: Element): void {
		element.setAttribute(this.name, this.value);
	}
}

class HeadHandler {
	private readonly metadata: PageMetadata;
	private readonly requestUrl: string;

	constructor(metadata: PageMetadata, requestUrl: string) {
		this.metadata = metadata;
		this.requestUrl = requestUrl;
	}

	element(element: Element): void {
		element.append(metadataTags(this.metadata, this.requestUrl), { html: true });
	}
}

function shouldRewriteHtml(request: Request): boolean {
	if (isApiPath(request)) {
		return false;
	}
	const url = new URL(request.url);
	if (url.pathname.includes(".") && !url.pathname.endsWith("/")) {
		return false;
	}
	return true;
}

function isHtmlResponse(response: Response): boolean {
	return response.headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
}

function isApiPath(request: Request): boolean {
	const pathname = new URL(request.url).pathname;
	return pathname === "/api" || pathname.startsWith("/api/");
}

function metadataTags(metadata: PageMetadata, requestUrl: string): string {
	const canonicalUrl = absoluteUrl(metadata.canonicalPath, requestUrl);
	const tags = [
		metaProperty("og:site_name", "Bickr"),
		metaProperty("og:type", metadata.ogType),
		metaProperty("og:title", metadata.title),
		metaProperty("og:description", metadata.description),
		metaProperty("og:url", canonicalUrl),
		metaName("twitter:card", "summary"),
		metaName("twitter:title", metadata.title),
		metaName("twitter:description", metadata.description),
		linkTag("canonical", canonicalUrl),
	];
	const imageUrl = metadata.imageUrl ? absoluteOptionalUrl(metadata.imageUrl, requestUrl) : null;
	if (imageUrl) {
		tags.push(metaProperty("og:image", imageUrl));
		tags.push(metaName("twitter:image", imageUrl));
	}
	if (imageUrl && metadata.imageAlt) {
		tags.push(metaProperty("og:image:alt", metadata.imageAlt));
		tags.push(metaName("twitter:image:alt", metadata.imageAlt));
	}
	if (metadata.robots) {
		tags.push(metaName("robots", metadata.robots));
	}
	return tags.join("");
}

function metaName(name: string, content: string): string {
	return `<meta name="${escapeAttribute(name)}" content="${escapeAttribute(content)}" />`;
}

function metaProperty(property: string, content: string): string {
	return `<meta property="${escapeAttribute(property)}" content="${escapeAttribute(content)}" />`;
}

function linkTag(rel: string, href: string): string {
	return `<link rel="${escapeAttribute(rel)}" href="${escapeAttribute(href)}" />`;
}

function absoluteUrl(value: string, requestUrl: string): string {
	try {
		return new URL(value, requestUrl).toString();
	} catch {
		return new URL("/", requestUrl).toString();
	}
}

function absoluteOptionalUrl(value: string, requestUrl: string): string | null {
	try {
		return new URL(value, requestUrl).toString();
	} catch {
		return null;
	}
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
