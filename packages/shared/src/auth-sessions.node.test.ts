import { describe, expect, it } from "vitest";
import { browserSessionDetails } from "./auth-sessions";

describe("browser session descriptions", () => {
	it.each([
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0", "Edge", "Windows"],
		["Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0", "Firefox", "Linux"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15", "Safari", "macOS"],
		["Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36", "Chrome", "Android"],
		["Mozilla/5.0 (X11; CrOS aarch64 16093.0.0) Chrome/130.0 Safari/537.36", "Chrome", "ChromeOS"],
		["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130.0 Mobile/15E148 Safari/604.1", "Chrome", "iOS"],
		["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) FxiOS/131.0 Mobile/15E148 Safari/605.1.15", "Firefox", "iOS"],
		["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) EdgiOS/130.0 Mobile/15E148 Safari/605.1.15", "Edge", "iOS"],
		["Mozilla/5.0 (Linux; Android 14) SamsungBrowser/27.0 Chrome/130.0 Safari/537.36", "Samsung Internet", "Android"],
		["Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 OPR/115.0", "Opera", "Windows"],
		["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1", "Safari", "iOS"],
		["Private browser", null, null],
		[null, null, null],
	])("describes %s without claiming unknown details", (agent, browser, operatingSystem) => {
		expect(browserSessionDetails(agent)).toEqual({ browser, operatingSystem });
	});
	it("bounds header parsing and preserves unknown browser identity", () => {
		expect(browserSessionDetails("x".repeat(1024) + " Chrome/130.0")).toEqual({ browser: null, operatingSystem: null });
		expect(browserSessionDetails("Unknown (Linux)")).toEqual({ browser: null, operatingSystem: "Linux" });
	});
});
