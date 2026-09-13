import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiscordInvite } from "./discord-invite";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
let root: Root;
let container: HTMLElement;
const reportError = vi.fn();
beforeEach(() => {
	vi.resetAllMocks();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	HTMLDialogElement.prototype.showModal = function() { this.open = true; };
	HTMLDialogElement.prototype.close = function() { this.open = false; };
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function mount() { await act(async () => root.render(<DiscordInvite reportError={reportError} />)); }
it("keeps the modal closed when this account already dismissed it", async () => {
	vi.mocked(api).mockResolvedValue({ ok: true, data: { dismissed: true } });
	await mount();
	expect(container.querySelector("dialog")?.open).toBe(false);
});
it("opens after the server check and saves Escape dismissal", async () => {
	vi.mocked(api).mockResolvedValueOnce({ ok: true, data: { dismissed: false } }).mockResolvedValue({ ok: true, data: { dismissed: true } });
	await mount();
	const dialog = container.querySelector("dialog")!;
	expect(dialog.open).toBe(true);
	await act(async () => { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
	expect(dialog.open).toBe(false);
	expect(api).toHaveBeenLastCalledWith("/api/me/discord-invite", { method: "POST", timeoutMs: 15000 });
});
it("reports failed persistence and permits a fresh server check on a later visit", async () => {
	vi.mocked(api).mockResolvedValueOnce({ ok: true, data: { dismissed: false } }).mockResolvedValueOnce({ ok: false, error: "network", message: "offline" });
	await mount();
	await act(async () => { container.querySelector<HTMLButtonElement>(".modal-foot button")!.click(); });
	expect(container.querySelector("dialog")?.open).toBe(false);
	expect(reportError).toHaveBeenCalledWith(expect.stringContaining("next visit"));
	vi.mocked(api).mockResolvedValue({ ok: true, data: { dismissed: false } });
	await act(async () => root.render(<DiscordInvite key="new-visit" reportError={reportError} />));
	expect(container.querySelector("dialog")?.open).toBe(true);
});
it("joins via a real secure external link and acknowledges the invitation", async () => {
	vi.mocked(api).mockResolvedValue({ ok: true, data: { dismissed: false } });
	await mount();
	const link = container.querySelector("a")!;
	expect(link.href).toBe("https://discord.gg/TC8fqeVEWU");
	expect(link.rel).toBe("noopener noreferrer");
	expect(link.target).toBe("_blank");
	await act(async () => { link.click(); });
	expect(api).toHaveBeenLastCalledWith("/api/me/discord-invite", { method: "POST", timeoutMs: 15000 });
});
