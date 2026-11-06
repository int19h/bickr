import { memo } from "react";
import { PlainText, RichText, richTextReferencePattern } from "../components/content";
import { MarkdownBody } from "../markdown/markdown-body";

// `text` and `worldHandle` are strings, so the default shallow compare skips a
// parse when the text is unchanged. Rendered Markdown still reads
// ReferenceDataContext, NavigationContext, HoverTooltipContext, and
// TranslationContext, so those updates arrive without a new parse. Do not add
// a custom comparator for that.
export const LoopMarkdown = memo(function LoopMarkdown({ text, worldHandle }: { text: string; worldHandle?: string }) {
	return <MarkdownBody preserveHeadingLevels text={text} referencePattern={richTextReferencePattern}
		renderText={(text) => <RichText text={text} worldHandle={worldHandle} />}
		renderPlain={(text) => <PlainText text={text} />} />;
});
