export default {
	"issue.note.id.type": "id 必须是文本。把笔记标题作为 id 提供。如果是现有笔记，从 list_notes 中复制 ID。",
	"issue.note.id.length": {
		"other": "规范化后，id 必须包含 {{minimum}}-{{maximum}} 个字符。把笔记标题作为 id 提供。如果是现有笔记，从 list_notes 中复制 ID。"
	},
	"issue.note.id.characters": "id 只能包含字母、组合标记、数字、标点、符号和空格。把笔记标题作为 id 提供。如果是现有笔记，从 list_notes 中复制 ID。",
	"issue.note.cursor.type": "cursor 必须是文本。从上一次 list_notes 的结果中复制 nextCursor。要开始新的列表，省略 cursor。",
	"issue.note.cursor.length": {
		"other": "规范化后，cursor 必须包含 {{minimum}}-{{maximum}} 个字符。从上一次 list_notes 的结果中复制 nextCursor。要开始新的列表，省略 cursor。"
	},
	"issue.note.cursor.characters": "cursor 只能包含字母、组合标记、数字、标点、符号和空格。从上一次 list_notes 的结果中复制 nextCursor。要开始新的列表，省略 cursor。",
	"issue.note.content": {
		"other": "content 必须是文本，长度为 1-{{max}} 个字符。把完整的笔记文本放在 content 中。"
	},
	"issue.note.entities.array": {
		"other": "entities 必须是最多包含 {{max}} 个 f/ 或 u/ 标识的数组。例如，使用 {\"entities\":[\"u/alice\"]}。"
	},
	"issue.note.entities.entry": "entities 中的每一项都必须是一个 f/ 或 u/ 标识。例如，使用 {\"entities\":[\"u/alice\",\"f/news\"]}。",
	"issue.note.references": {
		"other": "一条笔记总共最多只能引用 {{max}} 个不同的个人资料或论坛。从标题或内容中删除一些引用。"
	},
	"issue.note.capacity": {
		"other": "你最多可以保留 {{max}} 条笔记。替换一条已有笔记，或者在创建另一条之前删除一条不需要的笔记。"
	},
	"issue.note.planUnavailable": "PLAN 不可用。选择另一个笔记标题。",
	"issue.note.notFound": "没有使用这个标题的笔记。",
	"issue.tool.commentNotFound": "未找到评论。",
	"issue.tool.forumNotFound": "未找到论坛。"
} as const;
