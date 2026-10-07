export default {
	"structured_output.unexpected_tools.compaction": "META: ツールを呼び出さないでください。必要な JSON スキーマに従う、詳しい一人称の要約で答えてください。",
	"structured_output.unexpected_tools.other": "この返答では Bickr の操作機能を使わないでください。{{property}} だけを含む、必要な JSON オブジェクトで答えてください。",
	"structured_output.empty.compaction": "要約の応答は空でした。{{property}} に空でないテキストを入れた JSON オブジェクトを返してください。",
	"structured_output.empty.translation": "翻訳の応答は空でした。{{property}} に空でないテキストを入れた JSON オブジェクトを返してください。",
	"structured_output.empty.avatar_description": "プロフィール画像の説明の応答は空でした。{{property}} に空でないテキストを入れた JSON オブジェクトを返してください。",
	"structured_output.invalid_json.compaction": "要約の応答は JSON オブジェクトでなければなりません。{{property}} とそのテキスト値のみを指定してください。",
	"structured_output.invalid_json.translation": "翻訳の応答は JSON オブジェクトでなければなりません。{{property}} とそのテキスト値のみを指定してください。",
	"structured_output.invalid_json.avatar_description": "プロフィール画像の説明の応答は JSON オブジェクトでなければなりません。{{property}} とそのテキスト値のみを指定してください。",
	"structured_output.missing_tool": "{{toolName}}ツールの呼び出しが返されませんでした。{{property}}に空でないテキストを入れて、{{toolName}}を1回呼び出してください。",
	"structured_output.wrong_tool": "この要求には {{toolName}} だけを使ってください。ここで {{receivedTool}} を使わないでください。",
	"structured_output.tool_count": {
		"other": "{{toolName}}ツールの呼び出しは1件のはずでしたが、{{count}}件受け取りました。{{toolName}}をちょうど1回呼び出してください。"
	},
	"structured_output.tool_mismatch": "予期したツールは {{toolName}} でしたが、受け取ったのは {{receivedTool}} です。代わりに {{toolName}} を呼び出してください。",
	"structured_output.invalid_arguments_json": "{{toolName}} の引数は有効な JSON ではありませんでした。{{property}} にテキストを含む JSON オブジェクトを指定してください。文字列内の特殊文字をエスケープしてください。",
	"structured_output.arguments_object": "{{toolName}} の引数は JSON オブジェクトでなければなりません。{{property}} とそのテキスト値を {} の中に入れてください。",
	"structured_output.output_object": "構造化出力は JSON オブジェクトでなければなりません。{{property}} とそのテキスト値を {} の中に入れてください。",
	"structured_output.extra_arguments": {
		"other": "想定外の引数が {{count}} 個あります：{{fields}}。それらの引数を削除してください。{{property}} だけを渡してください。"
	},
	"structured_output.extra_fields": {
		"other": "想定外のフィールドが {{count}} 個あります：{{fields}}。それらのフィールドを削除してください。{{property}} だけを渡してください。"
	},
	"structured_output.nonempty.compaction": "要約の引数は、空でない文字列でなければなりません。テキストを {{property}} に入れてください。",
	"structured_output.nonempty.translation": "翻訳の引数は、空でない文字列でなければなりません。テキストを {{property}} に入れてください。",
	"structured_output.nonempty.avatar_description": "プロフィール画像の説明の引数は、空でない文字列でなければなりません。テキストを {{property}} に入れてください。",
	"structured_output.transcript": "{{property}} の要約を、通常の一人称の文章で書いてください。書き起こしの行 {{line}} を削除してください。{{labels}} のラベルが付いた行を書かないでください。",
	"structured_output.minimum.compaction": {
		"other": "{{property}} の要約は、{{minimum}} 文字以上でなければなりません。テキストに関連する詳細を加えてください。"
	},
	"structured_output.minimum.translation": {
		"other": "{{property}} の翻訳は、{{minimum}} 文字以上でなければなりません。テキストに関連する詳細を加えてください。"
	},
	"structured_output.minimum.avatar_description": {
		"other": "{{property}} のプロフィール画像の説明は、{{minimum}} 文字以上でなければなりません。テキストに関連する詳細を加えてください。"
	},
	"structured_output.maximum.compaction": {
		"other": "{{property}} の要約は、{{maximum}} 文字以下でなければなりません。テキストを短くしてください。"
	},
	"structured_output.maximum.translation": {
		"other": "{{property}} の翻訳は、{{maximum}} 文字以下でなければなりません。テキストを短くしてください。"
	},
	"structured_output.maximum.avatar_description": {
		"other": "{{property}} のプロフィール画像の説明は、{{maximum}} 文字以下でなければなりません。テキストを短くしてください。"
	},
	"structured_output.wrong_tool.unnamed": "この要求には {{toolName}} だけを使ってください。名前のないツール呼び出しを送らないでください。",
	"structured_output.tool_mismatch.unnamed": "予期したツールは {{toolName}} でしたが、受け取ったのは名前のないツール呼び出しです。代わりに {{toolName}} を呼び出してください。",
	"structured_output.nonreducing.estimate": {
		"other": "{{property}} の要約ではコンテキストが短くなりませんでした。推定の長さは {{replacementTokens}} トークンです。"
	},
	"structured_output.nonreducing.before": {
		"other": "置き換え前のコンテキストは {{compactedTokens}} トークンでした。必要な事実を残して要約を短くしてください。"
	},
	"structured_output.nonempty.compaction.field": "要約のフィールドは、空でない文字列でなければなりません。テキストを {{property}} に入れてください。",
	"structured_output.nonempty.translation.field": "翻訳のフィールドは、空でない文字列でなければなりません。テキストを {{property}} に入れてください。",
	"structured_output.nonempty.avatar_description.field": "プロフィール画像の説明のフィールドは、空でない文字列でなければなりません。テキストを {{property}} に入れてください。"
} as const;
