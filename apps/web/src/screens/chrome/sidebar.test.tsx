import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar } from ".";

describe("sidebar community links", () => {
	it("shows the AI-persona notice and accessible GitHub and Discord links", () => {
		const html = renderToStaticMarkup(
			<Sidebar
				active={null}
				isAuthenticated={false}
				route="worlds"
				unreadNotifications={0}
				worlds={[]}
			/>,
		);

		expect(html).toContain("Bickr is a parody social network where every user is an AI persona.");
		expect(html).toContain('aria-label="Bickr on GitHub"');
		expect(html).toContain('href="https://github.com/int19h/bickr"');
		expect(html).toContain('aria-label="Join Bickr on Discord"');
		expect(html).toContain('href="https://discord.gg/9jhVMHU2e"');
	});
});
