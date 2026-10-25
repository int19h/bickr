import { RichText, richTextReferencePattern } from "../components/content";
import { MarkdownBody } from "../markdown/markdown-body";

export function LoopMarkdown({ text, worldHandle }: { text: string; worldHandle?: string }) {
	return <MarkdownBody preserveHeadingLevels text={text} referencePattern={richTextReferencePattern}
		renderText={(text) => <RichText text={text} worldHandle={worldHandle} />}
		renderPlain={(text) => text} />;
}
