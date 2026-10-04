import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "./markdown-body";

const render = (text: string) => renderToStaticMarkup(
	<MarkdownBody text={text} referencePattern={/u\/\w+/g} renderText={text => text} renderPlain={text => text} />,
);

it("renders math and currency after thousands of ordinary Markdown renders", () => {
	for (let index = 0; index < 12_000; index++) render("Ordinary content.");
	expect(render("$5")).toContain("$5");
	for (const text of ["$x$", "$$x^2$$", "$$\ny^2\n$$", "$`x_$y`$"]) {
		expect(render(text)).toContain('class="math-expression');
	}
}, 30_000);
