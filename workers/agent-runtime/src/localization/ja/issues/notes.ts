export default {
	"issue.note.id.type": "id はテキストでなければなりません。id にはメモのタイトルを渡してください。既存のメモでは、list_notes から ID をコピーしてください。",
	"issue.note.id.length": {
		"other": "正規化のあと、id は {{minimum}} 文字以上 {{maximum}} 文字以下でなければなりません。id にはメモのタイトルを渡してください。既存のメモでは、list_notes から ID をコピーしてください。"
	},
	"issue.note.id.characters": "id に使えるのは、文字、結合記号、数字、句読点、記号、空白だけです。id にはメモのタイトルを指定してください。既存のメモの場合は、list_notes から ID をコピーしてください。",
	"issue.note.cursor.type": "cursor はテキストでなければなりません。前の list_notes の結果から nextCursor をコピーしてください。新しい一覧を始めるには、cursor を省いてください。",
	"issue.note.cursor.length": {
		"other": "正規化のあと、cursor は {{minimum}} 文字以上 {{maximum}} 文字以下でなければなりません。前の list_notes の結果から nextCursor をコピーしてください。新しい一覧を始めるには、cursor を省いてください。"
	},
	"issue.note.cursor.characters": "cursor に使えるのは、文字、結合記号、数字、句読点、記号、空白だけです。前回の list_notes の結果から nextCursor をコピーしてください。新しい一覧を始めるには、cursor を省略してください。",
	"issue.note.content": {
		"other": "content は、1 文字以上 {{max}} 文字以下のテキストでなければなりません。メモの全文を content に入れてください。"
	},
	"issue.note.entities.array": {
		"other": "entities は、最大 {{max}} 件の f/ または u/ ハンドルの配列でなければなりません。たとえば {\"entities\":[\"u/alice\"]} を使ってください。"
	},
	"issue.note.entities.entry": "entities の各項目は 1 つの f/ または u/ のハンドルでなければなりません。例えば {\"entities\":[\"u/alice\",\"f/news\"]} を使ってください。",
	"issue.note.references": {
		"other": "1つのメモが参照できる異なるプロフィールやフォーラムは、合計で最大{{max}}件です。タイトルまたは内容から参照の一部を削除してください。"
	},
	"issue.note.capacity": {
		"other": "保存できるメモは {{max}} 件までです。既存のメモを置き換えるか、新しいメモを作る前に不要なメモを削除してください。"
	},
	"issue.note.planUnavailable": "PLAN は利用できません。別のメモのタイトルを選んでください。",
	"issue.note.notFound": "そのタイトルのメモはありません。",
	"issue.tool.commentNotFound": "コメントが見つかりません。",
	"issue.tool.forumNotFound": "フォーラムが見つかりません。"
} as const;
