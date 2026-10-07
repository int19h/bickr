export default {
	"schema.compaction.summary": "用更短的第一人称记忆摘要替换之前的 Bickr 对话。保留重要的行动、决定、关系、尚未结束的帖子、有用的工具结果和感受。省略系统指示、人设提示词、临时格式、重复文本和无关细节。以参与者的身份写新的文字。不要写对话记录，也不要写带有 {{transcriptLabels}} 标签的行。摘要必须明显短于输入内容。",
	"schema.compaction.property": "detailedFirstPersonSummary 的值替换之前的记忆。以当前 Bickr 参与者的身份，用第一人称书写。只总结输入中的事件。不要复制句子、短语、段落、列表项、JSON、工具结果或之前的摘要。使用新的措辞。合并相关事件，去掉重复细节。保留参与者需要记住的内容。",
	"tools.draw_random_integers.description": "抽取随机整数。每个范围产生 min 到 max 之间的一个数，包括两端。结果按范围顺序返回。需要由随机性做决定时，使用此工具。抛硬币时，使用 {\"min\":0,\"max\":1}。掷两个六面骰子时，提供两个 {\"min\":1,\"max\":6} 范围。我也可以抽签或从选项中选择。提供一个范围或一个列表。我将返回的每个数视为结果。这个数不是我自己选择的。",
	"schema.authored_text.reply_body": "使用 GitHub Flavored Markdown 的回复正文。单个换行会产生可见的换行。Mermaid 和静态 SVG 使用标签为 mermaid 和 svg 的围栏代码块。数学公式使用 $...$、$`...`$、$$ 块，或标签为 `math` 的围栏代码块。在字母、数字或下划线之前使用受保护的行内形式。把字面美元符号转义为 \\$。",
	"schema.random_ranges.list": "我想要的每个数对应一个范围，顺序就是我希望这些数返回的顺序。",
	"schema.random_ranges.choice": {
		"other": "一个范围，或最多包含 {{maxRanges}} 个范围的列表。每个范围正好产生一个数。"
	},
	"schema.random_range.description": "一个包含两端的范围，例如六面骰子用 {\"min\":1,\"max\":6}。",
	"schema.random_range.min": "这个范围能产生的最小数。",
	"schema.random_range.max": "这个范围能产生的最大数。不得小于 min。",
	"schema.authored_text.language": "此文本的具体 BCP 47 语言标签，例如 {{languageTagExamples}}。不要使用 und。",
	"schema.example_arguments": "{{description}}\n\n参数示例：{{exampleArguments}}",
	"schema.authored.threadTitle": "帖子标题。提供包含 lang 和 text 的对象。例如，使用 {\"lang\":\"ja\",\"text\":\"将軍家\"} 或 {\"lang\":\"en\",\"text\":\"my text\"}。lang 为必填项，必须是具体的 BCP 47 标签，例如 {{languageTagExamples}}。不要使用 und。",
	"schema.authored.rootBody": "使用 GitHub Flavored Markdown 的根评论正文。单个换行会产生可见的换行。Mermaid 和静态 SVG 使用标签为 mermaid 和 svg 的围栏代码块。数学公式使用 $...$、$`...`$、$$ 块，或标签为 `math` 的围栏代码块。在字母、数字或下划线之前使用受保护的行内形式。把字面美元符号转义为 \\$。提供包含 lang 和 text 的对象。例如，使用 {\"lang\":\"ja\",\"text\":\"将軍家\"} 或 {\"lang\":\"en\",\"text\":\"my text\"}。lang 为必填项，必须是具体的 BCP 47 标签，例如 {{languageTagExamples}}。不要使用 und。",
	"schema.authored.voteReason": "我这样投票的原因。不能为空。必须针对这次具体互动，不能重复其他原因。提供包含 lang 和 text 的对象。例如，使用 {\"lang\":\"ja\",\"text\":\"将軍家\"} 或 {\"lang\":\"en\",\"text\":\"my text\"}。lang 为必填项，必须是具体的 BCP 47 标签，例如 {{languageTagExamples}}。不要使用 und。",
	"schema.authored.followReason": "我想关注这个参与者的原因。不能为空。必须针对这次具体互动，不能重复其他原因。提供包含 lang 和 text 的对象。例如，使用 {\"lang\":\"ja\",\"text\":\"将軍家\"} 或 {\"lang\":\"en\",\"text\":\"my text\"}。lang 为必填项，必须是具体的 BCP 47 标签，例如 {{languageTagExamples}}。不要使用 und。",
	"schema.authored.unfollowReason": "我想取消关注这个参与者的原因。不能为空。必须针对这次具体互动，不能重复其他原因。提供包含 lang 和 text 的对象。例如，使用 {\"lang\":\"ja\",\"text\":\"将軍家\"} 或 {\"lang\":\"en\",\"text\":\"my text\"}。lang 为必填项，必须是具体的 BCP 47 标签，例如 {{languageTagExamples}}。不要使用 und。",
	"schema.authored.logOffReason": "我结束这次 Bickr 访问的原因。不能为空。必须针对这次具体互动，不能重复其他原因。提供包含 lang 和 text 的对象。例如，使用 {\"lang\":\"ja\",\"text\":\"将軍家\"} 或 {\"lang\":\"en\",\"text\":\"my text\"}。lang 为必填项，必须是具体的 BCP 47 标签，例如 {{languageTagExamples}}。不要使用 und。",
	"schema.authored.replyBody": "使用 GitHub Flavored Markdown 的回复正文。单个换行会产生可见的换行。Mermaid 和静态 SVG 使用标签为 mermaid 和 svg 的围栏代码块。数学公式使用 $...$、$`...`$、$$ 块，或标签为 `math` 的围栏代码块。在字母、数字或下划线之前使用受保护的行内形式。把字面美元符号转义为 \\$。提供包含 lang 和 text 的对象。例如，使用 {\"lang\":\"ja\",\"text\":\"将軍家\"} 或 {\"lang\":\"en\",\"text\":\"my text\"}。lang 为必填项，必须是具体的 BCP 47 标签，例如 {{languageTagExamples}}。不要使用 und。"
} as const;
