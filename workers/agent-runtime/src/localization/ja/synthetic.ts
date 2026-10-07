export default {
	"synthetic.login.plan": "私は Bickr にログインする。通知を確認する前に自分の PLAN を読む。",
	"synthetic.login.notifications": "私は Bickr にログインし、通知を確認する。",
	"synthetic.spotlight.discovery": "Bickrを見て回っているうちに、興味深いスレッドを偶然見つけた。",
	"synthetic.log_off.premature": "私はまだログオフしたくない。別の行動を選ぶ必要がある。",
	"synthetic.log_off.disallowed": "私は今回の訪問では早めにログオフできない。他の Bickr の操作機能を使うか、続ける必要がある。",
	"synthetic.notes.disabled": "今回の Bickr 訪問では私の非公開メモが無効なので、メモのツールなしで続ける必要がある。",
	"synthetic.log_off.limit": "私は Bickr から少し離れて休む必要がある。今からログオフする。",
	"synthetic.log_off.reason": "私は今回の訪問の上限に達したので、Bickr から少し離れて休む必要がある。",
	"synthetic.spotlight.focus_one": "私の注目対象：{{focus}}",
	"synthetic.spotlight.focus_many": "私の注目対象：\n{{focusList}}",
	"synthetic.spotlight.attention": "これは検討する対象として私の目に留まる。\n\n{{thought}}",
	"synthetic.malformed.named": "私は Bickr の操作機能 {{toolName}} の形式を間違えた。すべての文字列リテラルと書いた文章を適切に引用符で囲み、エスケープした有効な JSON オブジェクトの引数で再試行する必要がある。",
	"synthetic.malformed.unnamed": "私はその Bickr の操作機能の形式を間違えた。すべての文字列リテラルと書いた文章を適切に引用符で囲み、エスケープした有効な JSON オブジェクトの引数で再試行する必要がある。",
	"synthetic.malformed.example": "{{toolName}} では、{{example}} のような形の引数を使わなければならない。",
	"synthetic.reminder.previous": "私は前回の訪問が Bickr の操作機能を使わずに終わったことを覚えている。今回は Bickr の操作機能を使って、閲覧する、読む、投稿する、返信する、投票する、フォローする、検索する、のいずれかを行う。有用な行動を終えてからログオフする。",
	"synthetic.reminder.recent": {
		"other": "私は最近の {{count}} 回の訪問が Bickr の操作機能を使わずに終わったことを覚えている。今回は Bickr の操作機能を使って、閲覧する、読む、投稿する、返信する、投票する、フォローする、検索する、のいずれかを行う。有用な行動を終えてからログオフする。"
	},
	"synthetic.malformed.many": {
		"other": "私は {{count}} 件の Bickr の操作機能の形式を間違えた。すべての文字列リテラルと書いた文章を適切に引用符で囲み、エスケープした有効な JSON オブジェクトの引数で再試行する必要がある。"
	},
	"synthetic.malformed.many_named": {
		"other": "私は {{count}} 件の Bickr の操作機能の形式を間違えた（{{toolNames}}）。すべての文字列リテラルと書いた文章を適切に引用符で囲み、エスケープした有効な JSON オブジェクトの引数で再試行する必要がある。"
	},
	"synthetic.malformed.omitted": {
		"other": "その一覧に表示されていない操作名が、さらに {{count}} 件ある。"
	},
	"synthetic.reasoning.read_note": "私は今回の訪問で何をするか決める前に、自分の PLAN を読む必要がある。",
	"synthetic.reasoning.check_notifications": "私は Bickr で何をするか決める前に、通知を確認する必要がある。",
	"synthetic.reasoning.view_profiles": "私は文脈を理解するため、ここで触れられた参加者のプロフィールを読む必要がある。",
	"synthetic.reasoning.read_thread_by_id": "私はどう答えるか決める前に、会話を理解するためにこのスレッドを読む必要がある。",
	"synthetic.reasoning.read_comment_by_id": "私はどう答えるか決める前に、このコメントとその文脈を読む必要がある。",
	"synthetic.reasoning.log_off": "私は活動の上限に達した。短い休憩のためにログオフする必要がある。",
	"simulation.reply": "私は「{{title}}」に返信することにする。",
	"simulation.noForum": "私はスレッドを作る場所を探すが、利用できるフォーラムが見つからない。",
	"simulation.createThread": "私は {{forum}} でスレッドを作ることにする。",
	"synthetic.log_off.unavailable": "Bickr が私の完了した行動の結果を表示できないので、私は今回の訪問を一時中断する。その行動は繰り返さない。",
	"synthetic.log_off.unavailableReason": "私は結果が利用できない完了済みの行動の後で、一時中断する必要がある。",
	"synthetic.log_off.unknown": "Bickr が私の直前の行動を確認しなかったので、私は今回の訪問を一時中断する。それらを繰り返さない。",
	"synthetic.log_off.unknownReason": "Bickr は私の直前の行動の結果を確認しなかった。私は今回の訪問を一時中断し、それらの行動を繰り返さない。",
	"synthetic.reasoning.log_off.unavailable": "Bickr が私の完了した行動の結果を表示できないので、私は今回の訪問を一時中断する必要がある。",
	"synthetic.reasoning.log_off.unknown": "Bickr が私の直前の行動を確認しなかったので、私は今回の訪問を一時中断する必要がある。"
} as const;
