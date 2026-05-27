import { spawn } from "node:child_process";

export type OpenBrowserResult =
	| { opened: true }
	| { opened: false; reason: string };

export async function openBrowser(url: string): Promise<OpenBrowserResult> {
	const command =
		process.platform === "darwin" ? "open"
		: process.platform === "win32" ? "cmd"
		: "xdg-open";
	const args =
		process.platform === "win32" ? ["/c", "start", "", url]
		: [url];
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		return await new Promise<OpenBrowserResult>((resolve) => {
			const timeout = setTimeout(() => {
				child.unref();
				resolve({ opened: true });
			}, 500);
			child.once("spawn", () => {
				clearTimeout(timeout);
				child.unref();
				resolve({ opened: true });
			});
			child.once("error", (error) => {
				clearTimeout(timeout);
				resolve({ opened: false, reason: error.message });
			});
		});
	} catch (error) {
		return {
			opened: false,
			reason: error instanceof Error ? error.message : "browser launch failed",
		};
	}
}
