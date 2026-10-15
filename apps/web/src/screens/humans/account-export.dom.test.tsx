import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { AccountExport } from "./account-export";
import { createAccountExport } from "../../account-export";
import { defaultAccountExportOptions, accountExportContentSections } from "@bickr/shared/account-export";

let root: Root;
let container: HTMLDivElement;
const urls: URL[] = [];
const imageReference = { kind: "user", entityId: "owner", slot: "avatar", key: "users/owner/avatars/image.png", url: "https://images.test/image.png" };
const reply = (data: unknown) => Response.json({ ok: true, data });
function fetcher(path: string | URL | Request) {
	const url = new URL(String(path), "https://example.com");
	urls.push(url);
	const section = url.searchParams.get("section");
	if (url.pathname.endsWith("/image")) return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
	if (section === "notes" && url.searchParams.has("botId")) return Promise.resolve(reply({ records: [{ id: "PLAN", content: "Private plan" }], nextCursor: null }));
	const records = section === "profile" ? [{ id: "owner", displayName: { text: "Me", lang: "en" } }]
		: section === "bots" ? [{ id: "bot", prompt: { text: 'Exact 日本語\n"quoted"', lang: "ja" } }]
		: section === "notes" ? [{ botId: "bot" }] : [];
	return Promise.resolve(reply({ kind: "account_export_page", ownerUserId: "owner", section, records, imageReferences: section === "profile" ? [imageReference] : [], nextCursor: null }));
}
function button(text: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent === text)!; }
async function entries(blob: Blob) { return unzipSync(new Uint8Array(await blob.arrayBuffer())); }

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	urls.length = 0;
	vi.stubGlobal("fetch", vi.fn(fetcher));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("account export confirmation", () => {
	it("does no export work before confirmation and defaults to definitions with image URLs", async () => {
		await act(async () => root.render(<AccountExport userId="owner" />));
		expect(fetch).not.toHaveBeenCalled();
		await act(async () => button("Export").click());
		expect(fetch).not.toHaveBeenCalled();
		expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
		expect(container.querySelector<HTMLInputElement>('input[value="urls"]')!.checked).toBe(true);
		expect(container.textContent).toContain("API keys");
		expect(container.textContent).toContain("512 MB");
		await act(async () => button("Cancel").click());
		expect(fetch).not.toHaveBeenCalled();
	});

	it("produces a readable ZIP, preserves full text, and never requests optional content by default", async () => {
		const file = await createAccountExport("owner", defaultAccountExportOptions, new AbortController().signal, () => {});
		const archive = await entries(file);
		const exported = JSON.parse(strFromU8(archive["export.json"]!));
		expect(exported.data.bots[0].prompt.text).toBe('Exact 日本語\n"quoted"');
		expect(exported.options).toEqual(defaultAccountExportOptions);
		expect(exported.counts.bots).toBe(1);
		expect(exported.complete).toBe(true);
		expect(Object.keys(archive).filter((path) => path.startsWith("images/"))).toHaveLength(0);
		for (const section of accountExportContentSections) expect(urls.some((url) => url.searchParams.get("section") === section)).toBe(false);
	});

	it("includes selected bot content and image bytes with a safe manifest path", async () => {
		const file = await createAccountExport("owner", { includeBotContent: true, images: "files" }, new AbortController().signal, () => {});
		const archive = await entries(file);
		const exported = JSON.parse(strFromU8(archive["export.json"]!));
		const images = JSON.parse(strFromU8(archive["manifest.json"]!));
		expect(exported.data.notes).toEqual([{ botId: "bot", id: "PLAN", content: "Private plan" }]);
		expect(images.files[0]).toMatchObject({ ...imageReference, archivePath: "images/000001.png" });
		expect(archive["images/000001.png"]).toEqual(new Uint8Array([1, 2, 3]));
		expect(urls.find((url) => url.pathname.endsWith("/image"))?.searchParams.get("expectedKey")).toBe(imageReference.key);
	});

	it("uses the modal choices and starts one ZIP download only after confirmation", async () => {
		let saved: Blob | undefined;
		vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { saved = blob as Blob; return "blob:export"; });
		const names: string[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
		await act(async () => root.render(<AccountExport userId="owner" />));
		await act(async () => button("Export").click());
		await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await act(async () => container.querySelector<HTMLInputElement>('input[value="files"]')!.click());
		expect(fetch).not.toHaveBeenCalled();
		await act(async () => button("Download ZIP").click());
		expect(names).toHaveLength(1);
		expect(names[0]).toMatch(/^bickr-export-.*\.zip$/);
		expect(saved?.type).toBe("application/zip");
		const archive = await entries(saved!);
		expect(JSON.parse(strFromU8(archive["export.json"]!)).options).toEqual({ includeBotContent: true, images: "files" });
		expect(archive["images/000001.png"]).toBeDefined();
	});

	it("does not download a partial archive after a source fails and leaves retry available", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, message: "Storage unavailable", error: "server_error" }, { status: 503 })));
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
		await act(async () => root.render(<AccountExport userId="owner" />));
		await act(async () => button("Export").click());
		await act(async () => button("Download ZIP").click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Storage unavailable");
		expect(button("Download ZIP").disabled).toBe(false);
		expect(click).not.toHaveBeenCalled();
	});

	it("rejects repeated cursors and an account change instead of finishing incomplete data", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => reply({ kind: "account_export_page", ownerUserId: "owner", section: "profile", records: [], imageReferences: [], nextCursor: "same" })));
		await expect(createAccountExport("owner", defaultAccountExportOptions, new AbortController().signal, () => {})).rejects.toThrow("did not advance");
		vi.stubGlobal("fetch", vi.fn(async () => reply({ kind: "account_export_page", ownerUserId: "other", section: "profile", records: [], imageReferences: [], nextCursor: null })));
		await expect(createAccountExport("owner", defaultAccountExportOptions, new AbortController().signal, () => {})).rejects.toThrow("does not match");
	});

	it("cancels an in-flight export without starting a download", async () => {
		let finish!: (value: Response) => void;
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
		await act(async () => root.render(<AccountExport userId="owner" />));
		await act(async () => button("Export").click());
		await act(async () => button("Download ZIP").click());
		expect(button("Exporting…").disabled).toBe(true);
		await act(async () => button("Cancel").click());
		await act(async () => finish(reply({ kind: "account_export_page", ownerUserId: "owner", section: "profile", records: [], imageReferences: [], nextCursor: null })));
		expect(click).not.toHaveBeenCalled();
		expect(container.querySelector(".modal")).toBeNull();
	});
});
